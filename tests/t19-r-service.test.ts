// SPDX-License-Identifier: AGPL-3.0-only
// T19 review fixes R1d / R5 / R6a on AnalysisService.search against a fake worker (the rig of t19-c1-service.test.ts):
//   R1d  a request inside the search run rejects ANALYSIS_CANCELLED while the search's own signal is not aborted
//        (another request's abort dropped the shared worker) → the run is re-run once; twice → the search rejects;
//        the search's own abort → no re-run, rejects with signal.reason.
//   R5   the worker is replaced between two restores of one sync → both rows are restored on the new worker (bounded to 3 passes).
//   R6a  the abort listener the search adds to its signal is removed once the search settles.
// Synthetic data only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisService } from '../apps/web/src/analysis/service';
import { AnalysisError } from '../apps/web/src/analysis/types';
import type { AnalysisRequest } from '../apps/web/src/analysis/protocol';
import type { ProjectStore } from '../apps/web/src/store/database';

afterEach(() => { vi.restoreAllMocks(); });

type Handler = (request: AnalysisRequest, worker: FakeWorker) => unknown;
class FakeWorker {
  requests: AnalysisRequest[] = []; inits: unknown[] = []; closes: unknown[] = []; closed = false;
  private pending = new Set<(e: Error) => void>();
  constructor(private handler: Handler) {}
  init(options: unknown) { this.inits.push(options); return Promise.resolve({ value: undefined }); }
  run(request: AnalysisRequest) {
    this.requests.push(request);
    if (this.closed) return Promise.reject(new AnalysisError('ANALYSIS_CANCELLED', 'closed'));
    return new Promise<{ ok: true; value: unknown }>((resolve, reject) => {
      this.pending.add(reject);
      Promise.resolve().then(() => this.handler(request, this)).then(value => { this.pending.delete(reject); resolve({ ok: true, value }); }, e => { this.pending.delete(reject); reject(e); });
    });
  }
  close(error: unknown) { this.closed = true; this.closes.push(error); for (const reject of this.pending) reject(error as Error); this.pending.clear(); }
}
function service(handler: Handler) {
  const workers: FakeWorker[] = [];
  const svc = new AnalysisService('/models/', (() => { const w = new FakeWorker(handler); workers.push(w); return w; }) as never);
  return { svc, workers };
}
const tasks = (w: FakeWorker) => w.requests.map(r => r.task).filter(t => t !== 'available' && t !== 'init');
const all = (workers: FakeWorker[]) => workers.flatMap(w => w.requests);
const ALL = { analysis: true, transcription: true, embeddings: true, beats: true };
const cancelled = () => new AnalysisError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
const q = { query: 'dog' } as never;
const settle = () => new Promise(res => setTimeout(res, 15));

/** A rows-only store: sync reads search_index, assets and links; `passes()` counts the sync passes (search_index reads). */
const asset = (id: string) => ({ id, name: `${id}.mp4`, type: 'video', durationMs: 4000, processing_status: 'ready' });
const entryFor = (id: string) => ({ asset: { id, filename: `${id}.mp4`, type: 'video', duration: 4, projectIds: [] }, vectors: [id] });
function fakeStore(ids: string[]) {
  const data: Record<string, unknown[]> = { search_index: ids.map(id => ({ id, embedder: 'e1', entry: entryFor(id) })), assets: ids.map(asset), links: [] };
  const rows = vi.fn(async (name: string) => data[name] ?? []);
  return { store: { rows, row: vi.fn(async () => undefined), putRow: vi.fn(async () => {}) } as unknown as ProjectStore, passes: () => rows.mock.calls.filter(([n]) => n === 'search_index').length };
}
const base: Handler = r => (r.task === 'available' ? ALL : r.task === 'restore' ? true : r.task === 'search' ? { results: [] } : undefined);
/** Drop the current worker by aborting a concurrent request's signal (the way a cancelled preparation does). */
const dropWorker = (svc: AnalysisService) => { const c = new AbortController(); svc.request({ task: 'remove', assetId: 'nothing' }, [], c.signal).catch(() => {}); c.abort(); };

describe('T19 R1d search is re-run once when a request inside it is cancelled by someone else', () => {
  it('a "search" request rejecting ANALYSIS_CANCELLED once (own signal not aborted): the run is re-run (sync again, then search) and resolves', async () => {
    let searches = 0;
    const { svc, workers } = service((r, w) => { if (r.task === 'search' && ++searches === 1) throw cancelled(); return base(r, w); });
    const { store, passes } = fakeStore(['A']), controller = new AbortController();
    expect(await svc.search(store, q, controller.signal)).toEqual({ results: [] });
    expect(all(workers).filter(r => r.task === 'search')).toHaveLength(2);
    expect(passes()).toBe(2); // the sync ran again
  });
  it('a "restore" during sync rejecting ANALYSIS_CANCELLED once: the run is re-run and resolves, the row restored again', async () => {
    let restores = 0;
    const { svc, workers } = service((r, w) => { if (r.task === 'restore' && ++restores === 1) throw cancelled(); return base(r, w); });
    const { store, passes } = fakeStore(['A']);
    expect(await svc.search(store, q, new AbortController().signal)).toEqual({ results: [] });
    expect(all(workers).filter(r => r.task === 'restore')).toHaveLength(2);
    expect(all(workers).filter(r => r.task === 'search')).toHaveLength(1);
    expect(passes()).toBe(2);
  });
  it('the same without a signal on the search', async () => {
    let searches = 0;
    const { svc, workers } = service((r, w) => { if (r.task === 'search' && ++searches === 1) throw cancelled(); return base(r, w); });
    expect(await svc.search(fakeStore(['A']).store, q)).toEqual({ results: [] });
    expect(all(workers).filter(r => r.task === 'search')).toHaveLength(2);
  });
  it('it rejects twice → the search rejects ANALYSIS_CANCELLED, after exactly two runs', async () => {
    const { svc, workers } = service((r, w) => { if (r.task === 'search') throw cancelled(); return base(r, w); });
    const { store, passes } = fakeStore(['A']);
    await expect(svc.search(store, q, new AbortController().signal)).rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    expect(all(workers).filter(r => r.task === 'search')).toHaveLength(2);
    expect(passes()).toBe(2);
  });
  it('guard: the search\'s own signal aborted → no re-run, and it rejects with signal.reason', async () => {
    const searches: { reject: (e: unknown) => void }[] = [];
    const { svc, workers } = service((r, w) => (r.task === 'search' ? new Promise((_, reject) => searches.push({ reject })) : base(r, w)));
    const controller = new AbortController(), reason = new Error('superseded');
    const first = svc.search(fakeStore(['A']).store, q, controller.signal);
    const outcome = first.then(() => 'resolved', e => e);
    await vi.waitFor(() => expect(searches).toHaveLength(1));
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    searches[0].reject(cancelled()); // the worker's answer arrives late as a cancellation
    await settle();
    expect(all(workers).filter(r => r.task === 'search')).toHaveLength(1);
  });
  it('realistic: a search in flight, another request\'s abort drops the worker → the search still resolves on the new worker (sync, then search)', async () => {
    const { svc, workers } = service((r, w) => (r.task === 'search' && w === workers[0] ? new Promise(() => {}) : base(r, w)));
    const outcome = svc.search(fakeStore(['A']).store, q).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(workers[0]?.requests.some(r => r.task === 'search')).toBe(true));
    dropWorker(svc);
    expect(await outcome).toEqual({ value: { results: [] } });
    expect(workers).toHaveLength(2);
    expect(workers[0].closes).toHaveLength(1);
    expect(tasks(workers[1])).toEqual(['restore', 'search']);
  });
});

describe('T19 R5 sync: a worker replaced between two restores', () => {
  const restored = (w: FakeWorker) => w.requests.filter(r => r.task === 'restore').map(r => (r as { entry: { asset: { id: string } } }).entry.asset.id);
  /** Drops the current worker just before the `n`th restore is sent, i.e. right after the previous restore resolved. */
  function replaceBeforeRestore(svc: AnalysisService, when: (n: number) => boolean) {
    const original = svc.request.bind(svc); let n = 0;
    vi.spyOn(svc, 'request').mockImplementation(((request: AnalysisRequest, ...rest: unknown[]) => {
      if (request.task === 'restore' && when(++n)) dropWorker(svc);
      return (original as (...a: unknown[]) => Promise<unknown>)(request, ...rest);
    }) as never);
  }
  it('both rows are restored on the new worker before the search is sent', async () => {
    const { svc, workers } = service(base);
    replaceBeforeRestore(svc, n => n === 2); // after the first restore (A) resolved on worker 0
    const { store } = fakeStore(['A', 'B']);
    expect(await svc.search(store, q)).toEqual({ results: [] });
    expect(workers).toHaveLength(2);
    const last = workers[1];
    expect(restored(workers[0])).toEqual(['A']);
    expect(restored(last).sort()).toEqual(['A', 'B']); // before the fix: ['B'] only, so A is missing from the index that is searched
    const sent = last.requests.map(r => r.task);
    expect(sent.lastIndexOf('restore')).toBeLessThan(sent.indexOf('search'));
  });
  it('the re-sync is bounded: a worker replaced on every restore stops after 3 passes and the search still goes out', async () => {
    const { svc, workers } = service(base);
    replaceBeforeRestore(svc, () => true);
    const { store, passes } = fakeStore(['A', 'B']);
    expect(await svc.search(store, q)).toEqual({ results: [] });
    expect(passes()).toBe(3);
    expect(all(workers).filter(r => r.task === 'search')).toHaveLength(1);
    expect(all(workers).filter(r => r.task === 'restore').length).toBeLessThanOrEqual(6);
  });
  it('guard: nothing replaced → one pass, one restore per row, all on the one worker', async () => {
    const { svc, workers } = service(base);
    const { store, passes } = fakeStore(['A', 'B']);
    await svc.search(store, q);
    expect(workers).toHaveLength(1); expect(restored(workers[0])).toEqual(['A', 'B']); expect(passes()).toBe(1);
  });
});

describe('T19 R6a search removes the abort listener it added to its signal', () => {
  function spied() {
    const controller = new AbortController(), { signal } = controller;
    const added: unknown[] = [], removed: unknown[] = [];
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    vi.spyOn(signal, 'addEventListener').mockImplementation(((type: string, listener: unknown, options?: unknown) => { if (type === 'abort') added.push(listener); return add(type, listener as never, options as never); }) as never);
    vi.spyOn(signal, 'removeEventListener').mockImplementation(((type: string, listener: unknown, options?: unknown) => { if (type === 'abort') removed.push(listener); return remove(type, listener as never, options as never); }) as never);
    return { signal, added, removed };
  }
  it('after the search resolves, every abort listener it added is removed', async () => {
    const { svc } = service(base), { signal, added, removed } = spied();
    await svc.search(fakeStore(['A']).store, q, signal);
    expect(added.length).toBeGreaterThan(0);
    for (const listener of added) expect(removed).toContain(listener);
  });
  it('after the search rejects (a plain failure), every abort listener it added is removed', async () => {
    const { svc } = service((r, w) => { if (r.task === 'search') throw new AnalysisError('ANALYSIS_FAILED', 'plain'); return base(r, w); });
    const { signal, added, removed } = spied();
    await expect(svc.search(fakeStore(['A']).store, q, signal)).rejects.toMatchObject({ code: 'ANALYSIS_FAILED' });
    expect(added.length).toBeGreaterThan(0);
    for (const listener of added) expect(removed).toContain(listener);
  });
  it('control: aborting after the search settled does nothing (no late rejection, worker untouched)', async () => {
    const { svc, workers } = service(base), controller = new AbortController();
    await svc.search(fakeStore(['A']).store, q, controller.signal);
    controller.abort(new Error('late'));
    await settle();
    expect(workers[0].closes).toEqual([]);
  });
});
