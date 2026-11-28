// SPDX-License-Identifier: AGPL-3.0-only
// T19a audit F4 (landed-audit-t19a l.97-108; lane A 12:01): SYNC_LOW_CONFIDENCE's 0.5 line, pinned from both sides. Xapp
// refuses confidence < 0.5 (code-level findings §17 :392, part 3 :264); the ticket: fewer than 3 anchor matches or confidence
// below 0.5 (implementation tickets :827, :347). So exactly 0.5 is accepted and anything under it is refused.
// sync.ts: confidence = matches / max(1, min(|a|, |b|)) × max(0, 1 − residual / 0.2). Every row but d matches k words at one
// offset with zero residual (the factor is exactly 1), so confidence = k / n: words are on a 0.5 s grid (source from 2 s, target
// from 0.5 s), every time and difference is exact in binary, each difference is 1.5, and the residual is median([0, …]) = 0.
// The other words differ between the transcripts, so they never match; one anchor offset, so no tie rule is involved.
import { expect, it } from 'vitest';
import { syncOffset } from '../apps/web/src/analysis/sync';
import type { Transcript } from '../apps/web/src/analysis/types';

const transcript = (words: [string, number][]): Transcript => ({ language: 'en', languages: ['en'], total_duration: 60, segments: [{ id: 0, start: 0, end: 60, text: words.map(w => w[0]).join(' '), speaker: 0, words: words.map(([word, start]) => ({ word, start, end: start + 0.3 })) }] });
const grid = (words: string[], from: number) => transcript(words.map((w, i) => [w, from + i * 0.5]));
const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
/** k shared words first, then n − k words of each transcript's own: confidence k / n. */
const pair = (k: number, n: number) => [grid([...names('m', k), ...names('s', n - k)], 2), grid([...names('m', k), ...names('t', n - k)], 0.5)] as const;
const refusal = (percent: number, confidence: number) => expect.objectContaining({ code: 'SYNC_LOW_CONFIDENCE', message: `Low sync confidence (${percent}%). Transcripts may not overlap enough.`, details: { confidence } });

it('a: 3 matches of 7, confidence 3/7 = 0.428…: refused (43%)', () => {
  expect(() => syncOffset(...pair(3, 7))).toThrowError(refusal(43, 3 / 7)); // 3 / 7 × 1, the same float sync.ts computes
});

it('a2: 50 matches of 101, confidence 50/101 = 0.49505: refused, the message rounding to 50% (audit nit l.108)', () => {
  expect(() => syncOffset(...pair(50, 101))).toThrowError(refusal(50, 50 / 101)); // Math.round(49.505) = 50; nit open (audit l.108)
});

it('b: 3 matches of 6, confidence exactly 0.5: accepted', () => {
  const r = syncOffset(...pair(3, 6)); // 3 / 6 = 0.5 exactly (representable, division correctly rounded), × 1
  expect({ offset: r.offset, confidence: r.confidence, matches: r.matches.length }).toEqual({ offset: 1.5, confidence: 0.5, matches: 3 });
});

it('c: 4 matches of 7, confidence 4/7 = 0.571…: accepted', () => {
  const r = syncOffset(...pair(4, 7));
  expect({ offset: r.offset, confidence: r.confidence, matches: r.matches.length }).toEqual({ offset: 1.5, confidence: 4 / 7, matches: 4 });
});

it('d: 2 matches of 3 at confidence 2/3: refused for the match count (67%)', () => {
  // The only anchor (a b c) gives differences 0, 0, −1, offset median 0; c is 1 s off (> 0.2), so a and b match: residual 0.
  expect(() => syncOffset(transcript([['a', 0], ['b', 0.5], ['c', 1]]), transcript([['a', 0], ['b', 0.5], ['c', 2]]))).toThrowError(refusal(67, 2 / 3));
});
