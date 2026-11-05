// SPDX-License-Identifier: AGPL-3.0-only
// T13 inspector: the Fade in / Fade out buttons (two volume keyframes each, one "Edit items" step) and the Keep pitch switch (off by default, stored on the item).
// Oracle: the T13 ticket (fade = 0 at the clip edge, the current value 1 s inside; keep pitch a per-clip switch in the Speed section; audio inspector Speed + Volume,
// video inspector Basic + "Speed & Time Remap"). Logic below the UI is in tests/t13-edits.test.ts.
import { expect, test, type Page } from '@playwright/test';
import { openEditor, skipTour, stored } from './t02-support';
import { seekMs } from './t15-support';

test.setTimeout(60_000);
test.use({ viewport: { width: 1280, height: 800 } });
test.beforeEach(async ({ page }) => { await skipTour(page); });

const track = (id: string, name: string, kind: string) => ({ id, name, kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
const doc = () => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 8000, fps: 30, size: { width: 1280, height: 720 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: [track('a1', 'A1', 'audio'), track('v1', 'V1', 'video')], layerOrder: [{ type: 'track', id: 'a1' }, { type: 'track', id: 'v1' }],
  items: [
    { id: 'aud', type: 'audio', trackId: 'a1', display: { from: 0, to: 8000 }, trim: { from: 0, to: 8000 }, sourceDuration: 8000, playbackRate: 1, details: { name: 'Sound' }, metadata: {}, properties: {}, masks: [], effects: [] },
    { id: 'vid', type: 'video', trackId: 'v1', display: { from: 0, to: 8000 }, trim: { from: 0, to: 8000 }, sourceDuration: 8000, playbackRate: 1, details: { name: 'Picture' }, metadata: {}, properties: {}, masks: [], effects: [] },
  ],
});
const inspector = (page: Page) => page.getByRole('region', { name: 'Inspector' });
const section = (page: Page, title: string) => inspector(page).locator('details.inspector-section').filter({ has: page.locator('summary', { hasText: new RegExp(`^${title}$`) }) });
async function openSection(page: Page, title: string) {
  const s = section(page, title); await expect(s).toBeVisible();
  if (!(await s.evaluate(el => (el as HTMLDetailsElement).open))) await s.locator('summary').click();
  await expect(s).toHaveJSProperty('open', true);
  return s;
}
async function select(page: Page, id: string) {
  await page.evaluate(async id => { const p = '/src/editor/view.ts'; (await import(p)).select([id]); }, id);
  await expect(inspector(page).locator('details.inspector-section > summary').first()).toBeVisible();
}
const live = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/editor.tsx'; return JSON.parse(JSON.stringify((await import(p)).activeSession.document.items.find((i: any) => i.id === id))); }, id) as Promise<any>;
const volumeKeys = async (page: Page, id: string) => ((await live(page, id)).properties?.volume?.keyframes ?? []).map((k: any) => [k.time, k.value]).sort((a: number[], b: number[]) => a[0] - b[0]) as number[][];
const undoStack = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; return (await import(p)).activeRuntime.bus.undoStack.map((e: any) => ({ label: e.label, source: e.source })); }) as Promise<{ label: string; source: string }[]>;
const EDIT = { label: 'Edit items', source: 'user' };
const undoNow = (page: Page) => page.evaluate(async () => { const p = '/src/editor/commands.ts'; (await import(p)).dispatch({ type: 'undo' }); });

test('audio clip: sections are Speed and Volume; Volume holds the Fade in / Fade out buttons', async ({ page }) => {
  const id = await openEditor(page, doc(), 'T13 inspector'); void id;
  await select(page, 'aud');
  await expect(inspector(page).locator('details.inspector-section > summary')).toHaveText(['Speed', 'Volume']);
  const vol = await openSection(page, 'Volume');
  await expect(vol.getByRole('button', { name: 'Fade in', exact: true })).toBeVisible(); await expect(vol.getByRole('button', { name: 'Fade out', exact: true })).toBeVisible();
  expect(await volumeKeys(page, 'aud')).toEqual([]);
});

test('Fade in then Fade out on an audio clip: two keyframes each, one "Edit items" step per press, undo restores, the diamond at the playhead shows the edge keyframe', async ({ page }) => {
  await openEditor(page, doc(), 'T13 inspector');
  await seekMs(page, 0); await select(page, 'aud');
  const vol = await openSection(page, 'Volume');
  await vol.getByRole('button', { name: 'Fade in', exact: true }).click();
  await expect.poll(() => volumeKeys(page, 'aud')).toEqual([[0, 0], [1000, 1]]);
  expect(await undoStack(page)).toEqual([EDIT]);
  await expect(vol.getByRole('button', { name: 'Volume keyframe at playhead' })).toBeVisible(); // playhead 0 sits on the 0 keyframe
  await vol.getByRole('button', { name: 'Fade out', exact: true }).click();
  await expect.poll(() => volumeKeys(page, 'aud')).toEqual([[0, 0], [1000, 1], [7000, 1], [8000, 0]]);
  expect(await undoStack(page)).toEqual([EDIT, EDIT]);
  await undoNow(page); await expect.poll(() => volumeKeys(page, 'aud')).toEqual([[0, 0], [1000, 1]]);
  await undoNow(page); await expect.poll(() => volumeKeys(page, 'aud')).toEqual([]);
  // the edit reaches the store
  await vol.getByRole('button', { name: 'Fade in', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved locally');
  const s = await stored(page, await page.evaluate(() => location.pathname.split('/').pop()!));
  expect(JSON.parse(s.json).items.find((i: any) => i.id === 'aud').properties.volume.keyframes).toHaveLength(2);
});

test('Keep pitch on an audio clip: a switch in Speed, off by default, on after a click and stored on the item, off again after a second click', async ({ page }) => {
  await openEditor(page, doc(), 'T13 inspector');
  await select(page, 'aud');
  const speed = await openSection(page, 'Speed'), sw = speed.getByRole('switch', { name: 'Keep pitch' });
  await expect(sw).toBeVisible(); await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect((await live(page, 'aud')).keepPitch).toBeUndefined();
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true'); expect((await live(page, 'aud')).keepPitch).toBe(true);
  expect(await undoStack(page)).toEqual([EDIT]);
  await expect(page.getByRole('status')).toHaveText('Saved locally');
  const id = await page.evaluate(() => location.pathname.split('/').pop()!);
  expect(JSON.parse((await stored(page, id)).json).items.find((i: any) => i.id === 'aud').keepPitch).toBe(true);
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false'); expect('keepPitch' in (await live(page, 'aud'))).toBe(false);
  expect(await undoStack(page)).toEqual([EDIT, EDIT]);
  await undoNow(page); await expect(sw).toHaveAttribute('aria-checked', 'true');
});

test('the switch state follows the selected clip (a second audio clip starts off)', async ({ page }) => {
  const d = doc(); d.items.push({ ...d.items[0], id: 'aud2', display: { from: 0, to: 4000 }, details: { name: 'Sound 2' }, keepPitch: true } as any);
  await openEditor(page, d, 'T13 inspector');
  await select(page, 'aud2'); const speed = await openSection(page, 'Speed');
  await expect(speed.getByRole('switch', { name: 'Keep pitch' })).toHaveAttribute('aria-checked', 'true');
  await select(page, 'aud'); await expect(section(page, 'Speed').getByRole('switch', { name: 'Keep pitch' })).toHaveAttribute('aria-checked', 'false');
});

test('video clip: Basic has Fade in / Fade out, "Speed & Time Remap" has the Keep pitch switch, and both write to the video item', async ({ page }) => {
  await openEditor(page, doc(), 'T13 inspector');
  await seekMs(page, 0); await select(page, 'vid');
  const titles = await inspector(page).locator('details.inspector-section > summary').allTextContents();
  expect(titles).toContain('Basic'); expect(titles).toContain('Speed & Time Remap');
  const basic = await openSection(page, 'Basic');
  await expect(basic.getByRole('button', { name: 'Fade in', exact: true })).toBeVisible(); await expect(basic.getByRole('button', { name: 'Fade out', exact: true })).toBeVisible();
  await basic.getByRole('button', { name: 'Fade out', exact: true }).click();
  await expect.poll(() => volumeKeys(page, 'vid')).toEqual([[7000, 1], [8000, 0]]);
  expect(await undoStack(page)).toEqual([EDIT]);
  const speed = await openSection(page, 'Speed & Time Remap'), sw = speed.getByRole('switch', { name: 'Keep pitch' });
  await expect(sw).toHaveAttribute('aria-checked', 'false'); await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true'); expect((await live(page, 'vid')).keepPitch).toBe(true);
  expect(await undoStack(page)).toEqual([EDIT, EDIT]);
});

test('a locked track: Fade in and Keep pitch are refused with a notice and change nothing', async ({ page }) => {
  const d = doc(); (d.tracks[0] as any).locked = true;
  await openEditor(page, d, 'T13 inspector');
  await select(page, 'aud');
  const vol = await openSection(page, 'Volume'); await vol.getByRole('button', { name: 'Fade in', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('TRACK_LOCKED');
  const speed = await openSection(page, 'Speed'); await speed.getByRole('switch', { name: 'Keep pitch' }).click();
  expect(await volumeKeys(page, 'aud')).toEqual([]); expect((await live(page, 'aud')).keepPitch).toBeUndefined(); expect(await undoStack(page)).toEqual([]);
});
