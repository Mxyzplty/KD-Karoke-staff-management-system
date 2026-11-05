// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { ctcAlign, spell } from '../apps/web/src/analysis/align';
import { AnalysisEngine } from '../apps/web/src/analysis/engine';
import { LocalModels } from '../apps/web/src/analysis/models';
import { makeTranscript } from '../apps/web/src/analysis/transcript';
import type { Transcript } from '../apps/web/src/analysis/types';

const blank = 0, a = 1, b = 2, delimiter = 3, classes = 4;
const vocab = new Map([['a', a], ['b', b], ['|', delimiter]]);

// One possible path: all other frame/label combinations are impossible.
function emissions(path: number[]) {
  const logProbs = new Float32Array(path.length * classes).fill(-Infinity);
  path.forEach((label, frame) => { logProbs[frame * classes + label] = 0; });
  return { logProbs, frames: path.length, classes, vocab, blank, delimiter };
}

describe('CTC alignment', () => {
  it('spells supported lowercase characters without treating delimiters as letters', () => {
    expect(spell('A!|b?', vocab)).toEqual([a, b]);
    expect(spell('$123', vocab)).toEqual([]);
  });

  it('includes repeated label frames but excludes surrounding blanks', () => {
    const e = emissions([blank, a, a, blank, b, blank]);
    expect(ctcAlign(e.logProbs, e.frames, classes, [[a, b]], blank, delimiter)).toEqual([[1, 5]]);
  });

  it('requires a blank between identical letters', () => {
    const e = emissions([a, blank, a, blank]);
    expect(ctcAlign(e.logProbs, e.frames, classes, [[a, a]], blank, delimiter)).toEqual([[0, 3]]);
    const impossible = emissions([a, a]);
    expect(ctcAlign(impossible.logProbs, impossible.frames, classes, [[a, a]], blank, delimiter)).toBeNull();
  });

  it('requires the delimiter but excludes its frames from adjacent word spans', () => {
    const e = emissions([blank, a, a, delimiter, delimiter, b, blank]);
    expect(ctcAlign(e.logProbs, e.frames, classes, [[a], [b]], blank, delimiter)).toEqual([[1, 3], [5, 6]]);
    const noDelimiter = emissions([a, blank, b]);
    expect(ctcAlign(noDelimiter.logProbs, noDelimiter.frames, classes, [[a], [b]], blank, delimiter)).toBeNull();
    expect(ctcAlign(e.logProbs, e.frames, classes, [], blank, delimiter)).toBeNull();
  });
});

describe('transcription alignment wiring', () => {
  const rate = 16000;
  const samples = Float32Array.from({ length: 2 * rate }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 300 * i / rate));
  const pcm = { sampleRate: rate, channels: 1, data: [samples] };
  const chunks: { text: string; timestamp: [number, number] }[] = [
    { text: ' A', timestamp: [0.5, 0.6] },
    { text: ' $', timestamp: [0.7, 0.8] },
    { text: ' b', timestamp: [0.9, 1] },
  ];

  function setup(path: number[]) {
    const engine = new AnalysisEngine({ modelRoot: 'x', device: 'cpu' });
    vi.spyOn(engine.models, 'classify').mockResolvedValue({ isMusic: false, hasVocals: true, labels: [] } as never);
    vi.spyOn(engine.models, 'speechRegions').mockResolvedValue([[0, 2]]);
    vi.spyOn(engine.models, 'transcribe').mockResolvedValue({ text: ' A $ b', chunks } as never);
    const ctc = vi.spyOn(engine.models, 'ctcLogProbs').mockResolvedValue(emissions(path));
    let seen: Transcript | undefined;
    const diarize = vi.spyOn(engine.models, 'diarize').mockImplementation(async (_audio, transcript) => { seen = structuredClone(transcript); });
    return { engine, ctc, diarize, observed: () => seen };
  }

  it('retimes spellable words and segment bounds before diarization, preserving text and unspellable ASR times', async () => {
    const path = Array<number>(60).fill(blank);
    path[10] = a; path[20] = delimiter; path[50] = b;
    const { engine, ctc, diarize, observed } = setup(path);
    const result = await engine.transcribe(pcm, 'en');
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('expected transcript');
    expect(ctc).toHaveBeenCalledOnce();
    expect(diarize).toHaveBeenCalledOnce();
    expect(result.transcript.segments).toHaveLength(1);
    const segment = result.transcript.segments[0];
    expect(segment.text).toBe('A $ b');
    expect(segment.words).toEqual([
      { word: 'A', start: 0.2, end: 0.22 },
      { word: '$', start: 0.7, end: 0.8 },
      { word: 'b', start: 1, end: 1.02 },
    ]);
    expect([segment.start, segment.end]).toEqual([0.2, 1.02]);
    for (const n of [segment.start, segment.end, ...segment.words.flatMap(w => [w.start, w.end])]) expect(Math.abs(n * 50 - Math.round(n * 50))).toBeLessThan(1e-9);
    expect(observed()).toEqual(result.transcript);
  });

  it('retains the original segment when no alignment path exists', async () => {
    const { engine, diarize, observed } = setup([a]);
    const original = makeTranscript(chunks, samples, 2, 'en', [[0, 2]]);
    const result = await engine.transcribe(pcm, 'en');
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('expected transcript');
    expect(result.transcript).toEqual(original);
    expect(diarize).toHaveBeenCalledOnce();
    expect(observed()).toEqual(original);
  });
});

describe('aligner lifecycle', () => {
  it('disposes the loaded aligner and clears its cached promise', async () => {
    const models = new LocalModels({ modelRoot: 'x', device: 'cpu' });
    const dispose = vi.fn().mockResolvedValue(undefined);
    const cache = models as unknown as { aligner?: Promise<{ model: { dispose: typeof dispose }; vocab: Map<string, number>; blank: number; delimiter: number }> };
    cache.aligner = Promise.resolve({ model: { dispose }, vocab, blank, delimiter });
    await models.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(cache.aligner).toBeUndefined();
    await models.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
