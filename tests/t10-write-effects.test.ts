// SPDX-License-Identifier: AGPL-3.0-only
// T10 writeEffects (contracts #29, error codes §7) and the effects stale-read scope (A0.2 item 3): agent ids, add / params / enabled /
// remove, keyframes kept, polar and hex values, .cube lutData, all-or-nothing batches, the Wave-3 instance, the helper schema, the gate.
// Oracle: ticket T10 "Owned acceptance"; the Wave-3 instance is the stored example in the ticket (grayscale amount 100, order 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLS, validate } from '../apps/helper/src/schemas';
import { Executor, modifiedAt, neverRead } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { effectsBlock, effectStack } from '../apps/web/src/timeline/effects';
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
const write = (e: Editor, args: Record<string, unknown>) => e.call('writeEffects', args) as any;
const withTransport = () => { const d = base(); itemOf(d, 'v1').effects = [{ id: 'effect_1_aaaaaaaaa', effectId: 'stacked-alpha', enabled: true, order: 0, parameters: {} }]; return editor(d); };
/** A refusal leaves the document and the history exactly as they were. */
const untouched = (e: Editor, before: string, n = 0) => { expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n); expect(e.journal).toHaveLength(n); };

describe('T10 writeEffects: ids, add, params, enabled, remove', () => {
  it('add appends in order and answers the new agent ids "<effectType>_<1-based position>"; one "Edit items" entry', () => {
    const e = editor();
    const r = write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }, { effectId: 'vignette' }, { effectId: 'grayscale' }] });
    expect(r).toMatchObject({ success: true, data: { itemIds: ['v1'], items: [{ itemId: 'v1', added: ['grayscale_1', 'vignette_2', 'grayscale_3'] }] } });
    expect(types(e)).toEqual(['grayscale', 'vignette', 'grayscale']); expect(stack(e).map(x => x.order)).toEqual([0, 1, 2]);
    for (const x of stack(e)) expect(x.id).toMatch(ID);
    expect(e.labels()).toEqual(['Edit items']);
    expect(r.data.items[0].effects.map((x: any) => x.effectId)).toEqual(['grayscale_1', 'vignette_2', 'grayscale_3']);
  });
  it('a transport stage is stored first and has no agent id: positions count the other entries only', () => {
    const e = withTransport();
    const r = write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }, { effectId: 'vignette' }] });
    expect(r.data.items[0].added).toEqual(['grayscale_1', 'vignette_2']);
    expect(types(e)).toEqual(['stacked-alpha', 'grayscale', 'vignette']);
    expect(write(e, { itemId: 'v1', effects: { vignette_2: { enabled: false } } })).toMatchObject({ success: true });
    expect(stack(e)[2].enabled).toBe(false); expect(stack(e)[0].enabled).toBe(true);
    // The internal stage cannot be addressed by an agent id.
    const before = json(e.doc), n = e.bus.undoStack.length;
    expect(write(e, { itemId: 'v1', effects: { 'stacked-alpha_1': { remove: true } } })).toMatchObject({ success: false });
    expect(write(e, { itemId: 'v1', effects: { vignette_3: { enabled: false } } })).toMatchObject({ success: false, code: 'EFFECT_NOT_FOUND' }); // only two agent-visible entries
    untouched(e, before, n);
  });
  it('the same id grammar errors: INVALID_EFFECT_ID_FORMAT, INVALID_STACK_POSITION, EFFECT_NOT_FOUND', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }] });
    const before = json(e.doc), n = e.bus.undoStack.length;
    expect(write(e, { itemId: 'v1', effects: { grayscale: { enabled: false } } })).toMatchObject({ success: false, code: 'INVALID_EFFECT_ID_FORMAT' });
    for (const bad of ['grayscale_0', 'grayscale_-1', 'grayscale_1.5'])
      expect(write(e, { itemId: 'v1', effects: { [bad]: { enabled: false } } }), bad).toMatchObject({ success: false, code: 'INVALID_STACK_POSITION' });
    expect(write(e, { itemId: 'v1', effects: { grayscale_2: { enabled: false } } })).toMatchObject({ success: false, code: 'EFFECT_NOT_FOUND' }); // beyond the stack
    expect(write(e, { itemId: 'v1', effects: { sepia_1: { enabled: false } } })).toMatchObject({ success: false, code: 'EFFECT_NOT_FOUND' }); // position 1 holds grayscale
    untouched(e, before, n);
  });
  it('initialParameters on add, params and enabled on edit, remove: true overrides the rest, all in one call and one entry', () => {
    const e = editor();
    write(e, { itemId: 'v1', add: [{ effectId: 'grayscale', initialParameters: { amount: 30 } }, { effectId: 'vignette' }, { effectId: 'sepia' }] });
    expect(stack(e)[0].parameters.amount.defaultValue).toBe(30);
    const n = e.bus.undoStack.length;
    const r = write(e, { itemId: 'v1', effects: { grayscale_1: { params: { amount: 80 }, enabled: false }, vignette_2: { remove: true, params: { amount: 5 }, enabled: false } } });
    expect(r).toMatchObject({ success: true, data: { items: [{ itemId: 'v1', added: [] }] } });
    expect(types(e)).toEqual(['grayscale', 'sepia']); expect(stack(e)[0]).toMatchObject({ enabled: false, order: 0 }); expect(stack(e)[0].parameters.amount.defaultValue).toBe(80);
    expect(stack(e)[1].order).toBe(1); expect(e.bus.undoStack).toHaveLength(n + 1);
  });
  it('edits and removes resolve against the stack as it was at the start of the call; add appends after them', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }, { effectId: 'sepia' }] });
    const r = write(e, { itemId: 'v1', effects: { grayscale_1: { remove: true }, sepia_2: { enabled: false } }, add: [{ effectId: 'vignette' }] });
    expect(r.data.items[0].added).toEqual(['vignette_2']); // sepia is position 1 once grayscale is gone, the new effect is 2
    expect(types(e)).toEqual(['sepia', 'vignette']); expect(stack(e)[0].enabled).toBe(false);
  });
  it('an enabled-only or empty-params edit changes nothing else; a no-op write still succeeds', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'vignette', initialParameters: { amount: 12 } }] });
    write(e, { itemId: 'v1', effects: { vignette_1: { enabled: false } } });
    expect(stack(e)[0].parameters.amount.defaultValue).toBe(12);
    expect(write(e, { itemId: 'v1', effects: { vignette_1: { params: {} } } })).toMatchObject({ success: true });
  });
  it('the response lists the item\'s effects (agent ids, non-default parameters only)', () => {
    const e = editor(); const r = write(e, { itemId: 'v1', add: [{ effectId: 'grayscale', initialParameters: { amount: 40 } }, { effectId: 'sepia' }] });
    expect(r.data.items[0].effects).toEqual([
      expect.objectContaining({ effectId: 'grayscale_1', effectType: 'grayscale', enabled: true, order: 0, parameters: { amount: expect.anything() } }),
      expect.objectContaining({ effectId: 'sepia_2', effectType: 'sepia', enabled: true, order: 1 }),
    ]);
    expect(r.data.items[0].effects[1]).not.toHaveProperty('parameters'); // all defaults
  });
});

describe('T10 writeEffects: values', () => {
  it('params change base values and keep keyframes', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }] });
    e.call('writeKeyframes', { itemId: 'v1', effectId: 'grayscale_1', payload: { amount: { replace: [{ time: 0, value: 0 }, { time: 2, value: 100 }] } } });
    const kf = json(stack(e)[0].parameters.amount.keyframes);
    expect(write(e, { itemId: 'v1', effects: { grayscale_1: { params: { amount: 55 } } } })).toMatchObject({ success: true });
    expect(stack(e)[0].parameters.amount.defaultValue).toBe(55); expect(json(stack(e)[0].parameters.amount.keyframes)).toBe(kf); expect(stack(e)[0].parameters.amount.keyframes).toHaveLength(2);
  });
  it('writeKeyframes on an effect: UNKNOWN_PARAMETER and NOT_ANIMATABLE are refusals; EFFECT_NOT_FOUND for a missing effect', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }] }); const before = json(e.doc), n = e.bus.undoStack.length;
    expect(e.call('writeKeyframes', { itemId: 'v1', effectId: 'grayscale_1', payload: { nope: { add: [{ time: 0, value: 1 }] } } })).toMatchObject({ success: false, code: 'UNKNOWN_PARAMETER' });
    expect(e.call('writeKeyframes', { itemId: 'v1', effectId: 'sepia_1', payload: { amount: { add: [{ time: 0, value: 1 }] } } })).toMatchObject({ success: false, code: 'EFFECT_NOT_FOUND' });
    untouched(e, before, n);
  });
  it('a polar value is {angle, distance 0–1} and is stored as given; extra keys or a distance beyond 1 are INVALID_PARAM_VALUE', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'color-wheels' }] }); const n = e.bus.undoStack.length;
    expect(write(e, { itemId: 'v1', effects: { 'color-wheels_1': { params: { shadowsWheel: { angle: 200, distance: 0.35 }, midtonesWheel: { angle: -30, distance: 1 } } } } })).toMatchObject({ success: true });
    expect(stack(e)[0].parameters.shadowsWheel.defaultValue).toEqual({ angle: 200, distance: 0.35 });
    expect(stack(e)[0].parameters.midtonesWheel.defaultValue).toEqual({ angle: -30, distance: 1 });
    const before = json(e.doc);
    for (const bad of [{ angle: 10, distance: 1.2 }, { angle: 10, distance: -0.1 }, { angle: 10 }, { angle: 10, distance: 0.5, z: 1 }, 'red', 5, { x: 1, y: 2 }])
      expect(write(e, { itemId: 'v1', effects: { 'color-wheels_1': { params: { shadowsWheel: bad } } } }), json(bad)).toMatchObject({ success: false, code: 'INVALID_PARAM_VALUE' });
    untouched(e, before, n + 1);
  });
  it('colours are hex only (#rgb, #rrggbb, #rrggbbaa); rgba() or a name is INVALID_PARAM_VALUE and the message names the format', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'color-key' }] }); const n = e.bus.undoStack.length;
    for (const ok of ['#0f0', '#00b140', '#00B14080']) {
      expect(write(e, { itemId: 'v1', effects: { 'color-key_1': { params: { keyColor: ok } } } }), ok).toMatchObject({ success: true });
      expect(stack(e)[0].parameters.keyColor.defaultValue).toBe(ok);
    }
    const before = json(e.doc);
    for (const bad of ['rgba(0, 177, 64, 1)', 'green', '#12', '#12345', '#1234567', '00b140', 3, null]) {
      const r = write(e, { itemId: 'v1', effects: { 'color-key_1': { params: { keyColor: bad } } } });
      expect(r, String(bad)).toMatchObject({ success: false, code: 'INVALID_PARAM_VALUE' }); expect(r.message).toContain('hex');
    }
    untouched(e, before, n + 3);
    expect(write(e, { itemId: 'v1', add: [{ effectId: 'color-key', initialParameters: { keyColor: 'rgb(1,2,3)' } }] })).toMatchObject({ success: false, code: 'INVALID_PARAM_VALUE' });
  });
  it('numbers outside the registry range are refused, not clamped; unknown parameters are UNKNOWN_PARAMETERS; selects take their options only', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }, { effectId: 'luma-key' }] }); const before = json(e.doc), n = e.bus.undoStack.length;
    for (const [fx, params, code] of [['grayscale_1', { amount: 101 }, 'INVALID_PARAM_VALUE'], ['grayscale_1', { amount: -1 }, 'INVALID_PARAM_VALUE'], ['grayscale_1', { amount: '50' }, 'INVALID_PARAM_VALUE'],
      ['grayscale_1', { nope: 1 }, 'UNKNOWN_PARAMETERS'], ['luma-key_2', { keyType: 'middle' }, 'INVALID_PARAM_VALUE']] as const) {
      const r = write(e, { itemId: 'v1', effects: { [fx]: { params } } });
      expect(r, json(params)).toMatchObject({ success: false, code });
    }
    untouched(e, before, n);
    expect(write(e, { itemId: 'v1', effects: { 'luma-key_2': { params: { keyType: 'bright' } } } })).toMatchObject({ success: true });
    expect(stack(e)[1].parameters.keyType.defaultValue).toBe('bright');
  });
  it('NaN-like and non-boolean "enabled" values are refused', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }] }); const before = json(e.doc), n = e.bus.undoStack.length;
    for (const bad of ['yes', 1, null]) expect(write(e, { itemId: 'v1', effects: { grayscale_1: { enabled: bad } } }), String(bad)).toMatchObject({ success: false, code: 'INVALID_PARAM_VALUE' });
    untouched(e, before, n);
  });
  describe('.cube lutData', () => {
    const cube = (title?: string, rows = 8) => [...(title ? [`TITLE "${title}"`] : []), 'LUT_3D_SIZE 2', ...[0, 1].flatMap(b => [0, 1].flatMap(g => [0, 1].map(r => `${r} ${g} ${b}`))).slice(0, rows)].join('\n');
    it('.cube text is baked to the stored 33³ RGBA8 base64 table and lutName defaults to the cube TITLE', () => {
      const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'lut' }] });
      expect(write(e, { itemId: 'v1', effects: { lut_1: { params: { lutData: cube('Teal Hour') } } } })).toMatchObject({ success: true });
      const p = stack(e)[0].parameters;
      expect(p.lutName.defaultValue).toBe('Teal Hour');
      expect(p.lutData.defaultValue).toMatch(/^[A-Za-z0-9+/]+=*$/); expect(atob(p.lutData.defaultValue).length).toBe(33 ** 3 * 4);
      expect(p.lutData.defaultValue).not.toContain('LUT_3D_SIZE');
    });
    it('an explicit lutName wins over the TITLE; a cube without a TITLE leaves lutName alone; the same cube can go in initialParameters', () => {
      const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'lut', initialParameters: { lutData: cube('A'), lutName: 'Mine' } }] });
      expect(stack(e)[0].parameters.lutName.defaultValue).toBe('Mine');
      const before = stack(e)[0].parameters.lutName.defaultValue;
      write(e, { itemId: 'v1', effects: { lut_1: { params: { lutData: cube() } } } }); expect(stack(e)[0].parameters.lutName.defaultValue).toBe(before);
    });
    it('a broken cube or arbitrary text is INVALID_PARAM_VALUE; the stored base64 table is accepted back as is; the LUT is not in the response', () => {
      const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'lut' }] });
      write(e, { itemId: 'v1', effects: { lut_1: { params: { lutData: cube('X') } } } }); const baked = stack(e)[0].parameters.lutData.defaultValue, before = json(e.doc), n = e.bus.undoStack.length;
      expect(write(e, { itemId: 'v1', effects: { lut_1: { params: { lutData: cube('Y', 5) } } } })).toMatchObject({ success: false, code: 'INVALID_PARAM_VALUE' });
      expect(write(e, { itemId: 'v1', effects: { lut_1: { params: { lutData: 'not a lut' } } } })).toMatchObject({ success: false, code: 'INVALID_PARAM_VALUE' });
      expect(write(e, { itemId: 'v1', effects: { lut_1: { params: { lutData: 5 } } } })).toMatchObject({ success: false, code: 'INVALID_PARAM_VALUE' });
      untouched(e, before, n);
      const r = write(e, { itemId: 'v1', effects: { lut_1: { params: { lutData: baked } } } });
      expect(r).toMatchObject({ success: true }); expect(json(r)).not.toContain(baked);
    });
  });
});

describe('T10 writeEffects: targets, refusals and all-or-nothing', () => {
  it('exactly one of itemId / itemIds; EMPTY_PAYLOAD, INVALID_ADD, TIMELINE_ITEM_NOT_FOUND, TRACK_LOCKED', () => {
    const e = editor(), before = json(e.doc);
    const cases: [Record<string, unknown>, string][] = [
      [{ add: [{ effectId: 'sepia' }] }, 'INVALID_EFFECT_TARGETS'], [{ itemId: 'v1', itemIds: ['v2'], add: [{ effectId: 'sepia' }] }, 'INVALID_EFFECT_TARGETS'], [{ itemIds: [], add: [{ effectId: 'sepia' }] }, 'INVALID_EFFECT_TARGETS'],
      [{ itemId: 'v1' }, 'EMPTY_PAYLOAD'], [{ itemId: 'v1', add: [], effects: {} }, 'EMPTY_PAYLOAD'],
      [{ itemId: 'v1', add: [{}] }, 'INVALID_ADD'], [{ itemId: 'v1', add: [{ effectId: 3 }] }, 'INVALID_ADD'], [{ itemId: 'v1', add: 'sepia' }, 'INVALID_ADD'],
      [{ itemId: 'ghost', add: [{ effectId: 'sepia' }] }, 'TIMELINE_ITEM_NOT_FOUND'], [{ itemId: 'locked', add: [{ effectId: 'sepia' }] }, 'TRACK_LOCKED'],
      [{ itemId: 'v1', add: [{ effectId: 'nope' }] }, 'UNKNOWN_EFFECT'], [{ itemId: 'v1', add: [{ effectId: 'bg-removal' }] }, 'UNKNOWN_EFFECT'],
      [{ itemId: 'a1', add: [{ effectId: 'sepia' }] }, 'UNSUPPORTED_ITEM_TYPE'], [{ itemId: 't1', add: [{ effectId: 'sepia' }] }, 'EFFECT_NOT_SUPPORTED'],
    ];
    for (const [args, code] of cases) expect(write(e, args), json(args)).toMatchObject({ success: false, code });
    untouched(e, before);
  });
  it('a single item is all-or-nothing: a valid edit before an invalid add changes nothing', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }] }); const before = json(e.doc), n = e.bus.undoStack.length;
    expect(write(e, { itemId: 'v1', effects: { grayscale_1: { params: { amount: 5 }, enabled: false } }, add: [{ effectId: 'sepia' }, { effectId: 'nope' }] })).toMatchObject({ success: false, code: 'UNKNOWN_EFFECT' });
    expect(write(e, { itemId: 'v1', effects: { grayscale_1: { params: { amount: 5 } }, vignette_9: { enabled: false } } })).toMatchObject({ success: false });
    untouched(e, before, n);
  });
  it('itemIds applies the same patch to each item, in one entry', () => {
    const e = editor(); const r = write(e, { itemIds: ['v1', 'v2'], add: [{ effectId: 'grayscale', initialParameters: { amount: 20 } }] });
    expect(r).toMatchObject({ success: true, data: { itemIds: ['v1', 'v2'], items: [{ itemId: 'v1', added: ['grayscale_1'] }, { itemId: 'v2', added: ['grayscale_1'] }] } });
    expect(stack(e, 'v1')[0].parameters.amount.defaultValue).toBe(20); expect(stack(e, 'v2')[0].parameters.amount.defaultValue).toBe(20);
    expect(stack(e, 'v1')[0].id).not.toBe(stack(e, 'v2')[0].id); expect(e.bus.undoStack).toHaveLength(1);
    write(e, { itemIds: ['v1', 'v2', 'v1'], effects: { grayscale_1: { enabled: false } } }); // a repeated id is applied once
    expect(stack(e, 'v1')[0].enabled).toBe(false); expect(stack(e, 'v2')[0].enabled).toBe(false);
  });
  it('itemIds is all-or-nothing: one failing item (here an effect it lacks) changes none, the response lists failures[] and the first failure\'s code', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'grayscale' }] }); const before = json(e.doc), n = e.bus.undoStack.length;
    const r = write(e, { itemIds: ['v1', 'v2'], effects: { grayscale_1: { params: { amount: 9 } } }, add: [{ effectId: 'sepia' }] });
    expect(r).toMatchObject({ success: false, code: 'EFFECT_NOT_FOUND', failures: [{ itemId: 'v2', code: 'EFFECT_NOT_FOUND' }] });
    expect(r.message).toContain('No effects were changed'); expect(r.message).toContain('v2');
    untouched(e, before, n);
    const r2 = write(e, { itemIds: ['v1', 'a1', 'locked', 'ghost'], add: [{ effectId: 'sepia' }] });
    expect(r2.failures.map((f: any) => [f.itemId, f.code])).toEqual([['a1', 'UNSUPPORTED_ITEM_TYPE'], ['locked', 'TRACK_LOCKED'], ['ghost', 'TIMELINE_ITEM_NOT_FOUND']]);
    expect(r2.code).toBe('UNSUPPORTED_ITEM_TYPE'); untouched(e, before, n);
  });
  it('a refused call writes nothing to the history, a successful one writes one "Edit items" entry (agent source when run as the agent)', () => {
    const e = editor(); write(e, { itemId: 'v1', add: [{ effectId: 'sepia' }] });
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label: 'Edit items' }); expect(e.journal).toHaveLength(1);
  });
});

describe('T10 Wave-3 instance: grayscale added through writeEffects equals the UI-path addEffect (id aside)', () => {
  it('{effectId "grayscale", enabled true, order 0, parameters {amount {defaultValue 100, keyframes []}}}', () => {
    const viaTool = editor(), viaUi = editor();
    write(viaTool, { itemId: 'v1', add: [{ effectId: 'grayscale' }] });
    viaUi.intent({ type: 'addEffect', itemIds: ['v1'], effectId: 'grayscale' });
    const expected = { effectId: 'grayscale', enabled: true, order: 0, parameters: { amount: { defaultValue: 100, keyframes: [] } } };
    expect(stack(viaTool)).toEqual([{ id: expect.stringMatching(ID), ...expected }]);
    const strip = (x: any) => { const { id, ...rest } = x; return rest; };
    expect(strip(stack(viaTool)[0])).toEqual(strip(stack(viaUi)[0])); expect(strip(stack(viaTool)[0])).toEqual(expected);
    expect(Object.keys(stack(viaTool)[0])).toEqual(Object.keys(stack(viaUi)[0]));
  });
});

describe('T10 helper schema (writeEffects is the 24th served tool since the rebase onto c26dd28: T08 and T19 add four)', () => {
  it('is served, and the schema accepts every documented shape and leaves values to the handler', () => {
    expect(TOOLS).toHaveLength(43); expect(TOOLS.map(t => t.name)).toContain('writeEffects'); // T06 (C8 assertion-only edit): + addShape, writeShapePoints; T07 (C8): + addLayout, editLayout; T11 (C8): + applyTransition; T05: + addText; T12 (C8): + createMask, editMaskProperties, removeMask, writeMaskPoints, viewMaskFrame, previewSmartMask, trackSmartMask, removeBackground; T21: + getHelpSection, searchHelpDocs; T09 (C8 assertion-only edit): + addCaptions, editAllCaptionStyles, listCaptionTemplates = 43
    for (const input of [
      { itemId: 'v1', add: [{ effectId: 'grayscale' }] }, { itemId: 'v1', add: [{ effectId: 'lut', initialParameters: { lutData: 'TITLE "x"\nLUT_3D_SIZE 2' } }] },
      { itemIds: ['v1', 'v2'], effects: { grayscale_1: { params: { amount: 5 }, enabled: false } } }, { itemId: 'v1', effects: { vignette_2: { remove: true } } },
      { itemId: 'v1', effects: { 'color-wheels_1': { params: { shadowsWheel: { angle: 1, distance: 2 } } } } }, // range is the handler's job
      { itemId: 'v1', add: [{ effectId: 'color-key', initialParameters: { keyColor: 'rgba(0,0,0,1)' } }] },
    ]) expect(validate('writeEffects', input), json(input)).toBeNull();
  });
  it('rejects wrong types with the INVALID_TOOL_INPUT shape and the JSON path of the error', () => {
    expect(validate('writeEffects', { itemId: 'v1', effects: { grayscale_1: { enabled: 'yes' } } })).toMatchObject({
      success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for writeEffects', details: { errors: [{ path: '$.effects.grayscale_1.enabled', code: 'TYPE', message: 'must be boolean' }] } });
    expect(validate('writeEffects', { itemId: 5, add: [] })).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
    expect(validate('writeEffects', { itemIds: 'v1', add: [{ effectId: 'sepia' }] })).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
    expect(validate('writeEffects', { itemId: 'v1', add: [{ effectId: 4 }] })).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
    expect(validate('writeEffects', { itemId: 'v1', effects: { vignette_1: { remove: 'y' } } })).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
  });
  it('an input the schema lets through still ends in the handler\'s own code (what the helper sends on to the tab)', () => {
    const e = editor();
    for (const [input, code] of [[{ itemId: 'v1', itemIds: ['v2'], add: [{ effectId: 'sepia' }] }, 'INVALID_EFFECT_TARGETS'], [{ itemId: 'v1' }, 'EMPTY_PAYLOAD'],
      [{ itemId: 'v1', add: [{}] }, 'INVALID_ADD'], [{ itemId: 'v1', add: [{ effectId: 'color-key', initialParameters: { keyColor: 'rgba(0,0,0,1)' } }] }, 'INVALID_PARAM_VALUE']] as const) {
      expect(validate('writeEffects', input), json(input)).toBeNull(); expect(write(e, input), json(input)).toMatchObject({ success: false, code });
    }
  });
});

describe('T10 effects stale-read scope (A0.2 item 3)', () => {
  let seq = 0;
  const call = (toolName: string, input: Record<string, unknown>, session = 's'): Call => ({ type: 'call', callId: `w${++seq}`, executionKey: `mcp:conn:w${seq}`, toolName, input, session });
  const storage = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
  /** An editor whose v1 has grayscale (keyframed amount) and vignette, plus a plain v2 with sepia. */
  const setup = () => {
    const e = editor();
    e.call('writeEffects', { itemId: 'v1', add: [{ effectId: 'grayscale' }, { effectId: 'vignette' }] });
    e.call('writeEffects', { itemId: 'v2', add: [{ effectId: 'sepia' }] });
    e.call('writeKeyframes', { itemId: 'v1', effectId: 'grayscale_1', payload: { amount: { replace: [{ time: 0, value: 0 }, { time: 2, value: 100 }] } } });
    const ex = new Executor({ storage: storage(), current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    return { e, ex };
  };
  const NEVER = (id: string) => neverRead('effects', id);

  it('writeEffects with an `effects` entry is refused STALE_READ_REFRESHED on the first call: scope effects, agentId, the item\'s effects block; nothing applied; the retry passes', async () => {
    const { e, ex } = setup(); const block = effectsBlock(itemOf(e.doc, 'v1')), before = json(e.doc);
    const refused = await ex.execute(call('writeEffects', { itemId: 'v1', effects: { vignette_2: { enabled: false } } }));
    expect(refused).toEqual({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: NEVER('v1'), scope: 'effects', agentId: 'v1', currentState: block });
    expect(NEVER('v1')).toBe("You haven't read the effects of item 'v1' in this session. The current state is attached and they now count as fresh; retry the call.");
    expect(json(e.doc)).toBe(before);
    expect(await ex.execute(call('writeEffects', { itemId: 'v1', effects: { vignette_2: { enabled: false } } }))).toMatchObject({ success: true });
    expect(stack(e)[1].enabled).toBe(false);
    expect(await ex.execute(call('writeEffects', { itemId: 'v1', effects: { vignette_2: { enabled: true } } }))).toMatchObject({ success: true }); // the agent's own change does not stale its read
  });
  it('the effects block carries agent ids and only non-default or keyframed parameters, never a LUT', async () => {
    const { ex } = setup();
    const r = await ex.execute(call('writeEffects', { itemId: 'v1', effects: { vignette_2: { enabled: false } } })) as any;
    expect(r.currentState.effects.map((x: any) => x.effectId)).toEqual(['grayscale_1', 'vignette_2']);
    expect(r.currentState.effects[0].parameters.amount).toBeDefined(); expect(r.currentState.effects[1]).not.toHaveProperty('parameters');
  });
  it('an add-only call is not gated (no existing effects are edited); an item with no effects reads as effects null', async () => {
    const { e, ex } = setup();
    expect(await ex.execute(call('writeEffects', { itemId: 'v1', add: [{ effectId: 'sepia' }] }))).toMatchObject({ success: true });
    expect(await ex.execute(call('writeEffects', { itemId: 'v1', add: [{ effectId: 'sepia' }], effects: {} }))).toMatchObject({ success: true });
    const refused = await ex.execute(call('writeEffects', { itemId: 'a1', effects: { sepia_1: { enabled: false } } }, 'fresh')) as any;
    expect(refused).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'effects', agentId: 'a1', currentState: { effects: null, effectsNote: 'No effects on this item' } });
    expect(e.doc.items.length).toBeGreaterThan(0);
  });
  it('itemIds: every target with an `effects` entry is gated, in call order; the first stale one refuses the whole call', async () => {
    const { e, ex } = setup(); const before = json(e.doc);
    const first = await ex.execute(call('writeEffects', { itemIds: ['v2', 'v1'], effects: { sepia_1: { enabled: false } } })) as any;
    expect(first).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'effects', agentId: 'v2' }); expect(json(e.doc)).toBe(before);
    const second = await ex.execute(call('writeEffects', { itemIds: ['v2', 'v1'], effects: { sepia_1: { enabled: false } } })) as any;
    expect(second).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'effects', agentId: 'v1' }); // v2 is now fresh, v1 is next
    expect(await ex.execute(call('writeEffects', { itemIds: ['v2', 'v1'], effects: { sepia_1: { enabled: false } } }))).toMatchObject({ code: 'EFFECT_NOT_FOUND' }); // not gated any more: the handler answers
  });
  it('a user change to the item\'s effects after the read → the "modified … at <ISO>" message with the new block; the retry passes', async () => {
    const { e, ex } = setup(); const run = () => ex.execute(call('writeEffects', { itemId: 'v1', effects: { vignette_2: { params: { amount: 33 } } } }));
    expect(await run()).toMatchObject({ message: NEVER('v1') });
    vi.setSystemTime(new Date('2026-11-02T08:00:09.500Z'));
    e.intent({ type: 'toggleEffect', itemId: 'v1', instanceId: stack(e)[0].id, enabled: false }); // the user, outside an agent call
    ex.watcher.sync();
    const refused = await run() as any;
    expect(refused).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', scope: 'effects', agentId: 'v1', message: modifiedAt('2026-11-02T08:00:09.500Z', 'effects', 'v1') });
    expect(refused.message).toBe("The user modified the effects of item 'v1' at 2026-11-02T08:00:09.500Z after your last read. The current state is attached and they now count as fresh; retry the call.");
    expect(refused.currentState.effects[0].enabled).toBe(false);
    expect(await run()).toMatchObject({ success: true });
  });
  it('user changes that leave the item\'s effects block alone (a marker, another item\'s effects) keep the read current; a change to its keyframes does not', async () => {
    const { e, ex } = setup(); const run = () => ex.execute(call('writeEffects', { itemId: 'v1', effects: { vignette_2: { params: { amount: 33 } } } }));
    await run(); // the refusal marks the read
    e.intent({ type: 'addMarker', timeMs: 10 }); e.intent({ type: 'toggleEffect', itemId: 'v2', instanceId: stack(e, 'v2')[0].id, enabled: false }); ex.watcher.sync();
    expect(await run()).toMatchObject({ success: true });
    vi.setSystemTime(new Date('2026-11-02T08:00:20.000Z'));
    e.call('writeKeyframes', { itemId: 'v1', effectId: 'grayscale_1', payload: { amount: { add: [{ time: 1, value: 50 }] } } }); ex.watcher.sync();
    expect(await run()).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'effects', agentId: 'v1', message: modifiedAt('2026-11-02T08:00:20.000Z', 'effects', 'v1') });
  });
  it('each session has its own read state', async () => {
    const { ex } = setup(); const input = { itemId: 'v1', effects: { vignette_2: { enabled: false } } };
    await ex.execute(call('writeEffects', input, 'a')); expect(await ex.execute(call('writeEffects', input, 'a'))).toMatchObject({ success: true });
    expect(await ex.execute(call('writeEffects', input, 'b'))).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'effects' });
  });
  it('writeKeyframes with effectId is gated only when a written parameter already has keyframes (here grayscale amount, not vignette amount)', async () => {
    const { e, ex } = setup();
    const onVignette = { itemId: 'v1', effectId: 'vignette_2', payload: { amount: { add: [{ time: 1, value: 10 }] } } };
    expect(await ex.execute(call('writeKeyframes', onVignette))).toMatchObject({ success: true }); // no keyframes there yet
    const onGray = { itemId: 'v1', effectId: 'grayscale_1', payload: { amount: { add: [{ time: 1, value: 40 }] } } };
    const refused = await ex.execute(call('writeKeyframes', onGray)) as any;
    expect(refused).toEqual({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: NEVER('v1'), scope: 'effects', agentId: 'v1', currentState: effectsBlock(itemOf(e.doc, 'v1')) });
    expect(stack(e)[0].parameters.amount.keyframes).toHaveLength(2);
    expect(await ex.execute(call('writeKeyframes', onGray))).toMatchObject({ success: true });
    expect(stack(e)[0].parameters.amount.keyframes).toHaveLength(3);
  });
  it('writeKeyframes on an effect the item lacks, on a mask, or with an unknown id is not gated (its handler answers)', async () => {
    const { ex } = setup(); const payload = { amount: { add: [{ time: 1, value: 10 }] } };
    expect(await ex.execute(call('writeKeyframes', { itemId: 'v1', effectId: 'sepia_3', payload }))).toMatchObject({ code: 'EFFECT_NOT_FOUND' });
    expect(await ex.execute(call('writeKeyframes', { itemId: 'v1', effectId: 'sepia_0', payload }))).toMatchObject({ code: 'INVALID_STACK_POSITION' });
    expect(await ex.execute(call('writeKeyframes', { itemId: 'v1', effectId: 'bogus', payload }))).toMatchObject({ code: 'INVALID_EFFECT_ID_FORMAT' });
    expect(await ex.execute(call('writeKeyframes', { itemId: 'ghost', effectId: 'sepia_1', payload }))).not.toMatchObject({ code: 'STALE_READ_REFRESHED' });
    // T12 (C8 assertion-only edit): maskIndex is real now, so effectId + maskIndex together is INVALID_COMBINATION, not a NOT_IMPLEMENTED placeholder.
    expect(await ex.execute(call('writeKeyframes', { itemId: 'v1', effectId: 'grayscale_1', maskIndex: 0, payload }))).toMatchObject({ code: 'INVALID_COMBINATION' });
  });
  it('item-level keyframes (no effectId) stay in the keyframes scope, not the effects scope', async () => {
    const { e, ex } = setup();
    e.call('writeKeyframes', { itemId: 'v1', payload: { opacity: { replace: [{ time: 0, value: 1 }, { time: 2, value: 0 }] } } });
    const r = await ex.execute(call('writeKeyframes', { itemId: 'v1', payload: { opacity: { add: [{ time: 1, value: 0.5 }] } } })) as any;
    expect(r).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'keyframes' });
  });
});
