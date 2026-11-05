// SPDX-License-Identifier: AGPL-3.0-only
// T08 gate after the async dry run (review M1): the sandbox dry run takes real time, so the user can edit, or the open project can change, between the
// gate check and the real call. Oracle: agent tool results A0.2 (the stale-read gate: a user change after the session's read refuses a gated call with
// STALE_READ_REFRESHED and applies nothing) and the executor rule in agent/executor.ts (the call runs as the agent only on the runtime it was checked on,
// after the gates pass again; on another runtime it is handled again from the start). The dry run here is injected and released by hand.
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { loadCompiler } from '../apps/web/src/mg/tools';
import type { ProjectDocument } from '../apps/web/src/store/model';
import type { Runtime } from '../apps/web/src/timeline/runtime';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeAll(loadCompiler);
beforeEach(() => useIds());
afterEach(() => resetIds());

const CODE = `export const Card = () => <AbsoluteFill style={{ backgroundColor: '#112233' }}><div style={{ fontFamily: 'Roboto', color: '#fff' }}>Hello</div></AbsoluteFill>;`;
const NEW = `export const N = () => <AbsoluteFill />;`;
const BOX = { width: 540, height: 960, x: 10, y: 20 };
const SUMMARY = 'A lower third.';
const MODIFIED = /^The user modified the timeline at \d{4}-\d\d-\d\dT[\d:.]+Z after your last read\. The current state is attached and the timeline now counts as fresh; retry the call\.$/;
const json = (d: unknown) => JSON.stringify(d);
const fakeStorage = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };

function world(extra: ProjectDocument['items'] = []): ProjectDocument {
  return build({
    tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay')],
    items: [video('v1', 'V1', 0, 4000), mkItem('t1', 'O1', 1000, 3000, { type: 'text', details: { text: 'x' } }),
      mkItem('mg1', 'O2', 6000, 9000, { type: 'motionGraphic', trim: { from: 0, to: 3000 }, sourceDuration: 3000, details: { name: 'Motion graphic', code: CODE }, metadata: { summary: 'A card.' } }), ...extra],
  });
}
const editor = (doc: ProjectDocument = world()) => createEditor(doc, { assets: assets(), links: links() });
type Editor = ReturnType<typeof editor>;
const graphics = (e: Editor) => e.doc.items.filter(i => i.type === 'motionGraphic');
const addArgs = (extra: Record<string, unknown> = {}) => ({ code: CODE, summary: SUMMARY, ...BOX, trackId: 'O2', timelineStart: 20, ...extra });

let seq = 0;
const callOf = (toolName: string, input: Record<string, unknown> = {}, session = 's'): Call => ({ type: 'call', callId: `g${++seq}`, executionKey: `mcp:conn:g${seq}`, toolName, input, session });

/** An Executor whose dry run waits for release() on its first call (later calls pass at once), on a runtime the test can swap. */
function setup(first: Editor = editor()) {
  let open: Runtime | undefined = first.runtime, release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  let calls = 0;
  const dry = vi.fn(async () => { if (++calls === 1) await hold; });
  const ex = new Executor({ storage: fakeStorage(), current: () => open, ui: () => ({ selection: [], playheadMs: 0 }), dryRun: dry });
  const read = () => ex.execute(callOf('context'));
  /** Starts a call and returns (its result as `pending`) once its dry run is waiting, so a test edit lands inside the dry run. */
  const start = async (name: string, input: Record<string, unknown>) => {
    const pending = ex.execute(callOf(name, input));
    await vi.waitFor(() => expect(dry).toHaveBeenCalledTimes(1));
    return { pending };
  };
  return { ex, dry, read, start, release: () => release(), switchTo: (r: Runtime | undefined) => { open = r; } };
}

describe('a user edit while the dry run waits (the read the call was checked on is then stale)', () => {
  it('addMotionGraphic: refused STALE_READ_REFRESHED with the user-modified message; nothing is added; the user\'s edit is kept', async () => {
    const e = editor(), { read, start, release } = setup(e);
    await read();
    const { pending } = await start('addMotionGraphic', addArgs());
    e.intent({ type: 'deleteItems', itemIds: ['t1'], ripple: false });
    const edited = json(e.doc), journalAfterEdit = e.journal.length;
    release();
    const r = await pending as any;
    expect(r).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', scope: 'timeline' });
    expect(r.message).toMatch(MODIFIED);
    expect(graphics(e).map(i => i.id)).toEqual(['mg1']);
    expect(json(e.doc)).toBe(edited);
    expect(e.bus.undoStack).toHaveLength(1);
    expect(e.bus.undoStack[0]).toMatchObject({ source: 'user' });
    expect(e.journal).toHaveLength(journalAfterEdit);
  });

  it('the refusal carries the current state, and a retry then goes through (the refusal marked the timeline read) with a second dry run', async () => {
    const e = editor(), { ex, dry, read, start, release } = setup(e);
    await read();
    const { pending } = await start('addMotionGraphic', addArgs());
    e.intent({ type: 'deleteItems', itemIds: ['t1'], ripple: false });
    release();
    const refused = await pending as any;
    expect(refused.currentState).toBeDefined();
    expect(json(refused.currentState)).not.toContain('"t1"');
    const retry = await ex.execute(callOf('addMotionGraphic', addArgs())) as any;
    expect(retry).toMatchObject({ success: true });
    expect(dry).toHaveBeenCalledTimes(2);
    expect(graphics(e)).toHaveLength(2);
  });

  it('Undo of the agent\'s own earlier change (a user action) while the dry run waits also refuses', async () => {
    const e = editor(), { ex, read, start, release } = setup(e);
    await read();
    expect(await ex.execute(callOf('moveItem', { itemId: 'v1', by: 1 }))).toMatchObject({ success: true });
    // the next gated call waits on its dry run only if it is a graphic call; the first dry run call is this one
    const { pending } = await start('addMotionGraphic', addArgs());
    e.intent({ type: 'undo' });
    release();
    expect(await pending).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED' });
    expect(graphics(e).map(i => i.id)).toEqual(['mg1']);
  });

  it('control: no edit while the dry run waits → the call is applied once, as an agent change', async () => {
    const e = editor(), { read, start, release } = setup(e);
    await read();
    const { pending } = await start('addMotionGraphic', addArgs());
    release();
    expect(await pending).toMatchObject({ success: true, data: { trackId: 'O2' } });
    expect(graphics(e)).toHaveLength(2);
    expect(e.bus.undoStack).toHaveLength(1);
    expect(e.bus.undoStack[0]).toMatchObject({ label: 'Add items', source: 'agent' });
  });

  it('a call that was never gated cannot be made stale: editMotionGraphic runs after a user edit elsewhere (it is not timeline-gated)', async () => {
    const e = editor(), { start, release } = setup(e);
    const { pending } = await start('editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: NEW });
    e.intent({ type: 'deleteItems', itemIds: ['t1'], ripple: false });
    release();
    expect(await pending).toMatchObject({ success: true });
    expect(e.doc.items.find(i => i.id === 'mg1')!.details.code).toBe(NEW);
  });

  it('editMotionGraphic whose item the user deletes while the dry run waits: NOT_FOUND from the real call; nothing is written', async () => {
    const e = editor(), { start, release } = setup(e);
    const { pending } = await start('editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: NEW });
    e.intent({ type: 'deleteItems', itemIds: ['mg1'], ripple: false });
    const edited = json(e.doc);
    release();
    expect(await pending).toMatchObject({ success: false });
    expect(json(e.doc)).toBe(edited);
  });
});

describe('the open project is replaced while the dry run waits (a reload, keep-mine or a restored checkpoint is a new runtime)', () => {
  it('another runtime with a different document: the call is refused as stale and applied to neither', async () => {
    const e1 = editor(), e2 = editor(world([mkItem('t2', 'O1', 4000, 5000, { type: 'text', details: { text: 'y' } })]));
    const { read, start, release, switchTo } = setup(e1);
    await read();
    const b1 = json(e1.doc), b2 = json(e2.doc);
    const { pending } = await start('addMotionGraphic', addArgs());
    switchTo(e2.runtime);
    release();
    expect(await pending).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', scope: 'timeline' });
    expect(json(e1.doc)).toBe(b1); expect(json(e2.doc)).toBe(b2);
    expect(e1.bus.undoStack).toHaveLength(0); expect(e2.bus.undoStack).toHaveLength(0);
  });

  it('another runtime with an identical document: the call is handled again on it (a second dry run) and applied there only; the old document is byte-identical', async () => {
    const e1 = editor(), e2 = editor();
    const { dry, read, start, release, switchTo } = setup(e1);
    await read();
    const b1 = json(e1.doc);
    const { pending } = await start('addMotionGraphic', addArgs());
    switchTo(e2.runtime);
    release();
    expect(await pending).toMatchObject({ success: true, data: { trackId: 'O2' } });
    expect(json(e1.doc)).toBe(b1);
    expect(e1.bus.undoStack).toHaveLength(0); expect(e1.journal).toHaveLength(0);
    expect(dry).toHaveBeenCalledTimes(2);
    expect(graphics(e2)).toHaveLength(2);
    expect(e2.bus.undoStack).toHaveLength(1);
    expect(e2.bus.undoStack[0]).toMatchObject({ label: 'Add items', source: 'agent' });
  });

  it('no project open any more: PROJECT_UNAVAILABLE "No project is open…"; the old document is byte-identical', async () => {
    const e1 = editor();
    const { read, start, release, switchTo } = setup(e1);
    await read();
    const b1 = json(e1.doc);
    const { pending } = await start('addMotionGraphic', addArgs());
    switchTo(undefined);
    release();
    expect(await pending).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'No project is open in the connected editor tab. Open a project, then retry.' });
    expect(json(e1.doc)).toBe(b1); expect(e1.bus.undoStack).toHaveLength(0);
  });

  it('the old runtime is not written to after the switch, even when its document would still pass every check', async () => {
    const e1 = editor(), e2 = editor(world([mkItem('t2', 'O1', 4000, 5000, { type: 'text', details: { text: 'y' } })]));
    const { read, start, release, switchTo } = setup(e1);
    await read();
    const { pending } = await start('addMotionGraphic', addArgs());
    switchTo(e2.runtime);
    const before = e1.journal.length;
    release();
    await pending;
    expect(e1.journal).toHaveLength(before);
    expect(graphics(e1)).toHaveLength(1);
  });
});
