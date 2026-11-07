// SPDX-License-Identifier: AGPL-3.0-only
// T12 agent tools for vector masks on the T03 command path: createMask, editMaskProperties, removeMask, writeMaskPoints (contracts
// and results §2 under those names, error codes §8), the mask target of writeKeyframes, the masks view of viewItemDetails (results
// §2 include=masks) and the UI's mask edits (findings §20, part 3 §46.13; wave-3 fixtures in the T12 ticket). Coordinates are canvas
// px at the given time, stored in item-local px (part 5 §54.2 1.1). The Cutframe notes of results §2 apply: unknown modes refused,
// clamps reported in `clamped`, `itemId` next to the stored `agentId`.
import type { ProjectDocument, RecordData } from '../store/model';
import { boxMatrix, fpsOf, itemBox, projectSize } from '../render/model';
import { checkShape, writeKeyframes } from '../timeline/edits';
import { CommandError, fail, item, newId, trackLocked } from '../timeline/model';
import { keyframeId, keyframeList, toPropertyTime, toTimelineMs } from '../timeline/properties';
import { itemFrames, keyframeAt, localOf, timelineTime, updatedPoints } from '../timeline/shape-tools';
import { parsePath, basePath, mapPoints, newPoint, pathAt, pathKeyframes, pathString, presetPoints, shifted, SHAPE_TYPES } from '../timeline/shapes';
import type { PathKeyframe, PathPoint, ShapePath, ShapeType } from '../timeline/shapes';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { maskTarget as maskIn } from './keyframes';
import { clampMask, MASK_KEYS, MASK_MODES, masksOf } from './model';
import type { MaskKey, MaskMode, StoredMask } from './model';

type Handler = (ctx: ToolContext, args: RecordData) => ToolResult;
type Op = { op: 'update' | 'curve' | 'add' | 'remove'; count?: number };
const s3 = (ms: number) => Math.round(ms) / 1000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is RecordData => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
const holder = (m: StoredMask) => m as unknown as RecordData;
const EDITABLE = ['name', 'enabled', 'feather', 'expansion', 'opacity', 'inverted', 'mode'] as const;

// ---- Lookup and refusals shared by the tools (results §2 removeMask's table).
function maskedItem(doc: ProjectDocument, id: unknown): RecordData {
  if (!id) fail('ITEM_NOT_FOUND', 'Item not found', { message: `Item '${show(id ?? '')}' not found on timeline.` });
  const i = item(doc, id as string);
  if (!i) fail('TIMELINE_ITEM_NOT_FOUND', 'Timeline item not found', { message: `Timeline item for '${show(id)}' not found.` });
  return i!;
}
/** "Anything thrown" (results §2): a refusal keeps its code, a bug or a lock takes the tool's. */
function guarded<T>(code: string, error: string, prefix: string, run: () => T): T {
  try { return run(); }
  catch (e) { if (e instanceof CommandError) throw e; return fail(code, error, { message: `${prefix}${(e as Error).message}` }); }
}
const unlocked = (doc: ProjectDocument, i: RecordData, failed: (why: string) => never) => { if (trackLocked(doc, i.trackId)) failed(`Track ${i.trackId} is locked`); };

// ---- The stored record (findings §20, W3-RT-05, W3-CC-04).
const nextOrder = (i: RecordData) => masksOf(i).reduce((top, m) => Math.max(top, (m.order ?? -1) + 1), 0);
export function maskRecord(i: RecordData, o: Partial<StoredMask> & Pick<StoredMask, 'name' | 'points' | 'closed'>): StoredMask {
  return { id: newId('mask'), enabled: true, mode: 'add', order: nextOrder(i), colorIndex: masksOf(i).length, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape', ...o };
}
/** A number within range, listed in `clamped` when it was not. */
function ranged(key: MaskKey, v: unknown, fallback: number, clamped: string[]) {
  if (v === undefined) return fallback;
  if (!finite(v)) fail('INVALID_PROPERTY_VALUE', `${key} must be a finite number`);
  const stored = clampMask(key, v as number);
  if (stored !== v) clamped.push(key);
  return stored;
}
function modeOf(v: unknown): MaskMode {
  if (!(MASK_MODES as readonly unknown[]).includes(v)) fail('INVALID_PROPERTY_VALUE', 'Invalid mask mode', { message: `Mode '${show(v)}' is not valid. Use: ${MASK_MODES.join(', ')}.` });
  return v as MaskMode;
}
const maskPoint = (p: unknown, j: number, say: string): PathPoint => {
  try { return newPoint(p, j); }
  catch (e) { if (e instanceof CommandError && e.code === 'INVALID_POINT') fail('INVALID_POINT_COORDINATES', 'Invalid point coordinates', { message: say }); throw e; }
};

// ---- createMask.
const CREATE_POINT = 'Every mask point needs finite canvas x and y numbers. Handles need finite x and y offsets.';
export const createMask: Handler = (ctx, args) => ctx.bus.run('Edit items', 'agent', doc => guarded('CREATE_MASK_FAILED', 'Failed to create mask', 'Failed to create mask: ', () => {
  if (args.textPrompt !== undefined) fail('VISUAL_SELECTION_REQUIRED', 'Text segmentation has been retired. Use viewMaskFrame, draw normalized strokes with previewSmartMask, then trackSmartMask.');
  const i = maskedItem(doc, args.itemId);
  if (i.type !== 'video' && i.type !== 'image') fail('INVALID_ITEM_TYPE', 'Item type does not support masks', { message: `Masks work on video and image items only; '${i.id}' is ${i.type}.` });
  const custom = Array.isArray(args.points) && args.points.length >= 3, preset = args.shape !== undefined && isObj(args.bounds);
  if (!custom && !preset) fail('INVALID_MASK_DEFINITION', 'Invalid mask definition', { message: 'Provide shape + bounds or at least 3 points. For smart masks, inspect a frame and draw a visual selection.' });
  if (args.timelineSeconds === undefined) fail('MISSING_TIMELINE_SECONDS', 'timelineSeconds is required', { message: 'timelineSeconds sets the canvas-pixel to mask mapping and the first path keyframe.' });
  const t = timelineTime(i, args.timelineSeconds), failed = (why: string): never => fail('CREATE_MASK_FAILED', 'Failed to create mask', { message: `Failed to create mask: ${why}` });
  unlocked(doc, i, failed);
  let canvas: PathPoint[];
  if (preset && !custom) {
    if (!(SHAPE_TYPES as readonly unknown[]).includes(args.shape)) fail('INVALID_SHAPE_TYPE', 'Invalid shape type', { message: `Shape '${show(args.shape)}' is not valid. Use: ${SHAPE_TYPES.join(', ')}.` });
    const b = args.bounds;
    if (!finite(b.width) || !(b.width > 0) || !finite(b.height) || !(b.height > 0) || !['x', 'y', 'cx', 'cy'].every(k => b[k] === undefined || finite(b[k])))
      fail('INVALID_MASK_DEFINITION', 'Invalid mask definition', { message: 'bounds requires a positive width and height and finite x/y or cx/cy coordinates.' });
    const size = projectSize(doc), cx = b.cx ?? (b.x !== undefined ? b.x + b.width / 2 : size.width / 2), cy = b.cy ?? (b.y !== undefined ? b.y + b.height / 2 : size.height / 2);
    canvas = mapPoints([1, 0, 0, 1, cx - b.width / 2, cy - b.height / 2], presetPoints(args.shape as ShapeType, b.width, b.height, args.roundness ?? 0));
  } else canvas = args.points.map((p: unknown, j: number) => maskPoint(p, j, CREATE_POINT));
  const clamped: string[] = [], props = { feather: ranged('feather', args.feather, 0, clamped), expansion: ranged('expansion', args.expansion, 0, clamped), opacity: ranged('opacity', args.opacity, 100, clamped),
    inverted: args.inverted === true, mode: args.mode === undefined ? 'add' as const : modeOf(args.mode) };
  const inv = itemFrames(doc, i, t - i.display.from, failed).inv, points = shifted(mapPoints(inv, canvas), 0, 0), path = { points, closed: true };
  const type = args.shape as string, name = typeof args.name === 'string' && args.name ? args.name : custom ? 'Custom Mask' : `${type[0].toUpperCase()}${type.slice(1)} Mask`;
  const kf: PathKeyframe = { id: keyframeId(), time: toPropertyTime(i, t), value: pathString(path), points, closed: true, easing: 'linear' };
  i.masks = [...masksOf(i), maskRecord(i, { name, points, closed: true, ...props, keyframes: { path: { keyframes: [kf] } } })];
  const total = i.masks.length;
  return { success: true, message: `Created mask '${name}' on '${i.id}' with path keyframe at ${args.timelineSeconds}s.`,
    data: { itemId: i.id, agentId: i.id, maskIndex: total - 1, maskName: name, pointCount: points.length, hasPathKeyframes: true, properties: props, totalMasks: total, ...clamped.length ? { clamped } : {} } };
})) as ToolResult;

// ---- editMaskProperties.
export const editMaskProperties: Handler = (ctx, args) => ctx.bus.run('Edit items', 'agent', doc => guarded('EDIT_MASK_FAILED', 'Failed to edit mask', 'Failed to edit mask: ', () => {
  const i = maskedItem(doc, args.itemId), m = maskIn(i, args.maskIndex), p = isObj(args.properties) ? args.properties : {};
  const keys = EDITABLE.filter(k => p[k] !== undefined);
  if (!keys.length) fail('NO_UPDATES', 'No valid updates', { message: `Provide at least one of: ${EDITABLE.join(', ')}.` });
  unlocked(doc, i, why => fail('EDIT_MASK_FAILED', 'Failed to edit mask', { message: `Failed to edit mask: ${why}` }));
  const clamped: string[] = [];
  for (const k of keys) {
    if (k === 'mode') m.mode = modeOf(p.mode);
    else if (k === 'feather' || k === 'expansion' || k === 'opacity') m[k] = ranged(k, p[k], m[k], clamped);
    else if (k === 'name') { if (typeof p.name !== 'string' || !p.name) fail('INVALID_PROPERTY_VALUE', 'name must be a non-empty string'); m.name = p.name; }
    else { if (typeof p[k] !== 'boolean') fail('INVALID_PROPERTY_VALUE', `${k} must be true or false`); m[k] = p[k]; }
  }
  return { success: true, message: `Updated mask ${args.maskIndex} '${m.name}' on '${i.id}': ${keys.join(', ')}.`,
    data: { itemId: i.id, agentId: i.id, maskIndex: args.maskIndex, maskName: m.name, updatedProperties: keys, currentValues: { enabled: m.enabled !== false, feather: m.feather, expansion: m.expansion, opacity: m.opacity, inverted: !!m.inverted, mode: m.mode }, ...clamped.length ? { clamped } : {} } };
})) as ToolResult;

// ---- removeMask.
export const removeMask: Handler = (ctx, args) => ctx.bus.run('Edit items', 'agent', doc => guarded('REMOVE_MASK_FAILED', 'Failed to remove mask', 'Failed to remove mask: ', () => {
  const i = maskedItem(doc, args.itemId), m = maskIn(i, args.maskIndex);
  unlocked(doc, i, why => fail('REMOVE_MASK_FAILED', 'Failed to remove mask', { message: `Failed to remove mask: ${why}` }));
  i.masks = masksOf(i).filter(x => x !== m);
  return { success: true, message: `Removed mask ${args.maskIndex} '${m.name}' from '${i.id}'.`, data: { itemId: i.id, agentId: i.id, removedMaskIndex: args.maskIndex, removedMaskName: m.name, remainingMasks: i.masks.length } };
})) as ToolResult;

// ---- writeMaskPoints: update / curve, add and remove, each its own "Edit items" command (results §2: not atomic).
const stage = (code: string, error: string, prefix: string) => (why: string): never => fail(code, error, { message: `${prefix}${why}` });
const FAILED = {
  update: stage('UPDATE_POINTS_FAILED', 'Failed to update mask points', 'Failed to update mask points: '),
  add: stage('ADD_POINTS_FAILED', 'Failed to add mask points', 'Failed to add mask points: '),
  remove: stage('REMOVE_POINTS_FAILED', 'Failed to remove mask points', 'Failed to remove mask points: '),
  clear: stage('CLEAR_PATH_KEYFRAMES_FAILED', 'Failed to clear path keyframes', 'Failed to clear path keyframes: '),
};
const keyframed = (index: number, n: number, verb: string) => `Mask ${index} has ${n} path keyframe(s); ${verb} points needs a static path. Clear them first with clearKeyframes: true (keepStateAt keeps one time's shape).`;
/** Mask lookup for every operation of writeMaskPoints (results §2). */
function editable(doc: ProjectDocument, args: RecordData, failed: (why: string) => never) {
  const i = maskedItem(doc, args.itemId), m = maskIn(i, args.maskIndex);
  if (m.source === 'smart' || m.raster) fail('SMART_MASK_NOT_EDITABLE', 'Smart mask not editable', { message: 'Smart masks are AI-tracked and cannot have their points manually edited.' });
  unlocked(doc, i, failed);
  return { i, m, kfs: pathKeyframes(holder(m)) };
}
const writeKeys = (m: StoredMask, list: PathKeyframe[]) => { m.keyframes = { ...m.keyframes, path: { keyframes: [...list].sort((a, b) => a.time - b.time) } }; };
function setKeyPoints(m: StoredMask, list: PathKeyframe[], kf: PathKeyframe, points: PathPoint[]) {
  const path = { points: shifted(points, 0, 0), closed: kf.closed !== false };
  Object.assign(kf, { points: path.points, value: pathString(path) });
  writeKeys(m, list);
}
const setBase = (m: StoredMask, points: PathPoint[]) => { m.points = shifted(points, 0, 0); };
function updateStage(ctx: ToolContext, args: RecordData, curve: boolean): Op {
  const failed = FAILED.update;
  return ctx.bus.run('Edit items', 'agent', doc => guarded('UPDATE_POINTS_FAILED', 'Failed to update mask points', 'Failed to update mask points: ', () => {
    const { i, m, kfs } = editable(doc, args, failed), updates = args.update ?? [];
    if (!Array.isArray(updates) || (!updates.length && !curve)) fail('NO_UPDATES', 'No updates', { message: 'Provide at least one point update, or target a path keyframe to edit its easing/handles.' });
    if (curve && !kfs.length) fail('CURVE_REQUIRES_KEYFRAME', 'Curve requires keyframe', { message: 'Easing/handles can only target an existing keyframe after path keyframes exist.' });
    let target: { list: PathKeyframe[]; kf: PathKeyframe } | null = null;
    if (args.keyframeIndex !== undefined) {
      const n = args.keyframeIndex;
      if (!Number.isInteger(n) || n < 0 || n >= kfs.length)
        fail('INVALID_KEYFRAME_INDEX', 'Invalid keyframe index', { message: `Keyframe index ${show(n)} is out of range. ${kfs.length ? `Valid indices: 0-${kfs.length - 1}` : 'The mask has no path keyframes.'}` });
      target = { list: kfs, kf: kfs[n] };
    } else if (args.at !== undefined) target = keyframeAt(doc, i, timelineTime(i, args.at), holder(m));
    else if (curve) fail('EASING_REQUIRES_TARGET', 'Easing requires target', { message: 'Easing must be used with keyframeIndex (update existing) or at (create new).' });
    else if (kfs.length) fail('TIME_TARGET_REQUIRED', 'Time target required', { message: `Mask ${args.maskIndex} has ${kfs.length} path keyframe(s). Pass keyframeIndex, or at (timeline seconds), to choose the path to edit.` });
    if (curve) checkShape('writeMaskPoints', args);
    const path: ShapePath = target ? { points: target.kf.points ?? [], closed: target.kf.closed !== false } : basePath(holder(m));
    // For masks any empty handle value removes the handle (contracts "Point validation").
    const given = updates.map((u: unknown) => isObj(u) ? { ...u, ...Object.fromEntries(['handleIn', 'handleOut'].filter(h => u[h] !== undefined && !u[h]).map(h => [h, null])) } : u);
    const points = updates.length ? updatedPoints(doc, i, path.points, given, target ? localOf(i, target.kf) : 0, failed) : path.points;
    if (target) {
      if (curve) for (const k of ['easing', 'inHandle', 'outHandle'] as const) if (args[k] !== undefined) (target.kf as RecordData)[k] = args[k];
      setKeyPoints(m, target.list, target.kf, points);
    } else setBase(m, points);
    return updates.length ? { op: 'update', count: updates.length } : { op: 'curve' };
  }));
}
function addStage(ctx: ToolContext, args: RecordData): Op {
  const failed = FAILED.add;
  return ctx.bus.run('Edit items', 'agent', doc => guarded('ADD_POINTS_FAILED', 'Failed to add mask points', 'Failed to add mask points: ', () => {
    const { i, m, kfs } = editable(doc, args, failed);
    if (kfs.length) fail('KEYFRAMED_MASK_NO_ADD', 'Cannot add points to keyframed mask', { message: keyframed(args.maskIndex, kfs.length, 'adding') });
    if (!Array.isArray(args.add) || !args.add.length) fail('NO_POINTS', 'No points', { message: 'Provide at least one point to add.' });
    const points = [...basePath(holder(m)).points], inv = itemFrames(doc, i, 0, failed).inv;
    args.add.forEach((p: RecordData, j: number) => {
      const at = p?.after ?? points.length - 1;
      if (!Number.isInteger(at) || at < -1 || at >= points.length) fail('INVALID_AFTER_INDEX', 'Invalid after index', { message: `afterPointIndex ${show(at)} is out of range. Valid values: -1 to ${points.length - 1}` });
      points.splice(at + 1, 0, mapPoints(inv, [maskPoint(p, j, `A new mask point (${j}) needs finite canvas x and y numbers.`)])[0]);
    });
    setBase(m, points);
    return { op: 'add', count: args.add.length };
  }));
}
function removeStage(ctx: ToolContext, args: RecordData): Op {
  const failed = FAILED.remove;
  return ctx.bus.run('Edit items', 'agent', doc => guarded('REMOVE_POINTS_FAILED', 'Failed to remove mask points', 'Failed to remove mask points: ', () => {
    const { m, kfs } = editable(doc, args, failed);
    if (kfs.length) fail('KEYFRAMED_MASK_NO_REMOVE', 'Cannot remove points from keyframed mask', { message: keyframed(args.maskIndex, kfs.length, 'removing') });
    if (!Array.isArray(args.remove) || !args.remove.length) fail('NO_INDICES', 'No indices', { message: 'Provide at least one point index to remove.' });
    const points = basePath(holder(m)).points, n = points.length, bad = args.remove.find((k: unknown) => !Number.isInteger(k) || (k as number) < 0 || (k as number) >= n);
    if (bad !== undefined) fail('INVALID_POINT_INDEX', 'Invalid point index', { message: `Point index ${show(bad)} is out of range. Valid indices: 0-${n - 1}` });
    const gone = new Set<number>(args.remove), left = n - gone.size;
    if (left < 3) fail('MIN_POINTS_REQUIRED', 'Cannot remove points', { message: `Removing ${gone.size} point(s) would leave ${left} point(s). Minimum 3 points required.` });
    setBase(m, points.filter((_, k) => !gone.has(k)));
    return { op: 'remove', count: gone.size };
  }));
}
function clearStage(ctx: ToolContext, args: RecordData): ToolResult {
  const index = args.maskIndex;
  return ctx.bus.run('Edit items', 'agent', doc => guarded('CLEAR_PATH_KEYFRAMES_FAILED', 'Failed to clear path keyframes', 'Failed to clear path keyframes: ', () => {
    const { i, m, kfs } = editable(doc, args, FAILED.clear);
    if (!kfs.length) return { success: true, message: `Mask ${index} has no path keyframes to clear.`, data: { itemId: i.id, agentId: i.id, maskIndex: index, clearedCount: 0 } };
    // keepStateAt: the path drawn at that time becomes the base path; without it the base path stays (T06's choice).
    const kept = args.keepStateAt === undefined ? null : structuredClone(pathAt(holder(m), toPropertyTime(i, timelineTime(i, args.keepStateAt))));
    const { path: _, ...rest } = m.keyframes ?? {};
    if (Object.keys(rest).length) m.keyframes = rest; else delete m.keyframes;
    if (kept) { m.points = kept.points; m.closed = kept.closed; }
    return { success: true, message: `Cleared ${kfs.length} path keyframe(s) from mask ${index}. Points can now be added/removed.`, data: { itemId: i.id, agentId: i.id, maskIndex: index, clearedCount: kfs.length, pointCount: m.points.length } };
  })) as ToolResult;
}
export const writeMaskPoints: Handler = (ctx, args) => {
  if (typeof args.itemId !== 'string' || !args.itemId || args.maskIndex === undefined) fail('MISSING_PARAM', 'itemId and maskIndex are required');
  if (args.at !== undefined && args.keyframeIndex !== undefined) fail('INVALID_COMBINATION', 'Specify either `at` (timeline time) OR `keyframeIndex`, not both');
  const curve = ['easing', 'inHandle', 'outHandle'].some(k => args[k] !== undefined);
  if (args.clearKeyframes === true) {
    if (curve || ['update', 'add', 'remove', 'at', 'keyframeIndex'].some(k => args[k] !== undefined)) fail('INVALID_COMBINATION', '`clearKeyframes: true` is exclusive — no other ops allowed in the same call');
    return clearStage(ctx, args);
  }
  if (args.update === undefined && args.add === undefined && args.remove === undefined && !curve) fail('NO_UPDATES', 'No ops provided. Use add / update / remove / curve (easing,inHandle,outHandle) / clearKeyframes.');
  const ops: Op[] = [];
  if (args.update !== undefined || curve) ops.push(updateStage(ctx, args, curve));
  if (args.add !== undefined) ops.push(addStage(ctx, args));
  if (args.remove !== undefined) ops.push(removeStage(ctx, args));
  return { success: true, message: `writeMaskPoints on mask ${args.maskIndex}: ${ops.map(o => o.count === undefined ? o.op : `${o.op}(${o.count})`).join(' + ')}`, ops };
};

// ---- viewItemDetails include=masks (results §2 MaskView).
const viewPoints = (points: PathPoint[]) => points.map((p, index) => ({ index, ...p }));
const pathEditing = { canAddPoints: true, canRemovePoints: true, canMovePoints: true, requiresKeyframeIndex: false };
export function maskViews(doc: ProjectDocument, i: RecordData): RecordData | null {
  const list = masksOf(i);
  if (!list.length) return null;
  const canvas = (points: PathPoint[], t: number) => shifted(mapPoints(boxMatrix(itemBox(doc, i, t)), points), 0, 0);
  return { items: list.map((m, index) => {
    const base = { index, name: m.name ?? `Mask ${index}`, enabled: m.enabled !== false, mode: m.mode, inverted: !!m.inverted, properties: { feather: m.feather, expansion: m.expansion, opacity: m.opacity } };
    const props = Object.fromEntries(MASK_KEYS.flatMap(k => m.keyframes?.[k]?.keyframes?.length ? [[k, keyframeList(m.keyframes[k]!.keyframes, t => toTimelineMs(i, t)).map((kf: RecordData, n: number) => ({ index: n, ...kf }))]] : []));
    const animated = Object.keys(props).length ? { propertyKeyframes: props } : {};
    if (m.source === 'smart' || m.raster) return { ...base, type: 'smart', trackingLabel: 'tracked object', pathEditing: { canAddPoints: false, canRemovePoints: false, canMovePoints: false, reason: 'Smart masks are AI-tracked and cannot be manually edited' }, ...animated };
    const kfs = pathKeyframes(holder(m));
    if (!kfs.length) return { ...base, type: 'path', closed: m.closed !== false, pointCount: m.points?.length ?? 0, points: viewPoints(canvas(m.points ?? [], 0)), pathEditing, ...animated };
    const now = pathAt(holder(m), toPropertyTime(i, i.display.from));
    return { ...base, type: 'path', closed: m.closed !== false, pathKeyframes: kfs.map((k, n) => ({ index: n, timelineSeconds: s3(toTimelineMs(i, k.time)), easing: k.easing, pointCount: k.points?.length ?? 0, points: viewPoints(canvas(k.points ?? [], localOf(i, k))) })),
      currentInterpolatedPoints: { note: 'The path at the clip start.', pointCount: now.points.length, points: viewPoints(canvas(now.points, 0)) },
      pathEditing: { canAddPoints: false, canRemovePoints: false, canMovePoints: true, requiresKeyframeIndex: true, note: 'Pass keyframeIndex or at to writeMaskPoints.' }, ...animated };
  }) };
}
/** The `masks` / `masksNote` fields of viewItemDetails; also the gate's `currentState` (scope masks). */
export const masksBlock = (doc: ProjectDocument, i: RecordData) => { const masks = maskViews(doc, i); return masks ? { masks } : { masks: null, masksNote: 'No masks on this item' }; };

// ---- UI edits (findings §20 W3-RT-05, part 3 §46.13), each inside the caller's bus command. Points in item-local px.
export function maskable(doc: ProjectDocument, id: string): RecordData {
  const i = item(doc, id);
  if (!i) fail('TIMELINE_ITEM_NOT_FOUND', 'Timeline item not found', { message: `Timeline item for '${id}' not found.` });
  if (trackLocked(doc, i!.trackId)) fail('TRACK_LOCKED', `Track ${i!.trackId} is locked`);
  return i!;
}
/** A UI-drawn mask: "Mask <n>", a static path, source "shape". Returns its index. */
export function drawMask(doc: ProjectDocument, id: string, path: ShapePath): number {
  const i = maskable(doc, id), list = masksOf(i);
  i.masks = [...list, maskRecord(i, { name: `Mask ${list.length + 1}`, points: shifted(path.points, 0, 0), closed: path.closed })];
  return list.length;
}
export function patchMask(doc: ProjectDocument, id: string, index: number, patch: Partial<StoredMask>) {
  const m = masksOf(maskable(doc, id))[index];
  if (m) Object.assign(m, patch);
}
export function deleteMask(doc: ProjectDocument, id: string, index: number) {
  const i = maskable(doc, id);
  i.masks = masksOf(i).filter((_, k) => k !== index);
}
/** Mask card up / down: the neighbour in draw order swaps its `order`. */
export function reorderMask(doc: ProjectDocument, id: string, index: number, by: -1 | 1) {
  const list = masksOf(maskable(doc, id)), byOrder = list.map((m, k) => ({ m, k })).sort((a, b) => a.m.order - b.m.order || a.k - b.k), at = byOrder.findIndex(e => e.k === index), other = byOrder[at + by];
  if (at < 0 || !other) return;
  byOrder.forEach((e, n) => { e.m.order = n; });
  byOrder[at].m.order = at + by; other.m.order = at;
}
/** The pen tool on the mask's path at the playhead: a keyframed path edits (or makes) the path keyframe there. */
export function editMaskPath(doc: ProjectDocument, id: string, index: number, points: PathPoint[], playheadMs: number) {
  const i = maskable(doc, id), m = masksOf(i)[index];
  if (!m) return;
  if (pathKeyframes(holder(m)).length) {
    const { list, kf } = keyframeAt(doc, i, Math.min(Math.max(playheadMs, i.display.from), i.display.to), holder(m));
    setKeyPoints(m, list, kf, points);
  } else setBase(m, points);
}
/** Delete on a picked anchor: the same refusals as writeMaskPoints `remove`. */
function removeMaskPoint(doc: ProjectDocument, id: string, index: number, point: number) {
  const m = masksOf(maskable(doc, id))[index];
  if (!m) return;
  const kfs = pathKeyframes(holder(m)), points = basePath(holder(m)).points;
  if (kfs.length) fail('KEYFRAMED_MASK_NO_REMOVE', 'Cannot remove points from keyframed mask', { message: keyframed(index, kfs.length, 'removing') });
  if (points.length - 1 < 3) fail('MIN_POINTS_REQUIRED', 'Cannot remove points', { message: `Removing 1 point(s) would leave ${points.length - 1} point(s). Minimum 3 points required.` });
  setBase(m, points.filter((_, k) => k !== point));
}
const within = (i: RecordData, atMs: number) => Math.min(Math.max(atMs, i.display.from), i.display.to);
/** A slider: the base value while the property has no keyframes, else the keyframe under the playhead (made there when none is). */
function setMaskValue(doc: ProjectDocument, id: string, index: number, key: MaskKey, value: number, atMs: number) {
  const i = maskable(doc, id), m = masksOf(i)[index];
  if (!m) return;
  const list = m.keyframes?.[key]?.keyframes ?? [], t = within(i, atMs), hit = list.find(k => Math.abs(toTimelineMs(i, k.time) - t) <= 500 / fpsOf(doc));
  if (!list.length) m[key] = clampMask(key, value);
  else writeKeyframes(doc, { itemId: id, maskIndex: index, payload: { [key]: { add: [{ time: (hit ? toTimelineMs(i, hit.time) : t) / 1000, value: clampMask(key, value) }] } } });
}
/** A keyframe button: adds the keyframe at the playhead holding the value drawn there, or removes the one under it. Removing the
 *  last path keyframe keeps its path as the static path. */
function toggleMaskKeyframe(doc: ProjectDocument, id: string, index: number, key: MaskKey | 'path', atMs: number) {
  const i = maskable(doc, id), m = masksOf(i)[index], t = within(i, atMs);
  if (!m) return;
  if (key !== 'path') {
    const hit = m.keyframes?.[key]?.keyframes.find(k => Math.abs(toTimelineMs(i, k.time) - t) <= 500 / fpsOf(doc));
    writeKeyframes(doc, { itemId: id, maskIndex: index, payload: { [key]: hit ? { remove: [toTimelineMs(i, hit.time) / 1000] } : { add: [{ time: t / 1000 }] } } });
    return;
  }
  const list = pathKeyframes(holder(m)), hit = list.find(k => Math.abs(toTimelineMs(i, k.time) - t) < 1000 / fpsOf(doc));
  if (!hit) { writeKeys(m, keyframeAt(doc, i, t, holder(m)).list); return; }
  if (list.length === 1) setBase(m, hit.points ?? parsePath(hit.value).points);
  writeKeys(m, list.filter(k => k !== hit));
}
/** One inspector or stage edit (intent `maskEdit`): one "Edit items" entry. Coordinates are item-local px. */
export type MaskOp =
  | { op: 'draw'; path: ShapePath } | { op: 'path'; index: number; points: PathPoint[]; atMs: number } | { op: 'patch'; index: number; patch: Partial<StoredMask> }
  | { op: 'delete'; index: number } | { op: 'removePoint'; index: number; point: number } | { op: 'move'; index: number; by: -1 | 1 }
  | { op: 'value'; index: number; key: MaskKey; value: number; atMs: number } | { op: 'keyframe'; index: number; key: MaskKey | 'path'; atMs: number };
export function editMask(doc: ProjectDocument, id: string, o: MaskOp) {
  switch (o.op) {
    case 'draw': drawMask(doc, id, o.path); break;
    case 'path': editMaskPath(doc, id, o.index, o.points, o.atMs); break;
    case 'patch': patchMask(doc, id, o.index, o.patch); break;
    case 'delete': deleteMask(doc, id, o.index); break;
    case 'removePoint': removeMaskPoint(doc, id, o.index, o.point); break;
    case 'move': reorderMask(doc, id, o.index, o.by); break;
    case 'value': setMaskValue(doc, id, o.index, o.key, o.value, o.atMs); break;
    case 'keyframe': toggleMaskKeyframe(doc, id, o.index, o.key, o.atMs); break;
  }
}
