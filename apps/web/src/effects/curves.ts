// SPDX-License-Identifier: AGPL-3.0-only
// Curves table (part 4 §49.3): normalise the points, monotone cubic Hermite (Fritsch–Carlson), 256-entry 8-bit RGB table.
import type { ParamValues } from './schema';

type Pt = [number, number];
const clamp = (v: number, lo = 0, hi = 1) => Math.min(Math.max(v, lo), hi);
const num = (p: ParamValues, key: string, fb: number) => { const v = p[key]; return typeof v === 'number' && Number.isFinite(v) ? v : fb; };

export function evalCurve(input: Pt[], x: number): number {
  const pts: Pt[] = [];
  for (const q of input.map(([a, b]) => [clamp(a), clamp(b)] as Pt).sort((a, b) => a[0] - b[0]))
    if (!pts.length || q[0] - pts[pts.length - 1][0] >= 0.0005) pts.push(q);
  if (pts[0][0] > 0.0001) pts.unshift([0, pts[0][1]]); else pts[0][0] = 0;
  const last = pts[pts.length - 1];
  if (last[0] < 0.9999) pts.push([1, last[1]]); else last[0] = 1;
  const n = pts.length;
  const d = pts.slice(1).map((q, i) => (q[1] - pts[i][1]) / Math.max(q[0] - pts[i][0], 1e-6));
  const m = pts.map((_, i) => i === 0 ? d[0] : i === n - 1 ? d[d.length - 1] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  d.forEach((v, i) => {
    if (Math.abs(v) < 1e-6) { m[i] = m[i + 1] = 0; return; }
    const q = (m[i] / v) ** 2 + (m[i + 1] / v) ** 2;
    if (q > 9) { const k = 3 / Math.sqrt(q); m[i] *= k; m[i + 1] *= k; }
  });
  if (x <= 0) return pts[0][1];
  if (x >= 1) return pts[n - 1][1];
  const i = Math.max(0, pts.findIndex((q, j) => j < n - 1 && x >= q[0] && x <= pts[j + 1][0]));
  const w = pts[i + 1][0] - pts[i][0], t = (x - pts[i][0]) / w;
  return clamp((2 * t ** 3 - 3 * t * t + 1) * pts[i][1] + (t ** 3 - 2 * t * t + t) * w * m[i]
    + (-2 * t ** 3 + 3 * t * t) * pts[i + 1][1] + (t ** 3 - t * t) * w * m[i + 1]);
}

function channelPoints(p: ParamValues, ch: string): Pt[] {
  let sx = clamp(num(p, ch + 'ShadowX', 0.25), 0.02, 0.98), hx = clamp(num(p, ch + 'HighlightX', 0.75), 0.02, 0.98);
  if (sx > hx) [sx, hx] = [hx, sx];
  if (hx - sx < 0.04) { const mid = clamp((hx + sx) / 2, 0.04, 0.96); sx = mid - 0.02; hx = mid + 0.02; }
  const mid: Pt[] = p[ch + 'MidOn'] === true && hx - sx >= 0.08
    ? [[clamp(num(p, ch + 'MidX', 0.5), sx + 0.04, hx - 0.04), num(p, ch + 'MidY', 0.5)]] : [];
  return [[0, num(p, ch + 'BlackY', 0)], [sx, num(p, ch + 'ShadowY', 0.25)], ...mid, [hx, num(p, ch + 'HighlightY', 0.75)], [1, num(p, ch + 'WhiteY', 1)]];
}

/** 256 × RGBA8 table: each colour curve applied to the master curve's output. */
export function curvesTable(p: ParamValues): Uint8Array {
  const master = channelPoints(p, 'master'), rgb = ['red', 'green', 'blue'].map(ch => channelPoints(p, ch));
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const m = evalCurve(master, i / 255);
    rgb.forEach((pts, ch) => { out[i * 4 + ch] = Math.round(255 * evalCurve(pts, m)); });
    out[i * 4 + 3] = 255;
  }
  return out;
}
