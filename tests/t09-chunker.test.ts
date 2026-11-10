// SPDX-License-Identifier: AGPL-3.0-only
// T09 the local caption chunker (CAP-P01…P03, P09…P13 / OT-7, required case 9): the 66 stored cases of
// `fixtures/OT-7 caption chunk cases (C).json`, plus the rule edges written out from findings part 3 §44.2 and the tickets' "Chunker".
// Oracle: the fixture's own numbers (re-typed from Xapp's stored responses) and the prose rule, not chunker.ts. Times: ms,
// compared within 1 ms (the fixture's `compare` field). Case counts come from the fixture's `counts` block.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkWords, CHUNK_DEFAULTS, HOLD_MS, LIMITS } from '../apps/web/src/captions/chunker';
import type { ChunkOptions, ChunkWord } from '../apps/web/src/captions/chunker';
import { TEMPLATES, templateOptions } from '../apps/web/src/captions/templates';

type Case = {
  id: string; kind: 'manual' | 'template'; note?: string;
  options: Partial<ChunkOptions> & { template?: { name: string; canvas: { width: number; height: number }; layer: string; textTransform: string } };
  omittedOptions?: string[]; wordList: { text: string; startS: number; endS: number; sourceItem: string }[]; expectedChunks: { text: string; startS: number; endS: number }[]; expectedCount?: number;
};
type Fixture = { counts: Record<string, number>; templates: Record<string, { maxWords: number; maxCharacters: number; textTransform: string }>; cases: Case[] };
const fixture: Fixture = JSON.parse(readFileSync(new URL('../fixtures/OT-7 caption chunk cases (C).json', import.meta.url), 'utf8'));
const ms = (s: number) => Math.round(s * 1000);
const word = (text: string, startMs: number, endMs: number, source = 'i1'): ChunkWord => ({ text, startMs, endMs, source });
/** Words `step` ms apart, 100 ms long, in one source item. */
const run = (list: string[], step = 200, source = 'i1') => list.map((t, n) => word(t, n * step, n * step + 100, source));
const texts = (words: ChunkWord[], o: Partial<ChunkOptions> = {}) => chunkWords(words, { ...CHUNK_DEFAULTS, ...o }).map(c => c.text);

describe('T09 chunker: OT-7 fixture (CAP-P01 / P02 / P07 / P09 / P10 / P11 / P12 / P13)', () => {
  it('CAP-P03: clip i2 option sweep has the stored 11 / 40 / 14 / 9 chunks (W2-M10/19/20/21)', () => {
    for (const [id, count] of [['W2-M10', 11], ['W2-M19', 40], ['W2-M20', 14], ['W2-M21', 9]] as const) {
      const c = fixture.cases.find(c => c.id === id)!;
      const words = c.wordList.map(w => word(w.text, ms(w.startS), ms(w.endS), w.sourceItem));
      expect(chunkWords(words, { ...CHUNK_DEFAULTS, ...c.options }).filter(c => c.source === 'i2'), id).toHaveLength(count);
    }
  });
  it('the fixture is the 66-case file: 25 + 10 + 29 + 2', () => {
    expect(fixture.counts).toMatchObject({ total: 66, wave2Manual: 25, wave2Template: 10, wave3Manual: 29, wave3Template: 2 });
    expect(fixture.cases).toHaveLength(66);
    expect(fixture.cases.filter(c => c.kind === 'template')).toHaveLength(12);
  });

  for (const c of fixture.cases) {
    it(`${c.id} (${c.kind}): same chunk count, same word partition, times within 1 ms`, () => {
      const o = c.options, upper = c.kind === 'template' && o.template?.textTransform === 'uppercase';
      // Omitted flags (the agent path) count as on; every other flag is exactly the one the request sent.
      for (const f of c.omittedOptions ?? []) expect(o[f as keyof ChunkOptions], `${f} must not be in the request`).toBeUndefined();
      const options: ChunkOptions = { maxWords: o.maxWords!, maxCharacters: o.maxCharacters!, breakOnPunctuation: o.breakOnPunctuation ?? true, breakOnConjunctions: o.breakOnConjunctions ?? true };
      const got = chunkWords(c.wordList.map(w => word(w.text, ms(w.startS), ms(w.endS), w.sourceItem)), options);
      expect(got).toHaveLength(c.expectedChunks.length);
      got.forEach((chunk, n) => {
        const want = c.expectedChunks[n];
        expect(upper ? chunk.text.toUpperCase() : chunk.text, `chunk ${n}`).toBe(want.text);
        expect(Math.abs(chunk.startMs - ms(want.startS)), `chunk ${n} start`).toBeLessThanOrEqual(1);
        expect(Math.abs(chunk.endMs - ms(want.endS)), `chunk ${n} end`).toBeLessThanOrEqual(1);
      });
      // No word lost or duplicated.
      expect(got.flatMap(g => g.words.map(w => w.text))).toEqual([...c.wordList].sort((a, b) => a.startS - b.startS).map(w => w.text));
    });
  }

  it('the nine templates: portrait limits in templates.ts equal the fixture\'s (CAP-P07 / P13); the landscape layer follows the §44.3 table', () => {
    const size = { width: 1080, height: 1920 };
    expect(TEMPLATES.map(t => t.id)).toEqual(['default', 'cinema', 'editorial', 'handwritten', 'karaoke-pop', 'punch', 'subtitle', 'tiktok', '8-bit']);
    for (const [id, want] of Object.entries(fixture.templates)) {
      const t = TEMPLATES.find(x => x.id === id)!;
      expect(templateOptions(t, size), id).toEqual({ ...CHUNK_DEFAULTS, maxWords: want.maxWords, maxCharacters: want.maxCharacters });
    }
    const land = { width: 1920, height: 1080 }, opts = (id: string) => templateOptions(TEMPLATES.find(t => t.id === id)!, land);
    expect([opts('editorial').maxWords, opts('editorial').maxCharacters]).toEqual([5, 22]);
    expect([opts('handwritten').maxWords, opts('handwritten').maxCharacters]).toEqual([5, 30]);
    expect([opts('8-bit').maxWords, opts('8-bit').maxCharacters]).toEqual([3, 20]);
    expect([opts('cinema').maxWords, opts('cinema').maxCharacters]).toEqual([4, 15]); // no landscape limits stated: portrait stands
  });
});

describe('T09 readability option grid (synthetic and OT-7; NOT LibriSpeech word alignments)', () => {
  // The local LibriSpeech subset has utterance transcripts, not word timestamps. These inputs deliberately make no
  // LibriSpeech readability claim. Identity assertions detect a lost or duplicated token even when text repeats.
  const synthetic = Array.from({ length: 120 }, (_, n) => ({ ...word(n % 11 === 0 ? 'because' : n % 7 === 0 ? `word${n}.` : n % 13 === 0 ? 'supercalifragilisticexpialidocious' : `word${n}`, n * 180, n * 180 + 120, n < 60 ? 'a' : 'b'), token: n }));
  const inputs = [synthetic, fixture.cases.find(c => c.id === 'W2-M10')!.wordList.map((w, token) => ({ ...word(w.text, ms(w.startS), ms(w.endS), w.sourceItem), token }))];
  for (const [label, input] of inputs.map((w, n) => [n ? 'OT-7 W2-M10' : 'synthetic 120 tokens', w] as const)) {
    it(`${label}: 80 options preserve every token once and respect word/character limits`, () => {
      for (const maxWords of [1, 3, 5, 12, 20]) for (const maxCharacters of [10, 20, 35, 100])
        for (const breakOnPunctuation of [false, true]) for (const breakOnConjunctions of [false, true]) {
          const chunks = chunkWords(input, { maxWords, maxCharacters, breakOnPunctuation, breakOnConjunctions });
          expect(chunks.flatMap(c => c.words.map(w => w.token))).toEqual(input.map(w => w.token));
          for (const c of chunks) {
            expect(c.words.length).toBeGreaterThan(0);
            expect(c.words.length).toBeLessThanOrEqual(maxWords);
            expect(c.words.every(w => w.source === c.source)).toBe(true);
            // OT-7's indivisible over-long-word rule is the only character-limit exception.
            if (c.text.length > maxCharacters) expect(c.words).toHaveLength(1);
          }
        }
    });
  }
});

describe('T09 chunker: rule edges (findings part 3 §44.2, W3-RF-01…03, tickets "Chunker")', () => {
  it('defaults are 5 words / 35 characters with both breaks on; the UI bounds are 1–20 and 10–100', () => {
    expect(CHUNK_DEFAULTS).toEqual({ maxWords: 5, maxCharacters: 35, breakOnPunctuation: true, breakOnConjunctions: true });
    expect([LIMITS.maxWords, LIMITS.maxCharacters]).toEqual([[1, 20], [10, 100]]);
  });

  it('OT-7: maxWords closes a chunk before the (n+1)th word', () => {
    expect(texts(run(['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg']), { maxWords: 3 })).toEqual(['aa bb cc', 'dd ee ff', 'gg']);
    expect(texts(run(['aa', 'bb', 'cc']), { maxWords: 1 })).toEqual(['aa', 'bb', 'cc']);
  });

  it('OT-7: maxCharacters is inclusive, spaces count; an over-long word stays whole (W3-RF-01)', () => {
    const w = run(['This', 'is', 'pretty', 'freaky.']);
    expect(texts(w, { maxCharacters: 12 })).toEqual(['This is', 'pretty', 'freaky.']);
    expect(texts(w, { maxCharacters: 13 })).toEqual(['This is', 'pretty', 'freaky.']);
    expect(texts(w, { maxCharacters: 14 })).toEqual(['This is pretty', 'freaky.']);   // "This is pretty" is exactly 14: allowed
    expect(texts(run(['supercalifragilistic', 'x']), { maxCharacters: 10 })).toEqual(['supercalifragilistic', 'x']);
    expect(texts(run(['robotics,']), { maxCharacters: 8 })).toEqual(['robotics,']);   // 9 characters alone > 8, never cut
  });

  it('OT-7: the eight conjunctions break before the word, in any case, when conjunction breaks are on; the 42 listed others never do (W3-RF-02)', () => {
    for (const c of ['and', 'but', 'or', 'so', 'yet', 'for', 'nor', 'because', 'And', 'BECAUSE']) {
      expect(texts(run(['one', c, 'two']), { maxWords: 9 }), c).toEqual(['one', `${c} two`]);
      expect(texts(run(['one', c, 'two']), { maxWords: 9, breakOnConjunctions: false }), `${c} off`).toEqual([`one ${c} two`]);
    }
    for (const c of ['then', 'which', 'that', 'when', 'while', 'although', 'though', 'since', 'unless', 'until', 'before', 'after', 'whether', 'if', 'than', 'whereas', 'once', 'as', 'plus', 'however', 'also',
      'where', 'who', 'either', 'neither', 'otherwise', 'therefore', 'thus', 'hence', 'moreover', 'furthermore', 'instead', 'meanwhile', 'besides', 'whenever', 'wherever', 'lest', 'whilst', 'albeit',
      'provided', 'except', 'like'])
      expect(texts(run(['one', c, 'two']), { maxWords: 9 }), c).toEqual([`one ${c} two`]);
  });

  it('stand-in SR-13: the conjunction match ignores everything but letters, digits and apostrophes ("And,", "so,")', () => {
    expect(texts(run(['one', 'And,', 'two']), { maxWords: 9 })).toEqual(['one', 'And, two']);
    expect(texts(run(['one', 'so,', 'two']), { maxWords: 9 })).toEqual(['one', 'so, two']);
  });

  it('a conjunction as the first word never makes an empty chunk before it', () => {
    expect(texts(run(['and', 'then', 'go']), { maxWords: 9 })).toEqual(['and then go']);
  });

  it('OT-7: a sentence end (. ! ?, optionally closing quotes or brackets) closes the chunk after the word when punctuation breaks are on; commas never break', () => {
    expect(texts(run(['Hi.', 'there', 'you!', 'ok', 'now?', 'yes']), { maxWords: 9 })).toEqual(['Hi.', 'there you!', 'ok now?', 'yes']);
    expect(texts(run(['Hi.', 'there', 'you!']), { maxWords: 9, breakOnPunctuation: false })).toEqual(['Hi. there you!']);
    expect(texts(run(['He', 'said "go."', 'then']), { maxWords: 9 })).toEqual(['He said "go."', 'then']);
    expect(texts(run(['(see', 'this.)', 'next']), { maxWords: 9 })).toEqual(['(see this.)', 'next']);
    expect(texts(run(['one,', 'two,', 'three']), { maxWords: 9 })).toEqual(['one, two, three']);
  });

  it('OT-7 / W3-RF-03: a source-item boundary is the hard break; pauses never break', () => {
    const a = run(['just', 'want'], 200, 'i1'), b = run(['to', 'be'], 200, 'i2').map(w => ({ ...w, startMs: w.startMs + 500, endMs: w.endMs + 500 }));
    expect(texts([...a, ...b], { maxWords: 9, maxCharacters: 99 })).toEqual(['just want', 'to be']);
    // An 11.44 s pause inside one item does not break.
    expect(texts([word('space.', 0, 100), word('Okay,', 11540, 11700), word("they're", 11800, 11900)], { maxWords: 9, breakOnPunctuation: false })).toEqual(["space. Okay, they're"]);
  });

  it('the input is sorted by start before chunking (the server sorts first)', () => {
    expect(texts([word('two', 200, 300), word('one', 0, 100), word('three', 400, 500)], { maxWords: 9 })).toEqual(['one two three']);
  });

  it('CAP-P02 / OT-7: end = last word end + HOLD_MS (0.5 s), capped by the next chunk of the SAME source item; another item\'s chunk does not cap it', () => {
    expect(HOLD_MS).toBe(500);
    expect(chunkWords([word('hello', 0, 1000)])[0]).toMatchObject({ startMs: 0, endMs: 1500 });
    // The next chunk of the same item starts at 1200 < 1500: capped.
    const same = chunkWords([word('aa', 0, 1000), word('bb', 1200, 1300)], { ...CHUNK_DEFAULTS, maxWords: 1 });
    expect(same.map(c => [c.startMs, c.endMs])).toEqual([[0, 1200], [1200, 1800]]);
    // The next chunk starts after the hold: the hold stands.
    const far = chunkWords([word('aa', 0, 1000), word('bb', 5000, 5100)], { ...CHUNK_DEFAULTS, maxWords: 1 });
    expect(far.map(c => [c.startMs, c.endMs])).toEqual([[0, 1500], [5000, 5600]]);
    // The next chunk is in another item (starts at 1200, inside the hold): it does NOT cap this one.
    const other = chunkWords([word('aa', 0, 1000, 'i1'), word('bb', 1200, 1300, 'i2')]);
    expect(other.map(c => [c.startMs, c.endMs])).toEqual([[0, 1500], [1200, 1800]]);
    // The cap is the next chunk of the same item, with another item's chunk in between.
    const between = chunkWords([word('aa', 0, 1000, 'i1'), word('bb', 1100, 1150, 'i2'), word('cc', 1300, 1400, 'i1')]);
    expect(between.map(c => [c.source, c.endMs])).toEqual([['i1', 1300], ['i2', 1650], ['i1', 1900]]);
  });

  it('CAP-P02 / OT-7: the hold is not clipped at a range end (range 3–4 s keeps "is" and "pretty"; "pretty" ends 4.26 s in the response)', () => {
    const got = chunkWords([word('is', 3180, 3320), word('pretty', 3480, 3760)], CHUNK_DEFAULTS);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ text: 'is pretty', startMs: 3180, endMs: 4260 });
  });

  it('no words → no chunks', () => { expect(chunkWords([])).toEqual([]); });
});
