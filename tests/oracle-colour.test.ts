// SPDX-License-Identifier: AGPL-3.0-only
// Formula oracle, colour effects: one it() per "Test values" block of findings part 4 §49.
// Inputs are the block's stated inputs; expected values are copied as printed.
import { it, expect } from 'vitest';
import { colourEffect, effects, cssFilters, importCube, retouchPixel, keyDistance, recolorWeights } from '../parity/oracle/colour';
import { createImage, texel, type Image } from '../parity/oracle/image';
import { y709, type Params, type RGB, type RGBA } from '../parity/oracle/math';

// Tolerance = half a unit of the last printed digit. The 1e-7 slack only absorbs the
// float32 output rounding when an exact result sits on the printed rounding tie.
function near(actual: ArrayLike<number>, printed: string) {
  printed.split(',').map(s => s.trim()).forEach((s, i) => {
    const tol = .5 * 10 ** -(s.split('.')[1]?.length ?? 0);
    expect(Math.abs(actual[i] - Number(s)), `component ${i}: ${actual[i]} vs printed ${s}`).toBeLessThanOrEqual(tol + 1e-7);
  });
}
const grey = (v: string) => `${v}, ${v}, ${v}`;
// One pass of a chain effect on a 1 × 1 opaque image (pixel centre = (0.5, 0.5)).
const run = (effect: (typeof effects)[string], rgb: number[], p: Params = {}, a = 1) => Array.from(effect(createImage(1, 1, [...rgb, a] as RGBA), p, { timeS: 0 }).data);
const px = (id: string, rgb: number[], p: Params = {}) => run(effects[id], rgb, p);
const b64 = (table: Uint8Array) => Buffer.from(table).toString('base64');

it('§49.2 color-wheels test values', () => {
  near(px('color-wheels', [.2, .4, .6]), '0.2, 0.4, 0.6');
  near(px('color-wheels', [.2, .4, .6], { exposure: 1 }), '0.4, 0.8, 1.0');
  near(px('color-wheels', [.2, .4, .6], { contrast: 1.5 }), '0.05, 0.35, 0.65');
  near(px('color-wheels', [.5, .5, .5], { temperature: 100, tint: 50 }), '0.625, 0.45, 0.425');
  near(px('color-wheels', [.9, .9, .9], { highlightsWheel: { angle: 330, distance: .5 } }), '0.9, 0.6984, 0.4968');
  near(px('color-wheels', [.5, .5, .5], { offsetWheel: { angle: 90, distance: .4 } }), '0.4, 0.3, 0.5');
  near(px('color-wheels', [.2, .2, .2], { shadows: 50, toneCurve: 2 }), grey('0.2810'));
  near(px('color-wheels', [.2, .2, .2], { shadows: 50, toneCurve: 1 }), grey('0.5240'));
  near(px('color-wheels', [.8, .8, .8], { highlights: -100, toneCurve: 2 }), grey('0.6208'));
  near(px('color-wheels', [.8, .8, .8], { highlights: -100, toneCurve: 1 }), grey('0.1520'));
  near(px('color-wheels', [1, 0, 0], { hue: 75 }), '0.5, 1, 0');
  near(px('color-wheels', [.2, .4, .6], { lumMix: 0 }), grey('0.363'));
  near(px('color-wheels', [.2, .4, .6], { lift: .1, gain: 1.2, gamma: 2 }), '0.6, 0.7746, 0.9165');
  near(px('color-wheels', [.2, .4, .6], { colorBoost: 100 }), '0.0843, 0.4263, 0.7683');
  near(px('color-wheels', [.4, .5, .6], { midDetail: 100 }), '0.3188, 0.5184, 0.7180');
});

it('§49.3 curves test values', () => {
  near(px('curves', [.3, .5, .7]), '0.3, 0.5, 0.7');
  near(px('curves', [.25, .5, .75], { masterShadowY: .15, masterHighlightY: .85 }), '0.1520, 0.5, 0.8480');
  near(px('curves', [0, .5, 1], { masterBlackY: .1, masterWhiteY: .9 }), '0.1020, 0.5, 0.9020');
  near(px('curves', [.75, .75, .75], { redHighlightY: .85, blueHighlightY: .65 }), '0.8510, 0.75, 0.6490');
  near(px('curves', [.5, .5, .5], { masterMidOn: true, masterMidY: .6 }), grey('0.5980'));
  near(px('curves', [.5, .5, .5], { masterMidOn: false, masterMidY: .6 }), grey('0.5'));
});

it('§49.4 lut test values', () => {
  near(px('lut', [1 / 32, 1 / 32, 1 / 32]), grey('0.0314'));
  const inverting = b64(importCube(['LUT_3D_SIZE 2', ...[0, 1].flatMap(b => [0, 1].flatMap(g => [0, 1].map(r => `${1 - r} ${1 - g} ${1 - b}`)))].join('\n')));
  near(px('lut', [.25, .5, .75], { lutData: inverting }), '0.7490, 0.5020, 0.2510');
  near(px('lut', [.25, .5, .75], { lutData: inverting, blend: 50 }), '0.4995, 0.5010, 0.5005');
  const oneD = b64(importCube('LUT_1D_SIZE 3\n0 0 0\n0.25 0.25 0.25\n1 1 1'));
  near(px('lut', [.5, .5, .5], { lutData: oneD }), grey('0.2510'));
  near(px('lut', [.25, .25, .25], { lutData: oneD }), grey('0.1255'));
});

it('§49.5 levels test values', () => {
  near(px('levels', [.5, .25, .75], { inputBlack: 10, inputWhite: 90 }), '0.5, 0.1875, 0.8125');
  near(px('levels', [.25, .5, .81], { gamma: 2 }), '0.5, 0.7071, 0.9');
  near(px('levels', [0, .5, 1], { outputBlack: 20, outputWhite: 80 }), '0.2, 0.5, 0.8');
});

it('§49.6 hsl test values', () => {
  near(px('hsl', [1, 0, 0], { redHue: 100 }), '1, 0.5, 0');
  near(px('hsl', [1, .5, 0], { orangeSaturation: -100 }), '0.5, 0.5, 0.5');
  near(px('hsl', [0, 0, 1], { blueLuminance: -50 }), '0, 0, 0.5');
  near(px('hsl', [.2, .4, .8], { blueLuminance: 100 }), '0.52, 0.64, 0.88');
  near(px('hsl', [.2, .6, .2], { greenHue: -100, greenSaturation: 50 }), '0.25, 0.7, 0.1');
});

it('§49.7 secondary-qualifier test values', () => {
  const p = { saturation: -100 }, mask = (rgb: number[], q: Params = {}) => px('secondary-qualifier', rgb, { ...p, ...q, showMask: true });
  near(px('secondary-qualifier', [1, 0, 0], p), grey('0.299')); near(mask([1, 0, 0]), grey('1'));
  near(px('secondary-qualifier', [.9, .6, .5], p), grey('0.6783')); near(mask([.9, .6, .5]), grey('1'));
  near(px('secondary-qualifier', [0, 0, 1], p), '0, 0, 1'); near(mask([0, 0, 1]), grey('0'));
  const narrow = { hueCenter: 40, hueWidth: 10, hueSoftness: 20 };
  near(px('secondary-qualifier', [.9, .6, .5], { ...p, ...narrow }), '0.8654, 0.6122, 0.5279'); near(mask([.9, .6, .5], narrow), grey('0.15625'));
  near(mask([.5, .5, .5], { satLow: 20 }), grey('0'));
});

it('§49.8 power-window test values', () => {
  const at = (x: number, y: number, q: Params = {}, aspect = 1920 / 1080) => colourEffect('power-window', [.4, .4, .4, 1], { exposure: 1, ...q }, [x, y, aspect]);
  near(px('power-window', [.4, .4, .4], { exposure: 1 }), grey('0.8')); // 1 × 1 item: its pixel centre is the window centre
  near(at(.5, .5), grey('0.8')); near(at(.5, .5, { showMask: true }), grey('1'));
  near(at(.5, .72), grey('0.7584')); near(at(.5, .72, { showMask: true }), grey('0.896'));
  near(at(.9, .5), grey('0.4')); near(at(.9, .5, { showMask: true }), grey('0'));
  near(at(.5, .5, { invertMask: true }), grey('0.4'));
  const turned = { sizeX: 10, sizeY: 60, rotation: 45, showMask: true };
  near(at(.4, .6, turned, 1), grey('1')); near(at(.6, .6, turned, 1), grey('0'));
});

it('§49.9 retouch test values', () => {
  const skin: RGBA = [.85, .58, .48, 1], flat = createImage(8, 8, skin);
  expect(effects.retouch(flat, { strength: 100 }, { timeS: 0 }).data).toEqual(flat.data);
  const blemish = (size: number): Image => { const image = createImage(size, size, skin), c = size / 2; image.data.set([.9, .6, .5, 1], ((size - 1 - c) * size + c) * 4); return image; };
  const small = blemish(10);
  expect(effects.retouch(small, { strength: 0 }, { timeS: 0 }).data).toEqual(small.data);
  const image = blemish(800), p = { radius: 1, detail: 60, edgeTolerance: 15 };
  expect(texel(image, 400, 400)).toEqual(texel(createImage(1, 1, [.9, .6, .5, 1]), 0, 0));
  near(retouchPixel(image, 400, 400, { ...p, strength: 20 }), '0.8960, 0.5984, 0.4984');
  near(retouchPixel(image, 400, 400, { ...p, strength: 100 }), '0.8802, 0.5921, 0.4921');
  near(retouchPixel(image, 400, 400, { ...p, showMask: true }), '1, 1, 1');
  near(px('retouch', [.2, .6, .2], { showMask: true }), grey('0'));
});

it('§49.10 posterize test values', () => {
  near(px('posterize', [.3, .5, .95], { levels: 8 }), '0.25, 0.5, 1');
  near(px('posterize', [.3, .5, .95], { levels: 2 }), '0.5, 0.5, 1');
  near(px('posterize', [.0625, .1875, .06], { levels: 8 }), '0.125, 0.25, 0');
});

it('§49.11 color-key test values', () => {
  const key: RGB = [0, 177 / 255, 64 / 255];
  near(px('color-key', key), '0, 0, 0, 0');
  near([keyDistance([.2, .8, .2], key)], '0.1116'); near(px('color-key', [.2, .8, .2]), '0, 0, 0, 0');
  near([keyDistance([.3, .62, .35], key)], '0.1745'); near(px('color-key', [.3, .62, .35]), '0.2993, 0.3950, 0.3400, 0.8145');
  near([keyDistance([.3, .6, .35], key)], '0.1838'); near(px('color-key', [.3, .6, .35]), '0.3625, 0.4750, 0.4125, 1');
  near(px('color-key', [.8, .5, .4]), '0.8, 0.5, 0.4, 1');
});

it('§49.11 color-key keyColor parsing: only rgb()/rgba(), #rgb and #rrggbb; anything else keys green', () => {
  // Blue (0, 0, 1) is far from the green key (keyed only if the key is blue); the default green is keyed only by a green key.
  const blue = (keyColor: string) => px('color-key', [0, 0, 1], { keyColor })[3], green = (keyColor: string) => px('color-key', [0, 177 / 255, 64 / 255], { keyColor })[3];
  for (const k of ['#0000ff', '#00f', 'rgba(0,0,255,0.5)', 'rgb(0,0,255)']) expect([blue(k), green(k)], k).toEqual([0, 1]);
  for (const k of ['#0000ffff', '#00ff', '0000ff', 'blue']) expect([blue(k), green(k)], k).toEqual([1, 0]);
});

it('§49.12 luma-key test values', () => {
  near(px('luma-key', [.15, .15, .15]), '0, 0, 0, 0');
  near(px('luma-key', [.25, .25, .25]), '0.125, 0.125, 0.125, 0.5');
  near(px('luma-key', [.9, .9, .9], { keyType: 'bright', threshold: 80, softness: 10 }), '0, 0, 0, 0');
  near(px('luma-key', [.75, .75, .75], { keyType: 'bright', threshold: 80, softness: 10 }), '0.375, 0.375, 0.375, 0.5');
});

it('§49.13 grayscale test values', () => {
  near(px('grayscale', [1, 0, 0]), grey('0.299'));
  near(px('grayscale', [.2, .4, .6], { amount: 50 }), '0.2815, 0.3815, 0.4815');
});

it('§49.14 sepia test values', () => {
  near(px('sepia', [.5, .5, .5]), '0.6755, 0.6015, 0.4685');
  near(px('sepia', [.2, .4, .6]), '0.4996, 0.4450, 0.3466');
  near(px('sepia', [1, 1, 1]), '1, 1, 0.9370');
});

it('§49.15 invert test values', () => {
  near(run(cssFilters.invert, [.2, .4, .6], { amount: 100 }), '0.8, 0.6, 0.4');
  near(run(cssFilters.invert, [.2, .4, .6], { amount: 50 }), '0.5, 0.5, 0.5');
  near(run(cssFilters.invert, [.2, .4, .6], { amount: 25 }), '0.35, 0.45, 0.55');
});

it('§49.16 threshold test values', () => {
  near(px('threshold', [.5, .5, .5], { level: 50 }), grey('0'));
  near(px('threshold', [.6, .6, .6], { level: 50 }), grey('1'));
  near([y709([.6, .4, .4])], '0.4425'); near(px('threshold', [.6, .4, .4], { level: 50 }), grey('0'));
  near([y709([.2, .8, .2])], '0.6291'); near(px('threshold', [.2, .8, .2], { level: 50 }), grey('1'));
});

it('§49.16 threshold uses Y709, not Y601 (inputs where the two disagree)', () => {
  // (0.1, 0.7, 0.1): Y709 = 0.02126 + 0.50064 + 0.00722 = 0.52912 > 0.5, Y601 = 0.4522 → 1.
  // (0.9, 0.35, 0.4): Y709 = 0.19134 + 0.25032 + 0.02888 = 0.47054 ≤ 0.5, Y601 = 0.52015 → 0.
  expect(px('threshold', [.1, .7, .1], { level: 50 })).toEqual([1, 1, 1, 1]);
  expect(px('threshold', [.9, .35, .4], { level: 50 })).toEqual([0, 0, 0, 1]);
});

it('§49.18 lumetri-color test values', () => {
  near(px('lumetri-color', [.2, .4, .6]), '0.2, 0.4, 0.6');
  near(px('lumetri-color', [.5, .5, .5], { temperature: 100 }), '0.6, 0.5, 0.4');
  near(px('lumetri-color', [.2, .4, .6], { saturation: 0 }), grey('0.3719'));
  near(px('lumetri-color', [.1, .1, .1], { shadowsWheel: { angle: 0, distance: .4 } }), '0.2687, 0.0156, 0.1');
  near(px('lumetri-color', [.2, .4, .6], { vibrance: 100 }), '0.0774, 0.42, 0.7626');
});

it('§49.18 lumetri-color white balance coefficients, exact', () => {
  // Step 1 only (every later step is neutral at the defaults): R += 0.1·temp − 0.05·tint, G += 0.1·tint, B += −0.1·temp − 0.05·tint.
  const exact = (actual: number[], expected: number[]) => expected.forEach((v, i) => expect(Math.abs(actual[i] - v), `component ${i}: ${actual[i]} vs ${v}`).toBeLessThanOrEqual(1e-6));
  exact(px('lumetri-color', [.5, .5, .5], { temperature: 100 }), [.6, .5, .4, 1]);
  exact(px('lumetri-color', [.3, .3, .3], { temperature: 50, tint: 40 }), [.3 + .05 - .02, .3 + .04, .3 - .05 - .02, 1]);
});

it('§49.19 recolor test values', () => {
  const two = { palette: [{ base: '#d02020', kind: 'color' }, { base: '#2050d0', kind: 'color' }], colors: ['#20a040'] };
  near(px('recolor', [.82, .13, .13], two), '0.1312, 0.6304, 0.2527');
  near(px('recolor', [.13, .31, .82], two), '0.13, 0.31, 0.82');
  near(px('recolor', [.5, .5, .5], two), '0.5, 0.5, 0.5');
  near(px('recolor', [.6, .2, .6], two), '0.6044, 0.3583, 0.3415'); near(recolorWeights([.6, .2, .6], two), '0.531, 0.469');
  const white = { palette: [{ base: '#ffffff', kind: 'neutral' }], colors: ['#ffd0a0'] };
  near(px('recolor', [.5, .5, .5], white), '0.5483, 0.3859, 0.2073');
  near(px('recolor', [1, 0, 0], white), '1, 0, 0');
});

it('§49.19 recolor: a fully coloured pixel takes no neutral weight (the (1 − colored) factor)', () => {
  // Pure red: OKLab chroma ≈ 0.26 > chromaHi 0.07, so colored = 1 and neutral = (1 − 1)·… = 0. "Unchanged" is checked to
  // float32 precision (the OKLab round trip only), not to the printed integers' ±0.5.
  const white = { palette: [{ base: '#ffffff', kind: 'neutral' }], colors: ['#ffd0a0'] };
  px('recolor', [1, 0, 0], white).forEach((v, i) => expect(Math.abs(v - [1, 0, 0, 1][i]), `component ${i}: ${v}`).toBeLessThanOrEqual(1e-6));
});

it('§49.20 bg-removal test values', () => {
  near(run(effects['bg-removal'], [.8, .4, .2], { mask: createImage(1, 1, [0, 0, 0, .5]) }), '0.4, 0.2, 0.1, 0.5');
  near(run(effects['bg-removal'], [.8, .4, .2], { mask: createImage(1, 1, [1, 1, 1, 0]) }), '0, 0, 0, 0');
});
