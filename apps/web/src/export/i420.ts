// SPDX-License-Identifier: AGPL-3.0-only
// Canvas read-back → I420, BT.709 limited range (findings §7 encode step, Xapp's path: getImageData → CPU I420 BT.709 →
// VideoFrame). The frame carries explicit BT.709 tags, so the encoder and the MP4 colour box say the same thing.
// Y′ = 0.2126 R′ + 0.7152 G′ + 0.0722 B′; Cb = (B′ − Y′) / 1.8556; Cr = (R′ − Y′) / 1.5748; Y = 16 + 219 Y′,
// C = 128 + 224 C (8-bit, R′G′B′ in 0…1); chroma from the 2 × 2 block mean. Sizes are even (outputSize).
export const BT709: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
const KR = 0.2126, KG = 0.7152, KB = 0.0722;

/** Writes the I420 planes of `rgba` (w × h, both even) into `out` (w × h × 1.5 bytes). Every value is ≥ 16 before
 *  rounding, so (v + 0.5) | 0 is Math.round. */
export function rgbaToI420(rgba: Uint8ClampedArray, w: number, h: number, out: Uint8Array) {
  const cw = w >> 1, uOff = w * h, vOff = uOff + cw * (h >> 1), ys = 219 / 255, cs = 224 / 255;
  const yr = ys * KR, yg = ys * KG, yb = ys * KB, cb = cs / 1.8556 / 4, cr = cs / 1.5748 / 4;
  for (let y = 0; y < h; y += 2) {
    const row0 = y * w, row1 = row0 + w, c0 = (y >> 1) * cw;
    for (let x = 0; x < w; x += 2) {
      const i0 = row0 + x, i1 = row1 + x, p0 = i0 * 4, p1 = i1 * 4;
      const R0 = rgba[p0], G0 = rgba[p0 + 1], B0 = rgba[p0 + 2], R1 = rgba[p0 + 4], G1 = rgba[p0 + 5], B1 = rgba[p0 + 6];
      const R2 = rgba[p1], G2 = rgba[p1 + 1], B2 = rgba[p1 + 2], R3 = rgba[p1 + 4], G3 = rgba[p1 + 5], B3 = rgba[p1 + 6];
      out[i0] = (16.5 + yr * R0 + yg * G0 + yb * B0) | 0; out[i0 + 1] = (16.5 + yr * R1 + yg * G1 + yb * B1) | 0;
      out[i1] = (16.5 + yr * R2 + yg * G2 + yb * B2) | 0; out[i1 + 1] = (16.5 + yr * R3 + yg * G3 + yb * B3) | 0;
      // Chroma of the 2 × 2 block mean: sums here, the / 4 is in cb and cr.
      const r = R0 + R1 + R2 + R3, g = G0 + G1 + G2 + G3, b = B0 + B1 + B2 + B3, Y = KR * r + KG * g + KB * b, c = c0 + (x >> 1);
      out[uOff + c] = (128.5 + cb * (b - Y)) | 0;
      out[vOff + c] = (128.5 + cr * (r - Y)) | 0;
    }
  }
  return out;
}
