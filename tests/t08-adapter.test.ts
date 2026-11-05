// SPDX-License-Identifier: AGPL-3.0-only
// T08 parity adapter: snapshot Vite server (no watcher, no HMR), compact Float64 frames, one navigation retry, and the runner.
// Needs real Vite and Chromium; run from the repository root (the adapter serves root 'apps/web').
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MotionGraphicParityAdapter } from '../apps/web/src/mg/adapter';

const fill = (color: string) => `export const Graphic = () => <AbsoluteFill style={{backgroundColor:'${color}'}} />;`;
const project = { width: 64, height: 48, fps: 30, graphics: [
  { id: 'red', code: fill('#ff0000'), startMs: 0, durationMs: 1000 },
  { id: 'gray', code: fill('#808080'), startMs: 1000, durationMs: 1000 },
] };

describe('MotionGraphicParityAdapter (real Vite and Chromium)', () => {
  const adapter = new MotionGraphicParityAdapter() as any;
  let loads = 0;
  beforeAll(async () => { await adapter.open(project); adapter.page.on('load', () => { loads++; }); }, 60_000);
  afterAll(async () => { await adapter.close(); }, 60_000);

  it('serves a fixed snapshot: no file watcher and no HMR', () => {
    expect(adapter.server.config.server.watch).toBeNull();
    expect(adapter.server.config.server.hmr).toBe(false);
  });

  it('frame() returns a Float64Array of byte/255 with one RGBA entry per pixel (solid #ff0000, 64x48)', async () => {
    const frame = await adapter.frame(0);
    expect([frame.width, frame.height]).toEqual([64, 48]);
    expect(ArrayBuffer.isView(frame.rgba)).toBe(true);
    expect(frame.rgba).toBeInstanceOf(Float64Array);
    expect(frame.rgba.length).toBe(64 * 48 * 4);
    for (let i = 0; i < frame.rgba.length; i += 4) {
      if (frame.rgba[i] !== 1 || frame.rgba[i + 1] !== 0 || frame.rgba[i + 2] !== 0 || frame.rgba[i + 3] !== 1) {
        throw new Error(`pixel ${i / 4} is [${Array.from(frame.rgba.slice(i, i + 4))}], expected [1,0,0,1]`);
      }
    }
  }, 60_000);

  it('values are byte/255: #808080 gives 128/255 on every colour channel and alpha 1', async () => {
    const frame = await adapter.frame(1000);
    expect(frame.rgba.length).toBe(64 * 48 * 4);
    for (let i = 0; i < frame.rgba.length; i += 4) {
      for (let c = 0; c < 3; c++) if (Math.abs(frame.rgba[i + c] - 128 / 255) > 1e-9) throw new Error(`pixel ${i / 4} channel ${c} is ${frame.rgba[i + c]}`);
      if (frame.rgba[i + 3] !== 1) throw new Error(`pixel ${i / 4} alpha is ${frame.rgba[i + 3]}`);
    }
  }, 60_000);

  it('a navigation under an evaluate is retried once after re-navigating (reload on the first attempt only)', async () => {
    const before = loads;
    const result = await adapter.evaluate(async () => {
      if (!sessionStorage.getItem('t08-adapter-retry')) { sessionStorage.setItem('t08-adapter-retry', '1'); location.reload(); await new Promise(() => {}); }
      sessionStorage.removeItem('t08-adapter-retry');
      return 'ok';
    }, null);
    expect(result).toBe('ok');
    expect(loads).toBeGreaterThan(before);
    expect(await adapter.page.evaluate(() => !!(window as any).mg)).toBe(true);
    const frame = await adapter.frame(0);
    expect(frame.rgba.length).toBe(64 * 48 * 4);
    expect(frame.rgba[0]).toBe(1);
  }, 60_000);

  it('a reload on every attempt is retried only once, then rejects; a later frame() still works with window.mg present', async () => {
    await adapter.page.evaluate(() => sessionStorage.setItem('t08-adapter-attempts', '0'));
    await expect(adapter.evaluate(async () => {
      sessionStorage.setItem('t08-adapter-attempts', String(Number(sessionStorage.getItem('t08-adapter-attempts')) + 1));
      location.reload(); await new Promise(() => {});
    }, null)).rejects.toThrow(/Execution context was destroyed/);
    await adapter.page.waitForFunction(() => !!(window as any).mg);
    // Exactly one retry: two attempts in all.
    expect(await adapter.page.evaluate(() => sessionStorage.getItem('t08-adapter-attempts'))).toBe('2');
    await adapter.page.evaluate(() => sessionStorage.removeItem('t08-adapter-attempts'));
    expect(await adapter.page.evaluate(() => !!(window as any).mg)).toBe(true);
    const frame = await adapter.frame(1000);
    expect(frame.rgba.length).toBe(64 * 48 * 4);
    expect(frame.rgba[0]).toBeCloseTo(128 / 255, 9);
  }, 60_000);

  it('a non-navigation error is rethrown as is and causes no re-navigation', async () => {
    const before = loads;
    await expect(adapter.evaluate(async () => { throw new Error('boom'); }, null)).rejects.toThrow('boom');
    expect(loads - before).toBe(0);
  }, 60_000);

  // FU-m1: frame() renders through mg/errors.ts renderAgain, the rule mg/frames.ts graphicPicture uses, so one load
  // timeout costs an attempt and not a whole run part. The page's renderer is stubbed to fail a set number of times.
  const stub = (failures: number, code: string) => adapter.page.evaluate(({ failures, code }: { failures: number; code: string }) => {
    const w = window as any, real = w.__mgReal ?? (w.__mgReal = w.mg.renderMotionGraphic);
    w.__mgCalls = 0;
    w.mg.renderMotionGraphic = async (options: unknown, resolve: unknown) => {
      if (++w.__mgCalls <= failures) { const error = Error(`stub ${code}`) as Error & { code: string }; error.code = code; throw error; }
      return real(options, resolve);
    };
  }, { failures, code });
  const calls = () => adapter.page.evaluate(() => (window as any).__mgCalls);
  const unstub = () => adapter.page.evaluate(() => { const w = window as any; w.mg.renderMotionGraphic = w.__mgReal; });

  it('frame(): a render that fails with a retryable code is asked once more and the frame draws', async () => {
    await stub(1, 'MG_RENDER_FAILED');
    try { expect((await adapter.frame(0)).rgba[0]).toBe(1); } finally { await unstub(); }
    expect(await calls()).toBe(2);
  }, 60_000);

  it('frame(): a second failure is not asked again — two attempts, then the error', async () => {
    await stub(2, 'MG_RENDER_FAILED');
    try { await expect(adapter.frame(0)).rejects.toThrow(/stub MG_RENDER_FAILED/); } finally { await unstub(); }
    expect(await calls()).toBe(2);
  }, 60_000);

  it('frame(): a static failure (COMPILATION_ERROR) fails at once — one attempt', async () => {
    await stub(1, 'COMPILATION_ERROR');
    try { await expect(adapter.frame(0)).rejects.toThrow(/stub COMPILATION_ERROR/); } finally { await unstub(); }
    expect(await calls()).toBe(1);
  }, 60_000);
});

describe('MotionGraphicParityAdapter full-size frame', () => {
  const adapter = new MotionGraphicParityAdapter() as any;
  beforeAll(async () => { await adapter.open({ width: 1080, height: 1920, fps: 30, graphics: [{ id: 'green', code: fill('#00ff00'), startMs: 0, durationMs: 1000 }] }); }, 60_000);
  afterAll(async () => { await adapter.close(); }, 60_000);

  it('a 1080x1920 solid #00ff00 frame has the full length and [0,1,0,1] at the first, middle and last pixel', async () => {
    const started = performance.now();
    const frame = await adapter.frame(0);
    console.log(`t08-adapter: 1080x1920 frame() took ${Math.round(performance.now() - started)} ms`);
    expect([frame.width, frame.height]).toEqual([1080, 1920]);
    expect(frame.rgba.length).toBe(1080 * 1920 * 4);
    for (const pixel of [0, 540 * 1920 + 540, 1080 * 1920 - 1]) expect(Array.from(frame.rgba.slice(pixel * 4, pixel * 4 + 4)), `pixel ${pixel}`).toEqual([0, 1, 0, 1]);
  }, 120_000);
});

describe('parity runner', () => {
  it('npm run parity accepts the adapter frames for the example scenario (exit 0)', () => {
    const output = mkdtempSync(join(tmpdir(), 'cutframe-t08-parity-'));
    try {
      const run = spawnSync('npm', ['run', 'parity', '--', '--sequence', 'apps/web/src/mg/example-scenario.json', '--adapter', 'apps/web/src/mg/adapter.ts', '--no-provider', '--output', output], { encoding: 'utf8', shell: true, timeout: 150_000 });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    } finally { rmSync(output, { recursive: true, force: true }); }
  }, 180_000);
});
