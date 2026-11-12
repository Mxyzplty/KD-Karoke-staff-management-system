// SPDX-License-Identifier: AGPL-3.0-only
// Canvas 2D compositor (findings part 5 §53.4): draws a frame plan (render/model.ts) into a 2D context. Shared by the preview
// canvas and frame capture; T16a's export draws through the same function.
import { cellMediaRect, cover, effectiveRadius, EMPTY_CELL, MISSING_MEDIA } from './model';
import type { Draw, LayoutDraw, Pending } from './model';
import { EFFECT_FAILURES, runEffects, type EffectFailure } from './effects';
import { maskCanvas } from '../masks/render';
import { segments } from '../timeline/shapes';
import type { ShapeDraw } from './model';
import { drawText } from '../text/draw';
import { drawCaption } from '../captions/draw';
import { combine, surfaces } from './transitions';

/** One draw's picture. width × height is the fit size (a video's display size, the merged half for stacked alpha): the
 *  image is scaled into the fitted rect whatever its pixel size, so a proxy and its original give the same geometry.
 *  null = not ready (the preview draws nothing for that item); 'failed' = a decode / fetch error (grey #374151);
 *  {itemId, error} = a motion graphic that could not be rendered (T08): nothing is drawn and the caller reports `error`.
 *  {cells} = a layout's cell pictures, by LayoutDraw cell (T07; null for an empty cell). */
export type Source = { image: CanvasImageSource; width: number; height: number } | 'failed' | { itemId: string; error: string } | { cells: Source[] } | null;
/** A source with a picture to draw. */
export const isPicture = (s: Source): s is Extract<Source, { image: CanvasImageSource }> => s !== null && s !== 'failed' && 'image' in s;
/** Whether a draw has all it shows: its picture, a shape (no source), or a layout whose filled cells all have theirs. */
export const complete = (s: Source, d: Draw): boolean => d.kind === 'shape' || d.kind === 'caption' || isPicture(s)
  || (!!d.layout && !!s && typeof s === 'object' && 'cells' in s && d.layout.cells.every((c, k) => !c.media || isPicture(s.cells[k] ?? null)));
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let itemCanvas: OffscreenCanvas | null = null;
/** The effect path's shared item canvas (§53.4.1): W × H project px, fractional sizes truncated. */
function itemContext(W: number, H: number) {
  itemCanvas ??= new OffscreenCanvas(1, 1);
  itemCanvas.width = Math.max(1, Math.trunc(W)); itemCanvas.height = Math.max(1, Math.trunc(H));
  return itemCanvas.getContext('2d')!;
}
/** A shape's path in box px (findings part 5 §54.2: cubic where a handle is set, else a line; one point = a circle of
 *  radius 3), filled non-zero (an open path fills too), then stroked centred on the path. */
function shapeContent(ctx: Ctx, s: ShapeDraw) {
  const { points } = s.path;
  if (!points.length) return;
  ctx.beginPath();
  if (points.length === 1) ctx.arc(points[0].anchor.x, points[0].anchor.y, 3, 0, 2 * Math.PI);
  else {
    ctx.moveTo(points[0].anchor.x, points[0].anchor.y);
    for (const g of segments(s.path)) if (g.c1 && g.c2) ctx.bezierCurveTo(g.c1.x, g.c1.y, g.c2.x, g.c2.y, g.to.x, g.to.y); else ctx.lineTo(g.to.x, g.to.y);
    if (s.path.closed && points.length >= 3) ctx.closePath();
  }
  const alpha = ctx.globalAlpha;
  if (s.fill) { ctx.globalAlpha = alpha * s.fill.alpha; ctx.fillStyle = s.fill.color; ctx.fill('nonzero'); }
  if (s.stroke) { ctx.globalAlpha = alpha * s.stroke.alpha; ctx.strokeStyle = s.stroke.color; ctx.lineWidth = s.stroke.width; ctx.stroke(); }
  ctx.globalAlpha = alpha;
}
/** §53.3.3 a layout's cells, each clipped to its (rounded) rectangle at the cell's alpha: an empty cell white at 6 %, a
 *  failed one grey, a picture fitted into the cell; a picture not ready yet draws nothing. */
function layoutContent(ctx: Ctx, l: LayoutDraw, src: Source) {
  const pictures = src !== null && typeof src === 'object' && 'cells' in src ? src.cells : [], alpha = ctx.globalAlpha;
  l.cells.forEach((c, k) => {
    const { x, y, w, h } = c.rect, r = effectiveRadius(c.radius, w, h), s = pictures[k] ?? null;
    ctx.save(); ctx.beginPath();
    if (r > 0) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    ctx.clip(); ctx.globalAlpha = alpha * c.alpha;
    if (!c.media) { ctx.fillStyle = EMPTY_CELL; ctx.fillRect(x, y, w, h); }
    else if (s === 'failed') { ctx.fillStyle = MISSING_MEDIA; ctx.fillRect(x, y, w, h); }
    else if (isPicture(s)) {
      const m = cellMediaRect(c.media.fit, s.width, s.height, c.rect, c.media.zoom, c.media.panX, c.media.panY);
      try { ctx.drawImage(s.image, m.x, m.y, m.w, m.h); } catch { /* A source closed under the draw shows nothing this frame. */ }
    }
    ctx.restore();
  });
}
/** §53.3: video cover clipped to the box, stacked alpha and images stretched, a failed source grey. A motion graphic's
 *  frame is rendered at the box size (D25) and drawn at (0, 0, W, H). A shape and a text (T05) are drawings with no source. */
function content(ctx: Ctx, d: Draw, src: Source) {
  const { W, H } = d.box;
  if (d.shape) { shapeContent(ctx, d.shape); return; }
  if (d.text) { drawText(ctx, d.text, W, H); return; }
  if (d.caption) { drawCaption(ctx, d.caption, W, H); return; }
  if (d.layout) { layoutContent(ctx, d.layout, src); return; }
  if (src === null) return;
  if (src === 'failed') { ctx.fillStyle = MISSING_MEDIA; ctx.fillRect(0, 0, W, H); return; }
  if (!isPicture(src)) return;
  try {
    if (d.kind !== 'video' || d.stackedAlpha) { ctx.drawImage(src.image, 0, 0, W, H); return; }
    const r = cover(src.width, src.height, W, H);
    if (!r) return;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    ctx.drawImage(src.image, r.x, r.y, r.w, r.h);
    ctx.restore();
  } catch { /* A source closed or reset under the draw shows nothing this frame. */ }
}
let maskedCanvas: OffscreenCanvas | null = null;
/** T12 (part 5 §54.1): the item's masks multiply the picture's alpha, RGB unchanged, after the GPU effects and before the box
 *  transform. A GPU result is not a 2D canvas, so it is copied to one first. */
function masked(picture: OffscreenCanvas, d: Draw): OffscreenCanvas {
  const W = picture.width, H = picture.height, canvas = picture === itemCanvas ? picture : maskedCanvas ??= new OffscreenCanvas(1, 1);
  if (canvas !== picture) { canvas.width = W; canvas.height = H; }
  const c = canvas.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (canvas !== picture) c.drawImage(picture, 0, 0);
  c.globalCompositeOperation = 'destination-in'; c.drawImage(maskCanvas(d.item.id, d.masks!, W, H), 0, 0); c.globalCompositeOperation = 'source-over';
  return canvas;
}
/** §53.4.1 effect path (a CSS chain, GPU effects or masks): the content is drawn into the item canvas first, then the GPU
 *  effects run on it (T10: WebGPU, else WebGL2; T22: an element's recolour first), then the masks. */
function effectPicture(d: Draw, src: Source): OffscreenCanvas | EffectFailure {
  const ic = itemContext(d.box.W, d.box.H);
  ic.setTransform(1, 0, 0, 1, 0, 0); ic.clearRect(0, 0, ic.canvas.width, ic.canvas.height);
  content(ic, d, src);
  const picture = d.effects.length || d.element ? runEffects(ic.canvas, d.effects, { timeS: d.local / 1000, element: d.element }) : ic.canvas;
  return d.masks?.length && typeof picture !== 'string' ? masked(picture, d) : picture;
}
/** One item's draw (§53.4.2); blend overrides the item's own (a transition surface neutralises it, §55.4). */
function drawItem(ctx: Ctx, d: Draw, src: Source, failed: Pending[], blend = d.blend) {
  const { W, H } = d.box;
  let picture: OffscreenCanvas | EffectFailure | null = null;
  if (d.path === 'css') {
    picture = effectPicture(d, src);
    // A tainted canvas stays tainted: once more on a fresh one, so only an item whose own picture is cross-origin fails.
    if (picture === 'CANVAS_TAINTED') { itemCanvas = null; picture = effectPicture(d, src); }
    if (typeof picture === 'string') {
      if (picture === 'CANVAS_TAINTED') { itemCanvas = null; console.warn(`CANVAS_TAINTED: item ${d.item.id}: ${EFFECT_FAILURES.CANVAS_TAINTED.message}`); }
      failed.push({ itemId: d.item.id, owner: 'T10', what: `Effects: ${picture}`, code: picture, ...EFFECT_FAILURES[picture] });
      return;
    }
  }
  // §53.4.2 step 6: alpha, blend, filter, box transform, rounded clip; then the content and the border; then restore.
  ctx.save();
  ctx.globalAlpha = d.alpha; ctx.globalCompositeOperation = blend;
  if (d.filter) ctx.filter = d.filter;
  ctx.setTransform(...d.matrix);
  const r = effectiveRadius(d.radius, W, H);
  if (r > 0) { ctx.beginPath(); ctx.roundRect(0, 0, W, H, r); ctx.clip(); }
  if (picture) ctx.drawImage(picture, 0, 0); else content(ctx, d, src);
  if (d.border) { ctx.lineWidth = d.border.width; ctx.strokeStyle = d.border.color; ctx.strokeRect(0, 0, W, H); }
  ctx.restore();
}
/** Draws one frame. backdrop: 'black' (export, capture: opaque black, §53.8.1) or 'clear' (preview: the stage shows through).
 *  Returns the items the effect stage could not draw (T10 B3, error codes l.339 / l.327); they are not drawn at all. The two
 *  draws of a transition pair (T11, §55.4) go onto their own surfaces, are combined by kind and drawn once, source-over. */
export function composite(ctx: Ctx, draws: Draw[], sources: Source[], size: { width: number; height: number }, backdrop: 'black' | 'clear'): Pending[] {
  const failed: Pending[] = [], paired = new Set<number>();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  if (backdrop === 'black') { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, size.width, size.height); } else ctx.clearRect(0, 0, size.width, size.height);
  draws.forEach((d, i) => {
    if (paired.has(i)) return;
    if (!d.transition) { drawItem(ctx, d, sources[i], failed); return; }
    const tag = d.transition, sides = draws.map((q, j) => [q, j] as const).filter(([q]) => q.transition?.id === tag.id);
    const [a, b, r] = surfaces(size.width, size.height);
    for (const [q, j] of sides) { paired.add(j); drawItem(q.transition!.role === 'from' ? a : b, q, sources[j], failed, 'source-over'); }
    combine(a, b, r, tag);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.drawImage(r.canvas, 0, 0);
    ctx.restore();
  });
  ctx.filter = 'none';
  return failed;
}
