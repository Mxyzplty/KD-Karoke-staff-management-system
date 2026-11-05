// SPDX-License-Identifier: AGPL-3.0-only
// T11 transitions in the preview / capture path: two solid-colour image clips (A red 0–2 s, B blue 2–4 s, one track) with a 1 s centred transition
// (window [1500, 2500) ms, §55.2: p = (t − 1500) / 1000) → framePlan → composite (Canvas 2D) → pixels, on a 64×36 project. Generated pixels only.
// Oracle: findings part 5 §55.4 (A and B on their own transparent surfaces, combined by kind, drawn once source-over) and §55.5 (the per-kind maths):
//   fade       A for p < 0.5 then B, over opaque black with alpha cos(πp) / −cos(πp)
//   dissolve   B over A with weight 0.5 − 0.5·cos(πp)
//   additive   lighter: (1 − p)·A + p·B per channel
//   dip        A (p < 0.5) or B, then a solid colour with alpha smoothstep(2p) up / 1 − smoothstep(2p − 1) down (default colour black)
//   slide      e = inOutCubic(p); the outgoing clip moves e·W (or e·H) away from the named side, the incoming one enters at (e − 1)·W; whole px, round half up
//   wipe       B shows through a mask from the entry side: front f = p·(1 + s), feather s; s = 0 is a hard edge of ⌊p·L + 0.5⌋ px
// Tolerances (G-08 / §55.0): fade and dip ±0.06 in alpha (±15 of 255 per channel); every other kind ±1 LSB, except the two dissolve kinds (DISSOLVE_TOL, accepted by D32 Q11: see below).
// Own, not from the doc: an unknown stored kind hard-cuts and is listed in `pending` as {owner 'T11', what "Transition kind '<k>'"}; the pool is lazy.
import { test, expect, type Page } from '@playwright/test';
import { build, mkItem, mkTrack } from '../t03-fixtures';

const W = 64, H = 36, FPS = 30;
const T0 = 1500;                                          // window start; the cut is 2000, so p = (t − 1500) / 1000
const ID = 'transition_abcdefghij';
type RGB = [number, number, number];
const RED: RGB = [255, 0, 0], BLUE: RGB = [0, 0, 255], BLACK: RGB = [0, 0, 0];
const ALPHA_TOL = 0.06 * 255;                             // fade and dip
const LSB = 1;
// D32 Q11 accepts ±3 LSB for Canvas 2D dissolve and additive dissolve (§55.0); no float16 or WebGL2 path.
// A sweep of the shipped `combine` measured worst 2.09 for dissolve and 2.20 for additive dissolve, over 565 colour pairs (the reviewer's pair, 500 seeded
// random pairs, the 64 ordered 0/255 corner pairs) × 21 steps of p.
//   dissolve:  A (17,99,250) → B (240,128,3) at p .3, blue 197 against 199.09.
//   additive:  A (47,105,247) → B (74,118,9) at p .9, blue 35 against 32.80.
// Cause: Canvas 2D stores globalAlpha in 8 bits and rounds the blend to 8 bits. A float16 result surface meets ±1 (0.94 worst) at 3.7× the 1080p cost; WebGL2 meets it at 4–9×.
// Accepted tolerance for both dissolve kinds (the red/blue rows measure less; the general-colour case below is the one that needs 3).
const DISSOLVE_TOL = 3;

let page: Page;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await browser.newPage();
  await page.addInitScript('window.__name = (f) => f');
  await page.goto('/');
  await page.evaluate(async ({ w, h }) => {
    const m = '/src/render/model.ts', c = '/src/render/compositor.ts';
    const { framePlan } = await import(m), { composite } = await import(c);
    const solid = (r: number, g: number, b: number) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) d.set([r, g, b, 255], i); return createImageBitmap(new ImageData(d, w, h)); };
    const red = await solid(255, 0, 0), blue = await solid(0, 0, 255);
    const w2 = window as unknown as Record<string, unknown>;
    w2.__plan = (a: { doc: unknown; tMs: number }) => {
      const p = framePlan(a.doc as never, a.tMs);
      return { draws: p.draws.map((d: any) => ({ id: d.item.id, sourceMs: d.sourceMs, transition: d.transition ?? null })), pending: p.pending };
    };
    // Sources are solid bitmaps: A red and every other item blue, unless `colors` names an item id (made in the page, cached per colour).
    const made = new Map<string, ImageBitmap>();
    const bitmap = async (c: [number, number, number]) => { const k = c.join(); if (!made.has(k)) made.set(k, await solid(c[0], c[1], c[2])); return made.get(k)!; };
    w2.__frame = async (a: { doc: unknown; tMs: number; backdrop: 'black' | 'clear'; colors?: Record<string, [number, number, number]> }) => {
      const plan = framePlan(a.doc as never, a.tMs), canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const sources = await Promise.all(plan.draws.map(async (d: any) => ({ image: a.colors?.[d.item.id] ? await bitmap(a.colors[d.item.id]) : d.item.id === 'A' ? red : blue, width: w, height: h })));
      const failed = composite(ctx, plan.draws, sources as never, { width: w, height: h }, a.backdrop);
      const out = ctx.getImageData(0, 0, w, h).data; let s = '';
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000) as unknown as number[]);
      return { s: btoa(s), failed: failed.length, pending: plan.pending, draws: plan.draws.map((d: any) => ({ id: d.item.id, transition: d.transition ?? null })) };
    };
  }, { w: W, h: H });
});
test.afterAll(async () => { await page?.close(); });

// ---- documents and frames -------------------------------------------------------------------------------------------
/** A (image, 0–2000) → B (image, 2000–4000) on V1, one stored transition (or none). */
function docWith(rec: Record<string, unknown> | null) {
  const img = (id: string, from: number, to: number) => mkItem(id, 'V1', from, to, { type: 'image', metadata: { assetId: `asset-${id}` } });
  return JSON.parse(JSON.stringify(build({
    tracks: [mkTrack('V1', 'video')], items: [img('A', 0, 2000), img('B', 2000, 4000)],
    extra: { size: { width: W, height: H }, fps: FPS, transitions: rec ? [{ id: ID, trackId: 'V1', fromId: 'A', toId: 'B', durationMs: 1000, alignment: 0.5, ...rec }] : [] },
  })));
}
type Frame = { px: (x: number, y: number) => number[]; all: () => number[][]; failed: number; pending: any[]; draws: { id: string; transition: any }[] };
async function frame(doc: unknown, tMs: number, backdrop: 'black' | 'clear' = 'black', colors?: Record<string, RGB>): Promise<Frame> {
  const r = await page.evaluate(a => (window as any).__frame(a), { doc, tMs, backdrop, colors }) as { s: string; failed: number; pending: any[]; draws: any[] };
  const data = Buffer.from(r.s, 'base64');
  const px = (x: number, y: number) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  return { px, all: () => Array.from({ length: W * H }, (_, i) => px(i % W, Math.floor(i / W))), failed: r.failed, pending: r.pending, draws: r.draws };
}
const atP = (p: number) => T0 + p * 1000;
/** Every channel of a pixel within tol of the wanted colour, opaque. */
function near(got: number[], want: number[], tol: number, what: string) {
  for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k]), `${what}: channel ${'RGB'[k]} got ${got} want ${want.map(v => +v.toFixed(2))}`).toBeLessThanOrEqual(tol);
  expect(got[3], `${what}: alpha`).toBe(255);
}
const mix = (a: RGB, b: RGB, w: number): RGB => [0, 1, 2].map(k => a[k] * (1 - w) + b[k] * w) as RGB;
const smooth = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };

// ---- uniform kinds: the whole frame is one colour ---------------------------------------------------------------------
const PS = [0, 0.25, 0.5, 0.75, 0.999];
const uniform: { kind: string; rec: Record<string, unknown>; tol: number; want: (p: number) => RGB }[] = [
  { kind: 'fade', rec: { kind: 'fade' }, tol: ALPHA_TOL, want: p => p < 0.5 ? mix(BLACK, RED, Math.cos(Math.PI * p)) : mix(BLACK, BLUE, -Math.cos(Math.PI * p)) },
  { kind: 'dissolve', rec: { kind: 'dissolve' }, tol: DISSOLVE_TOL, want: p => mix(RED, BLUE, 0.5 - 0.5 * Math.cos(Math.PI * p)) },
  { kind: 'additiveDissolve', rec: { kind: 'additiveDissolve' }, tol: DISSOLVE_TOL, want: p => [255 * (1 - p), 0, 255 * p] },
  { kind: 'dipToColorDissolve (green)', rec: { kind: 'dipToColorDissolve', params: { color: [0, 1, 0] } }, tol: ALPHA_TOL,
    want: p => mix(p < 0.5 ? RED : BLUE, [0, 255, 0], p < 0.5 ? smooth(p / 0.5) : 1 - smooth((p - 0.5) / 0.5)) },
  { kind: 'dipToColorDissolve (default colour: black)', rec: { kind: 'dipToColorDissolve' }, tol: ALPHA_TOL,
    want: p => mix(p < 0.5 ? RED : BLUE, BLACK, p < 0.5 ? smooth(p / 0.5) : 1 - smooth((p - 0.5) / 0.5)) },
  { kind: 'dipToColorDissolve (0.2, 0.4, 0.6)', rec: { kind: 'dipToColorDissolve', params: { color: [0.2, 0.4, 0.6] } }, tol: ALPHA_TOL,
    want: p => mix(p < 0.5 ? RED : BLUE, [51, 102, 153], p < 0.5 ? smooth(p / 0.5) : 1 - smooth((p - 0.5) / 0.5)) },
];
for (const u of uniform) test(`${u.kind}: p = 0 / .25 / .5 / .75 / .999 give the §55.5 colour over the whole frame (±${u.tol === ALPHA_TOL ? '0.06 alpha' : u.tol === DISSOLVE_TOL ? '3 LSB, D32 Q11' : '1 LSB'})`, async () => {
  const doc = docWith(u.rec);
  for (const p of PS) {
    const f = await frame(doc, atP(p)), want = u.want(p);
    expect(f.failed).toBe(0); expect(f.pending, `p=${p} pending`).toEqual([]);
    expect(f.draws.map(d => [d.id, d.transition?.role]), `p=${p}: both draws are tagged`).toEqual([['A', 'from'], ['B', 'to']]);
    for (const [x, y] of [[0, 0], [W - 1, 0], [W >> 1, H >> 1], [0, H - 1], [W - 1, H - 1]]) near(f.px(x, y), want, u.tol, `${u.kind} p=${p} at (${x},${y})`);
  }
});

test('fade at p = .5 is exactly black (the cut of the dip) and dip colour at p = .5 is the full colour', async () => {
  near((await frame(docWith({ kind: 'fade' }), atP(0.5))).px(10, 10), BLACK, ALPHA_TOL, 'fade p=.5');
  near((await frame(docWith({ kind: 'dipToColorDissolve', params: { color: [0.2, 0.4, 0.6] } }), atP(0.5))).px(10, 10), [51, 102, 153], LSB, 'dip p=.5');
});

test('outside the window there is no pair: a frame just before it is A alone, just after it B alone, for every kind', async () => {
  for (const kind of ['fade', 'dissolve', 'additiveDissolve', 'dipToColorDissolve', 'slide', 'wipe']) {
    const doc = docWith({ kind, ...kind === 'slide' || kind === 'wipe' ? { direction: 'from-left' } : {} });
    const before = await frame(doc, T0 - 1), after = await frame(doc, T0 + 1000);   // 1499 and 2500 (half-open window)
    expect(before.draws, kind).toEqual([{ id: 'A', transition: null }]); expect(after.draws, kind).toEqual([{ id: 'B', transition: null }]);
    near(before.px(5, 5), RED, LSB, `${kind} before`); near(before.px(W - 1, H - 1), RED, LSB, `${kind} before`);
    near(after.px(5, 5), BLUE, LSB, `${kind} after`); near(after.px(W - 1, H - 1), BLUE, LSB, `${kind} after`);
  }
});

// General colours (not only pure red / blue). DISSOLVE_TOL is accepted by D32 Q11; the pairs are the worst ones of the 565-pair sweep (see the top of this file).
test('general colours: dissolve and additive dissolve stay within DISSOLVE_TOL (3 LSB, D32 Q11) of the §55.5 mix over the whole frame', async () => {
  const dissolveW = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * p);
  const cases: { kind: string; a: RGB; b: RGB; p: number; w: (p: number) => number }[] = [
    { kind: 'dissolve', a: [17, 99, 250], b: [240, 128, 3], p: 0.3, w: dissolveW },
    { kind: 'additiveDissolve', a: [17, 99, 250], b: [240, 128, 3], p: 0.3, w: p => p },
    { kind: 'additiveDissolve', a: [47, 105, 247], b: [74, 118, 9], p: 0.9, w: p => p },
  ];
  for (const c of cases) {
    const f = await frame(docWith({ kind: c.kind }), atP(c.p), 'black', { A: c.a, B: c.b }), want = mix(c.a, c.b, c.w(c.p));
    expect(f.failed).toBe(0);
    for (const [x, y] of [[0, 0], [W - 1, 0], [W >> 1, H >> 1], [0, H - 1], [W - 1, H - 1]]) near(f.px(x, y), want, DISSOLVE_TOL, `${c.kind} A ${c.a} → B ${c.b} p=${c.p} at (${x},${y})`);
  }
});

test('the tag on each draw: id, role, kind, p at linear progress, direction and params as stored', async () => {
  const doc = docWith({ kind: 'wipe', direction: 'from-top', params: { softness: 30 } });
  const f = await page.evaluate(a => (window as any).__plan(a), { doc, tMs: atP(0.25) }) as { draws: { id: string; transition: any }[] };
  expect(f.draws).toHaveLength(2);
  expect(f.draws[0]).toMatchObject({ id: 'A', transition: { id: ID, role: 'from', kind: 'wipe', direction: 'from-top', params: { softness: 30 } } });
  expect(f.draws[1]).toMatchObject({ id: 'B', transition: { id: ID, role: 'to', kind: 'wipe', direction: 'from-top', params: { softness: 30 } } });
  expect(f.draws[0].transition.p).toBeCloseTo(0.25, 9); expect(f.draws[1].transition.p).toBeCloseTo(0.25, 9);
});

// ---- slide ----------------------------------------------------------------------------------------------------------
const cubic = (x: number) => x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
const DIRS: Record<string, [number, number]> = { 'from-left': [1, 0], 'from-right': [-1, 0], 'from-top': [0, 1], 'from-bottom': [0, -1] };
const roundHalfUp = (v: number) => Math.floor(v + 0.5);
test('slide, all four directions at p = .25 / .5 / .75: A moves away from the named side, B enters from it, every pixel (whole-px offsets, ±1 LSB)', async () => {
  for (const [dir, [dx, dy]] of Object.entries(DIRS)) {
    const doc = docWith({ kind: 'slide', direction: dir });
    for (const p of [0.25, 0.5, 0.75]) {
      const e = cubic(p), ax = roundHalfUp(e * dx * W), ay = roundHalfUp(e * dy * H), bx = roundHalfUp((e - 1) * dx * W), by = roundHalfUp((e - 1) * dy * H);
      const f = await frame(doc, atP(p));
      let bad = 0, first = '';
      f.all().forEach((got, i) => {
        const x = i % W, y = Math.floor(i / W), inA = x - ax >= 0 && x - ax < W && y - ay >= 0 && y - ay < H, inB = x - bx >= 0 && x - bx < W && y - by >= 0 && y - by < H;
        const want = inA ? RED : inB ? BLUE : BLACK;
        if ([0, 1, 2].some(k => Math.abs(got[k] - want[k]) > LSB) || got[3] !== 255) { bad++; first ||= `(${x},${y}) got ${got} want ${want}`; }
      });
      expect(bad, `slide ${dir} p=${p} (A offset ${ax},${ay}; B ${bx},${by}): first bad ${first}`).toBe(0);
    }
  }
  // The §55.5 numbers on this canvas: from-left at p = .5 → left half B, right half A.
  const f = await frame(docWith({ kind: 'slide', direction: 'from-left' }), atP(0.5));
  near(f.px(31, 10), BLUE, LSB, 'x=31'); near(f.px(32, 10), RED, LSB, 'x=32');
});

test('slide with no stored direction (a stored record without one) enters from the left', async () => {
  const f = await frame(docWith({ kind: 'slide' }), atP(0.5));
  near(f.px(0, 0), BLUE, LSB, 'left half'); near(f.px(W - 1, 0), RED, LSB, 'right half');
});

// ---- wipe -----------------------------------------------------------------------------------------------------------
/** Position of pixel (x, y) from the entry side as a fraction of the axis, at its centre. */
const uOf = (dir: string, x: number, y: number) => dir === 'from-left' ? (x + 0.5) / W : dir === 'from-right' ? 1 - (x + 0.5) / W : dir === 'from-top' ? (y + 0.5) / H : 1 - (y + 0.5) / H;
const maskOf = (u: number, p: number, s: number) => { const f = p * (1 + s), g = f - s; return u <= g ? 1 : u >= Math.min(f, 1) && f <= 1 ? 0 : f > 1 ? (u >= 1 ? 0 : (1 - u) / (1 - g)) : (f - u) / s; };

test('wipe with softness 0: a hard edge of ⌊p·L + 0.5⌋ px of B from the entry side, all four directions at p = .25 / .5 / .75', async () => {
  for (const dir of Object.keys(DIRS)) {
    const doc = docWith({ kind: 'wipe', direction: dir });
    for (const p of [0.25, 0.5, 0.75]) {
      const L = dir === 'from-left' || dir === 'from-right' ? W : H, n = Math.floor(p * L + 0.5), f = await frame(doc, atP(p));
      let bad = 0, first = '';
      f.all().forEach((got, i) => {
        const x = i % W, y = Math.floor(i / W), pos = dir === 'from-left' ? x : dir === 'from-right' ? W - 1 - x : dir === 'from-top' ? y : H - 1 - y;
        const want = pos < n ? BLUE : RED;
        if ([0, 1, 2].some(k => Math.abs(got[k] - want[k]) > LSB) || got[3] !== 255) { bad++; first ||= `(${x},${y}) got ${got} want ${want}`; }
      });
      expect(bad, `wipe ${dir} p=${p} (edge at ${n} px): first bad ${first}`).toBe(0);
    }
  }
});

test('wipe softness 20 %: the feathered edge follows the §55.5 mask in all four directions (p = .25 and .5), and p = 0 shows A alone', async () => {
  for (const dir of Object.keys(DIRS)) {
    const doc = docWith({ kind: 'wipe', direction: dir, params: { softness: 20 } });
    for (const p of [0.25, 0.5]) {
      const f = await frame(doc, atP(p));
      let worst = 0, where = '';
      f.all().forEach((got, i) => {
        const x = i % W, y = Math.floor(i / W), m = maskOf(uOf(dir, x, y), p, 0.2), want = mix(RED, BLUE, m);
        const err = Math.max(...[0, 1, 2].map(k => Math.abs(got[k] - want[k])));
        if (err > worst) { worst = err; where = `(${x},${y}) m=${m.toFixed(3)} got ${got} want ${want.map(v => +v.toFixed(1))}`; }
      });
      // ±1 holds only for these red / blue colours. On general colours the feathered edge measures up to 1.76 (s .2, from-left, A (14,179,223) → B (223,161,124), p .3)
      // and up to 1.80 (s .5, from-bottom, A (37,226,230) → B (197,228,14), p .95): T11 notes Q11 (own tolerance, provisional).
      expect(worst, `wipe ${dir} s=.2 p=${p}: worst ${where}`).toBeLessThanOrEqual(LSB);
    }
    near((await frame(doc, atP(0))).px(3, 3), RED, LSB, `wipe ${dir} p=0 s=.2`);
  }
});

test('wipe quirk A (front past the far edge, p = .9, s = .2): the feather ends at the edge, mask (1 − u) / (1 − g)', async () => {
  const dir = 'from-left', f = await frame(docWith({ kind: 'wipe', direction: dir, params: { softness: 20 } }), atP(0.9));
  let worst = 0, where = '';
  f.all().forEach((got, i) => {
    const x = i % W, y = Math.floor(i / W), u = uOf(dir, x, y), g = 0.9 * 1.2 - 0.2, m = u <= g ? 1 : (1 - u) / (1 - g), want = mix(RED, BLUE, m);
    const err = Math.max(...[0, 1, 2].map(k => Math.abs(got[k] - want[k]))); if (err > worst) { worst = err; where = `(${x},${y}) m=${m.toFixed(3)} got ${got}`; }
  });
  expect(worst, `worst ${where}`).toBeLessThanOrEqual(LSB);
});

test('wipe quirk B (p = 0, s = 0): the first frame is the ramp 1 − u from the entry side, not "all A" — from-left and from-right, every pixel', async () => {
  for (const dir of ['from-left', 'from-right']) {
    const f = await frame(docWith({ kind: 'wipe', direction: dir }), atP(0));
    let worst = 0, where = '';
    f.all().forEach((got, i) => {
      const x = i % W, y = Math.floor(i / W), m = 1 - uOf(dir, x, y), want = mix(RED, BLUE, m);       // m·B + (1 − m)·A, u from the entry side
      const err = Math.max(...[0, 1, 2].map(k => Math.abs(got[k] - want[k]))); if (err > worst) { worst = err; where = `(${x},${y}) m=${m.toFixed(3)} got ${got} want ${want.map(v => +v.toFixed(1))}`; }
    });
    expect(worst, `wipe ${dir} p=0 s=0: worst ${where}`).toBeLessThanOrEqual(LSB);
  }
});

test('wipe softness is clamped to 0–100 %: 250 behaves as 100, −5 as a hard edge', async () => {
  const hard = await frame(docWith({ kind: 'wipe', direction: 'from-left', params: { softness: -5 } }), atP(0.5));
  near(hard.px(31, 3), BLUE, LSB, 'x=31 hard'); near(hard.px(32, 3), RED, LSB, 'x=32 hard');
  const full = await frame(docWith({ kind: 'wipe', direction: 'from-left', params: { softness: 250 } }), atP(0.5));
  const ref = await frame(docWith({ kind: 'wipe', direction: 'from-left', params: { softness: 100 } }), atP(0.5));
  expect(full.all()).toEqual(ref.all());
});

// ---- unknown kind, backdrop, pool -------------------------------------------------------------------------------------------
test('own rule: an unknown stored kind hard-cuts (A alone, then B alone) and is listed once as pending {T11, "Transition kind \'zoom\'"}', async () => {
  const doc = docWith({ kind: 'zoom' });
  const early = await frame(doc, atP(0.25)), late = await frame(doc, atP(0.75));
  const pending = [{ itemId: ID, owner: 'T11', what: "Transition kind 'zoom'" }];
  expect(early.pending).toStrictEqual(pending); expect(late.pending).toStrictEqual(pending);
  expect(early.draws).toEqual([{ id: 'A', transition: null }]); expect(late.draws).toEqual([{ id: 'B', transition: null }]);
  near(early.px(20, 20), RED, LSB, 'before the cut'); near(late.px(20, 20), BLUE, LSB, 'after the cut');
  expect((await frame(docWith(null), atP(0.25))).pending).toEqual([]);
});

test('on a clear backdrop the pair is still one draw: dissolve at p = .5 is opaque purple (A under B)', async () => {
  const f = await frame(docWith({ kind: 'dissolve' }), atP(0.5), 'clear');
  near(f.px(10, 10), [127.5, 0, 127.5], DISSOLVE_TOL, 'dissolve .5 on clear');
});

// §55.4 (P5 l.1078 "normal source-over at the pair's place in the layer order, over all lower tracks", l.1079 "a clip's own blend mode is neutralised during the window",
// l.1086 fade "also hides lower tracks"). A solid image L (60,200,60) on V0 under the pair on V1; A and B scaled to 0.5 and placed at (16, 9) (centred: a corner is covered by neither);
// A has blendMode 'multiply'. Pixels: corner (0,0) uncovered, centre (32,18) covered by A / B.
test('lower tracks and blend (§55.4): dissolve shows the lower track at an uncovered corner, fade hides it (black); A is unblended inside the window and multiplied outside it', async () => {
  const img = (id: string, trackId: string, from: number, to: number, details: Record<string, unknown> = {}) => mkItem(id, trackId, from, to, { type: 'image', metadata: { assetId: `asset-${id}` }, details });
  const half = { positionX: 16, positionY: 9, width: W, height: H, scale: 0.5 };      // §53.2.2: the box's top-left is (x, y); scaled 0.5 it is centred, covering 16–48 × 9–27
  const lowerDoc = (kind: string) => JSON.parse(JSON.stringify(build({
    tracks: [mkTrack('V0', 'video'), mkTrack('V1', 'video')],
    items: [img('L', 'V0', 0, 4000), img('A', 'V1', 0, 2000, { ...half, blendMode: 'multiply' }), img('B', 'V1', 2000, 4000, half)],
    extra: { size: { width: W, height: H }, fps: FPS, transitions: [{ id: ID, trackId: 'V1', fromId: 'A', toId: 'B', kind, durationMs: 1000, alignment: 0.5 }] },
  })));
  const GREEN: RGB = [60, 200, 60], colors = { L: GREEN }, centre: [number, number] = [W >> 1, H >> 1];
  const dissolve = lowerDoc('dissolve');
  near((await frame(dissolve, atP(0.5), 'black', colors)).px(0, 0), GREEN, LSB, 'dissolve p=.5, corner: the lower track');
  near((await frame(lowerDoc('fade'), atP(0.25), 'black', colors)).px(0, 0), BLACK, LSB, 'fade p=.25, corner: lower tracks hidden');
  near((await frame(dissolve, atP(0), 'black', colors)).px(...centre), RED, DISSOLVE_TOL, 'dissolve p=0, centre: A unblended (not multiplied)');
  const outside = await frame(dissolve, 1000, 'black', colors);
  near(outside.px(...centre), [60, 0, 0], LSB, 't=1000 (outside the window), centre: A multiplied with the lower track = A·L/255');
  near(outside.px(0, 0), GREEN, LSB, 't=1000, corner: the lower track');
});

test('the surface pool is lazy: a frame without a transition constructs no OffscreenCanvas; the first pair constructs three (A, B, result), the next pair of that size none', async ({ browser }) => {
  const p = await browser.newPage(); await p.addInitScript('window.__name = (f) => f'); await p.goto('/');
  try {
    const counts = await p.evaluate(async ({ w, h, plain, paired }) => {
      const m = '/src/render/model.ts', c = '/src/render/compositor.ts';
      const { framePlan } = await import(m), { composite } = await import(c);
      const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) d.set([255, 0, 0, 255], i);
      const bmp = await createImageBitmap(new ImageData(d, w, h)), ctx = new OffscreenCanvas(w, h).getContext('2d')!;
      const Original = OffscreenCanvas; let made = 0;
      (window as any).OffscreenCanvas = class extends Original { constructor(a: number, b: number) { super(a, b); made++; } };
      const run = (doc: unknown, t: number) => { made = 0; const pl = framePlan(doc as never, t); composite(ctx, pl.draws, pl.draws.map(() => ({ image: bmp, width: w, height: h })) as never, { width: w, height: h }, 'black'); return made; };
      const out = { plain: run(plain, 1750), first: run(paired, 1750), second: run(paired, 1800) };
      (window as any).OffscreenCanvas = Original;
      return out;
    }, { w: W, h: H, plain: docWith(null), paired: docWith({ kind: 'dissolve' }) });
    expect(counts).toEqual({ plain: 0, first: 3, second: 0 });
  } finally { await p.close(); }
});
