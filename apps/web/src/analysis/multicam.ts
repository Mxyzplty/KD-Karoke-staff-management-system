// SPDX-License-Identifier: AGPL-3.0-only
// T19 C10 (MC-P01): syncAndSwap (agent tool results §2 syncAndSwap; findings §17). The offset comes from the two assets'
// stored transcripts (sync.ts, in the worker): second-camera source time − base source time. Below 0.5 confidence it
// refuses with SYNC_LOW_CONFIDENCE and places nothing. The placement is addMedia's (one command, its failures). Cutframe
// places through the base item's position and trim and keeps the part with footage in sync (results header, improvement
// 3); `xapp` keeps Xapp's placement (timelineStart = from, trim = [max(0, from + offset), to + offset]).
import { currentAsset, importTranscript } from './read';
import type { AnalysisService, TranscriptRow } from './service';
import { UNAVAILABLE } from './availability';
import { wordsOf } from './types';
import type { Transcript } from './types';
import type { ProjectStore } from '../store/database';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { item as itemOf } from '../timeline/model';
import { rateOf, remapKeyframes } from '../timeline/properties';

type Result = { success: boolean; [k: string]: unknown };
export type SwapContext = {
  /** The current document (read again after the offset is known). */
  doc: () => ProjectDocument;
  /** By agent id or stored id (Runtime.assets). */
  asset: (id: string) => Asset | undefined;
  store: Pick<ProjectStore, 'row'>;
  service: Pick<AnalysisService, 'syncOffset'>;
  /** addMedia as one synchronous agent command (Runtime.call). */
  place: (args: RecordData) => Result;
  xapp?: boolean;
};
/** Xapp's code-less messages (Cutframe adds the codes); the rest is Cutframe wording. */
export const SWAP = {
  required: 'sourceAssetId, targetItemId, trackId, from, and to are all required.',
  noTarget: (id: string) => `Target item '${id}' was not found.`,
  noTargetAsset: (id: string) => `Target item '${id}' has no source asset.`,
  failed: 'Sync failed.',
  window: 'from and to must define a finite, increasing timeline range.',
  noSource: (id: string) => `Source asset '${id}' was not found. It is not in this project; the user may have removed it.`,
  timelineId: (id: string) => `Expected asset ID (e.g., 'video_1') but received timeline ID '${id}'.`,
  tooShort: (role: 'Source' | 'Target') => `${role} asset transcript too short for sync`,
  processing: (id: string) => `'${id}' is still being processed; its transcript appears when processing finishes. Retry syncAndSwap then.`,
  speed: (id: string) => `Target item '${id}' is time-remapped or not at normal speed; syncAndSwap needs a base clip at playback rate 1.`,
  noFootage: (from: number, to: number, offset: number) => `The source asset has no footage between ${from}s and ${to}s at the sync offset (${offset}s).`,
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const fail = (code: string, error: string, extra: RecordData = {}): Result => ({ success: false, code, error, ...extra });
const busy = (a: Asset) => a.processing_status === 'uploading' || a.processing_status === 'processing';

/** The asset's stored transcript, or why there is none. */
async function transcriptOf(ctx: SwapContext, asset: Asset, id: string, role: 'Source' | 'Target'): Promise<Transcript | Result> {
  const t = importTranscript((await ctx.store.row<TranscriptRow>('transcripts', asset.id))?.transcript);
  if (t && wordsOf(t).length) return t;
  if (busy(asset)) return fail('TRANSCRIPT_UNAVAILABLE', SWAP.processing(id));
  if (asset.processing_steps?.transcription === 'unavailable') return fail('ANALYSIS_UNAVAILABLE', UNAVAILABLE.transcription);
  return fail('TRANSCRIPT_UNAVAILABLE', SWAP.tooShort(role));
}
const isResult = (v: Transcript | Result): v is Result => 'success' in v;

/** syncAndSwap {sourceAssetId, targetItemId, trackId, from, to} (s). Success: addMedia's result + syncOffset (s),
 *  syncConfidence (0–1) and syncMatches (the number of matched words). */
export async function syncAndSwap(ctx: SwapContext, input: Record<string, unknown> = {}): Promise<Result> {
  const { sourceAssetId: sourceId, targetItemId: targetId, trackId, from, to } = input;
  if ([sourceId, targetId, trackId, from, to].some(v => v === undefined || v === null || v === '')) return fail('MISSING_PARAM', SWAP.required);
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= to) return fail('INVALID_TOOL_INPUT', SWAP.window);
  const target = itemOf(ctx.doc(), String(targetId));
  if (!target) return fail('ITEM_NOT_FOUND', SWAP.noTarget(String(targetId)));
  // The assets' current rows (status, steps, duration), not the editor's index entries (review R3).
  const targetAsset = await currentAsset(ctx.store, typeof target.metadata?.assetId === 'string' ? ctx.asset(target.metadata.assetId) : undefined);
  if (!targetAsset) return fail('SOURCE_ASSET_UNAVAILABLE', SWAP.noTargetAsset(String(targetId)));
  if (itemOf(ctx.doc(), String(sourceId))) return fail('TIMELINE_ID_NOT_ALLOWED', SWAP.timelineId(String(sourceId)));
  const sourceAsset = await currentAsset(ctx.store, ctx.asset(String(sourceId)));
  if (!sourceAsset) return fail('MEDIA_NOT_FOUND', SWAP.noSource(String(sourceId)));
  const source = await transcriptOf(ctx, sourceAsset, String(sourceId), 'Source');
  if (isResult(source)) return source;
  const base = await transcriptOf(ctx, targetAsset, String(targetId), 'Target');
  if (isResult(base)) return base;
  let sync: Awaited<ReturnType<AnalysisService['syncOffset']>>;
  try { sync = await ctx.service.syncOffset(source, base); } catch (e) {
    const err = e as { code?: string; message?: string; details?: { confidence?: number } };
    if (err?.code === 'SYNC_LOW_CONFIDENCE') return fail(err.code, err.message ?? SWAP.failed, { details: { confidence: err.details?.confidence ?? 0 } });
    return fail(err?.code || 'ANALYSIS_FAILED', err?.message || SWAP.failed);
  }
  const offset = sync.offset;
  let args: RecordData;
  if (ctx.xapp) args = { assetId: sourceId, trackId, timelineStart: from, trimStart: Math.max(0, from + offset), trimEnd: to + offset };
  else {
    // The base item as it is now (the offset took a worker round trip): its source time at timeline t, plus the offset.
    const now = itemOf(ctx.doc(), String(targetId));
    if (!now) return fail('ITEM_NOT_FOUND', SWAP.noTarget(String(targetId)));
    if (remapKeyframes(now).length || Math.abs(rateOf(now) - 1) > 1e-9) return fail('INVALID_TOOL_INPUT', SWAP.speed(String(targetId)));
    const at = (t: number) => ((now.trim?.from ?? 0) + t * 1000 - now.display.from) / 1000 + offset;
    // Only the part of the window the second camera covers is placed, so what is placed stays in sync.
    const length = (sourceAsset.durationMs ?? Infinity) / 1000;
    const start = Math.max(at(from), 0), end = Math.min(at(to), length);
    if (!(end > start)) return fail('INVALID_TRIM_RANGE', SWAP.noFootage(r3(from), r3(to), r3(offset)));
    args = { assetId: sourceId, trackId, timelineStart: r3(from + start - at(from)), trimStart: r3(start), trimEnd: r3(end) };
  }
  const placed = ctx.place(args);
  return placed.success ? { ...placed, syncOffset: r6(offset), syncConfidence: r6(sync.confidence), syncMatches: sync.matches.length } : placed;
}
