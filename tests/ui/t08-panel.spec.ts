// SPDX-License-Identifier: AGPL-3.0-only
// T08 Motion Graphics rail panel (wide rail tab, compact "Motion" drawer). Oracle: findings part 3 §46.3 (info icon, My Presets (n), Add Blank with start / end
// 0 to 5 s step 0.1 min 0, button Add Blank Motion Graphic, toast "Motion graphic added", no code or prompt field: generation is agent-only §44.9),
// ticket T08 "Motion Graphics rail panel", T02 shell I1 (opening a panel dispatches no intent), error INVALID_DURATION never reachable from the panel (button disabled).
import { test, expect, type Page } from '@playwright/test';
import { clearIntents, guard, intents, notices, openEditor, richDoc, skipTour, watchIntents } from './t02-support';

test.setTimeout(60_000);
test.beforeEach(async ({ page }) => { guard(page); await skipTour(page); });

const liveDoc = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document)); }) as Promise<{ items: any[]; tracks: any[]; layerOrder: any[]; size: { width: number; height: number } }>;
const graphics = async (page: Page) => (await liveDoc(page)).items.filter(i => i.type === 'motionGraphic');
const undo = (page: Page) => page.getByRole('button', { name: 'Undo' }).first().click();

/** The panel's region, opened from the wide rail or the compact bottom tab. */
async function openPanel(page: Page, compact: boolean) {
  if (compact) {
    await page.getByRole('navigation', { name: 'Editor panels' }).getByRole('tab', { name: 'Motion', exact: true }).click();
    return page.getByRole('dialog', { name: 'Motion' }).getByRole('region', { name: 'Motion graphics' });
  }
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Motion graphics', exact: true }).click();
  return page.getByRole('complementary', { name: 'Inspector and tools' }).getByRole('region', { name: 'Motion graphics' });
}
const fields = (panel: ReturnType<Page['locator']>) => ({
  start: panel.getByRole('spinbutton', { name: 'Start' }), end: panel.getByRole('spinbutton', { name: 'End' }), add: panel.getByRole('button', { name: 'Add Blank Motion Graphic' }),
});

const PRESET = { id: 'pre1', name: 'Lower third', mg_code: 'export const Lt = () => <AbsoluteFill style={{ backgroundColor: "#00ff00" }} />;', spatial: { x: 0, y: 0, width: 1080, height: 1920 }, duration_ms: 3000 };
/** Writes the user's presets row (or removes it) before the panel mounts. */
const setPresetsRow = (page: Page, presets: unknown[] | null) => page.evaluate(async presets => {
  const p = '/src/store/database.ts', { projectStore } = await import(p);
  if (presets === null) await projectStore.deleteRow('settings', 'mg-presets'); else await projectStore.putRow('settings', { id: 'mg-presets', presets });
}, presets);
/** Away to another rail tab and back, so the panel mounts again and reads the row. */
async function reopenPanel(page: Page) {
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Shapes', exact: true }).click();
  return openPanel(page, false);
}

test.describe('wide layout (1280 x 800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the panel content: heading, info icon, My Presets (0), No presets yet., Add Blank with Start 0 / End 5 (min 0, step 0.1), the button, and no code or prompt field', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel');
    const panel = await openPanel(page, false);
    await expect(panel.getByRole('heading', { name: /^Motion graphics/, level: 3 })).toBeVisible();
    const info = panel.getByRole('img', { name: 'About motion graphics' });
    await expect(info).toBeVisible();
    await expect(info).toHaveAttribute('title', 'Motion graphics are written by the AI agent. Add a blank one here, or one of your presets.');
    await expect(panel.getByText('My Presets (0)', { exact: true })).toBeVisible();
    await expect(panel.getByText('No presets yet.', { exact: true })).toBeVisible();
    const group = panel.getByRole('group', { name: 'Add Blank' });
    await expect(group).toBeVisible();
    const f = fields(panel);
    for (const [input, value] of [[f.start, '0'], [f.end, '5']] as const) {
      await expect(group.getByRole('spinbutton', { name: input === f.start ? 'Start' : 'End' })).toHaveValue(value);
      await expect(input).toHaveAttribute('type', 'number'); await expect(input).toHaveAttribute('min', '0'); await expect(input).toHaveAttribute('step', '0.1');
    }
    await expect(f.add).toBeVisible(); await expect(f.add).toBeEnabled();
    await expect(panel.locator('textarea')).toHaveCount(0);
    await expect(panel.getByRole('textbox')).toHaveCount(0);
    await expect(panel.getByText(/prompt|code/i)).toHaveCount(0);
  });

  test('I1: opening the tab dispatches no intent and changes nothing', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel i1');
    await watchIntents(page);
    const before = await liveDoc(page);
    await openPanel(page, false);
    expect(await intents(page)).toEqual([]);
    expect(await liveDoc(page)).toEqual(before);
  });

  test('Start 1.5, End 4, Add: toast "Motion graphic added", one blank graphic on a new overlay track covering the canvas, no stage note; Undo removes it and the track', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel add');
    await watchIntents(page);
    const before = await liveDoc(page);
    const panel = await openPanel(page, false), f = fields(panel);
    await f.start.fill('1.5'); await f.end.fill('4');
    await f.add.click();
    await expect(notices(page)).toContainText('Motion graphic added');
    const doc = await liveDoc(page), [g] = doc.items.filter(i => i.type === 'motionGraphic');
    expect(doc.items.filter(i => i.type === 'motionGraphic')).toHaveLength(1);
    expect(g).toMatchObject({ display: { from: 1500, to: 4000 }, trim: { from: 0, to: 2500 }, sourceDuration: 2500, details: { name: 'Motion graphic' }, metadata: {} });
    expect('code' in g.details).toBe(false);
    expect(g.properties).toMatchObject({ positionX: { defaultValue: 0 }, positionY: { defaultValue: 0 }, width: { defaultValue: doc.size.width }, height: { defaultValue: doc.size.height }, scale: { defaultValue: 1 } });
    expect(doc.tracks).toHaveLength(before.tracks.length + 1);
    expect(doc.tracks.find(t => t.id === g.trackId)).toMatchObject({ kind: 'overlay' });
    expect(before.tracks.map(t => t.id)).not.toContain(g.trackId);
    expect(doc.items.filter(i => i.type !== 'motionGraphic')).toEqual(before.items);
    const log = await intents(page);
    expect(log).toHaveLength(1);
    expect(log[0].intent).toEqual({ type: 'addBlankMotionGraphic', startMs: 1500, endMs: 4000 });
    expect(log[0].outcome).toEqual({ ok: true });
    await expect(page.locator('p.pending-render')).toHaveCount(0);
    await undo(page);
    const after = await liveDoc(page);
    expect(after.items).toEqual(before.items);
    expect(after.tracks).toEqual(before.tracks);
    expect(after.layerOrder).toEqual(before.layerOrder);
  });

  test('an invalid range disables the button and dispatches nothing: End = Start, End < Start, an empty field, a negative Start; a valid range enables it again', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel invalid');
    await watchIntents(page);
    const panel = await openPanel(page, false), f = fields(panel);
    const bad: [string, string][] = [['3', '3'], ['3', '2'], ['0', ''], ['', '5'], ['-1', '5'], ['0', '-2'], ['0', '0']];
    for (const [s, e] of bad) {
      await f.start.fill(s); await f.end.fill(e);
      await expect(f.add, `Start "${s}" End "${e}"`).toBeDisabled();
      await f.add.click({ force: true, noWaitAfter: true }).catch(() => undefined); // a disabled button takes the click and does nothing
    }
    expect(await intents(page)).toEqual([]);
    expect(await graphics(page)).toEqual([]);
    await f.start.fill('0.5'); await f.end.fill('0.6');
    await expect(f.add).toBeEnabled();
    await clearIntents(page);
  });

  test('My Presets: with no settings row the list is empty ("My Presets (0)", "No presets yet.")', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel no presets');
    await setPresetsRow(page, null);
    const panel = await reopenPanel(page);
    await expect(panel.getByText('My Presets (0)', { exact: true })).toBeVisible();
    await expect(panel.getByText('No presets yet.', { exact: true })).toBeVisible();
    await expect(panel.getByRole('list')).toHaveCount(0);
  });

  test('My Presets: a row with one valid and one invalid preset lists only the valid one; clicking it adds it, toast "Applied "<name>" — 1 item(s)"', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel presets');
    await setPresetsRow(page, [PRESET, { id: 'bad', name: 'No code' }]);
    await watchIntents(page);
    const panel = await reopenPanel(page), before = await liveDoc(page);
    await expect(panel.getByText('My Presets (1)', { exact: true })).toBeVisible();
    await expect(panel.getByText('No presets yet.')).toHaveCount(0);
    const list = panel.getByRole('list', { name: 'My Presets (1)' });
    await expect(list.getByRole('button')).toHaveText(['Lower third']);
    await expect(panel.getByRole('button', { name: 'No code' })).toHaveCount(0);
    expect(await intents(page)).toEqual([]);
    await list.getByRole('button', { name: 'Lower third' }).click();
    await expect(notices(page)).toContainText('Applied "Lower third" — 1 item(s)');
    const doc = await liveDoc(page), gs = doc.items.filter(i => i.type === 'motionGraphic');
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ display: { from: 0, to: 3000 }, trim: { from: 0, to: 3000 }, sourceDuration: 3000, playbackRate: 1, details: { name: 'Lower third', code: PRESET.mg_code }, metadata: { presetId: 'pre1' }, masks: [], effects: [] });
    expect(gs[0].properties).toMatchObject({ positionX: { defaultValue: 0 }, positionY: { defaultValue: 0 }, width: { defaultValue: doc.size.width }, height: { defaultValue: doc.size.height }, scale: { defaultValue: 1 } });
    expect(doc.tracks).toHaveLength(before.tracks.length + 1);
    expect(doc.tracks.find(t => t.id === gs[0].trackId)).toMatchObject({ kind: 'overlay' });
    const log = await intents(page);
    expect(log).toHaveLength(1);
    expect(log[0].intent.type).toBe('addGraphicPreset');
    expect(log[0].intent.preset).toMatchObject({ id: 'pre1', name: 'Lower third', duration_ms: 3000 });
    expect(log[0].outcome).toEqual({ ok: true });
    await undo(page);
    const after = await liveDoc(page);
    expect(after.items).toEqual(before.items);
    expect(after.tracks).toEqual(before.tracks);
  });

  test('two adds make two graphics on two new tracks', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel twice');
    const panel = await openPanel(page, false), f = fields(panel), before = await liveDoc(page);
    await f.add.click(); await f.add.click();
    const doc = await liveDoc(page), gs = doc.items.filter(i => i.type === 'motionGraphic');
    expect(gs).toHaveLength(2);
    expect(new Set(gs.map(g => g.trackId)).size).toBe(2);
    expect(doc.tracks).toHaveLength(before.tracks.length + 2);
    expect(gs.map(g => g.display)).toEqual([{ from: 0, to: 5000 }, { from: 0, to: 5000 }]);
  });
});

test.describe('compact layout (1023 x 800)', () => {
  test.use({ viewport: { width: 1023, height: 800 } });

  test('the Motion bottom tab opens a drawer with the same panel, and Add works there', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel compact');
    await watchIntents(page);
    const panel = await openPanel(page, true), f = fields(panel);
    await expect(panel.getByRole('heading', { name: /^Motion graphics/, level: 3 })).toBeVisible();
    await expect(panel.getByRole('img', { name: 'About motion graphics' })).toBeVisible();
    await expect(panel.getByText('My Presets (0)', { exact: true })).toBeVisible();
    await expect(panel.getByText('No presets yet.', { exact: true })).toBeVisible();
    await expect(f.start).toHaveValue('0'); await expect(f.end).toHaveValue('5');
    await expect(panel.locator('textarea')).toHaveCount(0);
    expect(await intents(page)).toEqual([]);
    await f.start.fill('1.5'); await f.end.fill('4');
    await f.add.click();
    await expect(notices(page)).toContainText('Motion graphic added');
    const gs = await graphics(page);
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ display: { from: 1500, to: 4000 } });
    const log = await intents(page);
    expect(log.map(l => l.intent)).toEqual([{ type: 'addBlankMotionGraphic', startMs: 1500, endMs: 4000 }]);
  });

  test('an invalid range disables the button in the drawer too', async ({ page }) => {
    await openEditor(page, richDoc(), 'T08 panel compact invalid');
    await watchIntents(page);
    const panel = await openPanel(page, true), f = fields(panel);
    await f.end.fill('0'); await expect(f.add).toBeDisabled();
    await f.end.fill(''); await expect(f.add).toBeDisabled();
    await f.end.fill('2'); await f.start.fill('-1'); await expect(f.add).toBeDisabled();
    expect(await intents(page)).toEqual([]);
  });
});
