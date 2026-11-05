// SPDX-License-Identifier: AGPL-3.0-only
// HDR → SDR BT.709 (findings §13 documented choice while golden capture G-10 is absent): ITU-R BT.2390 EETF.
// One shared implementation for ingest (proxies, thumbnails), preview (T15) and export (T16). Parameters:
//   source mastering range 0–1000 cd/m² (no mastering metadata is read), target SDR range 0–100 cd/m² (black lift b = 0);
//   HLG is first turned into display light with the BT.2100 OOTF at a 1000 cd/m² nominal peak (system gamma 1.2),
//   re-encoded as PQ and then takes the same EETF; the EETF is applied to each PQ-encoded R′G′B′ channel;
//   gamut BT.2020 → BT.709 by the linear BT.2087 matrix with clipping; output encoded with the inverse BT.1886 EOTF (γ 2.4).
export const TONEMAP = { sourcePeak: 1000, targetPeak: 100, hlgSystemGamma: 1.2, sdrGamma: 2.4 } as const;
const m1 = 2610 / 16384, m2 = 2523 / 4096 * 128, c1 = 3424 / 4096, c2 = 2413 / 4096 * 32, c3 = 2392 / 4096 * 32;
/** PQ inverse EOTF: absolute luminance (cd/m²) → signal [0, 1]. */
export function pqEncode(nits: number): number { const y = Math.max(0, nits) / 10000, p = y ** m1; return ((c1 + c2 * p) / (1 + c3 * p)) ** m2; }
/** PQ EOTF: signal [0, 1] → cd/m². */
export function pqDecode(e: number): number { const p = Math.max(0, e) ** (1 / m2); return 10000 * (Math.max(0, p - c1) / (c2 - c3 * p)) ** (1 / m1); }
const a = 0.17883277, b = 1 - 4 * a, c = 0.5 - a * Math.log(4 * a);
/** HLG inverse OETF: signal [0, 1] → scene-linear [0, 1]. */
export function hlgInverseOetf(e: number): number { return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - c) / a) + b) / 12; }
const PQ_MIN = pqEncode(0), PQ_MAX = pqEncode(TONEMAP.sourcePeak), PQ_TARGET = pqEncode(TONEMAP.targetPeak);
const MAX_LUM = (PQ_TARGET - PQ_MIN) / (PQ_MAX - PQ_MIN), KS = 1.5 * MAX_LUM - 0.5;
/** BT.2390 EETF on one PQ signal value (source 0–1000 cd/m² → target 0–100 cd/m², b = 0). */
export function eetf(e: number): number {
  const e1 = Math.min(1, Math.max(0, (e - PQ_MIN) / (PQ_MAX - PQ_MIN)));
  let e2 = e1;
  if (e1 > KS) {
    const t = (e1 - KS) / (1 - KS), t2 = t * t, t3 = t2 * t;
    e2 = (2 * t3 - 3 * t2 + 1) * KS + (t3 - 2 * t2 + t) * (1 - KS) + (-2 * t3 + 3 * t2) * MAX_LUM;
  }
  return e2 * (PQ_MAX - PQ_MIN) + PQ_MIN;
}
const BT2020_TO_709 = [1.660491, -0.587641, -0.07285, -0.12455, 1.1329, -0.008349, -0.018151, -0.100579, 1.11873];
const sdrEncode = (linear: number) => Math.min(1, Math.max(0, linear)) ** (1 / TONEMAP.sdrGamma);
/** One HDR pixel (non-linear BT.2020 R′G′B′, [0, 1]) → SDR BT.709 R′G′B′ [0, 1]. */
export function toneMapRgb(r: number, g: number, bl: number, transfer: 'pq' | 'hlg', out: number[] = [0, 0, 0]): number[] {
  let pr: number, pg: number, pb: number;
  if (transfer === 'hlg') {
    const sr = hlgInverseOetf(r), sg = hlgInverseOetf(g), sb = hlgInverseOetf(bl);
    const ys = 0.2627 * sr + 0.678 * sg + 0.0593 * sb, k = TONEMAP.sourcePeak * Math.max(ys, 0) ** (TONEMAP.hlgSystemGamma - 1);
    pr = pqEncode(k * sr); pg = pqEncode(k * sg); pb = pqEncode(k * sb);
  } else { pr = r; pg = g; pb = bl; }
  const lr = pqDecode(eetf(pr)) / TONEMAP.targetPeak, lg = pqDecode(eetf(pg)) / TONEMAP.targetPeak, lb = pqDecode(eetf(pb)) / TONEMAP.targetPeak;
  const m = BT2020_TO_709;
  out[0] = sdrEncode(m[0] * lr + m[1] * lg + m[2] * lb); out[1] = sdrEncode(m[3] * lr + m[4] * lg + m[5] * lb); out[2] = sdrEncode(m[6] * lr + m[7] * lg + m[8] * lb);
  return out;
}
export type YuvFrame = { width: number; height: number; bitDepth: 8 | 10; chroma: '420' | '422' | '444'; y: ArrayLike<number>; u: ArrayLike<number>; v: ArrayLike<number>; yStride: number; cStride: number; fullRange: boolean };
type Matrix = 'bt709' | 'bt2020-ncl' | 'bt470bg' | 'smpte170m';
const KR: Record<Matrix, [number, number]> = { bt709: [0.2126, 0.0722], 'bt2020-ncl': [0.2627, 0.0593], bt470bg: [0.299, 0.114], smpte170m: [0.299, 0.114] };
/**
 * Planar Y′CbCr → RGBA8. With `hdr` set the pixels take toneMapRgb; otherwise they are passed through unchanged (SDR).
 * Chroma is sampled nearest (each chroma sample covers its 2×1 or 2×2 block).
 */
export function yuvToRgba(f: YuvFrame, matrix: string, hdr: 'pq' | 'hlg' | null, target = new Uint8ClampedArray(f.width * f.height * 4)): Uint8ClampedArray {
  const [kr, kb] = KR[(matrix in KR ? matrix : 'bt709') as Matrix], kg = 1 - kr - kb;
  const max = (1 << f.bitDepth) - 1, scale = 1 << (f.bitDepth - 8);
  const yOff = f.fullRange ? 0 : 16 * scale, yRange = f.fullRange ? max : 219 * scale, cRange = f.fullRange ? max : 224 * scale, mid = 128 * scale;
  const sx = f.chroma === '444' ? 0 : 1, sy = f.chroma === '420' ? 1 : 0;
  const out = [0, 0, 0];
  for (let row = 0; row < f.height; row++) {
    for (let col = 0; col < f.width; col++) {
      const ci = (row >> sy) * f.cStride + (col >> sx);
      const yv = (f.y[row * f.yStride + col] - yOff) / yRange, cb = (f.u[ci] - mid) / cRange, cr = (f.v[ci] - mid) / cRange;
      let r = yv + 2 * (1 - kr) * cr, b = yv + 2 * (1 - kb) * cb;
      let g = (yv - kr * r - kb * b) / kg;
      r = Math.min(1, Math.max(0, r)); g = Math.min(1, Math.max(0, g)); b = Math.min(1, Math.max(0, b));
      if (hdr) { toneMapRgb(r, g, b, hdr, out); r = out[0]; g = out[1]; b = out[2]; }
      const o = (row * f.width + col) * 4;
      target[o] = Math.round(r * 255); target[o + 1] = Math.round(g * 255); target[o + 2] = Math.round(b * 255); target[o + 3] = 255;
    }
  }
  return target;
}
