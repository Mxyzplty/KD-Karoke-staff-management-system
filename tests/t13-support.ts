// SPDX-License-Identifier: AGPL-3.0-only
// T13 audio test support: plain documents, synthetic 48 kHz sources, signal measures. Expected values in the tests come from the
// written spec (T13 ticket, findings §7 / §29 / §30, agent tool results §10), never from running the audio code.
import { spawnSync } from 'node:child_process';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import type { AudioSource, SourcePcm } from '../apps/web/src/audio/mix';
import type { Keyframe } from '../apps/web/src/timeline/properties';

export const FS = 48000;
export const mkTrack = (id: string, extra: RecordData = {}): RecordData => ({ id, name: id, kind: 'audio', muted: false, solo: false, locked: false, hidden: false, volume: 1, ...extra });
export const kf = (time: number, value: unknown, easing: unknown = 'linear', extra: RecordData = {}): Keyframe => ({ id: `k${time}_${String(value)}`, time, value, easing, ...extra }) as Keyframe;
export const mkClip = (id: string, trackId: string, fromMs: number, toMs: number, extra: RecordData = {}): RecordData =>
  ({ id, type: 'audio', trackId, display: { from: fromMs, to: toMs }, trim: { from: 0 }, playbackRate: 1, properties: {}, metadata: { assetId: `asset-${id}` }, ...extra });
/** Stored volume property: static value and keyframes (times on the trim axis, ms). */
export const volume = (defaultValue: number, keyframes: ReturnType<typeof kf>[] = []) => ({ volume: { defaultValue, keyframes } });
export function mkDoc(tracks: RecordData[], items: RecordData[], groups: Record<string, RecordData> = {}, layerOrder?: ProjectDocument['layerOrder']): ProjectDocument {
  return { schemaVersion: 4, rev: 0, groups, duration: Math.max(1000, ...items.map(i => i.display.to)), fps: 30, size: { width: 1280, height: 720 }, background: {}, transitions: [], markers: [],
    tracks, items, layerOrder: layerOrder ?? tracks.map(t => ({ type: 'track' as const, id: t.id })) } as unknown as ProjectDocument;
}

/** A source signal as a function of source frame (48 kHz). */
export type Signal = (frame: number) => number;
export const sine = (hz: number, amp = 1): Signal => n => amp * Math.sin(2 * Math.PI * hz * n / FS);
/** Per-item synthetic sources: planar 48 kHz frames, `seconds` long, silent past the end. `calls` records each window requested. */
export function synthSource(signals: Record<string, Signal | Signal[]>, seconds: number, calls: { id: string; startS: number; endS: number }[] = []): AudioSource {
  const total = Math.round(seconds * FS);
  return async (item, startS, endS): Promise<SourcePcm | null> => {
    calls.push({ id: item.id, startS, endS });
    const s = signals[item.id]; if (!s) return null;
    const chans = Array.isArray(s) ? s : [s], start = Math.max(0, Math.floor(startS * FS)), end = Math.min(total, Math.ceil(endS * FS));
    return { start, data: chans.map(f => Float32Array.from({ length: Math.max(0, end - start) }, (_, i) => f(start + i))) };
  };
}
/** A source from decoded PCM held in memory (planar). */
export function pcmSource(pcm: Record<string, Float32Array[]>): AudioSource {
  return async (item, startS, endS) => {
    const p = pcm[item.id]; if (!p) return null;
    const start = Math.max(0, Math.floor(startS * FS)), end = Math.min(p[0].length, Math.ceil(endS * FS));
    return { start, data: p.map(c => c.slice(start, Math.max(start, end))) };
  };
}
/** Mono 48 kHz float PCM of a media file's first audio stream, decoded by ffmpeg. */
export function decodeWithFfmpeg(file: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr?.toString().slice(-300)}`);
  const b = r.stdout; return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4)));
}
export const haveFfmpeg = () => spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;

// ---- measures
export const rms = (x: ArrayLike<number>, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
export const db = (x: number) => 20 * Math.log10(x);
export const peak = (x: ArrayLike<number>, a = 0, b = x.length) => { let p = 0; for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i])); return p; };
/** Frequency (Hz) of x over [a, b) by positive-going zero crossings with linear interpolation. */
export function freqHz(x: ArrayLike<number>, a: number, b: number): number {
  const at: number[] = [];
  for (let i = Math.max(a + 1, 1); i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) at.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  if (at.length < 3) return NaN;
  return (at.length - 1) * FS / (at[at.length - 1] - at[0]);
}
export const cents = (f: number, expected: number) => 1200 * Math.log2(f / expected);
/** Seeded noise in -1…1 (mulberry32). */
export function noise(n: number, seed = 1): Float32Array {
  let a = seed >>> 0; const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1; }
  return out;
}
export const maxAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => { let m = 0; for (let i = 0; i < Math.max(a.length, b.length); i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0))); return m; };
