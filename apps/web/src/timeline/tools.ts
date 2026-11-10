// SPDX-License-Identifier: AGPL-3.0-only
// T03 agent tool handlers (agent tool results §2; contracts §2, §3d). Each call runs as one bus command tagged `agent`,
// speaks seconds, and gets the A0.3 `timelineChanges` report when anything changed. A refusal changes nothing.
// Xapp's code-less failures get Cutframe codes (results §1.4: "Cutframe should always add one").
import type { Asset, RecordData } from '../store/model';
import type { CommandBus, Label } from './bus';
import { timelineChanges } from './changes';
import { editProperties, setTimeRemap, setUseProxy, writeKeyframes } from './edits';
import { writeEffects } from './effects';
import { applyMoves, canInsertAfter, clone, insertAfter, mediaItem, remove, reorder, requireItems, RIPPLE_BOUNDARY, slip, specProblem, split, TOOL_IMAGE_MS, transform, trim } from './items';
import type { MediaSpec } from './items';
import { blockers, CommandError, fail, fmt, item, nextFree, span, stack, toMs, track, trackLocked } from './model';
import { consolidate, consolidateMessage, GROUP_LABEL, manageMarkers, manageTrack, manageTrackGroup, moveGroup, resizeCanvas, TRACK_LABEL } from './tracks';
import { prop } from './properties';
import { addMotionGraphic, editMotionGraphic } from '../mg/tools';
import { addShape, writeShapePoints } from './shape-tools';
import { addText } from '../text/tools';
import { addLayout, editLayout } from './layout-tools';
import { applyTransition } from './transitions';
import { createMask, editMaskProperties, removeMask, writeMaskPoints } from '../masks/tools';
import { CAPTION_TOOLS } from '../captions/tools';
import type { SourceData } from '../captions/generation';

export type ToolContext = {
  bus: CommandBus;
  /** Resolves an agent asset id (`video_1`) or a stored asset id to a project asset. */
  asset: (id: string) => Asset | undefined;
  /** The project's live asset links (agent id, stored id): the motion-graphic getAssetUrl check (T08). */
  assetLinks?: () => { agentId: string; id: string }[];
  /** T09 addCaptions: each asset's loaded transcript / music state (captions/agent.ts sets it before the sync call; with
   *  none, addCaptions captions nothing). */
  captionData?: (assetId: string) => SourceData;
};
export type ToolResult = RecordData & { success: boolean };
type Handler = (ctx: ToolContext, args: RecordData) => ToolResult;
const s3 = (ms: number) => Math.round(ms) / 1000;
/** Errors Xapp throws from the editor (they arrive as PROJECT_UNAVAILABLE + operationMayHaveRun:true there). Cutframe
 *  detects them before any change, so it reports its own code and operationMayHaveRun:false. */
const THROWN = new Set(['Group is locked', 'Group contains a locked track', 'Group cannot move before timeline start', 'Move must be finite', 'Trim item is outside ripple group',
  'Ripple-delete one group at a time, or use regular delete for a mixed selection.', 'Delete selection is outside ripple group', 'Group ripple delete needs a continuous interval',
  RIPPLE_BOUNDARY]);
const run = <T>(ctx: ToolContext, label: Label, op: Parameters<CommandBus['run']>[2]) => ctx.bus.run(label, 'agent', op) as T;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

// ---- addMedia.
const addMedia: Handler = (ctx, args) => run(ctx, args.insertAfterItemId !== undefined ? 'Insert items' : 'Add media', doc => {
  const ref = args.insertAfterItemId;
  if (ref !== undefined && (args.trackId !== undefined || args.timelineStart !== undefined))
    fail('INVALID_COMBINATION', `insertAfter cannot be used with ${['trackId', 'timelineStart'].filter(k => args[k] !== undefined).join(', ')}. Use insertAfterItemId alone, or trackId with timelineStart.`);
  const specs: MediaSpec[] = Array.isArray(args.items) ? args.items
    : args.assetId !== undefined ? [{ assetId: args.assetId, duration: args.duration, trimStart: args.trimStart, trimEnd: args.trimEnd, bounds: args.bounds, transcriptRange: args.transcriptRange, scaleMode: args.scaleMode } as MediaSpec] : [];
  const assets = specs.map(sp => ctx.asset(sp.assetId));
  if (ref !== undefined) {
    const r = item(doc, ref);
    if (!r) fail('INSERT_AFTER_NOT_FOUND', 'insertAfter item not found', { message: `Item '${ref}' not found on the timeline. Read context for current item ids.` });
    if (!track(doc, r.trackId)) fail('INSERT_AFTER_NO_TRACK', 'insertAfter item not on any track');
    for (const a of assets) if (a && !canInsertAfter(a.type, r))
      fail('INSERT_AFTER_TYPE_MISMATCH', 'insertAfter type mismatch', { message: `Cannot insert ${a.type} after ${r.type} item '${ref}'. The new item requires a compatible track kind.` });
  } else if (!args.trackId) fail('MISSING_TRACK_ID', 'trackId is required. Use context() for stable track ids or create a track explicitly with manageTrack.');
  if (specs.some(sp => (sp as RecordData).transcriptRange !== undefined)) fail('NOT_IMPLEMENTED', 'transcriptRange is not yet implemented (T19).');
  if (!specs.length) fail('NO_ITEMS', 'No items provided', { message: 'items array must contain at least one item.' });
  const types = [...new Set(assets.filter(Boolean).map(a => a!.type))];
  if (types.includes('audio') && types.length > 1) { const t = `Audio cannot share a call with visual media (found ${types.join(', ')}). Place audio in a separate call on an audio track.`; fail('MIXED_MEDIA_KINDS', t, { message: t }); }
  // Per-item validation (all or nothing); every failure keeps its own code (Cutframe note).
  const start0 = ref !== undefined ? 0 : toMs(args.timelineStart ?? 0), failures: RecordData[] = [];
  specs.forEach((sp, n) => {
    const raw = sp as RecordData;
    let problem: [string, string] | null = null;
    if (item(doc, sp.assetId)) problem = ['TIMELINE_ID_NOT_ALLOWED', `Expected asset ID (e.g., 'video_1') but received timeline ID '${sp.assetId}'.`];
    else if (raw.bounds && raw.scaleMode !== undefined) problem = ['INVALID_COMBINATION', 'bounds and scaleMode cannot be combined'];
    else problem = specProblem({ ...sp, duration: raw.duration === undefined ? undefined : toMs(raw.duration), trimStart: raw.trimStart === undefined ? undefined : toMs(raw.trimStart), trimEnd: raw.trimEnd === undefined ? undefined : toMs(raw.trimEnd) }, assets[n], start0);
    if (problem && problem[0] === 'MEDIA_NOT_FOUND' && /^(video|image|audio)_\d+$/.test(sp.assetId)) problem[1] += ` '${sp.assetId}' is not in this project; the user may have removed it.`;
    if (problem) failures.push({ assetId: sp.assetId, code: problem[0], error: problem[1] });
  });
  if (failures.length) fail('VALIDATION_FAILED', `${failures.length} item(s) failed validation`, { message: failures.map(f => `${f.assetId}: ${f.error}`).join('; '), data: { failures } });
  const ms = (v: unknown) => v === undefined ? undefined : toMs(v as number);
  const records = specs.map((sp, n) => mediaItem(doc, { assetId: sp.assetId, asset: assets[n]!, duration: ms((sp as RecordData).duration), trimStart: ms(sp.trimStart), trimEnd: ms(sp.trimEnd), bounds: sp.bounds }, '', 0, TOOL_IMAGE_MS));
  if (ref !== undefined) insertAfter(doc, ref, records);
  else {
    const t = track(doc, args.trackId), want = types.includes('audio') ? 'audio' : 'video';
    if (!t || t.kind !== want) {
      const ok = stack(doc).filter(id => track(doc, id)!.kind === want && !trackLocked(doc, id));
      fail('INVALID_TRACK', `Cannot place ${types.join('/')} items on track '${args.trackId}'`, { message: ok.length ? `Compatible unlocked ${want} tracks: ${ok.join(', ')}.` : `There is no unlocked ${want} track; create one with manageTrack.` });
    }
    if (trackLocked(doc, t.id)) fail('TRACK_LOCKED', `Track ${t.id} is locked`);
    let from = start0;
    const overlaps: RecordData[] = [];
    for (const [n, r] of records.entries()) {
      const len = span(r); r.trackId = t.id; r.display = { from, to: from + len };
      const hit = blockers(doc, t.id, r.display)[0];
      if (hit) overlaps.push({ assetId: specs[n].assetId, timeRange: `${fmt(from)}s–${fmt(from + len)}s`, conflictingItem: hit.id, conflictRange: `${fmt(hit.display.from)}s–${fmt(hit.display.to)}s`, len, from });
      from += len;
    }
    if (overlaps.length) {
      const o = overlaps[0];
      fail('OVERLAP_DETECTED', `Overlap detected on ${t.id}`, { message: `${o.assetId} at ${o.timeRange} overlaps ${o.conflictingItem} (${o.conflictRange}). The first free start for this length is ${fmt(nextFree(doc, t.id, o.from, o.len))}s.`,
        data: { overlaps: overlaps.map(({ len: _l, from: _f, ...rest }) => rest) } });
    }
    doc.items.push(...records);
  }
  const results = records.map((r, n) => {
    const out: RecordData = { assetId: specs[n].assetId, success: true, itemId: r.id };
    if (r.trim) out.resolvedTrim = { start: s3(r.trim.from), end: s3(r.trim.to), duration: s3(r.trim.to - r.trim.from) };
    const v = (k: string) => prop(r, k)?.defaultValue as number;
    if (specs[n].bounds && v('width')) out.resolvedBounds = { x: v('positionX'), y: v('positionY'), width: v('width') * v('scale'), height: v('height') * v('scale') };
    return out;
  });
  const n = records.length;
  return { success: true, data: { results, addedItemIds: records.map(r => r.id), summary: { total: n, succeeded: n, failed: 0 } }, message: `Successfully added ${n} media item${n === 1 ? '' : 's'} to timeline` };
});

// ---- Item edits.
const changeTrack: Handler = (ctx, args) => run(ctx, 'Move items', doc => {
  const i = item(doc, args.itemId);
  if (!i) fail('ITEM_NOT_FOUND', `Item '${args.itemId}' not found`);
  applyMoves(doc, [{ id: i.id, trackId: args.trackId, from: args.from === undefined ? i.display.from : toMs(args.from) }], 'Track change failed');
  return { success: true, data: { itemId: i.id, trackId: args.trackId, from: s3(i.display.from), to: s3(i.display.to) }, message: `Moved '${i.id}' to track '${args.trackId}' at ${fmt(i.display.from)}s–${fmt(i.display.to)}s.` };
});
const cloneItem: Handler = (ctx, args) => run(ctx, 'Duplicate items', doc => {
  const c = clone(doc, args.itemId, args.trackId, args.at === undefined ? undefined : toMs(args.at));
  return { success: true, data: { itemId: c.id, trackId: c.trackId, from: s3(c.display.from), to: s3(c.display.to) } };
});
const deleteItems: Handler = (ctx, args) => run(ctx, 'Delete items', (doc, tx) => {
  if (!Array.isArray(args.itemIds) || !args.itemIds.length) fail('MISSING_ITEM_IDS', 'itemIds is required');
  const r = remove(doc, args.itemIds, { ripple: !!args.ripple, rippleGroupId: args.rippleGroupId, path: 'tool' });
  tx.label = r.label;
  const data: RecordData = { deletedItemIds: args.ripple || args.rippleGroupId ? r.deleted : args.itemIds };
  if (args.ripple || args.rippleGroupId) data.shiftedItemIds = r.shifted;
  if (r.also.length) {
    data.alsoDeletedItemIds = r.also;
    if (!args.ripple && !args.rippleGroupId) data.note = 'Captions linked to the deleted clips were deleted with them. Pass ripple: true to also close the gap.';
  }
  return { success: true, data };
});
const moveItem: Handler = (ctx, args) => {
  const ids: string[] | null = Array.isArray(args.itemIds) ? args.itemIds : args.itemId !== undefined ? [args.itemId] : null;
  if (args.groupId !== undefined) {
    if (ids || args.by === undefined || ['to', 'trackId', 'beforeItemId', 'afterItemId'].some(k => args[k] !== undefined)) fail('INVALID_COMBINATION', 'Group moves require only groupId and by (seconds)');
    return run(ctx, 'Move group', doc => { moveGroup(doc, args.groupId, toMs(args.by)); return { success: true, data: { groupId: args.groupId, by: args.by } }; });
  }
  if (!ids?.length) fail('MISSING_ITEM_IDS', 'itemId or itemIds is required');
  if (args.beforeItemId !== undefined && args.afterItemId !== undefined) fail('INVALID_COMBINATION', 'Provide beforeItemId or afterItemId, not both');
  if (args.beforeItemId !== undefined || args.afterItemId !== undefined) return reorderItems(ctx, { itemIds: ids, beforeItemId: args.beforeItemId, afterItemId: args.afterItemId });
  if (args.to !== undefined && ids.length > 1) fail('INVALID_COMBINATION', 'Absolute to is only valid for one item; use by for a batch');
  if (args.by === undefined && args.to === undefined && args.trackId === undefined) fail('MISSING_PARAM', 'Provide by, to, trackId, beforeItemId, or afterItemId');
  if ((args.by !== undefined && !num(args.by)) || (args.to !== undefined && !num(args.to))) fail('INVALID_MOVE', 'Move must be finite');
  return run(ctx, ids.length > 1 ? 'Move items' : 'Move item', doc => {
    requireItems(doc, ids, 'ITEM_NOT_FOUND', missing => `Move cancelled; these item IDs are not on the timeline: ${missing.join(', ')}. A caption linked to a deleted clip is deleted with it; read context again.`);
    const moves = ids.map(id => { const i = item(doc, id)!; return { id, trackId: args.trackId ?? i.trackId, from: args.to !== undefined ? toMs(args.to) : i.display.from + toMs(args.by ?? 0) }; });
    const changed = applyMoves(doc, moves, 'Move failed'), list = changed.length ? changed : ids.map(id => item(doc, id)!);
    return { success: true, data: { items: list.map(i => ({ itemId: i.id, trackId: i.trackId, from: s3(i.display.from), to: s3(i.display.to) })) } };
  });
};
const reorderItems: Handler = (ctx, args) => {
  if (!Array.isArray(args.itemIds) || !args.itemIds.length) fail('MISSING_ITEM_IDS', 'itemIds is required');
  if ((args.beforeItemId === undefined) === (args.afterItemId === undefined)) fail('INVALID_COMBINATION', 'Provide exactly one of beforeItemId or afterItemId');
  // Undo label: Xapp's reorder tools are not traced; the drag form is "Ripple reorder" (provisional).
  return run(ctx, 'Ripple reorder', doc => ({ success: true, data: { itemIds: reorder(doc, args.itemIds, args.beforeItemId ?? args.afterItemId, args.beforeItemId !== undefined ? 'before' : 'after') } }));
};
const slipItem: Handler = (ctx, args) => run(ctx, 'Slip item', doc => {
  if (!num(args.slipSeconds)) fail('MISSING_PARAM', 'Slip was not applied');
  const d = slip(doc, args.itemId, toMs(args.slipSeconds));
  return { success: true, data: { itemId: args.itemId, slippedSeconds: s3(d) } };
});
const splitItem: Handler = (ctx, args) => run(ctx, 'Split item', doc => {
  if (!num(args.timestampS)) fail('INVALID_SPLIT_POINT', 'Split point is invalid or item was not found');
  const r = split(doc, args.itemId, toMs(args.timestampS));
  return { success: true, data: { leftItemId: r.left, rightItemId: r.right } };
});
const trimItem: Handler = (ctx, args) => run(ctx, 'Edit items', (doc, tx) => {
  if (!args.itemId || (args.handle !== 'start' && args.handle !== 'end') || !num(args.deltaSeconds)) fail('MISSING_PARAM', 'itemId, handle (start/end), and deltaSeconds are required');
  const r = trim(doc, args.itemId, args.handle, toMs(args.deltaSeconds), { ripple: !!args.ripple, rippleGroupId: args.rippleGroupId, path: 'tool' });
  tx.label = r.label;
  return { success: true, data: { itemId: args.itemId, appliedDeltaSeconds: s3(r.applied), shiftedItemIds: r.shifted } };
});
const transformItem: Handler = (ctx, args) => run(ctx, 'Edit items', doc => {
  const box = transform(doc, args.itemId, args), W = doc.size.width, H = doc.size.height, r = (v: number) => Math.round(v * 100) / 100;
  return { success: true, message: `'${args.itemId}' is now drawn at x ${r(box.x)}, y ${r(box.y)}, ${r(box.width)} × ${r(box.height)} px on the ${W} × ${H} canvas (before rotation).`, data: { itemId: args.itemId, drawnBox: { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) } } };
});

// ---- Properties, keyframes, time remap (T04; edits.ts holds the rules shared with the UI).
const editPropertiesTool: Handler = (ctx, args) => run(ctx, 'Edit items', (doc, tx) => {
  // A speed-only edit gets the UI speed control's label (UI/tool parity; provisional for the tool).
  if (args.properties && Object.keys(args.properties).join() === 'playbackRate') tx.label = 'Change speed';
  return editProperties(doc, args);
});
const writeKeyframesTool: Handler = (ctx, args) => run(ctx, 'Edit items', doc => writeKeyframes(doc, args));
const setTimeRemapTool: Handler = (ctx, args) => run(ctx, 'Edit items', doc => setTimeRemap(doc, args));
/** T15, provisional: Xapp has no Use Proxy tool (edits.ts setUseProxy). */
const setUseProxyTool: Handler = (ctx, args) => run(ctx, 'Edit items', doc => setUseProxy(doc, args));
// ---- Effects (T10; effects.ts holds the stack rules shared with the UI). A UI add is one "Edit items" entry (contracts #29).
const writeEffectsTool: Handler = (ctx, args) => run(ctx, 'Edit items', doc => writeEffects(doc, args));

// ---- Tracks, groups, markers, settings.
const manageTrackTool: Handler = (ctx, args) => run(ctx, (TRACK_LABEL[args.action] ?? 'Create track') as Label, (doc, tx) => {
  const r = manageTrack(doc, args); tx.label = r.label as Label;
  return { success: true, message: r.message, data: r.data };
});
const manageTrackGroupTool: Handler = (ctx, args) => run(ctx, (GROUP_LABEL[args.action] ?? 'Group tracks') as Label, doc => ({ success: true, data: manageTrackGroup(doc, args).data }));
const resizeCanvasTool: Handler = (ctx, args) => run(ctx, 'Resize canvas', doc => {
  const size = resizeCanvas(doc, args.aspectRatio);
  return { success: true, message: `Canvas resized to ${args.aspectRatio} (${size.width}x${size.height}).`, data: { aspectRatio: args.aspectRatio, width: size.width, height: size.height } };
});
const consolidateTracks: Handler = (ctx, args) => {
  if (args.trackIds !== undefined && (!Array.isArray(args.trackIds) || !args.trackIds.length))
    fail('INVALID_TOOL_INPUT', 'Invalid input for consolidateTracks', { message: '$.trackIds: must contain at least one track id', data: { details: { errors: [{ path: '$.trackIds', code: 'MINITEMS', message: 'must contain at least one track id' }] } } });
  const unknown = (args.trackIds ?? []).filter((id: string) => !track(ctx.bus.doc, id));
  if (unknown.length) return { success: false, moved: 0, deletedTrackIds: [], message: `Unknown track id(s): ${unknown.join(', ')}` };
  return run(ctx, 'Consolidate tracks', doc => {
    const r = consolidate(doc, args);
    return { success: true, moved: r.moved, deletedTrackIds: r.deletedTrackIds, message: consolidateMessage(r, args.deleteEmptyTracks) };
  });
};
const manageMarkersTool: Handler = (ctx, args) => run(ctx, 'Edit markers', doc => {
  const actions = (args.actions ?? []).map((a: RecordData) => ({ ...a, timeMs: a.time === undefined ? undefined : toMs(a.time) }));
  const r = manageMarkers(doc, actions);
  return { success: true, message: r.message, data: { addedMarkerIds: r.added } };
});

export const TOOLS: Record<string, Handler> = {
  addLayout, addMedia, addMotionGraphic, addShape, addText, applyTransition, changeTrack, cloneItem, consolidateTracks, createMask, deleteItems, editLayout, editMaskProperties, editMotionGraphic, editProperties: editPropertiesTool, manageMarkers: manageMarkersTool, manageTrack: manageTrackTool,
  manageTrackGroup: manageTrackGroupTool, moveItem, removeMask, reorderItems, resizeCanvas: resizeCanvasTool, setTimeRemap: setTimeRemapTool, setUseProxy: setUseProxyTool, slipItem, splitItem, transformItem, trimItem,
  writeEffects: writeEffectsTool, writeKeyframes: writeKeyframesTool, writeMaskPoints, writeShapePoints, ...CAPTION_TOOLS,
};

/** Runs one tool call: result, or a failure shape; plus `timelineChanges` when the document changed. */
export function callTool(ctx: ToolContext, name: string, args: RecordData = {}): ToolResult {
  const handler = TOOLS[name];
  if (!handler) return { success: false, error: `Unknown tool '${name}'`, code: 'UNKNOWN_TOOL' };
  const before = ctx.bus.doc;
  let result: ToolResult;
  try { result = handler(ctx, args ?? {}); } catch (e) {
    if (!(e instanceof CommandError)) throw e;
    result = { success: false, error: e.error, code: e.code };
    if (e.extra.message !== undefined) result.message = e.extra.message;
    if (e.extra.data !== undefined) result.data = e.extra.data;
    if (e.extra.details !== undefined) result.details = e.extra.details;
    if (e.extra.failures !== undefined) result.failures = e.extra.failures;
    if (THROWN.has(e.error) || e.extra.mayHaveRun === false) result.operationMayHaveRun = false;
  }
  const changes = timelineChanges(before, ctx.bus.doc);
  if (changes) result.timelineChanges = changes;
  return result;
}
