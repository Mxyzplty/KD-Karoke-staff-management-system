// SPDX-License-Identifier: AGPL-3.0-only
// BigTIFF → classic TIFF before the libav path (audit F-07, lane A 04:15 / 04:22): FFmpeg's TIFF decoder and the probe read
// classic TIFF only. Classic layout: TIFF Revision 6.0 (Aldus, 1992, https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf:
// 8-byte header, magic 42, 2-byte entry count, 12-byte entries, values over 4 bytes out of line on a word boundary). BigTIFF:
// LibTIFF "BigTIFF Design" (https://libtiff.gitlab.io/libtiff/specification/bigtiff.html: magic 43, offset size 8, 8-byte entry
// count, 20-byte entries, values over 8 bytes out of line, types 16 LONG8, 17 SLONG8, 18 IFD8).
// IFD0 only (multi-page unspecified, T29 ruling 4). Pixel data stays at its offsets: the input is copied, a classic header goes
// over its first 8 bytes and the new IFD0 and its out-of-line values are appended, each on an even offset; next IFD 0.
// The sub-IFD pointers (SubIFDs, Exif, GPS, Interop) are dropped: their targets are in BigTIFF layout.
// Unknown types are dropped (TIFF 6.0: "Readers should skip over fields containing an unexpected field type").
// null when the file is not a BigTIFF or anything needs more than 32 bits (classic: 16 bits for the entry count).
const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
const NARROW: Record<number, number> = { 16: 4, 17: 9, 18: 13 }; // LONG8 → LONG, SLONG8 → SLONG, IFD8 → IFD
const POINTERS = [330, 34665, 34853, 40965];
export function bigTiffToClassic(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (bytes.length < 16 || bytes[0] !== bytes[1] || (bytes[0] !== 0x49 && bytes[0] !== 0x4d)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), le = bytes[0] === 0x49;
  if (v.getUint16(2, le) !== 43 || v.getUint16(4, le) !== 8 || v.getUint16(6, le) !== 0) return null;
  const u32 = (at: number) => { const n = v.getBigUint64(at, le); return n > 0xffffffffn ? -1 : Number(n); }; // -1: needs more than 32 bits
  const ifd = u32(8);
  if (ifd < 0 || ifd + 8 > bytes.length) return null;
  const n = u32(ifd);
  if (n < 0 || n > 0xffff || ifd + 16 + n * 20 > bytes.length) return null;
  const entries: { tag: number; type: number; count: number; data: Uint8Array }[] = [];
  for (let i = 0; i < n; i++) {
    const p = ifd + 8 + i * 20, tag = v.getUint16(p, le), type = v.getUint16(p + 2, le), count = u32(p + 4);
    if (count < 0) return null;
    if (POINTERS.includes(tag) || !SIZE[type]) continue;
    const size = count * SIZE[type], at = size <= 8 ? p + 12 : u32(p + 12);
    if (at < 0 || at + size > bytes.length) return null;
    if (!NARROW[type]) { entries.push({ tag, type, count, data: bytes.subarray(at, at + size) }); continue; }
    const data = new Uint8Array(count * 4), d = new DataView(data.buffer);
    for (let k = 0; k < count; k++) {
      if (type === 17) { const s = v.getBigInt64(at + k * 8, le); if (s < -0x80000000n || s > 0x7fffffffn) return null; d.setInt32(k * 4, Number(s), le); }
      else { const u = u32(at + k * 8); if (u < 0) return null; d.setUint32(k * 4, u, le); }
    }
    entries.push({ tag, type: NARROW[type], count, data });
  }
  entries.sort((a, b) => a.tag - b.tag);
  const start = bytes.length + (bytes.length & 1);
  let end = start + 2 + entries.length * 12 + 4;
  const offsets = entries.map(e => { if (e.data.length <= 4) return -1; end += end & 1; const o = end; end += e.data.length; return o; });
  if (end > 0xffffffff) return null;
  const out = new Uint8Array(end), w = new DataView(out.buffer);
  out.set(bytes); w.setUint16(2, 42, le); w.setUint32(4, start, le); w.setUint16(start, entries.length, le);
  entries.forEach((e, k) => {
    const p = start + 2 + k * 12;
    w.setUint16(p, e.tag, le); w.setUint16(p + 2, e.type, le); w.setUint32(p + 4, e.count, le);
    if (offsets[k] < 0) out.set(e.data, p + 8); else { w.setUint32(p + 8, offsets[k], le); out.set(e.data, offsets[k]); }
  });
  return out;
}
