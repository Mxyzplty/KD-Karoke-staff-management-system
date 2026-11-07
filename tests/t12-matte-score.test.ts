// SPDX-License-Identifier: AGPL-3.0-only
// T12 oracle scores (BG-P01, BG-P03, SM-P02, SM-P03): binary, iou, boundaryF, flicker, scoreFrames. All expected values
// hand-computed from the definitions in matte-score.ts, not copied from its own output.
import { describe, expect, it } from 'vitest';
import { binary, boundaryF, flicker, iou, scoreFrames } from '../apps/web/src/masks/tools/matte-score';

const plane = (bits: number[]) => Uint8Array.from(bits);

describe('binary', () => {
  it('thresholds at 128 by default', () => {
    expect(binary(plane([0, 127, 128, 255]))).toEqual(plane([0, 0, 1, 1]));
  });
  it('a custom threshold', () => {
    expect(binary(plane([100, 200, 255]), 200)).toEqual(plane([0, 1, 1]));
  });
});

describe('iou', () => {
  it('identical masks: 1', () => { expect(iou(plane([1, 1, 0, 0]), plane([1, 1, 0, 0]))).toBe(1); });
  it('partial overlap: both 1, either 3 → 1/3', () => { expect(iou(plane([1, 1, 0, 0]), plane([0, 1, 1, 0]))).toBeCloseTo(1 / 3, 10); });
  it('both empty: 1 (vacuously perfect)', () => { expect(iou(plane([0, 0, 0, 0]), plane([0, 0, 0, 0]))).toBe(1); });
  it('one empty, one not: 0', () => { expect(iou(plane([0, 0, 0, 0]), plane([1, 0, 0, 0]))).toBe(0); });
});

// boundaryF: a 2-wide block in an 8x1 row (W=8,H=1), shifted so the nearest-cell distance to A sits just inside,
// then just outside, the default 2 px band. A's own boundary is both its cells (x=1,2): each has an empty neighbor
// on its outer side, and Cutframe's own array (not a combined grid), so the two blocks never touch each other.
const row = (xs: number[], W: number) => { const m = new Uint8Array(W); for (const x of xs) m[x] = 1; return m; };
describe('boundaryF: a shifted block, inside and outside the 2 px band', () => {
  const A = row([1, 2], 8);
  it('nearest cells 1 px apart (x=2 to x=3, within the band): every boundary pixel has a match, F = 1', () => {
    const B = row([3, 4], 8);
    expect(boundaryF(A, B, 8, 1)).toBe(1);
  });
  it('nearest cells 3 px apart (x=2 to x=5, past the band): no boundary pixel has a match, F = 0', () => {
    const B = row([5, 6], 8);
    expect(boundaryF(A, B, 8, 1)).toBe(0);
  });
});
describe('boundaryF: empty masks', () => {
  it('both empty: 1 (no boundary disagreement is possible)', () => {
    const empty = new Uint8Array(16);
    expect(boundaryF(empty, empty, 4, 4)).toBe(1);
  });
  it('one empty, one with content: 0', () => {
    // A 2x2 block at (x,y) 1,1–2,2 inside a 4x4 grid (16 cells, index = y*4+x): indices 5, 6, 9, 10.
    const empty = new Uint8Array(16), block = plane([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    expect(boundaryF(empty, block, 4, 4)).toBe(0);
    expect(boundaryF(block, empty, 4, 4)).toBe(0);
  });
});
describe('boundaryF: the picture border is not a boundary', () => {
  it('a fully filled frame has no boundary pixels, so two of them score 1, not 0', () => {
    const full = new Uint8Array(9).fill(1); // a 3x3 frame, entirely foreground
    expect(boundaryF(full, full, 3, 3)).toBe(1);
  });
});

describe('flicker', () => {
  it('fewer than 2 frames: 0', () => { expect(flicker([plane([1, 0, 1, 0])])).toBe(0); });
  it('mean share of pixels changing between consecutive frames', () => {
    // frame0→1: index 0 flips (1/4 of the frame). frame1→2: index 1 flips (1/4). Mean over 2 transitions = 1/4.
    const planes = [plane([0, 0, 0, 0]), plane([1, 0, 0, 0]), plane([1, 1, 0, 0])];
    expect(flicker(planes)).toBeCloseTo(0.25, 10);
  });
});

describe('scoreFrames', () => {
  const W = 4, H = 1;
  it('masks match truth on every frame, and nothing flickers: all scores are perfect', () => {
    const frame = plane([1, 1, 0, 0]);
    const r = scoreFrames([frame, frame], [frame, frame], W, H);
    expect(r).toMatchObject({ frames: 2, meanIou: 1, minIou: 1, boundaryF: 1, flickerMask: 0, flickerTruth: 0, flickerRatio: 1 });
  });
  it('a steady truth against a flickering mask gives flickerRatio Infinity, and mixed per-frame iou', () => {
    const truth = [plane([1, 1, 0, 0]), plane([1, 1, 0, 0])]; // unchanging ground truth: flickerTruth = 0
    const masks = [plane([1, 1, 0, 0]), plane([1, 0, 1, 0])]; // frame 0 matches truth exactly, frame 1 does not
    const r = scoreFrames(masks, truth, W, H);
    // frame0: iou 2/2=1. frame1: both={idx0}=1, either={idx0,1,2}=3 → iou 1/3.
    expect(r.frames).toBe(2);
    expect(r.minIou).toBeCloseTo(1 / 3, 10);
    expect(r.meanIou).toBeCloseTo((1 + 1 / 3) / 2, 10);
    expect(r.flickerTruth).toBe(0);
    expect(r.flickerMask).toBeCloseTo(0.5, 10); // 2 of 4 pixels differ between the mask's own two frames
    expect(r.flickerRatio).toBe(Infinity);
  });
});
