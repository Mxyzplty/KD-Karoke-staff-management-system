// SPDX-License-Identifier: AGPL-3.0-only
// The output limiter (findings §7 l.109; G-09 figures in agent tool results §10), always on: linked stereo peak, −1 dBFS
// ceiling, 5 ms lookahead (L frames, at least 1), 50 ms exponential release in linear gain, no make-up gain. Each sample j in
// [n, n + 5 ms] offers its needed gain + (j − n)/L and the smallest offer is the limit (the limit eases in and absorbs the
// attack: no output delay, so G-09's bursts stay where they were); the gain steps toward 1 with the 50 ms release and is then
// capped by the limit, and within 1e-9 of 1 it snaps to 1. Non-finite samples become 0. State (g) carries from one call to
// the next, so a mix rendered in chunks (each with its 5 ms lookahead rendered past its end) limits exactly as one long render.
export const CEILING_DB = -1, LOOKAHEAD_MS = 5, RELEASE_MS = 50;

export class Limiter {
  g = 1;
  readonly look: number;
  private readonly ceiling = 10 ** (CEILING_DB / 20);
  private readonly keep: number;
  constructor(readonly sampleRate = 48000) {
    this.look = Math.max(1, Math.round(LOOKAHEAD_MS / 1000 * sampleRate));
    this.keep = Math.exp(-1 / (RELEASE_MS / 1000 * sampleRate));
  }
  reset() { this.g = 1; }
  /** Limits frames [0, length) of left / right in place; frames [length, left.length) are lookahead only (left as they are). */
  process(left: Float32Array, right: Float32Array, length = Math.max(0, left.length - this.look)) {
    const total = left.length, need = new Float32Array(total), queue = new Int32Array(total), L = this.look;
    for (let i = 0; i < total; i++) {
      if (!Number.isFinite(left[i])) left[i] = 0;
      if (!Number.isFinite(right[i])) right[i] = 0;
      const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      need[i] = peak > this.ceiling ? this.ceiling / peak : 1;
    }
    // The limit: the smallest need[j] + (j − n)/L over [n, n + L] (a monotonic queue of indices; two offers keep their order as n moves).
    let head = 0, tail = 0, next = 0, g = this.g;
    for (let n = 0; n < length; n++) {
      for (const end = Math.min(total - 1, n + L); next <= end; next++) {
        while (tail > head && need[queue[tail - 1]] >= need[next] + (next - queue[tail - 1]) / L) tail--;
        queue[tail++] = next;
      }
      while (queue[head] < n) head++;
      const limit = need[queue[head]] + (queue[head] - n) / L;
      g = Math.min(1 - (1 - g) * this.keep, limit); if (1 - g < 1e-9) g = 1;
      left[n] *= g; right[n] *= g;
    }
    this.g = g;
  }
}
