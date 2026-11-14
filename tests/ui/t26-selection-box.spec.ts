// SPDX-License-Identifier: AGPL-3.0-only
// T26 preview selection box in real Chromium (ticket T26 rows 1-6, 9-14, 16; research 7.1 points 1-9; lane A's rulings Q1-Q3, Q5-Q8, A1, A2; Author's 22:08
// changes). Written from the ticket and 7.1: every number is 7.1's or worked by hand in a comment. Real pointer drags (page.mouse), no pointer capture.
// The DOM contract is the overlay's: svg.selection-overlay in .stage, [data-testid=selection-box] with circle.selection-handle[data-handle], selection-group,
// selection-guide-x / -y, selection-marquee. Canvas px in the comments are project px, y down; the helpers map them to the stage's screen rectangle.
import { test, expect, type Page } from '@playwright/test';
import { presetPoints } from '../../apps/web/src/timeline/shapes';
import { ffmpegAvailable } from '../media-fixtures';
import { clearIntents, createProject, intents, openEditor, setViewState, skipTour, typesDoc, viewState, watchIntents } from './t02-support';
import { liveDoc, savedDoc, undoLabels } from './t03-support';
import { panel } from './t04-support';
import { completed, decodeRgba, rectShape, runExport } from './t16a-support';

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => { test.setTimeout(150_000); await skipTour(page); });

type Pt = { x: number; y: number };
const SIZE = { width: 1080, height: 1920 };
const p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
const trk = (id: string, kind = 'overlay', extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1, ...extra });
const TRACKS = [trk('v1', 'video'), trk('o1'), trk('o2'), trk('o3')]; // bottom first
const doc = (items: unknown[], tracks: unknown[] = TRACKS, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 6000, fps: 30, size: SIZE, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks, layerOrder: (tracks as { id: string }[]).map(t => ({ type: 'track', id: t.id })), items, ...extra,
});
type Opt = { display?: { from: number; to: number }; props?: Record<string, unknown>; masks?: unknown[] };
const box = (x: number, y: number, w: number, h: number, props: Record<string, unknown> = {}) => ({ positionX: p(x), positionY: p(y), width: p(w), height: p(h), scale: p(1), rotation: p(0), opacity: p(1), ...Object.fromEntries(Object.entries(props).map(([k, v]) => [k, p(v)])) });
/** A rectangle shape (t16a-support's stored form) of w x h at (x, y). */
const shape = (id: string, trackId: string, x: number, y: number, w: number, h: number, o: Opt = {}) => {
  const r = rectShape(id, trackId, o.display ?? { from: 0, to: 4000 });
  return { ...r, details: { ...r.details, path: `M 0,0 L ${w},0 L ${w},${h} L 0,${h} Z`, points: [{ anchor: { x: 0, y: 0 } }, { anchor: { x: w, y: 0 } }, { anchor: { x: w, y: h } }, { anchor: { x: 0, y: h } }], width: w, height: h },
    properties: { ...r.properties, ...box(x, y, w, h, o.props) } };
};
/** An image with no asset (it is selectable and pickable; masks read the item box, not the picture). */
const image = (id: string, trackId: string, x: number, y: number, w: number, h: number, o: Opt = {}) => ({
  id, type: 'image', trackId, display: o.display ?? { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, details: { name: id }, properties: box(x, y, w, h, o.props), masks: o.masks ?? [], effects: [],
});
const text = (id: string, trackId: string, x: number, y: number, w: number, h: number, words: string, o: Opt = {}) => ({
  id, type: 'text', trackId, display: o.display ?? { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, playbackRate: 1, masks: [], effects: [],
  details: { text: words, fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' },
  properties: { ...box(x, y, w, h, o.props), fontSize: p(100), fontWeight: p(700), color: p('#ffffff'), backgroundColor: p('transparent'), textAlign: p('center'), wordWrap: p('break-word'), borderWidth: p(0), borderColor: p('#000000') },
});

// ---- helpers: geometry, pointer, state
const overlay = (page: Page) => page.locator('svg.selection-overlay');
const boxOf = (page: Page) => page.locator('[data-testid="selection-box"]');
const knobs = (page: Page) => overlay(page).locator('circle.selection-handle');
const groupBox = (page: Page) => page.locator('[data-testid="selection-group"]');
async function geo(page: Page, size = SIZE) {
  const r = (await page.locator('.stage').boundingBox())!;
  return { r, k: r.width / size.width, at: (x: number, y: number): Pt => ({ x: r.x + x * r.width / size.width, y: r.y + y * r.height / size.height }), canvas: (s: Pt): Pt => ({ x: (s.x - r.x) * size.width / r.width, y: (s.y - r.y) * size.height / r.height }) };
}
const knob = async (page: Page, h: string): Promise<Pt> => { const b = (await overlay(page).locator(`circle[data-handle="${h}"]`).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
/** Press at a, move to b in steps and release. */
async function drag(page: Page, a: Pt, b: Pt, steps = 8) { await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps }); await page.mouse.up(); }
/** Press at a and move to b, leaving the button down (the caller releases with page.mouse.up()). */
async function hold(page: Page, a: Pt, b: Pt, steps = 8) { await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps }); }
const click = async (page: Page, a: Pt, opts: { shift?: boolean } = {}) => { if (opts.shift) await page.keyboard.down('Shift'); await page.mouse.click(a.x, a.y); if (opts.shift) await page.keyboard.up('Shift'); };
const item = async (page: Page, id: string) => (await liveDoc(page)).items.find((i: { id: string }) => i.id === id);
const pv = async (page: Page, id: string, key: string) => { const q = (await item(page, id)).properties?.[key]; return q && typeof q === 'object' && 'defaultValue' in q ? q.defaultValue as number : q as number; };
const closeTo = (read: () => Promise<number>, want: number, tol = 2) => expect.poll(async () => Math.abs((await read()) - want), { message: `want ${want} +/- ${tol}` }).toBeLessThanOrEqual(tol);
const selection = (page: Page) => viewState(page, v => v.selection as string[]);
const choose = (page: Page, ids: string[]) => page.evaluate(async ids => { const m = '/src/editor/view.ts'; (await import(m)).select(ids); }, ids);
const undo = (page: Page) => page.evaluate(async () => { const m = '/src/editor/commands.ts'; (await import(m)).dispatch({ type: 'undo' }); });
const draftLive = (page: Page) => page.evaluate(async () => { const m = '/src/editor/selection-overlay.tsx'; return (await import(m)).useSelectionDraft.getState().doc !== null; });
const draftValue = (page: Page, id: string, key: string) => page.evaluate(async ({ id, key }) => {
  const m = '/src/editor/selection-overlay.tsx', d = (await import(m)).useSelectionDraft.getState().doc, q = d?.items.find((i: { id: string }) => i.id === id)?.properties?.[key];
  return (q && typeof q === 'object' && 'defaultValue' in q ? q.defaultValue : q) as number | undefined;
}, { id, key });
const transforms = async (page: Page) => (await intents(page)).filter(l => l.intent.type === 'transformOnPreview');
/** Opens an editor on `d`, watches intents and puts the playhead at `ms`. */
async function open(page: Page, d: unknown, ms = 500) { const id = await openEditor(page, d); await watchIntents(page); await setViewState(page, { playheadMs: ms }); return id; }
const near = (got: number, want: number, tol: number, what: string) => expect(Math.abs(got - want), `${what}: ${got} vs ${want}`).toBeLessThanOrEqual(tol);

// ---- fixtures
/** a: 400 x 300 at (200, 400): corners nw (200,400) ne (600,400) se (600,700) sw (200,700), centre (400,550). */
const A = () => doc([shape('a', 'o1', 200, 400, 400, 300)]);

test.describe('T26 rows 1 and 6: the box, the handles, their size', () => {
  test('row 1, 6: every visual item type shows the box with exactly 5 handles (4 corners + rotate) and no edge handle; audio shows none', async ({ page }) => {
    await open(page, typesDoc(), 0);
    for (const type of ['video', 'text', 'shape', 'motionGraphic', 'layout', 'caption', 'image']) {
      await choose(page, [`i-${type}`]);
      await expect(page.locator(`[data-testid="selection-box"][data-item="i-${type}"]`), type).toHaveCount(1);
      expect(await knobs(page).evaluateAll(cs => cs.map(c => c.getAttribute('data-handle')).sort()), type).toEqual(['ne', 'nw', 'rotate', 'se', 'sw']);
      await expect(boxOf(page).locator('.selection-line'), `${type}: the box line and the line to the rotation handle`).toHaveCount(2);
    }
    await choose(page, ['i-audio']); await expect(boxOf(page)).toHaveCount(0); await expect(groupBox(page)).toHaveCount(0);
  });

  test('row 1: the box follows the item at the playhead and is gone outside its time (both ends count, Q8)', async ({ page }) => {
    await open(page, doc([shape('a', 'o1', 200, 400, 400, 300, { display: { from: 1000, to: 3000 }, props: { positionX: 200 } })]), 0);
    await choose(page, ['a']); await expect(boxOf(page)).toHaveCount(0); // before its start: still selected, no box
    expect(await selection(page)).toEqual(['a']);
    for (const ms of [1000, 2000, 3000]) { await setViewState(page, { playheadMs: ms }); await expect(boxOf(page), `${ms} ms`).toHaveCount(1); }
    await setViewState(page, { playheadMs: 3100 }); await expect(boxOf(page)).toHaveCount(0);
    await setViewState(page, { playheadMs: 3000 }); // t = display.to: the box shows and the item is pickable
    await choose(page, []); const g = await geo(page); await click(page, g.at(400, 550)); expect(await selection(page)).toEqual(['a']);
  });

  /** 7.1 point 7: handle 10 screen px across (outer edge, border included), border 1 canvas px, lines 1.5 screen px, rotation handle 28 screen px above the top edge. */
  const measure = (page: Page) => page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>('svg.selection-overlay')!, stage = document.querySelector('.stage')!.getBoundingClientRect(), k = stage.width / svg.viewBox.baseVal.width;
    const c = (h: string) => svg.querySelector(`circle[data-handle="${h}"]`)!, mid = (h: string) => { const b = c(h).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }; };
    const border = parseFloat(getComputedStyle(c('se')).strokeWidth), nw = mid('nw'), ne = mid('ne'), rot = mid('rotate'), line = svg.querySelector('polygon.selection-line')!;
    return { k, zoomAttr: Number(svg.getAttribute('data-zoom')), outer: mid('se').w + border * k, border, line: parseFloat(getComputedStyle(line).strokeWidth) * k, gap: Math.hypot(rot.x - (nw.x + ne.x) / 2, rot.y - (nw.y + ne.y) / 2) };
  });
  test('row 1, 7.1 point 7: sizes keep their screen px at fit, zoomed in, zoomed out and after Reset view', async ({ page }) => {
    await open(page, A()); await choose(page, ['a']); await expect(boxOf(page)).toHaveCount(1);
    const preview = page.locator('[aria-label="Preview"]'), stage = page.locator('.stage');
    const check = async (label: string) => {
      await expect.poll(async () => { const m = await measure(page); return Math.abs(m.zoomAttr - m.k) / m.k; }, { message: `${label}: data-zoom follows the stage` }).toBeLessThan(0.02);
      const m = await measure(page);
      near(m.outer, 10, 0.7, `${label} handle`); near(m.border, 1, 0.05, `${label} border in canvas px`); near(m.line, 1.5, 0.1, `${label} line`); near(m.gap, 28, 0.8, `${label} rotation gap`);
    };
    await check('fit');
    for (let n = 0; n < 6; n++) await preview.dispatchEvent('wheel', { deltaY: -100, ctrlKey: true });
    await expect(stage).not.toHaveAttribute('data-scale', '1'); await check('zoomed in');
    await page.getByRole('button', { name: 'Reset view (fit)' }).click(); await expect(stage).toHaveAttribute('data-scale', '1');
    for (let n = 0; n < 5; n++) await preview.dispatchEvent('wheel', { deltaY: 100, ctrlKey: true });
    await expect(stage).not.toHaveAttribute('data-scale', '1'); await check('zoomed out');
    await page.getByRole('button', { name: 'Reset view (fit)' }).click(); await expect(stage).toHaveAttribute('data-scale', '1'); await check('after Reset view');
  });
});

test.describe('T26 rows 2-4: the corner and rotation drags, one history step', () => {
  // The pointer goes to canvas (400, 550), half way along the diagonal: e_x = 200 of 400, e_y = 150 of 300, factor 0.5.
  const corners: [string, Pt, Pt][] = [
    ['se', { x: 600, y: 700 }, { x: 200, y: 400 }], ['nw', { x: 200, y: 400 }, { x: 400, y: 550 }], ['ne', { x: 600, y: 400 }, { x: 200, y: 550 }], ['sw', { x: 200, y: 700 }, { x: 400, y: 400 }],
  ];
  for (const [corner, from, position] of corners) test(`row 2: ${corner} handle keeps the opposite corner fixed: scale 0.5, position (${position.x}, ${position.y}), width and height untouched`, async ({ page }) => {
    await open(page, A()); await choose(page, ['a']); const g = await geo(page);
    await drag(page, await knob(page, corner), g.at(400, 550));
    await closeTo(() => pv(page, 'a', 'scale'), 0.5, 0.02); await closeTo(() => pv(page, 'a', 'positionX'), position.x); await closeTo(() => pv(page, 'a', 'positionY'), position.y);
    expect(await pv(page, 'a', 'width')).toBe(400); expect(await pv(page, 'a', 'height')).toBe(300);
    void from;
  });

  test('rows 2, 4, Q3: a corner drag writes nothing to the document until release; one "Edit items" step; undo restores; the draft is dropped', async ({ page }) => {
    await open(page, A()); await choose(page, ['a']); const g = await geo(page), before = JSON.stringify((await liveDoc(page)).items);
    await hold(page, await knob(page, 'se'), g.at(400, 550));
    expect(await draftLive(page)).toBe(true); near(await draftValue(page, 'a', 'scale') ?? 0, 0.5, 0.02, 'the draft scale');
    expect(JSON.stringify((await liveDoc(page)).items), 'no document write on a move').toBe(before); expect(await undoLabels(page)).toEqual([]); expect(await transforms(page)).toHaveLength(0);
    const se = await knob(page, 'se'), want = g.at(400, 550); near(se.x, want.x, 2, 'the box follows the pointer (x)'); near(se.y, want.y, 2, 'the box follows the pointer (y)');
    await page.mouse.up();
    await expect.poll(() => draftLive(page)).toBe(false);
    expect(await undoLabels(page)).toEqual(['Edit items']); const edits = await transforms(page); expect(edits).toHaveLength(1); expect(edits[0].outcome.ok).toBe(true);
    await undo(page); expect(JSON.stringify((await liveDoc(page)).items)).toBe(before); expect(await undoLabels(page)).toEqual([]);
  });

  // a: 400 x 300 at (200, 400). Each press is 20 canvas px inside an edge midpoint (about 3.6 screen px at k 0.18, clear of the item border and of every corner handle).
  // The pointer moves by (-100, +60): the centre goes from (400, 550) to (300, 610), 240 and 350 canvas px from the canvas centre (540, 960), far outside the snap (8 screen px, about 44 canvas px).
  // With no edge handle the press is a move of the item by that offset; an edge resize would change scale, and a rotation would change rotation.
  test('row 6: no edge handles; a drag from each edge midpoint moves the item by the offset (position changes, scale stays 1, rotation stays 0)', async ({ page }) => {
    await open(page, A()); await choose(page, ['a']); await expect(knobs(page)).toHaveCount(5);
    const g = await geo(page);
    for (const [name, mid] of [['top', { x: 400, y: 420 }], ['right', { x: 580, y: 550 }], ['bottom', { x: 400, y: 680 }], ['left', { x: 220, y: 550 }]] as const) {
      const from = g.at(mid.x, mid.y), to = g.at(mid.x - 100, mid.y + 60);
      await drag(page, from, to);
      await closeTo(() => pv(page, 'a', 'positionX'), 100); await closeTo(() => pv(page, 'a', 'positionY'), 460);
      expect(await pv(page, 'a', 'scale'), `${name} edge: not a resize`).toBe(1); expect(await pv(page, 'a', 'rotation'), `${name} edge: not a rotation`).toBe(0);
      expect(await undoLabels(page), `${name} edge: one move step`).toEqual(['Edit items']);
      await undo(page); await expect.poll(() => undoLabels(page)).toEqual([]); await closeTo(() => pv(page, 'a', 'positionX'), 200, 0.01); await closeTo(() => pv(page, 'a', 'positionY'), 400, 0.01);
    }
  });

  // Rotation about the centre (400, 550): the handle is straight above a start-0 item, at angle -90 degrees; the pointer goes round at radius 300.
  const at = (deg: number): Pt => ({ x: 400 + 300 * Math.cos(deg * Math.PI / 180), y: 550 + 300 * Math.sin(deg * Math.PI / 180) });
  for (const [start, from, to, want] of [[0, -90, 0, 90], [350, -100, -70, 380], [10, -80, -110, -20]] as const) {
    test(`row 3: rotation ${start} + ${to - from} stores ${want}: no snap, no wrap into a range; only rotation changes`, async ({ page }) => {
      await open(page, doc([shape('a', 'o1', 200, 400, 400, 300, { props: { rotation: start } })])); await choose(page, ['a']); const g = await geo(page);
      void from;
      await drag(page, await knob(page, 'rotate'), g.at(at(to).x, at(to).y), 12);
      await closeTo(() => pv(page, 'a', 'rotation'), want, 1.5);
      expect(await pv(page, 'a', 'scale')).toBe(1); expect(await pv(page, 'a', 'positionX')).toBe(200); expect(await pv(page, 'a', 'positionY')).toBe(400);
      expect(await undoLabels(page)).toEqual(['Edit items']);
    });
  }

  test('row 4: a move that ends back on its start point, and a press and release with no move, make no step and write nothing', async ({ page }) => {
    await open(page, A()); await choose(page, ['a']); const g = await geo(page), start = g.at(400, 550), before = JSON.stringify((await liveDoc(page)).items);
    await hold(page, start, g.at(500, 640)); expect(await draftLive(page)).toBe(true);
    await page.mouse.move(start.x, start.y, { steps: 6 }); await page.mouse.up();
    await expect.poll(() => draftLive(page)).toBe(false);
    expect(await undoLabels(page)).toEqual([]); expect(JSON.stringify((await liveDoc(page)).items)).toBe(before);
    await clearIntents(page); await click(page, start);
    expect(await transforms(page)).toHaveLength(0); expect(await undoLabels(page)).toEqual([]); expect(JSON.stringify((await liveDoc(page)).items)).toBe(before);
  });
});

test.describe('T26 row 10: press selects and moves, the centre snap, the guides', () => {
  const two = () => doc([shape('a', 'o1', 200, 400, 400, 300), shape('b', 'o2', 700, 1200, 200, 100), shape('c', 'o3', 340, 700, 200, 100, { display: { from: 0, to: 4000 } })]);
  test('a press on an unselected item selects it and moves it in the same press, by the pointer movement, one step', async ({ page }) => {
    await open(page, doc([shape('a', 'o1', 200, 400, 400, 300), shape('b', 'o2', 700, 1200, 200, 100)])); const g = await geo(page);
    expect(await selection(page)).toEqual([]);
    // Centre to (300, 610): 240 and 350 px from the canvas centre (540, 960), far outside the snap (8 screen px is about 44 canvas px at k 0.18).
    await drag(page, g.at(400, 550), g.at(300, 610));
    expect(await selection(page)).toEqual(['a']); await closeTo(() => pv(page, 'a', 'positionX'), 100); await closeTo(() => pv(page, 'a', 'positionY'), 460);
    expect(await pv(page, 'b', 'positionX')).toBe(700); expect(await undoLabels(page)).toEqual(['Edit items']);
  });
  test('there is no drag threshold: the first pointer move already shows the draft; the document is written on release only', async ({ page }) => {
    await open(page, A()); const g = await geo(page), s = g.at(400, 550);
    await page.mouse.move(s.x, s.y); await page.mouse.down(); await page.mouse.move(s.x + 1, s.y);
    expect(await draftLive(page)).toBe(true); expect(await pv(page, 'a', 'positionX')).toBe(200);
    await page.mouse.up(); await expect.poll(() => pv(page, 'a', 'positionX')).not.toBe(200);
  });
  test('all selected items move together by the same movement', async ({ page }) => {
    await open(page, doc([shape('a', 'o1', 200, 400, 400, 300), shape('b', 'o2', 700, 1200, 200, 100)])); await choose(page, ['a', 'b']); const g = await geo(page);
    await drag(page, g.at(400, 550), g.at(450, 590));
    await closeTo(() => pv(page, 'a', 'positionX'), 250); await closeTo(() => pv(page, 'a', 'positionY'), 440); await closeTo(() => pv(page, 'b', 'positionX'), 750); await closeTo(() => pv(page, 'b', 'positionY'), 1240);
    expect(await undoLabels(page)).toEqual(['Edit items']);
  });
  // c: 200 x 100 at (340, 700), centre (440, 750). The canvas centre is (540, 960). 8 screen px is 8 / k canvas px (about 25 at the fit zoom).
  test('the item centre snaps to the canvas centre on each axis on its own, with a guide per snapped axis until release', async ({ page }) => {
    await open(page, two()); const g = await geo(page), grab = g.at(440, 750);
    const guideX = page.locator('[data-testid="selection-guide-x"]'), guideY = page.locator('[data-testid="selection-guide-y"]');
    await hold(page, grab, g.at(440 + 90, 750 + 0)); // centre x 530: 10 px from 540
    await expect(guideX).toHaveCount(1); await expect(guideY).toHaveCount(0); expect(await draftValue(page, 'c', 'positionX')).toBeCloseTo(440, 6);
    await page.mouse.move(g.at(440 + 90, 750 + 210).x, g.at(440 + 90, 750 + 210).y, { steps: 6 }); // centre y 960
    await expect(guideX).toHaveCount(1); await expect(guideY).toHaveCount(1); expect(await draftValue(page, 'c', 'positionY')).toBeCloseTo(910, 6);
    await page.mouse.move(g.at(440 + 300, 750 + 300).x, g.at(440 + 300, 750 + 300).y, { steps: 6 }); // far from both
    await expect(guideX).toHaveCount(0); await expect(guideY).toHaveCount(0); near(await draftValue(page, 'c', 'positionX') ?? 0, 640, 2, 'free x (no snap)');
    await page.mouse.move(g.at(440 + 90, 750 + 210).x, g.at(440 + 90, 750 + 210).y, { steps: 6 }); await expect(guideX).toHaveCount(1);
    await page.mouse.up(); await expect(guideX).toHaveCount(0); await expect(guideY).toHaveCount(0);
    await closeTo(() => pv(page, 'c', 'positionX'), 440, 0.01); await closeTo(() => pv(page, 'c', 'positionY'), 910, 0.01);
  });
  // a's centre (400, 550); the canvas centre x is 540. The limit is 8 screen px at the stage's own zoom k (lane A, 13 Nov: pin it at the real zoom).
  // 6 and 10 screen px leave 2 screen px to the limit on each side, room for the pointer's rounding to whole screen px.
  test('the snap limit is 8 screen px at the stage zoom: 6 screen px off snaps, 10 screen px off does not', async ({ page }) => {
    await open(page, A()); const g = await geo(page), grab = g.at(400, 550), guideX = page.locator('[data-testid="selection-guide-x"]');
    near(Number(await overlay(page).getAttribute('data-zoom')), g.k, 0.001, 'the overlay zoom is the stage width over the canvas width');
    const off = (screen: number) => ({ x: grab.x + 140 * g.k - screen, y: grab.y }); // centre x at 540 minus `screen` screen px
    await hold(page, grab, off(10)); await expect(guideX).toHaveCount(0); near(await draftValue(page, 'a', 'positionX') ?? 0, 340 - 10 / g.k, 1.5 / g.k, '10 screen px off: no snap');
    await page.mouse.move(off(6).x, off(6).y, { steps: 2 }); await expect(guideX).toHaveCount(1); expect(await draftValue(page, 'a', 'positionX')).toBeCloseTo(340, 6);
    await page.mouse.up(); await closeTo(() => pv(page, 'a', 'positionX'), 340, 0.01); expect(await undoLabels(page)).toEqual(['Edit items']);
  });
});

test.describe('T26 row 11: the click pick, Shift, empty space, the marquee', () => {
  test('Q1, 7.1 point 8: the higher track first; on the same track the item drawn later first', async ({ page }) => {
    await open(page, doc([shape('low', 'o1', 100, 300, 600, 600), shape('high', 'o2', 300, 500, 200, 200), shape('e', 'o3', 100, 1100, 300, 300, { display: { from: 0, to: 4000 } }), shape('l', 'o3', 200, 1200, 300, 300, { display: { from: 500, to: 4000 } })]), 1000);
    const g = await geo(page);
    await click(page, g.at(400, 600)); expect(await selection(page)).toEqual(['high']);
    await click(page, g.at(150, 350)); expect(await selection(page)).toEqual(['low']);
    await click(page, g.at(300, 1300)); expect(await selection(page), 'overlap on one track: l is drawn later').toEqual(['l']);
    await click(page, g.at(120, 1120)); expect(await selection(page)).toEqual(['e']);
  });
  test('a plain press keeps a selection the item is already in; Shift adds and takes out; empty space clears (not with Shift)', async ({ page }) => {
    await open(page, doc([shape('big', 'o1', 100, 300, 600, 600), shape('small', 'o2', 300, 500, 200, 200)])); const g = await geo(page);
    await click(page, g.at(400, 600)); expect(await selection(page)).toEqual(['small']);
    await click(page, g.at(150, 350), { shift: true }); expect(await selection(page)).toEqual(['small', 'big']);
    await click(page, g.at(150, 350), { shift: true }); expect(await selection(page)).toEqual(['small']);
    await choose(page, ['big', 'small']); await click(page, g.at(400, 600)); expect(await selection(page), 'a press on a selected item keeps the group').toEqual(['big', 'small']);
    await click(page, g.at(150, 350)); expect(await selection(page)).toEqual(['big', 'small']);
    await click(page, g.at(900, 1700), { shift: true }); expect(await selection(page), 'Shift on empty space keeps the selection').toEqual(['big', 'small']);
    await click(page, g.at(900, 1700)); expect(await selection(page)).toEqual([]);
    expect(await transforms(page)).toHaveLength(0); expect(await undoLabels(page)).toEqual([]);
  });
  test('a Shift press on an already selected item takes it out and starts no move: nothing is dragged, written or dispatched', async ({ page }) => {
    await open(page, doc([shape('big', 'o1', 100, 300, 600, 600), shape('small', 'o2', 300, 500, 200, 200)])); await choose(page, ['big', 'small']); const g = await geo(page);
    await clearIntents(page);
    // (150, 350) lies on big only. The pointer then moves 300 canvas px right and 400 down, so a move that wrongly started would show.
    await page.keyboard.down('Shift');
    await page.mouse.move(g.at(150, 350).x, g.at(150, 350).y); await page.mouse.down();
    await page.mouse.move(g.at(450, 750).x, g.at(450, 750).y, { steps: 8 });
    expect(await draftLive(page), 'no draft while the button is down').toBe(false);
    await page.mouse.up(); await page.keyboard.up('Shift');
    expect(await selection(page)).toEqual(['small']);
    expect(await pv(page, 'big', 'positionX')).toBe(100); expect(await pv(page, 'big', 'positionY')).toBe(300);
    expect(await pv(page, 'small', 'positionX')).toBe(300); expect(await pv(page, 'small', 'positionY')).toBe(500);
    expect(await undoLabels(page)).toEqual([]); expect(await transforms(page)).toHaveLength(0);
  });
  const ms = () => doc([shape('m1', 'o1', 100, 100, 100, 100), shape('m2', 'o1', 300, 100, 100, 100), shape('gone', 'o2', 120, 120, 40, 40, { display: { from: 3000, to: 4000 } })]);
  test('marquee: a press on empty space starts it; on release the items at the playhead lying fully inside are selected', async ({ page }) => {
    await open(page, ms()); const g = await geo(page), marquee = page.locator('[data-testid="selection-marquee"]');
    await choose(page, ['m2']);
    await hold(page, g.at(20, 20), g.at(250, 250)); await expect(marquee).toHaveCount(1);
    const r = (await marquee.boundingBox())!, a = g.canvas({ x: r.x, y: r.y }), b = g.canvas({ x: r.x + r.width, y: r.y + r.height });
    near(a.x, 20, 2, 'marquee left'); near(a.y, 20, 2, 'marquee top'); near(b.x, 250, 2, 'marquee right'); near(b.y, 250, 2, 'marquee bottom');
    await page.mouse.up(); await expect(marquee).toHaveCount(0);
    expect(await selection(page), 'the press cleared m2; gone is not at the playhead; m2 lies partly outside').toEqual(['m1']);
    await drag(page, g.at(20, 20), g.at(150, 150)); expect(await selection(page), 'm1 only partly inside').toEqual([]);
    await drag(page, g.at(20, 20), g.at(450, 250)); expect([...await selection(page)].sort()).toEqual(['m1', 'm2']);
  });
  test('marquee with Shift adds to the earlier selection; a press and release without movement selects nothing', async ({ page }) => {
    await open(page, ms()); const g = await geo(page); await choose(page, ['m2']);
    await page.keyboard.down('Shift'); await drag(page, g.at(20, 20), g.at(250, 250)); await page.keyboard.up('Shift');
    expect([...await selection(page)].sort()).toEqual(['m1', 'm2']);
    await choose(page, ['m2']); await click(page, g.at(900, 1700)); expect(await selection(page)).toEqual([]);
  });
});

test.describe('T26 rows 12 and A1: several selected items', () => {
  test('row 12: 2 or more selected items at the playhead show one plain box around them and no handles', async ({ page }) => {
    await open(page, doc([shape('a', 'o1', 200, 400, 400, 300), shape('b', 'o2', 700, 1200, 200, 100)])); await choose(page, ['a', 'b']);
    await expect(groupBox(page)).toHaveCount(1); await expect(boxOf(page)).toHaveCount(0); await expect(knobs(page)).toHaveCount(0);
    // The rect's own canvas-px geometry: its screen box would include half the 1.5 screen px stroke (about 4 canvas px at k 0.18).
    const r = await groupBox(page).evaluate(e => ['x', 'y', 'width', 'height'].map(k => Number(e.getAttribute(k)))), a = { x: r[0], y: r[1] }, b = { x: r[0] + r[2], y: r[1] + r[3] };
    near(a.x, 200, 2, 'left'); near(a.y, 400, 2, 'top'); near(b.x, 900, 2, 'right'); near(b.y, 1300, 2, 'bottom'); // the union of the two boxes
    await choose(page, ['a']); await expect(groupBox(page)).toHaveCount(0); await expect(boxOf(page)).toHaveCount(1);
  });
  test('A1: 2 selected, 1 at the playhead: the handles are drawn, but a press on one acts as a press on the stage (a move, no corner drag)', async ({ page }) => {
    await open(page, doc([shape('a', 'o1', 200, 400, 400, 300), shape('later', 'o2', 700, 1200, 200, 100, { display: { from: 3000, to: 4000 } })])); await choose(page, ['a', 'later']);
    await expect(boxOf(page)).toHaveCount(1); await expect(knobs(page)).toHaveCount(5);
    const g = await geo(page), se = await knob(page, 'se'), inside = { x: se.x - 2, y: se.y - 2 }; // on the handle and inside the item
    await drag(page, inside, { x: inside.x + 30, y: inside.y + 20 });
    await closeTo(() => pv(page, 'a', 'positionX'), 200 + 30 / g.k); await closeTo(() => pv(page, 'a', 'positionY'), 400 + 20 / g.k);
    expect(await pv(page, 'a', 'scale')).toBe(1); expect([...await selection(page)].sort()).toEqual(['a', 'later']);
  });
});

test.describe('T26 rows 13, 14, A2: locked and hidden tracks, captions', () => {
  const lockedTracks = [trk('v1', 'video'), trk('o1', 'overlay', { locked: true }), trk('o2')];
  test('row 13: on a locked track the box shows, the drag is refused with TRACK_LOCKED, and the item is back at its start values', async ({ page }) => {
    await open(page, doc([shape('a', 'o1', 200, 400, 400, 300)], lockedTracks)); await choose(page, ['a']); await expect(boxOf(page)).toHaveCount(1);
    const g = await geo(page), before = JSON.stringify((await liveDoc(page)).items), se0 = await knob(page, 'se');
    await drag(page, g.at(400, 550), g.at(500, 650));
    await expect.poll(async () => (await transforms(page)).length).toBe(1);
    expect((await transforms(page))[0].outcome).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
    expect(JSON.stringify((await liveDoc(page)).items)).toBe(before); expect(await undoLabels(page)).toEqual([]);
    await expect.poll(() => draftLive(page)).toBe(false);
    const se1 = await knob(page, 'se'); near(se1.x, se0.x, 1, 'the box is back (x)'); near(se1.y, se0.y, 1, 'the box is back (y)');
    await drag(page, se0, g.at(400, 550)); // a corner drag too
    await expect.poll(async () => (await transforms(page)).length).toBe(2); expect((await transforms(page))[1].outcome).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
    expect(JSON.stringify((await liveDoc(page)).items)).toBe(before);
  });
  test('A2: a move of several items where one is on a locked track is refused whole; every item is back', async ({ page }) => {
    await open(page, doc([shape('a', 'o1', 200, 400, 400, 300), shape('b', 'o2', 700, 1200, 200, 100)], lockedTracks)); await choose(page, ['a', 'b']);
    const g = await geo(page), before = JSON.stringify((await liveDoc(page)).items);
    await drag(page, g.at(750, 1250), g.at(800, 1300)); // press on b (unlocked), a is locked
    await expect.poll(async () => (await transforms(page)).length).toBe(1);
    expect((await transforms(page))[0].outcome).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
    expect(JSON.stringify((await liveDoc(page)).items), 'b did not move either').toBe(before); expect(await undoLabels(page)).toEqual([]);
  });
  test('row 14: on a hidden track the box shows, the item is picked and can be dragged (built from the code reading, not checked against output)', async ({ page }) => {
    await open(page, doc([shape('a', 'o1', 200, 400, 400, 300)], [trk('v1', 'video'), trk('o1', 'overlay', { hidden: true })])); const g = await geo(page);
    await click(page, g.at(400, 550)); expect(await selection(page)).toEqual(['a']); await expect(boxOf(page)).toHaveCount(1);
    await drag(page, g.at(400, 550), g.at(450, 600)); await closeTo(() => pv(page, 'a', 'positionX'), 250); await closeTo(() => pv(page, 'a', 'positionY'), 450);
    expect(await undoLabels(page)).toEqual(['Edit items']);
  });
  test('row 14: a caption shows the same box, from its stored width, height, position and scale (not checked against output)', async ({ page }) => {
    const cap = { id: 'cap', type: 'caption', trackId: 'c1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, details: { text: 'Caption', name: 'cap' }, properties: box(100, 1500, 600, 120), masks: [], effects: [] };
    await open(page, doc([cap], [trk('v1', 'video'), trk('c1', 'caption')])); await choose(page, ['cap']); await expect(boxOf(page)).toHaveCount(1);
    const g = await geo(page), nw = g.canvas(await knob(page, 'nw')), se = g.canvas(await knob(page, 'se'));
    near(nw.x, 100, 2, 'left'); near(nw.y, 1500, 2, 'top'); near(se.x, 700, 2, 'right'); near(se.y, 1620, 2, 'bottom');
  });
});

test.describe('T26 row 16: no box and no press in the editing modes', () => {
  const modes = () => doc([shape('a', 'o1', 200, 400, 400, 300), shape('b', 'o2', 700, 1200, 200, 100), image('m', 'v1', 100, 1400, 300, 200)]);
  test('mask editing: the box is hidden and a press does not select or move; it returns on leaving', async ({ page }) => {
    await open(page, modes()); await choose(page, ['m']); await expect(boxOf(page)).toHaveCount(1);
    await page.evaluate(async () => { const m = '/src/editor/mask-state.ts'; (await import(m)).openMaskEditor('m', null); });
    await expect(boxOf(page)).toHaveCount(0); const g = await geo(page);
    await click(page, g.at(750, 1250)); await drag(page, g.at(400, 550), g.at(450, 600));
    expect(await selection(page)).toEqual(['m']); expect(await transforms(page)).toHaveLength(0); expect(await pv(page, 'a', 'positionX')).toBe(200);
    await page.evaluate(async () => { const m = '/src/editor/mask-state.ts'; (await import(m)).leaveMaskEdit(); });
    await expect(boxOf(page)).toHaveCount(1);
  });
  test('shape drawing: the box is hidden and a press does not select or move', async ({ page }) => {
    await open(page, modes()); await choose(page, ['a']); await expect(boxOf(page)).toHaveCount(1);
    await page.evaluate(async () => { const m = '/src/editor/shape-ui.tsx'; (await import(m)).useShapeUi.setState({ mode: { kind: 'draw', type: 'rectangle' } }); });
    await expect(boxOf(page)).toHaveCount(0); const g = await geo(page);
    await click(page, g.at(750, 1250)); expect(await selection(page)).toEqual(['a']); expect(await transforms(page)).toHaveLength(0);
    await page.evaluate(async () => { const m = '/src/editor/shape-ui.tsx'; (await import(m)).useShapeUi.setState({ mode: null }); });
    await expect(boxOf(page)).toHaveCount(1);
  });
  test('a double-click while a mode is on does nothing from the overlay: with 1 shape selected, path editing is not entered (outside a mode it is, see Q7)', async ({ page }) => {
    await open(page, modes()); await choose(page, ['a']); await expect(boxOf(page)).toHaveCount(1);
    await page.evaluate(async () => { const m = '/src/editor/shape-ui.tsx'; (await import(m)).useShapeUi.setState({ mode: { kind: 'draw', type: 'rectangle' } }); });
    await expect(boxOf(page)).toHaveCount(0); const g = await geo(page).then(x => x.at(400, 550));
    await page.mouse.dblclick(g.x, g.y);
    const editing = await page.evaluate(async () => { const m = '/src/editor/shape-ui.tsx'; return (await import(m)).useShapeUi.getState().editing as string | null; });
    expect(editing, 'the overlay listener returns early while hidden').toBeNull();
    expect(await transforms(page)).toHaveLength(0);
  });
  test('shape path editing: the box is hidden and a press does not select or move', async ({ page }) => {
    await open(page, modes()); await choose(page, ['a']);
    await page.evaluate(async () => { const m = '/src/editor/shape-ui.tsx'; (await import(m)).useShapeUi.setState({ editing: 'a', mode: null }); });
    await expect(boxOf(page)).toHaveCount(0); const g = await geo(page);
    await click(page, g.at(750, 1250)); expect(await selection(page)).toEqual(['a']); expect(await transforms(page)).toHaveLength(0);
    await page.evaluate(async () => { const m = '/src/editor/shape-ui.tsx'; (await import(m)).useShapeUi.setState({ editing: null }); });
    await expect(boxOf(page)).toHaveCount(1);
  });
});

test.describe('T26 Q7 (Author 22:08): a double-click with exactly 1 shape selected enters path editing', () => {
  const editing = (page: Page) => page.evaluate(async () => { const m = '/src/editor/shape-ui.tsx'; return (await import(m)).useShapeUi.getState().editing as string | null; });
  const two = () => doc([shape('a', 'o1', 200, 400, 400, 300), shape('b', 'o2', 700, 1200, 200, 100)]);
  test('1 shape selected at the playhead: the double-click sets editing to its id and hides the box and handles', async ({ page }) => {
    await open(page, two()); await choose(page, ['a']); await expect(boxOf(page)).toHaveCount(1); const g = await geo(page).then(x => x.at(400, 550));
    await page.mouse.dblclick(g.x, g.y);
    await expect.poll(() => editing(page)).toBe('a'); await expect(boxOf(page)).toHaveCount(0); await expect(knobs(page)).toHaveCount(0);
  });
  test('a double-click on an unselected shape picks it first (its presses select it), then enters path editing', async ({ page }) => {
    await open(page, two()); const g = await geo(page).then(x => x.at(400, 550));
    await page.mouse.dblclick(g.x, g.y); await expect.poll(() => editing(page)).toBe('a');
  });
  test('2 selected: the double-click does not enter path editing', async ({ page }) => {
    await open(page, two()); await choose(page, ['a', 'b']); const g = await geo(page).then(x => x.at(400, 550));
    await page.mouse.dblclick(g.x, g.y); expect(await editing(page)).toBeNull(); expect([...await selection(page)].sort()).toEqual(['a', 'b']); await expect(groupBox(page)).toHaveCount(1);
  });
  test('the Edit path button still works', async ({ page }) => {
    await open(page, two()); await choose(page, ['a']);
    const path = panel(page).locator('details').filter({ has: page.locator('summary', { hasText: /^Shape Path$/ }) });
    if (!(await path.evaluate(e => (e as HTMLDetailsElement).open))) await path.locator('summary').click();
    await path.getByRole('button', { name: 'Edit path' }).click(); await expect.poll(() => editing(page)).toBe('a'); await expect(boxOf(page)).toHaveCount(0);
  });
});

test.describe('T26 row 11 and Q2: the text double-click', () => {
  const editor = (page: Page) => page.getByRole('textbox', { name: 'Edit text' });
  test('a double-click on a text opens the inline editor; the box and handles stay while it is open', async ({ page }) => {
    await open(page, doc([text('txt', 'o1', 240, 700, 600, 160, 'Draft')])); const g = await geo(page).then(x => x.at(540, 780));
    await page.mouse.dblclick(g.x, g.y);
    await expect(editor(page)).toBeFocused(); expect(await selection(page)).toEqual(['txt']);
    await expect(boxOf(page)).toHaveCount(1); await expect(knobs(page)).toHaveCount(5);
    await page.keyboard.press('Escape'); await expect(editor(page)).toHaveCount(0);
  });
  test('a double-click whose pick is not a text item does not open the editor of the text below it', async ({ page }) => {
    await open(page, doc([text('txt', 'o1', 240, 700, 600, 160, 'Draft'), image('img', 'o2', 200, 650, 700, 260)])); const g = await geo(page).then(x => x.at(540, 780));
    await page.mouse.dblclick(g.x, g.y);
    await expect(editor(page)).toHaveCount(0); expect(await selection(page)).toEqual(['img']);
  });
  // Known difference, pinned (Q2's leftover case). Two overlapping texts on one track: the pick prefers the stored zIndex 5 (the earlier-drawn first),
  // the text hit boxes of text/edit.tsx are in draw order, so the topmost box is the later-drawn one. The listener lets the event go on (the pick is a text) and the
  // existing hit box acts: it edits the later-drawn text and selects it. The outcome was predicted from the code reading and confirmed by the run.
  test('Q2 leftover (known difference, pinned): where the pick and the DOM hit box differ, the DOM hit box wins: its text opens and is selected', async ({ page }, info) => {
    await open(page, doc([text('first', 'o1', 240, 700, 600, 160, 'First', { props: { zIndex: 5 } }), text('second', 'o1', 240, 700, 600, 160, 'Second', { display: { from: 500, to: 4000 } })]), 1000);
    const g = await geo(page).then(x => x.at(540, 780));
    await page.mouse.dblclick(g.x, g.y);
    await expect(editor(page)).toBeFocused(); await expect(editor(page)).toHaveValue('Second'); expect(await selection(page)).toEqual(['second']);
    info.annotations.push({ type: 'known-difference', description: 'T26 Q2: the pick (zIndex first) and the DOM hit box (draw order) can differ for overlapping texts; the DOM hit box wins on a double-click' });
  });
});

test.describe('T26 Q6: the mask test of the pick', () => {
  test('a vector mask that cuts half an item: a click on the cut half picks the item below, a click on the kept half picks the item', async ({ page }) => {
    // masked: 600 x 600 at (100, 300), mask = its left half in item-local px (0,0)-(300,600). base lies under it.
    const mask = { id: 'mk1', name: 'Mask 1', enabled: true, points: presetPoints('rectangle', 300, 600), closed: true, mode: 'add', order: 0, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape' };
    await open(page, doc([image('base', 'v1', 100, 300, 600, 600), image('masked', 'o2', 100, 300, 600, 600, { masks: [mask] })])); const g = await geo(page);
    await click(page, g.at(550, 600)); expect(await selection(page), 'right half is cut away').toEqual(['base']);
    await click(page, g.at(250, 600)); expect(await selection(page), 'left half is kept').toEqual(['masked']);
    await click(page, g.at(150, 350)); expect(await selection(page)).toEqual(['masked']);
  });
  test('a lone subtract vector mask is a hole: a click inside the hole picks the item below, a click on the visible part picks the masked item', async ({ page }) => {
    // masked: 600 x 600 at (100, 300), hole = item-local (150,150)-(450,450), canvas (250,450)-(550,750). base lies under it.
    const hole = presetPoints('rectangle', 300, 300).map(p => ({ anchor: { x: p.anchor.x + 150, y: p.anchor.y + 150 } }));
    const mask = { id: 'mk1', name: 'Mask 1', enabled: true, points: hole, closed: true, mode: 'subtract', order: 0, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape' };
    await open(page, doc([image('base', 'v1', 100, 300, 600, 600), image('masked', 'o2', 100, 300, 600, 600, { masks: [mask] })])); const g = await geo(page);
    await click(page, g.at(400, 600)); expect(await selection(page), 'inside the hole').toEqual(['base']);
    await click(page, g.at(150, 350)); expect(await selection(page), 'visible part, top left').toEqual(['masked']);
    await click(page, g.at(650, 850)); expect(await selection(page), 'visible part, bottom right').toEqual(['masked']);
  });
  // The raster case (background removal, alpha 4 and 5, a raster with no frame yet) is unit level only: no .dmk helper in tests/ui/t12-support.ts is importable
  // without a T12 file; the pick's alpha rule is pinned with a stub in tests/t26-selection-box.test.ts.
});

test.describe('T26 row 9: the export draws the stored values and never the box', () => {
  test.skip(!ffmpegAvailable(), 'ffmpeg decodes the exported file');
  const SMALL = { width: 320, height: 180 };
  const smallDoc = () => ({ ...doc([rectShape('r', 'o1', { from: 0, to: 1000 }, '#ff0000')], [trk('o1')]), size: SMALL, duration: 1000 });
  // rectShape: 160 x 90 at (80, 45). The se handle goes to (200, 112.5), half way along the diagonal: factor 0.75, the rectangle 120 x 67.5 at (80, 45).
  const red = (f: Uint8Array) => { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, blue = 0; for (let i = 0; i < f.length; i += 4) { const x = (i / 4) % SMALL.width, y = Math.floor(i / 4 / SMALL.width), r = f[i], gg = f[i + 1], b = f[i + 2];
    if (r > 200 && gg < 60 && b < 60) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); } if (r < 140 && gg > 140 && gg < 190 && b > 220) blue++; } return { x0, y0, x1, y1, blue }; };
  test('after a corner drag the exported frame holds the dragged rectangle, no box pixels, and equals the export of a project stored with the same document', async ({ page }) => {
    const id = await open(page, smallDoc(), 0); await choose(page, ['r']); await expect(boxOf(page)).toHaveCount(1);
    const g = await geo(page, SMALL);
    await drag(page, await knob(page, 'se'), g.at(200, 112.5)); await expect.poll(async () => (await undoLabels(page)).length).toBe(1);
    const stored = await savedDoc(page, id); expect(stored.items[0].properties.scale.defaultValue).toBeGreaterThan(0.7); expect(stored.items[0].properties.scale.defaultValue).toBeLessThan(0.8);
    const run1 = await runExport(page, id, {}, undefined, true); completed(run1);
    const f1 = decodeRgba(run1.file!, SMALL.width, SMALL.height);
    const id2 = await createProject(page, stored, 'T26 export twin'); const run2 = await runExport(page, id2, {}, undefined, true); completed(run2);
    const f2 = decodeRgba(run2.file!, SMALL.width, SMALL.height);
    expect(f1.length).toBeGreaterThan(0); expect(f2.length).toBe(f1.length);
    for (const n of [0, Math.floor(f1.length / 2)]) expect(Buffer.compare(f1[n], f2[n]), `frame ${n}`).toBe(0);
    const r = red(new Uint8Array(f1[0])), s = stored.items[0].properties;
    near(r.x0, s.positionX.defaultValue, 2, 'rectangle left'); near(r.y0, s.positionY.defaultValue, 2, 'rectangle top');
    near(r.x1 - r.x0, 160 * s.scale.defaultValue, 2.5, 'rectangle width'); near(r.y1 - r.y0, 90 * s.scale.defaultValue, 2.5, 'rectangle height');
    expect(r.blue, 'no pixel of the box colour (#60a5fa) in the export').toBe(0);
  });
});

test.describe('T26 window listeners: pointercancel commits (7.1 l.1802), window blur commits too (not from Xapp; relay R9)', () => {
  // pointercancel commits like a release: research 7.1 l.1802 ("A pointer cancel commits too. Escape does not cancel a drag."). Window blur commits the same way (relay R9; Author may overrule):
  // not from Xapp: needed because the drag uses window listeners, not pointer capture (lane A's words).
  // c: 200 x 100 at (340, 700), centre (440, 750); a move to centre x 530 snaps to the canvas centre (540) and shows guide-x.
  const one = () => doc([shape('c', 'o1', 340, 700, 200, 100)]);
  const guides = (page: Page) => ({ x: page.locator('[data-testid="selection-guide-x"]'), y: page.locator('[data-testid="selection-guide-y"]') });

  test('pointercancel commits a move as one "Edit items" step', async ({ page }) => {
    await open(page, one()); const g = await geo(page), grab = g.at(440, 750), { x: guideX, y: guideY } = guides(page);
    await hold(page, grab, g.at(530, 750));
    expect(await draftLive(page)).toBe(true); await expect(guideX).toHaveCount(1);
    const wantX = await draftValue(page, 'c', 'positionX') ?? NaN, wantY = await draftValue(page, 'c', 'positionY') ?? NaN; // the committed (snapped) values
    await clearIntents(page); await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    expect(await draftLive(page)).toBe(false); await expect(guideX).toHaveCount(0); await expect(guideY).toHaveCount(0);
    await expect.poll(async () => (await transforms(page)).length).toBe(1);
    const settled = async () => { near(await pv(page, 'c', 'positionX'), wantX, 0.001, 'positionX'); near(await pv(page, 'c', 'positionY'), wantY, 0.001, 'positionY'); expect(await transforms(page)).toHaveLength(1); expect(await undoLabels(page)).toEqual(['Edit items']); };
    await settled();
    await page.mouse.up(); await page.mouse.move(g.at(700, 900).x, g.at(700, 900).y, { steps: 6 }); // the window listeners are gone: nothing follows the pointer
    expect(await draftLive(page)).toBe(false); await settled(); await expect(guideX).toHaveCount(0);
  });

  test('window blur commits a move as one "Edit items" step', async ({ page }) => {
    await open(page, one()); const g = await geo(page), grab = g.at(440, 750), { x: guideX, y: guideY } = guides(page);
    await hold(page, grab, g.at(530, 750));
    expect(await draftLive(page)).toBe(true); await expect(guideX).toHaveCount(1);
    const wantX = await draftValue(page, 'c', 'positionX') ?? NaN, wantY = await draftValue(page, 'c', 'positionY') ?? NaN; // the committed (snapped) values
    await clearIntents(page); await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await draftLive(page)).toBe(false); await expect(guideX).toHaveCount(0); await expect(guideY).toHaveCount(0);
    await expect.poll(async () => (await transforms(page)).length).toBe(1);
    const settled = async () => { near(await pv(page, 'c', 'positionX'), wantX, 0.001, 'positionX'); near(await pv(page, 'c', 'positionY'), wantY, 0.001, 'positionY'); expect(await transforms(page)).toHaveLength(1); expect(await undoLabels(page)).toEqual(['Edit items']); };
    await settled();
    await page.mouse.up(); await page.mouse.move(g.at(700, 900).x, g.at(700, 900).y, { steps: 6 }); // the window listeners are gone: nothing follows the pointer
    expect(await draftLive(page)).toBe(false); await settled(); await expect(guideX).toHaveCount(0);
  });

  test('window blur commits a corner drag as one "Edit items" step', async ({ page }) => {
    await open(page, A()); await choose(page, ['a']); const g = await geo(page);
    await hold(page, await knob(page, 'se'), g.at(400, 550)); expect(await draftLive(page)).toBe(true); near(await draftValue(page, 'a', 'scale') ?? 0, 0.5, 0.02, 'the draft scale');
    const wantS = await draftValue(page, 'a', 'scale') ?? NaN, wantX = await draftValue(page, 'a', 'positionX') ?? NaN, wantY = await draftValue(page, 'a', 'positionY') ?? NaN;
    await clearIntents(page); await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await draftLive(page)).toBe(false);
    await expect.poll(async () => (await transforms(page)).length).toBe(1);
    const settled = async () => { near(await pv(page, 'a', 'scale'), wantS, 0.001, 'scale'); near(await pv(page, 'a', 'positionX'), wantX, 0.001, 'positionX'); near(await pv(page, 'a', 'positionY'), wantY, 0.001, 'positionY'); expect(await transforms(page)).toHaveLength(1); expect(await undoLabels(page)).toEqual(['Edit items']); };
    await settled();
    await page.mouse.up(); await page.mouse.move(g.at(300, 500).x, g.at(300, 500).y, { steps: 4 });
    expect(await draftLive(page)).toBe(false); await settled();
  });

  test('a marquee ended by pointercancel selects the items fully inside, as a release does', async ({ page }) => {
    await open(page, doc([shape('m1', 'o1', 100, 100, 100, 100), shape('m2', 'o1', 300, 100, 100, 100)])); const g = await geo(page), marquee = page.locator('[data-testid="selection-marquee"]');
    await choose(page, ['m2']);
    await hold(page, g.at(20, 20), g.at(450, 250)); await expect(marquee).toHaveCount(1); // the press on empty space cleared m2; both items lie inside
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    await expect(marquee).toHaveCount(0); expect([...await selection(page)].sort()).toEqual(['m1', 'm2']);
    await page.mouse.up(); await page.mouse.move(g.at(500, 300).x, g.at(500, 300).y, { steps: 4 });
    await expect(marquee).toHaveCount(0); expect([...await selection(page)].sort()).toEqual(['m1', 'm2']);
  });
});

test.describe('T26 row 7: corner drags on T22 elements (RC 6.2, l.1612)', () => {
  // A corner drag changes `scale` (one factor for both axes) and the position; it never changes width or height, and no refit runs.
  // Both items are stored in T22's own form (details.element, as slotItem and the element insert write it). They sit far from the canvas centre axes (540, 960).
  // The pointer goes half way along the diagonal from the dragged corner to the opposite one: factor 0.5.
  const element = (id: string, extra: Record<string, unknown> = {}) => ({ id, palette: [{ base: '#FFD23F', kind: 'color' }], ...extra });

  test('a stretch element (underline-scribble, stretch: true) keeps width and height under a corner drag: scale 0.5, one "Edit items" step', async ({ page }) => {
    // 600 x 90 at (100, 300): nw (100, 300), se (700, 390); half way along the diagonal is (400, 345).
    const scribble = { ...image('s', 'o1', 100, 300, 600, 90), details: { name: 's', element: element('underline-scribble', { stretch: true }) } };
    await open(page, doc([scribble])); await choose(page, ['s']); const g = await geo(page);
    await drag(page, await knob(page, 'se'), g.at(400, 345));
    await closeTo(() => pv(page, 's', 'scale'), 0.5, 0.02);
    expect(await pv(page, 's', 'width'), 'width is not stretched by the drag').toBe(600); expect(await pv(page, 's', 'height'), 'height is not stretched by the drag').toBe(90);
    expect(await pv(page, 's', 'positionX')).toBe(100); expect(await pv(page, 's', 'positionY')).toBe(300); // se drag: the nw corner stays
    expect(await undoLabels(page)).toEqual(['Edit items']); expect(await transforms(page)).toHaveLength(1);
  });

  test('a text-slot element (label-tag) is not refitted by a corner drag: fontSize, width, height and text stay, scale changes, one "Edit items" step', async ({ page }) => {
    // label-tag has a text slot (catalogue/elements.ts, label-tag). 300 x 100 at (100, 800): nw (100, 800), se (400, 900); half way is (250, 850). fontSize 100 is far from any refit result.
    const tag = { ...text('t', 'o1', 100, 800, 300, 100, 'Sale today'), details: { text: 'Sale today', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto', name: 't', element: element('label-tag', { slot: 'text' }) } };
    await open(page, doc([tag])); await choose(page, ['t']); const g = await geo(page);
    const before = { fontSize: await pv(page, 't', 'fontSize'), width: await pv(page, 't', 'width'), height: await pv(page, 't', 'height'), text: (await item(page, 't')).details.text };
    expect(before).toEqual({ fontSize: 100, width: 300, height: 100, text: 'Sale today' });
    await drag(page, await knob(page, 'se'), g.at(250, 850));
    await closeTo(() => pv(page, 't', 'scale'), 0.5, 0.02);
    expect({ fontSize: await pv(page, 't', 'fontSize'), width: await pv(page, 't', 'width'), height: await pv(page, 't', 'height'), text: (await item(page, 't')).details.text }, 'no refit ran').toEqual(before);
    expect(await undoLabels(page)).toEqual(['Edit items']); expect(await transforms(page)).toHaveLength(1);
  });
});
