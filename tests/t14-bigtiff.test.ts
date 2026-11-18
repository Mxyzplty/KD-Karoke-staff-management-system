// SPDX-License-Identifier: AGPL-3.0-only
// T14 audit F-07 (lane A, 04:15 / 04:22): bigTiffToClassic rewrites a BigTIFF into a classic TIFF (same byte order, IFD0 only,
// types 16/17/18 → 4/9/13, strip and tile data left at their offsets, the IFD and every out-of-line value on an even offset,
// the four sub-IFD pointers dropped) or refuses with null. Red first: apps/web/src/media/bigtiff.ts does not exist yet, so
// this file fails to import until the helper lands.
// Every file is built here byte by byte. Expected values come from the classic layout of TIFF Revision 6.0 (Aldus, 1992,
// https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf: 8-byte header, magic 42, 12-byte entries, values over
// 4 bytes out of line on a word boundary, types 1–12) and the BigTIFF design (LibTIFF, "BigTIFF Design",
// https://libtiff.gitlab.io/libtiff/specification/bigtiff.html: magic 43, offset size 8, 8-byte entry count, 20-byte entries,
// types 16 LONG8, 17 SLONG8, 18 IFD8). The classic twin C of each BigTIFF B is the expected result.
import { describe, expect, it } from 'vitest';
import { bigTiffToClassic } from '../apps/web/src/media/bigtiff';

type Entry = { tag: number; type: number; count: number; values: number[] | string };
// Bytes per value: TIFF 6.0 types 1–12, IFD (13, TIFF Technical Note 1), BigTIFF 16–18.
const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
const SHORT = 3, LONG = 4, ASCII = 2, LONG8 = 16, IFD8 = 18;
const POINTERS = [330, 34665, 34853, 40965];
function encode(e: Entry, le: boolean): Uint8Array {
  const out = new Uint8Array(e.count * SIZE[e.type]), v = new DataView(out.buffer);
  if (typeof e.values === 'string') { for (let i = 0; i < e.values.length; i++) out[i] = e.values.charCodeAt(i); return out; }
  e.values.forEach((n, i) => {
    const at = i * SIZE[e.type];
    if (e.type === SHORT) v.setUint16(at, n, le); else if (e.type === LONG) v.setUint32(at, n, le); else if (e.type === LONG8 || e.type === IFD8) v.setBigUint64(at, BigInt(n), le); else throw Error(`no encoder for type ${e.type}`);
  });
  return out;
}
/** An IFD to be placed at file offset `at`: entries in tag order, then each out-of-line value on an even offset; next IFD 0. */
function ifd(entries: Entry[], at: number, le: boolean, big: boolean): Uint8Array {
  const slot = big ? 8 : 4, size = big ? 20 : 12, head = big ? 8 : 2, values = entries.map(e => encode(e, le));
  let end = head + entries.length * size + slot;
  const offsets = values.map(b => { if (b.length <= slot) return -1; end += end & 1; const o = end; end += b.length; return o; });
  const out = new Uint8Array(end), v = new DataView(out.buffer);
  if (big) v.setBigUint64(0, BigInt(entries.length), le); else v.setUint16(0, entries.length, le);
  entries.forEach((e, n) => {
    const p = head + n * size, value = p + (big ? 12 : 8);
    v.setUint16(p, e.tag, le); v.setUint16(p + 2, e.type, le);
    if (big) v.setBigUint64(p + 4, BigInt(e.count), le); else v.setUint32(p + 4, e.count, le);
    if (offsets[n] < 0) { out.set(values[n], value); return; }
    if (big) v.setBigUint64(value, BigInt(at + offsets[n]), le); else v.setUint32(value, at + offsets[n], le);
    out.set(values[n], offsets[n]);
  });
  return out;
}
/** A whole file: header, IFD0 right after it, and fixed blocks (pixel data, a sub-IFD) at their own offsets. */
function file(entries: Entry[], le: boolean, big: boolean, blocks: { at: number; bytes: Uint8Array }[]): Uint8Array {
  const start = big ? 16 : 8, dir = ifd([...entries].sort((a, b) => a.tag - b.tag), start, le, big);
  const out = new Uint8Array(Math.max(start + dir.length, ...blocks.map(b => b.at + b.bytes.length))), v = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d;
  if (big) { v.setUint16(2, 43, le); v.setUint16(4, 8, le); v.setUint16(6, 0, le); v.setBigUint64(8, BigInt(start), le); } else { v.setUint16(2, 42, le); v.setUint32(4, start, le); }
  out.set(dir, start);
  for (const b of blocks) { if (b.at < start + dir.length) throw Error('block overlaps IFD0'); out.set(b.bytes, b.at); }
  return out;
}
// Tiny classic IFD0 reader: types 1–13 only (anything else throws), IFD0 only, values resolved inline or out of line.
type Read = { order: string; magic: number; ifdAt: number; next: number; entries: { tag: number; type: number; count: number; bytes: number[]; at: number | null }[] };
function readClassic(b: Uint8Array): Read {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), le = b[0] === 0x49, magic = v.getUint16(2, le), ifdAt = v.getUint32(4, le), n = v.getUint16(ifdAt, le), entries: Read['entries'] = [];
  for (let i = 0; i < n; i++) {
    const p = ifdAt + 2 + i * 12, tag = v.getUint16(p, le), type = v.getUint16(p + 2, le), count = v.getUint32(p + 4, le);
    if (!(type >= 1 && type <= 13)) throw Error(`tag ${tag}: type ${type} is not a classic TIFF type`);
    const size = count * SIZE[type], at = size > 4 ? v.getUint32(p + 8, le) : null, from = at ?? p + 8;
    entries.push({ tag, type, count, bytes: Array.from(b.subarray(from, from + size)), at });
  }
  return { order: String.fromCharCode(b[0], b[1]), magic, ifdAt, next: v.getUint32(ifdAt + 2 + n * 12, le), entries };
}
const fields = (r: Read) => r.entries.map(({ tag, type, count, bytes }) => ({ tag, type, count, bytes }));
/** SHORT / LONG values of one entry, as numbers. */
function numbers(r: Read, tag: number): number[] {
  const e = r.entries.find(x => x.tag === tag)!, v = new DataView(Uint8Array.from(e.bytes).buffer), le = r.order === 'II';
  return Array.from({ length: e.count }, (_, i) => e.type === SHORT ? v.getUint16(i * 2, le) : v.getUint32(i * 4, le));
}
const pixels = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed) & 255);
const common = (width: number, height: number, sizeType: number): Entry[] => [
  { tag: 256, type: sizeType, count: 1, values: [width] }, { tag: 257, type: sizeType, count: 1, values: [height] },
  { tag: 258, type: SHORT, count: 3, values: [8, 8, 8] }, { tag: 259, type: SHORT, count: 1, values: [1] }, { tag: 262, type: SHORT, count: 1, values: [2] },
  // 7 ASCII bytes: inline in a BigTIFF entry (≤ 8), out of line in a classic one (> 4).
  { tag: 270, type: ASCII, count: 7, values: 'pixels\0' }, { tag: 274, type: SHORT, count: 1, values: [1] }, { tag: 277, type: SHORT, count: 1, values: [3] },
];
// (a): 4 × 2 RGB, two strips of one row (12 bytes each) at 512 and 524 in both files.
const STRIPS = [512, 524], strip = pixels(24, 5);
const stripped = (offsets: number[], counts: number[], wide: number): Entry[] => [...common(4, 2, SHORT), { tag: 278, type: SHORT, count: 1, values: [1] },
  { tag: 273, type: wide, count: 2, values: offsets }, { tag: 279, type: wide, count: 2, values: counts }];
const stripBlock = [{ at: STRIPS[0], bytes: strip }];
function expectClassicLike(result: Uint8Array | null, classic: Uint8Array, order: string) {
  expect(result).not.toBeNull();
  const r = readClassic(result!), c = readClassic(classic);
  expect([r.order, r.magic, r.next]).toEqual([order, 42, 0]);
  expect(fields(r)).toEqual(fields(c));
  // Lane A, 04:22: the rewritten IFD and every appended out-of-line value start on an even offset (TIFF word alignment).
  expect(r.ifdAt % 2, 'IFD0 offset is even').toBe(0);
  for (const e of r.entries) if (e.at !== null) expect(e.at % 2, `tag ${e.tag} value offset ${e.at} is even`).toBe(0);
  return r;
}

describe('T14 audit F-07: bigTiffToClassic (BigTIFF → classic TIFF before the libav path)', () => {
  it('(a) little-endian, LONG8 strip arrays, a value inline in BigTIFF but out of line in classic: tags and data offsets equal the classic original', () => {
    const classic = file(stripped(STRIPS, [12, 12], LONG), true, false, stripBlock), big = file(stripped(STRIPS, [12, 12], LONG8), true, true, stripBlock);
    const r = expectClassicLike(bigTiffToClassic(big), classic, 'II'), out = bigTiffToClassic(big)!;
    const offsets = numbers(r, 273), counts = numbers(r, 279);
    expect([offsets, counts]).toEqual([STRIPS, [12, 12]]);
    offsets.forEach((o, i) => expect(Array.from(out.subarray(o, o + counts[i])), `strip ${i}`).toEqual(Array.from(strip.subarray(i * 12, (i + 1) * 12))));
  });
  it('(b) big-endian (MM), tiled: TileWidth / TileLength / TileOffsets / TileByteCounts as LONG8 equal the classic original, tiles at their offsets', () => {
    // 32 × 16 RGB in two 16 × 16 tiles (TIFF 6.0: TileWidth and TileLength are multiples of 16), 768 bytes each, at 512 and 1280.
    const TILES = [512, 1280], tile = pixels(2 * 768, 11);
    const tiled = (wide: number): Entry[] => [...common(32, 16, LONG), { tag: 322, type: wide, count: 1, values: [16] }, { tag: 323, type: wide, count: 1, values: [16] },
      { tag: 324, type: wide, count: 2, values: TILES }, { tag: 325, type: wide, count: 2, values: [768, 768] }];
    const blocks = [{ at: TILES[0], bytes: tile }];
    const classic = file(tiled(LONG), false, false, blocks), big = file(tiled(LONG8), false, true, blocks);
    const r = expectClassicLike(bigTiffToClassic(big), classic, 'MM'), out = bigTiffToClassic(big)!;
    const offsets = numbers(r, 324), counts = numbers(r, 325);
    expect([numbers(r, 322), numbers(r, 323), offsets, counts]).toEqual([[16], [16], TILES, [768, 768]]);
    offsets.forEach((o, i) => expect(Array.from(out.subarray(o, o + counts[i])), `tile ${i}`).toEqual(Array.from(tile.subarray(i * 768, (i + 1) * 768))));
  });
  it('(c) a StripOffsets or StripByteCounts value of 2^32 is refused (null), on the value, not the file size', () => {
    expect(bigTiffToClassic(file(stripped([2 ** 32, 524], [12, 12], LONG8), true, true, stripBlock)), 'StripOffsets 2^32').toBeNull();
    expect(bigTiffToClassic(file(stripped(STRIPS, [2 ** 32, 12], LONG8), true, true, stripBlock)), 'StripByteCounts 2^32').toBeNull();
  });
  it('(d) the Exif IFD pointer (IFD8, to a BigTIFF-layout sub-IFD) is dropped; every other entry equals the classic original', () => {
    // The sub-IFD after the strips, in BigTIFF layout: DateTimeOriginal (36867), 20 ASCII bytes (out of line even in BigTIFF).
    const SUB = 1024, sub = ifd([{ tag: 36867, type: ASCII, count: 20, values: '2026:11:19 04:22:00\0' }], SUB, true, true);
    const classic = file(stripped(STRIPS, [12, 12], LONG), true, false, stripBlock);
    const big = file([...stripped(STRIPS, [12, 12], LONG8), { tag: 34665, type: IFD8, count: 1, values: [SUB] }], true, true, [...stripBlock, { at: SUB, bytes: sub }]);
    const r = expectClassicLike(bigTiffToClassic(big), classic, 'II');
    expect(r.entries.map(e => e.tag).filter(t => POINTERS.includes(t))).toEqual([]);
  });
});
