// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
test('source build opens without any provider or remote request', async ({ page }) => {
  const external: string[] = [];
  page.on('request', r => { if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) external.push(r.url()); });
  await page.goto('/?no-provider=1');
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByText('No AI provider connected.')).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ New Video', exact: true })).toBeVisible();
  expect(external).toEqual([]);
});
