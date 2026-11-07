// SPDX-License-Identifier: AGPL-3.0-only
// T12 mask engine, run in the mask worker. Auto-foreground (background removal; part 3 §44.7, ticket "length rule"): one pass over the
// source; a shot cut starts a new segment whose first frame seeds the objects; every frame's objects union into one binary alpha plane
// at source size. Smart masks (§44.7): strokes on one frame, tracked from there to both ends of the range. Output is the raster file
// of masks/raster.ts; frames with no object are empty planes, so the layer covers the whole range.
import type { Foreground } from './foreground';
import { RasterWriter, RASTER_LIMITS, deflate, inflate } from './raster';
import { signature } from './sam2';
import type { Decoded, Features, Sam2, Tracked } from './sam2';
import { thinStrokes } from './strokes';
import type { Stroke } from './strokes';

export type { Stroke };

export type Picture = { width: number; height: number; data: Uint8ClampedArray };
export type SourceFrame = { timeUs: number; picture: Picture };
export type Progress = (done: number, total: number) => void;
/** How long an empty shot waits before looking again (a fade-in's first frames show nothing). */
const LOOK_AGAIN_US = 1_000_000;
const BINS = 16, CUT = 0.1, STEP = 8;
/** Past a cut a tracker holds on to whatever fills its place (Xapp's jump to the man's face, W3-RF-06). So a shot starts from the seed's
 *  memory alone and keeps the object only if the region found looks like the seed's: cosine of `signature`s, same person across shots
 *  ≥ .98, another person ≤ .943 on clip 2. */
const SAME = 0.96;

/** A hard cut: the colour histogram of a sparse pixel grid moves by more than CUT between two frames. */
export class CutDetector {
  constructor(public last: Float32Array | null = null) {}
  next({ data, width, height }: Picture): boolean {
    const h = new Float32Array(3 * BINS); let n = 0;
    for (let y = 0; y < height; y += STEP) for (let x = 0, i = y * width * 4; x < width; x += STEP, i += 4 * STEP, n++) { h[data[i] >> 4]++; h[BINS + (data[i + 1] >> 4)]++; h[2 * BINS + (data[i + 2] >> 4)]++; }
    for (let i = 0; i < h.length; i++) h[i] /= 3 * n;
    const before = this.last; this.last = h;
    if (!before) return true;
    let moved = 0; for (let i = 0; i < h.length; i++) moved += Math.abs(h[i] - before[i]);
    return moved / 2 > CUT;
  }
}
/** Adds one decoded mask to a plane at picture size: bilinear on the logits, kept where positive (the edge is binary, §44.7). */
export function addLogits(d: Decoded, width: number, height: number, plane: Uint8Array) {
  const { logits, size } = d, kx = size / width, ky = size / height;
  for (let y = 0, o = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * ky - 0.5), y0 = Math.min(size - 1, Math.floor(fy)), y1 = Math.min(size - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++, o++) {
      if (plane[o]) continue;
      const fx = Math.max(0, (x + 0.5) * kx - 0.5), x0 = Math.min(size - 1, Math.floor(fx)), x1 = Math.min(size - 1, x0 + 1), tx = fx - x0;
      const a = logits[y0 * size + x0], b = logits[y0 * size + x1], c = logits[y1 * size + x0], e = logits[y1 * size + x1];
      if ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty > 0) plane[o] = 255;
    }
  }
}
type Size = { width: number; height: number };
/** The raster's own size: the source's, reduced to the raster limits (part 5 §54.6 5.3). */
export function rasterSize(width: number, height: number): Size {
  const k = Math.min(1, Math.sqrt(RASTER_LIMITS.pixels / (width * height)), RASTER_LIMITS.side / Math.max(width, height));
  return { width: Math.floor(width * k), height: Math.floor(height * k) };
}
type Live = { tracked: Tracked; clock: number };
async function stepAll(sam: Sam2, f: Features, objects: Live[], total: number, { width, height }: Size, plane: Uint8Array) {
  for (const o of objects) addLogits(await sam.track(f, o.tracked, o.clock++, total), width, height, plane);
}

export type Raster = { file: Blob; frameCount: number; width: number; height: number };
/** Auto-foreground over `total` frames; `raster` is null when no segment had a subject (the job fails AUTO_FOREGROUND_EMPTY). */
export async function autoForeground(sam: Sam2, fg: Foreground, frames: AsyncIterable<SourceFrame>, total: number, input: number, progress: Progress): Promise<{ raster: Raster | null; segments: number }> {
  const cuts = new CutDetector();
  let writer: RasterWriter | null = null, objects: Live[] = [], found = false, segments = 0, done = 0, looked = -Infinity;
  for await (const { timeUs, picture } of frames) {
    const { width, height, data } = picture, size = writer ?? rasterSize(width, height), plane = new Uint8Array(size.width * size.height);
    writer ??= new RasterWriter(size.width, size.height);
    if (cuts.next(picture)) { objects = []; segments++; looked = -Infinity; }
    if (!objects.length && timeUs - looked >= LOOK_AGAIN_US) {
      looked = timeUs;
      const seeds = await fg.seeds(data, width, height, input);
      if (seeds.length) {
        const f = await sam.encode(data, width, height);
        for (const s of seeds) objects.push({ tracked: await sam.seedMask(f, s.mask, s.point), clock: 1 });
        found = true;
        await stepAll(sam, f, objects, total, size, plane); // the seed frame's own pass gives the tracker's edge, as on every later frame
      }
    } else if (objects.length) await stepAll(sam, await sam.encode(data, width, height), objects, total, size, plane);
    await writer.add(timeUs, plane);
    progress(++done, total);
  }
  return { raster: writer && found ? { file: writer.blob(), frameCount: writer.count, width: writer.width, height: writer.height } : null, segments };
}

/** Strokes on a width × height frame as model prompts in the square input's px: one point per kept stroke point, labelled include or exclude. */
export function prompts(strokes: Stroke[], size: number, width: number, height: number): { points: [number, number][]; labels: number[] } {
  const points: [number, number][] = [], labels: number[] = [];
  for (const s of thinStrokes(strokes, width, height)) for (const [x, y] of s.points) { points.push([x * size, y * size]); labels.push(s.label); }
  return { points, labels };
}
/** The preview: one binary plane at source size for strokes on one picture. */
export async function previewStrokes(sam: Sam2, picture: Picture, strokes: Stroke[], size: number): Promise<Uint8Array> {
  const f = await sam.encode(picture.data, picture.width, picture.height), { points, labels } = prompts(strokes, size, picture.width, picture.height), plane = new Uint8Array(picture.width * picture.height);
  addLogits((await sam.seed(f, points, labels)).decoded, picture.width, picture.height, plane);
  return plane;
}
/** How a track finds its object on the seed frame. */
export type Seed = (f: Features, picture: Picture) => ReturnType<Sam2['seed']>;
export const strokeSeed = (sam: Sam2, strokes: Stroke[], input: number): Seed => (f, { width, height }) => { const { points, labels } = prompts(strokes, input, width, height); return sam.seed(f, points, labels); };
/** Box corners, the prompt's labels 2 and 3, for a box in picture px. */
export const boxSeed = (sam: Sam2, box: (picture: Picture) => Promise<[number, number, number, number]>, input: number): Seed => async (f, picture) => {
  const [x1, y1, x2, y2] = await box(picture), sx = input / picture.width, sy = input / picture.height;
  return sam.seed(f, [[x1 * sx, y1 * sy], [x2 * sx, y2 * sy]], [2, 3]);
};
/** Tracks an object from its seed frame forward, then back from it, and writes the raster in source-time order. `after` yields the
 *  seed frame and everything behind it; `before` the frames ahead of the seed frame, nearest first. */
export async function trackObject(sam: Sam2, seed: Seed, after: AsyncIterable<SourceFrame>, before: AsyncIterable<SourceFrame>, total: number, progress: Progress): Promise<Raster> {
  const planes: { timeUs: number; plane: Uint8Array }[] = [];
  let size: Size | null = null, start: Tracked | null = null, look: Float64Array = new Float64Array(0), done = 0, first: Float32Array | null = null;
  const fresh = () => ({ ...start!, recent: [], pointers: start!.pointers.slice(0, 1) });
  const same = (f: Features, d: Decoded) => signature(f, d).reduce((sum, v, i) => sum + v * look[i], 0) >= SAME;
  const pass = async (frames: AsyncIterable<SourceFrame>) => {
    const cuts = new CutDetector(first);
    let live: Tracked | null = start && fresh(), clock = 1, looked = -Infinity;
    for await (const { timeUs, picture } of frames) {
      size ??= rasterSize(picture.width, picture.height);
      const plane = new Uint8Array(size.width * size.height), cut = cuts.next(picture), check = !!start && (cut || (!live && Math.abs(timeUs - looked) >= LOOK_AGAIN_US));
      if (!start) {
        const f = await sam.encode(picture.data, picture.width, picture.height), { object, decoded } = await seed(f, picture);
        start = object; live = fresh(); first = cuts.last; look = signature(f, decoded);
        addLogits(decoded, size.width, size.height, plane);
      } else if (check || live) {
        const f = await sam.encode(picture.data, picture.width, picture.height);
        if (check) { live = fresh(); clock = 1; looked = timeUs; }
        const decoded = await sam.track(f, live!, clock++, total);
        if (check && !same(f, decoded)) live = null; else addLogits(decoded, size.width, size.height, plane);
      }
      planes.push({ timeUs, plane: await deflate(plane) });
      progress(++done, total);
    }
  };
  await pass(after);
  await pass(before);
  const { width, height } = size!, writer = new RasterWriter(width, height);
  for (const { timeUs, plane } of planes.sort((a, b) => a.timeUs - b.timeUs)) await writer.add(timeUs, await inflate(plane));
  return { file: writer.blob(), frameCount: writer.count, width, height };
}
