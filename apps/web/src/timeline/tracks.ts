// SPDX-License-Identifier: AGPL-3.0-only
// T03 tracks, groups, markers, project settings and consolidate (agent tool results §2 manageTrack / manageTrackGroup /
// resizeCanvas; contracts consolidateTracks; findings part 2 §29, §35, §36, §37). Draft-in-place like items.ts.
import type { ProjectDocument, RecordData } from '../store/model';
import type { Entry } from '../editor/geometry';
import {
  ancestors, blockers, EPS, fail, groupOf, insertTrack, itemsOn, KINDS, memberTracks, newId, newTrack, normaliseLayerOrder,
  overlaps, parents, removeEntry, siblings, stack, track, trackLocked,
} from './model';
import type { TrackKind } from './model';

// ---- Summaries returned by the tools.
export function trackSummary(doc: ProjectDocument, id: string): RecordData {
  const t = track(doc, id)!, order = stack(doc), at = order.indexOf(id);
  const s: RecordData = { id, name: t.name, kind: t.kind, groupId: groupOf(doc, id), order: at, layerIndex: order.length - 1 - at };
  if (at === 0) s.layer = 'bottom'; else if (at === order.length - 1) s.layer = 'top';
  Object.assign(s, { muted: !!t.muted, solo: !!t.solo, locked: !!t.locked, hidden: !!t.hidden, volume: t.volume ?? 1 });
  if (typeof t.height === 'number') s.height = t.height;
  s.itemCount = doc.items.filter(i => i.trackId === id).length;
  return s;
}
export function groupSummary(doc: ProjectDocument, id: string): RecordData {
  const g = doc.groups[id], ids = stack(doc).filter(t => memberTracks(doc, id).includes(t)), items = doc.items.filter(i => ids.includes(i.trackId));
  return { groupId: id, name: g.name, hidden: !!g.hidden, locked: !!g.locked, trackIds: ids,
    bounds: items.length ? { start: Math.min(...items.map(i => i.display.from)) / 1000, end: Math.max(...items.map(i => i.display.to)) / 1000 } : null };
}
const groupLocked = (doc: ProjectDocument, g: string) => !!doc.groups[g]?.locked || ancestors(doc, g).some(a => doc.groups[a]?.locked);

// ---- manageTrack (agent tool results §2; contracts §3d #21).
const FLAG: Record<string, 'muted' | 'solo' | 'locked' | 'hidden'> = { mute: 'muted', solo: 'solo', lock: 'locked', hide: 'hidden' };
export const TRACK_LABEL: Record<string, string> = { create: 'Create track', delete: 'Delete track', mute: 'Set track flag', solo: 'Set track flag', lock: 'Set track flag', hide: 'Set track flag', volume: 'Set track volume', rename: 'Rename track', reorder: 'Move track layer' };
/** Resolves position / relativeToTrackId / toIndex / groupId into a list and index; returns the message suffix. */
function placement(doc: ProjectDocument, args: RecordData, self?: string): { list: Entry[]; index: number | null; where: string; kindRule: boolean } {
  const { position, relativeToTrackId: rel, toIndex } = args;
  if (position !== undefined && !['top', 'bottom', 'above', 'below'].includes(position)) fail('INVALID_TRACK_POSITION', `Invalid position '${position}'. Use top, bottom, above or below.`);
  if ((position === 'above' || position === 'below') && !rel) fail('INVALID_RELATIVE_PLACEMENT', `position '${position}' requires relativeToTrackId.`);
  if (rel && (position === undefined || position === null)) fail('INVALID_RELATIVE_PLACEMENT', 'relativeToTrackId requires position above or below.');
  if (rel && (position === 'top' || position === 'bottom')) fail('AMBIGUOUS_TRACK_POSITION', `position '${position}' cannot be combined with relativeToTrackId.`);
  if (position !== undefined && toIndex !== undefined) fail('AMBIGUOUS_TRACK_POSITION', 'Use position or toIndex, not both.');
  let list = doc.layerOrder;
  if (args.groupId) {
    // Reorder keeps Xapp's short text ("Group not found"); Cutframe adds the code it lacks.
    if (!doc.groups[args.groupId]) fail('GROUP_NOT_FOUND', self ? 'Group not found' : `Group '${args.groupId}' not found.`);
    list = doc.groups[args.groupId].children;
  }
  if (rel) {
    if (rel === self) fail('INVALID_RELATIVE_PLACEMENT', 'A track cannot be placed relative to itself.');
    if (!track(doc, rel)) fail('RELATIVE_TRACK_NOT_FOUND', `Track '${rel}' not found.`);
    const owner = siblings(doc, rel);
    if (args.groupId !== undefined && owner !== list) fail('RELATIVE_PARENT_MISMATCH', `Track '${rel}' is not in ${args.groupId ? `group '${args.groupId}'` : 'the root'}.`);
    const at = owner.findIndex(e => e.id === rel);
    return { list: owner, index: position === 'above' ? at + 1 : at, where: ` ${position} track '${rel}'`, kindRule: false };
  }
  if (position === 'top') return { list, index: list.length, where: self ? ' to the top' : ' at the top', kindRule: false };
  if (position === 'bottom') return { list, index: 0, where: self ? ' to the bottom' : ' at the bottom', kindRule: false };
  if (toIndex !== undefined) {
    const max = list.length - (self && list.some(e => e.id === self) ? 1 : 0);
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex > max) fail('INVALID_TO_INDEX', `toIndex must be an integer from 0 to ${max} (bottom-to-top).`);
    return { list, index: toIndex, where: '', kindRule: false };
  }
  return { list, index: null, where: '', kindRule: true };
}
const guardGroupList = (doc: ProjectDocument, list: Entry[]) => {
  const owner = Object.entries(doc.groups).find(([, g]) => g.children === list)?.[0];
  if (owner && groupLocked(doc, owner)) fail('TRACK_LOCKED', 'Group is locked');
};
export function manageTrack(doc: ProjectDocument, args: RecordData): { message: string; data: RecordData; label: string } {
  const action = args.action;
  if (!action) fail('MISSING_ACTION', 'action is required');
  if (!(action in TRACK_LABEL)) fail('UNKNOWN_ACTION', `Unknown action '${action}'`);
  normaliseLayerOrder(doc);
  const label = TRACK_LABEL[action];
  if (action === 'create') {
    if (!KINDS.includes(args.kind)) fail('INVALID_TRACK_KIND', `Invalid track kind '${args.kind}'. Use video, audio, caption or overlay.`);
    const p = placement(doc, args), t = newTrack(doc, args.kind as TrackKind, typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined);
    guardGroupList(doc, p.list);
    insertTrack(doc, t, p.kindRule && p.list === doc.layerOrder ? undefined : { list: p.list, index: p.index ?? p.list.length });
    return { message: `Created ${t.kind} track '${t.name}'${p.where}.`, data: { track: trackSummary(doc, t.id) }, label };
  }
  if (!args.trackId) fail('MISSING_TRACK_ID', 'trackId is required');
  const t = track(doc, args.trackId);
  if (!t) fail('TRACK_NOT_FOUND', `Track '${args.trackId}' not found.`);
  const id = t.id;
  switch (action) {
    case 'delete': {
      const n = doc.items.filter(i => i.trackId === id).length;
      if (n && args.deleteItems !== true) fail('TRACK_NOT_EMPTY', `Track '${id}' contains ${n} item(s). Pass deleteItems: true to delete the track and its items.`, { data: { track: trackSummary(doc, id) } });
      deleteTrack(doc, id);
      return { message: `Deleted track '${id}'${n ? ` and ${n} item(s)` : ''}.`, data: { deletedTrackId: id, deletedItemCount: n }, label };
    }
    case 'mute': case 'solo': case 'lock': case 'hide':
      t[FLAG[action]] = args.value === undefined ? true : !!args.value;
      return { message: `Updated ${FLAG[action]} on track '${id}'.`, data: { track: trackSummary(doc, id) }, label };
    case 'volume':
      if (typeof args.volume !== 'number' || !Number.isFinite(args.volume) || args.volume < 0 || args.volume > 1) fail('INVALID_VOLUME', 'volume must be a number from 0 to 1.');
      t.volume = args.volume;
      return { message: `Set track '${id}' volume to ${args.volume}.`, data: { track: trackSummary(doc, id) }, label };
    case 'rename':
      if (typeof args.name !== 'string' || !args.name.trim()) fail('MISSING_NAME', 'name is required');
      t.name = args.name.trim();
      return { message: `Renamed track '${id}' to '${t.name}'.`, data: { track: trackSummary(doc, id) }, label };
    default: {
      const p = placement(doc, args, id);
      guardGroupList(doc, siblings(doc, id)); guardGroupList(doc, p.list);
      const anchor = p.index !== null && p.index < p.list.length ? p.list[p.index] : null;
      removeEntry(doc, id);
      let index = p.index === null ? p.list.length : anchor ? p.list.indexOf(anchor) : p.list.length;
      if (args.toIndex !== undefined) index = Math.min(args.toIndex, p.list.length);
      p.list.splice(index, 0, { type: 'track', id });
      return { message: `Reordered track '${id}'${p.where}.`, data: { track: trackSummary(doc, id) }, label };
    }
  }
}
export function deleteTrack(doc: ProjectDocument, id: string) {
  const g = groupOf(doc, id);
  if (g && groupLocked(doc, g)) fail('TRACK_LOCKED', 'Group is locked');
  const gone = new Set(doc.items.filter(i => i.trackId === id).map(i => i.id));
  doc.items = doc.items.filter(i => !gone.has(i.id) && !(i.captionSourceItemId && gone.has(i.captionSourceItemId)));
  doc.transitions = doc.transitions.filter(t => t.trackId !== id && !gone.has(t.fromId) && !gone.has(t.toId));
  removeEntry(doc, id);
  doc.tracks = doc.tracks.filter(t => t.id !== id);
}

// ---- UI track ops (labels per INTENTS / part 3 §45.1).
export function moveTrackLayer(doc: ProjectDocument, id: string, beforeTrackId: string | null) {
  if (!track(doc, id)) fail('TRACK_NOT_FOUND', `Track '${id}' not found.`);
  normaliseLayerOrder(doc);
  const target = beforeTrackId ? siblings(doc, beforeTrackId) : doc.layerOrder;
  guardGroupList(doc, siblings(doc, id)); guardGroupList(doc, target);
  removeEntry(doc, id);
  // Released on a track header: the moved track goes directly above it (provisional); null = top of the root.
  const at = beforeTrackId ? target.findIndex(e => e.id === beforeTrackId) + 1 : target.length;
  target.splice(at, 0, { type: 'track', id });
}
export function moveTrackOutOfGroup(doc: ProjectDocument, id: string) {
  const g = groupOf(doc, id);
  if (!g) fail('NOT_IN_GROUP', 'This track is not in a group');
  if (groupLocked(doc, g)) fail('TRACK_LOCKED', 'Group is locked');
  let entry = g; for (const a of ancestors(doc, g)) entry = a;
  removeEntry(doc, id);
  doc.layerOrder.splice(doc.layerOrder.findIndex(e => e.id === entry) + 1, 0, { type: 'track', id });
  dropEmptyGroups(doc);
}
/** A group left with fewer than two members dissolves into its parent (provisional; §37 groups need two tracks). */
function dropEmptyGroups(doc: ProjectDocument) {
  for (const [id, g] of Object.entries(doc.groups)) if ((g.children ?? []).length < 2) ungroup(doc, id, true);
}

// ---- Groups (manageTrackGroup; part 2 §37).
function bad(reason: string): never { fail('INVALID_GROUP_OPERATION', reason); }
export const GROUP_LABEL: Record<string, string> = { create: 'Group tracks', rename: 'Rename group', setTracks: 'Change group tracks', reorder: 'Reorder group', ungroup: 'Ungroup tracks', hide: 'Set group flag', lock: 'Set group flag', delete: 'Delete group' };
/** Adjacent in one owner list, every id a distinct track, none already in a group (unless `allow` is that group). */
function adjacentRun(doc: ProjectDocument, ids: string[], allow?: string): { list: Entry[]; from: number; to: number } | null {
  normaliseLayerOrder(doc);
  if (new Set(ids).size !== ids.length || ids.some(id => !track(doc, id))) return null;
  const p = parents(doc), owners = new Set(ids.map(id => p.get(id) ?? null));
  if (owners.size !== 1) return null;
  const owner = [...owners][0];
  if (owner && owner !== allow) return null;
  const list = owner ? doc.groups[owner].children : doc.layerOrder, at = ids.map(id => list.findIndex((e: Entry) => e.id === id)).sort((a, b) => a - b);
  return at.every((v, i) => i === 0 || v === at[i - 1] + 1) ? { list, from: at[0], to: at[at.length - 1] } : null;
}
export function createGroup(doc: ProjectDocument, ids: string[], name: string): string {
  if (typeof name !== 'string' || !name.trim() || !Array.isArray(ids) || new Set(ids).size < 2) bad('Choose a name and at least two distinct adjacent tracks');
  const run = adjacentRun(doc, ids);
  if (!run) bad('Group tracks must be adjacent and outside existing groups');
  const id = newId('group'), children = run.list.splice(run.from, run.to - run.from + 1, { type: 'group', id });
  doc.groups[id] = { id, name: name.trim(), children, hidden: false, locked: false };
  return id;
}
export function ungroup(doc: ProjectDocument, id: string, force = false) {
  const g = doc.groups[id];
  if (!g) bad('Unknown group');
  if (!force && groupLocked(doc, id)) bad('Group is locked');
  const list = siblings(doc, id), at = list.findIndex(e => e.id === id);
  list.splice(at, 1, ...(g.children ?? []));
  delete doc.groups[id];
}
export function manageTrackGroup(doc: ProjectDocument, args: RecordData): { data: RecordData; label: string } {
  const action = args.action;
  if (!(action in GROUP_LABEL)) bad('Unknown group action');
  const label = GROUP_LABEL[action];
  if (action === 'create') { const id = createGroup(doc, args.trackIds, args.name); return { data: groupSummary(doc, id), label }; }
  if (!args.groupId) bad('groupId is required');
  const id = args.groupId, g = doc.groups[id];
  if (action === 'rename' && (!g || typeof args.name !== 'string' || !args.name.trim())) bad('Unknown group or empty name');
  if (!g) bad('Unknown group');
  if (action === 'hide' || action === 'lock') {
    if (typeof args.value !== 'boolean') bad('value must be boolean');
    g[action === 'hide' ? 'hidden' : 'locked'] = args.value;
    return { data: groupSummary(doc, id), label };
  }
  if (groupLocked(doc, id)) bad('Group is locked');
  switch (action) {
    case 'rename': g.name = args.name.trim(); return { data: groupSummary(doc, id), label };
    case 'setTracks': {
      const ids: string[] = args.trackIds ?? [];
      if (new Set(ids).size !== ids.length || ids.length < 2 || ids.some(t => !track(doc, t))) bad('Choose distinct member tracks');
      // Members leave to the group's position, then the new run (members + neighbours of the group) is regrouped in place.
      const list = siblings(doc, id), at = list.findIndex(e => e.id === id), old = (g.children ?? []) as Entry[];
      list.splice(at, 1, ...old);
      g.children = [];
      const run = adjacentRun(doc, ids);
      if (!run || run.list !== list) bad('Membership must be adjacent and cannot take tracks from another group');
      g.children = list.splice(run.from, run.to - run.from + 1, { type: 'group', id });
      return { data: groupSummary(doc, id), label };
    }
    case 'reorder': {
      if (!Number.isInteger(args.toIndex)) bad('toIndex must be an integer');
      const list = siblings(doc, id), at = list.findIndex(e => e.id === id), [entry] = list.splice(at, 1);
      list.splice(Math.max(0, Math.min(args.toIndex, list.length)), 0, entry);
      return { data: groupSummary(doc, id), label };
    }
    case 'ungroup': ungroup(doc, id); return { data: { ungroupedId: id }, label };
    default: deleteGroup(doc, id); return { data: { deletedGroupId: id }, label };
  }
}
export function deleteGroup(doc: ProjectDocument, id: string) {
  if (!doc.groups[id]) bad('Unknown group');
  if (groupLocked(doc, id)) bad('Group is locked');
  const tracks = memberTracks(doc, id), nested = Object.keys(doc.groups).filter(g => g === id || ancestors(doc, g).includes(id));
  removeEntry(doc, id);
  const gone = new Set(doc.items.filter(i => tracks.includes(i.trackId)).map(i => i.id));
  doc.items = doc.items.filter(i => !gone.has(i.id) && !(i.captionSourceItemId && gone.has(i.captionSourceItemId)));
  doc.transitions = doc.transitions.filter(t => !tracks.includes(t.trackId) && !gone.has(t.fromId) && !gone.has(t.toId));
  doc.tracks = doc.tracks.filter(t => !tracks.includes(t.id));
  for (const g of nested) delete doc.groups[g];
}
export function reorderGroupStep(doc: ProjectDocument, id: string, direction: 'up' | 'down') {
  if (!doc.groups[id]) bad('Unknown group');
  if (groupLocked(doc, id)) bad('Group is locked');
  const list = siblings(doc, id), at = list.findIndex(e => e.id === id), to = direction === 'up' ? at + 1 : at - 1;
  if (to < 0 || to >= list.length) return;
  [list[at], list[to]] = [list[to], list[at]];
}
/** Group move in time (moveItem {groupId, by}; label "Move group"). */
export function moveGroup(doc: ProjectDocument, id: string, by: number) {
  if (!Number.isFinite(by)) fail('INVALID_MOVE', 'Move must be finite');
  if (!doc.groups[id]) fail('GROUP_NOT_FOUND', 'Unknown group');
  if (groupLocked(doc, id)) fail('TRACK_LOCKED', 'Group is locked');
  const tracks = memberTracks(doc, id);
  if (tracks.some(t => track(doc, t)?.locked)) fail('TRACK_LOCKED', 'Group contains a locked track');
  const items = doc.items.filter(i => tracks.includes(i.trackId));
  if (items.some(i => i.display.from + by < -EPS)) fail('GROUP_BEFORE_START', 'Group cannot move before timeline start');
  for (const i of items) i.display = { from: i.display.from + by, to: i.display.to + by };
}

// ---- Markers (findings part 2 §36): {id, timeMs, label?}.
export function addMarker(doc: ProjectDocument, timeMs: number, label?: string) {
  if (!Number.isFinite(timeMs) || timeMs < 0) fail('INVALID_MARKER_TIME', 'Marker time must be a non-negative number.');
  const m: RecordData = { id: newId('marker'), timeMs };
  if (label) m.label = String(label);
  doc.markers.push(m); doc.markers.sort((a, b) => a.timeMs - b.timeMs);
  return m;
}
export function removeMarker(doc: ProjectDocument, id: string) {
  if (!doc.markers.some(m => m.id === id)) fail('MARKER_NOT_FOUND', `Marker '${id}' not found.`);
  doc.markers = doc.markers.filter(m => m.id !== id);
}
export function updateMarker(doc: ProjectDocument, id: string, patch: { timeMs?: number; label?: string }) {
  const m = doc.markers.find(x => x.id === id);
  if (!m) fail('MARKER_NOT_FOUND', `Marker '${id}' not found.`);
  if (patch.timeMs !== undefined) { if (!Number.isFinite(patch.timeMs) || patch.timeMs < 0) fail('INVALID_MARKER_TIME', 'Marker time must be a non-negative number.'); m.timeMs = patch.timeMs; }
  if (patch.label !== undefined) m.label = String(patch.label);
  doc.markers.sort((a, b) => a.timeMs - b.timeMs);
}
/** manageMarkers: every action in one undo step "Edit markers"; times in ms here. */
export function manageMarkers(doc: ProjectDocument, actions: RecordData[]): { message: string; added: string[] } {
  let added = 0, updated = 0, removed = 0, cleared = false; const ids: string[] = [];
  for (const a of actions ?? []) {
    if (a.action === 'add') { ids.push(addMarker(doc, a.timeMs, a.label).id); added++; }
    else if (a.action === 'update') { updateMarker(doc, a.markerId, { timeMs: a.timeMs, label: a.label }); updated++; }
    else if (a.action === 'remove') { removeMarker(doc, a.markerId); removed++; }
    else if (a.action === 'clear') { doc.markers = []; cleared = true; }
    else fail('UNKNOWN_ACTION', `Unknown action '${a.action}'`);
  }
  const parts = [added && `added ${added}`, updated && `updated ${updated}`, removed && `removed ${removed}`, cleared && 'cleared all'].filter(Boolean);
  return { message: parts.length ? `Markers: ${parts.join(', ')}.` : 'No marker actions applied.', added: ids };
}

// ---- Project settings (findings part 2 §36).
export const ASPECTS: Record<string, { width: number; height: number }> = { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1080, height: 1080 } };
export function resizeCanvas(doc: ProjectDocument, ratio: string) {
  const size = ASPECTS[ratio];
  if (!size) fail('INVALID_ASPECT_RATIO', 'Invalid aspect ratio', { message: `'${ratio}' is not valid. Use: 16:9, 9:16, 1:1.` });
  doc.size = { ...size };
  return size;
}
/** Set duration / Set fps / Set background (part 2 §36; part 5: background `{type: color | image, value}`). No agent tool
 *  and no UI control reaches them (results §5), so the validation is Cutframe's own; any later item edit re-fits the
 *  duration to the content end. Set fps does not re-project "legacy background items" (unspecified; provisional). */
export function setSettings(doc: ProjectDocument, change: { duration?: number; fps?: number; background?: RecordData }) {
  if ('duration' in change && !(Number.isFinite(change.duration) && change.duration! > 0)) fail('INVALID_DURATION', 'Duration must be a positive number of milliseconds');
  if ('fps' in change && !(Number.isFinite(change.fps) && change.fps! > 0)) fail('INVALID_FPS', 'fps must be a positive number');
  const bg = change.background;
  if ('background' in change && !(bg && (bg.type === 'color' || bg.type === 'image') && typeof bg.value === 'string')) fail('INVALID_BACKGROUND', 'background must be {type: "color" | "image", value: string}');
  if (change.duration !== undefined) doc.duration = change.duration;
  if (change.fps !== undefined) doc.fps = change.fps;
  if (bg) doc.background = { type: bg.type, value: bg.value };
}

// ---- Consolidate (findings part 2 §35; Cutframe deletion scope = in trackIds, unlocked, not in a locked group).
export function consolidate(doc: ProjectDocument, args: { trackIds?: string[]; deleteEmptyTracks?: boolean }): { moved: number; deletedTrackIds: string[] } {
  const scope = args.trackIds ? new Set(args.trackIds) : null, order = stack(doc), usable = (id: string) => {
    const t = track(doc, id)!; return t.kind !== 'caption' && !trackLocked(doc, id) && (!scope || scope.has(id));
  };
  let moved = 0;
  // Walk sources from the top down; each item goes to the lowest qualifying track below it.
  for (let s = order.length - 1; s >= 0; s--) {
    const src = order[s]; if (!usable(src)) continue;
    const kind = track(doc, src)!.kind;
    for (const it of itemsOn(doc, src)) {
      for (let t = 0; t < s; t++) {
        const dst = order[t];
        if (!usable(dst) || track(doc, dst)!.kind !== kind || blockers(doc, dst, it.display, new Set([it.id])).length) continue;
        // Never slide a visual under something it used to cover: no non-audio item between target and source overlaps it.
        if (kind !== 'audio' && order.slice(t + 1, s).some(mid => track(doc, mid)!.kind !== 'audio' && doc.items.some(o => o.trackId === mid && overlaps(o.display, it.display)))) continue;
        it.trackId = dst; moved++; break;
      }
    }
  }
  const deleted: string[] = [];
  if (args.deleteEmptyTracks) for (const id of order) {
    if (!usable(id) || doc.items.some(i => i.trackId === id)) continue;
    const g = groupOf(doc, id); if (g && groupLocked(doc, g)) continue;
    deleteTrack(doc, id); deleted.push(id);
  }
  if (deleted.length) for (const [gid, g] of Object.entries(doc.groups)) if (!(g.children ?? []).length) { removeEntry(doc, gid); delete doc.groups[gid]; }
  return { moved, deletedTrackIds: deleted };
}
export const consolidateMessage = (r: { moved: number; deletedTrackIds: string[] }, deleteEmpty?: boolean) =>
  !r.moved && !r.deletedTrackIds.length ? 'Tracks are already consolidated.'
    : deleteEmpty ? `Consolidated ${r.moved} item(s) and deleted ${r.deletedTrackIds.length} empty track(s).` : `Consolidated ${r.moved} item(s); empty tracks were preserved.`;
