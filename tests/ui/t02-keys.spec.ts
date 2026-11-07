// SPDX-License-Identifier: AGPL-3.0-only
// T02 owned acceptance E1–E6 in real Chromium with real key presses. Edit effects of the key script (split, duplicate, nudge, delete, paste,
// undo) are T03's: here each key must produce exactly one typed intent with the right payload, the T03 notice, and no document change.
// Zones: page body, timeline, preview act; a focused button/menu/dialog/input does not. "ground truth" = our written key table (G-15 not stored).
import { test, expect, type Page } from '@playwright/test';
import { itemById, journalRows, liveDoc, savedDoc, spanOf, undoEntries } from './t03-support';
import { blurAll, clearIntents, clip, expectUntouched, groupedDoc, intents, notices, openEditor, richDoc, setViewState, skipTour, stored, viewState, watchIntents } from './t02-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 1000 }); });

type Zone = 'body' | 'timeline' | 'preview';
const focusOn = async (page: Page, zone: Zone) => { if (zone === 'body') await blurAll(page); else if (zone === 'timeline') await page.locator('.timeline-scroll').focus(); else await page.getByRole('region', { name: 'Preview' }).focus(); };
const ZONES: Zone[] = ['body', 'timeline', 'preview'];
const types = async (page: Page) => (await intents(page)).map(l => l.intent.type);
const playhead = (page: Page) => viewState(page, v => v.playheadMs as number);
async function setup(page: Page, doc = richDoc()) { const id = await openEditor(page, doc); await watchIntents(page); return { id, before: await stored(page, id) }; }
test('R3 Tab and Enter select initially unselected clips, expose inspector, and retain keyboard routing', async ({ page }) => {
  const { id, before } = await setup(page); expect(await viewState(page, v => v.selection)).toEqual([]); const original = await liveDoc(page);
  await page.locator('.timeline-scroll').focus(); let first = '';
  for (let n = 0; n < 100 && !first; n++) { await page.keyboard.press('Tab'); first = await page.evaluate(() => document.activeElement?.getAttribute('data-item-id') ?? ''); }
  expect(first).not.toBe(''); await page.keyboard.press('Enter'); expect(await viewState(page, v => v.selection)).toEqual([first]);
  await expect(page.getByRole('complementary', { name: 'Inspector and tools' })).toContainText(/Properties/);
  await clearIntents(page); await page.keyboard.press('ArrowRight'); expect((await intents(page)).at(-1)?.intent.type).toBe('nudgeItems');
  let second = ''; for (let n = 0; n < 100 && !second; n++) { await page.keyboard.press('Tab'); const current = await page.evaluate(() => document.activeElement?.getAttribute('data-item-id') ?? ''); if (current && current !== first) second = current; }
  expect(second).not.toBe(''); await page.keyboard.press('Control+Enter'); expect(await viewState(page, v => v.selection)).toEqual([first, second]);
  await page.keyboard.press('Control+Enter'); expect(await viewState(page, v => v.selection)).toEqual([first]);
  // T03 rule-6 fix (was: expectUntouched): the one ArrowRight really nudged the first selected clip, as one "Edit items" step.
  const nudged = await liveDoc(page); expect(itemById(nudged, first).properties.positionX.defaultValue).toBeGreaterThan(itemById(original, first).properties?.positionX?.defaultValue ?? 0);
  for (const it of nudged.items.filter((i: any) => i.id !== first)) expect(it, it.id).toEqual(itemById(original, it.id)); expect(await undoEntries(page)).toEqual([{ label: 'Edit items', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(itemById(saved, first).properties.positionX.defaultValue).toBe(itemById(nudged, first).properties.positionX.defaultValue);
  await expect.poll(async () => (await journalRows(page, id)).length, { timeout: 10000 }).toBe(1); expect((await journalRows(page, id))[0]).toMatchObject({ project_id: id, source: 'user', label: 'Edit items' });
  await page.keyboard.press('Control+Z'); expect(await undoEntries(page)).toEqual([]); const norev = (d: any) => ({ ...d, rev: 0 }); expect(norev(await liveDoc(page))).toEqual(norev(original)); expect(norev(await savedDoc(page, id))).toEqual(norev(original)); // undone: the stored document equals the original (only the save counter rev moved) // undo restores the stored document
});

test('E1 Space → one togglePlayback intent (T15) from the page, the timeline and the preview', async ({ page }) => {
  const { id, before } = await setup(page);
  for (const zone of ZONES) { await clearIntents(page); await focusOn(page, zone); await page.keyboard.press('Space'); expect((await intents(page)).map(l => [l.intent.type, l.outcome.ok]), zone).toEqual([['togglePlayback', true]]); } // T15 (was: outcome owner T15)
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible(); await expectUntouched(page, id, before); // T15 (was: notice "Playback is not yet implemented (T15)."): three toggles leave it playing
});

test('E1 ground truth: ← / → move the playhead exactly one frame at the project fps (also with Shift or Alt); nothing below 0', async ({ page }) => {
  const { id, before } = await setup(page, richDoc({ fps: 24 }));
  for (const zone of ZONES) {
    await setViewState(page, { playheadMs: 0 }); await focusOn(page, zone);
    await page.keyboard.press('ArrowRight'); expect(await playhead(page), zone).toBeCloseTo(1000 / 24, 9);
    await page.keyboard.press('Shift+ArrowRight'); expect(await playhead(page), `${zone} shift`).toBeCloseTo(2000 / 24, 9);
    await page.keyboard.press('Alt+ArrowRight'); expect(await playhead(page), `${zone} alt`).toBeCloseTo(3000 / 24, 9);
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Alt+ArrowLeft'); await page.keyboard.press('ArrowLeft'); expect(await playhead(page), `${zone} floor`).toBe(0);
  }
  await setViewState(page, { playheadMs: 19990 }); await blurAll(page); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); expect(await playhead(page)).toBe(20000); // clamped to the duration
  await expect(page.getByLabel('Timecode')).toHaveText('00:20.00 | 00:20.00'); expect(await types(page)).toEqual([]); await expectUntouched(page, id, before);
});

test('E1 ground truth: Ctrl+← / Ctrl+→ (and Cmd) also move exactly one frame — "Shift, Ctrl or Alt give no bigger step" (W3-ED-23)', async ({ page }) => {
  await setup(page, richDoc({ fps: 24 })); await blurAll(page);
  await page.keyboard.press('Control+ArrowRight'); expect(await playhead(page)).toBeCloseTo(1000 / 24, 9);
  await page.keyboard.press('Control+ArrowLeft'); expect(await playhead(page)).toBe(0);
  await page.keyboard.press('Meta+ArrowRight'); expect(await playhead(page)).toBeCloseTo(1000 / 24, 9);
});

test('E1 arrows with an item selected nudge it 5 px (Shift 20 px); the playhead stays', async ({ page }) => {
  const { id, before } = await setup(page); await clip(page, 'clipA').click(); await setViewState(page, { playheadMs: 700 });
  const cases: [string, number, number][] = [['ArrowRight', 5, 0], ['ArrowLeft', -5, 0], ['ArrowUp', 0, -5], ['ArrowDown', 0, 5], ['Shift+ArrowRight', 20, 0], ['Shift+ArrowLeft', -20, 0], ['Shift+ArrowUp', 0, -20], ['Shift+ArrowDown', 0, 20]];
  // T03 (was: NOT_IMPLEMENTED notice, document untouched): every press is ok:true, moves properties.positionX/Y by exactly dx/dy, and is one "Edit items" step.
  const pos = async () => { const c = itemById(await liveDoc(page), 'clipA'); return [c.properties?.positionX?.defaultValue ?? 0, c.properties?.positionY?.defaultValue ?? 0]; };
  let x = 0, y = 0, n = 0; expect(await pos()).toEqual([0, 0]);
  for (const zone of ZONES.slice(0, 2)) for (const [key, dx, dy] of cases) {
    await clearIntents(page); await focusOn(page, zone === 'timeline' ? 'timeline' : 'body'); await page.keyboard.press(key);
    const log = await intents(page); expect(log.map(l => l.intent), `${zone} ${key}`).toEqual([{ type: 'nudgeItems', itemIds: ['clipA'], dx, dy }]); expect(log[0].outcome).toEqual({ ok: true });
    x += dx; y += dy; n++; expect(await pos(), `${zone} ${key}`).toEqual([x, y]);
    const entries = await undoEntries(page); expect(entries, `${zone} ${key}`).toHaveLength(n); expect(entries.at(-1)).toEqual({ label: 'Edit items', source: 'user' });
  }
  expect(await playhead(page)).toBe(700);
  await clearIntents(page); await focusOn(page, 'preview'); await page.keyboard.press('ArrowRight'); expect(await types(page)).toEqual(['nudgeItems']);
  const after = await liveDoc(page); expect(itemById(after, 'clipA').properties.positionX.defaultValue).toBe(x + 5); expect(spanOf(after, 'clipA')).toEqual([0, 8000]); expect((await undoEntries(page))).toHaveLength(n + 1);
  const saved = await savedDoc(page, id); expect(itemById(saved, 'clipA').properties.positionX.defaultValue).toBe(x + 5); expect(saved.rev).toBeGreaterThan(before.rev);
});

test('E1 Ctrl+B splits at the playhead and Ctrl+D duplicates the selection (T03); nothing without a selection', async ({ page }) => {
  const { id, before } = await setup(page); await focusOn(page, 'body'); await page.keyboard.press('Control+B'); await page.keyboard.press('Control+D'); expect(await intents(page)).toEqual([]);
  await clip(page, 'clipA').click(); await clip(page, 'clipC').click({ modifiers: ['Control'] }); await setViewState(page, { playheadMs: 2500 });
  // T03 (was: NOT_IMPLEMENTED notice, document untouched). Per zone: Ctrl+B splits both crossing clips as one "Split items"; Ctrl+D duplicates the selection as one
  // "Duplicate items"; the second split finds no crossing clip → INVALID_SPLIT_POINT, no entry, no change. Two Ctrl+Z restore the start.
  const startItems = (await liveDoc(page)).items;
  for (const zone of ZONES) {
    await clearIntents(page); await focusOn(page, zone); await page.keyboard.press('Control+B');
    let doc = await liveDoc(page); expect(spanOf(doc, 'clipA'), `${zone} split A`).toEqual([0, 2500]); expect(spanOf(doc, 'clipC'), `${zone} split C`).toEqual([2000, 2500]); expect(doc.items, zone).toHaveLength(7);
    const rights = doc.items.filter((i: any) => !startItems.some((s: any) => s.id === i.id)); expect(rights.map((i: any) => [i.trackId, i.display.from, i.display.to]).sort(), zone).toEqual([['v1', 2500, 8000], ['v2', 2500, 6000]]);
    expect(await undoEntries(page), zone).toEqual([{ label: 'Split items', source: 'user' }]);
    await page.keyboard.press('Control+D'); doc = await liveDoc(page); expect(doc.items, `${zone} duplicated`).toHaveLength(9);
    for (const id2 of ['clipA', 'clipC']) { const orig = itemById(doc, id2), copies = doc.items.filter((i: any) => i.id !== id2 && i.trackId === orig.trackId && i.type === orig.type && i.metadata?.assetId === orig.metadata?.assetId && i.display.from >= orig.display.to && i.display.to - i.display.from === orig.display.to - orig.display.from); expect(copies.length, `${zone} copy of ${id2}`).toBeGreaterThanOrEqual(1); }
    expect(await undoEntries(page), zone).toEqual([{ label: 'Split items', source: 'user' }, { label: 'Duplicate items', source: 'user' }]);
    await page.keyboard.press('Meta+B'); const log = await intents(page);
    expect(log.map(l => l.intent), zone).toEqual([{ type: 'splitItems', itemIds: ['clipA', 'clipC'], atMs: 2500 }, { type: 'duplicateItems', itemIds: ['clipA', 'clipC'] }, { type: 'splitItems', itemIds: ['clipA', 'clipC'], atMs: 2500 }]);
    expect(log.map(l => l.outcome.ok), zone).toEqual([true, true, false]); expect(log[2].outcome).toMatchObject({ ok: false, code: 'INVALID_SPLIT_POINT' });
    expect((await liveDoc(page)).items, `${zone} refused split changes nothing`).toHaveLength(9); expect(await undoEntries(page), zone).toHaveLength(2);
    await page.keyboard.press('Control+Z'); await page.keyboard.press('Control+Z');
    expect((await liveDoc(page)).items, `${zone} restored`).toEqual(startItems); expect(await undoEntries(page), zone).toEqual([]);
  }
});

test('E1 + and = zoom in ×1.25, − zooms out ×0.8 per press; view only (no intent, no save)', async ({ page }) => {
  const { id, before } = await setup(page); await setViewState(page, { zoom: 0.2, scroll: 0 });
  for (const zone of ZONES) {
    await setViewState(page, { zoom: 0.2 }); await focusOn(page, zone);
    await page.keyboard.press('Shift+='); expect(await viewState(page, v => v.zoom), `${zone} +`).toBeCloseTo(0.25, 12);
    await page.keyboard.press('='); expect(await viewState(page, v => v.zoom), `${zone} =`).toBeCloseTo(0.3125, 12);
    await page.keyboard.press('-'); expect(await viewState(page, v => v.zoom), `${zone} −`).toBeCloseTo(0.25, 12); await page.keyboard.press('-'); expect(await viewState(page, v => v.zoom)).toBeCloseTo(0.2, 12);
  }
  expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
});

test('E1/E3 M adds a marker once (also with nothing selected), Shift+M toggles the lane, Ctrl+Shift+P toggles the overlay', async ({ page }) => {
  const { id, before } = await setup(page); await setViewState(page, { playheadMs: 1010 });
  for (const zone of ZONES) { await clearIntents(page); await focusOn(page, zone); await page.keyboard.press('m'); const log = await intents(page); expect(log.map(l => l.intent), zone).toEqual([{ type: 'addMarker', timeMs: 1000 }]); expect(log[0].outcome, zone).toEqual({ ok: true }); } // frame-aligned at 30 fps
  // T03 (was: NOT_IMPLEMENTED notice, document untouched): each M is ok:true, adds one marker at the frame-aligned playhead, and is one "Add marker" step.
  const markers = async () => (await liveDoc(page)).markers.map((m: any) => m.timeMs); expect(await markers()).toEqual([1000, 1000, 1000, 3000, 9000]);
  expect(await undoEntries(page)).toEqual([1, 2, 3].map(() => ({ label: 'Add marker', source: 'user' })));
  await clip(page, 'title').click(); await clearIntents(page); await page.keyboard.press('m'); expect(await types(page)).toEqual(['addMarker']); // also with an item selected; T12 (was: clipA): with a video or image selected M opens the mask editor (part 2 §36, t12-mask-ui)
  expect(await markers()).toEqual([1000, 1000, 1000, 1000, 3000, 9000]); expect(await undoEntries(page)).toHaveLength(4);
  await blurAll(page); await page.keyboard.press('Shift+M'); await expect(page.locator('.marker-lane')).toHaveCount(0); await page.keyboard.press('Shift+M'); await expect(page.locator('.marker-lane')).toHaveCount(1);
  await focusOn(page, 'timeline'); await page.keyboard.press('Shift+M'); await expect(page.locator('.marker-lane')).toHaveCount(0); await page.keyboard.press('Shift+M'); await expect(page.locator('.marker-lane')).toHaveCount(1);
  expect(await types(page)).toEqual(['addMarker']); // Shift+M is a view toggle, not an intent
  await page.keyboard.press('Control+Shift+P'); await expect(page.getByRole('complementary', { name: 'Performance' })).toBeVisible(); await page.keyboard.press('Control+Shift+P'); await expect(page.getByRole('complementary', { name: 'Performance' })).toHaveCount(0);
  expect(await undoEntries(page)).toHaveLength(4); // the view toggles added nothing
  const saved = await savedDoc(page, id); expect(saved.markers.map((m: any) => m.timeMs)).toEqual([1000, 1000, 1000, 1000, 3000, 9000]); expect(saved.rev).toBeGreaterThan(before.rev);
});

test('E1 Home, End, Escape and unmapped keys do nothing: no playhead move, no deselect, no intent', async ({ page }) => {
  const { id, before } = await setup(page); await clip(page, 'clipB').click(); await setViewState(page, { playheadMs: 4000, zoom: 0.1 });
  for (const zone of ZONES) { await focusOn(page, zone); for (const key of ['Home', 'End', 'Escape', 'PageUp', 'PageDown', 'q', 'Tab']) { if (key === 'Tab') { await focusOn(page, zone); continue; } await page.keyboard.press(key); } }
  expect(await playhead(page)).toBe(4000); expect(await viewState(page, v => v.selection)).toEqual(['clipB']); expect(await viewState(page, v => v.zoom)).toBe(0.1); expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
});

test('E1/E3 Delete priority: keyframe, then marker, then items (Delete and Backspace; ripple follows the tool); each once', async ({ page }) => {
  const { id, before } = await setup(page); const press = async (zone: Zone, key: string) => { await clearIntents(page); await focusOn(page, zone); await page.keyboard.press(key); return intents(page); };
  // T03 (was: NOT_IMPLEMENTED for items and markers, document untouched): items → "Delete items" / "Ripple delete", marker → "Remove marker", each one step; T04: a keyframe delete with no keyframe target (unreachable from the UI: the graph editor handles its own Delete and closing it clears the selection) changes nothing.
  // Each effect is checked on the live document, then undone with Ctrl+Z so the next case starts from the same document.
  const itemIds = async () => (await liveDoc(page)).items.map((i: any) => i.id), allItems = ['clipA', 'clipB', 'clipC', 'title', 'photo'];
  const undoOne = async (label: string, what: string) => { expect(await undoEntries(page), what).toEqual([{ label, source: 'user' }]); await page.keyboard.press('Control+Z'); expect(await undoEntries(page), `${what} undone`).toEqual([]); expect(await itemIds(), `${what} restored`).toEqual(allItems); expect((await liveDoc(page)).markers.map((m: any) => m.id), `${what} markers restored`).toEqual(['m1', 'm2']); };
  expect(await itemIds()).toEqual(allItems);
  for (const zone of ZONES) for (const key of ['Delete', 'Backspace']) {
    await setViewState(page, { selection: ['clipA', 'clipB'], markerId: null, keyframeSelected: false, toolMode: 'select' });
    let log = await press(zone, key); expect(log.map(l => l.intent), `${zone} ${key} items`).toEqual([{ type: 'deleteItems', itemIds: ['clipA', 'clipB'], ripple: false }]); expect(log[0].outcome).toEqual({ ok: true });
    expect(await itemIds(), `${zone} ${key} items`).toEqual(['clipC', 'title', 'photo']); await undoOne('Delete items', `${zone} ${key} items`);
    await setViewState(page, { selection: ['clipA', 'clipB'], toolMode: 'ripple' }); log = await press(zone, key); expect(log.map(l => l.intent), `${zone} ${key} ripple`).toEqual([{ type: 'deleteItems', itemIds: ['clipA', 'clipB'], ripple: true }]); expect(log[0].outcome).toEqual({ ok: true });
    expect(await itemIds(), `${zone} ${key} ripple`).toEqual(['clipC', 'title', 'photo']); await undoOne('Ripple delete', `${zone} ${key} ripple`);
    await setViewState(page, { selection: ['clipA', 'clipB'], markerId: 'm2', toolMode: 'select' }); log = await press(zone, key); expect(log.map(l => l.intent), `${zone} ${key} marker beats items`).toEqual([{ type: 'removeMarker', markerId: 'm2' }]); expect(log[0].outcome).toEqual({ ok: true });
    expect((await liveDoc(page)).markers.map((m: any) => m.id), `${zone} ${key} marker`).toEqual(['m1']); expect(await itemIds(), `${zone} ${key} marker leaves the items`).toEqual(allItems); await undoOne('Remove marker', `${zone} ${key} marker`);
    await setViewState(page, { selection: ['clipA', 'clipB'], markerId: 'm2', keyframeSelected: true }); log = await press(zone, key); expect(log.map(l => l.intent), `${zone} ${key} keyframe beats marker`).toEqual([{ type: 'deleteKeyframe' }]);
    expect(log[0].outcome).toEqual({ ok: true }); expect(await undoEntries(page)).toEqual([]); expect(await itemIds()).toEqual(allItems);
    await setViewState(page, { selection: [], markerId: null, keyframeSelected: false }); expect((await press(zone, key)).map(l => l.intent), `${zone} ${key} nothing`).toEqual([]);
  }
  await expect(notices(page)).not.toContainText('Deleting a keyframe');
  // Net effect of all those steps: undo restored every item and marker.
  const end = await liveDoc(page); expect(end.items).toEqual(JSON.parse(before.json).items); expect(end.markers).toEqual(JSON.parse(before.json).markers);
});

test('E1/E3 Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Ctrl+C, Ctrl+V are handled once whether the page or the timeline has focus (Ctrl and Cmd)', async ({ page }) => {
  const { id, before } = await setup(page); await clip(page, 'clipC').click(); await setViewState(page, { playheadMs: 3000 });
  const norev = (d: any) => ({ ...d, rev: 0 }); let round = 0, prev: { before: any; after: any } | undefined; // T03: the paste is a real edit, so rounds 2-4 find the previous round's paste on the undo stack
  for (const zone of ['body', 'timeline'] as const) for (const mod of ['Control', 'Meta']) {
    round++; const at = `${zone} ${mod}`;
    await focusOn(page, zone); await clearIntents(page); await setViewState(page, { clipboard: [] });
    await page.keyboard.press(`${mod}+V`); expect(await intents(page), `${at} paste with an empty clipboard`).toEqual([]);
    const start = norev(await liveDoc(page)), depth = (await undoEntries(page)).length; // round 1 has nothing to undo; later rounds undo the previous round's paste
    await page.keyboard.press(`${mod}+Z`); expect(norev(await liveDoc(page)), `${at} undo`).toEqual(prev?.before ?? start); expect((await undoEntries(page)).length, `${at} undo`).toBe(prev ? depth - 1 : depth);
    await page.keyboard.press(`${mod}+Shift+Z`); expect(norev(await liveDoc(page)), `${at} redo`).toEqual(prev?.after ?? start); expect((await undoEntries(page)).length, `${at} redo`).toBe(depth);
    await page.keyboard.press(`${mod}+Y`); expect(norev(await liveDoc(page)), `${at} Y (nothing left to redo)`).toEqual(start); expect((await undoEntries(page)).length, `${at} Y`).toBe(depth);
    expect(await types(page), at).toEqual(['undo', 'redo', 'redo']); expect((await intents(page)).map(l => l.outcome), at).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    await page.keyboard.press(`${mod}+C`); expect(await viewState(page, v => v.clipboard.map((i: any) => i.id)), `${at} copy`).toEqual(['clipC']); expect(await types(page)).toEqual(['undo', 'redo', 'redo']); // copy: view state only
    const pre = norev(await liveDoc(page)); await page.keyboard.press(`${mod}+V`); const log = await intents(page); expect(log.at(-1)!.intent, `${at} paste`).toMatchObject({ type: 'pasteItems', atMs: 3000 }); expect((log.at(-1)!.intent as any).items.map((i: any) => i.id)).toEqual(['clipC']); expect(log).toHaveLength(4);
    expect(log.at(-1)!.outcome).toEqual({ ok: true }); const doc = await liveDoc(page); prev = { before: pre, after: norev(doc) };
    // Placement (findings part 2 §29 l.415, moves right past overlapping items): the copy keeps clipC's track v2 and starts at the playhead 3000, so it moves right past clipC
    // (2000-6000) and past the copies pasted before it; no new track.
    const pasted = doc.items.filter((i: any) => !pre.items.some((o: any) => o.id === i.id)); expect(pasted, at).toHaveLength(1);
    expect(pasted[0].trackId, at).toBe(itemById(doc, 'clipC').trackId); expect(pasted[0].display, at).toEqual({ from: 2000 + 4000 * round, to: 6000 + 4000 * round }); expect(doc.tracks, at).toHaveLength(pre.tracks.length);
    expect(await undoEntries(page), at).toEqual(Array.from({ length: round }, () => ({ label: 'Add items', source: 'user' })));
  }
  const final = await liveDoc(page); expect(final.items).toHaveLength(9); expect(await undoEntries(page)).toEqual(Array.from({ length: 4 }, () => ({ label: 'Add items', source: 'user' }))); expect(norev(final)).not.toEqual(norev(JSON.parse(before.json)));
});

test('E2 keys do nothing while a button is focused (it swallows the arrows), a menu or dialog is open, or text is being typed', async ({ page }) => {
  const { id, before } = await setup(page); await clip(page, 'clipA').click(); await setViewState(page, { playheadMs: 0, zoom: 0.1 }); const keys = ['ArrowRight', 'ArrowLeft', 'm', 'Delete', 'Backspace', '+', '-', 'Control+B', 'Control+D', 'Control+Z', '?', 'Shift+M'];
  const quiet = async (what: string) => { expect(await intents(page), what).toEqual([]); expect(await playhead(page), what).toBe(0); expect(await viewState(page, v => v.zoom), what).toBe(0.1); await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' }), what).toHaveCount(0); };
  // A focused toolbar button (not pressed with Space/Enter: those activate it).
  await page.getByRole('button', { name: 'Zoom to fit' }).focus(); for (const key of keys) await page.keyboard.press(key); await quiet('toolbar button');
  await page.getByRole('tab', { name: 'Reference' }).focus(); for (const key of keys.filter(k => !k.startsWith('Arrow'))) await page.keyboard.press(key); await quiet('tab');
  // A text input: the keys are typed, not run.
  const search = page.getByLabel('Search footage'); await search.focus(); await page.keyboard.type('mm?+-'); await expect(search).toHaveValue('mm?+-'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Delete'); await quiet('text input');
  // An open menu.
  await page.getByRole('button', { name: 'Resize', exact: true }).click(); await expect(page.getByRole('menuitemradio').first()).toBeFocused(); for (const key of ['m', 'Delete', '+', 'Control+B']) await page.keyboard.press(key); await quiet('open menu'); await page.keyboard.press('Escape');
  // An open dialog.
  await page.getByRole('button', { name: 'Help', exact: true }).click(); await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click(); const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' }); await expect(dialog).toBeVisible();
  for (const key of ['ArrowRight', 'm', 'Delete', '+', 'Control+B', 'Control+Shift+P']) await page.keyboard.press(key);
  expect(await intents(page)).toEqual([]); expect(await playhead(page)).toBe(0); await expect(page.getByRole('complementary', { name: 'Performance' })).toHaveCount(0); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(await viewState(page, v => v.selection)).toEqual(['clipA']); await expectUntouched(page, id, before);
});

test('E4 group-selection layer: Ctrl/Cmd+C/V/D/Z/Y, M, Delete and Backspace are swallowed; ←/→ still step; Escape leaves the mode', async ({ page }) => {
  const { id, before } = await setup(page); const original = await liveDoc(page); await clip(page, 'clipA').click();
  const enter = async (name = 'V2') => { await page.locator('.track-row').filter({ has: page.locator('.track-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.track-name').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Group tracks…' }).click(); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toBeVisible(); };
  await enter();
  for (const zone of ['body', 'timeline'] as const) {
    await focusOn(page, zone);
    for (const key of ['Control+C', 'Control+V', 'Control+D', 'Control+Z', 'Control+Y', 'Control+Shift+Z', 'Meta+C', 'Meta+V', 'Meta+D', 'Meta+Z', 'Meta+Y', 'm', 'Delete', 'Backspace']) await page.keyboard.press(key);
    expect(await intents(page), zone).toEqual([]); expect(await viewState(page, v => v.clipboard), zone).toEqual([]);
  }
  expect(await viewState(page, v => v.selection)).toEqual(['clipA']); expect(await viewState(page, v => v.groupSelection !== null)).toBe(true);
  await focusOn(page, 'body'); await page.keyboard.press('ArrowRight'); expect(await playhead(page)).toBeCloseTo(1000 / 30, 9); await page.keyboard.press('ArrowLeft'); expect(await playhead(page)).toBe(0); expect(await intents(page)).toEqual([]); // steps, no nudge
  await page.keyboard.press('Escape'); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0);
  await enter('V1'); await focusOn(page, 'timeline'); await page.keyboard.press('Escape'); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0);
  await enter('O1'); await page.getByRole('checkbox', { name: 'Select O1 for the group' }).focus(); await page.keyboard.press('Escape'); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0); // a focused checkbox
  await enter('O2'); await focusOn(page, 'preview'); await page.keyboard.press('Escape'); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0);
  // Outside the mode the same keys act again.
  await focusOn(page, 'body'); await page.keyboard.press('Delete'); expect(await types(page)).toEqual(['deleteItems']);
  // T03 rule-6 fix (was: expectUntouched): outside the mode Delete really removes the selected clipA, as one "Delete items" step.
  const gone = await liveDoc(page); expect(itemById(gone, 'clipA')).toBeUndefined(); expect(gone.items).toHaveLength(original.items.length - 1); expect(await undoEntries(page)).toEqual([{ label: 'Delete items', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(itemById(saved, 'clipA')).toBeUndefined();
  await expect.poll(async () => (await journalRows(page, id)).length, { timeout: 10000 }).toBe(1); expect((await journalRows(page, id))[0]).toMatchObject({ project_id: id, source: 'user', label: 'Delete items' });
  await page.keyboard.press('Control+Z'); expect(await undoEntries(page)).toEqual([]); const norev = (d: any) => ({ ...d, rev: 0 }); expect(norev(await liveDoc(page))).toEqual(norev(original)); expect(norev(await savedDoc(page, id))).toEqual(norev(original)); // undone: the stored document equals the original (only the save counter rev moved)
});

test('E4 Escape inside the Name group dialog closes the dialog only; the mode stays until Cancel or Escape on the page', async ({ page }) => {
  await setup(page); await page.locator('.track-row').filter({ has: page.locator('.track-name', { hasText: /^V1$/ }) }).locator('.track-name').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Group tracks…' }).click();
  await page.getByRole('checkbox', { name: 'Select V2 for the group' }).check(); await page.getByRole('button', { name: 'Group (2)' }).click(); await expect(page.getByRole('dialog', { name: 'Name group' })).toBeVisible();
  const focused = await page.evaluate(() => { const a = document.activeElement; return `${a?.tagName}[${a?.getAttribute('aria-label')}]`; });
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Name group' })).toHaveCount(0); await expect(page.getByRole('toolbar', { name: 'Group tracks' }), `the dialog's focus was ${focused}`).toBeVisible();
  await blurAll(page); await page.keyboard.press('Escape'); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0);
});

test('E5 timeline-locked (blocking) layer: only Space and ←/→ act; every other key is swallowed; grouping is refused; unlocking restores the map', async ({ page }) => {
  const { id, before } = await setup(page); const original = await liveDoc(page); await clip(page, 'clipA').click(); await setViewState(page, { playheadMs: 0, zoom: 0.1 });
  await page.evaluate(async () => { const p = '/src/editor/view.ts'; const { setView, view } = await import(p); setView({ modes: { ...view().modes, timelineLocked: true } }); });
  for (const zone of ['body', 'timeline'] as const) {
    await focusOn(page, zone); await clearIntents(page);
    for (const key of ['m', 'Shift+M', 'Delete', 'Backspace', '+', '-', 'Control+B', 'Control+D', 'Control+Z', 'Control+C', 'Control+V', 'ArrowUp', 'ArrowDown', '?', 'Home']) await page.keyboard.press(key);
    expect(await intents(page), `${zone} swallowed`).toEqual([]); expect(await viewState(page, v => v.zoom), zone).toBe(0.1); await expect(page.locator('.marker-lane'), zone).toHaveCount(1);
  }
  await clearIntents(page); await focusOn(page, 'body');
  for (const key of ['m', 'Delete', 'Control+B', 'Control+Z', 'ArrowUp', 'ArrowDown']) await page.keyboard.press(key);
  expect(await intents(page)).toEqual([]); expect(await viewState(page, v => v.zoom)).toBe(0.1); expect(await playhead(page)).toBe(0); await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0); await expect(page.locator('.marker-lane')).toHaveCount(1);
  await page.keyboard.press('ArrowRight'); expect(await playhead(page)).toBeCloseTo(1000 / 30, 9); await page.keyboard.press('Shift+ArrowRight'); expect(await playhead(page)).toBeCloseTo(2000 / 30, 9); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); expect(await playhead(page)).toBe(0); // frame steps (Shift: still one frame) even with a selection
  await page.keyboard.press('Space'); await page.keyboard.press('Space'); expect((await intents(page)).map(l => [l.intent.type, l.outcome.ok])).toEqual([['togglePlayback', true], ['togglePlayback', true]]); await setViewState(page, { playheadMs: 0 }); // T15 (was: one press, outcome owner T15): play then pause, playhead back at 0 for the marker check below
  await page.locator('.track-row').filter({ has: page.locator('.track-name', { hasText: /^V2$/ }) }).locator('.track-name').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Group tracks…' }).click();
  await expect(notices(page)).toContainText('Tracks can’t be grouped while the timeline is locked'); await expect(page.getByRole('toolbar', { name: 'Group tracks' })).toHaveCount(0);
  await page.evaluate(async () => { const p = '/src/editor/view.ts'; const { setView, view } = await import(p); setView({ modes: { ...view().modes, timelineLocked: false } }); });
  await setViewState(page, { selection: [] }); await clearIntents(page); await focusOn(page, 'body'); await page.keyboard.press('m'); expect(await types(page)).toEqual(['addMarker']); // T12: nothing selected (clipA would open the mask editor)
  // T03 rule-6 fix (was: expectUntouched): once unlocked, M really adds one marker at the playhead (0 ms) as one "Add marker" step.
  const marked = await liveDoc(page); expect(marked.markers).toHaveLength(original.markers.length + 1); expect(marked.markers.some((m: any) => m.timeMs === 0)).toBe(true); expect(await undoEntries(page)).toEqual([{ label: 'Add marker', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(saved.markers).toHaveLength(original.markers.length + 1);
  await expect.poll(async () => (await journalRows(page, id)).length, { timeout: 10000 }).toBe(1); expect((await journalRows(page, id))[0]).toMatchObject({ project_id: id, source: 'user', label: 'Add marker' });
  await page.keyboard.press('Control+Z'); expect(await undoEntries(page)).toEqual([]); const norev = (d: any) => ({ ...d, rev: 0 }); expect(norev(await liveDoc(page))).toEqual(norev(original)); expect(norev(await savedDoc(page, id))).toEqual(norev(original)); // undone: the stored document equals the original (only the save counter rev moved)
});

test('seam: with the graph editor open the key handler is off (T04); smart-mask mode swallows Space, Delete and the zoom keys (T12)', async ({ page }) => {
  await setup(page); await clip(page, 'clipA').click(); await setViewState(page, { zoom: 0.1 }); await blurAll(page);
  const mode = (patch: object) => page.evaluate(async patch => { const p = '/src/editor/view.ts'; const { setView, view } = await import(p); setView({ modes: { graphEditorOpen: false, smartMask: false, timelineLocked: false, ...patch } }); void view; }, patch);
  await mode({ graphEditorOpen: true }); for (const key of ['Space', 'Delete', 'ArrowRight', 'm', 'Control+B', '+']) await page.keyboard.press(key);
  expect(await intents(page)).toEqual([]); expect(await playhead(page)).toBe(0); expect(await viewState(page, v => v.zoom)).toBe(0.1);
  await mode({ smartMask: true }); for (const key of ['Space', 'Delete', '+', '-']) await page.keyboard.press(key);
  expect(await intents(page)).toEqual([]); expect(await viewState(page, v => v.zoom)).toBe(0.1); await page.keyboard.press('ArrowRight'); expect((await intents(page)).map(l => l.intent.type)).toEqual(['nudgeItems']); // the rest follows the normal map (an item is selected: nudge)
});

test('E6 Ctrl+Shift+M asks "Clear all N markers?"; accepting reports one clearMarkers(N) → T03, dismissing does nothing; no markers → a notice, no dialog', async ({ page }) => {
  const { id, before } = await setup(page); const messages: string[] = []; let answer = false;
  page.on('dialog', d => { messages.push(d.message()); void (answer ? d.accept() : d.dismiss()); });
  await blurAll(page); await page.keyboard.press('Control+Shift+M'); await expect.poll(() => messages.length).toBe(1); expect(messages[0]).toBe('Clear all 2 markers?'); expect(await intents(page)).toEqual([]);
  expect((await liveDoc(page)).markers).toHaveLength(2); expect(await undoEntries(page)).toEqual([]); // dismissed: nothing changed
  // T03 (was: NOT_IMPLEMENTED notice, markers still there): accepting is ok:true, empties the markers and is one "Clear markers" step.
  answer = true; await page.keyboard.press('Control+Shift+M'); await expect.poll(async () => (await intents(page)).length).toBe(1);
  expect((await intents(page))[0]).toMatchObject({ intent: { type: 'clearMarkers', count: 2 }, outcome: { ok: true } });
  expect((await liveDoc(page)).markers).toEqual([]); expect(await undoEntries(page)).toEqual([{ label: 'Clear markers', source: 'user' }]); await expect(page.getByRole('option', { name: /^Marker at/ })).toHaveCount(0);
  await page.keyboard.press('Control+Z'); expect((await liveDoc(page)).markers.map((m: any) => m.id)).toEqual(['m1', 'm2']); expect(await undoEntries(page)).toEqual([]); // undo brings both back
  await focusOn(page, 'timeline'); await clearIntents(page); await page.keyboard.press('Meta+Shift+M'); await expect.poll(() => messages.length).toBe(3); await expect.poll(async () => (await liveDoc(page)).markers.length).toBe(0); expect(await types(page)).toEqual(['clearMarkers']); // once from the timeline too
  expect(await undoEntries(page)).toEqual([{ label: 'Clear markers', source: 'user' }]); await expect(page.getByRole('option', { name: /^Marker at/ })).toHaveCount(0);
  const saved = await savedDoc(page, id); expect(saved.markers).toEqual([]); expect(saved.rev).toBeGreaterThan(before.rev);
});

test('E6 with no markers there is no dialog, only a notice', async ({ page }) => {
  await setup(page, richDoc({ markers: [] })); let dialogs = 0; page.on('dialog', d => { dialogs++; void d.dismiss(); });
  await blurAll(page); await page.keyboard.press('Control+Shift+M'); await expect(notices(page)).toContainText('There are no markers to clear.'); expect(dialogs).toBe(0); expect(await intents(page)).toEqual([]);
});

test('E1 keys act once on a grouped project too (the timeline root and window handlers do not both run)', async ({ page }) => {
  await setup(page, groupedDoc()); await clip(page, 'clipA').click();
  for (const key of ['m', 'Delete', 'Backspace', 'Control+Z', 'Control+C', 'Control+V']) { await clearIntents(page); await page.keyboard.press(key); expect((await intents(page)).length, key).toBeLessThanOrEqual(1); }
});
