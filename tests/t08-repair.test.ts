// SPDX-License-Identifier: AGPL-3.0-only
// T08 motion-graphic repair (F27 (a), mock model): at most 2 attempts, each result compiled and rendered (validate); the second request carries the first attempt's
// code and renderer error; a fix is saved (one undo step) only if the item did not change meanwhile; never automatic.
// Oracle: findings part 2 §33 and part 3 §43.17, ticket T08 "Repair tests", error ITEM_NOT_FOUND "Item not found". Documents store ms.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGED, CONNECT_A_MODEL, NOTHING_TO_REPAIR, REPAIR_FAILED, repairGraphic, setRepairModel, useRepairModel } from '../apps/web/src/mg/repair';
import type { RepairDeps, RepairModel, RepairRequest } from '../apps/web/src/mg/repair';
import type { RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => { resetIds(); setRepairModel(null); });

const SIZE = { width: 540, height: 960 };
const item = (...given: [unknown?]): RecordData => { const code = given.length ? given[0] : 'ORIG'; return { id: 'g1', type: 'motionGraphic', trackId: 'o1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, playbackRate: 1, sourceDuration: 4000,
  details: { name: 'Counter', ...code === undefined ? {} : { code } }, metadata: {}, properties: {}, masks: [], effects: [] }; };
type Step = { code: string } | { error: string } | Error;
/** A model that answers with the given steps in order (an Error is thrown), recording every request. */
function model(...steps: Step[]) {
  const requests: RepairRequest[] = [];
  const fn: RepairModel = vi.fn(async r => { requests.push(structuredClone(r)); const s = steps[requests.length - 1]; if (s instanceof Error) throw s; return s ?? { error: 'out of answers' }; });
  return { fn, requests };
}
/** validate answers with the given renderer errors in order (null = it renders). */
function setup(m: RepairModel | null, problems: (string | null)[] = [], over: Partial<RepairDeps> = {}, subject: RecordData = item()) {
  const validated: string[] = [];
  const deps: RepairDeps = { model: m, validate: vi.fn(async code => { validated.push(code); return problems[validated.length - 1] ?? null; }), current: () => structuredClone(subject), save: vi.fn(() => null), ...over };
  return { deps, validated, subject, run: (error = 'E0') => repairGraphic(subject, error, SIZE, deps) };
}

describe('nothing to repair, no model', () => {
  it.each([[undefined, 'missing'], ['', 'empty'], [42, 'a number'], [null, 'null'], [{ x: 1 }, 'an object']])('code %j (%s): no-code, 0 attempts, the model is never called', async (code, _label) => {
    const m = model({ code: 'FIX' }), s = setup(m.fn, [], {}, item(code));
    expect(await s.run()).toEqual({ ok: false, attempts: 0, reason: 'no-code', message: NOTHING_TO_REPAIR });
    expect(m.fn).not.toHaveBeenCalled();
    expect(s.deps.validate).not.toHaveBeenCalled();
    expect(s.deps.save).not.toHaveBeenCalled();
  });
  it('no model: no-model, 0 attempts, the connect-a-model message, nothing validated or saved', async () => {
    const s = setup(null);
    expect(await s.run()).toEqual({ ok: false, attempts: 0, reason: 'no-model', message: CONNECT_A_MODEL });
    expect(s.deps.validate).not.toHaveBeenCalled();
    expect(s.deps.save).not.toHaveBeenCalled();
  });
  it('no code is reported before no model', async () => expect(await setup(null, [], {}, item('')).run()).toMatchObject({ reason: 'no-code', attempts: 0 }));
  it('the messages read as the UI shows them', () => {
    expect(CONNECT_A_MODEL).toBe('Connect a model to repair motion graphics.');
    expect(REPAIR_FAILED).toBe('Could not repair this motion graphic');
    expect(NOTHING_TO_REPAIR).toMatch(/no source code/);
    expect(CHANGED).toMatch(/changed during the repair/);
  });
  it('setRepairModel connects and disconnects the model the panel uses', () => {
    const fn: RepairModel = async () => ({ error: 'x' });
    expect(useRepairModel.getState().model).toBeNull();
    setRepairModel(fn); expect(useRepairModel.getState().model).toBe(fn);
    setRepairModel(null); expect(useRepairModel.getState().model).toBeNull();
  });
});

describe('the requests', () => {
  it('request 1 is exactly {code: the original, error: the given error, itemWidth, itemHeight}', async () => {
    const m = model({ code: 'FIX' }), s = setup(m.fn);
    await s.run('compilation error: boom');
    expect(m.requests[0]).toEqual({ code: 'ORIG', error: 'compilation error: boom', itemWidth: 540, itemHeight: 960 });
    expect(Object.keys(m.requests[0]).sort()).toEqual(['code', 'error', 'itemHeight', 'itemWidth']);
  });
  it('request 2 carries attempt 1\'s code and attempt 1\'s renderer error', async () => {
    const m = model({ code: 'A1' }, { code: 'A2' }), s = setup(m.fn, ['E1', 'E2']);
    await s.run('E0');
    expect(m.requests).toEqual([{ code: 'ORIG', error: 'E0', itemWidth: 540, itemHeight: 960 }, { code: 'A1', error: 'E1', itemWidth: 540, itemHeight: 960 }]);
  });
});

describe('two attempts at most', () => {
  it('still broken twice: exactly 2 model calls and 2 validate calls, failed with attempt 2\'s error, the original code kept (save never called)', async () => {
    const m = model({ code: 'A1' }, { code: 'A2' }), s = setup(m.fn, ['E1', 'E2']);
    expect(await s.run()).toEqual({ ok: false, attempts: 2, reason: 'failed', message: `${REPAIR_FAILED}: E2` });
    expect(m.fn).toHaveBeenCalledTimes(2);
    expect(s.deps.validate).toHaveBeenCalledTimes(2);
    expect(s.validated).toEqual(['A1', 'A2']);
    expect(s.deps.save).not.toHaveBeenCalled();
  });
  it('fixed on attempt 1: saved once with that code, ok with 1 attempt, the model called once', async () => {
    const m = model({ code: 'FIX' }), s = setup(m.fn);
    expect(await s.run()).toEqual({ ok: true, attempts: 1 });
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(s.deps.validate).toHaveBeenCalledTimes(1);
    expect(s.deps.save).toHaveBeenCalledTimes(1);
    expect(s.deps.save).toHaveBeenCalledWith('FIX');
  });
  it('broken then fixed: ok with 2 attempts, the second code saved, once', async () => {
    const m = model({ code: 'A1' }, { code: 'A2' }), s = setup(m.fn, ['E1', null]);
    expect(await s.run()).toEqual({ ok: true, attempts: 2 });
    expect(m.fn).toHaveBeenCalledTimes(2);
    expect(s.deps.save).toHaveBeenCalledTimes(1);
    expect(s.deps.save).toHaveBeenCalledWith('A2');
  });
  it('never a third attempt, however it fails', async () => {
    const m = model({ code: 'A1' }, { code: 'A2' }, { code: 'A3' });
    await setup(m.fn, ['E1', 'E2', null]).run();
    expect(m.fn).toHaveBeenCalledTimes(2);
  });
});

describe('a model that fails or answers without code', () => {
  it('{error} twice: no validate call, request 2 keeps the original code and the given error, failed with the model\'s message', async () => {
    const m = model({ error: 'rate limited' }, { error: 'quota used up' }), s = setup(m.fn);
    expect(await s.run('E0')).toEqual({ ok: false, attempts: 2, reason: 'failed', message: `${REPAIR_FAILED}: quota used up` });
    expect(s.deps.validate).not.toHaveBeenCalled();
    expect(m.requests[1]).toEqual({ code: 'ORIG', error: 'E0', itemWidth: 540, itemHeight: 960 });
    expect(s.deps.save).not.toHaveBeenCalled();
  });
  it('a thrown Error twice: failed with its message; a thrown string is used as it is', async () => {
    expect(await setup(model(new Error('net down'), new Error('net still down')).fn).run()).toMatchObject({ ok: false, attempts: 2, message: `${REPAIR_FAILED}: net still down` });
    const throwing: RepairModel = vi.fn(async () => { throw 'plain text'; });
    expect(await setup(throwing).run()).toMatchObject({ ok: false, message: `${REPAIR_FAILED}: plain text` });
  });
  it.each([[''], ['   ']])('{code: %j} counts as no code: no validate call, message "The model returned no code."', async code => {
    const m = model({ code }, { code }), s = setup(m.fn);
    expect(await s.run()).toEqual({ ok: false, attempts: 2, reason: 'failed', message: `${REPAIR_FAILED}: The model returned no code.` });
    expect(s.deps.validate).not.toHaveBeenCalled();
  });
  it('broken code, then a model error: request 2 carries attempt 1\'s code and renderer error; the result is the model\'s message', async () => {
    const m = model({ code: 'A1' }, { error: 'timed out' }), s = setup(m.fn, ['E1']);
    expect(await s.run()).toEqual({ ok: false, attempts: 2, reason: 'failed', message: `${REPAIR_FAILED}: timed out` });
    expect(m.requests[1]).toMatchObject({ code: 'A1', error: 'E1' });
    expect(s.validated).toEqual(['A1']);
  });
  it('a model error, then broken code: request 2 keeps the original; the result is the renderer\'s error for attempt 2', async () => {
    const m = model({ error: 'busy' }, { code: 'A2' }), s = setup(m.fn, ['E2']);
    expect(await s.run('E0')).toEqual({ ok: false, attempts: 2, reason: 'failed', message: `${REPAIR_FAILED}: E2` });
    expect(m.requests[1]).toMatchObject({ code: 'ORIG', error: 'E0' });
  });
  it('a model error, then a valid fix: ok with 2 attempts, validate called once', async () => {
    const m = model(new Error('blip'), { code: 'FIX' }), s = setup(m.fn);
    expect(await s.run()).toEqual({ ok: true, attempts: 2 });
    expect(s.validated).toEqual(['FIX']);
    expect(s.deps.save).toHaveBeenCalledWith('FIX');
  });
});

describe('the item changed while the model worked', () => {
  it('current() differs from the item passed in when a valid fix arrives: reason "changed", the changed message, save not called', async () => {
    const m = model({ code: 'FIX' }), s = setup(m.fn, [], { current: () => ({ ...item(), metadata: { edited: true } }) });
    expect(await s.run()).toEqual({ ok: false, attempts: 1, reason: 'changed', message: CHANGED });
    expect(s.deps.save).not.toHaveBeenCalled();
  });
  it('a deleted item (current() undefined) counts as changed', async () => {
    const s = setup(model({ code: 'FIX' }).fn, [], { current: () => undefined });
    expect(await s.run()).toMatchObject({ ok: false, reason: 'changed', message: CHANGED });
    expect(s.deps.save).not.toHaveBeenCalled();
  });
  it('changed after a broken first attempt: reported on the attempt whose fix arrives (2)', async () => {
    const s = setup(model({ code: 'A1' }, { code: 'A2' }).fn, ['E1', null], { current: () => ({ ...item(), display: { from: 500, to: 4000 } }) });
    expect(await s.run()).toEqual({ ok: false, attempts: 2, reason: 'changed', message: CHANGED });
  });
  it('mutating the item object itself while the model works is a change too (the comparison is against a copy taken at the start)', async () => {
    const subject = item(), mutating: RepairModel = vi.fn(async () => { (subject.display as { to: number }).to = 9999; return { code: 'FIX' }; });
    const s = setup(mutating, [], { current: () => subject }, subject);
    expect(await s.run()).toMatchObject({ ok: false, reason: 'changed' });
    expect(s.deps.save).not.toHaveBeenCalled();
  });
  it('an identical copy of the item is not a change', async () => {
    const s = setup(model({ code: 'FIX' }).fn, [], { current: () => structuredClone(item()) });
    expect(await s.run()).toEqual({ ok: true, attempts: 1 });
  });
  it('a change does not matter when no valid fix arrives: the failure is reported', async () => {
    const s = setup(model({ code: 'A1' }, { code: 'A2' }).fn, ['E1', 'E2'], { current: () => undefined });
    expect(await s.run()).toMatchObject({ reason: 'failed', message: `${REPAIR_FAILED}: E2` });
  });
});

describe('saving', () => {
  it('save returns an error text: failed with that text, after one attempt, no second request', async () => {
    const m = model({ code: 'FIX' }, { code: 'FIX2' }), s = setup(m.fn, [], { save: vi.fn(() => 'Item not found') });
    expect(await s.run()).toEqual({ ok: false, attempts: 1, reason: 'failed', message: `${REPAIR_FAILED}: Item not found` });
    expect(m.fn).toHaveBeenCalledTimes(1);
  });
});

describe('through the runtime: intent repairMotionGraphic {itemId, code}', () => {
  const world = () => build({
    tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')],
    items: [video('v1', 'V1', 0, 8000), { ...item('export const Broken = () => { throw new Error("boom"); };'), id: 'g1', trackId: 'O1' }],
    extra: { size: SIZE },
  });
  const editor = () => createEditor(world(), { assets: assets(), links: links() });

  it('sets details.code only, as one "Edit items" user entry; every other field of the item is untouched', () => {
    const e = editor(), before = structuredClone(e.doc.items.find(i => i.id === 'g1')!);
    expect(e.intent({ type: 'repairMotionGraphic', itemId: 'g1', code: 'export const Fixed = () => null;' })).toEqual({ ok: true });
    const after = e.doc.items.find(i => i.id === 'g1')!;
    expect(after.details.code).toBe('export const Fixed = () => null;');
    expect({ ...after, details: { ...after.details, code: before.details.code } }).toEqual(before);
    expect(e.bus.undoStack).toHaveLength(1);
    expect(e.bus.undoStack[0]).toMatchObject({ label: 'Edit items', source: 'user' });
  });
  it('undo restores the broken code, redo the fix', () => {
    const e = editor(), broken = JSON.stringify(e.doc);
    e.intent({ type: 'repairMotionGraphic', itemId: 'g1', code: 'FIXED' });
    const fixed = JSON.stringify(e.doc);
    e.bus.undo(); expect(JSON.stringify(e.doc)).toBe(broken);
    e.bus.redo(); expect(JSON.stringify(e.doc)).toBe(fixed);
  });
  it.each([['an unknown id', 'nope'], ['a video item', 'v1']])('%s: ITEM_NOT_FOUND "Item not found", no history entry, document untouched', (_label, itemId) => {
    const e = editor(), before = JSON.stringify(e.doc);
    const r = e.intent({ type: 'repairMotionGraphic', itemId, code: 'FIXED' });
    expect(r).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND', message: 'Item not found' });
    expect(e.bus.undoStack).toHaveLength(0);
    expect(JSON.stringify(e.doc)).toBe(before);
  });
  it('a text item is not a motion graphic either', () => {
    const e = createEditor(build({ tracks: [mkTrack('O1', 'overlay')], items: [mkItem('t1', 'O1', 0, 2000, { type: 'text', details: { text: 'x' } })] }), { assets: assets(), links: links() });
    expect(e.intent({ type: 'repairMotionGraphic', itemId: 't1', code: 'FIXED' })).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND' });
    expect(e.bus.undoStack).toHaveLength(0);
  });
});
