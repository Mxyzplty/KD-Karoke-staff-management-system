// SPDX-License-Identifier: AGPL-3.0-only
// T07 lane rule (tickets l.320): "runs its tools through the helper". addLayout and editLayout from a real MCP client, through a real
// helper (startHelper), to a paired Chromium tab, then the item the tab stored. Pattern: tests/ui/t06-shapes-helper.spec.ts `connected`;
// the gate cases follow t18a-tools row 10 and t18a-promise row 11. Every error response is checked whole (toStrictEqual) and the document
// stays unchanged. Oracles: contracts addLayout / editLayout (T07), Cutframe error codes (C).md (INVALID_TOOL_INPUT, STALE_READ_REFRESHED).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHelper } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { createProject, guard, richDoc, skipTour } from './t02-support';
import { videoAsset } from './t07-support';

test.use({ viewport: { width: 1400, height: 900 } });
const LINK_KEY = 'cutframe:agent-link:v1';
const NEVER_READ = "You haven't read the timeline in this session. The current state is attached and the timeline now counts as fresh; retry the call.";
const modifiedAt = (iso: string) => `The user modified the timeline at ${iso} after your last read. The current state is attached and the timeline now counts as fresh; retry the call.`;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SETTINGS = { size: { width: 1920, height: 1080 }, fps: 30, background: { type: 'color', value: 'transparent' } };
const LAYOUT_ID = /^item_[a-z0-9]{10}$/;

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]);
});

type Body = Record<string, any>;
/** A ready video asset linked to the project, and the agent id (`video_N`) the project's link gives it: the id a tool call names. */
async function agentAsset(page: Page, projectId: string, name: string) {
  const stored = await videoAsset(page, projectId, name, 10000);
  const id = await page.evaluate(async ({ projectId, stored }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    return (await projectStore.library()).links.find((l: any) => l.projectId === projectId && l.assetId === stored && l.deleted_at === null)?.agent_id as string | undefined;
  }, { projectId, stored });
  expect(id, 'the project link of the uploaded asset').toMatch(/^video_\d+$/);
  return { agentId: id!, stored };
}
/** A paired tab on a richDoc project linked to a fresh helper, plus MCP clients on that helper (as t10-write-effects-helper `connected`). */
async function connected(page: Page, assetNames: string[] = []) {
  const configDir = mkdtempSync(join(tmpdir(), 't07-helper-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], quietMs: 100 });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T07 layouts helper');
  // The tab indexes the project's assets when the editor opens: the video assets are uploaded and linked before it does.
  const assets: { agentId: string; stored: string }[] = [];
  for (const name of assetNames) assets.push(await agentAsset(page, projectId, name));
  const token = newToken(); helper.store.add(token);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), token);
  await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected');
  const client = async () => {
    const c = new Client({ name: 't07', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
    cleanups.push(() => c.close());
    return async (name: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
      expect(r.content).toHaveLength(1); expect(r.content[0].type).toBe('text');
      return { isError: r.isError, body: JSON.parse(r.content[0].text) as Body };
    };
  };
  return { call: await client(), client, projectId, assets };
}
const liveDoc = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); }) as Promise<Body>;
const timelineChanges = (items: Body) => ({ basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true, readBack: 'Use context or viewItemDetails for changed fields not included in these summaries, or for truncated text.', items });
/** The refusal's currentState is the context read without the view fields (t18a-tools CONTEXT): no selection, no playhead. */
const withoutView = ({ selectedItems: _s, playheadSeconds: _p, ...rest }: Body) => rest;
const userSplit = (page: Page, itemId: string, atMs: number) => page.evaluate(async ({ itemId, atMs }) => {
  const rt = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(rt);
  return activeRuntime.handle({ type: 'splitItems', itemIds: [itemId], atMs }).ok as boolean;
}, { itemId, atMs });


const layoutOf = async (page: Page, id: string) => (await liveDoc(page)).items.find((i: Body) => i.id === id) as Body;
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; body: Body }>;
test('addLayout and editLayout through the helper: a grid-2x2 is added with one cell filled, then gap, radius and a second cell are edited; the tab stores both', async ({ page }) => {
  const { call, assets: [one, two] } = await connected(page, ['one.mp4', 'two.mp4']);
  expect((await call('context')).body.success).toBe(true);                       // a read first: the timeline gate
  const added = await call('addLayout', { layoutType: 'grid-2x2', trackId: 'o3', timelineStart: 2, duration: 4, cells: [{ assetId: one.agentId }] });
  expect(added.isError, JSON.stringify(added.body).slice(0, 400)).toBeUndefined();
  const id = added.body.data.itemId as string;
  expect(added.body).toStrictEqual({
    success: true, message: `Added Grid 2x2 layout '${id}' to track 'o3' at 2s`,
    data: { itemId: expect.stringMatching(LAYOUT_ID), trackId: 'o3', type: 'layout', layoutType: 'grid-2x2', cellCount: 4, filledCells: 1, gap: 0, borderRadius: 0, timelinePosition: { start: 2, end: 6 } },
    // richDoc stores duration 20 s with its last clip ending at 16 s; the first timeline edit settles the project length on the content (a generic rule, not T07's).
    timelineChanges: { ...timelineChanges({ created: [{ itemId: id, type: 'layout', trackId: 'o3', from: 2, to: 6 }], updated: [], deleted: [] }),
      settings: { changedFields: ['duration'], before: { ...SETTINGS, duration: 20 }, after: { ...SETTINGS, duration: 16 } } },
  });
  await expect.poll(async () => (await layoutOf(page, id))?.type).toBe('layout');
  let stored = await layoutOf(page, id);
  expect(stored.trackId).toBe('o3'); expect(stored.display).toEqual({ from: 2000, to: 6000 });
  expect(stored.details.layoutType).toBe('grid-2x2'); expect(stored.details.cells).toHaveLength(4);
  expect(stored.details.cells.map((c: Body) => c.source)).toEqual([{ assetId: one.stored, type: 'video', url: `asset:${one.stored}` }, null, null, null]);

  const edited = await call('editLayout', { itemId: id, gap: 12, borderRadius: 8, cells: [{ index: 2, assetId: two.agentId, fillMode: 'fit' }] });
  expect(edited.isError, JSON.stringify(edited.body).slice(0, 400)).toBeUndefined();
  expect(edited.body).toStrictEqual({
    success: true, message: 'Layout updated successfully',
    data: { itemId: id, type: 'layout', layoutType: 'grid-2x2', cellCount: 4, filledCells: 2, gap: 12, borderRadius: 8 },
    timelineChanges: timelineChanges({ created: [], updated: [{ itemId: id, changedFields: expect.arrayContaining(['details.gap', 'details.borderRadius', 'details.cells']), before: { type: 'layout', trackId: 'o3', from: 2, to: 6 }, after: { type: 'layout', trackId: 'o3', from: 2, to: 6 } }], deleted: [] }),
  });
  await expect.poll(async () => (await layoutOf(page, id)).details.gap).toBe(12);
  stored = await layoutOf(page, id);
  expect(stored.details.borderRadius).toBe(8);
  expect(stored.details.cells.map((c: Body) => c.source?.assetId ?? null)).toEqual([one.stored, null, two.stored, null]);
  expect(stored.details.cells[2].fillMode).toBe('fit'); expect(stored.details.cells[0].fillMode).toBe('fill');
});

test('a layout type or a missing itemId the schema refuses is INVALID_TOOL_INPUT from the helper, and nothing is added or changed', async ({ page }) => {
  const { call, assets: [one] } = await connected(page, ['one.mp4']);
  await call('context');
  const added = await call('addLayout', { layoutType: 'grid-2x2', trackId: 'o3', timelineStart: 2, duration: 4, cells: [{ assetId: one.agentId }] });
  expect(added.isError, JSON.stringify(added.body).slice(0, 400)).toBeUndefined();
  const id = added.body.data.itemId as string;
  await expect.poll(async () => (await layoutOf(page, id))?.type).toBe('layout');
  const before = await liveDoc(page);

  const bad = await call('addLayout', { layoutType: 'grid-3x3', trackId: 'o3', timelineStart: 8 });
  expect(bad.isError).toBe(true);
  expect(bad.body).toStrictEqual({
    success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for addLayout', message: '$.layoutType: must be equal to one of the allowed values',
    details: { errors: [{ path: '$.layoutType', code: 'ENUM', message: 'must be equal to one of the allowed values' }] },
  });
  expect(await liveDoc(page)).toEqual(before);

  const noId = await call('editLayout', { gap: 4 });
  expect(noId.isError).toBe(true);
  expect(noId.body).toStrictEqual({
    success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for editLayout', message: '$.itemId: must have required property \'itemId\'',
    details: { errors: [{ path: '$.itemId', code: 'REQUIRED', message: 'must have required property \'itemId\'' }] },
  });
  expect(await liveDoc(page)).toEqual(before);                                   // the existing layout is unchanged too
});

test('the timeline gate (Q12): addLayout is refused without a fresh read and after an unseen change; editLayout is not gated', async ({ page }) => {
  const { call, client, assets: [one] } = await connected(page, ['one.mp4']);
  await call('context');
  const layout = await call('addLayout', { layoutType: 'split-horizontal', trackId: 'o3', timelineStart: 1, duration: 3 });
  expect(layout.isError, JSON.stringify(layout.body).slice(0, 400)).toBeUndefined();
  const id = layout.body.data.itemId as string;
  const state = (await call('context')).body.data;

  // A second MCP session that never read: addLayout is refused with the never-read message and the current state; nothing is written.
  const other = await client();
  const before = await liveDoc(page);
  const never = await other('addLayout', { layoutType: 'grid-2x2', trackId: 'o2', timelineStart: 5, duration: 1 });
  expect(never.isError).toBe(true);
  expect(never.body).toStrictEqual({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: NEVER_READ, scope: 'timeline', currentState: { success: true, data: withoutView(state) } });
  expect(await liveDoc(page)).toEqual(before);

  // The user changes the timeline behind the first client's back (it read before): editLayout still goes through, addLayout is refused.
  const t1 = Date.now();
  expect(await userSplit(page, 'clipA', 3000)).toBe(true);
  const ok = await call('editLayout', { itemId: id, gap: 6, cells: [{ index: 0, assetId: one.agentId }] });
  expect(ok.isError, JSON.stringify(ok.body).slice(0, 400)).toBeUndefined();
  expect(ok.body).toMatchObject({ success: true, message: 'Layout updated successfully', data: { itemId: id, layoutType: 'split-horizontal', filledCells: 1, gap: 6 } });
  await expect.poll(async () => (await layoutOf(page, id)).details.gap).toBe(6);
  const items = (await liveDoc(page)).items;
  const stale = await call('addLayout', { layoutType: 'grid-2x2', trackId: 'o2', timelineStart: 5, duration: 1 });
  expect(stale.isError).toBe(true);
  const fresh = withoutView((await call('context')).body.data);                   // the refusal counted as a read; the document has not changed since
  const iso = /at (\S+) after/.exec(stale.body.message)?.[1] ?? '';
  expect(iso).toMatch(ISO); expect(Date.parse(iso)).toBeGreaterThanOrEqual(t1);
  expect(stale.body).toStrictEqual({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: modifiedAt(iso), scope: 'timeline',
    currentState: { success: true, data: fresh } });
  expect((await liveDoc(page)).items).toEqual(items);                            // not applied
});
