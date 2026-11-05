// SPDX-License-Identifier: AGPL-3.0-only
// T04 time-remap frame cache in real Chromium (ticket T04 acceptance; findings part 3 §45.5 "caching frames" with real progress, §46.11 Time Remap).
// Written-spec oracle: with Time Remap on for a real video the Inspector shows "Caching frames… n %" and a progressbar "Caching frames" that reaches 100, then
// the check mark "Frames cached: N" where N is the number of source frames the curve needs (`remapFrameTimes(item, fps).length`, the module's own documented
// frame set) and `remapFrames(id)` holds exactly N blobs; a curve change rebuilds (aborting a running build); a source that cannot be read shows a role=alert
// "Frames could not be cached: …". Showing the frames is T15's and is not tested here.
// provisional choice, not Xapp parity: the frame set (one frame per project frame over the source range), the in-memory store, the failure wording after the
// colon, the encoded blob type (WebP, PNG fallback).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable, media } from '../media-fixtures';
import { createProject, linkClip, skipTour } from './t02-support';
import { liveDoc, undoLabels } from './t03-support';
import { kf, panel, pick, runtimeHandle, section, t04Doc } from './t04-support';

test.skip(!ffmpegAvailable(), 'ffmpeg generates the real video fixture');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

/** The 1 s, 320x180 h264 fixture as a 1 s clip at 0-1 s (the whole source). */
const clipDoc = () => t04Doc({ vid: { display: { from: 0, to: 1000 }, trim: { from: 0, to: 1000 }, sourceDuration: 1000 } });
const MODULE = '/src/editor/remap-cache.ts';

/** Creates the project, stores `bytes` as an asset attached to it, links the clip `vid` to it and opens the editor (optionally with a query string). */
async function openWithSource(page: Page, bytes: Buffer, name: string, query = '') {
  const id = await createProject(page, clipDoc(), 'Remap fixture');
  const assetId = await page.evaluate(async ({ id, name, b64 }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    const asset = await projectStore.upload(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type: 'video/mp4' })); await projectStore.attach(id, asset.id); return asset.id as string;
  }, { id, name, b64: bytes.toString('base64') });
  await linkClip(page, id, assetId, 'vid');
  await page.goto(`/project/${id}${query}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await pick(page, 'vid');
  return id;
}
const realVideo = () => readFileSync(media('h264-aac.mp4'));
const speedSection = (page: Page) => section(page, 'Speed & Time Remap');
const remapSwitch = async (page: Page) => (await speedSection(page)).getByRole('switch', { name: 'Time Remap' });
const stats = (page: Page) => page.evaluate(async m => ({ ...(await import(m)).remapCacheStats }), MODULE);
/** What the cache module holds for `vid` against its own frame-set function. */
const cacheFacts = (page: Page) => page.evaluate(async m => {
  const mod = await import(m), ed = '/src/editor.tsx', { activeSession } = await import(ed);
  const item = activeSession.document.items.find((i: any) => i.id === 'vid'), held = mod.remapFrames('vid');
  return { expected: mod.remapFrameTimes(item, activeSession.document.fps).length, frames: held ? held.frames.length : null, times: held ? held.times.length : null,
    allBlobs: held ? held.frames.every((b: unknown) => b instanceof Blob && (b as Blob).size > 0) : null };
}, MODULE);
/** Records every progress value / label the Inspector shows from now on (the building state can be shorter than a poll interval). */
const watchProgress = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __progress: { text: string; value: number; label: string | null }[] }; w.__progress = [];
  new MutationObserver(() => {
    const box = document.querySelector('.caching'), bar = box?.querySelector('progress');
    if (box && bar) w.__progress.push({ text: box.querySelector('span')?.textContent ?? '', value: bar.value, label: bar.getAttribute('aria-label') });
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
});
const progressSeen = (page: Page) => page.evaluate(() => (window as unknown as { __progress: { text: string; value: number; label: string | null }[] }).__progress);
const cachedMark = (page: Page, n?: number) => panel(page).getByRole('img', { name: n === undefined ? /^Frames cached: \d+$/ : `Frames cached: ${n}` });

for (const [title, query] of [['default decoder', ''], ['?wasm-decode=1 (forced WASM fallback)', '?wasm-decode=1']] as const) {
  test(`${title}: Time Remap on shows "Caching frames… n %" with a progressbar reaching 100, then "Frames cached: N" with N = remapFrameTimes length`, async ({ page }) => {
    await openWithSource(page, realVideo(), 'h264-aac.mp4', query); await watchProgress(page);
    const before = await stats(page); await (await remapSwitch(page)).click();
    await expect(cachedMark(page)).toBeVisible({ timeout: 90_000 });
    const facts = await cacheFacts(page), n = Number(/(\d+)$/.exec((await cachedMark(page).getAttribute('aria-label'))!)![1]);
    expect(facts.expected).toBeGreaterThan(1); expect(n).toBe(facts.expected); expect(facts.frames).toBe(facts.expected); expect(facts.times).toBe(facts.expected); expect(facts.allBlobs).toBe(true);
    const seen = await progressSeen(page); expect(seen.length, 'the building state was shown').toBeGreaterThan(0);
    expect(seen.every(s => s.label === 'Caching frames'), 'the progressbar is named "Caching frames"').toBe(true);
    expect(seen.every(s => s.text === `Caching frames… ${s.value} %`), 'the text and the bar agree').toBe(true);
    expect(Math.max(...seen.map(s => s.value)), 'progress reaches 100').toBe(100);
    for (let i = 1; i < seen.length; i++) expect(seen[i].value, 'progress never goes backwards').toBeGreaterThanOrEqual(seen[i - 1].value);
    await expect(panel(page).getByRole('progressbar', { name: 'Caching frames' })).toHaveCount(0);
    expect(await stats(page)).toEqual({ started: before.started + 1, aborted: before.aborted });
    expect(await undoLabels(page)).toEqual(['Edit items']); // only the toggle is an undo step; the cache is not part of the document
  });
}

test('a curve change rebuilds: started increments, the new frame count follows the new curve', async ({ page }) => {
  await openWithSource(page, realVideo(), 'h264-aac.mp4'); await (await remapSwitch(page)).click(); await expect(cachedMark(page)).toBeVisible({ timeout: 90_000 });
  const first = await cacheFacts(page), before = await stats(page), doc = await liveDoc(page), vid = doc.items.find((i: any) => i.id === 'vid');
  // Slow the clip to half speed: the end keyframe now reads 500 source ms instead of 1000, so about half the frames are needed.
  const end = vid.timeRemap.keyframes.find((k: any) => k.time === 1000);
  const r = await runtimeHandle(page, { type: 'editKeyframe', target: { itemId: 'vid', key: 'timeRemap', keyframeId: end.id }, patch: { value: 500 } }); expect(r.ok).toBe(true);
  await expect.poll(async () => (await stats(page)).started, { timeout: 30_000 }).toBe(before.started + 1);
  await expect(cachedMark(page, (await cacheFacts(page)).expected)).toBeVisible({ timeout: 90_000 });
  const second = await cacheFacts(page);
  expect(second.expected).toBeLessThan(first.expected); expect(second.frames).toBe(second.expected); expect(second.allBlobs).toBe(true);
  expect((await stats(page)).aborted, 'a finished build is not counted as aborted').toBe(before.aborted);
});

test('a curve change during a build aborts it: aborted and started both increment, and the final cache matches the final curve', async ({ page }) => {
  await openWithSource(page, realVideo(), 'h264-aac.mp4'); await speedSection(page); const before = await stats(page); // expands the section so the result is visible
  // One page task: switch on, wait until the build has started (no sleeps: a frame-by-frame wait on the module's own counter), then change the curve while it runs.
  const out = await page.evaluate(async ({ m, start }) => {
    const rt = '/src/timeline/runtime.ts', ed = '/src/editor.tsx', { activeRuntime } = await import(rt), { activeSession } = await import(ed), mod = await import(m);
    const on = activeRuntime.handle({ type: 'toggleTimeRemap', itemId: 'vid', on: true });
    while (mod.remapCacheStats.started === start) await new Promise(r => requestAnimationFrame(r));
    const end = activeSession.document.items.find((i: any) => i.id === 'vid').timeRemap.keyframes.find((k: any) => k.time === 1000);
    const edit = activeRuntime.handle({ type: 'editKeyframe', target: { itemId: 'vid', key: 'timeRemap', keyframeId: end.id }, patch: { value: 500 } });
    return { on: on.ok, edit: edit.ok, stats: { ...mod.remapCacheStats } };
  }, { m: MODULE, start: before.started });
  expect(out.on && out.edit).toBe(true); expect(out.stats.started).toBeGreaterThanOrEqual(before.started + 1);
  await expect(cachedMark(page)).toBeVisible({ timeout: 90_000 });
  const facts = await cacheFacts(page), s = await stats(page);
  expect(facts.frames).toBe(facts.expected); expect(await cachedMark(page).getAttribute('aria-label')).toBe(`Frames cached: ${facts.expected}`);
  expect(s.started - before.started, 'second build for the changed curve').toBe(2); expect(s.aborted - before.aborted, 'the first build was aborted').toBe(1);
});

test('Time Remap off drops the cache: no progress, no check mark, remapFrames is null', async ({ page }) => {
  await openWithSource(page, realVideo(), 'h264-aac.mp4'); const sw = await remapSwitch(page); await sw.click(); await expect(cachedMark(page)).toBeVisible({ timeout: 90_000 });
  await sw.click(); await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(cachedMark(page)).toHaveCount(0); await expect(panel(page).getByRole('progressbar')).toHaveCount(0);
  expect((await cacheFacts(page)).frames).toBeNull();
});

test('an unreadable source shows role=alert "Frames could not be cached: …" and no check mark', async ({ page }) => {
  await openWithSource(page, Buffer.alloc(4096, 7), 'corrupt.mp4'); await (await remapSwitch(page)).click();
  const alert = panel(page).getByRole('alert').filter({ hasText: /^Frames could not be cached:/ }); await expect(alert).toBeVisible({ timeout: 60_000 });
  expect((await alert.textContent())!.length, 'the reason follows the prefix').toBeGreaterThan('Frames could not be cached:'.length + 1);
  await expect(cachedMark(page)).toHaveCount(0); await expect(panel(page).getByRole('progressbar')).toHaveCount(0); expect((await cacheFacts(page)).frames).toBeNull();
});

test('a clip with no stored source shows the same alert (provisional wording after the colon)', async ({ page }) => {
  const id = await createProject(page, clipDoc(), 'No source'); await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); await pick(page, 'vid');
  await (await remapSwitch(page)).click(); await expect(panel(page).getByRole('alert').filter({ hasText: /^Frames could not be cached:/ })).toBeVisible({ timeout: 30_000 });
});

test('a video without Time Remap, and other item types, never build a cache', async ({ page }) => {
  await openWithSource(page, realVideo(), 'h264-aac.mp4'); const before = await stats(page);
  await pick(page, 'img'); await pick(page, 'vid');
  await expect(panel(page).getByRole('progressbar')).toHaveCount(0); expect(await stats(page)).toEqual(before); expect((await cacheFacts(page)).frames).toBeNull();
});
