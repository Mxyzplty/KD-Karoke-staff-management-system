// SPDX-License-Identifier: AGPL-3.0-only
// T03: the undo history is persisted as the settings row `history:<projectId>` ({ id, at: fingerprint(doc), undo, redo }), saved 500 ms after a bus change,
// and restored on the next load ONLY when the loaded document is the state it ends at. (a) the happy path across a reload, (b) a document changed outside the bus.
import { test, expect, type Page } from '@playwright/test';
import { clip, openEditor, richDoc, skipTour, stored } from './t02-support';
import { liveDoc, savedDoc, undoEntries } from './t03-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

const norev = (d: any) => ({ ...d, rev: 0 });
const undoButton = (page: Page) => page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Undo', exact: true });
const historyRow = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.row('settings', `history:${id}`)) as { id: string; at: string; undo: { label: string; source: string }[]; redo: unknown[] } | undefined; }, id);
/** Deletes clipA through the real toolbar, then waits until the document is autosaved and the history row exists. */
async function editAndPersist(page: Page, id: string) {
  await clip(page, 'clipA').click(); await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Delete', exact: true }).click();
  expect(await undoEntries(page)).toEqual([{ label: 'Delete items', source: 'user' }]);
  await savedDoc(page, id); await expect.poll(() => historyRow(page, id), { timeout: 10000 }).toMatchObject({ id: `history:${id}`, undo: [{ label: 'Delete items', source: 'user' }], redo: [] });
}
const reload = async (page: Page, id: string) => { await page.goto(`/project/${id}`); await expect(clip(page, 'clipB')).toBeVisible(); };

test('persisted history (a): after a reload Undo is enabled and restores the original stored document', async ({ page }) => {
  const id = await openEditor(page, richDoc()); const original = JSON.parse((await stored(page, id)).json);
  await editAndPersist(page, id); await expect(clip(page, 'clipA')).toHaveCount(0);
  await reload(page, id);
  await expect(undoButton(page)).toBeEnabled(); expect(await undoEntries(page)).toEqual([{ label: 'Delete items', source: 'user' }]); await expect(clip(page, 'clipA')).toHaveCount(0); // the edit is the loaded state
  await undoButton(page).click();
  await expect(clip(page, 'clipA')).toBeVisible(); expect(norev(await liveDoc(page))).toEqual(norev(original)); expect(await undoEntries(page)).toEqual([]);
  await expect(page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled(); // the restored step moved to the redo stack
});

test('persisted history (b): a document changed outside the bus invalidates the saved history (Undo stays disabled, stacks empty)', async ({ page }) => {
  const id = await openEditor(page, richDoc());
  await editAndPersist(page, id);
  // Write a different document straight into the T01 store (what a second tab or an import would do), bypassing the bus and the history row.
  await page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); const r = await projectStore.read(id); await projectStore.save(id, { ...r.document, markers: [...r.document.markers, { id: 'outside', timeMs: 1234 }] }, r.document.rev); }, id);
  await reload(page, id);
  await page.waitForTimeout(1500); // the history row is read asynchronously on load; give a wrong restore the chance to show
  await expect(undoButton(page)).toBeDisabled(); expect(await undoEntries(page)).toEqual([]);
  expect((await liveDoc(page)).markers.map((m: any) => m.id)).toContain('outside'); await expect(clip(page, 'clipA')).toHaveCount(0);
});
