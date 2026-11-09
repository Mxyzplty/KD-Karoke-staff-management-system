// SPDX-License-Identifier: AGPL-3.0-only
// PT-FE-11: live tabs and a timed-out, non-cancellable project creation.
import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 900 } });
test.setTimeout(180_000);

const snapshot = (page: Page) => page.evaluate(async () => {
  const p = '/src/store/database.ts', { projectStore } = await import(p);
  const projects = await projectStore.rows('projects') as { id: string; is_demo?: boolean }[];
  const assets = await projectStore.rows('assets') as { id: string; source?: { kind: string } }[];
  const demo = assets.filter(a => a.source?.kind === 'demo');
  const readable = await Promise.all(demo.map(async a => {
    try { return (await projectStore.media.read(a.id)).size > 0; } catch { return false; }
  }));
  return { projects: projects.filter(p => p.is_demo).map(p => p.id), assets: demo.map(a => a.id), readable: demo.filter((_, n) => readable[n]).map(a => a.id) };
});

test('PT-FE-11: entering and leaving a second tab preserves the live first demo', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('cutframe:onboarding:v1', JSON.stringify({ phase: 'drive-picker', step: 3, answers: {}, other: {}, completed: false })));
  await page.goto('/onboarding');
  await page.getByRole('button', { name: /Use the built-in assistant/ }).click();
  await page.getByRole('button', { name: 'Show me', exact: true }).click();
  await expect(page.locator('.demo-turn.assistant').first()).toBeVisible({ timeout: 90_000 });
  const before = await snapshot(page);
  expect(before.projects).toHaveLength(1);
  expect(before.assets).toHaveLength(14);
  expect(before.readable).toEqual(before.assets);

  const second = await context.newPage();
  await second.goto('/onboarding');
  // FirstEdit starts production setup on mount. Showing it also permits a safe wait or refusal.
  const show = second.getByRole('button', { name: 'Show me', exact: true });
  const refused = second.getByRole('heading', { name: 'The demo could not start' });
  await expect(show.or(refused)).toBeVisible();
  if (await show.isVisible()) await show.click();
  await Promise.race([
    second.locator('.demo-turn.assistant').first().waitFor({ timeout: 10_000 }).catch(() => {}),
    refused.waitFor({ timeout: 10_000 }).catch(() => {}),
  ]);
  const during = await snapshot(page);
  expect.soft(during.projects, 'B entering must preserve A project').toContain(before.projects[0]);
  expect.soft(during.assets, 'B entering must preserve all A asset IDs').toEqual(expect.arrayContaining(before.assets));
  expect.soft(during.readable, 'B entering must preserve A media').toEqual(expect.arrayContaining(before.assets));
  // Leaving the route exercises FirstEdit cleanup whether B started, waited, or refused.
  await second.evaluate(() => { history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(second.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await second.waitForTimeout(2000); // allow asynchronous unmount cleanup to start before checking A
  await expect.poll(async () => {
    const after = await snapshot(page);
    return { project: after.projects.includes(before.projects[0]), assets: before.assets.filter(id => after.assets.includes(id)).length, readable: before.assets.filter(id => after.readable.includes(id)).length };
  }, { timeout: 10_000 }).toEqual({ project: true, assets: 14, readable: 14 });
});

test('PT-FE-11: timeout and leave cannot leave a project from delayed real creation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => { const p = '/src/settings/first-edit/pack.ts'; await (await import(p)).loadPack(); });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(async () => {
    const db = '/src/store/database.ts', pack = '/src/settings/first-edit/pack.ts';
    const { projectStore } = await import(db), { setupDemo } = await import(pack), w = window as any;
    const create = projectStore.create.bind(projectStore), put = projectStore.putRow.bind(projectStore);
    w.createReached = new Promise<void>(resolve => { w.reachCreate = resolve; });
    w.createFinished = new Promise<void>(resolve => { w.finishCreate = resolve; });
    w.markFinished = new Promise<void>(resolve => { w.finishMark = resolve; });
    projectStore.create = async (...args: Parameters<typeof create>) => {
      w.reachCreate();
      await new Promise<void>(resolve => { w.releaseCreate = resolve; });
      try { return await create(...args); } finally { w.finishCreate(); }
    };
    projectStore.putRow = async (...args: Parameters<typeof put>) => {
      try { return await put(...args); } finally { if (args[0] === 'projects' && (args[1] as any).is_demo) w.finishMark(); }
    };
    w.settled = false;
    w.setupResult = setupDemo(projectStore).then(() => ({ ok: true }), (e: any) => ({ ok: false, reason: e.reason })).then((result: { ok: boolean; reason?: string }) => { w.settled = true; return result; });
  });
  await page.evaluate(() => (window as any).createReached);
  await page.clock.runFor(119_999);
  expect(await page.evaluate(() => (window as any).settled)).toBe(false);
  await page.clock.runFor(2);
  expect(await page.evaluate(() => (window as any).setupResult)).toEqual({ ok: false, reason: 'timeout' });
  await page.evaluate(async () => {
    const db = '/src/store/database.ts', demos = '/src/settings/first-edit/demos.ts', w = window as any;
    w.cleanup = (await import(demos)).leaveDemos((await import(db)).projectStore);
    w.releaseCreate();
  });
  await page.evaluate(async () => { const w = window as any; await w.createFinished; await w.cleanup; });
  await page.clock.resume();
  // The unfixed build marks the late row asynchronously after create returns. A fixed build may never mark it.
  await page.evaluate(() => Promise.race([(window as any).markFinished, new Promise(resolve => setTimeout(resolve, 2000))]));
  expect(await snapshot(page)).toEqual({ projects: [], assets: [], readable: [] });
  expect(await page.evaluate(async () => {
    const p = '/src/store/database.ts', { projectStore } = await import(p);
    return { projects: (await projectStore.rows('projects')).length, assets: (await projectStore.rows('assets')).length };
  })).toEqual({ projects: 0, assets: 0 });
});
