// SPDX-License-Identifier: AGPL-3.0-only
// T15 (deferred from T14): a clip with E-AC-3 audio plays in the editor.
// Written-spec oracle (T14/T15 brief, part 5 §53.8.3): Play starts, the playhead advances on the master clock, playback raises no page
// error, and the stage keeps painting frames. Fixture S5f (H.264 1920x1080 30 fps + E-AC-3 audio, 3 s) comes from the fixture store; the
// spec skips without it (CI has no store). Whether headless Chromium DECODES E-AC-3 is not asserted: the audio decode result is logged
// (playbackStats.sounds / buffers) so the run shows what this browser did; the test only requires that an unsupported audio codec does
// not stop playback.
import { test, expect } from '@playwright/test';
import { skipTour } from './t02-support';
import { NO_STORE, fixture, haveFile, openWithVideos, videoDoc } from './t15-support';

const FILE = () => fixture('synthetic', 'S5f-eac3-audio.mp4');
test.skip(!haveFile(FILE()), `S5f needs the fixture store: ${NO_STORE}`);
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

test('a clip with E-AC-3 audio plays: the playhead advances, frames are painted, no page error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openWithVideos(page, videoDoc([{ id: 'vid', to: 3000, sourceDuration: 3000 }], { duration: 3000 }), { vid: { path: FILE() } }, 'T15 E-AC-3');
  await expect.poll(() => page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.library()).assets.every((a: { processing_status: string }) => a.processing_status === 'ready' || a.processing_status === 'failed'); }), { timeout: 90_000 }).toBe(true);
  await page.evaluate(async () => { const p = '/src/render/playback.ts'; (await import(p)).resetPlaybackStats(); });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  const playhead = () => page.evaluate(async () => { const p = '/src/editor/view.ts'; return (await import(p)).view().playheadMs as number; });
  await expect.poll(playhead, { timeout: 15000 }).toBeGreaterThan(500);
  await page.waitForTimeout(1000);
  const stats = await page.evaluate(async () => { const p = '/src/render/playback.ts'; return { ...(await import(p)).playbackStats } as Record<string, number>; });
  console.log(`T15 E-AC-3 playback stats: ${JSON.stringify(stats)}`);
  expect(await playhead(), 'the clock advanced past the start').toBeGreaterThan(1000);
  expect(stats.painted, 'frames were painted while playing').toBeGreaterThan(10);
  expect(errors, 'no page errors during playback').toEqual([]);
});
