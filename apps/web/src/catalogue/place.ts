// SPDX-License-Identifier: AGPL-3.0-only
// T22 element placement (findings part 2 §33; the points §33 leaves open are settled from Xapp's code, reference compares
// part 6 §6.1, with no stored output behind them). A text slot gives a text item (font size = clamp(8…48, round(box height
// × slot height × 0.55)), #111111 / centre by default), a media slot a layout item whose cells are the openings, anything
// else an image item. Every item's box is the whole element box, at scale 1. Given bounds → scaled to fit with the top-left
// corner at the bounds origin and nothing rounded, or stretched when the element allows it and both sides are given; no
// bounds → fitted into 60 % of the canvas width × 40 % of its height and centred, the four values rounded one by one.
// Times in ms; duration default 3 s. Pure.
import type { RecordData } from '../store/model';
import { fontDetails, textRecord } from '../text/tools';
import { newCell } from '../timeline/layouts';
import { fail, fmt, newId } from '../timeline/model';
import { storedProperties } from '../timeline/properties';
import type { CatalogueElement, Frac } from './elements';

/** A box in canvas px. */
export type Box = { x: number; y: number; width: number; height: number };
export type PlaceOptions = { bounds?: { x: number; y: number; width?: number; height?: number }; timelineStart?: number; duration?: number };
export interface Placement {
  type: 'image' | 'text' | 'layout';
  /** Where the element box sits on the canvas. */
  rect: Box;
  stretched: boolean;
  display: { from: number; to: number };
  text?: { fontSize: number; color: string; textAlign: string; fontFamily: string; fontWeight: number };
  cells?: Frac[];
}
export const ELEMENT_MS = 3000, ELEMENT_FIT = { width: 0.6, height: 0.4 };

/** The item type an element becomes (§33): text slot → text, media slot → layout, else image. */
export const elementItemType = (el: CatalogueElement): Placement['type'] => el.slot?.kind === 'text' ? 'text' : el.slot?.kind === 'media' ? 'layout' : 'image';
/** A bounds side that constrains the fit. Infinity does not (as in T03's fitProperties, where min() drops it); bounds
 *  whose only side is Infinity are refused here, where T03 would store a non-finite scale. */
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
// ---- Three points §33's text does not settle (notes R-1..R-3), settled from code in part 6 §6.1. One place each.
/** R-1: a fitted element sits with its top-left corner at the bounds origin; the spare room is right or below. */
const fittedOrigin = (bounds: { x: number; y: number }) => ({ x: bounds.x, y: bounds.y });
/** R-2: the height is the box height after fitting, in canvas px, times the slot's share of it. Holds for the empty insert. */
const slotFontSize = (rect: Box, slot: Frac) => Math.min(48, Math.max(8, Math.round(rect.height * slot.height * 0.55)));
/** R-3: the natural size is the bounding box of the pieces. In every element of ours that box is the whole element
 *  (tests/t22-content), so it is the element's own width × height. */
const elementSize = (el: CatalogueElement) => ({ width: el.width, height: el.height });

export function placement(el: CatalogueElement, canvas: { width: number; height: number }, opts: PlaceOptions = {}): Placement {
  const from = opts.timelineStart ?? 0, length = opts.duration ?? ELEMENT_MS;
  if (!(from >= 0) || !Number.isFinite(from)) fail('INVALID_TIMELINE_START', `timelineStart must be >= 0. Received: ${fmt(from)}s.`);
  if (!(length > 0) || !Number.isFinite(length)) fail('INVALID_DURATION', `duration must be positive. Received: ${fmt(length)}s.`);
  const b = opts.bounds, size = elementSize(el);
  let rect: Box, stretched = false;
  if (b) {
    const w = positive(b.width), h = positive(b.height);
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || (!w && !h)) fail('INVALID_BOUNDS', 'bounds requires finite x/y coordinates and at least one positive width or height.');
    if (el.stretch && w && h) { rect = { x: b.x, y: b.y, width: b.width!, height: b.height! }; stretched = true; }
    else {
      const s = Math.min(w ? b.width! / size.width : Infinity, h ? b.height! / size.height : Infinity);
      rect = { ...fittedOrigin(b), width: size.width * s, height: size.height * s };
    }
  } else {
    const s = Math.min(ELEMENT_FIT.width * canvas.width / size.width, ELEMENT_FIT.height * canvas.height / size.height);
    const width = Math.round(size.width * s), height = Math.round(size.height * s);
    rect = { x: Math.round((canvas.width - width) / 2), y: Math.round((canvas.height - height) / 2), width, height };
  }
  const out: Placement = { type: elementItemType(el), rect, stretched, display: { from, to: from + length } };
  if (el.slot?.kind === 'text') {
    const sl = el.slot;
    out.text = { fontSize: slotFontSize(rect, sl.box), color: sl.color ?? '#111111', textAlign: sl.textAlign ?? 'center', fontFamily: sl.fontFamily, fontWeight: sl.fontWeight };
  }
  if (el.slot?.kind === 'media') out.cells = el.slot.openings.map(o => ({ ...o }));
  return out;
}

/** The stored item of one placed element. Its box is the element box: a text item lays its text out inside the slot
 *  (catalogue/graphic.ts textSlot), a layout item is of type `element` with no gap and square corners. */
export function placeElement(el: CatalogueElement, canvas: { width: number; height: number }, opts: PlaceOptions & { trackId: string; assetId: string; name?: string }): RecordData {
  const p = placement(el, canvas, opts), { rect } = p, palette = el.palette.map(e => ({ ...e }));
  if (p.type === 'text') {
    const t = p.text!;
    const record = textRecord({ text: '', trackId: opts.trackId, display: p.display, details: { ...fontDetails(t.fontFamily, t.fontWeight), element: { id: el.id, palette, slot: 'text' } },
      properties: { positionX: rect.x, positionY: rect.y, width: rect.width, height: rect.height, fontSize: t.fontSize, fontWeight: t.fontWeight, color: t.color, textAlign: t.textAlign } });
    record.metadata = { assetId: opts.assetId };
    return record;
  }
  if (p.type === 'layout')
    return { id: newId('item'), type: 'layout', trackId: opts.trackId, display: p.display, details: { layoutType: 'element', gap: 0, borderRadius: 0, cells: p.cells!.map(newCell), element: { id: el.id, palette, slot: 'media' } },
      metadata: { assetId: opts.assetId },
      properties: storedProperties({ positionX: rect.x, positionY: rect.y, width: rect.width, height: rect.height, scale: 1, rotation: 0, opacity: 1 }) };
  const element: RecordData = { id: el.id, palette };
  if (el.pieces) element.pieces = el.pieces.map(x => ({ ...x }));
  if (el.stretch) element.stretch = true;
  return { id: newId('item'), type: 'image', trackId: opts.trackId, display: p.display, playbackRate: 1, details: { name: opts.name ?? el.name, element }, metadata: { assetId: opts.assetId },
    properties: storedProperties({ width: rect.width, height: rect.height, scale: 1, positionX: rect.x, positionY: rect.y }),
    masks: [], effects: [] };
}
