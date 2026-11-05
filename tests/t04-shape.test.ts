// SPDX-License-Identifier: AGPL-3.0-only
// T04 stored shape through the T03 command paths, written-spec oracle. Oracle: findings part 2 §38 (property time on the trim axis, split, trim),
// §41b (right-half trim.from = old + elapsed × rate; remap keyframes shifted by −elapsed), findings §15 (nudge offsets all keyframes), tool contracts
// slipItem ("keyframes stay put on the timeline"), tool results §2 (cloneItem), tickets § T04 (stored animatable shape).
// Provisional (undocumented): a bare number under `properties` reads as the default value with no keyframes (dev-only data written by T03 builds);
// transformItem on a keyframed property writes the default value and leaves the keyframes; a start trim shifts time-remap keyframes by −delta so
// the footage at each timeline moment is unchanged; keyframe ids are not asserted for clones / pastes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import type { Label } from '../apps/web/src/timeline/bus';
import { changeSpeed, remapOff, remapOn } from '../apps/web/src/timeline/edits';
import { keyframesBlock, sourceTime, valueAt } from '../apps/web/src/timeline/properties';
import { assets, fixture, itemOf, links, mkItem, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => useIds()); afterEach(() => resetIds());
type Editor = ReturnType<typeof createEditor>;
const editor = (doc: ProjectDocument = fixture()) => createEditor(doc, { assets: assets(), links: links() });
const call = (e: Editor, name: string, args: Record<string, unknown>): any => e.call(name, args);
const json = (d: unknown) => JSON.stringify(d);
const kf = (time: number, value: unknown, easing: any = 'linear') => ({ id: `k${time}`, time, value, easing });
const prop = (keyframes: any[], defaultValue: unknown = 0) => ({ defaultValue, keyframes });
/** The fixture with `patch` merged into item `id` before the editor starts. */
const patched = (id: string, patch: Record<string, unknown>) => { const d = fixture(); Object.assign(itemOf(d, id), patch); return d; };
const stored = (v: any) => v && typeof v === 'object' && 'defaultValue' in v && Array.isArray(v.keyframes);

describe('T04 stored shape from the T03 writers (tickets § T04)', () => {
  it('addMedia writes every property in the stored shape { defaultValue, keyframes: [] } and no time remap', () => {
    const e = editor(), r = call(e, 'addMedia', { trackId: 'V2', timelineStart: 0, items: [{ assetId: 'video_1' }] });
    expect(r.success).toBe(true);
    const it = itemOf(e.doc, r.data.addedItemIds[0]), keys = Object.keys(it.properties);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) { expect(stored(it.properties[k]), k).toBe(true); expect(it.properties[k].keyframes, k).toEqual([]); }
    expect(it.timeRemap ?? null).toBeNull();
  });
  it('transformItem rotation writes properties.rotation as { defaultValue: 15, keyframes: [] }', () => {
    const e = editor(), r = call(e, 'transformItem', { itemId: 'v1', rotation: 15 });
    expect(r.success).toBe(true);
    expect(itemOf(e.doc, 'v1').properties.rotation).toEqual({ defaultValue: 15, keyframes: [] });
  });
  it('provisional: a bare number under properties (T03-era data) is read as the default value and written back in the stored shape', () => {
    const e = editor(patched('v1', { properties: { rotation: 5 } }));
    expect(call(e, 'transformItem', { itemId: 'v1', rotation: 15 }).success).toBe(true);
    expect(itemOf(e.doc, 'v1').properties.rotation).toEqual({ defaultValue: 15, keyframes: [] });
  });
  it('provisional: transformItem on a keyframed property sets the default value and keeps the keyframes untouched', () => {
    const ks = [kf(0, 0), kf(1000, 90)], e = editor(patched('v1', { properties: { rotation: prop(ks, 0) } }));
    expect(call(e, 'transformItem', { itemId: 'v1', rotation: 15 }).success).toBe(true);
    expect(itemOf(e.doc, 'v1').properties.rotation).toEqual({ defaultValue: 15, keyframes: ks });
  });
});

describe('T04 nudge offsets the default value and every keyframe (findings §15, tickets § T04)', () => {
  const props = () => ({ positionX: prop([kf(0, 10, 'easeIn'), kf(1000, 20, 'linear'), kf(2000, 'x')], 5), opacity: prop([kf(0, 0), kf(1000, 1)], 1) });
  it('dx / dy move positionX / positionY: default + every numeric keyframe; times, ids, easings and other properties are untouched; a missing axis is created', () => {
    const e = editor(patched('v1', { properties: props() })), before = structuredClone(itemOf(e.doc, 'v1'));
    e.intent({ type: 'nudgeItems', itemIds: ['v1'], dx: 7, dy: -3 });
    const p = itemOf(e.doc, 'v1').properties;
    expect(p.positionX.defaultValue).toBe(12);
    expect(p.positionX.keyframes).toEqual([kf(0, 17, 'easeIn'), kf(1000, 27, 'linear'), kf(2000, 'x')]); // non-numeric keyframe untouched
    expect(p.positionY).toEqual({ defaultValue: -3, keyframes: [] });
    expect(p.opacity).toEqual(before.properties.opacity);
    expect(e.bus.undoStack).toHaveLength(1);
  });
  it('audio items are not nudged; undo restores the document byte for byte', () => {
    const e = editor(patched('v1', { properties: props() })), before = json(e.doc);
    e.intent({ type: 'nudgeItems', itemIds: ['a1'], dx: 5, dy: 5 });
    expect(itemOf(e.doc, 'a1').properties).toEqual({});
    e.intent({ type: 'nudgeItems', itemIds: ['v1'], dx: 5, dy: 0 });
    expect(json(e.doc)).not.toBe(before);
    e.intent({ type: 'undo' }); e.intent({ type: 'undo' });
    expect(json(e.doc)).toBe(before);
  });
});

describe('T04 split keeps keyframed properties continuous and shifts the remap (findings part 2 §38, §41b)', () => {
  it('video at rate 2: the right half starts at old trim.from + elapsed × rate; both halves keep the keyframes; the property value continues across the cut', () => {
    const ks = [kf(1000, 0), kf(9000, 1)], doc = patched('v1', { playbackRate: 2, trim: { from: 1000, to: 9000 }, properties: { opacity: prop(ks, 1) } });
    const e = editor(doc), whole = structuredClone(itemOf(e.doc, 'v1')), r = call(e, 'splitItem', { itemId: 'v1', timestampS: 1.5 });
    expect(r.success).toBe(true);
    const left = itemOf(e.doc, r.data.leftItemId), right = itemOf(e.doc, r.data.rightItemId);
    expect(right.trim).toEqual({ from: 4000, to: 9000 }); expect(left.trim).toEqual({ from: 1000, to: 4000 });
    expect(left.properties.opacity.keyframes).toEqual(ks); expect(right.properties.opacity.keyframes).toEqual(ks);
    expect(valueAt(right, 'opacity', 0)).toBeCloseTo(valueAt(whole, 'opacity', 1500) as number, 9);
    expect(valueAt(right, 'opacity', 1000)).toBeCloseTo(valueAt(whole, 'opacity', 2500) as number, 9);
  });
  it('text (no media length): the right half gets trim.from = elapsed × rate and its keyframed opacity continues from the cut', () => {
    const ks = [kf(0, 0), kf(4000, 1)], doc = patched('t1', { display: { from: 0, to: 4000 }, properties: { opacity: prop(ks, 1) } });
    const e = editor(doc), r = call(e, 'splitItem', { itemId: 't1', timestampS: 1.5 });
    expect(r.success).toBe(true);
    const right = itemOf(e.doc, r.data.rightItemId);
    expect(right.trim.from).toBe(1500); expect(valueAt(right, 'opacity', 0)).toBeCloseTo(0.375, 9);
  });
  it('time-remap keyframes of the right half are shifted by −elapsed; the left half keeps its curve; the source time continues', () => {
    const remap = { defaultValue: 0, keyframes: [kf(0, 0), kf(4000, 8000)] }, e = editor(patched('v1', { timeRemap: remap })), whole = structuredClone(itemOf(e.doc, 'v1'));
    const r = call(e, 'splitItem', { itemId: 'v1', timestampS: 1 });
    const left = itemOf(e.doc, r.data.leftItemId), right = itemOf(e.doc, r.data.rightItemId);
    expect(left.timeRemap.keyframes.map((k: any) => k.time)).toEqual([0, 4000]);
    expect(right.timeRemap.keyframes.map((k: any) => k.time)).toEqual([-1000, 3000]);
    expect(right.timeRemap.keyframes.map((k: any) => k.value)).toEqual([0, 8000]); // values are source ms and do not move
    for (const local of [0, 500, 3000]) expect(sourceTime(right, local)).toBeCloseTo(sourceTime(whole, 1000 + local), 9);
  });
  it('the UI split gives the same stored shape as the tool (one document either way)', () => {
    const ks = [kf(0, 0), kf(4000, 1)], doc = patched('t1', { display: { from: 0, to: 4000 }, properties: { opacity: prop(ks, 1) } });
    const a = editor(doc), b = editor(doc);
    call(a, 'splitItem', { itemId: 't1', timestampS: 1.5 }); useIds(); b.intent({ type: 'splitItems', itemIds: ['t1'], atMs: 1500 });
    expect(json(b.doc)).toBe(json(a.doc));
  });
});

describe('T04 slip and trim against the trim axis (findings part 2 §38; contracts slipItem)', () => {
  const clip = () => patched('v2', { display: { from: 1000, to: 5000 }, trim: { from: 2000, to: 6000 }, properties: { opacity: prop([kf(2000, 0), kf(4000, 1)], 1) } });
  it('slipItem: the keyframes stay put on the timeline (timeline seconds and values at a given timeline time are unchanged)', () => {
    const e = editor(clip()), before = keyframesBlock(itemOf(e.doc, 'v2')), v = valueAt(itemOf(e.doc, 'v2'), 'opacity', 1000);
    expect(call(e, 'slipItem', { itemId: 'v2', slipSeconds: 1 }).success).toBe(true);
    const it = itemOf(e.doc, 'v2');
    expect(it.trim).toEqual({ from: 3000, to: 7000 }); expect(it.display).toEqual({ from: 1000, to: 5000 });
    expect(keyframesBlock(it)).toEqual(before); expect(valueAt(it, 'opacity', 1000)).toBeCloseTo(v as number, 9);
  });
  it('trimming the start moves the clip window over the keyframes: stored keyframe times are unchanged, the value at the new start is the old value one second in', () => {
    const e = editor(clip()), v = valueAt(itemOf(e.doc, 'v2'), 'opacity', 1000);
    expect(call(e, 'trimItem', { itemId: 'v2', handle: 'start', deltaSeconds: 1 }).success).toBe(true);
    const it = itemOf(e.doc, 'v2');
    expect(it.properties.opacity.keyframes.map((k: any) => k.time)).toEqual([2000, 4000]); expect(it.trim.from).toBe(3000);
    expect(valueAt(it, 'opacity', 0)).toBeCloseTo(v as number, 9);
  });
  it('trimming the end leaves every keyframe where it is', () => {
    const e = editor(clip());
    expect(call(e, 'trimItem', { itemId: 'v2', handle: 'end', deltaSeconds: -1 }).success).toBe(true);
    expect(itemOf(e.doc, 'v2').properties.opacity.keyframes.map((k: any) => k.time)).toEqual([2000, 4000]);
  });
  it('provisional: trimming the start of a remapped clip keeps the footage at each timeline moment (remap keyframes shift by −delta)', () => {
    const remap = { defaultValue: 0, keyframes: [kf(0, 0), kf(4000, 8000)] }, e = editor(patched('v1', { timeRemap: remap })), whole = structuredClone(itemOf(e.doc, 'v1'));
    expect(call(e, 'trimItem', { itemId: 'v1', handle: 'start', deltaSeconds: 1 }).success).toBe(true);
    const it = itemOf(e.doc, 'v1');
    expect(sourceTime(it, 0)).toBeCloseTo(sourceTime(whole, 1000), 9); expect(sourceTime(it, 2000)).toBeCloseTo(sourceTime(whole, 3000), 9);
  });
});

describe('T04 clone and paste copy the animated state (tool results §2 cloneItem; part 2 §29)', () => {
  const animated = () => patched('v1', { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(4000, 8000)] }, properties: { opacity: prop([kf(0, 0), kf(1000, 1, 'easeOut')], 1) } });
  it('cloneItem copies properties and remap deeply: equal values and times, independent arrays', () => {
    const e = editor(animated()), r = call(e, 'cloneItem', { itemId: 'v1', trackId: 'V2', at: 0 });
    expect(r.success).toBe(true);
    const copy = itemOf(e.doc, r.data.itemId), src = itemOf(e.doc, 'v1');
    const shape = (i: any) => ({ p: i.properties.opacity.keyframes.map(({ time, value, easing }: any) => ({ time, value, easing })), r: i.timeRemap.keyframes.map(({ time, value }: any) => ({ time, value })) });
    expect(shape(copy)).toEqual(shape(src));
    copy.properties.opacity.keyframes[0].value = 0.9; copy.timeRemap.keyframes[1].value = 1;
    expect(src.properties.opacity.keyframes[0].value).toBe(0); expect(src.timeRemap.keyframes[1].value).toBe(8000);
  });
  it('the UI duplicate and paste copy the same animated state', () => {
    const e = editor(animated()), src = structuredClone(itemOf(e.doc, 'v1'));
    e.intent({ type: 'duplicateItems', itemIds: ['v1'] });
    const dup = e.doc.items.find(i => i.id !== 'v1' && i.timeRemap)!;
    expect(dup).toBeDefined(); expect(dup.properties.opacity.keyframes.map((k: any) => k.value)).toEqual([0, 1]);
    e.intent({ type: 'pasteItems', items: [src], atMs: 20000 });
    const pasted = e.doc.items.find(i => i.display.from === 20000)!;
    expect(pasted.timeRemap.keyframes.map((k: any) => k.value)).toEqual([0, 8000]); expect(pasted.properties.opacity.keyframes.map((k: any) => k.time)).toEqual([0, 1000]);
  });
});

describe('T04 shape of a document item (sanity of the fixtures)', () => {
  it('a plain fixture item has no keyframes and reads the registry default', () => {
    const it = mkItem('x', 'V1', 0, 1000), v = video('y', 'V1', 0, 1000);
    expect(keyframesBlock(it).keyframes).toBeNull(); expect(valueAt(v, 'opacity', 0)).toBe(1);
  });
});

describe('T04 no writer leaves a bare number under properties or timeRemap (approval condition b; tickets § T04)', () => {
  const isStored = (v: any) => v !== null && typeof v === 'object' && 'defaultValue' in v && Array.isArray(v.keyframes);
  /** Every property is { defaultValue, keyframes }; every timeRemap is null or { defaultValue, keyframes }. */
  const noBare = (doc: ProjectDocument) => {
    for (const it of doc.items) {
      for (const [k, v] of Object.entries<any>(it.properties ?? {})) expect(isStored(v), `${it.id}.properties.${k} = ${json(v)}`).toBe(true);
      expect(it.timeRemap === null || it.timeRemap === undefined || isStored(it.timeRemap), `${it.id}.timeRemap = ${json(it.timeRemap)}`).toBe(true);
    }
  };
  const seeded = () => patched('v1', { properties: { rotation: 5, opacity: 0.5 } }); // T03-era bare numbers (provisional read tolerance, see header)
  it('writeKeyframes over a bare number', () => {
    const e = editor(seeded());
    expect(call(e, 'writeKeyframes', { itemId: 'v1', payload: { rotation: { add: [{ time: 0.5, value: 10 }] } } }).success).toBe(true);
    expect(isStored(itemOf(e.doc, 'v1').properties.rotation)).toBe(true); expect(itemOf(e.doc, 'v1').properties.rotation.defaultValue).toBe(5);
  });
  it('editProperties over a bare number', () => {
    const e = editor(seeded());
    expect(call(e, 'editProperties', { itemId: 'v1', properties: { rotation: 15 } }).success).toBe(true);
    expect(itemOf(e.doc, 'v1').properties.rotation).toEqual({ defaultValue: 15, keyframes: [] });
  });
  it('editProperties on a fresh item writes the stored shape for a static value of every kind (number, boolean-free registry keys)', () => {
    const e = editor();
    expect(call(e, 'editProperties', { itemId: 'v1', properties: { opacity: 0.4, blendMode: 'multiply', boxShadow: { x: 2 } } }).success).toBe(true);
    noBare(e.doc);
    expect(itemOf(e.doc, 'v1').properties.blendMode).toEqual({ defaultValue: 'multiply', keyframes: [] });
  });
  it('setTimeRemap stores { defaultValue, keyframes }', () => {
    const e = editor(), r = call(e, 'setTimeRemap', { itemId: 'v1', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1000 }] });
    expect(r.success).toBe(true); noBare(e.doc); expect(itemOf(e.doc, 'v1').timeRemap.keyframes).toHaveLength(2);
  });
  it('writeKeyframes {timeRemap:{replace:[]}} clears to null, not 0 or {}', () => {
    const e = editor(patched('v1', { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(1000, 1000)] } }));
    expect(call(e, 'writeKeyframes', { itemId: 'v1', payload: { timeRemap: { replace: [] } } }).success).toBe(true);
    noBare(e.doc); expect(itemOf(e.doc, 'v1').timeRemap ?? null).toBeNull();
  });
  // Coordinator condition (b), 31 Oct: the T03 op set plus every T04 writer on ONE editor. Bare numbers are seeded on v1 only, the item every op touches (it, its split half, its clone
  // and its paste). The read is tolerant and nothing migrates on read, so a key an op did not write may stay bare. The oracle is therefore per op: every item the op added, and every
  // properties key / timeRemap whose value the op changed, must be stored-shaped. Copies (split right half, clone, paste) therefore normalise the bare values they carry
  // (coordinator decision, condition (b): writers always emit the stored shape). v3 is an untouched control: its bare number must survive every op unchanged.
  it('seeded bare numbers on v1 only (the item every op touches): after each of the T03 ops and every T04 writer, every item and key the op wrote is stored-shaped (none is a bare number)', () => {
    const doc = seeded(); Object.assign(itemOf(doc, 'v3'), { properties: { rotation: 7 } });
    const e = editor(doc), steps: string[] = [], COPY_OPS = new Set(['splitItem', 'cloneItem', 'pasteItems (copy of v1)']);
    const snap = () => new Map(e.doc.items.map(i => [i.id, { properties: structuredClone(i.properties ?? {}) as Record<string, any>, timeRemap: structuredClone(i.timeRemap ?? null) }]));
    const noBareExceptControl = (op: string, before: ReturnType<typeof snap>) => {
      for (const it of e.doc.items) {
        const old = before.get(it.id);
        for (const [k, v] of Object.entries<any>(it.properties ?? {})) if ((!old || json(old.properties[k]) !== json(v)) ) expect(isStored(v), `after ${op}: ${it.id}.properties.${k} = ${json(v)}`).toBe(true);
        if (!old || json(old.timeRemap) !== json(it.timeRemap ?? null)) expect(it.timeRemap === null || it.timeRemap === undefined || isStored(it.timeRemap), `after ${op}: ${it.id}.timeRemap = ${json(it.timeRemap)}`).toBe(true);
      }
      expect(itemOf(e.doc, 'v3').properties.rotation, `after ${op}: the control kept its bare number`).toBe(7);
      if (COPY_OPS.has(op)) for (const it of e.doc.items.filter(i => !before.has(i.id))) { // a copy of v1's bare values comes out stored-shaped with the source's default and no keyframes
        const src = before.get('v1')!.properties, dflt = (v: any) => isStored(v) ? v.defaultValue : v;
        for (const k of ['rotation', 'opacity']) expect(it.properties[k], `after ${op}: ${it.id}.${k}`).toEqual({ defaultValue: dflt(src[k]), keyframes: [] });
      }
    };
    const tool = (op: string, name: string, args: Record<string, unknown>) => { const b = snap(), r = call(e, name, args); expect(r.success, `${op}: ${json(r)}`).toBe(true); steps.push(op); noBareExceptControl(op, b); return r; };
    const intent = (op: string, i: Record<string, unknown>) => { const b = snap(), n = e.bus.undoStack.length; e.intent(i as any); expect(e.bus.undoStack.length, `${op} wrote an undo entry`).toBe(n + 1); steps.push(op); noBareExceptControl(op, b); };
    const bus = (op: string, label: Label, fn: (d: ProjectDocument) => unknown) => { const b = snap(), n = e.bus.undoStack.length; e.bus.run(label, 'user', d => fn(d)); expect(e.bus.undoStack.length, `${op} wrote an undo entry`).toBe(n + 1); steps.push(op); noBareExceptControl(op, b); };
    tool('addMedia', 'addMedia', { trackId: 'V2', timelineStart: 20, items: [{ assetId: 'video_1' }] });
    tool('moveItem', 'moveItem', { itemId: 'v1', trackId: 'V2' });
    tool('trimItem', 'trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -0.5 });
    tool('slipItem', 'slipItem', { itemId: 'v1', slipSeconds: 0.5 });
    tool('splitItem', 'splitItem', { itemId: 'v1', timestampS: 1.5 });
    tool('cloneItem', 'cloneItem', { itemId: 'v1', trackId: 'V1', at: 14 });
    tool('transformItem', 'transformItem', { itemId: 'v1', rotation: 15 });
    intent('nudgeItems', { type: 'nudgeItems', itemIds: ['v1'], dx: 5, dy: 0 });
    intent('pasteItems (copy of v1)', { type: 'pasteItems', items: [structuredClone(itemOf(e.doc, 'v1'))], atMs: 40000 });
    tool('writeKeyframes', 'writeKeyframes', { itemId: 'v1', payload: { opacity: { add: [{ time: 0.5, value: 0.3 }] } } });
    tool('editProperties', 'editProperties', { itemId: 'v1', properties: { rotation: 20, opacity: 0.8 } });
    bus('changeSpeed', 'Change speed', d => changeSpeed(d, 'v1', 2, false));
    bus('remapOn', 'Edit items', d => remapOn(d, 'v1'));
    bus('remapOff', 'Edit items', d => remapOff(d, 'v1'));
    tool('setTimeRemap', 'setTimeRemap', { itemId: 'v1', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 1000 }] });
    expect(steps).toHaveLength(15); expect(itemOf(e.doc, 'v3').properties.rotation).toBe(7); // the control was never rewritten
  });
  it('changeSpeed, remapOn and remapOff', () => {
    const e = editor(), run = (fn: (d: ProjectDocument) => unknown) => e.bus.run('Change speed', 'user', d => fn(d));
    run(d => changeSpeed(d, 'v1', 2, false)); noBare(e.doc);
    run(d => remapOn(d, 'v1')); noBare(e.doc); expect(itemOf(e.doc, 'v1').timeRemap.keyframes).toHaveLength(2);
    run(d => remapOff(d, 'v1')); noBare(e.doc); expect(itemOf(e.doc, 'v1').timeRemap ?? null).toBeNull();
  });
});
