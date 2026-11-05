// SPDX-License-Identifier: AGPL-3.0-only
// T13 mix with T11's transitions: sound hard-cuts at the cut and each clip sounds only inside its own range. Oracle: findings
// part 5 §55.3 l.1074 ("the extended clip's audio is muted outside its own original range … Audio therefore hard-cuts at the cut;
// transitions are picture-only"), §59 point 6 (an inference from absence) and T11's QE6 (tests/ui/t11-export.spec.ts E3 (iii)).
// The export's mix and the preview's are the same mixFrames, so this covers both.
import { describe, it, expect } from 'vitest';
import { mixFrames } from '../apps/web/src/audio/mix';
import { addAtCut, editTransition, KINDS } from '../apps/web/src/timeline/transitions';
import { FS, maxAbsDiff, mkClip, mkDoc, mkTrack, synthSource } from './t13-support';

const dc = (amp: number) => () => amp;
/** V1 0–2 s (source 1–3 s) meets V2 2–4 s (source 3–5 s); a picture transition draws each past its own range. */
const pair = () => mkDoc([mkTrack('V', { kind: 'video' })], [
  mkClip('a', 'V', 0, 2000, { type: 'video', trim: { from: 1000 } }), mkClip('b', 'V', 2000, 4000, { type: 'video', trim: { from: 3000 } })]);
const source = (calls: { id: string; startS: number; endS: number }[] = []) => synthSource({ a: dc(0.25), b: dc(0.125) }, 6, calls);

describe('T11 transitions in the T13 mix', () => {
  it('a Fade at the cut (the diamond: 1 s, centre) leaves the mix unchanged: A until the cut, B from it, no crossfade', async () => {
    const plain = await mixFrames(pair(), 0, 4 * FS, { source: source() });
    const doc = pair(); addAtCut(doc, 'a', 'b');
    expect(doc.transitions).toMatchObject([{ fromId: 'a', toId: 'b', kind: 'fade', durationMs: 1000, alignment: 0.5 }]);
    const calls: { id: string; startS: number; endS: number }[] = [], [L, R] = await mixFrames(doc, 0, 4 * FS, { source: source(calls) });
    // maxAbsDiff, not toEqual: a deep compare of 192 000 floats per call is slow in vitest.
    expect(L.length).toBe(4 * FS); expect(maxAbsDiff(L, plain[0])).toBe(0); expect(maxAbsDiff(R, plain[1])).toBe(0);
    expect(L.subarray(0, 2 * FS).every(v => v === 0.25)).toBe(true); expect(L.subarray(2 * FS).every(v => v === 0.125)).toBe(true);
    // Neither source is read past its range plus the read padding (0.25 s): A's 1–3 s, B's 3–5 s.
    expect(new Set(calls.map(c => c.id))).toEqual(new Set(['a', 'b']));
    for (const c of calls) {
      if (c.id === 'a') expect(c.endS).toBeLessThanOrEqual(3.25); else expect(c.startS).toBeGreaterThanOrEqual(2.75);
    }
  });

  it('every kind and alignment, at the longest duration (2 s), mixes the same as no transition', async () => {
    const plain = await mixFrames(pair(), 0, 4 * FS, { source: source() });
    for (const kind of KINDS) for (const alignment of [0, 0.5, 1]) {
      const doc = pair(), { id } = addAtCut(doc, 'a', 'b');
      editTransition(doc, id, { kind, alignment, durationMs: 2000 });
      expect(doc.transitions).toMatchObject([{ kind, alignment, durationMs: 2000 }]);
      const [L, R] = await mixFrames(doc, 0, 4 * FS, { source: source() });
      expect(maxAbsDiff(L, plain[0]), `${kind} ${alignment}`).toBe(0); expect(maxAbsDiff(R, plain[1]), `${kind} ${alignment}`).toBe(0);
    }
  });
});
