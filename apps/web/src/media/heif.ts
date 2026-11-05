// SPDX-License-Identifier: AGPL-3.0-only
// HEIF / HEIC stills (ISO/IEC 23008-12), review F8: Chromium decodes no HEIC, so we read the container ourselves and decode
// the HEVC items with our LGPL libav build. Supported: one hvc1 item or a `grid` of hvc1 tiles, `ispe` size, `irot`
// rotation, `imir` mirror, `colr` nclx colour. Not supported (stated): alpha/depth auxiliary items, `clap` crops, AVIF.
export type HeifImage = {
  width: number; height: number; rotation: 0 | 90 | 180 | 270; mirror: 0 | 1 | null;
  /** Transformative properties in ipma association order (HEIF; also followed by libheif). */
  transforms: ({ type: 'rotate'; degrees: 0 | 90 | 180 | 270 } | { type: 'mirror'; axis: 0 | 1 })[];
  colour: { primaries?: string; transfer?: string; matrix?: string; fullRange: boolean } | null;
  grid: { rows: number; columns: number; outputWidth: number; outputHeight: number } | null;
  /** Each tile as one Annex-B HEVC access unit (parameter sets + slices), in raster order. */
  tiles: Uint8Array[];
};
type Box = { type: string; start: number; end: number };
const four = (d: DataView, at: number) => String.fromCharCode(d.getUint8(at), d.getUint8(at + 1), d.getUint8(at + 2), d.getUint8(at + 3));
function* boxes(d: DataView, start: number, end: number): Generator<Box> {
  for (let at = start; at + 8 <= end;) {
    let size = d.getUint32(at), header = 8; const type = four(d, at + 4);
    if (size === 1) { size = Number(d.getBigUint64(at + 8)); header = 16; } else if (size === 0) size = end - at;
    if (size < header || at + size > end) return;
    yield { type, start: at + header, end: at + size }; at += size;
  }
}
const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'];
export function isHeif(bytes: Uint8Array): boolean {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || four(d, 4) !== 'ftyp') return false;
  const size = d.getUint32(0), brands = [four(d, 8)];
  for (let at = 16; at + 4 <= Math.min(size, bytes.length); at += 4) brands.push(four(d, at));
  return brands.some(b => HEIF_BRANDS.includes(b)) && !brands.includes('avif');
}
const PRIMARIES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
const TRANSFER: Record<number, string> = { 1: 'bt709', 6: 'smpte170m', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' };
const MATRIX: Record<number, string> = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };
/** Parse the container; null when this is not a HEIF file whose primary item is hvc1 or a grid of hvc1. */
export function parseHeif(bytes: Uint8Array): HeifImage | null {
  if (!isHeif(bytes)) return null;
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta = [...boxes(d, 0, bytes.length)].find(b => b.type === 'meta');
  if (!meta) return null;
  let primary = 0, idat: Box | undefined;
  const items = new Map<number, { type: string; extents: { offset: number; length: number }[]; method: number }>();
  const refs = new Map<number, number[]>(), props: Box[] = [], assoc = new Map<number, number[]>();
  for (const b of boxes(d, meta.start + 4, meta.end)) {
    const version = d.getUint8(b.start), body = b.start + 4;
    if (b.type === 'pitm') primary = version === 0 ? d.getUint16(body) : d.getUint32(body);
    else if (b.type === 'idat') idat = b;
    else if (b.type === 'iinf') {
      for (const infe of boxes(d, body + (version === 0 ? 2 : 4), b.end)) {
        if (infe.type !== 'infe') continue;
        const v = d.getUint8(infe.start), p = infe.start + 4;
        if (v < 2) continue;
        const id = v === 2 ? d.getUint16(p) : d.getUint32(p), typeAt = p + (v === 2 ? 4 : 6);
        items.set(id, { ...(items.get(id) ?? { extents: [], method: 0 }), type: four(d, typeAt) });
      }
    } else if (b.type === 'iloc') {
      const s1 = d.getUint8(body), s2 = d.getUint8(body + 1), offsetSize = s1 >> 4, lengthSize = s1 & 15, baseSize = s2 >> 4, indexSize = version >= 1 ? s2 & 15 : 0;
      const read = (at: number, n: number) => n === 0 ? 0 : n === 4 ? d.getUint32(at) : n === 8 ? Number(d.getBigUint64(at)) : n === 2 ? d.getUint16(at) : d.getUint8(at);
      let at = body + 2; const count = version < 2 ? d.getUint16(at) : d.getUint32(at); at += version < 2 ? 2 : 4;
      for (let i = 0; i < count; i++) {
        const id = version < 2 ? d.getUint16(at) : d.getUint32(at); at += version < 2 ? 2 : 4;
        const method = version >= 1 ? d.getUint16(at) & 15 : 0; if (version >= 1) at += 2;
        at += 2; const base = read(at, baseSize); at += baseSize;
        const extentCount = d.getUint16(at); at += 2; const extents: { offset: number; length: number }[] = [];
        for (let e = 0; e < extentCount; e++) { at += indexSize; const offset = read(at, offsetSize); at += offsetSize; const length = read(at, lengthSize); at += lengthSize; extents.push({ offset: base + offset, length }); }
        items.set(id, { type: items.get(id)?.type ?? '', extents, method });
      }
    } else if (b.type === 'iref') {
      for (const r of boxes(d, body, b.end)) {
        if (r.type !== 'dimg') continue;
        const wide = version === 1, from = wide ? d.getUint32(r.start) : d.getUint16(r.start), n = d.getUint16(r.start + (wide ? 4 : 2)), list: number[] = [];
        for (let i = 0; i < n; i++) list.push(wide ? d.getUint32(r.start + 6 + 4 * i) : d.getUint16(r.start + 4 + 2 * i));
        refs.set(from, list);
      }
    } else if (b.type === 'iprp') {
      for (const c of boxes(d, b.start, b.end)) {
        if (c.type === 'ipco') props.push(...boxes(d, c.start, c.end));
        if (c.type !== 'ipma') continue;
        const v = d.getUint8(c.start), flags = d.getUint8(c.start + 3); let at = c.start + 4;
        const n = d.getUint32(at); at += 4;
        for (let i = 0; i < n; i++) {
          const id = v < 1 ? d.getUint16(at) : d.getUint32(at); at += v < 1 ? 2 : 4;
          const count = d.getUint8(at++), list: number[] = [];
          for (let k = 0; k < count; k++) { const index = flags & 1 ? d.getUint16(at) & 0x7fff : d.getUint8(at) & 0x7f; at += flags & 1 ? 2 : 1; list.push(index); }
          assoc.set(id, list);
        }
      }
    }
  }
  const data = (id: number) => {
    const item = items.get(id); if (!item) return null;
    const base = item.method === 1 && idat ? idat.start : 0, parts = item.extents.map(e => bytes.subarray(base + e.offset, base + e.offset + e.length));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const propsOf = (id: number) => (assoc.get(id) ?? []).map(i => props[i - 1]).filter(Boolean);
  const prop = (id: number, type: string) => propsOf(id).find(p => p.type === type);
  /** hvcC parameter sets + an item's length-prefixed NAL units → one Annex-B access unit. */
  const accessUnit = (id: number) => {
    const config = prop(id, 'hvcC'), payload = data(id);
    if (!config || !payload) return null;
    const lengthSize = (d.getUint8(config.start + 21) & 3) + 1, chunks: Uint8Array[] = [], start = new Uint8Array([0, 0, 0, 1]);
    let at = config.start + 23; const arrays = d.getUint8(config.start + 22);
    for (let a = 0; a < arrays; a++) {
      const n = d.getUint16(at + 1); at += 3;
      for (let k = 0; k < n; k++) { const len = d.getUint16(at); at += 2; chunks.push(start, bytes.subarray(at, at + len)); at += len; }
    }
    const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let p = 0; p + lengthSize <= payload.length;) {
      const len = lengthSize === 4 ? pv.getUint32(p) : lengthSize === 2 ? pv.getUint16(p) : pv.getUint8(p); p += lengthSize;
      chunks.push(start, payload.subarray(p, p + len)); p += len;
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  };
  const kind = items.get(primary)?.type;
  let tiles: Uint8Array[], grid: HeifImage['grid'] = null;
  if (kind === 'hvc1') { const au = accessUnit(primary); if (!au) return null; tiles = [au]; }
  else if (kind === 'grid') {
    const g = data(primary); if (!g) return null;
    const gv = new DataView(g.buffer, g.byteOffset, g.byteLength), large = gv.getUint8(1) & 1;
    grid = { rows: gv.getUint8(2) + 1, columns: gv.getUint8(3) + 1, outputWidth: large ? gv.getUint32(4) : gv.getUint16(4), outputHeight: large ? gv.getUint32(8) : gv.getUint16(6) };
    const units = (refs.get(primary) ?? []).map(accessUnit);
    if (units.length !== grid.rows * grid.columns || units.some(u => !u)) return null;
    tiles = units as Uint8Array[];
  } else return null;
  const size = prop(primary, 'ispe'), rot = prop(primary, 'irot'), mir = prop(primary, 'imir'), colr = prop(primary, 'colr');
  const width = size ? d.getUint32(size.start + 4) : grid?.outputWidth ?? 0, height = size ? d.getUint32(size.start + 8) : grid?.outputHeight ?? 0;
  let colour: HeifImage['colour'] = null;
  if (colr && four(d, colr.start) === 'nclx') colour = { primaries: PRIMARIES[d.getUint16(colr.start + 4)], transfer: TRANSFER[d.getUint16(colr.start + 6)], matrix: MATRIX[d.getUint16(colr.start + 8)], fullRange: (d.getUint8(colr.start + 10) & 0x80) !== 0 };
  // irot is anticlockwise in quarter turns; our records are clockwise.
  const rotation = (rot ? [0, 270, 180, 90][d.getUint8(rot.start) & 3] : 0) as HeifImage['rotation'];
  const mirror = mir ? (d.getUint8(mir.start) & 1) as 0 | 1 : null;
  const transforms: HeifImage['transforms'] = [];
  for (const p of propsOf(primary)) {
    if (p.type === 'irot') transforms.push({ type: 'rotate', degrees: rotation });
    if (p.type === 'imir') transforms.push({ type: 'mirror', axis: mirror! });
  }
  return { width, height, rotation, mirror, transforms, colour, grid, tiles };
}
