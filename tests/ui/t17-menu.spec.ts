// SPDX-License-Identifier: AGPL-3.0-only
// T17 ledger rows 1, 4, 5, 7, 8 in the real editor: the Save chevron menu "Restore Checkpoint", delete icon, recovery checkpoints, names.
import { test, expect } from '@playwright/test';
import { notices, skipTour } from './t02-support';
import { chevron, cpList, docWith, flushNow, menu, openMenu, openProject, RECOVERY, reopen, rows, run, saveButton, storedOf } from './t17-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

test('L7 menu: empty state, Save adds a row, delete icon removes it at once with no dialog (default mode)', async ({ page }) => {
  const dialogs: string[] = []; page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  const id = await openProject(page, docWith(['title', 'photo', 'clipA', 'clipB', 'clipC']), false);
  await openMenu(page);
  await expect(menu(page).getByText('Restore Checkpoint')).toBeVisible(); await expect(menu(page).getByText('No checkpoints saved yet')).toBeVisible(); await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0);

  await run(page, { type: 'deleteItems', itemIds: ['photo'], ripple: false }); // a small change, still unsaved when Save is pressed
  await saveButton(page).click();
  await expect.poll(async () => (await cpList(page, id)).length).toBe(1);
  const [cp] = await cpList(page, id); expect(Object.keys(cp).sort()).toEqual(['editorState', 'id', 'timestamp']); expect(cp.editorState.items.map((i: any) => i.id)).not.toContain('photo'); // Save flushed the change first
  expect(cp.editorState).toEqual(await storedOf(page, id));

  await openMenu(page); await expect(menu(page).getByText('No checkpoints saved yet')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('Checkpoint');
  const del = menu(page).getByRole('button', { name: /^Delete Checkpoint, / });
  await del.click(); // no confirmation: gone at once, menu stays open
  await expect(rows(page)).toHaveCount(0); await expect(menu(page).getByText('No checkpoints saved yet')).toBeVisible(); await expect(menu(page)).toBeVisible();
  await expect.poll(async () => (await cpList(page, id)).length).toBe(0);
  expect(dialogs).toEqual([]); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(notices(page)).not.toContainText('CHECKPOINT');
});

test('L7/L8 default menu: newest first, optional names via Rename, delete removes only that row', async ({ page }) => {
  const id = await openProject(page, docWith(['title', 'photo']), false);
  for (let k = 0; k < 3; k++) { await run(page, { type: 'addMarker', timeMs: 1000 * (k + 1) }); await saveButton(page).click(); await expect.poll(async () => (await cpList(page, id)).length).toBe(k + 1); }
  const list = await cpList(page, id); expect(list.map(c => c.editorState.markers.length)).toEqual([5, 4, 3]); // richDoc starts with 2 markers
  await openMenu(page); await expect(rows(page)).toHaveCount(3);
  // Rename the middle one: Enter commits, an empty name clears it (default mode only).
  const middle = menu(page).locator('.checkpoint-row').nth(1);
  await middle.getByRole('button', { name: /^Rename Checkpoint, / }).click();
  const input = menu(page).getByRole('textbox', { name: 'Name for Checkpoint' }); await input.fill('  Rough cut  '); await input.press('Enter');
  await expect(rows(page).nth(1)).toContainText('Rough cut'); await expect.poll(async () => (await cpList(page, id))[1].name).toBe('Rough cut');
  await menu(page).locator('.checkpoint-row').nth(1).getByRole('button', { name: /^Rename Rough cut, / }).click();
  const again = menu(page).getByRole('textbox', { name: 'Name for Rough cut' }); await again.fill(''); await again.press('Enter');
  await expect.poll(async () => (await cpList(page, id))[1]).not.toHaveProperty('name'); await expect(rows(page).nth(1)).toContainText('Checkpoint');
  // Delete the first row only.
  await menu(page).locator('.checkpoint-row').first().getByRole('button', { name: /^Delete Checkpoint, / }).click();
  await expect(rows(page)).toHaveCount(2); const left = await cpList(page, id); expect(left.map(c => c.id)).toEqual([list[1].id, list[2].id]);
});

test('L7/L5 default: an OPEN menu refreshes when a recovery checkpoint is written (separate slot, label shown)', async ({ page }) => {
  const id = await openProject(page, docWith(['clipA', 'clipB', 'clipC', 'title', 'photo']), false);
  await openMenu(page); await expect(rows(page)).toHaveCount(0);
  await run(page, { type: 'deleteItems', itemIds: ['clipA', 'clipB', 'clipC'], ripple: false }); // 5 → 2
  await flushNow(page);
  await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText(RECOVERY);
  const [a] = await cpList(page, id); expect(a.label).toBe(RECOVERY); expect(a.rev).toBe(0); expect(a.editorState.items).toHaveLength(5);
});

test('L7/L5 parity: the open list stays stale; the recovery checkpoint appears only after a page reload; no Rename button', async ({ page }) => {
  const id = await openProject(page, docWith(['clipA', 'clipB', 'clipC', 'title', 'photo']), true);
  await openMenu(page); await expect(menu(page).getByText('No checkpoints saved yet')).toBeVisible();
  await run(page, { type: 'deleteItems', itemIds: ['clipA', 'clipB', 'clipC'], ripple: false });
  await flushNow(page);
  await expect.poll(async () => (await cpList(page, id)).length).toBe(1); // written in the same save
  await page.waitForTimeout(800); // give a wrongly live list the chance to update
  await expect(rows(page)).toHaveCount(0); await expect(menu(page).getByText('No checkpoints saved yet')).toBeVisible();
  await page.keyboard.press('Escape'); await openMenu(page); await expect(rows(page)).toHaveCount(0); // closing and reopening the menu does not re-read it either
  await reopen(page, id); await openMenu(page);
  await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText(RECOVERY);
  await expect(menu(page).getByRole('button', { name: /^Rename / })).toHaveCount(0);
  await expect(menu(page).getByRole('button', { name: /^Delete / })).toHaveCount(1);
});

test('L7 parity: this tab\'s own Save and delete do update the open list', async ({ page }) => {
  const id = await openProject(page, docWith(['title', 'photo']), true);
  await openMenu(page); await expect(rows(page)).toHaveCount(0);
  await run(page, { type: 'saveCheckpoint' }); await expect(rows(page)).toHaveCount(1); // the Save button itself would click outside the open menu and close it
  await menu(page).getByRole('button', { name: /^Delete Checkpoint, / }).click(); await expect(rows(page)).toHaveCount(0);
  expect(await cpList(page, id)).toEqual([]);
});

test('L1/F1 parity via the UI: four Saves, each after a small change, keep the 3 newest in the menu (newest first)', async ({ page }) => {
  const id = await openProject(page, docWith(['title', 'photo']), true);
  const seen: string[][] = [];
  for (let k = 1; k <= 4; k++) {
    await run(page, { type: 'addMarker', timeMs: 500 * k }); await saveButton(page).click();
    await expect.poll(async () => (await cpList(page, id))[0]?.editorState.markers.length).toBe(k + 2); // richDoc has 2 markers already
    seen.push((await cpList(page, id)).map(c => c.id));
  }
  expect(seen.map(l => l.length)).toEqual([1, 2, 3, 3]);
  expect(seen[3]).toEqual([seen[3][0], seen[2][0], seen[1][0]]); // [S4, S3, S2]; S1 is gone
  expect(seen[3]).not.toContain(seen[0][0]);
  const list = await cpList(page, id);
  for (const c of list) expect(Object.keys(c).sort()).toEqual(['editorState', 'id', 'timestamp']);
  await openMenu(page); await expect(rows(page)).toHaveCount(3);
});

test('L6/F5 an autosave never writes a checkpoint (real 3 s debounce)', async ({ page }) => {
  const id = await openProject(page, docWith(['title', 'photo']), false);
  await saveButton(page).click(); await expect.poll(async () => (await cpList(page, id)).length).toBe(1); const before = await cpList(page, id);
  const rev = (await storedOf(page, id)).rev;
  await run(page, { type: 'addMarker', timeMs: 1111 }); await expect(page.getByRole('status')).toHaveText('Unsaved changes');
  await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 }); expect((await storedOf(page, id)).rev).toBe(rev + 1);
  await run(page, { type: 'addMarker', timeMs: 2222 }); await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 10000 }); expect((await storedOf(page, id)).rev).toBe(rev + 2);
  expect(await cpList(page, id)).toEqual(before);
});
