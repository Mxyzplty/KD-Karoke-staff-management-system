// SPDX-License-Identifier: AGPL-3.0-only
// T06 success shapes: addShape on the 6 presets and a custom path, writeShapePoints (add / insertAt / update / remove / keyframed paths /
// clear), viewItemDetails shapeType and points, and the drawShape runtime fixtures (2) rectangle from a drag, (3) start-frame rule,
// (4) track choice. Oracles: tickets §T06 fixtures (2)–(5), contracts addShape / writeShapePoints, results l.1325–l.1327; the pentagon, star,
// ellipse and rectangle numbers are re-derived here from the written formulas (regular polygon R = min(w,h)/2, κ = 0.5522847498), not read
// back from the code. Success envelopes of writeShapePoints are Cutframe's own (decision Q8): pinned as implemented.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { presetPoints, shifted } from '../apps/web/src/timeline/shapes';
import { viewItemDetails } from '../apps/web/src/analysis/details';
import type { DetailsContext } from '../apps/web/src/analysis/details';
import { build, mkTrack, resetIds, video } from './t03-fixtures';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T08:00:00.000Z')); });
afterEach(() => { resetIds(); vi.useRealTimers(); });

const doc = (): ProjectDocument => build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')], items: [video('v1', 'V1', 0, 4000)] });
const clip30 = (): ProjectDocument => build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 30000)] });
const KAPPA = 0.5522847498, BOX = { x: 0, y: 0, width: 320, height: 240 };
const item = (e: ReturnType<typeof createEditor>, id: string) => e.doc.items.find(i => i.id === id) as any;
const near = (a: number, b: number, tol = 0.01) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
const ctx = (d: ProjectDocument) => ({ doc: d, asset: () => undefined, agentId: () => undefined, store: { row: async () => undefined, putRow: async () => {}, media: {} }, service: { rhythm: async () => undefined } }) as unknown as DetailsContext;

const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
/** The stored shape record every shape starts as (tickets fixture 2 style defaults; contracts addShape). */
const record = (id: string, o: { type: string; trackId: string; from: number; to: number; path: string; points: unknown[]; w: number; h: number; x: number; y: number }) => ({
  name: `Shape ${o.type}`, id, type: 'shape', trackId: o.trackId, display: { from: o.from, to: o.to },
  details: { src: '', path: o.path, points: o.points, closed: true, width: o.w, height: o.h },
  properties: { positionX: prop(o.x), positionY: prop(o.y), width: prop(o.w), height: prop(o.h), opacity: prop(1), scale: prop(1), rotation: prop(0),
    fillColor: prop('#3b82f6'), fillOpacity: prop(1), strokeColor: prop('none'), strokeWidth: prop(0), strokeOpacity: prop(1) },
  metadata: { shapeType: o.type },
});
const pt = (x: number, y: number) => ({ anchor: { x, y } });

describe('T06 addShape: the 6 presets (tickets fixture 5)', () => {
  it('1. rectangle in 0,0 320×240 for 2 s: the whole response (with timelineChanges) and the whole stored record', () => {
    const e = createEditor(doc()), r = e.call('addShape', { shape: 'rectangle', bounds: BOX, duration: 2, trackId: 'O1', timelineStart: 0 }) as any, id = r.data.itemId;
    expect(r).toStrictEqual({
      success: true, message: `Shape '${id}' (rectangle) added to track 'O1' at 0s`,
      data: { itemId: id, trackId: 'O1', shapeType: 'rectangle', pointCount: 4, timelineStart: 0, duration: 2, bounds: BOX },
      timelineChanges: { basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true, readBack: 'Use context or viewItemDetails for changed fields not included in these summaries, or for truncated text.',
        items: { created: [{ itemId: id, type: 'shape', trackId: 'O1', from: 0, to: 2 }], updated: [], deleted: [] } },
    });
    expect(item(e, id)).toStrictEqual(record(id, { type: 'rectangle', trackId: 'O1', from: 0, to: 2000, path: 'M 0,0 L 320,0 L 320,240 L 0,240 Z',
      points: [pt(0, 0), pt(320, 0), pt(320, 240), pt(0, 240)], w: 320, h: 240, x: 0, y: 0 }));
  });

  const run = (shape: string, bounds: Record<string, number> = BOX, extra: Record<string, unknown> = {}) => {
    const e = createEditor(doc()), r = e.call('addShape', { shape, bounds, duration: 2, trackId: 'O1', timelineStart: 0, ...extra }) as any;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const { timelineChanges, ...core } = r; expect(timelineChanges).toBeDefined();
    return { e, core, it: item(e, r.data.itemId) };
  };
  const handled = (i: any) => i.details.points.filter((p: any) => p.handleIn || p.handleOut).length;

  it('2. anchor counts, shapeType and handles per preset: rectangle 4, ellipse 4, triangle 3, pentagon 5, star 10, heart 6; handles on ellipse and heart only', () => {
    const want: Record<string, [number, boolean]> = { rectangle: [4, false], ellipse: [4, true], triangle: [3, false], pentagon: [5, false], star: [10, false], heart: [6, true] };
    for (const [shape, [n, hasHandles]] of Object.entries(want)) {
      const { core, it: i } = run(shape);
      expect(core.message, shape).toBe(`Shape '${core.data.itemId}' (${shape}) added to track 'O1' at 0s`);
      expect(core.data, shape).toMatchObject({ shapeType: shape, pointCount: n, trackId: 'O1', timelineStart: 0, duration: 2 });
      expect(i.metadata, shape).toStrictEqual({ shapeType: shape }); expect(i.details.points, shape).toHaveLength(n); expect(i.details.closed, shape).toBe(true);
      expect(handled(i) > 0, shape).toBe(hasHandles);
      if (!hasHandles) for (const p of i.details.points) expect(Object.keys(p), shape).toEqual(['anchor']);
    }
  });

  it('3. triangle: apex top-centre, base corners at the bottom (whole record)', () => {
    const { it: i } = run('triangle');
    expect(i.details.points).toStrictEqual([pt(160, 0), pt(320, 240), pt(0, 240)]); expect(i.details.path).toBe('M 160,0 L 320,240 L 0,240 Z');
  });

  it('4. ellipse: four anchors right / bottom / left / top, handles κ·radius (88.37 × 66.27 in 320 × 240)', () => {
    const { it: i } = run('ellipse'), kx = Math.round(KAPPA * 160 * 100) / 100, ky = Math.round(KAPPA * 120 * 100) / 100;
    expect(i.details.points).toStrictEqual([
      { anchor: { x: 320, y: 120 }, handleIn: { x: 0, y: -ky }, handleOut: { x: 0, y: ky } },
      { anchor: { x: 160, y: 240 }, handleIn: { x: kx, y: 0 }, handleOut: { x: -kx, y: 0 } },
      { anchor: { x: 0, y: 120 }, handleIn: { x: 0, y: ky }, handleOut: { x: 0, y: -ky } },
      { anchor: { x: 160, y: 0 }, handleIn: { x: -kx, y: 0 }, handleOut: { x: kx, y: 0 } },
    ]);
    near(kx, 88.37); near(ky, 66.27);
  });

  it('5. pentagon and star in 320 × 240 keep their own aspect: stored 228.25 × 217.08 (±0.01); centred on the box; first vertex up', () => {
    const R = 120, w = 2 * R * Math.sin(2 * Math.PI / 5), h = R * (1 + Math.cos(Math.PI / 5));
    near(w, 228.25); near(h, 217.08);
    for (const shape of ['pentagon', 'star']) {
      const { core, it: i } = run(shape);
      near(i.details.width, 228.25); near(i.details.height, 217.08); near(i.properties.width.defaultValue, 228.25); near(i.properties.height.defaultValue, 217.08);
      near(core.data.bounds.width, 228.25); near(core.data.bounds.height, 217.08);
      near(core.data.bounds.x + core.data.bounds.width / 2, 160); near(i.properties.positionX.defaultValue, core.data.bounds.x);
      const apex = i.details.points[0].anchor; near(apex.y, 0); near(apex.x + i.properties.positionX.defaultValue, 160);
    }
  });

  it('6. star: outer vertices on R = min(w, h) / 2 = 120, inner vertices on 0.4·R, alternating', () => {
    const { it: i } = run('star'), cx = 160 - i.properties.positionX.defaultValue, cy = 120;
    i.details.points.forEach((p: any, k: number) => {
      const d = Math.hypot(p.anchor.x - cx, p.anchor.y - cy), want = k % 2 ? 0.4 * 120 : 120;
      near(d, want, 0.02);
    });
  });

  it('7. pentagon: five vertices on R = 120 around the box centre', () => {
    const { it: i } = run('pentagon'), cx = 160 - i.properties.positionX.defaultValue;
    for (const p of i.details.points) near(Math.hypot(p.anchor.x - cx, p.anchor.y - 120), 120, 0.02);
  });

  it('8. heart: 6 anchors with handles, width 320 and height 0.9 × 240 = 216, inside the box (placement within the box is Cutframe\'s own; no spec value)', () => {
    const { core, it: i } = run('heart');
    near(i.details.width, 320); near(i.details.height, 216);
    expect(core.data.bounds).toMatchObject({ x: 0, width: 320, height: 216 }); expect(core.data.bounds.y).toBeGreaterThanOrEqual(0); expect(core.data.bounds.y + 216).toBeLessThanOrEqual(240 + 1e-9);
  });

  it('9. centre bounds (cx / cy) and roundness place and round the rectangle: 4 anchors kept, handles appear on rounded corners', () => {
    const c = run('rectangle', { cx: 500, cy: 400, width: 200, height: 100 });
    expect(c.core.data.bounds).toStrictEqual({ x: 400, y: 350, width: 200, height: 100 });
    expect(c.it.properties.positionX.defaultValue).toBe(400); expect(c.it.properties.positionY.defaultValue).toBe(350);
    const r = run('rectangle', BOX, { roundness: 50 });
    expect(r.it.details.points.length).toBeGreaterThan(4); expect(handled(r.it)).toBeGreaterThan(0); expect(r.core.data.shapeType).toBe('rectangle');
    near(r.it.details.width, 320); near(r.it.details.height, 240);
  });

  it('10. style options reach the record (fill, stroke) and the default style is the panel default', () => {
    const { it: i } = run('ellipse', BOX, { fillColor: '#ff0000', fillOpacity: 0.5, strokeColor: '#000000', strokeWidth: 4 });
    expect(i.properties.fillColor.defaultValue).toBe('#ff0000'); expect(i.properties.fillOpacity.defaultValue).toBe(0.5);
    expect(i.properties.strokeColor.defaultValue).toBe('#000000'); expect(i.properties.strokeWidth.defaultValue).toBe(4);
  });
});

describe('T06 addShape: a custom 6-point path (tickets fixture 5)', () => {
  const POINTS = [pt(600, 600), pt(700, 560), pt(800, 600), pt(800, 700), pt(700, 740), pt(600, 700)];
  it('11. shapeType "custom", 6 anchors, closed; item box = the path bbox; points stored item-local', () => {
    const e = createEditor(doc()), r = e.call('addShape', { points: POINTS, duration: 2, trackId: 'O1', timelineStart: 0 }) as any, id = r.data.itemId;
    const { timelineChanges, ...core } = r; expect(timelineChanges).toBeDefined();
    expect(core).toStrictEqual({ success: true, message: `Shape '${id}' (custom) added to track 'O1' at 0s`,
      data: { itemId: id, trackId: 'O1', shapeType: 'custom', pointCount: 6, timelineStart: 0, duration: 2, bounds: { x: 600, y: 560, width: 200, height: 180 } } });
    expect(item(e, id)).toStrictEqual(record(id, { type: 'custom', trackId: 'O1', from: 0, to: 2000, path: 'M 0,40 L 100,0 L 200,40 L 200,140 L 100,180 L 0,140 Z',
      points: [pt(0, 40), pt(100, 0), pt(200, 40), pt(200, 140), pt(100, 180), pt(0, 140)], w: 200, h: 180, x: 600, y: 560 }));
  });
  it('12. default timeline start (insertAfterItemId) and duration: the shape follows the anchor item on its track', () => {
    const e = createEditor(doc()), a = e.call('addShape', { shape: 'star', bounds: BOX, duration: 2, trackId: 'O1', timelineStart: 1 }) as any;
    const b = e.call('addShape', { shape: 'heart', bounds: BOX, duration: 3, insertAfterItemId: a.data.itemId }) as any;
    expect(b.success, JSON.stringify(b)).toBe(true); expect(b.data).toMatchObject({ trackId: 'O1', timelineStart: 3, duration: 3, shapeType: 'heart' });
  });
});

describe('T06 writeShapePoints: update, add (insertAt), remove and the combined call', () => {
  const setup = () => {
    const e = createEditor(doc()), r = e.call('addShape', { shape: 'rectangle', bounds: { x: 100, y: 100, width: 200, height: 100 }, duration: 5, trackId: 'O1', timelineStart: 0 }) as any;
    return { e, id: r.data.itemId as string };
  };
  const pts = (e: ReturnType<typeof createEditor>, id: string) => item(e, id).details.points.map((p: any) => [p.anchor.x, p.anchor.y]);
  const change = (id: string, fields: string[]) => ({ basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true, readBack: 'Use context or viewItemDetails for changed fields not included in these summaries, or for truncated text.',
    items: { created: [], updated: [{ itemId: id, changedFields: fields, before: { type: 'shape', trackId: 'O1', from: 0, to: 5 }, after: { type: 'shape', trackId: 'O1', from: 0, to: 5 } }], deleted: [] } });

  it('13. update: one anchor axis (canvas px) moves the point, refits the box; whole response', () => {
    const { e, id } = setup();
    expect(e.call('writeShapePoints', { itemId: id, update: [{ pointIndex: 0, anchor: { x: 90 } }] })).toStrictEqual({
      success: true, message: `writeShapePoints on shape '${id}': update(1)`, ops: [{ op: 'update', count: 1 }],
      timelineChanges: change(id, ['details.path', 'details.points', 'details.width', 'properties.positionX', 'properties.width']) });
    expect(pts(e, id)).toStrictEqual([[0, 0], [210, 0], [210, 100], [10, 100]]);
    expect(item(e, id).properties.positionX.defaultValue).toBe(90); expect(item(e, id).properties.width.defaultValue).toBe(210); expect(item(e, id).details.width).toBe(210);
  });

  it('14. add: a point appended at the end by default, and insertAt places it at the index', () => {
    const { e, id } = setup();
    expect(e.call('writeShapePoints', { itemId: id, add: [{ anchor: { x: 200, y: 150 } }] })).toStrictEqual({
      success: true, message: `writeShapePoints on shape '${id}': add(1)`, ops: [{ op: 'add', count: 1 }], timelineChanges: change(id, ['details.path', 'details.points']) });
    expect(pts(e, id)).toStrictEqual([[0, 0], [200, 0], [200, 100], [0, 100], [100, 50]]);
    expect(e.call('writeShapePoints', { itemId: id, add: [{ anchor: { x: 150, y: 120 } }], insertAt: 1 })).toMatchObject({ success: true, ops: [{ op: 'add', count: 1 }] });
    expect(pts(e, id)).toStrictEqual([[0, 0], [50, 20], [200, 0], [200, 100], [0, 100], [100, 50]]);
    expect(item(e, id).metadata.shapeType).toBe('rectangle');
  });

  it('15. remove: points leave by index, nothing below 3 (closed); whole response', () => {
    const { e, id } = setup();
    expect(e.call('writeShapePoints', { itemId: id, remove: [3] })).toStrictEqual({
      success: true, message: `writeShapePoints on shape '${id}': remove(1)`, ops: [{ op: 'remove', count: 1 }], timelineChanges: change(id, ['details.path', 'details.points']) });
    expect(pts(e, id)).toStrictEqual([[0, 0], [200, 0], [200, 100]]);
  });

  it('16. one call with update + add + remove commits the stages in turn and reports them in that order', () => {
    const { e, id } = setup();
    const r = e.call('writeShapePoints', { itemId: id, update: [{ pointIndex: 0, anchor: { y: 110 } }], add: [{ anchor: { x: 200, y: 150 } }], remove: [2] }) as any;
    expect(r).toMatchObject({ success: true, message: `writeShapePoints on shape '${id}': update(1) + add(1) + remove(1)`, ops: [{ op: 'update', count: 1 }, { op: 'add', count: 1 }, { op: 'remove', count: 1 }] });
    expect(item(e, id).details.points).toHaveLength(4);
  });

  it('17. a handle can be set with an offset from its anchor and removed with null', () => {
    const { e, id } = setup();
    expect(e.call('writeShapePoints', { itemId: id, update: [{ pointIndex: 1, handleOut: { x: 10, y: 20 } }] })).toMatchObject({ success: true });
    expect(item(e, id).details.points[1].handleOut).toStrictEqual({ x: 10, y: 20 });
    expect(e.call('writeShapePoints', { itemId: id, update: [{ pointIndex: 1, handleOut: null }] })).toMatchObject({ success: true });
    expect(item(e, id).details.points[1].handleOut).toBeUndefined();
  });

  it('18. keyframed path: update at a time makes a path keyframe (details.keyframes only); curve edits the keyframe; add / remove are refused; clearKeyframes frees them', () => {
    const { e, id } = setup(), base = JSON.stringify(item(e, id).details.points);
    expect(e.call('writeShapePoints', { itemId: id, at: 1, update: [{ pointIndex: 0, anchor: { x: 80 } }] })).toStrictEqual({
      success: true, message: `writeShapePoints on shape '${id}': update(1)`, ops: [{ op: 'update', count: 1 }], timelineChanges: change(id, ['details.keyframes']) });
    expect(JSON.stringify(item(e, id).details.points)).toBe(base);
    expect(item(e, id).details.keyframes.path.keyframes).toHaveLength(1);
    expect(e.call('writeShapePoints', { itemId: id, keyframeIndex: 0, easing: 'linear' })).toStrictEqual({ success: true, message: `writeShapePoints on shape '${id}': curve`, ops: [{ op: 'curve' }] });
    expect(e.call('writeShapePoints', { itemId: id, add: [{ anchor: { x: 1, y: 2 } }] })).toMatchObject({ success: false, code: 'KEYFRAMED_SHAPE_NO_ADD' });
    expect(e.call('writeShapePoints', { itemId: id, remove: [0] })).toMatchObject({ success: false, code: 'KEYFRAMED_SHAPE_NO_REMOVE' });
    expect(e.call('writeShapePoints', { itemId: id, clearKeyframes: true })).toStrictEqual({
      success: true, message: `Cleared 1 path keyframe(s) from shape "${id}". Points can now be added/removed.`, data: { itemId: id, clearedCount: 1, pointCount: 4 },
      timelineChanges: change(id, ['details.keyframes']) });
    expect(e.call('writeShapePoints', { itemId: id, remove: [0] })).toMatchObject({ success: true });
    expect(e.call('writeShapePoints', { itemId: id, clearKeyframes: true })).toStrictEqual({
      success: true, message: `Shape "${id}" has no path keyframes to clear.`, data: { itemId: id, clearedCount: 0 } });
  });

  it('19. each accepted call is one undo step ("Edit items") and undo restores the points', () => {
    const { e, id } = setup(), n = e.bus.undoStack.length, before = JSON.stringify(e.doc);
    expect(e.call('writeShapePoints', { itemId: id, remove: [3] })).toMatchObject({ success: true });
    expect(e.bus.undoStack).toHaveLength(n + 1);
    e.bus.undo(); expect(JSON.stringify(e.doc)).toBe(before);
  });
});

describe('T06 viewItemDetails include=general on shape items: shapeType and points in canvas px (results l.1325–l.1327)', () => {
  it('20. every preset and a custom path read back shapeType and fullDetails {points, closed}; points are canvas px (item box offset added)', async () => {
    const e = createEditor(doc()), want: [string, number][] = [['rectangle', 4], ['ellipse', 4], ['triangle', 3], ['pentagon', 5], ['star', 10], ['heart', 6]];
    for (const [shape, n] of want) {
      const r = e.call('addShape', { shape, bounds: { x: 100, y: 200, width: 320, height: 240 }, duration: 2, trackId: 'O1', timelineStart: want.findIndex(w => w[0] === shape) * 2 }) as any;
      const v = await viewItemDetails(ctx(e.doc), { itemId: r.data.itemId }) as any, i = item(e, r.data.itemId);
      expect(v.success, shape).toBe(true);
      expect(v.data.timelineMetadata.metadata, shape).toStrictEqual({ shapeType: shape });
      expect(v.data.fullDetails.closed, shape).toBe(true); expect(v.data.fullDetails.points, shape).toHaveLength(n);
      const ox = i.properties.positionX.defaultValue, oy = i.properties.positionY.defaultValue;
      i.details.points.forEach((p: any, k: number) => {
        const q = v.data.fullDetails.points[k]; near(q.anchor.x, p.anchor.x + ox, 0.005); near(q.anchor.y, p.anchor.y + oy, 0.005);
        expect(Boolean(q.handleIn), `${shape}[${k}]`).toBe(Boolean(p.handleIn));
      });
    }
    const c = e.call('addShape', { points: [pt(600, 600), pt(700, 560), pt(800, 600), pt(800, 700), pt(700, 740), pt(600, 700)], duration: 2, trackId: 'O1', timelineStart: 20 }) as any;
    const v = await viewItemDetails(ctx(e.doc), { itemId: c.data.itemId }) as any;
    expect(v.data.timelineMetadata.metadata).toStrictEqual({ shapeType: 'custom' });
    expect(v.data.fullDetails).toStrictEqual({ points: [pt(600, 600), pt(700, 560), pt(800, 600), pt(800, 700), pt(700, 740), pt(600, 700)], closed: true });
  });

  it('21. a point edit is visible in the next read (no stale copy)', async () => {
    const e = createEditor(doc()), r = e.call('addShape', { shape: 'rectangle', bounds: { x: 100, y: 100, width: 200, height: 100 }, duration: 2, trackId: 'O1', timelineStart: 0 }) as any;
    e.call('writeShapePoints', { itemId: r.data.itemId, update: [{ pointIndex: 2, anchor: { x: 320, y: 230 } }] });
    const v = await viewItemDetails(ctx(e.doc), { itemId: r.data.itemId }) as any;
    expect(v.data.fullDetails.points).toStrictEqual([pt(100, 100), pt(300, 100), pt(320, 230), pt(100, 200)]);
  });
});

describe('T06 drawShape runtime fixtures (tickets W3-RT-08 fixtures 2–4)', () => {
  const DRAG = { points: [pt(200, 300), pt(520, 300), pt(520, 500), pt(200, 500)], closed: true };
  const draw = (e: ReturnType<typeof createEditor>, playheadMs: number, shapeType = 'rectangle', path: any = DRAG) => {
    const before = new Set(e.doc.items.map(i => i.id));
    expect(e.intent({ type: 'drawShape', shapeType, path, playheadMs, style: {} })).toMatchObject({ ok: true });
    const made = e.doc.items.filter(i => !before.has(i.id)); expect(made).toHaveLength(1); return made[0] as any;
  };

  it('22. fixture 2: playhead 1.0 s, a drag makes one "Add items" entry: display 1,000–6,000 ms, name "Shape rectangle", 4 anchors, style defaults', () => {
    const e = createEditor(clip30()), n = e.bus.undoStack.length, before = JSON.stringify(e.doc);
    const made = draw(e, 1000);
    expect(e.bus.undoStack).toHaveLength(n + 1); expect(JSON.stringify(e.bus.undoStack.at(-1))).toContain('Add items');
    const track = e.doc.tracks.find(t => t.id === made.trackId)!; expect(track.kind).toBe('overlay');
    expect(made).toStrictEqual(record(made.id, { type: 'rectangle', trackId: made.trackId, from: 1000, to: 6000, path: 'M 0,0 L 320,0 L 320,200 L 0,200 Z',
      points: [pt(0, 0), pt(320, 0), pt(320, 200), pt(0, 200)], w: 320, h: 200, x: 200, y: 300 }));
    e.bus.undo(); expect(JSON.stringify(e.doc)).toBe(before);
  });

  it('23. fixture 3: the start frame is floor(playhead · 30 fps) whole frames, stored in whole ms; a playhead shown as 5.00 s / 20.00 s (4.999 / 19.999) gives 4,967 / 19,967 ms (frames 149 / 599); an exact frame boundary stays', () => {
    const rows: [number, number][] = [[4999, 4967], [19999, 19967], [5000, 5000], [20000, 20000], [1000, 1000], [0, 0]];
    for (const [playhead, start] of rows) {
      const made = draw(createEditor(clip30()), playhead);
      expect(made.display, `${playhead} ms`).toStrictEqual({ from: start, to: start + 5000 });
      expect(Math.floor(start * 30 / 1000 + 1e-6), `${playhead} ms frames`).toBe(Math.floor(playhead * 30 / 1000 + 1e-6));
    }
  });

  it('24. fixture 4: shape 1 at 1–6 s → a new overlay track (O1); shape 2 at 4.967–9.967 s overlaps → a second new overlay (O2); shape 3 at 19.967–24.967 s → the existing first overlay', () => {
    const e = createEditor(clip30()), tracksBefore = e.doc.tracks.length;
    const s1 = draw(e, 1000), s2 = draw(e, 4999), s3 = draw(e, 19999);
    expect([s1.display, s2.display, s3.display]).toStrictEqual([{ from: 1000, to: 6000 }, { from: 4967, to: 9967 }, { from: 19967, to: 24967 }]);
    expect(s2.trackId).not.toBe(s1.trackId); expect(s3.trackId).toBe(s1.trackId);
    expect(e.doc.tracks).toHaveLength(tracksBefore + 2);
    const overlays = e.doc.tracks.filter(t => t.kind === 'overlay'); expect(overlays.map(t => t.id)).toEqual(expect.arrayContaining([s1.trackId, s2.trackId]));
  });

  it('25. a UI Polygon of 5 points stores its own type "polygon": 5 anchors, closed, no handles; a Pen path stores "custom"', () => {
    const e = createEditor(clip30());
    const poly = draw(e, 0, 'polygon', { points: [pt(10, 10), pt(110, 10), pt(130, 80), pt(60, 130), pt(0, 80)], closed: true });
    expect(poly.metadata).toStrictEqual({ shapeType: 'polygon' }); expect(poly.details.points).toHaveLength(5); expect(poly.details.closed).toBe(true);
    for (const p of poly.details.points) expect(Object.keys(p)).toEqual(['anchor']);
    const pen = draw(e, 0, 'custom', { points: [pt(10, 10), pt(110, 10), { anchor: { x: 60, y: 130 }, handleIn: { x: -20, y: 0 }, handleOut: { x: 20, y: 0 } }], closed: true });
    expect(pen.metadata).toStrictEqual({ shapeType: 'custom' }); expect(pen.details.points).toHaveLength(3);
  });

  it('26. a UI Rectangle, Ellipse and Star drag stores the same shapeType, anchors, handles, size and position as addShape with the same canvas box (±0.01); ticket acceptance l.202', () => {
    const box = { x: 120.5, y: 80.25, width: 310, height: 190 };
    for (const type of ['rectangle', 'ellipse', 'star'] as const) {
      // What the stage overlay builds from a drag: the preset in a w × h box, shifted to the drag's top-left (shape-ui.tsx up()).
      const ui = draw(createEditor(clip30()), 0, type, { points: shifted(presetPoints(type, box.width, box.height), box.x, box.y), closed: true });
      const e = createEditor(doc()), r = e.call('addShape', { shape: type, bounds: box, duration: 5, trackId: 'O1', timelineStart: 0 }) as any;
      expect(r.success, JSON.stringify(r)).toBe(true);
      const agent = item(e, r.data.itemId);
      expect(ui.metadata.shapeType, type).toBe(agent.metadata.shapeType); expect(ui.details.closed, type).toBe(agent.details.closed);
      expect(ui.details.points, type).toHaveLength(agent.details.points.length);
      ui.details.points.forEach((p: any, k: number) => {
        const q = agent.details.points[k];
        near(p.anchor.x, q.anchor.x); near(p.anchor.y, q.anchor.y);
        for (const h of ['handleIn', 'handleOut']) { expect(!!p[h], `${type} point ${k} ${h}`).toBe(!!q[h]); if (p[h]) { near(p[h].x, q[h].x); near(p[h].y, q[h].y); } }
      });
      for (const k of ['positionX', 'positionY', 'width', 'height']) near(ui.properties[k].defaultValue, agent.properties[k].defaultValue);
    }
  });
});
