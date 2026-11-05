// SPDX-License-Identifier: AGPL-3.0-only
// T19 C4 / C11: viewItemDetails (agent tool results §2 viewItemDetails; error codes §10). Served here: the details object's
// always-present fields and status flags, include=transcript, include=keyframes and the beats-only result. `general`
// (the default), `analysis`, `masks` and `effects` are T18's and refuse NOT_IMPLEMENTED with the owner, except `general`
// when every target is a shape item (T06: timeline/shape-tools shapeDetails, a partial delivery of T18's). Async because
// beats are computed on first read (AnalysisService.rhythm). C5: `snapToBeats`, the cut-to-beat hook on the same reads.
import { hasSource } from '../timeline/items';
import { isCaption, item as itemOf, span } from '../timeline/model';
import { keyframesBlock, rateOf, remapKeyframes } from '../timeline/properties';
import { shapeDetails } from '../timeline/shape-tools';
import { readBeats, snapCuts } from './helpers';
import { SOURCE, currentAsset, importTranscript, placement, transcription } from './read';
import type { AnalysisService, RhythmRow, TranscriptRow } from './service';
import type { Pair, Rhythm } from './types';
import type { ProjectStore } from '../store/database';
import type { Asset, ProcessingStep, ProjectDocument, RecordData } from '../store/model';

type Result = { success: boolean; [k: string]: unknown };
type Reason = { success: false; code: string; error: string };
export type DetailsContext = {
  doc: ProjectDocument;
  /** By stored id or, for this project's live links, by agent id (Runtime.assets). */
  asset: (id: string) => Asset | undefined;
  /** The project's agent id for a stored asset id; undefined when the asset is not (or no longer) in the project. */
  agentId: (assetId: string) => string | undefined;
  store: Pick<ProjectStore, 'row' | 'putRow' | 'media'>;
  service: Pick<AnalysisService, 'rhythm'>;
};
export const DETAILS_OWNER = 'T18';
/** Xapp's code-less messages (Cutframe adds INVALID_TOOL_INPUT); `strength` is Cutframe wording. */
export const MESSAGES = {
  noIds: 'Provide itemId/itemIds or assetId/assetIds',
  range: 'beatsFrom and beatsTo must define a finite, increasing time range.',
  subdivisions: 'subdivisionsPerBeat must be 2, 3, or 4.',
  strength: 'minStrength must be a number from 0 to 1.',
};
const an = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
export const BEATS = {
  notAudioItem: (x: string, type: string) => `'${x}' is ${an(type)} item. Beat data exists only for music audio.`,
  notAudioAsset: (x: string, type: string) => `'${x}' is ${an(type)}. Beat data comes from music audio; inspect the music track instead.`,
  notMusic: (x: string) => `'${x}' is not tagged as music (its analysis treats it as speech or sound), so it has no beat data.`,
  processing: (x: string) => `'${x}' is still being analyzed. Beat data for music appears when processing finishes; check again shortly.`,
  failed: (x: string) => `Beat analysis failed for '${x}'. Its other analysis is unaffected; place cuts from its waveform timing or choose another music track.`,
  remap: 'Timeline rhythm is unavailable for a time-remapped clip; inspect its source asset for source-clock rhythm.',
};
export const sourceUnavailable = (x: string) => `The exact source for '${x}' is unavailable in this project.`;
/** Xapp's text up to "call context()"; the rest (stored as "…") and the asset-id sentence are Cutframe wording. */
export const notFound = (x: string) => `'${x}' is not a current timeline item or project asset. Timeline item IDs change when clips are deleted, split or replaced; call context() to get the current IDs.`
  + (/^(video|audio|image)_\d+$/.test(x) ? ` '${x}' looks like a project asset ID; the client probably removed it from the project.` : '');
export const templateMissing = (x: string) => `'${x}' is a template asset that is not in this project. Add it with addAssetToProject, then inspect the agent ID it returns.`;
const stillAdding = (x: string) => `'${x}' is still being added, so there is no source to read yet. Keep the clip in place; it fills in when the upload finishes.`;
const processingNote = (x: string) => `'${x}' is still being processed; its analysis and transcript appear when processing finishes.`;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const fail = (code: string, error: string): Reason => ({ success: false, code, error });
const invalid = (error: string) => fail('INVALID_TOOL_INPUT', error);
const words = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(w => String(w).trim().toLowerCase()).filter(Boolean);
const list = (one: unknown, many: unknown): string[] => Array.isArray(many) ? many.map(String) : typeof one === 'string' && one ? [one] : [];
const itemType = (i: RecordData): string => isCaption(i) ? 'caption' : String(i.type);
const busy = (a: Asset) => a.processing_status === 'uploading' || a.processing_status === 'processing';
const SERVED = new Set(['transcript', 'keyframes']), OWNED = new Set(['general', 'analysis', 'masks', 'effects']);

type Target = { id: string; item?: RecordData; asset?: Asset };
/** A timeline item first, then a project asset (agent or stored id with a live link), with the asset's current row. */
async function resolve(ctx: DetailsContext, id: string): Promise<Target | Reason> {
  const i = itemOf(ctx.doc, id);
  if (i) return { id, item: i, asset: await currentAsset(ctx.store, typeof i.metadata?.assetId === 'string' ? ctx.asset(i.metadata.assetId) : undefined) };
  const a = ctx.asset(id);
  if (a && ctx.agentId(a.id) !== undefined) return { id, asset: await currentAsset(ctx.store, a) };
  return id.startsWith('tpl_') ? fail('TEMPLATE_ASSET_NOT_IN_PROJECT', templateMissing(id)) : fail('ITEM_NOT_FOUND', notFound(id));
}
const isReason = (t: Target | Reason): t is Reason => 'success' in t;

/** Status flags, only when abnormal (results §2 table "status flags"). */
function flags(ctx: DetailsContext, { id, item, asset }: Target): Record<string, unknown> {
  const media = item ? typeof item.metadata?.assetId === 'string' : true;
  if (!media) return {};
  if (!asset || asset.last_error_code === 'OBJECT_MISSING') return { assetUnavailable: true, warning: 'SOURCE_ASSET_UNAVAILABLE', warningMessage: sourceUnavailable(id) };
  if (asset.processing_status === 'uploading') return { assetStillAdding: true, warning: 'SOURCE_STILL_ADDING', warningMessage: stillAdding(id) };
  const out: Record<string, unknown> = item && ctx.agentId(asset.id) === undefined ? { assetRemovedFromProject: true, warning: 'SOURCE_ASSET_UNAVAILABLE', warningMessage: sourceUnavailable(id) } : {};
  return asset.processing_status === 'processing' ? { ...out, assetProcessing: true, status: 'PROCESSING', note: processingNote(id) } : out;
}

/** `capabilities` per step, only when one is not ready. `unavailable` (no local models, C12) is Cutframe's. A step that
 *  never ran on an asset prepared before T19 is `never` (`pending` while the asset is still being prepared). */
const STATE: Record<ProcessingStep, string> = { complete: 'ready', skipped: 'never', pending: 'pending', processing: 'pending', failed: 'failed', unavailable: 'unavailable' };
function capabilities(asset?: Asset): Record<string, unknown> {
  if (!asset) return {};
  const steps = asset.processing_steps ?? {}, state = (s?: ProcessingStep) => s ? STATE[s] : busy(asset) ? 'pending' : 'never';
  const search = [state(steps.embeddings_description), state(steps.embeddings_transcript)];
  const c = { analysis: state(steps.analysis), transcript: state(steps.transcription), search: ['failed', 'pending', 'unavailable', 'ready'].find(v => search.includes(v)) ?? 'never' };
  return Object.values(c).every(v => v === 'ready') ? {} : { capabilities: c };
}

async function details(ctx: DetailsContext, t: Target, include: Set<string>, keyframesRead: string[], general: boolean) {
  const { id, item, asset } = t, length = r3((asset?.durationMs ?? 0) / 1000);
  const d: Record<string, unknown> = item
    ? { id, type: itemType(item), startTime: r3(item.display.from / 1000), endTime: r3(item.display.to / 1000), duration: r3(span(item) / 1000), layer: item.trackId,
      hasKeyframes: keyframesBlock(item).keyframes !== null, hasMasks: !!item.masks?.length, hasEffects: !!item.effects?.length }
    : { id, type: asset!.type, startTime: 0, endTime: length, duration: length, layer: `${asset!.type}_track_available`, hasKeyframes: false, hasMasks: false, hasEffects: false };
  if (asset?.recorded_at) d.recordedAt = asset.recorded_at;
  Object.assign(d, flags(ctx, t), capabilities(asset));
  if (general && item) Object.assign(d, shapeDetails(ctx.doc, item));
  if (include.has('transcript') && asset && asset.type !== 'image' && (!item || item.type === 'video' || item.type === 'audio')) {
    const transcript = importTranscript((await ctx.store.row<TranscriptRow>('transcripts', asset.id))?.transcript);
    // Item: item start + source − trim start, playback rate not applied (results §2).
    const out = transcript && transcription(transcript, item ? placement(item.display.from, item.trim ?? { from: 0, to: span(item) * rateOf(item) }, 1) : SOURCE);
    if (out) d.transcription = out;
  }
  if (include.has('keyframes')) {
    Object.assign(d, item ? keyframesBlock(item) : { keyframes: null, keyframesNote: 'No keyframes on this item' });
    if (item) keyframesRead.push(id);
  }
  return d;
}

type BeatOptions = { window?: [number, number]; minStrength?: number; divisions: 2 | 3 | 4 };
function beatOptions(input: Record<string, unknown>): BeatOptions | Reason {
  const { beatsFrom: from, beatsTo: to, minStrength: s } = input;
  let window: [number, number] | undefined;
  if (from !== undefined || to !== undefined) {
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) return invalid(MESSAGES.range);
    window = [from, to];
  }
  const divisions = input.subdivisionsPerBeat === undefined ? 4 : Number(input.subdivisionsPerBeat);
  if (divisions !== 2 && divisions !== 3 && divisions !== 4) return invalid(MESSAGES.subdivisions);
  if (s !== undefined && (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1)) return invalid(MESSAGES.strength);
  return { window, minStrength: s as number | undefined, divisions };
}
type Full = Extract<ReturnType<typeof readBeats>, { beats: unknown }>;
/** An item's clocks: source s → timeline s, timeline s → source s, and its visible source window [lo, hi) in s. */
function clock(item: RecordData) {
  const rate = rateOf(item), trimFrom = item.trim?.from ?? 0, trimTo = item.trim?.to ?? trimFrom + span(item) * rate;
  return { rate, lo: trimFrom / 1000, hi: trimTo / 1000,
    tl: (s: number) => r6((item.display.from + (s * 1000 - trimFrom) / rate) / 1000), src: (t: number) => (trimFrom + (t * 1000 - item.display.from) * rate) / 1000 };
}
/** An item's beats in timeline s: mapped through trim and rate, hidden source parts dropped, bpm scaled by the rate. */
function itemBeats(item: RecordData, r: Rhythm, o: BeatOptions) {
  const { rate, tl, src, lo, hi } = clock(item), down = r.downbeats.find(([t]) => t >= lo && t < hi);
  const base = { bpm: r.bpm === null ? null : r6(r.bpm * rate), firstDownbeat: down ? tl(down[0]) : null };
  if (!o.window) return base;
  const from = Math.max(lo, src(o.window[0])), to = Math.min(hi, src(o.window[1])), pair = ([t, s]: Pair): Pair => [tl(t), s];
  if (!(from < to)) return { ...base, beats: [], downbeats: [], subdivisions: { divisionsPerBeat: o.divisions, method: 'interpolated' as const, timestamps: [] } };
  const b = readBeats(r, { from, to, minStrength: o.minStrength, divisionsPerBeat: o.divisions }) as Full;
  return { ...base, beats: b.beats.map(pair), downbeats: b.downbeats.map(pair), subdivisions: { ...b.subdivisions, timestamps: b.subdivisions.timestamps.map(tl) } };
}
/** Why a target has no beats; `soft` = the source simply has none (a success with `noBeats`), else a failure. */
type NoBeats = { reason: Reason; soft: boolean };
type BeatsOutcome = { beats: Record<string, unknown> } | NoBeats;
const soft = (code: string, error: string): NoBeats => ({ reason: fail(code, error), soft: true });
const hard = (code: string, error: string): NoBeats => ({ reason: fail(code, error), soft: false });
/** The source rhythm behind a target, or why there is none. */
async function rhythmOf(ctx: DetailsContext, { id, item, asset }: Target): Promise<{ rhythm: Rhythm } | NoBeats> {
  if (item && item.type !== 'audio') return soft('BEATS_NOT_AUDIO', BEATS.notAudioItem(id, itemType(item)));
  if (!item && asset!.type !== 'audio') return soft('BEATS_NOT_AUDIO', BEATS.notAudioAsset(id, asset!.type));
  if (!asset || asset.last_error_code === 'OBJECT_MISSING') return hard('SOURCE_ASSET_UNAVAILABLE', sourceUnavailable(id));
  if (busy(asset)) return hard('BEATS_PROCESSING', BEATS.processing(id));
  if (!hasSource(asset)) return hard('BEATS_FAILED', BEATS.failed(id)); // preparation failed: never classified as music
  let row: RhythmRow;
  try { row = await ctx.service.rhythm(ctx.store, asset); } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err?.code === 'ANALYSIS_UNAVAILABLE') return hard(err.code, err.message ?? '');
    if (err?.code === 'WORKSPACE_FILE_MISSING' || err?.code === 'OBJECT_MISSING') return hard('SOURCE_ASSET_UNAVAILABLE', sourceUnavailable(id));
    return hard('BEATS_FAILED', BEATS.failed(id));
  }
  return row.analysis ? { rhythm: row.analysis.stored } : soft('BEATS_NOT_MUSIC', BEATS.notMusic(id));
}
async function beatsOf(ctx: DetailsContext, t: Target, o: BeatOptions): Promise<BeatsOutcome> {
  const found = await rhythmOf(ctx, t);
  if (!('rhythm' in found)) return found;
  const r = found.rhythm, { item } = t;
  if (!item) return { beats: readBeats(r, o.window ? { from: o.window[0], to: o.window[1], minStrength: o.minStrength, divisionsPerBeat: o.divisions } : {}) };
  if (remapKeyframes(item).length) return o.window ? hard('RHYTHM_TIME_REMAP_UNSUPPORTED', BEATS.remap) : { beats: { bpm: null, firstDownbeat: null } };
  return { beats: itemBeats(item, r, o) };
}

/** C5, the cut-to-beat snap hook (tickets T19 helpers; for T13 and agent-side code): snaps `cuts` to the nearest beat or
 *  subdivision of the target's music within `tolerance` and returns the moves (`snapCuts`). Item: cuts, tolerance and
 *  moves in timeline s, only beats in the visible part of the source; asset: source s. Same reasons as the beats read. */
export async function snapToBeats(ctx: DetailsContext, input: { id: string; cuts: number[]; tolerance: number; subdivisionsPerBeat?: 2 | 3 | 4 }): Promise<Result> {
  const t = await resolve(ctx, input.id);
  if (isReason(t)) return t;
  const found = await rhythmOf(ctx, t);
  if (!('rhythm' in found)) return found.reason;
  try {
    if (!t.item) return { success: true, data: { moves: snapCuts(input.cuts, found.rhythm, input.tolerance, input.subdivisionsPerBeat) } };
    if (remapKeyframes(t.item).length) return fail('RHYTHM_TIME_REMAP_UNSUPPORTED', BEATS.remap);
    const { rate, tl, src, lo, hi } = clock(t.item), visible: Rhythm = { ...found.rhythm, beats: found.rhythm.beats.filter(([s]) => s >= lo && s < hi) };
    const moves = snapCuts(input.cuts.map(src), visible, input.tolerance * rate, input.subdivisionsPerBeat)
      .map(m => ({ index: m.index, from: input.cuts[m.index], to: tl(m.to), delta: r6(tl(m.to) - input.cuts[m.index]) }));
    return { success: true, data: { moves } };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return fail(err?.code ?? 'INVALID_ANALYSIS_INPUT', err?.message ?? String(e));
  }
}
async function beats(ctx: DetailsContext, ids: string[], input: Record<string, unknown>): Promise<Result> {
  const o = beatOptions(input);
  if ('success' in o) return o;
  const out = new Map<string, BeatsOutcome>();
  // One source at a time: each may decode a whole file.
  for (const id of ids) { const t = await resolve(ctx, id); out.set(id, isReason(t) ? { reason: t, soft: false } : await beatsOf(ctx, t, o)); }
  if (ids.length === 1) {
    const r = out.get(ids[0])!;
    return 'beats' in r ? { success: true, data: { beats: r.beats } } : r.soft ? { success: true, data: { beats: null, noBeats: r.reason.error } } : r.reason;
  }
  const beatsBySource: Record<string, unknown> = {}, unavailable: Record<string, Reason> = {};
  for (const [id, r] of out) if ('beats' in r) beatsBySource[id] = r.beats; else unavailable[id] = r.reason;
  const hardReason = [...out.values()].some(r => 'reason' in r && !r.soft);
  if (!Object.keys(beatsBySource).length && hardReason) return { success: false, code: 'BEATS_UNAVAILABLE', error: Object.values(unavailable).map(r => r.error).join(' '), unavailable };
  return { success: true, data: { beatsBySource, ...(Object.keys(unavailable).length ? { unavailable } : {}) } };
}

function notImplemented(asked: string[]): Result {
  const what = asked.map(w => `"${w}"`).join(', ');
  return { success: false, code: 'NOT_IMPLEMENTED', owner: DETAILS_OWNER, error: `viewItemDetails include ${what} is not implemented yet`,
    message: `This version serves include "transcript", "keyframes" and "beats"; ${what} arrives with ${DETAILS_OWNER}. Pass include with those values only.` };
}

/** viewItemDetails. `onKeyframesRead` is called for each returned item whose keyframes were included (T18a R3). */
export async function viewItemDetails(ctx: DetailsContext, input: Record<string, unknown> = {}, onKeyframesRead: (itemId: string) => void = () => {}): Promise<Result> {
  const ids = [...new Set([...list(input.itemId, input.itemIds), ...list(input.assetId, input.assetIds)])];
  if (!ids.length) return invalid(MESSAGES.noIds);
  const include = new Set(words(input.include));
  if (include.has('beats')) return beats(ctx, ids, input); // beats-only; other include values are ignored
  const known = [...include].filter(w => SERVED.has(w) || OWNED.has(w)), unserved = known.length ? known.filter(w => OWNED.has(w)) : ['general'];
  // T06: `general` is served when every target is a shape item; any other target keeps the call-level refusal (T18).
  const general = unserved.length > 0 && unserved.every(w => w === 'general') && ids.every(id => itemOf(ctx.doc, id)?.type === 'shape');
  if (unserved.length && !general) return notImplemented(unserved);
  const results: Result[] = [], keyframesRead: string[] = [];
  for (const id of ids) { const t = await resolve(ctx, id); results.push(isReason(t) ? { id, ...t } : { id, success: true, data: await details(ctx, t, include, keyframesRead, general) }); }
  keyframesRead.forEach(onKeyframesRead);
  if (ids.length === 1) { const { id: _, ...only } = results[0]; return only.success ? { success: true, data: only.data } : only as Result; }
  return { success: true, message: `Batch: ${results.filter(r => r.success).length}/${ids.length} items`, data: { results } };
}
