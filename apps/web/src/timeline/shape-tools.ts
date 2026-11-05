// SPDX-License-Identifier: AGPL-3.0-only
// T06 shape items on the T03 command path: the agent tools addShape and writeShapePoints (contracts addShape,
// writeMaskPoints / writeShapePoints, "Point validation"; error codes §8; results §2 writeMaskPoints for the mirrored
// result shapes), the UI's draw and pen edits (findings §20, part 3 §46.4; W3-RT-08), the box refit after a path edit and
// the shape part of viewItemDetails include=general (results §2 viewItemDetails). Geometry lives in shapes.ts.
import type { ProjectDocument, RecordData } from '../store/model';
import { apply, boxMatrix, fpsOf, itemBox, projectSize } from '../render/model';
import { overlap } from '../mg/tools';
import { checkProperty, checkShape } from './edits';
import { canInsertAfter, insertAfter } from './items';
import { blockers, CommandError, fail, fmt, freeTracks, insertTrack, item, newId, newTrack, span, toMs, track, trackLocked } from './model';
import { ensureProp, keyframeId, rateOf, setStatic, staticValue, toPropertyTime, toTimelineMs } from './properties';
import {
  basePath, fitted, HANDLES, invert, mapPoints, newPoint, pathAt, pathKeyframes, pathString, presetPoints, r2, SHAPE_STYLE, SHAPE_TYPES, shapeRecord, shifted,
  updatedPoint,
} from './shapes';
import type { PathKeyframe, PathPoint, ShapePath, ShapeType } from './shapes';
import type { ToolContext, ToolResult } from './tools';

type Handler = (ctx: ToolContext, args: RecordData) => ToolResult;
type Op = { op: 'update' | 'curve' | 'add' | 'remove'; count?: number };
const s3 = (ms: number) => Math.round(ms) / 1000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is RecordData => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
/** A new shape lasts 5 s (W3-RT-08); Cutframe uses the same default for addShape without `duration`. */
export const SHAPE_MS = 5000;
const STYLE_KEYS = ['fillColor', 'fillOpacity', 'strokeColor', 'strokeWidth', 'strokeOpacity'] as const;
const NO_UPDATES = 'Provide at least one point update, or target a path keyframe to edit its easing/handles.';
const BOUNDS = 'bounds requires a positive width and height and finite x/y or cx/cy coordinates.';
const noPoints = (): never => fail('NO_SHAPE_POINTS', 'No shape points', { message: 'Custom shapes require at least one valid bezier point.' });
const noBounds = (id: string): never => fail('NO_SHAPE_PATH_BOUNDS', 'No shape path bounds', { message: `Shape "${id}" could not be fitted to its edited path.` });

// ---- The stored item, its placement and the refit.
/** The playhead's frame start (Q4, W3-RT-08): floor(t · fps / 1000) frames, in whole ms. */
export const startFrameMs = (doc: ProjectDocument, playheadMs: number) => { const fps = fpsOf(doc); return Math.round(Math.floor(playheadMs * fps / 1000 + 1e-6) * 1000 / fps); };
/** The lowest unlocked overlay track free over the span, else a new overlay track by the kind rule (Q5; fixture 4). */
export function shapeTrack(doc: ProjectDocument, range: { from: number; to: number }): string {
  const free = freeTracks(doc, 'overlay', range);
  return free.length ? free[free.length - 1] : insertTrack(doc, newTrack(doc, 'overlay')).id;
}
/** A shape item from a canvas-px path: its box is the path's bounds, its points relative to the box (W3-RT-08). */
export function shapeFromPath(o: { shapeType: string; path: ShapePath; trackId: string; display: { from: number; to: number }; style: Record<string, unknown> }): RecordData {
  const f = fitted(o.path);
  if (!f) fail('NO_SHAPE_PATH_BOUNDS', 'No shape path bounds', { message: `The ${o.shapeType} path has no visible bounds: its points span no width or no height.` });
  return shapeRecord({ id: newId('item'), trackId: o.trackId, display: o.display, shapeType: o.shapeType, points: f.points, closed: o.path.closed,
    x: r2(f.box.x), y: r2(f.box.y), width: r2(f.box.width), height: r2(f.box.height), style: o.style });
}
const shiftProp = (i: RecordData, key: string, d: number) => {
  if (!(Math.abs(d) > 1e-6)) return;
  const p = ensureProp(i, key);
  p.defaultValue = r2(Number(p.defaultValue ?? 0) + d);
  p.keyframes = p.keyframes.map(k => typeof k.value === 'number' ? { ...k, value: r2(k.value + d) } : k);
};
/** Writes the base path (item-local px) and refits the box to its bounds so the drawn path stays put at item-local ms
 *  `local`: points move to the bounds' top-left, width / height become the bounds, and the position (default and every
 *  keyframe) moves by the change of the box's top-left. false when the path has no bounds. */
export function setBasePath(doc: ProjectDocument, i: RecordData, path: ShapePath, local = 0): boolean {
  const f = fitted(path);
  if (!f) return false;
  const old = itemBox(doc, i, local), W = r2(f.box.width), H = r2(f.box.height), [cx, cy] = apply(boxMatrix(old), f.box.x + W / 2, f.box.y + H / 2);
  shiftProp(i, 'positionX', cx - Math.abs(W * old.sx) / 2 - old.x);
  shiftProp(i, 'positionY', cy - Math.abs(H * old.sy) / 2 - old.y);
  setStatic(i, 'width', W); setStatic(i, 'height', H);
  i.details = { ...i.details, points: f.points, closed: path.closed, path: pathString({ points: f.points, closed: path.closed }), width: W, height: H };
  return true;
}
/** The path keyframe at timeline ms t: an existing one within one frame (the nearest), else a new one holding the path
 *  drawn there (results §2 writeMaskPoints, "Which keyframe an update touches"). */
function keyframeAt(doc: ProjectDocument, i: RecordData, t: number): { list: PathKeyframe[]; kf: PathKeyframe } {
  const list = pathKeyframes(i.details), d = (k: PathKeyframe) => Math.abs(toTimelineMs(i, k.time) - t);
  const near = list.filter(k => d(k) < 1000 / fpsOf(doc)).sort((a, b) => d(a) - d(b))[0];
  if (near) return { list, kf: near };
  const time = toPropertyTime(i, t), path = structuredClone(pathAt(i.details, time));
  const kf: PathKeyframe = { id: keyframeId(), time, value: pathString(path), points: path.points, closed: path.closed, easing: 'linear' };
  list.push(kf);
  return { list, kf };
}
const writePathKeyframes = (i: RecordData, list: PathKeyframe[]) => {
  i.details = { ...i.details, keyframes: { ...i.details?.keyframes, path: { keyframes: [...list].sort((a, b) => a.time - b.time) } } };
};
/** Rewrites one path keyframe's points (rounded; no refit: the box follows the base path). false when it has no bounds. */
function setKeyframePath(i: RecordData, list: PathKeyframe[], kf: PathKeyframe, points: PathPoint[]): boolean {
  const path = { points: shifted(points, 0, 0), closed: kf.closed !== false };
  if (!fitted(path)) return false;
  Object.assign(kf, { points: path.points, value: pathString(path) });
  writePathKeyframes(i, list);
  return true;
}
/** A shape's box matrix at item-local ms and its inverse; a box with no area (scale 0) cannot take canvas points. */
function frames(doc: ProjectDocument, i: RecordData, local: number, failed: (why: string) => never) {
  const m = boxMatrix(itemBox(doc, i, local)), inv = invert(m);
  return inv ? { m, inv } : failed('the shape has no visible size at that time (scale 0)');
}
const localOf = (i: RecordData, k: PathKeyframe) => toTimelineMs(i, k.time) - i.display.from;
/** createMask's TIME_OUT_OF_RANGE text for a timeline time in seconds outside the item. */
function timelineTime(i: RecordData, s: unknown): number {
  const t = finite(s) ? toMs(s) : NaN;
  if (!(t >= i.display.from - 1e-6 && t <= i.display.to + 1e-6)) fail('TIME_OUT_OF_RANGE', 'Time out of range', { message: `Timeline time ${show(s)}s is outside item bounds (${fmt(i.display.from)}s - ${fmt(i.display.to)}s).` });
  return t;
}

// ---- addShape (contracts addShape; placement as addMotionGraphic, T08).
function customPoints(input: unknown): PathPoint[] {
  const checked = (Array.isArray(input) ? input : []).map((p, j) => { try { return newPoint(p, j); } catch (e) { if (e instanceof CommandError) return e; throw e; } });
  if (!checked.some(p => !(p instanceof CommandError))) noPoints();
  const bad = checked.find(p => p instanceof CommandError);
  if (bad) throw bad;
  return checked as PathPoint[];
}
/** Fill and stroke from the call: checked as editProperties would; a stroke width with no colour strokes #000000. */
function shapeStyle(args: RecordData): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) if (args[k] !== undefined) { checkProperty({ type: 'shape' }, k, args[k]); style[k] = args[k]; }
  if (style.strokeColor === undefined && Number(style.strokeWidth) > 0) style.strokeColor = '#000000';
  return style;
}
export const addShape: Handler = (ctx, args) => ctx.bus.run(args.insertAfterItemId !== undefined ? 'Insert items' : 'Add items', 'agent', doc => {
  const ref: string | undefined = args.insertAfterItemId;
  if (ref !== undefined && (args.trackId !== undefined || args.timelineStart !== undefined))
    fail('INVALID_COMBINATION', `insertAfter cannot be used with ${['trackId', 'timelineStart'].filter(k => args[k] !== undefined).join(', ')}. Use insertAfterItemId alone, or trackId with timelineStart.`);
  if (ref !== undefined) {
    const r = item(doc, ref);
    if (!r) fail('INSERT_AFTER_NOT_FOUND', 'insertAfter item not found', { message: `Item '${ref}' not found on the timeline. Read context for current item ids.` });
    if (!track(doc, r.trackId)) fail('INSERT_AFTER_NO_TRACK', 'insertAfter item not on any track');
    if (!canInsertAfter('shape', r)) fail('INSERT_AFTER_TYPE_MISMATCH', 'insertAfter type mismatch', { message: `Cannot insert shape after ${r.type} item '${ref}'. The new item requires a compatible track kind.` });
  }
  const custom = args.points !== undefined, closed = args.closed !== false;
  if (args.shape !== undefined && custom) fail('INVALID_COMBINATION', 'Provide either shape (a preset with bounds) or points (a custom path), not both.');
  if (args.shape === undefined && !custom) fail('NO_SHAPE_SPECIFIED', 'No shape specified', { message: "Must provide either 'shape' (preset) or 'points' (custom bezier path)." });
  let path: ShapePath;
  if (!custom) {
    if (!(SHAPE_TYPES as readonly unknown[]).includes(args.shape)) fail('INVALID_SHAPE_TYPE', 'Invalid shape type', { message: `Shape '${show(args.shape)}' is not valid. Use: ${SHAPE_TYPES.join(', ')}.` });
    const b = args.bounds;
    if (!isObj(b) || !finite(b.width) || !(b.width > 0) || !finite(b.height) || !(b.height > 0) || !['x', 'y', 'cx', 'cy'].every(k => b[k] === undefined || finite(b[k])))
      fail('INVALID_BOUNDS', 'Invalid bounds', { message: BOUNDS });
    if (args.roundness !== undefined && !(finite(args.roundness) && args.roundness >= 0 && args.roundness <= 100)) fail('INVALID_PROPERTY_VALUE', 'roundness must be from 0 to 100');
    // Centre: cx / cy, else x / y as the top-left, else the canvas centre (Cutframe choice).
    const size = projectSize(doc), cx = b.cx ?? (b.x !== undefined ? b.x + b.width / 2 : size.width / 2), cy = b.cy ?? (b.y !== undefined ? b.y + b.height / 2 : size.height / 2);
    path = { points: mapPoints([1, 0, 0, 1, cx - b.width / 2, cy - b.height / 2], presetPoints(args.shape as ShapeType, b.width, b.height, args.roundness ?? 0)), closed };
  } else {
    const preset = ['bounds', 'roundness'].filter(k => args[k] !== undefined);
    if (preset.length) fail('INVALID_COMBINATION', `${preset.join(' and ')} ${preset.length > 1 ? 'apply' : 'applies'} to shape presets only; a points path is placed by its own canvas coordinates.`);
    path = { points: customPoints(args.points), closed };
  }
  const style = shapeStyle(args), length = args.duration === undefined ? SHAPE_MS : finite(args.duration) ? toMs(args.duration) : NaN;
  if (!(length > 0)) fail('INVALID_DURATION', `duration must be positive. Received: ${show(args.duration)}s.`);
  const shapeType = custom ? 'custom' : args.shape as string, record = shapeFromPath({ shapeType, path, trackId: '', display: { from: 0, to: length }, style });
  if (ref !== undefined) insertAfter(doc, ref, [record]);
  else {
    if (!args.trackId) fail('MISSING_TRACK_ID', 'trackId is required');
    const t = track(doc, args.trackId);
    if (!t || t.kind !== 'overlay') fail('INVALID_TRACK', `Overlay track '${args.trackId}' not found`);
    if (trackLocked(doc, t.id)) fail('TRACK_LOCKED', `Track '${t.id}' is locked`);
    const from = args.timelineStart === undefined ? 0 : finite(args.timelineStart) ? toMs(args.timelineStart) : NaN;
    if (!(from >= 0)) fail('INVALID_TIMELINE_START', `timelineStart must be >= 0. Received: ${show(args.timelineStart)}s.`);
    record.trackId = t.id; record.display = { from, to: from + length };
    const hit = blockers(doc, t.id, record.display)[0];
    if (hit) overlap(doc, t.id, record.display, hit);
    doc.items.push(record);
  }
  const v = (k: string) => record.properties[k].defaultValue;
  return { success: true, message: `Shape '${record.id}' (${shapeType}) added to track '${record.trackId}' at ${fmt(record.display.from)}s`,
    data: { itemId: record.id, trackId: record.trackId, shapeType, pointCount: record.details.points.length, timelineStart: s3(record.display.from), duration: s3(length),
      bounds: { x: v('positionX'), y: v('positionY'), width: v('width'), height: v('height') } } };
}) as ToolResult;

// ---- writeShapePoints: update / curve, add and remove, each its own "Edit items" command (contracts: not atomic, Q7).
function shapeOf(doc: ProjectDocument, id: string, failed: (why: string) => never): RecordData {
  const i = item(doc, id);
  if (!i) fail('SHAPE_NOT_FOUND', 'Shape not found', { message: `Shape '${id}' not found on timeline.` });
  if (i.type !== 'shape') fail('NOT_A_SHAPE', 'Not a shape', { message: `Item "${id}" is not a shape (type: ${i.type}).` });
  if (trackLocked(doc, i.trackId)) failed(`Track ${i.trackId} is locked`);
  return i;
}
const stageFailed = (code: string, error: string, text: (id: string, why: string) => string) => (id: string) => (why: string): never => fail(code, error, { message: text(id, why) });
const FAILED = {
  update: stageFailed('SHAPE_POINT_UPDATE_FAILED', 'Failed to update shape points', (id, why) => `Failed to update shape "${id}" points: ${why}`),
  add: stageFailed('SHAPE_POINT_ADD_FAILED', 'Failed to add shape points', (id, why) => `Failed to add points to shape "${id}": ${why}`),
  remove: stageFailed('SHAPE_POINT_REMOVE_FAILED', 'Failed to remove shape points', (id, why) => `Failed to remove points from shape "${id}": ${why}`),
  clear: stageFailed('CLEAR_SHAPE_PATH_KEYFRAMES_FAILED', 'Failed to clear path keyframes', (id, why) => `Failed to clear path keyframes from shape "${id}": ${why}`),
};
const keyframed = (id: string, n: number, verb: string) => `Shape "${id}" has ${n} path keyframe(s); ${verb} points needs a static path. Clear them first with clearKeyframes: true (keepStateAt keeps one time's shape).`;
/** Applies update[] (canvas px) to item-local points with the box at item-local ms `local`. */
function edited(doc: ProjectDocument, i: RecordData, points: PathPoint[], updates: unknown[], local: number, failed: (why: string) => never): PathPoint[] {
  const n = points.length, out = [...points];
  for (const u of updates) {
    const k = isObj(u) ? u.pointIndex : undefined;
    if (!isObj(u) || !Number.isInteger(k) || k < 0 || k >= n) fail('INVALID_POINT_INDEX', 'Invalid point index', { message: `Point index ${show(k)} is out of range. Valid indices: 0-${n - 1}` });
  }
  const { m, inv } = frames(doc, i, local, failed);
  for (const u of updates as RecordData[]) {
    const k = u.pointIndex, back = mapPoints(inv, [updatedPoint(mapPoints(m, [out[k]])[0], u, k)])[0], next: PathPoint = { anchor: u.anchor !== undefined ? back.anchor : out[k].anchor };
    for (const h of HANDLES) { const v = u[h] === undefined ? out[k][h] : u[h] === null ? undefined : back[h]; if (v) next[h] = v; }
    out[k] = next;
  }
  return out;
}
function updateStage(ctx: ToolContext, args: RecordData, curve: boolean): Op {
  const id: string = args.itemId, failed = FAILED.update(id);
  return ctx.bus.run('Edit items', 'agent', doc => {
    const i = shapeOf(doc, id, failed), kfs = pathKeyframes(i.details), updates = args.update ?? [];
    if (!Array.isArray(updates) || (!updates.length && !curve)) fail('NO_UPDATES_PROVIDED', 'No updates provided', { message: NO_UPDATES });
    if (curve && !kfs.length) fail('CURVE_REQUIRES_KEYFRAME', 'Curve requires keyframe', { message: 'Easing/handles can only target an existing keyframe after path keyframes exist.' });
    let target: { list: PathKeyframe[]; kf: PathKeyframe } | null = null;
    if (args.keyframeIndex !== undefined) {
      const n = args.keyframeIndex;
      if (!Number.isInteger(n) || n < 0 || n >= kfs.length)
        fail('INVALID_KEYFRAME_INDEX', 'Invalid keyframe index', { message: `Keyframe index ${show(n)} is out of range. ${kfs.length ? `Valid indices: 0-${kfs.length - 1}` : 'The shape has no path keyframes.'}` });
      target = { list: kfs, kf: kfs[n] };
    } else if (args.at !== undefined) target = keyframeAt(doc, i, timelineTime(i, args.at));
    else if (kfs.length) fail('TIME_TARGET_REQUIRED', 'Time target required', { message: `Shape "${id}" has ${kfs.length} path keyframe(s). Pass keyframeIndex, or at (timeline seconds), to choose the path to edit.` });
    if (curve) checkShape('writeShapePoints', args);
    const path = target ? { points: target.kf.points ?? [], closed: target.kf.closed !== false } : basePath(i.details);
    if (updates.length && !path.points.length) noPoints();
    const points = updates.length ? edited(doc, i, path.points, updates, target ? localOf(i, target.kf) : 0, failed) : path.points;
    if (target) {
      if (curve) for (const k of ['easing', 'inHandle', 'outHandle'] as const) if (args[k] !== undefined) (target.kf as RecordData)[k] = args[k];
      if (!setKeyframePath(i, target.list, target.kf, points)) noBounds(id);
    } else if (!setBasePath(doc, i, { points, closed: path.closed })) noBounds(id);
    return updates.length ? { op: 'update', count: updates.length } : { op: 'curve' };
  });
}
function addStage(ctx: ToolContext, args: RecordData): Op {
  const id: string = args.itemId, failed = FAILED.add(id);
  return ctx.bus.run('Edit items', 'agent', doc => {
    const i = shapeOf(doc, id, failed), kfs = pathKeyframes(i.details);
    if (kfs.length) fail('KEYFRAMED_SHAPE_NO_ADD', 'Cannot add points to keyframed shape', { message: keyframed(id, kfs.length, 'adding') });
    if (!Array.isArray(args.add) || !args.add.length) fail('NO_POINTS_PROVIDED', 'No points provided', { message: 'Provide at least one new point with an anchor position.' });
    const path = basePath(i.details), n = path.points.length, at = args.insertAt ?? n;
    if (!Number.isInteger(at) || at < 0 || at > n) fail('INVALID_INSERT_INDEX', 'Invalid insert index', { message: `Insert index ${show(at)} is out of range. Valid range: 0-${n}` });
    const fresh = args.add.map((p: unknown, j: number) => newPoint(p, j)), points = [...path.points];
    points.splice(at, 0, ...mapPoints(frames(doc, i, 0, failed).inv, fresh));
    if (!setBasePath(doc, i, { points, closed: path.closed })) noBounds(id);
    return { op: 'add', count: fresh.length };
  });
}
/** Points left after removing `gone` must still make a path: 3 for a closed path, 2 for an open one (Q13). */
function checkRemoval(path: ShapePath, gone: Set<number>) {
  const left = path.points.length - gone.size, min = path.closed ? 3 : 2;
  if (left < min) fail('MINIMUM_POINTS_REQUIRED', 'Cannot remove points', { message: `Removing ${gone.size} point(s) would leave ${left} point(s). Minimum ${min} points required.` });
}
function removeStage(ctx: ToolContext, args: RecordData): Op {
  const id: string = args.itemId, failed = FAILED.remove(id);
  return ctx.bus.run('Edit items', 'agent', doc => {
    const i = shapeOf(doc, id, failed), kfs = pathKeyframes(i.details);
    if (kfs.length) fail('KEYFRAMED_SHAPE_NO_REMOVE', 'Cannot remove points from keyframed shape', { message: keyframed(id, kfs.length, 'removing') });
    if (!Array.isArray(args.remove) || !args.remove.length) fail('NO_INDICES_PROVIDED', 'No indices provided', { message: 'Provide at least one point index to remove.' });
    const path = basePath(i.details), n = path.points.length;
    if (!n) noPoints();
    const bad = args.remove.filter((k: unknown) => !Number.isInteger(k) || (k as number) < 0 || (k as number) >= n);
    if (bad.length) fail('INVALID_POINT_INDICES', 'Invalid point indices', { message: `Point indices ${bad.map(show).join(', ')} are out of range. Valid indices: 0-${n - 1}` });
    const gone = new Set<number>(args.remove);
    checkRemoval(path, gone);
    if (!setBasePath(doc, i, { points: path.points.filter((_, k) => !gone.has(k)), closed: path.closed })) noBounds(id);
    return { op: 'remove', count: gone.size };
  });
}
function clearStage(ctx: ToolContext, args: RecordData): ToolResult {
  const id: string = args.itemId, failed = FAILED.clear(id);
  return ctx.bus.run('Edit items', 'agent', doc => {
    const i = shapeOf(doc, id, failed), kfs = pathKeyframes(i.details);
    if (!kfs.length) return { success: true, message: `Shape "${id}" has no path keyframes to clear.`, data: { itemId: id, clearedCount: 0 } };
    // keepStateAt: the path drawn at that time becomes the base path; without it the base path stays (Cutframe choice).
    const t = args.keepStateAt === undefined ? null : timelineTime(i, args.keepStateAt), kept = t === null ? null : structuredClone(pathAt(i.details, toPropertyTime(i, t)));
    const { path: _, ...rest } = i.details.keyframes ?? {};
    i.details = { ...i.details, keyframes: rest };
    if (!Object.keys(rest).length) delete i.details.keyframes;
    if (kept && !setBasePath(doc, i, kept, t! - i.display.from)) noBounds(id);
    return { success: true, message: `Cleared ${kfs.length} path keyframe(s) from shape "${id}". Points can now be added/removed.`, data: { itemId: id, clearedCount: kfs.length, pointCount: basePath(i.details).points.length } };
  }) as ToolResult;
}
export const writeShapePoints: Handler = (ctx, args) => {
  if (typeof args.itemId !== 'string' || !args.itemId) fail('MISSING_PARAM', 'itemId is required');
  if (args.at !== undefined && args.keyframeIndex !== undefined) fail('INVALID_COMBINATION', 'Specify either `at` (timeline time) OR `keyframeIndex`, not both');
  const curve = ['easing', 'inHandle', 'outHandle'].some(k => args[k] !== undefined);
  if (args.clearKeyframes === true) {
    if (curve || ['update', 'add', 'remove', 'insertAt', 'at', 'keyframeIndex'].some(k => args[k] !== undefined)) fail('INVALID_COMBINATION', '`clearKeyframes: true` is exclusive — no other ops allowed in the same call');
    return clearStage(ctx, args);
  }
  // Inputs that would otherwise be ignored are refused (Cutframe choice: nothing is skipped silently).
  if (args.keepStateAt !== undefined) fail('INVALID_COMBINATION', 'keepStateAt applies only with clearKeyframes: true.');
  if (args.insertAt !== undefined && args.add === undefined) fail('INVALID_COMBINATION', 'insertAt applies only with add.');
  if (args.update === undefined && args.add === undefined && args.remove === undefined && !curve) fail('NO_UPDATES_PROVIDED', 'No updates provided', { message: NO_UPDATES });
  const ops: Op[] = [];
  if (args.update !== undefined || curve) ops.push(updateStage(ctx, args, curve));
  if (args.add !== undefined) ops.push(addStage(ctx, args));
  if (args.remove !== undefined) ops.push(removeStage(ctx, args));
  return { success: true, message: `writeShapePoints on shape '${args.itemId}': ${ops.map(o => o.count === undefined ? o.op : `${o.op}(${o.count})`).join(' + ')}`, ops };
};

// ---- UI edits (Shapes panel, pen tool, inspector), each inside the caller's bus command.
/** Shapes panel Draw / pen / polygon: a canvas-px path placed at the playhead's frame for 5 s on a free overlay track. */
export function drawShape(doc: ProjectDocument, o: { shapeType: string; path: ShapePath; playheadMs: number; style: Record<string, unknown> }): RecordData {
  const from = startFrameMs(doc, o.playheadMs), record = shapeFromPath({ shapeType: o.shapeType, path: o.path, trackId: '', display: { from, to: from + SHAPE_MS }, style: o.style });
  record.trackId = shapeTrack(doc, record.display);
  doc.items.push(record);
  return record;
}
function uiShape(doc: ProjectDocument, id: string): RecordData {
  const i = item(doc, id);
  if (!i || i.type !== 'shape') fail('SHAPE_NOT_FOUND', 'Shape not found', { message: `Shape '${id}' not found on timeline.` });
  if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
  return i;
}
const localAt = (i: RecordData, playheadMs: number) => Math.min(Math.max(playheadMs, i.display.from), i.display.to) - i.display.from;
/** Pen edit of the selected shape (points item-local): a keyframed path edits the path keyframe at the playhead (made there
 *  when none is within a frame); a static path is rewritten and refitted. */
export function editShapePath(doc: ProjectDocument, id: string, points: PathPoint[], playheadMs: number) {
  const i = uiShape(doc, id);
  if (pathKeyframes(i.details).length) {
    const { list, kf } = keyframeAt(doc, i, i.display.from + localAt(i, playheadMs));
    if (!setKeyframePath(i, list, kf, points)) noBounds(id);
  } else if (!setBasePath(doc, i, { points, closed: basePath(i.details).closed }, localAt(i, playheadMs))) noBounds(id);
}
/** Pen delete of one anchor: refused on a keyframed path and below the minimum. */
export function removeShapePoint(doc: ProjectDocument, id: string, index: number, playheadMs: number) {
  const i = uiShape(doc, id), kfs = pathKeyframes(i.details), path = basePath(i.details);
  if (kfs.length) fail('KEYFRAMED_SHAPE_NO_REMOVE', 'Cannot remove points from keyframed shape', { message: keyframed(id, kfs.length, 'removing') });
  checkRemoval(path, new Set([index]));
  if (!setBasePath(doc, i, { points: path.points.filter((_, k) => k !== index), closed: path.closed }, localAt(i, playheadMs))) noBounds(id);
}
/** Inspector "Add path keyframe": the path drawn at the playhead, kept as a path keyframe there (none added within a frame
 *  of an existing one). */
export function addPathKeyframe(doc: ProjectDocument, id: string, playheadMs: number) {
  const i = uiShape(doc, id), { list } = keyframeAt(doc, i, i.display.from + localAt(i, playheadMs));
  writePathKeyframes(i, list);
}

// ---- viewItemDetails include=general for shape items (results §2 viewItemDetails; T18 owns `general` for every other type).
/** Cutframe wording: the include values that add to a shape's details. */
export const MORE_DATA = 'More data: include "keyframes", "masks" or "effects".';
export function shapeDetails(doc: ProjectDocument, i: RecordData): RecordData {
  const v = (k: string) => staticValue(i, k), scale = Number(v('scale')), x = Number(v('positionX')), y = Number(v('positionY')), props: RecordData = {};
  if (x !== 0 || y !== 0) props.position = { x, y };
  if (v('width') || v('height')) props.size = { width: Number(v('width')) * scale, height: Number(v('height')) * scale };
  if (scale !== 1) props.scale = scale;
  if (v('opacity') !== 1) props.opacity = v('opacity');
  if (v('rotation') !== 0) props.rotate = v('rotation');
  if (v('flipX')) props.flipX = true;
  if (v('flipY')) props.flipY = true;
  for (const k of STYLE_KEYS) if (v(k) !== SHAPE_STYLE[k]) props[k] = v(k);
  // The points as writeShapePoints takes them: canvas px at the clip's start.
  const path = pathAt(i.details, toPropertyTime(i, i.display.from)), m = boxMatrix(itemBox(doc, i, 0));
  return {
    source: {}, moreDataAvailable: MORE_DATA,
    timelineMetadata: { metadata: i.metadata ?? {}, isMain: false, playbackRate: rateOf(i), display: { from: s3(i.display.from), to: s3(i.display.to) }, originalDuration: s3(span(i)) },
    properties: props, fullDetails: { points: shifted(mapPoints(m, path.points), 0, 0), closed: path.closed },
  };
}
