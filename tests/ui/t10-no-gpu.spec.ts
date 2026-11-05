// SPDX-License-Identifier: AGPL-3.0-only
// T10 fix round 2 B3, WEBGL_UNSUPPORTED (error codes appendix l.339: precondition, user_fixable; tickets l.392 / l.403).
// Chromium launched with the GPU and the software rasteriser off: no WebGL2 context (OffscreenCanvas included) and no
// WebGPU adapter, checked first (probe: `--disable-webgl` / `--disable-3d-apis` alone still give OffscreenCanvas a WebGL2
// context in this Chromium; these two flags do not). An image item with an enabled GPU effect is not drawn and the stage
// and captureFrame name the code; an item without one draws; WebGL2 creation is retried after GL_RETRY_MS, not per frame
// and not never. The getContext counter only observes the calls.
import { test, expect } from '@playwright/test';
import { skipTour } from './t02-support';
import { runCanvas, seekMs, shown } from './t15-support';
import { capture, grayscale, imageDoc, maxAlpha, openImages, stagePixels, W, H } from './t10-failures-support';

test.use({ launchOptions: { args: ['--disable-gpu', '--disable-software-rasterizer'] } });
test.setTimeout(90_000);
const SENTENCE = 'This browser has neither WebGL2 nor WebGPU. Use a current Chrome, Edge or Safari with hardware acceleration on.';
test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __name: unknown; __gl2Asked: number }, orig = OffscreenCanvas.prototype.getContext;
    w.__name = (f: unknown) => f; w.__gl2Asked = 0;
    OffscreenCanvas.prototype.getContext = function (this: OffscreenCanvas, type: string, ...rest: unknown[]) { if (type === 'webgl2') w.__gl2Asked++; return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest); } as typeof orig;
  });
});
const asked = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __gl2Asked: number }).__gl2Asked);

test('no WebGL2, no WebGPU: the GPU-effect item is not drawn, the stage and captureFrame name WEBGL_UNSUPPORTED; WebGL2 is asked for again after the back-off', async ({ page }) => {
  await page.goto('/');
  const probe = await page.evaluate(async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return { webgl2: !!new OffscreenCanvas(1, 1).getContext('webgl2'), adapter: !!(gpu && await gpu.requestAdapter()), twoD: !!new OffscreenCanvas(1, 1).getContext('2d') };
  });
  expect(probe, 'the launch flags leave no GPU backend and a working 2D canvas').toEqual({ webgl2: false, adapter: false, twoD: true });

  await openImages(page, imageDoc([{ id: 'plain' }, { id: 'fx', effects: [grayscale()] }]), 'T10 no GPU');
  const note = page.locator('.stage .render-error');
  // [0, 1000): the item without effects draws (direct path) and nothing is reported.
  await shown(page, 0);
  expect(maxAlpha(await stagePixels(page)), 'the plain image is drawn').toBe(255);
  await expect(note).toHaveCount(0);
  // [1000, 2000): the grayscale item is not drawn; the stage names the code with the sentence; data-exact stays false.
  await seekMs(page, 1500);
  await expect(note).toHaveText(`Effects not drawn (WEBGL_UNSUPPORTED): ${SENTENCE}`);
  await expect(note).toHaveAttribute('role', 'alert');
  await expect(runCanvas(page)).toHaveAttribute('data-frame', '45');
  await expect(runCanvas(page)).toHaveAttribute('data-exact', 'false');
  expect(maxAlpha(await stagePixels(page)), 'nothing is drawn for the item (never drawn without its effect)').toBe(0);

  // Back-off: a burst of 20 effect frames asks for a context at most once; the paused stage asks again about every GL_RETRY_MS.
  const burst = await page.evaluate(async () => {
    const e = '/src/render/effects.ts', fx = await import(e), w = window as unknown as { __gl2Asked: number };
    const src = new OffscreenCanvas(8, 8), before = w.__gl2Asked, out = new Set<unknown>();
    for (let i = 0; i < 20; i++) out.add(fx.runEffects(src, [{ effectId: 'grayscale', params: { amount: 100 } }], { timeS: 0 }));
    return { out: [...out], asked: w.__gl2Asked - before, retryMs: fx.GL_RETRY_MS as number };
  });
  expect(burst.out).toEqual(['WEBGL_UNSUPPORTED']);
  expect(burst.asked, 'context requests in a burst of 20 frames').toBeLessThanOrEqual(1);
  const a0 = await asked(page);
  await page.waitForTimeout(burst.retryMs * 3 + 200);
  const retries = await asked(page) - a0;
  test.info().annotations.push({ type: 'measured', description: `WebGL2 context requests while paused for ${burst.retryMs * 3 + 200} ms: ${retries} (GL_RETRY_MS ${burst.retryMs})` });
  expect(retries, 'asked again after the back-off (not cached for the session)').toBeGreaterThanOrEqual(1);
  expect(retries, 'and not more often than the back-off allows').toBeLessThanOrEqual(4);
  await expect(note).toHaveText(`Effects not drawn (WEBGL_UNSUPPORTED): ${SENTENCE}`);

  // captureFrame: the plain frame has no error; the grayscale frame is black (not drawn) and carries the code.
  const r = await capture(page, { timestamps: [0.5, 1.5] });
  expect(r.result.success).toBe(true);
  expect(r.frames[0]).toEqual({ timestamp: 0.5, frame: 15, time: 0.5, width: Math.round(W * 0.35), height: Math.round(H * 0.35) });
  expect(r.frames[1]).toEqual({ timestamp: 1.5, frame: 45, time: 1.5, width: Math.round(W * 0.35), height: Math.round(H * 0.35),
    notRendered: ['Effects: WEBGL_UNSUPPORTED (T10)'], errors: [{ code: 'WEBGL_UNSUPPORTED', category: 'precondition', recovery: 'user_fixable', message: SENTENCE }] });
  expect(r.images[0].mean, 'the plain image is in the capture').toBeGreaterThan(40);
  expect(r.images[1].max, 'the item is not drawn: black backdrop (JPEG noise only)').toBeLessThanOrEqual(8);

  // Back on the plain item the error goes away.
  await seekMs(page, 500); await shown(page, 15);
  await expect(note).toHaveCount(0);
});
