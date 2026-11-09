// SPDX-License-Identifier: AGPL-3.0-only
// T10 owned acceptance, `writeEffects` row ("JSON Schema added to the T18a helper and run through it", verified direct-call + helper), fix round 1
// N4: one valid writeEffects from a real MCP client through a real helper to a paired Chromium tab, then the instance the tab stored. Pattern:
// tests/ui/t18a-tools.spec.ts `connected`. Oracle: contracts #29 and the T10 stored shape `{id effect_<epoch ms>_<9 chars>, effectId, enabled,
// order, parameters {key {defaultValue, keyframes}}}`; the success shape is provisional (notes P21).
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

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]);
});

/** A paired tab on a richDoc project linked to a fresh helper, plus an MCP client on that helper (as t18a-tools `connected`). */
async function connected(page: Page) {
  const configDir = mkdtempSync(join(tmpdir(), 't10-helper-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], quietMs: 100 });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T10 writeEffects helper');
  const token = newToken(); helper.store.add(token);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), token);
  await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected');
  const client = new Client({ name: 't10', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(r.content).toHaveLength(1); expect(r.content[0].type).toBe('text');
    return { isError: r.isError, body: JSON.parse(r.content[0].text) as Record<string, any> };
  };
  return { call };
}
const liveDoc = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); }) as Promise<Record<string, any>>;

test('writeEffects through the helper: a valid add reaches the tab, answers the success shape, and the tab stores the instance', async ({ page }) => {
  const { call } = await connected(page);
  expect((await call('context')).body.success).toBe(true); // a read first: the timeline gate
  const r = await call('writeEffects', { itemId: 'clipA', add: [{ effectId: 'grayscale', initialParameters: { amount: 40 } }] });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBeUndefined();
  expect(r.body).toMatchObject({ success: true, message: "Effects written on 'clipA' atomically.", data: { itemIds: ['clipA'], items: [{ itemId: 'clipA', added: ['grayscale_1'] }] } });
  expect(r.body.data.items[0].effects).toEqual([{ effectId: 'grayscale_1', effectType: 'grayscale', name: expect.any(String), enabled: true, order: 0, parameters: { amount: { value: 40 } } }]);
  await expect.poll(async () => (await liveDoc(page)).items.find((i: { id: string }) => i.id === 'clipA')?.effects?.length).toBe(1);
  const stored = (await liveDoc(page)).items.find((i: { id: string }) => i.id === 'clipA').effects[0];
  expect(stored).toEqual({ id: expect.stringMatching(/^effect_\d+_[A-Za-z0-9]{9}$/), effectId: 'grayscale', enabled: true, order: 0, parameters: { amount: { defaultValue: 40, keyframes: [] } } });
});
