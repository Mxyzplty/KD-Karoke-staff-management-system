// SPDX-License-Identifier: AGPL-3.0-only
// Independent CPU reference (float64) of the documented HDR choice, written separately from apps/web/src/media/tonemap.ts:
// BT.2020 NCL limited-range Y′CbCr → R′G′B′ → (HLG: BT.2100 OOTF at 1000 cd/m², γ 1.2 → PQ) → BT.2390 EETF 0–1000 → 0–100 cd/m²
// per channel → linear /100 → BT.2087 BT.2020→BT.709 matrix → clip → γ 1/2.4. Plus CIEDE2000.
const M1 = 0.1593017578125, M2 = 78.84375, C1 = 0.8359375, C2 = 18.8515625, C3 = 18.6875;
const pqInv = (y: number) => { const p = Math.pow(Math.max(y, 0) / 10000, M1); return Math.pow((C1 + C2 * p) / (1 + C3 * p), M2); };
const pq = (e: number) => { const p = Math.pow(Math.max(e, 0), 1 / M2); return 10000 * Math.pow(Math.max(p - C1, 0) / (C2 - C3 * p), 1 / M1); };
const hlgInv = (e: number) => { const a = 0.17883277, b = 0.28466892, c = 0.55991073; return e <= 0.5 ? e * e / 3 : (Math.exp((e - c) / a) + b) / 12; };
function bt2390(e: number) {
  const lo = pqInv(0), hi = pqInv(1000), maxLum = (pqInv(100) - lo) / (hi - lo), ks = 1.5 * maxLum - 0.5;
  const x = Math.min(1, Math.max(0, (e - lo) / (hi - lo)));
  if (x <= ks) return x * (hi - lo) + lo;
  const t = (x - ks) / (1 - ks);
  const p = (2 * t ** 3 - 3 * t ** 2 + 1) * ks + (t ** 3 - 2 * t ** 2 + t) * (1 - ks) + (-2 * t ** 3 + 3 * t ** 2) * maxLum;
  return p * (hi - lo) + lo;
}
/** One 10-bit limited-range BT.2020 NCL sample → SDR BT.709 R′G′B′ in [0, 1]. */
export function referencePixel(y: number, cb: number, cr: number, transfer: 'pq' | 'hlg'): [number, number, number] {
  const Y = (y - 64) / 876, B = (cb - 512) / 896, R = (cr - 512) / 896;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const r = clip(Y + 1.4746 * R), g = clip(Y - 0.164553 * B - 0.571353 * R), b = clip(Y + 1.8814 * B);
  let e: number[];
  if (transfer === 'hlg') {
    const s = [hlgInv(r), hlgInv(g), hlgInv(b)], ys = 0.2627 * s[0] + 0.678 * s[1] + 0.0593 * s[2], gain = 1000 * Math.pow(Math.max(ys, 0), 0.2);
    e = s.map(v => pqInv(gain * v));
  } else e = [r, g, b];
  const lin = e.map(v => pq(bt2390(v)) / 100);
  const out = [1.660491 * lin[0] - 0.587641 * lin[1] - 0.07285 * lin[2], -0.12455 * lin[0] + 1.1329 * lin[1] - 0.008349 * lin[2], -0.018151 * lin[0] - 0.100579 * lin[1] + 1.11873 * lin[2]];
  return out.map(v => Math.pow(clip(v), 1 / 2.4)) as [number, number, number];
}
/** SDR R′G′B′ (γ 2.4 display, BT.709 primaries, D65) → CIELAB. */
export function lab([r, g, b]: number[]): [number, number, number] {
  const [R, G, B] = [r, g, b].map(v => Math.pow(v, 2.4));
  const X = 0.4124 * R + 0.3576 * G + 0.1805 * B, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = 0.0193 * R + 0.1192 * G + 0.9505 * B;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const [fx, fy, fz] = [X / 0.95047, Y, Z / 1.08883].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/** CIEDE2000 colour difference. */
export function deltaE2000(a: number[], b: number[]): number {
  const [L1, a1, b1] = a, [L2, a2, b2] = b, rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2, G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const A1 = (1 + G) * a1, A2 = (1 + G) * a2, Cp1 = Math.hypot(A1, b1), Cp2 = Math.hypot(A2, b2);
  const h = (x: number, y: number) => { if (x === 0 && y === 0) return 0; const v = Math.atan2(y, x) / rad; return v < 0 ? v + 360 : v; };
  const h1 = h(A1, b1), h2 = h(A2, b2), dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = h2 - h1; if (Cp1 * Cp2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dh / 2 * rad), Lm = (L1 + L2) / 2, Cpm = (Cp1 + Cp2) / 2;
  let hm = h1 + h2; if (Cp1 * Cp2 !== 0) { if (Math.abs(h1 - h2) > 180) hm += h1 + h2 < 360 ? 360 : -360; hm /= 2; }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2)), Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T, Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}
