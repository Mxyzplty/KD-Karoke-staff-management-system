// SPDX-License-Identifier: AGPL-3.0-only
// T22 element placement (findings part 2 §33): the item an element becomes and where it sits. A text slot gives a text
// item (font size = clamp(8…48, round(element height × slot height × 0.55)), #111111 / centre by default), a media slot a
// layout item whose cells are the openings, anything else an image item. Given bounds → scaled to fit, or stretched when
// the element allows it and both sides are given; no bounds → fitted into 60 % of the canvas width × 40 % of its height,
// centred. Times in ms; duration default 3 s. Pure.
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
  text?: { box: Box; fontSize: number; color: string; textAlign: string; fontFamily: string; fontWeight: number };
  cells?: Frac[];
}
export const ELEMENT_MS = 3000, ELEMENT_FIT = { width: 0.6, height: 0.4 };

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function placement(el: CatalogueElement, canvas: { width: number; height: number }, opts: PlaceOptions = {}): Placement {
  const from = opts.timelineStart ?? 0, length = opts.duration ?? ELEMENT_MS;
  if (!(from >= 0) || !Number.isFinite(from)) fail('INVALID_TIMELINE_START', `timelineStart must be >= 0. Received: ${fmt(from)}s.`);
  if (!(length > 0) || !Number.isFinite(length)) fail('INVALID_DURATION', `duration must be positive. Received: ${fmt(length)}s.`);
  const b = opts.bounds;
  let rect: Box, stretched = false;
  if (b) {
    const w = positive(b.width), h = positive(b.height);
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || (!w && !h)) fail('INVALID_BOUNDS', 'bounds requires finite x/y coordinates and at least one positive width or height.');
    if (el.stretch && w && h) { rect = { x: b.x, y: b.y, width: b.width!, height: b.height! }; stretched = true; }
    else {
      const s = Math.min(w ? b.width! / el.width : Infinity, h ? b.height! / el.height : Infinity);
      rect = { x: b.x, y: b.y, width: el.width * s, height: el.height * s };
    }
  } else {
    const s = Math.min(ELEMENT_FIT.width * canvas.width / el.width, ELEMENT_FIT.height * canvas.height / el.height);
    rect = { x: (canvas.width - el.width * s) / 2, y: (canvas.height - el.height * s) / 2, width: el.width * s, height: el.height * s };
  }
  const out: Placement = { type: el.slot?.kind === 'text' ? 'text' : el.slot?.kind === 'media' ? 'layout' : 'image', rect, stretched, display: { from, to: from + length } };
  if (el.slot?.kind === 'text') {
    const sl = el.slot, box = sl.box;
    out.text = { box: { x: rect.x + box.x * rect.width, y: rect.y + box.y * rect.height, width: box.width * rect.width, height: box.height * rect.height },
      fontSize: Math.min(48, Math.max(8, Math.round(rect.height * box.height * 0.55))), color: sl.color ?? '#111111', textAlign: sl.textAlign ?? 'center',
      fontFamily: sl.fontFamily, fontWeight: sl.fontWeight };
  }
  if (el.slot?.kind === 'media') out.cells = el.slot.openings.map(o => ({ ...o }));
  return out;
}

/** The stored item of one placed element. */
export function placeElement(el: CatalogueElement, canvas: { width: number; height: number }, opts: PlaceOptions & { trackId: string; assetId: string; name?: string }): RecordData {
  const p = placement(el, canvas, opts), { rect } = p, palette = el.palette.map(e => ({ ...e }));
  if (p.type === 'text') {
    const t = p.text!;
    const record = textRecord({ text: '', trackId: opts.trackId, display: p.display, details: { ...fontDetails(t.fontFamily, t.fontWeight), element: { id: el.id, palette, slot: 'text' } },
      properties: { positionX: t.box.x, positionY: t.box.y, width: t.box.width, height: t.box.height, fontSize: t.fontSize, fontWeight: t.fontWeight, color: t.color, textAlign: t.textAlign } });
    record.metadata = { assetId: opts.assetId };
    return record;
  }
  if (p.type === 'layout')
    return { id: newId('item'), type: 'layout', trackId: opts.trackId, display: p.display, details: { cells: p.cells!.map(newCell), element: { id: el.id, palette, slot: 'media' } },
      metadata: { assetId: opts.assetId },
      properties: storedProperties({ positionX: rect.x, positionY: rect.y, width: rect.width, height: rect.height, scale: 1, rotation: 0, opacity: 1 }) };
  const element: RecordData = { id: el.id, palette };
  if (el.pieces) element.pieces = el.pieces.map(x => ({ ...x }));
  if (el.stretch) element.stretch = true;
  return { id: newId('item'), type: 'image', trackId: opts.trackId, display: p.display, playbackRate: 1, details: { name: opts.name ?? el.name, element }, metadata: { assetId: opts.assetId },
    properties: storedProperties(p.stretched ? { width: rect.width, height: rect.height, scale: 1, positionX: rect.x, positionY: rect.y }
      : { width: el.width, height: el.height, scale: rect.width / el.width, positionX: rect.x, positionY: rect.y }),
    masks: [], effects: [] };
}
