// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BeatThis (Foscarin, Schlüter, Widmer, ISMIR 2024; CPJKU/beat_this @ b95c8ab0, MIT) around the ONNX
 * export of a fold checkpoint (T19q round B4: fold0 ships; folds 1-7 only score the Groove validation set).
 * Ported from beat_this.preprocessing, beat_this.inference and the "minimal" postprocessor; the only addition
 * is sub-frame peak refinement (see `refine`).
 */
import { fft } from './beats';
import { resample } from './audio';
import type { Pcm } from './types';

const RATE = 22050, N_FFT = 1024, HOP = 441, MELS = 128, F_MIN = 30, F_MAX = 11000, FPS = 50, CHUNK = 1500, BORDER = 6;

/** torchaudio's Slaney mel scale. */
const hzToMel = (hz: number) => hz < 1000 ? hz * 3 / 200 : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27);
const melToHz = (mel: number) => mel < 15 ? mel * 200 / 3 : 1000 * Math.exp(Math.log(6.4) / 27 * (mel - 15));

/** torchaudio.functional.melscale_fbanks(513, 30, 11000, 128, 22050, norm=None, mel_scale="slaney"), [bin][mel]. */
const filterbank = (() => {
  const bins = N_FFT / 2 + 1, nyquist = Math.floor(RATE / 2);
  const points = Array.from({ length: MELS + 2 }, (_, i) => melToHz(hzToMel(F_MIN) + (hzToMel(F_MAX) - hzToMel(F_MIN)) * i / (MELS + 1)));
  const bank = new Float64Array(bins * MELS);
  for (let k = 0; k < bins; k++) {
    const freq = nyquist * k / (bins - 1);
    for (let m = 0; m < MELS; m++) {
      const down = (freq - points[m]) / (points[m + 1] - points[m]), up = (points[m + 2] - freq) / (points[m + 2] - points[m + 1]);
      bank[k * MELS + m] = Math.max(0, Math.min(down, up));
    }
  }
  return bank;
})();

/**
 * LogMelSpect: torchaudio MelSpectrogram at 22050 Hz (n_fft 1024, hop 441, periodic Hann, centred with
 * reflect padding, STFT scaled by 1/sqrt(1024), magnitude, 128 Slaney bands 30-11000 Hz), then
 * log1p(1000 x). Row-major [frames][128] at 50 frames per second.
 */
export function logMel(samples: Float32Array) {
  const half = N_FFT / 2, frames = 1 + Math.floor(samples.length / HOP), out = new Float32Array(frames * MELS);
  const at = (i: number) => samples[i < 0 ? -i : i >= samples.length ? 2 * samples.length - 2 - i : i];
  const window = Float64Array.from({ length: N_FFT }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N_FFT));
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), magnitude = new Float64Array(half + 1);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < N_FFT; k++) { re[k] = at(f * HOP - half + k) * window[k]; im[k] = 0; }
    fft(re, im);
    for (let k = 0; k <= half; k++) magnitude[k] = Math.hypot(re[k], im[k]) / Math.sqrt(N_FFT);
    for (let m = 0; m < MELS; m++) {
      let sum = 0;
      for (let k = 0; k <= half; k++) sum += magnitude[k] * filterbank[k * MELS + m];
      out[f * MELS + m] = Math.log1p(1000 * sum);
    }
  }
  return { spect: out, frames };
}

/**
 * split_predict_aggregate: chunks of 1500 frames overlapping by the 6-frame border the model was not
 * trained on, the first and last zero-padded by it, the last moved left to end at the piece end (a piece
 * under 1488 frames is one shorter chunk); predictions lose their borders and earlier chunks win overlaps.
 */
export async function framewiseLogits(spect: Float32Array, frames: number, model: (chunk: Float32Array, frames: number) => Promise<Float32Array>) {
  const starts: number[] = [];
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
  if (frames > CHUNK - 2 * BORDER) starts[starts.length - 1] = frames - (CHUNK - BORDER);
  const predictions: Float32Array[] = [];
  for (const s of starts) {
    const from = Math.max(s, 0), to = Math.min(s + CHUNK, frames), left = Math.max(0, -s), right = Math.max(0, Math.min(BORDER, s + CHUNK - frames));
    const length = left + to - from + right, chunk = new Float32Array(length * MELS);
    chunk.set(spect.subarray(from * MELS, to * MELS), left * MELS);
    predictions.push((await model(chunk, length)).slice(BORDER, length - BORDER));
  }
  const logits = new Float32Array(frames).fill(-1000);
  for (let i = starts.length - 1; i >= 0; i--) logits.set(predictions[i].subarray(0, Math.min(starts[i] + CHUNK - BORDER, frames) - starts[i] - BORDER), starts[i] + BORDER);
  return logits;
}

/**
 * The minimal postprocessor for beats: frames that equal the maximum within +/-3 frames (70 ms) and have
 * a logit above 0, runs of adjacent frames replaced by their running mean. Then, an addition: a peak on a
 * single frame moves to the vertex of the parabola through its logit and its neighbours', because
 * `detectBeats` reports BPM from the median interval and whole 20 ms frames quantise it (2 % at 128 BPM).
 * Strength is the sigmoid of the peak frame's logit.
 */
export function beatPeaks(logits: Float32Array) {
  const frames: number[] = [];
  for (let t = 0; t < logits.length; t++) {
    let max = -Infinity;
    for (let k = Math.max(0, t - 3); k <= Math.min(logits.length - 1, t + 3); k++) max = Math.max(max, logits[k]);
    if (logits[t] === max && logits[t] > 0) frames.push(t);
  }
  const merged: number[] = [];
  for (let i = 0; i < frames.length;) {
    let p = frames[i], c = 1;
    for (i++; i < frames.length && frames[i] - p <= 1; i++) { c++; p += (frames[i] - p) / c; }
    merged.push(p);
  }
  const refine = (p: number) => {
    if (!Number.isInteger(p) || p < 1 || p > logits.length - 2) return p;
    const [a, b, c] = [logits[p - 1], logits[p], logits[p + 1]], curve = a - 2 * b + c;
    return curve < 0 ? p + 0.5 * (a - c) / curve : p;
  };
  return { times: merged.map(p => refine(p) / FPS), strengths: merged.map(p => 1 / (1 + Math.exp(-logits[Math.round(p)]))) };
}

/** Beat times (s) and strengths from the learned tracker; `model` runs the ONNX graph on one chunk. */
export async function learnedBeats(pcm: Pcm, model: (chunk: Float32Array, frames: number) => Promise<Float32Array>) {
  const { spect, frames } = logMel(resample(pcm, RATE));
  return beatPeaks(await framewiseLogits(spect, frames, model));
}
