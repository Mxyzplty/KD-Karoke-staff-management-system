// SPDX-License-Identifier: AGPL-3.0-only
// T28 round 2 (review finding 2, lane A's ruling 15 Nov): after a plain wheel zoom the shape path editor's screen px rules follow the new zoom.
// The editor sizes its point markers (5 screen px half-side, 10 across) and its close snap (8 screen px from the first point) from px = canvas width ÷ the svg's
// screen width; a wheel zoom changes only the stage's transform and data-scale, never its layout size. Pen Tool, no resize. Screen px throughout.
import { test, expect, type Page } from '@playwright/test';
import { openEditor, skipTour } from './t02-support';

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => { test.setTimeout(120_000); await skipTour(page); });

type Pt = { x: number; y: number };
const trk = (id: string, kind: string) => ({ id, name: id.toUpperCase(), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
const TRACKS = [trk('v1', 'video'), trk('o1', 'overlay')];
const p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
/** One image (no asset) on o1 for 0..6000 ms: a closed pen path makes a shape only when the timeline has an item (W3-RT-08 fixture 1, t06-shapes.spec.ts l.90-95). */
const IMAGE = { id: 'img', type: 'image', trackId: 'o1', display: { from: 0, to: 6000 }, trim: { from: 0, to: 6000 }, details: { name: 'img' }, masks: [], effects: [],
  properties: { positionX: p(0), positionY: p(0), width: p(200), height: p(200), scale: p(1), rotation: p(0), opacity: p(1) } };
const DOC = {
  schemaVersion: 4, rev: 0, groups: {}, duration: 6000, fps: 30, size: { width: 1080, height: 1920 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: TRACKS, layerOrder: TRACKS.map(t => ({ type: 'track', id: t.id })), items: [IMAGE],
};
const stage = (page: Page) => page.locator('.stage');
const drawing = (page: Page) => page.locator('svg[aria-label="Shape drawing area"]');
const markers = (page: Page) => drawing(page).locator('rect');
const pathEditor = (page: Page) => page.locator('svg[aria-label="Shape path editor"]');
const pen = (page: Page) => page.evaluate(async () => { const m = '/src/editor/shape-ui.tsx'; (await import(m)).useShapeUi.setState({ mode: { kind: 'pen' }, editing: null }); });
const centre = async (page: Page): Promise<Pt> => { const b = (await stage(page).boundingBox())!; return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; };
/** Opens at fit, starts the Pen Tool and wheels `steps` times by deltaY at the stage centre; waits for data-scale = factor (zoom ÷ fit). */
async function zoomed(page: Page, steps: number, deltaY: number, factor: number) {
  await openEditor(page, DOC); await expect(stage(page)).toHaveAttribute('data-scale', '1'); await pen(page); await expect(drawing(page)).toBeVisible();
  const c = await centre(page); await page.mouse.move(c.x, c.y);
  for (let n = 0; n < steps; n++) await page.mouse.wheel(0, deltaY);
  await expect.poll(async () => Number(await stage(page).getAttribute('data-scale')), { message: `zoom ÷ fit = ${factor}` }).toBeCloseTo(factor, 2);
  return c;
}
const click = (page: Page, p: Pt) => page.mouse.click(p.x, p.y);
/** Every marker's on-screen width, once React has re-rendered at the new px. */
const markerWidths = (page: Page) => markers(page).evaluateAll(els => els.map(e => e.getBoundingClientRect().width));

test.describe('T28 round 2: the shape path editor\'s screen px after a wheel zoom (pen markers 10 px, close snap 8 px)', () => {
  test('zoomed in 4 wheel steps (1.3^4 = 2.86 x fit): a marker is 10 screen px across; a click 12 px from the first point adds a 4th point, one 6 px away closes the path', async ({ page }) => {
    const a = await zoomed(page, 4, -100, 1.3 ** 4), b = { x: a.x + 40, y: a.y }, c = { x: a.x + 20, y: a.y + 40 };
    await click(page, a); await click(page, b); await click(page, c); await expect(markers(page)).toHaveCount(3);
    // Before the fix px kept the fit's value: markers 2.86 x 10 px, and the snap 2.86 x 8 = 22.8 px, so the 12 px click below would close the path.
    await expect.poll(async () => (await markerWidths(page)).map(w => Math.abs(w - 10)).reduce((m, d) => Math.max(m, d), 0), { message: 'markers 10 screen px +/- 0.5' }).toBeLessThanOrEqual(0.5);
    await click(page, { x: a.x + 12, y: a.y }); await expect(markers(page), '12 px from the first point: outside the 8 px snap, a 4th point').toHaveCount(4);
    await expect(drawing(page)).toBeVisible(); await expect(pathEditor(page)).toHaveCount(0);
    await click(page, { x: a.x, y: a.y + 6 }); await expect(pathEditor(page), '6 px from the first point: inside the snap, the path closes and path editing opens').toBeVisible();
    await expect(drawing(page)).toHaveCount(0);
  });
  test('zoomed out 1 wheel step (0.7 x fit): a marker is 10 screen px across and a click 7 px from the first point still closes the path', async ({ page }) => {
    const a = await zoomed(page, 1, 100, 0.7), b = { x: a.x + 40, y: a.y }, c = { x: a.x + 20, y: a.y + 40 };
    await click(page, a); await click(page, b); await click(page, c); await expect(markers(page)).toHaveCount(3);
    // Before the fix the markers were 0.7 x 10 = 7 px and the snap 0.7 x 8 = 5.6 px, so this 7 px click added a 4th point instead.
    await expect.poll(async () => (await markerWidths(page)).map(w => Math.abs(w - 10)).reduce((m, d) => Math.max(m, d), 0), { message: 'markers 10 screen px +/- 0.5' }).toBeLessThanOrEqual(0.5);
    await click(page, { x: a.x + 7, y: a.y }); await expect(pathEditor(page), '7 px from the first point closes the path').toBeVisible();
  });
});
