// SPDX-License-Identifier: AGPL-3.0-only
// T15 (deferred from T03): transformItem's data.drawnBox against the rendered picture.
// Written-spec oracle (findings part 2 §41b, l.592): "drawnBox equals the rendered bounding box within 1 px". drawnBox is in canvas px,
// before rotation. A solid red PNG image item on a 400 x 300 project is drawn on the paused stage (clear backdrop); the opaque
// bounding box is measured on the canvas (clipped to the canvas, so an off-canvas part is not measured) and compared with
// drawnBox intersected with the canvas.
import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { prop, runtimeCall } from './t04-support';
import { openWithVideos, runCanvas, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the solid red PNG');
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const W = 400, H = 300;
function redPng(): string {
  const dir = path.join(tmpdir(), 'cutframe-t15-media'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'red-64x64.png');
  if (!existsSync(out)) { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', out]); expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0); }
  return out;
}
async function open(page: Page) {
  const d = videoDoc([{ id: 'im', to: 1000, sourceDuration: 1000, properties: { positionX: prop(100), positionY: prop(50), width: prop(100), height: prop(80), scale: prop(1) } }], { size: { width: W, height: H }, duration: 1000 });
  d.items[0].type = 'image';
  await openWithVideos(page, d, { im: { path: redPng(), type: 'image/png' } }, 'T15 drawn box');
  await expect(runCanvas(page)).toBeVisible();
}
/** Bounding box [x0, y0, x1, y1) of the pixels with alpha > 127 on the stage canvas, or null when none. */
const bbox = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 127) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1] as number[];
});
const clipped = (b: { x: number; y: number; width: number; height: number }) => [Math.max(0, b.x), Math.max(0, b.y), Math.min(W, b.x + b.width), Math.min(H, b.y + b.height)];
/** Polls until the rendered box is within 1 px of the expected one (the stage repaints after the edit). */
const expectRendered = async (page: Page, want: number[], label: string) => {
  await expect.poll(async () => { const b = await bbox(page); return b ? b.map((v, k) => Math.abs(v - want[k]) <= 1).every(Boolean) ? 'match' : `rendered ${b} vs drawnBox ${want}` : 'nothing drawn'; }, { message: label, timeout: 15000 }).toBe('match');
};

// A 4 x 4 opaque image at positionX 10.25 (20 x 4 project), rows x = [9, 10, 11, 13, 14, 15] of the alpha channel.
// Oracle labels: written-spec (part 5 §53.2.2, no snap) for the matrix; measurement for the edge. The oracle's coverage edge would be
// [0, 191, 255, 255, 64, 0] (tests/oracle-item.test.ts, §53.2.4); whether the preview must show that soft edge or Chromium's hard one is
// Author's Q13, and the l.162 export check belongs to T16a. Probe (bare Chromium 2D canvas, setTransform(1,0,0,1,10.25,0)): drawImage gives
// [0, 255, 255, 255, 0, 0] (ImageBitmap and canvas sources) and fillRect gives [0, 192, 255, 255, 64, 0]: Chromium pixel-snaps an axis-aligned
// fractional-translate drawImage. So the edge is RECORDED, not asserted against the oracle row.
// Asserted: (i) the draw plan's matrix holds 10.25 unsnapped (a model that rounds positionX fails here); (ii) the item covers x 10..14: pixels
// 11-13 opaque, 9 and 15 empty, pixel 10 at least the soft value (191 - 2) and pixel 14 at most the soft value (64 + 2), which holds for both edges.
test('a 4 x 4 image at positionX 10.25: the matrix is unsnapped and the item covers x 10..14 (edge recorded)', async ({ page }) => {
  const d = videoDoc([{ id: 'im', to: 1000, sourceDuration: 1000, properties: { positionX: prop(10.25), positionY: prop(0), width: prop(4), height: prop(4), scale: prop(1) } }], { size: { width: 20, height: 4 }, duration: 1000 });
  d.items[0].type = 'image';
  await openWithVideos(page, d, { im: { path: redPng(), type: 'image/png' } }, 'T15 soft edge');
  await expect(runCanvas(page)).toBeVisible();
  const xs = [9, 10, 11, 13, 14, 15];
  const row = () => page.evaluate(xs => { const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, g = c.getContext('2d')!; return xs.map(x => g.getImageData(x, 2, 1, 1).data[3]); }, xs);
  // (ii) first: poll until the item is on the canvas (pixel 12 opaque), then read the row once.
  await expect.poll(async () => (await row())[2], { message: 'the image is drawn', timeout: 15000 }).toBe(255);
  const a = await row();
  console.log(`T15 positionX 10.25 alpha at x ${JSON.stringify(xs)}: ${JSON.stringify(a)} (oracle coverage [0,191,255,255,64,0])`);
  test.info().annotations.push({ type: 'measured', description: `alpha at x ${JSON.stringify(xs)} = ${JSON.stringify(a)}; oracle coverage [0,191,255,255,64,0]` });
  expect(a[0], 'x 9 is empty').toBe(0);
  expect(a[5], 'x 15 is empty').toBe(0);
  expect(a[1], 'x 10 is at least the soft-edge value').toBeGreaterThanOrEqual(191 - 2);
  expect([a[2], a[3]], 'x 11 and x 13 are opaque').toEqual([255, 255]);
  expect(a[4], 'x 14 is at most the soft-edge value').toBeLessThanOrEqual(64 + 2);
  // (i) the draw plan keeps the stored position: translate 10.25, not 10 or 11.
  const e = await page.evaluate(async () => {
    const m = '/src/render/model.ts', s = '/src/editor.tsx', { framePlan } = await import(m), { activeSession } = await import(s);
    const draws = framePlan(activeSession.document, 0).draws; return { n: draws.length, e: draws[0]?.matrix[4] as number };
  });
  expect(e.n, 'one draw at t 0').toBe(1);
  expect(e.e, 'the draw matrix translate x is the stored positionX (§53.2.2: no snap)').toBe(10.25);
});

test('transformItem drawnBox equals the rendered bounding box within 1 px (scaleBy, move, partly off canvas)', async ({ page }) => {
  await open(page);
  await expectRendered(page, [100, 50, 200, 130], 'before any edit: the stored box');
  const scaled = await runtimeCall(page, 'transformItem', { itemId: 'im', scaleBy: 2 }) as { success: boolean; data: { drawnBox: { x: number; y: number; width: number; height: number } } };
  expect(scaled.success).toBe(true);
  expect(scaled.data.drawnBox, 'scaleBy 2 keeps the centre (written spec: part 2 §41b)').toEqual({ x: 50, y: 10, width: 200, height: 160 });
  await expectRendered(page, clipped(scaled.data.drawnBox), 'after scaleBy 2');
  const moved = await runtimeCall(page, 'transformItem', { itemId: 'im', x: -30, y: 250 }) as { success: boolean; data: { drawnBox: { x: number; y: number; width: number; height: number } } };
  expect(moved.success).toBe(true);
  expect(moved.data.drawnBox).toMatchObject({ x: -30, y: 250 });
  await expectRendered(page, clipped(moved.data.drawnBox), 'after moving to (-30, 250), clipped by the canvas');
});
