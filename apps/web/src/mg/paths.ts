// SPDX-License-Identifier: AGPL-3.0-only
import { svgPathProperties } from 'svg-path-properties';
import { createNoise3D } from 'simplex-noise';
import { morphPath } from './interpolate-path';
export function evolvePath(progress: number, path: string): { strokeDasharray: string; strokeDashoffset: number } {
  const length = new svgPathProperties(path).getTotalLength();
  return { strokeDasharray: `${length} ${length}`, strokeDashoffset: length * (1 - progress) };
}
export function interpolatePath(value: number, pathA: string, pathB: string): string {
  if (value === 1) return pathB;
  const commands = (path: string) => path.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/g) ?? [];
  const a = commands(pathA), b = commands(pathB);
  if (!/[aA]/.test(pathA + pathB) && a.length === b.length && a.every((v, i) => isNaN(Number(v)) ? v === b[i] : !isNaN(Number(b[i])))) return value === 0 ? pathA : a.map((v, i) => isNaN(Number(v)) ? v : String(Number(v) + (Number(b[i]) - Number(v)) * value)).join(' ');
  // Other command lists: d3-interpolate-path's algorithm, which Remotion's interpolatePath is ported from (at 0 the extended A).
  const morphed = morphPath(value, a, b);
  if (morphed !== null) return morphed;
  if (value === 0) return pathA;
  // Arcs and relative commands are normalised to equal-length arc-distance polylines.
  const pa = new svgPathProperties(pathA), pb = new svgPathProperties(pathB), count = 256;
  return Array.from({ length: count + 1 }, (_, i) => { const x = pa.getPointAtLength(pa.getTotalLength() * i / count), y = pb.getPointAtLength(pb.getTotalLength() * i / count); return `${i ? 'L' : 'M'} ${x.x + (y.x - x.x) * value} ${x.y + (y.y - x.y) * value}`; }).join(' ') + (/z\s*$/i.test(pathA) && /z\s*$/i.test(pathB) ? ' Z' : '');
}
const noises = new Map<string, ReturnType<typeof createNoise3D>>();
export function noise3D(seed: string | number, x: number, y: number, z: number): number {
  const key = String(seed); let noise = noises.get(key);
  if (!noise) { let state = 2166136261; for (const c of key) state = Math.imul(state ^ c.charCodeAt(0), 16777619); noise = createNoise3D(() => { state += 0x6d2b79f5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }); if (noises.size >= 128) noises.delete(noises.keys().next().value!); noises.set(key, noise); }
  return noise(x, y, z);
}
