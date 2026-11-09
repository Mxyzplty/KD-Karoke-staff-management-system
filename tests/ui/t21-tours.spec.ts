// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 5 in Chromium (§36): the editor and home product tours, their seen-flags stored locally, a seen tour not
// showing again after a reload, and the home tour waiting for onboarding to be finished or dismissed. Nothing leaves localhost.
import { test, expect, type Page } from '@playwright/test';
import { guard, openEditor, richDoc } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const EDITOR = 'cutframe:tour:editor', HOME = 'cutframe:tour:home', ONBOARDING = 'cutframe:onboarding:v1';
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

const flag = (page: Page, key: string) => page.evaluate(k => localStorage.getItem(k), key);
const onboarding = (page: Page, state: Record<string, unknown>) => page.addInitScript(([k, v]) => { try { localStorage.setItem(k as string, JSON.stringify(v)); } catch { /* storage unavailable */ } }, [ONBOARDING, { phase: 'ready', step: 0, answers: {}, other: {}, ...state }]);
const homeTour = (page: Page) => page.getByRole('dialog', { name: 'Home tour' });
const editorTour = (page: Page) => page.getByRole('dialog', { name: 'Editor tour' });

test('row 5: the editor tour shows on the first visit with its four steps, and Done stores a local seen-flag', async ({ page }) => {
  await onboarding(page, { completed: true });
  expect(await openEditor(page, richDoc(), 'T21 tour')).toBeTruthy();
  const tour = editorTour(page);
  await expect(tour).toBeVisible({ timeout: 10_000 });
  expect(await flag(page, EDITOR)).toBeNull();
  const steps = ['Your footage', 'Reference videos', 'The timeline', 'Connect your own agent'];
  for (const [n, title] of steps.entries()) {
    await expect(tour.getByText(`${n + 1} of 4`)).toBeVisible();
    await expect(tour.getByRole('heading')).toHaveText(title);
    await expect(page.locator(`[data-tour="${['footage', 'reference-tab', 'timeline', 'agent-badge'][n]}"]`)).toHaveCount(1); // the anchor the step points at
    await tour.getByRole('button', { name: n < 3 ? 'Next' : 'Done' }).click();
  }
  await expect(tour).toHaveCount(0);
  expect(await flag(page, EDITOR)).toBe('done');
  expect(await page.evaluate(() => sessionStorage.getItem('cutframe:tour:editor'))).toBeNull(); // localStorage, not sessionStorage
});

test('row 5: a seen editor tour does not show again after a reload; clearing the flag brings it back', async ({ page }) => {
  await onboarding(page, { completed: true });
  const id = await openEditor(page, richDoc(), 'T21 tour reload');
  await expect(editorTour(page)).toBeVisible({ timeout: 10_000 });
  await editorTour(page).getByRole('button', { name: 'Skip tour' }).click();
  expect(await flag(page, EDITOR)).toBe('skipped');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await page.waitForTimeout(1500); // the tour polls for its anchors every 100 ms; it would be up by now
  await expect(editorTour(page)).toHaveCount(0);
  await page.evaluate(k => localStorage.removeItem(k), EDITOR);
  await page.goto(`/project/${id}`);
  await expect(editorTour(page)).toBeVisible({ timeout: 10_000 });
});

test('row 5: the home tour (two steps) shows once onboarding is finished, Done stores its own local flag, and it does not return after a reload', async ({ page }) => {
  await onboarding(page, { completed: true });
  await page.goto('/');
  const tour = homeTour(page);
  await expect(tour).toBeVisible({ timeout: 10_000 });
  await expect(tour.getByText('1 of 2')).toBeVisible(); await expect(tour.getByRole('heading')).toHaveText('Start a video');
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour.getByText('2 of 2')).toBeVisible(); await expect(tour.getByRole('heading')).toHaveText('Your projects');
  expect(await flag(page, HOME)).toBeNull();
  await tour.getByRole('button', { name: 'Done' }).click();
  await expect(tour).toHaveCount(0);
  expect(await flag(page, HOME)).toBe('done');
  expect(await flag(page, EDITOR)).toBeNull(); // the two tours keep separate flags
  await page.reload(); await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(homeTour(page)).toHaveCount(0);
});

test('row 5: Skip tour on home stores "skipped" and the tour stays gone after a reload', async ({ page }) => {
  await onboarding(page, { completed: true });
  await page.goto('/');
  await expect(homeTour(page)).toBeVisible({ timeout: 10_000 });
  await homeTour(page).getByRole('button', { name: 'Skip tour' }).click();
  expect(await flag(page, HOME)).toBe('skipped');
  await page.reload(); await page.waitForTimeout(1500);
  await expect(homeTour(page)).toHaveCount(0);
});

test('row 5: the home tour waits while the setup card is up, and starts once onboarding is dismissed (after a reload)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Set up' })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(homeTour(page)).toHaveCount(0); // onboarding is neither finished nor dismissed
  expect(await flag(page, HOME)).toBeNull();
  await page.getByRole('button', { name: 'Not now' }).click();
  await page.reload();
  await expect(homeTour(page)).toBeVisible({ timeout: 10_000 });
});

test('row 5: dismissing the setup card starts the home tour in the same visit, without a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(homeTour(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('button', { name: 'Set up' })).toHaveCount(0);
  await expect(homeTour(page)).toBeVisible({ timeout: 10_000 });
});

test('row 5: finishing onboarding by skipping setup releases the home tour on the page it lands on', async ({ page }) => {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await page.getByRole('dialog', { name: 'Skip setup' }).getByRole('button', { name: 'Skip setup', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(homeTour(page)).toBeVisible({ timeout: 10_000 });
});
