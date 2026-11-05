// SPDX-License-Identifier: AGPL-3.0-only
// T10a CPU-side logic vs the oracle: LUT import, curves table, CSS chain, Colour block maths, uniform packing,
// halftone/recolor setup. No GPU.
import { describe, expect, it } from 'vitest';
import {
  EFFECTS, LUT_BYTES, LUT_GRID, ADVANCED_GROUPS, BASIC_SLIDERS, COLOUR_BLOCK_EFFECTS, NEUTRAL_WHEEL,
  blockInstances, bt709Table, cssChain, cssFilterFor, cssFilterString, curvesTable, cubeTitle, decodeLut, effectById, encodeLut,
  evalCurve, extrasFor, halftoneExtras, identityLut, importCube, isCssEffect, keyColour, looksLikeCube, lutTableFor, oklab,
  packUniforms, parseColour, puckHue, puckOffset, recolorActive, recolorExtras, resolveParams, ringRadius, wheelFromPointer,
  type Wheel,
} from '../apps/web/src/effects';
import { curvesTable as oracleCurvesTable, importCube as oracleImportCube, lutTable as oracleLutTable, recolorActive as oracleRecolorActive } from '../parity/oracle/colour';
import { halftoneSetup } from '../parity/oracle/stylize';

// ---- LUT ----------------------------------------------------------------------------------------------------------
const f = (v: number) => v.toFixed(6);
function identityCube(size: number, header = '') {
  const lines: string[] = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++)
    lines.push([r, g, b].map(v => f(v / (size - 1))).join(' '));
  return `${header}LUT_3D_SIZE ${size}\n${lines.join('\n')}\n`;
}
function warmCube(size: number) {
  const lines: string[] = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const x = r / (size - 1), y = g / (size - 1), z = b / (size - 1);
    lines.push([Math.min(1, x * 1.1 + 0.02), y ** 0.9, z * 0.8 + 0.1 * x].map(f).join(' '));
  }
  return `# generated\nLUT_3D_SIZE ${size}\n${lines.join('\r\n')}\r\n`;
}
function oneD(size: number) {
  const lines: string[] = [];
  for (let i = 0; i < size; i++) { const t = i / (size - 1); lines.push([t, t ** 2, Math.sqrt(t)].map(f).join(' ')); }
  return `TITLE "curve 1D"\nLUT_1D_SIZE ${size}\n${lines.join('\n')}\n`;
}
const withDomain = (size: number) => {
  const lines: string[] = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push([-0.5 + r, -0.5 + g * 2, 0.25 + b * 0.5].map(f).join(' '));
  return `DOMAIN_MIN -0.5 -0.5 0.25\nDOMAIN_MAX ${size - 1 - 0.5} ${2 * (size - 1) - 0.5} ${0.25 + (size - 1) * 0.5}\nLUT_3D_SIZE ${size}\n${lines.join('\n')}\n`;
};

describe('LUT', () => {
  it('LUT_BYTES = 33³ × 4 = 143,748', () => { expect(LUT_GRID).toBe(33); expect(LUT_BYTES).toBe(143748); });

  const cubes: [string, string][] = [
    ['identity size 2', identityCube(2)], ['identity size 17', identityCube(17)], ['identity size 33', identityCube(33)],
    ['warm size 5 (CRLF, comment)', warmCube(5)], ['titled size 3', identityCube(3, 'TITLE "Test look"\n')], ['1D size 16', oneD(16)], ['1D size 2', oneD(2)],
    ['DOMAIN_MIN/MAX size 3', withDomain(3)], ['out-of-range values clamp', 'LUT_3D_SIZE 2\n' + Array(8).fill('2 -1 0.5').join('\n') + '\n'],
  ];
  for (const [name, text] of cubes) {
    it(`importCube is byte-equal to the oracle: ${name}`, () => {
      const ours = importCube(text), theirs = oracleImportCube(text);
      expect(ours).toHaveLength(LUT_BYTES);
      expect(Buffer.from(ours).equals(Buffer.from(theirs))).toBe(true);
    });
  }

  it('an identity 33 cube maps r,g,b to round(code·255/32) with alpha 255 and red-fastest order', () => {
    const t = importCube(identityCube(33));
    const at = (r: number, g: number, b: number) => [...t.subarray(((b * 33 + g) * 33 + r) * 4, ((b * 33 + g) * 33 + r) * 4 + 4)];
    expect(at(0, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(32, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(0, 32, 0)).toEqual([0, 255, 0, 255]);
    expect(at(0, 0, 32)).toEqual([0, 0, 255, 255]);
    expect(at(16, 8, 4)).toEqual([Math.round(16 * 255 / 32), Math.round(8 * 255 / 32), Math.round(4 * 255 / 32), 255]);
  });

  it('importCube errors match the oracle (messages)', () => {
    const bads = ['', 'LUT_3D_SIZE 2\n0 0 0\n', '0 0 0\nLUT_3D_SIZE 2\n', 'LUT_3D_SIZE 1\n', 'LUT_3D_SIZE 130\n', 'LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n',
      'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0\n', 'LUT_1D_SIZE 2\n0 0\n1 1 1\n', 'LUT_1D_SIZE 2\n0 0 x\n1 1 1\n'];
    for (const text of bads) {
      let a = '', b = '';
      try { importCube(text); } catch (e) { a = (e as Error).message; }
      try { oracleImportCube(text); } catch (e) { b = (e as Error).message; }
      expect(a, JSON.stringify(text)).not.toBe('');
      expect(a).toBe(b);
    }
  });

  it('cubeTitle and looksLikeCube', () => {
    expect(cubeTitle('TITLE "Hello world"\nLUT_3D_SIZE 2')).toBe('Hello world');
    expect(cubeTitle('TITLE Plain\nLUT_3D_SIZE 2')).toBe('Plain');
    expect(cubeTitle('LUT_3D_SIZE 2')).toBeUndefined();
    expect(looksLikeCube('# x\nLUT_3D_SIZE 2\n')).toBe(true);
    expect(looksLikeCube('LUT_1D_SIZE 2\n')).toBe(true);
    expect(looksLikeCube('QUJD')).toBe(false);
  });

  it('encodeLut/decodeLut base64 round-trip; wrong length or bad base64 → undefined', () => {
    const t = importCube(warmCube(4)), s = encodeLut(t);
    expect(s).toHaveLength(191664);
    expect(Buffer.from(decodeLut(s)!).equals(Buffer.from(t))).toBe(true);
    expect(encodeLut(decodeLut(s)!)).toBe(s);
    expect(decodeLut('')).toBeUndefined();
    expect(decodeLut('!!!')).toBeUndefined();
    expect(decodeLut(btoa('abc'))).toBeUndefined();
  });

  it('lutTableFor: valid base64 decodes; missing, wrong type, empty or unreadable falls back to the identity table (= oracle lutTable)', () => {
    const t = importCube(warmCube(4)), s = encodeLut(t);
    expect(Buffer.from(lutTableFor(s)).equals(Buffer.from(t))).toBe(true);
    expect(Buffer.from(oracleLutTable(s)).equals(Buffer.from(t))).toBe(true);
    for (const bad of [undefined, null, 5, '', 'garbage', btoa('short')]) {
      expect(Buffer.from(lutTableFor(bad)).equals(Buffer.from(identityLut())), String(bad)).toBe(true);
      expect(Buffer.from(identityLut()).equals(Buffer.from(oracleLutTable(bad as never)))).toBe(true);
    }
  });
});

// ---- Curves -------------------------------------------------------------------------------------------------------
describe('curvesTable vs the oracle (byte-equal)', () => {
  const sets: [string, Record<string, unknown>][] = [
    ['defaults', {}],
    ['master S-curve', { masterShadowY: 0.15, masterHighlightY: 0.85 }],
    ['master with mid point', { masterMidOn: true, masterMidX: 0.5, masterMidY: 0.6 }],
    ['red lifted, blue crushed', { redBlackY: 0.1, redShadowY: 0.4, blueWhiteY: 0.8, blueHighlightY: 0.6 }],
    ['crossed shadow/highlight x (swap)', { greenShadowX: 0.8, greenHighlightX: 0.3 }],
    ['points closer than 0.04', { masterShadowX: 0.5, masterHighlightX: 0.51, masterMidOn: true }],
    ['non-monotone', { masterShadowY: 0.9, masterHighlightY: 0.1, redShadowY: 0.0, redHighlightY: 1 }],
    ['extreme', { masterBlackY: 1, masterWhiteY: 0, masterShadowX: 0.02, masterHighlightX: 0.98 }],
  ];
  for (const [name, p] of sets) {
    it(name, () => {
      const ours = curvesTable({ ...resolveParams('curves', {}), ...p } as never), theirs = oracleCurvesTable({ ...resolveParams('curves', {}), ...p });
      expect(ours).toHaveLength(1024);
      for (let i = 0; i < 256; i++) {
        expect([ours[i * 4], ours[i * 4 + 1], ours[i * 4 + 2], ours[i * 4 + 3]], `entry ${i}`).toEqual([...theirs[i], 255]);
      }
    });
  }
  it('evalCurve edges: x ≤ 0 → first y, x ≥ 1 → last y, interpolates through the points', () => {
    const pts: [number, number][] = [[0, 0.2], [0.5, 0.5], [1, 0.9]];
    expect(evalCurve(pts, -1)).toBe(0.2);
    expect(evalCurve(pts, 2)).toBe(0.9);
    expect(evalCurve(pts, 0.5)).toBeCloseTo(0.5, 9);
  });
});

// ---- CSS ----------------------------------------------------------------------------------------------------------
describe('CSS effects', () => {
  it('isCssEffect', () => {
    for (const id of ['invert', 'gaussian-blur', 'drop-shadow']) expect(isCssEffect(id)).toBe(true);
    expect(isCssEffect('glow')).toBe(false);
    expect(isCssEffect('nope')).toBe(false);
  });

  it('invert: amount → invert(n%), clamped to 0–100, 0 adds nothing', () => {
    expect(cssFilterFor('invert', {})).toEqual({ effectId: 'invert', filter: 'invert(100%)', reach: 0 });
    expect(cssFilterFor('invert', { amount: 40 })?.filter).toBe('invert(40%)');
    expect(cssFilterFor('invert', { amount: 250 })?.filter).toBe('invert(100%)');
    expect(cssFilterFor('invert', { amount: 0 })).toBeNull();
    expect(cssFilterFor('invert', { amount: NaN })?.filter).toBe('invert(100%)');
  });

  it('gaussian-blur: radius → blur(npx) with reach ⌈3σ⌉; default radius 0 adds nothing', () => {
    expect(cssFilterFor('gaussian-blur', {})).toBeNull();
    expect(cssFilterFor('gaussian-blur', { radius: 2.5 })).toEqual({ effectId: 'gaussian-blur', filter: 'blur(2.5px)', reach: 8 });
    expect(cssFilterFor('gaussian-blur', { radius: 10 })).toMatchObject({ filter: 'blur(10px)', reach: 30 });
  });

  it('drop-shadow: always added; rgba colour text from the hex param; reach = max(|x|,|y|) + 1 + ⌈3·blur⌉', () => {
    expect(cssFilterFor('drop-shadow', {})).toEqual({ effectId: 'drop-shadow', filter: 'drop-shadow(4px 4px 4px rgba(0, 0, 0, 0.5))', reach: 4 + 1 + 12 });
    expect(cssFilterFor('drop-shadow', { x: -10, y: 3, blur: 0, color: '#ff0000' })).toEqual({ effectId: 'drop-shadow', filter: 'drop-shadow(-10px 3px 0px rgba(255, 0, 0, 1))', reach: 11 });
    expect(cssFilterFor('drop-shadow', { x: 0, y: 0, blur: 0 })?.filter).toBe('drop-shadow(0px 0px 0px rgba(0, 0, 0, 0.5))');
    expect(cssFilterFor('drop-shadow', { color: '#00ff0080' })?.filter).toContain('rgba(0, 255, 0, 0.501961)');
  });

  it('cssFilterFor on a non-CSS effect throws', () => {
    expect(() => cssFilterFor('glow')).toThrow('not a CSS-rendered effect');
  });

  it('cssChain: stack order kept, disabled and no-op entries and WebGL effects skipped; cssFilterString joins with spaces, empty = none', () => {
    const stack = [
      { effectId: 'drop-shadow', params: { x: 1, y: 2, blur: 3 } }, { effectId: 'glow' }, { effectId: 'invert', params: { amount: 50 } },
      { effectId: 'gaussian-blur', params: { radius: 4 }, enabled: false }, { effectId: 'gaussian-blur', params: { radius: 0 } },
      { effectId: 'gaussian-blur', params: { radius: 2 }, enabled: true },
    ];
    const chain = cssChain(stack);
    expect(chain.map(c => c.effectId)).toEqual(['drop-shadow', 'invert', 'gaussian-blur']);
    expect(cssFilterString(chain)).toBe('drop-shadow(1px 2px 3px rgba(0, 0, 0, 0.5)) invert(50%) blur(2px)');
    expect(cssFilterString([])).toBe('none');
    expect(cssChain([])).toEqual([]);
    expect(cssChain([{ effectId: 'invert', enabled: false }])).toEqual([]);
  });
});

// ---- Colour block -------------------------------------------------------------------------------------------------
describe('Colour block maths', () => {
  it('ringRadius = size/2 − 2', () => { expect(ringRadius(200)).toBe(98); expect(ringRadius(100)).toBe(48); });

  it('wheelFromPointer: right = 0°, up = 90° (counter-clockwise), whole degrees in 0…359', () => {
    expect(wheelFromPointer(50, 0, 200)).toMatchObject({ angle: 0 });
    expect(wheelFromPointer(0, -50, 200)).toMatchObject({ angle: 90 });
    expect(wheelFromPointer(-50, 0, 200)).toMatchObject({ angle: 180 });
    expect(wheelFromPointer(0, 50, 200)).toMatchObject({ angle: 270 });
    expect(wheelFromPointer(0, 0, 200)).toEqual({ angle: 0, distance: 0 });
    const w = wheelFromPointer(30.4, -20.2, 200);
    expect(Number.isInteger(w.angle) && w.angle >= 0 && w.angle < 360).toBe(true);
  });

  it('distance = r / (0.7·ring) to 0.01, capped at 1', () => {
    const r = 0.7 * ringRadius(200);
    expect(wheelFromPointer(r / 2, 0, 200).distance).toBe(0.5);
    expect(wheelFromPointer(r, 0, 200).distance).toBe(1);
    expect(wheelFromPointer(500, 0, 200).distance).toBe(1);
    expect(wheelFromPointer(r * 0.337, 0, 200).distance).toBe(0.34);
  });

  it('puckOffset is the inverse of wheelFromPointer for wheel values on the 0.01 / 1° grid', () => {
    for (const size of [120, 200, 241]) for (let angle = 0; angle < 360; angle += 17) for (let d = 10; d <= 100; d += 15) {
      const w: Wheel = { angle, distance: d / 100 };
      const { dx, dyDown } = puckOffset(w, size);
      expect(wheelFromPointer(dx, dyDown, size), `${size} ${angle} ${d}`).toEqual(w);
    }
    expect(puckOffset({ angle: 0, distance: 1 }, 200).dx).toBeCloseTo(0.7 * 98, 9);
    const up = puckOffset({ angle: 90, distance: 1 }, 200);
    expect(up.dx).toBeCloseTo(0, 9);
    expect(up.dyDown).toBeCloseTo(-0.7 * 98, 9);
    expect(puckOffset({ angle: 0, distance: 3 }, 200).dx).toBeCloseTo(0.7 * 98, 9);
    expect(puckOffset({ angle: 0, distance: -1 }, 200).dx).toBeCloseTo(0, 9);
  });

  it('puckHue = (360 − angle) mod 360', () => {
    expect(puckHue({ angle: 0, distance: 1 })).toBe(0);
    expect(puckHue({ angle: 90, distance: 1 })).toBe(270);
    expect(puckHue({ angle: 270, distance: 1 })).toBe(90);
    expect(puckHue({ angle: 360, distance: 1 })).toBe(0);
    expect(puckHue({ angle: -90, distance: 1 })).toBe(90);
    expect(puckHue({ angle: 1, distance: 1 })).toBe(359);
  });

  it('blockInstances: first instance of each block effect, -1 when absent', () => {
    expect(COLOUR_BLOCK_EFFECTS).toEqual(['color-wheels', 'curves', 'lut']);
    expect(blockInstances([])).toEqual({ 'color-wheels': -1, curves: -1, lut: -1 });
    expect(blockInstances([{ effectId: 'glow' }, { effectId: 'curves' }, { effectId: 'color-wheels' }, { effectId: 'curves' }, { effectId: 'color-wheels' }]))
      .toEqual({ 'color-wheels': 2, curves: 1, lut: -1 });
  });

  it('block constants name real color-wheels parameters; neutral wheel is {0,0}', () => {
    const keys = new Set(effectById('color-wheels')!.params.map(p => p.key));
    for (const k of [...BASIC_SLIDERS.map(s => s.key), ...Object.values(ADVANCED_GROUPS).flat()]) expect(keys.has(k), k).toBe(true);
    expect(BASIC_SLIDERS.find(s => s.label === 'Vibrance')!.key).toBe('colorBoost');
    expect(NEUTRAL_WHEEL).toEqual({ angle: 0, distance: 0 });
  });
});

// ---- Colour helpers -----------------------------------------------------------------------------------------------
describe('colour helpers', () => {
  it('parseColour: hex forms, rgb()/rgba(), fallback', () => {
    expect(parseColour('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseColour('#f008')).toEqual([1, 0, 0, 0x88 / 255]);
    expect(parseColour('00ff00')).toEqual([0, 1, 0, 1]);
    expect(parseColour('#ff000080')[3]).toBeCloseTo(128 / 255, 9);
    expect(parseColour('rgba(255, 0, 51, 0.25)')).toEqual([1, 0, 0.2, 0.25]);
    expect(parseColour('rgb(0,0,255)')).toEqual([0, 0, 1, 1]);
    expect(parseColour('nonsense')).toEqual([0, 0, 0, 1]);
    expect(parseColour(5, '#ffffff')).toEqual([1, 1, 1, 1]);
  });
  it('keyColour: rgb()/#rgb/#rrggbb accepted, #rgba / #rrggbbaa / bare hex → Xapp green', () => {
    const green = [0, 177 / 255, 64 / 255];
    expect(keyColour('#ff0000')).toEqual([1, 0, 0]);
    expect(keyColour('rgba(0,255,0,0.1)')).toEqual([0, 1, 0]);
    for (const v of ['#ff000080', '#f008', 'ff0000', 5, undefined]) expect(keyColour(v)).toEqual(green);
  });
  it('bt709Table: 256 entries, monotone, endpoints 0 and 255', () => {
    const t = bt709Table();
    expect(t).toHaveLength(256);
    expect([t[0], t[255]]).toEqual([0, 255]);
    for (let i = 1; i < 256; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
  });
  it('oklab: black → 0, white → L 1 with ~0 chroma', () => {
    expect(oklab([0, 0, 0])).toEqual([0, 0, 0]);
    const w = oklab([1, 1, 1]);
    expect(w[0]).toBeCloseTo(1, 4); expect(Math.hypot(w[1], w[2])).toBeLessThan(1e-4);
  });
});

// ---- Uniforms -----------------------------------------------------------------------------------------------------
describe('packUniforms', () => {
  const frame = { width: 1080, height: 1920, timeS: 1.5, seed: 321.25, final: true };
  it('frame slots: W,H,T,SEED,AW,AH,FINAL,SW at 0..7; aux size defaults to 1×1; SW defaults to W', () => {
    const u = packUniforms(undefined, {}, frame);
    expect(u).toHaveLength(256);
    expect([...u.subarray(0, 8)]).toEqual([1080, 1920, 1.5, 321.25, 1, 1, 1, 1080]);
    expect(u.subarray(8).every(v => v === 0)).toBe(true);
    const a = packUniforms(undefined, {}, { ...frame, final: false, sourceWidth: 2160 }, [], { width: 256, height: 1, data: new Uint8Array(1024) });
    expect([...a.subarray(0, 8)]).toEqual([1080, 1920, 1.5, 321.25, 256, 1, 0, 2160]);
  });

  it('numbers from slot 8 in definition order; booleans 0/1; selects = option index', () => {
    const lv = effectById('levels')!, u = packUniforms(lv, resolveParams('levels', { gamma: 2.5, inputBlack: 10 }), frame);
    expect([...u.subarray(8, 13)]).toEqual([10, 100, 2.5, 0, 100]);
    const mir = packUniforms(effectById('mirror')!, { horizontal: false, vertical: true }, frame);
    expect([mir[8], mir[9]]).toEqual([0, 1]);
    const dith = effectById('dither')!, vals = resolveParams('dither', { pattern: 'crosses', mode: 'radial', style: 'scaled', shape: 'diamond', palette: 'sepia' });
    const d = packUniforms(dith, vals, frame);
    expect([...d.subarray(8, 13)]).toEqual([5, 2, 1, 2, 3]);
  });

  it('colour wheels take two slots (angle, distance); colours take four floats (straight RGBA 0…1)', () => {
    const cw = effectById('color-wheels')!, v = resolveParams('color-wheels', { shadowsWheel: { angle: 30, distance: 0.5 }, offsetWheel: { angle: 200, distance: 1 } });
    const u = packUniforms(cw, v, frame);
    expect([...u.subarray(8, 16)]).toEqual([30, 0.5, 0, 0, 0, 0, 200, 1]);
    const ht = effectById('halftone')!, h = packUniforms(ht, resolveParams('halftone', { colorFront: '#ff0000', colorBack: '#00ff0080' }), frame);
    expect([...h.subarray(8, 12)]).toEqual([1, 0, 0, 1]);
    expect(h[12]).toBe(0); expect(h[13]).toBe(1); expect(h[14]).toBe(0); expect(h[15]).toBeCloseTo(128 / 255, 6);
    const ck = packUniforms(effectById('color-key')!, resolveParams('color-key', { keyColor: '#ff000080' }), frame);
    expect([...ck.subarray(8, 12)]).toEqual([0, Math.fround(177 / 255), Math.fround(64 / 255), 1]);
    const ck2 = packUniforms(effectById('color-key')!, resolveParams('color-key', { keyColor: '#0000ff' }), frame);
    expect([...ck2.subarray(8, 12)]).toEqual([0, 0, 1, 1]);
  });

  it('per-frame extras are written at slot 128', () => {
    const u = packUniforms(effectById('dither')!, resolveParams('dither', {}), frame, [7, 8, 9]);
    expect([...u.subarray(128, 131)]).toEqual([7, 8, 9]);
    expect(u[127]).toBe(0); expect(u[131]).toBe(0);
    expect(() => packUniforms(undefined, {}, frame, new Array(129).fill(1))).toThrow('too many extra uniforms');
    expect(() => packUniforms(undefined, {}, frame, new Array(128).fill(1))).not.toThrow();
  });

  it('every effect packs its defaults without error and puts each parameter at its registered slot', () => {
    for (const e of EFFECTS.filter(x => x.renderType === 'webgl')) {
      const v = resolveParams(e.id, {}), u = packUniforms(e, v, frame);
      for (const s of e.uniforms) {
        const p = e.params.find(q => q.key === s.key)!;
        if (p.type === 'number') expect(u[s.slot], `${e.id}.${s.key}`).toBe(Math.fround(p.default));
      }
    }
  });
});

describe('dither extras', () => {
  it('palette: count then RGB as 4-decimal fractions of the 8-bit codes', () => {
    const bw = extrasFor('dither', { palette: 'bw' }, 10, 10);
    expect(bw).toEqual([2, 0, 0, 0, 1, 1, 1]);
    const gb = extrasFor('dither', { palette: 'gameboy' }, 10, 10);
    expect(gb[0]).toBe(4);
    expect(gb.slice(1, 4)).toEqual([Math.round(0x0f / 255 * 1e4) / 1e4, Math.round(0x38 / 255 * 1e4) / 1e4, Math.round(0x0f / 255 * 1e4) / 1e4]);
    expect(extrasFor('dither', { palette: 'cga' }, 10, 10)[0]).toBe(4);
    expect(extrasFor('dither', { palette: 'sepia' }, 10, 10)).toHaveLength(13);
    expect(extrasFor('dither', { palette: 'unknown' }, 10, 10)).toEqual(gb);
    expect(extrasFor('glow', {}, 10, 10)).toEqual([]);
  });
});

describe('halftoneExtras vs the oracle halftoneSetup', () => {
  const sizes: [number, number][] = [[1080, 1920], [270, 480], [48, 32], [256, 192], [640, 360]];
  const variants: Record<string, unknown>[] = [
    {}, { size: 0 }, { size: 100 }, { size: 20, radius: 60 }, { contrast: 0 }, { contrast: 100, radius: 200 },
    ...(['classic', 'gooey', 'holes', 'soft'] as const).flatMap(type => (['hex', 'square'] as const).flatMap(grid =>
      [{ type, grid }, { type, grid, originalColors: true, contrast: 70, radius: 40 }])),
  ];
  for (const [W, H] of sizes) {
    it(`${W}×${H}: all variants`, () => {
      for (const p of variants) {
        const values = resolveParams('halftone', p), o = halftoneSetup(W, H, values), e = halftoneExtras(values, W, H);
        expect(e, JSON.stringify(p)).toEqual([o.N, +o.hex, o.type, o.w, o.h, o.kappa, o.b, +o.original]);
      }
    });
  }
  it('extrasFor routes halftone', () => {
    const v = resolveParams('halftone', {});
    expect(extrasFor('halftone', v, 100, 50)).toEqual(halftoneExtras(v, 100, 50));
  });
});

describe('recolor', () => {
  const same = { palette: [{ base: '#336699', kind: 'color' }], colors: ['#336699'] };
  const el = {
    palette: [{ base: '#c0392b', kind: 'color' }, { base: '#2c3e50', kind: 'neutral' }], colors: ['#27ae60', '#2c3e50'],
  };
  const oracleParams = (e: typeof el) => e;

  it('recolorActive matches the oracle', () => {
    const cases = [
      same, el, { palette: [{ base: '#336699', kind: 'color' }], colors: ['#336698'] }, { palette: [{ base: '#336699', kind: 'color' }], colors: [] },
      { palette: [], colors: [] }, { palette: [{ base: '#000000', kind: 'color' }, { base: '#ffffff', kind: 'color' }], colors: ['#000000', '#fefefe'] },
      { palette: [{ base: '#000', kind: 'color' }, { base: '#fff', kind: 'color' }, { base: '#f00', kind: 'color' }], colors: ['#000', '#fff', '#00f'] },
      { palette: [{ base: '#336699', kind: 'color' }], colors: ['#336699ff'] },
    ];
    for (const c of cases) expect(recolorActive(c), JSON.stringify(c)).toBe(oracleRecolorActive(oracleParams(c as never)));
    expect(recolorActive(undefined)).toBe(false);
    expect(recolorActive(el)).toBe(true);
    expect(recolorActive(same)).toBe(false);
  });

  it('recolorExtras layout: count, active, band defaults, per-entry OKLab data at 8 + 16i', () => {
    const e = recolorExtras(el);
    expect(e).toHaveLength(40);
    expect(e.slice(0, 6)).toEqual([2, 1, 0.025, 0.07, 2, 3]);
    expect(e[8]).toBe(1); expect(e[24]).toBe(0);
    const base = oklab(parseColour('#c0392b').slice(0, 3) as never), goal = oklab(parseColour('#27ae60').slice(0, 3) as never);
    expect(e.slice(9, 12)).toEqual(base); expect(e.slice(12, 15)).toEqual(goal);
    expect(e[15]).toBeCloseTo(Math.atan2(base[2], base[1]), 12);
    expect(recolorExtras(undefined).slice(0, 2)).toEqual([0, 0]);
    expect(recolorExtras({ ...el, bands: { chromaLo: 0.1 } })[2]).toBe(0.1);
    expect(recolorExtras({ ...el, glossHi: 4 })[5]).toBe(4);
  });
});

describe('internal consistency', () => {
  it('the WebGL effect list the renderer can run equals the registry (no CSS entries have extras)', () => {
    for (const e of EFFECTS.filter(x => x.renderType === 'css')) expect(e.uniforms).toEqual([]);
  });
});
