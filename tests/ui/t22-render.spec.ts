// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 4 G-L: real SVG->PNG import, placement, palette pixels and slot pictures on paused and playing Chromium stages.
// No fixture store, ffmpeg, network, encoded-PNG pin or screenshot hash. Agent calls use the real Executor in the page.
// H: corner-brackets reaches its entire SVG box (12px inset path, 24px square-cap stroke): bbox tolerance 1 project px.
// Underline extents are independently derived from its authored cubic extrema and 11px round stroke, not its empty margins.
// J: <=16 code values per RGB channel, the T10a recolour tolerance (f32 GPU gamut bisection versus f64 oracle §49.19).
import { test, expect, type Page } from '@playwright/test';
import { findElement } from '../../apps/web/src/catalogue/elements';
import { recolor as oracleRecolor } from '../../parity/oracle/colour';
import type { RGB } from '../../parity/oracle/math';
import { createProject, guard, skipTour } from './t02-support';
import { prop } from './t04-support';
import { canvasSizeOf, runCanvas, shown } from './t15-support';

test.use({ viewport: { width: 1280, height: 900 } });
test.setTimeout(90_000);
const W = 400, H = 300;
type Rec = Record<string, any>;
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  await skipTour(page); leaks.set(page, guard(page));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
});
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'no off-localhost requests, even failed ones').toEqual([]); });
const track = (id: string, kind: string) => ({ id, name: id, kind, hidden: false, locked: false, muted: false, solo: false, volume: 1 });
const emptyDoc = () => ({ schemaVersion: 4, rev: 0, groups: {}, duration: 4000, fps: 30, size: { width: W, height: H },
  background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: [track('V1', 'video'), track('O1', 'overlay')], layerOrder: [{ type: 'track', id: 'V1' }, { type: 'track', id: 'O1' }], items: [] as Rec[] });
async function openEmpty(page: Page) {
  const id = await createProject(page, emptyDoc(), 'T22 element render');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); return id;
}
async function agentCall(page: Page, toolName: string, input: Rec): Promise<Rec> {
  return page.evaluate(async ({ toolName, input }) => {
    const rp = '/src/timeline/runtime.ts', ep = '/src/agent/executor.ts', rt = (await import(rp)).activeRuntime;
    const win = window as any;
    if (!win.__t22Agent) {
      const data = new Map<string, string>(), Executor = (await import(ep)).Executor;
      win.__t22Agent = { seq: 0, executor: new Executor({ current: () => rt, storage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } } }) };
    }
    const state = win.__t22Agent;
    const call = (name: string, args: Rec) => state.executor.execute({ type: 'call', callId: `t22-${++state.seq}`, executionKey: `t22-${state.seq}`, session: 't22', toolName: name, input: args });
    await call('context', {}); return call(toolName, input);
  }, { toolName, input });
}
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(({ x, y }) => {
    const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement;
    return Array.from(c.getContext('2d')!.getImageData(x, y, 1, 1).data);
  }, { x, y });
}
async function bbox(page: Page): Promise<number[] | null> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement;
    if (!c) return null;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (data[(y * c.width + x) * 4 + 3] > 127) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
  });
}
async function expectBox(page: Page, expected: number[], label: string) {
  await expect(runCanvas(page)).toBeVisible();
  await expect.poll(async () => { const got = await bbox(page); return got ? Math.max(...got.map((value, k) => Math.abs(value - expected[k]))) : Infinity; },
    { timeout: 15_000, message: label }).toBeLessThanOrEqual(1);
}
const expectedRaster = (width: number, height: number) => {
  const s = Math.min(2, 2048 / Math.max(width, height)); return { width: Math.round(width * s), height: Math.round(height * s) };
};

test.describe('G: real browser rasteriser, PNG dimensions and transparent pixels', () => {
  for (const id of ['sticker-star', 'phone-frame']) test(id, async ({ page }) => {
    await openEmpty(page);
    const added = await agentCall(page, 'addMedia', { assetId: `element:${id}`, trackId: id === 'sticker-star' ? 'V1' : 'O1' });
    expect(added.success, JSON.stringify(added)).toBe(true);
    const result = await page.evaluate(async (itemId: string) => {
      const rp = '/src/timeline/runtime.ts', sp = '/src/store/database.ts';
      const item = (await import(rp)).activeRuntime.bus.doc.items.find((i: Rec) => i.id === itemId), store = (await import(sp)).projectStore;
      const asset = await store.row('assets', item.metadata.assetId), blob = await store.media.read(asset.id), bitmap = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bitmap.width, bitmap.height), g = c.getContext('2d')!; g.drawImage(bitmap, 0, 0);
      const alpha = (x: number, y: number) => g.getImageData(x, y, 1, 1).data[3];
      const out = { mime: asset.mimeType, name: asset.name, width: bitmap.width, height: bitmap.height,
        corner: alpha(0, 0), centre: alpha(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2)), body: alpha(5, Math.floor(bitmap.height / 2)) };
      bitmap.close(); return out;
    }, added.data.addedItemIds[0]);
    const e = findElement(id)!;
    // OPFS may return a typeless Blob; PNG is the persisted asset MIME/extension and is actually decoded here.
    expect(result).toMatchObject({ mime: 'image/png', ...expectedRaster(e.width, e.height) }); expect(result.name).toMatch(/\.png$/);
    expect(result.corner).toBe(0);
    if (id === 'sticker-star') expect(result.centre).toBe(255);
    else { expect(result.centre, 'screen opening').toBe(0); expect(result.body, 'frame body').toBe(255); }
  });
});

// Cubic Bézier extrema, independently from the SVG's y controls, including the two endpoints.
function cubicRange(p0: number, p1: number, p2: number, p3: number) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 3 * p0 - 6 * p1 + 3 * p2, c = -3 * p0 + 3 * p1;
  const ts = [0, 1], discriminant = 4 * b * b - 12 * a * c;
  if (discriminant >= 0) for (const t of [(-2 * b - Math.sqrt(discriminant)) / (6 * a), (-2 * b + Math.sqrt(discriminant)) / (6 * a)]) if (t > 0 && t < 1) ts.push(t);
  const ys = ts.map(t => ((a * t + b) * t + c) * t + p0); return [Math.min(...ys), Math.max(...ys)];
}
test.describe('H: stage opaque bounds follow placement, not canvas size or natural SVG size', () => {
  for (const bounded of [false, true]) test(`corner-brackets ${bounded ? 'with' : 'without'} bounds`, async ({ page }) => {
    await openEmpty(page);
    const args = { assetId: 'element:corner-brackets', trackId: 'V1', ...(bounded ? { bounds: { x: 50, y: 40, width: 300, height: 150 } } : {}) };
    const result = await agentCall(page, 'addMedia', args); expect(result.success, JSON.stringify(result)).toBe(true);
    // Own §33 arithmetic: no bounds s=min(240/1000,120/600)=.2 -> (100,90,200,120).
    // Bounds s=min(300/1000,150/600)=.25 -> (50,40,250,150). The authored 24px stroke reaches x/y box edges.
    if (bounded) expect(result.data.results[0].resolvedBounds).toEqual({ x: 50, y: 40, width: 250, height: 150 });
    await expectBox(page, bounded ? [50, 40, 300, 190] : [100, 90, 300, 210], 'opaque bracket bounds within 1 project pixel');
  });
  test('underline-scribble stretches both sides; visible extents come from its curves plus round 11px half-stroke', async ({ page }) => {
    await openEmpty(page);
    const bounds = { x: 40, y: 100, width: 320, height: 48 };
    const result = await agentCall(page, 'addMedia', { assetId: 'element:underline-scribble', trackId: 'V1', bounds });
    expect(result.success, JSON.stringify(result)).toBe(true); expect(result.data.results[0].resolvedBounds).toEqual(bounds);
    // SVG 800×120: monotone x ranges 24..776 / 60..740. Curves y controls [52,20,28,40] / [92,64,70,84].
    // Round caps/stroke enlarge each path's centre-line bbox by 11 SVG px; image stretch scales x and y independently.
    const first = cubicRange(52, 20, 28, 40), second = cubicRange(92, 64, 70, 84);
    const expected = [40 + 13 * 320 / 800, 100 + (Math.min(first[0], second[0]) - 11) * 48 / 120,
      40 + 787 * 320 / 800, 100 + (Math.max(first[1], second[1]) + 11) * 48 / 120];
    await expectBox(page, expected, 'curve-derived visible bounds; same 1px raster/coverage tolerance');
  });
});

test('I: real star recolour changes its fill towards green, without recolouring its outline', async ({ page }) => {
  await openEmpty(page);
  const result = await agentCall(page, 'addMedia', { assetId: 'element:sticker-star', trackId: 'V1', bounds: { x: 72, y: 40, width: 256, height: 256 } });
  expect(result.success, JSON.stringify(result)).toBe(true); await expect(runCanvas(page)).toBeVisible();
  // SVG fill centre (256,256) -> (200,168); tip stroke centre (256,36) -> (200,58).
  await expect.poll(async () => (await pixel(page, 200, 168))[3], { timeout: 15_000 }).toBe(255);
  const before = await pixel(page, 200, 168), outline = await pixel(page, 200, 58);
  before.slice(0, 3).forEach((v, k) => expect(Math.abs(v - [255, 200, 61][k]), 'flat fill, <=2 quantisation codes').toBeLessThanOrEqual(2)); expect(outline[3]).toBe(255);
  const edited = await agentCall(page, 'editProperties', { itemId: result.data.addedItemIds[0], properties: { colors: ['#00FF00'] } });
  expect(edited.success, JSON.stringify(edited)).toBe(true);
  await expect.poll(async () => { const p = await pixel(page, 200, 168); return p[1] - Math.max(p[0], p[2]); }, { timeout: 15_000 }).toBeGreaterThan(60);
  const after = await pixel(page, 200, 168), outlineAfter = await pixel(page, 200, 58), target = [0, 255, 0];
  const distance = (p: number[]) => Math.hypot(...target.map((v, k) => p[k] - v)); expect(distance(after)).toBeLessThan(distance(before));
  // Same <=16 channel-code allowance as the oracle test below, never a PNG byte hash.
  outlineAfter.slice(0, 3).forEach((v, k) => expect(Math.abs(v - outline[k])).toBeLessThanOrEqual(16));
});

/** Seed a raw fixture before opening the editor; real PNGs are created in-page and stored/linked, with no network. */
async function openSeed(page: Page, item: Rec, colour: number[], catalogueId?: string) {
  const projectId = await createProject(page, emptyDoc(), 'T22 seeded pixels');
  await page.evaluate(async ({ projectId, item, colour, catalogueId }) => {
    const sp = '/src/store/database.ts', cp = '/src/catalogue/assets.ts', store = (await import(sp)).projectStore;
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d')!;
    g.fillStyle = `rgb(${colour.join(',')})`; g.fillRect(0, 0, 64, 64);
    const png = await new Promise<Blob>((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('PNG creation failed')), 'image/png'));
    const flat = await store.upload(new File([png], 'flat.png', { type: 'image/png' })); await store.attach(projectId, flat.id);
    await store.updateAsset(flat.id, (a: Rec) => ({ ...a, processing_status: 'ready', processing_steps: { ...a.processing_steps, probe: 'complete' }, media: { image: { width: 64, height: 64 } } }));
    if (catalogueId) {
      const picture = await (await import(cp)).ensureCatalogueAsset(store, projectId, `element:${catalogueId}`); item.metadata.assetId = picture.id;
      if (item.type === 'layout') item.details.cells[0].source = { assetId: flat.id, type: 'image', url: `asset:${flat.id}` };
    } else item.metadata.assetId = flat.id;
    const current = await store.read(projectId); current.document.items = [item]; await store.save(projectId, current.document, current.document.rev);
  }, { projectId, item, colour, catalogueId });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); await expect(runCanvas(page)).toBeVisible();
}
function flatItem(element: Rec): Rec {
  return { id: 'flat', type: 'image', trackId: 'V1', display: { from: 0, to: 4000 }, details: { element }, metadata: { assetId: 'replace' },
    properties: { positionX: prop(40), positionY: prop(40), width: prop(200), height: prop(200), scale: prop(1), opacity: prop(1) }, effects: [], masks: [] };
}
test.describe('J: synthetic flat-pixel recolour versus independent §49.19 oracle', () => {
  const element = { id: 'synthetic-flat', palette: [{ base: '#d02020', kind: 'color' }, { base: '#2050d0', kind: 'color' }], colors: ['#20a040', '#2050d0'] };
  for (const rgb of [[209, 33, 33], [33, 79, 209], [153, 51, 153]]) test(`RGB ${rgb.join(',')}`, async ({ page }) => {
    const expected = oracleRecolor(rgb.map(v => v / 255) as RGB, element).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
    await openSeed(page, flatItem(element), rgb);
    await expect.poll(async () => { const got = await pixel(page, 140, 140); return got[3] === 255 ? Math.max(...expected.map((v, k) => Math.abs(got[k] - v))) : Infinity; },
      { timeout: 15_000, message: 'T10a <=16 RGB codes: GPU f32 gamut bisection versus independent f64 oracle' }).toBeLessThanOrEqual(16);
  });
});

function slotItem(id: string, overrideRect?: { x: number; y: number; width: number; height: number }): Rec {
  const e = findElement(id)!, text = e.slot?.kind === 'text';
  const rect = overrideRect ?? (text ? { x: 40, y: 80, width: 320, height: 320 / 3 } : { x: 150, y: 30, width: 100, height: 200 });
  const b = e.slot?.kind === 'text' ? e.slot.box : { x: 0, y: 0, width: 1, height: 1 };
  const details: Rec = { name: e.name, element: { id, palette: e.palette, slot: text ? 'text' : 'media' } };
  // Rendering-only offline fixture: fonts.ts serves non-italic Roboto 400/700 locally. Manrope defaults belong to the fonts step.
  if (text) Object.assign(details, { text: 'HI', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' });
  else if (e.slot?.kind === 'media') details.cells = e.slot.openings.map((bounds, k) => ({ id: `cell${k}`, bounds, source: null,
    fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 }));
  return { id: 'slot', type: text ? 'text' : 'layout', trackId: 'O1', display: { from: 0, to: 4000 }, details, metadata: { assetId: 'replace' },
    properties: { positionX: prop(rect.x + b.x * rect.width), positionY: prop(rect.y + b.y * rect.height), width: prop(rect.width * b.width), height: prop(rect.height * b.height),
      scale: prop(1), opacity: prop(1), fontSize: prop(48), fontWeight: prop(700), color: prop('#0000FF'), textAlign: prop('center') } };
}
async function colourCounts(page: Page, colours: number[][]) {
  return page.evaluate(colours => {
    const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    return colours.map(rgb => { let count = 0; for (let k = 0; k < pixels.length; k += 4) if (pixels[k + 3] > 200 && rgb.every((v, j) => Math.abs(v - pixels[k + j]) <= 12)) count++; return count; });
  }, colours);
}
test.describe('K: slot pictures and their own content both appear on the stage', () => {
  test('label-tag shows its yellow picture and blue text', async ({ page }) => {
    await openSeed(page, slotItem('label-tag'), [255, 0, 255], 'label-tag');
    await expect.poll(async () => Math.min(...await colourCounts(page, [[255, 200, 61], [0, 0, 255]])), { timeout: 15_000 }).toBeGreaterThan(10);
  });
  test('phone-frame is visible over a filled magenta opening', async ({ page }) => {
    await openSeed(page, slotItem('phone-frame'), [255, 0, 255], 'phone-frame');
    await expect.poll(async () => Math.min(...await colourCounts(page, [[27, 27, 31], [255, 0, 255]])), { timeout: 15_000 }).toBeGreaterThan(10);
    const screen = await pixel(page, 200, 130), body = await pixel(page, 152, 130);
    screen.slice(0, 3).forEach((v, k) => expect(Math.abs(v - [255, 0, 255][k])).toBeLessThanOrEqual(2));
    body.slice(0, 3).forEach((v, k) => expect(Math.abs(v - [27, 27, 31][k])).toBeLessThanOrEqual(2));
  });
});

test('L: playing into unseen slot elements shows both pictures and both contents while the playhead advances', async ({ page }) => {
  const labelBox = { x: 20, y: 90, width: 220, height: 220 / 3 }, phoneBox = { x: 280, y: 30, width: 100, height: 200 };
  const label = slotItem('label-tag', labelBox), phone = slotItem('phone-frame', phoneBox);
  label.id = 'playing-label'; phone.id = 'playing-phone'; label.properties.fontSize = prop(32);
  for (const item of [label, phone]) item.display = { from: 1000, to: 7000 };
  const projectId = await createProject(page, emptyDoc(), 'T22 cold-entry slot playback');
  await page.evaluate(async ({ projectId, items }) => {
    const sp = '/src/store/database.ts', cp = '/src/catalogue/assets.ts', store = (await import(sp)).projectStore;
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d')!; g.fillStyle = '#FF00FF'; g.fillRect(0, 0, 64, 64);
    const blob = await new Promise<Blob>((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('PNG creation failed')), 'image/png'));
    const flat = await store.upload(new File([blob], 'playing-cell.png', { type: 'image/png' })); await store.attach(projectId, flat.id);
    await store.updateAsset(flat.id, (a: Rec) => ({ ...a, processing_status: 'ready', processing_steps: { ...a.processing_steps, probe: 'complete' }, media: { image: { width: 64, height: 64 } } }));
    for (const item of items) {
      const picture = await (await import(cp)).ensureCatalogueAsset(store, projectId, `element:${item.details.element.id}`);
      item.metadata.assetId = picture.id;
      if (item.type === 'layout') item.details.cells[0].source = { assetId: flat.id, type: 'image', url: `asset:${flat.id}` };
    }
    const current = await store.read(projectId); current.document.items = items; current.document.duration = 7000;
    await store.save(projectId, current.document, current.document.rev);
  }, { projectId, items: [label, phone] });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await page.evaluate(async () => { const vp = '/src/editor/view.ts'; (await import(vp)).setView({ playheadMs: 0, quality: 'half' }); });
  await shown(page, 0);
  const regions = [{ box: labelBox, colours: [[255, 200, 61], [0, 0, 255]] }, { box: phoneBox, colours: [[27, 27, 31], [255, 0, 255]] }];
  const sample = () => page.evaluate(async ({ regions, W, H }) => {
    const vp = '/src/editor/view.ts', pp = '/src/render/playback.ts';
    const t = (await import(vp)).view().playheadMs as number, playing = (await import(pp)).usePlayback.getState().playing as boolean;
    const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, g = c.getContext('2d')!;
    // Playing quality/display/DPR may shrink the canvas: map each PROJECT box into the current bitmap before counting.
    const counts = regions.flatMap(({ box, colours }) => {
      const x = Math.max(0, Math.floor(box.x * c.width / W)), y = Math.max(0, Math.floor(box.y * c.height / H));
      const right = Math.min(c.width, Math.ceil((box.x + box.width) * c.width / W)), bottom = Math.min(c.height, Math.ceil((box.y + box.height) * c.height / H));
      const pixels = g.getImageData(x, y, right - x, bottom - y).data;
      return colours.map(rgb => { let n = 0; for (let k = 0; k < pixels.length; k += 4) if (pixels[k + 3] > 200 && rgb.every((v, j) => Math.abs(v - pixels[k + j]) <= 12)) n++; return n; });
    });
    return { t, playing, width: c.width, height: c.height, counts };
  }, { regions, W, H });
  // The only paused frame is t=0, BEFORE [1000,7000): neither element has appeared. This does not claim an empty decoder cache.
  const cold = await sample(); expect(cold.t).toBe(0); expect(cold.playing).toBe(false); expect(cold.counts).toEqual([0, 0, 0, 0]);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  try {
    let visible = await sample();
    // A not-yet-decoded bitmap may be skipped: poll for readiness during playback, never demand the first frame.
    await expect.poll(async () => { visible = await sample(); return visible.playing && visible.t >= 1000 && visible.t < 7000 && visible.counts.every(n => n > 5); },
      { timeout: 15_000, intervals: [50, 100], message: 'yellow label/blue text and dark frame/magenta cell inside their own boxes during playback' }).toBe(true);
    const first = visible;
    await expect.poll(async () => { visible = await sample(); return visible.playing && visible.t > first.t && visible.t < 7000 && visible.counts.every(n => n > 5); },
      { timeout: 10_000, intervals: [50, 100], message: 'a second visible playing frame with an advancing playhead' }).toBe(true);
    expect(visible.t).toBeGreaterThan(first.t); expect(visible.playing).toBe(true);
    expect(await canvasSizeOf(page)).toEqual({ width: visible.width, height: visible.height });
    expect(visible.width).toBeLessThanOrEqual(W / 2); expect(visible.height).toBeLessThanOrEqual(H / 2);
  } finally {
    const pause = page.getByRole('button', { name: 'Pause', exact: true });
    if (await pause.isVisible()) await pause.click();
  }
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});
