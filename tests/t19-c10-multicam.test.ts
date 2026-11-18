// SPDX-License-Identifier: AGPL-3.0-only
// T19 C10 (MC-P01): syncAndSwap (analysis/multicam.ts) over a fake service and a fake place; the executor route (real T03 runtime,
// injected store/service); and the real sync.ts syncOffset on the public aligned words of the 30 s action clip when
// $CUTFRAME_FIXTURES has them. Synthetic words otherwise; no fitting. Audit F1 (landed-audit-t19 l.37-46): the real syncOffset
// on a seeded 3,000-word pair, each call in a worker killed at a hard cap; measurement only (time printed, offset asserted).
// F1 fix, red-first (lane A 03:56): the 2 s bar, identity goldens of whole results, and the 30 s syncAndSwap deadline.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { build as bundle } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { UNAVAILABLE } from '../apps/web/src/analysis/availability';
import { SWAP, syncAndSwap } from '../apps/web/src/analysis/multicam';
import type { SwapContext } from '../apps/web/src/analysis/multicam';
import type { AnalysisRequest } from '../apps/web/src/analysis/protocol';
import { AnalysisService } from '../apps/web/src/analysis/service';
import { syncOffset } from '../apps/web/src/analysis/sync';
import type { SyncResult } from '../apps/web/src/analysis/sync';
import { AnalysisError } from '../apps/web/src/analysis/types';
import type { Transcript } from '../apps/web/src/analysis/types';
import { createEditor } from '../apps/web/src/timeline/harness';
import type { Asset } from '../apps/web/src/store/model';
import { assets as fixtureAssets, build, fixture, links, mkItem, mkTrack } from './t03-fixtures';

type Rec = Record<string, any>;
const MESSAGE = 'sourceAssetId, targetItemId, trackId, from, and to are all required.';
const WINDOW = 'from and to must define a finite, increasing timeline range.';

const word = (w: string, start: number) => ({ word: w, start, end: start + 0.3 });
const SRC_WORDS = [word('sa', 1), word('sb', 2), word('sc', 3)], BASE_WORDS = [word('ba', 1), word('bb', 2), word('bc', 3)];
const row = (id: string, words: Rec[] | null) => ({ id, status: 'complete', transcript: words ? { words } : null, created_at: 'x' });
const asset = (id: string, durationMs: number, extra: Rec = {}) =>
  ({ id, name: `${id}.bin`, type: 'video', durationMs, processing_status: 'ready', processing_steps: { transcription: 'complete' }, last_error_code: null, ...extra }) as unknown as Asset;

type Rig = { xapp?: boolean; offset?: number; confidence?: number; items?: Rec[]; assets?: Asset[]; rows?: Rec; sync?: (doc: { set(items: Rec[]): void }) => Promise<unknown> | unknown; place?: (a: Rec) => Rec };
/** Base item 'base' 2–12 s on V1, trim.from 5 s, asset 20 s; second camera 'video_2' / asset-src 10 s; place echoes its arguments. */
function rig(o: Rig = {}) {
  const baseItems = [mkItem('base', 'V1', 2000, 12000, { trim: { from: 5000, to: 15000 }, sourceDuration: 20000, metadata: { assetId: 'asset-base' } }),
    mkItem('txt', 'O1', 1000, 3000, { type: 'text', details: { text: 'Hello' }, metadata: {} })];
  const tracks = [mkTrack('V1', 'video'), mkTrack('V2', 'video'), mkTrack('O1', 'overlay')];
  let doc = build({ tracks, items: o.items ?? baseItems });
  const list = o.assets ?? [asset('asset-base', 20000), asset('asset-src', 10000)];
  const byId = new Map<string, Asset>([['video_1', list[0]], ['video_2', list[1]]]);
  for (const a of list) byId.set(a.id, a);
  const rows: Rec = o.rows ?? { transcripts: { 'asset-src': row('asset-src', SRC_WORDS), 'asset-base': row('asset-base', BASE_WORDS) } };
  const offset = o.offset ?? 1.234, confidence = o.confidence ?? 0.9;
  const syncOffsetFn = vi.fn(async (..._a: unknown[]) => {
    await o.sync?.({ set: items => { doc = build({ tracks, items }); } });
    return { offset, confidence, matches: [{ sourceIndex: 0, targetIndex: 0, sourceTime: 1, targetTime: 0 }, { sourceIndex: 1, targetIndex: 1, sourceTime: 2, targetTime: 1 }, { sourceIndex: 2, targetIndex: 2, sourceTime: 3, targetTime: 2 }] };
  });
  const place = vi.fn((args: Rec) => o.place?.(args) ?? ({ success: true, data: { echo: args }, timelineChanges: 'x' }));
  const reads: string[] = [];
  const ctx = { doc: () => doc, asset: (id: string) => byId.get(id), store: { row: async (s: string, id: string) => { reads.push(`${s}:${id}`); return rows[s]?.[id]; } },
    service: { syncOffset: syncOffsetFn }, place, ...(o.xapp ? { xapp: true } : {}) } as unknown as SwapContext;
  return { ctx, place, sync: syncOffsetFn, reads, items: baseItems };
}
const INPUT = { sourceAssetId: 'video_2', targetItemId: 'base', trackId: 'V2', from: 4, to: 8 };
const run = (r: ReturnType<typeof rig>, extra: Rec = {}) => syncAndSwap(r.ctx, { ...INPUT, ...extra }) as Promise<Rec>;
const placed = (r: ReturnType<typeof rig>) => { expect(r.place).toHaveBeenCalledTimes(1); return r.place.mock.calls[0][0]; };

describe('T19 C10 syncAndSwap: placement', () => {
  it('a. base 2–12 s with trim.from 5 s, offset +1.234, window 4–8 → timelineStart 4, trim 8.234–10 (end clamped to the 10 s source)', async () => {
    const r = rig(), out = await run(r);
    expect(placed(r)).toEqual({ assetId: 'video_2', trackId: 'V2', timelineStart: 4, trimStart: 8.234, trimEnd: 10 });
    expect(out).toEqual({ success: true, data: { echo: placed(r) }, timelineChanges: 'x', syncOffset: 1.234, syncConfidence: 0.9, syncMatches: 3 });
  });
  it('b. offset −7.5 → the start moves so the part stays in sync: timelineStart 4.5, trim 0–3.5', async () => {
    const r = rig({ offset: -7.5 }); await run(r);
    expect(placed(r)).toEqual({ assetId: 'video_2', trackId: 'V2', timelineStart: 4.5, trimStart: 0, trimEnd: 3.5 });
  });
  it('c. xapp: timelineStart = from, trim = [max(0, from + offset), to + offset]', async () => {
    const r = rig({ xapp: true }); await run(r);
    const a = placed(r); expect(a).toMatchObject({ assetId: 'video_2', trackId: 'V2', timelineStart: 4 });
    expect(a.trimStart).toBeCloseTo(5.234, 9); expect(a.trimEnd).toBeCloseTo(9.234, 9);
    const n = rig({ xapp: true, offset: -7.5 }); await run(n);
    expect(placed(n)).toMatchObject({ timelineStart: 4, trimStart: 0 }); expect(placed(n).trimEnd).toBeCloseTo(0.5, 9);
  });
  it('xapp does not check the base clip speed; Cutframe mode does', async () => {
    const fast = [mkItem('base', 'V1', 2000, 12000, { trim: { from: 5000, to: 15000 }, playbackRate: 2, metadata: { assetId: 'asset-base' } })];
    const v = rig({ xapp: true, items: fast }); expect((await run(v)).success).toBe(true); expect(v.place).toHaveBeenCalledTimes(1);
    const d = rig({ items: fast }); expect(await run(d)).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT' }); expect(d.place).not.toHaveBeenCalled();
  });
  it('the source asset resolves by its stored id too; the result carries the id as given', async () => {
    const r = rig(); await run(r, { sourceAssetId: 'asset-src' });
    expect(placed(r)).toMatchObject({ assetId: 'asset-src', trackId: 'V2', timelineStart: 4, trimStart: 8.234, trimEnd: 10 });
  });
  it('the offset is syncOffset(source transcript, target transcript): source first; both stored transcripts are read once', async () => {
    const r = rig(); await run(r);
    const [source, target] = r.sync.mock.calls[0] as [Transcript, Transcript];
    expect(source.segments.flatMap(s => s.words.map(w => w.word))).toEqual(['sa', 'sb', 'sc']);
    expect(target.segments.flatMap(s => s.words.map(w => w.word))).toEqual(['ba', 'bb', 'bc']);
    expect(r.sync).toHaveBeenCalledTimes(1); expect(r.reads.filter(x => x.startsWith('transcripts:')).sort()).toEqual(['transcripts:asset-base', 'transcripts:asset-src']);
  });
  it('a window starting at 0 is valid (0 is not "missing"); the window start maps through the base item', async () => {
    const r = rig({ offset: 0 }); const out = await run(r, { from: 0, to: 3 });
    expect(out.success).toBe(true); expect(placed(r)).toEqual({ assetId: 'video_2', trackId: 'V2', timelineStart: 0, trimStart: 3, trimEnd: 6 });
  });
  it('placement values are rounded to 3 decimals; syncOffset and syncConfidence to 6', async () => {
    const r = rig({ offset: 1.23456789, confidence: 0.8765432109 }); const out = await run(r);
    expect(placed(r)).toEqual({ assetId: 'video_2', trackId: 'V2', timelineStart: 4, trimStart: 8.235, trimEnd: 10 });
    expect(out).toMatchObject({ syncOffset: 1.234568, syncConfidence: 0.876543, syncMatches: 3 });
  });
  it('a place failure is returned as is, without sync fields', async () => {
    const failure = { success: false, code: 'TRACK_LOCKED', error: 'Track V2 is locked' };
    const r = rig({ place: () => failure }); const out = await run(r);
    expect(out).toEqual(failure); expect(r.place).toHaveBeenCalledTimes(1);
  });
  it('a base clip with a trimmed start before the window is mapped from its own trim: trim.from 0, item 0–10 s, offset 2 → trim 6–10 for window 4–8', async () => {
    const r = rig({ offset: 2, items: [mkItem('base', 'V1', 0, 10000, { trim: { from: 0, to: 10000 }, metadata: { assetId: 'asset-base' } })] }); await run(r);
    expect(placed(r)).toEqual({ assetId: 'video_2', trackId: 'V2', timelineStart: 4, trimStart: 6, trimEnd: 10 });
  });
});

describe('T19 C10 syncAndSwap: the base item moved while the offset was computed (f)', () => {
  it('trims follow the moved item: display 3–13 s (trim.from 5 s) → trim 7.234–10', async () => {
    const r = rig({ sync: async doc => doc.set([mkItem('base', 'V1', 3000, 13000, { trim: { from: 5000, to: 15000 }, sourceDuration: 20000, metadata: { assetId: 'asset-base' } })]) });
    await run(r); expect(placed(r)).toEqual({ assetId: 'video_2', trackId: 'V2', timelineStart: 4, trimStart: 7.234, trimEnd: 10 });
  });
  it('the item re-trimmed meanwhile (trim.from 6 s) shifts the source part by 1 s', async () => {
    const r = rig({ sync: async doc => doc.set([mkItem('base', 'V1', 2000, 12000, { trim: { from: 6000, to: 16000 }, sourceDuration: 20000, metadata: { assetId: 'asset-base' } })]) });
    await run(r); expect(placed(r)).toEqual({ assetId: 'video_2', trackId: 'V2', timelineStart: 4, trimStart: 9.234, trimEnd: 10 });
  });
  it('the item deleted meanwhile → ITEM_NOT_FOUND, nothing placed', async () => {
    const r = rig({ sync: async doc => doc.set([]) });
    expect(await run(r)).toEqual({ success: false, code: 'ITEM_NOT_FOUND', error: "Target item 'base' was not found." }); expect(r.place).not.toHaveBeenCalled();
  });
  it('the item sped up meanwhile → INVALID_TOOL_INPUT (speed), nothing placed', async () => {
    const r = rig({ sync: async doc => doc.set([mkItem('base', 'V1', 2000, 7000, { trim: { from: 5000, to: 15000 }, playbackRate: 2, metadata: { assetId: 'asset-base' } })]) });
    expect(await run(r)).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: SWAP.speed('base') }); expect(r.place).not.toHaveBeenCalled();
  });
});

describe('T19 C10 syncAndSwap: sync failures (d)', () => {
  const LOW = 'Low sync confidence (31%). Transcripts may not overlap enough.';
  it('SYNC_LOW_CONFIDENCE keeps its code, its exact message and details.confidence; place is not called', async () => {
    const r = rig(); r.sync.mockRejectedValueOnce(new AnalysisError('SYNC_LOW_CONFIDENCE', LOW, { confidence: 0.31 }));
    expect(await run(r)).toEqual({ success: false, code: 'SYNC_LOW_CONFIDENCE', error: LOW, details: { confidence: 0.31 } }); expect(r.place).not.toHaveBeenCalled();
  });
  it('a plain error object with that code works the same (it crossed the worker boundary); no details → confidence 0', async () => {
    const r = rig(); r.sync.mockRejectedValueOnce({ code: 'SYNC_LOW_CONFIDENCE', message: LOW, details: { confidence: 0.31 } });
    expect(await run(r)).toEqual({ success: false, code: 'SYNC_LOW_CONFIDENCE', error: LOW, details: { confidence: 0.31 } });
    r.sync.mockRejectedValueOnce(new AnalysisError('SYNC_LOW_CONFIDENCE', 'Low sync confidence (0%). Transcripts may not overlap enough.'));
    expect(await run(r)).toMatchObject({ code: 'SYNC_LOW_CONFIDENCE', details: { confidence: 0 } });
  });
  it('another worker error: its code with "Sync failed." for an empty message', async () => {
    const r = rig(); r.sync.mockRejectedValueOnce({ code: 'ANALYSIS_WORKER_FAILED', message: '' });
    expect(await run(r)).toEqual({ success: false, code: 'ANALYSIS_WORKER_FAILED', error: 'Sync failed.' }); expect(r.place).not.toHaveBeenCalled();
    expect(SWAP.failed).toBe('Sync failed.');
  });
  it('a worker error keeps a non-empty message; one without a code → ANALYSIS_FAILED', async () => {
    const r = rig(); r.sync.mockRejectedValueOnce(new AnalysisError('ANALYSIS_UNAVAILABLE', 'Local analysis models are not installed.'));
    expect(await run(r)).toEqual({ success: false, code: 'ANALYSIS_UNAVAILABLE', error: 'Local analysis models are not installed.' });
    r.sync.mockRejectedValueOnce(new Error('boom'));
    expect(await run(r)).toEqual({ success: false, code: 'ANALYSIS_FAILED', error: 'boom' });
    r.sync.mockRejectedValueOnce(undefined);
    expect(await run(r)).toEqual({ success: false, code: 'ANALYSIS_FAILED', error: 'Sync failed.' }); expect(r.place).not.toHaveBeenCalled();
  });
  it('offset −30 (no footage in the window) → INVALID_TRIM_RANGE; so does a window beyond the source end', async () => {
    const r = rig({ offset: -30 });
    expect(await run(r)).toEqual({ success: false, code: 'INVALID_TRIM_RANGE', error: 'The source asset has no footage between 4s and 8s at the sync offset (-30s).' });
    const far = rig({ offset: 30 }); expect(await run(far)).toMatchObject({ success: false, code: 'INVALID_TRIM_RANGE' });
    expect(r.place).not.toHaveBeenCalled(); expect(far.place).not.toHaveBeenCalled();
  });
});

describe('T19 C10 syncAndSwap: refusals (e), place and syncOffset never called', () => {
  const refused = async (input: Rec, o: Rig = {}, from: Rec = INPUT) => {
    const r = rig(o), out = await (syncAndSwap(r.ctx, { ...from, ...input }) as Promise<Rec>);
    expect(r.place).not.toHaveBeenCalled(); expect(r.sync).not.toHaveBeenCalled(); return out;
  };
  it('no input and each of the five parameters missing / null / empty → MISSING_PARAM with the exact message', async () => {
    const r = rig(); expect(await syncAndSwap(r.ctx)).toEqual({ success: false, code: 'MISSING_PARAM', error: MESSAGE });
    expect(SWAP.required).toBe(MESSAGE);
    for (const key of Object.keys(INPUT)) for (const value of [undefined, null, '']) {
      if (typeof (INPUT as Rec)[key] === 'number' && value === '') continue;
      expect(await refused({ [key]: value }), `${key}=${String(value)}`).toEqual({ success: false, code: 'MISSING_PARAM', error: MESSAGE });
    }
  });
  it('from ≥ to, non-finite, from < 0 or a non-number → INVALID_TOOL_INPUT', async () => {
    for (const patch of [{ from: 5, to: 5 }, { from: 6, to: 5 }, { from: NaN }, { to: NaN }, { to: Infinity }, { from: -Infinity }, { from: -1 }, { from: '4' }, { to: '8' }, { from: true }])
      expect(await refused(patch), JSON.stringify(patch)).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: WINDOW });
  });
  it('target item missing → ITEM_NOT_FOUND "Target item \'<id>\' was not found."', async () => {
    expect(await refused({ targetItemId: 'nope' })).toEqual({ success: false, code: 'ITEM_NOT_FOUND', error: "Target item 'nope' was not found." });
  });
  it('target item without metadata.assetId (text) or with an unknown asset → SOURCE_ASSET_UNAVAILABLE "Target item \'<id>\' has no source asset."', async () => {
    expect(await refused({ targetItemId: 'txt' })).toEqual({ success: false, code: 'SOURCE_ASSET_UNAVAILABLE', error: "Target item 'txt' has no source asset." });
    const gone = [mkItem('base', 'V1', 2000, 12000, { trim: { from: 5000, to: 15000 }, metadata: { assetId: 'asset-nowhere' } })];
    expect(await refused({}, { items: gone })).toEqual({ success: false, code: 'SOURCE_ASSET_UNAVAILABLE', error: "Target item 'base' has no source asset." });
  });
  it('sourceAssetId that is a timeline item id → TIMELINE_ID_NOT_ALLOWED', async () => {
    expect(await refused({ sourceAssetId: 'txt' })).toEqual({ success: false, code: 'TIMELINE_ID_NOT_ALLOWED', error: "Expected asset ID (e.g., 'video_1') but received timeline ID 'txt'." });
    expect(await refused({ sourceAssetId: 'base' })).toMatchObject({ code: 'TIMELINE_ID_NOT_ALLOWED' });
  });
  it('unknown source asset → MEDIA_NOT_FOUND', async () => {
    const out = await refused({ sourceAssetId: 'video_9' });
    expect(out).toMatchObject({ success: false, code: 'MEDIA_NOT_FOUND' }); expect(out.error).toContain("Source asset 'video_9' was not found");
  });
  it('a transcript row missing, null or without words → TRANSCRIPT_UNAVAILABLE "<Source|Target> asset transcript too short for sync"', async () => {
    const S = { success: false, code: 'TRANSCRIPT_UNAVAILABLE', error: 'Source asset transcript too short for sync' }, T = { success: false, code: 'TRANSCRIPT_UNAVAILABLE', error: 'Target asset transcript too short for sync' };
    expect(await refused({}, { rows: { transcripts: { 'asset-base': row('asset-base', BASE_WORDS) } } })).toEqual(S);
    expect(await refused({}, { rows: { transcripts: { 'asset-src': row('asset-src', SRC_WORDS) } } })).toEqual(T);
    expect(await refused({}, { rows: { transcripts: { 'asset-src': row('asset-src', null), 'asset-base': row('asset-base', BASE_WORDS) } } })).toEqual(S);
    expect(await refused({}, { rows: { transcripts: { 'asset-src': row('asset-src', SRC_WORDS), 'asset-base': row('asset-base', []) } } })).toEqual(T);
    expect(await refused({}, { rows: { transcripts: { 'asset-src': { id: 'asset-src', transcript: { segments: [] } }, 'asset-base': row('asset-base', BASE_WORDS) } } })).toEqual(S);
    expect(await refused({}, { rows: {} })).toEqual(S);
  });
  it('processing_status processing / uploading with no words → TRANSCRIPT_UNAVAILABLE (the processing text)', async () => {
    for (const status of ['processing', 'uploading']) {
      const src = await refused({}, { assets: [asset('asset-base', 20000), asset('asset-src', 10000, { processing_status: status })], rows: { transcripts: { 'asset-base': row('asset-base', BASE_WORDS) } } });
      expect(src, status).toEqual({ success: false, code: 'TRANSCRIPT_UNAVAILABLE', error: SWAP.processing('video_2') });
      const base = await refused({}, { assets: [asset('asset-base', 20000, { processing_status: status }), asset('asset-src', 10000)], rows: { transcripts: { 'asset-src': row('asset-src', SRC_WORDS) } } });
      expect(base, status).toMatchObject({ success: false, code: 'TRANSCRIPT_UNAVAILABLE' }); expect(base.error).toContain('is still being processed');
    }
    expect(SWAP.processing('video_2')).toContain('is still being processed');
  });
  it('a processing asset that already has words syncs normally', async () => {
    const r = rig({ assets: [asset('asset-base', 20000), asset('asset-src', 10000, { processing_status: 'processing' })] });
    expect((await run(r)).success).toBe(true); expect(r.place).toHaveBeenCalledTimes(1);
  });
  it('processing_steps.transcription "unavailable" with no words → ANALYSIS_UNAVAILABLE (UNAVAILABLE.transcription)', async () => {
    const unavailable = { processing_steps: { transcription: 'unavailable' } };
    const expected = { success: false, code: 'ANALYSIS_UNAVAILABLE', error: UNAVAILABLE.transcription };
    expect(await refused({}, { assets: [asset('asset-base', 20000), asset('asset-src', 10000, unavailable)], rows: { transcripts: { 'asset-base': row('asset-base', BASE_WORDS) } } })).toEqual(expected);
    expect(await refused({}, { assets: [asset('asset-base', 20000, unavailable), asset('asset-src', 10000)], rows: { transcripts: { 'asset-src': row('asset-src', SRC_WORDS) } } })).toEqual(expected);
  });
});

describe('T19 C10 syncAndSwap: speed refusals ask the offset first, then refuse', () => {
  it('playbackRate ≠ 1 or time-remap keyframes → INVALID_TOOL_INPUT with the speed text, nothing placed', async () => {
    const kf = (time: number, value: number) => ({ time, value, easing: 'linear' });
    const meta = { trim: { from: 5000, to: 15000 }, metadata: { assetId: 'asset-base' } };
    for (const extra of [{ playbackRate: 2 }, { playbackRate: 0.5 }, { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(10000, 10000)] } }]) {
      const r = rig({ items: [mkItem('base', 'V1', 2000, 12000, { ...meta, ...extra })] });
      expect(await run(r), JSON.stringify(extra)).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: SWAP.speed('base') });
      expect(r.place).not.toHaveBeenCalled();
    }
    expect(SWAP.speed('base')).toContain("Target item 'base'");
  });
  it('a time-remap with empty keyframes is not a remap', async () => {
    const r = rig({ items: [mkItem('base', 'V1', 2000, 12000, { trim: { from: 5000, to: 15000 }, metadata: { assetId: 'asset-base' }, timeRemap: { defaultValue: 0, keyframes: [] } })] });
    expect((await run(r)).success).toBe(true);
  });
});

// ---- Executor (real runtime).
const fakeStorage = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
let seq = 0;
const call = (toolName: string, input: Record<string, unknown> = {}, extra: Partial<Call> = {}): Call => ({ type: 'call', callId: `c${++seq}`, executionKey: `mcp:conn:c${seq}`, toolName, input, ...extra });
const EXEC_INPUT = { sourceAssetId: 'video_2', targetItemId: 'v1', trackId: 'V2', from: 0, to: 4 };

function exec(offset = 1) {
  const rows: Rec = { transcripts: { 'asset-vid1': row('asset-vid1', BASE_WORDS), 'asset-vid2': row('asset-vid2', SRC_WORDS) } };
  const service = { syncOffset: vi.fn(async (..._a: unknown[]) => ({ offset, confidence: 0.8, matches: [{}, {}, {}, {}] })) };
  const deps = { store: { row: async (s: string, id: string) => rows[s]?.[id] }, service };
  const analysis = vi.fn(async () => deps);
  const editor = createEditor(fixture(), { assets: fixtureAssets(), links: links() });
  const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }), analysis: analysis as never });
  return { editor, ex, service, analysis };
}
const itemsOn = (editor: ReturnType<typeof exec>['editor'], trackId: string) => editor.runtime.bus.doc.items.filter(i => i.trackId === trackId);

describe('T19 C10 executor syncAndSwap', () => {
  it('success: one item on the given track from the synced trim; one undo entry "Add media"; data.addedItemIds, timelineChanges and the sync fields', async () => {
    const { editor, ex } = exec();
    const r = await ex.execute(call('syncAndSwap', EXEC_INPUT, { session: 's' })) as Rec;
    expect(r).toMatchObject({ success: true, syncOffset: 1, syncConfidence: 0.8, syncMatches: 4 });
    expect(r.data.addedItemIds).toHaveLength(1); expect(r.timelineChanges).toBeDefined();
    const added = itemsOn(editor, 'V2'); expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: r.data.addedItemIds[0], display: { from: 0, to: 4000 }, trim: { from: 1000, to: 5000 }, metadata: { assetId: 'asset-vid2' } });
    expect(editor.runtime.bus.undoStack).toHaveLength(1); expect(editor.runtime.bus.undoStack[0]).toMatchObject({ label: 'Add media', source: 'agent' });
    editor.runtime.bus.undo(); expect(itemsOn(editor, 'V2')).toHaveLength(0);
  });
  it('not gated: it works without a prior context read (a gated tool is refused in the same state)', async () => {
    const { ex } = exec();
    expect(await ex.execute(call('moveItem', { itemId: 'v3', by: 1 }, { session: 's' }))).toMatchObject({ code: 'STALE_READ_REFRESHED' });
    expect(await ex.execute(call('syncAndSwap', EXEC_INPUT, { session: 'fresh' }))).toMatchObject({ success: true });
  });
  it('the same executionKey twice → the stored result, one item, one sync', async () => {
    const { editor, ex, service } = exec();
    const key = { executionKey: 'mcp:conn:same', session: 's' };
    const first = await ex.execute(call('syncAndSwap', EXEC_INPUT, key)), second = await ex.execute(call('syncAndSwap', EXEC_INPUT, key));
    expect(second).toEqual(first); expect(itemsOn(editor, 'V2')).toHaveLength(1); expect(service.syncOffset).toHaveBeenCalledTimes(1); expect(editor.runtime.bus.undoStack).toHaveLength(1);
  });
  it('the offset moves the trim: −1 s → timelineStart 1, trim 0–3 (no footage before the source start)', async () => {
    const { editor, ex } = exec(-1);
    expect(await ex.execute(call('syncAndSwap', EXEC_INPUT, { session: 's' }))).toMatchObject({ success: true, syncOffset: -1 });
    expect(itemsOn(editor, 'V2')[0]).toMatchObject({ display: { from: 1000, to: 4000 }, trim: { from: 0, to: 3000 } });
  });
  it('addMedia failures pass through and change nothing: locked track, overlap, wrong track kind', async () => {
    const lockedRig = exec();
    lockedRig.editor.runtime.bus.run('Change speed' as never, 'user', doc => { doc.tracks.find(t => t.id === 'V2')!.locked = true; });
    const undoBefore = lockedRig.editor.runtime.bus.undoStack.length;
    expect(await lockedRig.ex.execute(call('syncAndSwap', EXEC_INPUT, { session: 's' }))).toMatchObject({ success: false, code: 'TRACK_LOCKED' });
    expect(itemsOn(lockedRig.editor, 'V2')).toHaveLength(0); expect(lockedRig.editor.runtime.bus.undoStack).toHaveLength(undoBefore);

    const overlap = exec(), before = overlap.editor.runtime.bus.doc.items.length;
    expect(await overlap.ex.execute(call('syncAndSwap', { ...EXEC_INPUT, trackId: 'V1' }, { session: 's' }))).toMatchObject({ success: false, code: 'OVERLAP_DETECTED' });
    expect(overlap.editor.runtime.bus.doc.items).toHaveLength(before); expect(overlap.editor.runtime.bus.undoStack).toHaveLength(0);

    const kind = exec();
    expect(await kind.ex.execute(call('syncAndSwap', { ...EXEC_INPUT, trackId: 'A1' }, { session: 's' }))).toMatchObject({ success: false, code: 'INVALID_TRACK' });
    expect(kind.editor.runtime.bus.doc.items).toHaveLength(before); expect(kind.editor.runtime.bus.undoStack).toHaveLength(0);
  });
  it('refusals come back as failure results without touching the timeline (low confidence, bad input, unknown target)', async () => {
    const { editor, ex, service } = exec();
    service.syncOffset.mockRejectedValueOnce(new AnalysisError('SYNC_LOW_CONFIDENCE', 'Low sync confidence (31%). Transcripts may not overlap enough.', { confidence: 0.31 }));
    expect(await ex.execute(call('syncAndSwap', EXEC_INPUT, { session: 's' }))).toEqual({ success: false, code: 'SYNC_LOW_CONFIDENCE', error: 'Low sync confidence (31%). Transcripts may not overlap enough.', details: { confidence: 0.31 } });
    expect(await ex.execute(call('syncAndSwap', { ...EXEC_INPUT, to: undefined }, { session: 's' }))).toMatchObject({ code: 'MISSING_PARAM', error: MESSAGE });
    expect(await ex.execute(call('syncAndSwap', { ...EXEC_INPUT, targetItemId: 'nope' }, { session: 's' }))).toMatchObject({ code: 'ITEM_NOT_FOUND' });
    expect(itemsOn(editor, 'V2')).toHaveLength(0); expect(editor.runtime.bus.undoStack).toHaveLength(0);
  });
  it('no project → PROJECT_UNAVAILABLE, and the analysis dependency is not loaded', async () => {
    const analysis = vi.fn(async () => ({}));
    const ex = new Executor({ storage: fakeStorage(), current: () => undefined, analysis: analysis as never });
    expect(await ex.execute(call('syncAndSwap', EXEC_INPUT, { session: 's' }))).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'No project is open in the connected editor tab. Open a project, then retry.' });
    expect(analysis).not.toHaveBeenCalled();
  });
  it('an analysis dependency that rejects → a failure envelope with its code and message', async () => {
    const editor = createEditor(fixture(), { assets: fixtureAssets(), links: links() });
    const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, analysis: (async () => { throw Object.assign(new Error('models gone'), { code: 'ANALYSIS_UNAVAILABLE' }); }) as never });
    expect(await ex.execute(call('syncAndSwap', EXEC_INPUT, { session: 's' }))).toEqual({ success: false, code: 'ANALYSIS_UNAVAILABLE', error: 'models gone' });
  });
  it('the project closed while the offset was computed → the placement is refused (PROJECT_UNAVAILABLE), nothing added', async () => {
    const editor = createEditor(fixture(), { assets: fixtureAssets(), links: links() });
    let open = true;
    const rows: Rec = { transcripts: { 'asset-vid1': row('asset-vid1', BASE_WORDS), 'asset-vid2': row('asset-vid2', SRC_WORDS) } };
    const service = { syncOffset: async () => { open = false; return { offset: 1, confidence: 0.8, matches: [{}, {}, {}] }; } };
    const ex = new Executor({ storage: fakeStorage(), current: () => (open ? editor.runtime : undefined),
      analysis: (async () => ({ store: { row: async (s: string, id: string) => rows[s]?.[id] }, service })) as never });
    expect(await ex.execute(call('syncAndSwap', EXEC_INPUT, { session: 's' }))).toMatchObject({ success: false, code: 'PROJECT_UNAVAILABLE' });
    expect(editor.runtime.bus.doc.items.filter(i => i.trackId === 'V2')).toHaveLength(0);
  });
});

// ---- Real sync.ts on the public aligned words of the 30 s action clip.
describe('T19 C10 engine syncOffset (public OT-2 words, no models)', () => {
  const root = process.env.CUTFRAME_FIXTURES, file = root ? path.join(root, 'datasets', 'speech', 'tos-action-30s-aligned.json') : '';
  const transcript = (words: { word: string; start: number; end: number }[]): Transcript =>
    ({ language: 'en', languages: ['en'], total_duration: words.at(-1)?.end ?? 0, segments: [{ id: 0, start: words[0].start, end: words.at(-1)!.end, text: words.map(w => w.word).join(' '), speaker: 0, words }] });
  const load = () => (JSON.parse(readFileSync(file, 'utf8')).words as { text: string; startMs: number; endMs: number }[]).map(w => ({ word: w.text, start: w.startMs / 1000, end: w.endMs / 1000 }));
  it.skipIf(!root || !existsSync(file))('the same words shifted by +1.234 s with every 7th word dropped → offset −1.234 ± 1/24 s, confidence ≥ 0.5', () => {
    const original = load(), shifted = original.filter((_, i) => (i + 1) % 7 !== 0).map(w => ({ ...w, start: w.start + 1.234, end: w.end + 1.234 }));
    const result = syncOffset(transcript(original), transcript(shifted));
    console.log(`[T19 C10] ${original.length} words; offset ${result.offset.toFixed(3)} (expected -1.234), confidence ${result.confidence.toFixed(3)}, matches ${result.matches.length}`);
    expect(Math.abs(result.offset + 1.234)).toBeLessThanOrEqual(1 / 24); expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });
  it.skipIf(!root || !existsSync(file))('reversed word order against the original → SYNC_LOW_CONFIDENCE', () => {
    const original = load(), texts = original.map(w => w.word).reverse(), reversed = original.map((w, i) => ({ ...w, word: texts[i] }));
    let error: unknown; try { syncOffset(transcript(original), transcript(reversed)); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(AnalysisError); expect(error).toMatchObject({ code: 'SYNC_LOW_CONFIDENCE' });
    expect((error as AnalysisError).message).toMatch(/^Low sync confidence \(\d+%\)\. Transcripts may not overlap enough\.$/);
  });
});

// ---- Audit F1: real sync.ts on 3,000 synthetic words. syncOffset is synchronous and testTimeout cannot stop it, so every call
// runs in a worker (sync.ts bundled by esbuild) that is terminated at a hard cap. Ladder 125 → 2,000 words (stop after the first
// call > 10 s or killed at 20 s), growth exponent from the last two finished calls, then 3,000 words killed at 120 s.
describe('T19 audit F1 engine syncOffset at 3,000 words (measurement; time printed, not asserted)', () => {
  const SHIFT = 1.234, FRAME = 1 / 24; // MC-P01 ±1 frame = 1/24 s (T19a notes l.183, l.1478; this file l.341)
  type Run = { n: number; ms: number; killed: boolean; offset?: number; confidence?: number; matches?: number; error?: string };
  /** Seeded (mulberry32) words from a 200-word vocabulary, one per 0.4 s; the source is the same words SHIFT s later → offset +SHIFT. */
  const pair = (n: number) => {
    let s = 0x7e19f1;
    const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const words = Array.from({ length: n }, (_, k) => ({ word: `w${Math.floor(rand() * 200)}`, start: k * 0.4, end: k * 0.4 + 0.3 }));
    const doc = (ws: typeof words): Transcript => ({ language: 'en', languages: ['en'], total_duration: ws.at(-1)!.end, segments: [{ id: 0, start: ws[0].start, end: ws.at(-1)!.end, text: ws.map(w => w.word).join(' '), speaker: 0, words: ws }] });
    return { source: doc(words.map(w => ({ ...w, start: w.start + SHIFT, end: w.end + SHIFT }))), target: doc(words) };
  };
  const WORKER = `import { parentPort, workerData } from 'node:worker_threads'; import { syncOffset } from './sync';
const t0 = performance.now();
try { const r = syncOffset(workerData.source, workerData.target); parentPort.postMessage({ ms: performance.now() - t0, offset: r.offset, confidence: r.confidence, matches: r.matches.length }); }
catch (e: any) { parentPort.postMessage({ ms: performance.now() - t0, error: String(e?.code ?? e) }); }`;
  /** ms is measured inside the worker around syncOffset only; the cap runs from the spawn. */
  const timed = (code: string, n: number, capMs: number) => new Promise<Run>((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: pair(n) });
    const kill = setTimeout(() => { void worker.terminate(); resolve({ n, ms: capMs, killed: true }); }, capMs);
    worker.once('message', m => { clearTimeout(kill); void worker.terminate(); resolve({ n, killed: false, ...m }); });
    worker.once('error', e => { clearTimeout(kill); reject(e); });
  });
  const line = (r: Run, capMs: number) => console.log(`[T19 F1] n=${r.n} words: ${r.killed ? `> ${capMs} ms (killed)` : `${r.ms.toFixed(1)} ms`}; offset ${r.offset?.toFixed(6) ?? '-'} (expected ${SHIFT}), confidence ${r.confidence?.toFixed(3) ?? '-'}, matches ${r.matches ?? '-'}${r.error ? `, error ${r.error}` : ''}`);
  const check = (r: Run) => { if (r.killed) return; expect(r.error).toBeUndefined(); expect(Math.abs(r.offset! - SHIFT)).toBeLessThanOrEqual(FRAME); expect(r.confidence).toBeGreaterThanOrEqual(0.5); };
  it('3,000 words, 200-word vocabulary, source = target + 1.234 s → offset +1.234 ± 1/24 s on every call that finishes; a killed call prints "> cap" and passes', async () => {
    const code = (await bundle({ stdin: { contents: WORKER, resolveDir: path.resolve('apps/web/src/analysis'), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false })).outputFiles[0].text;
    const done: Run[] = [];
    for (const n of [125, 250, 500, 1000, 2000]) {
      const r = await timed(code, n, 20_000); line(r, 20_000); check(r);
      if (r.killed) break; done.push(r); if (r.ms > 10_000) break;
    }
    if (done.length >= 2) { const [p, q] = done.slice(-2), k = Math.log(q.ms / p.ms) / Math.log(q.n / p.n); console.log(`[T19 F1] growth exponent ${k.toFixed(2)} (n ${p.n} → ${q.n}); extrapolated n=3000: ${Math.round(q.ms * (3000 / q.n) ** k / 1000)} s`); }
    const full = await timed(code, 3000, 120_000); line(full, 120_000); check(full);
  }, 240_000);
});

// ---- Audit F1 fix, red-first (landed-audit-t19 l.37-46, l.126; lane A ruling 19 Nov 03:56). BAR: 3,000 words → 1.234 ± 1/24 s
// within 2 s, timed inside the worker (red on a404e27: killed at 10 s). IDENTITY: the bound changes no result: sha256 of the
// whole result (plus offset, confidence, matches in clear) against goldens captured on a404e27 from the `[T19 F1 golden]`
// lines (placeholders until then, so red). DEADLINE: syncAndSwap's sync gets 30 s (Cutframe addition, below the helper's
// 60 s TOOL_TIMEOUT). The measurement describe above stays as run; seededPair and SYNC_WORKER repeat its pair and worker,
// posting the whole result and its sha.
const F1_SHIFT = 1.234, F1_FRAME = 1 / 24; // MC-P01 ±1 frame (T19a notes l.183)
type Golden = { sha: string; offset: number; confidence: number; matches: number };
/** Not captured yet: fails every comparison until the a404e27 value is filled in. */
const UNCAPTURED: Golden = { sha: 'capture on a404e27', offset: NaN, confidence: NaN, matches: -1 };
const GOLDEN: Record<'pair-125' | 'pair-250' | 'pair-500' | 'fixture-shifted' | 'tie-1-equal-distance' | 'tie-2-next-target' | 'tie-3-boundary' | 'tie-4-candidate-order' | 'tie-5-duplicate-anchors', Golden> = {
  'pair-125': { sha: 'd0bc8ec3c05318fc42c836b30068121aafa8896a6c9ceccbc2f7a5cc498d19ee', offset: 1.2340000000000018, confidence: 1, matches: 125 },
  'pair-250': { sha: '45fb93e59c8d4500e07b2cd4585022298ee816e0d5a9f6e0fbf3aef6ba586827', offset: 1.234, confidence: 0.9999999999999911, matches: 250 },
  'pair-500': { sha: '07661a0de3ea8c297ad6f3fc14e0994635d012372bbf496796c8b40d97e2c0ed', offset: 1.2340000000000018, confidence: 0.9999999999999645, matches: 500 },
  'fixture-shifted': { sha: '7bf1eb9075d2878f318aba319842402a350ca8a4ba9a09ebf5eda958bd10b3a6', offset: -1.234, confidence: 0.9999999999999911, matches: 32 },
  'tie-1-equal-distance': { sha: '2a308c33b6ce6547c28773e96f4b39a5b4eb632466935941e17944c40cac7bfb', offset: 0, confidence: 1, matches: 4 },
  'tie-2-next-target': { sha: '78066d8c150de13b8cbb00e9996ad88299a54de3d3c289dca87f3b166fc7a79b', offset: 0, confidence: 1, matches: 5 },
  'tie-3-boundary': { sha: 'bdf5a25def90e555bcd0f51e5ed78e5c5ee7f3379a4547ec333eaa6b06904a4b', offset: 0, confidence: 0.7142857142857143, matches: 5 },
  'tie-4-candidate-order': { sha: '2eb39cc0661d42cdb7929d61a39ef6503afde20efc4a16241e9a3c1473b4a048', offset: 0.5, confidence: 0.5, matches: 3 },
  'tie-5-duplicate-anchors': { sha: 'e3524484473e6406415fbf1ce6c52ed5baf8867bc5e828c2c84bad9ae9229f15', offset: 0.5, confidence: 1, matches: 6 },
};
const REVERSED_GOLDEN = { sha: '1c5b6b7b307b1a90a61121aed9ea5158b1ba95e2850969543ce09ca2c2ffb6ed', code: 'SYNC_LOW_CONFIDENCE', message: 'Low sync confidence (0%). Transcripts may not overlap enough.', confidence: 0 };
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const golden = (name: string, result: SyncResult, sha = sha256(result), extra = ''): Golden => {
  console.log(`[T19 F1 golden] ${name} ${sha} ${result.offset} ${result.confidence} ${result.matches.length}${extra && ` ${extra}`}`);
  return { sha, offset: result.offset, confidence: result.confidence, matches: result.matches.length };
};
/** The measurement's pair(n): seeded (mulberry32) words from a 200-word vocabulary, one per 0.4 s; source = target + 1.234 s. */
function seededPair(n: number) {
  let s = 0x7e19f1;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const words = Array.from({ length: n }, (_, k) => ({ word: `w${Math.floor(rand() * 200)}`, start: k * 0.4, end: k * 0.4 + 0.3 }));
  const doc = (ws: typeof words): Transcript => ({ language: 'en', languages: ['en'], total_duration: ws.at(-1)!.end, segments: [{ id: 0, start: ws[0].start, end: ws.at(-1)!.end, text: ws.map(w => w.word).join(' '), speaker: 0, words: ws }] });
  return { source: doc(words.map(w => ({ ...w, start: w.start + F1_SHIFT, end: w.end + F1_SHIFT }))), target: doc(words) };
}
const SYNC_WORKER = `import { createHash } from 'node:crypto'; import { parentPort, workerData } from 'node:worker_threads'; import { syncOffset } from './sync';
const t0 = performance.now();
try { const result = syncOffset(workerData.source, workerData.target), ms = performance.now() - t0; parentPort.postMessage({ ms, result, sha: createHash('sha256').update(JSON.stringify(result)).digest('hex') }); }
catch (e: any) { parentPort.postMessage({ ms: performance.now() - t0, error: String(e?.code ?? e) }); }`;
let syncWorkerCode: Promise<string> | undefined;
type Synced = { ms: number; killed: boolean; result?: SyncResult; sha?: string; error?: string };
/** syncOffset on seededPair(n) in a worker terminated at capMs (from the spawn); ms is timed inside the worker around syncOffset. */
async function synced(n: number, capMs: number): Promise<Synced> {
  const code = await (syncWorkerCode ??= bundle({ stdin: { contents: SYNC_WORKER, resolveDir: path.resolve('apps/web/src/analysis'), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false }).then(b => b.outputFiles[0].text));
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: seededPair(n) });
    const kill = setTimeout(() => { void worker.terminate(); resolve({ ms: capMs, killed: true }); }, capMs);
    worker.once('message', (m: Omit<Synced, 'killed'>) => { clearTimeout(kill); void worker.terminate(); resolve({ ...m, killed: false }); });
    worker.once('error', e => { clearTimeout(kill); reject(e); });
  });
}

describe('T19 audit F1 fix: the bar (3,000 words within 2 s, in a worker killed at 10 s)', () => {
  it('3,000 words, 200-word vocabulary, source = target + 1.234 s → offset 1.234 ± 1/24 s, confidence ≥ 0.5, syncOffset ≤ 2,000 ms', async () => {
    const r = await synced(3000, 10_000);
    console.log(`[T19 F1 bar] n=3000 words: ${r.killed ? '> 10000 ms (killed)' : `${r.ms.toFixed(1)} ms`}; offset ${r.result?.offset.toFixed(6) ?? '-'}, confidence ${r.result?.confidence.toFixed(3) ?? '-'}${r.error ? `, error ${r.error}` : ''}`);
    expect(r.killed, 'syncOffset did not return within the 10 s cap').toBe(false);
    expect(r.error).toBeUndefined(); expect(r.ms).toBeLessThanOrEqual(2000);
    expect(Math.abs(r.result!.offset - F1_SHIFT)).toBeLessThanOrEqual(F1_FRAME); expect(r.result!.confidence).toBeGreaterThanOrEqual(0.5);
  }, 30_000);
});

describe('T19 audit F1 fix: identity (whole results unchanged from a404e27)', () => {
  for (const n of [125, 250, 500] as const) it(`seededPair(${n}) in the worker (killed at 30 s) → the a404e27 result, every field`, async () => {
    const r = await synced(n, 30_000);
    expect(r.killed, `n=${n} did not return within the 30 s cap`).toBe(false); expect(r.error).toBeUndefined();
    expect(golden(`pair-${n}`, r.result!, r.sha)).toEqual(GOLDEN[`pair-${n}`]);
  }, 45_000);
  const root = process.env.CUTFRAME_FIXTURES, file = root ? path.join(root, 'datasets', 'speech', 'tos-action-30s-aligned.json') : '';
  const transcript = (words: { word: string; start: number; end: number }[]): Transcript =>
    ({ language: 'en', languages: ['en'], total_duration: words.at(-1)?.end ?? 0, segments: [{ id: 0, start: words[0].start, end: words.at(-1)!.end, text: words.map(w => w.word).join(' '), speaker: 0, words }] });
  const load = () => (JSON.parse(readFileSync(file, 'utf8')).words as { text: string; startMs: number; endMs: number }[]).map(w => ({ word: w.text, start: w.startMs / 1000, end: w.endMs / 1000 }));
  it.skipIf(!root || !existsSync(file))('public OT-2 words shifted +1.234 s, every 7th dropped (the engine case above) → the a404e27 result, every field', () => {
    const original = load(), shifted = original.filter((_, i) => (i + 1) % 7 !== 0).map(w => ({ ...w, start: w.start + 1.234, end: w.end + 1.234 }));
    expect(golden('fixture-shifted', syncOffset(transcript(original), transcript(shifted)))).toEqual(GOLDEN['fixture-shifted']);
  });
  it.skipIf(!root || !existsSync(file))('reversed word order (the engine case above) → the a404e27 error: code, exact message and details', () => {
    const original = load(), texts = original.map(w => w.word).reverse(), reversed = original.map((w, i) => ({ ...w, word: texts[i] }));
    let error: unknown; try { syncOffset(transcript(original), transcript(reversed)); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(AnalysisError);
    const { code, message, details } = error as AnalysisError, sha = sha256({ code, message, details });
    console.log(`[T19 F1 golden] fixture-reversed ${sha} - ${details?.confidence} - ${message}`);
    expect({ sha, code, message, confidence: details?.confidence }).toEqual(REVERSED_GOLDEN);
  });

  // -- Tie and boundary rules (coordinator 04:0x, from lane A 03:56): strict < on distance (the first j wins), j ≥ nextTarget,
  // best by confidence then matches. seededPair never reaches them (0.4 s apart: one j per 0.2 s window). Hand-built, main
  // thread; times are binary fractions unless the case is about decimals. Picks that follow from sync.ts are asserted too.
  const tx = (words: [string, number][]): Transcript => ({ language: 'en', languages: ['en'], total_duration: words.at(-1)![1] + 0.3,
    segments: [{ id: 0, start: words[0][1], end: words.at(-1)![1] + 0.3, text: words.map(w => w[0]).join(' '), speaker: 0, words: words.map(([word, start]) => ({ word, start, end: start + 0.3 })) }] });
  it('1. equal distance: the target has x at 2.875 and 3.125 around the source x at 3 (offset 0) → the first j (2.875) wins', () => {
    const result = syncOffset(tx([['p', 0], ['q', 1], ['r', 2], ['x', 3]]), tx([['p', 0], ['q', 1], ['r', 2], ['x', 2.875], ['x', 3.125]]));
    expect(result.matches[3]).toEqual({ sourceIndex: 3, targetIndex: 3, sourceTime: 3, targetTime: 2.875 });
    expect(golden('tie-1-equal-distance', result)).toEqual(GOLDEN['tie-1-equal-distance']);
  });
  it('2. nextTarget: source y at 3 takes target y 3.125; source y at 3.25 skips that closer one (passed) for y 3.4375 (d .1875)', () => {
    const result = syncOffset(tx([['p', 0], ['q', 1], ['r', 2], ['y', 3], ['y', 3.25]]), tx([['p', 0], ['q', 1], ['r', 2], ['y', 3.125], ['y', 3.4375]]));
    expect(result.matches.map(m => m.targetIndex)).toEqual([0, 1, 2, 3, 4]); expect(result.matches[4]).toMatchObject({ sourceTime: 3.25, targetTime: 3.4375 });
    expect(golden('tie-2-next-target', result)).toEqual(GOLDEN['tie-2-next-target']);
  });
  it('3. the 0.2 s window in floating point (offset 0): z 0.2 − 0 = 0.2 exactly (excluded); v 2.3 − 2.1 and u 3.2 − 3.0 land on the side d < 0.2 says', () => {
    const A: [string, number][] = [['z', 0.2], ['p', 1], ['q', 1.5], ['v', 2.3], ['r', 2.5], ['s', 2.75], ['u', 3.2]];
    const B: [string, number][] = [['z', 0], ['p', 1], ['q', 1.5], ['v', 2.1], ['r', 2.5], ['s', 2.75], ['u', 3.0]];
    const result = syncOffset(tx(A), tx(B)), d = (i: number) => Math.abs(A[i][1] - B[i][1] - 0); // sync.ts:22 with the candidate offset 0
    expect(d(0)).toBe(0.2);
    for (const i of [0, 3, 6]) expect(result.matches.some(m => m.sourceIndex === i), `${A[i][0]}: d ${d(i)}`).toBe(d(i) < 0.2);
    expect(result.matches.map(m => m.sourceIndex).filter(i => ![0, 3, 6].includes(i))).toEqual([1, 2, 4, 5]);
    expect(golden('tie-3-boundary', result, undefined, `d z=${d(0)} v=${d(3)} u=${d(6)}`)).toEqual(GOLDEN['tie-3-boundary']);
  });
  it('4. candidate order: anchors p q r (offset +0.5) and k l m (offset −0.5) both give 3 matches, confidence 0.5 → the first found (+0.5) stays best', () => {
    const result = syncOffset(tx([['p', 10], ['q', 11], ['r', 12], ['k', 13], ['l', 14], ['m', 15]]), tx([['p', 9.5], ['q', 10.5], ['r', 11.5], ['k', 13.5], ['l', 14.5], ['m', 15.5]]));
    expect(result.offset).toBe(0.5); expect(result.confidence).toBe(0.5); expect(result.matches.map(m => m.sourceIndex)).toEqual([0, 1, 2]);
    expect(golden('tie-4-candidate-order', result)).toEqual(GOLDEN['tie-4-candidate-order']);
  });
  it('5. duplicate anchors: p q r twice → four candidates share offset 0.5 exactly (others −2.5, 3.5: 3 matches each) → all 6 words at 0.5', () => {
    const result = syncOffset(tx([['p', 1], ['q', 2], ['r', 3], ['p', 4], ['q', 5], ['r', 6]]), tx([['p', 0.5], ['q', 1.5], ['r', 2.5], ['p', 3.5], ['q', 4.5], ['r', 5.5]]));
    expect(result.offset).toBe(0.5); expect(result.confidence).toBe(1); expect(result.matches.map(m => [m.sourceIndex, m.targetIndex])).toEqual([0, 1, 2, 3, 4, 5].map(i => [i, i]));
    expect(golden('tie-5-duplicate-anchors', result)).toEqual(GOLDEN['tie-5-duplicate-anchors']);
  });
});

describe('T19 audit F1 fix: syncAndSwap sync deadline 30 s (Cutframe addition; lane A 03:56)', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('a sync that never settles: pending at 29,999 ms; at 30,000 ms TOOL_TIMEOUT "Sync failed.", operationMayHaveRun false, details.deadlineMs; its signal aborted; nothing placed', async () => {
    vi.useFakeTimers();
    const r = rig(); r.sync.mockImplementation(() => new Promise<never>(() => {}));
    let out: Rec | undefined; void run(r).then(v => { out = v; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(r.sync).toHaveBeenCalledTimes(1); expect(out).toBeUndefined(); expect(r.place).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual({ success: false, code: 'TOOL_TIMEOUT', error: 'Sync failed.', operationMayHaveRun: false, details: { deadlineMs: 30000 } });
    expect(r.place).not.toHaveBeenCalled();
    const signal = r.sync.mock.calls[0][2]; // the 3rd syncOffset argument is the fix's (a404e27 passes two)
    expect(signal).toBeInstanceOf(AbortSignal); expect((signal as AbortSignal).aborted).toBe(true);
  });
  it('a sync that settles first clears its timer: no pending timer after the result', async () => {
    vi.useFakeTimers();
    const r = rig(); expect(await run(r)).toMatchObject({ success: true, syncOffset: 1.234 });
    expect(vi.getTimerCount()).toBe(0);
  });
  // A search or ingest request pending on the dropped worker is re-run once: t19-r-service.test.ts R1d (not repeated here).
  it('AnalysisService.syncOffset(source, target, signal): abort closes the worker with ANALYSIS_CANCELLED, rejects with signal.reason; the next request spawns a fresh worker', async () => {
    type Fake = { requests: AnalysisRequest[]; closes: unknown[] };
    const workers: Fake[] = [];
    const spawn = () => {
      const pending = new Set<(e: unknown) => void>(), w: Fake = { requests: [], closes: [] };
      workers.push(w);
      return { ...w, init: () => Promise.resolve({ value: undefined }), run: (request: AnalysisRequest) => { w.requests.push(request); return new Promise((_, reject) => { pending.add(reject); }); },
        close: (e: unknown) => { w.closes.push(e); for (const reject of pending) reject(e); pending.clear(); } };
    };
    // The signal parameter is the fix's; a404e27's syncOffset takes two (one cast).
    const svc = new AnalysisService('/models/', spawn as never) as unknown as { syncOffset(s: Transcript, t: Transcript, signal?: AbortSignal): Promise<SyncResult> };
    const words = SRC_WORDS.map(w => ({ ...w })), doc: Transcript = { language: 'en', languages: ['en'], total_duration: 3.3, segments: [{ id: 0, start: 1, end: 3.3, text: 'sa sb sc', speaker: 0, words }] };
    const c = new AbortController(), first = svc.syncOffset(doc, doc, c.signal), settled = first.then(() => 'resolved', (e: unknown) => e);
    await vi.waitFor(() => expect(workers[0]?.requests.map(q => q.task)).toEqual(['sync']));
    c.abort();
    expect(workers[0].closes).toHaveLength(1); expect(workers[0].closes[0]).toMatchObject({ code: 'ANALYSIS_CANCELLED', message: 'Analysis was cancelled.' });
    expect(await settled).toBe(c.signal.reason);
    void svc.syncOffset(doc, doc).catch(() => {});
    expect(workers).toHaveLength(2);
    await vi.waitFor(() => expect(workers[1].requests.map(q => q.task)).toEqual(['sync']));
  });
});
