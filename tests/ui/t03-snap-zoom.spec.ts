// SPDX-License-Identifier: AGPL-3.0-only
// T03 acceptance (ticket T03, fixtures 8-9 and W3-RT-11): scripted snapping drags at three zooms against cuts, the playhead and markers,
// and the zoom / scroll rule after a REAL trim. Snap reach is 8 / sqrt(2) px = 5.66 px at every zoom, so one pixel layout is scaled per zoom.
// Expected values are the oracle's rules (target +/- 1 frame, one "Move item" entry on release, none during the drag), not source output.
import { test, expect, type Page } from '@playwright/test';
import { clearIntents, clip, intents, openEditor, richDoc, setViewState, skipTour, viewState, watchIntents } from './t02-support';
import { itemById, liveDoc, savedDoc, undoEntries } from './t03-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

const FRAME = 1000 / 30;
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Timeline' });
const geometry = (page: Page) => viewState(page, v => ({ zoom: v.zoom as number, scroll: v.scroll as number, laneWidth: v.laneWidth as number }));
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, hold?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + dx / 2, from.y, { steps: 8 }); await page.mouse.move(from.x + dx, from.y, { steps: 8 });
  if (hold) await hold();
  await page.mouse.up();
}
const centre = async (locator: ReturnType<Page['locator']>) => { const b = (await locator.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const norev = (d: any) => ({ ...d, rev: 0 });

const vtrack = (id: string) => ({ id, name: id.toUpperCase(), kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1 });
const vclip = (id: string, trackId: string, from: number, to: number) => ({ id, type: 'video', trackId, display: { from, to }, trim: { from: 0, to: to - from }, sourceDuration: to - from, details: { name: id } });

/** Pixel layout (lane-relative): dragMe 100-250 on v2; v1 holds a 500-700 and b 700-950 (cut 700, edges 500 and 950); marker 820; playhead 400. */
const scene = (z: number) => {
  const ms = (px: number) => Math.round(px / z);
  return richDoc({
    duration: ms(1000), tracks: [vtrack('v1'), vtrack('v2')], layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'v2' }],
    items: [vclip('dragMe', 'v2', ms(100), ms(250)), vclip('a', 'v1', ms(500), ms(700)), vclip('b', 'v1', ms(700), ms(950))], markers: [{ id: 'mk', timeMs: ms(820) }],
  });
};
type Case = { name: string; edge: 'start' | 'end'; px: number; off: number };
const CASES: Case[] = [
  { name: 'start to the playhead', edge: 'start', px: 400, off: 3 }, { name: 'start to the cut', edge: 'start', px: 700, off: -3 }, { name: 'start to the marker', edge: 'start', px: 820, off: 3 },
  { name: 'end to the cut', edge: 'end', px: 700, off: 3 }, { name: 'end to the marker', edge: 'end', px: 820, off: -3 }, { name: 'end to a clip start', edge: 'end', px: 500, off: -3 }, { name: 'end to a clip end', edge: 'end', px: 950, off: 3 },
];

for (const z of [0.05, 0.1, 0.2]) {
  test(`snapping at zoom ${z}: 7 drags release on the target (+/- 1 frame) as one "Move item"; 2 out-of-reach drags keep the raw delta; undo after each`, async ({ page }) => {
    const id = await openEditor(page, scene(z)); await watchIntents(page); const ms = (px: number) => Math.round(px / z);
    await setViewState(page, { zoom: z, scroll: 0, playheadMs: ms(400) }); expect((await geometry(page)).zoom).toBe(z);
    const original = await liveDoc(page), origFrom = ms(100), origTo = ms(250), len = origTo - origFrom;
    const settle = async () => { await expect(page.locator('.snap-line')).toHaveCount(0); };
    const afterRelease = async (): Promise<any> => {
      await settle(); expect(await undoEntries(page)).toEqual([{ label: 'Move item', source: 'user' }]);
      const l = (await intents(page)).at(-1)!; expect(l.intent.type).toBe('moveItems'); expect(l.intent).toMatchObject({ itemIds: ['dragMe'], trackId: null, newTrack: false, ripple: false }); expect(l.outcome).toEqual({ ok: true });
      return { l, doc: await liveDoc(page) };
    };
    const undo = async () => { await page.keyboard.press('Control+Z'); expect(await undoEntries(page)).toEqual([]); expect(norev(await liveDoc(page))).toEqual(norev(original)); };
    let first = true;
    for (const c of CASES) {
      await clearIntents(page); const target = ms(c.px), shiftPx = c.edge === 'start' ? c.px - 100 : c.px - 250, start = await centre(clip(page, 'dragMe'));
      await dragBy(page, start, shiftPx + c.off, async () => { await expect(page.locator('.snap-line'), c.name).toHaveAttribute('data-snap-ms', String(target)); expect(await undoEntries(page), `${c.name}: nothing is undoable during the drag`).toEqual([]); });
      const { l, doc } = await afterRelease(); const it = itemById(doc, 'dragMe');
      if (c.edge === 'start') expect(Math.abs(it.display.from - target), `${c.name}: start`).toBeLessThanOrEqual(FRAME); else expect(Math.abs(it.display.to - target), `${c.name}: end`).toBeLessThanOrEqual(FRAME);
      expect(it.display.to - it.display.from, `${c.name}: length kept`).toBeCloseTo(len, -1); expect(Math.abs(l.intent.deltaMs - ((c.edge === 'start' ? target - origFrom : target - origTo))), `${c.name}: intent delta`).toBeLessThanOrEqual(FRAME);
      if (first) { const saved = await savedDoc(page, id); expect(itemById(saved, 'dragMe').display).toEqual(it.display); first = false; } // the move is autosaved
      await undo();
    }
    // Out of reach: 14 px from the cut (reach is 5.66 px) and a stretch with no target at all - raw delta, no highlight line.
    for (const dx of [490, 614]) {
      await clearIntents(page); await dragBy(page, await centre(clip(page, 'dragMe')), dx, async () => { await expect(page.locator('.snap-line'), `dx ${dx}`).toHaveCount(0); });
      const { l, doc } = await afterRelease(); expect(Math.abs(l.intent.deltaMs - dx / z), `dx ${dx} raw delta`).toBeLessThanOrEqual(FRAME); expect(Math.abs(itemById(doc, 'dragMe').display.from - (origFrom + dx / z))).toBeLessThanOrEqual(FRAME);
      await undo();
    }
    await expect.poll(async () => (await intents(page)).filter(i => i.outcome.ok === false)).toEqual([]); // no refused intent anywhere in the 9 drags
  });
}

const longDoc = () => richDoc({ duration: 45000, tracks: [vtrack('v1')], layerOrder: [{ type: 'track', id: 'v1' }], items: [{ ...vclip('long', 'v1', 0, 45000), sourceDuration: 45000 }], markers: [] });

test('W3-RT-11 through a REAL trim: at zoom fit x 1.25^3 trimming the end by 5 s keeps the zoom, shortens the content by 5 s x zoom and clamps the scroll', async ({ page }) => {
  const id = await openEditor(page, longDoc()); const bar = toolbar(page); await bar.getByRole('button', { name: 'Zoom to fit', exact: true }).click();
  let g = await geometry(page); const fit = (g.laneWidth - 32) / 47000; expect(g.zoom).toBeCloseTo(fit, 12);
  for (let n = 0; n < 3; n++) await bar.getByRole('button', { name: 'Zoom in', exact: true }).click();
  g = await geometry(page); expect(g.zoom / fit).toBeCloseTo(1.25 ** 3, 9);
  const lanes = page.locator('.ruler-lanes'), widthOf = async () => (await lanes.evaluate(el => el.getBoundingClientRect().width)), before = await widthOf(); expect(before).toBeCloseTo(47000 * g.zoom, 1);
  await page.locator('.timeline-scroll').evaluate(el => { el.scrollLeft = 1e7; }); await expect.poll(async () => (await geometry(page)).scroll).toBeGreaterThan(0);
  const scrolled = (await geometry(page)).scroll; expect(scrolled).toBeCloseTo(47000 * g.zoom - g.laneWidth, 0);
  await clip(page, 'long').click(); await watchIntents(page); await dragBy(page, await centre(clip(page, 'long').locator('.trim-end')), -5000 * g.zoom);
  const l = (await intents(page)).at(-1)!; expect(l.intent).toMatchObject({ type: 'trimItem', itemId: 'long', edge: 'end', ripple: false }); expect(l.outcome).toEqual({ ok: true }); expect(Math.abs(l.intent.deltaMs + 5000)).toBeLessThanOrEqual(FRAME);
  const doc = await liveDoc(page); expect(Math.abs(itemById(doc, 'long').display.to - 40000)).toBeLessThanOrEqual(FRAME); expect(doc.duration).toBe(itemById(doc, 'long').display.to); // the project follows the clip
  expect(await undoEntries(page)).toEqual([{ label: 'Edit items', source: 'user' }]);
  await expect.poll(async () => Math.round(await widthOf())).toBe(Math.round((doc.duration + 2000) * g.zoom));
  const after = await geometry(page); expect(Math.abs(after.zoom - g.zoom), 'zoom unchanged by a shortening edit').toBeLessThan(1e-9);
  expect(before - (await widthOf())).toBeCloseTo((45000 - doc.duration) * g.zoom, 0); expect(after.scroll).toBeCloseTo((doc.duration + 2000) * g.zoom - g.laneWidth, 0); expect(after.scroll).toBeLessThan(scrolled);
  await expect.poll(() => page.locator('.timeline-scroll').evaluate(el => el.scrollLeft)).toBeCloseTo(after.scroll, 0);
  const saved = await savedDoc(page, id); expect(saved.duration).toBe(doc.duration);
});

test('W3-RT-11 through a REAL trim: at zoom fit a trim that shortens the project raises the zoom to the new fit; undo restores the clip', async ({ page }) => {
  await openEditor(page, longDoc()); await toolbar(page).getByRole('button', { name: 'Zoom to fit', exact: true }).click(); const original = await liveDoc(page);
  const g = await geometry(page); expect(g.zoom).toBeCloseTo((g.laneWidth - 32) / 47000, 12);
  await clip(page, 'long').click(); await dragBy(page, await centre(clip(page, 'long').locator('.trim-end')), -30000 * g.zoom);
  const doc = await liveDoc(page); expect(Math.abs(itemById(doc, 'long').display.to - 15000)).toBeLessThanOrEqual(FRAME);
  expect(await undoEntries(page)).toEqual([{ label: 'Edit items', source: 'user' }]);
  await expect.poll(async () => (await geometry(page)).zoom).toBeCloseTo((g.laneWidth - 32) / (doc.duration + 2000), 9); // fit is the minimum, so the zoom rises to the new fit
  expect((await geometry(page)).scroll).toBe(0);
  await page.keyboard.press('Control+Z'); expect(await undoEntries(page)).toEqual([]); expect(norev(await liveDoc(page))).toEqual(norev(original));
});
