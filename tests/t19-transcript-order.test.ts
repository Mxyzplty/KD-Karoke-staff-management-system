// SPDX-License-Identifier: AGPL-3.0-only
// T19 review finding M3: the transcript must never run backwards in time (Whisper's overlapping 30 s windows re-emit audio).
import { describe, expect, it, vi } from 'vitest';
import { AnalysisEngine } from '../apps/web/src/analysis/engine';
import { makeTranscript } from '../apps/web/src/analysis/transcript';
import type { Transcript } from '../apps/web/src/analysis/types';

const rate = 16000;
const tone = (seconds: number) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 300 * i / rate));
const chunk = (text: string, start: number, end: number) => ({ text: ` ${text}`, timestamp: [start, end] as [number, number] });

/** The M3 property, over the flattened words and over the segments. */
function expectTimeOrder(transcript: Transcript) {
  const words = transcript.segments.flatMap(s => s.words);
  words.forEach((w, i) => {
    expect(w.start, `word ${i} (${w.word}) start <= end`).toBeLessThanOrEqual(w.end);
    if (i) expect(w.start, `word ${i} (${w.word}) starts after word ${i - 1} ends`).toBeGreaterThanOrEqual(words[i - 1].end);
  });
  transcript.segments.forEach((s, i) => {
    expect(s.start, `segment ${i} start <= end`).toBeLessThanOrEqual(s.end);
    if (i) expect(s.start, `segment ${i} starts after segment ${i - 1} ends`).toBeGreaterThanOrEqual(transcript.segments[i - 1].end);
  });
}
const times = (transcript: Transcript) => transcript.segments.flatMap(s => s.words.map(w => [w.word, w.start, w.end]));

describe('makeTranscript M3: words re-emitted by overlapping ASR windows', () => {
  const samples = tone(60), duration = 60;
  /** Every transcript built here must satisfy the M3 property, not only the tests that assert it by name. */
  const make = (chunks: ReturnType<typeof chunk>[], voice?: [number, number][]) => {
    const transcript = makeTranscript(chunks, samples, duration, 'en', voice);
    expectTimeOrder(transcript);
    return transcript;
  };

  // "So we go." closes a sentence, A B C D. is the first decode of the phrase, then the next window
  // re-emits it with one more word in front (X) starting before A did. The later copy wins.
  const duplicate = [
    chunk('So', 46, 46.32), chunk('we', 46.32, 46.64), chunk('go.', 46.64, 47),
    chunk('A', 47.88, 48.2), chunk('B', 48.2, 48.52), chunk('C', 48.52, 48.84), chunk('D.', 48.84, 49.16),
    chunk('X', 47.7, 47.88), chunk('A', 47.88, 48.2), chunk('B', 48.2, 48.52), chunk('C', 48.52, 48.84), chunk('D.', 48.84, 49.16),
    chunk('E', 49.2, 49.5),
  ];

  for (const [name, voice] of [['no voice array', undefined], ['a voice array covering everything', [[0, 60]] as [number, number][]]] as const) {
    describe(name, () => {
      it('keeps only the second copy of a duplicated phrase, in time order', () => {
        const transcript = make(duplicate, voice);
        expect(times(transcript)).toEqual([
          ['So', 46, 46.32], ['we', 46.32, 46.64], ['go.', 46.64, 47],
          ['X', 47.7, 47.88], ['A', 47.88, 48.2], ['B', 48.2, 48.52], ['C', 48.52, 48.84], ['D.', 48.84, 49.16],
          ['E', 49.2, 49.5],
        ]);
        expect(transcript.segments.map(s => [s.text, s.start, s.end])).toEqual([
          ['So we go.', 46, 47],
          ['X A B C D.', 47.7, 49.16],
          ['E', 49.2, 49.5],
        ]);
      });

      it('leaves ordered input unchanged', () => {
        const ordered = [
          chunk('hello', 1, 1.4), chunk('there', 1.4, 1.8), chunk('friend.', 1.8, 2.4),
          chunk('how', 3, 3.2), chunk('are', 3.2, 3.5), chunk('you', 3.5, 3.9),
        ];
        const transcript = make(ordered, voice);
        expect(times(transcript)).toEqual([
          ['hello', 1, 1.4], ['there', 1.4, 1.8], ['friend.', 1.8, 2.4],
          ['how', 3, 3.2], ['are', 3.2, 3.5], ['you', 3.5, 3.9],
        ]);
        expect(transcript.segments.map(s => [s.text, s.start, s.end])).toEqual([['hello there friend.', 1, 2.4], ['how are you', 3, 3.9]]);
      });
    });
  }

  it('drops only the kept words that start later than the new word, and trims the one it runs into', () => {
    const transcript = make([chunk('a', 10, 10.4), chunk('b', 10.4, 10.8), chunk('c', 10.8, 11.2), chunk('d', 10.5, 10.9), chunk('e', 10.9, 11.3)]);
    expect(times(transcript)).toEqual([['a', 10, 10.4], ['b', 10.4, 10.5], ['d', 10.5, 10.9], ['e', 10.9, 11.3]]);
  });

  it('trims a kept word that runs into the new word without dropping it', () => {
    const transcript = make([chunk('P', 47, 47.9), chunk('X', 47.7, 47.88), chunk('Y', 47.88, 48.2)]);
    expect(times(transcript)).toEqual([['P', 47, 47.7], ['X', 47.7, 47.88], ['Y', 47.88, 48.2]]);
  });

  it('replaces the first decode when the restart begins at the very same starts (no duplicate first word)', () => {
    const transcript = make([chunk('a', 20, 20.2), chunk('b', 20.2, 20.4), chunk('c', 20.4, 20.6), chunk('a', 20, 20.2), chunk('b', 20.2, 20.4), chunk('c', 20.4, 20.6), chunk('d', 20.6, 20.8)]);
    expect(times(transcript)).toEqual([['a', 20, 20.2], ['b', 20.2, 20.4], ['c', 20.4, 20.6], ['d', 20.6, 20.8]]);
  });

  it('unwinds a whole earlier decode when a later one restarts before it', () => {
    const transcript = make([chunk('a', 20, 20.2), chunk('b', 20.2, 20.4), chunk('c', 20.4, 20.6), chunk('x', 19.8, 20), chunk('a', 20, 20.2), chunk('b', 20.2, 20.4), chunk('c', 20.4, 20.6), chunk('d', 20.6, 20.8)]);
    expect(times(transcript)).toEqual([['x', 19.8, 20], ['a', 20, 20.2], ['b', 20.2, 20.4], ['c', 20.4, 20.6], ['d', 20.6, 20.8]]);
  });

  it('keeps words with an equal start when the earlier one is zero-length (collapsed DTW words)', () => {
    const transcript = make([chunk('a', 1, 1.2), chunk('b', 1.2, 1.2), chunk('c', 1.2, 1.5), chunk('d', 1.5, 1.8)]);
    expect(times(transcript)).toEqual([['a', 1, 1.2], ['b', 1.2, 1.2], ['c', 1.2, 1.5], ['d', 1.5, 1.8]]);
  });

  it("keeps a zero-length word at the new word's start (it does not overlap it)", () => {
    const transcript = make([chunk('a', 0.8, 1), chunk('b', 1, 1), chunk('c', 1, 1.4)]);
    expect(times(transcript)).toEqual([['a', 0.8, 1], ['b', 1, 1], ['c', 1, 1.4]]);
  });

  it('drops the earlier of two non-collapsed words that start together', () => {
    const transcript = make([chunk('x', 5, 5.2), chunk('y', 5, 5.2), chunk('z', 5.2, 5.4)]);
    expect(times(transcript)).toEqual([['y', 5, 5.2], ['z', 5.2, 5.4]]);
  });

  it('is the identical result as dropping the earlier copy by hand', () => {
    const withDuplicate = make(duplicate);
    const withoutEarlierCopy = make([...duplicate.slice(0, 3), ...duplicate.slice(7)]);
    expect(withDuplicate).toEqual(withoutEarlierCopy);
  });
});

describe('AnalysisEngine.realign M3: each CTC window is clamped to its neighbouring segments', () => {
  const seconds = 3, pcm = { sampleRate: rate, channels: 1, data: [tone(seconds)] };
  // "a b." and "c d" are 0.1 s apart (the sentence stop splits them), so the 0.5 s pads overlap.
  const chunks = [chunk('a', 1, 1.2), chunk('b.', 1.2, 1.4), chunk('c', 1.5, 1.7), chunk('d', 1.7, 1.9)];
  const blank = 0, a = 1, b = 2, delimiter = 3, classes = 4;
  const vocab = new Map([['a', a], ['b', b], ['|', delimiter]]);
  const emissions = (path: number[]) => {
    const logProbs = new Float32Array(path.length * classes).fill(-Infinity);
    path.forEach((label, frame) => { logProbs[frame * classes + label] = 0; });
    return { logProbs, frames: path.length, classes, vocab, blank, delimiter };
  };
  const noPath = emissions([a]);

  function setup(first: ReturnType<typeof emissions>, asr = chunks, second = noPath) {
    const engine = new AnalysisEngine({ modelRoot: 'x', device: 'cpu' });
    vi.spyOn(engine.models, 'classify').mockResolvedValue({ isMusic: false, hasVocals: true, labels: [] } as never);
    vi.spyOn(engine.models, 'speechRegions').mockResolvedValue([[0, seconds]]);
    vi.spyOn(engine.models, 'transcribe').mockResolvedValue({ text: asr.map(c => c.text).join(''), chunks: asr } as never);
    vi.spyOn(engine.models, 'qwenTranscribe').mockResolvedValue({ chunks: asr } as never);
    const windows: [number, number][] = [];
    const ctc = vi.spyOn(engine.models, 'ctcLogProbs').mockImplementation(async (audio: Float32Array) => {
      const from = audio.byteOffset / Float32Array.BYTES_PER_ELEMENT / rate;
      windows.push([from, from + audio.length / rate]);
      return windows.length === 1 ? first : windows.length === 2 ? second : noPath;
    });
    vi.spyOn(engine.models, 'diarize').mockResolvedValue(undefined as never);
    return { engine, ctc, windows };
  }

  it('stops the first window at the next segment and starts the second at the first one\'s end when the first is not re-timed', async () => {
    const { engine, ctc, windows } = setup(noPath);
    const result = await engine.transcribe(pcm, 'en');
    if (result.status !== 'complete') throw new Error('expected transcript');
    expect(result.transcript.segments.map(s => [s.text, s.start, s.end])).toEqual([['a b.', 1, 1.4], ['c d', 1.5, 1.9]]);
    expect(ctc).toHaveBeenCalledTimes(2);
    // Unclamped these would be [0.5, 1.9] and [1, 2.4].
    expect(windows[0][0]).toBeCloseTo(0.5, 6);
    expect(windows[0][1]).toBeCloseTo(1.5, 6);
    expect(windows[1][0]).toBeCloseTo(1.4, 6);
    expect(windows[1][1]).toBeCloseTo(2.4, 6);
    expectTimeOrder(result.transcript);
  });

  it('starts the second window at the first segment\'s re-timed end, not its ASR end', async () => {
    // Window 1 starts at 0.5 s: "a" at frame 10 (0.7 s), delimiter, "b" at frame 40 (1.3 s, ends 1.32 s).
    const path = Array<number>(60).fill(blank);
    path[10] = a; path[20] = delimiter; path[40] = b;
    const { engine, windows } = setup(emissions(path));
    const result = await engine.transcribe(pcm, 'en');
    if (result.status !== 'complete') throw new Error('expected transcript');
    expect(result.transcript.segments[0].end).toBe(1.32);
    expect(windows).toHaveLength(2);
    expect(windows[0][1]).toBeCloseTo(1.5, 6);
    expect(windows[1][0]).toBeCloseTo(1.32, 6);
    expect(windows[1][1]).toBeCloseTo(2.4, 6);
    expectTimeOrder(result.transcript);
  });

  it('clamps an unspellable word between its re-timed neighbours', async () => {
    // "5" has no spellable characters, so it keeps its ASR times 1.2-1.6, which overlap both neighbours once
    // they are re-timed: "a" to 1.30-1.32 (frame 40 of a window starting at 0.5 s), "b" to 1.54-1.56 (frame 52).
    const path = Array<number>(60).fill(blank);
    path[40] = a; path[50] = delimiter; path[52] = b;
    const { engine } = setup(emissions(path), [chunk('a', 1, 1.2), chunk('5', 1.2, 1.6), chunk('b', 1.6, 1.8)]);
    const result = await engine.transcribe(pcm, 'en');
    if (result.status !== 'complete') throw new Error('expected transcript');
    expect(result.transcript.segments).toHaveLength(1);
    const [first, digit, last] = result.transcript.segments[0].words;
    expect([first.start, first.end]).toEqual([1.3, 1.32]);
    expect([last.start, last.end]).toEqual([1.54, 1.56]);
    expect(digit.word).toBe('5');
    expect(digit.start).toBeGreaterThanOrEqual(first.end);
    expect(digit.end).toBeLessThanOrEqual(last.start);
    expect([digit.start, digit.end]).toEqual([1.32, 1.54]);
    expectTimeOrder(result.transcript);
  });

  it("clamps an unspellable first word up to the window start, which follows the previous segment's re-timed end", async () => {
    // Segment 1 ("a b.") is re-timed so "b." ends at 1.72 s, after segment 2's ASR start of 1.5 s. Segment 2's
    // window therefore starts at 1.72 s; its unspellable "5" (ASR 1.5-1.9 s) is clamped up to it, before "a" at 2.12 s.
    const first = Array<number>(70).fill(blank);
    first[10] = a; first[20] = delimiter; first[60] = b;
    const second = Array<number>(40).fill(blank);
    second[20] = a;
    const { engine, windows } = setup(emissions(first), [chunk('a', 1, 1.2), chunk('b.', 1.2, 1.4), chunk('5', 1.5, 1.9), chunk('a', 1.9, 2.1)], emissions(second));
    const result = await engine.transcribe(pcm, 'en');
    if (result.status !== 'complete') throw new Error('expected transcript');
    const [one, two] = result.transcript.segments;
    expect([one.start, one.end]).toEqual([0.7, 1.72]);
    expect(windows[1][0]).toBeCloseTo(1.72, 6);
    const [digit, letter] = two.words;
    expect(letter.word).toBe('a');
    expect([letter.start, letter.end]).toEqual([2.12, 2.14]);
    expect(digit.word).toBe('5');
    expect([digit.start, digit.end]).toEqual([1.72, 1.9]);
    expect(digit.start).toBeGreaterThanOrEqual(windows[1][0] - 1e-9);
    expectTimeOrder(result.transcript);
  });

  it('keeps an unspellable last word after its re-timed neighbour', async () => {
    // "a" is re-timed to 1.50-1.52 s, past the ASR start of "5" (1.2-1.8 s): its start follows "a"'s end and its
    // ASR end stands (the upper bound is the window end, 2.3 s, which an ASR end can never exceed).
    const path = Array<number>(60).fill(blank);
    path[50] = a;
    const { engine } = setup(emissions(path), [chunk('a', 1, 1.2), chunk('5', 1.2, 1.8)]);
    const result = await engine.transcribe(pcm, 'en');
    if (result.status !== 'complete') throw new Error('expected transcript');
    expect(result.transcript.segments).toHaveLength(1);
    const [letter, digit] = result.transcript.segments[0].words;
    expect([letter.start, letter.end]).toEqual([1.5, 1.52]);
    expect(digit.word).toBe('5');
    expect([digit.start, digit.end]).toEqual([1.52, 1.8]);
    expectTimeOrder(result.transcript);
  });
});
