// SPDX-License-Identifier: AGPL-3.0-only
// T12: the combined mask of one item at one frame (findings part 5 §54.2–§54.7, §54.12). Each mask's coverage is a W × H 8-bit
// plane: a vector mask is filled and stroked on a canvas, then blurred; a raster is resampled, offset and blurred. The planes
// combine in model.ts, and the result multiplies the item canvas's alpha after the GPU effects (compositor.ts). Rendering stays
// synchronous, so a raster frame comes from rasterPlane's cache: export and capture wait for it (readyMasks) before they
// composite; the preview holds the mask's last decoded frame meanwhile.
import { segments } from '../timeline/shapes';
import type { ShapePath } from '../timeline/shapes';
import { combineInto, layerValue, offsetPlane, resample } from './model';
import type { FrameMask } from './model';
import { rasterPlane, readyRaster } from './raster';

type Ctx = OffscreenCanvasRenderingContext2D;
const surface = (W: number, H: number) => new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
let draw: Ctx | null = null, blur: Ctx | null = null;
function sized(ctx: Ctx | null, W: number, H: number): Ctx {
  if (!ctx || ctx.canvas.width !== W || ctx.canvas.height !== H) return surface(W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.clearRect(0, 0, W, H);
  return ctx;
}
const alphaOf = (rgba: Uint8ClampedArray, out: Uint8ClampedArray) => { for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3]; return out; };
/** §54.2 1.2: 0 points empty; 1 point a circle of radius 3; else Bézier or line segments, coordinates rounded to 0.01 px. */
function trace(ctx: Ctx, path: ShapePath) {
  const { points } = path, r = (v: number) => Math.round(v * 100) / 100;
  ctx.beginPath();
  if (!points.length) return;
  if (points.length === 1) { ctx.arc(r(points[0].anchor.x), r(points[0].anchor.y), 3, 0, 2 * Math.PI); return; }
  ctx.moveTo(r(points[0].anchor.x), r(points[0].anchor.y));
  for (const g of segments(path)) if (g.c1 && g.c2) ctx.bezierCurveTo(r(g.c1.x), r(g.c1.y), r(g.c2.x), r(g.c2.y), r(g.to.x), r(g.to.y)); else ctx.lineTo(r(g.to.x), r(g.to.y));
  if (path.closed && points.length >= 3) ctx.closePath();
}
/** §54.3 2.1, §54.4 3.1: fill (non-zero), the stroke of width 2|e| added or erased, then the canvas blur at σ = feather. */
function vectorCoverage(path: ShapePath, m: FrameMask, W: number, H: number, out: Uint8ClampedArray) {
  const ctx = draw = sized(draw, W, H);
  ctx.fillStyle = ctx.strokeStyle = '#000';
  trace(ctx, path);
  ctx.fill('nonzero');
  if (m.expansion !== 0) {
    ctx.lineWidth = 2 * Math.abs(m.expansion); ctx.lineJoin = ctx.lineCap = 'round';
    ctx.globalCompositeOperation = m.expansion > 0 ? 'source-over' : 'destination-out';
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  return alphaOf(feathered(ctx, m.feather, W, H).getImageData(0, 0, W, H).data, out);
}
function feathered(ctx: Ctx, feather: number, W: number, H: number): Ctx {
  if (!(feather > 0)) return ctx;
  const b = blur = sized(blur, W, H);
  b.filter = `blur(${feather}px)`; b.drawImage(ctx.canvas, 0, 0); b.filter = 'none';
  return b;
}
/** A raster's coverage: the same expansion and feather on the resampled plane (§54.6 5.3, §54.12). */
function rasterCoverage(plane: Uint8Array, m: FrameMask, W: number, H: number, out: Uint8ClampedArray<ArrayBuffer>) {
  let g: Uint8ClampedArray = resample(plane, m.raster!.ref, W, H, out);
  if (m.expansion !== 0) g = offsetPlane(g, W, H, m.expansion, m.raster!.ref.edgeSampling === 'clamp');
  if (!(m.feather > 0)) { if (g !== out) out.set(g); return out; }
  const ctx = draw = sized(draw, W, H), rgba = new ImageData(W, H);
  for (let i = 0; i < g.length; i++) rgba.data[i * 4 + 3] = g[i];
  ctx.putImageData(rgba, 0, 0);
  return alphaOf(feathered(ctx, m.feather, W, H).getImageData(0, 0, W, H).data, out);
}
/** The combined 8-bit alpha (§54.6 5.1: first = first after filtering). A raster with no decoded frame yet covers nothing, so
 *  the footage a removal took out never flashes. */
export function combinedPlane(masks: FrameMask[], planes: (Uint8Array | null)[], W: number, H: number): Uint8ClampedArray {
  let acc: Uint8ClampedArray | null = null;
  const g = new Uint8ClampedArray(W * H), b = new Uint8ClampedArray(W * H);
  masks.forEach((m, k) => {
    const raster = planes[k];
    if (raster) rasterCoverage(raster, m, W, H, g); else if (m.path) vectorCoverage(m.path, m, W, H, g); else g.fill(0);
    layerValue(g, m, b);
    if (acc) combineInto(acc, b, m.mode); else acc = b.slice();
  });
  return acc ?? new Uint8ClampedArray(W * H).fill(255);
}
// One finished mask per item, reused while its frame state is unchanged: a static mask costs one plane, not one per frame.
const CACHE_ITEMS = 16;
const cache = new Map<string, { key: string; canvas: OffscreenCanvas }>();
const planeIds = new WeakMap<Uint8Array, number>();
let nextPlane = 1;
const planeId = (p: Uint8Array | null) => { if (!p) return 0; let id = planeIds.get(p); if (!id) planeIds.set(p, id = nextPlane++); return id; };
/** The item's mask as a canvas for destination-in, W × H. */
export function maskCanvas(itemId: string, masks: FrameMask[], W: number, H: number): OffscreenCanvas {
  const planes = masks.map(m => m.raster ? m.raster.plane ?? rasterPlane(m.raster.ref, m.raster.timeUs) : null);
  const key = JSON.stringify([W, H, masks.map((m, k) => [m.mode, m.inverted, m.opacity, m.feather, m.expansion, m.path, m.raster && m.raster.ref.file, planeId(planes[k])])]), hit = cache.get(itemId);
  if (hit?.key === key) return hit.canvas;
  const plane = combinedPlane(masks, planes, W, H);
  const canvas = hit && hit.canvas.width === W && hit.canvas.height === H ? hit.canvas : new OffscreenCanvas(W, H), rgba = new ImageData(W, H);
  for (let i = 0; i < plane.length; i++) rgba.data[i * 4 + 3] = plane[i];
  canvas.getContext('2d')!.putImageData(rgba, 0, 0);
  cache.delete(itemId); cache.set(itemId, { key, canvas });
  if (cache.size > CACHE_ITEMS) cache.delete(cache.keys().next().value!);
  return canvas;
}
/** Every raster frame the draws show, held by the draw: export and capture await this before they composite, so a cache that has
 *  to let go of a frame cannot blank one. */
export async function readyMasks(draws: { masks?: FrameMask[] }[]): Promise<void> {
  await Promise.all(draws.flatMap(d => d.masks ?? []).flatMap(({ raster: r }) => r ? [readyRaster(r.ref, r.timeUs).then(plane => { r.plane = plane; })] : []));
}
