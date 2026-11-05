// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '@huggingface/transformers';
import { InferenceSession, Tensor } from 'onnxruntime-web/webgpu';
import { loadQwen3Asr, Qwen3AsrModel, Qwen3AsrRecognizer } from '../apps/web/src/analysis/qwen-asr';

const specials = Object.fromEntries(Object.entries({
  151643: '<|endoftext|>', 151644: '<|im_start|>', 151645: '<|im_end|>',
  151646: '<|audio_pad|>', 151647: '<|audio_start|>', 151648: '<|audio_end|>', 151649: '<asr_text>',
}).map(([id, content]) => [id, { content }]));
const modelOptions = { convUrl: 'http://test/conv', encoderUrl: 'http://test/encoder', decoderUrl: 'http://test/decoder' };
const byteVocab = (() => {
  const base = [...Array.from({ length: 94 }, (_, i) => i + 33), ...Array.from({ length: 12 }, (_, i) => i + 161), ...Array.from({ length: 82 }, (_, i) => i + 174)];
  let extra = 0;
  return Object.fromEntries(Array.from({ length: 256 }, (_, b) => [String.fromCodePoint(base.includes(b) ? b : 256 + extra++), b]));
})();
const originalFetch = env.fetch;
const originalRoot = env.localModelPath;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); env.fetch = originalFetch; env.localModelPath = originalRoot; });

function fakeSession(id: number, released: number[], badMetadata = false) {
  return {
    inputNames: id % 3 === 1 ? (badMetadata ? [] : ['in']) : id % 3 === 2 ? ['x', 'mask'] : ['ids', 'audio', 'attention', 'pos', 'key', 'value'],
    outputNames: id % 3 === 0 ? ['logits', 'key', 'value'] : ['out'],
    inputMetadata: [{}, {}, {}, {}, { shape: [1, 1024, 1, 1], type: 'float32' }, { type: 'float32' }],
    release: vi.fn(async () => { released.push(id); }),
  };
}

function setupFetch(failure?: 'fetch' | 'parse' | 'validation') {
  vi.stubGlobal('location', new URL('http://test/'));
  env.localModelPath = 'http://test/models/';
  env.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.endsWith('.onnx') || !path.includes('tokenizer/')) return new Response(new Uint8Array([1]));
    if (path.endsWith('vocab.json')) {
      if (failure === 'fetch') return new Response('', { status: 404 });
      return new Response(failure === 'parse' ? '{' : JSON.stringify(byteVocab));
    }
    if (path.endsWith('tokenizer_config.json')) return new Response(JSON.stringify({ added_tokens_decoder: failure === 'validation' ? {} : specials }));
    return new Response('');
  }) as typeof env.fetch;
}

describe('Qwen initialization cleanup', () => {
  it.each(['session', 'metadata'] as const)('releases partial acquisitions after %s failure, and retry succeeds', async failure => {
    setupFetch();
    const released: number[] = [];
    let attempts = 0;
    vi.spyOn(InferenceSession, 'create').mockImplementation(async () => {
      const n = ++attempts;
      if (failure === 'session' && n === 3) throw new Error('decoder failed');
      return fakeSession(n, released, failure === 'metadata' && n === 1) as never;
    });
    await expect(Qwen3AsrModel.create(modelOptions)).rejects.toThrow();
    expect(released.slice().sort()).toEqual(failure === 'session' ? [1, 2] : [1, 2, 3]);
    const old = attempts;
    // New identities restart the three-session shape cycle after a failed third creation.
    attempts = 0;
    vi.mocked(InferenceSession.create).mockImplementation(async () => {
      const id = ++attempts;
      const session = fakeSession(id, [], false);
      session.release = vi.fn(async () => { released.push(old + id); });
      return session as never;
    });
    const retry = await Qwen3AsrModel.create(modelOptions);
    expect(released.length).toBe(failure === 'session' ? 2 : 3);
    await retry.dispose();
    expect(released.length).toBe(failure === 'session' ? 5 : 6);
  });

  it('still releases every session when one release rejects, and surfaces the original creation error', async () => {
    setupFetch();
    const released: number[] = [];
    let attempts = 0;
    vi.spyOn(InferenceSession, 'create').mockImplementation(async () => {
      const n = ++attempts;
      if (n === 3) throw new Error('decoder failed');
      const session = fakeSession(n, released);
      if (n === 1) session.release = vi.fn(async () => { released.push(n); throw new Error('release failed'); });
      return session as never;
    });
    await expect(Qwen3AsrModel.create(modelOptions)).rejects.toThrow('decoder failed');
    expect(released.slice().sort()).toEqual([1, 2]);
  });

  it.each(['fetch', 'parse', 'validation'] as const)('releases the model on tokenizer %s failure and permits retry', async failure => {
    setupFetch(failure);
    const released: number[] = [];
    let calls = 0;
    vi.spyOn(InferenceSession, 'create').mockImplementation(async () => fakeSession(++calls, released) as never);
    await expect(loadQwen3Asr({ modelId: 'fake' })).rejects.toThrow();
    expect(released.slice().sort()).toEqual([1, 2, 3]);
    setupFetch();
    const retry = await loadQwen3Asr({ modelId: 'fake' });
    expect(released).toHaveLength(3);
    await retry.dispose();
    expect(released.slice().sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each([1, 2, 3])('waits for pending session %i and releases it before tokenizer rejection', async pending => {
    setupFetch('fetch');
    const released: number[] = [];
    let finish!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0, settled = false;
    vi.spyOn(InferenceSession, 'create').mockImplementation(async () => {
      const id = ++calls;
      if (id === pending) { entered(); await gate; }
      return fakeSession(id, released) as never;
    });
    const loading = loadQwen3Asr({ modelId: 'fake' }).then(() => { settled = true; }, () => { settled = true; });
    await started;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish();
    await loading;
    expect(released.slice().sort()).toEqual([1, 2, 3]);
    setupFetch();
    const retry = await loadQwen3Asr({ modelId: 'fake' });
    expect(released).toHaveLength(3);
    await retry.dispose();
    expect(released.slice().sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('Qwen recognizer encoder-output trim', () => {
  it.each(['float32', 'float16'] as const)('skips prompt and LLM for silent %s embeddings', async type => {
    const output = type === 'float32' ? new Tensor('float32', new Float32Array(8), [1, 4, 2]) : new Tensor('float16', new Uint16Array(8), [1, 4, 2]);
    const encode = vi.fn(() => [7]);
    let calls = 0;
    const llm = vi.fn(async (ids: BigInt64Array) => {
      const width = 151646, data = new Float32Array(ids.length * width).fill(-100);
      data[(ids.length - 1) * width + (++calls === 1 ? 1 : 151645)] = 1;
      return { logits: { dims: [1, ids.length, width], data, type: 'float32' }, kvDelta: [] };
    });
    const model = { forwardConvFrontend: async () => ({ dims: [1, 4, 2] }), forwardEncoder: async () => output, forwardLLM: llm, maxTotalLen: 1024, createEmptyKVCache: () => [], applyKvDeltaInplace: () => {} };
    const recognizer = new Qwen3AsrRecognizer(model as never, { encode, asrTextId: 3, decode: () => 'hallucinated' } as never);
    encode.mockClear();
    expect(await recognizer.decode(new Float32Array(1600))).toEqual({ text: '' });
    expect(encode).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });

  it.each(['float32', 'float16', 'uint16'] as const)('trims trailing %s rows with hidden width 3 and reduces audio pads', async type => {
    const output = type === 'float32'
      ? new Tensor('float32', Float32Array.from([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]), [1, 4, 3])
      : new Tensor(type, Uint16Array.from([0x3c00, 0, 0, 0, 0x4000, 0, 0, 0, 0, 0, 0, 0]), [1, 4, 3]);
    const encode = vi.fn((text: string) => text === '<|audio_pad|>' ? [42] : [7]);
    let firstIds: bigint[] = [], firstAudio: any, laterAudio: any, calls = 0;
    const model = {
      forwardConvFrontend: async () => ({ dims: [1, 4, 3] }), forwardEncoder: async () => output,
      maxTotalLen: 1024, createEmptyKVCache: () => [], applyKvDeltaInplace: () => {},
      forwardLLM: async (ids: BigInt64Array, audio: unknown) => {
        if (++calls === 1) { firstIds = Array.from(ids); firstAudio = audio; }
        else laterAudio = audio;
        const width = 151646, data = new Float32Array(ids.length * width).fill(-100);
        data[(ids.length - 1) * width + (calls === 1 ? 1 : 151645)] = 1;
        return { logits: { dims: [1, ids.length, width], data, type: 'float32' }, kvDelta: [] };
      },
    };
    const tokenizer = { encode, asrTextId: 3, decode: () => 'ok' };
    const recognizer = new Qwen3AsrRecognizer(model as never, tokenizer as never);
    expect(await recognizer.decode(new Float32Array(3200))).toEqual({ text: 'ok' });
    expect(firstAudio.dims).toEqual([1, 2, 3]);
    expect(firstAudio.type).toBe(type);
    const bits = new Uint16Array(firstAudio.data.buffer, firstAudio.data.byteOffset, firstAudio.data.byteLength / 2);
    expect(type === 'float32' ? Array.from(firstAudio.data as Float32Array) : Array.from(bits)).toEqual(type === 'float32' ? [1, 0, 0, 0, 2, 0] : [0x3c00, 0, 0, 0, 0x4000, 0]);
    expect(laterAudio).toBe(firstAudio);
    expect(firstIds.filter(id => id === 42n)).toHaveLength(2);
  });
});
