// SPDX-License-Identifier: AGPL-3.0-only
// T24 (T21 follow-up) in Chromium: Settings → AI and services when the read of the model connections hangs or fails. A loading line,
// then an alert with Try again after 10 s on the page clock or at once on a rejection; a late answer still shows the section; the
// normal path shows neither. No step waits on real time: the page clock is frozen and only runFor moves it.
import { test, expect, type Page } from '@playwright/test';
import { guard, notices, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

/** A plain Error, so the notification is this text alone (no STORAGE_QUOTA mapping). */
const FAILED = 'T24: the providers row could not be read.';
type Fault = { hold: boolean; fail: 'all' | 'next' | 'none' };
/** Every get('providers') on the settings store: unanswered while hold is on (until release), thrown while fail says so. */
const fault = (page: Page, start: Fault) => page.addInitScript(({ start, message }) => {
  const get = IDBObjectStore.prototype.get, held: IDBRequest[] = [];
  const f = { ...start, release: () => { for (const r of held.splice(0)) r.dispatchEvent(new Event('success')); } };
  (window as unknown as { __read: typeof f }).__read = f;
  IDBObjectStore.prototype.get = function (key) {
    const mine = this.name === 'settings' && key === 'providers';
    if (mine && f.fail !== 'none') { if (f.fail === 'next') f.fail = 'none'; throw new Error(message); }
    const r = get.call(this, key);
    if (mine) r.addEventListener('success', e => { if (e.isTrusted && f.hold) { e.stopImmediatePropagation(); held.push(r); } });
    return r;
  };
}, { start, message: FAILED });
const set = (page: Page, patch: Partial<Fault>) => page.evaluate(patch => { Object.assign((window as unknown as { __read: Fault }).__read, patch); }, patch);
const release = (page: Page) => page.evaluate(() => (window as unknown as { __read: { release: () => void } }).__read.release());
/** install keeps real time flowing (D34), so the clock is paused an hour ahead before the page loads: from here only runFor moves it. */
async function freeze(page: Page) {
  await page.clock.install({ time: new Date('2026-11-01T10:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-01T11:00:00Z'));
}
/** Settings is lazy, and React commits a Suspense reveal no sooner than 300 ms (page clock) after its fallback, through a page
 *  timer. So once the app shell is up (it commits together with the fallback) the clock runs 300 ms; the section mounts after
 *  that, and its own 10 s starts at its mount. A reveal that does not come fails here, not at a later assertion. */
async function open(page: Page) {
  await page.goto('/settings');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.clock.runFor(300);
  await expect(services(page)).toBeVisible();
}
const services = (page: Page) => page.getByRole('region', { name: 'AI and services', exact: true });
const loading = (page: Page) => services(page).getByText('Loading your model connections…', { exact: true });
const alert = (page: Page) => services(page).getByRole('alert');
const again = (page: Page) => alert(page).getByRole('button', { name: 'Try again', exact: true });
const add = (page: Page) => services(page).getByRole('button', { name: '＋ Add connection', exact: true });
const notes = (page: Page) => notices(page).locator('div');

test('T24: a read that never answers shows the loading line, then after 10 s the alert; Try again brings the section back', async ({ page }) => {
  await freeze(page); await fault(page, { hold: true, fail: 'none' });
  await open(page);
  await expect(loading(page)).toBeVisible();
  await expect(add(page)).toHaveCount(0); await expect(alert(page)).toHaveCount(0);
  await page.clock.runFor(9_000);
  await expect(loading(page)).toBeVisible(); await expect(alert(page)).toHaveCount(0);
  await page.clock.runFor(1_000);
  await expect(alert(page)).toContainText('Couldn’t read your model connections from this browser’s storage.');
  await expect(again(page)).toBeVisible();
  await expect(loading(page)).toHaveCount(0); await expect(add(page)).toHaveCount(0);
  // A retried read gets its own 10 s. The clock is paused, so the new timer starts at the frozen time of the click and 9 999 + 1 is exact.
  await again(page).click();
  await expect(loading(page)).toBeVisible(); await expect(alert(page)).toHaveCount(0);
  await page.clock.runFor(9_999);
  await expect(loading(page)).toBeVisible(); await expect(alert(page)).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(again(page)).toBeVisible(); await expect(loading(page)).toHaveCount(0);
  await set(page, { hold: false });
  await again(page).click();
  await expect(add(page)).toBeVisible();
  await expect(alert(page)).toHaveCount(0); await expect(loading(page)).toHaveCount(0);
  await add(page).click();
  await expect(page.getByRole('form', { name: 'Add a model connection' })).toBeVisible();
});

test('T24: an answer that comes after the 10 s mark shows the section with no click, and the alert goes', async ({ page }) => {
  await freeze(page); await fault(page, { hold: true, fail: 'none' });
  await open(page);
  await expect(loading(page)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(again(page)).toBeVisible();
  await release(page);
  await expect(add(page)).toBeVisible();
  await expect(services(page).getByText('No model connections.', { exact: true })).toBeVisible();
  await expect(alert(page)).toHaveCount(0); await expect(loading(page)).toHaveCount(0);
  await expect(notes(page)).toHaveCount(0); // a slow read is not a storage error
});

test('T24: a read that throws shows the alert at once with a storage-error notification, and Try again recovers the section', async ({ page }) => {
  await freeze(page); await fault(page, { hold: false, fail: 'all' });
  await open(page);
  await expect(alert(page)).toContainText('Couldn’t read your model connections from this browser’s storage.'); // 300 ms of page time since the load, far under 10 s
  await expect(again(page)).toBeVisible();
  await expect(loading(page)).toHaveCount(0); await expect(add(page)).toHaveCount(0);
  await expect(notices(page)).toContainText(FAILED); // the footer and Local usage read the same row and report it too
  await set(page, { fail: 'none' });
  await again(page).click();
  await expect(add(page)).toBeVisible();
  await expect(alert(page)).toHaveCount(0); await expect(loading(page)).toHaveCount(0);
});

test('T24: a retry that throws shows the alert again at once and reports the error once', async ({ page }) => {
  await freeze(page); await fault(page, { hold: true, fail: 'none' });
  await open(page);
  await expect(loading(page)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(again(page)).toBeVisible();
  await expect(notes(page)).toHaveCount(0);
  // The read Try again starts is the only get('providers') from here on, so the one notification is the section's own.
  await set(page, { fail: 'next' });
  await again(page).click();
  await expect(notes(page)).toHaveCount(1); await expect(notes(page)).toContainText(FAILED);
  await expect(again(page)).toBeVisible(); await expect(loading(page)).toHaveCount(0); // the clock has not moved since the click
  await set(page, { hold: false });
  await again(page).click();
  await expect(add(page)).toBeVisible();
  await expect(alert(page)).toHaveCount(0); await expect(notes(page)).toHaveCount(1);
});

test('T24: a normal read shows the section with no alert, no loading line and no notification', async ({ page }) => {
  await page.goto('/settings');
  await expect(add(page)).toBeVisible();
  await expect(services(page).getByText('No model connections.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('local-usage')).toBeVisible(); // the page's other reads have answered
  await expect(alert(page)).toHaveCount(0); await expect(loading(page)).toHaveCount(0);
  await expect(notes(page)).toHaveCount(0);
});
