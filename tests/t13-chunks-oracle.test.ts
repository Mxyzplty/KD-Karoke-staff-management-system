// SPDX-License-Identifier: AGPL-3.0-only
// T13 chunked rendering, the audio oracle and the resampler. Oracles: "written-spec" = findings §7 (chunks of 120 s over 5 min, the limiter's
// gain carried across, 5 ms lookahead), master plan §4 (oracle gates: lag ≤ 1 ms, ±0.1 dB RMS / peak, residual ≤ −50 dBFS, excluded spans,
// two silent signals agree) and the T13 ticket (sources converted to 48 kHz as Xapp's export does).
import { describe, it, expect } from 'vitest';
import { mixFrames } from '../apps/web/src/audio/mix';
import type { Stereo } from '../apps/web/src/audio/mix';
import { CHUNK_MS, LONG_MS, audioChunks, rangeFrames, renderAudio } from '../apps/web/src/audio/stage';
import { AUDIO_GATES, compareAudio, lagFrames, levels } from '../apps/web/src/audio/oracle';
import { resamplePlanar } from '../apps/web/src/audio/resample';
import { stretchInto } from '../apps/web/src/audio/stretch';
import { FS, db, kf, maxAbsDiff, mkClip, mkDoc, mkTrack, noise, peak, rms, sine, synthSource, volume } from './t13-support';

const square: (n: number) => number = n => (Math.floor(2 * 200 * n / FS) % 2 === 0 ? 3 : -3);
const source = synthSource({ c1: square, c2: sine(440, 0.6), c3: sine(700, 0.5), c4: sine(300, 0.5), c5: n => 0.25 * Math.sin(n * 0.011) + 0.2 * Math.sin(n * 0.0273) }, 14);
const remap = { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0, { type: 'bezier', points: [0.5, 0.2, 0.75, 0.6] } as never), kf(3000, 6000)] }, sourceDuration: 14000 };
/** A mix with a loud square ending at 1.9 s (its release spans the chunk boundary at 2 s), a rate-1.5 clip with eased volume and a remapped clip. */
const busy = () => mkDoc([mkTrack('a'), mkTrack('b', { volume: 0.8 })], [
  mkClip('c1', 'a', 0, 1900),
  mkClip('c2', 'a', 500, 4500, { playbackRate: 1.5, properties: volume(1, [kf(0, 0.3), kf(2000, 1, 'easeInOut')]) }),
  mkClip('c4', 'b', 2000, 5000, remap),
  mkClip('c5', 'a', 3300, 5800, { trim: { from: 700 } }),
]);
const plain = () => mkDoc([mkTrack('a')], [mkClip('c1', 'a', 0, 1900), mkClip('c2', 'a', 500, 4500, { playbackRate: 1.5 }), mkClip('c5', 'a', 3300, 5800, { trim: { from: 700 } })]);
const keep = () => mkDoc([mkTrack('a')], [mkClip('c3', 'a', 1000, 5000, { playbackRate: 2, keepPitch: true })]);
const rem = () => mkDoc([mkTrack('a')], [mkClip('c4', 'a', 2000, 5000, remap)]);
async function assemble(input: Parameters<typeof audioChunks>[0], chunkMs?: number): Promise<{ pcm: Stereo; starts: number[] }> {
  const { start, frames } = rangeFrames(input.fromMs, input.toMs), pcm: Stereo = [new Float32Array(frames), new Float32Array(frames)], starts: number[] = [];
  for await (const c of audioChunks(input, chunkMs)) { starts.push(c.startFrame); pcm[0].set(c.channels[0], c.startFrame - start); pcm[1].set(c.channels[1], c.startFrame - start); }
  return { pcm, starts };
}

describe('chunk equality (written-spec: chunked render = one-shot render, limiter gain carried)', () => {
  for (const [name, doc] of [['busy mix (rate, eased volume, remap, loud square)', busy], ['plain clips (rate, trim)', plain], ['remapped clip', rem]] as const) {
    for (const chunkMs of [1000, 777]) it(`${name}: audioChunks(${chunkMs} ms) assembled equals the one-shot renderAudio, sample for sample`, async () => {
      const input = { doc: doc(), fromMs: 0, toMs: 6000, source }, whole = await renderAudio(input), parts = await assemble(input, chunkMs);
      expect(parts.starts.length).toBeGreaterThan(5);
      expect(maxAbsDiff(parts.pcm[0], whole.channels[0])).toBe(0); expect(maxAbsDiff(parts.pcm[1], whole.channels[1])).toBe(0);
      expect(peak(whole.channels[0])).toBeGreaterThan(0.1);
    });
  }
  // The keep-pitch stretcher restarts its shift chain at fixed grain indices precisely so that chunked = one-shot (stretch.ts header).
  // Regression guard (found and fixed in T13): stretchInto wrote out[n − n0] into the whole window buffer, so a keep-pitch clip that starts
  // after the window start landed f0 − start frames too early (see "keep-pitch placement" below).
  for (const chunkMs of [1000, 777]) it(`keep-pitch clip: audioChunks(${chunkMs} ms) assembled equals the one-shot renderAudio, sample for sample`, async () => {
    const input = { doc: keep(), fromMs: 0, toMs: 6000, source }, whole = await renderAudio(input), parts = await assemble(input, chunkMs);
    expect(maxAbsDiff(parts.pcm[0], whole.channels[0])).toBe(0); expect(maxAbsDiff(parts.pcm[1], whole.channels[1])).toBe(0);
  });
  it('keep-pitch placement: a rate-2 keep-pitch clip at 1000–5000 ms is silent before 1 s, sounding 1–5 s (window starting at 0), as the plain 2× clip is', async () => {
    const d = keep(), [L] = await mixFrames(d, 0, 6 * FS, { source }), [P] = await mixFrames(mkDoc([mkTrack('a')], [mkClip('c3', 'a', 1000, 5000, { playbackRate: 2 })]), 0, 6 * FS, { source });
    expect(peak(P, 0, FS - 10), 'plain 2× clip is silent before its start').toBe(0); expect(rms(P, FS + 4800, 5 * FS - 4800)).toBeGreaterThan(0.2);
    expect(peak(L, 0, FS - 10), 'keep-pitch clip silent before its start').toBe(0);
    expect(rms(L, 4 * FS + 4800, 5 * FS - 4800), 'keep-pitch clip still sounding at 4.5 s').toBeGreaterThan(0.2);
    expect(peak(L, 5 * FS + 10, 6 * FS), 'silent after its end').toBe(0);
  });
  it('keep-pitch placement: a window starting inside the clip equals the same frames of the larger window', async () => {
    const d = keep(), whole = await mixFrames(d, 0, 6 * FS, { source }), w = await mixFrames(d, 2 * FS, FS, { source });
    expect(maxAbsDiff(w[0], whole[0].subarray(2 * FS, 3 * FS))).toBeLessThan(1e-9); // f/48 − from, times 48, is not an exact integer (as in the placement test)
  });
  it('the release of the loud square spans the boundary at 2 s, so the carried gain matters (a fresh limiter at 2 s would differ)', async () => {
    const input = { doc: plain(), fromMs: 0, toMs: 6000, source }, whole = await renderAudio(input);
    // the square ends at 1.9 s (g ≈ 0.3); at 2.0 s the gain is still recovering, so c2's 0.6-amplitude tone is attenuated there
    const fresh = await renderAudio({ ...input, fromMs: 2000 }); // limiter starts at g = 1
    const a = whole.channels[0].subarray(96000, 96000 + 2400), b = fresh.channels[0].subarray(0, 2400);
    expect(maxAbsDiff(a, b), 'fresh limiter must differ: the gain at 2.0 s is not 1').toBeGreaterThan(0.01);
  });
  it('parity mode with static volumes: chunked = one-shot', async () => {
    const doc = mkDoc([mkTrack('a', { volume: 0.7 })], [mkClip('c1', 'a', 0, 1900, { properties: volume(0.9) }), mkClip('c2', 'a', 500, 4500, { playbackRate: 1.5 })]);
    const input = { doc, fromMs: 0, toMs: 6000, source, mode: 'parity' as const }, whole = await renderAudio(input), parts = await assemble(input, 1000);
    expect(maxAbsDiff(parts.pcm[0], whole.channels[0])).toBe(0); expect(maxAbsDiff(parts.pcm[1], whole.channels[1])).toBe(0);
  });
  it('a range not on a whole frame or chunk: [1000.5, 3000.25) ms is round(ms × 48) frames, chunked = whole', async () => {
    expect(rangeFrames(1000.5, 3000.25)).toEqual({ start: 48024, frames: Math.round(3000.25 * 48) - 48024 });
    const input = { doc: busy(), fromMs: 1000.5, toMs: 3000.25, source }, whole = await renderAudio(input), parts = await assemble(input, 333);
    expect(whole.channels[0].length).toBe(rangeFrames(1000.5, 3000.25).frames);
    expect(maxAbsDiff(parts.pcm[0], whole.channels[0])).toBe(0); expect(parts.starts[0]).toBe(48024);
  });
  it('the empty range renders nothing', async () => {
    const whole = await renderAudio({ doc: busy(), fromMs: 1000, toMs: 1000, source });
    expect(whole.channels[0].length).toBe(0); expect(rangeFrames(2000, 1000).frames).toBe(0);
  });
});

describe('default chunking (written-spec: ranges over 5 min render in 120 s chunks)', () => {
  it('constants: LONG_MS = 5 min, CHUNK_MS = 120 s', () => { expect(LONG_MS).toBe(300000); expect(CHUNK_MS).toBe(120000); });
  it('a 301 s range comes in 3 contiguous chunks of 120 s, 120 s, 61 s', async () => {
    const doc = mkDoc([mkTrack('a')], [mkClip('c1', 'a', 119_900, 120_150)]), sizes: number[] = [], starts: number[] = []; let loud = 0, ceilingOk = true;
    for await (const c of audioChunks({ doc, fromMs: 0, toMs: 301_000, source })) {
      starts.push(c.startFrame); sizes.push(c.channels[0].length); loud = Math.max(loud, peak(c.channels[0])); ceilingOk &&= peak(c.channels[0]) <= 10 ** (-1 / 20) + 1e-6;
    }
    expect(starts).toEqual([0, 5_760_000, 11_520_000]); expect(sizes).toEqual([5_760_000, 5_760_000, 61 * FS]);
    expect(loud).toBeGreaterThan(0.5); expect(ceilingOk).toBe(true);
  }, 120000);
  it('a loud burst straddling the 120 s boundary stays under the ceiling and the limiter does not restart (no step in the gain at the boundary)', async () => {
    const doc = mkDoc([mkTrack('a')], [mkClip('c1', 'a', 119_900, 120_150)]), at = 120 * FS;
    const chunks: Stereo[] = []; for await (const c of audioChunks({ doc, fromMs: 119_000, toMs: 121_000, source }, 1000)) chunks.push(c.channels);
    const ref = await renderAudio({ doc, fromMs: 119_000, toMs: 121_000, source }), joined = new Float32Array(2 * FS); joined.set(chunks[0][0]); joined.set(chunks[1][0], FS);
    expect(maxAbsDiff(joined, ref.channels[0])).toBe(0); void at;
  });
});

describe('mixFrames windows join exactly (written-spec: the mix is a pure function of the absolute frame)', () => {
  // keep-pitch clips have their own block below (and the chunk equality above)
  for (const [name, doc] of [['busy mix', busy], ['plain clips', plain], ['remapped clip', rem]] as const) {
    it(`${name}: adjacent windows [a, a+n1) + [a+n1, a+n1+n2) equal the whole`, async () => {
      const a = 40_000, n1 = 77_777, n2 = 120_001, d = doc();
      const whole = await mixFrames(d, a, n1 + n2, { source }), w1 = await mixFrames(d, a, n1, { source }), w2 = await mixFrames(d, a + n1, n2, { source });
      for (let c = 0; c < 2; c++) {
        expect(maxAbsDiff(w1[c], whole[c].subarray(0, n1)), `${name} first window, channel ${c}`).toBe(0);
        expect(maxAbsDiff(w2[c], whole[c].subarray(n1)), `${name} second window, channel ${c}`).toBe(0);
      }
    });
  }
});

describe('mixFrames windows on a keep-pitch clip (windows join exactly and match the one-shot render)', () => {
  it('adjacent windows equal the whole, sample for sample (the second window replays the chain from its restart)', async () => {
    const a = 40_000, n1 = 77_777, n2 = 120_001, d = keep();
    const whole = await mixFrames(d, a, n1 + n2, { source }), w1 = await mixFrames(d, a, n1, { source }), w2 = await mixFrames(d, a + n1, n2, { source });
    for (let c = 0; c < 2; c++) {
      expect(maxAbsDiff(w1[c], whole[c].subarray(0, n1)), `first window, channel ${c}`).toBe(0);
      expect(maxAbsDiff(w2[c], whole[c].subarray(n1)), `second window, channel ${c}`).toBe(0);
    }
  });
});

// ---- review M2: the stretch's cost. The fast stretch reads each grain's mono samples once into scratch arrays and can carry its chain
// between calls; both must leave every sample as the pre-registered method gives it. Oracle: the method as first written (closure readers,
// the chain replayed from its restart on every call), copied here unchanged from stretch.ts at adfd6a1.
const GRAIN = 1920, HOP = 960, SEARCH = 480, COARSE = 8, CHAIN = 50;
const WINDOW = Float32Array.from({ length: GRAIN }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / GRAIN));
type Read = (x: number) => number;
function refScore(mono: Read, a: number, b: number, step: number) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < HOP; i += step) { const x = mono(a + i), y = mono(b + i); ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
function refShift(mono: Read, centre: number, continuation: number) {
  let best = 0, top = -Infinity;
  for (let d = -SEARCH; d <= SEARCH; d += COARSE) { const s = refScore(mono, centre - HOP + d, continuation, 4); if (s > top) { top = s; best = d; } }
  const coarse = best;
  for (let d = Math.max(-SEARCH, coarse - COARSE + 1); d <= Math.min(SEARCH, coarse + COARSE - 1); d++) { const s = refScore(mono, centre - HOP + d, continuation, 1); if (s > top) { top = s; best = d; } }
  return best;
}
function refStretch(out: [Float32Array, Float32Array], n0: number, n1: number, clipStart: number, position: (k: number) => number, left: Read, right: Read, gain: (n: number) => number) {
  const mono: Read = x => 0.5 * (left(x) + right(x));
  const first = Math.max(0, Math.floor((n0 - clipStart) / HOP) - 1), last = Math.ceil((n1 - clipStart) / HOP) + 1;
  let j = first - (first % CHAIN), start = Math.round(position(j * HOP)) - HOP;
  for (; j < first; ) { j++; start = j % CHAIN === 0 ? Math.round(position(j * HOP)) - HOP : Math.round(position(j * HOP)) + refShift(mono, Math.round(position(j * HOP)), start + HOP) - HOP; }
  for (; j <= last; j++) {
    if (j > first) { const centre = Math.round(position(j * HOP)); start = j % CHAIN === 0 ? centre - HOP : centre - HOP + refShift(mono, centre, start + HOP); }
    const o = clipStart + j * HOP - HOP;
    for (let i = Math.max(0, n0 - o), end = Math.min(GRAIN, n1 - o); i < end; i++) { const n = o + i, w = WINDOW[i] * gain(n); out[0][n] += w * left(start + i); out[1][n] += w * right(start + i); }
  }
}
describe('keep-pitch cost changes leave every sample (review M2)', () => {
  const N = 12 * FS, base = 3000, L = noise(N, 11).map((v, i) => 0.4 * v + 0.5 * Math.sin(i * 0.031)), R = noise(N, 12).map((v, i) => 0.3 * v + 0.4 * Math.sin(i * 0.017));
  const reader = (x: Float32Array): Read => k => { const i = k - base; return i >= 0 && i < x.length ? x[i] : 0; };
  const cases: [string, (k: number) => number][] = [
    ['2×', k => 2 * k + base + 500], ['0.5×', k => 0.5 * k + base + 500], ['1.37× (fractional)', k => 1.37 * k + base + 123.4],
    ['ramp 1× → 3×', k => base + k + k * k / (8 * FS)], ['reverse', k => base + 10 * FS - 1.5 * k], ['freeze', () => base + 4 * FS],
  ];
  for (const [name, position] of cases) it(`${name}: stretchInto equals the reference method, sample for sample, in windows across chain restarts`, () => {
    for (const [n0, n1, clipStart] of [[0, 3 * FS, 0], [100_000, 112_000, 2000], [47_000, 49_001, -5000], [0, 2 * FS, 30_000]] as const) {
      const got: Stereo = [new Float32Array(n1), new Float32Array(n1)], want: Stereo = [new Float32Array(n1), new Float32Array(n1)], gain = (n: number) => 0.8 + 0.2 * Math.sin(n / 5000);
      stretchInto(got, n0, n1, clipStart, position, L, R, base, gain); refStretch(want, n0, n1, clipStart, position, reader(L), reader(R), gain);
      expect(maxAbsDiff(got[0], want[0]), `${name} [${n0}, ${n1}) left`).toBe(0); expect(maxAbsDiff(got[1], want[1]), `${name} [${n0}, ${n1}) right`).toBe(0);
    }
  });
  it('a carried chain (preview order: 250 ms chunks plus the 5 ms lookahead, then a seek back) gives the same samples as none', async () => {
    const d = keep(), chains = new Map(), step = 250 * 48, look = 240;
    for (const k of [...Array.from({ length: 16 }, (_, i) => 4 + i), 1, 2, 3, 10, 11]) {
      const at = k * step, carried = await mixFrames(d, at, step + look, { source, chains }), fresh = await mixFrames(d, at, step + look, { source });
      expect(maxAbsDiff(carried[0], fresh[0]), `chunk ${k} left`).toBe(0); expect(maxAbsDiff(carried[1], fresh[1]), `chunk ${k} right`).toBe(0);
    }
    expect(peak((await mixFrames(d, 2 * FS, FS, { source, chains }))[0]), 'the clip sounds (not a vacuous comparison)').toBeGreaterThan(0.2);
    expect(chains.size, 'one chain for the one clip').toBe(1);
  });
  it('a chain is kept per clip setting: changing the rate between calls starts another chain (no stale state)', async () => {
    const chains = new Map(), a = keep(), b = mkDoc([mkTrack('a')], [mkClip('c3', 'a', 1000, 5000, { playbackRate: 1.5, keepPitch: true })]);
    for (const d of [a, b, a]) {
      const carried = await mixFrames(d, 2 * FS, 12_240, { source, chains }), fresh = await mixFrames(d, 2 * FS, 12_240, { source });
      expect(maxAbsDiff(carried[0], fresh[0])).toBe(0);
    }
    expect(chains.size).toBe(2);
  });
});

// ---- oracle
const body = (n: number, pad: number, seed = 1) => { const x = noise(n, seed).map(v => v * 0.5); x.fill(0, 0, pad); x.fill(0, n - pad); return x; };
/** `x` delayed by `lag` frames (negative = advanced), same length plus slack so no ref frame is lost. */
const delayed = (x: Float32Array, lag: number): Float32Array => { const y = new Float32Array(x.length + Math.abs(lag) + 8); for (let i = 0; i < x.length; i++) y[i + lag + (lag < 0 ? 0 : 0)] = x[i]; return y; };
const st = (x: Float32Array): Stereo => [x, x];
const scaled = (x: Float32Array, k: number) => x.map(v => v * k);
const REF = body(96000, 600);

describe('audio oracle (written-spec: lag ≤ 1 ms, ±0.1 dB RMS and peak, residual ≤ −50 dBFS)', () => {
  it('gates are the master-plan values', () => { expect(AUDIO_GATES).toEqual({ lagMs: 1, gainDb: 0.1, peakDb: 0.1, residualDb: -50 }); });
  it('identical signals pass with lag 0, gain 0, residual far below the gate', () => {
    const r = compareAudio(st(REF), st(REF.slice()));
    expect(r.passed).toBe(true); expect(r.lagMs).toBeCloseTo(0, 6); expect(Math.abs(r.gainDb)).toBeLessThan(1e-6); expect(r.residualDb).toBeLessThan(-120);
  });
  it('recovers a +24-frame delay (0.5 ms) and passes', () => {
    const r = compareAudio(st(REF), st(delayed(REF, 24)));
    expect(r.lagMs).toBeCloseTo(0.5, 2); expect(r.passed).toBe(true); expect(r.residualDb).toBeLessThan(-120);
    expect(lagFrames(st(REF), st(delayed(REF, 24)), 480)).toBeCloseTo(24, 1);
  });
  it('recovers an advance of 24 frames (lag −0.5 ms; sign: test late against ref is positive)', () => {
    const early = new Float32Array(REF.length); early.set(REF.subarray(24)); // early[n] = REF[n + 24]
    const r = compareAudio(st(REF), st(early));
    expect(r.lagMs).toBeCloseTo(-0.5, 2); expect(r.passed).toBe(true);
    expect(lagFrames(st(REF), st(early), 480)).toBeCloseTo(-24, 1);
  });
  it('a 100-frame delay (2.08 ms) is found and fails the 1 ms gate; the levels and residual are fine after alignment', () => {
    const r = compareAudio(st(REF), st(delayed(REF, 100)));
    expect(r.lagMs).toBeCloseTo(100 * 1000 / FS, 2); expect(r.passed).toBe(false); expect(Math.abs(r.gainDb)).toBeLessThan(0.01); expect(r.residualDb).toBeLessThan(-120);
  });
  it('the lag search stays within maxLagMs (a 1000-frame delay is not reported beyond ±10 ms)', () => {
    const r = compareAudio(st(REF), st(delayed(REF, 1000)), { maxLagMs: 10 });
    expect(Math.abs(r.lagMs)).toBeLessThanOrEqual(10 + 1e-9); expect(r.passed).toBe(false);
    const found = compareAudio(st(REF), st(delayed(REF, 1000)), { maxLagMs: 30 });
    expect(found.lagMs).toBeCloseTo(1000 * 1000 / FS, 2);
  });
  it('+0.2 dB of gain fails the level gate (and is measured as +0.2 dB); +0.05 dB passes', () => {
    const hi = compareAudio(st(REF), st(scaled(REF, 10 ** (0.2 / 20))));
    expect(hi.gainDb).toBeCloseTo(0.2, 3); expect(hi.peakDb).toBeCloseTo(0.2, 3); expect(hi.passed).toBe(false);
    const lo = compareAudio(st(REF), st(scaled(REF, 10 ** (0.05 / 20))));
    expect(lo.gainDb).toBeCloseTo(0.05, 3); expect(lo.passed).toBe(true);
    const neg = compareAudio(st(REF), st(scaled(REF, 10 ** (-0.2 / 20))));
    expect(neg.gainDb).toBeCloseTo(-0.2, 3); expect(neg.passed).toBe(false);
  });
  it('residual gate: independent noise at −55 dBFS passes, at −45 dBFS fails (measured residual ≈ the noise level)', () => {
    const plus = (dbfs: number) => { const n = noise(REF.length, 99), k = Math.sqrt(3) * 10 ** (dbfs / 20); return REF.map((v, i) => v + (i < 600 || i >= REF.length - 600 ? 0 : n[i] * k)); };
    const quiet = compareAudio(st(REF), st(plus(-55))), loud = compareAudio(st(REF), st(plus(-45)));
    expect(quiet.residualDb).toBeCloseTo(-55, 0); expect(quiet.passed).toBe(true);
    expect(loud.residualDb).toBeCloseTo(-45, 0); expect(loud.passed).toBe(false);
  });
  it('both signals silent: NaN level differences pass (written-spec: two silent signals agree)', () => {
    const z = new Float32Array(48000), r = compareAudio(st(z), st(z.slice()));
    expect(Number.isNaN(r.gainDb)).toBe(true); expect(r.passed).toBe(true); expect(r.lagMs).toBe(0);
  });
  it('silent vs audible fails in both directions', () => {
    const z = new Float32Array(REF.length);
    expect(compareAudio(st(REF), st(z)).passed).toBe(false); expect(compareAudio(st(z), st(REF)).passed).toBe(false);
  });
  it('exclude spans (frames of ref) are left out of every figure: a dropout fails without it and passes with it', () => {
    const drop = REF.slice(); drop.fill(0, 30000, 30480);
    expect(compareAudio(st(REF), st(drop)).passed).toBe(false);
    const ex = compareAudio(st(REF), st(drop), { exclude: [[30000, 30480]] });
    expect(ex.passed).toBe(true); expect(ex.residualDb).toBeLessThan(-120);
  });
  it('exclude spans are left out of the lag search too: a 200-frame-late first 60 000 frames sets the lag only when not excluded', () => {
    const late = delayed(REF, 200).subarray(0, REF.length).slice(); late.set(REF.subarray(60000), 60000);
    expect(compareAudio(st(REF), st(late)).lagMs).toBeCloseTo(200 * 1000 / FS, 1);
    const ex = compareAudio(st(REF), st(late), { exclude: [[0, 60200]] });
    expect(ex.lagMs).toBeCloseTo(0, 6); expect(ex.passed).toBe(true); expect(ex.residualDb).toBeLessThan(-120);
  });
  it('levels(keep): excluded frames count neither in RMS nor in peak; both channels pooled', () => {
    const l = new Float32Array(1000).fill(0.5), r = new Float32Array(1000).fill(0.5); l.fill(1, 0, 100); r.fill(1, 0, 100);
    const all = levels([l, r]), kept = levels([l, r], n => n >= 100);
    expect(all.peakDb).toBeCloseTo(0, 6); expect(kept.peakDb).toBeCloseTo(db(0.5), 6); expect(kept.rmsDb).toBeCloseTo(db(0.5), 6);
    expect(all.rmsDb).toBeCloseTo(db(Math.sqrt((100 * 1 + 900 * 0.25) / 1000)), 6);
    const mixed = levels([new Float32Array(1000).fill(1), new Float32Array(1000)]); expect(mixed.rmsDb).toBeCloseTo(db(Math.SQRT1_2), 6);
  });
  it('stereo: a channel-swapped test still has a lag, level and residual judged on both channels (swap fails the residual)', () => {
    const a = REF, b = body(96000, 600, 5), r = compareAudio([a, b], [b, a]);
    expect(r.passed).toBe(false); expect(r.residualDb).toBeGreaterThan(-20);
  });
});

describe('resamplePlanar (written-spec: sources not at 48 kHz are converted to the mix rate)', () => {
  it('44.1 kHz → 48 kHz: a 1 kHz sine keeps its frequency and phase (interior error < 2e-3), length ×48/44.1', () => {
    const x = Float32Array.from({ length: 44100 }, (_, n) => 0.8 * Math.sin(2 * Math.PI * 1000 * n / 44100)), [y] = resamplePlanar([x], 44100, 48000);
    expect(y.length).toBe(48000);
    let worst = 0; for (let j = 100; j < 47900; j++) worst = Math.max(worst, Math.abs(y[j] - 0.8 * Math.sin(2 * Math.PI * 1000 * j / 48000)));
    expect(worst, `worst interior error ${worst.toExponential(2)}`).toBeLessThan(2e-3);
    console.log(`[T13 resample] 44.1k→48k 1 kHz: worst interior error ${worst.toExponential(2)} (${db(worst / 0.8).toFixed(1)} dB re signal)`);
  });
  it('48 kHz → 48 kHz is the identity (bit-exact), with an integer offset shifting and zero-padding', () => {
    const x = noise(5000, 4), [y] = resamplePlanar([x], 48000, 48000);
    expect(Array.from(y)).toEqual(Array.from(x));
    const [s] = resamplePlanar([x], 48000, 48000, 10, 100); expect(Array.from(s)).toEqual(Array.from(x.subarray(10, 110)));
    const [z] = resamplePlanar([x], 48000, 48000, -3, 10); expect(Array.from(z.subarray(0, 3))).toEqual([0, 0, 0]); expect(Array.from(z.subarray(3))).toEqual(Array.from(x.subarray(0, 7)));
  });
  it('96 kHz → 48 kHz: a 10 kHz tone passes within 0.1 dB, a 30 kHz tone (would alias to 18 kHz) is attenuated (reported)', () => {
    const tone = (hz: number) => Float32Array.from({ length: 96000 }, (_, n) => 0.7 * Math.sin(2 * Math.PI * hz * n / 96000));
    const pass = resamplePlanar([tone(10000)], 96000, 48000)[0], stop = resamplePlanar([tone(30000)], 96000, 48000)[0];
    const passDb = db(rms(pass, 2000, 46000) / (0.7 * Math.SQRT1_2)), stopDb = db(rms(stop, 2000, 46000) / (0.7 * Math.SQRT1_2));
    console.log(`[T13 resample] 96k→48k: 10 kHz ${passDb.toFixed(3)} dB, 30 kHz (aliases to 18 kHz) ${stopDb.toFixed(1)} dB`);
    expect(Math.abs(passDb)).toBeLessThan(0.1); expect(stopDb).toBeLessThan(-40);
  });
  it('44.1 kHz → 48 kHz of noise-free DC stays DC (interior), 2-channel data is converted per channel', () => {
    const [a, b] = resamplePlanar([new Float32Array(44100).fill(0.5), new Float32Array(44100).fill(-0.25)], 44100, 48000);
    for (const j of [200, 20000, 47000]) { expect(a[j]).toBeCloseTo(0.5, 3); expect(b[j]).toBeCloseTo(-0.25, 3); }
  });
});
