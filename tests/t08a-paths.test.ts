// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { evolvePath, interpolatePath, noise3D } from '../apps/web/src/mg/paths';

it('evolves a known-length path both inside and outside the unit interval', () => {
  const path = 'M 0 0 L 30 40';
  expect(evolvePath(0, path)).toEqual({ strokeDasharray: '50 50', strokeDashoffset: 50 });
  expect(evolvePath(.5, path)).toEqual({ strokeDasharray: '50 50', strokeDashoffset: 25 });
  expect(evolvePath(1, path)).toEqual({ strokeDasharray: '50 50', strokeDashoffset: 0 });
  expect(evolvePath(1.5, path).strokeDashoffset).toBe(-25);
  expect(evolvePath(-.5, path).strokeDashoffset).toBe(75);
});

it('interpolates compatible SVG paths including extrapolation and preserves endpoints', () => {
  const a = 'M 0 0 L 10 20', b = 'M 10 20 L 30 40';
  expect(interpolatePath(0, a, b)).toBe(a);
  expect(interpolatePath(1, a, b)).toBe(b);
  expect(interpolatePath(.5, a, b)).toMatch(/^M\s+5\s+10\s+L\s+20\s+30$/);
  expect(interpolatePath(2, a, b)).toMatch(/^M\s+20\s+40\s+L\s+50\s+60$/);
});

it('uses deterministic seeded noise within the documented range', () => {
  const samples = Array.from({ length: 12 }, (_, i) => noise3D('seed-A', i / 7, i / 11, i / 13));
  expect(samples).toEqual(Array.from({ length: 12 }, (_, i) => noise3D('seed-A', i / 7, i / 11, i / 13)));
  expect(samples.every(n => n >= -1 && n <= 1)).toBe(true);
  expect(samples).not.toEqual(Array.from({ length: 12 }, (_, i) => noise3D('seed-B', i / 7, i / 11, i / 13)));
});
