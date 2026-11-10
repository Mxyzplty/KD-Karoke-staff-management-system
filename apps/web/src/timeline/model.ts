// SPDX-License-Identifier: AGPL-3.0-only
// T03 timeline rules shared by every command: units, item/track kinds, stack order, auto names, placement by kind,
// effective locks, overlap and free-space search (findings §3, part 2 §29, §31, §37). Pure functions over a document.
import type { ProjectDocument, RecordData } from '../store/model';
import { layerEntries } from '../editor/geometry';
import type { Entry } from '../editor/geometry';

/** A refused command: nothing changed. `error` is the agent-facing text; extra fields preserve the tool's failure envelope. */
export class CommandError extends Error {
  constructor(public code: string, public error: string, public extra: { message?: string; data?: RecordData; details?: RecordData; mayHaveRun?: boolean; failures?: RecordData[] } = {}) { super(error); }
}
export function fail(code: string, error: string, extra?: CommandError['extra']): never { throw new CommandError(code, error, extra); }

// ---- Units: the document stores ms; agent tools speak seconds.
export const toMs = (s: number) => Math.round(s * 1e6) / 1e3;
export const sec = (ms: number) => ms / 1000;
/** Seconds in messages: up to 3 decimals, no trailing zeros ("2.5s"). */
export const fmt = (ms: number) => String(+(ms / 1000).toFixed(3));
export const EPS = 1e-6;

export type TrackKind = 'video' | 'audio' | 'caption' | 'overlay';
/** Caption = a caption item, or a text item marked as a caption (provisional field `details.subType`; part 2 §41c). */
export const isCaption = (item: RecordData) => item.type === 'caption' || (item.type === 'text' && item.details?.subType === 'caption');
/** Track kind an item type lives on (§29 move rules; §31 insertAfter table: video/image, audio, caption, text/shape/motionGraphic/layout). */
export const kindOf = (type: string): TrackKind => type === 'video' || type === 'image' ? 'video' : type === 'audio' ? 'audio' : type === 'caption' ? 'caption' : 'overlay';
export const itemKind = (item: RecordData): TrackKind => isCaption(item) ? 'caption' : kindOf(item.type);
export const MEDIA_TYPES = new Set(['video', 'audio', 'motionGraphic']);
export const KINDS: TrackKind[] = ['video', 'audio', 'caption', 'overlay'];
export const PREFIX: Record<TrackKind, string> = { video: 'V', audio: 'A', caption: 'C', overlay: 'O' };

// ---- Ids: injectable so tests and the G-01 replay are deterministic.
let idSource: () => string = () => Math.random().toString(36).slice(2, 12).padEnd(10, '0');
export const newId = (prefix: string) => `${prefix}_${idSource()}`;
export function setIdSource(source: (() => string) | null) { idSource = source ?? (() => Math.random().toString(36).slice(2, 12).padEnd(10, '0')); }

// ---- Lookup.
export const track = (doc: ProjectDocument, id: string) => doc.tracks.find(t => t.id === id);
export const item = (doc: ProjectDocument, id: string) => doc.items.find(i => i.id === id);
export const itemsOn = (doc: ProjectDocument, trackId: string) => doc.items.filter(i => i.trackId === trackId).sort((a, b) => a.display.from - b.display.from);
export const span = (i: RecordData) => i.display.to - i.display.from;

// ---- Stack: layerOrder is bottom-first; groups nest entries (part 2 §37).
/** Track ids bottom-to-top, groups flattened in place. */
export function stack(doc: ProjectDocument): string[] {
  const out: string[] = [], walk = (list: Entry[]) => list.forEach(e => e.type === 'group' ? walk((doc.groups[e.id]?.children ?? []) as Entry[]) : out.push(e.id));
  walk(layerEntries(doc));
  return out.filter(id => track(doc, id));
}
/** Direct parent group of each entry id (tracks and groups). */
export function parents(doc: ProjectDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, g] of Object.entries(doc.groups)) for (const c of (g.children ?? []) as Entry[]) out.set(c.id, id);
  return out;
}
export const groupOf = (doc: ProjectDocument, trackId: string) => parents(doc).get(trackId) ?? null;
/** Every group containing the entry, innermost first. */
export function ancestors(doc: ProjectDocument, id: string): string[] {
  const p = parents(doc), out: string[] = [];
  for (let g = p.get(id); g && !out.includes(g); g = p.get(g)) out.push(g);
  return out;
}
/** Locked = the track's own flag or any enclosing group's lock (§29: "Group is locked"). */
export const trackLocked = (doc: ProjectDocument, trackId: string) => !!track(doc, trackId)?.locked || ancestors(doc, trackId).some(g => doc.groups[g]?.locked);
/** The entry list that holds `id` (root layerOrder or a group's children), materialising the §53.5 repair first. */
export function siblings(doc: ProjectDocument, id: string): Entry[] {
  normaliseLayerOrder(doc);
  const g = parents(doc).get(id);
  return g ? doc.groups[g].children : doc.layerOrder;
}
/** Writes layerEntries' missing-track repair into the stored order, so later splices see every track. */
export function normaliseLayerOrder(doc: ProjectDocument) {
  const entries = layerEntries(doc);
  if (entries.length !== doc.layerOrder.length) doc.layerOrder = entries;
}
export function memberTracks(doc: ProjectDocument, groupId: string): string[] {
  const out: string[] = [], walk = (list: Entry[]) => list.forEach(e => e.type === 'group' ? walk((doc.groups[e.id]?.children ?? []) as Entry[]) : out.push(e.id));
  walk((doc.groups[groupId]?.children ?? []) as Entry[]);
  return out;
}
export function removeEntry(doc: ProjectDocument, id: string) {
  const list = siblings(doc, id), i = list.findIndex(e => e.id === id);
  if (i >= 0) list.splice(i, 1);
}

// ---- Names and placement (part 2 §29).
export function autoName(doc: ProjectDocument, kind: TrackKind): string {
  const p = PREFIX[kind], taken = new Set(doc.tracks.filter(t => t.kind === kind).map(t => String(t.name)));
  let n = 1; while (taken.has(`${p}${n}`)) n++;
  return `${p}${n}`;
}
export const newTrack = (doc: ProjectDocument, kind: TrackKind, name?: string): RecordData =>
  ({ id: newId('track'), name: name ?? autoName(doc, kind), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
const holds = (doc: ProjectDocument, e: Entry, test: (t: RecordData) => boolean): boolean =>
  e.type === 'group' ? ((doc.groups[e.id]?.children ?? []) as Entry[]).some(c => holds(doc, c, test)) : test(track(doc, e.id) ?? {});
/** Index in `list` where a new track of this kind goes: caption top, audio bottom, video/overlay just above the highest non-caption entry. */
export function placementIndex(doc: ProjectDocument, list: Entry[], kind: TrackKind): number {
  if (kind === 'caption') return list.length;
  if (kind === 'audio') return 0;
  for (let i = list.length - 1; i >= 0; i--) if (holds(doc, list[i], t => t.kind !== 'caption')) return i + 1;
  return 0;
}
/** Adds a track at the root by the kind rule (or at `index` in `list`); returns it. */
export function insertTrack(doc: ProjectDocument, record: RecordData, at?: { list: Entry[]; index: number }) {
  normaliseLayerOrder(doc);
  doc.tracks.push(record);
  const list = at?.list ?? doc.layerOrder, index = at?.index ?? placementIndex(doc, list, record.kind);
  list.splice(index, 0, { type: 'track', id: record.id });
  return record;
}

// ---- Gain rule (part 2 §29): muted, or any track soloed and not this one → 0, else volume clamped to 0…1.
// Solo changes sound only (picture of non-soloed tracks still shows).
export function trackGain(doc: ProjectDocument, trackId: string): number {
  const t = track(doc, trackId); if (!t) return 0;
  const anySolo = doc.tracks.some(x => x.solo);
  if (t.muted || (anySolo && !t.solo)) return 0;
  return Math.min(1, Math.max(0, t.volume ?? 1));
}

// ---- Overlap and free space. Spans are half-open [from, to).
export const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to - EPS && b.from < a.to - EPS;
export function blockers(doc: ProjectDocument, trackId: string, range: { from: number; to: number }, exclude: ReadonlySet<string> = new Set()): RecordData[] {
  return itemsOn(doc, trackId).filter(i => !exclude.has(i.id) && overlaps(i.display, range));
}
/** First start ≥ `from` where `length` fits on the track. */
export function nextFree(doc: ProjectDocument, trackId: string, from: number, length: number, exclude: ReadonlySet<string> = new Set()): number {
  let start = Math.max(0, from);
  for (const i of itemsOn(doc, trackId).filter(i => !exclude.has(i.id))) if (overlaps(i.display, { from: start, to: start + length })) start = i.display.to;
  return start;
}
/** Unlocked tracks of a kind with room for the range, top-first (provisional order). */
export function freeTracks(doc: ProjectDocument, kind: TrackKind, range: { from: number; to: number }, exclude: ReadonlySet<string> = new Set(), skip?: string): string[] {
  return stack(doc).reverse().filter(id => id !== skip && track(doc, id)!.kind === kind && !trackLocked(doc, id) && !blockers(doc, id, range, exclude).length);
}

/** Content end: the last item end; an empty timeline keeps the 1000 ms default (provisional). */
export const contentEnd = (doc: ProjectDocument) => doc.items.length ? Math.max(...doc.items.map(i => i.display.to)) : 1000;
/** Source length of a media item in source ms (null when unknown or not media). */
export const sourceLength = (i: RecordData): number | null => MEDIA_TYPES.has(i.type) && typeof i.sourceDuration === 'number' && i.sourceDuration > 0 ? i.sourceDuration : null;
export const rate = (i: RecordData) => i.playbackRate ?? 1;
