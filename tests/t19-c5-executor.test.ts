// SPDX-License-Identifier: AGPL-3.0-only
// T19 C4/C5: the executor's viewItemDetails path: async, PROJECT_UNAVAILABLE without a project, success marks the timeline
// read (and the keyframes scope of an item whose keyframes were included), a failed single call marks nothing.
// Real T03 runtime (createEditor) with injected store/service stubs. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, fixture, links } from './t03-fixtures';

const NO_PROJECT = { success: false, code: 'PROJECT_UNAVAILABLE', error: 'No project is open in the connected editor tab. Open a project, then retry.' };
const fakeStorage = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
let seq = 0;
const call = (toolName: string, input: Record<string, unknown> = {}, extra: Partial<Call> = {}): Call => ({ type: 'call', callId: `c${++seq}`, executionKey: `mcp:conn:c${seq}`, toolName, input, ...extra });

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T10:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

const deps = { store: { row: async () => undefined, putRow: async () => {}, media: {} }, service: { rhythm: async () => { throw new Error('unused'); } } } as never;
function rig(analysis: () => Promise<unknown> = async () => deps) {
  const editor = createEditor(fixture(), { assets: assets(), links: links() });
  const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }), analysis: analysis as never });
  return { editor, ex };
}
const refused = (r: unknown) => (r as { code?: string }).code === 'STALE_READ_REFRESHED';
const move = (session = 's') => call('moveItem', { itemId: 'v3', by: 1 }, { session });

describe('T19 C5 executor viewItemDetails', () => {
  it('execute() returns a promise; a success carries { success, data }', async () => {
    const { ex } = rig();
    const pending = ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'transcript' }, { session: 's' }));
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toMatchObject({ success: true, data: { id: 'v1' } });
  });
  it('no project → PROJECT_UNAVAILABLE, and the analysis dependency is not loaded', async () => {
    const analysis = vi.fn(async () => deps);
    const ex = new Executor({ storage: fakeStorage(), current: () => undefined, analysis: analysis as never });
    expect(await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'transcript' }, { session: 's' }))).toEqual(NO_PROJECT);
    expect(analysis).not.toHaveBeenCalled();
  });
  it('a successful call marks the timeline read: a following gated call is not refused; without it the first gated call is', async () => {
    const a = rig();
    expect(refused(await a.ex.execute(move()))).toBe(true); // control: never read
    const b = rig();
    expect(await b.ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'transcript' }, { session: 's' }))).toMatchObject({ success: true });
    const moved = await b.ex.execute(move());
    expect(refused(moved)).toBe(false); expect(moved).toMatchObject({ success: true });
    expect(b.editor.doc.items.find(i => i.id === 'v3')!.display).toEqual({ from: 11000, to: 13000 });
  });
  it('the read is per session', async () => {
    const { ex } = rig();
    await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'transcript' }, { session: 's' }));
    expect(refused(await ex.execute(move('t')))).toBe(true);
    expect(refused(await ex.execute(move('s')))).toBe(false);
  });
  it('a batch with at least one success counts as a success (message Batch: n/m) and marks the read', async () => {
    const { ex } = rig();
    const r = await ex.execute(call('viewItemDetails', { itemIds: ['v1', 'nope'], include: 'transcript' }, { session: 's' }));
    expect(r).toMatchObject({ success: true, message: 'Batch: 1/2 items' });
    expect(refused(await ex.execute(move()))).toBe(false);
  });

  describe('keyframes scope', () => {
    /** v1 with opacity keyframed before the executor's first sync (the baseline, not a user change). */
    function keyframed() {
      const editor = createEditor(fixture(), { assets: assets(), links: links() });
      expect(editor.call('writeKeyframes', { itemId: 'v1', payload: { opacity: { replace: [{ time: 1, value: 1 }, { time: 3, value: 0.5 }] } } })).toMatchObject({ success: true });
      const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }), analysis: (async () => deps) as never });
      return { editor, ex };
    }
    const write = (session = 's') => call('writeKeyframes', { itemId: 'v1', payload: { opacity: { add: [{ time: 2, value: 0.7 }] } } }, { session });
    it('control: a write on a keyframed property is refused with scope keyframes before any read', async () => {
      const { ex } = keyframed();
      expect(await ex.execute(write())).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'keyframes', agentId: 'v1' });
    });
    it('include=keyframes marks that item\'s keyframes scope: a later writeKeyframes is not refused', async () => {
      const { ex } = keyframed();
      expect(await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'keyframes' }, { session: 's' }))).toMatchObject({ success: true, data: { keyframes: { opacity: { keyframeCount: 2 } } } });
      expect(await ex.execute(write())).toMatchObject({ success: true });
      expect(refused(await ex.execute(write('other')))).toBe(true); // another session has not read
    });
    it('include=transcript alone does not mark the keyframes scope (the timeline is read, keyframes are not)', async () => {
      const { ex } = keyframed();
      await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'transcript' }, { session: 's' }));
      expect(await ex.execute(write())).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'keyframes', agentId: 'v1' });
    });
    it('only the returned items are marked: reading v2 keyframes leaves v1 gated', async () => {
      const { ex } = keyframed();
      await ex.execute(call('viewItemDetails', { itemId: 'v2', include: 'keyframes' }, { session: 's' }));
      expect(await ex.execute(write())).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'keyframes', agentId: 'v1' });
    });
    it('a user change to the keyframes after the read makes it stale again', async () => {
      const { editor, ex } = keyframed();
      await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'keyframes' }, { session: 's' }));
      editor.runtime.bus.run('Change speed' as never, 'user', doc => { const i = doc.items.find(x => x.id === 'v1')!; i.properties!.opacity.keyframes[0].value = 0.25; });
      expect(await ex.execute(write())).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'keyframes', agentId: 'v1' });
    });
  });

  describe('failures mark nothing', () => {
    it('a failed single call (unknown id) leaves the timeline unread', async () => {
      const { ex } = rig();
      expect(await ex.execute(call('viewItemDetails', { itemId: 'nope', include: 'transcript' }, { session: 's' }))).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
      expect(refused(await ex.execute(move()))).toBe(true);
    });
    // T12 (C8 assertion-only edit): masks is served now, so NOT_IMPLEMENTED is exercised via `effects` (still T18-owned) instead.
    it('NOT_IMPLEMENTED and INVALID_TOOL_INPUT mark nothing', async () => {
      const { ex } = rig();
      expect(await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'effects' }, { session: 's' }))).toMatchObject({ code: 'NOT_IMPLEMENTED' });
      expect(await ex.execute(call('viewItemDetails', { include: 'transcript' }, { session: 's' }))).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
      expect(refused(await ex.execute(move()))).toBe(true);
    });
    it('a failed include=keyframes call marks no keyframes scope', async () => {
      const editor = createEditor(fixture(), { assets: assets(), links: links() });
      editor.call('writeKeyframes', { itemId: 'v1', payload: { opacity: { replace: [{ time: 1, value: 1 }, { time: 3, value: 0.5 }] } } });
      const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, analysis: (async () => deps) as never });
      await ex.execute(call('viewItemDetails', { itemId: 'nope', include: 'keyframes' }, { session: 's' }));
      expect(await ex.execute(call('writeKeyframes', { itemId: 'v1', payload: { opacity: { add: [{ time: 2, value: 0.7 }] } } }, { session: 's' }))).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'keyframes' });
    });
    it('an analysis dependency that rejects → a failure envelope with its code and message, nothing marked', async () => {
      const { ex } = rig(async () => { throw Object.assign(new Error('models gone'), { code: 'ANALYSIS_UNAVAILABLE' }); });
      expect(await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'transcript' }, { session: 's' }))).toEqual({ success: false, code: 'ANALYSIS_UNAVAILABLE', error: 'models gone' });
      expect(refused(await ex.execute(move()))).toBe(true);
    });
    it('an error without a code → PROJECT_UNAVAILABLE', async () => {
      const { ex } = rig(async () => { throw new Error('boom'); });
      expect(await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'transcript' }, { session: 's' }))).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'boom' });
    });
  });
});
