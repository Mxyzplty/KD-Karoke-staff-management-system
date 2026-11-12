// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 7 / A22/A23/GFX-10: the style/MG panels, customisation, save eligibility, loss/missing notices and transfer.
// Oracle: the pinned step-7 UI contract, §31 and authored Name Bar timings. Document/UI assertions only, no glyph/pixel wait.
// External requests are aborted. Font-load attempts are annotated (OQ-6 is later), never replaced by a font/loader fixture.
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { STYLE_PRESETS } from '../../apps/web/src/presets/content';
import type { DirectPreset } from '../../apps/web/src/presets/model';
import { clip, intents, notices, openEditor, setViewState, skipTour, watchIntents } from './t02-support';
import { prop } from './t04-support';

test.use({ viewport: { width: 1400, height: 900 } }); test.setTimeout(90_000);
type Rec = Record<string, any>;
const blocked = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  await skipTour(page); blocked.set(page, []);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    blocked.get(page)!.push(url.href); return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  const urls = blocked.get(page)!;
  if (urls.length) test.info().annotations.push({ type: 'blocked-network', description: `No external requests allowed; attempted: ${[...new Set(urls)].join(', ')}` });
});
const props = (values: Rec) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, prop(value)]));
const track = (id: string, kind: string) => ({ id, name: id, kind, hidden: false, locked: false, muted: false, solo: false, volume: 1 });
function title(id = 'title'): Rec {
  return { id, type: 'text', trackId: id === 'keep' ? 'O4' : 'O1', display: { from: 0, to: id === 'keep' ? 20000 : 4000 },
    details: { text: id === 'keep' ? 'Keep' : 'Saved title wording', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' },
    properties: props({ positionX: 40, positionY: 60, width: 240, height: 80, fontSize: 32, fontWeight: 700, color: '#FFFFFF', textAlign: 'left', scale: 1, opacity: 1 }), effects: [], masks: [] };
}
function shape(): Rec {
  return { id: 'shape', type: 'shape', trackId: 'O2', display: { from: 0, to: 4000 }, metadata: { shapeType: 'rectangle' },
    details: { closed: true, points: [{ anchor: { x: 0, y: 0 } }, { anchor: { x: 120, y: 0 } }, { anchor: { x: 120, y: 80 } }, { anchor: { x: 0, y: 80 } }] },
    properties: props({ positionX: 30, positionY: 100, width: 120, height: 80, fillColor: '#123456', scale: 1, opacity: 1 }) };
}
const CODE = 'export const Saved = () => <AbsoluteFill style={{backgroundColor:"#123456"}} />;';
function fullItems(): Rec[] {
  return [title('keep'), title(), shape(), { id: 'graphic', type: 'motionGraphic', trackId: 'O3', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000,
    details: { code: CODE }, properties: props({ positionX: 40, positionY: 60, width: 240, height: 80, scale: 1 }) },
  { id: 'video', type: 'video', trackId: 'V1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000, details: { name: 'Video' } },
  { id: 'image', type: 'image', trackId: 'V1', display: { from: 4000, to: 8000 }, details: { name: 'Image' } }];
}
function document(items: Rec[] = [title('keep')]) {
  const tracks = [track('V1', 'video'), track('O1', 'overlay'), track('O2', 'overlay'), track('O3', 'overlay'), track('O4', 'overlay')];
  return { schemaVersion: 4, rev: 0, groups: {}, duration: 20000, fps: 30, size: { width: 400, height: 300 }, background: { type: 'color', value: 'transparent' },
    transitions: [], markers: [], tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), items };
}
const liveDoc = (page: Page): Promise<Rec> => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Inspector and tools' });
async function styles(page: Page) {
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Style presets', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'Style presets', exact: true })).toBeVisible(); return panel(page);
}
async function motion(page: Page) {
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Motion graphics', exact: true }).click();
  const region = panel(page).getByRole('region', { name: 'Motion graphics' }); await expect(region).toBeVisible(); return region;
}
const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true }).first().click();
const runtimeLabels = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; return (await import(p)).activeRuntime.bus.labels(); });
const setPresetsRow = (page: Page, row: 'mg-presets' | 'style-presets', presets: unknown[]) => page.evaluate(async ({ row, presets }) => {
  const p = '/src/store/database.ts'; await (await import(p)).projectStore.putRow('settings', { id: row, presets });
}, { row, presets });
async function savedDialog(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: 'Save as preset', exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Preset name' }).fill(name); return dialog;
}
async function addBuiltin(page: Page, name = 'Title Wipe') {
  const before = await liveDoc(page), p = await motion(page);
  await p.getByRole('group', { name: 'Built-in presets (10)' }).getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Add "${name}"`, exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click(); await expect(notices(page)).toContainText(`Applied "${name}" — 1 item(s)`);
  const ids = new Set(before.items.map((item: Rec) => item.id));
  await expect.poll(async () => (await liveDoc(page)).items.filter((item: Rec) => !ids.has(item.id)).length).toBe(1);
  return (await liveDoc(page)).items.find((item: Rec) => !ids.has(item.id)) as Rec;
}

test('A22: a multi-item direct preset starts at zero, closes the panel and is one undo, not at the 10s playhead', async ({ page }) => {
  await openEditor(page, document(), 'T22 A22'); await setViewState(page, { playheadMs: 10000 }); await watchIntents(page);
  const before = await liveDoc(page), p = await styles(page), preset = STYLE_PRESETS.find(p => p.id === 'lower-thirds/name-bar') as DirectPreset;
  await p.getByRole('group', { name: 'Presets', exact: true }).getByRole('button', { name: 'Name Bar', exact: true }).click();
  await expect(notices(page)).toContainText('Applied "Name Bar" — 3 item(s)'); await expect(p.getByRole('heading', { name: 'Style presets', exact: true })).toHaveCount(0);
  const after = await liveDoc(page), beforeIds = new Set(before.items.map((item: Rec) => item.id)), added = after.items.filter((item: Rec) => !beforeIds.has(item.id));
  expect(added).toHaveLength(3); expect(added.map((item: Rec) => item.display)).toEqual(preset.items.map(item => ({ from: item.relativeStart, to: item.relativeStart + item.duration })));
  expect(new Set(added.map((item: Rec) => item.trackId)).size).toBe(3); expect(after.tracks).toHaveLength(before.tracks.length + 3);
  for (const item of added) expect(after.tracks.find((track: Rec) => track.id === item.trackId).kind).toBe('overlay');
  expect(await runtimeLabels(page)).toEqual(['Add items']); expect(await intents(page)).toHaveLength(1);
  await undo(page); const restored = await liveDoc(page);
  expect(restored.items).toEqual(before.items); expect(restored.tracks).toEqual(before.tracks); expect(restored.layerOrder).toEqual(before.layerOrder);
});

test('A23: only populated chips in category order, All=16, Text filters the three-column grid', async ({ page }) => {
  await openEditor(page, document(), 'T22 A23'); const p = await styles(page), categories = p.getByRole('group', { name: 'Categories' }), grid = p.getByRole('group', { name: 'Presets', exact: true });
  await expect(categories.getByRole('button')).toHaveText(['All', 'Text', 'Lower Thirds', 'Info Cards', 'Panels', 'Misc', 'Collages']);
  await expect(categories.getByRole('button', { name: 'Title Cards', exact: true })).toHaveCount(0); await expect(categories.getByRole('button', { name: 'Overlays', exact: true })).toHaveCount(0);
  await expect(categories.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(grid.getByRole('button')).toHaveCount(16);
  const columns = await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/)); expect(columns).toHaveLength(3);
  await categories.getByRole('button', { name: 'Text', exact: true }).click(); await expect(categories.getByRole('button', { name: 'Text', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(grid.getByRole('button')).toHaveCount(4);
  for (const name of ['Big Headline', 'Serif Quote', 'Kicker and Title', 'Stacked Words']) await expect(grid.getByRole('button', { name, exact: true })).toHaveCount(1);
  await categories.getByRole('button', { name: 'All', exact: true }).click(); await expect(grid.getByRole('button')).toHaveCount(16);
});

for (const custom of ['', 'make it red']) test(`MG style dialog Add, custom text ${JSON.stringify(custom)}`, async ({ page }) => {
  await openEditor(page, document(), 'T22 customise'); const before = await liveDoc(page), p = await styles(page);
  await p.getByRole('button', { name: 'Side Panel', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Add "Side Panel"', exact: true });
  await expect(dialog).toBeVisible(); expect((await liveDoc(page)).items).toEqual(before.items); expect(await runtimeLabels(page)).toEqual([]);
  await dialog.getByRole('textbox', { name: 'Customise', exact: true }).fill(custom); await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(notices(page)).toContainText('Applied "Side Panel" — 1 item(s)'); expect((await liveDoc(page)).items).toHaveLength(before.items.length + 1);
  if (custom) { await expect(notices(page)).toContainText('Customise the "Side Panel" preset: make it red'); await expect(notices(page)).toContainText('not yet implemented (T20)'); }
  else await expect(notices(page)).not.toContainText('not yet implemented (T20)');
});
test('MG style dialog Cancel adds nothing', async ({ page }) => {
  await openEditor(page, document(), 'T22 cancel'); const before = await liveDoc(page), p = await styles(page);
  await p.getByRole('button', { name: 'Side Panel', exact: true }).click(); await page.getByRole('dialog', { name: 'Add "Side Panel"', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await liveDoc(page)).items).toEqual(before.items); expect((await liveDoc(page)).tracks).toEqual(before.tracks); expect(await runtimeLabels(page)).toEqual([]);
});

test('Motion graphics built-in list is above My Presets, opens the same dialog and adds at zero', async ({ page }) => {
  await openEditor(page, document(), 'T22 builtins'); const p = await motion(page), builtin = p.getByRole('group', { name: 'Built-in presets (10)' });
  await expect(builtin.getByRole('button')).toHaveCount(10); await expect(p.getByText('My Presets (0)', { exact: true })).toBeVisible();
  const builtHeading = p.getByText('Built-in presets (10)', { exact: true }), ownHeading = p.getByText('My Presets (0)', { exact: true });
  expect((await builtHeading.boundingBox())!.y).toBeLessThan((await ownHeading.boundingBox())!.y);
  const before = await liveDoc(page); await builtin.getByRole('button', { name: 'Title Wipe', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add "Title Wipe"', exact: true }); await expect(dialog.getByRole('textbox', { name: 'Customise' })).toBeVisible();
  expect((await liveDoc(page)).items).toEqual(before.items); await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(notices(page)).toContainText('Applied "Title Wipe" — 1 item(s)');
  const item = (await liveDoc(page)).items.find((item: Rec) => item.type === 'motionGraphic'); expect(item.display.from).toBe(0);
});

test('save a text item through the inspector, list it, and reapply the same text/box/font size/family', async ({ page }) => {
  const source = title(); await openEditor(page, document([title('keep'), source]), 'T22 save text'); await clip(page, 'title').click();
  await panel(page).getByRole('button', { name: 'Save as preset', exact: true }).click(); const dialog = await savedDialog(page, 'My saved title');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(notices(page)).toContainText('Saved "My saved title" to My style presets');
  const before = await liveDoc(page), p = await styles(page); await expect(p.getByRole('heading', { name: 'My style presets (1)', exact: true })).toBeVisible();
  await p.getByRole('button', { name: 'My saved title', exact: true }).click();
  const ids = new Set(before.items.map((item: Rec) => item.id)); await expect.poll(async () => (await liveDoc(page)).items.filter((item: Rec) => !ids.has(item.id)).length).toBe(1);
  const item = (await liveDoc(page)).items.find((item: Rec) => !ids.has(item.id)); expect(item.details.text).toBe(source.details.text); expect(item.details.fontFamilyDisplay).toBe('Roboto');
  for (const key of ['positionX', 'positionY', 'width', 'height', 'fontSize']) expect(item.properties[key].defaultValue).toBe(source.properties[key].defaultValue);
});
test('save an applied MG through Clip actions and list it in My Presets', async ({ page }) => {
  await openEditor(page, document(), 'T22 save graphic'); const item = await addBuiltin(page);
  await clip(page, item.id).click({ button: 'right' }); await page.getByRole('menu', { name: 'Clip actions' }).getByRole('menuitem', { name: 'Save as preset', exact: true }).click();
  const dialog = await savedDialog(page, 'My saved graphic'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notices(page)).toContainText('Saved "My saved graphic" to My Presets');
  const p = await motion(page); await expect(p.getByText('My Presets (1)', { exact: true })).toBeVisible(); await expect(p.getByRole('list', { name: 'My Presets (1)' }).getByRole('button', { name: 'My saved graphic', exact: true })).toBeVisible();
});

for (const selection of [
  { ids: ['title'], savable: true }, { ids: ['shape'], savable: true }, { ids: ['graphic'], savable: true }, { ids: ['title', 'shape'], savable: true },
  { ids: ['video'], savable: false }, { ids: ['image'], savable: false }, { ids: ['title', 'video'], savable: false },
]) test(`Clip actions Save eligibility: ${selection.ids.join('+')}`, async ({ page }) => {
  await openEditor(page, document(fullItems()), 'T22 menu'); await setViewState(page, { selection: selection.ids });
  await clip(page, selection.ids[0]).click({ button: 'right' }); const menu = page.getByRole('menu', { name: 'Clip actions' }); await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Save as preset', exact: true })).toHaveCount(selection.savable ? 1 : 0);
  const chosen = await page.evaluate(async () => { const p = '/src/editor/view.ts'; return (await import(p)).view().selection; }); expect(chosen).toEqual(selection.ids);
  if (selection.ids.length === 1 && selection.ids[0] === 'video') await expect(menu.getByRole('menuitem')).toHaveText(['Split at playhead', 'Duplicate', 'Slip', 'Copy', 'Paste at playhead', 'Delete']);
});

test('save dialog warns about enabled effects and the save toast carries the loss notice', async ({ page }) => {
  const item = title(); item.effects = [{ id: 'fx', effectId: 'invert', enabled: true, order: 0, parameters: { amount: prop(100) } }];
  await openEditor(page, document([title('keep'), item]), 'T22 loss notice'); await clip(page, 'title').click(); await panel(page).getByRole('button', { name: 'Save as preset', exact: true }).click();
  const dialog = await savedDialog(page, 'Lossy title'); await expect(dialog).toContainText('Not kept in the preset: effects.');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(notices(page)).toContainText('Saved "Lossy title" to My style presets. Not kept: effects');
});

const OWN = { id: 'text/transfer-fixture', name: 'Transferred title', description: 'An independently authored transfer fixture.', version: 1, savedAt: '2026-11-11T03:00:00.000Z', canvas_size: { width: 400, height: 300 },
  items: [{ type: 'text', relativeStart: 0, duration: 3000, details: { text: 'Imported words', left: 0.1, top: 0.2, width: 0.6, height: 0.2, fontSize: 0.08, fontFamily: 'Roboto', fontWeight: 700, color: '#FFFFFF' } }] };
test('a stored missing font still places the preset and shows the exact notice', async ({ page }) => {
  await openEditor(page, document(), 'T22 missing font'); const own = structuredClone(OWN); own.items[0].details.fontFamily = 'No Such Font'; own.name = 'Missing family';
  await setPresetsRow(page, 'style-presets', [own]); const before = await liveDoc(page), p = await styles(page); await p.getByRole('button', { name: own.name, exact: true }).click();
  await expect(notices(page)).toContainText('The font "No Such Font" is not available here. The default font is used.'); expect((await liveDoc(page)).items).toHaveLength(before.items.length + 1);
});
test('a stored MG missing literal media still places and reports the exact asset notice', async ({ page }) => {
  await openEditor(page, document(), 'T22 missing asset');
  const own = { id: 'my/missing-asset', name: 'Missing asset', mg_code: "export const G = () => <Img src={getAssetUrl('video_9')} />;", duration_ms: 3000 };
  await setPresetsRow(page, 'mg-presets', [own]); const before = await liveDoc(page), p = await motion(page);
  await p.getByRole('list', { name: 'My Presets (1)' }).getByRole('button', { name: own.name, exact: true }).click();
  await expect(notices(page)).toContainText('The asset "video_9" is not in this project. Attach it, then check the motion graphic.'); expect((await liveDoc(page)).items).toHaveLength(before.items.length + 1);
});
test('Export presets download imports back through the file chooser', async ({ page }) => {
  await openEditor(page, document(), 'T22 transfer'); await setPresetsRow(page, 'style-presets', [OWN]); let p = await styles(page);
  await expect(p.getByRole('button', { name: OWN.name, exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download'); await p.getByRole('button', { name: 'Export presets', exact: true }).click();
  const file = await downloaded, filePath = await file.path(); expect(filePath, 'Playwright makes the completed download readable').toBeTruthy();
  const payload = JSON.parse(await readFile(filePath!, 'utf8')); expect(payload).toMatchObject({ format: 'cutframe-presets', version: 1 }); expect(payload.presets).toContainEqual(OWN);
  await setPresetsRow(page, 'style-presets', []); await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Shapes', exact: true }).click(); p = await styles(page);
  const choosing = page.waitForEvent('filechooser'); await p.getByRole('button', { name: 'Import presets', exact: true }).click(); await (await choosing).setFiles(filePath!);
  await expect(notices(page)).toContainText(`Imported ${payload.presets.length} preset(s)`); await expect(p.getByRole('button', { name: OWN.name, exact: true })).toBeVisible();
});
