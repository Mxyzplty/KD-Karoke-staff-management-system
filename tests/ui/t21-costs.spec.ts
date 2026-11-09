// SPDX-License-Identifier: AGPL-3.0-only
// T21 /costs in Chromium: the optional paid extras with who bills them, the free alternatives, and this device's storage quota and
// decoder support. No request leaves localhost: the pricing links are only links.
import { test, expect, type Page } from '@playwright/test';
import { guard, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

test('/costs says Cutframe is free and lists each optional paid extra with its biller', async ({ page }) => {
  await page.goto('/costs');
  await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
  await expect(page.getByText('Cutframe has no subscription, watermark or paid core limits.')).toBeVisible();
  const rows = page.getByTestId('costs-extras').locator('tbody tr');
  const cells = await rows.evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].slice(0, 3).map(td => td.textContent)));
  expect(cells.map(c => c[0])).toEqual(['OpenAI', 'OpenRouter', 'Anthropic', 'Google Gemini', 'ElevenLabs', 'Your backup folder’s sync service']);
  expect(cells.map(c => c[2])).toEqual(['OpenAI', 'OpenRouter', 'Anthropic', 'Google', 'ElevenLabs', 'That service']);
  // Local servers are free, so they are not billed extras.
  await expect(page.getByTestId('costs-extras')).not.toContainText('Ollama');
});

test('every hosted extra links to a pricing page that opens in a new tab with rel=noreferrer', async ({ page }) => {
  await page.goto('/costs');
  const links = page.getByTestId('costs-extras').getByRole('link', { name: 'Pricing' });
  await expect(links).toHaveCount(5);
  const attributes = await links.evaluateAll(as => as.map(a => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]));
  for (const [href, target, rel] of attributes) { expect(href).toMatch(/^https:\/\//); expect(target).toBe('_blank'); expect(rel).toBe('noreferrer'); }
});

// Limits and URLs as each provider's own page gave them on 5 Nov 2026; the page must say that date.
const STOCK: [string, string[], [string, string][]][] = [
  ['Pexels', ['200 requests per hour', '20,000 requests per month'], [['Pricing and limits', 'https://www.pexels.com/api/documentation/']]],
  ['Unsplash', ['50 requests per hour', '1,000 requests per hour'], [['Pricing and limits', 'https://unsplash.com/developers']]],
  ['Freesound', ['60 requests per minute', '2,000 requests per day', '30 requests per minute', '500 requests per day', 'non-commercial'], [['Limits', 'https://freesound.org/docs/api/overview.html'], ['Terms', 'https://freesound.org/docs/api/terms_of_use.html']]],
];
test('stock media shows each provider’s limits and its links, opened in a new tab with rel=noreferrer, and the date they were checked', async ({ page }) => {
  await page.goto('/costs');
  const table = page.getByTestId('costs-stock'), rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(STOCK.length);
  for (const [n, [provider, limits, links]] of STOCK.entries()) {
    const row = rows.nth(n);
    await expect(row.locator('td').first()).toHaveText(provider);
    for (const limit of limits) await expect(row).toContainText(limit);
    for (const [name, href] of links) {
      const link = row.getByRole('link', { name, exact: true });
      await expect(link).toHaveAttribute('href', href);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noreferrer');
    }
  }
  await expect(page.getByTestId('costs-stock-date')).toContainText('5 Nov 2026');
  // No provider publishes a price for going over: the page says so rather than implying a free upgrade.
  await expect(rows.nth(1)).toContainText('No price is published');
  await expect(rows.nth(2)).toContainText('No price is published');
});

test('the free alternatives are listed', async ({ page }) => {
  await page.goto('/costs');
  const free = page.getByRole('heading', { name: 'Free alternatives' }).locator('xpath=following-sibling::ul[1]');
  await expect(free).toContainText('Local model servers (Ollama, LM Studio, llama.cpp, vLLM)');
  await expect(free).toContainText('Speech to text on this device: free.');
  await expect(free).toContainText('Stock media from Pexels, Unsplash and Freesound');
  await expect(free).toContainText('Your own agent through the helper');
});

test('This device shows the browser storage quota and a decode line for H.264, HEVC, VP9 and AV1', async ({ page }) => {
  await page.goto('/costs');
  await expect(page.getByTestId('costs-quota')).toContainText(/\d+(\.\d)? (MB|GB) used of \d+(\.\d)? (MB|GB)/);
  for (const codec of ['H.264', 'HEVC', 'VP9', 'AV1']) {
    await expect(page.getByText(`${codec} decoding`)).toBeVisible();
    await expect(page.locator(`[data-codec="${codec}"]`)).toHaveText(/^(Hardware|Software only|Not supported)$/);
  }
});

test('Costs is reachable from the top navigation and from Settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Costs' }).click();
  await expect(page).toHaveURL(/\/costs$/);
  await page.goto('/settings');
  await page.locator('section[aria-labelledby="local-usage"]').getByRole('link', { name: 'Costs' }).click();
  await expect(page).toHaveURL(/\/costs$/);
});
