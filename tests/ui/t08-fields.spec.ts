// SPDX-License-Identifier: AGPL-3.0-only
// T08 inspector Fields section (review M5): a motion graphic whose code declares editable fields shows a "Fields" section above Basic and Transform with one control per
// field; each edit writes details.fieldValues[name] through the command path as exactly one "Edit items" undo step, and the render uses the value.
// Oracle: agent tool results (C) line 1726 (editable fields: text, number, color, boolean, text[], font, select; value = details.fieldValues[name], else the declared default).
// Provisional, not Xapp parity (fields.tsx): the label (meta.label, else the name), the choice list, text and number committing on blur or Enter, and no list removal.
// Logic below the UI is in tests/t08-fields.test.ts.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { guard, openEditor, skipTour } from './t02-support';
import { canvasSizeOf, crop, seekMs, shown } from './t15-support';

test.setTimeout(90_000);
test.use({ viewport: { width: 1280, height: 800 } });
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const seen: string[] = []; errors.set(page, seen);
  page.on('pageerror', e => seen.push(`pageerror: ${e.message}`));
  guard(page); await skipTour(page);
});
test.afterEach(async ({ page }) => { expect(errors.get(page), 'errors thrown in the page').toEqual([]); });

const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
/** One field of every type. The colour field is labelled; the others are labelled by their names. The text sits in the top-left corner. */
const ALL = `export const G = () => {
  const title = editable('title', 'Hello');
  const size = editable('size', 40);
  const bg = editable('bg', '#ff0000', { type: 'color', label: 'Background' });
  const show = editable('show', true);
  const lines = editable('lines', ['one', 'two']);
  const font = editable('font', 'Roboto', { type: 'font' });
  const mood = editable('mood', 'calm', { type: 'select', options: ['calm', 'loud'] });
  return <AbsoluteFill style={{ backgroundColor: bg }}><div style={{ position: 'absolute', left: 0, top: 0, fontFamily: font, fontSize: size }}>{show ? title : ''} {lines.join(' ')} {mood}</div></AbsoluteFill>;
};`;
/** A graphic that is only its background colour, so the centre pixel is the field's value. */
const COLOUR = `export const G = () => <AbsoluteFill style={{ backgroundColor: editable('bg', '#ff0000', { type: 'color', label: 'Background' }) }} />;`;
const NO_FIELDS = `export const G = () => <AbsoluteFill style={{ backgroundColor: '#112233' }} />;`;
const DOES_NOT_COMPILE = `export const G = () => <AbsoluteFill`;
/** 540 x 960 project, one overlay track, one full-canvas graphic g1 of the given code. */
function doc(code: string, details: Record<string, unknown> = {}) {
  const item = { id: 'g1', type: 'motionGraphic', trackId: 'o1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000, playbackRate: 1,
    details: { name: 'Fielder', code, ...details }, metadata: {}, effects: [], masks: [],
    properties: { positionX: prop(0), positionY: prop(0), width: prop(540), height: prop(960), scale: prop(1) } };
  return { schemaVersion: 4, rev: 0, groups: {}, duration: 4000, fps: 30, size: { width: 540, height: 960 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks: [{ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 }], layerOrder: [{ type: 'track', id: 'o1' }], items: [item] };
}

const graphic = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document.items.find((i: any) => i.id === 'g1'))); }) as Promise<any>;
const fieldValues = async (page: Page) => (await graphic(page)).details.fieldValues as Record<string, unknown> | undefined;
const undoStack = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; return (await import(p)).activeRuntime.bus.undoStack.map((e: any) => ({ label: e.label, source: e.source })); }) as Promise<{ label: string; source: string }[]>;
const dispatchUndo = (page: Page) => page.evaluate(async () => { const p = '/src/editor/commands.ts'; (await import(p)).dispatch({ type: 'undo' }); });
const inspector = (page: Page) => page.getByRole('region', { name: 'Inspector' });
const sectionTitles = (page: Page) => inspector(page).locator('details.inspector-section > summary').allTextContents();
const EDIT = { label: 'Edit items', source: 'user' };

/** Opens the project paused at 500 ms with the graphic selected, and waits for the inspector. */
async function openWith(page: Page, code: string, details: Record<string, unknown> = {}) {
  await openEditor(page, doc(code, details), 'T08 fields');
  await seekMs(page, 500);
  await page.evaluate(async () => { const p = '/src/editor/view.ts'; (await import(p)).select(['g1']); });
  await expect(inspector(page).locator('details.inspector-section > summary').filter({ hasText: /^Basic$/ })).toBeVisible();
}
/** The Fields section, opened (sections start closed). */
async function fieldsSection(page: Page): Promise<Locator> {
  const summary = inspector(page).locator('details.inspector-section > summary').filter({ hasText: /^Fields$/ });
  // The section appears when the code's compile resolves (sandbox boot plus compile, behind the preview's render): 3-9 s on a loaded machine, past the 5 s default.
  await expect(summary).toBeVisible({ timeout: 30_000 });
  const section = inspector(page).locator('details.inspector-section').filter({ has: page.locator('summary', { hasText: /^Fields$/ }) });
  if (!(await section.evaluate(el => (el as HTMLDetailsElement).open))) await summary.click();
  await expect(section).toHaveJSProperty('open', true);
  return section;
}
/** Waits until the code's field list is settled in the page (one compile per code), so an absent section is a real absence. */
const settled = (page: Page, code: string) => page.evaluate(async code => {
  const f = '/src/mg/frames.ts', d = '/src/store/database.ts', { graphicFields } = await import(f), { projectStore } = await import(d);
  await graphicFields(projectStore, code).then(() => null, () => null);
}, code);
const blurred = (field: Locator) => field.evaluate(el => (el as HTMLElement).blur());

test.describe('the section', () => {
  test('a graphic with fields shows "Fields" before Basic and Transform', async ({ page }) => {
    await openWith(page, ALL);
    await fieldsSection(page);
    const titles = await sectionTitles(page);
    expect(titles[0]).toBe('Fields');
    expect(titles.indexOf('Fields')).toBeLessThan(titles.indexOf('Basic'));
    expect(titles.indexOf('Basic')).toBeLessThan(titles.indexOf('Transform'));
    expect(titles.filter(t => t === 'Fields')).toHaveLength(1);
  });

  test('code without editable fields has no Fields section (Basic and Transform are still there)', async ({ page }) => {
    await openWith(page, NO_FIELDS);
    await settled(page, NO_FIELDS);
    await expect(inspector(page).locator('details.inspector-section > summary').filter({ hasText: /^Fields$/ })).toHaveCount(0);
    expect(await sectionTitles(page)).toEqual(expect.arrayContaining(['Basic', 'Transform']));
  });

  test('code that does not compile has no Fields section and the inspector still works', async ({ page }) => {
    await openWith(page, DOES_NOT_COMPILE);
    await settled(page, DOES_NOT_COMPILE);
    await expect(inspector(page).locator('details.inspector-section > summary').filter({ hasText: /^Fields$/ })).toHaveCount(0);
    expect(await sectionTitles(page)).toEqual(expect.arrayContaining(['Basic', 'Transform']));
  });

  test('a graphic with no code at all has no Fields section', async ({ page }) => {
    await openEditor(page, (() => { const d = doc(''); delete (d.items[0].details as any).code; return d; })(), 'T08 fields no code');
    await page.evaluate(async () => { const p = '/src/editor/view.ts'; (await import(p)).select(['g1']); });
    await expect(inspector(page).locator('details.inspector-section > summary').filter({ hasText: /^Basic$/ })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(inspector(page).locator('details.inspector-section > summary').filter({ hasText: /^Fields$/ })).toHaveCount(0);
  });

  // Review m4: listing no fields for no code loads neither the renderer (mg/index.ts, with the sandbox bundle) nor the compiler (Babel).
  test('selecting a graphic with empty code loads neither the renderer nor the compiler module', async ({ page }) => {
    const loaded: string[] = [];
    page.on('request', r => { const path = new URL(r.url()).pathname; if (path === '/src/mg/index.ts' || path === '/src/mg/compiler.ts') loaded.push(path); });
    await openEditor(page, doc(''), 'T08 fields empty code');
    await page.evaluate(async () => { const p = '/src/editor/view.ts'; (await import(p)).select(['g1']); });
    await expect(inspector(page).locator('details.inspector-section > summary').filter({ hasText: /^Basic$/ })).toBeVisible();
    expect(await page.evaluate(async () => { const f = '/src/mg/frames.ts', d = '/src/store/database.ts'; return (await import(f)).graphicFields((await import(d)).projectStore, ''); })).toEqual([]);
    await page.waitForTimeout(300);
    await expect(inspector(page).locator('details.inspector-section > summary').filter({ hasText: /^Fields$/ })).toHaveCount(0);
    expect(loaded).toEqual([]);
  });

  // Review m4: at most 100 fields are shown (a provisional coordinator default, no spec); the rest are counted on one line.
  test('a graphic that declares 150 fields shows the first 100 controls and one "50 more fields not shown" line', async ({ page }) => {
    const MANY = `export const G = () => { const v = []; for (let i = 0; i < 150; i++) v.push(editable('f' + i, 'v' + i)); return <AbsoluteFill />; };`;
    await openWith(page, MANY);
    const section = await fieldsSection(page);
    await expect(section.locator('label.row')).toHaveCount(100);
    await expect(section.getByRole('textbox', { name: 'f0', exact: true })).toHaveValue('v0');
    await expect(section.getByRole('textbox', { name: 'f99', exact: true })).toHaveValue('v99');
    await expect(section.getByRole('textbox', { name: 'f100', exact: true })).toHaveCount(0);
    await expect(section.getByText(/more fields? not shown$/)).toHaveText('50 more fields not shown');
  });

  test('opening the section and looking at it changes nothing (no undo entry, no fieldValues written)', async ({ page }) => {
    await openWith(page, ALL);
    await fieldsSection(page);
    expect(await undoStack(page)).toEqual([]);
    expect(await fieldValues(page)).toBeUndefined();
  });
});

test.describe('one control per type, showing the declared default', () => {
  test('the seven controls', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page);
    await expect(s.getByLabel('title', { exact: true })).toHaveValue('Hello');
    await expect(s.getByLabel('size', { exact: true })).toHaveValue('40');
    await expect(s.getByLabel('size', { exact: true })).toHaveAttribute('type', 'number');
    await expect(s.getByRole('button', { name: 'Background: #ff0000' })).toBeVisible();
    await expect(s.getByRole('switch', { name: 'show' })).toHaveAttribute('aria-checked', 'true');
    const list = s.getByRole('group', { name: 'lines' });
    await expect(list.getByLabel('lines 1')).toHaveValue('one');
    await expect(list.getByLabel('lines 2')).toHaveValue('two');
    await expect(list.getByRole('button', { name: 'Add to lines' })).toBeVisible();
    await expect(s.getByRole('combobox', { name: 'font' })).toHaveValue('Roboto');
    const mood = s.getByRole('combobox', { name: 'mood' });
    await expect(mood).toHaveValue('calm');
    expect(await mood.locator('option').allTextContents()).toEqual(['calm', 'loud']);
  });

  test('no extra controls: the section holds exactly the seven fields', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page);
    await expect(s.locator('label.row, div.field-list')).toHaveCount(7);
  });

  test('a stored value is shown instead of the default (and the others keep theirs)', async ({ page }) => {
    await openWith(page, ALL, { fieldValues: { title: 'Stored', size: 12, show: false, lines: ['solo'], mood: 'loud', bg: '#00ff00' } });
    const s = await fieldsSection(page);
    await expect(s.getByLabel('title', { exact: true })).toHaveValue('Stored');
    await expect(s.getByLabel('size', { exact: true })).toHaveValue('12');
    await expect(s.getByRole('switch', { name: 'show' })).toHaveAttribute('aria-checked', 'false');
    await expect(s.getByRole('group', { name: 'lines' }).getByRole('textbox')).toHaveCount(1);
    await expect(s.getByRole('combobox', { name: 'mood' })).toHaveValue('loud');
    await expect(s.getByRole('button', { name: 'Background: #00ff00' })).toBeVisible();
    await expect(s.getByRole('combobox', { name: 'font' })).toHaveValue('Roboto');
  });
});

test.describe('each edit is one "Edit items" user step in details.fieldValues, and undo restores it', () => {
  type Case = { name: string; act: (page: Page, s: Locator) => Promise<void>; key: string; value: unknown; shown: (s: Locator) => Promise<void> };
  const cases: Case[] = [
    { name: 'text (Enter)', key: 'title', value: 'World',
      act: async (_p, s) => { const f = s.getByLabel('title', { exact: true }); await f.fill('World'); await f.press('Enter'); },
      shown: s => expect(s.getByLabel('title', { exact: true })).toHaveValue('World') as unknown as Promise<void> },
    { name: 'number (Enter)', key: 'size', value: 55,
      act: async (_p, s) => { const f = s.getByLabel('size', { exact: true }); await f.fill('55'); await f.press('Enter'); },
      shown: s => expect(s.getByLabel('size', { exact: true })).toHaveValue('55') as unknown as Promise<void> },
    { name: 'colour (hex field)', key: 'bg', value: '#00ff00',
      act: async (page, s) => { await s.getByRole('button', { name: /^Background: / }).click(); const hex = page.getByRole('dialog', { name: 'Background colour' }).getByLabel('Hex'); await hex.fill('00ff00'); await hex.press('Enter'); },
      shown: s => expect(s.getByRole('button', { name: 'Background: #00ff00' })).toBeVisible() as unknown as Promise<void> },
    { name: 'toggle', key: 'show', value: false,
      act: async (_p, s) => { await s.getByRole('switch', { name: 'show' }).click(); },
      shown: s => expect(s.getByRole('switch', { name: 'show' })).toHaveAttribute('aria-checked', 'false') as unknown as Promise<void> },
    { name: 'list entry (Enter)', key: 'lines', value: ['uno', 'two'],
      act: async (_p, s) => { const f = s.getByRole('group', { name: 'lines' }).getByLabel('lines 1'); await f.fill('uno'); await f.press('Enter'); },
      shown: s => expect(s.getByRole('group', { name: 'lines' }).getByLabel('lines 1')).toHaveValue('uno') as unknown as Promise<void> },
    { name: 'list "Add"', key: 'lines', value: ['one', 'two', ''],
      act: async (_p, s) => { await s.getByRole('button', { name: 'Add to lines' }).click(); },
      shown: s => expect(s.getByRole('group', { name: 'lines' }).getByRole('textbox')).toHaveCount(3) as unknown as Promise<void> },
    { name: 'choice', key: 'mood', value: 'loud',
      act: async (_p, s) => { await s.getByRole('combobox', { name: 'mood' }).selectOption('loud'); },
      shown: s => expect(s.getByRole('combobox', { name: 'mood' })).toHaveValue('loud') as unknown as Promise<void> },
  ];
  for (const c of cases) {
    test(`${c.name}: details.fieldValues.${c.key} is written, one user "Edit items" entry, undo removes it`, async ({ page }) => {
      await openWith(page, ALL);
      const s = await fieldsSection(page);
      await c.act(page, s);
      await expect.poll(async () => (await fieldValues(page))?.[c.key]).toEqual(c.value);
      expect(Object.keys((await fieldValues(page)) ?? {})).toEqual([c.key]);
      expect(await undoStack(page)).toEqual([EDIT]);
      await c.shown(s);
      await dispatchUndo(page);
      await expect.poll(async () => (await fieldValues(page))?.[c.key]).toBeUndefined();
      expect(await undoStack(page)).toEqual([]);
      await expect(s.getByLabel('title', { exact: true })).toHaveValue('Hello');
    });
  }

  // The sandbox catalogue (agent-checks.ts SANDBOX_FAMILY_NAMES) holds one family, Roboto, so the list is [Roboto]; a stored font outside it is kept as an extra option.
  test('the font select lists the sandbox catalogue; a stored font outside it is shown too, and choosing Roboto writes it as one step', async ({ page }) => {
    await openWith(page, ALL, { fieldValues: { font: 'Pacifico' } });
    const s = await fieldsSection(page), select = s.getByRole('combobox', { name: 'font' });
    await expect(select).toHaveValue('Pacifico');
    expect(await select.locator('option').evaluateAll(list => list.map(o => (o as HTMLOptionElement).value))).toEqual(['Roboto', 'Pacifico']);
    await select.selectOption('Roboto');
    await expect.poll(async () => (await fieldValues(page))?.font).toBe('Roboto');
    expect(await undoStack(page)).toEqual([EDIT]);
    await dispatchUndo(page);
    await expect.poll(async () => (await fieldValues(page))?.font).toBe('Pacifico');
  });

  test('five edits in a row are five "Edit items" entries, each undone by one Undo, in reverse order', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page);
    const title = s.getByLabel('title', { exact: true });
    await title.fill('A'); await title.press('Enter');
    await s.getByRole('switch', { name: 'show' }).click();
    await s.getByRole('combobox', { name: 'mood' }).selectOption('loud');
    const size = s.getByLabel('size', { exact: true }); await size.fill('60'); await size.press('Enter');
    await s.getByRole('button', { name: 'Add to lines' }).click();
    await expect.poll(async () => (await undoStack(page)).length).toBe(5);
    expect(await undoStack(page)).toEqual(Array(5).fill(EDIT));
    expect(await fieldValues(page)).toEqual({ title: 'A', show: false, mood: 'loud', size: 60, lines: ['one', 'two', ''] });
    await dispatchUndo(page);
    expect(await fieldValues(page)).toEqual({ title: 'A', show: false, mood: 'loud', size: 60 });
    await dispatchUndo(page); await dispatchUndo(page);
    expect(await fieldValues(page)).toEqual({ title: 'A', show: false });
  });

  test('other details survive an edit (name and code are unchanged)', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page), title = s.getByLabel('title', { exact: true });
    await title.fill('World'); await title.press('Enter');
    await expect.poll(async () => (await fieldValues(page))?.title).toBe('World');
    const g = await graphic(page);
    expect(g.details.name).toBe('Fielder'); expect(g.details.code).toBe(ALL);
  });
});

test.describe('text and number commit on blur or Enter; an unchanged value adds no entry', () => {
  test('typing alone commits nothing; blur commits once', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page), title = s.getByLabel('title', { exact: true });
    await title.fill('Typing');
    expect(await undoStack(page)).toEqual([]);
    expect(await fieldValues(page)).toBeUndefined();
    await blurred(title);
    await expect.poll(async () => (await fieldValues(page))?.title).toBe('Typing');
    expect(await undoStack(page)).toEqual([EDIT]);
  });
  test('number: typing alone commits nothing; Tab (blur) commits the number once', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page), size = s.getByLabel('size', { exact: true });
    await size.fill('72');
    expect(await undoStack(page)).toEqual([]);
    await size.press('Tab');
    await expect.poll(async () => (await fieldValues(page))?.size).toBe(72);
    expect(await undoStack(page)).toEqual([EDIT]);
  });
  test('a text that equals the current value adds no entry (Enter and blur)', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page), title = s.getByLabel('title', { exact: true });
    await title.fill('Hello'); await title.press('Enter');
    await title.fill('Hello'); await blurred(title);
    expect(await undoStack(page)).toEqual([]);
    expect(await fieldValues(page)).toBeUndefined();
  });
  test('a number that equals the current value adds no entry; a number written as "40.0" is the same number', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page), size = s.getByLabel('size', { exact: true });
    await size.fill('40'); await size.press('Enter');
    await size.fill('40.0'); await size.press('Enter');
    expect(await undoStack(page)).toEqual([]);
  });
  test('an empty number field restores the value shown and adds no entry', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page), size = s.getByLabel('size', { exact: true });
    await size.fill(''); await size.press('Enter');
    await expect(size).toHaveValue('40');
    expect(await undoStack(page)).toEqual([]);
    expect(await fieldValues(page)).toBeUndefined();
  });
  test('a set value that is then edited back to the default is an entry (the item\'s value changed), and not a second one when repeated', async ({ page }) => {
    await openWith(page, ALL, { fieldValues: { title: 'Stored' } });
    const s = await fieldsSection(page), title = s.getByLabel('title', { exact: true });
    await title.fill('Hello'); await title.press('Enter');
    await expect.poll(async () => (await fieldValues(page))?.title).toBe('Hello');
    await title.fill('Hello'); await title.press('Enter');
    expect(await undoStack(page)).toEqual([EDIT]);
  });
  test('an unchanged colour (the same hex) adds no entry', async ({ page }) => {
    await openWith(page, ALL);
    const s = await fieldsSection(page);
    await s.getByRole('button', { name: /^Background: / }).click();
    const hex = page.getByRole('dialog', { name: 'Background colour' }).getByLabel('Hex');
    await hex.fill('ff0000'); await hex.press('Enter');
    expect(await undoStack(page)).toEqual([]);
  });
});

test.describe('the render uses the value', () => {
  const centre = async (page: Page) => {
    const size = await canvasSizeOf(page), px = await crop(page, Math.floor(size.width / 2), Math.floor(size.height / 2), 1, 1);
    return [px[0], px[1], px[2]];
  };
  test('the default colour is drawn, an edited colour is drawn after the edit, and Undo draws the default again', async ({ page }) => {
    await openWith(page, COLOUR);
    await shown(page, 15);
    expect(await centre(page), 'the declared default #ff0000').toEqual([255, 0, 0]);
    const s = await fieldsSection(page);
    await s.getByRole('button', { name: /^Background: / }).click();
    const hex = page.getByRole('dialog', { name: 'Background colour' }).getByLabel('Hex');
    await hex.fill('00ff00'); await hex.press('Enter');
    await expect.poll(() => centre(page), { message: 'the edited colour reaches the stage', timeout: 15000 }).toEqual([0, 255, 0]);
    await dispatchUndo(page);
    await expect.poll(() => centre(page), { message: 'Undo draws the default again', timeout: 15000 }).toEqual([255, 0, 0]);
  });
  test('a stored value is drawn when the project opens', async ({ page }) => {
    await openWith(page, COLOUR, { fieldValues: { bg: '#0000ff' } });
    await shown(page, 15);
    expect(await centre(page)).toEqual([0, 0, 255]);
  });
});
