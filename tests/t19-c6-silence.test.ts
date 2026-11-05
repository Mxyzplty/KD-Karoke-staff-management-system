// SPDX-License-Identifier: AGPL-3.0-only
// T19 C6 (CUT-P01): removeSilences(bus, itemId, words, options) on a real CommandBus over a plain host: the cuts, the ripple,
// the single undo entry, playbackRate, ranges, the refusals and the group ripple. Synthetic words; the fixture row uses the
// public CC-BY aligned words of the 30 s action clip when $CUTFRAME_FIXTURES has them. Report-only against CUT-P01's 4.38 s.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDocument } from '../apps/web/src/store/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { CommandBus } from '../apps/web/src/timeline/bus';
import { removeSilences } from '../apps/web/src/timeline/silence';
import type { Word } from '../apps/web/src/analysis/types';
import { build, itemOf, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => resetIds());

const host = (initial: ProjectDocument = emptyDocument()) => { let doc = structuredClone(initial); return { get: () => doc, set: (d: ProjectDocument) => { doc = d; }, current: () => doc }; };
const rig = (doc: ProjectDocument) => { const h = host(doc), bus = new CommandBus(h); return { h, bus, before: structuredClone(h.current()) }; };
const w = (start: number, end: number, word = 'w'): Word => ({ word, start, end });
/** Words (source s) with the gaps 1.0 s, 2.0 s and 0.5 s between them, starting at source second 1. */
const words = () => [w(1.0, 1.5), w(2.5, 3.0), w(5.0, 5.5), w(6.0, 6.5)];
/** V1: the source item `v` (display 2000–14000, trim from 1000) and a later item on the same track. */
const single = (extra: Record<string, unknown> = {}, track: Record<string, unknown> = {}) => build({
  tracks: [mkTrack('V1', 'video', track)],
  items: [video('v', 'V1', 2000, 14000, 1000, 30000, extra), video('later', 'V1', 14000, 16000)],
});
const onV1 = (doc: ProjectDocument) => doc.items.filter(i => i.trackId === 'V1').sort((a, b) => a.display.from - b.display.from);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e as { code?: string; message: string }; } throw new Error('did not throw'); };
const untouched = (r: ReturnType<typeof rig>) => { expect(r.h.current()).toEqual(r.before); expect(r.bus.undoStack).toHaveLength(0); };

describe('T19 C6 removeSilences: cuts and ripple', () => {
  it('two long gaps → two cuts of gap − 0.35 s, mapped to the timeline; three pieces; the later item closes up; no word is cut', () => {
    const r = rig(single()), res = removeSilences(r.bus, 'v', words());
    expect(res.cuts).toEqual([{ from: 2.675, to: 3.325 }, { from: 4.175, to: 5.825 }]);
    expect(res.removed).toBeCloseTo(2.3, 9);
    const pieces = onV1(r.h.current()).filter(i => i.id !== 'later');
    expect(pieces).toHaveLength(3);
    expect(pieces.map(i => [i.display.from, i.display.to])).toEqual([[2000, 2675], [2675, 3525], [3525, 11700]]);
    expect(pieces.map(i => [i.trim.from, i.trim.to])).toEqual([[1000, 1675], [2325, 3175], [4825, 13000]]);
    expect(pieces[0].id).toBe('v');
    expect(itemOf(r.h.current(), 'later').display).toEqual({ from: 11700, to: 13700 });
    expect(r.h.current().duration).toBe(13700);
    // No (mapped) word span intersects a removed span (original timeline ms).
    const at = (s: number) => Math.round(2000 + (s * 1000 - 1000));
    for (const word of words()) for (const c of res.cuts) {
      const from = at(word.start), to = at(word.end);
      expect(to <= c.from * 1000 || from >= c.to * 1000, `${word.start}-${word.end} vs ${c.from}-${c.to}`).toBe(true);
    }
  });
  it('the 0.5 s gap is not cut; a gap just over pause is; the cut starts half a kept gap after the word', () => {
    const r = rig(single());
    expect(removeSilences(r.bus, 'v', [w(1, 2), w(2.5, 3)]).cuts).toEqual([]); // 0.5 s
    expect(removeSilences(r.bus, 'v', [w(1, 2), w(2.75, 3)]).cuts).toEqual([]); // exactly the 0.75 s threshold
    expect(removeSilences(r.bus, 'v', [w(1, 2), w(2.8, 3)]).cuts).toEqual([{ from: 3.175, to: 3.625 }]); // 0.8 s: 2 + .175 … 2.8 − .175
  });
  it('options: pause and keptGap change the cuts', () => {
    const r = rig(single()), res = removeSilences(r.bus, 'v', words(), { pause: 0.4, keptGap: 0.2 });
    expect(res.cuts).toHaveLength(3); expect(res.cuts[0]).toEqual({ from: 2.6, to: 3.4 });
  });
  it('words closing the item or a single word: nothing before the first word and nothing after the last is cut', () => {
    const r = rig(single());
    expect(removeSilences(r.bus, 'v', [w(5, 6)]).cuts).toEqual([]); expect(removeSilences(r.bus, 'v', []).cuts).toEqual([]);
    untouched(r);
  });
});

describe('T19 C6 removeSilences: undo', () => {
  it('one undo entry labelled "Ripple delete" with the default source user; undo restores the exact items', () => {
    const r = rig(single()); removeSilences(r.bus, 'v', words());
    expect(r.bus.undoStack).toHaveLength(1); expect(r.bus.undoStack[0]).toMatchObject({ label: 'Ripple delete', source: 'user' });
    r.bus.undo(); expect(r.h.current().items).toEqual(r.before.items); expect(r.h.current().duration).toBe(r.before.duration);
  });
  it('the given source is recorded', () => {
    const r = rig(single()); removeSilences(r.bus, 'v', words(), { source: 'agent' });
    expect(r.bus.undoStack).toHaveLength(1); expect(r.bus.undoStack[0]).toMatchObject({ label: 'Ripple delete', source: 'agent' });
  });
  it('nothing to cut → no undo entry, the document unchanged, { cuts: [], removed: 0 }', () => {
    const r = rig(single()); expect(removeSilences(r.bus, 'v', [w(1, 2), w(2.5, 3)])).toEqual({ cuts: [], removed: 0 }); untouched(r);
  });
});

describe('T19 C6 removeSilences: playbackRate', () => {
  it('rate 2: the timeline cut is half the source cut', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('v', 'V1', 0, 6000, 0, 30000, { playbackRate: 2, trim: { from: 0, to: 12000 } })] });
    const r = rig(doc), res = removeSilences(r.bus, 'v', [w(0.5, 1.0), w(3.0, 3.5)], { keptGap: 0.4 });
    expect(res.cuts).toEqual([{ from: 0.6, to: 1.4 }]); // source 1.2–2.8 s = 1.6 s → 0.8 s
    expect(res.removed).toBeCloseTo(0.8, 9);
    const pieces = onV1(r.h.current()); expect(pieces.map(i => [i.display.from, i.display.to])).toEqual([[0, 600], [600, 5200]]);
    expect(pieces.every(i => i.playbackRate === 2)).toBe(true);
  });
});

describe('T19 C6 removeSilences: ranges', () => {
  const gaps = () => [w(0, 1), w(3, 4), w(6, 7), w(9, 9.5)]; // gaps [1,3], [4,6], [7,9]
  const item10 = () => rig(build({ tracks: [mkTrack('V1', 'video')], items: [video('v', 'V1', 0, 10000, 0, 30000)] }));
  it('a gap fully outside the ranges is not cut; a range over a gap cuts it', () => {
    const r = item10(); expect(removeSilences(r.bus, 'v', gaps(), { ranges: [[0, 3.5]] }).cuts).toEqual([{ from: 1.175, to: 2.825 }]);
  });
  it('a range partly over a gap: only the part inside, still with the margins', () => {
    const r = item10(); expect(removeSilences(r.bus, 'v', gaps(), { ranges: [[0, 1.9]] }).cuts).toEqual([{ from: 1.175, to: 1.725 }]);
  });
  it('a part inside the range that is not longer than the pause is not cut', () => {
    const r = item10(); expect(removeSilences(r.bus, 'v', gaps(), { ranges: [[0, 1.5]] }).cuts).toEqual([]); untouched(r);
  });
  it('several ranges cut each of their gaps', () => {
    const r = item10(); expect(removeSilences(r.bus, 'v', gaps(), { ranges: [[0, 3.5], [6.5, 10]] }).cuts).toEqual([{ from: 1.175, to: 2.825 }, { from: 7.175, to: 8.825 }]);
  });
  it("ranges are clipped to the item's visible source part: a gap beyond trim.to is ignored", () => {
    const r = rig(build({ tracks: [mkTrack('V1', 'video')], items: [video('v', 'V1', 0, 6000, 0, 30000)] })); // visible 0–6 s
    expect(removeSilences(r.bus, 'v', gaps(), { ranges: [[0, 100]] }).cuts).toEqual([{ from: 1.175, to: 2.825 }, { from: 4.175, to: 5.825 }]);
  });
  it('the visible part starts at trim.from: the gap before it is cut only from the visible start; the default ranges are the visible part', () => {
    const doc = () => build({ tracks: [mkTrack('V1', 'video')], items: [video('v', 'V1', 0, 4000, 2000, 30000)] }); // visible 2–6 s
    const a = rig(doc()), b = rig(doc());
    expect(removeSilences(a.bus, 'v', gaps(), { ranges: [[0, 100]] }).cuts).toEqual([{ from: 0.175, to: 0.825 }, { from: 2.175, to: 3.825 }]);
    expect(removeSilences(b.bus, 'v', gaps()).cuts).toEqual([{ from: 0.175, to: 0.825 }, { from: 2.175, to: 3.825 }]);
  });
  it('a range wholly outside the visible part leaves everything alone', () => {
    const r = item10(); expect(removeSilences(r.bus, 'v', gaps(), { ranges: [[20, 30]] })).toEqual({ cuts: [], removed: 0 }); untouched(r);
  });
});

describe('T19 C6 removeSilences: refusals leave the document and the undo stack untouched', () => {
  it('unknown id → ITEM_NOT_FOUND', () => {
    const r = rig(single()); expect(code(() => removeSilences(r.bus, 'nope', words()))).toMatchObject({ code: 'ITEM_NOT_FOUND' }); untouched(r);
  });
  it('image and text items → INVALID_ANALYSIS_INPUT "Silence removal needs a video or audio item."', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')], items: [mkItem('img', 'V1', 0, 5000, { type: 'image' }), mkItem('txt', 'O1', 0, 5000, { type: 'text', details: { text: 'x' } })] });
    for (const id of ['img', 'txt']) { const r = rig(doc); expect(code(() => removeSilences(r.bus, id, words()))).toMatchObject({ code: 'INVALID_ANALYSIS_INPUT', message: 'Silence removal needs a video or audio item.' }); untouched(r); }
  });
  it('an audio item is accepted', () => {
    const doc = build({ tracks: [mkTrack('A1', 'audio')], items: [mkItem('a', 'A1', 0, 8000, { type: 'audio', trim: { from: 0, to: 8000 }, sourceDuration: 30000 })] });
    const r = rig(doc); expect(removeSilences(r.bus, 'a', [w(0, 1), w(3, 4)]).cuts).toEqual([{ from: 1.175, to: 2.825 }]);
  });
  it('a time-remapped item → INVALID_ANALYSIS_INPUT "Silence removal does not support time-remapped items."', () => {
    const r = rig(single({ timeRemap: { keyframes: [{ time: 0, value: 0 }, { time: 12000, value: 12000 }] } }));
    expect(code(() => removeSilences(r.bus, 'v', words()))).toMatchObject({ code: 'INVALID_ANALYSIS_INPUT', message: 'Silence removal does not support time-remapped items.' }); untouched(r);
  });
  it('an empty timeRemap.keyframes list is not a remap', () => {
    const r = rig(single({ timeRemap: { keyframes: [] } })); expect(removeSilences(r.bus, 'v', words()).cuts).toHaveLength(2);
  });
  it('a locked track → TRACK_LOCKED (from the split)', () => {
    const r = rig(single({}, { locked: true })); expect(code(() => removeSilences(r.bus, 'v', words()))).toMatchObject({ code: 'TRACK_LOCKED' }); untouched(r);
  });
  it('keptGap greater than pause → INVALID_ANALYSIS_INPUT', () => {
    const r = rig(single()); expect(code(() => removeSilences(r.bus, 'v', words(), { pause: 0.5, keptGap: 0.6 }))).toMatchObject({ code: 'INVALID_ANALYSIS_INPUT' }); untouched(r);
  });
  it('a failing run does not leave the bus busy: the next run works', () => {
    const r = rig(single()); code(() => removeSilences(r.bus, 'nope', words()));
    expect(r.bus.running).toBe(false); expect(removeSilences(r.bus, 'v', words()).cuts).toHaveLength(2);
  });
});

describe('T19 C6 removeSilences: an item inside a track group', () => {
  it('both cuts ripple as group ripples (no RIPPLE_NOT_CONTINUOUS); the group sibling closes up; label "Ripple group delete"', () => {
    const doc = build({
      tracks: [mkTrack('V1', 'video'), mkTrack('V2', 'video')], layerOrder: [{ type: 'group', id: 'g1' }],
      groups: { g1: { id: 'g1', name: 'Pair', children: [{ type: 'track', id: 'V1' }, { type: 'track', id: 'V2' }], hidden: false, locked: false } },
      items: [video('v', 'V1', 0, 10000, 0, 30000), video('later', 'V1', 10000, 12000), video('side', 'V2', 8000, 9500)],
    });
    const r = rig(doc), res = removeSilences(r.bus, 'v', [w(0, 1), w(3, 4), w(7, 8)]);
    expect(res.cuts).toEqual([{ from: 1.175, to: 2.825 }, { from: 4.175, to: 6.825 }]); expect(res.removed).toBeCloseTo(4.3, 9);
    expect(r.bus.undoStack).toHaveLength(1); expect(r.bus.undoStack[0]).toMatchObject({ label: 'Ripple group delete', source: 'user' });
    const d = r.h.current();
    expect(onV1(d).filter(i => i.id !== 'later').map(i => [i.display.from, i.display.to])).toEqual([[0, 1175], [1175, 2525], [2525, 5700]]);
    expect(itemOf(d, 'later').display).toEqual({ from: 5700, to: 7700 });
    expect(itemOf(d, 'side').display).toEqual({ from: 3700, to: 5200 });
    r.bus.undo(); expect(r.h.current().items).toEqual(r.before.items);
  });
});

describe('T19 C6 removeSilences: fixture row (public CC-BY aligned words of the 30 s action clip)', () => {
  const root = process.env.CUTFRAME_FIXTURES, file = root ? path.join(root, 'datasets', 'speech', 'tos-action-30s-aligned.json') : '';
  it.skipIf(!root || !existsSync(file))('ranges [0, 7.74] and [19.18, 30] → 3 cuts, 4.290 s removed (CUT-P01 4.38 s is report-only)', () => {
    const aligned = JSON.parse(readFileSync(file, 'utf8')) as { words: { text: string; startMs: number; endMs: number }[] };
    const spoken = aligned.words.map(x => w(x.startMs / 1000, x.endMs / 1000, x.text));
    const r = rig(build({ tracks: [mkTrack('V1', 'video')], items: [video('clip', 'V1', 0, 30000, 0, 30000)] }));
    const res = removeSilences(r.bus, 'clip', spoken, { ranges: [[0, 7.74], [19.18, 30]] });
    const expected = [[2.755, 5.025], [21.295, 22.725], [26.275, 26.865]];
    expect(res.cuts).toHaveLength(3);
    res.cuts.forEach((c, i) => { expect(Math.abs(c.from - expected[i][0])).toBeLessThanOrEqual(0.001); expect(Math.abs(c.to - expected[i][1])).toBeLessThanOrEqual(0.001); });
    expect(Math.abs(res.removed - 4.29)).toBeLessThanOrEqual(0.001);
    console.info(`[T19 C6] removed ${res.removed.toFixed(3)} s vs CUT-P01 reference 4.38 s (report-only, delta ${(res.removed - 4.38).toFixed(3)} s)`);
  });
});
