// SPDX-License-Identifier: AGPL-3.0-only
// T11 integration round: compareOt6Frames (parity/ot6-fade.ts), the per-frame checks of `--ot6-fade` against Xapp's export, on tiny synthetic frames.
// Oracle: the written rule (implementation tickets l.154; QE2): SSIM floor .98 and, where the fixture alpha is >= 0.1, the fitted alpha
// alpha * Σ(theirs · ours) / Σ(ours²) within the ticket's ±0.06; a fixture alpha < 0.1 is not fitted. `ours` is keyed by the offset from frame 165,
// `theirs` by the frame. Frames are 8 x 8 RGBA with one grey per frame, so the fit is exact: ours 100, theirs v gives fitted = alpha * v / 100.
import { describe, expect, it } from 'vitest';
import { OT6_FRAMES, compareOt6Frames, type FadeAlpha } from '../parity/ot6-fade';

const W = 8, H = 8;
const grey = (v: number) => { const d = new Uint8Array(W * H * 4); for (let i = 0; i < d.length; i++) d[i] = i % 4 === 3 ? 255 : v; return d; };
const row = (frame: number, alpha: number): FadeAlpha => ({ frame, p: 0.5, clip: 'speech', alpha, sourceMs: 0 });
// Frame -> the grey of their frame (ours is 100 everywhere). 170 / 171: +0.05 / +0.07 off the fixture alpha .5; 172 / 173: -0.035 / -0.07; 190: alpha .05.
const THEIRS: Record<number, number> = { 170: 110, 171: 114, 172: 93, 173: 86, 190: 255 };
const FADE = [row(170, 0.5), row(171, 0.5), row(172, 0.5), row(173, 0.5), row(190, 0.05)];

describe('compareOt6Frames: the --ot6-fade checks (the ticket\'s ±0.06, l.154)', () => {
  const [first, last] = OT6_FRAMES, frames = Array.from({ length: last - first + 1 }, (_, k) => first + k);
  const ours = new Map(frames.map(f => [f - first, grey(100)]));
  const theirs = new Map(frames.map(f => [f, grey(THEIRS[f] ?? 100)]));
  const r = compareOt6Frames(FADE, ours, theirs, W, H);
  const at = (f: number) => r.rows.find(x => (x as { frame: number }).frame === f) as Record<string, unknown>;

  it('reports the tolerances it used: alphaTolerance 0.06 and minSsim 0.98, and one row per frame 165-194', () => {
    expect(r.alphaTolerance).toBe(0.06);
    expect(r.minSsim).toBe(0.98);
    expect(r.rows.map(x => (x as { frame: number }).frame)).toStrictEqual(frames);
  });
  it('a fitted alpha 0.05 (or -0.035) off the fixture alpha is no alpha failure', () => {
    expect(at(170)).toMatchObject({ alpha: 0.5, fittedAlpha: expect.closeTo(0.55, 12) });
    expect(at(172)).toMatchObject({ alpha: 0.5, fittedAlpha: expect.closeTo(0.465, 12) });
    expect(r.failures.filter(x => (x as { check: string }).check === 'alpha').map(x => (x as { frame: number }).frame)).not.toContain(170);
    expect(r.failures.filter(x => (x as { check: string }).check === 'alpha').map(x => (x as { frame: number }).frame)).not.toContain(172);
  });
  it('0.07 off (either way) is exactly that frame\'s alpha failure, with the fixture alpha expected and the fitted one actual', () => {
    expect(r.failures.filter(x => (x as { check: string }).check === 'alpha')).toStrictEqual([
      { frame: 171, check: 'alpha', expected: 0.5, actual: expect.closeTo(0.57, 12) },
      { frame: 173, check: 'alpha', expected: 0.5, actual: expect.closeTo(0.43, 12) },
    ]);
  });
  it('a fixture alpha below 0.1 is not fitted: no fittedAlpha and no alpha failure, however far their frame is', () => {
    expect(at(190)).toMatchObject({ frame: 190, clip: 'speech', alpha: 0.05 });
    expect(at(190)).not.toHaveProperty('fittedAlpha');
    expect(r.failures).not.toContainEqual(expect.objectContaining({ frame: 190, check: 'alpha' }));
  });
  it('a frame without a fixture row has no alpha, clip or fittedAlpha', () => {
    expect(at(165)).toStrictEqual({ frame: 165, ssim: expect.any(Number) });
  });
});
