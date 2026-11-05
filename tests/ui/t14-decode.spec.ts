// SPDX-License-Identifier: AGPL-3.0-only
// T14 acceptance 2–4 and 5 (part) in real Chromium. Oracle: ffmpeg's own decode of the same file (ground truth, F17 C-gt).
// Tolerances: WASM (FFmpeg's decoders) frames bit-exact (max |Δ| = 0); WebCodecs frames max |Δ| ≤ 2 code values with
// PSNR ≥ 50 dB (hardware decoders may round differently); VFR timestamps ±0.5 ms; audio: residual ≤ −50 dBFS RMS and
// level within ±0.1 dB after cross-correlation alignment (master plan §4 audio oracle); HDR: ΔE2000 ≤ 3 per patch.
import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ffmpegAvailable, ffprobePts, hasStore, media, STORE } from '../media-fixtures';
import { deltaE2000, lab, referencePixel } from '../colour-reference';
import { yuvToRgba } from '../../apps/web/src/media/tonemap';

test.skip(!ffmpegAvailable(), 'ffmpeg is the oracle');
test.setTimeout(180_000);
const served = new Map<string, string>();
async function serve(page: Page, file: string) {
  const name = `${served.size}-${path.basename(file)}`; served.set(name, file);
  await page.route(`**/__t14/${name}`, route => route.fulfill({ path: file, contentType: 'application/octet-stream' }));
  return `/__t14/${name}`;
}
/** ffmpeg's decode of presentation frame k as planar samples (8-bit or 16-bit little-endian), autorotated. */
function ffmpegFrame(file: string, k: number, pixFmt: string) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${k})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'], { maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr)); return r.stdout as Buffer;
}
function ffmpegPcm(file: string) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr)); return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
}
type Decoded = { decoder: string; count: number; timestamps: number[]; width: number; height: number; bitDepth: number; chroma: string; y: number[]; u: number[]; v: number[]; rotation: number };
/** Decode in the page; returns frame k's planes (cropped to the visible size) and all timestamps. */
async function decode(page: Page, url: string, k: number, forceWasm = false): Promise<Decoded> {
  return page.evaluate(async ({ url, k, forceWasm }) => {
    const p = '/src/media/decode.ts'; const { videoFrames, videoDecoder } = await import(p);
    const blob = await (await fetch(url)).blob(), decoder = await videoDecoder(blob, { forceWasm });
    const timestamps: number[] = []; let pick: any;
    for await (const f of videoFrames(blob, { forceWasm })) { if (timestamps.length === k) pick = f; timestamps.push(f.timestamp); }
    const cw = pick.chroma === '444' ? pick.width : Math.ceil(pick.width / 2), ch = pick.chroma === '420' ? Math.ceil(pick.height / 2) : pick.height;
    const crop = (plane: ArrayLike<number>, stride: number, w: number, h: number) => { const out: number[] = []; for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out.push(plane[r * stride + c]); return out; };
    return { decoder, count: timestamps.length, timestamps, width: pick.width, height: pick.height, bitDepth: pick.bitDepth, chroma: pick.chroma,
      y: crop(pick.y, pick.yStride, pick.width, pick.height), u: crop(pick.u, pick.cStride, cw, ch), v: crop(pick.v, pick.cStride, cw, ch), rotation: 0 };
  }, { url, k, forceWasm });
}
/** The shipped display path: frame k through frameToRgba with the probed rotation (review F12: no test-side rotation). */
async function displayFrame(page: Page, url: string, k: number, forceWasm: boolean): Promise<{ width: number; height: number; rgba: number[]; rotation: number; decoder: string }> {
  return page.evaluate(async ({ url, k, forceWasm }) => {
    const d = '/src/media/decode.ts', p = '/src/media/probe.ts'; const { videoFrames, frameToRgba, videoDecoder } = await import(d), { probeMedia } = await import(p);
    const blob = await (await fetch(url)).blob(), rotation = (await probeMedia(blob, 'clip.mp4', 'video')).video!.rotation;
    let i = 0; for await (const f of videoFrames(blob, { forceWasm })) if (i++ === k) { const out = frameToRgba(f, rotation); return { width: out.width, height: out.height, rgba: Array.from(out.data), rotation, decoder: await videoDecoder(blob, { forceWasm }) }; }
    throw new Error('frame not found');
  }, { url, k, forceWasm });
}
/** Expected display frame: ffmpeg's autorotated planes through the shipped converter, without rotation. */
function expectedDisplay(file: string, k: number, width: number, height: number, matrix = 'bt709') {
  const raw = ffmpegFrame(file, k, 'yuv420p'), cw = width / 2;
  const frame = { width, height, bitDepth: 8 as const, chroma: '420' as const, y: raw.subarray(0, width * height), u: raw.subarray(width * height, width * height * 1.25), v: raw.subarray(width * height * 1.25), yStride: width, cStride: cw, fullRange: false };
  return yuvToRgba(frame, matrix, null);
}
function rgbaDiff(a: ArrayLike<number>, b: ArrayLike<number>) {
  let max = 0, se = 0; for (let i = 0; i < a.length; i++) { if (i % 4 === 3) continue; const d = Math.abs(a[i] - b[i]); max = Math.max(max, d); se += d * d; }
  return { max, psnr: se === 0 ? Infinity : 10 * Math.log10(255 * 255 / (se / (a.length * 0.75))) };
}function compare(ours: Decoded, raw: Buffer, wide: boolean) {
  const samples = wide ? Array.from(new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)) : Array.from(raw);
  const all = [...ours.y, ...ours.u, ...ours.v]; expect(all.length).toBe(samples.length);
  let max = 0, se = 0; for (let i = 0; i < all.length; i++) { const d = Math.abs(all[i] - samples[i]); max = Math.max(max, d); se += d * d; }
  const peak = wide ? 1023 : 255, psnr = se === 0 ? Infinity : 10 * Math.log10(peak * peak / (se / all.length));
  return { max, psnr };
}
const cases = [
  { name: 'h264-aac.mp4', pix: 'yuv420p', wide: false, expect: 'webcodecs' },
  { name: 'hevc10-sdr.mp4', pix: 'yuv420p10le', wide: true, expect: 'wasm-unless-native' },
  { name: 'hevc10-pq.mp4', pix: 'yuv420p10le', wide: true, expect: 'wasm-unless-native' },
  { name: 'prores.mov', pix: 'yuv422p10le', wide: true, expect: 'wasm' },
  { name: 'h264-opus.mkv', pix: 'yuv420p', wide: false, expect: 'webcodecs' },
];
test('which codecs this Chromium decodes natively (WebCodecs)', async ({ page }) => {
  await page.goto('/');
  const support = await page.evaluate(async () => Object.fromEntries(await Promise.all(Object.entries({ h264: 'avc1.640028', hevc10: 'hvc1.2.4.L120.90', vp9: 'vp09.00.10.08', prores: 'apcn' }).map(async ([k, codec]) => [k, (await VideoDecoder.isConfigSupported({ codec, codedWidth: 320, codedHeight: 180 }).catch(() => ({ supported: false }))).supported]))));
  console.log('WebCodecs decode support:', JSON.stringify(support), await page.evaluate(() => navigator.userAgent));
  expect(support.h264, 'H.264 must decode natively (else run the suite on the Chrome channel)').toBe(true);
});
for (const c of cases) test(`${c.name}: decoded frame 7 equals ffmpeg's frame 7 (natural path), and through the forced WASM path`, async ({ page }) => {
  await page.goto('/'); const file = media(c.name), url = await serve(page, file), raw = ffmpegFrame(file, 7, c.pix);
  const natural = await decode(page, url, 7);
  if (c.expect === 'webcodecs') expect(natural.decoder).toBe('webcodecs');
  if (c.expect === 'wasm') expect(natural.decoder).toBe('wasm');
  const n = compare(natural, raw, c.wide);
  if (natural.decoder === 'wasm') expect(n.max).toBe(0); else { expect(n.max).toBeLessThanOrEqual(2); expect(n.psnr).toBeGreaterThanOrEqual(50); }
  const forced = await decode(page, url, 7, true); expect(forced.decoder).toBe('wasm');
  expect(compare(forced, raw, c.wide).max).toBe(0);
  expect(forced.timestamps).toEqual(natural.timestamps.map(t => expect.closeTo(t, 3)));
  expect(forced.count).toBe(ffprobePts(file).pts.length);
});
test('damaged ProRes sample data raises the ingest form of DECODE_ERROR (natural and forced WASM path)', async ({ page }) => {
  await page.goto('/');
  const outcome = await page.evaluate(async bytes => {
    const p = '/src/media/decode.ts'; const { videoFrames } = await import(p);
    // ProRes frames start with a frame header: overwrite every sample's payload so no frame is decodable.
    const data = new Uint8Array(bytes); const view = new DataView(data.buffer);
    let mdat = -1, end = 0; for (let at = 0; at + 8 < data.length;) { const size = view.getUint32(at), type = String.fromCharCode(...data.subarray(at + 4, at + 8)); if (type === 'mdat') { mdat = at; end = at + size; break; } at += size; }
    for (let i = mdat + 16; i < end; i++) data[i] = 0xff; // the movie box (after mdat) stays intact
    const out: Record<string, unknown> = {};
    for (const forceWasm of [false, true]) {
      try { let n = 0; for await (const _ of videoFrames(new Blob([data]), { forceWasm })) n++; out[String(forceWasm)] = `decoded ${n}`; }
      catch (e) { out[String(forceWasm)] = { code: (e as { code?: string }).code, category: (e as { category?: string }).category }; }
    }
    return out;
  }, Array.from(readFileSync(media('prores.mov'))));
  expect(outcome).toEqual({ false: { code: 'DECODE_ERROR', category: 'system_error' }, true: { code: 'DECODE_ERROR', category: 'system_error' } });
});
test('VFR: every decoded timestamp equals ffprobe pts (±0.5 ms), WebCodecs and WASM', async ({ page }) => {
  await page.goto('/'); const file = media('vfr.mp4'), url = await serve(page, file), pts = ffprobePts(file).pts;
  for (const forceWasm of [false, true]) {
    const d = await decode(page, url, 0, forceWasm);
    expect(d.timestamps.length).toBe(pts.length);
    d.timestamps.forEach((t, i) => expect(Math.abs(t - pts[i])).toBeLessThanOrEqual(0.0005));
  }
});
test('rotation 90: frame shown 1080 × 1920-style (180 × 320) and equals ffmpeg\'s autorotated frame', async ({ page }) => {
  await page.goto('/'); const file = media('rotation-90.mp4'), url = await serve(page, file);
  const info = await page.evaluate(async url => { const p = '/src/media/probe.ts'; const { probeMedia } = await import(p); return (await probeMedia(await (await fetch(url)).blob(), 'r.mp4', 'video')).video; }, url);
  expect(info).toMatchObject({ rotation: 270, displayWidth: 180, displayHeight: 320 });
  const expected = expectedDisplay(file, 3, 180, 320);
  for (const forceWasm of [false, true]) {
    const d = await displayFrame(page, url, 3, forceWasm); expect([d.width, d.height, d.rotation]).toEqual([180, 320, 270]);
    const m = rgbaDiff(d.rgba, expected);
    if (d.decoder === 'wasm') expect(m.max).toBe(0); else { expect(m.max).toBeLessThanOrEqual(6); expect(m.psnr).toBeGreaterThanOrEqual(45); }
  }
});
for (const name of ['ac3.mp4', 'eac3.mp4']) test(`${name}: audio decodes to PCM matching ffmpeg's decode, and the waveform worker gives peaks`, async ({ page }) => {
  await page.goto('/'); const file = media(name), url = await serve(page, file), reference = Array.from(ffmpegPcm(file));
  for (const forceWasm of [false, true]) {
    const ours: { rate: number; channels: number; data: number[]; source: string; peaks: number[]; buckets: number } = await page.evaluate(async ({ url, forceWasm }) => {
      const p = '/src/media/decode.ts', w = '/src/media/work.ts'; const { decodeAudio } = await import(p), { makeWaveform } = await import(w);
      const blob = await (await fetch(url)).blob(), pcm = await decodeAudio(blob, { forceWasm }), wave = await makeWaveform(blob, { forceWasm });
      return { rate: pcm.sampleRate, channels: pcm.channels, data: Array.from(pcm.data[0]), source: pcm.source, peaks: Array.from(wave.peaks), buckets: wave.bucketsPerSecond };
    }, { url, forceWasm });
    expect([ours.rate, ours.channels, ours.source]).toEqual([48000, 1, forceWasm ? 'wasm' : 'webcodecs']);
    // Cross-correlation lag (must be ≤ 1 ms = 48 samples), then level and residual at that lag.
    let best = -Infinity, bestLag = 0;
    for (let lag = -2048; lag <= 2048; lag++) { let s = 0; for (let i = 4800; i < 4800 + 9600; i++) s += (ours.data[i + lag] ?? 0) * (reference[i] ?? 0); if (s > best) { best = s; bestLag = lag; } }
    let e = 0, r = 0, o = 0, n = 0;
    for (let i = 4800; i < reference.length - 4800; i++) { const a = ours.data[i + bestLag] ?? 0, b = reference[i]; e += (a - b) ** 2; r += b * b; o += a * a; n++; }
    const residualDb = 10 * Math.log10(e / n + 1e-20), levelDb = 10 * Math.log10(o / r);
    console.log(`${name} (${ours.source}): lag ${bestLag} samples, residual ${residualDb.toFixed(1)} dBFS, level ${levelDb.toFixed(3)} dB`);
    expect(Math.abs(bestLag)).toBeLessThanOrEqual(48); expect(residualDb).toBeLessThanOrEqual(-50); expect(Math.abs(levelDb)).toBeLessThanOrEqual(0.1);
    expect(ours.buckets).toBe(100); expect(ours.peaks.length / 2).toBeGreaterThanOrEqual(99); expect(Math.max(...ours.peaks)).toBeGreaterThan(0.05);
  }
});
/** Tone-mapped frame k vs the independent CPU reference on 8 × 4 test-pattern patches (mean colour per patch). */
async function hdrDeltaE(page: Page, file: string, transfer: 'pq' | 'hlg', k: number) {
  const url = await serve(page, file), raw = ffmpegFrame(file, k, 'yuv420p10le');
  const ours: { w: number; h: number; rgba: number[]; source: string } = await page.evaluate(async ({ url, k }) => {
    const p = '/src/media/decode.ts'; const { videoFrames, frameToRgba } = await import(p);
    let i = 0; for await (const f of videoFrames(await (await fetch(url)).blob())) if (i++ === k) { const out = frameToRgba(f); return { w: out.width, h: out.height, rgba: Array.from(out.data), source: f.source }; }
    throw new Error('frame not found');
  }, { url, k });
  const w = ours.w, h = ours.h, Y = new Uint16Array(raw.buffer, raw.byteOffset, w * h), U = new Uint16Array(raw.buffer, raw.byteOffset + w * h * 2, (w / 2) * (h / 2)), V = new Uint16Array(raw.buffer, raw.byteOffset + w * h * 2 + (w / 2) * (h / 2) * 2, (w / 2) * (h / 2));
  let worst = 0;
  for (let py = 0; py < 4; py++) for (let px = 0; px < 8; px++) {
    const sum = [0, 0, 0], ref = [0, 0, 0]; let count = 0;
    for (let y = Math.floor(py * h / 4) + 2; y < Math.floor((py + 1) * h / 4) - 2; y++) for (let x = Math.floor(px * w / 8) + 2; x < Math.floor((px + 1) * w / 8) - 2; x++) {
      const o = (y * w + x) * 4; sum[0] += ours.rgba[o] / 255; sum[1] += ours.rgba[o + 1] / 255; sum[2] += ours.rgba[o + 2] / 255;
      const c = (y >> 1) * (w >> 1) + (x >> 1), [r, g, b] = referencePixel(Y[y * w + x], U[c], V[c], transfer); ref[0] += r; ref[1] += g; ref[2] += b; count++;
    }
    worst = Math.max(worst, deltaE2000(lab(sum.map(v => v / count)), lab(ref.map(v => v / count))));
  }
  return { worst, source: ours.source };
}
for (const [name, transfer] of [['hevc10-pq.mp4', 'pq'], ['hevc10-hlg.mp4', 'hlg']] as const) test(`HDR ${transfer.toUpperCase()}: detected, decoded and tone-mapped within ΔE2000 ≤ 3 of the CPU reference`, async ({ page }) => {
  await page.goto('/'); const r = await hdrDeltaE(page, media(name), transfer, 10);
  console.log(`${name}: worst patch ΔE2000 ${r.worst.toFixed(3)} (${r.source})`); expect(r.worst).toBeLessThanOrEqual(3);
});
test.describe('fixture store (ground truth)', () => {
  test.skip(!hasStore, 'needs $CUTFRAME_FIXTURES');
  const s = (n: string) => path.join(STORE, 'synthetic', n);
  for (const [name, pix, wide] of [['S5b-hdr10-pq-hevc10.mp4', 'yuv420p10le', true], ['S5c-hlg-hevc10.mp4', 'yuv420p10le', true], ['S5h-prores422.mov', 'yuv422p10le', true], ['S5g-container.mkv', 'yuv420p', false], ['S5i-hevc10-sdr.mp4', 'yuv420p10le', true]] as const)
    test(`${name}: frame 45 equals ffmpeg's (natural and forced WASM)`, async ({ page }) => {
      await page.goto('/'); const url = await serve(page, s(name)), raw = ffmpegFrame(s(name), 45, pix);
      const natural = await decode(page, url, 45); const m = compare(natural, raw, wide);
      if (natural.decoder === 'wasm') expect(m.max).toBe(0); else { expect(m.max).toBeLessThanOrEqual(2); expect(m.psnr).toBeGreaterThanOrEqual(50); }
      expect(compare(await decode(page, url, 45, true), raw, wide).max).toBe(0);
    });
  test('S5a VFR timestamps and S5d at 1080 × 1920', async ({ page }) => {
    await page.goto('/'); const pts = ffprobePts(s('S5a-vfr.mp4')).pts, d = await decode(page, await serve(page, s('S5a-vfr.mp4')), 0);
    expect(d.timestamps.length).toBe(65); d.timestamps.forEach((t, i) => expect(Math.abs(t - pts[i])).toBeLessThanOrEqual(0.0005));
    const url = await serve(page, s('S5d-rotation-90.mp4')), expected = expectedDisplay(s('S5d-rotation-90.mp4'), 30, 1080, 1920);
    for (const forceWasm of [false, true]) {
      const r = await displayFrame(page, url, 30, forceWasm); expect([r.width, r.height]).toEqual([1080, 1920]);
      const m = rgbaDiff(r.rgba, expected); if (r.decoder === 'wasm') expect(m.max).toBe(0); else { expect(m.max).toBeLessThanOrEqual(6); expect(m.psnr).toBeGreaterThanOrEqual(45); }
    }
  });
  for (const [name, transfer] of [['S5b-hdr10-pq-hevc10.mp4', 'pq'], ['S5c-hlg-hevc10.mp4', 'hlg']] as const) test(`${name}: tone-mapped patches within ΔE2000 ≤ 3`, async ({ page }) => {
    await page.goto('/'); const r = await hdrDeltaE(page, s(name), transfer, 45); console.log(`${name}: worst ΔE2000 ${r.worst.toFixed(3)}`); expect(r.worst).toBeLessThanOrEqual(3);
  });
  for (const name of ['S5e-ac3-audio.mp4', 'S5f-eac3-audio.mp4']) test(`${name}: PCM vs ffmpeg residual ≤ −50 dBFS`, async ({ page }) => {
    await page.goto('/'); const url = await serve(page, s(name)), reference = ffmpegPcm(s(name));
    const data: number[] = await page.evaluate(async url => { const p = '/src/media/decode.ts'; const { decodeAudio } = await import(p); return Array.from((await decodeAudio(await (await fetch(url)).blob())).data[0]); }, url);
    let best = 0, lag = 0; for (let l = -2048; l <= 2048; l++) { let s2 = 0; for (let i = 4800; i < 14400; i++) s2 += (data[i + l] ?? 0) * reference[i]; if (s2 > best) { best = s2; lag = l; } }
    let e = 0, n = 0; for (let i = 4800; i < reference.length - 4800; i++) { e += ((data[i + lag] ?? 0) - reference[i]) ** 2; n++; }
    expect(10 * Math.log10(e / n + 1e-20)).toBeLessThanOrEqual(-50);
  });
});
