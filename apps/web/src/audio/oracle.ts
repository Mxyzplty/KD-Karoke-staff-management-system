// SPDX-License-Identifier: AGPL-3.0-only
// The audio oracle (master plan §4): align the tested audio to the reference by cross-correlation (lag ≤ 1 ms), then
// compare RMS level and peak (±0.1 dB) and the residual after alignment (≤ −50 dBFS RMS). Levels are dBFS of the stereo
// signal (both channels pooled); excluded spans (e.g. the 10 ms after each clip start, G-09) are left out of every figure.
import type { Stereo } from './mix';

export const AUDIO_GATES = { lagMs: 1, gainDb: 0.1, peakDb: 0.1, residualDb: -50 };
export const dB = (x: number) => x > 0 ? 20 * Math.log10(x) : -Infinity;

function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}
const mono = (s: Stereo) => s[0].map((x, i) => 0.5 * (x + s[1][i]));
/** Frames by which `test` is late against `ref` (test[n + lag] ≈ ref[n]), searched within ±maxLag, with a parabolic
 *  sub-frame refinement. */
export function lagFrames(ref: Stereo, test: Stereo, maxLag: number): number {
  const a = mono(ref), b = mono(test);
  let size = 1; while (size < a.length + b.length) size <<= 1;
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(a); br.set(b); fft(ar, ai); fft(br, bi);
  for (let i = 0; i < size; i++) { const r = br[i] * ar[i] + bi[i] * ai[i], m = bi[i] * ar[i] - br[i] * ai[i]; br[i] = r; bi[i] = m; } // B · conj(A)
  fft(br, bi, true);
  const at = (lag: number) => br[(lag + size) % size];
  let best = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) if (at(lag) > at(best)) best = lag;
  const y0 = at(best - 1), y1 = at(best), y2 = at(best + 1), d = y0 - 2 * y1 + y2;
  return d < 0 ? best + 0.5 * (y0 - y2) / d : best;
}
export type Levels = { rmsDb: number; peakDb: number };
export function levels(s: Stereo, keep: (n: number) => boolean = () => true): Levels {
  let sum = 0, count = 0, peak = 0;
  for (let n = 0; n < s[0].length; n++) {
    if (!keep(n)) continue;
    for (const ch of s) { sum += ch[n] * ch[n]; peak = Math.max(peak, Math.abs(ch[n])); }
    count += 2;
  }
  return { rmsDb: dB(Math.sqrt(sum / Math.max(1, count))), peakDb: dB(peak) };
}
export type AudioComparison = { lagMs: number; ref: Levels; test: Levels; gainDb: number; peakDb: number; residualDb: number; passed: boolean };
/** Compares two equal-rate stereo signals: lag (searched within ±maxLagMs), then levels and residual on the overlap after
 *  shifting `test` by the whole-frame lag. `exclude` holds [from, to) frame spans of `ref` left out, of the lag search
 *  too: both signals are blanked there before the cross-correlation. */
export function compareAudio(ref: Stereo, test: Stereo, options: { sampleRate?: number; maxLagMs?: number; exclude?: [number, number][] } = {}): AudioComparison {
  const spans = options.exclude ?? [], keep = (i: number) => !spans.some(([a, b]) => i >= a && i < b);
  const blank = (s: Stereo) => (spans.length ? s.map(ch => { const c = ch.slice(); for (const [a, b] of spans) c.fill(0, Math.max(0, a), Math.min(c.length, b)); return c; }) : s) as Stereo;
  const rate = options.sampleRate ?? 48000, lag = lagFrames(blank(ref), blank(test), Math.round((options.maxLagMs ?? 50) * rate / 1000)), shift = Math.round(lag);
  const n = ref[0].length, shifted: Stereo = [new Float32Array(n), new Float32Array(n)], residual: Stereo = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) { const j = i + shift; shifted[c][i] = j >= 0 && j < test[c].length ? test[c][i + shift] : 0; residual[c][i] = shifted[c][i] - ref[c][i]; }
  const r = levels(ref, keep), t = levels(shifted, keep), res = levels(residual, keep).rmsDb, lagMs = lag * 1000 / rate;
  const gainDb = t.rmsDb - r.rmsDb, peakDb = t.peakDb - r.peakDb;
  const close = (x: number, gate: number) => Number.isNaN(x) || Math.abs(x) <= gate; // NaN = −∞ − (−∞): two silent signals agree
  const passed = Math.abs(lagMs) <= AUDIO_GATES.lagMs && close(gainDb, AUDIO_GATES.gainDb) && close(peakDb, AUDIO_GATES.peakDb) && res <= AUDIO_GATES.residualDb;
  return { lagMs, ref: r, test: t, gainDb, peakDb, residualDb: res, passed };
}
