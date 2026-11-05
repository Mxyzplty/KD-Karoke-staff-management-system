// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
const cases = `/@fs/${process.cwd().replaceAll('\\', '/')}/tests/t14-round2-cases.ts`;
test.beforeEach(async ({ page }) => {
  // Bind the shipped lifecycle once, without mounting a second copy via the React app.
  await page.route('**/round2-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>T14 race schedules</title>' }));
  await page.goto('/round2-test');
});
test('F16 real Web Locks / IDB / OPFS: obsolete writer cannot overwrite successor; deletion and recovery', async ({ page }) => {
  const r = await page.evaluate(async url => {
    const m = await import(url);
    return { APIs: typeof navigator.locks?.request === 'function' && typeof navigator.storage.getDirectory === 'function' && typeof indexedDB.open === 'function', kept: await m.staleProxy(true), deleted: await m.staleProxy(true, true) };
  }, cases);
  expect(r.APIs).toBe(true); expect(r.kept.before).toBe('NEW'); expect(r.kept.final).toBe('NEW'); expect(r.kept.width).toBe(8);
  expect(r.kept.key).not.toBe(r.kept.assetId); expect(r.kept.remaining).toContain(r.kept.key);
  expect(r.kept.remaining.filter((k: string) => k.startsWith(r.kept.assetId))).toEqual([r.kept.key]);
  expect(r.deleted.row).toBeUndefined(); expect(r.deleted.remaining.filter((k: string) => k.startsWith(r.deleted.assetId))).toEqual([]);
});
test('F17 real Web Locks: failed stale replacement then simultaneous manual and automatic retries', async ({ page }) => {
  const r = await page.evaluate(async url => { const m = await import(url); return [await m.failedTakeover(true, false), await m.failedTakeover(true, true)]; }, cases);
  for (const out of r) expect(out).toEqual({ replacement: 'failed', probes: 1, phase: 'finished', status: 'ready' });
});
test('F18 real Web Locks / IDB: refresh and successor between discovery and interruption', async ({ page }) => {
  const r = await page.evaluate(async url => { const m = await import(url); return [await m.freshHeartbeat(true), await m.freshHeartbeat(true, true)]; }, cases);
  for (const out of r) { expect(out.found).toEqual([]); expect(out.record.phase).toBe('running'); expect(out.asset.last_error_code).toBeNull(); }
  const successor = await page.evaluate(async url => (await import(url)).recoverySuccessor(true), cases);
  expect(successor.record.attemptId).toBe('successor'); expect(successor.asset.processing_status).toBe('ready'); expect(successor.asset.last_error_code).toBeNull();
});
test('F19 real lifecycle: visible rescan finishes before cancellation publication, then resumes after release', async ({ page }) => {
  const r = await page.evaluate(async url => (await import(url)).quickResume(), cases);
  expect(r.probes).toBe(2); expect(r.phase).toBe('finished'); expect(r.asset.processing_status).toBe('ready'); expect(r.asset.preparationAttempts).toBe(0); expect(r.asset.last_error_code).toBeNull();
});
