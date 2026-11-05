// SPDX-License-Identifier: AGPL-3.0-only
// Formula oracle, findings part 4 §51: every "Test values" block recomputed through
// parity/oracle/distort.ts on small synthetic images.
import { describe, expect, it } from 'vitest';
import { blurTaps, cssFilters, effects, fragments } from '../parity/oracle/distort';
import { createImage, sample, texel, type Image } from '../parity/oracle/image';
import type { RGBA } from '../parity/oracle/math';

const ctx = { timeS: 0 };
// Tolerance = half a unit of the printed value's last digit, unless a tighter one is passed.
const printed = (actual: number, text: string, tol = .5 * 10 ** -(text.split('.')[1]?.length ?? 0)) =>
  expect(Math.abs(actual - Number(text)), `${actual} vs printed ${text}`).toBeLessThanOrEqual(tol + 1e-12);
// Exact claims ("unchanged", "identity", "transparent") are checked to float32 storage precision.
const exact = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(1e-6);
const build = (w: number, h: number, f: (c: number, rowFromBottom: number) => RGBA): Image => {
  const im = createImage(w, h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) im.data.set(f(c, r), ((h - 1 - r) * w + c) * 4);
  return im;
};
const noise = (w: number, h: number) => build(w, h, (c, r) => [0, 1, 2, 3].map(k => { const s = Math.sin(c * 12.9898 + r * 78.233 + k * 37.719) * 43758.5453; return s - Math.floor(s); }) as RGBA);
const flat = (w: number, h: number) => build(w, h, () => [.3, .6, .9, 1]);
const same = (a: Image, b: Image) => { expect([a.width, a.height]).toEqual([b.width, b.height]); a.data.forEach((v, i) => exact(v, b.data[i])); };
// R and G hold the pixel-centre position in texels (exact in float32); a bilinear sample
// then returns the uv it was taken at. Off-image taps read back the clamped edge centre.
const coords = (w: number, h: number) => build(w, h, (c, r) => [c + .5, r + .5, 0, 1]);
const C = coords(1000, 1000);
const uv = (s: RGBA, im = C) => [s[0] / im.width, s[1] / im.height];
const EDGE = 1 / 1000; // read-back margin of a boundary uv on C (half a texel, rounded up)
const top = (im: Image, c: number, rowFromTop: number) => texel(im, c, im.height - 1 - rowFromTop);

describe('§51 blur, distort and generate effects (formula oracle)', () => {
  it('§51.1 box-blur test values', () => {
    const src = noise(7, 5);
    same(effects['box-blur'](src, { radius: .7 }, ctx), src);
    const ramp = build(10, 1, c => [c / 9, c / 9, c / 9, 1]);
    printed(texel(effects['box-blur'](ramp, { radius: 1 }, ctx), 0, 0)[0], '0.037037');
    printed(texel(effects['box-blur'](ramp, { radius: 1 }, ctx), 5, 0)[0], '0.555556');
    printed(texel(effects['box-blur'](ramp, { radius: 3 }, ctx), 0, 0)[0], '0.095238');
    const line = effects['box-blur'](build(11, 7, c => c === 5 ? [1, 1, 1, 1] : [0, 0, 0, 1]), { radius: 2 }, ctx);
    for (let r = 0; r < 7; r++) for (let c = 0; c < 11; c++) Math.abs(c - 5) <= 2 ? printed(texel(line, c, r)[0], '0.2') : exact(texel(line, c, r)[0], 0);
    same(effects['box-blur'](flat(6, 4), { radius: 4 }, ctx), flat(6, 4));
  });

  it('§51.2 motion-blur test values', () => {
    const p = { amount: 20, angle: 0, samples: 4 }, taps = blurTaps['motion-blur'](.5, .5, p, 1000, 1), total = taps.reduce((s, t) => s + t[2], 0);
    ['-60', '-20', '20', '60'].forEach((px, i) => printed((taps[i][0] - .5) * 1000, px));
    ['0.072289', '0.427711', '0.427711', '0.072289'].forEach((w, i) => printed(taps[i][2] / total, w));
    printed(total, '1.872145');
    // A single white texel at column 500 shows each tap's offset and normalised weight.
    const dot = effects['motion-blur'](build(1000, 1, c => c === 500 ? [1, 1, 1, 1] : [0, 0, 0, 1]), p, ctx);
    ([[560, '0.072289'], [520, '0.427711'], [480, '0.427711'], [440, '0.072289']] as const).forEach(([c, w]) => printed(texel(dot, c, 0)[0], w));
    const src = noise(9, 7);
    same(effects['motion-blur'](src, { angle: 30 }, ctx), effects['motion-blur'](src, { angle: 210 }, ctx));
    same(effects['motion-blur'](flat(9, 7), { amount: 100, angle: 33 }, ctx), flat(9, 7));
  });

  it('§51.3 radial-blur test values', () => {
    const p = { amount: 25, centerX: 50, centerY: 50, samples: 32 }, inner = (x: number, y: number, q = p) => blurTaps['radial-blur'](x, y, q, 1920, 1080).at(-1)!;
    printed(inner(1, .5)[0], '0.975'); printed(inner(1, .5)[1], '0.5');
    printed((1 - inner(1, .5)[0]) * 1920, '48');
    inner(1, 1).slice(0, 2).forEach(v => printed(v, '0.96464'));
    inner(1, 1, { ...p, amount: 100 }).slice(0, 2).forEach(v => printed(v, '0.85858'));
    const src = noise(5, 5), out = effects['radial-blur'](src, p, ctx); // centre texel (2, 2) sits at uv (0.5, 0.5)
    texel(out, 2, 2).forEach((v, k) => exact(v, texel(src, 2, 2)[k]));
    same(effects['radial-blur'](flat(8, 6), { amount: 100, centerX: 20, centerY: 70 }, ctx), flat(8, 6));
  });

  it('§51.4 zoom-blur test values', () => {
    const taps = blurTaps['zoom-blur'](.75, .5, { amount: 30, samples: 16, centerX: 50, centerY: 50 }, 1000, 1000), total = taps.reduce((s, t) => s + t[2], 0);
    expect(taps).toHaveLength(16);
    printed(taps[0][0], '0.75'); printed(taps[15][0], '0.7875');
    taps.forEach((t, i) => { exact(t[0], .75 + i * (.7875 - .75) / 15); exact(t[1], .5); exact(t[2] / total, 1 / 16); });
    printed(uv(fragments['zoom-blur'](C, .75, .5, { amount: 30, samples: 16 }))[0], '0.76875'); // equal-weight mean of 0.75…0.7875
    const last = blurTaps['zoom-blur'](.9, .9, { amount: 100 }, 1000, 1000).at(-1)!;
    printed(last[0], '1.1'); printed(last[1], '1.1');
    const src = noise(6, 4);
    sample(src, last[0], last[1]).forEach((v, k) => exact(v, texel(src, 5, 3)[k]));
    const odd = noise(5, 5);
    texel(effects['zoom-blur'](odd, { amount: 100 }, ctx), 2, 2).forEach((v, k) => exact(v, texel(odd, 2, 2)[k]));
  });

  it('§51.5 gaussian-blur test values', () => {
    const src = noise(8, 6);
    same(cssFilters['gaussian-blur'](src, { radius: 0 }, ctx), src);
    // Opaque white left half on a transparent raster; 84 %→16 % alpha transition along the middle row.
    const edge = build(64, 64, c => c < 32 ? [1, 1, 1, 1] : [0, 0, 0, 0]);
    const width = (im: Image) => {
      const a = Array.from({ length: im.width }, (_, c) => top(im, c, 32)[3]);
      const cross = (level: number) => { for (let c = 16; c + 1 < a.length; c++) if (a[c] >= level && a[c + 1] < level) return c + (a[c] - level) / (a[c] - a[c + 1]); return NaN; };
      return cross(.16) - cross(.84);
    };
    printed(width(cssFilters['gaussian-blur'](edge, { radius: 4 }, ctx)), '8');
    // The item's own blur(3px) is the same CSS blur, placed first in the chain.
    printed(width(cssFilters['gaussian-blur'](cssFilters['gaussian-blur'](edge, { radius: 3 }, ctx), { radius: 4 }, ctx)) / 2, '5');
  });

  it('§51.6 drop-shadow test values', () => {
    const W = 110, square = (c: number, rTop: number) => c >= 5 && c <= 104 && rTop >= 5 && rTop <= 104; // 100 × 100 at columns/rows 5…104
    const src = build(W, W, (c, r) => square(c, W - 1 - r) ? [1, 1, 1, 1] : [0, 0, 0, 0]);
    const out = cssFilters['drop-shadow'](src, { x: 4, y: 4, blur: 0, color: 'rgba(0,0,0,0.5)' }, ctx);
    const right2 = top(out, 104 + 2, 54);
    ['0', '0', '0', '0.5'].forEach((v, k) => printed(right2[k], v));
    // Over an opaque white background, then the 8-bit write.
    const onWhite = right2.slice(0, 3).map(v => Math.round((v * right2[3] + (1 - right2[3])) * 255));
    onWhite.forEach(v => printed(v, '128'));
    exact(top(out, 104 + 5, 54)[3], 0);
    exact(top(out, 54, 5 - 2)[3], 0);
    for (let r = 5; r <= 104; r++) for (let c = 5; c <= 104; c++) top(out, c, r).forEach(v => exact(v, 1));
  });

  it('§51.7 chromatic-aberration test values', () => {
    // R and B carry u (or v) in texels, so out.r − p = +o and out.b − p = −o along that axis.
    const X = build(1000, 500, c => [c + .5, 0, c + .5, 1]), Y = build(1000, 500, (_, r) => [r + .5, 0, r + .5, 1]);
    const offset = (amount: number, angle: number) => {
      const p = { amount, angle }, sx = fragments['chromatic-aberration'](X, .5, .5, p), sy = fragments['chromatic-aberration'](Y, .5, .5, p);
      expect(sx[2] / 1000 - .5).toBeCloseTo(-(sx[0] / 1000 - .5), 12);
      return [sx[0] / 1000 - .5, sy[0] / 500 - .5];
    };
    let [ox, oy] = offset(5, 0); printed(ox, '0.005'); exact(oy, 0);
    [ox, oy] = offset(5, 90); exact(ox, 0); printed(oy, '0.01'); printed(oy * 500, '5');
    [ox, oy] = offset(10, 45); printed(ox, '0.007071'); printed(oy, '0.014142'); printed(ox * 1000, '7.0711'); printed(oy * 500, '7.0711');
    const line = effects['chromatic-aberration'](build(200, 3, c => c === 100 ? [1, 1, 1, 1] : [0, 0, 0, 1]), { amount: 5, angle: 0 }, ctx);
    ([[95, [1, 0, 0]], [100, [0, 1, 0]], [105, [0, 0, 1]]] as const).forEach(([c, rgb]) => rgb.forEach((v, k) => exact(texel(line, c, 1)[k], v)));
    const src = noise(9, 7);
    same(effects['chromatic-aberration'](src, { amount: 0, angle: 37 }, ctx), src);
  });

  it('§51.8 lens-distortion test values', () => {
    const src = noise(9, 7);
    same(effects['lens-distortion'](src, { distortion: 0 }, ctx), src);
    for (const distortion of [-100, -40, 30, 100]) uv(fragments['lens-distortion'](C, .5, .5, { distortion })).forEach(v => exact(v, .5));
    const [u, v] = uv(fragments['lens-distortion'](C, 1, .5, { distortion: 50 }));
    printed(u, '0.75'); printed(v, '0.5');
    fragments['lens-distortion'](C, 1, .5, { distortion: 50, mirrorEdges: false }).forEach(x => exact(x, 0));
    uv(fragments['lens-distortion'](C, 1, 1, { distortion: -50 })).forEach(x => printed(x, '0.5'));
    uv(fragments['lens-distortion'](C, 1, 1, { distortion: -100 })).forEach(x => printed(x, '0', EDGE));
    uv(fragments['lens-distortion'](C, .75, .75, { distortion: 30 })).forEach(x => printed(x, '0.7875'));
  });

  it('§51.9 twirl test values', () => {
    const at = (x: number, y: number, p: Record<string, number>) => uv(fragments.twirl(C, x, y, { centerX: 50, centerY: 50, ...p }));
    let [u, v] = at(.75, .5, { amount: 10, radius: 50 }); printed(u, '0.742228'); printed(v, '0.561851');
    [u, v] = at(.6, .5, { amount: -50, radius: 50 }); printed(u, '0.400171'); printed(v, '0.505837');
    [u, v] = at(.5, .95, { radius: 40 }); exact(u, .5); exact(v, .95);
    [u, v] = at(.5, .5, { amount: 100, radius: 100 }); exact(u, .5); exact(v, .5);
  });

  it('§51.10 wave test values', () => {
    const at = (x: number, y: number, p: Record<string, number> = {}) => uv(fragments.wave(C, x, y, p));
    let [u, v] = at(.05, .5); printed(u, '0.038244'); printed(v, '0.52');
    [u, v] = at(.3, .1); exact(u, .3); exact(v, .1);
    [u, v] = at(.5, .5); exact(u, .5); exact(v, .5);
    [u, v] = at(.25, 0, { amplitudeX: 100, amplitudeY: 100, frequencyX: 1, frequencyY: 1 }); printed(u, '0.308779'); printed(v, '0.1');
  });

  it('§51.11 kaleidoscope test values', () => {
    const at = (deg: number, p: Record<string, number>) => uv(fragments.kaleidoscope(C, .5 + .25 * Math.cos(deg * Math.PI / 180), .5 + .25 * Math.sin(deg * Math.PI / 180), p));
    // a back from the sampled point: the sample sits at radius 0.25, angle a above +x.
    const a = (s: number[]) => Math.atan2(s[1] - .5, s[0] - .5) * 180 / Math.PI;
    let s = at(100, { segments: 6, rotation: 0 }); printed(a(s), '20'); printed(s[0], '0.73492'); printed(s[1], '0.58551');
    for (const deg of [10, -10]) { s = at(deg, { segments: 6 }); printed(a(s), '10'); printed(s[0], '0.74620'); printed(s[1], '0.54341'); }
    at(200, { segments: 6 }).forEach((x, k) => exact(x, at(100, { segments: 6 })[k]));
    printed(a(at(100, { segments: 6, rotation: 30 })), '10');
    // Rotation sign: φ = atan2 + ρ. n 6, rotation 15, angle 10° → φ 25° → a 25° (a sign flip would give φ −5° → a 5°).
    s = at(10, { segments: 6, rotation: 15 });
    exact(s[0], .5 + .25 * Math.cos(25 * Math.PI / 180)); exact(s[1], .5 + .25 * Math.sin(25 * Math.PI / 180));
    for (const [x, y] of [[1, 1], [0, 0]]) uv(fragments.kaleidoscope(C, x, y, { segments: 4 })).forEach(v => printed(v, '1', EDGE));
    s = at(170, { segments: 2.5 }); printed(a(s), '26'); printed(s[0], '0.72470'); printed(s[1], '0.60959');
  });

  it('§51.12 mirror test values', () => {
    const row = (values: number[]) => build(values.length, 1, c => [values[c], values[c], values[c], 1]);
    const col = (topToBottom: number[]) => build(1, topToBottom.length, (_, r) => { const v = topToBottom[topToBottom.length - 1 - r]; return [v, v, v, 1]; });
    const readRow = (im: Image) => Array.from({ length: im.width }, (_, c) => texel(im, c, 0)[0]);
    const readCol = (im: Image) => Array.from({ length: im.height }, (_, r) => top(im, 0, r)[0]);
    const [a, b, c, d, e] = [.1, .2, .3, .4, .5];
    readRow(effects.mirror(row([a, b, c, d]), { horizontal: true }, ctx)).forEach((v, i) => exact(v, [a, b, b, a][i]));
    readRow(effects.mirror(row([a, b, c, d, e]), { horizontal: true }, ctx)).forEach((v, i) => exact(v, [a, b, c, b, a][i]));
    const t = [.1, .2, .3, .4], vertical = { horizontal: false, vertical: true };
    readCol(effects.mirror(col(t), vertical, ctx)).forEach((v, i) => exact(v, [t[3], t[2], t[2], t[3]][i]));
    // WebGPU path = the same maths with y counted down: flip, apply, flip back.
    const flip = (im: Image) => col(readCol(im).reverse());
    readCol(flip(effects.mirror(flip(col(t)), vertical, ctx))).forEach((v, i) => exact(v, [t[0], t[1], t[1], t[0]][i]));
    const src = noise(7, 6);
    same(effects.mirror(src, { horizontal: false, vertical: false }, ctx), src);
  });

  it('§51 printed numbers outside the test-values blocks', () => {
    expect(blurTaps['box-blur'](.5, .5, { radius: 5 }, 100, 100)).toHaveLength(121);
    expect(blurTaps['box-blur'](.5, .5, { radius: 20 }, 100, 100)).toHaveLength(1681);
    const taps = blurTaps['motion-blur'](.5, .5, {}, 1920, 1080), total = taps.reduce((s, t) => s + t[2], 0);
    printed(total, '13.884806'); printed(taps[11][2] / total, '0.071749'); printed(taps[12][2] / total, '0.071749'); printed(taps[0][2] / total, '0.009747');
    printed((taps[23][0] - .5) * 1920, '115.2');
    const diagonal = blurTaps['motion-blur'](.5, .5, { angle: 45 }, 1080, 1920).at(-1)!;
    printed(Math.atan2((diagonal[1] - .5) * 1920, (diagonal[0] - .5) * 1080) * 180 / Math.PI, '60.64');
    printed(blurTaps['radial-blur'](.9, .2, {}, 1920, 1080).reduce((s, t) => s + t[2], 0), '24');
  });
});
