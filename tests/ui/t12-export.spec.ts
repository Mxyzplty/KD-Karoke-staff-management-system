// SPDX-License-Identifier: AGPL-3.0-only
// T12 export checks through T16a's pipeline (lane rule l.320). Generated media and generated rasters, no models and no fixture store, so CI runs them:
// SM-P06 Add = pixel union on two raster layers in source time, a vector mask with Invert, Subtract and Feather, and a raster file that is gone.
import { test, expect, type Page } from '@playwright/test';
import { skipTour } from './t02-support';
import { completed, decodeRgba, genMedia, mkDoc, runExport, setup } from './t16a-support';

const W = 320, H = 180, ON = 231, OFF = 24, MARGIN = 3;
type Rect = [number, number, number, number];
test.beforeEach(({ page }) => skipTour(page));

const white = () => genMedia('t12-white.mp4', ['-f', 'lavfi', '-i', `color=c=white:size=${W}x${H}:rate=30:duration=1`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p']);
const open = (page: Page) => setup(page, mkDoc([{ id: 'c', from: 0, to: 1000 }]), { c: white() }, 'T12 export');
const layer = (extra: Record<string, unknown>): Record<string, any> => ({ id: `m${extra.order}`, name: `Mask ${extra.order}`, enabled: true, points: [], closed: true, mode: 'add', colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape', ...extra });
const box = ([x0, y0, x1, y1]: Rect) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ anchor: { x, y } }));
const vector = (order: number, rect: Rect, extra: Record<string, unknown> = {}) => layer({ order, points: box(rect), ...extra });
/** One Smart layer over 0–1 s of source: `frames` is [time in µs, kept rectangle] per raster frame. */
async function smart(page: Page, id: string, order: number, frames: [number, Rect][]) {
  const file = `t12-${order}.dmk`;
  await page.evaluate(async ({ id, file, frames, W, H }) => {
    const r = '/src/masks/raster.ts', s = '/src/store/database.ts', { RasterWriter } = await import(r), { projectStore } = await import(s), w = new RasterWriter(W, H);
    for (const [timeUs, [x0, y0, x1, y1]] of frames) {
      const plane = new Uint8Array(W * H);
      for (let y = y0; y < y1; y++) plane.fill(255, y * W + x0, y * W + x1);
      await w.add(timeUs, plane);
    }
    await projectStore.media.writeMask(id, file, w.blob());
  }, { id, file, frames, W, H });
  return layer({ order, source: 'smart', raster: { file, sourceStartUs: 0, sourceEndUs: 1_000_000, frameCount: frames.length, width: W, height: H, space: { kind: 'source', width: W, height: H }, version: 1 } });
}
const setMasks = (page: Page, id: string, masks: unknown[]) => page.evaluate(async ({ id, masks }) => {
  const p = '/src/store/database.ts', { projectStore } = await import(p), { document } = await projectStore.read(id) as any;
  document.items[0].masks = masks;
  await projectStore.save(id, document, document.rev);
}, { id, masks });
const exported = async (page: Page, id: string) => { const r = await runExport(page, id); completed(r); expect(r.result!.frames).toBe(30); return decodeRgba(r.file!, W, H); };
const inside = ([x0, y0, x1, y1]: Rect, x: number, y: number, by = 0) => x >= x0 - by && x < x1 + by && y >= y0 - by && y < y1 + by;
/** Pixels off the wanted picture: white in the rectangles `kept` (less `cut`), black elsewhere; rows within MARGIN of an edge are left to the codec. */
function wrong(frame: Buffer, kept: Rect[], cut: Rect[] = []) {
  const edge = (r: Rect, x: number, y: number) => inside(r, x, y, MARGIN) && !inside([r[0] + MARGIN, r[1] + MARGIN, r[2] - MARGIN, r[3] - MARGIN], x, y);
  let bad = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if ([...kept, ...cut].some(r => edge(r, x, y))) continue;
    const v = frame[(y * W + x) * 4], on = kept.some(r => inside(r, x, y)) && !cut.some(r => inside(r, x, y));
    if (on ? v < ON : v > OFF) bad++;
  }
  return bad;
}

test('SM-P06 two Add layers are the pixel union, each read in source time', async ({ page }) => {
  test.setTimeout(180_000);
  const { id } = await open(page);
  const left: Rect = [0, 0, 160, H], right: Rect = [160, 0, W, H], top: Rect = [0, 0, W, 90];
  await setMasks(page, id, [await smart(page, id, 0, [[0, left], [500_000, right]]), await smart(page, id, 1, [[0, top]])]);
  const frames = await exported(page, id);
  // Bottom right black up to the raster's frame at 0.5 s, bottom left black from it on: the frame with the last time ≤ source time.
  for (const n of [0, 5, 14]) expect(wrong(frames[n], [left, top]), `frame ${n}`).toBe(0);
  for (const n of [15, 20, 29]) expect(wrong(frames[n], [right, top]), `frame ${n}`).toBe(0);
});

test('a vector mask in the export: Add, Invert, Subtract, Feather', async ({ page }) => {
  test.setTimeout(180_000);
  const { id } = await open(page);
  const rect: Rect = [40, 30, 280, 150], hole: Rect = [120, 60, 200, 120], full: Rect = [0, 0, W, H];
  await setMasks(page, id, [vector(0, rect)]);
  expect(wrong((await exported(page, id))[15], [rect])).toBe(0);
  await setMasks(page, id, [vector(0, rect, { inverted: true })]);
  expect(wrong((await exported(page, id))[15], [full], [rect])).toBe(0);
  await setMasks(page, id, [vector(0, rect), vector(1, hole, { mode: 'subtract' })]);
  expect(wrong((await exported(page, id))[15], [rect], [hole])).toBe(0);
  await setMasks(page, id, [vector(0, rect, { feather: 6 })]);
  const f = (await exported(page, id))[15], at = (x: number) => f[(90 * W + x) * 4];
  expect(at(40 - 18)).toBeLessThanOrEqual(OFF);
  expect(Math.abs(at(40) - 128)).toBeLessThanOrEqual(24);
  expect(at(40 + 18)).toBeGreaterThanOrEqual(ON);
});

test('a raster file that is gone fails the export rather than drawing another frame', async ({ page }) => {
  test.setTimeout(120_000);
  const { id } = await open(page);
  const gone = await smart(page, id, 0, [[0, [0, 0, W, H]]]);
  await setMasks(page, id, [{ ...gone, raster: { ...gone.raster, file: 'gone.dmk' } }]);
  const r = await runExport(page, id);
  expect(r.status).toBe('failed');
  expect(r.error?.code).toBe('WORKSPACE_FILE_MISSING');
});
