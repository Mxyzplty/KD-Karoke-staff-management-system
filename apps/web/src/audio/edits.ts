// SPDX-License-Identifier: AGPL-3.0-only
// T13's inspector edits. Fades are volume keyframes only (Xapp has no fade control; the shortcut is a documented
// improvement, stand-in SR-18): two keyframes through writeKeyframes, 0 at the clip's edge and the current value FADE_MS
// inside it. Keep pitch (§ T13 Speed and pitch): a per-clip switch, off by default, read by mix.ts keepsPitch.
// Provisional: FADE_MS (capped at half the clip), keepPitch stored as a top-level item field (absent when off).
import type { ProjectDocument } from '../store/model';
import { fail, item, span, trackLocked } from '../timeline/model';
import { REMAP_TYPES } from '../timeline/properties';
import { writeKeyframes } from '../timeline/edits';

export const FADE_MS = 1000;

export function addFade(doc: ProjectDocument, itemId: string, edge: 'in' | 'out') {
  const i = item(doc, itemId);
  if (!i) fail('ITEM_NOT_FOUND', 'Item not found');
  const len = Math.min(FADE_MS, span(i) / 2), { from, to } = i.display;
  const [outer, inner] = edge === 'in' ? [from, from + len] : [to, to - len];
  // The inner keyframe comes first: it captures the current value (no value given) before the edge keyframe exists.
  return writeKeyframes(doc, { itemId, payload: { volume: { add: [{ time: inner / 1000 }, { time: outer / 1000, value: 0 }] } } });
}

export function setKeepPitch(doc: ProjectDocument, itemId: string, on: boolean) {
  const i = item(doc, itemId);
  if (!i) fail('ITEM_NOT_FOUND', 'Item not found');
  if (!REMAP_TYPES.has(i.type)) fail('INVALID_ITEM_TYPE', `Keep pitch only applies to video and audio items, but '${i.id}' is type '${i.type}'.`);
  if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
  if (on) i.keepPitch = true; else delete i.keepPitch;
}
