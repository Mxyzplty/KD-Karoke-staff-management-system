// SPDX-License-Identifier: AGPL-3.0-only
// T08 agent tools end to end: a real MCP client, a real editor tab and the default (sandbox) dry run.
// Oracle: reference compares §1.4 R4 (a graphic that throws at frame 0 is refused with `compilation error: <thrown text>`), agent tool results §2 addMotionGraphic.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHelper } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { addAsset, createProject, guard, richDoc, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const LINK_KEY = 'cutframe:agent-link:v1';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]);
});

type Body = Record<string, any>;
async function connected(page: Page) {
  const configDir = mkdtempSync(join(tmpdir(), 't08-tools-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], quietMs: 100 });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T08 tools');
  await addAsset(page, projectId);
  const token = newToken(); helper.store.add(token);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), token);
  await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected');
  const client = new Client({ name: 't08', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: r.isError, body: JSON.parse(r.content[0].text) as Body };
  };
  return { call };
}
const liveDoc = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); }) as Promise<Body>;

const BOX = { width: 540, height: 960, x: 10, y: 20 };
const GOOD = `export const Card = () => <AbsoluteFill style={{ backgroundColor: '#112233' }}><div style={{ fontFamily: 'Roboto', color: '#fff' }}>Hello</div></AbsoluteFill>;`;
const THROWS = `export const Boom = () => { throw new Error('G-06 R4 boom at frame 0'); };`;
const args = (code: string, extra: Record<string, unknown> = {}) => ({ code, summary: 'A card.', ...BOX, trackId: 'o3', ...extra });

test.describe('addMotionGraphic / editMotionGraphic through MCP with the default dry run', () => {
  test('a graphic that throws at frame 0 is refused with `compilation error: <thrown text>` and the project is untouched', async ({ page }) => {
    const { call } = await connected(page);
    await call('context');
    const before = await liveDoc(page);
    const r = await call('addMotionGraphic', args(THROWS));
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ success: false, code: 'COMPILATION_ERROR' });
    expect(r.body.error).toMatch(/^compilation error: .*G-06 R4 boom at frame 0/);
    expect(await liveDoc(page)).toEqual(before);
  });

  test('a valid graphic is added (default dry run passes), is readable with view, and an updateCode that throws is refused with the code unchanged', async ({ page }) => {
    const { call } = await connected(page);
    await call('context');
    const added = await call('addMotionGraphic', args(GOOD));
    expect(added.isError, JSON.stringify(added.body).slice(0, 400)).toBeUndefined();
    expect(added.body).toMatchObject({ success: true, data: { trackId: 'o3', duration: 5, timelineStart: 0, summary: 'A card.' } });
    const itemId = added.body.data.itemId as string;
    expect(added.body.timelineChanges.items.created).toHaveLength(1);

    const view = await call('editMotionGraphic', { itemId });
    expect(view.body).toEqual({ success: true, message: 'Motion graphic code retrieved', data: { agentId: itemId, code: GOOD, summary: 'A card.' } });

    const bad = await call('editMotionGraphic', { itemId, action: 'updateCode', code: THROWS });
    expect(bad.isError).toBe(true);
    expect(bad.body).toMatchObject({ success: false, code: 'COMPILATION_ERROR' });
    expect(bad.body.error).toMatch(/^compilation error: .*G-06 R4 boom at frame 0/);
    expect((await call('editMotionGraphic', { itemId })).body.data.code).toBe(GOOD);

    const patched = await call('editMotionGraphic', { itemId, action: 'patchCode', patches: [{ old_string: 'Hello', new_string: 'Hi there' }] });
    expect(patched.isError, JSON.stringify(patched.body).slice(0, 400)).toBeUndefined();
    expect((await call('editMotionGraphic', { itemId })).body.data.code).toBe(GOOD.replace('Hello', 'Hi there'));
  });

  test('a schema failure and a handler refusal come back as isError envelopes', async ({ page }) => {
    const { call } = await connected(page);
    await call('context');
    const typed = await call('addMotionGraphic', args(GOOD, { animationDuration: '5' }));
    expect(typed.isError).toBe(true);
    expect(typed.body).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for addMotionGraphic', message: '$.animationDuration: must be number' });
    const zap = await call('editMotionGraphic', { itemId: 'nope', action: 'zap' });
    expect(zap.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });
});
