// SPDX-License-Identifier: AGPL-3.0-only
// Review F24: EXIF Orientation 1–8 through the real upload → prepareAsset → worker path. The TIFF tag is written into a
// new IFD of our generated asymmetric 96 × 64 TIFF (pixel data untouched). Oracle: ffmpeg filter chains for the TIFF/EXIF
// Orientation definitions applied to the untagged source; where this ffmpeg autorotates tagged TIFFs (8.x does, 6.1 does
// not), its own autorotation must equal that oracle. JPEG (browser decode, imageOrientation from-image) and HEIF
// (irot/imir properties, probe orientation 1) must still be transformed exactly once. No product helper is used here.
// The cached poster is decoded by ffmpeg, as in F8/F13: the poster is 4:2:0 JPEG, and Chromium's and ffmpeg's decodes of the
// same 4:2:0 file differ by ~24.8 dB PSNR on this saturated pattern (61.6 dB on 4:4:4) — chroma upsampling is not normative.
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ffmpegAvailable, media } from '../media-fixtures';
import { heifCase } from '../t14-round2-fixtures';
import { dir, reference, run, taggedJpeg, taggedTiff, type Ref } from './t14-orientation-support';

test.skip(!ffmpegAvailable(), 'ffmpeg generates the media and is the oracle');
test.setTimeout(240_000);
const psnrRgb = (a: Buffer, b: Buffer) => { let se = 0; for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2; return 10 * Math.log10(255 * 255 / (se / a.length || 1e-9)); };
/** The cached JPEG's own geometry (ffprobe) and pixels (ffmpeg). */
function decodePoster(b64: string, label: string) {
  const file = path.join(dir, `${label.replace(/\W+/g, '-')}.jpg`); writeFileSync(file, Buffer.from(b64, 'base64'));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return { size: probe.stdout.trim().split(',').map(Number), rgb: run(['-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']) };
}
/** Real ingest: ProjectStore.upload → prepareAsset (worker thumbnails) → cached rows and the cached JPEG bytes. */
const ingest = (page: Page, name: string, type: string, bytes: Buffer) => page.evaluate(async ({ name, type, b64 }) => {
  const d = '/src/store/database.ts', p = '/src/media/prepare.ts'; const { ProjectStore } = await import(d), { prepareAsset } = await import(p);
  const store = new ProjectStore(`t14-r3-${crypto.randomUUID()}`), file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type });
  const asset = await store.upload(file);
  try {
    const result = await prepareAsset(store, asset.id), row = await store.row('assets', asset.id), thumb = await store.row('thumbnails', asset.id);
    const u = new Uint8Array(await thumb.poster.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return { result, status: row.processing_status, image: row.media.image, decoder: row.media.decoder, thumbnail: [thumb.width, thumb.height], poster: btoa(s) };
  } finally { await store.deleteAssets([asset.id]); await store.close(); }
}, { name, type, b64: bytes.toString('base64') });
async function check(page: Page, label: string, name: string, type: string, bytes: Buffer, ref: Ref, orientation: number | null) {
  const r = await ingest(page, name, type, bytes), poster = decodePoster(r.poster, label), quality = psnrRgb(poster.rgb, ref.rgb);
  console.log(`${label}: probe ${r.image.width}×${r.image.height} o${r.image.orientation} (${r.decoder}); cached ${r.thumbnail.join('×')}, JPEG ${poster.size.join('×')}; PSNR ${quality.toFixed(2)} dB`);
  expect.soft([r.result, r.status], label).toEqual(['prepared', 'ready']);
  if (orientation !== null) expect.soft(r.image.orientation, label).toBe(orientation);
  expect.soft([r.image.width, r.image.height], `${label} probed display size`).toEqual([ref.width, ref.height]);
  expect.soft(r.thumbnail, `${label} cached thumbnail size`).toEqual([ref.width, ref.height]);
  expect.soft(poster.size, `${label} encoded JPEG size`).toEqual([ref.width, ref.height]);
  expect.soft(quality, `${label} poster PSNR vs ffmpeg`).toBeGreaterThanOrEqual(25);
}
test.beforeEach(async ({ page }) => { await page.goto('/'); });
test('F24 TIFF EXIF Orientation 1–8: probed size, cached thumbnail, encoded JPEG and poster pixels match ffmpeg', async ({ page }) => {
  const refs = Array.from({ length: 9 }, (_, o) => o ? reference(media('pattern.tiff'), o) : null);
  // The source is asymmetric under every transform, so a size swap or the wrong mirror cannot reach the threshold.
  let closest = 0;
  for (let a = 1; a <= 8; a++) for (let b = a + 1; b <= 8; b++) if (refs[a]!.width === refs[b]!.width) closest = Math.max(closest, psnrRgb(refs[a]!.rgb, refs[b]!.rgb));
  console.log(`closest pair of distinct orientation references: PSNR ${closest.toFixed(2)} dB`); expect(closest).toBeLessThan(25);
  const autorotates = run(['-i', taggedTiff(6).file, '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-']).readUInt32BE(16) === 64;
  for (let o = 1; o <= 8; o++) {
    const tiff = taggedTiff(o);
    // Oracle cross-check: this ffmpeg's own Orientation handling of the exact tagged file, where it has one.
    if (autorotates) expect(run(['-i', tiff.file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']).equals(refs[o]!.rgb), `ffmpeg autorotation o${o}`).toBe(true);
    await check(page, `TIFF o${o}`, `o${o}.tiff`, 'image/tiff', tiff.bytes, refs[o]!, o);
  }
  console.log(`ffmpeg autorotates tagged TIFF: ${autorotates}`);
});
test('F24 orientation still applies exactly once on the browser (JPEG from-image) and HEIF property paths', async ({ page }) => {
  for (const o of [2, 6, 7]) await check(page, `JPEG o${o}`, `o${o}.jpg`, 'image/jpeg', taggedJpeg(o), reference(media('pattern.jpg'), o), o);
  const heif = heifCase({ axis: 1, rotation: 1 });
  await check(page, 'HEIF irot 90° ccw + imir axis 1', 'turned.heic', 'image/heic', heif.bytes, { width: heif.width, height: heif.height, rgb: heif.rgb }, 1);
});
