// SPDX-License-Identifier: AGPL-3.0-only
// T19 C2: a transcription that fails leaves the asset ready and a transcript row that says why ({status: 'failed', error}).
// transcriptionStep attaches the row as `puts` on the error it rethrows; prepareAsset publishes it with the failed step.
// Synthetic data only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/src/media/worker-client', () => ({ runWorker: vi.fn(async () => new Float32Array(8)), browserSteps: vi.fn() }));

import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { syncAndSwap } from '../apps/web/src/analysis/multicam';
import type { SwapContext } from '../apps/web/src/analysis/multicam';
import { resolveTranscriptRanges } from '../apps/web/src/analysis/ranges';
import { analysisService } from '../apps/web/src/analysis/service';
import { transcriptionStep } from '../apps/web/src/analysis/steps';
import { AnalysisError } from '../apps/web/src/analysis/types';
import { runWorker } from '../apps/web/src/media/worker-client';
import { mediaError } from '../apps/web/src/media/codes';
import { uploadToLibrary } from '../apps/web/src/media/ingest';
import { prepareAsset } from '../apps/web/src/media/prepare';
import type { AnalysisArgs, Steps } from '../apps/web/src/media/prepare';
import { build, mkItem, mkTrack } from './t03-fixtures';

type Rec = Record<string, any>;
const opened: ProjectStore[] = [];
let tick = Date.parse('2026-11-02T00:00:00Z');
function setup() {
  const files = new Map<string, Blob>();
  const media: MediaStore = {
    write: vi.fn(async (id, blob) => { files.set(id, blob); }), read: vi.fn(async id => { const b = files.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; }),
    remove: vi.fn(async (kind, id) => { if (kind === 'asset') files.delete(id); }), list: vi.fn(async () => [...files.keys()]),
  };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
}
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(runWorker).mockClear(); for (const s of opened.splice(0)) await s.close(); });
const fake = (extra: Partial<Steps> = {}): Partial<Steps> => ({ probe: async () => ({ container: 'mp4', mimeType: 'video/mp4', durationMs: 3000, video: null, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null }), ...extra });
async function ready(store: ProjectStore, name = 'clip.mp4') {
  return (await uploadToLibrary(store, [new File(['synthetic bytes'], name)], async () => 'rename', { prepare: false })).assets[0];
}
const stored = (store: ProjectStore, id: string) => store.row<Asset>('assets', id);
const transcriptOf = (store: ProjectStore, id: string) => store.row<Rec>('transcripts', id);
const MESSAGE = 'The local ASR returned an invalid word timestamp.';
/** An error as transcriptionStep throws it: the cause plus the failed row as `puts`. */
const failedWith = (id: string, message = MESSAGE) => Object.assign(new Error(message), { puts: [{ store: 'transcripts', value: { id, status: 'failed', transcript: null, error: message, created_at: '2026-11-02T00:00:00.000Z' } }] });

describe('T19 C2 prepareAsset publishes the failed transcript row', () => {
  it('1. transcription throws with puts → the row is stored as given; step failed, asset ready, TRANSCRIPTION_FAILED, phase finished; embeddings still run with transcription null', async () => {
    const store = setup(), a = await ready(store), seen: Rec[] = [];
    const error = failedWith(a.id);
    expect(await prepareAsset(store, a.id, { steps: fake({ transcription: async () => { throw error; }, embeddings: async ({ results }: AnalysisArgs) => { seen.push({ ...results }); } }) })).toBe('prepared');
    expect(await transcriptOf(store, a.id)).toEqual({ id: a.id, status: 'failed', transcript: null, error: MESSAGE, created_at: '2026-11-02T00:00:00.000Z' });
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'TRANSCRIPTION_FAILED', processing_steps: { transcription: 'failed', analysis: 'unavailable', embeddings_description: 'complete', embeddings_transcript: 'complete' } });
    expect(await store.row<Rec>('preparations', a.id)).toMatchObject({ phase: 'finished', code: 'TRANSCRIPTION_FAILED' });
    expect(seen).toHaveLength(1); expect(seen[0].transcription).toBeNull();
  });
  it('1b. several rows in puts are all stored with the failed step (puts of other stores too)', async () => {
    const store = setup(), a = await ready(store);
    const error = failedWith(a.id); error.puts.push({ store: 'analyses', value: { id: a.id, analysis: { marker: 'kept' }, created_at: 'x' } } as never);
    await prepareAsset(store, a.id, { steps: fake({ transcription: async () => { throw error; } }) });
    expect(await transcriptOf(store, a.id)).toMatchObject({ status: 'failed' });
    expect(await store.row('analyses', a.id)).toEqual({ id: a.id, analysis: { marker: 'kept' }, created_at: 'x' });
  });
  it('1c. an earlier complete transcript row is replaced by the failed one', async () => {
    const store = setup(), a = await ready(store);
    await store.putRow('transcripts', { id: a.id, status: 'complete', transcript: { segments: [] }, created_at: 'old' });
    await prepareAsset(store, a.id, { steps: fake({ transcription: async () => { throw failedWith(a.id); } }), manual: true });
    expect(await transcriptOf(store, a.id)).toMatchObject({ status: 'failed', transcript: null, error: MESSAGE });
  });
  it('2. a step throwing WITHOUT puts (or with an empty puts) → no transcripts row, step failed, as before', async () => {
    const store = setup(), a = await ready(store), b = await ready(store, 'other.mp4');
    await prepareAsset(store, a.id, { steps: fake({ transcription: async () => { throw new Error('no rows'); } }) });
    expect(await transcriptOf(store, a.id)).toBeUndefined();
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'TRANSCRIPTION_FAILED', processing_steps: { transcription: 'failed' } });
    await prepareAsset(store, b.id, { steps: fake({ transcription: async () => { throw Object.assign(new Error('empty'), { puts: [] }); } }) });
    expect(await transcriptOf(store, b.id)).toBeUndefined();
    expect(await stored(store, b.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'TRANSCRIPTION_FAILED', processing_steps: { transcription: 'failed' } });
  });
  it('2b. puts on an analysis step failure are published too (the catch is shared); a failure code of the first failing step wins', async () => {
    const store = setup(), a = await ready(store);
    const error = Object.assign(new Error('x'), { puts: [{ store: 'analyses', value: { id: a.id, analysis: { marker: 'p' }, created_at: 'x' } }] });
    await prepareAsset(store, a.id, { steps: fake({ analysis: async () => { throw error; }, transcription: async () => { throw failedWith(a.id); } }) });
    expect(await store.row('analyses', a.id)).toMatchObject({ analysis: { marker: 'p' } });
    expect(await transcriptOf(store, a.id)).toMatchObject({ status: 'failed' });
    expect(await stored(store, a.id)).toMatchObject({ last_error_code: 'GEMINI_FAILED', processing_steps: { analysis: 'failed', transcription: 'failed' } });
  });
  it('3. cancelled during the transcription step (even if the error carries puts) → no failed row; the attempt is cancelled, not failed', async () => {
    const store = setup(), a = await ready(store), controller = new AbortController();
    let begin!: () => void; const running = new Promise<void>(r => { begin = r; });
    let fail!: (e: unknown) => void; const hold = new Promise<never>((_, reject) => { fail = reject; });
    const done = prepareAsset(store, a.id, { signal: controller.signal, steps: fake({ transcription: () => { begin(); return hold; } }) });
    await running; controller.abort(); fail(failedWith(a.id));
    expect(await done).not.toBe('prepared');
    expect(await transcriptOf(store, a.id)).toBeUndefined();
    expect(await store.row<Rec>('preparations', a.id)).toMatchObject({ phase: 'cancelled', code: 'CLIENT_PREPARATION_CANCELLED' });
    expect(await stored(store, a.id)).toMatchObject({ last_error_code: 'CLIENT_PREPARATION_CANCELLED' });
    expect((await stored(store, a.id))?.processing_steps?.transcription).not.toBe('complete');
  });
  it('3b. the step itself aborts the attempt and then rejects with puts: same, nothing written', async () => {
    const store = setup(), a = await ready(store), controller = new AbortController();
    const done = prepareAsset(store, a.id, { signal: controller.signal, steps: fake({ transcription: async ({ signal }: AnalysisArgs) => { await Promise.resolve(); controller.abort(); await Promise.resolve(); throw Object.assign(signal.reason ?? new Error('aborted'), { puts: failedWith(a.id).puts }); } }) });
    expect(await done).not.toBe('prepared');
    expect(await transcriptOf(store, a.id)).toBeUndefined();
    expect(await store.row<Rec>('preparations', a.id)).toMatchObject({ phase: 'cancelled' });
  });
  it('4. a retry after a failed row with a step that succeeds overwrites the row with status complete and clears the code', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ transcription: async () => { throw failedWith(a.id); } }) });
    expect((await transcriptOf(store, a.id))?.status).toBe('failed');
    const complete = { id: a.id, status: 'complete', transcript: { language: 'en', segments: [] }, created_at: '2026-11-02T01:00:00.000Z' };
    await prepareAsset(store, a.id, { steps: fake({ transcription: async () => ({ state: 'complete', puts: [{ store: 'transcripts', value: complete }] }) }), manual: true });
    expect(await transcriptOf(store, a.id)).toEqual(complete);
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: null, processing_steps: { transcription: 'complete' } });
  });
});

describe('T19 C2 transcriptionStep', () => {
  const info = { container: 'mp4', mimeType: 'video/mp4', durationMs: 6000, video: { displayWidth: 640, displayHeight: 360 }, audio: { sampleRate: 48000, channels: 2 }, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null };
  const args = (type: Asset['type'] = 'audio', i: Rec = { ...info, video: null }): AnalysisArgs => ({ blob: new Blob(['synthetic']), asset: { id: 'x1', name: 'x', type } as Asset, info: i as never, signal: new AbortController().signal, results: {} });
  const available = (transcription = true) => vi.spyOn(analysisService, 'available').mockResolvedValue({ analysis: false, transcription, embeddings: false, beats: false });
  const thrown = async (work: Promise<unknown>) => { try { await work; } catch (e) { return e as Rec; } throw new Error('did not throw'); };

  it('5a. the request rejects with an AnalysisError → the same object is thrown, code kept; puts[0].value is the failed row with its message', async () => {
    available(); const rejection = new AnalysisError('TRANSCRIPTION_FAILED', MESSAGE);
    vi.spyOn(analysisService, 'request').mockRejectedValue(rejection);
    const e = await thrown(transcriptionStep(args()));
    expect(e).toBe(rejection); expect(e.code).toBe('TRANSCRIPTION_FAILED');
    expect(e.puts).toHaveLength(1);
    expect(e.puts[0]).toMatchObject({ store: 'transcripts', value: { id: 'x1', status: 'failed', transcript: null, error: MESSAGE } });
    expect(typeof e.puts[0].value.created_at).toBe('string'); expect(Number.isNaN(Date.parse(e.puts[0].value.created_at))).toBe(false);
  });
  it('5b. a pcm decode failure is handled the same way', async () => {
    available(); vi.mocked(runWorker).mockRejectedValueOnce(new Error('pcm decode failed'));
    const request = vi.spyOn(analysisService, 'request');
    const e = await thrown(transcriptionStep(args()));
    expect(e.message).toBe('pcm decode failed'); expect(e.puts[0].value).toMatchObject({ status: 'failed', transcript: null, error: 'pcm decode failed' });
    expect(request).not.toHaveBeenCalled();
  });
  it('5c. a non-Error rejection (a string) → an Error wrapping that text, with the row', async () => {
    available(); vi.spyOn(analysisService, 'request').mockRejectedValue('plain text failure');
    const e = await thrown(transcriptionStep(args()));
    expect(e).toBeInstanceOf(Error); expect(e.message).toBe('plain text failure'); expect(e.puts[0].value).toMatchObject({ status: 'failed', error: 'plain text failure' });
  });
  it('5d. an Error without a message → the row says "Transcription failed."', async () => {
    available(); vi.spyOn(analysisService, 'request').mockRejectedValue(new Error(''));
    const e = await thrown(transcriptionStep(args()));
    expect(e.puts[0].value.error).toBe('Transcription failed.');
  });
  it('5e. unavailable → { state: "unavailable" }, no throw, no request; image or no audio track → skipped', async () => {
    const request = vi.spyOn(analysisService, 'request'); available(false);
    expect(await transcriptionStep(args())).toEqual({ state: 'unavailable' });
    expect(vi.mocked(runWorker)).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    available();
    expect(await transcriptionStep(args('image', { ...info, video: null, audio: null, image: { width: 10, height: 10 } }))).toEqual({ state: 'skipped' });
    expect(await transcriptionStep(args('video', { ...info, audio: null }))).toEqual({ state: 'skipped' });
    expect(request).not.toHaveBeenCalled();
  });
  it('5f. control: a successful request still returns the complete row as puts and does not throw', async () => {
    available(); vi.spyOn(analysisService, 'request').mockResolvedValue({ status: 'complete', transcript: { language: 'en', segments: [] } });
    const out = await transcriptionStep(args()) as Rec;
    expect(out.state).toBe('complete');
    expect(out.puts[0]).toMatchObject({ store: 'transcripts', value: { id: 'x1', status: 'complete', transcript: { language: 'en', segments: [] } } });
  });
});

describe('T19 C2 a failed row read by the tools', () => {
  /** A real store holding a failed row (written by prepareAsset) for asset `bad` and a good transcript for asset `good`. */
  async function stores() {
    const store = setup(), bad = await ready(store, 'bad.mp4'), good = await ready(store, 'good.mp4');
    await prepareAsset(store, bad.id, { steps: fake({ transcription: async () => { throw failedWith(bad.id); } }) });
    const words = [{ word: 'one', start: 1, end: 1.4 }, { word: 'two', start: 2, end: 2.4 }, { word: 'three', start: 3, end: 3.4 }];
    await prepareAsset(store, good.id, { steps: fake({ transcription: async () => ({ state: 'complete', puts: [{ store: 'transcripts', value: { id: good.id, status: 'complete', transcript: { words }, created_at: 'x' } }] }) }) });
    return { store, bad: (await stored(store, bad.id))!, good: (await stored(store, good.id))! };
  }
  function swapCtx(store: ProjectStore, source: Asset, target: Asset) {
    const doc = build({ tracks: [mkTrack('V1', 'video'), mkTrack('V2', 'video')], items: [mkItem('base', 'V1', 0, 8000, { trim: { from: 0, to: 8000 }, sourceDuration: 8000, metadata: { assetId: target.id } })] });
    const byId = new Map<string, Asset>([['video_2', source], [source.id, source], [target.id, target]]);
    const syncOffset = vi.fn(async () => ({ offset: 0, confidence: 0.9, matches: [] }));
    const place = vi.fn(() => ({ success: true }));
    return { ctx: { doc: () => doc, asset: (id: string) => byId.get(id), store, service: { syncOffset }, place } as unknown as SwapContext, syncOffset, place };
  }
  const INPUT = { sourceAssetId: 'video_2', targetItemId: 'base', trackId: 'V2', from: 0, to: 4 };

  it('6a. syncAndSwap: the failed row on the source → TRANSCRIPT_UNAVAILABLE "Source asset transcript too short for sync"; nothing synced or placed', async () => {
    const { store, bad, good } = await stores(); expect(bad.processing_steps?.transcription).toBe('failed');
    const { ctx, syncOffset, place } = swapCtx(store, bad, good);
    expect(await syncAndSwap(ctx, INPUT)).toEqual({ success: false, code: 'TRANSCRIPT_UNAVAILABLE', error: 'Source asset transcript too short for sync' });
    expect(syncOffset).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled();
  });
  it('6b. syncAndSwap: the failed row on the target (the source is fine) → the Target message', async () => {
    const { store, bad, good } = await stores();
    const { ctx, syncOffset, place } = swapCtx(store, good, bad);
    expect(await syncAndSwap(ctx, INPUT)).toEqual({ success: false, code: 'TRANSCRIPT_UNAVAILABLE', error: 'Target asset transcript too short for sync' });
    expect(syncOffset).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled();
  });
  it('6c. addMedia transcriptRange (resolveTranscriptRanges): the failed row → TRANSCRIPT_UNAVAILABLE; the good asset resolves', async () => {
    const { store, bad, good } = await stores();
    const byId = new Map<string, Asset>([['video_1', bad], ['video_2', good]]);
    const out = await resolveTranscriptRanges({ trackId: 'V2', assetId: 'video_1', transcriptRange: { text: 'one' } }, id => byId.get(id), store) as Rec;
    expect(out).toMatchObject({ success: false, code: 'TRANSCRIPT_UNAVAILABLE', details: { assetId: 'video_1' } });
    const ok = await resolveTranscriptRanges({ trackId: 'V2', assetId: 'video_2', transcriptRange: { text: 'two' } }, id => byId.get(id), store) as Rec;
    expect(ok.resolved[0]).toMatchObject({ trimStart: 2, wordCount: 1, matchedText: 'two' });
  });
});
