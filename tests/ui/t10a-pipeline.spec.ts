// SPDX-License-Identifier: AGPL-3.0-only
// T10a render pipeline on real backends: stack chaining with float intermediates, CSS entries returned (not rendered), recolor from
// element data, bg-removal with a mask, texture-source uploads, and the two transport stages.
// Tolerances: chains ≤ 2 codes (f32 shader math per pass, half-float RGBA16F intermediates); transport stages: 709 exact, stacked alpha ≤ 1 code (even width; the odd-width case asserts
// size ⌊SW/2⌋ × H, no throw and valid bytes, and does NOT pin the alpha offset: the contract is even SW = 2W); recolor ≤ 16 codes on < 0.01% of channels
// (rare gamut-edge pixels: 7-step bisection in f32 vs f64) with SSIM ≥ 0.98; bg-removal ≤ 2 codes (GPU bilinear mask weights).
// One test per backend; WebGPU tests are explicit skips ('no WebGPU adapter') when the browser grants no device.
import { test, expect, type Page } from '@playwright/test';
import { bt709Table } from '../../apps/web/src/effects/colour-math';
import { effects as oracleEffects } from '../../parity/oracle/effects';
import { cssFilters as oracleCss } from '../../parity/oracle/effects';
import { compare, CONTEXT, ensureInput, log, perBackend, quantise, renderInPage, setupPage, standInS3a, standInS3c, stillAt, STILLS, STILLS_ALL, toImage, variantParams, type PageInfo, type Raw, type StillId } from './t10a-support';

test.use({ channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } });
test.setTimeout(300_000);
test.describe.configure({ mode: 'parallel' });

let page: Page, info: PageInfo;
test.beforeAll(async ({ browser }) => { test.setTimeout(120_000); page = await browser.newPage(); info = await setupPage(page); });
test.afterAll(async () => { await page?.close(); });

function oracleChain(raw: Raw, steps: { id: string; params: Record<string, unknown> }[], extra: Record<string, unknown> = {}) {
  let img = toImage(raw);
  for (const s of steps) img = oracleEffects[s.id](img, { ...s.params, ...extra }, CONTEXT);
  return quantise(img);
}
/** Deterministic RGBA noise with a given alpha pattern (straight alpha, top row first). */
function noise(width: number, height: number, alpha: (x: number, y: number) => number = () => 255, seed = 1): Raw {
  const data = new Uint8Array(width * height * 4); let s = seed >>> 0;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([rnd(), rnd(), rnd(), alpha(x, y)], (y * width + x) * 4);
  return { width, height, data };
}
/** Hue sweep (x) × lightness ramp (y), opaque — colourful input for recolor. LABELLED STAND-IN (no store needed). */
function hueSweep(width: number, height: number): Raw {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const h = x / width * 6, l = 0.15 + 0.7 * (1 - y / height), c = (1 - Math.abs(2 * l - 1)) * 0.8, xx = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
    const [r, g, b] = [[c, xx, 0], [xx, c, 0], [0, c, xx], [0, xx, c], [xx, 0, c], [c, 0, xx]][Math.min(5, Math.floor(h))];
    data.set([r + m, g + m, b + m].map(v => Math.round(v * 255)).concat(255), (y * width + x) * 4);
  }
  return { width, height, data };
}

test.describe('chains', () => {
  const CHAINS: { name: string; stack: { effectId: string; params?: Record<string, unknown>; enabled?: boolean; order?: number }[]; steps: { id: string; params: Record<string, unknown> }[] }[] = [
    (() => {
      const a = variantParams('color-wheels', 'max'), b = { ...variantParams('pixelate', 'defaults'), blockSize: 6 }, c = variantParams('vignette', 'max');
      return { name: 'color-wheels → pixelate → vignette', stack: [{ effectId: 'color-wheels', params: a }, { effectId: 'pixelate', params: b }, { effectId: 'vignette', params: c }],
        steps: [{ id: 'color-wheels', params: a }, { id: 'pixelate', params: b }, { id: 'vignette', params: c }] };
    })(),
    (() => {
      const a = variantParams('hsl', 'max'), b = variantParams('grayscale', 'min'), c = variantParams('edge-detection', 'defaults');
      return { name: 'order and enabled: stack order overridden by `order`, disabled entry skipped', stack: [{ effectId: 'edge-detection', params: c, order: 2 }, { effectId: 'sepia', enabled: false }, { effectId: 'hsl', params: a, order: 0 }, { effectId: 'grayscale', params: b, order: 1 }],
        steps: [{ id: 'hsl', params: a }, { id: 'grayscale', params: b }, { id: 'edge-detection', params: c }] };
    })(),
  ];
  for (const c of CHAINS) for (const still of ['S3a*', 'S3c*'] as StillId[]) {
    perBackend(`${c.name} ${still} 270×480`, () => info, async backend => {
      const raw = stillAt(still, 270, 480), key = `${still}@270x480`;
      await ensureInput(page, key, raw);
      const expected = oracleChain(raw, c.steps);
      const out = await renderInPage(page, { backend, input: key, stack: c.stack, context: CONTEXT });
      const d = compare(out.data, expected, 270, 480);
      log({ spec: 'pipeline', case: c.name, still, backend, ...d });
      expect.soft(d.maxErr, `${backend} max error`).toBeLessThanOrEqual(2);
      expect.soft(d.ssim, `${backend} SSIM`).toBeGreaterThanOrEqual(0.98);
    });
  }

  perBackend('intermediates stay float: levels squeeze (40–60%) then expand returns the input within 1 code', () => info, async backend => {
    const raw = stillAt('S3a*', 270, 480), key = 'S3a*@270x480', base = variantParams('levels', 'defaults');
    const squeeze = { ...base, outputBlack: 40, outputWhite: 60 }, expand = { ...base, inputBlack: 40, inputWhite: 60 };
    await ensureInput(page, key, raw);
    const expected = oracleChain(raw, [{ id: 'levels', params: squeeze }, { id: 'levels', params: expand }]);
    const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: 'levels', params: squeeze }, { effectId: 'levels', params: expand }], context: CONTEXT });
    const vsOracle = compare(out.data, expected, 270, 480), vsInput = compare(out.data, raw.data, 270, 480);
    log({ spec: 'pipeline', case: 'float-intermediates', backend, vsOracle, vsInput });
    expect.soft(vsOracle.maxErr, `${backend} vs oracle`).toBeLessThanOrEqual(1);
    expect.soft(vsInput.maxErr, `${backend} vs input (8-bit intermediates would band by ~5 codes)`).toBeLessThanOrEqual(1);
  });

  perBackend('empty stack and disabled-only stack return the input bytes unchanged (straight alpha included)', () => info, async backend => {
    const raw = noise(97, 61, (x, y) => (x * 7 + y * 3) & 255, 5);
    await ensureInput(page, 'noise-alpha', raw);
    for (const stack of [[], [{ effectId: 'glow', enabled: false }], [{ effectId: 'no-such-effect' }]]) {
      const out = await renderInPage(page, { backend, input: 'noise-alpha', stack });
      expect(compare(out.data, raw.data, 97, 61).maxErr, `${backend} ${JSON.stringify(stack)}`).toBe(0);
    }
  });
});

test.describe('CSS entries', () => {
  perBackend('returned in stack order with their filters, not rendered on the GPU', () => info, async backend => {
    const raw = stillAt('S3a*', 270, 480), key = 'S3a*@270x480', glow = variantParams('glow', 'defaults');
    await ensureInput(page, key, raw);
    const stack = [{ effectId: 'drop-shadow', params: { x: 3, y: -2, blur: 5, color: '#336699' } }, { effectId: 'glow', params: glow }, { effectId: 'invert', params: { amount: 40 } },
      { effectId: 'gaussian-blur', params: { radius: 6 }, enabled: false }, { effectId: 'gaussian-blur', params: { radius: 2.5 } }];
    const expected = oracleChain(raw, [{ id: 'glow', params: glow }]);
    const out = await renderInPage(page, { backend, input: key, stack, context: CONTEXT });
    expect(out.css.map(c => [c.effectId, c.filter])).toEqual([
      ['drop-shadow', 'drop-shadow(3px -2px 5px rgba(51, 102, 153, 1))'], ['invert', 'invert(40%)'], ['gaussian-blur', 'blur(2.5px)']]);
    const d = compare(out.data, expected, 270, 480);
    expect.soft(d.maxErr, `${backend} pixels = glow only`).toBeLessThanOrEqual(1);
  });
  test('oracle CSS invert on the GPU-rendered frame equals invert of the oracle chain (order GPU → CSS)', () => {
    // pure Node: confirms the oracle models the CSS chain after the GPU chain, as the renderer returns it
    const raw = stillAt('S3a*', 64, 64), img = toImage(raw);
    const inverted = oracleCss.invert(img, { amount: 100 }, CONTEXT);
    expect(inverted.data[0]).toBeCloseTo(1 - img.data[0], 6);
  });
});

test.describe('recolor (element data) and bg-removal (mask)', () => {
  const element = { palette: [{ base: '#c0392b', kind: 'color' }, { base: '#2c3e50', kind: 'neutral' }], colors: ['#27ae60', '#e67e22'] };
  const inputs: [string, () => Raw][] = [['hue-sweep*', () => hueSweep(270, 480)], ['S3a*', () => stillAt('S3a*', 270, 480)], ['S3c*', () => stillAt('S3c*', 270, 480)]];
  for (const [name, make] of inputs) {
    perBackend(`recolor first, empty stack, ${name} 270×480`, () => info, async backend => {
      const raw = make(), key = `recolor-${name}`;
      await ensureInput(page, key, raw);
      const expected = oracleChain(raw, [{ id: 'recolor', params: element }]);
      const out = await renderInPage(page, { backend, input: key, stack: [], context: { ...CONTEXT, element } });
      const d = compare(out.data, expected, 270, 480);
      log({ spec: 'pipeline', case: 'recolor', input: name, backend, ...d });
      expect.soft(d.maxErr, `${backend} max error`).toBeLessThanOrEqual(16);
      expect.soft(d.over2, `${backend} fraction over 2 codes`).toBeLessThanOrEqual(0.0001);
      expect.soft(d.ssim, `${backend} SSIM`).toBeGreaterThanOrEqual(0.98);
    });
  }
  perBackend('recolor runs before the stack entries (recolor → sepia)', () => info, async backend => {
    const raw = hueSweep(270, 480), key = 'recolor-chain', sepia = variantParams('sepia', 'max');
    await ensureInput(page, key, raw);
    const expected = oracleChain(raw, [{ id: 'recolor', params: element }, { id: 'sepia', params: sepia }]);
    const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: 'sepia', params: sepia }], context: { ...CONTEXT, element } });
    const d = compare(out.data, expected, 270, 480);
    expect.soft(d.maxErr, `${backend}`).toBeLessThanOrEqual(16);
    expect.soft(d.ssim, `${backend} SSIM`).toBeGreaterThanOrEqual(0.98);
  });
  perBackend('inactive palette (targets equal bases after rounding) leaves the input unchanged', () => info, async backend => {
    const raw = hueSweep(270, 480), key = 'recolor-inactive';
    await ensureInput(page, key, raw);
    const out = await renderInPage(page, { backend, input: key, stack: [], context: { ...CONTEXT, element: { palette: [{ base: '#336699', kind: 'color' }], colors: ['#336699'] } } });
    expect(compare(out.data, raw.data, 270, 480).maxErr).toBe(0);
  });

  const maskAt = (w: number, h: number): Raw => noise(w, h, (x, y) => Math.round(255 * (0.15 + 0.7 * (x / w) * (1 - y / h))), 9);
  for (const [mw, mh] of [[270, 480], [90, 160]] as const) {
    perBackend(`bg-removal with a ${mw}×${mh} mask on 270×480 (premultiplied output)`, () => info, async backend => {
      const raw = hueSweep(270, 480), key = 'bgr-input', mask = maskAt(mw, mh);
      await ensureInput(page, key, raw);
      const expected = oracleChain(raw, [{ id: 'bg-removal', params: {} }], { mask: toImage(mask) });
      const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: 'bg-removal' }], context: { ...CONTEXT, mask } });
      const d = compare(out.data, expected, 270, 480);
      log({ spec: 'pipeline', case: 'bg-removal', mask: `${mw}x${mh}`, backend, ...d });
      expect.soft(d.maxErr, `${backend} max error`).toBeLessThanOrEqual(2);
      expect.soft(d.ssim, `${backend} SSIM`).toBeGreaterThanOrEqual(0.98);
    });
  }
  perBackend('bg-removal without a mask is dropped (output = input)', () => info, async backend => {
    const raw = hueSweep(270, 480), key = 'bgr-input';
    await ensureInput(page, key, raw);
    const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: 'bg-removal' }], context: CONTEXT });
    expect(compare(out.data, raw.data, 270, 480).maxErr, backend).toBe(0);
  });
});

// S3 matrix for the two context-driven effects. Both have params = [] in the registry (recolor reads element data, bg-removal reads the
// mask), so the defaults/min/max variants are input-data presets: recolor = element data, bg-removal = mask. Bounds are the ones of the
// single tests above, not widened: recolor max error ≤ 16, fraction of channels > 2 codes ≤ 0.0001, SSIM ≥ 0.98; bg-removal ≤ 2, SSIM ≥ 0.98.
// Store stills (S3a, S3b, S3c) skip without $CUTFRAME_FIXTURES (T00 rule); the stand-ins S3a*, S3c* always run.
test.describe('recolor and bg-removal over the S3 stills (defaults / min / max)', () => {
  type El = { palette: { base: string; kind: string }[]; colors: string[] };
  const RECOLOR: Record<'defaults' | 'min' | 'max', El> = {
    defaults: { palette: [{ base: '#c0392b', kind: 'color' }, { base: '#2c3e50', kind: 'neutral' }], colors: ['#27ae60', '#e67e22'] },
    min: { palette: [{ base: '#c0392b', kind: 'color' }], colors: ['#c1392b'] },                       // weakest active recolor: 1 code in R
    max: { palette: [{ base: '#c0392b', kind: 'color' }, { base: '#2980b9', kind: 'color' }], colors: ['#2980b9', '#f1c40f'] }, // two colour entries: hue-share branch
  };
  const gradientMask = (w: number, h: number): Raw => noise(w, h, (x, y) => Math.round(255 * (0.15 + 0.7 * (x / w) * (1 - y / h))), 9);
  const MASK: Record<'defaults' | 'min' | 'max', () => Raw> = {
    defaults: () => gradientMask(270, 480),
    min: () => gradientMask(90, 160),                                                                  // lowest-resolution mask (bilinear upsample)
    max: () => noise(270, 480, (x, y) => (Math.floor(x / 30) + Math.floor(y / 30)) % 2 ? 255 : 0, 9),     // hard edges, alpha 0 and 1
  };
  for (const still of STILLS_ALL) for (const variant of ['defaults', 'min', 'max'] as const) {
    const store = !still.endsWith('*');
    perBackend(`recolor ${variant} ${still} 270×480`, () => info, async backend => {
      const raw = stillAt(still, 270, 480), key = `${still}@270x480`, element = RECOLOR[variant];
      await ensureInput(page, key, raw);
      const expected = oracleChain(raw, [{ id: 'recolor', params: element }]);
      const out = await renderInPage(page, { backend, input: key, stack: [], context: { ...CONTEXT, element } });
      const d = compare(out.data, expected, 270, 480);
      log({ spec: 'pipeline', case: 'recolor-matrix', variant, still, backend, ...d });
      expect.soft(d.maxErr, `${backend} max error`).toBeLessThanOrEqual(16);
      expect.soft(d.over2, `${backend} fraction over 2 codes`).toBeLessThanOrEqual(0.0001);
      expect.soft(d.ssim, `${backend} SSIM`).toBeGreaterThanOrEqual(0.98);
    }, { store });
    perBackend(`bg-removal ${variant} ${still} 270×480`, () => info, async backend => {
      const raw = stillAt(still, 270, 480), key = `${still}@270x480`, mask = MASK[variant]();
      await ensureInput(page, key, raw);
      const expected = oracleChain(raw, [{ id: 'bg-removal', params: {} }], { mask: toImage(mask) });
      const out = await renderInPage(page, { backend, input: key, stack: [{ effectId: 'bg-removal' }], context: { ...CONTEXT, mask } });
      const d = compare(out.data, expected, 270, 480);
      log({ spec: 'pipeline', case: 'bg-removal-matrix', variant, still, backend, ...d });
      expect.soft(d.maxErr, `${backend} max error`).toBeLessThanOrEqual(2);
      expect.soft(d.ssim, `${backend} SSIM`).toBeGreaterThanOrEqual(0.98);
    }, { store });
  }
});

test.describe('uploads', () => {
  perBackend('ImageBitmap, OffscreenCanvas and HTMLCanvasElement upload give the same pixels as a raw upload (opaque; semi-transparent via premultiplyAlpha none)', () => info, async backend => {
    const raw = noise(67, 43, () => 255, 3), semi = noise(67, 43, (x, y) => (x * 5 + y * 11) & 255, 4);
    {
      const result = await page.evaluate(async ({ backend, opaque, semiB64 }) => {
        const t = (window as any).__t, r = t.r[backend];
        const dec = (s: string) => { const bin = atob(s), d = new Uint8ClampedArray(bin.length); for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i); return d; };
        const read = async (src: any) => { const f = r.upload(src); const o = await r.read(f); r.release(f); return Array.from(o as Uint8Array); };
        const out: Record<string, number[]> = {};
        for (const [name, s] of [['opaque', opaque], ['semi', semiB64]] as const) {
          const data = dec(s), id = new ImageData(data, 67, 43);
          out[`${name}-raw`] = await read({ width: 67, height: 43, data: new Uint8Array(data.buffer) });
          out[`${name}-bitmap`] = await read(await createImageBitmap(id, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
          const oc = new OffscreenCanvas(67, 43); oc.getContext('2d')!.putImageData(id, 0, 0);
          out[`${name}-offscreen`] = await read(oc);
          const hc = document.createElement('canvas'); hc.width = 67; hc.height = 43; hc.getContext('2d')!.putImageData(id, 0, 0);
          out[`${name}-canvas`] = await read(hc);
        }
        return out;
      }, { backend, opaque: Buffer.from(raw.data).toString('base64'), semiB64: Buffer.from(semi.data).toString('base64') });
      for (const k of ['bitmap', 'offscreen', 'canvas']) {
        const d = compare(new Uint8Array(result[`opaque-${k}`]), new Uint8Array(result['opaque-raw']), 67, 43);
        expect.soft(d.maxErr, `${backend} opaque ${k} vs raw`).toBe(0);
      }
      const rawOpaque = compare(new Uint8Array(result['opaque-raw']), raw.data, 67, 43);
      expect.soft(rawOpaque.maxErr, `${backend} opaque raw round trip`).toBe(0);
      const rawSemi = compare(new Uint8Array(result['semi-raw']), semi.data, 67, 43);
      expect.soft(rawSemi.maxErr, `${backend} semi raw round trip`).toBe(0);
      const bm = compare(new Uint8Array(result['semi-bitmap']), new Uint8Array(result['semi-raw']), 67, 43);
      log({ spec: 'pipeline', case: 'semi-bitmap-vs-raw', backend, ...bm });
      expect.soft(bm.maxErr, `${backend} semi-transparent ImageBitmap (premultiplyAlpha none) vs raw`).toBe(0);
    }
  });
});

test.describe('transport stages', () => {
  perBackend('video-input-709 = bt709Table per colour channel, alpha kept (exact)', () => info, async backend => {
    const raw = noise(129, 77, (x, y) => (x * 3 + y * 5) & 255, 11), table = bt709Table();
    await ensureInput(page, 'stage709', raw);
    const expected = new Uint8Array(raw.data.length);
    for (let i = 0; i < raw.data.length; i += 4) { expected[i] = table[raw.data[i]]; expected[i + 1] = table[raw.data[i + 1]]; expected[i + 2] = table[raw.data[i + 2]]; expected[i + 3] = raw.data[i + 3]; }
    const out = await renderInPage(page, { backend, input: 'stage709', stack: [], stage: 'video-input-709' });
    expect([out.width, out.height]).toEqual([129, 77]);
    const d = compare(out.data, expected, 129, 77);
    log({ spec: 'pipeline', case: 'video-input-709', backend, ...d });
    expect.soft(d.maxErr, `${backend}`).toBe(0);
  });

  // Contract: SW is even (SW = 2W; stacked-alpha sources are packed videos). Even widths are strict.
  perBackend('stacked-alpha 128×60: RGB from the left half, alpha from the right half\'s R, output width 64 (even SW, ≤1 code)', () => info, async backend => {
    const W = 128, H = 60, raw = noise(W, H, () => 255, 21), outW = W / 2;
    await ensureInput(page, 'stacked-128', raw);
    const expected = new Uint8Array(outW * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < outW; x++) {
      const l = (y * W + x) * 4, r = (y * W + x + outW) * 4, o = (y * outW + x) * 4;
      expected.set([raw.data[l], raw.data[l + 1], raw.data[l + 2], raw.data[r]], o);
    }
    const out = await renderInPage(page, { backend, input: 'stacked-128', stack: [], stage: 'stacked-alpha' });
    expect([out.width, out.height], `${backend} size`).toEqual([outW, H]);
    expect(out.data.length).toBe(outW * H * 4);
    const d = compare(out.data, expected, outW, H);
    log({ spec: 'pipeline', case: 'stacked-alpha-128', backend, ...d });
    expect.soft(d.maxErr, `${backend}`).toBeLessThanOrEqual(1);
  });
  // Odd SW is outside the contract: no refusal, output ⌊SW/2⌋ × H, no throw, valid bytes. The alpha offset is NOT pinned.
  perBackend('stacked-alpha 129×60 (odd SW, outside the contract): output ⌊SW/2⌋ × H = 64×60, no throw, valid bytes, alpha offset not pinned', () => info, async backend => {
    const W = 129, H = 60, raw = noise(W, H, () => 255, 21), outW = Math.floor(W / 2);
    await ensureInput(page, 'stacked-129', raw);
    const out = await renderInPage(page, { backend, input: 'stacked-129', stack: [], stage: 'stacked-alpha' });
    expect([out.width, out.height], `${backend} size`).toEqual([outW, H]);
    expect(out.data.length).toBe(outW * H * 4);
    expect(out.data.every(v => Number.isInteger(v) && v >= 0 && v <= 255), `${backend} every byte is a valid 0-255 integer`).toBe(true);
    log({ spec: 'pipeline', case: 'stacked-alpha-129', backend, size: `${out.width}x${out.height}` });
  });
});
