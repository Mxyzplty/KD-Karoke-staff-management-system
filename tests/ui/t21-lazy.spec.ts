// SPDX-License-Identifier: AGPL-3.0-only
// T21 load: Settings, Help, Costs and Onboarding (with First Edit and the help corpus) load with their routes, not with every page.
// demos.ts stays: start-up sweeps a demo left behind with it, and it holds no route code.
import { test, expect, type Page } from '@playwright/test';
import { skipTour } from './t02-support';

const ROUTES = /\/src\/settings\/(SettingsPage|HelpPage|CostsPage|OnboardingPage|Services|guides|help)\.tsx?|\/src\/settings\/first-edit\/(?!demos\.ts)|\/src\/settings\/help-corpus\.markdown/;
const watch = (page: Page) => { const seen: string[] = []; page.on('request', r => { const path = new URL(r.url()).pathname; if (ROUTES.test(path)) seen.push(path); }); return seen; };

test('the home page loads none of the route code', async ({ page }) => {
  const seen = watch(page);
  await skipTour(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual([]);
});

const pages: [string, string, RegExp][] = [['/settings', 'Settings', /SettingsPage/], ['/costs', 'Costs', /CostsPage/], ['/help', 'Help', /HelpPage/], ['/onboarding', 'Who are you?', /OnboardingPage/]];
for (const [path, heading, code] of pages) {
  test(`${path} loads its code with its route, and shows from a direct load and from home`, async ({ page }) => {
    await skipTour(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    const seen = watch(page);
    await page.evaluate(to => { history.pushState(null, '', to); dispatchEvent(new PopStateEvent('popstate')); }, path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    expect(seen.some(p => code.test(p)), 'fetched on the route change').toBe(true);
  });
}
