// SPDX-License-Identifier: AGPL-3.0-only
import { resample } from './audio';
import { ctcAlign, spell, CTC_FRAME } from './align';
import { detectBeats } from './beats';
import { learnedBeats } from './beatthis';
import { makeTranscript } from './transcript';
import { LocalModels, type ModelOptions } from './models';
import { FootageIndex, SEARCH_THRESHOLDS, VISUAL_THRESHOLD } from './search';
import { AnalysisError, grid, type AssetInput, type Frame, type Pcm, type Transcript, type TranscriptionResult, type VisualAnalysis } from './types';
export { syncOffset } from './sync';
export { snapCuts, planSilenceRemoval, readBeats } from './helpers';
export * from './types';

export class AnalysisEngine {
  readonly models: LocalModels;
  readonly footage: FootageIndex;
  constructor(options: ModelOptions) { this.models = new LocalModels(options); this.footage = new FootageIndex(texts => this.models.embed(texts), SEARCH_THRESHOLDS, { embed: texts => this.models.clipText(texts), medium: VISUAL_THRESHOLD }); }
  async transcribe(pcm: Pcm, language?: string): Promise<TranscriptionResult> {
    const audio = resample(pcm), duration = pcm.data[0].length / pcm.sampleRate;
    const classification = await this.models.classify(audio);
    if (classification.isMusic && !classification.hasVocals) return { status: 'skipped', transcript: null, reason: 'MUSIC_WITHOUT_VOCALS' };
    // Speech and singing take the same path. Voice activity bounds the decode and filters its words:
    // Whisper invents text over long stretches without a voice (e.g. a closing phrase over a music
    // intro). Decoding continuously, not region by region, keeps the language-model context.
    const voice = await this.models.speechRegions(audio);
    const chunks: { text: string; timestamp: [number | null, number | null] }[] = [];
    if (voice.length) {
      const start = Math.max(0, voice[0][0] - 0.25), end = Math.min(duration, voice.at(-1)![1] + 0.25), voiced = audio.subarray(Math.floor(start * 16000), Math.ceil(end * 16000));
      // Without a requested language, Whisper identifies it on the voiced audio.
      if (!language) language = await this.models.detectLanguage(voiced);
      const output = await this.models.transcribe(voiced, language);
      for (const chunk of output.chunks ?? []) chunks.push({ text: chunk.text, timestamp: [chunk.timestamp[0] === null ? null : start + chunk.timestamp[0], chunk.timestamp[1] === null ? null : start + chunk.timestamp[1]] });
    }
    // With no voice at all there is nothing to identify; the empty transcript keeps the 'en' default.
    const transcript = makeTranscript(chunks, audio, duration, language || 'en', voice);
    await this.realign(audio, transcript);
    await this.models.diarize(audio, transcript);
    return { status: 'complete', transcript };
  }
  /** TR-P03: re-time each segment's words with the CTC aligner. ASR times stand wherever it cannot align. */
  private async realign(audio: Float32Array, transcript: Transcript) {
    const rate = 16000, pad = 0.5, duration = audio.length / rate;
    for (const [index, segment] of transcript.segments.entries()) {
      const words = segment.words;
      if (!words.length) continue;
      // One alignment per segment, over a window padded half a second each side and clamped to the file
      // and to its neighbours (M3: the previous segment as already re-timed, the next as transcribed),
      // so no word can align into another segment's audio and the transcript stays in time order.
      const previous = transcript.segments[index - 1], next = transcript.segments[index + 1];
      const from = Math.max(0, previous?.end ?? 0, grid(Math.min(...words.map(w => w.start)) - pad));
      const to = Math.min(duration, next?.start ?? duration, grid(Math.max(...words.map(w => w.end)) + pad));
      if (to - from < 0.1) continue;
      const { logProbs, frames, classes, vocab, blank, delimiter } = await this.models.ctcLogProbs(audio.subarray(Math.round(from * rate), Math.round(to * rate)));
      // Unspellable words keep their ASR times and take no part in the alignment.
      const spellable = words.map((w, i) => [spell(w.word, vocab), i] as const).filter(([tokens]) => tokens.length);
      const spans = ctcAlign(logProbs, frames, classes, spellable.map(([tokens]) => tokens), blank, delimiter);
      if (!spans) continue;
      const aligned = new Set<number>();
      spans.forEach(([startFrame, endFrame], n) => {
        const word = words[spellable[n][1]];
        const start = grid(from + startFrame * CTC_FRAME), end = grid(from + endFrame * CTC_FRAME);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) { word.start = start; word.end = end; aligned.add(spellable[n][1]); }
      });
      // M3: a word that kept its ASR times (unspellable, e.g. digits) is clamped between its re-timed neighbours.
      words.forEach((word, i) => {
        if (aligned.has(i)) return;
        const after = i ? words[i - 1].end : from, before = words.find((w, k) => k > i && aligned.has(k))?.start ?? to;
        word.start = grid(Math.min(Math.max(word.start, after), before));
        word.end = grid(Math.min(Math.max(word.end, word.start), before));
      });
      // The 0.45 s sentence grouping is not re-run; only the segment's own bounds follow its words.
      segment.start = Math.min(...words.map(w => w.start));
      segment.end = Math.max(...words.map(w => w.end));
    }
  }
  async beats(pcm: Pcm, asset: Pick<AssetInput, 'type' | 'filename'>) {
    if (asset.type !== 'audio') return detectBeats(pcm, asset.type, false, asset.filename);
    const classification = await this.models.classify(resample(pcm));
    return classification.isMusic ? this.musicBeats(pcm, asset.filename) : detectBeats(pcm, asset.type, false, asset.filename);
  }
  /** Beats of audio already classified as music: the deterministic tracker, with BeatThis's beats on dense music (T19q B4).
   * `beatModel` names another BeatThis export; only the scorer's Groove validation passes one. */
  async musicBeats(pcm: Pcm, name = 'audio', beatModel?: string) {
    const learned = await learnedBeats(pcm, (chunk, frames) => this.models.beatLogits(chunk, frames, beatModel));
    return detectBeats(pcm, 'audio', true, name, learned);
  }
  async describe(frames: Frame[], duration: number): Promise<VisualAnalysis> {
    if (!frames.length || !Number.isFinite(duration) || duration <= 0) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'Visual analysis needs display frames and a positive duration.');
    const ordered = frames.slice().sort((a, b) => a.timestamp - b.timestamp);
    if (ordered.some(f => f.width < 1 || f.height < 1 || f.data.length !== f.width * f.height * 4 || !Number.isFinite(f.timestamp) || f.timestamp < 0 || f.timestamp >= duration)) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'Invalid display RGBA frame or timestamp.');
    const segments: VisualAnalysis['segments'] = [];
    for (let i = 0; i < ordered.length; i++) {
      const start = i === 0 ? 0 : (ordered[i - 1].timestamp + ordered[i].timestamp) / 2;
      const end = i === ordered.length - 1 ? duration : (ordered[i].timestamp + ordered[i + 1].timestamp) / 2;
      const description = await this.models.caption(ordered[i]);
      const previous = segments.at(-1);
      if (previous?.description === description) previous.end = end; else segments.push({ start, end, description });
    }
    const counts = new Map<string, number>();
    for (const s of segments) for (const token of s.description.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []) if (!['with', 'there', 'this', 'that', 'image', 'picture', 'front', 'background'].includes(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([tag]) => tag);
    const { width, height } = ordered[0];
    return this.attachImageVectors(ordered, { width, height, aspectRatio: width / height, tags, summary: [...new Set(segments.map(s => s.description))].join(' '), segments });
  }
  /** T19q round F8 (T19's F2): each description segment carries the CLIP embedding of its first frame. */
  async attachImageVectors(frames: Frame[], analysis: VisualAnalysis) {
    const ordered = frames.slice().sort((a, b) => a.timestamp - b.timestamp);
    for (const segment of analysis.segments) segment.vector = await this.models.imageVector(ordered.find(f => f.timestamp >= segment.start)!);
    return analysis;
  }
}
