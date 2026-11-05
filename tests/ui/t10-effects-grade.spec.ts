// SPDX-License-Identifier: AGPL-3.0-only
// T10 Effects UI, wave-3 fixture (A) and T02 G1 on the real Color card (C): picker add, a 12-move real-pointer drag, the agent
// path (`writeEffects`) giving the same stored instance, and Exposure -3…3 (plain click nothing; 100 px = +1.85, Shift = +0.20;
// typed -99 / 999 clamp, 'abc' ignored), one "Edit items" undo entry per gesture. Oracle: part 3 §46.6 W3-ED-24, part 4 §49.1.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { clip, openEditor, richDoc, skipTour } from './t02-support';
import { itemById, liveDoc, undoEntries } from './t03-support';

test.describe.configure({ mode: 'parallel' });
test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1400, height: 900 }); });

const INSTANCE = /^effect_\d+_\w{9}$/;
async function openEffects(page: Page, itemId: string) {
  await openEditor(page, richDoc()); await clip(page, itemId).click();
  const panel = page.getByRole('complementary', { name: 'Inspector and tools' }); await panel.getByRole('tab', { name: 'Effects' }).click(); return panel;
}
const effectsOf = async (page: Page, itemId: string) => (itemById(await liveDoc(page), itemId).effects ?? []) as any[];
const entries = async (page: Page) => (await undoEntries(page)).length;
const agent = (page: Page, name: string, args: unknown) => page.evaluate(async ({ name, args }) => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); return activeRuntime.call(name, args); }, { name, args });
const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
/** A real-pointer relative drag in `moves` equal steps (integer client x, so the total is exact). */
async function drag(page: Page, l: Locator, dx: number, moves = 12, shift = false) {
  const c = await centre(l); await page.mouse.move(c.x, c.y); if (shift) await page.keyboard.down('Shift'); await page.mouse.down();
  for (let n = 1; n <= moves; n++) await page.mouse.move(Math.round(c.x + dx * n / moves), c.y);
  await page.mouse.up(); if (shift) await page.keyboard.up('Shift');
}

test('A wave-3 fixture: picker "Add Grayscale" is one "Edit items" entry with the stored instance; a 12-move drag of Amount to 41 is one more entry', async ({ page }) => {
  const panel = await openEffects(page, 'clipA'); const before = await entries(page);
  await expect(panel.getByText('No effects applied. Drag an effect from the sidebar or use + Add Effect.')).toBeVisible();
  await panel.getByRole('button', { name: '+ Add Effect' }).click();
  const picker = page.getByRole('dialog', { name: 'Add Effect' }); await picker.getByRole('button', { name: 'Grayscale', exact: true }).click(); await expect(picker).toHaveCount(0);
  const card = panel.getByRole('region', { name: 'Grayscale', exact: true }); await expect(card).toBeVisible();
  expect(await undoEntries(page)).toHaveLength(before + 1); expect((await undoEntries(page)).at(-1)).toMatchObject({ label: 'Edit items' });
  const fx = await effectsOf(page, 'clipA'); expect(fx).toHaveLength(1);
  expect(fx[0]).toEqual({ id: expect.stringMatching(INSTANCE), effectId: 'grayscale', enabled: true, order: 0, parameters: { amount: { defaultValue: 100, keyframes: [] } } });

  const amount = card.getByRole('slider', { name: 'Amount', exact: true }); await expect(amount).toHaveAttribute('aria-valuenow', '100');
  await drag(page, amount, -191, 12); // 100 px of travel = 30.86 %: -191 px from 100 lands on 41
  await expect(amount).toHaveAttribute('aria-valuenow', '41');
  expect(await entries(page)).toBe(before + 2); expect((await undoEntries(page)).at(-1)).toMatchObject({ label: 'Edit items' });
  const after = await effectsOf(page, 'clipA'); expect(after).toHaveLength(1);
  expect(after[0].parameters.amount).toEqual({ defaultValue: 41, keyframes: [] }); expect(Number.isInteger(after[0].parameters.amount.defaultValue)).toBe(true);
});

test('A the agent path (`writeEffects`) on a fresh item stores the same instance apart from the id', async ({ page }) => {
  await openEffects(page, 'clipA');
  const ui = page.getByRole('complementary', { name: 'Inspector and tools' });
  await ui.getByRole('button', { name: '+ Add Effect' }).click(); await page.getByRole('dialog', { name: 'Add Effect' }).getByRole('button', { name: 'Grayscale', exact: true }).click();
  const viaUi = (await effectsOf(page, 'clipA'))[0];
  const before = await entries(page);
  const r = await agent(page, 'writeEffects', { itemId: 'clipB', add: [{ effectId: 'grayscale' }] }) as any;
  expect(r).toMatchObject({ success: true, data: { items: [{ itemId: 'clipB', added: ['grayscale_1'] }] } });
  expect(await entries(page)).toBe(before + 1);
  const viaAgent = (await effectsOf(page, 'clipB')); expect(viaAgent).toHaveLength(1);
  expect(viaAgent[0].id).toMatch(INSTANCE); expect({ ...viaAgent[0], id: '' }).toEqual({ ...viaUi, id: '' });
  expect(viaAgent[0].id).not.toBe(viaUi.id);
});

test('C T02 G1 on the real Color card: plain click nothing; 100 px = Exposure 1.85, typed -99 / 999 clamp to -3 / 3, abc ignored; one entry per gesture', async ({ page }) => {
  const panel = await openEffects(page, 'clipA'); const card = panel.getByRole('region', { name: 'Color', exact: true });
  const exposure = card.getByRole('slider', { name: 'Exposure', exact: true }), field = card.getByLabel('Exposure value'); const base = await entries(page);
  await expect(exposure).toHaveAttribute('aria-valuemin', '-3'); await expect(exposure).toHaveAttribute('aria-valuemax', '3'); await expect(exposure).toHaveAttribute('aria-valuenow', '0');
  const c = await centre(exposure); await page.mouse.click(c.x + 60, c.y);
  expect(await entries(page)).toBe(base); expect(await effectsOf(page, 'clipA')).toHaveLength(0); await expect(exposure).toHaveAttribute('aria-valuenow', '0'); // a plain click creates no grade

  await drag(page, exposure, 100, 20); await expect(exposure).toHaveAttribute('aria-valuenow', '1.85');
  let fx = await effectsOf(page, 'clipA'); expect(fx).toHaveLength(1); expect(fx[0]).toMatchObject({ effectId: 'color-wheels', enabled: true, order: 0 });
  const exp = fx[0].parameters.exposure.defaultValue; expect(Math.abs(exp - 1.85)).toBeLessThanOrEqual(0.05); expect(exp).toBe(1.85);
  expect(await entries(page)).toBe(base + 1); expect((await undoEntries(page)).at(-1)).toMatchObject({ label: 'Edit items' });

  await exposure.dblclick(); await field.fill('-99'); await field.press('Enter');
  await expect(exposure).toHaveAttribute('aria-valuenow', '-3'); expect(await entries(page)).toBe(base + 2);
  await exposure.dblclick(); await field.fill('999'); await field.press('Enter');
  await expect(exposure).toHaveAttribute('aria-valuenow', '3'); expect(await entries(page)).toBe(base + 3);
  await exposure.dblclick(); await field.fill('abc'); await field.press('Enter'); await expect(field).toHaveCount(0);
  await expect(exposure).toHaveAttribute('aria-valuenow', '3'); expect(await entries(page)).toBe(base + 3); // ignored: no entry
  fx = await effectsOf(page, 'clipA'); expect(fx).toHaveLength(1); expect(fx[0].parameters.exposure).toEqual({ defaultValue: 3, keyframes: [] });
});

test('C Shift drag on Exposure is +0.20, one entry; Alt and Ctrl are plain', async ({ page }) => {
  const panel = await openEffects(page, 'clipB'); const exposure = panel.getByRole('region', { name: 'Color', exact: true }).getByRole('slider', { name: 'Exposure', exact: true });
  const base = await entries(page);
  await drag(page, exposure, 100, 20, true); await expect(exposure).toHaveAttribute('aria-valuenow', '0.2');
  const exp = (await effectsOf(page, 'clipB'))[0].parameters.exposure.defaultValue; expect(Math.abs(exp - 0.2)).toBeLessThanOrEqual(0.05); expect(exp).toBe(0.2);
  expect(await entries(page)).toBe(base + 1);
  await page.keyboard.down('Alt'); await drag(page, exposure, -100, 20); await page.keyboard.up('Alt'); // Alt is a plain drag: back to 0.2 - 1.85
  await expect(exposure).toHaveAttribute('aria-valuenow', '-1.65'); expect(await entries(page)).toBe(base + 2);
});
