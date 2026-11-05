// SPDX-License-Identifier: AGPL-3.0-only
// T08 motion-graphic error panel and repair (F27 (a), mock model). A graphic that throws at render shows, on the stage, a group "Motion graphic error" with the
// graphic's name and the renderer's message and a button "Fix automatically" (disabled with "Connect a model to repair motion graphics." until a model is connected).
// The user's own model gets 2 attempts at most; a fix is saved as one undo step only if the graphic did not change meanwhile.
// Oracle: findings part 2 §33, part 3 §43.17, ticket T08 "Repair tests", toasts "Motion graphic fixed" / "Motion graphic repair failed".
import { test, expect, type Page } from '@playwright/test';
import { guard, intents, notices, openEditor, skipTour, watchIntents } from './t02-support';
import { runCanvas, seekMs, shown } from './t15-support';

test.setTimeout(90_000);
test.use({ viewport: { width: 1280, height: 800 } });
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const seen: string[] = []; errors.set(page, seen);
  page.on('pageerror', e => seen.push(`pageerror: ${e.message}`));
  guard(page); await skipTour(page);
});
test.afterEach(async ({ page }) => { expect(errors.get(page), 'errors thrown in the page').toEqual([]); });

const FPS = 30;
const BROKEN = `export const G = () => { throw new Error('boom'); };`;
const STILL_BROKEN = `export const G = () => { throw new Error('still broken'); };`;
const FIXED = `export const G = () => <AbsoluteFill style={{ backgroundColor: '#00ff00' }} />;`;
const LATE = `export const G = () => { const f = useCurrentFrame(); if (f >= 40) throw new Error('late failure'); return <AbsoluteFill style={{ backgroundColor: '#ffffff' }} />; };`;

const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
/** A 540 x 960 30 fps project with one overlay track holding one motion graphic of the given code (null: none). */
function doc(code: string | null, name = 'Boomer') {
  const item = { id: 'g1', type: 'motionGraphic', trackId: 'o1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000, playbackRate: 1,
    details: { name, ...code === null ? {} : { code } }, metadata: {}, effects: [], masks: [],
    properties: { positionX: prop(100), positionY: prop(200), width: prop(200), height: prop(100), scale: prop(1) } };
  return { schemaVersion: 4, rev: 0, groups: {}, duration: 4000, fps: FPS, size: { width: 540, height: 960 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks: [{ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 }], layerOrder: [{ type: 'track', id: 'o1' }], items: [item] };
}

type Answer = { code: string } | { error: string };
/** Connects a mock repair model that answers in order (the last answer repeats); with `gate` it waits until releaseModel(page). Every request is recorded. */
const connectModel = (page: Page, answers: Answer[], gate = false) => page.evaluate(async ({ answers, gate }) => {
  const p = '/src/mg/repair.ts', { setRepairModel } = await import(p), w = window as any;
  w.__reqs = []; w.__open = null; w.__gate = gate ? new Promise<void>(r => { w.__open = r; }) : null;
  let n = 0;
  setRepairModel(async (req: unknown) => { w.__reqs.push(JSON.parse(JSON.stringify(req))); if (w.__gate) await w.__gate; return answers[Math.min(n++, answers.length - 1)]; });
}, { answers, gate });
const releaseModel = (page: Page) => page.evaluate(() => { (window as any).__open(); });
const requests = (page: Page) => page.evaluate(() => (window as any).__reqs as { code: string; error: string; itemWidth: number; itemHeight: number }[]);

const graphic = async (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document.items.find((i: any) => i.id === 'g1'))); }) as Promise<any>;
const undoStack = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; return (await import(p)).activeRuntime.bus.undoStack.map((e: any) => ({ label: e.label, source: e.source })); }) as Promise<{ label: string; source: string }[]>;
const panel = (page: Page) => page.getByRole('group', { name: 'Motion graphic error' });
const fixButton = (page: Page) => panel(page).getByRole('button', { name: /^(Fix automatically|Fixing…)$/ });

/** Opens the project paused at 500 ms and waits for the error panel. */
async function openBroken(page: Page, code = BROKEN) {
  await openEditor(page, doc(code), 'T08 repair');
  await seekMs(page, 500);
  await expect(panel(page)).toBeVisible();
}

test.describe('the error panel', () => {
  test('a graphic that throws shows "<name>: <renderer message>", a disabled "Fix automatically" and "Connect a model to repair motion graphics."', async ({ page }) => {
    await openBroken(page);
    await expect(panel(page).locator('p').first()).toHaveText(/^Boomer: .*boom/);
    await expect(fixButton(page)).toBeVisible();
    await expect(fixButton(page)).toHaveText('Fix automatically');
    await expect(fixButton(page)).toBeDisabled();
    await expect(panel(page).getByText('Connect a model to repair motion graphics.', { exact: true })).toBeVisible();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
  });

  test('the panel is on the stage; opening it dispatches no repair and changes nothing', async ({ page }) => {
    await openEditor(page, doc(BROKEN), 'T08 repair idle');
    await watchIntents(page);
    await seekMs(page, 500);
    await expect(panel(page)).toBeVisible();
    expect((await intents(page)).filter(i => i.intent.type === 'repairMotionGraphic')).toEqual([]);
    expect((await graphic(page)).details.code).toBe(BROKEN);
    expect(await undoStack(page)).toEqual([]);
  });

  test('connecting a model enables the button and removes the "connect a model" line', async ({ page }) => {
    await openBroken(page);
    await connectModel(page, [{ code: FIXED }]);
    await expect(fixButton(page)).toBeEnabled();
    await expect(panel(page).getByText('Connect a model to repair motion graphics.')).toHaveCount(0);
  });

  test('a graphic that fails only at frame 40 shows the panel at frame 40 and not at frame 10', async ({ page }) => {
    await openEditor(page, doc(LATE), 'T08 repair late');
    await seekMs(page, 10 / FPS * 1000);
    await shown(page, 10);
    await expect(panel(page)).toHaveCount(0);
    await seekMs(page, 40 / FPS * 1000);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('p').first()).toHaveText(/^Boomer: .*late failure/);
    await seekMs(page, 10 / FPS * 1000);
    await shown(page, 10);
    await expect(panel(page)).toHaveCount(0);
  });

  test('no panel for an empty graphic (no code), with or without a model', async ({ page }) => {
    await openEditor(page, doc(null), 'T08 repair empty');
    await connectModel(page, [{ code: FIXED }]);
    await seekMs(page, 500);
    await page.waitForTimeout(800);
    await expect(panel(page)).toHaveCount(0);
    await expect(runCanvas(page).first()).toBeAttached();
  });
});

test.describe('repair', () => {
  test('a fix on attempt 1: toast "Motion graphic fixed", the panel is gone, details.code is the fix, one "Edit items" undo step, the model was asked once with the exact request', async ({ page }) => {
    await openBroken(page);
    await watchIntents(page);
    await connectModel(page, [{ code: FIXED }]);
    await fixButton(page).click();
    await expect(notices(page)).toContainText('Motion graphic fixed');
    await expect(panel(page)).toHaveCount(0);
    expect((await graphic(page)).details).toMatchObject({ name: 'Boomer', code: FIXED });
    expect(await undoStack(page)).toEqual([{ label: 'Edit items', source: 'user' }]);
    const reqs = await requests(page);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ code: BROKEN, itemWidth: 200, itemHeight: 100 });
    expect(reqs[0].error).toMatch(/boom/);
    const repairs = (await intents(page)).filter(i => i.intent.type === 'repairMotionGraphic');
    expect(repairs.map(r => r.intent)).toEqual([{ type: 'repairMotionGraphic', itemId: 'g1', code: FIXED }]);
    expect(repairs[0].outcome).toEqual({ ok: true });
  });

  test('Undo restores the broken code and the panel comes back', async ({ page }) => {
    await openBroken(page);
    await connectModel(page, [{ code: FIXED }]);
    await fixButton(page).click();
    await expect(panel(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).first().click();
    expect((await graphic(page)).details.code).toBe(BROKEN);
    await expect(panel(page)).toBeVisible();
    expect(await undoStack(page)).toEqual([]);
  });

  test('broken then fixed: attempt 2 is asked with attempt 1\'s code and its error, then saved', async ({ page }) => {
    await openBroken(page);
    await connectModel(page, [{ code: STILL_BROKEN }, { code: FIXED }]);
    await fixButton(page).click();
    await expect(notices(page)).toContainText('Motion graphic fixed');
    const reqs = await requests(page);
    expect(reqs).toHaveLength(2);
    expect(reqs[1]).toMatchObject({ code: STILL_BROKEN, itemWidth: 200, itemHeight: 100 });
    expect(reqs[1].error).toMatch(/still broken/);
    expect((await graphic(page)).details.code).toBe(FIXED);
    expect(await undoStack(page)).toHaveLength(1);
  });

  test('a model returning broken code twice: toast "Motion graphic repair failed", red alert "Could not repair this motion graphic: …", code unchanged, two requests, no undo step; the button reads "Fixing…" and is disabled while it runs', async ({ page }) => {
    await openBroken(page);
    await watchIntents(page);
    await connectModel(page, [{ code: STILL_BROKEN }], true);
    await fixButton(page).click();
    await expect(fixButton(page)).toHaveText('Fixing…');
    await expect(fixButton(page)).toBeDisabled();
    await releaseModel(page);
    await expect(notices(page)).toContainText('Motion graphic repair failed');
    const alert = panel(page).getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(/^Could not repair this motion graphic: .*still broken/);
    expect(await alert.evaluate(el => getComputedStyle(el).color)).toBe('rgb(255, 107, 107)');
    await expect(fixButton(page)).toHaveText('Fix automatically');
    await expect(fixButton(page)).toBeEnabled();
    expect((await graphic(page)).details.code).toBe(BROKEN);
    expect(await requests(page)).toHaveLength(2);
    expect(await undoStack(page)).toEqual([]);
    expect((await intents(page)).filter(i => i.intent.type === 'repairMotionGraphic')).toEqual([]);
  });

  test('a model that answers {error} twice: failure shows the model\'s message, code unchanged', async ({ page }) => {
    await openBroken(page);
    await connectModel(page, [{ error: 'The provider is down.' }]);
    await fixButton(page).click();
    await expect(panel(page).getByRole('alert')).toHaveText('Could not repair this motion graphic: The provider is down.');
    expect((await graphic(page)).details.code).toBe(BROKEN);
    expect(await requests(page)).toHaveLength(2);
  });

  test('the graphic edited while the model is waiting: the result is discarded (code unchanged) and the failure text says it changed', async ({ page }) => {
    await openBroken(page);
    await watchIntents(page);
    await connectModel(page, [{ code: FIXED }], true);
    await fixButton(page).click();
    await expect(fixButton(page)).toHaveText('Fixing…');
    const edit = await page.evaluate(async () => { const p = '/src/editor/commands.ts'; return (await import(p)).dispatch({ type: 'editProperty', itemIds: ['g1'], owner: 'T04', label: 'Position', key: 'positionX', value: 50 }); });
    expect(edit).toEqual({ ok: true });
    await releaseModel(page);
    await expect(notices(page)).toContainText('Motion graphic repair failed');
    await expect(panel(page).getByRole('alert')).toHaveText('The motion graphic changed during the repair, so the result was not applied.');
    const g = await graphic(page);
    expect(g.details.code).toBe(BROKEN);
    expect(g.properties.positionX.defaultValue).toBe(50);
    expect((await intents(page)).filter(i => i.intent.type === 'repairMotionGraphic')).toEqual([]);
    expect(await undoStack(page)).toHaveLength(1); // only the user's own edit
  });
});
