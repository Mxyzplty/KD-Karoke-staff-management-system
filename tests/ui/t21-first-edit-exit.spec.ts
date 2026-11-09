// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance rows 5 and 9: leaving the demo by the browser instead of its own buttons (an in-app route change, a closed tab, a
// crash) leaves no demo behind, in the store, the Library or the Settings counts; and the editor tour neither shows over the demo
// nor spends its seen flag. No skipTour here: that flag is part of what is under test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { addAsset, createProject, guard, notices } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
test.setTimeout(180_000);
const KEY = 'cutframe:onboarding:v1', TOUR = 'cutframe:tour:editor';
const AT_PICKER = { phase: 'drive-picker', step: 3, answers: {}, other: {}, completed: false };
const PACK_FILES = (JSON.parse(readFileSync(join(process.cwd(), 'vendor', 'demo-pack', 'pack.json'), 'utf8')) as { files: unknown[] }).files.length;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const seed = (page: Page) => page.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k as string)) localStorage.setItem(k as string, JSON.stringify(v)); } catch { /* storage unavailable */ } }, [KEY, AT_PICKER]);
const built = (page: Page) => page.getByRole('button', { name: /Use the built-in assistant/ });
const intro = (page: Page) => page.getByRole('heading', { name: 'A quick look at what this can do' });
const within = (page: Page, path: string) => page.evaluate(to => { history.pushState(null, '', to); dispatchEvent(new PopStateEvent('popstate')); }, path);
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name }).click();
async function inDemo(page: Page) {
  await page.goto('/onboarding');
  await built(page).click(); await expect(intro(page)).toBeVisible();
  await page.getByRole('button', { name: 'Show me' }).click();
  await expect(page.locator('.demo-turn.assistant').first()).toContainText('Your timeline is empty', { timeout: 90_000 });
}
const rows = (page: Page) => page.evaluate(async () => {
  const s = '/src/store/database.ts', { projectStore } = await import(s), projects = await projectStore.rows('projects') as { id: string; is_demo?: boolean }[], assets = await projectStore.rows('assets') as { source?: { kind: string } }[];
  const trail = (await projectStore.rows('settings') as { id: string }[]).filter(r => /^(history|journal):/.test(r.id));
  return { projects: projects.length, demoProjects: projects.filter(r => r.is_demo).length, assets: assets.length, demoAssets: assets.filter(a => a.source?.kind === 'demo').length, trail: trail.length };
});
const NOTHING = { projects: 0, demoProjects: 0, assets: 0, demoAssets: 0, trail: 0 };
const inTheDemo = async (page: Page) => expect(await rows(page)).toMatchObject({ demoProjects: 1, demoAssets: PACK_FILES });
/** Library and Settings show no demo: the counts are the app's own, read by a route that loads them once. */
async function emptyLists(page: Page) {
  await expect(page.getByRole('heading', { name: 'No assets yet' })).toBeVisible();
  await nav(page, 'Settings');
  await expect(page.getByTestId('usage-projects')).toHaveText('0');
  await expect(page.getByTestId('usage-assets')).toHaveText('0 (0.0 MB)');
}

test('leaving the demo by an in-app route change removes it, with nothing left in the Library or the Settings counts', async ({ page }) => {
  const leaks = guard(page);
  await seed(page); await inDemo(page); await inTheDemo(page);
  await within(page, '/');
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect.poll(() => rows(page), { timeout: 20_000 }).toEqual(NOTHING);
  await nav(page, 'Library');
  await emptyLists(page);
  await expect(notices(page)).not.toContainText('no longer exists');
  expect(leaks).toEqual([]);
});

test('leaving while the setup is still running removes the demo once the setup has finished', async ({ page }) => {
  await seed(page);
  await page.goto('/onboarding');
  await built(page).click(); await expect(intro(page)).toBeVisible();
  await within(page, '/');
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect.poll(async () => (await rows(page)).demoProjects, { timeout: 90_000, intervals: [100] }).toBe(1); // the setup carries on, and makes its project
  await expect.poll(() => rows(page), { timeout: 90_000 }).toEqual(NOTHING);
});

test('a tab closed in the middle of the demo leaves nothing at the next start: Library and Settings show none', async ({ page, context }) => {
  await seed(page); await inDemo(page); await inTheDemo(page);
  await page.close();
  const next = await context.newPage();
  await next.goto('/assets');
  await expect(next.getByRole('heading', { name: 'No assets yet' })).toBeVisible();
  expect(await rows(next)).toEqual(NOTHING);
  await emptyLists(next);
});

test('a second tab opened during the demo leaves it alone; once the demo’s tab is gone the next start removes it', async ({ page, context }) => {
  await seed(page); await inDemo(page); await inTheDemo(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await inTheDemo(second);
  await page.close();
  await second.reload();
  await expect(second.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  expect(await rows(second)).toEqual(NOTHING);
});

test('a demo a crash left behind goes at start-up, before the Library reads, and the user’s own project and asset stay', async ({ page }) => {
  const mine = await createProject(page, undefined, 'Mine');
  await addAsset(page, mine, 'mine.png');
  const demo = await page.evaluate(async png => {
    const s = '/src/store/database.ts', i = '/src/media/ingest.ts', { projectStore } = await import(s), { uploadToProject } = await import(i);
    const record = await projectStore.create('First Edit, crashed'), bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    await projectStore.putRow('projects', { ...record, is_demo: true });
    const { preparing } = await uploadToProject(projectStore, record.id, [new File([bytes], 'crashed-demo.png', { type: 'image/png' })], { source: { kind: 'demo', licence: 'CC0-1.0', author: 'Test', pageUrl: 'http://localhost/' } });
    await Promise.all(preparing);
    await projectStore.putRow('settings', { id: `history:${record.id}` }); await projectStore.putRow('settings', { id: `journal:${record.id}:0` });
    return record.id as string;
  }, PNG);
  expect(await rows(page)).toMatchObject({ projects: 2, demoProjects: 1, assets: 2, demoAssets: 1 });
  await page.goto('/assets');
  await expect(page.getByText('mine.png', { exact: true })).toBeVisible();
  await expect(page.getByText('crashed-demo.png', { exact: true })).toHaveCount(0);
  expect(await rows(page)).toMatchObject({ projects: 1, demoProjects: 0, assets: 1, demoAssets: 0 });
  expect(await page.evaluate(async id => { const s = '/src/store/database.ts'; return ((await (await import(s)).projectStore.rows('settings')) as { id: string }[]).filter(r => r.id.includes(id)).length; }, demo)).toBe(0);
  await nav(page, 'Settings');
  await expect(page.getByTestId('usage-projects')).toHaveText('1');
  await expect(page.getByTestId('usage-assets')).toHaveText(/^1 \(/);
});

test('no editor tour over the demo, and its seen flag is still free for the first real project', async ({ page }) => {
  await seed(page); await inDemo(page);
  await page.waitForTimeout(6000); // the tour shows within 5 s of its anchors
  await expect(page.getByRole('dialog', { name: 'Editor tour' })).toHaveCount(0);
  expect(await page.evaluate(k => localStorage.getItem(k), TOUR)).toBeNull();
  await page.locator('.demo-top').getByRole('button', { name: 'Skip demo' }).click();
  await page.getByRole('button', { name: 'Open Cutframe' }).click();
  await expect(page).toHaveURL(/\/$/);
  const id = await createProject(page, undefined, 'First real project');
  await page.goto(`/project/${id}`);
  const tour = page.getByRole('dialog', { name: 'Editor tour' });
  await expect(tour).toBeVisible({ timeout: 15_000 });
  await expect(tour).toContainText('Your footage');
  await expect(tour).toContainText('1 of 4');
});
