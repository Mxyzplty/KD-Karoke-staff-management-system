// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 2 in Chromium: the Local usage panel of §39. "No provider connected" without a provider, and no control
// anywhere in the panel changes a limit. The +200 MB ±1 MB test is in t21-usage-opfs.spec.ts.
import { test, expect, type Page } from '@playwright/test';
import { guard, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const MB = 2 ** 20;
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

const used = (page: Page) => page.getByTestId('usage-storage').getAttribute('data-used').then(Number);
/** One provider row in the settings store, as Settings → AI and services writes it. */
const connect = (page: Page, usage?: unknown) => page.evaluate(async usage => {
  const p = '/src/store/database.ts'; const { projectStore } = await import(p);
  await projectStore.putRow('settings', { id: 'providers', connections: [{ id: 'c1', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' }], fallback: { connection: 'c1', model: 'gpt-test' }, jobs: {}, speech: 'local' });
  if (usage) localStorage.setItem('cutframe:usage:v1', JSON.stringify(usage));
}, usage);

test('row 2: without a provider the AI row says "No provider connected"; with one it names the model, the biller and the counted tokens', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('usage-ai')).toHaveText('No provider connected');
  await connect(page, { models: { c1: { requests: 3, input: 1200, output: 300, lastTurn: 1500 } }, requests: {}, exports: 0 });
  await page.reload();
  await expect(page.getByTestId('usage-ai')).toHaveText('OpenAI · gpt-test · 3 requests, 1,200 tokens in, 300 out, billed by OpenAI');
  // removing the connection puts the empty state back
  await page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); await projectStore.putRow('settings', { id: 'providers', connections: [], fallback: null, jobs: {}, speech: 'local' }); });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('usage-ai')).toHaveText('No provider connected');
});

test('row 2: the panel reports projects, library assets and exports, the free-plan line and the Costs link', async ({ page }) => {
  await page.goto('/settings');
  const panel = page.locator('section[aria-labelledby="local-usage"]');
  await expect(panel).toContainText('Plan: free and open source (AGPL-3.0).');
  await expect(panel.getByRole('link', { name: 'Costs' })).toHaveAttribute('href', '/costs');
  await expect(page.getByTestId('usage-persist')).toBeVisible();
  await expect(page.getByTestId('usage-projects')).toHaveText('0');
  await page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); await projectStore.create('Counted'); localStorage.setItem('cutframe:usage:v1', JSON.stringify({ models: {}, requests: {}, exports: 4 })); });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('usage-projects')).toHaveText('1');
  await expect(page.getByTestId('usage-exports')).toHaveText('4');
  await panel.getByRole('link', { name: 'Costs' }).click();
  await expect(page).toHaveURL(/\/costs$/);
});

test('row 2: no control in the panel changes a limit — only Refresh and Request persistent storage, both leave the quota as it was', async ({ page }) => {
  await page.goto('/settings');
  const panel = page.locator('section[aria-labelledby="local-usage"]');
  await expect(page.getByTestId('usage-storage')).toContainText('of');
  await expect(panel).toContainText('Cutframe sets no limits.');
  expect(await panel.locator('input, select, textarea, [role="slider"], [role="spinbutton"], [contenteditable]').count()).toBe(0); // the <meter> is read-only output
  const names = await panel.getByRole('button').evaluateAll(els => els.map(e => e.textContent?.trim()));
  expect(names.every(n => n === 'Refresh' || n === 'Request persistent storage'), names.join(' | ')).toBe(true);
  expect(names).toContain('Refresh');
  const quota = () => page.evaluate(async () => (await navigator.storage.estimate()).quota);
  const shown = () => page.getByTestId('usage-storage').textContent().then(t => /of (.+)$/.exec(t ?? '')?.[1]);
  const before = { real: await quota(), shown: await shown() };
  for (const name of names) { await panel.getByRole('button', { name: name!, exact: true }).click(); }
  await page.getByRole('button', { name: 'Refresh' }).click();
  expect({ real: await quota(), shown: await shown() }).toEqual(before);
  await expect(page.getByTestId('usage-storage').locator('meter')).toHaveAttribute('max', String(before.real));
});
