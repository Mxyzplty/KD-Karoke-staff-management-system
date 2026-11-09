// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 1, Delete local data after a working session: the delete finishes in the same tab after a real export has
// opened the font store, a second Cutframe tab lets go by itself, and the "another tab" message shows only for a connection that
// really will not close. The oracle is a first start in a new profile: afterwards this browser holds exactly what that one holds.
// No skipTour: its seen flag would be a key the delete has to remove and the init script puts back.
import { test, expect, type Browser, type Page } from '@playwright/test';
import { addAsset, createProject, notices } from './t02-support';
import { completed, runExport, setup } from './t16a-support';

test.use({ viewport: { width: 1400, height: 900 } });
test.setTimeout(120_000);
const SIZE = { width: 320, height: 180 };
const p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
const tracks = [{ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 }];
const TEXT_DOC = {
  schemaVersion: 4, rev: 0, groups: {}, duration: 200, fps: 30, size: SIZE, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })),
  items: [{
    id: 'txt', type: 'text', trackId: 'o1', display: { from: 0, to: 200 }, trim: { from: 0, to: 200 }, playbackRate: 1, masks: [], effects: [],
    details: { text: 'Hi', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' },
    properties: { opacity: p(1), scale: p(1), rotation: p(0), fontSize: p(90), fontWeight: p(700), color: p('#ffffff'), backgroundColor: p('transparent'), textAlign: p('center'), wordWrap: p('break-word'), borderWidth: p(0), borderColor: p('#000000'), positionX: p(40), positionY: p(30), width: p(240), height: p(120) },
  }],
};

const files = (page: Page) => page.evaluate(async () => {
  const found: string[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, at: string) => {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${at}${name}/`); else found.push(`${at}${name}`);
    }
  };
  await walk(await navigator.storage.getDirectory(), '');
  return found.sort();
});
/** Every Cutframe database with its row counts, every OPFS file, the localStorage keys and the cache names. */
const snapshot = async (page: Page) => ({
  files: await files(page),
  ...await page.evaluate(async () => {
    const databases: Record<string, Record<string, number>> = {};
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith('cutframe')) continue;
      const db = await new Promise<IDBDatabase>((ok, fail) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); }), rows: Record<string, number> = {};
      for (const store of db.objectStoreNames) rows[store] = await new Promise<number>((ok, fail) => { const r = db.transaction(store).objectStore(store).count(); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
      db.close(); databases[name] = rows;
    }
    return { databases, keys: Object.keys(localStorage).filter(k => k.startsWith('cutframe')).sort(), caches: await caches.keys() };
  }),
});
async function firstStart(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL }), page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const state = await snapshot(page);
  await context.close();
  return state;
}
const within = (page: Page, path: string) => page.evaluate(to => { history.pushState(null, '', to); dispatchEvent(new PopStateEvent('popstate')); }, path);
async function deleteAll(page: Page) {
  await page.getByRole('button', { name: 'Delete local data' }).click();
  await page.getByRole('dialog', { name: 'Delete local data' }).getByRole('button', { name: 'Delete everything' }).click();
}
async function gone(page: Page, browser: Browser, baseURL: string) {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(notices(page)).not.toContainText('Another Cutframe tab');
  const fresh = await firstStart(browser, baseURL);
  await expect.poll(() => snapshot(page), { timeout: 10_000 }).toEqual(fresh);
}

test('after a real export the delete finishes in the same tab: stores, OPFS media and proxies, and localStorage are as on a first start', async ({ page, browser, baseURL }) => {
  await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ status: 404, contentType: 'text/plain', body: 'blocked' }));
  const { id } = await setup(page, TEXT_DOC, {}, 'Doomed export');
  completed(await runExport(page, id, {}, undefined, false));
  await addAsset(page, id, 'doomed.png');
  await page.evaluate(async () => {
    const s = '/src/store/database.ts', k = '/src/settings/secrets.ts', { projectStore } = await import(s), secrets = await import(k);
    await secrets.putSecret('model:doomed', 'sk-t21-doomed-key', 'https://api.example.com');
    await projectStore.putRow('settings', { id: 'profile', name: 'Doomed' });
    localStorage.setItem('cutframe:agent-link:v1', '{"port":47820,"auto":false}');
    const app = await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe', { create: true }), proxies = await app.getDirectoryHandle('proxies', { create: true });
    const writer = await (await proxies.getFileHandle('doomed-proxy', { create: true })).createWritable(); await writer.write(new Uint8Array(16)); await writer.close();
  });
  const before = await snapshot(page);
  expect(Object.keys(before.databases), 'the session really opened these').toEqual(expect.arrayContaining(['cutframe', 'cutframe-fonts', 'cutframe-secrets']));
  expect(before.databases.cutframe).toMatchObject({ projects: 1, assets: 1 });
  expect(before.files.filter(f => f.startsWith('cutframe/media/'))).toHaveLength(1);
  expect(before.files).toContain('cutframe/proxies/doomed-proxy');
  expect(before.keys).toContain('cutframe:agent-link:v1');
  await within(page, '/settings');
  await deleteAll(page);
  await gone(page, browser, baseURL!);
});

test('a second Cutframe tab holding the font store lets go by itself: no message, and the delete finishes', async ({ page, context, browser, baseURL }) => {
  await page.goto('/settings');
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate(async () => { const f = '/src/text/font-registry.ts'; await (await import(f)).loadUserFonts(); });
  expect(await other.evaluate(async () => (await indexedDB.databases()).map(d => d.name))).toContain('cutframe-fonts');
  await deleteAll(page);
  await gone(page, browser, baseURL!);
});

test('a connection that will not close gets the message, everything else is gone by then, and the delete finishes once it closes', async ({ page, context, browser, baseURL }) => {
  const id = await createProject(page, undefined, 'Doomed');
  await addAsset(page, id, 'doomed.png');
  await page.goto('/settings');
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate(() => new Promise<void>((ok, fail) => { const r = indexedDB.open('cutframe'); r.onsuccess = () => { (window as unknown as { held: IDBDatabase }).held = r.result; ok(); }; r.onerror = () => fail(r.error); }));
  await deleteAll(page);
  await expect(notices(page)).toContainText('Another Cutframe tab is still open', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/settings$/);
  expect(await files(page), 'OPFS is not held back by the other tab').toEqual([]);
  await other.close();
  await page.getByRole('dialog', { name: 'Delete local data' }).getByRole('button', { name: 'Delete everything' }).click(); // the dialog stays open on the message
  await gone(page, browser, baseURL!);
});
