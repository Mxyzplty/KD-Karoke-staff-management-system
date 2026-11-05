// SPDX-License-Identifier: AGPL-3.0-only
// T13 speed and pitch (T13 ticket "Speed and pitch", findings §7b). Oracle: "written-spec" = 2× / 0.5× clips sound one octave up / down
// (within ±10 cents on S2's 1 kHz bursts), a remap ramp 1× → 4× rises smoothly, a −1× section plays backwards, a freeze holds one sample,
// keep pitch holds the pitch at the new duration. Source: S2 (the fixture store's synthetic/S2-…-tone…mp4, 100 ms bursts of 1 kHz at
// every whole second, decoded to mono 48 kHz by ffmpeg) when present, and always a synthetic burst train of the same layout.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { mixFrames } from '../apps/web/src/audio/mix';
import { evaluate } from '../apps/web/src/timeline/properties';
import { FS, cents, decodeWithFfmpeg, freqHz, haveFfmpeg, kf, mkClip, mkDoc, mkTrack, pcmSource, peak, rms, sine } from './t13-support';

const STORE = process.env.CUTFRAME_FIXTURES ?? (existsSync('C:/Users/owner/cutframe-fixtures') ? 'C:/Users/owner/cutframe-fixtures' : '');
const S2_FILE = STORE ? path.join(STORE, 'synthetic', 'S2-framecount-tone-1920x1080-30fps-10s.mp4') : '';
const haveS2 = !!S2_FILE && existsSync(S2_FILE) && haveFfmpeg();
const burstTrain = (seconds: number): Float32Array => Float32Array.from({ length: seconds * FS }, (_, n) => (n % FS < 4800 ? 0.78 * Math.sin(2 * Math.PI * 1000 * n / FS) : 0));
const sources: Record<string, () => Float32Array> = { 'synthetic burst train': () => burstTrain(10), ...(haveS2 ? { 'S2 (fixture store)': () => decodeWithFfmpeg(S2_FILE) } : {}) };
if (!haveS2) console.log('[T13 speed] S2 absent or ffmpeg missing: only the synthetic 1 kHz burst train ran');

const clipDoc = (extra: Record<string, unknown>, toMs: number) => mkDoc([mkTrack('a')], [mkClip('c', 'a', 0, toMs, extra)]);
const mix = async (extra: Record<string, unknown>, toMs: number, pcm: Float32Array) =>
  (await mixFrames(clipDoc(extra, toMs), 0, Math.round(toMs * FS / 1000), { source: pcmSource({ c: [pcm] }) }))[0];
/** Frequencies of the bursts in `out`: `count` bursts, burst k starting at k × period s and lasting `len` s; the inner part is measured. */
function burstFreqs(out: Float32Array, count: number, period: number, len: number): number[] {
  const margin = 0.15 * len;
  return Array.from({ length: count }, (_, k) => freqHz(out, Math.round((k * period + margin) * FS), Math.round((k * period + len - margin) * FS)));
}

for (const [name, load] of Object.entries(sources)) describe(`speed and pitch on ${name}`, () => {
  const pcm = load();
  it('S2 layout check: ten 100 ms bursts of 1 kHz', () => {
    expect(burstFreqs(pcm, 9, 1, 0.1).every(f => Math.abs(cents(f, 1000)) < 5)).toBe(true);
  });
  it('2× → 2 kHz within ±10 cents; the bursts are half as long and twice as dense', async () => {
    const out = await mix({ playbackRate: 2 }, 5000, pcm);
    const f = burstFreqs(out, 9, 0.5, 0.05);
    f.forEach((x, k) => expect(Math.abs(cents(x, 2000)), `burst ${k}: ${x.toFixed(1)} Hz`).toBeLessThanOrEqual(10));
    expect(peak(out, Math.round(0.06 * FS), Math.round(0.49 * FS))).toBeLessThan(0.02); // silence between bursts
  });
  it('0.5× → 500 Hz within ±10 cents; the bursts are twice as long', async () => {
    const out = await mix({ playbackRate: 0.5 }, 10000, pcm);
    const f = burstFreqs(out, 4, 2, 0.2);
    f.forEach((x, k) => expect(Math.abs(cents(x, 500)), `burst ${k}: ${x.toFixed(1)} Hz`).toBeLessThanOrEqual(10));
  });
  it('reverse (−1× remap section): the output is the source played backwards, sample for sample', async () => {
    const out = await mix({ timeRemap: { defaultValue: 0, keyframes: [kf(0, 3000), kf(2000, 1000)] }, sourceDuration: 10000 }, 2000, pcm);
    let worst = 0; for (let k = 0; k < 2 * FS - 2; k++) worst = Math.max(worst, Math.abs(out[k] - pcm[3 * FS - k]));
    expect(worst).toBeLessThan(1e-6);
  });
  it('freeze: a constant remap holds one sample for the whole clip', async () => {
    let at = 1440 + 3 * FS; // inside the burst at 3 s: the first sample 30 ms in with a clearly non-zero value
    while (Math.abs(pcm[at]) < 0.3) at++;
    const out = await mix({ timeRemap: { defaultValue: 0, keyframes: [kf(0, at / 48), kf(1000, at / 48)] }, sourceDuration: 10000 }, 1000, pcm);
    expect(Math.abs(pcm[at])).toBeGreaterThan(0.05);
    for (const k of [0, 1, 999, 20000, 47999]) expect(out[k]).toBeCloseTo(pcm[at], 6);
  });
  it('keep pitch at 2×: 1 kHz ±10 cents at half the duration', async () => {
    const out = await mix({ playbackRate: 2, keepPitch: true }, 5000, pcm);
    const f = burstFreqs(out, 9, 0.5, 0.05);
    f.forEach((x, k) => expect(Math.abs(cents(x, 1000)), `burst ${k}: ${x.toFixed(1)} Hz`).toBeLessThanOrEqual(10));
  });
  it('keep pitch at 0.5×: 1 kHz ±10 cents at twice the duration', async () => {
    const out = await mix({ playbackRate: 0.5, keepPitch: true }, 10000, pcm);
    const f = burstFreqs(out, 4, 2, 0.2);
    f.forEach((x, k) => expect(Math.abs(cents(x, 1000)), `burst ${k}: ${x.toFixed(1)} Hz`).toBeLessThanOrEqual(10));
  });
});

describe('speed and pitch on a continuous 1 kHz tone', () => {
  const tone = Float32Array.from({ length: 20 * FS }, (_, n) => 0.5 * Math.sin(2 * Math.PI * 1000 * n / FS)), at = (s: number) => Math.round(s * FS);
  it('remap ramp 1× → 4× rises smoothly: monotonic, no jumps, ends at 1 kHz and 4 kHz', async () => {
    // One segment 0…4000 ms → source 0…10000 ms with a bezier easing whose end slopes are 0.4 and 1.6 of the mean speed 2.5 (= 1× and 4×).
    const keyframes = [kf(0, 0, { type: 'bezier', points: [0.5, 0.2, 0.75, 0.6] }), kf(4000, 10000)];
    const speed = (ms: number) => ((evaluate(keyframes, 0, ms + 1) as number) - (evaluate(keyframes, 0, ms - 1) as number)) / 2; // source ms per ms
    expect(speed(1)).toBeCloseTo(1, 1); expect(speed(3999)).toBeCloseTo(4, 1);
    const out = await mix({ timeRemap: { defaultValue: 0, keyframes }, sourceDuration: 20000 }, 4000, tone);
    const win = 0.04, f: number[] = [], expected: number[] = [];
    for (let t = 0.02; t + win < 3.98; t += win) {
      f.push(freqHz(out, at(t), at(t + win)));
      expected.push(1000 * ((evaluate(keyframes, 0, (t + win) * 1000) as number) - (evaluate(keyframes, 0, t * 1000) as number)) / (win * 1000));
    }
    expect(expected.every((v, i) => i === 0 || v >= expected[i - 1] - 1e-9), 'the test curve itself rises monotonically').toBe(true);
    f.forEach((x, i) => expect(Math.abs(cents(x, expected[i])), `window ${i}: ${x.toFixed(1)} Hz vs ${expected[i].toFixed(1)}`).toBeLessThanOrEqual(35));
    f.forEach((x, i) => { if (i) { expect(x, `monotonic at window ${i}`).toBeGreaterThanOrEqual(f[i - 1] * 0.99); expect(x / f[i - 1], `jump at window ${i}`).toBeLessThan(1.08); } });
    expect(Math.abs(cents(f[0], 1000))).toBeLessThan(100); expect(Math.abs(cents(f[f.length - 1], 4000))).toBeLessThan(100);
  });
  it('keep pitch at 2×: 1 kHz ±10 cents, half the duration, level preserved', async () => {
    const out = await mix({ playbackRate: 2, keepPitch: true }, 2000, tone);
    expect(Math.abs(cents(freqHz(out, at(0.2), at(1.8)), 1000))).toBeLessThanOrEqual(10);
    const level = 20 * Math.log10(rms(out, at(0.2), at(1.8)) / (0.5 / Math.SQRT2));
    expect(Math.abs(level), `level ${level.toFixed(2)} dB`).toBeLessThan(0.5); // the overlapping grain windows sum to 1
    const after = await mixFrames(clipDoc({ playbackRate: 2, keepPitch: true }, 2000), 0, at(2.5), { source: pcmSource({ c: [tone] }) });
    expect(peak(after[0], at(2.05), at(2.5))).toBe(0); // the clip ends at 2 s: half of the 4 s of source it would play at 1×
  });
  it('keep pitch at 0.5×: 1 kHz ±10 cents over twice the duration', async () => {
    const out = await mix({ playbackRate: 0.5, keepPitch: true }, 4000, tone);
    expect(Math.abs(cents(freqHz(out, at(0.3), at(3.7)), 1000))).toBeLessThanOrEqual(10);
  });
  it('keep pitch follows a remap ramp (pitch stays 1 kHz while the clip speeds up 1× → 4×)', async () => {
    const keyframes = [kf(0, 0, { type: 'bezier', points: [0.5, 0.2, 0.75, 0.6] }), kf(4000, 10000)];
    const out = await mix({ keepPitch: true, timeRemap: { defaultValue: 0, keyframes }, sourceDuration: 20000 }, 4000, tone);
    for (const [a, b] of [[0.2, 1.0], [1.0, 2.0], [2.0, 3.0], [3.0, 3.8]]) expect(Math.abs(cents(freqHz(out, at(a), at(b)), 1000)), `${a}…${b} s`).toBeLessThanOrEqual(20);
  });
  it('keep pitch at rate 1 is the plain path (identical samples)', async () => {
    const plain = await mix({}, 1000, tone), kept = await mix({ keepPitch: true }, 1000, tone);
    expect(Array.from(kept)).toEqual(Array.from(plain));
  });
  it('keepPitch is off by default: 2× without it is an octave up (control for the tests above)', async () => {
    const out = await mix({ playbackRate: 2 }, 2000, tone);
    expect(Math.abs(cents(freqHz(out, at(0.2), at(1.8)), 2000))).toBeLessThanOrEqual(10);
  });
  void sine;
});
