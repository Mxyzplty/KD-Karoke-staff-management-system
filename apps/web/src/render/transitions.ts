// SPDX-License-Identifier: AGPL-3.0-only
// T11 transition pictures (findings part 5 §55.4, §55.5): the per-kind curves and the canvas combine of the two transparent
// full-canvas surfaces (outgoing A, incoming B) into a third, which the compositor draws source-over at the pair's layer
// position. One path for the paused preview, the playing preview, captureFrame and the export (compositor.ts). Canvas 8-bit
// intermediates: pixel checks allow ±1 LSB (§55.0), except Canvas 2D dissolve and additive dissolve allow ±3 LSB (D32 Q11).
// Nothing here runs until a frame holds a transition (the pool is lazy).
import type { Direction } from '../timeline/transitions';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth01 = (x: number) => { const v = clamp01(x); return v * v * (3 - 2 * v); };
export const inOutCubic = (x: number) => x < 0.5 ? 4 * x ** 3 : 1 - (2 - 2 * x) ** 3 / 2;
/** fade: A for p < 0.5, then B, over opaque black with alpha cos(πp) / −cos(πp). */
export const fadeAlpha = (p: number) => clamp01(p < 0.5 ? Math.cos(Math.PI * p) : -Math.cos(Math.PI * p));
/** dissolve: B over A with the raised cosine. */
export const dissolveWeight = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * p);
/** dipToColorDissolve: the full-frame colour overlay's alpha (smoothstep up to the midpoint, mirrored after). */
export const dipOverlay = (p: number) => p < 0.5 ? smooth01(p / 0.5) : 1 - smooth01((p - 0.5) / 0.5);
/** params.color [r, g, b] in 0–1, each clamped and rounded to /255; a non-array is black, a non-number entry 0. */
export const dipColour = (c: unknown): [number, number, number] =>
  Array.isArray(c) ? [0, 1, 2].map(i => typeof c[i] === 'number' ? Math.round(clamp01(c[i]) * 255) : 0) as [number, number, number] : [0, 0, 0];
const VECTOR: Record<Direction, [number, number]> = { 'from-left': [1, 0], 'from-right': [-1, 0], 'from-top': [0, 1], 'from-bottom': [0, -1] };
const direction = (d: unknown): Direction => d && Object.hasOwn(VECTOR, d as string) ? d as Direction : 'from-left';
/** slide: whole-px offsets (round half up) of A and B for e = inOutCubic(p); the incoming clip enters from the named side. */
export function slideOffsets(p: number, dir: unknown, width: number, height: number) {
  const e = inOutCubic(p), [x, y] = VECTOR[direction(dir)];
  return { outgoing: [Math.round(e * x * width), Math.round(e * y * height)] as [number, number], incoming: [Math.round((e - 1) * x * width), Math.round((e - 1) * y * height)] as [number, number] };
}
/** wipe: params.softness clamped to 0–100, as a fraction of the frame along the wipe. */
export const wipeSoftness = (params: unknown) => { const s = (params as { softness?: unknown } | undefined)?.softness; return typeof s === 'number' ? Math.min(100, Math.max(0, s)) / 100 : 0; };
/** The mask at position u from the entry side (reference path): quirk B (p = 0, s = 0: the ramp 1 − u) and quirk A (front
 *  past the far edge: the feather ends there). */
export function wipeMask(u: number, p: number, s: number) {
  const f = p * (1 + s), g = f - s;
  if (p === 0 && s === 0) return 1 - u;
  if (f > 1) return u <= g ? 1 : u >= 1 ? 0 : (1 - u) / (1 - g);
  return u <= g ? 1 : u >= f ? 0 : (f - u) / s;
}

/** The pair's kind and progress as framePlan tags its two draws (render/model.ts). */
export type Pair = { kind: string; p: number; direction?: string; params?: unknown };
type Ctx2 = OffscreenCanvasRenderingContext2D;

// Three reused surfaces per frame size (A, B, result), at most two sizes (the paused project size and the playing size).
const pool = new Map<string, [Ctx2, Ctx2, Ctx2]>(), POOL_SIZES = 2;
/** Cleared A and B surfaces and the result surface for a frame of this size, made on first use. */
export function surfaces(width: number, height: number): [Ctx2, Ctx2, Ctx2] {
  const key = `${width}x${height}`;
  let s = pool.get(key);
  if (s) pool.delete(key);
  else {
    if (pool.size >= POOL_SIZES) pool.delete(pool.keys().next().value!);
    s = [0, 1, 2].map(() => new OffscreenCanvas(width, height).getContext('2d')!) as [Ctx2, Ctx2, Ctx2];
  }
  pool.set(key, s);
  for (const c of s) reset(c);
  return s;
}
function reset(c: Ctx2) {
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
}

/** wipe: B keeps the mask's alpha. A hard edge (s = 0, p > 0) covers the pixels whose centre has u ≤ p, i.e. ⌊p·L + 0.5⌋ px
 *  from the entry side; otherwise a linear gradient along the axis from u = g to u = min(f, 1) (quirk A), or 0 → 1 (quirk B). */
function maskWipe(b: Ctx2, p: number, dir: Direction, s: number) {
  const W = b.canvas.width, H = b.canvas.height, horizontal = dir === 'from-left' || dir === 'from-right', L = horizontal ? W : H;
  const far = dir === 'from-right' || dir === 'from-bottom', at = (u: number) => far ? L - u * L : u * L;
  if (s === 0 && p > 0) {
    const n = Math.min(L, Math.floor(p * L + 0.5)), lo = far ? 0 : n, len = L - n;
    if (len > 0) { if (horizontal) b.clearRect(lo, 0, len, H); else b.clearRect(0, lo, W, len); }
    return;
  }
  const f = p * (1 + s), [u0, u1] = s === 0 ? [0, 1] : [f - s, Math.min(f, 1)];
  const a = at(u0), z = at(u1), grad = horizontal ? b.createLinearGradient(a, 0, z, 0) : b.createLinearGradient(0, a, 0, z);
  grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  // Cost only (T11 notes, 1080p measurement): outside the whole-pixel band around the ramp the gradient is constant, 1 on the
  // entry side and 0 past the front, so that part is cleared and only the band is masked. The pixels are the same.
  const lo = Math.max(0, Math.floor(Math.min(a, z))), hi = Math.min(L, Math.ceil(Math.max(a, z))), [k0, k1] = far ? [0, lo] : [hi, L];
  if (k1 > k0) { if (horizontal) b.clearRect(k0, 0, k1 - k0, H); else b.clearRect(0, k0, W, k1 - k0); }
  if (hi <= lo) return;
  b.save(); b.beginPath(); if (horizontal) b.rect(lo, 0, hi - lo, H); else b.rect(0, lo, W, hi - lo); b.clip();
  b.globalCompositeOperation = 'destination-in'; b.fillStyle = grad; b.fillRect(0, 0, W, H);
  b.restore();
}

/** Combines A and B (each item drawn on its own transparent surface, own blend mode neutralised) into r, per §55.5. */
export function combine(a: Ctx2, b: Ctx2, r: Ctx2, pair: Pair) {
  const { p } = pair, W = r.canvas.width, H = r.canvas.height;
  switch (pair.kind) {
    case 'fade':
      r.fillStyle = '#000000'; r.fillRect(0, 0, W, H);
      r.globalAlpha = fadeAlpha(p); r.drawImage(p < 0.5 ? a.canvas : b.canvas, 0, 0);
      break;
    case 'additiveDissolve':
      r.globalAlpha = 1 - p; r.drawImage(a.canvas, 0, 0);
      r.globalCompositeOperation = 'lighter'; r.globalAlpha = p; r.drawImage(b.canvas, 0, 0);
      break;
    case 'dipToColorDissolve': {
      const [cr, cg, cb] = dipColour((pair.params as { color?: unknown } | undefined)?.color);
      r.drawImage(p < 0.5 ? a.canvas : b.canvas, 0, 0);
      r.globalAlpha = dipOverlay(p); r.fillStyle = `rgb(${cr}, ${cg}, ${cb})`; r.fillRect(0, 0, W, H);
      break;
    }
    case 'slide': {
      const o = slideOffsets(p, pair.direction, W, H);
      r.drawImage(b.canvas, ...o.incoming); r.drawImage(a.canvas, ...o.outgoing);
      break;
    }
    case 'wipe':
      maskWipe(b, p, direction(pair.direction), wipeSoftness(pair.params));
      r.drawImage(a.canvas, 0, 0); r.drawImage(b.canvas, 0, 0);
      break;
    default: // dissolve (framePlan tags only the six kinds; another stored kind is reported and hard-cuts)
      r.drawImage(a.canvas, 0, 0);
      r.globalAlpha = dissolveWeight(p); r.drawImage(b.canvas, 0, 0);
  }
  r.globalAlpha = 1; r.globalCompositeOperation = 'source-over';
}
