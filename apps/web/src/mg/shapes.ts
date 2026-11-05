// SPDX-License-Identifier: AGPL-3.0-only
// Shape makers from the written formulas (reference compares §1.5, heart §1.6). Upper-case instructions are absolute,
// lower-case relative; the path prints each instruction's fields in table order with JavaScript's number printing.
import React from 'react';
import { supportedOptions } from './errors';
export type Instruction = { type: string; [key: string]: number | boolean | string };
export type Shape = { path: string; width: number; height: number; transformOrigin: string; instructions: Instruction[] };
type Point = [number, number];
type Round = { cornerRadius?: number; edgeRoundness?: number | null };

const FIELDS: Record<string, string[]> = {
  M: ['x', 'y'], m: ['dx', 'dy'], L: ['x', 'y'], l: ['dx', 'dy'], T: ['x', 'y'], t: ['dx', 'dy'], H: ['x'], h: ['dx'], V: ['y'], v: ['dy'],
  C: ['cp1x', 'cp1y', 'cp2x', 'cp2y', 'x', 'y'], c: ['cp1dx', 'cp1dy', 'cp2dx', 'cp2dy', 'dx', 'dy'],
  S: ['cpx', 'cpy', 'x', 'y'], s: ['cpdx', 'cpdy', 'dx', 'dy'], Q: ['cpx', 'cpy', 'x', 'y'], q: ['cpdx', 'cpdy', 'dx', 'dy'],
  A: ['rx', 'ry', 'xAxisRotation', 'largeArcFlag', 'sweepFlag', 'x', 'y'], a: ['rx', 'ry', 'xAxisRotation', 'largeArcFlag', 'sweepFlag', 'dx', 'dy'], Z: [],
};
export function serializeInstructions(list: Instruction[]): string {
  return list.map(i => {
    const fields = FIELDS[i.type];
    if (!fields) throw Error(`Unknown instruction type: ${i.type}`);
    return [i.type, ...fields.map(f => typeof i[f] === 'boolean' ? (i[f] ? 1 : 0) : i[f])].join(' ');
  }).join(' ');
}
const result = (instructions: Instruction[], width: number, height: number, origin: Point, path = serializeInstructions(instructions)): Shape =>
  ({ path, width, height, transformOrigin: `${origin[0]} ${origin[1]}`, instructions });

const M = (p: Point): Instruction => ({ type: 'M', x: p[0], y: p[1] });
const L = (p: Point): Instruction => ({ type: 'L', x: p[0], y: p[1] });
const C = (a: Point, b: Point, p: Point): Instruction => ({ type: 'C', cp1x: a[0], cp1y: a[1], cp2x: b[0], cp2y: b[1], x: p[0], y: p[1] });
const toward = (from: Point, to: Point, distance: number): Point => {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return [from[0] + (to[0] - from[0]) / length * distance, from[1] + (to[1] - from[1]) / length * distance];
};
const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
function checkRound(o: Round) {
  if ((o.cornerRadius ?? 0) > 0 && o.edgeRoundness !== null && o.edgeRoundness !== undefined) throw Error('"cornerRadius" and "edgeRoundness" cannot be specified at the same time.');
}
/** §1.5 corner rule over a closed corner list (the first corner repeated at the end). The last corner's outgoing edge is
 *  the list's first edge. */
function corners(list: Point[], o: Round, rule: 'arc' | 'bezier'): Instruction[] {
  checkRound(o);
  const cR = o.cornerRadius ?? 0, e = o.edgeRoundness ?? null, next = (i: number) => list[i === list.length - 1 ? 1 : i + 1];
  const out = [M(e !== null ? mid(list[0], list[1]) : cR > 0 ? toward(list[0], list[1], cR) : list[0])];
  for (let i = 1; i < list.length; i++) {
    const p = list[i], prev = list[i - 1], n = next(i);
    if (e !== null) {
      const inMid = mid(prev, p), outMid = mid(p, n);
      out.push(C([inMid[0] + (p[0] - prev[0]) * e / 2, inMid[1] + (p[1] - prev[1]) * e / 2], [outMid[0] - (n[0] - p[0]) * e / 2, outMid[1] - (n[1] - p[1]) * e / 2], outMid));
    } else if (cR > 0) {
      const before = toward(p, prev, cR), after = toward(p, n, cR);
      out.push(L(before), rule === 'arc'
        ? { type: 'a', rx: cR, ry: cR, xAxisRotation: 0, largeArcFlag: false, sweepFlag: true, dx: after[0] - before[0], dy: after[1] - before[1] }
        : C(p, p, after));
    } else out.push(L(p));
  }
  return out;
}
const closed = (list: Point[]) => [...list, list[0]];

/** Bounding box of an outline drawn with absolute M / L / C only (stars and polygons), cubic extrema included. */
function bounds(list: Instruction[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
  const roots = (p0: number, p1: number, p2: number, p3: number) => {
    const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
    if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
    const disc = b * b - 4 * a * c; if (disc < 0) return [];
    return [(-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a)];
  };
  for (const i of list) {
    const x = i.x as number, y = i.y as number;
    if (i.type === 'C') {
      const X = [cx, i.cp1x as number, i.cp2x as number, x], Y = [cy, i.cp1y as number, i.cp2y as number, y];
      for (const t of [...roots(X[0], X[1], X[2], X[3]), ...roots(Y[0], Y[1], Y[2], Y[3])]) if (t > 0 && t < 1) add(cubic(X[0], X[1], X[2], X[3], t), cubic(Y[0], Y[1], Y[2], Y[3], t));
    }
    if (i.type !== 'Z') { add(x, y); cx = x; cy = y; }
  }
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}
/** Star and polygon: the path is shifted so the outline's box starts at (0, 0); instructions and origin stay around (R, R). */
function placed(instructions: Instruction[], R: number): Shape {
  const b = bounds(instructions), shift = (i: Instruction): Instruction => i.type === 'C'
    ? { ...i, cp1x: (i.cp1x as number) - b.x0, cp1y: (i.cp1y as number) - b.y0, cp2x: (i.cp2x as number) - b.x0, cp2y: (i.cp2y as number) - b.y0, x: (i.x as number) - b.x0, y: (i.y as number) - b.y0 }
    : i.type === 'Z' ? i : { ...i, x: (i.x as number) - b.x0, y: (i.y as number) - b.y0 };
  return result(instructions, b.width, b.height, [R, R], serializeInstructions(instructions.map(shift)));
}

export function makeRect(o: { width: number; height: number } & Round): Shape {
  supportedOptions('makeRect', o, ['width', 'height', 'cornerRadius', 'edgeRoundness']);
  const { width: w, height: h } = o, cR = o.cornerRadius ?? 0;
  return result([...corners([[cR, 0], [w, 0], [w, h], [0, h], [0, 0]], o, 'arc'), { type: 'Z' }], w, h, [w / 2, h / 2]);
}
export function makeEllipse(o: { rx: number; ry: number }): Shape {
  supportedOptions('makeEllipse', o, ['rx', 'ry']);
  const { rx, ry } = o;
  return result([M([rx, 0]), { type: 'a', rx, ry, xAxisRotation: 0, largeArcFlag: true, sweepFlag: false, dx: 1, dy: 0 }, { type: 'Z' }], 2 * rx, 2 * ry, [rx, ry]);
}
export function makeCircle(o: { radius: number }): Shape {
  supportedOptions('makeCircle', o, ['radius']);
  const r = o.radius, arc = (dy: number): Instruction => ({ type: 'a', rx: r, ry: r, xAxisRotation: 0, largeArcFlag: true, sweepFlag: true, dx: 0, dy });
  return result([M([r, 0]), arc(2 * r), arc(-2 * r), { type: 'Z' }], 2 * r, 2 * r, [r, r]);
}
export function makeTriangle(o: { length: number; direction?: 'up' | 'right' | 'down' | 'left' } & Round): Shape {
  supportedOptions('makeTriangle', o, ['length', 'direction', 'cornerRadius', 'edgeRoundness']);
  if (typeof o.length !== 'number') throw Error(`"length" of a triangle must be a number, got ${JSON.stringify(o.length)}`);
  const l = o.length, s = Math.sqrt(0.75) * l, direction = o.direction ?? 'right';
  const table: Record<string, [Point[], number, number, Point]> = {
    up: [[[l / 2, 0], [0, s], [l, s]], l, s, [l / 2, 2 * s / 3]],
    right: [[[0, 0], [0, l], [s, l / 2]], s, l, [s / 3, l / 2]],
    down: [[[0, 0], [l, 0], [l / 2, s]], l, s, [l / 2, s / 3]],
    left: [[[s, 0], [s, l], [0, l / 2]], s, l, [2 * s / 3, l / 2]],
  };
  const row = table[direction]; if (!row) throw Error(`Unsupported triangle direction '${direction}'.`);
  return result([...corners(closed(row[0]), o, 'bezier'), { type: 'Z' }], row[1], row[2], row[3]);
}
export function makeStar(o: { innerRadius: number; outerRadius: number; points: number } & Round): Shape {
  supportedOptions('makeStar', o, ['innerRadius', 'outerRadius', 'points', 'cornerRadius', 'edgeRoundness']);
  const R = o.outerRadius, n = o.points, list: Point[] = [];
  for (let i = 0; i < 2 * n; i++) { const r = i % 2 ? o.innerRadius : R, a = -Math.PI / 2 + i * Math.PI / n; list.push([R + r * Math.cos(a), R + r * Math.sin(a)]); }
  return placed([...corners(closed(list), o, (o.cornerRadius ?? 0) > 0 ? 'bezier' : 'arc'), { type: 'Z' }], R);
}
export function makePolygon(o: { radius: number; points: number } & Round): Shape {
  supportedOptions('makePolygon', o, ['radius', 'points', 'cornerRadius', 'edgeRoundness']);
  if (o.points < 3) throw Error(`"points" should be minimum 3, got ${o.points}`);
  const R = o.radius, list: Point[] = [];
  for (let i = 0; i < o.points; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / o.points; list.push([R + R * Math.cos(a), R + R * Math.sin(a)]); }
  // §1.5 names no corner rule for the polygon; "bezier" as for the star and triangle (T08 notes, interpretation).
  return placed(corners(closed(list), o, 'bezier'), R);
}
export function makeHeart(o: { height: number; aspectRatio?: number; bottomRoundnessAdjustment?: number; depthAdjustment?: number }): Shape {
  supportedOptions('makeHeart', o, ['height', 'aspectRatio', 'bottomRoundnessAdjustment', 'depthAdjustment']);
  const H = o.height, W = H * (o.aspectRatio ?? 1.1), b = o.bottomRoundnessAdjustment ?? 0, k = o.depthAdjustment ?? 0;
  const i = (23 / 110 + b) * W, oo = 0.69 * H, l = 0.6 * H, c = 0.13 * H, d = 29 / 110 * W, u = 15 / 110 * W, x = 5 / 110 * W, f = 0.07 * H, m = (0.17 + k) * H;
  return result([
    M([W / 2, H]),
    C([W / 2 - i, oo], [0, l], [0, H / 4]),
    C([0, c], [W / 4 - d / 2, 0], [W / 4, 0]),
    C([W / 4 + d / 2, 0], [W / 2 - x, f], [W / 2, m]),
    C([W / 2 + x, f], [W / 2 + u, 0], [3 * W / 4, 0]),
    C([3 * W / 4 + d / 2, 0], [W, c], [W, H / 4]),
    C([W, l], [W / 2 + i, oo], [W / 2, H]),
    { type: 'Z' },
  ], W, H, [W / 2, H / 2]);
}
export function makePie(o: { radius: number; progress: number; closePath?: boolean; counterClockwise?: boolean; rotation?: number }): Shape {
  supportedOptions('makePie', o, ['radius', 'progress', 'closePath', 'counterClockwise', 'rotation']);
  const { radius: r, closePath = true, counterClockwise = false, rotation = 0 } = o, p = Math.max(0, Math.min(1, o.progress));
  const five = (v: number) => Math.round(v * 1e5) / 1e5;
  const at = (q: number): Point => { const a = (counterClockwise ? -1 : 1) * q * 2 * Math.PI + 1.5 * Math.PI + rotation; return [five(r + r * Math.cos(a)), five(r + r * Math.sin(a))]; };
  const A = (to: Point): Instruction => ({ type: 'A', rx: r, ry: r, xAxisRotation: 0, largeArcFlag: false, sweepFlag: !counterClockwise, x: to[0], y: to[1] });
  const list = [M(at(0)), ...(p <= 0.5 ? [A(at(p))] : [A(at(0.5)), A(at(p))])];
  if (closePath && p > 0 && p < 1) list.push(L([r, r]));
  if (closePath) list.push({ type: 'Z' });
  return result(list, 2 * r, 2 * r, [r, r]);
}
const makers = { Rect: makeRect, Circle: makeCircle, Ellipse: makeEllipse, Triangle: makeTriangle, Star: makeStar, Polygon: makePolygon, Heart: makeHeart, Pie: makePie };
const geometryKeys = ['width', 'height', 'radius', 'rx', 'ry', 'length', 'direction', 'innerRadius', 'outerRadius', 'points', 'edgeRoundness', 'cornerRadius', 'progress', 'closePath', 'counterClockwise',
  'aspectRatio', 'bottomRoundnessAdjustment', 'depthAdjustment', 'rotation'];
export const shapeComponents = Object.fromEntries(Object.entries(makers).map(([name, make]) => [name, (props: Record<string, unknown>) => {
  const svgProps = ['fill','fillOpacity','fillRule','stroke','strokeWidth','strokeOpacity','strokeLinecap','strokeLinejoin','strokeMiterlimit','strokeDasharray','strokeDashoffset','opacity','color','transform','vectorEffect','clipPath','mask','filter','id','className','style','pathStyle','children','shapeRendering','paintOrder'];
  supportedOptions(name, props, [...geometryKeys, ...svgProps, ...Object.keys(props).filter(k => k.startsWith('data-') || k.startsWith('aria-'))]);
  const args = Object.fromEntries(Object.entries(props).filter(([k]) => geometryKeys.includes(k))), rest = Object.fromEntries(Object.entries(props).filter(([k]) => !geometryKeys.includes(k) && !['style', 'pathStyle', 'children'].includes(k)));
  const shape = (make as (o: never) => Shape)(args as never);
  // §1.5 components: the origin is a path attribute and pathStyle defaults to {transformBox: 'fill-box'}.
  return React.createElement('svg', { width: shape.width, height: shape.height, viewBox: `0 0 ${shape.width} ${shape.height}`, style: { overflow: 'visible', ...props.style as object } },
    React.createElement('path', { ...rest, d: shape.path, transformOrigin: shape.transformOrigin, style: (props.pathStyle ?? { transformBox: 'fill-box' }) as object }));
}])) as unknown as Record<keyof typeof makers, React.ComponentType<any>>;
