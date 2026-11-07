// SPDX-License-Identifier: AGPL-3.0-only
// T12: the mask target of writeKeyframes (contracts writeKeyframes `maskIndex`; findings part 5 §54.8 7.3). Apart from tools.ts, which
// imports the edit module this file serves.
import type { RecordData } from '../store/model';
import { fail } from '../timeline/model';
import type { Keyframe } from '../timeline/properties';
import { MASK_KEYS, masksOf } from './model';
import type { MaskKey, StoredMask } from './model';

const show = (v: unknown) => v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
export const isMaskKey = (p: string): p is MaskKey => (MASK_KEYS as readonly string[]).includes(p);
/** The mask at an index, or NO_MASKS / INVALID_MASK_INDEX (results §2 removeMask). */
export function maskTarget(i: RecordData, index: unknown): StoredMask {
  const list = masksOf(i);
  if (!list.length) fail('NO_MASKS', 'No masks found', { message: `No masks found on '${i.id}'.` });
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= list.length)
    fail('INVALID_MASK_INDEX', 'Invalid mask index', { message: `Mask index ${show(index)} is out of range. Valid indices: 0-${list.length - 1}` });
  return list[index as number];
}
/** The stored keyframe track of feather, expansion or opacity, shaped as a property for writeKeyframes. */
export function maskProp(m: StoredMask, key: MaskKey): { defaultValue: number; keyframes: Keyframe[] } {
  const track = (m.keyframes ??= {})[key] ??= { keyframes: [] };
  return { get defaultValue() { return m[key]; }, get keyframes() { return track.keyframes; }, set keyframes(k) { track.keyframes = k; } };
}
