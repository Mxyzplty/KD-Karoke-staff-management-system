// SPDX-License-Identifier: AGPL-3.0-only
import { median } from '../audio';
import { normalWord } from '../sync';
import { wordsOf, type Transcript } from '../types';
import { normalizeEnglish } from './whisper-normalizer';

/** Levenshtein traceback, including substitutions, insertions and deletions. */
function alignWords(a: string[], b: string[]) {
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
  let i = a.length, j = b.length;
  const equal: [number, number][] = [];
  while (i || j) {
    if (i && j && dp[i][j] === dp[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1])) { if (a[i - 1] === b[j - 1]) equal.push([i - 1, j - 1]); i--; j--; }
    else if (i && dp[i][j] === dp[i - 1][j] + 1) i--; else j--;
  }
  return { errors: dp[a.length][b.length], referenceWords: a.length, hypothesisWords: b.length, wer: a.length ? dp[a.length][b.length] / a.length : b.length ? 1 : 0, equal: equal.reverse() };
}
export function wordAlignment(reference: string[], hypothesis: string[]) { return alignWords(reference.map(normalWord), hypothesis.map(normalWord)); }
/** The WER rows (T19q Q8, D31): each side joined, normalised and split, then compared exactly. The normaliser leaves single spaces only. */
export function normalizedWer(reference: string[], hypothesis: string[]) {
  const words = (side: string[]) => normalizeEnglish(side.join(' ')).split(' ').filter(Boolean);
  return alignWords(words(reference), words(hypothesis));
}
export const ASR_CONDITIONS = ['clean', 'snr5', 'music5', 'music0'] as const;
export type AsrCondition = typeof ASR_CONDITIONS[number];
export type AsrTotals = Record<AsrCondition, { errors: number; words: number }>;
export const WER_NORMALIZER = 'openai/whisper@86098128 EnglishTextNormalizer';
export const asrTotals = () => Object.fromEntries(ASR_CONDITIONS.map(c => [c, { errors: 0, words: 0 }])) as AsrTotals;
/** The measured values of `V-ASR summary`. */
export function asrSummary(utterances: number, totals: AsrTotals, gateFired: Record<AsrCondition, number>, noRepetition: boolean, asrModel: string) {
  const wer = Object.fromEntries(ASR_CONDITIONS.map(c => [c, totals[c].errors / totals[c].words])) as Record<AsrCondition, number>;
  return { utterances, ...wer, gateFired, noRepetition, asrModel, werNormalizer: WER_NORMALIZER };
}
export type AsrSummary = ReturnType<typeof asrSummary>;
/** The measured values of `V-ASR validation`: T19 round T3's rule against a baseline judged under the same normaliser. */
export function asrVerdict(summary: AsrSummary, baseline: string, base: AsrSummary) {
  if (base.music5 === undefined) throw Error('The baseline has no music conditions; rerun it with this scorer');
  if (base.werNormalizer !== WER_NORMALIZER) throw Error('The baseline was not judged under the normaliser; re-judge it with --part asr-rejudge');
  const pass = (['snr5', 'music5', 'music0'] as const).some(c => summary[c] < base[c]) && ASR_CONDITIONS.every(c => summary[c] <= base[c]) && summary.noRepetition;
  return { ...summary, baseline, baselineWer: Object.fromEntries(ASR_CONDITIONS.map(c => [c, base[c]])), pass };
}
/** One stored `V-ASR <id>` row re-scored from its stored text. Word counts, gates and text stay as stored. */
export function rejudgeAsrRow(measured: Record<string, any>, truth: string[], totals: AsrTotals) {
  const rejudged = { ...measured };
  for (const c of ASR_CONDITIONS) {
    if (typeof measured[c]?.text !== 'string') throw Error(`The stored row has no ${c} text`);
    const score = normalizedWer(truth, [measured[c].text]);
    totals[c].errors += score.errors; totals[c].words += score.referenceWords;
    rejudged[c] = { ...measured[c], wer: score.wer, errors: score.errors };
  }
  return rejudged;
}
export function percentile(values: number[], p: number) { const sorted = values.slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : Infinity; }
export function beatScore(truth: number[], actual: number[], tolerance: number) {
  const a = truth.slice().sort((a, b) => a - b), b = actual.slice().sort((a, b) => a - b);
  let i = 0, j = 0, matched = 0;
  while (i < a.length && j < b.length) {
    if (Math.abs(a[i] - b[j]) <= tolerance + 1e-9) { matched++; i++; j++; }
    else if (a[i] < b[j]) i++; else j++;
  }
  return { truth: a.length, detected: b.length, matched, f: a.length + b.length ? 2 * matched / (a.length + b.length) : 1 };
}
export function timingScore(reference: { text: string; startMs: number; endMs: number; timingScorable: boolean }[], transcript: Transcript) {
  const words = wordsOf(transcript), aligned = wordAlignment(reference.map(w => w.text), words.map(w => w.word));
  // The gate stays on the worse of each word's two boundaries; start-only and end-only are reported
  // beside it (review m1). Missing/wrong words are reported as coverage, rather than secretly assigned
  // perfect timestamps.
  const pairs = aligned.equal.filter(([i]) => reference[i].timingScorable).map(([i, j]) => [Math.abs(reference[i].startMs - words[j].start * 1000), Math.abs(reference[i].endMs - words[j].end * 1000)]);
  const stat = (errors: number[]) => ({ medianMs: errors.length ? median(errors) : Infinity, p95Ms: percentile(errors, 0.95) });
  return { ...stat(pairs.map(([s, e]) => Math.max(s, e))), start: stat(pairs.map(p => p[0])), end: stat(pairs.map(p => p[1])), timedCorrectWords: pairs.length, scorableWords: reference.filter(w => w.timingScorable).length };
}
/** Cues below this are too few to evidence a speaker gate (fixed before scoring; review M2). */
export const MIN_SPEAKER_CUES = 10;
/**
 * Every scorable consensus interval is a unit, labelled with the hypothesis speaker that overlaps it
 * most (none: wrong). Agreement is the best one-to-one label permutation (the complement of a
 * DER-style confusion), which is at most min(purity, coverage): splitting one speaker into many
 * labels lowers coverage and therefore agreement. `cues` counts the subtitle cues holding a unit.
 */
export function speakerAgreement(reference: { startMs: number; endMs: number; speaker: string; scorable: boolean }[], transcript: Transcript, cues: { startMs: number; endMs: number }[]) {
  const scored = reference.filter(r => r.scorable).map(r => {
    const overlap = new Map<number, number>();
    for (const s of transcript.segments) overlap.set(s.speaker, (overlap.get(s.speaker) ?? 0) + Math.max(0, Math.min(r.endMs, s.end * 1000) - Math.max(r.startMs, s.start * 1000)));
    const best = [...overlap].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    return { startMs: r.startMs, endMs: r.endMs, reference: r.speaker, predicted: best && best[1] > 0 ? best[0] : null };
  });
  const scorableCues = cues.filter(c => scored.some(s => s.endMs > c.startMs && s.startMs < c.endMs)).length;
  const refs = [...new Set(scored.map(s => s.reference))], predictions = [...new Set(scored.flatMap(s => s.predicted === null ? [] : [s.predicted]))];
  const count = (ref: string, label: number) => scored.filter(s => s.reference === ref && s.predicted === label).length;
  let correct = 0;
  function assign(index: number, used: Set<number>, score: number) {
    if (index === refs.length) { correct = Math.max(correct, score); return; }
    assign(index + 1, used, score);
    for (const label of predictions) if (!used.has(label)) { used.add(label); assign(index + 1, used, score + count(refs[index], label)); used.delete(label); }
  }
  assign(0, new Set(), 0);
  const units = scored.length;
  const purity = units ? predictions.reduce((s, label) => s + Math.max(...refs.map(ref => count(ref, label))), 0) / units : 0;
  const coverage = units ? refs.reduce((s, ref) => s + Math.max(0, ...predictions.map(label => count(ref, label))), 0) / units : 0;
  return { agreement: units ? correct / units : 0, correct, units, purity, coverage, referenceSpeakers: refs.length, predictedLabels: predictions.length, scorableCues, evidenced: scorableCues >= MIN_SPEAKER_CUES, scored };
}
