// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger rows 10 and 8 in Chromium: the 23 served tools through a real MCP client against a real editor tab, error codes,
// `context` layout L with the UI's selection and playhead, and the `cutframe://project/state` resource with a user edit.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHelper } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { SERVED_TOOLS } from '../../apps/web/src/agent/protocol';
import { addAsset, createProject, guard, richDoc, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const LINK_KEY = 'cutframe:agent-link:v1';
const URI = 'cutframe://project/state';
const NEVER_READ = "You haven't read the timeline in this session. The current state is attached and the timeline now counts as fresh; retry the call.";
const ITEM = /^item_[a-z0-9]{10}$/, MARKER = /^marker_[a-z0-9]{10}$/, TRACK = /^track_[a-z0-9]{10}$/, GROUP = /^group_[a-z0-9]{10}$/;
const id = (re: RegExp) => expect.stringMatching(re);

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]); // the loopback-only guard
});

type Body = Record<string, any>;
/** A paired tab on a project with richDoc and one image asset, linked to a fresh helper; plus an MCP client on that helper. */
async function connected(page: Page, quietMs = 100) {
  const configDir = mkdtempSync(join(tmpdir(), 't18a-tools-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], quietMs });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T18a tools');
  await addAsset(page, projectId); // agent id image_1
  const token = newToken(); helper.store.add(token);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), token);
  await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected');
  const client = new Client({ name: 't18a', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(r.content).toHaveLength(1); expect(r.content[0].type).toBe('text');
    return { isError: r.isError, body: JSON.parse(r.content[0].text) as Body };
  };
  return { helper, projectId, client, call };
}
const text = (r: { contents: object[] }) => (r.contents[0] as { text: string }).text;
const liveDoc = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); }) as Promise<Body>;
const setView = (page: Page, patch: Record<string, unknown>) => page.evaluate(async patch => { const p = '/src/editor/view.ts'; (await import(p)).setView(patch); }, patch);
/** A user edit made through the editor's own command path (what a click does), not through the agent. */
const userSplit = (page: Page, itemId: string, atMs: number) => page.evaluate(async ({ itemId, atMs }) => {
  const rt = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(rt);
  return activeRuntime.handle({ type: 'splitItems', itemIds: [itemId], atMs }).ok as boolean;
}, { itemId, atMs });

const track = (name: string, kind: string, order: number, layerIndex: number, items: { id: string; start: number; end: number }[], layer?: string) =>
  ({ name, kind, order, layerIndex, ...(layer ? { layer } : {}), muted: false, solo: false, locked: false, hidden: false, volume: 1, type: kind, items });
const CONTEXT = {
  _tracks: 'Tracks are keyed by persistent track id and listed top to bottom (layerIndex 0 draws on top). Empty tracks are included.',
  duration: 20, fps: 30, canvasSize: { width: 1920, height: 1080 },
  tracks: {
    o3: track('O3', 'overlay', 5, 0, [], 'top'), o2: track('O2', 'overlay', 4, 1, [{ id: 'photo', start: 0, end: 4 }]), o1: track('O1', 'overlay', 3, 2, [{ id: 'title', start: 1, end: 5 }]),
    v2: track('V2', 'video', 2, 3, [{ id: 'clipC', start: 2, end: 6 }]), v1: track('V1', 'video', 1, 4, [{ id: 'clipA', start: 0, end: 8 }, { id: 'clipB', start: 8, end: 16 }]),
    a1: track('A1', 'audio', 0, 5, [], 'bottom'),
  },
  layerOrder: ['a1', 'v1', 'v2', 'o1', 'o2', 'o3'].map(id => ({ id, type: 'track' })), groups: {},
  markers: [{ time: 3 }, { time: 9, label: 'Beat' }],
};

test.describe('the served tools against a Chromium tab (row 10)', () => {
  // T10 (C8 assertion-only edit): writeEffects is served, so tools/list has 24 tools. T06 (C8): + addShape, writeShapePoints = 26. T07 (C8): + addLayout, editLayout = 28.
  // T11 (C8): + applyTransition = 29. T05: + addText = 30. T12 (C8): + createMask, editMaskProperties, removeMask, writeMaskPoints = 34; its smart-mask tools = 38; T21's help tools = 40.
  test('row 10: tools/list is exactly the 40 served tools', async ({ page }) => {
    const { client } = await connected(page);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([...SERVED_TOOLS].sort());
    expect(tools).toHaveLength(40);
  });

  test('row 10: `context` is layout L — the open project\'s tracks top-first with {id,start,end} items in seconds, markers without ids, and the UI\'s selection and playhead', async ({ page }) => {
    const { call } = await connected(page);
    expect(await call('context')).toEqual({ isError: undefined, body: { success: true, data: { ...CONTEXT, selectedItems: [], playheadSeconds: 0 } } });
    await setView(page, { selection: ['clipC', 'title'], playheadMs: 2500 });
    expect(await call('context')).toEqual({ isError: undefined, body: { success: true, data: { ...CONTEXT, selectedItems: ['clipC', 'title'], playheadSeconds: 2.5 } } });
  });

  test('row 10: each of the 23 tools runs once against the tab with its documented result, and the editor holds the outcome', async ({ page }) => {
    const { call } = await connected(page);
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await call(name, args);
      expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 300)}`).toBeUndefined();
      expect(r.body.success).toBe(true);
      return r.body;
    };
    expect((await call('context')).body.success).toBe(true); // a read first: the timeline gate

    // addMedia
    const added = await ok('addMedia', { trackId: 'v2', timelineStart: 10, items: [{ assetId: 'image_1', duration: 2 }] });
    expect(added.data).toEqual({ results: [{ assetId: 'image_1', success: true, itemId: id(ITEM) }], addedItemIds: [id(ITEM)], summary: { total: 1, succeeded: 1, failed: 0 } });
    expect(added.message).toBe('Successfully added 1 media item to timeline');
    expect(added.timelineChanges.items.created).toEqual([{ itemId: added.data.addedItemIds[0], type: 'image', trackId: 'v2', from: 10, to: 12, playbackRate: 1 }]);
    expect(added.timelineChanges.settings).toMatchObject({ changedFields: ['duration'], before: { duration: 20 }, after: { duration: 16 } });

    // moveItem
    const moved = await ok('moveItem', { itemId: 'clipC', to: 12 });
    expect(moved.data).toEqual({ items: [{ itemId: 'clipC', trackId: 'v2', from: 12, to: 16 }] });
    expect(moved.timelineChanges.items.updated).toEqual([{ itemId: 'clipC', changedFields: ['display'], before: { type: 'video', trackId: 'v2', from: 2, to: 6, trim: { from: 1, to: 5 } }, after: { type: 'video', trackId: 'v2', from: 12, to: 16, trim: { from: 1, to: 5 } } }]);

    // trimItem
    const trimmed = await ok('trimItem', { itemId: 'clipB', handle: 'end', deltaSeconds: -1 });
    expect(trimmed.data).toEqual({ itemId: 'clipB', appliedDeltaSeconds: -1, shiftedItemIds: [] });
    expect(trimmed.timelineChanges.items.updated).toEqual([{ itemId: 'clipB', changedFields: ['display', 'trim'], before: { type: 'video', trackId: 'v1', from: 8, to: 16, trim: { from: 2, to: 10 } }, after: { type: 'video', trackId: 'v1', from: 8, to: 15, trim: { from: 2, to: 9 } } }]);

    // slipItem
    const slipped = await ok('slipItem', { itemId: 'clipB', slipSeconds: 1 });
    expect(slipped.data).toEqual({ itemId: 'clipB', slippedSeconds: 1 });
    expect(slipped.timelineChanges.items.updated).toEqual([{ itemId: 'clipB', changedFields: ['trim'], before: { type: 'video', trackId: 'v1', from: 8, to: 15, trim: { from: 2, to: 9 } }, after: { type: 'video', trackId: 'v1', from: 8, to: 15, trim: { from: 3, to: 10 } } }]);

    // splitItem
    const split = await ok('splitItem', { itemId: 'clipA', timestampS: 3 });
    expect(split.data).toEqual({ leftItemId: 'clipA', rightItemId: id(ITEM) });
    expect(split.timelineChanges.items.created).toEqual([{ itemId: split.data.rightItemId, type: 'video', trackId: 'v1', from: 3, to: 8, trim: { from: 3, to: 8 } }]);

    // transformItem
    const transformed = await ok('transformItem', { itemId: 'clipA', x: 10 });
    expect(transformed.data).toEqual({ itemId: 'clipA', drawnBox: { x: 10, y: 0, width: 1920, height: 1080 } });
    expect(transformed.message).toBe("'clipA' is now drawn at x 10, y 0, 1920 × 1080 px on the 1920 × 1080 canvas (before rotation).");
    expect(transformed.timelineChanges.items.updated[0]).toMatchObject({ itemId: 'clipA', changedFields: ['properties.positionX'] });

    // editProperties, writeKeyframes, setTimeRemap (T04; clipA is 0–3 s after the split, source 10 s). None of the written
    // properties is keyframed yet, so the keyframes gate lets them through.
    const edited = await ok('editProperties', { itemId: 'clipA', properties: { opacity: 0.5 } });
    expect(edited.message).toBe('Updated 1 item atomically');
    expect(edited.data).toEqual({ itemIds: ['clipA'], changedFields: { clipA: ['properties.opacity'] } });
    expect(edited.timelineChanges.items.updated[0]).toMatchObject({ itemId: 'clipA', changedFields: ['properties.opacity'] });
    const written = await ok('writeKeyframes', { itemId: 'clipA', payload: { scale: { replace: [{ time: 0, value: 1 }, { time: 2, value: 1.5 }] } } });
    expect(written.message).toBe("Keyframes written on 'clipA': scale (2).");
    expect(written.data).toMatchObject({ itemId: 'clipA', keyframes: { scale: { keyframeCount: 2 } } });
    expect(written.timelineChanges.items.updated[0]).toMatchObject({ itemId: 'clipA', changedFields: ['properties.scale'] });
    const remapped = await ok('setTimeRemap', { itemId: 'clipA', keyframes: [{ time: 0, value: 0 }, { time: 3, value: 3000 }] });
    expect(remapped.message).toBe("Set 2 time remap keyframes on 'clipA' (replaced). Speed range: 1.000x – 1.000x.");
    expect(remapped.data).toEqual({ itemId: 'clipA', mode: 'replace', keyframesSet: 2, totalKeyframesInTrack: 2, clipDuration: 3, sourceDuration: 10, speedRange: { min: 1, max: 1 } });
    expect(remapped.timelineChanges.items.updated[0]).toMatchObject({ itemId: 'clipA', changedFields: ['timeRemap'] });

    // cloneItem (clipA is 0–3 after the split)
    const cloned = await ok('cloneItem', { itemId: 'clipA', trackId: 'v2', at: 17 });
    expect(cloned.data).toEqual({ itemId: id(ITEM), trackId: 'v2', from: 17, to: 20 });
    expect(cloned.timelineChanges.items.created).toEqual([{ itemId: cloned.data.itemId, type: 'video', trackId: 'v2', from: 17, to: 20, trim: { from: 0, to: 3 } }]);

    // changeTrack
    const changed = await ok('changeTrack', { itemId: 'title', trackId: 'o3' });
    expect(changed.data).toEqual({ itemId: 'title', trackId: 'o3', from: 1, to: 5 });
    expect(changed.message).toBe("Moved 'title' to track 'o3' at 1s–5s.");
    expect(changed.timelineChanges.items.updated).toMatchObject([{ itemId: 'title', changedFields: ['trackId'], before: { trackId: 'o1', from: 1, to: 5 }, after: { trackId: 'o3', from: 1, to: 5 } }]);

    // reorderItems
    const reordered = await ok('reorderItems', { itemIds: ['clipB'], beforeItemId: 'clipA' });
    expect(reordered.data).toEqual({ itemIds: ['clipB'] });

    // deleteItems
    const deleted = await ok('deleteItems', { itemIds: ['photo'] });
    expect(deleted.data).toEqual({ deletedItemIds: ['photo'] });
    expect(deleted.timelineChanges.items.deleted).toEqual([{ itemId: 'photo', type: 'image', trackId: 'o2', from: 0, to: 4, trim: { from: 0, to: 4 } }]);

    // manageMarkers
    const marked = await ok('manageMarkers', { actions: [{ action: 'add', time: 1, label: 'x' }] });
    expect(marked.data).toEqual({ addedMarkerIds: [id(MARKER)] });
    expect(marked.message).toBe('Markers: added 1.');
    expect(marked.timelineChanges.markers.created).toEqual([{ id: marked.data.addedMarkerIds[0], time: 1, text: 'x' }]);

    // manageTrack
    const newTrack = await ok('manageTrack', { action: 'create', kind: 'video' });
    expect(newTrack.message).toBe("Created video track 'V3'.");
    expect(newTrack.data.track).toEqual({ id: id(TRACK), name: 'V3', kind: 'video', groupId: null, order: 6, layerIndex: 0, layer: 'top', muted: false, solo: false, locked: false, hidden: false, volume: 1, itemCount: 0 });

    // manageTrackGroup
    const grouped = await ok('manageTrackGroup', { action: 'create', name: 'G', trackIds: ['v1', 'v2'] });
    expect(grouped.data).toMatchObject({ groupId: id(GROUP), name: 'G', hidden: false, locked: false, trackIds: ['v1', 'v2'] });

    // resizeCanvas
    const resized = await ok('resizeCanvas', { aspectRatio: '9:16' });
    expect(resized.data).toEqual({ aspectRatio: '9:16', width: 1080, height: 1920 });
    expect(resized.message).toBe('Canvas resized to 9:16 (1080x1920).');
    expect(resized.timelineChanges.settings).toMatchObject({ changedFields: ['size'] });

    // consolidateTracks: the title goes back from o3 to o1, and the clone at 17–20 closes up onto v1 (empty tracks stay)
    const consolidated = await ok('consolidateTracks', {});
    expect(consolidated).toMatchObject({ success: true, moved: 2, deletedTrackIds: [], message: 'Consolidated 2 item(s); empty tracks were preserved.' });

    // viewItemDetails (T19 C4): a read — the item as the timeline holds it (syncAndSwap needs transcripts; its refusal is in the failures test)
    const viewed = await ok('viewItemDetails', { itemId: 'clipB', include: ['keyframes'] });
    expect(viewed.data).toMatchObject({ id: 'clipB', layer: 'v1', startTime: 0, endTime: 7 }); expect(viewed.data).toHaveProperty('keyframes');

    // the tab itself holds what the tools reported
    const ctx = (await call('context')).body.data;
    expect(ctx.canvasSize).toEqual({ width: 1080, height: 1920 });
    expect(ctx.tracks.v2.items).toEqual([{ id: added.data.addedItemIds[0], start: 10, end: 12 }, { id: 'clipC', start: 12, end: 16 }]);
    expect(ctx.tracks.v1.items).toEqual([{ id: 'clipB', start: 0, end: 7 }, { id: 'clipA', start: 7, end: 10 }, { id: split.data.rightItemId, start: 10, end: 15 }, { id: cloned.data.itemId, start: 17, end: 20 }]);
    expect(ctx.tracks.o2.items).toEqual([]);
    expect(ctx.tracks.o1.items).toEqual([{ id: 'title', start: 1, end: 5 }]);
    expect(Object.keys(ctx.groups)).toEqual([grouped.data.groupId]);
    expect(ctx.markers).toEqual([{ time: 1, label: 'x' }, { time: 3 }, { time: 9, label: 'Beat' }]); // sorted by time, still without ids
  });

  test('row 10: failures come back as isError envelopes with the tool\'s own code and leave the project untouched', async ({ page }) => {
    const { call } = await connected(page);
    const before = await liveDoc(page);
    const fail = async (name: string, args: Record<string, unknown>) => {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.body.success).toBe(false);
      expect(r.body.timelineChanges, 'a refused call reports no changes').toBeUndefined();
      return r.body;
    };

    // The gate: nothing has been read yet in this MCP session.
    const stale = await fail('moveItem', { itemId: 'clipC', by: 1 });
    expect(stale).toEqual({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: NEVER_READ, scope: 'timeline', currentState: { success: true, data: CONTEXT } });
    expect(await liveDoc(page)).toEqual(before);
    // …and the refusal counted as a read, so a retry is judged on its merits.
    expect((await call('moveItem', { itemId: 'clipC', by: 1 })).isError).toBeUndefined();
    expect((await call('moveItem', { itemId: 'clipC', to: 2 })).isError).toBeUndefined(); // back where it was
    const base = await liveDoc(page);

    expect(await fail('moveItem', { itemId: 'nope', by: 1 })).toEqual({ success: false, code: 'ITEM_NOT_FOUND',
      error: 'Move cancelled; these item IDs are not on the timeline: nope. A caption linked to a deleted clip is deleted with it; read context again.' });
    expect(await fail('trimItem', { itemId: 'clipA', handle: 'start', deltaSeconds: -1 })).toEqual({ success: false, code: 'TRIM_AT_LIMIT',
      error: "Trim was not applied — 'clipA' cannot move its start that way: it is already at the limit of its source media or its minimum length." });
    expect(await fail('changeTrack', { itemId: 'title', trackId: 'a1' })).toEqual({ success: false, code: 'TRACK_INCOMPATIBLE', error: 'Track change failed: TRACK_INCOMPATIBLE' });
    expect(await fail('manageTrack', { action: 'delete', trackId: 'zzz' })).toEqual({ success: false, code: 'TRACK_NOT_FOUND', error: "Track 'zzz' not found." });
    expect(await fail('cloneItem', { itemId: 'clipA', trackId: 'v2', at: 3 })).toMatchObject({ success: false, code: 'TRACK_OVERLAP' });
    expect(await fail('syncAndSwap', { sourceAssetId: 'video_1', targetItemId: 'nope', trackId: 'v1', from: 0, to: 2 })).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
    expect(await fail('context', { selection: 'x' })).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', message: '$.selection: must NOT have additional properties',
      details: { errors: [{ path: '$.selection', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }] } });
    expect(await liveDoc(page)).toEqual(base);
  });
});

test.describe('the project-state resource with a Chromium tab (row 8)', () => {
  test('row 8: the resource is listed and reads the light `context` of the open project — no selection, no playhead', async ({ page }) => {
    const { client } = await connected(page);
    await setView(page, { selection: ['clipC'], playheadMs: 2500 });
    expect((await client.listResources()).resources).toEqual([{ name: 'project-state', title: 'Project state', uri: URI, mimeType: 'application/json',
      description: "The open project's timeline as the context tool returns it without parameters. Subscribe to be told when items, tracks or transitions change." }]);
    const read = await client.readResource({ uri: URI });
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]).toMatchObject({ uri: URI, mimeType: 'application/json' });
    expect(JSON.parse(text(read))).toEqual({ success: true, data: CONTEXT });
  });

  test('row 8: a subscribed client is told when the user or the agent changes the timeline, once per burst, and not after unsubscribing', async ({ page }) => {
    const { client, call } = await connected(page);
    const told: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { told.push(n.params.uri); });
    await client.subscribeResource({ uri: URI });

    expect(await userSplit(page, 'clipA', 2000)).toBe(true);
    await expect.poll(() => told.length, { timeout: 5000 }).toBe(1);
    const items = JSON.parse(text(await client.readResource({ uri: URI }))).data.tracks.v1.items;
    expect(items).toEqual([{ id: 'clipA', start: 0, end: 2 }, { id: id(ITEM), start: 2, end: 8 }, { id: 'clipB', start: 8, end: 16 }]);

    // an agent edit changes the timeline just as well
    expect((await call('context')).body.success).toBe(true);
    expect((await call('moveItem', { itemId: 'clipC', to: 12 })).body.success).toBe(true);
    await expect.poll(() => told.length, { timeout: 5000 }).toBe(2);
    await page.waitForTimeout(400); // several quiet windows: no further notification
    expect(told).toEqual([URI, URI]);

    await client.unsubscribeResource({ uri: URI });
    expect(await userSplit(page, 'clipB', 10000)).toBe(true);
    await page.waitForTimeout(400);
    expect(told).toHaveLength(2);
  });

  test('row 8: a burst of user edits collapses into a single notification (debounce)', async ({ page }) => {
    const { client } = await connected(page, 600);
    const told: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { told.push(n.params.uri); });
    await client.subscribeResource({ uri: URI }); // no priming read: the watcher's 50 ms runtime poll has long since taken its baseline
    for (const [item, at] of [['clipA', 1000], ['clipC', 4000], ['clipB', 10000]] as const) expect(await userSplit(page, item, at)).toBe(true);
    await expect.poll(() => told.length, { timeout: 5000 }).toBe(1);
    await page.waitForTimeout(1000);
    expect(told).toEqual([URI]);
  });
});
