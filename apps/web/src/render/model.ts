// SPDX-License-Identifier: AGPL-3.0-only
// Item render model (findings part 5 §53): one evaluator for the preview (T15) and the export (T16a). Pure: no DOM.
// Project px, y down. A matrix is canvas-ordered [a, b, c, d, e, f] (setTransform): it maps item-local px (u right, v down,
// origin = the unscaled box's top-left) to frame px, X = a·u + c·v + e, Y = b·u + d·v + f.
import type { ProjectDocument, RecordData } from '../store/model';
import { prop, propertyTime, sourceTime, valueAt } from '../timeline/properties';
import { ancestors, isCaption, stack, track } from '../timeline/model';
import { graphicFrame, graphicTimeMs } from '../mg/clock';
import { effectParamsAt, effectStack, isInternal } from '../timeline/effects';
import { cssFilterFor } from '../effects/css';
import { effectById } from '../effects/registry';
import type { EffectInstance } from '../effects/renderer';
import { resolveParams } from '../effects/validate';
import { pathAt } from '../timeline/shapes';
import type { ShapePath } from '../timeline/shapes';
import { animationState } from '../text/animation';
import type { TextDraw } from '../text/draw';
import { textStyle } from '../text/style';
import { cellItem, cellsOf, LAYOUT_PARITY } from '../timeline/layouts';
import { activeAt, KINDS, type Active } from '../timeline/transitions';
import type { Pair } from './transitions';

export type Mat = [number, number, number, number, number, number];
export type Rect = { x: number; y: number; w: number; h: number };
export type Box = { x: number; y: number; W: number; H: number; sx: number; sy: number; rotation: number; skew: number; flipX: boolean; flipY: boolean };
export type Size = { width: number; height: number };
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const projectSize = (doc: Pick<ProjectDocument, 'size'>): Size => ({ width: doc.size?.width || 1080, height: doc.size?.height || 1920 });

// ---- §53.1.1 one box or paint field at item-local ms: the property (static or keyframed, at property time), then
// details[key], then the fallback (the registry default unless the caller passes one).
export function field(item: RecordData, key: string, local: number, fallback?: unknown): any {
  const v = prop(item, key) ? valueAt(item, key, local) : undefined;
  return v ?? item.details?.[key] ?? fallback ?? valueAt(item, key, local);
}

// ---- §53.1 box geometry, §53.2.1 effective scale (scale ≠ 1 wins over scaleX / scaleY).
export function itemBox(doc: Pick<ProjectDocument, 'size'>, item: RecordData, local: number): Box {
  const { width: Wp, height: Hp } = projectSize(doc), caption = item.type === 'caption', f = (k: string, d: unknown) => field(item, k, local, d), scale = f('scale', 1);
  return {
    x: f('positionX', 0), y: f('positionY', 0), W: f('width', caption ? 800 : 0) || Wp, H: f('height', caption ? 100 : 0) || Hp,
    sx: scale !== 1 ? scale : f('scaleX', 1), sy: scale !== 1 ? scale : f('scaleY', 1),
    // Items store no skew; text animations add σ in itemDraw (§53.2.2 step 3, §56.3, T05).
    rotation: f('rotation', 0), skew: 0, flipX: !!f('flipX', false), flipY: !!f('flipY', false),
  };
}
// §53.2.2: translate(centre) · rotate(θ°) · skewX(σ°) · scale(sx·fx, sy·fy) · translate(−W/2, −H/2). No rounding.
// Centre = (x + |W·sx| / 2, y + |H·sy| / 2).
export function boxMatrix(b: Box): Mat {
  const r = b.rotation * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r), k = Math.tan(b.skew * Math.PI / 180);
  const ax = b.sx * (b.flipX ? -1 : 1), ay = b.sy * (b.flipY ? -1 : 1), cx = b.x + Math.abs(b.W * b.sx) / 2, cy = b.y + Math.abs(b.H * b.sy) / 2;
  const a = ax * cos, bb = ax * sin, c = ay * (k * cos - sin), d = ay * (k * sin + cos);
  return [a, bb, c, d, cx - a * b.W / 2 - c * b.H / 2, cy - bb * b.W / 2 - d * b.H / 2];
}
/** §53.8.1 step 3: the frame scale (Wo / Wp, Ho / Hp) applied after the box matrix. */
export function frameScale(doc: Pick<ProjectDocument, 'size'>, out: Size, m: Mat): Mat {
  const p = projectSize(doc), kx = out.width / p.width, ky = out.height / p.height;
  return [m[0] * kx, m[1] * ky, m[2] * kx, m[3] * ky, m[4] * kx, m[5] * ky];
}
export const apply = (m: Mat, u: number, v: number): [number, number] => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

// ---- §53.3 media fit (item-local px). Video: cover, centred, clipped to the box; a source under 2 px is not drawn.
export function cover(srcW: number, srcH: number, W: number, H: number): Rect | null {
  if (srcW < 2 || srcH < 2) return null;
  const a = srcW / srcH;
  return a > W / H ? { x: (W - H * a) / 2, y: 0, w: H * a, h: H } : { x: 0, y: (H - W / a) / 2, w: W, h: W / a };
}
/** Image: stretched to the box. */
export const stretch = (W: number, H: number): Rect => ({ x: 0, y: 0, w: W, h: H });
/** §53.3.1 export frame pick: the last frame whose timestamp ≤ request + 0.1 ms; before the first frame, the first. */
export function pickFrame(timestampsMs: number[], requestMs: number): number {
  let k = 0;
  for (let i = 0; i < timestampsMs.length; i++) if (timestampsMs[i] <= requestMs + 0.1) k = i;
  return k;
}
/** Missing / failed media in the export and frame capture (#374151); the preview draws nothing for a missing video frame. */
export const MISSING_MEDIA = '#374151';
/** §53.4.3: a uniform corner radius fitted to the box. */
export const effectiveRadius = (r: number, W: number, H: number) => Math.min(r, W / 2, H / 2);

// ---- §58: the 16 blend names map 1:1 to globalCompositeOperation; normal = source-over (no change).
export const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'] as const;
export const compositeOp = (mode: unknown): GlobalCompositeOperation => mode !== 'normal' && (BLENDS as readonly unknown[]).includes(mode) ? mode as GlobalCompositeOperation : 'source-over';

// ---- §53.4.1 path and §53.4.3 the item's own CSS chain: blur (> 0, px) then brightness (≠ 1, × 100 %).
// Masks (T12) are not rendered by T15: an item that needs them is reported, not drawn wrong. k scales CSS px lengths (cssScale).
export function cssChain(item: RecordData, local: number, k = 1): string {
  const blur = Number(field(item, 'blur', local, 0)) || 0, brightness = Number(field(item, 'brightness', local, 1));
  return [blur > 0 ? `blur(${blur * k}px)` : '', Number.isFinite(brightness) && brightness !== 1 ? `brightness(${brightness * 100}%)` : ''].filter(Boolean).join(' ');
}
const enabled = (list: unknown) => Array.isArray(list) ? list.filter(e => e && e.enabled !== false) : [];
/** CSS effect keys that are px lengths (part 4 §51.5, §51.6), scaled by cssScale. */
const CSS_LENGTHS: Record<string, string[]> = { 'gaussian-blur': ['radius'], 'drop-shadow': ['x', 'y', 'blur'] };
/** Enabled stack entries the effect path does not draw, with the owner ticket: bg-removal needs T12's matte, recolor is T22's
 *  element pass, and an id the registry does not know has no renderer. The first one in stack order makes the item pending. */
const UNRENDERED: Record<string, [string, string]> = { 'bg-removal': ['T12', 'Background removal rendering'], recolor: ['T22', 'Recolor rendering'] };
export function unrenderedEffect(item: RecordData): { owner: string; what: string } | null {
  for (const e of effectStack(item)) {
    if (!e || e.enabled === false || isInternal(e)) continue;
    const known = UNRENDERED[e.effectId];
    if (known) return { owner: known[0], what: known[1] };
    if (!effectById(e.effectId)) return { owner: '?', what: `Unknown effect '${e.effectId}'` };
  }
  return null;
}
/** T10 (§53.4.1, part 4 §48 0.3): the item's enabled, known effects in stack order with their values at item-local ms, the
 *  transport stages left out. WebGL entries run on the item canvas; CSS entries give filter functions that follow the item's
 *  own chain. itemDraw reports an item with an unrendered entry (unrenderedEffect) before it gets here. */
export function itemEffects(item: RecordData, local: number, k = 1): { gpu: EffectInstance[]; css: string[] } {
  const gpu: EffectInstance[] = [], css: string[] = [];
  for (const e of effectStack(item)) {
    const def = e && e.enabled !== false && !isInternal(e) ? effectById(e.effectId) : undefined;
    if (!def) continue;
    const params = effectParamsAt(item, e, local);
    if (def.renderType === 'webgl') { gpu.push({ effectId: def.id, params, enabled: true, order: gpu.length }); continue; }
    const values = resolveParams(def.id, params);
    for (const key of CSS_LENGTHS[def.id] ?? []) values[key] = Number(values[key]) * k;
    const f = cssFilterFor(def.id, values);
    if (f) css.push(f.filter);
  }
  return { gpu, css };
}
/** The internal effect that marks a stacked-alpha video (findings §6 "alpha video packed side by side", §13 merge pool). An
 *  entry of the item's effect stack {id, effectId, enabled, order, parameters}; T10 defines it as a transport stage
 *  (effects/registry.ts TRANSPORT_STAGES): stored first, hidden from the cards and the agent ids. */
export const STACKED_ALPHA_EFFECT = 'stacked-alpha';
export const isStackedAlpha = (item: RecordData) => item.type === 'video' && enabled(item.effects).some(e => e.effectId === STACKED_ALPHA_EFFECT);

// ---- §53.5 stacking: layerOrder bottom-first, groups in place; a hidden track or hidden enclosing group is skipped; audio
// tracks hold no picture. Muted / solo are sound only, locked has no effect.
const hidden = (doc: ProjectDocument, id: string) => !!track(doc, id)?.hidden || ancestors(doc, id).some(g => doc.groups[g]?.hidden);
export const drawTracks = (doc: ProjectDocument): string[] => stack(doc).filter(id => !hidden(doc, id) && track(doc, id)?.kind !== 'audio');
/** Items of one track in draw order: stable sort by display.from (zIndex ignored by the export and the canvas preview). */
export const trackItems = (doc: ProjectDocument, trackId: string): RecordData[] =>
  doc.items.map((i, n) => [i, n] as const).filter(([i]) => i.trackId === trackId).sort((a, b) => a[0].display.from - b[0].display.from || a[1] - b[1]).map(([i]) => i);
export const isVisible = (item: RecordData, t: number) => item.display.from <= t && t < item.display.to;
/** Preview canvas runs (§53.5.4): tracks bottom-up, hidden / audio / empty skipped; consecutive canvas tracks share one
 *  canvas; any other track with items ends the run (it is drawn by its owner's layer). A canvas track is a video-kind track
 *  or a track holding a motion graphic, a shape, a text or a layout (T08, T06, T05, T07: the preview draws the export's
 *  drawing, not a DOM layer). */
export function previewRuns(doc: ProjectDocument): { trackIds: string[]; index: number }[] {
  const runs: { trackIds: string[]; index: number }[] = [];
  let run: string[] | null = null, n = 0;
  for (const id of drawTracks(doc)) {
    if (!doc.items.some(i => i.trackId === id)) continue;
    n++;
    if (track(doc, id)?.kind === 'video' || doc.items.some(i => i.trackId === id && (i.type === 'motionGraphic' || i.type === 'shape' || i.type === 'text' || i.type === 'layout'))) { if (!run) runs.push({ trackIds: run = [], index: n }); run.push(id); runs[runs.length - 1].index = n; }
    else run = null;
  }
  return runs;
}

// ---- One item's draw at timeline ms t (§53.4.2 order: alpha, blend, filter, box transform, rounded clip, content, border).
export type Draw = {
  item: RecordData; kind: 'video' | 'image' | 'motionGraphic' | 'shape' | 'text' | 'layout'; local: number;
  /** Source ms to show: the remap / trim clock for video (§53.3.1), property time for an image or a shape, graphic time for
   *  a motion graphic. */
  sourceMs: number;
  box: Box; matrix: Mat; alpha: number; blend: GlobalCompositeOperation; filter: string; radius: number;
  /** 'css' = the effect path (§53.4.1): a CSS chain or GPU effects. */
  border: { width: number; color: string } | null; path: 'direct' | 'css';
  /** A stacked-alpha video: its merged frame is stretched to the box (§53.3.1), not cover-fitted. */
  stackedAlpha: boolean;
  /** T10: the enabled WebGL effects with their values at this frame, run on the item canvas in this order. */
  effects: EffectInstance[];
  /** A motion graphic (T08): its code, the graphic frame on the MG clock, and what useVideoConfig reports. */
  graphic?: GraphicDraw;
  /** A shape (T06): its path at property time, drawn 1:1 in box px (§53.1.2), with its fill and stroke. */
  shape?: ShapeDraw;
  /** A text (T05): its style, its entrance animation state at this local ms (the box channels are already in box and alpha)
   *  and its look, drawn in box px by text/draw.ts. */
  text?: TextDraw;
  /** A layout (T07): its cells in box px. */
  layout?: LayoutDraw;
  /** T11: one side of a transition pair (framePlan). */
  transition?: TransitionTag;
};
/** §53.3.3 one layout cell: its rectangle in box px (gap applied), the corner radius of its clip, its alpha factor (cell
 *  opacity / 100; the item's opacity is the draw's alpha) and, when filled, the media as a draw of the cell's media item
 *  (timeline/layouts cellItem) with its fit, zoom and pan. An empty cell is white at 6 % alpha. */
export type CellDraw = { rect: Rect; radius: number; alpha: number; media: { draw: Draw; fit: 'cover' | 'contain'; zoom: number; panX: number; panY: number } | null };
export type LayoutDraw = { cells: CellDraw[] };
export const EMPTY_CELL = 'rgba(255, 255, 255, 0.06)';
const num = (v: unknown, d: number) => typeof v === 'number' && Number.isFinite(v) ? v : d;
/** §53.3.3 cell rectangle: bounds (fractions) × the box, inset by half the gap on every side. */
export const cellRect = (b: { x: number; y: number; width: number; height: number }, W: number, H: number, gap = 0): Rect =>
  ({ x: b.x * W + gap / 2, y: b.y * H + gap / 2, w: b.width * W - gap, h: b.height * H - gap });
/** §53.3.3 media in a cell: cover or contain at zoom / 100, centred, then moved by pan / 200 × the cell size. */
export function cellMediaRect(fit: 'cover' | 'contain', srcW: number, srcH: number, c: Rect, zoom = 100, panX = 0, panY = 0): Rect {
  const z = zoom / 100, a = srcW / srcH, A = c.w / c.h, heightLed = fit === 'cover' ? a > A : a < A;
  const h = heightLed ? c.h * z : c.w * z / a, w = heightLed ? h * a : c.w * z;
  return { x: c.x + (c.w - w) / 2 + panX / 200 * c.w, y: c.y + (c.h - h) / 2 + panY / 200 * c.h, w, h };
}
/** Fill mode "fill" = cover, anything else = contain; an image cell is cover in Xapp's export (§53.9 row 7) and honours Fit
 *  here unless LAYOUT_PARITY.imageFit says 'cover'. */
const cellFit = (type: string, fillMode: unknown): 'cover' | 'contain' => fillMode === 'fill' || (type === 'image' && LAYOUT_PARITY.imageFit === 'cover') ? 'cover' : 'contain';
function layoutDraw(item: RecordData, local: number, box: Box, parent: Draw): LayoutDraw {
  const gap = Math.max(0, num(item.details?.gap, 0)), radius = Math.max(0, num(item.details?.borderRadius, 0));
  return { cells: cellsOf(item).flatMap((cell, k): CellDraw[] => {
    const rect = cellRect(cell.bounds, box.W, box.H, gap);
    if (!(rect.w > 0 && rect.h > 0)) return [];
    const media = cellItem(item, cell, k), kind = media?.type as 'video' | 'image';
    return [{ rect, radius, alpha: typeof cell.opacity === 'number' ? Math.min(1, Math.max(0, cell.opacity / 100)) : 1, media: media ? {
      draw: { ...parent, item: media, kind, sourceMs: kind === 'video' ? sourceTime(media, local) : propertyTime(media, local), effects: [], stackedAlpha: false, layout: undefined },
      fit: cellFit(kind, cell.fillMode), zoom: num(cell.zoom, 100), panX: num(cell.panX, 0), panY: num(cell.panY, 0),
    } : null }];
  }) };
}
/** fill / stroke null = not drawn (colour "none", opacity 0, or stroke width 0). Alphas multiply the item's opacity once
 *  (§53.4.5 quirk 2, opacity squared on the effect path, is not reproduced: T06 Q10). */
export type ShapeDraw = { path: ShapePath; fill: { color: string; alpha: number } | null; stroke: { color: string; width: number; alpha: number } | null };
function shapeDraw(item: RecordData, local: number): ShapeDraw {
  const f = (k: string, d: unknown) => field(item, k, local, d), alpha = (k: string) => Math.min(1, Math.max(0, Number(f(k, 1)) || 0));
  const fill = String(f('fillColor', '#3b82f6')), stroke = String(f('strokeColor', 'none')), width = Number(f('strokeWidth', 0)) || 0;
  return {
    path: pathAt(item.details, propertyTime(item, local)),
    fill: fill !== 'none' && alpha('fillOpacity') > 0 ? { color: fill, alpha: alpha('fillOpacity') } : null,
    stroke: stroke !== 'none' && width > 0 && alpha('strokeOpacity') > 0 ? { color: stroke, width, alpha: alpha('strokeOpacity') } : null,
  };
}
/** lastFrame: the designed length's last frame (Infinity without one). */
export type GraphicDraw = { code: string; frame: number; lastFrame: number; fps: number; canvas: Size; durationInFrames: number; fieldValues: Record<string, unknown> };
/** Render options. cssScale (preview only, §53.9 row 20): CSS px lengths × this factor, so a reduced-quality canvas blurs as
 *  much as the project-size frame does; the export and capture keep 1 (fixed output px). */
export type DrawOptions = { cssScale?: number };
/** What a frame needs that T15 does not render, with the owner ticket (shown on the stage, never drawn wrong). The
 *  compositor adds an item its effect stage could not draw, with the error code, category, recovery and sentence (T10 B3). */
export type Pending = { itemId: string; owner: string; what: string; code?: string; category?: string; recovery?: string; message?: string };
const OWNERS: Record<string, [string, string]> = { caption: ['T09', 'Captions'] };
/** §56.3 a text animation's channels on the box and alpha: scale k about the box centre, translate (tx, ty) box sizes,
 *  rotation r and skew σ degrees added, alpha × o. w, h = the scaled box |W·sx|, |H·sy|. */
function animateBox(box: Box, c: { k: number; tx: number; ty: number; r: number; skew: number }): Box {
  const w = Math.abs(box.W * box.sx), h = Math.abs(box.H * box.sy);
  return { ...box, x: box.x + w * (1 - c.k) / 2 + c.tx * w, y: box.y + h * (1 - c.k) / 2 + c.ty * h, sx: box.sx * c.k, sy: box.sy * c.k, rotation: box.rotation + c.r, skew: box.skew + c.skew };
}
/** T08 MG clock (findings §16 addendum, mg/clock.ts): clip start = display.from, trim start = trim.from, designed length =
 *  sourceDuration. durationInFrames = the clip length (G-06: Xapp's export reports it; Cutframe follows the export). */
function graphicDraw(doc: ProjectDocument, item: RecordData, t: number): { sourceMs: number; graphic: GraphicDraw } {
  const fps = fpsOf(doc), values = item.details?.fieldValues;
  const clock = { timelineTimeMs: t, clipStartMs: item.display.from, trimStartMs: item.trim?.from ?? 0, designedLengthMs: typeof item.sourceDuration === 'number' ? item.sourceDuration : undefined };
  return { sourceMs: graphicTimeMs(clock), graphic: { code: item.details.code, frame: graphicFrame({ ...clock, fps }), lastFrame: graphicFrame({ ...clock, timelineTimeMs: Infinity, fps }), fps, canvas: projectSize(doc),
    durationInFrames: Math.round((item.display.to - item.display.from) * fps / 1000), fieldValues: values && typeof values === 'object' && !Array.isArray(values) ? values : {} } };
}
export function itemDraw(doc: ProjectDocument, item: RecordData, t: number, out: Size = projectSize(doc), opts: DrawOptions = {}): Draw | Pending | null {
  if (item.type === 'audio') return null;
  const local = t - item.display.from;
  let alpha = Number(field(item, 'opacity', local, 1));
  if (!(alpha > 0)) return null;
  const owner = OWNERS[isCaption(item) ? 'caption' : item.type];
  if (owner) return { itemId: item.id, owner: owner[0], what: `${owner[1]} rendering` };
  const mg = item.type === 'motionGraphic', shape = item.type === 'shape', text = item.type === 'text', layout = item.type === 'layout';
  // A motion graphic without code (the panel's blank graphic, a legacy one) is an empty graphic: nothing to draw (T08 notes).
  if (mg && !(typeof item.details?.code === 'string' && item.details.code)) return null;
  if (item.type !== 'video' && item.type !== 'image' && !mg && !shape && !text && !layout) return { itemId: item.id, owner: '?', what: `Item type ${item.type}` };
  if (enabled(item.masks).length) return { itemId: item.id, owner: 'T12', what: 'Masks rendering' };
  const unrendered = unrenderedEffect(item);
  if (unrendered) return { itemId: item.id, ...unrendered };
  let box = itemBox(doc, item, local), textDraw: TextDraw | undefined;
  const k = opts.cssScale ?? 1;
  if (text) {
    // §56: the entrance runs on item-local ms (trim ignored); its box channels move the box, o multiplies the alpha.
    const style = textStyle(item, local), anim = animationState(item.details?.textAnimation, local, style.text);
    box = animateBox(box, anim.channels); alpha *= anim.channels.o;
    if (!(alpha > 0)) return null;
    textDraw = { item, style, anim, look: item.details?.look, shadowScale: k };
  }
  const matrix = frameScale(doc, out, boxMatrix(box));
  if (!(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) > 0)) return null;
  const fx = itemEffects(item, local, k);
  // A text's borderWidth / borderColor are its font stroke (text/draw.ts), not a box border.
  const filter = [cssChain(item, local, k), ...fx.css].filter(Boolean).join(' '), bw = text ? 0 : Number(field(item, 'borderWidth', local, 0)) || 0;
  const d: Draw = {
    item, kind: item.type, local, ...mg ? graphicDraw(doc, item, t) : { sourceMs: item.type === 'video' ? sourceTime(item, local) : propertyTime(item, local) },
    box, matrix, alpha: Math.min(1, alpha), blend: compositeOp(field(item, 'blendMode', local, 'normal')), filter,
    radius: Math.max(0, Number(field(item, 'borderRadius', local, 0)) || 0),
    border: bw > 0 ? { width: bw, color: String(field(item, 'borderColor', local, '#000000')) } : null, path: filter || fx.gpu.length ? 'css' : 'direct',
    stackedAlpha: isStackedAlpha(item), effects: fx.gpu, ...shape ? { shape: shapeDraw(item, local) } : {}, ...textDraw ? { text: textDraw } : {},
  };
  if (layout) d.layout = layoutDraw(item, local, box, d);
  return d;
}
export const isPending = (d: Draw | Pending): d is Pending => 'owner' in d;
/** T11: the two draws of a transition pair carry its id, their role and the kind at linear progress p (§55.4). */
export type TransitionTag = Pair & { id: string; role: 'from' | 'to' };
/** Every draw of the frame at timeline ms t, bottom first, plus what the frame shows that T15 does not render. trackIds limits
 *  the walk (one preview run). T11 (§55.3, §55.4; results §11 decision 1: Cutframe renders transitions in the preview too, Xapp's
 *  preview hard-cuts): inside a transition's window both clips are drawn at t, extended past their own range, tagged, at the
 *  place of the first of them in the track's draw order; the compositor combines them. A stored kind outside the six is
 *  listed and its clips hard-cut. */
export function framePlan(doc: ProjectDocument, t: number, out: Size = projectSize(doc), trackIds: string[] = drawTracks(doc), opts: DrawOptions = {}): { draws: Draw[]; pending: Pending[] } {
  const draws: Draw[] = [], pending: Pending[] = [], pairs: Active[] = [];
  for (const a of doc.transitions?.length ? activeAt(doc, t) : []) {
    if (!trackIds.includes(a.from.trackId)) continue;
    if ((KINDS as readonly unknown[]).includes(a.record.kind)) pairs.push(a);
    else pending.push({ itemId: String(a.record.id), owner: 'T11', what: `Transition kind '${a.record.kind}'` });
  }
  const push = (d: Draw | Pending | null, tag?: TransitionTag) => { if (d) { if (isPending(d)) pending.push(d); else draws.push(tag ? { ...d, transition: tag } : d); } };
  const done = new Set<Active>();
  for (const id of trackIds) for (const item of trackItems(doc, id)) {
    const pair = pairs.find(a => a.from.id === item.id || a.to.id === item.id);
    if (pair) {
      if (done.has(pair)) continue;
      done.add(pair);
      const r = pair.record, tag = (role: 'from' | 'to'): TransitionTag => ({ id: String(r.id), role, kind: r.kind, p: pair.p, direction: r.direction, params: r.params });
      push(itemDraw(doc, pair.from, t, out, opts), tag('from'));
      push(itemDraw(doc, pair.to, t, out, opts), tag('to'));
      continue;
    }
    if (!isVisible(item, t)) continue;
    push(itemDraw(doc, item, t, out, opts));
  }
  return { draws, pending };
}

// ---- §53.8 frame loop and clocks.
export const fpsOf = (doc: Pick<ProjectDocument, 'fps'>) => doc.fps || 30;
export const frameTime = (n: number, fps: number) => n / fps * 1000;
/** The export's frames: N = ceil(duration / 1000 × fps) after the leading-gap shift (earliest exported item start > 1 ms);
 *  a range gives floor(start × fps) … ceil(end × fps) − 1 with no shift. */
export function exportPlan(doc: ProjectDocument, range?: { startS: number; endS: number }) {
  const fps = fpsOf(doc);
  if (range) { const first = Math.floor(range.startS * fps); return { fps, first, count: Math.ceil(range.endS * fps) - first, shiftMs: 0 }; }
  const exported = new Set(stack(doc).filter(id => !hidden(doc, id))), starts = doc.items.filter(i => exported.has(i.trackId)).map(i => i.display.from);
  const earliest = starts.length ? Math.min(...starts) : 0, shiftMs = earliest > 1 ? earliest : 0;
  return { fps, first: 0, count: Math.ceil(((doc.duration ?? 8000) - shiftMs) / 1000 * fps), shiftMs };
}
export type Plan = ReturnType<typeof exportPlan>;
/** Export frame n shows the timeline at this ms; encoded timestamp in s. */
export const planTime = (plan: Plan, n: number) => frameTime(n, plan.fps) + plan.shiftMs;
export const encodedTime = (plan: Plan, n: number) => (n - plan.first) / plan.fps;
/** §53.8.3 preview clock: the frame index round(t s × fps), and that frame's time. */
export const previewFrame = (tMs: number, fps: number) => Math.round(tMs / 1000 * fps);
export const snapTime = (tMs: number, fps: number) => frameTime(previewFrame(tMs, fps), fps);
/** Playback's element sync (T15, provisional, not Xapp parity). A playing element's offset from the clock is media time; a
 *  clip at speed rate covers rate / fps media s per timeline frame (mediaFrame), the unit of its ½-frame and CATCH_UP
 *  thresholds. catchUpNudge: the nudge for offset off (media s, element minus clock) and one frame `frame`: on beyond one
 *  frame (+1 behind, −1 ahead), off within half a frame, else kept. */
export const mediaFrame = (fps: number, rate: number) => rate / fps;
export const catchUpNudge = (off: number, nudge: number, frame: number) => Math.abs(off) > frame ? (off < 0 ? 1 : -1) : Math.abs(off) < frame / 2 ? 0 : nudge;

// ---- §53.8.3 preview canvas size. Paused: the project size. Playing: q = max(0.1, min(1, quality, display)), display =
// max(on-screen W × dpr / Wp, on-screen H × dpr / Hp); size = max(2, round(Wp q)) × max(2, round(Hp q)).
export const QUALITY_FACTOR = { full: 1, half: 0.5, quarter: 0.25 } as const;
export function canvasSize(project: Size, playing: boolean, quality: keyof typeof QUALITY_FACTOR, onscreen: Size, dpr: number): Size {
  if (!playing) return project;
  const display = Math.max(onscreen.width * dpr / project.width, onscreen.height * dpr / project.height);
  const q = Math.max(0.1, Math.min(1, QUALITY_FACTOR[quality], display));
  return { width: Math.max(2, Math.round(project.width * q)), height: Math.max(2, Math.round(project.height * q)) };
}
