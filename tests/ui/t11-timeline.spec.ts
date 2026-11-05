// SPDX-License-Identifier: AGPL-3.0-only
// T11 Transitions, timeline UI (tickets l.153, wave-3 fixtures 1–7). Oracle: findings part 3 §46.8 (the diamond on a cut, the marker, the popover's
// kinds / directions / Align, the edge drag), part 5 §55.1 (defaults fade, 1000 ms, alignment 0.5; 100 ms floor, 3000 ms cap) and §55.6 (stored
// record). Labels "Add transition" / "Edit transition" / "Remove transition" are the contracted undo labels; the UI never writes "Change transition".
// Own, not from the doc (T11 notes, labelled): the diamond only on video / image pairs of one track, the 16 px minimum width of an openable marker,
// the arrow names (From left / From right / From top / From bottom), and the edge drag's length rule (d0 ± the drag distance, cap 3000, floor 100).
// Fixture numbers (tickets l.153): (1) diamonds, (2) popover picks, (3) Align, (4) edge drags, (5) trash, (6) a cut with no source handles (images only here),
// (7) the UI never writes "Change transition". Group headings, the Dip colour control and the Wipe softness slider are own UI ("documented improvement", §46.8).
// One page per test; image clips only (no media decoding). Zoom 0.1 px/ms, so 1 px = 10 ms and the drag tolerance "±1 px" is ±10 ms.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { openEditor, richDoc, setViewState, skipTour } from './t02-support';
import { liveDoc, undoEntries } from './t03-support';

test.describe.configure({ mode: 'parallel' });
test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1400, height: 900 }); });

const ZOOM = 0.1, MS_PER_PX = 1 / ZOOM;
const img = (id: string, trackId: string, from: number, to: number) => ({ id, type: 'image', trackId, display: { from, to }, trim: { from: 0, to: to - from }, details: { name: id } });
/** V1: i1 0–20 s | i2 20–50 s | i3 50–90 s. V2: j1 20–30 s | j2 30–40 s (a second same-track cut, and a clip that starts where i2 does on another track). */
const doc = () => richDoc({
  duration: 90000, markers: [],
  items: [img('i1', 'v1', 0, 20000), img('i2', 'v1', 20000, 50000), img('i3', 'v1', 50000, 90000), img('j1', 'v2', 20000, 30000), img('j2', 'v2', 30000, 40000)],
});
async function open(page: Page) {
  await openEditor(page, doc(), 'T11 timeline');
  await expect(page.locator('button.cut-diamond')).toHaveCount(3);
  await setViewState(page, { zoom: ZOOM });
}
const scrollTo = async (page: Page, ms: number) => { await setViewState(page, { scroll: Math.max(0, ms * ZOOM - 250) }); await page.waitForTimeout(50); };
const transitions = async (page: Page) => (await liveDoc(page)).transitions as Record<string, any>[];
const labels = async (page: Page) => (await undoEntries(page)).map(e => e.label);
const diamond = (page: Page, cut: string) => page.locator(`button.cut-diamond[data-cut="${cut}"]`);
const marker = (page: Page) => page.locator('.transition-marker');
const popover = (page: Page) => page.getByRole('dialog', { name: 'Transition' });
/** Adds the fade on i1 → i2 through the diamond and opens its popover. */
async function addAndOpen(page: Page) {
  await open(page); await scrollTo(page, 20000);
  await diamond(page, 'i1:i2').click();
  await expect(marker(page)).toHaveCount(1);
  await marker(page).locator('button.transition-open').click();
  await expect(popover(page)).toBeVisible();
}
const pick = (page: Page, name: string, exact = true) => popover(page).getByRole('button', { name, exact }).click();

test('(1) diamonds sit on each same-track cut of two video / image clips, none across tracks, and one leaves once its transition is added', async ({ page }) => {
  await open(page);
  const cuts = await page.locator('button.cut-diamond').evaluateAll(els => els.map(e => e.getAttribute('data-cut')));
  expect(cuts.sort()).toEqual(['i1:i2', 'i2:i3', 'j1:j2']);
  for (const bad of ['i1:j1', 'i2:j1', 'j2:i3']) await expect(diamond(page, bad)).toHaveCount(0); // across tracks
  await expect(page.locator('button.cut-diamond').first()).toHaveAttribute('aria-label', 'Add transition');
  await scrollTo(page, 20000);
  await diamond(page, 'i1:i2').click();
  await expect(diamond(page, 'i1:i2')).toHaveCount(0);
  await expect(page.locator('button.cut-diamond')).toHaveCount(2);
});

test('(1)(6) the diamond stores one "Add transition": fade, 1000 ms, alignment 0.5, on the pair; (6) a cut without source handles (images only here) is fine and shows no message', async ({ page }) => {
  await open(page); await scrollTo(page, 20000);
  const before = (await undoEntries(page)).length;
  await diamond(page, 'i1:i2').click();
  await expect(marker(page)).toHaveCount(1);
  const t = await transitions(page);
  expect(t).toHaveLength(1);
  expect(t[0]).toMatchObject({ trackId: 'v1', fromId: 'i1', toId: 'i2', kind: 'fade', durationMs: 1000, alignment: 0.5 });
  expect(t[0].id).toMatch(/^transition_[a-z0-9]{10}$/);
  expect(t[0]).not.toHaveProperty('direction');
  const entries = await undoEntries(page);
  expect(entries).toHaveLength(before + 1);
  expect(entries.at(-1)).toMatchObject({ label: 'Add transition' });
  await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('alert')).toHaveCount(0); // no message
  await expect(marker(page)).toHaveAttribute('data-kind', 'fade');
  await expect(marker(page).locator('button.transition-open')).toHaveAttribute('aria-label', 'Fade transition, 1.00s');
});

test('(2)(7) each popover pick is one "Edit transition": the labels store their kinds, Push and Wipe start from-left, the arrows store the four directions, a kind switch resets the direction, other kinds store none', async ({ page }) => {
  await addAndOpen(page);
  // Part 3 §46.8: the kind groups are BASIC / DISSOLVE / MOTION / WIPE, in that order, each holding its labels (Align follows; Direction only for Push and Wipe).
  const groups = popover(page).getByRole('group');
  expect(await groups.evaluateAll(els => els.map(e => e.getAttribute('aria-label')))).toEqual(['BASIC', 'DISSOLVE', 'MOTION', 'WIPE', 'Align']);
  expect(await groups.evaluateAll(els => els.slice(0, 4).map(e => [e.querySelector('small')!.textContent, [...e.querySelectorAll('button')].map(b => b.textContent)])))
    .toEqual([['BASIC', ['Fade']], ['DISSOLVE', ['Cross Dissolve', 'Additive Dissolve', 'Dip To Color']], ['MOTION', ['Push']], ['WIPE', ['Wipe']]]);
  let n = (await undoEntries(page)).length;
  const kindOf = async () => (await transitions(page))[0];
  const step = async (action: () => Promise<unknown>) => { await action(); expect(await labels(page), 'one entry per pick').toHaveLength(++n); expect((await labels(page)).at(-1)).toBe('Edit transition'); };

  for (const [label, kind] of [['Cross Dissolve', 'dissolve'], ['Additive Dissolve', 'additiveDissolve'], ['Dip To Color', 'dipToColorDissolve'], ['Fade', 'fade']] as const) {
    await step(() => pick(page, label));
    const r = await kindOf(); expect(r.kind, label).toBe(kind); expect(r, `${label} stores no direction`).not.toHaveProperty('direction');
    await expect(popover(page).getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(popover(page).getByRole('group', { name: 'Direction' })).toHaveCount(0); // only Push and Wipe have it

  await step(() => pick(page, 'Push'));
  expect(await kindOf()).toMatchObject({ kind: 'slide', direction: 'from-left' });
  const arrows: [string, string][] = [['From right', 'from-right'], ['From top', 'from-top'], ['From bottom', 'from-bottom'], ['From left', 'from-left']];
  for (const [name, dir] of arrows) {
    await step(() => popover(page).getByRole('group', { name: 'Direction' }).getByRole('button', { name, exact: true }).click());
    expect((await kindOf()).direction, name).toBe(dir);
  }
  expect(await popover(page).getByRole('group', { name: 'Direction' }).getByRole('button').allTextContents()).toEqual(['←', '→', '↑', '↓']);

  await step(() => popover(page).getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'From bottom', exact: true }).click());
  await step(() => pick(page, 'Wipe'));
  expect(await kindOf(), 'a kind switch resets the direction to from-left').toMatchObject({ kind: 'wipe', direction: 'from-left' });
  await step(() => popover(page).getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'From top', exact: true }).click());
  expect((await kindOf()).direction).toBe('from-top');
  await step(() => pick(page, 'Cross Dissolve'));
  expect(await kindOf()).not.toHaveProperty('direction');
  await step(() => pick(page, 'Push'));
  expect(await kindOf()).toMatchObject({ kind: 'slide', direction: 'from-left' });

  expect(await labels(page)).not.toContain('Change transition');
  expect(new Set((await labels(page)).slice(1))).toEqual(new Set(['Edit transition']));
  expect((await transitions(page))).toHaveLength(1); // the same record all along
});

test('(3) Align End / Center / Start store 1 / 0.5 / 0, one "Edit transition" each', async ({ page }) => {
  await addAndOpen(page);
  let n = (await undoEntries(page)).length;
  for (const [name, value] of [['End', 1], ['Start', 0], ['Center', 0.5]] as const) {
    await popover(page).getByRole('group', { name: 'Align' }).getByRole('button', { name, exact: true }).click();
    expect((await transitions(page))[0].alignment, name).toBe(value);
    expect(await labels(page)).toHaveLength(++n); expect((await labels(page)).at(-1)).toBe('Edit transition');
    await expect(popover(page).getByRole('group', { name: 'Align' }).getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
});

/** Presses an edge zone, moves by dx px and releases; the pointer is not captured past the window, so the moves are made in steps. */
async function dragEdge(page: Page, zone: Locator, dx: number) {
  const b = (await zone.boundingBox())!, x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 5 }); await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100); // the release is handled by the last render's closure; let React settle before the document is read
}

test('(4)(7) an edge drag of +1 s stores 2000 ms (±1 px), far right 3000, far left 100; one "Edit transition" each', async ({ page }) => {
  await open(page); await scrollTo(page, 20000);
  await diamond(page, 'i1:i2').click(); await expect(marker(page)).toHaveCount(1);
  let n = (await undoEntries(page)).length;
  const end = () => marker(page).locator('.transition-edge-end');
  const dur = async () => (await transitions(page))[0].durationMs as number;
  const tol = 1 * MS_PER_PX;

  await dragEdge(page, end(), 1000 * ZOOM);
  expect(Math.abs((await dur()) - 2000), `got ${await dur()}`).toBeLessThanOrEqual(tol);
  expect(await labels(page)).toHaveLength(++n); expect((await labels(page)).at(-1)).toBe('Edit transition');

  await dragEdge(page, end(), 600);
  expect(await dur()).toBe(3000);
  expect(await labels(page)).toHaveLength(++n); expect((await labels(page)).at(-1)).toBe('Edit transition');

  await dragEdge(page, end(), -400);
  expect(await dur()).toBe(100);
  expect(await labels(page)).toHaveLength(++n); expect((await labels(page)).at(-1)).toBe('Edit transition');

  // A click on an edge without moving writes nothing.
  const b = (await end().boundingBox())!; await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  expect(await labels(page)).toHaveLength(n);
  expect(await labels(page)).not.toContain('Change transition');
});

test('(5)(7) the trash stores one "Remove transition": transitions [] and the diamond returns', async ({ page }) => {
  await addAndOpen(page);
  const n = (await undoEntries(page)).length;
  await popover(page).getByRole('button', { name: 'Remove transition' }).click();
  await expect(marker(page)).toHaveCount(0);
  expect(await transitions(page)).toEqual([]);
  const entries = await undoEntries(page);
  expect(entries).toHaveLength(n + 1); expect(entries.at(-1)).toMatchObject({ label: 'Remove transition' });
  await expect(diamond(page, 'i1:i2')).toHaveCount(1);
  await expect(page.locator('button.cut-diamond')).toHaveCount(3);
  expect(await labels(page)).not.toContain('Change transition');
});

test('own UI: the Dip To Color popover has a colour control; a pick writes params.color [r, g, b] in 0–1 (#336699 → 0.2, 0.4, 0.6) as one "Edit transition"; other kinds do not show it', async ({ page }) => {
  await addAndOpen(page);
  await expect(popover(page).getByLabel('Dip colour')).toHaveCount(0);
  await pick(page, 'Dip To Color');
  const n = (await undoEntries(page)).length;
  await popover(page).getByLabel('Dip colour').fill('#336699');
  await expect.poll(async () => (await transitions(page))[0].params?.color).toBeTruthy();
  const c = (await transitions(page))[0].params.color as number[];
  expect(c).toHaveLength(3); [0.2, 0.4, 0.6].forEach((v, k) => expect(c[k]).toBeCloseTo(v, 9));
  expect(await labels(page)).toHaveLength(n + 1); expect((await labels(page)).at(-1)).toBe('Edit transition');
  expect((await transitions(page))[0].kind).toBe('dipToColorDissolve');
  await pick(page, 'Fade'); await expect(popover(page).getByLabel('Dip colour')).toHaveCount(0);
});

test('own UI: the Wipe softness slider shows only for Wipe; a release writes params.softness in 0–100 as one "Edit transition"', async ({ page }) => {
  await addAndOpen(page);
  const slider = popover(page).getByRole('slider', { name: 'Softness' });
  await expect(slider).toHaveCount(0);
  await pick(page, 'Dip To Color'); await expect(slider).toHaveCount(0);
  await pick(page, 'Wipe'); await expect(slider).toHaveCount(1);
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  const n = (await undoEntries(page)).length;
  const b = (await slider.boundingBox())!, y = b.y + b.height / 2;
  await page.mouse.move(b.x + 5, y); await page.mouse.down();
  await page.mouse.move(b.x + 25, y, { steps: 4 }); await page.mouse.move(b.x + 45, y, { steps: 4 });
  expect((await undoEntries(page)).length, 'nothing is written while dragging').toBe(n);
  await page.mouse.up();
  await expect.poll(async () => (await transitions(page))[0].params?.softness).toBeGreaterThan(0);
  const soft = (await transitions(page))[0].params.softness as number;
  expect(soft).toBeLessThanOrEqual(100); expect(Number.isInteger(soft)).toBe(true);
  await expect(slider).toHaveAttribute('aria-valuenow', String(soft));
  expect(await labels(page)).toHaveLength(n + 1); expect((await labels(page)).at(-1)).toBe('Edit transition');
  await pick(page, 'Push'); await expect(slider).toHaveCount(0);
});

/** The marker's horizontal extent in page px. */
const extent = async (page: Page) => { const b = (await marker(page).boundingBox())!; return { left: b.x, right: b.x + b.width, width: b.width }; };

test('(4) acceptance l.154: a Center transition grows on both sides equally — after the +1 s drag the stored window is [cut − 1000, cut + 1000)', async ({ page }) => {
  await open(page); await scrollTo(page, 20000);
  await diamond(page, 'i1:i2').click(); await expect(marker(page)).toHaveCount(1);
  const cut = 20000;                                                              // i1 ends and i2 starts at 20 s
  const b0 = await extent(page);                                                  // Center, 1000 ms: [cut − 500, cut + 500) = 100 px wide
  expect(Math.abs(b0.width - 1000 * ZOOM)).toBeLessThanOrEqual(1);
  await dragEdge(page, marker(page).locator('.transition-edge-end'), 1000 * ZOOM);
  const rec = (await transitions(page))[0], D = rec.durationMs as number;
  expect(Math.abs(D - 2000)).toBeLessThanOrEqual(MS_PER_PX);
  expect(rec.alignment).toBe(0.5);
  const pre = Math.floor(D * rec.alignment), post = D - pre;                      // §55.2: window [cut − pre, cut + post)
  expect([cut - pre, cut + post].map(v => Math.abs(v - cut))).toEqual([pre, post]);
  expect(Math.abs(pre - 1000) <= MS_PER_PX && Math.abs(post - 1000) <= MS_PER_PX, `pre ${pre} post ${post}`).toBe(true);
  const b1 = await extent(page);
  expect(Math.abs(b1.width - D * ZOOM), 'the marker is the window wide').toBeLessThanOrEqual(1);
  expect(Math.abs(b1.left - (b0.left - 500 * ZOOM)), 'the left edge moved out by half the growth').toBeLessThanOrEqual(1.5);
  expect(Math.abs(b1.right - (b0.right + 500 * ZOOM)), 'the right edge moved out by half the growth').toBeLessThanOrEqual(1.5);
  expect(Math.abs((b1.left + b1.right) / 2 - (b0.left + b0.right) / 2), 'still centred on the cut').toBeLessThanOrEqual(1);
});

for (const c of [
  { align: 'End', alignment: 1, edge: 'start', sign: -1, kept: 'right' },    // [cut − D, cut): the right edge is the cut; the start edge moves left
  { align: 'Start', alignment: 0, edge: 'end', sign: 1, kept: 'left' },       // [cut, cut + D): the left edge is the cut; the end edge moves right
] as const) test(`(4) acceptance l.154: a ${c.align} transition keeps its ${c.kept} edge on the cut — dragging the ${c.edge} edge 1 s gives about 2000 ms and the window still ${c.align === 'End' ? 'ends' : 'starts'} at the cut`, async ({ page }) => {
  await addAndOpen(page);
  await popover(page).getByRole('group', { name: 'Align' }).getByRole('button', { name: c.align, exact: true }).click();
  expect((await transitions(page))[0].alignment).toBe(c.alignment);
  await page.keyboard.press('Escape'); await expect(popover(page)).toHaveCount(0);
  const e0 = await extent(page);                                                  // 1000 ms wide, one edge on the cut
  await dragEdge(page, marker(page).locator(`.transition-edge-${c.edge}`), c.sign * 1000 * ZOOM);
  const rec = (await transitions(page))[0];
  expect(Math.abs(rec.durationMs - 2000), `got ${rec.durationMs}`).toBeLessThanOrEqual(MS_PER_PX);
  expect(rec.alignment).toBe(c.alignment);
  const e1 = await extent(page);
  expect(Math.abs(e1[c.kept] - e0[c.kept]), `the ${c.kept} edge stays at the cut`).toBeLessThanOrEqual(1);
  expect(Math.abs(e1.width - rec.durationMs * ZOOM)).toBeLessThanOrEqual(1);
  expect(Math.abs((c.kept === 'right' ? e1.left - e0.left : e1.right - e0.right) - c.sign * 1000 * ZOOM)).toBeLessThanOrEqual(1.5);   // the moving edge went 1 s out
});
