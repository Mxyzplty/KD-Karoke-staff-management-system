// SPDX-License-Identifier: AGPL-3.0-only AND BSD-3-Clause
/*! @license interpolatePath for command lists that differ: a TypeScript port of d3-interpolate-path 2.3.0
 * (https://github.com/pbeshai/d3-interpolate-path; vendor/manifest.json lists it).
 *
 * Copyright 2016, Peter Beshai
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of the author nor the names of contributors may be used to
 *   endorse or promote products derived from this software without specific prior
 *   written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
// Remotion's interpolatePath docs: "Source code stems mostly from d3-interpolate-path". Changes from 2.3.0: absolute commands
// only (paths.ts sends anything else to its resampling), implicit repeats read as the SVG grammar reads them, a malformed list
// gives null, and the output is printed with spaces as Remotion's docs show ("M 50 0 L 50 0"), not d3's "M50,0L50,0".
type Command = { type: string; [arg: string]: number | string };
const ARGS: Record<string, string[]> = { M: ['x', 'y'], L: ['x', 'y'], H: ['x'], V: ['y'], C: ['x1', 'y1', 'x2', 'y2', 'x', 'y'], S: ['x2', 'y2', 'x', 'y'], Q: ['x1', 'y1', 'x', 'y'], T: ['x', 'y'], Z: [] };
const num = (c: Command, arg: string) => c[arg] as number;

/** Absolute commands from path tokens (letters and numbers); null when a command is unknown or short of numbers. */
function parse(tokens: string[]): Command[] | null {
  const out: Command[] = []; let type = '';
  for (let i = 0; i < tokens.length;) {
    // A letter starts a command; numbers repeat the last one (after M as L), and numbers after Z or before any letter are an error.
    if (isNaN(Number(tokens[i]))) { type = tokens[i++]; if (type === 'z') type = 'Z'; } else if (type === 'M') type = 'L'; else if (!ARGS[type]?.length) return null;
    if (!ARGS[type]) return null;
    const c: Command = { type }; for (const arg of ARGS[type]) { const v = Number(tokens[i++]); if (isNaN(v)) return null; c[arg] = v; }
    out.push(c);
  }
  return out;
}
/** de Casteljau: `points` (start, controls, end) split into `count` pieces of equal t, each as L, Q or C. */
function splitCurve(points: number[][], count: number): Command[] {
  const cut = (p: number[][], t: number) => {
    const left: number[][] = [], right: number[][] = [];
    for (let level = p; ; ) { left.push(level[0]); right.unshift(level[level.length - 1]); if (level.length === 1) break; const prev = level; level = prev.slice(1).map((q, i) => [(1 - t) * prev[i][0] + t * q[0], (1 - t) * prev[i][1] + t * q[1]]); }
    return { left, right };
  };
  const command = (p: number[][]): Command => { const end = p[p.length - 1]; return p.length === 4 ? { type: 'C', x1: p[1][0], y1: p[1][1], x2: p[2][0], y2: p[2][1], x: end[0], y: end[1] } : p.length === 3 ? { type: 'Q', x1: p[1][0], y1: p[1][1], x: end[0], y: end[1] } : { type: 'L', x: end[0], y: end[1] }; };
  const pieces: Command[] = []; let rest = points;
  for (let i = 0; i < count - 1; i++) { const { left, right } = cut(rest, 1 / count / (1 - i / count)); pieces.push(command(left)); rest = right; }
  return [...pieces, command(rest)];
}
/** The segment from `start` to `end` as `count` commands: L, Q and C are split, any other type repeats `start` (M as L). */
function splitSegment(start: Command, end: Command, count: number): Command[] {
  if (end.type === 'L' || end.type === 'Q' || end.type === 'C') {
    const points = [[num(start, 'x'), num(start, 'y')]];
    if (end.x1 != null) points.push([num(end, 'x1'), num(end, 'y1')]);
    if (end.x2 != null) points.push([num(end, 'x2'), num(end, 'y2')]);
    return splitCurve([...points, [num(end, 'x'), num(end, 'y')]], count);
  }
  const copy = { ...start, type: start.type === 'M' ? 'L' : start.type };
  return [...Array.from({ length: count - 1 }, () => copy), end];
}
/** `commands` extended to the length of `reference`: reference segment i adds a point to segment floor(i * ratio). */
function extend(commands: Command[], reference: Command[]): Command[] {
  const ratio = (commands.length - 1) / (reference.length - 1), counts: number[] = [];
  for (let i = 0; i < reference.length - 1; i++) { const at = Math.floor(ratio * i); counts[at] = (counts[at] ?? 0) + 1; }
  const out = [commands[0]];
  counts.forEach((count, i) => out.push(...(i === commands.length - 1
    ? Array.from({ length: count }, () => ({ ...commands[i], type: commands[i].type === 'M' ? 'L' : commands[i].type }))
    : splitSegment(commands[i], commands[i + 1], count))));
  return out;
}
/** `a` as `b`'s type: x1 / x2 from x, y1 / y2 from y, anything else 0; a command is never converted to M. */
function sameType(a: Command, b: Command): Command {
  if (a.type === b.type || b.type === 'M') return a;
  const from: Record<string, string> = { x1: 'x', y1: 'y', x2: 'x', y2: 'y' }, c: Command = { type: b.type };
  for (const arg of ARGS[b.type]) c[arg] = a[arg] ?? (from[arg] ? a[from[arg]] : undefined) ?? 0;
  return c;
}
/** The path `value` of the way from A to B (both as tokens; at 0 the extended A). Null when either does not parse. */
export function morphPath(value: number, tokensA: string[], tokensB: string[]): string | null {
  let a = parse(tokensA), b = parse(tokensB);
  if (!a || !b) return null;
  if (!a.length && !b.length) return '';
  // Z is dropped while the lists are matched and added back when both had it.
  const z = (!a.length || a[a.length - 1].type === 'Z') && (!b.length || b[b.length - 1].type === 'Z');
  if (a[a.length - 1]?.type === 'Z') a.pop();
  if (b[b.length - 1]?.type === 'Z') b.pop();
  if (!a.length) a.push(b[0]); else if (!b.length) b.push(a[0]);
  if (b.length > a.length) a = extend(a, b); else if (a.length > b.length) b = extend(b, a);
  a = a.map((c, i) => sameType(c, b[i]));
  return [...a.map((c, i) => [c.type, ...ARGS[c.type].map(arg => (1 - value) * num(c, arg) + value * num(b[i], arg))].join(' ')), ...z ? ['Z'] : []].join(' ');
}
