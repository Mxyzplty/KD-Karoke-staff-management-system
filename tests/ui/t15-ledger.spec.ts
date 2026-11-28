// SPDX-License-Identifier: AGPL-3.0-only
// T15 findings-part-5 check ledger, rows T15 renders (image and video items). Each test builds a project document, takes its frame plan
// (render/model.ts framePlan) and draws it with the compositor (render/compositor.ts composite) on an OffscreenCanvas in the page,
// then reads single pixels. No media files are needed. Every test is a written-spec oracle: the pixel values are the §53 check rows.
//
// DEFERRED: pending in T15 (itemDraw reports them as Pending for T05/T06/T07, so there is nothing to draw and test yet):
//   - §53.4.6 shape with opacity 0.5 (+ blur 1 -> alpha ~0.25, quirk 2)               -> T06 shape rendering
//   - §53.4.6 layout item with blur 2 shows nothing (quirk 1)                           -> T07 layout rendering
//   - §53.4.6 text with no filter, second line below the box drawn; brightness 1.01 cuts it (quirk 3) -> T05 text rendering
//   - §53.6.3 "multiply" text on O1 over a mid-grey video (export darkens the text area, preview unblended) -> T05
//   - §53.6.3 "difference" white shape over a white image on a lower track (export black in the shape, preview white) -> T06
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
