// SPDX-License-Identifier: AGPL-3.0-only
// LUT data (part 4 §49.4): the stored table is a fixed 33³ RGBA8 grid, red fastest, then green, then blue.

export const LUT_GRID = 33;
export const LUT_BYTES = LUT_GRID ** 3 * 4; // 143,748 bytes = 191,664 base64 characters

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Parse a `.cube` file (1D or 3D) and resample it to the 33³ RGBA8 grid. Throws with the importer's reason. */
export function importCube(text: string): Uint8Array {
  let size = 0, dimension = 0, min = [0, 0, 0], max = [1, 1, 1];
  const entries: number[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    const [key, ...values] = line.split(/\s+/);
    if (key === 'LUT_3D_SIZE' || key === 'LUT_1D_SIZE') {
      if (size) throw new Error('Duplicate LUT size');
      dimension = key === 'LUT_3D_SIZE' ? 3 : 1;
      size = Number(values[0]);
      if (!Number.isInteger(size) || size < 2 || size > (dimension === 3 ? 129 : 65536)) throw new Error('Invalid LUT size');
    } else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      const v = values.map(Number);
      if (v.length !== 3 || !v.every(Number.isFinite)) throw new Error('Invalid LUT domain');
      if (key === 'DOMAIN_MIN') min = v; else max = v;
    } else if (/^[+\-.\d]/.test(key)) {
      if (!size) throw new Error('LUT data precedes size');
      const v = [key, ...values].map(Number);
      if (v.length < 3 || !v.every(Number.isFinite)) throw new Error('Invalid LUT entry');
      entries.push([0, 1, 2].map(i => Math.round(255 * clamp01(max[i] === min[i] ? 0 : (v[i] - min[i]) / (max[i] - min[i])))));
    }
  }
  if (!size || entries.length !== size ** dimension) throw new Error('LUT entry count mismatch');
  const out = new Uint8Array(LUT_BYTES);
  const lo = [0, 0, 0], hi = [0, 0, 0], f = [0, 0, 0];
  for (let b = 0; b < LUT_GRID; b++) for (let g = 0; g < LUT_GRID; g++) for (let r = 0; r < LUT_GRID; r++) {
    [r, g, b].forEach((v, i) => { const pos = v * (size - 1) / 32; lo[i] = Math.floor(pos); hi[i] = Math.min(lo[i] + 1, size - 1); f[i] = pos - lo[i]; });
    const at = (x: number, y: number, z: number, ch: number) => entries[(z * size + y) * size + x][ch];
    const o = ((b * LUT_GRID + g) * LUT_GRID + r) * 4;
    for (let ch = 0; ch < 3; ch++) {
      if (dimension === 1) { out[o + ch] = Math.round(mix(entries[lo[ch]][ch], entries[hi[ch]][ch], f[ch])); continue; }
      const alongR = (y: number, z: number) => mix(at(lo[0], y, z, ch), at(hi[0], y, z, ch), f[0]);
      const alongG = (z: number) => mix(alongR(lo[1], z), alongR(hi[1], z), f[1]);
      out[o + ch] = Math.round(mix(alongG(lo[2]), alongG(hi[2]), f[2]));
    }
    out[o + 3] = 255;
  }
  return out;
}

/** The `.cube` TITLE line (unquoted), if any — the natural `lutName`. */
export function cubeTitle(text: string): string | undefined {
  const m = text.match(/^\s*TITLE\s+"?([^"\r\n]*)"?\s*$/m);
  return m ? m[1] : undefined;
}

export const looksLikeCube = (text: string) => /^\s*LUT_(3D|1D)_SIZE\b/m.test(text);

export function encodeLut(table: Uint8Array): string {
  let s = '';
  for (let i = 0; i < table.length; i += 0x8000) s += String.fromCharCode(...table.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Decode a stored base64 table; undefined when it is not valid base64 of exactly 33³ RGBA8. */
export function decodeLut(data: string): Uint8Array | undefined {
  try {
    const s = atob(data);
    if (s.length !== LUT_BYTES) return undefined;
    const t = new Uint8Array(LUT_BYTES);
    for (let i = 0; i < LUT_BYTES; i++) t[i] = s.charCodeAt(i);
    return t;
  } catch { return undefined; }
}

let identity: Uint8Array | undefined;
/** Near-identity table (r·255/32 rounded) used when `lutData` is missing or unreadable. */
export function identityLut(): Uint8Array {
  if (!identity) {
    identity = new Uint8Array(LUT_BYTES);
    for (let b = 0; b < LUT_GRID; b++) for (let g = 0; g < LUT_GRID; g++) for (let r = 0; r < LUT_GRID; r++)
      identity.set([Math.round(r * 255 / 32), Math.round(g * 255 / 32), Math.round(b * 255 / 32), 255], ((b * LUT_GRID + g) * LUT_GRID + r) * 4);
  }
  return identity;
}

/** Render-time table for a stored `lutData` value. */
export const lutTableFor = (data: unknown) => (typeof data === 'string' && data && decodeLut(data)) || identityLut();
