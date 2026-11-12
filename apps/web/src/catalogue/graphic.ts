// SPDX-License-Identifier: AGPL-3.0-only
// T22 the picture of a slot element. A text-slot element is stored as a text item and a media-slot element as a layout item
// (findings part 2 §33); each keeps the element's file as its asset. The render model draws that file as one image under
// the text, or over the cells, and the export checks it like any other image. The picture is the whole file stretched over
// the item's box, each axis by itself; the text sits inside the slot (reference compares part 6 §6.1 point 4, from Xapp's
// code, no stored output). Pure.
import type { RecordData } from '../store/model';
import { findElement } from './elements';

/** The image a slot element item draws besides its text or cells, as an image item with the parent's id (a failure names
 *  the parent). It fills the parent's box. known false = the catalogue no longer has the element. */
export function slotGraphic(item: RecordData): { item: RecordData; known: boolean } | null {
  const data = item.details?.element, assetId = item.metadata?.assetId;
  if (!data || (data.slot !== 'text' && data.slot !== 'media') || typeof assetId !== 'string') return null;
  const el = findElement(data.id);
  return { item: { id: item.id, type: 'image', trackId: item.trackId, display: item.display, details: { name: el?.name ?? String(data.id), element: data }, metadata: { assetId } },
    known: data.slot === 'media' ? !!el : el?.slot?.kind === 'text' };
}
/** Where the text of a text-slot element item is laid out, in px inside its box W × H: it wraps at the slot width and is
 *  centred vertically in the slot height. null = not a text-slot element. */
export type TextSlot = { x: number; y: number; W: number; H: number };
export function textSlot(item: RecordData, W: number, H: number): TextSlot | null {
  const data = item.details?.element, slot = data?.slot === 'text' ? findElement(data.id)?.slot : undefined;
  return slot?.kind === 'text' ? { x: slot.box.x * W, y: slot.box.y * H, W: slot.box.width * W, H: slot.box.height * H } : null;
}
