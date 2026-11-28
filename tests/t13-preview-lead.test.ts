// SPDX-License-Identifier: AGPL-3.0-only
// T13 preview (audio/preview.ts), F9: the first chunk's node starts after the audio thread's render position, not only
// after the main thread's reading of currentTime. A node started at a time the render thread has already passed sounds
// late from its given offset: on the Linux runner chunk 0 sounded 448 frames late and overlapped chunk 1, while the late
// hook stayed silent (it compares with the same reading). The context is a stub that records each start(when, offset):
// currentTime returns a snapshot T, and the render position (T + 30 ms, or T in the control) is a number of this test the
// product cannot read. Margin: one render quantum (128 frames), because Web Audio applies a start at a render quantum
// boundary, so a start that reaches a render thread inside a quantum takes effect at the next boundary, up to one quantum
// on. Chunk 0 still drops exactly LEAD_MS of its head (the export's 960-frame exclusion in t13-preview (b) stays).
// This tests the design rule (a lead against a stated render position), not Chromium: the Linux gate is the evidence that
// the fix works there.
// F9 review L2: baseLatency 50 ms, render 80 ms ahead, fails if the lead ignores baseLatency; a NaN baseLatency counts as 0.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAD_MS, PreviewAudio } from '../apps/web/src/audio/preview';
import { FS, mkClip, mkDoc, mkTrack, sine, synthSource } from './t13-support';

const QUANTUM = 128, T = QUANTUM * 400;
type Start = { at: number; offset: number };
/** baseLatency absent when the key is missing (the property is not set at all). */
function stubContext(startFrame: number, latency: { baseLatency?: number }) {
  const starts: Start[] = [];
  const ctx = {
    state: 'running', sampleRate: FS, currentTime: startFrame / FS, destination: {}, ...latency,
    createBuffer: (_c: number, n: number, rate: number) => ({ duration: n / rate, copyToChannel() {} }),
    createBufferSource: () => ({ buffer: null, connect() {}, disconnect() {}, stop() {}, start(at: number, offset: number) { starts.push({ at, offset }); } }),
  };
  return { ctx: ctx as unknown as AudioContext, starts };
}
const drain = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0)); };

afterEach(() => { vi.restoreAllMocks(); });

describe('the first chunk starts after the render position', () => {
  it.each([
    ['baseLatency 0, render 30 ms ahead of currentTime', { baseLatency: 0 }, 30],
    ['baseLatency missing, render 30 ms ahead of currentTime', {}, 30],
    ['baseLatency 10 ms, render 30 ms ahead of currentTime', { baseLatency: 0.01 }, 30],
    ['control: baseLatency 0, render at currentTime', { baseLatency: 0 }, 0],
    ['baseLatency 50 ms, render 80 ms ahead of currentTime', { baseLatency: 0.05 }, 80],
    ['baseLatency NaN, render 30 ms ahead of currentTime', { baseLatency: NaN }, 30],
  ] as const)('%s', async (_name, latency, aheadMs) => {
    const doc = mkDoc([mkTrack('a1')], [mkClip('c1', 'a1', 0, 1000, { sourceDuration: 2000 })]);
    const { ctx, starts } = stubContext(T, latency);
    const render = T + aheadMs * FS / 1000; // context frames the audio thread has rendered
    const audio = new PreviewAudio(ctx, synthSource({ c1: sine(440, 0.5) }, 2), () => doc);
    await audio.prime(0);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    audio.begin();
    await drain();
    expect(starts.length).toBeGreaterThan(0);
    const { at, offset } = starts[0]; // chunk 0: settle() schedules it inside begin(), before chunk 1 is rendered
    expect(offset * FS, `chunk 0 offset ${offset * FS} frames`).toBeCloseTo(LEAD_MS * FS / 1000, 6);
    expect(at * FS, `chunk 0 at ${at * FS} frames, render ${render}, margin ${QUANTUM}`).toBeGreaterThanOrEqual(render + QUANTUM - 1e-6);
    audio.stop();
  });
});
