// SPDX-License-Identifier: AGPL-3.0-only
// T03 item operations through the agent tools (seconds) and the UI intents (ms), plus two-path parity.
// Oracle: ticket § T03; agent tool results §2 (addMedia l.169, changeTrack l.364, cloneItem l.389, deleteItems l.579, moveItem l.990, reorderItems l.1041,
// slipItem l.1174, trimItem l.1269) and §5 G-01; findings part 3 §45.1–§45.4; part 2 §37 (ripple), §41b (split/transform), §41c (captions exempt from ripple).
// Provisional (T03 command path notes): added error codes (INVALID_COMBINATION, MISSING_TRACK_ID, MIXED_MEDIA_KINDS, NO_ITEMS, VALIDATION_FAILED, OVERLAP_DETECTED,
// MISSING_ITEM_IDS, MISSING_PARAM, GROUP_NOT_FOUND, slip codes, TRIM_AT_LIMIT), the slip intent sign, "Ripple reorder", the changeTrack from/to/message fields.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { paste } from '../apps/web/src/timeline/items';
import { assets, build, fixture, grouped, itemOf, links, mkItem, mkTrack, resetIds, span, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => resetIds());

type Editor = ReturnType<typeof editor>;
const editor = (doc: ProjectDocument = fixture()) => createEditor(doc, { assets: assets(), links: links() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (e: Editor, name: string, args: Record<string, unknown>): any => e.call(name, args);
const json = (d: unknown) => JSON.stringify(d);
const only = (e: Editor, label: string, source = 'agent') => {
  expect(e.bus.undoStack).toHaveLength(1);
  expect(e.bus.undoStack[0]).toMatchObject({ label, source });
  expect(e.journal).toHaveLength(1);
};
/** a failed call: success false, document byte-identical, no entry, no journal record, no timelineChanges. */
const refused = (e: Editor, before: string, r: { success: boolean; timelineChanges?: unknown }) => {
  expect(r.success).toBe(false); expect(r.timelineChanges).toBeUndefined();
  expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
};
const lock = (doc: ProjectDocument, id: string) => { doc.tracks.find(t => t.id === id)!.locked = true; return doc; };
const ids = (e: Editor, trackId: string) => e.doc.items.filter(i => i.trackId === trackId).map(i => i.id);

describe('addMedia (results §2 addMedia l.169)', () => {
  it('chains items back-to-back from timelineStart; video trim defaults to the whole source; one "Add media" step; message plural/singular', () => {
    const e = editor();
    const r = call(e, 'addMedia', { trackId: 'V2', timelineStart: 2, items: [{ assetId: 'video_1' }, { assetId: 'video_2' }] });
    expect(r.success).toBe(true); expect(r.message).toBe('Successfully added 2 media items to timeline');
    expect(r.data.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(r.data.results.map((x: { assetId: string; success: boolean }) => [x.assetId, x.success])).toEqual([['video_1', true], ['video_2', true]]);
    expect(r.data.results[0].resolvedTrim).toEqual({ start: 0, end: 10, duration: 10 });
    expect(r.data.results[1].resolvedTrim).toEqual({ start: 0, end: 6, duration: 6 });
    expect(r.data.addedItemIds).toEqual(ids(e, 'V2'));
    const [a, b] = ids(e, 'V2').map(id => itemOf(e.doc, id));
    expect([a.display, b.display]).toEqual([{ from: 2000, to: 12000 }, { from: 12000, to: 18000 }]);
    expect([a.trim, b.trim]).toEqual([{ from: 0, to: 10000 }, { from: 0, to: 6000 }]);
    expect(a.metadata.assetId).toBe('asset-vid1'); expect(a.type).toBe('video');
    only(e, 'Add media');
    expect(r.timelineChanges.items.created).toHaveLength(2);
  });
  it('single mode (assetId) returns the same batch shape with singular wording', () => {
    const e = editor();
    const r = call(e, 'addMedia', { trackId: 'V2', timelineStart: 0, assetId: 'video_2', trimStart: 1, trimEnd: 4 });
    expect(r.message).toBe('Successfully added 1 media item to timeline');
    expect(r.data.results[0].resolvedTrim).toEqual({ start: 1, end: 4, duration: 3 });
    expect(span(e.doc, r.data.addedItemIds[0])).toEqual([0, 3000]);
  });
  it('images are 3 s through the tool and carry no resolvedTrim', () => {
    const e = editor();
    const r = call(e, 'addMedia', { trackId: 'V2', timelineStart: 1, items: [{ assetId: 'image_1' }] });
    expect(r.success).toBe(true); expect(r.data.results[0].resolvedTrim).toBeUndefined();
    expect(itemOf(e.doc, r.data.addedItemIds[0]).display).toEqual({ from: 1000, to: 4000 }); expect(itemOf(e.doc, r.data.addedItemIds[0]).type).toBe('image');
  });
  it('a video with unknown source length gets 5 s: resolvedTrim {0,5}', () => {
    const e = editor();
    const r = call(e, 'addMedia', { trackId: 'V2', timelineStart: 0, items: [{ assetId: 'video_4' }] });
    expect(r.data.results[0].resolvedTrim).toEqual({ start: 0, end: 5, duration: 5 });
    expect(span(e.doc, r.data.addedItemIds[0])).toEqual([0, 5000]);
  });
  it('audio goes on an audio track', () => {
    const e = editor();
    const r = call(e, 'addMedia', { trackId: 'A1', timelineStart: 6, items: [{ assetId: 'audio_1' }] });
    expect(r.success).toBe(true); expect(itemOf(e.doc, r.data.addedItemIds[0])).toMatchObject({ type: 'audio', trackId: 'A1', display: { from: 6000, to: 14000 } });
  });
  it('duration follows the content end after an add (G-01)', () => {
    const e = editor(); call(e, 'addMedia', { trackId: 'V2', timelineStart: 20, items: [{ assetId: 'video_1' }] });
    expect(e.doc.duration).toBe(30000);
  });
  it('insertAfterItemId: starts at the reference end, pushes later items right, one "Insert items" step', () => {
    const e = editor();
    const r = call(e, 'addMedia', { insertAfterItemId: 'v1', items: [{ assetId: 'video_2' }] }); // 6 s clip after v1 (ends 4 s)
    expect(r.success).toBe(true);
    const nid = r.data.addedItemIds[0];
    expect(span(e.doc, nid)).toEqual([4000, 10000]);
    expect(span(e.doc, 'v2')).toEqual([10000, 14000]); expect(span(e.doc, 'v3')).toEqual([16000, 18000]); // later items on the track shift by 6 s
    expect(span(e.doc, 'v1')).toEqual([0, 4000]);
    expect(e.doc.items.find(i => i.id === nid)!.trackId).toBe('V1');
    only(e, 'Insert items');
    expect(r.timelineChanges.items.updated.map((u: { itemId: string }) => u.itemId).sort()).toEqual(['v2', 'v3']);
    expect(r.timelineChanges.items.updated[0].changedFields).toContain('display');
  });
  // ---- failures in the order of results §2 (nothing is added; document byte-identical; no entry; no journal)
  const failCase = (name: string, args: Record<string, unknown>, expected: Record<string, unknown>, doc?: () => ProjectDocument) =>
    it(`failure: ${name}`, () => {
      const e = editor(doc?.()); const before = json(e.doc);
      const r = call(e, 'addMedia', args);
      expect(r).toMatchObject({ success: false, ...expected }); refused(e, before, r);
    });
  failCase('insertAfter with trackId/timelineStart (1st check)', { insertAfterItemId: 'v1', trackId: 'V1', timelineStart: 1, items: [{ assetId: 'video_1' }] },
    { code: 'INVALID_COMBINATION', error: 'insertAfter cannot be used with trackId, timelineStart. Use insertAfterItemId alone, or trackId with timelineStart.' });
  failCase('insertAfter item not found', { insertAfterItemId: 'nope', items: [{ assetId: 'video_1' }] },
    { code: 'INSERT_AFTER_NOT_FOUND', error: 'insertAfter item not found', message: "Item 'nope' not found on the timeline. Read context for current item ids." });
  failCase('insertAfter type mismatch (video after an audio item)', { insertAfterItemId: 'a1', items: [{ assetId: 'video_1' }] },
    { code: 'INSERT_AFTER_TYPE_MISMATCH', error: 'insertAfter type mismatch', message: "Cannot insert video after audio item 'a1'. The new item requires a compatible track kind." });
  failCase('no trackId', { items: [{ assetId: 'video_1' }] },
    { code: 'MISSING_TRACK_ID', error: 'trackId is required. Use context() for stable track ids or create a track explicitly with manageTrack.' });
  failCase('transcriptRange is deferred to T19', { trackId: 'V2', items: [{ assetId: 'video_1', transcriptRange: { text: 'x' } }] },
    { code: 'NOT_IMPLEMENTED', error: 'transcriptRange is not yet implemented (T19).' });
  failCase('empty batch', { trackId: 'V2', items: [] },
    { code: 'NO_ITEMS', error: 'No items provided', message: 'items array must contain at least one item.' });
  failCase('audio mixed with visual media', { trackId: 'V2', items: [{ assetId: 'audio_1' }, { assetId: 'video_1' }] },
    { code: 'MIXED_MEDIA_KINDS', error: 'Audio cannot share a call with visual media (found audio, video). Place audio in a separate call on an audio track.',
      message: 'Audio cannot share a call with visual media (found audio, video). Place audio in a separate call on an audio track.' });
  failCase('per-item validation: unknown asset keeps its own code and the hint for N-style ids', { trackId: 'V2', items: [{ assetId: 'video_1' }, { assetId: 'video_9' }] },
    { code: 'VALIDATION_FAILED', error: '1 item(s) failed validation', message: "video_9: Media asset not found 'video_9' is not in this project; the user may have removed it.",
      data: { failures: [{ assetId: 'video_9', code: 'MEDIA_NOT_FOUND', error: "Media asset not found 'video_9' is not in this project; the user may have removed it." }] } });
  failCase('per-item validation: a timeline id instead of an asset id', { trackId: 'V2', items: [{ assetId: 'v1' }] },
    { code: 'VALIDATION_FAILED', data: { failures: [{ assetId: 'v1', code: 'TIMELINE_ID_NOT_ALLOWED', error: "Expected asset ID (e.g., 'video_1') but received timeline ID 'v1'." }] } });
  failCase('per-item validation: asset without a usable source', { trackId: 'V2', items: [{ assetId: 'video_3' }] },
    { code: 'VALIDATION_FAILED', data: { failures: [{ assetId: 'video_3', code: 'INVALID_ASSET_URL', error: "Asset 'video_3' does not have a valid source URL." }] } });
  failCase('per-item validation: trim beyond the source', { trackId: 'V2', items: [{ assetId: 'video_2', trimStart: 0, trimEnd: 99 }] },
    { code: 'VALIDATION_FAILED', data: { failures: [expect.objectContaining({ assetId: 'video_2', code: 'TRIM_EXCEEDS_SOURCE' })] } });
  failCase('per-item validation: bounds combined with scaleMode', { trackId: 'V2', items: [{ assetId: 'video_1', bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleMode: 'fit' }] },
    { code: 'VALIDATION_FAILED', data: { failures: [expect.objectContaining({ assetId: 'video_1', code: 'INVALID_COMBINATION' })] } });
  failCase('wrong track kind', { trackId: 'A1', items: [{ assetId: 'video_1' }] },
    { code: 'INVALID_TRACK', error: "Cannot place video items on track 'A1'", message: 'Compatible unlocked video tracks: V1, V2.' });
  failCase('unknown track id', { trackId: 'zzz', items: [{ assetId: 'video_1' }] },
    { code: 'INVALID_TRACK', error: "Cannot place video items on track 'zzz'" });
  failCase('no unlocked track of the kind', { trackId: 'A1', items: [{ assetId: 'video_1' }] },
    { code: 'INVALID_TRACK', message: 'There is no unlocked video track; create one with manageTrack.' }, () => lock(lock(fixture(), 'V1'), 'V2'));
  failCase('locked track', { trackId: 'V2', items: [{ assetId: 'video_1' }] }, { code: 'TRACK_LOCKED', error: 'Track V2 is locked' }, () => lock(fixture(), 'V2'));
  failCase('overlap with items already on the track names the first free start', { trackId: 'V1', timelineStart: 1, items: [{ assetId: 'video_2' }] },
    { code: 'OVERLAP_DETECTED', error: 'Overlap detected on V1', message: 'video_2 at 1s–7s overlaps v1 (0s–4s). The first free start for this length is 12s.',
      data: { overlaps: [{ assetId: 'video_2', timeRange: '1s–7s', conflictingItem: 'v1', conflictRange: '0s–4s' }] } });
});

describe('moveItem (results §2 moveItem l.990)', () => {
  it('by: moves one item, label "Move item", data lists {itemId, trackId, from, to} in seconds', () => {
    const e = editor(); const r = call(e, 'moveItem', { itemId: 'v3', by: 1 });
    expect(r.success).toBe(true); expect(span(e.doc, 'v3')).toEqual([11000, 13000]);
    expect(r.data.items).toEqual([{ itemId: 'v3', trackId: 'V1', from: 11, to: 13 }]);
    only(e, 'Move item'); expect(r.timelineChanges.items.updated[0]).toMatchObject({ itemId: 'v3', changedFields: ['display'] });
  });
  it('to (absolute) for one item; a batch with by uses "Move items"', () => {
    const e = editor(); call(e, 'moveItem', { itemId: 'v3', to: 20 }); expect(span(e.doc, 'v3')).toEqual([20000, 22000]);
    const f = editor(); const r = call(f, 'moveItem', { itemIds: ['v3', 'a1'], by: 2 });
    expect([span(f.doc, 'v3'), span(f.doc, 'a1')]).toEqual([[12000, 14000], [2000, 7000]]); only(f, 'Move items'); expect(r.data.items).toHaveLength(2);
  });
  it('trackId moves between compatible tracks at the same time; incompatible → TRACK_INCOMPATIBLE', () => {
    const e = editor(); const r = call(e, 'moveItem', { itemId: 'v3', trackId: 'V2' });
    expect(r.success).toBe(true); expect(itemOf(e.doc, 'v3')).toMatchObject({ trackId: 'V2', display: { from: 10000, to: 12000 } }); only(e, 'Move item');
    const f = editor(); const before = json(f.doc); const x = call(f, 'moveItem', { itemId: 'v3', trackId: 'A1' });
    expect(x.error).toBe('Move failed: TRACK_INCOMPATIBLE'); refused(f, before, x);
  });
  it('collision → COLLISION and the whole move is refused (all-or-nothing)', () => {
    const e = editor(); const before = json(e.doc);
    const r = call(e, 'moveItem', { itemIds: ['v3', 'v1'], by: 1 }); // v3 fits, v1 would overlap v2
    expect(r.error).toContain('Move failed: COLLISION'); expect(JSON.stringify(r)).toContain('COLLISION'); refused(e, before, r);
    expect(span(e.doc, 'v3')).toEqual([10000, 12000]);
  });
  it('moving onto a locked track / of a locked item → TRACK_LOCKED; unknown track → TRACK_NOT_FOUND', () => {
    const e = editor(lock(fixture(), 'V2')); const before = json(e.doc);
    expect(call(e, 'moveItem', { itemId: 'v3', trackId: 'V2' }).error).toBe('Move failed: TRACK_LOCKED'); expect(e.bus.undoStack).toHaveLength(0);
    const f = editor(lock(fixture(), 'V1')); expect(call(f, 'moveItem', { itemId: 'v3', by: 1 }).error).toBe('Move failed: TRACK_LOCKED');
    const g = editor(); const r = call(g, 'moveItem', { itemId: 'v3', trackId: 'nope' }); expect(r.error).toBe('Move failed: TRACK_NOT_FOUND'); void before;
  });
  it('unknown item ids cancel the move and name them', () => {
    const e = editor(); const before = json(e.doc); const r = call(e, 'moveItem', { itemIds: ['v3', 'ghost'], by: 1 });
    expect(r).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND', error: 'Move cancelled; these item IDs are not on the timeline: ghost. A caption linked to a deleted clip is deleted with it; read context again.' }); refused(e, before, r);
  });
  it('parameter errors', () => {
    const e = editor();
    expect(call(e, 'moveItem', { by: 1 })).toMatchObject({ success: false, code: 'MISSING_ITEM_IDS', error: 'itemId or itemIds is required' });
    expect(call(e, 'moveItem', { itemId: 'v3', beforeItemId: 'v1', afterItemId: 'v2' })).toMatchObject({ code: 'INVALID_COMBINATION', error: 'Provide beforeItemId or afterItemId, not both' });
    expect(call(e, 'moveItem', { itemIds: ['v3', 'a1'], to: 3 })).toMatchObject({ code: 'INVALID_COMBINATION', error: 'Absolute to is only valid for one item; use by for a batch' });
    expect(call(e, 'moveItem', { itemId: 'v3' })).toMatchObject({ code: 'MISSING_PARAM', error: 'Provide by, to, trackId, beforeItemId, or afterItemId' });
    expect(call(e, 'moveItem', { itemId: 'v3', by: Infinity })).toMatchObject({ code: 'INVALID_MOVE', error: 'Move must be finite' });
    expect(e.bus.undoStack).toHaveLength(0);
  });
  it('groupId + by moves every item of every member track ("Move group"); only groupId and by are allowed', () => {
    const e = editor(grouped()); const r = call(e, 'moveItem', { groupId: 'g1', by: 1 });
    expect(r).toMatchObject({ success: true, data: { groupId: 'g1', by: 1 } });
    expect(['v1', 'v2', 'w1', 'w2', 'v3'].map(id => span(e.doc, id))).toEqual([[1000, 5000], [5000, 9000], [1000, 4000], [6000, 10000], [11000, 13000]]);
    expect(span(e.doc, 't1')).toEqual([1000, 3000]); // other tracks are left alone
    only(e, 'Move group');
    const f = editor(grouped());
    expect(call(f, 'moveItem', { groupId: 'g1', by: 1, itemId: 'v1' })).toMatchObject({ code: 'INVALID_COMBINATION', error: 'Group moves require only groupId and by (seconds)' });
    expect(call(f, 'moveItem', { groupId: 'g1' })).toMatchObject({ code: 'INVALID_COMBINATION' });
  });
  it('group moves: before the timeline start, unknown group and locked group are refused without a change', () => {
    const e = editor(grouped()); const before = json(e.doc);
    const r = call(e, 'moveItem', { groupId: 'g1', by: -1 });
    expect(r).toMatchObject({ success: false, code: 'GROUP_BEFORE_START', error: 'Group cannot move before timeline start', operationMayHaveRun: false }); refused(e, before, r);
    expect(call(e, 'moveItem', { groupId: 'nope', by: 1 })).toMatchObject({ success: false, code: 'GROUP_NOT_FOUND' });
    const f = editor(grouped()); f.doc.groups.g1.locked = true;
    expect(call(f, 'moveItem', { groupId: 'g1', by: 1 })).toMatchObject({ success: false, code: 'TRACK_LOCKED', error: 'Group is locked', operationMayHaveRun: false });
  });
});

describe('reorderItems / moveItem before|after (results §2 reorderItems l.1041; findings part 2 §37)', () => {
  it('beforeItemId: closes the gap left behind, opens one at the anchor, places the selection ("Ripple reorder")', () => {
    const e = editor(); const r = call(e, 'reorderItems', { itemIds: ['v2'], beforeItemId: 'v1' });
    expect(r).toMatchObject({ success: true, data: { itemIds: ['v2'] } });
    expect([span(e.doc, 'v2'), span(e.doc, 'v1'), span(e.doc, 'v3')]).toEqual([[0, 4000], [4000, 8000], [10000, 12000]]);
    only(e, 'Ripple reorder');
  });
  it('afterItemId through moveItem delegates to reorderItems', () => {
    const e = editor(); const r = call(e, 'moveItem', { itemId: 'v1', afterItemId: 'v2' });
    expect(r.success).toBe(true); expect([span(e.doc, 'v2'), span(e.doc, 'v1')]).toEqual([[0, 4000], [4000, 8000]]); only(e, 'Ripple reorder');
  });
  it('a contiguous multi-selection moves as a block', () => {
    const e = editor(); call(e, 'reorderItems', { itemIds: ['v1', 'v2'], afterItemId: 'v3' });
    expect([span(e.doc, 'v3'), span(e.doc, 'v1'), span(e.doc, 'v2')]).toEqual([[2000, 4000], [4000, 8000], [8000, 12000]].map(x => x)); // v3's gap closes, block placed at its end
  });
  it('failure codes (error text "Reorder failed: <CODE>")', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['ITEM_NOT_FOUND', { itemIds: ['ghost'], beforeItemId: 'v1' }], ['MIXED_TRACKS', { itemIds: ['v1', 'a1'], beforeItemId: 'v3' }],
      ['TARGET_INVALID', { itemIds: ['v1'], beforeItemId: 'v1' }], ['TARGET_INCOMPATIBLE', { itemIds: ['v1'], beforeItemId: 'a1' }],
      ['NON_CONTIGUOUS', { itemIds: ['v1', 'v3'], afterItemId: 'v2' }],
    ];
    for (const [code, args] of cases) {
      const e = editor(); const before = json(e.doc); const r = call(e, 'reorderItems', args);
      expect(r.error, code).toBe(`Reorder failed: ${code}`); refused(e, before, r);
    }
    const e = editor(lock(fixture(), 'V1')); expect(call(e, 'reorderItems', { itemIds: ['v2'], beforeItemId: 'v1' }).error).toBe('Reorder failed: TRACK_LOCKED');
    const f = editor();
    expect(call(f, 'reorderItems', { beforeItemId: 'v1' })).toMatchObject({ code: 'MISSING_ITEM_IDS', error: 'itemIds is required' });
    expect(call(f, 'reorderItems', { itemIds: ['v2'] })).toMatchObject({ code: 'INVALID_COMBINATION', error: 'Provide exactly one of beforeItemId or afterItemId' });
  });
});

describe('changeTrack (results §2 changeTrack l.364)', () => {
  it('moves one item to another compatible track keeping the time; "Move items"; data and message', () => {
    const e = editor(); const r = call(e, 'changeTrack', { itemId: 'v3', trackId: 'V2' });
    expect(r).toMatchObject({ success: true, data: { itemId: 'v3', trackId: 'V2', from: 10, to: 12 }, message: "Moved 'v3' to track 'V2' at 10s–12s." });
    expect(itemOf(e.doc, 'v3').trackId).toBe('V2'); only(e, 'Move items');
    expect(r.timelineChanges.items.updated[0]).toMatchObject({ itemId: 'v3', changedFields: ['trackId'] });
  });
  it('from repositions the item on the new track', () => {
    const e = editor(); call(e, 'changeTrack', { itemId: 'v3', trackId: 'V2', from: 1 }); expect(itemOf(e.doc, 'v3')).toMatchObject({ trackId: 'V2', display: { from: 1000, to: 3000 } });
  });
  it('failures: ITEM_NOT_FOUND, TRACK_NOT_FOUND, TRACK_LOCKED, TRACK_INCOMPATIBLE, COLLISION — nothing changes', () => {
    const e = editor(); const b = json(e.doc);
    expect(call(e, 'changeTrack', { itemId: 'ghost', trackId: 'V2' })).toMatchObject({ success: false, error: "Item 'ghost' not found", code: 'ITEM_NOT_FOUND' });
    expect(call(e, 'changeTrack', { itemId: 'v3', trackId: 'nope' }).error).toBe('Track change failed: TRACK_NOT_FOUND');
    expect(call(e, 'changeTrack', { itemId: 'v3', trackId: 'A1' }).error).toBe('Track change failed: TRACK_INCOMPATIBLE');
    expect(json(e.doc)).toBe(b); expect(e.bus.undoStack).toHaveLength(0);
    const f = editor(lock(fixture(), 'V2')); expect(call(f, 'changeTrack', { itemId: 'v3', trackId: 'V2' }).error).toBe('Track change failed: TRACK_LOCKED');
    const g = editor(grouped()); const gb = json(g.doc); const r = call(g, 'changeTrack', { itemId: 'v1', trackId: 'V2' });
    expect(r.error).toContain("Track change failed: COLLISION — 'v1' at 0s–4s would overlap 'w1' (0s–3s) on track V2."); expect(r.error).toContain('That track has room for it from 9s'); refused(g, gb, r);
  });
});

describe('trimItem (results §2 trimItem l.1269; findings part 2 §37)', () => {
  const trim = (e: Editor, a: Record<string, unknown>) => call(e, 'trimItem', { itemId: 'v3', handle: 'end', ...a });
  it('end handle shortens: display.to and trim.to follow; "Edit items"; data {appliedDeltaSeconds, shiftedItemIds:[]}', () => {
    const e = editor(); const r = trim(e, { deltaSeconds: -0.5 });
    expect(r).toMatchObject({ success: true, data: { itemId: 'v3', appliedDeltaSeconds: -0.5, shiftedItemIds: [] } });
    expect(itemOf(e.doc, 'v3')).toMatchObject({ display: { from: 10000, to: 11500 }, trim: { from: 0, to: 1500 } }); only(e, 'Edit items');
    expect(e.doc.duration).toBe(11500);
  });
  it('end handle extends within the source; start handle moves display.from and trim.from together', () => {
    const e = editor(); trim(e, { deltaSeconds: 1 }); expect(itemOf(e.doc, 'v3')).toMatchObject({ display: { from: 10000, to: 13000 }, trim: { from: 0, to: 3000 } });
    const f = editor(); trim(f, { handle: 'start', deltaSeconds: 1 }); expect(itemOf(f.doc, 'v3')).toMatchObject({ display: { from: 11000, to: 12000 }, trim: { from: 1000, to: 2000 } });
  });
  it('going past the end of the source clamps and reports appliedDeltaSeconds — not an error', () => {
    const e = editor(); const r = trim(e, { deltaSeconds: 20 }); // source 10 s, trim.to 2 s → 8 s available
    expect(r).toMatchObject({ success: true, data: { appliedDeltaSeconds: 8 } }); expect(itemOf(e.doc, 'v3')).toMatchObject({ display: { from: 10000, to: 20000 }, trim: { from: 0, to: 10000 } });
  });
  it('the minimum length is 50 ms', () => {
    const e = editor(); const r = trim(e, { deltaSeconds: -5 }); expect(r.data.appliedDeltaSeconds).toBe(-1.95); expect(span(e.doc, 'v3')).toEqual([10000, 10050]);
  });
  it('already at the source limit → TRIM_AT_LIMIT, nothing changes', () => {
    const e = editor(); const b = json(e.doc); const r = trim(e, { handle: 'start', deltaSeconds: -1 }); // trim.from is already 0
    expect(r).toMatchObject({ success: false, code: 'TRIM_AT_LIMIT' }); expect(r.error).toContain("Trim was not applied — 'v3' cannot move its start that way"); refused(e, b, r);
  });
  it('would overlap a neighbour → COLLISION with the free space; nothing changes', () => {
    const e = editor(); const b = json(e.doc); const r = call(e, 'trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: 1 });
    expect(r.error).toContain("Trim was not applied: COLLISION — it would overlap 'v2' (4s–8s) on the same track; there is 0s of free space on that side."); refused(e, b, r);
  });
  it('failures: MISSING_PARAM, ITEM_NOT_FOUND, TRACK_LOCKED', () => {
    const e = editor();
    expect(call(e, 'trimItem', { itemId: 'v3', handle: 'end' })).toMatchObject({ code: 'MISSING_PARAM', error: 'itemId, handle (start/end), and deltaSeconds are required' });
    expect(call(e, 'trimItem', { itemId: 'ghost', handle: 'end', deltaSeconds: 1 }).error).toBe('Trim was not applied: ITEM_NOT_FOUND');
    expect(call(editor(lock(fixture(), 'V1')), 'trimItem', { itemId: 'v3', handle: 'end', deltaSeconds: -1 }).error).toBe('Trim was not applied: TRACK_LOCKED');
  });
  it('ripple end-trim shifts later items of the same track only ("Ripple trim")', () => {
    const e = editor(); const r = call(e, 'trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, ripple: true });
    expect(r.data).toMatchObject({ appliedDeltaSeconds: -1, shiftedItemIds: ['v2', 'v3'] });
    expect([span(e.doc, 'v1'), span(e.doc, 'v2'), span(e.doc, 'v3')]).toEqual([[0, 3000], [3000, 7000], [9000, 11000]]);
    expect([span(e.doc, 'a1'), span(e.doc, 't1'), span(e.doc, 'c2')]).toEqual([[0, 5000], [1000, 3000], [2000, 4000]]); only(e, 'Ripple trim');
  });
  it('ripple start-trim keeps display.from and closes up the later items', () => {
    const e = editor(); call(e, 'trimItem', { itemId: 'v1', handle: 'start', deltaSeconds: 1, ripple: true });
    expect(itemOf(e.doc, 'v1')).toMatchObject({ display: { from: 0, to: 3000 }, trim: { from: 1000, to: 4000 } }); expect([span(e.doc, 'v2'), span(e.doc, 'v3')]).toEqual([[3000, 7000], [9000, 11000]]);
  });
  it('rippleGroupId outside the group → RIPPLE_OUTSIDE_GROUP (operationMayHaveRun:false)', () => {
    const e = editor(grouped()); const b = json(e.doc); const r = call(e, 'trimItem', { itemId: 't1', handle: 'end', deltaSeconds: -1, rippleGroupId: 'g1' });
    expect(r).toMatchObject({ success: false, code: 'RIPPLE_OUTSIDE_GROUP', error: 'Trim item is outside ripple group', operationMayHaveRun: false }); refused(e, b, r);
  });
  // §41c fixtures: captions are exempt from ripple
  it('§41c (a): ripple-trim the end of a caption followed by another caption → only the trimmed caption changes; one step', () => {
    const e = editor(); const r = call(e, 'trimItem', { itemId: 'c1', handle: 'end', deltaSeconds: -1, ripple: true });
    expect(r.success).toBe(true); expect(span(e.doc, 'c1')).toEqual([0, 1000]); expect([span(e.doc, 'c2'), span(e.doc, 'c3')]).toEqual([[2000, 4000], [4000, 6000]]);
    expect(r.data.shiftedItemIds).toEqual([]); expect(e.bus.undoStack).toHaveLength(1);
  });
  it('§41c (d): the trim handles of a caption in ripple mode behave like a normal trim (start handle too)', () => {
    const e = editor(); call(e, 'trimItem', { itemId: 'c2', handle: 'start', deltaSeconds: 0.5, ripple: true });
    expect(span(e.doc, 'c2')).toEqual([2500, 4000]); expect([span(e.doc, 'c1'), span(e.doc, 'c3')]).toEqual([[0, 2000], [4000, 6000]]); expect(e.bus.undoStack).toHaveLength(1);
  });
});

describe('slipItem (results §2 slipItem l.1174)', () => {
  it('moves the source window, display unchanged; "Slip item"; data {itemId, slippedSeconds}', () => {
    const e = editor(); const r = call(e, 'slipItem', { itemId: 'v2', slipSeconds: 1 });
    expect(r).toMatchObject({ success: true, data: { itemId: 'v2', slippedSeconds: 1 } });
    expect(itemOf(e.doc, 'v2')).toMatchObject({ display: { from: 4000, to: 8000 }, trim: { from: 3000, to: 7000 } }); only(e, 'Slip item');
  });
  it('clamps to the source and reports the applied slip', () => {
    const e = editor(); const r = call(e, 'slipItem', { itemId: 'v2', slipSeconds: 10 }); // trim.to 6 s of 10 s source → 4 s
    expect(r.data.slippedSeconds).toBe(4); expect(itemOf(e.doc, 'v2').trim).toEqual({ from: 6000, to: 10000 });
    const f = editor(); expect(call(f, 'slipItem', { itemId: 'v2', slipSeconds: -10 }).data.slippedSeconds).toBe(-2);
  });
  it('failures all say "Slip was not applied" with their own code', () => {
    const noSource = build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('x', 'V1', 0, 1000, { trim: { from: 0, to: 1000 } })] });
    const cases: [string, Editor, Record<string, unknown>][] = [
      ['MISSING_PARAM', editor(), { itemId: 'v1' }], ['ITEM_NOT_FOUND', editor(), { itemId: 'ghost', slipSeconds: 1 }], ['INVALID_ITEM_TYPE', editor(), { itemId: 't1', slipSeconds: 1 }],
      ['SOURCE_DURATION_UNKNOWN', editor(noSource), { itemId: 'x', slipSeconds: 1 }], ['TRACK_LOCKED', editor(lock(fixture(), 'V1')), { itemId: 'v1', slipSeconds: 1 }],
      ['SLIP_AT_LIMIT', editor(), { itemId: 'v1', slipSeconds: -1 }],
    ];
    for (const [code, e, args] of cases) {
      const b = json(e.doc); const r = call(e, 'slipItem', args);
      expect(r, code).toMatchObject({ success: false, code }); expect(r.error, code).toContain('Slip was not applied'); refused(e, b, r);
    }
  });
});

describe('splitItem (findings part 2 §41b; results §2 splitItem)', () => {
  it('media: left keeps its id, right is inserted right after it; right.trim = [cut, old trim.to]; one "Split item" step', () => {
    const e = editor(); const r = call(e, 'splitItem', { itemId: 'v2', timestampS: 6 });
    expect(r).toMatchObject({ success: true, data: { leftItemId: 'v2' } });
    const right = r.data.rightItemId; expect(right).not.toBe('v2');
    expect(itemOf(e.doc, 'v2')).toMatchObject({ display: { from: 4000, to: 6000 }, trim: { from: 2000, to: 4000 } });
    expect(itemOf(e.doc, right)).toMatchObject({ trackId: 'V1', display: { from: 6000, to: 8000 }, trim: { from: 4000, to: 6000 }, type: 'video' });
    const order = e.doc.items.map(i => i.id); expect(order.indexOf(right)).toBe(order.indexOf('v2') + 1); only(e, 'Split item');
    expect(r.timelineChanges.items.created).toHaveLength(1);
  });
  it('media at playbackRate 2: the cut in the source is elapsed × rate', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('r', 'V1', 0, 2000, 0, 10000, { playbackRate: 2, trim: { from: 0, to: 4000 } })] });
    const e = editor(doc); const r = call(e, 'splitItem', { itemId: 'r', timestampS: 1 });
    expect(itemOf(e.doc, 'r').trim).toEqual({ from: 0, to: 2000 }); expect(itemOf(e.doc, r.data.rightItemId).trim).toEqual({ from: 2000, to: 4000 });
  });
  it('non-media (text): the right half gets trim.from = elapsed × rate (§41b)', () => {
    const e = editor(); const r = call(e, 'splitItem', { itemId: 't1', timestampS: 2 });
    expect(span(e.doc, 't1')).toEqual([1000, 2000]); expect(span(e.doc, r.data.rightItemId)).toEqual([2000, 3000]);
    expect(itemOf(e.doc, r.data.rightItemId).trim).toEqual({ from: 1000, to: 2000 }); expect(itemOf(e.doc, r.data.rightItemId).details.text).toBe('Hello');
  });
  it('invalid points (outside, at the edges) and unknown items → the same text, nothing changes', () => {
    for (const args of [{ itemId: 'v2', timestampS: 9 }, { itemId: 'v2', timestampS: 4 }, { itemId: 'v2', timestampS: 8 }, { itemId: 'ghost', timestampS: 1 }]) {
      const e = editor(); const b = json(e.doc); const r = call(e, 'splitItem', args);
      expect(r.error).toBe('Split point is invalid or item was not found'); expect(['INVALID_SPLIT_POINT', 'ITEM_NOT_FOUND']).toContain(r.code); refused(e, b, r);
    }
  });
  it('a locked track refuses with the unlock hint', () => {
    const e = editor(lock(fixture(), 'V1')); const r = call(e, 'splitItem', { itemId: 'v2', timestampS: 6 });
    expect(r).toMatchObject({ success: false, code: 'TRACK_LOCKED', error: 'This clip or track is locked. Unlock it before splitting.' }); expect(e.bus.undoStack).toHaveLength(0);
  });
});

describe('cloneItem (results §2 cloneItem l.389)', () => {
  it('clones onto another track at the source end by default; new id; same trim/properties; "Duplicate items"', () => {
    const e = editor(); const r = call(e, 'cloneItem', { itemId: 'v1', trackId: 'V2' });
    expect(r).toMatchObject({ success: true, data: { trackId: 'V2', from: 4, to: 8 } });
    const c = itemOf(e.doc, r.data.itemId); expect(c.id).not.toBe('v1');
    expect(c).toMatchObject({ trackId: 'V2', display: { from: 4000, to: 8000 }, trim: { from: 0, to: 4000 }, metadata: { assetId: 'asset-vid1' }, type: 'video' });
    expect(span(e.doc, 'v1')).toEqual([0, 4000]); only(e, 'Duplicate items'); expect(r.timelineChanges.items.created).toHaveLength(1);
  });
  it('at places the clone', () => { const e = editor(); const r = call(e, 'cloneItem', { itemId: 'v1', trackId: 'V2', at: 1 }); expect(span(e.doc, r.data.itemId)).toEqual([1000, 5000]); });
  it('failures: ITEM_NOT_FOUND, MISSING_TRACK_ID, missing/locked/incompatible track, TRACK_OVERLAP with the next free start', () => {
    const e = editor(); const b = json(e.doc);
    expect(call(e, 'cloneItem', { itemId: 'ghost', trackId: 'V2' })).toMatchObject({ code: 'ITEM_NOT_FOUND', error: "Item 'ghost' not found" });
    expect(call(e, 'cloneItem', { itemId: 'v1' })).toMatchObject({ code: 'MISSING_TRACK_ID', error: 'trackId is required' });
    for (const [code, tid] of [['TRACK_NOT_FOUND', 'nope'], ['TRACK_INCOMPATIBLE', 'A1']]) expect(call(e, 'cloneItem', { itemId: 'v1', trackId: tid }), code).toMatchObject({ code, error: `Track '${tid}' is missing, locked, or incompatible` });
    expect(call(editor(lock(fixture(), 'V2')), 'cloneItem', { itemId: 'v1', trackId: 'V2' })).toMatchObject({ code: 'TRACK_LOCKED', error: "Track 'V2' is missing, locked, or incompatible" });
    const o = call(e, 'cloneItem', { itemId: 'v1', trackId: 'V1' }); // default at = 4 s overlaps v2
    expect(o.code).toBe('TRACK_OVERLAP'); expect(o.error).toContain('[addItems] requested window collides on track V1: 4s–8s overlaps item v2 (4s–8s). The next free start for this length on that track is 12s'); refused(e, b, o);
  });
});

describe('deleteItems (results §2 deleteItems l.579; findings part 2 §37, §41c)', () => {
  it('plain delete removes only the listed items; "Delete items"; data lists them', () => {
    const e = editor(); const r = call(e, 'deleteItems', { itemIds: ['v1'] });
    expect(r).toMatchObject({ success: true, data: { deletedItemIds: ['v1'] } }); expect(e.doc.items.some(i => i.id === 'v1')).toBe(false);
    expect([span(e.doc, 'v2'), span(e.doc, 'v3')]).toEqual([[4000, 8000], [10000, 12000]]); only(e, 'Delete items');
    expect(r.timelineChanges.items.deleted).toHaveLength(1);
  });
  it('failures: MISSING_ITEM_IDS, ITEM_NOT_FOUND ("Delete cancelled; unknown item ID(s): …")', () => {
    const e = editor(); const b = json(e.doc);
    expect(call(e, 'deleteItems', { itemIds: [] })).toMatchObject({ code: 'MISSING_ITEM_IDS', error: 'itemIds is required' });
    const r = call(e, 'deleteItems', { itemIds: ['v1', 'zzz'] }); expect(r).toMatchObject({ code: 'ITEM_NOT_FOUND' }); expect(r.error + (r.message ?? '')).toContain('Delete cancelled; unknown item ID(s): zzz'); refused(e, b, r);
  });
  it('captions linked to a deleted clip go with it, listed in alsoDeletedItemIds, with a note when not rippled', () => {
    const doc = fixture(); doc.items.push(mkItem('lc', 'C1', 6000, 7000, { type: 'caption', captionSourceItemId: 'v1' }) as never);
    const e = editor(doc); const r = call(e, 'deleteItems', { itemIds: ['v1'] });
    expect(r.data.alsoDeletedItemIds).toEqual(['lc']); expect(r.data.note).toBe('Captions linked to the deleted clips were deleted with them. Pass ripple: true to also close the gap.');
    expect(e.doc.items.some(i => i.id === 'lc')).toBe(false);
  });
  it('ripple closes each track\'s gap ("Ripple delete"); data lists shiftedItemIds', () => {
    const e = editor(); const r = call(e, 'deleteItems', { itemIds: ['v1'], ripple: true });
    expect(r.data).toMatchObject({ deletedItemIds: ['v1'], shiftedItemIds: ['v2', 'v3'] });
    expect([span(e.doc, 'v2'), span(e.doc, 'v3')]).toEqual([[0, 4000], [6000, 8000]]); only(e, 'Ripple delete');
    expect([span(e.doc, 'a1'), span(e.doc, 'c1')]).toEqual([[0, 5000], [0, 2000]]); // other tracks untouched
  });
  it('§41c (b): deleting two captions (ripple or not) never moves a later caption', () => {
    for (const ripple of [false, true]) {
      const e = editor(); call(e, 'deleteItems', { itemIds: ['c1', 'c2'], ripple });
      expect(ids(e, 'C1')).toEqual(['c3']); expect(span(e.doc, 'c3')).toEqual([4000, 6000]); expect(e.bus.undoStack).toHaveLength(1);
    }
  });
  it('§41c (c): ripple-deleting a video clip and a caption together closes the video gap, not the caption gap; one step', () => {
    const e = editor(); const r = call(e, 'deleteItems', { itemIds: ['v1', 'c1'], ripple: true });
    expect(r.success).toBe(true); expect([span(e.doc, 'v2'), span(e.doc, 'v3')]).toEqual([[0, 4000], [6000, 8000]]);
    expect([span(e.doc, 'c2'), span(e.doc, 'c3')]).toEqual([[2000, 4000], [4000, 6000]]); expect(e.bus.undoStack).toHaveLength(1); only(e, 'Ripple delete');
  });
  it('rippleGroupId: a selection outside the group / spanning several groups / not continuous is refused with operationMayHaveRun:false', () => {
    const e = editor(grouped()); const b = json(e.doc);
    const r = call(e, 'deleteItems', { itemIds: ['t1'], rippleGroupId: 'g1' });
    expect(r).toMatchObject({ success: false, code: 'RIPPLE_OUTSIDE_GROUP', error: 'Delete selection is outside ripple group', operationMayHaveRun: false }); refused(e, b, r);
  });
});

describe('transformItem (findings part 2 §41b)', () => {
  const img = (): ProjectDocument => build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('im', 'V1', 0, 3000, { type: 'image', properties: { positionX: 100, positionY: 200, width: 400, height: 300, scale: 1 } })] });
  it('scaleBy keeps the visual centre; data.drawnBox is in canvas px rounded to 2 dp; "Edit items"', () => {
    const e = editor(img()); const r = call(e, 'transformItem', { itemId: 'im', scaleBy: 2 });
    expect(r.success).toBe(true); expect(r.data.drawnBox).toEqual({ x: -100, y: 50, width: 800, height: 600 });
    expect(itemOf(e.doc, 'im').properties).toMatchObject({ scale: { defaultValue: 2, keyframes: [] }, positionX: { defaultValue: -100, keyframes: [] }, positionY: { defaultValue: 50, keyframes: [] } }); only(e, 'Edit items');
    expect(r.message).toBe("'im' is now drawn at x -100, y 50, 800 × 600 px on the 1080 × 1920 canvas (before rotation).");
  });
  it('failures: ITEM_NOT_FOUND, NO_PROPERTIES_PROVIDED, exclusive scale options, locked track', () => {
    const e = editor(img()); const b = json(e.doc);
    expect(call(e, 'transformItem', { itemId: 'ghost', x: 1 })).toMatchObject({ code: 'ITEM_NOT_FOUND', error: 'Item not found', message: "Item 'ghost' not found on timeline." });
    expect(call(e, 'transformItem', { itemId: 'im' })).toMatchObject({ code: 'NO_PROPERTIES_PROVIDED', error: 'No valid properties provided' });
    expect(call(e, 'transformItem', { itemId: 'im', scale: 1, scaleBy: 2 })).toMatchObject({ success: false, code: 'PROPERTY_VALIDATION_FAILED' });
    expect(call(e, 'transformItem', { itemId: 'im', scaleBy: 2, fitToCanvas: true })).toMatchObject({ success: false, code: 'PROPERTY_VALIDATION_FAILED' });
    expect(json(e.doc)).toBe(b); expect(e.bus.undoStack).toHaveLength(0);
    const l = img(); l.tracks[0].locked = true; expect(call(editor(l), 'transformItem', { itemId: 'im', x: 1 })).toMatchObject({ success: false, code: 'TRACK_LOCKED' });
  });
});

// ---- two-path parity: the same operation through the UI intent and through the tool, identical starting document and id source.
type Twin = { name: string; labels?: [string, string]; doc?: () => ProjectDocument; intent: Parameters<Editor['intent']>[0]; tool: [string, Record<string, unknown>] };
const TWINS: Twin[] = [
  { name: 'deleteItems', intent: { type: 'deleteItems', itemIds: ['v1', 'c1'], ripple: false }, tool: ['deleteItems', { itemIds: ['v1', 'c1'] }] },
  { name: 'deleteItems ripple', intent: { type: 'deleteItems', itemIds: ['v1', 'c1'], ripple: true }, tool: ['deleteItems', { itemIds: ['v1', 'c1'], ripple: true }] },
  { name: 'splitItems/splitItem', labels: ['Split items', 'Split item'], intent: { type: 'splitItems', itemIds: ['v2'], atMs: 6000 }, tool: ['splitItem', { itemId: 'v2', timestampS: 6 }] },
  { name: 'duplicateItems/cloneItem', intent: { type: 'duplicateItems', itemIds: ['v3'] }, tool: ['cloneItem', { itemId: 'v3', trackId: 'V1' }] },
  { name: 'moveItems/moveItem', intent: { type: 'moveItems', itemIds: ['v3'], deltaMs: 500, trackId: null, newTrack: false, ripple: false }, tool: ['moveItem', { itemId: 'v3', by: 0.5 }] },
  { name: 'moveItems to track/moveItem trackId', intent: { type: 'moveItems', itemIds: ['v3'], deltaMs: 0, trackId: 'V2', newTrack: false, ripple: false }, tool: ['moveItem', { itemId: 'v3', trackId: 'V2' }] },
  { name: 'trimItem end', intent: { type: 'trimItem', itemId: 'v3', edge: 'end', deltaMs: -500, ripple: false }, tool: ['trimItem', { itemId: 'v3', handle: 'end', deltaSeconds: -0.5 }] },
  { name: 'trimItem ripple', intent: { type: 'trimItem', itemId: 'v1', edge: 'end', deltaMs: -1000, ripple: true }, tool: ['trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, ripple: true }] },
  { name: 'slipItem (provisional sign: the source moves by −deltaMs)', intent: { type: 'slipItem', itemId: 'v2', deltaMs: -1000 }, tool: ['slipItem', { itemId: 'v2', slipSeconds: 1 }] },
  { name: 'deleteTrack', intent: { type: 'deleteTrack', trackId: 'V2' }, tool: ['manageTrack', { action: 'delete', trackId: 'V2' }] },
  { name: 'renameTrack', intent: { type: 'renameTrack', trackId: 'V1', name: 'Main' }, tool: ['manageTrack', { action: 'rename', trackId: 'V1', name: 'Main' }] },
  { name: 'setTrackFlag muted', intent: { type: 'setTrackFlag', trackId: 'V1', flag: 'muted', value: true }, tool: ['manageTrack', { action: 'mute', trackId: 'V1', value: true }] },
  { name: 'setTrackVolume', intent: { type: 'setTrackVolume', trackId: 'V1', volume: 0.5 }, tool: ['manageTrack', { action: 'volume', trackId: 'V1', volume: 0.5 }] },
  { name: 'groupTracks', intent: { type: 'groupTracks', trackIds: ['V1', 'V2'], name: 'G' }, tool: ['manageTrackGroup', { action: 'create', trackIds: ['V1', 'V2'], name: 'G' }] },
  { name: 'ungroupTracks', doc: grouped, intent: { type: 'ungroupTracks', groupId: 'g1' }, tool: ['manageTrackGroup', { action: 'ungroup', groupId: 'g1' }] },
  { name: 'deleteGroup', doc: grouped, intent: { type: 'deleteGroup', groupId: 'g1' }, tool: ['manageTrackGroup', { action: 'delete', groupId: 'g1' }] },
  { name: 'setGroupFlag locked', doc: grouped, intent: { type: 'setGroupFlag', groupId: 'g1', flag: 'locked', value: true }, tool: ['manageTrackGroup', { action: 'lock', groupId: 'g1', value: true }] },
  { name: 'resizeCanvas', intent: { type: 'resizeCanvas', aspectRatio: '1:1' }, tool: ['resizeCanvas', { aspectRatio: '1:1' }] },
  { name: 'placeAssets (click) / addMedia at the lane end', labels: ['Add items', 'Add media'], intent: { type: 'placeAssets', assetIds: ['asset-vid1'], name: 'x' }, tool: ['addMedia', { trackId: 'V1', timelineStart: 12, items: [{ assetId: 'video_1' }] }] },
];
describe('two-path parity: UI intent and agent tool produce the identical document and the same undo labels/snapshots (ticket § T03; findings part 3 §45)', () => {
  for (const t of TWINS) it(t.name, () => {
    resetIds(); useIds(); const a = editor(t.doc?.()); const ri = a.intent(t.intent); expect(ri, JSON.stringify(ri)).toMatchObject({ ok: true });
    resetIds(); useIds(); const b = editor(t.doc?.()); const rt = call(b, t.tool[0], t.tool[1]); expect(rt.success, JSON.stringify(rt)).toBe(true);
    expect(json(a.doc)).toBe(json(b.doc));
    expect(a.bus.undoStack).toHaveLength(1); expect(b.bus.undoStack).toHaveLength(1);
    // The two paths keep their own Xapp labels for split (UI "Split items", tool "Split item") and add (footage click "Add items", agent batch "Add media"): findings part 3 §45 label table.
    const strip = (x: Editor) => x.bus.undoStack.map(({ source: _s, timestamp: _t, label, ...rest }) => (t.labels ? rest : { label, ...rest }));
    expect(strip(a)).toEqual(strip(b));
    if (t.labels) expect([a.bus.undoStack[0].label, b.bus.undoStack[0].label]).toEqual(t.labels);
    expect(a.bus.undoStack[0].source).toBe('user'); expect(b.bus.undoStack[0].source).toBe('agent');
    if (!t.labels) expect(a.journal.map(r => r.label)).toEqual(b.journal.map(r => r.label));
  });
});

describe('paste placement — written-spec oracle (findings part 2 §29 l.415)', () => {
  // "Paste placement: each pasted range moves right past overlapping items; overlaps under 1 ms are snapped to the neighbour's edge; if it still overlaps, that item is not placed."
  // Each copy keeps its source track and its offset from the first copied item, starting at the playhead. Records are detached clipboard items (they need not be in the document).
  const at = (doc: ProjectDocument, placed: RecordData[]) => placed.map(c => { const i = itemOf(doc, c.id); return [i.trackId, i.display.from, i.display.to]; });
  const clip = (trackId: string, from: number, to: number, id = 'rec') => mkItem(id, trackId, from, to);
  const two = (items: ReturnType<typeof mkItem>[]) => build({ tracks: [mkTrack('V1', 'video'), mkTrack('V2', 'video')], items });

  it('no overlap: the copy sits at the playhead on its own track', () => {
    const doc = fixture(); const placed = paste(doc, [itemOf(doc, 'v3')], 20000); expect(at(doc, placed)).toEqual([['V1', 20000, 22000]]);
    const o = paste(doc, [itemOf(doc, 't1')], 5000); expect(at(doc, o)).toEqual([['O1', 5000, 7000]]);
  });
  it('overlap of 1 ms or more: the copy moves right past the item', () => {
    const doc = fixture(); expect(at(doc, paste(doc, [itemOf(doc, 't1')], 2000))).toEqual([['O1', 3000, 5000]]); // t1 is 1–3 s, the copy asked for 2–4 s
  });
  it('touching is not overlapping: a copy that starts exactly at a neighbour end stays', () => {
    const doc = fixture(); expect(at(doc, paste(doc, [itemOf(doc, 't1')], 3000))).toEqual([['O1', 3000, 5000]]);
  });
  it('chained: moves past several adjacent items, then past the next one it runs into', () => {
    const doc = fixture();
    expect(at(doc, paste(doc, [itemOf(doc, 'c1')], 1000))).toEqual([['C1', 6000, 8000]]); // past c1, c2, c3 (0–6 s)
    expect(at(doc, paste(doc, [itemOf(doc, 'v1')], 2000))).toEqual([['V1', 12000, 16000]]); // past v1, v2 (to 8 s), whose 8–12 s window then hits v3 (10–12 s)
  });
  it('an overlap under 1 ms at the copy END snaps the copy end to the neighbour start', () => {
    const doc = two([clip('V2', 5000, 6000, 'n')]); // the copy asks for 4000.5–5000.5, n starts 0.5 ms before that end
    expect(at(doc, paste(doc, [clip('V2', 0, 1000)], 4000.5))).toEqual([['V2', 4000, 5000]]);
  });
  it('an overlap under 1 ms at the copy START moves the copy start to the neighbour end', () => {
    const doc = two([clip('V2', 4000, 5000, 'n')]); // the copy asks for 4999.5–5999.5, n ends 0.5 ms after the copy start
    expect(at(doc, paste(doc, [clip('V2', 0, 1000)], 4999.5))).toEqual([['V2', 5000, 6000]]);
  });
  it('still overlapping after the snap: the copy is not placed', () => {
    const doc = two([clip('V2', 3000, 4000.7, 'p'), clip('V2', 5000, 6000, 'n')]); // start 4000.5 → past p to 4000.7 → n starts 0.7 ms inside the end → end-snap to 4000–5000, which overlaps p
    const before = json(doc); expect(paste(doc, [clip('V2', 0, 1000)], 4000.5)).toEqual([]); expect(json(doc)).toBe(before);
  });
  it('through the bus a paste that places nothing changes nothing: no undo entry, no journal record', () => {
    const e = editor(two([clip('V2', 3000, 4000.7, 'p'), clip('V2', 5000, 6000, 'n')])); const before = json(e.doc);
    e.intent({ type: 'pasteItems', items: [clip('V2', 0, 1000)], atMs: 4000.5 });
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('through the bus a paste that places something is one "Add items" step', () => {
    const e = editor(); e.intent({ type: 'pasteItems', items: [itemOf(e.doc, 'v3')], atMs: 20000 }); only(e, 'Add items', 'user');
  });
  it('several records: offsets between the copies are kept, each copy stays on its own track', () => {
    const doc = fixture(); const placed = paste(doc, [itemOf(doc, 'v1'), itemOf(doc, 't1')], 20000);
    expect(at(doc, placed)).toEqual([['V1', 20000, 24000], ['O1', 21000, 23000]]); // t1 starts 1 s after v1
  });
  it('several records: each copy moves right on its own, past what it overlaps', () => {
    const doc = fixture(); const placed = paste(doc, [itemOf(doc, 'v1'), itemOf(doc, 't1')], 2000);
    expect(at(doc, placed)).toEqual([['V1', 12000, 16000], ['O1', 3000, 5000]]); // v1 → past v1, v2, v3; t1 asks for 3–5 s, which is free
  });
  it('provisional choice, not Xapp parity (Author question 12): source track gone → the lowest free track of the kind at the paste point', () => {
    const doc = fixture(); const rec = { ...itemOf(doc, 'v1'), trackId: 'GONE' }; // V1 is occupied at 1 s, so only the empty V2 is free
    expect(at(doc, paste(doc, [rec], 1000))).toEqual([['V2', 1000, 5000]]);
  });
  it('provisional choice, not Xapp parity (Author question 12): source track locked → another free track of the kind', () => {
    const doc = lock(fixture(), 'V1'); expect(at(doc, paste(doc, [itemOf(doc, 'v1')], 1000))).toEqual([['V2', 1000, 5000]]);
  });
  it('provisional choice, not Xapp parity (Author question 12): source track of another kind → a free track of the clip kind', () => {
    const doc = fixture(); const rec = { ...itemOf(doc, 'v1'), trackId: 'A1' }; expect(at(doc, paste(doc, [rec], 1000))).toEqual([['V2', 1000, 5000]]);
  });
  it('provisional choice, not Xapp parity (Author question 12): no free track of the kind → a new track of that kind', () => {
    const doc = lock(fixture(), 'V1'); doc.items.push(mkItem('blocker', 'V2', 0, 9000)); const tracks = doc.tracks.length;
    const placed = paste(doc, [itemOf(doc, 'v1')], 1000); const c = itemOf(doc, placed[0].id);
    expect(doc.tracks).toHaveLength(tracks + 1); expect(['V1', 'V2']).not.toContain(c.trackId); expect(doc.tracks.find(t => t.id === c.trackId)!.kind).toBe('video'); expect(c.display).toEqual({ from: 1000, to: 5000 });
  });
  it('provisional choice, not Xapp parity (Author question 12b): a copy that would start before 0 after the end snap is not placed', () => {
    // V1 holds a neighbour at 4999.5-9000. The 5000 ms copy asks for 0-5000, overlaps it by 0.5 ms, so its end snaps to 4999.5 and its start would be -0.5 ms: not placed.
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [clip('V1', 4999.5, 9000, 'n')] }); const rec = clip('V1', 100000, 105000); const before = json(doc);
    expect(paste(doc, [rec], 0)).toEqual([]); expect(json(doc)).toBe(before);
    const e = editor(build({ tracks: [mkTrack('V1', 'video')], items: [clip('V1', 4999.5, 9000, 'n')] })); const start = json(e.doc);
    expect(e.intent({ type: 'pasteItems', items: [rec], atMs: 0 })).toEqual({ ok: true }); expect(json(e.doc)).toBe(start); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
});
