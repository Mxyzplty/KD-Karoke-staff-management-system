// SPDX-License-Identifier: AGPL-3.0-only
// T19 D: addMedia `transcriptRange` — findRange and resolveTranscriptRanges (analysis/ranges.ts). Synthetic words only.
import { describe, expect, it, vi } from 'vitest';
import { CANDIDATES, CONTEXT_WORDS, RANGE, findRange, resolveTranscriptRanges, usesTranscriptRange } from '../apps/web/src/analysis/ranges';
import type { Word } from '../apps/web/src/analysis/types';
import type { Asset } from '../apps/web/src/store/model';

type Rec = Record<string, any>;
/** Word i starts at i * 0.5 s and lasts 0.4 s. */
const say = (text: string): Word[] => text.split(' ').map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4 }));
// idx:  0       1  2   3     4      5  6    7     8    9   10     11   12  13      14   15  16    17  18    19      20    21
const TEXT = 'Welcome to the show. Today we talk about cats and dogs. Cats are quiet, dogs are loud! Say hello again, hello again.';
const W = say(TEXT);
const hit = (r: Rec) => { expect(r.code, JSON.stringify(r)).toBeUndefined(); return r; };

describe('T19 D findRange: text', () => {
  it('consecutive words → first word start, last word end, duration, count, matched text as spoken', () => {
    expect(findRange(W, { text: 'the show' })).toEqual({ trimStart: 1, trimEnd: 1.9, duration: 0.9, wordCount: 2, matchedText: 'the show.' });
  });
  it('a single word, the first word, the last word', () => {
    expect(hit(findRange(W, { text: 'welcome' }) as Rec)).toMatchObject({ trimStart: 0, trimEnd: 0.4, wordCount: 1, matchedText: 'Welcome' });
    expect(hit(findRange(W, { text: 'quiet' }) as Rec)).toMatchObject({ trimStart: 6.5, trimEnd: 6.9, matchedText: 'quiet,' });
    expect(hit(findRange(W, { text: 'Say hello' }) as Rec)).toMatchObject({ trimStart: 8.5, trimEnd: 9.4 });
    expect(hit(findRange(W, { text: 'hello again, hello again.' }) as Rec)).toMatchObject({ trimStart: 9, trimEnd: 10.9, wordCount: 4 });
  });
  it('the whole transcript', () => {
    expect(findRange(W, { text: TEXT })).toMatchObject({ trimStart: 0, trimEnd: 10.9, wordCount: 22 });
  });
  it('case and punctuation in the query and in the words are ignored', () => {
    const want = { trimStart: 1, trimEnd: 1.9, duration: 0.9, wordCount: 2, matchedText: 'the show.' };
    for (const text of ['THE SHOW', 'The, Show!', '"the" (show)', 'the   show', '  the\tshow\n', 'the show? ']) expect(findRange(W, { text }), text).toEqual(want);
  });
  it('curly and straight apostrophes match; edge apostrophes are trimmed', () => {
    const words = say('We don’t know ‘quote’ them');
    expect(hit(findRange(words, { text: "don't know" }) as Rec)).toMatchObject({ wordCount: 2, matchedText: 'don’t know' });
    expect(hit(findRange(words, { text: 'don’t' }) as Rec)).toMatchObject({ wordCount: 1 });
    expect(hit(findRange(words, { text: "'quote'" }) as Rec)).toMatchObject({ wordCount: 1, matchedText: '‘quote’' });
  });
  it('words that are only punctuation are skipped, so a match runs across them; they are not in matchedText', () => {
    const words: Word[] = [{ word: 'alpha', start: 0, end: 0.4 }, { word: '—', start: 0.5, end: 0.6 }, { word: 'beta', start: 1, end: 1.4 }];
    expect(findRange(words, { text: 'alpha beta' })).toEqual({ trimStart: 0, trimEnd: 1.4, duration: 1.4, wordCount: 2, matchedText: 'alpha beta' });
  });
  it('words match whole, not by prefix or substring', () => {
    expect((findRange(W, { text: 'the sho' }) as Rec).code).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
    expect((findRange(W, { text: 'elcome' }) as Rec).code).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
    expect((findRange(W, { text: 'show the' }) as Rec).code).toBe('TRANSCRIPT_RANGE_NOT_FOUND'); // order matters
    expect((findRange(W, { text: 'the the' }) as Rec).code).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
  });
  it('a query with no letters or digits matches nothing', () => {
    for (const text of ['!!!', '— …', '"']) expect((findRange(W, { text }) as Rec).code, text).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
  });
  it('NOT_FOUND carries the registry message and no candidates', () => {
    expect(findRange(W, { text: 'nothing like this' })).toEqual({ code: 'TRANSCRIPT_RANGE_NOT_FOUND', message: RANGE.notFound });
  });
});

describe('T19 D findRange: startText + endText', () => {
  it('from the first word of the start quote to the last word of the first end quote at or after it', () => {
    expect(findRange(W, { startText: 'today we', endText: 'cats and dogs' })).toEqual({ trimStart: 2, trimEnd: 5.4, duration: 3.4, wordCount: 7, matchedText: 'Today we talk about cats and dogs.' });
  });
  it('the first end quote wins when it occurs again later', () => {
    expect(hit(findRange(W, { startText: 'today', endText: 'dogs' }) as Rec)).toMatchObject({ trimEnd: 5.4, wordCount: 7 });
  });
  it('an end quote before the start quote does not count', () => {
    expect((findRange(W, { startText: 'loud', endText: 'welcome' }) as Rec).code).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
    expect((findRange(W, { startText: 'today', endText: 'nope' }) as Rec).code).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
    expect((findRange(W, { startText: 'nope', endText: 'dogs' }) as Rec).code).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
  });
  it('the end quote must reach at least the end of the start quote: "hello again" … "hello" skips the first "hello"', () => {
    expect(hit(findRange(W, { startText: 'hello again', endText: 'hello' }) as Rec)).toMatchObject({ trimStart: 9, trimEnd: 10.4, wordCount: 3, matchedText: 'hello again, hello' });
  });
  it('the same word as start and end is a one-word range', () => {
    expect(hit(findRange(W, { startText: 'show', endText: 'show' }) as Rec)).toMatchObject({ trimStart: 1.5, trimEnd: 1.9, wordCount: 1 });
  });
  it('a start quote that matches twice with a different end each is ambiguous', () => {
    const r = findRange(W, { startText: 'hello again', endText: 'again' }) as Rec;
    expect(r).toMatchObject({ code: 'AMBIGUOUS_TRANSCRIPT_RANGE', message: RANGE.ambiguous(2) });
    expect(r.candidates.map((c: Rec) => [c.trimStart, c.trimEnd, c.wordCount])).toEqual([[9, 9.9, 2], [10, 10.9, 2]]);
  });
  it('a start quote that matches twice where only one has an end is unambiguous', () => {
    const words = say('go on stop go on');
    expect(hit(findRange(words, { startText: 'go on', endText: 'stop' }) as Rec)).toMatchObject({ trimStart: 0, trimEnd: 1.4, wordCount: 3 });
  });
  it('case, punctuation and extra spaces are ignored in both quotes', () => {
    expect(findRange(W, { startText: ' TODAY, we ', endText: 'Cats... AND dogs' })).toEqual(findRange(W, { startText: 'today we', endText: 'cats and dogs' }));
  });
});

describe('T19 D findRange: form', () => {
  const FORM = { code: 'INVALID_TRANSCRIPT_RANGE', message: RANGE.form };
  it('anything but text alone or startText + endText is INVALID_TRANSCRIPT_RANGE', () => {
    for (const range of [{}, { startText: 'today' }, { endText: 'dogs' }, { text: 'show', startText: 'today' }, { text: 'show', endText: 'dogs' },
      { text: 'show', startText: 'today', endText: 'dogs' }, { text: '' }, { text: '   ' }, { text: 5 }, { text: null }, { startText: '', endText: 'dogs' }, { startText: 'today', endText: ' ' }, { startText: 1, endText: 2 }])
      expect(findRange(W, range as never), JSON.stringify(range)).toEqual(FORM);
  });
  it('a blank text next to a full start/end pair is not "given", so the pair is used', () => {
    expect(hit(findRange(W, { text: ' ', startText: 'today', endText: 'we' }) as Rec)).toMatchObject({ trimStart: 2, trimEnd: 2.9, wordCount: 2 });
  });
  it('the form is checked before the words (empty word list still INVALID, not NOT_FOUND)', () => {
    expect(findRange([], {})).toEqual(FORM);
    expect((findRange([], { text: 'x' }) as Rec).code).toBe('TRANSCRIPT_RANGE_NOT_FOUND');
  });
});

describe('T19 D findRange: ambiguity, candidates cap, context', () => {
  it('two matches → AMBIGUOUS with the count in the message and a candidate per match (no duration)', () => {
    const r = findRange(W, { text: 'dogs' }) as Rec;
    expect(r.code).toBe('AMBIGUOUS_TRANSCRIPT_RANGE');
    expect(r.message).toBe('The transcript range matched 2 locations. Provide more surrounding words or use numeric trims.');
    expect(r.candidates).toEqual([
      { trimStart: 5, trimEnd: 5.4, wordCount: 1, matchedText: 'dogs.', context: 'we talk about cats and dogs. Cats are quiet, dogs are' },
      { trimStart: 7, trimEnd: 7.4, wordCount: 1, matchedText: 'dogs', context: 'and dogs. Cats are quiet, dogs are loud! Say hello again,' },
    ]);
    expect(CONTEXT_WORDS).toBe(5);
  });
  it('context is the match plus five words each side, clamped at both ends of the transcript', () => {
    const rep = findRange(say('a b a b'), { text: 'a' }) as Rec;
    expect(rep.candidates.map((c: Rec) => c.context)).toEqual(['a b a b', 'a b a b']);
    const long = findRange(say('x a b c d e f g h i j k l m n x'), { text: 'x' }) as Rec;
    expect(long.candidates[0].context).toBe('x a b c d e'); // start clamped: match + five after
    expect(long.candidates[1].context).toBe('j k l m n x'); // five before + match (end clamped)
  });
  it('a multi-word match keeps five words of context around the whole match', () => {
    const r = findRange(say('p q r s t u v w x y z p q r'), { text: 'p q' }) as Rec;
    expect(r.candidates[0]).toMatchObject({ wordCount: 2, matchedText: 'p q', context: 'p q r s t u v' });
    expect(r.candidates[1].context).toBe('v w x y z p q r');
  });
  it('overlapping matches each count: "a a" in "a a a" is two locations', () => {
    const r = findRange(say('a a a'), { text: 'a a' }) as Rec;
    expect(r).toMatchObject({ code: 'AMBIGUOUS_TRANSCRIPT_RANGE', message: RANGE.ambiguous(2) });
    expect(r.candidates.map((c: Rec) => c.trimStart)).toEqual([0, 0.5]);
  });
  it(`more than ${CANDIDATES} matches: the message counts all, candidates are the first ${CANDIDATES} in order`, () => {
    const words = say(Array.from({ length: 12 }, (_, i) => `x w${i}`).join(' '));
    const r = findRange(words, { text: 'x' }) as Rec;
    expect(CANDIDATES).toBe(10);
    expect(r.message).toBe(RANGE.ambiguous(12));
    expect(r.candidates).toHaveLength(10);
    expect(r.candidates.map((c: Rec) => c.trimStart)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    const exactly = findRange(say(Array.from({ length: 10 }, () => 'x').join(' ')), { text: 'x' }) as Rec;
    expect(exactly.message).toBe(RANGE.ambiguous(10)); expect(exactly.candidates).toHaveLength(10);
  });
});

describe('T19 D findRange: clamping and rounding', () => {
  it('trimEnd is clamped to the source length (sourceEnd), trimStart is not; duration follows', () => {
    expect(findRange(W, { text: 'show' }, 1.7)).toEqual({ trimStart: 1.5, trimEnd: 1.7, duration: 0.2, wordCount: 1, matchedText: 'show.' });
    expect(findRange(W, { text: 'show' }, 100)).toMatchObject({ trimEnd: 1.9 });
    expect(findRange(W, { text: 'show' })).toMatchObject({ trimEnd: 1.9 });
    expect(findRange(W, { text: 'show' }, 1.9)).toMatchObject({ trimEnd: 1.9 });
  });
  it('times are rounded to milliseconds, duration from the rounded values', () => {
    const words: Word[] = [{ word: 'odd', start: 1.23456, end: 2.34567 }];
    expect(findRange(words, { text: 'odd' })).toEqual({ trimStart: 1.235, trimEnd: 2.346, duration: 1.111, wordCount: 1, matchedText: 'odd' });
  });
  it('matchedText trims each stored word', () => {
    const words: Word[] = [{ word: ' hi ', start: 0, end: 0.3 }, { word: 'there ', start: 0.5, end: 0.8 }];
    expect(hit(findRange(words, { text: 'hi there' }) as Rec).matchedText).toBe('hi there');
  });
});

describe('T19 D usesTranscriptRange', () => {
  it('a top-level range, or any item with one', () => {
    expect(usesTranscriptRange({ assetId: 'a', transcriptRange: { text: 'x' } })).toBe(true);
    expect(usesTranscriptRange({ items: [{ assetId: 'a' }, { assetId: 'b', transcriptRange: { text: 'x' } }] })).toBe(true);
  });
  it('none: plain args, items without ranges, undefined values', () => {
    expect(usesTranscriptRange({ assetId: 'a', trimStart: 1 })).toBe(false);
    expect(usesTranscriptRange({ items: [{ assetId: 'a' }, null, { assetId: 'b', transcriptRange: undefined }] })).toBe(false);
    expect(usesTranscriptRange({ transcriptRange: undefined })).toBe(false);
    expect(usesTranscriptRange({ items: 'x' })).toBe(false);
  });
  it('an explicit null counts as given (it is then refused as an invalid range)', () => {
    expect(usesTranscriptRange({ assetId: 'a', transcriptRange: null })).toBe(true);
  });
});

// ---- resolveTranscriptRanges
const asset = (id: string, extra: Rec = {}) => ({ id, name: `${id}.bin`, type: 'video', durationMs: 20000, ...extra }) as unknown as Asset;
const A1 = asset('asset-1'), A2 = asset('asset-2');
function rig(o: { rows?: Rec; assets?: Record<string, Asset>; fail?: Error } = {}) {
  const byId: Record<string, Asset> = o.assets ?? { video_1: A1, video_2: A2, 'asset-1': A1, 'asset-2': A2 };
  const rows: Rec = o.rows ?? { 'asset-1': { id: 'asset-1', status: 'complete', transcript: { words: W }, created_at: 'x' }, 'asset-2': { id: 'asset-2', status: 'complete', transcript: { words: say('two cameras say the same words twice the same words') }, created_at: 'x' } };
  const row = vi.fn(async (store: string, id: string) => { if (o.fail) throw o.fail; return store === 'transcripts' ? rows[id] : undefined; });
  const run = (args: Rec) => resolveTranscriptRanges(args, id => byId[id], { row } as never) as Promise<Rec>;
  return { run, row };
}
const failure = (code: string, message: string, assetId: string, extra: Rec = {}) => ({ success: false, code, error: message, message, details: { assetId, ...extra } });

describe('T19 D resolveTranscriptRanges: success', () => {
  it('single form: transcriptRange becomes trimStart / trimEnd; other fields stay; resolved has the range', async () => {
    const { run, row } = rig();
    const r = await run({ assetId: 'video_1', trackId: 'V2', timelineStart: 3, transcriptRange: { text: 'the show' } });
    expect(r.args).toEqual({ assetId: 'video_1', trackId: 'V2', timelineStart: 3, trimStart: 1, trimEnd: 1.9 });
    expect(r.args).not.toHaveProperty('transcriptRange');
    expect(r.resolved).toEqual([{ trimStart: 1, trimEnd: 1.9, duration: 0.9, wordCount: 2, matchedText: 'the show.' }]);
    const reads = (store: string) => row.mock.calls.filter(c => c[0] === store);
    expect(reads('transcripts')).toEqual([['transcripts', 'asset-1']]); // by the stored id, not the agent id
    expect(reads('assets')).toEqual([['assets', 'asset-1']]); // the fresh asset row (R3), also by the stored id
  });
  it('batch: items with ranges are resolved, others pass through unchanged (same object), the top-level fields stay', async () => {
    const { run } = rig();
    const plain = { assetId: 'video_1', trimStart: 1, trimEnd: 2 };
    const r = await run({ trackId: 'V2', timelineStart: 0, items: [
      { assetId: 'video_1', transcriptRange: { text: 'the show' } }, plain, { assetId: 'video_2', transcriptRange: { startText: 'two cameras', endText: 'same words' } }] });
    expect(r.args.trackId).toBe('V2'); expect(r.args.timelineStart).toBe(0);
    expect(r.args.items).toEqual([{ assetId: 'video_1', trimStart: 1, trimEnd: 1.9 }, plain, { assetId: 'video_2', trimStart: 0, trimEnd: 2.9 }]);
    expect(r.args.items[1]).toBe(plain);
    expect(r.resolved).toHaveLength(3);
    expect(r.resolved[1]).toBeUndefined();
    expect(r.resolved[2]).toMatchObject({ trimStart: 0, trimEnd: 2.9, wordCount: 6 });
  });
  it('args without any range come back as they are, resolved [undefined]; the store is not read', async () => {
    const { run, row } = rig();
    const args = { assetId: 'video_1', trimStart: 1 };
    const r = await run(args);
    expect(r.args).toBe(args); expect(r.resolved).toEqual([undefined]); expect(row).not.toHaveBeenCalled();
  });
  it('trimEnd is clamped to the asset duration', async () => {
    const { run } = rig({ assets: { video_1: asset('asset-1', { durationMs: 1700 }) } });
    const r = await run({ assetId: 'video_1', transcriptRange: { text: 'show' } });
    expect(r.args).toMatchObject({ trimStart: 1.5, trimEnd: 1.7 }); expect(r.resolved[0]).toMatchObject({ duration: 0.2 });
  });
  it('an asset without a duration is not clamped', async () => {
    for (const durationMs of [null, undefined]) {
      const { run } = rig({ assets: { video_1: asset('asset-1', { durationMs }) } });
      expect((await run({ assetId: 'video_1', transcriptRange: { text: 'hello again, hello again.' } })).args, String(durationMs)).toMatchObject({ trimEnd: 10.9 });
    }
  });
  it('a top-level range next to an items array is left for the handler (items win)', async () => {
    const { run, row } = rig();
    const r = await run({ transcriptRange: { text: 'the show' }, assetId: 'video_1', items: [{ assetId: 'video_1', trimStart: 0 }] });
    expect(r.args.transcriptRange).toEqual({ text: 'the show' }); expect(row).not.toHaveBeenCalled();
  });
});

describe('T19 D resolveTranscriptRanges: failures', () => {
  it('INVALID_COMBINATION for trimStart, trimEnd or duration (zero and null count), before the asset is looked up', async () => {
    const { run, row } = rig();
    for (const extra of [{ trimStart: 1 }, { trimEnd: 2 }, { duration: 1 }, { trimStart: 0 }, { duration: null }])
      expect(await run({ assetId: 'video_1', transcriptRange: { text: 'show' }, ...extra }), JSON.stringify(extra)).toEqual(failure('INVALID_COMBINATION', RANGE.combination, 'video_1'));
    expect(await run({ assetId: 'nope', trimStart: 1, transcriptRange: { text: 'show' } })).toMatchObject({ code: 'INVALID_COMBINATION', details: { assetId: 'nope' } });
    expect(row).not.toHaveBeenCalled();
  });
  it('MEDIA_NOT_FOUND for an unknown asset, before the range is looked at', async () => {
    const { run, row } = rig();
    expect(await run({ assetId: 'ghost', transcriptRange: { text: 'show' } })).toEqual(failure('MEDIA_NOT_FOUND', RANGE.media, 'ghost'));
    expect(await run({ assetId: 'ghost', transcriptRange: 'show' })).toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    expect(row).not.toHaveBeenCalled();
  });
  it('a range that is not an object is INVALID_TRANSCRIPT_RANGE without reading the store', async () => {
    const { run, row } = rig();
    for (const transcriptRange of ['the show', 5, true, null])
      expect(await run({ assetId: 'video_1', transcriptRange }), String(transcriptRange)).toEqual(failure('INVALID_TRANSCRIPT_RANGE', RANGE.form, 'video_1'));
    expect(row).not.toHaveBeenCalled();
  });
  it('TRANSCRIPT_UNAVAILABLE: no row, a null transcript, an empty one', async () => {
    for (const rows of [{}, { 'asset-1': { id: 'asset-1', status: 'complete', transcript: null } }, { 'asset-1': { id: 'asset-1', transcript: { words: [] } } },
      { 'asset-1': { id: 'asset-1', transcript: { segments: [] } } }, { 'asset-1': { id: 'asset-1', transcript: 'x' } }])
      expect(await rig({ rows }).run({ assetId: 'video_1', transcriptRange: { text: 'show' } }), JSON.stringify(rows)).toEqual(failure('TRANSCRIPT_UNAVAILABLE', RANGE.unavailable, 'video_1'));
  });
  it('TRANSCRIPT_UNAVAILABLE comes before the form check (an invalid range on an asset without words)', async () => {
    expect(await rig({ rows: {} }).run({ assetId: 'video_1', transcriptRange: {} })).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  });
  it('the form, not-found and ambiguous failures carry the assetId as given; ambiguous adds candidates', async () => {
    const { run } = rig();
    expect(await run({ assetId: 'video_1', transcriptRange: {} })).toEqual(failure('INVALID_TRANSCRIPT_RANGE', RANGE.form, 'video_1'));
    expect(await run({ assetId: 'video_1', transcriptRange: { text: 'no such words' } })).toEqual(failure('TRANSCRIPT_RANGE_NOT_FOUND', RANGE.notFound, 'video_1'));
    const amb = await run({ assetId: 'asset-1', transcriptRange: { text: 'dogs' } });
    expect(amb).toMatchObject({ success: false, code: 'AMBIGUOUS_TRANSCRIPT_RANGE', error: RANGE.ambiguous(2), message: RANGE.ambiguous(2), details: { assetId: 'asset-1' } });
    expect(amb.details.candidates).toHaveLength(2);
    expect(amb.details.candidates[0]).toMatchObject({ trimStart: 5, trimEnd: 5.4, wordCount: 1, matchedText: 'dogs.' });
    expect(await run({ assetId: 'video_1', transcriptRange: { text: 'show' } })).toHaveProperty('args');
  });
  it('the first bad item wins; later items are not read; nothing is returned but the failure', async () => {
    const { run, row } = rig();
    const r = await run({ trackId: 'V2', items: [
      { assetId: 'video_1', transcriptRange: { text: 'the show' } }, { assetId: 'video_1', transcriptRange: { text: 'dogs' } }, { assetId: 'video_1', transcriptRange: { text: 'zzz' } }] });
    expect(r).toMatchObject({ success: false, code: 'AMBIGUOUS_TRANSCRIPT_RANGE' });
    expect(r).not.toHaveProperty('args'); expect(row.mock.calls.filter(c => c[0] === 'transcripts')).toHaveLength(2);
  });
  it('a store failure rejects (the executor maps it)', async () => {
    const { run } = rig({ fail: Object.assign(new Error('db closed'), { code: 'PROJECT_UNAVAILABLE' }) });
    await expect(run({ assetId: 'video_1', transcriptRange: { text: 'show' } })).rejects.toThrow('db closed');
  });
});
