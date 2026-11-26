// SPDX-License-Identifier: AGPL-3.0-only
// T09 F-A / tickets T09 acceptance: exhaustive readability invariants on independent MFA word alignments.
// Oracle: Lugosch, LibriSpeech Alignments, doi:10.5281/zenodo.2619474 (CC BY 4.0), test-clean TextGrids.
// No ASR/aligner runs here. The manifest records the approved archive md5; do not rehash its 623 MB per run.
// The 22 Oct timing-contract amendment distinguishes raw chunkWords holds from caller item-end clipping:
// raw end = last word end + 500 ms, capped only by the next chunk of the SAME source (not the item/range end).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkWords } from '../apps/web/src/captions/chunker';
import type { ChunkOptions, ChunkWord } from '../apps/web/src/captions/chunker';
import { STORE } from './media-fixtures';

const ROOT = path.join(STORE, 'datasets', 't09', 'librispeech-alignments');
// Same STORE resolution as media-fixtures.ts; absent datasets may skip, a present partial dataset must fail R1.
const available = !!STORE && existsSync(ROOT);
const EXPECTED = { utterances: 2620, chapters: 87, words: 52598, silence: 11623, unknown: 213 };
const OPTIONS: ChunkOptions[] = [];
for (const maxWords of [1, 3, 5, 12, 20]) for (const maxCharacters of [10, 20, 35, 100])
  for (const breakOnPunctuation of [false, true]) for (const breakOnConjunctions of [false, true])
    OPTIONS.push({ maxWords, maxCharacters, breakOnPunctuation, breakOnConjunctions });

type Word = ChunkWord & { occurrence: string };
type Span = { startMs: number; endMs: number };
type Interval = Span & { text: string };
type Utterance = Span & { source: string; chapter: string; words: Word[]; intervals: Interval[] };
const fail = (context: string, message: string): never => { throw new Error(`${context}: ${message}`); };

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  }).sort();
}

let files: string[] | undefined;
function fixtureFiles(): string[] {
  if (files) return files;
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  expect(manifest, 'R1 approved archive and extraction manifest').toMatchObject({
    zip: { name: 'librispeech_alignments.zip', md5: '2bab567d0ace651a4ba254e813629f46', bytes: 623023332 },
    extracted: { dir: 'extracted', glob: 'test-clean/**', fileCount: 2620, utteranceCount: 2620, totalBytes: 19465870, format: 'TextGrid' },
  });
  const found = filesUnder(path.join(ROOT, 'extracted', 'test-clean'));
  expect(found, 'R1 on-disk file count (no partial extraction)').toHaveLength(EXPECTED.utterances);
  expect(found.every(file => file.endsWith('.TextGrid')), 'R1 every extracted file is a TextGrid').toBe(true);
  expect(found.reduce((sum, file) => sum + statSync(file).size, 0), 'R1 extracted byte count').toBe(19465870);
  files = found;
  return files;
}

/** Only the long TextGrid words tier is needed; declared counts/ordinals prevent silent parse omissions. */
function readUtterance(file: string): Utterance {
  const source = path.relative(path.join(ROOT, 'extracted'), file).replaceAll('\\', '/');
  const context = `R4 TextGrid ${source}`, text = readFileSync(file, 'utf8');
  const parts = text.split(/^\s*item \[\d+\]:/m);
  const tiers = parts.slice(1).filter(tier => /^\s*name = "words"\s*$/m.test(tier));
  if (!text.startsWith('File type = "ooTextFile"') || !/^Object class = "TextGrid"\s*$/m.test(text) || tiers.length !== 1)
    fail(context, 'expected long TextGrid with exactly one words tier');
  const bounds = (part: string): Span => {
    const match = part.match(/^\s*xmin = (\S+)\s+xmax = (\S+)\s*$/m);
    if (!match) return fail(context, 'missing xmin/xmax');
    return { startMs: Number(match[1]) * 1000, endMs: Number(match[2]) * 1000 };
  };
  const span = bounds(parts[0]), tier = tiers[0], tierSpan = bounds(tier);
  if (!/^\s*class = "IntervalTier"\s*$/m.test(tier) || tierSpan.startMs !== span.startMs || tierSpan.endMs !== span.endMs)
    fail(context, 'words tier bounds/class differ from the utterance');
  const declared = tier.match(/^\s*intervals: size = (\d+)\s*$/m);
  if (!declared) fail(context, 'missing interval count');
  const intervals: Interval[] = [], words: Word[] = [];
  const pattern = /^\s*intervals \[(\d+)\]:\s+xmin = (\S+)\s+xmax = (\S+)\s+text = "((?:[^"]|"")*)"\s*$/gm;
  for (const match of tier.matchAll(pattern)) {
    if (Number(match[1]) !== intervals.length + 1) fail(context, `missing/repeated interval ordinal ${match[1]}`);
    const interval = { startMs: Number(match[2]) * 1000, endMs: Number(match[3]) * 1000, text: match[4].replaceAll('""', '"') };
    intervals.push(interval);
    // Empty labels are silence. Keep EVERY nonempty label, including the 213 literal <unk> occurrences.
    if (interval.text !== '') words.push({ ...interval, source, occurrence: `${source}:${match[1]}` });
  }
  if (intervals.length !== Number(declared![1])) fail(context, `parsed ${intervals.length} intervals, declared ${declared![1]}`);
  if (!words.length) fail(context, 'utterance has no word occurrences');
  return { ...span, source, chapter: path.posix.dirname(source), words, intervals };
}

let loaded: Utterance[] | undefined;
const corpus = () => loaded ??= fixtureFiles().map(readUtterance);

/** Exhaustive checks with a first counterexample, avoiding millions of Vitest assertion objects. */
function checkGrid(input: Word[], options: ChunkOptions, label: string, spans: Map<string, Span>): number {
  const chunks = chunkWords(input, options);
  const bad = (index: number, message: string) => fail(`${label}, ${JSON.stringify(options)}, chunk ${index}`, message);
  let cursor = 0, previousStart = -Infinity;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk.words.length) bad(i, 'empty chunk');
    if (chunk.words.length > options.maxWords) bad(i, `maxWords exceeded: ${chunk.words.length}`);
    const joined = chunk.words.map(word => word.text).join(' ');
    if (chunk.text !== joined) bad(i, 'chunk text differs from its word occurrences');
    if (joined.length > options.maxCharacters && !(chunk.words.length === 1 && chunk.words[0].text.length > options.maxCharacters))
      bad(i, `maxCharacters exceeded: ${joined.length}`);
    for (const word of chunk.words) {
      const wanted = input[cursor++];
      if (!wanted || word.occurrence !== wanted.occurrence || word.text !== wanted.text || word.source !== wanted.source
        || word.startMs !== wanted.startMs || word.endMs !== wanted.endMs)
        bad(i, `lost/duplicated/changed occurrence at input ${cursor - 1}: expected ${wanted?.occurrence}, got ${word.occurrence}`);
      if (word.source !== chunk.source) bad(i, `mixed sources: ${word.source} in ${chunk.source}`);
    }
    const span = spans.get(chunk.source);
    if (!span || !Number.isFinite(chunk.startMs) || !Number.isFinite(chunk.endMs) || chunk.startMs < previousStart
      || chunk.startMs < span.startMs || chunk.endMs > span.endMs + 500 || chunk.endMs <= chunk.startMs)
      bad(i, `R4 non-finite, unordered or out-of-source timing ${chunk.startMs}..${chunk.endMs}`);
    if (chunk.startMs !== chunk.words[0].startMs) bad(i, 'R4 start is not the first word start');
    previousStart = chunk.startMs;
  }
  if (cursor !== input.length) bad(chunks.length, `lost occurrences: emitted ${cursor} of ${input.length}`);
  // Reverse traversal independently finds each source's next chunk without an O(n^2) assertion loop.
  const nextStart = new Map<string, number>();
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i], last = chunk.words[chunk.words.length - 1];
    const expectedEnd = Math.min(last.endMs + 500, nextStart.get(chunk.source) ?? Infinity);
    if (chunk.endMs !== expectedEnd) bad(i, `R4 hold/cap: expected ${expectedEnd}, got ${chunk.endMs}`);
    nextStart.set(chunk.source, chunk.startMs);
  }
  return chunks.length;
}

describe.skipIf(!available)('T09 F-A LibriSpeech test-clean: 100% external word-alignment readability grid', () => {
  it('R1: approved manifest/md5 and all 2620 on-disk TextGrids, never a partial-dataset skip', () => {
    expect(fixtureFiles()).toHaveLength(EXPECTED.utterances);
  });

  it('R2 + R4: every utterance at all 80 options preserves occurrences, limits, sources and raw timings', () => {
    const utterances = corpus();
    let grids = 0, chunks = 0;
    for (const utterance of utterances) {
      const spans = new Map([[utterance.source, utterance]]);
      for (const options of OPTIONS) {
        chunks += checkGrid(utterance.words, options, `R2 ${utterance.source}`, spans);
        grids++;
      }
    }
    expect(OPTIONS).toHaveLength(80);
    expect(grids).toBe(EXPECTED.utterances * 80);
    console.log(`[T09 F-A R2] ${utterances.length} utterances, ${grids} grids, ${chunks} chunks; no sampling`);
  });

  it('R3 + R4: every chapter at all 80 options, cumulative utterance offsets and source hard breaks', () => {
    const chapters = new Map<string, Utterance[]>();
    for (const utterance of corpus()) {
      const group = chapters.get(utterance.chapter) ?? [];
      group.push(utterance); chapters.set(utterance.chapter, group);
    }
    let grids = 0, sources = 0, occurrences = 0, chunks = 0;
    for (const [chapter, utterances] of chapters) {
      const words: Word[] = [], spans = new Map<string, Span>();
      let offsetMs = 0;
      // fixtureFiles sorts the zero-padded utterance filenames within each chapter; every utterance is a source item.
      for (const utterance of utterances) {
        spans.set(utterance.source, { startMs: offsetMs, endMs: offsetMs + utterance.endMs });
        for (const word of utterance.words) words.push({ ...word, startMs: word.startMs + offsetMs, endMs: word.endMs + offsetMs });
        offsetMs += utterance.endMs;
        sources++; occurrences += utterance.words.length;
      }
      for (const options of OPTIONS) {
        chunks += checkGrid(words, options, `R3 ${chapter}`, spans);
        grids++;
      }
    }
    expect(chapters.size).toBe(EXPECTED.chapters);
    expect(sources).toBe(EXPECTED.utterances);
    expect(occurrences).toBe(EXPECTED.words);
    expect(grids).toBe(EXPECTED.chapters * 80);
    console.log(`[T09 F-A R3] ${chapters.size} chapters, ${sources} sources, ${grids} grids, ${chunks} chunks; no sampling`);
  });

  it('R4: all source intervals are finite, ordered and in range; silence and unknown labels are accounted for', () => {
    let words = 0, silence = 0, unknown = 0;
    for (const utterance of corpus()) {
      const context = `R4 dataset timing ${utterance.source}`;
      if (utterance.startMs !== 0 || !Number.isFinite(utterance.endMs) || utterance.endMs <= 0)
        fail(context, `invalid utterance range ${utterance.startMs}..${utterance.endMs}`);
      let previousEnd = utterance.startMs;
      for (const [index, interval] of utterance.intervals.entries()) {
        if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs) || interval.startMs < previousEnd
          || interval.startMs < utterance.startMs || interval.endMs > utterance.endMs || interval.endMs < interval.startMs
          || (interval.text !== '' && interval.endMs === interval.startMs))
          fail(context, `interval ${index + 1} (${JSON.stringify(interval.text)}) invalid/overlapping/out of range: ${interval.startMs}..${interval.endMs}`);
        previousEnd = interval.endMs;
        if (interval.text === '') silence++;
        else { words++; if (interval.text === '<unk>') unknown++; }
      }
    }
    expect({ words, silence, unknown }).toEqual({ words: EXPECTED.words, silence: EXPECTED.silence, unknown: EXPECTED.unknown });
    expect(corpus().reduce((sum, utterance) => sum + utterance.words.length, 0)).toBe(words);
    console.log(`[T09 F-A R4] ${words} nonempty occurrences retained (including ${unknown} <unk>); skipped non-word labels: empty silence=${silence}; other labels skipped=0`);
  });
});
