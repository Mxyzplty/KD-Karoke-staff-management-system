// SPDX-License-Identifier: AGPL-3.0-only
// T11 lane rule (tickets l.320): "runs its tools through the helper". applyTransition from a real MCP client, through a real helper (startHelper),
// to a paired Chromium tab, then the record the tab stored. Pattern: tests/ui/t06-shapes-helper.spec.ts, t10-write-effects-helper.spec.ts.
// Oracles: results §2 (applyTransition success: message "Added <kind> transition (<d>s, <word> on the cut) on <from> → <to> at <s>s.", data.transition
// {id, kind, durationSeconds, alignment word}, timelineChanges.transitions.created entry) and §11 (G-08: defaults fade / 1 s / center; schema
// refusals before anything changes); contracts applyTransition (anyOf betweenItems | atSeconds, EXCLUSIVE; durationSeconds > 0); error codes §7
// (INVALID_TOOL_INPUT; STALE_READ_REFRESHED for the gate cases). applyTransition is NOT in the timeline stale-read gate (agent/executor.ts
// TIMELINE_GATED); the gate is shown live with addShape, which is gated (T06 Q12), on the same kind of session.
// Not from the T11 docs: the schema refusal's `message` / `details.errors[].path` / `.message` texts are T18a's shared helper-validator wording.
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
const ID = /^transition_[a-z0-9]{10}$/;
const WRAP = { basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true, readBack: 'Use context or viewItemDetails for changed fields not included in these summaries, or for truncated text.' };

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]);
});

type Body = Record<string, any>;
/** A paired tab on a richDoc project linked to a fresh helper, plus MCP clients on that helper (as t06-shapes-helper `connected`). */
async function connected(page: Page) {
  const configDir = mkdtempSync(join(tmpdir(), 't11-helper-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], quietMs: 100 });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  const projectId = await createProject(page, richDoc(), 'T11 applyTransition helper');
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
    const c = new Client({ name: 't11', version: '0' });
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
const stored = async (page: Page) => (await liveDoc(page)).transitions as Body[];
const labels = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; return (await import(p)).activeRuntime.bus.undoStack.map((e: any) => e.label as string); }) as Promise<string[]>;
const userSplit = (page: Page, itemId: string, atMs: number) => page.evaluate(async ({ itemId, atMs }) => {
  const rt = '/src/timeline/runtime.ts'; const { activeRuntime } = await import(rt);
  return activeRuntime.handle({ type: 'splitItems', itemIds: [itemId], atMs }).ok as boolean;
}, { itemId, atMs });

// richDoc: clipA (V1 0–8 s, source 10 s, trim 0–8 s) meets clipB (V1 8–16 s, trim 2–10 s) at 8 s; the shorter clip is 8 s, so the cap is 3 s.
test('applyTransition add through the helper: the whole success body, then the record the tab stored and its one "Add transition" entry', async ({ page }) => {
  const { call } = await connected(page);
  expect((await call('context')).body.success).toBe(true);
  const before = (await labels(page)).length;
  const r = await call('applyTransition', { action: 'add', betweenItems: ['clipA', 'clipB'], kind: 'dissolve', durationSeconds: 0.6 });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBeUndefined();
  await expect.poll(async () => (await stored(page)).length).toBe(1);
  const rec = (await stored(page))[0];
  expect(rec).toStrictEqual({ id: expect.stringMatching(ID), trackId: 'v1', fromId: 'clipA', toId: 'clipB', kind: 'dissolve', durationMs: 600, alignment: 0.5 });
  expect(r.body).toStrictEqual({
    success: true, message: 'Added dissolve transition (0.60s, center on the cut) on clipA → clipB at 8.00s.',
    data: { transition: { id: rec.id, kind: 'dissolve', durationSeconds: 0.6, alignment: 'center' } },
    timelineChanges: { ...WRAP, transitions: { created: [{ id: rec.id, trackId: 'v1', fromId: 'clipA', toId: 'clipB', kind: 'dissolve', duration: 0.6, alignment: 0.5 }], updated: [], deleted: [] } },
  });
  const entries = await labels(page); expect(entries).toHaveLength(before + 1); expect(entries.at(-1)).toBe('Add transition');
});

test('a second add on the same cut replaces in place (same id, label "Change transition"); remove through the helper stores none', async ({ page }) => {
  const { call } = await connected(page);
  await call('context');
  await call('applyTransition', { action: 'add', betweenItems: ['clipA', 'clipB'] });          // defaults: fade, 1 s, center (§11)
  const first = (await stored(page))[0];
  expect(first).toMatchObject({ kind: 'fade', durationMs: 1000, alignment: 0.5 });
  const r = await call('applyTransition', { action: 'add', betweenItems: ['clipB', 'clipA'], kind: 'slide', direction: 'from-top', alignment: 'end' }); // either order
  expect(r.body.message).toBe('Replaced slide transition (1.00s, end on the cut) on clipA → clipB at 8.00s.');
  await expect.poll(async () => (await stored(page))[0]?.kind).toBe('slide');
  expect(await stored(page)).toStrictEqual([{ ...first, kind: 'slide', direction: 'from-top', alignment: 1 }]);
  expect((await labels(page)).at(-1)).toBe('Change transition');
  const gone = await call('applyTransition', { action: 'remove', betweenItems: ['clipA', 'clipB'] });
  expect(gone.body.message).toBe('Removed the slide transition on clipA → clipB at 8.00s.');
  await expect.poll(async () => (await stored(page)).length).toBe(0);
  expect((await labels(page)).at(-1)).toBe('Remove transition');
});

test('schema refusals through the helper: both betweenItems and atSeconds → INVALID_COMBINATION; durationSeconds 0; nothing is written', async ({ page }) => {
  const { call } = await connected(page);
  await call('context');
  const doc0 = await liveDoc(page), n0 = (await labels(page)).length;
  for (const [args, code] of [
    [{ action: 'add', betweenItems: ['clipA', 'clipB'], atSeconds: 8 }, 'INVALID_COMBINATION'],
    [{ action: 'add', betweenItems: ['clipA', 'clipB'], durationSeconds: 0 }, undefined],
  ] as const) {
    const r = await call('applyTransition', args as Record<string, unknown>);
    expect(r.isError, JSON.stringify(args)).toBe(true);
    const errs = r.body.details.errors as Body[];
    expect(r.body).toStrictEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for applyTransition', message: `${errs[0].path}: ${errs[0].message}`, details: { errors: errs } });
    expect(errs.length).toBeGreaterThan(0);
    if (code) expect(errs.map(e => e.code)).toContain(code);
    else expect(errs[0].path).toBe('$.durationSeconds');
    expect(await liveDoc(page)).toEqual(doc0); expect(await labels(page)).toHaveLength(n0);
  }
});

test('applyTransition is not stale-read gated: it succeeds after a user edit with no fresh read, and on a session that never read, while a gated tool is refused on the same state', async ({ page }) => {
  const { call, client } = await connected(page);
  await call('context');
  expect(await userSplit(page, 'clipC', 3000)).toBe(true);                    // the user changes the timeline behind the client's back
  const r = await call('applyTransition', { action: 'add', betweenItems: ['clipA', 'clipB'] });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBeUndefined();
  expect(r.body.success).toBe(true);
  await expect.poll(async () => (await stored(page)).length).toBe(1);

  // A session that never read: applyTransition goes through; the gated addShape is refused with the never-read message on the same document.
  const never = await client(), never2 = await client();
  const gated = await never2('addShape', { shape: 'star', bounds: { x: 100, y: 200, width: 300, height: 240 }, trackId: 'o3', timelineStart: 1, duration: 2 });
  expect(gated.isError).toBe(true);
  expect(gated.body).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', message: NEVER_READ, scope: 'timeline' });
  const upd = await never('applyTransition', { action: 'update', betweenItems: ['clipA', 'clipB'], kind: 'wipe' });
  expect(upd.isError, JSON.stringify(upd.body).slice(0, 300)).toBeUndefined();
  expect(upd.body.message).toBe('Updated wipe transition (1.00s, center on the cut) on clipA → clipB at 8.00s.');
  await expect.poll(async () => (await stored(page))[0]?.kind).toBe('wipe');
});
