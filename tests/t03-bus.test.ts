// SPDX-License-Identifier: AGPL-3.0-only
// T03 command bus, undo labels and edit journal. Oracle: ticket § T03; findings part 3 §45.1 (labels), §45.2 (journal), §45.3 (undo grouping);
// agent tool results §1 (timelineChanges); G-01. Tests assert document state, undo entries (label + source) and journal records.
// Provisional (T03 command path notes, "Provisional choices"): empty-stack Undo/Redo is ok:true with no record; "Ripple reorder" for reorderItems;
// "Move track layer" for moveTrackOutOfGroup; "Move to new track" at the bottom of the stack; UI split splits all selected crossing items.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDocument } from '../apps/web/src/store/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { CommandBus, LABELS, snapshot, SNAPSHOT_KEYS } from '../apps/web/src/timeline/bus';
import type { JournalInput } from '../apps/web/src/timeline/bus';
import { EditJournal, FLUSH_COUNT, FLUSH_MS, QUEUE_CAP } from '../apps/web/src/timeline/journal';
import type { JournalRecord } from '../apps/web/src/timeline/journal';
import { createEditor } from '../apps/web/src/timeline/harness';
import { CommandError } from '../apps/web/src/timeline/model';
import { assets, build, fixture, grouped, itemOf, links, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => { resetIds(); vi.useRealTimers(); });

const host = (initial: ProjectDocument = emptyDocument()) => { let doc = structuredClone(initial); return { get: () => doc, set: (d: ProjectDocument) => { doc = d; }, current: () => doc }; };
const mk = (initial?: ProjectDocument, options: ConstructorParameters<typeof CommandBus>[1] = {}) => {
  const h = host(initial), journal: JournalInput[] = [], bus = new CommandBus(h, { journal: r => journal.push(r), ...options });
  return { h, bus, journal };
};
const addMarker = (n: number) => (doc: ProjectDocument) => { doc.markers.push({ id: `m${n}`, timeMs: n * 100 }); };
const editor = (doc = fixture()) => createEditor(doc, { assets: assets(), links: links() });
const json = (d: unknown) => JSON.stringify(d);

describe('bus: one entry per command (ticket § T03; part 3 §45.3)', () => {
  it('a command that changes the document pushes exactly one undo entry and one journal record, tagged with label and source', () => {
    const { h, bus, journal } = mk();
    bus.run('Add marker', 'user', addMarker(1));
    expect(bus.undoStack).toHaveLength(1);
    expect(bus.undoStack[0]).toMatchObject({ label: 'Add marker', source: 'user' });
    expect(h.current().markers).toHaveLength(1);
    expect(journal).toEqual([{ source: 'user', label: 'Add marker', items_before: 0, items_after: 0 }]);
  });
  it('several operations inside one command are one entry (Clone 2 → 1, Split 2 → 1; §45.3)', () => {
    const { h, bus } = mk();
    bus.run('Edit markers', 'agent', doc => { addMarker(1)(doc); addMarker(2)(doc); addMarker(3)(doc); });
    expect(bus.undoStack).toHaveLength(1);
    expect(h.current().markers).toHaveLength(3);
    bus.undo();
    expect(h.current().markers).toHaveLength(0);
  });
  it('a nested run adds no entry and no journal record of its own; the outer label stands', () => {
    const { h, bus, journal } = mk();
    bus.run('Move to new track', 'user', doc => { bus.run('Add marker', 'user', addMarker(1)); bus.run('Add marker', 'user', addMarker(2)); });
    expect(bus.undoStack.map(e => e.label)).toEqual(['Move to new track']);
    expect(journal.map(r => r.label)).toEqual(['Move to new track']);
    expect(h.current().markers).toHaveLength(2);
  });
  it('a command that throws leaves the document byte-identical and adds no entry and no journal record', () => {
    const { h, bus, journal } = mk(fixture());
    const before = json(h.current());
    expect(() => bus.run('Delete items', 'agent', doc => { doc.items.pop(); doc.tracks.length = 0; throw new CommandError('X', 'boom'); })).toThrow('boom');
    expect(json(h.current())).toBe(before);
    expect(bus.undoStack).toHaveLength(0); expect(bus.redoStack).toHaveLength(0); expect(journal).toEqual([]);
    expect(bus.running).toBe(false);
  });
  it('a throw inside a nested run rolls back the whole outer command', () => {
    const { h, bus, journal } = mk();
    const before = json(h.current());
    expect(() => bus.run('Edit markers', 'agent', () => { bus.run('Add marker', 'agent', addMarker(1)); bus.run('Add marker', 'agent', () => { throw new CommandError('X', 'inner'); }); })).toThrow('inner');
    expect(json(h.current())).toBe(before); expect(bus.undoStack).toHaveLength(0); expect(journal).toEqual([]);
  });
  it('the host document is only replaced on success (the running command sees a draft)', () => {
    const { h, bus } = mk();
    bus.run('Add marker', 'user', doc => { addMarker(1)(doc); expect(h.current().markers).toHaveLength(0); expect(bus.doc.markers).toHaveLength(1); });
    expect(h.current().markers).toHaveLength(1);
  });
  it('entries keep before/after snapshots of the ten snapshot parts (findings §4)', () => {
    expect([...SNAPSHOT_KEYS]).toEqual(['items', 'tracks', 'transitions', 'markers', 'layerOrder', 'groups', 'duration', 'fps', 'size', 'background']);
    const { bus } = mk(fixture());
    bus.run('Resize canvas', 'user', doc => { doc.size = { width: 1920, height: 1080 }; });
    const e = bus.undoStack[0];
    expect(Object.keys(e.before).sort()).toEqual([...SNAPSHOT_KEYS].sort());
    expect(e.before.size).toEqual({ width: 1080, height: 1920 }); expect(e.after.size).toEqual({ width: 1920, height: 1080 });
    expect(e.before.items).toEqual(fixture().items);
  });
});

describe('bus: no-op rule (part 3 §45.3; ticket: content compare is the default, reference mode is parity)', () => {
  it('default (content): a command that writes an equal value creates no entry and no journal record', () => {
    const { bus, journal } = mk(fixture());
    bus.run('Edit items', 'user', doc => { doc.items.find(i => i.id === 'v1')!.properties = {}; });
    expect(bus.undoStack).toHaveLength(0); expect(journal).toHaveLength(0);
  });
  it('default (content): a command that writes nothing creates no entry', () => {
    const { bus } = mk();
    bus.run('Edit items', 'user', () => undefined);
    expect(bus.undoStack).toHaveLength(0);
  });
  it("noOp 'reference': a command that re-commits an equal value still creates an \"Edit items\" entry (§45.3: collapsing the text Animation section)", () => {
    const { bus, journal } = mk(fixture(), { noOp: 'reference' });
    bus.run('Edit items', 'user', doc => { doc.items.find(i => i.id === 'v1')!.properties = {}; });
    expect(bus.undoStack.map(e => e.label)).toEqual(['Edit items']); expect(journal.map(r => r.label)).toEqual(['Edit items']);
  });
  it("noOp 'reference': a command that marks tx.noop (wrote nothing) is skipped", () => {
    const { bus, journal } = mk(fixture(), { noOp: 'reference' });
    bus.run('Edit items', 'user', (_d, tx) => { tx.noop = true; });
    expect(bus.undoStack).toHaveLength(0); expect(journal).toHaveLength(0);
  });
});

describe('bus: history cap, undo/redo, redo clearing (ticket § T03)', () => {
  it('the cap is 100: the 101st command drops the oldest entry', () => {
    const { bus } = mk();
    for (let n = 1; n <= 101; n++) bus.run('Add marker', 'user', addMarker(n));
    expect(bus.undoStack).toHaveLength(100);
    expect(bus.undoStack[0].after.markers).toHaveLength(2); // entry 1 (1 marker) is gone; the oldest left is command 2
    expect(bus.undoStack[99].after.markers).toHaveLength(101);
  });
  it('undo then redo round-trips exactly 100 steps, byte-identical to the state before / after', () => {
    const { h, bus } = mk();
    for (let n = 1; n <= 100; n++) bus.run('Add marker', 'user', addMarker(n));
    const full = json(h.current());
    for (let n = 0; n < 100; n++) expect(bus.undo()).not.toBeNull();
    expect(h.current().markers).toHaveLength(0); expect(bus.canUndo()).toBe(false); expect(bus.canRedo()).toBe(true);
    expect(bus.undo()).toBeNull();
    for (let n = 0; n < 100; n++) expect(bus.redo()).not.toBeNull();
    expect(json(h.current())).toBe(full); expect(bus.canRedo()).toBe(false);
    expect(bus.redo()).toBeNull();
  });
  it('after 101 commands only 100 undo steps exist, back to the state after command 1', () => {
    const { h, bus } = mk();
    for (let n = 1; n <= 101; n++) bus.run('Add marker', 'user', addMarker(n));
    let steps = 0; while (bus.undo()) steps++;
    expect(steps).toBe(100); expect(h.current().markers).toHaveLength(1);
  });
  it('a new command clears the redo stack', () => {
    const { bus } = mk();
    bus.run('Add marker', 'user', addMarker(1)); bus.run('Add marker', 'user', addMarker(2));
    bus.undo(); expect(bus.canRedo()).toBe(true);
    bus.run('Add marker', 'user', addMarker(3));
    expect(bus.canRedo()).toBe(false); expect(bus.redoStack).toHaveLength(0);
  });
  it('undo restores the exact snapshot and redo re-applies it (labels stay on the entry)', () => {
    const e = editor();
    const start = snapshot(e.doc);
    e.call('deleteItems', { itemIds: ['v1'] });
    expect(e.doc.items.some(i => i.id === 'v1')).toBe(false);
    const entry = e.bus.undo('agent');
    expect(entry?.label).toBe('Delete items'); expect(json(snapshot(e.doc))).toBe(json(start));
    e.bus.redo('agent');
    expect(e.doc.items.some(i => i.id === 'v1')).toBe(false);
  });
  it('duration follows the content end after item edits (G-01)', () => {
    const e = editor();
    expect(e.doc.duration).toBe(12000);
    e.call('deleteItems', { itemIds: ['v3'] });
    expect(e.doc.duration).toBe(8000); // c3 ends at 6000, v2 at 8000
    e.bus.undo();
    expect(e.doc.duration).toBe(12000);
    e.call('deleteItems', { itemIds: ['v1', 'v2', 'v3', 'a1', 't1', 'c1', 'c2', 'c3'] });
    expect(e.doc.duration).toBe(1000); // an empty timeline keeps the 1000 ms default (T03 notes, provisional)
  });
  it('duration does not change for a settings/track command that leaves items alone', () => {
    const e = editor(); e.doc.duration; // 12000
    e.call('manageTrack', { action: 'create', kind: 'video' });
    expect(e.doc.duration).toBe(12000);
  });
  it('undo/redo with an empty stack is ok:true, changes nothing and writes no journal record (provisional)', () => {
    const e = editor(); const before = json(e.doc);
    expect(e.intent({ type: 'undo' })).toEqual({ ok: true }); expect(e.intent({ type: 'redo' })).toEqual({ ok: true });
    expect(json(e.doc)).toBe(before); expect(e.journal).toEqual([]);
  });
  it('bus.subscribe is notified on command, undo, redo and clear; clear empties both stacks', () => {
    const { bus } = mk(); const seen: number[] = []; const off = bus.subscribe(() => seen.push(1));
    bus.run('Add marker', 'user', addMarker(1)); bus.undo(); bus.redo(); bus.clear();
    expect(seen).toHaveLength(4); expect(bus.undoStack).toHaveLength(0); expect(bus.redoStack).toHaveLength(0);
    off(); bus.run('Add marker', 'user', addMarker(2)); expect(seen).toHaveLength(4);
  });
});

describe('labels: the 52 labels of part 3 §45.1', () => {
  it('LABELS lists 52 distinct labels', () => {
    expect(LABELS).toHaveLength(52); expect(new Set(LABELS).size).toBe(52);
  });
  it('contains every label named in §45.1 groups (Items, Tracks, Groups, Ripple, Project, Markers, Captions + agent)', () => {
    for (const l of ['Add items', 'Edit items', 'Delete items', 'Split item', 'Split items', 'Move item', 'Move items', 'Slip item', 'Duplicate items', 'Insert items', 'Change speed', 'Move to new track',
      'Create track', 'Delete track', 'Rename track', 'Set track flag', 'Set track volume', 'Resize track', 'Move track layer', 'Move item out of group',
      'Group tracks', 'Rename group', 'Change group tracks', 'Reorder group', 'Move group', 'Set group flag', 'Ungroup tracks', 'Delete group',
      'Ripple trim', 'Ripple group trim', 'Ripple delete', 'Ripple group delete', 'Ripple reorder', 'Resize canvas', 'Add marker', 'Remove marker', 'Clear markers', 'Edit markers',
      'Add media', 'Consolidate tracks']) expect(LABELS, l).toContain(l);
  });
});

type Case = { name: string; label: string; doc?: () => ProjectDocument; run: (e: ReturnType<typeof editor>) => unknown };
const lastEntry = (e: ReturnType<typeof editor>) => e.bus.undoStack.at(-1)!;

// Every tool: one call → one undo entry whose label equals the journal record's label, source 'agent' (label parity, part 3 §45.1).
const TOOL_CASES: Case[] = [
  { name: 'addMedia with trackId', label: 'Add media', run: e => e.call('addMedia', { trackId: 'V2', timelineStart: 0, items: [{ assetId: 'video_1' }] }) },
  { name: 'addMedia with insertAfterItemId', label: 'Insert items', run: e => e.call('addMedia', { insertAfterItemId: 'v1', items: [{ assetId: 'video_2' }] }) },
  { name: 'changeTrack', label: 'Move items', run: e => e.call('changeTrack', { itemId: 'v3', trackId: 'V2' }) },
  { name: 'cloneItem', label: 'Duplicate items', run: e => e.call('cloneItem', { itemId: 'v1', trackId: 'V2' }) },
  { name: 'deleteItems', label: 'Delete items', run: e => e.call('deleteItems', { itemIds: ['v3'] }) },
  { name: 'deleteItems ripple', label: 'Ripple delete', run: e => e.call('deleteItems', { itemIds: ['v1'], ripple: true }) },
  { name: 'deleteItems rippleGroupId', label: 'Ripple group delete', doc: grouped, run: e => e.call('deleteItems', { itemIds: ['v1', 'w1'], rippleGroupId: 'g1' }) },
  { name: 'moveItem one item', label: 'Move item', run: e => e.call('moveItem', { itemId: 'v3', by: 1 }) },
  { name: 'moveItem several items', label: 'Move items', run: e => e.call('moveItem', { itemIds: ['v3', 'a1'], by: 1 }) },
  { name: 'moveItem groupId + by', label: 'Move group', doc: grouped, run: e => e.call('moveItem', { groupId: 'g1', by: 1 }) },
  { name: 'moveItem beforeItemId (delegates to reorderItems)', label: 'Ripple reorder', run: e => e.call('moveItem', { itemId: 'v2', beforeItemId: 'v1' }) },
  { name: 'reorderItems', label: 'Ripple reorder', run: e => e.call('reorderItems', { itemIds: ['v2'], beforeItemId: 'v1' }) },
  { name: 'slipItem', label: 'Slip item', run: e => e.call('slipItem', { itemId: 'v1', slipSeconds: 1 }) },
  { name: 'splitItem', label: 'Split item', run: e => e.call('splitItem', { itemId: 'v1', timestampS: 2 }) },
  { name: 'trimItem', label: 'Edit items', run: e => e.call('trimItem', { itemId: 'v3', handle: 'end', deltaSeconds: -0.5 }) },
  { name: 'trimItem ripple', label: 'Ripple trim', run: e => e.call('trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, ripple: true }) },
  { name: 'trimItem rippleGroupId', label: 'Ripple group trim', doc: grouped, run: e => e.call('trimItem', { itemId: 'v1', handle: 'end', deltaSeconds: -1, rippleGroupId: 'g1' }) },
  { name: 'transformItem', label: 'Edit items', run: e => e.call('transformItem', { itemId: 'v1', x: 10 }) },
  { name: 'manageTrack create', label: 'Create track', run: e => e.call('manageTrack', { action: 'create', kind: 'video' }) },
  { name: 'manageTrack delete', label: 'Delete track', run: e => e.call('manageTrack', { action: 'delete', trackId: 'V2' }) },
  { name: 'manageTrack mute', label: 'Set track flag', run: e => e.call('manageTrack', { action: 'mute', trackId: 'V1' }) },
  { name: 'manageTrack solo', label: 'Set track flag', run: e => e.call('manageTrack', { action: 'solo', trackId: 'V1' }) },
  { name: 'manageTrack lock', label: 'Set track flag', run: e => e.call('manageTrack', { action: 'lock', trackId: 'V1' }) },
  { name: 'manageTrack hide', label: 'Set track flag', run: e => e.call('manageTrack', { action: 'hide', trackId: 'V1' }) },
  { name: 'manageTrack volume', label: 'Set track volume', run: e => e.call('manageTrack', { action: 'volume', trackId: 'V1', volume: 0.5 }) },
  { name: 'manageTrack rename', label: 'Rename track', run: e => e.call('manageTrack', { action: 'rename', trackId: 'V1', name: 'Main' }) },
  { name: 'manageTrack reorder', label: 'Move track layer', run: e => e.call('manageTrack', { action: 'reorder', trackId: 'V1', position: 'top' }) },
  { name: 'manageTrackGroup create', label: 'Group tracks', run: e => e.call('manageTrackGroup', { action: 'create', name: 'G', trackIds: ['V1', 'V2'] }) },
  { name: 'manageTrackGroup rename', label: 'Rename group', doc: grouped, run: e => e.call('manageTrackGroup', { action: 'rename', groupId: 'g1', name: 'New' }) },
  { name: 'manageTrackGroup setTracks', label: 'Change group tracks', doc: grouped, run: e => e.call('manageTrackGroup', { action: 'setTracks', groupId: 'g1', trackIds: ['V1', 'V2', 'O1'] }) },
  { name: 'manageTrackGroup reorder', label: 'Reorder group', doc: grouped, run: e => e.call('manageTrackGroup', { action: 'reorder', groupId: 'g1', toIndex: 0 }) },
  { name: 'manageTrackGroup ungroup', label: 'Ungroup tracks', doc: grouped, run: e => e.call('manageTrackGroup', { action: 'ungroup', groupId: 'g1' }) },
  { name: 'manageTrackGroup hide', label: 'Set group flag', doc: grouped, run: e => e.call('manageTrackGroup', { action: 'hide', groupId: 'g1', value: true }) },
  { name: 'manageTrackGroup lock', label: 'Set group flag', doc: grouped, run: e => e.call('manageTrackGroup', { action: 'lock', groupId: 'g1', value: true }) },
  { name: 'manageTrackGroup delete', label: 'Delete group', doc: grouped, run: e => e.call('manageTrackGroup', { action: 'delete', groupId: 'g1' }) },
  { name: 'resizeCanvas', label: 'Resize canvas', run: e => e.call('resizeCanvas', { aspectRatio: '16:9' }) },
  { name: 'consolidateTracks', label: 'Consolidate tracks', doc: () => { const d = fixture(); d.items.push(video('x', 'V2', 8000, 10000) as never); return d; }, run: e => e.call('consolidateTracks', {}) },
  { name: 'manageMarkers', label: 'Edit markers', run: e => e.call('manageMarkers', { actions: [{ action: 'add', time: 1 }] }) },
];
describe('labels: every agent tool writes the expected label to the undo entry AND the journal, source agent (§45.1 label parity)', () => {
  for (const c of TOOL_CASES) it(`${c.name} → "${c.label}"`, () => {
    const e = editor(c.doc?.());
    const r = c.run(e) as { success: boolean; error?: string; code?: string };
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(e.bus.undoStack).toHaveLength(1);
    expect(lastEntry(e)).toMatchObject({ label: c.label, source: 'agent' });
    expect(e.journal).toHaveLength(1);
    expect(e.journal[0]).toMatchObject({ label: c.label, source: 'agent' });
    expect(e.journal[0].label).toBe(lastEntry(e).label);
  });
});

// Every UI intent: same parity with source 'user'.
const imgAsset = 'asset-img1';
const INTENT_CASES: Case[] = [
  { name: 'deleteItems', label: 'Delete items', run: e => e.intent({ type: 'deleteItems', itemIds: ['v3'], ripple: false }) },
  { name: 'deleteItems ripple', label: 'Ripple delete', run: e => e.intent({ type: 'deleteItems', itemIds: ['v1'], ripple: true }) },
  { name: 'deleteItems ripple in a group', label: 'Ripple group delete', doc: grouped, run: e => e.intent({ type: 'deleteItems', itemIds: ['v1', 'w1'], ripple: true }) },
  { name: 'splitItems', label: 'Split items', run: e => e.intent({ type: 'splitItems', itemIds: ['v1'], atMs: 2000 }) },
  { name: 'duplicateItems', label: 'Duplicate items', run: e => e.intent({ type: 'duplicateItems', itemIds: ['v1'] }) },
  { name: 'nudgeItems', label: 'Edit items', run: e => e.intent({ type: 'nudgeItems', itemIds: ['v1'], dx: 5, dy: 0 }) },
  { name: 'pasteItems', label: 'Add items', run: e => e.intent({ type: 'pasteItems', items: [structuredClone(fixture().items.find(i => i.id === 'v1')!)], atMs: 20000 }) },
  { name: 'moveItems one item', label: 'Move item', run: e => e.intent({ type: 'moveItems', itemIds: ['v3'], deltaMs: 500, trackId: null, newTrack: false, ripple: false }) },
  { name: 'moveItems several items', label: 'Move items', run: e => e.intent({ type: 'moveItems', itemIds: ['v3', 'a1'], deltaMs: 500, trackId: null, newTrack: false, ripple: false }) },
  { name: 'moveItems newTrack', label: 'Move to new track', run: e => e.intent({ type: 'moveItems', itemIds: ['v3'], deltaMs: 0, trackId: null, newTrack: true, ripple: false }) },
  { name: 'moveItems ripple (drag-reorder)', label: 'Ripple reorder', run: e => e.intent({ type: 'moveItems', itemIds: ['v2'], deltaMs: -4000, trackId: null, newTrack: false, ripple: true }) },
  { name: 'trimItem', label: 'Edit items', run: e => e.intent({ type: 'trimItem', itemId: 'v3', edge: 'end', deltaMs: -500, ripple: false }) },
  { name: 'trimItem ripple', label: 'Ripple trim', run: e => e.intent({ type: 'trimItem', itemId: 'v1', edge: 'end', deltaMs: -1000, ripple: true }) },
  { name: 'trimItem ripple in a group', label: 'Ripple group trim', doc: grouped, run: e => e.intent({ type: 'trimItem', itemId: 'v1', edge: 'end', deltaMs: -1000, ripple: true }) },
  { name: 'slipItem', label: 'Slip item', run: e => e.intent({ type: 'slipItem', itemId: 'v1', deltaMs: -1000 }) },
  { name: 'moveItemOutOfGroup', label: 'Move item out of group', doc: grouped, run: e => e.intent({ type: 'moveItemOutOfGroup', itemId: 'v1' }) },
  { name: 'placeAssets', label: 'Add items', run: e => e.intent({ type: 'placeAssets', assetIds: ['asset-vid1'], name: 'x' }) },
  { name: 'drop assets on a lane', label: 'Add items', run: e => e.intent({ type: 'drop', payload: { kind: 'assets', items: [{ assetId: 'asset-vid2' }] } as never, trackId: 'V1', timeMs: 0, below: false }) },
  { name: 'addMarker', label: 'Add marker', run: e => e.intent({ type: 'addMarker', timeMs: 1000 }) },
  { name: 'removeMarker', label: 'Remove marker', doc: () => build({ ...{ tracks: [mkTrack('V1', 'video')], markers: [{ id: 'm1', timeMs: 100 }] } }), run: e => e.intent({ type: 'removeMarker', markerId: 'm1' }) },
  { name: 'clearMarkers', label: 'Clear markers', doc: () => build({ tracks: [mkTrack('V1', 'video')], markers: [{ id: 'm1', timeMs: 100 }, { id: 'm2', timeMs: 200 }] }), run: e => e.intent({ type: 'clearMarkers', count: 2 }) },
  { name: 'deleteTrack', label: 'Delete track', run: e => e.intent({ type: 'deleteTrack', trackId: 'V2' }) },
  { name: 'renameTrack', label: 'Rename track', run: e => e.intent({ type: 'renameTrack', trackId: 'V1', name: 'Main' }) },
  { name: 'setTrackFlag', label: 'Set track flag', run: e => e.intent({ type: 'setTrackFlag', trackId: 'V1', flag: 'muted', value: true }) },
  { name: 'setTrackVolume', label: 'Set track volume', run: e => e.intent({ type: 'setTrackVolume', trackId: 'V1', volume: 0.5 }) },
  { name: 'resizeTrack', label: 'Resize track', run: e => e.intent({ type: 'resizeTrack', trackId: 'V1', height: 80 }) },
  { name: 'moveTrackLayer', label: 'Move track layer', run: e => e.intent({ type: 'moveTrackLayer', trackId: 'V1', beforeTrackId: null }) },
  { name: 'moveTrackOutOfGroup (provisional label)', label: 'Move track layer', doc: grouped, run: e => e.intent({ type: 'moveTrackOutOfGroup', trackId: 'V1' }) },
  { name: 'groupTracks', label: 'Group tracks', run: e => e.intent({ type: 'groupTracks', trackIds: ['V1', 'V2'], name: 'G' }) },
  { name: 'setGroupFlag', label: 'Set group flag', doc: grouped, run: e => e.intent({ type: 'setGroupFlag', groupId: 'g1', flag: 'locked', value: true }) },
  { name: 'reorderGroup', label: 'Reorder group', doc: grouped, run: e => e.intent({ type: 'reorderGroup', groupId: 'g1', direction: 'up' }) },
  { name: 'ungroupTracks', label: 'Ungroup tracks', doc: grouped, run: e => e.intent({ type: 'ungroupTracks', groupId: 'g1' }) },
  { name: 'deleteGroup', label: 'Delete group', doc: grouped, run: e => e.intent({ type: 'deleteGroup', groupId: 'g1' }) },
  { name: 'resizeCanvas', label: 'Resize canvas', run: e => e.intent({ type: 'resizeCanvas', aspectRatio: '1:1' }) },
];
describe('labels: every UI intent writes the expected label to the undo entry AND the journal, source user', () => {
  for (const c of INTENT_CASES) it(`${c.name} → "${c.label}"`, () => {
    const e = editor(c.doc?.());
    const r = c.run(e) as { ok: boolean; message?: string };
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(e.bus.undoStack).toHaveLength(1);
    expect(lastEntry(e)).toMatchObject({ label: c.label, source: 'user' });
    expect(e.journal).toEqual([expect.objectContaining({ label: c.label, source: 'user' })]);
  });
  void imgAsset;
});

describe('journal records for Undo / Redo (part 3 §45.2: "Undo" / "Redo" records)', () => {
  it('Undo and Redo each write one record with the item counts before and after, and the source of the caller', () => {
    const e = editor();
    e.call('deleteItems', { itemIds: ['v1', 'v2'] });
    e.bus.undo('user'); e.bus.redo('agent');
    expect(e.journal).toEqual([
      { source: 'agent', label: 'Delete items', items_before: 8, items_after: 6 },
      { source: 'user', label: 'Undo', items_before: 6, items_after: 8 },
      { source: 'agent', label: 'Redo', items_before: 8, items_after: 6 },
    ]);
  });
  it('the intents undo / redo run as user and keep one record each', () => {
    const e = editor();
    e.intent({ type: 'addMarker', timeMs: 100 });
    expect(e.intent({ type: 'undo' })).toEqual({ ok: true }); expect(e.intent({ type: 'redo' })).toEqual({ ok: true });
    expect(e.journal.map(r => [r.source, r.label])).toEqual([['user', 'Add marker'], ['user', 'Undo'], ['user', 'Redo']]);
  });
  it('undo of an agent entry restores the document and keeps the entry (label, source agent) on the redo stack', () => {
    const e = editor();
    e.call('splitItem', { itemId: 'v1', timestampS: 2 });
    e.intent({ type: 'undo' });
    expect(e.bus.redoStack).toHaveLength(1); expect(e.bus.redoStack[0]).toMatchObject({ label: 'Split item', source: 'agent' });
    expect(e.doc.items).toHaveLength(8);
  });
});

describe('journal queue and flush (part 3 §45.2: batch ~4 s after the first record; ticket: 4 s, 30 records, hide, cap 1000)', () => {
  const input = (n = 0): JournalInput => ({ source: 'user', label: 'Add marker', items_before: n, items_after: n });
  const setup = () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T00:00:00.000Z'));
    const batches: JournalRecord[][] = [], errors: unknown[] = [];
    const j = new EditJournal('p1', async r => { batches.push(r); }, 'sess-1', undefined, e => errors.push(e));
    return { j, batches, errors };
  };
  it('exposes the documented constants', () => { expect([FLUSH_MS, FLUSH_COUNT, QUEUE_CAP]).toEqual([4000, 30, 1000]); });
  it('records carry exactly {project_id, session_id, source, label, items_before, items_after, seq, client_ts}; seq counts up from 1; client_ts is the ISO time', () => {
    const { j } = setup();
    j.record({ source: 'agent', label: 'Split item', items_before: 3, items_after: 4 });
    vi.advanceTimersByTime(1500); j.record(input());
    expect(Object.keys(j.queue[0]).sort()).toEqual(['client_ts', 'items_after', 'items_before', 'label', 'project_id', 'seq', 'session_id', 'source']);
    expect(j.queue[0]).toEqual({ project_id: 'p1', session_id: 'sess-1', source: 'agent', label: 'Split item', items_before: 3, items_after: 4, seq: 1, client_ts: '2026-10-31T00:00:00.000Z' });
    expect(j.queue[1].seq).toBe(2); expect(j.queue[1].client_ts).toBe('2026-10-31T00:00:01.500Z');
  });
  it('flushes 4 s after the first queued record, not before', async () => {
    const { j, batches } = setup();
    j.record(input());
    await vi.advanceTimersByTimeAsync(FLUSH_MS - 1); expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1); expect(batches[0]).toHaveLength(1); expect(j.queue).toHaveLength(0);
  });
  it('the 4 s timer starts at the FIRST record: later records do not push it back; a batch holds everything queued by then', async () => {
    const { j, batches } = setup();
    j.record(input(1)); await vi.advanceTimersByTimeAsync(3000); j.record(input(2));
    await vi.advanceTimersByTimeAsync(999); expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1); expect(batches[0].map(r => r.items_before)).toEqual([1, 2]);
  });
  it('flushes at once when 30 records are queued; 29 do not', async () => {
    const { j, batches } = setup();
    for (let n = 1; n < FLUSH_COUNT; n++) j.record(input(n));
    expect(batches).toHaveLength(0);
    j.record(input(30));
    expect(batches).toHaveLength(1); expect(batches[0]).toHaveLength(30); expect(batches[0].map(r => r.seq)).toEqual(Array.from({ length: 30 }, (_, k) => k + 1));
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 2); expect(batches).toHaveLength(1); // the timer was cancelled by the flush
  });
  it('after a flush the next record starts a fresh 4 s timer and seq keeps counting', async () => {
    const { j, batches } = setup();
    j.record(input()); await vi.advanceTimersByTimeAsync(FLUSH_MS);
    j.record(input()); await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(batches).toHaveLength(2); expect(batches[1][0].seq).toBe(2);
  });
  it('flushes when the page is hidden (visibilitychange → hidden) and on pagehide; not when it becomes visible; unbind detaches', async () => {
    const { j, batches } = setup();
    const doc = { visibilityState: 'visible', handlers: {} as Record<string, () => void>, addEventListener(t: string, f: () => void) { this.handlers[t] = f; }, removeEventListener(t: string) { delete this.handlers[t]; } };
    const win = { handlers: {} as Record<string, () => void>, addEventListener(t: string, f: () => void) { this.handlers[t] = f; }, removeEventListener(t: string) { delete this.handlers[t]; } };
    const unbind = j.bindLifecycle(doc as never, win as never);
    j.record(input(1)); doc.handlers.visibilitychange(); expect(batches).toHaveLength(0); // visible: no flush
    doc.visibilityState = 'hidden'; doc.handlers.visibilitychange(); await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1);
    j.record(input(2)); win.handlers.pagehide(); await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(2);
    unbind(); expect(Object.keys(doc.handlers)).toEqual([]); expect(Object.keys(win.handlers)).toEqual([]);
  });
  it('flush with an empty queue calls the sink never', async () => {
    const { j, batches } = setup(); await j.flush(); expect(batches).toHaveLength(0);
  });
  it('the queue is capped at 1000: with 1000 records queued a further record drops the oldest (seq 1) — QUEUE_CAP is unreachable through record() alone because it flushes at 30, so the queue is pre-filled', async () => {
    const { j, batches } = setup();
    for (let n = 1; n <= QUEUE_CAP; n++) j.queue.push({ project_id: 'p1', session_id: 'sess-1', ...input(n), seq: n, client_ts: 'x' });
    j.record(input(1001));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1); expect(batches[0]).toHaveLength(QUEUE_CAP);
    expect(batches[0][0].items_before).toBe(2); expect(batches[0].at(-1)!.items_before).toBe(1001);
  });
  it('a failing sink never blocks editing: the batch is dropped and onError is called at most once per minute', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T00:00:00.000Z'));
    const errors: unknown[] = []; let calls = 0;
    const j = new EditJournal('p1', async () => { calls++; throw new Error('db down'); }, 's', undefined, e => errors.push(e));
    const burst = async () => { for (let n = 0; n < FLUSH_COUNT; n++) j.record(input(n)); await vi.advanceTimersByTimeAsync(0); };
    await burst(); expect(calls).toBe(1); expect(errors).toHaveLength(1); expect(j.queue).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30000); await burst(); expect(calls).toBe(2); expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31000); await burst(); expect(calls).toBe(3); expect(errors).toHaveLength(2);
  });
  it('integration: bus commands, agent calls and undo feed the journal with the §45.2 record fields (label + counts + source)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T00:00:00.000Z'));
    const batches: JournalRecord[][] = [];
    const j = new EditJournal('p1', async r => { batches.push(r); }, 'sess-1');
    const e = createEditor(fixture(), { assets: assets(), links: links(), options: { journal: r => j.record(r) } });
    e.intent({ type: 'splitItems', itemIds: ['v1'], atMs: 2000 });               // 8 → 9 items
    e.call('deleteItems', { itemIds: ['v3'] });                                   // 9 → 8
    e.intent({ type: 'undo' });                                                   // 8 → 9
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(batches).toHaveLength(1);
    expect(batches[0].map(({ client_ts: _t, ...r }) => r)).toEqual([
      { project_id: 'p1', session_id: 'sess-1', source: 'user', label: 'Split items', items_before: 8, items_after: 9, seq: 1 },
      { project_id: 'p1', session_id: 'sess-1', source: 'agent', label: 'Delete items', items_before: 9, items_after: 8, seq: 2 },
      { project_id: 'p1', session_id: 'sess-1', source: 'user', label: 'Undo', items_before: 8, items_after: 9, seq: 3 },
    ]);
  });
});

describe('failures leave no undo entry and no journal record (any tool, any intent)', () => {
  it('a refused tool call (COLLISION) leaves the document byte-identical, with no entry, no record and no timelineChanges', () => {
    const e = editor(); const before = json(e.doc);
    const r = e.call('moveItem', { itemId: 'v1', to: 3 }); // overlaps v2 (4–8 s)
    expect(r.success).toBe(false); expect(r.timelineChanges).toBeUndefined();
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toEqual([]);
  });
  it('a refused intent (INVALID_SPLIT_POINT) returns ok:false with the code and writes nothing', () => {
    const e = editor(); const before = json(e.doc);
    const r = e.intent({ type: 'splitItems', itemIds: ['v1'], atMs: 9999 });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_SPLIT_POINT' });
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toEqual([]);
  });
  it('an unknown tool returns UNKNOWN_TOOL and writes nothing', () => {
    const e = editor();
    expect(e.call('nope', {})).toMatchObject({ success: false, code: 'UNKNOWN_TOOL' });
    expect(e.bus.undoStack).toHaveLength(0);
  });
  it('unhandled intents (togglePlayback) return undefined so the T02 NOT_IMPLEMENTED seam stays; T04 now handles editProperty (owner T04) and deleteKeyframe; T05 handles the text drop (Add items)', () => {
    const e = editor();
    expect(e.intent({ type: 'editProperty', itemIds: ['v1'], owner: 'T04', label: 'x', key: 'k', value: 1 })).toMatchObject({ ok: false, code: 'INVALID_PROPERTY' });
    expect(e.intent({ type: 'togglePlayback' })).toBeUndefined();
    expect(e.intent({ type: 'deleteKeyframe' })).toEqual({ ok: true });
    expect(e.bus.undoStack).toHaveLength(0);
    // T05 (assertion edit): the text drop is no longer a seam; it adds a text item as one 'Add items' entry.
    const before = e.doc.items.length, texts = e.doc.items.filter(i => i.type === 'text').length;
    expect(e.intent({ type: 'drop', payload: { kind: 'text' } as never, trackId: null, timeMs: 0, below: false })).toMatchObject({ ok: true });
    expect(e.doc.items.length).toBe(before + 1);
    expect(e.doc.items.filter(i => i.type === 'text')).toHaveLength(texts + 1);
    expect(e.bus.undoStack).toHaveLength(1);
    expect(e.bus.undoStack[0].label).toBe('Add items');
  });
});

void [itemOf, mkItem, video];
