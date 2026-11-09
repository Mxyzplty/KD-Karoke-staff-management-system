// SPDX-License-Identifier: AGPL-3.0-only
// T06 lane rule (tickets l.320): "runs its tools through the helper". addShape and writeShapePoints from a real MCP client, through a real
// helper (startHelper), to a paired Chromium tab, then the item the tab stored. Pattern: tests/ui/t10-write-effects-helper.spec.ts `connected`;
// the gate cases follow t18a-tools row 10 and t18a-promise row 11. Every error response is checked whole (toStrictEqual) and the document
// stays unchanged. Oracles: contracts addShape / writeShapePoints, Cutframe error codes (C).md (INVALID_TOOL_INPUT), the star numbers of
// tests/t06-shapes.test.ts (regular 5-point star, R = min(w, h) / 2, inner 0.4 R, first vertex up).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHelper } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { createProject, guard, richDoc, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const LINK_KEY = 'cutframe:agent-link:v1';
const NEVER_READ = "You haven't read the timeline in this session. The current state is attached and the timeline now counts as fresh; retry the call.";
const modifiedAt = (iso: string) => `The user modified the timeline at ${iso} after your last read. The current state is attached and the timeline now counts as fresh; retry the call.`;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BOUNDS = { x: 100, y: 200, width: 300, height: 240 };      // star: centre (250, 320), R = min(w, h) / 2 = 120, first vertex (250, 200)
const SETTINGS = { size: { width: 1920, height: 1080 }, fps: 30, background: { type: 'color', value: 'transparent' } };
/** The result's bounds are the star's own extent, not the box: width 2 R sin 72°, height R + R cos 36°, from the centre line x = 250 (2 decimals). */
const STAR_BOUNDS = { x: Math.round((250 - 120 * Math.sin(2 * Math.PI / 5)) * 100) / 100, y: 200, width: Math.round(2 * 120 * Math.sin(2 * Math.PI / 5) * 100) / 100, height: Math.round(120 * (1 + Math.cos(Math.PI / 5)) * 100) / 100 };

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]);
});

type Body = Record<string, any>;
/** A paired tab on a richDoc project linked to a fresh helper, plus MCP clients on that helper (as t10-write-effects-helper `connected`). */
async function connected(page: Page) {
  const configDir = mkdtempSync(join(tmpdir(), 't06-helper-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], quietMs: 100 });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T06 shapes helper');
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
    const c = new Client({ name: 't06', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
    cleanups.push(() => c.close());
    return async (name: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
      expect(r.content).toHaveLength(1); expect(r.content[0].type).toBe('text');
      return { isError: r.isError, body: JSON.parse(r.content[0].text) as Body };
    };
  };
  return { call: await client(), client };
}
const liveDoc = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); }) as Promise<Body>;
const shapeOf = async (page: Page, id: string) => (await liveDoc(page)).items.find((i: Body) => i.id === id) as Body;
/** A stored point in canvas px: the item-local anchor plus the item's position. */
const abs = (item: Body, k: number) => ({ x: item.details.points[k].anchor.x + item.properties.positionX.defaultValue, y: item.details.points[k].anchor.y + item.properties.positionY.defaultValue });
const near = (got: { x: number; y: number }, want: { x: number; y: number }) => { expect(Math.abs(got.x - want.x), `${got.x} vs ${want.x}`).toBeLessThanOrEqual(0.01); expect(Math.abs(got.y - want.y), `${got.y} vs ${want.y}`).toBeLessThanOrEqual(0.01); };
const timelineChanges = (items: Body) => ({ basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true, readBack: 'Use context or viewItemDetails for changed fields not included in these summaries, or for truncated text.', items });
/** The refusal's currentState is the context read without the view fields (t18a-tools CONTEXT): no selection, no playhead. */
const withoutView = ({ selectedItems: _s, playheadSeconds: _p, ...rest }: Body) => rest;
const userSplit = (page: Page, itemId: string, atMs: number) => page.evaluate(async ({ itemId, atMs }) => {
  const rt = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(rt);
  return activeRuntime.handle({ type: 'splitItems', itemIds: [itemId], atMs }).ok as boolean;
}, { itemId, atMs });

test('addShape and writeShapePoints through the helper: the star is added, then a point is updated and one added; the tab stores both', async ({ page }) => {
  const { call } = await connected(page);
  expect((await call('context')).body.success).toBe(true);                       // a read first: the timeline gate
  const added = await call('addShape', { shape: 'star', bounds: BOUNDS, trackId: 'o3', timelineStart: 1, duration: 2 });
  expect(added.isError, JSON.stringify(added.body).slice(0, 400)).toBeUndefined();
  const id = added.body.data.itemId as string;
  expect(added.body).toStrictEqual({
    success: true, message: `Shape '${id}' (star) added to track 'o3' at 1s`,
    data: { itemId: expect.stringMatching(/^item_[a-z0-9]{10}$/), trackId: 'o3', shapeType: 'star', pointCount: 10, timelineStart: 1, duration: 2, bounds: STAR_BOUNDS },
    // richDoc stores duration 20 s with its last clip ending at 16 s; the first timeline edit settles the project length on the content (a generic rule, not T06's).
    timelineChanges: { ...timelineChanges({ created: [{ itemId: id, type: 'shape', trackId: 'o3', from: 1, to: 3 }], updated: [], deleted: [] }),
      settings: { changedFields: ['duration'], before: { ...SETTINGS, duration: 20 }, after: { ...SETTINGS, duration: 16 } } },
  });
  await expect.poll(async () => (await shapeOf(page, id))?.metadata?.shapeType).toBe('star');
  let stored = await shapeOf(page, id);
  expect(stored.type).toBe('shape'); expect(stored.trackId).toBe('o3'); expect(stored.display).toEqual({ from: 1000, to: 3000 }); expect(stored.details.points).toHaveLength(10);
  near(abs(stored, 0), { x: 250, y: 200 });                                      // the first vertex is up, on the box's centre line

  const written = await call('writeShapePoints', { itemId: id, update: [{ pointIndex: 0, anchor: { y: 150 } }], add: [{ anchor: { x: 400, y: 400 } }] });
  expect(written.isError, JSON.stringify(written.body).slice(0, 400)).toBeUndefined();
  expect(written.body).toStrictEqual({
    success: true, message: `writeShapePoints on shape '${id}': update(1) + add(1)`, ops: [{ op: 'update', count: 1 }, { op: 'add', count: 1 }],
    timelineChanges: timelineChanges({ created: [], updated: [{ itemId: id, changedFields: expect.arrayContaining(['details.path', 'details.points']), before: { type: 'shape', trackId: 'o3', from: 1, to: 3 }, after: { type: 'shape', trackId: 'o3', from: 1, to: 3 } }], deleted: [] }),
  });
  await expect.poll(async () => (await shapeOf(page, id)).details.points.length).toBe(11);
  stored = await shapeOf(page, id);
  near(abs(stored, 0), { x: 250, y: 150 });                                      // the updated vertex
  near(abs(stored, 10), { x: 400, y: 400 });                                     // the added point, appended at the end
  expect(stored.metadata.shapeType).toBe('star');
});

test('addShape with a shape type the schema does not know is refused by the helper as INVALID_TOOL_INPUT and nothing is added', async ({ page }) => {
  const { call } = await connected(page);
  await call('context');
  const before = await liveDoc(page);
  const r = await call('addShape', { shape: 'hexagon', bounds: BOUNDS, trackId: 'o3' });
  expect(r.isError).toBe(true);
  expect(r.body).toStrictEqual({
    success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for addShape', message: '$.shape: must be equal to one of the allowed values',
    details: { errors: [{ path: '$.shape', code: 'ENUM', message: 'must be equal to one of the allowed values' }] },
  });
  expect((await liveDoc(page)).items).toEqual(before.items);
  expect(await liveDoc(page)).toEqual(before);
});

test('the timeline gate (Q12): addShape is refused without a fresh read and after an unseen change; writeShapePoints is not gated', async ({ page }) => {
  const { call, client } = await connected(page);
  await call('context');
  const star = await call('addShape', { shape: 'star', bounds: BOUNDS, trackId: 'o3', timelineStart: 1, duration: 2 });
  expect(star.isError).toBeUndefined();
  const id = star.body.data.itemId as string;
  const state = (await call('context')).body.data;

  // A second MCP session that never read: addShape is refused with the never-read message and the current state; nothing is written.
  const other = await client();
  const before = await liveDoc(page);
  const never = await other('addShape', { shape: 'star', bounds: BOUNDS, trackId: 'o2', timelineStart: 5, duration: 1 });
  expect(never.isError).toBe(true);
  expect(never.body).toStrictEqual({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: NEVER_READ, scope: 'timeline', currentState: { success: true, data: withoutView(state) } });
  expect(await liveDoc(page)).toEqual(before);

  // The user changes the timeline behind the first client's back (it read before): writeShapePoints still goes through, addShape is refused.
  const t1 = Date.now();
  expect(await userSplit(page, 'clipA', 3000)).toBe(true);
  const ok = await call('writeShapePoints', { itemId: id, update: [{ pointIndex: 0, anchor: { y: 150 } }] });
  expect(ok.isError, JSON.stringify(ok.body).slice(0, 400)).toBeUndefined();
  expect(ok.body).toMatchObject({ success: true, message: `writeShapePoints on shape '${id}': update(1)`, ops: [{ op: 'update', count: 1 }] });
  near(abs(await shapeOf(page, id), 0), { x: 250, y: 150 });
  const items = (await liveDoc(page)).items;
  const stale = await call('addShape', { shape: 'star', bounds: BOUNDS, trackId: 'o2', timelineStart: 5, duration: 1 });
  expect(stale.isError).toBe(true);
  const fresh = withoutView((await call('context')).body.data);                   // the refusal counted as a read; the document has not changed since
  const iso = /at (\S+) after/.exec(stale.body.message)?.[1] ?? '';
  expect(iso).toMatch(ISO); expect(Date.parse(iso)).toBeGreaterThanOrEqual(t1);
  expect(stale.body).toStrictEqual({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: modifiedAt(iso), scope: 'timeline',
    currentState: { success: true, data: fresh } });
  expect((await liveDoc(page)).items).toEqual(items);                            // not applied
});
