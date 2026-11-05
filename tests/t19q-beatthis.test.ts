// SPDX-License-Identifier: AGPL-3.0-only
// T19q B4: the BeatThis port without model weights. logMel against a torchaudio reference
// (tests/fixtures/beatthis-mel.json, from apps/web/src/analysis/tools/beatthis_mel_ref.py), framewiseLogits against a
// stub model (inference.py split_piece/aggregate_prediction semantics), beatPeaks on synthetic logits. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { beatPeaks, framewiseLogits, logMel } from '../apps/web/src/analysis/beatthis';

const MELS = 128;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

describe('T19q logMel vs torchaudio', () => {
  const ref = JSON.parse(readFileSync(new URL('./fixtures/beatthis-mel.json', import.meta.url), 'utf8')) as
    { rate: number; length: number; hash: number; frames: number; mels: number; spect: number[][] };
  // Closed form shared with the generator: float64, cast to float32 once.
  const samples = Float32Array.from({ length: ref.length }, (_, n) =>
    0.5 * Math.sin(2 * Math.PI * 440 * n / ref.rate) + 0.25 * Math.sin(2 * Math.PI * 3000 * n / ref.rate) + (n % 2205 === 0 ? 0.8 : 0));

  it('the rebuilt signal is bit-identical to the generator’s float32 samples', () => {
    let h = 2166136261;
    for (const b of new Uint8Array(samples.buffer)) h = Math.imul(h ^ b, 16777619) >>> 0;
    expect(h).toBe(ref.hash);
  });
  // The reference is torchaudio in float64 throughout (window and filterbank too) on these same samples, as the port
  // computes. The bound leaves room for the fixture's 6 decimals, so a float32 window or a filterbank computed in float32 fails it.
  it('same frame count and max |diff| < 2e-6 over every frame and band', () => {
    const { spect, frames } = logMel(samples);
    expect(frames).toBe(ref.frames);
    expect(ref.mels).toBe(MELS);
    expect(spect.length).toBe(frames * MELS);
    let max = 0;
    for (let f = 0; f < frames; f++) for (let m = 0; m < MELS; m++) max = Math.max(max, Math.abs(spect[f * MELS + m] - ref.spect[f][m]));
    expect(max).toBeLessThan(2e-6);
  });
});

describe('T19q framewiseLogits (stub model)', () => {
  // Frame f of the piece is filled with f + 1 so the chunks a stub receives can be checked; the stub's value at chunk-local
  // frame i of chunk c is c * 10000 + i. A chunk starting at piece frame s (s < 0: zero-padded by -s) has local frame i = piece frame s + i.
  function run(frames: number) {
    const spect = new Float32Array(frames * MELS);
    for (let f = 0; f < frames; f++) spect.fill(f + 1, f * MELS, (f + 1) * MELS);
    const received: { chunk: Float32Array; length: number }[] = [];
    const model = async (chunk: Float32Array, length: number) => {
      const c = received.length;
      received.push({ chunk, length });
      return Float32Array.from({ length }, (_, i) => c * 10000 + i);
    };
    return framewiseLogits(spect, frames, model).then(logits => ({ logits, received }));
  }

  it('a piece shorter than one chunk (100 frames): one chunk of 100 + 6 + 6, borders discarded', async () => {
    const { logits, received } = await run(100);
    expect(received.map(r => r.length)).toEqual([112]);
    expect(received[0].chunk.length).toBe(112 * MELS);
    expect(logits.length).toBe(100);
    for (let f = 0; f < 100; f++) expect(logits[f]).toBe(f + 6);
  });
  it('exactly 1488 frames (1500 - 2 * 6): still one chunk, nothing moved', async () => {
    const { logits, received } = await run(1488);
    expect(received.map(r => r.length)).toEqual([1500]);
    expect(logits.length).toBe(1488);
    for (let f = 0; f < 1488; f++) expect(logits[f]).toBe(f + 6);
  });
  it('3200 frames: chunks at -6, 1482 and the last moved left to 1706; earlier chunks win overlaps', async () => {
    const { logits, received } = await run(3200);
    expect(received.map(r => r.length)).toEqual([1500, 1500, 1500]);
    expect(logits.length).toBe(3200);
    // Chunk 0 keeps pieces 0..1487, chunk 1 keeps 1488..2975 (frame 1482 + 6 onwards), chunk 2 only what is left: 2976..3199.
    for (let f = 0; f < 3200; f++) {
      const expected = f < 1488 ? f + 6 : f < 2976 ? 10000 + (f - 1482) : 20000 + (f - 1706);
      expect(logits[f]).toBe(expected);
    }
    // Chunk content: zero padding on the left of the first chunk, the right piece frames in the others.
    const first = received[0].chunk, second = received[1].chunk, last = received[2].chunk;
    expect(first[5 * MELS]).toBe(0);
    expect(first[6 * MELS]).toBe(1);
    expect(first[1499 * MELS]).toBe(1494);
    expect(second[0]).toBe(1483);
    expect(last[0]).toBe(1707);
    expect(last[1499 * MELS]).toBe(0); // local 1499 = piece frame 3205: past the end, zero padding
    expect(last[1493 * MELS]).toBe(3200); // local 1493 = piece frame 3199, the last real frame
  });
});

describe('T19q beatPeaks', () => {
  const quiet = (n: number, set: Record<number, number>) => { const l = new Float32Array(n).fill(-5); for (const [i, v] of Object.entries(set)) l[+i] = v; return l; };

  it('a clean single-frame peak: one beat at the parabola vertex, within half a frame', () => {
    // a=1, b=3, c=2 at frames 9, 10, 11: vertex = 10 + 0.5 (1 - 2) / (1 - 6 + 2) = 10 + 1/6.
    const { times, strengths } = beatPeaks(quiet(30, { 9: 1, 10: 3, 11: 2 }));
    expect(times.length).toBe(1);
    expect(times[0]).toBeCloseTo((10 + 1 / 6) / 50, 12);
    expect(Math.abs(times[0] - 10 / 50)).toBeLessThanOrEqual(0.01);
    expect(strengths[0]).toBeCloseTo(sigmoid(3), 6);
  });
  it('a symmetric peak stays exactly on its frame', () => {
    expect(beatPeaks(quiet(30, { 9: 1, 10: 3, 11: 1 })).times).toEqual([10 / 50]);
  });
  it('a 2-frame plateau merges to the running mean and is not refined', () => {
    const { times, strengths } = beatPeaks(quiet(40, { 19: 1, 20: 3, 21: 3, 22: 1 }));
    expect(times).toEqual([20.5 / 50]);
    expect(strengths[0]).toBeCloseTo(sigmoid(3), 6);
  });
  it('a 3-frame run: the running mean takes 19 and 20 (upstream deduplicate_peaks), not the whole run', () => {
    // 21 is 1.5 from the mean, so it starts a new peak, and `refine` then moves it to 20.5 (upstream keeps frame 21).
    expect(beatPeaks(quiet(40, { 19: 3, 20: 3, 21: 3 })).times).toEqual([19.5 / 50, 20.5 / 50]);
  });
  it('equal peaks 2 frames apart: both kept (deduplicate_peaks width 1)', () => {
    expect(beatPeaks(quiet(30, { 10: 3, 12: 3 })).times).toEqual([10 / 50, 12 / 50]);
  });
  it('a peak on a flat stretch has no curvature and stays on its frame', () => {
    expect(beatPeaks(quiet(40, { 19: 3, 20: 3, 21: 3, 22: 3, 25: 5 })).times).toEqual([19.5 / 50, 21 / 50, 25 / 50]);
  });
  it('peaks within 3 frames: only the larger survives', () => {
    const { times, strengths } = beatPeaks(quiet(30, { 10: 2, 13: 4 }));
    expect(times).toEqual([13 / 50]);
    expect(strengths[0]).toBeCloseTo(sigmoid(4), 6);
    // 4 frames apart: both survive.
    expect(beatPeaks(quiet(30, { 10: 2, 14: 4 })).times).toEqual([10 / 50, 14 / 50]);
  });
  it('a peak with logit <= 0 is dropped', () => {
    expect(beatPeaks(quiet(30, { 10: 0 })).times).toEqual([]);
    expect(beatPeaks(quiet(30, { 10: -1 })).times).toEqual([]);
    expect(beatPeaks(quiet(30, { 10: 0, 20: 2 })).times).toEqual([20 / 50]);
  });
  it('a peak at the first and at the last index: kept on its frame, not refined', () => {
    const { times, strengths } = beatPeaks(quiet(20, { 0: 3, 1: 2, 18: 2, 19: 3 }));
    expect(times).toEqual([0, 19 / 50]);
    expect(strengths.every(s => Number.isFinite(s))).toBe(true);
    expect(strengths[0]).toBeCloseTo(sigmoid(3), 6);
    expect(strengths[1]).toBeCloseTo(sigmoid(3), 6);
  });
  it('empty and all-negative logits give no beats', () => {
    expect(beatPeaks(new Float32Array(0))).toEqual({ times: [], strengths: [] });
    expect(beatPeaks(new Float32Array(10).fill(-2)).times).toEqual([]);
  });
});
