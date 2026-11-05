// SPDX-License-Identifier: AGPL-3.0-only
// Timeline view rules (findings §15, §23; part 2 §29, §37; part 3 §45.4, §46.12, §46.14). Pure functions: no DOM, no store.
import type { ProjectDocument, RecordData } from '../store/model';

// ---- Zoom (px per ms) and scroll (findings §23, part 3 §45.4).
export const DEFAULT_ZOOM = 0.05, MAX_ZOOM = 1, ZOOM_FLOOR = 0.001, ZOOM_STEP = 1.25, FIT_PADDING_MS = 2000, FIT_SPARE_PX = 32;
/** Fit = (lane width − 32 px) ÷ (duration + 2 s); also the minimum zoom at all times (floor 0.001), never above the
 *  maximum 1 px/ms (a short project in a wide lane fits at 1; review R8). */
export const fitZoom = (laneWidth: number, durationMs: number) => Math.min(MAX_ZOOM, Math.max(ZOOM_FLOOR, (laneWidth - FIT_SPARE_PX) / (durationMs + FIT_PADDING_MS)));
export const clampZoom = (zoom: number, fit: number) => Math.min(MAX_ZOOM, Math.max(fit, zoom));
/** Content width of the lanes: (duration + 2 s) × zoom (W3-RT-11: 47 s × 74.26 px/s = 3,491 px). */
export const contentWidth = (zoom: number, durationMs: number) => (durationMs + FIT_PADDING_MS) * zoom;
export const maxScroll = (zoom: number, durationMs: number, laneWidth: number) => Math.max(0, contentWidth(zoom, durationMs) - laneWidth);
export const clampScroll = (scroll: number, zoom: number, durationMs: number, laneWidth: number) => Math.min(maxScroll(zoom, durationMs, laneWidth), Math.max(0, scroll));
export type ZoomView = { zoom: number; scroll: number };
/** Zoom in/out by ×1.25 / ÷1.25 anchored on the playhead: its screen x stays put, or it is centred when it was off screen. */
export function zoomAround(view: ZoomView, direction: 'in' | 'out', anchorMs: number, laneWidth: number, durationMs: number): ZoomView {
  const fit = fitZoom(laneWidth, durationMs), zoom = clampZoom(direction === 'in' ? view.zoom * ZOOM_STEP : view.zoom / ZOOM_STEP, fit);
  const screen = anchorMs * view.zoom - view.scroll, offset = screen >= 0 && screen <= laneWidth ? screen : laneWidth / 2;
  return { zoom, scroll: clampScroll(anchorMs * zoom - offset, zoom, durationMs, laneWidth) };
}
/** Zoom to fit: zoom = fit, horizontal scroll reset to 0. */
export const zoomToFit = (laneWidth: number, durationMs: number): ZoomView => ({ zoom: fitZoom(laneWidth, durationMs), scroll: 0 });
/** After a document or viewport change: the fit floor only raises the zoom; the scroll is clamped to the new end (W3-RT-11). */
export function reconcileZoom(view: ZoomView, laneWidth: number, durationMs: number): ZoomView {
  const zoom = clampZoom(view.zoom, fitZoom(laneWidth, durationMs));
  return { zoom, scroll: clampScroll(view.scroll, zoom, durationMs, laneWidth) };
}

// ---- Ruler (findings §23): first interval at least 72 px wide; labels m:ss, m:ss.s below 1 s intervals.
export const TICK_LADDER_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000];
export const MIN_TICK_PX = 72, RULER_PX = 26, MARKER_LANE_PX = 14;
export const tickInterval = (zoom: number) => TICK_LADDER_MS.find(ms => ms * zoom >= MIN_TICK_PX) ?? TICK_LADDER_MS[TICK_LADDER_MS.length - 1];
export function tickLabel(ms: number, intervalMs: number): string {
  const minutes = Math.floor(ms / 60000), seconds = (ms - minutes * 60000) / 1000;
  return intervalMs < 1000 ? `${minutes}:${seconds.toFixed(1).padStart(4, '0')}` : `${minutes}:${String(Math.floor(seconds + 1e-9)).padStart(2, '0')}`;
}
/** Tick times visible in [scroll, scroll + width] px. */
export function ticks(zoom: number, scroll: number, width: number): number[] {
  const interval = tickInterval(zoom), first = Math.floor(scroll / zoom / interval) * interval, out: number[] = [];
  for (let t = Math.max(0, first); t * zoom <= scroll + width; t += interval) out.push(t);
  return out;
}

// ---- Time display and the playhead.
const two = (n: number) => String(n).padStart(2, '0');
/** Timecode mm:ss.cc (findings §46.12; an empty project reads 00:01.00 as its duration). */
export function timecode(ms: number): string {
  const cs = Math.floor(Math.max(0, ms) / 10 + 1e-6), minutes = Math.floor(cs / 6000), seconds = Math.floor(cs / 100) % 60;
  return `${two(minutes)}:${two(seconds)}.${two(cs % 100)}`;
}
/** One frame at project fps, clamped to 0…duration (findings §15: Shift/Ctrl/Alt give no bigger step). */
export function stepFrame(playheadMs: number, direction: 1 | -1, fps: number, durationMs: number): number {
  const frame = Math.round(playheadMs * fps / 1000) + direction;
  return Math.min(durationMs, Math.max(0, frame * 1000 / fps));
}
export const frameAt = (ms: number, fps: number) => Math.round(ms * fps / 1000) * 1000 / fps;

// ---- Track rows (findings §23, part 2 §29).
export const MEDIA_TRACK_PX = 56, CAPTION_OVERLAY_TRACK_PX = 48, WAVEFORM_LANE_PX = 36, TRACK_MIN_PX = 36, TRACK_MAX_PX = 120;
export const trackHeight = (track: RecordData) => typeof track.height === 'number' ? track.height : track.kind === 'caption' || track.kind === 'overlay' ? CAPTION_OVERLAY_TRACK_PX : MEDIA_TRACK_PX;
/** A lane-height drag stores round(start + delta), clamped to 36–120 px (W3-CC-03). */
export const resizedHeight = (start: number, delta: number) => Math.min(TRACK_MAX_PX, Math.max(TRACK_MIN_PX, Math.round(start + delta)));
/** Clip colours by type (findings §23). */
export const clipColour = (type: string) => type === 'caption' ? 'teal' : type === 'motionGraphic' ? 'cyan' : type === 'shape' ? 'rose' : type === 'layout' ? 'amber' : 'blue';

export type Entry = { type: 'track' | 'group'; id: string };
export type Row = { kind: 'track'; track: RecordData; groupId: string | null; depth: number } | { kind: 'group'; group: RecordData & { id: string }; depth: number; members: string[] };
/** Stored layer order is bottom-first; tracks missing from it are placed by the §53.5 repair (audio bottom, caption top, others below the first caption). */
export function layerEntries(doc: Pick<ProjectDocument, 'layerOrder' | 'groups' | 'tracks'>): Entry[] {
  const entries = [...doc.layerOrder], seen = new Set<string>();
  const walk = (list: Entry[]) => list.forEach(e => e.type === 'group' ? walk((doc.groups[e.id]?.children ?? []) as Entry[]) : seen.add(e.id));
  walk(entries);
  const holdsCaption = (e: Entry): boolean => e.type === 'group' ? ((doc.groups[e.id]?.children ?? []) as Entry[]).some(holdsCaption) : doc.tracks.find(t => t.id === e.id)?.kind === 'caption';
  for (const track of doc.tracks) if (!seen.has(track.id)) {
    const entry: Entry = { type: 'track', id: track.id }, caption = entries.findIndex(holdsCaption);
    if (track.kind === 'audio') entries.unshift(entry); else if (track.kind === 'caption' || caption < 0) entries.push(entry); else entries.splice(caption, 0, entry);
  }
  return entries;
}
/** Display rows top-first; a group row sits above its members (part 3 §46.12); collapsed groups hide their members. */
export function displayRows(doc: Pick<ProjectDocument, 'layerOrder' | 'groups' | 'tracks'>, collapsed: ReadonlySet<string> = new Set()): Row[] {
  const rows: Row[] = [], tracks = new Map(doc.tracks.map(t => [t.id, t]));
  const memberIds = (list: Entry[]): string[] => list.flatMap(e => e.type === 'group' ? memberIds((doc.groups[e.id]?.children ?? []) as Entry[]) : [e.id]);
  const walk = (list: Entry[], groupId: string | null, depth: number) => {
    for (const e of [...list].reverse()) {
      if (e.type === 'group') {
        const group = doc.groups[e.id]; if (!group) continue;
        const children = (group.children ?? []) as Entry[];
        rows.push({ kind: 'group', group: { ...group, id: e.id }, depth, members: memberIds(children) });
        if (!collapsed.has(e.id)) walk(children, e.id, depth + 1);
      } else { const track = tracks.get(e.id); if (track) rows.push({ kind: 'track', track, groupId, depth }); }
    }
  };
  walk(layerEntries(doc), null, 0);
  return rows;
}
/** Tracks that do not show: hidden themselves or inside a hidden group at any depth (part 2 §29, §37; review R6). */
export function hiddenTrackIds(doc: Pick<ProjectDocument, 'layerOrder' | 'groups' | 'tracks'>): Set<string> {
  const out = new Set<string>(), tracks = new Map(doc.tracks.map(t => [t.id, t]));
  const walk = (list: Entry[], hidden: boolean) => {
    for (const e of list) {
      if (e.type === 'group') { const g = doc.groups[e.id]; if (g) walk((g.children ?? []) as Entry[], hidden || !!g.hidden); continue; }
      const t = tracks.get(e.id); if (t && (hidden || t.hidden)) out.add(t.id);
    }
  };
  walk(layerEntries(doc), false);
  return out;
}
/** Group id of each track (direct parent). */
export function trackGroups(doc: Pick<ProjectDocument, 'layerOrder' | 'groups'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, group] of Object.entries(doc.groups)) for (const child of (group.children ?? []) as Entry[]) if (child.type === 'track') out.set(child.id, id);
  return out;
}

// ---- Clips: trim handles and halo (findings §15), context-menu enable rules (findings §15, part 3 §46.14).
export const TRIM_HANDLE_PX = 8, TRIM_MIN_CLIP_PX = 16;
export const showTrimHandles = (clipWidthPx: number) => clipWidthPx >= TRIM_MIN_CLIP_PX;
const SOURCE_TYPES = new Set(['video', 'audio']);
/** Source window of a media clip in source ms, or null for items without a source. */
export function sourceWindow(item: RecordData): { from: number; to: number; source: number } | null {
  if (!SOURCE_TYPES.has(item.type) || typeof item.sourceDuration !== 'number') return null;
  const from = item.trim?.from ?? 0, to = item.trim?.to ?? (from + (item.display.to - item.display.from) * (item.playbackRate ?? 1));
  return { from, to, source: item.sourceDuration };
}
/** Red when that edge is constrained by the source limit, green otherwise. */
export function trimHalo(item: RecordData, edge: 'start' | 'end'): 'red' | 'green' {
  const w = sourceWindow(item); if (!w) return 'green';
  return (edge === 'start' ? w.from <= 0 : w.to >= w.source) ? 'red' : 'green';
}
export const hasSourceHandles = (item: RecordData) => { const w = sourceWindow(item); return !!w && (w.from > 0 || w.to < w.source); };
export type ClipMenuState = { moveOutOfGroup: boolean | null; split: boolean; duplicate: boolean; slip: boolean; slipLabel: 'Slip' | 'Exit slip mode'; copy: boolean; paste: boolean; delete: boolean };
/** null for moveOutOfGroup = entry absent (the clip's track is not grouped). */
export function clipMenu(item: RecordData, opts: { playheadMs: number; locked: boolean; grouped: boolean; clipboard: number; slipping: boolean }): ClipMenuState {
  const on = !opts.locked, noSlip = ['image', 'layout', 'caption'].includes(item.type);
  return {
    moveOutOfGroup: opts.grouped ? on : null,
    split: on && item.display.from < opts.playheadMs && opts.playheadMs < item.display.to,
    duplicate: on, slip: on && !noSlip && (opts.slipping || hasSourceHandles(item)), slipLabel: opts.slipping ? 'Exit slip mode' : 'Slip',
    copy: on, paste: on && opts.clipboard > 0, delete: on,
  };
}

// ---- Snapping (findings §23): grid, item edges on visible tracks (dragged excluded), markers, playhead.
export const SNAP_PX = 8;
export const snapDistanceMs = (zoom: number) => Math.max(1, (SNAP_PX / Math.sqrt(zoom / DEFAULT_ZOOM)) / zoom);
export function snapTargets(doc: Pick<ProjectDocument, 'items' | 'markers' | 'tracks'>, opts: { zoom: number; playheadMs: number; exclude: ReadonlySet<string>; hiddenTracks: ReadonlySet<string>; rangeMs: [number, number] }): number[] {
  const out: number[] = [], interval = tickInterval(opts.zoom);
  for (let t = Math.max(0, Math.floor(opts.rangeMs[0] / interval) * interval); t <= opts.rangeMs[1]; t += interval) out.push(t);
  for (const item of doc.items) if (!opts.exclude.has(item.id) && !opts.hiddenTracks.has(item.trackId)) out.push(item.display.from, item.display.to);
  for (const marker of doc.markers) out.push(marker.timeMs);
  out.push(opts.playheadMs);
  return out;
}
/** A dragged span tests its start and its end; the closer match wins (by the end: start = target − length). */
export function snap(startMs: number, lengthMs: number, targets: number[], zoom: number): { startMs: number; target: number | null } {
  const limit = snapDistanceMs(zoom); let best: { d: number; start: number; target: number } | null = null;
  for (const target of targets) for (const [edge, start] of [[startMs, target], [startMs + lengthMs, target - lengthMs]] as const) {
    const d = Math.abs(edge - target); if (d <= limit && (!best || d < best.d)) best = { d, start, target };
  }
  return best ? { startMs: best.start, target: best.target } : { startMs, target: null };
}

// ---- Track grouping selection mode (part 2 §37, part 3 §46.12).
/** Eligible = root-level (ungrouped) and unlocked; rows are the display rows top-first. */
export function groupEligible(rows: Row[]): string[] {
  return rows.filter((r): r is Extract<Row, { kind: 'track' }> => r.kind === 'track' && r.groupId === null && !r.track.locked).map(r => r.track.id);
}
/** The checked set is always a contiguous run of root tracks; checking a track also checks every track between. */
export function toggleGroupCheck(rows: Row[], checked: string[], trackId: string): string[] {
  const root = rows.filter(r => r.depth === 0), index = (id: string) => root.findIndex(r => r.kind === 'track' && r.track.id === id);
  const eligible = new Set(groupEligible(rows)), i = index(trackId); if (i < 0 || !eligible.has(trackId)) return checked;
  const positions = checked.map(index).filter(n => n >= 0).sort((a, b) => a - b);
  if (!positions.length) return [trackId];
  const lo = positions[0], hi = positions[positions.length - 1];
  const span = (a: number, b: number) => root.slice(a, b + 1);
  if (checked.includes(trackId)) {
    const next = i === lo ? span(lo + 1, hi) : i === hi ? span(lo, hi - 1) : span(lo, i - 1);
    return next.map(r => (r as Extract<Row, { kind: 'track' }>).track.id);
  }
  const run = span(Math.min(lo, i), Math.max(hi, i));
  if (!run.every(r => r.kind === 'track' && eligible.has(r.track.id))) return checked;
  return run.map(r => (r as Extract<Row, { kind: 'track' }>).track.id);
}
/** Blank name → the next free "Group n" (smallest n, case-insensitive). */
export function nextGroupName(groups: Record<string, RecordData>): string {
  const taken = new Set(Object.values(groups).map(g => String(g.name ?? '').trim().toLowerCase()));
  let n = 1; while (taken.has(`group ${n}`)) n++;
  return `Group ${n}`;
}
