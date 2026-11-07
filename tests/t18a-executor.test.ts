// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger rows 5 (read-only bypass), 7 (executor gate — timeline and per-item keyframes scopes, envelopes), 8 (what changes
// count for the resource) and 12 (attribution): the tab-side dispatcher and the Watcher,
// driven over a real T03 runtime (createEditor) or a minimal fake `{bus:{doc, subscribe}, call}`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { Watcher } from '../apps/web/src/agent/watch';
import type { Change } from '../apps/web/src/agent/watch';
import type { Runtime } from '../apps/web/src/timeline/runtime';
import { createEditor } from '../apps/web/src/timeline/harness';
import { keyframesBlock } from '../apps/web/src/timeline/properties';
import { fixture, itemOf, mkTrack, build } from './t03-fixtures';

const LEDGER_STORAGE_KEY = 'cutframe:tool-execution-ledger:v1';
const NO_PROJECT = { success: false, code: 'PROJECT_UNAVAILABLE', error: 'No project is open in the connected editor tab. Open a project, then retry.' };
const NEVER_READ = "You haven't read the timeline in this session. The current state is attached and the timeline now counts as fresh; retry the call.";
const modifiedAt = (iso: string) => `The user modified the timeline at ${iso} after your last read. The current state is attached and the timeline now counts as fresh; retry the call.`;

const fakeStorage = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
let seq = 0;
const call = (toolName: string, input: Record<string, unknown> = {}, extra: Partial<Call> = {}): Call =>
  ({ type: 'call', callId: `c${++seq}`, executionKey: `mcp:conn:c${seq}`, toolName, input, ...extra });

/** A minimal runtime: the document is replaced (not mutated) on every change, like the real bus does. */
function fakeRuntime(doc = fixture(), handler: (tool: string, input: Record<string, unknown>) => any = () => ({ success: true })) {
  const listeners = new Set<() => void>();
  const rt = {
    bus: { doc, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; } },
    call: (tool: string, input: Record<string, unknown>) => handler(tool, input),
    replaceDoc(next: typeof doc) { rt.bus.doc = next; for (const l of [...listeners]) l(); },
    listeners,
  };
  return rt;
}
const asRuntime = (r: unknown) => r as Runtime;
const marker = (doc: ReturnType<typeof fixture>, id: string) => ({ ...doc, markers: [...doc.markers, { id, timeMs: 500 }] });

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('t18a executor gate (row 7)', () => {
  it('row 7: the first gated call of a session is refused STALE_READ_REFRESHED with the light context attached; the retry passes', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    const refused = await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's1' }));
    expect(refused).toEqual({
      success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: NEVER_READ, scope: 'timeline',
      currentState: { success: true, data: expect.objectContaining({ duration: 12, fps: 30, canvasSize: { width: 1080, height: 1920 } }) },
    });
    const state = (refused as any).currentState.data;
    expect(Object.keys(state).slice(0, 7)).toEqual(['_tracks', 'duration', 'fps', 'canvasSize', 'tracks', 'layerOrder', 'groups']);
    expect(state).not.toHaveProperty('selectedItems'); // the light read has no MCP additions
    expect(state).not.toHaveProperty('playheadSeconds');
    expect(editor.doc.items.find(i => i.id === 'v3')!.display).toEqual({ from: 10000, to: 12000 }); // nothing applied

    const retried = await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's1' }));
    expect(retried).toMatchObject({ success: true });
    expect(editor.doc.items.find(i => i.id === 'v3')!.display).toEqual({ from: 11000, to: 13000 });
  });

  it('row 7: after context, a user change is refused with modifiedAt(<ISO of the change>); the retry passes', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    expect(await ex.execute(call('context', {}, { session: 's1' }))).toMatchObject({ success: true });
    vi.setSystemTime(new Date('2026-11-01T10:00:05.250Z'));
    expect(editor.intent({ type: 'addMarker', timeMs: 500 })).toEqual({ ok: true }); // the user adds a marker in the editor
    const refused = await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's1' }));
    expect(refused).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', scope: 'timeline',
      message: modifiedAt('2026-11-01T10:00:05.250Z') });
    expect((refused as any).currentState.data.markers).toEqual([{ time: 0.5 }]); // the attached state includes the user's change
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's1' }))).toMatchObject({ success: true });
  });

  it('row 7: a user Undo counts as a user change', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's1' }));
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's1' }))).toMatchObject({ success: true });
    vi.setSystemTime(new Date('2026-11-01T10:01:00.000Z'));
    editor.intent({ type: 'undo' });
    expect(editor.doc.items.find(i => i.id === 'v3')!.display).toEqual({ from: 10000, to: 12000 });
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 2 }, { session: 's1' }))).toMatchObject({ code: 'STALE_READ_REFRESHED', message: modifiedAt('2026-11-01T10:01:00.000Z') });
  });

  it('row 7: the agent\'s own edits never trip the gate', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's1' }));
    for (const by of [1, 1, -2]) expect(await ex.execute(call('moveItem', { itemId: 'v3', by }, { session: 's1' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('manageMarkers', { actions: [{ action: 'add', time: 2 }] }, { session: 's1' }))).toMatchObject({ success: true });
    expect(editor.doc.items.find(i => i.id === 'v3')!.display).toEqual({ from: 10000, to: 12000 });
  });

  it('row 7: sessions are independent', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's1' }));
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's1' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's2' }))).toMatchObject({ code: 'STALE_READ_REFRESHED', message: NEVER_READ });
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's2' }))).toMatchObject({ success: true }); // the refusal marked s2 fresh
    // a call without a session shares the "default" session
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }))).toMatchObject({ code: 'STALE_READ_REFRESHED', message: NEVER_READ });
  });

  it('row 7: a user change refuses every session that has read before it, each once', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's1' }));
    await ex.execute(call('context', {}, { session: 's2' }));
    editor.intent({ type: 'addMarker', timeMs: 100 });
    for (const session of ['s1', 's2']) {
      expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session }))).toMatchObject({ code: 'STALE_READ_REFRESHED' });
      expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session }))).toMatchObject({ success: true });
    }
  });

  it('row 7: only the timeline-gated tools are gated (context, resizeCanvas are not)', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    expect(await ex.execute(call('resizeCanvas', { aspectRatio: '16:9' }, { session: 'fresh' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('context', {}, { session: 'fresh2' }))).toMatchObject({ success: true });
  });

  it('row 7: no runtime → PROJECT_UNAVAILABLE exactly (every tool, and the resource read)', async () => {
    const ex = new Executor({ storage: fakeStorage(), current: () => undefined, ui: () => ({ selection: [], playheadMs: 0 }) });
    expect(await ex.execute(call('context'))).toEqual(NO_PROJECT);
    expect(await ex.execute(call('moveItem', { itemId: 'v1', by: 1 }))).toEqual(NO_PROJECT);
    expect(await ex.execute(call('context', {}, { resource: true }))).toEqual(NO_PROJECT);
  });

  it('row 7: a thrown {code, message} → {success:false, code, error, operationMayHaveRun:true}', async () => {
    const rt = fakeRuntime(fixture(), () => { throw Object.assign(new Error('m'), { code: 'X' }); });
    const ex = new Executor({ storage: fakeStorage(), current: () => asRuntime(rt), ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's' }));
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' }))).toEqual({ success: false, code: 'X', error: 'm', operationMayHaveRun: true });
  });

  it('row 7: a thrown error without code or message gets PROJECT_UNAVAILABLE and the fixed text', async () => {
    const rt = fakeRuntime(fixture(), () => { throw {}; }); // eslint-disable-line no-throw-literal
    const ex = new Executor({ storage: fakeStorage(), current: () => asRuntime(rt), ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's' }));
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' })))
      .toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'Unable to verify the open project.', operationMayHaveRun: true });
  });

  it('row 7: context success adds selectedItems (array) and playheadSeconds rounded to 3 dp', async () => {
    const editor = createEditor(fixture());
    const selection = ['v1', 't1'];
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection, playheadMs: 1234.5678 }) });
    const result = await ex.execute(call('context', {}, { session: 's' })) as any;
    expect(result.success).toBe(true);
    expect(result.data.selectedItems).toEqual(['v1', 't1']);
    expect(result.data.selectedItems).not.toBe(selection); // a copy
    expect(result.data.playheadSeconds).toBe(1.235);
    expect(Object.keys(result.data).slice(-2)).toEqual(['selectedItems', 'playheadSeconds']);
  });

  it('row 7: context with no selection reports selectedItems [] and an exact playhead', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 2000 }) });
    const result = await ex.execute(call('context', {}, { session: 's' })) as any;
    expect(result.data.selectedItems).toEqual([]);
    expect(result.data.playheadSeconds).toBe(2);
  });

  it('row 7: mutating results carry timelineChanges; context does not', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    const read = await ex.execute(call('context', {}, { session: 's' })) as any;
    expect(read).not.toHaveProperty('timelineChanges');
    const moved = await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' })) as any;
    expect(moved.success).toBe(true);
    expect(moved.timelineChanges).toMatchObject({ basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true });
    expect(moved.timelineChanges.items.updated).toHaveLength(1);
    expect(moved.timelineChanges.items.updated[0]).toMatchObject({ itemId: 'v3', before: { from: 10, to: 12 }, after: { from: 11, to: 13 } });
  });

  it('row 7: a documented tool failure comes back unchanged (ITEM_NOT_FOUND), with no timelineChanges', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's' }));
    const result = await ex.execute(call('moveItem', { itemId: 'nope', by: 1 }, { session: 's' })) as any;
    expect(result).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
    expect(result).not.toHaveProperty('timelineChanges');
  });
});

describe('t18a executor ledger and resource (rows 5, 8)', () => {
  it('row 5: a duplicate delivery of one mutating call applies once and answers with the stored result', async () => {
    const editor = createEditor(fixture());
    const storage = fakeStorage();
    const ex = new Executor({ storage, current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's' }));
    const original = call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' });
    const first = await ex.execute(original);
    const again = await ex.execute({ ...original });
    expect(first).toMatchObject({ success: true });
    expect(again).toEqual(first);
    expect(editor.doc.items.find(i => i.id === 'v3')!.display).toEqual({ from: 11000, to: 13000 }); // moved once, not twice
    expect(editor.labels().filter(l => l === 'Move item')).toHaveLength(1);
  });

  it('row 5: the same execution key with other input → KEY_COLLISION; nothing is applied', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's' }));
    const original = call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' });
    await ex.execute(original);
    expect(await ex.execute({ ...original, input: { itemId: 'v3', by: 5 } })).toEqual({ success: false, code: 'TOOL_EXECUTION_KEY_COLLISION',
      error: 'This tool execution key was already used for different input, so the operation was not run.' });
    expect(editor.doc.items.find(i => i.id === 'v3')!.display).toEqual({ from: 11000, to: 13000 });
  });

  it('row 5: read-only tools (context) bypass the ledger: no entry, and the same key re-reads the current state', async () => {
    const editor = createEditor(fixture());
    const storage = fakeStorage();
    const ex = new Executor({ storage, current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    const read = call('context', {}, { session: 's' });
    const before = await ex.execute(read) as any;
    expect(before.data.markers).toBeUndefined();
    editor.intent({ type: 'addMarker', timeMs: 750 });
    const after = await ex.execute({ ...read }) as any; // same executionKey
    expect(after.data.markers).toEqual([{ time: 0.75 }]);
    expect(storage.data.has(LEDGER_STORAGE_KEY)).toBe(false);
  });

  it('row 5: a ledger entry is written for mutating calls under cutframe:tool-execution-ledger:v1', async () => {
    const editor = createEditor(fixture());
    const storage = fakeStorage();
    const ex = new Executor({ storage, current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    await ex.execute(call('context', {}, { session: 's' }));
    const c = call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' });
    await ex.execute(c);
    const stored = JSON.parse(storage.data.get(LEDGER_STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key: c.executionKey, tool: 'moveItem', fingerprint: '{"by":1,"itemId":"v3"}' });
  });

  it('row 8: a resource read returns context without parameters and does NOT satisfy the gate', async () => {
    const editor = createEditor(fixture());
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: ['v1'], playheadMs: 5000 }) });
    const resource = await ex.execute(call('context', {}, { session: 's', resource: true })) as any;
    expect(resource.success).toBe(true);
    expect(resource.data).not.toHaveProperty('selectedItems');
    expect(resource.data).not.toHaveProperty('playheadSeconds');
    const plain = await ex.execute(call('context', {}, { session: 'other' })) as any;
    const { selectedItems: _s, playheadSeconds: _p, ...light } = plain.data;
    expect(resource.data).toEqual(light);
    // A gated call in the same session after only a resource read is still refused as never-read.
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' }))).toMatchObject({ code: 'STALE_READ_REFRESHED', message: NEVER_READ });
  });
});

describe('t18a keyframes gate (row 7, A0.2 item 3 keyframes scope)', () => {
  const KF_NEVER = (id: string) => `You haven't read the keyframes of item '${id}' in this session. The current state is attached and they now count as fresh; retry the call.`;
  const KF_MODIFIED = (iso: string, id: string) => `The user modified the keyframes of item '${id}' at ${iso} after your last read. The current state is attached and they now count as fresh; retry the call.`;
  /** v1 with opacity and positionX keyframed, set before the executor's first sync (so it is the baseline, not a user change). */
  function keyframed(onState?: (parts: string[]) => void) {
    const editor = createEditor(fixture());
    expect(editor.call('writeKeyframes', { itemId: 'v1', payload: { opacity: { replace: [{ time: 1, value: 1 }, { time: 3, value: 0.5 }] }, positionX: { replace: [{ time: 0, value: 0 }, { time: 2, value: 100 }] } } })).toMatchObject({ success: true });
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }), onState });
    return { editor, ex };
  }
  const kf = (editor: ReturnType<typeof createEditor>, id = 'v1') => keyframesBlock(itemOf(editor.doc, id));

  it('row 7: editProperties on a keyframed property — refused with scope keyframes, agentId and the item\'s keyframes block; the retry changes only the default value', async () => {
    const { editor, ex } = keyframed();
    const before = kf(editor);
    expect(before.keyframes?.opacity).toMatchObject({ keyframeCount: 2 });
    expect(await ex.execute(call('editProperties', { itemId: 'v1', properties: { opacity: 0.8 } }, { session: 's' }))).toEqual({
      success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: KF_NEVER('v1'), scope: 'keyframes', agentId: 'v1', currentState: before });
    expect(kf(editor)).toEqual(before); // nothing applied
    expect(await ex.execute(call('editProperties', { itemId: 'v1', properties: { opacity: 0.8 } }, { session: 's' }))).toMatchObject({ success: true });
    expect(kf(editor).keyframes?.opacity).toMatchObject({ defaultValue: 0.8, keyframeCount: 2 });
    // Another session has its own read state.
    expect(await ex.execute(call('editProperties', { itemId: 'v1', properties: { opacity: 0.7 } }, { session: 't' }))).toMatchObject({ code: 'STALE_READ_REFRESHED', message: KF_NEVER('v1') });
  });

  it('row 7: not gated when no written property is keyframed (another property, another item); setTimeRemap is never gated', async () => {
    const { editor, ex } = keyframed();
    expect(await ex.execute(call('editProperties', { itemId: 'v1', properties: { volume: 0.5 } }, { session: 's' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('editProperties', { itemId: 'v2', properties: { opacity: 0.5 } }, { session: 's' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('writeKeyframes', { itemId: 'v1', payload: { scale: { add: [{ time: 1, value: 2 }] } } }, { session: 's' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('setTimeRemap', { itemId: 'v1', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 2000 }] }, { session: 's' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('setTimeRemap', { itemId: 'v1', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 3000 }] }, { session: 's' }))).toMatchObject({ success: true });
    expect(kf(editor).keyframes?.timeRemap).toMatchObject({ keyframeCount: 2 });
  });

  it('row 7: writeKeyframes on a property that already has keyframes is gated; an effect or mask target is not (its handler answers)', async () => {
    const { ex } = keyframed();
    const write = { itemId: 'v1', payload: { opacity: { add: [{ time: 2, value: 0.7 }] } } };
    expect(await ex.execute(call('writeKeyframes', write, { session: 's' }))).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'keyframes', agentId: 'v1', message: KF_NEVER('v1') });
    expect(await ex.execute(call('writeKeyframes', write, { session: 's' }))).toMatchObject({ success: true });
    // T10/T12 (C8 assertion-only edit): the effect and mask targets are served now; neither is gated, and each handler refuses it directly.
    expect(await ex.execute(call('writeKeyframes', { ...write, effectId: 'vignette_1' }, { session: 'u' }))).toMatchObject({ success: false, code: 'EFFECT_NOT_FOUND' });
    expect(await ex.execute(call('writeKeyframes', { ...write, maskIndex: 0 }, { session: 'u' }))).toMatchObject({ success: false, code: 'NO_MASKS' });
  });

  it('row 7: transformItem is gated only when the position / scale / rotation it writes is keyframed (positionX here)', async () => {
    const { ex } = keyframed();
    const cases: [Record<string, unknown>, boolean][] = [
      [{ rotation: 10 }, false], [{ y: 5 }, false], [{ centerY: true }, false], [{ scale: 1.5 }, false], [{ scaleBy: 1, x: 3, y: 3 }, true],
      [{ x: 5 }, true], [{ centerX: true }, true], [{ center: true }, true], [{ scaleBy: 1.1 }, true], [{ fitToCanvas: true }, true], [{ fillCanvas: true }, true],
    ];
    for (const [i, [args, gated]] of cases.entries()) {
      const result = await ex.execute(call('transformItem', { itemId: 'v1', ...args }, { session: `x${i}` }));
      expect(result, JSON.stringify(args)).toMatchObject(gated ? { code: 'STALE_READ_REFRESHED', scope: 'keyframes', agentId: 'v1' } : { success: true });
    }
  });

  it('row 7: a batch refuses on the first keyframed target; nothing is applied to the others', async () => {
    const { editor, ex } = keyframed();
    expect(await ex.execute(call('editProperties', { itemIds: ['v2', 'v1', 'v3'], properties: { opacity: 0.4 } }, { session: 's' }))).toMatchObject({ code: 'STALE_READ_REFRESHED', agentId: 'v1' });
    expect(kf(editor, 'v2')).toEqual({ keyframes: null, keyframesNote: 'No keyframes on this item' });
    expect(itemOf(editor.doc, 'v2').properties?.opacity).toBeUndefined();
    expect(await ex.execute(call('editProperties', { itemIds: ['v2', 'v1', 'v3'], properties: { opacity: 0.4 } }, { session: 's' }))).toMatchObject({ success: true });
  });

  it('row 7: a user change to the item\'s keyframes → modifiedAt(<ISO>); user changes elsewhere (a marker, another item\'s keyframes) leave the read current', async () => {
    const { editor, ex } = keyframed();
    const edit = () => ex.execute(call('editProperties', { itemId: 'v1', properties: { opacity: 0.9 } }, { session: 's' }));
    expect(await edit()).toMatchObject({ message: KF_NEVER('v1') }); // the refusal marks the scope read
    editor.intent({ type: 'addMarker', timeMs: 10 });
    editor.call('writeKeyframes', { itemId: 'v2', payload: { opacity: { replace: [{ time: 5, value: 1 }] } } });
    ex.watcher.sync();
    expect(await edit()).toMatchObject({ success: true });

    vi.setSystemTime(new Date('2026-11-01T10:00:09.500Z'));
    editor.call('writeKeyframes', { itemId: 'v1', payload: { opacity: { add: [{ time: 2, value: 0.7 }] } } }); // outside an agent call: the user
    ex.watcher.sync();
    const refused = await edit() as any;
    expect(refused).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'keyframes', agentId: 'v1', message: KF_MODIFIED('2026-11-01T10:00:09.500Z', 'v1') });
    expect(refused.currentState.keyframes.opacity.keyframeCount).toBe(3);
    expect(await edit()).toMatchObject({ success: true });
  });
});

describe('t18a watcher attribution (row 12)', () => {
  it('row 12: a change inside asAgent → user:false; outside → user:true', () => {
    const rt = fakeRuntime(build({ tracks: [mkTrack('V1', 'video')] }));
    const changes: Change[] = [];
    const watcher = new Watcher(c => changes.push(c), () => asRuntime(rt));
    watcher.sync(); // baseline
    vi.setSystemTime(new Date('2026-11-01T10:00:01.000Z'));
    watcher.asAgent(() => rt.replaceDoc(marker(rt.bus.doc, 'm1')));
    vi.setSystemTime(new Date('2026-11-01T10:00:02.000Z'));
    rt.replaceDoc(marker(rt.bus.doc, 'm2'));
    expect(changes).toEqual([
      { parts: ['markers'], user: false, at: Date.parse('2026-11-01T10:00:01.000Z') },
      { parts: ['markers'], user: true, at: Date.parse('2026-11-01T10:00:02.000Z') },
    ]);
  });

  it('row 12: a change that only touches an unwatched key (the project title) is not reported', () => {
    const rt = fakeRuntime();
    const changes: Change[] = [];
    const watcher = new Watcher(c => changes.push(c), () => asRuntime(rt));
    watcher.sync();
    rt.replaceDoc({ ...rt.bus.doc, rev: 9 });
    expect(changes).toEqual([]);
  });

  it('row 12: the parts name what differs (items, tracks, transitions, markers, layerOrder, groups, duration, fps, size, background)', () => {
    const rt = fakeRuntime();
    const changes: Change[] = [];
    const watcher = new Watcher(c => changes.push(c), () => asRuntime(rt));
    watcher.sync();
    rt.replaceDoc({ ...rt.bus.doc, items: rt.bus.doc.items.slice(1) });
    rt.replaceDoc({ ...rt.bus.doc, duration: rt.bus.doc.duration + 1000, fps: 24 });
    expect(changes.map(c => c.parts)).toEqual([['items'], ['duration', 'fps']]);
  });

  it('row 12: a replaced runtime is followed (the old one is released, the new one reported)', () => {
    const first = fakeRuntime(), second = fakeRuntime(build({ tracks: [mkTrack('V9', 'video')] }));
    let current: ReturnType<typeof fakeRuntime> = first;
    const changes: Change[] = [];
    const watcher = new Watcher(c => changes.push(c), () => asRuntime(current));
    expect(watcher.sync()).toBe(asRuntime(first));
    expect(first.listeners.size).toBe(1);

    current = second; // the project was reopened / a checkpoint restored: a new runtime with another document
    expect(watcher.sync()).toBe(asRuntime(second));
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ user: true });
    expect(changes[0].parts).toEqual(expect.arrayContaining(['items', 'tracks']));

    changes.length = 0;
    first.replaceDoc(marker(first.bus.doc, 'old')); // the old runtime no longer reports
    expect(changes).toEqual([]);
    second.replaceDoc(marker(second.bus.doc, 'new'));
    expect(changes).toMatchObject([{ parts: ['markers'], user: true }]);
  });

  it('row 12: stop() releases the runtime; no runtime → sync returns undefined', () => {
    const rt = fakeRuntime();
    let current: ReturnType<typeof fakeRuntime> | undefined = rt;
    const watcher = new Watcher(() => {}, () => asRuntime(current));
    watcher.sync();
    watcher.stop();
    expect(rt.listeners.size).toBe(0);
    current = undefined;
    expect(watcher.sync()).toBeUndefined();
  });

  it('row 12: Executor.onState gets the parts of agent and user changes alike', async () => {
    const editor = createEditor(fixture());
    const parts: string[][] = [];
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }), onState: p => parts.push(p) });
    await ex.execute(call('context', {}, { session: 's' }));
    await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' })); // agent
    editor.intent({ type: 'addMarker', timeMs: 10 });                              // user
    ex.watcher.sync();
    expect(parts).toEqual([['items', 'duration'], ['markers']]); // v3 moved to 11–13 s: the end of the timeline grew from 12 s to 13 s
  });

  it('row 8: T04 changes are item changes — a property, a keyframe or a time remap (user or agent) reports items, the resource notification\'s trigger', async () => {
    const editor = createEditor(fixture());
    const parts: string[][] = [];
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }), onState: p => parts.push(p) });
    ex.watcher.sync();
    editor.call('editProperties', { itemId: 'v1', properties: { opacity: 0.5 } });
    editor.call('writeKeyframes', { itemId: 'v1', payload: { scale: { add: [{ time: 1, value: 2 }] } } });
    editor.call('setTimeRemap', { itemId: 'v1', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 2000 }] });
    await ex.execute(call('editProperties', { itemId: 'v2', properties: { volume: 0.2 } }, { session: 's' }));
    expect(parts).toEqual([['items'], ['items'], ['items'], ['items']]);
  });
});
