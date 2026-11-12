// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 5: A16/A19/A20, findings part 2 §31 and the implementer's pinned preset-core contract.
// Cutframe readings: all times are ms; properties contains keyframe lists only; scaled details/keyframes round to .01.
// Independent expectations below use literal §31 formulas and authored data, never scaleDirectPreset/applyStylePreset
// or placeGraphicPreset to obtain an expected value. Non-geometric styles/keyframes are not scaled or rounded.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyStylePreset, scaleDirectPreset } from '../apps/web/src/presets/apply';
import { CATEGORIES, stylePresetProblem } from '../apps/web/src/presets/model';
import type { DirectPreset, GraphicStylePreset, StylePreset } from '../apps/web/src/presets/model';
import { STYLE_PRESETS } from '../apps/web/src/presets/content';
import { GRAPHIC_STYLE_PRESETS } from '../apps/web/src/presets/mg-style';
import { prop, staticValue } from '../apps/web/src/timeline/properties';
import { CommandError } from '../apps/web/src/timeline/model';
import { presetPoints } from '../apps/web/src/timeline/shapes';
import type { ShapeType } from '../apps/web/src/timeline/shapes';
import type { RecordData } from '../apps/web/src/store/model';
import { build, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeEach(() => useIds()); afterEach(() => resetIds());
const CANVASES = [{ width: 1920, height: 1080 }, { width: 1080, height: 1080 }, { width: 1080, height: 1920 }];
const round2 = (n: number) => Math.round(n * 100) / 100;
const FIXTURE: DirectPreset = { id: 'text/independent-fractions', name: 'Independent fractions', description: 'An independently authored scaling fixture.', items: [
  { type: 'text', relativeStart: 137, duration: 2157,
    details: { text: 'Independent text', left: 0.1234567, top: 0.2345678, width: 0.4567891, height: 0.0789123, fontSize: 0.0314159,
      fontFamily: 'Roboto', fontWeight: 700, color: '#123456', textAlign: 'left', letterSpacing: '0.07em', opacity: 0.812345 },
    properties: { positionX: [{ time: 511, value: 0.7654321 }, { time: 0, value: 0.1234567, easing: 'easeOutCubic' }],
      positionY: [{ time: 29, value: 0.3456789 }], width: [{ time: 31, value: 0.5678912 }], height: [{ time: 37, value: 0.1234567 }],
      fontSize: [{ time: 41, value: 0.0412345 }], opacity: [{ time: 43, value: 0.123456 }], rotation: [{ time: 47, value: 1.234567 }] } },
  { type: 'shape', relativeStart: 43, duration: 3431,
    details: { shapeType: 'rectangle', left: 0.212121, top: 0.585858, width: 0.313131, height: 0.121212, fillColor: '#ABCDEF', fillOpacity: 0.612345, roundness: 7.5 },
    properties: { opacity: [{ time: 0, value: 0.25 }, { time: 719, value: 0.75, easing: 'linear' }] } },
] };
const graphic = (extra: RecordData = {}): GraphicStylePreset => ({ id: 'misc/independent-graphic', name: 'Independent graphic', description: 'Independent graphic placement fixture.',
  mg_code: 'export const Portrait = () => null;', mg_code_h: 'export const Landscape = () => null;', duration_ms: 4321,
  spatial: { x: 101, y: 201, width: 301, height: 401 }, spatial_h: { x: 103, y: 203, width: 303, height: 403 }, ...extra });
const clone = <T>(value: T): T => structuredClone(value);
const direct = () => clone(FIXTURE);
const record = (patch: RecordData = {}) => ({ ...direct(), ...patch });
const itemRecord = (patch: RecordData = {}, detailPatch: RecordData = {}) => ({ ...direct(), items: [{ ...clone(FIXTURE.items[0]), ...patch, details: { ...FIXTURE.items[0].details, ...detailPatch } }] });

describe('A16: preset shapes, categories and validation', () => {
  it('the eight category slugs/labels match §31 (Panels is slide-in-panels)', () => {
    expect(CATEGORIES).toEqual([{ slug: 'text', label: 'Text' }, { slug: 'title-cards', label: 'Title Cards' }, { slug: 'lower-thirds', label: 'Lower Thirds' },
      { slug: 'info-cards', label: 'Info Cards' }, { slug: 'slide-in-panels', label: 'Panels' }, { slug: 'misc', label: 'Misc' }, { slug: 'overlays', label: 'Overlays' }, { slug: 'collages', label: 'Collages' }]);
  });
  it('direct text+shape and motion-graphic records are valid, with optional canvas and MG variants', () => {
    for (const value of [direct(), record({ canvas_size: { width: 1920, height: 1080 } }), graphic(),
      { id: 'misc/minimal', name: 'Minimal', description: 'A minimal graphic.', mg_code: 'export const G = () => null;' }]) expect(stylePresetProblem(value)).toBeNull();
  });
  it.each([null, undefined, 42, true, 'preset', []])('non-record %j is invalid', value => expect(stylePresetProblem(value)).not.toBeNull());
  it.each(['', 'no-slash', '/slug', 'text/', 'unknown/slug'])('id %j is invalid', id => expect(stylePresetProblem(record({ id }))).not.toBeNull());
  it.each([{ name: undefined }, { name: '' }, { description: undefined }, { description: '' }])('missing listing field %j is invalid', patch => expect(stylePresetProblem(record(patch))).not.toBeNull());
  it('neither items nor mg_code has the one pinned reason', () => expect(stylePresetProblem({ id: 'text/missing', name: 'Missing', description: 'Missing content.' })).toBe('has neither items nor mg_code'));
  it('empty items is invalid', () => expect(stylePresetProblem(record({ items: [] }))).not.toBeNull());
  it.each(['video', 'image', 'caption', 'layout'])('direct %s is invalid', type => expect(stylePresetProblem(itemRecord({ type }))).not.toBeNull());
  it('negative relativeStart is invalid', () => expect(stylePresetProblem(itemRecord({ relativeStart: -1 }))).not.toBeNull());
  it.each([0, -1, NaN])('duration %s is invalid', duration => expect(stylePresetProblem(itemRecord({ duration }))).not.toBeNull());
  it.each(['left', 'top', 'width', 'height'])('missing %s is invalid', key => {
    const p = direct(); delete p.items[0].details[key]; expect(stylePresetProblem(p)).not.toBeNull();
  });
  it('text without text is invalid', () => { const p = direct(); delete p.items[0].details.text; expect(stylePresetProblem(p)).not.toBeNull(); });
  it.each([0, -1])('text fontSize %s is invalid', fontSize => expect(stylePresetProblem(itemRecord({}, { fontSize }))).not.toBeNull());
  it.each(['rectangle', 'ellipse', 'triangle', 'pentagon', 'star', 'heart'])('shapeType %s is valid', shapeType => {
    const p = direct(); p.items = [{ ...p.items[1], details: { ...p.items[1].details, shapeType } }]; expect(stylePresetProblem(p)).toBeNull();
  });
  it('an unknown shapeType is invalid', () => { const p = direct(); p.items[1].details.shapeType = 'hexagon'; expect(stylePresetProblem(p)).not.toBeNull(); });
  it.each([{ time: NaN, value: 1 }, { time: Infinity, value: 1 }, { time: 0, value: NaN }, { time: 0, value: Infinity }, { time: 0, value: 1, easing: 'unknown-easing' }])(
    'bad keyframe %j is invalid', keyframe => expect(stylePresetProblem(itemRecord({ properties: { opacity: [keyframe] } }))).not.toBeNull());
  it('properties stores keyframe arrays, not a static value', () => expect(stylePresetProblem(itemRecord({ properties: { opacity: 0.5 } }))).not.toBeNull());
  it.each([{ mg_code: '' }, { mg_code_h: '' }, { spatial: { x: 0, y: 0, width: 0, height: 5 } },
    { spatial_h: { x: 0, y: NaN, width: 5, height: 5 } }, { duration_ms: 0 }])('MG record violating T08 %j is invalid', patch => expect(stylePresetProblem(graphic(patch))).not.toBeNull());
});

// The independent §31 oracle. Default authoring area 1080×1920:
// landscape s=9/16, area607.5×1080, offsets656.25/0; square same area, offsets236.25/0; portrait s=1, offsets0/0.
// Fixture text in landscape: left731.25, top253.33, width277.50, height85.23, fontSize19.09.
// Portrait: left133.33, top450.37, width493.33, height151.51, fontSize33.93; square left311.25, fontSize19.09.
function expectedDirect(p: DirectPreset, canvas: { width: number; height: number }, start: number) {
  const src = p.canvas_size ?? { width: 1080, height: 1920 }, s = Math.min(canvas.width / src.width, canvas.height / src.height);
  const effW = src.width * s, effH = src.height * s, offsetX = (canvas.width - effW) / 2, offsetY = (canvas.height - effH) / 2;
  const scaled = (key: string, value: number) => key === 'left' || key === 'positionX' ? round2(value * effW + offsetX)
    : key === 'top' || key === 'positionY' ? round2(value * effH + offsetY)
    : key === 'width' || key === 'fontSize' ? round2(value * effW) : key === 'height' ? round2(value * effH) : value;
  return p.items.map(item => ({ type: item.type, display: { from: start + item.relativeStart, to: start + item.relativeStart + item.duration },
    details: Object.fromEntries(Object.entries(item.details).map(([key, value]) => [key, typeof value === 'number' ? scaled(key, value) : value])),
    properties: Object.fromEntries(Object.entries(item.properties ?? {}).map(([key, list]) => [key, list.map(k => ({ time: k.time, value: scaled(key, k.value), easing: k.easing ?? 'linear' }))])) }));
}
function initial(canvas: { width: number; height: number }) {
  return build({ tracks: [mkTrack('V1', 'video'), mkTrack('O0', 'overlay')], items: [mkItem('keep', 'O0', 0, 9000, { type: 'text', details: { text: 'Keep' } })], extra: { size: canvas } });
}
function assertApplied(p: DirectPreset, canvas: { width: number; height: number }, start: number) {
  const expected = expectedDirect(p, canvas, start), doc = initial(canvas), before = clone(doc), applied = applyStylePreset(doc, p, start);
  expect(applied).toHaveLength(p.items.length); expect(doc.items.slice(0, before.items.length)).toEqual(before.items);
  expect(doc.tracks.slice(0, before.tracks.length)).toEqual(before.tracks); expect(doc.tracks).toHaveLength(before.tracks.length + p.items.length);
  expect(new Set(applied.map(item => item.trackId)).size).toBe(p.items.length);
  const layerIds = doc.layerOrder.map(entry => entry.id), indices = applied.map(item => layerIds.indexOf(item.trackId));
  expect(indices.every(index => index >= 0)).toBe(true);
  indices.slice(1).forEach((index, k) => expect(index).toBeGreaterThan(indices[k]));
  applied.forEach((item, k) => {
    const want = expected[k];
    expect(item).toMatchObject({ type: want.type, display: want.display, details: { source: 'cutframe-preset' }, metadata: { presetId: p.id } });
    expect(doc.tracks.find(track => track.id === item.trackId)?.kind).toBe('overlay'); expect(doc.items).toContain(item);
    for (const [key, value] of Object.entries(want.details)) {
      if (key === 'text') expect(item.details.text).toBe(value);
      else if (key === 'fontFamily') expect(item.details.fontFamilyDisplay).toBe(value);
      else if (key === 'shapeType') expect(item.metadata.shapeType).toBe(value);
      // Implementer clarification: these shape inputs are baked into the T06 path, never stored style properties.
      else if (want.type === 'shape' && (key === 'roundness' || key === 'innerRatio')) continue;
      else expect(staticValue(item, key === 'left' ? 'positionX' : key === 'top' ? 'positionY' : key), `${p.id} item${k} ${key}`).toEqual(value);
    }
    if (want.type === 'shape') {
      // Approved T06 integration oracle; width/height here still come from the independent §31 scaling above.
      expect(item.details.points).toEqual(presetPoints(want.details.shapeType as ShapeType, want.details.width, want.details.height, want.details.roundness ?? 0, want.details.innerRatio ?? 0.4));
      expect(item.details.closed).toBe(true);
    }
    for (const [key, list] of Object.entries(want.properties)) {
      const keyframes = prop(item, key)!.keyframes;
      expect(keyframes.map(({ time, value, easing }) => ({ time, value, easing })), `${p.id} item${k} ${key}`).toEqual(list);
      for (const keyframe of keyframes) expect(keyframe.id).toBeTypeOf('string');
    }
  });
}

describe('A19/A20: independent normalised direct scaling and stored items on three canvases', () => {
  const directPresets = STYLE_PRESETS.filter((p): p is DirectPreset => Array.isArray((p as DirectPreset).items));
  const fixtures = [FIXTURE, { ...clone(FIXTURE), id: 'text/landscape-source', canvas_size: { width: 1920, height: 1080 } }, ...directPresets];
  for (const p of fixtures) for (const canvas of CANVASES) it(`${p.id} → ${canvas.width}×${canvas.height}`, () => {
    const expected = expectedDirect(p, canvas, 2345), before = JSON.stringify(p), actual = scaleDirectPreset(p, canvas, 2345);
    expect(actual).toHaveLength(expected.length);
    actual.forEach((item, k) => {
      expect(item.type).toBe(expected[k].type); expect(item.display).toEqual(expected[k].display); expect(item.details).toEqual(expected[k].details);
      // Missing easing and explicit linear are equivalent here; stored records below must spell the default out.
      const frames = Object.fromEntries(Object.entries(item.properties).map(([key, list]) => [key, list.map(frame => ({ time: frame.time, value: frame.value, easing: frame.easing ?? 'linear' }))]));
      expect(frames).toEqual(expected[k].properties);
    });
    assertApplied(p, canvas, 2345); expect(JSON.stringify(p)).toBe(before);
  });
});

describe('shape geometry inputs are baked into the T06 path, not stored as style', () => {
  it.each([0, 7.5])('rectangle roundness %s has the independently specified plain/handled anchor count', roundness => {
    const p = direct(); p.items = [{ ...p.items[1], details: { ...p.items[1].details, roundness } }];
    const item = applyStylePreset(initial(CANVASES[2]), p, 0)[0], points = item.details.points as { handleIn?: unknown; handleOut?: unknown }[];
    expect(item.metadata.shapeType).toBe('rectangle'); expect(item.details.closed).toBe(true);
    expect(points).toHaveLength(roundness === 0 ? 4 : 8);
    expect(points.some(point => !!point.handleIn || !!point.handleOut)).toBe(roundness > 0);
    expect(item.properties).not.toHaveProperty('roundness');
  });
});

function expectedGraphic(p: GraphicStylePreset, canvas: { width: number; height: number }) {
  const landscape = canvas.width > canvas.height && !!p.mg_code_h, ref = landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  const b = landscape ? p.spatial_h : p.spatial, code = landscape ? p.mg_code_h! : p.mg_code;
  if (!b || b.x === 0 && b.y === 0 && b.width === ref.width && b.height === ref.height) return { code, x: 0, y: 0, width: canvas.width, height: canvas.height };
  if (b.y + b.height >= ref.height - 10) return { code, x: b.x * canvas.width / ref.width, width: b.width * canvas.width / ref.width,
    height: b.height * canvas.height / ref.height, y: canvas.height - b.height * canvas.height / ref.height };
  const s = Math.min(canvas.width / ref.width, canvas.height / ref.height);
  return { code, x: b.x * s + (canvas.width - ref.width * s) / 2, y: b.y * s + (canvas.height - ref.height * s) / 2, width: b.width * s, height: b.height * s };
}
describe('A16/A19: motion graphics use the §31 reference/variant/full-frame/bottom/centred placement', () => {
  const shipped = ['slide-in-panels/side-panel', 'slide-in-panels/bottom-sheet', 'collages/grid-reveal', 'misc/progress-ring'].map(id => GRAPHIC_STYLE_PRESETS.find(p => p.id === id)!);
  const fixtures = [...shipped, graphic(), graphic({ id: 'misc/full-reference', spatial: { x: 0, y: 0, width: 1080, height: 1920 }, mg_code_h: undefined }),
    graphic({ id: 'misc/bottom-boundary', spatial: { x: 101, y: 1410, width: 300, height: 500 }, mg_code_h: undefined })];
  for (const p of fixtures) for (const canvas of CANVASES) it(`${p.id} → ${canvas.width}×${canvas.height}`, () => {
    const want = expectedGraphic(p, canvas), doc = initial(canvas), applied = applyStylePreset(doc, p, 1250);
    expect(applied).toHaveLength(1); const item = applied[0];
    expect(item).toMatchObject({ type: 'motionGraphic', display: { from: 1250, to: 1250 + p.duration_ms }, details: { code: want.code }, metadata: { presetId: p.id } });
    // §31 MG geometry is unrounded; equivalent multiply/divide order may differ in the last binary digit, not by a canvas px.
    for (const [key, value] of Object.entries({ positionX: want.x, positionY: want.y, width: want.width, height: want.height, scale: 1 })) expect(Math.abs(Number(staticValue(item, key)) - value)).toBeLessThanOrEqual(1e-9);
    expect(doc.tracks).toHaveLength(3); expect(doc.tracks.find(track => track.id === item.trackId)?.kind).toBe('overlay');
  });
});

describe('applyStylePreset refusals do not mutate the document', () => {
  it.each([[-1000, '-1'], [-1, '-0.001']] as const)('negative start %s ms: INVALID_TIMELINE_START', (start, seconds) => {
    const doc = initial(CANVASES[0]), before = JSON.stringify(doc);
    expect(() => applyStylePreset(doc, FIXTURE, start)).toThrowError(expect.objectContaining({ code: 'INVALID_TIMELINE_START', error: `timelineStart must be >= 0. Received: ${seconds}s.` }));
    expect(JSON.stringify(doc)).toBe(before);
  });
  it.each([{ ...FIXTURE, items: [] }, { id: 'misc/no-code', name: 'No code', description: 'No content.' }])('empty preset %j: PRESET_EMPTY', p => {
    const doc = initial(CANVASES[0]), before = JSON.stringify(doc);
    let error: unknown; try { applyStylePreset(doc, p as StylePreset); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CommandError); expect(error).toMatchObject({ code: 'PRESET_EMPTY' }); expect(JSON.stringify(doc)).toBe(before);
  });
});
