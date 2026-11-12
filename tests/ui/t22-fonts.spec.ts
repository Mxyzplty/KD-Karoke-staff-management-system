// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 12 / A14 and lane A's rulings: the order of the two font pickers, read from the real DOM.
// Text picker (inspector): every registry family in rank order, then uploads; no role filter; no family twice.
// Caption picker (Captions panel): the APPLIED caption template's list in its order, then the other registry families in rank
// order, then uploads; no template applied gives the general order. Oracle: FONT_LISTS and FONT_REGISTRY data, ordered here
// by that rule, never fontPickerOrder's output. A fresh browser context has no uploads. External requests are aborted and fail the case.
import { test, expect, type Page } from '@playwright/test';
import { clip, openEditor, skipTour } from './t02-support';
import { panel, prop, section } from './t04-support';

test.use({ viewport: { width: 1400, height: 900 } }); test.setTimeout(90_000);
type Rec = Record<string, any>;
const blocked = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  await skipTour(page); blocked.set(page, []);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname) || ['data:', 'blob:', 'about:'].includes(url.protocol)) return route.continue();
    blocked.get(page)!.push(url.href); return route.abort();
  });
});
test.afterEach(async ({ page }) => { expect(blocked.get(page), 'no off-localhost requests, even failed ones').toEqual([]); });

const props = (values: Rec) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, prop(value)]));
const track = (id: string, kind: string) => ({ id, name: id, kind, hidden: false, locked: false, muted: false, solo: false, volume: 1 });
// Roboto 400/700 are served locally (text/fonts.ts), so neither seeded item needs a remote face.
const FONT = { fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' };
function doc(): Rec {
  const tracks = [track('V1', 'video'), track('O1', 'overlay'), track('C1', 'caption')];
  const words = [['hello', 0, 800], ['brave', 1000, 1800], ['world', 2000, 2800]].map(([text, startMs, endMs]) => ({ text, startMs, endMs, sourceStartMs: startMs, sourceEndMs: endMs }));
  return { schemaVersion: 4, rev: 0, groups: {}, duration: 6000, fps: 30, size: { width: 1080, height: 1920 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), items: [
      { id: 'title', type: 'text', trackId: 'O1', display: { from: 0, to: 4000 }, details: { text: 'Picker title', ...FONT }, effects: [], masks: [],
        properties: props({ positionX: 140, positionY: 300, width: 800, height: 200, fontSize: 96, fontWeight: 700, color: '#FFFFFF', textAlign: 'left', scale: 1, opacity: 1 }) },
      // A detached caption with no template anywhere (T09's fixture shape); no transcription.
      { id: 'cap', type: 'caption', trackId: 'C1', display: { from: 0, to: 3000 }, trim: { from: 0, to: 3000 }, playbackRate: 1, masks: [], effects: [], metadata: { captionMode: 'detached' },
        details: { text: 'hello brave world', words, ...FONT, renderMode: 'default', renderConfig: {} },
        properties: props({ opacity: 1, scale: 1, rotation: 0, fontSize: 65, fontWeight: '700', color: '#FFFFFF', backgroundColor: 'transparent', textAlign: 'center',
          borderWidth: 3, borderColor: '#000000', boxShadow: { color: '#000000', x: 0, y: 0, blur: 0 }, positionX: 200, positionY: 1344, width: 680, height: 120 }) },
    ] };
}
type FontData = { lists: Record<string, string[]>; registry: { family: string; rank: number | null; source: string }[]; templates: { id: string; name: string }[] };
/** The declared data, read in the page (the modules need Vite): each list's families and the registry's families with ranks. */
const fontData = (page: Page): Promise<FontData> => page.evaluate(async () => {
  const fp = '/src/catalogue/fonts.ts', rp = '/src/text/font-registry.ts', tp = '/src/captions/templates.ts';
  const lists = (await import(fp)).FONT_LISTS as Record<string, { family: string }[]>, registry = (await import(rp)).FONT_REGISTRY as Rec[], templates = (await import(tp)).TEMPLATES as Rec[];
  return { lists: Object.fromEntries(Object.entries(lists).map(([id, list]) => [id, list.map(pick => pick.family)])),
    registry: registry.map(f => ({ family: f.family, rank: f.rank, source: f.source })), templates: templates.map(t => ({ id: t.id, name: t.name })) };
});
/** The rule, computed from the data: registry rank order; a template's own list goes first and no family repeats. */
function general(data: FontData): string[] {
  for (const f of data.registry) expect(typeof f.rank, `${f.family} has a rank`).toBe('number');
  const ranked = [...data.registry].sort((a, b) => a.rank! - b.rank!).map(f => f.family);
  expect(ranked.length).toBeGreaterThan(0); expect(new Set(ranked).size, 'the registry names no family twice').toBe(ranked.length); return ranked;
}
function forTemplate(data: FontData, id: string): string[] {
  const own = data.lists[id], ranked = general(data);
  expect(own, `${id} has a font list`).toBeDefined(); expect(own, `${id}: four families`).toHaveLength(4); expect(new Set(own).size).toBe(4);
  for (const family of own) expect(ranked, `${id}: ${family} is a registry family`).toContain(family);
  return [...own, ...ranked.filter(family => !own.includes(family))];
}
const nameOf = (data: FontData, id: string) => { const t = data.templates.find(t => t.id === id); expect(t, `caption template ${id}`).toBeDefined(); return t!.name; };

const tool = (page: Page) => page.getByRole('region', { name: 'Captions', exact: true });
async function openCaptions(page: Page) {
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Captions' }).click(); await expect(tool(page)).toBeVisible();
}
const captionOptions = (page: Page): Promise<string[]> => tool(page).getByLabel('Caption font', { exact: true }).locator('option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value));
/** Change browses and makes the tile pending; nothing is applied until Apply (the T09 flow). */
async function pickTemplate(page: Page, name: string) {
  await tool(page).getByRole('button', { name: 'Change template' }).click();
  const gallery = page.getByRole('dialog', { name: 'Caption templates' }); await gallery.getByRole('option', { name: new RegExp(name) }).click();
  await gallery.getByRole('button', { name: 'Close' }).click(); await expect(gallery).toBeHidden();
  await expect(tool(page).locator('[aria-label="Selected template"]')).toContainText(name);
}
async function applyTemplate(page: Page, name: string) {
  await pickTemplate(page, name); const apply = tool(page).getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeEnabled(); await apply.click(); await expect(apply).toBeDisabled();
}
/** The inspector's font list of the selected item: each option's family is its button's own text, before the category note. */
async function inspectorFamilies(page: Page, itemId: string): Promise<string[]> {
  await clip(page, itemId).click(); const body = await section(page, 'Text');
  await body.getByRole('button', { name: /^Font: / }).click();
  const list = page.getByRole('listbox', { name: 'Font families', exact: true }); await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toBeVisible();
  return list.getByRole('option').evaluateAll(options => options.map(o => (o.querySelector('button')?.childNodes[0]?.textContent ?? '').trim()));
}
function expectOrder(actual: string[], expected: string[], label: string) {
  expect(new Set(actual).size, `${label}: no family twice`).toBe(actual.length); expect(actual, label).toEqual(expected);
}

test('text picker: every registry family in rank order, no role filter, no family twice', async ({ page }) => {
  await openEditor(page, doc(), 'T22 text font picker'); const data = await fontData(page), expected = general(data);
  const actual = await inspectorFamilies(page, 'title');
  expectOrder(actual, expected, 'the general order'); expect(actual).toHaveLength(data.registry.length);
  // No role filter: a caption-only pick of a template list (cinema's Barlow is role "caption") is still offered for text.
  for (const list of Object.values(data.lists)) for (const family of list) expect(actual, family).toContain(family);
  await expect(panel(page).getByRole('button', { name: 'Font: Roboto', exact: true })).toBeVisible();
});

test('caption picker with no template applied shows the general order', async ({ page }) => {
  await openEditor(page, doc(), 'T22 caption font picker'); await openCaptions(page); const data = await fontData(page);
  await expect(tool(page).locator('[aria-label="Selected template"]')).toHaveText('None');
  expectOrder(await captionOptions(page), general(data), 'no template: the general order');
});

for (const id of ['cinema', 'editorial']) test(`caption picker with ${id} applied: its four families first, in list order, then the rest in rank order`, async ({ page }) => {
  await openEditor(page, doc(), `T22 caption fonts ${id}`); await openCaptions(page); const data = await fontData(page), expected = forTemplate(data, id);
  await applyTemplate(page, nameOf(data, id));
  await expect.poll(() => captionOptions(page), { message: `${id}: the applied template's order` }).toEqual(expected);
  const actual = await captionOptions(page); expectOrder(actual, expected, id);
  expect(actual.slice(0, 4)).toEqual(data.lists[id]); expect(actual.slice(4)).toEqual(general(data).filter(family => !data.lists[id].includes(family)));
  expect(actual, 'nothing is left out').toHaveLength(data.registry.length);
});

test('caption picker follows the template when it is changed in the UI, and only once the change is applied', async ({ page }) => {
  await openEditor(page, doc(), 'T22 caption fonts change'); await openCaptions(page); const data = await fontData(page);
  const plain = general(data), cinema = forTemplate(data, 'cinema'), editorial = forTemplate(data, 'editorial');
  expect(cinema).not.toEqual(editorial); expect(cinema).not.toEqual(plain); expect(editorial).not.toEqual(plain);
  expectOrder(await captionOptions(page), plain, 'before any template');
  // A pending tile is not the applied template: the order stays until Apply.
  await pickTemplate(page, nameOf(data, 'cinema')); expectOrder(await captionOptions(page), plain, 'cinema pending, not applied');
  await tool(page).getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => captionOptions(page), { message: 'cinema applied' }).toEqual(cinema);
  await pickTemplate(page, nameOf(data, 'editorial')); expectOrder(await captionOptions(page), cinema, 'editorial pending, cinema still applied');
  await tool(page).getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => captionOptions(page), { message: 'editorial applied' }).toEqual(editorial);
  expectOrder(await captionOptions(page), editorial, 'the new template');
});

test('a caption with no template: its inspector font list is the general order', async ({ page }) => {
  await openEditor(page, doc(), 'T22 caption inspector fonts'); const data = await fontData(page);
  expectOrder(await inspectorFamilies(page, 'cap'), general(data), 'caption item, no template');
});
