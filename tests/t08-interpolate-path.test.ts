// SPDX-License-Identifier: AGPL-3.0-only
// Follow-up item 5a: interpolatePath between different command lists follows d3-interpolate-path 2.3.0, the code Remotion's
// interpolatePath docs say it stems from.
import { describe, expect, it } from 'vitest';
import { interpolatePath } from '../apps/web/src/mg/paths';
import { makeRect, makeStar } from '../apps/web/src/mg/shapes';

type Cmd = [string, ...number[]];
const read = (path: string): Cmd[] => path.trim().split(/\s+(?=[A-Za-z])/).map(c => { const [type, ...n] = c.split(/\s+/); return [type, ...n.map(Number)]; });
const expectPath = (path: string, commands: Cmd[]) => {
  const got = read(path);
  expect(got.map(c => c[0]).join('')).toBe(commands.map(c => c[0]).join(''));
  got.forEach((c, i) => c.slice(1).forEach((v, j) => expect(v).toBeCloseTo(commands[i][j + 1] as number, 9)));
};
const mix = (a: Cmd[], b: Cmd[], t: number): Cmd[] => a.map((c, i) => [c[0], ...c.slice(1).map((v, j) => (1 - t) * (v as number) + t * (b[i][j + 1] as number))]);

describe('square to star (G-06 element 10)', () => {
  const square = makeRect({ width: 200, height: 200 }).path, star = makeStar({ innerRadius: 40, outerRadius: 100, points: 5 }).path;
  // The square's 4 segments extended to the star's 10: ratio 4 / 10, so reference segment i adds a point to square segment
  // floor(0.4 i), giving 3, 2, 3 and 2 equal pieces.
  const extended: Cmd[] = [['M', 0, 0], ['L', 200 / 3, 0], ['L', 400 / 3, 0], ['L', 200, 0], ['L', 200, 100], ['L', 200, 200],
    ['L', 400 / 3, 200], ['L', 200 / 3, 200], ['L', 0, 200], ['L', 0, 100], ['L', 0, 0], ['Z']];
  const starCommands = read(star);
  it('pins both inputs', () => {
    expect(square).toBe('M 0 0 L 200 0 L 200 200 L 0 200 L 0 0 Z');
    expect(starCommands.map(c => c[0]).join('')).toBe('MLLLLLLLLLLZ');
  });
  it.each([0, 0.25, 0.505, 0.75])('at %s mixes the extended square with the star', t => expectPath(interpolatePath(t, square, star), mix(extended, starCommands, t)));
  it('at 1 returns the star as given', () => expect(interpolatePath(1, square, star)).toBe(star));
  it('star to square extends the square on the other side', () => expectPath(interpolatePath(0.25, star, square), mix(starCommands, extended, 0.25)));
});

describe('the d3-interpolate-path steps', () => {
  it('splits a cubic by de Casteljau and converts it to the other list\'s L', () => {
    // C (0,0) (0,100) (100,100) (100,0) halves at (50,75); each half is then an L to its end point.
    expectPath(interpolatePath(0.5, 'M 0 0 C 0 100 100 100 100 0', 'M 0 0 L 50 50 L 100 0'), [['M', 0, 0], ['L', 50, 62.5], ['L', 100, 0]]);
  });
  it('converts L to C with both controls at its end point', () => {
    expectPath(interpolatePath(0.5, 'M 0 0 L 50 50 L 100 0', 'M 0 0 C 0 100 100 100 100 0'),
      [['M', 0, 0], ['C', 25, 50, 37.5, 62.5, 50, 62.5], ['C', 87.5, 37.5, 100, 25, 100, 0]]);
  });
  it('reads implicit repeats as the SVG grammar does (after M as L)', () => {
    expect(interpolatePath(0.5, 'M 0 0 10 0 20 0', 'M 0 0 L 20 0')).toBe('M 0 0 L 10 0 L 20 0');
    // Read as M M, the first path would repeat its start instead of splitting the line (M 0 0 L 2.5 2.5 M 10 5).
    expect(interpolatePath(0.5, 'M 0 0 10 0', 'M 0 0 5 5 10 10')).toBe('M 0 0 L 5 2.5 L 10 5');
  });
  it('adds Z back only when both paths close', () => {
    expect(interpolatePath(0.5, 'M 0 0 L 10 0 Z', 'M 0 0 L 5 0 L 10 0')).toBe('M 0 0 L 5 0 L 10 0');
    expect(interpolatePath(0.5, 'M 0 0 L 10 0 Z', 'M 0 0 L 5 0 L 10 0 z')).toBe('M 0 0 L 5 0 L 10 0 Z');
  });
  it('mixes as (1 - t) a + t b', () => {
    // 0.1 to 0.7 at 0.3: (1 - t) a + t b is 0.27999999999999997, a + (b - a) t is 0.28.
    expect(interpolatePath(0.3, 'M 0 0 L 0.1 0', 'M 0 0 L 0.5 0 L 0.7 0')).toBe(`M 0 0 L ${0.7 * 0.05 + 0.3 * 0.5} 0 L 0.27999999999999997 0`);
  });
});

describe('unchanged cases', () => {
  it('equal command lists keep the per-number mix a + (b - a) t and return path A at 0', () => {
    expect(interpolatePath(0.3, 'M 0 0 L 0.1 0', 'M 0 0 L 0.7 0')).toBe(`M 0 0 L ${0.1 + (0.7 - 0.1) * 0.3} 0`);
    expect(interpolatePath(0.3, 'M 0 0 L 0.1 0', 'M 0 0 L 0.7 0')).not.toBe(`M 0 0 L ${0.7 * 0.1 + 0.3 * 0.7} 0`);
    expect(interpolatePath(0, 'M 0  0 L 1 0', 'M 0 0 L 2 0')).toBe('M 0  0 L 1 0');
  });
  it('the Remotion docs example', () => expect(interpolatePath(0.5, 'M 0 0 L 100 0', 'M 100 0 L 0 0')).toBe('M 50 0 L 50 0'));
  it.each([['arcs', 'M 0 0 A 10 10 0 0 1 20 0'], ['relative commands', 'm 0 0 l 10 0 l 10 0 l 0 5']])('%s are still resampled to 257 points', (_, a) => {
    const path = interpolatePath(0.5, a, 'M 0 0 L 10 0 L 20 0');
    expect(path.match(/[ML]/g)).toHaveLength(257);
    expect(interpolatePath(0, a, 'M 0 0 L 10 0 L 20 0')).toBe(a);
  });
});
