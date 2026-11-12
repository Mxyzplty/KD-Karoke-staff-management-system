// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 3: addMedia and editProperties through callTool, with our own ToolContext and asset lookup.
// Oracle: T22 notes Step 3 interfaces (01:33, overridden at 01:38), findings part 2 §33, plan S3,
// error rows 101/102/105/143/144 and tool results addMedia / editProperties normal path. The newer notes retain
// per-item failure codes (unlike the older captured envelope). Expected geometry comes from §33, not place.ts/edit.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import { CommandBus } from '../apps/web/src/timeline/bus';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext, ToolResult } from '../apps/web/src/timeline/tools';
import { findElement } from '../apps/web/src/catalogue/elements';
import { findSound } from '../apps/web/src/catalogue/sounds';
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
  const properties = { positionX: 37, positionY: 83, width: e.width, height: e.height, scale: 1, rotation: 0, opacity: 1 };
  const details: RecordData = { name: e.name, element: { id, palette: structuredClone(e.palette), ...(e.stretch ? { stretch: true } : {}) } };
  if (e.slot?.kind === 'text') {
    const b = e.slot.box;
    Object.assign(properties, { positionX: 37 + b.x * e.width, positionY: 83 + b.y * e.height, width: b.width * e.width, height: b.height * e.height });
    Object.assign(details, { text: '', fontFamily: 'Manrope Bold', fontFamilyDisplay: 'Manrope' }); details.element.slot = 'text';
  } else if (e.slot?.kind === 'media') {
    details.element.slot = 'media';
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

describe('editProperties element size: proportion, width priority, stretch and text origin', () => {
  it.each([{ width: 200 }, { height: 200 }, { width: 200, height: 400 }])('non-stretch star %j stays square, width wins', properties => {
    const w = withItems(elementItem('sticker-star')), r = edit(w, properties);
    expect(r.success, json(r)).toBe(true); expect(drawnSize(itemOf(w.doc, 'target'))).toEqual({ width: 200, height: 200 });
    expect(itemOf(w.doc, 'target').properties.positionX).toEqual(prop(37)); expect(itemOf(w.doc, 'target').properties.positionY).toEqual(prop(83));
    if ('width' in properties && 'height' in properties) expectElementNote(r, 'sticker-star', /proportion|aspect/i);
  });
  it('stretch sets both dimensions independently', () => {
    const w = withItems(elementItem('underline-scribble')), r = edit(w, { width: 300, height: 75 });
    expect(r.success, json(r)).toBe(true); expect(drawnSize(itemOf(w.doc, 'target'))).toEqual({ width: 300, height: 75 });
  });
  it.each(['width', 'height'])('text-slot %s resize keeps element origin (37,83), not the old text-slot origin', key => {
    const w = withItems(elementItem('label-tag')), r = edit(w, { [key]: key === 'width' ? 360 : 120 });
    // Whole element 720×240 -> 360×120 at (37,83); slot 60/720,40/240,600/720,160/240 -> (67,103,300,80).
    expect(r.success, json(r)).toBe(true);
    expect(itemOf(w.doc, 'target').properties).toMatchObject(stored({ positionX: 67, positionY: 103, width: 300, height: 80 }));
  });
  for (const key of ['width', 'height']) it.each([0, -1, NaN, Infinity, -Infinity])(`${key} %s refuses INVALID_PROPERTY_VALUE without changes`, value => {
    const w = withItems(elementItem('sticker-star')), before = json(w.doc), r = edit(w, { [key]: value });
    refused(w, before, r, 'INVALID_PROPERTY_VALUE');
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
