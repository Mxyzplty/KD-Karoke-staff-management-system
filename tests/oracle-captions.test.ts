// SPDX-License-Identifier: AGPL-3.0-only
// Findings part 5 §57 test values, computed through the oracle. Tolerance: half a unit of the last printed digit;
// a value printed as an integer (px sums, start-of-animation values) is compared exactly, up to float noise (1e-9).
import { it, expect } from 'vitest';
import { wordState, layoutCaption, graphemeOffsets } from '../parity/oracle/captions';

const near = (actual: number, printed: string) => { const d = printed.split('.')[1]?.length; expect(Math.abs(actual - Number(printed)), `${actual} vs ${printed}`).toBeLessThanOrEqual(d === undefined ? 1e-9 : .5 * 10 ** -d + 1e-12); };
const word = { text: 'word', startMs: 500, endMs: 900 };

it('§57 caption test values (word [500, 900) ms, defaults)', () => {
  const wbw = (t: number) => wordState('word-by-word', word, t).opacity;
  near(wbw(499), '0.4'); near(wbw(530), '0.55'); near(wbw(560), '0.70'); near(wbw(620), '1.0'); near(wbw(700), '1.0'); near(wbw(950), '1.0');
  const up = (t: number) => wordState('slide-up', word, t);
  near(up(500).opacity, '0'); near(up(500).dy, '20');
  near(up(530).opacity, '0.3859'); near(up(530).dy, '12.28');
  near(up(560).opacity, '0.6570'); near(up(560).dy, '6.86');
  near(up(620).opacity, '0.9360'); near(up(620).dy, '1.28');
  for (const t of [700, 900, 2000]) expect([up(t).opacity, up(t).dy, up(t).dx]).toEqual([1, 0, 0]);
  const left = wordState('slide-left', word, 500); expect([left.opacity, left.dx, left.dy]).toEqual([0, 20, 0]);
  const hl = (t: number) => { const s = wordState('highlight', word, t); return [s.color, s.scale]; };
  expect([hl(499), hl(500), hl(899), hl(900)]).toEqual([[null, 1], ['#FFD700', 1.05], ['#FFD700', 1.05], [null, 1]]);
});

it('§57.3 caption line layout test (widths 200 / 300 / 200, F 60, middle word at 1.05)', () => {
  // Box width is not stated; 1080 is assumed (any width ≥ 772 keeps one line and the same offsets).
  const widths: Record<string, number> = { one: 200, two: 300, three: 200 }, measure = (s: string) => widths[s];
  const box = { fontSize: 60, width: 1080, height: 200 }, words = ['one', 'two', 'three'];
  const plain = layoutCaption(words, measure, box), hot = layoutCaption(words, measure, box, [1, 1.05, 1]);
  expect([plain.length, hot.length, hot[0].length]).toEqual([1, 1, 3]);
  const [a, b] = [plain[0], hot[0]];
  near(b[1].extra, '15');
  near(a[2].left + a[2].width - a[0].left, '724'); near(b[2].left + b[2].width - b[0].left, '739'); // outer words are unscaled
  near(a[0].left - b[0].left, '7.5'); near(b[2].left - a[2].left, '7.5');
  expect(graphemeOffsets(words)).toEqual([0, 4, 8]);
});

it('§53.7.4 caption line pitch in the layout: F × lineHeight, no px rule; anything else 1.2', () => {
  // One word, F 60, box height 200: first top = (200 − pitch) / 2 + 0.2·60.
  const top = (lineHeight: unknown) => layoutCaption(['one'], () => 100, { fontSize: 60, width: 1080, height: 200, lineHeight })[0][0].top;
  for (const v of ['normal', '36px', '120%', undefined, 0, -2]) near(top(v), '76'); // pitch 1.2·60 = 72 → (200 − 72) / 2 + 12
  near(top(1.5), '67'); near(top('1.5'), '67'); // pitch 90 → 55 + 12
  near(top(36), '-968'); // quirk: 36 is a multiplier, pitch 2160 → (200 − 2160) / 2 + 12
});
