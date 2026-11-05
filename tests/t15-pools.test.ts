// SPDX-License-Identifier: AGPL-3.0-only
// T15 pool formulas, no browser. Written-spec oracle: findings §5 (decoder pool clamp(floor(cores / 2), 3, 6)) and §13 (colour/alpha
// merge pool clamp(cores, 1, 4)). The byte-budget eviction needs real workers and runs in tests/ui/t15-pools.spec.ts.
// The packing (left RGB, right alpha in channel 0) is provisional P2 (our FX-1 layout, not a stated Xapp fact).
import { describe, it, expect } from 'vitest';
import { decoderCount } from '../apps/web/src/render/decoder-pool';
import { STACKED_ALPHA, halves, mergeCount, mergeHalves } from '../apps/web/src/render/merge-pool';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

describe('T15 pool sizes (written-spec oracle: §5 and §13)', () => {
  it('decoder pool = clamp(floor(cores / 2), 3, 6) for 1..64 cores', () => {
    for (let cores = 1; cores <= 64; cores++) expect(decoderCount(cores), `cores ${cores}`).toBe(clamp(Math.floor(cores / 2), 3, 6));
  });
  it('decoder pool corner values', () => {
    expect([1, 2, 6, 7, 8, 11, 12, 13, 64].map(c => decoderCount(c))).toEqual([3, 3, 3, 3, 4, 5, 6, 6, 6]);
  });
  it('merge pool = clamp(cores, 1, 4) for 1..64 cores', () => {
    for (let cores = 1; cores <= 64; cores++) expect(mergeCount(cores), `cores ${cores}`).toBe(clamp(cores, 1, 4));
  });
  it('merge pool corner values (0 cores floors at 1)', () => {
    expect([0, 1, 2, 3, 4, 5, 64].map(c => mergeCount(c))).toEqual([1, 1, 2, 3, 4, 4, 4]);
  });
});

// A frame `width` px wide: left half straight RGB, right half R = G = B = alpha (provisional P2).
function stacked(width: number, height: number, rgb: (x: number, y: number) => number[], alpha: (x: number, y: number) => number) {
  const w = width >> 1, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < w; x++) {
    const c = (y * width + x) * 4, a = (y * width + x + (width - w)) * 4, [r, g, b] = rgb(x, y), al = alpha(x, y);
    data.set([r, g, b, 255], c); data.set([al, al, al, 255], a);
  }
  return data;
}

describe('T15 stacked-alpha merge on synthetic halves (formula oracle: out.rgb = colour half, out.a = alpha half channel 0; P2 layout)', () => {
  it('the layout constant and the half offsets', () => {
    expect(STACKED_ALPHA).toEqual({ colour: 'left', alpha: 'right', channel: 0 });
    expect(halves(8)).toEqual({ colourX: 0, alphaX: 4 });
    expect(halves(10)).toEqual({ colourX: 0, alphaX: 5 });
    expect(halves(9)).toEqual({ colourX: 0, alphaX: 5 }); // odd width: the output is floor(w / 2) wide, the alpha half is the right floor(w / 2) columns
  });
  it('every pixel: rgb from the left half, alpha from channel 0 of the right half, over a gradient', () => {
    const W = 64, H = 16, w = W >> 1, rgb = (x: number, y: number) => [x * 8 % 256, y * 16 % 256, (x + y) * 5 % 256], alpha = (x: number, y: number) => (x * 7 + y * 13) % 256;
    const src = stacked(W, H, rgb, alpha), { colourX, alphaX } = halves(W), out = mergeHalves(src, W, H, colourX, alphaX, STACKED_ALPHA.channel);
    expect(out.length).toBe(w * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < w; x++) expect([...out.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)], `(${x},${y})`).toEqual([...rgb(x, y), alpha(x, y)]);
  });
  it('alpha is exact for all 256 levels and straight colour is not premultiplied', () => {
    const W = 512, H = 1, rgb = () => [200, 100, 50], alpha = (x: number) => x, out = mergeHalves(stacked(W, H, rgb, alpha), W, H, 0, W >> 1, 0);
    for (let x = 0; x < 256; x++) expect([...out.subarray(x * 4, x * 4 + 4)]).toEqual([200, 100, 50, x]);
  });
  it('only the chosen channel of the alpha half is read', () => {
    const W = 4, H = 1, src = new Uint8ClampedArray(W * 4);
    src.set([10, 20, 30, 255, 40, 50, 60, 255, 1, 2, 3, 255, 4, 5, 6, 255]);
    expect([...mergeHalves(src, W, H, 0, 2, 0)]).toEqual([10, 20, 30, 1, 40, 50, 60, 4]);
    expect([...mergeHalves(src, W, H, 0, 2, 1)]).toEqual([10, 20, 30, 2, 40, 50, 60, 5]);
    expect([...mergeHalves(src, W, H, 0, 2, 2)]).toEqual([10, 20, 30, 3, 40, 50, 60, 6]);
  });
  it('the worker source is self-contained: the function rebuilt from its text gives the same bytes', () => {
    const W = 32, H = 8, src = stacked(W, H, (x, y) => [x * 3, y * 9, 255 - x], (x, y) => x * 11 + y), { colourX, alphaX } = halves(W);
    const rebuilt = new Function(`return (${mergeHalves.toString()})`)() as typeof mergeHalves;
    expect([...rebuilt(src, W, H, colourX, alphaX, 0)]).toEqual([...mergeHalves(src, W, H, colourX, alphaX, 0)]);
  });
  it('an odd width drops the middle column: output is floor(width / 2) wide', () => {
    const W = 9, H = 2, out = mergeHalves(new Uint8ClampedArray(W * H * 4), W, H, ...(({ colourX, alphaX }) => [colourX, alphaX] as const)(halves(W)), 0);
    expect(out.length).toBe(4 * H * 4);
  });
});
