// SPDX-License-Identifier: AGPL-3.0-only
// T17 ledger rows 2, 3, 5, 9 in the real editor: restore through the menu, the undo history after it, recovery checkpoints made by real undos / Delete, undo after reload.
import { test, expect } from '@playwright/test';
import { clip, skipTour } from './t02-support';
import { cpList, docWith, flushNow, historyRow, journalCount, liveIds, liveOf, norev, normJson, openMenu, openProject, RECOVERY, reopen, rows, run, saveButton, storedOf, undoButton, undoStack } from './t17-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });
const ALL = ['clipA', 'clipB', 'clipC', 'title', 'photo'];

/** Saves a checkpoint of the 5-item document, then deletes two clips and waits until that is autosaved and the history row exists. */
async function checkpointThenEdit(page: import('@playwright/test').Page, id: string) {
  await saveButton(page).click(); await expect.poll(async () => (await cpList(page, id)).length).toBe(1);
  const [cp] = await cpList(page, id); const atSave = await storedOf(page, id);
  await run(page, { type: 'deleteItems', itemIds: ['clipA'], ripple: false }); await run(page, { type: 'deleteItems', itemIds: ['photo'], ripple: false });
  await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 });
  await expect.poll(async () => (await historyRow(page, id))?.undo.length).toBe(2);
  return { cp, atSave };
}

for (const parity of [true, false]) {
  const mode = parity ? 'parity' : 'default';
  test(`L2/F2 + L3 (${mode}): restoring the checkpoint from the menu rewrites the stored document (rev + 1, byte-identical, no journal row) within ~1 s and leaves the list as it was`, async ({ page }) => {
    const id = await openProject(page, docWith(ALL), parity);
    const { cp, atSave } = await checkpointThenEdit(page, id);
    expect(await liveIds(page)).toEqual(['clipB', 'clipC', 'title']);
    const pre = await storedOf(page, id), listBefore = await cpList(page, id); await page.waitForTimeout(1200); const journalBefore = await journalCount(page, id);

    await openMenu(page); const t0 = Date.now(); await rows(page).first().click();
    await expect(clip(page, 'clipA')).toBeVisible({ timeout: 4000 }); const took = Date.now() - t0;
    await expect(page.getByRole('status')).toHaveText('Saved locally'); await expect(menu_closed(page)).toHaveCount(0);
    expect(took).toBeLessThan(2500); // "within about 1 s"; the margin is for the shared dev server
    const stored = await storedOf(page, id);
    expect(stored.rev).toBe(pre.rev + 1); expect(normJson(stored)).toBe(normJson(cp.editorState)); expect(normJson(stored)).toBe(normJson(atSave));
    expect(await liveIds(page)).toEqual(ALL); expect(norev(await liveOf(page))).toEqual(norev(stored)); expect((await liveOf(page)).rev).toBe(stored.rev);
    expect(await cpList(page, id)).toEqual(listBefore); // unchanged
    await page.waitForTimeout(1500); expect(await journalCount(page, id)).toBe(journalBefore); // a restore is not a command

    if (parity) {
      await expect(undoButton(page)).toBeDisabled(); expect(await undoStack(page)).toEqual([]);
      expect(await historyRow(page, id)).toBeUndefined();
    } else {
      await expect(undoButton(page)).toBeEnabled(); expect(await undoStack(page)).toEqual([{ label: 'Restore checkpoint', source: 'user' }]);
      await undoButton(page).click(); // one step back to the exact pre-restore state
      await expect(clip(page, 'clipA')).toHaveCount(0); expect(await liveIds(page)).toEqual(['clipB', 'clipC', 'title']);
      expect(norev(await liveOf(page))).toEqual(norev(pre)); expect(await undoStack(page)).toEqual([]); await expect(undoButton(page)).toBeDisabled();
    }
  });
}

/** After a restore the menu must be closed (the editor was reopened). */
const menu_closed = (page: import('@playwright/test').Page) => page.getByRole('menu', { name: 'Checkpoints' });

test('L9 undo after a reload works, and after a restore too (default mode)', async ({ page }) => {
  const id = await openProject(page, docWith(ALL), false);
  // Plain case: edit, let the history persist, reload, Undo is enabled and restores the original.
  const original = await storedOf(page, id);
  await run(page, { type: 'deleteItems', itemIds: ['clipA'], ripple: false });
  await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 }); await expect.poll(async () => (await historyRow(page, id))?.undo.length).toBe(1);
  await reopen(page, id); await expect(clip(page, 'clipB')).toBeVisible();
  await expect(undoButton(page)).toBeEnabled(); expect(await undoStack(page)).toEqual([{ label: 'Delete items', source: 'user' }]);
  await undoButton(page).click(); await expect(clip(page, 'clipA')).toBeVisible(); expect(norev(await liveOf(page))).toEqual(norev(original));

  // After a restore: Save a checkpoint (5 items), delete, restore, reload → the restore step is still there and undoes to the pre-restore state.
  await saveButton(page).click(); await expect.poll(async () => (await cpList(page, id)).length).toBe(1);
  await run(page, { type: 'deleteItems', itemIds: ['title'], ripple: false }); await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 });
  const pre = await storedOf(page, id);
  await openMenu(page); await rows(page).first().click(); await expect(clip(page, 'title')).toBeVisible({ timeout: 4000 }); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect.poll(async () => (await historyRow(page, id))?.undo.map(e => e.label)).toEqual(['Restore checkpoint']);
  await reopen(page, id); await expect(clip(page, 'title')).toBeVisible();
  await expect(undoButton(page)).toBeEnabled(); expect(await undoStack(page)).toEqual([{ label: 'Restore checkpoint', source: 'user' }]);
  await undoButton(page).click(); await expect(clip(page, 'title')).toHaveCount(0); expect(norev(await liveOf(page))).toEqual(norev(pre));
});

test('L9 parity: after a restore and a reload Undo stays disabled', async ({ page }) => {
  const id = await openProject(page, docWith(ALL), true);
  await checkpointThenEdit(page, id);
  await openMenu(page); await rows(page).first().click(); await expect(clip(page, 'clipA')).toBeVisible({ timeout: 4000 }); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await reopen(page, id); await page.waitForTimeout(1200); await expect(undoButton(page)).toBeDisabled(); expect(await undoStack(page)).toEqual([]);
});

for (const parity of [true, false]) {
  const mode = parity ? 'parity' : 'default';
  test(`L5/F4 (${mode}): 4→2 by two real undos and 2→1 by Delete each write a recovery checkpoint of the state before the drop, in the same save`, async ({ page }) => {
    const id = await openProject(page, docWith(['title', 'photo']), parity);
    // Manual checkpoints M1..M3 first (parity: they share the 3 slots; default: they have their own).
    for (let k = 1; k <= 3; k++) { await saveButton(page).click(); await expect.poll(async () => (await cpList(page, id)).length).toBe(k); }
    const manual = await cpList(page, id); expect(manual.map(c => c.label)).toEqual([undefined, undefined, undefined]);
    // 2 → 4 items in two steps (each a duplicate), saved; then two undos take it back to 2 before the debounce fires.
    await run(page, { type: 'duplicateItems', itemIds: ['title'] }); await run(page, { type: 'duplicateItems', itemIds: ['title'] }); // 'photo' sits on a track that refuses duplicates (TRACK_INCOMPATIBLE), so duplicate 'title' twice
    await flushNow(page); expect(await liveIds(page)).toHaveLength(4);
    const r4 = (await storedOf(page, id)).rev, state4 = await storedOf(page, id);
    expect((await cpList(page, id)).map(c => c.id)).toEqual(manual.map(c => c.id)); // saving 2 → 4 wrote nothing
    await run(page, { type: 'undo' }); await run(page, { type: 'undo' }); expect(await liveIds(page)).toHaveLength(2);
    await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 }); // the natural autosave
    let list = await cpList(page, id); const a1 = list[0];
    expect(a1.label).toBe(RECOVERY); expect(a1.rev).toBe(r4); expect(normJson(a1.editorState)).toBe(normJson(state4)); expect(a1.editorState.items).toHaveLength(4);
    expect(Object.keys(a1).sort()).toEqual(['editorState', 'id', 'label', 'rev', 'timestamp']);
    expect((await storedOf(page, id)).items).toHaveLength(2); expect((await storedOf(page, id)).rev).toBe(r4 + 1);
    // 2 → 1 by Delete.
    await run(page, { type: 'deleteItems', itemIds: [(await liveIds(page))[0]], ripple: false }); await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 });
    list = await cpList(page, id); const a2 = list[0];
    expect(a2.label).toBe(RECOVERY); expect(a2.rev).toBe(r4 + 1); expect(a2.editorState.items).toHaveLength(2); expect((await storedOf(page, id)).items).toHaveLength(1);
    if (parity) expect(list.map(c => c.id)).toEqual([a2.id, a1.id, manual[0].id]); // [A2, A1, M3]
    else expect(list.map(c => c.id)).toEqual([a2.id, a1.id, ...manual.map(c => c.id)]); // own slots: all manual kept
    // The menu shows them after a reload (parity's list is read once per open).
    await reopen(page, id); await openMenu(page); await expect(rows(page)).toHaveCount(list.length);
    await expect(rows(page).first()).toContainText(RECOVERY);
  });
}
