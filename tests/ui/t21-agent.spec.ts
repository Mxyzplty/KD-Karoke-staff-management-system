// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance rows 7, 12 and 14 in Chromium, against a real helper: the External Agent card (connections with Revoke, Allowed
// directories per device), the editor's agent badge and its popover, the editor with no helper running, and the origin rule (a page
// on a port the helper does not own is refused; the same port passes with --allow-origin). Nothing leaves localhost.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Helper, OWN_ORIGINS, startHelper } from '../../apps/helper/src/helper';
import { createProject, guard, richDoc, skipTour } from './t02-support';
import { docWith, run, saveButton } from './t17-support';

test.use({ viewport: { width: 1400, height: 900 } });
const LINK_KEY = 'cutframe:agent-link:v1';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
const leaks = new WeakMap<Page, string[]>();
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  leaks.set(page, guard(page)); await skipTour(page);
  const seen: string[] = []; errors.set(page, seen);
  page.on('pageerror', e => seen.push(`pageerror: ${e.message}`));
});
test.afterEach(async ({ page }) => {
  while (cleanups.length) await cleanups.pop()!();
  expect(leaks.get(page), 'requests that left localhost').toEqual([]);
  expect(errors.get(page), 'errors thrown in the page').toEqual([]);
});

async function helperUp(options: ConstructorParameters<typeof Helper>[0] = {}, logs: string[] = []) {
  const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), 't21-agent-'));
  const helper = await startHelper({ port: 0, log: m => logs.push(m), configDir, allowOrigins: [test.info().project.use.baseURL!], ...options });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  return helper;
}
const badge = (page: Page) => page.getByTestId('agent-link-badge');
const panel = (page: Page) => page.getByTestId('agent-link-panel');
/** Connect tab → the printed code → Pair, in whichever panel the page shows (the editor popover or the Settings card). */
async function pair(page: Page, helper: Helper) {
  await page.getByTestId('agent-link-port').fill(String(helper.port));
  await page.getByTestId('agent-link-connect').click();
  await expect(page.getByTestId('agent-link-code')).toBeVisible(); // the helper mints its code when the tab asks to pair
  await page.getByTestId('agent-link-code').fill(helper.pairingCode!);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(panel(page)).toContainText(`Connected to the helper on port ${helper.port}`);
}
async function openProject(page: Page, doc: unknown = richDoc()) {
  const id = await createProject(page, doc, 'T21 agent');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return id;
}
/** Pairings the helper has stored (its file is written on the first one). */
const tokens = (helper: Helper) => existsSync(helper.store.file) ? (JSON.parse(readFileSync(helper.store.file, 'utf8')).tokens as unknown[]).length : 0;
const storedToken = (page: Page) => page.evaluate(() => new Promise<string | undefined>(resolve => {
  const open = indexedDB.open('cutframe-agent', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => resolve(undefined);
  open.onsuccess = () => { const db = open.result, req = db.transaction('kv').objectStore('kv').get('token'); req.onsuccess = () => { db.close(); resolve(req.result as string | undefined); }; req.onerror = () => { db.close(); resolve(undefined); }; };
}));
/** A stand-in for showDirectoryPicker that hands back a real OPFS directory handle; queryPermission answers window.__perm. */
const stubFolders = (page: Page) => page.addInitScript(() => {
  // the state lives in sessionStorage: the init script runs again on every reload
  const get = (k: string, d: string) => sessionStorage.getItem(k) ?? d, set = (k: string, v: string) => sessionStorage.setItem(k, v);
  (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => { const n = Number(get('t21-next', '0')) + 1; set('t21-next', String(n)); return (await navigator.storage.getDirectory()).getDirectoryHandle(`t21-folder-${n}`, { create: true }); };
  const proto = (window as unknown as { FileSystemHandle: { prototype: Record<string, unknown> } }).FileSystemHandle.prototype;
  proto.queryPermission = async () => get('t21-perm', 'granted');
  proto.requestPermission = async () => { set('t21-asked', String(Number(get('t21-asked', '0')) + 1)); set('t21-perm', 'granted'); return 'granted'; };
});
const perm = (page: Page, state: string) => page.evaluate(s => sessionStorage.setItem('t21-perm', s), state);
const folderRows = (page: Page) => page.locator('ul[aria-label="Allowed directories"] li');

test.describe('row 4 — own-agent track', () => {
  test('row 4: pairing on the Connect step reaches the Ready page; Open Cutframe finishes and goes home', async ({ page }) => {
    const helper = await helperUp(), KEY = 'cutframe:onboarding:v1';
    const stored = () => page.evaluate(k => JSON.parse(localStorage.getItem(k)!), KEY);
    await page.goto('/settings');
    await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ phase: 'connect', drive: 'own', step: 0, answers: {}, other: {}, completed: false })), KEY);
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: 'Pair this tab' })).toBeVisible();
    await expect(page.getByTestId('connect-troubleshooting')).toContainText('Troubleshooting');
    await page.getByTestId('agent-link-port').fill(String(helper.port));
    await page.getByTestId('agent-link-connect').click();
    await expect(page.getByTestId('agent-link-code')).toBeVisible();
    await page.getByTestId('agent-link-code').fill(helper.pairingCode!);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'All set' })).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding$/);
    expect(await stored()).toMatchObject({ phase: 'ready', completed: false });
    await page.getByRole('button', { name: 'Open Cutframe' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(await stored()).toMatchObject({ phase: 'ready', completed: true });
  });
});

test.describe('row 7 — connections', () => {
  test('row 7: the External Agent card lists this browser and each connected MCP client from a real helper; Revoke all unpairs the tab at the helper', async ({ page }) => {
    const helper = await helperUp();
    await page.goto('/settings#external-agent');
    await expect(page.getByText('No active agent connections')).toBeVisible();
    await pair(page, helper);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)), client = new Client({ name: 't21-agent', version: '9.9.9' });
    await client.connect(transport); cleanups.push(() => client.close());
    await page.evaluate(async () => { const p = '/src/agent/link.ts'; (await import(p)).agentLink.refreshClients(); });
    const list = page.getByRole('list', { name: 'Agent connections' });
    await expect(list).toContainText(`This browser, helper port ${helper.port}`);
    await expect(list).toContainText('t21-agent 9.9.9');
    expect(tokens(helper)).toBe(1); expect(await storedToken(page)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await page.getByRole('button', { name: 'Revoke all' }).click();
    await expect(page.getByText('No active agent connections')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke all' })).toHaveCount(0);
    await expect.poll(() => tokens(helper), { message: 'tokens left on the helper' }).toBe(0);
    expect(await storedToken(page)).toBeUndefined();
    expect(await page.evaluate(k => localStorage.getItem(k), LINK_KEY)).toBeNull();
    await page.reload(); // nothing reconnects after a revoke
    await expect(page.getByText('No active agent connections')).toBeVisible();
  });

  test('row 7: the connection list is per device — it says so, and shows nothing for a helper this tab never paired with', async ({ page }) => {
    await helperUp();
    await page.goto('/settings#external-agent');
    const card = page.locator('#external-agent');
    await expect(card).toContainText('Connections are per device, so every computer needs its own.');
    await expect(card).toContainText('Folders are connected per device, so every computer needs its own.');
    await expect(page.getByRole('list', { name: 'Agent connections' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Revoke all' })).toHaveCount(0);
  });
});

test.describe('row 7 — the shell badge and popover', () => {
  test('row 7: the badge follows agent/link.ts — Connect tab, Connecting…, Connected, then Reconnecting… / Connection lost when the helper stops', async ({ page }) => {
    const helper = await helperUp();
    await openProject(page);
    await expect(badge(page)).toHaveAttribute('data-status', 'idle'); await expect(badge(page)).toHaveText('Connect tab');
    await expect(badge(page)).toHaveAccessibleName('Agent: not connected');
    await badge(page).click(); await expect(panel(page)).toBeVisible();
    await page.getByTestId('agent-link-port').fill(String(helper.port));
    await page.getByTestId('agent-link-connect').click();
    await expect(badge(page)).toHaveAttribute('data-status', 'pairing');
    await expect(badge(page)).toHaveText('Connecting…');
    await page.getByTestId('agent-link-code').fill(helper.pairingCode!);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(badge(page)).toHaveAttribute('data-status', 'connected'); await expect(badge(page)).toHaveText('Connected');
    await expect(badge(page)).toHaveAccessibleName('Agent: Connected');
    await expect(page.getByRole('dialog', { name: 'Agent connection' })).toContainText('Connected');
    await helper.close();
    await expect.poll(() => badge(page).getAttribute('data-status'), { timeout: 30_000 }).toMatch(/^(reconnecting|lost)$/);
    await expect(badge(page)).toHaveText(/Reconnecting…|Connection lost/);
    await page.keyboard.press('Escape');
    await badge(page).click();
    await page.getByRole('button', { name: 'Cancel' }).or(page.getByRole('button', { name: 'Connect tab' })).first().click();
    await expect(badge(page)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
    await expect(badge(page)).toHaveText('Connect tab');
  });

  test('row 7: the popover footer counts this device\'s allowed folders, and "Set up →" opens Settings at the External Agent card', async ({ page }) => {
    await stubFolders(page);
    await openProject(page);
    await badge(page).click();
    const footer = page.locator('.agent-footer');
    await expect(footer).toContainText('No allowed folders on this device.');
    const link = footer.getByRole('link', { name: 'Set up →' });
    await expect(link).toHaveAttribute('href', '/settings#external-agent');
    await link.click();
    await expect(page).toHaveURL(/\/settings#external-agent$/);
    await expect(page.getByRole('heading', { name: 'External Agent (MCP)' })).toBeInViewport();
    await page.getByRole('button', { name: '＋ Add folder' }).click();
    await expect(folderRows(page)).toHaveCount(1);
    const id = await createProject(page, richDoc(), 'T21 footer');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await badge(page).click();
    await expect(page.locator('.agent-footer')).toContainText('1 allowed folder on this device.');
  });
});

test.describe('row 7 — allowed folders per device', () => {
  test('row 7: Add folder lists it with its permission state; Reconnect re-asks; Blocked is shown', async ({ page }) => {
    await stubFolders(page);
    await page.goto('/settings#external-agent');
    await expect(page.getByText('No folders connected on this device')).toBeVisible();
    await page.getByRole('button', { name: '＋ Add folder' }).click();
    const first = page.locator('li[data-folder="t21-folder-1"]');
    await expect(first).toContainText('t21-folder-1'); await expect(first).toContainText('Allowed');
    await expect(first.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    await page.getByRole('button', { name: '＋ Add folder' }).click();
    await expect(folderRows(page)).toHaveCount(2);

    await perm(page, 'prompt'); await page.reload();
    await expect(first).toContainText('Needs permission');
    await first.getByRole('button', { name: 'Reconnect' }).click();
    expect(await page.evaluate(() => sessionStorage.getItem('t21-asked'))).toBe('1');
    await page.reload(); await expect(first).toContainText('Allowed'); // requestPermission granted it
    await perm(page, 'denied'); await page.reload();
    await expect(first).toContainText('Blocked'); await expect(first.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  });

  test('row 7: Remove forgets a folder, one at a time, and the empty state comes back', async ({ page }) => {
    await stubFolders(page);
    await page.goto('/settings#external-agent');
    await page.getByRole('button', { name: '＋ Add folder' }).click();
    const first = page.locator('li[data-folder="t21-folder-1"]');
    await expect(first).toContainText('Allowed');
    await page.getByRole('button', { name: '＋ Add folder' }).click();
    await expect(folderRows(page)).toHaveCount(2);
    await first.getByRole('button', { name: 'Remove' }).click();
    await expect(first).toHaveCount(0); await expect(folderRows(page)).toHaveCount(1);
    expect(await page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.rows('dirs')).map((d: any) => d.name); })).toEqual(['t21-folder-2']);
    await page.reload(); await expect(folderRows(page)).toHaveCount(1);
    await folderRows(page).first().getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('No folders connected on this device')).toBeVisible();
  });

  test('row 7: without a directory picker the card says to use a Chromium browser instead of offering Add folder', async ({ page }) => {
    await page.addInitScript(() => { delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker; });
    await page.goto('/settings#external-agent');
    await expect(page.getByText('Use Chrome, Edge, or another Chromium browser.')).toBeVisible();
    await expect(page.getByRole('button', { name: '＋ Add folder' })).toHaveCount(0);
  });
});

test.describe('row 12 — no helper running', () => {
  test('row 12: with no helper the editor works — edit, undo, save, checkpoint — with no page error and no request beyond the panel-open probe', async ({ page }) => {
    const out: string[] = [];
    page.on('request', r => { const u = new URL(r.url()); if (u.origin !== new URL(page.url() === 'about:blank' ? test.info().project.use.baseURL! : page.url()).origin && !/^(data|blob):/.test(r.url())) out.push(`${r.method()} ${u.origin}${u.pathname}`); });
    page.on('websocket', ws => { const u = new URL(ws.url()); if (u.pathname === '/tab') out.push(`WS ${ws.url()}`); });
    const id = await createProject(page, docWith(['title', 'photo', 'clipA', 'clipB']), 'T21 no helper');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    out.length = 0;
    await expect(badge(page)).toHaveText('Connect tab');
    expect((await run(page, { type: 'deleteItems', itemIds: ['photo'], ripple: false })).ok).toBe(true);
    await expect(page.locator('[data-item-id="photo"]')).toHaveCount(0);
    await page.keyboard.press('Control+z'); await expect(page.locator('[data-item-id="photo"]')).toHaveCount(1);
    await page.keyboard.press('Control+Shift+z'); await expect(page.locator('[data-item-id="photo"]')).toHaveCount(0);
    await saveButton(page).click(); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally'); await expect(page.locator('[data-item-id="photo"]')).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(out, 'nothing is sent to a helper until the user opens the panel').toEqual([]);

    await badge(page).click(); // the one allowed probe: GET /hello on the helper's port range, nothing else
    await expect(page.getByTestId('agent-link-helper')).toHaveText('No helper is running. Start it with npx cutframe-connect.');
    expect(out.length).toBeGreaterThan(0);
    for (const line of out) expect(line, line).toMatch(/^GET http:\/\/127\.0\.0\.1:478(2\d)\/hello$/);
    await page.getByTestId('agent-link-connect').click();
    await expect(page.getByTestId('agent-link-error')).toContainText('No helper answered on 127.0.0.1:47820–47829.');
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    expect((await run(page, { type: 'deleteItems', itemIds: ['clipB'], ripple: false })).ok).toBe(true); // still editing
  });

  test('row 12: Settings with no helper shows the card, the install command and the empty lists, and offers no connection', async ({ page }) => {
    await page.goto('/settings#external-agent');
    await expect(page.getByText('No active agent connections')).toBeVisible();
    await expect(page.locator('#external-agent')).toContainText('npx cutframe-connect');
    await expect(page.getByRole('button', { name: 'Revoke all' })).toHaveCount(0);
  });
});

test.describe('row 14 — the helper\'s origin rule in Chromium', () => {
  test('row 14: a page on a port the helper does not own is refused; restarting on the same port with --allow-origin lets it pair', async ({ page }) => {
    const base = test.info().project.use.baseURL!, origin = new URL(base).origin;
    const own = OWN_ORIGINS.includes(origin), logs: string[] = [];
    const first = await helperUp({ allowOrigins: [] }, logs), port = first.port;
    await openProject(page);
    await badge(page).click();
    await page.getByTestId('agent-link-port').fill(String(port));
    await page.getByTestId('agent-link-connect').click();
    if (own) { // the suite was started on one of the four own origins: no flag needed
      await expect(page.getByTestId('agent-link-code')).toBeVisible();
      await page.getByTestId('agent-link-code').fill(first.pairingCode!);
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      await expect(badge(page)).toHaveAttribute('data-status', 'connected');
      return;
    }
    // /hello carries no CORS grant for this origin, so the editor cannot even find the helper
    await expect(page.getByTestId('agent-link-error')).toContainText('No helper answered');
    await expect(badge(page)).toHaveAttribute('data-status', 'idle');
    // a stored link dials /tab directly: the upgrade is refused with 403 and the helper says how to fix it
    await page.evaluate(([k, p]) => localStorage.setItem(k as string, JSON.stringify({ port: p, auto: true })), [LINK_KEY, port]);
    await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await expect.poll(() => logs.some(l => l.includes(`Refused an editor connection from ${origin}`) && l.includes(`--allow-origin ${origin}`)), { timeout: 15_000, message: logs.join('\n') }).toBe(true);
    await expect(badge(page)).not.toHaveAttribute('data-status', 'connected');
    await expect(badge(page)).not.toHaveAttribute('data-status', 'pairing');
    expect(tokens(first)).toBe(0);

    await first.close();
    const second = await helperUp({ port, allowOrigins: [origin] }, logs);
    expect(second.port).toBe(port);
    await page.evaluate(k => localStorage.removeItem(k), LINK_KEY);
    await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await badge(page).click();
    await pair(page, second);
    await expect(badge(page)).toHaveAttribute('data-status', 'connected');
    expect(tokens(second)).toBe(1);
  });
});
