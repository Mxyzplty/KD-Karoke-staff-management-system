// SPDX-License-Identifier: AGPL-3.0-only
// T21 hosted speech-to-text (D23): ElevenLabs Speech to Text with the user's own key. It replaces the local transcription
// job only. Words, word times and speakers are mapped to the T19 transcript shape. Times are source seconds on T19's grid;
// speakers are numbered in order of first appearance.
import { grid } from '../analysis/types';
import type { Transcript } from '../analysis/types';
import type { ProjectStore } from '../store/database';
import { countRequest } from './meter';
import { ELEVENLABS, SPEECH_KEY, readProviders } from './providers';
import { getSecret } from './secrets';

type Token = { text: string; start?: number; end?: number; type: 'word' | 'spacing' | 'audio_event'; speaker_id?: string | null };
export type SpeechResponse = { language_code?: string; text?: string; words?: Token[] };
const SENTENCE_END = /[.!?。！？]["')\]]?$/, GAP_S = 1;
export function toTranscript(response: SpeechResponse, duration: number): Transcript {
  const speakers = new Map<string, number>(), segments: Transcript['segments'] = [];
  const speakerOf = (id: string) => { if (!speakers.has(id)) speakers.set(id, speakers.size); return speakers.get(id)!; };
  let open: Transcript['segments'][number] | undefined, pending = '';
  for (const token of response.words ?? []) {
    if (token.type === 'spacing') { pending = token.text; continue; }
    if (token.type !== 'word') continue;
    const start = grid(token.start ?? 0), end = grid(token.end ?? token.start ?? 0), speaker = speakerOf(token.speaker_id ?? 'speaker_0');
    if (!open || open.speaker !== speaker || SENTENCE_END.test(open.text) || start - open.end >= GAP_S) {
      open = { id: segments.length, start, end, text: token.text, speaker, words: [] }; segments.push(open);
    } else { open.text += pending + token.text; open.end = end; }
    open.words.push({ word: token.text, start, end }); pending = '';
  }
  const language = response.language_code ?? 'und';
  return { language, languages: [language], total_duration: grid(duration), segments };
}
/** 16 kHz mono samples as the 16-bit little-endian PCM the service reads without a container. */
const pcm16 = (samples: Float32Array) => {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((s, i) => out.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
  return new Blob([out.buffer]);
};
export async function transcribeHosted(key: string, samples: Float32Array, signal?: AbortSignal): Promise<Transcript> {
  const form = new FormData();
  form.set('model_id', 'scribe_v2'); form.set('diarize', 'true'); form.set('timestamps_granularity', 'word'); form.set('file_format', 'pcm_s16le_16');
  form.set('file', pcm16(samples), 'audio.pcm');
  countRequest('elevenlabs');
  const response = await fetch(`${ELEVENLABS.origin}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal });
  if (!response.ok) throw new Error(`ElevenLabs answered ${response.status}.`);
  return toTranscript(await response.json(), samples.length / 16000);
}
/** The hosted transcriber when the user chose it and its key is stored; else undefined and the local models do the job. */
export async function hostedSpeech(store: Pick<ProjectStore, 'row'>) {
  if ((await readProviders(store)).speech !== 'elevenlabs') return undefined;
  const key = await getSecret(SPEECH_KEY, ELEVENLABS.origin);
  return key ? (samples: Float32Array, signal?: AbortSignal) => transcribeHosted(key, samples, signal) : undefined;
}
