// SPDX-License-Identifier: AGPL-3.0-only
// T12 auto-foreground seeds (part 3 §44.7): a person's instance mask takes in the salient region that is the same object, what they carry.
import { describe, expect, it } from 'vitest';
import { withCarried, type Seed } from '../apps/web/src/masks/foreground';

const SIZE = 64;
const rect = (x0: number, y0: number, x1: number, y1: number) => { const m = new Uint8Array(SIZE * SIZE); for (let y = y0; y < y1; y++) m.fill(1, y * SIZE + x0, y * SIZE + x1); return m; };
const person = (mask: Uint8Array): Seed => ({ mask, point: [20, 20] });
const prob = (...masks: Uint8Array[]) => Float32Array.from({ length: SIZE * SIZE }, (_, i) => masks.some(m => m[i]) ? .9 : .1);
const area = (m: Uint8Array) => m.reduce((n, v) => n + v, 0);

describe('withCarried', () => {
  it('widens a person to the salient region that is the same object, and keeps the click on the person', () => {
    const body = rect(10, 10, 30, 40), kit = rect(30, 15, 38, 35), [seed] = withCarried([person(body)], prob(body, kit), SIZE);
    expect(area(seed.mask)).toBe(area(body) + area(kit));
    expect(seed.point).toEqual([20, 20]);
  });
  it('known limit: a smaller unrelated object in one salient blob with the person is taken along (160 px here). Pinned, not tuned: to this rule it looks like what a person carries', () => {
    const body = rect(10, 10, 30, 40), stone = rect(30, 15, 38, 35), [seed] = withCarried([person(body)], prob(body, stone), SIZE);
    expect(area(seed.mask) - area(body)).toBe(160);
  });
  it('takes nothing from a region that is another object, even where it touches the person', () => {
    const body = rect(10, 10, 30, 40), stone = rect(28, 0, 64, 64), [seed] = withCarried([person(body)], prob(stone), SIZE);
    expect(seed.mask).toEqual(body);
  });
  it('leaves each man of a group as he is when the group is one salient blob', () => {
    const men = [rect(4, 10, 20, 50), rect(24, 10, 40, 50), rect(44, 10, 60, 50)], blob = rect(4, 10, 60, 50), seeds = withCarried(men.map(person), prob(blob), SIZE);
    expect(seeds.map(s => s.mask)).toEqual(men);
  });
  it('changes nothing when nothing stands out', () => {
    const body = rect(10, 10, 30, 40);
    expect(withCarried([person(body)], new Float32Array(SIZE * SIZE), SIZE)[0].mask).toEqual(body);
  });
});
