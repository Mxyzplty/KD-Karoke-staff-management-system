// SPDX-License-Identifier: AGPL-3.0-only
// T06 error ledger: one row per code the shape tools own, the WHOLE response compared with toStrictEqual, and a refusal leaves the document,
// the undo stack and the journal untouched. Oracle: error codes §2 (the T06 rows l.211–255) and §3/§4 for the placement codes; contracts
// addShape / writeShapePoints; results §2 writeMaskPoints (the shape tool mirrors it). Wording that no spec gives (error titles for the
// rows the table quotes as message only, Cutframe-own checks) is asserted as implemented and marked "own" in the row label (and in the ledger
// table of the report): "own" = the wording or the condition is ours; "own title" = the message is the spec's, the title is ours; "own use" =
// the spec's code and wording on a call the spec does not list for that code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from '../apps/helper/src/schemas';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { viewItemDetails } from '../apps/web/src/analysis/details';
import type { DetailsContext } from '../apps/web/src/analysis/details';
import { build, mkItem, mkTrack, resetIds, video } from './t03-fixtures';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T08:00:00.000Z')); });
afterEach(() => { resetIds(); vi.useRealTimers(); });

const json = (d: unknown) => JSON.stringify(d);
const base = (): ProjectDocument => build({
  tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay'), mkTrack('OL', 'overlay')],
  items: [video('v1', 'V1', 0, 4000), mkItem('a1', 'A1', 0, 3000, { type: 'audio', trim: { from: 0, to: 3000 }, sourceDuration: 8000, metadata: { assetId: 'asset-aud1' } }),
    mkItem('orphan', 'gone', 0, 1000, { type: 'shape' })],
});
const RECT = { shape: 'rectangle', bounds: { x: 100, y: 100, width: 200, height: 100 }, duration: 5 };
type World = ReturnType<typeof world>;
/** sa: a static rectangle on O1 (0–5 s); sk: a rectangle on O2 with one path keyframe; sl: a rectangle on OL, which is then locked; sz: a rectangle on O2 (6–11 s) whose scale is then set to 0;
 *  se: a rectangle on O2 (12–17 s) whose stored base path is then emptied (only a loaded document can hold that: no tool or UI op makes it). */
function world() {
  const seed = createEditor(base()), id = (r: any): string => { expect(r.success, json(r)).toBe(true); return r.data.itemId; };
  const sa = id(seed.call('addShape', { ...RECT, trackId: 'O1', timelineStart: 0 }));
  const sk = id(seed.call('addShape', { ...RECT, trackId: 'O2', timelineStart: 0 }));
  expect(seed.call('writeShapePoints', { itemId: sk, at: 1, update: [{ pointIndex: 0, anchor: { x: 90 } }] })).toMatchObject({ success: true });
  const sl = id(seed.call('addShape', { ...RECT, trackId: 'OL', timelineStart: 0 }));
  const sz = id(seed.call('addShape', { ...RECT, trackId: 'O2', timelineStart: 6 }));
  const se = id(seed.call('addShape', { ...RECT, trackId: 'O2', timelineStart: 12 }));
  const doc = structuredClone(seed.doc); doc.tracks.find(t => t.id === 'OL')!.locked = true;
  (doc.items.find(i => i.id === sz) as any).properties.scale.defaultValue = 0;
  (doc.items.find(i => i.id === se) as any).details.points = [];
  return { e: createEditor(doc), sa, sk, sl, sz, se };
}
const r1 = (code: string, error: string, message: string) => ({ success: false, code, error, message });
const r2 = (code: string, error: string) => ({ success: false, code, error });
const POINT = (n: number, part = 'anchor') => `Point ${n}'s ${part} needs finite canvas x and y numbers. An update may give one axis; a new point gives both.`;
const HANDLE = (n: number, part: string) => `Point ${n}'s ${part} needs finite x and y numbers (an offset from its anchor), or null to remove it. A new handle gives both axes.`;
const SHAPES = 'rectangle, ellipse, triangle, pentagon, star, heart';
/** The 15 easing names, written from the T04 list (the order of the message's "Options:" is a provisional choice, error codes l.162). */
const EASING_NAMES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeInQuad', 'easeOutQuad', 'easeInOutQuad', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic', 'easeInBack', 'easeOutBack', 'easeInOutBack', 'easeOutElastic', 'easeOutBounce'];

type Row = [label: string, tool: string, args: (w: World) => Record<string, unknown>, expected: (w: World) => Record<string, unknown>];
const ROWS: Row[] = [
  // ---- lookup
  ['SHAPE_NOT_FOUND (own message)', 'writeShapePoints', () => ({ itemId: 'nope', remove: [0] }), () => r1('SHAPE_NOT_FOUND', 'Shape not found', "Shape 'nope' not found on timeline.")],
  ['NOT_A_SHAPE (own title)', 'writeShapePoints', () => ({ itemId: 'v1', remove: [0] }), () => r1('NOT_A_SHAPE', 'Not a shape', 'Item "v1" is not a shape (type: video).')],
  ['MISSING_PARAM (own: itemId)', 'writeShapePoints', () => ({ remove: [0] }), () => r2('MISSING_PARAM', 'itemId is required')],
  // ---- addShape: what to draw
  ['NO_SHAPE_SPECIFIED (own title)', 'addShape', () => ({ trackId: 'O1' }), () => r1('NO_SHAPE_SPECIFIED', 'No shape specified', "Must provide either 'shape' (preset) or 'points' (custom bezier path).")],
  ['INVALID_SHAPE_TYPE (handler; own title)', 'addShape', () => ({ shape: 'hexagon', bounds: RECT.bounds, trackId: 'O1' }),
    () => r1('INVALID_SHAPE_TYPE', 'Invalid shape type', `Shape 'hexagon' is not valid. Use: ${SHAPES}.`)],
  ['NO_SHAPE_POINTS (empty points; own title)', 'addShape', () => ({ points: [], trackId: 'O1' }), () => r1('NO_SHAPE_POINTS', 'No shape points', 'Custom shapes require at least one valid bezier point.')],
  ['NO_SHAPE_POINTS (no valid point, Q16; own title)', 'addShape', () => ({ points: [{ anchor: { x: 1 } }, {}], trackId: 'O1' }), () => r1('NO_SHAPE_POINTS', 'No shape points', 'Custom shapes require at least one valid bezier point.')],
  ['INVALID_POINT (addShape: first point error, Q16; own title)', 'addShape', () => ({ points: [{ anchor: { x: 1, y: 2 } }, { anchor: { x: 3 } }], trackId: 'O1' }),
    () => r1('INVALID_POINT', 'Invalid point', 'Point at index 1 must have an anchor with x and y coordinates.')],
  ['INVALID_POINT_COORDINATES (addShape anchor; own message)', 'addShape', () => ({ points: [{ anchor: { x: 1, y: 2 } }, { anchor: { x: 'a', y: 3 } }], trackId: 'O1' }),
    () => r1('INVALID_POINT_COORDINATES', 'Invalid point coordinates', POINT(1))],
  ['INVALID_POINT_COORDINATES (addShape handleOut; own message)', 'addShape', () => ({ points: [{ anchor: { x: 1, y: 2 } }, { anchor: { x: 5, y: 6 }, handleOut: { x: 1 } }], trackId: 'O1' }),
    () => r1('INVALID_POINT_COORDINATES', 'Invalid point coordinates', HANDLE(1, 'handleOut'))],
  ['NO_SHAPE_PATH_BOUNDS (addShape: zero area, Q17; own use)', 'addShape', () => ({ points: [{ anchor: { x: 5, y: 5 } }, { anchor: { x: 50, y: 5 } }, { anchor: { x: 90, y: 5 } }], trackId: 'O1' }),
    () => r1('NO_SHAPE_PATH_BOUNDS', 'No shape path bounds', 'The custom path has no visible bounds: its points span no width or no height.')],
  ['INVALID_BOUNDS (width 0; own, Q1)', 'addShape', () => ({ shape: 'ellipse', bounds: { width: 0, height: 40 }, trackId: 'O1' }),
    () => r1('INVALID_BOUNDS', 'Invalid bounds', 'bounds requires a positive width and height and finite x/y or cx/cy coordinates.')],
  ['INVALID_BOUNDS (x not finite; own, Q1)', 'addShape', () => ({ shape: 'ellipse', bounds: { width: 20, height: 40, x: 'left' }, trackId: 'O1' }),
    () => r1('INVALID_BOUNDS', 'Invalid bounds', 'bounds requires a positive width and height and finite x/y or cx/cy coordinates.')],
  ['INVALID_BOUNDS (no bounds with shape; own, Q1)', 'addShape', () => ({ shape: 'ellipse', trackId: 'O1' }),
    () => r1('INVALID_BOUNDS', 'Invalid bounds', 'bounds requires a positive width and height and finite x/y or cx/cy coordinates.')],
  ['INVALID_PROPERTY_VALUE (roundness 101; own)', 'addShape', () => ({ ...RECT, roundness: 101, trackId: 'O1' }), () => r2('INVALID_PROPERTY_VALUE', 'roundness must be from 0 to 100')],
  ['INVALID_PROPERTY_VALUE (fillOpacity 2; own use)', 'addShape', () => ({ ...RECT, fillOpacity: 2, trackId: 'O1' }), () => r2('INVALID_PROPERTY_VALUE', 'fillOpacity must be at most 1')],
  // ---- addShape: exclusivity
  ['INVALID_COMBINATION (insertAfter + trackId)', 'addShape', w => ({ ...RECT, insertAfterItemId: w.sa, trackId: 'O1' }),
    () => r2('INVALID_COMBINATION', 'insertAfter cannot be used with trackId. Use insertAfterItemId alone, or trackId with timelineStart.')],
  ['INVALID_COMBINATION (insertAfter + trackId + timelineStart)', 'addShape', w => ({ ...RECT, insertAfterItemId: w.sa, trackId: 'O1', timelineStart: 6 }),
    () => r2('INVALID_COMBINATION', 'insertAfter cannot be used with trackId, timelineStart. Use insertAfterItemId alone, or trackId with timelineStart.')],
  ['INVALID_COMBINATION (shape + points; Q14)', 'addShape', () => ({ ...RECT, points: [{ anchor: { x: 1, y: 2 } }], trackId: 'O1' }),
    () => r2('INVALID_COMBINATION', 'Provide either shape (a preset with bounds) or points (a custom path), not both.')],
  ['INVALID_COMBINATION (points + bounds)', 'addShape', () => ({ points: [{ anchor: { x: 1, y: 2 } }], bounds: RECT.bounds, trackId: 'O1' }),
    () => r2('INVALID_COMBINATION', 'bounds applies to shape presets only; a points path is placed by its own canvas coordinates.')],
  ['INVALID_COMBINATION (points + bounds + roundness)', 'addShape', () => ({ points: [{ anchor: { x: 1, y: 2 } }], bounds: RECT.bounds, roundness: 10, trackId: 'O1' }),
    () => r2('INVALID_COMBINATION', 'bounds and roundness apply to shape presets only; a points path is placed by its own canvas coordinates.')],
  // ---- addShape: placement
  ['INSERT_AFTER_NOT_FOUND', 'addShape', () => ({ ...RECT, insertAfterItemId: 'nope' }),
    () => r1('INSERT_AFTER_NOT_FOUND', 'insertAfter item not found', "Item 'nope' not found on the timeline. Read context for current item ids.")],
  ['INSERT_AFTER_NO_TRACK', 'addShape', () => ({ ...RECT, insertAfterItemId: 'orphan' }), () => r2('INSERT_AFTER_NO_TRACK', 'insertAfter item not on any track')],
  ['INSERT_AFTER_TYPE_MISMATCH', 'addShape', () => ({ ...RECT, insertAfterItemId: 'a1' }),
    () => r1('INSERT_AFTER_TYPE_MISMATCH', 'insertAfter type mismatch', "Cannot insert shape after audio item 'a1'. The new item requires a compatible track kind.")],
  ['MISSING_TRACK_ID', 'addShape', () => ({ ...RECT }), () => r2('MISSING_TRACK_ID', 'trackId is required')],
  ['INVALID_TRACK (missing)', 'addShape', () => ({ ...RECT, trackId: 'nope' }), () => r2('INVALID_TRACK', "Overlay track 'nope' not found")],
  ['INVALID_TRACK (wrong kind)', 'addShape', () => ({ ...RECT, trackId: 'V1' }), () => r2('INVALID_TRACK', "Overlay track 'V1' not found")],
  ['TRACK_LOCKED (addShape)', 'addShape', () => ({ ...RECT, trackId: 'OL' }), () => r2('TRACK_LOCKED', "Track 'OL' is locked")],
  ['INVALID_TIMELINE_START (own use)', 'addShape', () => ({ ...RECT, trackId: 'O1', timelineStart: -1 }), () => r2('INVALID_TIMELINE_START', 'timelineStart must be >= 0. Received: -1s.')],
  ['INVALID_DURATION (0; own use)', 'addShape', () => ({ ...RECT, trackId: 'O1', timelineStart: 6, duration: 0 }), () => r2('INVALID_DURATION', 'duration must be positive. Received: 0s.')],
  ['INVALID_DURATION (negative; own use)', 'addShape', () => ({ ...RECT, trackId: 'O1', timelineStart: 6, duration: -2 }), () => r2('INVALID_DURATION', 'duration must be positive. Received: -2s.')],
  ['TRACK_OVERLAP', 'addShape', w => ({ ...RECT, trackId: 'O1', timelineStart: 1 }),
    w => r2('TRACK_OVERLAP', `Requested range overlaps item '${w.sa}' (0s–5s) on track 'O1'. That track has room for this length from 5s.`)],
  // ---- writeShapePoints: update / curve
  ['NO_UPDATES_PROVIDED (nothing at all)', 'writeShapePoints', w => ({ itemId: w.sa }),
    () => r1('NO_UPDATES_PROVIDED', 'No updates provided', 'Provide at least one point update, or target a path keyframe to edit its easing/handles.')],
  ['NO_UPDATES_PROVIDED (update: [])', 'writeShapePoints', w => ({ itemId: w.sa, update: [] }),
    () => r1('NO_UPDATES_PROVIDED', 'No updates provided', 'Provide at least one point update, or target a path keyframe to edit its easing/handles.')],
  ['INVALID_POINT_INDEX (past the end)', 'writeShapePoints', w => ({ itemId: w.sa, update: [{ pointIndex: 4, anchor: { x: 1 } }] }),
    () => r1('INVALID_POINT_INDEX', 'Invalid point index', 'Point index 4 is out of range. Valid indices: 0-3')],
  ['INVALID_POINT_INDEX (negative)', 'writeShapePoints', w => ({ itemId: w.sa, update: [{ pointIndex: -1, anchor: { x: 1 } }] }),
    () => r1('INVALID_POINT_INDEX', 'Invalid point index', 'Point index -1 is out of range. Valid indices: 0-3')],
  ['INVALID_POINT_COORDINATES (update anchor; own message)', 'writeShapePoints', w => ({ itemId: w.sa, update: [{ pointIndex: 2, anchor: { x: 'a' } }] }),
    () => r1('INVALID_POINT_COORDINATES', 'Invalid point coordinates', POINT(2))],
  ['INVALID_POINT_COORDINATES (update new handleIn, one axis; own message)', 'writeShapePoints', w => ({ itemId: w.sa, update: [{ pointIndex: 1, handleIn: { x: 5 } }] }),
    () => r1('INVALID_POINT_COORDINATES', 'Invalid point coordinates', HANDLE(1, 'handleIn'))],
  ['INVALID_POINT_COORDINATES (first bad point stops the call; own message)', 'writeShapePoints', w => ({ itemId: w.sa, update: [{ pointIndex: 0, anchor: { x: 1 } }, { pointIndex: 3, anchor: { y: null } }, { pointIndex: 1, anchor: { x: 'z' } }] }),
    () => r1('INVALID_POINT_COORDINATES', 'Invalid point coordinates', POINT(3))],
  ['INVALID_POINT_COORDINATES (update with nothing to change; own message and condition)', 'writeShapePoints', w => ({ itemId: w.sa, update: [{ pointIndex: 0 }] }),
    () => r1('INVALID_POINT_COORDINATES', 'Invalid point coordinates', 'Point 0 gives no anchor, handleIn or handleOut to change.')],
  ['CURVE_REQUIRES_KEYFRAME', 'writeShapePoints', w => ({ itemId: w.sa, easing: 'linear' }),
    () => r1('CURVE_REQUIRES_KEYFRAME', 'Curve requires keyframe', 'Easing/handles can only target an existing keyframe after path keyframes exist.')],
  ['INVALID_KEYFRAME_INDEX (no keyframes; own variant)', 'writeShapePoints', w => ({ itemId: w.sa, keyframeIndex: 0, update: [{ pointIndex: 0, anchor: { x: 1 } }] }),
    () => r1('INVALID_KEYFRAME_INDEX', 'Invalid keyframe index', 'Keyframe index 0 is out of range. The shape has no path keyframes.')],
  ['INVALID_KEYFRAME_INDEX (past the end)', 'writeShapePoints', w => ({ itemId: w.sk, keyframeIndex: 3, update: [{ pointIndex: 0, anchor: { x: 1 } }] }),
    () => r1('INVALID_KEYFRAME_INDEX', 'Invalid keyframe index', 'Keyframe index 3 is out of range. Valid indices: 0-0')],
  ['INVALID_EASING (keyframed path; Options list order is provisional)', 'writeShapePoints', w => ({ itemId: w.sk, keyframeIndex: 0, easing: 'wobble' }),
    () => r1('INVALID_EASING', 'Invalid easing', `[writeShapePoints] easing 'wobble' not valid. Options: ${EASING_NAMES.join(', ')}`)],
  ['INVALID_BEZIER_HANDLE (inHandle x out of 0..1)', 'writeShapePoints', w => ({ itemId: w.sk, keyframeIndex: 0, inHandle: [2, 0] }),
    () => r1('INVALID_BEZIER_HANDLE', 'Invalid bezier handle', '[writeShapePoints] inHandle must be [x, y] with x from 0 to 1 and y from -100 to 100.')],
  ['TIME_TARGET_REQUIRED (own message)', 'writeShapePoints', w => ({ itemId: w.sk, update: [{ pointIndex: 0, anchor: { x: 1 } }] }),
    w => r1('TIME_TARGET_REQUIRED', 'Time target required', `Shape "${w.sk}" has 1 path keyframe(s). Pass keyframeIndex, or at (timeline seconds), to choose the path to edit.`)],
  ['TIME_OUT_OF_RANGE', 'writeShapePoints', w => ({ itemId: w.sa, at: 9, update: [{ pointIndex: 0, anchor: { x: 1 } }] }),
    () => r1('TIME_OUT_OF_RANGE', 'Time out of range', 'Timeline time 9s is outside item bounds (0s - 5s).')],
  ['NO_SHAPE_PATH_BOUNDS (update collapses the path)', 'writeShapePoints', w => ({ itemId: w.sa, update: [{ pointIndex: 0, anchor: { x: 300, y: 100 } }, { pointIndex: 3, anchor: { x: 300, y: 200 } }] }),
    w => r1('NO_SHAPE_PATH_BOUNDS', 'No shape path bounds', `Shape "${w.sa}" could not be fitted to its edited path.`)],
  // ---- writeShapePoints: add
  ['NO_POINTS_PROVIDED (own title)', 'writeShapePoints', w => ({ itemId: w.sa, add: [] }),
    () => r1('NO_POINTS_PROVIDED', 'No points provided', 'Provide at least one new point with an anchor position.')],
  ['INVALID_POINT (add; own title)', 'writeShapePoints', w => ({ itemId: w.sa, add: [{ anchor: { x: 1, y: 2 } }, { anchor: { y: 3 } }] }),
    () => r1('INVALID_POINT', 'Invalid point', 'Point at index 1 must have an anchor with x and y coordinates.')],
  ['INVALID_POINT_COORDINATES (add anchor; own message)', 'writeShapePoints', w => ({ itemId: w.sa, add: [{ anchor: { x: 1, y: Infinity } }] }),
    () => r1('INVALID_POINT_COORDINATES', 'Invalid point coordinates', POINT(0))],
  ['INVALID_INSERT_INDEX', 'writeShapePoints', w => ({ itemId: w.sa, add: [{ anchor: { x: 1, y: 2 } }], insertAt: 5 }),
    () => r1('INVALID_INSERT_INDEX', 'Invalid insert index', 'Insert index 5 is out of range. Valid range: 0-4')],
  ['KEYFRAMED_SHAPE_NO_ADD (own message)', 'writeShapePoints', w => ({ itemId: w.sk, add: [{ anchor: { x: 1, y: 2 } }] }),
    w => r1('KEYFRAMED_SHAPE_NO_ADD', 'Cannot add points to keyframed shape',
      `Shape "${w.sk}" has 1 path keyframe(s); adding points needs a static path. Clear them first with clearKeyframes: true (keepStateAt keeps one time's shape).`)],
  // ---- writeShapePoints: remove
  ['NO_INDICES_PROVIDED', 'writeShapePoints', w => ({ itemId: w.sa, remove: [] }), () => r1('NO_INDICES_PROVIDED', 'No indices provided', 'Provide at least one point index to remove.')],
  ['INVALID_POINT_INDICES', 'writeShapePoints', w => ({ itemId: w.sa, remove: [1, 9, 12] }),
    () => r1('INVALID_POINT_INDICES', 'Invalid point indices', 'Point indices 9, 12 are out of range. Valid indices: 0-3')],
  ['MINIMUM_POINTS_REQUIRED (own message, adapted from the mask row)', 'writeShapePoints', w => ({ itemId: w.sa, remove: [0, 1] }),
    () => r1('MINIMUM_POINTS_REQUIRED', 'Cannot remove points', 'Removing 2 point(s) would leave 2 point(s). Minimum 3 points required.')],
  ['KEYFRAMED_SHAPE_NO_REMOVE (own message)', 'writeShapePoints', w => ({ itemId: w.sk, remove: [0] }),
    w => r1('KEYFRAMED_SHAPE_NO_REMOVE', 'Cannot remove points from keyframed shape',
      `Shape "${w.sk}" has 1 path keyframe(s); removing points needs a static path. Clear them first with clearKeyframes: true (keepStateAt keeps one time's shape).`)],
  // ---- writeShapePoints on a stored shape whose base path is empty (a loaded document; no tool or UI op produces one)
  ['NO_SHAPE_POINTS (writeShapePoints update, stored empty path; own title)', 'writeShapePoints', w => ({ itemId: w.se, update: [{ pointIndex: 0, anchor: { x: 1 } }] }),
    () => r1('NO_SHAPE_POINTS', 'No shape points', 'Custom shapes require at least one valid bezier point.')],
  ['NO_SHAPE_POINTS (writeShapePoints remove [0], stored empty path; own title)', 'writeShapePoints', w => ({ itemId: w.se, remove: [0] }),
    () => r1('NO_SHAPE_POINTS', 'No shape points', 'Custom shapes require at least one valid bezier point.')],
  // ---- writeShapePoints: combinations the handler refuses (own wording)
  ['INVALID_COMBINATION (at + keyframeIndex)', 'writeShapePoints', w => ({ itemId: w.sk, at: 1, keyframeIndex: 0, update: [{ pointIndex: 0, anchor: { x: 1 } }] }),
    () => r2('INVALID_COMBINATION', 'Specify either `at` (timeline time) OR `keyframeIndex`, not both')],
  ['INVALID_COMBINATION (clearKeyframes + add)', 'writeShapePoints', w => ({ itemId: w.sk, clearKeyframes: true, add: [{ anchor: { x: 1, y: 2 } }] }),
    () => r2('INVALID_COMBINATION', '`clearKeyframes: true` is exclusive — no other ops allowed in the same call')],
  ['INVALID_COMBINATION (clearKeyframes + easing)', 'writeShapePoints', w => ({ itemId: w.sk, clearKeyframes: true, easing: 'linear' }),
    () => r2('INVALID_COMBINATION', '`clearKeyframes: true` is exclusive — no other ops allowed in the same call')],
  ['INVALID_COMBINATION (keepStateAt alone)', 'writeShapePoints', w => ({ itemId: w.sk, keepStateAt: 1 }), () => r2('INVALID_COMBINATION', 'keepStateAt applies only with clearKeyframes: true.')],
  ['INVALID_COMBINATION (insertAt without add)', 'writeShapePoints', w => ({ itemId: w.sa, insertAt: 1, remove: [0] }), () => r2('INVALID_COMBINATION', 'insertAt applies only with add.')],
  // ---- writeShapePoints on a locked track: the real trigger of the four *_FAILED codes
  ['SHAPE_POINT_UPDATE_FAILED (locked track)', 'writeShapePoints', w => ({ itemId: w.sl, update: [{ pointIndex: 0, anchor: { x: 1 } }] }),
    w => r1('SHAPE_POINT_UPDATE_FAILED', 'Failed to update shape points', `Failed to update shape "${w.sl}" points: Track OL is locked`)],
  ['SHAPE_POINT_ADD_FAILED (locked track)', 'writeShapePoints', w => ({ itemId: w.sl, add: [{ anchor: { x: 1, y: 2 } }] }),
    w => r1('SHAPE_POINT_ADD_FAILED', 'Failed to add shape points', `Failed to add points to shape "${w.sl}": Track OL is locked`)],
  ['SHAPE_POINT_REMOVE_FAILED (locked track)', 'writeShapePoints', w => ({ itemId: w.sl, remove: [0] }),
    w => r1('SHAPE_POINT_REMOVE_FAILED', 'Failed to remove shape points', `Failed to remove points from shape "${w.sl}": Track OL is locked`)],
  ['SHAPE_POINT_UPDATE_FAILED (scale 0)', 'writeShapePoints', w => ({ itemId: w.sz, update: [{ pointIndex: 0, anchor: { x: 1 } }] }),
    w => r1('SHAPE_POINT_UPDATE_FAILED', 'Failed to update shape points', `Failed to update shape "${w.sz}" points: the shape has no visible size at that time (scale 0)`)],
  ['SHAPE_POINT_ADD_FAILED (scale 0)', 'writeShapePoints', w => ({ itemId: w.sz, add: [{ anchor: { x: 1, y: 2 } }] }),
    w => r1('SHAPE_POINT_ADD_FAILED', 'Failed to add shape points', `Failed to add points to shape "${w.sz}": the shape has no visible size at that time (scale 0)`)],
  ['CLEAR_SHAPE_PATH_KEYFRAMES_FAILED (locked track)', 'writeShapePoints', w => ({ itemId: w.sl, clearKeyframes: true }),
    w => r1('CLEAR_SHAPE_PATH_KEYFRAMES_FAILED', 'Failed to clear path keyframes', `Failed to clear path keyframes from shape "${w.sl}": Track OL is locked`)],
];

describe('T06 error ledger: agent tools, the whole response (error codes §2 l.211–255, §3/§4 placement rows)', () => {
  it.each(ROWS)('%s via %s', (_label, tool, args, expected) => {
    const w = world(), { e } = w, before = json(e.doc), n = e.bus.undoStack.length, j = e.journal.length;
    expect(e.call(tool, args(w))).toStrictEqual(expected(w));
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n); expect(e.journal).toHaveLength(j);
  });
});

describe('T06 error ledger: INVALID_TOOL_INPUT at the helper schema, and what the schema leaves to the handler', () => {
  it('shape "polygon" / "hexagon" are INVALID_TOOL_INPUT before the tab sees the call (W3-ED-08, ticket fixture 5)', () => {
    for (const shape of ['polygon', 'hexagon']) {
      const v = validate('addShape', { shape, bounds: { width: 100, height: 100 }, trackId: 'O1' }) as any;
      expect(v, shape).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for addShape', details: { errors: [{ path: '$.shape', code: 'ENUM' }] } });
    }
  });
  it('the schema also refuses shape + points and at + keyframeIndex (exclusive); the handler keeps its own INVALID_COMBINATION for a caller that skips the schema', () => {
    expect(validate('addShape', { shape: 'star', points: [], bounds: { width: 1, height: 1 }, trackId: 'O1' })).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
    expect(validate('writeShapePoints', { itemId: 'x', at: 1, keyframeIndex: 0 })).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
    expect(validate('writeShapePoints', {})).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
  });
  it('the schema refuses an unknown easing (INVALID_TOOL_INPUT) but passes a handle outside 0..1 on to the handler (INVALID_BEZIER_HANDLE); the INVALID_EASING row is for a caller that skips the schema', () => {
    expect(validate('writeShapePoints', { itemId: 'x', keyframeIndex: 0, easing: 'wobble' })).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT' });
    expect(validate('writeShapePoints', { itemId: 'x', keyframeIndex: 0, inHandle: [2, 0] })).toBeNull();   // the schema checks only that a handle is 2 numbers; the 0..1 / ±100 range is the handler's
  });
  it('a refusal at the schema creates nothing in the document (the handler is not reached)', () => {
    const e = createEditor(base()), before = json(e.doc);
    expect(validate('addShape', { shape: 'polygon', bounds: { width: 10, height: 10 }, trackId: 'O1' })).not.toBeNull();
    expect(json(e.doc)).toBe(before);
  });
});

describe('T06 error ledger: viewItemDetails include=general is served for shape items only; any other target is NOT_IMPLEMENTED (owner T18)', () => {
  const ctx = (doc: ProjectDocument) => ({ doc, asset: () => undefined, agentId: () => undefined, store: { row: async () => undefined, putRow: async () => {}, media: {} }, service: { rhythm: async () => undefined } }) as unknown as DetailsContext;
  it('a non-shape target (and a mixed batch) is refused whole with the owner; a shape alone is served', async () => {
    const { e, sa } = world(), doc = e.doc;
    const refusal = {
      success: false, code: 'NOT_IMPLEMENTED', owner: 'T18', error: 'viewItemDetails include "general" is not implemented yet',
      message: 'This version serves include "transcript", "keyframes" and "beats"; "general" arrives with T18. Pass include with those values only.',
    };
    expect(await viewItemDetails(ctx(doc), { itemId: 'v1' })).toStrictEqual(refusal);
    expect(await viewItemDetails(ctx(doc), { itemId: 'v1', include: ['general'] })).toStrictEqual(refusal);
    expect(await viewItemDetails(ctx(doc), { itemIds: [sa, 'v1'] })).toStrictEqual(refusal);
    expect(await viewItemDetails(ctx(doc), { itemId: sa })).toMatchObject({ success: true });
  });
});

describe('T06 error ledger: writeShapePoints remove that collapses the path', () => {
  it('removing the one off-line point of a 4-point path leaves 3 collinear points: NO_SHAPE_PATH_BOUNDS (whole response), nothing written', () => {
    const e = createEditor(base()), made: any = e.call('addShape', { points: [{ anchor: { x: 0, y: 0 } }, { anchor: { x: 50, y: 0 } }, { anchor: { x: 100, y: 0 } }, { anchor: { x: 0, y: 100 } }], trackId: 'O1', timelineStart: 0, duration: 5 });
    expect(made.success, json(made)).toBe(true);
    const before = json(e.doc), n = e.bus.undoStack.length, j = e.journal.length;
    expect(e.call('writeShapePoints', { itemId: made.data.itemId, remove: [3] }))
      .toStrictEqual(r1('NO_SHAPE_PATH_BOUNDS', 'No shape path bounds', `Shape "${made.data.itemId}" could not be fitted to its edited path.`));
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n); expect(e.journal).toHaveLength(j);
  });
});

describe('T06 error ledger: the UI ops (intent path) refuse with the same codes and write nothing', () => {
  const refused = (code: string) => ({ ok: false, code });
  it('a point delete below the minimum, on a keyframed path, on a missing shape and on a locked track', () => {
    const { e, sa, sk, sl } = world(), before = json(e.doc), n = e.bus.undoStack.length;
    expect(e.intent({ type: 'removeShapePoint', itemId: 'nope', index: 0, playheadMs: 0 })).toMatchObject(refused('SHAPE_NOT_FOUND'));
    expect(e.intent({ type: 'removeShapePoint', itemId: sk, index: 0, playheadMs: 0 })).toMatchObject(refused('KEYFRAMED_SHAPE_NO_REMOVE'));
    expect(e.intent({ type: 'removeShapePoint', itemId: sl, index: 0, playheadMs: 0 })).toMatchObject(refused('TRACK_LOCKED'));
    expect(e.intent({ type: 'editShapePath', itemId: sl, points: [], playheadMs: 0 })).toMatchObject(refused('TRACK_LOCKED'));
    expect(e.intent({ type: 'addPathKeyframe', itemId: sl, playheadMs: 0 })).toMatchObject(refused('TRACK_LOCKED'));
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n);
    // The last allowed delete leaves 3; the next one is refused.
    expect(e.intent({ type: 'removeShapePoint', itemId: sa, index: 0, playheadMs: 0 })).toMatchObject({ ok: true });
    const after = json(e.doc);
    expect(e.intent({ type: 'removeShapePoint', itemId: sa, index: 0, playheadMs: 0 })).toMatchObject(refused('MINIMUM_POINTS_REQUIRED'));
    expect(json(e.doc)).toBe(after);
  });
  it('a drawn path with no area is NO_SHAPE_PATH_BOUNDS and creates nothing', () => {
    const { e } = world(), before = json(e.doc), n = e.bus.undoStack.length;
    const flat = { points: [{ anchor: { x: 0, y: 5 } }, { anchor: { x: 10, y: 5 } }, { anchor: { x: 20, y: 5 } }], closed: true };
    expect(e.intent({ type: 'drawShape', shapeType: 'custom', path: flat, playheadMs: 0, style: {} })).toMatchObject(refused('NO_SHAPE_PATH_BOUNDS'));
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n);
  });
});
