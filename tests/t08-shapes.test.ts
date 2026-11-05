// SPDX-License-Identifier: AGPL-3.0-only
// T08 shape makers, written from "Xapp reference compares and facts (C).md" §1.4 (shape errors), §1.5 (makers) and §1.6 (heart).
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeCircle, makeEllipse, makeHeart, makePie, makePolygon, makeRect, makeStar, makeTriangle, shapeComponents } from '../apps/web/src/mg/shapes';

type Ins = { type: string; [key: string]: unknown };
type Pt = { x: number; y: number };
type Shape = { path: string; width: number; height: number; transformOrigin: string; instructions: Ins[] };

// ---------------------------------------------------------------------------------------------------------------------
// Spec helpers (§1.5 instruction table, path string rule)
// ---------------------------------------------------------------------------------------------------------------------
const FIELDS: Record<string, string[]> = {
  M: ['x', 'y'], m: ['dx', 'dy'], L: ['x', 'y'], l: ['dx', 'dy'], T: ['x', 'y'], t: ['dx', 'dy'],
  H: ['x'], h: ['dx'], V: ['y'], v: ['dy'],
  C: ['cp1x', 'cp1y', 'cp2x', 'cp2y', 'x', 'y'], c: ['cp1dx', 'cp1dy', 'cp2dx', 'cp2dy', 'dx', 'dy'],
  S: ['cpx', 'cpy', 'x', 'y'], Q: ['cpx', 'cpy', 'x', 'y'], s: ['cpdx', 'cpdy', 'dx', 'dy'], q: ['cpdx', 'cpdy', 'dx', 'dy'],
  A: ['rx', 'ry', 'xAxisRotation', 'largeArcFlag', 'sweepFlag', 'x', 'y'], a: ['rx', 'ry', 'xAxisRotation', 'largeArcFlag', 'sweepFlag', 'dx', 'dy'],
  Z: [],
};
// Only these absolute types carry x/y pairs that a path shift moves.
const ABS_XY = new Set(['M', 'L', 'C']);

function serialize(instructions: Ins[], shiftX = 0, shiftY = 0): string {
  return instructions.map(ins => {
    const fields = FIELDS[ins.type];
    if (!fields) throw new Error(`test helper: unknown type ${ins.type}`);
    const vals = fields.map(f => {
      const v = ins[f];
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v !== 'number') throw new Error(`test helper: ${ins.type}.${f} is ${String(v)}`);
      if (ABS_XY.has(ins.type) && (f === 'x' || f.endsWith('x'))) return v - shiftX;
      if (ABS_XY.has(ins.type) && (f === 'y' || f.endsWith('y'))) return v - shiftY;
      return v;
    });
    return [ins.type, ...vals].join(' ');
  }).join(' ');
}

function expectInstructionShape(shape: Shape) {
  for (const ins of shape.instructions) {
    const fields = FIELDS[ins.type];
    expect(fields, `unknown instruction type ${ins.type}`).toBeDefined();
    expect(Object.keys(ins).sort()).toEqual(['type', ...fields].sort());
    for (const f of fields) {
      if (f === 'largeArcFlag' || f === 'sweepFlag') expect(typeof ins[f]).toBe('boolean');
      else expect(typeof ins[f]).toBe('number');
    }
  }
}

function tokens(path: string): string[] { return path.split(' '); }

function expectPathMatches(path: string, expected: string, tol: number) {
  const a = tokens(path), b = tokens(expected);
  expect(a.length).toBe(b.length);
  a.forEach((t, i) => {
    if (/^[A-Za-z]$/.test(b[i])) expect(t).toBe(b[i]);
    else expect(Math.abs(Number(t) - Number(b[i]))).toBeLessThanOrEqual(tol);
  });
}

function origin(shape: Shape): [number, number] {
  expect(shape.transformOrigin).toMatch(/^-?\d+(\.\d+)?(e[+-]?\d+)? -?\d+(\.\d+)?(e[+-]?\d+)?$/i);
  const [x, y] = shape.transformOrigin.split(' ').map(Number);
  return [x, y];
}

function types(shape: Shape): string { return shape.instructions.map(i => i.type).join(''); }

// ---------------------------------------------------------------------------------------------------------------------
// Reference corner rule (§1.5 "Corner rule"). Input is the corner list already closed by repeating the first corner.
// ---------------------------------------------------------------------------------------------------------------------
type Rule = 'arc' | 'bezier';
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function along(from: Pt, to: Pt, by: number): Pt {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: from.x + (to.x - from.x) * by / d, y: from.y + (to.y - from.y) * by / d };
}
function refJoin(points: Pt[], o: { cR?: number; e?: number | null; rule: Rule }, close: boolean): Ins[] {
  const k = points.length - 1, out: Ins[] = [];
  const next = (i: number) => (i === k ? points[1] : points[i + 1]);
  const cR = o.cR ?? 0;
  if (o.e != null) {
    const m0 = mid(points[0], points[1]);
    out.push({ type: 'M', x: m0.x, y: m0.y });
    for (let i = 1; i <= k; i++) {
      const p = points[i], q = points[i - 1], n = next(i);
      const inMid = mid(q, p), outMid = mid(p, n);
      const inV = { x: p.x - q.x, y: p.y - q.y }, outV = { x: n.x - p.x, y: n.y - p.y };
      out.push({
        type: 'C',
        cp1x: inMid.x + inV.x * o.e / 2, cp1y: inMid.y + inV.y * o.e / 2,
        cp2x: outMid.x - outV.x * o.e / 2, cp2y: outMid.y - outV.y * o.e / 2,
        x: outMid.x, y: outMid.y,
      });
    }
  } else if (cR > 0) {
    const s = along(points[0], points[1], cR);
    out.push({ type: 'M', x: s.x, y: s.y });
    for (let i = 1; i <= k; i++) {
      const p = points[i];
      const before = along(p, points[i - 1], cR), after = along(p, next(i), cR);
      out.push({ type: 'L', x: before.x, y: before.y });
      if (o.rule === 'arc') out.push({ type: 'a', rx: cR, ry: cR, xAxisRotation: 0, largeArcFlag: false, sweepFlag: true, dx: after.x - before.x, dy: after.y - before.y });
      else out.push({ type: 'C', cp1x: p.x, cp1y: p.y, cp2x: p.x, cp2y: p.y, x: after.x, y: after.y });
    }
  } else {
    out.push({ type: 'M', x: points[0].x, y: points[0].y });
    for (let i = 1; i <= k; i++) out.push({ type: 'L', x: points[i].x, y: points[i].y });
  }
  if (close) out.push({ type: 'Z' });
  return out;
}

function expectInstructionsClose(actual: Ins[], expected: Ins[], tol = 1e-9) {
  expect(actual.map(i => i.type)).toEqual(expected.map(i => i.type));
  actual.forEach((ins, i) => {
    for (const f of FIELDS[ins.type]) {
      const a = ins[f], b = expected[i][f];
      if (typeof b === 'boolean') expect(a, `${i}:${ins.type}.${f}`).toBe(b);
      else expect(Math.abs((a as number) - (b as number)), `${i}:${ins.type}.${f} ${String(a)} vs ${String(b)}`).toBeLessThanOrEqual(tol);
    }
  });
}

// Expected instruction count from the corner rule alone: k edges in the closed list.
function ruleCount(k: number, kind: 'none' | 'cR' | 'e', z: boolean): number {
  return 1 + (kind === 'cR' ? 2 * k : k) + (z ? 1 : 0);
}

const SQ = Math.sqrt(0.75);
function triPoints(l: number, dir: 'up' | 'right' | 'down' | 'left'): Pt[] {
  const s = SQ * l;
  const raw: Record<string, [number, number][]> = {
    up: [[l / 2, 0], [0, s], [l, s]],
    right: [[0, 0], [0, l], [s, l / 2]],
    down: [[0, 0], [l, 0], [l / 2, s]],
    left: [[s, 0], [s, l], [0, l / 2]],
  };
  const pts = raw[dir].map(([x, y]) => ({ x, y }));
  return [...pts, pts[0]];
}
function starPoints(n: number, inner: number, R: number): Pt[] {
  const pts: Pt[] = [];
  for (let j = 0; j < 2 * n; j++) {
    const a = -Math.PI / 2 + j * Math.PI / n, r = j % 2 === 0 ? R : inner;
    pts.push({ x: R + r * Math.cos(a), y: R + r * Math.sin(a) });
  }
  return [...pts, pts[0]];
}
function polyPoints(n: number, R: number): Pt[] {
  const pts: Pt[] = [];
  for (let j = 0; j < n; j++) {
    const a = -Math.PI / 2 + j * 2 * Math.PI / n;
    pts.push({ x: R + R * Math.cos(a), y: R + R * Math.sin(a) });
  }
  return [...pts, pts[0]];
}
function rectPoints(w: number, h: number): Pt[] {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: 0 }];
}

// Drawn-outline bounding box from the instructions (lines by end points, cubics by dense sampling).
function outlineBox(instructions: Ins[]) {
  let cx = 0, cy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const ins of instructions) {
    if (ins.type === 'M' || ins.type === 'L') { cx = ins.x as number; cy = ins.y as number; see(cx, cy); }
    else if (ins.type === 'C') {
      const [x1, y1, x2, y2, x3, y3] = ['cp1x', 'cp1y', 'cp2x', 'cp2y', 'x', 'y'].map(f => ins[f] as number);
      for (let s = 0; s <= 2000; s++) {
        const t = s / 2000, u = 1 - t;
        see(u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      cx = x3; cy = y3;
    } else if (ins.type !== 'Z') throw new Error(`outlineBox: unsupported ${ins.type}`);
  }
  return { minX, minY, maxX, maxY };
}

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

// ---------------------------------------------------------------------------------------------------------------------
describe('return shape and serialisation', () => {
  const all: [string, Shape][] = [
    ['rect', makeRect({ width: 40, height: 30 })],
    ['rect cR', makeRect({ width: 40, height: 30, cornerRadius: 4 })],
    ['circle', makeCircle({ radius: 10 })],
    ['ellipse', makeEllipse({ rx: 12, ry: 7 })],
    ['triangle', makeTriangle({ length: 50 })],
    ['triangle eR', makeTriangle({ length: 50, direction: 'left', edgeRoundness: 0.4 })],
    ['heart', makeHeart({ height: 100 })],
    ['pie', makePie({ radius: 20, progress: 0.3 })],
    ['pie big', makePie({ radius: 20, progress: 0.8 })],
    ['star', makeStar({ points: 5, innerRadius: 20, outerRadius: 50 })],
    ['polygon', makePolygon({ points: 6, radius: 30 })],
  ];
  it.each(all)('%s returns {path,width,height,transformOrigin,instructions} with spec-named fields', (_n, shape) => {
    expect(Object.keys(shape).sort()).toEqual(['height', 'instructions', 'path', 'transformOrigin', 'width']);
    expect(typeof shape.path).toBe('string');
    expectInstructionShape(shape);
    origin(shape);
  });

  const unshifted = all.filter(([n]) => !['star', 'polygon'].includes(n));
  it.each(unshifted)('%s path = letter + fields in table order, single spaces, flags 0/1', (_n, shape) => {
    expect(shape.path).toBe(serialize(shape.instructions));
    expect(shape.path).not.toMatch(/ {2}|^ | $/);
    expect(shape.path).not.toMatch(/true|false/);
  });

  it('prints numbers as JavaScript prints them, without rounding', () => {
    const s = makeRect({ width: 10 / 3, height: 7.123456789 });
    expect(s.path).toBe(`M 0 0 L ${10 / 3} 0 L ${10 / 3} ${7.123456789} L 0 ${7.123456789} L 0 0 Z`);
    const c = makeCircle({ radius: 1 / 3 });
    expect(c.path).toBe(`M ${1 / 3} 0 a ${1 / 3} ${1 / 3} 0 1 1 0 ${2 / 3} a ${1 / 3} ${1 / 3} 0 1 1 0 ${-2 / 3} Z`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('circle and ellipse', () => {
  it('circle: M(r,0), two relative arcs with large 1 sweep 1, Z; 2r x 2r; origin "r r"', () => {
    const s = makeCircle({ radius: 81 });
    expect(s.instructions).toEqual([
      { type: 'M', x: 81, y: 0 },
      { type: 'a', rx: 81, ry: 81, xAxisRotation: 0, largeArcFlag: true, sweepFlag: true, dx: 0, dy: 162 },
      { type: 'a', rx: 81, ry: 81, xAxisRotation: 0, largeArcFlag: true, sweepFlag: true, dx: 0, dy: -162 },
      { type: 'Z' },
    ]);
    expect([s.width, s.height]).toEqual([162, 162]);
    expect(s.transformOrigin).toBe('81 81');
    expect(s.path).toBe('M 81 0 a 81 81 0 1 1 0 162 a 81 81 0 1 1 0 -162 Z');
  });
  it('ellipse: M(rx,0), ONE relative arc (large 1, sweep 0, dx 1, dy 0), Z', () => {
    const s = makeEllipse({ rx: 121.5, ry: 67.5 });
    expect(s.instructions).toEqual([
      { type: 'M', x: 121.5, y: 0 },
      { type: 'a', rx: 121.5, ry: 67.5, xAxisRotation: 0, largeArcFlag: true, sweepFlag: false, dx: 1, dy: 0 },
      { type: 'Z' },
    ]);
    expect([s.width, s.height]).toEqual([243, 135]);
    expect(s.transformOrigin).toBe('121.5 67.5');
    expect(s.path).toBe('M 121.5 0 a 121.5 67.5 0 1 0 1 0 Z');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('rect', () => {
  it('no rounding: M, four L, Z around (0,0)-(w,h); origin w/2 h/2', () => {
    const s = makeRect({ width: 216, height: 135 });
    expect(s.path).toBe('M 0 0 L 216 0 L 216 135 L 0 135 L 0 0 Z');
    expect([s.width, s.height]).toEqual([216, 135]);
    expect(s.transformOrigin).toBe('108 67.5');
    expectInstructionsClose(s.instructions, refJoin(rectPoints(216, 135), { rule: 'arc' }, true));
  });
  it('edgeRoundness: M at first edge midpoint, one C per corner, Z', () => {
    const s = makeRect({ width: 216, height: 135, edgeRoundness: 0.5 });
    expectInstructionsClose(s.instructions, refJoin(rectPoints(216, 135), { e: 0.5, rule: 'arc' }, true));
    expect(types(s)).toBe('MCCCCZ');
    expect(s.instructions[0]).toMatchObject({ type: 'M', x: 108, y: 0 });
  });
  it('cornerRadius uses the "arc" rule: L then a(cR,cR,0,0,1) per corner (10 instructions)', () => {
    const s = makeRect({ width: 216, height: 135, cornerRadius: 20 });
    expect(types(s)).toBe('MLaLaLaLaZ');
    for (const ins of s.instructions.filter(i => i.type === 'a')) {
      expect(ins).toMatchObject({ rx: 20, ry: 20, xAxisRotation: 0, largeArcFlag: false, sweepFlag: true });
    }
    expect(s.instructions.some(i => i.type === 'C')).toBe(false);
    expect([s.width, s.height]).toEqual([216, 135]);
    expect(s.transformOrigin).toBe('108 67.5');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('triangle', () => {
  const l = 149, s = SQ * l;
  it.each([
    ['up', l, s, [l / 2, 2 * s / 3]],
    ['down', l, s, [l / 2, s / 3]],
    ['right', s, l, [s / 3, l / 2]],
    ['left', s, l, [2 * s / 3, l / 2]],
  ] as const)('%s: size and 1/3 / 2/3 origin', (dir, w, h, o) => {
    const t = makeTriangle({ length: l, direction: dir });
    close(t.width, w); close(t.height, h);
    const [ox, oy] = origin(t);
    close(ox, o[0]); close(oy, o[1]);
    expect(types(t)).toBe('MLLLZ');
    expectInstructionsClose(t.instructions, refJoin(triPoints(l, dir), { rule: 'bezier' }, true));
  });
  it('default direction is right', () => {
    expect(makeTriangle({ length: 100 })).toEqual(makeTriangle({ length: 100, direction: 'right' }));
  });
  it.each(['up', 'right', 'down', 'left'] as const)('%s with cornerRadius uses the bezier rule (C with both controls on the corner)', dir => {
    const t = makeTriangle({ length: l, direction: dir, cornerRadius: 15 });
    expect(types(t)).toBe('MLCLCLCZ');
    expectInstructionsClose(t.instructions, refJoin(triPoints(l, dir), { cR: 15, rule: 'bezier' }, true));
    const pts = triPoints(l, dir);
    const cs = t.instructions.filter(i => i.type === 'C');
    cs.forEach((c, i) => {
      close(c.cp1x as number, pts[i + 1].x); close(c.cp1y as number, pts[i + 1].y);
      close(c.cp2x as number, pts[i + 1].x); close(c.cp2y as number, pts[i + 1].y);
    });
  });
  it.each(['up', 'right', 'down', 'left'] as const)('%s with edgeRoundness: C between edge midpoints, cp = midpoint +/- edge vector * e/2', dir => {
    const t = makeTriangle({ length: l, direction: dir, edgeRoundness: 0.4 });
    expect(types(t)).toBe('MCCCZ');
    expectInstructionsClose(t.instructions, refJoin(triPoints(l, dir), { e: 0.4, rule: 'bezier' }, true));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('star', () => {
  const n = 5, inner = 40, R = 86.25;
  it('unrounded: starts straight up, alternates outer/inner, M + 10 L + Z (12)', () => {
    const s = makeStar({ points: n, innerRadius: inner, outerRadius: R });
    expectInstructionsClose(s.instructions, refJoin(starPoints(n, inner, R), { rule: 'arc' }, true));
    expect(types(s)).toBe('M' + 'L'.repeat(10) + 'Z');
    expect(s.instructions[0]).toMatchObject({ type: 'M' });
    close(s.instructions[0].x as number, R); close(s.instructions[0].y as number, 0);
    expect(s.transformOrigin).toBe(`${R} ${R}`);
  });
  it('width/height = bounding box of the outline; path shifted so the box starts at (0,0); instructions are not shifted', () => {
    const s = makeStar({ points: n, innerRadius: inner, outerRadius: R });
    const b = outlineBox(s.instructions);
    close(s.width, b.maxX - b.minX); close(s.height, b.maxY - b.minY);
    expect(Math.round(s.width)).toBe(164); expect(Math.round(s.height)).toBe(156); // table: star 5 164x156
    // pentagram: left/right extent is not symmetric around R in y, so a shift is needed
    expect(b.minX).toBeGreaterThan(0.1);
    expectPathMatches(s.path, serialize(s.instructions, b.minX, b.minY), 1e-9);
    expect(s.path).not.toBe(serialize(s.instructions));
    expect(s.transformOrigin).toBe(`${R} ${R}`);
  });
  it.each([
    ['cornerRadius (bezier)', { cornerRadius: 8 }, { cR: 8, rule: 'bezier' as Rule }],
    ['edgeRoundness', { edgeRoundness: 0.5 }, { e: 0.5, rule: 'bezier' as Rule }],
  ])('%s: instructions follow the corner rule and the path is shifted by the drawn-outline box', (_n, opts, ref) => {
    const s = makeStar({ points: 6, innerRadius: 40, outerRadius: 84.5, ...opts });
    expectInstructionsClose(s.instructions, refJoin(starPoints(6, 40, 84.5), ref, true));
    const b = outlineBox(s.instructions);
    expect(Math.abs(s.width - (b.maxX - b.minX))).toBeLessThanOrEqual(0.01);
    expect(Math.abs(s.height - (b.maxY - b.minY))).toBeLessThanOrEqual(0.01);
    expectPathMatches(s.path, serialize(s.instructions, b.minX, b.minY), 0.01);
    expect(s.transformOrigin).toBe('84.5 84.5');
  });
  it('cornerRadius uses C (bezier) not arcs', () => {
    const s = makeStar({ points: 8, innerRadius: 50, outerRadius: 84.5, cornerRadius: 8 });
    expect(s.instructions.some(i => i.type === 'a' || i.type === 'A')).toBe(false);
    expect(s.instructions.filter(i => i.type === 'C')).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('polygon', () => {
  it('hexagon R=86.6: n corners, M + 6 L, no Z, box 150 x 173, path shifted, origin R R', () => {
    const R = 86.6, s = makePolygon({ points: 6, radius: R });
    expectInstructionsClose(s.instructions, refJoin(polyPoints(6, R), { rule: 'arc' }, false));
    expect(types(s)).toBe('MLLLLLL');
    expect(s.instructions.some(i => i.type === 'Z')).toBe(false);
    expect(Math.round(s.width)).toBe(150); expect(Math.round(s.height)).toBe(173);
    const b = outlineBox(s.instructions);
    close(s.width, b.maxX - b.minX); close(s.height, b.maxY - b.minY);
    expectPathMatches(s.path, serialize(s.instructions, b.minX, b.minY), 1e-9);
    expect(s.path.endsWith('Z')).toBe(false);
    expect(s.transformOrigin).toBe(`${R} ${R}`);
  });
  it('odd polygon: the box is not centred on (R,R) so the origin stays at (R,R) while the path moves', () => {
    const R = 70, s = makePolygon({ points: 5, radius: R });
    const b = outlineBox(s.instructions);
    expect(b.maxY - b.minY).toBeLessThan(2 * R);
    close(s.height, R * (1 + Math.cos(Math.PI / 5)));
    close(s.width, 2 * R * Math.sin(2 * Math.PI / 5));
    expect(s.transformOrigin).toBe('70 70');
    expectPathMatches(s.path, serialize(s.instructions, b.minX, b.minY), 1e-9);
    expect(s.instructions[0]).toMatchObject({ type: 'M' });
    close(s.instructions[0].x as number, R); close(s.instructions[0].y as number, 0);
  });
  it('edgeRoundness: M + one C per corner, no Z', () => {
    const R = 70, s = makePolygon({ points: 5, radius: R, edgeRoundness: 0.5 });
    expectInstructionsClose(s.instructions, refJoin(polyPoints(5, R), { e: 0.5, rule: 'arc' }, false));
    expect(types(s)).toBe('MCCCCC');
  });
  it('cornerRadius: 3 corners give M + 3 x (L + rounded corner) = 7 instructions, no Z', () => {
    const s = makePolygon({ points: 3, radius: 72.5, cornerRadius: 10 });
    expect(s.instructions).toHaveLength(7);
    expect(s.instructions.map(i => i.type).filter(t => t === 'L')).toHaveLength(3);
    expect(s.instructions.some(i => i.type === 'Z')).toBe(false);
    expect(s.transformOrigin).toBe('72.5 72.5');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('instruction counts match the snippet-09 table (i=…)', () => {
  // [label, shape, expected i from the table, count from the corner rule alone]
  const rows: [string, Shape, number, number][] = [
    ['rect', makeRect({ width: 216, height: 135 }), 6, ruleCount(4, 'none', true)],
    ['rect cR', makeRect({ width: 216, height: 135, cornerRadius: 20 }), 10, ruleCount(4, 'cR', true)],
    ['rect eR', makeRect({ width: 216, height: 135, edgeRoundness: 0.5 }), 6, ruleCount(4, 'e', true)],
    ['circle', makeCircle({ radius: 81 }), 4, 4],
    ['ellipse', makeEllipse({ rx: 121.5, ry: 67.5 }), 3, 3],
    ['heart', makeHeart({ height: 148.5 }), 8, 8],
    ['tri up', makeTriangle({ length: 149, direction: 'up' }), 5, ruleCount(3, 'none', true)],
    ['tri down', makeTriangle({ length: 149, direction: 'down' }), 5, ruleCount(3, 'none', true)],
    ['tri left', makeTriangle({ length: 149, direction: 'left' }), 5, ruleCount(3, 'none', true)],
    ['tri right', makeTriangle({ length: 149, direction: 'right' }), 5, ruleCount(3, 'none', true)],
    ['tri cR (up)', makeTriangle({ length: 149, direction: 'up', cornerRadius: 15 }), 8, ruleCount(3, 'cR', true)],
    ['tri eR (right)', makeTriangle({ length: 149, direction: 'right', edgeRoundness: 0.4 }), 5, ruleCount(3, 'e', true)],
    ['star 5', makeStar({ points: 5, innerRadius: 40, outerRadius: 86.25 }), 12, ruleCount(10, 'none', true)],
    ['star 8 cR', makeStar({ points: 8, innerRadius: 50, outerRadius: 84.5, cornerRadius: 8 }), 34, ruleCount(16, 'cR', true)],
    ['star 6 eR', makeStar({ points: 6, innerRadius: 40, outerRadius: 64, edgeRoundness: 0.5 }), 14, ruleCount(12, 'e', true)],
    ['poly 6', makePolygon({ points: 6, radius: 86.6 }), 7, ruleCount(6, 'none', false)],
    ['poly 3 cR', makePolygon({ points: 3, radius: 72.5, cornerRadius: 10 }), 7, ruleCount(3, 'cR', false)],
    ['poly 5 eR', makePolygon({ points: 5, radius: 70, edgeRoundness: 0.5 }), 6, ruleCount(5, 'e', false)],
    ['pie p<=0.5', makePie({ radius: 81, progress: 0.3 }), 4, 4],
    ['pie open p .65', makePie({ radius: 81, progress: 0.65, closePath: false }), 3, 3],
    ['pie ccw p .4', makePie({ radius: 81, progress: 0.4, counterClockwise: true }), 4, 4],
  ];
  it.each(rows)('%s -> i=%i', (_label, shape, i, ruleI) => {
    expect(ruleI).toBe(i); // the table value follows from the corner rule
    expect(shape.instructions).toHaveLength(i);
  });

  it('table sizes: rect 216x135, circle 162x162, ellipse 243x135, heart 163x149, tri 149x129 / 129x149, star 5 164x156, poly 6 150x173, pie 162x162', () => {
    const wh = (s: Shape) => [Math.round(s.width), Math.round(s.height)];
    expect(wh(rows[0][1])).toEqual([216, 135]);
    expect(wh(rows[1][1])).toEqual([216, 135]);
    expect(wh(rows[2][1])).toEqual([216, 135]);
    expect(wh(rows[3][1])).toEqual([162, 162]);
    expect(wh(rows[4][1])).toEqual([243, 135]);
    expect(wh(rows[5][1])).toEqual([163, 149]);
    expect(wh(rows[6][1])).toEqual([149, 129]);
    expect(wh(rows[7][1])).toEqual([149, 129]);
    expect(wh(rows[8][1])).toEqual([129, 149]);
    expect(wh(rows[9][1])).toEqual([129, 149]);
    expect(wh(rows[10][1])).toEqual([149, 129]);
    expect(wh(rows[11][1])).toEqual([129, 149]);
    expect(wh(rows[12][1])).toEqual([164, 156]);
    expect(wh(rows[15][1])).toEqual([150, 173]);
    for (const idx of [18, 19, 20]) expect(wh(rows[idx][1])).toEqual([162, 162]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('pie', () => {
  const r = 50;
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  const pt = (q: number, ccw = false, rot = 0) => {
    const a = (ccw ? -1 : 1) * q * 2 * Math.PI + 1.5 * Math.PI + rot;
    return { x: r5(r + r * Math.cos(a)), y: r5(r + r * Math.sin(a)) };
  };
  const expectPt = (ins: Ins, p: Pt) => {
    for (const [f, v] of [['x', p.x], ['y', p.y]] as const) {
      const got = ins[f] as number;
      expect(Math.abs(got - v), `${f} ${got} vs ${v}`).toBeLessThanOrEqual(1.01e-5);
      expect(Math.abs(got * 1e5 - Math.round(got * 1e5)), `${f}=${got} not rounded to 5 decimals`).toBeLessThan(1e-6);
    }
  };
  const A = (sweep: boolean) => ({ type: 'A', rx: r, ry: r, xAxisRotation: 0, largeArcFlag: false, sweepFlag: sweep });

  it('p <= 0.5 closed: M start, one A (large 0, sweep true) to the end, L(r,r), Z', () => {
    const s = makePie({ radius: r, progress: 0.3 });
    expect(types(s)).toBe('MALZ');
    expectPt(s.instructions[0], pt(0));
    expect(s.instructions[1]).toMatchObject(A(true));
    expectPt(s.instructions[1], pt(0.3));
    expect(s.instructions[2]).toEqual({ type: 'L', x: r, y: r });
    expect([s.width, s.height]).toEqual([100, 100]);
    expect(s.transformOrigin).toBe('50 50');
    expect(s.path).toBe(serialize(s.instructions));
  });
  it('start point is on the arc at the top (r, 0)', () => {
    const s = makePie({ radius: r, progress: 0.3 });
    expect(Math.abs((s.instructions[0].x as number) - r)).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(s.instructions[0].y as number)).toBeLessThanOrEqual(1e-5);
  });
  it('p = 0.5 still uses a single arc', () => {
    const s = makePie({ radius: r, progress: 0.5 });
    expect(types(s)).toBe('MALZ');
    expectPt(s.instructions[1], pt(0.5));
  });
  it('p > 0.5: two identical A flags, first to the half-way point then to the end', () => {
    const s = makePie({ radius: r, progress: 0.8 });
    expect(types(s)).toBe('MAALZ');
    expect(s.instructions[1]).toMatchObject(A(true));
    expect(s.instructions[2]).toMatchObject(A(true));
    expectPt(s.instructions[1], pt(0.5));
    expectPt(s.instructions[2], pt(0.8));
  });
  it('open pie (closePath false): no L, no Z', () => {
    const s = makePie({ radius: r, progress: 0.65, closePath: false });
    expect(types(s)).toBe('MAA');
    expect(makePie({ radius: r, progress: 0.3, closePath: false }).instructions).toHaveLength(2);
  });
  it('counterClockwise: angle sign flips and sweep = false', () => {
    const s = makePie({ radius: r, progress: 0.4, counterClockwise: true });
    expect(types(s)).toBe('MALZ');
    expect(s.instructions[1]).toMatchObject(A(false));
    expectPt(s.instructions[1], pt(0.4, true));
    const big = makePie({ radius: r, progress: 0.7, counterClockwise: true });
    expect(types(big)).toBe('MAALZ');
    expectPt(big.instructions[1], pt(0.5, true));
    expectPt(big.instructions[2], pt(0.7, true));
  });
  it('L(r,r) only when 0 < p < 1 and closed', () => {
    expect(types(makePie({ radius: r, progress: 0 }))).toBe('MAZ');
    expect(types(makePie({ radius: r, progress: 1 }))).toBe('MAAZ');
    expect(types(makePie({ radius: r, progress: 0.0001 }))).toBe('MALZ');
    expect(types(makePie({ radius: r, progress: 0.9999 }))).toBe('MAALZ');
    expect(types(makePie({ radius: r, progress: 0, closePath: false }))).toBe('MA');
    expect(types(makePie({ radius: r, progress: 1, closePath: false }))).toBe('MAA');
  });
  it('progress is clamped to 0..1', () => {
    expect(makePie({ radius: r, progress: 3 })).toEqual(makePie({ radius: r, progress: 1 }));
    expect(makePie({ radius: r, progress: -2 })).toEqual(makePie({ radius: r, progress: 0 }));
  });
  it('rotation is added to every angle (radians)', () => {
    const s = makePie({ radius: r, progress: 0.3, rotation: Math.PI / 2 });
    expectPt(s.instructions[0], pt(0, false, Math.PI / 2));
    expectPt(s.instructions[1], pt(0.3, false, Math.PI / 2));
    expect(Math.abs((s.instructions[0].x as number) - 2 * r)).toBeLessThanOrEqual(1e-5);
    expect(Math.abs((s.instructions[0].y as number) - r)).toBeLessThanOrEqual(1e-5);
    expect(makePie({ radius: r, progress: 0.3, rotation: 0.7 })).not.toEqual(makePie({ radius: r, progress: 0.3 }));
  });
  it('defaults: closePath true, counterClockwise false, rotation 0', () => {
    expect(makePie({ radius: r, progress: 0.3 })).toEqual(makePie({ radius: r, progress: 0.3, closePath: true, counterClockwise: false, rotation: 0 }));
    expect(makePie({ radius: r, progress: 0.8 })).toEqual(makePie({ radius: r, progress: 0.8, closePath: true, counterClockwise: false, rotation: 0 }));
  });
  it('points are rounded to 5 decimals in instructions and in the path string', () => {
    const s = makePie({ radius: 33.333333, progress: 0.123457 });
    for (const ins of s.instructions.filter(i => i.type === 'A')) {
      for (const f of ['x', 'y']) expect(Math.abs((ins[f] as number) * 1e5 - Math.round((ins[f] as number) * 1e5))).toBeLessThan(1e-6);
    }
    expect(s.path).toBe(serialize(s.instructions));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('heart (§1.6)', () => {
  const heartConsts = (H: number, ar = 1.1, b = 0, k = 0) => {
    const W = H * ar;
    return { W, H, i: (23 / 110 + b) * W, o: 0.69 * H, l: 0.6 * H, c: 0.13 * H, d: 29 / 110 * W, u: 15 / 110 * W, x: 5 / 110 * W, f: 0.07 * H, m: (0.17 + k) * H };
  };
  const heartRef = (H: number, ar = 1.1, b = 0, k = 0): Ins[] => {
    const { W, i, o, l, c, d, u, x, f, m } = heartConsts(H, ar, b, k);
    const C = (a: number[]): Ins => ({ type: 'C', cp1x: a[0], cp1y: a[1], cp2x: a[2], cp2y: a[3], x: a[4], y: a[5] });
    return [
      { type: 'M', x: W / 2, y: H },
      C([W / 2 - i, o, 0, l, 0, H / 4]),
      C([0, c, W / 4 - d / 2, 0, W / 4, 0]),
      C([W / 4 + d / 2, 0, W / 2 - x, f, W / 2, m]),
      C([W / 2 + x, f, W / 2 + u, 0, 3 * W / 4, 0]),
      C([3 * W / 4 + d / 2, 0, W, c, W, H / 4]),
      C([W, l, W / 2 + i, o, W / 2, H]),
      { type: 'Z' },
    ];
  };

  it('H=100: width 110, height 100, origin "55 50", 8 instructions with the exact constants', () => {
    const s = makeHeart({ height: 100 });
    expect(s.width).toBeCloseTo(110, 9);
    expect(s.height).toBe(100);
    // W = 100 * 1.1 is 110.00000000000001 in JS, so the origin prints 55.00000000000001; compare numerically
    const [ox, oy] = origin(s);
    close(ox, 55); close(oy, 50);
    expect(s.instructions).toHaveLength(8);
    expectInstructionsClose(s.instructions, [
      { type: 'M', x: 55, y: 100 },
      { type: 'C', cp1x: 32, cp1y: 69, cp2x: 0, cp2y: 60, x: 0, y: 25 },
      { type: 'C', cp1x: 0, cp1y: 13, cp2x: 13, cp2y: 0, x: 27.5, y: 0 },
      { type: 'C', cp1x: 42, cp1y: 0, cp2x: 50, cp2y: 7, x: 55, y: 17 },
      { type: 'C', cp1x: 60, cp1y: 7, cp2x: 70, cp2y: 0, x: 82.5, y: 0 },
      { type: 'C', cp1x: 97, cp1y: 0, cp2x: 110, cp2y: 13, x: 110, y: 25 },
      { type: 'C', cp1x: 110, cp1y: 60, cp2x: 78, cp2y: 69, x: 55, y: 100 },
      { type: 'Z' },
    ], 1e-9);
    expect(s.path).toBe(serialize(s.instructions));
  });
  it('curve 5 is not the mirror of curve 4 (second control point at W/2 + 15/110 W)', () => {
    const s = makeHeart({ height: 100 });
    expect(s.instructions[4].cp2x as number).toBeCloseTo(70, 9); // mirror would be 68
  });
  it('H=148.5 (stored frame): W = 163.35, origin W/2 H/2, constants scale with W and H', () => {
    const s = makeHeart({ height: 148.5 });
    expect(s.width).toBeCloseTo(163.35, 9);
    expect(s.height).toBe(148.5);
    const [ox, oy] = origin(s);
    close(ox, 163.35 / 2); close(oy, 148.5 / 2);
    expectInstructionsClose(s.instructions, heartRef(148.5), 1e-9);
  });
  it('options aspectRatio, bottomRoundnessAdjustment, depthAdjustment are accepted; defaults 1.1 / 0 / 0', () => {
    expect(makeHeart({ height: 100 })).toEqual(makeHeart({ height: 100, aspectRatio: 1.1, bottomRoundnessAdjustment: 0, depthAdjustment: 0 }));
    const s = makeHeart({ height: 80, aspectRatio: 1.5, bottomRoundnessAdjustment: 0.02, depthAdjustment: 0.03 } as never);
    expect(s.width).toBeCloseTo(120, 9);
    expect(s.height).toBe(80);
    expect(s.transformOrigin).toBe('60 40');
    expectInstructionsClose(s.instructions, heartRef(80, 1.5, 0.02, 0.03), 1e-9);
    expect(s.instructions).not.toEqual(makeHeart({ height: 80, aspectRatio: 1.5 } as never).instructions);
  });

  // 64 equal-arc-length outline points for H=100 (spec §1.6), clockwise from the bottom tip.
  const POINTS = `
55,100 51.72,95.79 48.25,91.74 44.62,87.83 40.85,84.05 36.98,80.38 33.03,76.79 29.04,73.25
25.05,69.71 21.11,66.11 17.26,62.41 13.58,58.55 10.16,54.46 7.09,50.09 4.5,45.44 2.46,40.51
1.04,35.37 0.24,30.09 0,24.77 0.86,19.52 3,14.64 6.1,10.31 9.92,6.59 14.32,3.59
19.18,1.41 24.37,0.2 29.7,0.06 34.99,0.71 40.09,2.24 44.8,4.74 48.88,8.16 52.25,12.29
54.94,16.89 57.7,12.55 61.19,8.52 65.32,5.16 69.98,2.58 75.03,0.88 80.3,0.07 85.63,0.2
90.82,1.41 95.68,3.59 100.08,6.59 103.9,10.31 107,14.64 109.14,19.52 110,24.77 109.76,30.09
108.96,35.37 107.54,40.51 105.5,45.44 102.91,50.09 99.84,54.46 96.42,58.55 92.74,62.41 88.89,66.11
84.95,69.71 80.96,73.25 76.97,76.79 73.02,80.38 69.15,84.05 65.38,87.83 61.75,91.74 58.28,95.79`
    .trim().split(/\s+/).map(p => p.split(',').map(Number) as [number, number]);

  it('lists 64 points', () => { expect(POINTS).toHaveLength(64); });

  it('each of the 64 listed points lies within 0.01 px (+0.006 rounding slack) of the maker outline', () => {
    const s = makeHeart({ height: 100 });
    expect(s.width).toBeCloseTo(110, 9);
    // densely sample the cubic Béziers (absolute C after the initial M)
    const poly: [number, number][] = [];
    let cx = 0, cy = 0;
    for (const ins of s.instructions) {
      if (ins.type === 'M') { cx = ins.x as number; cy = ins.y as number; poly.push([cx, cy]); }
      else if (ins.type === 'C') {
        const [x1, y1, x2, y2, x3, y3] = ['cp1x', 'cp1y', 'cp2x', 'cp2y', 'x', 'y'].map(f => ins[f] as number);
        for (let q = 1; q <= 4000; q++) {
          const t = q / 4000, u = 1 - t;
          poly.push([u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
        }
        cx = x3; cy = y3;
      }
    }
    const segDist = (px: number, py: number, a: [number, number], b: [number, number]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
      return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
    };
    const worst: string[] = [];
    POINTS.forEach(([px, py], idx) => {
      let best = Infinity;
      for (let q = 1; q < poly.length; q++) best = Math.min(best, segDist(px, py, poly[q - 1], poly[q]));
      if (best > 0.01 + 0.006) worst.push(`#${idx} (${px},${py}) off by ${best.toFixed(4)}`);
    });
    expect(worst).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('errors (§1.4)', () => {
  const message = (fn: () => unknown): string => {
    try { fn(); } catch (e) { return (e as Error).message; }
    return '<did not throw>';
  };
  const BOTH = '"cornerRadius" and "edgeRoundness" cannot be specified at the same time.';

  it.each([
    ['rect', () => makeRect({ width: 100, height: 50, cornerRadius: 5, edgeRoundness: 0.5 })],
    ['triangle', () => makeTriangle({ length: 100, cornerRadius: 5, edgeRoundness: 0.5 })],
    ['star', () => makeStar({ points: 5, innerRadius: 20, outerRadius: 50, cornerRadius: 5, edgeRoundness: 0.5 })],
    ['polygon', () => makePolygon({ points: 5, radius: 50, cornerRadius: 5, edgeRoundness: 0.5 })],
  ])('%s: cornerRadius with edgeRoundness', (_n, fn) => {
    expect(message(fn)).toBe(BOTH);
  });

  it('polygon points < 3', () => {
    expect(message(() => makePolygon({ points: 2, radius: 50 }))).toBe('"points" should be minimum 3, got 2');
    expect(message(() => makePolygon({ points: 0, radius: 50 }))).toBe('"points" should be minimum 3, got 0');
    expect(() => makePolygon({ points: 3, radius: 50 })).not.toThrow();
  });

  it('triangle length must be a number (JSON of the value in the text)', () => {
    expect(message(() => makeTriangle({ length: 'x' as never }))).toBe('"length" of a triangle must be a number, got "x"');
    expect(message(() => makeTriangle({ length: true as never }))).toBe('"length" of a triangle must be a number, got true');
    expect(message(() => makeTriangle({ length: { a: 1 } as never }))).toBe('"length" of a triangle must be a number, got {"a":1}');
  });

  it('errors are thrown while rendering a component too', () => {
    expect(message(() => renderToStaticMarkup(React.createElement(shapeComponents.Rect, { width: 10, height: 10, cornerRadius: 1, edgeRoundness: 1 })))).toBe(BOTH);
    expect(message(() => renderToStaticMarkup(React.createElement(shapeComponents.Polygon, { points: 2, radius: 10 })))).toBe('"points" should be minimum 3, got 2');
    expect(message(() => renderToStaticMarkup(React.createElement(shapeComponents.Triangle, { length: 'x' })))).toBe('"length" of a triangle must be a number, got "x"');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('shape components', () => {
  const html = (C: React.ComponentType<any>, props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(C, props));
  const svgTag = (m: string) => m.match(/<svg[^>]*>/)![0];
  const pathTag = (m: string) => m.match(/<path[^>]*>/)![0];

  it('exports Rect, Circle, Ellipse, Triangle, Star, Polygon, Heart, Pie', () => {
    expect(Object.keys(shapeComponents).sort()).toEqual(['Circle', 'Ellipse', 'Heart', 'Pie', 'Polygon', 'Rect', 'Star', 'Triangle']);
  });

  it('Rect renders one svg (size, viewBox, overflow visible) and one path (d, transform-origin attribute, fill-box)', () => {
    const shape = makeRect({ width: 216, height: 135 });
    const m = html(shapeComponents.Rect, { width: 216, height: 135, fill: 'red', stroke: 'blue', strokeWidth: 2 });
    expect(m.match(/<svg/g)).toHaveLength(1);
    expect(m.match(/<path/g)).toHaveLength(1);
    const svg = svgTag(m), path = pathTag(m);
    expect(svg).toContain('width="216"');
    expect(svg).toContain('height="135"');
    expect(svg).toContain('viewBox="0 0 216 135"');
    expect(svg).toMatch(/style="[^"]*overflow:\s*visible/);
    expect(svg).not.toContain('fill=');
    expect(path).toContain(`d="${shape.path}"`);
    expect(path).toContain('transform-origin="108 67.5"');
    expect(path).toMatch(/style="[^"]*transform-box:\s*fill-box/);
    expect(path).toContain('fill="red"');
    expect(path).toContain('stroke="blue"');
    expect(path).toContain('stroke-width="2"');
  });

  it('every component renders the maker path and size for its props', () => {
    const cases: [string, Record<string, unknown>, Shape][] = [
      ['Rect', { width: 40, height: 30, cornerRadius: 4 }, makeRect({ width: 40, height: 30, cornerRadius: 4 })],
      ['Circle', { radius: 25 }, makeCircle({ radius: 25 })],
      ['Ellipse', { rx: 30, ry: 12 }, makeEllipse({ rx: 30, ry: 12 })],
      ['Triangle', { length: 60, direction: 'down', edgeRoundness: 0.3 }, makeTriangle({ length: 60, direction: 'down', edgeRoundness: 0.3 })],
      ['Star', { points: 5, innerRadius: 20, outerRadius: 50 }, makeStar({ points: 5, innerRadius: 20, outerRadius: 50 })],
      ['Polygon', { points: 7, radius: 40 }, makePolygon({ points: 7, radius: 40 })],
      ['Heart', { height: 100 }, makeHeart({ height: 100 })],
      ['Pie', { radius: 40, progress: 0.7, closePath: false }, makePie({ radius: 40, progress: 0.7, closePath: false })],
    ];
    for (const [name, props, shape] of cases) {
      const m = html((shapeComponents as Record<string, React.ComponentType<any>>)[name], props);
      expect(m.match(/<svg/g), name).toHaveLength(1);
      expect(m.match(/<path/g), name).toHaveLength(1);
      expect(svgTag(m), name).toContain(`width="${shape.width}"`);
      expect(svgTag(m), name).toContain(`height="${shape.height}"`);
      expect(svgTag(m), name).toContain(`viewBox="0 0 ${shape.width} ${shape.height}"`);
      expect(pathTag(m), name).toContain(`d="${shape.path}"`);
      expect(pathTag(m), name).toContain(`transform-origin="${shape.transformOrigin}"`);
    }
  });

  it('style goes on the svg alongside overflow:visible; pathStyle replaces the fill-box default', () => {
    const m = html(shapeComponents.Circle, { radius: 10, style: { opacity: 0.5 }, pathStyle: { transformBox: 'view-box' } });
    expect(svgTag(m)).toMatch(/overflow:\s*visible/);
    expect(svgTag(m)).toMatch(/opacity:\s*0\.5/);
    expect(pathTag(m)).toMatch(/transform-box:\s*view-box/);
    expect(pathTag(m)).not.toContain('fill-box');
  });

  it('geometry props do not leak onto the path as attributes', () => {
    const m = html(shapeComponents.Star, { points: 5, innerRadius: 20, outerRadius: 50, cornerRadius: 3, fill: 'lime' });
    const path = pathTag(m);
    for (const k of ['points=', 'innerRadius', 'outerRadius', 'cornerRadius']) expect(path).not.toContain(k);
    expect(path).toContain('fill="lime"');
  });
});
