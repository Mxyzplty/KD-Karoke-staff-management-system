// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 11 (items other tickets deferred to T21), each through the real Settings or editor UI:
// T17 the parity switch (T03 noOp 'reference', T04 slider grouping, in a really opened project), T01/T02 the Help and Community
// destinations and the cloud-backup popover, T14 stock-key management and the folder-connect entry, T08 repair (b) through
// setRepairModel, T19a the model storage line. Nothing leaves localhost (a hosted stock API is answered by a route in the page).
import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addAsset, createProject, guard, notices, openEditor, skipTour } from './t02-support';
import { dragSlider, pick, section, t04Doc } from './t04-support';

test.use({ viewport: { width: 1400, height: 900 } });
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

const PARITY = 'Reference behaviour';
const options = (page: Page) => page.evaluate(async () => { const m = '/src/timeline/runtime.ts', o = (await import(m)).activeRuntime.bus.options; return { noOp: o.noOp ?? 'content', sliderEntries: o.sliderEntries ?? 'drag' }; });
const labels = (page: Page) => page.evaluate(async () => { const m = '/src/timeline/runtime.ts'; return (await import(m)).activeRuntime.bus.undoStack.map((e: { label: string }) => e.label) as string[]; });
/** The same command twice through the open project's own bus: the first changes `vid`, the second writes the value it already has. */
const writeTwice = (page: Page) => page.evaluate(async () => {
  const m = '/src/timeline/runtime.ts', { activeRuntime } = await import(m), bus = activeRuntime.bus;
  const set = () => bus.run('Edit items', 'user', (doc: any) => { doc.items.find((i: any) => i.id === 'vid').details = { ...doc.items.find((i: any) => i.id === 'vid').details, name: 'Same' }; });
  set(); const first = bus.undoStack.length; set();
  return { first, second: bus.undoStack.length };
});

test.describe('row 11 · T17 parity switch, app-wide', () => {
  const stored = (page: Page) => page.evaluate(async () => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.row('settings', 'parity-mode')) as { enabled?: boolean } | undefined)?.enabled ?? false; });
  const setSwitch = async (page: Page, on: boolean) => {
    await page.goto('/settings');
    const sw = page.getByRole('switch', { name: PARITY });
    await expect(sw).toBeChecked({ checked: await stored(page) }); // the page shows the stored value once it has read it
    if ((await sw.isChecked()) !== on) await (on ? sw.check() : sw.uncheck());
    await expect(sw).toBeChecked({ checked: on });
    await expect.poll(() => stored(page)).toBe(on);
  };
  const speedDrag = async (page: Page) => {
    await pick(page, 'vid'); const speed = await section(page, 'Speed & Time Remap');
    const before = (await labels(page)).length;
    await dragSlider(page, speed, 'Speed', 40, 6);
    return (await labels(page)).slice(before);
  };

  test('row 11 (T17): by default an editor opens with the improved behaviour — no entry for an equal write, one entry per slider drag', async ({ page }) => {
    await openEditor(page, t04Doc());
    expect(await options(page)).toEqual({ noOp: 'content', sliderEntries: 'drag' });
    expect(await writeTwice(page)).toEqual({ first: 1, second: 1 });
    expect(await speedDrag(page)).toEqual(['Change speed']);
  });

  test('row 11 (T17): with Reference behaviour on, a project opened afterwards commits an entry for an equal write (T03 noOp "reference") and one per slider step (T04)', async ({ page }) => {
    await setSwitch(page, true);
    await openEditor(page, t04Doc());
    expect(await options(page)).toEqual({ noOp: 'reference', sliderEntries: 'step' });
    expect(await writeTwice(page)).toEqual({ first: 1, second: 2 });
    const drag = await speedDrag(page);
    expect(drag.length).toBeGreaterThan(1); expect(new Set(drag)).toEqual(new Set(['Change speed']));
  });

  test('row 11 (T17): the switch applies to every project opened after it', async ({ page }) => {
    await setSwitch(page, true);
    await openEditor(page, t04Doc(), 'First'); expect((await options(page)).noOp).toBe('reference');
    await openEditor(page, t04Doc(), 'Second'); expect((await options(page)).noOp).toBe('reference');
  });

  test('row 11 (T17): turning the switch off returns the next project to the default', async ({ page }) => {
    await setSwitch(page, true);
    await setSwitch(page, false);
    await openEditor(page, t04Doc(), 'Third');
    expect(await options(page)).toEqual({ noOp: 'content', sliderEntries: 'drag' });
    expect(await writeTwice(page)).toEqual({ first: 1, second: 1 });
  });
});

test.describe('row 11 · T01 and T02 Help destinations', () => {
  const noWindowOpen = (page: Page) => page.addInitScript(() => { (window as unknown as { __opened: unknown[] }).__opened = []; window.open = (...a: unknown[]) => { (window as unknown as { __opened: unknown[] }).__opened.push(a); return null; }; });
  const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened);
  const guides = [['Getting-started guide', '/help/getting-started', 'Getting started'], ['Agent-setup guide', '/help/agent-setup', 'Connect an agent']] as const;

  test('row 11 (T01): on the home page the ? menu lists the three destinations; the guides open their Help pages with text, Community says there is no space yet and opens nothing', async ({ page }) => {
    await noWindowOpen(page);
    for (const [label, path, heading] of guides) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Help & Resources' }).click();
      await expect(page.getByRole('menuitem')).toHaveText(['Getting-started guide', 'Agent-setup guide', 'Community']);
      await page.getByRole('menuitem', { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      expect((await page.locator('article').innerText()).length, `${label} has text`).toBeGreaterThan(80);
      await expect(page.getByText(/not yet implemented|No destination/i)).toHaveCount(0);
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Help & Resources' }).click();
    await page.getByRole('menuitem', { name: 'Community' }).click();
    await expect(notices(page)).toContainText('No community space has been set up yet.');
    await expect(page).toHaveURL(/\/$/);
    expect(await opened(page), 'no URL was guessed and opened').toEqual([]);
  });

  test('row 11 (T02): in the editor the Help menu does the same, and the project is untouched', async ({ page }) => {
    await noWindowOpen(page);
    const id = await openEditor(page, t04Doc());
    const stored = () => page.evaluate(async id => { const p = '/src/store/database.ts'; return JSON.stringify((await (await import(p)).projectStore.read(id)).document); }, id);
    const before = await stored();
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Getting-started guide', 'Agent-setup guide', 'Community', 'Keyboard shortcuts']);
    await page.getByRole('menuitem', { name: 'Community' }).click();
    await expect(notices(page)).toContainText('No community space has been set up yet.');
    await expect(page).toHaveURL(new RegExp(`/project/${id}$`));
    expect(await opened(page)).toEqual([]);
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Agent-setup guide' }).click();
    await expect(page).toHaveURL(/\/help\/agent-setup$/);
    await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('status')).toHaveText('Saved locally');
    expect(await stored()).toBe(before);
  });
});

test.describe('row 11 · T02 cloud-backup popover', () => {
  const stubPicker = (page: Page, folder: string) => page.addInitScript(name => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  }, folder);
  const names = (page: Page, folder: string) => page.evaluate(async folder => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true }); const out: string[] = []; for await (const [n] of (dir as unknown as { entries(): AsyncIterable<[string]> }).entries()) out.push(n); return out; }, folder);

  test('row 11 (T02): the popover\'s Auto switch turns backup on through the folder picker, copies the project\'s asset, shows it "Backed up", and off returns to "Local only"', async ({ page }) => {
    await stubPicker(page, 't21-pop');
    const id = await createProject(page, t04Doc(), 'T21 popover');
    const asset = await addAsset(page, id, 'pop.png');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await page.getByRole('button', { name: 'Cloud backup: local only' }).click();
    const pop = page.getByRole('dialog', { name: 'Cloud backup' });
    await expect(pop.getByRole('listitem')).toContainText('Local only');
    await pop.getByRole('switch', { name: 'Auto backup' }).click();
    await expect(page.getByRole('button', { name: 'Backup: on' })).toBeVisible();
    await expect(pop).toContainText('copied to the folder “t21-pop”');
    await expect(pop.getByRole('listitem')).toContainText('Backed up');
    await expect.poll(() => names(page, 't21-pop')).toEqual([`${asset}-pop.png`]);
    await pop.getByRole('switch', { name: 'Auto backup' }).click();
    await expect(page.getByRole('button', { name: 'Cloud backup: local only' })).toBeVisible();
    await expect(pop.getByRole('listitem')).toContainText('Local only');
  });

  test('row 11 (T02): "Set up in Settings →" opens Settings at Storage, where the same switch is; without a folder picker the switch is disabled', async ({ page }) => {
    await openEditor(page, t04Doc(), 'T21 popover link');
    await page.getByRole('button', { name: 'Cloud backup: local only' }).click();
    await page.getByRole('dialog', { name: 'Cloud backup' }).getByRole('link', { name: 'Set up in Settings →' }).click();
    await expect(page).toHaveURL(/\/settings#storage$/);
    await expect(page.getByRole('switch', { name: 'Auto backup' })).toBeVisible();
    await page.addInitScript(() => { delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker; });
    await page.goBack();
    await page.reload();
    await page.getByRole('button', { name: 'Cloud backup: local only' }).click();
    await expect(page.getByRole('dialog', { name: 'Cloud backup' }).getByRole('switch', { name: 'Auto backup' })).toBeDisabled();
  });
});

test.describe('row 11 · T14 stock keys and folders', () => {
  const seen: { url: string; authorization?: string }[] = [];
  test.beforeEach(async ({ page }) => {
    seen.length = 0;
    await page.route('https://api.pexels.com/**', route => {
      seen.push({ url: route.request().url(), authorization: route.request().headers()['authorization'] });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ photos: [], next_page: null }) });
    });
    // the hosted API is answered here: the guard must not count it as a leak
    leaks.set(page, []);
    page.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.hostname !== 'api.pexels.com' && !/^(data|blob):/.test(r.url())) leaks.get(page)!.push(r.url()); });
  });

  test('row 11 (T14): a key saved in Settings is the one the Photos tab sends (and the tab searches); Remove in Settings returns the tab to "Add a free key" with no request', async ({ page }) => {
    await page.goto('/settings');
    const row = page.locator('section[aria-labelledby="ai-services"] li').filter({ has: page.getByLabel('Pexels API key') });
    await row.getByLabel('Pexels API key').fill('px-row11-key'); await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByLabel('Pexels API key')).toHaveAttribute('placeholder', 'Key saved');
    await openEditor(page, t04Doc(), 'T21 stock key');
    await page.getByRole('tab', { name: 'Photos', exact: true }).click();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    expect(seen.every(s => s.authorization === 'px-row11-key'), 'the saved key is what is sent').toBe(true);
    await expect(page.getByRole('group', { name: 'Stock keys' })).toHaveCount(0);
    await page.goto('/settings');
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row.getByLabel('Pexels API key')).toHaveAttribute('placeholder', 'API key');
    seen.length = 0;
    await openEditor(page, t04Doc(), 'T21 stock key removed');
    await page.getByRole('tab', { name: 'Photos', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Stock keys' })).toContainText('Add a free key');
    await page.waitForTimeout(500);
    expect(seen).toEqual([]);
  });

  test('row 11 (T14): a key entered in the stock panel shows in Settings as saved, and the panel\'s own "Manage stock keys" and Settings agree after a reload', async ({ page }) => {
    await openEditor(page, t04Doc(), 'T21 stock panel key');
    await page.getByRole('tab', { name: 'Photos', exact: true }).click();
    const group = page.getByRole('group', { name: 'Stock keys' });
    await group.getByLabel('Pexels API key').fill('px-from-panel'); await group.getByRole('button', { name: 'Save Pexels key' }).click();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    await page.goto('/settings');
    await expect(page.locator('section[aria-labelledby="ai-services"] li').filter({ has: page.getByLabel('Pexels API key') }).getByLabel('Pexels API key')).toHaveAttribute('placeholder', 'Key saved');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie)).not.toContain('px-from-panel');
  });

  test('row 11 (T14): the folder-connect entry in Settings (Add folder) is the one the agent import uses — a file in the connected folder imports into a project', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('t21-import', { create: true }); });
    await page.goto('/settings');
    await page.getByRole('button', { name: '＋ Add folder' }).click();
    await expect(page.getByRole('list', { name: 'Allowed directories' })).toContainText('t21-import');
    const id = await createProject(page, t04Doc(), 'T21 folder import');
    const result = await page.evaluate(async id => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('t21-import');
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const w = await (await dir.getFileHandle('picture.png', { create: true })).createWritable(); await w.write(png); await w.close();
      const p = '/src/media/folders.ts', s = '/src/store/database.ts', { listAllowedDir, importFromAllowedDir } = await import(p), { projectStore } = await import(s);
      const listed = await listAllowedDir(projectStore, 't21-import'), imported = await importFromAllowedDir(projectStore, id, ['t21-import/picture.png']);
      return { listed: (listed as { entries?: { name: string }[] }).entries?.map(e => e.name), imported, linked: (await projectStore.projectAssets(id)).length };
    }, id);
    expect(result.listed).toEqual(['picture.png']);
    expect(result.imported).toMatchObject({ success: true, imported: [expect.any(String)] });
    expect(result.linked, 'the imported file is now an asset of the project').toBe(1);
  });
});

test.describe('row 11 · T08 repair (b) through setRepairModel', () => {
  let server: Server, origin = '';
  const seen: { path: string; auth?: string; body: any }[] = [];
  test.beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*'); res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        const text = Buffer.concat(chunks).toString('utf8');
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'repair-mock', choices: [{ message: { content: '```jsx\nexport default function Fixed() { return null; }\n```' } }], usage: { prompt_tokens: 40, completion_tokens: 9 } }));
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(async () => { await new Promise(r => server.close(r)); });
  const model = (page: Page) => page.evaluate(async () => {
    const m = '/src/mg/repair.ts', { useRepairModel } = await import(m), repair = useRepairModel.getState().model;
    return repair ? await repair({ code: 'export default function Broken() { return <div>; }', error: 'Unexpected token', itemWidth: 640, itemHeight: 360 }) : null;
  });

  test('row 11 (T08): without a model the repair seam is empty; a chosen model becomes it (the job’s own model over the default), sends the broken code and error with the key, survives a reload, and choosing none empties it again', async ({ page }) => {
    seen.length = 0;
    await page.goto('/settings');
    expect(await model(page), 'no model, no repair').toBeNull();
    await page.getByRole('button', { name: '＋ Add connection' }).click();
    const form = page.getByRole('form', { name: 'Add a model connection' });
    await form.getByLabel('Name').fill('Repair server'); await form.getByLabel('Base URL').fill(`${origin}/v1`); await form.getByLabel('API key').fill('sk-row11-repair');
    await form.getByRole('button', { name: 'Add connection' }).click();
    await expect(page.locator('li[data-connection="Repair server"]')).toBeVisible();
    expect(await model(page), 'a connection alone is not a chosen model').toBeNull();
    await page.getByRole('combobox', { name: 'Default model connection' }).selectOption({ label: 'Repair server' });
    await page.getByRole('textbox', { name: 'Default model model' }).fill('default-model');
    const call = () => seen[seen.length - 1];
    await expect.poll(async () => { await model(page); return call()?.body.model; }, { message: 'the default model is the one called' }).toBe('default-model');
    expect(call().path).toBe('/v1/chat/completions'); expect(call().auth).toBe('Bearer sk-row11-repair'); expect(call().body.model).toBe('default-model');
    const sent = JSON.stringify(call().body.messages);
    expect(sent).toContain('Unexpected token'); expect(sent).toContain('Broken');
    expect(await model(page)).toEqual({ code: expect.stringContaining('Fixed') });
    await page.getByText('Use another model for a job').click();
    await page.getByRole('combobox', { name: 'Motion-graphic repair connection' }).selectOption({ label: 'Repair server' });
    await page.getByRole('textbox', { name: 'Motion-graphic repair model' }).fill('repair-model');
    await expect.poll(async () => { await model(page); return call().body.model; }, { message: 'the job’s own model is the one called' }).toBe('repair-model');
    await page.reload();
    await expect.poll(async () => (await model(page)) !== null && call().body.model, { message: 'the repair model is connected again at start-up' }).toBe('repair-model');
    await page.getByText('Use another model for a job').click();
    await page.getByRole('combobox', { name: 'Motion-graphic repair connection' }).selectOption({ label: 'Default model' });
    await page.getByRole('combobox', { name: 'Default model connection' }).selectOption({ label: 'None' });
    await expect.poll(() => model(page), { timeout: 10_000 }).toBeNull();
  });
});

test.describe('row 11 · T19a model storage line', () => {
  const lines = (page: Page) => page.locator('ul[aria-label="Local models"] li').evaluateAll(els => els.map(e => ({ capability: e.getAttribute('data-capability'), text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim() })));
  const estimate = (page: Page, usage: number, quota: number) => page.addInitScript(([u, q]) => { navigator.storage.estimate = async () => ({ usage: u, quota: q }); }, [usage, quota]);

  test('row 11 (T19a): each local capability says Ready or Not installed; a missing one gives its size and this browser\'s free space, "not enough" when the quota is short and not otherwise', async ({ page }) => {
    await estimate(page, 50 * 2 ** 20, 250 * 2 ** 20);
    await page.goto('/settings');
    await expect(page.locator('ul[aria-label="Local models"] li')).toHaveCount(4);
    await expect.poll(async () => (await lines(page)).every(l => !l.text.includes('Checking'))).toBe(true);
    const short = await lines(page);
    expect(short.map(l => l.capability)).toEqual(['transcription', 'analysis', 'embeddings', 'beats']);
    for (const l of short) {
      expect(l.text, l.capability!).toContain('Not installed');
      expect(l.text, l.capability!).toMatch(/About [\d.]+ (MB|GB) on disk/);
      expect(l.text, l.capability!).toContain('This browser has 200.0 MB free');
    }
    const sized = (c: string) => { const m = /About ([\d.]+) (MB|GB)/.exec(short.find(l => l.capability === c)!.text)!; return Number(m[1]) * (m[2] === 'GB' ? 1024 : 1); };
    expect(sized('transcription'), 'the speech models are the largest download').toBeGreaterThan(sized('embeddings'));
    expect(sized('transcription')).toBeGreaterThan(200); // over the 200 MB free: not enough
    expect(short.find(l => l.capability === 'transcription')!.text).toContain('not enough');
    expect(short.find(l => l.capability === 'embeddings')!.text, 'a small model fits in 200 MB').not.toContain('not enough');
  });

  test('row 11 (T19a): with room to spare nothing says "not enough"; a capability whose model files are served reads Ready and gives no size', async ({ page }) => {
    await estimate(page, 0, 50 * 2 ** 30);
    await page.route(url => /\/config\.json$|beat_this_fold0\.onnx$/.test(url.pathname), route => route.fulfill({ status: 200, contentType: route.request().method() === 'HEAD' ? 'application/octet-stream' : 'application/json', body: '{}' }));
    await page.goto('/settings');
    await expect(page.locator('ul[aria-label="Local models"] li')).toHaveCount(4);
    await expect.poll(async () => (await lines(page)).every(l => !l.text.includes('Checking'))).toBe(true);
    const all = await lines(page);
    expect(all.map(l => l.text).join(' ')).not.toContain('not enough');
    const ready = all.filter(l => l.text.includes('Ready'));
    for (const l of ready) expect(l.text, l.capability!).not.toMatch(/on disk/);
    expect(ready.length, 'served model files make capabilities Ready').toBeGreaterThan(0);
  });
});
