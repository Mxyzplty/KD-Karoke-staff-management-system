// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { detectBeats } from '../apps/web/src/analysis/beats';
import { makeTranscript } from '../apps/web/src/analysis/transcript';
import { snapCuts } from '../apps/web/src/analysis/helpers';
import { FootageIndex } from '../apps/web/src/analysis/search';
import { speakerAgreement, timingScore, MIN_SPEAKER_CUES } from '../apps/web/src/analysis/tools/metrics';
import { AnalysisError, grid, type Rhythm, type Transcript, type SearchRequest, type AssetInput } from '../apps/web/src/analysis/types';
import { MEDIA_CODES } from '../apps/web/src/media/codes';

vi.mock('@huggingface/transformers', async orig => ({
  ...(await orig<object>()),
  pipeline: vi.fn(),
  AutoModelForAudioFrameClassification: { from_pretrained: vi.fn() },
  AutoProcessor: { from_pretrained: vi.fn() },
}));

/** Deterministic LCG, matching tests/t19a-analysis.test.ts's pattern. */
function seededRandom(seed: number) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
}

describe('beats.ts M3: long inputs must never crash on an uncoded error', () => {
  it('900s of 120 BPM kicks and eighth-note hats reaches the dense tracker without spread overflow', () => {
    const rate = 16000, seconds = 900, bpm = 120, interval = 60 / bpm;
    const samples = new Float32Array(rate * seconds);
    const kickLen = Math.round(0.08 * rate), kickTau = 0.015 * rate;
    for (let t = 0; t < seconds; t += interval) {
      const at = Math.round(t * rate);
      for (let j = 0; j < kickLen && at + j < samples.length; j++) samples[at + j] += 0.8 * Math.sin(2 * Math.PI * 60 * j / rate) * Math.exp(-j / kickTau);
    }
    const rnd = seededRandom(7), hatLen = Math.round(0.015 * rate), hatTau = 0.004 * rate;
    for (let t = 0; t < seconds; t += interval / 2) {
      const at = Math.round((t + (rnd() - 0.5) * 0.01) * rate);
      for (let j = 0; j < hatLen && at + j >= 0 && at + j < samples.length; j++) samples[at + j] += 0.3 * (rnd() * 2 - 1) * Math.exp(-j / hatTau);
    }
    const pcm = { sampleRate: rate, channels: 1, data: [samples] };
    const result = detectBeats(pcm, 'audio', true);
    const intervals = result.tab.onsets.slice(1).map(([t], i) => t - result.tab.onsets[i][0]).sort((a, b) => a - b);
    expect(intervals.length).toBeGreaterThan(3);
    expect(intervals[Math.floor(intervals.length / 2)]).toBeLessThan(0.28);
    expect(result.stored.bpm).not.toBeNull();
    expect(Number.isFinite(result.stored.bpm!)).toBe(true);
    expect(Math.abs(result.stored.bpm! - bpm) / bpm).toBeLessThan(0.05);
    expect(result.stored.beats.every(([t]) => t >= 0 && t < seconds)).toBe(true);
  }, 180_000);

  it('900s of near-silence either returns cleanly or throws a coded AnalysisError, never a bare RangeError', () => {
    const rate = 16000, seconds = 900, rnd = seededRandom(3);
    const samples = new Float32Array(rate * seconds);
    for (let i = 0; i < samples.length; i++) samples[i] = (rnd() - 0.5) * 1e-5;
    const pcm = { sampleRate: rate, channels: 1, data: [samples] };
    try {
      const result = detectBeats(pcm, 'audio', true);
      expect(result.stored.beats.every(([t]) => t >= 0 && t < seconds)).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisError);
      expect(typeof (error as AnalysisError).code).toBe('string');
    }
  }, 180_000);
});

describe('transcript.ts: word end/start refinement (review m1)', () => {
  function loudBlock(duration: number, loudFrom: number, loudTo: number) {
    const rate = 16000, samples = new Float32Array(Math.round(rate * duration));
    for (let i = Math.round(loudFrom * rate); i < Math.round(loudTo * rate); i++) samples[i] = 0.5 * Math.sin(2 * Math.PI * 300 * i / rate);
    return samples;
  }

  it('trims a chunk to the voiced onset and offset inside it (no voice spans)', () => {
    const samples = loudBlock(2.5, 1.2, 1.5);
    const result = makeTranscript([{ text: 'word', timestamp: [1.0, 2.0] }], samples, 2.5, 'en');
    expect(result.segments).toHaveLength(1);
    const [word] = result.segments[0].words;
    expect(word.start).toBeCloseTo(1.2, 2);
    expect(word.end).toBeCloseTo(1.5, 2);
    for (const n of [word.start, word.end]) expect(Math.abs(n * 50 - Math.round(n * 50))).toBeLessThan(1e-9);
  });

  it('clamps the end to the voice span when one is given', () => {
    const samples = loudBlock(2.5, 1.2, 1.5);
    const result = makeTranscript([{ text: 'word', timestamp: [1.0, 2.0] }], samples, 2.5, 'en', [[1.2, 1.5]]);
    const [word] = result.segments[0].words;
    expect(word.start).toBeCloseTo(1.2, 2);
    expect(word.end).toBeCloseTo(1.5, 2);
  });

  it('total_duration is one grid step past duration and always lands on the 20ms grid', () => {
    for (const duration of [45, 30.013, 0, 12.345]) {
      const result = makeTranscript([], new Float32Array(16000), duration, 'en');
      expect(result.total_duration).toBeCloseTo(grid(duration + 0.02), 9);
      expect(Math.abs(Math.round(result.total_duration * 50) - result.total_duration * 50)).toBeLessThan(1e-9);
    }
  });
});

describe('helpers.ts: snapCuts collisions', () => {
  const rhythm: Rhythm = { bpm: 120, averageBpm: 120, beats: [[1, 1], [2, 1]], downbeats: [[1, 1]], silences: [] };

  it('only the nearer of two cuts snapping to the same beat moves', () => {
    expect(snapCuts([0.875, 1.0625], rhythm, 0.2)).toEqual([{ index: 1, from: 1.0625, to: 1, delta: -0.0625 }]);
  });

  it('on a tie, the earlier cut moves', () => {
    expect(snapCuts([0.9375, 1.0625], rhythm, 0.2)).toEqual([{ index: 0, from: 0.9375, to: 1, delta: 0.0625 }]);
  });

  it('cuts snapping to distinct beats both move', () => {
    expect(snapCuts([0.875, 2.125], rhythm, 0.2)).toEqual([{ index: 0, from: 0.875, to: 1, delta: 0.125 }, { index: 1, from: 2.125, to: 2, delta: -0.125 }]);
  });
});

describe('search.ts: request validation and batched span embedding', () => {
  function asset(id: string): AssetInput { return { id, filename: `${id}.mp4`, type: 'video', duration: 2 }; }
  function transcriptWithSpan(matching: boolean): Transcript {
    return { language: 'en', languages: ['en'], total_duration: 2, segments: [
      { id: 0, start: 0, end: 1.5, text: 'hello world today', speaker: 0, words: [{ word: 'hello', start: 0, end: 0.5 }, { word: 'world', start: 0.5, end: 1 }, { word: 'today', start: 1, end: 1.5 }] },
      ...(matching ? [] : []),
    ] };
  }

  it('rejects threshold "constructor" and "toString" with INVALID_SEARCH_REQUEST (no Object.prototype fallthrough)', async () => {
    const index = new FootageIndex(async () => { throw new Error('embed must not be called'); });
    const base: Omit<SearchRequest, 'options'> = { query: 'x', mode: 'general' };
    for (const threshold of ['constructor', 'toString']) {
      await expect(index.search({ ...base, options: { threshold: threshold as SearchRequest['options']['threshold'], limit: 5 } }))
        .rejects.toMatchObject({ code: 'INVALID_SEARCH_REQUEST' });
    }
  });

  it('embeds the query once and all matched spans in exactly one further batch call', async () => {
    const calls: string[][] = [];
    const embed = vi.fn(async (texts: string[]) => { calls.push(texts); return texts.map(() => [1, 0]); });
    const index = new FootageIndex(embed);
    await index.add(asset('a1'), null, transcriptWithSpan(true));
    await index.add(asset('a2'), null, transcriptWithSpan(true));
    const before = calls.length;
    await index.search({ query: 'hello world', mode: 'general', options: { threshold: 'low', limit: 10 } });
    const searchCalls = calls.slice(before);
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[0]).toEqual(['hello world']);
    expect(searchCalls[1]).toHaveLength(2);
  });

  it('a wrong row count from the batched span embed call raises EMBEDDING_FAILED', async () => {
    function transcriptTwoSegments(): Transcript {
      return { language: 'en', languages: ['en'], total_duration: 3, segments: [
        { id: 0, start: 0, end: 1.5, text: 'hello world today', speaker: 0, words: [{ word: 'hello', start: 0, end: 0.5 }, { word: 'world', start: 0.5, end: 1 }, { word: 'today', start: 1, end: 1.5 }] },
        { id: 1, start: 1.5, end: 3, text: 'extra words here', speaker: 0, words: [{ word: 'extra', start: 1.5, end: 2 }, { word: 'words', start: 2, end: 2.5 }, { word: 'here', start: 2.5, end: 3 }] },
      ] };
    }
    // add() pushes 3 chunks per asset (filename tag + one description per segment), so its own embed
    // calls never collide with the 2-text span batch this test corrupts below.
    const embed = vi.fn(async (texts: string[]) => texts.length === 2 ? [[1, 0]] : texts.map(() => [1, 0]));
    const index = new FootageIndex(embed);
    await index.add(asset('a1'), null, transcriptTwoSegments());
    await index.add(asset('a2'), null, transcriptTwoSegments());
    await expect(index.search({ query: 'hello world', mode: 'general', options: { threshold: 'low', limit: 10 } }))
      .rejects.toMatchObject({ code: 'EMBEDDING_FAILED', message: MEDIA_CODES.EMBEDDING_FAILED.message });
  });
});

describe('tools/metrics.ts: speakerAgreement and timingScore', () => {
  it('evidenced is false below MIN_SPEAKER_CUES and true at or above it', () => {
    const reference = [{ startMs: 0, endMs: 20000, speaker: 'A', scorable: true }];
    const transcript: Transcript = { language: 'en', languages: ['en'], total_duration: 20, segments: [{ id: 0, start: 0, end: 20, text: 'x', speaker: 0, words: [] }] };
    const cues = (n: number) => Array.from({ length: n }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 500 }));
    expect(MIN_SPEAKER_CUES).toBe(10);
    expect(speakerAgreement(reference, transcript, cues(MIN_SPEAKER_CUES - 1)).evidenced).toBe(false);
    expect(speakerAgreement(reference, transcript, cues(MIN_SPEAKER_CUES)).evidenced).toBe(true);
  });

  it('splitting one true speaker across two predicted labels lowers agreement below 1 while purity stays 1', () => {
    const reference = [{ startMs: 0, endMs: 1000, speaker: 'A', scorable: true }, { startMs: 2000, endMs: 3000, speaker: 'A', scorable: true }];
    const transcript: Transcript = { language: 'en', languages: ['en'], total_duration: 3, segments: [
      { id: 0, start: 0, end: 1, text: 'x', speaker: 0, words: [] },
      { id: 1, start: 2, end: 3, text: 'y', speaker: 1, words: [] },
    ] };
    const result = speakerAgreement(reference, transcript, []);
    expect(result.agreement).toBeLessThan(1);
    expect(result.purity).toBe(1);
  });

  it('timingScore reports start/end {medianMs,p95Ms} separately and the top-level stat is the per-word worse boundary', () => {
    const reference = [{ text: 'alpha', startMs: 1000, endMs: 1500, timingScorable: true }, { text: 'beta', startMs: 2000, endMs: 2500, timingScorable: true }];
    // alpha: start off by 20ms, end off by 50ms (end is worse). beta: start off by 100ms, end off by 10ms (start is worse).
    const transcript: Transcript = { language: 'en', languages: ['en'], total_duration: 3, segments: [
      { id: 0, start: 0, end: 3, text: 'alpha beta', speaker: 0, words: [{ word: 'alpha', start: 0.98, end: 1.55 }, { word: 'beta', start: 2.1, end: 2.49 }] },
    ] };
    const result = timingScore(reference, transcript);
    expect(result.timedCorrectWords).toBe(2);
    expect(result.scorableWords).toBe(2);
    expect(result.start.medianMs).toBeCloseTo(60, 5);
    expect(result.start.p95Ms).toBeCloseTo(100, 5);
    expect(result.end.medianMs).toBeCloseTo(30, 5);
    expect(result.end.p95Ms).toBeCloseTo(50, 5);
    // Per-word worse boundary: [max(20,50), max(100,10)] = [50, 100] -- not simply max of the two sides' own medians (60/30).
    expect(result.medianMs).toBeCloseTo(75, 5);
    expect(result.p95Ms).toBeCloseTo(100, 5);
  });
});

describe('engine.ts: language plumbing (review m7)', () => {
  async function mockedEngine() {
    const { AnalysisEngine } = await import('../apps/web/src/analysis/engine');
    const engine = new AnalysisEngine({ modelRoot: 'x', device: 'cpu' });
    vi.spyOn(engine.models, 'classify').mockResolvedValue({ isMusic: false, hasVocals: true, labels: [] } as never);
    vi.spyOn(engine.models, 'speechRegions').mockResolvedValue([[0.5, 1.5]]);
    const detectLanguage = vi.spyOn(engine.models, 'detectLanguage').mockResolvedValue('fr');
    const transcribe = vi.spyOn(engine.models, 'transcribe').mockResolvedValue({ text: ' mot', chunks: [{ text: ' mot', timestamp: [0.25, 1.25] }] } as never);
    vi.spyOn(engine.models, 'ctcLogProbs').mockResolvedValue({ logProbs: new Float32Array(), frames: 0, classes: 2, vocab: new Map(), blank: 0, delimiter: 1 });
    vi.spyOn(engine.models, 'diarize').mockResolvedValue(undefined as never);
    return { engine, detectLanguage, transcribe };
  }
  const rate = 16000, samples = new Float32Array(rate * 2);
  for (let i = Math.round(0.5 * rate); i < Math.round(1.5 * rate); i++) samples[i] = 0.5 * Math.sin(2 * Math.PI * 300 * i / rate);
  const pcm = { sampleRate: rate, channels: 1, data: [samples] };

  it('a requested language passes through and detection is not called', async () => {
    const { engine, detectLanguage, transcribe } = await mockedEngine();
    const result = await engine.transcribe(pcm, 'de');
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Float32Array), 'de');
    expect(result.status === 'complete' && result.transcript.language).toBe('de');
  });

  for (const requested of [undefined, null, '']) it(`a ${JSON.stringify(requested) ?? 'missing'} language runs detection and the transcript carries the detected code`, async () => {
    const { engine, detectLanguage, transcribe } = await mockedEngine();
    const result = await engine.transcribe(pcm, requested as string | undefined);
    expect(detectLanguage).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(expect.any(Float32Array), 'fr');
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.transcript.language).toBe('fr');
    expect(result.transcript.languages).toEqual(['fr']);
    expect(result.transcript.segments[0]?.words[0]?.word).toBe('mot');
  });
});

describe('models.ts: retry and VAD window seams', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('m4: a rejected model load is not cached, so the next call retries it', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    const extractor = async (texts: string[]) => ({ tolist: () => texts.map(() => [1, 0]) });
    (pipeline as unknown as Mock).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(extractor);
    const { LocalModels } = await import('../apps/web/src/analysis/models');
    const models = new LocalModels({ modelRoot: 'x', device: 'cpu' });
    await expect(models.embed(['a'])).rejects.toThrow('boom');
    await expect(models.embed(['a'])).resolves.toEqual([[1, 0]]);
  });

  it('m6: a voice span cut by a window edge is recovered once windows overlap', async () => {
    const { AutoModelForAudioFrameClassification, AutoProcessor } = await import('@huggingface/transformers');
    const processor = Object.assign(async (audio: Float32Array) => ({ audio }), {
      post_process_speaker_diarization(logits: Float32Array, _length: number) {
        const spans: { id: number; start: number; end: number; confidence: number }[] = [];
        let start = -1;
        for (let i = 0; i <= logits.length; i++) {
          const nonzero = i < logits.length && logits[i] !== 0;
          if (nonzero && start < 0) start = i;
          if (!nonzero && start >= 0) { spans.push({ id: 1, start: start / 16000, end: i / 16000, confidence: 1 }); start = -1; }
        }
        return [spans];
      },
    });
    const model = async ({ audio }: { audio: Float32Array }) => ({ logits: audio });
    (AutoModelForAudioFrameClassification.from_pretrained as unknown as Mock).mockResolvedValue(model);
    (AutoProcessor.from_pretrained as unknown as Mock).mockResolvedValue(processor);
    const { LocalModels } = await import('../apps/web/src/analysis/models');

    const edgeCase = new LocalModels({ modelRoot: 'x', device: 'cpu' });
    const edgeSamples = new Float32Array(16000 * 20);
    for (let i = Math.round(9.9 * 16000); i < Math.round(10.1 * 16000); i++) edgeSamples[i] = 1;
    const edgeRegions = await edgeCase.speechRegions(edgeSamples);
    expect(edgeRegions).toHaveLength(1);
    expect(edgeRegions[0][0]).toBeCloseTo(9.9, 2);
    expect(edgeRegions[0][1]).toBeCloseTo(10.1, 2);

    const mergeCase = new LocalModels({ modelRoot: 'x', device: 'cpu' });
    const mergeSamples = new Float32Array(16000 * 20);
    for (let i = Math.round(9.5 * 16000); i < Math.round(10.5 * 16000); i++) mergeSamples[i] = 1;
    const mergeRegions = await mergeCase.speechRegions(mergeSamples);
    expect(mergeRegions).toHaveLength(1);
    expect(mergeRegions[0][0]).toBeCloseTo(9.5, 2);
    expect(mergeRegions[0][1]).toBeCloseTo(10.5, 2);
  });
});
