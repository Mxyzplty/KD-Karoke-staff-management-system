// SPDX-License-Identifier: AGPL-3.0-only
// T10 effects engine in the preview / capture path: an image item with effects → framePlan → composite (Canvas 2D + the WebGL2 effect stage)
// → pixels. One page load for the file; generated pixels only (no fixture store, no media).
// Oracle: the T10a pixel oracle parity/oracle (part 4 §48 0.3 / §49: grayscale §49.x, levels, colour keyers, Lumetri §49.18), compared with the T10a
// rule 6 (max error ≤ 4 codes, ≤ 0.1 % of channels over 1 code, SSIM ≥ 0.98); §53.4.1 (item canvas → effects → box), §53.9 (frame n at 30 fps =
// n / 30 s); the property clock is the trim axis (§38). Lumetri is retired: it cannot be added, only rendered from a stored instance (§49.18).
import { test, expect, type Page } from '@playwright/test';
import { createEditor } from '../../apps/web/src/timeline/harness';
import { resolveParams } from '../../apps/web/src/effects/validate';
import type { ProjectDocument } from '../../apps/web/src/store/model';
import { build, mkItem, mkTrack } from '../t03-fixtures';
import { effects as oracleEffects } from '../../parity/oracle/effects';
import { b64, compare, expectRule6, oracleWith, quantise, rule6Note, toImage, unb64, type Raw } from './t10a-support';

const W = 270, H = 480, FPS = 30;
let page: Page;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await browser.newPage();
  await page.addInitScript('window.__name = (f) => f');
  await page.goto('/');
  // The two render modules the preview uses, loaded once; the helper draws one frame and returns straight RGBA8 (getImageData).
  await page.evaluate(async () => {
    const m = '/src/render/model.ts', c = '/src/render/compositor.ts';
    const { framePlan } = await import(m), { composite } = await import(c);
    (window as unknown as { __frame: unknown }).__frame = (a: { doc: unknown; tMs: number; w: number; h: number; s: string; backdrop: 'black' | 'clear' }) => {
      const bin = atob(a.s), data = new Uint8ClampedArray(bin.length); for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      return createImageBitmap(new ImageData(data, a.w, a.h), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then(bitmap => {
        const plan = framePlan(a.doc as never, a.tMs), canvas = new OffscreenCanvas(a.w, a.h), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        composite(ctx, plan.draws, plan.draws.map(() => ({ image: bitmap, width: a.w, height: a.h })) as never, { width: a.w, height: a.h }, a.backdrop);
        const out = ctx.getImageData(0, 0, a.w, a.h).data; let s = '';
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000) as unknown as number[]);
        return { s: btoa(s), draws: plan.draws.length, pending: plan.pending.length, gpu: plan.draws.map((d: { effects: { effectId: string }[] }) => d.effects.map(e => e.effectId)) };
      });
    };
  });
});
test.afterAll(async () => { await page?.close(); });

// ---- generated pixels -----------------------------------------------------------------------------------------------
/** Colourful opaque pattern with a key-green band; alpha(y) lets a case make part of it semi-transparent. R = x ramp, G = y ramp, B = saw. */
function pattern(alphaAt: (x: number, y: number) => number = () => 255): Raw {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const band = x >= 90 && x < 180, jitter = (y % 20) - 10;
    const rgb = band ? [0, 177 + jitter, 64] : [Math.round(x / (W - 1) * 255), Math.round(y / (H - 1) * 255), ((x + y) % 64) * 4];
    data.set([...rgb, alphaAt(x, y)], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
}
const OPAQUE = pattern();
const CTX = { timeS: 0, seed: 0 };

/** An image item 0–2000 ms on a W×H project; `edit` runs through the same agent tools the app uses (writeEffects / writeKeyframes). */
function docWith(edit: (call: (tool: string, args: Record<string, unknown>) => unknown) => void): ProjectDocument {
  const doc = build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('img', 'V1', 0, 2000, { type: 'image', metadata: { assetId: 'asset-img' } })], extra: { size: { width: W, height: H }, fps: FPS } });
  const e = createEditor(doc);
  edit((tool, args) => { const r = e.call(tool, args) as { success?: boolean; message?: string }; expect(r, `${tool} ${JSON.stringify(args)}`).toMatchObject({ success: true }); return r; });
  return JSON.parse(JSON.stringify(e.doc));
}
async function render(doc: unknown, n: number, raw: Raw, backdrop: 'black' | 'clear' = 'clear') {
  const r = await page.evaluate(a => (window as unknown as { __frame(a: unknown): Promise<{ s: string; draws: number; pending: number; gpu: string[][] }> }).__frame(a),
    { doc, tMs: n / FPS * 1000, w: W, h: H, s: b64(raw.data), backdrop });
  expect(r.draws, `frame ${n} draws`).toBe(1); expect(r.pending, `frame ${n} pending`).toBe(0);
  return { data: unb64(r.s), gpu: r.gpu[0] };
}
const full = (id: string, p: Record<string, unknown>) => resolveParams(id, p);
/** What the effect stage reads from a semi-transparent source: the item canvas stores 8-bit premultiplied colour, and the upload un-premultiplies it. */
function viaItemCanvas(raw: Raw): Raw {
  const data = raw.data.slice();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]; if (a === 0 || a === 255) continue;
    for (let k = 0; k < 3; k++) data[i + k] = Math.min(255, Math.round(Math.round(raw.data[i + k] * a / 255) * 255 / a));
  }
  return { ...raw, data };
}

// ---- WebGL effects on a generated image, T10a oracle --------------------------------------------------------------
test('grayscale 100 on an image item: the composited frame matches the oracle (rule 6)', async () => {
  const doc = docWith(call => call('writeEffects', { itemId: 'img', add: [{ effectId: 'grayscale' }] }));
  const out = await render(doc, 0, OPAQUE);
  expect(out.gpu).toEqual(['grayscale']);
  const d = compare(out.data, oracleWith('grayscale', OPAQUE, full('grayscale', { amount: 100 }), CTX), W, H);
  test.info().annotations.push({ type: 'measured', description: `grayscale 100: ${rule6Note(d)}` });
  expectRule6(d, 'grayscale 100');
  // Grayscale really happened: R = G = B everywhere (±1 code of GPU rounding)
  let maxSpread = 0; for (let p = 0; p < W * H; p++) maxSpread = Math.max(maxSpread, Math.abs(out.data[p * 4] - out.data[p * 4 + 1]), Math.abs(out.data[p * 4 + 1] - out.data[p * 4 + 2]));
  expect(maxSpread, 'channel spread of a grayscale-100 frame').toBeLessThanOrEqual(1);
});

// Rebase onto c26dd28: a motion graphic's frame (T08, here the generated picture stands in for the sandbox's) goes through the same effect stage.
// The registry gives a graphic the CSS effects only (invert, gaussian-blur, drop-shadow), so the check is invert 100: 255 − source per channel.
test('invert 100 on a motion graphic: its frame is drawn through the effect path, every channel 255 − source', async () => {
  const doc = build({ tracks: [mkTrack('O1', 'overlay')], items: [mkItem('g', 'O1', 0, 2000, { type: 'motionGraphic', details: { name: 'Graphic', code: 'export const G = () => <AbsoluteFill />;' } })],
    extra: { size: { width: W, height: H }, fps: FPS } });
  const e = createEditor(doc);
  expect(e.call('writeEffects', { itemId: 'g', add: [{ effectId: 'invert' }] })).toMatchObject({ success: true });
  const out = await render(JSON.parse(JSON.stringify(e.doc)), 0, OPAQUE);
  expect(out.gpu).toEqual([]);
  let maxErr = 0, alpha = 255;
  for (let i = 0; i < W * H * 4; i += 4) {
    for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(out.data[i + k] - (255 - OPAQUE.data[i + k])));
    alpha = Math.min(alpha, out.data[i + 3]);
  }
  expect(maxErr, 'largest channel difference from 255 − source').toBeLessThanOrEqual(1); expect(alpha).toBe(255);
});

test('levels on an image item matches the oracle; the same effect disabled leaves the picture untouched', async () => {
  const values = { inputBlack: 10, inputWhite: 90, gamma: 1.4, outputBlack: 5, outputWhite: 95 };
  const doc = docWith(call => call('writeEffects', { itemId: 'img', add: [{ effectId: 'levels', initialParameters: values }] }));
  const d = compare((await render(doc, 0, OPAQUE)).data, oracleWith('levels', OPAQUE, full('levels', values), CTX), W, H);
  test.info().annotations.push({ type: 'measured', description: `levels: ${rule6Note(d)}` });
  expectRule6(d, 'levels');
  const off = docWith(call => { call('writeEffects', { itemId: 'img', add: [{ effectId: 'levels', initialParameters: values }] }); call('writeEffects', { itemId: 'img', effects: { levels_1: { enabled: false } } }); });
  const plain = await render(off, 0, OPAQUE);
  expect(plain.gpu, 'a disabled effect leaves the GPU list empty').toEqual([]);
  expect(compare(plain.data, OPAQUE.data, W, H).maxErr, 'disabled effect → the source pixels').toBe(0);
});

test('stack order: [grayscale, levels] and [levels, grayscale] each match the oracle chain and differ from each other', async () => {
  const lv = { inputBlack: 20, inputWhite: 80, gamma: 0.7, outputBlack: 0, outputWhite: 100 };
  // The GPU chain keeps float between effects, so the oracle chain does too: one quantise at the end.
  const chain = (ids: string[]) => quantise(ids.reduce((img, id) => oracleEffects[id](img, full(id, id === 'levels' ? lv : { amount: 60 }), CTX), toImage(OPAQUE)));
  const outs: Uint8Array[] = [];
  for (const ids of [['grayscale', 'levels'], ['levels', 'grayscale']]) {
    const doc = docWith(call => call('writeEffects', { itemId: 'img', add: ids.map(effectId => ({ effectId, initialParameters: effectId === 'levels' ? lv : { amount: 60 } })) }));
    const out = await render(doc, 0, OPAQUE);
    expect(out.gpu).toEqual(ids);
    const d = compare(out.data, chain(ids), W, H);
    test.info().annotations.push({ type: 'measured', description: `${ids.join(' → ')}: ${rule6Note(d)}` });
    expectRule6(d, ids.join(' → ')); outs.push(out.data);
  }
  expect(compare(outs[0], outs[1], W, H).maxErr, 'the two stack orders must not render the same').toBeGreaterThan(4);
});

// ---- a keyframed parameter over time ----------------------------------------------------------------------------------
test('keyframed grayscale amount 0 → 100 over 1 s: frames 0, 10, 20, 30 at 30 fps follow the sweep', async () => {
  const doc = docWith(call => {
    call('writeEffects', { itemId: 'img', add: [{ effectId: 'grayscale' }] });
    call('writeKeyframes', { itemId: 'img', effectId: 'grayscale_1', payload: { amount: { replace: [{ time: 0, value: 0, easing: 'linear' }, { time: 1, value: 100, easing: 'linear' }] } } });
  });
  const seen: number[] = [];
  for (const n of [0, 10, 20, 30]) {
    const amount = n / FPS * 100, out = await render(doc, n, OPAQUE);
    const d = compare(out.data, oracleWith('grayscale', OPAQUE, full('grayscale', { amount }), CTX), W, H);
    test.info().annotations.push({ type: 'measured', description: `frame ${n} (amount ${amount.toFixed(3)}): ${rule6Note(d)}` });
    expectRule6(d, `frame ${n} amount ${amount.toFixed(2)}`);
    // saturation left in the frame falls as the sweep rises: mean |R−G|
    let spread = 0; for (let p = 0; p < W * H; p++) spread += Math.abs(out.data[p * 4] - out.data[p * 4 + 1]);
    seen.push(spread / (W * H));
  }
  expect(seen[0], 'frame 0 is the untouched picture (amount 0)').toBeGreaterThan(20);
  expect(seen[3], 'frame 30 is fully grey (amount 100)').toBeLessThan(1);
  expect(seen, 'colour spread falls monotonically across frames 0, 10, 20, 30').toEqual([...seen].sort((a, b) => b - a));
});

// ---- Lumetri (retired): renders from a stored instance, preview / capture path only ---------------------------------------
test('Lumetri Color (retired, stored instance) renders in the preview path and matches the §49.18 oracle', async () => {
  const lumetri = {
    temperature: 20, tint: -10, exposure: 0.5, contrast: 15, highlights: -20, shadows: 25, whites: 10, blacks: -10, saturation: 120, vibrance: 30,
    shadowsWheel: { angle: 200, distance: 0.3 }, midtonesWheel: { angle: 40, distance: 0.2 }, highlightsWheel: { angle: 300, distance: 0.4 },
  };
  const doc = docWith(() => { /* no effects: the instance is stored by hand below, as an existing project would hold it */ }) as ProjectDocument;
  const item = doc.items.find(i => i.id === 'img')!;
  item.effects = [{ id: 'effect_1730000000000_lumetri01', effectId: 'lumetri-color', enabled: true, order: 0,
    parameters: Object.fromEntries(Object.entries(lumetri).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }])) }];
  const out = await render(doc, 0, OPAQUE);
  expect(out.gpu).toEqual(['lumetri-color']);
  const d = compare(out.data, oracleWith('lumetri-color', OPAQUE, full('lumetri-color', lumetri), CTX), W, H);
  test.info().annotations.push({ type: 'measured', description: `lumetri-color: ${rule6Note(d)}` });
  expectRule6(d, 'lumetri-color');
  expect(compare(out.data, OPAQUE.data, W, H).maxErr, 'Lumetri changed the picture').toBeGreaterThan(8);
});

// ---- keyers composite premultiplied -------------------------------------------------------------------------------------
test('colour key: opaque source → alpha follows the keyer, colour stays straight (premultiplied composite)', async () => {
  const values = { keyColor: '#00b140', similarity: 40, smoothness: 10, spillReduction: 50 };
  const doc = docWith(call => call('writeEffects', { itemId: 'img', add: [{ effectId: 'color-key', initialParameters: values }] }));
  const out = (await render(doc, 0, OPAQUE)).data, ref = oracleWith('color-key', OPAQUE, full('color-key', values), CTX);
  // Oracle rgb is premultiplied by the key alpha: the canvas's straight colour is rgb / alpha where alpha is not 0.
  let alphaErr = 0, colourErr = 0, keyed = 0, solid = 0, partial = 0;
  for (let p = 0; p < W * H; p++) {
    const a = ref[p * 4 + 3], got = out[p * 4 + 3];
    alphaErr = Math.max(alphaErr, Math.abs(got - a));
    if (a === 0) keyed++; else if (a === 255) solid++; else partial++;
    if (a >= 128) for (let k = 0; k < 3; k++) colourErr = Math.max(colourErr, Math.abs(out[p * 4 + k] - Math.min(255, Math.round(ref[p * 4 + k] * 255 / a))));
  }
  test.info().annotations.push({ type: 'measured', description: `color-key opaque: alpha max err ${alphaErr}, straight colour max err (alpha ≥ 128) ${colourErr}; pixels keyed ${keyed} partial ${partial} solid ${solid}` });
  expect(keyed, 'the key-green band is keyed out').toBeGreaterThan(W * H / 10);
  expect(solid, 'the rest of the picture stays opaque').toBeGreaterThan(W * H / 3);
  expect(alphaErr, 'alpha vs the oracle (codes)').toBeLessThanOrEqual(4);
  expect(colourErr, 'straight colour of the kept pixels vs oracle rgb / alpha (codes)').toBeLessThanOrEqual(4);
});

test('colour key and luma key on a semi-transparent source: alpha = source alpha × key alpha; colour composites premultiplied', async () => {
  const A0 = 128, halfA = pattern((_, y) => y < H / 2 ? 255 : A0);
  for (const [effectId, values] of [['color-key', { keyColor: '#00b140', similarity: 40, smoothness: 10, spillReduction: 50 }], ['luma-key', { keyType: 'bright', threshold: 60, softness: 10 }]] as const) {
    const doc = docWith(call => call('writeEffects', { itemId: 'img', add: [{ effectId, initialParameters: values }] }));
    const out = (await render(doc, 0, halfA)).data, ref = oracleWith(effectId, viaItemCanvas(halfA), full(effectId, values), CTX);
    // The oracle pair (rgb, alpha) is read as premultiplied, as the canvas does: colour above alpha is clamped to alpha. Its input is the source as the item canvas
    // hands it over (8-bit premultiplied round trip); pixels it keys fully out or fully keeps are compared, the narrow transition band is only counted.
    let aErr = 0, pErr = 0, hard = 0, soft = 0, keptSemi = 0, outBrighter = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4, src = halfA.data[p + 3], a = ref[p + 3];
      if (a !== 0 && a !== src) { soft++; if (out[p + 3] > src + 1) outBrighter++; continue; }
      hard++;
      aErr = Math.max(aErr, Math.abs(out[p + 3] - a));
      for (let k = 0; k < 3; k++) pErr = Math.max(pErr, Math.abs(Math.round(out[p + k] * out[p + 3] / 255) - Math.min(ref[p + k], a)));
      if (a === A0) keptSemi++;
    }
    test.info().annotations.push({ type: 'measured', description: `${effectId} on a source with alpha ${A0} in the lower half: alpha max err ${aErr}, premultiplied colour max err ${pErr}; ${hard} fully keyed / fully kept pixels (${keptSemi} kept at alpha ${A0}), ${soft} in the transition band` });
    expect(keptSemi, `${effectId} keeps semi-transparent pixels`).toBeGreaterThan(1000);
    expect(hard, `${effectId} transition band is the small part of the frame`).toBeGreaterThan(W * H * 0.6);
    expect(aErr, `${effectId} alpha vs oracle on fully keyed / kept pixels (codes)`).toBeLessThanOrEqual(2);
    expect(pErr, `${effectId} premultiplied colour vs oracle (codes)`).toBeLessThanOrEqual(2);
    expect(outBrighter, `${effectId} transition-band pixels more opaque than their source`).toBe(0);
  }
});
