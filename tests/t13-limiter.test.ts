// SPDX-License-Identifier: AGPL-3.0-only
// T13 output limiter. Oracle: "written-spec" = findings §7 + agent tool results §10 (G-09): linked stereo peak, −1 dBFS ceiling,
// 5 ms lookahead, 50 ms exponential release in LINEAR gain, no make-up gain. The G-09 table (measured on Xapp's AAC export)
// is reported, not gated, where it depends on the stored fixture's layout (see the comparison tests at the end).
import { describe, it, expect } from 'vitest';
import { Limiter } from '../apps/web/src/audio/limiter';
import { FS, db, noise, peak, rms, maxAbsDiff } from './t13-support';

const CEIL = 10 ** (-1 / 20), LOOK = Math.round(0.005 * FS), TAU = 0.05;
/** Limits whole signals; the buffer carries LOOK frames of lookahead (silence) past the signal. */
function limit(l: ArrayLike<number>, r: ArrayLike<number> = l) {
  const n = l.length, L = new Float32Array(n + LOOK), R = new Float32Array(n + LOOK);
  L.set(l); R.set(r);
  const lim = new Limiter(FS); lim.process(L, R, n);
  return { L: L.slice(0, n), R: R.slice(0, n), lim };
}
const square = (n: number, amp: number, hz = 1000) => Float32Array.from({ length: n }, (_, i) => (Math.floor(2 * hz * i / FS) % 2 === 0 ? amp : -amp));
const tone = (n: number, amp: number, hz = 1000) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / FS));

describe('limiter', () => {
  it('ceiling −1 dBFS is never exceeded (loud noise, boosted bursts, steps)', () => {
    for (const x of [noise(48000, 3).map(v => v * 4), tone(48000, 3), Float32Array.from({ length: 48000 }, (_, i) => (i % 9600 < 480 ? 8 : 0.2) * Math.sin(i * 0.37))]) {
      const { L, R } = limit(x, x.map(v => -v * 0.7));
      expect(peak(L)).toBeLessThanOrEqual(CEIL + 1e-6); expect(peak(R)).toBeLessThanOrEqual(CEIL + 1e-6);
    }
  });
  it('the ceiling is reached, not undershot, on an isolated boosted burst (no make-up gain, no overshoot)', () => {
    const x = new Float32Array(24000); x.set(tone(4800, 2), 4800);
    const { L } = limit(x);
    expect(db(peak(L))).toBeCloseTo(-1, 3);
    // G-09: the volume-2 S2 bursts peaked at −0.96 dBFS (post-AAC, ±0.05): formula −1.00, within 0.05 dB
    console.log(`[T13 limiter] boosted burst peak ${db(peak(L)).toFixed(3)} dBFS (formula −1.000; Xapp G-09 measured −0.96)`);
  });
  it('a 0 dBFS square (and one boosted to 1.5) comes out at RMS −1.0 dBFS (G-09: −1.05 measured, ±0.05 on a decoded AAC file)', () => {
    for (const amp of [1, 1.5]) {
      const { L } = limit(square(24000, amp));
      const level = db(rms(L, 4800, 19200));
      expect(level).toBeCloseTo(-1.0, 2);
      console.log(`[T13 limiter] square amp ${amp}: RMS ${level.toFixed(3)} dBFS (formula −1.000; Xapp G-09 −1.05)`);
    }
  });
  it('signals under the ceiling pass bit-exact (g stays 1; no make-up gain)', () => {
    const x = tone(24000, 0.8), { L, R, lim } = limit(x, x);
    expect(Array.from(L)).toEqual(Array.from(x)); expect(Array.from(R)).toEqual(Array.from(x)); expect(lim.g).toBe(1);
  });
  it('linked stereo: one gain for both channels (a loud left pulls the quiet right down equally)', () => {
    const l = tone(9600, 3), r = tone(9600, 0.1, 440), { L, R } = limit(l, r);
    for (const i of [2000, 5000, 7000]) expect(R[i] / r[i]).toBeCloseTo(L[i] / l[i], 6);
    expect(R[5000] / r[5000]).toBeLessThan(0.5);
  });
  it('lookahead: no output delay (a burst stays on its sample) and the gain is down before the burst', () => {
    const x = new Float32Array(12000); x.set(tone(2400, 2, 1000).map((v, i) => (i === 0 ? 0.5 * 2 : v)), 6000); // the first burst sample is non-zero
    const { L } = limit(x);
    expect(Array.from(L.subarray(0, 6000)).every(v => v === 0)).toBe(true);
    expect(L[6000]).not.toBe(0);
    expect(Math.abs(L[6000])).toBeLessThanOrEqual(CEIL + 1e-6);
    // a quiet signal just before the onset is attenuated within the 5 ms lookahead window, not earlier
    const q = new Float32Array(12000).fill(0.1); q.set(tone(2400, 2), 6000);
    const o = limit(q).L;
    expect(o[6000 - LOOK - 10]).toBeCloseTo(0.1, 6); expect(o[6000 - 1]).toBeLessThan(0.1 * 0.7);
  });
  it('release is exponential in linear gain, τ = 50 ms: g(t) = 1 − (1 − g0)·e^(−t/τ) (formula oracle, G-09 decision 1)', () => {
    const A = 2, g0 = CEIL / A, end = 24000, total = end + 6 * FS / 10, dc = 0.1;
    const x = new Float32Array(total); x.set(square(end, A)); x.fill(dc, end);
    const { L } = limit(x);
    for (const ms of [5, 10, 20, 30, 50, 75, 98, 150, 250]) {
      const k = Math.round(ms * FS / 1000), expected = dc * (1 - (1 - g0) * Math.exp(-(k / FS) / TAU));
      expect(L[end + k], `${ms} ms`).toBeCloseTo(expected, 3);
    }
    // and not the dB-domain release (G-09: it would give −5.39 / −4.41 / −2.96 / −1.79 / −1.09 dB for the Xapp layout)
    const k = Math.round(0.05 * FS), linear = L[end + k] / dc, dbDomain = 10 ** (20 * Math.log10(g0) * Math.exp(-0.05 / TAU) / 20);
    expect(Math.abs(linear - (1 - (1 - g0) * Math.exp(-1)))).toBeLessThan(2e-3);
    expect(Math.abs(linear - dbDomain)).toBeGreaterThan(0.02);
  });
  it('REPORT: release table vs G-09 (square at the gain that reproduces the "linear-gain prediction" column)', () => {
    // G-09 §10: measured −4.32 / −3.35 / −1.98 / −1.41 / −0.77 dB at 20 / 30 / 50 / 75 / 98 ms; linear-gain prediction −4.51 / −3.50 / −2.18 / −1.26 / −0.74.
    // The square's gain g0 is not in the spec; fitting the prediction column with τ = 50 ms gives g0 ≈ 0.3955 (amplitude ≈ 2.25), so the
    // comparison below uses that g0 (a layout-free fit, reported only).
    const g0 = 0.3955, A = CEIL / g0, end = 24000, dc = 0.1, x = new Float32Array(end + FS / 2); x.set(square(end, A)); x.fill(dc, end);
    const { L } = limit(x), at = [20, 30, 50, 75, 98], xapp = [-4.32, -3.35, -1.98, -1.41, -0.77], predicted = [-4.51, -3.50, -2.18, -1.26, -0.74];
    const ours = at.map(ms => db(L[end + Math.round(ms * FS / 1000)] / dc));
    console.log('[T13 limiter] release dB at 20/30/50/75/98 ms\n  ours      ' + ours.map(v => v.toFixed(2)).join(' / ') + '\n  Xapp meas ' + xapp.join(' / ') + '\n  predicted ' + predicted.join(' / ')
      + '\n  ours − measured ' + ours.map((v, i) => (v - xapp[i]).toFixed(2)).join(' / '));
    ours.forEach((v, i) => expect(Math.abs(v - predicted[i]), `${at[i]} ms vs the prediction column`).toBeLessThan(0.1));
    ours.forEach((v, i) => expect(Math.abs(v - xapp[i]), `${at[i]} ms vs measured`).toBeLessThan(0.25));
  });
  it('state carries across process() calls: two calls with lookahead equal one call, sample for sample', () => {
    const n = 40000, x = noise(n + LOOK, 11).map((v, i) => v * (i % 7000 < 800 ? 4 : 0.3)), y = x.map(v => v * -0.8);
    const whole = new Limiter(FS), wl = x.slice(), wr = y.slice(); whole.process(wl, wr, n);
    const a = new Limiter(FS), cut = 17321;
    const l1 = x.slice(0, cut + LOOK), r1 = y.slice(0, cut + LOOK); a.process(l1, r1, cut);
    const l2 = x.slice(cut, n + LOOK), r2 = y.slice(cut, n + LOOK); a.process(l2, r2, n - cut);
    const joinedL = new Float32Array(n); joinedL.set(l1.subarray(0, cut)); joinedL.set(l2.subarray(0, n - cut), cut);
    expect(maxAbsDiff(joinedL, wl.subarray(0, n))).toBe(0);
    expect(a.g).toBe(whole.g);
  });
  it('reset() returns the gain to 1; non-finite samples become 0', () => {
    const l = new Float32Array(2000), r = new Float32Array(2000); l[100] = NaN; r[200] = Infinity; l[300] = -Infinity; l[400] = 0.5;
    const lim = new Limiter(FS); lim.process(l, r, 1000);
    expect(l[100]).toBe(0); expect(r[200]).toBe(0); expect(l[300]).toBe(0); expect(l[400]).toBe(0.5);
    const loud = new Float32Array(500).fill(5), z = new Float32Array(500).fill(5), l2 = new Limiter(FS); l2.process(loud, z, 250);
    expect(l2.g).toBeLessThan(1); l2.reset(); expect(l2.g).toBe(1);
  });
});
