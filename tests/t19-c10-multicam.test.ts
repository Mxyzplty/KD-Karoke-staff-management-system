// SPDX-License-Identifier: AGPL-3.0-only
// T19 C10 (MC-P01): syncAndSwap (analysis/multicam.ts) over a fake service and a fake place; the executor route (real T03 runtime,
// injected store/service); and the real sync.ts syncOffset on the public aligned words of the 30 s action clip when
// $CUTFRAME_FIXTURES has them. Synthetic words otherwise; no fitting.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { UNAVAILABLE } from '../apps/web/src/analysis/availability';
import { SWAP, syncAndSwap } from '../apps/web/src/analysis/multicam';
import type { SwapContext } from '../apps/web/src/analysis/multicam';
import { syncOffset } from '../apps/web/src/analysis/sync';
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
