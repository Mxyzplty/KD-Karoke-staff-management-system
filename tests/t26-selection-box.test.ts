// SPDX-License-Identifier: AGPL-3.0-only
// T26 preview selection box, unit level: ticket T26 rows 1-6 and 10-14, research 7.1 points 1-8, lane A's rulings Q1, Q5, Q6, Q8, A1, A2.
// Written from the ticket and 7.1, not from the code: expected numbers are 7.1's (the W3-ED-15 drags) or worked by hand in the comments.
// Canvas 1080 x 1920, y down, angles in degrees. `zoom` is screen px per canvas px. Row 15 is tests/t26-transform-rotation.test.ts; the DOM side is
// tests/ui/t26-selection-box.spec.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import {
  atPlayhead, boundsOf, candidates, contains, cornerDrag, corners, frameOf, handleAt, handles, itemLocal, marqueeHits, moveDrag, pickAt, PICK_ALPHA_MIN,
  rotationDrag, screenPx, shownItems, writeEdits,
} from '../apps/web/src/editor/selection-box';
import type { Corner, PreviewEdit } from '../apps/web/src/editor/selection-box';
import { assets, build, fixture, itemOf, links, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeEach(() => useIds()); afterEach(() => resetIds());
const W = 1080, H = 1920;
type Pt = { x: number; y: number };
const P = (defaultValue: unknown, keyframes: unknown[] = []) => ({ defaultValue, keyframes });
const kf = (time: number, value: unknown, easing = 'linear') => ({ id: `k${time}`, time, value, easing });
/** An image item on `trackId` for 0..4000 ms with static properties (`extra.properties` merges over them). */
const box = (id: string, x: number, y: number, w: number, h: number, extra: RecordData = {}, trackId = 'V1') => {
  const { properties = {}, ...rest } = extra;
  return mkItem(id, trackId, 0, 4000, { type: 'image', trim: { from: 0, to: 4000 }, properties: { positionX: P(x), positionY: P(y), width: P(w), height: P(h), scale: P(1), rotation: P(0), ...properties }, ...rest });
};
const docOf = (items: RecordData[], tracks: RecordData[] = [mkTrack('V1', 'video')]): ProjectDocument => build({ tracks, items, extra: { size: { width: W, height: H } } });
const editor = (doc: ProjectDocument) => createEditor(doc, { assets: assets(), links: links() });
type Editor = ReturnType<typeof editor>;
const json = (d: unknown) => JSON.stringify(d);
const val = (doc: ProjectDocument, id: string, key: string) => itemOf(doc, id).properties[key].defaultValue;
const draft = (e: Editor, edits: PreviewEdit[], atMs = 1000) => e.intent({ type: 'transformOnPreview', edits, atMs });
/** The stored values a drag result writes, applied to a copy of the document (what the committed edit does for static properties). */
const applied = (doc: ProjectDocument, id: string, values: Record<string, number>) => { const d = structuredClone(doc); writeEdits(d, [{ itemId: id, values }], 1000); return d; };
/** Corner (sx, sy = ±1) of a turned box worked by hand: centre ± half the shown size along the item's own axes. */
const cornerAt = (x: number, y: number, w: number, h: number, s: number, rot: number, sx: number, sy: number): Pt => {
  const cw = w * s, ch = h * s, cx = x + cw / 2, cy = y + ch / 2, r = rot * Math.PI / 180;
  return { x: cx + Math.cos(r) * sx * cw / 2 - Math.sin(r) * sy * ch / 2, y: cy + Math.sin(r) * sx * cw / 2 + Math.cos(r) * sy * ch / 2 };
};
const near = (got: Pt, want: Pt, digits = 6) => { expect(got.x).toBeCloseTo(want.x, digits); expect(got.y).toBeCloseTo(want.y, digits); };
const SIGNS: Record<Corner, [number, number]> = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] };
const OPPOSITE: Record<Corner, Corner> = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' };

describe('row 1, 7.1 point 4: which items show the box (both ends of the time range count, lane A\'s Q8)', () => {
  it('every visual type shows it at the playhead; audio never, also when selected', () => {
    const types = ['video', 'image', 'text', 'shape', 'layout', 'motionGraphic', 'caption', 'audio'];
    const doc = docOf(types.map(type => mkItem(type, 'V1', 1000, 3000, { type })));
    expect(shownItems(doc, types, 2000).map(i => i.id)).toEqual(types.filter(t => t !== 'audio'));
  });
  it('Q8: display.from and display.to both show the box and are pickable; one ms either side does not', () => {
    const doc = docOf([box('a', 0, 0, 100, 100, { display: { from: 1000, to: 3000 } })]), a = doc.items[0], inside = { x: 50, y: 50 };
    for (const t of [1000, 2000, 3000]) { expect(atPlayhead(a, t), `t=${t}`).toBe(true); expect(shownItems(doc, ['a'], t)).toHaveLength(1); expect(pickAt(doc, t, inside, () => 255)?.id, `t=${t}`).toBe('a'); }
    for (const t of [999, 3001]) { expect(atPlayhead(a, t), `t=${t}`).toBe(false); expect(shownItems(doc, ['a'], t)).toEqual([]); expect(candidates(doc, t, inside)).toEqual([]); }
  });
  it('a selected item outside the playhead time shows no box; the item stays in the selection list given', () => {
    const doc = docOf([box('a', 0, 0, 100, 100, { display: { from: 0, to: 1000 } }), box('b', 0, 0, 100, 100)]);
    expect(shownItems(doc, ['a', 'b'], 2000).map(i => i.id)).toEqual(['b']);
  });
  it('item-local time is max(0, playhead - start); the box follows keyframes at that time', () => {
    const doc = docOf([box('a', 0, 0, 100, 100, { display: { from: 2000, to: 6000 }, properties: { positionX: P(0, [kf(0, 0), kf(1000, 100)]) } })]), a = doc.items[0];
    expect(itemLocal(a, 1000)).toBe(0); expect(itemLocal(a, 2500)).toBe(500);
    expect(frameOf(doc, a, 2500).cx).toBeCloseTo(50 + 50, 6); // x = 50 at 500 ms of 0 -> 100, centre = x + 100/2
    expect(frameOf(doc, a, 1000).cx).toBeCloseTo(0 + 50, 6);
  });
  it('row 14: a caption shows the same box, from its stored width, height, position and scale', () => {
    const doc = docOf([box('c', 50, 1500, 600, 120, { type: 'caption', properties: { scale: P(1.5) } })]);
    expect(frameOf(doc, doc.items[0], 1000)).toMatchObject({ cx: 50 + 900 / 2, cy: 1500 + 180 / 2, w: 900, h: 180, rotation: 0 });
    expect(shownItems(doc, ['c'], 1000)).toHaveLength(1);
  });
  it('row 14: a hidden track still shows the box, is picked and can be edited', () => {
    const doc = docOf([box('a', 0, 0, 200, 200)], [mkTrack('V1', 'video', { hidden: true })]);
    expect(shownItems(doc, ['a'], 1000)).toHaveLength(1); expect(pickAt(doc, 1000, { x: 10, y: 10 }, () => 255)?.id).toBe('a');
    const e = editor(doc); expect(draft(e, [{ itemId: 'a', values: { positionX: 40 } }])).toMatchObject({ ok: true }); expect(val(e.doc, 'a', 'positionX')).toBe(40);
  });
  it('the box is the item\'s turned frame: base size x |scale|, left = positionX, top = positionY, turned about its centre', () => {
    const doc = docOf([box('a', 100, 200, 400, 300, { properties: { scale: P(-0.5), rotation: P(90) } })]);
    expect(frameOf(doc, doc.items[0], 1000)).toMatchObject({ cx: 100 + 100, cy: 200 + 75, w: 200, h: 150, rotation: 90 });
  });
});

describe('row 1, row 6, 7.1 point 7: handles', () => {
  const doc = docOf([box('a', 100, 200, 400, 300)]), f = frameOf(doc, doc.items[0], 1000); // centre (300, 350)
  it('exactly 5 handles: 4 corners on the corners, the rotation handle 28 screen px above the middle of the top edge; no edge handle', () => {
    const h = handles(f, 0.5);
    expect(Object.keys(h).sort()).toEqual(['ne', 'nw', 'rotate', 'se', 'sw']);
    near(h.nw, { x: 100, y: 200 }); near(h.ne, { x: 500, y: 200 }); near(h.se, { x: 500, y: 500 }); near(h.sw, { x: 100, y: 500 });
    near(h.rotate, { x: 300, y: 200 - 28 / 0.5 }); // 28 screen px at zoom 0.5 = 56 canvas px
    for (const mid of [{ x: 300, y: 200 }, { x: 500, y: 350 }, { x: 300, y: 500 }, { x: 100, y: 350 }]) expect(handleAt(f, 0.5, mid), `edge midpoint ${json(mid)}`).toBeNull();
  });
  it('the rotation handle follows the turn: 90 degrees puts it 28 screen px right of the box', () => {
    const turned = docOf([box('a', 100, 200, 400, 300, { properties: { rotation: P(90) } })]), tf = frameOf(turned, turned.items[0], 1000);
    near(handles(tf, 1).rotate, { x: 300 + 150 + 28, y: 350 }); // turned 90: the top edge is the right edge (x = 450)
  });
  it('hit area is the circle\'s own 10 screen px square, no padding, and keeps its screen size at every zoom', () => {
    for (const zoom of [0.25, 0.5, 1, 3]) {
      const half = 5 / zoom, c = handles(f, zoom).se;
      expect(handleAt(f, zoom, { x: c.x + half * 0.95, y: c.y - half * 0.95 }), `inside at zoom ${zoom}`).toBe('se');
      expect(handleAt(f, zoom, { x: c.x + half * 1.05, y: c.y }), `outside at zoom ${zoom}`).toBeNull();
      expect(screenPx(10, zoom)).toBeCloseTo(10 / zoom, 9);
    }
    expect(screenPx(10, 0)).toBe(1000); // zoom is held at 0.01 or more
  });
  it('the rotation handle answers; a corner wins at its own position', () => {
    expect(handleAt(f, 0.5, handles(f, 0.5).rotate)).toBe('rotate'); expect(handleAt(f, 0.5, { x: 100, y: 200 })).toBe('nw');
  });
});

describe('row 2, 7.1 point 1: corner drag', () => {
  // W3-ED-15: a video of base 1280 x 534 on a 1080 x 1920 canvas, scale 0.84375 (shown 1080 x 450.5625), left edge on the canvas edge, centred in y
  // (positionY 734.71875). Fit zoom of the capture 366.7 / 1080. Each drag moves the bottom-right handle 40 screen px left, from the handle itself, y unchanged.
  const z = 366.7 / 1080, vid = () => docOf([box('v', 0, (H - 534 * 0.84375) / 2, 1280, 534, { type: 'video', properties: { scale: P(0.84375) } })]);
  const left40 = (d: ProjectDocument) => { const c = corners(frameOf(d, d.items[0], 1000)).se; return cornerDrag(d, d.items[0], 1000, 'se', { x: c.x - 40 / z, y: c.y }); };
  it('the two stored drags: scale 0.84375 -> 0.7517 -> 0.6597, position unchanged', () => {
    const d0 = vid(), r1 = left40(d0);
    expect(r1.scale).toBeCloseTo(0.7517, 3); expect(r1.positionX).toBeCloseTo(0, 6); expect(r1.positionY).toBeCloseTo(734.71875, 6);
    const d1 = applied(d0, 'v', r1), r2 = left40(d1);
    expect(r2.scale).toBeCloseTo(0.6597, 3); expect(r2.positionX).toBeCloseTo(0, 6); expect(r2.positionY).toBeCloseTo(734.71875, 6);
  });
  it('writes scale, positionX, positionY only; never width or height', () => {
    const d = vid(); expect(Object.keys(left40(d)).sort()).toEqual(['positionX', 'positionY', 'scale']);
  });
  // item 400 x 300 at (100, 200), scale 1: corners nw (100,200) ne (500,200) se (500,500) sw (100,500). The pointer at (300, 350) is half way along the diagonal.
  it.each([
    ['nw', 300, 350], ['ne', 100, 350], ['se', 100, 200], ['sw', 300, 200],
  ] as const)('%s handle: the opposite corner stays fixed; factor 0.5; positions %i, %i', (corner, px, py) => {
    const doc = docOf([box('a', 100, 200, 400, 300)]), r = cornerDrag(doc, doc.items[0], 1000, corner, { x: 300, y: 350 });
    expect(r.scale).toBeCloseTo(0.5, 9); expect(r.positionX).toBeCloseTo(px, 6); expect(r.positionY).toBeCloseTo(py, 6);
  });
  it('the factor is the smaller axis ratio: a pointer that moves out on one axis only does not make the item larger', () => {
    const doc = docOf([box('a', 100, 200, 400, 300)]), r = cornerDrag(doc, doc.items[0], 1000, 'se', { x: 100 + 800, y: 200 + 300 });
    expect(r.scale).toBeCloseTo(1, 9); expect(r.positionX).toBeCloseTo(100, 6); expect(r.positionY).toBeCloseTo(200, 6);
  });
  it('there is no upper limit and the factor multiplies the start scale (start 2, factor 3 -> 6)', () => {
    const doc = docOf([box('a', 0, 0, 100, 100, { properties: { scale: P(2) } })]); // shown 200 x 200
    expect(cornerDrag(doc, doc.items[0], 1000, 'se', { x: 600, y: 600 }).scale).toBeCloseTo(6, 9);
  });
  it('0.05 floor on the factor of one drag: a pointer at 30 px on a 1000 px item gives 0.05, not 0.03', () => {
    const doc = docOf([box('a', 0, 0, 1000, 1000)]);
    expect(cornerDrag(doc, doc.items[0], 1000, 'se', { x: 30, y: 30 }).scale).toBeCloseTo(0.05, 9);
  });
  it('0.05 is not the least stored scale: a second drag from 0.05 (shown 50 px) to 16 px stores 0.016', () => {
    const doc = docOf([box('a', 0, 0, 1000, 1000, { properties: { scale: P(0.05) } })]);
    expect(cornerDrag(doc, doc.items[0], 1000, 'se', { x: 16, y: 16 }).scale).toBeCloseTo(0.016, 9);
  });
  it('16 canvas px floor on each edge: a pointer past the fixed corner gives 16 / the longer start side (200 x 100 item -> 0.08)', () => {
    const doc = docOf([box('a', 100, 100, 200, 100)]), r = cornerDrag(doc, doc.items[0], 1000, 'se', { x: 0, y: 0 });
    expect(r.scale).toBeCloseTo(0.08, 9); expect(r.positionX).toBeCloseTo(100, 6); expect(r.positionY).toBeCloseTo(100, 6);
    // repeated drags stop when the longer shown side is 16 px: the stored video 1280 wide ends at scale 0.0125
    const v = docOf([box('v', 0, 0, 1280, 534, { type: 'video', properties: { scale: P(0.0125) } })]);
    expect(cornerDrag(v, v.items[0], 1000, 'se', { x: -50, y: -50 }).scale).toBeCloseTo(0.0125, 9); // shown 16 x 6.675: the 16 px floor gives factor 16 / 16 = 1, the scale stays
  });
  it.each([0, 30, 90, 217])('a turned item (%i degrees): the opposite corner stays fixed, every corner, a pointer on the diagonal lands exactly on it', rot => {
    const x = 100, y = 200, w = 400, h = 300, doc = docOf([box('a', x, y, w, h, { properties: { rotation: P(rot) } })]);
    for (const corner of Object.keys(SIGNS) as Corner[]) {
      const [sx, sy] = SIGNS[corner], [ox, oy] = SIGNS[OPPOSITE[corner]];
      const fixed = cornerAt(x, y, w, h, 1, rot, ox, oy), dragged = cornerAt(x, y, w, h, 1, rot, sx, sy);
      const p = { x: fixed.x + 0.6 * (dragged.x - fixed.x), y: fixed.y + 0.6 * (dragged.y - fixed.y) }, r = cornerDrag(doc, doc.items[0], 1000, corner, p);
      expect(r.scale, `${corner} @${rot}`).toBeCloseTo(0.6, 9);
      near(cornerAt(r.positionX, r.positionY, w, h, r.scale, rot, ox, oy), fixed); // the fixed corner did not move
      near(cornerAt(r.positionX, r.positionY, w, h, r.scale, rot, sx, sy), p); // the dragged corner is under the pointer
    }
  });
  it('a turned item measures the pointer along its own axes: moving 90 degrees along world x is the item\'s y axis', () => {
    // 400 x 300 at (100, 200) turned 90: centre (300, 350); se corner (150, 550), fixed nw (450, 150); the item's x axis points down, its y axis left.
    const doc = docOf([box('a', 100, 200, 400, 300, { properties: { rotation: P(90) } })]), r = cornerDrag(doc, doc.items[0], 1000, 'se', { x: 300, y: 350 });
    expect(r.scale).toBeCloseTo(0.5, 9); expect(r.positionX).toBeCloseTo(275, 6); expect(r.positionY).toBeCloseTo(175, 6); // new centre (375, 250), shown 200 x 150
  });
  it('the start scale is the value at the playhead, keyframes included (no jump at pointer down)', () => {
    const doc = docOf([box('a', 0, 0, 100, 100, { properties: { scale: P(1, [kf(0, 1), kf(1000, 2)]) } })]), c = corners(frameOf(doc, doc.items[0], 500)).se;
    expect(cornerDrag(doc, doc.items[0], 500, 'se', c).scale).toBeCloseTo(1.5, 9);
  });
  it('Q5: scale 1 with unequal scaleX / scaleY: the drag writes scale only and the shape changes on the first corner drag', () => {
    const doc = docOf([box('a', 0, 0, 100, 100, { properties: { scaleX: P(2), scaleY: P(1) } })]), f0 = frameOf(doc, doc.items[0], 1000);
    expect([f0.w, f0.h]).toEqual([200, 100]); // drawn with scaleX 2, scaleY 1
    const r = cornerDrag(doc, doc.items[0], 1000, 'se', { x: 100, y: 50 }); // half way
    expect(r.scale).toBeCloseTo(0.5, 9); expect(r.positionX).toBeCloseTo(0, 6); expect(r.positionY).toBeCloseTo(0, 6);
    const after = applied(doc, 'a', r), f1 = frameOf(after, itemOf(after, 'a'), 1000);
    expect([f1.w, f1.h]).toEqual([50, 50]); // scale now wins over scaleX / scaleY: 2:1 became 1:1
  });
});

describe('row 3, 7.1 point 2: rotation drag', () => {
  const at = (c: Pt, deg: number, r = 100): Pt => ({ x: c.x + r * Math.cos(deg * Math.PI / 180), y: c.y + r * Math.sin(deg * Math.PI / 180) });
  const rot = (start: number) => docOf([box('a', 100, 200, 400, 300, { properties: { rotation: P(start) } })]); // centre (300, 350)
  const c = { x: 300, y: 350 };
  it('writes rotation only: the start value plus the change of the pointer\'s angle about the centre', () => {
    const d = rot(20), r = rotationDrag(d, d.items[0], 1000, at(c, 10), at(c, 55));
    expect(Object.keys(r)).toEqual(['rotation']); expect(r.rotation).toBeCloseTo(65, 9);
  });
  it('no wrap: 350 + 30 stores 380 and 10 - 30 stores -20', () => {
    const a = rot(350), b = rot(10);
    expect(rotationDrag(a, a.items[0], 1000, at(c, 0), at(c, 30)).rotation).toBeCloseTo(380, 9);
    expect(rotationDrag(b, b.items[0], 1000, at(c, 0), at(c, -30)).rotation).toBeCloseTo(-20, 9);
  });
  it('no snap and no rounding: 0.123 degrees stays 0.123', () => {
    const d = rot(0); expect(rotationDrag(d, d.items[0], 1000, at(c, 0), at(c, 0.123)).rotation).toBeCloseTo(0.123, 9);
  });
  it('each angle is read in -180..180 and their difference is not wrapped: crossing the line left of the centre jumps by 360', () => {
    const d = rot(0); expect(rotationDrag(d, d.items[0], 1000, at(c, 170), at(c, -170)).rotation).toBeCloseTo(-340, 9);
  });
  it('the start value is the one at the playhead, keyframes included', () => {
    const d = docOf([box('a', 100, 200, 400, 300, { properties: { rotation: P(0, [kf(0, 0), kf(1000, 90)]) } })]);
    expect(rotationDrag(d, d.items[0], 500, at(c, 0), at(c, 0)).rotation).toBeCloseTo(45, 9);
  });
  it('the centre is the box centre of the shown size (position + shown / 2), whatever the turn', () => {
    const d = docOf([box('a', 0, 0, 100, 100, { properties: { scale: P(2), rotation: P(77) } })]); // centre (100, 100)
    expect(rotationDrag(d, d.items[0], 1000, at({ x: 100, y: 100 }, 0), at({ x: 100, y: 100 }, 90)).rotation).toBeCloseTo(77 + 90, 9);
  });
});

describe('row 10, 7.1 point 3: move and the centre snap', () => {
  it('every dragged item moves by the pointer movement, nothing rounded', () => {
    const doc = docOf([box('a', 10, 20, 100, 100), box('b', 300, 400, 100, 100)]), r = moveDrag(doc, ['a', 'b'], 1000, { x: 12.345678, y: -7.5 }, 1);
    expect(r.edits).toEqual([{ itemId: 'a', values: { positionX: 10 + 12.345678, positionY: 12.5 } }, { itemId: 'b', values: { positionX: 300 + 12.345678, positionY: 392.5 } }]);
    expect(r.snap).toEqual({ x: false, y: false });
  });
  it('the start values are the values at the playhead', () => {
    const doc = docOf([box('a', 0, 0, 100, 100, { properties: { positionX: P(0, [kf(0, 0), kf(1000, 100)]) } })]);
    expect(moveDrag(doc, ['a'], 500, { x: 5, y: 0 }, 1).edits[0].values.positionX).toBeCloseTo(55, 9);
  });
  // item 200 x 100 at (300, 500): centre (400, 550). Canvas centre (540, 960). Zoom 0.5: 8 screen px = 16 canvas px.
  it('the box centre snaps to the canvas centre on each axis on its own, within 8 screen px', () => {
    const doc = docOf([box('a', 300, 500, 200, 100)]);
    const x = moveDrag(doc, ['a'], 1000, { x: 130, y: 0 }, 0.5); // centre x 530, 10 px off: snaps
    expect(x.snap).toEqual({ x: true, y: false }); expect(x.edits[0].values).toEqual({ positionX: 440, positionY: 500 });
    const y = moveDrag(doc, ['a'], 1000, { x: 0, y: 400 }, 0.5); // centre y 950, 10 px off: snaps
    expect(y.snap).toEqual({ x: false, y: true }); expect(y.edits[0].values).toEqual({ positionX: 300, positionY: 910 });
    const both = moveDrag(doc, ['a'], 1000, { x: 135, y: 405 }, 0.5);
    expect(both.snap).toEqual({ x: true, y: true }); expect(both.edits[0].values).toEqual({ positionX: 440, positionY: 910 });
  });
  it('the 8 screen px are screen px: 15 canvas px snaps at zoom 0.5 (limit 16) and does not at zoom 1 (limit 8)', () => {
    const doc = docOf([box('a', 300, 500, 200, 100)]); // centre x 400; d.x 125 -> 525, 15 px off
    expect(moveDrag(doc, ['a'], 1000, { x: 125, y: 0 }, 0.5).snap.x).toBe(true); expect(moveDrag(doc, ['a'], 1000, { x: 125, y: 0 }, 1).snap.x).toBe(false);
    expect(moveDrag(doc, ['a'], 1000, { x: 123, y: 0 }, 1).snap.x).toBe(false); // 17 off at zoom 1 (limit 8)
  });
  it('the snap is worked out from the start position on every move: the item leaves the snap when the pointer goes on', () => {
    const doc = docOf([box('a', 300, 500, 200, 100)]);
    expect(moveDrag(doc, ['a'], 1000, { x: 140, y: 0 }, 1).snap.x).toBe(true); // centre 540 exactly
    const away = moveDrag(doc, ['a'], 1000, { x: 160, y: 0 }, 1); // 20 px past the centre: no snap, plain start + d
    expect(away.snap.x).toBe(false); expect(away.edits[0].values.positionX).toBe(460);
  });
  it('several items: the centre of their bounding box snaps, so they keep their offsets', () => {
    const doc = docOf([box('a', 0, 0, 100, 100), box('b', 200, 0, 100, 100)]); // bounds x 0..300, centre 150
    const r = moveDrag(doc, ['a', 'b'], 1000, { x: 395, y: 0 }, 1); // bounds centre 545: snaps to 540, shift 390
    expect(r.snap.x).toBe(true); expect(r.edits.map(e => e.values.positionX)).toEqual([390, 590]);
  });
  it('no snapping to canvas edges, other items or a grid', () => {
    const doc = docOf([box('a', 0, 0, 100, 100), box('b', 500, 500, 100, 100)]), r = moveDrag(doc, ['a'], 1000, { x: 499, y: 499 }, 1); // a lands on b's corner
    expect(r.snap).toEqual({ x: false, y: false }); expect(r.edits[0].values).toEqual({ positionX: 499, positionY: 499 });
    expect(moveDrag(doc, ['a'], 1000, { x: -3, y: -3 }, 1).edits[0].values).toEqual({ positionX: -3, positionY: -3 }); // next to the canvas edge
  });
  it('audio items are not moved', () => {
    const doc = docOf([box('a', 0, 0, 100, 100), mkItem('s', 'V1', 0, 4000, { type: 'audio' })]);
    expect(moveDrag(doc, ['a', 's'], 1000, { x: 1, y: 1 }, 1).edits.map(e => e.itemId)).toEqual(['a']);
  });
});

describe('row 11, 7.1 point 8: the pick, the marquee', () => {
  it('Q1 / 7.1: captions on top, then the tracks top to bottom; audio never', () => {
    const doc = fixture(), order = candidates(doc, 1500, { x: 10, y: 10 }).map(i => i.id);
    expect(order).toEqual(['c1', 't1', 'v1']); // C1 (caption) > O1 (text) > V1 (video); a1 is audio
  });
  it('Q1: on the same track the item drawn later is first; a higher zIndex goes before the draw order', () => {
    const early = box('early', 0, 0, 100, 100, { display: { from: 0, to: 4000 } }), late = box('late', 0, 0, 100, 100, { display: { from: 500, to: 4000 } });
    expect(candidates(docOf([early, late]), 1000, { x: 50, y: 50 }).map(i => i.id)).toEqual(['late', 'early']);
    expect(candidates(docOf([late, early]), 1000, { x: 50, y: 50 }).map(i => i.id), 'document order does not matter, the track\'s draw order does').toEqual(['late', 'early']);
    const z = box('early', 0, 0, 100, 100, { properties: { zIndex: P(5) } });
    expect(candidates(docOf([z, late]), 1000, { x: 50, y: 50 }).map(i => i.id)).toEqual(['early', 'late']);
  });
  it('a higher track beats a higher zIndex on a lower track', () => {
    const doc = docOf([box('low', 0, 0, 100, 100, { properties: { zIndex: P(9) } }, 'V1'), box('high', 0, 0, 100, 100, {}, 'V2')], [mkTrack('V1', 'video'), mkTrack('V2', 'video')]);
    expect(candidates(doc, 1000, { x: 50, y: 50 }).map(i => i.id)).toEqual(['high', 'low']);
  });
  it('a candidate holds the point in its turned box: inside the turned box, outside the unturned one, and the reverse', () => {
    const doc = docOf([box('a', 100, 200, 400, 300, { properties: { rotation: P(90) } })]); // turned box x 150..450, y 150..550
    expect(candidates(doc, 1000, { x: 160, y: 540 }).map(i => i.id)).toEqual(['a']); expect(candidates(doc, 1000, { x: 110, y: 210 })).toEqual([]);
    expect(contains(frameOf(doc, doc.items[0], 1000), { x: 300, y: 350 })).toBe(true);
  });
  it('Q6: the first candidate whose alpha is at least 32 wins; 31 fails, 32 passes, null (cannot be read) passes', () => {
    const doc = docOf([box('under', 0, 0, 100, 100, {}, 'V1'), box('over', 0, 0, 100, 100, {}, 'V2')], [mkTrack('V1', 'video'), mkTrack('V2', 'video')]), p = { x: 50, y: 50 };
    expect(PICK_ALPHA_MIN).toBe(32);
    const with_ = (a: number | null) => pickAt(doc, 1000, p, i => i.id === 'over' ? a : 255)?.id;
    expect(with_(31)).toBe('under'); expect(with_(32)).toBe('over'); expect(with_(null)).toBe('over'); expect(with_(255)).toBe('over'); expect(with_(0)).toBe('under');
  });
  it('Q6: every candidate failing the alpha test picks nothing; the read gets the item and the point, and only candidates are read', () => {
    const doc = docOf([box('a', 0, 0, 100, 100), box('far', 500, 500, 100, 100)]), calls: string[] = [];
    expect(pickAt(doc, 1000, { x: 50, y: 50 }, (i, p) => { calls.push(`${i.id}@${p.x},${p.y}`); return 0; })).toBeNull();
    expect(calls).toEqual(['a@50,50']);
  });
  it('a point on no item picks nothing', () => { expect(pickAt(docOf([box('a', 0, 0, 100, 100)]), 1000, { x: 500, y: 500 }, () => 255)).toBeNull(); });
  it('marquee: the items at the playhead whose box lies fully inside, in either corner order', () => {
    const doc = docOf([box('a', 10, 10, 100, 100), box('b', 200, 10, 100, 100), box('gone', 20, 20, 50, 50, { display: { from: 5000, to: 6000 } }), mkItem('s', 'V1', 0, 4000, { type: 'audio' })]);
    expect(marqueeHits(doc, 1000, { x: 0, y: 0 }, { x: 150, y: 150 })).toEqual(['a']);
    expect(marqueeHits(doc, 1000, { x: 150, y: 150 }, { x: 0, y: 0 })).toEqual(['a']);
    expect(marqueeHits(doc, 1000, { x: 0, y: 0 }, { x: 400, y: 150 })).toEqual(['a', 'b']);
  });
  it('marquee: an item only partly inside is not selected; a turned item counts by its turned corners', () => {
    const doc = docOf([box('a', 10, 10, 100, 100), box('t', 100, 200, 400, 300, { properties: { rotation: P(90) } })]); // t: turned box x 150..450, y 150..550
    expect(marqueeHits(doc, 1000, { x: 0, y: 0 }, { x: 105, y: 200 })).toEqual([]);
    expect(marqueeHits(doc, 1000, { x: 100, y: 100 }, { x: 460, y: 560 })).toEqual(['t']); // the unturned box (y 200..500) would fit in a smaller marquee
    expect(marqueeHits(doc, 1000, { x: 100, y: 190 }, { x: 460, y: 510 })).toEqual([]); // fits the unturned box, not the turned one
  });
});

describe('row 12, 7.1 point 4, lane A\'s A1: the group box and the edge case', () => {
  it('two or more shown items: one plain, unturned box around all of them (the turned corners bound it)', () => {
    const doc = docOf([box('a', 10, 20, 100, 100), box('t', 100, 200, 400, 300, { properties: { rotation: P(90) } })]), shown = shownItems(doc, ['a', 't'], 1000);
    const b = boundsOf(shown.map(i => frameOf(doc, i, 1000))); // x 10..450, y 20..550
    for (const [k, v] of Object.entries({ x: 10, y: 20, w: 440, h: 530 })) expect(b[k as 'x'], k).toBeCloseTo(v, 6);
  });
  it('A1: 2 selected, 1 at the playhead: 1 item is shown (the handles are drawn for it)', () => {
    const doc = docOf([box('a', 0, 0, 100, 100), box('b', 200, 0, 100, 100, { display: { from: 3000, to: 4000 } })]);
    expect(shownItems(doc, ['a', 'b'], 1000).map(i => i.id)).toEqual(['a']);
  });
});

describe('rows 4 and 5, 7.1 points 5 and 6: the write through the intent', () => {
  const two = () => docOf([box('a', 100, 200, 400, 300), box('b', 600, 700, 100, 100)]);
  it('row 4: one drag is one history step "Edit items"; undo restores the items', () => {
    const e = editor(two()), before = json(e.doc.items);
    expect(draft(e, [{ itemId: 'a', values: { positionX: 120.5, positionY: 210, scale: 0.5 } }, { itemId: 'b', values: { positionX: 610 } }])).toMatchObject({ ok: true });
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label: 'Edit items', source: 'user' });
    expect(val(e.doc, 'a', 'positionX')).toBe(120.5); expect(val(e.doc, 'a', 'scale')).toBe(0.5); expect(val(e.doc, 'b', 'positionX')).toBe(610);
    e.intent({ type: 'undo' }); expect(json(e.doc.items)).toBe(before); expect(e.bus.undoStack).toHaveLength(0);
  });
  it('row 4: a drag that ends on its start values makes no step; an empty edit list makes none', () => {
    const e = editor(two()), before = json(e.doc);
    draft(e, [{ itemId: 'a', values: { positionX: 100, positionY: 200, scale: 1, rotation: 0 } }]); expect(e.bus.undoStack).toHaveLength(0);
    draft(e, []); expect(e.bus.undoStack).toHaveLength(0); expect(json(e.doc)).toBe(before);
  });
  it('row 4: a drag that ends on its start values with keyframes makes no step (the value at the playhead is the start value)', () => {
    const e = editor(docOf([box('a', 0, 0, 100, 100, { properties: { positionX: P(0, [kf(0, 0), kf(1000, 100)]) } })])), before = json(e.doc);
    draft(e, [{ itemId: 'a', values: { positionX: 50 } }], 500); expect(e.bus.undoStack).toHaveLength(0); expect(json(e.doc)).toBe(before);
  });
  it('row 5: with no keyframes and a rotation in 0..360 the stored values equal a transformItem call with the same numbers', () => {
    const doc = () => docOf([box('im', 100, 200, 400, 300, { properties: { rotation: P(30) } })]), a = editor(doc()), b = editor(doc());
    draft(a, [{ itemId: 'im', values: { positionX: 40, positionY: 80, scale: 0.75, rotation: 200 } }]);
    expect(b.call('transformItem', { itemId: 'im', x: 40, y: 80, scale: 0.75, rotation: 200 })).toMatchObject({ success: true });
    expect(itemOf(a.doc, 'im').properties).toEqual(itemOf(b.doc, 'im').properties);
    expect(a.bus.undoStack[0].label).toBe(b.bus.undoStack[0].label); // both "Edit items"
  });
  it('row 5: a property with keyframes gets the keyframe and keeps its base value; the other properties stay static', () => {
    const e = editor(docOf([box('a', 5, 6, 100, 100, { trim: { from: 0, to: 4000 }, properties: { positionX: P(5, [kf(0, 1), kf(3000, 9)]) } })]));
    draft(e, [{ itemId: 'a', values: { positionX: 77, positionY: 66 } }], 2000);
    const p = itemOf(e.doc, 'a').properties;
    expect(p.positionX.defaultValue).toBe(5); expect(p.positionX.keyframes).toHaveLength(3);
    expect(p.positionX.keyframes.find((k: RecordData) => k.time === 2000)).toMatchObject({ value: 77, easing: 'linear' });
    expect(p.positionY.defaultValue).toBe(66); expect(p.positionY.keyframes).toEqual([]);
  });
  describe('7.1 point 6: the 100 ms window, on the item\'s playhead time', () => {
    const keyed = () => docOf([box('a', 0, 0, 100, 100, { display: { from: 2000, to: 6000 }, trim: { from: 500, to: 4500 }, properties: { positionX: P(5, [kf(1000, 10), kf(3000, 30)]) } })]);
    // property time = trim.from 500 + (t - display.from 2000) = t - 1500; the keyframes sit at 1000 and 3000.
    it.each([[2550, 1050], [2600, 1100], [2400, 900]])('t %i (property time %i): within 100 ms (100 itself counts) of the keyframe at 1000 -> replaced, its time stays', t => {
      const doc = keyed(); writeEdits(doc, [{ itemId: 'a', values: { positionX: 99 } }], t);
      const k = itemOf(doc, 'a').properties.positionX.keyframes; expect(k).toHaveLength(2); expect(k.find((x: RecordData) => x.id === 'k1000')).toMatchObject({ time: 1000, value: 99 });
    });
    it.each([[2601, 1101], [2399, 899], [3400, 1900]])('t %i (property time %i): outside 100 ms -> a new keyframe at that time with easing "linear"', (t, at) => {
      const doc = keyed(); writeEdits(doc, [{ itemId: 'a', values: { positionX: 99 } }], t);
      const k = itemOf(doc, 'a').properties.positionX.keyframes; expect(k).toHaveLength(3);
      expect(k.find((x: RecordData) => x.value === 99)).toMatchObject({ time: at, value: 99, easing: 'linear' }); expect(itemOf(doc, 'a').properties.positionX.defaultValue).toBe(5);
      expect(k.filter((x: RecordData) => x.value !== 99).map((x: RecordData) => x.value)).toEqual([10, 30]);
    });
  });
});

describe('row 13 and lane A\'s A2: locked tracks', () => {
  const locked = () => docOf([box('a', 100, 200, 400, 300, {}, 'V1'), box('b', 600, 700, 100, 100, {}, 'V2')], [mkTrack('V1', 'video'), mkTrack('V2', 'video', { locked: true })]);
  it('row 13: the drag is refused with TRACK_LOCKED, the item keeps its start values, no history entry', () => {
    const e = editor(docOf([box('a', 100, 200, 400, 300)], [mkTrack('V1', 'video', { locked: true })])), before = json(e.doc);
    expect(draft(e, [{ itemId: 'a', values: { positionX: 150, scale: 0.5 } }])).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0);
  });
  it('the box still shows on a locked track', () => {
    const doc = locked(); expect(shownItems(doc, ['b'], 1000)).toHaveLength(1);
  });
  it('A2: a move of several items where one is on a locked track is refused whole, whichever comes first, and every item is back', () => {
    for (const edits of [['a', 'b'], ['b', 'a']]) {
      const e = editor(locked()), before = json(e.doc);
      expect(draft(e, edits.map(itemId => ({ itemId, values: { positionX: 1, positionY: 2 } })))).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
      expect(json(e.doc), edits.join()).toBe(before); expect(e.bus.undoStack).toHaveLength(0);
    }
  });
  it('a track in a locked group counts as locked', () => {
    const doc = docOf([box('a', 0, 0, 100, 100)]); doc.groups = { g1: { id: 'g1', name: 'G', children: [{ type: 'track', id: 'V1' }], hidden: false, locked: true } as any };
    doc.layerOrder = [{ type: 'group', id: 'g1' }]; const e = editor(doc);
    expect(draft(e, [{ itemId: 'a', values: { positionX: 9 } }])).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
  });
});
