// SPDX-License-Identifier: AGPL-3.0-only
// The audio source worker's readers (source.worker.ts): native-rate PCM of a clip's original, BLOCK_S blocks with PADDING_S
// either side. WebCodecs through Mediabunny first. A container Mediabunny cannot open (AVI, raw AC-3 / E-AC-3), a track it
// cannot decode, or every track under the forced WASM switch goes through `whole` (T14's WASM decode) once, whole, as the
// base preview did. Only a container Mediabunny reads with no audio track has no sound (null); a failed decode rejects, so
// the export can report it (T16's AUDIO_FAILED), and a rejected open is not kept, so the next request opens again.
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import type { RawAudio } from '../media/decode';
import { BLOCK_S, PADDING_S } from './mix';

/** Native-rate PCM: frame i of data is source frame `first + i` at `rate`. */
export type Native = { rate: number; first: number; data: Float32Array[] };
export type Reader = { block(k: number): Promise<Native | null>; dispose(): void };

export async function openReader(blob: Blob, forceWasm: boolean, whole: (blob: Blob) => Promise<RawAudio>): Promise<Reader | null> {
  const wholeReader = async (): Promise<Reader> => { const raw = await whole(blob), all = { rate: raw.sampleRate, first: 0, data: raw.data }; return { block: async () => all, dispose() {} }; };
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }), track = await input.getPrimaryAudioTrack().catch(() => undefined); // undefined: not opened
  if (track === null) { input.dispose(); return null; }
  if (track === undefined || forceWasm || !await track.canDecode()) { input.dispose(); return wholeReader(); }
  const sink = new AudioSampleSink(track), rate = track.sampleRate, channels = track.numberOfChannels;
  return {
    async block(k) {
      const from = Math.max(0, k * BLOCK_S - PADDING_S), to = (k + 1) * BLOCK_S + PADDING_S, first = Math.floor(from * rate), length = Math.ceil(to * rate) - first;
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      for await (const sample of sink.samples(from, to)) {
        try {
          const at = Math.round(sample.timestamp * rate) - first, plane = new Float32Array(sample.numberOfFrames);
          for (let c = 0; c < channels; c++) {
            sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            const skip = Math.max(0, -at); // priming before the window (or before t = 0) is dropped, as decodeAudio does
            if (skip < plane.length && at + skip < length) data[c].set(plane.subarray(skip, Math.min(plane.length, length - at)), at + skip);
          }
        } finally { sample.close(); }
      }
      return { rate, first, data };
    },
    dispose() { input.dispose(); },
  };
}
/** The reader kept for `key`, opened once; an open that rejects is dropped from `cache`. */
export function cachedReader(cache: Map<string, Promise<Reader | null>>, key: string, open: () => Promise<Reader | null>): Promise<Reader | null> {
  const held = cache.get(key);
  if (held) return held;
  const made = open();
  cache.set(key, made);
  made.catch(() => { if (cache.get(key) === made) cache.delete(key); });
  return made;
}
