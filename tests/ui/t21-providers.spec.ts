// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 6 in Chromium (ticket "Providers"): each of the three model protocols passes the Test button against a mock server
// that records the request; Remove deletes the key; a stored key is never in clear text in IndexedDB, localStorage, a project, a checkpoint;
// the usage counters sit on the provider rows; every no-key state appears with no request leaving the app. Nothing leaves localhost.
import { test, expect, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { guard, openEditor, skipTour } from './t02-support';
import { docWith, openProject, saveButton, cpList, storedOf } from './t17-support';
import { seekMs } from './t15-support';

test.use({ viewport: { width: 1400, height: 900 } });
const KEY = 'sk-t21-SECRET-key-0123456789';
type Seen = { method: string; path: string; headers: IncomingMessage['headers']; body: any };
let server: Server, origin = '', seen: Seen[] = [];
/** What the mock server answers: tools = the model used the Test tool; window = the context window it reports (null: none). */
const mode = { tools: true, window: 128_000 as number | null };

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8'), path = (req.url ?? '').split('?')[0];
      res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*'); res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
      seen.push({ method: req.method ?? '', path, headers: req.headers, body: text ? JSON.parse(text) : undefined });
      res.setHeader('content-type', 'application/json');
      const ok = (json: unknown) => res.end(JSON.stringify(json));
      if (path === '/openai/v1/chat/completions') return ok({ model: 'gpt-mock-1', choices: [{ message: mode.tools ? { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"ok":true}' } }] } : { content: 'pong' } }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
      if (path === '/openai/v1/models') return ok({ data: [{ id: 'gpt-mock', ...mode.window ? { context_length: mode.window } : {} }] });
      if (path === '/anthropic/v1/messages') return ok({ model: 'claude-mock-1', content: mode.tools ? [{ type: 'tool_use', id: 't1', name: 'ping', input: { ok: true } }] : [{ type: 'text', text: 'pong' }], usage: { input_tokens: 12, output_tokens: 4 } });
      if (path.startsWith('/anthropic/v1/models/')) return ok({ id: 'claude-mock', ...mode.window ? { max_input_tokens: mode.window } : {} });
      if (path === '/gemini/v1beta/models/gemini-mock:generateContent') return ok({ modelVersion: 'gemini-mock-001', candidates: [{ content: { parts: mode.tools ? [{ functionCall: { name: 'ping', args: { ok: true } } }] : [{ text: 'pong' }] } }], usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 5 } });
      if (path === '/gemini/v1beta/models/gemini-mock') return ok({ name: 'models/gemini-mock', ...mode.window ? { inputTokenLimit: mode.window } : {} });
      res.statusCode = 404; ok({ error: { message: `no route ${path}` } });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise(r => server.close(r)); });

const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { seen = []; mode.tools = true; mode.window = 128_000; leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

const PROTOCOLS = {
  openai: { label: 'Local OpenAI', option: 'OpenAI-compatible', base: '/openai/v1', model: 'gpt-mock' },
  anthropic: { label: 'Local Claude', option: 'Anthropic Messages', base: '/anthropic', model: 'claude-mock' },
  gemini: { label: 'Local Gemini', option: 'Google Gemini', base: '/gemini', model: 'gemini-mock' },
} as const;
type Name = keyof typeof PROTOCOLS;
const secretState = (page: Page, id?: string) => page.evaluate(async id => {
  const p = '/src/settings/secrets.ts', q = '/src/store/database.ts', s = await import(p), { projectStore } = await import(q);
  const row = (await projectStore.row('settings', 'providers')) as { connections: { id: string }[] } | undefined, key = id ?? `model:${row?.connections[0]?.id}`;
  return { has: await s.hasSecret(key), origin: await s.secretOrigin(key) as string | undefined };
}, id);
/** Adds a connection through Settings → AI and services. */
async function add(page: Page, name: Name, key = KEY, base = origin + PROTOCOLS[name].base) {
  const p = PROTOCOLS[name];
  await page.goto('/settings');
  await page.getByRole('button', { name: '＋ Add connection' }).click();
  const form = page.getByRole('form', { name: 'Add a model connection' });
  await form.getByLabel('Name').fill(p.label); await form.getByLabel('Protocol').selectOption({ label: p.option });
  await form.getByLabel('Base URL').fill(base); if (key) await form.getByLabel('API key').fill(key);
  await form.getByRole('button', { name: 'Add connection' }).click();
  const row = page.locator(`li[data-connection="${p.label}"]`);
  await expect(row).toBeVisible();
  return row;
}
/** Sealed keys in the secrets database, the master record not counted (0 when it does not exist yet). */
const secretCount = (page: Page) => page.evaluate(() => new Promise<number>(res => {
  const r = indexedDB.open('cutframe-secrets');
  r.onsuccess = () => { const db = r.result, names = [...db.objectStoreNames]; if (!names.length) { db.close(); return res(0); } const c = db.transaction(names[0]).objectStore(names[0]).getAllKeys(); c.onsuccess = () => { db.close(); res(c.result.filter(k => k !== 'master').length); }; };
  r.onerror = () => res(0);
}));
const test_ = async (row: ReturnType<Page['locator']>, model: string) => {
  await row.getByLabel(/^Model to test on /).fill(model); await row.getByRole('button', { name: 'Test' }).click();
  return row.getByTestId('connection-test');
};

test.describe('Test button against a recording mock server', () => {
  test('row 6: OpenAI-compatible — POST /chat/completions with a Bearer key and the Test tool; shows the model name, "Tool calls work" and the context window', async ({ page }) => {
    const row = await add(page, 'openai');
    await expect(await test_(row, 'gpt-mock')).toHaveText('Works. Model gpt-mock-1. Tool calls work. Context window 128,000.');
    const post = seen.find(r => r.method === 'POST')!, get = seen.find(r => r.method === 'GET')!;
    expect(post.path).toBe('/openai/v1/chat/completions');
    expect(post.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(post.headers['content-type']).toContain('application/json');
    expect(post.body).toMatchObject({ model: 'gpt-mock', stream: false, messages: [{ role: 'user', content: expect.any(String) }], tools: [{ type: 'function', function: { name: 'ping' } }] });
    expect(post.body.tools[0].function.parameters).toMatchObject({ type: 'object', properties: { ok: expect.any(Object) } });
    expect(get.path).toBe('/openai/v1/models'); expect(get.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen).toHaveLength(2); // one test turn and one listing, nothing else
  });

  test('row 6: Anthropic Messages — POST /v1/messages with x-api-key, anthropic-version and input_schema tools; shows the model name, tools and the context window', async ({ page }) => {
    const row = await add(page, 'anthropic');
    await expect(await test_(row, 'claude-mock')).toHaveText('Works. Model claude-mock-1. Tool calls work. Context window 128,000.');
    const post = seen.find(r => r.method === 'POST')!, get = seen.find(r => r.method === 'GET')!;
    expect(post.path).toBe('/anthropic/v1/messages');
    expect(post.headers['x-api-key']).toBe(KEY); expect(post.headers['anthropic-version']).toBe('2023-06-01'); expect(post.headers.authorization).toBeUndefined();
    expect(post.body).toMatchObject({ model: 'claude-mock', max_tokens: 64, messages: [{ role: 'user', content: expect.any(String) }], tools: [{ name: 'ping', input_schema: { type: 'object' } }] });
    expect(get.path).toBe('/anthropic/v1/models/claude-mock'); expect(get.headers['x-api-key']).toBe(KEY);
    expect(seen).toHaveLength(2);
  });

  test('row 6: Google Gemini — POST :generateContent with x-goog-api-key and functionDeclarations whose schema has a property; shows the model name, tools and the context window', async ({ page }) => {
    const row = await add(page, 'gemini');
    await expect(await test_(row, 'gemini-mock')).toHaveText('Works. Model gemini-mock-001. Tool calls work. Context window 128,000.');
    const post = seen.find(r => r.method === 'POST')!, get = seen.find(r => r.method === 'GET')!;
    expect(post.path).toBe('/gemini/v1beta/models/gemini-mock:generateContent');
    expect(post.headers['x-goog-api-key']).toBe(KEY);
    expect(post.body).toMatchObject({ contents: [{ role: 'user', parts: [{ text: expect.any(String) }] }], tools: [{ functionDeclarations: [{ name: 'ping' }] }] });
    expect(Object.keys(post.body.tools[0].functionDeclarations[0].parameters.properties).length).toBeGreaterThan(0); // Gemini refuses an object schema with none
    expect(get.path).toBe('/gemini/v1beta/models/gemini-mock'); expect(get.headers['x-goog-api-key']).toBe(KEY);
    expect(seen).toHaveLength(2);
  });

  for (const name of ['openai', 'anthropic', 'gemini'] as const) {
    test(`row 6: ${name} — a model that does not use the tool is shown as "Tool calls were not used", and a server that reports no window shows none`, async ({ page }) => {
      mode.tools = false; mode.window = null;
      const row = await add(page, name);
      const text = await test_(row, PROTOCOLS[name].model);
      await expect(text).toContainText('Works.'); await expect(text).toContainText('Tool calls were not used.'); await expect(text).not.toContainText('Context window');
    });
  }

  test('row 6: a server error is shown with its status and message, and a wrong path is not reported as working', async ({ page }) => {
    const row = await add(page, 'openai', KEY, origin + '/nowhere');
    const text = await test_(row, 'gpt-mock');
    await expect(text).toContainText('answered 404'); await expect(text).toContainText('no route'); await expect(text).not.toContainText('Works.');
  });

  test('row 6: no key is sent to a keyless local server (no Authorization header), and a key is sent only to the origin it was entered for', async ({ page }) => {
    const row = await add(page, 'openai', '');
    await expect(row).toContainText('No key'); await expect(row).toContainText('Runs on your machine. No provider bills it.');
    await expect(await test_(row, 'gpt-mock')).toContainText('Works.');
    expect(seen.every(r => r.headers.authorization === undefined)).toBe(true);
  });
});

test.describe('keys', () => {
  test('row 6: Remove deletes the connection and its key from the encrypted store, and nothing sends it afterwards', async ({ page }) => {
    const row = await add(page, 'anthropic');
    await expect(row).toContainText('Key saved');
    expect(await secretState(page)).toEqual({ has: true, origin });
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('li[data-connection]')).toHaveCount(0);
    await expect(page.getByText('No model connections.')).toBeVisible();
    await page.reload(); await expect(page.getByText('No model connections.')).toBeVisible();
    expect(await secretCount(page)).toBe(0);
  });

  test('row 6: changing the base URL to another origin removes the saved key; keeping the origin keeps it', async ({ page }) => {
    const row = await add(page, 'openai');
    await row.getByRole('button', { name: 'Edit' }).click();
    const form = page.locator('form[aria-label^="Edit "]');
    await form.getByLabel('Base URL').fill(origin + '/openai/other'); await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator(`li[data-connection="${PROTOCOLS.openai.label}"]`)).toContainText('Key saved'); // same origin
    expect((await secretState(page)).has).toBe(true);
    await page.locator(`li[data-connection="${PROTOCOLS.openai.label}"]`).getByRole('button', { name: 'Edit' }).click();
    await page.locator('form[aria-label^="Edit "]').getByLabel('Base URL').fill('http://localhost:' + new URL(origin).port + '/openai/v1');
    await page.locator('form[aria-label^="Edit "]').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator(`li[data-connection="${PROTOCOLS.openai.label}"]`)).toContainText('No key'); // localhost ≠ 127.0.0.1
    expect((await secretState(page)).has).toBe(false);
  });

  test('row 6: the key string is in no clear text: not in IndexedDB (every database, bytes included), localStorage, sessionStorage, the project JSON or a checkpoint', async ({ page }) => {
    const row = await add(page, 'openai');
    await expect(row).toContainText('Key saved');
    await expect(await test_(row, 'gpt-mock')).toContainText('Works.'); // a used key leaves no trace either
    expect((await secretState(page)).has).toBe(true); // the scan is not vacuous: the sealed record is there
    const id = await openProject(page, docWith(['title', 'photo', 'clipA']), false, 'T21 key scan');
    await saveButton(page).click(); await expect.poll(async () => (await cpList(page, id)).length).toBe(1);
    const project = JSON.stringify(await storedOf(page, id)), checkpoint = JSON.stringify(await cpList(page, id));
    const dump = await page.evaluate(async () => {
      const text = (v: unknown): string => {
        if (typeof v === 'string') return v;
        if (v instanceof ArrayBuffer) return new TextDecoder('latin1').decode(v);
        if (ArrayBuffer.isView(v)) return new TextDecoder('latin1').decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        if (Array.isArray(v)) return v.map(text).join('\n');
        if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => k + '=' + text(x)).join('\n');
        return String(v);
      };
      const out: Record<string, string> = {};
      for (const info of await (indexedDB as any).databases()) {
        const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const store of db.objectStoreNames) {
          const all = await new Promise<unknown[]>(res => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); });
          out[`${info.name}/${store}`] = all.map(text).join('\n');
        }
        db.close();
      }
      out.localStorage = Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join('\n'); out.sessionStorage = Object.entries(sessionStorage).map(([k, v]) => `${k}=${v}`).join('\n');
      return out;
    });
    expect(Object.keys(dump).some(k => k.startsWith('cutframe-secrets/'))).toBe(true);
    for (const [where, content] of Object.entries(dump)) expect(content.includes(KEY), `key in clear in ${where}`).toBe(false);
    expect(project.includes(KEY), 'project JSON').toBe(false); expect(checkpoint.includes(KEY), 'checkpoint').toBe(false);
    expect(JSON.stringify(dump).includes(KEY.slice(3, 20))).toBe(false); // nor a fragment
  });

  test('row 6: the speech and stock keys are sealed too and the stock key goes only to its own library', async ({ page }) => {
    await page.goto('/settings');
    await page.getByLabel('Pexels API key').fill(KEY + '-pexels'); await page.getByRole('button', { name: /Save Pexels key|Save/ }).first().click();
    await expect.poll(async () => (await secretState(page, 'stock:pexels')).has).toBe(true);
    expect((await secretState(page, 'stock:pexels')).origin).toMatch(/pexels\.com$/);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage })).then(s => s.includes('-pexels'))).toBe(false);
  });
});

test.describe('usage counters', () => {
  const seed = (page: Page) => page.evaluate(async () => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    await projectStore.putRow('settings', { id: 'providers', connections: [{ id: 'c1', label: 'Counted model', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' }], fallback: { connection: 'c1', model: 'gpt-test' }, jobs: {}, speech: 'local' });
    localStorage.setItem('cutframe:usage:v1', JSON.stringify({ models: { c1: { requests: 3, input: 1200, output: 300, lastTurn: 1500 } }, requests: { pexels: 5 }, exports: 0 }));
  });

  test('row 6 (5): a model provider row shows this device\'s usage counter (requests and tokens)', async ({ page }) => {
    await page.goto('/settings'); await seed(page); await page.reload();
    const row = page.locator('li[data-connection="Counted model"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Billed by OpenAI');
    await expect(row, 'the provider row shows its request and token counter').toContainText(/3 requests/);
    await expect(row).toContainText('1,200');
  });

  test('row 6 (5): a stock provider row shows this device\'s request counter', async ({ page }) => {
    await page.goto('/settings'); await seed(page); await page.reload();
    const row = page.locator('section[aria-labelledby="ai-services"] li').filter({ has: page.getByLabel('Pexels API key') });
    await expect(row).toBeVisible();
    await expect(row, 'the stock row shows its request counter').toContainText(/5 requests/);
  });

  test('row 6 (5): a turn made on a connection is counted on this device (tokens from the answer) and the Local usage panel shows it', async ({ page }) => {
    const row = await add(page, 'openai');
    await page.evaluate(async ({ origin }) => {
      const p = '/src/settings/providers.ts', q = '/src/store/database.ts'; const { complete, readProviders, modelFor } = await import(p), { projectStore } = await import(q);
      const s = await readProviders(projectStore);
      await projectStore.putRow('settings', { id: 'providers', ...s, fallback: { connection: s.connections[0].id, model: 'gpt-mock' } });
      await complete(modelFor({ ...s, fallback: { connection: s.connections[0].id, model: 'gpt-mock' } }, 'chat')!, { user: 'hello', tool: true });
      void origin;
    }, { origin });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutframe:usage:v1')!).models)).toEqual({ [await page.evaluate(async () => { const q = '/src/store/database.ts'; const { projectStore } = await import(q); return ((await projectStore.row('settings', 'providers')) as any).connections[0].id as string; })]: { requests: 1, input: 11, output: 3, lastTurn: 14 } });
    await page.reload();
    await expect(page.getByTestId('usage-ai')).toContainText('1 request');
    void row;
  });
});

test.describe('no-key states', () => {
  test('row 6 (6): with no model provider, Settings says what still works and the app asks nothing of any provider', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('No model connections.')).toBeVisible();
    await expect(page.getByText(/No default model\. Editing, export and every manual feature work without one\./)).toBeVisible();
    await expect(page.getByTestId('usage-ai')).toHaveText('No provider connected');
    await page.getByRole('button', { name: '＋ Add connection' }).click();
    await expect(page.getByRole('form', { name: 'Add a model connection' }).getByRole('button', { name: 'Add connection' })).toBeDisabled();
    expect(seen).toEqual([]);
  });

  test('row 6 (6): without a model, motion-graphic repair is disabled with its hint, and no request is made', async ({ page }) => {
    const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
    const item = { id: 'g1', type: 'motionGraphic', trackId: 'o1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000, playbackRate: 1, details: { name: 'Boomer', code: `export const G = () => { throw new Error('boom'); };` }, metadata: {}, effects: [], masks: [],
      properties: { positionX: prop(100), positionY: prop(200), width: prop(200), height: prop(100), scale: prop(1) } };
    await openEditor(page, { schemaVersion: 4, rev: 0, groups: {}, duration: 4000, fps: 30, size: { width: 540, height: 960 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
      tracks: [{ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 }], layerOrder: [{ type: 'track', id: 'o1' }], items: [item] }, 'T21 repair no key');
    await seekMs(page, 500);
    const panel = page.getByRole('group', { name: 'Motion graphic error' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Fix automatically' })).toBeDisabled();
    await expect(panel.getByText('Connect a model to repair motion graphics.', { exact: true })).toBeVisible();
    expect(seen).toEqual([]);
  });

  test('row 6 (6): the project title stays "Untitled Project" with no model provider', async ({ page }) => {
    const id = await openProject(page, docWith(['title', 'clipA']), false, 'Untitled Project');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(async id => { const q = '/src/store/database.ts'; const { projectStore } = await import(q); return (await projectStore.list()).find((p: any) => p.id === id)?.title; }, id)).toBe('Untitled Project');
    expect(seen).toEqual([]);
  });

  test('row 6 (6): without a stock key, Photos, Videos and Sounds each show "Add a free key" naming the provider; no request is made; the rest of the editor works', async ({ page }) => {
    await openEditor(page, docWith(['title', 'clipA']), 'T21 stock no key');
    const asked: string[] = []; page.on('request', r => { const u = new URL(r.url()); if (u.origin !== new URL(page.url()).origin) asked.push(r.url()); });
    for (const [tab, provider] of [['Photos', 'Pexels and Unsplash'], ['Videos', 'Pexels'], ['Sounds', 'Freesound']] as const) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const group = page.getByRole('group', { name: 'Stock keys' });
      await expect(group).toContainText('Add a free key'); await expect(group).toContainText(provider);
    }
    await page.getByRole('tab', { name: 'Photos', exact: true }).click(); // tab switching alone searched nothing
    expect(asked).toEqual([]); expect(seen).toEqual([]);
  });
});
