// SPDX-License-Identifier: AGPL-3.0-only
// T04 agent tool handlers writeKeyframes, editProperties, setTimeRemap, written-spec oracle. Oracle: tool contracts (writeKeyframes entry shape,
// editProperties keys, setTimeRemap), tool results §2 (editProperties, setTimeRemap), §6 G-02 (value modes, §41 boundaries after whole-ms rounding,
// stored refusal text, speed ranges, merge), findings part 2 §38 / §41, error codes §6, requirements A0.3 (timelineChanges). Not tested here:
// INVALID_TOOL_INPUT and every handler code that Xapp's schema answers first (EMPTY_OPS, CONFLICTING_KEYFRAME_VALUE_MODES, INVALID_EASING,
// INVALID_KEYFRAMES, INVALID_KEYFRAME_TIME/VALUE): those are T18's.
// Provisional (undocumented, named `provisional` in the test): where `warnings` / `resolvedKeyframes` sit in the success envelope (both
// `data.*` and top level are accepted); the `[<path>]` prefix of writeKeyframes messages (not asserted); USE_SET_TIME_REMAP for `add` on
// `timeRemap`; ITEM_NOT_FOUND for writeKeyframes; undo labels of setTimeRemap and playbackRate edits; the playbackRate growth message wording;
// playbackRate on a non-media item; the codes of `properties is required` / `Provide itemId …`.
// Expected to be RED until the P2 handlers land (a missing tool answers UNKNOWN_TOOL).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { changeSpeed, remapOff, remapOn } from '../apps/web/src/timeline/edits';
import { keyframesBlock, sourceTime, valueAt } from '../apps/web/src/timeline/properties';
import { assets, build, itemOf, links, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => { useIds(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-23T08:00:00.000Z')); });
afterEach(() => { resetIds(); vi.useRealTimers(); });
type Editor = ReturnType<typeof createEditor>;
const editor = (doc: ProjectDocument = base()) => createEditor(doc, { assets: assets(), links: links() });
const call = (e: Editor, name: string, args: Record<string, unknown>): any => e.call(name, args);
const json = (d: unknown) => JSON.stringify(d);
const kf = (time: number, value: unknown, easing: any = 'linear') => ({ id: `k${time}`, time, value, easing });
const prop = (keyframes: any[], defaultValue: unknown = 0) => ({ defaultValue, keyframes });
/** S1 stand-in: video `vid` 0–10 s, trim 0–10 s, rate 1; audio `aud`; text `txt`. */
const base = (): ProjectDocument => build({
  tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('O1', 'overlay')],
  items: [video('vid', 'V1', 0, 10000, 0, 10000), mkItem('aud', 'A1', 0, 5000, { type: 'audio', trim: { from: 0, to: 5000 }, sourceDuration: 8000, metadata: { assetId: 'asset-aud1' } }),
    mkItem('txt', 'O1', 0, 4000, { type: 'text', details: { text: 'Hi' } })],
});
const withVid = (patch: Record<string, unknown>) => { const d = base(); Object.assign(itemOf(d, 'vid'), patch); return d; };
const bw = (...ks: any[]) => withVid({ properties: { borderWidth: prop(ks, 0) } });
const wk = (e: Editor, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => call(e, 'writeKeyframes', { itemId: 'vid', payload, ...extra });
const stored = (e: Editor, key: string, id = 'vid') => itemOf(e.doc, id).properties[key].keyframes as any[];
const times = (e: Editor, key = 'borderWidth') => stored(e, key).map(k => k.time);
const flat = (x: any): any[] => x === undefined ? [] : Array.isArray(x) ? x : Object.values(x).flat() as any[];
const warnings = (r: any): string[] => r.data?.warnings ?? r.warnings ?? [];
const resolved = (r: any) => flat(r.data?.resolvedKeyframes ?? r.resolvedKeyframes);
const only = (e: Editor, label: string) => { expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label, source: 'agent' }); expect(e.journal).toHaveLength(1); };
/** A refusal changes nothing: same document bytes, no undo entry, no journal row, no timelineChanges. */
const refused = (e: Editor, before: string, r: any, code: string) => {
  expect(r).toMatchObject({ success: false, code }); expect(r.timelineChanges).toBeUndefined();
  expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
};
const bez = (x1: number, y1: number, x2: number, y2: number, x: number) => {
  const B = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t * t + t ** 3;
  let lo = 0, hi = 1; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (B(x1, x2, m) < x) lo = m; else hi = m; }
  return B(y1, y2, (lo + hi) / 2);
};

describe('writeKeyframes: storage, value modes and time mapping (contracts; G-02; findings part 2 §38)', () => {
  it('G-02 value modes on positionY (0 → 400 over 0–8 s, linear): value, delta, factor and hold', () => {
    const e = editor();
    expect(wk(e, { positionY: { replace: [{ time: 0, value: 0 }, { time: 8, value: 400 }] } }).success).toBe(true);
    expect(wk(e, { positionY: { add: [{ time: 1, value: 100 }] } }).success).toBe(true);
    expect(wk(e, { positionY: { add: [{ time: 3, delta: 50 }] } }).success).toBe(true);
    expect(wk(e, { positionY: { add: [{ time: 5, factor: 0.5 }] } }).success).toBe(true);
    expect(wk(e, { positionY: { add: [{ time: 7 }] } }).success).toBe(true);
    const got = Object.fromEntries(stored(e, 'positionY').map(k => [k.time, k.value]));
    expect(got[1000]).toBe(100); expect(got[3000]).toBeCloseTo(235.71428571428572, 9); expect(got[5000]).toBeCloseTo(150.71428571428572, 9); expect(got[7000]).toBeCloseTo(316.9047619047619, 9);
    expect(times(e, 'positionY')).toEqual([0, 8000, 1000, 3000, 5000, 7000]); // add appends (findings part 2 §41 l.569–571)
  });
  it('a hold on a property with no keyframes captures its static value; delta / factor start from it', () => {
    const e = editor();
    wk(e, { opacity: { add: [{ time: 2 }] } }); expect(stored(e, 'opacity')[0].value).toBe(1);
    wk(e, { positionY: { add: [{ time: 2, delta: 50 }] } }); expect(stored(e, 'positionY')[0].value).toBe(50);
  });
  it('stores each keyframe with a stored id kf_<epoch ms>_<9 chars>, its outgoing easing (default linear) and the property in the stored shape', () => {
    const e = editor();
    wk(e, { opacity: { replace: [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 2, value: 1 }] } });
    const ks = stored(e, 'opacity');
    expect(ks.map(k => [k.time, k.value, k.easing])).toEqual([[0, 0, 'easeInOut'], [2000, 1, 'linear']]);
    for (const k of ks) expect(k.id).toMatch(/^kf_1792742400000_.{9}$/);
    expect(itemOf(e.doc, 'vid').properties.opacity.defaultValue).toBe(1);
  });
  it('a bezier handle pair is stored as easing linear with outHandle on the earlier and inHandle on the later keyframe, and drives the curve', () => {
    const e = editor();
    wk(e, { positionX: { replace: [{ time: 0, value: 0, outHandle: [0.25, 0.1] }, { time: 4, value: 10, inHandle: [0.25, 1] }] } });
    const [a, b] = stored(e, 'positionX');
    expect(a).toMatchObject({ easing: 'linear', outHandle: [0.25, 0.1] }); expect(b).toMatchObject({ easing: 'linear', inHandle: [0.25, 1] });
    expect(valueAt(itemOf(e.doc, 'vid'), 'positionX', 2000)).toBeCloseTo(10 * bez(0.25, 0.1, 0.25, 1, 0.5), 6);
  });
  it('the replace list is stored sorted by time; replace [] clears the keyframes and the property reads its default again', () => {
    const e = editor();
    wk(e, { opacity: { replace: [{ time: 3, value: 0.2 }, { time: 1, value: 0.8 }] } }); expect(times(e, 'opacity')).toEqual([1000, 3000]);
    expect(wk(e, { opacity: { replace: [] } }).success).toBe(true);
    expect(stored(e, 'opacity')).toEqual([]); expect(valueAt(itemOf(e.doc, 'vid'), 'opacity', 2000)).toBe(1);
  });
  it('properties not named are untouched; the call is one "Edit items" agent step with a timelineChanges entry for the item', () => {
    const e = editor(withVid({ properties: { scale: prop([kf(0, 1), kf(1000, 2)], 1) } })), before = json(itemOf(e.doc, 'vid').properties.scale);
    const r = wk(e, { opacity: { add: [{ time: 1, value: 0.5 }] } });
    expect(r.success).toBe(true); expect(json(itemOf(e.doc, 'vid').properties.scale)).toBe(before);
    only(e, 'Edit items');
    expect(r.timelineChanges.items.updated).toHaveLength(1);
    expect(r.timelineChanges.items.updated[0]).toMatchObject({ itemId: 'vid' }); expect(r.timelineChanges.items.updated[0].changedFields).toContain('properties.opacity');
  });
  it('tool times are timeline seconds, stored at trim.from + (time − item start) × rate: start 1 s, trim from 2 s, rate 2 → 3 s lands at 6,000 ms; the keyframes block reads it back as 3 s', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('late', 'V1', 1000, 5000, 2000, 20000, { playbackRate: 2, trim: { from: 2000, to: 10000 } })] });
    const e = editor(doc);
    expect(call(e, 'writeKeyframes', { itemId: 'late', payload: { opacity: { add: [{ time: 3, value: 0.5 }] } } }).success).toBe(true);
    expect(stored(e, 'opacity', 'late').map(k => k.time)).toEqual([6000]);
    expect(keyframesBlock(itemOf(e.doc, 'late')).keyframes!.opacity.keyframes[0].timelineSeconds).toBe(3);
  });
  it('the echo lists each resolved keyframe as { time, value, source } with the requested time unrounded (G-02)', () => {
    const e = editor(), r = wk(e, { opacity: { add: [{ time: 1.003999, value: 0.5 }] } });
    expect(resolved(r)).toHaveLength(1); expect(resolved(r)[0]).toMatchObject({ time: 1.003999, value: 0.5 }); expect(resolved(r)[0]).toHaveProperty('source');
    expect(resolved(r)[0]).not.toHaveProperty('easing');
  });
});

describe('writeKeyframes: §41 write rules after whole-millisecond rounding (findings part 2 §41; G-02 boundary outcomes)', () => {
  const run = (doc: ProjectDocument, op: Record<string, unknown>) => { const e = editor(doc); return { e, r: wk(e, { borderWidth: op }) }; };
  it.each([[1.003999, 1004], [3.004, 3004], [6.004001, 6004]])('add at %s s → rounded %i ms is 4 ms away: a NEW keyframe appended, no overwrite, no warning', (t, ms) => {
    const { e, r } = run(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3)), { add: [{ time: t, value: 9 }] });
    expect(r.success).toBe(true); expect(times(e)).toEqual([1000, 3000, 6000, ms]); expect(warnings(r)).toEqual([]); // appended at the end (§41)
  });
  it.each([[1.003, 1000], [1.0, 1000], [0.997, 1000]])('add at %s s is under 4 ms from the keyframe at %i: overwritten in place (id and time kept), with a warning', (t, at) => {
    const { e, r } = run(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3)), { add: [{ time: t, value: 9 }] });
    expect(r.success).toBe(true); expect(times(e)).toEqual([1000, 3000, 6000]);
    expect(stored(e, 'borderWidth').find(k => k.time === at)).toMatchObject({ id: `k${at}`, value: 9 });
    expect(warnings(r).join(' ')).toMatch(/replaced the keyframe already at that instant/);
  });
  it.each([[1.099999, 1100], [3.1, 3100], [6.100001, 6100]])('update at %s s (%i ms, 100 ms from the nearest keyframe): not under 100 ms, so a NEW keyframe is appended', (t, ms) => {
    const { e, r } = run(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3)), { update: [{ time: t, value: 9 }] });
    expect(r.success).toBe(true); expect(times(e)).toEqual([1000, 3000, 6000, ms]); // appended at the end (§41)
  });
  it('update 99 ms away overwrites the nearest keyframe (value replaced, time and id kept)', () => {
    const { e, r } = run(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3)), { update: [{ time: 1.099, value: 9 }] });
    expect(r.success).toBe(true); expect(times(e)).toEqual([1000, 3000, 6000]); expect(stored(e, 'borderWidth')[0]).toMatchObject({ id: 'k1000', time: 1000, value: 9 });
  });
  it('update 7.0625 s rounds to 7.063 s and overwrites the keyframe at 7.125 s (62 ms away), keeping its time', () => {
    const { e, r } = run(bw(kf(1000, 1), kf(7125, 4)), { update: [{ time: 7.0625, value: 9 }] });
    expect(r.success).toBe(true); expect(times(e)).toEqual([1000, 7125]); expect(stored(e, 'borderWidth')[1]).toMatchObject({ time: 7125, value: 9 });
  });
  it('update with two keyframes at equal distance: the first wins the tie (written-spec oracle §41; the tie was not exercised by G-02)', () => {
    const { e } = run(bw(kf(1000, 1), kf(1100, 2)), { update: [{ time: 1.05, value: 9 }] });
    expect(stored(e, 'borderWidth').map(k => [k.time, k.value])).toEqual([[1000, 9], [1100, 2]]);
  });
  it('update considers only keyframes that existed before the call: add 9.0 + update 9.05 in one call gives two new keyframes', () => {
    const { e, r } = run(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3)), { add: [{ time: 9, value: 5 }], update: [{ time: 9.05, value: 6 }] });
    expect(r.success).toBe(true); expect(times(e)).toEqual([1000, 3000, 6000, 9000, 9050]);
  });
  it.each([[1.099, [3000, 6000]], [3.0, [1000, 6000]]])('remove at %s s (under 100 ms) removes the matching keyframe', (t, left) => {
    const { e, r } = run(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3)), { remove: [t] });
    expect(r.success).toBe(true); expect(times(e)).toEqual(left);
  });
  it.each([1.099999, 3.1, 6.100001])('remove at %s s (exactly 100 ms away, the tolerance is strict) is refused with REMOVE_TIME_NOT_FOUND and nothing changes', t => {
    const e = editor(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3))), before = json(e.doc), r = wk(e, { borderWidth: { remove: [t] } });
    refused(e, before, r, 'REMOVE_TIME_NOT_FOUND');
  });
  it("the stored refusal text (G-02): error 'No keyframes at remove times' and the 3.1 s message with the available times", () => {
    const e = editor(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3))), r = wk(e, { borderWidth: { remove: [3.1] } });
    expect(r.error).toBe('No keyframes at remove times');
    expect(r.message).toBe("For 'borderWidth', no keyframes found at 3.1s (100ms tolerance). Available: 1.000s, 3.000s, 6.000s.");
  });
});

describe('writeKeyframes: refusals (error codes §6; G-02) leave the document, undo stack and journal untouched', () => {
  const props: [string, string, Record<string, unknown>, RegExp?][] = [
    ['KEYFRAME_VALUE_OUT_OF_RANGE', 'opacity above its max', { opacity: { add: [{ time: 1, value: 2 }] } }, /opacity must be at most 1, resolved to 2\./],
    ['KEYFRAME_VALUE_OUT_OF_RANGE', 'volume below its min', { volume: { add: [{ time: 1, value: -1 }] } }, /volume must be at least 0, resolved to -1\./],
    ['KEYFRAME_VALUE_OUT_OF_RANGE', 'a delta that resolves out of range', { opacity: { add: [{ time: 1, delta: 5 }] } }, /opacity must be at most 1, resolved to 6\./],
    ['INVALID_BEZIER_HANDLE', 'outHandle x above 1', { opacity: { add: [{ time: 1, value: 0.5, outHandle: [1.5, 0] }] } }, /must be \[x, y\] with x from 0 to 1 and y from -100 to 100\./],
    ['INVALID_BEZIER_HANDLE', 'inHandle y above 100', { opacity: { add: [{ time: 1, value: 0.5, inHandle: [0.5, 101] }] } }, /must be \[x, y\] with x from 0 to 1 and y from -100 to 100\./],
    ['TIME_OUT_OF_BOUNDS', 'a time past the item end', { opacity: { add: [{ time: 11, value: 0.5 }] } }, /outside item bounds \(0s - 10s\)/],
    ['PROPERTY_NOT_ON_TYPE', 'opacity on an audio item', { opacity: { add: [{ time: 1, value: 0.5 }] } }],
  ];
  it.each(props)('%s: %s', (code, _what, payload, msg) => {
    const e = editor(), before = json(e.doc), r = call(e, 'writeKeyframes', { itemId: code === 'PROPERTY_NOT_ON_TYPE' ? 'aud' : 'vid', payload });
    refused(e, before, r, code); if (msg) expect(r.message).toMatch(msg);
    if (code === 'PROPERTY_NOT_ON_TYPE') expect(r.error).toBe('Property not valid for item type');
  });
  it('handle boundaries x 0 / 1 and y −100 / 100 are accepted', () => {
    const e = editor(), r = wk(e, { opacity: { replace: [{ time: 0, value: 0, outHandle: [0, -100] }, { time: 2, value: 1, inHandle: [1, 100] }] } });
    expect(r.success).toBe(true);
  });
  it('volume on a text item is PROPERTY_NOT_ON_TYPE (it exists on video and audio only)', () => {
    const e = editor(), before = json(e.doc);
    refused(e, before, call(e, 'writeKeyframes', { itemId: 'txt', payload: { volume: { add: [{ time: 1, value: 1 }] } } }), 'PROPERTY_NOT_ON_TYPE');
  });
  it('a failing property in a multi-property call rolls everything back', () => {
    const e = editor(), before = json(e.doc);
    refused(e, before, wk(e, { opacity: { add: [{ time: 1, value: 0.5 }] }, scale: { add: [{ time: 1, value: 200 }] } }), 'KEYFRAME_VALUE_OUT_OF_RANGE');
  });
  it('provisional: `add` on timeRemap is USE_SET_TIME_REMAP (error "Use setTimeRemap for time remap keyframes")', () => {
    const e = editor(), before = json(e.doc), r = wk(e, { timeRemap: { add: [{ time: 1, value: 1000 }] } });
    refused(e, before, r, 'USE_SET_TIME_REMAP'); expect(r.error).toBe('Use setTimeRemap for time remap keyframes');
  });
  it('provisional: an unknown item is ITEM_NOT_FOUND', () => {
    const e = editor(), before = json(e.doc);
    refused(e, before, call(e, 'writeKeyframes', { itemId: 'nope', payload: { opacity: { add: [{ time: 1, value: 0.5 }] } } }), 'ITEM_NOT_FOUND');
  });
  // T10/T12 (C8 assertion-only edit): effect and mask targets are both served now, so each is refused by its own real error when the item has none.
  it('effectId the item lacks is refused EFFECT_NOT_FOUND (T10); maskIndex on an item with no masks is NO_MASKS (T12)', () => {
    for (const [extra, code, text] of [[{ effectId: 'vignette_1' }, 'EFFECT_NOT_FOUND', "Effect 'vignette_1' not on this item"], [{ maskIndex: 0 }, 'NO_MASKS', "No masks found on 'vid'."]] as const) {
      const e = editor(), before = json(e.doc), r = wk(e, { opacity: { add: [{ time: 1, value: 0.5 }] } }, extra);
      refused(e, before, r, code); expect(json(r)).toContain(text);
    }
  });
});

describe('editProperties (contracts; tool results §2 editProperties)', () => {
  it('writes the static value in the stored shape and reports changed fields in storage names, one "Edit items" agent step', () => {
    const e = editor(), r = call(e, 'editProperties', { itemId: 'vid', properties: { opacity: 0.5, volume: 2 } });
    expect(r.success).toBe(true);
    expect(itemOf(e.doc, 'vid').properties.opacity).toEqual({ defaultValue: 0.5, keyframes: [] }); expect(itemOf(e.doc, 'vid').properties.volume).toEqual({ defaultValue: 2, keyframes: [] });
    only(e, 'Edit items');
    expect(r.timelineChanges.items.updated).toHaveLength(1); expect(r.timelineChanges.items.updated[0].changedFields).toEqual(expect.arrayContaining(['properties.opacity', 'properties.volume']));
  });
  it('a batch is validated first and written atomically: message "Updated 2 items atomically", data.itemIds as given', () => {
    const doc = base(); doc.items.push(video('vid2', 'V1', 10000, 12000, 0, 10000));
    const e = editor(doc), r = call(e, 'editProperties', { itemIds: ['vid', 'vid2'], properties: { opacity: 0.25 } });
    expect(r.success).toBe(true); expect(r.message).toMatch(/^Updated 2 items atomically/); expect(r.data.itemIds).toEqual(['vid', 'vid2']);
    expect(itemOf(e.doc, 'vid').properties.opacity.defaultValue).toBe(0.25); expect(itemOf(e.doc, 'vid2').properties.opacity.defaultValue).toBe(0.25);
    only(e, 'Edit items');
  });
  it('one bad item in a batch changes nothing (INVALID_PROPERTY: volume is video and audio only)', () => {
    const e = editor(), before = json(e.doc), r = call(e, 'editProperties', { itemIds: ['vid', 'txt'], properties: { volume: 2 } });
    refused(e, before, r, 'INVALID_PROPERTY');
  });
  it('setting a property to its current value changes nothing: success, no timelineChanges, document identical', () => {
    const e = editor(), before = json(e.doc), r = call(e, 'editProperties', { itemId: 'vid', properties: { opacity: 1 } });
    expect(r.success).toBe(true); expect(r.timelineChanges).toBeUndefined(); expect(json(e.doc)).toBe(before);
  });
  it.each([
    ['opacity above its max', { opacity: 2 }, /opacity.*at most 1/i], ['opacity below its min', { opacity: -0.5 }, /opacity.*at least 0/i],
    ['volume above its max', { volume: 3.1 }, /volume.*at most 3/i], ['rotation above its max', { rotation: 361 }, /rotation.*at most 360/i],
    ['a non-finite number', { opacity: Number.NaN }, undefined], ['the wrong value type', { opacity: '0.5' }, undefined],
    ['playbackRate above 4', { playbackRate: 5 }, /playbackRate.*at most 4/i], ['playbackRate below 0.1', { playbackRate: 0.05 }, /playbackRate.*at least 0.1/i],
  ] as [string, Record<string, unknown>, RegExp | undefined][])('INVALID_PROPERTY_VALUE: %s', (_w, properties, msg) => {
    const e = editor(), before = json(e.doc), r = call(e, 'editProperties', { itemId: 'vid', properties });
    refused(e, before, r, 'INVALID_PROPERTY_VALUE'); if (msg) expect(json(r)).toMatch(msg);
  });
  it('unknown ids → ITEM_NOT_FOUND "Unknown item ID(s): <ids>"; missing arguments carry the documented error text', () => {
    const e = editor(), before = json(e.doc), r = call(e, 'editProperties', { itemId: 'nope', properties: { opacity: 0.5 } });
    refused(e, before, r, 'ITEM_NOT_FOUND'); expect(json(r)).toContain('Unknown item ID(s): nope');
    expect(call(e, 'editProperties', { itemId: 'vid' })).toMatchObject({ success: false, error: 'properties is required' });
    expect(call(e, 'editProperties', { properties: { opacity: 0.5 } })).toMatchObject({ success: false, error: 'Provide itemId (single) or itemIds (batch)' });
    expect(json(e.doc)).toBe(before);
  });
  it("provisional: codeless refusals carry T03's placeholder code MISSING_PARAM (results §1.4); an unknown item type is refused the same way", () => {
    const doc = base(); doc.items.push(mkItem('wid', 'O1', 5000, 6000, { type: 'widget' }));
    const e = editor(doc), before = json(e.doc);
    const a = call(e, 'editProperties', { itemId: 'vid' }); refused(e, before, a, 'MISSING_PARAM'); expect(a.error).toBe('properties is required');
    const b = call(e, 'editProperties', { properties: { opacity: 0.5 } }); refused(e, before, b, 'MISSING_PARAM'); expect(b.error).toBe('Provide itemId (single) or itemIds (batch)');
    const c = call(e, 'editProperties', { itemId: 'wid', properties: { opacity: 0.5 } }); refused(e, before, c, 'MISSING_PARAM'); expect(c.error).toBe('Unsupported item type: widget');
  });
  it('provisional: a playbackRate change keeps the start, sets the length to source span ÷ rate, keeps the trim, labels the step "Change speed" and reports the new span', () => {
    const e = editor(), r = call(e, 'editProperties', { itemId: 'vid', properties: { playbackRate: 2 } });
    expect(r.success).toBe(true);
    const it = itemOf(e.doc, 'vid');
    expect(it.playbackRate).toBe(2); expect(it.display).toEqual({ from: 0, to: 5000 }); expect(it.trim).toEqual({ from: 0, to: 10000 });
    expect(r.message).toMatch(/'vid' at 2× now spans 0–5s \(it ended at 10s\); later clips did not move\./); only(e, 'Change speed');
  });
  it('provisional: playbackRate on a text item is INVALID_PROPERTY (video and audio only)', () => {
    const e = editor(), before = json(e.doc);
    refused(e, before, call(e, 'editProperties', { itemId: 'txt', properties: { playbackRate: 2 } }), 'INVALID_PROPERTY');
  });
});

describe('setTimeRemap (contracts; tool results §2 setTimeRemap; findings part 2 §38; G-02)', () => {
  const g02 = [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 5, value: 8000, easing: { type: 'bezier', points: [0.25, 0.1, 0.25, 1] } }, { time: 10, value: 2000 }];
  const remap = (e: Editor, keyframes: unknown, extra: Record<string, unknown> = {}) => call(e, 'setTimeRemap', { itemId: 'vid', keyframes, ...extra });
  it('G-02 curve: success message, data fields and speed range 0.000×–2.759×; stored item-relative in ms with values in source ms', () => {
    const e = editor(), r = remap(e, g02);
    expect(r.success).toBe(true);
    expect(r.message).toBe("Set 3 time remap keyframes on 'vid' (replaced). Speed range: 0.000x – 2.759x.");
    expect(r.data).toEqual({ itemId: 'vid', mode: 'replace', keyframesSet: 3, totalKeyframesInTrack: 3, clipDuration: 10, sourceDuration: 10, speedRange: { min: 0, max: 2.759 } });
    expect(itemOf(e.doc, 'vid').timeRemap.keyframes.map((k: any) => [k.time, k.value])).toEqual([[0, 0], [5000, 8000], [10000, 2000]]);
    expect(itemOf(e.doc, 'vid').timeRemap.keyframes.map((k: any) => k.easing)).toEqual(['easeInOut', { type: 'bezier', points: [0.25, 0.1, 0.25, 1] }, 'linear']);
  });
  it('times are timeline seconds stored relative to the item start (item at 2 s: 3 s → 1,000 ms) and the curve is listed under keyframes.timeRemap in absolute seconds', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('late', 'V1', 2000, 12000, 0, 10000)] }), e = editor(doc);
    expect(call(e, 'setTimeRemap', { itemId: 'late', keyframes: [{ time: 2, value: 0 }, { time: 3, value: 500 }] }).success).toBe(true);
    expect(itemOf(e.doc, 'late').timeRemap.keyframes.map((k: any) => k.time)).toEqual([0, 1000]);
    expect(keyframesBlock(itemOf(e.doc, 'late')).keyframes!.timeRemap.keyframes.map(k => k.timelineSeconds)).toEqual([2, 3]);
  });
  it('merge (replace: false): a keyframe within 100 ms of an existing one updates it in place (time kept, value replaced, easing replaced by the default linear); speed range 0.001×–2.931×', () => {
    const e = editor(); remap(e, g02);
    const r = remap(e, [{ time: 5.05, value: 8500 }], { replace: false });
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/^Set 1 time remap keyframes on 'vid' \(merged\)\. Speed range: 0\.001x – 2\.931x\./);
    expect(r.data).toMatchObject({ mode: 'merge', keyframesSet: 1, totalKeyframesInTrack: 3, speedRange: { min: 0.001, max: 2.931 } });
    expect(itemOf(e.doc, 'vid').timeRemap.keyframes.map((k: any) => [k.time, k.value, k.easing])).toEqual([[0, 0, 'easeInOut'], [5000, 8500, 'linear'], [10000, 2000, 'linear']]);
  });
  it('merge: a keyframe 150 ms from the nearest is inserted in time order; with no existing curve a merge behaves like replace', () => {
    const e = editor(); remap(e, g02);
    expect(remap(e, [{ time: 5.15, value: 8100 }], { replace: false }).data.totalKeyframesInTrack).toBe(4);
    expect(itemOf(e.doc, 'vid').timeRemap.keyframes.map((k: any) => k.time)).toEqual([0, 5000, 5150, 10000]);
    const fresh = editor(), r = remap(fresh, [{ time: 0, value: 0 }, { time: 10, value: 10000 }], { replace: false });
    expect(r.success).toBe(true); expect(r.data).toMatchObject({ mode: 'merge', totalKeyframesInTrack: 2 });
  });
  it('a value beyond the source is accepted with the clamp warning; speed range 0.000×–1.200× (the clamped tail has speed 0); the message ends with the warnings', () => {
    const e = editor(), r = remap(e, [{ time: 0, value: 0 }, { time: 10, value: 12000 }]);
    expect(r.success).toBe(true); expect(r.data.speedRange).toEqual({ min: 0, max: 1.2 });
    expect(r.data.warnings).toEqual(['Keyframe at 10s maps to source 12000ms but source duration is only 10000ms. The value will be clamped during playback.'].map(() => expect.stringMatching(/maps to source 12000ms but source duration is only 10000ms\. The value will be clamped during playback\./)));
    expect(r.message).toMatch(/Speed range: 0\.000x – 1\.200x\. Warnings: /);
  });
  it('no warnings → no data.warnings field', () => { const e = editor(); expect(remap(e, [{ time: 0, value: 0 }, { time: 10, value: 10000 }]).data).not.toHaveProperty('warnings'); });
  it('TIME_OUT_OF_BOUNDS: a keyframe time outside the clip (10 ms tolerance) names the clip bounds', () => {
    for (const t of [15, 10.02]) {
      const e = editor(), before = json(e.doc), r = remap(e, [{ time: 0, value: 0 }, { time: t, value: 100 }]);
      refused(e, before, r, 'TIME_OUT_OF_BOUNDS'); expect(r.message).toMatch(/outside clip bounds \(0\.000s – 10\.000s\)/);
    }
  });
  it('INVALID_ITEM_TYPE for a text item; ITEM_NOT_FOUND for an unknown item; both change nothing', () => {
    const e = editor(), before = json(e.doc);
    refused(e, before, call(e, 'setTimeRemap', { itemId: 'txt', keyframes: [{ time: 0, value: 0 }] }), 'INVALID_ITEM_TYPE');
    refused(e, before, call(e, 'setTimeRemap', { itemId: 'nope', keyframes: [{ time: 0, value: 0 }] }), 'ITEM_NOT_FOUND');
  });
  it('audio items accept a time remap (findings part 3 §46.6, Audio row: "setTimeRemap accepts audio")', () => {
    const e = editor(), r = call(e, 'setTimeRemap', { itemId: 'aud', keyframes: [{ time: 0, value: 0 }, { time: 5, value: 5000 }] });
    expect(r.success).toBe(true); expect(itemOf(e.doc, 'aud').timeRemap.keyframes).toHaveLength(2);
  });
  it('provisional: one agent step labelled "Edit items" with a timelineChanges entry', () => {
    const e = editor(), r = remap(e, g02);
    only(e, 'Edit items'); expect(r.timelineChanges.items.updated).toHaveLength(1);
  });
});

// ---- Batch 2a: ordering (findings part 2 §41 l.569–571), remaining codes and strings, change speed, remap on / off.
describe('writeKeyframes: stored order (findings part 2 §41 l.569–571: replace sorted; add / unmatched update append; overwrite keeps place; remove keeps order)', () => {
  const stamp = (e: Editor) => stored(e, 'borderWidth').map(k => [k.id, k.time]);
  it('replace with out-of-order input is stored sorted by time', () => {
    const e = editor(); wk(e, { borderWidth: { replace: [{ time: 6, value: 3 }, { time: 1, value: 1 }, { time: 3, value: 2 }] } });
    expect(times(e)).toEqual([1000, 3000, 6000]);
  });
  it('an add after the end of the list and an add before it both append (stored order is call order)', () => {
    const e = editor(bw(kf(1000, 1), kf(6000, 3))); wk(e, { borderWidth: { add: [{ time: 8, value: 4 }, { time: 0.5, value: 5 }] } });
    expect(times(e)).toEqual([1000, 6000, 8000, 500]);
  });
  it('G-02: an update at 1.1 s that matches nothing (exactly 100 ms from 1 s) is stored AFTER the 6 s keyframe', () => {
    const e = editor(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3))); wk(e, { borderWidth: { update: [{ time: 1.1, value: 9 }] } });
    expect(times(e)).toEqual([1000, 3000, 6000, 1100]);
  });
  it('an add overwrite (under 4 ms) in the middle of the list keeps its index, id and time', () => {
    const e = editor(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3))), before = stamp(e); wk(e, { borderWidth: { add: [{ time: 3.002, value: 9 }] } });
    expect(stamp(e)).toEqual(before); expect(stored(e, 'borderWidth')[1].value).toBe(9);
  });
  it('an update overwrite (under 100 ms) in the middle of the list keeps its index, id and time', () => {
    const e = editor(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3))), before = stamp(e); wk(e, { borderWidth: { update: [{ time: 3.09, value: 9 }] } });
    expect(stamp(e)).toEqual(before); expect(stored(e, 'borderWidth')[1].value).toBe(9);
  });
  it('remove keeps the order of the keyframes that are left', () => {
    const e = editor(bw(kf(6000, 3), kf(1000, 1), kf(3000, 2), kf(8000, 4))); wk(e, { borderWidth: { remove: [1] } });
    expect(times(e)).toEqual([6000, 3000, 8000]);
  });
  it('in one call the ops run replace → add → update (pre-existing ids only) → remove; the replaced keyframes are new, so the update appends', () => {
    const e = editor(bw(kf(1000, 1), kf(3000, 2)));
    const r = wk(e, { borderWidth: { replace: [{ time: 2, value: 5 }], add: [{ time: 4, value: 6 }], update: [{ time: 2.05, value: 7 }], remove: [4] } });
    expect(r.success).toBe(true); expect(stored(e, 'borderWidth').map(k => [k.time, k.value])).toEqual([[2000, 5], [2050, 7]]);
  });
  it('provisional: the resolved echo is keyed by property with source value / delta / factor / hold', () => {
    const e = editor(bw(kf(0, 2), kf(10000, 12)));
    const r = wk(e, { borderWidth: { add: [{ time: 1, value: 4 }, { time: 2, delta: 1 }, { time: 3, factor: 2 }, { time: 5 }] } });
    expect(r.data.resolvedKeyframes.borderWidth.map((x: any) => [x.time, x.source])).toEqual([[1, 'value'], [2, 'delta'], [3, 'factor'], [5, 'hold']]);
  });
  it('provisional: success wording "Keyframes written on \'vid\': borderWidth (2)." with data.keyframes as the keyframes block entry (stored order, timeline seconds)', () => {
    const e = editor(), r = wk(e, { borderWidth: { replace: [{ time: 2, value: 4 }, { time: 1, value: 2 }] } });
    expect(r.message).toBe("Keyframes written on 'vid': borderWidth (2).");
    expect(r.data).toMatchObject({ itemId: 'vid', keyframes: { borderWidth: { defaultValue: 0, keyframeCount: 2, keyframes: [{ timelineSeconds: 1, value: 2 }, { timelineSeconds: 2, value: 4 }] } } });
  });
  it('provisional: a property left empty reports { defaultValue, keyframeCount: 0, keyframes: [] }; {timeRemap:{replace:[]}} clears the curve to null', () => {
    const doc = bw(kf(1000, 1)); Object.assign(itemOf(doc, 'vid'), { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(5000, 5000)] } });
    const e = editor(doc), r = wk(e, { borderWidth: { replace: [] }, timeRemap: { replace: [] } });
    expect(r.success).toBe(true); expect(r.data.keyframes.borderWidth).toEqual({ defaultValue: 0, keyframeCount: 0, keyframes: [] }); expect(r.data.keyframes.timeRemap).toEqual({ defaultValue: 0, keyframeCount: 0, keyframes: [] });
    expect(itemOf(e.doc, 'vid').timeRemap ?? null).toBeNull();
  });
});

describe('writeKeyframes: remaining refusals (error codes §6; provisional where the wording is Cutframe\'s own)', () => {
  const fresh = () => { const e = editor(), before = json(e.doc); return { e, before }; };
  it('PROPERTY_NOT_ON_TYPE message: "\'<p>\' does not exist on <type> items. Keyframeable properties on <type> items: <list>." (provisional wording)', () => {
    const { e, before } = fresh(), r = call(e, 'writeKeyframes', { itemId: 'aud', payload: { opacity: { add: [{ time: 1, value: 0.5 }] } } });
    refused(e, before, r, 'PROPERTY_NOT_ON_TYPE'); expect(r.message).toMatch(/^'opacity' does not exist on audio items\. Keyframeable properties on audio items: volume\./);
  });
  it('PROPERTY_NOT_ANIMATABLE: a fixed size on text (width), and a registry key outside the 15 (flipX on video); provisional wording', () => {
    const { e, before } = fresh();
    const a = call(e, 'writeKeyframes', { itemId: 'txt', payload: { width: { add: [{ time: 1, value: 10 }] } } });
    refused(e, before, a, 'PROPERTY_NOT_ANIMATABLE'); expect(a.error).toBe('Property not animatable'); expect(a.message).toMatch(/^'width' cannot be keyframed on text items\. Keyframeable properties on text items: /);
    const b = wk(e, { flipX: { add: [{ time: 1, value: 1 }] } });
    refused(e, before, b, 'PROPERTY_NOT_ANIMATABLE'); expect(b.message).toMatch(/^'flipX' cannot be keyframed on video items\. Keyframeable properties on video items: /);
  });
  it('INVALID_PROPERTY: a name that is not a keyframeable property at all; the message lists the 15 (provisional wording)', () => {
    const { e, before } = fresh(), r = wk(e, { bogus: { add: [{ time: 1, value: 1 }] } });
    refused(e, before, r, 'INVALID_PROPERTY'); expect(r.error).toBe('Invalid property');
    expect(r.message).toBe("'bogus' is not a keyframeable property. Keyframeable item properties: opacity, scale, rotation, positionX, positionY, width, height, blur, brightness, borderRadius, borderWidth, volume, fillOpacity, strokeWidth, strokeOpacity.");
  });
  it('EMPTY_OPS: error "No ops provided", message "No ops provided for \'<p>\'." (error codes §6)', () => {
    const { e, before } = fresh(), r = wk(e, { opacity: {} });
    refused(e, before, r, 'EMPTY_OPS'); expect(r.error).toBe('No ops provided'); expect(r.message).toBe("No ops provided for 'opacity'.");
  });
  it('CONFLICTING_KEYFRAME_VALUE_MODES: message with the entry path (error codes §6)', () => {
    const { e, before } = fresh(), r = wk(e, { opacity: { add: [{ time: 1, value: 0.5, delta: 0.1 }] } });
    refused(e, before, r, 'CONFLICTING_KEYFRAME_VALUE_MODES'); expect(r.message).toBe('[opacity.add[0]] provide at most one of value, delta, or factor. Omit all three to capture the current interpolated value.');
  });
  it.each([['value', 'INVALID_KEYFRAME_VALUE'], ['delta', 'INVALID_KEYFRAME_DELTA'], ['factor', 'INVALID_KEYFRAME_FACTOR']])('%s that is not a finite number → %s', (mode, code) => {
    const { e, before } = fresh(), r = wk(e, { opacity: { add: [{ time: 1, [mode]: 'x' }] } });
    refused(e, before, r, code); expect(r.message).toContain('[opacity.add[0]]');
  });
  it.each([-1, 'x', null])('INVALID_KEYFRAME_TIME for time %j (add) and for a bad remove time', t => {
    const { e, before } = fresh();
    refused(e, before, wk(e, { opacity: { add: [{ time: t, value: 0.5 }] } }), 'INVALID_KEYFRAME_TIME');
    refused(e, before, wk(e, { opacity: { remove: [t] } }), 'INVALID_KEYFRAME_TIME');
  });
  it('INVALID_EASING lists the options; INVALID_BEZIER_HANDLE names the entry path (error codes §6)', () => {
    const { e, before } = fresh(), r = wk(e, { opacity: { add: [{ time: 1, value: 0.5, easing: 'wobble' }] } });
    refused(e, before, r, 'INVALID_EASING'); expect(r.message).toMatch(/^\[opacity\.add\[0\]\] easing 'wobble' not valid\. Options: /);
    const h = wk(e, { opacity: { update: [{ time: 1, value: 0.5, outHandle: [2, 0] }] } });
    refused(e, before, h, 'INVALID_BEZIER_HANDLE'); expect(h.message).toBe('[opacity.update[0]] outHandle must be [x, y] with x from 0 to 1 and y from -100 to 100.');
  });
  it('INVALID_RESOLVED_KEYFRAME_VALUE: a factor that overflows to a non-finite value (message names the entry path)', () => {
    const e = editor(withVid({ properties: { positionY: prop([], 1e300) } })), before = json(e.doc);
    const r = wk(e, { positionY: { add: [{ time: 1, factor: 1e10 }] } });
    refused(e, before, r, 'INVALID_RESOLVED_KEYFRAME_VALUE'); expect(r.message).toBe('[positionY.add[0]] positionY resolved to a non-finite value.');
  });
  it('TIME_OUT_OF_BOUNDS exact message: "[<path>] keyframe at <t>s outside item bounds (<a>s - <b>s)." with the item bounds in timeline seconds', () => {
    const { e, before } = fresh(), r = wk(e, { opacity: { add: [{ time: 11, value: 0.5 }] } });
    refused(e, before, r, 'TIME_OUT_OF_BOUNDS'); expect(r.message).toBe('[opacity.add[0]] keyframe at 11s outside item bounds (0s - 10s).');
  });
  it('provisional: payload missing, empty or not an object → MISSING_PARAM "payload is required"', () => {
    for (const payload of [undefined, {}, [], 'x']) { const { e, before } = fresh(), r = call(e, 'writeKeyframes', { itemId: 'vid', payload }); refused(e, before, r, 'MISSING_PARAM'); expect(r.error).toBe('payload is required'); }
  });
  it('provisional (own wording): ITEM_NOT_FOUND carries error "Item not found" and message "Item \'<id>\' not found on timeline."', () => {
    const { e, before } = fresh(), r = call(e, 'writeKeyframes', { itemId: 'nope', payload: { opacity: { add: [{ time: 1, value: 0.5 }] } } });
    refused(e, before, r, 'ITEM_NOT_FOUND'); expect(r.error).toBe('Item not found'); expect(r.message).toBe("Item 'nope' not found on timeline.");
  });
  it('provisional: USE_SET_TIME_REMAP message starts "Time remap keyframes are written with setTimeRemap"; update / remove / non-empty replace on timeRemap are refused the same way', () => {
    for (const ops of [{ add: [{ time: 1, value: 1000 }] }, { update: [{ time: 1, value: 1000 }] }, { remove: [1] }, { replace: [{ time: 1, value: 1000 }] }]) {
      const { e, before } = fresh(), r = wk(e, { timeRemap: ops }); refused(e, before, r, 'USE_SET_TIME_REMAP'); expect(r.message).toMatch(/^Time remap keyframes are written with setTimeRemap/);
    }
  });
  it('REMOVE_TIME_NOT_FOUND: "Available: none." on an empty property; provisional: Available lists the curve as it is after the call\'s add / update ops', () => {
    const { e, before } = fresh(), r = wk(e, { opacity: { remove: [1] } });
    refused(e, before, r, 'REMOVE_TIME_NOT_FOUND'); expect(r.message).toBe("For 'opacity', no keyframes found at 1s (100ms tolerance). Available: none.");
    const e2 = editor(bw(kf(1000, 1), kf(3000, 2), kf(6000, 3))), b2 = json(e2.doc), r2 = wk(e2, { borderWidth: { add: [{ time: 9, value: 5 }], remove: [5] } });
    refused(e2, b2, r2, 'REMOVE_TIME_NOT_FOUND'); expect(r2.message).toBe("For 'borderWidth', no keyframes found at 5s (100ms tolerance). Available: 1.000s, 3.000s, 6.000s, 9.000s.");
  });
  it('TRACK_LOCKED: a locked track refuses the write (error "Track V1 is locked")', () => {
    const doc = base(); doc.tracks.find((t: any) => t.id === 'V1')!.locked = true;
    const e = editor(doc), before = json(e.doc), r = wk(e, { opacity: { add: [{ time: 1, value: 0.5 }] } });
    refused(e, before, r, 'TRACK_LOCKED'); expect(r.error).toBe('Track V1 is locked');
  });
});

describe('setTimeRemap: remaining codes and storage (provisional where the wording is Cutframe\'s own)', () => {
  const remap = (e: Editor, keyframes: unknown, extra: Record<string, unknown> = {}) => call(e, 'setTimeRemap', { itemId: 'vid', keyframes, ...extra });
  it('INVALID_KEYFRAMES for a missing, empty or non-array list: exact error-codes message', () => {
    for (const keyframes of [undefined, [], 'x', {}]) { const e = editor(), before = json(e.doc), r = remap(e, keyframes); refused(e, before, r, 'INVALID_KEYFRAMES'); expect(r.message).toBe('Keyframes must be a non-empty array. Each keyframe needs { time (seconds), value (source ms) }.'); }
  });
  it('INVALID_KEYFRAME_TIME for a negative or non-number time', () => {
    for (const time of [-1, 'x']) { const e = editor(), before = json(e.doc); refused(e, before, remap(e, [{ time, value: 0 }]), 'INVALID_KEYFRAME_TIME'); }
  });
  it('INVALID_KEYFRAME_VALUE for a negative or non-number value; provisional message "[keyframes[0]] value must be a non-negative number of source milliseconds, got: -5"', () => {
    const e = editor(), before = json(e.doc), r = remap(e, [{ time: 1, value: -5 }]);
    refused(e, before, r, 'INVALID_KEYFRAME_VALUE'); expect(r.message).toBe('[keyframes[0]] value must be a non-negative number of source milliseconds, got: -5');
    refused(e, before, remap(e, [{ time: 1, value: 'x' }]), 'INVALID_KEYFRAME_VALUE');
  });
  it('INVALID_EASING and INVALID_BEZIER_HANDLE use the entry path keyframes[n]', () => {
    const e = editor(), before = json(e.doc), r = remap(e, [{ time: 1, value: 0, easing: 'wobble' }]);
    refused(e, before, r, 'INVALID_EASING'); expect(r.message).toMatch(/^\[keyframes\[0\]\] easing 'wobble' not valid\. Options: /);
    refused(e, before, remap(e, [{ time: 0, value: 0 }, { time: 1, value: 0, inHandle: [0, 101] }]), 'INVALID_BEZIER_HANDLE');
  });
  it('10 ms tolerance: a time 10 ms past the end is accepted and clamps to the clip length; a time 10 ms before the start clamps to 0', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('late', 'V1', 2000, 12000, 0, 10000)] }), e = editor(doc);
    const r = call(e, 'setTimeRemap', { itemId: 'late', keyframes: [{ time: 1.99, value: 0 }, { time: 12.01, value: 9000 }] });
    expect(r.success).toBe(true); expect(itemOf(e.doc, 'late').timeRemap.keyframes.map((k: any) => k.time)).toEqual([0, 10000]);
  });
  it('provisional: the TIME_OUT_OF_BOUNDS message names the entry path: "[keyframes[1]] keyframe at 15s outside clip bounds (0.000s – 10.000s)."', () => {
    const e = editor(), before = json(e.doc), r = remap(e, [{ time: 0, value: 0 }, { time: 15, value: 100 }]);
    refused(e, before, r, 'TIME_OUT_OF_BOUNDS'); expect(r.message).toBe('[keyframes[1]] keyframe at 15s outside clip bounds (0.000s – 10.000s).');
  });
  it('merge keeps the id of the keyframe it updates; stored keyframe ids match kf_<epoch ms>_<9 chars>', () => {
    const e = editor(); remap(e, [{ time: 0, value: 0 }, { time: 5, value: 5000 }]);
    const ids = itemOf(e.doc, 'vid').timeRemap.keyframes.map((k: any) => k.id); for (const id of ids) expect(id).toMatch(/^kf_1792742400000_.{9}$/);
    remap(e, [{ time: 5.02, value: 5200 }], { replace: false });
    expect(itemOf(e.doc, 'vid').timeRemap.keyframes.map((k: any) => [k.id, k.time, k.value])).toEqual([[ids[0], 0, 0], [ids[1], 5000, 5200]]);
  });
  it('provisional: replace stores the curve sorted by time (the spec is silent on remap order)', () => {
    const e = editor(); remap(e, [{ time: 10, value: 10000 }, { time: 0, value: 0 }, { time: 5, value: 2000 }]);
    expect(itemOf(e.doc, 'vid').timeRemap.keyframes.map((k: any) => k.time)).toEqual([0, 5000, 10000]);
  });
  it('provisional fallback: sourceDuration comes from item.sourceDuration, else trim.to, else the clip span', () => {
    const run = (extra: Record<string, unknown>) => { const doc = base(); Object.assign(itemOf(doc, 'vid'), extra); return remap(editor(doc), [{ time: 0, value: 0 }, { time: 10, value: 1000 }]).data.sourceDuration; };
    expect(run({ sourceDuration: 20000 })).toBe(20); expect(run({ sourceDuration: 0, trim: { from: 0, to: 8000 } })).toBe(8); expect(run({ sourceDuration: 0, trim: undefined })).toBe(10);
  });
  it('TRACK_LOCKED: a locked track refuses setTimeRemap', () => {
    const doc = base(); doc.tracks.find((t: any) => t.id === 'V1')!.locked = true;
    const e = editor(doc), before = json(e.doc); refused(e, before, remap(e, [{ time: 0, value: 0 }]), 'TRACK_LOCKED');
  });
});

describe('editProperties: remaining codes and strings (provisional where the wording is Cutframe\'s own)', () => {
  const ed = (properties: Record<string, unknown>, id = 'vid', doc?: ProjectDocument) => { const e = editor(doc), before = json(e.doc); return { e, before, r: call(e, 'editProperties', { itemId: id, properties }) }; };
  it('text keys on a text item are written by T05 (one undo entry); on a caption → T09; colors / media → T22', () => {
    // T05 (assertion edit): was NOT_IMPLEMENTED naming T05. The positive case is covered in depth by tests/t05-*.test.ts.
    const a = ed({ fontSize: 40 }, 'txt'); expect(a.r.success).toBe(true); expect(valueAt(itemOf(a.e.doc, 'txt'), 'fontSize', 0)).toBe(40); only(a.e, 'Edit items');
    const b = ed({ text: 'x', color: '#fff' }, 'txt'); expect(b.r.success).toBe(true); expect(itemOf(b.e.doc, 'txt').details.text).toBe('x'); expect(valueAt(itemOf(b.e.doc, 'txt'), 'color', 0)).toBe('#fff'); only(b.e, 'Edit items');
    const doc = base(); doc.items.push(mkItem('cap', 'O1', 5000, 6000, { type: 'caption' }));
    const c = ed({ fontSize: 40 }, 'cap', doc); refused(c.e, c.before, c.r, 'NOT_IMPLEMENTED'); expect(c.r.error).toBe('fontSize is not yet implemented (T09).');
    const d = ed({ colors: [] }); refused(d.e, d.before, d.r, 'NOT_IMPLEMENTED'); expect(d.r.error).toBe('colors is not yet implemented (T22).');
    expect(ed({ media: {} }).r.error).toBe('media is not yet implemented (T22).');
  });
  it('INVALID_PROPERTY: error names the type and lists the allowed keys (registry plus playbackRate on video / audio); R2 shape { error, code }', () => {
    const { e, before, r } = ed({ bogus: 1 });
    refused(e, before, r, 'INVALID_PROPERTY'); expect(r.error).toMatch(/^Property 'bogus' is not editable on video items\. Allowed properties: .*opacity.*playbackRate$/);
    const a = ed({ opacity: 1 }, 'aud'); refused(a.e, a.before, a.r, 'INVALID_PROPERTY'); expect(a.r.error).toMatch(/Allowed properties: volume, playbackRate$/);
  });
  it.each([
    ['volume', 'txt', ' volume applies only to video and audio items.'], ['brightness', 'vid', ' For brightness on a video item, add an effect with writeEffects.'],
    ['strokeWidth', 'txt', ' A text outline is borderWidth / borderColor.'],
  ])('provisional: the %s pointer on %s', (key, id, pointer) => {
    const { e, before, r } = ed({ [key]: 1 }, id); refused(e, before, r, 'INVALID_PROPERTY'); expect(r.error).toContain(pointer);
  });
  it('provisional: a shape\'s borderWidth points to strokeWidth / strokeColor; blur on a shape points to writeEffects', () => {
    const doc = base(); doc.items.push(mkItem('shp', 'O1', 5000, 6000, { type: 'shape' }));
    expect(ed({ borderWidth: 1 }, 'shp', doc).r.error).toContain(" A shape's outline is strokeWidth / strokeColor.");
    expect(ed({ blur: 1 }, 'shp', doc).r.error).toContain(' For blur on a shape item, add an effect with writeEffects.');
  });
  it('INVALID_PROPERTY_VALUE strings: wrong type, non-finite, blendMode list, colour, boxShadow fields (provisional wording)', () => {
    const msg = (properties: Record<string, unknown>) => { const { e, before, r } = ed(properties); refused(e, before, r, 'INVALID_PROPERTY_VALUE'); return r.error as string; };
    expect(msg({ opacity: '0.5' })).toBe('opacity has the wrong value type'); expect(msg({ opacity: Number.POSITIVE_INFINITY })).toBe('opacity must be finite'); expect(msg({ opacity: 2 })).toBe('opacity must be at most 1');
    expect(msg({ blendMode: 'bogus' })).toBe('blendMode must be one of: normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity');
    expect(msg({ borderColor: 'not a colour!' })).toBe('borderColor must be a valid colour, got: not a colour!');
    expect(msg({ boxShadow: { x: 'a' } })).toBe('boxShadow.x must be finite'); expect(msg({ boxShadow: { color: '12 3' } })).toBe('boxShadow.color must be a valid colour, got: 12 3');
    expect(msg({ boxShadow: 5 })).toBe('boxShadow has the wrong value type'); expect(msg({ flipX: 1 })).toBe('flipX has the wrong value type');
  });
  it('a keyframed property changes only its default value; keyframes stay', () => {
    const ks = [kf(0, 0), kf(1000, 1)], doc = withVid({ properties: { opacity: prop(ks, 1) } }), { e, r } = ed({ opacity: 0.5 }, 'vid', doc);
    expect(r.success).toBe(true); expect(itemOf(e.doc, 'vid').properties.opacity).toEqual({ defaultValue: 0.5, keyframes: ks });
  });
  it('boxShadow merges its fields into the current value', () => {
    const { e, r } = ed({ boxShadow: { blur: 4, color: '#ff0000' } }); expect(r.success).toBe(true);
    expect(itemOf(e.doc, 'vid').properties.boxShadow.defaultValue).toEqual({ blur: 4, color: '#ff0000', x: 0, y: 0 });
    call(e, 'editProperties', { itemId: 'vid', properties: { boxShadow: { x: 3 } } });
    expect(itemOf(e.doc, 'vid').properties.boxShadow.defaultValue).toEqual({ blur: 4, color: '#ff0000', x: 3, y: 0 });
  });
  it('blendMode, flipX and borderColor are written in the stored shape', () => {
    const { e, r } = ed({ blendMode: 'color-dodge', flipX: true, borderColor: '#112233' }); expect(r.success).toBe(true);
    const p = itemOf(e.doc, 'vid').properties; expect(p.blendMode).toEqual({ defaultValue: 'color-dodge', keyframes: [] }); expect(p.flipX).toEqual({ defaultValue: true, keyframes: [] }); expect(p.borderColor.defaultValue).toBe('#112233');
  });
  it('data: itemIds as given and changedFields per item id in storage names; unchanged properties are not listed', () => {
    const doc = base(); doc.items.push(video('vid2', 'V1', 10000, 12000, 0, 10000));
    const e = editor(doc), r = call(e, 'editProperties', { itemIds: ['vid', 'vid2'], properties: { opacity: 0.5, scale: 1 } });
    expect(r.data.itemIds).toEqual(['vid', 'vid2']); expect(r.data.changedFields.vid).toEqual(['properties.opacity']); expect(r.data.changedFields.vid2).toEqual(['properties.opacity']);
  });
  it('a single item says "Updated 1 item atomically"', () => { expect(ed({ opacity: 0.5 }).r.message).toBe('Updated 1 item atomically'); });
  it('TRACK_LOCKED: a locked track refuses editProperties', () => {
    const doc = base(); doc.tracks.find((t: any) => t.id === 'V1')!.locked = true;
    const { e, before, r } = ed({ opacity: 0.5 }, 'vid', doc); refused(e, before, r, 'TRACK_LOCKED');
  });
  it('provisional: a playbackRate-only call is labelled "Change speed"; a mixed call is labelled "Edit items"', () => {
    const a = editor(); call(a, 'editProperties', { itemId: 'vid', properties: { playbackRate: 2 } }); expect(a.bus.undoStack[0].label).toBe('Change speed');
    const b = editor(); call(b, 'editProperties', { itemId: 'vid', properties: { playbackRate: 2, opacity: 0.5 } }); expect(b.bus.undoStack[0].label).toBe('Edit items');
  });
  it('provisional: playbackRate blocked by the next clip says so and keeps the clip to the gap', () => {
    const doc = base(); doc.items.push(video('nxt', 'V1', 10000, 14000, 0, 10000));
    const e = editor(doc), r = call(e, 'editProperties', { itemId: 'vid', properties: { playbackRate: 0.5 } });
    expect(r.success).toBe(true); expect(itemOf(e.doc, 'vid').display).toEqual({ from: 0, to: 10000 });
    expect(r.message).toMatch(/'vid' at 0\.5× was stopped at 10s by the next clip on its track, so less of its footage now plays; trimItem with ripple: true can lengthen it and push later clips along\./);
  });
});

describe('Change speed through changeSpeed, one bus entry (part 3 §45.5, W3-RT-12; provisional: the bus-level intent arrives in P3)', () => {
  const clips = () => build({ tracks: [mkTrack('V1', 'video')], items: [
    video('a', 'V1', 0, 20000, 0, 25000, { trim: { from: 0, to: 19999.78 } }), video('b', 'V1', 20000, 30000, 0, 10000)] });
  const speed = (e: Editor, id: string, rate: number, ripple: boolean) => e.bus.run('Change speed', 'user', d => changeSpeed(d, id, rate, ripple));
  it('0.5× on a 0–20 s clip with trim 0–19,999.78 and the next clip at 20 s, ripple off: stays 0–20 s (blocked), rate 0.5, trim unchanged', () => {
    const e = editor(clips()), r = speed(e, 'a', 0.5, false), a = itemOf(e.doc, 'a');
    expect(r).toMatchObject({ id: 'a', rate: 0.5, from: 0, to: 20000, oldEnd: 20000, blocked: true });
    expect(a.display).toEqual({ from: 0, to: 20000 }); expect(a.playbackRate).toBe(0.5); expect(a.trim).toEqual({ from: 0, to: 19999.78 });
    expect(itemOf(e.doc, 'b').display).toEqual({ from: 20000, to: 30000 });
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0].label).toBe('Change speed');
  });
  it('0.5×, ripple on: 0–40,000 ms and later clips move +20,000 ms', () => {
    const e = editor(clips()), r = speed(e, 'a', 0.5, true), a = itemOf(e.doc, 'a');
    expect(r).toMatchObject({ to: 40000, blocked: false }); expect(r.shifted).toContain('b');
    expect(a.display).toEqual({ from: 0, to: 40000 }); expect(a.playbackRate).toBe(0.5); expect(a.trim).toEqual({ from: 0, to: 19999.78 });
    expect(itemOf(e.doc, 'b').display).toEqual({ from: 40000, to: 50000 });
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0].label).toBe('Change speed');
  });
  it('undo restores the document byte for byte', () => {
    const e = editor(clips()), before = json(e.doc); speed(e, 'a', 0.5, true); e.bus.undo(); expect(json(e.doc)).toBe(before);
  });
  it('2× shortens the clip to trim length ÷ 2 (whole ms) and leaves later clips alone with ripple off', () => {
    const e = editor(clips()), r = speed(e, 'a', 2, false);
    expect(r).toMatchObject({ to: 10000, blocked: false, shifted: [] }); expect(itemOf(e.doc, 'a').display).toEqual({ from: 0, to: 10000 }); expect(itemOf(e.doc, 'b').display).toEqual({ from: 20000, to: 30000 });
  });
  it('a locked track refuses (TRACK_LOCKED) and the bus records no entry', () => {
    const doc = clips(); doc.tracks.find((t: any) => t.id === 'V1')!.locked = true;
    const e = editor(doc);
    expect(() => speed(e, 'a', 2, false)).toThrow(); expect(e.bus.undoStack).toHaveLength(0);
  });
});

describe('Remap on / off through remapOn and remapOff, one bus entry (part 3 §45.5; provisional: the bus-level intent arrives in P3)', () => {
  const clip = (extra: Record<string, unknown> = {}) => build({ tracks: [mkTrack('V1', 'video')], items: [video('c', 'V1', 0, 45000, 0, 45000, extra)] });
  const op = (e: Editor, fn: (d: ProjectDocument) => unknown) => e.bus.run('Edit items', 'user', d => fn(d));
  it('remap on a 45 s clip: keyframes {0 → 0} and {45,000 → 45,000}, both linear; the source time follows the clock', () => {
    const e = editor(clip()); op(e, d => remapOn(d, 'c')); const c = itemOf(e.doc, 'c');
    expect(c.timeRemap.keyframes.map((k: any) => [k.time, k.value, k.easing])).toEqual([[0, 0, 'linear'], [45000, 45000, 'linear']]);
    expect(sourceTime(c, 20000)).toBeCloseTo(20000, 6); expect(e.bus.undoStack).toHaveLength(1);
  });
  it('remap on a trimmed clip uses the trim window: {0 → trim.from}, {span → trim.to}', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('c', 'V1', 0, 4000, 2000, 20000, { trim: { from: 2000, to: 6000 } })] });
    const e = editor(doc); op(e, d => remapOn(d, 'c'));
    expect(itemOf(e.doc, 'c').timeRemap.keyframes.map((k: any) => [k.time, k.value])).toEqual([[0, 2000], [4000, 6000]]);
  });
  it('remap off: timeRemap is null; rate, length and trim are unchanged', () => {
    const e = editor(clip({ playbackRate: 2, display: { from: 0, to: 22500 }, timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(22500, 45000)] } }));
    const before = structuredClone(itemOf(e.doc, 'c')); op(e, d => remapOff(d, 'c')); const c = itemOf(e.doc, 'c');
    expect(c.timeRemap ?? null).toBeNull(); expect(c.playbackRate).toBe(2); expect(c.display).toEqual(before.display); expect(c.trim).toEqual(before.trim); expect(e.bus.undoStack).toHaveLength(1);
  });
  it('undo of remap on restores the document byte for byte', () => {
    const e = editor(clip()), before = json(e.doc); op(e, d => remapOn(d, 'c')); e.bus.undo(); expect(json(e.doc)).toBe(before);
  });
});
