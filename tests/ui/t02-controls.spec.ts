// SPDX-License-Identifier: AGPL-3.0-only
// T02 owned acceptance G1–G4: the shared slider row, slider card and colour picker, driven with real pointer input through the test-only harness
// (editor/harness.tsx), plus the editor wiring that reports T05 edits as intents without storing them; T04 and T10 (Color card) edits are stored.
// Oracle: part 3 §46.6 (W3-ED-24: 100 px on Exposure −3…3 = +1.85 ±0.05, Shift = +0.20 ±0.05, Alt/Ctrl plain), §46.4, §46.7.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { clip, expectUntouched, intents, notices, openEditor, richDoc, skipTour, stored, viewState, watchIntents } from './t02-support';
import { undoEntries } from './t03-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1400, height: 900 }); });

type Window = { __m: { commits: unknown[]; changes: unknown[]; value: () => unknown; setValue: (value: unknown) => void; unmount: () => void } };
async function mount(page: Page, options: unknown) {
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.evaluate(async options => {
    const p = '/src/editor/harness.tsx'; const h = await import(p); const container = document.createElement('div'); container.id = 'host'; container.style.cssText = 'position:fixed;left:80px;top:80px;width:380px;padding:8px;background:#fff;color:#000;z-index:9999';
    document.body.append(container); (window as unknown as Window).__m = h.mountControl(container, options);
  }, options);
}
const commits = (page: Page) => page.evaluate(() => (window as unknown as Window).__m.commits);
const changes = (page: Page) => page.evaluate(() => (window as unknown as Window).__m.changes.length);
const stored1 = (page: Page) => page.evaluate(() => (window as unknown as Window).__m.value());
const EXPOSURE = { kind: 'slider', label: 'Exposure', range: { min: -3, max: 3, step: 0.05 }, initial: 0 };
const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
async function drag(page: Page, l: Locator, dx: number, modifier?: 'Shift' | 'Alt' | 'Control') {
  const c = await centre(l); await page.mouse.move(c.x, c.y); if (modifier) await page.keyboard.down(modifier); await page.mouse.down();
  for (let n = 1; n <= 20; n++) await page.mouse.move(c.x + dx * n / 20, c.y); await page.mouse.up(); if (modifier) await page.keyboard.up(modifier);
}

test('G1 ground truth: a plain click changes nothing; a 100 px drag on Exposure gives +1.85, Shift +0.20, Alt/Ctrl the plain +1.85; one commit per gesture', async ({ page }) => {
  await mount(page, EXPOSURE); const slider = page.getByRole('slider', { name: 'Exposure' }); const text = page.locator('.slider-value');
  await expect(text).toHaveText('0.00'); await expect(slider).toHaveAttribute('aria-valuemin', '-3'); await expect(slider).toHaveAttribute('aria-valuemax', '3');
  const c = await centre(slider); await page.mouse.click(c.x + 60, c.y); expect(await commits(page)).toEqual([]); await expect(text).toHaveText('0.00'); expect(await stored1(page)).toBe(0);
  await drag(page, slider, 100); let list = (await commits(page)) as number[]; expect(list).toHaveLength(1); expect(Math.abs(list[0] - 1.85)).toBeLessThanOrEqual(0.05); expect(list[0]).toBe(1.85);
  expect(await changes(page)).toBeGreaterThan(5); // the live value follows the pointer, the commit comes once on release
  await expect(text).toHaveText('1.85'); await expect(slider).toHaveAttribute('aria-valuenow', '1.85');
  await drag(page, slider, -100); list = (await commits(page)) as number[]; expect(list).toHaveLength(2); expect(list[1]).toBe(0); // relative: back to where it started
  await drag(page, slider, 100, 'Shift'); list = (await commits(page)) as number[]; expect(list).toHaveLength(3); expect(Math.abs(list[2] - 0.2)).toBeLessThanOrEqual(0.05); expect(list[2]).toBe(0.2);
});

test('G1 Alt and Ctrl drags are plain (+1.85); a drag from the current value is relative; a huge drag clamps to the range', async ({ page }) => {
  await mount(page, EXPOSURE); const slider = page.getByRole('slider', { name: 'Exposure' });
  await drag(page, slider, 100, 'Alt'); await drag(page, slider, -100); await drag(page, slider, 100, 'Control'); await drag(page, slider, -100);
  expect(await commits(page)).toEqual([1.85, 0, 1.85, 0]);
  await drag(page, slider, 100); await drag(page, slider, 100); expect(((await commits(page)) as number[]).slice(4)).toEqual([1.85, 3]); // 1.85 + 1.85 = 3.70 → clamped to 3
  await drag(page, slider, 400); expect(((await commits(page)) as number[]).length).toBe(6); // already at 3: nothing new to commit
  await drag(page, slider, -2000); expect((await commits(page)).at(-1)).toBe(-3);
});

test('G1 a drag that ends where it began commits nothing; a right-click does nothing', async ({ page }) => {
  await mount(page, EXPOSURE); const slider = page.getByRole('slider', { name: 'Exposure' }); const c = await centre(slider);
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 80, c.y, { steps: 8 }); await page.mouse.move(c.x, c.y, { steps: 8 }); await page.mouse.up(); expect(await commits(page)).toEqual([]);
  await page.mouse.move(c.x, c.y); await page.mouse.down({ button: 'right' }); await page.mouse.move(c.x + 90, c.y, { steps: 6 }); await page.mouse.up({ button: 'right' }); expect(await commits(page)).toEqual([]);
  await slider.click({ button: 'right' }); await expect(page.getByLabel('Exposure value')).toHaveCount(0); await expect(page.getByRole('menu')).toHaveCount(0); expect(await commits(page)).toEqual([]);
});

test('G1 double-click types a number: Enter commits, Escape cancels, −99 → minimum, 999 → maximum, "abc" ignored, steps snap', async ({ page }) => {
  await mount(page, EXPOSURE); const slider = page.getByRole('slider', { name: 'Exposure' }), field = page.getByLabel('Exposure value');
  await slider.dblclick(); await expect(field).toBeFocused(); await expect(field).toHaveValue('0.00');
  await field.fill('-99'); await field.press('Enter'); await expect(field).toHaveCount(0); expect(await commits(page)).toEqual([-3]); await expect(page.locator('.slider-value')).toHaveText('-3.00');
  await slider.dblclick(); await field.fill('999'); await field.press('Enter'); expect(await commits(page)).toEqual([-3, 3]);
  await slider.dblclick(); await field.fill('abc'); await field.press('Enter'); await expect(field).toHaveCount(0); expect(await commits(page)).toEqual([-3, 3]); await expect(page.locator('.slider-value')).toHaveText('3.00'); // ignored
  await slider.dblclick(); await field.fill('1.234'); await field.press('Escape'); await expect(field).toHaveCount(0); expect(await commits(page)).toEqual([-3, 3]); // cancelled
  await slider.dblclick(); await field.fill('1.234'); await field.press('Enter'); expect(await commits(page)).toEqual([-3, 3, 1.25]); // snapped to the 0.05 step
  await slider.dblclick(); await field.press('Enter'); expect(await commits(page)).toEqual([-3, 3, 1.25]); // unchanged value: no commit
  await page.locator('.slider-value').dblclick(); await expect(field).toBeFocused(); await field.fill('0'); await field.press('Enter'); expect((await commits(page)).at(-1)).toBe(0); // the value text opens it too
});

test('G1 keyboard: arrows step one slider step and commit; Enter opens the field', async ({ page }) => {
  await mount(page, EXPOSURE); const slider = page.getByRole('slider', { name: 'Exposure' }); await slider.focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft'); expect(await commits(page)).toEqual([0.05, 0.1, 0.05]);
  await page.keyboard.press('Enter'); await expect(page.getByLabel('Exposure value')).toBeFocused(); await page.keyboard.press('Escape'); await expect(page.getByLabel('Exposure value')).toHaveCount(0);
});

test('G2 card: the reset arrow shows only when a row differs and restores every row', async ({ page }) => {
  const rows = [{ key: 'exposure', label: 'Exposure', range: { min: -3, max: 3, step: 0.05 } }, { key: 'contrast', label: 'Contrast', range: { min: 0, max: 2, step: 0.01 } }];
  await mount(page, { kind: 'card', title: 'Color', rows, defaults: { exposure: 0, contrast: 1 } });
  const reset = page.getByRole('button', { name: 'Reset Color' }); await expect(reset).toHaveCount(0);
  await drag(page, page.getByRole('slider', { name: 'Exposure' }), 100); await expect(reset).toBeVisible(); await drag(page, page.getByRole('slider', { name: 'Contrast' }), 100);
  expect(await commits(page)).toEqual([{ exposure: 1.85 }, { contrast: 1.62 }]); expect(await stored1(page)).toEqual({ exposure: 1.85, contrast: 1.62 });
  await reset.click(); expect((await commits(page)).at(-1)).toEqual({ exposure: 0, contrast: 1 }); expect(await stored1(page)).toEqual({ exposure: 0, contrast: 1 }); await expect(reset).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Exposure' })).toHaveAttribute('aria-valuenow', '0'); await expect(page.getByRole('slider', { name: 'Contrast' })).toHaveAttribute('aria-valuenow', '1');
});

test('G2 card: a single changed row (the other still default) also shows the arrow; resetting restores both rows', async ({ page }) => {
  const rows = [{ key: 'exposure', label: 'Exposure', range: { min: -3, max: 3, step: 0.05 } }, { key: 'contrast', label: 'Contrast', range: { min: 0, max: 2, step: 0.01 } }];
  await mount(page, { kind: 'card', title: 'Color', rows, defaults: { exposure: 0, contrast: 1 }, initial: { contrast: 1.5 } });
  await expect(page.getByRole('button', { name: 'Reset Color' })).toBeVisible(); await page.getByRole('button', { name: 'Reset Color' }).click();
  expect(await commits(page)).toEqual([{ exposure: 0, contrast: 1 }]); await expect(page.getByRole('button', { name: 'Reset Color' })).toHaveCount(0);
});

// T10 (C8 assertion-only edits): the Color card is built now. It reports the colourBlock intent and stores the grade on the
// item's first color-wheels instance (created on the first edit), so the shown value stays and Reset Color appears.
test('G3 editor wiring: Effects → Color card on a selected video reports colourBlock (T10) on release and stores the grade', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); await clip(page, 'clipA').click();
  const panel = page.getByRole('complementary', { name: 'Inspector and tools' }); await panel.getByRole('tab', { name: 'Effects' }).click();
  const card = panel.getByRole('region', { name: 'Color', exact: true }); await expect(card.locator('.slider-label')).toHaveText(['Exposure', 'Contrast', 'Saturation', 'Temperature', 'Tint', 'Vibrance']);
  await expect(card.getByRole('slider', { name: 'Contrast' })).toHaveAttribute('aria-valuenow', '1');
  await drag(page, card.getByRole('slider', { name: 'Exposure' }), 100);
  const log = await intents(page); expect(log).toHaveLength(1); expect(log[0].intent).toEqual({ type: 'colourBlock', itemIds: ['clipA'], effectId: 'color-wheels', values: { exposure: 1.85 } });
  expect(log[0].outcome).toMatchObject({ ok: true });
  await expect(card.getByRole('slider', { name: 'Exposure' })).toHaveAttribute('aria-valuenow', '1.85'); await expect(card.getByRole('button', { name: 'Reset Color' })).toBeVisible();
  const field = page.getByLabel('Contrast value'); await card.getByRole('slider', { name: 'Contrast' }).dblclick(); await field.fill('5'); await field.press('Enter');
  expect((await intents(page)).at(-1)!.intent).toMatchObject({ effectId: 'color-wheels', values: { contrast: 2 } }); // typed values clamp to the row's range
  const fx = JSON.parse((await stored(page, id)).live).items.find((i: { id: string }) => i.id === 'clipA').effects;
  expect(fx).toHaveLength(1); expect(fx[0]).toMatchObject({ effectId: 'color-wheels', enabled: true, order: 0, parameters: { exposure: { defaultValue: 1.85, keyframes: [] }, contrast: { defaultValue: 2, keyframes: [] } } });
});

test('G3 with several clips selected the color edit names all of them', async ({ page }) => {
  await openEditor(page, richDoc()); await watchIntents(page); await clip(page, 'clipA').click(); await clip(page, 'clipB').click({ modifiers: ['Control'] });
  const panel = page.getByRole('complementary', { name: 'Inspector and tools' }); await expect(panel).toContainText('2 items selected; showing the first.'); await panel.getByRole('tab', { name: 'Effects' }).click();
  await panel.getByRole('slider', { name: 'Exposure' }).focus(); await page.keyboard.press('ArrowRight'); expect((await intents(page)).at(-1)!.intent).toMatchObject({ type: 'colourBlock', itemIds: ['clipA', 'clipB'], effectId: 'color-wheels', values: { exposure: 0.05 } });
});

const swatch = (page: Page, name: RegExp) => page.getByRole('button', { name });
test('R5 empty and all-disabled menus close by Escape inside and outside a dialog', async ({ page }) => {
  for (const nested of [false, true]) for (const disabled of [false, true]) {
    await mount(page, { kind: 'menu', disabled, nested }); const trigger = page.getByRole('button', { name: 'Harness menu' });
    await trigger.click(); const menu = page.getByRole('menu', { name: 'Harness menu' }); await expect(menu).toBeVisible();
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
    if (nested) await expect(page.getByRole('dialog', { name: 'Harness dialog' })).toBeVisible();
    await trigger.click(); await expect(menu).toBeVisible(); await trigger.click(); await expect(menu).toHaveCount(0);
    if (nested) await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.evaluate(() => (window as unknown as Window).__m.unmount());
  }
});
test('G4 colour picker parts: SV square, hue, alpha, format, hex, opacity %, eyedropper (enabled only where the browser has one); no gradient tabs by default', async ({ page }) => {
  await mount(page, { kind: 'colour', label: 'Fill', initial: '#ff0000' }); await swatch(page, /^Fill: #ff0000$/).click(); const picker = page.getByRole('dialog', { name: 'Fill colour' });
  for (const part of ['Saturation and brightness', 'Hue', 'Alpha']) await expect(picker.getByRole('slider', { name: part })).toBeVisible();
  await expect(picker.getByLabel('Colour format')).toHaveValue('hex'); await expect(picker.getByLabel('Hex')).toHaveValue('#FF0000'); await expect(picker.getByLabel('Opacity')).toHaveValue('100'); await expect(picker.getByRole('tablist')).toHaveCount(0);
  const hasDropper = await page.evaluate(() => 'EyeDropper' in window); const dropper = picker.getByRole('button', { name: 'Eyedropper' });
  if (hasDropper) await expect(dropper).toBeEnabled(); else await expect(dropper).toBeDisabled(); await expect(dropper).toHaveAttribute('title', hasDropper ? 'Pick a colour from the screen' : 'This browser has no eyedropper');
  await expect(swatch(page, /^Fill:/)).toHaveAttribute('aria-expanded', 'true'); await page.mouse.click(5, 600); await expect(picker).toHaveCount(0); expect(await commits(page)).toEqual([]); // an outside press closes it, nothing committed
});

test('G4 eyedropper picks once and commits once; cancellation commits nothing', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any; w.__eyeCalls = 0; w.__eyeCancel = false;
    w.EyeDropper = class { async open() { w.__eyeCalls++; if (w.__eyeCancel) throw new DOMException('Cancelled', 'AbortError'); return { sRGBHex: '#12ab34' }; } };
  });
  await mount(page, { kind: 'colour', label: 'Fill', initial: '#ff0000' }); await swatch(page, /^Fill:/).click();
  const dropper = page.getByRole('button', { name: 'Eyedropper' }); await dropper.click();
  await expect.poll(() => commits(page)).toEqual(['#12ab34']); expect(await page.evaluate(() => (window as any).__eyeCalls)).toBe(1);
  await page.evaluate(() => { (window as any).__eyeCancel = true; }); await dropper.click();
  await expect.poll(() => page.evaluate(() => (window as any).__eyeCalls)).toBe(2); expect(await commits(page)).toEqual(['#12ab34']);
});

test('G4 hex field and opacity: valid entries commit, invalid ones restore the field and commit nothing', async ({ page }) => {
  await mount(page, { kind: 'colour', label: 'Fill', initial: '#ff0000' }); await swatch(page, /^Fill:/).click(); const picker = page.getByRole('dialog', { name: 'Fill colour' }), hex = picker.getByLabel('Hex'), opacity = picker.getByLabel('Opacity');
  await hex.fill('00ff00'); await hex.press('Enter'); expect(await commits(page)).toEqual(['#00ff00']); await expect(hex).toHaveValue('#00FF00');
  await hex.fill('#abc'); await hex.press('Enter'); expect((await commits(page)).at(-1)).toBe('#aabbcc');
  const n = (await commits(page)).length; await hex.fill('zzz'); await hex.press('Enter'); expect((await commits(page)).length).toBe(n); await expect(hex).toHaveValue('#AABBCC'); // restored
  await hex.fill('12345'); await hex.blur(); expect((await commits(page)).length).toBe(n); await expect(hex).toHaveValue('#AABBCC');
  await opacity.fill('50'); await opacity.press('Enter'); expect((await commits(page)).at(-1)).toBe('#aabbcc80'); await expect(opacity).toHaveValue('50');
  await opacity.fill('150'); await opacity.press('Enter'); expect((await commits(page)).at(-1)).toBe('#aabbcc'); await expect(opacity).toHaveValue('100'); // clamped, back to opaque
  const m = (await commits(page)).length; await opacity.fill(''); await opacity.press('Enter'); expect((await commits(page)).length).toBe(m); await expect(opacity).toHaveValue('100');
});

test('G4 SV square, hue bar and alpha bar commit on release with the picked colour', async ({ page }) => {
  await mount(page, { kind: 'colour', label: 'Fill', initial: '#ff0000' }); await swatch(page, /^Fill:/).click(); const picker = page.getByRole('dialog', { name: 'Fill colour' });
  const sv = (await picker.getByRole('slider', { name: 'Saturation and brightness' }).boundingBox())!;
  const channels = async () => { const c = (await commits(page)).at(-1) as string; return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)); };
  await page.mouse.click(sv.x + 2, sv.y + sv.height - 2); expect((await channels()).every(v => v <= 4), 'bottom-left is black').toBe(true);
  await page.mouse.click(sv.x + 2, sv.y + 2); expect((await channels()).every(v => v >= 250), 'top-left is white').toBe(true);
  await page.mouse.click(sv.x + sv.width - 2, sv.y + 2); { const [r, g, bl] = await channels(); expect(r).toBeGreaterThanOrEqual(250); expect(g).toBeLessThanOrEqual(4); expect(bl).toBeLessThanOrEqual(4); } // top-right: the pure hue
  const hue = (await picker.getByRole('slider', { name: 'Hue' }).boundingBox())!, before = (await commits(page)).length;
  await page.mouse.move(hue.x + hue.width / 3, hue.y + hue.height / 2); await page.mouse.down(); await page.mouse.move(hue.x + hue.width / 3 + 1, hue.y + hue.height / 2); expect((await commits(page)).length).toBe(before); // no commit while dragging
  await page.mouse.move(hue.x + hue.width / 3, hue.y + hue.height / 2); await page.mouse.up(); { const [r, g, bl] = await channels(); expect(g).toBeGreaterThanOrEqual(245); expect(r).toBeLessThanOrEqual(8); expect(bl).toBeLessThanOrEqual(8); } expect((await commits(page)).length).toBe(before + 1); // 1/3 of the hue bar is green
  const alpha = (await picker.getByRole('slider', { name: 'Alpha' }).boundingBox())!; await page.mouse.click(alpha.x + alpha.width / 2, alpha.y + alpha.height / 2); expect((await commits(page)).at(-1)).toMatch(/^#[0-9a-f]{6}(7f|80|81)$/); { const [r, g] = await channels(); expect(g).toBeGreaterThanOrEqual(245); expect(r).toBeLessThanOrEqual(8); }
  await expect(picker.getByLabel('Opacity')).toHaveValue(/^(49|50|51)$/);
  await picker.getByRole('slider', { name: 'Hue' }).focus(); await page.keyboard.press('ArrowRight'); expect((await commits(page)).at(-1)).toMatch(/^#[0-9a-f]{6}(7f|80|81)$/); // keyboard moves are commits too
});

test('G4 Solid / Gradient tabs: Gradient defaults linear 180°, black 0% → white 100%; linear / radial, angle, position grid, add a stop, edit a stop colour', async ({ page }) => {
  await mount(page, { kind: 'colour', label: 'Text colour', initial: '#ff0000', gradient: true }); await swatch(page, /^Text colour:/).click(); const picker = page.getByRole('dialog', { name: 'Text colour colour' });
  await expect(picker.getByRole('tab')).toHaveText(['Solid', 'Gradient']); await expect(picker.getByRole('tab', { name: 'Solid' })).toHaveAttribute('aria-selected', 'true');
  await picker.getByRole('tab', { name: 'Gradient' }).click(); expect(await commits(page)).toEqual(['linear-gradient(180deg, #000000 0%, #ffffff 100%)']);
  await expect(picker.getByRole('button', { name: 'Linear' })).toHaveAttribute('aria-pressed', 'true'); await expect(picker.getByLabel('Angle')).toHaveValue('180'); await expect(picker.getByLabel('Gradient preview')).toBeVisible();
  const angle = picker.getByLabel('Angle'); await angle.fill('90'); await angle.press('Enter'); expect((await commits(page)).at(-1)).toBe('linear-gradient(90deg, #000000 0%, #ffffff 100%)');
  await angle.fill('450'); await angle.press('Enter'); expect((await commits(page)).at(-1)).toBe('linear-gradient(90deg, #000000 0%, #ffffff 100%)'); // 450° wraps to 90°
  await picker.getByRole('button', { name: 'Radial' }).click(); expect((await commits(page)).at(-1)).toBe('radial-gradient(circle at center, #000000 0%, #ffffff 100%)');
  const grid = picker.getByRole('group', { name: 'Gradient position' }); await expect(grid.getByRole('button')).toHaveCount(9); await expect(grid.getByRole('button', { name: 'Position center' })).toHaveAttribute('aria-pressed', 'true');
  await grid.getByRole('button', { name: 'Position left top' }).click(); expect((await commits(page)).at(-1)).toBe('radial-gradient(circle at left top, #000000 0%, #ffffff 100%)');
  await picker.getByRole('button', { name: 'Linear' }).click(); expect((await commits(page)).at(-1)).toBe('linear-gradient(90deg, #000000 0%, #ffffff 100%)');
  const bar = picker.getByLabel('Gradient stops'), b = (await bar.boundingBox())!; await page.mouse.click(b.x + b.width / 2, b.y + 2); expect((await commits(page)).at(-1)).toBe('linear-gradient(90deg, #000000 0%, #000000 50%, #ffffff 100%)');
  await expect(picker.getByRole('button', { name: /^Stop \d at/ })).toHaveCount(3); await expect(picker.getByRole('button', { name: 'Stop 3 at 50%' })).toHaveAttribute('aria-pressed', 'true');
  await picker.getByRole('button', { name: 'Stop 2 at 100%' }).click(); await expect(picker.getByRole('button', { name: 'Stop 2 at 100%' })).toHaveAttribute('aria-pressed', 'true');
  const hex = picker.getByLabel('Hex'); await expect(hex).toHaveValue('#FFFFFF'); // selected stop's colour
  const count = (await commits(page)).length; await hex.fill('00ff00'); await hex.press('Enter');
  expect((await commits(page)).slice(count)).toEqual(['linear-gradient(90deg, #000000 0%, #000000 50%, #00ff00 100%)']);
  await picker.getByRole('button', { name: 'Stop 1 at 0%' }).click(); await expect(hex).toHaveValue('#000000');
  await picker.getByRole('tab', { name: 'Solid' }).click(); await expect(picker.getByLabel('Hex')).toBeVisible();
});

test('G4 a stored gradient value opens on the Gradient tab with its stops', async ({ page }) => {
  await mount(page, { kind: 'colour', label: 'Text colour', initial: 'linear-gradient(45deg, #ff0000 0%, #0000ff 100%)', gradient: true }); await swatch(page, /^Text colour:/).click(); const picker = page.getByRole('dialog', { name: 'Text colour colour' });
  await expect(picker.getByRole('tab', { name: 'Gradient' })).toHaveAttribute('aria-selected', 'true'); await expect(picker.getByLabel('Angle')).toHaveValue('45');
  await expect(picker.getByRole('button', { name: 'Stop 1 at 0%' })).toBeVisible(); await expect(picker.getByRole('button', { name: 'Stop 2 at 100%' })).toBeVisible(); expect(await commits(page)).toEqual([]);
});

test('R1 switching two selected text items reconciles their gradients', async ({ page }) => {
  const doc = richDoc(), first = doc.items.find(i => i.id === 'title')!;
  // T05 (assertion edit): a text's colour is the stored property `color` (was details.color in this T02-era fixture).
  const colour = (value: string) => ({ ...first.properties, color: { defaultValue: value, keyframes: [] } });
  first.properties = colour('linear-gradient(45deg, #ff0000 0%, #0000ff 100%)');
  doc.items.push({ ...first, id: 'title2', display: { from: 6000, to: 10000 }, properties: colour('linear-gradient(90deg, #00ff00 0%, #ffffff 100%)') });
  const id = await openEditor(page, doc), before = await stored(page, id); const panel = page.getByRole('complementary', { name: 'Inspector and tools' });
  await clip(page, 'title').click(); await panel.locator('summary').filter({ hasText: /^Text$/ }).click(); await panel.getByRole('button', { name: /^Text colour:/ }).click();
  await expect(page.getByLabel('Angle', { exact: true })).toHaveValue('45'); await expect(page.getByLabel('Hex', { exact: true })).toHaveValue('#FF0000');
  await clip(page, 'title2').click(); await panel.getByRole('button', { name: /^Text colour:/ }).click();
  await expect(page.getByLabel('Angle', { exact: true })).toHaveValue('90'); await expect(page.getByLabel('Hex', { exact: true })).toHaveValue('#00FF00'); await expectUntouched(page, id, before);
});

test('R1 external controlled value cancels an active gesture and fresh edits use the new gradient', async ({ page }) => {
  await mount(page, { kind: 'colour', label: 'Text colour', initial: 'linear-gradient(45deg, #ff0000 0%, #0000ff 100%)', gradient: true });
  await swatch(page, /^Text colour:/).click(); const picker = page.getByRole('dialog', { name: 'Text colour colour' }), hue = picker.getByRole('slider', { name: 'Hue' });
  const b = (await hue.boundingBox())!; await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.4, b.y + b.height / 2);
  await page.evaluate(() => (window as unknown as Window).__m.setValue('linear-gradient(90deg, #00ff00 0%, #ffffff 100%)'));
  await expect(picker.getByLabel('Angle')).toHaveValue('90'); await expect(picker.getByLabel('Hex')).toHaveValue('#00FF00'); await page.mouse.up(); expect(await commits(page)).toEqual([]);
  await picker.getByLabel('Hex').fill('123456'); await picker.getByLabel('Hex').press('Enter'); expect(await commits(page)).toEqual(['linear-gradient(90deg, #123456 0%, #ffffff 100%)']);
});

test('R11 an external value equal to an earlier emitted gradient still reconciles the same mounted picker (emit A → external B → external A)', async ({ page }) => {
  await mount(page, { kind: 'colour', label: 'Review', initial: 'linear-gradient(45deg, #ff0000 0%, #0000ff 100%)', gradient: true });
  await swatch(page, /^Review:/).click(); const angle = page.getByLabel('Angle', { exact: true }), hex = page.getByLabel('Hex', { exact: true });
  await angle.fill('60'); await angle.press('Enter');
  const emitted = (await commits(page)).at(-1) as string; expect(emitted).toBe('linear-gradient(60deg, #ff0000 0%, #0000ff 100%)'); await expect(angle).toHaveValue('60'); // ordinary owner echo keeps the controls
  await page.evaluate(() => (window as unknown as Window).__m.setValue('linear-gradient(90deg, #00ff00 0%, #ffffff 100%)')); await expect(angle).toHaveValue('90'); await expect(hex).toHaveValue('#00FF00');
  await page.evaluate(value => (window as unknown as Window).__m.setValue(value), emitted);
  await expect(page.getByRole('button', { name: `Review: ${emitted}` })).toBeVisible(); await expect(angle).toHaveValue('60'); await expect(hex).toHaveValue('#FF0000');
  expect(await commits(page)).toEqual([emitted]); // external replacements are never re-emitted
});

test('G4 editor wiring: shadow colour on a video is stored as one "Edit items" step (T04), text colour with a gradient is stored by T05 as one "Edit items" step', async ({ page }) => {
  const id = await openEditor(page, richDoc()); await watchIntents(page); const panel = page.getByRole('complementary', { name: 'Inspector and tools' });
  await clip(page, 'clipA').click(); await panel.locator('summary', { hasText: 'Shadow' }).click(); await panel.getByRole('button', { name: 'Shadow colour: transparent' }).click();
  const picker = page.getByRole('dialog', { name: 'Shadow colour colour' }); await expect(picker.getByRole('tab')).toHaveCount(0); // gradients are not allowed for a shadow
  await picker.getByLabel('Hex').fill('FF8800'); await picker.getByLabel('Hex').press('Enter');
  let l = (await intents(page)).at(-1)!; expect(l.intent).toMatchObject({ type: 'editProperty', itemIds: ['clipA'], owner: 'T04', label: 'Shadow colour', key: 'boxShadow' }); expect(String(l.intent.value.color)).toMatch(/^#ff8800/); expect(l.outcome).toEqual({ ok: true });
  await expect(panel.getByRole('button', { name: /^Shadow colour: #ff8800/ })).toBeVisible(); expect(JSON.parse((await stored(page, id)).live).items.find((i: any) => i.id === 'clipA').properties.boxShadow).toEqual({ defaultValue: { color: expect.stringMatching(/^#ff8800/), x: 0, y: 0, blur: 0 }, keyframes: [] }); // the swatch shows the stored value
  await clip(page, 'title').click(); await panel.locator('summary', { hasText: /^Text$/ }).click(); await panel.getByRole('button', { name: 'Text colour: #ffffff' }).click();
  const text = page.getByRole('dialog', { name: 'Text colour colour' }); await expect(text.getByRole('tab')).toHaveText(['Solid', 'Gradient']); await text.getByRole('tab', { name: 'Gradient' }).click();
  l = (await intents(page)).at(-1)!; expect(l.intent).toEqual({ type: 'editTextProperties', itemIds: ['title'], properties: { color: 'linear-gradient(180deg, #000000 0%, #ffffff 100%)' } }); expect(l.outcome).toEqual({ ok: true }); // T05 (assertion edit): was editProperty + NOT_IMPLEMENTED
  await expect(panel.getByRole('button', { name: /^Text colour: linear-gradient\(180deg, #000000 0%, #ffffff 100%\)/ })).toBeVisible(); expect(await undoEntries(page)).toEqual([{ label: 'Edit items', source: 'user' }, { label: 'Edit items', source: 'user' }]);
  expect(await viewState(page, v => v.selection)).toEqual(['title']);
});

test('G4 compact layout: Escape in the Shadow sheet closes the colour-picker popover first, then the drawer; the selection is kept', async ({ page }) => {
  await page.setViewportSize({ width: 1023, height: 900 }); const id = await openEditor(page, richDoc()); await watchIntents(page); const before = await stored(page, id);
  await clip(page, 'clipA').click(); await page.getByRole('navigation', { name: 'Editor panels' }).getByRole('tab', { name: 'Shadow' }).click(); const drawer = page.getByRole('dialog', { name: 'Shadow', exact: true }); await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Shadow colour: transparent' }).click(); const picker = page.getByRole('dialog', { name: 'Shadow colour colour' }); await expect(picker).toBeVisible();
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0); await expect(drawer).toBeVisible(); expect(await viewState(page, v => v.selection)).toEqual(['clipA']);
  await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0); expect(await viewState(page, v => v.selection)).toEqual(['clipA']); await expect(clip(page, 'clipA')).toHaveAttribute('aria-selected', 'true');
  expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
});
