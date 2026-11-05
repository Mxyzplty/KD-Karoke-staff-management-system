// SPDX-License-Identifier: AGPL-3.0-only
// T06 shapes UI: the Shapes panel, the drawing overlay (Rectangle / Star by one drag, Polygon by clicks, Pen Tool), the path editor
// (anchors, mirrored handles, Alt breaks the mirror, delete refused below 3) and the shape inspector bodies. Few flows, each
// combining several checks (tickets T06 runtime fixtures 1 and 2, acceptance UI rows); no matrices. Writes are read back from the
// live document and, after a reload, from the stored one. Nothing here is skipped on CI: the whole file is light (no render, no media).
import { test, expect, type Locator, type Page } from '@playwright/test';
import { presetPoints, shifted } from '../../apps/web/src/timeline/shapes';
import { clearIntents, expectUntouched, intents, notices, openEditor, richDoc, setViewState, skipTour, stored, viewState, watchIntents } from './t02-support';
import { runCanvas } from './t15-support';

type Pt = { x: number; y: number };
const CANVAS_W = 1920;
const shapes = async (page: Page, id: string) => JSON.parse((await stored(page, id)).live).items.filter((i: any) => i.type === 'shape');
const lastShape = async (page: Page, id: string) => (await shapes(page, id)).at(-1);
const panel = (page: Page) => page.getByRole('complementary', { name: 'Inspector and tools' });
const openShapes = (page: Page) => page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Shapes' }).click();
const drawArea = (page: Page) => page.getByRole('application', { name: 'Shape drawing area' });
const pathEditor = (page: Page) => page.getByRole('application', { name: 'Shape path editor' });
const points = (page: Page) => pathEditor(page).getByRole('button', { name: /^Point \d+$/ });
const drawIntents = async (page: Page) => (await intents(page)).filter(l => l.intent.type === 'drawShape');

async function stage(page: Page) {
  const box = (await drawArea(page).boundingBox())!;
  return { box, scale: CANVAS_W / box.width, at: (fx: number, fy: number): Pt => ({ x: box.x + box.width * fx, y: box.y + box.height * fy }) };
}
async function drag(page: Page, a: Pt, b: Pt) {
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up();
}
const centre = async (page: Page, name: string) => { const b = (await pathEditor(page).getByRole('button', { name, exact: true }).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
/** RGBA of what the preview shows at a point in project canvas px. The stage draws one `canvas.run` per layer run (t15-support.ts: run i holds
 *  its own tracks; a shape on an overlay track lands in a later run than the video), so the runs are composited in DOM (z) order, then read. */
const pixel = (page: Page, x: number, y: number) => page.evaluate(([x, y, W]) => {
  const runs = [...document.querySelectorAll<HTMLCanvasElement>('canvas.run')], o = document.createElement('canvas');
  o.width = runs[0].width; o.height = runs[0].height; const g = o.getContext('2d')!;
  for (const c of runs) g.drawImage(c, 0, 0);
  return Array.from(g.getImageData(Math.floor(x * o.width / W), Math.floor(y * o.width / W), 1, 1).data);
}, [x, y, CANVAS_W]);
const repaint = (page: Page) => page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const BLUE = [0x3b, 0x82, 0xf6];
const within = (got: number[], want: number[], tol: number) => got.slice(0, want.length).every((v, k) => Math.abs(v - want[k]) <= tol);
const near = (got: number, want: number, tol = 0.5) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(tol);
/** An inspector section (a <details> with that summary) and its opening: the sections start closed, so a check inside them would be vacuous otherwise. */
const section = (scope: Locator, title: string) => scope.locator('details').filter({ has: scope.page().locator('summary', { hasText: new RegExp(`^${title}$`) }) });
const expandAll = async (insp: Locator) => {
  for (const t of ['Fill', 'Stroke', 'Transform', 'Shape Path']) {
    const d = section(insp, t); if (!(await d.evaluate(e => (e as HTMLDetailsElement).open))) await d.locator('summary').click();
    await expect(d).toHaveJSProperty('open', true);
  }
};
/** Type into a Slider row the way a person does: double-click its value, fill "<label> value", Enter (the value is clamped to the row's range). */
const typeInto = async (scope: Locator, label: string, text: string) => {
  await scope.locator(`[data-slider="${label}"] .slider-value`).dblclick();
  const input = scope.getByRole('textbox', { name: `${label} value` }); await input.fill(text); await input.press('Enter');
};
/** The spec gives shapes no sides / points / inner-ratio control (tickets T06 UI rows): none of these roles carries such a name. */
const noCountControls = async (scope: Locator, what: string) => {
  for (const role of ['spinbutton', 'slider', 'combobox'] as const) await expect(scope.getByRole(role, { name: /sides|points|inner/i }), `${what}: ${role}`).toHaveCount(0);
};
/** A drawn preset against presetPoints in the dragged box, as the stage builds it (shape-ui.tsx up(): shifted to the drag's top-left), every anchor in canvas px (±0.5 from the drag scale) and every handle as stored. */
function expectPreset(shape: any, type: 'star' | 'ellipse', box: { x: number; y: number; w: number; h: number }, count: number) {
  const want = shifted(presetPoints(type, box.w, box.h), box.x, box.y), got = shape.details.points, px = shape.properties.positionX.defaultValue, py = shape.properties.positionY.defaultValue;
  expect(want).toHaveLength(count); expect(got).toHaveLength(count);
  want.forEach((p, k) => {
    near(got[k].anchor.x + px, p.anchor.x); near(got[k].anchor.y + py, p.anchor.y);
    for (const h of ['handleIn', 'handleOut'] as const) { if (p[h]) { near(got[k][h].x, p[h]!.x); near(got[k][h].y, p[h]!.y); } else expect(got[k][h]).toBeUndefined(); }
  });
}

test.describe('T06 shapes UI', () => {
  test.beforeEach(async ({ page }) => { test.setTimeout(150_000); await skipTour(page); });

  test('fixture 1: Draw shows the mode and writes nothing; a click without a drag writes nothing; an empty timeline writes nothing', async ({ page }) => {
    const id = await openEditor(page, richDoc()); await watchIntents(page);
    const before = await stored(page, id);
    await openShapes(page); await panel(page).getByRole('button', { name: 'Draw', exact: true }).click();
    await expect(drawArea(page)).toBeVisible(); await expect(page.getByRole('toolbar', { name: 'Drawing Shape' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Draw', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expectUntouched(page, id, before);
    const { at } = await stage(page), p = at(0.4, 0.4);
    await page.mouse.click(p.x, p.y);                       // a click is a zero-size drag: no shape
    await expect(drawArea(page)).toBeVisible(); expect(await drawIntents(page)).toHaveLength(0); await expectUntouched(page, id, before);
    await page.keyboard.press('Escape');                    // Escape cancels the mode
    await expect(drawArea(page)).toBeHidden(); expect(await drawIntents(page)).toHaveLength(0); await expectUntouched(page, id, before);
    // The ✕ pill cancels the mode the same way: one click, no item.
    await panel(page).getByRole('button', { name: 'Draw', exact: true }).click(); await expect(drawArea(page)).toBeVisible();
    await page.getByRole('toolbar', { name: 'Drawing Shape' }).getByRole('button', { name: 'Cancel drawing' }).click();
    await expect(drawArea(page)).toBeHidden(); expect(await drawIntents(page)).toHaveLength(0); await expectUntouched(page, id, before);

    // No item on the timeline: the drag ends the mode and nothing is created.
    const empty = await openEditor(page, { ...richDoc(), items: [], markers: [] }, 'T06 empty'); await watchIntents(page);
    const emptyBefore = await stored(page, empty);
    await openShapes(page); await panel(page).getByRole('button', { name: 'Draw', exact: true }).click();
    const s = await stage(page); await drag(page, s.at(0.2, 0.2), s.at(0.5, 0.5));
    await expect(drawArea(page)).toBeHidden(); expect(await drawIntents(page)).toHaveLength(0);
    await expectUntouched(page, empty, emptyBefore);
  });

  test('fixture 2 and the panel: Rectangle and Star by one drag in artboard scale; Transparent, stroke width clamps', async ({ page }) => {
    const id = await openEditor(page, richDoc()); await watchIntents(page);
    await setViewState(page, { playheadMs: 1234 });          // not on a frame boundary: the start-frame rule shows
    await openShapes(page);
    // Panel: Transparent hides the Opacity slider; stroke width clamps to 0–50.
    const opacity = panel(page).getByRole('slider', { name: 'Opacity' });
    await expect(opacity).toBeVisible();
    // First open: fill #3b82f6, Opacity 100, Transparent off, stroke #000000, width 0 (read from the controls, not the document).
    await expect(panel(page).getByRole('button', { name: 'Fill colour: #3b82f6' })).toBeVisible();
    await expect(opacity).toHaveAttribute('aria-valuenow', '100'); await expect(panel(page).locator('[data-slider="Opacity"] .slider-value')).toHaveText('100');
    await expect(panel(page).getByRole('checkbox', { name: 'Transparent' })).not.toBeChecked();
    await expect(panel(page).getByRole('button', { name: 'Stroke colour: #000000' })).toBeVisible();
    await expect(panel(page).getByRole('spinbutton', { name: 'Stroke width' })).toHaveValue('0');
    // The Fill colour picker is solid only: no Gradient tab (controls.tsx `gradient` is off here).
    await panel(page).getByRole('button', { name: 'Fill colour: #3b82f6' }).click();
    await expect(panel(page).getByRole('dialog', { name: 'Fill colour colour' })).toBeVisible();
    await expect(panel(page).getByRole('tab', { name: 'Gradient' })).toHaveCount(0); await expect(panel(page).getByRole('dialog', { name: 'Fill colour colour' }).getByRole('tablist')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(panel(page).getByRole('dialog')).toHaveCount(0);
    // No sides / points / inner-ratio control for any shape type.
    const typeBox = panel(page).getByRole('combobox', { name: 'Shape type' });
    for (const t of ['rectangle', 'ellipse', 'polygon', 'star']) { await typeBox.selectOption(t); await expect(typeBox).toHaveValue(t); await noCountControls(panel(page), `panel, ${t}`); }
    await typeBox.selectOption('rectangle');
    await panel(page).getByRole('checkbox', { name: 'Transparent' }).check(); await expect(opacity).toHaveCount(0);
    const width = panel(page).getByRole('spinbutton', { name: 'Stroke width' });
    await width.fill('99'); await expect(width).toHaveValue('50');
    await width.fill('-5'); await expect(width).toHaveValue('0');

    // Rectangle by one drag, Transparent on.
    await panel(page).getByRole('button', { name: 'Draw', exact: true }).click();
    const s = await stage(page), a = s.at(0.25, 0.25), b = s.at(0.5, 0.5);
    const mid = (p: Pt, q: Pt) => [((p.x + q.x) / 2 - s.box.x) * s.scale, ((p.y + q.y) / 2 - s.box.y) * s.scale] as const;
    await expect(runCanvas(page)).toBeVisible(); await repaint(page);
    const behind = await pixel(page, ...mid(a, b));         // what the stage shows at the rectangle's centre before any shape exists
    await clearIntents(page); await drag(page, a, b);
    await expect(drawArea(page)).toBeHidden();
    const drawn = await drawIntents(page); expect(drawn).toHaveLength(1);
    expect(drawn[0].intent).toMatchObject({ shapeType: 'rectangle' }); expect(drawn[0].outcome.ok).toBe(true);
    let shape = await lastShape(page, id);
    expect(shape.metadata.shapeType).toBe('rectangle');
    // Starts at the playhead's frame (stored in whole ms): floor(playhead × fps / 1000 + 1e-6) frames.
    const playhead = await viewState(page, v => v.playheadMs as number), fps = JSON.parse((await stored(page, id)).live).fps as number;
    expect(playhead).toBe(1234); expect(shape.display.from).toBe(Math.round(Math.floor(playhead * fps / 1000 + 1e-6) * 1000 / fps));
    near(shape.details.width, (b.x - a.x) * s.scale); near(shape.details.height, (b.y - a.y) * s.scale);
    near(shape.properties.positionX.defaultValue, (a.x - s.box.x) * s.scale); near(shape.properties.positionY.defaultValue, (a.y - s.box.y) * s.scale);
    expect(shape.properties.fillOpacity.defaultValue).toBe(0);                // Transparent → fillOpacity 0
    expect(shape.properties.fillColor.defaultValue).toBe('#3b82f6');          // the colour is kept (Q6)
    expect(shape.properties.strokeColor.defaultValue).toBe('none');           // width 0 → no stroke
    // Transparent: the drawn shape has no fill. The centre pixel is the one seen before the shape existed (±2 per channel) and not the fill blue.
    await repaint(page);
    await expect.poll(async () => { const p = await pixel(page, ...mid(a, b)); return within(p, behind, 2) && !within(p, BLUE, 40); }, { timeout: 10000, message: 'transparent rectangle centre' }).toBe(true);

    // Star by one drag, Transparent off.
    await openShapes(page);
    await panel(page).getByRole('checkbox', { name: 'Transparent' }).uncheck(); await expect(opacity).toBeVisible();
    await panel(page).getByRole('combobox', { name: 'Shape type' }).selectOption('star');
    await setViewState(page, { playheadMs: 10000 });        // exactly on a frame, 5 s before the end of the 15 s span: from 10000, to 15000
    await panel(page).getByRole('button', { name: 'Draw', exact: true }).click();
    const c = s.at(0.6, 0.2), d = s.at(0.8, 0.5);
    await drag(page, c, d);
    shape = await lastShape(page, id);
    expect(shape.metadata.shapeType).toBe('star'); expect(shape.details.points).toHaveLength(10);
    expect(shape.display).toEqual({ from: 10000, to: 15000 });
    // Opaque star: its box centre (inside the inner radius) is the fill blue ±8 per channel; the playback is paused (the playhead stays 10000).
    await expect.poll(async () => within(await pixel(page, ...mid(c, d)), BLUE, 8), { timeout: 10000, message: 'star centre is #3b82f6' }).toBe(true);
    expect(await viewState(page, v => v.playheadMs as number)).toBe(10000);
    expect(shape.properties.fillOpacity.defaultValue).toBe(1);
    // The star is regular in its box (R = min(w, h) / 2, inner 0.4 R): the stored points are presetPoints in the dragged box, whole list.
    expectPreset(shape, 'star', { x: (c.x - s.box.x) * s.scale, y: (c.y - s.box.y) * s.scale, w: (d.x - c.x) * s.scale, h: (d.y - c.y) * s.scale }, 10);
    near(shape.details.height, Math.min(d.x - c.x, d.y - c.y) * s.scale / 2 * (1 + Math.cos(Math.PI / 5)), 1);
    expect(await shapes(page, id)).toHaveLength(2);
    // The inspector on the star: no sides / points / inner-ratio control, and the Shape Path section is really open.
    const insp = panel(page); await expandAll(insp);
    await expect(insp.getByRole('button', { name: 'Add path keyframe' })).toBeVisible(); await noCountControls(insp, 'inspector, star');

    // Ellipse by one drag: 4 anchors with handles, the same layout as presetPoints (a circle's bezier).
    await openShapes(page); await panel(page).getByRole('combobox', { name: 'Shape type' }).selectOption('ellipse');
    await panel(page).getByRole('button', { name: 'Draw', exact: true }).click();
    const e1 = s.at(0.1, 0.55), e2 = s.at(0.3, 0.8);
    await drag(page, e1, e2);
    shape = await lastShape(page, id);
    expect(shape.metadata.shapeType).toBe('ellipse'); expect(shape.details.closed).toBe(true);
    expect(shape.details.points.every((p: any) => p.handleIn && p.handleOut)).toBe(true);
    expectPreset(shape, 'ellipse', { x: (e1.x - s.box.x) * s.scale, y: (e1.y - s.box.y) * s.scale, w: (e2.x - e1.x) * s.scale, h: (e2.y - e1.y) * s.scale }, 4);
    expect(await shapes(page, id)).toHaveLength(3);
  });

  test('Polygon, Pen Tool, path edit round trip, delete refused below 3, inspector bodies, path keyframe, Escape', async ({ page }) => {
    const id = await openEditor(page, richDoc()); await watchIntents(page);
    await openShapes(page);
    await panel(page).getByRole('combobox', { name: 'Shape type' }).selectOption('polygon');
    await panel(page).getByRole('button', { name: 'Draw', exact: true }).click();
    const s = await stage(page); await clearIntents(page);
    for (const [fx, fy] of [[0.1, 0.6], [0.2, 0.6], [0.25, 0.75], [0.2, 0.9]]) { const p = s.at(fx, fy); await page.mouse.click(p.x, p.y); }
    expect(await drawIntents(page)).toHaveLength(0);                         // nothing is written before the shape ends
    const last = s.at(0.1, 0.9); await page.mouse.dblclick(last.x, last.y);
    await expect(pathEditor(page)).toBeVisible(); await expect(points(page)).toHaveCount(5);
    let poly = await lastShape(page, id);
    // Exactly the clicked points, in click order (the double-click point last): anchor + position = (click − artboard origin) × scale.
    const clicks = [s.at(0.1, 0.6), s.at(0.2, 0.6), s.at(0.25, 0.75), s.at(0.2, 0.9), last];
    clicks.forEach((c, n) => {
      near(poly.details.points[n].anchor.x + poly.properties.positionX.defaultValue, (c.x - s.box.x) * s.scale);
      near(poly.details.points[n].anchor.y + poly.properties.positionY.defaultValue, (c.y - s.box.y) * s.scale);
    });
    expect(poly.metadata.shapeType).toBe('polygon'); expect(poly.details.closed).toBe(true); expect(poly.details.points).toHaveLength(5);
    expect(poly.details.points.every((p: any) => !p.handleIn && !p.handleOut)).toBe(true);

    // Drag an anchor 40 screen px right: one "Edit items", the stored point moved by 40 × scale.
    const first = poly.details.points[1].anchor.x + poly.properties.positionX.defaultValue, p1 = await centre(page, 'Point 2');
    await clearIntents(page); await drag(page, p1, { x: p1.x + 40, y: p1.y });
    expect((await intents(page)).filter(l => l.intent.type === 'editShapePath')).toHaveLength(1);
    poly = await lastShape(page, id);
    near(poly.details.points[1].anchor.x + poly.properties.positionX.defaultValue, first + 40 * s.scale, 1);

    // Delete down to 3 points, then the next delete is refused with the notice and writes nothing.
    for (let n = 0; n < 2; n++) { await pathEditor(page).getByRole('button', { name: 'Point 2', exact: true }).click(); await page.keyboard.press('Delete'); }
    await expect(points(page)).toHaveCount(3);
    const sizeBefore = (await lastShape(page, id)).details.points.length;
    await pathEditor(page).getByRole('button', { name: 'Point 2', exact: true }).click(); await clearIntents(page); await page.keyboard.press('Delete');
    await expect(notices(page)).toContainText('Minimum 3 points required');
    expect((await intents(page)).at(-1)!.outcome).toMatchObject({ ok: false, code: 'MINIMUM_POINTS_REQUIRED' });
    await expect(points(page)).toHaveCount(3); expect((await lastShape(page, id)).details.points).toHaveLength(sizeBefore);
    for (const b of await notices(page).getByRole('button', { name: /^Dismiss/ }).all()) await b.click();

    // Inspector bodies on the polygon: Fill Enabled off → none; Stroke Enabled on → #000000 / 0; the 2 centre buttons.
    const insp = panel(page);
    await expandAll(insp);
    await noCountControls(insp, 'inspector, polygon');
    await insp.getByRole('switch', { name: 'Fill Enabled' }).click();
    expect((await lastShape(page, id)).properties.fillColor.defaultValue).toBe('none');
    await insp.getByRole('switch', { name: 'Fill Enabled' }).click();
    expect((await lastShape(page, id)).properties.fillColor.defaultValue).toBe('#3b82f6');
    // The Fill % row: typed 40 → fillOpacity 0.4; 150 is clamped to 100 → 1. The Fill colour picker has no Gradient tab.
    const fill = section(insp, 'Fill');
    await expect(fill.getByRole('slider', { name: 'Fill' })).toHaveAttribute('aria-valuenow', '100');
    await typeInto(fill, 'Fill', '40');
    await expect.poll(async () => (await lastShape(page, id)).properties.fillOpacity.defaultValue).toBe(0.4);
    await expect(fill.getByRole('slider', { name: 'Fill' })).toHaveAttribute('aria-valuenow', '40');
    await typeInto(fill, 'Fill', '150');
    await expect.poll(async () => (await lastShape(page, id)).properties.fillOpacity.defaultValue).toBe(1);
    await expect(fill.getByRole('slider', { name: 'Fill' })).toHaveAttribute('aria-valuenow', '100'); await expect(fill.locator('.slider-value')).toHaveText('100%');
    await fill.getByRole('button', { name: 'Fill colour: #3b82f6' }).click();
    await expect(insp.getByRole('dialog', { name: 'Fill colour colour' })).toBeVisible();
    await expect(insp.getByRole('tab', { name: 'Gradient' })).toHaveCount(0); await expect(insp.getByRole('dialog', { name: 'Fill colour colour' }).getByRole('tablist')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(insp.getByRole('dialog', { name: 'Fill colour colour' })).toHaveCount(0);   // Escape goes to the open popover first, not to the path editor
    await expect(pathEditor(page)).toBeVisible(); await expect(points(page)).toHaveCount(3);                                   // path editing is still on
    await insp.getByRole('switch', { name: 'Stroke Enabled' }).click();
    poly = await lastShape(page, id); expect(poly.properties.strokeColor.defaultValue).toBe('#000000'); expect(poly.properties.strokeWidth.defaultValue).toBe(0);
    // The Stroke section shows colour #000000 and Width 0 as controls; a typed Width is clamped to 0–50 (99 → 50, -5 → 0) and stored.
    const stroke = section(insp, 'Stroke');
    await expect(stroke.getByRole('button', { name: 'Stroke colour: #000000' })).toBeVisible();
    await expect(stroke.getByRole('slider', { name: 'Width' })).toHaveAttribute('aria-valuenow', '0'); await expect(stroke.locator('[data-slider="Width"] .slider-value')).toHaveText('0px');
    await typeInto(stroke, 'Width', '99');
    await expect(stroke.locator('[data-slider="Width"] .slider-value')).toHaveText('50px');
    await expect.poll(async () => (await lastShape(page, id)).properties.strokeWidth.defaultValue).toBe(50);
    await typeInto(stroke, 'Width', '-5');
    await expect(stroke.locator('[data-slider="Width"] .slider-value')).toHaveText('0px');
    await expect.poll(async () => (await lastShape(page, id)).properties.strokeWidth.defaultValue).toBe(0);
    await insp.getByRole('button', { name: 'Centre horizontally' }).click(); await insp.getByRole('button', { name: 'Centre vertically' }).click();
    poly = await lastShape(page, id);
    const w = Math.abs(poly.details.width * poly.properties.scale.defaultValue), h = Math.abs(poly.details.height * poly.properties.scale.defaultValue);
    near(poly.properties.positionX.defaultValue, (CANVAS_W - w) / 2, 0.01); near(poly.properties.positionY.defaultValue, (1080 - h) / 2, 0.01);

    // Add path keyframe: disabled with the playhead outside the clip, adds 1 inside.
    const add = insp.getByRole('button', { name: 'Add path keyframe' });
    await setViewState(page, { playheadMs: 12000 }); await expect(add).toBeDisabled();
    await setViewState(page, { playheadMs: 2000 }); await expect(add).toBeEnabled(); await add.click();
    await expect(insp.getByText('1 path keyframe')).toBeVisible();
    await page.getByRole('toolbar', { name: 'Editing path' }).getByRole('button', { name: 'Done' }).click(); await expect(pathEditor(page)).toBeHidden();

    // Pen Tool: click, a dragged anchor (mirrored handles), click, then the first point closes → a closed custom path.
    await setViewState(page, { playheadMs: 0 });
    await openShapes(page); await panel(page).getByRole('button', { name: 'Pen Tool' }).click();
    const a = s.at(0.6, 0.6), b = s.at(0.75, 0.6), c = s.at(0.7, 0.8);
    await page.mouse.click(a.x, a.y); await drag(page, b, { x: b.x + 30, y: b.y + 20 }); await page.mouse.click(c.x, c.y);
    await page.mouse.click(a.x + 2, a.y + 2);
    await expect(pathEditor(page)).toBeVisible(); await expect(points(page)).toHaveCount(3);
    let pen = await lastShape(page, id);
    expect(pen.metadata.shapeType).toBe('custom'); expect(pen.details.closed).toBe(true); expect(pen.details.points).toHaveLength(3);
    const dragged = pen.details.points[1];
    expect(dragged.handleOut).toBeTruthy(); near(dragged.handleOut.x, 30 * s.scale, 1); near(dragged.handleIn.x, -30 * s.scale, 1);
    near(dragged.handleOut.y, 20 * s.scale, 1); near(dragged.handleIn.y, -20 * s.scale, 1);
    expect(pen.details.points[0].handleOut).toBeUndefined();

    // Edit the handle: mirrored; with Alt held at the press, not mirrored. Then reload and the stored points survive.
    const hOut = await centre(page, 'Point 2 out handle');
    await drag(page, hOut, { x: hOut.x + 20, y: hOut.y });
    pen = await lastShape(page, id); let moved = pen.details.points[1];
    near(moved.handleOut.x, dragged.handleOut.x + 20 * s.scale, 1); near(moved.handleIn.x, -moved.handleOut.x, 0.02); near(moved.handleIn.y, -moved.handleOut.y, 0.02);
    const hOut2 = await centre(page, 'Point 2 out handle'), mirrored = pen.details.points[1].handleIn;
    await page.keyboard.down('Alt'); await drag(page, hOut2, { x: hOut2.x, y: hOut2.y + 25 }); await page.keyboard.up('Alt');
    pen = await lastShape(page, id); moved = pen.details.points[1];
    near(moved.handleIn.x, mirrored.x, 0.02); near(moved.handleIn.y, mirrored.y, 0.02);       // the other handle did not follow
    near(moved.handleOut.y, mirrored.y * -1 + 25 * s.scale, 1.5);
    await expect(page.getByRole('status')).toHaveText('Saved locally');
    const saved = JSON.parse((await stored(page, id)).json).items.filter((i: any) => i.type === 'shape').map((i: any) => i.details.points);
    await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
    const reloaded = JSON.parse((await stored(page, id)).json).items.filter((i: any) => i.type === 'shape').map((i: any) => i.details.points);
    expect(reloaded).toStrictEqual(saved); expect(reloaded.at(-1)[1].handleOut.x).toBeCloseTo(moved.handleOut.x, 2);

    // Escape cancels an unfinished pen path and creates nothing.
    const count = (await shapes(page, id)).length;
    await openShapes(page); await panel(page).getByRole('button', { name: 'Pen Tool' }).click();
    const q = s.at(0.4, 0.4); await page.mouse.click(q.x, q.y); await page.mouse.click(q.x + 40, q.y);
    await page.keyboard.press('Escape'); await expect(drawArea(page)).toBeHidden();
    expect(await shapes(page, id)).toHaveLength(count);

    // Enter confirms an open pen path (P18): 2 clicks, no drag → one custom, not closed item, anchors at the click px × scale, no handles, mode ends.
    await openShapes(page); await panel(page).getByRole('button', { name: 'Pen Tool' }).click();
    const o1 = s.at(0.3, 0.3), o2 = s.at(0.45, 0.4);
    await page.mouse.click(o1.x, o1.y); await page.mouse.click(o2.x, o2.y); await page.keyboard.press('Enter');
    await expect(drawArea(page)).toBeHidden(); await expect(pathEditor(page)).toBeVisible(); await expect(points(page)).toHaveCount(2);
    expect(await shapes(page, id)).toHaveLength(count + 1);
    const open = await lastShape(page, id), ox = open.properties.positionX.defaultValue, oy = open.properties.positionY.defaultValue;
    expect(open.metadata.shapeType).toBe('custom'); expect(open.details.closed).toBe(false); expect(open.details.points).toHaveLength(2);
    [o1, o2].forEach((o, n) => {
      near(open.details.points[n].anchor.x + ox, (o.x - s.box.x) * s.scale); near(open.details.points[n].anchor.y + oy, (o.y - s.box.y) * s.scale);
      expect(open.details.points[n].handleIn).toBeUndefined(); expect(open.details.points[n].handleOut).toBeUndefined();
    });

    // One click, then Enter: the mode ends and nothing is written.
    await watchIntents(page);                                  // the reload dropped the observer
    await page.getByRole('toolbar', { name: 'Editing path' }).getByRole('button', { name: 'Done' }).click(); await expect(pathEditor(page)).toBeHidden();
    await expect(page.getByRole('status')).toHaveText('Saved locally');
    const before = await stored(page, id); await clearIntents(page);
    await openShapes(page); await panel(page).getByRole('button', { name: 'Pen Tool' }).click();
    const one = s.at(0.5, 0.2); await page.mouse.click(one.x, one.y); await page.keyboard.press('Enter');
    await expect(drawArea(page)).toBeHidden(); await expect(pathEditor(page)).toBeHidden();
    expect(await drawIntents(page)).toHaveLength(0); await expectUntouched(page, id, before);

    // The ✓ pill finishes a polygon without a double-click: 3 clicks, one press → one closed polygon with exactly those 3 points, mode ends.
    const n0 = (await shapes(page, id)).length;
    await openShapes(page); await panel(page).getByRole('combobox', { name: 'Shape type' }).selectOption('polygon');
    await panel(page).getByRole('button', { name: 'Draw', exact: true }).click();
    const tri = [s.at(0.6, 0.3), s.at(0.72, 0.3), s.at(0.66, 0.42)];
    for (const p of tri) await page.mouse.click(p.x, p.y);
    expect(await drawIntents(page)).toHaveLength(0);
    await page.getByRole('toolbar', { name: 'Drawing Shape' }).getByRole('button', { name: 'Confirm drawing' }).click();
    await expect(drawArea(page)).toBeHidden(); await expect(pathEditor(page)).toBeVisible(); await expect(points(page)).toHaveCount(3);
    expect(await drawIntents(page)).toHaveLength(1);
    expect(await shapes(page, id)).toHaveLength(n0 + 1);
    const triShape = await lastShape(page, id);
    expect(triShape.metadata.shapeType).toBe('polygon'); expect(triShape.details.closed).toBe(true); expect(triShape.details.points).toHaveLength(3);
    tri.forEach((t, n) => {
      near(triShape.details.points[n].anchor.x + triShape.properties.positionX.defaultValue, (t.x - s.box.x) * s.scale);
      near(triShape.details.points[n].anchor.y + triShape.properties.positionY.defaultValue, (t.y - s.box.y) * s.scale);
    });
  });
});
