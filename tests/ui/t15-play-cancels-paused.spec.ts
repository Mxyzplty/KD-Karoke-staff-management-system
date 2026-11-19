// SPDX-License-Identifier: AGPL-3.0-only
// T15 audit F2 (red-first, D115): a paused render still in flight when Play starts must never paint over the playing canvas. The paused effect
// (editor/preview-stage.tsx:80-98) returns at once while playing (:81) and bumps its generation only when it runs paused, so a render started before
// Play passes its check (:90) and then resizes the canvas, composites the old frame and sets data-frame / data-exact (:91-93) during playback.
// Oracle: T15's own rule that a playing canvas is data-exact="false" (the playback paint, preview-stage.tsx:59-73, sets it every frame), and
// playback never shows an earlier frame than one it already showed (no seek happens while playing here).
// Seam: decoderFaults.poolDelayMs (render/decoder-pool.ts), as t15-pool-behind.spec.ts uses it: the paused decode of the seek frame waits DELAY before
// its request, longer than START_WAIT_MS = 1000 ms (render/playback.ts:441-454), so it lands after the playback clock started. Frame 15 is never decoded
// before the seek, so the paused render really waits.
// Sampling: a MutationObserver (attributeOldValue) on the run canvas records every write of data-exact and data-frame, so a stale write is caught even
// when the next playback paint overwrites it within the same frame. The value each record set is the next record's old value (or the final value).
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { makeClip, openWithVideos, runCanvas, seekMs, shown, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the H.264 clip');
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 6, FPS = 30, N = 15, DELAY = 1800, WINDOW = 3000; // play from 0.5 s; the window ends well before the 6 s end (start wait <= 1 s)
const setDelay = (page: Page, ms: number) => page.evaluate(async ms => { const p = '/src/render/decoder-pool.ts'; (await import(p)).decoderFaults.poolDelayMs = ms; }, ms);

/** Opens the clip, waits for processing (a proxy arriving mid-play would swap the source) and the first paused frame. */
async function open(page: Page, title: string) {
  await openWithVideos(page, videoDoc([{ id: 'vid', to: SECONDS * 1000, sourceDuration: SECONDS * 1000 }], { duration: SECONDS * 1000 }), { vid: { path: makeClip(SECONDS) } }, title);
  await expect.poll(() => page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.library()).assets.every((a: { processing_status: string }) => a.processing_status === 'ready' || a.processing_status === 'failed'); }), { timeout: 60_000 }).toBe(true);
  // Review 17f1959a finding 1: settle on the source the stage now uses (the proxy, once ready): its frame 0 is decoded, so that re-render's
  // decode cannot join the paced chain after setDelay, ahead of the seek decode.
  await expect.poll(() => cached(page, 0), { timeout: 30_000, message: 'frame 0 of the current source is decoded' }).toBe(true);
  await shown(page, 0);
}
/** Whether the decoder cache holds source time `ms` of the clip's current source (render/sources.ts mediaKey with the stored asset row). */
const cached = (page: Page, ms: number) => page.evaluate(async ms => {
  const s = '/src/render/sources.ts', p = '/src/render/decoder-pool.ts', d = '/src/store/database.ts', e = '/src/editor.tsx';
  const { mediaKey } = await import(s), { cachedFrame } = await import(p), { projectStore } = await import(d), { activeSession } = await import(e);
  const item = activeSession.document.items.find((i: { id: string }) => i.id === 'vid'), asset = await projectStore.row('assets', item.metadata.assetId);
  return !!cachedFrame(mediaKey(item, asset), ms);
}, ms);
/** Starts recording every data-exact / data-frame write on run canvas 0. */
const arm = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('canvas.run[data-run="0"]')!, w = window as any;
  w.__f2 = [] as { name: string; old: string | null; at: number }[];
  w.__f2obs = new MutationObserver(list => { const at = performance.now(); for (const m of list) w.__f2.push({ name: m.attributeName, old: m.oldValue, at }); });
  w.__f2obs.observe(c, { attributes: true, attributeOldValue: true, attributeFilter: ['data-exact', 'data-frame'] });
});
const now = (page: Page) => page.evaluate(() => performance.now());
/** The values written to each attribute at or after `from` (performance.now() in the page), in order. */
const written = (page: Page, from: number) => page.evaluate(from => {
  const c = document.querySelector('canvas.run[data-run="0"]')!, w = window as any;
  w.__f2obs.disconnect();
  const recs = w.__f2 as { name: string; old: string | null; at: number }[], out: Record<string, string[]> = { 'data-exact': [], 'data-frame': [] };
  for (const name of Object.keys(out)) {
    const mine = recs.filter(r => r.name === name);
    mine.forEach((r, k) => { if (r.at >= from) out[name].push(String(k + 1 < mine.length ? mine[k + 1].old : c.getAttribute(name))); });
  }
  return out;
}, from);
/** Presses Play, keeps playing WINDOW ms, returns what was written meanwhile, then pauses. */
async function playWindow(page: Page) {
  const from = await now(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.waitForTimeout(WINDOW);
  // Review 17f1959a finding 1, positive control: the seek frame's decode (source time 500 ms) has landed while still playing and before the
  // drain below, so its render's paint, if any, falls inside the recorded window. Decodes are not cancelled, so this holds before and after the fix.
  await expect.poll(() => cached(page, N * 1000 / FPS), { timeout: 2000, message: 'the seek frame was decoded while playing' }).toBe(true);
  await expect(page.getByRole('button', { name: 'Pause', exact: true }), 'still playing at the end of the window').toBeVisible();
  const w = await written(page, from);
  await setDelay(page, 0); // drain any waiting decode before Pause
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  return w;
}
function expectPlayingWrites(w: Record<string, string[]>) {
  const frames = w['data-frame'].map(Number);
  expect(frames.length, 'playback painted frames during the window').toBeGreaterThan(0);
  expect(w['data-exact'].filter(v => v === 'true'), 'data-exact never "true" while playing').toEqual([]);
  const back = frames.findIndex((f, k) => k > 0 && f < frames[k - 1]);
  expect(back, `data-frame never goes backwards while playing (frames ${frames.join(',')})`).toBe(-1);
}

test(`F2: a paused render delayed ${DELAY} ms past Play does not paint over playback: data-exact never "true", data-frame never backwards`, async ({ page }) => {
  await open(page, 'T15 F2 paused in flight');
  await setDelay(page, DELAY);
  await arm(page);
  await seekMs(page, N * 1000 / FPS);
  await expect(runCanvas(page), 'the paused render of the seek frame started').toHaveAttribute('data-exact', 'false');
  expectPlayingWrites(await playWindow(page));
});

test('F2 guard: with no delay (the seek frame drawn before Play), playback writes data-exact "false" only and data-frame never goes backwards', async ({ page }) => {
  await open(page, 'T15 F2 guard');
  await arm(page);
  await seekMs(page, N * 1000 / FPS);
  await shown(page, N);
  expectPlayingWrites(await playWindow(page));
});
