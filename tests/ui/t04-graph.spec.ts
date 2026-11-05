// SPDX-License-Identifier: AGPL-3.0-only
// T04 keyframe graph editor in real Chromium (written-spec oracle: findings part 3 §46.10 and §46.11, editing rules §45.5, W3-CC-02 for the
// 7 Easing Presets; the T04 batch-2b brief for intents and labels). Every graph edit is one "Edit items" step; a click selects and writes nothing.
// "provisional choice, not Xapp parity": Fit = data range padded 10 %, Easing Preset clears the outgoing handle.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectUntouched, intents, openEditor, skipTour, stored, viewState, watchIntents } from './t02-support';
import { liveDoc, undoLabels } from './t03-support';
import { centre, dblclickOnCurve, dragTo, kf, panel, pick, prop, t04Doc } from './t04-support';

test.beforeEach(async ({ page }) => { await skipTour(page); });
const itemOf = (doc: any, id: string) => doc.items.find((i: any) => i.id === id);
const last = async (page: Page) => { const log = await intents(page); return log[log.length - 1]; };
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });
const graphButton = (page: Page) => panel(page).getByRole('button', { name: 'Keyframes graph' });
/** Opacity 100 → 50 → 0 % at 0 / 2 / 4 s of the clip, all linear. */
const opacityDoc = (extra: Record<string, unknown> = {}) => t04Doc({ vid: { properties: { opacity: prop(1, [kf('k1', 0, 1), kf('k2', 2000, 0.5), kf('k3', 4000, 0)]) }, ...extra } });
const keyframes = async (page: Page, key = 'opacity') => { const i = itemOf(await liveDoc(page), 'vid'); return (key === 'timeRemap' ? i.timeRemap : i.properties[key]).keyframes as any[]; };
const open = async (page: Page, doc = opacityDoc()) => { const id = await openEditor(page, doc); await pick(page, 'vid'); await watchIntents(page); await graphButton(page).click(); return id; };
const keyBtn = (d: Locator, label: string) => d.getByRole('button', { name: label, exact: true });
test.describe('opening and closing (§46.10)', () => {
  test('no keyframes: the header graph button opens "Keyframe Graph" with the empty-state note; Escape closes it', async ({ page }) => {
    await openEditor(page, t04Doc()); await pick(page, 'vid'); await graphButton(page).click();
    const d = dialog(page, 'Keyframe Graph'); await expect(d).toBeVisible(); await expect(d).toContainText('No keyframes yet. Add keyframes to a property, mask or effect.');
    expect(await viewState(page, v => v.modes.graphEditorOpen)).toBe(true);
    await page.keyboard.press('Escape'); await expect(d).toHaveCount(0); expect(await viewState(page, v => v.graph)).toBeNull();
  });
  test('keyframed Opacity: dialog "Opacity Graph Editor" with the PROPERTIES list "Opacity 3", the "Opacity curve" and three keyframe buttons', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor'); await expect(d).toBeVisible();
    const list = d.getByRole('group', { name: 'PROPERTIES' }); await expect(list.getByRole('button', { name: 'Opacity 3' })).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByRole('group', { name: 'Opacity curve' })).toBeVisible();
    for (const t of ['0.00', '2.00', '4.00']) await expect(keyBtn(d, `Opacity keyframe at ${t}s`)).toHaveAttribute('aria-pressed', 'false');
    await expect(d.getByRole('button', { name: 'Undo' })).toBeDisabled(); await expect(d.getByRole('button', { name: 'Redo' })).toBeDisabled();
    const axis = (await d.getByRole('group', { name: 'Opacity curve' }).locator('text.graph-tick').allTextContents()).join(' '); // value axis 0–100 for Opacity
    expect(axis).toContain('100%'); expect(axis).toContain('0%');
  });
  test('the PROPERTIES list shows every keyframed property with its count and switches the curve', async ({ page }) => {
    await open(page, opacityDoc({ properties: { opacity: prop(1, [kf('k1', 0, 1), kf('k2', 2000, 0.5)]), scale: prop(1, [kf('s1', 1000, 1), kf('s2', 3000, 2), kf('s3', 3500, 3)]) } }));
    const d = dialog(page, 'Opacity Graph Editor'), list = d.getByRole('group', { name: 'PROPERTIES' });
    await expect(list.getByRole('button', { name: 'Opacity 2' })).toBeVisible(); await expect(list.getByRole('button', { name: 'Scale 3' })).toBeVisible();
    await list.getByRole('button', { name: 'Scale 3' }).click(); await expect(dialog(page, 'Scale Graph Editor')).toBeVisible(); await expect(dialog(page, 'Scale Graph Editor').getByRole('group', { name: 'Scale curve' })).toBeVisible();
  });
});

test.describe('selection, handles, preset menu, delete (§45.5, §46.10)', () => {
  test('Easing Preset, Add Bezier and Delete are disabled until a keyframe is selected; handles appear only with a selection', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor');
    await expect(d.getByRole('button', { name: 'Easing Preset' })).toBeDisabled(); await expect(d.getByRole('button', { name: 'Add Bezier' })).toBeDisabled(); await expect(d.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    await expect(d.getByRole('button', { name: 'In handle' })).toHaveCount(0); await expect(d.getByRole('button', { name: 'Out handle' })).toHaveCount(0);
    await keyBtn(d, 'Opacity keyframe at 2.00s').click(); await expect(keyBtn(d, 'Opacity keyframe at 2.00s')).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByRole('button', { name: 'In handle' })).toBeVisible(); await expect(d.getByRole('button', { name: 'Out handle' })).toBeVisible();
    await expect(d.getByRole('button', { name: 'Easing Preset' })).toBeEnabled(); await expect(d.getByRole('button', { name: 'Add Bezier' })).toBeEnabled(); await expect(d.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
    expect(await undoLabels(page)).toEqual([]); // a click selects and writes nothing
  });
  test('the first keyframe has only an out handle, the last only an in handle; Enter on a focused keyframe selects it', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor');
    await keyBtn(d, 'Opacity keyframe at 0.00s').focus(); await page.keyboard.press('Enter'); await expect(keyBtn(d, 'Opacity keyframe at 0.00s')).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByRole('button', { name: 'Out handle' })).toBeVisible(); await expect(d.getByRole('button', { name: 'In handle' })).toHaveCount(0);
    await keyBtn(d, 'Opacity keyframe at 4.00s').focus(); await page.keyboard.press('Enter');
    await expect(d.getByRole('button', { name: 'In handle' })).toBeVisible(); await expect(d.getByRole('button', { name: 'Out handle' })).toHaveCount(0);
    expect(await undoLabels(page)).toEqual([]);
  });
  test('Easing Preset lists the 7 presets in order; "Ease In" stores easeIn and clears the outgoing handle (provisional choice, not Xapp parity)', async ({ page }) => {
    await open(page, opacityDoc({ properties: { opacity: prop(1, [kf('k1', 0, 1), kf('k2', 2000, 0.5, 'linear', { outHandle: [0.3, 0.1] }), kf('k3', 4000, 0)]) } }));
    const d = dialog(page, 'Opacity Graph Editor'); await keyBtn(d, 'Opacity keyframe at 2.00s').click(); await d.getByRole('button', { name: 'Easing Preset' }).click();
    const menu = page.getByRole('menu', { name: 'Easing Preset' });
    expect(await menu.locator('[role^="menuitem"]').allTextContents()).toEqual(['Linear', 'Ease In', 'Ease Out', 'Ease In/Out', 'Cubic In', 'Cubic Out', 'Cubic In/Out']);
    await menu.getByRole('menuitemradio', { name: 'Ease In' }).or(menu.getByRole('menuitem', { name: 'Ease In' })).first().click();
    expect((await last(page)).intent).toMatchObject({ type: 'editKeyframe', target: { itemId: 'vid', key: 'opacity', keyframeId: 'k2' }, patch: { easing: 'easeIn', outHandle: null } });
    const k2 = (await keyframes(page)).find(k => k.id === 'k2'); expect(k2.easing).toBe('easeIn'); expect(k2.outHandle).toBeUndefined();
    expect(await undoLabels(page)).toEqual(['Edit items']);
  });
  test('Add Bezier stores {type:"bezier", points:[0.42,0,0.58,1]}; the button then reads "Bezier" and is disabled', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor'); await keyBtn(d, 'Opacity keyframe at 2.00s').click(); await d.getByRole('button', { name: 'Add Bezier' }).click();
    expect((await last(page)).intent).toMatchObject({ type: 'editKeyframe', patch: { easing: { type: 'bezier', points: [0.42, 0, 0.58, 1] } } });
    expect((await keyframes(page)).find(k => k.id === 'k2').easing).toEqual({ type: 'bezier', points: [0.42, 0, 0.58, 1] });
    const b = d.getByRole('button', { name: 'Bezier', exact: true }); await expect(b).toBeVisible(); await expect(b).toBeDisabled(); await expect(d.getByRole('button', { name: 'Add Bezier' })).toHaveCount(0);
    expect(await undoLabels(page)).toEqual(['Edit items']);
  });
  test('Delete removes the selected keyframe (deleteKeyframe, "Edit items"); Undo / Redo in the dialog restore and redo it', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor'); await keyBtn(d, 'Opacity keyframe at 2.00s').click(); await d.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await last(page)).intent).toMatchObject({ type: 'deleteKeyframe', target: { itemId: 'vid', key: 'opacity', keyframeId: 'k2' } });
    expect((await keyframes(page)).map(k => k.id)).toEqual(['k1', 'k3']); await expect(keyBtn(d, 'Opacity keyframe at 2.00s')).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled(); expect(await undoLabels(page)).toEqual(['Edit items']);
    await d.getByRole('button', { name: 'Undo' }).click(); expect((await keyframes(page)).map(k => k.id)).toEqual(['k1', 'k2', 'k3']); await expect(keyBtn(d, 'Opacity keyframe at 2.00s')).toBeVisible();
    await d.getByRole('button', { name: 'Redo' }).click(); expect((await keyframes(page)).map(k => k.id)).toEqual(['k1', 'k3']);
  });
  for (const key of ['Delete', 'Backspace']) test(`${key} in the dialog (focus not in an input) deletes the selected keyframe`, async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor'); await keyBtn(d, 'Opacity keyframe at 2.00s').click(); await page.keyboard.press(key);
    expect((await keyframes(page)).map(k => k.id)).toEqual(['k1', 'k3']); expect(await undoLabels(page)).toEqual(['Edit items']);
  });
  test('Delete with nothing selected does nothing', async ({ page }) => {
    const id = await open(page); const before = await stored(page, id); await dialog(page, 'Opacity Graph Editor').getByRole('group', { name: 'PROPERTIES' }).focus().catch(() => {});
    await page.keyboard.press('Delete'); expect(await undoLabels(page)).toEqual([]); await expectUntouched(page, id, before);
  });
});

test.describe('editing on the curve (§45.5)', () => {
  test('dragging a diamond commits once on release: new time and value in one "Edit items" step; the click that starts it only selects', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor'), key = keyBtn(d, 'Opacity keyframe at 2.00s'), svg = d.getByRole('group', { name: 'Opacity curve' });
    const box = (await svg.boundingBox())!, scale = box.width / 600; // the svg viewBox is 600 units wide at zoom 1
    const from = await centre(key); await dragTo(page, from, 60 * scale, -40 * scale);
    const k2 = (await keyframes(page)).find(k => k.id === 'k2'); // up = a larger value, right = a later time
    expect(k2.time).toBeGreaterThan(2000); expect(k2.time).toBeLessThan(4000); expect(k2.value).toBeGreaterThan(0.5); expect(k2.value).toBeLessThanOrEqual(1);
    const patch = (await last(page)).intent.patch; expect((await last(page)).intent).toMatchObject({ type: 'editKeyframe', target: { keyframeId: 'k2' } });
    expect(Math.abs(patch.time - k2.time)).toBeLessThanOrEqual(0.5); expect(patch.value).toBe(k2.value); // the store rounds the time to whole ms (§41)
    expect(await undoLabels(page)).toEqual(['Edit items']); expect((await keyframes(page)).map(k => k.id)).toEqual(['k1', 'k2', 'k3']);
    // 60 units right of 2 s on a 540-unit plot of 4 s ≈ +444 ms; 40 units up on a 222-unit plot of 100 % ≈ +18 points.
    expect(k2.time).toBeGreaterThan(2000 + 300); expect(k2.time).toBeLessThan(2000 + 600); expect(k2.value).toBeGreaterThan(0.5 + 0.12); expect(k2.value).toBeLessThan(0.5 + 0.24);
  });
  test('a press and release without moving selects only: no entry', async ({ page }) => {
    const id = await open(page); const before = await stored(page, id), d = dialog(page, 'Opacity Graph Editor'), key = keyBtn(d, 'Opacity keyframe at 2.00s'), c = await centre(key);
    await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.up(); await expect(key).toHaveAttribute('aria-pressed', 'true');
    expect(await undoLabels(page)).toEqual([]); await expectUntouched(page, id, before);
  });
  test('a double-click on the curve adds a linear keyframe there and selects it: one "Edit items" entry', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor'), curve = d.getByLabel('Curve', { exact: true });
    await dblclickOnCurve(page, curve, 0.25); // a quarter along the 100 % → 0 % line: ≈ 1 s, ≈ 75 %
    const list = await keyframes(page); expect(list).toHaveLength(4); const added = list.find(k => !['k1', 'k2', 'k3'].includes(k.id));
    expect(added.easing).toBe('linear'); expect(Math.abs(added.time - 1000)).toBeLessThan(80); expect(Math.abs(added.value - 0.75)).toBeLessThan(0.04);
    expect((await last(page)).intent).toMatchObject({ type: 'addKeyframe', itemId: 'vid', key: 'opacity' });
    await expect(d.getByRole('button', { name: /^Opacity keyframe at 1\.0\ds$/ })).toHaveAttribute('aria-pressed', 'true'); expect(await undoLabels(page)).toEqual(['Edit items']);
  });
  // Wave-3 runtime fixture (5), ticket T04, findings part 3 §45.5: one sequence through the real keyboard. Delete acts on the keyframe while the editor is open and on the clip once it is closed.
  test('wave-3 fixture (5): double-click adds a keyframe, Delete (editor open) removes it, Escape closes, Delete removes the clip ("Delete items")', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor'), curve = d.getByLabel('Curve', { exact: true }); const items = async () => (await liveDoc(page)).items.length; const n = await items();
    await dblclickOnCurve(page, curve, 0.25);
    expect(await undoLabels(page)).toEqual(['Edit items']); const added = (await keyframes(page)).find(k => !['k1', 'k2', 'k3'].includes(k.id));
    expect(added.easing).toBe('linear'); await expect(d.getByRole('button', { name: /^Opacity keyframe at 1\.0\ds$/ })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Delete');
    await expect(d.getByRole('button', { name: /^Opacity keyframe at 1\.0\ds$/ })).toHaveCount(0); expect((await keyframes(page)).map(k => k.id)).toEqual(['k1', 'k2', 'k3']);
    expect(await undoLabels(page)).toEqual(['Edit items', 'Edit items']); expect(await items()).toBe(n);
    await page.keyboard.press('Escape'); await expect(d).toHaveCount(0); expect(await viewState(page, v => v.graph)).toBeNull(); expect(await viewState(page, v => v.selection)).toEqual(['vid']);
    await page.keyboard.press('Delete');
    await expect.poll(items).toBe(n - 1); expect((await undoLabels(page)).at(-1)).toBe('Delete items'); expect((await liveDoc(page)).items.some((i: any) => i.id === 'vid')).toBe(false);
  });
  test('Fit pads the data range by 10 % (provisional choice, not Xapp parity) and Time zoom widens the curve', async ({ page }) => {
    await open(page); const d = dialog(page, 'Opacity Graph Editor'), svg = d.getByRole('group', { name: 'Opacity curve' }), fit = d.getByRole('button', { name: 'Fit', exact: true });
    await expect(fit).toHaveAttribute('aria-pressed', 'false'); await fit.click(); await expect(fit).toHaveAttribute('aria-pressed', 'true');
    const ticks = (await svg.locator('text.graph-tick').allTextContents()).join(' '); expect(ticks).toContain('110%'); expect(ticks).toContain('-10%');
    await fit.click(); await expect(fit).toHaveAttribute('aria-pressed', 'false');
    const zoom = d.getByRole('slider', { name: 'Time zoom' }), w1 = (await svg.boundingBox())!.width; await zoom.fill('4');
    await expect.poll(async () => (await svg.boundingBox())!.width).toBeGreaterThan(w1 * 3.5);
    expect(await undoLabels(page)).toEqual([]);
  });
});

test.describe('Time Remap graph editor (§46.11)', () => {
  const remapDoc = () => t04Doc({ vid: { timeRemap: { defaultValue: 0, keyframes: [kf('r1', 0, 0), kf('r2', 4000, 4000)] } } });
  test('with remap on the button opens "Time Remap Graph Editor" listing only Time Remap; the time axis is wider than the clip with the outside shaded', async ({ page }) => {
    await open(page, opacityDoc({ timeRemap: { defaultValue: 0, keyframes: [kf('r1', 0, 0), kf('r2', 4000, 4000)] } }));
    const d = dialog(page, 'Time Remap Graph Editor'); await expect(d).toBeVisible();
    const list = d.getByRole('group', { name: 'PROPERTIES' }); await expect(list.getByRole('button')).toHaveCount(1); await expect(list.getByRole('button', { name: 'Time Remap 2' })).toHaveAttribute('aria-pressed', 'true');
    await expect(d.locator('.graph-outside')).toHaveCount(2); await expect(d.getByRole('group', { name: 'Time Remap curve' })).toBeVisible();
    await expect(keyBtn(d, 'Time Remap keyframe at 0.00s')).toBeVisible(); await expect(keyBtn(d, 'Time Remap keyframe at 4.00s')).toBeVisible();
    const axis = (await d.getByRole('group', { name: 'Time Remap curve' }).locator('text.graph-tick').allTextContents()).join(' ');
    expect(axis).toContain('-0.40s'); expect(axis).toContain('4.40s'); // 10 % of the 4 s clip either side
  });
  test('a double-click on the remap curve adds a remap keyframe (item-local time, source-time value) in one "Edit items" step', async ({ page }) => {
    await open(page, remapDoc()); const d = dialog(page, 'Time Remap Graph Editor'), curve = d.getByLabel('Curve', { exact: true });
    await dblclickOnCurve(page, curve, 0.35); // on the 0 → 4 s diagonal, away from both keyframes
    const list = await keyframes(page, 'timeRemap'); expect(list).toHaveLength(3); const added = list.find(k => !['r1', 'r2'].includes(k.id));
    expect(added.time).toBeGreaterThan(0); expect(added.time).toBeLessThan(4000); expect(Math.abs(added.value - added.time)).toBeLessThan(120); // the identity line
    expect((await last(page)).intent).toMatchObject({ type: 'addKeyframe', itemId: 'vid', key: 'timeRemap' }); expect(await undoLabels(page)).toEqual(['Edit items']);
    await expect(d.getByRole('button', { name: /^Time Remap keyframe at / })).toHaveCount(3);
  });
  test('Escape closes the remap editor and clears the graph view state', async ({ page }) => {
    await open(page, remapDoc()); await page.keyboard.press('Escape'); await expect(dialog(page, 'Time Remap Graph Editor')).toHaveCount(0);
    expect(await viewState(page, v => v.graph)).toBeNull();
  });
});
