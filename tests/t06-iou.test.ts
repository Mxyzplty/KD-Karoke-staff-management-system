// SPDX-License-Identifier: AGPL-3.0-only
// T06 formula oracle: the points addShape generates for each of the 6 presets, rasterised with the exact-area oracle rasteriser
// (parity/oracle/masks.ts buildPath + fillCoverage, 512 × 512), against the analytic ideal of the shape (tickets §T06 Acceptance:
// IoU >= 0.99; master plan F24 "C-gt until G-04 is stored"). NOT Xapp parity: no Xapp capture is read.
//   rectangle  the box (roundness > 0: corners cut by quarter ellipses with semi-axes 0.45 r w and 0.45 r h, the extent the written rule
//              puts the corner anchors at; the rule's 0.55 handle is the part under test)
//   ellipse    the inscribed ellipse        triangle  the isosceles triangle (apex top-centre)
//   pentagon   the regular pentagon, R = min(w, h) / 2 about the box centre, first vertex up
//   star       the regular 5-point star, outer R, inner 0.4 R, first vertex up
//   heart      no closed form: a dense sampling (64 steps per segment) of the heart's six cubic segments, restated here in units of the
//              heart's width W and height H = 0.9 h. It restates the generator's own control points (the Xapp heart is awaiting the
//              Author-run compare), so it checks sampling, closing and placement, not the Xapp shape.
// Soft IoU = sum of min / sum of max of the two coverage planes. Bounds/roundness sets: 320 × 240, 200 × 200, 300 × 150 (rectangle
// roundness 40; the other types ignore roundness or have no analytic rounded form), and a tall 100 × 400.
import { describe, expect, it } from 'vitest';
import { buildPath, fillCoverage, type MaskPoint, type Pt } from '../parity/oracle/masks';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, mkTrack, video } from './t03-fixtures';

const SIZE = 512, OX = 20, OY = 30, MIN = 0.99;
type Set = { w: number; h: number; roundness: number };
const SETS: Set[] = [{ w: 320, h: 240, roundness: 0 }, { w: 200, h: 200, roundness: 0 }, { w: 300, h: 150, roundness: 40 }, { w: 100, h: 400, roundness: 0 }];
const TYPES = ['rectangle', 'ellipse', 'triangle', 'pentagon', 'star', 'heart'] as const;

const soft = (a: Float32Array, b: Float32Array) => { let lo = 0, hi = 0; for (let k = 0; k < a.length; k++) { lo += Math.min(a[k], b[k]); hi += Math.max(a[k], b[k]); } return hi ? lo / hi : 1; };
const plane = (rings: Pt[][]) => fillCoverage(rings, SIZE, SIZE);

/** What addShape stored, in canvas px: the item-local points plus the item box origin, as one filled path. */
function generated(type: string, s: Set) {
  const e = createEditor(build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')], items: [video('v1', 'V1', 0, 4000)] }));
  const r = e.call('addShape', { shape: type, bounds: { x: OX, y: OY, width: s.w, height: s.h }, roundness: s.roundness || undefined, duration: 2, trackId: 'O1', timelineStart: 0 }) as any;
  expect(r.success, JSON.stringify(r)).toBe(true);
  const i = e.doc.items.find(x => x.id === r.data.itemId) as any, px = i.properties.positionX.defaultValue, py = i.properties.positionY.defaultValue;
  const points: MaskPoint[] = i.details.points.map((p: any) => ({ anchor: { x: p.anchor.x + px, y: p.anchor.y + py },
    ...(p.handleIn ? { handleIn: p.handleIn } : {}), ...(p.handleOut ? { handleOut: p.handleOut } : {}) }));
  return { points, px, py, rings: buildPath(points, i.details.closed).map(q => q.pts) };
}

const poly = (pts: Pt[]): Pt[][] => [pts];
const regular = (cx: number, cy: number, n: number, radius: (k: number) => number): Pt[] => Array.from({ length: n }, (_, k) => {
  const t = (-90 + 360 / n * k) * Math.PI / 180; return [cx + radius(k) * Math.cos(t), cy + radius(k) * Math.sin(t)] as Pt;
});
const ellipse = (cx: number, cy: number, a: number, b: number, n = 4096): Pt[] => Array.from({ length: n }, (_, k) => [cx + a * Math.cos(2 * Math.PI * k / n), cy + b * Math.sin(2 * Math.PI * k / n)] as Pt);
/** Rectangle with quarter-ellipse corners of semi-axes (a, b). */
function roundedRect(x: number, y: number, w: number, h: number, a: number, b: number, n = 512): Pt[] {
  const arc = (cx: number, cy: number, from: number) => Array.from({ length: n + 1 }, (_, k) => { const t = from + (Math.PI / 2) * k / n; return [cx + a * Math.cos(t), cy + b * Math.sin(t)] as Pt; });
  return [...arc(x + w - a, y + b, -Math.PI / 2), ...arc(x + w - a, y + h - b, 0), ...arc(x + a, y + h - b, Math.PI / 2), ...arc(x + a, y + b, Math.PI)];
}
/** The heart in units of its width W and height H: six cubic segments, start (0.5, 1), clockwise on screen. */
const HEART: [number, number][][] = [
  [[0.5, 1], [0.3, 8 / 9], [0, 2 / 3], [0, 1 / 3]], [[0, 1 / 3], [0, 1 / 9], [0.1, 0], [0.25, 0]], [[0.25, 0], [0.35, 0], [0.425, 1 / 9], [0.5, 2 / 9]],
  [[0.5, 2 / 9], [0.575, 1 / 9], [0.65, 0], [0.75, 0]], [[0.75, 0], [0.9, 0], [1, 1 / 9], [1, 1 / 3]], [[1, 1 / 3], [1, 2 / 3], [0.7, 8 / 9], [0.5, 1]],
];
function heart(x: number, y: number, W: number, H: number, n = 64): Pt[] {
  return HEART.flatMap(([p0, p1, p2, p3]) => Array.from({ length: n }, (_, k) => {
    const t = k / n, u = 1 - t, c = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3], at = (d: 0 | 1) => c[0] * p0[d] + c[1] * p1[d] + c[2] * p2[d] + c[3] * p3[d];
    return [x + W * at(0), y + H * at(1)] as Pt;
  }));
}

/** The analytic ideal of `type` for bounds (OX, OY, w, h) and the generated item's box origin (the heart is placed by it). */
function ideal(type: string, s: Set, px: number, py: number): Pt[][] {
  const { w, h } = s, cx = OX + w / 2, cy = OY + h / 2, R = Math.min(w, h) / 2;
  switch (type) {
    case 'rectangle': return poly(s.roundness ? roundedRect(OX, OY, w, h, 0.45 * (s.roundness / 100) * w, 0.45 * (s.roundness / 100) * h) : [[OX, OY], [OX + w, OY], [OX + w, OY + h], [OX, OY + h]]);
    case 'ellipse': return poly(ellipse(cx, cy, w / 2, h / 2));
    case 'triangle': return poly([[OX + w / 2, OY], [OX + w, OY + h], [OX, OY + h]]);
    case 'pentagon': return poly(regular(cx, cy, 5, () => R));
    case 'star': return poly(regular(cx, cy, 10, k => k % 2 ? 0.4 * R : R));
    default: return poly(heart(px, py, w, 0.9 * h));
  }
}

describe('T06 formula oracle: generated presets against the analytic ideal (IoU >= 0.99, 512 × 512, exact-area anti-aliasing)', () => {
  const cases = TYPES.flatMap(type => SETS.map(s => [type, s] as const));
  // Roundness is applied to the rectangle only: triangle / pentagon / star round their corners too, but have no analytic rounded ideal.
  it.each(cases)('%s %o', (type, set) => {
    const s = type === 'rectangle' ? set : { ...set, roundness: 0 };
    const g = generated(type, s), iou = soft(plane(g.rings), plane(ideal(type, s, g.px, g.py)));
    expect(iou, `${type} ${s.w}x${s.h} roundness ${s.roundness}`).toBeGreaterThanOrEqual(MIN);
  });

  it('rounding triangle / pentagon / star at roundness 40 keeps their shape close to the sharp ideal (IoU between 0.9 and 0.99: corners cut, nothing else moved)', () => {
    const s = SETS[2];
    for (const type of ['triangle', 'pentagon', 'star']) {
      const g = generated(type, s), iou = soft(plane(g.rings), plane(ideal(type, { ...s, roundness: 0 }, g.px, g.py)));
      expect(iou, type).toBeGreaterThan(0.9); expect(iou, type).toBeLessThan(MIN);
    }
  });

  it('the metric is not vacuous: a 5 px shift of the rectangle, a swapped shape and a 90% scale each fall below 0.99', () => {
    const s = SETS[0], g = generated('rectangle', s), want = plane(ideal('rectangle', s, g.px, g.py));
    const shifted = plane(g.rings.map(r => r.map(([x, y]) => [x + 5, y] as Pt)));
    expect(soft(shifted, want)).toBeLessThan(MIN);
    expect(soft(plane(generated('ellipse', s).rings), want)).toBeLessThan(MIN);
    expect(soft(plane(g.rings.map(r => r.map(([x, y]) => [OX + (x - OX) * 0.9, OY + (y - OY) * 0.9] as Pt))), want)).toBeLessThan(MIN);
    expect(soft(plane(g.rings), want)).toBeGreaterThanOrEqual(MIN);
  });

  it('a rounded rectangle differs from the plain one: roundness 40 removes area at the corners', () => {
    const s = SETS[2], round = generated('rectangle', s), plain = generated('rectangle', { ...s, roundness: 0 });
    const area = (rings: Pt[][]) => plane(rings).reduce((a, b) => a + b, 0);
    expect(area(round.rings)).toBeLessThan(area(plain.rings) - 100); expect(area(plain.rings)).toBeCloseTo(s.w * s.h, 0);
  });
});
