// SPDX-License-Identifier: AGPL-3.0-only
// T08 CI fix 2: OffthreadVideo waits for the frame at the seek time, not for `seeked`. A stub video stands in for the
// element; a stub VideoFrame reports the frame the element would draw (`shown`, seconds; null = no frame yet), so the
// not-yet-decoded states Linux Chromium hit (pre-seek frame still shown, or none) are forced deterministically.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentFrame, frameStartAt, showFrameAt } from '../apps/web/src/mg/video-frame';

const NAMED = 'Video frame was not decoded at the requested time.';
type Stub = { -readonly [K in keyof HTMLVideoElement]: HTMLVideoElement[K] } & { shown: number | null; frameUs: number | null; seeks: number[]; onSeek?: (time: number) => void };
let made = 0, closed = 0;
class StubVideoFrame {
  timestamp: number; duration: number | null;
  constructor(el: Stub) { if (el.shown === null) throw new DOMException('No current frame.', 'InvalidStateError'); made++; this.timestamp = Math.round(el.shown * 1e6); this.duration = el.frameUs; }
  close() { closed++; }
}
function video(fields: Partial<Stub> = {}): Stub {
  let time = 0;
  const el = { readyState: 4, videoWidth: 64, duration: 10, shown: 0, frameUs: 33_333, seeks: [] as number[], onloadedmetadata: null, onseeked: null, onerror: null, ...fields } as unknown as Stub;
  Object.defineProperty(el, 'currentTime', { get: () => time, set: (t: number) => { time = t; el.seeks.push(t); el.onSeek?.(t); } });
  return el;
}
const fire = (el: Stub, name: 'onseeked' | 'onloadedmetadata' | 'onerror', after = 5) => setTimeout(() => (el[name] as (() => void) | null)?.(), after);
function track(promise: Promise<void>) {
  const state = { value: 'pending' };
  promise.then(() => { state.value = 'resolved'; }, (e: Error) => { state.value = `rejected: ${e.message}`; });
  return state;
}
/** Frame starts of a 30 fps track: `count` frames from `first` seconds. */
const starts30 = (count: number, first = 0) => Array.from({ length: count }, (_, i) => first + i / 30);

beforeEach(() => { made = closed = 0; vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.stubGlobal('VideoFrame', StubVideoFrame); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('showFrameAt', () => {
  it('seeked while the pre-seek frame is still shown: the hold stays open until the frame at the seek time is current', async () => {
    const el = video({ onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 4 / 30, 30, 1800));
    expect(el.seeks).toEqual([4 / 30 + 0.001]);
    await vi.advanceTimersByTimeAsync(200);
    expect(state.value).toBe('pending'); // seeked fired at 5 ms; frame 0 (the pre-seek frame) would have been drawn
    el.shown = 4 / 30;
    await vi.advanceTimersByTimeAsync(10);
    expect(state.value).toBe('resolved');
    expect(closed).toBe(made);
  });

  it('seeked with no frame at all (readyState HAVE_METADATA, VideoFrame throws): never resolves, rejects with the named message at the cap', async () => {
    const el = video({ onSeek: () => { el.readyState = 1; el.shown = null; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 13 * 2 / 30, 30, 1800));
    await vi.advanceTimersByTimeAsync(1799);
    expect(state.value).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value).toBe(`rejected: ${NAMED}`);
  });

  it('a frame that VideoFrame cannot read yet (readyState 4, InvalidStateError) is waited for, then accepted', async () => {
    const el = video({ onSeek: () => { el.shown = null; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 26 / 30, 30, 1800));
    await vi.advanceTimersByTimeAsync(300);
    expect(state.value).toBe('pending');
    el.shown = 26 / 30;
    await vi.advanceTimersByTimeAsync(10);
    expect(state.value).toBe('resolved');
  });

  it('a stale frame is never accepted: frame 0 stays shown after seeking to frame 4, so the hold fails by name', async () => {
    const el = video({ onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 4 / 30, 30, 500));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.value).toBe(`rejected: ${NAMED}`);
  });

  it('a frame after the seek time is not accepted either', async () => {
    const el = video({ onSeek: () => { el.shown = 5 / 30; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 4 / 30, 30, 300));
    await vi.advanceTimersByTimeAsync(300);
    expect(state.value).toBe(`rejected: ${NAMED}`);
  });

  it('the frame that covers the time resolves at seeked; every VideoFrame is closed', async () => {
    const el = video({ onSeek: () => { el.shown = 7 / 30; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 7 / 30, 30, 1800));
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
    expect(made).toBeGreaterThan(0);
    expect(closed).toBe(made);
  });

  it('seeking to the frame already shown (source 0) resolves at seeked', async () => {
    const el = video({ onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 0, 30, 1800));
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
  });

  it('past the end of the video: the time is clamped to the last frame, which is accepted once it replaced the pre-seek frame', async () => {
    // Container duration 4 s (e.g. a longer audio track); the last video frame starts at 3.5 s and ends before 3.999 s.
    const el = video({ duration: 4, onSeek: () => { el.shown = 3.5; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 10, 30, 1800));
    expect(el.seeks).toEqual([4 - 0.001]);
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
  });

  it('the first frame arrives late: the seek waits for it, so that frame is not taken for the seek\'s frame', async () => {
    const el = video({ shown: null, onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 4 / 30, 30, 1800));
    await vi.advanceTimersByTimeAsync(50);
    expect(el.seeks).toEqual([]);
    el.shown = 0;
    await vi.advanceTimersByTimeAsync(10);
    expect(el.seeks).toEqual([4 / 30 + 0.001]);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.value).toBe('pending');
    el.shown = 4 / 30;
    await vi.advanceTimersByTimeAsync(10);
    expect(state.value).toBe('resolved');
  });

  it('without WebCodecs, seeked before readyState reaches HAVE_CURRENT_DATA waits for it', async () => {
    vi.unstubAllGlobals();
    expect(typeof (globalThis as { VideoFrame?: unknown }).VideoFrame).toBe('undefined');
    const el = video({ onSeek: () => { el.readyState = 1; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 4 / 30, 30, 1800));
    await vi.advanceTimersByTimeAsync(100);
    expect(state.value).toBe('pending');
    el.readyState = 2;
    await vi.advanceTimersByTimeAsync(10);
    expect(state.value).toBe('resolved');
  });

  it('waits for metadata before seeking; no metadata within the cap is the load timeout, not the named frame error', async () => {
    const el = video({ readyState: 0 });
    const state = track(showFrameAt(el, 1, 30, 1800));
    await vi.advanceTimersByTimeAsync(1800);
    expect(el.seeks).toEqual([]);
    expect(state.value).toBe('rejected: Video frame load timeout.');
  });

  it('metadata, then the seek: resolves once loaded and seeked', async () => {
    const el = video({ readyState: 0, onSeek: () => { el.shown = 1; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 1, 30, 1800));
    el.readyState = 4; fire(el, 'onloadedmetadata', 20);
    await vi.advanceTimersByTimeAsync(30);
    expect(el.seeks).toEqual([1.001]);
    expect(state.value).toBe('resolved');
  });

  it('a load error rejects at once', async () => {
    const el = video({ readyState: 0 });
    const state = track(showFrameAt(el, 1, 30, 1800));
    fire(el, 'onerror', 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(state.value).toBe('rejected: Video could not be loaded.');
  });
});

// The CI fix 2 delta review (t08-review, CF-B1 / CF-M1 / CF-M2): each case failed on that delta.
describe('showFrameAt: review cases', () => {
  it('R1: a stale frame 0 whose duration is 0 is refused for frame 4 (an unknown duration covers one composition frame)', async () => {
    const el = video({ frameUs: 0, onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 4 / 30, 30, 500));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.value).toBe(`rejected: ${NAMED}`);
  });

  it('R1b: the same with no duration (VideoFrame.duration null)', async () => {
    const el = video({ frameUs: null, onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 4 / 30, 30, 500));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.value).toBe(`rejected: ${NAMED}`);
  });

  it('R1c: with no duration, a frame that replaced the pre-seek frame is still accepted, past the end too', async () => {
    const el = video({ frameUs: null, onSeek: () => { el.shown = 4 / 30; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 4 / 30, 30, 1800));
    const end = video({ duration: 4, frameUs: 0, onSeek: () => { end.shown = 3.5; fire(end, 'onseeked'); } });
    const past = track(showFrameAt(end, 10, 30, 1800));
    await vi.advanceTimersByTimeAsync(5);
    expect([state.value, past.value]).toEqual(['resolved', 'resolved']);
  });

  it('R2: the first frame starts at 0.5 s; seeking to 0 (and to 0.4 s) draws that first frame', async () => {
    const el = video({ shown: 0.5, onSeek: () => fire(el, 'onseeked') });
    const at0 = track(showFrameAt(el, 0, 30, 1800));
    const later = video({ shown: 0.5, frameUs: null, onSeek: () => fire(later, 'onseeked') });
    const at12 = track(showFrameAt(later, 12 / 30, 30, 1800));
    await vi.advanceTimersByTimeAsync(5);
    expect([at0.value, at12.value]).toEqual(['resolved', 'resolved']);
  });

  it('R2: past the first frame, that first frame still shown is stale and refused', async () => {
    const el = video({ shown: 0.5, onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 1, 30, 500));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.value).toBe(`rejected: ${NAMED}`);
  });

  it('R2: a frame after the time only passes as the first frame: a later frame the element moved to is refused', async () => {
    // A fresh element (the sandbox never reuses one) shows frame 0; after seeking to 1 s it shows the frame at 2 s.
    const el = video({ onSeek: () => { el.shown = 2; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 1, 30, 500));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.value).toBe(`rejected: ${NAMED}`);
  });

  it('CF2-m1: Chromium has moved the position to the first frame\'s time (0.5 s); frames 0–10 draw that frame, 1 s does not', async () => {
    const offset = () => { const el = video({ shown: 0.5 }); el.currentTime = 0.5; el.seeks.length = 0; el.onSeek = () => fire(el, 'onseeked'); return el; };
    const states = Array.from({ length: 11 }, (_, f) => track(showFrameAt(offset(), f / 30, 30, 500)));
    const past = track(showFrameAt(offset(), 1, 30, 500));
    await vi.advanceTimersByTimeAsync(5);
    expect(states.map(s => s.value)).toEqual(Array(11).fill('resolved'));
    await vi.advanceTimersByTimeAsync(495);
    expect(past.value).toBe(`rejected: ${NAMED}`);
  });

  it('R3: one video frame in a 3 s file; seeking to 1 s draws that frame, proven by the track\'s frame list', async () => {
    const el = video({ duration: 3, onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 1, 30, 1800, [0]));
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
  });

  it('R3 without the frame list: the element cannot prove no later frame exists, so the hold fails by name', async () => {
    const el = video({ duration: 3, onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 1, 30, 500));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.value).toBe(`rejected: ${NAMED}`);
  });
});

describe('showFrameAt with the track\'s frame list', () => {
  it('a stale frame 0 is refused until the listed frame at the time is shown', async () => {
    const el = video({ onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 4 / 30, 30, 1800, starts30(120)));
    await vi.advanceTimersByTimeAsync(200);
    expect(state.value).toBe('pending');
    el.shown = 4 / 30;
    await vi.advanceTimersByTimeAsync(10);
    expect(state.value).toBe('resolved');
  });

  it('a stale frame that never changes fails by name; so do a later and an earlier frame than the listed one', async () => {
    const values = [];
    for (const shown of [0, 5 / 30, 3 / 30]) {
      const el = video({ onSeek: () => { el.shown = shown; fire(el, 'onseeked'); } });
      values.push(track(showFrameAt(el, 4 / 30, 30, 300, starts30(120))));
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(values.map(v => v.value)).toEqual([`rejected: ${NAMED}`, `rejected: ${NAMED}`, `rejected: ${NAMED}`]);
  });

  it('frames 1 s apart that the element reports as 1/30 s long: inside frame 0\'s second, frame 0 is drawn', async () => {
    // Chromium reports a sparse WebM's frames with the container's default duration, not the gap to the next frame.
    const el = video({ duration: 3.04, onSeek: () => fire(el, 'onseeked') });
    const state = track(showFrameAt(el, 0.5, 30, 1800, [0, 1, 2, 3]));
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
  });

  it('the first frame at 0.5 s: before it, that frame; after it, the listed frame and not the first one', async () => {
    const list = starts30(105, 0.5);
    const el = video({ shown: 0.5, onSeek: () => fire(el, 'onseeked') });
    const before = track(showFrameAt(el, 0, 30, 1800, list));
    const late = video({ shown: 0.5, onSeek: () => fire(late, 'onseeked') });
    const after = track(showFrameAt(late, 0.6, 30, 1800, list));
    await vi.advanceTimersByTimeAsync(100);
    expect([before.value, after.value]).toEqual(['resolved', 'pending']);
    late.shown = 0.6;
    await vi.advanceTimersByTimeAsync(10);
    expect(after.value).toBe('resolved');
  });

  it('past the end: the listed last frame', async () => {
    const el = video({ duration: 4, onSeek: () => { el.shown = 3.5; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 10, 30, 1800, starts30(106)));
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
  });

  // Review CF2-B1: Chromium truncates a seek time to whole microseconds, and shows the last frame at or before that.
  const ntsc = Array.from({ length: 120 }, (_, i) => i * 1001 / 30000);
  const truncating = (list: number[]) => { const el = video({ onSeek: t => { el.shown = frameStartAt(list, Math.floor(t * 1e6) / 1e6); fire(el, 'onseeked'); } }); return el; };

  it('CF2-B1: a 29.97 fps frame start equal to the time plus the nudge is drawn: the seek goes inside that frame, not to its start', async () => {
    expect(ntsc[30]).toBe(1 + Math.min(0.001, 0.5 / 30)); // the same double: a seek there shows frame 29 (1000999 µs)
    const el = truncating(ntsc);
    const state = track(showFrameAt(el, 1, 30, 500, ntsc));
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
    expect(el.shown).toBe(ntsc[30]);
    expect(el.seeks[0]).toBeGreaterThan(ntsc[30]); expect(el.seeks[0]).toBeLessThan(ntsc[31]);
  });

  it('CF2-B1: 29.97 fps clip in a 30 fps graphic, source frames 29, 30, 31 and 60 draw clip frames 29, 30, 30 and 59', async () => {
    const els = [29, 30, 31, 60].map(() => truncating(ntsc));
    const states = [29, 30, 31, 60].map((f, i) => track(showFrameAt(els[i], f / 30, 30, 500, ntsc)));
    await vi.advanceTimersByTimeAsync(5);
    expect(states.map(s => s.value)).toEqual(Array(4).fill('resolved'));
    expect(els.map(el => ntsc.indexOf(el.shown!))).toEqual([29, 30, 30, 59]);
  });

  it('the last listed frame is sought inside it, within the element\'s duration', async () => {
    const el = video({ duration: 3.51, onSeek: () => { el.shown = 3.5; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 10, 30, 500, starts30(106)));
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
    expect(el.seeks).toHaveLength(1); expect(el.seeks[0]).toBeCloseTo(3.505, 9);
  });

  it('a list that does not describe the element (its pre-seek frame is not the list\'s frame there) is not used', async () => {
    // With the list, frame 0.5 would be required at 0.75 s; the element's own spans accept the frame it moved to.
    const el = video({ onSeek: () => { el.shown = 0.75; fire(el, 'onseeked'); } });
    const state = track(showFrameAt(el, 0.75, 30, 1800, [0.5, 1]));
    await vi.advanceTimersByTimeAsync(5);
    expect(state.value).toBe('resolved');
  });
});

describe('frameStartAt', () => {
  it('is the last start at or before the time; before the first frame, the first frame', () => {
    const list = [0.5, 1, 2];
    expect([0, 0.5, 0.75, 1, 1.5, 2, 99].map(t => frameStartAt(list, t))).toEqual([0.5, 0.5, 0.5, 1, 1, 2, 2]);
  });
});

describe('currentFrame (the rasterise check: no frame fails MG_RENDER_FAILED instead of drawing a blank)', () => {
  it('is undefined with no decoded frame: readyState < 2, videoWidth 0, or VideoFrame cannot read one', () => {
    expect(currentFrame(video({ readyState: 1 }))).toBeUndefined();
    expect(currentFrame(video({ videoWidth: 0 }))).toBeUndefined();
    expect(currentFrame(video({ shown: null }))).toBeUndefined();
  });

  it('is the frame start and duration in seconds; an unknown duration is 0', () => {
    expect(currentFrame(video({ shown: 0.5 }))).toEqual({ start: 0.5, duration: 0.033333 });
    expect(currentFrame(video({ shown: 0.5, frameUs: null }))).toEqual({ start: 0.5, duration: 0 });
  });

  it('without WebCodecs, any decoded frame counts, with no start', () => {
    vi.unstubAllGlobals();
    expect(currentFrame(video({ readyState: 2 }))).toEqual({ start: NaN, duration: 0 });
    expect(currentFrame(video({ readyState: 1 }))).toBeUndefined();
  });
});
