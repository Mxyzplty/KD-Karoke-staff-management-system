// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 9 part 1: A4/A18, P3/P4/Q1, OQ-1 and R9-1..R9-3. Default font precedence is asserted from the pinned rules.
// Old defaults are literal T05/T09 expectations; bound-vs-unbound comparisons check only the specified unchanged fields.
// Font-dependent measured boxes are checked for centring, not compared as a glyph-metric oracle in Node.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import { emptyDocument } from '../apps/web/src/store/model';
import type { Asset, ProjectDocument, RecordData } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { CommandBus } from '../apps/web/src/timeline/bus';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext } from '../apps/web/src/timeline/tools';
import { valueAt, staticValue } from '../apps/web/src/timeline/properties';
import { ADD_TEXT, AGENT_TEXT, addTextPreset, addTextIn } from '../apps/web/src/text/tools';
import { PARITY } from '../apps/web/src/text/parity-switches';
import { addCaptionsIn, addCaptionsPanel } from '../apps/web/src/captions/tools';
import type { SourceData } from '../apps/web/src/captions/generation';
import type { Transcript } from '../apps/web/src/analysis/types';
import { PANEL_STYLE, AGENT_STYLE } from '../apps/web/src/captions/templates';
import { DEFAULT_TEMPLATE } from '../apps/web/src/templates/default';
import { defaultFont, templateProblem } from '../apps/web/src/templates/model';
import type { Template } from '../apps/web/src/templates/model';
import { bindTemplate, writeDefaults } from '../apps/web/src/templates/binding';
import { projectDefaults, templateFromProject, PROJECT_PALETTE_MAX, TEMPLATE_AUTHOR, saveTemplate, findTemplate, updateTemplate } from '../apps/web/src/templates/library';
import { assets, build, itemOf, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

const notifySpy = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/ui', async original => ({ ...await original<typeof import('../apps/web/src/ui')>(), notify: notifySpy }));
const opened: ProjectStore[] = [], NOW = new Date('2026-11-11T06:00:00.000Z');
beforeEach(() => { useIds(); notifySpy.mockClear(); PARITY.looks = 'catalogue'; PARITY.weightFace = 'switch'; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(async () => { for (const store of opened.splice(0)) await store.close(); resetIds(); vi.useRealTimers(); });
const p = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
const props = (values: RecordData) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, p(value)]));
const v = (item: RecordData, key: string) => valueAt(item, key, 0);
type State = 'absent' | 'undefined' | 'empty' | 'bound' | 'bad-title' | 'bad-caption';
const UNBOUND: State[] = ['absent', 'undefined', 'empty'];
function base(state: State = 'absent'): ProjectDocument {
  let doc = build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay'), mkTrack('C1', 'caption')],
    items: [video('v1', 'V1', 10000, 14000, 20000, 60000)], extra: { size: { width: 1080, height: 1920 } } });
  if (state === 'undefined') doc.templateDefaults = undefined;
  if (state === 'empty') doc.templateDefaults = {};
  if (state === 'bound' || state === 'bad-title' || state === 'bad-caption') {
    doc = writeDefaults(doc, DEFAULT_TEMPLATE, 7);
    if (state === 'bad-title') (doc.templateDefaults as RecordData).titlesFont = 'No Such Title Family';
    if (state === 'bad-caption') (doc.templateDefaults as RecordData).captionsFont = 'No Such Caption Family';
  }
  return doc;
}
const TRANSCRIPT: Transcript = { language: 'en', languages: ['en'], total_duration: 30, segments: [{ id: 0, speaker: 0, start: 20.2, end: 23.4, text: 'alpha beta gamma delta',
  words: [{ word: 'alpha', start: 20.2, end: 20.6 }, { word: 'beta', start: 21, end: 21.4 }, { word: 'gamma', start: 22, end: 22.4 }, { word: 'delta', start: 23, end: 23.4 }] }] };
const provider = (): SourceData => ({ status: 'complete', transcript: TRANSCRIPT, music: false });
function command(input: ProjectDocument) {
  let doc = structuredClone(input); const bus = new CommandBus({ get: () => doc, set: next => { doc = next; } });
  const ctx: ToolContext = { bus, asset: id => assets().find(a => a.id === id), captionData: provider };
  return { ctx, get doc() { return doc; } };
}
function panelTitle(input: ProjectDocument, drop = false) {
  useIds(); const doc = structuredClone(input), id = addTextPreset(doc, undefined, drop ? { trackId: 'O2', timeMs: 2500 } : undefined);
  return { doc, item: itemOf(doc, id) };
}
function agentTitle(input: ProjectDocument, args: RecordData = {}) {
  useIds(); const world = command(input), result = callTool(world.ctx, 'addText', { textContent: 'Agent title', trackId: 'O1', ...args });
  expect(result.success, JSON.stringify(result)).toBe(true); return { doc: world.doc, item: itemOf(world.doc, result.data.itemId), result };
}
type CaptionPath = 'agent' | 'panel';
function captions(input: ProjectDocument, path: CaptionPath, args: RecordData = {}) {
  useIds(); const world = command(input), result = path === 'agent' ? callTool(world.ctx, 'addCaptions', { trackId: 'C1', ...args })
    : addCaptionsPanel(world.doc, { trackId: 'C1', ...args }, provider);
  expect(result.success, JSON.stringify(result)).toBe(true);
  const items = world.doc.items.filter(item => item.type === 'caption'); expect(items.length).toBeGreaterThan(0);
  return { doc: world.doc, items, result };
}
type Font = { family: string; face: string; weight: number };
const SORA: Font = { family: 'Sora', face: 'Sora-ExtraBold', weight: 800 }, MANROPE: Font = { family: 'Manrope', face: 'Manrope-Bold', weight: 700 };
const ROBOTO_BOLD: Font = { family: 'Roboto', face: 'Roboto-Bold', weight: 700 }, ROBOTO: Font = { family: 'Roboto', face: 'Roboto-Regular', weight: 400 };
const OPEN_SANS: Font = { family: 'Open Sans', face: 'OpenSans-Regular', weight: 400 };
type LegacyStorage = { weight?: 'absent'; style?: 'absent' };
function expectFont(item: RecordData, font: Font, caption = false, legacy: LegacyStorage = {}) {
  expect(item.details).toMatchObject({ fontFamily: font.face, fontFamilyDisplay: font.family, fontUrl: expect.any(String) });
  expect(item.details.fontUrl).toContain(`family=${encodeURIComponent(font.family).replace(/%20/g, '+')}`);
  // R9 clarification: old preset/family-name paths omit these fields; named faces and captions store them explicitly.
  if (legacy.weight === 'absent') expect(item.properties).not.toHaveProperty('fontWeight');
  else expect(v(item, 'fontWeight')).toBe(caption ? String(font.weight) : font.weight);
  if (legacy.style === 'absent') expect(item.properties).not.toHaveProperty('fontStyle');
  else expect(v(item, 'fontStyle')).toBe('normal');
}
function centred(item: RecordData, doc: ProjectDocument) {
  const width = Number(v(item, 'width')), height = Number(v(item, 'height'));
  expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0);
  expect(v(item, 'positionX')).toBe(Math.round((doc.size.width - width) / 2)); expect(v(item, 'positionY')).toBe(Math.round((doc.size.height - height) / 2));
}
function nonFontLook(item: RecordData) {
  const copy = structuredClone(item);
  for (const key of ['fontFamily', 'fontFamilyDisplay', 'fontUrl', 'width', 'height']) delete copy.details[key];
  for (const key of ['fontWeight', 'fontStyle', 'positionX', 'positionY', 'width', 'height']) delete copy.properties[key];
  return copy;
}
const fontDigest = (item: RecordData) => ({ family: item.details.fontFamily, display: item.details.fontFamilyDisplay, url: item.details.fontUrl, weight: v(item, 'fontWeight'), style: v(item, 'fontStyle') });
function setup() {
  const bytes = new Map<string, Blob>(), media: MediaStore = { write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!), remove: vi.fn(async () => {}) };
  const store = new ProjectStore(crypto.randomUUID(), () => NOW.getTime(), media); opened.push(store); return store;
}

describe('unbound baselines: absent/undefined/empty defaults retain T05/T09 storage', () => {
  it('the documented baseline constants remain Roboto Bold 150/5s and agent 100/.6/3s, with distinct caption defaults', () => {
    expect(ADD_TEXT).toEqual({ text: 'Heading', family: 'Roboto', weight: 700, fontSize: 150, color: '#ffffff', textAlign: 'center', wordWrap: 'break-word', durationMs: 5000 });
    expect(AGENT_TEXT).toMatchObject({ fontSize: 100, widthShare: 0.6, durationMs: 3000 });
    expect(PANEL_STYLE).toMatchObject({ family: 'Open Sans', fontWeight: '400', fontSize: 65 }); expect(AGENT_STYLE).toMatchObject({ family: 'Roboto', fontWeight: '700', fontSize: 65 });
  });
  for (const state of UNBOUND) for (const drop of [false, true]) it(`${state}: addTextPreset ${drop ? 'drop' : 'panel'} baseline`, () => {
    const { doc, item } = panelTitle(base(state), drop); expectFont(item, ROBOTO_BOLD, false, { style: 'absent' }); centred(item, doc);
    expect(item.details.text).toBe('Heading'); expect(item.trackId).toBe(drop ? 'O2' : 'O1'); expect(item.display).toEqual({ from: drop ? 2500 : 0, to: drop ? 7500 : 5000 });
    expect(['fontSize', 'color', 'textAlign', 'wordWrap', 'borderWidth', 'borderColor'].map(key => v(item, key))).toEqual([150, '#ffffff', 'center', 'break-word', 0, '#000000']);
  });
  it.each(UNBOUND)('%s: agent text has no stored font unless requested', state => {
    const { doc, item } = agentTitle(base(state));
    for (const key of ['fontFamily', 'fontFamilyDisplay', 'fontUrl']) expect(item.details).not.toHaveProperty(key);
    expect(item.details.text).toBe('Agent title'); expect(item.display).toEqual({ from: 0, to: 3000 }); expect(v(item, 'fontSize')).toBe(100); expect(v(item, 'width')).toBe(648); centred(item, doc);
  });
  for (const state of UNBOUND) for (const path of ['agent', 'panel'] as const) it(`${state}: ${path} captions retain today's literal base`, () => {
    const run = captions(base(state), path);
    for (const item of run.items) {
      expectFont(item, path === 'agent' ? ROBOTO_BOLD : OPEN_SANS, true);
      expect(['fontSize', 'color', 'backgroundColor', 'borderWidth', 'borderColor', 'textAlign', 'textTransform'].map(key => v(item, key))).toEqual([65, '#FFFFFF', 'transparent', 3, '#000000', 'center', 'none']);
      expect(v(item, 'boxShadow')).toEqual({ color: '#000000', x: 0, y: 0, blur: 0 }); expect(item.details.renderMode).toBe('default');
    }
  });
});

describe('A4/P4/R9-1: bound titles select only the default font, below explicit font and a look font', () => {
  it.each([false, true])('addTextPreset drop=%s takes Sora 800 and keeps non-font defaults/track/timing/centring', drop => {
    const plain = panelTitle(base(), drop), bound = panelTitle(base('bound'), drop);
    expectFont(bound.item, SORA); centred(bound.item, bound.doc); expect(nonFontLook(bound.item)).toEqual(nonFontLook(plain.item));
    expect(v(bound.item, 'fontSize')).toBe(150); expect(v(bound.item, 'color')).toBe('#ffffff');
  });
  it('the direct addTextIn entry point also uses the bound titles font', () => {
    useIds(); const doc = base('bound'), result = addTextIn(doc, { textContent: 'Direct path', trackId: 'O1' }); expect(result.success).toBe(true); expectFont(itemOf(doc, result.data.itemId), SORA);
  });
  it.each([
    { label: 'no explicit style', args: {}, font: SORA, legacy: false },
    { label: 'explicit Roboto', args: { font: 'Roboto' }, font: ROBOTO, legacy: true },
    { label: 'poster look font', args: { look: { style: 'poster' } }, font: { family: 'Anton', face: 'Anton-Regular', weight: 400 }, legacy: true },
    { label: 'explicit font beats poster look', args: { look: { style: 'poster' }, font: 'Roboto' }, font: ROBOTO, legacy: true },
    { label: 'explicit named face beats poster look', args: { look: { style: 'poster' }, font: 'Roboto-Bold' }, font: ROBOTO_BOLD, legacy: false },
  ])('$label', ({ args, font, legacy }) => {
    const bound = agentTitle(base('bound'), args), plain = agentTitle(base(), args);
    expectFont(bound.item, font, false, legacy ? { weight: 'absent', style: 'absent' } : {}); expect(nonFontLook(bound.item)).toEqual(nonFontLook(plain.item));
    expect(v(bound.item, 'color')).toBe(v(plain.item, 'color')); expect(v(bound.item, 'fontSize')).toBe(100);
  });
});

describe('A4/OQ-1: the four caption precedence cells, bound/unbound × agent/panel', () => {
  const cases: { label: string; args: RecordData; size: number; choice: boolean }[] = [
    { label: 'no style args', args: {}, size: 65, choice: false },
    { label: 'size only, no font', args: { fontSize: 120 }, size: 120, choice: false },
    { label: 'explicit caption template', args: { templateId: 'cinema' }, size: 65, choice: true },
    { label: 'explicit font over explicit template', args: { templateId: 'cinema', font: 'Roboto-Bold' }, size: 65, choice: true },
  ];
  for (const path of ['agent', 'panel'] as const) for (const bound of [false, true]) for (const cell of cases) it(`${path}, bound=${bound}, ${cell.label}`, () => {
    const run = captions(base(bound ? 'bound' : 'absent'), path, cell.args);
    const expected = cell.args.font ? ROBOTO_BOLD : cell.args.templateId ? { family: 'Cormorant', face: 'Cormorant-Bold', weight: 700 } : bound ? MANROPE : path === 'agent' ? ROBOTO_BOLD : OPEN_SANS;
    for (const item of run.items) { expectFont(item, expected, true); expect(v(item, 'fontSize')).toBe(cell.size); }
    if (cell.choice && bound) expect(run.items).toEqual(captions(base(), path, cell.args).items);
    if (!cell.choice) {
      const plain = captions(base(), path, cell.args); expect(run.items.map(nonFontLook)).toEqual(plain.items.map(nonFontLook));
      for (const item of run.items) expect(v(item, 'color')).toBe('#FFFFFF');
    }
  });
  it('the direct addCaptionsIn entry point gets Manrope 700 too', () => {
    const doc = base('bound'), result = addCaptionsIn(doc, { trackId: 'C1' }, provider); expect(result.success).toBe(true);
    for (const item of doc.items.filter(item => item.type === 'caption')) expectFont(item, MANROPE, true);
  });
});

describe('P4 limits / R9-2 / R9-3: no palette/accent application or retroactive changes; unknown defaults are silent fallbacks', () => {
  it('accent and palette do not recolour new titles or captions', () => {
    const doc = base('bound'); (doc.templateDefaults as RecordData).accentFont = 'InstrumentSerif-Regular'; (doc.templateDefaults as RecordData).palette = [{ name: 'Never auto-apply', hex: '#01AB23' }];
    expect(v(panelTitle(doc).item, 'color')).toBe('#ffffff'); expect(v(agentTitle(doc).item, 'color')).toBe(v(agentTitle(base()).item, 'color'));
    for (const path of ['agent', 'panel'] as const) expect(captions(doc, path).items.map(item => v(item, 'color'))).toEqual(captions(base(), path).items.map(item => v(item, 'color')));
  });
  it('writing a binding after existing unbound text/captions changes none of those items', () => {
    const doc = captions(base(), 'agent').doc; addTextPreset(doc); const before = structuredClone(doc.items);
    expect(writeDefaults(doc, DEFAULT_TEMPLATE, 1).items).toEqual(before); expect(doc.items).toEqual(before);
  });
  it.each(['panel', 'drop', 'agent'])('unknown titlesFont: %s is exactly the old unbound item and emits no notice', path => {
    const plain = path === 'agent' ? agentTitle(base()).item : panelTitle(base(), path === 'drop').item;
    const fallback = path === 'agent' ? agentTitle(base('bad-title')).item : panelTitle(base('bad-title'), path === 'drop').item;
    expect(fallback).toEqual(plain); expect(notifySpy).not.toHaveBeenCalled();
  });
  it.each(['agent', 'panel'] as const)('unknown captionsFont: %s is exactly the old unbound captions and emits no notice', path => {
    const plain = captions(base(), path), fallback = captions(base('bad-caption'), path);
    expect(fallback.items).toEqual(plain.items); expect(fallback.result.warning).toBeUndefined(); expect(notifySpy).not.toHaveBeenCalled();
  });
  it.each(['agent', 'panel'] as const)('stored karaoke-pop project template does not choose that caption look: %s', async path => {
    const store = setup(), changed = await updateTemplate(store, DEFAULT_TEMPLATE.id, t => ({ ...t, captionTemplateId: 'karaoke-pop' }), NOW);
    expect((await findTemplate(store, DEFAULT_TEMPLATE.id))!.captionTemplateId).toBe('karaoke-pop');
    const doc = writeDefaults(base(), changed, 1); expect(doc.templateDefaults).not.toHaveProperty('captionTemplateId');
    const run = captions(doc, path); expect(run.items).toEqual(captions(base('bound'), path).items);
    for (const item of run.items) { expectFont(item, MANROPE, true); expect(item.details.renderMode).toBe('default'); expect(v(item, 'fontSize')).toBe(65); expect(v(item, 'textTransform')).toBe('none'); }
  });
});

describe('defaultFont/projectDefaults: bound keys and unbound project extraction', () => {
  it('defaultFont reads valid title/caption names, with absent/undefined/empty keys unbound', () => {
    expect(defaultFont(base('bound'), 'titlesFont')).toBe('Sora-ExtraBold'); expect(defaultFont(base('bound'), 'captionsFont')).toBe('Manrope-Bold');
    for (const state of UNBOUND) for (const key of ['titlesFont', 'captionsFont'] as const) expect(defaultFont(base(state), key)).toBeUndefined();
  });
  it('bound projectDefaults keeps the three font values and copies the palette array', () => {
    const doc = base('bound'), result = projectDefaults(doc), key = doc.templateDefaults as RecordData;
    expect(result).toEqual({ defaults: { captionsFont: 'Manrope-Bold', titlesFont: 'Sora-ExtraBold', accentFont: 'InstrumentSerif-Regular' }, palette: DEFAULT_TEMPLATE.palette });
    expect(result.palette).not.toBe(key.palette);
  });
  it.each(UNBOUND)('empty %s project has the three literal fallbacks and empty palette', state => {
    const doc = emptyDocument(); if (state === 'undefined') doc.templateDefaults = undefined; if (state === 'empty') doc.templateDefaults = {};
    expect(projectDefaults(doc)).toEqual({ defaults: { captionsFont: 'Open Sans', titlesFont: 'Roboto', accentFont: 'Roboto' }, palette: [] });
  });
  it('clear font-count winners, static fontSize not box area, next distinct font, and no stored face means not counted (C-15)', () => {
    const text = (id: string, font: string | undefined, size: number | string, width = 100) => mkItem(id, 'O1', 0, 1000, { type: 'text', details: { ...(font ? { fontFamily: font } : {}), fontFamilyDisplay: font ?? 'Instrument Serif' }, properties: props({ fontSize: size, width, height: width, color: 'none' }) });
    const caption = (id: string, font?: string) => mkItem(id, 'C1', 0, 1000, { type: 'caption', details: { ...(font ? { fontFamily: font } : {}), fontFamilyDisplay: font ?? 'Sora' }, properties: props({ fontSize: 1000, color: '#00FF00' }) });
    const doc = build({ items: [text('largest-size', 'Roboto-Bold', '160'), text('largest-area-same-font', 'Roboto-Bold', 150, 900), text('second-distinct', 'Sora-ExtraBold', 100), text('no-stored-font', undefined, 1000),
      caption('cap-other', 'Roboto-Bold'), caption('cap-win-one', 'Manrope-Bold'), caption('cap-win-two', 'Manrope-Bold'), caption('cap-no-stored-font')] });
    expect(projectDefaults(doc).defaults).toEqual({ captionsFont: 'Manrope-Bold', titlesFont: 'Roboto-Bold', accentFont: 'Sora-ExtraBold' });
  });
  it('item-type pools are literal text/caption pools, not the timeline subType compatibility helper (C-15)', () => {
    const doc = build({ items: [mkItem('text', 'O1', 0, 1000, { type: 'text', details: { fontFamily: 'Roboto-Bold', subType: 'caption' }, properties: props({ fontSize: 200 }) }),
      mkItem('caption', 'C1', 0, 1000, { type: 'caption', details: { fontFamily: 'Manrope-Bold' }, properties: props({ fontSize: 1000 }) })] });
    expect(projectDefaults(doc).defaults).toEqual({ captionsFont: 'Manrope-Bold', titlesFont: 'Roboto-Bold', accentFont: 'Roboto-Bold' });
  });
  it('palette normalisation/cap and reading C-15: ties in first-use order', () => {
    const text = (id: string, color: string) => mkItem(id, 'O1', 0, 1000, { type: 'text', details: { fontFamily: 'Roboto' }, properties: props({ color, fontSize: 50 }) });
    const shape = (id: string, fillColor: string) => mkItem(id, 'O2', 0, 1000, { type: 'shape', properties: props({ fillColor }) });
    const doc = build({ items: [mkItem('not-text-palette', 'C1', 0, 1000, { type: 'caption', properties: props({ color: '#FF00FF' }) }),
      text('first', '#aBc'), text('early-single', '#def'), shape('third', '#ABCDEF'), text('first-again', '#aabbcc'), shape('third-again', '#abcdef'),
      text('single-two', '#222222'), shape('single-three', '#333333'), shape('single-four', '#444444'), shape('excluded-five', '#555555'), shape('excluded-six', '#666666'),
      text('none', 'none'), shape('named-colour', 'red'), text('gradient', 'linear-gradient(red, blue)')] });
    expect(PROJECT_PALETTE_MAX).toBe(6);
    expect(projectDefaults(doc).palette).toEqual(['#AABBCC', '#ABCDEF', '#DDEEFF', '#222222', '#333333', '#444444'].map((hex, k) => ({ name: `Colour ${k + 1}`, hex })));
  });
});

describe('Q1/A18: templateFromProject and a real-store bind/save/bind flow', () => {
  it('constructor metadata, chosen asset kinds, and distinct family refs are explicit; no base implies no caption/preset inheritance', () => {
    const doc = base('bound'), chosen = [assets()[0], assets()[2], assets()[3]], guidance = '  Keep this guidance exactly.  ';
    const t = templateFromProject(doc, { name: '  Saved project \n', guidance, assets: chosen }, NOW);
    expect(templateProblem(t)).toBeNull(); expect(t.id).toMatch(/^my-[a-z0-9-]+$/);
    expect(t).toMatchObject({ name: 'Saved project', family: 'Personal', author: TEMPLATE_AUTHOR, guidance, learning: true, preferences: '', version: 1, savedAt: NOW.toISOString() });
    expect(t.assets.audio).toEqual([{ name: chosen[2].name, ref: 'asset:asset-aud1' }]); expect(t.assets.images).toEqual([{ name: chosen[1].name, ref: 'asset:asset-img1' }]); expect(t.examples).toEqual([{ name: chosen[0].name, ref: 'asset:asset-vid1' }]);
    expect(t.assets.fonts).toHaveLength(3); expect(t.assets.fonts).toEqual(expect.arrayContaining([{ name: 'Manrope', ref: 'font:Manrope' }, { name: 'Sora', ref: 'font:Sora' }, { name: 'Instrument Serif', ref: 'font:Instrument Serif' }]));
    expect(t).not.toHaveProperty('captionTemplateId'); expect(t.presetIds).toEqual([]);
  });
  it('base carries only its requested caption/preset ids; duplicate default faces collapse to one ref per family', () => {
    const doc = base('bound'); Object.assign(doc.templateDefaults as RecordData, { titlesFont: 'Manrope-Bold', captionsFont: 'Manrope-Bold', accentFont: 'Roboto' });
    const baseTemplate = { ...DEFAULT_TEMPLATE, captionTemplateId: 'karaoke-pop', presetIds: ['misc/progress-ring'], learning: false, preferences: 'Not inherited' };
    const t = templateFromProject(doc, { name: 'With base', guidance: 'Own guidance', assets: [], base: baseTemplate }, NOW);
    expect(templateProblem(t)).toBeNull(); expect(t).toMatchObject({ captionTemplateId: 'karaoke-pop', presetIds: ['misc/progress-ring'], learning: true, preferences: '' });
    expect(t.assets.fonts).toHaveLength(2); expect(t.assets.fonts).toEqual(expect.arrayContaining([{ name: 'Manrope', ref: 'font:Manrope' }, { name: 'Roboto', ref: 'font:Roboto' }]));
  });
  it('different now values make distinct valid ids', () => {
    const choices = { name: 'Repeated name', guidance: '', assets: [] as Asset[] }, a = templateFromProject(emptyDocument(), choices, NOW), b = templateFromProject(emptyDocument(), choices, new Date(NOW.getTime() + 1000));
    expect(a.id).not.toBe(b.id); expect(templateProblem(a)).toBeNull(); expect(templateProblem(b)).toBeNull();
  });
  it('A bound to Daylight -> preferences edit -> save -> B bind reproduces fonts/palette and new title/caption fonts', async () => {
    const store = setup(), a = await store.create('Project A', base()), bindA = await bindTemplate(store, a.id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'a' });
    let docA = writeDefaults((await store.read(a.id))!.document, DEFAULT_TEMPLATE, bindA.epoch); await store.save(a.id, docA, docA.rev);
    const personal = await updateTemplate(store, DEFAULT_TEMPLATE.id, t => ({ ...t, defaults: { ...t.defaults, titlesFont: 'Roboto-Bold' }, palette: [{ name: 'Personal violet', hex: '#663399' }, { name: 'Personal lime', hex: '#99CC33' }] }), NOW);
    docA = writeDefaults((await store.read(a.id))!.document, personal, bindA.epoch); await store.save(a.id, docA, docA.rev); docA = (await store.read(a.id))!.document;
    const saved = templateFromProject(docA, { name: 'From A', guidance: 'Same defaults', assets: [], base: personal }, NOW); await saveTemplate(store, saved);
    const b = await store.create('Project B', base()), bindB = await bindTemplate(store, b.id, { templateId: saved.id, expectedEpoch: 0, requestKey: 'b' });
    let docB = writeDefaults((await store.read(b.id))!.document, (await findTemplate(store, saved.id))!, bindB.epoch); await store.save(b.id, docB, docB.rev); docB = (await store.read(b.id))!.document;
    const key = (doc: ProjectDocument) => { const copy = structuredClone(doc.templateDefaults) as RecordData; delete copy.templateId; delete copy.epoch; return copy; };
    expect(key(docB)).toEqual(key(docA));
    const titleA = panelTitle(docA).item, titleB = panelTitle(docB).item; expectFont(titleA, ROBOTO_BOLD); expect(fontDigest(titleB)).toEqual(fontDigest(titleA));
    const captionsA = captions(docA, 'agent').items, captionsB = captions(docB, 'agent').items; expect(captionsB.map(fontDigest)).toEqual(captionsA.map(fontDigest));
    for (const item of captionsB) expectFont(item, MANROPE, true);
  });
});
