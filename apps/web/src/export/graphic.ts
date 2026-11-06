// SPDX-License-Identifier: AGPL-3.0-only
// D35: read the renderer's canvas PNG directly, so the input table sees its stored straight RGB.
// Swapping this for canvas or ImageDecoder is a pixel change. D34/D35 review, not re-measured here:
// exact in Playwright Chromium 156.0.8078.4, but installed Chrome 156.0.8078.80 differs by ±1 on partial
// alpha (1,422 bytes over all 65,536 straight/alpha pairs; at most 2 codes after table and composite).
// This reads only the non-interlaced 8-bit RGB/RGBA PNG produced by the graphic renderer.
// Format and filters: https://www.w3.org/TR/png-3/#9Filters
import { BT709_TO_SRGB } from './colour';

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
};
export async function decodeGraphicPng(png: Uint8Array<ArrayBuffer>): Promise<ImageData> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength), idat: Uint8Array<ArrayBuffer>[] = [];
  let width = 0, height = 0, channels = 0;
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) throw Error('Invalid graphic PNG.');
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at), type = view.getUint32(at + 4), start = at + 8;
    if (start + length + 4 > png.length) throw Error('Truncated graphic PNG.');
    if (type === 0x49484452) {
      width = view.getUint32(start); height = view.getUint32(start + 4);
      const kind = png[start + 9];
      if (png[start + 8] !== 8 || (kind !== 2 && kind !== 6) || png[start + 10] !== 0 || png[start + 11] !== 0 || png[start + 12] !== 0)
        throw Error('Graphic PNG must be non-interlaced 8-bit RGB or RGBA.');
      channels = kind === 6 ? 4 : 3;
    } else if (type === 0x49444154) idat.push(png.subarray(start, start + length));
    else if (type === 0x49454e44) break;
    at = start + length + 4;
  }
  if (!width || !height || !channels || width * height > 4096 * 4096) throw Error('Invalid graphic PNG dimensions.');
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = width * channels, row = stride + 1;
  if (raw.length !== row * height) throw Error('Invalid graphic PNG scanlines.');
  for (let y = 0; y < height; y++) {
    const start = y * row + 1, filter = raw[start - 1];
    if (filter > 4) throw Error('Invalid graphic PNG filter.');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? raw[start + x - channels] : 0, b = y ? raw[start + x - row] : 0, c = y && x >= channels ? raw[start + x - row - channels] : 0;
      raw[start + x] += filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = y * row + 1 + x * channels, d = (y * width + x) * 4;
    data[d] = raw[s]; data[d + 1] = raw[s + 1]; data[d + 2] = raw[s + 2]; data[d + 3] = channels === 4 ? raw[s + 3] : 255;
  }
  return new ImageData(data, width, height);
}
/** Export owns the returned bitmap. Only RGB changes; premultiplication happens after the input lookup. */
export async function graphicBitmap(png: string): Promise<ImageBitmap> {
  const binary = atob(png.slice(png.indexOf(',') + 1)), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const image = await decodeGraphicPng(bytes);
  for (let p = 0; p < image.data.length; p += 4) {
    image.data[p] = BT709_TO_SRGB[image.data[p]]; image.data[p + 1] = BT709_TO_SRGB[image.data[p + 1]]; image.data[p + 2] = BT709_TO_SRGB[image.data[p + 2]];
  }
  return createImageBitmap(image);
}
