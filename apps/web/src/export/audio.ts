// SPDX-License-Identifier: AGPL-3.0-only
// The export's audio stage: one interface (project + time range → 48 kHz stereo PCM), called in 120 s chunks above 5 min
// (master plan §1b, as Xapp). T13 fills it (audio/): the mix with its gain law (track gain × volume², mute, solo, hidden
// tracks, keyframed volume), speed, remap and keep pitch (mix.ts), through the always-on output limiter (limiter.ts), over
// the originals decoded in 8 s blocks by the export's own source worker (source.ts). A call that continues the previous
// one (the pipeline's next chunk) keeps the grid frame and the limiter's gain, so the chunks join as one pass
// (audio/stage.ts audioChunks).
import type { ProjectStore } from '../store/database';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { Limiter } from '../audio/limiter';
import { mixFrames, PER_MS } from '../audio/mix';
import type { AudioSource } from '../audio/mix';
import { sourcePool } from '../audio/source';
import { mediaError } from '../media/codes';
import { prop } from '../timeline/properties';
import { exportedMedia } from './prep';

export const SAMPLE_RATE = 48000;
export const CHUNK_S = 120;
export const CHUNKED_ABOVE_S = 300;
/** Planar stereo PCM at 48 kHz: data[0] left, data[1] right, same length. */
export type Pcm = { sampleRate: typeof SAMPLE_RATE; channels: 2; data: [Float32Array, Float32Array] };
/** Timeline ms [startMs, startMs + frames / 48 kHz) of `doc` (unshifted project time) → PCM of exactly `frames` samples. */
export type AudioStage = (doc: ProjectDocument, range: { startMs: number; frames: number }) => Promise<Pcm>;

const AUDIBLE = new Set(['video', 'audio']);
/** The stored static volume: the property's default value, else details.volume, else 1 (the remux check, remux.ts). */
export function storedVolume(item: RecordData): number {
  const p = prop(item, 'volume'), v = p ? p.defaultValue : item.details?.volume;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 1;
}

/** A source whose failures read as the export reports them: "no audio track" is silence; a video file that no demuxer
 *  opens (libav: "Could not open source file"; T14's demux pattern, media/codes.ts) is UNSUPPORTED_INPUT, as on the video
 *  path (media/decode.ts), the audio stage only meets it first. An audio file that fails stays an audio failure. */
export function exportSource(source: AudioSource): AudioSource {
  return async (item, startS, endS) => {
    try { return await source(item, startS, endS); }
    catch (e) {
      const message = (e as Error).message;
      if (/no audio track/i.test(message)) return null;
      if (item.type === 'video' && /could not open source file|moov|invalid data|unsupported or unrecognizable format|invalid container/i.test(message)) throw mediaError('UNSUPPORTED_INPUT', `This file could not be opened: ${message.replace(/^The audio could not be decoded: /, '')}`);
      throw e;
    }
  };
}
/** The stage over `source`: each call the limited mix of its range. */
export function mixStage(source: AudioSource): AudioStage {
  let limiter = new Limiter(SAMPLE_RATE), next: number | null = null;
  return async (doc, { startMs, frames }) => {
    const at = startMs * PER_MS, start = next !== null && Math.abs(at - next) < 1 ? next : Math.round(at);
    if (start !== next) limiter = new Limiter(SAMPLE_RATE);
    const [left, right] = await mixFrames(doc, start, frames + limiter.look, { source, end: start + frames });
    limiter.process(left, right, frames);
    next = start + frames;
    return { sampleRate: SAMPLE_RATE, channels: 2, data: [left.slice(0, frames), right.slice(0, frames)] };
  };
}
/** The export's stage over `store`'s originals; release(keep) drops the decoded blocks and readers of other assets, close()
 *  ends the export's source worker. */
export function exportMix(store: ProjectStore, assets: Map<string, Asset>, options: { forceWasm?: boolean } = {}): AudioStage & { release(keep: Set<string>): void; close(): void } {
  const pool = sourcePool(() => !!options.forceWasm);
  return Object.assign(mixStage(exportSource(pool.source(store, id => assets.get(id)))), { release: pool.release, close: pool.close });
}
/** Whether the export writes an audio stream: any exported video or audio item (§44.8; even when silent). */
export const hasAudioStream = (doc: ProjectDocument) => exportedMedia(doc).some(i => AUDIBLE.has(i.type));
