// SPDX-License-Identifier: AGPL-3.0-only
// T12 smart-mask strokes, pure (SM-P01): brushRadius, drawnStroke/evenly, thinStrokes, strokeProblem.
import { describe, expect, it } from 'vitest';
import { brushRadius, drawnStroke, STROKE_LIMITS, strokeProblem, thinStrokes, type Stroke } from '../apps/web/src/masks/strokes';

describe('brushRadius', () => {
  it('24 px diameter on a 534 px short side → 0.0224719', () => {
    expect(brushRadius(24, 534)).toBeCloseTo(0.0224719, 7);
  });
});

describe('drawnStroke (UI resample to 64 points)', () => {
  it('fewer points than the limit pass through unchanged', () => {
    const points: [number, number][] = [[0, 0], [0.1, 0.1], [0.2, 0.2]];
    const s = drawnStroke(1, points, 0.1);
    expect(s).toEqual({ label: 1, radius: 0.1, points });
  });
  it('more points than the limit resample to 64, keeping the first and last', () => {
    const points: [number, number][] = Array.from({ length: 100 }, (_, i) => [i / 100, i / 100]);
    const s = drawnStroke(0, points, 0.2);
    expect(s.points).toHaveLength(STROKE_LIMITS.uiPoints);
    expect(s.points[0]).toEqual(points[0]);
    expect(s.points[s.points.length - 1]).toEqual(points[99]);
  });
});

describe('thinStrokes (model-prompt resample to 12 points/stroke, 4 source-px label spacing)', () => {
  it('resamples a long stroke to at most 12 points, keeping the first and last, when spaced well past 4px', () => {
    const points: [number, number][] = Array.from({ length: 20 }, (_, i) => [i * 0.01, 0]);
    const [s] = thinStrokes([{ label: 1, points, radius: 0.1 }], 1000, 1000);
    expect(s.points).toHaveLength(STROKE_LIMITS.promptPoints);
    expect(s.points[0]).toEqual(points[0]);
    expect(s.points[s.points.length - 1]).toEqual(points[19]);
  });
  it('drops a same-label point within 4 source px of an already-kept point, across strokes, keeps another label at the same spot, and drops an emptied stroke entirely', () => {
    const strokes: Stroke[] = [
      { label: 1, points: [[0, 0], [0.01, 0], [0.02, 0]], radius: 0.1 }, // A: 0px,1px,2px — only the first (0,0) survives
      { label: 1, points: [[0.5, 0.5]], radius: 0.1 }, // B: far away, kept
      { label: 0, points: [[0, 0]], radius: 0.1 }, // C: same spot as A's kept point, different label — kept
      { label: 1, points: [[0.005, 0]], radius: 0.1 }, // D: 0.5px from A's kept point — dropped, stroke emptied
    ];
    const result = thinStrokes(strokes, 100, 100);
    expect(result).toEqual([
      { label: 1, points: [[0, 0]], radius: 0.1 },
      { label: 1, points: [[0.5, 0.5]], radius: 0.1 },
      { label: 0, points: [[0, 0]], radius: 0.1 },
    ]);
  });
});

describe('M11: the radius limit the Brush size field is clamped to (tests/ui/t12-mask-ui.spec.ts holds the field)', () => {
  it('the largest diameter on a 534 px short side, 267, is exactly the limit', () => {
    expect(strokeProblem([drawnStroke(1, [[0.5, 0.5]], brushRadius(267, 534))])).toBeNull();
    expect(strokeProblem([drawnStroke(1, [[0.5, 0.5]], brushRadius(268, 534))])).not.toBeNull();
  });
  it('radius exactly 0 and exactly 0.25 (the limit itself) both stay valid, unclamped', () => {
    const stroke = (radius: number): Stroke => ({ label: 1, points: [[0.5, 0.5]], radius });
    expect(strokeProblem([stroke(0)])).toBeNull();
    expect(strokeProblem([stroke(0.25)])).toBeNull();
  });
});

describe('strokeProblem (transport validation)', () => {
  const stroke = (over: Partial<Stroke> = {}): Stroke => ({ label: 1, points: [[0, 0]], radius: 0.1, ...over });

  it('0 strokes: count message', () => {
    expect(strokeProblem([])).toBe('A selection has 1 to 64 strokes.');
  });
  it('65 strokes: count message', () => {
    expect(strokeProblem(Array.from({ length: 65 }, () => stroke()))).toBe('A selection has 1 to 64 strokes.');
  });
  it('no include stroke: include message', () => {
    expect(strokeProblem([stroke({ label: 0 })])).toBe('A selection needs at least one include stroke.');
  });
  it('radius .26: radius message', () => {
    expect(strokeProblem([stroke({ radius: 0.26 })])).toBe('A stroke radius is at most 0.25 of the shorter side.');
  });
  it('a point outside 0–1: range message', () => {
    expect(strokeProblem([stroke({ points: [[1.01, 0]] })])).toBe('Stroke points are fractions of the frame, from 0 to 1.');
  });
  it('4,097 points across strokes: points message', () => {
    expect(strokeProblem([stroke({ points: Array.from({ length: 4097 }, () => [0.5, 0.5]) })])).toBe('A selection has at most 4096 points.');
  });
  it('64 strokes, 4,096 points, radius .25: passes', () => {
    const strokes = Array.from({ length: 64 }, (_, i) => stroke({ label: i === 0 ? 1 : 0, points: Array.from({ length: 64 }, () => [0.5, 0.5]), radius: 0.25 }));
    expect(strokeProblem(strokes)).toBeNull();
  });
});
