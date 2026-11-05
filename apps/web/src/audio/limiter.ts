// SPDX-License-Identifier: AGPL-3.0-only
// The output limiter (findings §7; G-09 figures in agent tool results §10), always on: linked stereo peak, −1 dBFS
// ceiling, 5 ms lookahead, 50 ms exponential release in linear gain, no make-up gain. The gain at sample n is the smallest
// gain any sample in [n, n + 5 ms] needs to stay under the ceiling (the lookahead absorbs the attack: no output delay, so
// G-09's bursts stay where they were); a lower target is taken at once, a higher one is approached as
// g ← target − (target − g)·e^(−1/(τ·fs)). Non-finite samples become 0. State (g) carries from one call to the next, so a
// mix rendered in chunks (each with its 5 ms lookahead rendered past its end) limits exactly as one long render.
export const CEILING_DB = -1, LOOKAHEAD_MS = 5, RELEASE_MS = 50;

export class Limiter {
  g = 1;
  readonly look: number;
  private readonly ceiling = 10 ** (CEILING_DB / 20);
  private readonly keep: number;
  constructor(readonly sampleRate = 48000) {
    this.look = Math.round(LOOKAHEAD_MS / 1000 * sampleRate);
    this.keep = Math.exp(-1 / (RELEASE_MS / 1000 * sampleRate));
  }
  reset() { this.g = 1; }
  /** Limits frames [0, length) of left / right in place; frames [length, left.length) are lookahead only (left as they are). */
  process(left: Float32Array, right: Float32Array, length = Math.max(0, left.length - this.look)) {
    const total = left.length, need = new Float32Array(total), queue = new Int32Array(total);
    for (let i = 0; i < total; i++) {
      if (!Number.isFinite(left[i])) left[i] = 0;
      if (!Number.isFinite(right[i])) right[i] = 0;
      const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      need[i] = peak > this.ceiling ? this.ceiling / peak : 1;
    }
    // Sliding minimum of need over [n, n + look] (a monotonic queue of indices).
    let head = 0, tail = 0, next = 0, g = this.g;
    for (let n = 0; n < length; n++) {
      for (const end = Math.min(total - 1, n + this.look); next <= end; next++) {
        while (tail > head && need[queue[tail - 1]] >= need[next]) tail--;
        queue[tail++] = next;
      }
      while (queue[head] < n) head++;
      const target = need[queue[head]];
      g = target < g ? target : target - (target - g) * this.keep;
      left[n] *= g; right[n] *= g;
    }
    this.g = g;
  }
}
