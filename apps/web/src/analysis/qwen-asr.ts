// SPDX-License-Identifier: AGPL-3.0-only AND Apache-2.0
/*! @license TypeScript port of https://github.com/k2-fsa/sherpa-onnx
 * @ 4161dacf2a9a86e3c4dd773b106c557b0a63cc1a:
 * sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.cc,
 * sherpa-onnx/csrc/offline-qwen3-asr-model.cc and sherpa-onnx/csrc/qwen-asr-tokenizer.cc.
 * Copyright (c)  2026 zengyw
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations
 * under the License. This file has been changed from the original C++ sources for TypeScript,
 * browser/Node ONNX sessions and the registered greedy English decoding path.
 */
/**
 * Qwen3-ASR-0.6B TypeScript port of sherpa-onnx's offline-recognizer-qwen3-asr-impl.cc,
 * offline-qwen3-asr-model.cc and qwen-asr-tokenizer.cc @ sherpa-onnx 4161dacf (Apache-2.0).
 * Log-mel features (center-pad 80, hann-400 frames every 160 samples, 400-point DFT,
 * 128 librosa-slaney mel bins over 0..8000 Hz, NormalizeWhisperFeatures) → conv frontend →
 * audio encoder → Qwen3 LLM decoder with KV cache (greedy, max_total_len min(1024, graph));
 * byte-level BPE tokenizer (GPT-2 byte↔unicode, Qwen3 pre-tokenization, longest-first
 * specials). ONNX via onnxruntime-web/webgpu wasm EP (numThreads 1, proxy false); node:fs
 * byte reads in Node, env.fetch in a browser.
 */
import { env } from '@huggingface/transformers';
import { AnalysisError } from './types';

type OrtNS = typeof import('onnxruntime-web/webgpu');
type OrtTensor = import('onnxruntime-web/webgpu').Tensor;
type OrtSession = import('onnxruntime-web/webgpu').InferenceSession;
type OrtTensorDataType = 'float32' | 'float16' | 'uint16' | 'int64' | 'bool';

const SAMPLE_RATE = 16000, FFT_SIZE = 400, FRAME_LEN = 400, FRAME_SHIFT = 160, WHISPER_PAD = 80;
const N_MELS = 128, HALF_FFT = FFT_SIZE / 2 + 1;
const CHUNK_SIZE = 100;
const EOS_IM_END = 151645, EOS_ENDOFTEXT = 151643;
const LOOP_WINDOW = 64, LOOP_MAX_DISTINCT = 3;
const MAX_TOTAL_LEN_CAP = 1024;

let ortModule: OrtNS | undefined;
async function ort(wasm?: { mjs: string; wasm: string }): Promise<OrtNS> {
  if (ortModule) return ortModule;
  const o = await import('onnxruntime-web/webgpu');
  o.env.wasm.numThreads = 1;
  o.env.wasm.proxy = false;
  if (wasm) o.env.wasm.wasmPaths = wasm;
  ortModule = o;
  return o;
}

/** Node byte read vs browser same-origin fetch; mirrors models.ts modelText(). */
async function readBytes(url: string): Promise<Uint8Array> {
  if (typeof location === 'undefined') {
    const fs = (globalThis as unknown as { process: { getBuiltinModule(name: 'node:fs'): { readFileSync(path: string): Buffer } } }).process.getBuiltinModule('node:fs');
    const buffer = fs.readFileSync(url);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  const response = await env.fetch(url);
  if (!response.ok) throw new AnalysisError('TRANSCRIPTION_FAILED', `The local Qwen3-ASR file ${url} is missing.`);
  return new Uint8Array(await response.arrayBuffer());
}
async function readText(url: string): Promise<string> {
  if (typeof location === 'undefined') {
    const fs = (globalThis as unknown as { process: { getBuiltinModule(name: 'node:fs'): { readFileSync(path: string, encoding: 'utf8'): string } } }).process.getBuiltinModule('node:fs');
    return fs.readFileSync(url, 'utf8');
  }
  const response = await env.fetch(url);
  if (!response.ok) throw new AnalysisError('TRANSCRIPTION_FAILED', `The local Qwen3-ASR file ${url} is missing.`);
  return response.text();
}

/* ---------- Feature extraction (log-mel) ---------- */

/** Librosa slaney mel scale with slaney triangular bins normalized by 2/(hz_u - hz_l). */
function hzToMelSlaney(hz: number): number {
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27;
  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logstep;
}
function melToHzSlaney(mel: number): number {
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27;
  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp((mel - minLogMel) * logstep);
}
let MEL_FB: Float32Array | undefined;
function melFilterbank(): Float32Array {
  if (MEL_FB) return MEL_FB;
  const fMin = 0, fMax = 8000;
  const melEdges = new Float64Array(N_MELS + 2);
  const mMin = hzToMelSlaney(fMin), mMax = hzToMelSlaney(fMax);
  for (let i = 0; i < N_MELS + 2; i++) melEdges[i] = mMin + (i * (mMax - mMin)) / (N_MELS + 1);
  const hzEdges = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) hzEdges[i] = melToHzSlaney(melEdges[i]);
  const fftFreqs = new Float64Array(HALF_FFT);
  for (let k = 0; k < HALF_FFT; k++) fftFreqs[k] = (k * SAMPLE_RATE) / FFT_SIZE;
  const fb = new Float32Array(N_MELS * HALF_FFT);
  for (let m = 0; m < N_MELS; m++) {
    const lo = hzEdges[m], ce = hzEdges[m + 1], hi = hzEdges[m + 2];
    const norm = 2 / (hi - lo);
    for (let k = 0; k < HALF_FFT; k++) {
      const f = fftFreqs[k];
      let v = 0;
      if (f >= lo && f <= ce) v = (f - lo) / (ce - lo);
      else if (f > ce && f <= hi) v = (hi - f) / (hi - ce);
      if (v > 0) fb[m * HALF_FFT + k] = v * norm;
    }
  }
  MEL_FB = fb;
  return fb;
}
let HANN: Float32Array | undefined;
function hannWindow(): Float32Array {
  if (HANN) return HANN;
  const w = new Float32Array(FRAME_LEN);
  for (let i = 0; i < FRAME_LEN; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1));
  HANN = w;
  return w;
}
let DFT_RE: Float32Array | undefined, DFT_IM: Float32Array | undefined;
function dftMatrix(): { re: Float32Array; im: Float32Array } {
  if (DFT_RE && DFT_IM) return { re: DFT_RE, im: DFT_IM };
  const re = new Float32Array(HALF_FFT * FFT_SIZE), im = new Float32Array(HALF_FFT * FFT_SIZE);
  for (let k = 0; k < HALF_FFT; k++) {
    for (let n = 0; n < FFT_SIZE; n++) {
      const t = (-2 * Math.PI * k * n) / FFT_SIZE;
      re[k * FFT_SIZE + n] = Math.cos(t);
      im[k * FFT_SIZE + n] = Math.sin(t);
    }
  }
  DFT_RE = re; DFT_IM = im;
  return { re, im };
}

/** 400-point DFT matrix-vector multiply over a hann-windowed frame; returns magnitude² of bins 0..200. */
function frameSpectrum(frame: Float32Array, hann: Float32Array, re: Float32Array, im: Float32Array, out: Float32Array) {
  for (let k = 0; k < HALF_FFT; k++) {
    let r = 0, j = 0;
    const base = k * FFT_SIZE;
    for (let n = 0; n < FFT_SIZE; n++) {
      const x = frame[n] * hann[n];
      r += x * re[base + n];
      j += x * im[base + n];
    }
    out[k] = r * r + j * j;
  }
}

/**
 * Center-pad 80 (reflect: samples[80], samples[79], ..., samples[1], then samples[0..]), then
 * kaldi frames (window 400, shift 160, snip_edges). Frame count is min(frames_from_padded,
 * floor(num_unpadded/160)) to match offline-stream FeedWhisper's GetFrames truncation.
 */
export function logMelFeatures(samples: Float32Array): { features: Float32Array; numFrames: number } {
  const n = samples.length;
  if (n < 2) return { features: new Float32Array(0), numFrames: 0 };
  const padded = new Float32Array(n + WHISPER_PAD);
  for (let i = 0; i < WHISPER_PAD; i++) padded[i] = samples[Math.min(WHISPER_PAD - i, n - 1)];
  padded.set(samples, WHISPER_PAD);
  const maxFromPad = Math.max(0, Math.floor((padded.length - FRAME_LEN) / FRAME_SHIFT) + 1);
  const numFrames = Math.min(maxFromPad, Math.floor(n / FRAME_SHIFT));
  if (numFrames <= 0) return { features: new Float32Array(0), numFrames: 0 };
  const hann = hannWindow(), fb = melFilterbank(), { re, im } = dftMatrix();
  const features = new Float32Array(numFrames * N_MELS);
  const spectrum = new Float32Array(HALF_FFT), frame = new Float32Array(FRAME_LEN);
  for (let t = 0; t < numFrames; t++) {
    const at = t * FRAME_SHIFT;
    for (let i = 0; i < FRAME_LEN; i++) frame[i] = padded[at + i];
    frameSpectrum(frame, hann, re, im, spectrum);
    const row = t * N_MELS;
    for (let m = 0; m < N_MELS; m++) {
      let acc = 0;
      const fbRow = m * HALF_FFT;
      for (let k = 0; k < HALF_FFT; k++) acc += fb[fbRow + k] * spectrum[k];
      features[row + m] = acc;
    }
  }
  normalizeWhisperFeatures(features, numFrames);
  return { features, numFrames };
}

/** clamp(x, 1e-10).log10(); then max(x, max-8); then (x+4)/4. */
export function normalizeWhisperFeatures(features: Float32Array, numFrames: number): void {
  const n = numFrames * N_MELS;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Math.log10(Math.max(features[i], 1e-10));
    features[i] = v;
    if (v > max) max = v;
  }
  const floor = max - 8;
  for (let i = 0; i < n; i++) {
    const v = features[i] < floor ? floor : features[i];
    features[i] = (v + 4) / 4;
  }
}

/** Reference TrimAudioFeatures on [1, audio tokens, hidden width] embeddings; null means all silent. */
export async function trimAudioFeatures(features: OrtTensor): Promise<OrtTensor | null> {
  const shape = features.dims;
  if (shape.length !== 3 || shape[0] !== 1 || shape[1] <= 0 || shape[2] <= 0) return features;
  if (features.type !== 'float32' && features.type !== 'float16' && features.type !== 'uint16') return features;
  const [, numFrames, width] = shape, source = features.data as Float32Array | Uint16Array;
  // ORT can expose float16 data as native Float16Array; scan and copy its underlying half bits.
  const data = features.type === 'float32' ? source : new Uint16Array(source.buffer, source.byteOffset, source.byteLength / 2);
  const eps = 1e-6;
  for (let a = numFrames - 1; a >= 0; a--) {
    let m = 0;
    const row = a * width;
    for (let d = 0; d < width; d++) {
      const v = Math.abs(features.type === 'float32' ? data[row + d] : fp16ToFloat(data[row + d]));
      if (v > m) m = v;
    }
    if (m > eps) {
      if (a + 1 === numFrames) return features;
      const o = await ort();
      return new o.Tensor(features.type, data.slice(0, (a + 1) * width), [1, a + 1, width]);
    }
  }
  return null;
}

/** tn = (((cs+1)/2+1)/2+1)/2 integer-div; full*tn + aftercnn(rem) where aftercnn = three times (x-1)/2+1. */
export function featToAudioTokensLen(featLen: number, chunkSize = CHUNK_SIZE): number {
  const tn = Math.floor((Math.floor((Math.floor((chunkSize + 1) / 2) + 1) / 2) + 1) / 2);
  const full = Math.floor(featLen / chunkSize), rem = featLen % chunkSize;
  if (rem <= 0) return full * tn;
  let x = rem;
  for (let i = 0; i < 3; i++) x = Math.floor((x - 1) / 2) + 1;
  return full * tn + x;
}

/* ---------- Tokenizer (byte-level BPE, Qwen3 pre-tok, longest-first specials) ---------- */

/** GPT-2 byte↔unicode: bytes 33-126, 161-172, 174-255 identity; others get code point 256+n. */
function byteUnicodeTables(): { byteToU: string[]; uToByte: Map<string, number> } {
  const base: number[] = [];
  for (let b = 33; b <= 126; b++) base.push(b);
  for (let b = 161; b <= 172; b++) base.push(b);
  for (let b = 174; b <= 255; b++) base.push(b);
  const bytes = base.slice(), codes = base.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!base.includes(b)) {
      bytes.push(b);
      codes.push(256 + n);
      n++;
    }
  }
  const byteToU = new Array<string>(256);
  const uToByte = new Map<string, number>();
  for (let i = 0; i < bytes.length; i++) {
    const u = String.fromCodePoint(codes[i]);
    byteToU[bytes[i]] = u;
    uToByte.set(u, bytes[i]);
  }
  return { byteToU, uToByte };
}

/**
 * Qwen3 pre-tokenization pattern. Case variants enumerated for 's|'t|'re|'ve|'m|'ll|'d because
 * JS does not support inline (?i:...) group modifiers across all engines (reference uses them).
 */
const PRE_TOK_RE = /'[sStTdDmM]|'[rR][eE]|'[vV][eE]|'[lL][lL]|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]|\s+(?!\S)|\s+/gu;

function isSkippableSpecial(token: string): boolean {
  return token === '<|im_start|>' || token === '<|im_end|>';
}

/** longest-first match of specials at pos; returns matched special or null. */
function matchSpecialAt(text: string, pos: number, sortedSpecials: string[]): string | null {
  for (const s of sortedSpecials) if (text.startsWith(s, pos)) return s;
  return null;
}

export class Qwen3AsrTokenizer {
  private readonly token2id = new Map<string, number>();
  private readonly id2token: string[] = [];
  private readonly bpeRanks = new Map<string, number>();
  private readonly specials = new Map<string, number>();
  private readonly sortedSpecials: string[] = [];
  readonly byteToU: string[];
  readonly uToByte: Map<string, number>;
  readonly eosId: number;
  readonly asrTextId: number;

  constructor(vocabJson: string, mergesTxt: string, tokenizerConfigJson: string) {
    ({ byteToU: this.byteToU, uToByte: this.uToByte } = byteUnicodeTables());
    const vocab = JSON.parse(vocabJson) as Record<string, number>;
    for (const [tok, id] of Object.entries(vocab)) {
      this.token2id.set(tok, id);
      this.id2token[id] = tok;
    }
    let rank = 0;
    for (const line of mergesTxt.split('\n')) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const sp = trimmed.indexOf(' ');
      if (sp <= 0) continue;
      this.bpeRanks.set(trimmed.slice(0, sp) + '\t' + trimmed.slice(sp + 1), rank++);
    }
    const config = JSON.parse(tokenizerConfigJson) as { added_tokens_decoder?: Record<string, { content: string }> };
    for (const [idStr, entry] of Object.entries(config.added_tokens_decoder ?? {})) {
      const id = Number(idStr), content = entry.content;
      if (!this.token2id.has(content)) { this.token2id.set(content, id); this.id2token[id] = content; }
      if (content.length >= 5 && content.startsWith('<|') && content.endsWith('|>')) this.specials.set(content, id);
      else if (content === '<asr_text>' || content === '<unk>' || content === '<|unk|>') this.specials.set(content, id);
    }
    this.sortedSpecials = [...this.specials.keys()].sort((a, b) => b.length - a.length);
    const eos = this.specials.get('<|im_end|>') ?? this.token2id.get('<|im_end|>');
    if (eos === undefined) throw new AnalysisError('TRANSCRIPTION_FAILED', 'Qwen3-ASR tokenizer has no <|im_end|> special token.');
    this.eosId = eos;
    const asrText = this.specials.get('<asr_text>') ?? this.token2id.get('<asr_text>');
    if (asrText === undefined) throw new AnalysisError('TRANSCRIPTION_FAILED', 'Qwen3-ASR tokenizer has no <asr_text> special token.');
    this.asrTextId = asrText;
  }

  getTokenId(token: string): number {
    const id = this.specials.get(token) ?? this.token2id.get(token);
    if (id === undefined) throw new AnalysisError('TRANSCRIPTION_FAILED', `Qwen3-ASR tokenizer has no token "${token}".`);
    return id;
  }

  /** Encode a string into token ids, honouring special tokens by longest-first prefix match. */
  encode(text: string): number[] {
    const ids: number[] = [];
    let pos = 0;
    while (pos < text.length) {
      const sp = matchSpecialAt(text, pos, this.sortedSpecials);
      if (sp) {
        ids.push(this.specials.get(sp)!);
        pos += sp.length;
        continue;
      }
      let nextSpecial = -1;
      for (const s of this.sortedSpecials) {
        const i = text.indexOf(s, pos);
        if (i >= 0 && (nextSpecial < 0 || i < nextSpecial)) nextSpecial = i;
      }
      const chunk = nextSpecial < 0 ? text.slice(pos) : text.slice(pos, nextSpecial);
      this.encodeOrdinary(chunk, ids);
      pos += chunk.length;
    }
    return ids;
  }

  private encodeOrdinary(chunk: string, out: number[]) {
    PRE_TOK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PRE_TOK_RE.exec(chunk)) !== null) {
      const piece = m[0];
      const bytes = new TextEncoder().encode(piece);
      let unicode = '';
      for (const b of bytes) unicode += this.byteToU[b];
      const bpe = this.bpeEncode(unicode);
      for (const id of bpe) out.push(id);
    }
  }

  private bpeEncode(piece: string): number[] {
    if (!piece.length) return [];
    let parts = [...piece];
    while (parts.length > 1) {
      let bestRank = Infinity, bestI = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.bpeRanks.get(parts[i] + '\t' + parts[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; bestI = i; }
      }
      if (bestI < 0) break;
      parts.splice(bestI, 2, parts[bestI] + parts[bestI + 1]);
    }
    const ids: number[] = [];
    for (const p of parts) {
      const id = this.token2id.get(p);
      if (id !== undefined) { ids.push(id); continue; }
      for (const ch of p) {
        const sub = this.token2id.get(ch);
        if (sub === undefined) throw new AnalysisError('TRANSCRIPTION_FAILED', `Qwen3-ASR tokenizer has no byte token for "${ch}".`);
        ids.push(sub);
      }
    }
    return ids;
  }

  /** Decode token ids: non-specials flushed as bytes through uToByte; <|im_start|>/<|im_end|> dropped. */
  decode(ids: readonly number[]): string {
    const chunks: Uint8Array[] = [];
    let buffer: number[] = [];
    const flush = () => {
      if (!buffer.length) return;
      const bytes: number[] = [];
      for (const id of buffer) {
        const tok = this.id2token[id];
        if (tok === undefined) continue;
        for (const u of tok) {
          const b = this.uToByte.get(u);
          if (b !== undefined) bytes.push(b);
        }
      }
      chunks.push(new Uint8Array(bytes));
      buffer = [];
    };
    const specialOut: { at: number; text: string }[] = [];
    for (const id of ids) {
      const tok = this.id2token[id];
      if (tok !== undefined && this.specials.has(tok)) {
        flush();
        if (!isSkippableSpecial(tok)) specialOut.push({ at: chunks.length, text: tok });
      } else buffer.push(id);
    }
    flush();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const parts = chunks.map(c => decoder.decode(c));
    let result = '';
    let si = 0;
    for (let i = 0; i <= parts.length; i++) {
      while (si < specialOut.length && specialOut[si].at === i) { result += specialOut[si].text; si++; }
      if (i < parts.length) result += parts[i];
    }
    return result.replace(/�/g, '');
  }
}

/* ---------- ONNX model wrapper (conv frontend, encoder, decoder) ---------- */

type KVLayer = { key: OrtTensor; value: OrtTensor };

interface Qwen3AsrModelOptions { convUrl: string; encoderUrl: string; decoderUrl: string; wasm?: { mjs: string; wasm: string } }

export class Qwen3AsrModel {
  private conv!: OrtSession;
  private encoder!: OrtSession;
  private decoder!: OrtSession;
  private o!: OrtNS;
  numLayers = 0;
  maxTotalLen = 0;
  private pastKeyShapeTpl: readonly number[] = [];
  private kvKeyType: OrtTensorDataType = 'float32';
  private kvValueType: OrtTensorDataType = 'float32';
  private decoderInputNames: readonly string[] = [];
  private decoderOutputNames: readonly string[] = [];
  private convInputName = '';
  private convOutputName = '';
  private encoderInputNames: readonly string[] = [];
  private encoderOutputName = '';

  static async create(opts: Qwen3AsrModelOptions): Promise<Qwen3AsrModel> {
    const m = new Qwen3AsrModel();
    m.o = await ort(opts.wasm);
    const sessOpts: import('onnxruntime-web/webgpu').InferenceSession.SessionOptions = { executionProviders: ['wasm'] };
    const [convBytes, encoderBytes, decoderBytes] = await Promise.all([readBytes(opts.convUrl), readBytes(opts.encoderUrl), readBytes(opts.decoderUrl)]);
    try {
      m.conv = await m.o.InferenceSession.create(convBytes, sessOpts);
      m.encoder = await m.o.InferenceSession.create(encoderBytes, sessOpts);
      m.decoder = await m.o.InferenceSession.create(decoderBytes, sessOpts);
      if (m.conv.inputNames.length !== 1 || m.conv.outputNames.length !== 1) throw new AnalysisError('TRANSCRIPTION_FAILED', 'Qwen3-ASR conv frontend must have exactly one input and output.');
      m.convInputName = m.conv.inputNames[0]; m.convOutputName = m.conv.outputNames[0];
      if (m.encoder.inputNames.length !== 2 || m.encoder.outputNames.length !== 1) throw new AnalysisError('TRANSCRIPTION_FAILED', 'Qwen3-ASR encoder must have exactly two inputs and one output.');
      m.encoderInputNames = m.encoder.inputNames; m.encoderOutputName = m.encoder.outputNames[0];
      m.decoderInputNames = m.decoder.inputNames; m.decoderOutputNames = m.decoder.outputNames;
      const outs = m.decoderOutputNames.length;
      if (outs < 1 || (outs - 1) % 2 !== 0) throw new AnalysisError('TRANSCRIPTION_FAILED', 'Qwen3-ASR decoder outputs mismatch: expected 1+2*num_layers.');
      m.numLayers = (outs - 1) / 2;
      if (m.decoderInputNames.length !== 4 + 2 * m.numLayers) throw new AnalysisError('TRANSCRIPTION_FAILED', 'Qwen3-ASR decoder inputs mismatch: expected 4+2*num_layers.');
      const pastKeyMeta = m.decoder.inputMetadata[4] as { shape?: readonly (number | string)[]; type?: string };
      const shape = pastKeyMeta?.shape ?? [];
      m.pastKeyShapeTpl = shape.map(d => typeof d === 'number' ? d : -1);
      const dim1 = m.pastKeyShapeTpl[1];
      m.maxTotalLen = typeof dim1 === 'number' && dim1 > 0 ? Math.min(dim1, MAX_TOTAL_LEN_CAP) : MAX_TOTAL_LEN_CAP;
      const keyMeta = m.decoder.inputMetadata[4] as { type?: string };
      const valMeta = m.decoder.inputMetadata[5] as { type?: string };
      m.kvKeyType = (keyMeta?.type ?? 'float32') as OrtTensorDataType;
      m.kvValueType = (valMeta?.type ?? 'float32') as OrtTensorDataType;
      if (m.kvKeyType !== 'float32' && m.kvKeyType !== 'float16' && m.kvKeyType !== 'uint16') throw new AnalysisError('TRANSCRIPTION_FAILED', `Qwen3-ASR decoder past_key dtype ${m.kvKeyType} is not supported.`);
      if (m.kvValueType !== 'float32' && m.kvValueType !== 'float16' && m.kvValueType !== 'uint16') throw new AnalysisError('TRANSCRIPTION_FAILED', `Qwen3-ASR decoder past_value dtype ${m.kvValueType} is not supported.`);
      return m;
    } catch (error) {
      await m.dispose().catch(() => {});
      throw error;
    }
  }

  async forwardConvFrontend(features: Float32Array, numFrames: number): Promise<OrtTensor> {
    const tensor = new this.o.Tensor('float32', features, [1, numFrames, N_MELS]);
    const outputs = await this.conv.run({ [this.convInputName]: tensor });
    return outputs[this.convOutputName];
  }

  async forwardEncoder(conv: OrtTensor, valid: number): Promise<OrtTensor> {
    const [, convFrames] = conv.dims as readonly number[];
    const maskData = new Uint8Array(convFrames);
    for (let i = 0; i < Math.min(valid, convFrames); i++) maskData[i] = 1;
    const mask = new this.o.Tensor('bool', maskData, [1, convFrames]);
    const outputs = await this.encoder.run({ [this.encoderInputNames[0]]: conv, [this.encoderInputNames[1]]: mask });
    return outputs[this.encoderOutputName];
  }

  /** Allocate zero KV cache of shape [batch, max_total_len, kv_h, head_dim] per layer. */
  createEmptyKVCache(batch = 1): KVLayer[] {
    const [, , kvH, hd] = this.pastKeyShapeTpl as readonly number[];
    if (!(kvH > 0) || !(hd > 0)) throw new AnalysisError('TRANSCRIPTION_FAILED', 'Qwen3-ASR decoder past_key shape has no kv_h/head_dim.');
    const shape = [batch, this.maxTotalLen, kvH, hd];
    const numel = batch * this.maxTotalLen * kvH * hd;
    const kv: KVLayer[] = [];
    for (let i = 0; i < this.numLayers; i++) {
      const keyData = this.kvKeyType === 'float32' ? new Float32Array(numel) : new Uint16Array(numel);
      const valueData = this.kvValueType === 'float32' ? new Float32Array(numel) : new Uint16Array(numel);
      kv.push({ key: new this.o.Tensor(this.kvKeyType, keyData, shape), value: new this.o.Tensor(this.kvValueType, valueData, shape) });
    }
    return kv;
  }

  async forwardLLM(inputIds: BigInt64Array, audioFeatures: OrtTensor, cachePosition: BigInt64Array, cacheKv: KVLayer[]): Promise<{ logits: OrtTensor; kvDelta: KVLayer[] }> {
    const seqLen = inputIds.length;
    const attnData = new BigInt64Array(seqLen);
    for (let i = 0; i < seqLen; i++) attnData[i] = 1n;
    const feeds: Record<string, OrtTensor> = {
      [this.decoderInputNames[0]]: new this.o.Tensor('int64', inputIds, [1, seqLen]),
      [this.decoderInputNames[1]]: audioFeatures,
      [this.decoderInputNames[2]]: new this.o.Tensor('int64', attnData, [1, seqLen]),
      [this.decoderInputNames[3]]: new this.o.Tensor('int64', cachePosition, [cachePosition.length]),
    };
    for (let i = 0; i < this.numLayers; i++) {
      feeds[this.decoderInputNames[4 + 2 * i]] = cacheKv[i].key;
      feeds[this.decoderInputNames[4 + 2 * i + 1]] = cacheKv[i].value;
    }
    const outputs = await this.decoder.run(feeds);
    const logits = outputs[this.decoderOutputNames[0]];
    const kvDelta: KVLayer[] = [];
    for (let i = 0; i < this.numLayers; i++) kvDelta.push({ key: outputs[this.decoderOutputNames[1 + 2 * i]], value: outputs[this.decoderOutputNames[1 + 2 * i + 1]] });
    return { logits, kvDelta };
  }

  /** Copy delta key/value into cache at [:, pos0:pos0+S, :, :] without reallocating the cache tensor. */
  applyKvDeltaInplace(cacheKv: KVLayer[], kvDelta: KVLayer[], cachePosition: BigInt64Array): void {
    const pos0 = Number(cachePosition[0]);
    const s = cachePosition.length;
    if (pos0 < 0 || pos0 >= this.maxTotalLen) return;
    const [, , kvH, hd] = this.pastKeyShapeTpl as readonly number[];
    const perPos = kvH * hd;
    const copyS = Math.min(s, this.maxTotalLen - pos0);
    for (let L = 0; L < this.numLayers; L++) {
      const dstK = cacheKv[L].key.data as Float32Array | Uint16Array;
      const dstV = cacheKv[L].value.data as Float32Array | Uint16Array;
      const srcK = kvDelta[L].key.data as Float32Array | Uint16Array;
      const srcV = kvDelta[L].value.data as Float32Array | Uint16Array;
      const srcS = (kvDelta[L].key.dims as readonly number[])[1];
      const copy = Math.min(copyS, srcS);
      const dstOff = pos0 * perPos;
      for (let t = 0; t < copy; t++) {
        for (let i = 0; i < perPos; i++) {
          dstK[dstOff + t * perPos + i] = srcK[t * perPos + i];
          dstV[dstOff + t * perPos + i] = srcV[t * perPos + i];
        }
      }
    }
  }

  async dispose(): Promise<void> {
    const released = await Promise.allSettled([this.conv, this.encoder, this.decoder].filter(Boolean).map(async session => session.release()));
    const failure = released.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

/* ---------- Recognizer: prompt → encoder → greedy KV-cache decode → cleanup ---------- */

function logitsToFloat32(logits: OrtTensor): Float32Array {
  const data = logits.data;
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = fp16ToFloat(data[i]);
    return out;
  }
  throw new AnalysisError('TRANSCRIPTION_FAILED', 'Qwen3-ASR logits must be float32 or float16.');
}
function fp16ToFloat(h: number): number {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}
function argmax(row: Float32Array, exclude?: number): number {
  let best = -Infinity, bestI = 0;
  for (let i = 0; i < row.length; i++) {
    if (i === exclude) continue;
    const v = row[i];
    if (v > best) { best = v; bestI = i; }
  }
  return bestI;
}

/** Last LOOP_WINDOW generated ids collapse to <= LOOP_MAX_DISTINCT distinct values → degenerate. */
function isDegenerateRepetition(generated: readonly number[]): boolean {
  if (generated.length < LOOP_WINDOW) return false;
  const seen = new Set<number>();
  for (let i = generated.length - LOOP_WINDOW; i < generated.length; i++) seen.add(generated[i]);
  return seen.size <= LOOP_MAX_DISTINCT;
}
function trimDegenerateTail(generated: number[]): void {
  if (generated.length < LOOP_WINDOW) return;
  while (generated.length) {
    const seen = new Set<number>();
    for (let i = Math.max(0, generated.length - LOOP_WINDOW); i < generated.length; i++) seen.add(generated[i]);
    if (seen.size > LOOP_MAX_DISTINCT) break;
    generated.pop();
  }
}

export interface Qwen3AsrDecodeResult { text: string }

export class Qwen3AsrRecognizer {
  private readonly audioPadIds: number[];
  private readonly promptIdsAfter: number[];
  constructor(readonly model: Qwen3AsrModel, readonly tokenizer: Qwen3AsrTokenizer) {
    this.audioPadIds = tokenizer.encode('<|audio_pad|>');
    this.promptIdsAfter = tokenizer.encode('<|audio_end|><|im_end|>\n<|im_start|>assistant\n');
  }

  /** <|im_start|>system\n<hotwords><|im_end|>\n<|im_start|>user\n<|audio_start|><audio_pad>*A<|audio_end|><|im_end|>\n<|im_start|>assistant\n[language en<asr_text>] */
  private buildSourceIds(audioTokenLen: number, language: string, hotwords: string): number[] {
    const before = this.tokenizer.encode('<|im_start|>system\n' + hotwords + '<|im_end|>\n<|im_start|>user\n<|audio_start|>');
    const ids = before.slice();
    const pad = this.audioPadIds[0];
    for (let i = 0; i < audioTokenLen; i++) ids.push(pad);
    for (const id of this.promptIdsAfter) ids.push(id);
    if (language) {
      for (const id of this.tokenizer.encode('language ' + language)) ids.push(id);
      ids.push(this.tokenizer.asrTextId);
    }
    return ids;
  }

  /** Strip the "language <L><asr_text>" prefix within the first 16 generated ids, if present. */
  private cleanupPrefix(generated: number[]): number[] {
    const scan = Math.min(16, generated.length);
    let asrAt = -1;
    for (let i = 1; i < scan; i++) if (generated[i] === this.tokenizer.asrTextId) { asrAt = i; break; }
    if (asrAt < 0) return generated;
    const prefix = this.tokenizer.decode(generated.slice(0, asrAt + 1));
    if (prefix.startsWith('language ') && prefix.endsWith('<asr_text>')) return generated.slice(asrAt + 1);
    return generated;
  }

  async decode(samples: Float32Array, language = 'en', hotwords = ''): Promise<Qwen3AsrDecodeResult> {
    const { features, numFrames } = logMelFeatures(samples);
    if (numFrames < 2) return { text: '' };
    const conv = await this.model.forwardConvFrontend(features, numFrames);
    const [, convFrames] = conv.dims as readonly number[];
    const expected = featToAudioTokensLen(numFrames, CHUNK_SIZE);
    const audioValid = Math.min(expected, convFrames);
    const audioFeatures = await trimAudioFeatures(await this.model.forwardEncoder(conv, audioValid));
    if (!audioFeatures) return { text: '' };
    const audioTokenLen = audioFeatures.dims.length === 3 && audioFeatures.dims[1] > 0 ? Math.min(audioValid, audioFeatures.dims[1]) : audioValid;
    if (audioTokenLen <= 0) return { text: '' };

    const source = this.buildSourceIds(audioTokenLen, language, hotwords);
    if (source.length >= this.model.maxTotalLen) return { text: '' };
    const cacheKv = this.model.createEmptyKVCache(1);
    const cachePos0 = new BigInt64Array(source.length);
    for (let i = 0; i < source.length; i++) cachePos0[i] = BigInt(i);
    const ids0 = BigInt64Array.from(source.map(BigInt));
    const first = await this.model.forwardLLM(ids0, audioFeatures, cachePos0, cacheKv);
    this.model.applyKvDeltaInplace(cacheKv, first.kvDelta, cachePos0);
    const logits0 = logitsToFloat32(first.logits);
    const dims0 = first.logits.dims as readonly number[];
    const vocabSize = dims0[dims0.length - 1];
    const lastRow0 = logits0.subarray((source.length - 1) * vocabSize, source.length * vocabSize);
    let token = argmax(lastRow0);
    if (token === EOS_IM_END || token === EOS_ENDOFTEXT) {
      token = argmax(lastRow0, token);
      if (token === EOS_IM_END || token === EOS_ENDOFTEXT) return { text: '' };
    }
    const generated: number[] = [token];
    let curLen = source.length;
    while (true) {
      if (curLen >= this.model.maxTotalLen) break;
      const inputIds = BigInt64Array.of(BigInt(token));
      const cachePos = BigInt64Array.of(BigInt(curLen));
      const step = await this.model.forwardLLM(inputIds, audioFeatures, cachePos, cacheKv);
      this.model.applyKvDeltaInplace(cacheKv, step.kvDelta, cachePos);
      curLen += 1;
      const logits = logitsToFloat32(step.logits);
      const stepRow = logits.subarray(logits.length - vocabSize);
      token = argmax(stepRow);
      if (token === EOS_IM_END || token === EOS_ENDOFTEXT) break;
      generated.push(token);
      if (isDegenerateRepetition(generated)) { trimDegenerateTail(generated); break; }
    }
    const cleaned = this.cleanupPrefix(generated);
    const text = this.tokenizer.decode(cleaned).replace(/�/g, '').trim();
    return { text };
  }

  async dispose(): Promise<void> { await this.model.dispose(); }
}

/* ---------- Entry point ---------- */

export interface Qwen3AsrLoadOptions { modelId: string; wasm?: { mjs: string; wasm: string } }

export async function loadQwen3Asr(opts: Qwen3AsrLoadOptions): Promise<Qwen3AsrRecognizer> {
  const root = env.localModelPath, id = opts.modelId;
  const base = `${root}${id}/`;
  const pendingModel = Qwen3AsrModel.create({ convUrl: base + 'conv_frontend.onnx', encoderUrl: base + 'encoder.int8.onnx', decoderUrl: base + 'decoder.int8.onnx', wasm: opts.wasm });
  try {
    const [vocab, merges, config, model] = await Promise.all([
      readText(base + 'tokenizer/vocab.json'),
      readText(base + 'tokenizer/merges.txt'),
      readText(base + 'tokenizer/tokenizer_config.json'),
      pendingModel,
    ]);
    const tokenizer = new Qwen3AsrTokenizer(vocab, merges, config);
    return new Qwen3AsrRecognizer(model, tokenizer);
  } catch (error) {
    // A tokenizer failure may win the race while session creation is still pending.
    const model = await pendingModel.catch(() => undefined);
    if (model) await model.dispose().catch(() => {});
    throw error;
  }
}
