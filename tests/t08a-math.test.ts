// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Easing, interpolate, interpolateColors, spring } from '../apps/web/src/mg/math';
import { makeCircle, makeEllipse, makeHeart, makePie, makePolygon, makeRect, makeStar, makeTriangle } from '../apps/web/src/mg/shapes';
import { fade, linearTiming, slide, springTiming, wipe } from '../apps/web/src/mg/transitions';

describe('motion graphic math', () => {
  it('uses piecewise interpolation, all extrapolation modes, and easing', () => {
    expect(interpolate(15, [0, 10, 20], [0, 20, 100])).toBe(60);
    expect(interpolate(-5, [0, 10], [0, 100])).toBe(-50);
    expect(interpolate(-5, [0, 10], [0, 100], { extrapolateLeft: 'wrap' })).toBe(50);
    expect(interpolate(15, [0, 10], [0, 100], { extrapolateRight: 'identity' })).toBe(15);
    expect(interpolate(15, [0, 10], [0, 100], { extrapolateRight: 'clamp' })).toBe(100);
    expect(interpolate(5, [0, 10], [0, 100], { easing: Easing.quad })).toBe(25);
    expect(() => interpolate(1, [0, 0], [0, 1])).toThrow();
    expect(() => interpolate(1, [0, 1], [0])).toThrow();
    expect(() => interpolate(1, [0, 1], [0, 1], { posterize: 2 } as never)).toThrow();
  });
  it('provides easing functions and modifiers with known values', () => {
    expect(Easing.linear(.5)).toBe(.5); expect(Easing.quad(.5)).toBe(.25);
    expect(Easing.cubic(.5)).toBe(.125); expect(Easing.poly(4)(.5)).toBe(.0625);
    expect(Easing.in(Easing.quad)(.5)).toBe(.25); expect(Easing.out(Easing.quad)(.5)).toBe(.75);
    expect(Easing.inOut(Easing.quad)(.25)).toBe(.125); expect(Easing.inOut(Easing.quad)(.75)).toBe(.875);
    expect(Easing.bezier(0, 0, 1, 1)(.5)).toBeCloseTo(.5, 8);
    for (const fn of [Easing.ease, Easing.sin, Easing.circle, Easing.exp, Easing.elastic(), Easing.back(), Easing.bounce]) {
      expect(fn(0)).toBeCloseTo(0); expect(fn(1)).toBeCloseTo(1);
    }
  });
  it('interpolates colour channels and spring endpoints', () => {
    expect(interpolateColors(.5, [0, 1], ['#000000', '#ffffff'])).toBe('rgba(128, 128, 128, 1)');
    expect(spring({ frame: 0, fps: 30, from: 2, to: 8 })).toBe(2);
    expect(spring({ frame: 30, fps: 30, durationInFrames: 30, from: 2, to: 8 })).toBe(8);
    expect(spring({ frame: 0, fps: 30, delay: 10 })).toBe(0);
    expect(spring({ frame: 10, fps: 30, delay: 10 })).toBe(0);
    expect(spring({ frame: 30, fps: 30, durationInFrames: 30, reverse: true })).toBe(0);
    expect(spring({ frame: 15, fps: 30, config: { mass: 1, damping: 10, stiffness: 100, overshootClamping: true } })).toBeLessThanOrEqual(1);
  });
  it('applies individual spring physics, duration, threshold, delay and reverse options', () => {
    const base = { frame: 10, fps: 30 };
    const natural = spring(base);
    expect(natural).toBeGreaterThan(1);
    expect(spring({ ...base, config: { overshootClamping: true } })).toBe(1);
    for (const config of [{ mass: 2 }, { damping: 20 }, { stiffness: 50 }]) expect(spring({ ...base, config })).not.toBeCloseTo(natural, 3);
    expect(spring({ ...base, durationInFrames: 30, durationRestThreshold: .01 })).not.toBeCloseTo(spring({ ...base, durationInFrames: 30, durationRestThreshold: .1 }), 3);
    expect(spring({ ...base, delay: 10 })).toBe(0);
    expect(spring({ ...base, durationInFrames: 30, reverse: true })).not.toBeCloseTo(spring({ ...base, durationInFrames: 30 }), 3);
  });
});

describe('shape and transition helpers', () => {
  it('applies both corner options to every documented rounded shape', () => {
    const makers = [
      (option: { cornerRadius?: number; edgeRoundness?: number }) => makeRect({ width: 20, height: 16, ...option }),
      (option: { cornerRadius?: number; edgeRoundness?: number }) => makeTriangle({ length: 20, ...option }),
      (option: { cornerRadius?: number; edgeRoundness?: number }) => makeStar({ innerRadius: 5, outerRadius: 10, points: 5, ...option }),
      (option: { cornerRadius?: number; edgeRoundness?: number }) => makePolygon({ radius: 10, points: 5, ...option }),
    ];
    for (const [index, make] of makers.entries()) {
      const sharp = make({});
      for (const option of [{ cornerRadius: 2 }, { edgeRoundness: .5 }]) {
        const rounded = make(option);
        expect(rounded.path).not.toBe(sharp.path);
        // Star and polygon boxes are the bounding box of the drawn outline (§1.5), so rounding can only shrink them.
        if (index >= 2) { expect(rounded.width).toBeLessThanOrEqual(sharp.width); expect(rounded.height).toBeLessThanOrEqual(sharp.height); }
        else expect([rounded.width, rounded.height]).toEqual([sharp.width, sharp.height]);
      }
    }
  });
  it('makes the documented shapes with expected bounding boxes', () => {
    const shapes = [makeRect({ width: 20, height: 10 }), makeCircle({ radius: 5 }), makeEllipse({ rx: 6, ry: 3 }),
      makeTriangle({ length: 20 }), makeStar({ points: 5, innerRadius: 5, outerRadius: 10 }),
      makePolygon({ points: 5, radius: 8 }), makeHeart({ height: 20 }), makePie({ radius: 7, progress: .25 })];
    const sizes = shapes.filter((_, i) => i !== 6).map(s => [s.width, s.height]);
    expect(sizes.filter((_, i) => i !== 4 && i !== 5)).toEqual([[20, 10], [10, 10], [12, 6], [10 * Math.sqrt(3), 20], [14, 14]]);
    // Star and polygon: bounding box of the drawn outline (§1.5), a regular pentagon / 5-point star pointing up.
    const box = (r: number) => [2 * r * Math.sin(72 * Math.PI / 180), r * (1 + Math.cos(36 * Math.PI / 180))];
    expect(sizes[4][0]).toBeCloseTo(box(10)[0], 9); expect(sizes[4][1]).toBeCloseTo(box(10)[1], 9);
    expect(sizes[5][0]).toBeCloseTo(box(8)[0], 9); expect(sizes[5][1]).toBeCloseTo(box(8)[1], 9);
    expect(shapes[6].height).toBe(20); // Exact heart width needs the private reference.
    for (const s of shapes) { expect(s.path).toBeTruthy(); expect(s.transformOrigin).toBeTruthy(); }
    expect(makeRect({ width: 20, height: 10, cornerRadius: 2 }).path).not.toBe(shapes[0].path);
    expect(makeRect({ width: 20, height: 10, edgeRoundness: .5 }).path).not.toBe(shapes[0].path);
    expect(makePie({ radius: 7, progress: .25, counterClockwise: true }).path).not.toBe(shapes[7].path);
    expect(makePie({ radius: 7, progress: .25, closePath: false }).path).not.toBe(shapes[7].path);
  });
  it('implements timing and presentation direction choices', () => {
    const linear = linearTiming({ durationInFrames: 20 });
    expect(linear.getDurationInFrames({ fps: 30 })).toBe(20);
    expect(linear.getProgress({ frame: 10, fps: 30 })).toBe(.5);
    expect(springTiming({ durationInFrames: 18 }).getDurationInFrames({ fps: 30 })).toBe(18);
    expect(fade({ shouldFadeOutExitingScene: true }).shouldFadeOutExitingScene).toBe(true);
    for (const direction of ['from-left', 'from-right', 'from-top', 'from-bottom']) expect(slide({ direction }).direction).toBe(direction);
    for (const direction of ['from-left', 'from-top-left', 'from-top', 'from-top-right', 'from-right', 'from-bottom-right', 'from-bottom', 'from-bottom-left']) expect(wipe({ direction }).direction).toBe(direction);
    expect(() => slide({ direction: 'diagonal' })).toThrow();
  });
});
