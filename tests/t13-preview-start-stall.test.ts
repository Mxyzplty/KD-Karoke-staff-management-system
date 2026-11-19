// SPDX-License-Identifier: AGPL-3.0-only
// T13 audit F9-R (t13-preview-d55-diagnosis §4): a context that reports 'running' at once but renders its first quantum
// stallMs later (the T33 Windows run: `since 0, f0 0`, the tail 23 quanta short). Real render/playback.ts and audio/preview.ts
// on a fake clock (setTimeout, clearTimeout, performance) with requestAnimationFrame on setTimeout; the context is a stub whose
// currentTime is performance.now() since it was made, less stallMs, and that records each node's start(at, offset) and the
// context time of its first stop(). The source is synthetic (audio/source mocked: no worker-backed pool).
// A: the end-of-timeline pause must not stop the sound before the mapping's end (one render quantum of slack).
// B (lane A): well inside the play, the picture's clock must match the sound's mapping within one render quantum. The clock is
// read where it crosses a frame boundary: the paint of frame n comes on the first animation frame with clock ≥ (n − ½) / fps
// (model.ts previewFrame rounds), so with animation frames 1 ms apart the clock at that paint is within 1 ms of that boundary.
// The sound's timeline time at the paint is ctx.currentTime − base, base = chunk 0's at − offset (its node holds frame 0 and
// starts LEAD_MS in; the nodes exist from the start, so follow() never moves the mapping).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setView } from '../apps/web/src/editor/view';
import { dispatch } from '../apps/web/src/editor/commands';
import { attachPlayback, usePlayback } from '../apps/web/src/render/playback';
import type { ProjectStore } from '../apps/web/src/store/database';
import { FS, mkClip, mkDoc, mkTrack } from './t13-support';

vi.mock('../apps/web/src/audio/source', async () => {
  const { synthSource, sine } = await import('./t13-support');
  const s = synthSource({ c1: sine(440, 0.5) }, 4);
  return { storeAudioSource: () => s, clearAudioSources: () => {} };
});

const QUANTUM = 128, FPS = 30;
/** Row B's reading: the first paint at or after 1000 ms of play, past the stall (60 ms) and the start's hold and switch
 *  (both under 120 ms), several chunks into the sound, and well before the end-of-timeline pause (about 3.08 s). */
const SAMPLE_MS = 1000;
type Node = { at: number; offset: number; duration: number; stoppedAt?: number };
type Paint = { ft: number; playMs: number; ctxS: number };

/** Reports 'running' from the start; renders (currentTime moves) stallMs after it was made. */
function stallContext(stallMs: number, nodes: Node[], made: { currentTime: number }[]) {
  return class {
    state = 'running'; sampleRate = FS; baseLatency = 0.01; destination = {}; onstatechange: unknown = null;
    madeAt = performance.now();
    constructor() { made.push(this); }
    get currentTime() { return Math.max(0, performance.now() - this.madeAt - stallMs) / 1000; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createBuffer(_c: number, n: number, rate: number) { return { duration: n / rate, copyToChannel() {} }; }
    createBufferSource() {
      const ctx = this; let node: Node | null = null;
      return {
        buffer: null as { duration: number } | null, connect() {}, disconnect() {},
        start(at: number, offset: number) { nodes.push(node = { at, offset, duration: this.buffer!.duration }); },
        stop() { if (node && node.stoppedAt === undefined) node.stoppedAt = ctx.currentTime; },
      };
    }
  };
}
/** One play of a 3000 ms audio-only timeline from 0, run on the fake clock for 4000 ms; detached in finally. */
async function playOnce(stallMs: number, rafMs: number) {
  const nodes: Node[] = [], made: { currentTime: number }[] = [], paints: Paint[] = [];
  vi.stubGlobal('AudioContext', stallContext(stallMs, nodes, made));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), rafMs));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  const doc = mkDoc([mkTrack('a1')], [mkClip('c1', 'a1', 0, 3000, { sourceDuration: 4000 })]);
  setView({ playheadMs: 0 });
  const t0 = performance.now();
  const detach = attachPlayback({ store: {} as ProjectStore, doc: () => doc, asset: () => undefined, paint: ft => paints.push({ ft, playMs: performance.now() - t0, ctxS: made[0]?.currentTime ?? NaN }) });
  try {
    dispatch({ type: 'togglePlayback' });
    await vi.advanceTimersByTimeAsync(4000);
    return { nodes, paints, playing: usePlayback.getState().playing };
  } finally { detach(); }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const CASES = [['control', 0], ['context renders 60 ms after running (T33 Windows)', 60]] as const;

describe('F9-R A: the end-of-timeline pause leaves the sound to the end of its mapping', () => {
  it.each(CASES)('%s', async (_name, stallMs) => {
    const r = await playOnce(stallMs, 16);
    expect(r.playing).toBe(false); // the end rule fired
    const last = r.nodes.at(-1)!, end = last.at - last.offset + last.duration; // chunk 11 (2.75-3 s): end = base + 3 s
    expect(last.stoppedAt ?? Infinity, `stopped at ${(last.stoppedAt ?? NaN) * FS} frames, sound ends ${end * FS}`).toBeGreaterThanOrEqual(end - QUANTUM / FS);
  });
});

describe('F9-R B: the picture clock follows the sound mapping after the start', () => {
  it.each(CASES)('%s', async (_name, stallMs) => {
    const r = await playOnce(stallMs, 1);
    const first = r.nodes[0], base = first.at - first.offset; // context s of timeline frame 0
    const i = r.paints.findIndex(p => p.playMs >= SAMPLE_MS), paint = r.paints[i], n = Math.round(paint.ft * FPS / 1000);
    expect(Math.round(r.paints[i - 1].ft * FPS / 1000), 'the previous paint is frame n − 1: the clock crossed into n since it').toBe(n - 1);
    const boundary = (n - 0.5) / FPS, heard = paint.ctxS - base; // timeline s: the clock's reading, the sound's
    expect(Math.abs(heard - boundary) * FS, `frame ${n} at ${paint.playMs} ms: sound at ${heard * FS} frames, clock at ${boundary * FS}`).toBeLessThanOrEqual(QUANTUM);
  });
});
