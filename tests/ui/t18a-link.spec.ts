// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger rows 2 (pair through the UI, the IndexedDB token), 4 (Chromium's 15 s ping, stall, AudioContext keep-alive) and 12 (Promise 4:
// nothing goes out without a stored link; panel probe; stored link dials only /tab; no badge on `/`; loopback guard), against a real helper.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { Helper, startHelper, VERSION } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { LINK_ERRORS, PING_MS, STALL_MS } from '../../apps/web/src/agent/protocol';
import { createProject, guard, richDoc, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
test.setTimeout(60_000); // D34: runFor pays one real macrotask per fake timer, so row 4's 120 s of fake time took up to 27.7 s of the default 30 s under load

const NO_HELPER = 'No helper answered on 127.0.0.1:47820–47829. Run npx cutframe-connect in a terminal, then press Connect tab.';
const LINK_KEY = 'cutframe:agent-link:v1';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]); // the loopback-only guard
});

async function helperUp(options: ConstructorParameters<typeof Helper>[0] = {}) {
  const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), 't18a-link-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, ...options });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  return helper;
}
/** localStorage.<LINK_KEY> before the app loads, once per tab (a later Disconnect must not be undone by the next load). */
const seedLink = (page: Page, port: number, auto: boolean) => page.addInitScript(({ key, port, auto }) => {
  try { if (!sessionStorage.getItem('t18a-seeded')) { localStorage.setItem(key, JSON.stringify({ port, auto })); sessionStorage.setItem('t18a-seeded', '1'); } } catch { /* storage unavailable */ }
}, { key: LINK_KEY, port, auto });
/** Wraps WebSocket so a page records every socket it opens: url, close code and reason, and the clock reading at construction. */
const recordSockets = (page: Page) => page.addInitScript(() => {
  const Native = window.WebSocket, log: { url: string; at: number; code?: number; reason?: string }[] = [];
  (window as any).__sockets = log;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const entry: (typeof log)[number] = { url: String(url), at: Date.now() };
      log.push(entry);
      this.addEventListener('close', e => { entry.code = e.code; entry.reason = e.reason; });
    }
  } as typeof WebSocket;
});
type Sock = { url: string; at: number; code?: number; reason?: string };
const sockets = (page: Page) => page.evaluate(() => ((window as any).__sockets ?? []) as Sock[]).then(all => all.filter(s => new URL(s.url).pathname === '/tab')); // the dev server's own HMR socket is not the link
/** Every request and websocket the page makes to a port in the helper range or the given one. */
function traffic(page: Page, port?: number) {
  const seen = { http: [] as string[], ws: [] as string[] };
  const mine = (u: URL) => (Number(u.port) >= 47820 && Number(u.port) <= 47829) || (port !== undefined && Number(u.port) === port);
  page.on('request', r => { const u = new URL(r.url()); if (mine(u)) seen.http.push(`${r.method()} ${u.origin}${u.pathname}`); });
  page.on('websocket', ws => { const u = new URL(ws.url()); if (mine(u)) seen.ws.push(ws.url()); });
  return seen;
}
const badge = (page: Page) => page.getByTestId('agent-link-badge');
const panel = (page: Page) => page.getByTestId('agent-link-panel');
async function openPanel(page: Page) { await badge(page).click(); await expect(panel(page)).toBeVisible(); }
async function openProject(page: Page) {
  const id = await createProject(page, richDoc(), 'T18a link');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return id;
}
const token = (page: Page) => page.evaluate(() => new Promise<string | undefined>(resolve => {
  const open = indexedDB.open('cutframe-agent', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => resolve(undefined);
  open.onsuccess = () => { const db = open.result, req = db.transaction('kv').objectStore('kv').get('token'); req.onsuccess = () => { db.close(); resolve(req.result as string | undefined); }; req.onerror = () => { db.close(); resolve(undefined); }; };
}));
/** Gives the tab a stored pairing: a token known to the helper and kept where the editor keeps it. Needs a page on the app origin. */
async function pairedTab(page: Page, helper: Helper) {
  const t = newToken(); helper.store.add(t);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), t);
  return t;
}
/** The panel flow the user follows: Connect tab → enter the printed code → Pair. */
async function pairThroughPanel(page: Page, helper: Helper) {
  await openPanel(page);
  await page.getByTestId('agent-link-port').fill(String(helper.port));
  await page.getByTestId('agent-link-connect').click();
  await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
  await page.getByTestId('agent-link-code').fill(helper.pairingCode!);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(badge(page)).toHaveAttribute('data-status', 'connected');
}

test.describe('Promise 4 — nothing goes out until the user asks (row 12)', () => {
  test('row 12: loading `/` and a project page without a stored link makes no helper request and no websocket; the badge is on the project page only', async ({ page }) => {
    const seen = traffic(page);
    await page.goto('/');
    await expect(page.getByTestId('agent-link')).toHaveCount(0); // no badge on `/`
    const id = await createProject(page, richDoc(), 'T18a link');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await expect(badge(page)).toHaveText('Connect tab');
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    expect(seen).toEqual({ http: [], ws: [] });
    await page.goto('/');
    await expect(page.getByTestId('agent-link')).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(seen).toEqual({ http: [], ws: [] });
  });

  test('row 12: opening the panel is the first probe — one GET /hello per port 47820–47829, no websocket; no helper → "No helper is running. Start it with npx cutframe-connect."', async ({ page }) => {
    const seen = traffic(page);
    await openProject(page);
    await openPanel(page);
    await expect(page.getByTestId('agent-link-helper')).toHaveText('No helper is running. Start it with npx cutframe-connect.');
    expect([...seen.http].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `GET http://127.0.0.1:${47820 + i}/hello`));
    expect(seen.ws).toEqual([]);
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
  });

  test('row 12: Connect tab with no helper → the NO_HELPER sentence, status back to idle, still no websocket', async ({ page }) => {
    const seen = traffic(page);
    await openProject(page);
    await openPanel(page);
    await expect(page.getByTestId('agent-link-helper')).toHaveText('No helper is running. Start it with npx cutframe-connect.');
    await page.getByTestId('agent-link-connect').click();
    await expect(page.getByTestId('agent-link-error')).toHaveText(NO_HELPER);
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    expect(seen.ws).toEqual([]);
  });

  test('row 12: a probe that finds a helper says "Helper <version> found on port <p>." and still opens no websocket until Connect tab', async ({ page }) => {
    const helper = await helperUp();
    await seedLink(page, helper.port, false); // remembers the port, does not auto-connect
    const seen = traffic(page, helper.port);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    await page.waitForTimeout(300);
    expect(seen.ws).toEqual([]);
    expect(seen.http).toEqual([]); // the stored port alone does not make the page talk
    await openPanel(page);
    await expect(page.getByTestId('agent-link-helper')).toHaveText(`Helper ${VERSION} found on port ${helper.port}.`);
    expect(seen.http).toContain(`GET http://127.0.0.1:${helper.port}/hello`);
    expect(seen.ws).toEqual([]);
  });

  test('row 12: a stored link dials only the stored port\'s /tab — no /hello, no port scan — and connects with the stored pairing', async ({ page }) => {
    const helper = await helperUp();
    await page.goto('/');
    await pairedTab(page, helper);
    await seedLink(page, helper.port, true);
    const seen = traffic(page, helper.port);
    await recordSockets(page);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    await expect(badge(page)).toHaveText('Connected');
    expect(seen.http).toEqual([]);
    expect(seen.ws).toEqual([`ws://127.0.0.1:${helper.port}/tab`]);
    expect((await sockets(page)).map(s => s.url)).toEqual([`ws://127.0.0.1:${helper.port}/tab`]);
  });

  test('row 12: a stored link whose helper is not running keeps trying /tab on that port only (never /hello, never the range)', async ({ page }) => {
    const helper = await helperUp();
    const port = helper.port;
    await helper.close();
    await seedLink(page, port, true);
    const seen = traffic(page, port);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', /connecting|reconnecting/);
    await expect.poll(() => seen.ws.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    expect(seen.http).toEqual([]);
    expect(new Set(seen.ws)).toEqual(new Set([`ws://127.0.0.1:${port}/tab`]));
  });
});

test.describe('the badge never blocks the editor (row 12)', () => {
  test('row 12: at 1023×800 the badge does not overlap the "Editor panels" tab bar, and still does not after resizing 1024 → 1023 without a reload', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openProject(page);
    const overlap = () => page.evaluate(() => {
      const a = document.querySelector('[data-testid="agent-link"]')!.getBoundingClientRect();
      const nav = document.querySelector('nav[aria-label="Editor panels"]');
      if (!nav) return null;
      const b = nav.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    });
    expect(await overlap()).toBeNull(); // the wide layout has no tab bar
    await page.setViewportSize({ width: 1023, height: 800 });
    await expect(page.getByRole('navigation', { name: 'Editor panels' })).toBeVisible();
    await expect.poll(overlap).toBe(false);
    await page.reload(); await expect(page.getByRole('navigation', { name: 'Editor panels' })).toBeVisible();
    await expect.poll(overlap).toBe(false);
  });
});

test.describe('pairing through the UI (row 2)', () => {
  test('row 2: Connect tab → code → Pair: connected; the token sits in IndexedDB, only its SHA-256 in the helper file; the link is remembered', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    expect(await token(page)).toBeUndefined();
    await pairThroughPanel(page, helper);
    await expect(badge(page)).toHaveText('Connected');
    await expect(panel(page)).toContainText(`Connected to the helper on port ${helper.port}. MCP clients use http://127.0.0.1:${helper.port}/mcp.`);

    const t = (await token(page))!;
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const file = readFileSync(helper.store.file, 'utf8');
    expect(file).not.toContain(t);
    const stored = JSON.parse(file);
    expect(stored.tokens).toEqual([{ hash: sha256(t), createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), tabId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    expect(await page.evaluate(k => localStorage.getItem(k), LINK_KEY)).toBe(JSON.stringify({ port: helper.port, auto: true }));
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('cutframe:agent-tab:v1')!))).toEqual({ tabId: stored.tokens[0].tabId, connId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  test('row 2: Pair stays disabled until six digits; a wrong code shows the helper\'s PAIRING_CODE_INVALID sentence and the right one still works', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await openPanel(page);
    await page.getByTestId('agent-link-port').fill(String(helper.port));
    await page.getByTestId('agent-link-connect').click();
    await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
    const pair = page.getByRole('button', { name: 'Pair', exact: true });
    await expect(pair).toBeDisabled();
    await page.getByTestId('agent-link-code').fill('12345');
    await expect(pair).toBeDisabled();
    const right = helper.pairingCode!, wrong = right === '000000' ? '111111' : '000000';
    await page.getByTestId('agent-link-code').fill(wrong);
    await expect(pair).toBeEnabled();
    await pair.click();
    await expect(page.getByTestId('agent-link-error')).toHaveText(LINK_ERRORS.PAIRING_CODE_INVALID);
    await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
    expect(helper.store.count()).toBe(0);
    await page.getByTestId('agent-link-code').fill(right);
    await pair.click();
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    await expect(page.getByTestId('agent-link-error')).toHaveCount(0);
  });

  test('row 2: the fifth wrong code shows the PAIRING_LOCKED sentence and drops the tab to idle; Connect tab says so again while locked; after `code` in the helper the new code pairs', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await openPanel(page);
    await page.getByTestId('agent-link-port').fill(String(helper.port));
    await page.getByTestId('agent-link-connect').click();
    await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
    const pair = page.getByRole('button', { name: 'Pair', exact: true }), wrong = helper.pairingCode === '000000' ? '111111' : '000000';
    for (let n = 1; n <= 4; n++) {
      await page.getByTestId('agent-link-code').fill(wrong);
      await pair.click();
      await expect(page.getByTestId('agent-link-error')).toHaveText(LINK_ERRORS.PAIRING_CODE_INVALID);
    }
    await page.getByTestId('agent-link-code').fill(wrong);
    await pair.click();
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    await expect(page.getByTestId('agent-link-error')).toHaveText(LINK_ERRORS.PAIRING_LOCKED);
    expect(helper.locked).toBe(true);
    await page.getByTestId('agent-link-connect').click();
    await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
    await expect(page.getByTestId('agent-link-error')).toHaveText(LINK_ERRORS.PAIRING_LOCKED);
    expect(helper.pairing).toBe(false);
    const code = helper.newCode(); // the terminal `code` command
    await page.getByTestId('agent-link-code').fill(code);
    await pair.click();
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    expect(helper.store.count()).toBe(1);
  });

  test('row 2: the reverse path — the panel shows a code to type into the helper; confirming it there pairs the tab', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await openPanel(page);
    await page.getByTestId('agent-link-port').fill(String(helper.port));
    await page.getByTestId('agent-link-connect').click();
    await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
    const offered = (await page.getByTestId('agent-link-offer').textContent())!;
    expect(offered).toMatch(/^\d{6}$/);
    await expect(page.getByTestId('agent-link-offer').locator('xpath=..')).toHaveText(`Or type ${offered} in the helper’s terminal.`);
    await expect.poll(() => helper.confirmOffer('000000' === offered ? '111111' : '000000')).toBe(false);
    expect(await helper.confirmOffer(offered)).toBe(true);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    expect(helper.store.count()).toBe(1);
    expect(await token(page)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('row 2: Cancel on the pairing step returns to idle with the pairing code left unused', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await openPanel(page);
    await page.getByTestId('agent-link-port').fill(String(helper.port));
    await page.getByTestId('agent-link-connect').click();
    await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    expect(helper.store.count()).toBe(0);
    expect(helper.pairing).toBe(true);
  });

  test('row 2: Disconnect closes the link and forgets the stored link but keeps the pairing; nothing reconnects by itself', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await recordSockets(page);
    await pairThroughPanel(page, helper);
    const t = await token(page);
    const before = (await sockets(page)).length;
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    expect(await page.evaluate(k => localStorage.getItem(k), LINK_KEY)).toBeNull();
    expect(await token(page)).toBe(t);
    expect(helper.store.count()).toBe(1);
    await page.waitForTimeout(600);
    expect((await sockets(page)).length).toBe(before); // no new connection
  });

  test('row 2: Unpair this tab revokes at the helper, deletes the IndexedDB token and the stored link', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await pairThroughPanel(page, helper);
    await page.getByRole('button', { name: 'Unpair this tab' }).click();
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    await expect.poll(() => helper.store.count()).toBe(0);
    expect(await token(page)).toBeUndefined();
    expect(await page.evaluate(k => localStorage.getItem(k), LINK_KEY)).toBeNull();
    expect(JSON.parse(readFileSync(helper.store.file, 'utf8'))).toEqual({ version: 1, tokens: [] });
  });

  test('row 2: the helper revoking every pairing drops this tab to idle with the TOKEN_REVOKED sentence; token and link are cleared', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await pairThroughPanel(page, helper);
    helper.revokeAll();
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    await expect(page.getByTestId('agent-link-error')).toHaveText(LINK_ERRORS.TOKEN_REVOKED);
    expect(await token(page)).toBeUndefined();
    expect(await page.evaluate(k => localStorage.getItem(k), LINK_KEY)).toBeNull();
  });

  test('row 2: after a reload the stored pairing and link reconnect without any click, as the same tab (same tab id, connection id resumed)', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await pairThroughPanel(page, helper);
    const tab = await page.evaluate(() => JSON.parse(sessionStorage.getItem('cutframe:agent-tab:v1')!));
    await page.reload();
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('cutframe:agent-tab:v1')!))).toEqual(tab);
    expect(helper.store.count()).toBe(1);
  });

  test('row 2: a token the helper no longer knows → TOKEN_INVALID, dropped, and the pairing step starts over', async ({ page }) => {
    const helper = await helperUp();
    await page.goto('/');
    await pairedTab(page, helper);
    helper.store.revokeAll(); // the tab still holds a token the file does not
    await seedLink(page, helper.port, true);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
    await expect(panel(page)).toHaveCount(0); // panel closed; only the badge shows the state
    await openPanel(page);
    await expect(page.getByTestId('agent-link-error')).toHaveText(LINK_ERRORS.TOKEN_INVALID);
    expect(await token(page)).toBeUndefined();
  });
});

/** A stand-in helper that records what the browser sends: only the browser side of the protocol is under test here. */
async function fakeHelper(options: { answerPings?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  const port = (wss.address() as { port: number }).port;
  const got: any[] = [], sockets: import('ws').WebSocket[] = [];
  wss.on('connection', ws => {
    sockets.push(ws);
    ws.on('message', d => {
      const m = JSON.parse(String(d)); got.push(m);
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'hello', protocol: 1, version: 'fake', connId: `conn-${sockets.length}`, paired: true, active: true }));
      if (m.type === 'ping' && options.answerPings) ws.send(JSON.stringify({ type: 'pong' }));
    });
  });
  cleanups.push(() => new Promise<void>(resolve => { for (const c of wss.clients) c.terminate(); wss.close(() => resolve()); }));
  return { port, got, sockets, pings: () => got.filter(m => m.type === 'ping').length };
}

test.describe('Chromium and the link (row 4)', () => {
  test('row 4: the tab pings every 15 s (PING_MS) and answers the helper\'s ping with a pong', async ({ page }) => {
    expect(PING_MS).toBe(15_000);
    const fake = await fakeHelper({ answerPings: true });
    await page.clock.install({ time: new Date('2026-11-01T10:00:00Z') });
    await seedLink(page, fake.port, true);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    expect(fake.got[0]).toEqual({ type: 'hello', protocol: 1, projectId: expect.stringMatching(/^[0-9a-f-]{36}$/), tabId: expect.stringMatching(/^[0-9a-f-]{36}$/), takeover: true });
    expect(fake.pings()).toBe(0);
    await page.clock.runFor(10_000);
    expect(fake.pings()).toBe(0);
    await page.clock.runFor(6_000);
    await expect.poll(fake.pings).toBe(1);
    await page.clock.runFor(15_000);
    await expect.poll(fake.pings).toBe(2);
    fake.sockets[0].send(JSON.stringify({ type: 'ping' }));
    await expect.poll(() => fake.got.filter(m => m.type === 'pong').length).toBe(1);
    expect(fake.got.at(-1)).toEqual({ type: 'pong' });
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
  });

  test('row 4: a helper that goes silent for more than 60 s (STALL_MS) is dropped and redialled; one that answers pings is kept', async ({ page }) => {
    expect(STALL_MS).toBe(60_000);
    const fake = await fakeHelper({ answerPings: false });
    // D34: install keeps real wall time flowing through the fake clock; pauseAt freezes it so the 250 ms reconnect does not
    // slip past the 'connecting' assertion. pauseAt only goes forward and real time may have moved the clock on by the time it
    // lands, so it takes a time an hour later, out of real time's reach; no page timers exist yet for the jump to fire.
    await page.clock.install({ time: new Date('2026-11-01T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-01T11:00:00Z'));
    await recordSockets(page);
    await seedLink(page, fake.port, true);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    await page.clock.runFor(45_000); // pings at 15, 30, 45: unanswered, still within 60 s of the hello
    expect(fake.sockets).toHaveLength(1);
    await page.clock.runFor(30_000); // the 75 s check sees > 60 s without a message
    await expect.poll(async () => (await sockets(page))[0].code).toBe(4000);
    await expect(badge(page)).toHaveAttribute('data-status', 'connecting');
    await page.clock.runFor(250);
    await expect.poll(() => fake.sockets.length).toBe(2);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
  });

  test('row 4: a pinging-and-ponging helper is never judged stalled', async ({ page }) => {
    const fake = await fakeHelper({ answerPings: true });
    await page.clock.install({ time: new Date('2026-11-01T10:00:00Z') });
    await seedLink(page, fake.port, true);
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    for (let n = 0; n < 8; n++) { await page.clock.runFor(15_000); await expect.poll(fake.pings).toBe(n + 1); }
    expect(fake.sockets).toHaveLength(1);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
  });

  test('row 4: while connected an inaudible AudioContext (constant source → gain 0) keeps the tab unthrottled; Disconnect closes it', async ({ page }) => {
    const helper = await helperUp();
    await page.addInitScript(() => {
      const Native = window.AudioContext, nodes: GainNode[] = [], rec = { created: 0, closed: 0, gain: [] as number[], sources: 0, started: 0 };
      (window as any).__audio = rec;
      // the gain is set after createGain() returns, so read it live
      Object.defineProperty(rec, 'gain', { enumerable: true, get: () => nodes.map(n => n.gain.value) });
      window.AudioContext = class extends Native {
        constructor(...a: ConstructorParameters<typeof Native>) { super(...a); rec.created++; }
        createGain() { const g = super.createGain(); nodes.push(g); return g; }
        createConstantSource() { rec.sources++; const s = super.createConstantSource(), start = s.start.bind(s); s.start = (...a: [number?]) => { rec.started++; return start(...a); }; return s; }
        close() { rec.closed++; return super.close(); }
      } as typeof AudioContext;
    });
    const audio = () => page.evaluate(() => (window as any).__audio as { created: number; closed: number; gain: number[]; sources: number; started: number });
    await openProject(page);
    expect(await audio()).toEqual({ created: 0, closed: 0, gain: [], sources: 0, started: 0 }); // idle: no audio
    await pairThroughPanel(page, helper);
    expect(await audio()).toEqual({ created: 1, closed: 0, gain: [0], sources: 1, started: 1 });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect.poll(async () => (await audio()).closed).toBe(1);
    expect((await audio()).created).toBe(1);
  });
});
