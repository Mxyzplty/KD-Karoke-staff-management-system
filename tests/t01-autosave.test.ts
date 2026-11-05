// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { AutosaveSession } from '../apps/web/src/store/autosave';
import { emptyDocument, StoreError } from '../apps/web/src/store/model';
import type { ProjectDocument } from '../apps/web/src/store/model';

afterEach(() => vi.useRealTimers());
function fixture(count = 0) {
  let stored: ProjectDocument = { ...emptyDocument(), items: Array.from({ length: count }, (_, n) => ({ id: `i${n}` })) };
  const port = {
    read: vi.fn(async () => ({ record: {} as any, document: structuredClone(stored) })),
    save: vi.fn(async (_id: string, doc: ProjectDocument, rev: number) => {
      if (rev !== stored.rev) throw new StoreError('CONFLICT', 'Another tab changed this project.');
      stored = structuredClone({ ...doc, rev: rev + 1 }); return stored;
    }),
  };
  return { port, stored: () => stored, replace: (doc: ProjectDocument) => { stored = doc; } };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
it('debounces for 3 seconds, restarts on change, and skips unchanged saves', async () => {
  vi.useFakeTimers(); const f = fixture(), s = new AutosaveSession(f.port, 'p', emptyDocument());
  s.update({ ...s.document, fps: 24 }); await vi.advanceTimersByTimeAsync(2000);
  s.update({ ...s.document, fps: 60 }); await vi.advanceTimersByTimeAsync(2999); expect(f.port.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.port.save).toHaveBeenCalledTimes(1); expect(f.stored().fps).toBe(60); expect(s.state).toBe('saved');
  s.update(structuredClone(s.document)); await vi.advanceTimersByTimeAsync(3000); await s.flush(); expect(f.port.save).toHaveBeenCalledTimes(1);
});
it('runs one save at a time and coalesces edits during the write into one follow-up', async () => {
  vi.useFakeTimers();
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const original = f.port.save.getMockImplementation()!;
  f.port.save.mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument()); s.update({ ...s.document, fps: 24 }); const saving = s.flush();
  s.update({ ...s.document, fps: 48 }); s.update({ ...s.document, fps: 60 }); expect(f.port.save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000); expect(f.port.save).toHaveBeenCalledTimes(1);
  release(); await saving; expect(f.port.save).toHaveBeenCalledTimes(2); expect(f.stored()).toMatchObject({ fps: 60, rev: 2 });
});
it.each(['in-place', 'fresh-object'] as const)('adopts a successful %s preparation after exactly one write', async mode => {
  const f = fixture(), original = f.port.save.getMockImplementation()!;
  // Bound the old endless loop so a regression fails promptly instead of hanging the worker.
  f.port.save.mockImplementation(async (...args) => { if (f.port.save.mock.calls.length > 3) throw new Error('Repeated identical repair'); return original(...args); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument(), { prepareSave: d => {
    if (mode === 'in-place') { d.duration = 2000; return d; }
    return { ...d, duration: 2000 };
  } });
  s.update({ ...s.document, fps: 24 }); await s.flush();
  expect(f.port.save).toHaveBeenCalledOnce(); expect(s.state).toBe('saved'); expect(s.error).toBeUndefined();
  expect(s.document).toEqual(f.stored()); expect(s.document).toMatchObject({ duration: 2000, fps: 24, rev: 1 });
});
it('waits for the latest edit’s own debounce when the previous write finishes first', async () => {
  vi.useFakeTimers(); const f = fixture(), original = f.port.save.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.save.mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument());
  s.update({ ...s.document, fps: 24 }); await vi.advanceTimersByTimeAsync(3000); expect(f.port.save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(200); s.update({ ...s.document, fps: 60 }); // t = 3.2 s; due at 6.2 s.
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(f.port.save).toHaveBeenCalledOnce(); expect(s.state).toBe('pending'); expect(f.stored()).toMatchObject({ fps: 24, rev: 1 });
  await vi.advanceTimersByTimeAsync(2999); expect(f.port.save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(f.port.save).toHaveBeenCalledTimes(2); expect(f.stored()).toMatchObject({ fps: 60, rev: 2 });
});
it('a newer edit restarts an already queued follow-up debounce while the first write is still running', async () => {
  vi.useFakeTimers(); const f = fixture(), original = f.port.save.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.save.mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument());
  s.update({ ...s.document, fps: 24 }); await vi.advanceTimersByTimeAsync(3000);
  s.update({ ...s.document, fps: 48 }); await vi.advanceTimersByTimeAsync(3000); // Its timer expires during the first write.
  s.update({ ...s.document, fps: 60 }); await vi.advanceTimersByTimeAsync(100);
  release(); await vi.advanceTimersByTimeAsync(0); expect(f.port.save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2899); expect(f.port.save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(f.port.save).toHaveBeenCalledTimes(2); expect(f.stored().fps).toBe(60);
});
it('explicit flush while a write is running requests an immediate coalesced follow-up', async () => {
  vi.useFakeTimers(); const f = fixture(), original = f.port.save.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.save.mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument()); s.update({ ...s.document, fps: 24 }); const first = s.flush();
  s.update({ ...s.document, fps: 60 }); const forced = s.flush();
  expect(f.port.save).toHaveBeenCalledOnce(); release(); await Promise.all([first, forced]);
  expect(f.port.save).toHaveBeenCalledTimes(2); expect(f.stored()).toMatchObject({ fps: 60, rev: 2 });
});
it('a flush requested during a write is not forgotten by a subsequent edit', async () => {
  vi.useFakeTimers(); const f = fixture(), original = f.port.save.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let releaseFollowUp!: () => void; const followUp = new Promise<void>(resolve => { releaseFollowUp = resolve; });
  f.port.save.mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  f.port.save.mockImplementationOnce(async (...args) => { await followUp; return original(...args); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument());
  s.update({ ...s.document, fps: 24 }); const first = s.flush();
  s.update({ ...s.document, fps: 60 }); const forced = s.flush();
  let settled = false; void forced.then(() => { settled = true; });
  s.update({ ...s.document, fps: 48 }); release();
  await vi.waitFor(() => expect(f.port.save).toHaveBeenCalledTimes(2), { timeout: 100, interval: 1 });
  expect(settled).toBe(false); expect(f.stored().fps).toBe(24);
  releaseFollowUp(); await Promise.all([first, forced]);
  expect(f.port.save).toHaveBeenCalledTimes(2); expect(f.stored()).toMatchObject({ fps: 48, rev: 2 });
  expect(s.document).toEqual(f.stored()); expect(s.state).toBe('saved'); expect(vi.getTimerCount()).toBe(0);
});
it('flush at the save completion microtask boundary drains the new edit before its promise resolves', async () => {
  vi.useFakeTimers(); const f = fixture(), s = new AutosaveSession(f.port, 'p', emptyDocument());
  const original = f.port.save.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.save.mockImplementationOnce(original).mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  let late: Promise<void> | undefined, once = false, settled = false;
  s.subscribe(() => { if (s.state === 'saved' && !once) { once = true; queueMicrotask(() => {
    s.update({ ...s.document, fps: 60 }); late = s.flush(); void late.then(() => { settled = true; });
  }); } });
  s.update({ ...s.document, fps: 24 }); const first = s.flush();
  await vi.waitFor(() => expect(f.port.save).toHaveBeenCalledTimes(2), { timeout: 100, interval: 1 });
  expect(late).toBeDefined(); expect(settled).toBe(false); expect(f.stored().fps).toBe(24);
  release(); await Promise.all([first, late]);
  expect(f.port.save).toHaveBeenCalledTimes(2); expect(f.stored()).toMatchObject({ fps: 60, rev: 2 });
  expect(s.document).toEqual(f.stored()); expect(s.state).toBe('saved'); expect(vi.getTimerCount()).toBe(0);
});
it.each([['CONFLICT', 'conflict'], ['SAVE_PAUSED', 'blocked'], ['STORAGE_QUOTA', 'error']] as const)('queued flush callers settle when the session enters %s', async (code, state) => {
  vi.useFakeTimers(); const f = fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.save.mockImplementationOnce(async () => { await gate; throw new StoreError(code, 'Write refused.'); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument()); s.update({ ...s.document, fps: 24 }); const first = s.flush();
  s.update({ ...s.document, fps: 60 }); const forced = s.flush(); release(); await Promise.all([first, forced]);
  expect(s.state).toBe(state); expect(s.error).toMatchObject({ code }); expect(f.stored().fps).toBe(30); expect(f.port.save).toHaveBeenCalledOnce();
  if (state === 'error') { await s.flush(); expect(s.state).toBe('saved'); expect(f.stored().fps).toBe(60); }
  else { await s.flush(); expect(f.port.save).toHaveBeenCalledOnce(); await s.reload(); expect(s.state).toBe('saved'); }
});
it('Keep mine resolves identical local and remote edits to saved and notifies subscribers without another write', async () => {
  const f = fixture(), s = new AutosaveSession(f.port, 'p', emptyDocument());
  f.replace({ ...emptyDocument(), fps: 24, rev: 1 }); s.update({ ...s.document, fps: 24 }); await s.flush();
  expect(s.state).toBe('conflict'); const states: string[] = []; s.subscribe(() => states.push(s.state));
  await s.keepMine(); expect(s.state).toBe('saved'); expect(s.error).toBeUndefined(); expect(states.at(-1)).toBe('saved');
  expect(s.document).toEqual(f.stored()); expect(s.document.rev).toBe(1); expect(f.port.save).toHaveBeenCalledOnce();
});
it('holds local changes on conflict; Reload restores remote content; Keep mine conditionally saves against the new rev', async () => {
  const f = fixture(), s = new AutosaveSession(f.port, 'p', emptyDocument());
  f.replace({ ...emptyDocument(), fps: 24, rev: 1 }); s.update({ ...s.document, fps: 60 }); await s.flush();
  expect(s.state).toBe('conflict'); expect(s.document.fps).toBe(60); await s.flush(); expect(f.port.save).toHaveBeenCalledTimes(1);
  await s.keepMine(); expect(f.stored()).toMatchObject({ fps: 60, rev: 2 });
  f.replace({ ...emptyDocument(), fps: 25, rev: 3 }); await s.reload(); expect(s.document).toMatchObject({ fps: 25, rev: 3 }); expect(s.state).toBe('saved');
});
it.each(['read-first', 'write-first'])('reload owns the read and preserves the local edit in conflict for the %s completion order', async order => {
  vi.useFakeTimers(); const f = fixture(), read = gate(), entered = gate(), write = gate();
  const originalSave = f.port.save.getMockImplementation()!;
  f.port.read.mockImplementationOnce(async () => { const snapshot = structuredClone(f.stored()); entered.release(); await read.promise; return { record: {} as any, document: snapshot }; });
  f.port.save.mockImplementationOnce(async (...args) => { await write.promise; return originalSave(...args); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument()), reloading = s.reload(); await entered.promise;
  s.update({ ...s.document, fps: 60 }); const flushing = s.flush();
  if (order === 'write-first') { write.release(); await vi.advanceTimersByTimeAsync(0); read.release(); }
  else { read.release(); await vi.advanceTimersByTimeAsync(0); write.release(); }
  await Promise.all([reloading, flushing]);
  expect(s.state).toBe('conflict'); expect(s.document.fps).toBe(60); expect(f.stored()).toMatchObject({ fps: 30, rev: 0 });
  expect(f.port.save).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  s.update({ ...s.document, duration: 2000 }); await s.flush();
  expect(s.state).toBe('conflict'); expect(s.document).toMatchObject({ fps: 60, duration: 2000 }); expect(f.port.save).not.toHaveBeenCalled();
  await s.keepMine(); expect(f.stored()).toMatchObject({ fps: 60, duration: 2000, rev: 1 }); expect(s.state).toBe('saved');
});
it.each(['flush', 'timer'])('an edit and %s during reload cannot overwrite a different freshly read base', async request => {
  vi.useFakeTimers(); const f = fixture(), read = gate(), entered = gate();
  const remote = { ...emptyDocument(), fps: 24, duration: 5000, rev: 1 }; f.replace(remote);
  f.port.read.mockImplementationOnce(async () => { const snapshot = structuredClone(f.stored()); entered.release(); await read.promise; return { record: {} as any, document: snapshot }; });
  const s = new AutosaveSession(f.port, 'p', emptyDocument()), reloading = s.reload(); await entered.promise;
  s.update({ ...s.document, fps: 60 }); const local = structuredClone(s.document);
  const flushing = request === 'flush' ? s.flush() : undefined;
  if (request === 'timer') await vi.advanceTimersByTimeAsync(3000);
  read.release(); await Promise.all([reloading, flushing]);
  expect(s.state).toBe('conflict'); expect(s.error).toMatchObject({ code: 'CONFLICT' }); expect(s.document).toEqual(local);
  expect(f.stored()).toEqual(remote); expect(f.port.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000); await s.flush(); expect(f.port.save).not.toHaveBeenCalled();
  await s.reload(); expect(s.document).toEqual(remote); expect(s.state).toBe('saved'); expect(s.error).toBeUndefined();
});
it('plain reload with no edits installs the read and holds a joining flush until that read completes', async () => {
  const f = fixture(), read = gate(), entered = gate(), remote = { ...emptyDocument(), fps: 24, duration: 5000, rev: 1 }; f.replace(remote);
  f.port.read.mockImplementationOnce(async () => { entered.release(); await read.promise; return { record: {} as any, document: structuredClone(remote) }; });
  const s = new AutosaveSession(f.port, 'p', emptyDocument()), reloading = s.reload(); await entered.promise;
  let settled = false; const flushing = s.flush().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); read.release(); await Promise.all([reloading, flushing]);
  expect(s.document).toEqual(remote); expect(s.state).toBe('saved'); expect(f.port.save).not.toHaveBeenCalled();
});
it('Keep mine during a reload read preserves the local choice in conflict instead of dropping it', async () => {
  vi.useFakeTimers(); const f = fixture(), read = gate(), entered = gate(); f.replace({ ...emptyDocument(), fps: 24, rev: 1 });
  f.port.read.mockImplementationOnce(async () => { const snapshot = structuredClone(f.stored()); entered.release(); await read.promise; return { record: {} as any, document: snapshot }; });
  const s = new AutosaveSession(f.port, 'p', emptyDocument()); s.update({ ...s.document, fps: 60 });
  const reloading = s.reload(); await entered.promise; const keeping = s.keepMine(); await vi.advanceTimersByTimeAsync(0);
  read.release(); await Promise.all([reloading, keeping]);
  expect(s.state).toBe('conflict'); expect(s.document.fps).toBe(60); expect(f.port.save).not.toHaveBeenCalled(); expect(f.stored().fps).toBe(24);
  await s.keepMine(); expect(s.document).toEqual(f.stored()); expect(f.stored()).toMatchObject({ fps: 60, rev: 2 });
});
it('a failed reload read settles a joining flush in error and preserves the local document', async () => {
  const f = fixture(), read = gate(), entered = gate();
  f.port.read.mockImplementationOnce(async () => { entered.release(); await read.promise; throw new Error('Read failed.'); });
  const s = new AutosaveSession(f.port, 'p', emptyDocument()), local = structuredClone(s.document), reloading = s.reload(); await entered.promise;
  const flushing = s.flush(); read.release(); const [reloaded, flushed] = await Promise.allSettled([reloading, flushing]);
  expect(reloaded.status).toBe('rejected'); expect(flushed.status).toBe('fulfilled'); expect(s.state).toBe('error');
  expect(s.error?.message).toBe('Read failed.'); expect(s.document).toEqual(local); expect(f.port.save).not.toHaveBeenCalled();
});
it.each([[10, 0], [20, 15], [4, 2], [2, 1]])('rereads before large deletion %i→%i and invokes T17 checkpoint hook with the stored revision', async (before, after) => {
  const f = fixture(before), checkpoint = vi.fn(async (_previous: ProjectDocument) => {}), s = new AutosaveSession(f.port, 'p', f.stored(), { beforeLargeDeletion: checkpoint });
  s.update({ ...s.document, items: s.document.items.slice(0, after) }); await s.flush();
  expect(f.port.read).toHaveBeenCalledOnce(); expect(checkpoint.mock.calls[0][0]).toMatchObject({ rev: 0 }); expect(f.stored().items).toHaveLength(after);
});
it('does not reread or checkpoint for a small deletion', async () => {
  const f = fixture(10), s = new AutosaveSession(f.port, 'p', f.stored()); s.update({ ...s.document, items: s.document.items.slice(0, 9) }); await s.flush(); expect(f.port.read).not.toHaveBeenCalled();
});
it('blocks an incompletely loaded empty document when storage still contains items', async () => {
  const f = fixture(5), s = new AutosaveSession(f.port, 'p', emptyDocument(), { fullyLoaded: false });
  s.update({ ...emptyDocument(), fps: 24 }); await s.flush(); expect(s.state).toBe('blocked'); expect(s.error).toMatchObject({ code: 'SAVE_PAUSED' }); expect(f.port.save).not.toHaveBeenCalled();
  s.update({ ...s.document, fps: 60 }); await s.flush(); expect(f.port.save).not.toHaveBeenCalled(); await s.reload(); expect(s.document.items).toHaveLength(5);
});
it('reread catches another revision before a destructive write or checkpoint', async () => {
  const f = fixture(4), checkpoint = vi.fn(async () => {}), s = new AutosaveSession(f.port, 'p', f.stored(), { beforeLargeDeletion: checkpoint });
  f.replace({ ...f.stored(), rev: 1 }); s.update({ ...s.document, items: [] }); await s.flush(); expect(s.state).toBe('conflict'); expect(checkpoint).not.toHaveBeenCalled(); expect(f.port.save).not.toHaveBeenCalled();
});
it.each(['hidden', 'pagehide'])('flushes from the %s event before the debounce without a direct flush call', async event => {
  vi.useFakeTimers(); const started = Date.now();
  const f = fixture(), s = new AutosaveSession(f.port, 'p', emptyDocument()), doc = new EventTarget(), win = new EventTarget();
  Object.defineProperty(doc, 'visibilityState', { value: 'hidden' }); const unbind = s.bindLifecycle(doc as Document, win as Window);
  s.update({ ...s.document, fps: 24 }); await vi.advanceTimersByTimeAsync(100);
  if (event === 'hidden') doc.dispatchEvent(new Event('visibilitychange')); else win.dispatchEvent(new Event('pagehide'));
  await vi.waitFor(() => { expect(f.port.save).toHaveBeenCalledOnce(); expect(s.state).toBe('saved'); }, { timeout: 100, interval: 1 });
  expect(f.stored().fps).toBe(24); expect(Date.now() - started).toBeLessThan(3000); unbind();
});
it('unbind removes lifecycle listeners while later edits still use the ordinary debounce', async () => {
  vi.useFakeTimers(); const f = fixture(), s = new AutosaveSession(f.port, 'p', emptyDocument()), doc = new EventTarget(), win = new EventTarget();
  Object.defineProperty(doc, 'visibilityState', { value: 'hidden' }); s.bindLifecycle(doc as Document, win as Window)();
  s.update({ ...s.document, fps: 25 }); doc.dispatchEvent(new Event('visibilitychange')); win.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(2999); expect(f.port.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.port.save).toHaveBeenCalledOnce(); expect(f.stored().fps).toBe(25);
});
it('unbinding cancels an already pending debounce', async () => {
  vi.useFakeTimers(); const f = fixture(), s = new AutosaveSession(f.port, 'p', emptyDocument());
  const unbind = s.bindLifecycle(new EventTarget() as Document, new EventTarget() as Window);
  s.update({ ...s.document, fps: 24 }); unbind(); await vi.advanceTimersByTimeAsync(4000);
  expect(f.port.save).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('retains a failed change, retries on next change and supports T03 save preparation refusals', async () => {
  const f = fixture(), s = new AutosaveSession(f.port, 'p', emptyDocument()); f.port.save.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
  s.update({ ...s.document, fps: 24 }); await s.flush(); expect(s.state).toBe('error'); expect(s.error).toMatchObject({ code: 'STORAGE_QUOTA' });
  s.update({ ...s.document, fps: 60 }); await s.flush(); expect(f.stored().fps).toBe(60);
  const blocked = new AutosaveSession(f.port, 'p', s.document, { prepareSave: () => { throw new StoreError('INVALID_MEDIA_TIMING', 'Invalid timing.'); } });
  blocked.update({ ...blocked.document, fps: 24 }); await blocked.flush(); expect(blocked.error).toMatchObject({ code: 'INVALID_MEDIA_TIMING' }); expect(f.stored().fps).toBe(60);
});
