// SPDX-License-Identifier: AGPL-3.0-only
// T15 seek accuracy on S1 (1080x1920, 30 fps, 10 s framecount video). 100 seek points: after each seek the paused stage shows
// the fixture frame number the clock asks for.
// Formula oracle (fixture frame numbers): ffmpeg decodes S1 frame n and the burned-in counter region of the canvas must be
// closer to ffmpeg frame n than to frame n - 1 or n + 1, and data-frame must equal round(t s x 30) (findings part 5 §53.8.3).
// NOTE: the brief names "red box x = 12n mod 1080" as the marker; in S1 the red box is static (x 360..479, y 1500..1619), so the
// burned-in counter ("0050" style digits, x 240..840, y 592..800) is the marker used here.
// PROVISIONAL: S1 marker = burned-in frame counter (fixture doc says a red box moving 360 px/s; the actual file's box is static).
import { test, expect } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { COUNTER, S1_FRAMES, counterCrops, readCounter } from '../../parity/s1-counter';
import { skipTour } from './t02-support';
import { NO_STORE, S1, canvasSizeOf, crop, haveFile, openWithVideos, seekMs, shown, videoDoc } from './t15-support';

test.skip(!haveFile(S1()), `S1 needs the fixture store: ${NO_STORE}`);
test.skip(!ffmpegAvailable(), 'ffmpeg decodes the oracle frames');
test.setTimeout(300_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const { x: X, y: Y, w: W, h: H } = COUNTER, FRAMES = S1_FRAMES, FPS = 30;

test('100 seek points on S1: the paused frame is the fixture frame round(t x 30)', async ({ page }) => {
  const oracle = counterCrops(S1()); // the shared S1 counter reader (parity/s1-counter.ts), also used by the G-02 frames runner
  await openWithVideos(page, videoDoc([{ id: 'vid' }]), { vid: { path: S1() } }, 'S1 seek');
  // 100 distinct frames ((37 k + 11) mod 300; 37 is coprime with 300, and k = 97 / 24 give the first / last frame), each time offset
  // by less than half a frame so that rounding (not truncation) picks the frame: +0.4 / -0.4 of a frame in turn.
  const points = Array.from({ length: 100 }, (_, k) => (k * 37 + 11) % FRAMES);
  expect(new Set(points).size).toBe(100);
  expect([points.includes(0), points.includes(FRAMES - 1)]).toEqual([true, true]);
  let worst = 0;
  for (const [k, n] of points.entries()) {
    const offset = n === 0 ? 0.3 : n === FRAMES - 1 ? -0.3 : (k % 2 ? 0.4 : -0.4), ms = Math.max(0, (n + offset) / FPS * 1000);
    expect(Math.round(ms / 1000 * FPS), `point ${k}`).toBe(n);
    await seekMs(page, ms); await shown(page, n);
    // The canvas is at the project size (= S1's size), so the crop of the counter region is the region as shown.
    const canvas = await crop(page, X, Y, W, H), candidates = [n - 1, n, n + 1].filter(m => m >= 0 && m < FRAMES);
    const read = readCounter(canvas, candidates.map(m => oracle[m]));
    worst = Math.max(worst, read.diff);
    expect(candidates[read.frame], `frame ${n} (t = ${ms.toFixed(2)} ms): the counter region is nearest to ffmpeg frame ${n}`).toBe(n);
    expect(read.diff, `frame ${n}: strictly closer to ffmpeg frame ${n} than to ${n - 1} / ${n + 1}`).toBeLessThan(read.runnerUp);
  }
  test.info().annotations.push({ type: 'measured', description: `worst counter-region mean abs diff vs ffmpeg over 100 seeks: ${worst.toFixed(3)} (8-bit levels)` });
  // A paused frame is always at the project size (§53.8.3).
  expect(await canvasSizeOf(page)).toEqual({ width: 1080, height: 1920 });
});
