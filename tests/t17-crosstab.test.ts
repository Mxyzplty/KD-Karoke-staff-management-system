// SPDX-License-Identifier: AGPL-3.0-only
// T17 ledger row 11 (findings part 2 §36): the per-project BroadcastChannel. Node's global BroadcastChannel delivers between channel objects of the same name.
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { AutosaveSession } from '../apps/web/src/store/autosave';
import { emptyDocument, StoreError } from '../apps/web/src/store/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { ProjectStore } from '../apps/web/src/store/database';
import type { MediaStore } from '../apps/web/src/store/media';
import { openVersions } from '../apps/web/src/versions/editor';
import { activeChannel, channelName, SAVE_MESSAGE, SaveChannel } from '../apps/web/src/versions/crosstab';

const closers: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const c of closers.splice(0)) c(); });
const pause = (ms = 60) => new Promise(r => setTimeout(r, ms));

/** A stored document moved by "other tabs" (replace) and a port that refuses stale writes, as the T01 store does. */
function fixture(rev = 0) {
  let stored: ProjectDocument = { ...emptyDocument(), rev };
  const port = {
    read: vi.fn(async () => ({ record: {} as any, document: structuredClone(stored) })),
    save: vi.fn(async (_id: string, doc: ProjectDocument, expected: number) => {
      if (expected !== stored.rev) throw new StoreError('CONFLICT', 'Another tab changed this project.');
      stored = structuredClone({ ...doc, rev: expected + 1 }); return stored;
    }),
  };
  return { port, stored: () => stored, replace: (d: ProjectDocument) => { stored = d; } };
}
/** A tab: the session, its SaveChannel bound to it, and a raw channel on the same name to play "another tab". */
function tab(f: ReturnType<typeof fixture>, projectId = crypto.randomUUID()) {
  const session = new AutosaveSession(f.port, projectId, structuredClone(f.stored())), channel = new SaveChannel(projectId);
  const unlisten = channel.listen(session), other = new BroadcastChannel(channelName(projectId));
  closers.push(() => { unlisten(); channel.close(); other.close(); });
  const send = (message: unknown) => other.postMessage(message);
  return { session, channel, other, send, projectId, unlisten, reload: vi.spyOn(session, 'reload'), flush: vi.spyOn(session, 'flush') };
}

it('L11 channel name is cutframe-project-<id>; a save posts exactly {type, rev, senderId} after success only', async () => {
  const f = fixture(), t = tab(f), heard: any[] = []; t.other.onmessage = e => heard.push(e.data);
  expect(channelName('abc')).toBe('cutframe-project-abc'); expect(SAVE_MESSAGE).toBe('cutframe-save');
  const wrapped = t.channel.wrap(f.port);
  const saved = await wrapped.save(t.projectId, emptyDocument(), 0); expect(saved.rev).toBe(1);
  await vi.waitFor(() => expect(heard).toHaveLength(1));
  expect(heard[0]).toEqual({ type: 'cutframe-save', rev: 1, senderId: t.channel.senderId }); expect(Object.keys(heard[0]).sort()).toEqual(['rev', 'senderId', 'type']);
  await expect(wrapped.save(t.projectId, emptyDocument(), 0)).rejects.toMatchObject({ code: 'CONFLICT' }); // stale: refused, nothing announced
  await pause(); expect(heard).toHaveLength(1);
  expect(await wrapped.read(t.projectId)).toMatchObject({ document: { rev: 1 } });
});

it('L11 two SaveChannels have distinct sender ids', () => {
  const a = new SaveChannel('p'), b = new SaveChannel('p'); closers.push(() => { a.close(); b.close(); });
  expect(a.senderId).not.toBe(b.senderId); expect(a.senderId).toMatch(/[0-9a-f-]{36}/);
});

it('L11 ignores its own sender id, other message types, malformed revs', async () => {
  const f = fixture(), t = tab(f); f.replace({ ...emptyDocument(), rev: 5 });
  t.send({ type: 'cutframe-save', rev: 5, senderId: t.channel.senderId });
  t.send({ type: 'something-else', rev: 5, senderId: 'x' });
  t.send({ type: 'cutframe-save', rev: '5', senderId: 'x' });
  t.send({ type: 'cutframe-save', senderId: 'x' });
  t.send(null); t.send('cutframe-save');
  await pause(); expect(t.reload).not.toHaveBeenCalled(); expect(t.flush).not.toHaveBeenCalled(); expect(t.session.document.rev).toBe(0);
});

it('L11 ignores revs ≤ the session rev and ≤ the last rev seen; a newer one from another sender refetches a clean tab', async () => {
  const f = fixture(2), t = tab(f); f.replace({ ...emptyDocument(), fps: 24, rev: 3 });
  t.send({ type: 'cutframe-save', rev: 2, senderId: 'x' }); t.send({ type: 'cutframe-save', rev: 1, senderId: 'x' }); await pause();
  expect(t.reload).not.toHaveBeenCalled(); expect(t.session.document.fps).toBe(30);
  t.send({ type: 'cutframe-save', rev: 3, senderId: 'x' });
  await vi.waitFor(() => expect(t.session.document).toMatchObject({ fps: 24, rev: 3 })); expect(t.reload).toHaveBeenCalledOnce(); expect(t.session.state).toBe('saved');
  t.send({ type: 'cutframe-save', rev: 3, senderId: 'y' }); t.send({ type: 'cutframe-save', rev: 3, senderId: 'x' }); await pause();
  expect(t.reload).toHaveBeenCalledOnce(); // already seen
});

it('L11 a tab\'s own post counts as seen: the same rev from another sender is ignored', async () => {
  const f = fixture(), t = tab(f); t.channel.post(4); f.replace({ ...emptyDocument(), rev: 4 });
  t.send({ type: 'cutframe-save', rev: 4, senderId: 'x' }); await pause(); expect(t.reload).not.toHaveBeenCalled();
  t.send({ type: 'cutframe-save', rev: 5, senderId: 'x' }); await vi.waitFor(() => expect(t.reload).toHaveBeenCalledOnce());
});

it('L11 a dirty tab flushes, meets the newer stored rev and enters the conflict state with its edit kept (no silent overwrite)', async () => {
  const f = fixture(), t = tab(f);
  t.session.update({ ...t.session.document, fps: 60 }); expect(t.session.state).toBe('pending');
  f.replace({ ...emptyDocument(), fps: 24, rev: 1 });
  t.send({ type: 'cutframe-save', rev: 1, senderId: 'x' });
  await vi.waitFor(() => expect(t.session.state).toBe('conflict'));
  expect(t.reload).not.toHaveBeenCalled(); expect(t.session.error).toMatchObject({ code: 'CONFLICT' });
  expect(t.session.document.fps).toBe(60); expect(f.stored()).toMatchObject({ fps: 24, rev: 1 });
  // In the conflict state further messages change nothing.
  t.flush.mockClear(); t.send({ type: 'cutframe-save', rev: 2, senderId: 'x' }); await pause(); expect(t.flush).not.toHaveBeenCalled(); expect(t.session.state).toBe('conflict');
});

it('L11 a tab that is saving or pending is dirty (not clean): it is not reloaded', async () => {
  const f = fixture(), t = tab(f); t.session.update({ ...t.session.document, fps: 60 }); f.replace({ ...emptyDocument(), fps: 24, rev: 1 });
  t.send({ type: 'cutframe-save', rev: 1, senderId: 'x' }); await vi.waitFor(() => expect(t.session.state).toBe('conflict')); expect(t.reload).not.toHaveBeenCalled();
});

it('L11 unlisten stops reacting; a closed channel is mute and deaf', async () => {
  const f = fixture(), a = tab(f);
  a.channel.close(); f.replace({ ...emptyDocument(), rev: 1 }); a.send({ type: 'cutframe-save', rev: 1, senderId: 'x' }); await pause(); expect(a.reload).not.toHaveBeenCalled();
  const heard: any[] = []; a.other.onmessage = e => heard.push(e.data); a.channel.post(9); await pause(); expect(heard).toEqual([]);
  const b = tab(fixture()); b.unlisten(); b.send({ type: 'cutframe-save', rev: 1, senderId: 'x' }); await pause(); expect(b.reload).not.toHaveBeenCalled();
});

it('L11 two real tabs of one project: tab A saves through its wrapped store, clean tab B refetches', async () => {
  const f = fixture(), id = crypto.randomUUID(), a = new SaveChannel(id), b = new SaveChannel(id);
  const sa = new AutosaveSession(a.wrap(f.port), id, f.stored()), sb = new AutosaveSession(b.wrap(f.port), id, f.stored());
  closers.push(a.listen(sa), b.listen(sb), () => { a.close(); b.close(); });
  sa.update({ ...sa.document, fps: 24 }); await sa.flush();
  await vi.waitFor(() => expect(sb.document).toMatchObject({ fps: 24, rev: 1 })); expect(sb.state).toBe('saved');
  expect(sa.document.rev).toBe(1); // A did not react to its own message
  sb.update({ ...sb.document, fps: 60 }); await sb.flush(); await vi.waitFor(() => expect(sa.document).toMatchObject({ fps: 60, rev: 2 }));
});

/** The open editor's wiring (openVersions on a real ProjectStore): a session saving through the announcing store, plus a raw channel playing "another tab". */
async function editorTab() {
  const bytes = new Map<string, Blob>(), media: MediaStore = { write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!), remove: vi.fn(async () => {}) };
  const store = new ProjectStore(crypto.randomUUID(), undefined, media), record = await store.create('Project', emptyDocument()), loaded = (await store.read(record.id))!;
  const versions = openVersions(store, record.id, 'default', vi.fn()), session = new AutosaveSession(versions.store, record.id, loaded.document, { beforeLargeDeletion: versions.beforeLargeDeletion });
  const teardown = versions.attach(session), channel = activeChannel!, other = new BroadcastChannel(channelName(record.id)), heard: any[] = [];
  other.onmessage = e => heard.push(e.data);
  closers.push(teardown, () => { other.close(); void store.close(); });
  const edit = () => session.update({ ...session.document, fps: 24 });
  return { store, id: record.id, r: loaded.document.rev, session, teardown, channel, other, heard, edit, send: (m: unknown) => other.postMessage(m) };
}

it('L11 teardown(session.flush()) in the same tick as an edit: the final save is still announced exactly once and stored (§45.2)', async () => {
  const t = await editorTab(); expect(activeChannel).toBe(t.channel);
  t.edit(); t.teardown(t.session.flush()); // what the editor cleanup does on "Back to home" inside the 3 s debounce
  await vi.waitFor(() => expect(t.heard).toHaveLength(1));
  expect(t.heard[0]).toEqual({ type: 'cutframe-save', rev: t.r + 1, senderId: expect.stringMatching(/^[0-9a-f-]{36}$/) }); expect(Object.keys(t.heard[0]).sort()).toEqual(['rev', 'senderId', 'type']);
  expect(t.heard[0].senderId).toBe(t.channel.senderId);
  expect((await t.store.read(t.id))!.document).toMatchObject({ rev: t.r + 1, fps: 24 });
  await pause(); expect(t.heard).toHaveLength(1);
});

it('L11 the teardown stops listening at once, while the final save is still in flight: a newer rev does not reload or flush the old session', async () => {
  const t = await editorTab(); const reload = vi.spyOn(t.session, 'reload'), flush = vi.spyOn(t.session, 'flush');
  t.send({ type: 'cutframe-save', rev: t.r + 1, senderId: 'x' }); await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce()); // control: listening before the teardown
  let settle!: () => void; const final = new Promise<void>(resolve => { settle = resolve; });
  t.teardown(final); flush.mockClear();
  t.send({ type: 'cutframe-save', rev: t.r + 2, senderId: 'x' }); t.send({ type: 'cutframe-save', rev: t.r + 3, senderId: 'y' }); await pause();
  expect(reload).toHaveBeenCalledOnce(); expect(flush).not.toHaveBeenCalled(); expect(activeChannel).toBe(t.channel); // channel is still open until the final save settles
  settle();
});

it('L11 once the final save settles the channel is closed: a later post is not heard and activeChannel is cleared', async () => {
  const t = await editorTab(); let settle!: () => void; const final = new Promise<void>(resolve => { settle = resolve; });
  t.teardown(final); t.channel.post(t.r + 1); await vi.waitFor(() => expect(t.heard).toHaveLength(1)); // open while the final save is in flight
  settle(); await final; await pause();
  expect(activeChannel).toBeUndefined(); t.channel.post(t.r + 2); await pause(); expect(t.heard).toHaveLength(1);
});

it('L11 a final save that rejects still closes the channel afterwards', async () => {
  const t = await editorTab(); t.teardown(Promise.reject(new Error('boom'))); await pause();
  expect(activeChannel).toBeUndefined(); t.channel.post(t.r + 1); await pause(); expect(t.heard).toEqual([]);
});

it('L11 a teardown with no argument closes the channel (nothing heard from a later post)', async () => {
  const t = await editorTab(); t.teardown(); await pause();
  expect(activeChannel).toBeUndefined(); t.channel.post(t.r + 1); await pause(); expect(t.heard).toEqual([]);
});
