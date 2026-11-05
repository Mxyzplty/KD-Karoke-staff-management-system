// SPDX-License-Identifier: AGPL-3.0-only
// T14 review round 1 in real Chromium: software probe (F7), every accepted extension really ingests (F8), stock key
// management and the cost line (F10, F14), page lifecycle cancels preparation (F11), and derived-media content against
// ffmpeg (F13). Oracles are ffmpeg's own decode or the written HDR reference (ground truth; F17 is C-gt).
import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expectedFacts, ffmpegAvailable, ffmpegImageRgb, ffprobePts, media } from '../media-fixtures';
import { deltaE2000, lab, referencePixel } from '../colour-reference';

test.skip(!ffmpegAvailable(), 'ffmpeg generates the media and is the oracle');
test.setTimeout(240_000);
const scratch = mkdtempSync(path.join(tmpdir(), 'cutframe-review-'));
type Rgb = { width: number; height: number; rgb: Uint8Array };
const settled = async (page: Page, count: number) => {
  await expect(page.getByRole('tab', { name: `Assets (${count})`, exact: true })).toBeVisible();
  await expect(page.locator('.badge.status').filter({ hasText: /Uploading|Processing/ })).toHaveCount(0, { timeout: 180_000 });
};
const rgbOf = (file: string, filter = ''): Rgb => {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, ...(filter ? ['-vf', filter] : []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const [w, h] = probe.stdout.trim().split(',').map(Number), size = (r.stdout as Buffer).length / 3, ratio = size / (w * h);
  return { width: ratio === 1 ? w : h, height: ratio === 1 ? h : w, rgb: r.stdout as Buffer };
};
/** ffmpeg's RGB of presentation frame k (autorotated, its own colour tags). */
const frameRgb = (file: string, k: number) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${k})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 }); if (r.status !== 0) throw new Error(String(r.stderr)); return r.stdout as Buffer; };
const save = (name: string, base64: string) => { const f = path.join(scratch, name); writeFileSync(f, Buffer.from(base64, 'base64')); return f; };
/** Worst ΔE2000 over 8 × 4 patch means, and PSNR. */
function compare(a: Rgb, b: Rgb) {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let worst = 0, se = 0;
  for (let py = 0; py < 4; py++) for (let px = 0; px < 8; px++) {
    const sa = [0, 0, 0], sb = [0, 0, 0]; let n = 0;
    for (let y = Math.floor(py * a.height / 4) + 1; y < Math.floor((py + 1) * a.height / 4) - 1; y++) for (let x = Math.floor(px * a.width / 8) + 1; x < Math.floor((px + 1) * a.width / 8) - 1; x++) {
      const o = (y * a.width + x) * 3; for (let c = 0; c < 3; c++) { sa[c] += a.rgb[o + c] / 255; sb[c] += b.rgb[o + c] / 255; } n++;
    }
    if (n) worst = Math.max(worst, deltaE2000(lab(sa.map(v => v / n)), lab(sb.map(v => v / n))));
  }
  for (let i = 0; i < a.rgb.length; i++) se += (a.rgb[i] - b.rgb[i]) ** 2;
  return { worstDeltaE: worst, psnr: 10 * Math.log10(255 * 255 / (se / a.rgb.length || 1e-9)) };
}
async function upload(page: Page, files: string[]) { await page.goto('/assets'); for (const f of files) await page.getByLabel('Upload media').setInputFiles(f); }
async function assets(page: Page) {
  return page.evaluate(async () => {
    const s = '/src/store/database.ts'; const { projectStore } = await import(s);
    const b64 = async (blob?: Blob) => { if (!blob) return null; const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
    const out: Record<string, any> = {};
    for (const a of (await projectStore.library()).assets) {
      const thumbs = await projectStore.row('thumbnails', a.id), wave = await projectStore.row('waveforms', a.id);
      out[a.name] = { status: a.processing_status, steps: a.processing_steps, code: a.last_error_code, media: a.media, poster: await b64(thumbs?.poster), posterSize: thumbs && [thumbs.width, thumbs.height],
        proxy: a.proxy ? await b64(await projectStore.media.readProxy(a.proxy.objectKey ?? a.id)) : null, peaks: wave ? Array.from(wave.peaks as Float32Array) : null };
    }
    return out;
  });
}
test('F7 a valid AVI ingests through the software probe: record vs ffprobe, poster and proxy', async ({ page }) => {
  const file = media('mpeg4.avi'); await upload(page, [file]); await settled(page, 1);
  const a = (await assets(page))['mpeg4.avi'], facts = expectedFacts(file);
  expect(a.code).toBeNull(); expect(a.status).toBe('ready');
  expect(a.media.video).toMatchObject({ codec: 'mpeg4', codedWidth: 160, codedHeight: 90, displayWidth: 160, displayHeight: 90, rotation: 0, vfr: false, frameCount: facts.video.frameCount });
  expect(a.media.video.fps).toBeCloseTo(facts.video.fps, 3); expect(Math.abs(a.media.durationMs - facts.durationMs)).toBeLessThanOrEqual(100);
  expect(a.media.audio).toEqual({ codec: 'pcm-s16', sampleRate: 48000, channels: 1 }); expect(a.media.decoder).toBe('wasm');
  expect(a.poster).toBeTruthy(); expect(a.proxy).toBeTruthy();
});
const IMAGES = ['pattern.png', 'pattern.jpg', 'pattern.jpeg', 'pattern.gif', 'pattern.bmp', 'pattern.webp', 'pattern.tiff', 'pattern-deflate.tiff', 'pattern.heic', 'grid.heic', 'pattern.svg'];
const VIDEOS = ['h264-aac.mp4', 'prores.mov', 'mpeg4.avi', 'vp9-opus.webm', 'h264-opus.mkv', 'h264.m4v'];
test('F8 every accepted image and video extension really ingests: probe + thumbnail, content vs the source', async ({ page }) => {
  await upload(page, [...IMAGES, ...VIDEOS].map(media)); await settled(page, IMAGES.length + VIDEOS.length);
  const all = await assets(page);
  for (const name of IMAGES) {
    const a = all[name]; expect.soft(a?.status, name).toBe('ready'); expect.soft(a?.steps?.thumbnails, name).toBe('complete');
    const expected: Rgb = name === 'pattern.heic' ? ffmpegImageRgb('heic-single') : name === 'grid.heic' ? ffmpegImageRgb('heic-grid') : name === 'pattern.svg' ? { width: 96, height: 64, rgb: new Uint8Array(0) } : ffmpegImageRgb(media(name));
    expect.soft(a?.media?.image && [a.media.image.width, a.media.image.height], name).toEqual([expected.width, expected.height]);
    if (!a?.poster) continue;
    const poster = rgbOf(save(`${name}.jpg`, a.poster));
    if (name === 'pattern.svg') {
      // Known regions of our own SVG: red top-left, blue background bottom-left, green circle.
      const at = (x: number, y: number) => Array.from(poster.rgb.subarray((y * poster.width + x) * 3, (y * poster.width + x) * 3 + 3));
      for (const [x, y, rgb] of [[10, 10, [255, 0, 0]], [10, 55, [32, 64, 192]], [72, 44, [0, 255, 0]]] as const) at(x, y).forEach((v, c) => expect.soft(Math.abs(v - rgb[c]), `${name} ${x},${y}`).toBeLessThanOrEqual(24));
    } else { const c = compare(poster, expected); console.log(`${name}: poster ΔE ${c.worstDeltaE.toFixed(2)} PSNR ${c.psnr.toFixed(1)} dB`); expect.soft(c.worstDeltaE, `${name} ΔE2000`).toBeLessThanOrEqual(3); }
  }
  for (const name of VIDEOS) {
    const a = all[name], facts = expectedFacts(media(name)); expect.soft(a?.status, name).toBe('ready'); expect.soft(a?.steps?.thumbnails, name).toBe('complete');
    expect.soft(a?.media?.video && [a.media.video.displayWidth, a.media.video.displayHeight], name).toEqual([facts.video.displayWidth, facts.video.displayHeight]);
    expect.soft(a?.poster, name).toBeTruthy();
  }
});
test('F10 + F14 both photo keys can be added through the panel; the cost/limit line stays at every point of use', async ({ page }) => {
  await page.route(url => /api\.pexels\.com|api\.unsplash\.com|images\./.test(url.hostname), route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'api.pexels.com') return route.fulfill({ json: url.pathname.includes('videos') ? { videos: [] } : { photos: Array.from({ length: 10 }, (_, i) => ({ id: i, width: 1, height: 1, url: 'u', photographer: 'p', src: { original: 'https://images.pexels.com/x.png', medium: 'https://images.pexels.com/x.png' } })) } });
    if (url.hostname === 'api.unsplash.com') return route.fulfill({ json: Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, width: 1, height: 1, user: { name: 'u' }, urls: { full: 'https://images.unsplash.com/x.png', small: 'https://images.unsplash.com/x.png' }, links: { html: 'h' } })) });
    return route.fulfill({ body: readFileSync(media('pattern.png')), contentType: 'image/png' });
  });
  await page.route(url => /freesound\.org/.test(url.hostname), route => route.fulfill({ json: { results: [], next: null } }));
  await page.goto('/'); const id = await page.evaluate(async () => { const s = '/src/store/database.ts'; return (await (await import(s)).projectStore.create('Keys')).id as string; });
  await page.goto(`/project/${id}`); await page.getByRole('tab', { name: 'Photos', exact: true }).click();
  const cost = page.getByText('the provider’s own request limits apply', { exact: false });
  await expect(cost).toHaveCount(1);
  await page.getByLabel('Pexels API key').fill('pk'); await page.getByRole('button', { name: 'Save Pexels key' }).click();
  const results = page.getByRole('list', { name: 'Photo results' }).getByRole('listitem');
  await expect(results).toHaveCount(10); await expect(cost).toHaveCount(1);
  await page.getByText('Manage stock keys').click(); await page.getByLabel('Unsplash API key').fill('uk'); await page.getByRole('button', { name: 'Save Unsplash key' }).click();
  await expect(results).toHaveCount(20);
  expect(await page.evaluate(async () => { const s = '/src/store/database.ts', k = '/src/media/stock.ts'; return (await import(k)).readKeys((await import(s)).projectStore); })).toEqual({ pexels: 'pk', unsplash: 'uk' });
  for (const [tab, label] of [['Videos', 'Pexels API key'], ['Sounds', 'Freesound API key']] as const) {
    await page.getByRole('tab', { name: tab, exact: true }).click(); await expect(cost).toHaveCount(1);
    if (tab === 'Sounds') { await page.getByLabel(label).fill('fk'); await page.getByRole('button', { name: 'Save Freesound key' }).click(); await expect(page.getByLabel('Search sounds')).toBeVisible(); await expect(cost).toHaveCount(1); }
  }
});
test('F11 hiding or leaving the page cancels a running preparation (CLIENT_PREPARATION_CANCELLED); showing it again resumes', async ({ page }) => {
  await upload(page, [media('slow-hevc.mp4')]);
  const phase = () => page.evaluate(async () => { const s = '/src/store/database.ts'; const { projectStore } = await import(s); const [a] = (await projectStore.library()).assets; const r = a && await projectStore.row('preparations', a.id); return { phase: r?.phase ?? null, code: a?.last_error_code ?? null, status: a?.processing_status ?? null }; });
  await expect.poll(async () => (await phase()).phase, { timeout: 30_000, intervals: [50] }).toBe('running');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')); });
  await expect.poll(phase, { timeout: 10_000 }).toMatchObject({ phase: 'cancelled', code: 'CLIENT_PREPARATION_CANCELLED' });
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(phase, { timeout: 120_000 }).toMatchObject({ status: 'ready', code: null });
});
test('F13 derived media match the source: waveform buckets vs ffmpeg PCM; poster and proxy frames vs ffmpeg (SDR, HDR→SDR, rotation)', async ({ page }) => {
  const names = ['h264-aac.mp4', 'hevc10-pq.mp4', 'rotation-90.mp4'];
  await upload(page, names.map(media)); await settled(page, 3);
  const all = await assets(page);
  for (const name of ['h264-aac.mp4', 'hevc10-pq.mp4']) {
    // The mono mix is the channel mean (notes, waveform). Not `-ac 1`: for float audio ffmpeg mixes stereo as 0.707·(L + R).
    const pcm = (() => {
      const n = Number(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', media(name)], { encoding: 'utf8' }).stdout.trim());
      const mean = `pan=mono|c0=${Array.from({ length: n }, (_, i) => `${1 / n}*c${i}`).join('+')}`;
      const r = spawnSync('ffmpeg', ['-v', 'error', '-i', media(name), '-vn', '-af', mean, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { maxBuffer: 64 << 20 });
      return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
    })();
    // The waveform row can land after the status badge settles under load: poll a fresh read until it exists.
    let fresh = all;
    await expect.poll(async () => (fresh = await assets(page))[name].peaks, { timeout: 60_000 }).not.toBeNull();
    const peaks: number[] = fresh[name].peaks, per = 480, buckets = Math.ceil(pcm.length / per);
    expect(Math.abs(peaks.length / 2 - buckets), `${name} bucket count`).toBeLessThanOrEqual(1);
    let worst = 0;
    for (let b = 0; b < Math.min(buckets, peaks.length / 2); b++) {
      let lo = Infinity, hi = -Infinity; for (let i = b * per; i < Math.min(pcm.length, (b + 1) * per); i++) { lo = Math.min(lo, pcm[i]); hi = Math.max(hi, pcm[i]); }
      worst = Math.max(worst, Math.abs(peaks[2 * b] - lo), Math.abs(peaks[2 * b + 1] - hi));
    }
    console.log(`${name}: worst waveform bucket |Δ| ${worst.toFixed(4)}`); expect(worst, `${name} waveform`).toBeLessThanOrEqual(0.01);
  }
  const k = 15; // poster time = min(1 s, duration / 2) = 0.5 s → frame 15 at 30 fps
  const sdr: Rgb = { width: 320, height: 180, rgb: frameRgb(media('h264-aac.mp4'), k) };
  const rot: Rgb = { width: 180, height: 320, rgb: frameRgb(media('rotation-90.mp4'), k) };
  const hdr: Rgb = (() => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', media('hevc10-pq.mp4'), '-vf', `select=eq(n\\,${k})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-'], { maxBuffer: 64 << 20 });
    const raw = r.stdout as Buffer, w = 320, h = 180, Y = new Uint16Array(raw.buffer, raw.byteOffset, w * h), U = new Uint16Array(raw.buffer, raw.byteOffset + w * h * 2, w * h / 4), V = new Uint16Array(raw.buffer, raw.byteOffset + w * h * 2.5, w * h / 4);
    const rgb = new Uint8Array(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = (y >> 1) * (w >> 1) + (x >> 1); referencePixel(Y[y * w + x], U[c], V[c], 'pq').forEach((v, i) => { rgb[(y * w + x) * 3 + i] = Math.round(v * 255); }); }
    return { width: w, height: h, rgb };
  })();
  for (const [name, expected] of [['h264-aac.mp4', sdr], ['hevc10-pq.mp4', hdr], ['rotation-90.mp4', rot]] as const) {
    const poster = rgbOf(save(`${name}.poster.jpg`, all[name].poster)), p = compare(poster, expected);
    const proxyFile = save(`${name}.proxy.mp4`, all[name].proxy); expect(ffprobePts(proxyFile).pts.length).toBe(30);
    const proxy: Rgb = { width: expected.width, height: expected.height, rgb: frameRgb(proxyFile, k) }, q = compare(proxy, expected);
    console.log(`${name}: poster ΔE ${p.worstDeltaE.toFixed(2)} PSNR ${p.psnr.toFixed(1)} dB; proxy ΔE ${q.worstDeltaE.toFixed(2)} PSNR ${q.psnr.toFixed(1)} dB`);
    expect(p.worstDeltaE, `${name} poster`).toBeLessThanOrEqual(3); expect(q.worstDeltaE, `${name} proxy`).toBeLessThanOrEqual(3);
    expect(p.psnr, `${name} poster PSNR`).toBeGreaterThanOrEqual(25); expect(q.psnr, `${name} proxy PSNR`).toBeGreaterThanOrEqual(25);
  }
});
