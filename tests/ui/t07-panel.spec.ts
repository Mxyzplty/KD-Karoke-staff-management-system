// SPDX-License-Identifier: AGPL-3.0-only
// T07 layouts UI (tickets T07 UI rows; findings part 3 §46.3 Layouts row, §46.6 Layout row): the Layouts panel, the layout inspector
// (header and chip, Cells (n), Style, Transform), the empty-row picker, the preview drop, the cell editor, and the compact tabs.
// Writes are read back from the live document and the undo stack (one entry per action). No render or media decode: the footage is
// ready library assets without picture bytes. Not skipped on CI.
import { test, expect, type Page } from '@playwright/test';
import { LAYOUT_PRESETS, LAYOUT_TYPES } from '../../apps/web/src/timeline/layouts';
import { addAsset, clearIntents, clip, intents, notices, openEditor, richDoc, skipTour, viewState, watchIntents } from './t02-support';
import { liveDoc, undoEntries } from './t03-support';
import { seekMs } from './t15-support';
import { dropOnStage, layoutsIn, openLayouts, openSection, panel, seedLayout, typeInto, videoAsset } from './t07-support';

test.setTimeout(150_000);
test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

/** richDoc plus one seeded split-horizontal layout "L1" on O3 (full canvas) with the given extra properties; footage: two videos and an image. */
async function withLayout(page: Page, over: Parameters<typeof seedLayout>[2] = {}, type: Parameters<typeof seedLayout>[1] = 'split-horizontal') {
  const base = richDoc(), doc = { ...base, items: [...base.items, seedLayout('L1', type, over)] };
  const id = await openEditor(page, doc);
  return id;
}
async function footage(page: Page, id: string) {
  const one = await videoAsset(page, id, 'Clip One', 30_000), two = await videoAsset(page, id, 'Clip Two', 45_000), pic = await addAsset(page, id, 'Still.png');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return { one, two, pic };
}
/** A ready 20 s audio asset in the library (no decodable bytes: nothing here plays it). */
const audioAsset = (page: Page, projectId: string) => page.evaluate(async projectId => {
  const p = '/src/store/database.ts'; const { projectStore } = await import(p);
  const a = await projectStore.upload(new File([new Uint8Array([73, 68, 51, 3, 0, 0, 0, 0])], 'Song.mp3', { type: 'audio/mpeg' }));
  await projectStore.updateAsset(a.id, (x: any) => ({ ...x, durationMs: 20_000, processing_status: 'ready', processing_steps: { ...x.processing_steps, probe: 'complete' } }));
  await projectStore.attach(projectId, a.id); return a.id as string;
}, projectId);
const cell = async (page: Page, k: number) => (await layoutsIn(page))[0].details.cells[k];
const selectLayout = async (page: Page) => { await clip(page, 'L1').click(); await expect(panel(page).getByRole('heading', { name: 'Layout', exact: true })).toBeVisible(); };

test.describe('T07 layouts UI', () => {
  test('Layouts panel (§46.3): 11 cards in the §20 order; a card click with the playhead at 10 s adds a 10 s layout from 0 s on a new overlay track as one "Add items" step', async ({ page }) => {
    const id = await openEditor(page, richDoc()); await watchIntents(page);
    await openLayouts(page);
    const cards = panel(page).getByRole('list', { name: 'Layout presets' }).getByRole('listitem');
    await expect(cards).toHaveCount(11);
    expect(await cards.allInnerTexts()).toEqual(LAYOUT_TYPES.map(t => LAYOUT_PRESETS[t].label));
    const before = await liveDoc(page); await seekMs(page, 10_000); await clearIntents(page);
    await cards.filter({ hasText: 'Grid 2x2' }).getByRole('button').click();
    expect((await intents(page)).map(l => [l.intent.type, l.intent.layoutType, l.outcome.ok])).toEqual([['addLayout', 'grid-2x2', true]]);
    const after = await liveDoc(page), made = after.items.filter((i: any) => i.type === 'layout');
    expect(made).toHaveLength(1);
    expect(made[0].display).toEqual({ from: 0, to: 10_000 });   // 10 s from 0 s whatever the playhead says
    expect(made[0].details.layoutType).toBe('grid-2x2'); expect(made[0].details.cells).toHaveLength(4);
    expect(after.tracks.length, 'a new track').toBe(before.tracks.length + 1);
    const track = after.tracks.find((t: any) => t.id === made[0].trackId);
    expect(before.tracks.some((t: any) => t.id === track.id)).toBe(false); expect(track.kind).toBe('overlay');
    expect(await undoEntries(page)).toEqual([{ label: 'Add items', source: 'user' }]);
  });

  test('Layout inspector (§46.6): header "Layout" with the preset chip, no Keyframes graph, sections Cells (n) / Style / Transform only', async ({ page }) => {
    await withLayout(page, {}, 'feature-left'); await selectLayout(page);
    const insp = panel(page);
    await expect(insp.getByTestId('layout-preset')).toHaveText('Feature Left');
    await expect(insp.getByRole('button', { name: 'Keyframes graph' })).toHaveCount(0);
    expect(await insp.locator('details.inspector-section > summary').allInnerTexts()).toEqual(['Cells (3)', 'Style', 'Transform']);   // no Opacity / Blend section
    await expect(insp.getByRole('button', { name: /^Add .*keyframe/i })).toHaveCount(0);
  });

  test('Cells: rows read "N Empty"; the empty-row picker fills a cell (one "Edit items"); Remove media and Delete cell are one undo step each; undo restores', async ({ page }) => {
    const id = await withLayout(page); const f = await footage(page, id); await watchIntents(page);
    await selectLayout(page); const insp = panel(page); await openSection(insp, /^Cells/);
    const rows = insp.getByRole('list', { name: 'Cells' }).getByRole('listitem');
    await expect(rows).toHaveCount(2); await expect(rows.nth(0)).toContainText('1 Empty'); await expect(rows.nth(1)).toContainText('2 Empty');
    await clearIntents(page);
    await rows.nth(0).getByRole('button', { name: '1 Empty' }).click();
    const picker = insp.getByRole('list', { name: 'Footage for cell 1' }); await expect(picker).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Fill cell 1 with Still.png' }), 'an image is offered').toBeVisible();
    await picker.getByRole('button', { name: 'Fill cell 1 with Clip One' }).click();
    await expect(rows.nth(0)).toContainText('1 Clip One');
    expect(await cell(page, 0)).toMatchObject({ source: { assetId: f.one, type: 'video' } });
    expect((await cell(page, 0)).source.url).toEqual(expect.any(String));
    expect(await undoEntries(page)).toEqual([{ label: 'Edit items', source: 'user' }]);
    const filled = await cell(page, 0);
    // Remove media: the cell empties, everything else of the cell is kept.
    await rows.nth(0).getByRole('button', { name: 'Remove media from cell 1' }).click();
    await expect(rows.nth(0)).toContainText('1 Empty'); expect((await cell(page, 0)).source).toBeNull();
    expect((await undoEntries(page)).map(e => e.label)).toEqual(['Edit items', 'Edit items']);
    await expect(rows.nth(0).getByRole('button', { name: 'Remove media from cell 1' })).toHaveCount(0);
    // Delete cell: Cells (2) -> Cells (1).
    await insp.getByRole('button', { name: 'Delete cell 2' }).click();
    await expect(insp.locator('summary', { hasText: 'Cells (1)' })).toBeVisible(); await expect(rows).toHaveCount(1);
    expect((await layoutsIn(page))[0].details.cells).toHaveLength(1);
    expect((await undoEntries(page)).map(e => e.label)).toEqual(['Edit items', 'Edit items', 'Edit items']);
    // Undo walks back one step at a time.
    await page.keyboard.press('Control+z'); await expect(insp.locator('summary', { hasText: 'Cells (2)' })).toBeVisible();
    await page.keyboard.press('Control+z'); expect((await cell(page, 0)).source).toEqual(filled.source);
    await page.keyboard.press('Control+z'); expect((await cell(page, 0)).source).toBeNull();
    expect((await intents(page)).filter(l => l.intent.type === 'layoutEdit').every(l => l.outcome.ok)).toBe(true);
  });

  test('Cell editor: Fill / Fit, Volume 100, Opacity 100, Speed 1 by default and clamped at 0-200, 0-100 and 0.1-4; no pan, zoom or trim control', async ({ page }) => {
    const id = await withLayout(page); await footage(page, id);
    await selectLayout(page); const insp = panel(page); await openSection(insp, /^Cells/);
    await insp.getByRole('button', { name: '1 Empty' }).click();
    await insp.getByRole('button', { name: 'Fill cell 1 with Clip One' }).click();
    const ed = insp.getByRole('group', { name: 'Cell 1' }); await expect(ed).toBeVisible();
    const mode = ed.getByRole('radiogroup', { name: 'Fill Mode' });
    await expect(mode.getByRole('radio', { name: 'Fill' })).toHaveAttribute('aria-checked', 'true'); await expect(mode.getByRole('radio', { name: 'Fit' })).toHaveAttribute('aria-checked', 'false');
    await expect(ed.locator('[data-slider="Volume"] .slider-value')).toContainText('100'); await expect(ed.locator('[data-slider="Opacity"] .slider-value')).toContainText('100');
    await expect(ed.locator('[data-slider="Speed"] .slider-value')).toContainText('1');
    for (const re of [/pan/i, /zoom/i, /trim/i, /crop/i]) {
      await expect(insp.getByRole('slider', { name: re }), `slider ${re}`).toHaveCount(0); await expect(insp.getByRole('button', { name: re }), `button ${re}`).toHaveCount(0);
    }
    await mode.getByRole('radio', { name: 'Fit' }).click();
    await expect(mode.getByRole('radio', { name: 'Fit' })).toHaveAttribute('aria-checked', 'true'); expect((await cell(page, 0)).fillMode).toBe('fit');
    for (const [label, key, text, want] of [['Volume', 'volume', '999', 200], ['Opacity', 'opacity', '150', 100], ['Speed', 'playbackRate', '9', 4], ['Speed', 'playbackRate', '0', 0.1], ['Volume', 'volume', '-5', 0]] as const) {
      await typeInto(ed, label, text); expect((await cell(page, 0))[key], `${label} ${text}`).toBe(want);
    }
    expect((await cell(page, 0))).toMatchObject({ panX: 0, panY: 0, zoom: 100 });   // untouched by every control above
    expect((await undoEntries(page)).every(e => e.label === 'Edit items')).toBe(true);
  });

  test('Style: Gap and Radius clamp at 0-40 px; the Transform buttons act on a layout shrunk below the canvas; each edit is one "Edit items" step', async ({ page }) => {
    await withLayout(page, { width: 400, height: 600, props: { positionX: 33, positionY: 70 } }); await selectLayout(page);
    const insp = panel(page); await openSection(insp, 'Style'); await openSection(insp, 'Transform');
    await typeInto(insp, 'Gap', '99'); expect((await layoutsIn(page))[0].details.gap).toBe(40);
    await typeInto(insp, 'Radius', '99'); expect((await layoutsIn(page))[0].details.borderRadius).toBe(40);
    await typeInto(insp, 'Gap', '-3'); expect((await layoutsIn(page))[0].details.gap).toBe(0);
    await typeInto(insp, 'Radius', '12'); expect((await layoutsIn(page))[0].details.borderRadius).toBe(12);
    const pv = async (k: string) => (await layoutsIn(page))[0].properties[k].defaultValue;
    await insp.getByRole('button', { name: 'Centre horizontally' }).click();
    expect(await pv('positionX')).toBe((1920 - 400) / 2); expect(await pv('positionY')).toBe(70);
    await insp.getByRole('button', { name: 'Centre vertically' }).click();
    expect(await pv('positionY')).toBe((1080 - 600) / 2);
    await insp.getByRole('button', { name: 'Reset to full canvas', exact: true }).click();
    expect([await pv('positionX'), await pv('positionY'), await pv('width'), await pv('height')]).toEqual([0, 0, 1920, 1080]);
    // The second reset button changes nothing more on a full-canvas layout: no extra undo entry.
    const n = (await undoEntries(page)).length; await insp.getByRole('button', { name: 'Reset to full canvas (2)' }).click();
    expect((await undoEntries(page)).length).toBe(n);
    expect((await undoEntries(page)).every(e => e.label === 'Edit items')).toBe(true);
    for (const re of [/^opacity$/i, /blend/i, /^scale$/i, /^position/i]) await expect(insp.locator(`[data-slider]`).filter({ hasText: re }), `Transform has no ${re}`).toHaveCount(0);
  });

  test('Preview drop: footage dropped on a cell fills it (toast "Added <name> to cell N", one "Edit items"), the layout stays 10 s, the source is {assetId, type, url}', async ({ page }) => {
    const id = await withLayout(page), song = await audioAsset(page, id); const f = await footage(page, id); await seekMs(page, 1000);
    const before = (await layoutsIn(page))[0];
    // Cell 1 is the left half, cell 2 the right half of the full-canvas layout.
    await dropOnStage(page, 0.25, 0.5, { kind: 'assets', items: [{ assetId: f.one, type: 'video', name: 'Clip One' }] });
    await expect(notices(page)).toContainText('Added Clip One to cell 1');
    await dropOnStage(page, 0.75, 0.5, { kind: 'assets', items: [{ assetId: f.two, type: 'video', name: 'Clip Two' }] });
    await expect(notices(page)).toContainText('Added Clip Two to cell 2');
    const after = (await layoutsIn(page))[0];
    expect(after.display).toEqual(before.display); expect(after.display).toEqual({ from: 0, to: 10_000 });   // the 30 s and 45 s sources do not stretch it
    expect(after.details.cells[0].source).toEqual({ assetId: f.one, type: 'video', url: expect.any(String) });
    expect(after.details.cells[1].source).toEqual({ assetId: f.two, type: 'video', url: expect.any(String) });
    expect(Object.keys(after.details.cells[0].source).sort()).toEqual(['assetId', 'type', 'url']);
    for (const k of [0, 1]) expect({ ...after.details.cells[k], source: null }).toEqual({ ...before.details.cells[k], source: null });   // every other cell field unchanged
    expect(after.properties).toEqual(before.properties);
    expect((await undoEntries(page)).map(e => e.label)).toEqual(['Edit items', 'Edit items']);
    // A real audio asset dropped on a cell does not fill it: the drop falls through to the preview's own footage drop (I13).
    const n = (await undoEntries(page)).length;
    await dropOnStage(page, 0.75, 0.5, { kind: 'assets', items: [{ assetId: song, type: 'audio', name: 'Song.mp3' }] });
    await expect.poll(async () => (await undoEntries(page)).length).toBe(n + 1);
    expect((await undoEntries(page)).slice(n)).toEqual([{ label: 'Add items', source: 'user' }]);
    const doc = await liveDoc(page), placed = doc.items.filter((i: any) => i.metadata?.assetId === song);
    expect(placed.map((i: any) => [i.type, doc.tracks.find((t: any) => t.id === i.trackId)?.kind])).toEqual([['audio', 'audio']]);
    expect((await layoutsIn(page))[0].details.cells).toEqual(after.details.cells);
  });

  test('Compact layout (below 1024 px): a selected layout offers the single Properties tab and its drawer holds Cells (n), Style and Transform', async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 900 });
    await withLayout(page); await clip(page, 'L1').click();
    const tabs = page.getByRole('navigation', { name: 'Editor panels' });
    expect(await tabs.getByRole('tab').allInnerTexts()).toEqual(['Properties']);
    await tabs.getByRole('tab', { name: 'Properties' }).click();
    const drawer = page.getByRole('dialog', { name: 'Properties', exact: true }); await expect(drawer).toBeVisible();
    expect(await drawer.locator('details.inspector-section > summary').allInnerTexts()).toEqual(['Cells (2)', 'Style', 'Transform']);
    await expect(drawer.getByTestId('layout-preset')).toHaveText('Split Horizontal');
    expect(await viewState(page, v => v.selection)).toEqual(['L1']);
  });
});
