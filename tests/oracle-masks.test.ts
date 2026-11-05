// SPDX-License-Identifier: AGPL-3.0-only
// Findings part 5 §54.11 test values through the oracle's mask equations.
import { describe, it, expect } from 'vitest';
import { maskAlpha, fillCoverage, rasterPlacement, rasterCoverage, pickRasterFrame, rasterActive, sourceUs, pathAt, maskAt, type Impl, type MaskPoint, type Pt } from '../parity/oracle/masks';
import { propertyTime, canvasToItem, type Box } from '../parity/oracle/item';

// Fixture T1–T12: opaque item, box 400 × 400, square (150,150)–(250,250), closed, add, opacity 100.
const pts = (...xy: [number, number][]): MaskPoint[] => xy.map(([x, y]) => ({ anchor: { x, y } }));
const square = pts([150, 150], [250, 150], [250, 250], [150, 250]);
const fullBox = pts([0, 0], [400, 0], [400, 400], [0, 400]);
const mask = (o: Record<string, any> = {}) => ({ enabled: true, points: square, closed: true, mode: 'add', opacity: 100, feather: 0, expansion: 0, inverted: false, ...o });
const alpha = (masks: any[], impl: Impl) => maskAlpha(masks, { W: 400, H: 400, propertyTimeMs: 0, sourceTimeUs: 0, impl })!;
// Output alpha × 255 at item pixel (x, y) for each implementation, vs the printed [canvas, gpu] values. The GPU
// column is [derived] (round-to-nearest 8 bit) and must match exactly. The canvas column is exact too, except where
// §54.11 states ±2 for the browser's blur kernel (canvasTol 2: T1, T2, T6, T7; the oracle is within ±1 there).
function check(masks: any[], cases: [number, number, number, number][], canvasTol = 0) {
  const a = { canvas: alpha(masks, 'canvas'), gpu: alpha(masks, 'gpu') };
  for (const [x, y, canvas, gpu] of cases) {
    expect(Math.abs(Math.round(a.canvas[y * 400 + x] * 255) - canvas), `canvas (${x},${y})`).toBeLessThanOrEqual(canvasTol);
    expect(Math.round(a.gpu[y * 400 + x] * 255), `gpu (${x},${y})`).toBe(gpu);
  }
}
// Coverage × 255 rounded, as the 8-bit store does.
const code = (c: Float32Array, W: number, x: number, y: number) => Math.round(c[y * W + x] * 255);

describe('§54.11 mask test values', () => {
  it('T1 feather 10 (and the brief example)', () => check([mask({ feather: 10 })], [[150, 200, 132, 133], [149, 200, 123, 122], [175, 200, 254, 254], [200, 200, 255, 255], [150, 150, 69, 69], [120, 200, 0, 0]], 2));
  it('T2 feather 10, inverted', () => check([mask({ feather: 10, inverted: true })], [[150, 200, 123, 122], [149, 200, 132, 133], [0, 0, 255, 255]], 2));
  it('T3 expansion +10 (round vs square corner)', () => check([mask({ expansion: 10 })], [[140, 200, 255, 255], [139, 200, 0, 0], [141, 141, 0, 255], [143, 143, 255, 255]]));
  it('T4 expansion −10', () => check([mask({ expansion: -10 })], [[160, 200, 255, 255], [159, 200, 0, 0], [160, 160, 255, 255]]));
  it('T5 expansion +2.5', () => check([mask({ expansion: 2.5 })], [[148, 200, 255, 255], [147, 200, 128, 128], [146, 200, 0, 0]]));
  it('T6 expansion +10, feather 5', () => check([mask({ expansion: 10, feather: 5 })], [[140, 200, 137, 138], [139, 200, 118, 117]], 2));
  it('T7 full-box rect, feather 10', () => check([mask({ points: fullBox, feather: 10 })], [[0, 200, 132, 133], [0, 0, 69, 69], [30, 200, 255, 255]], 2));
  it('T7b full-box rect, expansion −10', () => check([mask({ points: fullBox, expansion: -10 })], [[9, 200, 0, 0], [10, 200, 255, 255]]));
  // §54.11 allows ±2 on T8, but no blur is involved and the oracle reproduces both columns exactly. The GPU column
  // needs b = h·g kept a float in the combine step (subtract 77, difference 128); rounding b first gives 76 / 127.
  it('T8 two full-box masks: A add 60, then B at 50 (inside both / B empty)', () => {
    const A = mask({ points: fullBox, opacity: 60, order: 0 });
    for (const [mode, both, aOnly] of [['add', [204, 204], [153, 153]], ['subtract', [76, 77], [153, 153]], ['intersect', [77, 77], [0, 0]], ['difference', [127, 128], [153, 153]]] as const) {
      check([A, mask({ points: fullBox, opacity: 50, mode, order: 1 })], [[200, 200, both[0], both[1]]]);
      check([A, mask({ points: [], opacity: 50, mode, order: 1 })], [[200, 200, aOnly[0], aOnly[1]]]);
    }
  });
  it('T9 single masks', () => {
    for (const mode of ['add', 'intersect', 'difference']) check([mask({ mode })], [[200, 200, 255, 255], [50, 50, 0, 0]]);
    check([mask({ mode: 'subtract' })], [[200, 200, 0, 0], [50, 50, 255, 255]]);
  });
  it('T9b subtract, inverted, opacity 60', () => check([mask({ mode: 'subtract', inverted: true, opacity: 60 })], [[200, 200, 255, 255], [50, 50, 102, 102]]));
  it('T10 add, opacity 37', () => check([mask({ opacity: 37 })], [[200, 200, 94, 94]]));
  it('T11 open path still masks an area', () => check([mask({ points: pts([100, 100], [300, 100], [300, 300]), closed: false })], [[250, 150, 255, 255], [150, 250, 0, 0]]));
  it('T12 square in square: same winding fills, opposite winding is a hole', () => {
    const outer: Pt[] = [[100, 100], [300, 100], [300, 300], [100, 300]], inner: Pt[] = [[150, 150], [250, 150], [250, 250], [150, 250]];
    expect(Math.round(fillCoverage([outer, inner], 400, 400)[200 * 400 + 200] * 255)).toBe(255);
    expect(Math.round(fillCoverage([outer, [...inner].reverse()], 400, 400)[200 * 400 + 200] * 255)).toBe(0);
  });
  it('R raster placement, sampling, frame hold and range', () => {
    // R1: identity, a binary matte stays binary
    const r1 = { width: 1280, height: 534, data: new Float32Array(1280 * 534).map((_, i) => i % 1280 < 640 ? 1 : 0) };
    const p1 = rasterPlacement({ kind: 'source', width: 1280, height: 534 }, 1280, 534, 1280, 534);
    expect([p1.sx, p1.sy, p1.ox, p1.oy]).toEqual([1, 1, 0, 0]);
    expect(rasterCoverage(r1, { kind: 'source', width: 1280, height: 534 }, 1280, 534).every((v, i) => v === r1.data[i])).toBe(true);
    // R2: item box 1080 × 1920
    const p2 = rasterPlacement({ kind: 'source', width: 1280, height: 534 }, 1280, 534, 1080, 1920);
    expect(p2.s).toBeCloseTo(3.595506, 6); expect(p2.sx).toBeCloseTo(3.595506, 6); expect(p2.sy).toBeCloseTo(3.595506, 6);
    expect(p2.ox).toBeCloseTo(-1761.124, 3); expect(p2.oy).toBeCloseTo(0, 3);
    // R3: raster 640 × 267 at scale 2, edge between texel k − 1 (0) and k (1)
    const k = 320, r3 = { width: 640, height: 267, data: new Float32Array(640 * 267).map((_, i) => i % 640 >= k ? 1 : 0) };
    const c3 = rasterCoverage(r3, { kind: 'source', width: 1280, height: 534 }, 1280, 534), row = 200 * 1280;
    expect([2 * k - 2, 2 * k - 1, 2 * k, 2 * k + 1].map(x => c3[row + x])).toEqual([0, 0.25, 0.75, 1]);
    // R4: frame hold
    expect(pickRasterFrame([0, 41708, 83417], sourceUs(60))).toBe(1);
    expect(pickRasterFrame([0, 41708, 83417], sourceUs(41.707))).toBe(0);
    // R5: outside [sourceStartUs, sourceEndUs) the mask is absent and the item fully visible
    const r5 = { enabled: true, mode: 'add', raster: { sourceStartUs: 0, sourceEndUs: 30_000_000, space: { kind: 'item', width: 400, height: 400 } } };
    expect(rasterActive(r5, sourceUs(30000))).toBe(false);
    expect(maskAlpha([r5], { W: 400, H: 400, propertyTimeMs: 0, sourceTimeUs: sourceUs(30000) })).toBeNull();
  });
  it('N2 a smart raster mask without a finite source range throws instead of rendering the item unmasked', () => {
    // Review repro: no sourceStartUs / sourceEndUs on the mask or on mask.raster.
    const smart = { id: 'm1', enabled: true, mode: 'add', source: 'smart', raster: { space: { kind: 'item', width: 4, height: 4 } } };
    expect(() => maskAlpha([smart], { W: 4, H: 4, propertyTimeMs: 0, sourceTimeUs: 0 })).toThrow('sourceStartUs / sourceEndUs missing');
    const half = { ...smart, raster: { ...smart.raster, sourceStartUs: 0, sourceEndUs: Number.NaN } };
    expect(() => maskAlpha([half], { W: 4, H: 4, propertyTimeMs: 0, sourceTimeUs: 0 })).toThrow('not finite');
  });
  it('K path and property keyframes', () => {
    const moved = square.map(p => ({ anchor: { x: p.anchor.x + 100, y: p.anchor.y } }));
    const kf = (a: any, b: any, ta: number, tb: number) => ({ points: [], keyframes: { path: { keyframes: [{ time: ta, value: '', points: a, easing: 'linear' }, { time: tb, value: '', points: b, easing: 'linear' }] } } });
    // K1: t = 250 ms → x 175–275
    const xs = pathAt(kf(square, moved, 0, 1000), 250)[0].pts.map(p => p[0]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([175, 275]);
    // K2: gap ≤ 50 ms → nearest keyframe, a tie picks A
    const k2 = kf(square, moved, 0, 40), first = (t: number) => pathAt(k2, t)[0].pts[0][0];
    expect([first(15), first(20), first(25)]).toEqual([150, 150, 250]);
    // K3: different point counts → hard switch at e = 0.5
    const five = pts([150, 150], [250, 150], [250, 250], [150, 250], [140, 200]), k3 = kf(square, five, 0, 1000);
    expect(pathAt(k3, 499)[0].pts.length).toBe(4); expect(pathAt(k3, 500)[0].pts.length).toBe(5);
    // K4: feather keyframes 0 → 50 over 0–1000 ms
    expect(maskAt({ points: square, keyframes: { feather: { keyframes: [{ time: 0, value: 0 }, { time: 1000, value: 50 }] } } }, 500).feather).toBe(25);
    // K5: trim.from 1000, display.from 5000, rate 2, frame time 6000 → property time 3000
    expect(propertyTime({ id: 'k5', type: 'video', trackId: 'V1', display: { from: 5000, to: 9000 }, trim: { from: 1000 }, playbackRate: 2 }, 6000 - 5000)).toBe(3000);
  });
  it('C createMask canvas → item-local coordinates', () => {
    const box: Box = { x: 100, y: 50, W: 400, H: 400, sx: 0.5, sy: 0.5, rotation: 0, skew: 0, flipX: false, flipY: false };
    const a = canvasToItem(box, { x: 200, y: 150 }), b = canvasToItem(box, { x: 250, y: 150 });
    for (const [p, e] of [[a, [200, 200]], [b, [300, 200]]] as const) { expect(Math.abs(p.x - e[0])).toBeLessThan(1e-6); expect(Math.abs(p.y - e[1])).toBeLessThan(1e-6); }
  });
});

// §54.2 (1.3) / §53.2.4: coverage = the exact area of each pixel inside the polygon, in x and in y. Expected values
// are worked out by hand; the 16-sub-row sampling the oracle used before gives the values in brackets.
describe('exact area anti-aliasing', () => {
  it('positionY 10.2 probe: a 4 × 4 image quad at y 10.2–14.2 (no rounding tie)', () => {
    // Row 10 is 0.8 covered → 0.8 × 255 = 204 [16 sub-rows: 13/16 → 207]. Row 14 is 0.2 covered → 51 [3/16 → 48].
    // (The review's 10.3 sits on the tie 0.7 × 255 = 178.5; the double 10.3 rounds it to 178.)
    const c = fillCoverage([[[0, 10.2], [4, 10.2], [4, 14.2], [0, 14.2]]], 4, 20);
    expect(c[10 * 4 + 1]).toBe(Math.fround(11 - 10.2));
    expect([9, 10, 11, 13, 14, 15].map(y => code(c, 4, 1, y))).toEqual([0, 204, 255, 255, 51, 0]);
  });
  it('fractional-y edges: rect x 1–3, y 2.03–4.6', () => {
    // row 2: 1 − 0.03 = 0.97 → 247.35 → 247 [16/16 → 255]; row 4: 0.6 → 153 [10/16 → 159]
    const c = fillCoverage([[[1, 2.03], [3, 2.03], [3, 4.6], [1, 4.6]]], 4, 6);
    expect([1, 2, 3, 4, 5].map(y => code(c, 4, 1, y))).toEqual([0, 247, 255, 153, 0]);
    expect([0, 3].map(x => code(c, 4, x, 3))).toEqual([0, 0]);
  });
  it('fractional-x-and-y corners: rect x 1.35–3.8, y 2.4–4.8, and a sloped corner', () => {
    // column widths 0.65 / 1 / 0.8, row heights 0.6 / 1 / 0.8; each pixel = width × height
    // (1,2) 0.39 → 99 [0.65 × 10/16 → 104], (2,2) 0.6 → 153 [159], (3,2) 0.48 → 122, (1,3) 0.65 → 166,
    // (3,3) 0.8 → 204, (1,4) 0.52 → 133, (2,4) 0.8 → 204 [13/16 → 207], (3,4) 0.64 → 163 [0.8 × 13/16 → 166]
    const c = fillCoverage([[[1.35, 2.4], [3.8, 2.4], [3.8, 4.8], [1.35, 4.8]]], 5, 6);
    const grid = [2, 3, 4].map(y => [1, 2, 3].map(x => code(c, 5, x, y)));
    expect(grid).toEqual([[99, 153, 122], [166, 255, 204], [133, 204, 163]]);
    expect([code(c, 5, 0, 2), code(c, 5, 4, 3), code(c, 5, 2, 1), code(c, 5, 2, 5)]).toEqual([0, 0, 0, 0]);
    // right triangle (1.2,1.3) (1.9,1.3) (1.2,1.8) inside pixel (1,1): area 0.7 × 0.5 / 2 = 0.175 → 44.625 → 45 [42]
    const t = fillCoverage([[[1.2, 1.3], [1.9, 1.3], [1.2, 1.8]]], 3, 3);
    expect([code(t, 3, 1, 1), code(t, 3, 0, 1), code(t, 3, 2, 1), code(t, 3, 1, 0), code(t, 3, 1, 2)]).toEqual([45, 0, 0, 0, 0]);
  });
});
