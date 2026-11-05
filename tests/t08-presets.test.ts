// SPDX-License-Identifier: AGPL-3.0-only
// T08 motion-graphic presets (My Presets): validation, placement on a canvas, the addGraphicPreset command and the user's settings row.
// Oracle: findings part 2 §31 (preset data shape, reference canvases 1080 x 1920 / 1920 x 1080, full-frame / bottom-pinned / fit-and-centre placement,
// duration_ms default 5000), coordinator split 2 Nov (T22 ships the content and applyPreset, T08 the loader and My Presets), error INVALID_TIMELINE_START.
// Expected boxes are computed by hand from §31, never with the code under test. Documents store ms.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { MediaStore } from '../apps/web/src/store/media';
import { applyGraphicPreset, loadGraphicPresets, placeGraphicPreset, presetProblem, userGraphicPresets } from '../apps/web/src/mg/presets';
import type { GraphicPreset } from '../apps/web/src/mg/presets';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => resetIds());

const P = (extra: Record<string, unknown> = {}) => ({ id: 'p1', name: 'Lower third', mg_code: 'export const A = () => null;', ...extra });
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('presetProblem: a record is a preset only with id, name and code', () => {
  it('a valid minimal preset has no problem; so does a full one', () => {
    expect(presetProblem(P())).toBeNull();
    expect(presetProblem(P({ category: 'Titles', mg_code_h: 'x', spatial: box(0, 0, 1080, 1920), spatial_h: box(0, 0, 1920, 1080), duration_ms: 3000 }))).toBeNull();
  });
  it.each([[null], [undefined], [42], ['preset'], [true]] as const)('%j is "not an object"', v => expect(presetProblem(v)).toBe('not an object'));
  it.each([[{ name: 'n', mg_code: 'c' }], [{ id: '', name: 'n', mg_code: 'c' }], [{ id: '  ', name: 'n', mg_code: 'c' }], [{ id: 7, name: 'n', mg_code: 'c' }]])('%j: "id is missing"', r =>
    expect(presetProblem(r)).toBe('id is missing'));
  it.each([[{ id: 'i', mg_code: 'c' }], [{ id: 'i', name: '', mg_code: 'c' }], [{ id: 'i', name: null, mg_code: 'c' }]])('%j: "name is missing"', r =>
    expect(presetProblem(r)).toBe('name is missing'));
  it.each([[{ id: 'i', name: 'n' }], [{ id: 'i', name: 'n', mg_code: '' }], [{ id: 'i', name: 'n', mg_code: 5 }]])('%j: "mg_code is missing"', r =>
    expect(presetProblem(r)).toBe('mg_code is missing'));
  it.each([[''], [5], [null], [{}]])('mg_code_h %j is "mg_code_h is not code"', v => expect(presetProblem(P({ mg_code_h: v }))).toBe('mg_code_h is not code'));
  it.each([
    [{ x: 0, y: 0, width: 0, height: 10 }], [{ x: 0, y: 0, width: 10, height: -1 }], [{ x: Number.NaN, y: 0, width: 10, height: 10 }], [{ x: 0, y: Infinity, width: 10, height: 10 }],
    [{ x: 0, y: 0, width: 10 }], [{ x: '0', y: 0, width: 10, height: 10 }], [null], ['box'], [5],
  ])('spatial %j is "spatial is not a box"', v => expect(presetProblem(P({ spatial: v }))).toBe('spatial is not a box'));
  it('spatial_h that is not a box is "spatial_h is not a box"', () => {
    expect(presetProblem(P({ spatial_h: { x: 0, y: 0, width: 0, height: 5 } }))).toBe('spatial_h is not a box');
    expect(presetProblem(P({ spatial_h: null }))).toBe('spatial_h is not a box');
  });
  it.each([[0], [-5], [Number.NaN], [Infinity], ['5000'], [null]])('duration_ms %j is "duration_ms must be positive"', v => expect(presetProblem(P({ duration_ms: v }))).toBe('duration_ms must be positive'));
  it('reasons come in the check order: id, name, mg_code, mg_code_h, spatial, spatial_h, duration_ms', () => {
    const everythingWrong = { id: '', name: '', mg_code: '', mg_code_h: '', spatial: 1, spatial_h: 1, duration_ms: -1 };
    const order: [string, string][] = [['id', 'id is missing'], ['name', 'name is missing'], ['mg_code', 'mg_code is missing'], ['mg_code_h', 'mg_code_h is not code'], ['spatial', 'spatial is not a box'],
      ['spatial_h', 'spatial_h is not a box'], ['duration_ms', 'duration_ms must be positive']];
    const r: Record<string, unknown> = { ...everythingWrong };
    for (const [field, reason] of order) {
      expect(presetProblem(r)).toBe(reason);
      r[field] = { id: 'i', name: 'n', mg_code: 'c', mg_code_h: 'h', spatial: box(0, 0, 1, 1), spatial_h: box(0, 0, 1, 1), duration_ms: 1 }[field];
    }
    expect(presetProblem(r)).toBeNull();
  });
});

describe('loadGraphicPresets', () => {
  it('keeps the valid presets in order, defaults duration_ms to 5000, keeps every other field, and lists the others with their index and reason', () => {
    const full = P({ id: 'p2', category: 'Titles', mg_code_h: 'h', spatial: box(1, 2, 3, 4), spatial_h: box(5, 6, 7, 8), duration_ms: 3000 });
    const r = loadGraphicPresets([P(), 'junk', full, { id: 'p3', name: 'x' }, P({ id: 'p4', duration_ms: 0 })]);
    expect(r.presets).toEqual([{ ...P(), duration_ms: 5000 }, full]);
    expect(r.skipped).toEqual([{ index: 1, reason: 'not an object' }, { index: 3, reason: 'mg_code is missing' }, { index: 4, reason: 'duration_ms must be positive' }]);
  });
  it.each([[undefined], [null], [{}], ['list'], [7]])('a non-array (%j) gives no presets and nothing skipped', v => expect(loadGraphicPresets(v)).toEqual({ presets: [], skipped: [] }));
  it('does not change the records it was given', () => {
    const src = [P()], copy = JSON.stringify(src);
    loadGraphicPresets(src);
    expect(JSON.stringify(src)).toBe(copy);
  });
});

describe('placeGraphicPreset (§31)', () => {
  const preset = (extra: Record<string, unknown> = {}) => ({ ...P(), mg_code_h: 'LANDSCAPE', duration_ms: 5000, ...extra }) as GraphicPreset;
  const noH = (extra: Record<string, unknown> = {}) => ({ ...P(), duration_ms: 5000, ...extra }) as GraphicPreset;
  const at = (p: GraphicPreset, width: number, height: number) => placeGraphicPreset(p, { width, height });

  describe('portrait canvas 1080 x 1920 (reference 1080 x 1920, scale 1)', () => {
    it('a missing box and the exact full frame both cover the canvas', () => {
      expect(at(noH(), 1080, 1920).box).toEqual(box(0, 0, 1080, 1920));
      expect(at(noH({ spatial: box(0, 0, 1080, 1920) }), 1080, 1920).box).toEqual(box(0, 0, 1080, 1920));
    });
    it('uses mg_code even when mg_code_h exists', () => expect(at(preset({ spatial: box(0, 0, 1080, 1920) }), 1080, 1920).code).toBe(P().mg_code));
    it('a box in the middle is fit-scaled by 1 and kept where it is', () => expect(at(noH({ spatial: box(100, 200, 300, 400) }), 1080, 1920).box).toEqual(box(100, 200, 300, 400)));
    it('the bottom boundary: y + height 1909 is fit-scaled, 1910 is pinned to the bottom', () => {
      expect(at(noH({ spatial: box(100, 1409, 300, 500) }), 1080, 1920).box).toEqual(box(100, 1409, 300, 500)); // 1909 < 1910: fit, y stays
      expect(at(noH({ spatial: box(100, 1410, 300, 500) }), 1080, 1920).box).toEqual(box(100, 1420, 300, 500)); // 1910: y' = 1920 - 500
      expect(at(noH({ spatial: box(100, 1500, 300, 600) }), 1080, 1920).box).toEqual(box(100, 1320, 300, 600)); // past the bottom: pinned, y' = 1920 - 600
    });
    it('a box that is full width but not full height is not "full frame"', () => expect(at(noH({ spatial: box(0, 0, 1080, 1000) }), 1080, 1920).box).toEqual(box(0, 0, 1080, 1000)));
  });

  describe('square canvas 1080 x 1080 (portrait reference: width is not greater than height)', () => {
    it('full frame covers the whole canvas', () => expect(at(noH({ spatial: box(0, 0, 1080, 1920) }), 1080, 1080).box).toEqual(box(0, 0, 1080, 1080)));
    it('a middle box is scaled by min(1, 1080 / 1920) = 0.5625 and centred horizontally (offset 236.25)', () =>
      expect(at(noH({ spatial: box(100, 200, 300, 400) }), 1080, 1080).box).toEqual(box(100 * 0.5625 + 236.25, 200 * 0.5625, 300 * 0.5625, 400 * 0.5625)));
    it('mg_code_h is not used on a square canvas', () => expect(at(preset({ spatial: box(100, 200, 300, 400) }), 1080, 1080).code).toBe(P().mg_code));
    it('a bottom box is scaled per axis: x and width by 1, height by 1080 / 1920, pinned to the bottom edge', () =>
      expect(at(noH({ spatial: box(100, 1410, 300, 500) }), 1080, 1080).box).toEqual(box(100, 1080 - 281.25, 300, 281.25)));
  });

  describe('landscape canvas 1920 x 1080', () => {
    it('with mg_code_h: its code, spatial_h and the 1920 x 1080 reference (spatial is ignored)', () => {
      const p = preset({ spatial: box(0, 0, 10, 10), spatial_h: box(100, 200, 300, 400) });
      expect(at(p, 1920, 1080)).toEqual({ code: 'LANDSCAPE', box: box(100, 200, 300, 400) });
    });
    it('with mg_code_h and no spatial_h: the code of mg_code_h over the full canvas', () => expect(at(preset({ spatial: box(0, 0, 10, 10) }), 1920, 1080)).toEqual({ code: 'LANDSCAPE', box: box(0, 0, 1920, 1080) }));
    it('with mg_code_h and the exact full frame 1920 x 1080: the full canvas', () => expect(at(preset({ spatial_h: box(0, 0, 1920, 1080) }), 1920, 1080).box).toEqual(box(0, 0, 1920, 1080)));
    it('the bottom boundary on the landscape reference: y + height 1069 is fit-scaled, 1070 is pinned', () => {
      expect(at(preset({ spatial_h: box(100, 569, 400, 500) }), 1920, 1080).box).toEqual(box(100, 569, 400, 500));
      expect(at(preset({ spatial_h: box(100, 570, 400, 500) }), 1920, 1080).box).toEqual(box(100, 580, 400, 500));
    });
    it('without mg_code_h: mg_code and the portrait reference, scale min(1.7778, 0.5625) = 0.5625, centred (offset 656.25)', () => {
      const r = at(noH({ spatial: box(100, 200, 300, 400) }), 1920, 1080);
      expect(r.code).toBe(P().mg_code);
      expect(r.box).toEqual(box(100 * 0.5625 + 656.25, 200 * 0.5625, 300 * 0.5625, 400 * 0.5625));
    });
    it('without mg_code_h and a full-frame portrait box: the full landscape canvas', () => expect(at(noH({ spatial: box(0, 0, 1080, 1920) }), 1920, 1080).box).toEqual(box(0, 0, 1920, 1080)));
  });

  describe('other canvases', () => {
    it('540 x 960: a middle box is halved, never rounded (x 101 -> 50.5)', () => expect(at(noH({ spatial: box(101, 201, 301, 401) }), 540, 960).box).toEqual(box(50.5, 100.5, 150.5, 200.5)));
    it('540 x 960: a bottom box keeps 0.5 on x and height and is pinned (y = 960 - 250)', () => expect(at(noH({ spatial: box(101, 1410, 301, 500) }), 540, 960).box).toEqual(box(50.5, 710, 150.5, 250)));
    it('does not change the preset', () => {
      const p = noH({ spatial: box(101, 201, 301, 401) }), copy = JSON.stringify(p);
      at(p, 540, 960);
      expect(JSON.stringify(p)).toBe(copy);
    });
  });
});

describe('applyGraphicPreset and the addGraphicPreset command', () => {
  const world = () => build({
    tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('C1', 'caption')],
    items: [video('v1', 'V1', 0, 8000), mkItem('t1', 'O1', 1000, 3000, { type: 'text', details: { text: 'x' } })],
    extra: { size: { width: 540, height: 960 } },
  });
  const editor = (doc = world()) => createEditor(doc, { assets: assets(), links: links() });
  const preset = (extra: Record<string, unknown> = {}) => ({ ...P({ spatial: box(0, 0, 1080, 1920), duration_ms: 4000 }), ...extra }) as GraphicPreset;
  const blanks = (e: ReturnType<typeof editor>) => e.doc.items.filter(i => i.type === 'motionGraphic');

  it('the intent adds one motionGraphic: display 0 to duration_ms, trim 0 to duration_ms, designed length duration_ms, speed 1, name and code, metadata.presetId, no masks or effects', () => {
    const e = editor();
    expect(e.intent({ type: 'addGraphicPreset', preset: preset() })).toEqual({ ok: true });
    expect(blanks(e)).toHaveLength(1);
    expect(blanks(e)[0]).toMatchObject({ type: 'motionGraphic', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000, playbackRate: 1,
      details: { name: 'Lower third', code: P().mg_code }, metadata: { presetId: 'p1' }, masks: [], effects: [] });
  });
  it('the box is the placed box on the project canvas (full frame 540 x 960 here), scale 1', () => {
    const e = editor();
    e.intent({ type: 'addGraphicPreset', preset: preset() });
    expect(blanks(e)[0].properties).toMatchObject({ positionX: { defaultValue: 0 }, positionY: { defaultValue: 0 }, width: { defaultValue: 540 }, height: { defaultValue: 960 }, scale: { defaultValue: 1 } });
  });
  it('a fit-scaled box (x 101 -> 50.5 on 540 x 960) is stored unrounded', () => {
    const e = editor();
    e.intent({ type: 'addGraphicPreset', preset: preset({ spatial: box(101, 201, 301, 401) }) });
    expect(blanks(e)[0].properties).toMatchObject({ positionX: { defaultValue: 50.5 }, positionY: { defaultValue: 100.5 }, width: { defaultValue: 150.5 }, height: { defaultValue: 200.5 } });
  });
  it('a landscape canvas with mg_code_h stores that code', () => {
    const e = editor(build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 4000)], extra: { size: { width: 1920, height: 1080 } } }));
    e.intent({ type: 'addGraphicPreset', preset: preset({ mg_code_h: 'LANDSCAPE', spatial_h: box(100, 200, 300, 400) }) });
    expect(blanks(e)[0].details.code).toBe('LANDSCAPE');
    expect(blanks(e)[0].properties).toMatchObject({ positionX: { defaultValue: 100 }, positionY: { defaultValue: 200 }, width: { defaultValue: 300 }, height: { defaultValue: 400 } });
  });
  it('lives on a NEW overlay track at the default placement, without touching the existing items', () => {
    const e = editor(), before = e.doc.tracks.map(t => t.id), items = JSON.stringify(e.doc.items);
    e.intent({ type: 'addGraphicPreset', preset: preset() });
    const created = e.doc.tracks.filter(t => !before.includes(t.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: 'overlay', muted: false, solo: false, locked: false, hidden: false });
    expect(blanks(e)[0].trackId).toBe(created[0].id);
    expect(e.doc.layerOrder.map(l => l.id)).toEqual(['V1', 'O1', created[0].id, 'C1']);
    expect(JSON.stringify(e.doc.items.filter(i => i.type !== 'motionGraphic'))).toBe(items);
  });
  it('two applications make two tracks', () => {
    const e = editor();
    e.intent({ type: 'addGraphicPreset', preset: preset() }); e.intent({ type: 'addGraphicPreset', preset: preset() });
    expect(new Set(blanks(e).map(i => i.trackId)).size).toBe(2);
    expect(e.doc.tracks).toHaveLength(5);
  });
  it('one undo entry "Add items" from the user; undo restores the document, redo brings the graphic back', () => {
    const e = editor(), before = JSON.stringify(e.doc);
    e.intent({ type: 'addGraphicPreset', preset: preset() });
    expect(e.bus.undoStack).toHaveLength(1);
    expect(e.bus.undoStack[0]).toMatchObject({ label: 'Add items', source: 'user' });
    const after = JSON.stringify(e.doc);
    e.bus.undo();
    expect(JSON.stringify(e.doc)).toBe(before);
    e.bus.redo();
    expect(JSON.stringify(e.doc)).toBe(after);
  });
  it('applyGraphicPreset with a start time places the item there: display {start, start + duration_ms}, trim still from 0', () => {
    const doc = world(), r = applyGraphicPreset(doc, preset(), 2500);
    expect(r).toMatchObject({ display: { from: 2500, to: 6500 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000 });
    expect(doc.items.at(-1)).toBe(r);
  });
  it.each([[-1000, '-1'], [-1, '-0.001'], [Number.NaN, 'NaN']])('start %j ms: INVALID_TIMELINE_START "timelineStart must be >= 0. Received: %ss." and nothing changes', (start, shown) => {
    const doc = world(), before = JSON.stringify(doc);
    expect(() => applyGraphicPreset(doc, preset(), start)).toThrowError(expect.objectContaining({ code: 'INVALID_TIMELINE_START', message: expect.stringContaining(`timelineStart must be >= 0. Received: ${shown}s.`) }));
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('a start of exactly 0 is accepted', () => expect(() => applyGraphicPreset(world(), preset(), 0)).not.toThrow());
  it('the project duration grows to the end of the new graphic', () => {
    const e = editor(build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 2000)], extra: { size: { width: 540, height: 960 } } }));
    e.intent({ type: 'addGraphicPreset', preset: preset({ duration_ms: 9000 }) });
    expect(e.doc.duration).toBe(9000);
  });
});

describe('userGraphicPresets reads the settings row "mg-presets"', () => {
  const opened: ProjectStore[] = [];
  const setup = () => {
    const bytes = new Map<string, Blob>();
    const media: MediaStore = { write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!), remove: vi.fn(async () => {}) };
    const store = new ProjectStore(crypto.randomUUID(), () => Date.now(), media); opened.push(store); return store;
  };
  afterEach(async () => { for (const s of opened.splice(0)) await s.close(); });

  it('no row: no presets', async () => expect(await userGraphicPresets(setup())).toEqual({ presets: [], skipped: [] }));
  it('a row with one valid and one invalid preset: the valid one (duration defaulted) and the invalid one skipped with its reason', async () => {
    const store = setup();
    await store.putRow('settings', { id: 'mg-presets', presets: [P(), { id: 'bad', name: 'Broken' }] });
    expect(await userGraphicPresets(store)).toEqual({ presets: [{ ...P(), duration_ms: 5000 }], skipped: [{ index: 1, reason: 'mg_code is missing' }] });
  });
  it('a row whose presets field is not a list: no presets', async () => {
    const store = setup();
    await store.putRow('settings', { id: 'mg-presets', presets: 'nope' });
    expect(await userGraphicPresets(store)).toEqual({ presets: [], skipped: [] });
  });
  it('only the row with id "mg-presets" counts', async () => {
    const store = setup();
    await store.putRow('settings', { id: 'other', presets: [P()] });
    expect((await userGraphicPresets(store)).presets).toEqual([]);
  });
  it('reads through a stub with row() too: store "settings", key "mg-presets"', async () => {
    const row = vi.fn(async () => ({ id: 'mg-presets', presets: [P({ duration_ms: 1500 })] }));
    const r = await userGraphicPresets({ row } as unknown as ProjectStore);
    expect(row).toHaveBeenCalledWith('settings', 'mg-presets');
    expect(r.presets).toEqual([P({ duration_ms: 1500 })]);
  });
});
