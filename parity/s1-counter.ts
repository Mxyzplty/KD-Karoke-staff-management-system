// SPDX-License-Identifier: AGPL-3.0-only
// S1's burned-in frame counter ("0050" style digits) as a frame-identity reader, the t15-seek oracle: ffmpeg decodes the counter
// region of every S1 frame, and a picture shows the frame whose counter crop is nearest (mean absolute difference, 8-bit levels).
import { spawnSync } from 'node:child_process';

/** The counter region in S1 source px (x 240..839, y 592..799) and S1's frame count (30 fps, 10 s). */
export const COUNTER = { x: 240, y: 592, w: 600, h: 208 }, S1_FRAMES = 300;
export type Rgba = { width: number; height: number; data: ArrayLike<number> };

/** The counter region of every S1 frame, raw rgb24, one ffmpeg run. */
export function counterCrops(file: string): Uint8Array[] {
  const { x, y, w, h } = COUNTER;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', String(S1_FRAMES), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  const size = w * h * 3;
  if (r.status !== 0 || r.stdout.length !== size * S1_FRAMES) throw Error(`ffmpeg could not decode the S1 counter crops from ${file}: ${r.stderr?.toString().trim() || `${r.stdout?.length ?? 0} bytes`}`);
  const all = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length);
  return Array.from({ length: S1_FRAMES }, (_, n) => all.subarray(n * size, (n + 1) * size));
}

/** Mean absolute difference (8-bit levels) between an RGBA region and an rgb24 crop with the same pixel count. */
export function meanAbsDiff(rgba: ArrayLike<number>, rgb: ArrayLike<number>) {
  let sum = 0; const n = rgb.length / 3;
  for (let p = 0; p < n; p++) for (let k = 0; k < 3; k++) sum += Math.abs(rgba[p * 4 + k] - rgb[p * 3 + k]);
  return sum / (n * 3);
}

/** The counter region as `picture` shows it: `at(u, v)` maps S1 source px to picture px; bilinear samples at the mapped centres
 *  of the region's source pixels (clamped to the picture), RGBA, COUNTER.w × COUNTER.h. */
export function counterRegion(picture: Rgba, at: (u: number, v: number) => [number, number]): Uint8Array {
  const { x, y, w, h } = COUNTER, { width: W, height: H, data } = picture, out = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const [px, py] = at(x + i + 0.5, y + j + 0.5), fx = Math.min(Math.max(px - 0.5, 0), W - 1), fy = Math.min(Math.max(py - 0.5, 0), H - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1), ax = fx - x0, ay = fy - y0;
    for (let k = 0; k < 4; k++) {
      const v = (data[(y0 * W + x0) * 4 + k] * (1 - ax) + data[(y0 * W + x1) * 4 + k] * ax) * (1 - ay) + (data[(y1 * W + x0) * 4 + k] * (1 - ax) + data[(y1 * W + x1) * 4 + k] * ax) * ay;
      out[(j * w + i) * 4 + k] = Math.round(v);
    }
  }
  return out;
}

/** The S1 frame a counter region shows: the nearest crop, its difference and the second-nearest difference (the gap is how clear
 *  the reading is). */
export function readCounter(region: ArrayLike<number>, crops: Uint8Array[]): { frame: number; diff: number; runnerUp: number } {
  let frame = -1, diff = Infinity, runnerUp = Infinity;
  crops.forEach((c, n) => {
    const d = meanAbsDiff(region, c);
    if (d < diff) { runnerUp = diff; diff = d; frame = n; } else if (d < runnerUp) runnerUp = d;
  });
  return { frame, diff, runnerUp };
}
