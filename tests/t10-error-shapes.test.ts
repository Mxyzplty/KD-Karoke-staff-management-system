// SPDX-License-Identifier: AGPL-3.0-only
// T10 error shapes (fix round 3, B4): one row per T10 code, the WHOLE response compared, not the code alone. toStrictEqual
// rather than toEqual, so a `message: undefined` key would also fail the R2 row.
// Oracle: error codes §7 l.180–193 (writeEffects), §6 l.171 (writeKeyframes UNKNOWN_PARAMETER). R1 = {success:false, code,
// error, message}; R2 = {success:false, code, error} with no `message` key (INVALID_EFFECT_TARGETS). The "<list>" parts are
// built from the registry (discoverable ids, item types); every other word is the §7 template. A refused call leaves the
// document, the undo stack and the journal as they were.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { addEffect } from '../apps/web/src/timeline/effects';
import { CommandError } from '../apps/web/src/timeline/model';
import { discoverable, discoverableIds } from '../apps/web/src/effects/queries';
import { build, mkItem, mkTrack, resetIds, video } from './t03-fixtures';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T08:00:00.000Z')); });
afterEach(() => { resetIds(); vi.useRealTimers(); });

const base = (): ProjectDocument => build({
  tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('A1', 'audio'), mkTrack('L1', 'video', { locked: true })],
  items: [video('v1', 'V1', 0, 4000), video('v2', 'V1', 4000, 8000), mkItem('t1', 'O1', 0, 2000, { type: 'text', details: { text: 'Hi' } }),
    mkItem('a1', 'A1', 0, 3000, { type: 'audio', trim: { from: 0, to: 3000 }, sourceDuration: 8000, metadata: { assetId: 'asset-aud1' } }),
    video('locked', 'L1', 0, 2000)],
});
/** v1 holds one grayscale instance (agent id grayscale_1); every other item has no effects. */
const editor = () => {
  const e = createEditor(base());
  expect(e.call('writeEffects', { itemId: 'v1', add: [{ effectId: 'grayscale' }] })).toMatchObject({ success: true });
  return e;
};
const json = (d: unknown) => JSON.stringify(d);
const AUDIO = "'audio' items don't support effects. Effects work on: video, image, text, shape, motionGraphic."; // the §7 list itself (n6): a change to EFFECT_ITEM_TYPES fails
const textSupported = discoverable().filter(d => d.itemTypes.includes('text')).map(d => d.id).join(', ');

type Row = [code: string, tool: 'writeEffects' | 'writeKeyframes', args: Record<string, unknown>, expected: Record<string, unknown>];
const ROWS: Row[] = [
  ['EMPTY_PAYLOAD', 'writeEffects', { itemId: 'v1' },
    { success: false, code: 'EMPTY_PAYLOAD', error: 'Empty payload', message: 'writeEffects needs `add` (new effects) and/or `effects` (per-effect edits).' }],
  ['INVALID_EFFECT_ID_FORMAT', 'writeEffects', { itemId: 'v1', effects: { vignette: { enabled: false } } },
    { success: false, code: 'INVALID_EFFECT_ID_FORMAT', error: 'Invalid effect id', message: "'vignette' invalid. Expected effectName_stackPosition (e.g. 'vignette_1')." }],
  ['EFFECT_NOT_FOUND', 'writeEffects', { itemId: 'v1', effects: { vignette_1: { enabled: false } } },
    { success: false, code: 'EFFECT_NOT_FOUND', error: 'Effect not found', message: "Effect 'vignette_1' not on this item. Available: grayscale_1" }],
  ['UNKNOWN_PARAMETERS', 'writeEffects', { itemId: 'v1', effects: { grayscale_1: { params: { nope: 1, also: 2 } } } },
    { success: false, code: 'UNKNOWN_PARAMETERS', error: 'Unknown parameters', message: "On 'grayscale': unknown parameter(s) nope, also. Valid: amount" }],
  ['INVALID_PARAM_VALUE', 'writeEffects', { itemId: 'v1', effects: { grayscale_1: { params: { amount: 101 } } } },
    { success: false, code: 'INVALID_PARAM_VALUE', error: 'Invalid parameter value', message: "On 'grayscale': 'amount' must be between 0 and 100, got 101" }],
  ['INVALID_ADD', 'writeEffects', { itemId: 'v1', add: [{}] },
    { success: false, code: 'INVALID_ADD', error: 'Invalid add entry', message: 'Each add entry needs `effectId` (string).' }],
  ['UNKNOWN_EFFECT', 'writeEffects', { itemId: 'v1', add: [{ effectId: 'nope' }] },
    { success: false, code: 'UNKNOWN_EFFECT', error: 'Unknown effect', message: `Effect 'nope' not found. Available: ${discoverableIds().join(', ')}` }],
  ['EFFECT_DEPRECATED', 'writeEffects', { itemId: 'v1', add: [{ effectId: 'lumetri-color' }] },
    { success: false, code: 'EFFECT_DEPRECATED', error: 'Effect deprecated',
      message: "'lumetri-color' is retired and can't be newly added. Existing instances remain editable. Use Color Wheels, Levels or Curves instead." }],
  ['EFFECT_NOT_SUPPORTED', 'writeEffects', { itemId: 't1', add: [{ effectId: 'sepia' }] },
    { success: false, code: 'EFFECT_NOT_SUPPORTED', error: 'Effect not supported', message: `'text' doesn't support 'sepia'. Supported: ${textSupported}.` }],
  ['UNSUPPORTED_ITEM_TYPE', 'writeEffects', { itemId: 'a1', add: [{ effectId: 'sepia' }] },
    { success: false, code: 'UNSUPPORTED_ITEM_TYPE', error: 'Unsupported item type', message: AUDIO }],
  // R2: no `message` key at all (error codes §7 l.191).
  ['INVALID_EFFECT_TARGETS', 'writeEffects', { add: [{ effectId: 'sepia' }] },
    { success: false, code: 'INVALID_EFFECT_TARGETS', error: 'Provide exactly one of itemId or itemIds' }],
  ['UNKNOWN_PARAMETER', 'writeKeyframes', { itemId: 'v1', effectId: 'grayscale_1', payload: { nope: { add: [{ time: 0, value: 1 }] } } },
    { success: false, code: 'UNKNOWN_PARAMETER', error: 'Unknown parameter', message: "Parameter 'nope' not on effect 'grayscale_1'. Valid: amount" }],
  // Multi-item (itemIds): the first failure's code on top, every failing item in failures[] with its own R1 fields; an item
  // whose refusal has no message (TRACK_LOCKED) lists without the key and contributes its `error` to the top message.
  ['failures[] (itemIds)', 'writeEffects', { itemIds: ['v1', 'a1', 'locked'], add: [{ effectId: 'sepia' }] },
    { success: false, code: 'UNSUPPORTED_ITEM_TYPE', error: '2 item(s) failed effect validation',
      message: `No effects were changed. a1: ${AUDIO} locked: Track L1 is locked`,
      failures: [{ itemId: 'a1', code: 'UNSUPPORTED_ITEM_TYPE', error: 'Unsupported item type', message: AUDIO }, { itemId: 'locked', code: 'TRACK_LOCKED', error: 'Track L1 is locked' }] }],
];

describe('T10 error shapes: agent tools (whole response, error codes §7)', () => {
  it.each(ROWS)('%s via %s', (_code, tool, args, expected) => {
    const e = editor(), before = json(e.doc), n = e.bus.undoStack.length, j = e.journal.length;
    expect(e.call(tool, args)).toStrictEqual(expected);
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n); expect(e.journal).toHaveLength(j);
  });
});

/** The UI addEffect helper is not an agent tool, so callTool never wraps it; this maps its CommandError exactly as callTool
 *  does (tools.ts l.221–222: code, error, then `message` only when present). */
const helperShape = (fn: () => void): Record<string, unknown> => {
  try { fn(); } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    return { success: false, code: err.code, error: err.error, ...(err.extra.message !== undefined ? { message: err.extra.message } : {}) };
  }
  throw new Error('expected a refusal');
};
type HelperRow = [code: string, itemIds: string[], effectId: string, expected: Record<string, unknown>, outcome: string];
const HELPER_ROWS: HelperRow[] = [
  // error codes §7 l.193: the add itself failing; the cause in `message`.
  ['ADD_EFFECT_FAILED', ['locked'], 'sepia',
    { success: false, code: 'ADD_EFFECT_FAILED', error: 'Failed to add effect', message: 'Track L1 is locked' }, 'Failed to add effect Track L1 is locked'],
  // The helper's own checks keep their codes (notes, question 11). ITEM_NOT_FOUND has no message.
  ['ITEM_NOT_FOUND', ['ghost'], 'sepia', { success: false, code: 'ITEM_NOT_FOUND', error: "Item 'ghost' not found" }, "Item 'ghost' not found"],
  ['UNKNOWN_EFFECT (retired, intent)', ['v1'], 'lumetri-color',
    { success: false, code: 'UNKNOWN_EFFECT', error: 'Unknown effect', message: "Effect 'lumetri-color' is deprecated. Use Color Wheels, Levels or Curves instead." },
    "Unknown effect Effect 'lumetri-color' is deprecated. Use Color Wheels, Levels or Curves instead."],
];

describe('T10 error shapes: the UI addEffect helper and its intent outcome', () => {
  it.each(HELPER_ROWS)('%s', (_code, itemIds, effectId, expected, outcome) => {
    expect(helperShape(() => addEffect(base(), itemIds, effectId))).toStrictEqual(expected);
    const e = editor(), before = json(e.doc), n = e.bus.undoStack.length;
    expect(e.intent({ type: 'addEffect', itemIds, effectId })).toStrictEqual({ ok: false, code: expected.code, message: outcome });
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n);
  });
});
