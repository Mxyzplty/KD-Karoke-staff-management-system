// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 3: addMedia and editProperties through callTool, with our own ToolContext and asset lookup.
// Geometry/refit oracle: C-gt: settled from code, RC 6.1/6.3, no stored output; T22 Step 3 interfaces and plan S3 for envelopes,
// error rows 101/102/105/143/144 and tool results addMedia / editProperties normal path. The newer notes retain
// per-item failure codes (unlike the older captured envelope). Expected geometry is local arithmetic, not place.ts/edit.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import { CommandBus } from '../apps/web/src/timeline/bus';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext, ToolResult } from '../apps/web/src/timeline/tools';
import { ELEMENTS, findElement } from '../apps/web/src/catalogue/elements';
import type { CatalogueElement } from '../apps/web/src/catalogue/elements';
import { placeElement } from '../apps/web/src/catalogue/place';
import { findSound } from '../apps/web/src/catalogue/sounds';
import { measureText } from '../apps/web/src/text/tools';
import { assets, build, itemOf, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => resetIds());
const prop = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
const stored = (values: RecordData) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, prop(value)]));
const SIZE = { width: 1080, height: 1920 }, BOUNDS = { x: 37, y: 83, width: 360, height: 240 };
const ELEMENT_CASES = [
  { id: 'sticker-star', type: 'image', track: 'V1', wrong: 'O1' },
  { id: 'label-tag', type: 'text', track: 'O1', wrong: 'V1' },
  { id: 'phone-frame', type: 'layout', track: 'O1', wrong: 'V1' },
] as const;
const base = () => build({ tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('V2', 'video'), mkTrack('O1', 'overlay')],
  items: [video('untouched', 'V2', 5000, 9000)], markers: [{ id: 'marker', timeMs: 6000 }], extra: { size: SIZE } });
function catalogueAsset(id: string): Asset {
  const sound = id.startsWith('sound:') ? findSound(id.slice(6)) : undefined;
  return { ...assets()[sound ? 3 : 2], id: `stored-${id}`, name: id, type: sound ? 'audio' : 'image',
    durationMs: sound?.durationMs ?? null } as Asset;
}
function world(doc = base(), omit: string[] = []) {
  let current = structuredClone(doc);
  const journal: unknown[] = [], bus = new CommandBus({ get: () => current, set: d => { current = d; } }, { journal: row => { journal.push(row); } });
  const lookup = new Map(assets().map(a => [a.id, a]));
  for (const id of ['element:sticker-star', 'element:label-tag', 'element:phone-frame', 'sound:mouse-click']) if (!omit.includes(id)) lookup.set(id, catalogueAsset(id));
  const ctx: ToolContext = { bus, asset: id => lookup.get(id) };
  return { bus, ctx, journal, get doc() { return current; }, call: (name: string, args: RecordData) => callTool(ctx, name, args) };
}
type World = ReturnType<typeof world>;
const json = (value: unknown) => JSON.stringify(value);
function refused(w: World, before: string, result: ToolResult, code: string) {
  expect(result).toMatchObject({ success: false, code }); expect(result.timelineChanges).toBeUndefined();
  expect(json(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0); expect(w.journal).toHaveLength(0);
}
function edit(w: World, properties: RecordData, ids: string | string[] = 'target') {
  return w.call('editProperties', { ...(Array.isArray(ids) ? { itemIds: ids } : { itemId: ids }), properties });
}
// Authored fixtures, not placeElement output: the element's own box starts at (37,83), scale 1.
function elementItem(id: string, itemId = 'target'): RecordData {
  const e = findElement(id)!;
  const type = e.slot?.kind === 'text' ? 'text' : e.slot?.kind === 'media' ? 'layout' : 'image';
  const properties: RecordData = { positionX: 37, positionY: 83, width: e.width, height: e.height, scale: 1, rotation: 0, opacity: 1 };
  const details: RecordData = { name: e.name, element: { id, palette: structuredClone(e.palette), ...(e.stretch ? { stretch: true } : {}) } };
  if (e.slot?.kind === 'text') {
    Object.assign(properties, { fontSize: 48, fontWeight: 700, color: '#111111', textAlign: 'center' });
    Object.assign(details, { text: '', fontFamily: 'Manrope-Bold', fontFamilyDisplay: 'Manrope' }); details.element.slot = 'text';
  } else if (e.slot?.kind === 'media') {
    details.element.slot = 'media';
    Object.assign(details, { layoutType: 'element', gap: 0, borderRadius: 0 });
    details.cells = e.slot.openings.map((bounds, k) => ({ id: `cell-${k}`, bounds: { ...bounds }, source: null,
      fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 }));
  }
  return mkItem(itemId, type === 'image' ? 'V1' : 'O1', 0, 3000, { type, properties: stored(properties), details, metadata: { assetId: `stored-element:${id}` } });
}
const withItems = (...items: RecordData[]) => { const doc = base(); doc.items.push(...items); return world(doc); };
const drawnSize = (item: RecordData) => ({ width: item.properties.width.defaultValue * item.properties.scale.defaultValue,
  height: item.properties.height.defaultValue * item.properties.scale.defaultValue });
function expectElementNote(result: ToolResult, id: string, meaning: RegExp) {
  const e = findElement(id)!;
  expect(result.message).toMatch(meaning);
  expect([e.id, e.name, 'target'].some(name => result.message.includes(name))).toBe(true);
}
// RC 6.1/6.3: the only shared oracle is T05's height measurement. Try candidate integers in ascending order on a
// separate fixture; slot dimensions, limits and maximum are local, never read from the refit or tool's result.
function expectedRefit(item: RecordData, slotWidth: number, slotHeight: number): number {
  const candidate = structuredClone(item), upper = Math.min(400, Math.floor(slotHeight)); let largest = 8;
  for (let size = 8; size <= upper; size++) {
    candidate.properties.fontSize.defaultValue = size;
    if (measureText(candidate, slotWidth).height <= slotHeight) largest = size;
  }
  return largest;
}
const SELF_SIZED = 'the text sizes itself to its bubble; resize the bubble to change it';
const PROPORTIONS = 'keeps its proportions: height follows width';
const fitSentence = (id: string, size: number) => `${id}'s text fits its bubble at fontSize ${size}.`;
const sizeSentence = (id: string, size: number, asked: number) => `${id}'s text sizes itself to its bubble: fontSize ${size}, not ${asked}. Resize the bubble to change it.`;
function boxOf(item: RecordData) { return Object.fromEntries(['positionX', 'positionY', 'width', 'height'].map(key => [key, structuredClone(item.properties[key])])); }

describe('addMedia catalogue elements: result, track, bounds and one atomic undo', () => {
  for (const spec of ELEMENT_CASES) for (const bounded of [false, true]) it(`${spec.id}, ${bounded ? 'with' : 'without'} bounds`, () => {
    const w = world(), before = structuredClone(w.doc), e = findElement(spec.id)!;
    const r = w.call('addMedia', { assetId: `element:${spec.id}`, trackId: spec.track, timelineStart: 1.25, ...(bounded ? { bounds: BOUNDS } : {}) });
    expect(r.success, json(r)).toBe(true); expect(r.data.results).toHaveLength(1);
    const row = r.data.results[0], added = itemOf(w.doc, row.itemId);
    const block = { id: e.id, colors: e.palette.map(p => [p.name, p.base]),
      ...(spec.type === 'text' ? { slot: 'text', text: '' } : spec.type === 'layout' ? { slot: 'media ×1', media: [null] } : {}) };
    expect(row).toMatchObject({ assetId: `element:${e.id}`, success: true, itemId: added.id, type: spec.type, element: block });
    expect(row.element).toEqual(block); expect(row.resolvedTrim).toBeUndefined();
    expect(added).toMatchObject({ type: spec.type, trackId: spec.track, display: { from: 1250, to: 4250 }, metadata: { assetId: `stored-element:${e.id}` } });
    expect(w.doc.tracks.find(t => t.id === added.trackId)?.kind).toBe(spec.type === 'image' ? 'video' : 'overlay');
    if (bounded) {
      const s = Math.min(360 / e.width, 240 / e.height);
      expect(row.resolvedBounds).toEqual({ x: 37, y: 83, width: e.width * s, height: e.height * s });
    } else expect(row).not.toHaveProperty('resolvedBounds');
    expect(r.data.addedItemIds).toEqual([added.id]); expect(r.data.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect({ ...w.doc, items: w.doc.items.filter(i => i.id !== added.id) }).toEqual(before);
    expect(w.bus.undoStack).toHaveLength(1); expect(w.bus.undoStack[0]).toMatchObject({ label: 'Add media', source: 'agent' });
    w.bus.undo(); expect(w.doc).toEqual(before);
  });
  it.each(ELEMENT_CASES)('$id refuses the wrong track kind', spec => {
    const w = world(), before = json(w.doc), r = w.call('addMedia', { assetId: `element:${spec.id}`, trackId: spec.wrong });
    refused(w, before, r, 'INVALID_TRACK');
  });
  it('a catalogue sound is an audio item with its known duration, not the unknown-source fallback', () => {
    const w = world(), sound = findSound('mouse-click')!;
    const r = w.call('addMedia', { assetId: 'sound:mouse-click', trackId: 'A1' });
    expect(r.success, json(r)).toBe(true);
    const row = r.data.results[0], added = itemOf(w.doc, row.itemId);
    expect(added).toMatchObject({ type: 'audio', trackId: 'A1', display: { from: 0, to: sound.durationMs }, trim: { from: 0, to: sound.durationMs } });
    expect(row).toMatchObject({ assetId: 'sound:mouse-click', success: true, resolvedTrim: { start: 0, end: sound.durationMs / 1000, duration: sound.durationMs / 1000 } });
    expect(row).not.toHaveProperty('element'); expect(w.bus.labels()).toEqual(['Add media']);
  });
  it('element trimStart/trimEnd are ignored; two elements chain from timelineStart in a single undo', () => {
    const w = world(), r = w.call('addMedia', { trackId: 'V1', timelineStart: 2,
      items: [{ assetId: 'element:sticker-star', trimStart: 100, trimEnd: -1, duration: 0.75 }, { assetId: 'element:sticker-star' }] });
    expect(r.success, json(r)).toBe(true);
    expect(r.data.addedItemIds.map((id: string) => itemOf(w.doc, id).display)).toEqual([{ from: 2000, to: 2750 }, { from: 2750, to: 5750 }]);
    expect(w.bus.labels()).toEqual(['Add media']);
  });
});

describe('S3 addMedia: exact per-item codes/messages and no mutation on refusal', () => {
  it.each([
    ['element:missing', 'UNKNOWN_ELEMENT', "'missing' is not a built-in element. Use an element:<id> from elements/."],
    ['sound:missing', 'UNKNOWN_SOUND', "'missing' is not in the sound catalog. Use a sound:<slug> from the catalog listing."],
    ['element:sticker-star', 'MEDIA_NOT_FOUND', 'Media asset not found'],
  ])('%s → %s in VALIDATION_FAILED', (assetId, code, error) => {
    const w = world(base(), [assetId]), before = json(w.doc), r = w.call('addMedia', { assetId, trackId: 'V1' });
    refused(w, before, r, 'VALIDATION_FAILED'); expect(r.data.failures).toEqual([{ assetId, code, error }]);
  });
  it.each([
    [{ bounds: { x: NaN, y: 0, width: 10 } }, 'INVALID_BOUNDS', 'bounds requires finite x/y coordinates and at least one positive width or height.'],
    [{ bounds: { x: 0, y: Infinity, height: 10 } }, 'INVALID_BOUNDS', 'bounds requires finite x/y coordinates and at least one positive width or height.'],
    [{ bounds: { x: 0, y: 0, width: 0, height: -1 } }, 'INVALID_BOUNDS', 'bounds requires finite x/y coordinates and at least one positive width or height.'],
    [{ timelineStart: -1 }, 'INVALID_TIMELINE_START', 'timelineStart must be >= 0. Received: -1s.'],
    [{ timelineStart: NaN }, 'INVALID_TIMELINE_START', 'timelineStart must be >= 0. Received: NaNs.'],
    [{ duration: 0 }, 'INVALID_DURATION', 'duration must be positive. Received: 0s.'],
    [{ duration: -1 }, 'INVALID_DURATION', 'duration must be positive. Received: -1s.'],
    [{ duration: NaN }, 'INVALID_DURATION', 'duration must be positive. Received: NaNs.'],
  ] as const)('%j → %s', (args, code, error) => {
    const w = world(), before = json(w.doc), r = w.call('addMedia', { assetId: 'element:label-tag', trackId: 'O1', ...args });
    refused(w, before, r, 'VALIDATION_FAILED'); expect(r.data.failures).toEqual([{ assetId: 'element:label-tag', code, error }]);
  });
  it('slot element + sticker in one call refuses MIXED_MEDIA_KINDS', () => {
    const w = world(), before = json(w.doc), r = w.call('addMedia', { trackId: 'O1', items: [{ assetId: 'element:label-tag' }, { assetId: 'element:sticker-star' }] });
    refused(w, before, r, 'MIXED_MEDIA_KINDS');
    expect(r.error).toBe('Elements with a text or media slot go on an overlay track; stickers, videos and images go on a video track (found text, image). Place them in separate calls.');
  });
});

describe('insertAfterItemId uses the element item type, not its source image asset type', () => {
  it.each(ELEMENT_CASES)('$id inserts on its compatible reference track and ripples later items', spec => {
    const doc = base(), refType = spec.type === 'image' ? 'video' : 'text';
    doc.items.push(mkItem('ref', spec.track, 1000, 4000, { type: refType, details: refType === 'text' ? { text: 'ref' } : {} }),
      mkItem('later', spec.track, 5000, 6000, { type: refType, details: refType === 'text' ? { text: 'later' } : {} }));
    const w = world(doc), r = w.call('addMedia', { assetId: `element:${spec.id}`, insertAfterItemId: 'ref' });
    expect(r.success, json(r)).toBe(true);
    expect(itemOf(w.doc, r.data.addedItemIds[0])).toMatchObject({ type: spec.type, trackId: spec.track, display: { from: 4000, to: 7000 } });
    expect(itemOf(w.doc, 'later').display).toEqual({ from: 8000, to: 9000 }); expect(itemOf(w.doc, 'ref')).toEqual(itemOf(doc, 'ref'));
    expect(w.bus.labels()).toEqual(['Insert items']);
  });
  it.each(ELEMENT_CASES)('$id refuses an incompatible reference without changing anything', spec => {
    const doc = base(), refType = spec.type === 'image' ? 'text' : 'video';
    doc.items.push(mkItem('ref', spec.wrong, 1000, 4000, { type: refType, details: refType === 'text' ? { text: 'ref' } : {} }));
    const w = world(doc), before = json(w.doc), r = w.call('addMedia', { assetId: `element:${spec.id}`, insertAfterItemId: 'ref' });
    refused(w, before, r, 'INSERT_AFTER_TYPE_MISMATCH');
    expect(r.message).toBe(`Cannot insert ${spec.type} after ${refType} item 'ref'. The new item requires a compatible track kind.`);
  });
});

describe('editProperties element colours: slot updates, keep/null, extras and atomic validation', () => {
  it('sets slots, stores full uppercase colours and reports palette names; null and missing keep previous values', () => {
    const w = withItems(elementItem('sticker-star')), e = findElement('sticker-star')!;
    const first = edit(w, { colors: ['#aabbcc', '#dDeEfF'] });
    expect(first.success, json(first)).toBe(true); expect(itemOf(w.doc, 'target').details.element.colors).toEqual(['#AABBCC', '#DDEEFF']);
    expect(first.data.results).toEqual([{ itemId: 'target', applied: { colors: { [e.palette[0].name]: '#AABBCC', [e.palette[1].name]: '#DDEEFF' } } }]);
    const next = edit(w, { colors: [null, '#112233'] });
    expect(next.success, json(next)).toBe(true); expect(itemOf(w.doc, 'target').details.element.colors).toEqual(['#AABBCC', '#112233']);
    expect(next.data.results[0].applied.colors).toEqual({ [e.palette[1].name]: '#112233' });
    expect(edit(w, { colors: ['#334455'] }).success).toBe(true);
    expect(itemOf(w.doc, 'target').details.element.colors).toEqual(['#334455', '#112233']);
  });
  it('a never-set slot retains the palette base, while extras are ignored with an element-specific note', () => {
    const w = withItems(elementItem('sticker-star')), e = findElement('sticker-star')!;
    const r = edit(w, { colors: ['#abcdef', null, '#123456'] });
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').details.element.colors).toEqual(['#ABCDEF', e.palette[1].base]);
    expect(r.data.results[0].applied.colors).toEqual({ [e.palette[0].name]: '#ABCDEF' }); expectElementNote(r, e.id, /ignor/i);
  });
  it.each([{ colors: ['red'] }, { colors: ['#fff'] }, { colors: [123] }, { colors: ['#GG0000'] }, { colors: 'not-an-array' }, { colors: {} }])('bad colors $colors refuses without writing any target', ({ colors }) => {
    const w = withItems(elementItem('sticker-star')), before = json(w.doc), r = edit(w, { colors, opacity: 0.5 });
    refused(w, before, r, 'INVALID_PROPERTY_VALUE');
  });
});

describe('editProperties element media: openings, clearing, keep and validation', () => {
  it('fills a video and image, null empties one, and a missing entry keeps the other', () => {
    const w = withItems(elementItem('split-frame'));
    const first = edit(w, { media: ['asset-vid1', 'asset-img1'] });
    expect(first.success, json(first)).toBe(true);
    expect(itemOf(w.doc, 'target').details.cells.map((cell: RecordData) => cell.source)).toEqual([
      { assetId: 'asset-vid1', type: 'video', url: 'asset:asset-vid1' }, { assetId: 'asset-img1', type: 'image', url: 'asset:asset-img1' },
    ]);
    expect(first.data.results[0]).toEqual({ itemId: 'target', applied: { media: ['asset-vid1', 'asset-img1'] } });
    const next = edit(w, { media: [null] });
    expect(next.success, json(next)).toBe(true); expect(next.data.results[0].applied.media).toEqual([null]);
    expect(itemOf(w.doc, 'target').details.cells.map((cell: RecordData) => cell.source)).toEqual([null, { assetId: 'asset-img1', type: 'image', url: 'asset:asset-img1' }]);
  });
  it('ignores extra media entries with a note, without validating an ignored missing id', () => {
    const w = withItems(elementItem('phone-frame')), r = edit(w, { media: ['asset-img1', 'ignored-nonexistent'] });
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').details.cells).toHaveLength(1);
    expect(r.data.results[0].applied.media).toEqual(['asset-img1']); expectElementNote(r, 'phone-frame', /ignor/i);
  });
  it.each([['missing', 'MEDIA_NOT_FOUND'], ['asset-aud1', 'INVALID_PROPERTY_VALUE']])('%s refuses %s, including an earlier otherwise-valid colour update', (assetId, code) => {
    const w = withItems(elementItem('phone-frame')), before = json(w.doc), r = edit(w, { colors: ['#123456'], media: [assetId] });
    refused(w, before, r, code);
  });
  it.each([{ media: 'not-an-array' }, { media: {} }, { media: [42] }])('malformed media $media refuses atomically', ({ media }) => {
    const w = withItems(elementItem('phone-frame')), before = json(w.doc), r = edit(w, { media });
    refused(w, before, r, 'INVALID_PROPERTY_VALUE');
  });
});

describe('A13 C-gt: settled from code, RC 6.1/6.3, no stored output — resize stores whole dimensions at the same corner', () => {
  it.each([{ width: 200 }, { height: 200 }, { width: 200, height: 400 }])('non-stretch star %j stays square, width wins; an ignored height is data only', properties => {
    const w = withItems(elementItem('sticker-star')), r = edit(w, properties);
    expect(r.success, json(r)).toBe(true); expect(drawnSize(itemOf(w.doc, 'target'))).toEqual({ width: 200, height: 200 });
    expect(itemOf(w.doc, 'target').properties.positionX).toEqual(prop(37)); expect(itemOf(w.doc, 'target').properties.positionY).toEqual(prop(83));
    expect(r.message).toBe('Updated 1 item atomically');
    expect(r.data.results).toEqual([{ itemId: 'target', applied: { width: 200, height: 200 }, ...('width' in properties && 'height' in properties ? { ignored: { height: PROPORTIONS } } : {}) }]);
  });
  it('stretch sets both dimensions independently', () => {
    const w = withItems(elementItem('underline-scribble')), r = edit(w, { width: 300, height: 75 });
    expect(r.success, json(r)).toBe(true); expect(drawnSize(itemOf(w.doc, 'target'))).toEqual({ width: 300, height: 75 });
    expect(r.data.results).toEqual([{ itemId: 'target', applied: { width: 300, height: 75 } }]); expect(r.message).toBe('Updated 1 item atomically');
  });
  it.each(['width', 'height'])('text-slot %s resize keeps element origin (37,83), not the old text-slot origin', key => {
    const w = withItems(elementItem('label-tag')), r = edit(w, { [key]: key === 'width' ? 360 : 120 });
    // RC 6.1: 720×240 ->360×120; the text item stores the WHOLE element box, not local slot (30,20,300,80).
    expect(r.success, json(r)).toBe(true);
    expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ positionX: 37, positionY: 83, width: 360, height: 120 }));
  });
  it('an image resize changes stored width/height without touching its existing scale', () => {
    const item = elementItem('sticker-star'); item.properties.scale = prop(2); const w = withItems(item), r = edit(w, { width: 200 });
    expect(r.success, json(r)).toBe(true);
    expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ positionX: 37, positionY: 83, width: 200, height: 200, scale: 2 }));
  });
  it('a media-slot layout resize stores the new whole box and keeps the corner', () => {
    const w = withItems(elementItem('phone-frame')), r = edit(w, { width: 270 });
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ positionX: 37, positionY: 83, width: 270, height: 540 }));
  });
  it.each([{ width: 300 }, { height: 75 }])('stretch resize changes only the given side %j', dimensions => {
    const w = withItems(elementItem('underline-scribble')), r = edit(w, dimensions); expect(r.success, json(r)).toBe(true);
    expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ width: dimensions.width ?? 800, height: dimensions.height ?? 120, positionX: 37, positionY: 83 }));
  });
  for (const key of ['width', 'height']) it.each([0, -1, NaN, Infinity, -Infinity, '200', null, undefined])(`${key} %s refuses INVALID_PROPERTY_VALUE without changes for all three element kinds`, value => {
    for (const { id } of ELEMENT_CASES) {
      const w = withItems(elementItem(id)), before = json(w.doc), r = edit(w, { [key]: value });
      refused(w, before, r, 'INVALID_PROPERTY_VALUE'); expect(r.error).toBe("An element's width and height must be positive.");
    }
  });
  it('ordinary width is still the old property path, also inside a mixed element/non-element batch', () => {
    const ordinary = mkItem('ordinary', 'V2', 0, 3000, { type: 'image', properties: stored({ width: 500, height: 100, scale: 1 }) });
    const single = withItems(ordinary), r = edit(single, { width: 300 }, 'ordinary');
    expect(r.success, json(r)).toBe(true); expect(r.data).not.toHaveProperty('results'); expect(itemOf(single.doc, 'ordinary').properties.width).toEqual(prop(300));
    expect(itemOf(single.doc, 'ordinary').properties.height).toEqual(prop(100));
    const batch = withItems(elementItem('sticker-star'), ordinary), result = edit(batch, { width: 200 }, ['target', 'ordinary']);
    expect(result.success, json(result)).toBe(true); expect(drawnSize(itemOf(batch.doc, 'target'))).toEqual({ width: 200, height: 200 });
    expect(itemOf(batch.doc, 'ordinary').properties).toMatchObject(stored({ width: 200, height: 100 }));
  });
});

describe('RC 6.3: fixed-element resize follows the current box ratio, with data-only height refusals', () => {
  for (const id of ['sticker-star', 'label-tag', 'phone-frame']) it.each([
    { label: '600/400 uses 600/300 and ignores height', asked: { width: 600, height: 400 }, used: { width: 600, height: 300 }, ignored: true },
    { label: '600/300.4 uses 600/300 with no ignored height', asked: { width: 600, height: 300.4 }, used: { width: 600, height: 300 }, ignored: false },
    { label: 'height alone divides by current ratio, without rounding', asked: { height: 100.25 }, used: { width: 200.5, height: 100.25 }, ignored: false },
    { label: 'width alone multiplies by current ratio, without rounding', asked: { width: 600.25 }, used: { width: 600.25, height: 300.125 }, ignored: false },
  ])(`${id}: $label`, ({ asked, used, ignored }) => {
    const item = elementItem(id); Object.assign(item.properties, stored({ width: 400, height: 200 }));
    const w = withItems(item), r = edit(w, asked); expect(r.success, json(r)).toBe(true);
    expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ ...used, positionX: 37, positionY: 83, scale: 1 }));
    expect(r.data.results).toEqual([{ itemId: 'target', applied: used, ...(ignored ? { ignored: { height: PROPORTIONS } } : {}) }]);
    expect(r.message).toBe('Updated 1 item atomically');
  });
  it.each([{ height: 299.5, ignored: false }, { height: 300.5, ignored: false }, { height: 299.4999, ignored: true }, { height: 300.5001, ignored: true }])(
    'asked height $height: the absolute discrepancy must be more than 0.5 to be ignored', ({ height, ignored }) => {
      const item = elementItem('sticker-star'); Object.assign(item.properties, stored({ width: 400, height: 200 }));
      const w = withItems(item), r = edit(w, { width: 600, height }); expect(r.success, json(r)).toBe(true);
      expect(r.data.results).toEqual([{ itemId: 'target', applied: { width: 600, height: 300 }, ...(ignored ? { ignored: { height: PROPORTIONS } } : {}) }]); expect(r.message).toBe('Updated 1 item atomically');
    });
  it.each([
    { width: 0, height: 200, asked: { width: 600 }, used: { width: 600, height: 600 * (240 / 720) } },
    { width: 400, height: 0, asked: { width: 600 }, used: { width: 600, height: 600 * (240 / 720) } },
    { width: 0, height: 0, asked: { height: 60 }, used: { width: 60 / (240 / 720), height: 60 } },
  ])('empty box $width × $height uses label-tag natural ratio 240/720 only as a fallback', ({ width, height, asked, used }) => {
    const item = elementItem('label-tag'); Object.assign(item.properties, stored({ width, height })); const w = withItems(item), r = edit(w, asked);
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ ...used, positionX: 37, positionY: 83 }));
    expect(r.data.results).toEqual([{ itemId: 'target', applied: used }]); expect(r.message).toBe('Updated 1 item atomically');
  });
});

describe('RC 6.1/6.3: the real agent editProperties handler refits non-blank text-slot elements', () => {
  it('setting text through the tool refits and reports the applied size even without an element field', () => {
    const item = elementItem('label-tag'), text = 'A long line that will need to wrap. '.repeat(30), expected = structuredClone(item); expected.details.text = text;
    const fitted = expectedRefit(expected, 720 * (600 / 720), 240 * (160 / 240)), w = withItems(item), r = edit(w, { text });
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties.fontSize).toEqual(prop(fitted)); expect(fitted).not.toBe(48);
    expect(r.data.results).toEqual([{ itemId: 'target', applied: { fontSize: fitted } }]); expect(r.message).toBe(`Updated 1 item atomically. ${fitSentence('target', fitted)}`);
    expect(r.data.changedFields.target).toContain('properties.fontSize'); expect(r.timelineChanges.items.updated.find((i: RecordData) => i.itemId === 'target').changedFields).toContain('properties.fontSize');
  });
  it('one width + text call resizes 300 × 150 to 600 × 300 before fitting the new text in its 480 × 150 slot', () => {
    // Approved test-only catalogue data: no production helper or catalogue value supplies the .8 × .5 oracle.
    const synthetic: CatalogueElement = { id: 't22-test-refit-bubble', name: 'Test refit bubble', group: 'bubble', file: 'test-only-refit.svg', width: 400, height: 200, palette: [],
      slot: { kind: 'text', box: { x: 0.1, y: 0.25, width: 0.8, height: 0.5 }, fontFamily: 'Roboto', fontWeight: 400 } };
    const catalogue = ELEMENTS as CatalogueElement[]; catalogue.push(synthetic);
    try {
      const item = placeElement(synthetic, SIZE, { trackId: 'O1', assetId: 'test-picture', bounds: { x: 37, y: 83, width: 300, height: 150 } }); item.id = 'target'; item.details.text = 'Before';
      const text = 'The new text must wrap within the resized bubble. '.repeat(4), expected = structuredClone(item); Object.assign(expected.properties, stored({ width: 600, height: 300 })); expected.details.text = text;
      const fitted = expectedRefit(expected, 600 * 0.8, 300 * 0.5), w = withItems(item), r = edit(w, { width: 600, text });
      expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ width: 600, height: 300, positionX: 37, positionY: 83, fontSize: fitted })); expect(itemOf(w.doc, 'target').details.text).toBe(text);
      expect([600 * 0.8, 300 * 0.5, 8, Math.min(400, Math.floor(300 * 0.5))]).toEqual([480, 150, 8, 150]);
      expect(r.data.results).toEqual([{ itemId: 'target', applied: { width: 600, height: 300, fontSize: fitted } }]); expect(r.message).toBe(`Updated 1 item atomically. ${fitSentence('target', fitted)}`);
    } finally { const at = catalogue.indexOf(synthetic); if (at >= 0) catalogue.splice(at, 1); }
  });
  it('the same combined resize/text edit uses the real label-tag fractions on its new box', () => {
    const item = elementItem('label-tag'); Object.assign(item.properties, stored({ width: 300, height: 150 })); item.details.text = 'Before';
    const text = 'The new text must wrap within the resized bubble. '.repeat(4), expected = structuredClone(item); Object.assign(expected.properties, stored({ width: 600, height: 300 })); expected.details.text = text;
    const slotW = 600 * (600 / 720), slotH = 300 * (160 / 240), fitted = expectedRefit(expected, slotW, slotH), w = withItems(item), r = edit(w, { width: 600, text });
    expect([slotW, slotH]).toEqual([500, 200]); expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ width: 600, height: 300, fontSize: fitted })); expect(itemOf(w.doc, 'target').details.text).toBe(text);
    expect(r.data.results).toEqual([{ itemId: 'target', applied: { width: 600, height: 300, fontSize: fitted } }]);
  });
  it('a height-only agent resize refits existing text inside the new proportional whole box', () => {
    const item = elementItem('label-tag'); item.details.text = 'H'; const expected = structuredClone(item); Object.assign(expected.properties, stored({ width: 360, height: 120 }));
    const fitted = expectedRefit(expected, 360 * (600 / 720), 120 * (160 / 240)), w = withItems(item), r = edit(w, { height: 120 });
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ width: 360, height: 120, fontSize: fitted, positionX: 37, positionY: 83 }));
    expect(r.data.results).toEqual([{ itemId: 'target', applied: { width: 360, height: 120, fontSize: fitted } }]); expect(r.message).toBe(`Updated 1 item atomically. ${fitSentence('target', fitted)}`);
  });
  it.each([
    { key: 'text', value: 'New wrapped text' }, { key: 'fontFamily', value: 'Roboto-Regular' }, { key: 'fontWeight', value: 400 }, { key: 'fontStyle', value: 'italic' },
    { key: 'fontSize', value: 1000 }, { key: 'letterSpacing', value: 2 }, { key: 'lineHeight', value: 1.5 }, { key: 'wordSpacing', value: 3 },
    { key: 'textTransform', value: 'uppercase' }, { key: 'look', value: null }, { key: 'width', value: 720 }, { key: 'height', value: 240 },
  ])('agent trigger $key refits, including when the requested field was already equal', ({ key, value }) => {
    const item = elementItem('label-tag'); item.details.text = 'Mixed case words'; item.properties.fontSize = prop(1);
    const expected = structuredClone(item);
    if (key === 'text') expected.details.text = value;
    else if (key === 'fontFamily') { expected.details.fontFamily = 'Roboto-Regular'; expected.details.fontFamilyDisplay = 'Roboto'; Object.assign(expected.properties, stored({ fontWeight: 400, fontStyle: 'normal' })); }
    else if (key !== 'look') expected.properties[key] = prop(value);
    const fitted = expectedRefit(expected, 720 * (600 / 720), 240 * (160 / 240)), beforeBox = boxOf(item), w = withItems(item), r = edit(w, { [key]: value }), after = itemOf(w.doc, 'target');
    expect(r.success, json(r)).toBe(true); expect(after.properties.fontSize).toEqual(prop(fitted)); expect(boxOf(after)).toEqual(beforeBox);
    if (key === 'text') expect(after.details.text).toBe(value);
    else if (key === 'fontFamily') expect(after.details.fontFamily).toBe('Roboto-Regular');
    else if (key !== 'look' && key !== 'fontSize') expect(after.properties[key]).toEqual(prop(value));
    const applied = { ...(['width', 'height'].includes(key) ? { width: 720, height: 240 } : {}), fontSize: fitted };
    expect(r.data.results).toEqual([{ itemId: 'target', applied, ...(key === 'fontSize' ? { ignored: { fontSize: SELF_SIZED } } : {}) }]);
    expect(r.message).toBe(`Updated 1 item atomically. ${key === 'fontSize' ? sizeSentence('target', fitted, 1000) : fitSentence('target', fitted)}`);
  });
  it.each([false, true])('asked fontSize equals fitted size = %s: exact applied/ignored entry and sentence', same => {
    const item = elementItem('label-tag'); item.details.text = 'H'; const fitted = expectedRefit(item, 600, 160), asked = same ? fitted : 1000, w = withItems(item), r = edit(w, { fontSize: asked });
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties.fontSize).toEqual(prop(fitted));
    expect(r.data.results).toEqual([{ itemId: 'target', applied: { fontSize: fitted }, ...(!same ? { ignored: { fontSize: SELF_SIZED } } : {}) }]);
    expect(r.message).toBe(`Updated 1 item atomically. ${same ? fitSentence('target', fitted) : sizeSentence('target', fitted, asked)}`);
  });
  it('the agent fontSize write and refit replace only the base value, keeping every font-size keyframe', () => {
    const item = elementItem('label-tag'), text = 'too many words '.repeat(100), keyframes = [{ id: 'size-a', time: 1000, value: 20, easing: 'linear' }, { id: 'size-b', time: 2000, value: 24 }];
    Object.assign(item.properties, stored({ width: 36, height: 30 })); item.details.text = text; item.properties.fontSize = { defaultValue: 48, keyframes: structuredClone(keyframes) };
    // Even unanimated size 8 cannot fit the locally computed 30 × 20 slot, so the fallback is unambiguously 8.
    const smallest = structuredClone(item); smallest.properties.fontSize = prop(8); expect(measureText(smallest, 36 * (600 / 720)).height).toBeGreaterThan(30 * (160 / 240));
    const w = withItems(item), r = edit(w, { fontSize: 1000 }); expect(r.success, json(r)).toBe(true);
    expect(itemOf(w.doc, 'target').properties.fontSize).toEqual({ defaultValue: 8, keyframes });
    expect(r.data.results).toEqual([{ itemId: 'target', applied: { fontSize: 8 }, ignored: { fontSize: SELF_SIZED } }]); expect(r.message).toBe(`Updated 1 item atomically. ${sizeSentence('target', 8, 1000)}`);
  });
  it.each([false, true])('refit changes the stored size = %s: fontSize appears in both changedFields views only then', changed => {
    const item = elementItem('label-tag'), text = 'After', expected = structuredClone(item); item.details.text = 'Before'; expected.details.text = text;
    const fitted = expectedRefit(expected, 600, 160); item.properties.fontSize = prop(changed ? 1 : fitted);
    const w = withItems(item), r = edit(w, { text, fontSize: 1000 }); expect(r.success, json(r)).toBe(true); expect(r.data.results[0].applied.fontSize).toBe(fitted);
    const toolFields = r.data.changedFields.target, timelineFields = r.timelineChanges.items.updated.find((i: RecordData) => i.itemId === 'target').changedFields;
    for (const fields of [toolFields, timelineFields]) { expect(fields).toContain('details.text'); expect(fields.includes('properties.fontSize')).toBe(changed); }
    expect(itemOf(w.doc, 'target').properties.fontSize).toEqual(prop(fitted));
  });
  it.each(['', ' \t\n '])('blank text %j is written but never refitted or reported as a refit', text => {
    const item = elementItem('label-tag'); item.details.text = 'Before'; const w = withItems(item), r = edit(w, { text });
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').details.text).toBe(text); expect(itemOf(w.doc, 'target').properties.fontSize).toEqual(prop(48));
    expect(r.data).not.toHaveProperty('results'); expect(r.message).toBe('Updated 1 item atomically'); expect(r.data.changedFields.target).not.toContain('properties.fontSize');
  });
  it('opacity has no trigger: non-blank, badly fitting slot text keeps its fontSize and has no result sentence', () => {
    const item = elementItem('label-tag'); item.details.text = 'Too many words to fit at 48. '.repeat(100); const w = withItems(item), r = edit(w, { opacity: 0.5 });
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ fontSize: 48, opacity: 0.5 }));
    expect(r.data).not.toHaveProperty('results'); expect(r.message).toBe('Updated 1 item atomically'); expect(r.data.changedFields.target).not.toContain('properties.fontSize');
  });
  it('a mixed slot/ordinary-text batch refits and reports only the slot item', () => {
    const slot = elementItem('label-tag'), plain = mkItem('plain', 'O1', 0, 3000, { type: 'text', details: { text: 'Before', fontFamily: 'Roboto-Regular', fontFamilyDisplay: 'Roboto' }, properties: stored({ width: 720, height: 240, fontSize: 125 }) });
    slot.details.text = 'Before'; const text = 'New words in both text items', expected = structuredClone(slot); expected.details.text = text;
    const fitted = expectedRefit(expected, 600, 160), w = withItems(slot, plain), r = edit(w, { text }, ['target', 'plain']);
    expect(r.success, json(r)).toBe(true); expect(itemOf(w.doc, 'target').properties.fontSize).toEqual(prop(fitted)); expect(itemOf(w.doc, 'plain').properties.fontSize).toEqual(prop(125));
    expect(itemOf(w.doc, 'plain').details.text).toBe(text); expect(r.data.results).toEqual([{ itemId: 'target', applied: { fontSize: fitted } }]); expect(r.message).toBe(`Updated 2 items atomically. ${fitSentence('target', fitted)}`); expect(r.data.changedFields.plain).not.toContain('properties.fontSize');
  });
  it('element notes precede one fit sentence per refitted item, in target order', () => {
    const first = elementItem('label-tag'), second = elementItem('label-tag', 'second'), text = 'After';
    const expected = structuredClone(first); expected.details.text = text; const fitted = expectedRefit(expected, 600, 160), w = withItems(first, second), r = edit(w, { colors: ['#123456'], text }, ['target', 'second']);
    expect(r.success, json(r)).toBe(true);
    expect(r.message).toBe(`Updated 2 items atomically. Label tag: set Fill to #123456. Label tag: set Fill to #123456. ${fitSentence('target', fitted)} ${fitSentence('second', fitted)}`);
    expect(r.data.results).toEqual(['target', 'second'].map(itemId => ({ itemId, applied: { colors: { Fill: '#123456' }, fontSize: fitted } })));
  });
  it('an ignored proportional height and an ignored requested font size coexist; only the refit has a sentence', () => {
    const item = elementItem('label-tag'); item.details.text = 'Before'; Object.assign(item.properties, stored({ width: 400, height: 200 }));
    const text = 'After', expected = structuredClone(item); Object.assign(expected.properties, stored({ width: 600, height: 300 })); expected.details.text = text;
    const fitted = expectedRefit(expected, 600 * (600 / 720), 300 * (160 / 240)), w = withItems(item), r = edit(w, { width: 600, height: 400, text, fontSize: 1000 });
    expect(r.success, json(r)).toBe(true); expect(r.data.results).toEqual([{ itemId: 'target', applied: { width: 600, height: 300, fontSize: fitted }, ignored: { height: PROPORTIONS, fontSize: SELF_SIZED } }]);
    expect(r.message).toBe(`Updated 1 item atomically. ${sizeSentence('target', fitted, 1000)}`);
  });
});

describe('RC 6.3 / lane A: refused edits are atomic at the public agent-tool/bus boundary', () => {
  function check(items: RecordData[], properties: RecordData, ids: string[], code: string, error?: string) {
    const doc = base(); doc.rev = 17; doc.items.push(...items); const w = world(doc);
    // Keep real existing history on both sides, so a refusal must preserve it rather than merely leave empty stacks.
    expect(edit(w, { zIndex: 3 }, ids[0]).success).toBe(true); expect(edit(w, { blendMode: 'multiply' }, ids[0]).success).toBe(true); w.bus.undo();
    expect(w.bus.undoStack).toHaveLength(1); expect(w.bus.redoStack).toHaveLength(1);
    const before = structuredClone({ doc: w.doc, undo: w.bus.undoStack, redo: w.bus.redoStack, journal: w.journal }), result = edit(w, properties, ids);
    expect(result).toMatchObject({ success: false, code, ...(error ? { error } : {}) }); expect(result.timelineChanges).toBeUndefined();
    expect(w.doc).toEqual(before.doc); expect(w.doc.rev).toBe(17); expect(w.bus.undoStack).toEqual(before.undo); expect(w.bus.redoStack).toEqual(before.redo); expect(w.journal).toEqual(before.journal);
  }
  it('valid image-element colours plus bad width leave document, revision and both history stacks unchanged', () => {
    check([elementItem('sticker-star')], { colors: ['#123456'], width: 0 }, ['target'], 'INVALID_PROPERTY_VALUE', "An element's width and height must be positive.");
  });
  it('a later refused batch target rolls back the earlier target, including its valid colours and media', () => {
    check([elementItem('phone-frame', 'first'), elementItem('split-frame', 'second')], { colors: ['#123456'], media: ['asset-img1', 'missing'] }, ['first', 'second'], 'MEDIA_NOT_FOUND', 'Media asset not found');
  });
  it('a refused trigger-key call on the agent refit path leaves text, box, font size, revision and history unchanged', () => {
    const item = elementItem('label-tag'); item.details.text = 'Before';
    check([item], { colors: ['#123456'], width: 600, text: 'After', fontFamily: 'No Such Refit Font' }, ['target'], 'FONT_NOT_FOUND');
  });
});

describe('S3 editProperties target eligibility, locked tracks and batch atomicity', () => {
  for (const type of ['image', 'text']) for (const key of ['colors', 'media']) it(`${key} on one non-element ${type}: NOT_AN_ELEMENT with the text-colour hint only when relevant`, () => {
    const ordinary = mkItem('ordinary', type === 'text' ? 'O1' : 'V1', 0, 3000, { type, details: type === 'text' ? { text: 'Hi' } : {} });
    const w = withItems(ordinary), before = json(w.doc), r = edit(w, { [key]: [] }, 'ordinary');
    refused(w, before, r, 'NOT_AN_ELEMENT');
    expect(r.error).toBe("Item 'ordinary' is not a built-in element; colors, media and element size apply to elements only." + (type === 'text' && key === 'colors' ? ' Text colour is `color`.' : ''));
  });
  it.each(['colors', 'media'])('a non-element in a batch gets ignored.%s instead of refusing the eligible element', key => {
    const w = withItems(elementItem(key === 'media' ? 'phone-frame' : 'sticker-star'), mkItem('ordinary', 'V2', 0, 3000, { type: 'image' }));
    const r = edit(w, { [key]: key === 'media' ? ['asset-img1'] : ['#123456'] }, ['target', 'ordinary']);
    expect(r.success, json(r)).toBe(true); expect(r.data.results.find((row: RecordData) => row.itemId === 'ordinary')).toMatchObject({ ignored: { [key]: 'not a built-in element' } });
  });
  it.each(['label-tag', 'sticker-star'])('%s has the correct ELEMENT_HAS_NO_MEDIA sentence; batch records the same ignored.media', id => {
    const e = findElement(id)!, message = id === 'label-tag' ? `${e.name} holds text, not media. Set its text instead.` : `${e.name} has no openings for media.`;
    const one = withItems(elementItem(id)), before = json(one.doc), r = edit(one, { media: ['asset-img1'] });
    refused(one, before, r, 'ELEMENT_HAS_NO_MEDIA'); expect(r.error).toBe(message);
    const batch = withItems(elementItem(id, 'no-media'), elementItem('phone-frame', 'frame'));
    const result = edit(batch, { media: ['asset-img1'] }, ['no-media', 'frame']);
    expect(result.success, json(result)).toBe(true); expect(result.data.results.find((row: RecordData) => row.itemId === 'no-media')).toMatchObject({ ignored: { media: message } });
    expect(itemOf(batch.doc, 'frame').details.cells[0].source.assetId).toBe('asset-img1');
  });
  it('a locked target refuses the whole batch before the other element can change', () => {
    const doc = base(); doc.tracks.find(t => t.id === 'O1')!.locked = true;
    doc.items.push(elementItem('sticker-star', 'first'), elementItem('label-tag', 'locked'));
    const w = world(doc), before = json(w.doc), r = edit(w, { colors: ['#123456'] }, ['first', 'locked']);
    refused(w, before, r, 'TRACK_LOCKED');
  });
  it('a later bad media asset rolls back an earlier valid element in the same batch', () => {
    const w = withItems(elementItem('phone-frame', 'first'), elementItem('split-frame', 'second')), before = json(w.doc);
    const r = edit(w, { media: ['asset-img1', 'missing'] }, ['first', 'second']);
    refused(w, before, r, 'MEDIA_NOT_FOUND');
  });
  it('a normal opacity edit on an element has no data.results and remains one Edit items undo', () => {
    const w = withItems(elementItem('sticker-star')), r = edit(w, { opacity: 0.5 });
    expect(r.success, json(r)).toBe(true); expect(r.data).not.toHaveProperty('results');
    expect(itemOf(w.doc, 'target').properties.opacity).toEqual(prop(0.5)); expect(w.bus.labels()).toEqual(['Edit items']);
  });
});
