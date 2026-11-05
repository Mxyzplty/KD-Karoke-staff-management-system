// SPDX-License-Identifier: AGPL-3.0-only
// T19 C1: the per-asset analysis steps recorded by prepareAsset (analysis, transcription, embeddings_description,
// embeddings_transcript) with fake steps. Synthetic data only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { mediaError } from '../apps/web/src/media/codes';
import { uploadToLibrary } from '../apps/web/src/media/ingest';
import { prepareAsset } from '../apps/web/src/media/prepare';
import type { AnalysisArgs, Steps } from '../apps/web/src/media/prepare';

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
afterEach(async () => { vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
const fake = (extra: Partial<Steps> = {}): Partial<Steps> => ({ probe: async () => ({ container: 'mp4', mimeType: 'video/mp4', durationMs: 3000, video: null, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null }), ...extra });
async function ready(store: ProjectStore) {
  return (await uploadToLibrary(store, [new File(['synthetic bytes'], 'clip.mp4')], async () => 'rename', { prepare: false })).assets[0];
}
const stored = (store: ProjectStore, id: string) => store.row<Asset>('assets', id);
const T19 = ['analysis', 'transcription', 'embeddings_description', 'embeddings_transcript'];
const only = (a: Asset | undefined) => Object.fromEntries(T19.map(n => [n, a?.processing_steps?.[n]]));

describe('T19 C1 preparation steps', () => {
  it('absent T19 steps are all "unavailable"; the asset is ready without an error', async () => {
    const store = setup(), a = await ready(store);
    expect(await prepareAsset(store, a.id, { steps: fake() })).toBe('prepared');
    const row = await stored(store, a.id);
    expect(only(row)).toEqual({ analysis: 'unavailable', transcription: 'unavailable', embeddings_description: 'unavailable', embeddings_transcript: 'unavailable' });
    expect(row).toMatchObject({ processing_status: 'ready', last_error_code: null, last_error_message: null });
  });
  it('a step returning { state: "skipped" } is recorded skipped; { state: "unavailable" } and "complete" likewise', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ analysis: async () => ({ state: 'skipped' }), transcription: async () => ({ state: 'unavailable' }), embeddings: async () => ({ state: 'skipped' }) }) });
    expect(only(await stored(store, a.id))).toEqual({ analysis: 'skipped', transcription: 'unavailable', embeddings_description: 'skipped', embeddings_transcript: 'skipped' });
  });
  it('{ states } sets embeddings_description and embeddings_transcript separately', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ analysis: async () => ({ state: 'complete' }), embeddings: async () => ({ states: { embeddings_description: 'complete', embeddings_transcript: 'skipped' } }) }) });
    expect(only(await stored(store, a.id))).toEqual({ analysis: 'complete', transcription: 'unavailable', embeddings_description: 'complete', embeddings_transcript: 'skipped' });
  });
  it('a step returning nothing (async () => {}) means complete, for every T19 step', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ analysis: async () => {}, transcription: async () => {}, embeddings: async () => {} }) });
    const row = await stored(store, a.id);
    expect(only(row)).toEqual({ analysis: 'complete', transcription: 'complete', embeddings_description: 'complete', embeddings_transcript: 'complete' });
    expect(row).toMatchObject({ processing_status: 'ready', last_error_code: null });
  });
  it('puts land in their stores with the step state', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({
      analysis: async () => ({ puts: [{ store: 'analyses', value: { id: a.id, analysis: { marker: 'a' } } }] }),
      transcription: async () => ({ puts: [{ store: 'transcripts', value: { id: a.id, status: 'complete', transcript: { marker: 't' } } }] }),
      embeddings: async () => ({ puts: [{ store: 'search_index', value: { id: a.id, embedder: 'fake', entry: { marker: 'e' } } }] }),
    }) });
    expect(await store.row('analyses', a.id)).toEqual({ id: a.id, analysis: { marker: 'a' } });
    expect(await store.row('transcripts', a.id)).toEqual({ id: a.id, status: 'complete', transcript: { marker: 't' } });
    expect(await store.row('search_index', a.id)).toEqual({ id: a.id, embedder: 'fake', entry: { marker: 'e' } });
    expect(only(await stored(store, a.id))).toEqual({ analysis: 'complete', transcription: 'complete', embeddings_description: 'complete', embeddings_transcript: 'complete' });
  });
  it('value of analysis and transcription reaches the embeddings step as results; absent or failed → null', async () => {
    const store = setup(), a = await ready(store), seen: Record<string, unknown>[] = [];
    await prepareAsset(store, a.id, { steps: fake({
      analysis: async () => ({ value: { summary: 'A' } }), transcription: async () => ({ value: { segments: [] } }),
      embeddings: async ({ results }: AnalysisArgs) => { seen.push({ ...results }); },
    }) });
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ analysis: { summary: 'A' }, transcription: { segments: [] } });
    const b = await ready(store); seen.length = 0;
    await prepareAsset(store, b.id, { steps: fake({ analysis: async () => { throw new Error('boom'); }, embeddings: async ({ results }: AnalysisArgs) => { seen.push({ ...results }); } }) });
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ analysis: null, transcription: null });
  });
  it('the step receives the blob, the probed info and the asset with the probed media', async () => {
    const store = setup(), a = await ready(store); let args: AnalysisArgs | undefined;
    await prepareAsset(store, a.id, { steps: fake({ analysis: async x => { args = x; } }) });
    expect(args?.info.durationMs).toBe(3000); expect(args?.asset.id).toBe(a.id); expect(args?.asset.media?.container).toBe('mp4'); expect(await args?.blob.text()).toBe('synthetic bytes'); expect(args?.signal.aborted).toBe(false);
  });
  it('a rejecting embeddings step: asset ready, EMBEDDING_FAILED with its message, both embeddings steps failed', async () => {
    const store = setup(), a = await ready(store);
    expect(await prepareAsset(store, a.id, { steps: fake({ analysis: async () => ({ state: 'complete' }), embeddings: async () => { throw new Error('index exploded'); } }) })).toBe('prepared');
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'EMBEDDING_FAILED', last_error_message: 'Search indexing failed — retry to try again.',
      processing_steps: { analysis: 'complete', embeddings_description: 'failed', embeddings_transcript: 'failed' } });
    expect((await store.row<{ code?: string }>('preparations', a.id))?.code).toBe('EMBEDDING_FAILED');
  });
  it('a failing analysis or transcription is GEMINI_FAILED / TRANSCRIPTION_FAILED and later steps still run', async () => {
    const store = setup(), a = await ready(store), ran: string[] = [];
    await prepareAsset(store, a.id, { steps: fake({ analysis: async () => { throw new Error('x'); }, transcription: async () => { ran.push('transcription'); }, embeddings: async () => { ran.push('embeddings'); } }) });
    expect(ran).toEqual(['transcription', 'embeddings']);
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED', last_error_message: 'Media analysis failed — retry to try again.', processing_steps: { analysis: 'failed', transcription: 'complete', embeddings_description: 'complete' } });
    const b = await ready(store);
    await prepareAsset(store, b.id, { steps: fake({ transcription: async () => { throw new Error('x'); } }) });
    expect(await stored(store, b.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'TRANSCRIPTION_FAILED', processing_steps: { transcription: 'failed', analysis: 'unavailable' } });
  });
  it('the first failing code wins: analysis failure + embeddings failure → GEMINI_FAILED', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ analysis: async () => { throw new Error('a'); }, transcription: async () => { throw new Error('t'); }, embeddings: async () => { throw new Error('e'); } }) });
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED', last_error_message: 'Media analysis failed — retry to try again.',
      processing_steps: { analysis: 'failed', transcription: 'failed', embeddings_description: 'failed', embeddings_transcript: 'failed' } });
  });
  it('a failed step keeps its earlier rows out of the store (rows are published with the state)', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ transcription: async () => { throw new Error('x'); } }) });
    expect(await store.row('transcripts', a.id)).toBeUndefined();
  });
  it('a retry after a T19 failure re-runs the steps and clears the code when they succeed', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ embeddings: async () => { throw new Error('e'); } }) });
    expect((await stored(store, a.id))?.last_error_code).toBe('EMBEDDING_FAILED');
    await prepareAsset(store, a.id, { steps: fake({ embeddings: async () => {} }), manual: true });
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: null, last_error_message: null, processing_steps: { embeddings_description: 'complete', embeddings_transcript: 'complete' } });
  });
});
