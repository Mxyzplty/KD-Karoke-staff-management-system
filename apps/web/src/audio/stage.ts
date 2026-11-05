// SPDX-License-Identifier: AGPL-3.0-only
// The limited mix of a range as the export renders it (export/audio.ts is T16a's stage over the same mix and limiter;
// this is its reference pass, for the oracle and the tests): the mix (mix.ts: gain law, speed / remap, keep pitch)
// through the always-on output limiter (limiter.ts). Ranges over
// LONG_MS mix in CHUNK_MS chunks (findings §7), each rendered 5 ms past its end for the limiter's lookahead, the limiter's
// gain carried across; in parity mode Xapp's keyframe range rule applies per chunk. Failures propagate as thrown (the
// AUDIO_FAILED class and its message are T16's).
import type { ProjectDocument } from '../store/model';
import type { GainMode } from './gain';
import { Limiter } from './limiter';
import { MIX_RATE, PER_MS, mixFrames } from './mix';
import type { AudioSource, Stereo } from './mix';

export const LONG_MS = 5 * 60_000, CHUNK_MS = 120_000;
export type AudioStageInput = { doc: ProjectDocument; fromMs: number; toMs: number; source: AudioSource; mode?: GainMode };
export type AudioChunk = { startFrame: number; channels: Stereo };
export type StagePcm = { sampleRate: typeof MIX_RATE; channels: Stereo };

/** The range's frames on the mix grid: [round(from × 48), round(to × 48)). */
export const rangeFrames = (fromMs: number, toMs: number) => { const start = Math.round(fromMs * PER_MS); return { start, frames: Math.max(0, Math.round(toMs * PER_MS) - start) }; };
/** The limited mix of the range, chunk by chunk (one chunk up to LONG_MS). */
export async function* audioChunks(input: AudioStageInput, chunkMs = input.toMs - input.fromMs > LONG_MS ? CHUNK_MS : Infinity): AsyncGenerator<AudioChunk> {
  const { start, frames } = rangeFrames(input.fromMs, input.toMs), limiter = new Limiter(MIX_RATE), step = Number.isFinite(chunkMs) ? Math.round(chunkMs * PER_MS) : frames;
  for (let at = start; at < start + frames; at += step) {
    const n = Math.min(step, start + frames - at), [L, R] = await mixFrames(input.doc, at, n + limiter.look, { source: input.source, mode: input.mode, end: at + n });
    limiter.process(L, R, n);
    yield { startFrame: at, channels: [L.slice(0, n), R.slice(0, n)] };
  }
}
/** The whole range as one buffer (tests, short exports). */
export async function renderAudio(input: AudioStageInput): Promise<StagePcm> {
  const { start, frames } = rangeFrames(input.fromMs, input.toMs), channels: Stereo = [new Float32Array(frames), new Float32Array(frames)];
  for await (const c of audioChunks(input)) { channels[0].set(c.channels[0], c.startFrame - start); channels[1].set(c.channels[1], c.startFrame - start); }
  return { sampleRate: MIX_RATE, channels };
}
