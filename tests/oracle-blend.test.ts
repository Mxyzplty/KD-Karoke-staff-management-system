// SPDX-License-Identifier: AGPL-3.0-only
// Findings part 5 §58 (blend modes) through the oracle's equations.
import { describe, it, expect } from 'vitest';
import { blendColour, composite, compositeImage, lum } from '../parity/oracle/blend';
import { createImage } from '../parity/oracle/image';
import type { RGB, RGBA } from '../parity/oracle/math';

const c8 = (v: number): RGB => [v / 255, v / 255, v / 255];
const before = (mode: string, layer: number, backdrop: number) => blendColour(mode, c8(backdrop), c8(layer))[0] * 255;
// One opaque 1 × 1 draw of `layer` onto opaque `backdrop`, stored to 8 bit (§58.3 rule).
const drawn = (mode: string, layer: number, backdrop: number) => {
  const b = createImage(1, 1, [...c8(backdrop), 1] as RGBA), l = createImage(1, 1, [...c8(layer), 1] as RGBA);
  return Math.round(compositeImage(b, l, mode).data[0] * 255);
};
const within = (a: number, e: number, tol: number) => expect(Math.abs(a - e)).toBeLessThanOrEqual(tol);

describe('§58 blend modes', () => {
  it('§58.3 blend test values: layer 128 over backdrop 128, multiply / screen / darken / lighten / difference', () => {
    for (const [mode, v] of [['multiply', 64], ['screen', 192], ['darken', 128], ['lighten', 128], ['difference', 0]] as const) within(drawn(mode, 128, 128), v, 1);
    within(before('screen', 128, 128), 191.75, 0.005);
  });
  it('§58.3 blend test values: layer 128 over backdrop 128, overlay / hard-light / soft-light / exclusion', () => {
    for (const [mode, v, pre] of [['overlay', 128, 128.5], ['hard-light', 128, 128.5], ['soft-light', 128, 128.21], ['exclusion', 127, 127.5]] as const) {
      within(drawn(mode, 128, 128), v, 1);
      within(before(mode, 128, 128), pre, 0.005);
    }
  });
  it('§58.3 blend test values: layer 200 over backdrop 100', () => {
    for (const [mode, v] of [['multiply', 78], ['screen', 222], ['difference', 100], ['color-dodge', 255], ['color-burn', 57]] as const) within(drawn(mode, 200, 100), v, 1);
  });
  it('§58.2 compositing rule: Cm = (1 − αb)·Cs + αb·B, then source-over', () => {
    // multiply layer 0.8 at αs 0.5 over opaque 0.5: Cm = 0.4, out = 0.5·0.4 + 0.5·0.5 = 0.45
    const o = composite([0.5, 0.5, 0.5, 1], [0.8, 0.8, 0.8, 0.5], 'multiply');
    expect(o[0]).toBeCloseTo(0.45, 12); expect(o[3]).toBe(1);
    // against a transparent backdrop every mode is plain source-over
    const t = composite([0, 0, 0, 0], [0.8, 0.2, 0.4, 0.5], 'difference');
    expect(t).toEqual([0.8, 0.2, 0.4, 0.5]);
  });
  it('§58.4 a blended layer with nothing beneath blends with the export black', () => {
    const s: RGB = [200 / 255, 100 / 255, 50 / 255], black: RGB = [0, 0, 0];
    for (const mode of ['multiply', 'darken', 'color-dodge', 'color-burn', 'overlay', 'soft-light', 'hue', 'saturation', 'color']) blendColour(mode, black, s).forEach(v => expect(v).toBeCloseTo(0, 12));
    for (const mode of ['screen', 'lighten', 'difference', 'exclusion']) blendColour(mode, black, s).forEach((v, i) => expect(v).toBeCloseTo(s[i], 12));
    blendColour('hard-light', black, s).forEach((v, i) => expect(v).toBeCloseTo(Math.max(0, 2 * s[i] - 1), 12));
    blendColour('luminosity', black, s).forEach(v => expect(v).toBeCloseTo(lum(s), 12));
  });
});
