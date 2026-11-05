// SPDX-License-Identifier: AGPL-3.0-only
// The mix engine shared by preview and export (findings §7, §7b; T13): 48 kHz stereo on one absolute grid (timeline frame F
// = F / 48 ms), so chunks rendered apart (preview chunks, export chunks) join sample-exactly. Each video / audio clip on an
// audible track reads its source at the mix rate along its clock — constant speed: trim.from + local × rate (resampling,
// so pitch × rate; past the source end it is silent); time remap: the remap curve with its easing, clamped to 0…source
// length (reverse plays backwards, a freeze holds one sample; no rate clamp, no anti-alias) — with linear interpolation,
// times the gain law (gain.ts), and sums. "Keep pitch" clips go through stretch.ts instead. Sources are read in windows
// covering what the clip reads, padded by PADDING_S either side. Mono plays on both sides; 5.1 and quad fold down by
// the Web Audio speaker rules; other layouts play their first two channels. The filled cells of a T07 layout item are clips
// too (timeline/layouts cell items: the layout's track and time, the cell's Speed and Volume).
import type { ProjectDocument, RecordData } from '../store/model';
import { withCellItems } from '../timeline/layouts';
import { prop, rateOf, remapKeyframes } from '../timeline/properties';
import { compileCurve } from './curve';
import { audibleTrackGain, clipGain } from './gain';
import type { GainMode } from './gain';
import { CHAIN, GRAIN, HOP, stretchInto } from './stretch';
import type { Chain } from './stretch';

export const MIX_RATE = 48000, PER_MS = MIX_RATE / 1000, PADDING_S = 0.25;
/** The browser sources decode in blocks of BLOCK_S source seconds (source.ts). */
export const BLOCK_S = 8;
/** A source's sound at the mix rate: planar frames from source frame `start` (source frame f = f / 48 000 s). */
export type SourcePcm = { start: number; data: Float32Array[] };
/** The window of a clip's source covering source seconds [startS, endS] at the mix rate; null when it has no sound. */
export type AudioSource = (item: RecordData, startS: number, endS: number) => Promise<SourcePcm | null>;
/** `chains`: keep-pitch chain state carried between calls that render in order (preview); the samples do not depend on it. */
export type MixOptions = { source: AudioSource; mode?: GainMode; chains?: Map<string, Chain> };
export type Stereo = [Float32Array, Float32Array];

const SQRT_HALF = Math.SQRT1_2;
/** The two output channels of a planar source (Web Audio's down-mix rules for 4 and 6 channels). */
export function toStereo(data: Float32Array[]): Stereo {
  const [a, b, c, d, e, f] = data;
  if (data.length === 1) return [a, a];
  if (data.length === 4) return [a.map((x, i) => 0.5 * (x + c[i])), b.map((x, i) => 0.5 * (x + d[i]))];
  if (data.length === 6) return [a.map((x, i) => x + SQRT_HALF * (c[i] + e[i])), b.map((x, i) => x + SQRT_HALF * (c[i] + f[i]))];
  return [a, b];
}
/** Source ms a clip reads at item-local ms (see the header; a constant-speed clock is not clamped). */
export function clipClock(item: RecordData): (local: number) => number {
  const remap = remapKeyframes(item), rate = rateOf(item), trim = item.trim?.from ?? 0;
  if (!remap.length) return local => trim + local * rate;
  const limit = typeof item.sourceDuration === 'number' ? item.sourceDuration : Infinity, curve = compileCurve(remap, Number(item.timeRemap?.defaultValue ?? 0));
  return local => Math.min(Math.max(curve(local), 0), limit);
}
const audible = (item: RecordData) => item.type === 'video' || item.type === 'audio';
/** A static volume of 0: the clip is silent everywhere, so its source is never read. */
const silent = (item: RecordData) => { const p = prop(item, 'volume'); return !!p && !p.keyframes.length && p.defaultValue === 0; };
export const keepsPitch = (item: RecordData) => item.keepPitch === true && (remapKeyframes(item).length > 0 || rateOf(item) !== 1);
/** A keep-pitch clip's chain, kept per everything its chain reads: the clip but its volume (the clock, the source, the place). */
function chainOf(chains: Map<string, Chain>, item: RecordData): Chain {
  const key = JSON.stringify({ ...item, properties: { ...item.properties, volume: undefined } });
  let chain = chains.get(key);
  if (!chain) chains.set(key, chain = new Map());
  return chain;
}

/**
 * Mixes `frames` frames from timeline frame `start`. `end` (default start + frames) is the end of the range the caller
 * exports: frames past it are lookahead (the limiter's), and parity mode skips keyframes outside [start, end].
 */
export async function mixFrames(doc: ProjectDocument, start: number, frames: number, options: MixOptions & { end?: number }): Promise<Stereo> {
  const out: Stereo = [new Float32Array(frames), new Float32Array(frames)], mode = options.mode ?? 'default';
  const fromMs = start / PER_MS, toMs = (options.end ?? start + frames) / PER_MS;
  // Windows are fetched together, then summed in document order (the same float sums however the range is chunked).
  const jobs = withCellItems(doc.items).map(async item => {
    if (!audible(item) || audibleTrackGain(doc, item.trackId) === 0 || silent(item)) return null;
    const df = item.display.from, f0 = Math.max(start, Math.ceil(df * PER_MS - 1e-6)), f1 = Math.min(start + frames, Math.ceil(item.display.to * PER_MS - 1e-6));
    if (f1 <= f0) return null;
    const clock = clipClock(item), local = (f: number) => f / PER_MS - df, stretch = keepsPitch(item);
    // A stretch replays its shift chain from the last restart (up to CHAIN grains back) and reads grains past both ends.
    const ext = stretch ? (CHAIN * HOP + 2 * GRAIN) / PER_MS : 0, l0 = local(f0) - ext, l1 = local(f1) + ext;
    let lo = Math.min(clock(l0), clock(l1)), hi = Math.max(clock(l0), clock(l1));
    if (remapKeyframes(item).length) for (let t = Math.ceil(l0); t < l1; t++) { const s = clock(t); if (s < lo) lo = s; if (s > hi) hi = s; }
    const pcm = await options.source(item, Math.max(0, lo / 1000 - PADDING_S), Math.max(0, hi / 1000 + PADDING_S));
    return pcm && pcm.data.length ? { item, f0, f1, clock, local, stretch, pcm } : null;
  });
  for (const job of await Promise.all(jobs)) {
    if (!job) continue;
    const { item, f0, f1, clock, local, pcm } = job, [L, R] = toStereo(pcm.data), n = L.length, base = pcm.start;
    const gain = clipGain(doc, item, mode, fromMs, toMs);
    if (job.stretch) {
      const first = Math.round(item.display.from * PER_MS);
      stretchInto(out, f0 - start, f1 - start, first - start, k => clock(local(first + k)) * PER_MS, L, R, base, i => gain((start + i) / PER_MS), options.chains && chainOf(options.chains, item));
      continue;
    }
    for (let f = f0; f < f1; f++) {
      const x = clock(local(f)) * PER_MS - base, i = Math.floor(x);
      if (i < -1 || i >= n) continue;
      const w = x - i, g = gain(f / PER_MS), o = f - start;
      const l0 = i >= 0 ? L[i] : 0, r0 = i >= 0 ? R[i] : 0, l1 = i + 1 < n ? L[i + 1] : 0, r1 = i + 1 < n ? R[i + 1] : 0;
      out[0][o] += g * (l0 + (l1 - l0) * w); out[1][o] += g * (r0 + (r1 - r0) * w);
    }
  }
  return out;
}
