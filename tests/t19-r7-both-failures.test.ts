// SPDX-License-Identifier: AGPL-3.0-only
// T19 review finding 5: when the proxy (ENCODE_FAILED) and a T19 step both fail on one asset, last_error_code holds the proxy's
// code, so the analysis failure must be found from the asset's failed steps: analysisFailure(asset) (media-ui.tsx). Synthetic data only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { mediaError } from '../apps/web/src/media/codes';
import { uploadToLibrary } from '../apps/web/src/media/ingest';
import { prepareAsset } from '../apps/web/src/media/prepare';
import type { Steps } from '../apps/web/src/media/prepare';
import { analysisFailed, analysisFailure } from '../apps/web/src/media-ui';

const opened: ProjectStore[] = [];
let tick = Date.parse('2026-11-02T00:00:00Z');
function setup() {
  const files = new Map<string, Blob>();
  const media = {
    write: vi.fn(async (id: string, blob: Blob) => { files.set(id, blob); }), read: vi.fn(async (id: string) => { const b = files.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; }),
    remove: vi.fn(async (kind: string, id: string) => { if (kind === 'asset') files.delete(id); }), list: vi.fn(async () => [...files.keys()]),
    writeProxy: vi.fn(async () => {}), removeProxy: vi.fn(async () => {}),
  } as unknown as MediaStore;
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
}
afterEach(async () => { vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
const fake = (extra: Partial<Steps> = {}): Partial<Steps> => ({ probe: async () => ({ container: 'mp4', mimeType: 'video/mp4', durationMs: 3000, video: null, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null }), ...extra });
async function ready(store: ProjectStore) {
  return (await uploadToLibrary(store, [new File(['synthetic bytes'], 'clip.mp4')], async () => 'rename', { prepare: false })).assets[0];
}
const stored = async (store: ProjectStore, id: string) => (await store.row<Asset>('assets', id))!;
const encodeFails = async () => { throw mediaError('ENCODE_FAILED'); };
const proxyOk = async () => ({ blob: new Blob(['proxy']), codec: 'avc1', container: 'mp4', width: 2, height: 2 });
const boom = (name: string) => async () => { throw new Error(`${name} failed`); };

const STEP = {
  analysis: { code: 'GEMINI_FAILED', recorded: ['analysis'] },
  transcription: { code: 'TRANSCRIPTION_FAILED', recorded: ['transcription'] },
  embeddings: { code: 'EMBEDDING_FAILED', recorded: ['embeddings_description', 'embeddings_transcript'] },
} as const;
const NAMES = Object.keys(STEP) as (keyof typeof STEP)[];

describe('T19 R7a the proxy and a T19 step both fail: the asset keeps the proxy code, the analysis failure is still found', () => {
  it.each(NAMES)('proxy ENCODE_FAILED + %s throws → ready, last_error_code ENCODE_FAILED, proxy and step failed, analysisFailure = the step\'s code', async name => {
    const store = setup(), a = await ready(store);
    expect(await prepareAsset(store, a.id, { steps: fake({ proxy: encodeFails, [name]: boom(name) }) })).toBe('prepared');
    const row = await stored(store, a.id);
    expect(row).toMatchObject({ processing_status: 'ready', last_error_code: 'ENCODE_FAILED' });
    expect(row.processing_steps?.proxy).toBe('failed');
    for (const n of STEP[name].recorded) expect(row.processing_steps?.[n], n).toBe('failed');
    expect(analysisFailure(row)).toBe(STEP[name].code);
    expect(analysisFailed(row)).toBe(true);
  });
  it('several steps failed: the first in the order analysis → transcription → embeddings', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ proxy: encodeFails, transcription: boom('t'), embeddings: boom('e') }) });
    expect(analysisFailure(await stored(store, a.id))).toBe('TRANSCRIPTION_FAILED');
  });
});

describe('T19 R7b a manual retry where the proxy now succeeds but analysis still fails', () => {
  it('last_error_code GEMINI_FAILED, analysisFailure GEMINI_FAILED (still visible after the proxy retry)', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ proxy: encodeFails, analysis: boom('analysis') }) });
    expect((await stored(store, a.id)).last_error_code).toBe('ENCODE_FAILED');
    await prepareAsset(store, a.id, { steps: fake({ proxy: proxyOk, analysis: boom('analysis') }), manual: true });
    const row = await stored(store, a.id);
    expect(row).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED' });
    expect(row.processing_steps?.proxy).toBe('complete');
    expect(analysisFailure(row)).toBe('GEMINI_FAILED');
  });
});

describe('T19 R7c a manual retry where everything succeeds', () => {
  it('analysisFailure null, no error code, every step complete', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ proxy: encodeFails, analysis: boom('analysis') }) });
    expect(analysisFailure(await stored(store, a.id))).toBe('GEMINI_FAILED');
    await prepareAsset(store, a.id, { steps: fake({ proxy: proxyOk, analysis: async () => {}, transcription: async () => {}, embeddings: async () => {} }), manual: true });
    const row = await stored(store, a.id);
    expect(row).toMatchObject({ processing_status: 'ready', last_error_code: null });
    expect(row.processing_steps).toMatchObject({ proxy: 'complete', analysis: 'complete', transcription: 'complete', embeddings_description: 'complete', embeddings_transcript: 'complete' });
    expect(analysisFailure(row)).toBeNull(); expect(analysisFailed(row)).toBe(false);
  });
});

describe('T19 R7d a proxy-only failure is not an analysis failure', () => {
  it('T19 steps complete → analysisFailure null (the proxy code is not shown as an analysis badge)', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ proxy: encodeFails, analysis: async () => {}, transcription: async () => {}, embeddings: async () => {} }) });
    const row = await stored(store, a.id);
    expect(row).toMatchObject({ processing_status: 'ready', last_error_code: 'ENCODE_FAILED' });
    expect(analysisFailure(row)).toBeNull(); expect(analysisFailed(row)).toBe(false);
  });
  it('T19 steps unavailable (no steps given) → analysisFailure null', async () => {
    const store = setup(), a = await ready(store);
    await prepareAsset(store, a.id, { steps: fake({ proxy: encodeFails }) });
    const row = await stored(store, a.id);
    expect(row.last_error_code).toBe('ENCODE_FAILED'); expect(analysisFailure(row)).toBeNull();
  });
});

describe('T19 R7 analysisFailure as a function of the asset row', () => {
  const row = (status: string, code: string | null, steps: Record<string, string>) => ({ id: 'x', processing_status: status, last_error_code: code, processing_steps: steps }) as unknown as Asset;
  it('only a ready asset has an analysis failure', () => {
    for (const status of ['processing', 'uploading', 'failed']) {
      expect(analysisFailure(row(status, 'GEMINI_FAILED', { analysis: 'failed' })), status).toBeNull();
      expect(analysisFailed(row(status, null, { analysis: 'failed' })), status).toBe(false);
    }
  });
  it('last_error_code first when it is one of the three; else the first failed step', () => {
    expect(analysisFailure(row('ready', 'EMBEDDING_FAILED', { analysis: 'failed' }))).toBe('EMBEDDING_FAILED');
    expect(analysisFailure(row('ready', 'ENCODE_FAILED', { analysis: 'failed', transcription: 'failed' }))).toBe('GEMINI_FAILED');
    expect(analysisFailure(row('ready', 'ENCODE_FAILED', { transcription: 'failed', embeddings_transcript: 'failed' }))).toBe('TRANSCRIPTION_FAILED');
    expect(analysisFailure(row('ready', 'EXTRACTION_FAILED', { embeddings_description: 'failed' }))).toBe('EMBEDDING_FAILED');
    expect(analysisFailure(row('ready', 'ENCODE_FAILED', { embeddings_transcript: 'failed' }))).toBe('EMBEDDING_FAILED');
  });
  it('null when nothing failed, whatever the other states and the (non-analysis) error code', () => {
    expect(analysisFailure(row('ready', null, {}))).toBeNull();
    expect(analysisFailure(row('ready', 'ENCODE_FAILED', { proxy: 'failed', analysis: 'complete', transcription: 'unavailable', embeddings_description: 'pending', embeddings_transcript: 'skipped' }))).toBeNull();
    expect(analysisFailure({ id: 'x', processing_status: 'ready', last_error_code: null } as unknown as Asset)).toBeNull(); // no processing_steps at all
  });
});
