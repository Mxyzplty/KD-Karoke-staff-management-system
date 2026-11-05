// SPDX-License-Identifier: AGPL-3.0-only
// Formula oracle, findings part 4 §50: every "Test values" block, computed by parity/oracle/stylize.ts.
import { describe, it, expect } from 'vitest';
import { createImage, texel, type Image } from '../parity/oracle/image';
import type { RGBA } from '../parity/oracle/math';
import { effects, kernels, halftoneSetup } from '../parity/oracle/stylize';

// Tolerance: half a unit of the last printed digit (dp); values the steps give exactly are checked to 1e-6 (EXACT).
const dp = (digits: number) => .5 * 10 ** -digits, EXACT = 1e-6, ctx0 = { timeS: 0 };
const near = (actual: number, expected: number, tol: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol + 1e-12);
const nearRGB = (actual: RGBA, expected: number[], tol: number) => expected.forEach((v, q) => near(actual[q], v, tol));
const flat = (w: number, h: number, c: RGBA) => createImage(w, h, c);
function image(w: number, h: number, f: (column: number, rowFromBottom: number) => RGBA): Image {
  const out = createImage(w, h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out.data.set(f(c, r), ((h - 1 - r) * w + c) * 4);
  return out;
}
// One evaluation at a stated normalised position (the block's coordinates are often not pixel centres).
const at = (id: string, src: Image, p: object, x: number, y: number, timeS = 0) => kernels[id](src, p, { timeS })(x, y);
const hex = (s: string) => [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255);

describe('§50 stylize effects (formula oracle)', () => {
  it('§50.1 vignette test values', () => {
    const white = flat(8, 8, [1, 1, 1, 1]);
    for (const [x, y, k, tol] of [[.5, .5, 1, EXACT], [.75, .5, 1, EXACT], [.875, .5, .75, EXACT], [1, .5, .5, EXACT], [0, 0, .5, EXACT], [.8, .8, .7885, dp(4)]]) {
      const out = at('vignette', white, {}, x, y);
      nearRGB(out, [k, k, k, 1], tol);
    }
  });

  it('§50.2 sharpen test values', () => {
    const step = image(16, 4, c => c < 8 ? [.2, .2, .2, 1] : [.8, .8, .8, 1]), run = (p: object) => effects.sharpen(step, p, ctx0);
    const soft = run({ amount: 50, radius: 1 }), hard = run({ amount: 300, radius: 1 });
    for (let r = 0; r < 4; r++) {
      nearRGB(texel(soft, 7, r), [.1099, .1099, .1099, 1], dp(4)); nearRGB(texel(soft, 8, r), [.8901, .8901, .8901, 1], dp(4));
      for (const c of [0, 1, 2]) nearRGB(texel(soft, c, r), [.2, .2, .2, 1], EXACT);
      for (const c of [13, 14, 15]) nearRGB(texel(soft, c, r), [.8, .8, .8, 1], EXACT);
      nearRGB(texel(hard, 7, r), [0, 0, 0, 1], EXACT); nearRGB(texel(hard, 8, r), [1, 1, 1, 1], EXACT);
    }
    const plain = flat(9, 7, [.3, .5, .7, .6]), same = effects.sharpen(plain, { amount: 300, radius: 2.5 }, ctx0);
    plain.data.forEach((v, i) => near(same.data[i], v, EXACT));
  });

  it('§50.3 glow test values', () => {
    const out = (v: number, p: object = {}) => texel(effects.glow(flat(8, 8, [v, v, v, 1]), p, ctx0), 3, 4);
    nearRGB(out(.5), [.5, .5, .5, 1], EXACT);
    nearRGB(out(.65), [.8531, .8531, .8531, 1], dp(4));
    nearRGB(out(.65, { intensity: 10 }), [.6906, .6906, .6906, 1], dp(4));
    nearRGB(out(.7), [1, 1, 1, 1], EXACT);
    nearRGB(out(.65, { rings: 32, samplesPerRing: 64, radius: 50, softness: 10 }), [.8531, .8531, .8531, 1], dp(4)); // uniform: no dependence on the ring set-up
  });

  it('§50.4 glitch test values', () => {
    // Intensity 0: only the split remains (red at x0 − 5, green at x0, blue at x0 + 5).
    const x0 = 15, line = image(32, 6, c => c === x0 ? [1, 1, 1, 1] : [0, 0, 0, 1]);
    const split = effects.glitch(line, { intensity: 0, rgbSplit: 5 }, { timeS: 0, seed: 731.25 });
    for (let r = 0; r < 6; r++) for (let c = 0; c < 32; c++) nearRGB(texel(split, c, r), [+(c === x0 - 5), +(c === x0), +(c === x0 + 5), 1], EXACT);
    // Fixed seed: every pixel of a band (H/rows = 4 px here) gets the same band shift; rows may add only the thin-row nudge 0.015·I.
    const W = 200, H = 80, ramp = image(W, H, c => { const v = (c + .5) / W; return [v, v, v, 1]; });
    const out = effects.glitch(ramp, { intensity: 100, blockSize: 100, rgbSplit: 0 }, { timeS: 0, seed: 417.3 });
    const rowShift = (r: number) => { const d = [50, 75, 100, 125, 150].map(c => texel(out, c, r)[1] - (c + .5) / W); d.forEach(v => near(v, d[0], EXACT)); return d[0]; };
    const bands = new Set<number>();
    for (let band = 0; band < 20; band++) {
      const d = [0, 1, 2, 3].map(k => rowShift(band * 4 + k)), lo = Math.min(...d);
      d.forEach(v => expect(Math.abs(v - lo) < 1e-5 || Math.abs(v - lo - .015) < 1e-5, `band ${band}: ${d}`).toBe(true));
      bands.add(Math.round(lo * 1e5));
    }
    expect(bands.size).toBeGreaterThan(2); // the shift really varies between bands
  });

  it('§50.4 glitch with a fixed seed matches an independent run of the written steps', () => {
    // Ramp source: src(x).rgb = clamp(x, 0.5/W, 1 − 0.5/W) (bilinear, clamp-to-edge), alpha 0.5 + 0.5·that, so every
    // channel reads back the position it was sampled at. Intensity 100, blockSize 100 → 20 bands of 4 rows; split 3 px.
    const W = 200, H = 80, seed = 417.3, I = 1, rows = 20, sp = 3 / W;
    const ramp = image(W, H, c => { const v = (c + .5) / W; return [v, v, v, .5 + .5 * v]; });
    const out = effects.glitch(ramp, { intensity: 100, blockSize: 100, rgbSplit: 3 }, { timeS: 0, seed });
    const H1 = (n: number) => { const s = 43758.5453 * Math.sin(n); return s - Math.floor(s); }, src = (x: number) => Math.min(Math.max(x, .5 / W), 1 - .5 / W);
    let moved = 0;
    for (let r = 0; r < H; r++) {
      const y = (r + .5) / H, band = Math.floor(y * rows), k = Math.floor(y * H), shifted = H1(band + 137 * seed) >= 1 - .5 * I;
      if (shifted && r % 4 === 0) moved++;
      for (let c = 0; c < W; c++) {
        let x = (c + .5) / W;
        if (shifted) x += (2 * H1(band + 53 * seed) - 1) * .1 * I;
        if (H1(k + 7 * seed) >= 1 - .15 * I) x += .015 * I;
        nearRGB(texel(out, c, r), [src(x + sp), src(x), src(x - sp), .5 + .5 * src(x)], 1e-6);
      }
    }
    expect(moved).toBeGreaterThan(0); expect(moved).toBeLessThan(rows); // this seed has both moved and still bands
  });

  it('§50.5 vhs test values', () => {
    const context = { timeS: 0, seed: 512.5 };
    const gray = effects.vhs(flat(4, 4, [.5, .5, .5, 1]), { noise: 0, distortion: 0 }, context);
    const red = effects.vhs(flat(4, 4, [1, 0, 0, 1]), { colorBleed: 50, scanlines: 40, noise: 0, distortion: 0 }, context);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const even = r % 2 === 0; // rows counted from the y origin (bottom)
      nearRGB(texel(gray, c, r), even ? [.44, .44, .44, 1] : [.5, .5, .5, 1], EXACT);
      nearRGB(texel(red, c, r), even ? [.7761, .0281, .0281, 1] : [.8819, .0319, .0319, 1], dp(4));
    }
  });

  it('§50.5 vhs with noise and distortion (wobble, HW noise) matches an independent run of the written steps', () => {
    // Ramp source as in the glitch check: every channel reads back its sample x, alpha 0.5 + 0.5·x.
    const W = 64, H = 8, seed = 271.8, Ls = .4, cb = .5, N = 1, D = 1;
    const ramp = image(W, H, c => { const v = (c + .5) / W; return [v, v, v, .5 + .5 * v]; });
    const out = effects.vhs(ramp, { scanlines: 40, colorBleed: 50, noise: 100, distortion: 100 }, { timeS: 0, seed });
    const fr = (v: number) => v - Math.floor(v), src = (x: number) => Math.min(Math.max(x, .5 / W), 1 - .5 / W), clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    // HW per §48.2: q = frac(p.xyx·0.1031); q += dot(q, q.yzx + 33.33); frac((q.x + q.y)·q.z).
    const HW = (px: number, py: number) => { const q = [fr(px * .1031), fr(py * .1031), fr(px * .1031)], d = q[0] * (q[1] + 33.33) + q[1] * (q[2] + 33.33) + q[2] * (q[0] + 33.33); return fr((q[0] + d + q[1] + d) * (q[2] + d)); };
    const noise: number[] = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const x = (c + .5) / W, y = (r + .5) / H, xw = x + Math.sin(50 * y + 10 * seed) * D * .005;
      const s = .5 + .5 * Math.sin(Math.PI * y * H), n = 2 * HW(xw * W + seed, y * H + seed) - 1;
      const rgb = [src(xw + 3 * cb / W), src(xw), src(xw - 1.5 * cb / W)].map(v => v * (1 - .3 * Ls * s) + n * .15 * N);
      const l = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      nearRGB(texel(out, c, r), [...rgb.map(v => clamp01(v + (l - v) * .3 * cb)), .5 + .5 * src(x)], 1e-6);
      noise.push(n);
    }
    expect(Math.max(...noise) - Math.min(...noise)).toBeGreaterThan(1); // the noise term really varies across the image
  });

  it('§50.6 pixelate test values', () => {
    const src = image(16, 16, (c, r) => [c / 16, r / 16, (16 * c + r) / 256, .5 + c / 64]);
    const mid = [0, 1, 2, 3].map(q => (texel(src, 3, 3)[q] + texel(src, 4, 3)[q] + texel(src, 3, 4)[q] + texel(src, 4, 4)[q]) / 4);
    const b8 = effects.pixelate(src, { blockSize: 8 }, ctx0), b5 = effects.pixelate(src, { blockSize: 5 }, ctx0);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) nearRGB(texel(b8, c, r), mid, EXACT);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) nearRGB(texel(b5, c, r), texel(src, 2, 2), EXACT);
  });

  it('§50.7 ascii test values', () => {
    // Mono, white on black, contrast 100, default cell 12 px on a 24 × 24 item; probes in cell (0, 0) at local (u, v).
    const C = 12, W = 24, src = (v: number) => flat(W, W, [v, v, v, 1]);
    const probe = (v: number, p: object, u: number, w: number) => at('ascii', src(v), p, u * C / W, w * C / W);
    const ink = (v: number, p: object, a: number, b: number) => probe(v, p, .5 + a, .5 + b)[0];
    effects.ascii(src(0), {}, ctx0).data.forEach((v, i) => near(v, i % 4 === 3 ? 1 : 0, EXACT));
    nearRGB(probe(1, {}, .5, .5), [.5, .5, .5, 1], EXACT);
    nearRGB(probe(1, {}, .5, .75), [1, 1, 1, 1], EXACT);
    nearRGB(probe(1, {}, .05, .05), [0, 0, 0, 1], EXACT);
    // Gray 0.45 → level 4 (plus): this ink pattern excludes every other level.
    for (const [a, b, k] of [[0, 0, 1], [.3, 0, 1], [0, .3, 1], [.3, .3, 0], [.45, 0, 0]]) near(ink(.45, {}, a, b), k, EXACT);
    // Blocks ramp, gray 0.45 → level 2: inks v ≥ 0.5.
    for (const [v, k] of [[.1, 0], [.4, 0], [.6, 1], [.9, 1]]) near(probe(.45, { ramp: 'blocks' }, .5, v)[0], k, EXACT);
    // Gray 0.62 at contrast 300 → level 8 ("percent"): band a + b ≈ 0 plus blobs at (−0.2, 0.22) and (0.2, −0.22).
    for (const [a, b, k] of [[0, 0, 1], [-.1, .27, 1], [.1, -.27, 1], [.15, .4, 0], [.3, .3, 0]]) near(ink(.62, { contrast: 300 }, a, b), k, EXACT);
  });

  it('§50.8 edge-detection test values', () => {
    const run = (src: Image) => effects['edge-detection'](src, {}, ctx0);
    run(flat(8, 8, [.3, .6, .9, .7])).data.forEach((v, i) => near(v, i % 4 === 3 ? .7 : 0, EXACT));
    for (const [v, e, tol] of [[1, 1, EXACT], [.02, 0, EXACT], [.03, .352, dp(3)], [.0375, 1, EXACT], [.2, 1, EXACT]]) {
      const out = run(image(8, 8, c => c < 4 ? [0, 0, 0, 1] : [v, v, v, 1]));
      for (let r = 0; r < 8; r++) for (const c of [3, 4]) nearRGB(texel(out, c, r), [e, e, e, 1], tol);
    }
  });

  it('§50.9 scanlines test values', () => {
    const white = flat(8, 8, [1, 1, 1, 1]), p = { density: 5, opacity: 30 };
    for (const [y, k, tol] of [[0, .85, dp(2)], [.0031416, 1, dp(1)], [.0094248, .7, dp(2)]]) nearRGB(at('scanlines', white, p, .5, y), [k, k, k, 1], tol);
    for (const y of [0, .1, .37, .5, .93]) near(at('scanlines', white, { ...p, speed: 100 }, .5, y, 1)[0], at('scanlines', white, p, .5, y + .5)[0], EXACT);
  });

  it('§50.10 film-grain test values (statistical)', () => {
    const varied = image(32, 32, (c, r) => [c / 31, r / 31, (c + r) / 62, .8]), grain = effects['film-grain'];
    expect(grain(varied, { amount: 0 }, { timeS: 3.7 }).data).toEqual(varied.data);
    expect(grain(varied, { speed: 0 }, { timeS: 0 }).data).toEqual(grain(varied, { speed: 0 }, { timeS: 5 }).data);
    // amount 30 on 128 × 128 uniform images, pooled over 8 frames at 30 fps (one frame alone can sit ~3.6 σ off):
    // mean within 0.005, range inside the stated bounds and spanned to 0.01.
    for (const [v, mean, lo, hi] of [[0, .075, 0, .3], [1, .9625, .85, 1], [.5, .5, .275, .725]]) {
      const src = flat(128, 128, [v, v, v, 1]), r: number[] = [];
      for (let f = 0; f < 8; f++) grain(src, { amount: 30 }, { timeS: f / 30 }).data.forEach((x, i) => { if (i % 4 === 0) r.push(x); });
      const m = r.reduce((s, x) => s + x, 0) / r.length, min = r.reduce((a, x) => Math.min(a, x)), max = r.reduce((a, x) => Math.max(a, x));
      near(m, mean, .005);
      expect(min).toBeGreaterThanOrEqual(lo - EXACT); expect(max).toBeLessThanOrEqual(hi + EXACT);
      expect(min).toBeLessThanOrEqual(lo + .01); expect(max).toBeGreaterThanOrEqual(hi - .01);
    }
  });

  it('§50.11 dither test values', () => {
    // Uniform gray 0.5 on 16 × 16 (four 8 px cells); τ and q are internal, checked through the palette colour they select.
    const gray = flat(16, 16, [.5, .5, .5, 1]), code = dp(0) / 255;
    const cell = (out: Image, i: number, j: number, rgb: number[]) => { for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) nearRGB(texel(out, 8 * i + c, 8 * j + r), [...rgb, 1], code); };
    const base = effects.dither(gray, {}, ctx0);
    cell(base, 0, 0, hex('306230')); cell(base, 1, 0, hex('8bac0f')); cell(base, 1, 1, hex('306230'));
    const bw = effects.dither(gray, { pattern: 'bayer2', palette: 'bw' }, ctx0);
    cell(bw, 0, 0, [0, 0, 0]); cell(bw, 1, 0, [1, 1, 1]); cell(bw, 0, 1, [1, 1, 1]); cell(bw, 1, 1, [0, 0, 0]);
    const hole = image(16, 16, (c, r) => c === 5 && r === 9 ? [.5, .5, .5, 0] : [.5, .5, .5, 1]);
    expect(Array.from(texel(effects.dither(hole, {}, ctx0), 5, 9))).toEqual([0, 0, 0, 0]);
  });

  it('§50.12 halftone test values', () => {
    const grid = (W: number, H: number, p: object) => { const g = halftoneSetup(W, H, p); return [g.cols, g.rows]; };
    expect(grid(1920, 1080, { type: 'classic' })).toEqual([107, 61]);
    expect(grid(1920, 1080, { type: 'gooey', grid: 'hex' })).toEqual([51, 29]);
    expect(grid(1920, 1080, { type: 'gooey', grid: 'square' })).toEqual([35, 21]);
    expect(grid(1920, 1080, { type: 'holes' })).toEqual([213, 121]);
    expect(grid(1920, 1080, { type: 'soft' })).toEqual([35, 21]);
    expect(grid(1080, 1920, { type: 'classic' })).toEqual([35, 61]);
    for (const [size, cr] of [[0, [267, 151]], [50, [107, 61]], [100, [7, 5]]] as const) expect(grid(1920, 1080, { type: 'classic', size })).toEqual(cr);
    near(halftoneSetup(16, 16, {}).kappa, 3.7947, dp(4));
    // Classic, square grid, no grain, radius 125: probe the rendered ink at the printed radius from the dot at the item centre,
    // invert the smooth edge to get the true radius rr, then ℓ = 1 − rr / (0.25·b). Black is probed diagonally (its dots overlap along x).
    const p = { type: 'classic', grid: 'square', grainMixer: 0, grainOverlay: 0 }, g = halftoneSetup(16, 16, p), front = hex('2b2b2b'), back = hex('f2f1e8');
    const invS = (s: number) => .5 - Math.sin(Math.asin(1 - 2 * s) / 3);
    for (const [v, rr, l, diagonal] of [[0, .272, .1304, true], [.5, .156, .5, false], [1, .041, .8696, false]] as const) {
      const dx = diagonal ? rr * Math.SQRT1_2 : rr, dy = diagonal ? rr * Math.SQRT1_2 : 0;
      const out = at('halftone', flat(16, 16, [v, v, v, 1]), p, .5 + dx * g.w, .5 + dy * g.h), F = (out[0] - back[0]) / (front[0] - back[0]);
      const measured = rr + .02 - .04 * invS(1 - F);
      near(measured, rr, dp(3)); near(1 - measured / (.25 * g.b), l, dp(4));
    }
    // Paper pixel: no dot cover, grain 0.
    const paper = at('halftone', flat(16, 16, [.5, .5, .5, 1]), p, .5 + .25 * g.w, .5 + .25 * g.h);
    near(paper[0], .949, dp(3)); near(paper[1], .9451, dp(4)); near(paper[2], .9098, dp(4)); near(paper[3], 1, EXACT);
    const render = (v: number, q: object) => effects.halftone(flat(16, 16, [v, v, v, 1]), q, ctx0).data;
    // Contrast 0: ℓ = 0.5 everywhere, so the output no longer depends on the image colour.
    expect(render(0, { contrast: 0 })).toEqual(render(1, { contrast: 0 }));
    // grainMixer 0 and grainOverlay 0: no noise is used (grainSize has no effect), deterministic; with grain on it does matter.
    const still = { grainMixer: 0, grainOverlay: 0 };
    expect(render(.3, { ...still, grainSize: 0 })).toEqual(render(.3, { ...still, grainSize: 100 }));
    expect(render(.3, { grainSize: 0 })).not.toEqual(render(.3, { grainSize: 100 }));
  });

  it('§50.12 halftone with grain 0 is the noise-free two-tone result (independent derivation)', () => {
    // Classic, square, gray 0.3, 16 × 16, defaults otherwise: size 50 → n0 = lerp(300, 7, 0.5^0.7), 1/h = n0/2 = 59.8 → 60 →
    // odd 61 cells per axis; κ = 15·0.4^1.5; ℓ = sigmoid(κ·(0.3 − 0.5)); rr = 0.25·1.25·(1 − ℓ);
    // F = min(1, Σ over the 4 sub-lattices of 1 − S(rr − 0.02, rr + 0.02, d)); out = front·F + back·(1 − F), A = 1.
    const front = hex('2b2b2b'), back = hex('f2f1e8');
    const S = (a: number, b: number, v: number) => { const t = Math.min(Math.max((v - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
    const lum = 1 / (1 + Math.exp(-15 * .4 ** 1.5 * (.3 - .5))), radius = .25 * 1.25 * (1 - lum);
    const out = effects.halftone(flat(16, 16, [.3, .3, .3, 1]), { type: 'classic', grid: 'square', grainMixer: 0, grainOverlay: 0 }, ctx0), cover: number[] = [];
    for (let row = 0; row < 16; row++) for (let column = 0; column < 16; column++) {
      const P = [((column + .5) / 16 - .5) * 61, ((row + .5) / 16 - .5) * 61]; let F = 0;
      for (const [ox, oy] of [[-.5, -.5], [0, -.5], [-.5, 0], [0, 0]]) { const fx = P[0] + ox - Math.floor(P[0] + ox), fy = P[1] + oy - Math.floor(P[1] + oy); F += 1 - S(radius - .02, radius + .02, Math.hypot(fx - .5, fy - .5)); }
      F = Math.min(1, F); cover.push(F);
      nearRGB(texel(out, column, row), [...[0, 1, 2].map(q => front[q] * F + back[q] * (1 - F)), 1], 1e-6);
    }
    expect([Math.min(...cover), Math.max(...cover)]).toEqual([0, 1]); // both paper and full ink pixels are checked
  });
});
