// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 7 / GFX-10: own saved presets, persistence, replay, transfer and missing-content/loss notices.
// Oracle: the pinned step-7 contract, §31 normalisation, and T08's existing MG placement for a different canvas.
// Save/replay expectations below come from the original input record; no saved/apply output supplies its own expected value.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { MediaStore } from '../apps/web/src/store/media';
import type { RecordData } from '../apps/web/src/store/model';
import { savable, notKept, savedGraphic, savedDirect, loadStylePresets, storePresets, userStylePresets, exportPresets, importPresets, missingFor } from '../apps/web/src/presets/user';
import { applyStylePreset } from '../apps/web/src/presets/apply';
import { customiseMessage } from '../apps/web/src/presets/model';
import { applyGraphicPreset, loadGraphicPresets, placeGraphicPreset, userGraphicPresets } from '../apps/web/src/mg/presets';
import type { GraphicPreset } from '../apps/web/src/mg/presets';
import { prop as getProp, staticValue } from '../apps/web/src/timeline/properties';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

// Observe only the real runtime's notify boundary; preserve every other ui.tsx export (T13's existing unit-test pattern).
const notifySpy = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/ui', async original => ({ ...await original<typeof import('../apps/web/src/ui')>(), notify: notifySpy }));
beforeEach(() => { useIds(); notifySpy.mockClear(); });
const opened: ProjectStore[] = [];
afterEach(async () => { resetIds(); for (const store of opened.splice(0)) await store.close(); });
const CANVAS = { width: 1920, height: 1080 }, NOW = new Date('2026-11-11T03:00:00.000Z');
const p = (defaultValue: unknown, keyframes: unknown[] = []) => ({ defaultValue, keyframes });
const props = (values: RecordData) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, p(value)]));
const CODE = 'export const SavedCard = () => <AbsoluteFill><div>{editable("title", "Default")}</div></AbsoluteFill>;';
function text(): RecordData {
  return mkItem('text', 'O1', 1250, 4750, { type: 'text', details: { text: 'Keep this wording', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' },
    properties: { ...props({ positionX: 133.33, positionY: 271.11, width: 640, height: 180, fontSize: 58.5, fontWeight: 700, color: '#12AB34', textAlign: 'left', letterSpacing: '0.1em', scale: 1, rotation: 0 }),
      positionX: p(133.33, [{ id: 'x0', time: 0, value: 133.33, easing: 'linear' }, { id: 'x1', time: 1250, value: 233.78, easing: 'easeOutCubic' }]),
      opacity: p(0.8, [{ id: 'o0', time: 0, value: 0.2, easing: 'linear' }, { id: 'o1', time: 1875, value: 0.8, easing: 'easeInOutCubic' }]) } });
}
function shape(): RecordData {
  return mkItem('shape', 'O2', 2250, 5250, { type: 'shape', metadata: { shapeType: 'rectangle' },
    details: { closed: true, width: 300.5, height: 160.25, points: [
      { anchor: { x: 0, y: 0 }, handleIn: { x: 0, y: 20 } }, { anchor: { x: 300.5, y: 0 }, handleOut: { x: -30, y: 0 } },
      { anchor: { x: 300.5, y: 160.25 } }, { anchor: { x: 0, y: 160.25 } },
    ] }, properties: props({ positionX: 88.75, positionY: 412.5, width: 300.5, height: 160.25, fillColor: '#ABCDEF', fillOpacity: 0.6,
      strokeColor: '#112233', strokeWidth: 2, scale: 1, opacity: 0.8, rotation: 0 }) });
}
function graphic(): RecordData {
  return mkItem('graphic', 'O3', 1250, 6250, { type: 'motionGraphic', trim: { from: 0, to: 5000 }, sourceDuration: 5000,
    details: { code: CODE, fieldValues: { title: 'Saved wording', accent: '#123456', amount: 37 } },
    properties: props({ positionX: 83.25, positionY: 157.75, width: 345.67, height: 219.23, scale: 1, opacity: 1 }) });
}
const target = (canvas = CANVAS) => build({ extra: { size: canvas } });
function setup() {
  const bytes = new Map<string, Blob>(), media: MediaStore = { write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!), remove: vi.fn(async () => {}) };
  const store = new ProjectStore(crypto.randomUUID(), () => NOW.getTime(), media); opened.push(store); return store;
}
const within = (got: number, expected: number) => expect(Math.abs(got - expected)).toBeLessThanOrEqual(0.01);
function expectBox(item: RecordData, original: RecordData) {
  for (const key of ['positionX', 'positionY', 'width', 'height']) within(Number(staticValue(item, key)), original.properties[key].defaultValue);
}
function expectText(item: RecordData, original: RecordData) {
  expect(item.type).toBe('text'); expect(item.details.text).toBe(original.details.text); expect(item.details.fontFamilyDisplay).toBe(original.details.fontFamilyDisplay);
  expectBox(item, original);
  for (const key of ['fontSize', 'fontWeight', 'color', 'textAlign', 'letterSpacing']) expect(staticValue(item, key)).toEqual(original.properties[key].defaultValue);
  for (const key of ['positionX', 'opacity']) {
    const got = getProp(item, key)!.keyframes, expected = original.properties[key].keyframes;
    expect(got.map(k => [k.time, k.easing])).toEqual(expected.map((k: RecordData) => [k.time, k.easing]));
    got.forEach((k, i) => within(Number(k.value), expected[i].value));
  }
  expect(item.display.to - item.display.from).toBe(original.display.to - original.display.from);
}
// The graphic() box (83.25, 157.75, 345.67, 219.23 on 1920×1080) on the 1080×1920 reference canvas, worked by hand:
//   x = 83.25 / 1920 × 1080 = 46.828125, y = 157.75 / 1080 × 1920 = 2524/9 = 280.4444444444…,
//   width = 345.67 / 1920 × 1080 = 194.439375, height = 219.23 / 1080 × 1920 = 3507.68/9 = 389.7422222222….
const PORTRAIT_BOX = { x: 46.828125, y: 280.4444444444, width: 194.439375, height: 389.7422222222 };
/** A box with exactly x / y / width / height, each within 1e-9 of the literal (float rounding and the ten printed decimals only). */
function closeBox(got: RecordData | undefined, expected: { x: number; y: number; width: number; height: number }) {
  expect(Object.keys(got ?? {}).sort()).toEqual(['height', 'width', 'x', 'y']);
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(Number(got![key]) - expected[key]), key).toBeLessThanOrEqual(1e-9);
}
function expectPoints(actual: RecordData[], original: RecordData[]) {
  expect(actual).toHaveLength(original.length);
  actual.forEach((point, k) => {
    for (const field of ['anchor', 'handleIn', 'handleOut']) {
      if (!original[k][field]) expect(point[field]).toBeUndefined();
      else { expect(point[field]).toBeDefined(); within(point[field].x, original[k][field].x); within(point[field].y, original[k][field].y); }
    }
  });
}

describe('savable: single graphic or one/many text+shape items only', () => {
  const cases: { label: string; items: RecordData[]; expected: 'graphic' | 'direct' | null }[] = [
    { label: 'one text', items: [text()], expected: 'direct' }, { label: 'one shape', items: [shape()], expected: 'direct' },
    { label: 'text+shape', items: [text(), shape()], expected: 'direct' }, { label: 'two texts', items: [text(), text()], expected: 'direct' },
    { label: 'two shapes', items: [shape(), shape()], expected: 'direct' }, { label: 'one coded graphic', items: [graphic()], expected: 'graphic' },
    { label: 'two graphics', items: [graphic(), graphic()], expected: null }, { label: 'graphic+text', items: [graphic(), text()], expected: null },
    { label: 'text+video', items: [text(), mkItem('v', 'V1', 0, 1000)], expected: null }, { label: 'empty list', items: [], expected: null },
    ...['video', 'image', 'audio', 'caption', 'layout'].map(type => ({ label: type, items: [mkItem(type, 'T', 0, 1000, { type })], expected: null })),
    ...[undefined, '', '   '].map(code => ({ label: `blank graphic ${JSON.stringify(code)}`, items: [{ ...graphic(), details: { code } }], expected: null })),
  ];
  it.each(cases)('$label -> $expected', ({ items, expected }) => expect(savable(items)).toBe(expected));
});

describe('GFX-10: save/list/apply direct items on the same canvas', () => {
  it('text keeps text/family/box/font size/colour/keyframes/timing and is normalised in the saved record', async () => {
    const original = text(), before = JSON.stringify(original), preset = savedDirect([original], CANVAS, 'My Saved Title', NOW);
    expect(preset).toMatchObject({ id: expect.stringMatching(/^text\/[^/]+-.+/), name: 'My Saved Title', canvas_size: CANVAS, version: 1, savedAt: NOW.toISOString() });
    expect(preset.items[0]).toMatchObject({ relativeStart: 0, duration: 3500, details: { left: 133.33 / 1920, top: 271.11 / 1080, width: 640 / 1920, height: 180 / 1080, fontSize: 58.5 / 1920, fontFamily: 'Roboto' } });
    const store = setup(); await storePresets(store, [preset]); const listed = await userStylePresets(store);
    expect(listed).toEqual({ presets: [preset], skipped: [] });
    const applied = applyStylePreset(target(), listed.presets[0], 0); expect(applied).toHaveLength(1); expectText(applied[0], original);
    expect(JSON.stringify(original)).toBe(before);
  });
  it('shape carries normalised path points/handles and restores its box and paint within .01', async () => {
    const original = shape(), preset = savedDirect([original], CANVAS, 'My Saved Shape', NOW);
    expect(preset.id).toMatch(/^misc\/[^/]+-.+/); expect(preset.items[0].details.closed).toBe(true);
    const fractions = preset.items[0].details.points as RecordData[];
    fractions.forEach((point, k) => { for (const key of ['anchor', 'handleIn', 'handleOut']) if (original.details.points[k][key]) {
      expect(Math.abs(point[key].x - original.details.points[k][key].x / 300.5)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(point[key].y - original.details.points[k][key].y / 160.25)).toBeLessThanOrEqual(1e-12);
    } });
    const store = setup(); await storePresets(store, [preset]); const listed = await userStylePresets(store);
    const [item] = applyStylePreset(target(), listed.presets[0]); expect(item.type).toBe('shape'); expectBox(item, original);
    expectPoints(item.details.points, original.details.points); expect(item.details.closed).toBe(true);
    for (const key of ['fillColor', 'fillOpacity', 'strokeColor', 'strokeWidth']) expect(staticValue(item, key)).toEqual(original.properties[key].defaultValue);
  });
  it('two saved items retain their 1000 ms offset and display lengths', async () => {
    const originals = [text(), shape()], preset = savedDirect(originals, CANVAS, 'Two items', NOW);
    expect(preset.items.map(item => [item.relativeStart, item.duration])).toEqual([[0, 3500], [1000, 3000]]);
    const store = setup(); await storePresets(store, [preset]); const listed = await userStylePresets(store);
    const items = applyStylePreset(target(), listed.presets[0], 5000);
    expect(items.map(item => item.display)).toEqual([{ from: 5000, to: 8500 }, { from: 6000, to: 9000 }]); expectText(items[0], originals[0]); expectPoints(items[1].details.points, originals[1].details.points);
  });
});

describe('GFX-10: saved graphics, exact same-canvas box and T08 fallback placement', () => {
  it('save -> T08 list -> same canvas restores the exact box/code/field values/length', async () => {
    const original = graphic(), preset = savedGraphic(original, CANVAS, 'Saved graphic', NOW), store = setup();
    expect(preset).toMatchObject({ id: expect.stringMatching(/^my\//), name: 'Saved graphic', mg_code: CODE, mg_code_h: CODE, duration_ms: 5000,
      field_values: original.details.fieldValues, saved: { canvas: CANVAS, box: { x: 83.25, y: 157.75, width: 345.67, height: 219.23 } }, version: 1, savedAt: NOW.toISOString() });
    // §31 reference boxes of the fixture box: on 1920×1080 it is the box itself; on 1080×1920 each axis is box / canvas × reference.
    closeBox(preset.spatial_h, { x: 83.25, y: 157.75, width: 345.67, height: 219.23 }); closeBox(preset.spatial, PORTRAIT_BOX);
    await storePresets(store, [preset]); const listed = await userGraphicPresets(store); expect(listed).toEqual({ presets: [preset], skipped: [] });
    const [item] = applyStylePreset(target(), listed.presets[0], 2000);
    for (const key of ['positionX', 'positionY', 'width', 'height']) expect(staticValue(item, key)).toBe(original.properties[key].defaultValue);
    expect(item.details.code).toBe(CODE); expect(item.details.fieldValues).toEqual(original.details.fieldValues); expect(item.display).toEqual({ from: 2000, to: 7000 });
    expect(loadGraphicPresets([preset])).toEqual({ presets: [preset], skipped: [] });
  });
  // §31 placement of PORTRAIT_BOX (not full frame, not within 10 px of the 1920 bottom: uniform fit, centred), worked by hand:
  //   1080×1920: s = min(1080/1080, 1920/1920) = 1, no offset, so the box is PORTRAIT_BOX.
  //   1080×1080: s = min(1080/1080, 1080/1920) = 0.5625, ox = (1080 − 1080 × 0.5625) / 2 = 236.25, oy = (1080 − 1920 × 0.5625) / 2 = 0;
  //     x = 46.828125 × 0.5625 + 236.25 = 262.5908203125, y = 2524/9 × 0.5625 = 157.75,
  //     width = 194.439375 × 0.5625 = 109.3721484375, height = 3507.68/9 × 0.5625 = 219.23.
  it.each([
    { canvas: { width: 1080, height: 1920 }, box: PORTRAIT_BOX },
    { canvas: { width: 1080, height: 1080 }, box: { x: 262.5908203125, y: 157.75, width: 109.3721484375, height: 219.23 } },
  ])('other canvas $canvas places the saved graphic by §31 at the worked box', ({ canvas, box }) => {
    const preset = savedGraphic(graphic(), CANVAS, 'Saved graphic', NOW), [item] = applyStylePreset(target(canvas), preset);
    closeBox({ x: staticValue(item, 'positionX'), y: staticValue(item, 'positionY'), width: staticValue(item, 'width'), height: staticValue(item, 'height') }, box);
    expect(item.details.fieldValues).toEqual(graphic().details.fieldValues);
  });
  it('legacy T08 and imported rows without saved/field_values still use spatial placement', () => {
    const legacy = { id: 'my/legacy', name: 'Legacy', mg_code: CODE, duration_ms: 4200, spatial: { x: 101, y: 201, width: 301, height: 401 } };
    const imported = importPresets({ format: 'cutframe-presets', version: 1, presets: [legacy] }); expect(imported).toEqual({ presets: [legacy], skipped: [] });
    for (const preset of [loadGraphicPresets([legacy]).presets[0], imported.presets[0]]) {
      const canvas = { width: 1080, height: 1920 }, expected = placeGraphicPreset(legacy, canvas).box, [item] = applyStylePreset(target(canvas), preset);
      expect([staticValue(item, 'positionX'), staticValue(item, 'positionY'), staticValue(item, 'width'), staticValue(item, 'height')]).toEqual([expected.x, expected.y, expected.width, expected.height]);
      expect(item.display.to - item.display.from).toBe(4200); expect(item.details.code).toBe(CODE);
    }
  });
});

describe('legacy graphic runtime intents preserve T08 output, user undo/journal and missing-only notices', () => {
  const plain: GraphicPreset = { id: 'legacy/plain', name: 'Plain graphic', mg_code: 'export const Portrait = () => null;',
    spatial: { x: 101, y: 201, width: 301, height: 401 }, duration_ms: 4000 };
  const fixtures = [
    { label: 'portrait with spatial', canvas: { width: 540, height: 960 }, preset: plain },
    { label: 'portrait without spatial', canvas: { width: 540, height: 960 }, preset: { id: 'legacy/full', name: 'Full frame', mg_code: plain.mg_code, duration_ms: 4000 } },
    { label: 'landscape code and spatial_h', canvas: { width: 1920, height: 1080 }, preset: { ...plain, id: 'legacy/landscape',
      mg_code_h: 'export const Landscape = () => null;', spatial_h: { x: 103, y: 203, width: 303, height: 403 } } },
  ];
  const world = (canvas: { width: number; height: number }) => build({
    tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('C1', 'caption')],
    items: [video('v1', 'V1', 0, 8000), mkItem('t1', 'O1', 1000, 3000, { type: 'text', details: { text: 'Keep' } })], extra: { size: canvas },
  });
  // Ignore only these two generated ids at the item root, not metadata, effects, properties or any other record field.
  const withoutGeneratedIds = (item: RecordData) => { const copy = structuredClone(item); delete copy.id; delete copy.trackId; return copy; };
  for (const type of ['addGraphicPreset', 'applyStylePreset'] as const) for (const fixture of fixtures) it(`${type}: ${fixture.label}`, () => {
    for (const key of ['field_values', 'saved', 'version', 'savedAt']) expect(fixture.preset).not.toHaveProperty(key);
    const initial = world(fixture.canvas), expectedDoc = structuredClone(initial);
    // This is the explicitly requested T08 integration oracle, independent of the new runtime/shared applyStylePreset path.
    const expected = applyGraphicPreset(expectedDoc, fixture.preset), editor = createEditor(initial, { assets: assets(), links: links() });
    expect(editor.intent({ type, preset: fixture.preset })).toEqual({ ok: true });
    const items = editor.doc.items.filter(item => item.type === 'motionGraphic'); expect(items).toHaveLength(1);
    expect(withoutGeneratedIds(items[0])).toEqual(withoutGeneratedIds(expected));
    expect(editor.doc.items.filter(item => item.type !== 'motionGraphic')).toEqual(initial.items);
    expect(editor.bus.undoStack).toHaveLength(1); expect(editor.bus.undoStack[0]).toMatchObject({ label: 'Add items', source: 'user' });
    expect(editor.journal).toEqual([{ label: 'Add items', source: 'user', items_before: 2, items_after: 3 }]);
    expect(notifySpy).not.toHaveBeenCalled();
    editor.bus.undo(); expect(editor.doc).toEqual(initial);
  });
  it.each(['addGraphicPreset', 'applyStylePreset'] as const)('%s: positive control reports one missing asset notice, even across both code variants', type => {
    const code = "export const NeedsAsset = () => <Img src={getAssetUrl('video_9')} />;";
    const preset: GraphicPreset = { ...plain, mg_code: code, mg_code_h: code }, editor = createEditor(world({ width: 1920, height: 1080 }), { assets: assets(), links: links() });
    expect(editor.intent({ type, preset })).toEqual({ ok: true }); expect(editor.doc.items.filter(item => item.type === 'motionGraphic')).toHaveLength(1);
    expect(editor.bus.undoStack).toHaveLength(1); expect(editor.bus.undoStack[0]).toMatchObject({ label: 'Add items', source: 'user' });
    expect(editor.journal).toEqual([{ label: 'Add items', source: 'user', items_before: 2, items_after: 3 }]);
    expect(notifySpy).toHaveBeenCalledExactlyOnceWith('The asset "video_9" is not in this project. Attach it, then check the motion graphic.');
  });
});

describe('versioned settings rows and import/export', () => {
  it('same id replaces in the correct row, without dropping unrelated presets', async () => {
    const store = setup(), a = savedDirect([text()], CANVAS, 'First', NOW), b = savedDirect([shape()], CANVAS, 'Second', NOW), g = savedGraphic(graphic(), CANVAS, 'Graphic', NOW), g2 = savedGraphic(graphic(), CANVAS, 'Other graphic', NOW);
    await storePresets(store, [a, b, g, g2]); await storePresets(store, [{ ...a, name: 'Replacement' }, { ...g, name: 'Graphic replacement' }]);
    const row = await store.row<{ id: string; presets: RecordData[] }>('settings', 'style-presets');
    expect(row?.presets).toHaveLength(2); expect(row?.presets.find(preset => preset.id === a.id)?.name).toBe('Replacement'); expect(row?.presets).toContainEqual(b);
    const graphics = (await userGraphicPresets(store)).presets;
    expect(graphics).toHaveLength(2); expect(graphics).toContainEqual({ ...g, name: 'Graphic replacement' }); expect(graphics).toContainEqual(g2);
    expect((await store.row<{ presets: unknown[] }>('settings', 'mg-presets'))?.presets).toEqual(graphics);
  });
  it('both kinds have version/time and survive export -> JSON -> import unchanged', () => {
    const presets = [savedDirect([text()], CANVAS, 'Title', NOW), savedGraphic(graphic(), CANVAS, 'Graphic', NOW)];
    for (const preset of presets) expect(preset).toMatchObject({ version: 1, savedAt: NOW.toISOString() });
    const file = exportPresets(presets); expect(file).toEqual({ format: 'cutframe-presets', version: 1, presets });
    expect(importPresets(JSON.parse(JSON.stringify(file)))).toEqual({ presets, skipped: [] });
  });
  it('invalid records keep their index and their reason in loaders/import, valid records survive', () => {
    const valid = savedDirect([text()], CANVAS, 'Title', NOW), invalid = { id: 'text/bad', name: 'Bad', description: 'Missing content.' };
    // The style row names both missing parts; a file record without items is read as a motion-graphic preset, so its code is what is missing.
    expect(loadStylePresets([valid, invalid])).toEqual({ presets: [valid], skipped: [{ index: 1, reason: 'has neither items nor mg_code' }] });
    expect(importPresets({ format: 'cutframe-presets', version: 1, presets: [valid, invalid] })).toEqual({ presets: [valid], skipped: [{ index: 1, reason: 'mg_code is missing' }] });
  });
  it('a graphic record whose spatial is not a box is skipped with that reason, in the loader and the import', () => {
    const good = savedGraphic(graphic(), CANVAS, 'Graphic', NOW), bad = { ...good, id: 'my/bad-box', spatial: { x: 0, y: 0, width: 0, height: 100 } };
    expect(loadGraphicPresets([bad, good])).toEqual({ presets: [good], skipped: [{ index: 0, reason: 'spatial is not a box' }] });
    expect(importPresets({ format: 'cutframe-presets', version: 1, presets: [bad, good] })).toEqual({ presets: [good], skipped: [{ index: 0, reason: 'spatial is not a box' }] });
  });
  it.each([{ format: 'other-format', version: 1 }, { format: 'cutframe-presets', version: 2 }])('wrong file %j throws INVALID_PRESET_FILE', fields => {
    expect(() => importPresets({ ...fields, presets: [] })).toThrowError(expect.objectContaining({ code: 'INVALID_PRESET_FILE' }));
  });
});

describe('missingFor reports registry/media gaps once, with exact notices', () => {
  it('a repeated missing family is named once', () => {
    const preset = savedDirect([text(), text()], CANVAS, 'Missing font', NOW); preset.items.forEach(item => { item.details.fontFamily = 'No Such Font'; });
    expect(missingFor(preset, [])).toEqual(['The font "No Such Font" is not available here. The default font is used.']);
  });
  it.each(['Roboto', 'Manrope'])('registry family %s produces no missing-font notice', family => {
    const preset = savedDirect([text()], CANVAS, 'Known font', NOW); preset.items[0].details.fontFamily = family; expect(missingFor(preset, [])).toEqual([]);
  });
  it('literal asset ids from both code variants are de-duplicated; attached ids are not missing', () => {
    const preset = savedGraphic(graphic(), CANVAS, 'Missing asset', NOW);
    preset.mg_code = "export const G = () => <Img src={getAssetUrl('video_9')} />;";
    preset.mg_code_h = 'export const G = () => <><Img src={getAssetUrl("video_9")} /><Img src={getAssetUrl("image_2")} /></>;';
    expect(missingFor(preset, ['image_2'])).toEqual(['The asset "video_9" is not in this project. Attach it, then check the motion graphic.']);
    expect(missingFor(preset, ['video_9', 'image_2'])).toEqual([]);
  });
});

describe('notKept names unsupported saved parts; customiseMessage trims only the custom text', () => {
  it('plain text has no loss notice; disabled-only effects are not reported', () => {
    expect(notKept([text()])).toEqual([]); const item = text(); item.effects = [{ enabled: false, effectId: 'invert' }]; expect(notKept([item])).toEqual([]);
  });
  it.each(['effects', 'masks', 'path keyframes', 'text look', 'keyframe handles', 'keyframes', 'keyframes without a number value'])('%s is reported', part => {
    let item = text();
    // A colour keyframe has a string value: a saved preset carries number keyframes only.
    if (part === 'keyframes without a number value') item.properties.color = p('#12AB34', [{ id: 'c0', time: 0, value: '#12AB34', easing: 'linear' }, { id: 'c1', time: 1250, value: '#AB1234', easing: 'linear' }]);
    if (part === 'effects') item.effects = [{ effectId: 'invert', enabled: true }];
    if (part === 'masks') item.masks = [{ id: 'mask' }];
    if (part === 'text look') item.details.look = { style: 'mercury' };
    if (part === 'keyframe handles') item.properties.positionX.keyframes[0].outHandle = { x: 0.1, y: 0.2 };
    if (part === 'path keyframes') { item = shape(); item.details.keyframes = { path: { keyframes: [{ id: 'path', time: 0, value: { points: item.details.points, closed: true }, easing: 'linear' }] } }; }
    if (part === 'keyframes') { item = graphic(); item.properties.positionX = p(83.25, [{ id: 'x', time: 0, value: 83.25, easing: 'linear' }]); }
    expect(notKept([item])).toEqual([part]);
    const preset = item.type === 'motionGraphic' ? savedGraphic(item, CANVAS, 'Loss case', NOW) : savedDirect([item], CANVAS, 'Loss case', NOW);
    expect(notKept(applyStylePreset(target(), preset))).toEqual([]);
  });
  it('duplicates are named once', () => { const item = text(); item.effects = [{ effectId: 'invert', enabled: true }]; expect(notKept([item, item])).toEqual(['effects']); });
  it('customise message uses the pinned wording and trimmed text', () => expect(customiseMessage('Side Panel', '  make it red \n')).toBe('Customise the "Side Panel" preset: make it red'));
});
