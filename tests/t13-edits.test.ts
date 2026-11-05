// SPDX-License-Identifier: AGPL-3.0-only
// T13 inspector edits: addFade / setKeepPitch through the T03 runtime ("Edit items"), and a fade through the mix engine.
// Oracle: the T13 ticket (fade = two volume keyframes, 0 at the clip edge and the current value 1 s inside, capped at half the clip),
// keyframe times on the trim axis in ms, gain = track × volume² (findings §7 / §40, G-09 formula).
import { describe, expect, it } from 'vitest';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { mixFrames } from '../apps/web/src/audio/mix';
import { FS, db, kf, mkClip, mkDoc, mkTrack, rms, sine, synthSource, volume } from './t13-support';

const doc = (clip: RecordData, tracks: RecordData[] = [mkTrack('a')], more: RecordData[] = []) => mkDoc(tracks, [clip, ...more]);
const editor = (d: ProjectDocument) => createEditor(d);
// Stored in insertion order (findings part 2 §41: add appends, readers sort), so compared sorted by time.
const kfs = (d: ProjectDocument, id = 'c') => (d.items.find(i => i.id === id)!.properties.volume?.keyframes ?? []).map((k: { time: number; value: number }) => [k.time, k.value]).sort((a: number[], b: number[]) => a[0] - b[0]);
const edit = (e: ReturnType<typeof editor>, i: object) => e.intent(i as never);

describe('addFade', () => {
  it('fade-in on a 10 s clip at volume 0.8: 0 at the clip start, 0.8 at 1 s', () => {
    const e = editor(doc(mkClip('c', 'a', 2000, 12000, { properties: volume(0.8) })));
    expect(edit(e, { type: 'addFade', itemId: 'c', edge: 'in' })).toEqual({ ok: true });
    expect(kfs(e.doc)).toEqual([[0, 0], [1000, 0.8]]);
  });
  it('fade-out mirrors it: 0.8 at 9 s, 0 at the clip end (trim axis)', () => {
    const e = editor(doc(mkClip('c', 'a', 2000, 12000, { properties: volume(0.8) })));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'out' });
    expect(kfs(e.doc)).toEqual([[9000, 0.8], [10000, 0]]);
  });
  it('a clip with a trim offset stores the keyframes on the trim axis', () => {
    const e = editor(doc(mkClip('c', 'a', 2000, 12000, { trim: { from: 3000 }, properties: volume(0.8) })));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    expect(kfs(e.doc)).toEqual([[3000, 0], [4000, 0.8]]);
  });
  it('a clip with default volume 1 fades to 1', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 5000)));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    expect(kfs(e.doc)).toEqual([[0, 0], [1000, 1]]);
  });
  it('a 1.2 s clip fades over 0.6 s (half the clip), both edges', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 1200)));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    expect(kfs(e.doc)).toEqual([[0, 0], [600, 1]]);
    const f = editor(doc(mkClip('c', 'a', 0, 1200)));
    edit(f, { type: 'addFade', itemId: 'c', edge: 'out' });
    expect(kfs(f.doc)).toEqual([[600, 1], [1200, 0]]);
  });
  it('a clip of exactly 2 s uses the full 1 s fade; 1.99 s uses 0.995 s', () => {
    const a = editor(doc(mkClip('c', 'a', 0, 2000))); edit(a, { type: 'addFade', itemId: 'c', edge: 'in' }); expect(kfs(a.doc)[1][0]).toBe(1000);
    const b = editor(doc(mkClip('c', 'a', 0, 1990))); edit(b, { type: 'addFade', itemId: 'c', edge: 'in' }); expect(kfs(b.doc)[1][0]).toBe(995);
  });
  it('with existing volume keyframes the inner value is the interpolated value there, not 0', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 10000, { properties: volume(1, [kf(0, 0.2), kf(2000, 0.6)]) })));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    const k = kfs(e.doc); // 0 at the edge replaces the keyframe at 0; at 1 s the line 0.2 → 0.6 gives 0.4
    expect(k).toHaveLength(3); expect(k[0]).toEqual([0, 0]); expect(k[1][0]).toBe(1000); expect(k[1][1]).toBeCloseTo(0.4, 6); expect(k[2]).toEqual([2000, 0.6]);
  });
  it('fade-out over existing keyframes captures the value at 1 s before the end', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 10000, { properties: volume(1, [kf(8000, 0.5), kf(10000, 1)]) })));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'out' });
    const k = kfs(e.doc); expect(k[k.length - 1]).toEqual([10000, 0]);
    const inner = k.find((x: number[]) => x[0] === 9000)!; expect(inner[1]).toBeCloseTo(0.75, 6);
  });
  it('one "Edit items" undo entry per press; undo restores the document exactly; redo reapplies', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 10000))), before = JSON.stringify(e.doc);
    edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label: 'Edit items', source: 'user' }); expect(e.journal).toHaveLength(1);
    edit(e, { type: 'addFade', itemId: 'c', edge: 'out' });
    expect(e.bus.undoStack).toHaveLength(2); expect(kfs(e.doc)).toHaveLength(4);
    edit(e, { type: 'undo' }); expect(kfs(e.doc)).toHaveLength(2);
    edit(e, { type: 'undo' }); expect(JSON.stringify(e.doc)).toBe(before);
    edit(e, { type: 'redo' }); expect(kfs(e.doc)).toHaveLength(2);
  });
  it('pressing the same fade twice does not duplicate keyframes', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 10000)));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'in' }); edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    expect(kfs(e.doc)).toHaveLength(2);
  });
  it('a video clip takes the fade too (volume is animatable on video)', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 10000, { type: 'video' }), [mkTrack('a', { kind: 'video' })]));
    expect(edit(e, { type: 'addFade', itemId: 'c', edge: 'in' })).toEqual({ ok: true });
    expect(kfs(e.doc)).toEqual([[0, 0], [1000, 1]]);
  });
  it('refusals leave the document, undo stack and journal untouched: unknown item, locked track', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 10000), [mkTrack('a', { locked: true })])), before = JSON.stringify(e.doc);
    expect(edit(e, { type: 'addFade', itemId: 'c', edge: 'in' })).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
    expect(edit(e, { type: 'addFade', itemId: 'nope', edge: 'in' })).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND' });
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('a text clip has no volume to fade: refused, unchanged', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 10000, { type: 'text' }))), before = JSON.stringify(e.doc);
    const r = edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    expect(r).toMatchObject({ ok: false }); expect(JSON.stringify(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0);
  });
});

describe('setKeepPitch', () => {
  it('on sets keepPitch true, off removes the field; round-trips to the original document', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 5000))), before = JSON.stringify(e.doc);
    expect(edit(e, { type: 'setKeepPitch', itemId: 'c', on: true })).toEqual({ ok: true });
    expect(e.doc.items[0].keepPitch).toBe(true);
    edit(e, { type: 'setKeepPitch', itemId: 'c', on: false });
    expect('keepPitch' in e.doc.items[0]).toBe(false); expect(JSON.stringify(e.doc)).toBe(before);
  });
  it('one "Edit items" entry per toggle; undo restores', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 5000)));
    edit(e, { type: 'setKeepPitch', itemId: 'c', on: true });
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label: 'Edit items', source: 'user' }); expect(e.journal).toHaveLength(1);
    edit(e, { type: 'undo' }); expect('keepPitch' in e.doc.items[0]).toBe(false);
    edit(e, { type: 'redo' }); expect(e.doc.items[0].keepPitch).toBe(true);
  });
  it('a video clip is accepted', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 5000, { type: 'video' }), [mkTrack('a', { kind: 'video' })]));
    expect(edit(e, { type: 'setKeepPitch', itemId: 'c', on: true })).toEqual({ ok: true }); expect(e.doc.items[0].keepPitch).toBe(true);
  });
  it.each(['text', 'image', 'shape', 'caption'])('a %s clip is refused with INVALID_ITEM_TYPE', type => {
    const e = editor(doc(mkClip('c', 'a', 0, 5000, { type }))), before = JSON.stringify(e.doc);
    expect(edit(e, { type: 'setKeepPitch', itemId: 'c', on: true })).toMatchObject({ ok: false, code: 'INVALID_ITEM_TYPE' });
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('a locked track refuses with TRACK_LOCKED; an unknown item with ITEM_NOT_FOUND', () => {
    const e = editor(doc(mkClip('c', 'a', 0, 5000), [mkTrack('a', { locked: true })])), before = JSON.stringify(e.doc);
    expect(edit(e, { type: 'setKeepPitch', itemId: 'c', on: true })).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
    expect(edit(e, { type: 'setKeepPitch', itemId: 'zz', on: true })).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND' });
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0);
  });
});

describe('a fade through the mix engine (default mode)', () => {
  const mix = async (d: ProjectDocument) => (await mixFrames(d, 0, 4 * FS, { source: synthSource({ c: sine(1000, 1) }, 4), mode: 'default' }))[0];
  const levelAt = (x: Float32Array, ms: number) => { const a = Math.round(ms * 48) - 240; return db(rms(x, a, a + 480)); };
  const full = db(Math.SQRT1_2);
  it('fade-in of a constant 1 kHz sine at volume 1: gain = ramp² — −12.04 dB at 0.5 s, silent at 0, full at 1 s and after (±0.1 dB)', async () => {
    const e = editor(doc(mkClip('c', 'a', 0, 4000)));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    const k = e.doc.items[0].properties.volume.keyframes; expect(k.map((x: { easing: unknown }) => x.easing), 'the fade keyframes ease linearly').toEqual(['linear', 'linear']);
    const L = await mix(e.doc);
    expect(levelAt(L, 500) - full).toBeCloseTo(-12.04, 1);
    expect(levelAt(L, 250) - full).toBeCloseTo(20 * Math.log10(0.25 ** 2), 1);
    expect(Math.abs(L[0])).toBeLessThan(1e-6);
    expect(levelAt(L, 1500) - full).toBeCloseTo(0, 1); expect(levelAt(L, 3500) - full).toBeCloseTo(0, 1);
  });
  it('fade-out mirrors it: −12.04 dB at 0.5 s before the end, silent at the end', async () => {
    const e = editor(doc(mkClip('c', 'a', 0, 4000)));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'out' });
    const L = await mix(e.doc);
    expect(levelAt(L, 3500) - full).toBeCloseTo(-12.04, 1); expect(levelAt(L, 2000) - full).toBeCloseTo(0, 1);
    expect(Math.abs(L[4 * FS - 1])).toBeLessThan(1e-3);
  });
  it('fade-in at volume 0.8: the plateau is 0.8² = −3.88 dB', async () => {
    const e = editor(doc(mkClip('c', 'a', 0, 4000, { properties: volume(0.8) })));
    edit(e, { type: 'addFade', itemId: 'c', edge: 'in' });
    expect(levelAt(await mix(e.doc), 2000) - full).toBeCloseTo(20 * Math.log10(0.64), 1);
  });
});
