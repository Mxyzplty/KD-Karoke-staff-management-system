// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 8 through the helper: the 20 scripted questions of tests/t21-help.test.ts, asked by an MCP client over the real
// helper to a connected editor tab, each returning its section; the result shapes of "Cutframe agent tool results" (searchHelpDocs,
// getHelpSection); one-word queries find nothing. Nothing leaves localhost.
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
const QUESTIONS: [string, string][] = [
  ['how do I get started with Cutframe', 'getting-started'],
  ['how do I import my footage into the library', 'library'],
  ['how does undo and version history work', 'version-history'],
  ['what is on the editor layout and inspector', 'editor'],
  ['how do I split a clip on the timeline', 'timeline'],
  ['how do I add subtitles to my video', 'captions'],
  ['how do I change the text font', 'text'],
  ['how do I add a blur effect or colour grade', 'effects'],
  ['how do I add a transition', 'transitions'],
  ['how do I mask part of a clip', 'masks'],
  ['how do I make a motion graphic overlay', 'motion-graphics'],
  ['how do I make a split screen layout', 'shapes-layouts'],
  ['how do I record a voice-over', 'audio'],
  ['how do I export a video as mp4', 'export'],
  ['what are the keyboard shortcuts', 'keyboard-shortcuts'],
  ['how do I connect Claude Code to the editor', 'agent-setup'],
  ['my agent connection has a wrong pairing code', 'agent-troubleshooting'],
  ['where do I put my API keys in settings', 'settings'],
  ['how do I use Ollama as a local model server', 'local-model-servers'],
  ['how much does it cost and what is the storage quota', 'costs'],
];
type Section = { section_id: string; section_title: string; parent_section: string; content: string; similarity?: number };
type Result = { isError?: boolean; body: Record<string, any> };

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]);
});

/** A real helper, a paired editor tab on a project, and an MCP client on the helper's /mcp. */
async function connected(page: Page) {
  const configDir = mkdtempSync(join(tmpdir(), 't21-help-helper-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], quietMs: 100 });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T21 help helper');
  const token = newToken(); helper.store.add(token);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), token);
  await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected');
  const client = new Client({ name: 't21-help', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
  cleanups.push(() => client.close());
  return async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(r.content, `${name} returns one text block`).toHaveLength(1); expect(r.content[0].type).toBe('text');
    return { isError: r.isError, body: JSON.parse(r.content[0].text) as Record<string, any> };
  };
}

test('row 8: each of the 20 scripted questions, asked through the helper, returns its section; getHelpSection then reads that section', async ({ page }) => {
  test.setTimeout(120_000);
  const call = await connected(page);
  expect(new Set(QUESTIONS.map(q => q[1])).size).toBe(20);
  for (const [question, id] of QUESTIONS) {
    const r = await call('searchHelpDocs', { query: question });
    expect(r.isError ?? false, question).toBe(false);
    expect(r.body, question).toMatchObject({ success: true, found: true, query: question, message: expect.any(String) });
    const sections = r.body.sections as Section[];
    expect(sections.map(s => s.section_id), question).toContain(id);
    const hit = sections.find(s => s.section_id === id)!;
    expect(Object.keys(hit).sort(), question).toEqual(['content', 'parent_section', 'section_id', 'section_title', 'similarity']);
    const section = await call('getHelpSection', { section_id: id });
    expect(section.isError ?? false, id).toBe(false);
    expect(section.body, id).toMatchObject({ success: true, section: { section_id: id, section_title: hit.section_title, parent_section: hit.parent_section, content: hit.content } });
    expect(section.body.section.similarity, `${id} has no similarity`).toBeUndefined();
  }
});

test('row 8: result shape — at most 5 sections best first, integer similarity 30–65, match_count caps the list, a value above 5 is refused', async ({ page }) => {
  const call = await connected(page);
  const r = await call('searchHelpDocs', { query: 'how do I connect my agent and fix the pairing code' });
  const sections = r.body.sections as Section[];
  expect(r.body.found).toBe(true);
  expect(sections.length).toBeGreaterThan(1); expect(sections.length).toBeLessThanOrEqual(5);
  const scores = sections.map(s => s.similarity!);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  for (const s of scores) { expect(Number.isInteger(s)).toBe(true); expect(s).toBeGreaterThanOrEqual(30); expect(s).toBeLessThanOrEqual(65); }
  expect(r.body.message).toMatch(new RegExp(`${sections.length}`));
  const two = await call('searchHelpDocs', { query: 'how do I connect my agent and fix the pairing code', match_count: 2 });
  expect((two.body.sections as Section[]).map(s => s.section_id)).toEqual(sections.slice(0, 2).map(s => s.section_id));
  const six = await call('searchHelpDocs', { query: 'how do I export', match_count: 6 });
  expect(six.isError).toBe(true);
  expect(six.body).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for searchHelpDocs', details: { errors: [{ path: '$.match_count', code: 'MAXIMUM' }] } });
});

test('row 8: a one-word query finds nothing, in the no-match shape without a query field; so does gibberish', async ({ page }) => {
  const call = await connected(page);
  for (const query of ['export', 'captions', 'x', 'undo', 'asdf qwer zxcv']) {
    const r = await call('searchHelpDocs', { query });
    expect(r.isError ?? false, query).toBe(false);
    expect(r.body, query).toEqual({ success: true, found: false, message: 'No matching help documentation found for this query.', sections: [] });
    expect(Object.keys(r.body), query).not.toContain('query');
  }
});

test('row 8: getHelpSection with an unknown id is a failure with SECTION_NOT_FOUND and the id in its message', async ({ page }) => {
  const call = await connected(page);
  for (const id of ['nonexistent', '__catalog__', '']) {
    const r = await call('getHelpSection', { section_id: id });
    expect(r.isError, id).toBe(true);
    expect(r.body, id).toMatchObject({ success: false, code: 'SECTION_NOT_FOUND', error: `Section "${id}" not found` });
  }
});
