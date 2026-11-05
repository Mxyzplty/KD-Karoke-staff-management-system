// SPDX-License-Identifier: AGPL-3.0-only
// T10 fix round 2 B3 in the default test Chromium (WebGL2, no WebGPU): CANVAS_TAINTED (error codes appendix l.327:
// system_error, our_bug) with a real taint, and a WebGL2 context loss whose re-create fails (WEBGL_UNSUPPORTED until the
// back-off ends). The taint is real: a PNG served from a second origin (http://taint.test, routed by the test) without CORS
// and loaded without the crossOrigin attribute, so every canvas it is drawn into is not origin-clean. Cutframe reads every
// picture from a local Blob, so no app path loads a cross-origin picture today; the stage / capture tests hand the stage
// that cross-origin picture by substituting the page's createImageBitmap for Blobs (the injection point, not a mock of
// the failure: the browser raises the SecurityError). The context-loss test injects one fault: the re-created WebGL2
// context is refused (getContext returns null) until the test lifts it; recorded as test-only in the notes.
import { test, expect, type Page } from '@playwright/test';
import { clip, notices, openEditor, richDoc, skipTour } from './t02-support';
import { itemById, liveDoc, undoEntries } from './t03-support';
import { runCanvas } from './t15-support';
import { capture, grayscale, imageDoc, maxAlpha, openImages, pngInPage, stagePixels, W, H } from './t10-failures-support';

test.setTimeout(90_000);
const TAINT_URL = 'http://taint.test/pattern.png';
const TAINTED = { code: 'CANVAS_TAINTED', category: 'system_error', recovery: 'our_bug', message: 'The frame could not be read back: a cross-origin picture tainted the canvas. That is our bug.' };
test.beforeEach(async ({ page }) => { await skipTour(page); await page.addInitScript('window.__name = (f) => f'); });
/** Serves the page-made PNG from the second origin, with no CORS headers. */
async function serveCrossOrigin(page: Page) {
  await page.goto('/');
  const png = Buffer.from(await pngInPage(page), 'base64');
  await page.route('http://taint.test/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
}

test('CANVAS_TAINTED in the compositor: a cross-origin picture on the effect path is not drawn and is reported; the other item draws exactly; the frame stays readable', async ({ page }) => {
  await serveCrossOrigin(page);
  const doc = imageDoc([{ id: 'cross', effects: [grayscale('ccccccccc')] }, { id: 'clean', effects: [grayscale()] }]);
  doc.items[1].display = { from: 0, to: 1000 }; doc.items[1].trackId = 'v2';
  doc.tracks.push({ ...doc.tracks[0], id: 'v2', name: 'V2' }); doc.layerOrder.push({ type: 'track', id: 'v2' });
  const r = await page.evaluate(async ({ doc, url }) => {
    const m = '/src/render/model.ts', c = '/src/render/compositor.ts', { framePlan } = await import(m), { composite } = await import(c);
    const img = new Image(); img.src = url; await img.decode();
    const probe = new OffscreenCanvas(4, 4).getContext('2d')!; probe.drawImage(img, 0, 0);
    let taints = ''; try { probe.getImageData(0, 0, 1, 1); } catch (e) { taints = (e as Error).name; }
    const pattern = new OffscreenCanvas(64, 64), px = pattern.getContext('2d')!; px.fillStyle = '#e02020'; px.fillRect(0, 0, 32, 64); px.fillStyle = '#2040e0'; px.fillRect(32, 0, 32, 64);
    const cleanBmp = await createImageBitmap(pattern);
    const plan = framePlan(doc as never, 500), size = { width: 200, height: 200 };
    const src = (d: { item: { id: string } }) => d.item.id === 'cross' ? { image: img, width: 64, height: 64 } : { image: cleanBmp, width: 64, height: 64 };
    const draw = (draws: { item: { id: string } }[]) => {
      const out = new OffscreenCanvas(200, 200), ctx = out.getContext('2d', { willReadFrequently: true })!;
      const failed = composite(ctx, draws as never, draws.map(src) as never, size, 'clear');
      let readable = true, sum = 0, spread = 0, data: Uint8ClampedArray | null = null;
      try { data = ctx.getImageData(0, 0, 200, 200).data; } catch { readable = false; }
      if (data) for (let i = 0; i < data.length; i += 4) { sum += data[i] + data[i + 1] + data[i + 2]; spread = Math.max(spread, Math.abs(data[i] - data[i + 1]), Math.abs(data[i + 1] - data[i + 2])); }
      return { failed, readable, sum, spread, data: data ? Array.from(data) : [] };
    };
    const cleanOnly = plan.draws.filter((d: { item: { id: string } }) => d.item.id === 'clean');
    const warns: string[] = [], warn = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
    const ref = draw(cleanOnly), asPlanned = draw(plan.draws), reversed = draw([...plan.draws].reverse()), after = draw(cleanOnly);
    console.warn = warn;
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
    const strip = (x: ReturnType<typeof draw>) => ({ failed: x.failed, readable: x.readable, spread: x.spread, sameAsRef: same(x.data, ref.data), lit: x.sum > 0 });
    return { taints, warns, order: plan.draws.map((d: { item: { id: string } }) => d.item.id), ref: strip(ref), asPlanned: strip(asPlanned), reversed: strip(reversed), after: strip(after) };
  }, { doc, url: TAINT_URL });
  expect(r.taints, 'the second-origin picture really taints a canvas').toBe('SecurityError');
  expect(r.order.sort()).toEqual(['clean', 'cross']);
  expect(r.ref).toMatchObject({ failed: [], readable: true, lit: true, sameAsRef: true });
  expect(r.ref.spread, 'the clean item went through grayscale (R = G = B ± 1)').toBeLessThanOrEqual(1);
  const failure = { itemId: 'cross', owner: 'T10', what: 'Effects: CANVAS_TAINTED', ...TAINTED };
  for (const [name, x] of [['bottom-to-top order', r.asPlanned], ['reversed order', r.reversed]] as const) {
    expect(x.failed, `${name}: the cross-origin item is reported`).toEqual([failure]);
    expect(x.readable, `${name}: the frame stays readable (the item is not drawn)`).toBe(true);
    expect(x.sameAsRef, `${name}: the clean item is drawn exactly as on its own`).toBe(true);
  }
  expect(r.after, 'the next frame after a taint: the shared item canvas was replaced').toMatchObject({ failed: [], readable: true, sameAsRef: true });
  // Fix round 3 n3 (appendix l.327 "logged"): one console.warn per failed draw with the code, not two for the retry.
  expect(r.warns, 'logged once per occurrence').toEqual(Array(2).fill(`CANVAS_TAINTED: item cross: ${TAINTED.message}`));
});

test('CANVAS_TAINTED on the stage and in captureFrame: the effect item is not drawn and named; captureFrame flags it; a cross-origin picture drawn straight into the capture refuses the call', async ({ page }) => {
  await serveCrossOrigin(page);
  // From the moment the flag is set (after the upload), every Blob the page decodes is answered with the cross-origin picture
  // (except the JPEG blocks the capture helper decodes to measure them).
  await page.addInitScript(url => {
    const orig = window.createImageBitmap.bind(window);
    (window as unknown as { createImageBitmap: unknown }).createImageBitmap = async (src: ImageBitmapSource, ...rest: unknown[]) => {
      if (src instanceof Blob && src.type !== 'image/jpeg' && sessionStorage.getItem('t10-taint') === '1') { const img = new Image(); img.src = url; await img.decode(); return (orig as (...a: unknown[]) => Promise<ImageBitmap>)(img, ...rest); }
      return (orig as (...a: unknown[]) => Promise<ImageBitmap>)(src, ...rest);
    };
  }, TAINT_URL);
  await openImages(page, imageDoc([{ id: 'fx', effects: [grayscale()] }, { id: 'plain' }]), 'T10 taint', () => page.evaluate(() => sessionStorage.setItem('t10-taint', '1')));
  const note = page.locator('.stage .render-error');
  await expect(note).toHaveText(`Effects not drawn (CANVAS_TAINTED): ${TAINTED.message}`);
  await expect(runCanvas(page)).toHaveAttribute('data-frame', '0');
  await expect(runCanvas(page)).toHaveAttribute('data-exact', 'false');
  expect(maxAlpha(await stagePixels(page)), 'the item is not drawn (and the stage canvas stays readable)').toBe(0);

  const size = { width: Math.round(W * 0.35), height: Math.round(H * 0.35) };
  const flagged = await capture(page, { timestamps: [0.5] });
  expect(flagged.result.success).toBe(true);
  expect(flagged.frames).toEqual([{ timestamp: 0.5, frame: 15, time: 0.5, ...size, notRendered: ['Effects: CANVAS_TAINTED (T10)'], errors: [TAINTED] }]);
  expect(flagged.images[0].max, 'the item is not drawn: black backdrop').toBeLessThanOrEqual(8);

  for (const timestamps of [[1.5], [0.5, 1.5]]) {
    const refused = await capture(page, { timestamps });
    expect(refused.result, `timestamps ${timestamps}`).toEqual({ success: false, code: 'CANVAS_TAINTED', category: 'system_error', recovery: 'our_bug', error: 'Frames could not be read back', message: TAINTED.message });
    expect(refused.images).toEqual([]);
  }
});

test('ADD_EFFECT_FAILED from the Effects rail (error codes §7 l.193): an item on a locked track is selected, a click on an effect shows "Failed to add effect" and stores nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const doc = richDoc(); (doc.tracks as { id: string; locked?: boolean }[]).find(t => t.id === 'v1')!.locked = true;
  await openEditor(page, doc); await clip(page, 'clipA').click();
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Effects' }).click();
  const before = (await undoEntries(page)).length;
  await page.getByRole('region', { name: 'Effects', exact: true }).first().getByRole('button', { name: 'Sepia', exact: true }).click();
  await expect(notices(page)).toContainText('ADD_EFFECT_FAILED: Failed to add effect Track v1 is locked');
  expect(itemById(await liveDoc(page), 'clipA').effects ?? []).toEqual([]);
  expect((await undoEntries(page)).length, 'no undo entry').toBe(before);
});

test('WebGL2 context loss whose re-create fails: WEBGL_UNSUPPORTED, no new request until GL_RETRY_MS, then the same frame again', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const e = '/src/render/effects.ts', fx = await import(e), proto = OffscreenCanvas.prototype, orig = proto.getContext;
    const seen = { asked: 0, refuse: false, ctx: null as WebGL2RenderingContext | null };
    proto.getContext = function (this: OffscreenCanvas, type: string, ...rest: unknown[]) {
      const call = () => (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      if (type !== 'webgl2') return call();
      seen.asked++;
      if (seen.refuse) return null; // the test-only fault: the re-created context is refused
      const c = call() as WebGL2RenderingContext; seen.ctx = c; return c;
    } as typeof orig;
    const src = new OffscreenCanvas(32, 32), sc = src.getContext('2d')!; sc.fillStyle = '#c03060'; sc.fillRect(0, 0, 32, 32);
    const stack = [{ effectId: 'grayscale', params: { amount: 100 } }];
    const frame = () => {
      const out = fx.runEffects(src, stack, { timeS: 0 });
      if (typeof out === 'string') return out;
      const c = new OffscreenCanvas(32, 32), x = c.getContext('2d')!; x.drawImage(out, 0, 0); return Array.from(x.getImageData(0, 0, 32, 32).data).join();
    };
    try {
      const first = frame(), askedFirst = seen.asked;
      seen.ctx!.getExtension('WEBGL_lose_context')!.loseContext(); seen.refuse = true;
      const lost = frame(), askedLost = seen.asked;
      const burst = new Set<string>(); for (let i = 0; i < 20; i++) burst.add(frame());
      const askedBurst = seen.asked;
      seen.refuse = false;
      await new Promise(res => setTimeout(res, fx.GL_RETRY_MS + 100));
      const back = frame();
      return { firstIsPixels: first.includes(','), grey: first.split(',').slice(0, 3), askedFirst, lost, askedLost, burst: [...burst], askedBurst, sameFrame: back === first, askedBack: seen.asked, backend: fx.effectsBackend() };
    } finally { proto.getContext = orig; }
  });
  expect(r.firstIsPixels).toBe(true); expect(r.askedFirst, 'the stage created its WebGL2 context here').toBe(1);
  expect(new Set(r.grey).size, 'grayscale ran (R = G = B)').toBe(1);
  expect(r.lost, 'lost context + refused re-create').toBe('WEBGL_UNSUPPORTED'); expect(r.askedLost).toBe(2);
  expect(r.burst).toEqual(['WEBGL_UNSUPPORTED']); expect(r.askedBurst, 'no request during the back-off').toBe(2);
  expect(r.sameFrame, 'after the back-off: a new context draws the same frame').toBe(true); expect(r.askedBack).toBe(3);
  expect(r.backend).toBe('webgl2');
});
