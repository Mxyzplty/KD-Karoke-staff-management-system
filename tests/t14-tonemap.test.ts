// SPDX-License-Identifier: AGPL-3.0-only
// The documented HDR choice (findings §13): BT.2390 EETF to SDR BT.709, parameters in apps/web/src/media/tonemap.ts.
import { describe, expect, it } from 'vitest';
import { eetf, hlgInverseOetf, pqDecode, pqEncode, toneMapRgb, TONEMAP, yuvToRgba } from '../apps/web/src/media/tonemap';
import { deltaE2000, lab, referencePixel } from './colour-reference';

describe('T14 tone map (BT.2390 EETF, 0–1000 → 0–100 cd/m²)', () => {
  it('PQ transfer: published anchor values and a round trip', () => {
    expect(pqEncode(10000)).toBeCloseTo(1, 12); expect(pqEncode(0)).toBeCloseTo(0, 5);
    expect(pqEncode(100)).toBeCloseTo(0.5081, 4); expect(pqEncode(1000)).toBeCloseTo(0.7518, 4); expect(pqEncode(203)).toBeCloseTo(0.5807, 4);
    for (const nits of [0.01, 1, 58, 203, 1000, 4000]) expect(pqDecode(pqEncode(nits))).toBeCloseTo(nits, 6);
  });
  it('EETF: identity below the knee, source peak → target peak, monotonic, never above the target', () => {
    const ks = 1.5 * (pqEncode(100) / pqEncode(1000)) - 0.5;
    expect(eetf(0.2 * pqEncode(1000))).toBeCloseTo(0.2 * pqEncode(1000), 12);
    expect(eetf(ks * pqEncode(1000) * 0.99)).toBeCloseTo(ks * pqEncode(1000) * 0.99, 12);
    expect(eetf(pqEncode(1000))).toBeCloseTo(pqEncode(TONEMAP.targetPeak), 10);
    expect(eetf(pqEncode(4000))).toBeCloseTo(pqEncode(100), 10);
    let previous = -1; for (let e = 0; e <= 1; e += 1 / 1024) { const v = eetf(e); expect(v).toBeGreaterThanOrEqual(previous - 1e-12); expect(v).toBeLessThanOrEqual(pqEncode(100) + 1e-12); previous = v; }
  });
  it('HLG: inverse OETF and the BT.2100 OOTF at 1000 cd/m² put the 75 % signal at ≈ 203 cd/m² (BT.2408 reference white)', () => {
    expect(hlgInverseOetf(0.5)).toBeCloseTo(1 / 12, 12); expect(hlgInverseOetf(1)).toBeCloseTo(1, 6);
    const ys = hlgInverseOetf(0.75); expect(TONEMAP.sourcePeak * ys ** TONEMAP.hlgSystemGamma).toBeCloseTo(203, -1);
  });
  it('neutral greys stay neutral; black stays black; HDR white is clipped to SDR white', () => {
    for (const transfer of ['pq', 'hlg'] as const) {
      const [r, g, b] = toneMapRgb(0.5, 0.5, 0.5, transfer); expect(Math.abs(r - g)).toBeLessThan(1e-5); expect(Math.abs(g - b)).toBeLessThan(1e-5);
      expect(toneMapRgb(0, 0, 0, transfer)).toEqual([0, 0, 0]); expect(toneMapRgb(1, 1, 1, transfer).every(v => v > 0.999)).toBe(true);
    }
  });
  it('the shipped converter matches the independent float64 reference within ΔE2000 ≤ 0.5 on a code-value sweep', () => {
    let worst = 0;
    for (const transfer of ['pq', 'hlg'] as const) for (let y = 64; y <= 940; y += 73) for (let cb = 128; cb <= 896; cb += 192) for (let cr = 128; cr <= 896; cr += 192) {
      const frame = { width: 1, height: 1, bitDepth: 10 as const, chroma: '444' as const, y: [y], u: [cb], v: [cr], yStride: 1, cStride: 1, fullRange: false };
      const rgba = yuvToRgba(frame, 'bt2020-ncl', transfer);
      worst = Math.max(worst, deltaE2000(lab([rgba[0] / 255, rgba[1] / 255, rgba[2] / 255]), lab(referencePixel(y, cb, cr, transfer))));
    }
    expect(worst).toBeLessThanOrEqual(0.5);
  });
  it('SDR frames convert without tone mapping (BT.709 limited range)', () => {
    const frame = { width: 2, height: 1, bitDepth: 8 as const, chroma: '444' as const, y: [16, 235], u: [128, 128], v: [128, 128], yStride: 2, cStride: 2, fullRange: false };
    expect(Array.from(yuvToRgba(frame, 'bt709', null))).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});
