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
// Review F1 (t13-f9r-review): C-A and C-B are A and B with the clip moved to start at 300 ms, so chunk 0 (0-250 ms) is silent
// and makes no node; the first node is chunk 1's, made on the mapping at its place (offset 0), so base = its at − 0.25 s.
// Review F4: A and C-A pin the node count, so a chunk skipped as late cannot move the last node and loosen the bound.
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
/** Rows B and C-B read the first paint at or after 1000 ms of play: past the stall (60 ms), the start's hold and every switch
 *  of the clock (the last when the context reaches the first sound: chunk 1, 250 ms into the mapping in C, before 400 ms of
 *  play), several chunks into the sound, and well before the end-of-timeline pause (about 3.08 s). */
const SAMPLE_MS = 1000, SOUND_FROM_MS = 300;
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
/** One play of a 3000 ms audio-only timeline from 0 (its clip from fromMs), run on the fake clock for 4000 ms; detached in finally. */
async function playOnce(stallMs: number, rafMs: number, fromMs = 0) {
  const nodes: Node[] = [], made: { currentTime: number }[] = [], paints: Paint[] = [];
  vi.stubGlobal('AudioContext', stallContext(stallMs, nodes, made));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), rafMs));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  const doc = mkDoc([mkTrack('a1')], [mkClip('c1', 'a1', fromMs, 3000, { sourceDuration: 4000 })]);
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

/** A: `count` chunks make a node (12 with sound from 0, 11 with chunk 0 silent); the last is chunk 11 (2.75-3 s). */
async function endRow(stallMs: number, fromMs: number, count: number) {
  const r = await playOnce(stallMs, 16, fromMs);
  expect(r.playing).toBe(false); // the end rule fired
  expect(r.nodes).toHaveLength(count);
  const last = r.nodes.at(-1)!, end = last.at - last.offset + last.duration; // chunk 11: end = base + 3 s
  expect(last.stoppedAt ?? Infinity, `stopped at ${(last.stoppedAt ?? NaN) * FS} frames, sound ends ${end * FS}`).toBeGreaterThanOrEqual(end - QUANTUM / FS);
}
/** B: the first node is the chunk from timeline s firstS, so base = its at − offset − firstS. */
async function syncRow(stallMs: number, fromMs: number, firstS: number) {
  const r = await playOnce(stallMs, 1, fromMs);
  const first = r.nodes[0], base = first.at - first.offset - firstS; // context s of timeline frame 0
  const i = r.paints.findIndex(p => p.playMs >= SAMPLE_MS), paint = r.paints[i], n = Math.round(paint.ft * FPS / 1000);
  expect(Math.round(r.paints[i - 1].ft * FPS / 1000), 'the previous paint is frame n − 1: the clock crossed into n since it').toBe(n - 1);
  const boundary = (n - 0.5) / FPS, heard = paint.ctxS - base; // timeline s: the clock's reading, the sound's
  expect(Math.abs(heard - boundary) * FS, `frame ${n} at ${paint.playMs} ms: sound at ${heard * FS} frames, clock at ${boundary * FS}`).toBeLessThanOrEqual(QUANTUM);
}

describe('F9-R A: the end-of-timeline pause leaves the sound to the end of its mapping', () => {
  it.each(CASES)('%s', (_name, stallMs) => endRow(stallMs, 0, 12));
});
describe('F9-R B: the picture clock follows the sound mapping after the start', () => {
  it.each(CASES)('%s', (_name, stallMs) => syncRow(stallMs, 0, 0));
});
describe('F9-R C-A: chunk 0 silent, sound from 300 ms: the end pause leaves the sound to the end of its mapping', () => {
  it.each(CASES)('%s', (_name, stallMs) => endRow(stallMs, SOUND_FROM_MS, 11));
});
describe('F9-R C-B: chunk 0 silent, sound from 300 ms: the picture clock follows the sound mapping', () => {
  it.each(CASES)('%s', (_name, stallMs) => syncRow(stallMs, SOUND_FROM_MS, 0.25));
});
