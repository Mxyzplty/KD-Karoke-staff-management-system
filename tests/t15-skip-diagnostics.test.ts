// SPDX-License-Identifier: AGPL-3.0-only
// T15 :104 Step A (scratch: 2026-11-24 T15 playback104 diagnosis (C), §3): a skip records where it happened. Diagnostics only:
// playbackStats.skippedAt and maxRafGapAtMs are written by the loop and read by nothing but the stats and the specs' messages.
// Real render/playback.ts and audio/preview.ts on a fake clock (setTimeout, clearTimeout, performance), the same harness as
// t13-preview-start-stall.test.ts: requestAnimationFrame on setTimeout, 1 ms apart (the clock never crosses two frame indices
// between two of them), and a context stub whose currentTime is performance.now() since it was made, so on the context the
// clock advances exactly with performance.now(). The clip's sound starts at 300 ms, so the clock starts on performance.now()
// and re-anchors on the context at the sound. Row 1: one animation frame STALL_MS late, 1500 ms into the play, well after
// the re-anchor: exactly one skippedAt entry, naming the first index not painted, the gap, the context clock and the time
// since the re-anchor. Row 2 (control): no stall, no entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setView } from '../apps/web/src/editor/view';
import { dispatch } from '../apps/web/src/editor/commands';
import { attachPlayback, playbackStats, resetPlaybackStats } from '../apps/web/src/render/playback';
import type { ProjectStore } from '../apps/web/src/store/database';
import { FS, mkClip, mkDoc, mkTrack } from './t13-support';

vi.mock('../apps/web/src/audio/source', async () => {
  const { synthSource, sine } = await import('./t13-support');
  const s = synthSource({ c1: sine(440, 0.5) }, 4);
  return { storeAudioSource: () => s, clearAudioSources: () => {} };
});

const FPS = 30, STALL_AT_MS = 1500, SOUND_FROM_MS = 300;
/** More than two frame periods (66.7 ms), so the stall always skips at least one index whatever its phase. */
const STALL_MS = 70;

function context() {
  return class {
    state = 'running'; sampleRate = FS; baseLatency = 0.01; destination = {}; onstatechange: unknown = null;
    madeAt = performance.now();
    get currentTime() { return (performance.now() - this.madeAt) / 1000; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createBuffer(_c: number, n: number, rate: number) { return { duration: n / rate, copyToChannel() {} }; }
    createBufferSource() { return { buffer: null, connect() {}, disconnect() {}, start() {}, stop() {} }; }
  };
}

/** One play of a 3000 ms audio-only timeline from 0, run for 4000 ms; with stall, the first animation frame requested at or
 *  after STALL_AT_MS of play comes STALL_MS later. Returns the paints, the stall and the last re-anchor's performance.now(). */
async function playOnce(stall: boolean) {
  const paints: { n: number; at: number }[] = [];
  let gap: { from: number; to: number } | null = null, seen = 0, reanchorAt = NaN;
  vi.stubGlobal('AudioContext', context());
  const t0 = performance.now();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const from = performance.now(), ms = stall && !gap && from - t0 >= STALL_AT_MS ? STALL_MS : 1;
    if (ms !== 1) gap = { from, to: from + ms };
    return setTimeout(() => {
      cb(performance.now());
      // performance.now() does not move inside the callback, so this is the frame's own reading at the re-anchor.
      if (playbackStats.reanchors !== seen) { seen = playbackStats.reanchors; reanchorAt = performance.now(); }
    }, ms);
  });
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  const doc = mkDoc([mkTrack('a1')], [mkClip('c1', 'a1', SOUND_FROM_MS, 3000, { sourceDuration: 4000 })]);
  setView({ playheadMs: 0 });
  resetPlaybackStats();
  const detach = attachPlayback({ store: {} as ProjectStore, doc: () => doc, asset: () => undefined, paint: ft => paints.push({ n: Math.round(ft * FPS / 1000), at: performance.now() }) });
  try {
    dispatch({ type: 'togglePlayback' });
    await vi.advanceTimersByTimeAsync(4000);
    return { paints, gap: gap as { from: number; to: number } | null, reanchorAt, stats: { ...playbackStats, skippedAt: [...playbackStats.skippedAt] } };
  } finally { detach(); }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('T15 :104 Step A: skip diagnostics', () => {
  it(`one ${STALL_MS} ms animation-frame gap after the re-anchor records exactly one skippedAt entry`, async () => {
    const r = await playOnce(true), g = r.gap!;
    expect(g, 'the stall happened').not.toBeNull();
    expect(r.stats.reanchors, 'the clock re-anchored on the context at the sound').toBeGreaterThanOrEqual(1);
    expect(r.reanchorAt, 'the re-anchor came before the stall').toBeLessThan(g.from);
    const before = r.paints.filter(p => p.at <= g.from).at(-1)!, after = r.paints.find(p => p.at === g.to)!;
    expect(after, 'the animation frame that ends the stall paints').toBeDefined();
    expect(r.stats.skipped, `paints ${before.n} -> ${after.n}`).toBe(after.n - before.n - 1);
    expect(r.stats.skipped).toBeGreaterThanOrEqual(1);
    expect(r.stats.skippedAt).toHaveLength(1);
    const e = r.stats.skippedAt[0];
    expect(e.n, 'the first index not painted').toBe(before.n + 1);
    expect(e.gapMs).toBe(STALL_MS);
    expect(e.ctx, 'the clock was on the context').toBe(true);
    expect(e.sinceReanchorMs).toBe(Math.round((g.to - r.reanchorAt) * 10) / 10);
    expect(r.stats.maxRafGapMs).toBe(STALL_MS);
    expect(r.stats.maxRafGapAtMs, 'the longest gap is the stall, at the skip\'s clock reading').toBe(e.t);
  });

  it('control: animation frames 1 ms apart record no skip', async () => {
    const r = await playOnce(false);
    expect(r.gap).toBeNull();
    expect(r.stats.skipped).toBe(0);
    expect(r.stats.skippedAt).toEqual([]);
    expect(r.stats.maxRafGapMs).toBeLessThanOrEqual(1);
  });
});
