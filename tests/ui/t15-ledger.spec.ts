// SPDX-License-Identifier: AGPL-3.0-only
// T15 findings-part-5 check ledger, rows T15 renders (image and video items). Each test builds a project document, takes its frame plan
// (render/model.ts framePlan) and draws it with the compositor (render/compositor.ts composite) on an OffscreenCanvas in the page,
// then reads single pixels. No media files are needed. Every test is a written-spec oracle: the pixel values are the §53 check rows.
//
// Recorded differences, not pending (the shape and layout draws exist, so the Xapp readings below are not copied):
//   - §53.4.6 shape with opacity 0.5 (+ blur 1 -> alpha ~0.25, quirk 2): opacity is applied once, not squared (T06 Q10)
//   - §53.4.6 layout item with blur 2 shows nothing (quirk 1): the layout is drawn (T07 notes Q4)
//   - §53.4.5 quirk 2 for a caption: opacity once as well, tested below ("caption opacity once")
// Quirk 3 (a 2-line text and brightness 1.01) and the four §53.6.3 checks are tested below, in export and in the preview.
//   (the text-layout numbers of §53.7.6 are covered in tests/t15-text-layout.test.ts)
import { test, expect, type Page } from '@playwright/test';
import { FRAME_LEVEL_TOLERANCE } from '../../parity/frame-tolerance';
import { openEditor, skipTour } from './t02-support';
import { videoDoc } from './t15-support';

test.setTimeout(60_000);
test.beforeEach(async ({ page }) => { await skipTour(page); await page.goto('/'); });

type Px = [number, number, number, number];
type Clip = Parameters<typeof videoDoc>[0][number] & { type?: string };
/** A project of the given size whose clips have the given item types (videoDoc makes video items). */
const doc = (clips: Clip[], size: { width: number; height: number }) => {
  const d = videoDoc(clips, { size, duration: 1000 });
  d.items.forEach((i, n) => { i.type = clips[n].type ?? 'video'; i.display = { from: 0, to: 1000 }; });
  return d;
};
/** Frame plan at t = 0 drawn with the compositor; one solid-colour source per draw (bottom first); the pixels at `points`. */
const paint = (page: Page, document: unknown, colors: string[], backdrop: 'black' | 'clear', points: [number, number][]) => page.evaluate(async ({ document, colors, backdrop, points }) => {
  const m = '/src/render/model.ts', c = '/src/render/compositor.ts';
  const { framePlan } = await import(m), { composite } = await import(c);
  const size = (document as { size: { width: number; height: number } }).size;
  const { draws, pending } = framePlan(document, 0);
  if (pending.length) throw new Error(`pending: ${JSON.stringify(pending)}`);
  if (draws.length !== colors.length) throw new Error(`${draws.length} draws for ${colors.length} sources`);
  const sources = colors.map(color => { const oc = new OffscreenCanvas(64, 64), x = oc.getContext('2d')!; x.fillStyle = color; x.fillRect(0, 0, 64, 64); return { image: oc, width: 64, height: 64 }; });
  const out = new OffscreenCanvas(size.width, size.height), ctx = out.getContext('2d')!;
  composite(ctx, draws, sources, size, backdrop);
  return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data) as Px);
}, { document, colors, backdrop, points });
const near = (a: Px, b: Px, tol = FRAME_LEVEL_TOLERANCE) => a.every((v, k) => Math.abs(v - b[k]) <= tol);
const BLACK: Px = [0, 0, 0, 255], WHITE: Px = [255, 255, 255, 255], RED: Px = [255, 0, 0, 255];
const image = (details: Record<string, unknown>): Clip => ({ id: 'im', type: 'image', details });

test.describe('§53.4.6 checks (findings part 5 l.295)', () => {
  test('white 200 x 200 image, borderRadius 50, borderWidth 10 #ff0000, black backdrop: (100,1) red, (100,6) white, (2,2) black, (16,16) white', async ({ page }) => {
    const d = doc([image({ positionX: 0, positionY: 0, width: 200, height: 200, borderRadius: 50, borderWidth: 10, borderColor: '#ff0000' })], { width: 400, height: 300 });
    const px = await paint(page, d, ['#ffffff'], 'black', [[100, 1], [100, 6], [2, 2], [16, 16]]);
    expect({ 'red: the border inner half (5 px)': near(px[0], RED), 'white below the border': near(px[1], WHITE), 'black outside the rounded clip': near(px[2], BLACK), 'white, no border along the corner': near(px[3], WHITE) })
      .toEqual({ 'red: the border inner half (5 px)': true, 'white below the border': true, 'black outside the rounded clip': true, 'white, no border along the corner': true });
  });

  test('borderRadius 500 on a 400 x 300 image is a 150 px radius pill', async ({ page }) => {
    const d = doc([image({ positionX: 0, positionY: 0, width: 400, height: 300, borderRadius: 500 })], { width: 400, height: 300 });
    const model = await page.evaluate(async () => { const p = '/src/render/model.ts'; return (await import(p)).effectiveRadius(500, 400, 300) as number; });
    expect(model).toBe(150);
    // (20,60): outside a 150 px corner circle centred at (150,150) (distance 158), but inside a 100 px one (distance 89); (200,3) and (60,150) are inside the pill.
    const px = await paint(page, d, ['#ffffff'], 'black', [[20, 60], [200, 3], [60, 150], [5, 5]]);
    expect(px.map(p => near(p, WHITE) ? 'white' : near(p, BLACK) ? 'black' : 'other')).toEqual(['black', 'white', 'white', 'black']);
  });

  test('blur 4 with radius 0 leaves a halo about 12 px (3 sigma) outside the box; with radius 1 there is none', async ({ page }) => {
    // Box (100,100)-(300,300) on a 400 x 300 clear canvas; read alpha along the row y = 200 left of the box (x = 100 is the edge).
    const outside = [96, 92, 70] as const, points: [number, number][] = outside.map(x => [x, 200]);
    const halo = (radius: number) => paint(page, doc([image({ positionX: 100, positionY: 100, width: 200, height: 200, blur: 4, borderRadius: radius })], { width: 400, height: 300 }), ['#ffffff'], 'clear', points);
    const flat = (await halo(0)).map(p => p[3]), clipped = (await halo(1)).map(p => p[3]);
    // sigma 4: half-plane edge coverage at 4 / 8 / 12 px is 16 % / 2.3 % / 0.1 % (12 px is below one alpha level), so alpha is clearly >0 at 4 and 8 px, 0 at 30 px.
    expect({ at4: flat[0] > 10, at8: flat[1] > 0, at30: flat[2] }).toEqual({ at4: true, at8: true, at30: 0 });
    expect(clipped, 'radius 1 clips the blurred picture to the box').toEqual([0, 0, 0]);
  });
});

test.describe('§53.6.3 checks (findings part 5 l.377)', () => {
  const colour = (rgb: number[]) => `rgb(${rgb.join(',')})`;
  const full = { positionX: 0, positionY: 0, width: 100, height: 100 };
  test('a lone "multiply" video over nothing: export (black backdrop) is black, preview (clear backdrop) is unchanged', async ({ page }) => {
    const d = doc([{ id: 'v', details: { ...full, blendMode: 'multiply' } }], { width: 100, height: 100 });
    const rgb = [200, 100, 50];
    const [exp] = await paint(page, d, [colour(rgb)], 'black', [[50, 50]]), [pre] = await paint(page, d, [colour(rgb)], 'clear', [[50, 50]]);
    expect(near(exp, BLACK), `export pixel ${exp}`).toBe(true);
    expect(near(pre, [...rgb, 255] as Px), `preview pixel ${pre}`).toBe(true);
  });

  for (const backdrop of ['black', 'clear'] as const) {
    test(`a "screen" V2 video over a V1 video in the same run: ${backdrop === 'black' ? 'export' : 'preview'} screens them`, async ({ page }) => {
      const a = [100, 50, 200], b = [50, 100, 10], screen = a.map((v, k) => 255 - (255 - v) * (255 - b[k]) / 255);
      const d = doc([{ id: 'v1c', track: 'v1', details: full }, { id: 'v2c', track: 'v2', details: { ...full, blendMode: 'screen' } }], { width: 100, height: 100 });
      const [p] = await paint(page, d, [colour(a), colour(b)], backdrop, [[50, 50]]);
      expect(near(p, [...screen, 255] as Px, 1.5), `${backdrop} backdrop: pixel ${p}, expected ${screen.map(Math.round)}`).toBe(true);
    });
  }
});

test.describe('§53.8.4 check: an empty region of the frame (findings part 5 l.503)', () => {
  test('export (black backdrop) draws (0,0,0) in an empty region even with the stored background #ff0000', async ({ page }) => {
    const d = { ...doc([{ id: 'v', details: { positionX: 0, positionY: 0, width: 50, height: 100 } }], { width: 100, height: 100 }), background: { type: 'color', value: '#ff0000' } };
    const [empty, drawn] = await paint(page, d, ['rgb(10,200,30)'], 'black', [[80, 50], [20, 50]]);
    expect(near(empty, BLACK), `empty region ${empty}`).toBe(true);
    expect(near(drawn, [10, 200, 30, 255]), `drawn region ${drawn}`).toBe(true);
  });

  test('the preview stage shows the stored background #ff0000 behind the clear canvas; a transparent background shows black', async ({ page }) => {
    const base = doc([{ id: 'v', details: { positionX: 0, positionY: 0, width: 50, height: 100 } }], { width: 100, height: 100 });
    await openEditor(page, { ...base, background: { type: 'color', value: '#ff0000' } }, 'T15 stage red');
    const stage = page.locator('.stage');
    await expect(stage).toHaveCSS('background-color', 'rgb(255, 0, 0)');
    await page.goto('/');
    await openEditor(page, { ...base, background: { type: 'color', value: 'transparent' } }, 'T15 stage transparent');
    await expect(page.locator('.stage')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  });
});

// ---- T30, the G-19 follow-up checks. Export = one composite(..., 'black') of every draw of the real framePlan. Preview = one
// composite(..., 'clear') per preview run (render/model.ts previewRuns), the run canvases stacked in run order over the stage
// background, as editor/preview-stage.tsx draws them. A text, shape or caption draw takes no source and a layout takes { cells };
// the fonts are loaded as the export does (text/fonts.ts loadTextFonts, captions/fonts.ts loadCaptionFonts) before the plan is drawn.
type Src = string | null | { cells: (string | null)[] };
type Shot = { w: number; exp: Uint8Array; pre: Uint8Array };
const frames = async (page: Page, document: { size: { width: number; height: number } }, sources: Src[], backdrop: 'black' | 'clear' = 'black'): Promise<Shot> => {
  const r = await page.evaluate(async ({ document, sources, backdrop }) => {
    const m = '/src/render/model.ts', c = '/src/render/compositor.ts', f = '/src/text/fonts.ts', cf = '/src/captions/fonts.ts', s = '/src/editor/preview-stage.tsx';
    const { framePlan, previewRuns } = await import(m), { composite } = await import(c), { loadTextFonts } = await import(f), { loadCaptionFonts } = await import(cf), { stageBackground } = await import(s);
    const { width, height } = document.size, size = { width, height };
    await loadTextFonts(document);
    await loadCaptionFonts(document);
    const swatch = (color: string) => { const oc = new OffscreenCanvas(64, 64), x = oc.getContext('2d')!; x.fillStyle = color; x.fillRect(0, 0, 64, 64); return { image: oc, width: 64, height: 64 }; };
    const picture = (s: Src) => s === null ? null : typeof s === 'string' ? swatch(s) : { cells: s.cells.map(cell => cell === null ? null : swatch(cell)) };
    const all = framePlan(document, 0);
    if (all.pending.length) throw new Error(`pending: ${JSON.stringify(all.pending)}`);
    if (all.draws.length !== sources.length) throw new Error(`${all.draws.length} draws for ${sources.length} sources`);
    const byItem = new Map(all.draws.map((d: { item: { id: string } }, k: number) => [d.item.id, picture(sources[k])] as const));
    const sourcesOf = (draws: { item: { id: string } }[]) => draws.map(d => byItem.get(d.item.id) ?? null);
    const read = (ctx: OffscreenCanvasRenderingContext2D) => {
      const data = ctx.getImageData(0, 0, width, height).data;
      let bin = '';
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    const exp = new OffscreenCanvas(width, height), ectx = exp.getContext('2d')!;
    composite(ectx, all.draws, sourcesOf(all.draws), size, backdrop);
    const stage = new OffscreenCanvas(width, height), sctx = stage.getContext('2d')!;
    sctx.fillStyle = String(stageBackground(document).background); sctx.fillRect(0, 0, width, height);
    for (const run of previewRuns(document) as { trackIds: string[] }[]) {
      const plan = framePlan(document, 0, size, run.trackIds), canvas = new OffscreenCanvas(width, height);
      composite(canvas.getContext('2d')!, plan.draws, sourcesOf(plan.draws), size, 'clear');
      sctx.drawImage(canvas, 0, 0);
    }
    return { exp: read(ectx), pre: read(sctx) };
  }, { document, sources, backdrop });
  const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
  return { w: document.size.width, exp: bytes(r.exp), pre: bytes(r.pre) };
};
const at = (data: Uint8Array, w: number, x: number, y: number): Px => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
/** The export and the preview pixel at each point: the export is `want` within `tol`, and the preview equals the export (±1). */
const blended = (shot: Shot, points: [number, number][], want: Px[], tol = FRAME_LEVEL_TOLERANCE) => {
  const exp = points.map(([x, y]) => at(shot.exp, shot.w, x, y)), pre = points.map(([x, y]) => at(shot.pre, shot.w, x, y));
  expect(exp.map((q, k) => near(q, want[k], tol)), `export ${JSON.stringify(exp)}, wanted ${JSON.stringify(want)}`).toEqual(want.map(() => true));
  expect(pre.map((q, k) => near(q, exp[k])), `preview ${JSON.stringify(pre)} vs export ${JSON.stringify(exp)}`).toEqual(want.map(() => true));
};
/** Pixels whose whole disc of radius `r` is ink, nearest the frame centre first. It reads a reference render, never the result
 *  under test, so an interior is not picked because the tested pixel passes. */
const interior = (data: Uint8Array, w: number, ink: (q: Px) => boolean, r: number): [number, number][] => {
  const h = data.length / 4 / w, found: [number, number][] = [];
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    if (!ink(at(data, w, x, y))) continue;
    let whole = true;
    for (let dy = -r; dy <= r && whole; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r && !ink(at(data, w, x + dx, y + dy))) { whole = false; break; }
    if (whole) found.push([x, y]);
  }
  return found.sort((a, b) => (a[0] - w / 2) ** 2 + (a[1] - h / 2) ** 2 - ((b[0] - w / 2) ** 2 + (b[1] - h / 2) ** 2));
};
const p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
const box = (x: number, y: number, width: number, height: number) => ({ positionX: x, positionY: y, width, height });
const pbox = (x: number, y: number, width: number, height: number) => ({ positionX: p(x), positionY: p(y), width: p(width), height: p(height) });
type Size = { width: number; height: number };
const bare = (tracks: [string, string][], items: unknown[], size: Size) => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 1000, fps: 30, size, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: tracks.map(([id, kind]) => ({ id, name: id.toUpperCase(), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 })),
  layerOrder: tracks.map(([id]) => ({ type: 'track', id })), items,
});
const entry = (id: string, type: string, trackId: string, rest: Record<string, unknown>) =>
  ({ id, type, trackId, display: { from: 0, to: 1000 }, trim: { from: 0, to: 1000 }, playbackRate: 1, masks: [], effects: [], ...rest });
const textEntry = (id: string, trackId: string, text: string, F: number, color: string, props: Record<string, unknown>, details: Record<string, unknown> = {}) => entry(id, 'text', trackId, {
  details: { text, fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto', ...details },
  properties: { opacity: p(1), scale: p(1), rotation: p(0), fontSize: p(F), fontWeight: p(700), color: p(color), backgroundColor: p('transparent'), textAlign: p('center'), wordWrap: p('break-word'), borderWidth: p(0), borderColor: p('#000000'), ...props },
});

test.describe('§53.4.6 quirk 3 and the caption half of quirk 2 (findings part 5 l.290-291, l.303-305)', () => {
  test('a 2-line text with no filter draws line 2 below its box; brightness 1.01 cuts it at the box edge', async ({ page }) => {
    const size = { width: 300, height: 400 };
    const textDoc = (props: Record<string, unknown>) => bare([['o1', 'overlay']], [textEntry('t', 'o1', 'A\nB', 100, '#ffffff', { ...pbox(0, 0, 300, 150), ...props })], size);
    const rows = (shot: Shot, y0: number, y1: number) => {
      let lit = 0, other = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < size.width; x++) {
        const q = at(shot.exp, size.width, x, y);
        if (Math.max(q[0], q[1], q[2]) >= 128) lit++;
        if (!near(q, BLACK)) other++;
      }
      return { lit, other };
    };
    const plain = await frames(page, textDoc({}), [null]), bright = await frames(page, textDoc({ brightness: p(1.01) }), [null]);
    expect({ 'line 2 drawn below the box, no filter': rows(plain, 150, 400).lit > 0, 'line 1 inside the box, no filter': rows(plain, 0, 150).lit > 0 }).toEqual({ 'line 2 drawn below the box, no filter': true, 'line 1 inside the box, no filter': true });
    expect(rows(bright, 150, 400), 'brightness 1.01: every pixel below the box is black').toMatchObject({ lit: 0, other: 0 });
    expect(rows(bright, 0, 150).lit, 'brightness 1.01: line 1 is kept').toBeGreaterThan(0);
  });

  test('caption opacity once: opacity 0.5 with blur 1 reads alpha 127.5 inside a glyph (opacity squared would read 64)', async ({ page }) => {
    const size = { width: 800, height: 400 }, words = [{ text: 'M', startMs: 0, endMs: 1000, sourceStartMs: 0, sourceEndMs: 1000 }];
    const captionDoc = (props: Record<string, unknown>) => bare([['c1', 'caption']], [entry('cap', 'caption', 'c1', {
      metadata: { captionMode: 'detached' },
      details: { text: 'M', words, fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto', renderMode: 'default', renderConfig: {} },
      properties: { fontSize: p(300), fontWeight: p('700'), color: p('#FFFFFF'), backgroundColor: p('transparent'), borderWidth: p(0), textAlign: p('center'), scale: p(1), rotation: p(0), ...pbox(0, 0, 800, 400), opacity: p(1), ...props },
    })], size);
    // The reference is the same caption at opacity 1 and no blur: its fully opaque pixels with a whole disc of radius 4 around them
    // are at least 3 px (3 sigma of blur 1) from any glyph edge. The 0.5 render is read only at those pixels.
    const ref = await frames(page, captionDoc({}), [null], 'clear');
    const spots = interior(ref.exp, size.width, q => q[3] === 255, 4);
    expect(spots.length, 'a glyph interior at least 4 px from every edge, from the reference render').toBeGreaterThan(0);
    const shot = await frames(page, captionDoc({ opacity: p(0.5), blur: p(1) }), [null], 'clear');
    const alphas = spots.filter((_, k) => k % Math.ceil(spots.length / 25) === 0).map(([x, y]) => at(shot.exp, size.width, x, y)[3]);
    expect(alphas.map(a => a >= 126 && a <= 129), `alpha at ${alphas.length} interior pixels: ${alphas}`).toEqual(alphas.map(() => true));
  });
});

test.describe('§53.6.3 checks 2-4 and the multiply checks for image, motion graphic and layout: export and preview agree', () => {
  const rgb = (v: number[]) => `rgb(${v.join(',')})`, GREY = rgb([128, 128, 128]), ORANGE = rgb([255, 128, 0]);
  const full = box(0, 0, 100, 100), patch = box(25, 25, 50, 50), size = { width: 100, height: 100 };
  const video = (id: string, trackId: string, details: Record<string, unknown>) => entry(id, 'video', trackId, { sourceDuration: 1000, details: { name: id, ...details } });
  // Inside the patch the multiply reads (128, 64, 0) (255 * 128 / 255 per channel); outside it the grey video shows.
  const MULTIPLIED: Px[] = [[128, 64, 0, 255], [128, 128, 128, 255]], POINTS: [number, number][] = [[50, 50], [5, 5]];

  test('check 2: a "multiply" text on O1 over a mid-grey V1 darkens the glyph, in export and preview', async ({ page }) => {
    const frame = { width: 320, height: 320 }, H = (details: Record<string, unknown>) => textEntry('t', 'o1', 'H', 200, '#ff8000', pbox(0, 0, 320, 320), details);
    // The glyph pixel is chosen on a reference render of the text alone (opaque #ff8000 with a whole disc of radius 2 around it).
    const ref = await frames(page, bare([['o1', 'overlay']], [H({})], frame), [null]);
    const inside = interior(ref.exp, 320, q => near(q, [255, 128, 0, 255], 2), 2)[0];
    expect(inside, 'a glyph interior in the reference render').toBeDefined();
    expect(near(at(ref.exp, 320, 5, 5), BLACK), 'the reference is empty at (5, 5)').toBe(true);
    const doc = bare([['v1', 'video'], ['o1', 'overlay']], [video('v', 'v1', box(0, 0, 320, 320)), H({ blendMode: 'multiply' })], frame);
    blended(await frames(page, doc, [GREY, null]), [inside, [5, 5]], MULTIPLIED);
  });

  test('check 3: a "screen" V2 video over a V1 video in one run screens them in the export and in the run-split preview', async ({ page }) => {
    const a = [100, 50, 200], b = [50, 100, 10], screen = a.map((v, k) => 255 - (255 - v) * (255 - b[k]) / 255);
    const doc = bare([['v1', 'video'], ['v2', 'video']], [video('v1c', 'v1', full), video('v2c', 'v2', { ...full, blendMode: 'screen' })], size);
    blended(await frames(page, doc, [rgb(a), rgb(b)]), [[50, 50]], [[...screen, 255] as Px], 1.5);
  });

  test('check 4: a "difference" white shape over a white image is black inside the shape, in export and preview', async ({ page }) => {
    const pt = (x: number, y: number) => ({ anchor: { x, y } });
    const shape = entry('sh', 'shape', 'o1', {
      details: { src: '', path: 'M 0,0 L 50,0 L 50,50 L 0,50 Z', points: [pt(0, 0), pt(50, 0), pt(50, 50), pt(0, 50)], closed: true, width: 50, height: 50, blendMode: 'difference' },
      properties: { ...pbox(25, 25, 50, 50), opacity: p(1), scale: p(1), rotation: p(0), fillColor: p('#ffffff'), fillOpacity: p(1), strokeColor: p('none'), strokeWidth: p(0), strokeOpacity: p(1) },
      metadata: { shapeType: 'rectangle' },
    });
    const doc = bare([['v1', 'video'], ['o1', 'overlay']], [entry('im', 'image', 'v1', { details: full }), shape], size);
    blended(await frames(page, doc, [rgb([255, 255, 255]), null]), POINTS, [BLACK, WHITE]);
  });

  test('a "multiply" image over a mid-grey video in one run multiplies in export and preview', async ({ page }) => {
    const doc = bare([['v1', 'video'], ['v2', 'video']], [video('v1c', 'v1', full), entry('im', 'image', 'v2', { details: { ...patch, blendMode: 'multiply' } })], size);
    blended(await frames(page, doc, [GREY, ORANGE]), POINTS, MULTIPLIED);
  });

  test('a "multiply" motion graphic over a mid-grey video in one run multiplies in export and preview', async ({ page }) => {
    const graphic = entry('mg', 'motionGraphic', 'o1', { sourceDuration: 1000, details: { code: 'export const Graphic = () => null;', ...patch, blendMode: 'multiply' } });
    const doc = bare([['v1', 'video'], ['o1', 'overlay']], [video('v1c', 'v1', full), graphic], size);
    blended(await frames(page, doc, [GREY, ORANGE]), POINTS, MULTIPLIED);
  });

  test('a "multiply" one-cell layout over a mid-grey video in one run multiplies in export and preview', async ({ page }) => {
    const cell = { id: 'cellcellcellcellcell1', bounds: { x: 0, y: 0, width: 1, height: 1 }, source: { assetId: 'asset', type: 'image', url: 'asset:asset' }, fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 };
    const layout = entry('lay', 'layout', 'o1', { details: { layoutType: 'split-horizontal', cells: [cell], gap: 0, borderRadius: 0, ...patch, blendMode: 'multiply' } });
    const doc = bare([['v1', 'video'], ['o1', 'overlay']], [video('v1c', 'v1', full), layout], size);
    blended(await frames(page, doc, [GREY, { cells: [ORANGE] }]), POINTS, MULTIPLIED);
  });
});
