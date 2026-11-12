// SPDX-License-Identifier: AGPL-3.0-only
// T22 render plans/export: C-gt: settled from code, RC 6.1, no stored output; this replaces R-1..R-3.
// Geometry expectations are local arithmetic over authored slot fractions, never slotGraphic/textSlot/boxMatrix results.
// Raster pixels are in ui/t22-render.spec.ts; no value is asserted against a stored output capture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { framePlan } from '../apps/web/src/render/model';
import { exportedItems, exportedMedia, precheck } from '../apps/web/src/export/prep';
import { hasAudioStream } from '../apps/web/src/export/audio';
import { withCellItems } from '../apps/web/src/timeline/layouts';
import { createEditor } from '../apps/web/src/timeline/harness';
import { findElement } from '../apps/web/src/catalogue/elements';
import { slotGraphic, textSlot } from '../apps/web/src/catalogue/graphic';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import type { ProjectStore } from '../apps/web/src/store/database';
import { assets, build, itemOf, mkItem, mkTrack, resetIds, video } from './t03-fixtures';

afterEach(() => resetIds());
const prop = (defaultValue: unknown, keyframes: unknown[] = []) => ({ defaultValue, keyframes });
const properties = (values: RecordData) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, prop(value)]));
const near = (got: number, expected: number) => expect(Math.abs(got - expected)).toBeLessThanOrEqual(1e-9);
const point = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const fx = { id: 'stored-recolor', effectId: 'recolor', enabled: true, order: 0, parameters: {} };
function elementItem(id: string, itemId = 'element'): RecordData {
  const e = findElement(id)!, text = e.slot?.kind === 'text', media = e.slot?.kind === 'media';
  const values: RecordData = { positionX: 40, positionY: 70, width: e.width, height: e.height, scale: 1, opacity: 1, rotation: 0 };
  const details: RecordData = { name: e.name, element: { id, palette: structuredClone(e.palette), colors: e.palette.map(p => p.base), ...(text ? { slot: 'text' } : media ? { slot: 'media' } : {}) } };
  if (e.slot?.kind === 'text') {
    Object.assign(values, { fontSize: 48, fontWeight: 700, color: '#111111', textAlign: 'center' });
    Object.assign(details, { text: 'HI', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' });
  } else if (e.slot?.kind === 'media') {
    Object.assign(details, { layoutType: 'element', gap: 0, borderRadius: 0 });
    details.cells = e.slot.openings.map((bounds, k) => ({ id: `cell-${k}`, bounds: { ...bounds }, source: null,
      fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 }));
  }
  return mkItem(itemId, 'T', 0, 4000, { type: text ? 'text' : media ? 'layout' : 'image', details, properties: properties(values), metadata: { assetId: `picture-${id}` } });
}
const project = (...items: RecordData[]) => build({ tracks: [mkTrack('T', 'video')], items, extra: { size: { width: 1080, height: 1920 } } });
const noInputEffects = (plan: ReturnType<typeof framePlan>) => ({ ...plan, draws: plan.draws.map(d => ({ ...d, item: { ...d.item, effects: [] } })) });

describe('A/B: element recolour and stored recolor entries are drawn, not pending', () => {
  it('palette bases are inactive; editProperties with a changed colour adds Draw.element and the css path', () => {
    const item = elementItem('sticker-star'), editor = createEditor(project(item));
    const initial = framePlan(editor.doc, 500);
    expect(initial.pending).toEqual([]); expect(initial.draws).toHaveLength(1);
    expect(initial.draws[0]).not.toHaveProperty('element'); expect(initial.draws[0].path).toBe('direct');
    expect(editor.call('editProperties', { itemId: item.id, properties: { colors: ['#00FF00'] } })).toMatchObject({ success: true });
    const plan = framePlan(editor.doc, 500), e = findElement('sticker-star')!;
    expect(plan.pending).toEqual([]); expect(plan.draws).toHaveLength(1);
    expect(plan.draws[0]).toMatchObject({ kind: 'image', path: 'css', element: { palette: e.palette, colors: ['#00FF00', e.palette[1].base] } });
  });
  it('an enabled stored recolor entry on an element is not pending', () => {
    const item = elementItem('sticker-star'); item.effects = [fx]; item.details.element.colors[0] = '#00FF00';
    const plan = framePlan(project(item), 500);
    expect(plan.pending).toEqual([]); expect(plan.draws).toHaveLength(1); expect(plan.draws[0].element).toMatchObject({ colors: ['#00FF00', '#1B1B1F'] });
  });
  it('equal 8-bit colours with different hexadecimal case are inactive', () => {
    const item = elementItem('sticker-star'); item.details.element.colors = item.details.element.palette.map((entry: RecordData) => entry.base.toLowerCase());
    const plan = framePlan(project(item), 500);
    expect(plan.pending).toEqual([]); expect(plan.draws).toHaveLength(1); expect(plan.draws[0]).not.toHaveProperty('element'); expect(plan.draws[0].path).toBe('direct');
  });
  it('on a non-element image the stored recolor entry is a no-op, with every render field unchanged', () => {
    const item = mkItem('ordinary', 'T', 0, 4000, { type: 'image', properties: properties({ width: 100, height: 80 }) });
    const baseline = framePlan(project(item), 500), changed = structuredClone(item); changed.effects = [fx];
    const plan = framePlan(project(changed), 500);
    // Only Draw.item.effects (the input record, necessarily different) is normalised. No rendering field is omitted.
    expect(noInputEffects(plan)).toEqual(noInputEffects(baseline)); expect(plan.pending).toEqual([]);
    expect(plan.draws[0].effects).toEqual([]); expect(plan.draws[0]).not.toHaveProperty('element');
  });
});

function ordinaryItems(): RecordData[] {
  const cell = (id: string, source: unknown) => ({ id, bounds: { x: 0, y: 0, width: 1, height: 1 }, source, fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 });
  return ['video', 'image', 'text', 'shape', 'layout-empty', 'layout-filled', 'caption', 'motionGraphic'].map((kind, k) => {
    const type = kind.startsWith('layout') ? 'layout' : kind;
    const details: RecordData = type === 'text' ? { text: 'Ordinary' } : type === 'caption' ? { text: 'Caption', words: [] }
      : type === 'motionGraphic' ? { code: 'export const G = () => null;' } : type === 'layout' ? { cells: [cell(`c${k}`, kind === 'layout-filled' ? { assetId: 'asset-img1', type: 'image', url: 'asset:asset-img1' } : null)] } : {};
    return mkItem(kind, `T${k}`, 0, 4000, { type, details, properties: properties({ width: 200, height: 100 }), metadata: { assetId: type === 'video' ? 'asset-vid1' : 'asset-img1' } });
  });
}
describe('C: documents without details.element retain one ordered draw per visible item', () => {
  it('video/image/text/shape/layout filled+empty/caption/motionGraphic have no extra image or element key', () => {
    const items = ordinaryItems(), doc = build({ items, tracks: items.map((item, k) => mkTrack(item.trackId, k === 6 ? 'caption' : 'video')) });
    const plan = framePlan(doc, 500);
    expect(plan.pending).toEqual([]); expect(plan.draws.map(d => [d.item.id, d.kind])).toEqual(items.map(item => [item.id, item.type]));
    for (const draw of plan.draws) expect(draw).not.toHaveProperty('element');
    expect(plan.draws.filter(d => d.kind === 'image')).toHaveLength(1);
    expect(plan.draws.find(d => d.item.id === 'layout-empty')!.layout!.cells[0].media).toBeNull();
    const filled = plan.draws.find(d => d.item.id === 'layout-filled')!.layout!.cells[0].media!;
    expect(filled.draw.kind).toBe('image'); expect(filled.draw).not.toHaveProperty('element');
  });
  it('an ordinary transition pair still has only its two video draws, in from/to order', () => {
    const a = video('from', 'T', 0, 2000), b = video('to', 'T', 2000, 4000), doc = project(a, b);
    doc.transitions = [{ id: 'pair', trackId: 'T', fromId: a.id, toId: b.id, kind: 'dissolve', durationMs: 1000, alignment: 0.5 }];
    const plan = framePlan(doc, 2000);
    expect(plan.pending).toEqual([]); expect(plan.draws.map(d => [d.item.id, d.kind, d.transition?.role])).toEqual([['from', 'video', 'from'], ['to', 'video', 'to']]);
    for (const draw of plan.draws) expect(draw).not.toHaveProperty('element');
  });
});

describe('A13 C-gt: settled from code, RC 6.1, no stored output — slot picture and parent share the whole box', () => {
  it.each(['label-tag', 'phone-frame'])('%s has two draws with equal animated box/matrix, ids, alpha/blend/filter', id => {
    const item = elementItem(id);
    item.properties.positionX = prop(0, [{ id: 'x0', time: 0, value: 100, easing: 'linear' }, { id: 'x1', time: 2000, value: 140 }]);
    item.properties.positionY = prop(0, [{ id: 'y0', time: 0, value: 200, easing: 'linear' }, { id: 'y1', time: 2000, value: 260 }]);
    item.properties.scale = prop(1, [{ id: 's0', time: 0, value: 1, easing: 'linear' }, { id: 's1', time: 2000, value: 2 }]);
    item.properties.opacity = prop(1, [{ id: 'o0', time: 0, value: 0.2, easing: 'linear' }, { id: 'o1', time: 2000, value: 0.8 }]);
    Object.assign(item.properties, properties({ rotation: 30, blendMode: 'multiply', blur: 2 }));
    const plan = framePlan(project(item), 1000); // halfway: x=120, y=230, scale=1.5, alpha=.5
    expect(plan.pending).toEqual([]); expect(plan.draws.map(d => d.kind)).toEqual(id === 'label-tag' ? ['image', 'text'] : ['layout', 'image']);
    const picture = plan.draws.find(d => d.kind === 'image')!, parent = plan.draws.find(d => d.kind !== 'image')!;
    expect(plan.draws.map(d => d.item.id)).toEqual([item.id, item.id]); expect(picture.item.metadata.assetId).toBe(item.metadata.assetId);
    expect(picture.box).toEqual(parent.box); expect(picture.matrix).toEqual(parent.matrix);
    for (const draw of [picture, parent]) {
      near(draw.alpha, 0.5); expect(draw.blend).toBe('multiply'); expect(draw.filter).toBe('blur(2px)');
      near(draw.box.sx, 1.5); near(draw.box.sy, 1.5); near(draw.box.rotation, 30);
    }
    // Independent §53.2 matrix at the halfway keyframes, not boxMatrix() or slotGraphic().
    const r = Math.PI / 6, a = 1.5 * Math.cos(r), b = 1.5 * Math.sin(r), c = -b, d = a;
    const w = item.properties.width.defaultValue, h = item.properties.height.defaultValue;
    near(parent.box.W, w); near(parent.box.H, h);
    const anchor = [120 + w * 1.5 / 2 - a * w / 2 - c * h / 2, 230 + h * 1.5 / 2 - b * w / 2 - d * h / 2];
    const parentPoint = point(parent.matrix, 0, 0), picturePoint = point(picture.matrix, 0, 0);
    for (let k = 0; k < 2; k++) { near(parentPoint[k], anchor[k]); near(picturePoint[k], anchor[k]); }
  });
  it.each([{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }])('text-slot geometry is local to the whole fitted box on %j', canvas => {
    const item = elementItem('label-tag'), b = Math.min(0.6 * canvas.width / 720, 0.4 * canvas.height / 240);
    const W = Math.round(720 * b), H = Math.round(240 * b);
    Object.assign(item.properties, properties({ width: W, height: H, positionX: Math.round((canvas.width - W) / 2), positionY: Math.round((canvas.height - H) / 2) }));
    const doc = project(item); doc.size = canvas;
    const expected = { x: W * (60 / 720), y: H * (40 / 240), W: W * (600 / 720), H: H * (160 / 240) };
    expect(textSlot(item, W, H)).toEqual(expected);
    const parent = framePlan(doc, 1000).draws.find(draw => draw.kind === 'text')!; expect(parent.text!.slot).toEqual(expected);
  });
  it('text-slot geometry uses keyframed width/height at the requested frame', () => {
    const item = elementItem('label-tag');
    item.properties.width = prop(720, [{ id: 'w0', time: 0, value: 360, easing: 'linear' }, { id: 'w1', time: 2000, value: 720 }]);
    item.properties.height = prop(240, [{ id: 'h0', time: 0, value: 120, easing: 'linear' }, { id: 'h1', time: 2000, value: 300 }]);
    const text = framePlan(project(item), 1000).draws.find(draw => draw.kind === 'text')!;
    expect(text.box.W).toBe(540); expect(text.box.H).toBe(210);
    expect(text.text!.slot).toEqual({ x: 540 * (60 / 720), y: 210 * (40 / 240), W: 540 * (600 / 720), H: 210 * (160 / 240) });
  });
  it('an ordinary text has no text slot, and non-slot metadata produces no extra picture', () => {
    const item = elementItem('label-tag'); delete item.details.element;
    expect(textSlot(item, 720, 240)).toBeNull(); expect(slotGraphic(item)).toBeNull();
    const plan = framePlan(project(item), 1000); expect(plan.draws).toHaveLength(1); expect(plan.draws[0].text).not.toHaveProperty('slot');
  });
  it.each(['label-tag', 'phone-frame'])('%s slotGraphic describes a known picture, not a second slot-sized box', id => {
    const item = elementItem(id), graphic = slotGraphic(item)!;
    expect(graphic.known).toBe(true); expect(graphic).not.toHaveProperty('box'); expect(graphic.item).toMatchObject({ id: item.id, type: 'image', metadata: { assetId: item.metadata.assetId } });
  });
  it.each(['label-tag', 'phone-frame'])('%s picture ignores a stored parent GPU effect but still follows CSS filtering', id => {
    const item = elementItem(id); item.effects = [{ id: 'stored-gpu', effectId: 'grayscale', enabled: true, order: 0, parameters: { amount: prop(100) } }];
    const first = framePlan(project(item), 1000), parent = first.draws.find(draw => draw.kind !== 'image')!, picture = first.draws.find(draw => draw.kind === 'image')!;
    expect(first.pending).toEqual([]); expect(parent.effects.map(effect => effect.effectId)).toEqual(['grayscale']); expect(picture.effects).toEqual([]); expect(picture.path).toBe('direct');
    item.properties.blur = prop(2); const filtered = framePlan(project(item), 1000).draws;
    expect(filtered.find(draw => draw.kind === 'image')).toMatchObject({ effects: [], filter: 'blur(2px)', path: 'css' });
  });
  it.each(['label-tag', 'phone-frame'])("a slot element's text, cells and picture are not masked: T12 masks video and image items only (%s)", id => {
    const item = elementItem(id); item.masks = [{ id: 'stored-mask', name: 'Stored mask', enabled: true, order: 0, source: 'shape', mode: 'add', colorIndex: 0,
      points: [{ anchor: { x: 0, y: 0 } }, { anchor: { x: 100, y: 0 } }, { anchor: { x: 100, y: 100 } }], closed: true, feather: 0, expansion: 0, opacity: 100, inverted: false }];
    if (item.type === 'layout') item.details.cells[0].source = { assetId: 'asset-img1', type: 'image', url: 'asset:asset-img1' };
    const plan = framePlan(project(item), 1000); expect(plan.pending).toEqual([]); expect(plan.draws).toHaveLength(2);
    for (const draw of plan.draws) expect(draw).not.toHaveProperty('masks');
    if (item.type === 'layout') expect(plan.draws.find(draw => draw.kind === 'layout')!.layout!.cells[0].media!.draw).not.toHaveProperty('masks');
    expect(plan.draws.find(draw => draw.kind === 'image')!.path).toBe('direct');
  });
  it.each(['label-tag', 'phone-frame'])('%s recolour belongs to the picture only; opacity .5 stays .5 on both draws, not grouped', id => {
    const item = elementItem(id); item.details.element.colors[0] = '#00FF00'; item.properties.opacity = prop(0.5);
    const plan = framePlan(project(item), 500), picture = plan.draws.find(d => d.kind === 'image')!, parent = plan.draws.find(d => d.kind !== 'image')!;
    expect(plan.pending).toEqual([]); expect(plan.draws).toHaveLength(2); expect(plan.draws.map(d => d.alpha)).toEqual([0.5, 0.5]);
    expect(picture.element).toMatchObject({ palette: findElement(id)!.palette, colors: item.details.element.colors }); expect(picture.path).toBe('css');
    expect(parent).not.toHaveProperty('element');
  });
  it('unknown text-slot element is pending on T22 while its text remains drawn', () => {
    const item = elementItem('label-tag'); item.details.element.id = 'missing';
    const plan = framePlan(project(item), 500);
    expect(plan.pending).toEqual([{ itemId: item.id, owner: 'T22', what: "Unknown element 'missing'" }]); expect(plan.draws.map(d => d.kind)).toEqual(['text']);
  });
  it.each(['label-tag', 'phone-frame'])('applyTransition rejects %s with INVALID_PAIR, without mutation', id => {
    const a = elementItem(id, 'a'), b = elementItem(id, 'b'); a.display.to = 2000; b.display = { from: 2000, to: 4000 };
    const editor = createEditor(project(a, b)), before = JSON.stringify(editor.doc);
    // The quoted reason is message; error remains T11's generic title (implementer clarification, t11-transitions row p4).
    expect(editor.call('applyTransition', { action: 'add', betweenItems: ['a', 'b'], kind: 'dissolve' })).toMatchObject({ success: false, code: 'INVALID_PAIR', error: 'Transition rejected', message: 'Transitions only work with video and image clips' });
    expect(JSON.stringify(editor.doc)).toBe(before); expect(editor.labels()).toEqual([]);
  });
  for (const id of ['label-tag', 'phone-frame']) it.each(['from', 'to'])(`forced pair: ${id} on %s gives its picture the parent's transition tag`, role => {
    const slot = elementItem(id, 'slot'), ordinary = video('ordinary', 'T', role === 'from' ? 2000 : 0, role === 'from' ? 4000 : 2000);
    slot.display = role === 'from' ? { from: 0, to: 2000 } : { from: 2000, to: 4000 };
    const doc = project(...(role === 'from' ? [slot, ordinary] : [ordinary, slot]));
    doc.transitions = [{ id: 'forced', trackId: 'T', fromId: role === 'from' ? 'slot' : 'ordinary', toId: role === 'to' ? 'slot' : 'ordinary', kind: 'dissolve', durationMs: 1000, alignment: 0.5 }];
    const plan = framePlan(doc, 2000), slotDraws = plan.draws.filter(d => d.item.id === 'slot');
    expect(plan.pending).toEqual([]); expect(slotDraws).toHaveLength(2);
    for (const draw of slotDraws) expect(draw.transition).toMatchObject({ id: 'forced', role });
    expect(slotDraws[0].transition).toEqual(slotDraws[1].transition);
  });
});

function fakeStore(list: Asset[], missing = false) {
  const read = vi.fn(async () => { if (missing) throw Object.assign(new Error('missing bytes'), { code: 'WORKSPACE_FILE_MISSING' }); return new Blob(['bytes']); });
  return { read, store: { library: async () => ({ assets: list }), media: { read } } as unknown as ProjectStore };
}
describe('E: export checks include slot pictures without changing ordinary media/audio selection', () => {
  for (const id of ['label-tag', 'phone-frame', 'sticker-star']) {
    it(`${id} unresolved asset names the element and the parent id`, async () => {
      const item = elementItem(id), { store } = fakeStore([]);
      const error = await precheck(store, project(item)).then(() => null, error => error);
      expect(error).toMatchObject({ code: 'UNRESOLVED_MEDIA', detail: expect.stringContaining(findElement(id)!.name), data: { itemIds: [item.id] } });
    });
    it(`${id} missing local bytes names the library asset`, async () => {
      const item = elementItem(id), asset = { ...assets()[2], id: item.metadata.assetId, name: 'element-picture.png' }, { store } = fakeStore([asset], true);
      const error = await precheck(store, project(item)).then(() => null, error => error);
      expect(error).toMatchObject({ code: 'MISSING_LOCAL_FILES', detail: expect.stringContaining('element-picture.png') });
    });
  }
  for (const id of ['label-tag', 'phone-frame']) it.each(['track', 'group'])(`${id} on hidden %s needs no asset or file check`, async hidden => {
    const doc = project(elementItem(id)), { store, read } = fakeStore([]);
    if (hidden === 'track') doc.tracks[0].hidden = true;
    else { doc.groups = { hidden: { hidden: true, children: [{ type: 'track', id: 'T' }] } }; doc.layerOrder = [{ type: 'group', id: 'hidden' }]; }
    await expect(precheck(store, doc)).resolves.toBeInstanceOf(Map); expect(exportedMedia(doc)).toEqual([]); expect(read).not.toHaveBeenCalled();
  });
  it.each([false, true])('hasAudioStream is unchanged by slot pictures, audible source = %s', audible => {
    const doc = project(...(audible ? [video('v', 'T', 0, 4000)] : []));
    const before = hasAudioStream(doc); doc.items.push(elementItem('label-tag'), elementItem('phone-frame', 'frame'));
    expect(hasAudioStream(doc)).toBe(before); expect(before).toBe(audible);
  });
  it('without slots exportedMedia is exactly withCellItems(exportedItems(doc)) restricted to video/image/audio', () => {
    const items = ordinaryItems(), doc = build({ tracks: items.map(i => mkTrack(i.trackId, 'video')), items });
    const expected = withCellItems(exportedItems(doc)).filter(item => ['video', 'image', 'audio'].includes(item.type));
    expect(exportedMedia(doc)).toEqual(expected);
  });
});
