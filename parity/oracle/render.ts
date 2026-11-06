// SPDX-License-Identifier: AGPL-3.0-only
// Expected export frame of a project: findings part 5 §53 (item model), §54 (masks), §58 (blend)
// and part 4 §48.3 (GPU chain, masks, then the CSS chain at the draw). CPU float with the canvas
// draw model: content → canvas filter (output px) → × global alpha → rounded clip → blend; the
// frame is stored back to 8 bit after every draw. Decoding and glyph rasterising come from deps.
import { createImage, mapPixels, sample, type Image, type Effect, type EffectContext } from './image';
import { clamp, colour, type RGBA } from './math';
import {
  IDENTITY, apply, boxMatrix, cellAlpha, cellMedia, cellRect, cellSourceTime, chains, cover, drawTracks, effectiveRadius, field, frameScale,
  invert, isVisible, itemBox, linear, projectSize, propertyTime, sourceTime, stretch, trackItems, EMPTY_CELL, MISSING_MEDIA,
  type Box, type Ease, type EffectRef, type Item, type Mat, type Project, type Rect, type Size,
} from './item';
import { applyMask, fillCoverage, maskAlpha, sourceUs, type AlphaPlane, type Pt } from './masks';
import { compositeImage, q8 } from './blend';
import { cssFilters as distortCss } from './distort';
import { recolorActive } from './colour';
import { PER_GRAPHEME, PRESET_MS, applyTextChannels, graphemeStates, textChannels, type GraphemeState, type TextAnimation } from './text';
import { captionSettings, wordState, type Word, type WordState } from './captions';
import { transferImage, videoInput } from './transfer';

// A transition pair's combined surface (project px, full canvas), drawn source-over once, at the
// first of its items in the draw order; those items are then not drawn on their own (§53.5.3, §55.4).
export type TransitionDraw = { itemIds: string[]; image: Image };
// What deps.text rasterises one text, caption or shape item into. Text, captions and shapes are vectors drawn at the
// final resolution (§53.4.1, §53.4.5 quirk 4), so deps.text draws through m itself and the oracle never resamples them.
// - Direct path: m = the full item matrix (box transform with the text-animation channels, then the frame scale),
//   size = the output frame. Nothing is clipped at the box (quirk 3, §53.7.3).
// - Effect path: m = identity, size = the W × H item canvas (which clips), later resampled through the item matrix.
// - A canvas shadow (text and caption only) is its own draw just before the draw it shadows; its offset and blur are
//   target px and are not transformed by m (§53.7.3; item px on the effect path, quirk 5).
// - graphemes: the §56.6 states of a typewriter, scramble or step-fade item at τ, else null. deps.text MUST apply them on
//   the layout of the full final text: draw only visible graphemes (stroke and decoration too), the shown glyph, its
//   opacity, dropped by drop × H. Captions index graphemes across the words joined by single spaces (§57.3).
// - words: the §57.2 states of a caption's details.words at τ, else null; opacity = the mode alpha only (the renderer
//   applies the item opacity), colour null = the item colour. deps.text MUST apply them.
export type TextTarget = { timeMs: number; m: Mat; size: Size; graphemes: GraphemeState[] | null; words: WordState[] | null };
export type Deps = {
  exportColour?: boolean; // D34/D35 video + graphic input tables and final all-pixel output; omitted for preview/canvas
  effects: Record<string, Effect>; // GPU effects by kind, run in stack order on the W × H item canvas
  cssFilters: Record<string, Effect>; // CSS-rendered stack effects by kind, run on the frame-sized layer (the item's blur and brightness are built in)
  source(item: Item, sourceTimeMs: number, cell?: number): Image | null; // decoded frame / bitmap (layout: cell index); null = decode error → grey box
  // The draw calls of a text, caption or shape item in canvas order (background; then per line or word: shadow,
  // stroke, fill, decoration), each a raster of target.size in target px with the draw's own (fill, stroke or word)
  // alpha and without the item opacity. Each is faded and blended on its own (§53.4.2 step 9, §58.4).
  text?(item: Item, target: TextTarget): Image[];
  // Element data of an image item that is a Xapp element with a source, as colour.ts `recolor` takes it
  // (palette, colors, chromaLo/Hi, glossLo/Hi), else null. Where an item stores it is not in the spec (part 4 §49.19).
  element?(item: Item): Record<string, any> | null;
  transition?(project: Project, timeMs: number, renderLayer: (item: Item, timeMs: number) => Image): TransitionDraw[];
  raster?(item: Item, mask: any, sourceTimeUs: number): AlphaPlane | null; // held frame of a raster mask
  ease?: Ease; // keyframe easing (default: linear only)
  seed?: number; // per-render random seed passed to the effects
};
type Layer = { image: Image; alpha: number };

// §53.4.3: the item's own CSS filters, first in the CSS chain. blur = a CSS blur with σ = value output px (the
// part 4 §51.5 kernel); brightness = CSS brightness(value × 100 %): each channel × value, clamped, on
// un-premultiplied sRGB (the CSS Filter Effects reading part 4 §49.15 uses for invert).
const ITEM_FILTERS: Record<string, Effect> = {
  blur: (img, p, ctx) => distortCss['gaussian-blur'](img, { radius: p.value }, ctx),
  brightness: (img, p) => mapPixels(img, c => [clamp(c[0] * p.value), clamp(c[1] * p.value), clamp(c[2] * p.value), c[3]]),
};
const cssFilter = (deps: Deps, kind: string): Effect | undefined => ITEM_FILTERS[kind] ?? deps.cssFilters[kind];
// How far (px) a CSS filter reads past a pixel: ceil(3σ) for the blurs (§51.5), plus the offset for drop-shadow
// (§51.6; inventory defaults x 4, y 4, blur 4; +1 for its bilinear shift). Per-pixel filters read nothing around.
const num = (v: unknown, d: number) => typeof v === 'number' && Number.isFinite(v) ? v : d;
function reach(c: EffectRef): number {
  const p = c.params, blur = (s: number) => Math.ceil(3 * Math.max(s, 0));
  if (c.kind === 'blur') return blur(p.value);
  if (c.kind === 'gaussian-blur') return blur(num(p.radius, 0));
  if (c.kind === 'drop-shadow') return Math.ceil(Math.max(Math.abs(num(p.x, 4)), Math.abs(num(p.y, 4)))) + 1 + blur(num(p.blur, 4));
  if (c.kind === 'brightness' || c.kind === 'invert') return 0;
  throw Error(`CSS filter ${c.kind}: its reach past a pixel is not known`);
}
// The out-sized middle of a layer padded by `pad` on every side.
function crop(img: Image, pad: number, out: Size): Image {
  if (!pad) return img;
  const res = createImage(out.width, out.height);
  for (let y = 0; y < out.height; y++) { const from = ((y + pad) * img.width + pad) * 4; res.data.set(img.data.subarray(from, from + out.width * 4), y * out.width * 4); }
  return res;
}

// §56.1 / §56.2: a version-1 config with a known preset; anything else is undefined and throws.
const knownAnimation = (a: any) => a?.version === 1 && (a.preset === 'none' || PER_GRAPHEME.includes(a.preset) || Object.hasOwn(PRESET_MS, a.preset));
// §53.4.2 step 6, §56.3: the whole-box text-animation channels at item-local τ (trim ignored) on the box and the global alpha.
function animated(item: Item, a: unknown, tau: number, box: Box, opacity: number): [Box, number] {
  if (a == null) return [box, opacity];
  if (!knownAnimation(a)) throw Error(`item ${item.id}: textAnimation ${JSON.stringify(a)} is not a version-1 config with a known preset (§56.1)`);
  const r = applyTextChannels({ x: box.x, y: box.y, width: box.W, height: box.H, scaleX: box.sx, scaleY: box.sy, rotation: box.rotation, skewX: box.skew, opacity }, textChannels(a as TextAnimation, tau));
  return [{ ...box, x: r.x, y: r.y, sx: r.scaleX, sy: r.scaleY, rotation: r.rotation, skew: r.skewX }, r.opacity];
}
// §56.6 grapheme states (text and captions) and §57.2 word states (captions with words) at item-local τ. Stored
// caption: details.text, words [{text, startMs, endMs}], renderMode, renderConfig (part 3 stored caption item).
const RENDER_MODES = ['default', 'highlight', 'word-by-word', 'slide-up', 'slide-left'];
function textStates(item: Item, a: TextAnimation | null, tau: number): { graphemes: GraphemeState[] | null; words: WordState[] | null } {
  const d = item.details ?? {}, list: Word[] | null = item.type === 'caption' && Array.isArray(d.words) && d.words.length ? d.words : null;
  let words: WordState[] | null = null;
  if (list) {
    const mode = d.renderMode ?? 'default';
    if (!RENDER_MODES.includes(mode)) throw Error(`caption ${item.id}: renderMode ${JSON.stringify(mode)} is not one of the §57.2 modes`);
    const s = captionSettings(mode, d.renderConfig ?? {});
    words = list.map(w => wordState(mode, w, tau, s));
  }
  const text = list ? list.map(w => w.text).join(' ') : String(d.text ?? '');
  return { graphemes: a && PER_GRAPHEME.includes(a.preset) ? graphemeStates(a, text, tau) : null, words };
}

const rectRing = (r: Rect): Pt[] => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
const map = (m: Mat, ring: Pt[]): Pt[] => ring.map(([u, v]) => apply(m, u, v));
function roundedRing(r: Rect, radius: number, n = 32): Pt[] {
  const k = effectiveRadius(radius, r.w, r.h), out: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= n; i++) { const a = a0 + i / n * Math.PI / 2; out.push([cx + k * Math.cos(a), cy + k * Math.sin(a)]); } };
  corner(r.x + r.w - k, r.y + k, -Math.PI / 2); corner(r.x + r.w - k, r.y + r.h - k, 0); corner(r.x + k, r.y + r.h - k, Math.PI / 2); corner(r.x + k, r.y + k, Math.PI);
  return out;
}
const premultiply = (img: Image): Image => { const data = img.data.slice(); for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k++) data[i + k] *= data[i + 3]; return { ...img, data }; };
const scaleAlpha = (img: Image, k: number, clip?: Float32Array | null): Image => { const data = img.data.slice(); for (let i = 3; i < data.length; i += 4) data[i] *= k * (clip ? clip[(i - 3) / 4] : 1); return { ...img, data }; };
const quantise = (img: Image): Image => ({ ...img, data: img.data.map(q8) });

// Anti-aliased coverage: the product over sets of polygons (local px, mapped by m) — the drawn quad times every clip.
function coverageOf(size: Size, m: Mat, sets: Pt[][][]): Float32Array {
  const out = new Float32Array(size.width * size.height).fill(1);
  for (const rings of sets) { const c = fillCoverage(rings.map(r => map(m, r)), size.width, size.height); for (let i = 0; i < out.length; i++) out[i] *= c[i]; }
  return out;
}
// drawImage of src onto local rect r through m: bilinear on premultiplied texels, clamp-to-edge (image smoothing on).
function drawRaster(size: Size, src: Image, r: Rect, m: Mat, clips: Pt[][][] = []): Image {
  const out = createImage(size.width, size.height), cov = coverageOf(size, m, [[rectRing(r)], ...clips]), inv = invert(m), pm = premultiply(src);
  for (let i = 0; i < cov.length; i++) {
    if (cov[i] <= 0) continue;
    const [u, v] = apply(inv, i % size.width + 0.5, Math.floor(i / size.width) + 0.5), s = sample(pm, (u - r.x) / r.w, 1 - (v - r.y) / r.h);
    if (s[3] > 0) out.data.set([s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3] * cov[i]], i * 4);
  }
  return out;
}
function fillLayer(size: Size, m: Mat, sets: Pt[][][], c: RGBA): Image {
  const out = createImage(size.width, size.height), cov = coverageOf(size, m, sets);
  for (let i = 0; i < cov.length; i++) if (cov[i] > 0) out.data.set([c[0], c[1], c[2], c[3] * cov[i]], i * 4);
  return out;
}

// §53.4.2 step 3: the content fitted into the box, drawn through m into an image of `size`; alpha = the draw's global alpha.
function content(item: Item, t: number, deps: Deps, size: Size, m: Mat, box: Box, opacity: number, states: ReturnType<typeof textStates>): Layer[] {
  const local = t - item.display.from, ease = deps.ease ?? linear, boxRect = stretch(box.W, box.H);
  const grey = (): Layer[] => [{ image: fillLayer(size, m, [[rectRing(boxRect)]], MISSING_MEDIA), alpha: opacity }];
  if (item.type === 'video') {
    const decoded = deps.source(item, sourceTime(item, local, ease)), src = decoded && deps.exportColour ? videoInput(decoded) : decoded;
    if (!src) return grey();
    const r = cover(src.width, src.height, box.W, box.H);
    return r ? [{ image: drawRaster(size, src, r, m, [[rectRing(boxRect)]]), alpha: opacity }] : [];
  }
  if (item.type === 'image') {
    const src = deps.source(item, propertyTime(item, local));
    return src ? [{ image: drawRaster(size, src, boxRect, m), alpha: opacity }] : grey();
  }
  if (item.type === 'text' || item.type === 'caption' || item.type === 'shape') {
    if (!deps.text) throw Error(`${item.type} item ${item.id}: deps.text is required`);
    return deps.text(item, { timeMs: t, m, size, ...states }).map((image): Layer => {
      if (image.width !== size.width || image.height !== size.height) throw Error(`${item.type} item ${item.id}: deps.text returned a ${image.width} × ${image.height} draw for a ${size.width} × ${size.height} target`);
      return { image, alpha: opacity };
    });
  }
  if (item.type === 'layout') {
    const d = item.details ?? {}, gap = d.gap ?? 0, radius = d.borderRadius ?? 0;
    return (d.cells ?? []).map((cell: any, i: number): Layer => {
      const c = cellRect(cell.bounds, box.W, box.H, gap), clip = radius > 0 ? roundedRing(c, radius) : rectRing(c), alpha = cellAlpha(cell, opacity);
      if (!cell.source?.url) return { image: fillLayer(size, m, [[clip]], EMPTY_CELL), alpha };
      const kind = cell.source.type === 'image' ? 'image' : 'video';
      let src = deps.source(item, cellSourceTime(cell, local), i);
      if (src && deps.exportColour) {
        if (cell.source.type === 'motionGraphic') src = transferImage(src, 'input');
        else if (kind === 'video') src = videoInput(src);
      }
      if (!src) throw Error(`layout ${item.id} cell ${i}: source unavailable`);
      return { image: drawRaster(size, src, cellMedia(kind, cell.fillMode, src.width, src.height, c, cell.zoom ?? 100, cell.panX ?? 0, cell.panY ?? 0), m, [[clip]]), alpha };
    });
  }
  throw Error(`item type ${item.type} not supported`);
}

// The frame-sized draw calls of one item (content, then border), each already filtered, faded and clipped, plus its blend mode.
export function itemDraws(project: Project, item: Item, t: number, deps: Deps, out: Size = projectSize(project)): { mode: string; draws: Image[] } {
  const ease = deps.ease ?? linear, local = t - item.display.from, pt = propertyTime(item, local), f = (k: string, d: any) => field(item, k, pt, d, ease);
  // textAnimation and renderMode are stored under details.* (agent tool results l.607); a properties entry is not the stored shape.
  if (item.properties?.textAnimation !== undefined) throw Error(`item ${item.id}: textAnimation is stored under details, not properties`);
  const mode: string = f('blendMode', 'normal'), opacity: number = f('opacity', 1), anim = item.details?.textAnimation ?? null;
  if (anim != null && item.type !== 'text' && item.type !== 'caption') throw Error(`${item.type} item ${item.id}: textAnimation is defined for text and caption items only (§56.1)`);
  if (item.type === 'audio' || opacity <= 0) return { mode, draws: [] };
  if (item.type === 'motionGraphic') { // default server render: a full-canvas stacked-alpha video; only the blend mode is carried (§53.3.4)
    const p = projectSize(project), decoded = deps.source(item, sourceTime(item, local, ease));
    const src = decoded && deps.exportColour ? transferImage(decoded, 'input') : decoded;
    return { mode, draws: src ? [drawRaster(out, src, stretch(p.width, p.height), frameScale(project, out, IDENTITY))] : [] };
  }
  // Step 6: the text-animation channels move, scale, rotate and skew the box and multiply the opacity (§56.3).
  const [box, alpha] = animated(item, anim, local, itemBox(project, item, pt, ease), opacity), M = frameScale(project, out, boxMatrix(box));
  if (!(Math.abs(M[0] * M[3] - M[1] * M[2]) > 0)) return { mode, draws: [] };
  // Part 4 §49.19: an image element whose first two targets differ from their bases gets a recolor pass first in its chain.
  const element = item.type === 'image' ? deps.element?.(item) ?? null : null;
  const ch = chains(item, pt, k => k in deps.cssFilters, ease, element?.palette?.length && recolorActive(element) ? element : null), ctx: EffectContext = { timeS: local / 1000, seed: deps.seed };
  for (const e of ch.gpu) if (!deps.effects[e.kind]) throw Error(`effect ${e.kind}: no implementation in deps.effects`);
  for (const c of ch.css) if (!cssFilter(deps, c.kind)) throw Error(`CSS filter ${c.kind}: no implementation in deps.cssFilters`);
  // The CSS chain sees the item past the frame edge (outside the item is transparent, outside the frame is not, §51.5):
  // the layers are drawn padded by the chain's reach, filtered, then cropped. The direct path has no CSS chain (pad 0).
  const pad = ch.css.reduce((s, c) => s + reach(c), 0), big = { width: out.width + 2 * pad, height: out.height + 2 * pad };
  const Mp: Mat = [M[0], M[1], M[2], M[3], M[4] + pad, M[5] + pad], states = textStates(item, anim, local);
  let layers: Layer[];
  if (ch.path === 'direct') layers = content(item, t, deps, out, M, box, alpha, states);
  else {
    const size = { width: Math.trunc(box.W), height: Math.trunc(box.H) };
    if (size.width <= 0 || size.height <= 0) return { mode, draws: [] };
    let canvas = createImage(size.width, size.height);
    // No item-canvas case for layouts (§53.4.5 quirk 1); shapes and captions set alpha = opacity on it (quirk 2).
    if (item.type !== 'layout') for (const l of content(item, t, deps, size, IDENTITY, box, alpha, states)) canvas = compositeImage(canvas, item.type === 'shape' || item.type === 'caption' ? scaleAlpha(l.image, l.alpha) : l.image, 'normal');
    for (const e of ch.gpu) canvas = deps.effects[e.kind](canvas, e.params, ctx);
    if (ch.gpu.length) canvas = quantise(canvas); // the last pass writes the 8-bit canvas
    const us = sourceUs(sourceTime(item, local, ease));
    const acc = maskAlpha(ch.masks, { W: size.width, H: size.height, propertyTimeMs: pt, sourceTimeUs: us, ease, raster: mask => deps.raster?.(item, mask, us) ?? null });
    if (acc) canvas = applyMask(canvas, acc);
    layers = [{ image: drawRaster(big, canvas, stretch(size.width, size.height), Mp), alpha }];
  }
  const bw: number = f('borderWidth', 0);
  if (bw > 0 && item.type !== 'text' && item.type !== 'caption') { // a centred rectangle stroke (miter corners), not masked
    const outer = { x: -bw / 2, y: -bw / 2, w: box.W + bw, h: box.H + bw }, inner = { x: bw / 2, y: bw / 2, w: box.W - bw, h: box.H - bw };
    layers.push({ image: fillLayer(big, Mp, [[rectRing(outer), ...(inner.w > 0 && inner.h > 0 ? [rectRing(inner).reverse()] : [])]], colour(f('borderColor', '#000000'))), alpha });
  }
  const radius: number = f('borderRadius', 0), clip = radius > 0 ? coverageOf(out, M, [[roundedRing(stretch(box.W, box.H), radius)]]) : null;
  return { mode, draws: layers.map(l => scaleAlpha(crop(ch.css.reduce((img, c) => cssFilter(deps, c.kind)!(img, c.params, ctx), l.image), pad, out), l.alpha, clip)) };
}

// One item through its whole path onto a transparent frame-sized canvas (default: project px). Its
// draws keep the blend mode, which against transparency acts as source-over (§58.4).
export function renderItem(project: Project, item: Item, timeMs: number, deps: Deps, out: Size = projectSize(project)): Image {
  const { mode, draws } = itemDraws(project, item, timeMs, deps, out);
  return draws.reduce((acc, d) => compositeImage(acc, d, mode), createImage(out.width, out.height));
}

// The export frame at timeline time timeMs (§53.0): opaque black, items bottom first, blended, at the output size.
export function renderFrame(project: Project, timeMs: number, deps: Deps, out: Size = projectSize(project)): Image {
  let frame = createImage(out.width, out.height, [0, 0, 0, 1]);
  const pairs = deps.transition?.(project, timeMs, (item, t) => renderItem(project, item, t, deps)) ?? [], done = new Set<TransitionDraw>(), p = projectSize(project);
  for (const track of drawTracks(project)) for (const item of trackItems(project, track.id)) {
    const pair = pairs.find(q => q.itemIds.includes(item.id));
    if (pair) {
      if (!done.has(pair)) { done.add(pair); frame = compositeImage(frame, drawRaster(out, pair.image, stretch(p.width, p.height), frameScale(project, out, IDENTITY)), 'normal'); }
      continue;
    }
    if (!isVisible(item, timeMs)) continue;
    const { mode, draws } = itemDraws(project, item, timeMs, deps, out);
    for (const d of draws) frame = compositeImage(frame, d, mode);
  }
  return deps.exportColour ? transferImage(frame, 'output') : frame;
}
