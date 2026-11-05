// SPDX-License-Identifier: AGPL-3.0-only
// T13 mix engine: placement on the 48 kHz grid, speed / remap reading, channel layouts, windows. Oracles: "written-spec" = T13 ticket +
// findings §7 / §7b (sources at 48 kHz, constant speed = resampling, remap clamped, past the source end silent, ±0.25 s decode padding,
// Web Audio down-mix rules for 4 / 6 channels).
import { describe, it, expect } from 'vitest';
import { clipClock, mixFrames, toStereo } from '../apps/web/src/audio/mix';
import { FS, kf, mkClip, mkDoc, mkTrack, synthSource, volume } from './t13-support';

const impulse = (at: number, amp = 1) => (n: number) => (n === at ? amp : 0);
const ramp = (n: number) => n / 1e6;
const one = (extra: Record<string, unknown>, from = 1000, to = 2000, trackExtra: Record<string, unknown> = {}) => mkDoc([mkTrack('a', trackExtra)], [mkClip('c', 'a', from, to, extra)]);
// A frame position f/48 − from, times 48, is not exactly an integer in floating point (error ~1e-11), so a neighbour can leak at ~1e-11
// of the impulse: counted as zero here (−200 dB).
const nonzero = (x: Float32Array) => { const out: number[] = []; x.forEach((v, i) => { if (Math.abs(v) > 1e-9) out.push(i); }); return out; };

describe('placement on the absolute 48 kHz grid', () => {
  it('a source impulse lands on the exact frame: display.from × 48 + source frame', async () => {
    const [L, R] = await mixFrames(one({}), 0, 4 * FS, { source: synthSource({ c: impulse(1000, 0.5) }, 4) });
    expect(nonzero(L)).toEqual([48000 + 1000]); expect(L[49000]).toBe(0.5); expect(R[49000]).toBe(0.5); // mono plays on both sides
  });
  it('trim.from moves the read position: trim 500 ms → source frame 24000 sounds at the clip start', async () => {
    const [L] = await mixFrames(one({ trim: { from: 500 } }), 0, 4 * FS, { source: synthSource({ c: impulse(24000 + 96) }, 4) });
    expect(nonzero(L)).toEqual([48000 + 96]);
  });
  it('rate 2 reads every second source frame (resampling: pitch × rate)', async () => {
    const [L] = await mixFrames(one({ playbackRate: 2 }), 0, 4 * FS, { source: synthSource({ c: impulse(2000) }, 4) });
    expect(nonzero(L)).toEqual([48000 + 1000]);
  });
  it('rate 0.5 interpolates linearly between source frames', async () => {
    const [L] = await mixFrames(one({ playbackRate: 0.5 }), 0, 4 * FS, { source: synthSource({ c: ramp }, 4) });
    // output frame k reads source position k / 2: ramp is linear so the value is (k/2)/1e6
    for (const k of [0, 1, 2, 3, 1001]) expect(L[48000 + k]).toBeCloseTo((k / 2) / 1e6, 9);
  });
  it('the clip is silent outside its display span and past its source end', async () => {
    const [L] = await mixFrames(one({}, 1000, 3000), 0, 4 * FS, { source: synthSource({ c: n => 0.25 }, 1.5) }); // 1.5 s of source in a 2 s clip
    expect(L[47999]).toBe(0); expect(L[48000]).toBe(0.25); expect(L[48000 + 71999]).toBe(0.25);
    expect(L[48000 + 72001]).toBe(0); expect(L[3 * FS]).toBe(0);
  });
  it('a clip with no sound (source null) or a non-audible type contributes nothing', async () => {
    const doc = mkDoc([mkTrack('a')], [mkClip('c', 'a', 0, 1000), mkClip('t', 'a', 0, 1000, { type: 'text' }), mkClip('i', 'a', 0, 1000, { type: 'image' })]);
    const [L, R] = await mixFrames(doc, 0, FS, { source: synthSource({ t: n => 1, i: n => 1 }, 2) });
    expect(nonzero(L)).toEqual([]); expect(nonzero(R)).toEqual([]);
  });
  it('video clips are audible too; two clips on one track sum', async () => {
    const doc = mkDoc([mkTrack('a')], [mkClip('v', 'a', 0, 1000, { type: 'video' }), mkClip('w', 'a', 0, 1000)]);
    const [L] = await mixFrames(doc, 0, 100, { source: synthSource({ v: n => 0.25, w: n => 0.125 }, 2) });
    expect(L[50]).toBeCloseTo(0.375, 7);
  });
  it('sub-range reads equal the same frames of a larger range', async () => {
    const doc = one({ properties: volume(1, [kf(0, 0.2), kf(1000, 1)]) }, 500, 2500), src = synthSource({ c: n => Math.sin(n * 0.01) }, 4);
    const big = await mixFrames(doc, 0, 3 * FS, { source: src }), small = await mixFrames(doc, 77777, 5000, { source: src });
    expect(Array.from(small[0])).toEqual(Array.from(big[0].subarray(77777, 82777)));
  });
});

describe('decode windows (written-spec: ±0.25 s padding)', () => {
  it('requests the clip\'s source span padded by 0.25 s each side, clamped at 0', async () => {
    const calls: { id: string; startS: number; endS: number }[] = [];
    await mixFrames(one({ trim: { from: 500 } }, 1000, 2000), 0, 4 * FS, { source: synthSource({ c: n => 0 }, 4, calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0].startS).toBeCloseTo(0.25, 6); expect(calls[0].endS).toBeCloseTo(1.75, 6);
    const early: typeof calls = [];
    await mixFrames(one({}, 0, 1000), 0, FS, { source: synthSource({ c: n => 0 }, 4, early) });
    expect(early[0].startS).toBe(0); expect(early[0].endS).toBeCloseTo(1.25, 6);
  });
  it('rate 2 widens the span; a range covering part of a clip requests only what that part reads', async () => {
    const calls: { id: string; startS: number; endS: number }[] = [];
    await mixFrames(one({ playbackRate: 2 }, 0, 2000), 0, FS, { source: synthSource({ c: n => 0 }, 8, calls) }); // first second of timeline = 2 s of source
    expect(calls[0].startS).toBe(0); expect(calls[0].endS).toBeCloseTo(2.25, 3);
  });
  it('a window outside the range is not requested at all', async () => {
    const calls: { id: string; startS: number; endS: number }[] = [];
    await mixFrames(one({}, 5000, 6000), 0, FS, { source: synthSource({ c: n => 0 }, 8, calls) });
    expect(calls).toHaveLength(0);
  });
  it('a muted track reads no source', async () => {
    const calls: { id: string; startS: number; endS: number }[] = [];
    await mixFrames(one({}, 0, 1000, { muted: true }), 0, FS, { source: synthSource({ c: n => 0 }, 8, calls) });
    expect(calls).toHaveLength(0);
  });
});

describe('clipClock (written-spec: constant speed trim + local × rate; remap curve clamped to 0…source length)', () => {
  it('constant speed', () => {
    const c = clipClock(mkClip('c', 'a', 0, 1000, { trim: { from: 300 }, playbackRate: 2 }));
    expect(c(0)).toBe(300); expect(c(100)).toBe(500); expect(c(-50)).toBe(200); // not clamped
  });
  it('remap: the curve, clamped to 0…sourceDuration; reverse and freeze are expressible', () => {
    const rev = clipClock(mkClip('c', 'a', 0, 1000, { sourceDuration: 1500, timeRemap: { defaultValue: 0, keyframes: [kf(0, 1000), kf(1000, 0)] } }));
    expect(rev(0)).toBe(1000); expect(rev(250)).toBe(750); expect(rev(1000)).toBe(0);
    const fast = clipClock(mkClip('c', 'a', 0, 1000, { sourceDuration: 1500, timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(500, 3000)] } }));
    expect(fast(250)).toBe(1500); expect(fast(400)).toBe(1500); // clamped to the source length
    const under = clipClock(mkClip('c', 'a', 0, 1000, { sourceDuration: 1500, timeRemap: { defaultValue: 0, keyframes: [kf(0, -400), kf(1000, 600)] } }));
    expect(under(0)).toBe(0); expect(under(1000)).toBe(600);
    const freeze = clipClock(mkClip('c', 'a', 0, 1000, { timeRemap: { defaultValue: 0, keyframes: [kf(0, 700), kf(1000, 700)] } }));
    expect(freeze(0)).toBe(700); expect(freeze(999)).toBe(700);
  });
});

describe('toStereo (written-spec: Web Audio speaker down-mix; mono both sides; others first two)', () => {
  const ch = (n: number) => Array.from({ length: n }, (_, c) => Float32Array.of(c + 1));
  it('mono → both', () => { const [l, r] = toStereo(ch(1)); expect(l[0]).toBe(1); expect(r[0]).toBe(1); });
  it('stereo untouched', () => { const [l, r] = toStereo(ch(2)); expect([l[0], r[0]]).toEqual([1, 2]); });
  it('quad (L R SL SR): L = 0.5 (L + SL), R = 0.5 (R + SR)', () => { const [l, r] = toStereo(ch(4)); expect(l[0]).toBeCloseTo(0.5 * (1 + 3), 6); expect(r[0]).toBeCloseTo(0.5 * (2 + 4), 6); });
  it('5.1 (L R C LFE SL SR): L = L + √½ (C + SL), R = R + √½ (C + SR), LFE dropped', () => {
    const [l, r] = toStereo(ch(6)); expect(l[0]).toBeCloseTo(1 + Math.SQRT1_2 * (3 + 5), 6); expect(r[0]).toBeCloseTo(2 + Math.SQRT1_2 * (3 + 6), 6);
  });
  it('3 channels play the first two', () => { const [l, r] = toStereo(ch(3)); expect([l[0], r[0]]).toEqual([1, 2]); });
});

describe('time remap through the mix (written-spec: findings §7b)', () => {
  it('reverse: a −1× section plays the source backwards, sample for sample', async () => {
    // remap 0…1000 ms (item-local) → source 2000…1000 ms, i.e. source frame 96000 − k at output frame k
    const doc = one({ timeRemap: { defaultValue: 0, keyframes: [kf(0, 2000), kf(1000, 1000)] }, sourceDuration: 4000 }, 1000, 2000);
    const [L] = await mixFrames(doc, 0, 3 * FS, { source: synthSource({ c: ramp }, 4) });
    for (const k of [0, 1, 2, 5000, 20000, 47990]) expect(L[48000 + k], `k=${k}`).toBeCloseTo((96000 - k) / 1e6, 8);
  });
  it('freeze: a constant remap holds one source sample', async () => {
    const doc = one({ timeRemap: { defaultValue: 0, keyframes: [kf(0, 1500), kf(1000, 1500)] }, sourceDuration: 4000 }, 1000, 2000);
    const [L] = await mixFrames(doc, 0, 3 * FS, { source: synthSource({ c: ramp }, 4) });
    const v = 72000 / 1e6;
    for (const k of [0, 1, 700, 24000, 47999]) expect(L[48000 + k]).toBeCloseTo(v, 8);
  });
  it('remap past the source length is clamped to the source end, where there is no sound (silent: no wrap, no repeat)', async () => {
    const doc = one({ timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(1000, 8000)] }, sourceDuration: 2000 }, 0, 1000);
    const [L] = await mixFrames(doc, 0, FS, { source: synthSource({ c: ramp }, 2) });
    expect(L[100]).toBeGreaterThan(0.0001); // 8× speed: frame 100 reads source frame 800 → 0.0008
    expect(L[100]).toBeCloseTo(800 / 1e6, 8);
    expect(L[FS - 10]).toBe(0);
  });
});
