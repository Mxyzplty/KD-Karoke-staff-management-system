// SPDX-License-Identifier: AGPL-3.0-only
// T12 masks in the real preview / capture path: an image item with masks → framePlan → composite (real Chromium Canvas 2D,
// no WebGPU) → pixels. One page load for the file; generated pixels only (no fixture store, no media).
// Oracle: findings part 5 §54.11 "Test values" (T1–T12, T8), Canvas path column only (§54.12 (2): canvas-path semantics for
// every mask — Cutframe has no GPU/canvas split). Fixture per §54.11: opaque item, box 400 × 400, no effects, k = 1; the
// default square mask is anchors (150,150) (250,150) (250,250) (150,250), closed, mode add, opacity 100, unless stated.
// Tolerances (§54.11): ±2/255 on T1, T2, T6, T7, T8; exact on T3–T5, T7b, T11, T12 (T9, T9b, T10 are covered by the pure
// t12-render-model.test.ts unit tests on model.ts and are not repeated here).
import { test, expect, type Page } from '@playwright/test';
import { createEditor } from '../../apps/web/src/timeline/harness';
import type { ProjectDocument } from '../../apps/web/src/store/model';
import { build, mkItem, mkTrack } from '../t03-fixtures';
import { b64, unb64 } from './t10a-support';

const W = 400, H = 400, FPS = 30;
let page: Page;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await browser.newPage();
  await page.addInitScript('window.__name = (f) => f');
  await page.goto('/');
  await page.evaluate(async () => {
    const m = '/src/render/model.ts', c = '/src/render/compositor.ts';
    const { framePlan } = await import(m), { composite } = await import(c);
    (window as unknown as { __frame: unknown }).__frame = (a: { doc: unknown; tMs: number; w: number; h: number; s: string }) => {
      const bin = atob(a.s), data = new Uint8ClampedArray(bin.length); for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      return createImageBitmap(new ImageData(data, a.w, a.h), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then(bitmap => {
        const plan = framePlan(a.doc as never, a.tMs), canvas = new OffscreenCanvas(a.w, a.h), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        composite(ctx, plan.draws, plan.draws.map(() => ({ image: bitmap, width: a.w, height: a.h })) as never, { width: a.w, height: a.h }, 'clear');
        const out = ctx.getImageData(0, 0, a.w, a.h).data; let s = '';
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000) as unknown as number[]);
        return { s: btoa(s), draws: plan.draws.length, pending: plan.pending.length };
      });
    };
  });
});
test.afterAll(async () => { await page?.close(); });

/** A flat fully-opaque 400 × 400 source: colour is irrelevant here, only output alpha (masks multiply alpha only, §54.1). */
function opaque(): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([200, 0, 0, 255], i * 4);
  return data;
}
const OPAQUE = opaque();

type Mask = { id: string; name: string; enabled: boolean; points: { anchor: { x: number; y: number } }[]; closed: boolean; mode: string; order: number; colorIndex: number;
  feather: number; expansion: number; opacity: number; inverted: boolean; source: 'shape' };
const pt = (x: number, y: number) => ({ anchor: { x, y } });
/** The default fixture square (150,150)(250,150)(250,250)(150,250), overridable per test. */
const squareMask = (extra: Partial<Mask> = {}): Mask => ({
  id: 'm1', name: 'Mask 1', enabled: true, closed: true, mode: 'add', order: 0, colorIndex: 0,
  feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape',
  points: [pt(150, 150), pt(250, 150), pt(250, 250), pt(150, 250)], ...extra,
});
/** A rect mask covering (x0,y0)–(x1,y1), used for the full-box (T7, T7b, T8) and half-box (T8) fixtures. */
const rectMask = (x0: number, y0: number, x1: number, y1: number, extra: Partial<Mask> = {}): Mask => ({
  id: 'm1', name: 'Mask 1', enabled: true, closed: true, mode: 'add', order: 0, colorIndex: 0,
  feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape',
  points: [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], ...extra,
});

/** An opaque image item filling the whole 400 × 400 project box (identity box matrix, item-local px = project px), masks baked
 *  into `masks` directly — §54.11's pixel coordinates apply without createMask's canvas-to-item-local transform. */
function docWith(masks: Mask[]): ProjectDocument {
  const doc = build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('img', 'V1', 0, 2000, { type: 'image', metadata: { assetId: 'asset-img' }, masks })], extra: { size: { width: W, height: H }, fps: FPS } });
  return JSON.parse(JSON.stringify(createEditor(doc).doc));
}
async function render(doc: unknown) {
  const r = await page.evaluate(a => (window as unknown as { __frame(a: unknown): Promise<{ s: string; draws: number; pending: number }> }).__frame(a),
    { doc, tMs: 0, w: W, h: H, s: b64(OPAQUE) });
  expect(r.draws, 'draws').toBe(1); expect(r.pending, 'pending').toBe(0);
  return unb64(r.s);
}
const alphaAt = (data: Uint8Array, x: number, y: number) => data[(y * W + x) * 4 + 3];
function expectAlpha(data: Uint8Array, x: number, y: number, expected: number, tol: number, label: string) {
  const got = alphaAt(data, x, y);
  expect(got, `${label} (${x},${y}): expected ${expected}±${tol}, got ${got}`).toBeGreaterThanOrEqual(expected - tol);
  expect(got, `${label} (${x},${y}): expected ${expected}±${tol}, got ${got}`).toBeLessThanOrEqual(expected + tol);
}

// ---- T1: feather 10 (±2/255) -----------------------------------------------------------------------------------------
test('T1: feather 10 — edge falloff and the 3σ-outside / centre / corner anchors', async () => {
  const data = await render(docWith([squareMask({ feather: 10 })]));
  expectAlpha(data, 150, 200, 132, 2, 'T1 first inside');
  expectAlpha(data, 149, 200, 123, 2, 'T1 first outside');
  expectAlpha(data, 175, 200, 254, 2, 'T1 well inside');
  expectAlpha(data, 200, 200, 255, 2, 'T1 centre');
  expectAlpha(data, 150, 150, 69, 2, 'T1 corner');
  expectAlpha(data, 120, 200, 0, 2, 'T1 3σ outside');
});

// ---- T2: feather 10, inverted (±2/255) -------------------------------------------------------------------------------
test('T2: feather 10, inverted — inside/outside swap, far outside stays opaque', async () => {
  const data = await render(docWith([squareMask({ feather: 10, inverted: true })]));
  expectAlpha(data, 150, 200, 123, 2, 'T2 first inside (inverted)');
  expectAlpha(data, 149, 200, 132, 2, 'T2 first outside (inverted)');
  expectAlpha(data, 0, 0, 255, 2, 'T2 far outside (inverted)');
});

// ---- T3: expansion +10 (exact) -----------------------------------------------------------------------------------
test('T3: expansion +10 — straight edge exact, round (not square) corner offset', async () => {
  const data = await render(docWith([squareMask({ expansion: 10 })]));
  expectAlpha(data, 140, 200, 255, 0, 'T3 inside expanded edge');
  expectAlpha(data, 139, 200, 0, 0, 'T3 outside expanded edge');
  expectAlpha(data, 141, 141, 0, 0, 'T3 outside the round corner (canvas path: round, not square)');
  expectAlpha(data, 143, 143, 255, 0, 'T3 inside the round corner');
});

// ---- T4: expansion −10 (exact) -----------------------------------------------------------------------------------
test('T4: expansion −10 — the mask shrinks exactly 10 px on every side', async () => {
  const data = await render(docWith([squareMask({ expansion: -10 })]));
  expectAlpha(data, 160, 200, 255, 0, 'T4 inside shrunk edge');
  expectAlpha(data, 159, 200, 0, 0, 'T4 outside shrunk edge');
  expectAlpha(data, 160, 160, 255, 0, 'T4 inside shrunk corner');
});

// ---- T5: expansion +2.5 (exact) ----------------------------------------------------------------------------------
test('T5: expansion +2.5 — a fractional offset still lands on an exact antialiased pixel', async () => {
  const data = await render(docWith([squareMask({ expansion: 2.5 })]));
  expectAlpha(data, 148, 200, 255, 0, 'T5 inside');
  expectAlpha(data, 147, 200, 128, 0, 'T5 half-covered edge pixel');
  expectAlpha(data, 146, 200, 0, 0, 'T5 outside');
});

// ---- T6: expansion +10, feather 5 (±2/255) -------------------------------------------------------------------------
test('T6: expansion +10 with feather 5 — expansion then feather, canvas-path values', async () => {
  const data = await render(docWith([squareMask({ expansion: 10, feather: 5 })]));
  expectAlpha(data, 140, 200, 137, 2, 'T6 inside expanded+feathered edge');
  expectAlpha(data, 139, 200, 118, 2, 'T6 outside expanded+feathered edge');
});

// ---- T7 / T7b: full-box rect ------------------------------------------------------------------------------------------
test('T7: full-box rect (0,0)–(400,400), feather 10 (±2/255)', async () => {
  const data = await render(docWith([rectMask(0, 0, 400, 400, { feather: 10 })]));
  expectAlpha(data, 0, 200, 132, 2, 'T7 edge midpoint');
  expectAlpha(data, 0, 0, 69, 2, 'T7 corner');
  expectAlpha(data, 30, 200, 255, 2, 'T7 well inside');
});
test('T7b: full-box rect, expansion −10 (exact)', async () => {
  const data = await render(docWith([rectMask(0, 0, 400, 400, { expansion: -10 })]));
  expectAlpha(data, 9, 200, 0, 0, 'T7b outside shrunk edge');
  expectAlpha(data, 10, 200, 255, 0, 'T7b inside shrunk edge');
});

// ---- T8: two full-box masks, A add 60 then B at the mode under test, opacity 50 (±2/255) ------------------------------
// A covers the whole canvas; B covers only the left half (0,0)–(200,400), so x=100 is "inside both" and x=300 is
// "inside A only (B empty)" — both far from the x=200 seam to avoid its own antialiasing.
test('T8: combination modes — inside-both and inside-A-only match §54.11\'s canvas-path column', async () => {
  const A = rectMask(0, 0, 400, 400, { id: 'm1', order: 0, mode: 'add', opacity: 60 });
  const cases: [string, number, number][] = [['add', 204, 153], ['subtract', 76, 153], ['intersect', 77, 0], ['difference', 127, 153]];
  for (const [mode, both, aOnly] of cases) {
    const B = rectMask(0, 0, 200, 400, { id: 'm2', order: 1, mode, opacity: 50 });
    const data = await render(docWith([A, B]));
    expectAlpha(data, 100, 200, both, 2, `T8 ${mode} inside both`);
    expectAlpha(data, 300, 200, aOnly, 2, `T8 ${mode} inside A only (B empty)`);
  }
});

// ---- T11: open path, fill still closes it (exact) ----------------------------------------------------------------
test('T11: open path (closed:false) — fill("nonzero") still closes the triangle', async () => {
  const data = await render(docWith([squareMask({ closed: false, points: [pt(100, 100), pt(300, 100), pt(300, 300)] })]));
  expectAlpha(data, 250, 150, 255, 0, 'T11 inside the implicitly-closed triangle');
  expectAlpha(data, 150, 250, 0, 0, 'T11 outside the implicitly-closed triangle');
});

// ---- T12: square in square (exact). A mask's `points` is one chain, so the two rings are joined by a bridge walked once each way: its two walks cancel in the
// winding count, and the rings' own directions decide the centre, which is what the row exercises (review finding m1).
test('T12: square in square — same winding keeps the centre, opposite winding leaves a hole', async () => {
  const outer = [pt(100, 100), pt(300, 100), pt(300, 300), pt(100, 300), pt(100, 100)], inner = [pt(150, 150), pt(250, 150), pt(250, 250), pt(150, 250)];
  const chain = (ring: typeof inner) => [...outer, ...ring, ring[0], outer[0]];
  const same = await render(docWith([squareMask({ points: chain(inner) })])), opposite = await render(docWith([squareMask({ points: chain([...inner].reverse()) })]));
  expectAlpha(same, 200, 200, 255, 0, 'T12 same winding, centre');
  expectAlpha(opposite, 200, 200, 0, 0, 'T12 opposite winding, centre');
  expectAlpha(opposite, 120, 200, 255, 0, 'T12 opposite winding, between the rings');
});

// ---- M7: the same offsets on a raster. The raster is the rectangle itself at 400 × 400, so any difference from the vector mask is the offset's. Pixels along the row and
// the column through the rectangle's centre must equal the vector mask's: T3, T4, T5, T7, T7b, and a rectangle touching one edge of the box (§54.12: one expansion for every mask).
const RASTER = { file: 'r.dmk', sourceStartUs: 0, sourceEndUs: 2_000_000, frameCount: 1, width: W, height: H, space: { kind: 'item', width: W, height: H }, version: 1 };
const putRaster = ([x0, y0, x1, y1]: number[]) => page.evaluate(async ({ x0, y0, x1, y1, W, H, ref }) => {
  const p = '/src/masks/raster.ts', { RasterWriter, readyRaster, useRasterStore } = await import(p), plane = new Uint8Array(W * H), w = new RasterWriter(W, H);
  for (let y = y0; y < y1; y++) plane.fill(255, y * W + x0, y * W + x1);
  await w.add(0, plane);
  const blob = w.blob();
  useRasterStore({ writeMask: async () => undefined, readMask: async () => blob });
  await readyRaster(ref, 0);
}, { x0, y0, x1, y1, W, H, ref: RASTER });
const CASES: [string, number[], Partial<Mask>, number][] = [
  ['T3 expansion +10', [150, 150, 250, 250], { expansion: 10 }, 0], ['T4 expansion −10', [150, 150, 250, 250], { expansion: -10 }, 0], ['T5 expansion +2.5', [150, 150, 250, 250], { expansion: 2.5 }, 0],
  ['T7 full box, feather 10', [0, 0, 400, 400], { feather: 10 }, 2], ['T7b full box, expansion −10', [0, 0, 400, 400], { expansion: -10 }, 0], ['touching the box\'s left edge, expansion −10', [0, 100, 200, 300], { expansion: -10 }, 0],
];
for (const [name, rect, extra, tolerance] of CASES) test(`M7: ${name} — a raster gives the vector mask's pixels through its centre (±${tolerance}/255)`, async () => {
  const [x0, y0, x1, y1] = rect, cx = (x0 + x1) >> 1, cy = (y0 + y1) >> 1, vector = await render(docWith([rectMask(x0, y0, x1, y1, extra)]));
  await putRaster(rect);
  const raster = await render(docWith([rectMask(x0, y0, x1, y1, { ...extra, points: [], raster: RASTER, source: 'smart' } as unknown as Partial<Mask>)]));
  const off: string[] = [];
  for (let k = 0; k < W; k++) for (const [x, y] of [[k, cy], [cx, k]]) { const a = alphaAt(raster, x, y), b = alphaAt(vector, x, y); if (Math.abs(a - b) > tolerance) off.push(`(${x},${y}) raster ${a} vector ${b}`); }
  expect(off).toEqual([]);
});

// ---- M7, review round 2: shrinking must not add coverage (§54.3, §54.12). On a resampled raster the edge pixels hold interpolated coverage, so at every negative
// expansion, whole or fractional, each pixel of the real combinedPlane stays at or under the same pixel with a smaller shrink: 0, then −0.1, … −5, feather or not.
const ERODE = [-0.1, -0.25, -0.5, -0.75, -1, -2.5, -5];
const SOURCES: [string, number, number, number, boolean?][] = [['binary, full', 10, 10, 0], ['binary, a square inside', 13, 7, 1], ['a ramp', 16, 16, 2], ['noise', 9, 11, 3], ['binary, a square inside, clamped', 13, 7, 1, true]];
for (const [name, w, h, kind, clamp] of SOURCES) for (const feather of [0, 3]) test(`M7: negative expansion never raises alpha on a resampled raster: ${name}, ${w} × ${h} to 20 × 20, feather ${feather}`, async () => {
  const raised = await page.evaluate(async ({ w, h, kind, clamp, feather, ERODE }) => {
    const r = '/src/masks/render.ts', { combinedPlane } = await import(r), plane = new Uint8Array(w * h);
    let seed = 12345;
    for (let y = 0, k = 0; y < h; y++) for (let x = 0; x < w; x++, k++) plane[k] = kind === 0 ? 255 : kind === 1 ? (x >= 3 && x < 10 && y >= 2 && y < 5 ? 255 : 0) : kind === 2 ? 255 * (x + y) / (w + h - 2) : (seed = seed * 1103515245 + 12345 & 0x7fffffff) >> 16 & 255;
    const ref = { file: 'x', sourceStartUs: 0, sourceEndUs: 1e6, frameCount: 1, width: w, height: h, space: { kind: 'source', width: w, height: h }, version: 1, ...clamp ? { edgeSampling: 'clamp' } : {} };
    const at = (expansion: number) => combinedPlane([{ id: 'm', mode: 'add', inverted: false, opacity: 1, feather, expansion, path: null, raster: { timeUs: 0, ref } }], [plane], 20, 20);
    const out: string[] = [];
    let before = at(0), last = 0;
    for (const e of ERODE) {
      const now = at(e), up = now.filter((v: number, k: number) => v > before[k]).length;
      if (up) out.push(`${last} to ${e}: ${up} pixels rose, ${now.reduce((m: number, v: number, k: number) => Math.max(m, v - before[k]), 0)} at most`);
      before = now; last = e;
    }
    return out;
  }, { w, h, kind, clamp, feather, ERODE });
  expect(raised).toEqual([]);
});
