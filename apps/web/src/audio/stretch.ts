// SPDX-License-Identifier: AGPL-3.0-only
// "Keep pitch" (T13, an optional per-clip switch, off by default): WSOLA time-stretch driven by the clip's own source
// positions, so it follows constant speed, time remap and reverse alike. Grains of GRAIN frames (periodic Hann, 50 %
// overlap: the windows sum to 1) are centred every HOP output frames; grain j copies the source around the position the
// clip reads at its centre, shifted by up to ±SEARCH frames to the offset whose start best continues the previous grain
// (normalised cross-correlation of the mono sum, coarse every COARSE frames on every 4th sample, then refined frame by
// frame). The chain of shifts restarts every CHAIN grains at a fixed grain index, so a chunked render (preview chunks,
// export chunks) gives the same samples as one long render. Parameters pre-registered in the T13 notes before any run.
// Cost (review M2): each grain's mono samples are read once into scratch arrays, four offsets are scored per pass (each sum
// in its own order), and a caller rendering in order (preview)
// passes a Chain so the next call continues the chain instead of replaying it from the restart; the arithmetic, and so
// every sample, is the same either way.
export const GRAIN = 1920, HOP = GRAIN / 2, SEARCH = 480, COARSE = 8, CHAIN = 50;
const WINDOW = Float32Array.from({ length: GRAIN }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / GRAIN));
/** Grain index → its start (source frame), kept between calls on one clip; a kept grain is not searched again; entries
 *  before the last call's first grain go. */
export type Chain = Map<number, number>;

/** Planar source window: frame x of the source is L[x − base], 0 outside. */
type Window = { L: Float32Array; R: Float32Array; base: number };
const candidates = new Float64Array(HOP + 2 * SEARCH), continuation = new Float64Array(HOP);
/** Mono sum of frames [from, from + out.length) into out (0 outside the window). */
function mono(src: Window, from: number, out: Float64Array) {
  const { L, R, base } = src, n = L.length;
  for (let i = 0; i < out.length; i++) { const p = from + i - base; out[i] = p >= 0 && p < n ? 0.5 * (L[p] + R[p]) : 0; }
}
/** Normalised cross-correlation of candidate offset d against the continuation, every `step`-th sample (bb: its energy). */
function score(d: number, step: number, bb: number) {
  let ab = 0, aa = 0;
  for (let i = 0, c = SEARCH + d; i < HOP; i += step) { const x = candidates[c + i], y = continuation[i]; ab += x * y; aa += x * x; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
const scores = new Float64Array(4);
/** score() of offsets d, d + gap, d + 2 gap, d + 3 gap into `scores`: four independent sums per pass, each added in
 *  score's own order, so each value is score's exactly (the sums' add latency no longer runs one after another). */
function score4(d: number, gap: number, step: number, bb: number) {
  let ab0 = 0, aa0 = 0, ab1 = 0, aa1 = 0, ab2 = 0, aa2 = 0, ab3 = 0, aa3 = 0;
  const c0 = SEARCH + d, c1 = c0 + gap, c2 = c1 + gap, c3 = c2 + gap;
  for (let i = 0; i < HOP; i += step) {
    const y = continuation[i];
    let x = candidates[c0 + i]; ab0 += x * y; aa0 += x * x;
    x = candidates[c1 + i]; ab1 += x * y; aa1 += x * x;
    x = candidates[c2 + i]; ab2 += x * y; aa2 += x * x;
    x = candidates[c3 + i]; ab3 += x * y; aa3 += x * x;
  }
  scores[0] = aa0 > 0 && bb > 0 ? ab0 / Math.sqrt(aa0 * bb) : 0; scores[1] = aa1 > 0 && bb > 0 ? ab1 / Math.sqrt(aa1 * bb) : 0;
  scores[2] = aa2 > 0 && bb > 0 ? ab2 / Math.sqrt(aa2 * bb) : 0; scores[3] = aa3 > 0 && bb > 0 ? ab3 / Math.sqrt(aa3 * bb) : 0;
}
/** The best offset in [lo, hi] every `gap` frames, in ascending order (the first of equal scores wins, as one by one). */
function search(lo: number, hi: number, gap: number, step: number, bb: number, best: { d: number; top: number }) {
  let d = lo;
  for (; d + 3 * gap <= hi; d += 4 * gap) {
    score4(d, gap, step, bb);
    for (let k = 0; k < 4; k++) if (scores[k] > best.top) { best.top = scores[k]; best.d = d + k * gap; }
  }
  for (; d <= hi; d += gap) { const s = score(d, step, bb); if (s > best.top) { best.top = s; best.d = d; } }
}
const found = { d: 0, top: -Infinity };
function bestShift(src: Window, centre: number, next: number) {
  mono(src, centre - HOP - SEARCH, candidates); mono(src, next, continuation);
  let bb4 = 0, bb1 = 0;
  for (let i = 0; i < HOP; i += 4) bb4 += continuation[i] * continuation[i];
  for (let i = 0; i < HOP; i++) bb1 += continuation[i] * continuation[i];
  found.d = 0; found.top = -Infinity;
  search(-SEARCH, SEARCH, COARSE, 4, bb4, found);
  const coarse = found.d;
  search(Math.max(-SEARCH, coarse - COARSE + 1), Math.min(SEARCH, coarse + COARSE - 1), 1, 1, bb1, found);
  return found.d;
}
/**
 * Adds the stretched clip into out[n] for n in [n0, n1) of the mix (left / right), times gain(n).
 * `position(k)` = source frame (fractional) the clip reads at clip frame k (k = 0 at the clip start); `clipStart` = the
 * mix frame of clip frame 0 (may be negative). Source frames are read from L / R (source frame x at index x − base).
 * `chain`: the clip's chain state from earlier calls in this order of rendering (optional; the samples do not depend on it).
 */
export function stretchInto(out: [Float32Array, Float32Array], n0: number, n1: number, clipStart: number, position: (k: number) => number,
  L: Float32Array, R: Float32Array, base: number, gain: (n: number) => number, chain?: Chain) {
  const src: Window = { L, R, base }, size = L.length;
  const first = Math.max(0, Math.floor((n0 - clipStart) / HOP) - 1), last = Math.ceil((n1 - clipStart) / HOP) + 1;
  // Replay the chain from its restart point (or the latest kept grain after it) up to the first grain that touches [n0, n1).
  let j = first - (first % CHAIN), start = Math.round(position(j * HOP)) - HOP;
  if (chain) for (const [k, s] of chain) if (k > j && k <= first) { j = k; start = s; }
  for (; j < first; ) { j++; start = j % CHAIN === 0 ? Math.round(position(j * HOP)) - HOP : Math.round(position(j * HOP)) + bestShift(src, Math.round(position(j * HOP)), start + HOP) - HOP; }
  for (; j <= last; j++) {
    const kept = j > first ? chain?.get(j) : undefined; // the previous call's last grains (its lookahead) are kept
    if (kept !== undefined) start = kept;
    else if (j > first) {
      const centre = Math.round(position(j * HOP));
      start = j % CHAIN === 0 ? centre - HOP : centre - HOP + bestShift(src, centre, start + HOP);
    }
    chain?.set(j, start);
    const o = clipStart + j * HOP - HOP; // grain j spans output [o, o + GRAIN), centred on clip frame j × HOP
    for (let i = Math.max(0, n0 - o), end = Math.min(GRAIN, n1 - o); i < end; i++) {
      const n = o + i, w = WINDOW[i] * gain(n), p = start + i - base;
      out[0][n] += w * (p >= 0 && p < size ? L[p] : 0); out[1][n] += w * (p >= 0 && p < size ? R[p] : 0);
    }
  }
  if (chain) for (const k of chain.keys()) if (k < first) chain.delete(k);
}
