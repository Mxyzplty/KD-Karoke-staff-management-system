// SPDX-License-Identifier: AGPL-3.0-only
// Masks of findings part 5 §54 on the CPU. Buffers are W × H item-local px, row 0 = top, y down,
// one alpha value 0…1 per pixel. Both Xapp implementations are here: 'canvas' (vector masks only:
// round offset, canvas blur) and 'gpu' (any raster mask on the item: square morphology, separable
// Gaussian). Every step is stored back to 8 bit, as both Xapp paths do (§54.6 5.2); on the GPU path a mask's
// layer value b = h·g is a float inside the combine step.
import { keyframed, keyList, linear, type Ease, type Keyframe } from './item';
import { q8 } from './blend';
import type { Image } from './image';

export type Pt = [number, number];
export type SubPath = { pts: Pt[]; closed: boolean };
export type XY = { x: number; y: number };
export type MaskPoint = { anchor: XY; handleIn?: XY; handleOut?: XY };
export type AlphaPlane = { width: number; height: number; data: Float32Array };
export type Impl = 'canvas' | 'gpu';
export type RasterSpace = { kind: 'item' | 'source'; width: number; height: number };

// ---- non-zero fill with exact area anti-aliasing: a pixel's coverage = the area of its unit square where the
// winding number ≠ 0. Each pixel row is cut into slabs at edge ends and edge crossings; inside a slab the edge order
// is fixed, so the region is a set of x intervals between straight boundary edges, integrated exactly in x and y.
const CURVE = 64, ROUND = 128;
// Mean of clamp(u, 0, 1) while u runs linearly from p to q (exact: the clamp is linear between its kinks).
function clampMean(p: number, q: number): number {
  const lo = Math.min(p, q), hi = Math.max(p, q);
  if (hi - lo < 1e-12) return Math.min(Math.max((lo + hi) / 2, 0), 1);
  const a = Math.max(lo, 0), b = Math.min(hi, 1);
  return ((b > a ? (b - a) * (b + a) / 2 : 0) + Math.max(hi - Math.max(lo, 1), 0)) / (hi - lo);
}
// One boundary edge over a slab of height h, x from xa (slab top) to xb (slab bottom): adds sign · h · the mean
// width of [px, px + 1] left of the edge. Pixels wholly left of it get sign · h through `run` (summed from the right).
function edgeArea(row: Float64Array, run: Float64Array, W: number, xa: number, xb: number, h: number, sign: number) {
  const lo = Math.floor(Math.min(xa, xb)), hi = Math.ceil(Math.max(xa, xb));
  if (lo > 0) run[Math.min(lo, W)] += sign * h;
  for (let px = Math.max(lo, 0); px < Math.min(hi, W); px++) row[px] += sign * h * clampMean(xa - px, xb - px);
}
export function fillCoverage(rings: Pt[][], W: number, H: number): Float32Array {
  const out = new Float32Array(W * H), edges: number[][] = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
    if (y0 !== y1) edges.push(y0 < y1 ? [x0, y0, x1, y1, 1] : [x1, y1, x0, y0, -1]);
  }
  edges.sort((a, b) => a[1] - b[1]);
  if (!edges.length) return out;
  const top = Math.max(0, Math.floor(edges[0][1])), bottom = Math.min(H, Math.ceil(edges.reduce((m, e) => Math.max(m, e[3]), -Infinity)));
  const xAt = (e: number[], y: number) => e[0] + (y - e[1]) * (e[2] - e[0]) / (e[3] - e[1]);
  const row = new Float64Array(W), run = new Float64Array(W + 1);
  let next = 0, active: number[][] = [];
  for (let y = top; y < bottom; y++) {
    while (next < edges.length && edges[next][1] < y + 1) active.push(edges[next++]);
    active = active.filter(e => e[3] > y);
    const cuts = [y, y + 1];
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e[1] > y) cuts.push(e[1]);
      if (e[3] < y + 1) cuts.push(e[3]);
      for (let j = i + 1; j < active.length; j++) {
        const f = active[j], ya = Math.max(y, e[1], f[1]), yb = Math.min(y + 1, e[3], f[3]);
        if (ya >= yb) continue;
        const da = xAt(e, ya) - xAt(f, ya), db = xAt(e, yb) - xAt(f, yb);
        if (da * db < 0) cuts.push(ya + (yb - ya) * da / (da - db));
      }
    }
    cuts.sort((a, b) => a - b);
    row.fill(0); run.fill(0);
    for (let k = 1; k < cuts.length; k++) {
      const ya = cuts[k - 1], yb = cuts[k], ym = (ya + yb) / 2;
      if (!(yb > ya)) continue;
      const xs = active.filter(e => e[1] < ym && e[3] > ym).map(e => [xAt(e, ym), xAt(e, ya), xAt(e, yb), e[4]]).sort((a, b) => a[0] - b[0]);
      let w = 0;
      for (const [, xa, xb, d] of xs) {
        const was = w;
        w += d;
        if (was === 0) edgeArea(row, run, W, xa, xb, yb - ya, -1); // region starts: left boundary
        else if (w === 0) edgeArea(row, run, W, xa, xb, yb - ya, 1); // region ends: right boundary
      }
    }
    for (let px = W - 1, c = 0; px >= 0; px--) { c += run[px + 1]; out[y * W + px] = Math.min(Math.max(row[px] + c, 0), 1); }
  }
  return out;
}

// ---- §54.2 path from points (anchors absolute, handles offsets), coordinates rounded to 0.01 px.
const r2 = (v: number) => Math.round(v * 100) / 100;
const at = (p: XY, h?: XY): Pt => [r2(p.x + (h?.x ?? 0)), r2(p.y + (h?.y ?? 0))];
export function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n = CURVE): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]] as Pt;
  });
}
export const circle = (c: Pt, r: number, n = ROUND): Pt[] => Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos(2 * Math.PI * i / n), c[1] + r * Math.sin(2 * Math.PI * i / n)] as Pt);
export function buildPath(points: MaskPoint[], closed = true): SubPath[] {
  if (!points.length) return [];
  if (points.length === 1) return [{ pts: circle(at(points[0].anchor), 3), closed: true }];
  const pts: Pt[] = [at(points[0].anchor)];
  const seg = (p: MaskPoint, q: MaskPoint) => pts.push(...(p.handleOut || q.handleIn ? cubic(at(p.anchor), at(p.anchor, p.handleOut), at(q.anchor, q.handleIn), at(q.anchor)) : [at(q.anchor)]));
  for (let i = 1; i < points.length; i++) seg(points[i - 1], points[i]);
  const close = closed && points.length >= 3;
  if (close) { seg(points[points.length - 1], points[0]); pts.pop(); }
  return [{ pts, closed: close }];
}
// A stored path string (absolute M, L, C, Z only), for path keyframes that carry no points.
export function parsePath(d: string): SubPath[] {
  const tok = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [], out: SubPath[] = [];
  let i = 0, cmd = '';
  const num = () => Number(tok[i++]), pt = (): Pt => [num(), num()], cur = () => out[out.length - 1].pts;
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    if (cmd === 'M') { out.push({ pts: [pt()], closed: false }); cmd = 'L'; }
    else if (cmd === 'L') cur().push(pt());
    else if (cmd === 'C') { const p0 = cur()[cur().length - 1]; cur().push(...cubic(p0, pt(), pt(), pt())); }
    else if (cmd === 'Z') { out[out.length - 1].closed = true; cmd = ''; }
    else throw Error(`path command "${cmd}" not supported`);
  }
  return out;
}

// ---- §54.3 expansion.
const area = (r: Pt[]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
const positive = (r: Pt[]) => area(r) < 0 ? r.reverse() : r;
// The region a stroke of width 2r with round joins and caps covers, as same-winding rings (non-zero fill = union).
export function strokeRings(paths: SubPath[], r: number): Pt[][] {
  const rings: Pt[][] = [];
  for (const { pts, closed } of paths) {
    const n = pts.length;
    for (const p of pts) rings.push(positive(circle(p, r)));
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!l) continue;
      const nx = -(b[1] - a[1]) / l * r, ny = (b[0] - a[0]) / l * r;
      rings.push(positive([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]));
    }
  }
  return rings;
}
// Canvas path (2.1): fill, then the path stroked at width 2|e| (round joins/caps) is drawn over (e > 0) or erased (e < 0).
export function expandCanvas(paths: SubPath[], g: Float32Array, e: number, W: number, H: number): Float32Array {
  const s = fillCoverage(strokeRings(paths, Math.abs(e)), W, H).map(q8);
  return g.map((a, i) => q8(e > 0 ? a + s[i] * (1 - a) : a * (1 - s[i])));
}
// GPU path (2.2): square-window max (grow) or min (shrink), horizontal then vertical, outside reads 0,
// fractional radius = lerp between windows n and n + 1 (applied in each pass).
export function expandGpu(g: Float32Array, e: number, W: number, H: number): Float32Array {
  const r = Math.abs(e), n = Math.floor(r), f = r - n, grow = e > 0;
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(W * H), len = horizontal ? W : H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const pos = horizontal ? x : y, read = (k: number) => k < 0 || k >= len ? 0 : src[horizontal ? y * W + k : k * W + x];
      const win = (m: number) => { let v = grow ? 0 : 1; for (let k = -m; k <= m; k++) v = grow ? Math.max(v, read(pos + k)) : Math.min(v, read(pos + k)); return v; };
      const a = win(n);
      out[y * W + x] = q8(f > 0 ? a + (win(n + 1) - a) * f : a);
    }
    return out;
  };
  return pass(pass(g, true), false);
}

// ---- §54.4 feather: separable Gaussian, σ = feather px, taps −R…R with R = ceil(3σ), weights
// exp(−i²/2σ²) normalised by the sum of all taps; outside reads 0. GPU: 8-bit between passes.
export function gaussian(g: Float32Array, W: number, H: number, sigma: number, between8bit: boolean): Float32Array {
  const R = Math.ceil(3 * sigma), w = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (2 * sigma * sigma)));
  const sum = w.reduce((a, b) => a + b, 0);
  const pass = (src: Float32Array, horizontal: boolean, quant: boolean) => {
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = -R; k <= R; k++) {
        const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H) v += w[k + R] * src[yy * W + xx];
      }
      out[y * W + x] = quant ? q8(v / sum) : v / sum;
    }
    return out;
  };
  return pass(pass(g, true, between8bit), false, true);
}

// ---- §54.6 5.3 raster masks.
export const sourceUs = (ms: number) => Math.round(ms * 1000);
const rasterField = (mask: any, key: string) => mask.raster?.[key] ?? mask[key];
// A raster mask without a finite source range under either placement throws instead of being dropped (review N2).
export function rasterActive(mask: any, us: number) {
  const start = rasterField(mask, 'sourceStartUs'), end = rasterField(mask, 'sourceEndUs');
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw Error(`raster mask ${mask.id ?? ''}: sourceStartUs / sourceEndUs missing or not finite (on the mask or mask.raster)`);
  return start <= us && us < end;
}
// The last stored frame with timeUs ≤ the source time (hold, no blending).
export function pickRasterFrame(timesUs: number[], us: number): number {
  let k = 0;
  for (let i = 0; i < timesUs.length; i++) if (timesUs[i] <= us) k = i;
  return k;
}
export function rasterPlacement(space: RasterSpace, rw: number, rh: number, W: number, H: number) {
  if (space.kind === 'source') {
    const s = Math.max(W / space.width, H / space.height);
    return { s, sx: space.width * s / rw, sy: space.height * s / rh, ox: (W - space.width * s) / 2, oy: (H - space.height * s) / 2 };
  }
  return { s: 1, sx: W / rw, sy: H / rh, ox: 0, oy: 0 };
}
// Each buffer pixel centre mapped back into raster px, minus 0.5, sampled bilinearly; outside reads 0 unless 'clamp'.
export function rasterCoverage(plane: AlphaPlane, space: RasterSpace, W: number, H: number, edgeSampling?: string): Float32Array {
  const p = rasterPlacement(space, plane.width, plane.height, W, H), out = new Float32Array(W * H), clampEdge = edgeSampling === 'clamp';
  const tex = (x: number, y: number) => {
    if (clampEdge) { x = Math.min(Math.max(x, 0), plane.width - 1); y = Math.min(Math.max(y, 0), plane.height - 1); }
    else if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) return 0;
    return plane.data[y * plane.width + x];
  };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const fx = (i + 0.5 - p.ox) / p.sx - 0.5, fy = (j + 0.5 - p.oy) / p.sy - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    out[j * W + i] = (tex(x0, y0) * (1 - tx) + tex(x0 + 1, y0) * tx) * (1 - ty) + (tex(x0, y0 + 1) * (1 - tx) + tex(x0 + 1, y0 + 1) * tx) * ty;
  }
  return out;
}

// ---- §54.8 the mask at property time t: path keyframes win over the static points.
function lerpPoints(a: MaskPoint[], b: MaskPoint[], e: number): MaskPoint[] {
  const l = (p?: XY, q?: XY) => p && q ? { x: p.x + (q.x - p.x) * e, y: p.y + (q.y - p.y) * e } : p ?? q;
  return a.map((p, i) => ({ anchor: l(p.anchor, b[i].anchor)!, handleIn: l(p.handleIn, b[i].handleIn), handleOut: l(p.handleOut, b[i].handleOut) }));
}
export function pathAt(mask: any, t: number, ease: Ease = linear): SubPath[] {
  const kf: any[] | undefined = keyList(mask.keyframes?.path)?.slice().sort((a: Keyframe, b: Keyframe) => a.time - b.time);
  if (!kf?.length) return buildPath(mask.points ?? [], mask.closed ?? true);
  const one = (k: any) => k.points ? buildPath(k.points, k.closed ?? true) : parsePath(k.value ?? '');
  const last = kf[kf.length - 1];
  if (t <= kf[0].time) return one(kf[0]);
  if (t >= last.time) return one(last);
  const i = kf.findIndex(k => k.time > t), a = kf[i - 1], b = kf[i];
  if (t === a.time) return one(a);
  if (b.time - a.time <= 50) return one(t - a.time <= b.time - t ? a : b);
  const e = ease(a, b, (t - a.time) / (b.time - a.time));
  if (a.points && b.points && a.points.length === b.points.length) return buildPath(lerpPoints(a.points, b.points, e), a.closed ?? true);
  return one(e < 0.5 ? a : b);
}
export function maskAt(mask: any, t: number, ease: Ease = linear) {
  const num = (key: string, d: number) => keyframed(keyList(mask.keyframes?.[key]), mask[key] ?? d, t, ease);
  return { paths: pathAt(mask, t, ease), feather: num('feather', 0), expansion: num('expansion', 0), opacity: num('opacity', 100) };
}

// ---- §54.3–§54.5 one mask's g, then its layer value b.
export function coverage(paths: SubPath[], raster: Float32Array | null, W: number, H: number, feather: number, expansion: number, impl: Impl): Float32Array {
  let g: Float32Array = raster ? raster.map(q8) : fillCoverage(paths.map(p => p.pts), W, H).map(q8);
  if (expansion) g = impl === 'gpu' ? expandGpu(g, expansion, W, H) : expandCanvas(paths, g, expansion, W, H);
  if (feather > 0) g = gaussian(g, W, H, feather, impl === 'gpu');
  return g;
}
// The canvas path draws h·g into an 8-bit layer before Subtract's 1 − b; the GPU path keeps b a float until it
// combines (§54.11 T8 GPU: subtract 77, difference 128).
function layerOf(g: Float32Array, inverted: boolean, opacity: number, mode: string, impl: Impl): Float32Array {
  const h = Math.min(Math.max(opacity, 0), 100) / 100, store = impl === 'gpu' ? (v: number) => v : q8;
  return g.map(v => { const b = store(h * (inverted ? 1 - v : v)); return mode === 'subtract' ? 1 - b : b; });
}
// Canvas-path layer value b.
export function layerValue(g: Float32Array, inverted: boolean, opacity: number, mode: string): Float32Array {
  return layerOf(g, inverted, opacity, mode, 'canvas');
}
// §54.6 5.2: the first mask sets acc = b (stored to 8 bit); each next one combines (unknown modes: add on canvas, intersect on GPU).
export function combine(acc: Float32Array | null, b: Float32Array, mode: string, impl: Impl): Float32Array {
  if (!acc) return b.map(q8);
  const m = ['add', 'subtract', 'intersect', 'difference'].includes(mode) ? mode : impl === 'gpu' ? 'intersect' : 'add';
  return acc.map((a, i) => { const v = b[i]; return q8(m === 'add' ? a + v * (1 - a) : m === 'difference' ? a * (1 - v) + v * (1 - a) : a * v); });
}

export type MaskOptions = {
  W: number; H: number; propertyTimeMs: number; sourceTimeUs: number; ease?: Ease;
  raster?: (mask: any) => AlphaPlane | null; // the held raster frame of a raster mask (caller decodes)
  impl?: Impl; // default: 'gpu' when any enabled mask is a raster mask, else 'canvas'
};
// Combined mask alpha acc of an item's mask list, or null when no mask takes part.
export function maskAlpha(masks: any[], o: MaskOptions): Float32Array | null {
  const enabled = masks.map((m, i) => [m, i] as const).filter(([m]) => m.enabled !== false);
  for (const [m] of enabled) { // stored shapes the oracle does not model throw instead of drawing as a plain vector mask
    if (m.pathKeyframes !== undefined || m.propertyKeyframes !== undefined) throw Error(`mask ${m.id ?? ''}: legacy frame-based pathKeyframes / propertyKeyframes (§54.8 7.4) are not modelled`);
    if (m.source === 'smart' && !m.raster) throw Error(`mask ${m.id ?? ''}: a legacy vector smart mask (§54.9 8.3) is not modelled`);
  }
  const impl: Impl = o.impl ?? (enabled.some(([m]) => m.raster) ? 'gpu' : 'canvas');
  const on = enabled.filter(([m]) => !m.raster || rasterActive(m, o.sourceTimeUs)).sort((a, b) => (a[0].order ?? a[1]) - (b[0].order ?? b[1]) || a[1] - b[1]);
  let acc: Float32Array | null = null;
  for (const [m] of on) {
    const s = maskAt(m, o.propertyTimeMs, o.ease ?? linear);
    let raster: Float32Array | null = null;
    if (m.raster) {
      if (impl !== 'gpu') throw Error('raster masks run on the GPU path only');
      const plane = o.raster?.(m);
      if (!plane) throw Error(`raster frame for mask ${m.id ?? ''} unavailable`);
      raster = rasterCoverage(plane, m.raster.space, o.W, o.H, m.raster.edgeSampling);
    }
    acc = combine(acc, layerOf(coverage(s.paths, raster, o.W, o.H, s.feather, s.expansion, impl), !!m.inverted, s.opacity, m.mode ?? 'add', impl), m.mode ?? 'add', impl);
  }
  return acc;
}
// Final step: item alpha × acc, RGB unchanged (straight alpha).
export function applyMask(image: Image, acc: Float32Array): Image {
  const data = image.data.slice();
  for (let i = 0; i < acc.length; i++) data[i * 4 + 3] = q8(data[i * 4 + 3] * acc[i]);
  return { width: image.width, height: image.height, data };
}
