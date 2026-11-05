// SPDX-License-Identifier: AGPL-3.0-only
// The `context` tool, layout L only (agent tool results §2 `context`; T18a scope). Layouts C and S need item content,
// transcripts, effects, keyframes and masks, which T18 serves: those `include` words return NOT_IMPLEMENTED with the owner.
// The projection repeats parity/g01.ts `contextL` (that module reads files, so the web bundle cannot import it).
import type { ProjectDocument, RecordData } from '../store/model';
import { isCaption, itemsOn, stack } from '../timeline/model';
import { groupSummary, trackSummary } from '../timeline/tracks';
import { layerEntries } from '../editor/geometry';
import type { ToolResult } from './protocol';

type Rec = Record<string, unknown>;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const TYPES = ['video', 'image', 'audio', 'text', 'caption', 'shape', 'motionGraphic', 'layout'];
const DETAIL = ['transcript', 'transcript_words', 'effects', 'keyframes', 'masks'];
export const TEXT_COLLAPSE = 80;
export const CAPTION_GAP_S = 1.5;
export const CONTEXT_OWNER = 'T18';

// Fixed hints. Xapp's exact sentences are not stored (results §2 `context`: "<fixed hint>"), so these are Cutframe wording.
export const HINTS = {
  tracks: 'Tracks are keyed by persistent track id and listed top to bottom (layerIndex 0 draws on top). Empty tracks are included.',
  textOverflow: `More than ${TEXT_COLLAPSE} text items are in scope, so text tracks show only their item count. Pass startSeconds and endSeconds to list a shorter window.`,
  captionNote: 'Caption tracks show only their time ranges. Pass types: "caption" (optionally with startSeconds and endSeconds) to list the caption items.',
  note: 'include "content" without types returns this light overview. Item content (include "content" with types) is not available in this version.',
};
export const WORDS_ERROR = 'transcript_words requires startSeconds and endSeconds. Use include: "transcript" for sentence-level across the full timeline.';

/** CSV string or array → trimmed, non-empty words. */
const words = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(w => String(w).trim()).filter(Boolean);
const itemType = (i: RecordData): string => isCaption(i) ? 'caption' : String(i.type);
const canonicalType = (t: string) => TYPES.find(k => k.toLowerCase() === t.toLowerCase()) ?? t.toLowerCase();
const captionRanges = (items: { start: number; end: number }[]) => items.reduce<{ start: number; end: number }[]>((out, i) => {
  const last = out[out.length - 1];
  if (last && i.start - last.end <= CAPTION_GAP_S + 1e-9) last.end = Math.max(last.end, i.end); else out.push({ start: i.start, end: i.end });
  return out;
}, []);

function notImplemented(layout: 'C' | 'S', asked: string[]): ToolResult {
  const what = layout === 'C' ? 'item content (include "content" with types)' : `${asked.join(', ')} details`;
  return { success: false, code: 'NOT_IMPLEMENTED', owner: CONTEXT_OWNER, error: `context layout ${layout} is not implemented yet`,
    message: `This version reads only the light overview; ${what} arrives with ${CONTEXT_OWNER}. Call context without include, or with include "timing" or "markers".` };
}

/** `context` → `{success:true, data}` in layout L, or the documented refusal. */
export function readContext(doc: ProjectDocument, input: Rec = {}): ToolResult {
  const include = new Set(words(input.include).map(w => w.toLowerCase()).map(w => w === 'basic' ? 'content' : w));
  const typeList = words(input.types).map(canonicalType), types = typeList.length ? new Set(typeList) : undefined;
  const start = input.startSeconds, end = input.endSeconds, windowed = typeof start === 'number' && typeof end === 'number';
  if (include.has('transcript_words') && !windowed) return { success: false, code: 'INVALID_TOOL_INPUT', error: WORDS_ERROR };
  const content = include.has('content'), details = DETAIL.filter(w => include.has(w));
  if (!(include.has('timing') || (!content && !details.length) || (content && !types))) return content ? notImplemented('C', []) : notImplemented('S', details);

  const inWindow = (i: RecordData) => !windowed || (i.display.from / 1000 < (end as number) && i.display.to / 1000 > (start as number));
  const order = [...stack(doc)].reverse();
  const scoped = new Map(order.map(id => [id, itemsOn(doc, id).filter(inWindow)]));
  const listed = new Map(order.map(id => [id, scoped.get(id)!.filter(i => !types || types.has(itemType(i)))]));
  const textCount = [...listed.values()].flat().filter(i => itemType(i) === 'text').length, textOverflow = textCount > TEXT_COLLAPSE;
  let captionsCollapsed = false;

  const tracks: Rec = {};
  for (const id of order) {
    const s = trackSummary(doc, id), all = scoped.get(id)!, kept = listed.get(id)!;
    const row: Rec = { name: s.name, kind: s.kind, order: s.order, layerIndex: s.layerIndex, ...(s.layer ? { layer: s.layer } : {}), muted: s.muted, solo: s.solo, locked: s.locked, hidden: s.hidden, volume: s.volume, type: s.kind };
    const items = kept.map(i => ({ id: i.id, start: r3(i.display.from / 1000), end: r3(i.display.to / 1000) }));
    if (types && all.length && !kept.length) Object.assign(row, { itemCount: all.length, filtered: true });
    else if (s.kind === 'caption' && items.length && !types?.has('caption')) { Object.assign(row, { itemCount: items.length, collapsed: true, ranges: captionRanges(items) }); captionsCollapsed = true; }
    else if (textOverflow && kept.length && kept.every(i => itemType(i) === 'text')) Object.assign(row, { type: 'text', itemCount: kept.length, collapsed: true });
    else {
      row.items = items;
      const dropped = all.filter(i => !kept.includes(i));
      if (dropped.length) Object.assign(row, { filteredItemCount: dropped.length, filteredTypes: [...new Set(dropped.map(itemType))] });
    }
    tracks[id] = row;
  }
  const groups: Rec = {};
  for (const id of Object.keys(doc.groups)) { const g = groupSummary(doc, id); groups[id] = { name: g.name, hidden: g.hidden, locked: g.locked, trackIds: g.trackIds, bounds: g.bounds }; }
  const markers = doc.markers.filter(m => m.timeMs >= 0).sort((a, b) => a.timeMs - b.timeMs).map(m => ({ time: r3(m.timeMs / 1000), ...(m.label ? { label: m.label } : {}) }));
  const data: Rec = { _tracks: HINTS.tracks, duration: r3(doc.duration / 1000), fps: doc.fps, canvasSize: { width: doc.size.width, height: doc.size.height }, tracks,
    layerOrder: layerEntries(doc).map(e => ({ id: e.id, type: e.type })), groups };
  if (textOverflow) data._textOverflow = HINTS.textOverflow;
  if (captionsCollapsed) data._captionNote = HINTS.captionNote;
  if (content && !types) data._note = HINTS.note;
  if (markers.length) data.markers = markers;
  return { success: true, data };
}
