// SPDX-License-Identifier: AGPL-3.0-only
// Orientation fixtures shared by the T14 round-3 spec and the T29 spec: ffmpeg filter-chain oracles for the TIFF/EXIF
// Orientation definitions, and our generated TIFF / JPEG with an Orientation tag written in. No product helper is used here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { media } from '../media-fixtures';

export const dir = mkdtempSync(path.join(tmpdir(), 't14-round3-'));
export const run = (args: string[]) => { const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 16 << 20 }); if (r.status !== 0) throw Error(String(r.stderr)); return r.stdout as Buffer; };
// TIFF 6.0 / EXIF Orientation: 2 mirror left/right, 3 rotate 180, 4 mirror top/bottom, 5 transpose, 6 rotate 90 clockwise,
// 7 transverse, 8 rotate 90 counter-clockwise.
export const FILTER: Record<number, string> = { 1: 'null', 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };
export type Ref = { width: number; height: number; rgb: Buffer };
export const reference = (file: string, orientation: number): Ref => {
  const rgb = run(['-i', file, '-vf', FILTER[orientation], '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']), swap = orientation >= 5;
  return { width: swap ? 64 : 96, height: swap ? 96 : 64, rgb };
};
/** Our generated TIFF with an Orientation entry added in a rewritten IFD0 (all other entries and strips unchanged). */
export function taggedTiff(orientation: number) {
  const original = readFileSync(media('pattern.tiff')), le = original[0] === 0x49;
  const u16 = (b: Buffer, n: number) => le ? b.readUInt16LE(n) : b.readUInt16BE(n), u32 = (b: Buffer, n: number) => le ? b.readUInt32LE(n) : b.readUInt32BE(n);
  const put16 = (b: Buffer, n: number, v: number) => le ? b.writeUInt16LE(v, n) : b.writeUInt16BE(v, n), put32 = (b: Buffer, n: number, v: number) => le ? b.writeUInt32LE(v, n) : b.writeUInt32BE(v, n);
  const at = u32(original, 4), entries: Buffer[] = [];
  for (let n = 0; n < u16(original, at); n++) { const e = Buffer.from(original.subarray(at + 2 + n * 12, at + 14 + n * 12)); if (u16(e, 0) !== 274) entries.push(e); }
  const tag = Buffer.alloc(12); put16(tag, 0, 274); put16(tag, 2, 3); put32(tag, 4, 1); put16(tag, 8, orientation); entries.push(tag); entries.sort((a, b) => u16(a, 0) - u16(b, 0));
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4); put16(ifd, 0, entries.length); entries.forEach((e, n) => e.copy(ifd, 2 + n * 12));
  const bytes = Buffer.concat([original, ifd]); put32(bytes, 4, original.length);
  const file = path.join(dir, `o${orientation}.tiff`); writeFileSync(file, bytes); return { bytes, file };
}
/** Our 4:4:4 JPEG with an EXIF APP1 (big-endian TIFF header, IFD0 = Orientation only) inserted after SOI. */
export function taggedJpeg(orientation: number) {
  const original = readFileSync(media('pattern.jpg')), tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 1, 18, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]), head = Buffer.from([0xff, 0xe1, 0, 0]); head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([original.subarray(0, 2), head, body, original.subarray(2)]);
}
/** T14 audit F-05: taggedJpeg with 5 full APP15 segments (5 × 65,537 bytes) after its EXIF APP1, so SOF lies past the first 256 KB. */
export function paddedJpeg(orientation: number) {
  const tagged = taggedJpeg(orientation), end = 4 + tagged.readUInt16BE(4); // SOI, then APP1 marker + its length field and body
  const pad = Array.from({ length: 5 }, () => { const s = Buffer.alloc(4 + 65_533); s.writeUInt16BE(0xffef, 0); s.writeUInt16BE(65_535, 2); return s; });
  return Buffer.concat([tagged.subarray(0, end), ...pad, tagged.subarray(end)]);
}
/** T14 audit F-07: the pattern.tiff source frame as a 16-bit RGBA TIFF (rgba64le, testsrc2's alpha is opaque). */
export function rgba64Tiff() {
  const file = path.join(dir, 'pattern-rgba64.tiff');
  run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=1:duration=1', '-frames:v', '1', '-pix_fmt', 'rgba64le', file]); return file;
}
/** T14 audit F-07: the same source frame as a grey + alpha TIFF, 8-bit (ya8) or 16-bit (ya16le); the alpha is opaque. */
export function yaTiff(pixFmt: 'ya8' | 'ya16le') {
  const file = path.join(dir, pixFmt === 'ya8' ? 'pattern-ya8.tiff' : 'pattern-ya16.tiff');
  run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=1:duration=1', '-frames:v', '1', '-pix_fmt', pixFmt, file]); return file;
}
/** T14 audit F-07: an uncoded RGB 8-bit BigTIFF (magic 43, 8-byte offsets, one strip) written from raw RGB24 pixels; ffmpeg
 *  writes no BigTIFF. Little-endian: header 16 bytes, pixels, then IFD0 (8-byte count, 20-byte entries, 8-byte next offset). */
export function bigTiff(img: Ref) {
  const pixels = 16, ifd = pixels + img.rgb.length, types: Record<number, number> = { 3: 2, 4: 4, 16: 8 };
  // [tag, type, count, value]: SHORT 3, LONG 4, LONG8 16. BitsPerSample's three SHORTs fit in the 8-byte value field.
  const entries: [number, number, number, number[]][] = [[256, 4, 1, [img.width]], [257, 4, 1, [img.height]], [258, 3, 3, [8, 8, 8]], [259, 3, 1, [1]], [262, 3, 1, [2]],
    [273, 16, 1, [pixels]], [277, 3, 1, [3]], [278, 4, 1, [img.height]], [279, 16, 1, [img.rgb.length]], [284, 3, 1, [1]]];
  const head = Buffer.alloc(16); head.write('II', 0, 'latin1'); head.writeUInt16LE(43, 2); head.writeUInt16LE(8, 4); head.writeBigUInt64LE(BigInt(ifd), 8);
  const dirBytes = Buffer.alloc(8 + entries.length * 20 + 8); dirBytes.writeBigUInt64LE(BigInt(entries.length), 0);
  entries.forEach(([tag, type, count, values], n) => {
    const at = 8 + n * 20; dirBytes.writeUInt16LE(tag, at); dirBytes.writeUInt16LE(type, at + 2); dirBytes.writeBigUInt64LE(BigInt(count), at + 4);
    values.forEach((v, i) => { const o = at + 12 + i * types[type]; if (type === 3) dirBytes.writeUInt16LE(v, o); else if (type === 4) dirBytes.writeUInt32LE(v, o); else dirBytes.writeBigUInt64LE(BigInt(v), o); });
  });
  return Buffer.concat([head, img.rgb, dirBytes]);
}
