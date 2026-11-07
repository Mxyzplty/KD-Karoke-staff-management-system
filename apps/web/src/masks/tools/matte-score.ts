// SPDX-License-Identifier: AGPL-3.0-only
// T12 oracle scores of a binary matte against truth (BG-P01, BG-P03, SM-P02, SM-P03). A plane is one byte per pixel, row-major, non-zero = kept.
export const binary = (alpha: Uint8Array, at = 128) => alpha.map(v => v >= at ? 1 : 0);
export function iou(a: Uint8Array, b: Uint8Array) {
  let both = 0, either = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) both++; if (a[i] || b[i]) either++; }
  return either ? both / either : 1;
}
/** Pixels of the mask with a 4-neighbour outside it; the picture's own border is no boundary. */
function boundary(m: Uint8Array, W: number, H: number) {
  const out: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (m[i] && ((x > 0 && !m[i - 1]) || (x + 1 < W && !m[i + 1]) || (y > 0 && !m[i - W]) || (y + 1 < H && !m[i + W]))) out.push(i);
  }
  return out;
}
/** Share of the `from` pixels within `band` px (Euclidean) of a pixel of `to`. An empty `from` scores 1 when `to` is empty too, else 0. */
function within(from: number[], to: number[], W: number, H: number, band: number) {
  if (!from.length) return to.length ? 0 : 1;
  const near = new Uint8Array(W * H), r = Math.ceil(band);
  for (const i of to) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = i % W + dx, y = Math.floor(i / W) + dy;
    if (dx * dx + dy * dy <= band * band && x >= 0 && x < W && y >= 0 && y < H) near[y * W + x] = 1;
  }
  return from.reduce((n, i) => n + near[i], 0) / from.length;
}
export function boundaryF(a: Uint8Array, b: Uint8Array, W: number, H: number, band = 2) {
  const ea = boundary(a, W, H), eb = boundary(b, W, H), p = within(ea, eb, W, H, band), r = within(eb, ea, W, H, band);
  return p + r ? 2 * p * r / (p + r) : 0;
}
/** Mean share of the picture that changes between consecutive frames. */
export function flicker(planes: Uint8Array[]) {
  if (planes.length < 2) return 0;
  let changed = 0;
  for (let k = 1; k < planes.length; k++) for (let i = 0; i < planes[k].length; i++) if (!planes[k][i] !== !planes[k - 1][i]) changed++;
  return changed / (planes.length - 1) / planes[0].length;
}
export function scoreFrames(masks: Uint8Array[], truth: Uint8Array[], W: number, H: number) {
  const rows = masks.map((m, k) => ({ iou: iou(m, truth[k]), f: boundaryF(m, truth[k], W, H) })), mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const flickerMask = flicker(masks), flickerTruth = flicker(truth), ious = rows.map(r => r.iou);
  return { frames: rows.length, meanIou: mean(ious), minIou: Math.min(...ious), boundaryF: mean(rows.map(r => r.f)), flickerMask, flickerTruth, flickerRatio: flickerTruth ? flickerMask / flickerTruth : flickerMask ? Infinity : 1, rows };
}
