// SPDX-License-Identifier: AGPL-3.0-only
// T09 the local caption chunker (findings part 3 §44.2; tickets T09 "Chunker"): greedy grouping of timed words. A chunk
// closes before a word at maxWords, when the joined text with single spaces would pass maxCharacters (inclusive; an
// over-long word stays whole), before a conjunction and at a source-item boundary (the hard break), and closes after a
// sentence end. Pauses, commas and speaker changes never break. Times are in whatever clock the caller's words use.
export type ChunkOptions = { maxWords: number; maxCharacters: number; breakOnPunctuation: boolean; breakOnConjunctions: boolean };
export type ChunkWord = { text: string; startMs: number; endMs: number; source: string };
export type Chunk<W extends ChunkWord = ChunkWord> = { words: W[]; text: string; startMs: number; endMs: number; source: string };
/** Panel defaults (part 3 §46.5); the agent has no flag inputs, so an omitted flag is on (CAP-P09). */
export const CHUNK_DEFAULTS: ChunkOptions = { maxWords: 5, maxCharacters: 35, breakOnPunctuation: true, breakOnConjunctions: true };
export const LIMITS = { maxWords: [1, 20], maxCharacters: [10, 100] } as const;
/** A caption holds 0.5 s past its last word (§44.1 step 3). */
export const HOLD_MS = 500;
const CONJUNCTIONS = new Set(['and', 'but', 'or', 'so', 'yet', 'for', 'nor', 'because']);
/** Edge rules, stand-in SR-13: only letters, digits and apostrophes count for the conjunction match. */
const conjunction = (word: string) => CONJUNCTIONS.has(word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''));
const SENTENCE_END = /[.!?]["'”’)\]}»]*$/u;

export function chunkWords<W extends ChunkWord>(input: W[], options: ChunkOptions = CHUNK_DEFAULTS): Chunk<W>[] {
  const words = [...input].sort((a, b) => a.startMs - b.startMs), groups: W[][] = [];
  let open: W[] = [];
  const close = () => { if (open.length) groups.push(open); open = []; };
  for (const w of words) {
    if (open.length && (open.length >= options.maxWords || [...open, w].map(x => x.text).join(' ').length > options.maxCharacters
      || (options.breakOnConjunctions && conjunction(w.text)) || w.source !== open[0].source)) close();
    open.push(w);
    if (options.breakOnPunctuation && SENTENCE_END.test(w.text)) close();
  }
  close();
  return groups.map((group, n) => {
    const next = groups.slice(n + 1).find(g => g[0].source === group[0].source), last = group[group.length - 1];
    return { words: group, text: group.map(w => w.text).join(' '), startMs: group[0].startMs, source: group[0].source,
      endMs: Math.min(last.endMs + HOLD_MS, next ? next[0].startMs : Infinity) };
  });
}
