// SPDX-License-Identifier: AGPL-3.0-only
// OffthreadVideo frame readiness (T08 notes, CI fix 2). `seeked` does not mean the element shows the new frame: Chromium
// can fire it while the frame drawImage paints is still the pre-seek frame, or no frame at all, with readyState already 4.
// WebCodecs' VideoFrame(element) reads that same current frame with its media timestamp, so the wait checks the frame itself
// against the frame the source has at the seek time: the host lists each video track's frame starts (mg/index.ts).
type Frame = { start: number; duration: number };
const POLL_MS = 10, EPSILON = 1e-4;

/** The frame the element would draw now (media time in seconds; duration 0 when the container gives none), or undefined
 *  while it has none. Without WebCodecs, any decoded frame (readyState HAVE_CURRENT_DATA) counts, with start NaN. */
export function currentFrame(el: HTMLVideoElement): Frame | undefined {
  if (el.readyState < 2 || !el.videoWidth) return undefined;
  if (typeof VideoFrame !== 'function') return { start: NaN, duration: 0 };
  let frame: VideoFrame;
  try { frame = new VideoFrame(el); } catch { return undefined; }
  const shown = { start: frame.timestamp / 1e6, duration: (frame.duration ?? 0) / 1e6 };
  frame.close(); return shown;
}

/** The start of the frame a source shows at `time`, from its frame starts (seconds, ascending): the last one at or before
 *  the time; before the first frame, the first frame. */
export function frameStartAt(starts: readonly number[], time: number): number {
  let at = starts[0];
  for (const start of starts) { if (start > time) break; at = start; }
  return at;
}

/** Seeks to `seconds` and resolves once the element shows the source's frame at that time; rejects after `timeoutMs`. The
 *  frame at the time is the last one starting at or before it plus a nudge (less than half a frame), which absorbs container
 *  timestamp rounding; past the source end, its last frame.
 *  With `starts` (the video track's frame starts, from the host) that frame is picked from the list, the element seeks to the
 *  middle of it (Chromium truncates a seek time to whole microseconds, so a time on a frame's start can show the frame
 *  before), and the shown frame must be it: neither a stale nor a missing frame passes, and a frame the element shows for a
 *  long time (a one-frame track, a sparse recording) does. Without them (a file Mediabunny cannot read) the element seeks to
 *  the nudged time and its own spans decide: a frame that starts at or before the time and covers it (a frame with no
 *  duration covers one composition frame) or replaced the frame shown before the seek; before the first frame, the first
 *  frame. That fallback cannot tell a one-frame track past its first frame from a stale frame, so it fails. */
export function showFrameAt(el: HTMLVideoElement, seconds: number, fps: number, timeoutMs: number, starts?: readonly number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let poll: ReturnType<typeof setTimeout> | undefined, before: Frame | undefined, first = false, time = 0, expected: number | undefined, seeked = false;
    const finish = (error?: Error) => { clearTimeout(timer); clearTimeout(poll); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => finish(Error(seeked ? 'Video frame was not decoded at the requested time.' : 'Video frame load timeout.')), timeoutMs);
    const matches = (frame: Frame) => {
      if (Number.isNaN(frame.start)) return true;
      if (expected !== undefined) return Math.abs(frame.start - expected) < EPSILON;
      if (frame.start > time) return first && frame.start === before!.start;
      return time < frame.start + (frame.duration || 1 / fps) || frame.start !== before!.start;
    };
    const check = () => { const frame = currentFrame(el); if (frame && matches(frame)) finish(); else poll = setTimeout(check, POLL_MS); };
    // The first frame is waited for before seeking, so a late first frame is not taken for the seek's frame.
    const seek = () => {
      before = currentFrame(el); if (!before) { poll = setTimeout(seek, POLL_MS); return; }
      // Only the first frame can start at or after the position it is shown at (Chromium moves a fresh element's position
      // to its first frame's time once that frame is decoded; the sandbox never reuses an element).
      first = before.start > el.currentTime - EPSILON;
      const nudge = Math.min(0.001, 0.5 / fps);
      // The list must describe this element's timeline: the frame it shows before the seek is the list's frame there.
      if (starts?.length && Math.abs(before.start - frameStartAt(starts, el.currentTime)) < EPSILON) {
        const at = frameStartAt(starts, seconds + nudge), next = starts.find(start => start > at);
        expected = at; time = (at + (next ?? (el.duration > at ? Math.min(at + 1 / fps, el.duration) : at + 1 / fps))) / 2;
      } else time = Math.min(seconds + nudge, Math.max(0, el.duration - nudge));
      el.onseeked = () => { seeked = true; check(); }; el.currentTime = time;
    };
    el.onerror = () => finish(Error('Video could not be loaded.'));
    if (el.readyState >= 1) seek(); else el.onloadedmetadata = seek;
  });
}
