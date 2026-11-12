// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 10: plan A4/A5/A6/A8/A9/A10/A11/S1; findings §22 and part 3 §46.1.
// Expectations are the written contract and Daylight's authored data, not template/default helper results.
// No browser run by the test author. Real store, native controls and bundled files; no skipped cases or network fixtures.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { addAsset, createProject, guard, linkClip, notices, openEditor, setViewState, skipTour, stored } from './t02-support';
import { prop } from './t04-support';
import { runCanvas, shown } from './t15-support';

test.use({ viewport: { width: 1400, height: 1000 } }); test.setTimeout(120_000);
type Rec = Record<string, any>;
const leaks = new WeakMap<Page, string[]>();
async function localOnly(page: Page) {
  await skipTour(page); leaks.set(page, guard(page));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(u.hostname) || ['blob:', 'data:'].includes(u.protocol) ? route.continue() : route.abort();
  });
}
test.beforeEach(async ({ page }) => { await localOnly(page); });
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) if (leaks.has(page)) expect(leaks.get(page), 'templates and bundled previews make no off-localhost requests').toEqual([]);
});
const PALETTE = [{ name: 'Chalk', hex: '#FAFAF7' }, { name: 'Ink', hex: '#15171C' }, { name: 'Cobalt', hex: '#2F6BFF' }, { name: 'Sun', hex: '#FFD23F' }];
const FONTS = { captionsFont: 'Manrope-Bold', titlesFont: 'Sora-ExtraBold', accentFont: 'InstrumentSerif-Regular' };
const DEFAULTS = { templateId: 'daylight', epoch: 1, ...FONTS, palette: PALETTE };
const EXAMPLES = ['Big Headline', 'Serif Quote', 'Name Bar', 'Fact Card'];
const AUDIO = ['Soft chime', 'Short beep', 'Happy beep', 'Mouse click', 'Clicker', 'Camera focus', 'Typewriter ding', 'Latch click'];
const IMAGES = ['Sparkles', 'Scribble underline', 'Swoop arrow', 'Label tag'];
const track = (id: string, kind: string) => ({ id, name: id, kind, hidden: false, locked: false, muted: false, solo: false, volume: 1 });
function document(items: Rec[] = []): Rec {
  const tracks = [track('V1', 'video'), track('O1', 'overlay')];
  return { schemaVersion: 4, rev: 0, groups: {}, duration: 10000, fps: 30, size: { width: 960, height: 540 }, background: { type: 'color', value: 'transparent' },
    transitions: [], markers: [], tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), items };
}
const state = (page: Page, id: string): Promise<Rec> => page.evaluate(async id => {
  const p = '/src/store/database.ts'; return JSON.parse(JSON.stringify(await (await import(p)).projectStore.read(id)));
}, id);
const templatesRow = (page: Page): Promise<Rec | null> => page.evaluate(async () => {
  const p = '/src/store/database.ts'; return await (await import(p)).projectStore.row('settings', 'templates') ?? null;
});
const live = (page: Page): Promise<Rec> => page.evaluate(async () => {
  const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document));
});
async function saved(page: Page) { await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 15000 }); }
const picker = (page: Page) => page.getByRole('dialog', { name: 'Choose a Template', exact: true });
const current = (page: Page) => page.getByRole('dialog', { name: 'Current template', exact: true });
async function menu(page: Page, choice: string) {
  await page.getByRole('button', { name: /^Template: / }).click();
  const m = page.getByRole('menu', { name: /^Template: / }); await expect(m.getByText('Project template', { exact: true })).toBeVisible();
  await expect(m.getByRole('menuitem')).toHaveText(['View details', 'Change template', 'Save as template']);
  await m.getByRole('menuitem', { name: choice, exact: true }).click();
}
async function closeDialog(scope: Locator, title: string) { await scope.getByRole('button', { name: `Close ${title}`, exact: true }).click(); }
async function choose(scope: Locator, name = 'Daylight', tab = 'Built-in templates') {
  await scope.getByRole('tab', { name: tab, exact: true }).click();
  const row = scope.getByRole('list', { name: tab, exact: true }).getByRole('button', { name: new RegExp(`^${name}`) });
  await row.click(); await expect(row).toHaveAttribute('aria-pressed', 'true'); return row;
}
async function preview(scope: Locator, name = 'Daylight', tab = 'Built-in templates') {
  await choose(scope, name, tab); await scope.getByRole('button', { name: `Preview ${name}`, exact: true }).click();
  await expect(scope.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function pickerContract(scope: Locator) {
  await expect(scope.getByRole('tab', { name: 'Built-in templates', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(scope.getByRole('tab', { name: 'My templates', exact: true })).toBeVisible();
  await expect(scope.getByRole('searchbox', { name: 'Find a template' })).toBeVisible();
  await expect(scope.getByRole('list', { name: 'Built-in templates', exact: true }).getByRole('button', { name: /^Daylight/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(scope.getByRole('button', { name: 'Choose a template', exact: true })).toBeDisabled();
}
async function bindDaylight(page: Page) {
  await menu(page, 'Change template'); const p = picker(page); await choose(p);
  await p.getByRole('button', { name: 'Use Daylight', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Template: Daylight', exact: true })).toBeVisible(); await saved(page);
}
async function colours(scope: Locator, palette = PALETTE) {
  const region = scope.getByRole('region', { name: 'Colors', exact: true }); await expect(region.getByRole('listitem')).toHaveCount(palette.length);
  for (const swatch of palette) { await expect(region.getByText(swatch.name, { exact: true })).toBeVisible(); await expect(region.getByText(swatch.hex, { exact: true })).toBeVisible(); }
}
async function form(scope: Locator, fonts = FONTS, palette = PALETTE) {
  await scope.getByRole('tab', { name: 'Your preferences', exact: true }).click(); const f = scope.getByRole('form', { name: 'Your preferences' });
  await expect(f.getByRole('switch', { name: 'Learn and update this template' })).toBeChecked();
  await expect(f).toContainText('What the agent learns from your feedback is written to your own copy of this template.'); await expect(f).toContainText('Projects that already use this template keep their look.');
  for (const [label, value] of [['Captions', fonts.captionsFont], ['Titles', fonts.titlesFont], ['Accent', fonts.accentFont]]) await expect(f.getByRole('combobox', { name: `${label} font`, exact: true })).toHaveValue(value);
  for (const [n, s] of palette.entries()) { await expect(f.getByLabel(`Colour ${n + 1}`, { exact: true })).toHaveValue(s.hex.toLowerCase()); await expect(f.getByRole('textbox', { name: `Colour ${n + 1} name`, exact: true })).toHaveValue(s.name); }
  await expect(f.getByRole('button', { name: 'Save fonts & colors', exact: true })).toBeVisible(); return f;
}
async function addTitle(page: Page) {
  const before = new Set((await live(page)).items.map((i: Rec) => i.id));
  await setViewState(page, { selection: [] }); await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('region', { name: 'Text', exact: true }).getByRole('button', { name: 'Add text', exact: true }).click();
  await expect.poll(async () => (await live(page)).items.filter((i: Rec) => !before.has(i.id)).length).toBe(1);
  return (await live(page)).items.find((i: Rec) => !before.has(i.id)) as Rec;
}

test('A5: wizard uses the shared picker; selection enables Use, and the card can change and remove it', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '＋ New Video', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'New Video', exact: true }); await expect(wizard.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
  await wizard.getByRole('button', { name: 'Choose template', exact: true }).click(); const p = picker(page); await pickerContract(p);
  await choose(p); await expect(p.getByRole('button', { name: 'Preview Daylight', exact: true })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Use Daylight', exact: true })).toBeEnabled(); await p.getByRole('button', { name: 'Use Daylight', exact: true }).click();
  await expect(wizard.getByText('Daylight', { exact: true })).toBeVisible(); await expect(wizard.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
  await wizard.getByRole('button', { name: 'Change', exact: true }).click(); await pickerContract(p); await closeDialog(p, 'Choose a Template');
  await wizard.getByRole('button', { name: 'Remove', exact: true }).click(); await expect(wizard.getByText('Daylight', { exact: true })).toHaveCount(0); await expect(wizard.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
});

test('A8/A10: the unbound chip opens real details, picker and save dialogs; no-template has both content tabs', async ({ page }) => {
  await openEditor(page, document(), 'Unbound template UI'); await expect(page.getByRole('button', { name: 'Template: No template', exact: true })).toBeVisible();
  await menu(page, 'View details'); const d = current(page); await expect(d.getByText('PERSONAL TEMPLATE', { exact: true })).toBeVisible(); await expect(d.getByRole('heading', { name: 'No template', exact: true })).toBeVisible();
  await expect(d.getByRole('button', { name: 'Save to My templates', exact: true })).toBeVisible(); await expect(d.getByRole('tab', { name: 'Included assets', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(d.getByRole('tabpanel', { name: 'Included assets', exact: true })).toContainText('This template holds creative guidance but no media.');
  await d.getByRole('tab', { name: 'Your preferences', exact: true }).click(); const prefs = d.getByRole('tabpanel', { name: 'Your preferences', exact: true });
  await expect(prefs.getByRole('switch', { name: 'Learn and update this template' })).toBeChecked(); await expect(prefs.getByRole('switch')).toBeDisabled();
  await expect(prefs).toContainText('This project has no template to write to yet.'); await expect(prefs).toContainText('Font and colour controls are not available for this template.'); await expect(prefs.getByRole('combobox')).toHaveCount(0);
  await d.getByRole('button', { name: 'Save to My templates', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Save as template', exact: true })).toBeVisible();
  await closeDialog(page.getByRole('dialog', { name: 'Save as template', exact: true }), 'Save as template');
  await menu(page, 'Change template'); await pickerContract(picker(page)); await closeDialog(picker(page), 'Choose a Template');
  await menu(page, 'Save as template'); await expect(page.getByRole('dialog', { name: 'Save as template', exact: true }).getByRole('textbox', { name: 'Template name' })).toHaveValue('Unbound template UI template');
});

test('A5: Library Templates has the same picker and hint; its action opens New Video with Daylight selected', async ({ page }) => {
  await page.goto('/assets'); await page.getByRole('tablist', { name: 'Library', exact: true }).getByRole('tab', { name: 'Templates', exact: true }).click();
  const p = page.getByRole('tabpanel', { name: 'Templates', exact: true }); await pickerContract(p); await expect(p).toContainText('Changing the template guides the next edits');
  await choose(p); await expect(p.getByRole('button', { name: 'New video with this template', exact: true })).toBeEnabled();
  await p.getByRole('button', { name: 'Preview Daylight', exact: true }).click(); await expect(p.getByRole('heading', { name: 'Daylight', exact: true })).toBeVisible(); await expect(p.getByRole('button', { name: 'New video with this template', exact: true })).toBeVisible();
  await p.getByRole('button', { name: '‹ Back', exact: true }).click(); await p.getByRole('button', { name: 'New video with this template', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'New Video', exact: true }); await expect(wizard.getByText('Daylight', { exact: true })).toBeVisible(); await expect(wizard.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
});

test('A11: search is live, mixed-case and name-only; author-only and nonsense give a silent empty list', async ({ page }) => {
  await openEditor(page, document(), 'Template search'); await menu(page, 'Change template'); const p = picker(page); await pickerContract(p);
  const search = p.getByRole('searchbox', { name: 'Find a template' }), rows = p.getByRole('list', { name: 'Built-in templates', exact: true });
  await search.fill('dAyLiGhT'); await expect(rows.getByRole('listitem')).toHaveCount(1); await expect(rows).toContainText('Daylight');
  for (const query of ['Cutframe', '__no_such_template__']) { await search.fill(query); await expect(rows.getByRole('listitem')).toHaveCount(0); await expect(rows).toHaveText(''); }
  await search.clear(); await expect(rows.getByRole('listitem')).toHaveCount(1);
});

test('A6: Daylight preview has its authored colours, examples, asset lists and real audio/image/font previews', async ({ page }) => {
  await openEditor(page, document(), 'Daylight preview'); await menu(page, 'Change template'); const p = picker(page); await preview(p);
  await expect(p.getByText('CUTFRAME TEMPLATE', { exact: true })).toBeVisible(); await expect(p.getByText('By Cutframe', { exact: true })).toBeVisible();
  for (const name of ['‹ Back', 'Use template', 'Save to My templates', 'Export template file']) await expect(p.getByRole('button', { name, exact: true })).toBeVisible();
  await colours(p); const examples = p.getByRole('region', { name: 'Examples', exact: true }); await expect(examples.getByRole('listitem')).toHaveCount(4);
  for (const name of EXAMPLES) await expect(examples.getByRole('button', { name: `Preview ${name}`, exact: true })).toBeVisible();
  await examples.getByRole('button', { name: 'Preview Big Headline', exact: true }).click(); await expect(examples.getByRole('group', { name: 'Big Headline preview', exact: true })).toContainText('Big Headline');
  const included = p.getByRole('tabpanel', { name: 'Included assets', exact: true });
  for (const [label, names] of [['Fonts', ['Manrope', 'Sora', 'Instrument Serif']], ['Audio', AUDIO], ['Images', IMAGES]] as const) {
    const section = included.getByRole('region', { name: label, exact: true }); await expect(section.getByRole('listitem')).toHaveCount(names.length);
    for (const name of names) await expect(section.getByRole('button', { name: `Preview ${name}`, exact: true })).toBeVisible();
  }
  await included.getByRole('button', { name: 'Preview Soft chime', exact: true }).click(); const audio = included.getByRole('group', { name: 'Soft chime preview', exact: true }).locator('audio');
  await expect(audio).toHaveAttribute('controls', ''); await expect.poll(async () => audio.evaluate((a: HTMLAudioElement) => a.readyState >= 1 || Number.isFinite(a.duration))).toBe(true);
  await included.getByRole('button', { name: 'Preview Sparkles', exact: true }).click(); const image = included.getByRole('group', { name: 'Sparkles preview', exact: true }).getByRole('img', { name: 'Sparkles', exact: true });
  await expect.poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await included.getByRole('button', { name: 'Preview Sora', exact: true }).click(); await expect(included.getByRole('group', { name: 'Sora preview', exact: true })).toContainText('The quick brown fox 0123');
  await form(p); await p.getByRole('button', { name: 'Save to My templates', exact: true }).click(); await expect(p.getByRole('button', { name: 'In My templates', exact: true })).toBeDisabled();
  await p.getByRole('button', { name: '‹ Back', exact: true }).click(); await p.getByRole('tab', { name: 'My templates', exact: true }).click(); await expect(p.getByRole('list', { name: 'My templates', exact: true })).toContainText('Daylight');
});

test('A8: Use writes binding/defaults, changes the chip, and adds no undo or redo entry', async ({ page }) => {
  const id = await openEditor(page, document(), 'Bind Daylight'); const before = await state(page, id); await bindDaylight(page);
  const after = await state(page, id); expect(after.record).toMatchObject({ template_id: 'daylight', template_epoch: 1 }); expect(after.document.templateDefaults).toEqual(DEFAULTS);
  expect(after.document.items).toEqual(before.document.items); await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled(); await expect(page.getByRole('button', { name: 'Redo', exact: true }).first()).toBeDisabled();
  await menu(page, 'View details'); const d = current(page); await expect(d.getByRole('heading', { name: 'Daylight', exact: true })).toBeVisible();
  await d.getByRole('button', { name: 'Change template', exact: true }).click(); await pickerContract(picker(page));
});

test('A8: after an edit then bind, Undo removes the edit but keeps the binding/defaults', async ({ page }) => {
  const id = await openEditor(page, document(), 'Undo across binding'); await addTitle(page); await saved(page); await bindDaylight(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeEnabled(); await expect(page.getByRole('button', { name: 'Redo', exact: true }).first()).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click(); await expect.poll(async () => (await live(page)).items.length).toBe(0); await saved(page);
  const after = await state(page, id); expect(after.record).toMatchObject({ template_id: 'daylight', template_epoch: 1 }); expect(after.document.templateDefaults).toEqual(DEFAULTS);
  await expect(page.getByRole('button', { name: 'Template: Daylight', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled(); await expect(page.getByRole('button', { name: 'Redo', exact: true }).first()).toBeEnabled();
});

test('A4/A5: first preference edit makes a personal copy; both tabs persist it, discard restores built-in, bound defaults stay fixed', async ({ page }) => {
  const id = await openEditor(page, document(), 'Personal preferences'); await bindDaylight(page); const bound = await state(page, id);
  await menu(page, 'View details'); const d = current(page); await colours(d); await form(d); expect(await templatesRow(page)).toBeNull(); await closeDialog(d, 'Current template');
  await menu(page, 'Change template'); const p = picker(page); await pickerContract(p); expect(await templatesRow(page)).toBeNull();
  await p.getByRole('tab', { name: 'My templates', exact: true }).click(); await expect(p.getByRole('heading', { name: 'No templates of your own yet', exact: true })).toBeVisible();
  await expect(p).toContainText('Open a built-in template and choose Save to My templates, or save a project as a template from the template menu in the editor.');
  await expect(p.getByRole('button', { name: 'Import template file', exact: true })).toBeVisible(); await expect(p.getByLabel('Template file', { exact: true })).toHaveAttribute('type', 'file'); expect(await templatesRow(page)).toBeNull();
  await preview(p); await colours(p); await form(p); expect(await templatesRow(page)).toBeNull();
  await p.getByRole('button', { name: 'Save to My templates', exact: true }).click(); await expect(p.getByRole('button', { name: 'In My templates', exact: true })).toBeDisabled();
  expect(await templatesRow(page)).toEqual({ id: 'templates', templates: [], membership: ['daylight'] }); await p.getByRole('button', { name: '‹ Back', exact: true }).click();
  for (const tab of ['Built-in templates', 'My templates']) {
    await preview(p, 'Daylight', tab); await colours(p); await form(p); expect((await templatesRow(page))!.templates).toEqual([]); await p.getByRole('button', { name: '‹ Back', exact: true }).click();
  }
  await preview(p); const f = await form(p); await f.getByRole('combobox', { name: 'Titles font', exact: true }).selectOption('Roboto-Regular'); await f.getByRole('textbox', { name: 'Colour 1 name', exact: true }).fill('Personal Chalk');
  await f.getByRole('button', { name: 'Save fonts & colors', exact: true }).click(); await expect(notices(page)).toContainText('Fonts and colours saved.');
  await expect.poll(async () => (await templatesRow(page))!.templates[0]?.defaults.titlesFont).toBe('Roboto-Regular');
  const personal = (await templatesRow(page))!.templates[0]; expect(personal).toMatchObject({ id: 'daylight', basedOn: 'daylight', defaults: { titlesFont: 'Roboto-Regular' } }); expect(personal.palette[0]).toEqual({ name: 'Personal Chalk', hex: '#FAFAF7' });
  const newFonts = { ...FONTS, titlesFont: 'Roboto-Regular' }, newPalette = PALETTE.map((s, n) => n === 0 ? { ...s, name: 'Personal Chalk' } : s);
  await closeDialog(p, 'Choose a Template'); await menu(page, 'View details'); await colours(d, newPalette); await form(d, newFonts, newPalette); await closeDialog(d, 'Current template');
  await menu(page, 'Change template');
  for (const tab of ['Built-in templates', 'My templates']) { await preview(p, 'Daylight', tab); await colours(p, newPalette); await form(p, newFonts, newPalette); await p.getByRole('button', { name: '‹ Back', exact: true }).click(); }
  expect(await state(page, id)).toEqual(bound);
  await preview(p); await p.getByRole('button', { name: 'Discard my changes', exact: true }).click(); await expect(notices(page)).toContainText('Daylight is back to its built-in values.');
  await colours(p); await form(p); await expect(p.getByRole('button', { name: 'Discard my changes', exact: true })).toHaveCount(0); expect((await templatesRow(page))!.templates).toEqual([]); expect(await state(page, id)).toEqual(bound);
});

test('A9/export: Save as template has locked defaults, never auto-picks footage, explicitly carries one library asset without changing the project', async ({ page }) => {
  const footage = { id: 'footage', type: 'image', trackId: 'V1', display: { from: 0, to: 4000 }, details: { name: 'Original footage' },
    properties: { positionX: prop(20), positionY: prop(20), width: prop(100), height: prop(100), scale: prop(1), opacity: prop(1) } };
  const id = await createProject(page, document([footage]), 'Carry this project'), assetId = await addAsset(page, id, 'chosen-footage.png'); await linkClip(page, id, assetId, 'footage');
  await page.goto(`/project/${id}`); await saved(page); const before = await state(page, id), beforeStored = await stored(page, id);
  await menu(page, 'Save as template'); const d = page.getByRole('dialog', { name: 'Save as template', exact: true });
  await expect(d.getByRole('textbox', { name: 'Template name', exact: true })).toHaveValue('Carry this project template'); await expect(d.getByRole('textbox', { name: 'What should it carry forward?', exact: true })).not.toHaveValue('');
  await expect(d).toContainText('The project itself does not change.'); await expect(d).toContainText('Learning starts on for the new template.');
  const assets = d.getByRole('region', { name: 'Reusable assets', exact: true }), locked = assets.getByRole('listitem'); await expect(locked).toHaveCount(2);
  await expect(locked.nth(0)).toHaveAttribute('data-locked', 'true'); await expect(locked.nth(0)).toContainText('Fonts:'); await expect(locked.nth(0)).toContainText('Automatic');
  await expect(locked.nth(1)).toHaveAttribute('data-locked', 'true'); await expect(locked.nth(1)).toContainText('Colours:'); await expect(locked.nth(1)).toContainText('Automatic'); await expect(assets.getByText('chosen-footage.png', { exact: true })).toHaveCount(0);
  await d.getByRole('textbox', { name: 'Template name', exact: true }).fill('My carry-forward'); await assets.getByRole('button', { name: 'Add from library', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add from library', exact: true }); await expect(library.getByRole('checkbox', { name: 'Select chosen-footage.png', exact: true })).not.toBeChecked();
  await library.getByRole('button', { name: 'Add chosen-footage.png', exact: true }).click(); await library.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(assets.getByRole('button', { name: 'Remove chosen-footage.png', exact: true })).toBeVisible(); await expect(assets.getByRole('listitem')).toHaveCount(3);
  await d.getByRole('button', { name: 'Save new template', exact: true }).click(); await expect(notices(page)).toContainText('My carry-forward is in My templates.'); expect(await state(page, id)).toEqual(before); expect((await stored(page, id)).json).toBe(beforeStored.json);
  const own = (await templatesRow(page))!.templates.find((t: Rec) => t.name === 'My carry-forward'); expect(own).toMatchObject({ learning: true, assets: { images: [{ name: 'chosen-footage.png', ref: `asset:${assetId}` }] } });
  await menu(page, 'Change template'); const p = picker(page); await preview(p, 'My carry-forward', 'My templates'); await expect(p.getByRole('region', { name: 'Images', exact: true }).getByRole('button', { name: 'Preview chosen-footage.png', exact: true })).toBeVisible(); await expect(p.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await p.getByRole('button', { name: 'Export template file', exact: true }).click(); const file = p.getByRole('group', { name: 'Template file', exact: true }); await expect(file.getByText('Media: chosen-footage.png', { exact: true })).toBeVisible(); await expect(file.getByText('Uploaded fonts: none', { exact: true })).toBeVisible();
  await expect(file.getByRole('button', { name: 'Download file', exact: true })).toBeVisible(); await file.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(file).toHaveCount(0); expect(await state(page, id)).toEqual(before);
});

test('S1: a second already-open editor refuses a stale selection and retains its unbound chip', async ({ page, context }) => {
  const id = await openEditor(page, document(), 'Two template tabs'), other = await context.newPage(); await localOnly(other);
  try {
    await other.goto(`/project/${id}`); await saved(other); await expect(other.getByRole('button', { name: 'Template: No template', exact: true })).toBeVisible();
    await bindDaylight(page); await menu(other, 'Change template'); const p = picker(other); await choose(p); await p.getByRole('button', { name: 'Use Daylight', exact: true }).click();
    await expect(notices(other)).toContainText('TEMPLATE_SELECTION_STALE: This project or template changed. Refresh it and review your choice again.'); await expect(p).toBeVisible();
    await closeDialog(p, 'Choose a Template'); await expect(other.getByRole('button', { name: 'Template: No template', exact: true })).toBeVisible();
    expect((await state(page, id)).record).toMatchObject({ template_id: 'daylight', template_epoch: 1 }); expect(leaks.get(other)).toEqual([]);
  } finally { await other.close(); }
});

const ownTemplate = (id: string, name: string, titlesFont = 'Roboto-Regular'): Rec => ({ id, name, family: 'Personal', author: 'You', palette: [{ name: 'Personal ink', hex: '#123456' }], examples: [],
  assets: { fonts: [{ name: 'Roboto', ref: 'font:Roboto' }], audio: [], images: [] }, defaults: { captionsFont: 'Roboto-Regular', titlesFont, accentFont: 'Roboto-Regular' },
  presetIds: [], guidance: 'A local test template.', learning: true, preferences: '', version: 1, savedAt: '2026-11-11T00:00:00.000Z' });
const storeOwn = (page: Page, template: Rec) => page.evaluate(async template => { const p = '/src/templates/library.ts', s = '/src/store/database.ts'; await (await import(p)).saveTemplate((await import(s)).projectStore, template); }, template);

test('deleted own template: the bound project shows Missing template and a real change action', async ({ page }) => {
  const id = await openEditor(page, document(), 'Deleted bound template'), template = ownTemplate('my-deleted-template', 'Temporary template'); await storeOwn(page, template);
  await menu(page, 'Change template'); const p = picker(page); await choose(p, template.name, 'My templates'); await p.getByRole('button', { name: 'Use Temporary template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Template: Temporary template', exact: true })).toBeVisible(); await saved(page); const before = await state(page, id);
  await menu(page, 'View details'); const d = current(page); await expect(d.getByRole('heading', { name: template.name, exact: true })).toBeVisible(); await d.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Template: Missing template', exact: true })).toBeVisible(); await menu(page, 'View details'); await expect(d).toContainText('This template is no longer in your library.');
  await d.getByRole('button', { name: 'Change template', exact: true }).click(); await expect(p).toBeVisible(); expect(await state(page, id)).toEqual(before);
});

test('R9-3/import: a template with an unavailable titles font binds with the same explicit notice in details', async ({ page }) => {
  const id = await openEditor(page, document(), 'Missing default font'), font = 'No Such T22 Titles Font', template = ownTemplate('my-missing-font', 'Missing font template', font);
  await menu(page, 'Change template'); const p = picker(page); await p.getByRole('tab', { name: 'My templates', exact: true }).click();
  await p.getByLabel('Template file', { exact: true }).setInputFiles({ name: 'missing-font.cutframe-template.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'cutframe-template', version: 1, template, assets: [] })) });
  await expect(notices(page)).toContainText('Missing font template was added to My templates.'); await preview(p, template.name, 'My templates');
  const line = `${font} is not available in this browser. The standard font is used in its place.`; await expect(p.getByRole('note')).toHaveText(line); await p.getByRole('button', { name: 'Use template', exact: true }).click();
  await expect(notices(page)).toContainText(line); await expect(page.getByRole('button', { name: 'Template: Missing font template', exact: true })).toBeVisible(); await saved(page);
  expect((await state(page, id)).record.template_id).toBe(template.id); await menu(page, 'View details'); await expect(current(page).getByRole('note')).toHaveText(line);
});

test('export: bundled Daylight carries no library media or uploaded fonts', async ({ page }) => {
  await openEditor(page, document(), 'Daylight export'); await menu(page, 'Change template'); const p = picker(page); await preview(p);
  await p.getByRole('button', { name: 'Export template file', exact: true }).click(); const file = p.getByRole('group', { name: 'Template file', exact: true });
  await expect(file.getByText('Media: none', { exact: true })).toBeVisible(); await expect(file.getByText('Uploaded fonts: none', { exact: true })).toBeVisible();
  await expect(file.getByRole('button', { name: 'Download file', exact: true })).toBeVisible(); await file.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(file).toHaveCount(0);
});

async function seedBinding(page: Page, id: string) {
  await page.evaluate(async id => { const p = '/src/store/database.ts', store = (await import(p)).projectStore;
    await store.swapRow('projects', id, (row: Rec) => ({ ...row, template_id: 'daylight', template_epoch: 1, template_request: 'seeded-binding' }));
  }, id);
}
test('repairDefaults on open fills missing defaults at the record epoch without creating history', async ({ page }) => {
  const id = await createProject(page, document(), 'Repair missing defaults'); await seedBinding(page, id); expect((await state(page, id)).document).not.toHaveProperty('templateDefaults');
  await page.goto(`/project/${id}`); await expect.poll(async () => (await state(page, id)).document.templateDefaults).toEqual(DEFAULTS); await saved(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled(); await expect(page.getByRole('button', { name: 'Redo', exact: true }).first()).toBeDisabled();
});
for (const bound of [false, true]) test(`repairDefaults on open leaves a ${bound ? 'correctly bound' : 'unbound'} document revision unchanged`, async ({ page }) => {
  const doc = document(); if (bound) doc.templateDefaults = structuredClone(DEFAULTS);
  const id = await createProject(page, doc, 'No-op defaults repair'); if (bound) await seedBinding(page, id); const before = await stored(page, id);
  await page.goto(`/project/${id}`); await expect(page.getByRole('button', { name: `Template: ${bound ? 'Daylight' : 'No template'}`, exact: true })).toBeVisible(); await saved(page);
  // Settle the actual async repair read, not an arbitrary delay or an explicit autosave flush.
  await page.evaluate(async id => { const p = '/src/store/database.ts'; await (await import(p)).projectStore.read(id); }, id);
  const after = await stored(page, id); expect(after.rev).toBe(before.rev); expect(after.json).toBe(before.json);
});

test('bundled variable Sora: a bound Text-panel title stores ExtraBold and differs in ink from an otherwise identical Regular item', async ({ page }) => {
  const id = await openEditor(page, document(), 'Two Sora weights'); await bindDaylight(page); const bold = await addTitle(page); await saved(page);
  const storedBold = (await state(page, id)).document.items.find((i: Rec) => i.id === bold.id); expect(storedBold.details).toMatchObject({ fontFamily: 'Sora-ExtraBold', fontFamilyDisplay: 'Sora' }); expect(storedBold.properties.fontWeight.defaultValue).toBe(800);
  await page.evaluate(async id => {
    const p = '/src/timeline/runtime.ts', f = '/src/text/fonts.ts', runtime = (await import(p)).activeRuntime, fonts = await import(f);
    await Promise.all(['Sora-ExtraBold', 'Sora-Regular'].map(name => fonts.loadFont(fonts.resolveFont(name))));
    runtime.bus.run('Add items', 'user', (doc: Rec) => {
      const source = doc.items.find((i: Rec) => i.id === id), regular = structuredClone(source);
      regular.id = 'sora-regular'; regular.display = { from: 5000, to: 10000 }; regular.details.fontFamily = 'Sora-Regular';
      regular.properties.fontWeight = { defaultValue: 400, keyframes: [] }; doc.items.push(regular); doc.duration = 10000;
    });
  }, bold.id);
  const regular = (await live(page)).items.find((i: Rec) => i.id === 'sora-regular'); expect(regular.details.text).toBe(bold.details.text); expect(regular.details.fontFamily).toBe('Sora-Regular'); expect(regular.properties.fontWeight.defaultValue).toBe(400);
  for (const key of ['positionX', 'positionY', 'width', 'height', 'fontSize', 'color', 'textAlign']) expect(regular.properties[key]).toEqual(bold.properties[key]);
  await setViewState(page, { selection: [], playheadMs: 500 }); await shown(page, 15); await expect(runCanvas(page)).toBeVisible();
  const pixels = () => runCanvas(page).evaluate(async (canvas: HTMLCanvasElement) => {
    const bytes = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0;
    for (let n = 3; n < bytes.length; n += 4) if (bytes[n] > 0) ink++;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
    return { ink, hash, width: canvas.width, height: canvas.height };
  });
  const thick = await pixels(); expect(thick.ink).toBeGreaterThan(100);
  await setViewState(page, { playheadMs: 6000 }); await shown(page, 180); const thin = await pixels(); expect(thin.ink).toBeGreaterThan(100);
  expect([thin.width, thin.height]).toEqual([thick.width, thick.height]); expect(thin.hash, 'relative pixels of the two real font weights, never a pinned screenshot hash').not.toBe(thick.hash);
});
