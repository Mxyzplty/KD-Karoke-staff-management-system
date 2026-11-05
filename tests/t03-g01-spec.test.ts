// SPDX-License-Identifier: AGPL-3.0-only
// T03 golden editing sequence G-01, rebuilt from the WRITTEN spec (no Xapp reference files read).
// Oracle: agent tool results §5 (l.1619-1653, incl. "Corrections and additions" and "Cutframe decisions from G-01"); tickets doc T03
// "Golden editing sequence" + acceptance invalid cases (l.56-57); findings part 2 §35 (consolidate), §37; fixtures doc (S1, tos-action-30s).
// Only the numbers named in those sections are oracle facts. Every time/position the docs do not state is marked `// reconstruction`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Asset, AssetLink, ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, grouped, itemOf, mkItem, mkTrack, resetIds, span, useIds, video } from './t03-fixtures';

// fixtures doc: S1 = 1080x1920, 30 fps, 10.000 s, no audio; tos-action-30s = 1280x534, 30.000 s.
const asset = (id: string, w: number, h: number, ms: number) => ({ id, name: id, type: 'video', durationMs: ms, processing_status: 'ready', last_error_code: null, media: { durationMs: ms, video: { displayWidth: w, displayHeight: h } } }) as unknown as Asset;
const assets = [asset('s1', 1080, 1920, 10000), asset('act', 1280, 534, 30000)];
const links = [{ id: 'p:s1', projectId: 'p', assetId: 's1', agent_id: 'video_1', content_type: 'video', added_at: '', deleted_at: null }, { id: 'p:act', projectId: 'p', assetId: 'act', agent_id: 'video_2', content_type: 'video', added_at: '', deleted_at: null }] as unknown as AssetLink[];
const fresh = (doc?: ProjectDocument) => createEditor(doc, { assets, links });
type Ed = ReturnType<typeof fresh>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any;

describe('G-01 written-spec oracle — part A: editing sequence on S1 + tos-action-30s (results §5; tickets T03 "Golden editing sequence")', () => {
  const e = fresh();
  let va = '', vb = '', vc = '', s1 = '', s1r = '', act = '', cl1 = '', cl2 = '', cl3 = '', cv = '', gid = '', ins = '';
  beforeAll(() => useIds()); afterAll(() => resetIds());
  const last = () => e.bus.undoStack.at(-1)!;
  const itemCount = () => e.doc.items.length;
  /** Runs one mutating call: exactly +1 undo entry + +1 journal record with the label, source 'agent', and the item counts of the document. */
  const step = (label: string, fn: () => R): R => {
    const n = e.bus.undoStack.length, j = e.journal.length, before = itemCount();
    const r = fn();
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(e.bus.undoStack).toHaveLength(n + 1); expect(last()).toMatchObject({ label, source: 'agent' });
    expect(e.journal).toHaveLength(j + 1); expect(e.journal.at(-1)).toMatchObject({ label, source: 'agent', items_before: before, items_after: itemCount() });
    fits();
    return r;
  };
  /** "the project duration is re-fitted to the last item end after every edit" (results §5 "What G-01 confirmed"). */
  const fits = () => { if (e.doc.items.length) expect(e.doc.duration).toBe(Math.max(...e.doc.items.map(i => i.display.to))); };
  const at = (id: string) => span(e.doc, id);

  it('S0 new project: duration 1 s, 30 fps, 1080x1920, no tracks, no groups, no markers (findings §3; results §5)', () => {
    expect(e.doc).toMatchObject({ duration: 1000, fps: 30, size: { width: 1080, height: 1920 }, tracks: [], layerOrder: [], groups: {}, markers: [] });
    expect(e.bus.undoStack).toHaveLength(0);
  });
  it('S1 manageTrack create video "G01-VA" → message without a placement suffix; first track order 0 / layer "bottom"; "Create track"', () => {
    const r = step('Create track', () => e.call('manageTrack', { action: 'create', kind: 'video', name: 'G01-VA' }));
    expect(r.message).toBe("Created video track 'G01-VA'."); va = r.data.track.id;
    expect(r.data.track).toMatchObject({ name: 'G01-VA', kind: 'video', order: 0, layer: 'bottom' });
  });
  it('S2 addMedia S1 + tos-action-30s (trim 5.3–15.3) on VA: back-to-back, one "Add media" step', () => {
    const r = step('Add media', () => e.call('addMedia', { trackId: va, items: [{ assetId: 'video_1' }, { assetId: 'video_2', trimStart: 5.3, trimEnd: 15.3 }] }));
    [s1, act] = r.data.addedItemIds;
    expect(at(s1)).toEqual([0, 10000]); expect(at(act)).toEqual([10000, 20000]); // reconstruction: chained from 0 (default timelineStart)
    expect(itemOf(e.doc, act).trim).toEqual({ from: 5300, to: 15300 }); expect(e.doc.duration).toBe(20000);
  });
  it('S3 splitItem S1 at 2.5 s → the left half keeps S1\'s id (results §5); "Split item"', () => {
    const r = step('Split item', () => e.call('splitItem', { itemId: s1, timestampS: 2.5 }));
    expect(r.data.leftItemId).toBe(s1); s1r = r.data.rightItemId;
    expect(at(s1)).toEqual([0, 2500]); expect(at(s1r)).toEqual([2500, 10000]); // reconstruction: 2.5 s split point from the spec step
    expect(itemOf(e.doc, s1r).trim).toEqual({ from: 2500, to: 10000 });
  });
  it('S4 trimItem S1R end −1 s with ripple → the action clip moves 10–20 s → 9–19 s and is listed in shiftedItemIds; "Ripple trim"', () => {
    const r = step('Ripple trim', () => e.call('trimItem', { itemId: s1r, handle: 'end', deltaSeconds: -1, ripple: true }));
    expect(r.data.shiftedItemIds).toEqual([act]); expect(r.data.appliedDeltaSeconds).toBe(-1);
    expect(at(act)).toEqual([9000, 19000]); expect(at(s1r)).toEqual([2500, 9000]);
  });
  it('S5 trimItem S1R start +0.5 s, no ripple → a gap is left (nothing shifts)', () => {
    const r = step('Edit items', () => e.call('trimItem', { itemId: s1r, handle: 'start', deltaSeconds: 0.5 })); // label: findings part 3 §45.1 (a plain trim writes the generic label)
    expect(r.data.shiftedItemIds).toEqual([]); expect(at(s1r)).toEqual([3000, 9000]); expect(at(act)).toEqual([9000, 19000]); // reconstruction: 0.5 s from the spec step
    expect(at(s1)).toEqual([0, 2500]); // gap 2.5–3 s
  });
  it('S6 moveItem S1R beforeItemId S1L → S1R 0–6 s, S1L 6–8.5 s (results §5); "Ripple reorder"', () => {
    step('Ripple reorder', () => e.call('moveItem', { itemId: s1r, beforeItemId: s1 }));
    expect(at(s1r)).toEqual([0, 6000]); expect(at(s1)).toEqual([6000, 8500]);
    expect(at(act)).toEqual([9000, 19000]); // reconstruction: a reorder only re-packs the two moved items' span
  });
  it('S7 act end +1 s → 9–20 s (reconstruction: the insert step of the spec needs the clip to end at 20 s)', () => {
    const r = step('Edit items', () => e.call('trimItem', { itemId: act, handle: 'end', deltaSeconds: 1 }));
    expect(r.data.appliedDeltaSeconds).toBe(1); expect(at(act)).toEqual([9000, 20000]);
  });
  it('S8 clones of S1L at 20 / 25 / 32.5 s → CL1 / CL2 / CL3 keep trim and length; each is one "Duplicate items"', () => {
    const c = (t: number) => step('Duplicate items', () => e.call('cloneItem', { itemId: s1, trackId: va, at: t }));
    const [a, b, d] = [c(20), c(25), c(32.5)];
    [cl1, cl2, cl3] = [a, b, d].map(r => r.data.itemId);
    expect(a.data).toMatchObject({ trackId: va, from: 20, to: 22.5 }); expect(b.data).toMatchObject({ from: 25, to: 27.5 }); expect(d.data).toMatchObject({ from: 32.5, to: 35 });
    expect(itemOf(e.doc, cl1).trim).toEqual(itemOf(e.doc, s1).trim); expect(e.doc.duration).toBe(35000);
  });
  it('S9 deleteItems CL2 with ripple → CL3 32.5 → 30 s (results §5); "Ripple delete"', () => {
    const r = step('Ripple delete', () => e.call('deleteItems', { itemIds: [cl2], ripple: true }));
    expect(r.data.shiftedItemIds).toEqual([cl3]); expect(at(cl3)).toEqual([30000, 32500]); expect(e.doc.duration).toBe(32500);
    expect(at(cl1)).toEqual([20000, 22500]);
  });
  it('S10 create VB, VC (video, above VA) and clone S1L onto VC at 30 s', () => {
    vb = step('Create track', () => e.call('manageTrack', { action: 'create', kind: 'video', name: 'G01-VB' })).data.track.id;
    vc = step('Create track', () => e.call('manageTrack', { action: 'create', kind: 'video', name: 'G01-VC' })).data.track.id;
    expect(e.doc.layerOrder.map(l => l.id)).toEqual([va, vb, vc]); // placement: each new video track just above the highest non-caption track (results §5)
    cv = step('Duplicate items', () => e.call('cloneItem', { itemId: s1, trackId: vc, at: 30 })).data.itemId;
    expect(at(cv)).toEqual([30000, 32500]);
  });
  it('S11 manageTrackGroup create [VA, VB] → bounds = span of the members\' items; the members collapse into one layerOrder entry; "Group tracks"', () => {
    const r = step('Group tracks', () => e.call('manageTrackGroup', { action: 'create', trackIds: [va, vb], name: 'G01-G' }));
    gid = r.data.groupId;
    expect(r.data).toMatchObject({ trackIds: [va, vb], bounds: { start: 0, end: 32.5 } });
    expect(e.doc.layerOrder).toEqual([{ type: 'group', id: gid }, { type: 'track', id: vc }]);
    expect(e.doc.tracks.find(t => t.id === va)!.locked).toBe(false);
  });
  it('S12 deleteItems CL1 with rippleGroupId → CL3 30 → 27.5 s; the VC item stays; group bounds follow; "Ripple group delete"', () => {
    step('Ripple group delete', () => e.call('deleteItems', { itemIds: [cl1], rippleGroupId: gid }));
    expect(at(cl3)).toEqual([27500, 30000]); expect(at(cv)).toEqual([30000, 32500]);
  });
  it('S13 resizeCanvas 16:9 → 1920x1080; every item keeps its pixel position and size; groups and markers unchanged; "Resize canvas"', () => {
    const items = JSON.stringify(e.doc.items.map(i => [i.id, i.properties])), groups = JSON.stringify(e.doc.groups), markers = JSON.stringify(e.doc.markers);
    const r = step('Resize canvas', () => e.call('resizeCanvas', { aspectRatio: '16:9' }));
    expect(r.data).toEqual({ aspectRatio: '16:9', width: 1920, height: 1080 }); expect(e.doc.size).toEqual({ width: 1920, height: 1080 });
    expect(JSON.stringify(e.doc.items.map(i => [i.id, i.properties]))).toBe(items); expect(JSON.stringify(e.doc.groups)).toBe(groups); expect(JSON.stringify(e.doc.markers)).toBe(markers);
  });
  it('S14 addMedia insertAfterItemId = action, S1 for 2 s → 20–22 s, contain-fitted (scale 0.5625, x 656.25, y 0); CL3 → 29.5–32 s; VC item stays; "Insert items"', () => {
    const r = step('Insert items', () => e.call('addMedia', { insertAfterItemId: act, items: [{ assetId: 'video_1', duration: 2 }] }));
    ins = r.data.addedItemIds[0];
    expect(at(ins)).toEqual([20000, 22000]); expect(itemOf(e.doc, ins).trackId).toBe(va);
    expect(itemOf(e.doc, ins).properties).toMatchObject({ scale: { defaultValue: 0.5625, keyframes: [] }, positionX: { defaultValue: 656.25, keyframes: [] }, positionY: { defaultValue: 0, keyframes: [] } });
    expect(itemOf(e.doc, ins).properties.width.defaultValue * itemOf(e.doc, ins).properties.scale.defaultValue).toBe(607.5); // box 607.5 x 1080 (results §5, findings part 5 §53)
    expect(at(cl3)).toEqual([29500, 32000]); expect(at(cv)).toEqual([30000, 32500]);
  });
  it('S15 manageMarkers add 4.5 s "G01 A moved" → exactly one marker {4500 ms, label}; "Edit markers"', () => {
    step('Edit markers', () => e.call('manageMarkers', { actions: [{ action: 'add', time: 4.5, label: 'G01 A moved' }] }));
    expect(e.doc.markers).toHaveLength(1); expect(e.doc.markers[0]).toMatchObject({ timeMs: 4500, label: 'G01 A moved' });
  });
  it('the whole sequence wrote one undo entry per mutating call, in order, all source "agent"', () => {
    expect(e.bus.undoStack.map(x => x.label)).toEqual(['Create track', 'Add media', 'Split item', 'Ripple trim', 'Edit items', 'Ripple reorder', 'Edit items', 'Duplicate items', 'Duplicate items', 'Duplicate items',
      'Ripple delete', 'Create track', 'Create track', 'Duplicate items', 'Group tracks', 'Ripple group delete', 'Resize canvas', 'Insert items', 'Edit markers']);
    expect(e.bus.undoStack.every(x => x.source === 'agent')).toBe(true);
  });
  it('undoing the whole sequence restores the new-project document exactly (100-step cap not hit)', () => {
    while (e.bus.undoStack.length) e.bus.undo();
    expect(e.doc).toMatchObject({ duration: 1000, fps: 30, size: { width: 1080, height: 1920 }, tracks: [], items: [], layerOrder: [], groups: {}, markers: [] });
  });
});

describe('G-01 written-spec oracle — group lock does not touch the member tracks own flag (results §5)', () => {
  it('lock / unlock a group: value required; group.locked toggles, member track locked stays false; "Set group flag" ×2', () => {
    const e = fresh(grouped());
    const on = e.call('manageTrackGroup', { action: 'lock', groupId: 'g1', value: true }) as R;
    expect(on.data).toMatchObject({ locked: true }); expect(e.doc.groups.g1.locked).toBe(true);
    expect(e.doc.tracks.filter(t => ['V1', 'V2'].includes(t.id)).every(t => t.locked === false)).toBe(true);
    expect((e.call('manageTrackGroup', { action: 'lock', groupId: 'g1', value: false }) as R).data.locked).toBe(false);
    expect(e.bus.undoStack.map(x => x.label)).toEqual(['Set group flag', 'Set group flag']);
  });
});

describe('G-01 written-spec oracle — trim clamps (results §5 "Corrections": trimItem beyond the source clamps, success, no warning)', () => {
  // The window is the spec's: tos-action-30s trim 5.3–15.3 of a 30 s source. Position is a reconstruction: alone on its track at 10 s so that no
  // neighbour limits the move (in the main sequence the clip sits next to S1L, whose collision clamp would stop the start trim first).
  const setup = () => {
    const e = fresh(); const t = (e.call('manageTrack', { action: 'create', kind: 'video' }) as R).data.track.id;
    const id = (e.call('addMedia', { trackId: t, timelineStart: 10, items: [{ assetId: 'video_2', trimStart: 5.3, trimEnd: 15.3 }] }) as R).data.addedItemIds[0];
    return { e, id };
  };
  it('end +20 s → appliedDeltaSeconds 14.7, clamped at the source end (30 s), success, no warning; one undo restores', () => {
    const { e, id } = setup(); const before = JSON.stringify(e.doc.items); const n = e.bus.undoStack.length;
    const r = e.call('trimItem', { itemId: id, handle: 'end', deltaSeconds: 20 }) as R;
    expect(r.success).toBe(true); expect(r.data.appliedDeltaSeconds).toBeCloseTo(14.7, 9); expect(r.warning).toBeUndefined(); expect(r.error).toBeUndefined();
    expect(itemOf(e.doc, id).trim.to).toBe(30000); expect(at2(e, id)).toEqual([10000, 34700]);
    expect(e.bus.undoStack).toHaveLength(n + 1); e.bus.undo(); expect(JSON.stringify(e.doc.items)).toBe(before);
  });
  it('start −10 s → appliedDeltaSeconds −5.3, clamped at the source start (0 s), success, no warning; one undo restores', () => {
    const { e, id } = setup(); const before = JSON.stringify(e.doc.items);
    const r = e.call('trimItem', { itemId: id, handle: 'start', deltaSeconds: -10 }) as R;
    expect(r.success).toBe(true); expect(r.data.appliedDeltaSeconds).toBeCloseTo(-5.3, 9); expect(r.warning).toBeUndefined();
    expect(itemOf(e.doc, id).trim.from).toBe(0); expect(at2(e, id)).toEqual([4700, 20000]);
    e.bus.undo(); expect(JSON.stringify(e.doc.items)).toBe(before);
  });
  const at2 = (e: Ed, id: string) => span(e.doc, id);
});

describe('G-01 written-spec oracle — refusals (tickets T03 acceptance: invalid cases; results §5 "Corrections")', () => {
  const small = () => fresh(build({ tracks: [mkTrack('V1', 'video'), mkTrack('A1', 'audio')], items: [video('a', 'V1', 0, 4000), video('b', 'V1', 6000, 9000), mkItem('au', 'A1', 0, 3000, { type: 'audio' })] }));
  const untouched = (e: Ed, before: string, r: R) => { expect(r.success).toBe(false); expect(r.timelineChanges).toBeUndefined(); expect(JSON.stringify(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0); };
  it('a move on a locked track → TRACK_LOCKED, error "Move failed: TRACK_LOCKED", nothing changes', () => {
    const e = small(); (e.doc.tracks.find(t => t.id === 'V1') as R).locked = true; const b = JSON.stringify(e.doc);
    const r = e.call('moveItem', { itemId: 'b', by: 1 }) as R;
    expect(r).toMatchObject({ success: false, code: 'TRACK_LOCKED', error: 'Move failed: TRACK_LOCKED' }); untouched(e, b, r);
  });
  it('a move onto an occupied range → COLLISION (not TRACK_OVERLAP); the error names the blocking item and its range', () => {
    const e = small(); const b = JSON.stringify(e.doc); const r = e.call('moveItem', { itemId: 'b', by: -3 }) as R; // 3–6 s overlaps a (0–4 s)
    expect(r.code).toBe('COLLISION'); expect(r.error).toMatch(/^Move failed: COLLISION — 'b' at 3s–6s would overlap 'a' \(0s–4s\) on track V1\./); untouched(e, b, r);
  });
  it('a group-boundary ripple → GROUP_RIPPLE_BOUNDARY_UNSET with the stored text; operationMayHaveRun false (Cutframe decision 1: Xapp reports true)', () => {
    const d = grouped(); (d.items.find(i => i.id === 'w1') as R).display = { from: 2000, to: 3500 };
    const e = fresh(d); const b = JSON.stringify(e.doc); const r = e.call('trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, rippleGroupId: 'g1' }) as R;
    expect(r).toMatchObject({ success: false, code: 'GROUP_RIPPLE_BOUNDARY_UNSET', error: 'An item spans this edit boundary. Split it at the boundary or turn off ripple editing first.', operationMayHaveRun: false }); untouched(e, b, r);
  });
  it('an unknown split id → the code-less Xapp text plus a code Cutframe adds', () => {
    const e = small(); const b = JSON.stringify(e.doc); const r = e.call('splitItem', { itemId: 'nope', timestampS: 1 }) as R;
    expect(r.error).toBe('Split point is invalid or item was not found'); expect(typeof r.code).toBe('string'); expect(r.code).not.toBe(''); untouched(e, b, r); // added code: provisional name
  });
  it('a video asset on an audio track → INVALID_TRACK, "Cannot place video items on track …", the message lists the compatible video tracks', () => {
    const e = small(); const b = JSON.stringify(e.doc); const r = e.call('addMedia', { trackId: 'A1', items: [{ assetId: 'video_1' }] }) as R;
    expect(r.code).toBe('INVALID_TRACK'); expect(r.error).toBe("Cannot place video items on track 'A1'"); expect(r.message).toContain('V1'); untouched(e, b, r);
  });
});

describe('G-01 written-spec oracle — part B: consolidateTracks on the 7-track "K" layout (results §5; findings part 2 §35; tickets T03 Consolidate numbers)', () => {
  // Stack bottom→top (results §5): K-A2, K-A1, K-V1, K-V2, K-VL (locked), K-O1, K-E1, K-EL (locked, empty), group K{K-G1, K-G2} (empty, group locked), K-C1.
  // reconstruction: K-E1, K-EL, K-G1, K-G2 are empty video tracks; item times below; the doc names none of them.
  const kdoc = () => build({
    tracks: [mkTrack('K-A2', 'audio'), mkTrack('K-A1', 'audio'), mkTrack('K-V1', 'video'), mkTrack('K-V2', 'video'), mkTrack('K-VL', 'video', { locked: true }), mkTrack('K-O1', 'overlay'),
      mkTrack('K-E1', 'video'), mkTrack('K-EL', 'video', { locked: true }), mkTrack('K-G1', 'video'), mkTrack('K-G2', 'video'), mkTrack('K-C1', 'caption')],
    layerOrder: ['K-A2', 'K-A1', 'K-V1', 'K-V2', 'K-VL', 'K-O1', 'K-E1', 'K-EL'].map(id => ({ type: 'track' as const, id })).concat([{ type: 'group', id: 'K' } as never, { type: 'track', id: 'K-C1' }]),
    groups: { K: { id: 'K', name: 'K', children: [{ type: 'track', id: 'K-G1' }, { type: 'track', id: 'K-G2' }], hidden: false, locked: true } },
    items: [video('P1', 'K-V1', 0, 4000), video('P2', 'K-V2', 5000, 8000), video('P3', 'K-V2', 1000, 3000), video('PL', 'K-VL', 6000, 9000), mkItem('T1', 'K-O1', 0, 2000, { type: 'text', details: { text: 'Hi' } })],
  });
  const labels = (e: Ed) => e.bus.undoStack.map(x => x.label);
  it('subset {K-V2, K-VL} → moved 0, "Tracks are already consolidated." (K-VL is locked, K-V1 is outside the set); no entry', () => {
    const e = fresh(kdoc()); const b = JSON.stringify(e.doc);
    const r = e.call('consolidateTracks', { trackIds: ['K-V2', 'K-VL'] }) as R;
    expect(r).toMatchObject({ success: true, moved: 0, deletedTrackIds: [], message: 'Tracks are already consolidated.' }); expect(JSON.stringify(e.doc)).toBe(b); expect(e.bus.undoStack).toHaveLength(0);
  });
  it('trackIds [] → INVALID_TOOL_INPUT (schema MINITEMS on $.trackIds), nothing changes', () => {
    const e = fresh(kdoc()); const b = JSON.stringify(e.doc); const r = e.call('consolidateTracks', { trackIds: [] }) as R;
    expect(r).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT' }); expect(JSON.stringify(r)).toContain('MINITEMS'); expect(JSON.stringify(r)).toContain('$.trackIds');
    expect(JSON.stringify(e.doc)).toBe(b); expect(e.bus.undoStack).toHaveLength(0);
  });
  it('all tracks (default) → moved 1: P2 → K-V1 with times unchanged; P3 stays (overlaps P1); the locked K-VL item and the overlay text stay; the repeat moves 0', () => {
    const e = fresh(kdoc());
    const r = e.call('consolidateTracks', {}) as R;
    expect(r).toMatchObject({ success: true, moved: 1, deletedTrackIds: [], message: 'Consolidated 1 item(s); empty tracks were preserved.' });
    expect(itemOf(e.doc, 'P2').trackId).toBe('K-V1'); expect(span(e.doc, 'P2')).toEqual([5000, 8000]);
    expect(itemOf(e.doc, 'P3').trackId).toBe('K-V2'); expect(itemOf(e.doc, 'PL').trackId).toBe('K-VL'); expect(itemOf(e.doc, 'T1').trackId).toBe('K-O1');
    expect(e.doc.tracks).toHaveLength(11); // nothing deleted
    expect(labels(e)).toEqual(['Consolidate tracks']); expect(e.bus.undoStack[0].source).toBe('agent'); expect(e.journal).toHaveLength(1);
    const again = e.call('consolidateTracks', {}) as R;
    expect(again).toMatchObject({ success: true, moved: 0, message: 'Tracks are already consolidated.' }); expect(e.bus.undoStack).toHaveLength(1);
    e.bus.undo(); expect(itemOf(e.doc, 'P2').trackId).toBe('K-V2');
  });
  it('Q32 {trackIds:[K-V1,K-V2], deleteEmptyTracks:true} with a locked empty track + a locked group of empty tracks elsewhere → Cutframe succeeds in scope: P8 → K-V1, nothing deleted (documented deviation from Xapp\'s PROJECT_UNAVAILABLE "Group is locked")', () => {
    const d = kdoc(); d.items.push(video('P8', 'K-V2', 12000, 14000) as never); // reconstruction: P8 on K-V2, clear of everything on K-V1
    (d.items.find(i => i.id === 'P2') as R).trackId = 'K-V1'; // reconstruction: P2 already packed onto K-V1, so only P8 moves
    const e = fresh(d);
    const n = e.bus.undoStack.length;
    const r = e.call('consolidateTracks', { trackIds: ['K-V1', 'K-V2'], deleteEmptyTracks: true }) as R;
    // message: findings part 2 §35 results format "Consolidated n item(s) and deleted m empty track(s)." with m = 0 (results §5 decision 2: "the §35 message for deleteEmptyTracks: true")
    expect(r).toMatchObject({ success: true, moved: 1, deletedTrackIds: [], message: 'Consolidated 1 item(s) and deleted 0 empty track(s).' });
    expect(itemOf(e.doc, 'P8').trackId).toBe('K-V1'); expect(span(e.doc, 'P8')).toEqual([12000, 14000]);
    for (const id of ['K-EL', 'K-G1', 'K-G2', 'K-E1']) expect(e.doc.tracks.some(t => t.id === id)).toBe(true);
    expect(e.doc.groups.K).toMatchObject({ locked: true }); expect(e.bus.undoStack).toHaveLength(n + 1); expect(e.bus.undoStack.at(-1)!.label).toBe('Consolidate tracks');
  });
});
