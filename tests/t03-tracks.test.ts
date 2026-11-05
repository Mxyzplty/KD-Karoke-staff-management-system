// SPDX-License-Identifier: AGPL-3.0-only
// T03 tracks, groups, group ripple and the timelineChanges report through the agent tools (seconds).
// Oracle: agent tool results §1 (A0.3 timelineChanges), §2 manageTrack l.911, manageTrackGroup l.959, resizeCanvas l.1067;
// findings part 2 §29 (tracks), §36 (markers/canvas), §37 (groups and group ripple), §35 (consolidate).
// Provisional (T03 command path notes): default-placement message text for create, GROUP_NOT_FOUND on reorder (Xapp has no code),
// TRACK_LOCKED for a locked parent group on create/reorder, the group-ripple occupied-interval refusal, operationMayHaveRun values.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, fixture, grouped, itemOf, links, mkItem, mkTrack, resetIds, span, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => resetIds());

type Editor = ReturnType<typeof editor>;
const editor = (doc: ProjectDocument = fixture()) => createEditor(doc, { assets: assets(), links: links() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (e: Editor, name: string, args: Record<string, unknown>): any => e.call(name, args);
const json = (d: unknown) => JSON.stringify(d);
const only = (e: Editor, label: string) => {
  expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label, source: 'agent' }); expect(e.journal).toHaveLength(1);
};
const refused = (e: Editor, before: string, r: { success: boolean; timelineChanges?: unknown }) => {
  expect(r.success).toBe(false); expect(r.timelineChanges).toBeUndefined();
  expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
};
const stackOf = (e: Editor) => e.doc.layerOrder.map(x => x.id);
const lockTrack = (doc: ProjectDocument, id: string) => { doc.tracks.find(t => t.id === id)!.locked = true; return doc; };
const empties = () => build({ tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('V2', 'video'), mkTrack('V3', 'video')] });

describe('manageTrack create (results §2 manageTrack; findings part 2 §29)', () => {
  it('names a new track with the kind prefix + the smallest free number and places it by the kind rule; "Create track"', () => {
    const e = editor(); const r = call(e, 'manageTrack', { action: 'create', kind: 'video' });
    expect(r.success).toBe(true); expect(r.data.track.name).toBe('V3'); expect(r.message).toBe("Created video track 'V3'."); // default-placement wording: provisional
    expect(stackOf(e)).toEqual(['A1', 'V1', 'V2', 'O1', r.data.track.id, 'C1']); // video: just above the highest non-caption track, below captions
    only(e, 'Create track');
  });
  it('audio goes below everything, caption above everything, overlay above the highest non-caption; names A2 / C2 / O2', () => {
    const e = editor();
    expect(call(e, 'manageTrack', { action: 'create', kind: 'audio' }).data.track).toMatchObject({ name: 'A2', order: 0, layer: 'bottom' });
    expect(call(e, 'manageTrack', { action: 'create', kind: 'caption' }).data.track).toMatchObject({ name: 'C2', layer: 'top' });
    expect(call(e, 'manageTrack', { action: 'create', kind: 'overlay' }).data.track.name).toBe('O2');
  });
  it('a deleted number is reused (smallest free)', () => {
    const e = editor(empties()); call(e, 'manageTrack', { action: 'delete', trackId: 'V2' });
    expect(call(e, 'manageTrack', { action: 'create', kind: 'video' }).data.track.name).toBe('V2');
  });
  it('an explicit name wins; surrounding blanks are trimmed', () => {
    const e = editor(); expect(call(e, 'manageTrack', { action: 'create', kind: 'video', name: '  Hero  ' }).data.track.name).toBe('Hero');
  });
  it('TrackSummary has exactly the documented fields (bottom track carries layer:"bottom", no height)', () => {
    const e = editor(); const r = call(e, 'manageTrack', { action: 'create', kind: 'video', position: 'bottom' });
    expect(r.message).toBe("Created video track 'V3' at the bottom.");
    expect(r.data.track).toEqual({ id: r.data.track.id, name: 'V3', kind: 'video', groupId: null, order: 0, layerIndex: 5, layer: 'bottom', muted: false, solo: false, locked: false, hidden: false, volume: 1, itemCount: 0 });
  });
  it('position top / above / below and toIndex place the track; the message names where', () => {
    const e = editor(); const top = call(e, 'manageTrack', { action: 'create', kind: 'overlay', position: 'top' });
    expect(top.message).toMatch(/ at the top\.$/); expect(stackOf(e).at(-1)).toBe(top.data.track.id); expect(top.data.track.layer).toBe('top');
    const above = call(e, 'manageTrack', { action: 'create', kind: 'video', position: 'above', relativeToTrackId: 'V1' });
    expect(above.message).toMatch(/ above track 'V1'\.$/); expect(stackOf(e).indexOf(above.data.track.id)).toBe(stackOf(e).indexOf('V1') + 1);
    const below = call(e, 'manageTrack', { action: 'create', kind: 'video', position: 'below', relativeToTrackId: 'V1' });
    expect(below.message).toMatch(/ below track 'V1'\.$/); expect(stackOf(e).indexOf(below.data.track.id)).toBe(stackOf(e).indexOf('V1') - 1);
    const f = editor(); const at = call(f, 'manageTrack', { action: 'create', kind: 'video', toIndex: 2 });
    expect(at.message).toBe(`Created video track 'V3'.`); expect(stackOf(f)[2]).toBe(at.data.track.id);
  });
  it('inside a group (groupId): the track joins that group and reports groupId', () => {
    const e = editor(grouped()); const r = call(e, 'manageTrack', { action: 'create', kind: 'video', groupId: 'g1', position: 'top' });
    expect(r.data.track.groupId).toBe('g1'); expect(e.doc.groups.g1.children.at(-1)).toEqual({ type: 'track', id: r.data.track.id });
  });
  const bad = (name: string, args: Record<string, unknown>, expected: Record<string, unknown>, doc?: () => ProjectDocument) =>
    it(`failure: ${name}`, () => { const e = editor(doc?.()); const b = json(e.doc); const r = call(e, 'manageTrack', args); expect(r).toMatchObject({ success: false, ...expected }); refused(e, b, r); });
  bad('no action', {}, { code: 'MISSING_ACTION', error: 'action is required' });
  bad('unknown action', { action: 'zap' }, { code: 'UNKNOWN_ACTION', error: "Unknown action 'zap'" });
  bad('invalid kind', { action: 'create', kind: 'gif' }, { code: 'INVALID_TRACK_KIND', error: "Invalid track kind 'gif'. Use video, audio, caption or overlay." });
  bad('invalid position', { action: 'create', kind: 'video', position: 'middle' }, { code: 'INVALID_TRACK_POSITION', error: "Invalid position 'middle'. Use top, bottom, above or below." });
  bad('above without relativeToTrackId', { action: 'create', kind: 'video', position: 'above' }, { code: 'INVALID_RELATIVE_PLACEMENT', error: "position 'above' requires relativeToTrackId." });
  bad('relativeToTrackId without a position', { action: 'create', kind: 'video', relativeToTrackId: 'V1' }, { code: 'INVALID_RELATIVE_PLACEMENT', error: 'relativeToTrackId requires position above or below.' });
  bad('top with relativeToTrackId', { action: 'create', kind: 'video', position: 'top', relativeToTrackId: 'V1' }, { code: 'AMBIGUOUS_TRACK_POSITION', error: "position 'top' cannot be combined with relativeToTrackId." });
  bad('position and toIndex', { action: 'create', kind: 'video', position: 'top', toIndex: 1 }, { code: 'AMBIGUOUS_TRACK_POSITION', error: 'Use position or toIndex, not both.' });
  bad('relative track not found', { action: 'create', kind: 'video', position: 'above', relativeToTrackId: 'nope' }, { code: 'RELATIVE_TRACK_NOT_FOUND', error: "Track 'nope' not found." });
  bad('group not found', { action: 'create', kind: 'video', groupId: 'nope', position: 'top' }, { code: 'GROUP_NOT_FOUND', error: "Group 'nope' not found." });
  bad('relative track outside the given group', { action: 'create', kind: 'video', groupId: 'g1', position: 'above', relativeToTrackId: 'O1' }, { code: 'RELATIVE_PARENT_MISMATCH', error: "Track 'O1' is not in group 'g1'." }, grouped);
  bad('toIndex out of range', { action: 'create', kind: 'video', toIndex: 99 }, { code: 'INVALID_TO_INDEX', error: 'toIndex must be an integer from 0 to 5 (bottom-to-top).' });
  bad('creating inside a locked group', { action: 'create', kind: 'video', groupId: 'g1', position: 'top' }, { code: 'TRACK_LOCKED', error: 'Group is locked' }, () => { const d = grouped(); d.groups.g1.locked = true; return d; });
});

describe('manageTrack delete / flags / volume / rename / reorder (results §2 manageTrack)', () => {
  it('delete a track with items needs deleteItems:true (TRACK_NOT_EMPTY carries data.track and changes nothing)', () => {
    const e = editor(); const b = json(e.doc); const r = call(e, 'manageTrack', { action: 'delete', trackId: 'V1' });
    expect(r).toMatchObject({ success: false, code: 'TRACK_NOT_EMPTY', error: "Track 'V1' contains 3 item(s). Pass deleteItems: true to delete the track and its items.", data: { track: { id: 'V1', itemCount: 3 } } }); refused(e, b, r);
  });
  it('delete with deleteItems:true removes the track, its items and linked captions; "Delete track"', () => {
    const doc = fixture(); doc.items.push(mkItem('lc', 'C1', 6000, 7000, { type: 'caption', captionSourceItemId: 'v1' }) as never);
    doc.transitions.push({ id: 'tr1', trackId: 'V1', fromId: 'v1', toId: 'v2', kind: 'fade', duration: 500 } as never);
    const e = editor(doc); const r = call(e, 'manageTrack', { action: 'delete', trackId: 'V1', deleteItems: true });
    expect(r).toMatchObject({ success: true, message: "Deleted track 'V1' and 3 item(s).", data: { deletedTrackId: 'V1', deletedItemCount: 3 } });
    expect(e.doc.tracks.some(t => t.id === 'V1')).toBe(false); expect(stackOf(e)).not.toContain('V1');
    expect(e.doc.items.map(i => i.id)).not.toContain('v1'); expect(e.doc.items.some(i => i.id === 'lc')).toBe(false); expect(e.doc.transitions).toHaveLength(0);
    only(e, 'Delete track');
    expect(r.timelineChanges.tracks.deleted).toHaveLength(1); expect(r.timelineChanges.items.deleted.length).toBeGreaterThanOrEqual(3);
  });
  it('delete an empty track needs no flag', () => {
    const e = editor(); const r = call(e, 'manageTrack', { action: 'delete', trackId: 'V2' });
    expect(r).toMatchObject({ success: true, message: "Deleted track 'V2'.", data: { deletedTrackId: 'V2', deletedItemCount: 0 } });
  });
  it('mute / solo / lock / hide: value defaults to true, false clears; the message names the stored flag; "Set track flag"', () => {
    for (const [action, flag] of [['mute', 'muted'], ['solo', 'solo'], ['lock', 'locked'], ['hide', 'hidden']] as const) {
      const e = editor(); const r = call(e, 'manageTrack', { action, trackId: 'V1' });
      expect(r.message).toBe(`Updated ${flag} on track 'V1'.`); expect(r.data.track[flag]).toBe(true);
      expect(e.doc.tracks.find(t => t.id === 'V1')![flag]).toBe(true); only(e, 'Set track flag');
      expect(r.timelineChanges.tracks.updated[0]).toMatchObject({ id: 'V1', changedFields: [flag] });
      call(e, 'manageTrack', { action, trackId: 'V1', value: false }); expect(e.doc.tracks.find(t => t.id === 'V1')![flag]).toBe(false);
    }
  });
  it('setting a flag to the value it already has changes nothing: success, no entry, no timelineChanges', () => {
    const e = editor(); const r = call(e, 'manageTrack', { action: 'mute', trackId: 'V1', value: false });
    expect(r.success).toBe(true); expect(r.timelineChanges).toBeUndefined(); expect(e.bus.undoStack).toHaveLength(0);
  });
  it('volume 0–1: message, stored value, "Set track volume"; anything else → INVALID_VOLUME', () => {
    const e = editor(); const r = call(e, 'manageTrack', { action: 'volume', trackId: 'V1', volume: 0.5 });
    expect(r.message).toBe("Set track 'V1' volume to 0.5."); expect(e.doc.tracks.find(t => t.id === 'V1')!.volume).toBe(0.5); only(e, 'Set track volume');
    for (const v of [1.5, -0.1, Number.NaN, '1', undefined]) {
      const f = editor(); const b = json(f.doc); const x = call(f, 'manageTrack', { action: 'volume', trackId: 'V1', volume: v });
      expect(x).toMatchObject({ code: 'INVALID_VOLUME', error: 'volume must be a number from 0 to 1.' }); refused(f, b, x);
    }
  });
  it('rename trims, "Rename track"; blank → MISSING_NAME', () => {
    const e = editor(); const r = call(e, 'manageTrack', { action: 'rename', trackId: 'V1', name: '  Main  ' });
    expect(r.message).toBe("Renamed track 'V1' to 'Main'."); expect(e.doc.tracks.find(t => t.id === 'V1')!.name).toBe('Main'); only(e, 'Rename track');
    const f = editor(); expect(call(f, 'manageTrack', { action: 'rename', trackId: 'V1', name: '   ' })).toMatchObject({ code: 'MISSING_NAME', error: 'name is required' });
  });
  it('missing / unknown trackId', () => {
    const e = editor();
    expect(call(e, 'manageTrack', { action: 'mute' })).toMatchObject({ code: 'MISSING_TRACK_ID', error: 'trackId is required' });
    expect(call(e, 'manageTrack', { action: 'mute', trackId: 'nope' })).toMatchObject({ code: 'TRACK_NOT_FOUND', error: "Track 'nope' not found." });
  });
  it('reorder top / bottom / above / below / toIndex: message, stack and "Move track layer"', () => {
    const cases: [Record<string, unknown>, string, string[]][] = [
      [{ position: 'top' }, "Reordered track 'V1' to the top.", ['A1', 'V2', 'O1', 'C1', 'V1']],
      [{ position: 'bottom', trackId: 'O1' }, "Reordered track 'O1' to the bottom.", ['O1', 'A1', 'V1', 'V2', 'C1']],
      [{ position: 'above', relativeToTrackId: 'O1' }, "Reordered track 'V1' above track 'O1'.", ['A1', 'V2', 'O1', 'V1', 'C1']],
      [{ position: 'below', relativeToTrackId: 'A1' }, "Reordered track 'V1' below track 'A1'.", ['V1', 'A1', 'V2', 'O1', 'C1']],
      [{ toIndex: 3 }, "Reordered track 'V1'.", ['A1', 'V2', 'O1', 'V1', 'C1']],
    ];
    for (const [args, message, stack] of cases) {
      const e = editor(); const r = call(e, 'manageTrack', { action: 'reorder', trackId: 'V1', ...args });
      expect(r.message, JSON.stringify(args)).toBe(message); expect(stackOf(e)).toEqual(stack); only(e, 'Move track layer');
      expect(r.data.track.id).toBe(args.trackId ?? 'V1'); expect(r.timelineChanges.layerOrder.after.map((x: { id: string }) => x.id)).toEqual(stack);
    }
  });
  it('reorder failures: itself, toIndex range, unknown group, relative parent mismatch', () => {
    const e = editor(); const b = json(e.doc);
    expect(call(e, 'manageTrack', { action: 'reorder', trackId: 'V1', position: 'above', relativeToTrackId: 'V1' })).toMatchObject({ code: 'INVALID_RELATIVE_PLACEMENT', error: 'A track cannot be placed relative to itself.' });
    expect(call(e, 'manageTrack', { action: 'reorder', trackId: 'V1', toIndex: 5 })).toMatchObject({ code: 'INVALID_TO_INDEX', error: 'toIndex must be an integer from 0 to 4 (bottom-to-top).' });
    const g = call(e, 'manageTrack', { action: 'reorder', trackId: 'V1', groupId: 'nope', position: 'top' }); expect(g).toMatchObject({ success: false, error: 'Group not found' }); // Xapp's text; code is Cutframe' addition (provisional)
    expect(call(e, 'manageTrack', { action: 'reorder', trackId: 'V1', groupId: 'g1', position: 'top' }).success).toBe(false);
    expect(json(e.doc)).toBe(b); expect(e.bus.undoStack).toHaveLength(0);
  });
  it('reorder inside a locked group → TRACK_LOCKED "Group is locked"', () => {
    const d = grouped(); d.groups.g1.locked = true; const e = editor(d); const b = json(e.doc);
    const r = call(e, 'manageTrack', { action: 'reorder', trackId: 'V1', position: 'top' }); expect(r).toMatchObject({ code: 'TRACK_LOCKED', error: 'Group is locked' }); refused(e, b, r);
  });
});

describe('manageTrackGroup (results §2 manageTrackGroup l.959; findings part 2 §37)', () => {
  const grp = (e: Editor, args: Record<string, unknown>) => call(e, 'manageTrackGroup', args);
  it('create: trimmed name, adjacent tracks collapse into the group at their place; GroupSummary; "Group tracks"; no message field', () => {
    const e = editor(); const r = grp(e, { action: 'create', trackIds: ['V1', 'V2'], name: '  Pair  ' });
    expect(r.success).toBe(true); expect(r).not.toHaveProperty('message');
    expect(r.data).toEqual({ groupId: r.data.groupId, name: 'Pair', hidden: false, locked: false, trackIds: ['V1', 'V2'], bounds: { start: 0, end: 12 } });
    expect(e.doc.layerOrder).toEqual([{ type: 'track', id: 'A1' }, { type: 'group', id: r.data.groupId }, { type: 'track', id: 'O1' }, { type: 'track', id: 'C1' }]);
    expect(e.doc.groups[r.data.groupId]).toMatchObject({ name: 'Pair', hidden: false, locked: false, children: [{ type: 'track', id: 'V1' }, { type: 'track', id: 'V2' }] });
    only(e, 'Group tracks');
    expect(r.timelineChanges.groups.created).toHaveLength(1); expect(r.timelineChanges.layerOrder).toBeDefined();
  });
  it('create with empty member tracks reports bounds:null', () => {
    const e = editor(empties()); expect(grp(e, { action: 'create', trackIds: ['V1', 'V2'], name: 'G' }).data.bounds).toBeNull();
  });
  const bad = (name: string, args: Record<string, unknown>, reason: string, doc?: () => ProjectDocument) =>
    it(`failure: ${name} → INVALID_GROUP_OPERATION "${reason}"`, () => {
      const e = editor(doc?.() ?? fixture()); const b = json(e.doc); const r = grp(e, args);
      expect(r).toMatchObject({ success: false, code: 'INVALID_GROUP_OPERATION', error: reason }); refused(e, b, r);
    });
  const lockedGroup = () => { const d = grouped(); d.groups.g1.locked = true; return d; };
  bad('create without a name', { action: 'create', trackIds: ['V1', 'V2'], name: '  ' }, 'Choose a name and at least two distinct adjacent tracks');
  bad('create with one track', { action: 'create', trackIds: ['V1'], name: 'G' }, 'Choose a name and at least two distinct adjacent tracks');
  bad('create with a duplicate id', { action: 'create', trackIds: ['V1', 'V1'], name: 'G' }, 'Choose a name and at least two distinct adjacent tracks');
  bad('create with non-adjacent tracks', { action: 'create', trackIds: ['V1', 'O1'], name: 'G' }, 'Group tracks must be adjacent and outside existing groups');
  bad('create with a track already in a group', { action: 'create', trackIds: ['V2', 'O1'], name: 'G' }, 'Group tracks must be adjacent and outside existing groups', grouped);
  bad('create with an unknown track', { action: 'create', trackIds: ['V1', 'zzz'], name: 'G' }, 'Group tracks must be adjacent and outside existing groups');
  bad('no groupId', { action: 'rename', name: 'x' }, 'groupId is required');
  bad('rename with an empty name', { action: 'rename', groupId: 'g1', name: ' ' }, 'Unknown group or empty name', grouped);
  bad('rename an unknown group', { action: 'rename', groupId: 'nope', name: 'x' }, 'Unknown group or empty name', grouped);
  bad('lock an unknown group', { action: 'lock', groupId: 'nope', value: true }, 'Unknown group', grouped);
  bad('hide without a boolean', { action: 'hide', groupId: 'g1', value: 'yes' }, 'value must be boolean', grouped);
  bad('reorder without an integer', { action: 'reorder', groupId: 'g1', toIndex: 1.5 }, 'toIndex must be an integer', grouped);
  bad('setTracks with duplicates', { action: 'setTracks', groupId: 'g1', trackIds: ['V1', 'V1'] }, 'Choose distinct member tracks', grouped);
  bad('setTracks with fewer than two', { action: 'setTracks', groupId: 'g1', trackIds: ['V1'] }, 'Choose distinct member tracks', grouped);
  bad('unknown action', { action: 'zap', groupId: 'g1' }, 'Unknown group action', grouped);
  bad('rename in a locked group', { action: 'rename', groupId: 'g1', name: 'x' }, 'Group is locked', lockedGroup);
  bad('setTracks in a locked group', { action: 'setTracks', groupId: 'g1', trackIds: ['V1', 'V2'] }, 'Group is locked', lockedGroup);
  bad('reorder a locked group', { action: 'reorder', groupId: 'g1', toIndex: 0 }, 'Group is locked', lockedGroup);
  bad('ungroup a locked group', { action: 'ungroup', groupId: 'g1' }, 'Group is locked', lockedGroup);
  bad('delete a locked group', { action: 'delete', groupId: 'g1' }, 'Group is locked', lockedGroup);
  it('rename: trimmed, "Rename group"', () => {
    const e = editor(grouped()); const r = grp(e, { action: 'rename', groupId: 'g1', name: ' Duo ' });
    expect(r.data).toMatchObject({ groupId: 'g1', name: 'Duo' }); only(e, 'Rename group');
    expect(r.timelineChanges.groups.updated[0]).toMatchObject({ id: 'g1', changedFields: ['name'] });
  });
  it('hide / lock work on a locked group (the only changes allowed) and report the flag; "Set group flag"', () => {
    const e = editor(grouped()); const r = grp(e, { action: 'lock', groupId: 'g1', value: true });
    expect(r.data).toMatchObject({ locked: true, hidden: false }); only(e, 'Set group flag');
    expect(r.timelineChanges.groups.updated[0]).toMatchObject({ id: 'g1', changedFields: ['locked'], before: { locked: false }, after: { locked: true } });
    expect(grp(e, { action: 'lock', groupId: 'g1', value: false }).data.locked).toBe(false);
    expect(grp(e, { action: 'hide', groupId: 'g1', value: true }).data.hidden).toBe(true);
  });
  it('reorder: moves the group within its list to toIndex (bottom-to-top); "Reorder group"', () => {
    const e = editor(grouped()); const r = grp(e, { action: 'reorder', groupId: 'g1', toIndex: 0 });
    expect(r.success).toBe(true); expect(e.doc.layerOrder.map(x => x.id)).toEqual(['g1', 'A1', 'O1']); only(e, 'Reorder group');
    expect(grp(e, { action: 'reorder', groupId: 'g1', toIndex: 99 }).success).toBe(true); expect(e.doc.layerOrder.at(-1)!.id).toBe('g1'); // clamped
  });
  it('ungroup: children go back in place; data {ungroupedId}; "Ungroup tracks"', () => {
    const e = editor(grouped()); const r = grp(e, { action: 'ungroup', groupId: 'g1' });
    expect(r.data).toEqual({ ungroupedId: 'g1' }); expect(e.doc.groups.g1).toBeUndefined();
    expect(e.doc.layerOrder.map(x => x.id)).toEqual(['A1', 'V1', 'V2', 'O1']); only(e, 'Ungroup tracks'); expect(r.timelineChanges.groups.deleted).toHaveLength(1);
  });
  it('delete: removes the group, its member tracks, their items and transitions; data {deletedGroupId}; "Delete group"', () => {
    const d = grouped(); d.transitions.push({ id: 'tr1', trackId: 'V1', fromId: 'v1', toId: 'v2', kind: 'fade', duration: 500 } as never);
    const e = editor(d); const r = grp(e, { action: 'delete', groupId: 'g1' });
    expect(r.data).toEqual({ deletedGroupId: 'g1' });
    expect(e.doc.tracks.map(t => t.id)).toEqual(['A1', 'O1']); expect(e.doc.items.map(i => i.id)).toEqual(['t1']); expect(e.doc.transitions).toHaveLength(0);
    expect(e.doc.layerOrder.map(x => x.id)).toEqual(['A1', 'O1']); only(e, 'Delete group');
  });
  // The next two are the membership-changing setTracks cases of the ticket. They FAIL against the current source (adjacentRun is called without the group id as `allow`).
  it('setTracks with the members the group already holds is a no-op: success + GroupSummary, 0 undo entries, 0 journal records', () => {
    // Members keep their stack order (findings part 2 §37), so ['V2','V1'] changes nothing. Ticket T03 Build: "no-op commands skipped". Implementer decision, Phase 1 #2.
    const e = editor(grouped()); const r = grp(e, { action: 'setTracks', groupId: 'g1', trackIds: ['V2', 'V1'] });
    expect(r, JSON.stringify(r)).toMatchObject({ success: true, data: { groupId: 'g1', trackIds: ['V1', 'V2'] } });
    expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0); expect(r.timelineChanges).toBeUndefined();
  });
  it('setTracks that changes membership: a neighbour joins the group; the summary lists the new members in stack order', () => {
    const e = editor(grouped()); const r = grp(e, { action: 'setTracks', groupId: 'g1', trackIds: ['V1', 'V2', 'O1'] });
    expect(r, JSON.stringify(r)).toMatchObject({ success: true, data: { groupId: 'g1', trackIds: ['V1', 'V2', 'O1'] } });
    expect(e.doc.layerOrder.map(x => x.id)).toEqual(['A1', 'g1']); expect(e.doc.groups.g1.children.map((c: { id: string }) => c.id)).toEqual(['V1', 'V2', 'O1']);
    only(e, 'Change group tracks'); expect(r.timelineChanges.groups.updated[0].changedFields).toEqual(['children']);
  });
  it('setTracks cannot take a track from another group', () => {
    const d = grouped(); d.tracks.push(mkTrack('C1', 'caption'));
    d.layerOrder = [{ type: 'track', id: 'A1' }, { type: 'group', id: 'g1' }, { type: 'group', id: 'g2' }];
    d.groups.g2 = { id: 'g2', name: 'Other', children: [{ type: 'track', id: 'O1' }, { type: 'track', id: 'C1' }], hidden: false, locked: false };
    const e = editor(d); const b = json(e.doc); const r = grp(e, { action: 'setTracks', groupId: 'g1', trackIds: ['V1', 'V2', 'O1'] });
    expect(r).toMatchObject({ success: false, code: 'INVALID_GROUP_OPERATION', error: 'Membership must be adjacent and cannot take tracks from another group' }); refused(e, b, r);
  });
});

describe('group ripple (findings part 2 §37: the group is the ripple scope; results §5 G-01)', () => {
  const OCC = 'Another item occupies the removed group interval. Split or remove it explicitly first.';
  const BOUND = 'An item spans this edit boundary. Split it at the boundary or turn off ripple editing first.';
  it('ripple group trim: items starting at/after the old end move on every member track, other tracks stay; "Ripple group trim"', () => {
    const e = editor(grouped()); const r = call(e, 'trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, rippleGroupId: 'g1' });
    expect(r.success, JSON.stringify(r)).toBe(true); expect(r.data.appliedDeltaSeconds).toBe(-1);
    expect(['v1', 'v2', 'w1', 'w2', 'v3', 't1'].map(id => span(e.doc, id))).toEqual([[0, 3000], [3000, 7000], [0, 3000], [4000, 8000], [9000, 11000], [1000, 3000]]);
    expect([...r.data.shiftedItemIds].sort()).toEqual(['v2', 'v3', 'w2']); only(e, 'Ripple group trim');
  });
  it('an item of another member track crossing the edit boundary refuses the edit: GROUP_RIPPLE_BOUNDARY_UNSET, document unchanged', () => {
    const d = grouped(); d.items.find(i => i.id === 'w1')!.display = { from: 2000, to: 3500 };
    const e = editor(d); const b = json(e.doc); const r = call(e, 'trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, rippleGroupId: 'g1' });
    expect(r).toMatchObject({ success: false, code: 'GROUP_RIPPLE_BOUNDARY_UNSET', error: BOUND, operationMayHaveRun: false }); // results §5 'Cutframe decisions from G-01' item 1 (l.1650): Xapp true, Cutframe false
    refused(e, b, r);
  });
  it('ripple group delete of a clean interval: the selection goes, later items on every member track close up by the interval; "Ripple group delete"', () => {
    const e = editor(grouped()); const r = call(e, 'deleteItems', { itemIds: ['v1', 'w1'], rippleGroupId: 'g1' });
    expect(r.success, JSON.stringify(r)).toBe(true); expect(e.doc.items.map(i => i.id)).toEqual(['v2', 'w2', 'v3', 't1']);
    expect(['v2', 'w2', 'v3', 't1'].map(id => span(e.doc, id))).toEqual([[0, 4000], [1000, 5000], [6000, 8000], [1000, 3000]]); only(e, 'Ripple group delete');
  });
  it('deleting one item while another member track still has an item inside the removed interval is refused (provisional text)', () => {
    const e = editor(grouped()); const b = json(e.doc); const r = call(e, 'deleteItems', { itemIds: ['v1'], rippleGroupId: 'g1' });
    expect(r).toMatchObject({ success: false, code: 'RIPPLE_INTERVAL_OCCUPIED', error: OCC }); refused(e, b, r);
  });
  it('a locked member track or a locked group refuses a group ripple edit (TRACK_LOCKED), nothing changes', () => {
    const a = editor(lockTrack(grouped(), 'V2')); const ab = json(a.doc); const ra = call(a, 'trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, rippleGroupId: 'g1' });
    expect(ra.code).toBe('TRACK_LOCKED'); expect(json(a.doc)).toBe(ab); expect(a.bus.undoStack).toHaveLength(0);
    const d = grouped(); d.groups.g1.locked = true; const b = editor(d); const rb = call(b, 'trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, rippleGroupId: 'g1' });
    // results §2 trimItem l.1282: a ripple trim on a locked track reports the "already at the limit" text with TRACK_LOCKED
    expect(rb).toMatchObject({ success: false, code: 'TRACK_LOCKED' }); expect(rb.error).toMatch(/^Trim was not applied — 'v1' cannot move its end that way/);
    expect(b.bus.undoStack).toHaveLength(0);
  });
  it('a group ripple delete in a locked group is thrown as "Group is locked" (results §1.4 thrown errors, stored for the locked-group case)', () => {
    const d = grouped(); d.groups.g1.locked = true; const e = editor(d); const b = json(e.doc);
    const r = call(e, 'deleteItems', { itemIds: ['v1', 'w1'], rippleGroupId: 'g1' });
    expect(r).toMatchObject({ success: false, code: 'TRACK_LOCKED', error: 'Group is locked' }); refused(e, b, r);
  });
  it('insertAfter inside a group ripples the whole group by the inserted length and leaves tracks outside the group alone; "Insert items"', () => {
    const e = editor(grouped()); const r = call(e, 'addMedia', { insertAfterItemId: 'v1', items: [{ assetId: 'video_2' }] }); // 6 s
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(['v2', 'w2', 'v3', 'w1', 't1'].map(id => span(e.doc, id))).toEqual([[10000, 14000], [11000, 15000], [16000, 18000], [0, 3000], [1000, 3000]]);
    expect(span(e.doc, r.data.addedItemIds[0])).toEqual([4000, 10000]); only(e, 'Insert items');
  });
  it('a group move (moveItem groupId) never touches tracks outside the group; the group is not ripple-scoped (see t03-items)', () => {
    const e = editor(grouped()); call(e, 'moveItem', { groupId: 'g1', by: 2 }); expect(span(e.doc, 't1')).toEqual([1000, 3000]);
  });
});

describe('timelineChanges (results §1 A0.3)', () => {
  it('header constants first, then the sections in the documented order', () => {
    const e = editor(); const r = call(e, 'addMedia', { trackId: 'V2', timelineStart: 20, items: [{ assetId: 'video_1' }] });
    const t = r.timelineChanges; expect(Object.keys(t).slice(0, 4)).toEqual(['basis', 'timeUnit', 'detailsOmitted', 'readBack']);
    // readBack is Xapp's exact sentence (research §1.8.3 item 1, 22 stored results).
    expect(t).toMatchObject({ basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true,
      readBack: 'Use context or viewItemDetails for changed fields not included in these summaries, or for truncated text.' });
    expect(Object.keys(t).slice(4)).toEqual(['items', 'settings']);
  });
  it('items.created: {itemId, type, trackId, from, to (s), trim, playbackRate}; settings.duration reports the grown timeline', () => {
    const e = editor(); const r = call(e, 'addMedia', { trackId: 'V2', timelineStart: 20, items: [{ assetId: 'video_1' }] });
    const id = r.data.addedItemIds[0];
    expect(r.timelineChanges.items).toEqual({ created: [{ itemId: id, type: 'video', trackId: 'V2', from: 20, to: 30, trim: { from: 0, to: 10 }, playbackRate: 1 }], updated: [], deleted: [] });
    expect(r.timelineChanges.settings).toMatchObject({ changedFields: ['duration'], before: { duration: 12 }, after: { duration: 30 } });
  });
  it('items.deleted carries the state before; text/caption items carry text in created and deleted', () => {
    const e = editor(); const r = call(e, 'deleteItems', { itemIds: ['v1', 't1'] });
    expect(r.timelineChanges.items.deleted).toEqual([
      { itemId: 'v1', type: 'video', trackId: 'V1', from: 0, to: 4, trim: { from: 0, to: 4 }, playbackRate: 1 },
      { itemId: 't1', type: 'text', trackId: 'O1', from: 1, to: 3, playbackRate: 1, text: 'Hello' },
    ]);
    const f = editor(); const s = call(f, 'splitItem', { itemId: 't1', timestampS: 2 }); expect(s.timelineChanges.items.created[0]).toMatchObject({ type: 'text', text: 'Hello' });
  });
  it('items.updated: sorted changedFields and before/after (s); a trim lists display and trim, nothing else', () => {
    const e = editor(); const r = call(e, 'trimItem', { itemId: 'v3', handle: 'end', deltaSeconds: -0.5 });
    expect(r.timelineChanges.items.updated).toEqual([{ itemId: 'v3', changedFields: ['display', 'trim'],
      before: { type: 'video', trackId: 'V1', from: 10, to: 12, trim: { from: 0, to: 2 }, playbackRate: 1 }, after: { type: 'video', trackId: 'V1', from: 10, to: 11.5, trim: { from: 0, to: 1.5 }, playbackRate: 1 } }]);
    expect(r.timelineChanges.items.created).toEqual([]); expect(r.timelineChanges.items.deleted).toEqual([]);
  });
  it('changedFields goes one level into the details / properties / metadata bags ("bag.key"), never the bag itself', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('im', 'V1', 0, 3000, { type: 'image', properties: { positionX: 100, positionY: 200, width: 400, height: 300, scale: 1 } })] });
    const e = editor(doc); const r = call(e, 'transformItem', { itemId: 'im', scaleBy: 2 });
    const f: string[] = r.timelineChanges.items.updated[0].changedFields;
    expect(f).toEqual([...f].sort()); expect(f).toContain('properties.scale'); expect(f).not.toContain('properties'); expect(f.every(x => x.startsWith('properties.'))).toBe(true);
  });
  it('tracks: created/deleted/updated summaries and the layerOrder block', () => {
    const e = editor(); const c = call(e, 'manageTrack', { action: 'create', kind: 'video', position: 'bottom' });
    expect(c.timelineChanges.tracks.created).toEqual([{ id: c.data.track.id, kind: 'video', name: 'V3', order: 0, muted: false, solo: false, hidden: false, locked: false, volume: 1 }]);
    expect(c.timelineChanges.layerOrder.before.map((x: { id: string }) => x.id)).toEqual(['A1', 'V1', 'V2', 'O1', 'C1']);
    expect(c.timelineChanges.layerOrder.after[0]).toEqual({ id: c.data.track.id, type: 'track' });
    const l = call(e, 'manageTrack', { action: 'lock', trackId: 'V1' });
    expect(l.timelineChanges.tracks.updated[0]).toMatchObject({ id: 'V1', changedFields: ['locked'], before: { locked: false }, after: { locked: true } }); expect(l.timelineChanges.layerOrder).toBeUndefined();
  });
  it('a re-stacked track counts as changed through order (derived), the reorder changes layerOrder', () => {
    const e = editor(); const r = call(e, 'manageTrack', { action: 'reorder', trackId: 'V1', position: 'top' });
    expect(r.timelineChanges.tracks.updated.map((u: { id: string }) => u.id).sort()).toEqual(['C1', 'O1', 'V1', 'V2']);
    expect(r.timelineChanges.tracks.updated.every((u: { before: { order: number }; after: { order: number } }) => u.before.order !== u.after.order)).toBe(true);
  });
  it('groups: GroupSummary {name, children, hidden, locked}', () => {
    const e = editor(); const r = call(e, 'manageTrackGroup', { action: 'create', trackIds: ['V1', 'V2'], name: 'Pair' });
    expect(r.timelineChanges.groups.created).toEqual([{ id: r.data.groupId, name: 'Pair', children: [{ id: 'V1', type: 'track' }, { id: 'V2', type: 'track' }], hidden: false, locked: false }]);
  });
  it('markers: {time (s), text}; settings: size changes list changedFields ["size"] with both sizes', () => {
    const e = editor(); const m = call(e, 'manageMarkers', { actions: [{ action: 'add', time: 2.5, label: 'Beat' }] });
    expect(m.timelineChanges.markers.created).toEqual([{ id: m.data.addedMarkerIds[0], time: 2.5, text: 'Beat' }]);
    const r = call(e, 'resizeCanvas', { aspectRatio: '1:1' });
    expect(r.timelineChanges.settings).toMatchObject({ changedFields: ['size'], before: { size: { width: 1080, height: 1920 } }, after: { size: { width: 1080, height: 1080 } } });
  });
  it('a successful call that changes nothing has no timelineChanges and writes no entry (moveItem by 0)', () => {
    const e = editor(); const r = call(e, 'moveItem', { itemId: 'v3', by: 0 });
    expect(r.success).toBe(true); expect(r.timelineChanges).toBeUndefined(); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('a refusal never carries timelineChanges (every refused call in these files already asserts it); the net change ignores steps that cancel out', () => {
    const e = editor(); const r = call(e, 'cloneItem', { itemId: 'v1', trackId: 'V2' });
    call(e, 'deleteItems', { itemIds: [r.data.itemId] }); expect(json(e.doc)).toBe(json(editor().doc)); // clone then delete: document back to the start
  });
});

describe('markers, canvas and consolidate through the tools (results §2 resizeCanvas; findings part 2 §35, §36)', () => {
  it('resizeCanvas: fixed sizes, message and data, "Resize canvas"; same size → success without a change', () => {
    const e = editor(); const r = call(e, 'resizeCanvas', { aspectRatio: '16:9' });
    expect(r).toMatchObject({ success: true, message: 'Canvas resized to 16:9 (1920x1080).', data: { aspectRatio: '16:9', width: 1920, height: 1080 } });
    expect(e.doc.size).toEqual({ width: 1920, height: 1080 }); only(e, 'Resize canvas');
    const again = call(e, 'resizeCanvas', { aspectRatio: '16:9' }); expect(again.success).toBe(true); expect(again.timelineChanges).toBeUndefined(); expect(e.bus.undoStack).toHaveLength(1);
    const f = editor(); call(f, 'resizeCanvas', { aspectRatio: '9:16' }); expect(f.doc.size).toEqual({ width: 1080, height: 1920 });
  });
  it('resizeCanvas failure: INVALID_ASPECT_RATIO with the exact error and message', () => {
    const e = editor(); const b = json(e.doc); const r = call(e, 'resizeCanvas', { aspectRatio: '4:3' });
    expect(r).toMatchObject({ success: false, code: 'INVALID_ASPECT_RATIO', error: 'Invalid aspect ratio', message: "'4:3' is not valid. Use: 16:9, 9:16, 1:1." }); refused(e, b, r);
  });
  it('manageMarkers: add/update/remove/clear in one "Edit markers" step; times in seconds in, ms stored, sorted by time', () => {
    const e = editor(); const r = call(e, 'manageMarkers', { actions: [{ action: 'add', time: 3, label: 'B' }, { action: 'add', time: 1, label: 'A' }] });
    expect(r.success).toBe(true); expect(e.doc.markers.map(m => [m.timeMs, m.label])).toEqual([[1000, 'A'], [3000, 'B']]); only(e, 'Edit markers');
    const [a] = e.doc.markers; call(e, 'manageMarkers', { actions: [{ action: 'update', markerId: a.id, time: 5, label: 'A2' }] });
    expect(e.doc.markers.map(m => [m.timeMs, m.label])).toEqual([[3000, 'B'], [5000, 'A2']]);
    call(e, 'manageMarkers', { actions: [{ action: 'remove', markerId: a.id }] }); expect(e.doc.markers).toHaveLength(1);
    call(e, 'manageMarkers', { actions: [{ action: 'clear' }] }); expect(e.doc.markers).toEqual([]);
    expect(e.bus.undoStack.map(x => x.label)).toEqual(['Edit markers', 'Edit markers', 'Edit markers', 'Edit markers']);
  });
  it('manageMarkers failures roll the whole call back: unknown marker, negative time, unknown action', () => {
    for (const actions of [[{ action: 'add', time: 1 }, { action: 'remove', markerId: 'nope' }], [{ action: 'add', time: -1 }], [{ action: 'zap' }]]) {
      const e = editor(); const b = json(e.doc); const r = call(e, 'manageMarkers', { actions }); expect(r.success).toBe(false); refused(e, b, r);
    }
  });
  it('consolidateTracks: items slide to the lowest qualifying same-kind unlocked track; message and counts; "Consolidate tracks"', () => {
    const d = fixture(); d.items.push(video('x', 'V2', 8000, 10000) as never);
    const e = editor(d); const r = call(e, 'consolidateTracks', {});
    expect(r).toMatchObject({ success: true, moved: 1, deletedTrackIds: [], message: 'Consolidated 1 item(s); empty tracks were preserved.' });
    expect(itemOf(e.doc, 'x').trackId).toBe('V1'); only(e, 'Consolidate tracks');
    expect(call(e, 'consolidateTracks', {})).toMatchObject({ success: true, moved: 0, message: 'Tracks are already consolidated.' }); expect(e.bus.undoStack).toHaveLength(1);
  });
  it('consolidateTracks deleteEmptyTracks removes the emptied unlocked tracks (never captions) and reports them', () => {
    const d = fixture(); d.items.push(video('x', 'V2', 8000, 10000) as never);
    const e = editor(d); const r = call(e, 'consolidateTracks', { deleteEmptyTracks: true });
    expect(r).toMatchObject({ success: true, moved: 1, deletedTrackIds: ['V2'], message: 'Consolidated 1 item(s) and deleted 1 empty track(s).' });
    expect(e.doc.tracks.some(t => t.id === 'V2')).toBe(false); expect(e.doc.tracks.some(t => t.id === 'C1')).toBe(true);
  });
  it('consolidateTracks leaves locked tracks alone and reports unknown ids without changing anything', () => {
    const d = lockTrack(fixture(), 'V1'); d.items.push(video('x', 'V2', 8000, 10000) as never);
    const e = editor(d); expect(call(e, 'consolidateTracks', {}).moved).toBe(0); expect(itemOf(e.doc, 'x').trackId).toBe('V2');
    const f = editor(); expect(call(f, 'consolidateTracks', { trackIds: ['V1', 'zzz'] })).toMatchObject({ success: false, moved: 0, deletedTrackIds: [], message: 'Unknown track id(s): zzz' }); expect(f.bus.undoStack).toHaveLength(0);
  });
});

// ---- Consolidate acceptance: the W3-RT-16 layout (findings part 2 §35, "Cutframe parity test" l.489). Every number and message below is copied from §35 l.470-489.
// Layout bottom-first: A2 music copy 12-20 s, A1 music 0-10 s, V1 speech 0-10 s, V2 action 12-22 s, V3 action copy 3-8 s, V4 locked action 25-30 s, C caption 2.96-4.84 s.
// Extras, placed ONLY where a case needs them (all between V4 and C): V5 empty unlocked video + V6 empty locked video (case 3), a locked group g7 {V7, V8} of two empty video tracks (cases 7, 7b).
describe('written-spec oracle (§35 W3-RT-16): consolidateTracks acceptance fixtures', () => {
  const w3 = (o: { v5v6?: boolean; group?: boolean } = {}) => {
    const tracks = [mkTrack('A2', 'audio'), mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('V2', 'video'), mkTrack('V3', 'video'), mkTrack('V4', 'video', { locked: true })];
    const order: ProjectDocument['layerOrder'] = tracks.map(t => ({ type: 'track' as const, id: t.id as string }));
    const groups: ProjectDocument['groups'] = {};
    if (o.v5v6) { tracks.push(mkTrack('V5', 'video'), mkTrack('V6', 'video', { locked: true })); order.push({ type: 'track', id: 'V5' }, { type: 'track', id: 'V6' }); }
    if (o.group) {
      tracks.push(mkTrack('V7', 'video'), mkTrack('V8', 'video')); order.push({ type: 'group', id: 'g7' });
      groups.g7 = { id: 'g7', name: 'Locked pair', children: [{ type: 'track', id: 'V7' }, { type: 'track', id: 'V8' }], hidden: false, locked: true };
    }
    tracks.push(mkTrack('C', 'caption')); order.push({ type: 'track', id: 'C' });
    const audio = (id: string, trackId: string, from: number, to: number) => mkItem(id, trackId, from, to, { type: 'audio', trim: { from: 0, to: to - from }, sourceDuration: 20000, metadata: { assetId: 'asset-aud1' } });
    return build({ tracks, layerOrder: order, groups, items: [
      audio('music-copy', 'A2', 12000, 20000), audio('music', 'A1', 0, 10000), video('speech', 'V1', 0, 10000), video('action', 'V2', 12000, 22000),
      video('action-copy', 'V3', 3000, 8000), video('action-locked', 'V4', 25000, 30000), mkItem('cap', 'C', 2960, 4840, { type: 'caption', details: { text: 'caption' } }),
    ] });
  };
  const map = (d: ProjectDocument) => Object.fromEntries(d.items.map(i => [i.id, i.trackId]));
  const SAME = { 'music-copy': 'A2', speech: 'V1', 'action-locked': 'V4', cap: 'C' };
  const DEFAULT_MOVES = { ...SAME, music: 'A2', action: 'V1', 'action-copy': 'V2' }; // V2 -> V1, V3 -> V2, A1 -> A2
  const SUBSET_MOVES = { ...SAME, music: 'A1', action: 'V1', 'action-copy': 'V2' }; // audio is outside [V1,V2,V3] and stays on A1
  const reply = (r: { success: boolean; moved: number; deletedTrackIds: string[]; message: string }) => ({ success: r.success, moved: r.moved, deletedTrackIds: r.deletedTrackIds, message: r.message });
  const stable = (d: ProjectDocument) => { const c = structuredClone(d); c.rev = 0; return c; };
  /** One successful call, with everything every case must assert: reply, item->track map, only trackId changed, exactly 1 entry, one Undo restores the fixture. */
  const run = (doc: ProjectDocument, args: Record<string, unknown>, want: { reply: ReturnType<typeof reply>; items: Record<string, string>; deleted?: string[] }) => {
    const e = editor(doc); const original = stable(e.doc); const r = call(e, 'consolidateTracks', args);
    expect(reply(r)).toEqual(want.reply); expect(map(e.doc)).toEqual(want.items);
    const items = structuredClone(e.doc.items); for (const i of items) i.trackId = original.items.find(o => o.id === i.id)!.trackId;
    expect(items).toEqual(original.items); // no field of any item changed except trackId
    const gone = want.deleted ?? []; expect(e.doc.tracks.map(t => t.id)).toEqual(original.tracks.map(t => t.id).filter(id => !gone.includes(id)));
    for (const t of e.doc.tracks) expect(t).toEqual(original.tracks.find(o => o.id === t.id)); // remaining tracks otherwise untouched (locks, names, flags)
    expect(e.doc.markers).toEqual(original.markers); expect(e.doc.duration).toBe(original.duration); expect(e.doc.groups).toEqual(original.groups);
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label: 'Consolidate tracks', source: 'agent' }); expect(e.journal).toHaveLength(1);
    const after = stackOf(e); expect(e.bus.undo('agent')).not.toBeNull();
    expect(stable(e.doc)).toEqual(original); expect(e.bus.undoStack).toHaveLength(0); // one Undo restores all tracks and every item
    return { r, after };
  };

  it('1. defaults {}: moved 3 (V2->V1, V3->V2, A1->A2), nothing deleted, "Consolidated 3 item(s); empty tracks were preserved."', () => {
    run(w3(), {}, { reply: { success: true, moved: 3, deletedTrackIds: [], message: 'Consolidated 3 item(s); empty tracks were preserved.' }, items: DEFAULT_MOVES });
  });
  it('2. {deleteEmptyTracks:true}: the same 3 moves, A1 and V3 deleted, "Consolidated 3 item(s) and deleted 2 empty track(s)."; remaining orders renumbered (l.478)', () => {
    const { r, after } = run(w3(), { deleteEmptyTracks: true },
      { reply: { success: true, moved: 3, deletedTrackIds: ['A1', 'V3'], message: 'Consolidated 3 item(s) and deleted 2 empty track(s).' }, items: DEFAULT_MOVES, deleted: ['A1', 'V3'] });
    // order is the stack index (bottom = 0): the 5 remaining tracks are 0..4, so V4 (was 5) and C (was 6) moved down
    expect(after).toEqual(['A2', 'V1', 'V2', 'V4', 'C']);
    const orders = Object.fromEntries(r.timelineChanges.tracks.updated.map((u: { id: string; after: { order: number } }) => [u.id, u.after.order]));
    expect(orders).toEqual({ V1: 1, V2: 2, V4: 3, C: 4 }); // A2 stays 0, so it is not reported as updated; before: V1 2, V2 3, V4 5, C 6
    expect(r.timelineChanges.tracks.deleted.map((t: { id: string }) => t.id).sort()).toEqual(['A1', 'V3']);
  });
  it('3. {trackIds:[V1,V2,V3], deleteEmptyTracks:true} with empty V5 and locked empty V6: moved 2, only V3 deleted, V5 and V6 kept (l.489 Cutframe scope)', () => {
    const doc = w3({ v5v6: true }); const e = editor(doc);
    call(e, 'consolidateTracks', { trackIds: ['V1', 'V2', 'V3'], deleteEmptyTracks: true });
    for (const kept of ['V5', 'V6', 'A1', 'V4', 'C']) expect(e.doc.tracks.some(t => t.id === kept), kept).toBe(true); // unselected empty, locked empty, audio outside the set: all kept
    run(doc, { trackIds: ['V1', 'V2', 'V3'], deleteEmptyTracks: true },
      { reply: { success: true, moved: 2, deletedTrackIds: ['V3'], message: 'Consolidated 2 item(s) and deleted 1 empty track(s).' }, items: SUBSET_MOVES, deleted: ['V3'] });
  });
  it('4. {trackIds:[V1,V2]} on the packed result: moved 0, "Tracks are already consolidated.", document unchanged, no entry', () => {
    const packed = editor(w3()); call(packed, 'consolidateTracks', {});
    const e = editor(packed.doc); const before = json(e.doc); const r = call(e, 'consolidateTracks', { trackIds: ['V1', 'V2'] });
    expect(reply(r)).toEqual({ success: true, moved: 0, deletedTrackIds: [], message: 'Tracks are already consolidated.' });
    expect(json(e.doc)).toBe(before); expect(map(e.doc)).toEqual(DEFAULT_MOVES); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('5. unknown id: exactly {success:false, moved:0, deletedTrackIds:[], message:"Unknown track id(s): zzz-not-a-track"}; nothing changes, no entry', () => {
    const e = editor(w3()); const before = json(e.doc); const r = call(e, 'consolidateTracks', { trackIds: ['zzz-not-a-track'] });
    expect(r).toEqual({ success: false, moved: 0, deletedTrackIds: [], message: 'Unknown track id(s): zzz-not-a-track' });
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('6. trackIds: [] is refused before any change: INVALID_TOOL_INPUT / MINITEMS, document byte-identical, no entry', () => {
    const e = editor(w3()); const before = json(e.doc); const r = call(e, 'consolidateTracks', { trackIds: [] });
    expect(r).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT' }); expect(JSON.stringify(r)).toContain('MINITEMS');
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('7. locked group {V7,V8} present + deleteEmptyTracks: the group is untouched, moved 3, deleted [A1,V3] (Xapp fails with PROJECT_UNAVAILABLE "Group is locked": documented difference)', () => {
    const doc = w3({ group: true });
    run(doc, { deleteEmptyTracks: true },
      { reply: { success: true, moved: 3, deletedTrackIds: ['A1', 'V3'], message: 'Consolidated 3 item(s) and deleted 2 empty track(s).' }, items: DEFAULT_MOVES, deleted: ['A1', 'V3'] });
    const e = editor(doc); call(e, 'consolidateTracks', { deleteEmptyTracks: true });
    expect(e.doc.groups.g7).toEqual(doc.groups.g7); expect(e.doc.layerOrder.some(x => x.id === 'g7')).toBe(true);
    for (const id of ['V7', 'V8']) expect(e.doc.tracks.some(t => t.id === id), id).toBe(true);
  });
  it('7b. the same locked group with trackIds:[A1,A2]: moved 1 (A1 -> A2), deleted [A1], message from the l.475 format', () => {
    run(w3({ group: true }), { trackIds: ['A1', 'A2'], deleteEmptyTracks: true },
      { reply: { success: true, moved: 1, deletedTrackIds: ['A1'], message: 'Consolidated 1 item(s) and deleted 1 empty track(s).' }, items: { ...SAME, music: 'A2', action: 'V2', 'action-copy': 'V3' }, deleted: ['A1'] });
  });
});

// ---- Consolidate occlusion rule (findings part 2 §35 l.472-473). Spec, l.473 verbatim: "For each item, the target is the lowest track (bottom-most first) that has the same kind, is unlocked and in the set,
// has no time overlap with the item, and — for non-audio items — has no non-audio item on any track between the target and the source that overlaps the item in time (so moving down never slides a visual
// under something it used to cover). Audio items skip that occlusion check. If no lower track qualifies, the item stays." l.472: locked tracks are skipped as sources and as targets (their items still count for occlusion).
describe('written-spec oracle (findings part 2 §35 l.472-473): consolidateTracks occlusion', () => {
  const audioItem = (id: string, trackId: string, from: number, to: number) => mkItem(id, trackId, from, to, { type: 'audio', trim: { from: 0, to: to - from }, sourceDuration: 20000, metadata: { assetId: 'asset-aud1' } });
  const map = (d: ProjectDocument) => Object.fromEntries(d.items.map(i => [i.id, i.trackId]));
  /** tracks are listed bottom-first (layerOrder index 0 = bottom); one call with defaults; asserts the reply, the item->track map and that only trackId of the moved items changed. */
  const occ = (tracks: ReturnType<typeof mkTrack>[], docItems: ReturnType<typeof mkItem>[], want: { moved: number; items: Record<string, string> }) => {
    const e = editor(build({ tracks, items: docItems })); const before = json(e.doc); const originalItems = structuredClone(e.doc.items); const r = call(e, 'consolidateTracks', {});
    expect({ success: r.success, moved: r.moved, deletedTrackIds: r.deletedTrackIds, message: r.message }).toEqual({ success: true, moved: want.moved, deletedTrackIds: [],
      message: want.moved ? `Consolidated ${want.moved} item(s); empty tracks were preserved.` : 'Tracks are already consolidated.' });
    expect(map(e.doc)).toEqual(want.items);
    const items = structuredClone(e.doc.items); for (const i of items) i.trackId = originalItems.find(o => o.id === i.id)!.trackId; expect(items).toEqual(originalItems); // only trackId changed
    expect(e.doc.tracks.map(t => t.id)).toEqual(tracks.map(t => t.id));
    if (want.moved) { expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label: 'Consolidate tracks', source: 'agent' }); expect(e.journal).toHaveLength(1); }
    else { expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0); }
  };

  it('a. a locked middle track still occludes: V3 stays under the locked V2 item, and the locked V2 is not a target', () => {
    occ([mkTrack('V1', 'video'), mkTrack('V2', 'video', { locked: true }), mkTrack('V3', 'video')], [video('locked-item', 'V2', 2000, 9000), video('upper', 'V3', 3000, 8000)],
      { moved: 0, items: { 'locked-item': 'V2', upper: 'V3' } });
  });
  it('b. the same layout with the locked item clear of the moving item (9-12 s): V3 moves down past the locked V2 to V1', () => {
    occ([mkTrack('V1', 'video'), mkTrack('V2', 'video', { locked: true }), mkTrack('V3', 'video')], [video('locked-item', 'V2', 9000, 12000), video('upper', 'V3', 3000, 8000)],
      { moved: 1, items: { 'locked-item': 'V2', upper: 'V1' } });
  });
  it('c. a non-audio item on a track between (an overlay text 0-5 s) blocks the video from moving below it; the text has no lower overlay track and stays', () => {
    occ([mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('V2', 'video')], [mkItem('text-between', 'O1', 0, 5000, { type: 'text', details: { text: 'between' } }), video('upper', 'V2', 3000, 8000)],
      { moved: 0, items: { 'text-between': 'O1', upper: 'V2' } });
  });
  it('d. audio skips the occlusion check: audio under a locked audio track moves to the empty bottom track, the locked track is neither source nor target', () => {
    occ([mkTrack('A-bottom', 'audio'), mkTrack('A-locked', 'audio', { locked: true }), mkTrack('A-top', 'audio')], [audioItem('locked-audio', 'A-locked', 0, 9000), audioItem('top-audio', 'A-top', 1000, 8000)],
      { moved: 1, items: { 'locked-audio': 'A-locked', 'top-audio': 'A-bottom' } });
  });
});
