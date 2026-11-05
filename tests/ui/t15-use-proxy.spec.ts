// SPDX-License-Identifier: AGPL-3.0-only
// T15 Use Proxy: the inspector switch and callTool('setUseProxy') are two paths to ONE edit (UI <-> tool parity).
// Written-spec oracle: findings §2 (details.useProxy picks proxy or original for the preview; default on), the T04/T15 brief
// (undo label "Edit items", same stored document and same history snapshots from both paths), results P12 refusal codes.
// PROVISIONAL (P12): Xapp has no Use Proxy tool, so the tool name, its argument names (itemId, useProxy) and the messages are our own.
import { test, expect, type Page } from '@playwright/test';
import { openEditor, skipTour } from './t02-support';
import { liveDoc, storedDoc, undoEntries, undoLabels } from './t03-support';
import { pick, runtimeCall, section, t04Doc } from './t04-support';

test.beforeEach(async ({ page }) => { await skipTour(page); });

const stripRev = (v: unknown): unknown => Array.isArray(v) ? v.map(stripRev) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'rev').map(([k, x]) => [k, stripRev(x)])) : v;
const itemOf = (doc: any, id: string) => doc.items.find((i: any) => i.id === id);
const history = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); return JSON.parse(JSON.stringify(activeRuntime.bus.undoStack.map((e: any) => ({ label: e.label, before: e.before, after: e.after })))) as any[]; });
const call = (page: Page, args: Record<string, unknown>) => runtimeCall(page, 'setUseProxy', args) as Promise<Record<string, any>>;
async function viaUi(page: Page, steps: boolean[]) {
  const id = await openEditor(page, t04Doc()); await pick(page, 'vid');
  const sw = (await section(page, 'Basic')).getByRole('switch', { name: 'Use Proxy' });
  for (const on of steps) { await expect(sw).toHaveAttribute('aria-checked', String(!on)); await sw.click(); await expect(sw).toHaveAttribute('aria-checked', String(on)); }
  return id;
}
async function viaTool(page: Page, steps: boolean[]) {
  const id = await openEditor(page, t04Doc());
  for (const on of steps) { const r = await call(page, { itemId: 'vid', useProxy: on }); expect(r).toMatchObject({ success: true, data: { itemId: 'vid', useProxy: on } }); }
  return id;
}
async function outcome(page: Page, id: string) {
  await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 });
  return { live: stripRev(await liveDoc(page)), stored: stripRev(await storedDoc(page, id)), labels: await undoLabels(page), history: stripRev(await history(page)) };
}

test('off: the switch and the tool store the same document, one "Edit items" entry with the same snapshots', async ({ page }) => {
  const ui = await outcome(page, await viaUi(page, [false]));
  const tool = await outcome(page, await viaTool(page, [false]));
  expect(itemOf(ui.live, 'vid').details.useProxy).toBe(false);
  expect(ui.labels).toEqual(['Edit items']); expect(tool.labels).toEqual(['Edit items']);
  expect(tool.live).toEqual(ui.live); expect(tool.stored).toEqual(ui.stored); expect(tool.history).toEqual(ui.history);
});

test('off then on: both paths agree on the stored value and on two undo entries', async ({ page }) => {
  const ui = await outcome(page, await viaUi(page, [false, true]));
  const tool = await outcome(page, await viaTool(page, [false, true]));
  expect(itemOf(ui.live, 'vid').details.useProxy).toBe(true);
  expect(ui.labels).toEqual(['Edit items', 'Edit items']); expect(tool.labels).toEqual(ui.labels);
  expect(tool.live).toEqual(ui.live); expect(tool.stored).toEqual(ui.stored); expect(tool.history).toEqual(ui.history);
});

test('turning it on when it is already on (default) changes nothing: success, no undo entry', async ({ page }) => {
  const id = await openEditor(page, t04Doc()), before = stripRev(await liveDoc(page));
  const r = await call(page, { itemId: 'vid', useProxy: true });
  expect(r).toMatchObject({ success: true, data: { itemId: 'vid', useProxy: true } });
  expect(await undoLabels(page)).toEqual([]); expect(stripRev(await liveDoc(page))).toEqual(before);
  expect(itemOf(await storedDoc(page, id), 'vid').details.useProxy).toBeUndefined();
});

test.describe('refusals leave the project untouched (P12 codes, provisional messages)', () => {
  const untouched = async (page: Page, before: unknown) => { expect(await undoEntries(page)).toEqual([]); expect(stripRev(await liveDoc(page))).toEqual(before); };

  test('ITEM_NOT_FOUND for an unknown item', async ({ page }) => {
    await openEditor(page, t04Doc()); const before = stripRev(await liveDoc(page));
    expect(await call(page, { itemId: 'nope', useProxy: false })).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND', error: 'Item not found', message: "Item 'nope' not found on timeline." });
    await untouched(page, before);
  });
  test('INVALID_ITEM_TYPE for image, audio and motion graphic items', async ({ page }) => {
    await openEditor(page, t04Doc()); const before = stripRev(await liveDoc(page));
    for (const [id, type] of [['img', 'image'], ['aud', 'audio'], ['mg', 'motionGraphic']]) {
      expect(await call(page, { itemId: id, useProxy: false }), id).toMatchObject({ success: false, code: 'INVALID_ITEM_TYPE', error: 'Invalid item type', message: `Use Proxy only applies to video items, but '${id}' is type '${type}'.` });
    }
    await untouched(page, before);
  });
  test('MISSING_PARAM when useProxy is not a boolean', async ({ page }) => {
    await openEditor(page, t04Doc()); const before = stripRev(await liveDoc(page));
    for (const args of [{ itemId: 'vid' }, { itemId: 'vid', useProxy: 'false' }, { itemId: 'vid', useProxy: 0 }, { itemId: 'vid', useProxy: null }]) {
      expect(await call(page, args), JSON.stringify(args)).toMatchObject({ success: false, code: 'MISSING_PARAM', error: 'useProxy (true or false) is required' });
    }
    await untouched(page, before);
  });
  test('TRACK_LOCKED when the item\'s track is locked', async ({ page }) => {
    const doc = t04Doc(); doc.tracks.find(t => t.id === 'v1')!.locked = true;
    await openEditor(page, doc); const before = stripRev(await liveDoc(page));
    expect(await call(page, { itemId: 'vid', useProxy: false })).toMatchObject({ success: false, code: 'TRACK_LOCKED', error: 'Track v1 is locked' });
    await untouched(page, before);
  });
});
