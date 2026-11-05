// SPDX-License-Identifier: AGPL-3.0-only
// T19q T5: model-free unit tests for the Qwen3-ASR TypeScript port. No ONNX session is loaded here —
// feature/tokenizer helpers, production windowing and alignment, and engine routing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tensor } from 'onnxruntime-web/webgpu';
import { logMelFeatures, normalizeWhisperFeatures, trimAudioFeatures, featToAudioTokensLen, Qwen3AsrTokenizer } from '../apps/web/src/analysis/qwen-asr';
import { AnalysisEngine } from '../apps/web/src/analysis/engine';
import { CAPABILITY_MODELS, modelAvailability } from '../apps/web/src/analysis/availability';
import { MODEL_IDS } from '../apps/web/src/analysis/model-ids';
import type { Pair } from '../apps/web/src/analysis/types';
import { LocalModels } from '../apps/web/src/analysis/models';
import { makeTranscript } from '../apps/web/src/analysis/transcript';

const N_MELS = 128;

describe('logMelFeatures + normalizeWhisperFeatures: sherpa-onnx NormalizeWhisperFeatures formula', () => {
  /** log = max(x, 1e-10).log10(); max_v = log.max() - 8; log = max(log, max_v); mel = (log + 4) / 4. */
  function refNormalize(features: Float32Array, numFrames: number): Float32Array {
    const out = new Float32Array(numFrames * N_MELS);
    let max = -Infinity;
    for (let i = 0; i < out.length; i++) { const v = Math.log10(Math.max(features[i], 1e-10)); out[i] = v; if (v > max) max = v; }
    const floor = max - 8;
    for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
    return out;
  }

  it('matches a reimplementation of the reference formula to 1e-6', () => {
    const numFrames = 4;
    const raw = Float32Array.from({ length: numFrames * N_MELS }, (_, i) => (i === 10 ? 0 : (i + 1) * 0.0003));
    const got = raw.slice(), expected = refNormalize(raw.slice(), numFrames);
    normalizeWhisperFeatures(got, numFrames);
    for (let i = 0; i < got.length; i++) expect(got[i]).toBeCloseTo(expected[i], 6);
  });

  it('an all-zero 16000-sample input: numFrames in 95..100, every feature equals -1.5', () => {
    const { features, numFrames } = logMelFeatures(new Float32Array(16000));
    expect(numFrames).toBeGreaterThanOrEqual(95);
    expect(numFrames).toBeLessThanOrEqual(100);
    expect(features.length).toBe(numFrames * N_MELS);
    for (let i = 0; i < features.length; i++) expect(features[i]).toBeCloseTo(-1.5, 5);
  });

  it('features.length === numFrames * 128 for an arbitrary input', () => {
    const samples = Float32Array.from({ length: 20000 }, (_, i) => Math.sin((2 * Math.PI * 300 * i) / 16000));
    const { features, numFrames } = logMelFeatures(samples);
    expect(numFrames).toBeGreaterThan(0);
    expect(features.length).toBe(numFrames * N_MELS);
  });

  it('a short input (< 2 samples) returns numFrames 0', () => {
    expect(logMelFeatures(new Float32Array(1)).numFrames).toBe(0);
    expect(logMelFeatures(new Float32Array(0)).numFrames).toBe(0);
  });
});

describe('featToAudioTokensLen: sherpa-onnx impl.cc integer formula', () => {
  function aftercnn(x: number): number {
    for (let i = 0; i < 3; i++) x = Math.floor((x - 1) / 2) + 1;
    return x;
  }
  function ref(featLen: number, chunkSize = 100): number {
    const tn = Math.floor((Math.floor((Math.floor((chunkSize + 1) / 2) + 1) / 2) + 1) / 2);
    const full = Math.floor(featLen / chunkSize), rem = featLen % chunkSize;
    return full * tn + (rem > 0 ? aftercnn(rem) : 0);
  }

  it.each([
    [0, 0],
    [100, 13],
    [50, 7],
    [250, 33],
    [1, 1],
  ])('featToAudioTokensLen(%i) === %i', (featLen, expected) => {
    expect(featToAudioTokensLen(featLen)).toBe(expected);
    expect(ref(featLen)).toBe(expected);
  });

  it('matches the reference reimplementation across a range of lengths', () => {
    for (let len = 0; len <= 400; len += 7) expect(featToAudioTokensLen(len)).toBe(ref(len));
  });
});

describe('trimAudioFeatures: encoder embedding rows', () => {
  it('trims silent trailing rows and preserves the hidden width', async () => {
    const tensor = new Tensor('float32', Float32Array.from([1, 2, 0, 0, 0, 0]), [1, 3, 2]);
    const result = await trimAudioFeatures(tensor);
    expect(result?.dims).toEqual([1, 1, 2]);
    expect(Array.from(result!.data as Float32Array)).toEqual([1, 2]);
  });
  it('returns null for an entirely silent tensor', async () => {
    expect(await trimAudioFeatures(new Tensor('float32', new Float32Array(6), [1, 3, 2]))).toBeNull();
  });
  it('preserves an untrimmed tensor', async () => {
    const tensor = new Tensor('float32', Float32Array.from([0, 0, 1, 0]), [1, 2, 2]);
    expect(await trimAudioFeatures(tensor)).toBe(tensor);
  });
});

describe('Qwen3AsrTokenizer: byte-level BPE round-trip + specials', () => {
  /** GPT-2 byte<->unicode table, same recipe as qwen-asr.ts's byteUnicodeTables(). */
  function byteUnicodeTable(): string[] {
    const base: number[] = [];
    for (let b = 33; b <= 126; b++) base.push(b);
    for (let b = 161; b <= 172; b++) base.push(b);
    for (let b = 174; b <= 255; b++) base.push(b);
    const bytes = base.slice(), codes = base.slice();
    let n = 0;
    for (let b = 0; b < 256; b++) if (!base.includes(b)) { bytes.push(b); codes.push(256 + n); n++; }
    const byteToU = new Array<string>(256);
    for (let i = 0; i < bytes.length; i++) byteToU[bytes[i]] = String.fromCodePoint(codes[i]);
    return byteToU;
  }
  const BASE_SPECIALS: Record<number, string> = {
    151643: '<|endoftext|>', 151644: '<|im_start|>', 151645: '<|im_end|>',
    151646: '<|audio_pad|>', 151647: '<|audio_start|>', 151648: '<|audio_end|>', 151649: '<asr_text>',
  };
  function makeTokenizer(extra: Record<number, string> = {}) {
    const byteToU = byteUnicodeTable();
    const vocab: Record<string, number> = {};
    for (let b = 0; b < 256; b++) vocab[byteToU[b]] = b;
    vocab['he'] = 1000; vocab['llo'] = 1001; // merged filler entries; unreachable since merges.txt is empty
    const addedTokensDecoder: Record<string, { content: string }> = {};
    for (const [id, content] of Object.entries({ ...BASE_SPECIALS, ...extra })) addedTokensDecoder[id] = { content };
    const tokenizer = new Qwen3AsrTokenizer(JSON.stringify(vocab), '', JSON.stringify({ added_tokens_decoder: addedTokensDecoder }));
    return tokenizer;
  }
  const code = (ch: string) => ch.codePointAt(0)!;

  it('encodes a plain word as one byte-id per character', () => {
    const tokenizer = makeTokenizer();
    expect(tokenizer.encode('hello')).toEqual([...'hello'].map(code));
  });
  it('keeps specials whole, longest match first at each position', () => {
    const tokenizer = makeTokenizer();
    expect(tokenizer.encode('<|im_start|>hi<|im_end|>')).toEqual([151644, code('h'), code('i'), 151645]);
  });
  it('round-trips a plain phrase through encode/decode', () => {
    const tokenizer = makeTokenizer();
    expect(tokenizer.decode(tokenizer.encode('hello world'))).toBe('hello world');
  });
  it('decode drops <|im_start|>/<|im_end|> (skippable specials)', () => {
    const tokenizer = makeTokenizer();
    expect(tokenizer.decode([151644, code('h'), code('i'), 151645])).toBe('hi');
  });
  it('decode keeps <asr_text> in place', () => {
    const tokenizer = makeTokenizer();
    expect(tokenizer.decode([151649, code('h'), code('i')])).toBe('<asr_text>hi');
  });
  it('eosId and asrTextId are the configured special ids', () => {
    const tokenizer = makeTokenizer();
    expect(tokenizer.eosId).toBe(151645);
    expect(tokenizer.asrTextId).toBe(151649);
  });
  it('matches the longer special over its own prefix (longest-first)', () => {
    const tokenizer = makeTokenizer({ 160000: '<|a|>', 160001: '<|a|b|>' });
    expect(tokenizer.encode('<|a|b|>')).toEqual([160001]);
  });
});

describe('Qwen production windowing and alignment', () => {
  function setup(text: string) {
    const models = new LocalModels({ modelRoot: 'unused', device: 'cpu' });
    const decode = vi.fn().mockResolvedValue({ text });
    vi.spyOn(models as any, 'qwenRecognizer').mockResolvedValue({ decode });
    vi.spyOn(models, 'ctcLogProbs').mockResolvedValue({
      logProbs: new Float32Array(), frames: 0, classes: 4,
      vocab: new Map([['a', 2], ['b', 3]]), blank: 0, delimiter: 1,
    });
    return { models, decode };
  }

  it('cuts at the latest available VAD gap and covers the whole multi-window input', async () => {
    const { models, decode } = setup('');
    await models.qwenTranscribe(new Float32Array(60 * 16000), [[1, 5], [7, 15], [20, 25], [29, 60]], 60);
    expect(decode.mock.calls.map(([samples]) => samples.length / 16000)).toEqual([27, 30, 3]);
  });

  it('hard splits a continuous voice region at 30 seconds', async () => {
    const { models, decode } = setup('');
    await models.qwenTranscribe(new Float32Array(40 * 16000), [[0, 40]], 40);
    expect(decode.mock.calls.map(([samples]) => samples.length / 16000)).toEqual([30, 10]);
  });

  it('interpolates an unspellable word between real CTC anchors', async () => {
    const { models } = setup('a !!! b');
    const data = new Float32Array(7 * 4).fill(-100);
    [0, 2, 0, 1, 0, 3, 0].forEach((id, frame) => { data[frame * 4 + id] = 0; });
    vi.mocked(models.ctcLogProbs).mockResolvedValue({ logProbs: data, frames: 7, classes: 4, vocab: new Map([['a', 2], ['b', 3]]), blank: 0, delimiter: 1 });
    const { chunks } = await models.qwenTranscribe(new Float32Array(16000), [[0, 1]], 1);
    expect(chunks.map(c => c.text)).toEqual(['a', '!!!', 'b']);
    expect(chunks.map(c => c.timestamp)).toEqual([[0.02, 0.04], [0.04, 0.1], [0.1, 0.12]]);
  });

  it('places a no-path fallback in separated intersecting voiced spans and retains both words', async () => {
    const { models } = setup('hello world');
    const samples = new Float32Array(10 * 16000);
    const voice: Pair[] = [[0, 1], [9, 10]];
    const { chunks } = await models.qwenTranscribe(samples, voice, 10);
    expect(chunks.map(c => c.timestamp)).toEqual([[0, 1], [9, 10]]);
    expect(makeTranscript(chunks, samples, 10, 'en', voice).segments.flatMap(s => s.words.map(w => w.word))).toEqual(['hello', 'world']);
  });

  it('clamps an unequal word crossing a voice gap to the span containing its active-time midpoint', async () => {
    const { models } = setup('a bbb');
    const samples = new Float32Array(10 * 16000);
    const voice: Pair[] = [[0, 1], [9, 10]];
    const { chunks } = await models.qwenTranscribe(samples, voice, 10);
    expect(chunks.map(c => c.timestamp)).toEqual([[0, 0.5], [9, 10]]);
    expect(makeTranscript(chunks, samples, 10, 'en', voice).segments.flatMap(s => s.words.map(w => w.word))).toEqual(['a', 'bbb']);
  });

  it('emits nothing for windows with no voice and keeps the fallback in the voiced ones', async () => {
    const { models, decode } = setup('hello');
    const samples = new Float32Array(105 * 16000);
    const { chunks } = await models.qwenTranscribe(samples, [[0, 5], [100, 105]], 105);
    // Windows: [0,30], [30,52.5] (VAD-gap midpoint), [52.5,82.5], [82.5,105]; only the first and last intersect voice.
    expect(decode).toHaveBeenCalledTimes(4);
    expect(chunks).toEqual([{ text: 'hello', timestamp: [0, 5] }, { text: 'hello', timestamp: [100, 105] }]);
  });

  it('intersects voice with each window and applies nonzero window offsets', async () => {
    const { models } = setup('a');
    const samples = new Float32Array(40 * 16000);
    const voice: Pair[] = [[0, 1], [29, 40]];
    const { chunks } = await models.qwenTranscribe(samples, voice, 40);
    expect(chunks.map(c => c.timestamp)).toEqual([[0, 1], [29, 40]]);
    expect(makeTranscript(chunks, samples, 40, 'en', voice).segments.flatMap(s => s.words.map(w => w.word))).toEqual(['a', 'a']);
  });
});

describe('AnalysisEngine.transcribe routing: English goes through Qwen3-ASR, other languages stay on Whisper', () => {
  const rate = 16000;
  const tone = (seconds: number) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / rate));

  function setup() {
    const engine = new AnalysisEngine({ modelRoot: 'x', device: 'cpu' });
    const classify = vi.spyOn(engine.models, 'classify').mockResolvedValue({ isMusic: true, hasVocals: true, labels: [] } as never);
    const speechRegions = vi.spyOn(engine.models, 'speechRegions');
    const detectLanguage = vi.spyOn(engine.models, 'detectLanguage').mockResolvedValue('en');
    const qwenTranscribe = vi.spyOn(engine.models, 'qwenTranscribe').mockResolvedValue({ chunks: [] });
    const transcribe = vi.spyOn(engine.models, 'transcribe').mockResolvedValue({ text: '', chunks: [] } as never);
    const diarize = vi.spyOn(engine.models, 'diarize').mockResolvedValue(undefined as never);
    // T6 arbitration may score a region; no real aligner may load here (both decodes are empty, so it is never called).
    const ctcLogProbs = vi.spyOn(engine.models, 'ctcLogProbs').mockRejectedValue(new Error('no aligner in this test'));
    return { engine, classify, speechRegions, detectLanguage, qwenTranscribe, transcribe, diarize, ctcLogProbs };
  }

  it('detected English runs transcribe (voiced slice, "en") and qwenTranscribe (voiced slice and voice regions relative to it)', async () => {
    const { engine, speechRegions, detectLanguage, qwenTranscribe, transcribe, ctcLogProbs } = setup();
    const samples = tone(10), pcm = { sampleRate: rate, channels: 1, data: [samples] };
    speechRegions.mockResolvedValue([[2, 3], [5, 6]]);
    const result = await engine.transcribe(pcm);
    expect(result.status).toBe('complete');
    expect(detectLanguage).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][0].length / rate).toBeCloseTo(4.5, 6);
    expect(transcribe.mock.calls[0][1]).toBe('en');
    expect(ctcLogProbs).not.toHaveBeenCalled();
    expect(qwenTranscribe).toHaveBeenCalledTimes(1);
    const [voiced, localVoice, voicedDuration] = qwenTranscribe.mock.calls[0];
    expect(voiced).toBeInstanceOf(Float32Array);
    expect(voiced.length / rate).toBeCloseTo(4.5, 6);
    expect(localVoice).toEqual([[0.25, 1.25], [3.25, 4.25]]);
    expect(voicedDuration).toBeCloseTo(4.5, 6);
  });

  it('an explicit non-English language dispatches to transcribe and never calls detectLanguage or qwenTranscribe', async () => {
    const { engine, speechRegions, detectLanguage, qwenTranscribe, transcribe } = setup();
    const samples = tone(5), pcm = { sampleRate: rate, channels: 1, data: [samples] };
    speechRegions.mockResolvedValue([[1, 2]]);
    const result = await engine.transcribe(pcm, 'de');
    expect(result.status).toBe('complete');
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(qwenTranscribe).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][1]).toBe('de');
  });

  it('no voice at all: neither transcribe nor qwenTranscribe runs, and the transcript has no segments', async () => {
    const { engine, speechRegions, detectLanguage, qwenTranscribe, transcribe } = setup();
    const samples = tone(3), pcm = { sampleRate: rate, channels: 1, data: [samples] };
    speechRegions.mockResolvedValue([]);
    const result = await engine.transcribe(pcm);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('unreachable');
    expect(result.transcript.segments).toEqual([]);
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(qwenTranscribe).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe('availability.ts: qwen3Asr HEAD-probe for conv_frontend.onnx', () => {
  // Default node env has no `location`: give the probe a same-origin root so it can reach the stub fetcher.
  beforeEach(() => { vi.stubGlobal('location', new URL('http://m.test/')); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Answers every non-qwen probe with a valid config.json so transcription hinges on the qwen HEAD. */
  function fetcher(qwen: { ok: boolean; contentType?: string }) {
    const calls: { url: string; method: string }[] = [];
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.endsWith('/conv_frontend.onnx')) {
        const headers = new Headers(qwen.contentType ? { 'content-type': qwen.contentType } : {});
        return new Response(null, { status: qwen.ok ? 200 : 404, headers });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { fetch: f as unknown as typeof fetch, calls };
  }

  it('CAPABILITY_MODELS.transcription lists every transcription key, including qwen3Asr', () => {
    expect(CAPABILITY_MODELS.transcription).toEqual(['sound', 'vad', 'whisper', 'aligner', 'speaker', 'qwen3Asr']);
    expect(MODEL_IDS.qwen3Asr).toBe('csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25');
  });

  it('present (HEAD 200, non-HTML): transcription available, and the probe uses HEAD so the 44 MB file is not downloaded', async () => {
    const { fetch, calls } = fetcher({ ok: true, contentType: 'application/octet-stream' });
    const result = await modelAvailability('/models/', MODEL_IDS, fetch);
    expect(result.transcription).toBe(true);
    const qwenCall = calls.find(c => c.url.endsWith('/conv_frontend.onnx'));
    expect(qwenCall).toBeDefined();
    expect(qwenCall!.method).toBe('HEAD');
    expect(qwenCall!.url).toContain(`${MODEL_IDS.qwen3Asr}/conv_frontend.onnx`);
  });

  it('missing (HEAD 404): transcription unavailable', async () => {
    const { fetch } = fetcher({ ok: false });
    const result = await modelAvailability('/models/', MODEL_IDS, fetch);
    expect(result.transcription).toBe(false);
  });

  it('a static host serving its SPA index page (HEAD 200, text/html) counts as missing', async () => {
    const { fetch } = fetcher({ ok: true, contentType: 'text/html; charset=utf-8' });
    const result = await modelAvailability('/models/', MODEL_IDS, fetch);
    expect(result.transcription).toBe(false);
  });

  it('a thrown fetch (offline, DNS) counts as missing', async () => {
    const offline = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const result = await modelAvailability('/models/', MODEL_IDS, offline);
    expect(result.transcription).toBe(false);
  });
});
