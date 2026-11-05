// SPDX-License-Identifier: AGPL-3.0-only
// T15 early handoff when the decoder pool falls behind (render/playback.ts poolBehind(), P19). Needs ffmpeg for a 4 s 320x180 H.264 clip; no fixture store.
// Seam: decoderFaults.poolDelayMs (render/decoder-pool.ts): decodes take turns, one per poolDelayMs across the whole pool, before their request is sent, so the
// pool delivers at most 1000 / poolDelayMs frames/s (cache hits are not slowed). It is read at each turn: setting it back to 0 drains the waiting decodes at once.
// Scenario: open the clip with the pool at full speed (first paused frame drawn), set poolDelayMs, press Play. The start waits at most START_WAIT_MS for the
// first POOL_AHEAD frames, then the clock runs and the pool draws; with the pool slower than real time it runs out of prefetched frames while the element
// is still settling (HANDOFF_SETTLE_MS), so the pool's latest frame drifts from the clock and poolBehind() hands the clip to the element early.
// Written-spec / coordinator oracle (P19, P18, option G; the drift bound is the steady-state playback test's 1.5 frames): the early handoff is counted
// (behindHandoffs >= 1), no frame index is skipped, no element resync, and every drawn frame stays within 1.5 frames of the clock (maxDriftMs).
// Implementation-contract oracle: handoffs >= behindHandoffs, and driftLog has an element-path paint after the pool-path paints.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { makeClip, openWithVideos, shown, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the H.264 clip');
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 4, FPS = 30, DELAY = 350; // measured on 4217: 200 ms hands off at ~225 ms (normal ~264), 350 at ~158, 500 at ~132; 350 leaves the pool 4-5 frames stale by the normal handoff time
const setDelay = (page: Page, ms: number) => page.evaluate(async ms => { const p = '/src/render/decoder-pool.ts'; (await import(p)).decoderFaults.poolDelayMs = ms; }, ms);

test(`the pool lags (${DELAY} ms per decode): the clip is handed to the element early (behindHandoffs >= 1), skipped 0, resyncs 0, drift under 1.5 frames`, async ({ page }) => {
  await openWithVideos(page, videoDoc([{ id: 'vid', to: SECONDS * 1000, sourceDuration: SECONDS * 1000 }], { duration: SECONDS * 1000 }), { vid: { path: makeClip(SECONDS) } }, 'T15 pool behind');
  await shown(page, 0);
  // Processing must be finished: a source swap (proxy ready) during playback would remount the clip and start a second pool phase.
  await expect.poll(() => page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.library()).assets.every((a: { processing_status: string }) => a.processing_status === 'ready' || a.processing_status === 'failed'); }), { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(1500);
  await page.evaluate(async () => { const p = '/src/render/playback.ts'; (await import(p)).resetPlaybackStats(); });
  await setDelay(page, DELAY);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  // The handoff (early or normal) lands while the clip plays.
  await expect.poll(() => page.evaluate(async () => { const p = '/src/render/playback.ts'; return (await import(p)).playbackStats.handoffs as number; }), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(700); // element-path paints after the handoff
  const r = await page.evaluate(async () => {
    const p = '/src/render/playback.ts', { playbackStats, driftLog } = await import(p);
    return { stats: { ...playbackStats } as Record<string, any>, log: driftLog.map((e: { t: number; driftMs: number; path: string }) => `${Math.round(e.t)}:${e.driftMs.toFixed(1)}:${e.path}`) as string[] };
  });
  await setDelay(page, 0); // drain the waiting decodes before Pause
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const s = r.stats, paths = r.log.map(l => l.split(':')[2]), firstElement = paths.indexOf('element');
  console.log(`T15 pool behind: delay ${DELAY} ms stats ${JSON.stringify(s)}\npaths ${paths.length} pool ${paths.filter(x => x === 'pool').length} element ${paths.filter(x => x === 'element').length} firstElement ${firstElement}\nlog ${r.log.join(' ')}`);
  test.info().annotations.push({ type: 'measured', description: `delay ${DELAY}; behindHandoffs ${s.behindHandoffs}; handoffs ${s.handoffs} ${JSON.stringify(s.handoffMs)}; maxDriftMs ${(s.maxDriftMs as number).toFixed(2)}; poolDrawnFrames ${s.poolDrawnFrames}` });
  expect(s.behindHandoffs, 'handoffs made early because the pool fell behind').toBeGreaterThanOrEqual(1);
  expect(s.handoffs, 'every early handoff is a handoff').toBeGreaterThanOrEqual(s.behindHandoffs);
  expect(s.skipped, 'frame indices never painted').toBe(0);
  expect(s.resyncs, 'element resyncs').toBe(0);
  expect(s.maxDriftMs, 'max drawn-frame drift from the master clock (ms)').toBeLessThan(1.5 * 1000 / FPS);
  expect(firstElement, 'the element draws after the pool').toBeGreaterThan(0);
});
