// SPDX-License-Identifier: AGPL-3.0-only
// T03 item edits (findings §3, §17; part 2 §29, §31, §37, §38, §41, §41b, §41c; part 5 §53.1.3; agent tool results §2, §5).
// Every op works on the running command's draft in ms and either completes or throws CommandError; the bus then drops
// the draft, so a refusal never leaves a partial change. Texts are Xapp's; codes Xapp leaves out are Cutframe additions.
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import {
  ancestors, blockers, EPS, fail, fmt, freeTracks, groupOf, insertTrack, isCaption, item, itemKind, itemsOn, kindOf, MEDIA_TYPES,
  memberTracks, newId, newTrack, nextFree, overlaps, rate, sourceLength, span, track, trackLocked,
} from './model';
import type { TrackKind } from './model';
import { ensureProp, normaliseProperties, prop, remapKeyframes, setStatic, sourceTime, storedProperties } from './properties';
import { copyRecord, splitBindings, splitCaptionWords } from '../captions/links';

export const MIN_ITEM_MS = 50, TOOL_IMAGE_MS = 3000, UI_IMAGE_MS = 5000, UNKNOWN_SOURCE_MS = 5000;
const frame = (doc: ProjectDocument) => 1000 / doc.fps;
const window_ = (r: { from: number; to: number }) => `${fmt(r.from)}s–${fmt(r.to)}s`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const are = (list: string[]) => `track(s) ${list.join(', ')} ${list.length === 1 ? 'is' : 'are'} free`;

// ---- Keyframes (T04: `properties[key]` / `timeRemap` = {defaultValue, keyframes[]}). Property keyframes sit on the trim
// axis (part 2 §38: property time = trim.from + t × rate); time-remap keyframes sit on the item-local axis.
function shiftKeyframes(i: RecordData, by: number, which: 'property' | 'remap') {
  if (!by) return;
  if (which === 'remap') { for (const k of remapKeyframes(i)) k.time += by; return; }
  for (const key of Object.keys(i.properties ?? {})) if (prop(i, key)?.keyframes.length) for (const k of ensureProp(i, key).keyframes) k.time += by;
}

// ---- New items from assets (part 5 §53.1.3).
export function naturalSize(asset: Asset): { width: number; height: number } | null {
  const v = asset.media?.video, im = (asset.media as RecordData | null | undefined)?.image;
  const width = v?.displayWidth ?? im?.width, height = v?.displayHeight ?? im?.height;
  return width > 0 && height > 0 ? { width, height } : null;
}
/** Fit (contain) or fill (cover), centred; with bounds the aspect is kept and the box sits at (x, y). */
export function fitProperties(doc: ProjectDocument, size: { width: number; height: number }, mode: 'fit' | 'fill' = 'fit', bounds?: RecordData) {
  const W = doc.size.width, H = doc.size.height;
  if (bounds) {
    const scale = Math.min(bounds.width > 0 ? bounds.width / size.width : Infinity, bounds.height > 0 ? bounds.height / size.height : Infinity);
    return { width: size.width, height: size.height, scale, positionX: bounds.x, positionY: bounds.y };
  }
  const scale = (mode === 'fit' ? Math.min : Math.max)(W / size.width, H / size.height);
  return { width: size.width, height: size.height, scale, positionX: (W - size.width * scale) / 2, positionY: (H - size.height * scale) / 2 };
}
export type MediaSpec = { assetId: string; asset?: Asset; trimStart?: number; trimEnd?: number; duration?: number; bounds?: RecordData };
export const sourceOf = (a: Asset) => a.durationMs ?? a.media?.durationMs ?? null;
/** Timeline length and source window (ms) of one placement. */
export function resolveSpec(spec: MediaSpec & { asset: Asset }, imageMs: number) {
  const a = spec.asset;
  if (a.type === 'image') return { length: spec.duration ?? imageMs, trim: null, source: null };
  const source = sourceOf(a), from = spec.trimStart ?? 0;
  const to = spec.trimEnd ?? (spec.duration !== undefined ? from + spec.duration : source ?? from + UNKNOWN_SOURCE_MS);
  return { length: to - from, trim: { from, to }, source };
}
/** A usable source: the asset's bytes were stored and no ingest step reported them missing (provisional reading of "source URL"). */
export const hasSource = (a: Asset) => a.processing_status !== 'failed' && a.last_error_code !== 'OBJECT_MISSING' && a.processing_status !== 'uploading';
export function mediaItem(doc: ProjectDocument, spec: MediaSpec & { asset: Asset }, trackId: string, from: number, imageMs: number): RecordData {
  const a = spec.asset, r = resolveSpec(spec, imageMs), size = a.type === 'audio' ? null : naturalSize(a);
  const record: RecordData = { id: newId('item'), type: a.type, trackId, display: { from, to: from + r.length }, playbackRate: 1,
    details: { name: a.name }, metadata: { assetId: a.id }, properties: size ? storedProperties(fitProperties(doc, size, 'fit', spec.bounds)) : {}, masks: [], effects: [] };
  if (r.trim) { record.trim = r.trim; if (r.source !== null) record.sourceDuration = r.source; }
  return record;
}
/** Per-placement checks (addMedia per-item validation; agent tool results §2). Returns [code, reason] or null. */
export function specProblem(spec: MediaSpec, asset: Asset | undefined, startMs: number): [string, string] | null {
  if (!asset) return ['MEDIA_NOT_FOUND', 'Media asset not found'];
  if (spec.bounds && asset.type === 'audio') return ['BOUNDS_NOT_SUPPORTED', 'Canvas bounds only apply to visual media'];
  if (spec.bounds && (![spec.bounds.x, spec.bounds.y].every(Number.isFinite) || !(spec.bounds.width > 0 || spec.bounds.height > 0)))
    return ['INVALID_BOUNDS', 'bounds requires finite x/y coordinates and at least one positive width or height.'];
  if (!hasSource(asset)) return ['INVALID_ASSET_URL', `Asset '${spec.assetId}' does not have a valid source URL.`];
  if (startMs < 0) return ['INVALID_TIMELINE_START', `timelineStart must be >= 0. Received: ${fmt(startMs)}s.`];
  if (asset.type === 'image') return spec.duration !== undefined && !(spec.duration > 0) ? ['INVALID_IMAGE_DURATION', `Image duration must be positive. Received: ${fmt(spec.duration)}s.`] : null;
  if (spec.duration !== undefined && !(spec.duration > 0)) return ['INVALID_DURATION', `duration must be positive. Received: ${fmt(spec.duration)}s.`];
  const r = resolveSpec({ ...spec, asset }, TOOL_IMAGE_MS);
  if (!(r.trim!.to > r.trim!.from)) return ['INVALID_TRIM_RANGE', 'trimEnd must be greater than trimStart.'];
  if (r.source !== null && r.trim!.to > r.source + EPS) return ['TRIM_EXCEEDS_SOURCE', `trimEnd (${fmt(r.trim!.to)}s) exceeds source ${asset.type} duration (${fmt(r.source)}s).`];
  return null;
}

// ---- Insert compatibility (part 2 §31).
const insertClass = (type: string) => type === 'video' || type === 'image' ? 'visual' : type === 'audio' ? 'audio' : type === 'caption' ? 'caption' : 'overlay';
export const canInsertAfter = (type: string, ref: RecordData) => insertClass(type) === insertClass(isCaption(ref) ? 'caption' : ref.type);

// ---- Ripple (part 2 §37).
export const RIPPLE_BOUNDARY = 'An item spans this edit boundary. Split it at the boundary or turn off ripple editing first.';
export const RIPPLE_OCCUPIED = 'Another item occupies the removed group interval. Split or remove it explicitly first.';
const groupLocked = (doc: ProjectDocument, g: string) => !!doc.groups[g]?.locked || ancestors(doc, g).some(a => doc.groups[a]?.locked);
/** Group ripple: the interval [t, r) becomes n ms long on every member track. Items at/after r move by n − (r − t); an
 *  item crossing t or r refuses the edit; another item inside [t, r) refuses it (provisional: Xapp may delete it). */
export function groupRipple(doc: ProjectDocument, groupId: string, t: number, r: number, n: number, skip: ReadonlySet<string>): string[] {
  if (groupLocked(doc, groupId)) fail('TRACK_LOCKED', 'Group is locked');
  const tracks = memberTracks(doc, groupId);
  if (tracks.some(id => track(doc, id)?.locked)) fail('TRACK_LOCKED', 'Group contains a locked track');
  const shift = n - (r - t), moved: string[] = [], crosses = (i: RecordData, p: number) => i.display.from < p - EPS && i.display.to > p + EPS;
  const affected = tracks.flatMap(id => itemsOn(doc, id)).filter(i => !skip.has(i.id));
  for (const i of affected) {
    if (crosses(i, t) || (r > t + EPS && crosses(i, r))) fail('GROUP_RIPPLE_BOUNDARY_UNSET', RIPPLE_BOUNDARY);
    if (r > t + EPS && i.display.from >= t - EPS && i.display.to <= r + EPS) fail('RIPPLE_INTERVAL_OCCUPIED', RIPPLE_OCCUPIED);
  }
  if (shift) for (const i of affected) if (i.display.from >= r - EPS) { i.display = { from: i.display.from + shift, to: i.display.to + shift }; moved.push(i.id); }
  return moved;
}
/** Outside a group: later items of the same track (starting after the old end − 1 ms) move by `by`. */
function trackRipple(doc: ProjectDocument, trackId: string, oldEnd: number, by: number, skip: ReadonlySet<string>): string[] {
  const moved: string[] = [];
  if (by) for (const i of itemsOn(doc, trackId)) if (!skip.has(i.id) && i.display.from > oldEnd - 1) { i.display = { from: i.display.from + by, to: i.display.to + by }; moved.push(i.id); }
  return moved;
}
/** One edit point moving by `by` at `oldEnd` on the item's ripple scope (group or track). */
export function rippleAt(doc: ProjectDocument, trackId: string, groupId: string | null, oldEnd: number, by: number, skip: ReadonlySet<string>) {
  if (!groupId) return trackRipple(doc, trackId, oldEnd, by, skip);
  return by < 0 ? groupRipple(doc, groupId, oldEnd + by, oldEnd, 0, skip) : groupRipple(doc, groupId, oldEnd, oldEnd, by, skip);
}

/** Collision text of the add-items placement (cloneItem; agent tool results §2). */
export const addCollision = (trackId: string, want: { from: number; to: number }, b: RecordData, next: number) =>
  `[addItems] requested window collides on track ${trackId}: ${window_(want)} overlaps item ${b.id} (${window_(b.display)}). The next free start for this length on that track is ${fmt(next)}s; or use another track.`;

// ---- Move / change track (the shared move planner; agent tool results §2 moveItem, changeTrack).
export type Move = { id: string; trackId: string; from: number };
/** Validates and applies an all-or-nothing batch of moves. `prefix` is "Move failed" or "Track change failed". */
export function applyMoves(doc: ProjectDocument, moves: Move[], prefix: string): RecordData[] {
  const moving = new Set(moves.map(m => m.id)), planned = new Map<string, { trackId: string; from: number; to: number }>();
  for (const m of moves) {
    const i = item(doc, m.id)!, t = track(doc, m.trackId);
    if (!t) fail('TRACK_NOT_FOUND', `${prefix}: TRACK_NOT_FOUND`);
    if (trackLocked(doc, i.trackId) || trackLocked(doc, m.trackId)) fail('TRACK_LOCKED', `${prefix}: TRACK_LOCKED`);
    if (itemKind(i) !== t.kind) fail('TRACK_INCOMPATIBLE', `${prefix}: TRACK_INCOMPATIBLE`);
    let from = Math.max(0, m.from);
    const len = span(i), others = (range: { from: number; to: number }) => [
      ...blockers(doc, m.trackId, range, moving),
      ...[...planned].filter(([id, p]) => id !== m.id && p.trackId === m.trackId && overlaps(p, range)).map(([id, p]) => ({ id, display: p })),
    ].sort((a, b) => a.display.from - b.display.from);
    // Sub-frame overlap with the left neighbour: nudged to start at its end (findings §29).
    const left = others({ from, to: from + len }).find(b => b.display.from < from && b.display.to - from < frame(doc));
    if (left) from = left.display.to;
    const hit = others({ from, to: from + len })[0];
    if (hit) {
      const room = nextFree(doc, m.trackId, from, len, moving), free = freeTracks(doc, t.kind, { from, to: from + len }, moving, m.trackId);
      fail('COLLISION', `${prefix}: COLLISION — '${m.id}' at ${window_({ from, to: from + len })} would overlap '${hit.id}' (${window_(hit.display)}) on track ${m.trackId}. That track has room for it from ${fmt(room)}s${free.length ? `; for the same time, ${are(free)}` : ''}.`);
    }
    planned.set(m.id, { trackId: m.trackId, from, to: from + len });
  }
  const changed: RecordData[] = [];
  for (const [id, p] of planned) {
    const i = item(doc, id)!;
    if (i.trackId === p.trackId && Math.abs(i.display.from - p.from) < EPS) continue;
    i.trackId = p.trackId; i.display = { from: p.from, to: p.to }; changed.push(i);
  }
  return changed;
}
export function requireItems(doc: ProjectDocument, ids: string[], code: string, error: (missing: string[]) => string) {
  const missing = ids.filter(id => !item(doc, id));
  if (missing.length) fail(code, error(missing));
}

// ---- Reorder (agent tool results §2 reorderItems; G-01 S1R 0–6 s, S1L 6–8.5 s).
export function reorder(doc: ProjectDocument, ids: string[], anchorId: string, place: 'before' | 'after'): string[] {
  requireItems(doc, ids, 'ITEM_NOT_FOUND', () => 'Reorder failed: ITEM_NOT_FOUND');
  const sel = ids.map(id => item(doc, id)!).sort((a, b) => a.display.from - b.display.from), src = sel[0].trackId;
  if (sel.some(i => i.trackId !== src)) fail('MIXED_TRACKS', 'Reorder failed: MIXED_TRACKS');
  const anchor = item(doc, anchorId);
  if (!anchor || ids.includes(anchorId)) fail('TARGET_INVALID', 'Reorder failed: TARGET_INVALID');
  const dest = anchor.trackId, kind = track(doc, dest)?.kind;
  if (sel.some(i => itemKind(i) !== kind)) fail('TARGET_INCOMPATIBLE', 'Reorder failed: TARGET_INCOMPATIBLE');
  if (trackLocked(doc, src) || trackLocked(doc, dest)) fail('TRACK_LOCKED', 'Reorder failed: TRACK_LOCKED');
  const start = sel[0].display.from, end = Math.max(...sel.map(i => i.display.to)), selected = new Set(ids);
  if (itemsOn(doc, src).some(i => !selected.has(i.id) && i.display.from >= start - EPS && i.display.from < end - EPS)) fail('NON_CONTIGUOUS', 'Reorder failed: NON_CONTIGUOUS');
  const extent = end - start, offsets = sel.map(i => i.display.from - start);
  // Items starting at or after `at` move by `by` (group scope: the group ripple rules).
  const ripple = (trackId: string, at: number, by: number) => {
    try { return rippleAt(doc, trackId, groupOf(doc, trackId), at, by, selected); }
    catch (e) { if ((e as { code?: string }).code !== 'TRACK_LOCKED') throw e; return fail('TRACK_LOCKED', 'Reorder failed: TRACK_LOCKED'); }
  };
  // Close the gap left behind, then open one at the anchor.
  ripple(src, end, -extent);
  const p = place === 'before' ? anchor.display.from : anchor.display.to;
  ripple(dest, p, extent);
  sel.forEach((i, n) => { i.trackId = dest; i.display = { from: p + offsets[n], to: p + offsets[n] + span(i) }; });
  return sel.map(i => i.id);
}

// ---- Trim (agent tool results §2 trimItem, §5; part 2 §37, §38, §41c).
export type TrimResult = { applied: number; shifted: string[]; label: 'Edit items' | 'Ripple trim' | 'Ripple group trim' };
export function trim(doc: ProjectDocument, id: string, edge: 'start' | 'end', delta: number, opts: { ripple?: boolean; rippleGroupId?: string; path: 'tool' | 'ui' }): TrimResult {
  const i = item(doc, id);
  if (!i) fail('ITEM_NOT_FOUND', 'Trim was not applied: ITEM_NOT_FOUND');
  const ripple = (opts.ripple || !!opts.rippleGroupId) && !isCaption(i);
  let groupId: string | null = null;
  if (ripple) {
    groupId = opts.rippleGroupId ?? groupOf(doc, i.trackId);
    if (opts.rippleGroupId && !memberTracks(doc, opts.rippleGroupId).includes(i.trackId)) fail('RIPPLE_OUTSIDE_GROUP', 'Trim item is outside ripple group');
  }
  const limit = `Trim was not applied — '${id}' cannot move its ${edge} that way: it is already at the limit of its source media or its minimum length.`;
  if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', ripple ? limit : 'Trim was not applied: TRACK_LOCKED');
  const r = rate(i), len = span(i), src = sourceLength(i), tr = i.trim as { from: number; to: number } | undefined;
  let lo: number, hi: number;
  if (edge === 'start') {
    lo = Math.max(ripple ? -Infinity : -i.display.from, tr ? -Math.floor(tr.from / r * 1000) / 1000 : -Infinity); hi = len - MIN_ITEM_MS;
  } else { lo = -(len - MIN_ITEM_MS); hi = src !== null && tr ? (src - tr.to) / r : Infinity; }
  let d = clamp(delta, lo, hi);
  if (!ripple && Math.abs(d) > EPS) {
    // Neighbour collision: the tool refuses (snapping within 1 ms); the UI stops at the neighbour (ticket: "collision clamp").
    const others = itemsOn(doc, i.trackId).filter(x => x.id !== id);
    const want = edge === 'start' ? { from: i.display.from + d, to: i.display.from } : { from: i.display.to, to: i.display.to + d };
    const hit = d < 0 || edge === 'end' ? others.filter(x => overlaps(x.display, want)).sort((a, b) => edge === 'start' ? b.display.to - a.display.to : a.display.from - b.display.from)[0] : undefined;
    if (hit) {
      const stop = edge === 'start' ? hit.display.to - i.display.from : hit.display.from - i.display.to, over = Math.abs(d - stop);
      if (opts.path === 'ui' || over <= 1 + EPS) d = stop;
      else fail('COLLISION', `Trim was not applied: COLLISION — it would overlap '${hit.id}' (${window_(hit.display)}) on the same track; there is ${fmt(Math.abs(stop))}s of free space on that side.`);
    }
  }
  if (Math.abs(d) < EPS) fail('TRIM_AT_LIMIT', limit);
  const oldEnd = i.display.to;
  if (edge === 'start') {
    if (tr) tr.from += d * r;
    shiftKeyframes(i, -d, 'remap');
    i.display = ripple ? { from: i.display.from, to: i.display.to - d } : { from: i.display.from + d, to: i.display.to };
  } else {
    if (tr && typeof tr.to === 'number') tr.to += d * r;
    i.display = { from: i.display.from, to: i.display.to + d };
  }
  const shifted = ripple ? rippleAt(doc, i.trackId, groupId, oldEnd, edge === 'start' ? -d : d, new Set([id])) : [];
  return { applied: d, shifted, label: ripple ? (groupId ? 'Ripple group trim' : 'Ripple trim') : 'Edit items' };
}

// ---- Slip (agent tool results §2 slipItem; contracts: keyframes stay put on the timeline, masks follow the footage).
export function slip(doc: ProjectDocument, id: string, delta: number): number {
  const i = item(doc, id), no = 'Slip was not applied';
  if (!i) fail('ITEM_NOT_FOUND', no);
  if (!MEDIA_TYPES.has(i.type)) fail('INVALID_ITEM_TYPE', no);
  const src = sourceLength(i), tr = i.trim as { from: number; to: number } | undefined;
  if (src === null || !tr) fail('SOURCE_DURATION_UNKNOWN', no);
  if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', no);
  const d = clamp(delta, -tr.from, src - tr.to);
  if (Math.abs(d) < EPS) fail('SLIP_AT_LIMIT', no);
  tr.from += d; tr.to += d;
  shiftKeyframes(i, d, 'property');
  return d;
}

// ---- Split (contracts splitItem; part 2 §38, §41b).
export function split(doc: ProjectDocument, id: string, at: number): { left: string; right: string } {
  const i = item(doc, id);
  if (!i || !(i.display.from + EPS < at && at < i.display.to - EPS)) fail(i ? 'INVALID_SPLIT_POINT' : 'ITEM_NOT_FOUND', 'Split point is invalid or item was not found');
  if (trackLocked(doc, i.trackId) || i.locked) fail('TRACK_LOCKED', 'This clip or track is locked. Unlock it before splitting.');
  const elapsed = at - i.display.from, r = rate(i), right = structuredClone(i), cut = (i.trim?.from ?? 0) + elapsed * r, captionCut = sourceTime(i, elapsed);
  right.id = newId('item'); right.display = { from: at, to: i.display.to }; normaliseProperties(right);
  if (MEDIA_TYPES.has(i.type) && i.trim) { right.trim = { from: cut, to: i.trim.to }; i.trim.to = cut; }
  else right.trim = { from: cut, to: cut + (i.display.to - at) * r };
  if (i.trim && !MEDIA_TYPES.has(i.type)) i.trim.to = cut;
  i.display = { from: i.display.from, to: at };
  shiftKeyframes(right, -elapsed, 'remap');
  doc.items.splice(doc.items.indexOf(i) + 1, 0, right);
  if (isCaption(i)) { if (Array.isArray(i.details?.words) && i.details.words.length) splitCaptionWords(doc, i, right, at); }
  else splitBindings(doc, i, right, captionCut);
  for (const t of doc.transitions) if (t.fromId === id) t.fromId = right.id;
  return { left: id, right: right.id };
}

// ---- Clone (agent tool results §2 cloneItem) and UI duplicate ("Duplicate items" right after the source).
export function clone(doc: ProjectDocument, id: string, trackId: string | undefined, at?: number): RecordData {
  const i = item(doc, id);
  if (!i) fail('ITEM_NOT_FOUND', `Item '${id}' not found`);
  if (!trackId) fail('MISSING_TRACK_ID', 'trackId is required');
  const t = track(doc, trackId), bad = `Track '${trackId}' is missing, locked, or incompatible`;
  if (!t) fail('TRACK_NOT_FOUND', bad);
  if (trackLocked(doc, trackId)) fail('TRACK_LOCKED', bad);
  if (t.kind !== itemKind(i)) fail('TRACK_INCOMPATIBLE', bad);
  const from = Math.max(0, at ?? i.display.to), want = { from, to: from + span(i) }, hit = blockers(doc, trackId, want)[0];
  if (hit) fail('TRACK_OVERLAP', addCollision(trackId, want, hit, nextFree(doc, trackId, from, span(i))));
  const copy = structuredClone(i);
  copy.id = newId('item'); copy.trackId = trackId; copy.display = want; normaliseProperties(copy);
  copyRecord(copy);
  doc.items.push(copy);
  return copy;
}
export function duplicate(doc: ProjectDocument, ids: string[]): RecordData[] {
  return ids.map(id => {
    const i = item(doc, id);
    if (!i) fail('ITEM_NOT_FOUND', `Item '${id}' not found`);
    if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
    return clone(doc, id, i.trackId, nextFree(doc, i.trackId, i.display.to, span(i)));
  });
}

// ---- Delete and ripple delete (agent tool results §2 deleteItems; part 2 §37, §41c).
export type DeleteResult = { deleted: string[]; also: string[]; shifted: string[]; label: 'Delete items' | 'Ripple delete' | 'Ripple group delete' };
export function remove(doc: ProjectDocument, ids: string[], opts: { ripple?: boolean; rippleGroupId?: string; path: 'tool' | 'ui' }): DeleteResult {
  if (!ids?.length) fail('MISSING_ITEM_IDS', 'itemIds is required');
  requireItems(doc, ids, 'ITEM_NOT_FOUND', missing => `Delete cancelled; unknown item ID(s): ${missing.join(', ')}`);
  const unique = [...new Set(ids)], sel = unique.map(id => item(doc, id)!);
  if (opts.path === 'ui') for (const i of sel) if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
  const gone = new Set(unique), also = doc.items.filter(x => !gone.has(x.id) && x.captionSourceItemId && gone.has(x.captionSourceItemId)).map(x => x.id);
  also.forEach(x => gone.add(x));
  const ripple = opts.ripple || !!opts.rippleGroupId, gaps = sel.filter(i => !isCaption(i));
  let shifted: string[] = [], label: DeleteResult['label'] = ripple ? 'Ripple delete' : 'Delete items';
  const removeAll = () => { doc.items = doc.items.filter(x => !gone.has(x.id)); doc.transitions = doc.transitions.filter(t => !gone.has(t.fromId) && !gone.has(t.toId)); };
  if (!ripple || !gaps.length) { removeAll(); return { deleted: unique, also, shifted, label }; }
  const groupsOf = new Set(gaps.map(i => opts.rippleGroupId && memberTracks(doc, opts.rippleGroupId).includes(i.trackId) ? opts.rippleGroupId : groupOf(doc, i.trackId)));
  if (opts.rippleGroupId && [...groupsOf].some(g => g !== opts.rippleGroupId)) fail('RIPPLE_OUTSIDE_GROUP', 'Delete selection is outside ripple group');
  if (groupsOf.size > 1 && [...groupsOf].some(Boolean)) fail('RIPPLE_MIXED_GROUPS', 'Ripple-delete one group at a time, or use regular delete for a mixed selection.');
  const g = [...groupsOf][0] ?? null;
  if (g) {
    const spans = gaps.map(i => i.display).sort((a, b) => a.from - b.from);
    let t = spans[0].from, r = spans[0].to;
    for (const s of spans.slice(1)) { if (s.from > r + EPS) fail('RIPPLE_NOT_CONTINUOUS', 'Group ripple delete needs a continuous interval'); r = Math.max(r, s.to); }
    removeAll();
    shifted = groupRipple(doc, g, t, r, 0, gone);
    return { deleted: unique, also, shifted, label: 'Ripple group delete' };
  }
  // Outside groups: each track closes its own gaps; captions are left out of the computation (§41c).
  const byTrack = new Map<string, RecordData[]>();
  for (const i of gaps) byTrack.set(i.trackId, [...(byTrack.get(i.trackId) ?? []), i]);
  for (const trackId of byTrack.keys()) if (trackLocked(doc, trackId)) fail('TRACK_LOCKED', `Track ${trackId} is locked`);
  removeAll();
  const moved = new Set<string>();
  for (const [trackId, removed] of byTrack) for (const x of itemsOn(doc, trackId)) {
    const by = removed.filter(d => d.display.to <= x.display.from + EPS).reduce((s, d) => s + span(d), 0);
    if (by > EPS) { x.display = { from: x.display.from - by, to: x.display.to - by }; moved.add(x.id); }
  }
  shifted = doc.items.filter(x => moved.has(x.id)).map(x => x.id);
  return { deleted: unique, also, shifted, label };
}

// ---- Insert after an item (part 2 §31, §37 "Insert items").
export function insertAfter(doc: ProjectDocument, refId: string, records: RecordData[]): string[] {
  const ref = item(doc, refId);
  if (!ref) fail('INSERT_AFTER_NOT_FOUND', 'insertAfter item not found', { message: `Item '${refId}' not found on the timeline.` });
  const t = track(doc, ref.trackId);
  if (!t) fail('INSERT_AFTER_NO_TRACK', 'insertAfter item not on any track');
  for (const r of records) if (!canInsertAfter(r.type, ref))
    fail('INSERT_AFTER_TYPE_MISMATCH', 'insertAfter type mismatch', { message: `Cannot insert ${r.type} after ${ref.type} item '${refId}'. The new item requires a compatible track kind.` });
  for (const r of records) if (kindOf(r.type) !== t.kind) fail('INVALID_TRACK', `Cannot insert ${r.type} on ${t.kind} track`);
  if (trackLocked(doc, t.id)) fail('TRACK_LOCKED', `Track ${t.id} is locked`);
  const at = ref.display.to, total = records.reduce((s, r) => s + span(r), 0), g = groupOf(doc, t.id);
  const shifted = rippleAt(doc, t.id, g, at, total, new Set(records.map(r => r.id)));
  let from = at;
  for (const r of records) { const len = span(r); r.trackId = t.id; r.display = { from, to: from + len }; from += len; doc.items.push(r); }
  return shifted;
}

// ---- Move an item out of its group onto a "<name> copy" track (findings §29).
export function moveOutOfGroup(doc: ProjectDocument, id: string): RecordData {
  const i = item(doc, id);
  if (!i) fail('ITEM_NOT_FOUND', `Item '${id}' not found`);
  const g = groupOf(doc, i.trackId), src = track(doc, i.trackId)!;
  if (!g) fail('NOT_IN_GROUP', 'This item is not in a group');
  if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
  // The new track sits at the root just above the group's entry (provisional position).
  let entry = g; for (const a of ancestors(doc, g)) entry = a;
  const index = doc.layerOrder.findIndex(e => e.id === entry);
  const t = insertTrack(doc, newTrack(doc, src.kind as TrackKind, `${src.name} copy`), { list: doc.layerOrder, index: index + 1 });
  i.trackId = t.id;
  return t;
}

// ---- Transform (contracts transformItem; part 2 §41b; part 5 §53.1.3).
const TRANSFORM_KEYS = ['x', 'y', 'scale', 'scaleBy', 'rotation', 'center', 'centerX', 'centerY', 'fitToCanvas', 'fillCanvas', 'alignTop', 'alignBottom'];
export function transform(doc: ProjectDocument, id: string, args: RecordData): { x: number; y: number; width: number; height: number } {
  const i = item(doc, id);
  if (!i) fail('ITEM_NOT_FOUND', 'Item not found', { message: `Item '${id}' not found on timeline.` });
  if (!TRANSFORM_KEYS.some(k => args[k] !== undefined && args[k] !== false)) fail('NO_PROPERTIES_PROVIDED', 'No valid properties provided');
  const bad = (message: string, details?: RecordData) => fail('PROPERTY_VALIDATION_FAILED', 'Property validation failed', { message, data: details });
  const scales = ['scale', 'scaleBy', 'fitToCanvas', 'fillCanvas'].filter(k => args[k] !== undefined && args[k] !== false);
  if (scales.length > 1) bad(`Use only one of scale, scaleBy, fitToCanvas or fillCanvas (received ${scales.join(', ')}).`);
  if (args.scaleBy !== undefined && !(typeof args.scaleBy === 'number' && args.scaleBy > 0)) bad(`scaleBy must be a number greater than 0. Received: ${JSON.stringify(args.scaleBy)}.`);
  if (args.scale !== undefined && !(typeof args.scale === 'number' && args.scale >= 0 && args.scale <= 100)) bad(`scale must be between 0 and 100. Received: ${JSON.stringify(args.scale)}.`);
  if (args.rotation !== undefined && !(typeof args.rotation === 'number' && args.rotation >= -360 && args.rotation <= 360)) bad(`rotation must be between -360 and 360. Received: ${JSON.stringify(args.rotation)}.`);
  for (const k of ['x', 'y']) if (args[k] !== undefined && !Number.isFinite(args[k])) bad(`${k} must be a finite number.`);
  if ((args.fitToCanvas || args.fillCanvas) && !['video', 'image'].includes(i.type)) bad('fitToCanvas and fillCanvas apply to video and image items only.');
  if ((args.alignTop || args.alignBottom) && !(i.type === 'text' || isCaption(i))) bad('alignTop and alignBottom apply to text items only.');
  if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
  // Works on the static values; changed ones are written back in the stored shape (keyframes untouched).
  const keys = ['width', 'height', 'scale', 'positionX', 'positionY', 'rotation'], W = doc.size.width, H = doc.size.height;
  i.properties ??= {};
  const p: RecordData = Object.fromEntries(keys.map(k => [k, prop(i, k)?.defaultValue])), was = { ...p };
  const w = p.width || i.details?.width || W, h = p.height || i.details?.height || H;
  let s = p.scale ?? 1;
  const size = () => ({ rw: Math.abs(w * s), rh: Math.abs(h * s) });
  if (args.fitToCanvas || args.fillCanvas) {
    const f = fitProperties(doc, { width: w, height: h }, args.fitToCanvas ? 'fit' : 'fill');
    s = f.scale; p.scale = s; p.positionX = f.positionX; p.positionY = f.positionY;
  }
  if (typeof args.scale === 'number') { s = args.scale; p.scale = s; }
  if (typeof args.scaleBy === 'number') {
    const before = size(); s = s * args.scaleBy; p.scale = s; const after = size();
    if (args.x === undefined) p.positionX = (p.positionX ?? 0) - (after.rw - before.rw) / 2;
    if (args.y === undefined) p.positionY = (p.positionY ?? 0) - (after.rh - before.rh) / 2;
  }
  if (typeof args.rotation === 'number') p.rotation = args.rotation;
  if (typeof args.x === 'number') p.positionX = args.x;
  if (typeof args.y === 'number') p.positionY = args.y;
  const { rw, rh } = size();
  if (args.center || args.centerX || args.alignTop || args.alignBottom) p.positionX = (W - rw) / 2;
  if (args.center || args.centerY) p.positionY = (H - rh) / 2;
  if (args.alignTop) p.positionY = Math.max(0, Math.round(0.3 * H) - rh);
  if (args.alignBottom) p.positionY = Math.round(0.7 * H);
  for (const k of keys) if (p[k] !== was[k]) setStatic(i, k, p[k]);
  return { x: p.positionX ?? 0, y: p.positionY ?? 0, width: rw, height: rh };
}

// ---- UI nudge (arrow keys: position ±5 px, Shift ±20 px; label "Edit items"). The default value and every keyframe
// move (findings §15: Cutframe offsets all keyframes, where Xapp moves only the default).
export function nudge(doc: ProjectDocument, ids: string[], dx: number, dy: number) {
  for (const id of ids) {
    const i = item(doc, id); if (!i || ['audio'].includes(i.type)) continue;
    if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
    for (const [key, d] of [['positionX', dx], ['positionY', dy]] as const) {
      const p = ensureProp(i, key, 0);
      p.defaultValue = Number(p.defaultValue ?? 0) + d;
      for (const k of p.keyframes) if (typeof k.value === 'number') k.value += d;
    }
  }
}

// ---- Paste at the playhead (part 2 §29): each copy keeps its track and its offset from the first copied item, and moves
// right past the items it overlaps; an overlap under 1 ms is snapped to that neighbour's edge; a copy that still overlaps is
// not placed. Provisional (Author question 12): a copy whose track is gone, locked or of another kind goes to the lowest
// free track of its kind at the paste point, else a new one.
export function paste(doc: ProjectDocument, records: RecordData[], at: number): RecordData[] {
  if (!records.length) return [];
  const base = Math.min(...records.map(r => r.display.from)), out: RecordData[] = [];
  for (const r of records) {
    const copy = structuredClone(r), kind = itemKind(r), len = span(r);
    let start = at + (r.display.from - base);
    copy.id = newId('item'); normaliseProperties(copy);
    const own = track(doc, r.trackId);
    if (own && own.kind === kind && !trackLocked(doc, own.id)) {
      for (const n of itemsOn(doc, own.id)) {
        const range = { from: start, to: start + len };
        if (!overlaps(n.display, range)) continue;
        const over = Math.min(range.to, n.display.to) - Math.max(range.from, n.display.from);
        start = over < 1 && n.display.from > range.from ? n.display.from - len : n.display.to;
      }
      if (start < 0 || blockers(doc, own.id, { from: start, to: start + len }).length) continue;
      copy.trackId = own.id;
    } else {
      copy.trackId = freeTracks(doc, kind, { from: start, to: start + len }).reverse()[0] ?? insertTrack(doc, newTrack(doc, kind)).id;
    }
    copy.display = { from: start, to: start + len };
    doc.items.push(copy); out.push(copy);
  }
  return out;
}
