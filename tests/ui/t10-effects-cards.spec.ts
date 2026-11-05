// SPDX-License-Identifier: AGPL-3.0-only
// T10 Effects UI, card controls (D): enable switch, remove, reorder (keyboard and drag), rail add / drop / search, picker search and
// per-type lists, .cube load, colour swatch, wheel drag, Color card bypass / reset, parameter keyframes and their timeline marks.
// Each test keeps at most three effects on one clip (the headless preview slows with many). Oracle: part 3 §46.6, part 4 §49.1.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { clip, openEditor, richDoc, setViewState, skipTour } from './t02-support';
import { itemById, liveDoc, undoEntries } from './t03-support';

test.describe.configure({ mode: 'parallel' });
test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1400, height: 900 }); });

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector and tools' });
async function openEffects(page: Page, itemId: string) {
  await openEditor(page, richDoc()); await clip(page, itemId).click();
  const panel = inspector(page); await panel.getByRole('tab', { name: 'Effects' }).click(); return panel;
}
const effectsOf = async (page: Page, itemId: string) => (itemById(await liveDoc(page), itemId).effects ?? []) as any[];
const stackOf = async (page: Page, itemId: string) => (await effectsOf(page, itemId)).slice().sort((a, b) => a.order - b.order).map(e => e.effectId as string);
const entries = async (page: Page) => (await undoEntries(page)).length;
const agent = (page: Page, name: string, args: unknown) => page.evaluate(async ({ name, args }) => { const p = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(p); return activeRuntime.call(name, args); }, { name, args });
const addAll = (page: Page, itemId: string, ids: string[]) => agent(page, 'writeEffects', { itemId, add: ids.map(effectId => ({ effectId })) });
const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const card = (panel: Locator, name: string) => panel.getByRole('region', { name, exact: true });
const colour = (panel: Locator) => card(panel, 'Color');
async function openAdvanced(panel: Locator) { await colour(panel).locator('details.advanced > summary').click(); }
const blockOf = (fx: any[]) => fx.filter(e => ['color-wheels', 'curves', 'lut'].includes(e.effectId));

test('D enable switch, keyboard and drag reorder, remove: one "Edit items" entry each', async ({ page }) => {
  const panel = await openEffects(page, 'clipA');
  await addAll(page, 'clipA', ['grayscale', 'sepia', 'invert']);
  expect(await stackOf(page, 'clipA')).toEqual(['grayscale', 'sepia', 'invert']);
  let base = await entries(page);

  const sw = card(panel, 'Sepia').getByRole('switch', { name: 'Enable Sepia' });
  await expect(sw).toHaveAttribute('aria-checked', 'true'); await sw.click(); await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect((await effectsOf(page, 'clipA')).find(e => e.effectId === 'sepia').enabled).toBe(false); expect(await entries(page)).toBe(++base);
  await sw.click(); await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect((await effectsOf(page, 'clipA')).find(e => e.effectId === 'sepia').enabled).toBe(true); expect(await entries(page)).toBe(++base);
  expect((await undoEntries(page)).at(-1)).toMatchObject({ label: 'Edit items' });

  const grip = (n: string) => card(panel, n).getByRole('button', { name: `Reorder ${n}` });
  await grip('Invert').focus(); await page.keyboard.press('ArrowUp');
  expect(await stackOf(page, 'clipA')).toEqual(['grayscale', 'invert', 'sepia']); expect(await entries(page)).toBe(++base);
  await grip('Grayscale').focus(); await page.keyboard.press('ArrowUp'); // already first: no move, no entry
  await grip('Sepia').focus(); await page.keyboard.press('ArrowDown'); // already last
  expect(await stackOf(page, 'clipA')).toEqual(['grayscale', 'invert', 'sepia']); expect(await entries(page)).toBe(base);
  await grip('Grayscale').focus(); await page.keyboard.press('ArrowDown');
  expect(await stackOf(page, 'clipA')).toEqual(['invert', 'grayscale', 'sepia']); expect(await entries(page)).toBe(++base);

  await grip('Sepia').dragTo(card(panel, 'Invert'));
  expect(await stackOf(page, 'clipA')).toEqual(['sepia', 'invert', 'grayscale']); expect(await entries(page)).toBe(++base);
  expect((await effectsOf(page, 'clipA')).map(e => e.order).sort()).toEqual([0, 1, 2]);

  await card(panel, 'Invert').getByRole('button', { name: 'Remove Invert' }).click();
  await expect(card(panel, 'Invert')).toHaveCount(0);
  expect(await stackOf(page, 'clipA')).toEqual(['sepia', 'grayscale']); expect(await entries(page)).toBe(++base);
  expect((await undoEntries(page)).at(-1)).toMatchObject({ label: 'Edit items' });
});

test('D rail: disabled with no selection, click adds, search filters, a drag from the rail drops on the Effects tab', async ({ page }) => {
  await openEditor(page, richDoc());
  const rail = () => page.getByRole('region', { name: 'Effects', exact: true }).first();
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Effects' }).click();
  const hint = page.getByText('Select a timeline item first to apply an effect.');
  await expect(hint).toBeVisible();
  const names = rail().getByRole('list', { name: 'Effects' }).getByRole('button');
  const all = await names.allTextContents(); expect(all).toContain('LUT (.cube)'); expect(all).toContain('Secondary (HSL Qualifier)');
  expect(all.length).toBeGreaterThanOrEqual(30);
  for (const b of await names.all()) await expect(b).toBeDisabled();

  await clip(page, 'clipA').click(); await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Effects' }).click();
  await expect(hint).toHaveCount(0); await expect(rail().getByRole('button', { name: 'Sepia', exact: true })).toBeEnabled();
  const base = await entries(page);
  await rail().getByRole('button', { name: 'Sepia', exact: true }).click();
  expect(await stackOf(page, 'clipA')).toEqual(['sepia']); expect(await entries(page)).toBe(base + 1);

  await rail().getByLabel('Search effects').fill('gray');
  await expect(names).toHaveText(['Grayscale']); await rail().getByLabel('Search effects').fill('zzzz');
  await expect(rail().getByText('No effects match.')).toBeVisible(); await rail().getByLabel('Search effects').fill('');
  expect(await names.count()).toBe(all.length);

  // The row is draggable and carries the effect id; the Effects tab accepts that drop (the rail and the tab are never on
  // screen together, so the data transfer is carried across the swap).
  const li = rail().locator('li', { has: page.getByRole('button', { name: 'Invert', exact: true }) });
  await expect(li).toHaveAttribute('draggable', 'true');
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await li.dispatchEvent('dragstart', { dataTransfer: dt });
  expect(await dt.evaluate(d => d.getData('application/x-cutframe-effect'))).toBe('invert');
  await clip(page, 'clipB').click(); await inspector(page).getByRole('tab', { name: 'Effects' }).click();
  const tab = page.locator('.effects-tab'); await expect(tab).toBeVisible();
  const before = await entries(page);
  await tab.dispatchEvent('dragover', { dataTransfer: dt }); await tab.dispatchEvent('drop', { dataTransfer: dt });
  await expect(card(inspector(page), 'Invert')).toBeVisible();
  expect(await stackOf(page, 'clipB')).toEqual(['invert']); expect(await entries(page)).toBe(before + 1);
  expect(await stackOf(page, 'clipA')).toEqual(['sepia']);
  // A drop that carries something else does nothing.
  const other = await page.evaluateHandle(() => { const d = new DataTransfer(); d.setData('text/plain', 'sepia'); return d; });
  await tab.dispatchEvent('drop', { dataTransfer: other }); expect(await stackOf(page, 'clipB')).toEqual(['invert']);
});

test('D picker: search, and the list follows the item type (36 for video and image; Invert, Gaussian Blur, Drop Shadow for text)', async ({ page }) => {
  const panel = await openEffects(page, 'clipA');
  const open = async () => { await panel.getByRole('button', { name: '+ Add Effect' }).click(); return page.getByRole('dialog', { name: 'Add Effect' }); };
  const rows = (d: Locator) => d.getByRole('list', { name: 'Effects to add' }).getByRole('button');
  let dlg = await open(); await expect(rows(dlg)).toHaveCount(36);
  const video = await rows(dlg).evaluateAll(b => b.map(x => x.getAttribute('aria-label')));
  expect(video).toContain('Secondary (HSL Qualifier)'); for (const n of ['LUT (.cube)', 'Color Wheels', 'Curves']) expect(video).not.toContain(n); // the Color card's three are not in the picker
  await dlg.getByLabel('Search effects to add').fill('blur'); const blurs = await rows(dlg).evaluateAll(b => b.map(x => x.getAttribute('aria-label')));
  expect(blurs.length).toBeGreaterThan(2); for (const n of blurs) expect(n!.toLowerCase()).toContain('blur');
  await dlg.getByLabel('Search effects to add').fill('zzzz'); await expect(dlg.getByText('No effects match.')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dlg).toHaveCount(0);

  await clip(page, 'photo').click(); dlg = await open(); await expect(rows(dlg)).toHaveCount(36); await page.keyboard.press('Escape');
  await clip(page, 'title').click(); dlg = await open();
  expect((await rows(dlg).evaluateAll(b => b.map(x => x.getAttribute('aria-label')))).sort()).toEqual(['Drop Shadow', 'Gaussian Blur', 'Invert']);
  await dlg.getByRole('button', { name: 'Invert', exact: true }).click(); await expect(dlg).toHaveCount(0);
  expect(await stackOf(page, 'title')).toEqual(['invert']);
});

test('D Load .cube LUT: the stored name is the cube TITLE, else the file name without .cube; one entry per load', async ({ page }) => {
  const panel = await openEffects(page, 'clipA'); await openAdvanced(panel);
  const cube = (title: string) => `${title}LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`;
  const input = colour(panel).getByLabel('LUT file'); const base = await entries(page);
  await expect(colour(panel).locator('.lut-name')).toHaveText('No LUT loaded');
  await input.setInputFiles({ name: 'warm look.cube', mimeType: 'text/plain', buffer: Buffer.from(cube('')) });
  await expect(colour(panel).locator('.lut-name')).toHaveText('warm look');
  let lut = (await effectsOf(page, 'clipA')).find(e => e.effectId === 'lut');
  expect(lut.parameters.lutName.defaultValue).toBe('warm look'); expect(String(lut.parameters.lutData?.defaultValue ?? '').length).toBeGreaterThan(0);
  expect(await entries(page)).toBe(base + 1);
  await input.setInputFiles({ name: 'file-name.cube', mimeType: 'text/plain', buffer: Buffer.from(cube('TITLE "Cool teal"\n')) });
  await expect(colour(panel).locator('.lut-name')).toHaveText('Cool teal');
  lut = (await effectsOf(page, 'clipA')).find(e => e.effectId === 'lut'); expect(lut.parameters.lutName.defaultValue).toBe('Cool teal');
  expect((await effectsOf(page, 'clipA')).filter(e => e.effectId === 'lut')).toHaveLength(1); expect(await entries(page)).toBe(base + 2);
});

test('D colour swatch: a hex typed in the popover is stored as that colour, one entry', async ({ page }) => {
  const panel = await openEffects(page, 'clipA');
  // Past clipA's end the paused stage does not draw it. Drawn, halftone takes ~45 s per 1920 × 1080 frame on software GL with
  // 2 CPUs (CI fix 1; the draw is synchronous, so the next call waited past the timeout). The card is the same off the clip.
  await setViewState(page, { playheadMs: 9000 }); await addAll(page, 'clipA', ['halftone']);
  const c = card(panel, 'Halftone'); const base = await entries(page);
  await c.getByRole('button', { name: /^Front Color: #/ }).click();
  const pop = page.getByRole('dialog', { name: 'Front Color colour' }); const hex = pop.getByLabel('Hex');
  await hex.fill('#ff8800'); await hex.press('Enter');
  await expect.poll(async () => String((await effectsOf(page, 'clipA'))[0].parameters.colorFront.defaultValue).toLowerCase()).toBe('#ff8800');
  expect(await entries(page)).toBe(base + 1);
  await expect(c.getByRole('button', { name: /^Front Color: #ff8800$/i })).toBeVisible();
  expect((await effectsOf(page, 'clipA'))[0].parameters.colorBack.defaultValue).not.toMatch(/ff8800/i); // the other colour is untouched
});

test('D colour wheel: drag stores {angle, distance} on release, a plain click changes nothing, double-click is neutral', async ({ page }) => {
  const panel = await openEffects(page, 'clipA'); await openAdvanced(panel);
  const wheel = colour(panel).getByRole('slider', { name: 'Shadows wheel' }); const base = await entries(page);
  await expect(wheel).toHaveAttribute('aria-valuetext', '0°, 0%');
  let c = await centre(wheel); await page.mouse.click(c.x + 8, c.y);
  expect(await effectsOf(page, 'clipA')).toHaveLength(0); expect(await entries(page)).toBe(base);

  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 6, c.y); await page.mouse.move(c.x + 12, c.y);
  expect(await effectsOf(page, 'clipA')).toHaveLength(0); // nothing is stored before the release
  await page.mouse.up();
  const got = () => effectsOf(page, 'clipA').then(fx => fx.find(e => e.effectId === 'color-wheels')?.parameters.shadowsWheel.defaultValue as { angle: number; distance: number });
  await expect.poll(async () => (await got())?.distance).toBeCloseTo(0.5, 1);
  let w = await got(); expect(Math.abs(w.angle)).toBeLessThanOrEqual(1); expect(Math.abs(w.distance - 0.5)).toBeLessThanOrEqual(0.02);
  await expect(wheel).toHaveAttribute('aria-valuetext', `${w.angle}°, 50%`); expect(await entries(page)).toBe(base + 1);

  c = await centre(wheel); await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x, c.y - 6); await page.mouse.move(c.x, c.y - 12); await page.mouse.up();
  await expect.poll(async () => (await got()).angle).toBeGreaterThanOrEqual(89);
  w = await got(); expect(w.angle).toBeLessThanOrEqual(91); expect(Math.abs(w.distance - 0.5)).toBeLessThanOrEqual(0.02); expect(await entries(page)).toBe(base + 2);

  await wheel.dblclick(); await expect.poll(got).toEqual({ angle: 0, distance: 0 });
  await expect(wheel).toHaveAttribute('aria-valuetext', '0°, 0%'); expect(await entries(page)).toBe(base + 3);
  await wheel.dblclick(); expect(await entries(page)).toBe(base + 3); // already neutral: no entry
});

test('D Color card: Enable Color bypasses the grade, Reset Color deletes it; the other effects stay', async ({ page }) => {
  const panel = await openEffects(page, 'clipA'); await addAll(page, 'clipA', ['sepia']);
  const color = colour(panel); await expect(color.getByRole('switch', { name: 'Enable Color' })).toHaveCount(0); await expect(color.getByRole('button', { name: 'Reset Color' })).toHaveCount(0);
  const exposure = color.getByRole('slider', { name: 'Exposure', exact: true }); await exposure.dblclick(); await color.getByLabel('Exposure value').fill('1'); await color.getByLabel('Exposure value').press('Enter');
  await expect(exposure).toHaveAttribute('aria-valuenow', '1');
  expect(blockOf(await effectsOf(page, 'clipA')).length).toBeGreaterThan(0);
  const sw = color.getByRole('switch', { name: 'Enable Color' }); await expect(sw).toHaveAttribute('aria-checked', 'true'); let base = await entries(page);
  await sw.click(); await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect(blockOf(await effectsOf(page, 'clipA')).every(e => e.enabled === false)).toBe(true);
  expect((await effectsOf(page, 'clipA')).find(e => e.effectId === 'sepia').enabled).toBe(true); expect(await entries(page)).toBe(++base);
  await expect(exposure).toHaveAttribute('aria-valuenow', '1'); // bypass keeps the values
  await sw.click(); await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(blockOf(await effectsOf(page, 'clipA')).every(e => e.enabled !== false)).toBe(true); expect(await entries(page)).toBe(++base);

  await color.getByRole('button', { name: 'Reset Color' }).click();
  expect(blockOf(await effectsOf(page, 'clipA'))).toHaveLength(0); expect(await stackOf(page, 'clipA')).toEqual(['sepia']);
  await expect(exposure).toHaveAttribute('aria-valuenow', '0'); await expect(color.getByRole('switch', { name: 'Enable Color' })).toHaveCount(0);
  expect(await entries(page)).toBe(++base);
});

test('D effect keyframes: diamond adds at the playhead, the slider edits the keyframe, Delete removes it; timeline mark and eye', async ({ page }) => {
  const panel = await openEffects(page, 'clipA'); await addAll(page, 'clipA', ['grayscale']);
  const c = card(panel, 'Grayscale'); const id = (await effectsOf(page, 'clipA'))[0].id as string;
  const amount = c.getByRole('slider', { name: 'Amount', exact: true }), field = c.getByLabel('Amount value');
  const marks = clip(page, 'clipA').locator(`.clip-kf[data-kf-key="${id}.amount"]`);
  const eye = c.getByRole('button', { name: 'Show Amount keyframes on the timeline' });
  const param = async () => (await effectsOf(page, 'clipA'))[0].parameters.amount as { defaultValue: number; keyframes: any[] };

  await setViewState(page, { playheadMs: 9000 }); // past the clip's end
  await expect(c.getByRole('button', { name: 'Add Amount keyframe' })).toBeDisabled(); await expect(eye).toBeDisabled();
  await setViewState(page, { playheadMs: 2000 });
  const add = c.getByRole('button', { name: 'Add Amount keyframe' }); await expect(add).toBeEnabled(); await expect(add).toHaveAttribute('aria-pressed', 'false');
  let base = await entries(page); await add.click();
  const at = c.getByRole('button', { name: 'Amount keyframe at playhead' }); await expect(at).toHaveAttribute('aria-pressed', 'true');
  expect((await param()).keyframes).toHaveLength(1); expect((await param()).defaultValue).toBe(100); expect(await entries(page)).toBe(++base);
  await expect(eye).toBeEnabled(); await expect(eye).toHaveAttribute('aria-pressed', 'true'); await expect(marks).toHaveCount(1);

  await amount.dblclick(); await field.fill('30'); await field.press('Enter'); // on the keyframe: edits the keyframe, not the static value
  await expect(amount).toHaveAttribute('aria-valuenow', '30');
  const p = await param(); expect(p.defaultValue).toBe(100); expect(p.keyframes).toHaveLength(1); expect(Object.values(p.keyframes[0])).toContain(30); expect(await entries(page)).toBe(++base);

  await eye.click(); await expect(eye).toHaveAttribute('aria-pressed', 'false'); await expect(marks).toHaveCount(0);
  await eye.click(); await expect(eye).toHaveAttribute('aria-pressed', 'true'); await expect(marks).toHaveCount(1);
  expect(await entries(page)).toBe(base); // the eye is view state, not an edit

  await c.getByRole('button', { name: 'Delete Amount keyframe' }).click();
  expect((await param()).keyframes).toHaveLength(0); await expect(c.getByRole('button', { name: 'Add Amount keyframe' })).toHaveAttribute('aria-pressed', 'false');
  await expect(marks).toHaveCount(0); await expect(eye).toBeDisabled(); expect(await entries(page)).toBe(++base);
});
