// SPDX-License-Identifier: AGPL-3.0-only
// T06 shape geometry, shared by shape items and T12's shape masks (findings part 5 §54.2, §54.8 7.2; contracts addShape,
// writeShapePoints "Point validation"; W3-RT-08): the six presets, a path as anchors with handles (item-local px; a handle is
// an offset from its anchor), its string and bounds, the point validator, path keyframes and the stored shape record. Pure:
// only the matrix type comes from the render model, so render/model.ts can import pathAt without a cycle.
import type { RecordData } from '../store/model';
import type { Mat } from '../render/model';
import { fail } from './model';
import { segmentEase, storedProperties } from './properties';
import type { Easing, Handle, Keyframe } from './properties';

export type Pt = { x: number; y: number };
export type PathPoint = { anchor: Pt; handleIn?: Pt; handleOut?: Pt };
export type ShapePath = { points: PathPoint[]; closed: boolean };
/** A path keyframe (§54.8 7.2): time on the property axis (ms), the path string as `value`, its points and closed flag. */
export type PathKeyframe = { id: string; time: number; value: string; points: PathPoint[]; closed: boolean; easing: Easing; inHandle?: Handle; outHandle?: Handle };
export type Bounds = { x: number; y: number; width: number; height: number };

export const SHAPE_TYPES = ['rectangle', 'ellipse', 'triangle', 'pentagon', 'star', 'heart'] as const;
export type ShapeType = typeof SHAPE_TYPES[number];
export const HANDLES = ['handleIn', 'handleOut'] as const;
/** §54.2 1.2: coordinates rounded to 0.01 (+ 0 turns −0 into 0). */
export const r2 = (v: number) => Math.round(v * 100) / 100 + 0;
const pt = (x: number, y: number): Pt => ({ x, y });
const plus = (a: Pt, b: Pt) => pt(a.x + b.x, a.y + b.y);
const minus = (a: Pt, b: Pt) => pt(a.x - b.x, a.y - b.y);
const times = (a: Pt, k: number) => pt(a.x * k, a.y * k);
const unit = (a: Pt) => { const l = Math.hypot(a.x, a.y); return l > 0 ? times(a, 1 / l) : pt(0, 0); };

// ---- §54.2 1.5 presets, in a w × h box (origin its top-left), clockwise on screen.
/** Ellipse handle length per unit radius. */
export const KAPPA = 0.5522847498;
/** Pentagon and star are regular, R = min(w, h) / 2 about the box centre with the first vertex up, so they keep their own
 *  aspect; the star alternates R and innerRatio · R. roundness 0–100 rounds rectangle, triangle, pentagon and star corners;
 *  ellipse and heart ignore it. */
export function presetPoints(type: ShapeType, w: number, h: number, roundness = 0, innerRatio = 0.4): PathPoint[] {
  const a = w / 2, b = h / 2, R = Math.min(w, h) / 2;
  const ring = (n: number, r: (k: number) => number) => Array.from({ length: n }, (_, k) => {
    const t = (-90 + 360 / n * k) * Math.PI / 180;
    return pt(a + r(k) * Math.cos(t), b + r(k) * Math.sin(t));
  });
  const corners = type === 'rectangle' ? [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)] : type === 'triangle' ? [pt(a, 0), pt(w, h), pt(0, h)]
    : type === 'pentagon' ? ring(5, () => R) : type === 'star' ? ring(10, k => k % 2 ? innerRatio * R : R) : null;
  if (corners) return roundness > 0 ? rounded(corners, roundness / 100) : corners.map(anchor => ({ anchor }));
  if (type === 'ellipse') {
    const kx = KAPPA * a, ky = KAPPA * b;
    return [
      { anchor: pt(w, b), handleIn: pt(0, -ky), handleOut: pt(0, ky) },
      { anchor: pt(a, h), handleIn: pt(kx, 0), handleOut: pt(-kx, 0) },
      { anchor: pt(0, b), handleIn: pt(0, ky), handleOut: pt(0, -ky) },
      { anchor: pt(a, 0), handleIn: pt(-kx, 0), handleOut: pt(kx, 0) },
    ];
  }
  // Heart: anchors and handles as fractions of the half extents about the centre (bounds w × 0.9 h).
  const at = (x: number, y: number) => pt(a + x * a, b + y * b), off = (x: number, y: number) => pt(x * a, y * b);
  return [
    { anchor: at(0, 1), handleIn: off(0.4, -0.2), handleOut: off(-0.4, -0.2) },
    { anchor: at(-1, -0.2), handleIn: off(0, 0.6), handleOut: off(0, -0.4) },
    { anchor: at(-0.5, -0.8), handleIn: off(-0.3, 0), handleOut: off(0.2, 0) },
    { anchor: at(0, -0.4), handleIn: off(-0.15, -0.2), handleOut: off(0.15, -0.2) },
    { anchor: at(0.5, -0.8), handleIn: off(-0.2, 0), handleOut: off(0.3, 0) },
    { anchor: at(1, -0.2), handleIn: off(0, -0.4), handleOut: off(0, 0.6) },
  ];
}
/** Corner rounding (r = roundness / 100): each corner P becomes two anchors 0.45 · r of the way along its edges, each with
 *  one handle toward P of length 0.55 × the shorter of the two distances. */
function rounded(c: Pt[], r: number): PathPoint[] {
  return c.flatMap((P, i) => {
    const A = c[(i + c.length - 1) % c.length], B = c[(i + 1) % c.length];
    const pin = plus(P, times(minus(A, P), 0.45 * r)), pout = plus(P, times(minus(B, P), 0.45 * r));
    const L = 0.55 * Math.min(Math.hypot(pin.x - P.x, pin.y - P.y), Math.hypot(pout.x - P.x, pout.y - P.y));
    return [{ anchor: pin, handleOut: times(unit(minus(P, pin)), L) }, { anchor: pout, handleIn: times(unit(minus(P, pout)), L) }];
  });
}

// ---- §54.2 1.2 the path: a segment is a cubic when the previous point has an out-handle or this one an in-handle, else a
// line; a closed path of 3+ points adds the closing segment by the same rule.
export type Segment = { from: Pt; to: Pt; c1?: Pt; c2?: Pt };
export function segments({ points, closed }: ShapePath): Segment[] {
  const seg = (p: PathPoint, q: PathPoint): Segment => p.handleOut || q.handleIn
    ? { from: p.anchor, c1: plus(p.anchor, p.handleOut ?? pt(0, 0)), c2: plus(q.anchor, q.handleIn ?? pt(0, 0)), to: q.anchor } : { from: p.anchor, to: q.anchor };
  const out = points.slice(1).map((q, i) => seg(points[i], q));
  if (closed && points.length >= 3) out.push(seg(points[points.length - 1], points[0]));
  return out;
}
const num = (v: number) => String(r2(v));
const xy = (p: Pt) => `${num(p.x)},${num(p.y)}`;
/** "M x,y L … C x1,y1 x2,y2 x,y Z", 2 decimals; a straight closing segment is the Z alone. No points: ""; one point: the
 *  r 3 circle as two arcs. */
export function pathString(path: ShapePath): string {
  const { points } = path;
  if (!points.length) return '';
  if (points.length === 1) { const { x, y } = points[0].anchor; return `M ${xy(pt(x - 3, y))} A 3,3 0 1,0 ${xy(pt(x + 3, y))} A 3,3 0 1,0 ${xy(pt(x - 3, y))} Z`; }
  const segs = segments(path), closing = path.closed && points.length >= 3 ? segs.pop()! : null;
  const draw = (s: Segment) => s.c1 ? `C ${xy(s.c1)} ${xy(s.c2!)} ${xy(s.to)}` : `L ${xy(s.to)}`;
  return [`M ${xy(points[0].anchor)}`, ...segs.map(draw), ...closing ? [...closing.c1 ? [draw(closing)] : [], 'Z'] : []].join(' ');
}
/** One axis of a cubic's interior extrema (roots of the derivative in (0, 1)). */
function extrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  let ts: number[];
  if (Math.abs(a) < 1e-12) ts = Math.abs(b) < 1e-12 ? [] : [-c / b];
  else { const d = b * b - 4 * a * c; ts = d < 0 ? [] : [(-b + Math.sqrt(d)) / (2 * a), (-b - Math.sqrt(d)) / (2 * a)]; }
  return ts.filter(t => t > 0 && t < 1).map(t => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; });
}
/** The drawn path's bounds (anchors plus curve extrema); one point: the r 3 circle; none, or a non-finite value: null. */
export function pathBounds(path: ShapePath): Bounds | null {
  const { points } = path;
  if (!points.length) return null;
  const xs: number[] = [], ys: number[] = [];
  if (points.length === 1) { const { x, y } = points[0].anchor; xs.push(x - 3, x + 3); ys.push(y - 3, y + 3); }
  else {
    xs.push(points[0].anchor.x); ys.push(points[0].anchor.y);
    for (const s of segments(path)) {
      xs.push(s.to.x); ys.push(s.to.y);
      if (s.c1) { xs.push(...extrema(s.from.x, s.c1.x, s.c2!.x, s.to.x)); ys.push(...extrema(s.from.y, s.c1.y, s.c2!.y, s.to.y)); }
    }
  }
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
/** Points moved by (dx, dy) and rounded to 0.01 (handles are offsets: rounded only). */
export const shifted = (points: PathPoint[], dx: number, dy: number): PathPoint[] => points.map(p => ({
  anchor: pt(r2(p.anchor.x + dx), r2(p.anchor.y + dy)), ...Object.fromEntries(HANDLES.filter(h => p[h]).map(h => [h, pt(r2(p[h]!.x), r2(p[h]!.y))])),
}));

// ---- Item-local ↔ canvas: anchors through the whole box matrix, handles (offsets) through its linear part.
export function mapPoints(m: Mat, points: PathPoint[]): PathPoint[] {
  const at = (p: Pt) => pt(m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]), lin = (p: Pt) => pt(m[0] * p.x + m[2] * p.y, m[1] * p.x + m[3] * p.y);
  return points.map(p => ({ anchor: at(p.anchor), ...Object.fromEntries(HANDLES.filter(h => p[h]).map(h => [h, lin(p[h]!)])) }));
}
export function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

// ---- Point validation (contracts "Point validation", Xapp build BPc88dS2): every coordinate a finite number; the first bad
// point stops the call. A new point needs an anchor with x and y; an update may give one axis of a stored anchor or handle;
// a handle given as null is removed, a new handle needs both axes. Points are named by their index (an update by pointIndex).
const isObj = (v: unknown): v is RecordData => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const RULE = {
  anchor: 'needs finite canvas x and y numbers. An update may give one axis; a new point gives both.',
  handle: 'needs finite x and y numbers (an offset from its anchor), or null to remove it. A new handle gives both axes.',
};
const badCoordinates = (message: string): never => fail('INVALID_POINT_COORDINATES', 'Invalid point coordinates', { message });
/** One anchor or handle: the given axes over `base` (the stored value, canvas px). */
function axes(v: unknown, base: Pt | undefined, n: number, part: 'anchor' | 'handleIn' | 'handleOut'): Pt {
  const said = `Point ${n}'s ${part} ${part === 'anchor' ? RULE.anchor : RULE.handle}`;
  if (!isObj(v) || (v.x === undefined && v.y === undefined)) return badCoordinates(said);
  const x = v.x === undefined ? base?.x : v.x, y = v.y === undefined ? base?.y : v.y;
  if (!finite(x) || !finite(y)) return badCoordinates(said);
  return pt(x, y);
}
/** A new point (add[] entry, custom path point) in canvas px. INVALID_POINT without an anchor x and y. */
export function newPoint(p: unknown, i: number): PathPoint {
  if (!isObj(p) || !isObj(p.anchor) || p.anchor.x === undefined || p.anchor.y === undefined)
    fail('INVALID_POINT', 'Invalid point', { message: `Point at index ${i} must have an anchor with x and y coordinates.` });
  const out: PathPoint = { anchor: axes(p.anchor, undefined, i, 'anchor') };
  for (const h of HANDLES) if (p[h] !== undefined && p[h] !== null) out[h] = axes(p[h], undefined, i, h);
  return out;
}
/** An update {pointIndex, anchor?, handleIn?, handleOut?} merged onto the stored point; both in canvas px. */
export function updatedPoint(stored: PathPoint, u: RecordData, n: number): PathPoint {
  if (u.anchor === undefined && u.handleIn === undefined && u.handleOut === undefined) badCoordinates(`Point ${n} gives no anchor, handleIn or handleOut to change.`);
  const out: PathPoint = { ...stored };
  if (u.anchor !== undefined) out.anchor = axes(u.anchor, stored.anchor, n, 'anchor');
  for (const h of HANDLES) {
    if (u[h] === null) delete out[h];
    else if (u[h] !== undefined) out[h] = axes(u[h], stored[h], n, h);
  }
  return out;
}

// ---- §54.8 7.2 path keyframes. A holder is a shape's details (or a mask): {points, closed, keyframes.path.keyframes[]}.
export const pathKeyframes = (holder: RecordData | undefined): PathKeyframe[] =>
  Array.isArray(holder?.keyframes?.path?.keyframes) ? [...holder!.keyframes.path.keyframes].sort((a: PathKeyframe, b: PathKeyframe) => a.time - b.time) : [];
export const basePath = (holder: RecordData | undefined): ShapePath => ({ points: Array.isArray(holder?.points) ? holder!.points : [], closed: holder?.closed !== false });
const pathOf = (k: PathKeyframe): ShapePath => ({ points: Array.isArray(k.points) ? k.points : [], closed: k.closed !== false });
/** The path at property time t (ms). With keyframes they win over the base path: the first before it, the last after it, a
 *  keyframe exactly on it; a gap of 50 ms or less takes the nearer keyframe (a tie: A); otherwise e = A→B's easing at p:
 *  equal point counts lerp anchors and handles (a one-sided handle is kept, A's closed flag), else a hard switch at e ≥ 0.5. */
export function pathAt(holder: RecordData | undefined, t: number): ShapePath {
  const k = pathKeyframes(holder);
  if (!k.length) return basePath(holder);
  const last = k[k.length - 1];
  if (t <= k[0].time) return pathOf(k[0]);
  if (t >= last.time) return pathOf(last);
  const i = k.findIndex(f => f.time > t), A = k[i - 1], B = k[i];
  if (t === A.time) return pathOf(A);
  if (B.time - A.time <= 50) return pathOf(t - A.time <= B.time - t ? A : B);
  const e = segmentEase(A as unknown as Keyframe, B as unknown as Keyframe, (t - A.time) / (B.time - A.time)), pa = pathOf(A), pb = pathOf(B);
  if (pa.points.length !== pb.points.length) return e >= 0.5 ? pb : pa;
  const lerp = (p: Pt, q: Pt) => pt(p.x + (q.x - p.x) * e, p.y + (q.y - p.y) * e);
  return { closed: pa.closed, points: pa.points.map((p, n) => {
    const q = pb.points[n], out: PathPoint = { anchor: lerp(p.anchor, q.anchor) };
    for (const h of HANDLES) { const u = p[h], v = q[h]; if (u || v) out[h] = u && v ? lerp(u, v) : (u ?? v)!; }
    return out;
  }) };
}

// ---- The stored shape item (W3-RT-08): name "Shape <type>", details {src "", path, points, closed, width, height}, the box
// and style as stored properties, metadata.shapeType.
export const SHAPE_STYLE = { fillColor: '#3b82f6', fillOpacity: 1, strokeColor: 'none', strokeWidth: 0, strokeOpacity: 1 };
export type ShapeSpec = { id: string; trackId: string; display: { from: number; to: number }; shapeType: string; points: PathPoint[]; closed: boolean;
  x: number; y: number; width: number; height: number; style: Record<string, unknown> };
export const shapeRecord = (s: ShapeSpec): RecordData => ({
  name: `Shape ${s.shapeType}`, id: s.id, type: 'shape', trackId: s.trackId, display: s.display,
  details: { src: '', path: pathString(s), points: s.points, closed: s.closed, width: s.width, height: s.height },
  properties: storedProperties({ positionX: s.x, positionY: s.y, width: s.width, height: s.height, opacity: 1, scale: 1, rotation: 0, ...SHAPE_STYLE, ...s.style }),
  metadata: { shapeType: s.shapeType },
});
/** A path fitted to its bounds: points relative to the bounds' top-left (rounded), and those bounds (unrounded). null when
 *  the bounds are not finite or have no width or height (NO_SHAPE_PATH_BOUNDS for the caller). */
export function fitted(path: ShapePath): { points: PathPoint[]; box: Bounds } | null {
  const b = pathBounds(path);
  if (!b || !(b.width > 0) || !(b.height > 0)) return null;
  return { points: shifted(path.points, -b.x, -b.y), box: b };
}
