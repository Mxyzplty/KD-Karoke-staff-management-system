// SPDX-License-Identifier: AGPL-3.0-only
// T19 C3: transcript read helpers (analysis/read.ts): importTranscript (every stored shape → the measured one), placement,
// transcription (viewItemDetails include=transcript), speechSections and transcriptDetail (the `context` transcript detail).
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { DEAD_AIR_S, EARLIER, LATER, LEGACY_WORD_S, SOURCE, importTranscript, placement, speechSections, transcriptDetail, transcription } from '../apps/web/src/analysis/read';
import type { Transcript } from '../apps/web/src/analysis/types';

type W = { word: string; start: number; end: number };
const w = (word: string, start: number, end = start + 0.2): W => ({ word, start, end });
const seg = (id: number, start: number, end: number, text: string, speaker = 0, words: W[] = []) => ({ id, start, end, text, speaker, words });
const tr = (segments: Transcript['segments'], language = 'en'): Transcript => ({ language, languages: language === 'und' ? [] : [language], total_duration: Math.max(0, ...segments.map(s => s.end)), segments });

describe('T19 C3 importTranscript', () => {
  it('the measured shape passes through: language, languages, total_duration, segments, speaker ints, words', () => {
    const raw = { language: 'en', languages: ['en', 'fr'], total_duration: 9, segments: [
      { id: 0, start: 0, end: 1, text: 'Hello there', speaker: 1, words: [w('Hello', 0, 0.4), w('there', 0.5, 1)] },
      { id: 1, start: 2, end: 3, text: 'Good bye', speaker: 0, words: [w('Good', 2, 2.4), w('bye', 2.5, 3)] },
    ] };
    expect(importTranscript(raw)).toEqual(raw);
  });
  it('older segments whose words carry a speaker: the segment takes its first word\'s speaker; words keep only { word, start, end }', () => {
    const out = importTranscript({ language: 'en', segments: [{ id: 0, start: 0, end: 1, text: 'a b', words: [{ word: 'a', start: 0, end: 0.4, speaker: 2 }, { word: 'b', start: 0.5, end: 1, speaker: 3 }] }] })!;
    expect(out.segments[0].speaker).toBe(2);
    expect(out.segments[0].words).toEqual([w('a', 0, 0.4), w('b', 0.5, 1)]);
    for (const word of out.segments[0].words) expect(Object.keys(word).sort()).toEqual(['end', 'start', 'word']);
  });
  it('a segment speaker wins over its words\'; a segment without any speaker is 0', () => {
    const out = importTranscript({ segments: [
      { id: 0, start: 0, end: 1, text: 'a', speaker: 4, words: [{ word: 'a', start: 0, end: 1, speaker: 2 }] },
      { id: 1, start: 2, end: 3, text: 'b', words: [w('b', 2, 3)] },
    ] })!;
    expect(out.segments.map(s => s.speaker)).toEqual([4, 0]);
  });
  it('legacy flat words are grouped into sentences at . ! ? … (also with a closing quote or bracket after); ids are 0..n', () => {
    const out = importTranscript({ language: 'en', words: [
      { word: 'Hello', start: 0, end: 0.4 }, { word: 'world.', start: 0.5, end: 1 },
      { word: 'Really', start: 1.5, end: 1.9 }, { word: 'now?', start: 2, end: 2.4 },
      { word: 'Wow!', start: 3, end: 3.4 },
      { word: 'He', start: 4, end: 4.2 }, { word: 'said', start: 4.3, end: 4.5 }, { word: 'go."', start: 4.6, end: 5 },
      { word: '(see', start: 6, end: 6.2 }, { word: 'this.)', start: 6.3, end: 6.6 },
      { word: 'Wait…', start: 7, end: 7.4 },
      { word: 'tail', start: 8, end: 8.4 },
    ] })!;
    expect(out.segments.map(s => s.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out.segments.map(s => s.text)).toEqual(['Hello world.', 'Really now?', 'Wow!', 'He said go."', '(see this.)', 'Wait…', 'tail']);
    expect(out.segments[0]).toEqual({ id: 0, start: 0, end: 1, text: 'Hello world.', speaker: 0, words: [w('Hello', 0, 0.4), w('world.', 0.5, 1)] });
    expect(out.segments[3]).toMatchObject({ start: 4, end: 5 });
  });
  it('legacy words accept text / timestamp for word / start', () => {
    const out = importTranscript({ words: [{ text: 'Hi', timestamp: 1, end: 1.5 }, { text: 'you.', timestamp: 2, end: 2.5 }] })!;
    expect(out.segments).toEqual([{ id: 0, start: 1, end: 2.5, text: 'Hi you.', speaker: 0, words: [w('Hi', 1, 1.5), w('you.', 2, 2.5)] }]);
  });
  it('a legacy word without an end, with end < start or with a non-finite end lasts LEGACY_WORD_S', () => {
    expect(LEGACY_WORD_S).toBe(0.3);
    const out = importTranscript({ words: [{ word: 'a', start: 1 }, { word: 'b', start: 2, end: 1.5 }, { word: 'c', start: 3, end: NaN }, { word: 'd', start: 4, end: Infinity }, { word: 'e.', start: 5, end: 5.5 }] })!;
    const words = out.segments.flatMap(s => s.words);
    expect(words.map(x => x.start)).toEqual([1, 2, 3, 4, 5]);
    expect(words.slice(0, 4).map(x => x.end)).toEqual([1.3, 2.3, 3.3, 4.3].map(x => expect.closeTo(x, 9)));
    expect(words[4].end).toBe(5.5);
  });
  it('a missing language is "und" with languages []; "en" without languages gives ["en"]', () => {
    expect(importTranscript({ words: [w('a.', 0)] })).toMatchObject({ language: 'und', languages: [] });
    expect(importTranscript({ segments: [seg(0, 0, 1, 'x', 0, [w('x', 0, 1)])], language: '' })).toMatchObject({ language: 'und', languages: [] });
    expect(importTranscript({ language: 'en', segments: [seg(0, 0, 1, 'x', 0, [w('x', 0, 1)])] })).toMatchObject({ language: 'en', languages: ['en'] });
  });
  it('a missing total_duration is the latest segment end; a given one is kept', () => {
    expect(importTranscript({ segments: [seg(0, 0, 2, 'a', 0, [w('a', 0, 2)]), seg(1, 3, 7.5, 'b', 0, [w('b', 3, 7.5)])] })!.total_duration).toBe(7.5);
    expect(importTranscript({ words: [w('a.', 0, 1), w('b.', 4, 5)] })!.total_duration).toBe(5);
    expect(importTranscript({ total_duration: 60, segments: [seg(0, 0, 2, 'a', 0, [w('a', 0, 2)])] })!.total_duration).toBe(60);
  });
  it('words without text or without a start are dropped (segment and legacy forms)', () => {
    const out = importTranscript({ segments: [{ id: 0, start: 0, end: 3, text: 'x', words: [{ word: 'ok', start: 0, end: 1 }, { word: '', start: 1, end: 2 }, { word: '  ', start: 1, end: 2 }, { start: 2, end: 3 }, { word: 'nostart', end: 2 }, { word: 'late', start: 2, end: 3 }] }] })!;
    expect(out.segments[0].words.map(x => x.word)).toEqual(['ok', 'late']);
    const legacy = importTranscript({ words: [{ word: 'a', start: 0 }, { word: '', start: 1 }, { word: 'nostart' }, { text: 'b.', timestamp: 2 }] })!;
    expect(legacy.segments.flatMap(s => s.words.map(x => x.word))).toEqual(['a', 'b.']);
  });
  it('segments (and their words) are sorted by start', () => {
    const out = importTranscript({ segments: [seg(1, 5, 6, 'late', 0, [w('b', 5.5, 6), w('a', 5, 5.4)]), seg(0, 0, 1, 'early', 0, [w('x', 0, 1)])] })!;
    expect(out.segments.map(s => s.text)).toEqual(['early', 'late']);
    expect(out.segments[1].words.map(x => x.word)).toEqual(['a', 'b']);
    expect(importTranscript({ words: [w('second.', 5), w('first.', 1)] })!.segments.map(s => s.text)).toEqual(['first.', 'second.']);
  });
  it('null, a non-object, and an object with neither segments nor words → null', () => {
    for (const raw of [null, undefined, 'text', 12, {}, { language: 'en' }, { segments: 'x', words: 'y' }]) expect(importTranscript(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('T19 C3 placement', () => {
  it('at(s) = startMs/1000 + (s − trim.from/1000) / rate; from / to are the trim in seconds', () => {
    const p = placement(10000, { from: 2000, to: 6000 }, 2);
    expect(p.from).toBe(2); expect(p.to).toBe(6);
    expect(p.at(2)).toBe(10); expect(p.at(3)).toBe(10.5); expect(p.at(6)).toBe(12);
  });
  it('the rate defaults to 1; SOURCE is the identity over everything', () => {
    expect(placement(1000, { from: 0, to: 4000 }).at(3)).toBe(4);
    expect(SOURCE.at(7.25)).toBe(7.25); expect(SOURCE.from).toBe(-Infinity); expect(SOURCE.to).toBe(Infinity);
  });
});

describe('T19 C3 transcription (include=transcript)', () => {
  const t = tr([
    seg(0, 0, 3, 'One two three', 1, [w('One', 0, 0.5), w('two', 1, 1.5), w('three', 2, 3)]),
    seg(1, 5, 6, 'Four', 0, [w('Four', 5, 6)]),
    seg(2, 9, 10, 'Five', 0, [w('Five', 9, 10)]),
  ]);
  it('SOURCE keeps every segment and word, times rounded to ms, with ids, text and speaker', () => {
    const out = transcription(t)!;
    expect(out.language).toBe('en');
    expect(out.segments).toHaveLength(3);
    expect(out.segments[0]).toEqual({ id: 0, start: 0, end: 3, text: 'One two three', speaker: 1, words: [w('One', 0, 0.5), w('two', 1, 1.5), w('three', 2, 3)] });
  });
  it('keeps the segments that overlap [from, to) and, inside them, only the words that start inside', () => {
    const out = transcription(t, placement(0, { from: 1000, to: 5500 }))!;
    expect(out.segments.map(s => s.id)).toEqual([0, 1]);
    expect(out.segments[0].words.map(x => x.word)).toEqual(['two', 'three']); // "One" starts before the trim
    expect(out.segments[0]).toMatchObject({ start: -1, end: 2, text: 'One two three' }); // not clipped: placed at 0 + (s − 1)
    expect(out.segments[1].words.map(x => x.word)).toEqual(['Four']);
    const edge = transcription(t, placement(0, { from: 3000, to: 5000 }));
    expect(edge).toBeUndefined(); // seg 0 ends exactly at from, seg 1 starts exactly at to
  });
  it('times go through p.at and are rounded to 3 decimals', () => {
    const out = transcription(tr([seg(0, 0.0004, 1.23456, 'x', 0, [w('x', 0.0004, 1.23456)])]), { from: -Infinity, to: Infinity, at: s => s + 10 })!;
    expect(out.segments[0]).toMatchObject({ start: 10, end: 11.235 });
    expect(out.segments[0].words[0]).toEqual({ word: 'x', start: 10, end: 11.235 });
    const placed = transcription(t, placement(20000, { from: 1000, to: 6000 }, 1))!;
    expect(placed.segments[1]).toMatchObject({ start: 24, end: 25 }); // 20 + (5 − 1)
  });
  it('language is left out when it is "und"', () => {
    const out = transcription({ ...t, language: 'und', languages: [] })!;
    expect(out).not.toHaveProperty('language'); expect(out.segments).toHaveLength(3);
  });
  it('undefined when no segment survives', () => {
    expect(transcription(t, placement(0, { from: 6500, to: 8500 }))).toBeUndefined();
    expect(transcription(tr([]))).toBeUndefined();
  });
});

describe('T19 C3 speechSections', () => {
  const s = (start: number, end: number, text: string, speaker = 0) => ({ start, end, text, speaker });
  it('DEAD_AIR_S is 1 s', () => { expect(DEAD_AIR_S).toBe(1); });
  it('a gap ≥ 1 s adds a dead_air entry { start, end, duration } and starts a new speech section', () => {
    expect(speechSections([s(0, 2, 'A'), s(4.5, 6, 'B')])).toEqual([
      { type: 'speech', start: 0, end: 2, text: 'A', speaker: 0 },
      { type: 'dead_air', start: 2, end: 4.5, duration: 2.5 },
      { type: 'speech', start: 4.5, end: 6, text: 'B', speaker: 0 },
    ]);
    const exact = speechSections([s(0, 2, 'A'), s(3, 4, 'B')])!;
    expect(exact.map(x => x.type)).toEqual(['speech', 'dead_air', 'speech']); // a gap of exactly 1 s is dead air
    expect(exact[1]).toEqual({ type: 'dead_air', start: 2, end: 3, duration: 1 });
  });
  it('a speaker change starts a new section without dead air', () => {
    expect(speechSections([s(0, 2, 'A', 0), s(2.2, 4, 'B', 1)])).toEqual([
      { type: 'speech', start: 0, end: 2, text: 'A', speaker: 0 },
      { type: 'speech', start: 2.2, end: 4, text: 'B', speaker: 1 },
    ]);
  });
  it('the same speaker with a gap < 1 s merges: end extends, text joined with a space', () => {
    const out = speechSections([s(0, 2, 'A'), s(2.5, 4, 'B'), s(10, 11, 'C')])!;
    expect(out).toEqual([
      { type: 'speech', start: 0, end: 4, text: 'A B', speaker: 0 },
      { type: 'dead_air', start: 4, end: 10, duration: 6 },
      { type: 'speech', start: 10, end: 11, text: 'C', speaker: 0 },
    ]);
  });
  it('undefined unless there is more than one entry', () => {
    expect(speechSections([])).toBeUndefined();
    expect(speechSections([s(0, 2, 'A')])).toBeUndefined();
    expect(speechSections([s(0, 2, 'A'), s(2.5, 4, 'B')])).toBeUndefined(); // merged into one
  });
});

describe('T19 C3 transcriptDetail (context)', () => {
  const item = { id: 'a1', type: 'audio', startMs: 5000, endMs: 13000 };
  // Timeline = source + 4 for placement(5000, trim 1000–9000 s): source 1 → 5.
  const t = tr([
    seg(0, 0, 1.5, 'Zero', 0, [w('Zero', 0, 0.4), w('zz', 1.2, 1.5)]),
    seg(1, 2, 4, 'One', 0, [w('One', 2, 2.5), w('and', 3, 3.5)]),
    seg(2, 5, 7, 'Two', 0, [w('Two', 5, 5.5), w('too', 6, 6.5)]),
    seg(3, 9.5, 11, 'Three', 0, [w('Three', 9.5, 10)]),
  ]);
  const p = placement(5000, { from: 1000, to: 9000 }, 1);

  it('sentence view by default: segments carry text/start/end/speaker and no words key; ids and item times from the item', () => {
    const out = transcriptDetail(item, t, p)!;
    expect(out).toMatchObject({ id: 'a1', type: 'audio', timelineStart: 5, timelineEnd: 13 });
    expect(out.segments).toEqual([
      { text: 'Zero', start: 4, end: 5.5, speaker: 0 },
      { text: 'One', start: 6, end: 8, speaker: 0 },
      { text: 'Two', start: 9, end: 11, speaker: 0 },
    ]);
    for (const s of out.segments) expect(s).not.toHaveProperty('words');
  });
  it('transcript joins the kept sentences and marks trimmed content: later here (seg 3 starts past the trim end)', () => {
    const out = transcriptDetail(item, t, p)!;
    expect(LATER).toBe('[later transcript trimmed]'); expect(EARLIER).toBe('[earlier transcript trimmed]');
    expect(out.transcript).toBe('Zero One Two [later transcript trimmed]');
  });
  it('the earlier marker appears when segments before the first kept one exist', () => {
    const out = transcriptDetail(item, t, placement(5000, { from: 3000, to: 12000 }, 1))!; // seg 0 (ends 1.5) is before the trim
    expect(out.transcript).toBe('[earlier transcript trimmed] One Two Three');
  });
  it('both markers when content lies on both sides; none when everything is kept', () => {
    const both = transcriptDetail(item, t, placement(5000, { from: 3000, to: 9000 }, 1))!;
    expect(both.transcript).toBe('[earlier transcript trimmed] One Two [later transcript trimmed]');
    const all = transcriptDetail(item, t, placement(0, { from: 0, to: 20000 }, 1))!;
    expect(all.transcript).toBe('Zero One Two Three');
  });
  it('words: true adds only the words that start inside the trim', () => {
    const out = transcriptDetail(item, t, p, { words: true })!;
    expect(out.segments[0].words).toEqual([{ word: 'zz', start: 5.2, end: 5.5 }]); // "Zero" starts at source 0, before the trim
    expect(out.segments[1].words).toEqual([{ word: 'One', start: 6, end: 6.5 }, { word: 'and', start: 7, end: 7.5 }]);
  });
  it('words: true also honours [from, to) on the timeline; the segments are restricted to that range too', () => {
    const out = transcriptDetail(item, t, p, { words: true, from: 6.5, to: 9.8 })!;
    expect(out.segments.map(s => s.text)).toEqual(['One', 'Two']); // "Zero" ends at 5.5 ≤ 6.5
    expect(out.segments[0].words).toEqual([{ word: 'and', start: 7, end: 7.5 }]); // "One" starts at 6 < 6.5
    expect(out.segments[1].words).toEqual([{ word: 'Two', start: 9, end: 9.5 }]); // "too" starts at 10 ≥ 9.8
    expect(out.transcript).toBe('[earlier transcript trimmed] One Two [later transcript trimmed]');
  });
  it('the item rate scales the placement: rate 2 halves the source distances', () => {
    const fast = transcriptDetail(item, t, placement(5000, { from: 1000, to: 9000 }, 2))!;
    expect(fast.segments[1]).toMatchObject({ text: 'One', start: 5.5, end: 6.5 });
  });
  it('speechSections only when present (dead air or a speaker change)', () => {
    expect(transcriptDetail(item, tr([seg(0, 0, 1, 'Solo', 0, [w('Solo', 0, 1)])]), SOURCE)).not.toHaveProperty('speechSections');
    const gap = tr([seg(0, 0, 1, 'Early', 0, [w('Early', 0, 1)]), seg(1, 4, 5, 'Late', 0, [w('Late', 4, 5)])]);
    expect(transcriptDetail(item, gap, SOURCE)!.speechSections).toEqual([
      { type: 'speech', start: 0, end: 1, text: 'Early', speaker: 0 },
      { type: 'dead_air', start: 1, end: 4, duration: 3 },
      { type: 'speech', start: 4, end: 5, text: 'Late', speaker: 0 },
    ]);
    const turn = tr([seg(0, 0, 1, 'Hi', 0, [w('Hi', 0, 1)]), seg(1, 1.2, 2, 'Yo', 1, [w('Yo', 1.2, 2)])]);
    expect(transcriptDetail(item, turn, SOURCE)!.speechSections).toHaveLength(2);
  });
  it('undefined when nothing is kept', () => {
    expect(transcriptDetail(item, t, placement(0, { from: 11500, to: 12000 }))).toBeUndefined();
    expect(transcriptDetail(item, t, p, { from: 50, to: 60 })).toBeUndefined();
    expect(transcriptDetail(item, tr([]), SOURCE)).toBeUndefined();
  });
});
