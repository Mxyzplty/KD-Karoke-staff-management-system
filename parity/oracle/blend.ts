// SPDX-License-Identifier: AGPL-3.0-only
// Blend modes of findings part 5 §58: W3C Compositing and Blending Level 1 on gamma-encoded
// sRGB 0…1 (no linear-light step), straight alpha, then source-over; 8-bit store after each draw.
import { createImage, type Image } from './image';
import type { RGB, RGBA } from './math';

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

// §58.3: the result × 255 is rounded to the nearest 8-bit value.
export const q8 = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255) / 255;

const screen = (b: number, s: number) => b + s - b * s;
const hard = (b: number, s: number) => s <= 0.5 ? b * 2 * s : screen(b, 2 * s - 1);
export const separable: Record<string, (b: number, s: number) => number> = {
  normal: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen,
  overlay: (b, s) => hard(s, b),
  darken: Math.min,
  lighten: Math.max,
  'color-dodge': (b, s) => b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s)),
  'color-burn': (b, s) => b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s),
  'hard-light': hard,
  'soft-light': (b, s) => s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

// W3C non-separable helpers: Lum = 0.3 R + 0.59 G + 0.11 B, ClipColor, SetLum, Sat, SetSat.
export const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColour(c: RGB): RGB {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  let out = c;
  if (n < 0) out = out.map(v => l + (v - l) * l / (l - n)) as RGB;
  if (x > 1) out = out.map(v => l + (v - l) * (1 - l) / (x - l)) as RGB;
  return out;
}
const setLum = (c: RGB, l: number) => { const d = l - lum(c); return clipColour(c.map(v => v + d) as RGB); };
const sat = (c: RGB) => Math.max(...c) - Math.min(...c);
function setSat(c: RGB, s: number): RGB {
  const order = [0, 1, 2].sort((i, j) => c[i] - c[j]), [lo, mid, hi] = order, out: RGB = [0, 0, 0];
  if (c[hi] > c[lo]) { out[mid] = (c[mid] - c[lo]) * s / (c[hi] - c[lo]); out[hi] = s; }
  return out;
}
const nonSeparable: Record<string, (b: RGB, s: RGB) => RGB> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};

// B(Cb, Cs) per mode.
export function blendColour(mode: string, b: RGB, s: RGB): RGB {
  if (nonSeparable[mode]) return nonSeparable[mode](b, s);
  const f = separable[mode];
  if (!f) throw Error(`unknown blend mode ${mode}`);
  return [f(b[0], s[0]), f(b[1], s[1]), f(b[2], s[2])];
}

// §58.2 compositing: Cm = (1 − αb)·Cs + αb·B(Cb, Cs), then source-over. Straight RGBA in and out.
export function composite(b: RGBA, s: RGBA, mode: string): RGBA {
  const ab = b[3], as = s[3], ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const B = blendColour(mode, [b[0], b[1], b[2]], [s[0], s[1], s[2]]);
  const ch = (i: number) => (as * ((1 - ab) * s[i] + ab * B[i]) + (1 - as) * ab * b[i]) / ao;
  return [ch(0), ch(1), ch(2), ao];
}

// One draw of `layer` onto `backdrop` (same size), stored back to 8 bit.
export function compositeImage(backdrop: Image, layer: Image, mode: string, quantise = true): Image {
  if (backdrop.width !== layer.width || backdrop.height !== layer.height) throw Error('composite: size mismatch');
  const out = createImage(backdrop.width, backdrop.height), d = backdrop.data, l = layer.data;
  for (let i = 0; i < d.length; i += 4) {
    const v: RGBA = l[i + 3] > 0 ? composite([d[i], d[i + 1], d[i + 2], d[i + 3]], [l[i], l[i + 1], l[i + 2], l[i + 3]], mode) : [d[i], d[i + 1], d[i + 2], d[i + 3]];
    out.data.set(quantise ? v.map(q8) : v, i);
  }
  return out;
}
