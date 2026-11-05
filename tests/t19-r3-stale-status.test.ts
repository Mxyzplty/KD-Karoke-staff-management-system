// SPDX-License-Identifier: AGPL-3.0-only
// T19 review fix R3: the async T19 paths (viewItemDetails, syncAndSwap, addMedia transcriptRange) re-read the asset from the
// analysis store, store.row('assets', <stored id>), after their first await, and fall back to the ctx.asset snapshot when the
// store has no row: the snapshot can be stale (status 'processing', durationMs null) once the preparation has finished.
// Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { viewItemDetails } from '../apps/web/src/analysis/details';
import type { DetailsContext } from '../apps/web/src/analysis/details';
import { syncAndSwap } from '../apps/web/src/analysis/multicam';
import type { SwapContext } from '../apps/web/src/analysis/multicam';
import { resolveTranscriptRanges } from '../apps/web/src/analysis/ranges';
import type { RhythmRow } from '../apps/web/src/analysis/service';
import type { Rhythm } from '../apps/web/src/analysis/types';
import type { Asset } from '../apps/web/src/store/model';
import { build, mkItem, mkTrack } from './t03-fixtures';

type Rec = Record<string, any>;
const DONE = { analysis: 'complete', transcription: 'complete', embeddings_description: 'complete', embeddings_transcript: 'complete' };
const PENDING = { analysis: 'pending', transcription: 'pending', embeddings_description: 'pending', embeddings_transcript: 'pending' };
const asset = (id: string, type: 'video' | 'audio', durationMs: number | null, extra: Rec = {}) =>
  ({ id, name: `${id}.bin`, type, durationMs, recorded_at: null, processing_status: 'ready', processing_steps: { ...DONE }, last_error_code: null, media: { container: 'mp4' }, ...extra }) as unknown as Asset;
/** The state of an asset whose preparation has not been seen to finish: processing, no media yet, nothing known. */
const stale = (id: string, type: 'video' | 'audio', extra: Rec = {}) => asset(id, type, null, { processing_status: 'processing', processing_steps: { ...PENDING }, media: undefined, ...extra });

// ---- viewItemDetails ------------------------------------------------------------------------------------------------------------
const RHYTHM: Rhythm = { bpm: 120, averageBpm: 118, beats: [[0.5, 0.9], [1, 0.4], [1.5, 0.9]], downbeats: [[0.5, 0.9]], silences: [] };
const rhythmRow = (a: Asset): RhythmRow => ({ id: a.id, analysis: { stored: RHYTHM, tab: { bpm: 120, beats: RHYTHM.beats, onsets: [], silences: [], firstBeat: 0.5, tempoType: 'constant' } }, created_at: '2026-11-02T00:00:00Z' });
function details(o: { snapshot: Asset; fresh?: Asset; agent: string; items: Rec[] }) {
  const byId = new Map<string, Asset>([[o.snapshot.id, o.snapshot], [o.agent, o.snapshot]]), reads: string[] = [];
  const rows: Rec = { assets: o.fresh ? { [o.fresh.id]: o.fresh } : {} };
  const service = { rhythm: vi.fn(async (_store: unknown, a: Asset) => rhythmRow(a)) };
  const ctx = { doc: build({ tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video')], items: o.items }),
    asset: (id: string) => byId.get(id), agentId: (id: string) => (id === o.snapshot.id ? o.agent : undefined),
    store: { row: async (s: string, id: string) => { reads.push(`${s}:${id}`); return rows[s]?.[id]; }, putRow: async () => {}, media: {} }, service } as unknown as DetailsContext;
  return { run: (input: Rec) => viewItemDetails(ctx, input) as Promise<Rec>, service, reads };
}
const AUDIO_ITEM = [mkItem('a1', 'A1', 0, 4000, { type: 'audio', trim: { from: 0, to: 4000 }, metadata: { assetId: 'asset-aud' } })];
const VIDEO_ITEM = [mkItem('v1', 'V1', 0, 4000, { trim: { from: 0, to: 4000 }, metadata: { assetId: 'asset-vid' } })];

describe('T19 R3a viewItemDetails include=beats re-reads the asset', () => {
  it.each([['item', { itemId: 'a1' }], ['asset', { assetId: 'audio_1' }]])('%s: snapshot processing without media, store row ready → no BEATS_PROCESSING; rhythm is asked with the fresh row', async (_n, ids) => {
    const w = details({ snapshot: stale('asset-aud', 'audio'), fresh: asset('asset-aud', 'audio', 8000, { media: { container: 'mp3' } }), agent: 'audio_1', items: AUDIO_ITEM });
    const r = await w.run({ ...ids, include: 'beats' });
    expect(r).toMatchObject({ success: true, data: { beats: { bpm: 120 } } }); // before the fix: BEATS_PROCESSING
    expect(w.service.rhythm).toHaveBeenCalledTimes(1);
    expect(w.service.rhythm.mock.calls[0][1]).toMatchObject({ id: 'asset-aud', processing_status: 'ready', media: { container: 'mp3' }, durationMs: 8000 });
    expect(w.reads).toContain('assets:asset-aud');
  });
  it('guard: the store has no row for it → the snapshot is used (processing → BEATS_PROCESSING, the service is not asked)', async () => {
    const w = details({ snapshot: stale('asset-aud', 'audio'), agent: 'audio_1', items: AUDIO_ITEM });
    expect(await w.run({ assetId: 'audio_1', include: 'beats' })).toMatchObject({ success: false, code: 'BEATS_PROCESSING' });
    expect(w.service.rhythm).not.toHaveBeenCalled();
  });
  it('the other way: snapshot ready, store row processing → BEATS_PROCESSING', async () => {
    const w = details({ snapshot: asset('asset-aud', 'audio', 8000), fresh: asset('asset-aud', 'audio', 8000, { processing_status: 'processing' }), agent: 'audio_1', items: AUDIO_ITEM });
    expect(await w.run({ assetId: 'audio_1', include: 'beats' })).toMatchObject({ success: false, code: 'BEATS_PROCESSING' });
    expect(w.service.rhythm).not.toHaveBeenCalled();
  });
});

describe('T19 R3b viewItemDetails of an asset or item: duration, status flags and capabilities come from the fresh row', () => {
  const fresh = () => asset('asset-vid', 'video', 30000);
  it('asset (no item): duration / endTime 30, no assetProcessing, no capabilities', async () => {
    const w = details({ snapshot: stale('asset-vid', 'video'), fresh: fresh(), agent: 'video_1', items: VIDEO_ITEM });
    const r = await w.run({ assetId: 'video_1', include: 'transcript' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ id: 'video_1', type: 'video', startTime: 0, endTime: 30, duration: 30 });
    expect(r.data).not.toHaveProperty('assetProcessing'); expect(r.data).not.toHaveProperty('status'); expect(r.data).not.toHaveProperty('note');
    expect(r.data).not.toHaveProperty('capabilities');
  });
  it('item: no assetProcessing / capabilities either', async () => {
    const w = details({ snapshot: stale('asset-vid', 'video'), fresh: fresh(), agent: 'video_1', items: VIDEO_ITEM });
    const r = await w.run({ itemId: 'v1', include: 'transcript' });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty('assetProcessing'); expect(r.data).not.toHaveProperty('capabilities');
  });
  it('the other way: snapshot ready and complete, store row processing → assetProcessing and capabilities pending', async () => {
    const w = details({ snapshot: asset('asset-vid', 'video', 30000), fresh: stale('asset-vid', 'video', { durationMs: 30000 }), agent: 'video_1', items: VIDEO_ITEM });
    const r = await w.run({ assetId: 'video_1', include: 'transcript' });
    expect(r.data).toMatchObject({ assetProcessing: true, status: 'PROCESSING', capabilities: { analysis: 'pending', transcript: 'pending', search: 'pending' } });
  });
  it('guard: no store row → the snapshot (processing, durationMs null → 0 s, assetProcessing)', async () => {
    const w = details({ snapshot: stale('asset-vid', 'video'), agent: 'video_1', items: VIDEO_ITEM });
    const r = await w.run({ assetId: 'video_1', include: 'transcript' });
    expect(r.data).toMatchObject({ endTime: 0, duration: 0, assetProcessing: true, capabilities: { analysis: 'pending' } });
  });
});

// ---- syncAndSwap ----------------------------------------------------------------------------------------------------------------
const word = (w: string, start: number) => ({ word: w, start, end: start + 0.3 });
const SRC_WORDS = [word('sa', 1), word('sb', 2), word('sc', 3)], BASE_WORDS = [word('ba', 1), word('bb', 2), word('bc', 3)];
const trow = (id: string, words: Rec[]) => ({ id, status: 'complete', transcript: { words }, created_at: 'x' });
function swap(o: { source: Asset; fresh?: Asset; transcripts?: Rec }) {
  const base = asset('asset-base', 'video', 20000);
  const items = [mkItem('base', 'V1', 2000, 12000, { trim: { from: 5000, to: 15000 }, sourceDuration: 20000, metadata: { assetId: 'asset-base' } })];
  const doc = build({ tracks: [mkTrack('V1', 'video'), mkTrack('V2', 'video')], items });
  const byId = new Map<string, Asset>([['asset-base', base], ['asset-src', o.source], ['video_2', o.source]]);
  const rows: Rec = { transcripts: o.transcripts ?? { 'asset-src': trow('asset-src', SRC_WORDS), 'asset-base': trow('asset-base', BASE_WORDS) }, assets: o.fresh ? { [o.fresh.id]: o.fresh } : {} };
  const sync = vi.fn(async () => ({ offset: 1.234, confidence: 0.9, matches: [{ sourceIndex: 0, targetIndex: 0, sourceTime: 1, targetTime: 0 }] }));
  const place = vi.fn((args: Rec) => ({ success: true, data: { echo: args } }));
  const ctx = { doc: () => doc, asset: (id: string) => byId.get(id), store: { row: async (s: string, id: string) => rows[s]?.[id] }, service: { syncOffset: sync }, place } as unknown as SwapContext;
  return { run: () => syncAndSwap(ctx, { sourceAssetId: 'video_2', targetItemId: 'base', trackId: 'V2', from: 4, to: 8 }) as Promise<Rec>, place, sync };
}

describe('T19 R3c syncAndSwap re-reads the source asset', () => {
  it('snapshot durationMs null, store row 10000 → trimEnd clamped to 10 (before the fix: 12.234, unclamped)', async () => {
    const w = swap({ source: asset('asset-src', 'video', null), fresh: asset('asset-src', 'video', 10000) });
    expect((await w.run()).success).toBe(true);
    expect(w.place).toHaveBeenCalledTimes(1);
    expect(w.place.mock.calls[0][0]).toEqual({ assetId: 'video_2', trackId: 'V2', timelineStart: 4, trimStart: 8.234, trimEnd: 10 });
  });
  it('guard: no store row → the snapshot duration (null → unclamped)', async () => {
    const w = swap({ source: asset('asset-src', 'video', null) });
    await w.run();
    expect(w.place.mock.calls[0][0]).toMatchObject({ trimStart: 8.234, trimEnd: 12.234 });
  });
  it('snapshot processing, store row ready with transcription unavailable and no transcript → ANALYSIS_UNAVAILABLE (not the "still being processed" TRANSCRIPT_UNAVAILABLE)', async () => {
    const w = swap({ source: stale('asset-src', 'video'), fresh: asset('asset-src', 'video', 10000, { processing_steps: { ...DONE, transcription: 'unavailable' } }),
      transcripts: { 'asset-base': trow('asset-base', BASE_WORDS) } });
    expect(await w.run()).toMatchObject({ success: false, code: 'ANALYSIS_UNAVAILABLE' });
    expect(w.sync).not.toHaveBeenCalled();
  });
  it('the other way: snapshot ready, store row processing, no transcript → TRANSCRIPT_UNAVAILABLE (still being processed)', async () => {
    const w = swap({ source: asset('asset-src', 'video', 10000), fresh: stale('asset-src', 'video', { durationMs: 10000 }), transcripts: { 'asset-base': trow('asset-base', BASE_WORDS) } });
    const r = await w.run();
    expect(r).toMatchObject({ success: false, code: 'TRANSCRIPT_UNAVAILABLE' });
    expect(r.error).toContain('still being processed');
  });
  it('guard: snapshot processing, no store row, no transcript → TRANSCRIPT_UNAVAILABLE (still being processed)', async () => {
    const w = swap({ source: stale('asset-src', 'video'), transcripts: { 'asset-base': trow('asset-base', BASE_WORDS) } });
    expect(await w.run()).toMatchObject({ success: false, code: 'TRANSCRIPT_UNAVAILABLE' });
  });
});

// ---- addMedia transcriptRange ---------------------------------------------------------------------------------------------------
describe('T19 R3d resolveTranscriptRanges re-reads the asset duration', () => {
  const WORDS = [{ word: 'alpha', start: 0, end: 0.4 }, { word: 'zulu', start: 4.5, end: 6.5 }];
  function resolve(snapshot: Asset, fresh?: Asset) {
    const rows: Rec = { transcripts: { 'asset-v': trow('asset-v', WORDS) }, assets: fresh ? { [fresh.id]: fresh } : {} };
    const store = { row: async (s: string, id: string) => rows[s]?.[id] };
    return resolveTranscriptRanges({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'zulu' } }, id => (id === 'video_1' || id === 'asset-v' ? snapshot : undefined), store as never) as Promise<Rec>;
  }
  it('snapshot durationMs null, store row 5000 (shorter than the last word\'s end 6.5) → trimEnd clamped to 5', async () => {
    const r = await resolve(asset('asset-v', 'video', null), asset('asset-v', 'video', 5000));
    expect(r.code, JSON.stringify(r)).toBeUndefined();
    expect(r.resolved[0]).toEqual({ trimStart: 4.5, trimEnd: 5, duration: 0.5, wordCount: 1, matchedText: 'zulu' });
    expect(r.args).toMatchObject({ trimStart: 4.5, trimEnd: 5 });
  });
  it('the other way: snapshot 4 s, store row 10 s → not clamped to the stale 4 s', async () => {
    const r = await resolve(asset('asset-v', 'video', 4000), asset('asset-v', 'video', 10000));
    expect(r.resolved[0]).toMatchObject({ trimStart: 4.5, trimEnd: 6.5 });
  });
  it('guard: no store row → the snapshot duration (null → unclamped, 5000 → clamped)', async () => {
    expect((await resolve(asset('asset-v', 'video', null))).resolved[0]).toMatchObject({ trimEnd: 6.5 });
    expect((await resolve(asset('asset-v', 'video', 5000))).resolved[0]).toMatchObject({ trimEnd: 5 });
  });
});
