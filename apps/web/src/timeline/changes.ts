// SPDX-License-Identifier: AGPL-3.0-only
// A0.3 `timelineChanges` (agent tool results §1): the net difference between the editor state before and after one
// tool call. Fixed header fields and Diff layout; changedFields use Cutframe's stored names with the "bag.key" rule.
import type { ProjectDocument, RecordData } from '../store/model';
import { sec, stack } from './model';

/** Fixed read-back hint, Xapp's exact wording (research §1.8.3 item 1: 22 stored results). */
export const READ_BACK = 'Use context or viewItemDetails for changed fields not included in these summaries, or for truncated text.';
const BAGS = new Set(['details', 'properties', 'metadata']);
const TEXT_CAP = 1000;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function changedFields(a: RecordData, b: RecordData): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'id') continue;
    if (BAGS.has(k) && (a[k] ?? {}) instanceof Object && (b[k] ?? {}) instanceof Object && !Array.isArray(a[k] ?? {}) && !Array.isArray(b[k] ?? {})) {
      const x = a[k] ?? {}, y = b[k] ?? {};
      for (const j of new Set([...Object.keys(x), ...Object.keys(y)])) if (!same(x[j], y[j])) out.push(`${k}.${j}`);
    } else if (!same(a[k], b[k])) out.push(k);
  }
  return out.sort();
}
function text(out: RecordData, value: unknown) {
  if (typeof value !== 'string') return;
  out.text = value.slice(0, TEXT_CAP);
  if (value.length > TEXT_CAP) { out.textTruncated = true; out.textLength = value.length; }
}
const itemText = (i: RecordData) => i.details?.text ?? (Array.isArray(i.details?.words) ? i.details.words.map((w: RecordData) => w.text ?? w.word ?? '').join(' ') : undefined);
function itemSummary(i: RecordData, withText: boolean): RecordData {
  const s: RecordData = { type: i.type, trackId: i.trackId, from: sec(i.display.from), to: sec(i.display.to) };
  if (i.trim && typeof i.trim.from === 'number') s.trim = { from: sec(i.trim.from), to: sec(i.trim.to) };
  // Research §1.8.3 item 2: Xapp never puts playbackRate in a motion-graphic item summary (21 stored results), and does for
  // other types when the item has one set.
  if (typeof i.playbackRate === 'number' && i.type !== 'motionGraphic') s.playbackRate = i.playbackRate;
  if (i.captionSourceItemId) s.captionSourceItemId = i.captionSourceItemId;
  if (Array.isArray(i.details?.words)) s.wordCount = i.details.words.length;
  if (withText && (i.type === 'text' || i.type === 'caption')) text(s, itemText(i));
  return s;
}
function trackSummary(doc: ProjectDocument, t: RecordData): RecordData {
  const s: RecordData = { kind: t.kind, name: t.name, order: stack(doc).indexOf(t.id), muted: !!t.muted, solo: !!t.solo, hidden: !!t.hidden, locked: !!t.locked };
  if (typeof t.volume === 'number') s.volume = t.volume;
  return s;
}
const groupSummary = (g: RecordData): RecordData => ({ name: g.name, children: (g.children ?? []).map((c: RecordData) => ({ id: c.id, type: c.type })), hidden: !!g.hidden, locked: !!g.locked });
const transitionSummary = (t: RecordData): RecordData => {
  const s: RecordData = { trackId: t.trackId, fromId: t.fromId, toId: t.toId, kind: t.kind, duration: sec(t.durationMs ?? 0), alignment: t.alignment ?? 0.5 };
  if (t.direction !== undefined) s.direction = t.direction;
  return s;
};
const markerSummary = (m: RecordData): RecordData => { const s: RecordData = { time: sec(m.timeMs) }; text(s, m.label); return s; };
function settings(doc: ProjectDocument): RecordData {
  const bg = doc.background ?? { type: 'color', value: 'transparent' };
  return { duration: sec(doc.duration), fps: doc.fps, size: { width: doc.size.width, height: doc.size.height }, background: bg.type === 'color' ? { type: bg.type, value: bg.value } : { type: bg.type } };
}

type Summary = (record: RecordData, doc: ProjectDocument, full: boolean) => RecordData;
function diff(before: RecordData[], after: RecordData[], key: string, summary: Summary, a: ProjectDocument, b: ProjectDocument, textKeys = false) {
  const old = new Map(before.map(r => [r.id, r])), now = new Map(after.map(r => [r.id, r]));
  const created = after.filter(r => !old.has(r.id)).map(r => ({ [key]: r.id, ...summary(r, b, true) }));
  const deleted = before.filter(r => !now.has(r.id)).map(r => ({ [key]: r.id, ...summary(r, a, true) }));
  const updated: RecordData[] = [];
  for (const r of after) {
    const p = old.get(r.id); if (!p) continue;
    const fields = changedFields(p, r), was = summary(p, a, false), is = summary(r, b, false);
    // Stack order is derived, so a re-stacked track counts as changed through `order`.
    if (!fields.length && same(was, is)) continue;
    if (!fields.length) fields.push(...Object.keys(is).filter(k => !same(was[k], is[k])));
    const full = textKeys && fields.some(f => f === 'details.text' || f === 'details.words');
    updated.push({ [key]: r.id, changedFields: fields.sort(), before: full ? summary(p, a, true) : was, after: full ? summary(r, b, true) : is });
  }
  return created.length || updated.length || deleted.length ? { created, updated, deleted } : null;
}

/** The change report for one call, or undefined when nothing changed. */
export function timelineChanges(a: ProjectDocument, b: ProjectDocument): RecordData | undefined {
  const out: RecordData = { basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true, readBack: READ_BACK };
  let any = false;
  const put = (k: string, v: RecordData | null) => { if (v) { out[k] = v; any = true; } };
  put('items', diff(a.items, b.items, 'itemId', (r, _d, full) => itemSummary(r, full), a, b, true));
  put('tracks', diff(a.tracks, b.tracks, 'id', (r, d) => trackSummary(d, r), a, b));
  const groups = (d: ProjectDocument) => Object.entries(d.groups ?? {}).map(([id, g]) => ({ ...g, id }));
  put('groups', diff(groups(a), groups(b), 'id', r => groupSummary(r), a, b));
  put('transitions', diff(a.transitions ?? [], b.transitions ?? [], 'id', r => transitionSummary(r), a, b));
  put('markers', diff(a.markers ?? [], b.markers ?? [], 'id', r => markerSummary(r), a, b));
  const ref = (d: ProjectDocument) => (d.layerOrder ?? []).map(e => ({ id: e.id, type: e.type }));
  if (!same(ref(a), ref(b))) { out.layerOrder = { before: ref(a), after: ref(b) }; any = true; }
  const sa = settings(a), sb = settings(b), fields = Object.keys(sa).filter(k => !same(sa[k], sb[k])).sort();
  if (fields.length) { out.settings = { changedFields: fields, before: sa, after: sb }; any = true; }
  return any ? out : undefined;
}
