// SPDX-License-Identifier: AGPL-3.0-only
// T19q T8: model-free tests for the music gate in AnalysisEngine.transcribe. Qwen3-ASR and T6's arbitration run only when
// the language is English AND the sound classifier marked the file as music. Every model call is stubbed.
import { describe, expect, it, vi } from 'vitest';
import { AnalysisEngine } from '../apps/web/src/analysis/engine';

const rate = 16000;
type Chunk = { text: string; timestamp: [number | null, number | null] };
const chunk = (text: string, start: number | null, end: number | null): Chunk => ({ text, timestamp: [start, end] });

// A 28-class alphabet: 0 blank, 1 delimiter, 2.. the letters a-z.
const blank = 0, delimiter = 1, classes = 28;
const vocab = new Map<string, number>([['|', delimiter], ...[...'abcdefghijklmnopqrstuvwxyz'].map((c, i) => [c, 2 + i] as [string, number])]);
/** One frame per path character ('_' blank, '|' delimiter, a letter): log-prob 0 on the path's label, `miss` elsewhere. */
function emit(path: string, miss = -5) {
  const logProbs = new Float32Array(path.length * classes).fill(miss);
  [...path].forEach((c, t) => { logProbs[t * classes + (c === '_' ? blank : c === '|' ? delimiter : vocab.get(c)!)] = 0; });
  return { logProbs, frames: path.length, classes, vocab, blank, delimiter };
}

const tone = (seconds: number) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / rate));
const pcm = { sampleRate: rate, channels: 1, data: [tone(10)] };
// Voice [[2,3],[5,6]] -> the voiced slice starts at 1.75 s; chunk times below are local to it. In region 1 the matrix spells
// "bar", so wherever arbitration runs Qwen's "bar" beats whisper's "foo".
const whisperChunks = () => [chunk(' hello', 0.5, 0.9), chunk(' world', 0.9, 1.3), chunk(' foo', 3.5, 3.9)];
const qwenChunks = () => [chunk('hello', 0.5, 0.9), chunk('world', 0.9, 1.3), chunk('bar', 3.5, 3.9)];

function setup(isMusic: boolean, hasVocals = true, detected = 'en') {
  const engine = new AnalysisEngine({ modelRoot: 'x', device: 'cpu' });
  const classify = vi.spyOn(engine.models, 'classify').mockResolvedValue({ isMusic, hasVocals, labels: [] } as never);
  vi.spyOn(engine.models, 'speechRegions').mockResolvedValue([[2, 3], [5, 6]]);
  const detectLanguage = vi.spyOn(engine.models, 'detectLanguage').mockResolvedValue(detected);
  const transcribe = vi.spyOn(engine.models, 'transcribe').mockImplementation(async () => ({ text: '', chunks: whisperChunks() }) as never);
  const qwenTranscribe = vi.spyOn(engine.models, 'qwenTranscribe').mockImplementation(async () => ({ chunks: qwenChunks() }));
  const ctcLogProbs = vi.spyOn(engine.models, 'ctcLogProbs').mockImplementation(async () => emit('_bar_'));
  vi.spyOn(engine.models, 'diarize').mockResolvedValue(undefined as never);
  return { engine, classify, detectLanguage, transcribe, qwenTranscribe, ctcLogProbs };
}
type Result = Awaited<ReturnType<AnalysisEngine['transcribe']>>;
const complete = (result: Result) => {
  if (result.status !== 'complete') throw new Error('expected a transcript');
  return result.transcript;
};
const wordsOf = (result: Result) => complete(result).segments.flatMap(s => s.words);
const textOf = (result: Result) => wordsOf(result).map(w => w.word);

/** The whisper-only reference: the same run with a language that never reaches Qwen, so the same stubs give whisper's chunks alone. */
async function whisperOnly() {
  const reference = setup(true, true, 'de');
  const result = await reference.engine.transcribe(pcm, 'de');
  expect(reference.qwenTranscribe).not.toHaveBeenCalled();
  return { result, ctcCalls: reference.ctcLogProbs.mock.calls.length };
}

describe('AnalysisEngine.transcribe: Qwen3-ASR and arbitration run only on English music files', () => {
  it('not music, English requested: no qwenTranscribe, no arbitration scoring, whisper\'s words exactly', async () => {
    const { engine, transcribe, qwenTranscribe, ctcLogProbs } = setup(false);
    const result = await engine.transcribe(pcm, 'en');
    const expected = await whisperOnly();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][1]).toBe('en');
    expect(qwenTranscribe).not.toHaveBeenCalled();
    expect(textOf(result)).toEqual(['hello', 'world', 'foo']);
    expect(wordsOf(result)).toEqual(wordsOf(expected.result)); // text and times
    expect(ctcLogProbs).toHaveBeenCalledTimes(complete(result).segments.length); // the realign pass only
    expect(ctcLogProbs).toHaveBeenCalledTimes(expected.ctcCalls);
    const strip = (t: ReturnType<typeof complete>) => ({ ...t, language: '', languages: [] as string[] });
    expect(strip(complete(result))).toEqual(strip(complete(expected.result)));
  });

  it('not music, English detected: no qwenTranscribe, no arbitration scoring, whisper\'s words exactly', async () => {
    const { engine, detectLanguage, transcribe, qwenTranscribe, ctcLogProbs } = setup(false);
    const result = await engine.transcribe(pcm);
    const expected = await whisperOnly();
    expect(detectLanguage).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][1]).toBe('en');
    expect(qwenTranscribe).not.toHaveBeenCalled();
    expect(complete(result).language).toBe('en');
    expect(textOf(result)).toEqual(['hello', 'world', 'foo']);
    expect(wordsOf(result)).toEqual(wordsOf(expected.result));
    expect(ctcLogProbs).toHaveBeenCalledTimes(complete(result).segments.length);
    expect(ctcLogProbs).toHaveBeenCalledTimes(expected.ctcCalls);
  });

  it('music, English requested: qwenTranscribe runs once and arbitration picks Qwen\'s words in the region it wins', async () => {
    const { engine, transcribe, qwenTranscribe, ctcLogProbs } = setup(true);
    const result = await engine.transcribe(pcm, 'en');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(qwenTranscribe).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toEqual(['hello', 'world', 'bar']); // region 1: Qwen's "bar" over whisper's "foo"
    expect(ctcLogProbs.mock.calls.length).toBeGreaterThan(complete(result).segments.length); // plus the arbitration call
  });

  it('music, English detected: the same arbitration', async () => {
    const { engine, detectLanguage, qwenTranscribe } = setup(true);
    const result = await engine.transcribe(pcm);
    expect(detectLanguage).toHaveBeenCalledTimes(1);
    expect(qwenTranscribe).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toEqual(['hello', 'world', 'bar']);
  });

  it.each([true, false])('another language requested (isMusic %s): no qwenTranscribe, whisper\'s words', async isMusic => {
    const { engine, detectLanguage, transcribe, qwenTranscribe } = setup(isMusic);
    const result = await engine.transcribe(pcm, 'de');
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(transcribe.mock.calls[0][1]).toBe('de');
    expect(qwenTranscribe).not.toHaveBeenCalled();
    expect(textOf(result)).toEqual(['hello', 'world', 'foo']);
  });

  it.each([true, false])('another language detected (isMusic %s): no qwenTranscribe, whisper\'s words', async isMusic => {
    const { engine, transcribe, qwenTranscribe } = setup(isMusic, true, 'fr');
    const result = await engine.transcribe(pcm);
    expect(transcribe.mock.calls[0][1]).toBe('fr');
    expect(qwenTranscribe).not.toHaveBeenCalled();
    expect(textOf(result)).toEqual(['hello', 'world', 'foo']);
  });

  it.each([undefined, 'en'])('music without vocals (language %s) is skipped before either decoder runs', async language => {
    const { engine, classify, detectLanguage, transcribe, qwenTranscribe } = setup(true, false);
    const result = await engine.transcribe(pcm, language);
    expect(result).toEqual({ status: 'skipped', transcript: null, reason: 'MUSIC_WITHOUT_VOCALS' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(qwenTranscribe).not.toHaveBeenCalled();
  });

  it.each([
    ['music, en', true, 'en'],
    ['not music, en', false, 'en'],
    ['music, de', true, 'de'],
    ['not music, de', false, 'de'],
  ] as const)('classify runs exactly once per transcribe (%s)', async (_name, isMusic, language) => {
    const { engine, classify } = setup(isMusic);
    await engine.transcribe(pcm, language);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('classify runs once with detected English too, music or not', async () => {
    for (const isMusic of [true, false]) {
      const { engine, classify } = setup(isMusic);
      await engine.transcribe(pcm);
      expect(classify).toHaveBeenCalledTimes(1);
    }
  });
});
