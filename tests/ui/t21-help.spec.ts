// SPDX-License-Identifier: AGPL-3.0-only
// T21 /help and /help/<id> in Chromium (the corpus people read), the help tools as the Executor answers them, and the same tools
// through a real helper and MCP client (acceptance row 8).
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

test('/help lists every section under its four groups', async ({ page }) => {
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();
  await expect(page.locator('.help-page section > h2')).toHaveText(['Start here', 'The editor', 'Agents', 'Settings and costs']);
  expect(await page.locator('.help-page section li a').count()).toBeGreaterThanOrEqual(20);
  await expect(page.getByRole('link', { name: 'Export a video' })).toBeVisible();
});

test('a section link opens /help/<id> with its text, and All help goes back', async ({ page }) => {
  await page.goto('/help');
  await page.getByRole('link', { name: 'Export a video' }).click();
  await expect(page).toHaveURL(/\/help\/export$/);
  const article = page.locator('article[data-section="export"]');
  await expect(article.getByRole('heading', { name: 'Export a video' })).toBeVisible();
  await expect(article).toContainText('There is no watermark');
  await article.getByRole('link', { name: 'All help' }).click();
  await expect(page).toHaveURL(/\/help$/);
});

test('searching a question lists matching sections; one word and gibberish say nothing matched', async ({ page }) => {
  await page.goto('/help');
  const box = page.getByRole('textbox', { name: 'Search help' });
  await box.fill('how do I add subtitles to my video');
  await expect(page.getByRole('list', { name: 'Search results' }).getByRole('link', { name: 'Captions and subtitles' })).toBeVisible();
  await box.fill('export');
  await expect(page.getByText('No matching help. Try a few more words.')).toBeVisible();
  await box.fill('zebra quantum pancake');
  await expect(page.getByText('No matching help. Try a few more words.')).toBeVisible();
});

test('the Help & Resources menu links the two guides and says Community is not set up', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Help & Resources' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Getting-started guide', 'Agent-setup guide', 'Community']);
  await page.getByRole('menuitem', { name: 'Community' }).click();
  await expect(page.getByText('No community space has been set up yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Help & Resources' }).click();
  await page.getByRole('menuitem', { name: 'Getting-started guide' }).click();
  await expect(page).toHaveURL(/\/help\/getting-started$/);
});

test('the help tools answer without a project (the Executor help dispatch)', async ({ page }) => {
  await page.goto('/help');
  const run = (tool: string, input: Record<string, unknown>) => page.evaluate(async ({ tool, input }) => { const p = '/src/settings/help.ts'; return (await import(p)).helpTool(tool, input); }, { tool, input });
  expect(await run('getHelpSection', { section_id: 'getting-started' })).toMatchObject({ success: true, section: { section_id: 'getting-started', parent_section: 'Start here' } });
  expect(await run('getHelpSection', { section_id: 'nonexistent' })).toMatchObject({ success: false, code: 'SECTION_NOT_FOUND' });
  const exported = await run('searchHelpDocs', { query: 'how do I export' }) as { success: boolean; found: boolean; sections: { section_id: string }[] };
  expect(exported).toMatchObject({ success: true, found: true });
  expect(exported.sections[0]).toMatchObject({ section_id: 'export' });
  expect(await run('searchHelpDocs', { query: 'x' })).toMatchObject({ success: true, found: false, sections: [] });
});

test('searchHelpDocs and getHelpSection work through the helper from an MCP client', async ({ page }) => {
  const configDir = mkdtempSync(join(tmpdir(), 't21-help-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], quietMs: 100 });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T21 help');
  const token = newToken(); helper.store.add(token);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), token);
  await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected');
  const client = new Client({ name: 't21', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: r.isError, body: JSON.parse(r.content[0].text) as Record<string, any> };
  };
  const found = await call('searchHelpDocs', { query: 'how do I connect Claude Code to the editor' });
  expect(found.body).toMatchObject({ success: true, found: true });
  expect(found.body.sections.map((s: { section_id: string }) => s.section_id)).toContain('agent-setup');
  expect((await call('getHelpSection', { section_id: 'export' })).body).toMatchObject({ success: true, section: { section_id: 'export' } });
  expect((await call('getHelpSection', { section_id: 'nonexistent' })).body).toMatchObject({ success: false, code: 'SECTION_NOT_FOUND' });
  expect((await call('searchHelpDocs', { query: 'x' })).body).toMatchObject({ success: true, found: false });
});
