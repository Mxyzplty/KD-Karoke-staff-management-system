// SPDX-License-Identifier: AGPL-3.0-only
// T26 preview selection box, the pure part (research 7.1 points 1 to 8; D90): the turned box of an item at the playhead, its
// four corner handles and rotation handle, the corner, rotation and move drags with the centre snap, the click pick, the marquee
// and the write (keyframe rule, locked track). Canvas px, y down. No DOM: selection-overlay.tsx reads the pointer and the alpha.
import type { ProjectDocument, RecordData } from '../store/model';
import { apply, boxMatrix, field, fpsOf, itemBox, projectSize, trackItems } from '../render/model';
import type { Box } from '../render/model';
import { frameMasks, masksOf } from '../masks/model';
import type { FrameMask } from '../masks/model';
import { ensureProp, keyframeId, prop, propertyTime, setStatic } from '../timeline/properties';
import { fail, item as itemOf, stack, trackLocked } from '../timeline/model';
import { invert } from '../timeline/shapes';
import type { Pt, ShapePath } from '../timeline/shapes';

/** 7.1 point 7 (screen px unless named), point 1 (canvas px, factor), point 3, point 6 (ms), point 8. */
export const HANDLE_PX = 10, ROTATE_GAP_PX = 28, LINE_PX = 1.5, SNAP_PX = 8, MIN_EDGE = 16, MIN_FACTOR = 0.05, MARQUEE_MIN = 2, KEYFRAME_WINDOW_MS = 100;
/** Author's ruling e (12 Nov; §54.10 point 8): with a raster mask, the mask test passes when the combined alpha is above 4 of 255. */
export const PICK_ALPHA_ABOVE = 4;
export type Corner = 'nw' | 'ne' | 'se' | 'sw';
export type Handle = Corner | 'rotate';
export type TransformKey = 'positionX' | 'positionY' | 'scale' | 'rotation';
export type PreviewEdit = { itemId: string; values: Partial<Record<TransformKey, number>> };
/** The turned box: centre, shown size (base size × |scale|), rotation in degrees. */
export type Frame = { cx: number; cy: number; w: number; h: number; rotation: number };
export type Rect = { x: number; y: number; w: number; h: number };
/** (item, canvas point) → the item's combined mask alpha there, 0 to 255; null when it cannot be read. */
export type AlphaAt = (item: RecordData, p: Pt) => number | null;
/** (bare mask path in item px, item-local point) → inside it, by the canvas fill rule. */
export type InsidePath = (path: ShapePath, p: Pt) => boolean;
/** The two reads of the mask test; selection-overlay.tsx passes the real ones, tests pass stubs. */
export type MaskReads = { alpha: AlphaAt; inside: InsidePath };

const SIGN: Record<Corner, [number, number]> = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] };
const DEFAULT: Record<TransformKey, number> = { positionX: 0, positionY: 0, scale: 1, rotation: 0 };
/** A size in screen px as canvas px at this zoom (screen px per canvas px). */
export const screenPx = (px: number, zoom: number) => px / Math.max(zoom, 0.01);
/** 7.1's playhead time of an item, item-local: max(0, playhead − start); properties are read at its property time. */
export const itemLocal = (item: RecordData, t: number) => Math.max(0, t - item.display.from);
/** 7.1 point 4: not audio, and the time range holds the playhead with both ends counted (lane A's Q8). */
export const atPlayhead = (item: RecordData, t: number) => item.type !== 'audio' && item.display.from <= t && t <= item.display.to;
export const valueOf = (item: RecordData, key: TransformKey, t: number) => Number(field(item, key, itemLocal(item, t), DEFAULT[key]));

const axes = (rotation: number) => { const r = rotation * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return { ux: { x: c, y: s }, uy: { x: -s, y: c } }; };
const frameFrom = (b: Box): Frame => { const w = Math.abs(b.W * b.sx), h = Math.abs(b.H * b.sy); return { cx: b.x + w / 2, cy: b.y + h / 2, w, h, rotation: b.rotation }; };
/** The box drawn from itemBox (lane A's Q5: scale ≠ 1 wins over scaleX / scaleY), so it sits on the drawn item. */
export const frameOf = (doc: ProjectDocument, item: RecordData, t: number) => frameFrom(itemBox(doc, item, itemLocal(item, t)));
const point = (f: Frame, sx: number, sy: number): Pt => { const { ux, uy } = axes(f.rotation); return { x: f.cx + ux.x * sx * f.w / 2 + uy.x * sy * f.h / 2, y: f.cy + ux.y * sx * f.w / 2 + uy.y * sy * f.h / 2 }; };
export const corners = (f: Frame): Record<Corner, Pt> => ({ nw: point(f, -1, -1), ne: point(f, 1, -1), se: point(f, 1, 1), sw: point(f, -1, 1) });
/** The 5 handle centres: the corners, and the rotation handle 28 screen px above the middle of the top edge. */
export function handles(f: Frame, zoom: number): Record<Handle, Pt> {
  const top = point(f, 0, -1), { uy } = axes(f.rotation), gap = screenPx(ROTATE_GAP_PX, zoom);
  return { ...corners(f), rotate: { x: top.x - uy.x * gap, y: top.y - uy.y * gap } };
}
/** 7.1 point 7: the handle's own 10 screen px square, no padding. */
export function handleAt(f: Frame, zoom: number, p: Pt): Handle | null {
  const half = screenPx(HANDLE_PX, zoom) / 2, all = handles(f, zoom);
  return (Object.keys(all) as Handle[]).find(k => Math.abs(p.x - all[k].x) <= half && Math.abs(p.y - all[k].y) <= half) ?? null;
}
export function contains(f: Frame, p: Pt): boolean {
  const { ux, uy } = axes(f.rotation), dx = p.x - f.cx, dy = p.y - f.cy;
  return Math.abs(dx * ux.x + dy * ux.y) <= f.w / 2 && Math.abs(dx * uy.x + dy * uy.y) <= f.h / 2;
}
/** The plain box around several turned boxes (axis-aligned, not turned). */
export function boundsOf(frames: Frame[]): Rect {
  const ps = frames.flatMap(f => Object.values(corners(f))), xs = ps.map(p => p.x), ys = ps.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
/** The selected items that show the box (7.1 point 4); 1 gets the turned box and handles, 2 or more one plain box. */
export const shownItems = (doc: ProjectDocument, selection: string[], t: number) => doc.items.filter(i => selection.includes(i.id) && atPlayhead(i, t));

// ---- Drags. Each starts again from the start document on every pointer move, so one drag adds at most 1 keyframe per property.
/** 7.1 point 1: the opposite corner stays fixed; one factor h = max(0.05, min(e_x / w0, e_y / h0)), e_x, e_y ≥ 16, in the item's
 *  turned axes. The new position comes from the change in size, so a fixed edge keeps its exact stored value. */
export function cornerDrag(doc: ProjectDocument, item: RecordData, t: number, corner: Corner, p: Pt): Record<'scale' | 'positionX' | 'positionY', number> {
  const local = itemLocal(item, t), b = itemBox(doc, item, local), f = frameFrom(b), [sx, sy] = SIGN[corner], { ux, uy } = axes(f.rotation);
  const o = point(f, -sx, -sy), dx = p.x - o.x, dy = p.y - o.y;
  const ex = Math.max(MIN_EDGE, sx * (dx * ux.x + dy * ux.y)), ey = Math.max(MIN_EDGE, sy * (dx * uy.x + dy * uy.y));
  const scale = valueOf(item, 'scale', t) * Math.max(MIN_FACTOR, Math.min(ex / f.w, ey / f.h));
  // The new box as itemBox will draw it: an item with scale 1 and unequal scaleX, scaleY changes shape here (lane A's Q5).
  const w = Math.abs(b.W * (scale !== 1 ? scale : Number(field(item, 'scaleX', local, 1)))), h = Math.abs(b.H * (scale !== 1 ? scale : Number(field(item, 'scaleY', local, 1))));
  const dw = w - f.w, dh = h - f.h, ax = sx * dw / 2, ay = sy * dh / 2;
  return { scale, positionX: b.x + ax * ux.x + ay * uy.x - dw / 2, positionY: b.y + ax * ux.y + ay * uy.y - dh / 2 };
}
const angle = (p: Pt, c: Pt) => Math.atan2(p.y - c.y, p.x - c.x) * 180 / Math.PI;
/** 7.1 point 2: start + the change of the pointer's angle about the centre at press, each angle in −180 to 180, not wrapped. */
export function rotationDrag(doc: ProjectDocument, item: RecordData, t: number, from: Pt, p: Pt): { rotation: number } {
  const f = frameOf(doc, item, t), c = { x: f.cx, y: f.cy };
  return { rotation: valueOf(item, 'rotation', t) + (angle(p, c) - angle(from, c)) };
}
/** 7.1 point 3: every item moves by the pointer's movement d (canvas px); the centre of their bounding box snaps to the canvas
 *  centre, each axis on its own, within 8 screen px. */
export function moveDrag(doc: ProjectDocument, ids: string[], t: number, d: Pt, zoom: number): { edits: PreviewEdit[]; snap: { x: boolean; y: boolean } } {
  const items = ids.map(id => itemOf(doc, id)).filter((i): i is RecordData => !!i && i.type !== 'audio');
  if (!items.length) return { edits: [], snap: { x: false, y: false } };
  const b = boundsOf(items.map(i => frameOf(doc, i, t))), { width, height } = projectSize(doc), limit = screenPx(SNAP_PX, zoom);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, x = Math.abs(cx + d.x - width / 2) <= limit, y = Math.abs(cy + d.y - height / 2) <= limit;
  const dx = x ? width / 2 - cx : d.x, dy = y ? height / 2 - cy : d.y;
  return { edits: items.map(i => ({ itemId: i.id, values: { positionX: valueOf(i, 'positionX', t) + dx, positionY: valueOf(i, 'positionY', t) + dy } })), snap: { x, y } };
}

// ---- 7.1 point 8: the click pick and the marquee.
/** Items at the playhead whose turned box holds p, in pick order: the higher track first (layerOrder is bottom-first), then the
 *  higher zIndex, then the item drawn later (lane A's Q1). Hidden and locked tracks count (row 14, row 13). */
export function candidates(doc: ProjectDocument, t: number, p: Pt): RecordData[] {
  const order = stack(doc).reverse(), rank = (i: RecordData) => { const n = order.indexOf(i.trackId); return n < 0 ? order.length : n; };
  const z = (i: RecordData) => Number(field(i, 'zIndex', itemLocal(i, t), 0)) || 0, drawn = (i: RecordData) => trackItems(doc, i.trackId).indexOf(i);
  return doc.items.filter(i => atPlayhead(i, t) && contains(frameOf(doc, i, t), p)).sort((a, b) => rank(a) - rank(b) || z(b) - z(a) || drawn(b) - drawn(a));
}
/** Findings part 5 §54.10 point 8, vector-only items: one boolean per mask, in frameMasks' order (enabled, by `order`); feather
 *  and expansion are ignored (the bare path). A mask with opacity < 50 is dropped before the first-mask rule, and one with 50 to
 *  100 counts as fully opaque: both lane A's reading of l.898, confirmed by Author. Then §54.5 and §54.6 as booleans (the boolean
 *  reading of each mode is lane A's, confirmed by Author, O6): invert, Subtract negates, the first mask is acc, then add OR, subtract and
 *  intersect AND, difference XOR. null: no mask left. */
export function vectorHit(masks: FrameMask[], p: Pt, inside: InsidePath): boolean | null {
  let acc: boolean | null = null;
  for (const m of masks) {
    if (m.opacity < 0.5) continue;
    const g = (!!m.path && inside(m.path, p)) !== m.inverted, b = m.mode === 'subtract' ? !g : g;
    acc = acc === null ? b : m.mode === 'add' ? acc || b : m.mode === 'difference' ? acc !== b : acc && b;
  }
  return acc;
}
/** 7.1 point 8's mask test (§54.10 point 8, Author's ruling e and his answer of 13 Nov on l.746). Only video and image items carry
 *  masks (render/model.ts). The masks that count are frameMasks' (§54.6 5.1): none left, the item passes. The rule comes from the
 *  stored list: any raster mask, in range or not (disabled too: lane A's reading, for Author), means the combined alpha of the
 *  masks that count, a hit above 4 of 255, null passes. No raster stored: the booleans. */
export function maskHit(doc: ProjectDocument, item: RecordData, t: number, p: Pt, reads: MaskReads): boolean {
  if (item.type !== 'video' && item.type !== 'image') return true;
  const local = itemLocal(item, t), masks = frameMasks(item, local, fpsOf(doc));
  if (!masks.length) return true;
  if (masksOf(item).some(m => m && m.raster)) { const a = reads.alpha(item, p); return a === null || a > PICK_ALPHA_ABOVE; }
  const inv = invert(boxMatrix(itemBox(doc, item, local)));
  if (!inv) return true;
  const [x, y] = apply(inv, p.x, p.y);
  return vectorHit(masks, { x, y }, reads.inside) ?? true;
}
/** The first candidate that passes the mask test. */
export const pickAt = (doc: ProjectDocument, t: number, p: Pt, reads: MaskReads): RecordData | null =>
  candidates(doc, t, p).find(i => maskHit(doc, i, t, p, reads)) ?? null;
/** The items at the playhead whose turned box lies fully inside the marquee from a to b. */
export function marqueeHits(doc: ProjectDocument, t: number, a: Pt, b: Pt): string[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return doc.items.filter(i => atPlayhead(i, t) && Object.values(corners(frameOf(doc, i, t))).every(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)).map(i => i.id);
}

// ---- The write (7.1 points 5 and 6). One function for the live draft and the committed edit.
/** Per property: a value equal to the one at the playhead is not written (a drag that ends on its start values makes no step);
 *  no keyframes: the static value, as transformItem; keyframes: the one within 100 ms of the item's playhead time (property
 *  time) takes the value and keeps its time, else one is added there with easing "linear". The base value stays. */
export function writeEdits(doc: ProjectDocument, edits: PreviewEdit[], t: number) {
  for (const { itemId, values } of edits) {
    const i = itemOf(doc, itemId);
    if (!i) fail('ITEM_NOT_FOUND', 'Item not found', { message: `Item '${itemId}' not found on timeline.` });
    const at = propertyTime(i, itemLocal(i, t));
    for (const [key, value] of Object.entries(values) as [TransformKey, number][]) {
      if (value === valueOf(i, key, t)) continue;
      if (!prop(i, key)?.keyframes.length) { setStatic(i, key, value); continue; }
      const list = ensureProp(i, key).keyframes;
      let near: (typeof list)[number] | undefined;
      for (const k of list) if (Math.abs(k.time - at) <= KEYFRAME_WINDOW_MS && (!near || Math.abs(k.time - at) < Math.abs(near.time - at))) near = k;
      if (near) list[list.indexOf(near)] = { ...near, value }; else list.push({ id: keyframeId(), time: at, value, easing: 'linear' });
    }
  }
}
/** The committed edit (intent transformOnPreview, "Edit items"): an item on a locked track refuses the whole edit with
 *  TRACK_LOCKED, as transformItem does (timeline/items.ts), so every item goes back (lane A's A2). */
export function applyPreviewEdit(doc: ProjectDocument, edits: PreviewEdit[], t: number) {
  for (const { itemId } of edits) {
    const i = itemOf(doc, itemId);
    if (i && trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
  }
  writeEdits(doc, edits, t);
}
