// SPDX-License-Identifier: AGPL-3.0-only
// T12 masks, the pure part (findings part 5 §54): the stored mask, what one frame needs from it (§54.6 5.1, §54.8) and the
// alpha algebra on 8-bit planes (§54.5, §54.6 5.2), with the raster placement and frame lookup (§54.6 5.3). masks/render.ts
// fills the planes. One implementation for preview, capture and export, canvas-path semantics for every mask (§54.12): a
// round offset and a canvas blur also when a raster is present, so adding a smart mask never changes the manual masks.
import type { RecordData } from '../store/model';
import { easingCurve, evaluate, propertyTime, sourceTime } from '../timeline/properties';
import type { Keyframe } from '../timeline/properties';
import { parsePath, pathAt, pathKeyframes } from '../timeline/shapes';
import type { PathKeyframe, PathPoint, ShapePath } from '../timeline/shapes';

export const MASK_MODES = ['add', 'subtract', 'intersect', 'difference'] as const;
export type MaskMode = typeof MASK_MODES[number];
export const MASK_KEYS = ['feather', 'expansion', 'opacity'] as const;
export type MaskKey = typeof MASK_KEYS[number];
/** Stored ranges: the editor and the tools clamp to these; the render does not (§54.3, §54.4, §54.8 7.3). */
export const MASK_RANGE: Record<MaskKey, { min: number; max: number }> = { feather: { min: 0, max: 50 }, expansion: { min: -50, max: 50 }, opacity: { min: 0, max: 100 } };
export const clampMask = (key: MaskKey, v: number) => Math.min(MASK_RANGE[key].max, Math.max(MASK_RANGE[key].min, v));
/** The frames of a raster mask (§54.6 5.3): 8-bit alpha planes in the mask store under `file`, one per source frame. */
export type RasterSpace = { kind: 'item' | 'source'; width: number; height: number };
export type RasterRef = { file: string; sourceStartUs: number; sourceEndUs: number; frameCount: number; width: number; height: number; space: RasterSpace; version: number; edgeSampling?: 'clamp' };
export type StoredMask = {
  id: string; name: string; enabled: boolean; points: PathPoint[]; closed: boolean; mode: MaskMode; order: number; colorIndex: number;
  feather: number; expansion: number; opacity: number; inverted: boolean; source: 'shape' | 'freehand' | 'smart';
  keyframes?: { path?: { keyframes: PathKeyframe[] } } & Partial<Record<MaskKey, { keyframes: Keyframe[] }>>;
  raster?: RasterRef; selectionMode?: 'auto-foreground'; purpose?: 'background-removal';
  /** Read from old projects, never written: §54.9 8.3's tracker rate, §54.8 7.4's frame-based fields. */
  smartMask?: { sourceFps?: number }; pathKeyframes?: { frame: number; path: string; easing?: unknown }[]; propertyKeyframes?: Partial<Record<MaskKey, { frame: number; value: number; easing?: unknown }[]>>;
};
/** One mask at one frame: what the render needs, nothing else. `plane` is the exact raster frame, set by readyMasks for export and capture. */
export type FrameMask = { id: string; mode: MaskMode; inverted: boolean; opacity: number; feather: number; expansion: number; path: ShapePath | null; raster: { ref: RasterRef; timeUs: number; plane?: Uint8Array } | null };

export const masksOf = (item: RecordData): StoredMask[] => Array.isArray(item.masks) ? item.masks : [];
/** The value at property time t; a mask with no keyframes of `key` falls back on §54.8 7.4's `propertyKeyframes` at the integer frame:
 *  eased lerp, named easings only. */
function value(m: StoredMask, key: MaskKey, t: number, frame: number) {
  const list = m.keyframes?.[key]?.keyframes?.length ? undefined : m.propertyKeyframes?.[key];
  if (Array.isArray(list) && list.length) return Number(evaluate(list.map(k => ({ id: '', time: k.frame, value: k.value, easing: typeof k.easing === 'string' ? k.easing : 'linear' })), m[key], frame));
  return Number(evaluate(m.keyframes?.[key]?.keyframes, m[key], t));
}
/** §54.8 7.4's `pathKeyframes` at the integer frame, when `keyframes.path` has none: held outside them, A until the eased progress
 *  reaches 0.5, then B; keyframes one frame apart hold A. */
function legacyPath(m: StoredMask, frame: number): ShapePath | null {
  const list = Array.isArray(m.pathKeyframes) ? [...m.pathKeyframes].sort((a, b) => a.frame - b.frame) : [];
  if (!list.length) return null;
  const at = list.findIndex(k => k.frame > frame);
  if (at <= 0) return parsePath(list[at < 0 ? list.length - 1 : 0].path);
  const A = list[at - 1], B = list[at], late = B.frame - A.frame > 1 && easingCurve(A.easing)((frame - A.frame) / (B.frame - A.frame)) >= 0.5;
  return parsePath((late ? B : A).path);
}
/** §54.8 7.3: h as a fraction, clamped where it is used. */
const fraction = (opacity: number) => Math.min(1, Math.max(0, opacity / 100));
/** §54.6 5.1: enabled, by `order`; a raster outside [sourceStartUs, sourceEndUs) is dropped, as is a legacy vector "smart" mask
 *  outside its first-to-last path keyframe span (§54.9 8.3), read at times floored to its tracker's rate. "First" in the combine means
 *  first after this filter. `fps` is the document's, for the integer frame of the legacy frame-based fields (§54.8 7.4). */
export function frameMasks(item: RecordData, local: number, fps = 30): FrameMask[] {
  const t = propertyTime(item, local), source = sourceTime(item, local), us = Math.round(source * 1000), frame = Math.floor(local * fps / 1000);
  return masksOf(item).filter(m => m && m.enabled !== false).map((m, n) => ({ m, n })).sort((a, b) => a.m.order - b.m.order || a.n - b.n).flatMap(({ m }): FrameMask[] => {
    if (m.raster && (us < m.raster.sourceStartUs || us >= m.raster.sourceEndUs)) return [];
    const keys = pathKeyframes(m as unknown as RecordData), legacy = !m.raster && m.source === 'smart' && keys.length > 0;
    const rate = legacy ? m.smartMask?.sourceFps ?? 0 : 0, floored = (ms: number) => rate > 0 ? Math.floor(ms * rate / 1000) * 1000 / rate : ms, shown = floored(source), p = floored(t);
    if (legacy && (shown < keys[0].time || shown > keys[keys.length - 1].time)) return [];
    return [{ id: m.id, mode: MASK_MODES.includes(m.mode) ? m.mode : 'add', inverted: !!m.inverted, opacity: fraction(value(m, 'opacity', p, frame)), feather: value(m, 'feather', p, frame), expansion: value(m, 'expansion', p, frame),
      path: m.raster ? null : (keys.length ? null : legacyPath(m, frame)) ?? pathAt(m as unknown as RecordData, legacy ? shown : t), raster: m.raster ? { ref: m.raster, timeUs: us } : null }];
  });
}

// ---- §54.5, §54.6 5.2 on 8-bit planes, rounded after every step. g is one mask's coverage after expansion and feather.
/** b from g: invert, opacity, and for Subtract 1 − b (the first mask too: a lone Subtract is a hole). Writes into `out`. */
export function layerValue(g: Uint8ClampedArray, m: Pick<FrameMask, 'inverted' | 'opacity' | 'mode'>, out: Uint8ClampedArray) {
  const table = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) { const b = Math.round((m.inverted ? 255 - v : v) * m.opacity); table[v] = m.mode === 'subtract' ? 255 - b : b; }
  for (let i = 0; i < g.length; i++) out[i] = table[g[i]];
}
/** acc ← mode(acc, b); `b` already holds Subtract's 1 − h·g. */
export function combineInto(acc: Uint8ClampedArray, b: Uint8ClampedArray, mode: MaskMode) {
  const n = acc.length, div = 1 / 255;
  if (mode === 'add') for (let i = 0; i < n; i++) acc[i] = acc[i] + b[i] * (255 - acc[i]) * div + 0.5 | 0;
  else if (mode === 'difference') for (let i = 0; i < n; i++) acc[i] = (acc[i] * (255 - b[i]) + b[i] * (255 - acc[i])) * div + 0.5 | 0;
  else for (let i = 0; i < n; i++) acc[i] = acc[i] * b[i] * div + 0.5 | 0;
}

// ---- §54.6 5.3 raster frames and placement.
/** The last frame with timeUs ≤ t (hold); the time is clamped to the first frame. */
export function frameIndex(timesUs: ArrayLike<number>, t: number): number {
  let lo = 0, hi = timesUs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (timesUs[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}
/** Raster px per item px: scale and offset of the raster in the item box. "item" stretches the raster over the box; "source"
 *  cover-fits the source space, like the video itself. */
export function placement(raster: Pick<RasterRef, 'width' | 'height' | 'space'>, W: number, H: number) {
  const { space, width, height } = raster;
  if (space.kind === 'item') return { sx: W / width, sy: H / height, ox: 0, oy: 0 };
  const s = Math.max(W / space.width, H / space.height);
  return { sx: space.width * s / width, sy: space.height * s / height, ox: (W - space.width * s) / 2, oy: (H - space.height * s) / 2 };
}
/** The raster resampled to W × H: each buffer pixel centre mapped back into raster px, minus 0.5, then bilinear; outside the
 *  raster reads 0, or the edge texel when `clamp`. */
export function resample(plane: Uint8Array, raster: Pick<RasterRef, 'width' | 'height' | 'space' | 'edgeSampling'>, W: number, H: number, out: Uint8ClampedArray = new Uint8ClampedArray(W * H)): Uint8ClampedArray {
  const { width: w, height: h } = raster, { sx, sy, ox, oy } = placement(raster, W, H), clamp = raster.edgeSampling === 'clamp';
  if (sx === 1 && sy === 1 && ox === 0 && oy === 0 && w === W && h === H) { out.set(plane); return out; }
  const at = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) { if (!clamp) return 0; x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y)); }
    return plane[y * w + x];
  };
  for (let Y = 0, k = 0; Y < H; Y++) {
    const fy = (Y + 0.5 - oy) / sy - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    for (let X = 0; X < W; X++, k++) {
      const fx = (X + 0.5 - ox) / sx - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      out[k] = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty + 0.5 | 0;
    }
  }
  return out;
}
/** Expansion of a coverage plane by a Euclidean offset (§54.12's round offset, for a raster: its canvas path is a stroke of the
 *  outline): the distance to the nearest pixel across the 50 % edge (exact transform, Felzenszwalb), a 1 px ramp on the new edge.
 *  Outside the plane is 0, as outside a raster (§54.6 5.3), so erosion also starts at its border; `clamp` repeats the edge there.
 *  A pixel kept by erosion keeps its own coverage, scaled by the ramp: a resampled edge is partly covered, and shrinking never adds coverage. */
export function offsetPlane(g: Uint8ClampedArray, W: number, H: number, e: number, clamp = false): Uint8ClampedArray {
  if (!(e < 0) || clamp) return offset(g, W, H, e);
  const wide = new Uint8ClampedArray((W + 2) * (H + 2)), out = new Uint8ClampedArray(W * H), row = (y: number) => (y + 1) * (W + 2) + 1;
  for (let y = 0; y < H; y++) wide.set(g.subarray(y * W, (y + 1) * W), row(y));
  const eroded = offset(wide, W + 2, H + 2, e);
  for (let y = 0; y < H; y++) out.set(eroded.subarray(row(y), row(y) + W), y * W);
  return out;
}
function offset(g: Uint8ClampedArray, W: number, H: number, e: number): Uint8ClampedArray {
  const grow = e > 0, r = Math.abs(e), INF = 1e20, dist = new Float64Array(W * H);
  for (let i = 0; i < dist.length; i++) dist[i] = (g[i] >= 128) === grow ? 0 : INF;
  const n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len: number, get: (k: number) => number, set: (k: number, x: number) => void) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let x = 0; x < W; x++) pass(H, y => dist[y * W + x], (y, o) => { dist[y * W + x] = o; });
  for (let y = 0; y < H; y++) pass(W, x => dist[y * W + x], (x, o) => { dist[y * W + x] = o; });
  const out = new Uint8ClampedArray(W * H);
  for (let i = 0; i < out.length; i++) {
    const inside = dist[i] === 0, reach = inside ? 1 : Math.min(1, Math.max(0, r + 1 - Math.sqrt(dist[i])));
    out[i] = (grow ? inside || reach > 0 ? Math.max(g[i], reach * 255) : g[i] : g[i] >= 128 ? g[i] * (1 - reach) : 0) + 0.5 | 0;
  }
  return out;
}
