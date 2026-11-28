// SPDX-License-Identifier: AGPL-3.0-only
// T15 60 s-class playback with a mid-play mount of a DIFFERENT source (the coordinator runs this one). Gated like the 60 s spec: set T15_LONG=1
// (and have the fixture store: S1 and S2).
// Written-spec oracle (findings §5, part 5 §53.8.3), the same budget as t15-playback-60s.spec.ts, not loosened: no frame skipped, no draw
// without a picture, no dropped video frame, the frame rate within +-2 of 30 fps, no element resync, and the worst drawn-frame drift under one
// frame. Counters are playbackStats (render/playback.ts). maxDriftMs (option G definition, T15 notes / render/playback.ts): since the reset,
// the worst offset of a painted video frame, whichever path drew it: the presented media time of the frame drawn (an element's currentTime, a
// pool frame's decoded timestamp, a remap-cache frame's source time) minus the expected media time at the paint's clock reading t
// (sourceTime at t - from). The elements' own offset is elementMaxDriftMs (information only, not asserted); a mid-play start leaves 63-68 ms
// there, which the pool draws cover until the handoff.
// Measurement oracle (GPU, headed, port 4214, 3 runs, all passed): maxDriftMs 16.40 / 16.57 / 16.23, elementMaxDriftMs 67.6 / 64.0 / 63.2,
// poolDrawnFrames 47 / 47 / 46, handoffs 3 / 3 / 3, handoffMs [267,262,945] / [271,257,922] / [263,260,897] (the ~900 ms entry is S2, which
// has audio), unconverged 0. Pool-drawn frames sit up to half a frame (16.7 ms) off by construction: the paint shows frame round(t x fps).
// Implementation-contract oracle (T15 notes, mount-stall diagnosis: making a media element stalls Chromium's main thread for ~40-50 ms, which
// caused the 60 s skips; elements are reused through an idle pool and, while playing, made only right after a frame paint): lateMounts >= 1,
// i.e. the after-paint path really ran for the S2 mount. The spec asserts from - PREROLL_MS > PREMOUNT_MS so the S2 clip is NOT pre-mounted by
// fillPool at play start; if someone widens the window this spec fails loudly instead of quietly testing nothing.
// Timeline (20 s): V1 plays S1 at [0, 10) and [10, 20); V2 plays S2 (1920 x 1080 cover-fit, with a tone: a <video> and an <audio> element) at
// [14 s, 20 s), trim 0, so it mounts at 12.5 s while the clock runs.
import { test, expect } from '@playwright/test';
import { skipTour } from './t02-support';
import { NO_STORE, S1, fixture, haveFile, openWithVideos, videoDoc } from './t15-support';

const S2 = () => fixture('synthetic', 'S2-framecount-tone-1920x1080-30fps-10s.mp4');
test.skip(process.env.T15_LONG !== '1', 'set T15_LONG=1 to run the mid-play mount playback check (about 40 s wall time)');
test.skip(!haveFile(S1()) || !haveFile(S2()), `S1 and S2 need the fixture store: ${NO_STORE}`);
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 20, FPS = 30, S2_FROM = 14_000;
test('a different source mounting mid-play (S2 at 14 s over S1): skipped, notReady and droppedVideoFrames are 0, fps within 2 of 30, no resync, drift under a frame, lateMounts >= 1', async ({ page }) => {
  const clips = [
    { id: 'a', track: 'v1', from: 0, to: 10000, sourceDuration: 10000 },
    { id: 'b', track: 'v1', from: 10000, to: 20000, sourceDuration: 10000 },
    { id: 'c', track: 'v2', from: S2_FROM, to: 20000, sourceDuration: 10000 },
  ];
  await openWithVideos(page, videoDoc(clips, { duration: SECONDS * 1000 }), { a: { path: S1() }, b: { path: S1() }, c: { path: S2() } }, 'T15 mid-play mount');
  const { PREMOUNT_MS, PREROLL_MS } = await page.evaluate(async () => { const p = '/src/render/playback.ts'; const m = await import(p); return { PREMOUNT_MS: m.PREMOUNT_MS as number, PREROLL_MS: m.PREROLL_MS as number }; });
  expect(S2_FROM - PREROLL_MS, 'the S2 clip mounts after the pre-mount window seen at play start').toBeGreaterThan(PREMOUNT_MS);
  await expect.poll(() => page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.library()).assets.every((a: { processing_status: string }) => a.processing_status === 'ready' || a.processing_status === 'failed'); }), { timeout: 120_000 }).toBe(true);
  await page.waitForTimeout(1500);
  await page.evaluate(async () => { const p = '/src/render/playback.ts'; (await import(p)).resetPlaybackStats(); });
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: (SECONDS + 30) * 1000 }); // it pauses itself at the end
  const wall = (Date.now() - t0) / 1000;
  const stats = await page.evaluate(async () => { const p = '/src/render/playback.ts'; return { ...(await import(p)).playbackStats } as Record<string, number>; });
  const fps = stats.painted / SECONDS;
  console.log(`T15 mid-play mount playback: wall ${wall.toFixed(1)} s, fps ${fps.toFixed(2)}, stats ${JSON.stringify(stats)}`);
  test.info().annotations.push({ type: 'measured', description: `fps ${fps.toFixed(2)}; ${JSON.stringify(stats)}` });
  expect(stats.skipped, 'frame indices never painted').toBe(0);
  expect(stats.notReady, 'draws with no picture yet').toBe(0);
  expect(stats.failed, 'draws that showed the grey failed picture').toBe(0);
  expect(stats.droppedVideoFrames, 'dropped video frames').toBe(0);
  expect(Math.abs(fps - FPS), `fps ${fps}`).toBeLessThanOrEqual(2);
  expect(stats.resyncs, 'element resyncs').toBe(0);
  expect(stats.maxDriftMs, 'max drawn-frame drift from the master clock (ms)').toBeLessThan(1000 / FPS);
  expect(stats.lateMounts, 'media elements made while the clock runs (the after-paint path ran)').toBeGreaterThanOrEqual(1);
  // Implementation-contract oracle (option G): each clip start draws from the decoder pool until its element settles, then hands off.
  expect(stats.handoffs, 'clip starts handed from the pool to their element').toBeGreaterThanOrEqual(1);
  expect(stats.poolDrawnFrames, 'video frames drawn from the pool').toBeGreaterThanOrEqual(1);
});
