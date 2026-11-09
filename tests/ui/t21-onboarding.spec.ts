// SPDX-License-Identifier: AGPL-3.0-only
// T21 /onboarding in Chromium: the four About You questions with their option counts and answer rules, the drive picker, and the
// redirect home once setup is done or skipped.
import { test, expect, type Page } from '@playwright/test';
import { guard, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const KEY = 'cutframe:onboarding:v1';
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

/** [title, option count, radio (one answer) or checkbox (several)] in the order the page asks them. */
const QUESTIONS: [string, number, 'radio' | 'checkbox'][] = [['Who are you?', 8, 'radio'], ['What do you make?', 12, 'checkbox'], ['What should the AI do?', 10, 'checkbox'], ['What do you edit with today?', 8, 'radio']];
const state = (page: Page) => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY);
/** Answers the first option of each question and presses Next, landing on the drive picker. */
async function aboutYou(page: Page) {
  for (const [title] of QUESTIONS) {
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.getByRole('list', { name: title }).locator('input').first().check();
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.getByRole('heading', { name: 'How do you want to drive the AI?' })).toBeVisible();
}

test('the four questions have the contracted option counts and one-answer / several-answer inputs', async ({ page }) => {
  await page.goto('/onboarding');
  await expect(page.getByRole('list', { name: 'Setup progress' }).getByRole('listitem')).toHaveText(['Sign Up', 'About You', 'First Edit', 'Ready']);
  for (const [n, [title, count, type]] of QUESTIONS.entries()) {
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText(`0${n + 1} of 05`)).toBeVisible();
    const inputs = page.getByRole('list', { name: title }).locator('input');
    await expect(inputs).toHaveCount(count);
    await expect(inputs.first()).toHaveAttribute('type', type);
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
    await inputs.first().check();
    await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
    await page.getByRole('button', { name: 'Next' }).click();
  }
});

test('a one-answer question replaces its choice, a several-answer question toggles', async ({ page }) => {
  await page.goto('/onboarding');
  const who = page.getByRole('list', { name: 'Who are you?' }).locator('input');
  await who.nth(0).check(); await who.nth(1).check();
  await expect(who.nth(0)).not.toBeChecked(); await expect(who.nth(1)).toBeChecked();
  await page.getByRole('button', { name: 'Next' }).click();
  const make = page.getByRole('list', { name: 'What do you make?' }).locator('input');
  await make.nth(0).check(); await make.nth(1).check();
  await expect(make.nth(0)).toBeChecked(); await expect(make.nth(1)).toBeChecked();
  await make.nth(0).uncheck();
  await expect(make.nth(0)).not.toBeChecked();
  expect((await state(page)).answers).toMatchObject({ role: ['Social media manager'], kind: ['YouTube / long-form'] });
});

test('Other reveals a free-text field and Back keeps the answers', async ({ page }) => {
  await page.goto('/onboarding');
  const who = page.getByRole('list', { name: 'Who are you?' }).locator('input');
  await who.last().check();
  await page.getByRole('textbox', { name: 'Tell us more' }).fill('Teacher');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('list', { name: 'Who are you?' }).locator('input').last()).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Tell us more' })).toHaveValue('Teacher');
});

test('the drive picker offers built-in, own agent and skip', async ({ page }) => {
  await page.goto('/onboarding');
  await aboutYou(page);
  const cards = page.locator('.drive-card');
  await expect(cards).toHaveCount(3);
  expect(await cards.evaluateAll(els => els.map(e => e.getAttribute('data-drive')))).toEqual(['built-in', 'own', 'skip']);
  await expect(cards.nth(0)).toContainText('Use the built-in assistant');
  await expect(cards.nth(1)).toContainText('Connect your own AI');
  await expect(cards.nth(2)).toContainText('Not now — go to the editor');
  await expect(page.getByText('Either way you get the same editor and the same features.')).toBeVisible();
});

test('own agent leads to the install step with the helper command and a back path', async ({ page }) => {
  await page.goto('/onboarding');
  await aboutYou(page);
  await page.locator('.drive-card[data-drive="own"]').click();
  await expect(page.getByRole('heading', { name: 'Install the helper' })).toBeVisible();
  await expect(page.getByText('npx cutframe-connect').first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Setup progress' }).getByRole('listitem')).toHaveText(['Sign Up', 'About You', 'Install', 'Connect', 'Ready']);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Pair this tab' })).toBeVisible();
  // The code comes from this tab or the helper, never the client (T18a pairing, AgentLink).
  await expect(page.getByText('Connect this tab, then enter the pairing code the helper printed, or type the code this tab shows into the helper’s terminal.')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'How do you want to drive the AI?' })).toBeVisible();
});

test('Not now finishes onboarding and redirects to /', async ({ page }) => {
  await page.goto('/onboarding');
  await aboutYou(page);
  await page.locator('.drive-card[data-drive="skip"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Who are you?' })).toHaveCount(0);
  expect(await state(page)).toMatchObject({ completed: true, phase: 'ready' });
});

test('Skip setup on a question asks about the demo, and skipping there completes onboarding', async ({ page }) => {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Skip setup' }).click();
  const dialog = page.getByRole('dialog', { name: 'Skip setup' });
  await expect(dialog).toContainText('Would you like the quick demo with the built-in assistant instead?');
  await expect(dialog.getByRole('button', { name: 'Show me the demo' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Skip setup', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await state(page)).toMatchObject({ completed: true });
});

test('a finished onboarding sends /onboarding home', async ({ page }) => {
  await page.addInitScript(k => { try { localStorage.setItem(k, JSON.stringify({ phase: 'ready', step: 0, answers: {}, other: {}, completed: true })); } catch { /* storage unavailable */ } }, KEY);
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/$/);
});

test('Home offers setup until it is dismissed, and Not now is remembered', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Set up' })).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('button', { name: 'Set up' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Set up' })).toHaveCount(0);
  expect(await state(page)).toMatchObject({ dismissed: true });
});
