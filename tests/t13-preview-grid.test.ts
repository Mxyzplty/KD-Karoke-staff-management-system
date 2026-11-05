// SPDX-License-Identifier: AGPL-3.0-only
// T13 preview (audio/preview.ts): every chunk node starts on the context's 48 kHz frame grid. Chromium interpolates a buffer
// started between frames (sub-sample start), so a preview chunk off the grid is no longer the export's samples: the
// t13-preview (b) capture then read a −28 dBFS residual at a 0.1 ms lag, one step of performance.now() (0.1 ms when the
// page is not cross-origin isolated). The context is a stub that records each start(when, offset).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewAudio } from '../apps/web/src/audio/preview';
import { FS, mkClip, mkDoc, mkTrack, sine, synthSource } from './t13-support';

type Start = { at: number; offset: number };
function stubContext(startFrame: number) {
  const starts: Start[] = [];
  const ctx = {
    state: 'running', sampleRate: FS, currentTime: startFrame / FS, destination: {},
    createBuffer: (_c: number, n: number, rate: number) => ({ duration: n / rate, copyToChannel() {} }),
    createBufferSource: () => ({ buffer: null, connect() {}, disconnect() {}, stop() {}, start(at: number, offset: number) { starts.push({ at, offset }); } }),
  };
  return { ctx: ctx as unknown as AudioContext & { currentTime: number }, starts };
}
const offGrid = (seconds: number) => Math.abs(seconds * FS - Math.round(seconds * FS));
const drain = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0)); };

afterEach(() => { vi.restoreAllMocks(); });

describe('preview chunks start on the context frame grid', () => {
  it('the mapping is fixed a performance.now() step (0.1 ms = 4.8 frames) after begin(): the first chunk still starts on a frame', async () => {
    const doc = mkDoc([mkTrack('a1')], [mkClip('c1', 'a1', 0, 1000, { sourceDuration: 2000 })]);
    const { ctx, starts } = stubContext(128 * 400);
    const audio = new PreviewAudio(ctx, synthSource({ c1: sine(440, 0.5) }, 2), () => doc);
    await audio.prime(0);
    vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValue(1000.1);
    audio.begin();
    await drain();
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(offGrid(s.at), `start at ${s.at * FS} frames`).toBeLessThan(1e-6);
    audio.stop();
  });
  it('follow() at a picture time between frames (100.0123 ms) moves the mapping; the chunk heard next still starts on a frame', async () => {
    // silent for the first 1.5 s (more than AHEAD_MS), so no node is playing or scheduled when follow() moves the mapping
    const doc = mkDoc([mkTrack('a1')], [mkClip('c1', 'a1', 1500, 2500, { sourceDuration: 2000 })]);
    const { ctx, starts } = stubContext(128 * 400);
    const audio = new PreviewAudio(ctx, synthSource({ c1: sine(440, 0.5) }, 2), () => doc);
    await audio.prime(0);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    audio.begin();
    await drain();
    expect(starts).toHaveLength(0);
    ctx.currentTime += 128 * 38 / FS; // about 100 ms on
    audio.follow(100.0123);
    ctx.currentTime += 128 * 190 / FS; // about 0.6 s later: the clip's first chunk is within AHEAD_MS
    audio.pump();
    await drain();
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(offGrid(s.at), `start at ${s.at * FS} frames`).toBeLessThan(1e-6);
    audio.stop();
  });
});
