// SPDX-License-Identifier: AGPL-3.0-only
// T19q T6: model-free unit tests for whisper/Qwen3-ASR arbitration — align.ts (spellOut, ctcScore), engine.ts (voiceRegion,
// sameWords, arbitrate, English routing) and models.ts (whisper and Qwen are never resident together). Every model call is stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ctcAlign, ctcScore, spellOut } from '../apps/web/src/analysis/align';
import { AnalysisEngine, sameWords, voiceRegion } from '../apps/web/src/analysis/engine';
import { LocalModels } from '../apps/web/src/analysis/models';

const mocks = vi.hoisted(() => ({ events: [] as string[], pipeline: vi.fn(), loadQwen3Asr: vi.fn() }));
vi.mock('@huggingface/transformers', async importOriginal => ({ ...(await importOriginal<typeof import('@huggingface/transformers')>()), pipeline: mocks.pipeline }));
vi.mock('../apps/web/src/analysis/qwen-asr', async importOriginal => ({ ...(await importOriginal<typeof import('../apps/web/src/analysis/qwen-asr')>()), loadQwen3Asr: mocks.loadQwen3Asr }));

const rate = 16000;
type Chunk = { text: string; timestamp: [number | null, number | null] };
const chunk = (text: string, start: number | null, end: number | null): Chunk => ({ text, timestamp: [start, end] });

// A 28-class alphabet for the engine-level tests: 0 blank, 1 delimiter, 2.. the letters a-z.
const blank = 0, delimiter = 1, classes = 28;
const vocab = new Map<string, number>([['|', delimiter], ...[...'abcdefghijklmnopqrstuvwxyz'].map((c, i) => [c, 2 + i] as [string, number])]);
/** One frame per path character ('_' blank, '|' delimiter, a letter): log-prob 0 on the path's label, `miss` elsewhere. */
function emit(path: string, miss = -5) {
  const logProbs = new Float32Array(path.length * classes).fill(miss);
  [...path].forEach((c, t) => { logProbs[t * classes + (c === '_' ? blank : c === '|' ? delimiter : vocab.get(c)!)] = 0; });
  return { logProbs, frames: path.length, classes, vocab, blank, delimiter };
}

describe('spellOut: scoring-only digit spelling', () => {
  it.each([
    ['4', ['four']],
    ['0', ['zero']],
    ['19', ['nineteen']],
    ['21', ['twenty', 'one']],
    ['100', ['one', 'hundred']],
    ['1999', ['one', 'thousand', 'nine', 'hundred', 'ninety', 'nine']],
    ['2094', ['two', 'thousand', 'ninety', 'four']],
    ['9999', ['nine', 'thousand', 'nine', 'hundred', 'ninety', 'nine']],
    ['1,000', ['one', 'thousand']],
    ['9,999', ['nine', 'thousand', 'nine', 'hundred', 'ninety', 'nine']],
    ['007', ['seven']],
  ])('cardinal %s', (word, expected) => expect(spellOut(word)).toEqual(expected));

  it.each([
    ['15th', ['fifteenth']],
    ['21st', ['twenty', 'first']],
    ['12th', ['twelfth']],
    ['20th', ['twentieth']],
    ['2nd', ['second']],
    ['3rd', ['third']],
    ['4th', ['fourth']],
    ['5th', ['fifth']],
    ['8th', ['eighth']],
    ['9th', ['ninth']],
    ['1st', ['first']],
    ['100th', ['one', 'hundredth']],
    ['1,000th', ['one', 'thousandth']],
    ['21ST', ['twenty', 'first']],
  ])('ordinal %s', (word, expected) => expect(spellOut(word)).toEqual(expected));

  it.each([
    ['4,', ['four']],
    ['(4)', ['four']],
    ['"15th"', ['fifteenth']],
    ['4.', ['four']],
    [' 4 ', ['four']],
  ])('punctuated %j', (word, expected) => expect(spellOut(word)).toEqual(expected));

  it.each(['hello', '12345', '1990s', '4.5', '10,000', '', 'a4', '4a', '4-5', '4th5', '-4', '(-4)'])('%j is returned unchanged', word => expect(spellOut(word)).toEqual([word]));

  it('never emits a hyphen or "and"', () => {
    for (const n of [21, 99, 101, 342, 1999, 2094]) expect(spellOut(String(n)).some(w => /-|^and$/.test(w))).toBe(false);
  });
});

describe('ctcScore: Viterbi best-path log-likelihood', () => {
  // Classes: 0 blank, 1 delimiter, 2 'a', 3 'b'. Rows are frames.
  const [B, D, A, Bb] = [0, 1, 2, 3], width = 4;
  const matrix = (rows: number[][]) => ({ logProbs: Float32Array.from(rows.flat()), frames: rows.length });
  const score = (m: { logProbs: Float32Array; frames: number }, words: number[][]) => ctcScore(m.logProbs, m.frames, width, words, B, D);

  it('(a) a hand-worked best path: a, blank, delimiter, b, blank = -0.1 - 0.5 - 0.2 - 0.3 - 0.4', () => {
    const m = matrix([
      [-2, -9, -0.1, -9],
      [-0.5, -9, -1, -9],
      [-3, -0.2, -9, -9],
      [-9, -9, -9, -0.3],
      [-0.4, -9, -9, -1.5],
    ]);
    expect(score(m, [[A], [Bb]])).toBeCloseTo(-1.5, 5);
  });

  it('(b) the best valid path is not the per-frame argmax: "aa" needs a blank between its letters', () => {
    // Argmax is a,a,a,a (one letter once collapsed). The best valid path is a, blank, a, a = -0.1 - 1 - 0.1 - 0.3.
    const m = matrix([
      [-4, -9, -0.1, -9],
      [-1, -9, -0.2, -9],
      [-3, -9, -0.1, -9],
      [-2, -9, -0.3, -9],
    ]);
    expect(score(m, [[A, A]])).toBeCloseTo(-1.5, 5);
  });

  it('agrees with a brute-force maximum over every CTC path', () => {
    // 5 frames of fixed, varied log-probs; enumerate all 4^5 label sequences and keep those that collapse to the target.
    const rows = [[-0.7, -1.2, -0.9, -2.5], [-1.1, -2.2, -0.4, -1.3], [-0.3, -0.8, -2.0, -1.9], [-2.4, -0.6, -1.0, -0.5], [-0.9, -1.7, -1.5, -0.35]];
    const m = matrix(rows);
    const collapse = (labels: number[]) => labels.filter((l, i) => l !== B && l !== labels[i - 1]);
    const brute = (target: number[]) => {
      let best = -Infinity;
      for (let code = 0; code < 4 ** rows.length; code++) {
        const labels = Array.from({ length: rows.length }, (_, t) => Math.floor(code / 4 ** t) % 4);
        const collapsed = collapse(labels);
        if (collapsed.length !== target.length || collapsed.some((l, i) => l !== target[i])) continue;
        best = Math.max(best, labels.reduce((sum, l, t) => sum + Math.fround(rows[t][l]), 0));
      }
      return best;
    };
    for (const [words, target] of [[[[A], [Bb]], [A, D, Bb]], [[[A, Bb]], [A, Bb]], [[[A, A]], [A, A]], [[[Bb], [Bb]], [Bb, D, Bb]]] as [number[][], number[]][]) {
      expect(score(m, words)).toBeCloseTo(brute(target), 5);
    }
  });

  it('(c) is null when there are fewer frames than tokens', () => {
    const m = matrix([[-1, -1, -0.1, -9], [-1, -1, -9, -0.1]]);
    expect(score(m, [[A], [Bb]])).toBeNull(); // three tokens (a, delimiter, b) in two frames
    expect(score(m, [[A, Bb, A]])).toBeNull();
  });

  it('(d) is null for a repeated letter without room for the blank, and exists once it fits', () => {
    const two = matrix([[-1, -9, -0.1, -9], [-1, -9, -0.1, -9]]);
    expect(score(two, [[A, A]])).toBeNull(); // frames == tokens, but a,a needs a blank in between
    const three = matrix([[-1, -9, -0.1, -9], [-0.5, -9, -9, -9], [-1, -9, -0.1, -9]]);
    expect(score(three, [[A, A]])).toBeCloseTo(-0.1 - 0.5 - 0.1, 5);
  });

  it('(e) with no words the path is all blanks, the sum of the blank log-probs over every frame', () => {
    const m = matrix([[-0.25, -9, -9, -9], [-0.5, -9, -9, -9], [-1.25, -9, -9, -9]]);
    expect(score(m, [])).toBeCloseTo(-2, 5);
    expect(score(matrix([[-0.75, -9, -9, -9]]), [])).toBeCloseTo(-0.75, 5);
  });

  it('(f) is null for zero frames, with or without words', () => {
    const m = matrix([]);
    expect(score(m, [])).toBeNull();
    expect(score(m, [[A]])).toBeNull();
  });

  it('is null when no path has finite probability', () => {
    const m = matrix([[0, -Infinity, -Infinity, -Infinity], [0, -Infinity, -Infinity, -Infinity]]);
    expect(score(m, [[A]])).toBeNull();
  });

  it('a single letter in a single frame scores that letter', () => {
    expect(score(matrix([[-2, -9, -0.6, -9]]), [[A]])).toBeCloseTo(-0.6, 5);
  });

  it('(g) equals the sum of log-probs along the path ctcAlign takes', () => {
    const rows = [
      [-0.1, -3, -2, -4],
      [-1.5, -3, -0.2, -4],
      [-2, -3, -0.3, -4],
      [-2.5, -0.4, -3, -3],
      [-3, -3, -3, -0.5],
      [-0.6, -3, -3, -2],
    ];
    const m = matrix(rows), words = [[A], [Bb]];
    const spans = ctcAlign(m.logProbs, m.frames, width, words, B, D)!;
    expect(spans).toEqual([[1, 3], [4, 5]]);
    // Single-letter words: a span is exactly the frames of its letter; the one frame between the spans is the delimiter.
    const path = Array<number>(m.frames).fill(B);
    spans.forEach(([start, end], w) => { for (let t = start; t < end; t++) path[t] = words[w][0]; });
    expect(spans[1][0] - spans[0][1]).toBe(1);
    path[spans[0][1]] = D;
    expect(path).toEqual([B, A, A, D, Bb, B]);
    const along = path.reduce((sum, label, t) => sum + m.logProbs[t * width + label], 0);
    expect(score(m, words)).toBeCloseTo(along, 6);
    expect(along).toBeCloseTo(-2.1, 5);
  });
});

describe('voiceRegion: which voice region a word belongs to', () => {
  const voice: [number, number][] = [[1, 2], [4, 5]];
  const at = (start: number | null, end: number | null) => chunk('x', start, end);

  it('a midpoint inside a region selects it, bounds inclusive', () => {
    expect(voiceRegion(at(1.2, 1.6), voice)).toBe(0);
    expect(voiceRegion(at(4.2, 4.6), voice)).toBe(1);
    expect(voiceRegion(at(2, 2), voice)).toBe(0); // midpoint on a region's end
    expect(voiceRegion(at(4, 4), voice)).toBe(1); // midpoint on a region's start
  });
  it('a midpoint in the gap goes to the nearer region', () => {
    expect(voiceRegion(at(3.5, 3.7), [[0, 2], [5, 6]])).toBe(1); // 3.6: 1.6 from region 0's end, 1.4 from region 1's start
    expect(voiceRegion(at(3.8, 4.2), [[0, 2], [5, 6]])).toBe(1); // 4: 2 from region 0, 1 from region 1
    expect(voiceRegion(at(2.4, 2.6), [[0, 2], [5, 6]])).toBe(0); // 2.5: 0.5 from region 0, 2.5 from region 1
  });
  it('an exact tie goes to the earlier region', () => {
    expect(voiceRegion(at(2, 4), voice)).toBe(0); // midpoint 3: 1 from each
  });
  it('before the first region and after the last', () => {
    expect(voiceRegion(at(0.1, 0.3), voice)).toBe(0);
    expect(voiceRegion(at(8, 9), voice)).toBe(1);
  });
  it('a word without times goes to the first region; no regions gives 0', () => {
    expect(voiceRegion(at(null, null), voice)).toBe(0);
    expect(voiceRegion(at(null, 4.5), voice)).toBe(0);
    expect(voiceRegion(at(1, 2), [])).toBe(0);
  });
});

describe('sameWords: equality after lowercasing and stripping punctuation', () => {
  const seq = (...texts: string[]) => texts.map(text => chunk(text, 0, 1));

  it('ignores case, punctuation and spacing', () => {
    expect(sameWords(seq(' Hello,', ' world.'), seq('hello', 'World'))).toBe(true);
    expect(sameWords(seq('Hello, world.'), seq('hello', 'world'))).toBe(true);
    expect(sameWords(seq('“Quoted”', 'text…'), seq('quoted text'))).toBe(true);
  });
  it('reads a curly apostrophe as a straight one and keeps it', () => {
    expect(sameWords(seq('don’t'), seq("don't"))).toBe(true);
    expect(sameWords(seq("don't"), seq('dont'))).toBe(false);
  });
  it('keeps hyphens: flour-fatted differs from flour fatted', () => {
    expect(sameWords(seq('flour-fatted'), seq('flour fatted'))).toBe(false);
    expect(sameWords(seq('Flour-Fatted,'), seq('flour-fatted'))).toBe(true);
  });
  it('differs on different words, extra words and digits vs spelled-out numbers', () => {
    expect(sameWords(seq('hello', 'world'), seq('hello', 'word'))).toBe(false);
    expect(sameWords(seq('hello'), seq('hello', 'world'))).toBe(false);
    expect(sameWords(seq('4'), seq('four'))).toBe(false);
  });
  it('empty sequences, and punctuation-only chunks, are equal to nothing', () => {
    expect(sameWords([], [])).toBe(true);
    expect(sameWords(seq('...'), [])).toBe(true);
    expect(sameWords(seq('', ' '), [])).toBe(true);
    expect(sameWords(seq('a'), [])).toBe(false);
  });
});

describe('AnalysisEngine.arbitrate: per voice region, whisper unless qwen differs and scores strictly higher', () => {
  type Matrix = ReturnType<typeof emit>;
  /** `matrices`: what ctcLogProbs returns on its n-th call (the last one repeats). `windows` records each call's [from, to] in seconds. */
  function setup(matrices: Matrix | Matrix[]) {
    const engine = new AnalysisEngine({ modelRoot: 'x', device: 'cpu' });
    const list = Array.isArray(matrices) ? matrices : [matrices], windows: [number, number][] = [], buffers: ArrayBufferLike[] = [];
    const ctc = vi.spyOn(engine.models, 'ctcLogProbs').mockImplementation(async (audio: Float32Array) => {
      const from = audio.byteOffset / Float32Array.BYTES_PER_ELEMENT / rate;
      windows.push([from, from + audio.length / rate]);
      buffers.push(audio.buffer);
      return list[Math.min(windows.length - 1, list.length - 1)];
    });
    const run = (audio: Float32Array, voice: [number, number][], whisper: Chunk[], qwen: Chunk[]): Promise<Chunk[]> => engine['arbitrate'](audio, voice, whisper, qwen);
    return { engine, ctc, windows, buffers, run };
  }
  const silence = (seconds: number) => new Float32Array(Math.round(seconds * rate));
  const oneRegion = [[1, 2]] as [number, number][];

  it('equal word sequences keep whisper and never call ctcLogProbs', async () => {
    const { ctc, run } = setup(emit('_b_'));
    const whisper = [chunk(' Hello,', 1.1, 1.4), chunk(' world.', 1.5, 1.9)], qwen = [chunk('hello', 1.1, 1.4), chunk('World', 1.5, 1.9)];
    const result = await run(silence(4), oneRegion, whisper, qwen);
    expect(result).toEqual(whisper);
    expect(result[0]).toBe(whisper[0]);
    expect(ctc).not.toHaveBeenCalled();
  });

  it('qwen scoring strictly higher wins the region', async () => {
    const { ctc, run } = setup(emit('_b_'));
    const whisper = [chunk(' a', 1.2, 1.4)], qwen = [chunk(' b', 1.2, 1.4)];
    const result = await run(silence(4), oneRegion, whisper, qwen);
    expect(ctc).toHaveBeenCalledTimes(1);
    expect(result).toEqual(qwen);
    expect(result[0]).toBe(qwen[0]);
  });

  it('whisper scoring higher keeps whisper', async () => {
    const { run } = setup(emit('_a_'));
    const whisper = [chunk(' a', 1.2, 1.4)], qwen = [chunk(' b', 1.2, 1.4)];
    expect(await run(silence(4), oneRegion, whisper, qwen)).toEqual(whisper);
  });

  it('a tie keeps whisper (words differing only in what the aligner cannot spell)', async () => {
    const { ctc, run } = setup(emit('_a_'));
    const whisper = [chunk('a', 1.1, 1.3), chunk('$', 1.4, 1.5)], qwen = [chunk('a', 1.1, 1.3), chunk('€', 1.4, 1.5)];
    const result = await run(silence(4), oneRegion, whisper, qwen);
    expect(ctc).toHaveBeenCalledTimes(1); // not sameWords: the symbols differ
    expect(result).toEqual(whisper);
    expect(result[1]).toBe(whisper[1]);
  });

  it('whisper with no path (more tokens than frames) keeps whisper even though qwen scores', async () => {
    const { run } = setup(emit('_b_')); // 3 frames; "a a a" is 5 tokens
    const whisper = [chunk(' a', 1.1, 1.2), chunk(' a', 1.3, 1.4), chunk(' a', 1.5, 1.6)], qwen = [chunk(' b', 1.2, 1.4)];
    expect(await run(silence(4), oneRegion, whisper, qwen)).toEqual(whisper);
  });

  it('qwen with no path keeps whisper', async () => {
    const { run } = setup(emit('_b_'));
    const whisper = [chunk(' a', 1.2, 1.4)], qwen = [chunk(' b', 1.1, 1.2), chunk(' b', 1.3, 1.4), chunk(' b', 1.5, 1.6)];
    expect(await run(silence(4), oneRegion, whisper, qwen)).toEqual(whisper);
  });

  it('both without a path keeps whisper', async () => {
    const { run } = setup(emit('_b_'));
    const whisper = [chunk('a', 1.1, 1.2), chunk('a', 1.3, 1.4), chunk('a', 1.5, 1.6)], qwen = [chunk('b', 1.1, 1.2), chunk('b', 1.3, 1.4), chunk('b', 1.5, 1.6)];
    expect(await run(silence(4), oneRegion, whisper, qwen)).toEqual(whisper);
  });

  it('keeps the winning model\'s own text: qwen\'s "4" is scored as "four" but stays "4"', async () => {
    const { run } = setup(emit('_four_'));
    const whisper = [chunk(' fur', 1.2, 1.5)], qwen = [chunk('4', 1.2, 1.5)];
    const result = await run(silence(4), oneRegion, whisper, qwen);
    expect(result).toEqual([chunk('4', 1.2, 1.5)]);
    expect(result[0]).toBe(qwen[0]);
  });

  it('spells an ordinal for the score too: qwen\'s "15th" is scored as "fifteenth"', async () => {
    const { run } = setup(emit('_fifte_enth_')); // "ee" needs the blank between its letters
    const whisper = [chunk(' fifty', 1.2, 1.5)], qwen = [chunk('15th', 1.2, 1.5)];
    const result = await run(silence(4), oneRegion, whisper, qwen);
    expect(result).toEqual(qwen);
  });

  it('a region where whisper has words and qwen none is scored against the all-blank path', async () => {
    const speech = setup(emit('_a_')), silent = setup(emit('___'));
    const whisper = [chunk(' a', 1.2, 1.4)];
    // The audio has an "a": whisper's words beat an empty qwen.
    expect(await speech.run(silence(4), oneRegion, whisper, [])).toEqual(whisper);
    expect(speech.ctc).toHaveBeenCalledTimes(1);
    // The audio is silent: all blanks (0) beat whisper's "a" (-5), so whisper's words are dropped.
    expect(await silent.run(silence(4), oneRegion, whisper, [])).toEqual([]);
  });

  it('a region where qwen has words and whisper none is scored the same way', async () => {
    const speech = setup(emit('_b_')), silent = setup(emit('___'));
    const qwen = [chunk(' b', 1.2, 1.4)];
    expect(await speech.run(silence(4), oneRegion, [], qwen)).toEqual(qwen);
    expect(await silent.run(silence(4), oneRegion, [], qwen)).toEqual([]); // all blanks: the empty whisper side wins the region
  });

  it('substitutes qwen\'s chunks for the regions it wins; with region-ordered input that is region order', async () => {
    const voice: [number, number][] = [[1, 2], [4, 5], [7, 8]];
    const { ctc, windows, run } = setup([emit('_b|b_'), emit('_a|a_')]);
    const w0 = chunk(' a', 1.2, 1.4), w1 = [chunk(' same', 4.1, 4.4), chunk(' words', 4.5, 4.9)], w2 = [chunk(' a', 7.2, 7.4), chunk(' a', 7.5, 7.7)];
    const q0 = [chunk(' b', 1.2, 1.3), chunk(' b', 1.3, 1.4)], q1 = [chunk('Same', 4.1, 4.4), chunk('words.', 4.5, 4.9)], q2 = [chunk(' b', 7.2, 7.7)];
    const result = await run(silence(10), voice, [w0, ...w1, ...w2], [...q0, ...q1, ...q2]);
    expect(ctc).toHaveBeenCalledTimes(2); // the middle region is equal and unscored
    expect(windows[0][0]).toBeCloseTo(0.75, 4); expect(windows[0][1]).toBeCloseTo(2.25, 4);
    expect(windows[1][0]).toBeCloseTo(6.75, 4); expect(windows[1][1]).toBeCloseTo(8.25, 4);
    expect(result).toHaveLength(q0.length + w1.length + w2.length);
    expect(result[0]).toBe(q0[0]); expect(result[1]).toBe(q0[1]);
    expect(result[2]).toBe(w1[0]); expect(result[3]).toBe(w1[1]);
    expect(result[4]).toBe(w2[0]); expect(result[5]).toBe(w2[1]);
  });

  it('assigns each model\'s words to regions by its own timestamps', async () => {
    const voice: [number, number][] = [[1, 2], [4, 5]];
    const { windows, run } = setup(emit('_a_'));
    // Whisper's word sits in region 1 only; qwen's only in region 0, so both regions differ and both are scored.
    const result = await run(silence(8), voice, [chunk(' a', 4.2, 4.4)], [chunk(' a', 1.2, 1.4)]);
    expect(windows).toHaveLength(2);
    // Region 0: whisper has nothing, qwen "a" over an "a" -> qwen. Region 1: whisper "a" over an "a", qwen nothing -> whisper.
    expect(result.map(c => c.timestamp[0])).toEqual([1.2, 4.2]);
  });

  describe('output order: whisper\'s sequence, each qwen-won region substituted in place', () => {
    const at = (text: string, t: number) => chunk(text, t, t + 0.1);
    const identical = (result: Chunk[], whisper: Chunk[]) => {
      expect(result).toHaveLength(whisper.length);
      whisper.forEach((c, i) => expect(result[i]).toBe(c));
    };
    // Whisper jumps back: 1.6 (region 0) is emitted after region 1's 3.5 and 4.5, and 4.8 (region 1) after it.
    const backJump = [[0, 2], [3, 5]] as [number, number][];
    const jumpWhisper = (a: string, c: string) => [at(a, 0.5), at(a, 1.5), at(c, 3.5), at(c, 4.5), at(a, 1.6), at(c, 4.8)];
    const three = [[1, 2], [4, 5], [7, 8]] as [number, number][];
    const four = [[1, 2], [4, 5], [7, 8], [10, 11]] as [number, number][];

    describe('whisper keeps every region: the result is whisper\'s array, element by element', () => {
      it('all regions equal (and no ctcLogProbs call), with a back-jump', async () => {
        const { ctc, run } = setup(emit('_b_'));
        const whisper = jumpWhisper(' a', ' c'), qwen = [at('A,', 0.5), at('a', 1.5), at('C', 3.5), at('c.', 4.5), at('a', 1.6), at('c', 4.8)];
        identical(await run(silence(8), backJump, whisper, qwen), whisper);
        expect(ctc).not.toHaveBeenCalled();
      });

      it('whisper scoring higher in every region, with a back-jump', async () => {
        const { ctc, run } = setup([emit('_a|a|a_'), emit('_c|c|c_')]);
        const whisper = jumpWhisper(' a', ' c'), qwen = [at(' b', 0.5), at(' b', 1.5), at(' d', 3.5), at(' d', 4.5)];
        identical(await run(silence(8), backJump, whisper, qwen), whisper);
        expect(ctc).toHaveBeenCalledTimes(2);
      });

      it('a tie in every region, with a back-jump', async () => {
        const { ctc, run } = setup(emit('_a_'));
        const whisper = [at('a', 0.5), at('$', 1.5), at('a', 3.5), at('$', 4.5), at('$', 1.6), at('$', 4.8)];
        const qwen = [at('a', 0.5), at('€', 1.5), at('a', 3.5), at('€', 4.5)];
        identical(await run(silence(8), backJump, whisper, qwen), whisper);
        expect(ctc).toHaveBeenCalledTimes(2); // scored, not skipped as equal
      });

      it('an empty whisper and an empty qwen give an empty result', async () => {
        const { run } = setup(emit('_b_'));
        expect(await run(silence(8), backJump, [], [])).toEqual([]);
      });
    });

    describe('a qwen-won region takes the slot of its first whisper chunk', () => {
      it('the middle of three: whisper region 0, qwen region 1, whisper region 2', async () => {
        const { ctc, run } = setup(emit('_b|b_'));
        const w0 = [at(' x', 1.2)], w1 = [at(' a', 4.1), at(' a', 4.5), at(' a', 4.8)], w2 = [at(' y', 7.2), at(' z', 7.5)];
        const q0 = [at('X', 1.2)], q1 = [at(' b', 4.1), at(' b', 4.6)], q2 = [at('y', 7.2), at('Z.', 7.5)];
        const result = await run(silence(10), three, [...w0, ...w1, ...w2], [...q0, ...q1, ...q2]);
        expect(ctc).toHaveBeenCalledTimes(1); // regions 0 and 2 are equal
        expect(result).toHaveLength(5);
        expect(result[0]).toBe(w0[0]);
        expect(result[1]).toBe(q1[0]); expect(result[2]).toBe(q1[1]);
        expect(result[3]).toBe(w2[0]); expect(result[4]).toBe(w2[1]);
      });

      it('region 0 of the back-jump input: qwen once at whisper\'s first region-0 chunk; the re-emitted 1.6 is dropped too', async () => {
        const { ctc, run } = setup(emit('_b|b_'));
        const whisper = jumpWhisper(' a', ' c'), q0 = [at(' b', 0.5), at(' b', 1.5)];
        const qwen = [...q0, at('C', 3.5), at('c', 4.5), at('c', 4.8)];
        const result = await run(silence(8), backJump, whisper, qwen);
        expect(ctc).toHaveBeenCalledTimes(1); // region 1 is equal
        expect(result).toHaveLength(5);
        expect(result[0]).toBe(q0[0]); expect(result[1]).toBe(q0[1]);
        expect(result[2]).toBe(whisper[2]); expect(result[3]).toBe(whisper[3]); expect(result[4]).toBe(whisper[5]);
        expect(result).not.toContain(whisper[0]); expect(result).not.toContain(whisper[1]); expect(result).not.toContain(whisper[4]);
      });

      it('region 1 of the back-jump input: whisper\'s region-0 chunks keep their places, including the late 1.6', async () => {
        const { run } = setup(emit('_b|b_'));
        const whisper = jumpWhisper(' a', ' c'), q1 = [at(' b', 3.5), at(' b', 4.5)];
        const result = await run(silence(8), backJump, whisper, [at('A', 0.5), at('a', 1.5), at('a', 1.6), ...q1]);
        expect(result).toHaveLength(5);
        expect(result[0]).toBe(whisper[0]); expect(result[1]).toBe(whisper[1]);
        expect(result[2]).toBe(q1[0]); expect(result[3]).toBe(q1[1]); // the slot of whisper's 3.5; 4.5 and 4.8 are dropped
        expect(result[4]).toBe(whisper[4]);
      });
    });

    describe('a qwen-won region with no whisper words', () => {
      it('(a) the middle one goes right before whisper\'s first region-2 chunk', async () => {
        const { run } = setup(emit('_b_'));
        const w0 = [at(' x', 1.2)], w2 = [at(' y', 7.2), at(' z', 7.5)], q1 = [at(' b', 4.2)];
        const result = await run(silence(10), three, [...w0, ...w2], [at('X', 1.2), ...q1, at('y', 7.2), at('z', 7.5)]);
        expect(result).toHaveLength(4);
        expect(result[0]).toBe(w0[0]); expect(result[1]).toBe(q1[0]);
        expect(result[2]).toBe(w2[0]); expect(result[3]).toBe(w2[1]);
      });

      it('(b) the last one is appended at the end', async () => {
        const { run } = setup(emit('_b_'));
        const w0 = [at(' x', 1.2)], w1 = [at(' y', 4.2)], q2 = [at(' b', 7.2)];
        const result = await run(silence(10), three, [...w0, ...w1], [at('X', 1.2), at('Y', 4.2), ...q2]);
        expect(result).toHaveLength(3);
        expect(result[0]).toBe(w0[0]); expect(result[1]).toBe(w1[0]); expect(result[2]).toBe(q2[0]);
      });

      it('(c) two in a row (regions 1 and 2 of four) go in region order before whisper\'s first region-3 chunk', async () => {
        const { ctc, run } = setup(emit('_b_'));
        const w0 = [at(' x', 1.2)], w3 = [at(' y', 10.2), at(' z', 10.5)], q1 = [at(' b', 4.2)], q2 = [at(' b', 7.2)];
        const result = await run(silence(13), four, [...w0, ...w3], [at('X', 1.2), ...q1, ...q2, at('y', 10.2), at('z', 10.5)]);
        expect(ctc).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(5);
        expect(result[0]).toBe(w0[0]); expect(result[1]).toBe(q1[0]); expect(result[2]).toBe(q2[0]);
        expect(result[3]).toBe(w3[0]); expect(result[4]).toBe(w3[1]);
      });

      it('(d) the first one comes first, before whisper\'s first chunk', async () => {
        const { run } = setup(emit('_b_'));
        const w1 = [at(' y', 4.2), at(' z', 4.5)], q0 = [at(' b', 1.2)];
        const result = await run(silence(10), three, w1, [...q0, at('Y', 4.2), at('z', 4.5)]);
        expect(result).toHaveLength(3);
        expect(result[0]).toBe(q0[0]); expect(result[1]).toBe(w1[0]); expect(result[2]).toBe(w1[1]);
      });

      it('a pending region is flushed once, and a later lower-region whisper chunk keeps its place', async () => {
        // Whisper: region 0, region 2, then a late region-0 chunk. Qwen wins empty region 1 and keeps the rest.
        const { run } = setup(emit('_b_'));
        const w = [at(' x', 1.2), at(' y', 7.2), at(' x', 1.4)], q1 = [at(' b', 4.2)];
        const result = await run(silence(10), three, w, [at('X', 1.2), at('x', 1.4), ...q1, at('Y', 7.2)]);
        expect(result.filter(c => c === q1[0])).toHaveLength(1);
        expect(result).toHaveLength(4);
        expect(result[0]).toBe(w[0]); expect(result[1]).toBe(q1[0]); expect(result[2]).toBe(w[1]); expect(result[3]).toBe(w[2]);
      });
    });
  });

  describe('the audio window passed to ctcLogProbs', () => {
    const differing = (start: number, end: number) => ({ whisper: [chunk(' a', start, end)], qwen: [chunk(' b', start, end)] });
    const expectWindow = (got: [number, number], from: number, to: number) => { expect(got[0]).toBeCloseTo(from, 4); expect(got[1]).toBeCloseTo(to, 4); };

    it('is the region padded by 0.25 s each side', async () => {
      const { windows, run } = setup(emit('_b_'));
      const { whisper, qwen } = differing(5.2, 5.8);
      await run(silence(20), [[5, 6]], whisper, qwen);
      expect(windows).toHaveLength(1);
      expectWindow(windows[0], 4.75, 6.25);
    });

    it('is a view onto the same audio buffer, not a copy', async () => {
      const { buffers, run } = setup(emit('_b_'));
      const audio = silence(20), { whisper, qwen } = differing(5.2, 5.8);
      await run(audio, [[5, 6]], whisper, qwen);
      expect(buffers[0]).toBe(audio.buffer);
    });

    it('stops short of the neighbouring regions (previous end / next start)', async () => {
      const { windows, run } = setup(emit('_b_'));
      const voice: [number, number][] = [[2, 3], [3.1, 4]];
      await run(silence(20), voice, [chunk(' a', 2.4, 2.6), chunk(' a', 3.5, 3.7)], [chunk(' b', 2.4, 2.6), chunk(' b', 3.5, 3.7)]);
      expect(windows).toHaveLength(2);
      expectWindow(windows[0], 1.75, 3.1); // to = next region's start, not 3.25
      expectWindow(windows[1], 3, 4.25); // from = previous region's end, not 2.85
    });

    it('is clamped to the start of the file', async () => {
      const { windows, run } = setup(emit('_b_'));
      const { whisper, qwen } = differing(0.1, 0.2);
      await run(silence(20), [[0.1, 0.3]], whisper, qwen);
      expectWindow(windows[0], 0, 0.55);
    });

    it('is clamped to the end of the file', async () => {
      const { windows, run } = setup(emit('_b_'));
      const { whisper, qwen } = differing(19.9, 20);
      await run(silence(20), [[19.8, 20]], whisper, qwen);
      expectWindow(windows[0], 19.55, 20);
    });
  });
});

describe('AnalysisEngine.transcribe: English runs whisper then Qwen3-ASR and arbitrates; other languages stay on whisper', () => {
  const tone = (seconds: number) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / rate));
  // Voice [[2,3],[5,6]] -> the voiced slice starts at 1.75 s; chunk times below are local to it.
  const whisperChunks = () => [chunk(' hello', 0.5, 0.9), chunk(' world', 0.9, 1.3), chunk(' foo', 3.5, 3.9)];
  const qwenChunks = () => [chunk('hello', 0.5, 0.9), chunk('world', 0.9, 1.3), chunk('bar', 3.5, 3.9)];

  function setup(matrix = emit('_bar_'), detected = 'en') {
    const engine = new AnalysisEngine({ modelRoot: 'x', device: 'cpu' });
    vi.spyOn(engine.models, 'classify').mockResolvedValue({ isMusic: true, hasVocals: true, labels: [] } as never);
    vi.spyOn(engine.models, 'speechRegions').mockResolvedValue([[2, 3], [5, 6]]);
    const detectLanguage = vi.spyOn(engine.models, 'detectLanguage').mockResolvedValue(detected);
    const transcribe = vi.spyOn(engine.models, 'transcribe').mockImplementation(async () => ({ text: '', chunks: whisperChunks() }) as never);
    const qwenTranscribe = vi.spyOn(engine.models, 'qwenTranscribe').mockImplementation(async () => ({ chunks: qwenChunks() }));
    const ctcLogProbs = vi.spyOn(engine.models, 'ctcLogProbs').mockImplementation(async () => matrix);
    const diarize = vi.spyOn(engine.models, 'diarize').mockResolvedValue(undefined as never);
    return { engine, detectLanguage, transcribe, qwenTranscribe, ctcLogProbs, diarize };
  }
  const pcm = { sampleRate: rate, channels: 1, data: [tone(10)] };
  const wordsOf = (result: Awaited<ReturnType<AnalysisEngine['transcribe']>>) => {
    if (result.status !== 'complete') throw new Error('expected a transcript');
    return result.transcript.segments.flatMap(s => s.words.map(w => w.word));
  };

  it('English calls transcribe, then qwenTranscribe on the same voiced slice, and keeps the arbitrated words', async () => {
    const { engine, transcribe, qwenTranscribe, diarize } = setup(emit('_bar_'));
    const result = await engine.transcribe(pcm, 'en');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(qwenTranscribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.invocationCallOrder[0]).toBeLessThan(qwenTranscribe.mock.invocationCallOrder[0]);
    const [voiced, language] = transcribe.mock.calls[0], [qwenVoiced, localVoice, voicedDuration] = qwenTranscribe.mock.calls[0];
    expect(language).toBe('en');
    expect(qwenVoiced).toBe(voiced);
    expect(voiced.length / rate).toBeCloseTo(4.5, 6);
    expect(localVoice).toEqual([[0.25, 1.25], [3.25, 4.25]]);
    expect(voicedDuration).toBeCloseTo(4.5, 6);
    // Region 0 is the same words; in region 1 the matrix spells "bar", so qwen wins it.
    expect(wordsOf(result)).toEqual(['hello', 'world', 'bar']);
    expect(diarize).toHaveBeenCalledTimes(1);
    if (result.status !== 'complete') throw new Error('unreachable');
    expect(diarize.mock.calls[0][1]).toBe(result.transcript);
  });

  it('English keeps whisper\'s words where whisper scores higher', async () => {
    const { engine } = setup(emit('_fo_o_'));
    expect(wordsOf(await engine.transcribe(pcm, 'en'))).toEqual(['hello', 'world', 'foo']);
  });

  it('whisper\'s local times are moved by the voiced slice\'s start (1.75 s) before arbitration', async () => {
    const { engine } = setup(emit('_bar_'));
    const result = await engine.transcribe(pcm, 'en');
    if (result.status !== 'complete') throw new Error('expected a transcript');
    const [hello] = result.transcript.segments[0].words;
    expect(hello.start).toBeGreaterThanOrEqual(2.2); // 1.75 + 0.5, refined only within the word
    expect(hello.start).toBeLessThan(2.65);
  });

  it('English with the same words in every region makes no arbitration call (only the realign pass uses the aligner)', async () => {
    const { engine, transcribe, qwenTranscribe, ctcLogProbs } = setup();
    transcribe.mockImplementation(async () => ({ text: '', chunks: qwenChunks() }) as never);
    qwenTranscribe.mockImplementation(async () => ({ chunks: qwenChunks().map(c => ({ ...c, text: c.text.toUpperCase() })) }));
    const result = await engine.transcribe(pcm, 'en');
    if (result.status !== 'complete') throw new Error('expected a transcript');
    expect(wordsOf(result)).toEqual(['hello', 'world', 'bar']);
    expect(ctcLogProbs).toHaveBeenCalledTimes(result.transcript.segments.length); // one realign call per segment, none for arbitration
  });

  it('English with every region equal gives the transcript whisper alone gives (the same run with language "de"), except language/languages', async () => {
    const english = setup(), german = setup(emit('_bar_'), 'de');
    for (const s of [english, german]) s.transcribe.mockImplementation(async () => ({ text: '', chunks: qwenChunks() }) as never);
    english.qwenTranscribe.mockImplementation(async () => ({ chunks: qwenChunks().map(c => ({ ...c, text: c.text.toUpperCase() + '.' })) }));
    const en = await english.engine.transcribe(pcm, 'en'), de = await german.engine.transcribe(pcm, 'de');
    if (en.status !== 'complete' || de.status !== 'complete') throw new Error('expected a transcript');
    expect(english.qwenTranscribe).toHaveBeenCalledTimes(1);
    expect(german.qwenTranscribe).not.toHaveBeenCalled();
    expect(en.transcript.language).toBe('en'); expect(de.transcript.language).toBe('de');
    const strip = (t: typeof en.transcript) => ({ ...t, language: '', languages: [] as string[] });
    expect(strip(en.transcript)).toEqual(strip(de.transcript));
    expect(english.ctcLogProbs).toHaveBeenCalledTimes(german.ctcLogProbs.mock.calls.length); // only realign calls, none for arbitration
  });

  it('detected English runs both models; detectLanguage comes first and its result is passed to transcribe', async () => {
    const { engine, detectLanguage, transcribe, qwenTranscribe } = setup();
    await engine.transcribe(pcm);
    expect(detectLanguage).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][1]).toBe('en');
    expect(qwenTranscribe).toHaveBeenCalledTimes(1);
    expect(detectLanguage.mock.invocationCallOrder[0]).toBeLessThan(transcribe.mock.invocationCallOrder[0]);
    expect(transcribe.mock.invocationCallOrder[0]).toBeLessThan(qwenTranscribe.mock.invocationCallOrder[0]);
  });

  it('an explicit non-English language calls transcribe only and keeps whisper\'s words untouched', async () => {
    const { engine, detectLanguage, transcribe, qwenTranscribe } = setup();
    const result = await engine.transcribe(pcm, 'de');
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(qwenTranscribe).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][1]).toBe('de');
    expect(wordsOf(result)).toEqual(['hello', 'world', 'foo']);
  });

  it('a detected non-English language is passed to transcribe and never reaches qwenTranscribe', async () => {
    const { engine, detectLanguage, transcribe, qwenTranscribe } = setup(emit('_bar_'), 'fr');
    const result = await engine.transcribe(pcm);
    expect(detectLanguage).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][1]).toBe('fr');
    expect(qwenTranscribe).not.toHaveBeenCalled();
    expect(wordsOf(result)).toEqual(['hello', 'world', 'foo']);
  });

  it('is deterministic: the same input twice gives an identical transcript', async () => {
    const first = await setup().engine.transcribe(pcm, 'en'), second = await setup().engine.transcribe(pcm, 'en');
    expect(first.status).toBe('complete');
    expect(second).toEqual(first);
    const { engine } = setup();
    expect(await engine.transcribe(pcm, 'en')).toEqual(await engine.transcribe(pcm, 'en'));
  });
});

describe('LocalModels: whisper and Qwen3-ASR are never resident together', () => {
  const events = mocks.events;
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 5));
  const originalGenerate: unknown[] = [];
  /** Disposal takes a tick, so a release that is not awaited would let the next load run first. */
  function fakeWhisper() {
    const generate = vi.fn();
    originalGenerate.push(generate);
    const model = Object.assign(vi.fn(async () => ({ logits: { data: Float32Array.from([0, 0, 0, 0, 0, 0, 9, 0]), dims: [1, 1, 8] } })), {
      generate, _extract_token_timestamps: vi.fn(),
      generation_config: { decoder_start_token_id: 1, lang_to_id: { '<|en|>': 5, '<|de|>': 6 } },
    });
    return Object.assign(vi.fn(async () => ({ text: '', chunks: [] })), {
      model, processor: vi.fn(async () => ({})),
      dispose: vi.fn(async () => { await delay(); events.push('whisper:dispose'); }),
    });
  }
  function fakeQwen() {
    return { decode: vi.fn(async () => ({ text: 'hello world' })), dispose: vi.fn(async () => { await delay(); events.push('qwen:dispose'); }) };
  }
  function setup() {
    const models = new LocalModels({ modelRoot: 'x', device: 'cpu' });
    vi.spyOn(models, 'ctcLogProbs').mockResolvedValue(emit('_h_e_l_l_o_|_w_o_r_l_d_'));
    return models;
  }
  const samples = new Float32Array(rate);

  beforeEach(() => {
    events.length = 0;
    originalGenerate.length = 0;
    mocks.pipeline.mockReset().mockImplementation(async () => { events.push('whisper:load'); await delay(); return fakeWhisper(); });
    mocks.loadQwen3Asr.mockReset().mockImplementation(async () => { events.push('qwen:load'); await delay(); return fakeQwen(); });
  });

  it('transcribe, qwenTranscribe, transcribe: whisper is disposed before qwen loads, and qwen before whisper reloads', async () => {
    const models = setup();
    await models.transcribe(samples, 'en');
    expect(events).toEqual(['whisper:load']);
    expect(models.backends.transcription).toBe('cpu');
    const { chunks } = await models.qwenTranscribe(samples, [[0, 1]], 1);
    expect(chunks.map(c => c.text)).toEqual(['hello', 'world']);
    expect(events).toEqual(['whisper:load', 'whisper:dispose', 'qwen:load']);
    expect(models.backends.transcription).toBe('wasm');
    await models.transcribe(samples, 'en');
    expect(events).toEqual(['whisper:load', 'whisper:dispose', 'qwen:load', 'qwen:dispose', 'whisper:load']);
    expect(models.backends.transcription).toBe('cpu');
  });

  it('the whisper loader checks the Transformers.js version and replaces generate on the model it loaded', async () => {
    const models = setup();
    await models.transcribe(samples, 'en');
    expect(mocks.pipeline.mock.calls[0][0]).toBe('automatic-speech-recognition');
    const loaded = await mocks.pipeline.mock.results[0].value;
    expect(loaded.model.generate).not.toBe(originalGenerate[0]);
    expect(typeof loaded.model._extract_token_timestamps).toBe('function');
  });

  it('qwen first: nothing to release, and a second qwenTranscribe reuses the loaded recognizer', async () => {
    const models = setup();
    await models.qwenTranscribe(samples, [[0, 1]], 1);
    await models.qwenTranscribe(samples, [[0, 1]], 1);
    expect(events).toEqual(['qwen:load']);
    expect(mocks.loadQwen3Asr).toHaveBeenCalledTimes(1);
  });

  it('repeated whisper calls load the pipeline once and never touch qwen', async () => {
    const models = setup();
    await models.transcribe(samples, 'en');
    await models.transcribe(samples, 'de');
    expect(events).toEqual(['whisper:load']);
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
    expect(mocks.loadQwen3Asr).not.toHaveBeenCalled();
  });

  it('detectLanguage also releases qwen before whisper loads', async () => {
    const models = setup();
    await models.qwenTranscribe(samples, [[0, 1]], 1);
    expect(await models.detectLanguage(samples)).toBe('de');
    expect(events).toEqual(['qwen:load', 'qwen:dispose', 'whisper:load']);
  });

  it('two English passes alternate whisper and qwen, one resident at a time', async () => {
    const models = setup();
    await models.transcribe(samples, 'en');
    await models.qwenTranscribe(samples, [[0, 1]], 1);
    await models.transcribe(samples, 'en');
    await models.qwenTranscribe(samples, [[0, 1]], 1);
    expect(events).toEqual(['whisper:load', 'whisper:dispose', 'qwen:load', 'qwen:dispose', 'whisper:load', 'whisper:dispose', 'qwen:load']);
  });
});
