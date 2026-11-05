// SPDX-License-Identifier: AGPL-3.0-only
// T18a ledger row 10 (unit half): `context` layout L (agent tool results §2 `context`, lines 418-462), layouts C and S → NOT_IMPLEMENTED (owner T18).
// Expected values are written out from the spec for the T03 fixture documents (units: documents store ms, results are seconds).
import { describe, expect, it } from 'vitest';
import { readContext, HINTS, WORDS_ERROR } from '../apps/web/src/agent/context';
import { contextL } from '../parity/g01';
import { build, fixture, grouped, mkItem, mkTrack, video } from './t03-fixtures';

const data = (doc: ReturnType<typeof fixture>, input: Record<string, unknown> = {}) => {
  const result = readContext(doc, input);
  if (!result.success) throw new Error(`context failed: ${JSON.stringify(result)}`);
  return result.data as Record<string, any>;
};
const flags = { muted: false, solo: false, locked: false, hidden: false, volume: 1 };

describe('t18a context layout L (row 10)', () => {
  it('row 10: the T03 fixture projects to exactly the spec shape (tracks top to bottom, captions collapsed, empty tracks kept)', () => {
    const doc = fixture();
    expect(readContext(doc)).toEqual({ success: true, data: {
      _tracks: HINTS.tracks,
      duration: 12,
      fps: doc.fps,
      canvasSize: { width: doc.size.width, height: doc.size.height },
      tracks: {
        C1: { name: 'C1', kind: 'caption', order: 4, layerIndex: 0, layer: 'top', ...flags, type: 'caption', itemCount: 3, collapsed: true, ranges: [{ start: 0, end: 6 }] },
        O1: { name: 'O1', kind: 'overlay', order: 3, layerIndex: 1, ...flags, type: 'overlay', items: [{ id: 't1', start: 1, end: 3 }] },
        V2: { name: 'V2', kind: 'video', order: 2, layerIndex: 2, ...flags, type: 'video', items: [] },
        V1: { name: 'V1', kind: 'video', order: 1, layerIndex: 3, ...flags, type: 'video', items: [{ id: 'v1', start: 0, end: 4 }, { id: 'v2', start: 4, end: 8 }, { id: 'v3', start: 10, end: 12 }] },
        A1: { name: 'A1', kind: 'audio', order: 0, layerIndex: 4, layer: 'bottom', ...flags, type: 'audio', items: [{ id: 'a1', start: 0, end: 5 }] },
      },
      layerOrder: [{ id: 'A1', type: 'track' }, { id: 'V1', type: 'track' }, { id: 'V2', type: 'track' }, { id: 'O1', type: 'track' }, { id: 'C1', type: 'track' }],
      groups: {},
      _captionNote: HINTS.captionNote,
    } });
  });

  it('row 10: key order — top level, then the track keys top to bottom', () => {
    const d = data(fixture());
    expect(Object.keys(d)).toEqual(['_tracks', 'duration', 'fps', 'canvasSize', 'tracks', 'layerOrder', 'groups', '_captionNote']);
    expect(Object.keys(d.tracks)).toEqual(['C1', 'O1', 'V2', 'V1', 'A1']);
    expect(Object.keys(d.tracks.V1)).toEqual(['name', 'kind', 'order', 'layerIndex', 'muted', 'solo', 'locked', 'hidden', 'volume', 'type', 'items']);
    expect(Object.keys(d.tracks.C1)).toEqual(['name', 'kind', 'order', 'layerIndex', 'layer', 'muted', 'solo', 'locked', 'hidden', 'volume', 'type', 'itemCount', 'collapsed', 'ranges']);
  });

  it('row 10: matches the parity projection contextL for the fixture and the grouped fixture (hint strings aside)', () => {
    for (const doc of [fixture(), grouped()]) {
      const { _tracks, _captionNote, ...rest } = data(doc);
      expect(_tracks).toBe(HINTS.tracks);
      // The spec example (results §2, line 526) shows a collapsed caption row with ranges and no `items`; contextL keeps `items` there, so drop them from its side.
      const expected = JSON.parse(JSON.stringify(contextL(doc)));
      for (const row of Object.values(expected.tracks) as Record<string, unknown>[]) if (row.collapsed) delete row.items;
      expect(JSON.parse(JSON.stringify(rest))).toEqual(expected);
      void _captionNote;
    }
  });

  it('row 10: groups are {name, hidden, locked, trackIds (bottom to top), bounds in seconds}', () => {
    const d = data(grouped());
    expect(d.groups).toEqual({ g1: { name: 'Pair', hidden: false, locked: false, trackIds: ['V1', 'V2'], bounds: { start: 0, end: 12 } } });
    expect(d.layerOrder).toEqual([{ id: 'A1', type: 'track' }, { id: 'g1', type: 'group' }, { id: 'O1', type: 'track' }]);
    expect(Object.keys(d.tracks)).toEqual(['O1', 'V2', 'V1', 'A1']);
    expect(Object.keys(d.groups.g1)).toEqual(['name', 'hidden', 'locked', 'trackIds', 'bounds']);
  });

  it('row 10: a group with no items has bounds null', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video'), mkTrack('V2', 'video')], layerOrder: [{ type: 'group', id: 'g1' }],
      groups: { g1: { id: 'g1', name: 'Empty', children: [{ type: 'track', id: 'V1' }, { type: 'track', id: 'V2' }], hidden: true, locked: true } } });
    expect(data(doc).groups).toEqual({ g1: { name: 'Empty', hidden: true, locked: true, trackIds: ['V1', 'V2'], bounds: null } });
  });

  it('row 10: an empty project reports duration 1 and no tracks; a single track is "bottom" (the second rule wins)', () => {
    expect(data(build())).toMatchObject({ duration: 1, tracks: {}, layerOrder: [], groups: {} });
    const one = data(build({ tracks: [mkTrack('V1', 'video')] }));
    expect(one.tracks.V1).toEqual({ name: 'V1', kind: 'video', order: 0, layerIndex: 0, layer: 'bottom', ...flags, type: 'video', items: [] });
  });

  it('row 10: track flags and volume are reported; volume defaults to 1', () => {
    const doc = build({ tracks: [mkTrack('A1', 'audio', { muted: true, solo: true, locked: true, hidden: true, volume: 0.25 }), { ...mkTrack('V1', 'video'), volume: undefined }] });
    const d = data(doc);
    expect(d.tracks.A1).toMatchObject({ muted: true, solo: true, locked: true, hidden: true, volume: 0.25, layer: 'bottom' });
    expect(d.tracks.V1).toMatchObject({ muted: false, volume: 1, layer: 'top' });
  });

  it('row 10: times are seconds rounded to 1 ms', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 1234, 5678.4)] });
    expect(data(doc).tracks.V1.items).toEqual([{ id: 'v1', start: 1.234, end: 5.678 }]);
  });

  it('row 10: items are sorted by start', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('late', 'V1', 5000, 6000), video('early', 'V1', 0, 1000), video('mid', 'V1', 2000, 3000)] });
    expect(data(doc).tracks.V1.items.map((i: { id: string }) => i.id)).toEqual(['early', 'mid', 'late']);
  });

  it('row 10: markers (time ≥ 0, sorted, label when set) appear without include; none → no key', () => {
    const doc = { ...fixture(), markers: [{ id: 'm3', timeMs: 9500 }, { id: 'm1', timeMs: 500, label: 'Intro' }, { id: 'neg', timeMs: -10 }, { id: 'm2', timeMs: 1234.5678 }] };
    expect(data(doc).markers).toEqual([{ time: 0.5, label: 'Intro' }, { time: 1.235 }, { time: 9.5 }]);
    expect(data(doc)).toHaveProperty('markers');
    expect(data(fixture())).not.toHaveProperty('markers');
    expect(data({ ...fixture(), markers: [{ id: 'neg', timeMs: -1 }] })).not.toHaveProperty('markers');
  });

  it('row 10: include words — timing and markers keep layout L; basic/content without types adds _note; CSV and array forms both work', () => {
    const base = data(fixture());
    expect(data(fixture(), { include: 'timing' })).toEqual(base);
    expect(data(fixture(), { include: ['markers'] })).toEqual(base);
    expect(data(fixture(), { include: 'markers, timing' })).toEqual(base);
    expect(data(fixture(), { include: 'content,timing', types: 'video' })).toEqual(data(fixture(), { types: 'video' })); // timing forces L
    for (const include of ['content', 'basic', ['basic'], 'CONTENT']) {
      const d = data(fixture(), { include });
      expect(d._note).toBe(HINTS.note);
      expect(Object.keys(d).slice(-2)).toEqual(['_captionNote', '_note']);
      const { _note, ...rest } = d;
      expect(rest).toEqual(base);
      void _note;
    }
  });

  it('row 10: layout C (content with types) → NOT_IMPLEMENTED naming owner T18', () => {
    expect(readContext(fixture(), { include: 'content', types: 'video' })).toEqual({ success: false, code: 'NOT_IMPLEMENTED', owner: 'T18',
      error: 'context layout C is not implemented yet',
      message: 'This version reads only the light overview; item content (include "content" with types) arrives with T18. Call context without include, or with include "timing" or "markers".' });
  });

  it('row 10: layout S (transcript / effects / keyframes / masks) → NOT_IMPLEMENTED naming the words asked', () => {
    expect(readContext(fixture(), { include: 'effects,keyframes' })).toEqual({ success: false, code: 'NOT_IMPLEMENTED', owner: 'T18',
      error: 'context layout S is not implemented yet',
      message: 'This version reads only the light overview; effects, keyframes details arrives with T18. Call context without include, or with include "timing" or "markers".' });
    for (const word of ['transcript', 'masks']) expect(readContext(fixture(), { include: [word] })).toMatchObject({ success: false, code: 'NOT_IMPLEMENTED', owner: 'T18', error: 'context layout S is not implemented yet' });
    // transcript_words with a full window reaches layout S too
    expect(readContext(fixture(), { include: 'transcript_words', startSeconds: 0, endSeconds: 2 })).toMatchObject({ success: false, code: 'NOT_IMPLEMENTED' });
  });

  it('row 10: transcript_words without both bounds → the spec sentence; one bound alone is not a window', () => {
    const expected = { success: false, code: 'INVALID_TOOL_INPUT', error: 'transcript_words requires startSeconds and endSeconds. Use include: "transcript" for sentence-level across the full timeline.' };
    expect(WORDS_ERROR).toBe(expected.error);
    expect(readContext(fixture(), { include: 'transcript_words' })).toEqual(expected);
    expect(readContext(fixture(), { include: 'transcript_words', startSeconds: 1 })).toEqual(expected);
    expect(readContext(fixture(), { include: 'transcript_words', endSeconds: 1 })).toEqual(expected);
  });

  it('row 10: time window lists items overlapping it; touching an edge does not count; one bound alone is ignored', () => {
    const d = data(fixture(), { startSeconds: 4, endSeconds: 5 });
    expect(d.tracks.V1.items).toEqual([{ id: 'v2', start: 4, end: 8 }]); // v1 ends at 4 (touching), v3 starts at 10
    expect(d.tracks.A1.items).toEqual([{ id: 'a1', start: 0, end: 5 }]);
    expect(d.tracks.O1.items).toEqual([]); // t1 is 1–3
    expect(d.tracks.C1).toMatchObject({ itemCount: 1, collapsed: true, ranges: [{ start: 4, end: 6 }] }); // c2 ends at 4 (touching): only c3
    expect(data(fixture(), { startSeconds: 4 })).toEqual(data(fixture()));
    expect(data(fixture(), { endSeconds: 4 })).toEqual(data(fixture()));
    expect(data(fixture(), { startSeconds: '4', endSeconds: '5' })).toEqual(data(fixture())); // strings are not numbers
  });

  it('row 10: types removes other items; a track that loses all of them is {…, itemCount, filtered:true} without items', () => {
    const d = data(fixture(), { types: 'Video' }); // case-insensitive
    expect(d.tracks.V1.items).toHaveLength(3);
    expect(d.tracks.V1).not.toHaveProperty('filteredItemCount');
    expect(d.tracks.V2).toMatchObject({ items: [] });          // empty to begin with: stays an empty list
    expect(d.tracks.A1).toEqual({ name: 'A1', kind: 'audio', order: 0, layerIndex: 4, layer: 'bottom', ...flags, type: 'audio', itemCount: 1, filtered: true });
    expect(d.tracks.O1).toMatchObject({ itemCount: 1, filtered: true });
    expect(d.tracks.O1).not.toHaveProperty('items');
    expect(d.tracks.C1).toMatchObject({ itemCount: 3, filtered: true });
  });

  it('row 10: a track that keeps some items gets filteredItemCount and filteredTypes', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 1000), mkItem('i1', 'V1', 1000, 2000, { type: 'image' }), mkItem('i2', 'V1', 2000, 3000, { type: 'image' }), mkItem('s1', 'V1', 3000, 4000, { type: 'shape' })] });
    const row = data(doc, { types: 'video' }).tracks.V1;
    expect(row.items).toEqual([{ id: 'v1', start: 0, end: 1 }]);
    expect(row.filteredItemCount).toBe(3);
    expect([...row.filteredTypes].sort()).toEqual(['image', 'shape']);
    expect(Object.keys(row).slice(-3)).toEqual(['items', 'filteredItemCount', 'filteredTypes']);
  });

  it('row 10: types including caption lists the caption items and drops _captionNote', () => {
    const d = data(fixture(), { types: 'caption' });
    expect(d.tracks.C1.items).toEqual([{ id: 'c1', start: 0, end: 2 }, { id: 'c2', start: 2, end: 4 }, { id: 'c3', start: 4, end: 6 }]);
    expect(d.tracks.C1).not.toHaveProperty('collapsed');
    expect(d).not.toHaveProperty('_captionNote');
  });

  it('row 10: captions merge into one range while the gap is ≤ 1.5 s; an empty caption track keeps items []', () => {
    const cap = (id: string, from: number, to: number) => mkItem(id, 'C1', from, to, { type: 'caption', details: { text: id } });
    const doc = build({ tracks: [mkTrack('C1', 'caption'), mkTrack('C2', 'caption')], items: [cap('a', 0, 1000), cap('b', 2500, 3000), cap('c', 4501, 5000), cap('d', 5000, 5200)] });
    const d = data(doc);
    expect(d.tracks.C1).toMatchObject({ itemCount: 4, collapsed: true, ranges: [{ start: 0, end: 3 }, { start: 4.501, end: 5.2 }] }); // gap 1.5 merges, gap 1.501 does not
    expect(d.tracks.C2).toMatchObject({ items: [] });
    expect(d.tracks.C2).not.toHaveProperty('collapsed');
  });

  it('row 10: more than 80 text items in scope collapse text tracks to a count; 80 do not', () => {
    const texts = (n: number) => Array.from({ length: n }, (_, k) => mkItem(`t${k}`, 'O1', k * 100, k * 100 + 50, { type: 'text', details: { text: 'x' } }));
    const tracks = [mkTrack('O1', 'overlay')];
    const eighty = data(build({ tracks, items: texts(80) }));
    expect(eighty.tracks.O1.items).toHaveLength(80);
    expect(eighty).not.toHaveProperty('_textOverflow');

    const over = data(build({ tracks, items: texts(81) }));
    expect(over.tracks.O1).toEqual({ name: 'O1', kind: 'overlay', order: 0, layerIndex: 0, layer: 'bottom', ...flags, type: 'text', itemCount: 81, collapsed: true });
    expect(over._textOverflow).toBe(HINTS.textOverflow);
    // with a window that brings the count to 80 or fewer the items come back
    expect(data(build({ tracks, items: texts(81) }), { startSeconds: 0, endSeconds: 7.95 }).tracks.O1.items).toHaveLength(80);
    // listing only another type keeps the overflow off (the text items are filtered out of the count)
    expect(data(build({ tracks, items: texts(81) }), { types: 'video' })).not.toHaveProperty('_textOverflow');
  });

  it('row 10: reading does not change the document', () => {
    const doc = fixture();
    const before = JSON.stringify(doc);
    readContext(doc);
    readContext(doc, { types: 'video', startSeconds: 0, endSeconds: 5, include: 'timing' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
