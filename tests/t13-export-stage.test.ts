// SPDX-License-Identifier: AGPL-3.0-only
// T13's mix in T16a's audio stage (export/audio.ts mixStage), called as T16a's pipeline calls it (export/pipeline.ts
// feedAudio: one call, or 120 s chunks above 5 min, startMs = baseMs + pcmStart / 48 kHz). Oracles: T13's reference pass
// (audio/stage.ts renderAudio, whose chunked = one-shot equality is t13-chunks-oracle's) and the written spec (−1 dBFS
// ceiling; findings §7 l.101 for the remux conditions). The browser run through startExport is tests/ui/t13-export.spec.ts.
import { describe, expect, it } from 'vitest';
import type { Asset, ProjectDocument } from '../apps/web/src/store/model';
import type { GainMode } from '../apps/web/src/audio/gain';
import { mixFrames, PER_MS } from '../apps/web/src/audio/mix';
import { renderAudio } from '../apps/web/src/audio/stage';
import { CHUNK_S, CHUNKED_ABOVE_S, mixStage, SAMPLE_RATE } from '../apps/web/src/export/audio';
import type { AudioStage } from '../apps/web/src/export/audio';
import { remuxCandidate } from '../apps/web/src/export/remux';
import { exportPlan } from '../apps/web/src/render/model';
import { toTimelineMs } from '../apps/web/src/timeline/properties';
import { FS, kf, mkClip, mkDoc, mkTrack, peak, rms, sine, synthSource, volume } from './t13-support';
import type { Signal } from './t13-support';

const CEILING = 10 ** (-1 / 20);
/** The pipeline's calls (feedAudio's arithmetic): chunk outputs in order. */
async function pipelineCalls(stage: () => AudioStage, doc: ProjectDocument, baseMs: number, durationS: number) {
  const total = Math.round(durationS * SAMPLE_RATE), chunk = durationS > CHUNKED_ABOVE_S ? CHUNK_S * SAMPLE_RATE : total, out: [Float32Array, Float32Array][] = [];
  const s = stage();
  for (let at = 0; at < total; at += chunk) out.push((await s(doc, { startMs: baseMs + at / SAMPLE_RATE * 1000, frames: Math.min(chunk, total - at) })).data);
  return { total, chunk, out };
}
const mismatches = (a: Float32Array, b: Float32Array, from = 0, to = a.length) => { let n = 0; for (let i = from; i < to; i++) if (a[i] !== b[i]) n++; return n; };
/** 0.2 × a 440 Hz sine with 1.2 × bursts over the source-second windows given. */
const bursty = (bursts: [number, number][]): Signal => n => (bursts.some(([a, b]) => n >= a * FS && n < b * FS) ? 1.2 : 0.2) * Math.sin(2 * Math.PI * 440 * n / FS);

describe('the stage over T16a\'s 120 s chunk calls (written-spec: chunks join as one pass, the limiter gain carried)', () => {
  // 310 s, so the pipeline calls in 120 s chunks. The range starts at 1001 / 30 ms (frame 1 at 29.97 fps: 1601.6 on the
  // 48 kHz grid), so each chunk start is a fraction off the grid. Burst A ends 33 ms before the first chunk edge (the
  // limiter is releasing there); burst B straddles the second (the limiter is holding there).
  const baseMs = 1001 / 30, signal = bursty([[119.9, 120.0], [239.95, 240.1]]);
  const doc = mkDoc([mkTrack('a1')], [mkClip('c1', 'a1', 0, 310100, { sourceDuration: 320000 })]);
  const source = synthSource({ c1: signal }, 320);

  it('consecutive calls equal renderAudio over the range, sample for sample; the output stays under −1 dBFS', async () => {
    const { total, chunk, out } = await pipelineCalls(() => mixStage(source), doc, baseMs, 310);
    expect(out.map(c => c[0].length)).toEqual([chunk, chunk, total - 2 * chunk]);
    const ref = await renderAudio({ doc, fromMs: baseMs, toMs: baseMs + total / SAMPLE_RATE * 1000, source });
    expect(ref.channels[0]).toHaveLength(total);
    out.forEach((c, k) => { for (const ch of [0, 1] as const) expect(mismatches(c[ch], ref.channels[ch].subarray(k * chunk, k * chunk + c[ch].length))).toBe(0); });
    for (const c of out) expect(peak(c[0])).toBeLessThanOrEqual(CEILING * (1 + 1e-6)); // float32 rounding of the gain
    expect(peak(out[2][0], 0, 4800)).toBeGreaterThan(0.5); // burst B's limited level right after the second edge
  }, 120_000);
  it('negative control: a fresh limiter per call (no carry) differs right after the first edge, where the limiter is releasing', async () => {
    const carried = (await pipelineCalls(() => mixStage(source), doc, baseMs, 310)).out;
    let calls = 0;
    const fresh: AudioStage = (d, r) => { calls++; return mixStage(source)(d, r); };
    const control = (await pipelineCalls(() => fresh, doc, baseMs, 310)).out;
    expect(calls).toBe(3);
    expect(mismatches(carried[0][0], control[0][0])).toBe(0);
    expect(mismatches(carried[1][0], control[1][0], 0, 4800)).toBeGreaterThan(0);
  }, 120_000);
});

describe('the stage carries only across a continuing call', () => {
  const doc = mkDoc([mkTrack('a1')], [mkClip('c1', 'a1', 0, 3000, { sourceDuration: 4000 })]), source = synthSource({ c1: bursty([[0.9, 1.0]]) }, 4);
  const second = (startMs: number) => ({ startMs, frames: SAMPLE_RATE });
  it('a call starting where the last ended (within a frame) carries the limiter; any other start begins afresh on round(startMs × 48)', async () => {
    const fresh = await mixStage(source)(doc, second(1000.5));
    const s = mixStage(source);
    await s(doc, second(0));
    const jumped = await s(doc, second(1000.5));
    expect(mismatches(jumped.data[0], fresh.data[0])).toBe(0);
    const t = mixStage(source);
    await t(doc, second(0));
    const continued = await t(doc, second(1000 + 0.4 / 48)), alone = await mixStage(source)(doc, second(1000));
    expect(mismatches(continued.data[0], alone.data[0], 0, 480)).toBeGreaterThan(0); // releasing after the burst at 0.9–1.0 s
    const ref = await renderAudio({ doc, fromMs: 0, toMs: 2000, source });
    expect(mismatches(continued.data[0], ref.channels[0].subarray(SAMPLE_RATE))).toBe(0);
  });
});

// ---- T13 audit F5: the export never runs in parity mode (the A1 compare only used renderAudio parity). export/audio.ts:53
// calls mixFrames with no mode, so mix.ts:64 reads 'default'; for a range of one call audio/stage.ts:20-28 (renderAudio
// :31) does the same steps (start round(ms × 48), frames + look, end, a fresh Limiter, process(n)) but passes its mode.
// Only gain.ts clipGain (:21) reads the mode; its static branch (:24: no volume keyframes, or parity on a remapped clip)
// gives tg × base² in both, and mix.ts clipClock (:41) and stretchInto (:85) take none. exportMix (export/audio.ts:61-63)
// is mixStage over the decoder's source, which feeds both sides alike, so a synthetic source stands in.
describe('export = parity where no keyframes differ (T13 audit F5)', () => {
  const remap = { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0, { type: 'bezier', points: [0.5, 0.2, 0.75, 0.6] } as never), kf(3000, 6000)] }, sourceDuration: 14000 }; // t13-chunks-oracle :16
  // Static volumes only. c1 (item volume 2, gain 4 over 1.2 × bursts: the A4 case) overlaps c2 (rate 2, track 0.5) in the
  // first half; c3 (remapped) and c4 (keep pitch at 1.5) sound alone after; c5 sits on the muted a3 (timeline/model.ts:116).
  const doc = mkDoc([mkTrack('a1'), mkTrack('a2', { volume: 0.5 }), mkTrack('a3', { muted: true }), mkTrack('a4')], [
    mkClip('c1', 'a1', 0, 2500, { properties: volume(2) }), mkClip('c2', 'a2', 1000, 3000, { playbackRate: 2 }),
    mkClip('c3', 'a1', 3000, 4500, { ...remap, properties: volume(0.8) }), mkClip('c4', 'a4', 4500, 6000, { playbackRate: 1.5, keepPitch: true }), mkClip('c5', 'a3', 0, 6000)]);
  const source = synthSource({ c1: bursty([[0.5, 0.6], [1.5, 1.7]]), c2: sine(330, 0.5), c3: sine(700, 0.5), c4: sine(300, 0.5), c5: sine(200) }, 14);
  for (const [id, baseMs] of [['a0', 0], ['a1001', 1001 / 30]] as const) it(`${id}: no volume keyframes, the limiter working hard: the export equals renderAudio parity, sample for sample (range from ${baseMs.toFixed(3)} ms)`, async () => {
    const { total, out } = await pipelineCalls(() => mixStage(source), doc, baseMs, 6), start = Math.round(baseMs * PER_MS), at = (ms: number) => Math.round(ms * PER_MS) - start;
    expect(out).toHaveLength(1);
    const ref = await renderAudio({ doc, fromMs: baseMs, toMs: baseMs + total / SAMPLE_RATE * 1000, source, mode: 'parity' });
    for (const ch of [0, 1] as const) { expect(ref.channels[ch]).toHaveLength(total); expect(mismatches(out[0][ch], ref.channels[ch])).toBe(0); }
    const raw = await mixFrames(doc, start, total, { source });
    expect(Math.max(peak(raw[0]), peak(raw[1]))).toBeGreaterThan(CEILING); // the limiter engages
    for (const ch of [0, 1] as const) expect(peak(out[0][ch])).toBeLessThanOrEqual(CEILING * (1 + 1e-6)); // float32 rounding of the gain
    expect(rms(out[0][0], at(3000) + 4800, at(4500) - 4800), 'c3 (remapped) sounds').toBeGreaterThan(0);
    expect(rms(out[0][0], at(4500) + 4800, at(6000) - 4800), 'c4 (keep pitch) sounds').toBeGreaterThan(0);
  }, 60_000);

  // One eased pair, quiet (0.2 × gain ≤ 1 < ceiling), so the limiter is idle: need = 1 (limiter.ts:27), target 1, g stays
  // exactly 1 (:38), and :39 scales in place with no output delay, so output frame n is mix frame n. The keyframe at property
  // time 2000 sits at toTimelineMs (timeline/properties.ts:158) and the mix reads the gain at f / PER_MS (mix.ts:91): from
  // the first such f both modes give exactly tg × 1² (default: curve.ts:21 at property time, gain.ts:28; parity: gain.ts:39).
  const clip = mkClip('k1', 'a1', 0, 4000, { properties: volume(1, [kf(0, 0, 'easeInOut'), kf(2000, 1, 'easeInOut')]) });
  const kdoc = mkDoc([mkTrack('a1')], [clip]), ksource = synthSource({ k1: sine(440, 0.2) }, 5);
  const keyed = async (mode?: GainMode) => (await renderAudio({ doc: kdoc, fromMs: 0, toMs: 4000, source: ksource, mode })).channels;
  it('c1: eased volume keyframes: the export equals renderAudio in default mode (no mode), sample for sample', async () => {
    const { total, out } = await pipelineCalls(() => mixStage(ksource), kdoc, 0, 4), ref = await keyed();
    expect(out).toHaveLength(1);
    for (const ch of [0, 1] as const) { expect(ref[ch]).toHaveLength(total); expect(mismatches(out[0][ch], ref[ch])).toBe(0); }
  }, 60_000);
  it('c2: eased volume keyframes: the export differs from renderAudio parity before the last keyframe (output frames) and equals it from there to the end', async () => {
    const { total, out } = await pipelineCalls(() => mixStage(ksource), kdoc, 0, 4), ref = await keyed('parity'), raw = await mixFrames(kdoc, 0, total, { source: ksource });
    expect(Math.max(peak(raw[0]), peak(raw[1]))).toBeLessThan(CEILING); // the limiter stays idle
    const atMs = toTimelineMs(clip, 2000); let b = Math.ceil(atMs * PER_MS); while (b / PER_MS < atMs) b++; while ((b - 1) / PER_MS >= atMs) b--;
    const boundary = b - 0; // relative to the range start, frame round(0 × 48) = 0
    expect(boundary > 0 && boundary < total).toBe(true);
    for (const ch of [0, 1] as const) { expect(ref[ch]).toHaveLength(total); expect(mismatches(out[0][ch], ref[ch], 0, boundary)).toBeGreaterThan(0); expect(mismatches(out[0][ch], ref[ch], boundary, total)).toBe(0); }
  }, 60_000);
});

// ---- remuxCandidate: T13's gain law on the fast path (findings §7 l.101: only an unedited clip is copied; packets are
// copied without re-encoding, so a clip the gain law changes must take the encode path).
describe('remuxCandidate and the track gain (written-spec: findings §7 l.101, §29)', () => {
  const W = 640, H = 360, MS = 3000;
  const asset = { id: 'a1', name: 'clip.mp4', durationMs: MS, processing_status: 'ready',
    media: { video: { codec: 'avc', codecString: 'avc1.64001f', fps: 30, vfr: false, rotation: 0, displayWidth: W, displayHeight: H }, audio: { codec: 'aac' } } } as unknown as Asset;
  const doc = (v1: Record<string, unknown> = {}, v2: Record<string, unknown> = {}) => ({
    schemaVersion: 4, rev: 0, groups: {}, duration: MS, fps: 30, size: { width: W, height: H }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks: [{ id: 'v1', name: 'V1', kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1, ...v1 }, { id: 'v2', name: 'V2', kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1, ...v2 }],
    layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'v2' }],
    items: [{ id: 'c1', type: 'video', trackId: 'v1', display: { from: 0, to: MS }, trim: { from: 0, to: MS }, sourceDuration: MS, details: { name: 'c1' }, metadata: { assetId: 'a1' } }],
  }) as unknown as ProjectDocument;
  const run = (d: ProjectDocument) => remuxCandidate(d, exportPlan(d), { width: W, height: H }, id => (id === 'a1' ? asset : undefined), false);
  const reason = (r: ReturnType<typeof run>) => ('reason' in r ? r.reason : null);

  it('the clip on a track of gain 1 (solo on its own track included) takes the remux path', () => {
    expect('item' in run(doc())).toBe(true);
    expect('item' in run(doc({ solo: true }))).toBe(true);
  });
  it('a muted track, another track soloed, or a track volume under 1 → encode path ("the clip is edited")', () => {
    expect(reason(run(doc({ muted: true })))).toBe('the clip is edited');
    expect(reason(run(doc({}, { solo: true })))).toBe('the clip is edited');
    expect(reason(run(doc({ volume: 0.5 })))).toBe('the clip is edited');
  });
});
