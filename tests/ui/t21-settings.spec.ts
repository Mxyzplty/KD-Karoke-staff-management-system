// SPDX-License-Identifier: AGPL-3.0-only
// T21 Settings page in Chromium: the §39 section order, the profile name surviving a reload, Run setup again, and the Delete local data
// confirmation. Nothing here leaves localhost.
import { test, expect, type Page } from '@playwright/test';
import { guard, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

test('/settings shows the six sections in order', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.locator('.settings > section > h2')).toHaveText(['Profile', 'Local usage', 'AI and services', 'Storage', 'External Agent (MCP)', 'Danger Zone']);
  await expect(page.getByTestId('local-usage')).toBeVisible();
  await expect(page.getByText('Plan: free and open source (AGPL-3.0).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete local data' })).toBeVisible();
});

test('Local usage reports storage, projects, assets and exports without limiting anything', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('usage-storage')).toContainText(/MB|GB/);
  await expect(page.getByTestId('usage-projects')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('usage-assets')).toContainText(/^\d+ \(/);
  await expect(page.getByTestId('usage-exports')).toHaveText('0');
  await expect(page.getByTestId('usage-ai')).toHaveText('No provider connected');
});

test('the profile name is saved on blur and is still there after a reload', async ({ page }) => {
  await page.goto('/settings');
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toHaveValue('');
  await name.fill('  Ada Lovelace ');
  await name.blur();
  await expect.poll(() => page.evaluate(async () => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.row('settings', 'profile')) as { name: string } | undefined)?.name; })).toBe('Ada Lovelace');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Ada Lovelace');
  await expect(page.locator('.avatar')).toHaveText('A');
});

test('Run setup again resets onboarding and opens /onboarding at the first question', async ({ page }) => {
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('t21-seeded')) { localStorage.setItem('cutframe:onboarding:v1', JSON.stringify({ phase: 'ready', step: 3, answers: {}, other: {}, completed: true })); sessionStorage.setItem('t21-seeded', '1'); } } catch { /* storage unavailable */ } });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: 'Who are you?' })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutframe:onboarding:v1')!))).toMatchObject({ phase: 'about-you', step: 0, completed: false });
});

test('Delete local data asks first, and Cancel leaves everything in place', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Delete local data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete local data' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This permanently removes your projects and media.');
  await expect(dialog.getByRole('button', { name: 'Delete everything' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings$/);
});

test('the External Agent card lists the helper command and one tab per client guide', async ({ page }) => {
  await page.goto('/settings');
  const card = page.locator('#external-agent');
  await expect(card).toContainText('npx cutframe-connect');
  const tabs = card.getByRole('tablist', { name: 'Client' }).getByRole('tab');
  expect(await tabs.count()).toBeGreaterThanOrEqual(3);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByText('No active agent connections')).toBeVisible();
});
