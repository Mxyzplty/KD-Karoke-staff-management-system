// SPDX-License-Identifier: AGPL-3.0-only
// T10 fix round 1 B2: the preview / capture effect stage (framePlan → composite → render/effects.ts) on both backends. WebGPU
// when the browser grants an adapter and a device, WebGL2 when the test switch forces it, and WebGL2 for the frame after a
// device loss, then WebGPU again on a new device. Generated pixels only. Oracle: the T10a pixel oracle parity/oracle (part 4
// §48 0.3 / §49) under the T10a rule 6 (max error ≤ 4 codes, ≤ 0.1 % of channels over 1 code, SSIM ≥ 0.98); keyers as in
// t10-render.spec.ts (alpha and straight colour within 4 codes). The WebGPU rows skip only when the browser has no adapter or
// the stage refused a fallback adapter (CI fix 1: Linux SwiftShader, as in CI); the refused case has its own row, which runs
// only there.
import { test, expect, type Page } from '@playwright/test';
import { createEditor } from '../../apps/web/src/timeline/harness';
import { resolveParams } from '../../apps/web/src/effects/validate';
import type { ProjectDocument } from '../../apps/web/src/store/model';
import { build, mkItem, mkTrack } from '../t03-fixtures';
import { effects as oracleEffects } from '../../parity/oracle/effects';
import { b64, compare, expectRule6, oracleWith, quantise, rule6Note, toImage, unb64, type Raw } from './t10a-support';
import { skipTour } from './t02-support';
import { seekMs, shown } from './t15-support';
import { capture, imageDoc, levels, openImages, stagePixels } from './t10-failures-support';

test.use({ channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } });
const W = 270, H = 480;
let page: Page, adapter = false, refused: string | null = null;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await browser.newPage();
  await page.addInitScript('window.__name = (f) => f');
  await page.goto('/');
  adapter = await page.evaluate(async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!(gpu && await gpu.requestAdapter());
  });
  // framePlan + composite as the preview draws one frame; returns straight RGBA8 (getImageData) and the backend that drew it.
  refused = await page.evaluate(async () => {
    const m = '/src/render/model.ts', c = '/src/render/compositor.ts', e = '/src/render/effects.ts';
    const { framePlan } = await import(m), { composite } = await import(c), fx = await import(e);
    const w = window as unknown as Record<string, unknown>;
    w.__fx = fx;
    w.__frame = (a: { doc: unknown; w: number; h: number; s: string }) => {
      const bin = atob(a.s), data = new Uint8ClampedArray(bin.length); for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      return createImageBitmap(new ImageData(data, a.w, a.h), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then(bitmap => {
        const plan = framePlan(a.doc as never, 0), canvas = new OffscreenCanvas(a.w, a.h), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        composite(ctx, plan.draws, plan.draws.map(() => ({ image: bitmap, width: a.w, height: a.h })) as never, { width: a.w, height: a.h }, 'clear');
        const out = ctx.getImageData(0, 0, a.w, a.h).data; let s = '';
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000) as unknown as number[]);
        return { s: btoa(s), backend: fx.effectsBackend(), gpu: plan.draws.map((d: { effects: { effectId: string }[] }) => d.effects.map(x => x.effectId)) };
      });
    };
    await fx.setEffectsBackend('auto');
    return fx.webgpuRefusal() as string | null;
  });
});
const noWebgpu = () => !adapter ? 'no WebGPU adapter' : refused ? `the stage refused the WebGPU adapter: ${refused}` : '';
test.afterAll(async () => { await page?.close(); });

/** Colourful opaque pattern with a key-green band (as t10-render.spec.ts). */
function pattern(): Raw {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const band = x >= 90 && x < 180, jitter = (y % 20) - 10;
    data.set([...(band ? [0, 177 + jitter, 64] : [Math.round(x / (W - 1) * 255), Math.round(y / (H - 1) * 255), ((x + y) % 64) * 4]), 255], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
}
const OPAQUE = pattern(), CTX = { timeS: 0, seed: 0 };
const LEVELS = { inputBlack: 10, inputWhite: 90, gamma: 1.4, outputBlack: 5, outputWhite: 95 };
const KEY = { keyColor: '#00b140', similarity: 40, smoothness: 10, spillReduction: 50 };

function docWith(add: { effectId: string; initialParameters?: Record<string, unknown> }[]): ProjectDocument {
  const doc = build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('img', 'V1', 0, 2000, { type: 'image', metadata: { assetId: 'asset-img' } })], extra: { size: { width: W, height: H }, fps: 30 } });
  const e = createEditor(doc);
  expect(e.call('writeEffects', { itemId: 'img', add })).toMatchObject({ success: true });
  return JSON.parse(JSON.stringify(e.doc));
}
const setBackend = (mode: 'auto' | 'webgl2') => page.evaluate(m => (window as unknown as { __fx: { setEffectsBackend(m: string): Promise<string | null> } }).__fx.setEffectsBackend(m), mode);
async function render(doc: unknown) {
  const r = await page.evaluate(a => (window as unknown as { __frame(a: unknown): Promise<{ s: string; backend: string | null; gpu: string[][] }> }).__frame(a), { doc, w: W, h: H, s: b64(OPAQUE.data) });
  return { data: unb64(r.s), backend: r.backend, gpu: r.gpu[0] };
}

/** grayscale, levels, the [grayscale 60, levels] chain (half-float intermediates) and colour key, each on `backend`. */
async function oracleRows(backend: 'webgl2' | 'webgpu') {
  const cases: [string, { effectId: string; initialParameters?: Record<string, unknown> }[], Uint8Array][] = [
    ['grayscale', [{ effectId: 'grayscale' }], oracleWith('grayscale', OPAQUE, resolveParams('grayscale', { amount: 100 }), CTX)],
    ['levels', [{ effectId: 'levels', initialParameters: LEVELS }], oracleWith('levels', OPAQUE, resolveParams('levels', LEVELS), CTX)],
    ['grayscale 60 → levels', [{ effectId: 'grayscale', initialParameters: { amount: 60 } }, { effectId: 'levels', initialParameters: LEVELS }],
      quantise(oracleEffects.levels(oracleEffects.grayscale(toImage(OPAQUE), resolveParams('grayscale', { amount: 60 }), CTX), resolveParams('levels', LEVELS), CTX))],
  ];
  for (const [name, add, ref] of cases) {
    const out = await render(docWith(add));
    expect(out.backend, `${name}: backend that drew the frame`).toBe(backend);
    expect(out.gpu).toEqual(add.map(a => a.effectId));
    const d = compare(out.data, ref, W, H);
    test.info().annotations.push({ type: 'measured', description: `${backend} ${name}: ${rule6Note(d)}` });
    expectRule6(d, `${backend} ${name}`);
  }
  const out = await render(docWith([{ effectId: 'color-key', initialParameters: KEY }])), ref = oracleWith('color-key', OPAQUE, resolveParams('color-key', KEY), CTX);
  expect(out.backend).toBe(backend);
  let alphaErr = 0, colourErr = 0, keyed = 0;
  for (let p = 0; p < W * H; p++) {
    const a = ref[p * 4 + 3];
    alphaErr = Math.max(alphaErr, Math.abs(out.data[p * 4 + 3] - a));
    if (a === 0) keyed++;
    if (a >= 128) for (let k = 0; k < 3; k++) colourErr = Math.max(colourErr, Math.abs(out.data[p * 4 + k] - Math.min(255, Math.round(ref[p * 4 + k] * 255 / a))));
  }
  test.info().annotations.push({ type: 'measured', description: `${backend} color-key: alpha max err ${alphaErr}, straight colour max err (alpha ≥ 128) ${colourErr}, ${keyed} keyed` });
  expect(keyed, 'the key-green band is keyed out').toBeGreaterThan(W * H / 10);
  expect(alphaErr, `${backend} color-key alpha vs the oracle (codes)`).toBeLessThanOrEqual(4);
  expect(colourErr, `${backend} color-key straight colour vs oracle rgb / alpha (codes)`).toBeLessThanOrEqual(4);
}

test('webgl2 (forced by the test switch): the preview effect stage matches the oracle', async () => {
  expect(await setBackend('webgl2')).toBe('webgl2');
  await oracleRows('webgl2');
});

test('webgpu (the rule when a device is granted): the preview effect stage matches the oracle', async () => {
  test.skip(!!noWebgpu(), noWebgpu());
  expect(await setBackend('auto'), 'an adapter exists, so the device must be granted').toBe('webgpu');
  await oracleRows('webgpu');
});

// CI fix 1: Linux SwiftShader (CI) offers a fallback adapter. Its device's maths is right (T10a's readback rows), but its
// webgpu canvas reaches a 2D canvas as 0,0,0,0 and its first frame resets the GPU process, so every WebGPU frame was blank.
// The stage refuses a fallback adapter before asking for a device and keeps WebGL2.
test('a fallback WebGPU adapter: the rule keeps WebGL2 and the stage matches the oracle', async () => {
  test.skip(!adapter || !refused, !adapter ? 'no WebGPU adapter' : 'a hardware adapter: the webgpu rows run instead');
  test.info().annotations.push({ type: 'measured', description: `refused: ${refused}` });
  expect(refused).toMatch(/^fallback adapter /);
  expect(await setBackend('auto'), 'auto after the refusal').toBe('webgl2');
  await oracleRows('webgl2');
});

test('device loss: the next frame draws on WebGL2 and matches the oracle; a new device then draws on WebGPU again', async () => {
  test.skip(!!noWebgpu(), noWebgpu());
  expect(await setBackend('auto')).toBe('webgpu');
  const doc = docWith([{ effectId: 'levels', initialParameters: LEVELS }]), ref = oracleWith('levels', OPAQUE, resolveParams('levels', LEVELS), CTX);
  await page.evaluate(() => (window as unknown as { __fx: { loseEffectsDevice(): Promise<void> } }).__fx.loseEffectsDevice());
  const lost = await render(doc);
  expect(lost.backend, 'the frame after the loss').toBe('webgl2');
  expectRule6(compare(lost.data, ref, W, H), 'levels after the loss (webgl2)');
  expect(await setBackend('auto'), 'a new device after the loss').toBe('webgpu');
  const back = await render(doc);
  expect(back.backend).toBe('webgpu');
  expectRule6(compare(back.data, ref, W, H), 'levels on the new device (webgpu)');
});

// Fix round 2 N5: a frame drawn between device.destroy() and the settling of device.lost is blank. The paused stage draws
// again when the loss is reported (its first paint after the report is WebGL2-exact), and a capture that starts inside the
// window equals the WebGL2 capture. Which frames fell inside the window is timing; it is recorded, not asserted (measured:
// frame 1 inside the window 9 / 9 runs). Mutation check: without the stage repaint the first paint after the report comes
// ~1.3 s later (an unrelated repaint), without the capture redraw the capture differs from the WebGL2 one; both fail here.
test('device-loss window (N5): the stage repaints when the loss is reported and a capture started inside the window equals the WebGL2 capture', async ({ browser }) => {
  test.skip(!!noWebgpu(), noWebgpu());
  test.setTimeout(90_000);
  const p = await browser.newPage();
  try {
    await skipTour(p); await p.addInitScript('window.__name = (f) => f');
    await openImages(p, imageDoc([{ id: 'fx', effects: [levels()] }]), 'T10 N5');
    const backend = (m: 'auto' | 'webgl2') => p.evaluate(async m => { const e = '/src/render/effects.ts'; return (await import(e)).setEffectsBackend(m); }, m);
    expect(await backend('webgl2')).toBe('webgl2');
    await seekMs(p, 1000 / 30); await shown(p, 1);
    const ref = await stagePixels(p);
    expect(await backend('auto')).toBe('webgpu');
    await seekMs(p, 0); await shown(p, 0);
    const onGpu = compare(await stagePixels(p), ref, 200, 200);
    test.info().annotations.push({ type: 'measured', description: `stage frame on WebGPU vs WebGL2: ${rule6Note(onGpu)}` });

    // Destroy (not awaited), seek to frame 1; record the first paint after the loss is reported.
    const r = await p.evaluate(async () => {
      const e = '/src/render/effects.ts', v = '/src/editor/view.ts', fx = await import(e), { setView } = await import(v);
      const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, read = () => { const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let s = ''; for (let k = 0; k < d.length; k += 0x8000) s += String.fromCharCode(...d.subarray(k, k + 0x8000)); return btoa(s); };
      const o = { settled: 0, paintedInWindow: null as boolean | null, first: null as { frame?: string; backend: string | null; px: string; afterMs: number } | null };
      const mo = new MutationObserver(() => {
        if (c.dataset.exact !== 'true') return;
        if (o.paintedInWindow === null && c.dataset.frame === '1') o.paintedInWindow = !o.settled;
        if (o.settled && !o.first) o.first = { frame: c.dataset.frame, backend: fx.effectsBackend(), px: read(), afterMs: performance.now() - o.settled };
      });
      mo.observe(c, { attributes: true, attributeFilter: ['data-exact'] });
      const losses = fx.effectsDeviceLosses(), lost = fx.loseEffectsDevice().then(() => { o.settled = performance.now(); });
      setView({ playheadMs: 1000 / 30 });
      await lost;
      for (const t0 = performance.now(); !o.first && performance.now() - t0 < 10_000;) await new Promise(res => setTimeout(res, 10));
      mo.disconnect();
      return { paintedInWindow: o.paintedInWindow, first: o.first, losses: fx.effectsDeviceLosses() - losses };
    });
    test.info().annotations.push({ type: 'measured', description: `stage: frame 1 painted inside the loss window: ${r.paintedInWindow}; first paint after the report on ${r.first?.backend}, ${r.first?.afterMs.toFixed(0)} ms after it` });
    expect(r.losses, 'one loss reported').toBe(1);
    expect(r.first, 'the stage painted after the loss was reported').not.toBeNull();
    expect(r.first!.frame).toBe('1'); expect(r.first!.backend).toBe('webgl2');
    // The report itself causes the paint (measured ~7 ms); the next unrelated repaint of this page comes ~1.3 s later.
    expect(r.first!.afterMs, 'ms from the loss report to the repaint').toBeLessThan(500);
    expect(Buffer.from(r.first!.px, 'base64').equals(Buffer.from(ref)), 'the first paint after the report is the WebGL2 frame, byte for byte').toBe(true);

    // Capture: the WebGL2 capture is the reference; a capture started right after destroy() gives the same JPEG.
    expect(await backend('webgl2')).toBe('webgl2');
    const want = await capture(p, { timestamps: [0.5] });
    expect(await backend('auto')).toBe('webgpu');
    const gpu = await capture(p, { timestamps: [0.5] });
    const lost = await capture(p, { timestamps: [0.5] }, true);
    test.info().annotations.push({ type: 'measured', description: `capture on WebGPU equals the WebGL2 JPEG: ${gpu.images[0].base64 === want.images[0].base64}` });
    expect(lost.result.success).toBe(true);
    expect(lost.images[0].base64 === want.images[0].base64, 'capture started inside the loss window = the WebGL2 capture').toBe(true);
  } finally { await p.close(); }
});
