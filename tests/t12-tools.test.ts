// SPDX-License-Identifier: AGPL-3.0-only
// T12 agent tools (contracts createMask l.329-345, editMaskProperties l.386-394, removeMask l.625, writeKeyframes l.922-935,
// writeMaskPoints l.944-970; results gate table l.24-43, createMask l.540-576, editMaskProperties l.659-690, removeMask
// l.1015-1029, include=masks MaskView l.1340-1348, writeMaskPoints l.1526-1550; error codes §8 l.200-254). Exact codes and
// messages are the handlers' own text (apps/web/src/masks/tools.ts, keyframes.ts), which this file pins down.
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { build, mkItem, mkTrack, resetIds, video } from './t03-fixtures';
import { validate } from '../apps/helper/src/schemas';

afterEach(() => resetIds());
type Editor = ReturnType<typeof createEditor>;
const doc = (extra: Record<string, unknown> = {}) => build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')], items: [video('vid', 'V1', 0, 4000, 0, 10000, extra)] });
const editor = (extra: Record<string, unknown> = {}) => createEditor(doc(extra));
const vid = (e: Editor) => e.doc.items.find(i => i.id === 'vid')!;
const refused = (r: any, code: string) => { expect(r.success).toBe(false); expect(r.code).toBe(code); return r; };

describe('createMask (contracts l.329-345, results l.540-576, error codes §8)', () => {
  it('3 custom canvas points: success data shape, one path keyframe, "Edit items" undo entry, default name', () => {
    const e = editor();
    const r: any = e.call('createMask', { itemId: 'vid', timelineSeconds: 1, points: [{ anchor: { x: 100, y: 100 } }, { anchor: { x: 200, y: 100 } }, { anchor: { x: 150, y: 200 } }] });
    expect(r).toMatchObject({ success: true, data: { itemId: 'vid', agentId: 'vid', maskIndex: 0, maskName: 'Custom Mask', pointCount: 3, hasPathKeyframes: true, totalMasks: 1,
      properties: { feather: 0, expansion: 0, opacity: 100, inverted: false, mode: 'add' } } });
    expect(r.message).toBe("Created mask 'Custom Mask' on 'vid' with path keyframe at 1s.");
    const m = vid(e).masks[0];
    expect(m).toMatchObject({ name: 'Custom Mask', enabled: true, mode: 'add', order: 0, colorIndex: 0, source: 'shape', closed: true });
    expect(m.points).toHaveLength(3);
    expect(m.keyframes.path.keyframes).toHaveLength(1);
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0].label).toBe('Edit items');
  });
  it('shape + bounds preset: default name "Ellipse Mask", a given name overrides it', () => {
    const e = editor();
    const r: any = e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'ellipse', bounds: { width: 100, height: 80, cx: 200, cy: 200 } });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.data.maskName).toBe('Ellipse Mask');
    const r2: any = e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 }, name: 'Vignette' });
    expect(r2.data.maskName).toBe('Vignette');
  });
  it('a second mask gets order 1, colorIndex 1, and totalMasks 2', () => {
    const e = editor();
    e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } });
    const r: any = e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } });
    expect(r.data).toMatchObject({ maskIndex: 1, totalMasks: 2 });
    expect(vid(e).masks[1]).toMatchObject({ order: 1, colorIndex: 1 });
  });
  it('VISUAL_SELECTION_REQUIRED: a textPrompt is refused with the retirement message (no extra.message, so it is `error`)', () => {
    const e = editor();
    const r = refused(e.call('createMask', { itemId: 'vid', textPrompt: 'the dog' }), 'VISUAL_SELECTION_REQUIRED');
    expect(r.error).toBe('Text segmentation has been retired. Use viewMaskFrame, draw normalized strokes with previewSmartMask, then trackSmartMask.');
  });
  it('INVALID_ITEM_TYPE: masks work on video and image items only', () => {
    const e = createEditor(build({ tracks: [mkTrack('O1', 'overlay')], items: [mkItem('t1', 'O1', 0, 4000, { type: 'text', details: { text: 'Hi' } })] }));
    const r = refused(e.call('createMask', { itemId: 't1', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } }), 'INVALID_ITEM_TYPE');
    expect(r.message).toBe("Masks work on video and image items only; 't1' is text.");
  });
  it('INVALID_MASK_DEFINITION: neither shape+bounds nor >= 3 points', () => {
    const e = editor();
    const r = refused(e.call('createMask', { itemId: 'vid', timelineSeconds: 0, points: [{ anchor: { x: 1, y: 1 } }, { anchor: { x: 2, y: 2 } }] }), 'INVALID_MASK_DEFINITION');
    expect(r.message).toBe('Provide shape + bounds or at least 3 points. For smart masks, inspect a frame and draw a visual selection.');
  });
  it('MISSING_TIMELINE_SECONDS', () => {
    const e = editor();
    expect(refused(e.call('createMask', { itemId: 'vid', shape: 'rectangle', bounds: { width: 10, height: 10 } }), 'MISSING_TIMELINE_SECONDS').message).toBe('timelineSeconds sets the canvas-pixel to mask mapping and the first path keyframe.');
  });
  it('INVALID_SHAPE_TYPE', () => {
    const e = editor();
    const r = refused(e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'hexagon', bounds: { width: 10, height: 10 } }), 'INVALID_SHAPE_TYPE');
    expect(r.message).toBe("Shape 'hexagon' is not valid. Use: rectangle, ellipse, triangle, pentagon, star, heart.");
  });
  it('INVALID_MASK_DEFINITION: bounds needs a positive width and height', () => {
    const e = editor();
    expect(refused(e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 0, height: 10 } }), 'INVALID_MASK_DEFINITION').message)
      .toBe('bounds requires a positive width and height and finite x/y or cx/cy coordinates.');
  });
  it('INVALID_POINT_COORDINATES: a point missing a finite y', () => {
    const e = editor();
    const r = refused(e.call('createMask', { itemId: 'vid', timelineSeconds: 0, points: [{ anchor: { x: 1, y: 1 } }, { anchor: { x: 2 } }, { anchor: { x: 3, y: 3 } }] }), 'INVALID_POINT_COORDINATES');
    expect(r.message).toBe('Every mask point needs finite canvas x and y numbers. Handles need finite x and y offsets.');
  });
  it('TIME_OUT_OF_RANGE: timelineSeconds outside the item', () => {
    expect(refused(editor().call('createMask', { itemId: 'vid', timelineSeconds: 9, shape: 'rectangle', bounds: { width: 10, height: 10 } }), 'TIME_OUT_OF_RANGE').message).toBe('Timeline time 9s is outside item bounds (0s - 4s).');
  });
  it('feather, expansion and opacity are clamped and reported in `clamped`; defaults are not', () => {
    const e = editor();
    const r: any = e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 }, feather: 999, expansion: -999, opacity: 150 });
    expect(r.data.properties).toEqual({ feather: 50, expansion: -50, opacity: 100, inverted: false, mode: 'add' });
    expect(r.data.clamped.sort()).toEqual(['expansion', 'feather', 'opacity']);
    const r2: any = e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } });
    expect(r2.data.clamped).toBeUndefined();
  });
  it('an invalid mode is refused (INVALID_PROPERTY_VALUE); a valid one is stored', () => {
    const e = editor();
    expect(refused(e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 }, mode: 'xor' }), 'INVALID_PROPERTY_VALUE').message)
      .toBe("Mode 'xor' is not valid. Use: add, subtract, intersect, difference.");
    e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 }, mode: 'subtract' });
    expect(vid(e).masks[0].mode).toBe('subtract');
  });
});

describe('editMaskProperties (contracts l.386-394, results l.659-690)', () => {
  const withMask = () => { const e = editor(); e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } }); return e; };
  it('updates several fields: data shape, message, currentValues reflect the stored mask', () => {
    const e = withMask();
    const r: any = e.call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { name: 'Vignette', feather: 10, mode: 'subtract', inverted: true } });
    // updatedProperties follows EDITABLE's own order (name, enabled, feather, expansion, opacity, inverted, mode), not the call's.
    expect(r.message).toBe("Updated mask 0 'Vignette' on 'vid': name, feather, inverted, mode.");
    expect(r.data).toMatchObject({ itemId: 'vid', maskIndex: 0, maskName: 'Vignette', updatedProperties: ['name', 'feather', 'inverted', 'mode'],
      currentValues: { enabled: true, feather: 10, expansion: 0, opacity: 100, inverted: true, mode: 'subtract' } });
  });
  it('NO_MASKS on an item with no masks', () => {
    expect(refused(editor().call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { feather: 5 } }), 'NO_MASKS').message).toBe("No masks found on 'vid'.");
  });
  it('INVALID_MASK_INDEX', () => {
    expect(refused(withMask().call('editMaskProperties', { itemId: 'vid', maskIndex: 1, properties: { feather: 5 } }), 'INVALID_MASK_INDEX').message).toBe('Mask index 1 is out of range. Valid indices: 0-0');
  });
  it('NO_UPDATES: an empty / all-unknown properties object', () => {
    expect(refused(withMask().call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: {} }), 'NO_UPDATES').message).toBe('Provide at least one of: name, enabled, feather, expansion, opacity, inverted, mode.');
  });
  it('a non-string name, a non-boolean inverted and a bad mode are each INVALID_PROPERTY_VALUE (no extra.message: the text is `error`)', () => {
    const e = withMask();
    expect(refused(e.call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { name: '' } }), 'INVALID_PROPERTY_VALUE').error).toBe('name must be a non-empty string');
    expect(refused(e.call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { inverted: 'yes' } }), 'INVALID_PROPERTY_VALUE').error).toBe('inverted must be true or false');
    expect(refused(e.call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { mode: 'xor' } }), 'INVALID_PROPERTY_VALUE')).toBeTruthy();
  });
  it('feather/expansion/opacity clamp and report in `clamped`', () => {
    const r: any = withMask().call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { opacity: -5 } });
    expect(r.data.currentValues.opacity).toBe(0); expect(r.data.clamped).toEqual(['opacity']);
  });
});

describe('removeMask (contracts l.625, results l.1015-1029)', () => {
  it('success: message, data, remainingMasks; a later mask shifts down one index', () => {
    const e = editor();
    e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 }, name: 'A' });
    e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 }, name: 'B' });
    const r: any = e.call('removeMask', { itemId: 'vid', maskIndex: 0 });
    expect(r).toMatchObject({ success: true, message: "Removed mask 0 'A' from 'vid'.", data: { itemId: 'vid', removedMaskIndex: 0, removedMaskName: 'A', remainingMasks: 1 } });
    expect(vid(e).masks[0].name).toBe('B'); // B is now at index 0
  });
  it('works on an item type createMask would refuse (no INVALID_ITEM_TYPE check on removeMask)', () => {
    const e = createEditor(build({ tracks: [mkTrack('O1', 'overlay')], items: [mkItem('t1', 'O1', 0, 4000, { type: 'text', details: { text: 'Hi' }, masks: [
      { id: 'm1', name: 'M', enabled: true, points: [{ anchor: { x: 0, y: 0 } }, { anchor: { x: 1, y: 0 } }, { anchor: { x: 1, y: 1 } }], closed: true, mode: 'add', order: 0, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape' },
    ] }) ] }));
    expect(e.call('removeMask', { itemId: 't1', maskIndex: 0 })).toMatchObject({ success: true });
  });
  it('NO_MASKS, INVALID_MASK_INDEX', () => {
    expect(refused(editor().call('removeMask', { itemId: 'vid', maskIndex: 0 }), 'NO_MASKS')).toBeTruthy();
    const e = editor(); e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } });
    expect(refused(e.call('removeMask', { itemId: 'vid', maskIndex: 5 }), 'INVALID_MASK_INDEX')).toBeTruthy();
  });
});

describe('writeMaskPoints (contracts l.944-970, results l.1526-1550)', () => {
  // createMask always seeds one path keyframe (contracts l.329-345), so clear it to get a static base path for the
  // plain update/add/remove tests below; freshMask() keeps that keyframe, for the KEYFRAMED_MASK_NO_* refusals.
  const freshMask = () => { const e = editor(); e.call('createMask', { itemId: 'vid', timelineSeconds: 0, points: [{ anchor: { x: 100, y: 100 } }, { anchor: { x: 200, y: 100 } }, { anchor: { x: 150, y: 200 } }] }); return e; };
  const withMask = () => { const e = freshMask(); e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, clearKeyframes: true }); return e; };
  it('update moves a point by index (canvas px), one op, one "Edit items" entry', () => {
    const e = withMask();
    const before = vid(e).masks[0].points[0].anchor, entries = e.bus.undoStack.length;
    const r: any = e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, update: [{ pointIndex: 0, anchor: { x: 120, y: 90 } }] });
    expect(r).toMatchObject({ success: true, ops: [{ op: 'update', count: 1 }] });
    expect(r.message).toBe('writeMaskPoints on mask 0: update(1)');
    expect(vid(e).masks[0].points[0].anchor).not.toEqual(before);
    expect(e.bus.undoStack.length - entries).toBe(1); expect(e.bus.undoStack.at(-1)!.label).toBe('Edit items');
  });
  it('add appends a point (afterPointIndex default: the end); 4 points after', () => {
    const e = withMask();
    const r: any = e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ anchor: { x: 175, y: 150 } }] });
    expect(r.ops).toEqual([{ op: 'add', count: 1 }]);
    expect(vid(e).masks[0].points).toHaveLength(4);
  });
  it('add[].after places the point; -1 is the start; out of range is INVALID_AFTER_INDEX', () => {
    const e = withMask(), xs = () => vid(e).masks[0].points.map((p: any) => p.anchor.x);
    e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ after: 0, anchor: { x: 111, y: 100 } }, { after: -1, anchor: { x: 99, y: 100 } }] });
    expect(xs()).toEqual([99, 100, 111, 200, 150]);
    refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ after: 9, anchor: { x: 1, y: 1 } }] }), 'INVALID_AFTER_INDEX');
    expect(xs()).toHaveLength(5);
  });
  it('§41b: one axis updates that axis, null removes a handle, a new point needs both axes, the first bad point stops the call', () => {
    const e = withMask(), first = () => vid(e).masks[0].points[0];
    expect((e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, update: [{ pointIndex: 0, handleOut: { x: 5, y: 6 } }] }) as any).success).toBe(true);
    expect(first().handleOut).toBeDefined();
    e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, update: [{ pointIndex: 0, anchor: { x: 130 }, handleOut: null }] });
    expect(first().anchor).toEqual({ x: 130, y: 100 }); expect(first().handleOut).toBeUndefined();
    refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ anchor: { x: 1 } }] }), 'INVALID_POINT_COORDINATES');
    const before = structuredClone(vid(e).masks[0].points);
    refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, update: [{ pointIndex: 0, anchor: { x: 1, y: 1 } }, { pointIndex: 1, anchor: { x: NaN } }] }), 'INVALID_POINT_COORDINATES');
    expect(vid(e).masks[0].points).toEqual(before);
  });
  it('KEYFRAMED_MASK_NO_ADD / _NO_REMOVE: createMask\'s own path keyframe already blocks add/remove', () => {
    const e = freshMask();
    expect(refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ anchor: { x: 1, y: 1 } }] }), 'KEYFRAMED_MASK_NO_ADD').message)
      .toBe("Mask 0 has 1 path keyframe(s); adding points needs a static path. Clear them first with clearKeyframes: true (keepStateAt keeps one time's shape).");
    expect(refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, remove: [0] }), 'KEYFRAMED_MASK_NO_REMOVE').message)
      .toBe("Mask 0 has 1 path keyframe(s); removing points needs a static path. Clear them first with clearKeyframes: true (keepStateAt keeps one time's shape).");
  });
  it('remove refuses below 3 points (MIN_POINTS_REQUIRED)', () => {
    expect(refused(withMask().call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, remove: [0, 1] }), 'MIN_POINTS_REQUIRED').message).toBe('Removing 2 point(s) would leave 1 point(s). Minimum 3 points required.');
  });
  it('clearKeyframes: true clears the path keyframes; keepStateAt keeps the shape at that time as the base path', () => {
    const e = freshMask(); // 1 path keyframe from creation
    e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, at: 2, update: [{ pointIndex: 0, anchor: { x: 10, y: 10 } }] }); // a 2nd, at 2s
    expect(vid(e).masks[0].keyframes.path.keyframes).toHaveLength(2);
    const r: any = e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, clearKeyframes: true, keepStateAt: 1 });
    expect(r).toMatchObject({ success: true, data: { maskIndex: 0, clearedCount: 2 } });
    expect(vid(e).masks[0].keyframes).toBeUndefined();
  });
  it('INVALID_COMBINATION: at + keyframeIndex, or clearKeyframes with another op', () => {
    const e = withMask();
    expect(refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, at: 1, keyframeIndex: 0, update: [{ pointIndex: 0, anchor: { x: 1, y: 1 } }] }), 'INVALID_COMBINATION')).toBeTruthy();
    expect(refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, clearKeyframes: true, add: [{ anchor: { x: 1, y: 1 } }] }), 'INVALID_COMBINATION')).toBeTruthy();
  });
  it('SMART_MASK_NOT_EDITABLE: a mask with source "smart" or a raster ref refuses points edits', () => {
    const e = createEditor(doc({ masks: [{ id: 'm1', name: 'Smart', enabled: true, points: [], closed: true, mode: 'add', order: 0, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'smart' }] }));
    expect(refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ anchor: { x: 1, y: 1 } }] }), 'SMART_MASK_NOT_EDITABLE').message).toBe('Smart masks are AI-tracked and cannot have their points manually edited.');
  });
  it('NO_UPDATES / NO_POINTS / NO_INDICES: an op with nothing to do', () => {
    const e = withMask();
    expect(refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, update: [] }), 'NO_UPDATES')).toBeTruthy();
    expect(refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [] }), 'NO_POINTS')).toBeTruthy();
    expect(refused(e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, remove: [] }), 'NO_INDICES')).toBeTruthy();
  });
  it('update + add + remove together: not atomic, each its own "Edit items" undo entry, in order', () => {
    const e = withMask(); // 3 points: add a 4th first so remove has something safe to take
    e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ anchor: { x: 5, y: 5 } }] });
    const before = e.bus.undoStack.length;
    const r: any = e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, update: [{ pointIndex: 0, anchor: { x: 9, y: 9 } }], add: [{ anchor: { x: 6, y: 6 } }], remove: [1] });
    expect(r.ops).toEqual([{ op: 'update', count: 1 }, { op: 'add', count: 1 }, { op: 'remove', count: 1 }]);
    expect(e.bus.undoStack.length - before).toBe(3); // update, add and remove each push their own entry
    expect(e.bus.undoStack.slice(before).every(u => u.label === 'Edit items')).toBe(true);
  });
  it('undo reverts only the last stage of a multi-op call', () => {
    const e = withMask();
    e.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, update: [{ pointIndex: 0, anchor: { x: 9, y: 9 } }], add: [{ anchor: { x: 6, y: 6 } }] });
    expect(vid(e).masks[0].points).toHaveLength(4);
    e.bus.undo();
    expect(vid(e).masks[0].points).toHaveLength(3); // the add is undone
    expect(vid(e).masks[0].points[0].anchor).toEqual({ x: 9, y: 9 }); // the update stands
  });
});

describe('writeKeyframes maskIndex (contracts l.922-935)', () => {
  const withMask = () => { const e = editor(); e.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } }); return e; };
  it('adds a feather keyframe on the mask; stored under mask.keyframes.feather', () => {
    const e = withMask();
    const r: any = e.call('writeKeyframes', { itemId: 'vid', maskIndex: 0, payload: { feather: { add: [{ time: 1, value: 20 }] } } });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(vid(e).masks[0].keyframes.feather.keyframes).toMatchObject([{ value: 20 }]);
  });
  it('NO_MASKS on an item with no masks; INVALID_MASK_INDEX out of range', () => {
    expect(refused(editor().call('writeKeyframes', { itemId: 'vid', maskIndex: 0, payload: { feather: { add: [{ time: 1, value: 20 }] } } }), 'NO_MASKS')).toBeTruthy();
    expect(refused(withMask().call('writeKeyframes', { itemId: 'vid', maskIndex: 3, payload: { feather: { add: [{ time: 1, value: 20 }] } } }), 'INVALID_MASK_INDEX')).toBeTruthy();
  });
});

describe('viewItemDetails include=masks (results MaskView l.1340-1348)', () => {
  const deps = { store: { row: async () => undefined, putRow: async () => {}, media: {} }, service: { rhythm: async () => { throw new Error('unused'); } } } as never;
  const call = (toolName: string, input: Record<string, unknown>, session = 's'): Call => ({ type: 'call', callId: 'c', executionKey: `mcp:conn:${toolName}`, toolName, input, session });
  function rig(extra: Record<string, unknown> = {}) {
    const ed = editor(extra);
    const ex = new Executor({ current: () => ed.runtime, ui: () => ({ selection: [], playheadMs: 0 }), analysis: (async () => deps) as never });
    return { ed, ex };
  }
  it('a static mask: type path, closed, pointCount, canvas-px points, pathEditing lets add/remove/move', async () => {
    const { ed, ex } = rig();
    ed.call('createMask', { itemId: 'vid', timelineSeconds: 0, points: [{ anchor: { x: 1, y: 1 } }, { anchor: { x: 2, y: 1 } }, { anchor: { x: 1, y: 2 } }] });
    ed.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, clearKeyframes: true }); // createMask seeds a path keyframe; clear it for the static-mask view
    const r: any = await ex.execute(call('viewItemDetails', { itemId: 'vid', include: 'masks' }, 's'));
    expect(r.success, JSON.stringify(r)).toBe(true);
    const m = r.data.masks.items[0];
    expect(m).toMatchObject({ index: 0, type: 'path', closed: true, pointCount: 3, pathEditing: { canAddPoints: true, canRemovePoints: true, canMovePoints: true, requiresKeyframeIndex: false } });
    expect(m.points).toHaveLength(3);
  });
  it('a keyframed mask: type path with pathKeyframes + currentInterpolatedPoints, pathEditing requires keyframeIndex', async () => {
    const { ed, ex } = rig();
    ed.call('createMask', { itemId: 'vid', timelineSeconds: 0, points: [{ anchor: { x: 1, y: 1 } }, { anchor: { x: 2, y: 1 } }, { anchor: { x: 1, y: 2 } }] });
    ed.call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, at: 2, update: [{ pointIndex: 0, anchor: { x: 9, y: 9 } }] });
    const r: any = await ex.execute(call('viewItemDetails', { itemId: 'vid', include: 'masks' }, 's'));
    const m = r.data.masks.items[0];
    expect(m.type).toBe('path'); expect(m.pathKeyframes).toHaveLength(2);
    expect(m.currentInterpolatedPoints.pointCount).toBe(3);
    expect(m.pathEditing).toMatchObject({ canAddPoints: false, canRemovePoints: false, canMovePoints: true, requiresKeyframeIndex: true });
  });
  it('a smart (raster) mask: type smart, trackingLabel, pathEditing refuses every point op', async () => {
    const { ex } = rig({ masks: [{ id: 'm1', name: 'Tracked', enabled: true, points: [], closed: true, mode: 'add', order: 0, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'smart',
      raster: { file: 'r1.mask', sourceStartUs: 0, sourceEndUs: 4_000_000, frameCount: 1, width: 2, height: 2, space: { kind: 'item', width: 2, height: 2 }, version: 1 } }] });
    const r: any = await ex.execute(call('viewItemDetails', { itemId: 'vid', include: 'masks' }, 's'));
    const m = r.data.masks.items[0];
    expect(m).toMatchObject({ type: 'smart', trackingLabel: 'tracked object', pathEditing: { canAddPoints: false, canRemovePoints: false, canMovePoints: false } });
  });
  it('no masks on the item: data.masks is null with masksNote', async () => {
    const { ex } = rig();
    const r: any = await ex.execute(call('viewItemDetails', { itemId: 'vid', include: 'masks' }, 's'));
    expect(r.data.masks).toBeNull(); expect(r.data.masksNote).toBe('No masks on this item');
  });
});

describe('masks stale-read gate (results gate table l.24-43)', () => {
  const deps = { store: { row: async () => undefined, putRow: async () => {}, media: {} }, service: { rhythm: async () => { throw new Error('unused'); } } } as never;
  const call = (toolName: string, input: Record<string, unknown>, session = 's'): Call => ({ type: 'call', callId: 'c', executionKey: `mcp:conn:${toolName}:${Math.random()}`, toolName, input, session });
  function rig() {
    const ed = editor();
    ed.call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } }); // baseline, before the executor's first sync
    const ex = new Executor({ current: () => ed.runtime, ui: () => ({ selection: [], playheadMs: 0 }), analysis: (async () => deps) as never });
    return { ed, ex };
  }
  it('editMaskProperties / writeMaskPoints are always gated: refused before any read of the masks scope', async () => {
    const { ex } = rig();
    expect(await ex.execute(call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { feather: 5 } }))).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'masks', agentId: 'vid' });
    const { ex: ex2 } = rig();
    expect(await ex2.execute(call('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ anchor: { x: 1, y: 1 } }] }))).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'masks' });
  });
  it('include=masks marks the scope read; the refusal carries currentState (the MaskView)', async () => {
    const { ex } = rig();
    const refusal: any = await ex.execute(call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { feather: 5 } }));
    expect(refusal.currentState.masks.items).toHaveLength(1);
    expect(await ex.execute(call('viewItemDetails', { itemId: 'vid', include: 'masks' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { feather: 5 } }))).toMatchObject({ success: true });
  });
  it('createMask and removeMask each mark the masks scope read on success', async () => {
    const { ex } = rig();
    expect(await ex.execute(call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } }))).toMatchObject({ success: true });
    expect(await ex.execute(call('editMaskProperties', { itemId: 'vid', maskIndex: 1, properties: { feather: 5 } }))).toMatchObject({ success: true });
    const { ex: ex2 } = rig();
    expect(await ex2.execute(call('removeMask', { itemId: 'vid', maskIndex: 0 }))).toMatchObject({ success: true });
    expect(await ex2.execute(call('createMask', { itemId: 'vid', timelineSeconds: 0, shape: 'rectangle', bounds: { width: 10, height: 10 } }))).toMatchObject({ success: true });
  });
  it('a user edit to the masks after the read makes it stale again', async () => {
    const { ed, ex } = rig();
    await ex.execute(call('viewItemDetails', { itemId: 'vid', include: 'masks' }));
    ed.runtime.bus.run('Edit items' as never, 'user', d => { d.items.find((i: any) => i.id === 'vid')!.masks[0].feather = 33; });
    expect(await ex.execute(call('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { feather: 5 } }))).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'masks' });
  });
  it('writeKeyframes+maskIndex is gated only when the written property already has keyframes', async () => {
    const { ex } = rig();
    expect(await ex.execute(call('writeKeyframes', { itemId: 'vid', maskIndex: 0, payload: { feather: { add: [{ time: 1, value: 20 }] } } }))).toMatchObject({ success: true }); // not yet keyframed: ungated
    expect(await ex.execute(call('writeKeyframes', { itemId: 'vid', maskIndex: 0, payload: { feather: { add: [{ time: 2, value: 10 }] } } }))).toMatchObject({ code: 'STALE_READ_REFRESHED', scope: 'masks' }); // now keyframed: gated
  });
});

describe('T12 helper schemas (apps/helper/src/schemas.ts)', () => {
  it('a minimal valid call of each of the 4 tools passes validation', () => {
    expect(validate('createMask', { itemId: 'vid', timelineSeconds: 0, points: [{ anchor: { x: 1, y: 1 } }, { anchor: { x: 2, y: 1 } }, { anchor: { x: 1, y: 2 } }] })).toBeNull();
    expect(validate('editMaskProperties', { itemId: 'vid', maskIndex: 0, properties: { feather: 5 } })).toBeNull();
    expect(validate('removeMask', { itemId: 'vid', maskIndex: 0 })).toBeNull();
    expect(validate('writeMaskPoints', { itemId: 'vid', maskIndex: 0, add: [{ anchor: { x: 1, y: 1 } }] })).toBeNull();
  });
  it('editMaskProperties / removeMask require itemId, maskIndex (and properties): a schema-level REQUIRED refusal', () => {
    expect(validate('editMaskProperties', { itemId: 'vid', maskIndex: 0 })).toMatchObject({ code: 'INVALID_TOOL_INPUT', details: { errors: [{ code: 'REQUIRED', path: '$.properties' }] } });
    expect(validate('removeMask', { itemId: 'vid' })).toMatchObject({ code: 'INVALID_TOOL_INPUT', details: { errors: [{ code: 'REQUIRED', path: '$.maskIndex' }] } });
  });
  it('createMask / writeMaskPoints have no required array: a wrong type is refused instead (TYPE)', () => {
    expect(validate('createMask', { itemId: 1 })).toMatchObject({ code: 'INVALID_TOOL_INPUT', details: { errors: [{ code: 'TYPE' }] } });
  });
  it('writeMaskPoints: at and keyframeIndex together are INVALID_COMBINATION', () => {
    expect(validate('writeMaskPoints', { itemId: 'vid', maskIndex: 0, at: 1, keyframeIndex: 0 })).toMatchObject({ code: 'INVALID_TOOL_INPUT', details: { errors: [{ path: '$.at', code: 'INVALID_COMBINATION' }] } });
  });
});

void (undefined as unknown as ProjectDocument);
