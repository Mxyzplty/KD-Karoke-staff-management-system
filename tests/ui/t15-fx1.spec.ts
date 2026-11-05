// SPDX-License-Identifier: AGPL-3.0-only
// T15 stacked alpha on FX-1 (160x96, 30 fps, 60 frames; stacked layout left RGB / right R=G=B=alpha, provisional P2 + P1 marker).
// Formula oracle: FX-1-stacked-alpha-truth.npz (rgba uint8, straight colour, exact per pixel) and OT-4-FX-1-description.json:
//   composite over a background = (colour x alpha + background x (255 - alpha) + 127) // 255.
// (a) ffmpeg-decoded raw RGBA of the FFV1 file (lossless, no colour conversion) through the REAL merge pool and compositor: alpha EXACT.
// (b) the file transcoded at test time to lossless full-range yuv444p (Chromium and T14 cannot decode FFV1) and decoded in real
//     Chromium through the whole preview path: alpha EXACT (R=G=B maps to U=V=128), colour within a MEASURED tolerance.
// Skips with a visible reason when the store, ffmpeg or python+numpy (reads the .npz) is missing.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { NO_STORE, crop, fixture, haveFile, openWithVideos, seekMs, shown, videoDoc } from './t15-support';

const MKV = fixture('prerequisites', 'FX-1-stacked-alpha.mkv'), NPZ = fixture('prerequisites', 'FX-1-stacked-alpha-truth.npz');
const W = 160, H = 96, FRAMES = 60, FPS = 30, FULL = 2 * W;
const numpy = () => spawnSync('python', ['-I', '-c', 'import numpy'], { encoding: 'utf8' }).status === 0;
test.skip(!haveFile(MKV) || !haveFile(NPZ), `FX-1 needs the fixture store (prerequisites/FX-1-stacked-alpha.*): ${NO_STORE}`);
test.skip(!ffmpegAvailable(), 'ffmpeg decodes / transcodes the FX-1 file');
test.skip(!numpy(), 'python with numpy reads the FX-1 truth .npz');
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const run = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { maxBuffer: 1 << 30 }); expect(r.status, `${cmd}: ${r.stderr?.toString().slice(-300)}`).toBe(0); return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length); };
const truth = () => run('python', ['-I', '-c', "import numpy,sys; sys.stdout.buffer.write(numpy.load(sys.argv[1])['rgba'].tobytes())", NPZ]);
const rawFrames = () => run('ffmpeg', ['-v', 'error', '-i', MKV, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
const SAMPLE = [0, 1, 10, 29, 30, 33, 36, 37, 45, 59];
const slice = (all: Uint8Array, n: number, w: number) => all.subarray(n * w * H * 4, (n + 1) * w * H * 4);
const over = (c: number, a: number, bg = 0) => Math.floor((c * a + bg * (255 - a) + 127) / 255);

test('(a) FX-1 raw RGBA through the real merge pool and compositor: alpha equals the truth exactly', async ({ page }) => {
  const truthAll = truth(), raw = rawFrames();
  expect(truthAll.length).toBe(FRAMES * W * H * 4);
  expect(raw.length).toBe(FRAMES * FULL * H * 4);
  await page.goto('/');
  let colourErrors = 0, absentOpaque = 0;
  for (const n of SAMPLE) {
    const frame = Buffer.from(slice(raw, n, FULL)).toString('base64');
    const result = await page.evaluate(async ({ frame, w, h, full }) => {
      const m = '/src/render/merge-pool.ts', mod = '/src/render/model.ts', c = '/src/render/compositor.ts';
      const { mergeStackedAlpha, closeMergePool } = await import(m), { framePlan } = await import(mod), { composite } = await import(c);
      const bytes = () => { const bin = atob(frame), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
      const enc = (u: Uint8ClampedArray | Uint8Array) => { let s = ''; for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode(...u.subarray(k, k + 0x8000)); return btoa(s); };
      const merged = await mergeStackedAlpha(bytes(), full, h, 'data'), asBitmap = await mergeStackedAlpha(bytes(), full, h, 'bitmap');
      const doc = { size: { width: w, height: h }, fps: 30, duration: 2000, tracks: [{ id: 'v1', kind: 'video' }], layerOrder: [{ type: 'track', id: 'v1' }], groups: {},
        items: [{ id: 'fx', type: 'video', trackId: 'v1', display: { from: 0, to: 2000 }, trim: { from: 0 }, properties: {}, metadata: { assetId: 'x' }, effects: [{ id: 'e', effectId: 'stacked-alpha', enabled: true, order: 0, parameters: {} }] }] };
      const plan = framePlan(doc as never, 0, { width: w, height: h });
      const sources = [{ image: asBitmap.bitmap, width: w, height: h }], paint = (backdrop: 'black' | 'clear') => {
        const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        composite(ctx, plan.draws, sources as never, { width: w, height: h }, backdrop); return enc(ctx.getImageData(0, 0, w, h).data);
      };
      const out = { width: merged.width, height: merged.height, data: enc(new Uint8Array(merged.data!)), clear: paint('clear'), black: paint('black'), stacked: plan.draws.map((d: { stackedAlpha: boolean }) => d.stackedAlpha), pending: plan.pending.length };
      closeMergePool(); return out;
    }, { frame, w: W, h: H, full: FULL });
    const t = slice(truthAll, n, W), dec = (s: string) => Uint8Array.from(Buffer.from(s, 'base64')), merged = dec(result.data), clear = dec(result.clear), black = dec(result.black);
    expect([result.width, result.height, result.stacked, result.pending], `frame ${n}`).toEqual([W, H, [true], 0]);
    // Plain loops, one assertion per measure: an expect() per pixel is far too slow for 150k pixels.
    let mergeAlpha = 0, clearAlpha = 0, notOpaque = 0, overBlack = 0;
    for (let p = 0; p < W * H; p++) {
      const a = t[p * 4 + 3];
      if (merged[p * 4 + 3] !== a) mergeAlpha++;
      if (clear[p * 4 + 3] !== a) clearAlpha++;
      if (merged[p * 4] !== t[p * 4] || merged[p * 4 + 1] !== t[p * 4 + 1] || merged[p * 4 + 2] !== t[p * 4 + 2]) colourErrors++;
      if (black[p * 4 + 3] !== 255) notOpaque++;
      for (let k = 0; k < 3; k++) overBlack = Math.max(overBlack, Math.abs(black[p * 4 + k] - over(t[p * 4 + k], a)));
    }
    expect(mergeAlpha, `frame ${n}: merge-pool alpha differs from the truth`).toBe(0);
    expect(clearAlpha, `frame ${n}: compositor alpha over a transparent backdrop differs from the truth`).toBe(0);
    expect(notOpaque, `frame ${n}: pixels not opaque over the black backdrop`).toBe(0);
    expect(overBlack, `frame ${n}: max colour error over black (levels)`).toBeLessThanOrEqual(1);
    if (n >= 30 && n <= 36) for (let p = 0; p < W * H; p++) if (t[p * 4 + 3] !== 0) absentOpaque++;
  }
  // The straight colour half is copied untouched by the merge: every RGB byte equals the truth.
  expect(colourErrors, 'merge-pool RGB bytes that differ from the truth (all sampled frames)').toBe(0);
  test.info().annotations.push({ type: 'note', description: `frames 30..36 ("absentFrameRange") pixels with alpha != 0 in the truth: ${absentOpaque}` });
});

/** Lossless, full-range, BT.709 yuv444p version of FX-1. The colour half goes RGB -> YUV 8-bit (the unavoidable quantisation); R=G=B halves stay exact. */
function transcode(codec: 'x264' | 'vp9') {
  const dir = path.join(tmpdir(), 'cutframe-t15-fx1'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, codec === 'x264' ? 'fx1-444-lossless.mp4' : 'fx1-444-lossless.webm');
  const vf = 'scale=in_range=pc:out_range=pc:out_color_matrix=bt709,format=yuv444p';
  const enc = codec === 'x264' ? ['-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast'] : ['-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8'];
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', MKV, '-vf', vf, ...enc, '-pix_fmt', 'yuv444p', '-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', out]);
  expect(r.status, `ffmpeg transcode: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  return out;
}
const CODEC = (process.env.T15_FX1_CODEC === 'vp9' ? 'vp9' : 'x264') as 'x264' | 'vp9';

test(`(b) FX-1 transcoded to lossless yuv444p (${CODEC}) in real Chromium: alpha exact, colour within the measured tolerance`, async ({ page }) => {
  const truthAll = truth(), file = transcode(CODEC);
  const doc = videoDoc([{ id: 'fx', from: 0, to: 2000, sourceDuration: 2000, effects: [{ id: 'e', effectId: 'stacked-alpha', enabled: true, order: 0, parameters: {} }] }], { size: { width: W, height: H }, duration: 2000 });
  await openWithVideos(page, doc, { fx: { path: file, type: CODEC === 'x264' ? 'video/mp4' : 'video/webm' } }, 'FX-1 stacked alpha');
  let alphaWrong = 0, maxStraight = 0, maxOver = 0;
  for (const n of SAMPLE) {
    await seekMs(page, n / FPS * 1000); await shown(page, n);
    const c = await crop(page, 0, 0, W, H), t = slice(truthAll, n, W);
    for (let p = 0; p < W * H; p++) {
      const a = t[p * 4 + 3];
      if (c[p * 4 + 3] !== a) alphaWrong++;
      for (let k = 0; k < 3; k++) {
        // The canvas holds premultiplied colour, so the comparison is on the colour as seen over black.
        maxOver = Math.max(maxOver, Math.abs(over(c[p * 4 + k], c[p * 4 + 3]) - over(t[p * 4 + k], a)));
        if (a === 255) maxStraight = Math.max(maxStraight, Math.abs(c[p * 4 + k] - t[p * 4 + k]));
      }
    }
  }
  test.info().annotations.push({ type: 'measured', description: `FX-1 yuv444p lossless (${CODEC}) in Chromium: alpha mismatches ${alphaWrong}; max colour error over black ${maxOver}; max straight-colour error where alpha = 255: ${maxStraight} (8-bit levels)` });
  console.log(`T15 FX-1 (b) measured: alpha mismatches ${alphaWrong}, max colour error over black ${maxOver}, max straight colour error at alpha 255 ${maxStraight}`);
  expect(alphaWrong, 'alpha differs from the truth').toBe(0);
  expect(maxOver, 'colour error over black (levels)').toBeLessThanOrEqual(3);
});
