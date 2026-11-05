// SPDX-License-Identifier: AGPL-3.0-only
// T17 checkpoints (ledger rows 1–6, 8, 10; wave-3 fixtures F1–F5). Real ProjectStore on fake-indexeddb, real AutosaveSession, real Checkpoints.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import { AutosaveSession } from '../apps/web/src/store/autosave';
import { emptyDocument } from '../apps/web/src/store/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { dispatch } from '../apps/web/src/editor/commands';
import { CommandBus, snapshot } from '../apps/web/src/timeline/bus';
import { fingerprint } from '../apps/web/src/timeline/runtime';
import { Checkpoints, insert, installCheckpoints, LIMITS, PARITY_KEY, readMode, RECOVERY_LABEL, RESTORE_LABEL, restoreCheckpoint, saveAsCopy, saveCheckpoint } from '../apps/web/src/versions/checkpoints';
import type { Checkpoint, CheckpointRow, Mode } from '../apps/web/src/versions/checkpoints';
import { openVersions } from '../apps/web/src/versions/editor';

const opened: ProjectStore[] = [], cleanups: (() => void)[] = [];
function newStore() {
  const bytes = new Map<string, Blob>();
  const media: MediaStore = { write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!), remove: vi.fn(async () => {}) };
  const store = new ProjectStore(crypto.randomUUID(), undefined, media); opened.push(store); return store;
}
afterEach(async () => { vi.restoreAllMocks(); for (const c of cleanups.splice(0)) c(); for (const s of opened.splice(0)) await s.close(); });

const docOf = (n: number, extra: Partial<ProjectDocument> = {}): ProjectDocument => ({ ...emptyDocument(), items: Array.from({ length: n }, (_, i) => ({ id: `i${i}` })), ...extra });
/** Sorted keys, `rev` dropped: the comparison form of the "byte-identical normalised JSON" check. */
const norm = (d: ProjectDocument) => JSON.stringify(d, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v).replace(/"rev":\d+,?/, '');
const normalised = (d: ProjectDocument) => norm({ ...d, rev: 0 });
const journalCount = async (store: ProjectStore) => (await store.rows<{ id: string }>('settings')).filter(r => r.id.startsWith('journal:')).length;

/** A project with `n` items and an autosave session; the injected clock advances 1 s per reading, so ids are distinct and ordered. */
async function open(mode: Mode, n = 3) {
  const store = newStore(), record = await store.create('Project', docOf(n)), loaded = (await store.read(record.id))!;
  const session = new AutosaveSession(store, record.id, loaded.document);
  let now = 1_700_000_000_000; const clock = () => (now += 1000);
  const checkpoints = new Checkpoints(store, record.id, mode, clock);
  let marks = 0;
  const edit = () => session.update({ ...session.document, markers: [...session.document.markers, { id: `m${++marks}`, timeMs: marks }] });
  return { store, record, session, checkpoints, clock, edit, id: record.id };
}
const ids = (list: Checkpoint[]) => list.map(c => c.id);

describe('L1/F1 Save = checkpoint (parity: 3 newest, unnamed)', () => {
  it('L1/F1 four Saves each after a small change keep exactly the 3 newest, newest first, as bare {id, timestamp, editorState}', async () => {
    const t = await open('parity');
    const s0a = (await t.checkpoints.add(docOf(1, { fps: 24 })))[0], s0b = (await t.checkpoints.add(docOf(1, { fps: 25 })))[0];
    expect(ids(await t.checkpoints.list())).toEqual([s0b.id, s0a.id]);
    let previous = [s0b.id, s0a.id]; const made: Checkpoint[] = [];
    for (const k of [1, 2, 3, 4]) {
      t.edit(); // unsaved when Save is pressed: Save must flush it first
      const list = await saveCheckpoint(t.session, t.store, t.checkpoints);
      const s = list[0]; made.push(s);
      const expected = [s.id, ...previous].slice(0, 3);
      expect(ids(list)).toEqual(expected); expect(ids(await t.checkpoints.list())).toEqual(expected);
      if (k === 1) expect(ids(list)).toEqual([s.id, s0b.id, s0a.id]);
      if (k === 2) expect(ids(list)).toEqual([s.id, made[0].id, s0b.id]);
      if (k === 3) expect(ids(list)).toEqual([s.id, made[1].id, made[0].id]);
      if (k === 4) expect(ids(list)).toEqual([s.id, made[2].id, made[1].id]);
      previous = expected;
      expect(Object.keys(s).sort()).toEqual(['editorState', 'id', 'timestamp']); // no name, no rev, no label
      expect(s.id).toMatch(/^checkpoint_\d+$/); expect(s.timestamp).toBe(new Date(Number(s.id.slice('checkpoint_'.length))).toISOString());
      // The pending change was flushed first: the checkpoint holds it, and equals the stored document.
      const stored = (await t.store.read(t.id))!.document;
      expect(s.editorState).toEqual(stored); expect(s.editorState.markers).toHaveLength(k); expect(t.session.state).toBe('saved');
    }
  });
  it('L1 the list is one IDB settings row checkpoints:<projectId> = {id, project_id, checkpoints, updated_at}', async () => {
    const t = await open('parity'); await saveCheckpoint(t.session, t.store, t.checkpoints);
    const row = await t.store.row<CheckpointRow>('settings', `checkpoints:${t.id}`);
    expect(row).toMatchObject({ id: `checkpoints:${t.id}`, project_id: t.id }); expect(row!.checkpoints).toHaveLength(1); expect(Number.isNaN(Date.parse(row!.updated_at))).toBe(false);
  });
  it('L1 ids come from the clock: checkpoint_<epoch ms> (real clock), two in one millisecond stay distinct', async () => {
    const store = newStore(), record = await store.create('P', docOf(1)), c = new Checkpoints(store, record.id, 'default');
    const before = Date.now(); await c.add(docOf(1)); const list = await c.add(docOf(2)); const after = Date.now();
    for (const cp of list) { const ms = Number(cp.id.slice('checkpoint_'.length)); expect(ms).toBeGreaterThanOrEqual(before); expect(ms).toBeLessThanOrEqual(after + 5); }
    expect(new Set(ids(list)).size).toBe(2);
  });
  it('L1 Save with nothing to save and no changes still adds a checkpoint of the stored document', async () => {
    const t = await open('parity'); const list = await saveCheckpoint(t.session, t.store, t.checkpoints);
    expect(list).toHaveLength(1); expect(list[0].editorState).toEqual((await t.store.read(t.id))!.document);
  });
  it.each(['CONFLICT', 'blocked'] as const)('L1 a Save that cannot complete (%s) throws and writes no checkpoint', async kind => {
    const t = await open('default');
    if (kind === 'CONFLICT') { const d = (await t.store.read(t.id))!.document; await t.store.save(t.id, { ...d, fps: 24 }, d.rev); t.edit(); }
    else { vi.spyOn(t.store, 'read').mockResolvedValue({ record: t.record, document: docOf(5) }); const s = new AutosaveSession(t.store, t.id, emptyDocument(), { fullyLoaded: false }); s.update({ ...emptyDocument(), fps: 24 }); await expect(saveCheckpoint(s, t.store, t.checkpoints)).rejects.toMatchObject({ code: 'SAVE_PAUSED' }); expect(await t.checkpoints.list()).toEqual([]); return; }
    await expect(saveCheckpoint(t.session, t.store, t.checkpoints)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await t.checkpoints.list()).toEqual([]);
  });
});

describe('L2/F2 restore', () => {
  async function withThree(mode: Mode) {
    const t = await open(mode); const made: Checkpoint[] = [];
    for (let k = 0; k < 3; k++) { t.edit(); made.push((await saveCheckpoint(t.session, t.store, t.checkpoints))[0]); }
    return { ...t, oldest: made[0], made };
  }
  it('L2/F2 restoring the oldest writes its document as the stored document (rev + 1, byte-identical normalised JSON), no journal row, list unchanged', async () => {
    const t = await withThree('parity'); t.edit(); await t.session.flush();
    const listBefore = await t.checkpoints.list(), rowsBefore = await journalCount(t.store), rev = t.session.document.rev, reopen = vi.fn();
    const restored = await restoreCheckpoint(t.session, t.store, t.oldest, 'parity', reopen);
    const stored = (await t.store.read(t.id))!.document;
    expect(stored.rev).toBe(rev + 1); expect(restored).toEqual(stored);
    expect(normalised(stored)).toBe(normalised(t.oldest.editorState)); expect(stored.markers.map(m => m.id)).toEqual(['m1']);
    expect(await journalCount(t.store)).toBe(rowsBefore); expect(await t.checkpoints.list()).toEqual(listBefore);
    expect(reopen).toHaveBeenCalledOnce(); expect(reopen.mock.calls[0][0]).toBeTypeOf('function');
  });
  it('L2 restore flushes a pending edit first, then overwrites it (rev advances by the flush and the restore)', async () => {
    const t = await withThree('default'); const rev = t.session.document.rev; t.edit();
    await restoreCheckpoint(t.session, t.store, t.oldest, 'default', vi.fn());
    const stored = (await t.store.read(t.id))!.document; expect(stored.rev).toBe(rev + 2); expect(normalised(stored)).toBe(normalised(t.oldest.editorState));
  });
  it('L2 a restore while another writer moved the stored rev → CONFLICT, nothing written, no reopen', async () => {
    const t = await withThree('parity'); const other = (await t.store.read(t.id))!.document;
    await t.store.save(t.id, { ...other, fps: 12 }, other.rev); const after = (await t.store.read(t.id))!.document;
    const reopen = vi.fn(); await expect(restoreCheckpoint(t.session, t.store, t.oldest, 'parity', reopen)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await t.store.read(t.id))!.document).toEqual(after); expect(reopen).not.toHaveBeenCalled();
  });
});

describe('L3 restore history', () => {
  it('L3 parity: the persisted history row is deleted by the reopen job (Undo disabled after reopen)', async () => {
    const t = await open('parity'); t.edit(); const cp = (await saveCheckpoint(t.session, t.store, t.checkpoints))[0];
    await t.store.putRow('settings', { id: `history:${t.id}`, at: 'x', undo: [{ label: 'Delete items' }], redo: [] });
    let job!: () => Promise<void>; await restoreCheckpoint(t.session, t.store, cp, 'parity', j => { job = j; });
    expect(await t.store.row('settings', `history:${t.id}`)).toBeDefined(); // untouched until the old editor is torn down
    await job(); expect(await t.store.row('settings', `history:${t.id}`)).toBeUndefined();
  });
  it('L3 default: the history is exactly one "Restore checkpoint" step; undoing it returns to the exact pre-restore state', async () => {
    const t = await open('default'); t.edit(); const cp = (await saveCheckpoint(t.session, t.store, t.checkpoints))[0];
    t.edit(); t.edit(); await t.session.flush(); const pre = structuredClone(t.session.document);
    await t.store.putRow('settings', { id: `history:${t.id}`, at: 'x', undo: [{ label: 'Delete items' }, { label: 'Add items' }], redo: [{ label: 'Redo' }] });
    let job!: () => Promise<void>; const restored = await restoreCheckpoint(t.session, t.store, cp, 'default', j => { job = j; }, () => 42);
    await job();
    const row = (await t.store.row<{ id: string; at: string; undo: any[]; redo: any[] }>('settings', `history:${t.id}`))!;
    expect(RESTORE_LABEL).toBe('Restore checkpoint');
    expect(row.id).toBe(`history:${t.id}`); expect(row.at).toBe(fingerprint(restored)); expect(row.redo).toEqual([]);
    expect(row.undo).toHaveLength(1); expect(row.undo[0]).toMatchObject({ label: 'Restore checkpoint', source: 'user', timestamp: 42 });
    expect(row.undo[0].before).toEqual(snapshot(pre)); expect(row.undo[0].after).toEqual(snapshot(restored));
    // Undo through the real bus, loaded from the persisted row, lands on the pre-restore state.
    let doc = (await t.store.read(t.id))!.document; const bus = new CommandBus({ get: () => doc, set: d => { doc = d; } });
    bus.restore(row.undo, row.redo); expect(bus.canUndo()).toBe(true); bus.undo();
    expect(snapshot(doc)).toEqual(snapshot(pre)); expect(bus.canUndo()).toBe(false); expect(bus.canRedo()).toBe(true);
  });
});

describe('L4/F3 delete', () => {
  it('L4/F3 delete removes only that checkpoint and leaves the others (and their order) intact', async () => {
    const t = await open('default'); const made: Checkpoint[] = [];
    for (let k = 0; k < 3; k++) { t.edit(); made.push((await saveCheckpoint(t.session, t.store, t.checkpoints))[0]); }
    const list = await t.checkpoints.remove(made[1].id);
    expect(ids(list)).toEqual([made[2].id, made[0].id]); expect(await t.checkpoints.list()).toEqual([made[2], made[0]]);
    expect(await t.checkpoints.remove('checkpoint_missing')).toEqual([made[2], made[0]]);
  });
  it('L4 notifies subscribers with the cause', async () => {
    const t = await open('parity'); const seen: string[] = []; const off = t.checkpoints.subscribe((list, cause) => seen.push(`${cause}:${list.length}`));
    const [a] = await t.checkpoints.add(docOf(1)); await t.checkpoints.add(docOf(1), { recovery: true }); await t.checkpoints.remove(a.id); off(); await t.checkpoints.add(docOf(1));
    expect(seen).toEqual(['save:1', 'recovery:2', 'delete:1']);
  });
});

describe('L5/F4 recovery checkpoints', () => {
  /** The editor's wiring (channel-wrapped store, guard hook, intents), minus React. */
  async function wired(mode: Mode, items: number) {
    const t = await open(mode, items), reopen = vi.fn(), v = openVersions(t.store, t.id, mode, reopen);
    const saves: { items: number; listAtSave: Checkpoint[] }[] = [], original = t.store.save.bind(t.store);
    vi.spyOn(t.store, 'save').mockImplementation(async (id, doc, rev) => { saves.push({ items: doc.items.length, listAtSave: await v.checkpoints.list() }); return original(id, doc, rev); });
    const session = new AutosaveSession(v.store, t.id, (await t.store.read(t.id))!.document, { beforeLargeDeletion: v.beforeLargeDeletion });
    cleanups.push(v.attach(session));
    const shrink = async (to: number) => { session.update({ ...session.document, items: session.document.items.slice(0, to) }); await session.flush(); };
    return { ...t, v, session, saves, shrink, grow: async (to: number) => { session.update({ ...session.document, items: Array.from({ length: to }, (_, i) => ({ id: `n${i}` })) }); await session.flush(); } };
  }
  it.each(['parity', 'default'] as const)('L5/F4 (%s) 4→2 in one save (two steps before the debounce) and 2→1 each write a recovery checkpoint of the state BEFORE the drop, in the same save', async mode => {
    const t = await wired(mode, 4);
    t.session.update({ ...t.session.document, items: t.session.document.items.slice(0, 3) }); t.session.update({ ...t.session.document, items: t.session.document.items.slice(0, 2) });
    await t.session.flush();
    let list = await t.v.checkpoints.list(); expect(list).toHaveLength(1);
    const a1 = list[0];
    expect(a1.label).toBe(RECOVERY_LABEL); expect(RECOVERY_LABEL).toBe('Automatic recovery before large deletion'); expect(a1.rev).toBe(0);
    expect(a1.editorState.items).toHaveLength(4); expect(a1.editorState.rev).toBe(0); expect(a1.id).toMatch(/^checkpoint_\d+$/);
    expect(t.saves).toHaveLength(1); expect(t.saves[0].items).toBe(2); expect(ids(t.saves[0].listAtSave)).toEqual([a1.id]); // the checkpoint landed before the document save
    expect((await t.store.read(t.id))!.document.items).toHaveLength(2);
    await t.shrink(1);
    list = await t.v.checkpoints.list(); const a2 = list[0];
    expect(a2.id).not.toBe(a1.id); expect(a2.label).toBe(RECOVERY_LABEL); expect(a2.rev).toBe(1); expect(a2.editorState.items).toHaveLength(2);
    expect(t.saves).toHaveLength(2); expect(ids(t.saves[1].listAtSave)).toContain(a2.id); expect((await t.store.read(t.id))!.document.items).toHaveLength(1);
  });
  it('L5/F4 parity: [M3,M2,M1] + two drops → [A2,A1,M3] (recovery shares the 3 slots and evicts manual ones)', async () => {
    const t = await wired('parity', 4); const m: Checkpoint[] = [];
    for (let k = 1; k <= 3; k++) m.push((await t.v.checkpoints.add(docOf(k)))[0]);
    expect(ids(await t.v.checkpoints.list())).toEqual([m[2].id, m[1].id, m[0].id]);
    await t.shrink(2); await t.shrink(1);
    const list = await t.v.checkpoints.list(); expect(list.map(c => c.label ?? 'M')).toEqual([RECOVERY_LABEL, RECOVERY_LABEL, 'M']); expect(list[2].id).toBe(m[2].id);
    expect(list[1].editorState.items).toHaveLength(4); expect(list[0].editorState.items).toHaveLength(2);
  });
  it('L5/F4 default: recovery checkpoints have their own slots — manual ones are never evicted', async () => {
    const t = await wired('default', 4); const m: Checkpoint[] = [];
    for (let k = 1; k <= 3; k++) m.push((await t.v.checkpoints.add(docOf(k)))[0]);
    await t.shrink(2); await t.shrink(1);
    const list = await t.v.checkpoints.list(); expect(list).toHaveLength(5);
    expect(list.map(c => c.label ? 'A' : 'M')).toEqual(['A', 'A', 'M', 'M', 'M']); expect(ids(list.slice(2))).toEqual([m[2].id, m[1].id, m[0].id]);
  });
  it('L5 default: recovery checkpoints are capped at 3 (the oldest recovery goes, manual stay)', async () => {
    const t = await wired('default', 20); const m = (await t.v.checkpoints.add(docOf(1)))[0];
    await t.shrink(8); const first = (await t.v.checkpoints.list())[0]; await t.shrink(3); await t.shrink(1); await t.grow(10); await t.shrink(4);
    const list = await t.v.checkpoints.list(); const recovery = list.filter(c => c.label);
    expect(recovery).toHaveLength(LIMITS.recovery); expect(ids(recovery)).not.toContain(first.id); expect(ids(list)).toContain(m.id);
    expect(recovery.map(c => c.editorState.items.length)).toEqual([10, 3, 8]); // newest first: the states before 10→4, 3→1, 8→3 (the 20→8 one was evicted)
  });
  it('L5 a small deletion (≥ half left, < 5 removed) writes no checkpoint and does not reread', async () => {
    const t = await wired('parity', 10); await t.shrink(9); await t.shrink(6);
    expect(await t.v.checkpoints.list()).toEqual([]);
  });
  it.each(['parity', 'default'] as const)('L5 (%s) if the recovery checkpoint cannot be written the save does not happen', async mode => {
    const t = await wired(mode, 4); vi.spyOn(t.v.checkpoints, 'add').mockRejectedValue(new Error('storage full'));
    t.session.update({ ...t.session.document, items: [] }); await t.session.flush();
    expect(t.session.state).toBe('error'); expect(t.saves).toHaveLength(0);
    const stored = (await t.store.read(t.id))!.document; expect(stored.items).toHaveLength(4); expect(stored.rev).toBe(0); expect(t.session.document.items).toHaveLength(0); // the edit is kept in memory
  });
});

describe('L6/F5 autosave never writes a checkpoint', () => {
  it('L6/F5 several edits and autosaves (timer and flush) leave the checkpoint list unchanged', async () => {
    const t = await open('default'); const kept = (await t.checkpoints.add(docOf(1)))[0];
    const v = openVersions(t.store, t.id, 'default', vi.fn()), session = new AutosaveSession(v.store, t.id, (await t.store.read(t.id))!.document, { beforeLargeDeletion: v.beforeLargeDeletion });
    cleanups.push(v.attach(session));
    for (let k = 0; k < 3; k++) { session.update({ ...session.document, markers: [...session.document.markers, { id: `a${k}`, timeMs: k }] }); await session.flush(); }
    session.update({ ...session.document, fps: 24 }); await vi.waitFor(() => expect(session.state).toBe('saved'), { timeout: 6000, interval: 100 }); // the real 3 s debounce
    expect((await t.store.read(t.id))!.document.rev).toBe(4);
    expect(await t.checkpoints.list()).toEqual([kept]);
  });
});

describe('L8 improvements (Cutframe default)', () => {
  it('L8 names are trimmed, optional, ignored in parity mode, and an empty rename clears the name', async () => {
    const t = await open('default'); const [a] = await t.checkpoints.add(docOf(1), { name: '  First cut  ' });
    expect(a.name).toBe('First cut'); expect((await t.checkpoints.add(docOf(1), { name: '   ' }))[0]).not.toHaveProperty('name');
    expect((await t.checkpoints.rename(a.id, '  Final  ')).find(c => c.id === a.id)!.name).toBe('Final');
    const cleared = (await t.checkpoints.rename(a.id, '   ')).find(c => c.id === a.id)!; expect(cleared).not.toHaveProperty('name');
    const p = await open('parity'); const [x] = await p.checkpoints.add(docOf(1), { name: 'Named' }); expect(x).not.toHaveProperty('name');
    expect((await p.checkpoints.rename(x.id, 'Later')).find(c => c.id === x.id)).not.toHaveProperty('name');
  });
  it('L8 the default list is longer: 20 manual checkpoints; recovery checkpoints use their own 3 slots', async () => {
    const t = await open('default'); for (let k = 0; k < 22; k++) await t.checkpoints.add(docOf(1, { fps: 20 + k }));
    let list = await t.checkpoints.list(); expect(list).toHaveLength(LIMITS.manual); expect(list[0].editorState.fps).toBe(41); expect(list[19].editorState.fps).toBe(22);
    for (let k = 0; k < 4; k++) await t.checkpoints.add(docOf(1), { recovery: true });
    list = await t.checkpoints.list(); expect(list.filter(c => c.label)).toHaveLength(3); expect(list.filter(c => !c.label)).toHaveLength(20);
    expect(LIMITS).toEqual({ parity: 3, manual: 20, recovery: 3 });
  });
  it('L8 insert() is pure: parity keeps the 3 newest of both kinds', () => {
    const cp = (id: string, recovery = false): Checkpoint => ({ id, timestamp: '', editorState: docOf(0), ...(recovery ? { label: RECOVERY_LABEL, rev: 0 } : {}) });
    expect(insert([cp('b'), cp('a')], cp('c'), 'parity').map(c => c.id)).toEqual(['c', 'b', 'a']);
    expect(insert([cp('c'), cp('b'), cp('a')], cp('r', true), 'parity').map(c => c.id)).toEqual(['r', 'c', 'b']);
  });
  it('L8 readMode: the parity-mode settings row switches the mode; absent or false = default', async () => {
    const store = newStore(); expect(PARITY_KEY).toBe('parity-mode'); expect(await readMode(store)).toBe('default');
    await store.putRow('settings', { id: PARITY_KEY, enabled: false }); expect(await readMode(store)).toBe('default');
    await store.putRow('settings', { id: PARITY_KEY, enabled: true }); expect(await readMode(store)).toBe('parity');
  });
});

describe('intent handler (saveCheckpoint / restoreCheckpoint / deleteCheckpoint / renameCheckpoint)', () => {
  it('L1/L2/L4/L8 dispatch answers {ok:true} at once; the work follows; an unknown id restores nothing', async () => {
    const t = await open('default'), reopen = vi.fn();
    cleanups.push(installCheckpoints(t.session, { read: id => t.store.read(id), save: (...a) => t.store.save(...a), putRow: (s, v) => t.store.putRow(s, v), deleteRow: (s, k) => t.store.deleteRow(s, k) }, t.checkpoints, reopen));
    t.edit(); expect(dispatch({ type: 'saveCheckpoint', name: 'Named' })).toEqual({ ok: true });
    await vi.waitFor(async () => expect(await t.checkpoints.list()).toHaveLength(1)); const [cp] = await t.checkpoints.list(); expect(cp.name).toBe('Named');
    expect(dispatch({ type: 'renameCheckpoint', checkpointId: cp.id, name: 'Renamed' })).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await t.checkpoints.list())[0].name).toBe('Renamed'));
    expect(dispatch({ type: 'restoreCheckpoint', checkpointId: 'checkpoint_nope' })).toEqual({ ok: true }); await new Promise(r => setTimeout(r, 50)); expect(reopen).not.toHaveBeenCalled();
    t.edit(); await t.session.flush(); const rev = t.session.document.rev;
    expect(dispatch({ type: 'restoreCheckpoint', checkpointId: cp.id })).toEqual({ ok: true }); await vi.waitFor(() => expect(reopen).toHaveBeenCalledOnce());
    expect((await t.store.read(t.id))!.document.rev).toBe(rev + 1);
    expect(dispatch({ type: 'deleteCheckpoint', checkpointId: cp.id })).toEqual({ ok: true }); await vi.waitFor(async () => expect(await t.checkpoints.list()).toEqual([]));
  });
});

describe('L10 Save as copy keeps both versions', () => {
  it('L10 the copy holds this tab\'s document (rev 0) and the asset links; the stored original is untouched', async () => {
    const t = await open('default'), asset = await t.store.upload(new File(['bytes'], 'a.mp4', { type: 'video/mp4' })); await t.store.attach(t.id, asset.id);
    const other = (await t.store.read(t.id))!.document; await t.store.save(t.id, { ...other, fps: 12 }, other.rev); const original = (await t.store.read(t.id))!;
    t.edit(); await t.session.flush(); expect(t.session.state).toBe('conflict'); const mine = structuredClone(t.session.document);
    const copy = await saveAsCopy(t.session, t.store, original.record);
    expect(copy.title).toBe('Project (copy)'); expect(copy.id).not.toBe(t.id);
    const stored = (await t.store.read(copy.id))!.document; expect(stored).toEqual({ ...mine, rev: 0 }); expect(stored.fps).toBe(30); expect(stored.markers).toHaveLength(1);
    expect((await t.store.projectAssets(copy.id)).map(l => l.assetId)).toEqual([asset.id]);
    expect((await t.store.read(t.id))!.document).toEqual(original.document); expect((await t.store.read(t.id))!.document.fps).toBe(12);
    // The copy is a normal project: the original is still listed too.
    expect((await t.store.list()).map(p => p.id).sort()).toEqual([t.id, copy.id].sort());
  });
});
