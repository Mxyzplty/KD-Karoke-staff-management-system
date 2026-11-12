// SPDX-License-Identifier: AGPL-3.0-only
// T22 the picture of a slot element. A text-slot element is stored as a text item and a media-slot element as a layout item
// (findings part 2 §33); each keeps the element's file as its asset. The render model draws that file as one image under
// the text, or over the cells, and the export checks it like any other image. How Xapp draws it is not in §33 (notes R-5
// point 4, open question C-6). Pure.
import type { RecordData } from '../store/model';
import { findElement, type Frac } from './elements';

const WHOLE: Frac = { x: 0, y: 0, width: 1, height: 1 };
/** The image a slot element item draws besides its text or cells, as an image item with the parent's id (a failure names
 *  the parent), and the item's own box as fractions of the element box. box null = the catalogue no longer has the element. */
export function slotGraphic(item: RecordData): { item: RecordData; box: Frac | null } | null {
  const data = item.details?.element, assetId = item.metadata?.assetId;
  if (!data || (data.slot !== 'text' && data.slot !== 'media') || typeof assetId !== 'string') return null;
  const el = findElement(data.id), slot = el?.slot;
  return {
    item: { id: item.id, type: 'image', trackId: item.trackId, display: item.display, details: { name: el?.name ?? String(data.id), element: data }, metadata: { assetId } },
    box: data.slot === 'media' ? WHOLE : slot?.kind === 'text' ? slot.box : null,
  };
}
