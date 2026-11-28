// SPDX-License-Identifier: AGPL-3.0-only
// T28 row 3 in real Chromium: while a preview drag is on, the inspector and the timeline show the drag's draft (Author, 14 Nov 02:31), and
// nothing is written to the document before release (T26 keeps the draft in one place). Written from the ticket row and T26's rules (research 7.1):
// a move writes positionX / positionY; a property with keyframes gets the keyframe within 100 ms of the playhead (property time), else a new one there;
// release, pointercancel (7.1 l.1802) and window blur commit one "Edit items" (intent transformOnPreview).
// Fixtures and helpers are copied from tests/ui/t26-selection-box.spec.ts (local there). Canvas px, y down; the helpers map them to the stage's screen rectangle.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { clearIntents, intents, openEditor, setViewState, skipTour, viewState, watchIntents } from './t02-support';
import { liveDoc, savedDoc, undoLabels } from './t03-support';
import { section, sliderIn, valueNow } from './t04-support';

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => { test.setTimeout(150_000); await skipTour(page); });

type Pt = { x: number; y: number };
const SIZE = { width: 1080, height: 1920 };
const p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
const kfs = (defaultValue: number, list: [string, number, number][]) => ({ defaultValue, keyframes: list.map(([id, time, value]) => ({ id, time, value, easing: 'linear' })) });
const trk = (id: string, kind = 'overlay') => ({ id, name: id.toUpperCase(), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
const TRACKS = [trk('v1', 'video'), trk('o1'), trk('o2')]; // bottom first
const doc = (items: unknown[]) => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 6000, fps: 30, size: SIZE, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: TRACKS, layerOrder: TRACKS.map(t => ({ type: 'track', id: t.id })), items,
});
const box = (x: number, y: number, w: number, h: number) => ({ positionX: p(x), positionY: p(y), width: p(w), height: p(h), scale: p(1), rotation: p(0), opacity: p(1) });
/** An image with no asset (selectable and pickable; its inspector has the T04 Transform section with the X and Y rows). */
const image = (id: string, x: number, y: number, w: number, h: number, props: Record<string, unknown> = {}) => ({
  id, type: 'image', trackId: 'o1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, details: { name: id }, properties: { ...box(x, y, w, h), ...props }, masks: [], effects: [],
});
/** A video with no asset: the compact layout's tab list has Transform for video only (panels.tsx compactTabs). */
const video = (id: string, x: number, y: number, w: number, h: number) => ({ ...image(id, x, y, w, h), type: 'video', trackId: 'v1', sourceDuration: 4000 });

// ---- helpers: geometry, pointer, state (from t26-selection-box.spec.ts)
async function geo(page: Page, size = SIZE) {
  const r = (await page.locator('.stage').boundingBox())!;
  return { r, k: r.width / size.width, at: (x: number, y: number): Pt => ({ x: r.x + x * r.width / size.width, y: r.y + y * r.height / size.height }) };
}
/** Press at a and move to b, leaving the button down (the caller releases with page.mouse.up()). */
async function hold(page: Page, a: Pt, b: Pt, steps = 8) { await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps }); }
const item = async (page: Page, id: string) => (await liveDoc(page)).items.find((i: { id: string }) => i.id === id);
const pv = async (page: Page, id: string, key: string) => { const q = (await item(page, id)).properties?.[key]; return q && typeof q === 'object' && 'defaultValue' in q ? q.defaultValue as number : q as number; };
const closeTo = (read: () => Promise<number>, want: number, tol = 2) => expect.poll(async () => Math.abs((await read()) - want), { message: `want ${want} +/- ${tol}` }).toBeLessThanOrEqual(tol);
const choose = (page: Page, ids: string[]) => page.evaluate(async ids => { const m = '/src/editor/view.ts'; (await import(m)).select(ids); }, ids);
const draftLive = (page: Page) => page.evaluate(async () => { const m = '/src/editor/selection-overlay.tsx'; return (await import(m)).useSelectionDraft.getState().doc !== null; });
const draftValue = (page: Page, id: string, key: string) => page.evaluate(async ({ id, key }) => {
  const m = '/src/editor/selection-overlay.tsx', d = (await import(m)).useSelectionDraft.getState().doc, q = d?.items.find((i: { id: string }) => i.id === id)?.properties?.[key];
  return (q && typeof q === 'object' && 'defaultValue' in q ? q.defaultValue : q) as number | undefined;
}, { id, key });
/** The draft's keyframes of one property, sorted by time (the write appends a new keyframe at the end of the list). */
const draftKeyframes = (page: Page, id: string, key: string) => page.evaluate(async ({ id, key }) => {
  const m = '/src/editor/selection-overlay.tsx', d = (await import(m)).useSelectionDraft.getState().doc, q = d?.items.find((i: { id: string }) => i.id === id)?.properties?.[key];
  return ([...(q?.keyframes ?? [])] as { id: string; time: number; value: number }[]).sort((a, b) => a.time - b.time);
}, { id, key });
const transforms = async (page: Page) => (await intents(page)).filter(l => l.intent.type === 'transformOnPreview');
/** Opens an editor on `d`, watches intents and puts the playhead at `ms`. */
async function open(page: Page, d: unknown, ms = 500) { const id = await openEditor(page, d); await watchIntents(page); await setViewState(page, { playheadMs: ms }); return id; }
const near = (got: number, want: number, tol: number, what: string) => expect(Math.abs(got - want), `${what}: ${got} vs ${want}`).toBeLessThanOrEqual(tol);

// ---- this spec's own reads
/** The X and Y rows' shown values (aria-valuenow of the slider; display unit px = stored px, factor 1). */
const xy = async (scope: Locator) => ({ x: await valueNow(scope, 'X'), y: await valueNow(scope, 'Y') });
/** Both rows show (x, y) within tol: polled, since the panels re-render after the pointer move. */
async function shows(scope: Locator, want: { x: number; y: number }, tol = 1e-5) {
  await closeTo(() => valueNow(scope, 'X'), want.x, tol); await closeTo(() => valueNow(scope, 'Y'), want.y, tol);
}
/** One property's keyframe marks on an item's timeline clip, as clip-relative ms, sorted (timeline.tsx clipKeyframes: left = clip-relative ms x zoom).
 *  Rounded to whole ms: the style's serialised px are not exact. */
const marks = (page: Page, id: string, key: string, z: number) => page.locator(`[data-item-id="${id}"] .clip-kf[data-kf-key="${key}"]`)
  .evaluateAll((es, z) => es.map(e => Math.round(parseFloat((e as HTMLElement).style.left) / z)).sort((a, b) => a - b), z);
const zoom = (page: Page) => viewState(page, v => v.zoom as number);
/** The marks at the timeline zoom current at the read: the draft and the commit settle the duration (bus post-op), and the zoom follows it (timeline.tsx). */
const marksNow = async (page: Page, id: string, key: string) => marks(page, id, key, await zoom(page));
const draftDuration = (page: Page) => page.evaluate(async () => { const m = '/src/editor/selection-overlay.tsx'; return (await import(m)).useSelectionDraft.getState().doc?.duration as number | undefined; });
/** Released: the timeline zoom is the one just before release, and the stored duration is the draft's (fixtures: stored 6000, content end 4000). */
async function settled(page: Page, zoomHeld: number, durationHeld: number | undefined) {
  expect(durationHeld, 'the draft\'s duration during the drag: the content end').toBe(4000);
  expect((await liveDoc(page)).duration, 'the stored duration after release equals the draft\'s').toBe(durationHeld);
  await expect.poll(() => zoom(page), { message: 'the timeline zoom after release equals the zoom just before release' }).toBe(zoomHeld);
}
const storedKeys = async (page: Page, id: string, key: string) => ((await item(page, id)).properties[key].keyframes as { time: number }[]).map(k => k.time).sort((a, b) => a - b);
/** Nothing written while held: the live and the saved items as before, no transformOnPreview intent, no undo entry. */
async function unwritten(page: Page, projectId: string, live: string, saved: string) {
  expect(JSON.stringify((await liveDoc(page)).items), 'no write to the live document on a move').toBe(live);
  expect(JSON.stringify((await savedDoc(page, projectId)).items), 'no write to the saved document on a move').toBe(saved);
  expect(await transforms(page)).toHaveLength(0); expect(await undoLabels(page)).toEqual([]);
}
const snapshot = async (page: Page, projectId: string) => ({ live: JSON.stringify((await liveDoc(page)).items), saved: JSON.stringify((await savedDoc(page, projectId)).items) });

// ---- fixtures
// m: 400 x 300 at (200, 400), centre (400, 550). The move goes to centre (300, 610): 240 and 350 canvas px from the canvas centre (540, 960),
// far outside the snap (8 screen px, about 44 canvas px at the fit zoom), so the draft is (100, 460) up to the pointer's rounding to whole screen px.
const ONE = () => doc([image('m', 200, 400, 400, 300)]);

test.describe('T28 row 3: the inspector and the timeline show the drag\'s draft', () => {
  test('a held move: the inspector\'s X and Y show the draft values; nothing is written before release', async ({ page }) => {
    const id = await open(page, ONE()); await choose(page, ['m']); const tf = await section(page, 'Transform');
    expect(await xy(tf), 'before the press: the stored values').toEqual({ x: 200, y: 400 });
    const g = await geo(page), { live, saved } = await snapshot(page, id);
    await hold(page, g.at(400, 550), g.at(300, 610));
    expect(await draftLive(page)).toBe(true);
    const want = { x: await draftValue(page, 'm', 'positionX') ?? NaN, y: await draftValue(page, 'm', 'positionY') ?? NaN };
    near(want.x, 100, 2, 'the draft X'); near(want.y, 460, 2, 'the draft Y');
    await shows(tf, want);
    await unwritten(page, id, live, saved);
    expect(await pv(page, 'm', 'positionX')).toBe(200); expect(await pv(page, 'm', 'positionY')).toBe(400);
    await page.mouse.up(); await expect.poll(() => draftLive(page)).toBe(false);
  });

  test('after release the inspector shows the committed values: one "Edit items" step', async ({ page }) => {
    await open(page, ONE()); await choose(page, ['m']); const tf = await section(page, 'Transform'), g = await geo(page);
    await hold(page, g.at(400, 550), g.at(300, 610));
    const want = { x: await draftValue(page, 'm', 'positionX') ?? NaN, y: await draftValue(page, 'm', 'positionY') ?? NaN };
    await shows(tf, want);
    await page.mouse.up(); await expect.poll(() => draftLive(page)).toBe(false);
    expect(await undoLabels(page)).toEqual(['Edit items']); const edits = await transforms(page); expect(edits).toHaveLength(1); expect(edits[0].outcome.ok).toBe(true);
    near(await pv(page, 'm', 'positionX'), want.x, 0.001, 'stored X'); near(await pv(page, 'm', 'positionY'), want.y, 0.001, 'stored Y');
    await shows(tf, { x: await pv(page, 'm', 'positionX'), y: await pv(page, 'm', 'positionY') });
  });

  // Reading of the brief's "after a pointercancel they show the stored values": in T26 a pointercancel commits the move (research 7.1 l.1802, the T26 case
  // 'pointercancel commits a move as one "Edit items" step'). So after it the draft is gone and the panels show the stored document, which now holds the commit.
  test('after a pointercancel the draft is gone and the inspector shows the stored document\'s values (the committed ones)', async ({ page }) => {
    await open(page, ONE()); await choose(page, ['m']); const tf = await section(page, 'Transform'), g = await geo(page);
    await hold(page, g.at(400, 550), g.at(300, 610));
    const want = { x: await draftValue(page, 'm', 'positionX') ?? NaN, y: await draftValue(page, 'm', 'positionY') ?? NaN };
    await shows(tf, want);
    await clearIntents(page); await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    expect(await draftLive(page)).toBe(false);
    await expect.poll(async () => (await transforms(page)).length).toBe(1); expect(await undoLabels(page)).toEqual(['Edit items']);
    const stored = { x: await pv(page, 'm', 'positionX'), y: await pv(page, 'm', 'positionY') };
    near(stored.x, want.x, 0.001, 'stored X = the committed draft X'); near(stored.y, want.y, 0.001, 'stored Y = the committed draft Y');
    await shows(tf, stored);
    await page.mouse.up(); // the window listeners are gone: the release changes nothing
    expect(await draftLive(page)).toBe(false); await shows(tf, stored); expect(await undoLabels(page)).toEqual(['Edit items']);
  });

  // k: positionX keyframes at 0 ms (200) and 3000 ms (600); trim.from 0, rate 1, display.from 0, so property time = timeline ms. Playhead 1500 ms, 1500 ms from
  // each keyframe (> 100 ms): X there is 400, so the box is 400 x 300 at (400, 400), centre (600, 550). The move goes to centre (450, 610) (90 canvas px from the
  // canvas centre x 540, outside the snap): the drag adds an X keyframe at 1500 ms (value about 250); Y has no keyframes, so its static value changes (about 460).
  const KEYED = () => doc([image('k', 400, 400, 400, 300, { positionX: kfs(200, [['k1', 0, 200], ['k2', 3000, 600]]) })]);
  test('with keyframes, playhead away from them: the drag\'s new X keyframe shows in the inspector and as a timeline mark; the stored document has no new keyframe before release', async ({ page }) => {
    const id = await open(page, KEYED(), 1500); await choose(page, ['k']); const tf = await section(page, 'Transform'), z = await zoom(page);
    await expect(tf.getByRole('button', { name: 'Add X keyframe' })).toHaveAttribute('aria-pressed', 'false'); expect(await xy(tf)).toEqual({ x: 400, y: 400 });
    expect(await marks(page, 'k', 'positionX', z), 'before: the 2 stored marks').toEqual([0, 3000]);
    const g = await geo(page), { live, saved } = await snapshot(page, id);
    await hold(page, g.at(600, 550), g.at(450, 610));
    const list = await draftKeyframes(page, 'k', 'positionX'); expect(list.map(k => k.time), 'the draft holds one new keyframe at the playhead').toEqual([0, 1500, 3000]);
    const added = list[1]; near(added.value, 250, 2, 'the new keyframe value');
    // Inspector: the X row is on a keyframe at the playhead (the diamond is filled, its time row reads the clip-relative 1.50 s) and shows its value.
    await expect(tf.getByRole('button', { name: 'X keyframe at playhead' })).toHaveAttribute('aria-pressed', 'true');
    await expect(tf.locator('.prop-row', { has: page.locator('[data-slider="X"]') }).locator('.kf-time')).toContainText('1.50s');
    await shows(tf, { x: added.value, y: await draftValue(page, 'k', 'positionY') ?? NaN });
    // Timeline: a third positionX mark at the playhead.
    await expect.poll(() => marksNow(page, 'k', 'positionX')).toEqual([0, 1500, 3000]);
    await unwritten(page, id, live, saved); expect(await storedKeys(page, 'k', 'positionX'), 'stored: still 2 keyframes').toEqual([0, 3000]);
    const zoomHeld = await zoom(page), durationHeld = await draftDuration(page);
    await page.mouse.up(); await expect.poll(() => draftLive(page)).toBe(false);
    expect(await undoLabels(page)).toEqual(['Edit items']); expect(await storedKeys(page, 'k', 'positionX'), 'after release the keyframe is stored').toEqual([0, 1500, 3000]);
    await settled(page, zoomHeld, durationHeld);
    await expect.poll(() => marksNow(page, 'k', 'positionX')).toEqual([0, 1500, 3000]);
  });

  // A mark carries only a time, so a value-only change does not show on the timeline; this case pins that the marks follow the draft's keyframe list:
  // q: X keyframes at 0 (200) and 1450 (400): the playhead 1500 is 50 ms from 1450 (within 100 ms), so the drag changes that keyframe's value and adds no X mark;
  // Y keyframes at 0 and 3000 (both 400): 1500 ms from each, so the drag adds a Y keyframe and a Y mark at 1500. X at 1500 holds the last value 400; the box is
  // at (400, 400), centre (600, 550), and the move goes to centre (450, 610) as above: X about 250, Y about 460.
  const TWO_KEYED = () => doc([image('q', 400, 400, 400, 300, { positionX: kfs(200, [['x1', 0, 200], ['x2', 1450, 400]]), positionY: kfs(400, [['y1', 0, 400], ['y2', 3000, 400]]) })]);
  test('the timeline\'s transform marks follow the draft: a keyframe within 100 ms keeps its mark (value only), a new keyframe adds a mark; none is stored before release', async ({ page }) => {
    const id = await open(page, TWO_KEYED(), 1500); await choose(page, ['q']); const tf = await section(page, 'Transform'), z = await zoom(page);
    expect(await marks(page, 'q', 'positionX', z)).toEqual([0, 1450]); expect(await marks(page, 'q', 'positionY', z)).toEqual([0, 3000]);
    const g = await geo(page), { live, saved } = await snapshot(page, id);
    await hold(page, g.at(600, 550), g.at(450, 610));
    const x = await draftKeyframes(page, 'q', 'positionX'), y = await draftKeyframes(page, 'q', 'positionY');
    expect(x.map(k => [k.id, k.time]), 'X: the keyframe at 1450 takes the value and keeps its time').toEqual([['x1', 0], ['x2', 1450]]); near(x[1].value, 250, 2, 'X keyframe value');
    expect(y.map(k => k.time), 'Y: a new keyframe at the playhead').toEqual([0, 1500, 3000]); near(y[1].value, 460, 2, 'new Y keyframe value');
    await expect.poll(() => marksNow(page, 'q', 'positionY')).toEqual([0, 1500, 3000]);
    expect(await marksNow(page, 'q', 'positionX'), 'X: no new mark, the marks stay').toEqual([0, 1450]);
    await shows(tf, { x: x[1].value, y: y[1].value });
    await expect(tf.getByRole('button', { name: 'Add X keyframe' })).toHaveAttribute('aria-pressed', 'false'); // 50 ms is more than half a frame: not "at playhead"
    await expect(tf.getByRole('button', { name: 'Y keyframe at playhead' })).toHaveAttribute('aria-pressed', 'true');
    await unwritten(page, id, live, saved);
    expect(await storedKeys(page, 'q', 'positionY')).toEqual([0, 3000]); expect((await item(page, 'q')).properties.positionX.keyframes[1].value).toBe(400);
    const zoomHeld = await zoom(page), durationHeld = await draftDuration(page);
    await page.mouse.up(); await expect.poll(() => draftLive(page)).toBe(false); expect(await undoLabels(page)).toEqual(['Edit items']);
    expect(await storedKeys(page, 'q', 'positionY')).toEqual([0, 1500, 3000]); await settled(page, zoomHeld, durationHeld);
    await expect.poll(() => marksNow(page, 'q', 'positionY')).toEqual([0, 1500, 3000]);
  });

  // Compact layout (W3-ED-01: below 1024 CSS px). The drawer is a modal <dialog> (shell.tsx Drawer, showModal), which makes the preview inert, so it cannot be
  // open at the press. The drawer is therefore opened through view state while the button is held, after the draft exists; the release then lands on the
  // dialog and reaches the overlay's window listener by bubbling. v: a video, 400 x 300 at (200, 400), the same move as above.
  test('compact layout: the Transform drawer\'s X and Y show the draft during a held move and the stored values after release', async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 800 });
    const id = await open(page, doc([video('v', 200, 400, 400, 300)])); await choose(page, ['v']);
    await expect(page.getByRole('navigation', { name: 'Editor panels' }).getByRole('tab', { name: 'Transform' })).toBeVisible();
    const g = await geo(page), { live, saved } = await snapshot(page, id);
    await hold(page, g.at(400, 550), g.at(300, 610)); expect(await draftLive(page)).toBe(true);
    await setViewState(page, { drawer: 'tab:transform' });
    const drawer = page.getByRole('dialog', { name: 'Transform' }); await expect(drawer).toBeVisible(); await expect(sliderIn(drawer, 'X')).toBeVisible();
    expect(await draftLive(page), 'opening the drawer does not end the drag').toBe(true);
    const want = { x: await draftValue(page, 'v', 'positionX') ?? NaN, y: await draftValue(page, 'v', 'positionY') ?? NaN };
    near(want.x, 100, 3, 'the draft X'); near(want.y, 460, 3, 'the draft Y');
    await shows(drawer, want);
    await unwritten(page, id, live, saved);
    await page.mouse.up(); await expect.poll(() => draftLive(page)).toBe(false);
    expect(await undoLabels(page)).toEqual(['Edit items']); expect(await transforms(page)).toHaveLength(1);
    const stored = { x: await pv(page, 'v', 'positionX'), y: await pv(page, 'v', 'positionY') };
    near(stored.x, want.x, 0.001, 'stored X'); near(stored.y, want.y, 0.001, 'stored Y');
    await expect(drawer).toBeVisible(); await shows(drawer, stored);
  });
});
