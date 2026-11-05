// SPDX-License-Identifier: AGPL-3.0-only
// T10 effect stacks through the T03 command path (UI intents): add / toggle / remove / reorder, the stored instance shape, one
// "Edit items" entry per intent, rollback on refusal, retired Lumetri, and the Color card's block (part 4 §49.1 [C]).
// Oracle: ticket T10 "Owned acceptance" (stored shape `{id effect_<epoch ms>_<9 chars>, effectId, enabled, order, parameters
// {key {defaultValue, keyframes}}}`), contracts #29, error codes §7 (UNKNOWN_EFFECT / "is deprecated" for the intent, EFFECT_DEPRECATED for writeEffects), part 4 §49.1.
// Provisional (named in the test): the reset arrow also drops keyframes; move target clamping.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { effectsBlock, effectStack } from '../apps/web/src/timeline/effects';
import { EFFECTS, effectById } from '../apps/web/src/effects/registry';
import { newInstanceParams } from '../apps/web/src/effects/validate';
import { setIdSource } from '../apps/web/src/timeline/model';
import { build, itemOf, mkItem, mkTrack, resetIds, video } from './t03-fixtures';

const ID = /^effect_\d+_[A-Za-z0-9]{9}$/;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T08:00:00.000Z')); });
afterEach(() => { resetIds(); vi.useRealTimers(); });

const base = (): ProjectDocument => build({
  tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('A1', 'audio'), mkTrack('L1', 'video', { locked: true })],
  items: [video('v1', 'V1', 0, 4000), video('v2', 'V1', 4000, 8000), mkItem('t1', 'O1', 0, 2000, { type: 'text', details: { text: 'Hi' } }),
    mkItem('a1', 'A1', 0, 3000, { type: 'audio', trim: { from: 0, to: 3000 }, sourceDuration: 8000, metadata: { assetId: 'asset-aud1' } }),
    video('locked', 'L1', 0, 2000)],
});
const editor = (doc = base()) => createEditor(doc);
type Editor = ReturnType<typeof editor>;
const stack = (e: Editor, id = 'v1') => effectStack(itemOf(e.doc, id));
const types = (e: Editor, id = 'v1') => stack(e, id).map(x => x.effectId);
const json = (d: unknown) => JSON.stringify(d);
/** Adds effects through the UI intent, returns the stored instance ids in stack order. */
const add = (e: Editor, effectId: string, itemIds = ['v1']) => { const r = e.intent({ type: 'addEffect', itemIds, effectId }); expect(r).toEqual({ ok: true }); };
const ids = (e: Editor, id = 'v1') => stack(e, id).map(x => x.id as string);
/** One "Edit items" user entry; the document is the only thing the refusal left alone. */
const lastLabel = (e: Editor) => e.bus.undoStack[e.bus.undoStack.length - 1];
const refusedAs = (e: Editor, before: string, n: number, out: any, code: string) => {
  expect(out).toMatchObject({ ok: false, code }); expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n); expect(e.journal).toHaveLength(n);
};
const colour = (e: Editor, effectId: 'color-wheels' | 'curves' | 'lut', values: Record<string, unknown>, itemIds = ['v1']) => e.intent({ type: 'colourBlock', itemIds, effectId, values });

describe('T10 stack: add (UI intent addEffect)', () => {
  it('stores {id, effectId, enabled, order, parameters{key{defaultValue, keyframes}}} with every declared parameter, one "Edit items" user entry', () => {
    const e = editor(); add(e, 'grayscale');
    const [g] = stack(e);
    expect(g).toEqual({ id: expect.stringMatching(ID), effectId: 'grayscale', enabled: true, order: 0, parameters: { amount: { defaultValue: 100, keyframes: [] } } });
    expect(e.labels()).toEqual(['Edit items']); expect(e.bus.undoStack[0]).toMatchObject({ label: 'Edit items', source: 'user' }); expect(e.journal).toHaveLength(1);
  });
  it('the id carries the epoch ms of the moment', () => {
    const e = editor(); add(e, 'sepia');
    expect(stack(e)[0].id.startsWith(`effect_${Date.parse('2026-11-02T08:00:00.000Z')}_`)).toBe(true);
  });
  it('every discoverable effect adds with exactly its declared parameters at their new-instance values (toneCurve 2 on color-wheels)', () => {
    const e = editor();
    for (const d of EFFECTS.filter(x => x.visibility === 'discoverable')) {
      const doc = base(), ed = editor(doc);
      const target = d.itemTypes.includes('video') ? 'v1' : 't1';
      expect(ed.intent({ type: 'addEffect', itemIds: [target], effectId: d.id }), d.id).toEqual({ ok: true });
      const inst = effectStack(itemOf(ed.doc, target))[0];
      expect(Object.keys(inst.parameters).sort(), d.id).toEqual(d.params.map(p => p.key).sort());
      expect(Object.fromEntries(Object.entries(inst.parameters).map(([k, p]: [string, any]) => [k, p.defaultValue])), d.id).toEqual(newInstanceParams(d.id));
      for (const p of Object.values<any>(inst.parameters)) expect(p.keyframes).toEqual([]);
    }
    add(e, 'color-wheels'); expect(stack(e)[0].parameters.toneCurve.defaultValue).toBe(2);
    expect(effectById('color-wheels')!.params.find(p => p.key === 'toneCurve')).toMatchObject({ default: 1 });
  });
  it('appends at the end of the stack: orders 0…n−1, distinct ids; the same effect twice is two instances', () => {
    const e = editor(); add(e, 'grayscale'); add(e, 'vignette'); add(e, 'grayscale');
    expect(types(e)).toEqual(['grayscale', 'vignette', 'grayscale']); expect(stack(e).map(x => x.order)).toEqual([0, 1, 2]);
    expect(new Set(ids(e)).size).toBe(3); for (const id of ids(e)) expect(id).toMatch(ID);
    expect(e.labels()).toEqual(['Edit items', 'Edit items', 'Edit items']);
  });
  it('several items at once: one entry, one instance per item, each with its own id', () => {
    const e = editor(); add(e, 'sepia', ['v1', 'v2']);
    expect(e.bus.undoStack).toHaveLength(1); expect(types(e, 'v1')).toEqual(['sepia']); expect(types(e, 'v2')).toEqual(['sepia']);
    expect(ids(e, 'v1')[0]).not.toBe(ids(e, 'v2')[0]);
  });
  it('undo removes it and redo brings the same instance back', () => {
    const e = editor(); add(e, 'sepia'); const id = ids(e)[0];
    e.intent({ type: 'undo' }); expect(stack(e)).toEqual([]);
    e.intent({ type: 'redo' }); expect(ids(e)).toEqual([id]);
  });
  it('a text item takes the CSS-capable effects only (EFFECT_NOT_SUPPORTED / UNSUPPORTED_ITEM_TYPE are refusals that roll back)', () => {
    const e = editor(), before = json(e.doc);
    refusedAs(e, before, 0, e.intent({ type: 'addEffect', itemIds: ['t1'], effectId: 'vignette' }), 'EFFECT_NOT_SUPPORTED');
    refusedAs(e, before, 0, e.intent({ type: 'addEffect', itemIds: ['a1'], effectId: 'invert' }), 'UNSUPPORTED_ITEM_TYPE');
    add(e, 'invert', ['t1']); expect(types(e, 't1')).toEqual(['invert']);
  });
  it('rollback: a multi-item add where the second item refuses changes nothing for the first', () => {
    const e = editor(), before = json(e.doc);
    refusedAs(e, before, 0, e.intent({ type: 'addEffect', itemIds: ['v1', 'a1'], effectId: 'sepia' }), 'UNSUPPORTED_ITEM_TYPE');
    expect(stack(e)).toEqual([]);
  });
  it('unknown, hidden and missing targets are refusals with nothing stored', () => {
    const e = editor(), before = json(e.doc);
    refusedAs(e, before, 0, e.intent({ type: 'addEffect', itemIds: ['v1'], effectId: 'nope' }), 'UNKNOWN_EFFECT');
    refusedAs(e, before, 0, e.intent({ type: 'addEffect', itemIds: ['v1'], effectId: 'bg-removal' }), 'UNKNOWN_EFFECT');
    refusedAs(e, before, 0, e.intent({ type: 'addEffect', itemIds: ['ghost'], effectId: 'sepia' }), 'ITEM_NOT_FOUND');
  });
  // Fix round 2 B3 (error codes §7 l.193, D26 reading in the notes): the helper's own checks keep their codes above; the add
  // itself failing is ADD_EFFECT_FAILED, "Failed to add effect", with the cause in the message, and nothing is stored.
  it('ADD_EFFECT_FAILED: a real trigger, an item on a locked track', () => {
    const e = editor(), before = json(e.doc), out: any = e.intent({ type: 'addEffect', itemIds: ['locked'], effectId: 'sepia' });
    refusedAs(e, before, 0, out, 'ADD_EFFECT_FAILED');
    expect(out.message).toBe('Failed to add effect Track L1 is locked');
  });
  // The fault fires on the first item (v1), so nothing was written before the refusal; the partial-write rollback is the
  // "rollback" test above (v1 passes, a1 refuses).
  it('ADD_EFFECT_FAILED: the instance write throwing (test-only fault injection: the id source throws on the first item), nothing stored', () => {
    const e = editor(), before = json(e.doc);
    setIdSource(() => { throw new Error('id source failed (test fault injection)'); });
    const out: any = e.intent({ type: 'addEffect', itemIds: ['v1', 'v2'], effectId: 'sepia' });
    refusedAs(e, before, 0, out, 'ADD_EFFECT_FAILED');
    expect(out.message).toBe('Failed to add effect id source failed (test fault injection)');
    resetIds(); add(e, 'sepia'); expect(types(e)).toEqual(['sepia']);
  });
});

describe('T10 stack: toggle, remove, reorder', () => {
  it('toggleEffect flips enabled in place (one entry); a no-op toggle writes no entry', () => {
    const e = editor(); add(e, 'grayscale'); const id = ids(e)[0];
    expect(e.intent({ type: 'toggleEffect', itemId: 'v1', instanceId: id, enabled: false })).toEqual({ ok: true });
    expect(stack(e)[0].enabled).toBe(false); expect(e.labels()).toEqual(['Edit items', 'Edit items']);
    e.intent({ type: 'toggleEffect', itemId: 'v1', instanceId: id, enabled: false }); expect(e.bus.undoStack).toHaveLength(2); // already off: nothing changed
    e.intent({ type: 'toggleEffect', itemId: 'v1', instanceId: id, enabled: true }); expect(stack(e)[0].enabled).toBe(true);
    expect(e.bus.undoStack).toHaveLength(3);
  });
  it('removeEffect deletes the instance and renumbers the rest (orders 0…n−1)', () => {
    const e = editor(); add(e, 'grayscale'); add(e, 'vignette'); add(e, 'sepia'); const [, mid] = ids(e);
    expect(e.intent({ type: 'removeEffect', itemId: 'v1', instanceId: mid })).toEqual({ ok: true });
    expect(types(e)).toEqual(['grayscale', 'sepia']); expect(stack(e).map(x => x.order)).toEqual([0, 1]); expect(e.bus.undoStack).toHaveLength(4);
    expect(lastLabel(e)).toMatchObject({ label: 'Edit items', source: 'user' });
  });
  it('removeEffect of an id the item does not have is EFFECT_NOT_FOUND and rolls back', () => {
    const e = editor(); add(e, 'grayscale'); const before = json(e.doc);
    refusedAs(e, before, 1, e.intent({ type: 'removeEffect', itemId: 'v1', instanceId: 'effect_1_aaaaaaaaa' }), 'EFFECT_NOT_FOUND');
    refusedAs(e, before, 1, e.intent({ type: 'toggleEffect', itemId: 'v2', instanceId: ids(e)[0], enabled: false }), 'EFFECT_NOT_FOUND'); // an instance of v1, not v2
  });
  it('moveEffect puts the instance at the 0-based position, others keep their relative order, orders renumber', () => {
    const e = editor(); for (const f of ['grayscale', 'vignette', 'sepia', 'invert']) add(e, f);
    const [g, , s] = ids(e);
    e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: s, to: 0 }); expect(types(e)).toEqual(['sepia', 'grayscale', 'vignette', 'invert']);
    e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: g, to: 3 }); expect(types(e)).toEqual(['sepia', 'vignette', 'invert', 'grayscale']);
    expect(stack(e).map(x => x.order)).toEqual([0, 1, 2, 3]); expect(e.bus.undoStack).toHaveLength(6);
  });
  it('moveEffect clamps a target beyond the stack to the ends (provisional)', () => {
    const e = editor(); add(e, 'grayscale'); add(e, 'sepia'); const [g] = ids(e);
    e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: g, to: 99 }); expect(types(e)).toEqual(['sepia', 'grayscale']);
    e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: g, to: -4 }); expect(types(e)).toEqual(['grayscale', 'sepia']);
  });
  it('a transport stage stays first in the stored array and never counts as a position', () => {
    const doc = base(); itemOf(doc, 'v1').effects = [{ id: 'effect_1_aaaaaaaaa', effectId: 'stacked-alpha', enabled: true, order: 0, parameters: {} }];
    const e = editor(doc); add(e, 'grayscale'); add(e, 'sepia'); const sep = ids(e)[2];
    e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: sep, to: 0 });
    expect(types(e)).toEqual(['stacked-alpha', 'sepia', 'grayscale']); expect(itemOf(e.doc, 'v1').effects.map((x: any) => x.effectId)).toEqual(['stacked-alpha', 'sepia', 'grayscale']);
    expect(effectsBlock(itemOf(e.doc, 'v1')).effects!.map((x: any) => x.effectId)).toEqual(['sepia_1', 'grayscale_2']);
  });
  it('effectParams edits static values only, keeps keyframes, one entry; an out-of-range value is INVALID_PARAM_VALUE and rolls back', () => {
    const e = editor(); add(e, 'grayscale'); const id = ids(e)[0];
    e.call('writeKeyframes', { itemId: 'v1', effectId: 'grayscale_1', payload: { amount: { replace: [{ time: 0, value: 0 }, { time: 2, value: 100 }] } } });
    const n = e.bus.undoStack.length;
    expect(e.intent({ type: 'effectParams', itemId: 'v1', instanceId: id, values: { amount: 41 } })).toEqual({ ok: true });
    expect(stack(e)[0].parameters.amount).toMatchObject({ defaultValue: 41 }); expect(stack(e)[0].parameters.amount.keyframes).toHaveLength(2);
    expect(e.bus.undoStack).toHaveLength(n + 1); expect(lastLabel(e)).toMatchObject({ label: 'Edit items', source: 'user' });
    const before = json(e.doc);
    refusedAs(e, before, n + 1, e.intent({ type: 'effectParams', itemId: 'v1', instanceId: id, values: { amount: 101 } }), 'INVALID_PARAM_VALUE');
    refusedAs(e, before, n + 1, e.intent({ type: 'effectParams', itemId: 'v1', instanceId: id, values: { bogus: 1 } }), 'UNKNOWN_PARAMETERS');
  });
  it('resetEffect puts every parameter back to its new-instance value and drops keyframes (provisional), one entry', () => {
    const e = editor(); add(e, 'vignette'); const id = ids(e)[0];
    e.intent({ type: 'effectParams', itemId: 'v1', instanceId: id, values: { amount: 10, feather: 5 } });
    e.call('writeKeyframes', { itemId: 'v1', effectId: 'vignette_1', payload: { midpoint: { replace: [{ time: 0, value: 0 }, { time: 1, value: 80 }] } } });
    const n = e.bus.undoStack.length;
    expect(e.intent({ type: 'resetEffect', itemId: 'v1', instanceId: id })).toEqual({ ok: true });
    expect(stack(e)[0].parameters).toEqual(Object.fromEntries(Object.entries(newInstanceParams('vignette')).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }])));
    expect(e.bus.undoStack).toHaveLength(n + 1); expect(stack(e)[0].id).toBe(id);
  });
  it('all stack intents are undoable one entry at a time', () => {
    const e = editor(); add(e, 'grayscale'); add(e, 'sepia'); const [g] = ids(e);
    e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: g, to: 1 }); e.intent({ type: 'toggleEffect', itemId: 'v1', instanceId: g, enabled: false });
    e.intent({ type: 'undo' }); expect(stack(e)[1].enabled).toBe(true);
    e.intent({ type: 'undo' }); expect(types(e)).toEqual(['grayscale', 'sepia']);
  });
});

describe('T10 retired Lumetri', () => {
  const lumetri = (extra: Record<string, unknown> = {}) => ({ id: 'effect_1_lumetri01', effectId: 'lumetri-color', enabled: true, order: 0, parameters: { exposure: { defaultValue: 1, keyframes: [] }, ...extra } });
  // Fix round 1 N1: writeEffects uses error codes §7 l.188 EFFECT_DEPRECATED (tickets appendix l.403); the UI intent keeps UNKNOWN_EFFECT (§7 l.187).
  it('adding it: the intent is refused UNKNOWN_EFFECT "is deprecated"; writeEffects EFFECT_DEPRECATED with the §7 text and the replacement note', () => {
    const e = editor(), before = json(e.doc);
    const out = e.intent({ type: 'addEffect', itemIds: ['v1'], effectId: 'lumetri-color' });
    refusedAs(e, before, 0, out, 'UNKNOWN_EFFECT'); expect((out as any).message).toContain('is deprecated');
    const r = e.call('writeEffects', { itemId: 'v1', add: [{ effectId: 'lumetri-color' }] }) as any;
    expect(r).toMatchObject({ success: false, code: 'EFFECT_DEPRECATED', error: 'Effect deprecated',
      message: "'lumetri-color' is retired and can't be newly added. Existing instances remain editable. Use Color Wheels, Levels or Curves instead." });
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0);
    // Not retired: an unknown id keeps UNKNOWN_EFFECT; a retired id on an item type without effects keeps UNSUPPORTED_ITEM_TYPE.
    expect(e.call('writeEffects', { itemId: 'v1', add: [{ effectId: 'not-an-effect' }] })).toMatchObject({ success: false, code: 'UNKNOWN_EFFECT' });
    expect(e.call('writeEffects', { itemId: 'a1', add: [{ effectId: 'lumetri-color' }] })).toMatchObject({ success: false, code: 'UNSUPPORTED_ITEM_TYPE' });
  });
  it('it never appears among the discoverable effects', () => {
    expect(EFFECTS.filter(x => x.visibility === 'discoverable').map(x => x.id)).not.toContain('lumetri-color');
    expect(EFFECTS.filter(x => x.visibility === 'retired').map(x => x.id)).toEqual(['lumetri-color']);
  });
  it('an existing instance loads in the stack, edits (values, toggle, move, remove) and can be keyframed', () => {
    const doc = base(); itemOf(doc, 'v1').effects = [lumetri(), { id: 'effect_1_gray00001', effectId: 'grayscale', enabled: true, order: 1, parameters: { amount: { defaultValue: 100, keyframes: [] } } }];
    const e = editor(doc);
    expect(types(e)).toEqual(['lumetri-color', 'grayscale']);
    expect(e.intent({ type: 'effectParams', itemId: 'v1', instanceId: 'effect_1_lumetri01', values: { exposure: 2.5, saturation: 120 } })).toEqual({ ok: true });
    expect(stack(e)[0].parameters.exposure.defaultValue).toBe(2.5); expect(stack(e)[0].parameters.saturation.defaultValue).toBe(120);
    expect(e.intent({ type: 'effectParams', itemId: 'v1', instanceId: 'effect_1_lumetri01', values: { exposure: 4.5 } })).toMatchObject({ ok: false, code: 'INVALID_PARAM_VALUE' }); // exposure ±4
    expect(e.call('writeKeyframes', { itemId: 'v1', effectId: 'lumetri-color_1', payload: { exposure: { replace: [{ time: 0, value: 0 }, { time: 2, value: 2 }] } } })).toMatchObject({ success: true });
    expect(e.call('writeEffects', { itemId: 'v1', effects: { 'lumetri-color_1': { enabled: false } } })).toMatchObject({ success: true });
    expect(stack(e)[0].enabled).toBe(false);
    expect(e.intent({ type: 'moveEffect', itemId: 'v1', instanceId: 'effect_1_lumetri01', to: 1 })).toEqual({ ok: true });
    expect(types(e)).toEqual(['grayscale', 'lumetri-color']);
    expect(e.intent({ type: 'removeEffect', itemId: 'v1', instanceId: 'effect_1_lumetri01' })).toEqual({ ok: true });
    expect(types(e)).toEqual(['grayscale']);
  });
});

describe('T10 Color card block (part 4 §49.1 [C]): the FIRST color-wheels / curves / lut instance', () => {
  it('the first edit creates one instance appended at the END of the stack (after the effects already there), one "Edit items" entry', () => {
    const e = editor(); add(e, 'grayscale'); add(e, 'vignette');
    expect(colour(e, 'color-wheels', { exposure: 0.5 })).toEqual({ ok: true });
    expect(types(e)).toEqual(['grayscale', 'vignette', 'color-wheels']);
    const cw = stack(e)[2];
    expect(cw.id).toMatch(ID); expect(cw.parameters.exposure.defaultValue).toBe(0.5); expect(cw.parameters.toneCurve.defaultValue).toBe(2); expect(cw.parameters.contrast.defaultValue).toBe(1);
    expect(e.bus.undoStack).toHaveLength(3); expect(lastLabel(e)).toMatchObject({ label: 'Edit items', source: 'user' });
  });
  it('later edits change the same instance (no second one), keep its keyframes, and leave other parameters alone', () => {
    const e = editor(); colour(e, 'color-wheels', { exposure: 0.5, saturation: 10 });
    e.call('writeKeyframes', { itemId: 'v1', effectId: 'color-wheels_1', payload: { exposure: { replace: [{ time: 0, value: 0 }, { time: 2, value: 1 }] } } });
    const id = ids(e)[0];
    colour(e, 'color-wheels', { exposure: -1, shadowsWheel: { angle: 120, distance: 0.4 } });
    expect(types(e)).toEqual(['color-wheels']); expect(ids(e)).toEqual([id]);
    const p = stack(e)[0].parameters;
    expect(p.exposure.defaultValue).toBe(-1); expect(p.exposure.keyframes).toHaveLength(2); expect(p.saturation.defaultValue).toBe(10); expect(p.shadowsWheel.defaultValue).toEqual({ angle: 120, distance: 0.4 });
  });
  it('edits the FIRST instance when the item already holds two of the same type', () => {
    const e = editor(); add(e, 'color-wheels'); add(e, 'grayscale'); add(e, 'color-wheels');
    const [first, , second] = ids(e);
    colour(e, 'color-wheels', { exposure: 1 });
    expect(stack(e).find(x => x.id === first)!.parameters.exposure.defaultValue).toBe(1);
    expect(stack(e).find(x => x.id === second)!.parameters.exposure.defaultValue).toBe(0);
    expect(types(e)).toEqual(['color-wheels', 'grayscale', 'color-wheels']);
  });
  it('curves and lut create their own instances; the three are independent and each is appended in the order first edited', () => {
    const e = editor();
    colour(e, 'curves', { masterShadowY: 0.3 }); colour(e, 'color-wheels', { exposure: 0.2 }); colour(e, 'lut', { blend: 60 });
    expect(types(e)).toEqual(['curves', 'color-wheels', 'lut']);
    expect(stack(e)[0].parameters.masterShadowY.defaultValue).toBe(0.3); expect(stack(e)[2].parameters.blend.defaultValue).toBe(60);
  });
  it('a block edit on several items creates/edits one instance per item, in one entry', () => {
    const e = editor(); add(e, 'color-wheels', ['v2']);
    const n = e.bus.undoStack.length; colour(e, 'color-wheels', { exposure: 0.7 }, ['v1', 'v2']);
    expect(e.bus.undoStack).toHaveLength(n + 1); expect(types(e, 'v1')).toEqual(['color-wheels']); expect(types(e, 'v2')).toEqual(['color-wheels']);
    expect(stack(e, 'v1')[0].parameters.exposure.defaultValue).toBe(0.7); expect(stack(e, 'v2')[0].parameters.exposure.defaultValue).toBe(0.7);
  });
  it('out-of-range and unknown block values refuse and roll back (no half-created instance)', () => {
    const e = editor(), before = json(e.doc);
    refusedAs(e, before, 0, colour(e, 'color-wheels', { exposure: 9 }), 'INVALID_PARAM_VALUE');
    refusedAs(e, before, 0, colour(e, 'color-wheels', { shadowsWheel: { angle: 10, distance: 2 } }), 'INVALID_PARAM_VALUE');
    refusedAs(e, before, 0, colour(e, 'curves', { nope: 1 }), 'UNKNOWN_PARAMETERS');
    expect(stack(e)).toEqual([]);
  });
  it('bypassGrade toggles all three block instances (not other effects), in one entry; the same call re-enables them', () => {
    const e = editor(); colour(e, 'color-wheels', { exposure: 0.2 }); add(e, 'sepia'); colour(e, 'curves', { masterShadowY: 0.3 }); colour(e, 'lut', { blend: 50 });
    const n = e.bus.undoStack.length;
    expect(e.intent({ type: 'bypassGrade', itemIds: ['v1'], enabled: false })).toEqual({ ok: true });
    expect(stack(e).map(x => [x.effectId, x.enabled])).toEqual([['color-wheels', false], ['sepia', true], ['curves', false], ['lut', false]]);
    expect(e.bus.undoStack).toHaveLength(n + 1);
    e.intent({ type: 'bypassGrade', itemIds: ['v1'], enabled: true }); expect(stack(e).every(x => x.enabled)).toBe(true);
  });
  it('resetGrade deletes the three block instances and leaves the other effects (renumbered)', () => {
    const e = editor(); add(e, 'sepia'); colour(e, 'color-wheels', { exposure: 0.2 }); colour(e, 'curves', { masterShadowY: 0.3 }); colour(e, 'lut', { blend: 50 }); add(e, 'vignette');
    const n = e.bus.undoStack.length;
    expect(e.intent({ type: 'resetGrade', itemIds: ['v1'] })).toEqual({ ok: true });
    expect(types(e)).toEqual(['sepia', 'vignette']); expect(stack(e).map(x => x.order)).toEqual([0, 1]); expect(e.bus.undoStack).toHaveLength(n + 1);
    e.intent({ type: 'undo' }); expect(types(e)).toEqual(['sepia', 'color-wheels', 'curves', 'lut', 'vignette']);
  });
  it('after a reset the next edit creates a fresh instance (a new id, back at defaults except the edited value)', () => {
    const e = editor(); colour(e, 'color-wheels', { exposure: 0.9, saturation: 30 }); const old = ids(e)[0];
    e.intent({ type: 'resetGrade', itemIds: ['v1'] }); colour(e, 'color-wheels', { exposure: 0.1 });
    expect(ids(e)[0]).not.toBe(old); expect(stack(e)[0].parameters.saturation.defaultValue).toBe(0);
  });
  it('bypass / reset on an item with no block instance changes nothing and writes no entry', () => {
    const e = editor(); add(e, 'sepia'); const n = e.bus.undoStack.length, before = json(e.doc);
    e.intent({ type: 'bypassGrade', itemIds: ['v1'], enabled: false }); e.intent({ type: 'resetGrade', itemIds: ['v1'] });
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n);
  });
});
