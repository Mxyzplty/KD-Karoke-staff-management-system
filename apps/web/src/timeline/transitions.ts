// SPDX-License-Identifier: AGPL-3.0-only
// T11 transitions on the T03 command path (findings §9; part 5 §55.1–§55.3; part 3 §46.8): the registry, the stored record and
// its limits, the shared add / update step (round, then clamp; refuse only "too short"), repair after item edits, the window
// around the cut (chained windows share a clip), the agent tool applyTransition (contracts #27, results §2 and §11; error codes
// §7) and the UI edits (diamond add, popover picks, edge drag, trash). The per-kind pictures are render/transitions.ts.
// Provisional, not Xapp parity (T11 notes): the tie rule of atSeconds, the wordings marked "own", a record whose clips no
// longer meet is kept and not drawn (Xapp's repair only covers length), the agent `update` label "Edit transition".
import type { ProjectDocument, RecordData } from '../store/model';
import { fail, item, itemsOn, span, trackLocked } from './model';
import type { ToolContext, ToolResult } from './tools';

export const KINDS = ['fade', 'dissolve', 'additiveDissolve', 'dipToColorDissolve', 'slide', 'wipe'] as const;
export type Kind = typeof KINDS[number];
export const DIRECTIONS = ['from-left', 'from-right', 'from-top', 'from-bottom'] as const;
export type Direction = typeof DIRECTIONS[number];
/** Every kind: default 1000 ms, 100–3000 ms (§55.1). */
export const DEFAULT_KIND: Kind = 'fade', DEFAULT_MS = 1000, MIN_MS = 100, MAX_MS = 3000;
/** Agent alignment words (§55.1): start = the window starts at the cut, end = it finishes there. */
export const ALIGNMENTS = { start: 0, center: 0.5, end: 1 } as const;
export type AlignmentWord = keyof typeof ALIGNMENTS;
/** The popover's groups and labels (part 3 §46.8, W3-ED-18). */
export const KIND_LABELS: Record<Kind, string> = { fade: 'Fade', dissolve: 'Cross Dissolve', additiveDissolve: 'Additive Dissolve', dipToColorDissolve: 'Dip To Color', slide: 'Push', wipe: 'Wipe' };
export const KIND_GROUPS: [string, Kind[]][] = [['BASIC', ['fade']], ['DISSOLVE', ['dissolve', 'additiveDissolve', 'dipToColorDissolve']], ['MOTION', ['slide']], ['WIPE', ['wipe']]];
export const hasDirection = (kind: string) => kind === 'slide' || kind === 'wipe';
/** Cut search radius of atSeconds (contracts #27). */
export const NEAR_MS = 500;
/** Two clips meet when |outgoing end − incoming start| ≤ 1 ms (§55.1). */
const MEET_MS = 1;

const s2 = (ms: number) => (ms / 1000).toFixed(2);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
export const isVisual = (i: RecordData) => i.type === 'video' || i.type === 'image';
/** The outgoing clip ends where the incoming one starts, on one track (no type check: that is the add step's). */
export const meets = (outgoing: RecordData, incoming: RecordData) => outgoing.trackId === incoming.trackId && Math.abs(outgoing.display.to - incoming.display.from) <= MEET_MS;
/** floor(min(outgoing length, incoming length, 3000)): clip length caps it, source handles never do (§55.1). */
export const maxMs = (outgoing: RecordData, incoming: RecordData) => Math.floor(Math.min(span(outgoing), span(incoming), MAX_MS));
/** The shared add / update step: refuses a pair whose maximum is under 100 ms, else round to whole ms and clamp. */
export function resolveMs(requestedMs: number, maximum: number): number {
  if (maximum < MIN_MS) fail('INVALID_PAIR', 'Transition rejected', { message: `These clips are too short for a transition (min ${MIN_MS}ms)` });
  return clamp(Math.round(requestedMs), MIN_MS, maximum);
}
/** Direction kinds keep one of the four directions (anything else → from-left); other kinds have none. */
export const directionFor = (kind: string, direction: unknown): Direction | undefined =>
  hasDirection(kind) ? (DIRECTIONS as readonly unknown[]).includes(direction) ? direction as Direction : 'from-left' : undefined;
/** Stored alignment clamped to [0, 1]; missing or non-finite = 0.5. */
export const alignmentOf = (r: RecordData) => typeof r.alignment === 'number' && Number.isFinite(r.alignment) ? clamp(r.alignment, 0, 1) : 0.5;
export const alignmentWord = (a: number): AlignmentWord => a === 0 ? 'start' : a === 1 ? 'end' : 'center';
/** Stored length; a record without a finite one has the kind default (§55.1). */
export const durationOf = (r: RecordData): number => typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : DEFAULT_MS;

/** The two clips of a record, or null when one is gone or they no longer meet (kept, not drawn: Q4). */
export function pairOf(doc: ProjectDocument, r: RecordData): { from: RecordData; to: RecordData } | null {
  const from = item(doc, r.fromId), to = item(doc, r.toId);
  return from && to && meets(from, to) ? { from, to } : null;
}
export const transitionAt = (doc: ProjectDocument, fromId: string, toId: string) => (doc.transitions ?? []).find(r => r.fromId === fromId && r.toId === toId);

// ---- Window (§55.2).
/** Pre-cut part floor(D × a) and post-cut part D − pre, D = max(1, floor(duration)). */
export function windowParts(durationMs: number, alignment: number) {
  const d = Math.max(1, Math.floor(durationMs)), pre = Math.floor(d * alignment);
  return { pre, post: d - pre };
}
/** A clip of length L with incoming part i and outgoing part o: when i + o > L both scale by L / (i + o), floored, and the
 *  leftover ms go one at a time to i when its shortfall ≥ o's, else to o. Shortfall = scaled value − floored value, as the
 *  T00 oracle reads it (open point, T11 notes). Example: L = 777, 500 + 500 → 389 / 388. */
export function chainParts(length: number, i: number, o: number): [number, number] {
  if (i + o <= length) return [i, o];
  const k = length / (i + o);
  let a = Math.floor(i * k), b = Math.floor(o * k);
  for (let left = Math.floor(length) - a - b; left > 0; left--) { if (i * k - a >= o * k - b) a++; else b++; }
  return [a, b];
}
export type Window = { cut: number; pre: number; post: number; start: number; end: number };
/** The record's window [cut − pre, cut + post) after the chain rule on both clips; null when its clips do not meet. */
export function windowOf(doc: ProjectDocument, r: RecordData): Window | null {
  const pair = pairOf(doc, r);
  if (!pair) return null;
  let { pre, post } = windowParts(durationOf(r), alignmentOf(r));
  const live = (q: RecordData) => q !== r && pairOf(doc, q);
  const before = (doc.transitions ?? []).find(q => q.toId === r.fromId && live(q)), after = (doc.transitions ?? []).find(q => q.fromId === r.toId && live(q));
  if (before) pre = chainParts(span(pair.from), windowParts(durationOf(before), alignmentOf(before)).post, pre)[1];
  if (after) post = chainParts(span(pair.to), post, windowParts(durationOf(after), alignmentOf(after)).pre)[0];
  const cut = pair.to.display.from;
  return { cut, pre, post, start: cut - pre, end: cut + post };
}
/** p = (t − start) / length inside the half-open window, else null. */
export const progressAt = (t: number, w: Window) => t >= w.start && t < w.end && w.end > w.start ? (t - w.start) / (w.end - w.start) : null;
export type Active = { record: RecordData; from: RecordData; to: RecordData; window: Window; p: number };
/** The transitions drawn at timeline ms t (at most one per track: chained windows never overlap). */
export function activeAt(doc: ProjectDocument, t: number): Active[] {
  const out: Active[] = [];
  for (const record of doc.transitions ?? []) {
    const pair = pairOf(doc, record), window = pair && windowOf(doc, record), p = window && progressAt(t, window);
    if (pair && window && p !== null) out.push({ record, ...pair, window, p });
  }
  return out;
}

// ---- Repair (§55.1): after every edit that changes items (bus.ts). Maximum under 100 ms → removed; over → clamped down.
export function repairTransitions(doc: ProjectDocument) {
  if (!doc.transitions?.length) return;
  doc.transitions = doc.transitions.filter(r => {
    const from = item(doc, r.fromId), to = item(doc, r.toId);
    if (!from || !to) return false;
    const m = maxMs(from, to);
    if (m < MIN_MS) return false;
    if (r.durationMs > m) r.durationMs = m;
    // Both clips moved to another track together and still meet there: the record follows them.
    if (meets(from, to) && r.trackId !== from.trackId) r.trackId = from.trackId;
    return true;
  });
}

// ---- Cut lookup (results §2 "Cut not resolved").
const cutNotResolved = (code: string, message: string): never => fail(code, 'Cut not resolved', { message });
const describe = (from: RecordData, to: RecordData) => `${from.id} → ${to.id} at ${s2(to.display.from)}s`;
/** betweenItems in either order: the clip that ends where the other starts is the outgoing one. */
export function cutBetween(doc: ProjectDocument, a: string, b: string): { from: RecordData; to: RecordData } {
  const x = item(doc, a), y = item(doc, b), missing = !x ? a : !y ? b : null;
  // Own wording (the code is the doc's, results §2).
  if (missing !== null) cutNotResolved('ITEM_NOT_FOUND', `Item '${missing}' not found on the timeline. Read context for current item ids.`);
  if (x!.trackId !== y!.trackId) cutNotResolved('INVALID_PAIR', 'The two items are on different tracks — transitions need an adjacent same-track pair.');
  if (meets(x!, y!)) return { from: x!, to: y! };
  if (meets(y!, x!)) return { from: y!, to: x! };
  const [first, second] = x!.display.from <= y!.display.from ? [x!, y!] : [y!, x!];
  // Own wording: Xapp's text gives both edges in ms (results §2), its exact form is not stored.
  return cutNotResolved('INVALID_PAIR', `'${first.id}' ends at ${Math.round(first.display.to)}ms and '${second.id}' starts at ${Math.round(second.display.from)}ms, so they do not meet at a cut — transitions need two adjacent clips.`);
}
/** Every cut between meeting neighbours, track by track in document order (UI diamonds and atSeconds). */
export function cuts(doc: ProjectDocument): { from: RecordData; to: RecordData }[] {
  const out: { from: RecordData; to: RecordData }[] = [];
  for (const t of doc.tracks) {
    const list = itemsOn(doc, t.id);
    for (let k = 1; k < list.length; k++) if (meets(list[k - 1], list[k])) out.push({ from: list[k - 1], to: list[k] });
  }
  return out;
}
/** The nearest cut within 0.5 s of atSeconds on any track; a tie goes to the earlier cut, then the earlier track (Q3). */
export function cutNear(doc: ProjectDocument, seconds: number): { from: RecordData; to: RecordData } {
  const t = seconds * 1000;
  let best: { from: RecordData; to: RecordData } | null = null, d = Infinity;
  for (const c of cuts(doc)) {
    const e = Math.abs(c.to.display.from - t);
    if (e <= NEAR_MS + 1e-6 && (e < d || (e === d && best && c.to.display.from < best.to.display.from))) { best = c; d = e; }
  }
  return best ?? cutNotResolved('CUT_NOT_FOUND', `No cut between adjacent clips within 0.5s of ${seconds}s. Use 'betweenItems' with the two item ids instead.`);
}

// ---- The shared add / update step (the agent's add and update, every UI add and edit).
export type Patch = { kind?: unknown; durationMs?: number; alignment?: number; direction?: unknown; params?: unknown };
const rejected = (code: string, message: string): never => fail(code, 'Transition rejected', { message });
/** Builds the stored record for the cut from `base` (the record it replaces or updates, or none) and the patch. */
function resolved(doc: ProjectDocument, from: RecordData, to: RecordData, base: RecordData | null, patch: Patch, id: string): RecordData {
  const kind = patch.kind ?? base?.kind ?? DEFAULT_KIND;
  if (!(KINDS as readonly unknown[]).includes(kind)) rejected('UNKNOWN_KIND', `Unknown transition kind '${String(kind)}'. Available: ${KINDS.join(', ')}`);
  if (!isVisual(from) || !isVisual(to)) rejected('INVALID_PAIR', 'Transitions only work with video and image clips');
  const durationMs = resolveMs(patch.durationMs ?? base?.durationMs ?? DEFAULT_MS, maxMs(from, to));
  const record: RecordData = { id, trackId: from.trackId, fromId: from.id, toId: to.id, kind, durationMs, alignment: patch.alignment ?? (base ? alignmentOf(base) : 0.5) };
  const direction = directionFor(kind as string, patch.direction ?? base?.direction);
  if (direction) record.direction = direction;
  const params = patch.params !== undefined ? patch.params : base?.params;
  if (params !== undefined) record.params = params; // stored as given (§55.6); the renderers clamp
  return record;
}
const write = (doc: ProjectDocument, record: RecordData) => {
  doc.transitions ??= [];
  const k = doc.transitions.findIndex(r => r.id === record.id);
  if (k >= 0) doc.transitions[k] = record; else doc.transitions.push(record);
};
const newTransitionId = () => `transition_${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`;

// ---- applyTransition (contracts #27; results §2, §11). Not gated by the stale-read check.
const missing = (error: string, message: string): never => fail('MISSING_PARAMETERS', error, { message });
export function applyTransition(ctx: ToolContext, args: RecordData): ToolResult {
  const action = args.action, between = args.betweenItems;
  if (!['add', 'update', 'remove'].includes(action) || (between === undefined && args.atSeconds === undefined))
    missing('Missing parameters', "applyTransition needs 'action' (add/update/remove) plus a cut address: 'betweenItems' ([outgoingId, incomingId]) or 'atSeconds'.");
  if (between !== undefined && (!Array.isArray(between) || between.length !== 2))
    missing('Missing parameters', `'betweenItems' needs exactly two item ids (got ${Array.isArray(between) ? between.length : 0}).`);
  if (args.alignment !== undefined && !Object.hasOwn(ALIGNMENTS, args.alignment)) missing('Invalid alignment', "'alignment' must be start, center, or end.");
  if (between === undefined && !(typeof args.atSeconds === 'number' && Number.isFinite(args.atSeconds)))
    missing('Missing parameters', "applyTransition needs 'action' (add/update/remove) plus a cut address: 'betweenItems' ([outgoingId, incomingId]) or 'atSeconds'.");
  const label = action === 'add' ? 'Add transition' : action === 'update' ? 'Edit transition' : 'Remove transition';
  return ctx.bus.run(label, 'agent', (doc, tx) => {
    const { from, to } = between !== undefined ? cutBetween(doc, String(between[0]), String(between[1])) : cutNear(doc, args.atSeconds);
    if (trackLocked(doc, from.trackId)) fail('TRACK_LOCKED', `Track ${from.trackId} is locked`); // D32 Q17; own ordering: resolved cut, then lock.
    const existing = transitionAt(doc, from.id, to.id) ?? null;
    if (action === 'remove') {
      // Own wording after "on the cut" (results §2 gives the sentence with a placeholder).
      if (!existing) return { success: true, message: `There is no transition on the cut ${describe(from, to)}, so nothing was removed.` };
      doc.transitions = doc.transitions.filter(r => r !== existing);
      return { success: true, message: `Removed the ${existing.kind} transition on ${from.id} → ${to.id} at ${s2(to.display.from)}s.` };
    }
    if (action === 'update' && !existing) fail('TRANSITION_NOT_FOUND', 'No transition', { message: `There is no transition on the cut ${describe(from, to)} to update — use action 'add'.` });
    if (action === 'add' && existing) tx.label = 'Change transition';
    const requested = typeof args.durationSeconds === 'number' ? Math.round(args.durationSeconds * 1000) : action === 'update' ? existing!.durationMs : DEFAULT_MS;
    // add replaces the whole record (keeping its id); update merges only the given fields.
    const record = resolved(doc, from, to, action === 'update' ? existing : null, {
      kind: args.kind, durationMs: requested, alignment: args.alignment === undefined ? undefined : ALIGNMENTS[args.alignment as AlignmentWord], direction: args.direction, params: args.params,
    }, existing?.id ?? newTransitionId());
    write(doc, record);
    const verb = action === 'update' ? 'Updated' : existing ? 'Replaced' : 'Added', word = alignmentWord(record.alignment);
    // Own wording after the dash: Xapp's sentence blames hidden source handles, but clip length is the cap (§55.7).
    const clamped = record.durationMs !== requested ? ` Duration clamped to ${s2(record.durationMs)}s — a transition lasts from 0.10s up to the shorter clip's length, at most 3.00s.` : '';
    const transition: RecordData = { id: record.id, kind: record.kind, durationSeconds: record.durationMs / 1000, alignment: word };
    if (record.direction) transition.direction = record.direction;
    if (record.params !== undefined) transition.params = record.params;
    return { success: true, message: `${verb} ${record.kind} transition (${s2(record.durationMs)}s, ${word} on the cut) on ${from.id} → ${to.id} at ${s2(to.display.from)}s.${clamped}`, data: { transition } };
  }) as ToolResult;
}

// ---- UI edits, each inside the caller's bus command (part 3 §46.8): "Add transition", "Edit transition", "Remove transition".
/** The diamond: Fade, 1.0 s, Center on the cut (clamped like any add; a pair under 100 ms is refused). */
export function addAtCut(doc: ProjectDocument, fromId: string, toId: string): RecordData {
  const from = item(doc, fromId), to = item(doc, toId);
  if (!from || !to || !meets(from, to)) fail('CUT_NOT_FOUND', 'Cut not resolved', { message: 'These clips no longer meet at a cut.' }); // own wording
  if (trackLocked(doc, from.trackId)) fail('TRACK_LOCKED', `Track ${from.trackId} is locked`);
  if (transitionAt(doc, fromId, toId)) fail('INVALID_PAIR', 'Transition rejected', { message: 'This cut already has a transition.' }); // own wording; the UI hides the diamond
  const record = resolved(doc, from, to, null, { kind: DEFAULT_KIND, durationMs: DEFAULT_MS, alignment: 0.5 }, newTransitionId());
  write(doc, record);
  return record;
}
/** A popover pick or an edge drag. A kind switch resets the direction to from-left (W3-RT-04); params are kept (§55.6). */
export function editTransition(doc: ProjectDocument, id: string, patch: Patch): RecordData {
  const base = (doc.transitions ?? []).find(r => r.id === id), pair = base && pairOf(doc, base);
  if (!base || !pair) fail('TRANSITION_NOT_FOUND', 'No transition', { message: 'This transition no longer exists.' }); // own wording
  const direction = patch.kind !== undefined && patch.kind !== base.kind ? 'from-left' : patch.direction;
  const record = resolved(doc, pair.from, pair.to, base, { ...patch, direction }, id);
  write(doc, record);
  return record;
}
export function removeTransition(doc: ProjectDocument, id: string) { doc.transitions = (doc.transitions ?? []).filter(r => r.id !== id); }
