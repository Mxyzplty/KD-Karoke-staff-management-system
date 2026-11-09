// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 9 (First Edit, §28b), the entry and failure half: PT-FE-01 (entry gating), PT-FE-02 (browser gate) and
// PT-FE-03 (setup failures E1, E3, E4; E2 needs sync accounts, which Cutframe does not have, so it has no test). The demo run
// itself (PT-FE-05…08, 10…12) is in t21-first-edit-run.spec.ts. Nothing leaves localhost; the pack is served by the app's own server.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { guard, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const KEY = 'cutframe:onboarding:v1';
const PACK_FILES = (JSON.parse(readFileSync(join(process.cwd(), 'vendor', 'demo-pack', 'pack.json'), 'utf8')) as { files: unknown[] }).files.length;
const AT_PICKER = { phase: 'drive-picker', step: 3, answers: {}, other: {}, completed: false };
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

/** Sets the onboarding state once; a later navigation or reload keeps whatever the app has stored since. */
const seed = (page: Page, state: Record<string, unknown>) => page.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k as string)) localStorage.setItem(k as string, JSON.stringify(v)); } catch { /* storage unavailable */ } }, [KEY, state]);
const stored = (page: Page) => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null') as Record<string, any> | null, KEY);
const projects = (page: Page) => page.evaluate(async () => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.rows('projects')) as { id: string; is_demo: boolean; title: string }[]).map(r => ({ id: r.id, demo: r.is_demo, title: r.title })); });
const demos = async (page: Page) => (await projects(page)).filter(p => p.demo).map(p => p.id);
const intro = (page: Page) => page.getByRole('heading', { name: 'A quick look at what this can do' });
const built = (page: Page) => page.getByRole('button', { name: /Use the built-in assistant/ });
const cacheDirs = (page: Page) => page.evaluate(async () => { const root = await navigator.storage.getDirectory(), names: string[] = []; for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string]> }).entries()) names.push(name); return names; });
/** A download of the pack: the dev server's `?import&url` module that only names a file is not one. */
const isPack = (url: string) => /demo-pack|\.webm|\.mp3|pack\.json/.test(url) && !/[?&]import/.test(url);
const packRequests = (page: Page) => { const seen: string[] = []; page.on('request', r => { if (isPack(r.url())) seen.push(r.url()); }); return seen; };
const unlessModule = (handler: Parameters<Page['route']>[1]): Parameters<Page['route']>[1] => (route, request) => /[?&]import/.test(request.url()) ? route.continue() : handler(route, request);
/** Demo projects once setup has stopped adding them (two equal reads 1.5 s apart). */
async function settled(page: Page) {
  let last = '';
  await expect.poll(async () => { const now = JSON.stringify((await demos(page)).sort()); const same = now === last && now !== '[]'; last = now; await page.waitForTimeout(1500); return same; }, { timeout: 60_000 }).toBe(true);
  return demos(page);
}
/** The demo's setup has finished: every pack file is an asset and none is still uploading or being prepared. */
const setupDone = (page: Page) => expect.poll(() => page.evaluate(async n => { const p = '/src/store/database.ts'; const demo = ((await (await import(p)).projectStore.library()).assets as { source?: { kind: string }; processing_status: string }[]).filter(a => a.source?.kind === 'demo'); return demo.length === n && demo.every(a => !['uploading', 'processing'].includes(a.processing_status)); }, PACK_FILES), { timeout: 90_000 }).toBe(true);
/** Skipping setup finishes onboarding directly: the app is home. */
const finished = async (page: Page) => {
  await expect(page).toHaveURL(/\/$/);
  expect(await stored(page)).toMatchObject({ phase: 'ready', completed: true });
};
/** Continue with no demo reached the Ready page (findings §28b.4) as skipped: phase `ready`, not yet completed; "Open Cutframe" finishes and goes home. */
const ready = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'All set' })).toBeVisible();
  expect(await stored(page)).toMatchObject({ phase: 'ready', completed: false, skipped: true });
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('button', { name: 'Open Cutframe' }).click();
  await finished(page);
};

test.describe('PT-FE-01 · entry gating', () => {
  test('PT-FE-01: the built-in path reaches First Edit; the own-agent path never does until the user switches to the built-in assistant in the skip dialog', async ({ page }) => {
    await seed(page, AT_PICKER); await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: 'How do you want to drive the AI?' })).toBeVisible();
    await page.locator('[data-drive="own"]').click();
    await expect(page.getByRole('heading', { name: 'Install the helper' })).toBeVisible();
    expect(await stored(page)).toMatchObject({ phase: 'install', drive: 'own' });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Pair this tab' })).toBeVisible();
    expect(await stored(page)).toMatchObject({ phase: 'connect', drive: 'own' });
    await expect(intro(page)).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(await demos(page), 'the own-agent path sets no demo up').toEqual([]);
    // the switch link, then the dialog's confirm
    await page.getByRole('button', { name: 'Skip setup — use the built-in assistant' }).click();
    await page.getByRole('dialog', { name: 'Skip setup' }).getByRole('button', { name: 'Show me the demo' }).click();
    await expect(intro(page)).toBeVisible();
    expect(await stored(page)).toMatchObject({ phase: 'first-edit', drive: 'built-in', completed: false });
  });

  test('PT-FE-01: on the own-agent install step the switch link also reaches First Edit, and the dialog\'s other choice skips it', async ({ page }) => {
    await seed(page, { ...AT_PICKER, phase: 'install', drive: 'own' }); await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: 'Install the helper' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip setup — use the built-in assistant' }).click();
    await page.getByRole('dialog', { name: 'Skip setup' }).getByRole('button', { name: 'Show me the demo' }).click();
    await expect(intro(page)).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.locator('[data-drive="own"]').click();
    await page.getByRole('button', { name: 'Skip setup — use the built-in assistant' }).click();
    await page.getByRole('dialog', { name: 'Skip setup' }).getByRole('button', { name: 'Skip setup', exact: true }).click();
    await finished(page);
    await expect(intro(page)).toHaveCount(0);
  });

  test('PT-FE-01: Back returns to the drive picker, and entering again creates a new demo project', async ({ page }) => {
    test.setTimeout(120_000); // twice the real setup: the re-entry's setup runs once the first has finished
    await seed(page, AT_PICKER); await page.goto('/onboarding');
    await built(page).click(); await expect(intro(page)).toBeVisible();
    const first = await settled(page); // setup starts as the intro shows
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'How do you want to drive the AI?' })).toBeVisible();
    expect(await stored(page)).toMatchObject({ phase: 'drive-picker' });
    await built(page).click(); await expect(intro(page)).toBeVisible();
    await expect.poll(async () => { const now = await demos(page); return now.length === 1 && !first.includes(now[0]); }, { message: 'the re-entry demo project is new and the earlier one was removed', timeout: 90_000 }).toBe(true);
  });

  test('PT-FE-01: Back after the setup has finished, then entering again, creates a new demo project and removes the earlier one', async ({ page }) => {
    test.setTimeout(120_000); // twice the real setup: download, upload and prepare 14 media files, from an empty file store each time
    await seed(page, AT_PICKER); await page.goto('/onboarding');
    await page.getByRole('button', { name: /Use the built-in assistant/ }).click(); await expect(intro(page)).toBeVisible();
    await setupDone(page);
    const first = await demos(page);
    expect(first).toHaveLength(1);
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: /Use the built-in assistant/ }).click(); await expect(intro(page)).toBeVisible();
    await expect.poll(async () => { const now = await demos(page); return now.length === 1 && now[0] !== first[0]; }, { timeout: 90_000 }).toBe(true);
    await setupDone(page);
    expect(await demos(page)).toHaveLength(1);
  });

  test('PT-FE-01: entering the demo leaves exactly one demo project, not one per setup run', async ({ page }) => {
    await seed(page, AT_PICKER); await page.goto('/onboarding');
    await built(page).click(); await expect(intro(page)).toBeVisible();
    expect(await settled(page)).toHaveLength(1);
  });

  test('PT-FE-01: the setup probes and thumbnails the clips but makes no proxies, which would go with the demo', async ({ page }) => {
    await seed(page, AT_PICKER); await page.goto('/onboarding');
    await built(page).click(); await expect(intro(page)).toBeVisible();
    await setupDone(page);
    const videos = await page.evaluate(async () => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.rows('assets')) as { type: string; proxy?: unknown; processing_status: string; processing_steps: Record<string, string>; last_error_message?: string | null }[]).filter(a => a.type === 'video').map(a => [a.proxy ?? null, a.processing_status, a.processing_steps.probe, a.processing_steps.thumbnails, a.last_error_message ?? null]); });
    expect(videos.length).toBeGreaterThan(0);
    for (const video of videos) expect(video).toEqual([null, 'ready', 'complete', 'complete', null]);
  });

  test('PT-FE-01: after onboarding is complete the demo is unreachable, even from a stored first-edit phase', async ({ page }) => {
    await seed(page, { ...AT_PICKER, phase: 'first-edit', drive: 'built-in', completed: true }); await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/$/);
    await expect(intro(page)).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(await projects(page)).toEqual([]);
    await page.goto('/onboarding'); await expect(page).toHaveURL(/\/$/);
    expect(await cacheDirs(page)).not.toContain('demo-pack'); // nothing was fetched
  });
});

test.describe('PT-FE-02 · browser gate', () => {
  async function gated(page: Page) {
    const seen = packRequests(page);
    await seed(page, AT_PICKER); await page.goto('/onboarding');
    await built(page).click();
    await expect(page.getByRole('heading', { name: 'The demo needs a desktop browser' })).toBeVisible();
    await page.waitForTimeout(1500); // setup, had it started, would have asked for the pack by now
    expect(seen, 'zero setup requests').toEqual([]);
    expect(await projects(page), 'no project').toEqual([]);
    expect(await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); try { await (await root.getDirectoryHandle('cutframe')).getDirectoryHandle('demo-pack'); return true; } catch { return false; } }), 'no pack cache').toBe(false);
    await expect(intro(page)).toHaveCount(0);
  }
  const variants: [string, (page: Page) => Promise<unknown>][] = [
    ['without WebCodecs', page => page.addInitScript(() => { Reflect.deleteProperty(window, 'VideoDecoder'); })],
    ['on a phone', page => page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => ({ mobile: true, platform: 'Android', brands: [] }) }); })],
  ];
  for (const [name, simulate] of variants) {
    test(`PT-FE-02: an unsupported browser (${name}) shows the requirement screen with no setup request and no project; Continue reaches Ready`, async ({ page }) => {
      await simulate(page); await gated(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await ready(page);
      expect(await projects(page)).toEqual([]);
    });
    test(`PT-FE-02: the requirement screen (${name}) has Back to the drive picker`, async ({ page }) => {
      await simulate(page); await gated(page);
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByRole('heading', { name: 'How do you want to drive the AI?' })).toBeVisible();
      expect(await stored(page)).toMatchObject({ phase: 'drive-picker', completed: false });
    });
  }
});

test.describe('PT-FE-03 · setup failures', () => {
  const fail = (code: string, message: string, inject: (page: Page) => Promise<unknown>) => test(`PT-FE-03: ${code} gives the error screen with Back and Continue; Continue reaches Ready`, async ({ page }) => {
    await seed(page, AT_PICKER); await page.goto('/onboarding');
    await inject(page);
    await built(page).click();
    await expect(page.getByRole('heading', { name: 'The demo could not start' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show me' })).toHaveCount(0);
    // Back first: the picker, and the failure does not stick to the next try
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'How do you want to drive the AI?' })).toBeVisible();
    await built(page).click();
    await expect(page.getByRole('heading', { name: 'The demo could not start' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await ready(page);
  });
  fail('E1 (missing pack)', 'The demo pack could not be loaded.', page => page.route(/pack\.json/, unlessModule(r => r.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }))));
  fail('E1 (a pack file that is missing)', 'The demo pack could not be loaded.', page => page.route(/fever-temple\.mp3/, unlessModule(r => r.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }))));
  fail('E3 (project creation failure)', 'The demo project could not be created.', page => page.evaluate(async () => {
    const p = '/src/store/database.ts', { projectStore } = await import(p);
    projectStore.create = () => Promise.reject(new Error('disk full'));
  }));
  fail('E4 (a thrown error)', 'The demo could not be set up.', page => page.evaluate(async () => {
    const p = '/src/store/database.ts', { projectStore } = await import(p);
    projectStore.rows = () => { throw new Error('boom'); };
  }));
});
