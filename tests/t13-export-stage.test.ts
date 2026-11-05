// SPDX-License-Identifier: AGPL-3.0-only
// T13's mix in T16a's audio stage (export/audio.ts mixStage), called as T16a's pipeline calls it (export/pipeline.ts
// feedAudio: one call, or 120 s chunks above 5 min, startMs = baseMs + pcmStart / 48 kHz). Oracles: T13's reference pass
// (audio/stage.ts renderAudio, whose chunked = one-shot equality is t13-chunks-oracle's) and the written spec (−1 dBFS
// ceiling; findings §7 l.101 for the remux conditions). The browser run through startExport is tests/ui/t13-export.spec.ts.
import { describe, expect, it } from 'vitest';
import type { Asset, ProjectDocument } from '../apps/web/src/store/model';
import { renderAudio } from '../apps/web/src/audio/stage';
import { CHUNK_S, CHUNKED_ABOVE_S, mixStage, SAMPLE_RATE } from '../apps/web/src/export/audio';
import type { AudioStage } from '../apps/web/src/export/audio';
import { remuxCandidate } from '../apps/web/src/export/remux';
import { exportPlan } from '../apps/web/src/render/model';
import { FS, mkClip, mkDoc, mkTrack, peak, synthSource } from './t13-support';
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
