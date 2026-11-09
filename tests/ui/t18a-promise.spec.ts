// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger row 11 — Promise 2, scripted end to end against a real helper and a real Chromium editor tab: pair through the UI,
// an MCP client reads `context` and moves an item, the user presses Undo, the agent's next edit is refused with the `modifiedAt`
// message and the current state, and the retry goes through.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHelper } from '../../apps/helper/src/helper';
import { createProject, guard, richDoc, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const NEVER_READ = "You haven't read the timeline in this session. The current state is attached and the timeline now counts as fresh; retry the call.";
const modifiedAt = (iso: string) => `The user modified the timeline at ${iso} after your last read. The current state is attached and the timeline now counts as fresh; retry the call.`;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]); // the loopback-only guard
});

type Body = Record<string, any>;
const badge = (page: Page) => page.getByTestId('agent-link-badge');
/** The user's side: open the project, then Connect tab → printed code → Pair, exactly as the panel asks. */
async function pairedThroughUi(page: Page) {
  const configDir = mkdtempSync(join(tmpdir(), 't18a-promise-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!] });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T18a promise');
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(badge(page)).toHaveAttribute('data-status', 'idle');
  await badge(page).click();
  await page.getByTestId('agent-link-port').fill(String(helper.port));
  await page.getByTestId('agent-link-connect').click();
  await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
  await page.getByTestId('agent-link-code').fill(helper.pairingCode!);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(badge(page)).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('agent-link-panel')).toContainText(`Connected to the helper on port ${helper.port}. MCP clients use http://127.0.0.1:${helper.port}/mcp.`);
  return { helper, projectId };
}
/** The agent's side: an MCP client of the helper and a `call` that parses the single text content. */
async function mcp(port: number) {
  const client = new Client({ name: 't18a-promise', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(r.content).toHaveLength(1);
    return { isError: r.isError, body: JSON.parse(r.content[0].text) as Body };
  };
  return { client, call };
}
const undo = (page: Page) => page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Undo', exact: true });
/** Where an item sits on the timeline, in seconds, as the agent's `context` would list it. */
const clip = (ctx: Body, itemId: string) => Object.values<Body>(ctx.data.tracks).flatMap(t => t.items).find(i => i.id === itemId);
const userSplit = (page: Page, itemId: string, atMs: number) => page.evaluate(async ({ itemId, atMs }) => {
  const rt = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(rt);
  return activeRuntime.handle({ type: 'splitItems', itemIds: [itemId], atMs }).ok as boolean;
}, { itemId, atMs });

test('row 11: pair in the UI → agent reads and moves a clip → user presses Undo → the agent\'s next edit is refused with the modifiedAt message → the retry goes through', async ({ page }) => {
  const { helper } = await pairedThroughUi(page);
  const { call } = await mcp(helper.port);

  // 1. The agent reads, then edits.
  const first = await call('context');
  expect(first.isError).toBeUndefined();
  expect(clip(first.body, 'clipC')).toEqual({ id: 'clipC', start: 2, end: 6 });
  const moved = await call('moveItem', { itemId: 'clipC', to: 12 });
  expect(moved.isError).toBeUndefined();
  expect(moved.body).toMatchObject({ success: true, data: { items: [{ itemId: 'clipC', trackId: 'v2', from: 12, to: 16 }] } });
  expect(clip((await call('context')).body, 'clipC')).toEqual({ id: 'clipC', start: 12, end: 16 });

  // 2. The user presses Undo in the editor: the agent's move is taken back.
  await expect(undo(page)).toBeEnabled();
  await undo(page).click();
  const t1 = Date.now(); // the user's later edit below is stamped at or after this
  const afterUndo = (await call('context')).body; // a read: the agent now knows about the Undo…
  expect(clip(afterUndo, 'clipC')).toEqual({ id: 'clipC', start: 2, end: 6 });

  // …so edit again, behind the agent's back: the user nudges the timeline, the agent has not looked since.
  await expect(undo(page)).toBeDisabled(); // nothing older to undo: the move was the only step
  expect(await userSplit(page, 'clipA', 3000)).toBe(true);
  const sent = { itemId: 'clipC', to: 12 };
  const refused = await call('moveItem', sent);

  // 3. Refused, with the user's modification time and the current state attached; the document is as the user left it.
  expect(refused.isError).toBe(true);
  const iso = /at (\S+) after/.exec(refused.body.message)?.[1] ?? '';
  expect(iso).toMatch(ISO);
  expect(Date.parse(iso)).toBeGreaterThanOrEqual(t1);
  expect(refused.body).toEqual({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: modifiedAt(iso), scope: 'timeline',
    currentState: { success: true, data: expect.objectContaining({ duration: 16, fps: 30 }) } }); // the user's split re-derives the duration from the last clip end (16 s)
  expect(Object.keys(refused.body.currentState.data)).not.toContain('selectedItems'); // the light context
  expect(clip(refused.body.currentState, 'clipC')).toEqual({ id: 'clipC', start: 2, end: 6 });
  expect(refused.body.currentState.data.tracks.v1.items).toEqual([{ id: 'clipA', start: 0, end: 3 }, { id: expect.stringMatching(/^item_[a-z0-9]{10}$/), start: 3, end: 8 }, { id: 'clipB', start: 8, end: 16 }]);
  expect((await call('context')).body.data.tracks.v2.items).toEqual([{ id: 'clipC', start: 2, end: 6 }]); // not applied

  // 4. The refusal counted as a read: the same call, retried, is applied.
  const retried = await call('moveItem', sent);
  expect(retried.isError).toBeUndefined();
  expect(retried.body).toMatchObject({ success: true, data: { items: [{ itemId: 'clipC', trackId: 'v2', from: 12, to: 16 }] } });
  expect(clip((await call('context')).body, 'clipC')).toEqual({ id: 'clipC', start: 12, end: 16 });
});

test('row 11: Undo itself counts as a user change — the refusal names Undo\'s time, and a `context` read between the user and the agent avoids it', async ({ page }) => {
  const { helper } = await pairedThroughUi(page);
  const { call } = await mcp(helper.port);

  await call('context');
  expect((await call('moveItem', { itemId: 'clipC', to: 12 })).isError).toBeUndefined();
  const t0 = Date.now();
  await undo(page).click(); // the agent has not read since the Undo
  const refused = await call('moveItem', { itemId: 'clipC', to: 20 });
  expect(refused.isError).toBe(true);
  const iso = /at (\S+) after/.exec(refused.body.message)?.[1] ?? '';
  expect(iso).toMatch(ISO);
  expect(Date.parse(iso)).toBeGreaterThanOrEqual(t0);
  expect(refused.body.message).toBe(modifiedAt(iso));
  expect(refused.body.currentState.data.tracks.v2.items).toEqual([{ id: 'clipC', start: 2, end: 6 }]);

  // a user edit followed by a read: no refusal
  expect(await userSplit(page, 'clipB', 10000)).toBe(true);
  expect((await call('context')).isError).toBeUndefined();
  const ok = await call('moveItem', { itemId: 'clipC', to: 12 });
  expect(ok.isError).toBeUndefined();
  expect(ok.body.success).toBe(true);
});

test('row 11: the gate is per MCP session — a second client that has not read is refused with the never-read message while the first carries on', async ({ page }) => {
  const { helper } = await pairedThroughUi(page);
  const a = await mcp(helper.port), b = await mcp(helper.port);

  await a.call('context');
  expect((await a.call('moveItem', { itemId: 'clipC', to: 12 })).isError).toBeUndefined();
  const refused = await b.call('moveItem', { itemId: 'clipC', to: 2 });
  expect(refused.isError).toBe(true);
  expect(refused.body).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', message: NEVER_READ, scope: 'timeline' });
  expect(clip(refused.body.currentState, 'clipC')).toEqual({ id: 'clipC', start: 12, end: 16 });
  expect((await b.call('moveItem', { itemId: 'clipC', to: 2 })).isError).toBeUndefined();
  expect((await a.call('moveItem', { itemId: 'clipC', to: 12 })).isError).toBeUndefined(); // another agent's edit is not a user change: a is not refused
});
