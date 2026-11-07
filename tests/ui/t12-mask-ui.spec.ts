// SPDX-License-Identifier: AGPL-3.0-only
// T12 mask UI: the "Editing path" stage overlay (Add Mask, Shape tool, Pen Tool, the shape list, Apply/Cancel), the layer
// card's fields, the M/A/I/Esc/Enter/Delete keys, and the smart-mask brush (stubbed engine: no real model run). Ticket
// T12 wave-3 fixtures (l.162-165). Project size 1280x534 (the ticket's test-clip size), one video item with no box
// overrides, so itemBox is the identity: item-local ("source") px is project-canvas px, exactly as t12-render.spec.ts.
import { test, expect, type Page } from '@playwright/test';
import { presetPoints, shifted } from '../../apps/web/src/timeline/shapes';
import {
  addAsset, clearIntents, clip, createProject, expectUntouched, intents, linkClip, notices, skipTour, stored, viewState, watchIntents, zoomNow,
} from './t02-support';
import { setParity } from './t17-support';

type Pt = { x: number; y: number };
const W = 1280, H = 534;

function maskDoc(): Record<string, unknown> {
  return {
    schemaVersion: 4, rev: 0, groups: {}, duration: 4000, fps: 30, size: { width: W, height: H }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks: [{ id: 'v1', name: 'V1', kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1 }],
    layerOrder: [{ type: 'track', id: 'v1' }],
    items: [{ id: 'vid1', type: 'video', trackId: 'v1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000, details: { name: 'Clip' } }],
  };
}
/** An image item (not a video): the smart tool refuses it. */
function imageDoc(): Record<string, unknown> {
  const doc = maskDoc();
  (doc.items as any[])[0] = { id: 'img1', type: 'image', trackId: 'v1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, details: { name: 'Photo' } };
  return doc;
}
async function openMaskEditor(page: Page, doc: Record<string, unknown>) {
  const id = await createProject(page, doc, 'T12 fixture');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return id;
}
/** A video asset with usable media.video dimensions, linked to the item: addAsset's upload (a PNG, no ffmpeg needed)
 *  patched with media.video so the smart brush (which needs an asset) renders. */
async function addVideoAsset(page: Page, projectId: string, itemId: string) {
  const assetId = await addAsset(page, projectId, 'clip.mp4');
  await page.evaluate(async ({ assetId, width, height }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    await projectStore.updateAsset(assetId, (a: any) => ({ ...a, media: { ...a.media, video: { displayWidth: width, displayHeight: height, durationMs: 4000, fps: 30 } } }));
  }, { assetId, width: W, height: H });
  await linkClip(page, projectId, assetId, itemId);
  return assetId;
}
/** Stubs the mask engine for this page load: 'preview' resolves with a tiny PNG; 'track'/'text' never resolve (these
 *  tests only check that a job appears and that Cancel attaches nothing, not a successful run). */
async function stubEngine(page: Page) {
  await page.evaluate(async () => {
    const p = '/src/masks/jobs.ts'; const { useMaskEngine } = await import(p);
    (window as any).__engineCalls = [];
    useMaskEngine(async () => ({
      async run(request: any) {
        (window as any).__engineCalls.push(request);
        if (request.task === 'preview') return { png: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) };
        return new Promise(() => { /* never settles */ });
      },
      close() { /* no engine to release */ },
    }));
  });
}
const engineCalls = (page: Page) => page.evaluate(() => (window as any).__engineCalls ?? []);

const liveDoc = async (page: Page, id: string) => JSON.parse((await stored(page, id)).live);
const itemMasks = async (page: Page, id: string, itemId = 'vid1') => ((await liveDoc(page, id)).items.find((i: any) => i.id === itemId)?.masks ?? []);
const maskEdits = async (page: Page) => (await intents(page)).filter(l => l.intent.type === 'maskEdit');

const panel = (page: Page) => page.getByRole('complementary', { name: 'Inspector and tools' });
const maskEditor = (page: Page) => page.getByRole('application', { name: 'Mask editor' });
const pathToolbar = (page: Page) => page.getByRole('toolbar', { name: 'Editing path' });
const points = (page: Page) => maskEditor(page).getByRole('button', { name: /^Point \d+$/ });
const smartBrush = (page: Page) => page.getByRole('application', { name: 'Smart mask brush' });
const smartToolbar = (page: Page) => page.getByRole('toolbar', { name: 'Smart mask' });
const openMask = async (page: Page) => { await panel(page).locator('summary', { hasText: 'Mask' }).click(); };

async function stage(svg: ReturnType<typeof maskEditor>) {
  const box = (await svg.boundingBox())!;
  return { box, scale: W / box.width, at: (fx: number, fy: number): Pt => ({ x: box.x + box.width * fx, y: box.y + box.height * fy }) };
}
async function drag(page: Page, a: Pt, b: Pt, { alt = false }: { alt?: boolean } = {}) {
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}
const near = (got: number, want: number, tol = 0.5) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(tol);
/** masks[n]'s anchors/handles against presetPoints shifted into the drag box, item-local == canvas px here (identity box). */
function expectEllipse(mask: any, box: { x: number; y: number; w: number; h: number }) {
  const want = shifted(presetPoints('ellipse', box.w, box.h), box.x, box.y);
  expect(mask.points).toHaveLength(4);
  want.forEach((p, k) => {
    near(mask.points[k].anchor.x, p.anchor.x); near(mask.points[k].anchor.y, p.anchor.y);
    for (const h of ['handleIn', 'handleOut'] as const) { near(mask.points[k][h].x, p[h]!.x); near(mask.points[k][h].y, p[h]!.y); }
  });
}

test.describe('T12 mask UI', () => {
  test.beforeEach(async ({ page }) => { test.setTimeout(150_000); await skipTour(page); });

  test('fixtures 1, 2, 4: Add Mask opens empty and writes nothing; a drag with no mask writes nothing; the shape list order; Shape tool (ellipse, default) draws masks[0]; Apply mask afterwards writes nothing', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc()); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    const before = await stored(page, id);

    // Fixture 1: Add Mask opens the path editor (no mask selected) and writes nothing by itself.
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await expect(maskEditor(page)).toBeVisible(); await expect(pathToolbar(page)).toBeVisible();
    expect(await maskEdits(page)).toHaveLength(0); await expectUntouched(page, id, before);

    // A drag on the path tool with nothing to edit writes nothing.
    const s = await stage(maskEditor(page));
    await drag(page, s.at(0.2, 0.2), s.at(0.6, 0.6));
    expect(await maskEdits(page)).toHaveLength(0); await expectUntouched(page, id, before);

    // Fixture 4: the shape list, Ellipse first (the default), then SHAPE_TYPES' own order.
    await pathToolbar(page).getByRole('button', { name: 'Shape', exact: true }).click();
    await expect(pathToolbar(page).getByRole('button', { name: 'Shape', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const shapeSelect = pathToolbar(page).getByRole('combobox', { name: 'Mask shape' });
    await expect(shapeSelect).toHaveValue('ellipse');
    expect(await shapeSelect.locator('option').allTextContents()).toEqual(['Ellipse', 'Rectangle', 'Triangle', 'Pentagon', 'Star', 'Heart']);

    // Fixture 2: one drag draws an ellipse mask (masks[0]).
    await clearIntents(page);
    const a = s.at(0.2, 0.3), b = s.at(0.6, 0.75);
    await drag(page, a, b);
    const edits = await maskEdits(page);
    expect(edits).toHaveLength(1); expect(edits[0].outcome.ok).toBe(true);
    const masks = await itemMasks(page, id);
    expect(masks).toHaveLength(1);
    const mask = masks[0];
    expect(mask).toMatchObject({ name: 'Mask 1', enabled: true, closed: true, mode: 'add', order: 0, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape' });
    expect(mask.keyframes).toBeUndefined();
    const box = { x: (a.x - s.box.x) * s.scale, y: (a.y - s.box.y) * s.scale, w: (b.x - a.x) * s.scale, h: (b.y - a.y) * s.scale };
    expectEllipse(mask, box);
    // The editor returns to the path tool on the new mask; the Shape pill is no longer pressed.
    await expect(pathToolbar(page).getByRole('button', { name: 'Shape', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Apply mask afterwards (path tool, not pen) writes nothing and closes the editor.
    await clearIntents(page);
    await pathToolbar(page).getByRole('button', { name: 'Apply mask (Enter)' }).click();
    expect(await maskEdits(page)).toHaveLength(0);
    await expect(maskEditor(page)).toBeHidden();
    expect(await itemMasks(page, id)).toHaveLength(1);
  });

  test('fixture 3: Mask Layers "+" and Pen Tool, 4 clicks and a click on the first point, draw masks[1]', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc()); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    const s = await stage(maskEditor(page));
    await pathToolbar(page).getByRole('button', { name: 'Shape', exact: true }).click();
    await drag(page, s.at(0.2, 0.3), s.at(0.6, 0.75)); // masks[0], as in the previous fixture
    expect(await itemMasks(page, id)).toHaveLength(1);

    await panel(page).getByRole('button', { name: 'Add mask layer' }).click(); // "+"
    await expect(maskEditor(page)).toBeVisible();
    await pathToolbar(page).getByRole('button', { name: 'Pen Tool' }).click();
    await expect(pathToolbar(page).getByRole('button', { name: 'Pen Tool' })).toHaveAttribute('aria-pressed', 'true');
    await clearIntents(page);
    const pts = [s.at(0.15, 0.4), s.at(0.45, 0.35), s.at(0.4, 0.65), s.at(0.18, 0.6)]; // kept clear of the "Editing path" pill (top: 8px, centered)
    for (const p of pts) await page.mouse.click(p.x, p.y);
    expect(await maskEdits(page)).toHaveLength(0); // nothing written before the closing click
    await page.mouse.click(pts[0].x, pts[0].y); // closes on the first point

    const edits = await maskEdits(page);
    expect(edits).toHaveLength(1); expect(edits[0].outcome.ok).toBe(true);
    const masks = await itemMasks(page, id);
    expect(masks).toHaveLength(2);
    const mask = masks[1];
    expect(mask).toMatchObject({ name: 'Mask 2', enabled: true, closed: true, mode: 'add', order: 1, colorIndex: 1, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape' });
    expect(mask.points).toHaveLength(4);
    expect(mask.points.every((p: any) => !p.handleIn && !p.handleOut)).toBe(true);
    pts.forEach((p, k) => { near(mask.points[k].anchor.x, (p.x - s.box.x) * s.scale); near(mask.points[k].anchor.y, (p.y - s.box.y) * s.scale); });
  });

  test('fixture 5: the layer card’s fields', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc()); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    const s = await stage(maskEditor(page));
    await pathToolbar(page).getByRole('button', { name: 'Shape', exact: true }).click();
    await drag(page, s.at(0.2, 0.3), s.at(0.6, 0.75));
    await pathToolbar(page).getByRole('button', { name: 'Apply mask (Enter)' }).click();
    expect(await itemMasks(page, id)).toHaveLength(1);

    const card = panel(page).getByRole('group', { name: 'Mask 1' });
    await expect(card.locator('h4', { hasText: 'Mask 1' })).toBeVisible();
    await expect(card.locator('.chip', { hasText: 'Manual' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Hide Mask 1' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Delete Mask 1' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Move Mask 1 up' })).toBeDisabled();   // only layer: both ends disabled
    await expect(card.getByRole('button', { name: 'Move Mask 1 down' })).toBeDisabled();
    await expect(card.getByRole('combobox', { name: 'Mask mode' })).toHaveValue('add');
    await expect(card.getByRole('switch', { name: 'Invert' })).not.toBeChecked();
    for (const [label, value, unit] of [['Feather', '0', 'px'], ['Expansion', '0', 'px'], ['Opacity', '100', '%']] as const) {
      await expect(card.getByRole('slider', { name: label })).toHaveAttribute('aria-valuenow', value);
      await expect(card.locator(`[data-slider="${label}"] .slider-value`)).toHaveText(`${value}${unit}`);
      await expect(card.getByRole('button', { name: `Add ${label} keyframe` })).toBeVisible();
    }
    await expect(card.getByRole('button', { name: 'Add Path keyframe' })).toBeVisible(); // a shape (non-smart) mask has a Path row too
  });

  test('parity mode: M with a video selected opens the mask editor and adds the marker too', async ({ page }) => {
    const id = await createProject(page, maskDoc(), 'T12 fixture');
    await setParity(page);
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await clip(page, 'vid1').click();
    await page.keyboard.press('m');
    await expect(maskEditor(page)).toBeVisible();
    await expect.poll(async () => (await liveDoc(page, id)).markers.length).toBe(1);
  });

  test('wave-3 check: each shape of the list draws by a drag and applies with Enter', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc());
    await clip(page, 'vid1').click(); await openMask(page);
    for (const [k, shape] of (['ellipse', 'rectangle', 'triangle', 'pentagon', 'star', 'heart'] as const).entries()) {
      await panel(page).getByRole('button', { name: 'Add Mask', exact: true }).click();
      const s = await stage(maskEditor(page));
      await pathToolbar(page).getByRole('button', { name: 'Shape', exact: true }).click();
      await pathToolbar(page).getByRole('combobox', { name: 'Mask shape' }).selectOption(shape);
      await drag(page, s.at(0.2, 0.35), s.at(0.5, 0.65));
      await page.keyboard.press('Enter');
      await expect(maskEditor(page)).toBeHidden();
      const masks = await itemMasks(page, id);
      expect(masks).toHaveLength(k + 1);
      expect(masks[k].points).toHaveLength(presetPoints(shape, 100, 100).length);
    }
  });

  test('fixture 6: M enters mask edit without a marker (and adds one with nothing selected); A, I, Esc, Enter, Delete', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc()); await watchIntents(page);
    await page.keyboard.press('m'); await page.keyboard.press('m'); // nothing selected: two presses, two markers
    expect((await liveDoc(page, id)).markers).toHaveLength(2);
    expect((await intents(page)).filter(l => l.intent.type === 'addMarker')).toHaveLength(2);

    await clip(page, 'vid1').click();
    await page.keyboard.press('m'); // one video selected: enters mask edit, no mask yet, no marker added
    await expect(maskEditor(page)).toBeVisible();
    expect((await liveDoc(page, id)).markers).toHaveLength(2);
    await page.keyboard.press('Escape'); await expect(maskEditor(page)).toBeHidden();
    expect(await itemMasks(page, id)).toHaveLength(0);

    // Draw one mask to edit with the rest of the keys.
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    const s = await stage(maskEditor(page));
    await pathToolbar(page).getByRole('button', { name: 'Shape', exact: true }).click();
    await drag(page, s.at(0.2, 0.35), s.at(0.5, 0.65)); // kept clear of the "Editing path" pill (top: 8px, centered)
    expect(await itemMasks(page, id)).toHaveLength(1);

    await page.keyboard.press('a'); // A: enters the smart tool
    await expect(pathToolbar(page).getByRole('button', { name: 'AI Smart Mask' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('a'); // A again: leaves it
    await expect(pathToolbar(page).getByRole('button', { name: 'AI Smart Mask' })).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press('i'); // I: inverts the edited mask
    expect((await itemMasks(page, id))[0].inverted).toBe(true);
    await page.keyboard.press('i');
    expect((await itemMasks(page, id))[0].inverted).toBe(false);

    await page.keyboard.press('Enter'); // Enter: applies/closes (path tool: no redraw)
    await expect(maskEditor(page)).toBeHidden();
    expect(await itemMasks(page, id)).toHaveLength(1);

    await page.keyboard.press('m'); // M re-enters editing the one existing (non-smart) mask
    await expect(maskEditor(page)).toBeVisible();
    await page.keyboard.press('Delete'); // Delete: removes the edited mask
    expect(await itemMasks(page, id)).toHaveLength(0);
  });

  test('smart mask: on a non-video item, A gives the notice "Smart masks only work on videos."', async ({ page }) => {
    const id = await openMaskEditor(page, imageDoc()); await watchIntents(page);
    await clip(page, 'img1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await expect(maskEditor(page)).toBeVisible();
    await expect(pathToolbar(page).getByRole('button', { name: 'AI Smart Mask' })).toBeDisabled();
    await page.keyboard.press('a'); // the key path bypasses the disabled button
    await expect(notices(page)).toContainText('Smart masks only work on videos.');
    expect(await itemMasks(page, id)).toHaveLength(0);
  });

  test('smart mask: the toolbar’s fields; a drag makes a stroke and a preview request; Alt held excludes; Track needs an include stroke', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc());
    await addVideoAsset(page, id, 'vid1');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await stubEngine(page); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await page.keyboard.press('a');
    await expect(smartBrush(page)).toBeVisible();
    const bar = smartToolbar(page);
    await expect(bar.getByRole('button', { name: 'Include', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(bar.getByRole('button', { name: 'Exclude', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(bar.getByRole('spinbutton', { name: 'Brush size' })).toHaveValue('24');
    await expect(bar.getByRole('spinbutton', { name: 'Track start' })).toBeVisible();
    await expect(bar.getByRole('spinbutton', { name: 'Track end' })).toBeVisible();
    await expect(bar.getByText('up to 60 s of source / 1,800 frames')).toBeVisible();
    const track = bar.getByRole('button', { name: 'Track', exact: true });
    await expect(track).toBeDisabled(); // no include stroke yet
    await expect(bar.getByRole('textbox', { name: 'Describe the object' })).toBeVisible();
    const find = bar.getByRole('button', { name: 'Find', exact: true });
    await expect(find).toBeDisabled(); // empty prompt

    const s = await stage(smartBrush(page));
    await drag(page, s.at(0.3, 0.6), s.at(0.4, 0.6)); // a short include stroke, kept clear of the "Smart mask" pill (top: 44px, centered)
    await expect(page.locator('[data-testid="smart-preview"]')).toBeVisible(); // the stroke produced a preview request
    expect((await engineCalls(page)).some((c: any) => c.task === 'preview')).toBe(true);
    await expect(track).toBeEnabled(); // an include stroke now exists
    let line = smartBrush(page).locator('polyline').last();
    await expect(line).toHaveAttribute('stroke', '#22c55e'); // include = green

    await drag(page, s.at(0.5, 0.8), s.at(0.6, 0.8), { alt: true }); // Alt held: exclude
    line = smartBrush(page).locator('polyline').last();
    await expect(line).toHaveAttribute('stroke', '#ef4444'); // exclude = red
  });

  test('M11: Brush size is a diameter, clamped to [1, floor(.5 * short side)] not .25 * short', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc()); // project is W=1280, H=534: short side 534, so max diameter is floor(.5*534)=267
    await addVideoAsset(page, id, 'vid1');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await stubEngine(page); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await page.keyboard.press('a');
    const size = smartToolbar(page).getByRole('spinbutton', { name: 'Brush size' });
    await size.fill('1000');
    await expect(size).toHaveValue('267'); // clamped to floor(.5*534), not floor(.25*534)=133
    await size.fill('-5');
    await expect(size).toHaveValue('1'); // clamped to the minimum of 1, not 0 or negative
  });

  test('M11: a selection over the radius limit reaches neither the preview nor a job', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc());
    await addVideoAsset(page, id, 'vid1');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await stubEngine(page); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await page.keyboard.press('a');
    await page.evaluate(async () => {
      const p = '/src/editor/smart-mask-ui.tsx'; const { useSmartSelection } = await import(p);
      useSmartSelection.setState({ strokes: [{ label: 1, points: [[0.5, 0.5]], radius: 0.936 }] }); // what 1000 px on 534 used to store
    });
    const s = await stage(smartBrush(page));
    await drag(page, s.at(0.3, 0.6), s.at(0.4, 0.6));
    await expect(notices(page)).toContainText('A stroke radius is at most 0.25 of the shorter side.');
    await smartToolbar(page).getByRole('button', { name: 'Track', exact: true }).click();
    expect((await engineCalls(page)).filter((c: any) => c.task === 'preview' || c.task === 'track')).toEqual([]);
    expect(await page.evaluate(async () => { const p = '/src/masks/jobs.ts'; return (await import(p)).useMaskJobs.getState().jobs.length; })).toBe(0);
  });
  test('smart mask: 32 strokes shows the limit notice and stops new strokes', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc());
    await addVideoAsset(page, id, 'vid1');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await stubEngine(page); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await page.keyboard.press('a');
    const s = await stage(smartBrush(page));
    await drag(page, s.at(0.3, 0.6), s.at(0.35, 0.6)); // one real stroke, kept clear of the "Smart mask" pill
    await page.evaluate(async () => {
      const p = '/src/editor/smart-mask-ui.tsx'; const { useSmartSelection } = await import(p);
      const strokes = useSmartSelection.getState().strokes;
      const extra = Array.from({ length: 31 }, () => ({ label: 1 as const, points: [[0.5, 0.5]] as [number, number][], radius: 0.02 }));
      useSmartSelection.setState({ strokes: [...strokes, ...extra] });
    });
    await expect(smartToolbar(page).getByRole('status')).toHaveText('This selection has 32 strokes. Clear it to start a new selection.');
    const before = await smartBrush(page).locator('polyline').count();
    await drag(page, s.at(0.1, 0.6), s.at(0.15, 0.6)); // a 33rd attempt is refused by down()
    expect(await smartBrush(page).locator('polyline').count()).toBe(before);
  });

  test('smart mask: a track range over 60 s refuses with the editor’s RANGE_TEXT', async ({ page }) => {
    const RANGE_TEXT = 'Use a source-time range up to 60 seconds, inside the video and containing the inspected frame.';
    const id = await openMaskEditor(page, maskDoc());
    await addVideoAsset(page, id, 'vid1');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await stubEngine(page); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await page.keyboard.press('a');
    const s = await stage(smartBrush(page));
    await drag(page, s.at(0.3, 0.6), s.at(0.4, 0.6)); // an include stroke, so Track is enabled
    const bar = smartToolbar(page);
    await bar.getByRole('spinbutton', { name: 'Track start' }).fill('0');
    await bar.getByRole('spinbutton', { name: 'Track end' }).fill('65');
    await bar.getByRole('button', { name: 'Track', exact: true }).click();
    await expect(notices(page)).toContainText(RANGE_TEXT);
    expect(await itemMasks(page, id)).toHaveLength(0); // refused: nothing attached, still in the editor
    await expect(maskEditor(page)).toBeVisible();
  });

  test('smart mask: Find creates a Background Jobs entry; Cancel attaches nothing', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc());
    await addVideoAsset(page, id, 'vid1');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await stubEngine(page); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await page.keyboard.press('a');
    const bar = smartToolbar(page);
    await bar.getByRole('textbox', { name: 'Describe the object' }).fill('the dog');
    await bar.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(maskEditor(page)).toBeHidden(); // Find launches the job and leaves the editor

    const jobs = page.getByRole('button', { name: /Background Jobs/ });
    await jobs.click();
    const row = page.getByRole('listitem').filter({ has: page.locator('strong', { hasText: 'Smart mask' }) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Cancel' }).click(); // cancels cooperatively; the stub engine never checks in, so the row may stay
    expect(await itemMasks(page, id)).toHaveLength(0); // nothing attached
  });

  test('smart mask: Space, Delete, + = − _ are swallowed', async ({ page }) => {
    const id = await openMaskEditor(page, maskDoc());
    await addVideoAsset(page, id, 'vid1');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await stubEngine(page); await watchIntents(page);
    await clip(page, 'vid1').click(); await openMask(page);
    await panel(page).getByRole('button', { name: 'Add Mask' }).click();
    await page.keyboard.press('a');
    await expect(smartBrush(page)).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // Space must not re-activate a focused button

    const zoomBefore = await zoomNow(page);
    for (const key of [' ', 'Delete', '+', '=', '-', '_']) await page.keyboard.press(key === ' ' ? 'Space' : key);
    expect(await zoomNow(page)).toBe(zoomBefore); // no zoom change
    expect((await intents(page)).some(l => l.intent.type === 'togglePlayback' || l.intent.type === 'deleteItems')).toBe(false);
    await expect(smartBrush(page)).toBeVisible(); // still in the smart tool, nothing cancelled or deleted
    expect(await itemMasks(page, id)).toHaveLength(0);
    expect(await viewState(page, v => v.selection)).toEqual(['vid1']); // the item itself was not deleted
  });
});
