// SPDX-License-Identifier: AGPL-3.0-only
import { AnalysisError, type Pcm, type Pair } from './types';

export function validatePcm(pcm: Pcm) {
  if (!Number.isInteger(pcm.sampleRate) || pcm.sampleRate <= 0 || pcm.channels < 1 || pcm.data.length !== pcm.channels || pcm.data.some(p => p.length !== pcm.data[0].length)) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'Expected equally sized planar PCM channels and a positive sample rate.');
  for (const plane of pcm.data) for (const value of plane) if (!Number.isFinite(value)) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'PCM contains a non-finite sample.');
}
export function mono(pcm: Pcm) {
  validatePcm(pcm);
  const result = new Float32Array(pcm.data[0].length);
  for (const channel of pcm.data) for (let i = 0; i < result.length; i++) result[i] += channel[i] / pcm.channels;
  return result;
}
/** Windowed-sinc low-pass resampling, including anti-aliasing when downsampling. */
export function resample(pcm: Pcm, rate = 16000) {
  const input = mono(pcm);
  if (pcm.sampleRate === rate) return input;
  const scale = pcm.sampleRate / rate, cutoff = Math.min(1, 1 / scale), radius = Math.ceil(16 / cutoff);
  const output = new Float32Array(Math.round(input.length / scale));
  for (let i = 0; i < output.length; i++) {
    const at = i * scale;
    let sum = 0, weight = 0;
    for (let j = Math.ceil(at - radius); j <= Math.floor(at + radius); j++) {
      if (j < 0 || j >= input.length) continue;
      const d = (at - j) * cutoff, sinc = Math.abs(d) < 1e-10 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * (at - j) / radius));
      sum += w * input[j]; weight += w;
    }
    output[i] = weight ? sum / weight : 0;
  }
  return output;
}
export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b), k = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[k] : (sorted[k - 1] + sorted[k]) / 2;
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length || [...a, ...b].some(x => !Number.isFinite(x))) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'Embeddings must have equal, nonzero dimensions and finite values.');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : 0;
}
/** Silence intervals in source seconds; absolute -45 dBFS RMS, 10 ms windows. */
export function silences(samples: Float32Array, rate: number, minimum = 0.1): Pair[] {
  const hop = Math.max(1, Math.round(rate / 100)), result: Pair[] = [];
  let start: number | null = null;
  for (let i = 0; i <= samples.length; i += hop) {
    let power = 0;
    const end = Math.min(i + hop, samples.length);
    for (let j = i; j < end; j++) power += samples[j] ** 2;
    const quiet = i < samples.length && Math.sqrt(power / Math.max(1, end - i)) < 10 ** (-45 / 20);
    if (quiet && start === null) start = i / rate;
    if (!quiet && start !== null) { if (i / rate - start >= minimum) result.push([start, Math.min(i, samples.length) / rate]); start = null; }
  }
  return result;
}
