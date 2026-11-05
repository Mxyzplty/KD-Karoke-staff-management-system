// SPDX-License-Identifier: AGPL-3.0-only
// T02 owned acceptance D1–D11 in real Chromium. Edits belong to T03: each control must dispatch its typed intent, show the
// "… is not yet implemented" notice and leave the stored document byte-identical, except the intents T03 owns (items, tracks, undo/redo, settings),
// which now edit the document. View rules (zoom, snap, rows) are asserted
// against our written tables; "ground truth" in a test name means the oracle is our table, not a Xapp capture (G-15 was never stored).
import { test, expect, type Page } from '@playwright/test';
import { TINY_PNG, addAsset, blurAll, clearIntents, clip, createProject, expectUntouched, groupedDoc, guard, intents, notices, openEditor, richDoc, setViewState, skipTour, snapDoc, stored, typesDoc, viewState, watchIntents } from './t02-support';
import { itemById, journalRows, liveDoc, savedDoc, spanOf, undoEntries } from './t03-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Timeline' });
const header = (page: Page, name: string) => page.locator('.track-row').filter({ has: page.locator('.track-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.track-header');
const trackRow = (page: Page, trackId: string) => page.locator('.track-row').filter({ has: page.locator(`[data-track-id="${trackId}"]`) });
const lastIntent = async (page: Page) => (await intents(page)).at(-1)!;
const geometry = (page: Page) => viewState(page, v => ({ zoom: v.zoom as number, scroll: v.scroll as number, laneWidth: v.laneWidth as number }));
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, hold?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + dx / 2, from.y, { steps: 8 }); await page.mouse.move(from.x + dx, from.y, { steps: 8 });
  if (hold) await hold();
  await page.mouse.up();
}
const centre = async (locator: ReturnType<Page['locator']>) => { const b = (await locator.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const norev = (d: any) => ({ ...d, rev: 0 }); // the whole document minus its revision counter

test('D1 toolbar: labels in order, defaults and enabled states', async ({ page }) => {
  await openEditor(page, richDoc()); const bar = toolbar(page);
  expect(await bar.getByRole('button').evaluateAll(b => b.map(x => x.getAttribute('aria-label')))).toEqual(['Delete', 'Split', 'Clone', 'Slip', 'Ripple', 'Undo', 'Redo', 'Play', 'Snapping', 'Markers', 'Waveform lanes', 'Zoom out', 'Zoom in', 'Zoom to fit']);
  for (const name of ['Delete', 'Split', 'Clone', 'Undo', 'Redo']) await expect(bar.getByRole('button', { name, exact: true }), name).toBeDisabled();
  for (const name of ['Slip', 'Ripple', 'Play', 'Zoom out', 'Zoom in', 'Zoom to fit']) await expect(bar.getByRole('button', { name, exact: true }), name).toBeEnabled();
  for (const [name, pressed] of [['Slip', 'false'], ['Ripple', 'false'], ['Snapping', 'true'], ['Markers', 'true'], ['Waveform lanes', 'true']]) await expect(bar.getByRole('button', { name, exact: true }), name).toHaveAttribute('aria-pressed', pressed);
  await expect(bar.getByLabel('Timecode')).toHaveText('00:00.00 | 00:20.00');
  await clip(page, 'clipA').click(); for (const name of ['Delete', 'Split', 'Clone']) await expect(bar.getByRole('button', { name, exact: true }), name).toBeEnabled();
  await expect(bar.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('D1 Ripple relabels Delete; Slip and Ripple toggle back to select and write nothing (not undoable, no intent, no save)', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id), bar = toolbar(page);
  await clip(page, 'clipA').click(); await bar.getByRole('button', { name: 'Ripple', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Ripple', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(bar.getByRole('button', { name: 'Ripple Delete', exact: true })).toBeVisible(); await expect(bar.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  expect(await viewState(page, v => v.toolMode)).toBe('ripple');
  await bar.getByRole('button', { name: 'Slip', exact: true }).click(); expect(await viewState(page, v => v.toolMode)).toBe('slip'); await expect(bar.getByRole('button', { name: 'Ripple', exact: true })).toHaveAttribute('aria-pressed', 'false'); await expect(bar.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await bar.getByRole('button', { name: 'Slip', exact: true }).click(); expect(await viewState(page, v => v.toolMode)).toBe('select');
  await bar.getByRole('button', { name: 'Ripple', exact: true }).click(); await bar.getByRole('button', { name: 'Ripple Delete', exact: true }).click();
  await bar.getByRole('button', { name: 'Ripple', exact: true }).click(); expect(await viewState(page, v => v.toolMode)).toBe('select');
  const log = await intents(page); expect(log).toHaveLength(1); expect(log[0].intent).toEqual({ type: 'deleteItems', itemIds: ['clipA'], ripple: true }); // T03 (was: NOT_IMPLEMENTED notice, document untouched): ripple delete closes the gap on v1 and is one "Ripple delete" step.
  expect(log[0].outcome).toEqual({ ok: true }); const doc = await liveDoc(page);
  expect(doc.items.map((i: any) => i.id)).toEqual(['clipB', 'clipC', 'title', 'photo']); expect(spanOf(doc, 'clipB')).toEqual([0, 8000]); expect(spanOf(doc, 'clipC')).toEqual([2000, 6000]); expect(doc.duration).toBe(8000);
  expect(await undoEntries(page)).toEqual([{ label: 'Ripple delete', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(saved.items.map((i: any) => i.id)).toEqual(['clipB', 'clipC', 'title', 'photo']); expect(spanOf(saved, 'clipB')).toEqual([0, 8000]); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D1 Split, Clone and Delete act on all selected items (one intent each) at the playhead; Play plays (T15)', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id), bar = toolbar(page);
  await clip(page, 'clipA').click(); await clip(page, 'clipC').click({ modifiers: ['Control'] }); await clip(page, 'title').click({ modifiers: ['Shift'] });
  expect(await viewState(page, v => v.selection)).toEqual(['clipA', 'clipC', 'title']); await setViewState(page, { playheadMs: 2500 });
  await clip(page, 'title').click({ modifiers: ['Control'] }); expect(await viewState(page, v => v.selection)).toEqual(['clipA', 'clipC']); // Ctrl-click toggles one out …
  await clip(page, 'title').click({ modifiers: ['Control'] }); expect(await viewState(page, v => v.selection)).toEqual(['clipA', 'clipC', 'title']); // … and back in
  // T03 (was: NOT_IMPLEMENTED notices, document untouched): each button is one step with the real effect on all three selected items.
  const count = async () => (await liveDoc(page)).items.length, labels = async () => (await undoEntries(page)).map(e => e.label);
  expect(await count()).toBe(5);
  await bar.getByRole('button', { name: 'Split', exact: true }).click(); let doc = await liveDoc(page); expect(doc.items).toHaveLength(8); // all three cross 2.5 s
  expect(spanOf(doc, 'clipA')).toEqual([0, 2500]); expect(spanOf(doc, 'clipC')).toEqual([2000, 2500]); expect(spanOf(doc, 'title')).toEqual([1000, 2500]); expect(await undoEntries(page)).toEqual([{ label: 'Split items', source: 'user' }]);
  await bar.getByRole('button', { name: 'Clone', exact: true }).click(); expect(await count()).toBe(11); expect(await labels()).toEqual(['Split items', 'Duplicate items']);
  await bar.getByRole('button', { name: 'Delete', exact: true }).click(); doc = await liveDoc(page); expect(doc.items).toHaveLength(8); expect(await labels()).toEqual(['Split items', 'Duplicate items', 'Delete items']);
  for (const gone of ['clipA', 'clipC', 'title']) expect(itemById(doc, gone), gone).toBeUndefined(); // only the three selected ids go; their right halves and the copies stay
  await bar.getByRole('button', { name: 'Play', exact: true }).click();
  const log = await intents(page); expect(log.map(l => l.intent)).toEqual([{ type: 'splitItems', itemIds: ['clipA', 'clipC', 'title'], atMs: 2500 }, { type: 'duplicateItems', itemIds: ['clipA', 'clipC', 'title'] }, { type: 'deleteItems', itemIds: ['clipA', 'clipC', 'title'], ripple: false }, { type: 'togglePlayback' }]);
  expect(log.slice(0, 3).map(l => l.outcome)).toEqual([{ ok: true }, { ok: true }, { ok: true }]); expect(log[3].outcome).toEqual({ ok: true }); // T15 (was: NOT_IMPLEMENTED, owner T15)
  await expect(bar.getByRole('button', { name: 'Pause', exact: true })).toBeVisible(); // T15 (was: notice "Playback is not yet implemented (T15).")
  const saved = await savedDoc(page, id); expect(saved.items).toHaveLength(8); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D1 snapping, markers and waveform toggles default on, persist per browser across reload', async ({ page }) => {
  await openEditor(page, richDoc()); const bar = toolbar(page);
  expect(await page.evaluate(() => localStorage.getItem('cutframe:timeline-ui'))).toBeNull();
  await bar.getByRole('button', { name: 'Snapping', exact: true }).click(); await bar.getByRole('button', { name: 'Markers', exact: true }).click(); await bar.getByRole('button', { name: 'Waveform lanes', exact: true }).click();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('cutframe:timeline-ui')))!)).toEqual({ snapping: false, markersVisible: false, waveforms: false });
  await expect(page.locator('.marker-lane')).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  for (const name of ['Snapping', 'Markers', 'Waveform lanes']) await expect(toolbar(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
  await toolbar(page).getByRole('button', { name: 'Markers', exact: true }).click(); await expect(page.locator('.marker-lane')).toHaveCount(1);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('cutframe:timeline-ui')))!)).toEqual({ snapping: false, markersVisible: true, waveforms: false });
});

test('D2 ground truth: zoom default 0.05 px/ms, ×1.25 / ÷1.25 steps, max 1, fit = (lane − 32) ÷ (duration + 2 s) is also the minimum, fit resets the scroll', async ({ page }) => {
  await openEditor(page, richDoc()); const bar = toolbar(page); let g = await geometry(page);
  const fit = (g.laneWidth - 32) / 22000; expect(fit).toBeLessThan(0.05); expect(g.zoom).toBe(0.05); // default, the fit is below it
  await bar.getByRole('button', { name: 'Zoom in', exact: true }).click(); expect((await geometry(page)).zoom).toBeCloseTo(0.0625, 12);
  await bar.getByRole('button', { name: 'Zoom out', exact: true }).click(); await bar.getByRole('button', { name: 'Zoom out', exact: true }).click(); expect((await geometry(page)).zoom).toBeCloseTo(0.05 / 1.25, 12);
  for (let n = 0; n < 30; n++) await bar.getByRole('button', { name: 'Zoom out', exact: true }).click();
  g = await geometry(page); expect(g.zoom).toBeCloseTo(fit, 12); expect(g.zoom).toBeGreaterThanOrEqual(fit - 1e-12);
  for (let n = 0; n < 40; n++) await bar.getByRole('button', { name: 'Zoom in', exact: true }).click(); expect((await geometry(page)).zoom).toBe(1);
  await setViewState(page, { scroll: 500 }); await bar.getByRole('button', { name: 'Zoom to fit', exact: true }).click(); g = await geometry(page);
  expect(g.zoom).toBeCloseTo(fit, 12); expect(g.scroll).toBe(0); await expect.poll(() => page.locator('.timeline-scroll').evaluate(el => el.scrollLeft)).toBe(0);
  // Content width = (duration + 2 s) × zoom (the lanes are never narrower than the viewport).
  await bar.getByRole('button', { name: 'Zoom in', exact: true }).click(); await bar.getByRole('button', { name: 'Zoom in', exact: true }).click(); g = await geometry(page);
  const width = await page.locator('.ruler-lanes').evaluate(el => el.getBoundingClientRect().width); expect(width).toBeCloseTo(22000 * g.zoom, 1);
});

test('D2 zoom keeps the playhead where it is on screen, or centres it when it was off screen', async ({ page }) => {
  await openEditor(page, richDoc({ duration: 60000 })); const bar = toolbar(page);
  await setViewState(page, { zoom: 0.2, scroll: 0, playheadMs: 1000 }); await page.waitForTimeout(100);
  await bar.getByRole('button', { name: 'Zoom in', exact: true }).click(); let g = await geometry(page); expect(g.zoom).toBeCloseTo(0.25, 12); expect(1000 * g.zoom - g.scroll).toBeCloseTo(200, 6);
  await setViewState(page, { zoom: 0.2, scroll: 0, playheadMs: 30000 }); await bar.getByRole('button', { name: 'Zoom in', exact: true }).click(); g = await geometry(page);
  expect(30000 * g.zoom - g.scroll).toBeCloseTo(g.laneWidth / 2, 6);
});

test('D2 ground truth W3-RT-11 through the UI: after zoom ×1.25³ a shortening edit keeps the zoom, shortens the content by 5 s × zoom and clamps the scroll; a much shorter timeline raises the zoom to the new fit', async ({ page }) => {
  const doc = richDoc({ duration: 45000, tracks: [{ id: 'v1', name: 'V1', kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1 }], layerOrder: [{ type: 'track', id: 'v1' }], items: [{ id: 'long', type: 'video', trackId: 'v1', display: { from: 0, to: 45000 }, trim: { from: 0, to: 45000 }, sourceDuration: 45000, details: { name: 'Long' } }], markers: [] });
  await openEditor(page, doc); const bar = toolbar(page); await bar.getByRole('button', { name: 'Zoom to fit', exact: true }).click();
  let g = await geometry(page); const fit = (g.laneWidth - 32) / 47000; expect(g.zoom).toBeCloseTo(fit, 12);
  for (let n = 0; n < 3; n++) await bar.getByRole('button', { name: 'Zoom in', exact: true }).click();
  g = await geometry(page); expect(g.zoom / fit).toBeCloseTo(1.25 ** 3, 9); const lanes = page.locator('.ruler-lanes'), widthOf = async () => (await lanes.evaluate(el => el.getBoundingClientRect().width));
  const before = await widthOf(); expect(before).toBeCloseTo(47000 * g.zoom, 1);
  await page.locator('.timeline-scroll').evaluate(el => { el.scrollLeft = 1e7; }); await expect.poll(async () => (await geometry(page)).scroll).toBeGreaterThan(0);
  const scrolled = (await geometry(page)).scroll; expect(scrolled).toBeCloseTo(47000 * g.zoom - g.laneWidth, 0);
  // The edit (test harness: the session shortens the project by 5 s, as a T03 trim would).
  await page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); activeSession.update({ ...activeSession.document, duration: 40000 }); });
  await expect.poll(async () => Math.round(await widthOf())).toBe(Math.round(42000 * g.zoom));
  const after = await geometry(page); expect(Math.abs(after.zoom - g.zoom)).toBeLessThan(1e-9); // unchanged (±0.01 px/s in the written rule)
  expect(before - (await widthOf())).toBeCloseTo(5000 * g.zoom, 0); expect(after.scroll).toBeCloseTo(42000 * g.zoom - g.laneWidth, 0); expect(after.scroll).toBeLessThan(scrolled);
  await expect.poll(() => page.locator('.timeline-scroll').evaluate(el => el.scrollLeft)).toBeCloseTo(after.scroll, 0);
  await page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); activeSession.update({ ...activeSession.document, duration: 3000 }); });
  await expect.poll(async () => (await geometry(page)).zoom).toBeCloseTo((g.laneWidth - 32) / 5000, 9);
});

test('D3 ground truth: ruler ladder (first interval at least 72 px) and labels; a ruler press seeks to the frame; the ruler menu adds a marker (T03)', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  await setViewState(page, { zoom: 0.05, scroll: 0 }); await expect(page.locator('.tick').nth(1)).toHaveText('0:02');
  expect((await page.locator('.tick').allTextContents()).slice(0, 4)).toEqual(['0:00', '0:02', '0:04', '0:06']);
  await setViewState(page, { zoom: 0.2 }); await expect(page.locator('.tick').nth(1)).toHaveText('0:00.5'); expect((await page.locator('.tick').allTextContents()).slice(0, 4)).toEqual(['0:00.0', '0:00.5', '0:01.0', '0:01.5']);
  await setViewState(page, { zoom: 0.0721 }); expect((await page.locator('.tick').allTextContents()).slice(0, 3)).toEqual(['0:00', '0:01', '0:02']); // 1000 ms × 0.0721 = 72.1 px
  await setViewState(page, { zoom: 0.05 });
  const ruler = page.locator('.ruler'), box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + 123, box.y + 10); const expected = Math.round(123 / 0.05 * 30 / 1000) * 1000 / 30; // 2,460 ms → frame 74
  expect(await viewState(page, v => v.playheadMs)).toBeCloseTo(expected, 6); await expect(toolbar(page).getByLabel('Timecode')).toHaveText('00:02.46 | 00:20.00');
  await page.mouse.move(box.x + 50, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 10, { steps: 6 }); await page.mouse.up(); expect(await viewState(page, v => v.playheadMs)).toBeCloseTo(Math.round(300 / 0.05 * 30 / 1000) * 1000 / 30, 6);
  await page.mouse.click(box.x + 80, box.y + 10, { button: 'right' }); const menu = page.getByRole('menu', { name: 'Ruler' }); await expect(menu.getByRole('menuitem')).toHaveText(['Add Marker (M)']);
  await menu.getByRole('menuitem').click(); const l = await lastIntent(page); expect(l.intent).toMatchObject({ type: 'addMarker' }); expect(l.intent.timeMs).toBeCloseTo(Math.round(80 / 0.05 * 30 / 1000) * 1000 / 30, 6);
  // T03 (was: NOT_IMPLEMENTED notice, document untouched): the marker is added at the frame-aligned time as one "Add marker" step.
  expect(l.outcome).toEqual({ ok: true }); const doc = await liveDoc(page); expect(doc.markers).toHaveLength(3); const added = doc.markers.find((m: any) => !['m1', 'm2'].includes(m.id));
  expect(added.timeMs).toBeCloseTo(l.intent.timeMs, 6); expect(await undoEntries(page)).toEqual([{ label: 'Add marker', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(saved.markers).toHaveLength(3); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D4 ground truth: track heights 56 (media) / 48 (caption, overlay) / stored height; 36 px "Audio" sub-lane for a video with sound while the toggle is on', async ({ page }) => {
  const doc = richDoc(); doc.tracks = doc.tracks.map(t => t.id === 'v2' ? { ...t, height: 90 } : t);
  doc.tracks.push({ id: 'c1', name: 'C1', kind: 'caption', muted: false, solo: false, locked: false, hidden: false, volume: 1 }); doc.layerOrder.push({ type: 'track', id: 'c1' });
  const id = await createProject(page, doc, 'Heights'); const asset = await addAsset(page, id, 'speech.png', { sound: true });
  await page.evaluate(async ({ id, asset }) => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); const { document } = await projectStore.read(id); document.items = document.items.map((i: any) => i.id === 'clipB' ? { ...i, metadata: { assetId: asset } } : i); await projectStore.save(id, document, document.rev); }, { id, asset });
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  const heightOf = async (trackId: string) => Math.round((await trackRow(page, trackId).boundingBox())!.height);
  expect(await heightOf('v2')).toBe(90); expect(await heightOf('o1')).toBe(48); expect(await heightOf('c1')).toBe(48); expect(await heightOf('a1')).toBe(56);
  expect(await heightOf('v1')).toBe(56 + 36); // clipB has sound: Audio sub-lane
  const sub = trackRow(page, 'v1').locator('.waveform-clip'); await expect(sub).toHaveCount(1); await expect(sub).toHaveText('Audio'); await expect(trackRow(page, 'v2').locator('.waveform-clip')).toHaveCount(0);
  const subBox = (await sub.boundingBox())!, clipBox = (await clip(page, 'clipB').boundingBox())!; expect(subBox.x).toBeCloseTo(clipBox.x, 0); expect(subBox.width).toBeCloseTo(clipBox.width, 0);
  expect(Math.round((await trackRow(page, 'v1').locator('.waveform-lane').boundingBox())!.height)).toBe(36);
  await watchIntents(page); await sub.click({ button: 'right' }); await expect(page.getByRole('menu', { name: 'Clip actions' })).toBeVisible(); expect(await viewState(page, v => v.selection)).toEqual(['clipB']); await page.keyboard.press('Escape');
  await toolbar(page).getByRole('button', { name: 'Waveform lanes', exact: true }).click(); await expect(sub).toHaveCount(0); expect(await heightOf('v1')).toBe(56);
});

test('D5 ground truth: stored bottom-first layer order is shown top-first, with item counts and clip positions at the zoom', async ({ page }) => {
  await openEditor(page, richDoc()); await setViewState(page, { zoom: 0.05, scroll: 0 });
  await expect(page.locator('.track-name')).toHaveText(['O3', 'O2', 'O1', 'V2', 'V1', 'A1']); await expect(page.locator('.track-header .item-count')).toHaveText(['0', '1', '1', '1', '2', '0']);
  const origin = (await page.locator('.ruler-lanes').boundingBox())!.x;
  for (const [id, from, to] of [['clipA', 0, 8000], ['clipB', 8000, 16000], ['clipC', 2000, 6000], ['title', 1000, 5000]] as const) {
    const b = (await clip(page, id).boundingBox())!; expect(b.x - origin, `${id} left`).toBeCloseTo(from * 0.05, 0); expect(b.width, `${id} width`).toBeCloseTo((to - from) * 0.05, 0);
  }
  await expect(page.getByRole('option', { name: /^Marker at/ })).toHaveCount(2); await expect(page.getByRole('option', { name: 'Marker at 00:03.00' })).toBeVisible(); await expect(page.getByRole('option', { name: 'Marker at 00:09.00: Beat' })).toBeVisible();
  const pin = (await page.getByRole('option', { name: 'Marker at 00:03.00' }).boundingBox())!; expect(Math.abs(pin.x + pin.width / 2 - origin - 3000 * 0.05)).toBeLessThan(1);
  await expect(clip(page, 'clipA')).toHaveAccessibleName('Clip A, video, 00:00.00 to 00:08.00');
});

test('D5 ground truth: clip colours by type (video/audio/image/text blue, shape rose, motion graphic cyan, layout amber, caption teal)', async ({ page }) => {
  await openEditor(page, typesDoc());
  for (const [id, colour] of [['video', 'blue'], ['audio', 'blue'], ['image', 'blue'], ['text', 'blue'], ['shape', 'rose'], ['motionGraphic', 'cyan'], ['layout', 'amber'], ['caption', 'teal']]) await expect(clip(page, `i-${id}`), id).toHaveClass(new RegExp(`\\bclip-${colour}\\b`));
});

test('D5 a group row sits above its members (item count = member tracks); collapse hides them and expand restores them', async ({ page }) => {
  const id = await openEditor(page, groupedDoc()); await watchIntents(page); const before = await stored(page, id);
  await expect(page.locator('.track-name')).toHaveText(['O1', 'Group 1', 'V2', 'V1', 'A1']);
  const rows = page.locator('.track-row'); await expect(rows.nth(1)).toHaveClass(/group-row/); await expect(rows.nth(1).locator('.item-count')).toHaveText('2');
  const pad = async (name: string) => (await header(page, name).evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))); expect(await pad('V2')).toBeGreaterThan(await pad('Group 1'));
  const collapse = page.getByRole('button', { name: 'Collapse Group 1' }); await expect(collapse).toHaveAttribute('aria-expanded', 'true'); await collapse.click();
  await expect(page.locator('.track-name')).toHaveText(['O1', 'Group 1', 'A1']); await expect(page.getByRole('button', { name: 'Expand Group 1' })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Expand Group 1' }).click(); await expect(page.locator('.track-name')).toHaveText(['O1', 'Group 1', 'V2', 'V1', 'A1']);
  expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before); // collapse is view state
});

test('D6 trim handles are 8 px wide, hidden under 16 px; red halo at the source limit, green otherwise (ground truth: findings §15)', async ({ page }) => {
  const doc = richDoc(); doc.items.push({ id: 'narrow', type: 'video', trackId: 'o3', display: { from: 0, to: 300 }, trim: { from: 0, to: 300 }, sourceDuration: 1000, details: { name: 'Narrow' } }, { id: 'wide', type: 'video', trackId: 'o3', display: { from: 1000, to: 1400 }, trim: { from: 0, to: 400 }, sourceDuration: 1000, details: { name: 'Wide' } });
  await openEditor(page, doc); await setViewState(page, { zoom: 0.05, scroll: 0 });
  const halo = async (id: string) => clip(page, id).locator('.trim-handle').evaluateAll(h => h.map(x => `${x.classList.contains('trim-start') ? 'start' : 'end'}:${x.getAttribute('data-halo')}`));
  expect(await halo('clipA')).toEqual(['start:red', 'end:green']); expect(await halo('clipB')).toEqual(['start:green', 'end:red']); expect(await halo('clipC')).toEqual(['start:green', 'end:green']);
  expect(await halo('title')).toEqual(['start:green', 'end:green']); expect(await halo('photo')).toEqual(['start:green', 'end:green']);
  await expect(clip(page, 'narrow').locator('.trim-handle')).toHaveCount(0); await expect(clip(page, 'wide').locator('.trim-handle')).toHaveCount(2); // 15 px vs 20 px
  expect((await clip(page, 'clipC').locator('.trim-handle').first().boundingBox())!.width).toBeCloseTo(8, 0);
});

test('D6 a trim drag trims on release with the edge, the delta and ripple (T03); under 3 px is a click', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id); await toolbar(page).getByRole('button', { name: 'Snapping', exact: true }).click(); await setViewState(page, { zoom: 0.05, scroll: 0 });
  const handle = clip(page, 'clipC').locator('.trim-start'), start = await centre(handle);
  await dragBy(page, start, 50, async () => { const b = (await clip(page, 'clipC').boundingBox())!; expect(b.width).toBeCloseTo(4000 * 0.05 - 50, 0); }); // visual feedback while dragging
  let l = await lastIntent(page); expect(l.intent).toEqual({ type: 'trimItem', itemId: 'clipC', edge: 'start', deltaMs: 1000, ripple: false });
  // T03 (was: NOT_IMPLEMENTED notice, the clip back at its stored length): the start edge moves 1 s, trim.from follows, one "Edit items" step.
  expect(l.outcome).toEqual({ ok: true }); let doc = await liveDoc(page); expect(spanOf(doc, 'clipC')).toEqual([3000, 6000]); expect(itemById(doc, 'clipC').trim).toEqual({ from: 2000, to: 5000 });
  expect(await undoEntries(page)).toEqual([{ label: 'Edit items', source: 'user' }]); await expect(clip(page, 'clipC')).toHaveCSS('width', '150px');
  await toolbar(page).getByRole('button', { name: 'Ripple', exact: true }).click(); await dragBy(page, await centre(clip(page, 'clipC').locator('.trim-end')), -40);
  l = await lastIntent(page); expect(l.intent).toEqual({ type: 'trimItem', itemId: 'clipC', edge: 'end', deltaMs: -800, ripple: true });
  expect(l.outcome).toEqual({ ok: true }); doc = await liveDoc(page); expect(spanOf(doc, 'clipC')).toEqual([3000, 5200]); expect(itemById(doc, 'clipC').trim).toEqual({ from: 2000, to: 4200 }); // ripple trim: nothing follows clipC on v2
  expect(await undoEntries(page)).toEqual([{ label: 'Edit items', source: 'user' }, { label: 'Ripple trim', source: 'user' }]);
  await clearIntents(page); await dragBy(page, await centre(clip(page, 'clipC').locator('.trim-end')), 2); expect(await intents(page)).toEqual([]); // under 3 px is a click, not a drag
  expect(await undoEntries(page)).toHaveLength(2); const saved = await savedDoc(page, id); expect(spanOf(saved, 'clipC')).toEqual([3000, 5200]); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D7 snapping drag: the move intent carries the snapped delta, the highlight line shows the target (start match, end match, none, off)', async ({ page }) => {
  const doc = snapDoc(); doc.items = [doc.items[0], { ...doc.items[1], display: { from: 5330, to: 6660 }, trim: { from: 0, to: 1330 }, sourceDuration: 1330 }]; doc.markers = [{ id: 'm', timeMs: 7730 }];
  const id = await openEditor(page, doc); await watchIntents(page); const before = await stored(page, id); await setViewState(page, { zoom: 0.1, scroll: 0, playheadMs: 0 });
  const run = async (dx: number, expectLine: number | null) => {
    await clearIntents(page); const start = await centre(clip(page, 'dragMe'));
    await dragBy(page, start, dx, async () => { if (expectLine === null) await expect(page.locator('.snap-line')).toHaveCount(0); else { await expect(page.locator('.snap-line')).toHaveAttribute('data-snap-ms', String(expectLine)); } });
    await expect(page.locator('.snap-line')).toHaveCount(0); const l = await lastIntent(page); expect(l.intent.type).toBe('moveItems'); expect(l.intent).toMatchObject({ itemIds: ['dragMe'], trackId: null, newTrack: false, ripple: false });
    // T03 rule-6 oracle fix: the drag now edits the document (one "Move item" step); undo it so the next drag starts from the same document.
    expect(await undoEntries(page)).toHaveLength(1); await page.keyboard.press('Control+Z'); expect(await undoEntries(page)).toHaveLength(0); expect(norev(await liveDoc(page))).toEqual(norev(JSON.parse(before.json)));
    return l.intent.deltaMs as number;
  };
  // zoom 0.1 → snap distance 8 ÷ √2 ÷ 0.1 = 56.6 ms. Start match on the marker: raw start 7,700 → 7,730 (delta 6,730 − 1,000).
  expect(await run(670, 7730)).toBeCloseTo(6730, 6);
  // Start match on another item's start edge (5,330): raw start 5,300.
  expect(await run(430, 5330)).toBeCloseTo(4330, 6);
  // End match: the span end (raw 7,710) is 20 ms from the marker → start = 7,730 − 2,000.
  expect(await run(471, 7730)).toBeCloseTo(4730, 6);
  // Playhead target.
  await setViewState(page, { playheadMs: 2650 }); expect(await run(164, 2650)).toBeCloseTo(1650, 6); await setViewState(page, { playheadMs: 0 });
  // No target within reach: the raw delta (250 px ÷ 0.1 = 2,500 ms), no highlight.
  expect(await run(250, null)).toBeCloseTo(2500, 6);
  // Snapping off: the raw delta even beside a target.
  await toolbar(page).getByRole('button', { name: 'Snapping', exact: true }).click(); expect(await run(670, null)).toBeCloseTo(6700, 6);
  await expectUntouched(page, id, before);
});

test('D7 items on hidden tracks are not snap targets', async ({ page }) => {
  const doc = snapDoc(true); doc.items = [doc.items[0], { ...doc.items[1], display: { from: 5330, to: 6660 }, trim: { from: 0, to: 1330 }, sourceDuration: 1330 }]; doc.markers = [];
  await openEditor(page, doc); await watchIntents(page); await setViewState(page, { zoom: 0.1, scroll: 0, playheadMs: 0 });
  await dragBy(page, await centre(clip(page, 'dragMe')), 430, async () => { await expect(page.locator('.snap-line')).toHaveCount(0); });
  expect((await lastIntent(page)).intent.deltaMs).toBeCloseTo(4300, 6); // raw: the hidden V1's 5,330 edge did not attract the start
});

test('R6 group and member visibility determine whether a member edge is a snap target', async ({ page }) => {
  for (const [groupHidden, memberHidden, visible] of [[false, false, true], [true, false, false], [false, true, false], [true, true, false]] as const) {
    const doc: any = snapDoc(); doc.markers = []; doc.items[1].display = { from: 5330, to: 6660 }; doc.tracks[0].hidden = memberHidden;
    doc.groups = { g: { name: 'Group', hidden: groupHidden, children: [{ type: 'track', id: 'v1' }] } }; doc.layerOrder = [{ type: 'group', id: 'g' }, { type: 'track', id: 'v2' }];
    const id = await openEditor(page, doc); await watchIntents(page); const before = await stored(page, id); await setViewState(page, { zoom: 0.1, scroll: 0, playheadMs: 0 });
    await dragBy(page, await centre(clip(page, 'dragMe')), 430, async () => { if (visible) await expect(page.locator('.snap-line')).toHaveAttribute('data-snap-ms', '5330'); else await expect(page.locator('.snap-line')).toHaveCount(0); });
    expect((await lastIntent(page)).intent.deltaMs).toBeCloseTo(visible ? 4330 : 4300, 6);
    // T03 rule-6 oracle fix: the drag now edits the document (one "Move item" step); undo it, then the document is the stored one again.
    expect(await undoEntries(page)).toHaveLength(1); await page.keyboard.press('Control+Z'); expect(await undoEntries(page)).toHaveLength(0); expect(norev(await liveDoc(page))).toEqual(norev(JSON.parse(before.json))); await expectUntouched(page, id, before);
  }
});

test('D7 a move released over an occupied lane is refused (COLLISION), below the tracks it moves to a new track (T03: "Move to new track")', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id); await toolbar(page).getByRole('button', { name: 'Snapping', exact: true }).click();
  const from = await centre(clip(page, 'clipC')), target = await centre(page.locator('.lane[data-track-id="v1"]')), box = (await page.locator('.lane[data-track-id="v1"]').boundingBox())!;
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + 20, from.y + 10, { steps: 4 }); await page.mouse.move(from.x + 20, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  expect((await lastIntent(page)).intent).toMatchObject({ type: 'moveItems', itemIds: ['clipC'], trackId: 'v1', newTrack: false }); expect(target).toBeTruthy();
  // T03: v1 is occupied by clipA (0–8 s) at the drop point, so the real outcome is a refusal and nothing changes (the successful lane move is covered in t03-lane-move.spec.ts).
  expect((await lastIntent(page)).outcome).toMatchObject({ ok: false, code: 'COLLISION' }); let doc = await liveDoc(page); expect(itemById(doc, 'clipC')).toMatchObject({ trackId: 'v2' }); expect(await undoEntries(page)).toEqual([]);
  const below = page.locator('.drop-below'); await below.scrollIntoViewIfNeeded(); const b = (await below.boundingBox())!, c2 = await centre(clip(page, 'clipC'));
  await page.mouse.move(c2.x, c2.y); await page.mouse.down(); await page.mouse.move(c2.x + 10, c2.y + 5, { steps: 3 }); await page.mouse.move(c2.x + 10, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
  expect((await lastIntent(page)).intent).toMatchObject({ type: 'moveItems', newTrack: true });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); doc = await liveDoc(page); const moved = itemById(doc, 'clipC'); expect(doc.tracks).toHaveLength(7); expect(['v1', 'v2']).not.toContain(moved.trackId); expect(doc.tracks.find((t: any) => t.id === moved.trackId)).toMatchObject({ kind: 'video' });
  expect(spanOf(doc, 'clipC')).toEqual([2200, 6200]); expect(await undoEntries(page)).toEqual([{ label: 'Move to new track', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(spanOf(saved, 'clipC')).toEqual([2200, 6200]); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D8 clip menu: entries, enable rules, selection on right-click; Copy is view state, the rest edit the document (T03)', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id), menu = page.getByRole('menu', { name: 'Clip actions' });
  await clip(page, 'clipC').click({ button: 'right' }); expect(await viewState(page, v => v.selection)).toEqual(['clipC']); await expect(menu.getByRole('menuitem')).toHaveText(['Split at playhead', 'Duplicate', 'Slip', 'Copy', 'Paste at playhead', 'Delete']);
  const states = async () => Object.fromEntries(await menu.getByRole('menuitem').evaluateAll(items => items.map(i => [i.textContent, (i as HTMLButtonElement).disabled])));
  expect(await states()).toEqual({ 'Split at playhead': true, Duplicate: false, Slip: false, Copy: false, 'Paste at playhead': true, Delete: false }); // playhead 0 is outside the clip; clipboard empty; hidden source → Slip on
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toHaveClass(/danger/); await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  await setViewState(page, { playheadMs: 3000 }); await clip(page, 'clipC').click({ button: 'right' }); expect((await states())['Split at playhead']).toBe(false);
  await menu.getByRole('menuitem', { name: 'Split at playhead' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'splitItems', itemIds: ['clipC'], atMs: 3000 });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); let doc = await liveDoc(page); expect(doc.items).toHaveLength(6); expect(spanOf(doc, 'clipC')).toEqual([2000, 3000]); // T03: split at the playhead
  await clip(page, 'clipC').click({ button: 'right' }); await menu.getByRole('menuitem', { name: 'Duplicate' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'duplicateItems', itemIds: ['clipC'] });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); expect((await liveDoc(page)).items).toHaveLength(7);
  const afterDuplicate = await liveDoc(page); const count = (await intents(page)).length; await clip(page, 'clipC').click({ button: 'right' }); await menu.getByRole('menuitem', { name: 'Copy' }).click();
  expect((await intents(page)).length).toBe(count); expect(await viewState(page, v => v.clipboard.map((i: any) => i.id))).toEqual(['clipC']); // copy: view state only
  await clip(page, 'clipC').click({ button: 'right' }); expect((await states())['Paste at playhead']).toBe(false); await menu.getByRole('menuitem', { name: 'Paste at playhead' }).click();
  let l = await lastIntent(page); expect(l.intent).toMatchObject({ type: 'pasteItems', atMs: 3000 }); expect(l.intent.items.map((i: any) => i.id)).toEqual(['clipC']); expect(l.outcome).toEqual({ ok: true });
  doc = await liveDoc(page); expect(doc.items).toHaveLength(8);
  // Paste placement (findings part 2 §29 l.415, moves right past overlapping items): the 1 s copy of clipC keeps track v2 and asks for the playhead 3000, which the right half of the split (3000-6000) occupies
  // and so does the duplicate behind it, so it lands at 7000-8000 on v2 with no new track.
  const pasted = doc.items.filter((i: any) => !afterDuplicate.items.some((o: any) => o.id === i.id)); expect(pasted).toHaveLength(1); expect(pasted[0]).toMatchObject({ type: 'video', trackId: 'v2', display: { from: 7000, to: 8000 } }); expect(doc.tracks).toHaveLength(afterDuplicate.tracks.length);
  await clip(page, 'clipC').click({ button: 'right' }); await menu.getByRole('menuitem', { name: 'Slip' }).click(); expect(await viewState(page, v => v.toolMode)).toBe('slip'); expect((await lastIntent(page)).intent.type).toBe('pasteItems'); // slip mode: view state
  await clip(page, 'clipC').click({ button: 'right' }); await expect(menu.getByRole('menuitem', { name: 'Exit slip mode' })).toBeVisible(); await page.keyboard.press('Escape'); await toolbar(page).getByRole('button', { name: 'Slip', exact: true }).click();
  await clip(page, 'clipC').click({ button: 'right' }); await menu.getByRole('menuitem', { name: 'Delete' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'deleteItems', itemIds: ['clipC'], ripple: false });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); doc = await liveDoc(page); expect(doc.items).toHaveLength(7); expect(itemById(doc, 'clipC')).toBeUndefined();
  expect(await undoEntries(page)).toEqual(['Split items', 'Duplicate items', 'Add items', 'Delete items'].map(label => ({ label, source: 'user' })));
  const saved = await savedDoc(page, id); expect(saved.items).toHaveLength(7); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D8 Slip is always off for image clips; a locked track turns every entry off; a grouped clip adds Move out of group (T03)', async ({ page }) => {
  const doc = richDoc(); doc.tracks = doc.tracks.map(t => t.id === 'v2' ? { ...t, locked: true } : t);
  await openEditor(page, doc); const menu = page.getByRole('menu', { name: 'Clip actions' });
  await clip(page, 'photo').click({ button: 'right' }); await expect(menu.getByRole('menuitem', { name: 'Slip' })).toBeDisabled(); await page.keyboard.press('Escape');
  await toolbar(page).getByRole('button', { name: 'Slip', exact: true }).click(); await clip(page, 'photo').click({ button: 'right' }); await expect(menu.getByRole('menuitem', { name: 'Exit slip mode' })).toBeDisabled(); await page.keyboard.press('Escape');
  await clip(page, 'clipC').click({ button: 'right' }); await expect(menu.getByRole('menuitem')).toHaveCount(6); for (const item of await menu.getByRole('menuitem').all()) await expect(item).toBeDisabled(); await page.keyboard.press('Escape');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
});

test('D8 a clip in a group shows Move out of group first and moves it to a new root track (T03)', async ({ page }) => {
  const id = await openEditor(page, groupedDoc()); await watchIntents(page); const before = await stored(page, id), menu = page.getByRole('menu', { name: 'Clip actions' });
  await clip(page, 'clipA').click({ button: 'right' }); await expect(menu.getByRole('menuitem')).toHaveText(['Move out of group', 'Split at playhead', 'Duplicate', 'Slip', 'Copy', 'Paste at playhead', 'Delete']);
  await menu.getByRole('menuitem', { name: 'Move out of group' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'moveItemOutOfGroup', itemId: 'clipA' });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); const doc = await liveDoc(page), a = itemById(doc, 'clipA'), t = doc.tracks.find((x: any) => x.id === a.trackId); // T03: a new root track "V1 copy" just above the group
  expect(['v1', 'v2']).not.toContain(a.trackId); expect(t).toMatchObject({ name: 'V1 copy', kind: 'video' }); expect(doc.layerOrder).toEqual([{ type: 'track', id: 'a1' }, { type: 'group', id: 'g1' }, { type: 'track', id: t.id }, { type: 'track', id: 'o1' }]);
  expect(spanOf(doc, 'clipA')).toEqual([0, 8000]); expect(await undoEntries(page)).toEqual([{ label: 'Move item out of group', source: 'user' }]);
  await clip(page, 'title').click({ button: 'right' }); await expect(menu.getByRole('menuitem', { name: 'Move out of group' })).toHaveCount(0);
  const saved = await savedDoc(page, id); expect(itemById(saved, 'clipA').trackId).toBe(t.id); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D8 a right-click anywhere on a track header (name, handle, count, empty area, icon row) opens the same track menu at the pointer', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1300 }); // tall enough that the menu is not clamped to the viewport bottom
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id), menu = page.getByRole('menu', { name: 'Track V1' }); const h = header(page, 'V1');
  const targets: [string, ReturnType<Page['locator']>, { x: number; y: number }?][] = [['name', h.locator('.track-name')], ['drag handle', h.locator('.drag-handle')], ['item count', h.locator('.item-count')], ['empty area', h, { x: 4, y: 4 }], ['icon row', h.locator('.track-icons')]];
  for (const [what, target, position] of targets) {
    const b = (await target.boundingBox())!, x = b.x + (position?.x ?? b.width / 2), y = b.y + (position?.y ?? b.height / 2);
    await page.mouse.click(x, y, { button: 'right' }); await expect(menu, what).toBeVisible(); await expect(menu.getByRole('menuitem'), what).toHaveText(['Group tracks…', 'Delete track']);
    const m = (await menu.boundingBox())!; expect(Math.abs(m.x - x), `${what} x`).toBeLessThan(3); expect(Math.abs(m.y - y), `${what} y`).toBeLessThan(3);
    await expect(menu.getByRole('menuitem', { name: 'Group tracks…' }), what).toBeEnabled(); await expect(menu.getByRole('menuitem', { name: 'Delete track' }), what).toBeEnabled(); await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  }
  // An empty track offers both entries too; Delete track acts at once (no confirmation dialog) and removes the track with its clips (T03).
  let dialog = false; page.on('dialog', d => { dialog = true; void d.dismiss(); });
  await header(page, 'O3').locator('.track-name').click({ button: 'right' }); await expect(page.getByRole('menu', { name: 'Track O3' }).getByRole('menuitem')).toHaveText(['Group tracks…', 'Delete track']); await page.keyboard.press('Escape');
  await h.locator('.track-name').click({ button: 'right' }); await menu.getByRole('menuitem', { name: 'Delete track' }).click();
  expect((await lastIntent(page)).intent).toEqual({ type: 'deleteTrack', trackId: 'v1' }); expect(dialog).toBe(false);
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); const doc = await liveDoc(page);
  await expect(page.locator('.track-name')).toHaveText(['O3', 'O2', 'O1', 'V2', 'A1']); await expect(clip(page, 'clipA')).toHaveCount(0); await expect(clip(page, 'clipB')).toHaveCount(0); // the track and its clips are gone
  expect(doc.tracks.map((t: any) => t.id)).toEqual(['a1', 'v2', 'o1', 'o2', 'o3']); expect(doc.items.map((i: any) => i.id)).toEqual(['clipC', 'title', 'photo']); expect(await undoEntries(page)).toEqual([{ label: 'Delete track', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(saved.tracks.map((t: any) => t.id)).toEqual(['a1', 'v2', 'o1', 'o2', 'o3']); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D8 a grouped track offers Move track out of group; a group row opens no menu; its … menu lists four entries (each acts, T03)', async ({ page }) => {
  const id = await openEditor(page, groupedDoc()); await watchIntents(page); const before = await stored(page, id);
  // T03: every entry edits the document, so the steps undo themselves (the toolbar Undo button) to start the next one from the stored document.
  const restore = async (what: string) => { while ((await undoEntries(page)).length) await toolbar(page).getByRole('button', { name: 'Undo', exact: true }).click(); expect(norev(await liveDoc(page)), what).toEqual(norev(JSON.parse(before.json))); };
  await header(page, 'V1').locator('.track-name').click({ button: 'right' }); const menu = page.getByRole('menu', { name: 'Track V1' }); await expect(menu.getByRole('menuitem')).toHaveText(['Move track out of group', 'Delete track']);
  await menu.getByRole('menuitem', { name: 'Move track out of group' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'moveTrackOutOfGroup', trackId: 'v1' });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); let doc = await liveDoc(page); expect(doc.groups).toEqual({}); expect(doc.layerOrder).toEqual([{ type: 'track', id: 'a1' }, { type: 'track', id: 'v2' }, { type: 'track', id: 'v1' }, { type: 'track', id: 'o1' }]); // v1 is at the root; g1 kept only v2, so it dissolves (provisional rule: a group needs two tracks, §37)
  expect(await undoEntries(page)).toEqual([{ label: 'Move track layer', source: 'user' }]); await restore('move track out of group');
  await header(page, 'Group 1').locator('.track-name').click({ button: 'right' }); await expect(page.getByRole('menu')).toHaveCount(0); await header(page, 'Group 1').click({ button: 'right', position: { x: 4, y: 4 } }); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('button', { name: 'Group 1 actions' }).click(); const actions = page.getByRole('menu', { name: 'Group 1 actions' }); await expect(actions.getByRole('menuitem')).toHaveText(['Hide group', 'Lock group', 'Ungroup', 'Delete group and contents']);
  await actions.getByRole('menuitem', { name: 'Hide group' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'setGroupFlag', groupId: 'g1', flag: 'hidden', value: true });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); expect((await liveDoc(page)).groups.g1.hidden).toBe(true);
  await page.getByRole('button', { name: 'Group 1 actions' }).click(); await actions.getByRole('menuitem', { name: 'Lock group' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'setGroupFlag', groupId: 'g1', flag: 'locked', value: true });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); expect((await liveDoc(page)).groups.g1.locked).toBe(true); expect(await undoEntries(page)).toEqual([{ label: 'Set group flag', source: 'user' }, { label: 'Set group flag', source: 'user' }]); await restore('hide + lock group');
  await page.getByRole('button', { name: 'Group 1 actions' }).click(); await actions.getByRole('menuitem', { name: 'Ungroup' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'ungroupTracks', groupId: 'g1' });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); doc = await liveDoc(page); expect(doc.groups).toEqual({}); expect(doc.items).toHaveLength(4); expect(await undoEntries(page)).toEqual([{ label: 'Ungroup tracks', source: 'user' }]); await restore('ungroup');
  await page.getByRole('button', { name: 'Group 1 actions' }).click(); await actions.getByRole('menuitem', { name: 'Delete group and contents' }).click(); expect((await lastIntent(page)).intent).toEqual({ type: 'deleteGroup', groupId: 'g1' });
  expect((await lastIntent(page)).outcome).toEqual({ ok: true }); doc = await liveDoc(page); expect(doc.groups).toEqual({}); expect(doc.tracks.map((t: any) => t.id)).toEqual(['a1', 'o1']); expect(doc.items.map((i: any) => i.id)).toEqual(['title']); expect(await undoEntries(page)).toEqual([{ label: 'Delete group', source: 'user' }]); await restore('delete group');
  for (const [name, intent, label] of [['Hide Group 1', { type: 'setGroupFlag', groupId: 'g1', flag: 'hidden', value: true }, 'Set group flag'], ['Move Group 1 up', { type: 'reorderGroup', groupId: 'g1', direction: 'up' }, 'Reorder group'], ['Move Group 1 down', { type: 'reorderGroup', groupId: 'g1', direction: 'down' }, 'Reorder group'], ['Ungroup Group 1', { type: 'ungroupTracks', groupId: 'g1' }, 'Ungroup tracks']] as const) {
    await page.getByRole('button', { name, exact: true }).click(); expect((await lastIntent(page)).intent, name).toEqual(intent); expect((await lastIntent(page)).outcome, name).toEqual({ ok: true });
    expect(await undoEntries(page), name).toEqual([{ label, source: 'user' }]); const order = (await liveDoc(page)).layerOrder.map((e: any) => e.id);
    if (name === 'Move Group 1 up') expect(order).toEqual(['a1', 'o1', 'g1']); if (name === 'Move Group 1 down') expect(order).toEqual(['g1', 'a1', 'o1']);
    await restore(name);
  }
  const saved = await savedDoc(page, id); expect(saved.layerOrder).toEqual(JSON.parse(before.json).layerOrder);
});

test('D9 grouping mode: V2 → Group (1) disabled; O3 → O3 O2 O1 V2 → Group (4); Shift/Ctrl on headers selects nothing; Create names it "Group 1" and groups them (T03)', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  await header(page, 'V2').locator('.track-name').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Group tracks…' }).click();
  const bar = page.getByRole('toolbar', { name: 'Group tracks' }); await expect(bar.getByRole('button')).toHaveText(['Cancel', 'Group (1)']); await expect(bar.getByRole('button', { name: 'Group (1)' })).toBeDisabled();
  const box = (name: string) => page.getByRole('checkbox', { name: `Select ${name} for the group` }); await expect(box('V2')).toBeChecked(); for (const n of ['O3', 'O2', 'O1', 'V1', 'A1']) await expect(box(n), n).not.toBeChecked();
  await box('O3').check(); for (const n of ['O3', 'O2', 'O1', 'V2']) await expect(box(n), n).toBeChecked(); for (const n of ['V1', 'A1']) await expect(box(n), n).not.toBeChecked();
  await expect(bar.getByRole('button', { name: 'Group (4)' })).toBeEnabled();
  // Header clicks with Shift or Ctrl select nothing and change nothing.
  await header(page, 'V1').locator('.track-name').click({ modifiers: ['Shift'] }); await header(page, 'A1').locator('.track-name').click({ modifiers: ['Control'] });
  expect(await viewState(page, v => v.selection)).toEqual([]); expect(await viewState(page, v => v.groupSelection.checked)).toEqual(['o3', 'o2', 'o1', 'v2']);
  await bar.getByRole('button', { name: 'Group (4)' }).click(); const dialog = page.getByRole('dialog', { name: 'Name group' }); await expect(dialog.getByLabel('Group name')).toHaveAttribute('placeholder', 'Group 1');
  await expect(dialog.getByRole('button')).toContainText(['×', 'Cancel', 'Create']); await dialog.getByRole('button', { name: 'Create' }).click();
  expect((await intents(page)).map(l => l.intent)).toEqual([{ type: 'groupTracks', trackIds: ['v2', 'o1', 'o2', 'o3'], name: 'Group 1' }]);
  await expect(toolbar(page)).toBeVisible(); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0); expect(await viewState(page, v => v.groupSelection)).toBeNull();
  // T03 (was: NOT_IMPLEMENTED notice, document untouched): one group "Group 1" holding the four tracks, one "Group tracks" step.
  expect((await intents(page))[0].outcome).toEqual({ ok: true }); const doc = await liveDoc(page), groups = Object.entries<any>(doc.groups); expect(groups).toHaveLength(1); const [gid, g] = groups[0];
  expect(g.name).toBe('Group 1'); expect(g.children.map((c: any) => c.id).sort()).toEqual(['o1', 'o2', 'o3', 'v2']); expect(doc.layerOrder.some((e: any) => e.type === 'group' && e.id === gid)).toBe(true); expect(await undoEntries(page)).toEqual([{ label: 'Group tracks', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(Object.keys(saved.groups)).toEqual([gid]); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D9 a typed name is trimmed; the placeholder is the next free "Group n"; Cancel (dialog or toolbar) and Escape change nothing', async ({ page }) => {
  const doc = richDoc({ groups: { old: { name: 'Group 1', children: [] } } }); const id = await openEditor(page, doc); await watchIntents(page); const before = await stored(page, id);
  const enter = async (name: string) => { await header(page, name).locator('.track-name').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Group tracks…' }).click(); };
  await enter('V1'); await page.getByRole('checkbox', { name: 'Select V2 for the group' }).check(); await page.getByRole('button', { name: 'Group (2)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Name group' }); await expect(dialog.getByLabel('Group name')).toHaveAttribute('placeholder', 'Group 2');
  await dialog.getByRole('button', { name: 'Cancel' }).click(); await expect(dialog).toHaveCount(0); expect(await intents(page)).toEqual([]);
  await page.getByRole('button', { name: 'Group (2)' }).click(); await dialog.getByLabel('Group name').fill('  My cut  '); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(await intents(page)).toEqual([]);
  await page.getByRole('button', { name: 'Group (2)' }).click(); await dialog.getByLabel('Group name').fill('  My cut  '); await dialog.getByLabel('Group name').press('Enter');
  expect((await lastIntent(page)).intent).toEqual({ type: 'groupTracks', trackIds: ['v1', 'v2'], name: 'My cut' });
  await clearIntents(page); await enter('O1'); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0); expect(await intents(page)).toEqual([]);
  await enter('O2'); await blurAll(page); await page.keyboard.press('Escape'); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0); expect(await intents(page)).toEqual([]);
  // T03 rule-6 oracle fix (was: expectUntouched): the confirmed "My cut" group exists next to the old one, as one "Group tracks" step; the cancels changed nothing.
  const now = await liveDoc(page), made = Object.entries<any>(now.groups).filter(([k]) => k !== 'old'); expect(made).toHaveLength(1); expect(made[0][1].name).toBe('My cut'); expect(made[0][1].children.map((c: any) => c.id).sort()).toEqual(['v1', 'v2']); expect(now.groups.old).toEqual(JSON.parse(before.json).groups.old);
  expect(await undoEntries(page)).toEqual([{ label: 'Group tracks', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(Object.keys(saved.groups).sort()).toEqual(['old', made[0][0]].sort());
  await expect.poll(async () => (await journalRows(page, id)).length, { timeout: 10000 }).toBe(1); expect((await journalRows(page, id))[0]).toMatchObject({ project_id: id, source: 'user', label: 'Group tracks' });
});

test('D9 locked tracks cannot be added to a group selection', async ({ page }) => {
  const doc = richDoc(); doc.tracks = doc.tracks.map(t => t.id === 'o1' ? { ...t, locked: true } : t); await openEditor(page, doc);
  await header(page, 'V2').locator('.track-name').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Group tracks…' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select O1 for the group' })).toBeDisabled(); await expect(page.getByRole('checkbox', { name: 'Select O3 for the group' })).toBeDisabled(); // would cross the locked track
  await expect(page.getByRole('checkbox', { name: 'Select V1 for the group' })).toBeEnabled();
});

test('D10 marker lane: pins, click selects, double-click and right-click open nothing, Delete on a selected pin → T03, Shift+M and the toolbar toggle the lane', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id); const pin = page.getByRole('option', { name: 'Marker at 00:03.00' });
  await pin.dblclick(); await pin.click({ button: 'right' }); await page.locator('.marker-lane').dblclick({ position: { x: 700, y: 5 } }); await page.locator('.marker-lane').click({ button: 'right', position: { x: 700, y: 5 } });
  await expect(page.getByRole('menu')).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0); expect(await intents(page)).toEqual([]);
  await pin.click(); await expect(pin).toHaveAttribute('aria-selected', 'true'); expect(await viewState(page, v => v.markerId)).toBe('m1'); expect(await viewState(page, v => v.selection)).toEqual([]);
  expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
  await blurAll(page); await page.keyboard.press('Shift+M'); await expect(page.locator('.marker-lane')).toHaveCount(0); await expect(toolbar(page).getByRole('button', { name: 'Markers', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Shift+M'); await expect(page.locator('.marker-lane')).toHaveCount(1);
});

test('D10 Delete with a marker pin selected by a click → removeMarker (T03); the pin is removed', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id); const pin = page.getByRole('option', { name: 'Marker at 00:03.00' });
  await pin.click(); await expect(pin).toHaveAttribute('aria-selected', 'true');
  const focused = await page.evaluate(() => { const a = document.activeElement; return `${a?.tagName}[role=${a?.getAttribute('role')}] ${a?.getAttribute('aria-label')}`; });
  await page.keyboard.press('Delete'); expect((await intents(page)).map(l => l.intent), `focus after the click: ${focused}`).toEqual([{ type: 'removeMarker', markerId: 'm1' }]);
  expect((await intents(page))[0].outcome).toEqual({ ok: true }); await expect(pin).toHaveCount(0); expect((await liveDoc(page)).markers.map((m: any) => m.id)).toEqual(['m2']); expect(await undoEntries(page)).toEqual([{ label: 'Remove marker', source: 'user' }]); // T03: the marker is gone
  const saved = await savedDoc(page, id); expect(saved.markers.map((m: any) => m.id)).toEqual(['m2']); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D11 header controls edit the track (T03): hide / mute / solo / lock, volume, rename', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id), h = header(page, 'V1');
  for (const [name, flag] of [['Hide V1', 'hidden'], ['Mute V1', 'muted'], ['Solo V1', 'solo'], ['Lock V1', 'locked']]) {
    const button = h.getByRole('button', { name, exact: true }); await expect(button).toHaveAttribute('aria-pressed', 'false'); await button.click();
    expect((await lastIntent(page)).intent, name).toEqual({ type: 'setTrackFlag', trackId: 'v1', flag, value: true }); expect((await lastIntent(page)).outcome, name).toEqual({ ok: true });
    await expect(button).toHaveAttribute('aria-pressed', 'true'); expect((await liveDoc(page)).tracks.find((t: any) => t.id === 'v1')[flag], name).toBe(true); // T03 (was: back to 'false'): the flag is set on the stored track
  }
  expect(await undoEntries(page)).toEqual(Array.from({ length: 4 }, () => ({ label: 'Set track flag', source: 'user' })));
  // Volume: a key step sets 0.99 (stored), a click at the middle sets about 50 % (stored).
  const volume = h.getByRole('slider', { name: 'V1 volume' }), vol = async () => (await liveDoc(page)).tracks.find((t: any) => t.id === 'v1').volume; await expect(volume).toHaveValue('100'); await volume.focus(); await page.keyboard.press('ArrowLeft');
  expect((await lastIntent(page)).intent).toEqual({ type: 'setTrackVolume', trackId: 'v1', volume: 0.99 }); expect((await lastIntent(page)).outcome).toEqual({ ok: true }); expect(await vol()).toBeCloseTo(0.99, 6); await expect(volume).toHaveValue('99');
  const vb = (await volume.boundingBox())!; await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2); const l = await lastIntent(page); expect(l.intent.type).toBe('setTrackVolume'); expect(l.intent.volume).toBeGreaterThan(0.35); expect(l.intent.volume).toBeLessThan(0.65);
  expect(l.outcome).toEqual({ ok: true }); expect(await vol()).toBeCloseTo(l.intent.volume, 6); expect((await undoEntries(page)).slice(4)).toEqual([{ label: 'Set track volume', source: 'user' }, { label: 'Set track volume', source: 'user' }]);
  // Rename: double-click, type, Enter → intent; Escape or an unchanged name → nothing.
  await clearIntents(page); await h.locator('.track-name').dblclick(); await page.getByLabel('Track name').fill('Narration'); await page.getByLabel('Track name').press('Enter');
  expect((await intents(page)).map(x => x.intent)).toEqual([{ type: 'renameTrack', trackId: 'v1', name: 'Narration' }]); expect((await intents(page))[0].outcome).toEqual({ ok: true }); await expect(header(page, 'Narration').locator('.track-name')).toHaveText('Narration'); // T03: renamed in the stored track
  const h2 = header(page, 'Narration'); expect((await liveDoc(page)).tracks.find((t: any) => t.id === 'v1').name).toBe('Narration');
  await h2.locator('.track-name').dblclick(); await page.getByLabel('Track name').fill('Other'); await page.getByLabel('Track name').press('Escape'); await h2.locator('.track-name').dblclick(); await page.getByLabel('Track name').press('Enter'); await h2.locator('.track-name').dblclick(); await page.getByLabel('Track name').fill('   '); await page.getByLabel('Track name').press('Enter');
  expect(await intents(page)).toHaveLength(1);
  const labels = (await undoEntries(page)).map(e => e.label); expect(labels).toHaveLength(7); expect(labels.at(-1)).toBe('Rename track'); expect(labels.filter(x => x === 'Rename track')).toHaveLength(1); // fixture 5: one "Rename track"
  const saved = await savedDoc(page, id); expect(saved.tracks.find((t: any) => t.id === 'v1').name).toBe('Narration'); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D11 lane height: drag +80 px from 56 → 120 (clamped), −80 → 40, +10 → 50 while dragging; each release is one "Resize track" and the height is stored (T03)', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id), row = trackRow(page, 'v1');
  const heights: number[] = [];
  for (const [dy, height] of [[80, 120], [-80, 40], [10, 50]]) {
    const handle = row.locator('.resize-handle'); await handle.scrollIntoViewIfNeeded(); const b = (await handle.boundingBox())!, x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + dy, { steps: 6 }); await expect(row).toHaveCSS('height', `${height}px`); await page.mouse.up();
    expect((await lastIntent(page)).intent, `dy ${dy}`).toEqual({ type: 'resizeTrack', trackId: 'v1', height }); expect((await lastIntent(page)).outcome, `dy ${dy}`).toEqual({ ok: true });
    await expect(row).toHaveCSS('height', `${height}px`); heights.push((await liveDoc(page)).tracks.find((t: any) => t.id === 'v1').height); // T03: the row keeps the new height and the track stores it
  }
  // T03: each release stores the height, so the next drag starts from it (the stub snapped back to 56).
  expect(heights).toEqual([120, 40, 50]); expect(await undoEntries(page)).toEqual(Array.from({ length: 3 }, () => ({ label: 'Resize track', source: 'user' })));
  const saved = await savedDoc(page, id); expect(saved.tracks.find((t: any) => t.id === 'v1').height).toBe(50); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('D11 reorder: dragging a handle onto another header moves the track layer (T03); releasing on itself does nothing', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  const handle = await centre(header(page, 'V1').locator('.drag-handle')), over = await centre(header(page, 'V2').locator('.track-name'));
  await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(over.x, over.y, { steps: 8 }); await page.mouse.up();
  expect((await intents(page)).map(l => l.intent)).toEqual([{ type: 'moveTrackLayer', trackId: 'v1', beforeTrackId: 'v2' }]); expect((await intents(page))[0].outcome).toEqual({ ok: true });
  // T03: beforeTrackId is in display order (top first), so V1 moves above V2; layerOrder is bottom-first.
  let doc = await liveDoc(page); expect(doc.layerOrder.map((e: any) => e.id)).toEqual(['a1', 'v2', 'v1', 'o1', 'o2', 'o3']); await expect(page.locator('.track-name')).toHaveText(['O3', 'O2', 'O1', 'V1', 'V2', 'A1']); expect(await undoEntries(page)).toEqual([{ label: 'Move track layer', source: 'user' }]);
  const handle2 = await centre(header(page, 'V1').locator('.drag-handle')); await clearIntents(page); await page.mouse.move(handle2.x, handle2.y); await page.mouse.down(); await page.mouse.up(); expect(await intents(page)).toEqual([]); expect(await undoEntries(page)).toHaveLength(1);
  const saved = await savedDoc(page, id); expect(saved.layerOrder.map((e: any) => e.id)).toEqual(['a1', 'v2', 'v1', 'o1', 'o2', 'o3']); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
});

test('H5 drops: assets, stock and text payloads on a lane, below the tracks and on the preview report their real outcome (assets and stock T03, text T05); malformed or foreign drags do nothing', async ({ page }) => {
  const leaks = guard(page); const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  const drop = (selector: string, payload: unknown, raw?: string) => page.evaluate(({ selector, payload, raw }) => {
    const el = document.querySelector(selector)!, data = new DataTransfer(); data.setData('application/x-cutframe-timeline', raw ?? JSON.stringify(payload)); const b = el.getBoundingClientRect(); const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: b.left + 120, clientY: b.top + 5 };
    el.dispatchEvent(new DragEvent('dragover', init)); el.dispatchEvent(new DragEvent('drop', init));
  }, { selector, payload, raw });
  const assets = { kind: 'assets', items: [{ assetId: 'a1', type: 'video', name: 'clip.mp4' }] }, stock = { kind: 'stock', item: { provider: 'pexels', provider_id: '7', type: 'video', name: 'Video', thumbnail_url: 'https://example.test/thumb', preview_url: 'https://example.test/preview', duration_ms: 5000, width: 1920, height: 1080, attribution: 'Attribution', author: 'Author', licence: 'Pexels License', page_url: 'https://example.test/page', download_url: 'https://example.test/download', tags: [] } }, text = { kind: 'text', text: 'Hello' };
  await drop('.lane[data-track-id="v2"]', assets); let l = await lastIntent(page);
  expect(l.intent).toMatchObject({ type: 'drop', payload: assets, trackId: 'v2', below: false }); expect(l.intent.timeMs).toBeCloseTo(120 / 0.05, 0); expect(l.outcome).toEqual({ ok: true }); // the drop is accepted; the unknown asset a1 is refused when placing (T03), so the document stays as stored
  await expect(notices(page)).toContainText('MEDIA_NOT_FOUND: Media asset not found'); expect(await undoEntries(page)).toEqual([]);
  await drop('.lane[data-track-id="o1"]', stock); l = await lastIntent(page); expect(l.intent).toMatchObject({ type: 'drop', payload: stock, trackId: 'o1' }); expect(l.outcome).toEqual({ ok: true }); // T03/T14 stock seam: the item is downloaded once (unrouted here, so it fails and nothing is placed)
  await expect.poll(() => leaks, { timeout: 10000 }).toEqual(['https://example.test/download']); expect(await undoEntries(page)).toEqual([]);
  await drop('.drop-below', text); l = await lastIntent(page); expect(l.intent).toMatchObject({ type: 'drop', payload: text, trackId: null, below: true }); expect(l.outcome).toEqual({ ok: true }); // T05 (assertion edit): was NOT_IMPLEMENTED (owner T05); the text drop adds one text item as one 'Add items' step, undone here so the later checks see the stored document
  expect(await undoEntries(page)).toEqual([{ label: 'Add items', source: 'user' }]); await page.locator('header').getByRole('button', { name: 'Undo' }).click(); expect(await undoEntries(page)).toEqual([]);
  await drop('[aria-label="Preview"]', assets); l = await lastIntent(page); expect(l.intent).toMatchObject({ type: 'drop', payload: assets, trackId: null, below: false }); expect(l.outcome).toEqual({ ok: true }); await expect(notices(page).getByText('MEDIA_NOT_FOUND: Media asset not found')).toHaveCount(2); expect(await undoEntries(page)).toEqual([]); // the preview drop is refused the same way
  const count = (await intents(page)).length; await drop('.lane[data-track-id="v2"]', null, '{broken'); await drop('.lane[data-track-id="v2"]', { kind: 'assets', items: [] }); await drop('.lane[data-track-id="v2"]', { kind: 'file', path: '/x' });
  expect((await intents(page)).length).toBe(count); await expectUntouched(page, id, before); expect(leaks).toEqual(['https://example.test/download']); // T03: the only network request is the stock download above (was: none)
});
