// SPDX-License-Identifier: AGPL-3.0-only
// T15 (deferred from T04 D5): a time-remapped clip shows the source frame its remap curve asks for, at 100 sample times.
// Formula oracle: remap keyframes (timeline seconds -> source ms, linear easing) are interpolated linearly; the source frame for source
// time s ms of a 30 fps constant-rate clip from 0 is n = floor(s x 30 / 1000 + 1e-6) (findings part 5 §53.3.1 frame pick). The paused
// canvas (project size = clip size, 320 x 180) must be closer to ffmpeg's decoded frame n than to frame n - 1 or n + 1 (mean abs diff
// over RGB), the same marker test the seek spec uses on S1. Sample times whose source time sits within 0.15 frame of a frame boundary
// are skipped (the pick is ambiguous to the decoder's 0.1 ms tolerance there). The G-02 preview frames F1/F2 are NOT used: they live in
// the private raw-reference folder that only T00's stored-reference mode reads.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { runtimeCall } from './t04-support';
import { canvasSizeOf, crop, makeClip, meanAbsDiff, openWithVideos, seekMs, shown, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the clip and the oracle frames');
test.setTimeout(300_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 4, FPS = 30, W = 320, H = 180, FRAMES = SECONDS * FPS;
// timeline seconds -> source ms: forward, a hold, then backwards
const CURVE: [number, number][] = [[0, 10], [1, 2990], [2, 2990], [3, 510], [4, 3910]];
const sourceMs = (tl: number) => {
  for (let k = 1; k < CURVE.length; k++) if (tl <= CURVE[k][0]) { const [t0, v0] = CURVE[k - 1], [t1, v1] = CURVE[k]; return v0 + (v1 - v0) * (tl - t0) / (t1 - t0); }
  return CURVE[CURVE.length - 1][1];
};

test('100 sample times on a remapped clip show the source frame the remap curve asks for', async ({ page }) => {
  const clip = makeClip(SECONDS, W, H);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  expect(r.status).toBe(0);
  const size = W * H * 3, all = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length);
  expect(all.length).toBe(size * FRAMES);
  const oracle = (n: number) => all.subarray(n * size, (n + 1) * size);

  await openWithVideos(page, videoDoc([{ id: 'vid', to: SECONDS * 1000, sourceDuration: SECONDS * 1000 }], { size: { width: W, height: H }, duration: SECONDS * 1000 }), { vid: { path: clip } }, 'T15 remap shown');
  const set = await runtimeCall(page, 'setTimeRemap', { itemId: 'vid', keyframes: CURVE.map(([time, value]) => ({ time, value, easing: 'linear' })) }) as { success: boolean };
  expect(set.success).toBe(true);

  // 100 distinct timeline frames spread over the 120 of the clip.
  const frames = Array.from({ length: 100 }, (_, k) => Math.floor(k * (FRAMES - 1) / 99)).filter((f, k, a) => a.indexOf(f) === k);
  let sampled = 0, skipped = 0, worst = 0;
  for (const f of frames) {
    const tl = f / FPS, s = sourceMs(tl), n = Math.floor(s * FPS / 1000 + 1e-6), phase = s * FPS / 1000 - n;
    if (phase < 0.15 || phase > 0.85 || n >= FRAMES) { skipped++; continue; }
    await seekMs(page, tl * 1000); await shown(page, f);
    const canvas = await crop(page, 0, 0, W, H), d = (m: number) => meanAbsDiff(canvas, oracle(m));
    const here = d(n), neighbours = [n - 1, n + 1].filter(m => m >= 0 && m < FRAMES).map(d);
    worst = Math.max(worst, here); sampled++;
    expect(here, `timeline frame ${f} (t = ${tl.toFixed(3)} s, source ${s.toFixed(1)} ms): canvas vs ffmpeg source frame ${n}`).toBeLessThan(Math.min(...neighbours));
  }
  expect(sampled, 'enough sample times were measurable').toBeGreaterThanOrEqual(60);
  test.info().annotations.push({ type: 'measured', description: `${sampled} sample times measured, ${skipped} skipped near frame boundaries; worst mean abs diff vs ffmpeg ${worst.toFixed(3)}` });
  expect(await canvasSizeOf(page)).toEqual({ width: W, height: H });
});

// Written-spec oracle: "Cutframe agent tool results (C).md" l.1667 (G-02 readable frames): a 10 s, 30 fps clip at timeline 0-10 s, trim 0-10,
// rate 1, with the §38 remap fixture 0 s -> 0 ms easeInOut, 5 s -> 8000 ms bezier [0.25, 0.1, 0.25, 1], 10 s -> 2000 ms. Paused preview:
// at 0.516667 s the shown frame is 16 and the picture is source frame 5; at 0.75 s frame 23 and source frame 11 (the playhead rounds half
// up, then the remap curve is applied; a floor of the unsnapped time would give 10 at 0.75 s). Marker: nearest of ffmpeg frames n - 1 / n / n + 1.
test('the §38 remap fixture: 0.516667 s shows frame 16 with source frame 5, 0.75 s shows frame 23 with source frame 11', async ({ page }) => {
  const clip = makeClip(10, W, H), n = 10 * FPS;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  expect(r.status).toBe(0);
  const size = W * H * 3, all = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length);
  expect(all.length).toBe(size * n);
  await openWithVideos(page, videoDoc([{ id: 'vid', to: 10000, sourceDuration: 10000 }], { size: { width: W, height: H }, duration: 10000 }), { vid: { path: clip } }, 'T15 remap §38');
  const set = await runtimeCall(page, 'setTimeRemap', { itemId: 'vid', keyframes: [
    { time: 0, value: 0, easing: 'easeInOut' }, { time: 5, value: 8000, easing: { type: 'bezier', points: [0.25, 0.1, 0.25, 1] } }, { time: 10, value: 2000 },
  ] }) as { success: boolean };
  expect(set.success).toBe(true);
  for (const [t, shownFrame, sourceFrame] of [[0.516667, 16, 5], [0.75, 23, 11]] as const) {
    await seekMs(page, t * 1000); await shown(page, shownFrame);
    const canvas = await crop(page, 0, 0, W, H), d = (m: number) => meanAbsDiff(canvas, all.subarray(m * size, (m + 1) * size));
    const here = d(sourceFrame);
    expect(here, `t = ${t} s, shown frame ${shownFrame}: canvas vs ffmpeg source frame ${sourceFrame}`).toBeLessThan(Math.min(d(sourceFrame - 1), d(sourceFrame + 1)));
  }
});
