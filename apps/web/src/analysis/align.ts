// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CTC forced alignment of known words to wav2vec2 emissions (TR-P03 new-model round): one Viterbi path
 * through blank-interleaved letters, with the word delimiter between words. Frames are 20 ms; a word
 * starts at its first letter's first frame and ends after its last letter's last frame.
 */
export const CTC_FRAME = 0.02;

/** The letters of a word the aligner can spell (lowercase letters, apostrophe, hyphen); other characters are dropped. */
export function spell(word: string, vocab: ReadonlyMap<string, number>) {
  return [...word.toLowerCase()].filter(c => c !== '|' && vocab.has(c)).map(c => vocab.get(c)!);
}

/**
 * Aligns words (each a non-empty letter-id list) to log-probabilities [frames x classes].
 * Returns [startFrame, endFrameExclusive] per word, or null when no path exists.
 */
export function ctcAlign(logProbs: Float32Array, frames: number, classes: number, words: number[][], blank: number, delimiter: number): [number, number][] | null {
  const tokens: number[] = [], owner: number[] = [];
  words.forEach((letters, w) => {
    if (w > 0) { tokens.push(delimiter); owner.push(-1); }
    for (const id of letters) { tokens.push(id); owner.push(w); }
  });
  const states = 2 * tokens.length + 1, label = (s: number) => s % 2 ? tokens[(s - 1) >> 1] : blank;
  if (!tokens.length || frames < tokens.length) return null;
  let previous = new Float64Array(states).fill(-Infinity), current = new Float64Array(states);
  const from = new Uint8Array(frames * states);
  previous[0] = logProbs[blank];
  previous[1] = logProbs[label(1)];
  for (let t = 1; t < frames; t++) {
    const row = t * classes;
    for (let s = 0; s < states; s++) {
      let best = previous[s], step = 0;
      if (s > 0 && previous[s - 1] > best) { best = previous[s - 1]; step = 1; }
      if (s > 1 && s % 2 && label(s) !== label(s - 2) && previous[s - 2] > best) { best = previous[s - 2]; step = 2; }
      current[s] = best + logProbs[row + label(s)];
      from[t * states + s] = step;
    }
    [previous, current] = [current, previous];
  }
  let s = previous[states - 1] >= previous[states - 2] ? states - 1 : states - 2;
  if (previous[s] === -Infinity) return null;
  const spans: [number, number][] = words.map(() => [Infinity, -Infinity]);
  for (let t = frames - 1; t >= 0; t--) {
    if (s % 2) {
      const w = owner[(s - 1) >> 1];
      if (w >= 0) { spans[w][0] = Math.min(spans[w][0], t); spans[w][1] = Math.max(spans[w][1], t + 1); }
    }
    if (t > 0) s -= from[t * states + s];
  }
  return spans;
}
