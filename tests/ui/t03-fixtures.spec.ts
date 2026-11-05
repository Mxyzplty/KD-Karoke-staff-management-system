// SPDX-License-Identifier: AGPL-3.0-only
// T03 acceptance, ticket fixtures 5, 10, 11, 12 and 13 (findings part 3 §45.1-§45.4, W3-RT-06, W3-RT-13, W3-RT-15, W3-RT-17) plus the key shortcuts,
// run in real Chromium against the real document, undo stack and journal. Expected values are the oracle's rules, not source output.
import { test, expect, type Page } from '@playwright/test';
import { clearIntents, clip, createProject, intents, openEditor, richDoc, setViewState, skipTour, stored, viewState, watchIntents, expectUntouched } from './t02-support';
import { itemById, journalRows, liveDoc, savedDoc, spanOf, undoEntries } from './t03-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 2600, height: 900 }); });

const FRAME = 1000 / 30;
const norev = (d: any) => ({ ...d, rev: 0 });
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Timeline' });
const header = (page: Page, name: string) => page.locator('.track-row').filter({ has: page.locator('.track-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.track-header');
const trackRow = (page: Page, trackId: string) => page.locator('.track-row').filter({ has: page.locator(`[data-track-id="${trackId}"]`) });
const lastIntent = async (page: Page) => (await intents(page)).at(-1)!;
const centre = async (locator: ReturnType<Page['locator']>) => { const b = (await locator.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
async function dragBy(page: Page, from: { x: number; y: number }, dx: number) {
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + dx / 2, from.y, { steps: 8 }); await page.mouse.move(from.x + dx, from.y, { steps: 8 }); await page.mouse.up();
}
const vtrack = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1, ...extra });
const vclip = (id: string, trackId: string, from: number, to: number) => ({ id, type: 'video', trackId, display: { from, to }, trim: { from: 0, to: to - from }, sourceDuration: to - from, details: { name: id } });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- Fixture 5: track header (W3-RT-06, W3-CC-03) -------------------------------------------------------------------------------------------------
test('fixture 5: rename = 1 "Rename track"; hide / mute / solo / lock on then off = 8 "Set track flag"; volume 100 to 50 % = 1 "Set track volume" (stored 0.5); lane height +80 from 56 = 1 "Resize track" (stored 120)', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const original = await liveDoc(page), h = header(page, 'V1');
  expect(original.tracks.find((t: any) => t.id === 'v1').height).toBeUndefined(); // default row height 56
  await h.locator('.track-name').dblclick(); await page.getByLabel('Track name').fill('Narration'); await page.getByLabel('Track name').press('Enter');
  expect(await undoEntries(page)).toEqual([{ label: 'Rename track', source: 'user' }]); expect((await liveDoc(page)).tracks.find((t: any) => t.id === 'v1').name).toBe('Narration');
  const hn = header(page, 'Narration');
  for (const [name, flag] of [['Hide Narration', 'hidden'], ['Mute Narration', 'muted'], ['Solo Narration', 'solo'], ['Lock Narration', 'locked']]) {
    const button = hn.getByRole('button', { name, exact: true }); await button.click(); expect((await liveDoc(page)).tracks.find((t: any) => t.id === 'v1')[flag], `${flag} on`).toBe(true);
    await button.click(); expect((await liveDoc(page)).tracks.find((t: any) => t.id === 'v1')[flag], `${flag} off`).toBeFalsy();
  }
  expect((await undoEntries(page)).slice(1)).toEqual(Array.from({ length: 8 }, () => ({ label: 'Set track flag', source: 'user' })));
  // Volume 100 -> 50 %: one pointer drag on the slider thumb, committed on release (one entry for the gesture).
  const before = (await undoEntries(page)).length, slider = hn.getByRole('slider', { name: 'Narration volume' }), sb = (await slider.boundingBox())!;
  await page.mouse.move(sb.x + sb.width - 1, sb.y + sb.height / 2); await page.mouse.down(); await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2, { steps: 10 }); await page.mouse.up();
  const entries = await undoEntries(page); expect(entries.slice(before), 'one "Set track volume" for the whole drag').toEqual([{ label: 'Set track volume', source: 'user' }]);
  expect((await liveDoc(page)).tracks.find((t: any) => t.id === 'v1').volume).toBeCloseTo(0.5, 1);
  // Lane height +80 px from 56 stores 120 (start + delta, clamped to 36-120).
  const row = trackRow(page, 'v1'), handle = row.locator('.resize-handle'); await handle.scrollIntoViewIfNeeded(); const hb = (await handle.boundingBox())!, x = hb.x + hb.width / 2, y = hb.y + hb.height / 2;
  const count = (await undoEntries(page)).length; await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 80, { steps: 6 }); await page.mouse.up();
  expect((await undoEntries(page)).slice(count)).toEqual([{ label: 'Resize track', source: 'user' }]); expect((await liveDoc(page)).tracks.find((t: any) => t.id === 'v1').height).toBe(120);
  const all = (await undoEntries(page)).map(e => e.label); expect(all).toHaveLength(1 + 8 + 1 + 1);
  // Saved, journalled (one record per entry), and eleven real undos restore the original document.
  const saved = await savedDoc(page, id); expect(saved.tracks.find((t: any) => t.id === 'v1')).toMatchObject({ name: 'Narration', height: 120 });
  await expect.poll(async () => (await journalRows(page, id)).length, { timeout: 12000 }).toBe(11); expect((await journalRows(page, id)).map(r => r.label)).toEqual(all);
  for (let n = 0; n < 11; n++) await page.keyboard.press('Control+Z');
  expect(await undoEntries(page)).toEqual([]); expect(norev(await liveDoc(page))).toEqual(norev(original));
});

// ---- Fixture 10: ripple reorder (W3-RT-13, part 3 §45.4 table) --------------------------------------------------------------------------------------
const reorderDoc = () => richDoc({
  duration: 30000, tracks: [vtrack('v1')], layerOrder: [{ type: 'track', id: 'v1' }], markers: [],
  items: [vclip('A', 'v1', 0, 8000), vclip('B', 'v1', 8000, 16000), vclip('C', 'v1', 16000, 30000)],
});
async function reorderSetup(page: Page) {
  const id = await openEditor(page, reorderDoc()); await watchIntents(page); await toolbar(page).getByRole('button', { name: 'Ripple', exact: true }).click();
  await setViewState(page, { zoom: 0.05, scroll: 0 }); expect(await viewState(page, v => v.zoom as number)).toBe(0.05);
  expect(await viewState(page, v => v.toolMode)).toBe('ripple'); return id;
}
test('fixture 10: ripple on, A 0-8 / B 8-16 / C 16-30 s, A released within 12 px of B\'s end cut -> B 0-8, A 8-16, C 16-30 (+/- 1 frame), ids kept, 1 "Ripple reorder"', async ({ page }) => {
  const id = await reorderSetup(page); const original = await liveDoc(page);
  // A's centre is at 4 s; B's end cut is at 16 s = 12 s x 0.05 = 600 px further right. Release 8 px past the cut (inside the 12 px window).
  await dragBy(page, await centre(clip(page, 'A')), 608);
  expect(await undoEntries(page)).toEqual([{ label: 'Ripple reorder', source: 'user' }]);
  const doc = await liveDoc(page);
  expect(doc.items.map((i: any) => i.id).sort()).toEqual(['A', 'B', 'C']); // ids kept, nothing created or removed
  for (const [itemId, from, to] of [['B', 0, 8000], ['A', 8000, 16000], ['C', 16000, 30000]] as const) { const [f, t] = spanOf(doc, itemId)!; expect(Math.abs(f - from), `${itemId} start`).toBeLessThanOrEqual(FRAME); expect(Math.abs(t - to), `${itemId} end`).toBeLessThanOrEqual(FRAME); }
  expect(doc.items.every((i: any) => i.trackId === 'v1')).toBe(true); expect(doc.duration).toBe(30000);
  const l = await lastIntent(page); expect(l.intent).toMatchObject({ type: 'moveItems', itemIds: ['A'], ripple: true }); expect(l.outcome).toEqual({ ok: true });
  const saved = await savedDoc(page, id); expect(spanOf(saved, 'A')![0]).toBeCloseTo(8000, -2);
  await expect.poll(async () => (await journalRows(page, id)).map(r => r.label), { timeout: 10000 }).toEqual(['Ripple reorder']);
  expect((await journalRows(page, id))[0]).toMatchObject({ project_id: id, source: 'user', label: 'Ripple reorder', items_before: 3, items_after: 3 });
  await page.keyboard.press('Control+Z'); expect(await undoEntries(page)).toEqual([]); expect(norev(await liveDoc(page))).toEqual(norev(original));
});

for (const dx of [480, 760, 900, 1150]) {
  test(`fixture 10: A released ${dx} px to the right, away from any cut -> the clip snaps back: no change and no entry`, async ({ page }) => {
    const id = await reorderSetup(page); const original = await liveDoc(page), start = await centre(clip(page, 'A'));
    await dragBy(page, start, dx);
    expect(await undoEntries(page), `+${dx} px: no undo entry`).toEqual([]); expect(norev(await liveDoc(page)), `+${dx} px: the document is unchanged`).toEqual(norev(original));
    await expect(clip(page, 'A')).toBeVisible(); expect((await journalRows(page, id)).length).toBe(0);
    await expectUntouched(page, id, await stored(page, id)); // nothing was saved either
  });
}

// ---- Fixture 11: toolbar Split of 3 -> 4 items = 1 "Split items" ----------------------------------------------------------------------------------
test('fixture 11: toolbar Split of a 3-item project makes 4 items as one "Split items" entry and one journal record (3 to 4); undo restores', async ({ page }) => {
  const doc3 = richDoc({ tracks: [vtrack('v1'), vtrack('v2')], layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'v2' }], markers: [], items: [vclip('s1', 'v1', 0, 8000), vclip('s2', 'v1', 8000, 16000), vclip('s3', 'v2', 2000, 6000)] });
  const id = await openEditor(page, doc3); await watchIntents(page); const original = await liveDoc(page); expect(original.items).toHaveLength(3);
  await setViewState(page, { playheadMs: 4000 }); await clip(page, 's1').click(); await toolbar(page).getByRole('button', { name: 'Split', exact: true }).click();
  const doc = await liveDoc(page); expect(doc.items).toHaveLength(4); expect(await undoEntries(page)).toEqual([{ label: 'Split items', source: 'user' }]);
  const left = itemById(doc, 's1'), right = doc.items.find((i: any) => i.trackId === 'v1' && i.id !== 's1' && i.display.from === 4000);
  expect(left.display).toEqual({ from: 0, to: 4000 }); expect(right.display).toEqual({ from: 4000, to: 8000 }); expect(right.id).not.toBe('s1');
  expect(left.trim).toEqual({ from: 0, to: 4000 }); expect(right.trim).toEqual({ from: 4000, to: 8000 }); // the right half starts where the left ends in the source
  expect((await lastIntent(page)).outcome).toEqual({ ok: true });
  const saved = await savedDoc(page, id); expect(saved.items).toHaveLength(4);
  await expect.poll(async () => (await journalRows(page, id)).length, { timeout: 10000 }).toBe(1); expect((await journalRows(page, id))[0]).toMatchObject({ project_id: id, source: 'user', label: 'Split items', items_before: 3, items_after: 4 });
  await toolbar(page).getByRole('button', { name: 'Undo', exact: true }).click(); // the toolbar control: Ctrl+Z is ignored while a toolbar button holds focus
  expect(await undoEntries(page)).toEqual([]); expect(norev(await liveDoc(page))).toEqual(norev(original));
});

// ---- Fixture 12: journal records and timing ---------------------------------------------------------------------------------------------------
test('fixture 12: each entry gives one journal record {project_id, session_id, source, label, items_before, items_after, seq, client_ts}, written about 4 s after the edit (+/- 0.5 s) and after the ~3 s document save; Undo / Redo get records too', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const original = await liveDoc(page), n0 = original.items.length;
  const t0 = Date.now(); await clip(page, 'clipA').click(); await page.keyboard.press('Delete'); const edited = Date.now();
  expect((await liveDoc(page)).items).toHaveLength(n0 - 1);
  await expect.poll(async () => (await storedDoc2(page, id)).items.length, { intervals: [50], timeout: 8000 }).toBe(n0 - 1); const savedAt = Date.now() - edited;
  expect((await journalRows(page, id)).length, 'the journal is not written yet when the document has just been saved').toBe(0);
  await expect.poll(async () => (await journalRows(page, id)).length, { intervals: [50], timeout: 8000 }).toBe(1); const journalAt = Date.now() - edited;
  expect(savedAt, `document save about 3 s after the edit (${savedAt} ms)`).toBeGreaterThan(2500); expect(savedAt).toBeLessThan(3700);
  expect(journalAt, `journal record about 4 s after the edit (${journalAt} ms)`).toBeGreaterThan(3500); expect(journalAt).toBeLessThan(4500); expect(journalAt).toBeGreaterThan(savedAt);
  const [row] = await journalRows(page, id);
  expect(row).toMatchObject({ project_id: id, source: 'user', label: 'Delete items', items_before: n0, items_after: n0 - 1, seq: 1 });
  expect(typeof row.session_id).toBe('string'); expect(row.session_id.length).toBeGreaterThan(0); expect(row.id).toBe(`journal:${id}:${row.session_id}:1`);
  expect(Math.abs(Date.parse(row.client_ts) - t0)).toBeLessThan(5000); expect(new Date(row.client_ts).toISOString()).toBe(row.client_ts); // an ISO timestamp of the edit
  // Undo and Redo are journalled too, with the item counts on each side; the session id stays and seq counts up.
  await page.keyboard.press('Control+Z'); await page.keyboard.press('Control+Shift+Z');
  await expect.poll(async () => (await journalRows(page, id)).length, { timeout: 8000 }).toBe(3);
  const rows = await journalRows(page, id); expect(rows.map(r => r.seq)).toEqual([1, 2, 3]); expect(new Set(rows.map(r => r.session_id)).size).toBe(1);
  expect(rows[1]).toMatchObject({ label: 'Undo', items_before: n0 - 1, items_after: n0 }); expect(rows[2]).toMatchObject({ label: 'Redo', items_before: n0, items_after: n0 - 1 });
  expect(rows.every(r => ['user', 'agent'].includes(r.source))).toBe(true);
});
const storedDoc2 = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return JSON.parse(JSON.stringify((await projectStore.read(id)).document)) as any; }, id);

// ---- Fixture 13: no-entry actions (W3-RT-17; the Pause click: T15) ------------------------------------------------------------------------------
test('fixture 13: a Slip tool click (and back), a Play then Pause click and the first click on a clip with nothing selected write nothing: 0 undo entries, 0 journal records, no save, no network request', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id), requests: string[] = [];
  expect(await viewState(page, v => v.selection)).toEqual([]);
  page.on('request', r => requests.push(`${r.method()} ${r.url()}`));
  const bar = toolbar(page), slip = bar.getByRole('button', { name: 'Slip', exact: true });
  await expect(slip).toHaveAttribute('aria-pressed', 'false'); await slip.click(); await expect(slip).toHaveAttribute('aria-pressed', 'true'); expect(await viewState(page, v => v.toolMode)).toBe('slip');
  await slip.click(); await expect(slip).toHaveAttribute('aria-pressed', 'false'); expect(await viewState(page, v => v.toolMode)).toBe('select'); // a second click switches back
  await bar.getByRole('button', { name: 'Play', exact: true }).click(); await bar.getByRole('button', { name: 'Pause', exact: true }).click(); await expect(bar.getByRole('button', { name: 'Play', exact: true })).toBeVisible(); // T15: the Pause click
  for (const name of ['Delete', 'Split', 'Clone']) await expect(bar.getByRole('button', { name, exact: true }), `${name} is disabled with nothing selected`).toBeDisabled();
  await clip(page, 'clipA').click(); // the first click selects at once
  expect(await viewState(page, v => v.selection)).toEqual(['clipA']);
  for (const name of ['Delete', 'Split', 'Clone']) await expect(bar.getByRole('button', { name, exact: true }), `${name} enabled after the click`).toBeEnabled();
  await expect(page.getByRole('complementary', { name: 'Inspector and tools' }).getByRole('tab', { name: 'Properties' })).toBeVisible();
  await wait(5500); // longer than the 4 s journal flush and the 3 s autosave
  expect(await undoEntries(page)).toEqual([]); expect(await journalRows(page, id)).toEqual([]); expect(requests, 'no network request at all').toEqual([]);
  expect((await intents(page)).filter(l => !['selectItems', 'setToolMode', 'select'].includes(l.intent.type) && l.outcome.ok === false)).toEqual([]);
  await expectUntouched(page, id, before);
});

// ---- Key shortcuts through the real document ----------------------------------------------------------------------------------------------------
test('keys: Ctrl+B splits at the playhead, Ctrl+D duplicates, an arrow nudges, Delete removes; each is one user entry and one real undo restores', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const original = await liveDoc(page);
  await setViewState(page, { playheadMs: 3000 }); await clip(page, 'clipB').click(); await setViewState(page, { playheadMs: 12000 });
  await page.keyboard.press('Control+B'); let doc = await liveDoc(page); expect(doc.items).toHaveLength(original.items.length + 1);
  expect(spanOf(doc, 'clipB')).toEqual([8000, 12000]);
  await clip(page, 'clipA').click(); await page.keyboard.press('Control+D'); doc = await liveDoc(page); expect(doc.items).toHaveLength(original.items.length + 2);
  await page.keyboard.press('ArrowRight'); doc = await liveDoc(page);
  await page.keyboard.press('Delete'); doc = await liveDoc(page);
  const labels = (await undoEntries(page)).map(e => e.label); expect(labels.slice(0, 2)).toEqual(['Split items', 'Duplicate items']); expect(labels.at(-1)).toBe('Delete items'); expect((await undoEntries(page)).every(e => e.source === 'user')).toBe(true);
  const n = labels.length; for (let i = 0; i < n; i++) await page.keyboard.press('Control+Z');
  expect(await undoEntries(page)).toEqual([]); expect(norev(await liveDoc(page))).toEqual(norev(original)); await savedDoc(page, id);
});
