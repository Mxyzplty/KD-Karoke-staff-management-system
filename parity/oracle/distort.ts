// SPDX-License-Identifier: AGPL-3.0-only
// CPU float reference of findings part 4 §51 (blur, distort and generate effects).
// `effects`: WebGL-chain passes. One fragment per pixel centre in the export convention
// (uv 0…1, x right, y UP from the bottom edge), taps are bilinear clamp-to-edge samples of
// straight RGBA. `fragments` evaluate the same per-pixel steps at any continuous uv.
// `cssFilters`: the two CSS-rendered effects on the item raster in output-canvas pixels
// (row 0 = top, y down). Pixels outside the raster count as transparent, so the caller
// pads the raster for the halo (≈ 3σ, plus the shadow offset) it wants to keep.
// Assumption: a non-number / non-finite parameter is treated as missing (inventory default).
import { clamp, colour, type Params, type RGBA } from './math';
import { createImage, mapPixels, sample, type Effect, type Image } from './image';

const num = (p: Params, key: string, fallback: number) => typeof p[key] === 'number' && Number.isFinite(p[key]) ? p[key] : fallback;
const bool = (p: Params, key: string, fallback: boolean) => typeof p[key] === 'boolean' ? p[key] : fallback;
const rad = (deg: number) => deg * Math.PI / 180;
const count = (p: Params, fallback: number, max: number) => Math.trunc(clamp(num(p, 'samples', fallback), 4, max));
const centre = (p: Params) => [num(p, 'centerX', 50) / 100, num(p, 'centerY', 50) / 100];

export type Tap = [x: number, y: number, weight: number];
export type Taps = (x: number, y: number, p: Params, width: number, height: number) => Tap[];
export type Fragment = (image: Image, x: number, y: number, p: Params) => RGBA;

// Weighted mean of the taps: Σ w·S(tap) / Σ w, all four channels alike.
export function gather(image: Image, taps: Tap[]): RGBA {
  const sum = [0, 0, 0, 0]; let total = 0;
  for (const [x, y, w] of taps) { const s = sample(image, x, y); for (let k = 0; k < 4; k++) sum[k] += w * s[k]; total += w; }
  return sum.map(v => v / total) as RGBA;
}

export const blurTaps: Record<string, Taps> = {
  // §51.1: (2N+1)² equal taps on texel centres, N = trunc(r) capped at 20; r < 0.5 passes through.
  'box-blur': (x, y, p, width, height) => {
    const r = num(p, 'radius', 5), n = Math.min(Math.trunc(r), 20), taps: Tap[] = [];
    if (r < .5) return [[x, y, 1]];
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++) taps.push([x + a / width, y + b / height, 1]);
    return taps;
  },
  // §51.2: N Gaussian-weighted taps t = −1…+1 along (cos φ, sin φ)·L in uv.
  'motion-blur': (x, y, p) => {
    const l = num(p, 'amount', 20) / 100 * .3, phi = rad(num(p, 'angle', 0)), n = count(p, 24, 128);
    if (l < .001) return [[x, y, 1]];
    return Array.from({ length: n }, (_, i): Tap => { const t = 2 * i / (n - 1) - 1; return [x + t * l * Math.cos(phi), y + t * l * Math.sin(phi), Math.exp(-2 * t * t)]; });
  },
  // §51.3: taps from p inward to c, scale 1 − k·t·d, weight 1 − t/2.
  'radial-blur': (x, y, p) => {
    const amount = num(p, 'amount', 25), k = amount / 250, [cx, cy] = centre(p), n = count(p, 32, 256);
    if (amount / 50 < .01) return [[x, y, 1]];
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
    return Array.from({ length: n }, (_, i): Tap => { const t = i / (n - 1), s = 1 - k * t * d; return [cx + s * dx, cy + s * dy, 1 - .5 * t]; });
  },
  // §51.4: equal taps from p outward to c + (1 + k)·δ; no early exit.
  'zoom-blur': (x, y, p) => {
    const k = num(p, 'amount', 30) / 200, [cx, cy] = centre(p), n = count(p, 16, 256), dx = x - cx, dy = y - cy;
    return Array.from({ length: n }, (_, i): Tap => { const s = 1 + k * i / (n - 1); return [cx + s * dx, cy + s * dy, 1]; });
  },
};

// Triangle-wave fold of §51.8: identity on 0…1, reflects beyond (mod with floor).
const fold = (v: number) => 1 - Math.abs(v - 2 * Math.floor(v / 2) - 1);

export const fragments: Record<string, Fragment> = {
  ...Object.fromEntries(Object.entries(blurTaps).map(([id, taps]): [string, Fragment] => [id, (image, x, y, p) => gather(image, taps(x, y, p, image.width, image.height))])),
  // §51.7: red from p + o, blue from p − o, green and alpha from p; o = a item px along φ.
  'chromatic-aberration': (image, x, y, p) => {
    const a = num(p, 'amount', 5), phi = rad(num(p, 'angle', 0)), ox = a * Math.cos(phi) / image.width, oy = a * Math.sin(phi) / image.height, c = sample(image, x, y);
    return [sample(image, x + ox, y + oy)[0], c[1], sample(image, x - ox, y - oy)[2], c[3]];
  },
  // §51.8: radial scale f = 1 + k·|q|² of q = 2p − 1; fold or cut to transparent outside 0…1.
  'lens-distortion': (image, x, y, p) => {
    const k = num(p, 'distortion', 0) / 100, qx = 2 * x - 1, qy = 2 * y - 1, f = 1 + k * (qx * qx + qy * qy), u = (f * qx + 1) / 2, v = (f * qy + 1) / 2;
    if (bool(p, 'mirrorEdges', true)) return sample(image, fold(u), fold(v));
    return u < 0 || u > 1 || v < 0 || v > 1 ? [0, 0, 0, 0] : sample(image, u, v);
  },
  // §51.9: inside radius R rotate δ counter-clockwise by θmax·(1 − d/R)².
  twirl: (image, x, y, p) => {
    const theta = num(p, 'amount', 10) / 10, r = num(p, 'radius', 50) / 100, [cx, cy] = centre(p), dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
    if (d >= r) return sample(image, x, y);
    const alpha = theta * (1 - d / r) ** 2, cos = Math.cos(alpha), sin = Math.sin(alpha);
    return sample(image, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
  },
  // §51.10: sequential — v′ from u, then u′ from v′.
  wave: (image, x, y, p) => {
    const v = y + num(p, 'amplitudeX', 20) / 1000 * Math.sin(2 * Math.PI * num(p, 'frequencyX', 5) * x);
    return sample(image, x + num(p, 'amplitudeY', 20) / 1000 * Math.sin(2 * Math.PI * num(p, 'frequencyY', 5) * v), v);
  },
  // §51.11: fold the polar angle into the half-wedge 0…w/2 above the +x axis.
  kaleidoscope: (image, x, y, p) => {
    const w = 2 * Math.PI / Math.max(num(p, 'segments', 6), 2), qx = x - .5, qy = y - .5, phi = Math.atan2(qy, qx) + rad(num(p, 'rotation', 0)), d = Math.hypot(qx, qy);
    let a = w * (phi / w - Math.floor(phi / w));
    if (a > w / 2) a = w - a;
    return sample(image, .5 + d * Math.cos(a), .5 + d * Math.sin(a));
  },
  // §51.12: reflect u > 0.5 and/or v > 0.5 (v up, so vertical copies the bottom half to the top).
  mirror: (image, x, y, p) => sample(image, bool(p, 'horizontal', true) && x > .5 ? 1 - x : x, bool(p, 'vertical', false) && y > .5 ? 1 - y : y),
};

export const effects: Record<string, Effect> = Object.fromEntries(Object.entries(fragments).map(([id, f]): [string, Effect] => [id, (image, p) => mapPixels(image, (_, x, y) => f(image, x, y, p))]));

// Separable sampled Gaussian exp(−i²/2σ²), truncated at ceil(3σ), normalised; zero outside the
// raster. The written kernel only: Chrome's exact approximation is implementation-defined (§51.5).
function gauss(src: Float64Array, width: number, height: number, channels: number, sigma: number): Float64Array {
  if (!(sigma > 0)) return src.slice();
  const r = Math.ceil(3 * sigma), w = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma))), total = w.reduce((s, v) => s + v);
  let out = src;
  for (const [dc, dr] of [[1, 0], [0, 1]]) {
    const next = new Float64Array(out.length);
    for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) for (let i = -r; i <= r; i++) {
      const c = col + i * dc, q = row + i * dr;
      if (c < 0 || c >= width || q < 0 || q >= height) continue;
      const from = (q * width + c) * channels, to = (row * width + col) * channels, k = w[i + r] / total;
      for (let ch = 0; ch < channels; ch++) next[to + ch] += k * out[from + ch];
    }
    out = next;
  }
  return out;
}
const copy = (image: Image): Image => ({ ...image, data: image.data.slice() });
// One value of a one-channel plane at a fractional (column, row-from-top); bilinear, zero outside.
function planeAt(plane: Float64Array, width: number, height: number, c: number, r: number): number {
  const c0 = Math.floor(c), r0 = Math.floor(r), tc = c - c0, tr = r - r0;
  const v = (cc: number, rr: number) => cc < 0 || cc >= width || rr < 0 || rr >= height ? 0 : plane[rr * width + cc];
  return (v(c0, r0) * (1 - tc) + v(c0 + 1, r0) * tc) * (1 - tr) + (v(c0, r0 + 1) * (1 - tc) + v(c0 + 1, r0 + 1) * tc) * tr;
}
const DEFAULT_SHADOW = 'rgba(0,0,0,0.5)';

export const cssFilters: Record<string, Effect> = {
  // §51.5: CSS blur with σ = R raster px, on premultiplied colour; R = 0 adds nothing.
  'gaussian-blur': (image, p) => {
    const sigma = num(p, 'radius', 0), { width, height, data } = image;
    if (!(sigma > 0)) return copy(image);
    const pre = new Float64Array(data.length);
    for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]; pre[i] = data[i] * a; pre[i + 1] = data[i + 1] * a; pre[i + 2] = data[i + 2] * a; pre[i + 3] = a; }
    const blurred = gauss(pre, width, height, 4, sigma), out = createImage(width, height);
    for (let i = 0; i < data.length; i += 4) { const a = blurred[i + 3]; for (let k = 0; k < 3; k++) out.data[i + k] = a > 0 ? blurred[i + k] / a : 0; out.data[i + 3] = a; }
    return out;
  },
  // §51.6: alpha blurred with σ = b, shifted (+x right, +y down), tinted, composited under the content.
  // Assumption: a fractional offset (keyframes) shifts bilinearly; an unparsable colour uses the default.
  'drop-shadow': (image, p) => {
    const { width, height, data } = image, x = num(p, 'x', 4), y = num(p, 'y', 4);
    const [sr, sg, sb, sa] = colour(typeof p.color === 'string' ? p.color : DEFAULT_SHADOW, DEFAULT_SHADOW);
    const alpha = new Float64Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    const blurred = gauss(alpha, width, height, 1, num(p, 'blur', 4)), out = createImage(width, height);
    for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
      const i = (row * width + col) * 4, a = data[i + 3], s = sa * planeAt(blurred, width, height, col - x, row - y), under = s * (1 - a), total = a + under;
      if (total > 0) out.data.set([(data[i] * a + sr * under) / total, (data[i + 1] * a + sg * under) / total, (data[i + 2] * a + sb * under) / total, total], i);
    }
    return out;
  },
};
