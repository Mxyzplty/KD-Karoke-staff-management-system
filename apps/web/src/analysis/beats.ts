// SPDX-License-Identifier: AGPL-3.0-only
import { median, mono, silences } from './audio';
import { AnalysisError, type BeatAnalysis, type Pair, type Pcm } from './types';

/** In-place radix-2 complex FFT; `re.length` is a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len, wr = Math.cos(angle), wi = Math.sin(angle), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const next = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = next;
      }
    }
  }
}

/**
 * Dense-music beat tracker after Ellis 2007. The onset envelope is our own, not librosa's default
 * mel onset strength: spectral flux over 24 log-spaced bands from 30 Hz to 8 kHz (32 ms Hann window,
 * dB with an 80 dB range, lag 1, mean over bands). Its low bands overlap on FFT bins below about
 * 150 Hz, so it leans towards the kick. A librosa-default 128-band mel envelope was tried and not
 * adopted (T19a notes, fix round 2). Then autocorrelation tempo under a log-normal prior (120 BPM, one
 * octave), dynamic-programming beat placement (tightness 100), and the standard trim of weak
 * leading/trailing beats. The trim test is also applied inside: a beat is dropped when both its own
 * onset and its neighbourhood are weak. The tracker constants are librosa's published defaults, not
 * fitted to any reference. Positions are `hop` frames.
 */
function trackBeats(samples: Float32Array, rate: number, hop: number) {
  const size = Math.round(0.032 * rate), bands = 24;
  let n = 1;
  while (n < size) n *= 2;
  const window = Float64Array.from({ length: size }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / size));
  const edges = Array.from({ length: bands + 1 }, (_, b) => 30 * (8000 / 30) ** (b / bands));
  const ranges = edges.slice(0, bands).map((low, b) => {
    const first = Math.min(n / 2 - 1, Math.floor(low * n / rate));
    return [first, Math.max(first + 1, Math.min(n / 2, Math.ceil(edges[b + 1] * n / rate)))];
  });
  const re = new Float64Array(n), im = new Float64Array(n), levels: Float64Array[] = [];
  let top = -Infinity;
  for (let f = 0; f * hop < samples.length; f++) {
    re.fill(0); im.fill(0);
    const from = f * hop - (size >> 1);
    for (let k = Math.max(0, -from); k < size && from + k < samples.length; k++) re[k] = samples[from + k] * window[k];
    fft(re, im);
    const row = new Float64Array(bands);
    ranges.forEach(([a, b], band) => {
      let power = 0;
      for (let k = a; k < b; k++) power += re[k] * re[k] + im[k] * im[k];
      row[band] = 10 * Math.log10(power + 1e-10);
      if (row[band] > top) top = row[band];
    });
    levels.push(row);
  }
  const floor = top - 80;
  const envelope = levels.map((row, f) => {
    if (!f) return 0;
    let flux = 0;
    for (let b = 0; b < bands; b++) flux += Math.max(0, Math.max(row[b], floor) - Math.max(levels[f - 1][b], floor));
    return flux / bands;
  });
  const dt = hop / rate, mean = envelope.reduce((a, b) => a + b, 0) / Math.max(1, envelope.length);
  const minLag = Math.max(2, Math.round(60 / 240 / dt)), maxLag = Math.min(envelope.length - 2, Math.round(60 / 40 / dt));
  if (maxLag <= minLag) return { positions: [] as number[], strengths: [] as number[] };
  const tempoScore: number[] = [];
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = lag; i < envelope.length; i++) sum += (envelope[i] - mean) * (envelope[i - lag] - mean);
    tempoScore.push(sum * Math.exp(-0.5 * Math.log2(60 / (lag * dt) / 120) ** 2));
  }
  let peak = 1;
  for (let j = 2; j < tempoScore.length - 1; j++) if (tempoScore[j] > tempoScore[peak]) peak = j;
  const [left, centre, right] = tempoScore.slice(peak - 1, peak + 2), curve = left - 2 * centre + right;
  const period = minLag - 1 + peak + (curve < 0 ? 0.5 * (left - right) / curve : 0);
  const deviation = Math.sqrt(envelope.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, envelope.length - 1)) || 1;
  // The kernel sum grows with the frame rate; rescale to librosa's default frame period (512/22050 s)
  // so that tightness 100 weighs tempo deviations as it does there.
  const reach = Math.round(period), scale = dt / (512 / 22050);
  const kernel = Array.from({ length: 2 * reach + 1 }, (_, j) => scale * Math.exp(-0.5 * ((j - reach) * 32 / period) ** 2));
  const local = envelope.map((_, i) => {
    let sum = 0;
    for (let j = Math.max(-reach, -i); j <= reach && i + j < envelope.length; j++) sum += envelope[i + j] / deviation * kernel[j + reach];
    return sum;
  });
  const tightness = 100, shortest = Math.round(period / 2), longest = Math.round(2 * period);
  const threshold = 0.01 * local.reduce((a, b) => Math.max(a, b), 0);
  const cumulative = new Float64Array(local.length), backlink = new Int32Array(local.length).fill(-1);
  let started = false;
  for (let i = 0; i < local.length; i++) {
    let best = -Infinity, from = -1;
    if (started || local[i] >= threshold) for (let d = shortest; d <= longest && d <= i; d++) {
      const score = cumulative[i - d] - tightness * Math.log(d / period) ** 2;
      if (score > best) { best = score; from = i - d; }
    }
    cumulative[i] = local[i] + (from < 0 ? 0 : best);
    backlink[i] = from;
    if (local[i] >= threshold) started = true;
  }
  const maxima: number[] = [];
  for (let i = 0; i < cumulative.length; i++) if (cumulative[i] > (cumulative[i - 1] ?? cumulative[i]) && cumulative[i] >= (cumulative[i + 1] ?? cumulative[i])) maxima.push(i);
  const typical = median(maxima.map(i => cumulative[i]));
  const beats: number[] = [];
  for (let i = maxima.filter(i => cumulative[i] * 2 > typical).at(-1) ?? -1; i >= 0; i = backlink[i]) beats.push(i);
  beats.reverse();
  const own = beats.map(i => local[i]);
  const around = own.map((v, k) => 0.5 * (own[k - 1] ?? 0) + v + 0.5 * (own[k + 1] ?? 0));
  const weak = (values: number[]) => 0.5 * Math.sqrt(values.reduce((s, v) => s + v * v, 0) / Math.max(1, values.length));
  const ownLimit = weak(own), aroundLimit = weak(around);
  const first = around.findIndex(v => v > aroundLimit), last = around.reduce((at, v, k) => v > aroundLimit ? k : at, -1);
  const kept = beats.map((_, k) => k).filter(k => k >= first && k <= last && (around[k] > aroundLimit || own[k] > ownLimit));
  // Whole frames quantise the median interval (5 ms is 1.2 % at 140 BPM): place each beat at the
  // parabolic peak of the local score, when it sits on one, for a sub-frame position.
  const refine = (i: number) => {
    const [a, b, c] = [local[i - 1], local[i], local[i + 1]], curve = a - 2 * b + c;
    return a === undefined || c === undefined || b < a || b < c || curve >= 0 ? i : i + 0.5 * (a - c) / curve;
  };
  return { positions: kept.map(k => refine(beats[k])), strengths: kept.map(k => own[k]) };
}

/**
 * Deterministic energy-onset / periodicity tracker. Classification belongs to the local sound model.
 * `learned` (BeatThis, T19q round B4) replaces the dense-music tracker's beats when given;
 * the dense/sparse decision and everything after the beat positions are unchanged.
 */
export function detectBeats(pcm: Pcm, assetType: string, isMusic: boolean, name = 'audio', learned?: { times: number[]; strengths: number[] }): BeatAnalysis {
  if (assetType !== 'audio') throw new AnalysisError('BEATS_NOT_AUDIO', `'${name}' is a ${assetType} item. Beat data exists only for music audio.`);
  if (!isMusic) throw new AnalysisError('BEATS_NOT_MUSIC', `'${name}' is not tagged as music (its analysis treats it as speech or sound), so it has no beat data.`);
  const samples = mono(pcm), rate = pcm.sampleRate, hop = Math.max(1, Math.round(rate * 0.005));
  const energy: number[] = [], low: number[] = [];
  let filtered = 0;
  const alpha = 1 - Math.exp(-2 * Math.PI * 140 / rate);
  for (let at = 0; at < samples.length; at += hop) {
    let sum = 0, bass = 0;
    for (let j = at; j < Math.min(samples.length, at + hop); j++) { sum += samples[j] ** 2; filtered += alpha * (samples[j] - filtered); bass += filtered ** 2; }
    energy.push(Math.sqrt(sum / hop)); low.push(Math.sqrt(bass / hop));
  }
  const novelty = energy.map((e, i) => Math.max(0, e - median(energy.slice(Math.max(0, i - 20), i))));
  const floor = median(novelty), mad = median(novelty.map(n => Math.abs(n - floor)));
  // reduce, not a spread: a long input exceeds the engine's argument limit.
  const threshold = Math.max(0.012, floor + mad * 6, novelty.reduce((a, b) => Math.max(a, b), 0) * 0.06);
  const peaks: number[] = [];
  for (let i = 1; i < novelty.length - 1; i++) {
    if (novelty[i] < threshold || novelty[i] < novelty[i - 1] || novelty[i] <= novelty[i + 1]) continue;
    const previous = peaks.at(-1);
    if (previous !== undefined && i - previous < 14) { if (novelty[i] > novelty[previous]) peaks[peaks.length - 1] = i; }
    else peaks.push(i);
  }
  const quiet = silences(samples, rate, 0.75);
  let positions = peaks;
  const intervals = peaks.slice(1).map((p, i) => (p - peaks[i]) * hop / rate), centre = median(intervals);
  const changes = intervals.slice(1).filter((d, i) => Math.abs(Math.log(d / intervals[i])) > Math.log(1.15)).length;
  let regularGrid = false;
  // Sparse unambiguous attacks retain local tempo changes. Dense percussion uses a metrical grid.
  let strengths = positions.map(i => novelty[i]);
  if (peaks.length >= 4 && (centre < 0.28 || centre > 0.75 || changes > intervals.length * 0.1)) {
    regularGrid = true;
    ({ positions, strengths } = learned ? { positions: learned.times.map(t => t * rate / hop), strengths: learned.strengths } : trackBeats(samples, rate, hop));
    const kept = positions.map((p, i) => [p, strengths[i]]).filter(([p]) => !quiet.some(([a, b]) => p * hop / rate >= a && p * hop / rate < b));
    positions = kept.map(k => k[0]); strengths = kept.map(k => k[1]);
  }
  const peakMax = strengths.reduce((a, b) => Math.max(a, b), 1e-9);
  const beats: Pair[] = positions.map((i, k) => {
    // Locate the beginning of the energy rise rather than its maximum.
    let start = i;
    while (!regularGrid && start > Math.max(0, i - 4) && novelty[start - 1] > novelty[i] * 0.15) start--;
    return [start * hop / rate, Math.min(1, strengths[k] / peakMax)];
  });
  const bassRatios = positions.map(position => {
    let bass = 0, all = 0;
    const i = Math.round(position);
    for (let j = i; j < Math.min(i + 10, energy.length); j++) { bass += low[j] ** 2; all += energy[j] ** 2; }
    return bass / Math.max(1e-10, all);
  });
  // Infer triple/quadruple accent periodicity. Equal click attacks default to four.
  let meter = 4, phase = 0, bestContrast = 0.1;
  for (const n of [3, 4]) for (let p = 0; p < n; p++) {
    const accented = bassRatios.filter((_, i) => i % n === p), other = bassRatios.filter((_, i) => i % n !== p);
    const contrast = accented.reduce((a, b) => a + b, 0) / Math.max(1, accented.length) - other.reduce((a, b) => a + b, 0) / Math.max(1, other.length);
    if (contrast > bestContrast) { bestContrast = contrast; meter = n; phase = p; }
  }
  const downbeats = beats.filter((_, i) => i % meter === phase);
  const distances = beats.slice(1).flatMap(([end], i) => {
    const start = beats[i][0];
    return quiet.some(([a, b]) => a < end && b > start) ? [] : [end - start];
  }).filter(x => x > 0);
  const period = median(distances), bpm = period ? 60 / period : null;
  const averageBpm = distances.length ? 60 / (distances.reduce((a, b) => a + b, 0) / distances.length) : null;
  const tempoType = !bpm ? 'unknown' : distances.some(d => Math.abs(d - period) > period * 0.08) ? 'variable' : 'constant';
  const stored = { bpm, averageBpm, beats, downbeats, silences: quiet };
  return { stored, tab: { bpm, beats, onsets: peaks.map(i => [i * hop / rate, Math.min(1, novelty[i] / peakMax)]), silences: quiet, firstBeat: beats[0]?.[0] ?? null, tempoType } };
}
