// SPDX-License-Identifier: AGPL-3.0-only
// T13 output limiter, the tracked gain rule (findings §7 l.109, corrected 27 Nov; Author, 27 Nov 01:00: "copy the reference
// limiter's whole gain rule, not only the release target"). Oracle: "written-spec" = reference() below, written from that text,
// not from limiter.ts. Material: a steady stereo 1 kHz tone at amplitude 2 (about 7 dB over the ceiling). Its sampled peaks are
// exactly 2, every 24 frames, so every window of L + 1 = 241 frames holds one: a flat sliding minimum of the needed gain holds the
// gain at ceiling ÷ 2 on every frame, with or without a release toward 1 (Author: "a release-only change must stay red on it").
// Under the tracked rule the gain lifts slightly between the peaks and the eased limit pulls it back down at each peak.
import { describe, it, expect } from 'vitest';
import { Limiter } from '../apps/web/src/audio/limiter';
import { FS } from './t13-support';

/** The rule, from l.109's text: L = max(1, round(fs × 5 ms)); needed gain = ceiling ÷ linked peak above the ceiling, else 1;
 *  limit(k) = min over j in k…k+L of needed(j) + (j − k)/L; each frame g ← g + (1 − g)(1 − e^(−1/(fs × 50 ms))), then
 *  g = min(g, limit(k)), then within 1e-9 of 1 it snaps to 1 (the text's order); output k = input k × g, no shift; non-finite
 *  samples → 0. Frames past the buffer count as silence (needed gain 1), as the final flush's silent frames do. */
function reference(left: Float32Array, right: Float32Array, length: number, fs = FS) {
  const L = Math.max(1, Math.round(fs * 0.005)), ceiling = 10 ** (-1 / 20), step = 1 - Math.exp(-1 / (fs * 0.05));
  const clean = (v: number) => (Number.isFinite(v) ? v : 0);
  const need = Array.from(left, (v, j) => { const p = Math.max(Math.abs(clean(v)), Math.abs(clean(right[j]))); return p > ceiling ? ceiling / p : 1; });
  const out = [new Float32Array(length), new Float32Array(length)];
  let g = 1;
  for (let k = 0; k < length; k++) {
    let limit = Infinity;
    for (let j = k; j <= k + L; j++) limit = Math.min(limit, (j < need.length ? need[j] : 1) + (j - k) / L);
    g = Math.min(g + (1 - g) * step, limit);
    if (1 - g < 1e-9) g = 1;
    out[0][k] = clean(left[k]) * g; out[1][k] = clean(right[k]) * g;
  }
  return out;
}

const A = 2, HZ = 1000, N = 4800, LOOK = Math.max(1, Math.round(FS * 0.005)), CEIL = 10 ** (-1 / 20);
// Float32 output: the reference rounds input × gain to float32 as the limiter does, so the two differ by the float32 rounding of
// the needed gain and of the product (about 1e-7 here); 1e-6 is that with margin, and 10⁴ below the first frame that differs.
const TOL = 1e-6;
/** N frames of the tone plus LOOK frames of its continuation (the lookahead the callers render past the range). */
function tone() {
  const l = Float32Array.from({ length: N + LOOK }, (_, i) => A * Math.sin(2 * Math.PI * HZ * i / FS));
  return [l, l.map(v => -0.7 * v)] as const;
}
/** The limiter as its callers use it: per call, the call's frames plus LOOK frames of lookahead, the gain carried. */
function limited(cuts: number[] = []) {
  const [l, r] = tone(), lim = new Limiter(FS), out = [new Float32Array(N), new Float32Array(N)], edges = [0, ...cuts, N];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1], cl = l.slice(a, b + LOOK), cr = r.slice(a, b + LOOK);
    lim.process(cl, cr, b - a);
    out[0].set(cl.subarray(0, b - a), a); out[1].set(cr.subarray(0, b - a), a);
  }
  return out;
}

describe('limiter: the tracked gain rule (findings §7 l.109) on a steady tone above the ceiling', () => {
  it('between the peaks the gain lifts above ceiling ÷ peak; at a peak it is ceiling ÷ peak', () => {
    const [l] = tone(), out = limited(), PEAK = 2412, BETWEEN = PEAK + 20; // a sampled peak (+2) and 20 frames after it (−√3)
    const lift = out[0][BETWEEN] / l[BETWEEN] - CEIL / A;
    expect(lift, `gain − ceiling ÷ peak at frame ${BETWEEN}`).toBeGreaterThan(1e-3); // rule: (1 − C/2)(1 − e^(−20/2400)) ≈ 4.6e-3; flat: 0
    expect(Math.abs(out[0][PEAK] / l[PEAK] - CEIL / A), `gain − ceiling ÷ peak at frame ${PEAK}`).toBeLessThan(1e-6);
  });
  it('every frame equals the reference, in one call and in three calls with the gain carried', () => {
    const [l, r] = tone(), ref = reference(l, r, N);
    const firstOff = (out: Float32Array[]) => {
      for (let k = 0; k < N; k++) for (let c = 0; c < 2; c++) if (!(Math.abs(out[c][k] - ref[c][k]) <= TOL)) return { frame: k, channel: c, expected: ref[c][k], received: out[c][k] };
      return null;
    };
    expect(firstOff(limited()), 'one call').toBeNull();
    expect(firstOff(limited([1009, 3011])), 'three calls').toBeNull();
  });
});
