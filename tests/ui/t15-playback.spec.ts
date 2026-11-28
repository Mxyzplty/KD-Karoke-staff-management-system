// SPDX-License-Identifier: AGPL-3.0-only
// T15 playback controls and clock. Needs ffmpeg for a 2 s H.264 clip.
// Written-spec oracle (part 5 §53.8.3, findings §5/§7b.2): Play/Pause button and Space toggle playback; the playhead advances on
// ONE master clock (the AudioContext's while it runs, else performance.now) so it tracks wall time; one paint per frame index
// round(t s x fps) so the playhead sits on frame boundaries; playback pauses at the end of the timeline.
// PROVISIONAL (P6): "Play at the end restarts from 0", pausing at the exact end with the playhead at the duration, and the
// playhead staying on the last painted frame when paused.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { prop } from './t04-support';
import { makeAudioClip, makeClip, openWithVideos, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the H.264 clips (picture-only and with an AAC tone) that play');
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 2, FPS = 30;
const open = (page: Page) => openWithVideos(page, videoDoc([{ id: 'vid', to: SECONDS * 1000, sourceDuration: SECONDS * 1000 }], { duration: SECONDS * 1000 }), { vid: { path: makeClip(SECONDS) } }, 'T15 playback');
const playhead = (page: Page) => page.evaluate(async () => { const p = '/src/editor/view.ts'; return (await import(p)).view().playheadMs as number; });
const setPlayhead = (page: Page, ms: number) => page.evaluate(async ms => { const p = '/src/editor/view.ts'; (await import(p)).setView({ playheadMs: ms }); }, ms);
const isPlaying = (page: Page) => page.evaluate(async () => { const p = '/src/render/playback.ts'; return (await import(p)).usePlayback.getState().playing as boolean; });
const playButton = (page: Page) => page.getByRole('button', { name: 'Play', exact: true });
const pauseButton = (page: Page) => page.getByRole('button', { name: 'Pause', exact: true });

test('Play and Pause buttons toggle playback and swap their names', async ({ page }) => {
  await open(page);
  await expect(playButton(page)).toBeVisible(); expect(await isPlaying(page)).toBe(false);
  await playButton(page).click(); await expect(pauseButton(page)).toBeVisible(); expect(await isPlaying(page)).toBe(true);
  await pauseButton(page).click(); await expect(playButton(page)).toBeVisible(); expect(await isPlaying(page)).toBe(false);
});

test('Space toggles playback from the stage', async ({ page }) => {
  await open(page);
  await page.locator('section.preview').click({ position: { x: 5, y: 5 } }); // focus the preview, not a button
  await page.keyboard.press('Space'); await expect(pauseButton(page)).toBeVisible(); expect(await isPlaying(page)).toBe(true);
  await page.keyboard.press('Space'); await expect(playButton(page)).toBeVisible(); expect(await isPlaying(page)).toBe(false);
});

test('the playhead advances with the wall clock and sits on frame boundaries; Pause freezes it', async ({ page }) => {
  await open(page);
  await playButton(page).click(); await expect(pauseButton(page)).toBeVisible();
  await expect.poll(() => playhead(page), { timeout: 10000 }).toBeGreaterThan(0); // the start waits for the visible clips, at most 1 s
  const sample = await page.evaluate(async () => {
    const p = '/src/editor/view.ts', { view } = await import(p), a = { t: view().playheadMs, w: performance.now() };
    await new Promise(r => setTimeout(r, 600));
    return { dt: view().playheadMs - a.t, dw: performance.now() - a.w };
  });
  expect(Math.abs(sample.dt - sample.dw), `playhead moved ${sample.dt.toFixed(0)} ms in ${sample.dw.toFixed(0)} ms of wall time`).toBeLessThanOrEqual(150);
  await pauseButton(page).click(); await expect(playButton(page)).toBeVisible();
  const frozen = await playhead(page);
  await page.waitForTimeout(400);
  expect(await playhead(page), 'paused: the playhead does not move').toBe(frozen);
  expect(Math.abs(frozen / 1000 * FPS - Math.round(frozen / 1000 * FPS)), 'paused on a frame boundary').toBeLessThan(0.01);
});

test('playback pauses at the end of the timeline with the playhead at the duration', async ({ page }) => {
  await open(page);
  await setPlayhead(page, SECONDS * 1000 - 400);
  await playButton(page).click();
  await expect(playButton(page)).toBeVisible({ timeout: 15000 });
  expect(await isPlaying(page)).toBe(false);
  expect(await playhead(page)).toBe(SECONDS * 1000);
});

test('Play at the end restarts from 0 (P6, provisional)', async ({ page }) => {
  await open(page);
  await setPlayhead(page, SECONDS * 1000);
  await playButton(page).click(); await expect(pauseButton(page)).toBeVisible(); expect(await isPlaying(page)).toBe(true);
  const first = () => page.evaluate(async () => { const p = '/src/render/playback.ts'; return (await import(p)).playbackStats.firstFrame as number; });
  await expect.poll(first, { timeout: 10000 }).toBeGreaterThanOrEqual(0); // the first paint after the start (-1 until then)
  expect(await first(), 'first painted frame after the restart is within the first frames').toBeLessThanOrEqual(2);
  expect(await playhead(page), 'playing from the start, not at the end').toBeLessThan(SECONDS * 1000 - 100);
});

// Master clock (render/playback.ts, provisional P18, written-spec oracle: the T15 notes' clock rule): the AudioContext clock is the master only
// while the context plays sound; otherwise performance.now. Every switch re-anchors once (playbackStats.reanchors + 1). T13 moved all preview
// sound to Web Audio (audio/preview.ts), so "plays sound" now means a mixed chunk with non-zero samples has started (before T13: a buffer source
// or a boosted element routed through a GainNode). The switch is made mid-play: a 7 s timeline, a picture-only clip on V2 over [0, 2 s], and a
// 4 s 1080x1920 clip with AAC audio on V1 over [2 s, 6 s]. Its sound starts at t = 2 s, after the clock has started on performance.now.
// Needs ffmpeg and the library to finish preparing the media first.
const readyAssets = (page: Page) => expect.poll(() => page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.library()).assets.every((a: { processing_status: string }) => a.processing_status === 'ready' || a.processing_status === 'failed'); }), { timeout: 120_000 }).toBe(true);
async function startClockLayout(page: Page, volume: number) {
  const doc = videoDoc([
    { id: 'pic', track: 'v2', from: 0, to: 2000, sourceDuration: 2000 },
    { id: 'loud', track: 'v1', from: 2000, to: 6000, sourceDuration: 4000, properties: { volume: prop(volume) } },
  ], { duration: 7000 });
  await openWithVideos(page, doc, { pic: { path: makeClip(2) }, loud: { path: makeAudioClip(4, 1080, 1920) } }, 'T15 clock');
  await readyAssets(page); await page.waitForTimeout(1500);
  await page.evaluate(async () => { const p = '/src/render/playback.ts'; (await import(p)).resetPlaybackStats(); });
  await playButton(page).click(); await expect(pauseButton(page)).toBeVisible();
}
const readStats = (page: Page) => page.evaluate(async () => { const p = '/src/render/playback.ts'; return { ...(await import(p)).playbackStats } as Record<string, number>; });
async function playClockLayout(page: Page, volume: number) {
  await startClockLayout(page, volume);
  await page.waitForTimeout(4000);
  // Read before Pause: stopping unmounts the sounds, which is not part of the rule under test.
  const stats = await page.evaluate(async () => { const p = '/src/render/playback.ts'; return { ...(await import(p)).playbackStats } as Record<string, number>; });
  await pauseButton(page).click(); await expect(playButton(page)).toBeVisible();
  console.log(`T15 clock layout volume ${volume}: ${JSON.stringify(stats)}`);
  return stats;
}

test('clock: a boosted sound (volume 1.5) mounting mid-play moves the clock to the context with one re-anchor (P18, provisional)', async ({ page }) => {
  const s = await playClockLayout(page, 1.5);
  // Drift is not asserted here: a mid-play clip start leaves up to ~70 ms for under a second in headless Chromium at either volume (the catch-up absorbs it); resyncs 0 bounds it below 200 ms.
  // Under option G that start offset is in elementMaxDriftMs; maxDriftMs (the worst drawn-frame offset) covers it with pool draws until the handoff.
  expect(s.sounds, 'the boosted clip mounted a sound').toBeGreaterThanOrEqual(1);
  expect(s.reanchors, 'the clock switched to the context once the boosted sound mounted').toBeGreaterThanOrEqual(1);
  expect(s.skipped, 'frame indices never painted').toBe(0);
  expect(s.resyncs, 'element resyncs').toBe(0);
  expect(s.failed, 'draws that showed the grey failed picture').toBe(0);
});

// T13 changed this control from volume 1 to volume 0: at volume 1 the clip is now heard through Web Audio and moves the clock like the boosted one.
test('clock control: the same layout at volume 0 (silent) never leaves performance.now: 0 re-anchors (P18, provisional)', async ({ page }) => {
  const s = await playClockLayout(page, 0);
  expect(s.reanchors, 're-anchors with no sound').toBe(0);
});

// Steady state on the audio clock (measurement oracle): once the boosted clip (starts at 2 s) has settled, 2.5 s of playback (3 s to 5.5 s)
// has no resync and no further re-anchor. maxDriftMs is zeroed (that field only) at playhead >= 3 s. Under option G, maxDriftMs is the worst
// offset of a painted video frame, whichever path drew it (presented media time of the frame drawn minus the expected media time at the
// paint's clock reading); the 65-70 ms mid-play start transient is now in elementMaxDriftMs, not maxDriftMs, so zeroing at 3 s is harmless.
// The drift bound 1.5 frames (50 ms) is a test-bound choice (not Xapp parity, the spec gives no drift number). Four runs on port 4217 measured
// 17.76 / 14.40 / 16.10 / 20.03 ms (element offset, before option G); 50 ms leaves 2.5x headroom over the worst, and a broken clock lands near
// 200 ms, the resync threshold. The measured drift is logged and added to the test annotations. maxRafGapMs is zeroed with it, and the console line
// and the drift assertion message carry maxRafGapMs, resyncs and the driftLog series from 3 s on, so a pass or a failure classifies itself (stall vs offset).
test('clock steady state: boosted sound on the context clock: 3 s to 5.5 s, drift under 1.5 frames, no resync, no re-anchor (P18)', async ({ page }) => {
  await startClockLayout(page, 1.5);
  await expect.poll(() => playhead(page), { timeout: 15000 }).toBeGreaterThanOrEqual(3000);
  const mark = await page.evaluate(async () => { const p = '/src/render/playback.ts', { playbackStats } = await import(p); playbackStats.maxDriftMs = 0; playbackStats.maxRafGapMs = 0; return playbackStats.reanchors as number; });
  await expect.poll(() => playhead(page), { timeout: 15000 }).toBeGreaterThanOrEqual(5500);
  // Before Pause: stopping unmounts the sounds. driftLog (render/playback.ts, outside playbackStats) holds the latest 600 painted video frames since the
  // reset, each { t, driftMs (signed: presented minus expected, negative = behind), path, gapMs (the rAF gap before that paint) }; a failure classifies itself:
  // a stall has gapMs about equal to driftMs, a sustained offset has many entries with small gaps.
  const { s, series } = await page.evaluate(async () => {
    const p = '/src/render/playback.ts', { playbackStats, driftLog } = await import(p);
    return { s: { ...playbackStats } as Record<string, number>, series: (driftLog as { t: number; driftMs: number; path: string; gapMs: number }[]).filter(e => e.t >= 3000).map(e => `${e.t}:${e.driftMs}:${e.path}:${e.gapMs}`) };
  });
  await pauseButton(page).click(); await expect(playButton(page)).toBeVisible();
  const detail = `maxRafGapMs ${s.maxRafGapMs}, resyncs ${s.resyncs}, drift series (t:driftMs:path:gapMs, t >= 3000) ${series.join(' ')}`;
  console.log(`T15 clock steady state: maxDriftMs ${s.maxDriftMs}, reanchors ${mark} -> ${s.reanchors}, resyncs ${s.resyncs}, sounds ${s.sounds}, maxRafGapMs ${s.maxRafGapMs}, drift series (t:driftMs:path:gapMs, t >= 3000) ${series.join(' ')}`);
  test.info().annotations.push({ type: 'measured', description: `maxDriftMs ${s.maxDriftMs}` });
  expect(s.sounds, 'the boosted clip has a sound mounted').toBeGreaterThanOrEqual(1);
  expect(s.maxDriftMs, `steady-state drawn-frame drift from the context clock (ms); ${detail}`).toBeLessThan(1.5 * 1000 / FPS);
  expect(s.resyncs, 'element resyncs').toBe(0);
  expect(s.failed, 'draws that showed the grey failed picture').toBe(0);
  expect(s.reanchors, 're-anchors since the reset point').toBe(mark);
});
