// SPDX-License-Identifier: AGPL-3.0-only
// CPU colour helpers shared by the uniform packer and the CSS chain (part 4 §48 notation).
export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

/**
 * Colour string → straight RGBA 0…1. `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (the `#` is optional) or
 * `rgb(a)(r, g, b[, a])` with r/g/b in 0…255 and a as given; anything else parses `fallback`.
 */
export function parseColour(value: unknown, fallback = '#000000'): RGBA {
  if (typeof value !== 'string') return parseColour(fallback);
  let hex = value.replace(/^#/, '');
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = [...hex].map(s => s + s).join('');
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex))
    return [0, 2, 4, 6].map(i => i === 6 && hex.length === 6 ? 1 : parseInt(hex.slice(i, i + 2), 16) / 255) as RGBA;
  const m = value.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const a = m[1].split(',').map(Number);
    if (a.length >= 3 && a.every(Number.isFinite)) return [a[0] / 255, a[1] / 255, a[2] / 255, a[3] ?? 1];
  }
  return parseColour(fallback);
}

/** Color Key's key colour: hex (3 or 6 digits) or an `rgb(a)(` string, else Xapp green; alpha ignored (§49.11). */
export function keyColour(value: unknown): RGB {
  const ok = typeof value === 'string' && (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) || /^rgba?\(/.test(value));
  return parseColour(ok ? value : '#00b140', '#00b140').slice(0, 3) as RGB;
}

const linear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;

/** Gamma sRGB → OKLab (§49.19). */
export function oklab(c: RGB): RGB {
  const [r, g, b] = c.map(linear);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s];
}

const srgbEncode = (v: number) => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055;

/** The 256-entry BT.709 input table (§48.1 0.1): invert the camera curve, sRGB-encode, round to 8 bit. */
export function bt709Table(): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255, lin = x < 0.081 ? x / 4.5 : ((x + 0.099) / 1.099) ** (1 / 0.45);
    t[i] = Math.round(Math.min(Math.max(srgbEncode(lin), 0), 1) * 255);
  }
  return t;
}
