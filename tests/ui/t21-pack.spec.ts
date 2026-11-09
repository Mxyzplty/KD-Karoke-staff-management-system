// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 10 (the First Edit demo pack, FX-3) in Chromium: the first-use download fetches each file once, keeps it in
// the browser's file store, and checks its SHA-256 against pack.json (bad bytes are refused and not kept); a complete cache then
// needs no network at all. The records against the files on disk are in tests/t21-pack.test.ts. Nothing leaves localhost.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { guard, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const KEY = 'cutframe:onboarding:v1', AT_PICKER = { phase: 'drive-picker', step: 3, answers: {}, other: {}, completed: false };
type Entry = { file: string; bytes: number; sha256: string };
const PACK = JSON.parse(readFileSync(join(process.cwd(), 'vendor', 'demo-pack', 'pack.json'), 'utf8')) as { files: Entry[] };
const SONG = PACK.files.find(f => f.file.includes('fever'))!;
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  leaks.set(page, guard(page)); await skipTour(page);
  await page.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k as string)) localStorage.setItem(k as string, JSON.stringify(v)); } catch { /* storage unavailable */ } }, [KEY, AT_PICKER]);
});
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

/** A download of the pack: the dev server's `?import&url` module that only names a file is not one. */
const isPack = (url: string) => /demo-pack|\.webm|\.mp3|pack\.json/.test(url) && !/[?&]import\b/.test(url);
const nameOf = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop()!).replace(/-[A-Za-z0-9_]{8}(?=\.\w+$)/, ''); // a built name carries a hash
const requests = (page: Page) => { const seen: string[] = []; page.on('request', r => { if (isPack(r.url())) seen.push(nameOf(r.url())); }); return seen; };
const cache = (page: Page) => page.evaluate(async () => {
  const out: { [name: string]: { size: number; sha256: string } } = {};
  try {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe')).getDirectoryHandle('demo-pack');
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const file = await (handle as FileSystemFileHandle).getFile(), hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      out[name] = { size: file.size, sha256: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('') };
    }
  } catch { /* no cache directory yet */ }
  return out;
});
const demoProjects = (page: Page) => page.evaluate(async () => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.rows('projects')) as { is_demo: boolean }[]).filter(r => r.is_demo).length; });
/** The demo's setup has finished: every pack file is an asset and none is still uploading or being prepared. */
const built = (page: Page, count: number) => expect.poll(() => page.evaluate(async n => { const p = '/src/store/database.ts'; const demo = ((await (await import(p)).projectStore.library()).assets as { source?: { kind: string }; processing_status: string }[]).filter(a => a.source?.kind === 'demo'); return demo.length === n && demo.every(a => !['uploading', 'processing'].includes(a.processing_status)); }, count), { timeout: 90_000 }).toBe(true);
const start = async (page: Page) => { await page.goto('/onboarding'); await page.getByRole('button', { name: /Use the built-in assistant/ }).click(); await expect(page.getByRole('heading', { name: 'A quick look at what this can do' })).toBeVisible(); };
/** Corrupts the response for `file`: `same` keeps its length (one byte flipped), else the body is cut short. */
async function corrupt(page: Page, file: string, how: 'same' | 'short') {
  const fixed = { value: false };
  await page.route(url => isPack(url.href) && nameOf(url.href) === file, async route => {
    if (fixed.value) return route.continue();
    const response = await route.fetch(), body = await response.body(), bad = Buffer.from(body);
    if (how === 'same') bad[Math.floor(bad.length / 2)] ^= 0xff;
    await route.fulfill({ response, body: how === 'same' ? bad : bad.subarray(0, bad.length - 1000) });
  });
  return () => { fixed.value = true; };
}

test.describe('row 10 · first use', () => {
  test('row 10: the first run fetches pack.json and every file, nothing else, keeps each in the file store, and every kept file has the recorded size and SHA-256', async ({ page }) => {
    test.setTimeout(180_000);
    const seen = requests(page);
    await start(page);
    await expect.poll(async () => Object.keys(await cache(page)).length, { timeout: 90_000 }).toBe(PACK.files.length + 1);
    expect([...new Set(seen)].sort()).toEqual(['pack.json', ...PACK.files.map(f => f.file)].sort());
    const kept = await cache(page);
    for (const f of PACK.files) expect(kept[f.file], f.file).toEqual({ size: f.bytes, sha256: f.sha256 });
    expect(Object.keys(kept).sort()).toEqual(['pack.json', ...PACK.files.map(f => f.file)].sort());
    await expect.poll(() => demoProjects(page), { timeout: 60_000 }).toBeGreaterThan(0);
  });

  test('row 10: the first run fetches each file once, not once per setup run', async ({ page }) => {
    test.setTimeout(180_000);
    const seen = requests(page);
    await start(page);
    await expect.poll(async () => Object.keys(await cache(page)).length, { timeout: 90_000 }).toBe(PACK.files.length + 1);
    await page.waitForTimeout(3000);
    expect([...seen].sort()).toEqual(['pack.json', ...PACK.files.map(f => f.file)].sort());
  });

  for (const how of ['same', 'short'] as const) {
    test(`row 10: a file whose bytes do not match (${how === 'same' ? 'one byte flipped, same length' : 'truncated'}) is refused: the error screen shows, the bad file is not kept, no demo project exists, and a corrected retry fetches only what is missing`, async ({ page }) => {
      test.setTimeout(240_000);
      const seen = requests(page);
      const fix = await corrupt(page, SONG.file, how);
      await page.goto('/onboarding'); await page.getByRole('button', { name: /Use the built-in assistant/ }).click();
      await expect(page.getByRole('heading', { name: 'The demo could not start' })).toBeVisible({ timeout: 90_000 });
      await expect(page.getByText('The demo pack could not be loaded.')).toBeVisible();
      const kept = await cache(page);
      expect(kept[SONG.file], 'the refused file is not kept').toBeUndefined();
      expect(await demoProjects(page), 'no demo project').toBe(0);
      const before = PACK.files.slice(0, PACK.files.findIndex(f => f.file === SONG.file)).map(f => f.file);
      for (const file of before) expect(kept[file], `${file} from before the bad one is kept`).toBeDefined();
      // the page is unchanged; the hosting is fixed; Back, then in again
      fix();
      seen.length = 0;
      await page.getByRole('button', { name: 'Back' }).click();
      await page.getByRole('button', { name: /Use the built-in assistant/ }).click();
      await expect.poll(async () => Object.keys(await cache(page)).length, { timeout: 90_000 }).toBe(PACK.files.length + 1);
      for (const file of before) expect(seen, `${file} was cached, so it is not fetched again`).not.toContain(file);
      expect(seen).toContain(SONG.file);
      const now = await cache(page);
      expect(now[SONG.file]).toEqual({ size: SONG.bytes, sha256: SONG.sha256 });
    });
  }

  test('row 10: with the whole pack kept, a second run needs no network — not the files, not pack.json — and still builds the demo project and its assets', async ({ page }) => {
    test.setTimeout(240_000);
    await start(page);
    await expect.poll(async () => Object.keys(await cache(page)).length, { timeout: 90_000 }).toBe(PACK.files.length + 1);
    await expect.poll(() => demoProjects(page), { timeout: 60_000 }).toBeGreaterThan(0);
    const blocked: string[] = [];
    await page.route(url => isPack(url.href), route => { blocked.push(route.request().url()); return route.abort(); });
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: /Use the built-in assistant/ }).click();
    await expect(page.getByRole('heading', { name: 'A quick look at what this can do' })).toBeVisible();
    await page.getByRole('button', { name: 'Show me' }).click();
    await expect(page.locator('.demo-turn.assistant').first()).toContainText('Your timeline is empty', { timeout: 90_000 });
    expect(blocked, 'nothing was asked of the network').toEqual([]);
    expect(await page.evaluate(async () => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.library()).assets as { source?: { kind: string } }[]).filter(a => a.source?.kind === 'demo').length; })).toBe(PACK.files.length);
    await expect(page.getByRole('heading', { name: 'The demo could not start' })).toHaveCount(0);
  });

  test('row 10: a kept file of the wrong size is fetched and checked again, not trusted', async ({ page }) => {
    test.setTimeout(240_000);
    await start(page);
    await built(page, PACK.files.length); // a second run while the first setup still runs would join it, not read the file store again
    await page.evaluate(async file => { // a half-written file from an interrupted run
      const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe')).getDirectoryHandle('demo-pack');
      const w = await (await dir.getFileHandle(file)).createWritable(); await w.write(new Blob(['partial'])); await w.close();
    }, SONG.file);
    const seen = requests(page);
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: /Use the built-in assistant/ }).click();
    await expect.poll(async () => (await cache(page))[SONG.file]?.size, { timeout: 90_000 }).toBe(SONG.bytes);
    expect(seen).toEqual([SONG.file]);
    expect((await cache(page))[SONG.file].sha256).toBe(SONG.sha256);
  });
});
