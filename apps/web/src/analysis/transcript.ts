// SPDX-License-Identifier: AGPL-3.0-only
import { cosine, median } from './audio';
import { AnalysisError, grid, type Pair, type Transcript, type Word } from './types';

/** Independent acoustic speaker baseline (log spectral bands, no OT-1 model or labels); the engine's WeSpeaker diarize() replaces it. */
function voiceFeatures(samples: Float32Array, rate: number, words: Word[]) {
  const vectors: number[][] = [], size = Math.round(rate * 0.025), hop = Math.round(rate * 0.02);
  for (const word of words) for (let at = Math.round(word.start * rate); at + size < Math.min(samples.length, word.end * rate); at += hop) {
    let power = 0;
    for (let k = 0; k < size; k++) power += samples[at + k] ** 2;
    if (power / size < 1e-5) continue;
    const bands: number[] = [];
    for (let b = 0; b < 16; b++) {
      const frequency = 100 * (40 ** (b / 15)), omega = 2 * Math.PI * frequency / rate;
      let re = 0, im = 0;
      for (let k = 0; k < size; k++) { const x = samples[at + k] * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / (size - 1))); re += x * Math.cos(omega * k); im += x * Math.sin(omega * k); }
      bands.push(Math.log(1e-8 + (re * re + im * im) / power));
    }
    const mean = bands.reduce((a, b) => a + b, 0) / bands.length;
    vectors.push(bands.map(v => v - mean));
  }
  return Array.from({ length: 16 }, (_, k) => median(vectors.map(v => v[k])));
}
/**
 * Whisper's DTW word spans tile the audio, so a word after a pause starts where the previous word
 * ended, and a word before a pause ends where the next word starts. Move the start to the voice
 * onset: past any voice-activity gap inside the word (to the last voice span that begins within it),
 * then to the first 10 ms frame at or above -20 dB of the word's loudest frame (a fixed a priori
 * threshold, not fitted to any truth set). The end is refined symmetrically (review m1): to the end
 * of the first voice span that ends within the word, then to the last frame at or above -20 dB.
 */
function voicedSpan(start: number, end: number, samples: Float32Array, voice: Pair[] | undefined): Pair {
  const onset = voice?.filter(([s]) => s > start && s < end - 0.02).at(-1);
  if (onset) start = onset[0];
  const offset = voice?.find(([, e]) => e > start + 0.02 && e < end);
  if (offset) end = offset[1];
  const rate = 16000, hop = rate / 100, rms: number[] = [];
  for (let at = Math.round(start * rate); at + hop <= Math.min(samples.length, end * rate); at += hop) {
    let power = 0;
    for (let k = 0; k < hop; k++) power += samples[at + k] ** 2;
    rms.push(Math.sqrt(power / hop));
  }
  const peak = Math.max(0, ...rms), first = rms.findIndex(v => v >= peak * 0.1);
  let last = rms.length - 1;
  while (last >= 0 && rms[last] < peak * 0.1) last--;
  const from = peak > 0 && first > 0 ? Math.min(start + first / 100, end - 0.02) : start;
  return [from, peak > 0 && last >= 0 && last < rms.length - 1 ? Math.max(start + (last + 1) / 100, from + 0.02) : end];
}
/** `voice` (optional): voice-activity spans; words whose midpoint lies over 0.25 s outside every span are dropped. */
export function makeTranscript(chunks: { text: string; timestamp: [number | null, number | null] }[], samples: Float32Array, duration: number, language: string, voice?: Pair[]): Transcript {
  const words: Word[] = [];
  for (const chunk of chunks) {
    if (!chunk.text.trim()) continue;
    const [start, end] = chunk.timestamp;
    if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new AnalysisError('TRANSCRIPTION_FAILED', 'The local ASR returned an invalid word timestamp.');
    if (start >= duration) continue;
    const middle = (start + end) / 2;
    if (voice && !voice.some(([s, e]) => middle >= s - 0.25 && middle <= e + 0.25)) continue;
    const from = Math.max(0, start), to = Math.min(duration, end), [voicedFrom, voicedTo] = to > from ? voicedSpan(from, to, samples, voice) : [from, to];
    const word = { word: chunk.text.trim(), start: grid(voicedFrom), end: grid(voicedTo) };
    // M3: Whisper's 30 s windows overlap by 5 s each side. When their merge re-emits audio already
    // transcribed, the words jump back in time; the later window decoded that audio outside its
    // stride (with more context), so it wins: kept words that start after it, or with it and overlap
    // it, are dropped, and a kept word running into it ends where it starts. The transcript stays in
    // time order without overlap.
    while (words.length && (words.at(-1)!.start > word.start || (words.at(-1)!.start === word.start && words.at(-1)!.end > word.start))) words.pop();
    const last = words.at(-1);
    if (last && last.end > word.start) last.end = word.start;
    words.push(word);
  }
  const groups: Word[][] = [];
  for (const word of words) {
    const last = groups.at(-1), previous = last?.at(-1);
    if (!last || (previous && (word.start - previous.end > 0.45 || /[.!?]$/.test(previous.word)))) groups.push([word]); else last.push(word);
  }
  // Collapsed DTW timestamps are a known silence-hallucination failure. Reject
  // the entire sentence when most words have no temporal support.
  const supported = groups.filter(group => group.filter(w => w.end > w.start).length > group.length / 2);
  const centroids: { vector: number[]; count: number }[] = [];
  const segments = supported.map((group, id) => {
    const vector = voiceFeatures(samples, 16000, group);
    let speaker = -1, similarity = 0.88;
    centroids.forEach((c, index) => { const score = cosine(vector, c.vector); if (score > similarity) { similarity = score; speaker = index; } });
    if (speaker < 0) { speaker = centroids.length; centroids.push({ vector, count: 1 }); }
    else { const c = centroids[speaker]; c.vector = c.vector.map((v, i) => (v * c.count + vector[i]) / (c.count + 1)); c.count++; }
    return { id, start: group[0].start, end: group.at(-1)!.end, text: group.map(w => w.word).join(' '), speaker, words: group };
  });
  // One grid step past the media end, rounded once so the sum stays on the 20 ms grid (review m8).
  return { language, languages: [language], total_duration: grid(duration + 0.02), segments };
}
