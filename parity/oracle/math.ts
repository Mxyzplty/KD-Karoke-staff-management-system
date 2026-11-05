// SPDX-License-Identifier: AGPL-3.0-only
// CPU reference of the clean-room equations in findings parts4–5.
export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];
export type Params = Record<string, any>;
export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const frac = (x: number) => x - Math.floor(x);
export const smooth = (a: number, b: number, x: number) => { const t = a === b ? Number(x >= b) : clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const y601 = (c: number[]) => c[0] * .299 + c[1] * .587 + c[2] * .114;
export const y709 = (c: number[]) => c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
export const rgbMap = (c: number[], f: (v: number, i: number) => number): RGB => [f(c[0], 0), f(c[1], 1), f(c[2], 2)];
export const sat = (c: RGB, k: number, luma = y601): RGB => { const y = luma(c); return rgbMap(c, v => y + (v - y) * k); };
export const wb = (c: RGB, t: number, u: number): RGB => [c[0] + .1 * t + .05 * u, c[1] - .1 * u, c[2] - .1 * t + .05 * u];
export function hsv(c: number[]): RGB {
  const high = Math.max(...c.slice(0, 3)), low = Math.min(...c.slice(0, 3)), d = high - low;
  const h = d < 1e-10 ? 0 : high === c[0] ? (c[1] - c[2]) / d : high === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  return [frac(h / 6), d / (high + 1e-10), high];
}
export const fromHsv = ([h, s, v]: RGB): RGB => [1, 2 / 3, 1 / 3].map(o => v * mix(1, clamp(Math.abs(frac(h + o) * 6 - 3) - 1), s)) as RGB;
export function hsl(c: RGB): RGB { const [h] = hsv(c), hi = Math.max(...c), lo = Math.min(...c), l = (hi + lo) / 2, d = hi - lo; return [h * 360, d < 1e-5 ? 0 : d / (1 - Math.abs(2 * l - 1)), l]; }
export function fromHsl([h, s, l]: RGB): RGB { const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2; const p = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return p.map(v => v + m) as RGB; }
export const h1 = (n: number) => frac(43758.5453 * Math.sin(n));
export const h2 = (x: number, y: number) => h1(12.9898 * x + 78.233 * y);
export function hw(x: number, y: number) { const q = [frac(x * .1031), frac(y * .1031), frac(x * .1031)]; const d = q[0] * (q[1] + 33.33) + q[1] * (q[2] + 33.33) + q[2] * (q[0] + 33.33); return frac((q[0] + q[1] + 2 * d) * (q[2] + d)); }
export function colour(value: string, fallback = '#000000'): RGBA {
  if (typeof value !== 'string') return colour(fallback);
  let hex = value.replace(/^#/, '');
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = [...hex].map(s => s + s).join('');
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return [0, 2, 4, 6].map((i) => i === 6 && hex.length === 6 ? 1 : parseInt(hex.slice(i, i + 2), 16) / 255) as RGBA;
  const m = value.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const a = m[1].split(',').map(Number); if (a.length >= 3 && a.every(Number.isFinite)) return [a[0] / 255, a[1] / 255, a[2] / 255, a[3] ?? 1]; }
  return colour(fallback);
}
export function oklab(c: RGB): RGB {
  const [r, g, b] = c.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b), m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b), s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
export function labLinear([l, a, b]: RGB): RGB { const x = (l + .3963377774 * a + .2158037573 * b) ** 3, y = (l - .1055613458 * a - .0638541728 * b) ** 3, z = (l - .0894841775 * a - 1.291485548 * b) ** 3; return [4.0767416621 * x - 3.3077115913 * y + .2309699292 * z, -1.2684380046 * x + 2.6097574011 * y - .3413193965 * z, -.0041960863 * x - .7034186147 * y + 1.707614701 * z]; }
export const srgb = (v: number) => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055;
