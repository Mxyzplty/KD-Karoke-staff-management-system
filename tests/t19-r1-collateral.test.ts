// SPDX-License-Identifier: AGPL-3.0-only
// T19 review fix R1 (a-c): a T19 step that rejects ANALYSIS_CANCELLED while ITS OWN signal is not aborted is a collateral
// cancel (another request's abort dropped the shared analysis worker). prepareAsset re-runs the step, at most 2 re-runs
// (3 calls in all); the failed call's `puts` are not published; after the last one the step fails with its code and the asset
// stays ready. Any other failure is not re-run and its puts are published (C2). Synthetic data only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { AnalysisError } from '../apps/web/src/analysis/types';
import { mediaError } from '../apps/web/src/media/codes';
import { uploadToLibrary } from '../apps/web/src/media/ingest';
import { cancelPreparation, prepareAsset } from '../apps/web/src/media/prepare';
import type { AnalysisArgs, PreparationRecord, Steps } from '../apps/web/src/media/prepare';

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
const collateral = (puts?: { store: string; value: unknown }[]) => Object.assign(new AnalysisError('ANALYSIS_CANCELLED', 'Analysis was cancelled.'), puts ? { puts } : {});

type Name = 'analysis' | 'transcription' | 'embeddings';
/** Per step: its failure code, the recorded step names, the store of the row an error would carry, and a success outcome. */
const STEPS: Record<Name, { code: string; recorded: string[]; store: 'analyses' | 'transcripts' | 'search_index'; ok: { state?: 'complete'; states?: Record<string, 'complete'> } }> = {
  analysis: { code: 'GEMINI_FAILED', recorded: ['analysis'], store: 'analyses', ok: { state: 'complete' } },
  transcription: { code: 'TRANSCRIPTION_FAILED', recorded: ['transcription'], store: 'transcripts', ok: { state: 'complete' } },
  embeddings: { code: 'EMBEDDING_FAILED', recorded: ['embeddings_description', 'embeddings_transcript'], store: 'search_index', ok: { states: { embeddings_description: 'complete', embeddings_transcript: 'complete' } } },
};
const NAMES = Object.keys(STEPS) as Name[];
const failedRow = (name: Name, id: string) => ({ store: STEPS[name].store, value: { id, status: 'failed', transcript: null, error: 'Analysis was cancelled.', created_at: 'x' } });

/** A step that throws `fail(call)` for the first `times` calls (with the failed row as puts) and then succeeds. */
function flaky(name: Name, id: string, times: number, fail: () => Error = () => collateral([failedRow(name, id)])) {
  const calls: AnalysisArgs[] = [];
  const step = async (args: AnalysisArgs) => { calls.push(args); if (calls.length <= times) throw fail(); return STEPS[name].ok; };
  return { calls, steps: fake({ [name]: step }) };
}

describe('T19 R1a a collateral cancel once, then success: the step is re-run and ends complete', () => {
  it.each(NAMES)('%s: 2 calls, step complete, asset ready with no error code, the first call\'s puts not published', async name => {
    const store = setup(), a = await ready(store), { calls, steps } = flaky(name, a.id, 1);
    expect(await prepareAsset(store, a.id, { steps })).toBe('prepared');
    expect(calls).toHaveLength(2);
    const row = await stored(store, a.id);
    expect(row).toMatchObject({ processing_status: 'ready', last_error_code: null, last_error_message: null });
    for (const n of STEPS[name].recorded) expect(row?.processing_steps?.[n], n).toBe('complete');
    expect(await store.row(STEPS[name].store, a.id)).toBeUndefined();
    expect(await store.row<PreparationRecord>('preparations', a.id)).toMatchObject({ phase: 'finished' });
  });
  it('a re-run gets a signal that is not aborted, and the later steps still run once', async () => {
    const store = setup(), a = await ready(store), seen: boolean[] = []; let embeddings = 0;
    let n = 0;
    await prepareAsset(store, a.id, { steps: fake({
      transcription: async ({ signal }: AnalysisArgs) => { seen.push(signal.aborted); if (++n === 1) throw collateral(); return { state: 'complete' }; },
      embeddings: async () => { embeddings++; },
    }) });
    expect(seen).toEqual([false, false]); expect(embeddings).toBe(1);
  });
});

describe('T19 R1b a collateral cancel every time: 3 calls, then the step fails with its code; nothing from the error is published', () => {
  it.each(NAMES)('%s: 3 calls in all, step failed, asset ready with its code, no row', async name => {
    const store = setup(), a = await ready(store), { calls, steps } = flaky(name, a.id, 99);
    expect(await prepareAsset(store, a.id, { steps })).toBe('prepared');
    expect(calls).toHaveLength(3);
    const row = await stored(store, a.id);
    expect(row).toMatchObject({ processing_status: 'ready', last_error_code: STEPS[name].code });
    for (const n of STEPS[name].recorded) expect(row?.processing_steps?.[n], n).toBe('failed');
    expect(await store.row(STEPS[name].store, a.id)).toBeUndefined();
    expect(await store.row<PreparationRecord>('preparations', a.id)).toMatchObject({ phase: 'finished', code: STEPS[name].code });
  });
  it('the cancel on the third call is the last: two cancels then success is complete (the boundary)', async () => {
    const store = setup(), a = await ready(store), { calls, steps } = flaky('transcription', a.id, 2);
    expect(await prepareAsset(store, a.id, { steps })).toBe('prepared');
    expect(calls).toHaveLength(3);
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: null, processing_steps: { transcription: 'complete' } });
  });
  it('a failed analysis step does not stop the others: transcription and embeddings still run; the first failure code wins', async () => {
    const store = setup(), a = await ready(store); let transcription = 0, embeddings = 0;
    await prepareAsset(store, a.id, { steps: fake({
      analysis: async () => { throw collateral(); },
      transcription: async () => { transcription++; },
      embeddings: async () => { embeddings++; },
    }) });
    expect(transcription).toBe(1); expect(embeddings).toBe(1);
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED' });
  });
});

describe('T19 R1c other failures are not re-run and their puts are published (C2)', () => {
  it.each(NAMES)('%s: a plain failure → 1 call, step failed, asset ready with its code, the error\'s row stored', async name => {
    const store = setup(), a = await ready(store);
    const { calls, steps } = flaky(name, a.id, 99, () => Object.assign(new Error('boom'), { puts: [failedRow(name, a.id)] }));
    expect(await prepareAsset(store, a.id, { steps })).toBe('prepared');
    expect(calls).toHaveLength(1);
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: STEPS[name].code });
    expect(await store.row(STEPS[name].store, a.id)).toMatchObject({ id: a.id, status: 'failed', error: 'Analysis was cancelled.' });
  });
  it('a different AnalysisError code is not collateral either', async () => {
    const store = setup(), a = await ready(store); let calls = 0;
    await prepareAsset(store, a.id, { steps: fake({ transcription: async () => { calls++; throw new AnalysisError('TRANSCRIPTION_FAILED', 'nope'); } }) });
    expect(calls).toBe(1);
    expect(await stored(store, a.id)).toMatchObject({ last_error_code: 'TRANSCRIPTION_FAILED', processing_steps: { transcription: 'failed' } });
  });
  it('guard: the user cancels during the step and the step rejects ANALYSIS_CANCELLED on its own (aborted) signal → not collateral: 1 call, attempt cancelled', async () => {
    const store = setup(), a = await ready(store); let calls = 0, started = false;
    const done = prepareAsset(store, a.id, { steps: fake({
      transcription: ({ signal }: AnalysisArgs) => { calls++; started = true; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(collateral([failedRow('transcription', a.id)])), { once: true })); },
    }) });
    await vi.waitFor(() => expect(started).toBe(true));
    expect(cancelPreparation(a.id)).toBe(true);
    expect(await done).toBe('failed');
    expect(calls).toBe(1);
    expect(await store.row<PreparationRecord>('preparations', a.id)).toMatchObject({ phase: 'cancelled', cancelledBy: 'user' });
    expect(await store.row('transcripts', a.id)).toBeUndefined();
  });
});
