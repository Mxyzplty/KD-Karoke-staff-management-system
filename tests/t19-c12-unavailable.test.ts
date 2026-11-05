// SPDX-License-Identifier: AGPL-3.0-only
// T19 C12: the no-provider state. A capability without its local models is "unavailable": a typed ANALYSIS_UNAVAILABLE
// error for requests, an "unavailable" step for preparation, and nothing faked (no rows, no worker work). Synthetic data only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/src/media/worker-client', () => ({ runWorker: vi.fn(async () => { throw new Error('runWorker must not be called'); }), browserSteps: vi.fn() }));

import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { UNAVAILABLE, unavailableError } from '../apps/web/src/analysis/availability';
import type { Availability, Capability } from '../apps/web/src/analysis/availability';
import { AnalysisService, analysisService } from '../apps/web/src/analysis/service';
import { analysisStep, embeddingsStep, transcriptionStep } from '../apps/web/src/analysis/steps';
import { AnalysisError } from '../apps/web/src/analysis/types';
import type { AnalysisRequest } from '../apps/web/src/analysis/protocol';
import { runWorker } from '../apps/web/src/media/worker-client';
import { mediaError } from '../apps/web/src/media/codes';
import { uploadToLibrary } from '../apps/web/src/media/ingest';
import { prepareAsset } from '../apps/web/src/media/prepare';
import type { AnalysisArgs, Steps } from '../apps/web/src/media/prepare';

const opened: ProjectStore[] = [];
let tick = Date.parse('2026-11-02T00:00:00Z');
function newStore() {
  const files = new Map<string, Blob>();
  const media: MediaStore = {
    write: vi.fn(async (id, blob) => { files.set(id, blob); }), read: vi.fn(async id => { const b = files.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; }),
    remove: vi.fn(async (kind, id) => { if (kind === 'asset') files.delete(id); }), list: vi.fn(async () => [...files.keys()]),
  };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
}
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(runWorker).mockClear(); for (const s of opened.splice(0)) await s.close(); });

const NONE: Availability = { analysis: false, transcription: false, embeddings: false, beats: false };
const ALL: Availability = { analysis: true, transcription: true, embeddings: true, beats: true };
const CAPABILITIES: Capability[] = ['analysis', 'transcription', 'embeddings', 'beats'];

describe('T19 C12 unavailableError', () => {
  const MESSAGES: Record<Capability, string> = {
    analysis: 'Visual analysis needs the local vision model, which is not installed in this browser.',
    transcription: 'Transcription needs the local speech models, which are not installed in this browser.',
    embeddings: 'Search needs the local search model, which is not installed in this browser. Nothing was searched.',
    beats: 'Beat detection needs the local sound model, which is not installed in this browser.',
  };
  it('pins the four messages verbatim', () => { expect(UNAVAILABLE).toEqual(MESSAGES); });
  it.each(CAPABILITIES)('%s: an AnalysisError with code ANALYSIS_UNAVAILABLE and its exact message', capability => {
    const error = unavailableError(capability);
    expect(error).toBeInstanceOf(AnalysisError); expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('ANALYSIS_UNAVAILABLE'); expect(error.message).toBe(MESSAGES[capability]); expect(error.message).toBe(UNAVAILABLE[capability]);
    expect(error.name).toBe('AnalysisError');
  });
});

/** A worker that answers `available` and records everything it is sent. */
class FakeWorker {
  requests: AnalysisRequest[] = [];
  constructor(private availability: Availability) {}
  init() { return Promise.resolve({ value: undefined }); }
  run(request: AnalysisRequest) { this.requests.push(request); return Promise.resolve({ ok: true as const, value: request.task === 'available' ? this.availability : undefined }); }
  close() {}
}
function service(availability: Availability) {
  const workers: FakeWorker[] = [];
  return { svc: new AnalysisService('/models/', (() => { const w = new FakeWorker(availability); workers.push(w); return w; }) as never), workers };
}

describe('T19 C12 AnalysisService.require', () => {
  it.each(CAPABILITIES)('%s: resolves when available, rejects with ANALYSIS_UNAVAILABLE and its message when not', async capability => {
    const yes = service({ ...NONE, [capability]: true }).svc;
    await expect(yes.require(capability)).resolves.toBeUndefined();
    const no = service({ ...ALL, [capability]: false }).svc;
    await expect(no.require(capability)).rejects.toMatchObject({ code: 'ANALYSIS_UNAVAILABLE', message: UNAVAILABLE[capability] });
    await expect(no.require(capability)).rejects.toBeInstanceOf(AnalysisError);
  });
  it('only the asked capability matters, and the probe runs once however often it is asked', async () => {
    const { svc, workers } = service({ analysis: true, transcription: false, embeddings: true, beats: false });
    await svc.require('analysis'); await svc.require('embeddings');
    await expect(svc.require('transcription')).rejects.toMatchObject({ code: 'ANALYSIS_UNAVAILABLE', message: UNAVAILABLE.transcription });
    await expect(svc.require('beats')).rejects.toMatchObject({ message: UNAVAILABLE.beats });
    expect(workers).toHaveLength(1); expect(workers[0].requests.filter(r => r.task === 'available')).toHaveLength(1);
  });
});

describe('T19 C12 search without the search model', () => {
  const asset = (id: string): Asset => ({ id, name: `${id}.mp4`, type: 'video', sizeBytes: 1, mimeType: 'video/mp4', folderId: null, created_at: '2026-11-02T00:00:00.000Z', recorded_at: null, location: null, durationMs: 4000, processing_status: 'ready', processing_steps: { upload: 'complete' } });
  it('rejects ANALYSIS_UNAVAILABLE with the embeddings message, sends the worker nothing but `available`, and leaves the store untouched', async () => {
    const store = newStore();
    await store.putRow('assets', asset('A')); await store.putRow('search_index', { id: 'A', embedder: 'e1', entry: { asset: { id: 'A', filename: 'A.mp4' } } });
    const put = vi.spyOn(store, 'putRow'), del = vi.spyOn(store, 'deleteRow'), swap = vi.spyOn(store, 'swapRow'), assets = await store.rows('assets'), index = await store.rows('search_index');
    const { svc, workers } = service({ ...ALL, embeddings: false });
    await expect(svc.search(store, { query: 'dog' } as never)).rejects.toMatchObject({ code: 'ANALYSIS_UNAVAILABLE', message: UNAVAILABLE.embeddings });
    await expect(svc.search(store, { query: 'dog' } as never)).rejects.toThrow(/Nothing was searched\.$/);
    expect(workers).toHaveLength(1);
    expect(workers[0].requests.map(r => r.task)).toEqual(['available']); // cached on the second call
    expect(put).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled(); expect(swap).not.toHaveBeenCalled();
    expect(await store.rows('assets')).toEqual(assets); expect(await store.rows('search_index')).toEqual(index);
  });
  it('with the search model present the same search does reach the worker (control)', async () => {
    const store = newStore(), { svc, workers } = service(ALL);
    await svc.search(store, { query: 'dog' } as never);
    expect(workers[0].requests.map(r => r.task)).toEqual(['available', 'search']);
  });
});

describe('T19 C12 steps with no local models', () => {
  const video = { container: 'mp4', mimeType: 'video/mp4', durationMs: 6000, video: { displayWidth: 640, displayHeight: 360 }, audio: { sampleRate: 48000, channels: 2 }, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null };
  const args = (type: Asset['type'], info: Record<string, unknown> = video, results: Record<string, unknown> = {}): AnalysisArgs => ({ blob: new Blob(['synthetic']), asset: { id: 'x', name: 'x', type } as Asset, info: info as never, signal: new AbortController().signal, results });
  function spies(availability: Availability = NONE) {
    return { available: vi.spyOn(analysisService, 'available').mockResolvedValue(availability), request: vi.spyOn(analysisService, 'request'), index: vi.spyOn(analysisService, 'index') };
  }
  const untouched = (s: ReturnType<typeof spies>) => { expect(vi.mocked(runWorker)).not.toHaveBeenCalled(); expect(s.request).not.toHaveBeenCalled(); expect(s.index).not.toHaveBeenCalled(); };

  it('analysisStep on a video → { state: "unavailable" }, no frames, no worker request, no puts', async () => {
    const s = spies(), outcome = await analysisStep(args('video'));
    expect(outcome).toEqual({ state: 'unavailable' }); expect(outcome).not.toHaveProperty('puts'); expect(outcome).not.toHaveProperty('value');
    expect(s.available).toHaveBeenCalled(); untouched(s);
  });
  it('analysisStep on an image → unavailable too', async () => {
    const s = spies(); expect(await analysisStep(args('image', { ...video, video: null, audio: null, image: { width: 10, height: 10 } }))).toEqual({ state: 'unavailable' }); untouched(s);
  });
  it('transcriptionStep on a video with audio → { state: "unavailable" }, no pcm op, no request, no puts', async () => {
    const s = spies(), outcome = await transcriptionStep(args('video'));
    expect(outcome).toEqual({ state: 'unavailable' }); expect(outcome).not.toHaveProperty('puts'); untouched(s);
    expect(await transcriptionStep(args('audio', { ...video, video: null }))).toEqual({ state: 'unavailable' }); untouched(s);
  });
  it('embeddingsStep → both embeddings steps unavailable, index never called, no puts — even with analysis results in hand', async () => {
    const s = spies(), outcome = await embeddingsStep(args('video', video, { analysis: { summary: 'x' }, transcription: { segments: [{ text: 'x' }] } }));
    expect(outcome).toEqual({ states: { embeddings_description: 'unavailable', embeddings_transcript: 'unavailable' } }); expect(outcome).not.toHaveProperty('puts'); untouched(s);
  });
  it('skip rules win before availability: audio asset → analysis skipped; image → transcription skipped; no audio track → transcription skipped (available is not asked)', async () => {
    const s = spies();
    expect(await analysisStep(args('audio', { ...video, video: null }))).toEqual({ state: 'skipped' });
    expect(await analysisStep(args('video', { ...video, video: null, image: null }))).toEqual({ state: 'skipped' }); // nothing to look at
    expect(await transcriptionStep(args('image', { ...video, video: null, audio: null, image: { width: 1, height: 1 } }))).toEqual({ state: 'skipped' });
    expect(await transcriptionStep(args('video', { ...video, audio: null }))).toEqual({ state: 'skipped' });
    expect(s.available).not.toHaveBeenCalled(); untouched(s);
  });
  it('with the capability present the step does go past the check (control: analysisStep asks the worker for frames)', async () => {
    spies(ALL); vi.mocked(runWorker).mockRejectedValueOnce(new Error('frames requested'));
    await expect(analysisStep(args('video'))).rejects.toThrow('frames requested'); expect(vi.mocked(runWorker)).toHaveBeenCalledTimes(1);
  });

  describe('through prepareAsset', () => {
    const probe: Steps['probe'] = async () => video as never;
    async function ready(store: ProjectStore) { return (await uploadToLibrary(store, [new File(['synthetic bytes'], 'clip.mp4')], async () => 'rename', { prepare: false })).assets[0]; }
    it('the real steps, with every capability unavailable: asset ready, no error code, four steps "unavailable", no analysis / transcript / index rows', async () => {
      const s = spies(), store = newStore(), a = await ready(store);
      expect(await prepareAsset(store, a.id, { steps: { probe, analysis: analysisStep, transcription: transcriptionStep, embeddings: embeddingsStep } })).toBe('prepared');
      expect(await store.row<Asset>('assets', a.id)).toMatchObject({ processing_status: 'ready', last_error_code: null, last_error_message: null,
        processing_steps: { upload: 'complete', probe: 'complete', analysis: 'unavailable', transcription: 'unavailable', embeddings_description: 'unavailable', embeddings_transcript: 'unavailable' } });
      for (const name of ['analyses', 'transcripts', 'search_index', 'rhythms'] as const) expect(await store.rows(name), name).toEqual([]);
      expect((await store.row<{ phase: string; code?: string }>('preparations', a.id))).toMatchObject({ phase: 'finished' });
      expect((await store.row<{ code?: string }>('preparations', a.id))?.code).toBeUndefined();
      untouched(s);
    });
    it('an audio-only asset: analysis skipped, transcription and the index unavailable', async () => {
      const s = spies(), store = newStore(), a = (await uploadToLibrary(store, [new File(['synthetic bytes'], 'voice.mp3')], async () => 'rename', { prepare: false })).assets[0];
      await prepareAsset(store, a.id, { steps: { probe: async () => ({ ...video, video: null, container: 'mp3' }) as never, analysis: analysisStep, transcription: transcriptionStep, embeddings: embeddingsStep } });
      expect(await store.row<Asset>('assets', a.id)).toMatchObject({ processing_status: 'ready', last_error_code: null,
        processing_steps: { analysis: 'skipped', transcription: 'unavailable', embeddings_description: 'unavailable', embeddings_transcript: 'unavailable' } });
      untouched(s);
    });
    it('the default absent steps behave the same (no provider wired at all)', async () => {
      const store = newStore(), a = await ready(store);
      await prepareAsset(store, a.id, { steps: { probe } });
      expect(await store.row<Asset>('assets', a.id)).toMatchObject({ processing_status: 'ready', last_error_code: null,
        processing_steps: { analysis: 'unavailable', transcription: 'unavailable', embeddings_description: 'unavailable', embeddings_transcript: 'unavailable' } });
    });
  });
});
