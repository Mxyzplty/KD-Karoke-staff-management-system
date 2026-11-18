// SPDX-License-Identifier: AGPL-3.0-only
// T14 audit F-05 / F-07 (lane A, 04:41): a TIFF whose IFD0 lies past the first 16 MiB keeps its Orientation in the probe.
// readExif in apps/web/src/media/probe.ts hands exifr only `blob.slice(0, Math.min(blob.size, 16 << 20))`, so an IFD0 after
// 16 MiB of pixels (libtiff's default layout puts IFD0 after the image data; the BigTIFF rewrite appends IFD0 at the end) is
// not seen and Orientation falls back to 1. Red today: both cases probe { width: 4096, height: 1400, orientation: 1 }.
// Expected values: the oriented size and the stored Orientation, the same contract as the F24 TIFF test
// (tests/ui/t14-round3-orientation.spec.ts:48) and probeImage (Orientation 5–8 swaps a header size). Cutframe design (lane A).
// Layouts: TIFF Revision 6.0 (Aldus, 1992, https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf: 8-byte header,
// magic 42, IFD anywhere in the file, 12-byte entries, values over 4 bytes out of line) and LibTIFF "BigTIFF Design"
// (https://libtiff.gitlab.io/libtiff/specification/bigtiff.html: magic 43, offset size 8, 20-byte entries, LONG8 = 16).
// Each file (~17.2 MB, zero pixels) is built in memory once per test; nothing is written to disk.
import { describe, expect, it } from 'vitest';
import { probeMedia } from '../apps/web/src/media/probe';

// Stored 4096 × 1400 RGB, 8 bits, uncompressed, one strip: 17,203,200 pixel bytes > 16 MiB (16,777,216).
const W = 4096, H = 1400, PIXELS = W * H * 3, SHORT = 3, LONG = 4, LONG8 = 16;
/** Header, pixels right after it, then IFD0 (Orientation 6) and its out-of-line values; returns the bytes and IFD0's offset. */
function lateIfdTiff(big: boolean): { bytes: Uint8Array; ifdAt: number } {
  const head = big ? 16 : 8, ifdAt = head + PIXELS, wide = big ? LONG8 : LONG, slot = big ? 8 : 4, size = big ? 20 : 12, count = big ? 8 : 2;
  // [tag, type, values]: ImageWidth, ImageLength, BitsPerSample, Compression 1, RGB, StripOffsets, Orientation 6, SamplesPerPixel,
  // RowsPerStrip, StripByteCounts. Every count is 1 except BitsPerSample (3 SHORTs: inline in BigTIFF, out of line in classic).
  const entries: [number, number, number[]][] = [[256, SHORT, [W]], [257, SHORT, [H]], [258, SHORT, [8, 8, 8]], [259, SHORT, [1]], [262, SHORT, [2]],
    [273, wide, [head]], [274, SHORT, [6]], [277, SHORT, [3]], [278, SHORT, [H]], [279, wide, [PIXELS]]];
  const width = (type: number) => type === SHORT ? 2 : type === LONG ? 4 : 8;
  let end = ifdAt + count + entries.length * size + slot;
  const outOfLine = entries.map(([, type, values]) => { if (values.length * width(type) <= slot) return -1; end += end & 1; const o = end; end += values.length * width(type); return o; });
  const bytes = new Uint8Array(end), v = new DataView(bytes.buffer), le = true;
  bytes[0] = bytes[1] = 0x49;
  if (big) { v.setUint16(2, 43, le); v.setUint16(4, 8, le); v.setUint16(6, 0, le); v.setBigUint64(8, BigInt(ifdAt), le); v.setBigUint64(ifdAt, BigInt(entries.length), le); }
  else { v.setUint16(2, 42, le); v.setUint32(4, ifdAt, le); v.setUint16(ifdAt, entries.length, le); }
  entries.forEach(([tag, type, values], n) => {
    const p = ifdAt + count + n * size, field = p + (big ? 12 : 8);
    v.setUint16(p, tag, le); v.setUint16(p + 2, type, le);
    if (big) v.setBigUint64(p + 4, BigInt(values.length), le); else v.setUint32(p + 4, values.length, le);
    const at = outOfLine[n] < 0 ? field : outOfLine[n];
    if (outOfLine[n] >= 0) v.setUint32(field, at, le);
    values.forEach((x, i) => { const o = at + i * width(type); if (type === SHORT) v.setUint16(o, x, le); else if (type === LONG) v.setUint32(o, x, le); else v.setBigUint64(o, BigInt(x), le); });
  });
  return { bytes, ifdAt };
}
async function probeLate(big: boolean, name: string) {
  const { bytes, ifdAt } = lateIfdTiff(big);
  expect(ifdAt, 'IFD0 lies past the first 16 MiB').toBeGreaterThan(16 << 20);
  const info = await probeMedia(new Blob([bytes]), name, 'image');
  return { image: info.image, decoder: info.decoder, container: info.container };
}
const ORIENTED = { image: { width: H, height: W, orientation: 6 }, decoder: 'wasm', container: 'tiff' };

describe('T14 audit F-05 / F-07: TIFF Orientation when IFD0 lies past 16 MiB (lane A 04:41)', () => {
  it('(a) BigTIFF, IFD0 after 17.2 MB of pixels, Orientation 6: oriented size and orientation 6', async () => {
    expect(await probeLate(true, 'late-ifd-big.tiff')).toEqual(ORIENTED);
  });
  it('(b) classic TIFF, IFD0 after 17.2 MB of pixels, Orientation 6: oriented size and orientation 6', async () => {
    expect(await probeLate(false, 'late-ifd-classic.tiff')).toEqual(ORIENTED);
  });
});
