// SPDX-License-Identifier: AGPL-3.0-only
// Colour maths for the shared colour picker (part 3 §46.4, §46.7): HSV ↔ RGB ↔ hex with alpha, and CSS gradient strings.
export type Rgba = { r: number; g: number; b: number; a: number };
export type Hsva = { h: number; s: number; v: number; a: number };
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
/** '#rgb', '#rrggbb', '#rrggbbaa' or 'transparent' → RGBA (0–255, alpha 0–1); null when it is not a colour we read. */
export function parseColour(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/); if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}
/** Opaque colours as '#rrggbb', others as '#rrggbbaa'. */
export const formatColour = (c: Rgba) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a >= 1 ? '' : hex2(c.a * 255)}`;
export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max, a };
}
export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return { r: Math.round(f(5) * 255), g: Math.round(f(3) * 255), b: Math.round(f(1) * 255), a: clamp01(a) };
}
export type GradientStop = { colour: string; at: number };
export type Gradient = { kind: 'linear' | 'radial'; angle: number; position: string; stops: GradientStop[] };
export const DEFAULT_GRADIENT: Gradient = { kind: 'linear', angle: 180, position: 'center', stops: [{ colour: '#000000', at: 0 }, { colour: '#ffffff', at: 100 }] };
export function gradientCss(g: Gradient): string {
  const stops = [...g.stops].sort((a, b) => a.at - b.at).map(s => `${s.colour} ${Math.round(s.at)}%`).join(', ');
  return g.kind === 'linear' ? `linear-gradient(${Math.round(g.angle)}deg, ${stops})` : `radial-gradient(circle at ${g.position}, ${stops})`;
}
/** Reads back a gradient string written by gradientCss; null for anything else. */
export function parseGradient(value: string): Gradient | null {
  const m = value.trim().match(/^(linear|radial)-gradient\((.*)\)$/); if (!m) return null;
  const parts = m[2].split(/,(?![^(]*\))/).map(s => s.trim()), head = parts[0];
  const linear = m[1] === 'linear', angle = linear ? head.match(/^(-?\d+(?:\.\d+)?)deg$/) : null, at = !linear ? head.match(/^circle(?: at (.+))?$/) : null;
  const stops = parts.slice(angle || at ? 1 : 0).map(s => s.match(/^(\S+)\s+(\d+(?:\.\d+)?)%$/)).filter((x): x is RegExpMatchArray => !!x).map(x => ({ colour: x[1], at: Number(x[2]) }));
  if (stops.length < 2) return null;
  return { kind: linear ? 'linear' : 'radial', angle: angle ? Number(angle[1]) : 180, position: at?.[1] ?? 'center', stops };
}
export const RADIAL_POSITIONS = ['left top', 'top', 'right top', 'left', 'center', 'right', 'left bottom', 'bottom', 'right bottom'];
