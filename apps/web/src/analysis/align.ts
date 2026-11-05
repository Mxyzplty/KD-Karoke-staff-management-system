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

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINAL: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
function cardinal(n: number): string[] {
  if (n < 20) return [ONES[n]];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[n / 10]];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? cardinal(n % 100) : [])];
  return [...cardinal(Math.floor(n / 1000)), 'thousand', ...(n % 1000 ? cardinal(n % 1000) : [])];
}
/**
 * T19q T6, for scoring only: a token that is a cardinal 0–9999 in digits, or its ordinal (st / nd / rd / th), as English
 * words (1999 → one thousand nine hundred ninety nine, 15th → fifteenth); any other token is returned as it is.
 */
export function spellOut(word: string): string[] {
  // A leading hyphen is a minus sign: a negative number is not in the range and stays as it is.
  const match = /^[^\P{P}-]*(\d{1,4}|\d,\d{3})(st|nd|rd|th)?\p{P}*$/iu.exec(word.trim());
  if (!match) return [word];
  const words = cardinal(Number(match[1].replace(',', '')));
  if (!match[2]) return words;
  const last = words.at(-1)!;
  return [...words.slice(0, -1), ORDINAL[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`)];
}

/** The words' letters joined by the delimiter; `owner` gives each token's word (-1 for a delimiter). */
function sequence(words: number[][], delimiter: number) {
  const tokens: number[] = [], owner: number[] = [];
  words.forEach((letters, w) => {
    if (w > 0) { tokens.push(delimiter); owner.push(-1); }
    for (const id of letters) { tokens.push(id); owner.push(w); }
  });
  return { tokens, owner };
}

/** The Viterbi trellis through blank-interleaved tokens: the last frame's best log-likelihood per state, and per frame and
 * state the step taken (0, 1 or 2 states back). */
function viterbi(logProbs: Float32Array, frames: number, classes: number, tokens: number[], blank: number) {
  const states = 2 * tokens.length + 1, label = (s: number) => s % 2 ? tokens[(s - 1) >> 1] : blank;
  let previous = new Float64Array(states).fill(-Infinity), current = new Float64Array(states);
  const from = new Uint8Array(frames * states);
  previous[0] = logProbs[blank];
  if (states > 1) previous[1] = logProbs[label(1)];
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
  return { last: previous, from, states };
}

/**
 * Aligns words (each a non-empty letter-id list) to log-probabilities [frames x classes].
 * Returns [startFrame, endFrameExclusive] per word, or null when no path exists.
 */
export function ctcAlign(logProbs: Float32Array, frames: number, classes: number, words: number[][], blank: number, delimiter: number): [number, number][] | null {
  const { tokens, owner } = sequence(words, delimiter);
  if (!tokens.length || frames < tokens.length) return null;
  const { last: previous, from, states } = viterbi(logProbs, frames, classes, tokens, blank);
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

/**
 * T19q T6: the log-likelihood of the best path ctcAlign would take for these words, or null when no path exists. With no
 * letters at all, the path is all blanks.
 */
export function ctcScore(logProbs: Float32Array, frames: number, classes: number, words: number[][], blank: number, delimiter: number): number | null {
  const { tokens } = sequence(words, delimiter);
  if (frames < Math.max(1, tokens.length)) return null;
  const { last, states } = viterbi(logProbs, frames, classes, tokens, blank);
  const best = Math.max(last[states - 1], states > 1 ? last[states - 2] : -Infinity);
  return best === -Infinity ? null : best;
}
