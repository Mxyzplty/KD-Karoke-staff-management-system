// SPDX-License-Identifier: AGPL-3.0-only
// T15 60 s playback of two 1080p tracks from S1 (the coordinator runs this one). Gated: set T15_LONG=1 (and have the fixture store).
// Written-spec oracle (findings §5, part 5 §53.8.3): no frame skipped, no draw without a picture, no dropped video frame over 60 s,
// and the frame rate within +-2 of the project's 30 fps. Counters are playbackStats (render/playback.ts).
// Sync: no resync and maxDriftMs under one frame (1000 / FPS). maxDriftMs (option G definition, T15 notes / render/playback.ts) is, since the
// reset, the worst offset of a painted video frame, whichever path drew it: the presented media time of the frame drawn (an element's
// currentTime, a pool frame's decoded timestamp, a remap-cache frame's source time) minus the expected media time at the paint's clock
// reading t (sourceTime at t - from). The elements' own offset is elementMaxDriftMs (information only). Measurement oracle: before P18 the
// element drift failed at 205.6 ms after Chromium's ~30 s silent-sink swap (the stats span the whole 60 s, so the bound covers that point);
// after P18 it measured 6.0-7.8 ms over 4 runs. With option G (GPU, headed, port 4214), run 2 of 2: maxDriftMs 16.67, elementMaxDriftMs 4.1,
// poolDrawnFrames 108, handoffs 12 (all 260-268 ms); pool-drawn frames sit up to half a frame (16.7 ms) off by construction. The older
// 60 s run 1 failed on skipped 25 (before option G + poolBehind); the freeze-6 evidence is 3 runs on an idle machine, and the results are in the T15 notes. S1 has no audio, so the master clock here is performance.now.
// Plays prepared media: a proxy that lands mid-play swaps the picture element (one hitch; noted in the T15 notes).
// Timeline: six consecutive 10 s copies of S1 on V1 and six on V2 (two simultaneous 1080 x 1920 sources, 60 s).
import { test, expect } from '@playwright/test';
import { skipTour } from './t02-support';
import { NO_STORE, S1, haveFile, openWithVideos, videoDoc } from './t15-support';

test.skip(process.env.T15_LONG !== '1', 'set T15_LONG=1 to run the 60 s playback check (about 90 s wall time)');
test.skip(!haveFile(S1()), `S1 needs the fixture store: ${NO_STORE}`);
test.setTimeout(240_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 60, FPS = 30;
test('60 s of two 1080p tracks: skipped, notReady and droppedVideoFrames are 0 and fps is within 2 of 30', async ({ page }) => {
  const clips = ['v1', 'v2'].flatMap(track => Array.from({ length: 6 }, (_, k) => ({ id: `${track}-${k}`, track, from: k * 10000, to: (k + 1) * 10000, sourceDuration: 10000 })));
  await openWithVideos(page, videoDoc(clips, { duration: SECONDS * 1000 }), Object.fromEntries(clips.map(c => [c.id, { path: S1() }])), 'T15 60 s');
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
  console.log(`T15 60 s playback: wall ${wall.toFixed(1)} s, fps ${fps.toFixed(2)}, stats ${JSON.stringify(stats)}`);
  test.info().annotations.push({ type: 'measured', description: `fps ${fps.toFixed(2)}; ${JSON.stringify(stats)}` });
  expect(stats.skipped, 'frame indices never painted').toBe(0);
  expect(stats.notReady, 'draws with no picture yet').toBe(0);
  expect(stats.failed, 'draws that showed the grey failed picture').toBe(0);
  expect(stats.droppedVideoFrames, 'dropped video frames').toBe(0);
  expect(Math.abs(fps - FPS), `fps ${fps}`).toBeLessThanOrEqual(2);
  expect(stats.resyncs, 'element resyncs').toBe(0);
  expect(stats.maxDriftMs, 'max drawn-frame drift from the master clock (ms)').toBeLessThan(1000 / FPS);
  // Implementation-contract oracle (T15 notes, mount-stall diagnosis): all 12 clips share one S1 asset, so the element pool never makes an element while playing.
  expect(stats.lateMounts, 'media elements made while the clock runs').toBe(0);
});
