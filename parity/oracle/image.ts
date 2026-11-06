// SPDX-License-Identifier: AGPL-3.0-only
// Shared CPU float image contract for the formula oracle (findings part 4 §48).
// Storage is row-major with row 0 at the TOP (as decoded frames are). Effect
// maths uses the export convention instead: x right, y UP from the bottom edge,
// pixel centres at (k + 0.5) / size. Colours are gamma-encoded sRGB in 0…1,
// straight (not premultiplied) alpha unless a function says otherwise.
import type { RGBA } from './math';

export type Image = { width: number; height: number; data: Float32Array; transfer?: string };
// timeS: seconds since the item's start. seed: the per-render random value in
// [0, 1000) that glitch/vhs draw; the oracle takes it as an explicit input.
export type EffectContext = { timeS: number; seed?: number };
// One effect pass: reads the previous pass, returns a new image of the same size.
export type Effect = (input: Image, params: Record<string, any>, context: EffectContext) => Image;

export function createImage(width: number, height: number, fill: RGBA = [0, 0, 0, 0]): Image {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw Error('Image size must be positive integers');
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
}

// Texel by integer column and integer row counted UP from the bottom row; clamp-to-edge.
export function texel(image: Image, column: number, rowFromBottom: number): RGBA {
  const x = Math.min(Math.max(column, 0), image.width - 1);
  const y = Math.min(Math.max(rowFromBottom, 0), image.height - 1);
  const i = ((image.height - 1 - y) * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

// One bilinear sample at normalised export coordinates, clamp-to-edge (GL LINEAR).
export function sample(image: Image, x: number, y: number): RGBA {
  const fx = x * image.width - 0.5, fy = y * image.height - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const a = texel(image, x0, y0), b = texel(image, x0 + 1, y0), c = texel(image, x0, y0 + 1), d = texel(image, x0 + 1, y0 + 1);
  return [0, 1, 2, 3].map(k => (a[k] * (1 - tx) + b[k] * tx) * (1 - ty) + (c[k] * (1 - tx) + d[k] * tx) * ty) as RGBA;
}

// Per-pixel pass; f receives the straight RGBA and the pixel-centre export coordinates.
export function mapPixels(image: Image, f: (colour: RGBA, x: number, y: number) => RGBA): Image {
  const out = createImage(image.width, image.height);
  for (let row = 0; row < image.height; row++) for (let column = 0; column < image.width; column++) {
    const i = (row * image.width + column) * 4;
    const value = f([image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]], (column + 0.5) / image.width, 1 - (row + 0.5) / image.height);
    out.data.set(value, i);
  }
  return out;
}

// Final 8-bit write: clamp, then round to the nearest code.
export function quantise8(image: Image): Uint8ClampedArray {
  const out = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(Math.max(image.data[i], 0), 1) * 255);
  return out;
}
