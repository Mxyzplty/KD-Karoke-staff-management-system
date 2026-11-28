// SPDX-License-Identifier: AGPL-3.0-only
// T15 seeks while playing (the coordinator runs this one on the GPU). Gated like the mount spec: set T15_LONG=1 (and have the fixture store: S2).
// Behaviour under test (render/playback.ts): a seek while playing (setView({ playheadMs }) as the timeline does) restarts like play(): it stops
// the media, holds the clock while the last painted frame stays on screen, waits for the pool's first POOL_AHEAD frames at the new time (at
// most START_WAIT_MS), then re-anchors; the decoder pool draws until the element hands off. playbackStats.seeks counts the seeks, and the
// frame-index tracking resets, so a seek is never a skipped frame.
// Timeline: one S2 clip (1920 x 1080 with a tone; its element holds 60-78 ms after a seek) on V1 at [0, 10 s), 30 fps. Seeks while playing:
// 1.5 -> 6 s, 7.5 -> 1 s, 3 -> 7 s (the coordinator's probe scratch/t15-probe-seek-s2-hold.mjs seeks 3 -> 8 s; 7 s here so the clip does not end before the last handoff lands).
// Written-spec / coordinator-budget oracle (findings §5, part 5 §53.8.3; not loosened): skipped 0, resyncs 0, maxDriftMs < 1000 / FPS, plus
// notReady 0, droppedVideoFrames 0 and seeks === the number of seeks made. NOT asserted: fps (paints are fewer during the holds) and
// lateMounts. maxDriftMs is the worst drawn-frame offset, whichever path drew it (T15 notes / render/playback.ts, option G).
// Implementation-contract oracle: the pool draws after each seek (poolDrawnFrames increases after every seek).
// Measurement oracle (the probe, reported not bounded): skipped 0, resyncs 0, stale 0, notReady 0, maxDriftMs 15.9, elementMaxDriftMs 68.9,
// handoffs 3 [882, 885, 880], unconverged 1, holds (seek -> first new paint) 515 / 267 / 382 ms. This spec logs the same values per run.
// Per-window report (no asserts of its own): maxDriftMs is wrapped in the page by an accessor, and a window is closed at every setView and at the end.
// Window 0 is play -> the first seek; window k is seek k's setView -> the next seek (the last one: +1 s). Each window reports its stale and skipped
// deltas, its maxDriftMs and its worst frame. The budget above is asserted on the largest window, which is the same number as one unwrapped maxDriftMs
// (the accessor keeps the running max inside each window and nothing else changes). The worst frame carries the drift, the wall time since its window
// opened, and view().playheadMs at the draw (the clock media time, up to one frame old: the app sets the playhead after the paint). The painted media
// time and the sign of the drift are not observable from outside render/playback.ts (drawn() is module-local), so the painted time is not reported.
import { test, expect, type Page } from '@playwright/test';
import { skipTour } from './t02-support';
import { NO_STORE, fixture, haveFile, openWithVideos, videoDoc } from './t15-support';

const S2 = () => fixture('synthetic', 'S2-framecount-tone-1920x1080-30fps-10s.mp4');
test.skip(process.env.T15_LONG !== '1', 'set T15_LONG=1 to run the seek-while-playing check (about 30 s wall time)');
test.skip(!haveFile(S2()), `S2 needs the fixture store: ${NO_STORE}`);
test.setTimeout(150_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const FPS = 30;
// [playhead ms to wait for before the seek, seek target ms]
const SEEKS: [number, number][] = [[1500, 6000], [7500, 1000], [3000, 7000]];
const playhead = (page: Page) => page.evaluate(async () => { const p = '/src/editor/view.ts'; return (await import(p)).view().playheadMs as number; });
const readStats = (page: Page) => page.evaluate(async () => { const p = '/src/render/playback.ts'; return { ...(await import(p)).playbackStats } as Record<string, any>; });

test('three seeks while playing S2: skipped 0, resyncs 0, notReady 0, droppedVideoFrames 0, seeks 3, drawn-frame drift under a frame, the pool draws after each seek', async ({ page }) => {
  await openWithVideos(page, videoDoc([{ id: 'c', to: 10000, sourceDuration: 10000 }], { duration: 10000 }), { c: { path: S2() } }, 'T15 seek while playing');
  await expect.poll(() => page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.library()).assets.every((a: { processing_status: string }) => a.processing_status === 'ready' || a.processing_status === 'failed'); }), { timeout: 120_000 }).toBe(true);
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const pb = '/src/render/playback.ts', v = '/src/editor/view.ts', { playbackStats: s, resetPlaybackStats } = await import(pb), { view } = await import(v);
    resetPlaybackStats();
    type Worst = { driftMs: number; sinceOpenMs: number; playheadMs: number };
    let cur = 0, worst: Worst | null = null, opened = performance.now();
    Object.defineProperty(s, 'maxDriftMs', { configurable: true, enumerable: true, get: () => cur,
      set: (x: number) => { if (x > cur) { cur = x; worst = { driftMs: x, sinceOpenMs: performance.now() - opened, playheadMs: view().playheadMs }; } else if (x === 0) { cur = 0; worst = null; } } });
    (window as unknown as { __window: () => unknown }).__window = () => { const r = { max: cur, worst, stale: s.stale as number, skipped: s.skipped as number }; cur = 0; worst = null; opened = performance.now(); return r; };
  });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  type Win = { max: number; worst: { driftMs: number; sinceOpenMs: number; playheadMs: number } | null; stale: number; skipped: number };
  const holds: number[] = [], poolBefore: number[] = [], poolAfter: number[] = [], closes: Win[] = [];
  for (const [waitFor, target] of SEEKS) {
    await expect.poll(() => playhead(page), { timeout: 20000 }).toBeGreaterThanOrEqual(waitFor);
    // setView at t0, then the hold: performance.now() until playbackStats.painted next increases.
    const r = await page.evaluate(async ({ target }) => {
      const v = '/src/editor/view.ts', pb = '/src/render/playback.ts';
      const { setView } = await import(v), { playbackStats } = await import(pb);
      const painted = playbackStats.painted as number, pool = playbackStats.poolDrawnFrames as number, closed = (window as unknown as { __window: () => unknown }).__window(), t0 = performance.now();
      setView({ playheadMs: target });
      return new Promise<{ hold: number; pool: number; closed: unknown }>(resolve => {
        const tick = () => playbackStats.painted > painted ? resolve({ hold: performance.now() - t0, pool, closed }) : (setTimeout(tick, 5), 0);
        tick();
      });
    }, { target });
    holds.push(Math.round(r.hold)); poolBefore.push(r.pool); closes.push(r.closed as Win);
    await page.waitForTimeout(300); // the pool draws until the element hands off
    poolAfter.push((await readStats(page)).poolDrawnFrames as number);
    await expect.poll(() => playhead(page), { message: `after the seek to ${target} ms the clock runs again`, timeout: 10000 }).toBeGreaterThan(target);
  }
  await page.waitForTimeout(1000); // the last seek's handoff (about 0.9 s for S2) lands before the stats are read
  const stats = await readStats(page); // before Pause: stopping unmounts the sounds
  closes.push(await page.evaluate(() => (window as unknown as { __window: () => unknown }).__window()) as Win); // closes the last window
  // closes[j] is the end of window j (0 = play -> seek 1); stale / skipped are cumulative since the reset.
  const windows = closes.map((c, j) => ({ window: j === 0 ? 'play -> seek 1' : `seek ${j} (-> ${SEEKS[j - 1][1]} ms)`, stale: c.stale - (j ? closes[j - 1].stale : 0), skipped: c.skipped - (j ? closes[j - 1].skipped : 0),
    maxDriftMs: +c.max.toFixed(2), worst: c.worst && { driftMs: +c.worst.driftMs.toFixed(2), sinceWindowOpenMs: Math.round(c.worst.sinceOpenMs), clockMediaMs: Math.round(c.worst.playheadMs) } }));
  const maxDriftMs = Math.max(...closes.map(c => c.max)); // the unwrapped stat is the max of the windows
  await page.getByRole('button', { name: 'Pause', exact: true }).click(); await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  console.log(`T15 seek while playing: holds ${JSON.stringify(holds)} ms, stats ${JSON.stringify({ ...stats, maxDriftMs })}\nwindows ${JSON.stringify(windows)}`);
  test.info().annotations.push({ type: 'measured', description: `holds ${JSON.stringify(holds)} ms; handoffs ${stats.handoffs} ${JSON.stringify(stats.handoffMs)}; unconverged ${stats.unconverged}; maxDriftMs ${maxDriftMs.toFixed(2)}; windows ${JSON.stringify(windows)}; elementMaxDriftMs ${(stats.elementMaxDriftMs as number).toFixed(2)}` });
  expect(stats.skipped, 'frame indices never painted (a seek is never a skip)').toBe(0);
  expect(stats.resyncs, 'element resyncs').toBe(0);
  expect(maxDriftMs, 'max drawn-frame drift from the master clock (ms)').toBeLessThan(1000 / FPS);
  expect(stats.notReady, 'draws with no picture yet').toBe(0);
  expect(stats.failed, 'draws that showed the grey failed picture').toBe(0);
  expect(stats.droppedVideoFrames, 'dropped video frames').toBe(0);
  expect(stats.seeks, 'seeks counted').toBe(SEEKS.length);
  // Implementation-contract oracle: after every seek the pool drew frames.
  SEEKS.forEach(([, target], k) => expect(poolAfter[k], `the pool drew frames after the seek to ${target} ms`).toBeGreaterThan(poolBefore[k]));
});
