// SPDX-License-Identifier: AGPL-3.0-only
import { env, pipeline, Florence2ForConditionalGeneration, AutoProcessor, AutoTokenizer, AutoModelForAudioFrameClassification, AutoModelForCTC, AutoModel, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, PreTrainedModel, RawImage, Tensor } from '@huggingface/transformers';
import type { AutomaticSpeechRecognitionPipeline, AudioClassificationPipeline, FeatureExtractionPipeline, Florence2Processor, PreTrainedTokenizer, Processor } from '@huggingface/transformers';
import type { InferenceSession } from 'onnxruntime-web';
import { averageLinkage } from './speakers';
import { AnalysisError, type Frame, type Pair, type Transcript } from './types';
import { MODEL_IDS } from './model-ids';
import { ctcAlign, spell, CTC_FRAME } from './align';
import type { Qwen3AsrRecognizer } from './qwen-asr';

export { MODEL_IDS };
export type ModelOptions = { modelRoot: string; device?: 'auto' | 'wasm' | 'cpu'; wasm?: { mjs: string; wasm: string } };
/** The DTW corrections below patch private Transformers.js methods verified on this version only. */
const DTW_PATCHED_VERSION = '4.3.2';
/** T19q round B4: the BeatThis export that ships (fold0 never trained on the scored drummer1 take). */
export const BEAT_THIS_FILE = 'beat_this_fold0.onnx';
/** A rejected model load is not cached, so the next call retries it (review m4). */
function retryable<T>(promise: Promise<T>, forget: (failed: Promise<T>) => void) { promise.catch(() => forget(promise)); return promise; }
const unit = (v: number[]) => { const norm = Math.hypot(...v) || 1; return v.map(x => x / norm); };
/** One engine per worker. All models must be prepared and hash-checked by tools/prepare.py. */
export class LocalModels {
  private asr?: Promise<AutomaticSpeechRecognitionPipeline>;
  private sound?: Promise<AudioClassificationPipeline>;
  private embedding?: Promise<FeatureExtractionPipeline>;
  private vision?: Promise<{ model: Florence2ForConditionalGeneration; processor: Florence2Processor }>;
  private vad?: Promise<{ model: PreTrainedModel; processor: Processor }>;
  private speaker?: Promise<{ model: PreTrainedModel; processor: Processor }>;
  private aligner?: Promise<{ model: PreTrainedModel; vocab: Map<string, number>; blank: number; delimiter: number }>;
  private beatThis = new Map<string, Promise<{ ort: typeof import('onnxruntime-web'); session: InferenceSession }>>();
  private clip?: Promise<{ vision: PreTrainedModel; text: PreTrainedModel; processor: Processor; tokenizer: PreTrainedTokenizer }>;
  private qwen?: Promise<Qwen3AsrRecognizer>;
  readonly backends: Record<string, string> = {};
  constructor(private options: ModelOptions) {
    env.allowRemoteModels = false; env.allowLocalModels = true; env.useBrowserCache = false; env.useFSCache = false; env.useWasmCache = false;
    if (typeof location !== 'undefined') {
      const root = new URL(options.modelRoot, location.href);
      if (root.origin !== location.origin) throw new AnalysisError('INVALID_MODEL_ROOT', 'Models must be served from this application origin.');
      env.localModelPath = root.href.endsWith('/') ? root.href : root.href + '/';
      env.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.origin !== location.origin) throw new AnalysisError('REMOTE_ANALYSIS_DISABLED', 'Analysis cannot request remote resources.');
        return fetch(input, init);
      };
      // Transformers.js 4.3.2 probes optional tokenizer/processor configs with a metadata check that
      // skips URL model paths, so in a browser those configs read as missing. Serve small config files
      // from the same-origin model root through the custom-cache hook; weights keep the normal path.
      env.useCustomCache = true;
      env.customCache = {
        match: async (key: string | Request) => {
          const url = new URL(typeof key === 'string' ? key : key.url, location.href);
          if (!url.href.startsWith(env.localModelPath) || !/\.(json|txt)$/.test(url.pathname)) return undefined;
          const response = await fetch(url);
          return response.ok ? response : undefined;
        },
        put: async () => undefined,
      };
    } else env.localModelPath = options.modelRoot.replace(/\\/g, '/').replace(/\/?$/, '/');
    if (env.backends.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      if (options.wasm) env.backends.onnx.wasm.wasmPaths = options.wasm;
    }
  }
  private async load<T>(key: string, factory: (device: 'webgpu' | 'wasm' | 'cpu') => Promise<T>): Promise<T> {
    const fallback = typeof location === 'undefined' ? 'cpu' : 'wasm';
    const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
    if ((this.options.device ?? 'auto') === 'auto' && gpu && await gpu.requestAdapter()) {
      try { const result = await factory('webgpu'); this.backends[key] = 'webgpu'; return result; }
      catch { /* A supported adapter can still reject an ONNX operator; retry the same model locally. */ }
    }
    const device = this.options.device === 'cpu' ? 'cpu' : fallback;
    const result = await factory(device); this.backends[key] = device; return result;
  }
  /** A small text file from the model root: the local cache in Node, the same-origin fetch in a browser. */
  private async modelText(id: string, file: string): Promise<string> {
    const url = `${env.localModelPath}${id}/${file}`;
    if (typeof location === 'undefined') {
      const fs = (globalThis as unknown as { process: { getBuiltinModule(name: 'node:fs'): { readFileSync(path: string, encoding: 'utf8'): string } } }).process.getBuiltinModule('node:fs');
      return fs.readFileSync(url, 'utf8');
    }
    const response = await env.fetch(url);
    if (!response.ok) throw new AnalysisError('TRANSCRIPTION_FAILED', `The local model file ${file} is missing.`);
    return response.text();
  }
  /** BeatThis beat logits `[frames]` for one log-mel chunk `[frames, 128]` (T19q B4). `file` is fold0's export, except
   * where the scorer scores a Groove validation item with the fold checkpoint that held it out. */
  async beatLogits(spect: Float32Array, frames: number, file = BEAT_THIS_FILE): Promise<Float32Array> {
    let pending = this.beatThis.get(file);
    if (!pending) {
      pending = retryable((async () => {
        // The ONNX Runtime build Transformers.js uses in a browser; its wasm CPU kernels on one thread,
        // in Node as well, so the scorer and the worker run the same arithmetic (T19 B1's loader).
        const ort = await import('onnxruntime-web/webgpu');
        ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
        if (this.options.wasm) ort.env.wasm.wasmPaths = this.options.wasm;
        const url = `${env.localModelPath}${MODEL_IDS.beats}/${file}`;
        let bytes: Uint8Array;
        if (typeof location === 'undefined') {
          const fs = (globalThis as unknown as { process: { getBuiltinModule(name: 'node:fs'): { readFileSync(path: string): Uint8Array } } }).process.getBuiltinModule('node:fs');
          bytes = fs.readFileSync(url);
        } else {
          const response = await env.fetch(url);
          if (!response.ok) throw new AnalysisError('BEATS_FAILED', `The local model file ${file} is missing.`);
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
        this.backends.beats = 'wasm';
        return { ort, session };
      })(), failed => { if (this.beatThis.get(file) === failed) this.beatThis.delete(file); });
      this.beatThis.set(file, pending);
    }
    const { ort, session } = await pending;
    const { beat } = await session.run({ spect: new ort.Tensor('float32', spect, [1, frames, 128]) });
    return beat.data as Float32Array;
  }
  /** T19q T5: whisper and Qwen3-ASR never share the 4 GiB wasm heap; releasing is idempotent. */
  private async releaseQwen() { if (this.qwen) { const q = this.qwen; this.qwen = undefined; try { await (await q).dispose(); } catch { /* already down */ } } }
  private async releaseWhisper() { if (this.asr) { const w = this.asr; this.asr = undefined; try { await (await w).dispose(); } catch { /* already down */ } } }
  private whisper() {
    return this.asr ??= retryable(this.load('transcription', async device => {
      await this.releaseQwen();
      if (env.version !== DTW_PATCHED_VERSION) throw new AnalysisError('TRANSCRIPTION_FAILED', `Word timing is verified on Transformers.js ${DTW_PATCHED_VERSION}, not ${env.version}.`);
      const asr = await pipeline('automatic-speech-recognition', MODEL_IDS.whisper, { device, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, local_files_only: true });
      // Two Transformers.js 4.3.2 DTW defects, corrected against the reference word-timing algorithm:
      // 1. Word timestamps go through the seek path, which crops the cross-attentions to the padded
      //    30 s window, so the DTW spans the zero padding after short audio (a 10 s window collapses
      //    every word to 29.98 s). The reference crops to the real chunk length, num_frames // 2
      //    encoder frames; the pipeline hands that length to generate() as num_frames in mel frames.
      // 2. It drops the attention row of the last prompt token, which is the row that predicts the
      //    first generated token, so every token receives the next token's time. Keep that row and
      //    move each time back onto the token it predicts.
      const whisper = asr.model as unknown as {
        generate(options: { num_frames?: number }): Promise<unknown>;
        _extract_token_timestamps(outputs: unknown, heads: unknown, frames: number | null, precision: number, inputIds: number): Tensor;
      };
      const generate = whisper.generate.bind(whisper), extract = whisper._extract_token_timestamps.bind(whisper);
      let melFrames: number | undefined;
      whisper.generate = options => { melFrames = options.num_frames; return generate(options); };
      whisper._extract_token_timestamps = (outputs, heads, frames, precision, inputIds) => {
        const cropped = frames != null && melFrames ? Math.min(frames, Math.ceil(melFrames / 2)) : frames;
        if (inputIds < 1) return extract(outputs, heads, cropped, precision, inputIds);
        const times = extract(outputs, heads, cropped, precision, inputIds - 1), [batches, length] = times.dims, data = times.data as Float32Array;
        for (let b = 0; b < batches; b++) {
          const row = data.subarray(b * length, (b + 1) * length);
          row.copyWithin(inputIds, inputIds - 1, length - 1);
          row[inputIds - 1] = 0;
        }
        return times;
      };
      return asr;
    }), failed => { if (this.asr === failed) this.asr = undefined; });
  }
  async transcribe(samples: Float32Array, language?: string) {
    return (await this.whisper())(samples, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, do_sample: false, num_beams: 1, ...(language ? { language } : {}), task: 'transcribe' });
  }
  /**
   * Whisper's own language identification (review m7): Transformers.js 4.3.2 defaults to English when
   * no language is given. Decode one step after <|startoftranscript|> over the first 30 s and take the
   * most likely language token, as the reference implementation's detect_language does.
   */
  async detectLanguage(samples: Float32Array) {
    const asr = await this.whisper(), model = asr.model as unknown as { generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> }; (inputs: Record<string, unknown>): Promise<{ logits: Tensor }> };
    const config = model.generation_config, inputs = await asr.processor(samples.subarray(0, 16000 * 30));
    const { logits } = await model({ ...inputs, decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(config.decoder_start_token_id)]), [1, 1]) });
    const scores = logits.data as Float32Array, offset = scores.length - logits.dims.at(-1)!;
    const [token] = Object.entries(config.lang_to_id).sort((a, b) => scores[offset + b[1]] - scores[offset + a[1]] || a[1] - b[1])[0];
    return token.slice(2, -2);
  }
  async classify(samples: Float32Array) {
    this.sound ??= retryable(this.load('sound', async device => pipeline('audio-classification', MODEL_IDS.sound, { device, dtype: 'q8', local_files_only: true })), failed => { if (this.sound === failed) this.sound = undefined; });
    const classifier = await this.sound;
    const maxima = new Map<string, number>();
    // Scan the whole asset; a sung passage after an instrumental intro must not be skipped.
    for (let at = 0; at < samples.length; at += 16000 * 8) {
      // AST is multilabel (independent sigmoid probabilities). The generic pipeline
      // applies a softmax, which incorrectly makes music and vocals compete.
      const inputs = await classifier.processor(samples.subarray(at, at + 16000 * 10));
      const output = await classifier.model(inputs), logits = output.logits.data as Float32Array;
      const labels = (classifier.model.config as unknown as { id2label: Record<string, string> }).id2label;
      for (let i = 0; i < logits.length; i++) {
        const score = 1 / (1 + Math.exp(-logits[i])), label = labels[i];
        maxima.set(label, Math.max(score, maxima.get(label) ?? 0));
      }
    }
    const labels = [...maxima].map(([label, score]) => ({ label, score })).sort((a, b) => b.score - a.score);
    const music = Math.max(0, ...labels.filter(r => /music|song|instrument|drum/i.test(r.label)).map(r => r.score));
    // Human vocal classes only: a singing bowl, bird or whale is not a singer.
    const speech = Math.max(0, ...labels.filter(r => /^(Speech|Male speech, man speaking|Female speech, woman speaking|Child speech, kid speaking|Conversation|Narration, monologue|Speech synthesizer)$/.test(r.label)).map(r => r.score));
    const singing = Math.max(0, ...labels.filter(r => /^(Singing|Male singing|Female singing|Child singing|Vocal music|Choir|Rapping)$/.test(r.label)).map(r => r.score));
    return { labels, isMusic: music >= 0.2, hasVocals: speech >= 0.1 || singing >= 0.05, speech, singing };
  }
  /** Voice-activity spans in seconds (speech or singing), unpadded; overlapping spans are merged. */
  async speechRegions(samples: Float32Array): Promise<Pair[]> {
    this.vad ??= retryable(this.load('speech segmentation', async device => ({ model: await AutoModelForAudioFrameClassification.from_pretrained(MODEL_IDS.vad, { device, dtype: 'fp32', local_files_only: true }), processor: await AutoProcessor.from_pretrained(MODEL_IDS.vad, { local_files_only: true }) })), failed => { if (this.vad === failed) this.vad = undefined; });
    const { model, processor } = await this.vad, spans: Pair[] = [], result: Pair[] = [];
    const post = processor as unknown as { post_process_speaker_diarization(logits: Tensor, length: number): { id: number; start: number; end: number; confidence: number }[][] };
    // 10 s windows overlap by 1 s (review m6), so a voice span cut by a window edge is also seen whole
    // by the next window; the merge below joins spans across the seam.
    for (let next = 0; next < samples.length; next += 144000) {
      // The last 10 s window ends at the file end (overlapping the previous one), so no short tail
      // reaches the model; a file under 1 s is zero-padded to the model's minimum input.
      const at = Math.max(0, Math.min(next, samples.length - 160000));
      let audio = samples.subarray(at, at + 160000);
      if (audio.length < 16000) { const padded = new Float32Array(16000); padded.set(audio); audio = padded; }
      const prediction = await model(await processor(audio));
      for (const span of post.post_process_speaker_diarization(prediction.logits, audio.length)[0]) if (span.id !== 0 && span.end - span.start >= 0.15)
        spans.push([at / 16000 + span.start, Math.min(samples.length / 16000, at / 16000 + span.end)]);
      if (at + 160000 >= samples.length) break;
    }
    for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
      const previous = result.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end); else result.push([start, end]);
    }
    return result;
  }
  /** One speaker vector per transcript segment: its audio from 0.1 s before it to 0.1 s after it (at most 5.1 s), extended
   * to 0.4 s where the audio allows. */
  async speakerVectors(samples: Float32Array, transcript: Transcript) {
    // T19q round S2 (T19's S1 unchanged): WeSpeaker ResNet34 (fp32), 80-bin fbank in, a 256-d embedding out as last_hidden_state.
    this.speaker ??= retryable(this.load('speakers', async device => ({ model: await AutoModel.from_pretrained(MODEL_IDS.speaker, { device, dtype: 'fp32', local_files_only: true }), processor: await AutoProcessor.from_pretrained(MODEL_IDS.speaker, { local_files_only: true }) })), failed => { if (this.speaker === failed) this.speaker = undefined; });
    const { model, processor } = await this.speaker, vectors: number[][] = [];
    for (const segment of transcript.segments) {
      const start = Math.max(0, Math.floor((segment.start - 0.1) * 16000)), end = Math.min(samples.length, Math.ceil(Math.min(segment.end + 0.1, segment.start + 5) * 16000));
      const clip = samples.slice(start, Math.max(start + 6400, end));
      const output = await model(await processor(clip));
      vectors.push(Array.from(output.last_hidden_state.data as Float32Array));
    }
    return vectors;
  }
  async diarize(samples: Float32Array, transcript: Transcript) {
    if (!transcript.segments.length) return;
    // T19q round S2: offline average linkage; the cosine-distance threshold is T19's V-SPK grid pick (.60).
    const labels = averageLinkage(await this.speakerVectors(samples, transcript), 0.6);
    transcript.segments.forEach((segment, i) => { segment.speaker = labels[i]; });
  }
  /** wav2vec2 CTC log-probabilities for one 16 kHz window, with the vocabulary the aligner was trained on. */
  async ctcLogProbs(samples: Float32Array) {
    this.aligner ??= retryable(this.load('word alignment', async device => {
      const model = await AutoModelForCTC.from_pretrained(MODEL_IDS.aligner, { dtype: 'q8', device, local_files_only: true });
      const vocab = new Map(Object.entries(JSON.parse(await this.modelText(MODEL_IDS.aligner, 'vocab.json')) as Record<string, number>));
      const blank = vocab.get('<pad>'), delimiter = vocab.get('|');
      if (blank === undefined || delimiter === undefined) throw new AnalysisError('TRANSCRIPTION_FAILED', 'The word aligner vocabulary has no blank or word delimiter.');
      return { model: model as unknown as PreTrainedModel, vocab, blank, delimiter };
    }), failed => { if (this.aligner === failed) this.aligner = undefined; });
    const { model, vocab, blank, delimiter } = await this.aligner;
    // preprocessor_config.json sets do_normalize: the window goes in at zero mean and unit variance.
    const input = Float32Array.from(samples), count = input.length || 1;
    let total = 0; for (const v of input) total += v;
    const mean = total / count;
    let spread = 0; for (const v of input) spread += (v - mean) ** 2;
    const scale = 1 / Math.sqrt(spread / count + 1e-7);
    for (let i = 0; i < input.length; i++) input[i] = (input[i] - mean) * scale;
    const run = model as unknown as (inputs: Record<string, Tensor>) => Promise<{ logits: Tensor }>;
    const { logits } = await run({ input_values: new Tensor('float32', input, [1, input.length]), attention_mask: new Tensor('int64', new BigInt64Array(input.length).fill(1n), [1, input.length]) });
    const [, frames, classes] = logits.dims, data = logits.data as Float32Array;
    // Per-frame log-softmax in place: the Viterbi pass in align.ts sums log-probabilities.
    for (let f = 0; f < frames; f++) {
      const at = f * classes;
      let max = -Infinity; for (let c = 0; c < classes; c++) if (data[at + c] > max) max = data[at + c];
      let sum = 0; for (let c = 0; c < classes; c++) sum += Math.exp(data[at + c] - max);
      const offset = max + Math.log(sum);
      for (let c = 0; c < classes; c++) data[at + c] -= offset;
    }
    return { logProbs: data, frames, classes, vocab, blank, delimiter };
  }
  /** T19q T5: Qwen3-ASR recognizer (English only). Whisper is released before loading. Its sessions always run on the
   * wasm EP, so it reports that backend under the transcription label itself, as BeatThis does for beats. */
  private qwenRecognizer() {
    return this.qwen ??= retryable((async () => {
      await this.releaseWhisper();
      const { loadQwen3Asr } = await import('./qwen-asr');
      const qwen = await loadQwen3Asr({ modelId: MODEL_IDS.qwen3Asr, wasm: this.options.wasm });
      this.backends.transcription = 'wasm';
      return qwen;
    })(), failed => { if (this.qwen === failed) this.qwen = undefined; });
  }
  /** ≤ 30 s windows cut at the latest VAD gap (midpoint) in [cursor + 1 s, cursor + 30 s]; single long span cut at 30 s. */
  private qwenWindows(voice: Pair[], duration: number): [number, number][] {
    const CAP = 30, MIN_IN = 1;
    const windows: [number, number][] = [];
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
  /** T19q T5 English path: Qwen3-ASR per ≤ 30 s window; word times from the T19a aligner with char-count interpolation
   *  for unplaceable words, and whole-window char-count spread when alignment yields no path. Chunks are in local time. */
  async qwenTranscribe(samples: Float32Array, voice: Pair[], duration: number) {
    const qwen = await this.qwenRecognizer();
    const windows = this.qwenWindows(voice, duration);
    const chunks: { text: string; timestamp: [number | null, number | null] }[] = [];
    for (const [winStart, winEnd] of windows) {
      const winDur = winEnd - winStart;
      if (winDur < 0.1) continue;
      const winSamples = samples.subarray(Math.max(0, Math.round(winStart * 16000)), Math.min(samples.length, Math.round(winEnd * 16000)));
      if (winSamples.length < 320) continue;
      const { text } = await qwen.decode(winSamples, 'en');
      const words = text.split(/\s+/).map(w => w.trim()).filter(Boolean);
      if (!words.length) continue;
      const { logProbs, frames, classes, vocab, blank, delimiter } = await this.ctcLogProbs(winSamples);
      const spellable = words.map((w, i) => [spell(w, vocab), i] as const).filter(([tokens]) => tokens.length);
      const spans = spellable.length ? ctcAlign(logProbs, frames, classes, spellable.map(([t]) => t), blank, delimiter) : null;
      const anchors: ([number, number] | null)[] = words.map(() => null);
      const lens = words.map(w => Math.max(1, w.length));
      if (spans) spans.forEach(([s, e], i) => { anchors[spellable[i][1]] = [s * CTC_FRAME, e * CTC_FRAME]; });
      if (!spans || anchors.every(a => a === null)) {
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
      for (let k = 0; k < words.length; k++) {
        const [s, e] = anchors[k]!;
        chunks.push({ text: words[k], timestamp: [winStart + s, winStart + e] });
      }
    }
    return { chunks };
  }
  async embed(texts: string[]) {
    if (!texts.length) return [];
    this.embedding ??= retryable(this.load('embedding', async device => pipeline('feature-extraction', MODEL_IDS.embedding, { device, dtype: 'q8', local_files_only: true })), failed => { if (this.embedding === failed) this.embedding = undefined; });
    return (await (await this.embedding)(texts, { pooling: 'mean', normalize: true })).tolist() as number[][];
  }
  async caption(frame: Frame) {
    this.vision ??= retryable(this.load('vision', async device => {
      const model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_IDS.vision, { device, dtype: { vision_encoder: 'fp32', embed_tokens: 'fp32', encoder_model: 'q4', decoder_model_merged: 'q4' }, local_files_only: true }) as Florence2ForConditionalGeneration;
      const processor = await AutoProcessor.from_pretrained(MODEL_IDS.vision, { local_files_only: true }) as Florence2Processor;
      return { model, processor };
    }), failed => { if (this.vision === failed) this.vision = undefined; });
    const { model, processor } = await this.vision!, image = new RawImage(frame.data, frame.width, frame.height, 4);
    const task = '<MORE_DETAILED_CAPTION>', inputs = await processor(image, processor.construct_prompts(task));
    const generated = await model.generate({ ...inputs, max_new_tokens: 128, do_sample: false, num_beams: 1 });
    const decoded = processor.batch_decode(generated as Tensor, { skip_special_tokens: false })[0];
    const result = processor.post_process_generation(decoded, task, image.size)[task];
    if (typeof result !== 'string' || !result.trim()) throw new AnalysisError('VISUAL_ANALYSIS_FAILED', 'The local vision model produced no description.');
    return result.trim();
  }
  private clipModels() {
    this.clip ??= retryable(this.load('clip', async device => ({
      vision: await CLIPVisionModelWithProjection.from_pretrained(MODEL_IDS.clip, { device, dtype: 'q8', local_files_only: true }),
      text: await CLIPTextModelWithProjection.from_pretrained(MODEL_IDS.clip, { device, dtype: 'q8', local_files_only: true }),
      processor: await AutoProcessor.from_pretrained(MODEL_IDS.clip, { local_files_only: true }),
      tokenizer: await AutoTokenizer.from_pretrained(MODEL_IDS.clip, { local_files_only: true })
    })), failed => { if (this.clip === failed) this.clip = undefined; });
    return this.clip;
  }
  /** T19q round F8 (T19's F2): the L2-normalised CLIP embedding of one display frame. */
  async imageVector(frame: Frame) {
    const { vision, processor } = await this.clipModels();
    const { image_embeds } = await vision(await processor(new RawImage(frame.data, frame.width, frame.height, 4)));
    return unit(Array.from(image_embeds.data as Float32Array));
  }
  /** T19q round F8 (T19's F2): L2-normalised CLIP text embeddings, one per text. */
  async clipText(texts: string[]) {
    if (!texts.length) return [];
    const { text, tokenizer } = await this.clipModels();
    const { text_embeds } = await text(tokenizer(texts, { padding: true, truncation: true })), width = text_embeds.dims[1], data = text_embeds.data as Float32Array;
    return texts.map((_, i) => unit(Array.from(data.subarray(i * width, (i + 1) * width))));
  }
  async dispose() {
    for (const pending of [this.asr, this.sound, this.embedding]) if (pending) await (await pending).dispose();
    if (this.clip) { const { vision, text } = await this.clip; await vision.dispose(); await text.dispose(); }
    if (this.vision) await (await this.vision).model.dispose();
    if (this.vad) await (await this.vad).model.dispose();
    if (this.speaker) await (await this.speaker).model.dispose();
    if (this.aligner) await (await this.aligner).model.dispose();
    for (const pending of this.beatThis.values()) await (await pending).session.release();
    this.beatThis.clear();
    if (this.qwen) await (await this.qwen).dispose();
    this.asr = undefined; this.sound = undefined; this.embedding = undefined; this.vision = undefined; this.vad = undefined; this.speaker = undefined; this.aligner = undefined; this.clip = undefined; this.qwen = undefined;
  }
}
