// SPDX-License-Identifier: AGPL-3.0-only
// T19q Q8 (D31): the WER rows of score.ts without score.ts (it runs main() on import): normalizedWer, the V-ASR re-judge of a
// stored row, the summary and T3's verdict rule, all from apps/web/src/analysis/tools/metrics.ts. Synthetic data only; no model.
import { describe, expect, it } from 'vitest';
import { ASR_CONDITIONS, WER_NORMALIZER, asrSummary, asrTotals, asrVerdict, normalizedWer, rejudgeAsrRow, wordAlignment, type AsrCondition } from '../apps/web/src/analysis/tools/metrics';

const words = (text: string) => text.split(' ').filter(Boolean);

describe('normalizedWer', () => {
  it('compares tokens carrying $, % and . after normalising both sides', () => {
    expect(normalizedWer(['it', 'cost', '$5.50'], ['it', 'cost', '$5.50']).wer).toBe(0);
    expect(normalizedWer(['five', 'dollars'], ['$5']).errors).toBe(0);
    expect(normalizedWer(['fifty', 'percent'], ['50%']).errors).toBe(0);
    expect(normalizedWer(['pi', 'is', '3.14.'], ['pi', 'is', 'three', 'point', 'one', 'four']).errors).toBe(0);
    expect(normalizedWer(['it', 'cost', '$5.50'], ['it', 'cost', '$5.60']).errors).toBe(1);
    expect(normalizedWer(['half', 'of', '50%'], ['half', 'of', '50']).errors).toBe(1);
  });
  it('joins each side before normalising, so a number spans array items', () => {
    const score = normalizedWer(['two', 'point', 'five', 'million'], ['2500000']);
    expect(score).toMatchObject({ errors: 0, referenceWords: 1, hypothesisWords: 1, wer: 0 });
  });
  it('scores an empty side on either side and on both', () => {
    expect(normalizedWer([], ['hello'])).toMatchObject({ errors: 1, referenceWords: 0, hypothesisWords: 1, wer: 1, equal: [] });
    expect(normalizedWer(['hello'], [])).toMatchObject({ errors: 1, referenceWords: 1, hypothesisWords: 0, wer: 1, equal: [] });
    expect(normalizedWer(['the', 'quick', 'brown', 'fox'], [])).toMatchObject({ errors: 4, referenceWords: 4, wer: 1 });
    expect(normalizedWer([], [])).toMatchObject({ errors: 0, referenceWords: 0, hypothesisWords: 0, wer: 0, equal: [] });
    expect(normalizedWer([''], [' '])).toMatchObject({ errors: 0, referenceWords: 0, hypothesisWords: 0, wer: 0 });
  });
  it('scores a side that normalises away as empty', () => {
    expect(normalizedWer(['[music]', '(laughs)', 'um'], ['hello'])).toMatchObject({ errors: 1, referenceWords: 0, hypothesisWords: 1, wer: 1 });
    expect(normalizedWer(['[music]'], ['uh'])).toMatchObject({ errors: 0, referenceWords: 0, hypothesisWords: 0, wer: 0 });
  });
  it('returns the shape wordAlignment returns', () => {
    const normalised = normalizedWer(['the', 'cat', 'sat'], ['the', 'dog', 'sat']), raw = wordAlignment(['the', 'cat', 'sat'], ['the', 'dog', 'sat']);
    expect(Object.keys(normalised).sort()).toEqual(Object.keys(raw).sort());
    expect(Object.keys(normalised).sort()).toEqual(['equal', 'errors', 'hypothesisWords', 'referenceWords', 'wer']);
    expect(normalised).toEqual(raw);
    expect(normalised).toEqual({ errors: 1, referenceWords: 3, hypothesisWords: 3, wer: 1 / 3, equal: [[0, 0], [2, 2]] });
  });
  it('scores 0 for a pair that differs raw and matches normalised', () => {
    const reference = ['Mr.', "Smith's", 'colour'].join(' '), hypothesis = ['mister', 'smith', 'is', 'color'].join(' ');
    expect(wordAlignment(words(reference), words(hypothesis)).errors).toBeGreaterThan(0);
    const score = normalizedWer(words(reference), words(hypothesis));
    expect(score).toMatchObject({ errors: 0, wer: 0, referenceWords: 4, hypothesisWords: 4 });
    expect(score.equal).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    expect(normalizedWer(['Hello,', 'World!'], ['hello', 'world']).wer).toBe(0);
    expect(normalizedWer(['Dr.', 'Who', 'said', '"Don’t', 'panic."'], ['doctor', 'who', 'said', 'don', 't', 'panic']).errors).toBe(0);
  });
  it('compares words exactly, with no normalWord step', () => {
    // normalWord (sync.ts) drops $ and %, so wordAlignment calls these equal and normalizedWer does not.
    expect(wordAlignment(['50%'], ['50']).errors).toBe(0);
    expect(normalizedWer(['50%'], ['50']).errors).toBe(1);
    expect(wordAlignment(['$5'], ['5']).errors).toBe(0);
    expect(normalizedWer(['$5'], ['5']).errors).toBe(1);
    // ...and the normaliser's own output is what is compared: "colour" and "color" are one word, "colour" and "colors" are not
    expect(normalizedWer(['colour'], ['color']).errors).toBe(0);
    expect(normalizedWer(['colour'], ['colors']).errors).toBe(1);
  });
  it('counts the normalised words of a reference that normalises to more or fewer words than it had', () => {
    expect(normalizedWer(["Let's", 'go'],['let', 'us', 'go'])).toMatchObject({ errors: 0, referenceWords: 3 }); // more: let's -> let us
    expect(normalizedWer(['10km'], ['10', 'km'])).toMatchObject({ errors: 0, referenceWords: 2 });
    expect(normalizedWer(['two', 'hundred', 'and', 'five'], ['205'])).toMatchObject({ errors: 0, referenceWords: 1, wer: 0 }); // fewer
    expect(normalizedWer(['one', 'hundred', 'dollars'], ['$100'])).toMatchObject({ errors: 0, referenceWords: 1 });
    const missed = normalizedWer(['one', 'hundred', 'dollars'], ['hello']);
    expect(missed).toMatchObject({ errors: 1, referenceWords: 1, hypothesisWords: 1, wer: 1 });
    expect(normalizedWer(['10km', 'away'], ['away'])).toMatchObject({ errors: 2, referenceWords: 3, wer: 2 / 3 });
  });
});

describe('wordAlignment is unchanged', () => {
  it('still folds case and punctuation per word', () => {
    expect(wordAlignment(['Hello,', 'World!'], ['hello', 'world'])).toEqual({ errors: 0, referenceWords: 2, hypothesisWords: 2, wer: 0, equal: [[0, 0], [1, 1]] });
    expect(wordAlignment(['The', 'cat.'], ['the', 'dog'])).toEqual({ errors: 1, referenceWords: 2, hypothesisWords: 2, wer: 0.5, equal: [[0, 0]] });
    expect(wordAlignment(['Mr.', 'Smith'], ['mister', 'smith'])).toMatchObject({ errors: 1, wer: 0.5 });
    expect(wordAlignment([], ['a'])).toMatchObject({ errors: 1, wer: 1 });
    expect(wordAlignment([], [])).toMatchObject({ errors: 0, wer: 0 });
  });
});

describe('rejudgeAsrRow', () => {
  // Stored values that cannot be the true scores, so a replaced field cannot pass by coincidence.
  const stored = () => ({
    drums: 'drummer1/session1/1_funk_80_beat_4-4', musicFrom: 120, referenceWords: 3,
    clean: { wer: 0.9, errors: 99, words: 7, withinTenPercent: true, musicGate: false, scaled: false, text: 'the cat sat' },
    snr5: { wer: 0.9, errors: 99, words: 2, withinTenPercent: false, musicGate: false, scaled: true, text: 'The cat.' },
    music5: { wer: 0.9, errors: 99, words: 3, withinTenPercent: true, musicGate: true, scaled: false, text: 'a cat sat' },
    music0: { wer: 0.9, errors: 99, words: 0, withinTenPercent: true, musicGate: false, scaled: false, text: '' },
  });
  const truth = ['The', 'cat', 'sat'];
  const deepFreeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

  it('replaces wer and errors for all four conditions', () => {
    const row = rejudgeAsrRow(stored(), truth, asrTotals());
    expect(ASR_CONDITIONS).toEqual(['clean', 'snr5', 'music5', 'music0']);
    expect([row.clean, row.snr5, row.music5, row.music0].map(c => [c.errors, c.wer])).toEqual([[0, 0], [1, 1 / 3], [1, 1 / 3], [3, 1]]);
  });
  it('keeps every other field as stored', () => {
    const before = stored(), row = rejudgeAsrRow(before, truth, asrTotals());
    expect(row.drums).toBe(before.drums);
    expect(row.musicFrom).toBe(120);
    expect(row.referenceWords).toBe(3);
    for (const c of ASR_CONDITIONS) {
      const { wer, errors, ...kept } = row[c], { wer: _w, errors: _e, ...original } = before[c];
      expect(kept).toEqual(original);
      expect(Object.keys(row[c]).sort()).toEqual(['errors', 'musicGate', 'scaled', 'text', 'wer', 'withinTenPercent', 'words']);
    }
    expect(row.clean.words).toBe(7);
    expect(row.snr5.scaled).toBe(true);
    expect(row.music5.musicGate).toBe(true);
    expect(row.snr5.withinTenPercent).toBe(false);
    expect(row.snr5.text).toBe('The cat.');
  });
  it('does not mutate its input, which may be frozen', () => {
    const before = deepFreeze(stored()), snapshot = structuredClone(before);
    const row = rejudgeAsrRow(before, truth, asrTotals());
    expect(before).toEqual(snapshot);
    expect(row).not.toBe(before);
    for (const c of ASR_CONDITIONS) expect(row[c]).not.toBe(before[c]);
  });
  it('accumulates errors and normalised reference words over two rows', () => {
    const totals = asrTotals();
    rejudgeAsrRow(stored(), truth, totals);
    const second = { ...stored(), clean: { ...stored().clean, text: 'hello there' }, snr5: { ...stored().snr5, text: 'hello' }, music5: { ...stored().music5, text: 'hello there' }, music0: { ...stored().music0, text: 'goodbye there' } };
    rejudgeAsrRow(second, ['Hello,', 'there!'], totals);
    expect(totals).toEqual({ clean: { errors: 0, words: 5 }, snr5: { errors: 2, words: 5 }, music5: { errors: 1, words: 5 }, music0: { errors: 4, words: 5 } });
    const again = asrTotals();
    expect(again).toEqual({ clean: { errors: 0, words: 0 }, snr5: { errors: 0, words: 0 }, music5: { errors: 0, words: 0 }, music0: { errors: 0, words: 0 } });
    expect(again).not.toBe(asrTotals());
  });
  it('counts the normalised words of the truth, not the stored word counts', () => {
    const totals = asrTotals();
    rejudgeAsrRow(stored(), ['Two', 'hundred', 'and', 'five'], totals);
    for (const c of ASR_CONDITIONS) expect(totals[c].words).toBe(1);
  });
  it('throws when a condition has no stored text', () => {
    for (const c of ASR_CONDITIONS) {
      const missing = stored() as Record<string, any>;
      delete missing[c].text;
      expect(() => rejudgeAsrRow(missing, truth, asrTotals())).toThrow(`The stored row has no ${c} text`);
    }
    const noCondition = stored() as Record<string, any>;
    delete noCondition.music0;
    expect(() => rejudgeAsrRow(noCondition, truth, asrTotals())).toThrow('The stored row has no music0 text');
    const numeric = stored() as Record<string, any>;
    numeric.clean.text = 5;
    expect(() => rejudgeAsrRow(numeric, truth, asrTotals())).toThrow('The stored row has no clean text');
  });
});

/** An AsrSummary whose WER per condition is exactly `wer[c]` (errors / 1000 words), at 4 decimals' worth of exactness. */
function summaryOf(wer: Record<AsrCondition, number>, noRepetition = true) {
  const totals = asrTotals();
  for (const c of ASR_CONDITIONS) totals[c] = { errors: Math.round(wer[c] * 1000), words: 1000 };
  return asrSummary(50, totals, { clean: 0, snr5: 1, music5: 2, music0: 3 }, noRepetition, 'test-asr-model');
}
const BASE = { clean: 0.2, snr5: 0.3, music5: 0.4, music0: 0.5 };
const withWer = (change: Partial<Record<AsrCondition, number>>) => ({ ...BASE, ...change });

describe('asrSummary', () => {
  it('takes each condition’s wer from its totals and passes the rest through as stored', () => {
    const totals = asrTotals();
    totals.clean = { errors: 3, words: 12 }; totals.snr5 = { errors: 5, words: 20 }; totals.music5 = { errors: 0, words: 8 }; totals.music0 = { errors: 8, words: 8 };
    const gateFired = { clean: 0, snr5: 1, music5: 4, music0: 7 };
    const summary = asrSummary(9, totals, gateFired, false, 'some-asr-model@rev');
    expect(summary).toEqual({
      utterances: 9, clean: 0.25, snr5: 0.25, music5: 0, music0: 1, gateFired, noRepetition: false, asrModel: 'some-asr-model@rev',
      werNormalizer: 'openai/whisper@86098128 EnglishTextNormalizer',
    });
    expect(summary.gateFired).toBe(gateFired);
    expect(summary.werNormalizer).toBe(WER_NORMALIZER);
  });
  it('reports noRepetition true as stored', () => {
    expect(summaryOf(BASE).noRepetition).toBe(true);
    expect(summaryOf(BASE, false).noRepetition).toBe(false);
  });
});

describe('asrVerdict', () => {
  it('throws on a baseline not judged under the normaliser, saying to re-judge it', () => {
    const { werNormalizer, ...unjudged } = summaryOf(BASE);
    expect(() => asrVerdict(summaryOf(BASE), 'base', unjudged as any)).toThrow(/re-judge/);
    expect(() => asrVerdict(summaryOf(BASE), 'base', { ...summaryOf(BASE), werNormalizer: 'someone else' } as any)).toThrow(/re-judge/);
    expect(() => asrVerdict(summaryOf(BASE), 'base', { ...summaryOf(BASE), werNormalizer: undefined } as any)).toThrow('The baseline was not judged under the normaliser; re-judge it with --part asr-rejudge');
  });
  it('throws the existing message on a baseline without music conditions', () => {
    const { music5, ...noMusic } = summaryOf(BASE);
    expect(() => asrVerdict(summaryOf(BASE), 'base', noMusic as any)).toThrow('The baseline has no music conditions; rerun it with this scorer');
    const { werNormalizer, ...old } = noMusic;
    expect(() => asrVerdict(summaryOf(BASE), 'base', old as any)).toThrow('The baseline has no music conditions; rerun it with this scorer');
  });
  it('passes on a strict fall in snr5, music5 or music0 with no rise anywhere', () => {
    for (const c of ['snr5', 'music5', 'music0'] as const) {
      const verdict = asrVerdict(summaryOf(withWer({ [c]: BASE[c] - 0.05 })), 'base', summaryOf(BASE));
      expect(verdict.pass, c).toBe(true);
    }
    expect(asrVerdict(summaryOf({ clean: 0.2, snr5: 0.1, music5: 0.1, music0: 0.1 }), 'base', summaryOf(BASE)).pass).toBe(true);
  });
  it('fails without a strict fall', () => {
    expect(asrVerdict(summaryOf(BASE), 'base', summaryOf(BASE)).pass).toBe(false);
  });
  it('fails when only clean falls', () => {
    expect(asrVerdict(summaryOf(withWer({ clean: 0.1 })), 'base', summaryOf(BASE)).pass).toBe(false);
  });
  it('fails when any condition rises, whatever else falls', () => {
    for (const c of ASR_CONDITIONS) {
      const fell = c === 'snr5' ? 'music5' : 'snr5';
      const verdict = asrVerdict(summaryOf(withWer({ [fell]: BASE[fell] - 0.1, [c]: BASE[c] + 0.001 })), 'base', summaryOf(BASE));
      expect(verdict.pass, `${c} rises`).toBe(false);
    }
  });
  it('fails when noRepetition is false even with a clean strict fall', () => {
    expect(asrVerdict(summaryOf(withWer({ music0: 0.4 }), false), 'base', summaryOf(BASE)).pass).toBe(false);
    expect(asrVerdict(summaryOf(withWer({ music0: 0.4 }), true), 'base', summaryOf(BASE)).pass).toBe(true);
  });
  it('lists the four baseline conditions and carries the summary and the baseline name', () => {
    const summary = summaryOf(withWer({ snr5: 0.25 })), verdict = asrVerdict(summary, 'the-base-run', summaryOf(BASE));
    expect(verdict.baselineWer).toEqual(BASE);
    expect(Object.keys(verdict.baselineWer)).toEqual(['clean', 'snr5', 'music5', 'music0']);
    expect(verdict).toMatchObject({ ...summary, baseline: 'the-base-run', pass: true });
  });
});
