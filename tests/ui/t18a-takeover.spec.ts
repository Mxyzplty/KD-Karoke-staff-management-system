// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger row 9: takeover between two Chromium tabs — the confirm and Moved screens, close codes 4409 / 4410 / 4503,
// a takeover never lands in the middle of a call, and the reconnect schedule (250 ms, 1 s, 2 s, 4 s, 8 s ×6, then lost) under page.clock.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { WebSocket as RawSocket } from 'ws';
import { Helper, startHelper } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { CLOSE, RECONNECT_DELAYS, RECONNECT_MAX } from '../../apps/web/src/agent/protocol';
import { createProject, guard, richDoc, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });

const LINK_KEY = 'cutframe:agent-link:v1';
const MOVED = 'Moved to another tab — Another tab took over the MCP connection. Reconnect here to take it back.';
const CONFIRM = 'Another tab holds the MCP connection. Take it over in this tab?';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks: { page: Page; list: string[] }[] = [];
/** Every page this test opens gets the loopback-only request guard, checked in afterEach. */
async function watch(page: Page) { leaks.push({ page, list: guard(page) }); await skipTour(page); return page; }
test.beforeEach(async ({ page }) => { await watch(page); });
test.afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const { list } of leaks.splice(0)) expect(list, 'requests that left localhost').toEqual([]);
});

async function helperUp(options: ConstructorParameters<typeof Helper>[0] = {}) {
  const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), 't18a-take-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!], ...options });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  return { helper, configDir };
}
const seedLink = (page: Page, port: number, auto: boolean) => page.addInitScript(({ key, port, auto }) => {
  try { if (!sessionStorage.getItem('t18a-seeded')) { localStorage.setItem(key, JSON.stringify({ port, auto })); sessionStorage.setItem('t18a-seeded', '1'); } } catch { /* storage unavailable */ }
}, { key: LINK_KEY, port, auto });
type Sock = { url: string; at: number; code?: number; reason?: string };
const recordSockets = (page: Page) => page.addInitScript(() => {
  const Native = window.WebSocket, log: Sock[] = [];
  (window as any).__sockets = log;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const entry: Sock = { url: String(url), at: Date.now() };
      log.push(entry);
      this.addEventListener('close', e => { entry.code = e.code; entry.reason = e.reason; });
    }
  } as typeof WebSocket;
});
const sockets = (page: Page) => page.evaluate(() => ((window as any).__sockets ?? []) as Sock[]).then(all => all.filter(s => new URL(s.url).pathname === '/tab'));
const badge = (page: Page) => page.getByTestId('agent-link-badge');
const panel = (page: Page) => page.getByTestId('agent-link-panel');
async function openPanel(page: Page) { await badge(page).click(); await expect(panel(page)).toBeVisible(); }
async function openProject(page: Page, name = 'T18a takeover') {
  const id = await createProject(page, richDoc(), name);
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return id;
}
/** A token the helper knows, stored where the editor keeps it. Needs a page on the app origin. */
async function pairedTab(page: Page, helper: Helper) {
  const t = newToken(); helper.store.add(t);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), t);
  return t;
}
/** A tab in a context of its own, paired and connected through its stored link. */
async function connectedTab(context: BrowserContext, helper: Helper, name: string, record = true) {
  const page = await watch(await context.newPage());
  await page.goto('/');
  await pairedTab(page, helper);
  await seedLink(page, helper.port, true);
  if (record) await recordSockets(page);
  await openProject(page, name);
  await expect(badge(page)).toHaveAttribute('data-status', 'connected');
  return page;
}
/** A second tab that wants the link but has not taken it: paired, remembers the port, does not auto-connect. */
async function waitingTab(context: BrowserContext, helper: Helper, name: string) {
  const page = await watch(await context.newPage());
  await page.goto('/');
  await pairedTab(page, helper);
  await seedLink(page, helper.port, false);
  await recordSockets(page);
  await openProject(page, name);
  await expect(badge(page)).toHaveAttribute('data-status', 'idle');
  return page;
}
const tabInfo = (page: Page) => page.evaluate(async () => ({
  tab: JSON.parse(sessionStorage.getItem('cutframe:agent-tab:v1') ?? 'null') as { tabId: string; connId?: string } | null,
  token: await new Promise<string | undefined>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onsuccess = () => { const req = open.result.transaction('kv').objectStore('kv').get('token'); req.onsuccess = () => resolve(req.result as string | undefined); };
  }),
}));
/** Hold every call the tab receives until `release()` runs; resolves each with `result`. */
const holdCalls = (page: Page) => page.evaluate(async () => {
  const path = '/src/agent/link.ts'; const { agentLink } = await import(path);
  const w = window as any; w.__held = [];
  agentLink.executor.execute = (m: any) => new Promise(resolve => { w.__held.push({ m, resolve }); });
  w.__release = (result: unknown) => { for (const h of w.__held.splice(0)) h.resolve(result); };
});
const held = (page: Page) => page.evaluate(() => (window as any).__held.map((h: any) => ({ toolName: h.m.toolName, input: h.m.input })) as { toolName: string; input: unknown }[]);
const release = (page: Page, result: unknown) => page.evaluate(r => (window as any).__release(r), result);

test.describe('takeover between tabs (row 9)', () => {
  test('row 9: Connect tab while another tab holds the link asks first — "Take over" moves the link, the old tab shows Moved and its socket closed 4409 "superseded"', async ({ browser }) => {
    const { helper } = await helperUp();
    const a = await connectedTab(await browser.newContext(), helper, 'A');
    const b = await waitingTab(await browser.newContext(), helper, 'B');

    await openPanel(b);
    await b.getByTestId('agent-link-connect').click();
    await expect(badge(b)).toHaveAttribute('data-status', 'confirm');
    await expect(panel(b)).toContainText(CONFIRM);
    await expect(badge(a)).toHaveAttribute('data-status', 'connected'); // asking does not disturb the holder
    expect((await sockets(a)).map(s => s.code)).toEqual([undefined]);

    await b.getByRole('button', { name: 'Take over' }).click();
    await expect(badge(b)).toHaveAttribute('data-status', 'connected');
    await expect(badge(a)).toHaveAttribute('data-status', 'moved');
    await expect(badge(a)).toHaveText('Moved');
    await expect.poll(async () => (await sockets(a))[0].code).toBe(CLOSE.superseded);
    expect((await sockets(a))[0]).toMatchObject({ code: 4409, reason: 'superseded' });
    await openPanel(a);
    await expect(panel(a)).toContainText(MOVED);
    await expect(a.getByRole('button', { name: 'Reconnect here' })).toBeVisible();
  });

  test('row 9: Cancel on the confirm screen leaves the holder connected and the asking tab idle', async ({ browser }) => {
    const { helper } = await helperUp();
    const a = await connectedTab(await browser.newContext(), helper, 'A');
    const b = await waitingTab(await browser.newContext(), helper, 'B');
    await openPanel(b);
    await b.getByTestId('agent-link-connect').click();
    await expect(badge(b)).toHaveAttribute('data-status', 'confirm');
    await b.getByRole('button', { name: 'Cancel' }).click();
    await expect(badge(b)).toHaveAttribute('data-status', 'idle');
    await b.waitForTimeout(300);
    await expect(badge(a)).toHaveAttribute('data-status', 'connected');
    expect((await sockets(a)).map(s => s.code)).toEqual([undefined]);
  });

  test('row 9: "Reconnect here" on the Moved tab takes the link back; the other tab becomes Moved in turn', async ({ browser }) => {
    const { helper } = await helperUp();
    const a = await connectedTab(await browser.newContext(), helper, 'A');
    const b = await waitingTab(await browser.newContext(), helper, 'B');
    await openPanel(b);
    await b.getByTestId('agent-link-connect').click();
    await b.getByRole('button', { name: 'Take over' }).click();
    await expect(badge(a)).toHaveAttribute('data-status', 'moved');

    await openPanel(a);
    await a.getByRole('button', { name: 'Reconnect here' }).click();
    await expect(badge(a)).toHaveAttribute('data-status', 'connected');
    await expect(badge(b)).toHaveAttribute('data-status', 'moved');
    await expect.poll(async () => (await sockets(b))[0].code).toBe(4409);
    await expect(panel(b)).toContainText(MOVED); // b's panel is still open from the confirm step
  });

  test('row 9: opening a project in a second tab of the same browser (stored link) takes the link without asking; the first tab is Moved', async ({ page, context }) => {
    const { helper } = await helperUp();
    await page.goto('/');
    await pairedTab(page, helper);
    await seedLink(page, helper.port, true);
    await recordSockets(page);
    const id = await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');

    const second = await watch(await context.newPage());
    await recordSockets(second);
    await second.goto(`/project/${id}`); await expect(second.getByRole('status')).toHaveText('Saved locally');
    await expect(badge(second)).toHaveAttribute('data-status', 'connected');
    await expect(badge(page)).toHaveAttribute('data-status', 'moved');
    await expect.poll(async () => (await sockets(page))[0].code).toBe(4409);
    expect((await sockets(page))[0].reason).toBe('superseded');
    expect((await tabInfo(page)).tab!.tabId).not.toBe((await tabInfo(second)).tab!.tabId);
  });

  test('row 9: the same tab connecting again (another socket with its tab id) replaces the old socket silently — 4410, and the tab shows Moved', async ({ page }) => {
    const { helper } = await helperUp();
    await page.goto('/');
    await pairedTab(page, helper);
    await seedLink(page, helper.port, true);
    await recordSockets(page);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    const { tab, token } = await tabInfo(page);

    const raw = new RawSocket(`ws://127.0.0.1:${helper.port}/tab`, { origin: new URL(page.url()).origin });
    cleanups.push(() => raw.terminate());
    const messages: any[] = [], closed = new Promise<{ code: number; reason: string }>(resolve => raw.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
    raw.on('message', d => messages.push(JSON.parse(String(d))));
    await new Promise(resolve => raw.once('open', resolve));
    raw.send(JSON.stringify({ type: 'hello', protocol: 1, projectId: null, tabId: tab!.tabId, token, connId: tab!.connId }));

    await expect(badge(page)).toHaveAttribute('data-status', 'moved');
    expect((await sockets(page))[0]).toMatchObject({ code: 4410, reason: 'replaced by a newer connection of the same tab' });
    expect(messages[0]).toMatchObject({ type: 'hello', paired: true, active: true, connId: tab!.connId });

    // "Reconnect here" is the same tab again: the raw client is the one replaced now.
    await openPanel(page);
    await page.getByRole('button', { name: 'Reconnect here' }).click();
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    expect(await closed).toEqual({ code: 4410, reason: 'replaced by a newer connection of the same tab' });
    expect(messages.some(m => m.type === 'takeover')).toBe(false); // a same-tab replacement is not a takeover
  });

  test('row 9: stopping the helper closes the link 4503 "helper stopped" and the tab starts redialling, not Moved', async ({ page }) => {
    const { helper } = await helperUp();
    await page.goto('/');
    await pairedTab(page, helper);
    await seedLink(page, helper.port, true);
    await recordSockets(page);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    await helper.close();
    await expect.poll(async () => (await sockets(page))[0].code).toBe(CLOSE.shutdown);
    expect((await sockets(page))[0]).toMatchObject({ code: 4503, reason: 'helper stopped' });
    await expect(badge(page)).toHaveAttribute('data-status', /^(connecting|reconnecting)$/);
  });
});

test.describe('a takeover never lands in the middle of a call (row 9)', () => {
  test('row 9: while a mutating call runs in the holder, the asking tab waits; the holder keeps the link until the result is sent, then moves and the caller gets the result', async ({ browser }) => {
    const { helper } = await helperUp();
    const a = await connectedTab(await browser.newContext(), helper, 'A');
    const b = await waitingTab(await browser.newContext(), helper, 'B');
    await holdCalls(a);

    const call = helper.call('moveItem', { itemId: 'v1', by: 1 }, undefined);
    await expect.poll(() => held(a)).toEqual([{ toolName: 'moveItem', input: { itemId: 'v1', by: 1 } }]);

    await openPanel(b);
    await b.getByTestId('agent-link-connect').click();
    await expect(badge(b)).toHaveAttribute('data-status', 'confirm');
    await b.getByRole('button', { name: 'Take over' }).click();
    await expect(badge(b)).toHaveAttribute('data-status', 'connecting');
    await b.waitForTimeout(500); // the wait is the point; there is nothing to poll for
    await expect(badge(a)).toHaveAttribute('data-status', 'connected');
    await expect(badge(b)).toHaveAttribute('data-status', 'connecting');
    expect((await sockets(a)).map(s => s.code)).toEqual([undefined]);

    await release(a, { success: true, moved: 1 });
    expect(await call).toEqual({ success: true, moved: 1 }); // the old tab's answer reaches the caller
    await expect(badge(b)).toHaveAttribute('data-status', 'connected');
    await expect(badge(a)).toHaveAttribute('data-status', 'moved');
    expect((await sockets(a))[0]).toMatchObject({ code: 4409, reason: 'superseded' });
  });
});

test.describe('reconnect schedule (row 9)', () => {
  /** Freezes the page clock a moment after load so retry timers fire only when the test says so. */
  async function freeze(page: Page) {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(new Date(now + 100));
    return page.evaluate(() => Date.now());
  }
  const label = (page: Page) => badge(page).textContent();

  test('row 9: with the helper gone the tab redials after 250 ms, 1 s, 2 s, 4 s and 8 s (×6) — exactly 10 redials, "Reconnecting…" from the 2nd — then shows Connection lost; Connect tab brings it back', async ({ page }) => {
    expect(RECONNECT_DELAYS).toEqual([250, 1000, 2000, 4000, 8000]);
    expect(RECONNECT_MAX).toBe(10);
    const { helper, configDir } = await helperUp();
    const port = helper.port;
    await page.clock.install({ time: new Date('2026-11-01T10:00:00Z') });
    await page.goto('/');
    await pairedTab(page, helper);
    await seedLink(page, port, true);
    await recordSockets(page);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    const base = await freeze(page);

    await helper.close();
    await expect.poll(async () => (await sockets(page))[0].code).toBe(4503);
    await expect(badge(page)).toHaveText('Connecting…'); // attempt 1
    expect(await sockets(page)).toHaveLength(1);

    const waits = [250, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000];
    let elapsed = 0;
    for (const [i, wait] of waits.entries()) {
      await page.clock.runFor(wait - 1);
      expect(await sockets(page), `no redial ${i + 1} before ${wait} ms`).toHaveLength(i + 1);
      await page.clock.runFor(1);
      elapsed += wait;
      await expect.poll(async () => (await sockets(page)).length, { message: `redial ${i + 1}` }).toBe(i + 2);
      await expect.poll(async () => (await sockets(page))[i + 1].code, { message: `redial ${i + 1} fails` }).toBe(1006);
      expect((await sockets(page))[i + 1].at - base, `redial ${i + 1} fires after ${wait} ms`).toBe(elapsed);
      if (i < waits.length - 1) await expect(badge(page)).toHaveText('Reconnecting…');
    }
    expect(waits.reduce((a, b) => a + b)).toBe(250 + 1000 + 2000 + 4000 + 8000 * 6);
    await expect(badge(page)).toHaveAttribute('data-status', 'lost');
    await expect(badge(page)).toHaveText('Connection lost');
    await page.clock.runFor(60_000);
    expect(await sockets(page)).toHaveLength(11); // it gave up: nothing more is dialled
    expect(await label(page)).toBe('Connection lost');

    // The user brings it back: same port, same pairing file.
    const again = await startHelper({ port, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!] });
    cleanups.push(() => again.close());
    await openPanel(page);
    await expect(page.getByTestId('agent-link-panel')).toContainText('The connection to the helper was lost.');
    await page.getByTestId('agent-link-connect').click();
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
  });

  test('row 9: a helper that comes back during the schedule is picked up by the next redial; after a stable connection the schedule starts over at 250 ms', async ({ page }) => {
    const { helper, configDir } = await helperUp();
    const port = helper.port;
    await page.clock.install({ time: new Date('2026-11-01T10:00:00Z') });
    await page.goto('/');
    await pairedTab(page, helper);
    await seedLink(page, port, true);
    await recordSockets(page);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    const base = await freeze(page);

    await helper.close();
    await expect.poll(async () => (await sockets(page))[0].code).toBe(4503);
    await page.clock.runFor(250); // redial 1 fails
    await expect.poll(async () => (await sockets(page))[1]?.code).toBe(1006);
    const again = await startHelper({ port, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!] });
    cleanups.push(() => again.close());
    await page.clock.runFor(999);
    expect(await sockets(page)).toHaveLength(2);
    await page.clock.runFor(1); // redial 2 (1 s) finds the helper
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    expect((await sockets(page))[2].at - base).toBe(1250);

    await page.clock.runFor(5_000); // RECONNECT_STABLE_MS: the attempt counter resets
    await again.close();
    await expect.poll(async () => (await sockets(page))[2].code).toBe(4503);
    const after = (await sockets(page)).length;
    await page.clock.runFor(249);
    expect(await sockets(page)).toHaveLength(after);
    await page.clock.runFor(1);
    await expect.poll(async () => (await sockets(page)).length).toBe(after + 1);
    await expect(badge(page)).toHaveText(/^(Connecting…|Reconnecting…)$/);
  });

  test('row 9: a link that drops before it has been stable for 5 s keeps counting up the schedule instead of restarting it', async ({ page }) => {
    const { helper, configDir } = await helperUp();
    const port = helper.port;
    await page.clock.install({ time: new Date('2026-11-01T10:00:00Z') });
    await page.goto('/');
    await pairedTab(page, helper);
    await seedLink(page, port, true);
    await recordSockets(page);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    const base = await freeze(page);

    await helper.close();
    await expect.poll(async () => (await sockets(page))[0].code).toBe(4503);
    await page.clock.runFor(250); // redial 1 fails → next wait 1 s
    await expect.poll(async () => (await sockets(page))[1]?.code).toBe(1006);
    const again = await startHelper({ port, log: () => {}, configDir, allowOrigins: [test.info().project.use.baseURL!] });
    cleanups.push(() => again.close());
    await page.clock.runFor(1000);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    await page.clock.runFor(1_000); // connected for 1 s only
    await again.close();
    await expect.poll(async () => (await sockets(page))[2].code).toBe(4503);
    const n = (await sockets(page)).length;
    await page.clock.runFor(1999);
    expect(await sockets(page)).toHaveLength(n); // the next wait is 2 s, not 250 ms
    await page.clock.runFor(1);
    await expect.poll(async () => (await sockets(page)).length).toBe(n + 1);
    expect((await sockets(page))[n].at - base).toBe(250 + 1000 + 1000 + 2000);
  });
});

