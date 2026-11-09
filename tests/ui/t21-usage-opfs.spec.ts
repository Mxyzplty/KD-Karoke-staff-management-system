// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 2 in Chromium: +200 MB ±1 MB in the Local usage panel after 200 MB is written to OPFS and Refresh is pressed.
// Its own file, without t21-usage's hooks: this test runs in its own browser, and those would start a second one it never uses.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, test, expect, type Page } from '@playwright/test';
import { guard, skipTour } from './t02-support';

const MB = 2 ** 20;
const used = (page: Page) => page.getByTestId('usage-storage').getAttribute('data-used').then(Number);

test('row 2: writing 200 MB to OPFS raises the shown storage use by 200 MB ±1 MB after Refresh', async ({ baseURL }) => {
  // A profile on disk, as a real browser has: an off-the-record context keeps OPFS in memory, and this write then depends on
  // what else the machine is holding, not on the panel.
  const profile = mkdtempSync(join(tmpdir(), 't21-usage-')), context = await chromium.launchPersistentContext(profile, { baseURL, viewport: { width: 1400, height: 900 } });
  try {
    const page = context.pages()[0] ?? await context.newPage(), left = guard(page);
    await skipTour(page);
    await page.goto('/settings');
    await expect(page.getByTestId('usage-storage')).toContainText(/MB|GB/);
    const before = await used(page);
    await page.evaluate(async chunks => {
      const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('t21-usage', { create: true });
      const writable = await (await dir.getFileHandle('fill.bin', { create: true })).createWritable();
      const block = new Uint8Array(64 * 1024); crypto.getRandomValues(block);
      const chunk = new Uint8Array(8 * 1024 * 1024); for (let at = 0; at < chunk.length; at += block.length) chunk.set(block, at);
      for (let n = 0; n < chunks; n++) await writable.write(chunk);
      await writable.close();
    }, 25); // 25 × 8 MiB = 200 MiB
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh' }).click(); return Math.abs((await used(page)) - before - 200 * MB) <= MB; }, { timeout: 20_000, message: 'shown usage after Refresh' }).toBe(true);
    const after = await used(page);
    expect(Math.abs(after - before - 200 * MB)).toBeLessThanOrEqual(MB);
    await expect(page.getByTestId('usage-storage')).toContainText(/\d+(\.\d)? (MB|GB) of \d+(\.\d)? (MB|GB)/);
    expect(left, 'requests that left localhost').toEqual([]);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
