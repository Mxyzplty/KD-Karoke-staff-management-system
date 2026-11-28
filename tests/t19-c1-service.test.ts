// SPDX-License-Identifier: AGPL-3.0-only
// T19 C1: model availability probe, frame times, and the AnalysisService (one worker, abort → terminate, index persistence
// and sync before search) against a fake worker. Synthetic data only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { modelAvailability } from '../apps/web/src/analysis/availability';
import type { Availability } from '../apps/web/src/analysis/availability';
import { AnalysisService, assetInput } from '../apps/web/src/analysis/service';
import { frameTimes } from '../apps/web/src/analysis/steps';
import { AnalysisError } from '../apps/web/src/analysis/types';
import type { AnalysisRequest } from '../apps/web/src/analysis/protocol';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('T19 C12/C1 modelAvailability', () => {
  const ids = { vision: 'vis', sound: 'snd', vad: 'vad', whisper: 'wsp', aligner: 'ali', speaker: 'spk', embedding: 'emb' };
  const json = () => new Response(JSON.stringify({ model_type: 'x' }), { headers: { 'content-type': 'application/json' } });
  const none = (status = 404) => new Response('Not found', { status });
  const html = () => new Response('<!doctype html><html><body>app</body></html>', { headers: { 'content-type': 'text/html' } });
  function probe(responses: Record<string, () => Response> = {}) {
    vi.stubGlobal('location', new URL('http://localhost:4173/app'));
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => { const url = String(input); calls.push(url); const id = url.split('/').at(-2)!; return (responses[id] ?? json)(); }) as unknown as typeof fetch;
    return { calls, fetcher };
  }
  const allTrue: Availability = { analysis: true, transcription: true, embeddings: true, beats: true };

  it('every model present → every capability available; each config.json is requested under the root', async () => {
    const { calls, fetcher } = probe();
    expect(await modelAvailability('/models/', ids, fetcher)).toEqual(allTrue);
    expect(calls.sort()).toEqual(Object.values(ids).map(id => `http://localhost:4173/models/${id}/config.json`).sort());
  });
  it('a root without a trailing slash and an absolute same-origin root work too', async () => {
    expect(await modelAvailability('/models', ids, probe().fetcher)).toEqual(allTrue);
    expect(await modelAvailability('http://localhost:4173/models/', ids, probe().fetcher)).toEqual(allTrue);
  });
  it('a 404 for the vision model → only analysis is false', async () => {
    expect(await modelAvailability('/models/', ids, probe({ vis: () => none() }).fetcher)).toEqual({ ...allTrue, analysis: false });
  });
  it('an HTML body (a static host answering a missing file with its index page) counts as missing', async () => {
    expect(await modelAvailability('/models/', ids, probe({ emb: html }).fetcher)).toEqual({ ...allTrue, embeddings: false });
  });
  it('a JSON value that is not an object (null, a number) counts as missing', async () => {
    expect((await modelAvailability('/models/', ids, probe({ emb: () => new Response('null') }).fetcher)).embeddings).toBe(false);
    expect((await modelAvailability('/models/', ids, probe({ emb: () => new Response('42') }).fetcher)).embeddings).toBe(false);
  });
  it('a missing sound classifier makes transcription and beats unavailable; a missing aligner only transcription', async () => {
    expect(await modelAvailability('/models/', ids, probe({ snd: () => none() }).fetcher)).toEqual({ analysis: true, transcription: false, embeddings: true, beats: false });
    expect(await modelAvailability('/models/', ids, probe({ ali: () => none(500) }).fetcher)).toEqual({ ...allTrue, transcription: false });
  });
  it('a failing fetch (network error) counts as missing', async () => {
    probe(); const fetcher = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect(await modelAvailability('/models/', ids, fetcher)).toEqual({ analysis: false, transcription: false, embeddings: false, beats: false });
  });
  it('a root on another origin → all false and nothing is fetched', async () => {
    const { calls, fetcher } = probe();
    expect(await modelAvailability('https://cdn.example.com/models/', ids, fetcher)).toEqual({ analysis: false, transcription: false, embeddings: false, beats: false });
    expect(await modelAvailability('http://localhost:9999/models/', ids, fetcher)).toEqual({ analysis: false, transcription: false, embeddings: false, beats: false });
    expect(calls).toEqual([]); expect(fetcher).not.toHaveBeenCalled();
  });
  it('keys missing from ids are ignored; a capability whose keys are all missing is false', async () => {
    const { calls, fetcher } = probe();
    // Only vision and sound exist: analysis ← vision, transcription ← sound (the other keys are ignored), beats ← sound, embeddings has no key.
    expect(await modelAvailability('/models/', { vision: 'vis', sound: 'snd' }, fetcher)).toEqual({ analysis: true, transcription: true, embeddings: false, beats: true });
    expect(calls.sort()).toEqual(['http://localhost:4173/models/snd/config.json', 'http://localhost:4173/models/vis/config.json']);
    expect(await modelAvailability('/models/', { vision: 'vis' }, probe().fetcher)).toEqual({ analysis: true, transcription: false, embeddings: false, beats: false });
    expect(await modelAvailability('/models/', {}, probe().fetcher)).toEqual({ analysis: false, transcription: false, embeddings: false, beats: false });
  });
  it('a missing present key still blocks: a listed key whose model is absent is not ignored', async () => {
    expect((await modelAvailability('/models/', { vision: 'vis', sound: 'snd', vad: 'vad' }, probe({ vad: () => none() }).fetcher)).transcription).toBe(false);
  });
  it('each model id is fetched once, even when two capabilities need it', async () => {
    const { calls, fetcher } = probe();
    await modelAvailability('/models/', ids, fetcher);
    expect(calls.filter(u => u.includes('/snd/'))).toHaveLength(1); expect(new Set(calls).size).toBe(calls.length);
    const shared = probe(); await modelAvailability('/models/', { vision: 'same', embedding: 'same', sound: 'same' }, shared.fetcher);
    expect(shared.calls).toEqual(['http://localhost:4173/models/same/config.json']);
  });
  it('beats also need BeatThis (T19q B4): its weights file is probed by HEAD, since it has no config.json', async () => {
    const withBeats = { ...ids, beats: 'bt' };
    const { calls, fetcher } = probe({ bt: () => new Response(null, { headers: { 'content-type': 'application/octet-stream' } }) });
    expect(await modelAvailability('/models/', withBeats, fetcher)).toEqual(allTrue);
    expect(calls.filter(u => u.includes('/bt/'))).toEqual(['http://localhost:4173/models/bt/beat_this_fold0.onnx']);
    expect(vi.mocked(fetcher).mock.calls.find(([u]) => String(u).includes('/bt/'))![1]).toEqual({ method: 'HEAD' });
    expect(await modelAvailability('/models/', withBeats, probe({ bt: () => none() }).fetcher)).toEqual({ ...allTrue, beats: false });
    expect(await modelAvailability('/models/', withBeats, probe({ bt: html }).fetcher)).toEqual({ ...allTrue, beats: false });
  });
});

describe('T19 C1 frameTimes', () => {
  it('every 2 s from 0.5 s while the frame lies inside the clip', () => {
    expect(frameTimes(5)).toEqual([0.5, 2.5, 4.5]);
    expect(frameTimes(4.5)).toEqual([0.5, 2.5]);
    expect(frameTimes(2.6)).toEqual([0.5, 2.5]);
    expect(frameTimes(1)).toEqual([0.5]);
  });
  it('a clip of 0.5 s or less gets its midpoint', () => {
    expect(frameTimes(0.4)).toEqual([0.2]);
    expect(frameTimes(0.5)).toEqual([0.25]);
    expect(frameTimes(0.1)[0]).toBeCloseTo(0.05);
  });
  it('a long clip is capped at 90 frames spread evenly, all inside the clip', () => {
    const times = frameTimes(1000);
    expect(times).toHaveLength(90); expect(Math.max(...times)).toBeLessThan(1000); expect(Math.min(...times)).toBeGreaterThan(0);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    for (const g of gaps) expect(g).toBeCloseTo(1000 / 90, 6);
    expect(times[0]).toBeCloseTo(0.5 * 1000 / 90, 6); expect(times.at(-1)).toBeCloseTo(1000 - 0.5 * 1000 / 90, 6);
  });
  it('the cap starts where 2 s spacing would exceed 90 frames', () => {
    expect(frameTimes(0.5 + 90 * 2)).toHaveLength(90); // exactly 90 at 2 s
    expect(frameTimes(0.5 + 90 * 2).at(-1)).toBeCloseTo(0.5 + 89 * 2);
    const over = frameTimes(0.5 + 90 * 2 + 1); expect(over).toHaveLength(90); expect(Math.max(...over)).toBeLessThan(0.5 + 90 * 2 + 1);
  });
});

describe('T19 C1 AnalysisService', () => {
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
        Promise.resolve().then(() => this.handler(request, this)).then(value => { if (value !== HANG) { this.pending.delete(reject); resolve({ ok: true, value }); } }, e => { this.pending.delete(reject); reject(e); });
      });
    }
    close(error: unknown) { this.closed = true; this.closes.push(error); for (const reject of this.pending) reject(error as Error); this.pending.clear(); }
  }
  const HANG = Symbol('hang');
  function service(handler: Handler = () => undefined, root = '/models/') {
    const workers: FakeWorker[] = [];
    const svc = new AnalysisService(root, (() => { const w = new FakeWorker(handler); workers.push(w); return w; }) as never);
    return { svc, workers };
  }
  const tasks = (w: FakeWorker, skip: string[] = ['available', 'init']) => w.requests.map(r => r.task).filter(t => !skip.includes(t));

  it('available() probes once, caches the answer and initialises the worker at the model root', async () => {
    const { svc, workers } = service(r => (r.task === 'available' ? { analysis: true, transcription: false, embeddings: true, beats: false } : undefined));
    const first = await svc.available(), second = await svc.available();
    expect(first).toEqual({ analysis: true, transcription: false, embeddings: true, beats: false }); expect(second).toBe(first);
    expect(workers).toHaveLength(1); expect(workers[0].requests.filter(r => r.task === 'available')).toEqual([{ task: 'available', modelRoot: '/models/' }]);
    expect(workers[0].inits).toEqual([{ modelRoot: '/models/' }]);
  });
  it('a failed probe is not cached: the next available() asks again', async () => {
    let n = 0; const { svc, workers } = service(r => { if (r.task === 'available' && ++n === 1) throw new AnalysisError('ANALYSIS_FAILED', 'nope'); return allFalse; });
    await expect(svc.available()).rejects.toMatchObject({ code: 'ANALYSIS_FAILED' });
    expect(await svc.available()).toEqual(allFalse); expect(workers[0].requests.filter(r => r.task === 'available')).toHaveLength(2);
  });
  const allFalse: Availability = { analysis: false, transcription: false, embeddings: false, beats: false };

  it('aborting a pending request closes the worker with ANALYSIS_CANCELLED; the next request spawns a new one', async () => {
    const { svc, workers } = service(r => (r.task === 'search' && workers[0].requests.filter(x => x.task === 'search').length === 1 ? HANG : 'ok'));
    const controller = new AbortController(), pending = svc.request({ task: 'search', request: {} as never }, [], controller.signal);
    await vi.waitFor(() => expect(workers[0].requests.some(r => r.task === 'search')).toBe(true));
    controller.abort(new Error('user stopped'));
    await expect(pending).rejects.toThrow('user stopped');
    expect(workers[0].closes).toHaveLength(1); expect(workers[0].closes[0]).toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    expect(await svc.request({ task: 'remove', assetId: 'x' })).toBe('ok');
    expect(workers).toHaveLength(2); expect(workers[1].closes).toHaveLength(0); expect(workers[1].inits).toHaveLength(1);
  });
  it('an already aborted signal rejects before any request is sent', async () => {
    const { svc, workers } = service(); const controller = new AbortController(); controller.abort(new Error('early'));
    await expect(svc.request({ task: 'remove', assetId: 'x' }, [], controller.signal)).rejects.toThrow('early');
    expect(workers.flatMap(w => w.requests.filter(r => r.task === 'remove'))).toEqual([]);
  });
  it('ANALYSIS_WORKER_FAILED drops the worker; other errors keep it', async () => {
    let mode: 'crash' | 'fail' | 'ok' = 'crash';
    const { svc, workers } = service(() => { if (mode === 'crash') throw new AnalysisError('ANALYSIS_WORKER_FAILED', 'crashed'); if (mode === 'fail') throw new AnalysisError('ANALYSIS_FAILED', 'plain'); return 1; });
    await expect(svc.request({ task: 'remove', assetId: 'x' })).rejects.toMatchObject({ code: 'ANALYSIS_WORKER_FAILED' });
    expect(workers[0].closes).toHaveLength(1);
    mode = 'fail'; await expect(svc.request({ task: 'remove', assetId: 'x' })).rejects.toMatchObject({ code: 'ANALYSIS_FAILED' });
    expect(workers).toHaveLength(2); expect(workers[1].closes).toHaveLength(0);
    mode = 'ok'; await svc.request({ task: 'remove', assetId: 'x' }); expect(workers).toHaveLength(2);
  });

  describe('search syncs the worker index with the stored rows first', () => {
    const opened: ProjectStore[] = [];
    let tick = Date.parse('2026-11-02T00:00:00Z');
    afterEach(async () => { for (const s of opened.splice(0)) await s.close(); });
    const newStore = () => {
      const media: MediaStore = { write: vi.fn(async () => {}), read: vi.fn(async () => new Blob()), remove: vi.fn(async () => {}) };
      const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
    };
    const asset = (id: string, name: string): Asset => ({ id, name, type: 'video', sizeBytes: 1, mimeType: 'video/mp4', folderId: null, created_at: '2026-11-02T00:00:00.000Z', recorded_at: null, location: null, durationMs: 4000, processing_status: 'ready', processing_steps: { upload: 'complete' } });
    const link = (projectId: string, assetId: string, deleted: boolean) => ({ id: `${projectId}:${assetId}`, projectId, assetId, agent_id: `video_${projectId}`, content_type: 'video', added_at: '2026-11-02T00:00:00.000Z', deleted_at: deleted ? '2026-11-02T01:00:00.000Z' : null });
    const entryFor = (id: string, filename: string) => ({ asset: { id, filename, type: 'video', duration: 4, projectIds: [] }, vectors: [id] });
    const handler: Handler = r => {
      if (r.task === 'available') return { analysis: true, transcription: true, embeddings: true, beats: true };
      if (r.task === 'restore') return r.embedder === 'e1';
      if (r.task === 'entry') return { entry: entryFor(r.assetId, `fresh-${r.assetId}`), embedder: 'e2' };
      if (r.task === 'search') return { results: [] };
      return undefined;
    };
    const search = (svc: AnalysisService, store: ProjectStore) => svc.search(store, { query: 'dog' } as never);

    it('removes indexed ids whose row is gone, restores changed rows with sorted live projectIds and the current name, and is quiet when nothing changed', async () => {
      const store = newStore(), { svc, workers } = service(handler);
      await store.putRow('assets', asset('A', 'a.mp4'));
      await store.putRow('links', link('p2', 'A', false)); await store.putRow('links', link('p1', 'A', false)); await store.putRow('links', link('p3', 'A', true));
      await store.putRow('search_index', { id: 'A', embedder: 'e1', entry: entryFor('A', 'stale-name.mp4') });
      // The worker still holds X, whose search_index row (and asset) are gone.
      await svc.index({ id: 'X', filename: 'x.mp4', type: 'video', duration: 1 }, null, null);
      const w = workers[0], before = w.requests.length;
      await search(svc, store);
      const sent = w.requests.slice(before).filter(r => r.task !== 'available');
      expect(sent.map(r => r.task)).toEqual(['remove', 'restore', 'search']);
      expect(sent[0]).toEqual({ task: 'remove', assetId: 'X' });
      expect(sent[1]).toMatchObject({ task: 'restore', embedder: 'e1', entry: { asset: { id: 'A', filename: 'a.mp4', projectIds: ['p1', 'p2'] }, vectors: ['A'] } });
      // Nothing changed → no restore, no remove.
      const mark = w.requests.length; await search(svc, store);
      expect(w.requests.slice(mark).map(r => r.task)).toEqual(['search']);
      // A rename and a link change make the entry stale again.
      await store.rename('asset', 'A', 'renamed.mp4'); await store.detach('p1', 'A');
      const mark2 = w.requests.length; await search(svc, store);
      const again = w.requests.slice(mark2);
      expect(again.map(r => r.task)).toEqual(['restore', 'search']);
      expect(again[0]).toMatchObject({ task: 'restore', entry: { asset: { filename: 'renamed.mp4', projectIds: ['p2'] } } });
      expect(workers).toHaveLength(1);
    });
    it('an asset deleted from the library is removed from the worker index on the next search', async () => {
      const store = newStore(), { svc, workers } = service(handler);
      await store.putRow('assets', asset('A', 'a.mp4')); await store.putRow('search_index', { id: 'A', embedder: 'e1', entry: entryFor('A', 'a.mp4') });
      await search(svc, store); await store.deleteAssets(['A']);
      const mark = workers[0].requests.length; await search(svc, store);
      expect(workers[0].requests.slice(mark)).toEqual([{ task: 'remove', assetId: 'A' }, expect.objectContaining({ task: 'search' })]);
    });
    it('a restore answered false (another embedder) re-embeds from the analyses and transcripts rows and persists the new row', async () => {
      const store = newStore(), { svc, workers } = service(handler);
      await store.putRow('assets', asset('B', 'b.mp4')); await store.putRow('links', link('p9', 'B', false));
      await store.putRow('search_index', { id: 'B', embedder: 'old-embedder', entry: entryFor('B', 'b.mp4') });
      const analysis = { summary: 'synthetic scene' }, transcript = { segments: [{ text: 'synthetic words' }] };
      await store.putRow('analyses', { id: 'B', analysis, created_at: 'x' }); await store.putRow('transcripts', { id: 'B', status: 'complete', transcript, created_at: 'x' });
      await search(svc, store);
      const sent = workers[0].requests.filter(r => !['available', 'init'].includes(r.task));
      expect(sent.map(r => r.task)).toEqual(['restore', 'index', 'entry', 'search']);
      expect(sent[1]).toEqual({ task: 'index', asset: { id: 'B', filename: 'b.mp4', type: 'video', duration: 4, projectIds: ['p9'] }, analysis, transcript });
      expect(sent[2]).toEqual({ task: 'entry', assetId: 'B' });
      expect(await store.row('search_index', 'B')).toEqual({ id: 'B', embedder: 'e2', entry: entryFor('B', 'fresh-B') });
      // The worker now holds B for this name and these links: the next search does not restore again.
      const mark = workers[0].requests.length; await search(svc, store);
      expect(workers[0].requests.slice(mark).map(r => r.task)).toEqual(['search']);
    });
    it('re-embedding without stored analysis / transcript rows indexes the filename only', async () => {
      const store = newStore(), { svc, workers } = service(handler);
      await store.putRow('assets', asset('C', 'c.mp4')); await store.putRow('search_index', { id: 'C', embedder: 'other', entry: entryFor('C', 'c.mp4') });
      await search(svc, store);
      expect(workers[0].requests.find(r => r.task === 'index')).toEqual({ task: 'index', asset: { id: 'C', filename: 'c.mp4', type: 'video', duration: 4, projectIds: [] }, analysis: null, transcript: null });
    });
    it('a fresh worker after cancellation gets the whole index restored at the next search', async () => {
      const store = newStore(), { svc, workers } = service(handler);
      await store.putRow('assets', asset('A', 'a.mp4')); await store.putRow('search_index', { id: 'A', embedder: 'e1', entry: entryFor('A', 'a.mp4') });
      await search(svc, store);
      const controller = new AbortController(); const sync = svc.request({ task: 'remove', assetId: 'nothing' }, [], controller.signal); controller.abort(); await sync.catch(() => {});
      await search(svc, store);
      expect(workers).toHaveLength(2);
      expect(workers[1].requests.filter(r => r.task === 'restore')).toHaveLength(1);
    });
    it('index() returns the persisted row and refuses a null entry (the worker was replaced)', async () => {
      const { svc } = service(handler);
      expect(await svc.index({ id: 'D', filename: 'd.mp4', type: 'video', duration: 2 }, null, null)).toEqual({ id: 'D', embedder: 'e2', entry: entryFor('D', 'fresh-D') });
      const { svc: replaced } = service(r => (r.task === 'entry' ? { entry: null, embedder: 'e2' } : undefined));
      await expect(replaced.index({ id: 'D', filename: 'd.mp4', type: 'video', duration: 2 }, null, null)).rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    });
    it('assetInput maps the record: filename, type, seconds, optional projectIds', () => {
      expect(assetInput(asset('E', 'e.mp4'))).toEqual({ id: 'E', filename: 'e.mp4', type: 'video', duration: 4 });
      expect(assetInput({ ...asset('E', 'e.mp4'), durationMs: null }, ['p'])).toEqual({ id: 'E', filename: 'e.mp4', type: 'video', duration: 0, projectIds: ['p'] });
    });
  });

  describe('search: cancellation and ordering', () => {
    const ALL = { analysis: true, transcription: true, embeddings: true, beats: true };
    /** A rows-only fake store (no sync work) and a worker whose search answers are released by hand. */
    function rig(rows: (call: number) => Promise<unknown[]> = async () => []) {
      let calls = 0; const store = { rows: vi.fn(async () => rows(++calls)) } as unknown as ProjectStore;
      const searches: { request: AnalysisRequest; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
      const { svc, workers } = service(r => {
        if (r.task === 'available') return ALL;
        if (r.task === 'search') return new Promise((resolve, reject) => searches.push({ request: r, resolve, reject }));
        return undefined;
      });
      return { svc, workers, store, searches, rowCalls: () => calls };
    }
    const response = { results: [], metadata: {} };
    const q = (query: string) => ({ query }) as never;
    const settle = () => new Promise(res => setTimeout(res, 15));

    it('a. aborting the signal rejects that call with signal.reason; the worker is not closed and serves the next request; the aborted search still completes in the worker', async () => {
      const { svc, workers, store, searches } = rig(), controller = new AbortController(), reason = new Error('superseded');
      const first = svc.search(store, q('a'), controller.signal);
      await vi.waitFor(() => expect(searches).toHaveLength(1));
      controller.abort(reason);
      await expect(first).rejects.toBe(reason);
      expect(workers).toHaveLength(1); expect(workers[0].closes).toEqual([]); expect(workers[0].closed).toBe(false);
      searches[0].resolve(response); // the worker finishes it anyway
      const second = svc.search(store, q('b'));
      await vi.waitFor(() => expect(searches).toHaveLength(2));
      expect(searches[1].request).toEqual({ task: 'search', request: { query: 'b' } });
      searches[1].resolve(response);
      expect(await second).toBe(response);
      expect(workers).toHaveLength(1); expect(workers[0].closes).toEqual([]);
    });
    it('a. abort with no reason rejects with the default AbortError reason', async () => {
      const { svc, store, searches } = rig(), controller = new AbortController();
      const first = svc.search(store, q('a'), controller.signal);
      await vi.waitFor(() => expect(searches).toHaveLength(1));
      controller.abort();
      await expect(first).rejects.toBe(controller.signal.reason);
      searches[0].resolve(response);
    });
    it('b. an already-aborted signal rejects before any worker request (no worker is even started)', async () => {
      const { svc, workers, store, rowCalls } = rig(), controller = new AbortController(), reason = new Error('already');
      controller.abort(reason);
      await expect(svc.search(store, q('a'), controller.signal)).rejects.toBe(reason);
      expect(workers).toHaveLength(0); expect(rowCalls()).toBe(0);
    });
    it('c. a second search sends no worker request until the first has finished', async () => {
      const { svc, workers, store, searches } = rig();
      const first = svc.search(store, q('a')), second = svc.search(store, q('b'));
      await vi.waitFor(() => expect(searches).toHaveLength(1));
      await settle();
      expect(searches).toHaveLength(1); expect(workers[0].requests.filter(r => r.task === 'search')).toHaveLength(1);
      searches[0].resolve({ ...response, n: 1 });
      expect(await first).toEqual({ ...response, n: 1 });
      await vi.waitFor(() => expect(searches).toHaveLength(2));
      expect(searches[1].request).toEqual({ task: 'search', request: { query: 'b' } });
      searches[1].resolve({ ...response, n: 2 });
      expect(await second).toEqual({ ...response, n: 2 });
    });
    it('c. including the sync of the first: the second does not read the store until the first sync is done', async () => {
      let release!: () => void; const hold = new Promise<void>(r => { release = r; });
      const { svc, store, searches, rowCalls } = rig(call => (call === 1 ? hold.then(() => []) : Promise.resolve([])));
      const first = svc.search(store, q('a')), second = svc.search(store, q('b'));
      await vi.waitFor(() => expect(rowCalls()).toBeGreaterThan(0));
      await settle();
      expect(rowCalls()).toBe(3); // one sync (rows, assets, links) so far; the second is queued
      expect(searches).toHaveLength(0);
      release();
      await vi.waitFor(() => expect(searches).toHaveLength(1));
      searches[0].resolve(response); await first;
      await vi.waitFor(() => expect(searches).toHaveLength(2));
      expect(rowCalls()).toBe(6);
      searches[1].resolve(response); await second;
    });
    it('c. a failed first search (worker error) does not block the second', async () => {
      const { svc, store, searches } = rig();
      const first = svc.search(store, q('a')), second = svc.search(store, q('b'));
      const firstError = first.catch(e => e);
      await vi.waitFor(() => expect(searches).toHaveLength(1));
      searches[0].reject(new AnalysisError('SEARCH_FAILED', 'boom'));
      expect(await firstError).toMatchObject({ code: 'SEARCH_FAILED' });
      await vi.waitFor(() => expect(searches).toHaveLength(2));
      searches[1].resolve(response);
      expect(await second).toBe(response);
    });
    it('c. a first search that fails in its sync (store error) does not block the second', async () => {
      const { svc, store, searches } = rig(call => (call === 1 ? Promise.reject(new Error('db closed')) : Promise.resolve([])));
      const first = svc.search(store, q('a')), second = svc.search(store, q('b'));
      const firstError = first.catch(e => e);
      expect(await firstError).toMatchObject({ message: 'db closed' });
      await vi.waitFor(() => expect(searches).toHaveLength(1));
      searches[0].resolve(response);
      expect(await second).toBe(response);
    });
    it('c. ANALYSIS_UNAVAILABLE rejects each queued search and neither reaches the worker search', async () => {
      const { svc, workers } = service(r => (r.task === 'available' ? { ...ALL, embeddings: false } : undefined));
      const store = { rows: async () => [] } as unknown as ProjectStore;
      const results = await Promise.allSettled([svc.search(store, q('a')), svc.search(store, q('b'))]);
      expect(results.map(r => r.status === 'rejected' && (r.reason as AnalysisError).code)).toEqual(['ANALYSIS_UNAVAILABLE', 'ANALYSIS_UNAVAILABLE']);
      expect(workers[0].requests.filter(r => r.task === 'search')).toHaveLength(0);
    });
    it('c. a search aborted while queued rejects at once with its reason; the search before it is unaffected', async () => {
      const { svc, store, searches } = rig(), controller = new AbortController(), reason = new Error('queued-abort');
      const first = svc.search(store, q('a')), second = svc.search(store, q('b'), controller.signal);
      await vi.waitFor(() => expect(searches).toHaveLength(1));
      controller.abort(reason);
      await expect(second).rejects.toBe(reason);
      searches[0].resolve(response);
      expect(await first).toBe(response);
    });
    it('d. without a signal the response is returned unchanged; a signal that is never aborted behaves the same', async () => {
      const { svc, store, searches } = rig(), controller = new AbortController();
      const plain = svc.search(store, q('a')); await vi.waitFor(() => expect(searches).toHaveLength(1)); searches[0].resolve(response);
      expect(await plain).toBe(response);
      const signalled = svc.search(store, q('b'), controller.signal); await vi.waitFor(() => expect(searches).toHaveLength(2)); searches[1].resolve(response);
      expect(await signalled).toBe(response);
    });
  });
});
