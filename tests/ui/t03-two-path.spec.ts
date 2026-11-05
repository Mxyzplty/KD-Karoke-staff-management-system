// SPDX-License-Identifier: AGPL-3.0-only
// T03 two-path parity (ticket T03 Acceptance l.57, product contract promise 2): every operation that has both a UI intent and an agent tool is run twice from the SAME
// start document, in two fresh editor sessions: once as `activeRuntime.handle(intent)` (source 'user') and once as `activeRuntime.call(tool, args)` (source 'agent').
// Both must give identical project JSON (new ids mapped by creation order, `rev` ignored), identical undo labels and a snapshot that undo restores to the original.
// The user / agent tag is the documented improvement and is excluded. Expected labels come from findings part 3 §45.1 (labels table), not from source output.
import { test, expect, type Page } from '@playwright/test';
import { groupedDoc, openEditor, richDoc, skipTour } from './t02-support';
import { journalRows, liveDoc } from './t03-support';

const vtrack = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1, ...extra });
const vclip = (id: string, trackId: string, from: number, to: number) => ({ id, type: 'video', trackId, display: { from, to }, trim: { from: 0, to: to - from }, sourceDuration: 10000, details: { name: id } });
/** v1: a 0-4000, b 4000-8000, c 9000-12000; v2: d 1000-5000 (trim 2000-6000, room to slip both ways); v3 empty; markers at 2000 and 6000. All clips have 10 s of source, so trims and slips have room. */
const pairDoc = () => richDoc({
  duration: 12000, tracks: [vtrack('v1'), vtrack('v2'), vtrack('v3')], layerOrder: ['v1', 'v2', 'v3'].map(id => ({ type: 'track', id })), groups: {},
  items: [vclip('a', 'v1', 0, 4000), vclip('b', 'v1', 4000, 8000), vclip('c', 'v1', 9000, 12000), { ...vclip('d', 'v2', 1000, 5000), trim: { from: 2000, to: 6000 } }],
  markers: [{ id: 'm1', timeMs: 2000 }, { id: 'm2', timeMs: 6000 }],
});

type Pair = { name: string; doc: () => any; ui: Record<string, unknown>; tool: [string, Record<string, unknown>]; label: string; toolLabel?: string; note?: string };
const move = (itemIds: string[], deltaMs: number, extra: Record<string, unknown> = {}) => ({ type: 'moveItems', itemIds, deltaMs, trackId: null, newTrack: false, ripple: false, ...extra });
const PAIRS: Pair[] = [
  // Items.
  { name: 'split one item', doc: pairDoc, ui: { type: 'splitItems', itemIds: ['b'], atMs: 5500 }, tool: ['splitItem', { itemId: 'b', timestampS: 5.5 }], label: 'Split items', toolLabel: 'Split item', note: 'tool label "Split item" PROVISIONAL (Xapp tool label untraced; part 3 §45.1 Items row)' },
  { name: 'duplicate (clone)', doc: pairDoc, ui: { type: 'duplicateItems', itemIds: ['c'] }, tool: ['cloneItem', { itemId: 'c', trackId: 'v1', at: 12 }], label: 'Duplicate items' },
  { name: 'duplicate an item on another track', doc: pairDoc, ui: { type: 'duplicateItems', itemIds: ['d'] }, tool: ['cloneItem', { itemId: 'd', trackId: 'v2', at: 5 }], label: 'Duplicate items' },
  { name: 'delete', doc: pairDoc, ui: { type: 'deleteItems', itemIds: ['b'], ripple: false }, tool: ['deleteItems', { itemIds: ['b'], ripple: false }], label: 'Delete items' },
  { name: 'delete two items', doc: pairDoc, ui: { type: 'deleteItems', itemIds: ['a', 'c'], ripple: false }, tool: ['deleteItems', { itemIds: ['a', 'c'], ripple: false }], label: 'Delete items' },
  { name: 'ripple delete', doc: pairDoc, ui: { type: 'deleteItems', itemIds: ['b'], ripple: true }, tool: ['deleteItems', { itemIds: ['b'], ripple: true }], label: 'Ripple delete' },
  { name: 'move by a delta', doc: pairDoc, ui: move(['c'], 500), tool: ['moveItem', { itemId: 'c', by: 0.5 }], label: 'Move item' },
  { name: 'move to another track', doc: pairDoc, ui: move(['c'], 0, { trackId: 'v3' }), tool: ['moveItem', { itemId: 'c', trackId: 'v3' }], label: 'Move item' },
  { name: 'move a batch', doc: pairDoc, ui: move(['a', 'b'], 100), tool: ['moveItem', { itemIds: ['a', 'b'], by: 0.1 }], label: 'Move items' },
  { name: 'changeTrack tool vs the UI single-item track move', doc: pairDoc, ui: move(['c'], 0, { trackId: 'v3' }), tool: ['changeTrack', { itemId: 'c', trackId: 'v3' }], label: 'Move item', toolLabel: 'Move items', note: 'tool label "Move items": agent tool results §changeTrack l.369' },
  { name: 'ripple reorder (A to the end of the track)', doc: pairDoc, ui: move(['a'], 12000, { ripple: true }), tool: ['reorderItems', { itemIds: ['a'], afterItemId: 'c' }], label: 'Ripple reorder', note: 'UI anchor rule provisional' },
  { name: 'trim the end', doc: pairDoc, ui: { type: 'trimItem', itemId: 'b', edge: 'end', deltaMs: -1000, ripple: false }, tool: ['trimItem', { itemId: 'b', handle: 'end', deltaSeconds: -1, ripple: false }], label: 'Edit items' },
  { name: 'trim the start', doc: pairDoc, ui: { type: 'trimItem', itemId: 'b', edge: 'start', deltaMs: 500, ripple: false }, tool: ['trimItem', { itemId: 'b', handle: 'start', deltaSeconds: 0.5, ripple: false }], label: 'Edit items' },
  { name: 'ripple trim the end', doc: pairDoc, ui: { type: 'trimItem', itemId: 'b', edge: 'end', deltaMs: -1000, ripple: true }, tool: ['trimItem', { itemId: 'b', handle: 'end', deltaSeconds: -1, ripple: true }], label: 'Ripple trim' },
  { name: 'slip', doc: pairDoc, ui: { type: 'slipItem', itemId: 'd', deltaMs: 300 }, tool: ['slipItem', { itemId: 'd', slipSeconds: -0.3 }], label: 'Slip item', note: 'sign provisional (UI passes -deltaMs)' },
  // Markers (the agent batch writes "Edit markers", the UI one label per action: part 3 §45.1 Markers row).
  { name: 'add a marker', doc: pairDoc, ui: { type: 'addMarker', timeMs: 3000 }, tool: ['manageMarkers', { actions: [{ action: 'add', time: 3 }] }], label: 'Add marker', toolLabel: 'Edit markers' },
  { name: 'remove a marker', doc: pairDoc, ui: { type: 'removeMarker', markerId: 'm1' }, tool: ['manageMarkers', { actions: [{ action: 'remove', markerId: 'm1' }] }], label: 'Remove marker', toolLabel: 'Edit markers' },
  { name: 'clear the markers', doc: pairDoc, ui: { type: 'clearMarkers' }, tool: ['manageMarkers', { actions: [{ action: 'clear' }] }], label: 'Clear markers', toolLabel: 'Edit markers' },
  // Tracks.
  { name: 'rename a track', doc: pairDoc, ui: { type: 'renameTrack', trackId: 'v2', name: 'Camera' }, tool: ['manageTrack', { action: 'rename', trackId: 'v2', name: 'Camera' }], label: 'Rename track' },
  ...(['hidden', 'muted', 'solo', 'locked'] as const).map((flag): Pair => ({
    name: `set the ${flag} flag`, doc: pairDoc, ui: { type: 'setTrackFlag', trackId: 'v1', flag, value: true },
    tool: ['manageTrack', { action: { hidden: 'hide', muted: 'mute', solo: 'solo', locked: 'lock' }[flag], trackId: 'v1', value: true }], label: 'Set track flag',
  })),
  { name: 'set the track volume', doc: pairDoc, ui: { type: 'setTrackVolume', trackId: 'v1', volume: 0.4 }, tool: ['manageTrack', { action: 'volume', trackId: 'v1', volume: 0.4 }], label: 'Set track volume' },
  { name: 'delete an empty track', doc: pairDoc, ui: { type: 'deleteTrack', trackId: 'v3' }, tool: ['manageTrack', { action: 'delete', trackId: 'v3' }], label: 'Delete track' },
  { name: 'delete a track with clips', doc: pairDoc, ui: { type: 'deleteTrack', trackId: 'v2' }, tool: ['manageTrack', { action: 'delete', trackId: 'v2', deleteItems: true }], label: 'Delete track' },
  { name: 'move a track layer', doc: pairDoc, ui: { type: 'moveTrackLayer', trackId: 'v1', beforeTrackId: 'v3' }, tool: ['manageTrack', { action: 'reorder', trackId: 'v1', position: 'above', relativeToTrackId: 'v3' }], label: 'Move track layer', note: 'UI "directly above" is provisional' },
  // Groups.
  { name: 'group two tracks', doc: pairDoc, ui: { type: 'groupTracks', trackIds: ['v1', 'v2'], name: 'Duo' }, tool: ['manageTrackGroup', { action: 'create', trackIds: ['v1', 'v2'], name: 'Duo' }], label: 'Group tracks' },
  { name: 'ungroup', doc: groupedDoc, ui: { type: 'ungroupTracks', groupId: 'g1' }, tool: ['manageTrackGroup', { action: 'ungroup', groupId: 'g1' }], label: 'Ungroup tracks' },
  { name: 'delete a group', doc: groupedDoc, ui: { type: 'deleteGroup', groupId: 'g1' }, tool: ['manageTrackGroup', { action: 'delete', groupId: 'g1' }], label: 'Delete group' },
  { name: 'hide a group', doc: groupedDoc, ui: { type: 'setGroupFlag', groupId: 'g1', flag: 'hidden', value: true }, tool: ['manageTrackGroup', { action: 'hide', groupId: 'g1', value: true }], label: 'Set group flag' },
  { name: 'lock a group', doc: groupedDoc, ui: { type: 'setGroupFlag', groupId: 'g1', flag: 'locked', value: true }, tool: ['manageTrackGroup', { action: 'lock', groupId: 'g1', value: true }], label: 'Set group flag' },
  { name: 'reorder a group up one step', doc: groupedDoc, ui: { type: 'reorderGroup', groupId: 'g1', direction: 'up' }, tool: ['manageTrackGroup', { action: 'reorder', groupId: 'g1', toIndex: 2 }], label: 'Reorder group', note: 'step direction mapping provisional' },
  // Project.
  { name: 'resize the canvas to 9:16', doc: pairDoc, ui: { type: 'resizeCanvas', aspectRatio: '9:16' }, tool: ['resizeCanvas', { aspectRatio: '9:16' }], label: 'Resize canvas' },
  { name: 'resize the canvas to 1:1', doc: pairDoc, ui: { type: 'resizeCanvas', aspectRatio: '1:1' }, tool: ['resizeCanvas', { aspectRatio: '1:1' }], label: 'Resize canvas' },
];

type Run = { ok: boolean; entries: { label: string; source: string }[]; after: any; restored: any };
/** Opens `doc` in a fresh page, runs one path, reads the result, undoes it, and reads the document again. */
async function runPath(page: Page, doc: any, path: 'ui' | 'tool', pair: Pair): Promise<Run & { original: any; id: string }> {
  const id = await openEditor(page, doc); const original = await liveDoc(page);
  const out = await page.evaluate(async ({ path, ui, tool }) => {
    const rt = '/src/timeline/runtime.ts', ed = '/src/editor.tsx';
    const { activeRuntime } = await import(rt), { activeSession } = await import(ed); const snap = () => JSON.parse(JSON.stringify(activeSession.document));
    const r = path === 'ui' ? activeRuntime.handle(ui) : activeRuntime.call(tool[0], tool[1]);
    const ok = path === 'ui' ? !!r && r.ok === true : !!r && r.success !== false;
    const entries = activeRuntime.bus.undoStack.map((e: any) => ({ label: e.label, source: e.source })), after = snap();
    activeRuntime.bus.undo(path === 'ui' ? 'user' : 'agent');
    return { ok, entries, after, restored: snap(), detail: r };
  }, { path, ui: pair.ui, tool: pair.tool });
  expect(out.ok, `${path} path result ${JSON.stringify(out.detail)}`).toBe(true);
  return { ...out, original, id };
}
const walk = (v: any, f: (s: string) => string): any => Array.isArray(v) ? v.map(x => walk(x, f)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), walk(x, f)])) : typeof v === 'string' ? f(v) : v;
const idsOf = (d: any): string[] => [...d.items.map((i: any) => i.id), ...d.tracks.map((t: any) => t.id), ...Object.keys(d.groups ?? {}), ...(d.markers ?? []).map((m: any) => m.id)];
/** Project JSON with every id created by the operation renamed `new#<creation order>` and `rev` zeroed. */
function normal(original: any, after: any) {
  const known = new Set(idsOf(original)), fresh = idsOf(after).filter(i => !known.has(i)), map = new Map(fresh.map((i, k) => [i, `new#${k + 1}`]));
  return { ...walk(after, s => map.get(s) ?? s), rev: 0 };
}
const norev = (d: any) => ({ ...d, rev: 0 });

test.beforeEach(async ({ page }) => { await skipTour(page); });

for (const pair of PAIRS) {
  test(`two-path: ${pair.name}`, async ({ page, context }) => {
    const doc = pair.doc(); const other = await context.newPage(); await skipTour(other);
    const ui = await runPath(page, doc, 'ui', pair), tool = await runPath(other, doc, 'tool', pair);
    expect(norev(ui.original), 'both sessions start from the same document').toEqual(norev(tool.original));
    // 1. identical project JSON.
    expect(normal(tool.original, tool.after), 'agent-path project JSON equals the UI path').toEqual(normal(ui.original, ui.after));
    expect(ui.after.rev === undefined || typeof ui.after.rev === 'number').toBe(true);
    // 2. exactly one undo entry on each path, tagged user / agent, with the oracle label (the tag itself is the documented improvement and not compared).
    expect(ui.entries, 'UI entry').toEqual([{ label: pair.label, source: 'user' }]);
    expect.soft(tool.entries, `tool entry (${pair.note ?? 'label parity per ticket l.57'})`).toEqual([{ label: pair.toolLabel ?? pair.label, source: 'agent' }]);
    expect.soft(tool.entries.map(e => e.label), 'identical undo labels on both paths').toEqual(pair.toolLabel ? [pair.toolLabel] : ui.entries.map(e => e.label));
    // 3. identical undo snapshots: undo returns each session to the original document.
    expect(norev(ui.restored), 'UI undo restores the original').toEqual(norev(ui.original));
    expect(norev(tool.restored), 'tool undo restores the original').toEqual(norev(tool.original));
    await other.close();
  });
}

test('two-path: the journal records source "user" for the UI path and "agent" for the tool path with the same label and item counts', async ({ page, context }) => {
  const pair = PAIRS.find(p => p.name === 'delete')!, doc = pair.doc(); const other = await context.newPage(); await skipTour(other);
  const ui = await runPath(page, doc, 'ui', pair), tool = await runPath(other, doc, 'tool', pair);
  const rows = async (p: Page, id: string) => { await expect.poll(async () => (await journalRows(p, id)).length, { timeout: 10000 }).toBeGreaterThanOrEqual(1); return (await journalRows(p, id)).filter(r => r.label !== 'Undo'); };
  const u = await rows(page, ui.id), a = await rows(other, tool.id);
  expect(u).toHaveLength(1); expect(a).toHaveLength(1);
  expect(u[0]).toMatchObject({ source: 'user', label: 'Delete items', items_before: ui.original.items.length, items_after: ui.original.items.length - 1, seq: 1 });
  expect(a[0]).toMatchObject({ source: 'agent', label: 'Delete items', items_before: tool.original.items.length, items_after: tool.original.items.length - 1, seq: 1 });
  await other.close();
});
