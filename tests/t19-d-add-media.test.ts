// SPDX-License-Identifier: AGPL-3.0-only
// T19 D: addMedia `transcriptRange` through the real Executor + Ledger over a real T03 runtime (store rows faked via the
// `analysis` option). Synthetic words only.
import { describe, expect, it, vi } from 'vitest';
import { Executor, NEVER_READ, NO_PROJECT } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { RANGE } from '../apps/web/src/analysis/ranges';
import type { Word } from '../apps/web/src/analysis/types';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, fixture, links } from './t03-fixtures';

type Rec = Record<string, any>;
/** Word i starts at i * 0.5 s and lasts 0.4 s. */
const say = (text: string): Word[] => text.split(' ').map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4 }));
// asset-vid1 (video_1, 10 s): alpha0 beta1 gamma2 delta3 epsilon4 zeta5 eta6 theta7 iota8 kappa9 lambda10 mu11
const ONE = say('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu alpha beta');
// asset-vid2 (video_2, 6 s)
const TWO = say('red orange yellow green blue indigo violet');
const rowOf = (id: string, words: Word[]) => ({ id, status: 'complete', transcript: { words }, created_at: 'x' });

const fakeStorage = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
let seq = 0;
const call = (toolName: string, input: Rec = {}, extra: Partial<Call> = {}): Call => ({ type: 'call', callId: `c${++seq}`, executionKey: `mcp:conn:c${seq}`, toolName, input, session: 's', ...extra });

function rig(o: { rows?: Rec; analysisFails?: Error; rowFails?: Error; noProject?: boolean } = {}) {
  const rows: Rec = o.rows ?? { 'asset-vid1': rowOf('asset-vid1', ONE), 'asset-vid2': rowOf('asset-vid2', TWO) };
  const reads: string[] = [];
  const store = { row: vi.fn(async (s: string, id: string) => { reads.push(`${s}:${id}`); if (o.rowFails) throw o.rowFails; return s === 'transcripts' ? rows[id] : undefined; }) };
  const analysis = vi.fn(async () => { if (o.analysisFails) throw o.analysisFails; return { store, service: {} }; });
  const editor = createEditor(fixture(), { assets: assets(), links: links() });
  const ex = new Executor({ storage: fakeStorage(), current: () => o.noProject ? undefined : editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }), analysis: analysis as never });
  const read = () => ex.execute(call('context'));
  const add = (input: Rec, extra: Partial<Call> = {}) => ex.execute(call('addMedia', input, extra)) as Promise<Rec>;
  const doc = () => JSON.stringify(editor.runtime.bus.doc);
  const onTrack = (id: string) => editor.runtime.bus.doc.items.filter(i => i.trackId === id);
  return { editor, ex, store, analysis, reads, read, add, doc, onTrack, undo: () => editor.runtime.bus.undoStack };
}

describe('T19 D addMedia transcriptRange: placement', () => {
  it('single: the words become the source trim; one "Add media" undo entry; resolved range on the result; timelineChanges', async () => {
    const r = rig(); await r.read();
    const res = await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma delta' } });
    const range = { trimStart: 1, trimEnd: 1.9, duration: 0.9, wordCount: 2, matchedText: 'gamma delta' };
    expect(res).toMatchObject({ success: true, message: 'Successfully added 1 media item to timeline' });
    expect(res.data.results[0]).toMatchObject({ assetId: 'video_1', success: true, resolvedTrim: { start: 1, end: 1.9, duration: 0.9 }, resolvedTranscriptRange: range });
    expect(res.data.resolvedTranscriptRanges).toEqual([range]);
    expect(res.data.addedItemIds).toHaveLength(1);
    expect(r.onTrack('V2')).toHaveLength(1);
    expect(r.onTrack('V2')[0]).toMatchObject({ id: res.data.addedItemIds[0], display: { from: 0, to: 900 }, trim: { from: 1000, to: 1900 }, metadata: { assetId: 'asset-vid1' } });
    expect(res.timelineChanges.items.created).toHaveLength(1);
    expect(r.undo().filter(e => e.label === 'Add media')).toHaveLength(1);
    expect(r.undo().at(-1)).toMatchObject({ label: 'Add media', source: 'agent' });
  });
  it('one undo reverts the whole add', async () => {
    const r = rig(); await r.read();
    const before = r.doc(); const depth = r.undo().length;
    await r.add({ trackId: 'V2', timelineStart: 0, items: [{ assetId: 'video_1', transcriptRange: { text: 'zeta' } }, { assetId: 'video_2', transcriptRange: { text: 'green' } }] });
    expect(r.undo()).toHaveLength(depth + 1);
    r.editor.runtime.bus.undo();
    expect(r.doc()).toBe(before);
  });
  it('startText + endText', async () => {
    const r = rig(); await r.read();
    const res = await r.add({ trackId: 'V2', timelineStart: 2, assetId: 'video_1', transcriptRange: { startText: 'delta', endText: 'zeta' } });
    expect(res.data.results[0].resolvedTranscriptRange).toMatchObject({ trimStart: 1.5, trimEnd: 2.9, wordCount: 3, matchedText: 'delta epsilon zeta' });
    expect(r.onTrack('V2')[0]).toMatchObject({ display: { from: 2000, to: 3400 }, trim: { from: 1500, to: 2900 } });
  });
  it('batch with mixed items: ranges resolved, a plain numeric item as it is, items chained back to back; ranges listed in order', async () => {
    const r = rig(); await r.read();
    const res = await r.add({ trackId: 'V2', timelineStart: 0, items: [
      { assetId: 'video_1', transcriptRange: { text: 'gamma delta' } }, { assetId: 'video_2', trimStart: 1, trimEnd: 3 }, { assetId: 'video_2', transcriptRange: { startText: 'yellow', endText: 'blue' } }] });
    expect(res.success).toBe(true);
    expect(res.data.summary).toEqual({ total: 3, succeeded: 3, failed: 0 });
    expect(res.data.results[0].resolvedTranscriptRange).toMatchObject({ trimStart: 1, trimEnd: 1.9 });
    expect(res.data.results[1]).not.toHaveProperty('resolvedTranscriptRange');
    expect(res.data.results[1].resolvedTrim).toEqual({ start: 1, end: 3, duration: 2 });
    expect(res.data.results[2].resolvedTranscriptRange).toMatchObject({ trimStart: 1, trimEnd: 2.4, wordCount: 3, matchedText: 'yellow green blue' });
    expect(res.data.resolvedTranscriptRanges).toHaveLength(2);
    expect(res.data.resolvedTranscriptRanges.map((x: Rec) => x.matchedText)).toEqual(['gamma delta', 'yellow green blue']);
    expect(r.onTrack('V2').map(i => [i.display.from, i.display.to])).toEqual([[0, 900], [900, 2900], [2900, 4300]]);
    expect(r.undo().filter(e => e.label === 'Add media')).toHaveLength(1);
  });
  it('the range is clamped to the source length: words past the asset duration cannot overrun it', async () => {
    const rows = { 'asset-vid2': rowOf('asset-vid2', [...TWO, { word: 'late', start: 5.5, end: 6.4 }]) }; // video_2 is 6 s; the last word ends past it
    const r = rig({ rows }); await r.read();
    const res = await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_2', transcriptRange: { startText: 'violet', endText: 'late' } });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(res.data.results[0].resolvedTranscriptRange).toMatchObject({ trimStart: 3, trimEnd: 6, wordCount: 2 });
    expect(r.onTrack('V2')[0].trim).toEqual({ from: 3000, to: 6000 });
  });
  it('args without a range never touch the analysis dependencies and add as before', async () => {
    const r = rig(); await r.read();
    const res = await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_2', trimStart: 1, trimEnd: 4 });
    expect(res.success).toBe(true); expect(res.data).not.toHaveProperty('resolvedTranscriptRanges');
    expect(r.analysis).not.toHaveBeenCalled();
  });
});

describe('T19 D addMedia transcriptRange: the timeline gate', () => {
  it('never read → STALE_READ_REFRESHED (scope timeline) before any transcript is read; nothing added', async () => {
    const r = rig(); const before = r.doc();
    const res = await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } });
    expect(res).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', scope: 'timeline', message: NEVER_READ });
    expect(r.analysis).not.toHaveBeenCalled(); expect(r.store.row).not.toHaveBeenCalled();
    expect(r.doc()).toBe(before); expect(r.undo()).toHaveLength(0);
  });
  it('the gate comes before range errors: a bad range on a never-read session is still STALE_READ_REFRESHED', async () => {
    for (const transcriptRange of [{ text: 'nothing here' }, {}, 'x']) {
      const r = rig(); // a refusal counts as a read, so each case needs a fresh session
      expect(await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange }), JSON.stringify(transcriptRange)).toMatchObject({ code: 'STALE_READ_REFRESHED' });
      expect(r.store.row).not.toHaveBeenCalled();
    }
  });
  it('the refusal counts as a read: the retry is judged on its merits and succeeds', async () => {
    const r = rig();
    expect(await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } })).toMatchObject({ code: 'STALE_READ_REFRESHED' });
    expect(await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } })).toMatchObject({ success: true });
  });
  it('a user change after the read refuses again, with the attached current state, before any transcript is read', async () => {
    const r = rig(); await r.read();
    expect(r.editor.intent({ type: 'addMarker', timeMs: 500 })).toEqual({ ok: true });
    const res = await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } });
    expect(res).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', scope: 'timeline' });
    expect(res.message).toMatch(/^The user modified the timeline at /);
    expect(res.currentState.data.markers).toEqual([{ time: 0.5 }]);
    expect(r.store.row).not.toHaveBeenCalled(); expect(r.onTrack('V2')).toHaveLength(0);
  });
  it('a session that has read is not affected by another session never reading', async () => {
    const r = rig(); await r.read();
    expect(await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } }, { session: 'other' })).toMatchObject({ code: 'STALE_READ_REFRESHED' });
    expect(await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } })).toMatchObject({ success: true });
  });
});

describe('T19 D addMedia transcriptRange: failures change nothing', () => {
  const RANGE_FAILS: [string, Rec, string, string][] = [
    ['range with trimStart', { assetId: 'video_1', trimStart: 1, transcriptRange: { text: 'gamma' } }, 'INVALID_COMBINATION', RANGE.combination],
    ['range with duration', { assetId: 'video_1', duration: 1, transcriptRange: { text: 'gamma' } }, 'INVALID_COMBINATION', RANGE.combination],
    ['unknown asset', { assetId: 'video_99', transcriptRange: { text: 'gamma' } }, 'MEDIA_NOT_FOUND', RANGE.media],
    ['wrong form', { assetId: 'video_1', transcriptRange: { text: 'gamma', startText: 'a' } }, 'INVALID_TRANSCRIPT_RANGE', RANGE.form],
    ['not an object', { assetId: 'video_1', transcriptRange: 'gamma' }, 'INVALID_TRANSCRIPT_RANGE', RANGE.form],
    ['no stored transcript', { assetId: 'audio_1', transcriptRange: { text: 'gamma' } }, 'TRANSCRIPT_UNAVAILABLE', RANGE.unavailable],
    ['words not found', { assetId: 'video_1', transcriptRange: { text: 'gamma epsilon' } }, 'TRANSCRIPT_RANGE_NOT_FOUND', RANGE.notFound],
    ['ambiguous', { assetId: 'video_1', transcriptRange: { text: 'alpha' } }, 'AMBIGUOUS_TRANSCRIPT_RANGE', RANGE.ambiguous(2)],
  ];
  it.each(RANGE_FAILS)('%s → the registry code and message; document and undo stack untouched', async (_n, item, code, message) => {
    const r = rig(); await r.read();
    const before = r.doc(), depth = r.undo().length;
    const res = await r.add({ trackId: 'V2', timelineStart: 0, ...item });
    expect(res).toMatchObject({ success: false, code, error: message, message });
    expect(res.details.assetId).toBe(item.assetId);
    expect(r.doc()).toBe(before); expect(r.undo()).toHaveLength(depth);
  });
  it('ambiguous: details.candidates with trims, count, matched text and context', async () => {
    const r = rig(); await r.read();
    const res = await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'alpha' } });
    expect(res.details.candidates).toEqual([
      { trimStart: 0, trimEnd: 0.4, wordCount: 1, matchedText: 'alpha', context: 'alpha beta gamma delta epsilon zeta' },
      { trimStart: 6, trimEnd: 6.4, wordCount: 1, matchedText: 'alpha', context: 'theta iota kappa lambda mu alpha beta' },
    ]);
  });
  it('in a batch the first bad range refuses the whole add: earlier good items are not placed', async () => {
    const r = rig(); await r.read();
    const before = r.doc();
    const res = await r.add({ trackId: 'V2', timelineStart: 0, items: [
      { assetId: 'video_1', transcriptRange: { text: 'gamma' } }, { assetId: 'video_2', transcriptRange: { text: 'nope' } }, { assetId: 'video_2', transcriptRange: {} }] });
    expect(res).toMatchObject({ success: false, code: 'TRANSCRIPT_RANGE_NOT_FOUND', details: { assetId: 'video_2' } });
    expect(r.doc()).toBe(before); expect(r.undo()).toHaveLength(0);
    expect(r.reads.filter(x => x.startsWith('transcripts:'))).toEqual(['transcripts:asset-vid1', 'transcripts:asset-vid2']); // the third item is never read
  });
  it('failures of the add itself pass through unchanged, without resolved ranges: locked track, overlap, wrong track kind, unknown track', async () => {
    const locked = rig(); await locked.read();
    locked.editor.runtime.bus.run('Change speed' as never, 'user', d => { d.tracks.find(t => t.id === 'V2')!.locked = true; });
    await locked.read();
    const lockedBefore = locked.doc(), lockedDepth = locked.undo().length;
    const l = await locked.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } });
    expect(l).toMatchObject({ success: false, code: 'TRACK_LOCKED' }); expect(l).not.toHaveProperty('data.resolvedTranscriptRanges');
    expect(locked.doc()).toBe(lockedBefore); expect(locked.undo()).toHaveLength(lockedDepth);

    for (const [trackId, start, code] of [['V1', 1, 'OVERLAP_DETECTED'], ['A1', 20, 'INVALID_TRACK']] as const) {
      const r = rig(); await r.read(); const before = r.doc();
      const res = await r.add({ trackId, timelineStart: start, assetId: 'video_1', transcriptRange: { text: 'gamma' } });
      expect(res, trackId).toMatchObject({ success: false, code }); expect(res).not.toHaveProperty('data.resolvedTranscriptRanges');
      expect(r.doc()).toBe(before); expect(r.undo()).toHaveLength(0);
    }
  });
  it('a batch where the add refuses one item after resolution places nothing of the failing item (no resolved ranges reported)', async () => {
    const r = rig(); await r.read(); const before = r.doc();
    const res = await r.add({ trackId: 'V1', timelineStart: 0, items: [{ assetId: 'video_1', transcriptRange: { text: 'beta' } }] }); // V1 is occupied at 0
    expect(res.success).toBe(false); expect(res.data?.resolvedTranscriptRanges).toBeUndefined();
    expect(r.doc()).toBe(before);
  });
  it('a store or analysis failure becomes a failure result with the error code (or PROJECT_UNAVAILABLE); nothing changes', async () => {
    const coded = rig({ rowFails: Object.assign(new Error('db closed'), { code: 'DB_CLOSED' }) }); await coded.read();
    expect(await coded.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } })).toEqual({ success: false, code: 'DB_CLOSED', error: 'db closed' });
    const plain = rig({ analysisFails: new Error('boom') }); await plain.read();
    expect(await plain.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } })).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'boom' });
    const blank = rig({ analysisFails: Object.assign(new Error(''), {}) }); await blank.read();
    expect(await blank.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } })).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'Unable to verify the open project.' });
    expect(plain.onTrack('V2')).toHaveLength(0); expect(plain.undo()).toHaveLength(0);
  });
  it('no open project → PROJECT_UNAVAILABLE', async () => {
    const r = rig({ noProject: true });
    expect(await r.add({ trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma' } })).toEqual(NO_PROJECT);
    expect(r.analysis).not.toHaveBeenCalled();
  });
  it('the raw handler path is untouched: without the executor a transcriptRange is still NOT_IMPLEMENTED (T03)', async () => {
    const r = rig();
    expect(r.editor.runtime.call('addMedia', { trackId: 'V2', assetId: 'video_1', transcriptRange: { text: 'gamma' } })).toMatchObject({ success: false, code: 'NOT_IMPLEMENTED' });
  });
});

describe('T19 D addMedia transcriptRange: idempotency', () => {
  it('the same executionKey twice → the stored result; one item; the transcripts are read once', async () => {
    const r = rig(); await r.read();
    const input = { trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma delta' } };
    const key = { executionKey: 'mcp:conn:same' };
    const first = await r.add(input, key), second = await r.add(input, key);
    expect(first.success).toBe(true); expect(second).toEqual(first);
    expect(r.onTrack('V2')).toHaveLength(1); expect(r.undo().filter(e => e.label === 'Add media')).toHaveLength(1);
    expect(r.store.row.mock.calls.filter(c => c[0] === 'transcripts')).toHaveLength(1);
  });
  it('a stored failure answers a retransmit too (the transcript is not read again)', async () => {
    const r = rig(); await r.read();
    const input = { trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'nope' } };
    const key = { executionKey: 'mcp:conn:fail' };
    const first = await r.add(input, key);
    expect(first.code).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
    expect(await r.add(input, key)).toEqual(first); expect(r.store.row.mock.calls.filter(c => c[0] === 'transcripts')).toHaveLength(1);
  });
  it('a different executionKey with the same input runs again (and then meets the first item: OVERLAP_DETECTED)', async () => {
    const r = rig(); await r.read();
    const input = { trackId: 'V2', timelineStart: 0, assetId: 'video_1', transcriptRange: { text: 'gamma delta' } };
    expect((await r.add(input)).success).toBe(true);
    expect(await r.add(input)).toMatchObject({ success: false, code: 'OVERLAP_DETECTED' });
    expect(r.onTrack('V2')).toHaveLength(1);
  });
});
