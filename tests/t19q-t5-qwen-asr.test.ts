// SPDX-License-Identifier: AGPL-3.0-only
// T19q T5: model-free unit tests for the Qwen3-ASR TypeScript port. No ONNX session is loaded here —
// only the pure feature/tokenizer helpers (qwen-asr.ts) and ports of models.ts's private window/anchor
// helpers, plus engine.ts routing with LocalModels mocked out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logMelFeatures, normalizeWhisperFeatures, trimAudioFeatures, featToAudioTokensLen, Qwen3AsrTokenizer } from '../apps/web/src/analysis/qwen-asr';
import { AnalysisEngine } from '../apps/web/src/analysis/engine';
import { CAPABILITY_MODELS, modelAvailability } from '../apps/web/src/analysis/availability';
import { MODEL_IDS } from '../apps/web/src/analysis/model-ids';
import type { Pair } from '../apps/web/src/analysis/types';

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

describe('trimAudioFeatures: last-frame-first scan', () => {
  const frame = (dim: number, value: number) => Array.from({ length: dim }, () => value);
  function build(values: number[]): Float32Array {
    const out = new Float32Array(values.length * N_MELS);
    values.forEach((v, i) => out.set(frame(N_MELS, v), i * N_MELS));
    return out;
  }

  it('returns the count of leading voiced frames, scanning from the end', () => {
    expect(trimAudioFeatures(build([0.1, 0.2, 0.3, 1e-7, 1e-8]), 5)).toBe(3);
  });
  it('returns 0 when every frame is silent', () => {
    expect(trimAudioFeatures(build([1e-7, 1e-8, 0]), 3)).toBe(0);
  });
  it('returns numFrames when every frame is voiced', () => {
    expect(trimAudioFeatures(build([0.1, 0.2, 0.3]), 3)).toBe(3);
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

describe('qwenWindows (ported): <=30s windows cut at the latest VAD-gap midpoint', () => {
  /** Verbatim port of LocalModels#qwenWindows (models.ts), private and untestable directly. */
  function qwenWindows(voice: Pair[], duration: number): Pair[] {
    const CAP = 30, MIN_IN = 1;
    const windows: Pair[] = [];
    let cursor = 0;
    while (cursor < duration - 1e-6) {
      const hard = Math.min(duration, cursor + CAP);
      if (hard - cursor < CAP - 1e-6) { windows.push([cursor, hard]); break; }
      let latest = -1;
      for (let i = 0; i + 1 < voice.length; i++) {
        const ge = voice[i][1], gs = voice[i + 1][0];
        if (gs <= ge) continue;
        const mid = (ge + gs) / 2;
        if (mid > cursor + MIN_IN && mid <= hard && mid > latest) latest = mid;
      }
      const cut = latest > 0 ? latest : hard;
      windows.push([cursor, cut]);
      cursor = cut;
    }
    return windows;
  }

  it('no voice at all: one window covering [0, duration]', () => {
    expect(qwenWindows([], 10)).toEqual([[0, 10]]);
  });
  it('cuts at the gap midpoint when one falls in [cursor+1, cursor+30]', () => {
    expect(qwenWindows([[5, 20], [25, 55]], 60)).toEqual([[0, 22.5], [22.5, 52.5], [52.5, 60]]);
  });
  it('a single voice span wider than 30s is hard-cut at 30s', () => {
    expect(qwenWindows([[0, 40]], 40)).toEqual([[0, 30], [30, 40]]);
  });
  it('every window is at most 30s and the windows cover [0, duration] in order with no gaps', () => {
    const windows = qwenWindows([[5, 20], [25, 55]], 60);
    expect(windows[0][0]).toBe(0);
    expect(windows.at(-1)![1]).toBe(60);
    windows.forEach(([s, e], i) => {
      expect(e - s).toBeLessThanOrEqual(30 + 1e-6);
      if (i) expect(s).toBe(windows[i - 1][1]);
    });
  });
});

describe('char-count anchor fill (ported): interpolates unaligned words between neighbours', () => {
  /** Verbatim port of the anchor-fill block inside LocalModels#qwenTranscribe (models.ts). */
  function fillAnchors(words: string[], initial: (Pair | null)[], winStart: number, winEnd: number): Pair[] {
    const winDur = winEnd - winStart;
    const anchors = initial.slice();
    const lens = words.map(w => Math.max(1, w.length));
    let allNull = true;
    for (const a of anchors) if (a !== null) { allNull = false; break; }
    if (allNull) {
      const total = lens.reduce((a, b) => a + b, 0);
      let cur = 0;
      for (let k = 0; k < words.length; k++) {
        const sf = cur / total; cur += lens[k]; const ef = cur / total;
        anchors[k] = [sf * winDur, ef * winDur];
      }
    } else {
      let i = 0;
      while (i < words.length) {
        if (anchors[i]) { i++; continue; }
        let j = i;
        while (j < words.length && !anchors[j]) j++;
        const left = i === 0 ? 0 : anchors[i - 1]![1];
        const right = j === words.length ? winDur : anchors[j]![0];
        const total = Math.max(1, lens.slice(i, j).reduce((a, b) => a + b, 0));
        let cur = 0;
        for (let k = i; k < j; k++) {
          const sf = cur / total; cur += lens[k]; const ef = cur / total;
          anchors[k] = [left + sf * (right - left), left + ef * (right - left)];
        }
        i = j;
      }
    }
    return anchors as Pair[];
  }

  it('whole-window fallback: char-length spread over [0, winDur] when every anchor is null', () => {
    expect(fillAnchors(['a', 'bb', 'ccc'], [null, null, null], 0, 6)).toEqual([[0, 1], [1, 3], [3, 6]]);
  });
  it('fills a single unaligned word in the gap between two anchored neighbours', () => {
    expect(fillAnchors(['aa', 'bb', 'cc'], [[0, 1], null, [5, 6]], 0, 6)).toEqual([[0, 1], [1, 5], [5, 6]]);
  });
  it('kept anchors pass through unchanged', () => {
    const anchors: (Pair | null)[] = [[0, 1], [1, 2], [2, 3]];
    expect(fillAnchors(['a', 'b', 'c'], anchors, 0, 3)).toEqual([[0, 1], [1, 2], [2, 3]]);
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
