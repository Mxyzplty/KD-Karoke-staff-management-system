// SPDX-License-Identifier: AGPL-3.0-only
// T10a renderer orchestration against a FAKE Backend (no GPU): pass order, release discipline, final flag, CSS split,
// transport stages.
import { describe, expect, it } from 'vitest';
import { createRenderer, gpuSteps, quantise, resolveParams, type Backend, type Frame, type PassSpec } from '../apps/web/src/effects';

interface Log { passes: PassSpec[]; released: Frame[]; uploads: number; disposed: boolean; inputs: Frame[] }

function fakeBackend(): { backend: Backend; log: Log } {
  const log: Log = { passes: [], released: [], uploads: 0, disposed: false, inputs: [] };
  let n = 0;
  const mk = (width: number, height: number, format: Frame['format']): Frame => ({ width, height, format, texture: `tex${n++}` });
  const backend: Backend = {
    kind: 'webgl2',
    upload: s => { log.uploads++; return mk((s as { width: number }).width, (s as { height: number }).height, 'rgba8'); },
    pass: (input, spec) => { log.passes.push(spec); log.inputs.push(input); return mk(spec.width, spec.height, spec.final ? 'rgba8' : 'rgba16f'); },
    read: async () => new Uint8Array(0),
    release: f => { log.released.push(f); },
    dispose: () => { log.disposed = true; },
  };
  return { backend, log };
}
const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8Array(w * h * 4) });
const FINAL = 6; // FRAME_SLOTS.FINAL

describe('gpuSteps', () => {
  const ids = (stack: Parameters<typeof gpuSteps>[0], ctx?: Parameters<typeof gpuSteps>[1]) => gpuSteps(stack, ctx).map(s => s.effect.id);

  it('keeps stack order; disabled entries skipped; enabled:undefined counts as enabled', () => {
    expect(ids([{ effectId: 'glow' }, { effectId: 'sharpen', enabled: false }, { effectId: 'levels', enabled: true }, { effectId: 'mirror' }]))
      .toEqual(['glow', 'levels', 'mirror']);
  });

  it('`order` sorts; entries without `order` use their stack position; ties keep stack order', () => {
    expect(ids([{ effectId: 'glow', order: 2 }, { effectId: 'sharpen', order: 0 }, { effectId: 'levels', order: 1 }])).toEqual(['sharpen', 'levels', 'glow']);
    expect(ids([{ effectId: 'glow' }, { effectId: 'sharpen', order: -1 }, { effectId: 'levels' }])).toEqual(['sharpen', 'glow', 'levels']);
    expect(ids([{ effectId: 'glow', order: 5 }, { effectId: 'sharpen', order: 5 }, { effectId: 'levels', order: 5 }])).toEqual(['glow', 'sharpen', 'levels']);
  });

  it('CSS effects and unknown ids never become GPU steps', () => {
    expect(ids([{ effectId: 'invert' }, { effectId: 'gaussian-blur' }, { effectId: 'drop-shadow' }, { effectId: 'nope' }, { effectId: 'glow' }])).toEqual(['glow']);
  });

  it('a `recolor` stack entry is ignored (only the element drives it)', () => {
    expect(ids([{ effectId: 'recolor' }, { effectId: 'glow' }])).toEqual(['glow']);
  });

  it('recolor goes first when the element asks for it, before every stack entry', () => {
    const element = { palette: [{ base: '#336699', kind: 'color' }], colors: ['#993333'] };
    expect(ids([{ effectId: 'glow', order: -10 }, { effectId: 'sharpen' }], { element })).toEqual(['recolor', 'glow', 'sharpen']);
    expect(ids([], { element })).toEqual(['recolor']);
    expect(ids([{ effectId: 'glow' }], { element: { palette: [{ base: '#336699', kind: 'color' }], colors: ['#336699'] } })).toEqual(['glow']);
  });

  it('bg-removal is dropped without a mask, kept with one', () => {
    const stack = [{ effectId: 'glow' }, { effectId: 'bg-removal' }];
    expect(ids(stack)).toEqual(['glow']);
    expect(ids(stack, { mask: px(2, 2) })).toEqual(['glow', 'bg-removal']);
  });

  it('values are resolved (defaults filled for missing keys, given values kept)', () => {
    const [s] = gpuSteps([{ effectId: 'levels', params: { gamma: 2 } }]);
    expect(s.values).toEqual(resolveParams('levels', { gamma: 2 }));
    expect(s.values.gamma).toBe(2);
    expect(s.values.inputWhite).toBe(100);
  });
});

describe('render() with a fake backend', () => {
  it('empty stack → one identity pass, final, no CSS', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(8, 4));
    const out = r.render(input, []);
    expect(log.passes).toHaveLength(1);
    expect(log.passes[0]).toMatchObject({ program: 'identity', width: 8, height: 4, final: true });
    expect(log.passes[0].uniforms[FINAL]).toBe(1);
    expect(out.css).toEqual([]);
    expect(out.frame).not.toBe(input);
    expect(log.released).toEqual([]);
  });

  it('a stack of only CSS effects also renders one identity pass and returns the CSS chain in stack order', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(8, 4));
    const out = r.render(input, [{ effectId: 'invert', params: { amount: 30 } }, { effectId: 'gaussian-blur', params: { radius: 2 } }, { effectId: 'drop-shadow', enabled: false }]);
    expect(log.passes.map(p => p.program)).toEqual(['identity']);
    expect(out.css.map(c => [c.effectId, c.filter])).toEqual([['invert', 'invert(30%)'], ['gaussian-blur', 'blur(2px)']]);
  });

  it('passes run in order with the input of each pass the previous output; first pass reads the caller input', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(16, 9));
    const out = r.render(input, [{ effectId: 'glow' }, { effectId: 'sharpen' }, { effectId: 'levels' }]);
    expect(log.passes.map(p => p.program)).toEqual(['glow', 'sharpen', 'levels']);
    expect(log.inputs[0]).toBe(input);
    expect(log.inputs[1].texture).toBe('tex1');
    expect(log.inputs[2].texture).toBe('tex2');
    expect(out.frame.texture).toBe('tex3');
    expect(log.passes.every(p => p.width === 16 && p.height === 9)).toBe(true);
  });

  it('final flag is set only on the last pass (spec and uniform slot 6)', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(4, 4));
    r.render(input, [{ effectId: 'glow' }, { effectId: 'sharpen' }, { effectId: 'levels' }]);
    expect(log.passes.map(p => p.final)).toEqual([false, false, true]);
    expect(log.passes.map(p => p.uniforms[FINAL])).toEqual([0, 0, 1]);
  });

  it('every intermediate frame is released exactly once; the input and the result never are', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(4, 4));
    const out = r.render(input, [{ effectId: 'glow' }, { effectId: 'sharpen' }, { effectId: 'levels' }, { effectId: 'mirror' }]);
    expect(log.released.map(f => f.texture)).toEqual(['tex1', 'tex2', 'tex3']);
    expect(log.released).not.toContain(input);
    expect(log.released).not.toContain(out.frame);
    // single effect: nothing to release
    const b2 = fakeBackend(), r2 = createRenderer(b2.backend), i2 = r2.upload(px(4, 4));
    r2.render(i2, [{ effectId: 'glow' }]);
    expect(b2.log.released).toEqual([]);
  });

  it('release on the renderer forwards to the backend; dispose too; backend kind is exposed', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), f = r.upload(px(2, 2));
    expect(r.backend).toBe('webgl2');
    r.release(f);
    expect(log.released).toEqual([f]);
    r.dispose();
    expect(log.disposed).toBe(true);
  });

  it('uniform block per pass: frame width/height/time/seed, parameter values from slot 8', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(20, 10));
    r.render(input, [{ effectId: 'levels', params: { gamma: 2 } }], { timeS: 3.5, seed: 77 });
    const u = log.passes[0].uniforms;
    expect([u[0], u[1], u[2], u[3]]).toEqual([20, 10, 3.5, 77]);
    expect(u[10]).toBe(2);
  });

  it('default seed is random per render() call, within [0, 1000)', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(4, 4));
    r.render(input, [{ effectId: 'glitch' }]); r.render(input, [{ effectId: 'glitch' }]);
    const [a, b] = log.passes.map(p => p.uniforms[3]);
    expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(1000);
    expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(1000);
    expect(a).not.toBe(b);
  });

  it('aux tables ride on the pass: curves 256×1, lut 1089×33, bg-removal mask, none for others', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(4, 4));
    const mask = px(6, 3);
    r.render(input, [{ effectId: 'curves' }, { effectId: 'lut' }, { effectId: 'bg-removal' }, { effectId: 'glow' }], { mask });
    const aux = log.passes.map(p => p.aux && [p.aux.width, p.aux.height, p.aux.data.length]);
    expect(aux).toEqual([[256, 1, 1024], [1089, 33, 143748], [6, 3, 72], undefined]);
    expect(log.passes[2].uniforms[4]).toBe(6); expect(log.passes[2].uniforms[5]).toBe(3);
    expect(log.passes[0].uniforms[4]).toBe(256);
  });

  it('extras are per pass at the pass frame size (halftone, dither)', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(40, 30));
    r.render(input, [{ effectId: 'halftone' }, { effectId: 'dither', params: { palette: 'bw' } }]);
    expect(log.passes[0].uniforms[128]).toBeGreaterThan(0); // halftone N
    expect([...log.passes[1].uniforms.subarray(128, 135)]).toEqual([2, 0, 0, 0, 1, 1, 1]);
  });

  it('recolor pass is first and gets element extras; the stack entries follow', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(4, 4));
    const element = { palette: [{ base: '#c0392b', kind: 'color' }], colors: ['#27ae60'] };
    r.render(input, [{ effectId: 'glow' }], { element });
    expect(log.passes.map(p => p.program)).toEqual(['recolor', 'glow']);
    expect(log.passes.map(p => p.final)).toEqual([false, true]);
    expect(log.passes[0].uniforms[128]).toBe(1);   // palette count
    expect(log.passes[0].uniforms[129]).toBe(1);   // active
  });

  it('render does not mutate the stack or its params', () => {
    const { backend } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(4, 4));
    const stack = [{ effectId: 'levels', params: { gamma: 2 }, order: 1 }, { effectId: 'glow', order: 0 }];
    const copy = JSON.stringify(stack);
    r.render(input, stack);
    expect(JSON.stringify(stack)).toBe(copy);
  });

  it('upload and read are forwarded unchanged', async () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend);
    const f = r.upload(px(3, 5));
    expect(log.uploads).toBe(1);
    expect(f).toMatchObject({ width: 3, height: 5, format: 'rgba8' });
    expect(await r.read(f)).toHaveLength(0);
  });
});

describe('runStage with a fake backend', () => {
  it('video-input-709: one final pass at input size, bt709 table as aux (256×1, gray ramp with alpha 255)', () => {
    const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(10, 6));
    const out = r.runStage('video-input-709', input);
    expect(log.passes).toHaveLength(1);
    expect(log.passes[0]).toMatchObject({ program: 'video-input-709', width: 10, height: 6, final: true });
    expect(log.passes[0].aux).toMatchObject({ width: 256, height: 1 });
    const d = log.passes[0].aux!.data;
    expect(d).toHaveLength(1024);
    expect([d[0], d[1], d[2], d[3]]).toEqual([0, 0, 0, 255]);
    expect([d[1020], d[1021], d[1022], d[1023]]).toEqual([255, 255, 255, 255]);
    for (let i = 0; i < 256; i++) expect(d[i * 4] === d[i * 4 + 1] && d[i * 4] === d[i * 4 + 2]).toBe(true);
    expect(out.width).toBe(10);
    expect(log.released).toEqual([]);
  });

  it('stacked-alpha: output width ⌊W/2⌋, SW slot = W, final, same height', () => {
    for (const [w, outW] of [[20, 10], [21, 10], [2, 1], [1, 1]] as const) {
      const { backend, log } = fakeBackend(), r = createRenderer(backend), input = r.upload(px(w, 7));
      const out = r.runStage('stacked-alpha', input);
      expect(out.width).toBe(outW); expect(out.height).toBe(7);
      expect(log.passes[0]).toMatchObject({ program: 'stacked-alpha', width: outW, height: 7, final: true });
      expect(log.passes[0].uniforms[0]).toBe(outW);   // W = output width
      expect(log.passes[0].uniforms[7]).toBe(w);      // SW = source width
      expect(log.passes[0].aux).toBeUndefined();
    }
  });
});

describe('quantise', () => {
  it('clamp + round to nearest', () => {
    const q = quantise(new Float32Array([-1, 0, 0.5, 1, 2, 0.4999, 0.502, 1 / 255, NaN]));
    expect([...q].slice(0, 8)).toEqual([0, 0, 128, 255, 255, 127, 128, 1]);
  });
});
