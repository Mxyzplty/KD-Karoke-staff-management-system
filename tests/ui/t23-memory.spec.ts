// SPDX-License-Identifier: AGPL-3.0-only
// T23 Settings > Agent memory in Chromium: the save switch (off by default, kept over a reload), the memory files listed by
// path with size and date, view, edit and save, delete, Clear all with its confirm, the 200,000-character limit, and T21's
// Delete local data wiping both rows. Files are seeded straight into the IndexedDB `settings` rows. Nothing leaves localhost.
import { test, expect, type Page } from '@playwright/test';
import { guard, notices, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

type Seed = { path: string; text: string; bytes: number; updatedAt: string };
const AT = '2026-11-14T09:30:00.000Z';
const BIG = 'é'.repeat(150_000); // 300,000 UTF-8 bytes, shown as 293.0 KB
const SEED: Seed[] = [
  { path: 'projects/next.md', text: 'Next: the reel for clip 2.', bytes: 26, updatedAt: '2026-11-13T08:00:00.000Z' },
  { path: 'overview.md', text: '# Memory\n- likes bold captions', bytes: 30, updatedAt: AT },
  { path: 'brand.md', text: BIG, bytes: 300_000, updatedAt: '2026-11-12T20:15:00.000Z' },
];

const section = (page: Page) => page.locator('#agent-memory');
const toggle = (page: Page) => section(page).getByRole('switch', { name: 'Let agents save memory' });
const items = (page: Page) => section(page).getByRole('list', { name: 'Memory files' }).getByRole('listitem');
/** Reads one `settings` row through the app's own store. */
const row = (page: Page, id: string) => page.evaluate(async key => { const s = '/src/store/database.ts'; return (await import(s)).projectStore.row('settings', key); }, id) as Promise<any>;
const stored = async (page: Page) => ((await row(page, 'memory_files'))?.files ?? []) as Seed[];
/** Writes the files row (in the given order, unsorted) and reloads so the section reads it. */
async function seed(page: Page, files: Seed[]) {
  await page.goto('/settings');
  await page.evaluate(async list => {
    const s = '/src/store/database.ts', { projectStore } = await import(s);
    await projectStore.putRow('settings', { id: 'memory_files', files: list.map(f => ({ ...f, version: 1, sha256: '0'.repeat(64) })) });
  }, files);
  await page.reload();
  await expect(items(page)).toHaveCount(files.length);
}

test('the switch is off by default, survives a reload, and can be turned back off', async ({ page }) => {
  await page.goto('/settings');
  await expect(section(page).getByRole('heading', { name: 'Agent memory' })).toBeVisible();
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  expect(await row(page, 'memory_enabled')).toBeUndefined();
  await expect(section(page).getByText('No memory saved')).toBeVisible();
  await expect(section(page).getByRole('button', { name: 'Clear all' })).toHaveCount(0);

  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await expect.poll(() => row(page, 'memory_enabled')).toEqual({ id: 'memory_enabled', enabled: true });
  await page.reload();
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).toBeChecked();

  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect.poll(() => row(page, 'memory_enabled')).toEqual({ id: 'memory_enabled', enabled: false });
  await page.reload();
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
});

test('files seeded in storage are listed in path order, each with its size and date', async ({ page }) => {
  await seed(page, SEED);
  expect(await items(page).evaluateAll(li => li.map(e => e.getAttribute('data-memory')))).toEqual(['brand.md', 'overview.md', 'projects/next.md']);
  const dates = await page.evaluate(list => list.map(at => new Date(at).toLocaleString()), SEED.map(f => f.updatedAt));
  for (const [i, f] of SEED.entries()) {
    const li = section(page).locator(`li[data-memory="${f.path}"]`);
    await expect(li).toContainText(f.path);
    await expect(li).toContainText(`updated ${dates[i]}`);
  }
  await expect(section(page).locator('li[data-memory="brand.md"]')).toContainText('293.0 KB · updated');
  await expect(section(page).locator('li[data-memory="overview.md"]')).toContainText('30 B · updated');
  await expect(section(page).locator('li[data-memory="projects/next.md"]')).toContainText('26 B · updated');
  await expect(section(page).getByRole('button', { name: 'Clear all' })).toBeVisible();
  await expect(section(page).getByText('No memory saved')).toHaveCount(0);
});

test('View opens the editor, Save keeps the new text over a reload, and Close collapses it', async ({ page }) => {
  await seed(page, SEED);
  const view = section(page).getByRole('button', { name: 'View overview.md' });
  await expect(view).toHaveAttribute('aria-expanded', 'false');
  await view.click();
  await expect(view).toHaveAttribute('aria-expanded', 'true');
  const box = section(page).getByRole('textbox', { name: 'Memory file overview.md' });
  await expect(box).toHaveValue('# Memory\n- likes bold captions');

  const next = '# Memory\n- likes bold captions\n- exports at 1080x1920';
  await box.fill(next);
  await section(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await stored(page)).find(f => f.path === 'overview.md')).toMatchObject({ text: next, version: 2, bytes: next.length });

  await page.reload();
  await section(page).getByRole('button', { name: 'View overview.md' }).click();
  await expect(section(page).getByRole('textbox', { name: 'Memory file overview.md' })).toHaveValue(next);
  await section(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(section(page).getByRole('textbox', { name: 'Memory file overview.md' })).toHaveCount(0);
  await expect(section(page).getByRole('button', { name: 'View overview.md' })).toHaveAttribute('aria-expanded', 'false');
});

test('Delete removes one file and keeps the others', async ({ page }) => {
  await seed(page, SEED);
  await section(page).getByRole('button', { name: 'Delete overview.md' }).click();
  await expect(items(page)).toHaveCount(2);
  await expect(section(page).locator('li[data-memory="overview.md"]')).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).map(f => f.path).sort()).toEqual(['brand.md', 'projects/next.md']);
  await page.reload();
  await expect.poll(() => items(page).evaluateAll(li => li.map(e => e.getAttribute('data-memory')))).toEqual(['brand.md', 'projects/next.md']);
});

test('Clear all asks first: Cancel keeps the files, confirming leaves "No memory saved" and the switch as it was', async ({ page }) => {
  await seed(page, SEED);
  await toggle(page).click();
  await expect.poll(() => row(page, 'memory_enabled')).toMatchObject({ enabled: true });

  await section(page).getByRole('button', { name: 'Clear all' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear agent memory' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(items(page)).toHaveCount(3);
  expect(await stored(page)).toHaveLength(3);

  await section(page).getByRole('button', { name: 'Clear all' }).click();
  await page.getByRole('dialog', { name: 'Clear agent memory' }).getByRole('button', { name: 'Clear all memory' }).click();
  await expect(page.getByRole('dialog', { name: 'Clear agent memory' })).toHaveCount(0);
  await expect(section(page).getByText('No memory saved')).toBeVisible();
  await expect(section(page).getByRole('button', { name: 'Clear all' })).toHaveCount(0);
  expect(await stored(page)).toEqual([]);
  await page.reload();
  await expect(section(page).getByText('No memory saved')).toBeVisible();
  await expect(toggle(page)).toBeChecked();
});

test('a save over 200,000 characters shows a notice and keeps the stored text', async ({ page }) => {
  await seed(page, SEED);
  await section(page).getByRole('button', { name: 'View projects/next.md' }).click();
  await section(page).getByRole('textbox', { name: 'Memory file projects/next.md' }).fill('x'.repeat(200_001));
  await section(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notices(page)).toContainText('projects/next.md is longer than 200000 characters');
  expect((await stored(page)).find(f => f.path === 'projects/next.md')).toMatchObject({ text: 'Next: the reel for clip 2.', version: 1 });
  await expect(section(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test('a save after the stored file changed behind the editor shows a notice and keeps the newer text', async ({ page }) => {
  await seed(page, SEED);
  await section(page).getByRole('button', { name: 'View overview.md' }).click();
  const agent = '# Memory\n- the agent wrote this';
  await page.evaluate(async text => { // as an agent write would: same row, text and its bytes replaced, version + 1
    const s = '/src/store/database.ts', { projectStore } = await import(s);
    await projectStore.swapRow('settings', 'memory_files', (row: { id: string; files: { path: string; text: string; version: number; bytes: number }[] }) =>
      ({ ...row, files: row.files.map(f => f.path === 'overview.md' ? { ...f, text, bytes: new TextEncoder().encode(text).length, version: f.version + 1 } : f) }));
  }, agent);
  const box = section(page).getByRole('textbox', { name: 'Memory file overview.md' }), save = section(page).getByRole('button', { name: 'Save', exact: true });
  const CHANGED = 'This file changed after you opened it. Close it and view it again to edit the latest text.';
  const overview = async () => (await stored(page)).find(f => f.path === 'overview.md');
  await box.fill('the user edit');
  await save.click();
  await expect(notices(page)).toContainText(CHANGED);
  expect(await overview()).toMatchObject({ text: agent, version: 2 });
  // The list refreshed to the agent's file while the editor kept the user's draft.
  await expect(box).toHaveValue('the user edit');
  await expect(section(page).locator('li[data-memory="overview.md"]')).toContainText(`${new TextEncoder().encode(agent).length} B`);
  await section(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(box).toHaveCount(0);
  // Viewed again, the editor holds the latest text, and its own saves never trip the check.
  await section(page).getByRole('button', { name: 'View overview.md' }).click();
  await expect(box).toHaveValue(agent);
  const changedBefore = await notices(page).getByText(CHANGED).count();
  await box.fill('the user edit 2');
  await save.click();
  await expect.poll(overview).toMatchObject({ text: 'the user edit 2', version: 3 });
  expect(await notices(page).getByText(CHANGED).count(), 'no second CHANGED notice').toBeLessThanOrEqual(changedBefore);
  await box.fill('the user edit 3');
  await save.click();
  await expect.poll(overview).toMatchObject({ text: 'the user edit 3', version: 4 });
  expect(await notices(page).getByText(CHANGED).count(), 'no CHANGED notice on the editor\'s own writes').toBeLessThanOrEqual(changedBefore);
});

test("T21's Delete local data also wipes memory: the files and the switch", async ({ page }) => {
  await seed(page, SEED);
  await toggle(page).click();
  await expect.poll(() => row(page, 'memory_enabled')).toMatchObject({ enabled: true });

  await page.getByRole('button', { name: 'Delete local data' }).click();
  await page.getByRole('dialog', { name: 'Delete local data' }).getByRole('button', { name: 'Delete everything' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

  await page.goto('/settings');
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(section(page).getByText('No memory saved')).toBeVisible();
  expect(await row(page, 'memory_enabled')).toBeUndefined();
  expect(await row(page, 'memory_files')).toBeUndefined();
});
