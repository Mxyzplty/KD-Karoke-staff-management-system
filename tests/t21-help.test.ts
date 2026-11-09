// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 8: the help corpus and the searchHelpDocs / getHelpSection tools (one search word finds nothing, 20 scripted
// questions find their section, an unknown id is SECTION_NOT_FOUND).
import { describe, expect, test, vi } from 'vitest';
import { HELP_TOOLS } from '../apps/web/src/agent/protocol';
import { HELP_SECTIONS, helpTool, parseCorpus, searchHelp } from '../apps/web/src/settings/help';
import type { Embed } from '../apps/web/src/settings/help';
import { QUESTIONS } from './t21-help-questions';

type Hit = { section_id: string; similarity: number };
type Found = { success: true; found: boolean; sections: Hit[]; message: string };
/** No model installed: the lexical search answers. */
const lexical: Embed = async () => null;
const search = async (query: string) => await helpTool('searchHelpDocs', { query }, lexical) as Found;

describe('help corpus', () => {
  test('parses every ## heading into a section with its # parent and {#id}', () => {
    expect(HELP_SECTIONS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(HELP_SECTIONS.map(s => s.section_id)).size).toBe(HELP_SECTIONS.length);
    for (const s of HELP_SECTIONS) {
      expect(s.section_id).toMatch(/^[a-z0-9-]+$/);
      expect(s.section_title).not.toBe('');
      expect(s.parent_section).not.toBe('');
      expect(s.content.length).toBeGreaterThan(40);
    }
    expect(new Set(HELP_SECTIONS.map(s => s.parent_section))).toEqual(new Set(['Start here', 'The editor', 'Agents', 'Settings and costs']));
  });
  test('parseCorpus handles CRLF and skips text before the first heading', () => {
    const sections = parseCorpus('<!-- header -->\r\n# Parent\r\n\r\n## One {#one}\r\nFirst body.\r\n\r\n## Two {#two}\r\nSecond body.\r\n');
    expect(sections.map(s => [s.section_id, s.section_title, s.parent_section, s.content])).toEqual([
      ['one', 'One', 'Parent', 'First body.'], ['two', 'Two', 'Parent', 'Second body.'],
    ]);
  });
  test('HELP_TOOLS is exactly the two help tools', () => {
    expect([...HELP_TOOLS].sort()).toEqual(['getHelpSection', 'searchHelpDocs']);
  });
});

describe('getHelpSection', () => {
  test('returns the section for a known id', async () => {
    const r = await helpTool('getHelpSection', { section_id: 'getting-started' }) as { success: true; section: (typeof HELP_SECTIONS)[number] };
    expect(r.success).toBe(true);
    expect(r.section.section_id).toBe('getting-started');
    expect(r.section.section_title).toBe('Getting started');
    expect(r.section.parent_section).toBe('Start here');
    expect(r.section.content).toContain('free video editor');
  });
  test('every corpus section can be fetched by its id', async () => {
    for (const s of HELP_SECTIONS) expect(await helpTool('getHelpSection', { section_id: s.section_id })).toEqual({ success: true, section: s });
  });
  test('an unknown id is SECTION_NOT_FOUND', async () => {
    expect(await helpTool('getHelpSection', { section_id: 'nonexistent' })).toEqual({ success: false, code: 'SECTION_NOT_FOUND', error: 'Section "nonexistent" not found' });
    expect(await helpTool('getHelpSection', {})).toMatchObject({ success: false, code: 'SECTION_NOT_FOUND' });
  });
});

describe('searchHelpDocs, lexical (no model installed)', () => {
  test('"how do I export" finds the export section', async () => {
    const r = await search('how do I export a video');
    expect(r.found).toBe(true);
    expect(r.sections[0].section_id).toBe('export');
    expect(r.message).toMatch(/^Found \d+ matching help sections?\./);
  });
  test('a single search word finds nothing (W3-RF-18)', async () => {
    expect(await search('x')).toEqual({ success: true, found: false, message: 'No matching help documentation found for this query.', sections: [] });
    expect((await search('export')).found).toBe(false);
    expect((await search('how do I')).found).toBe(false); // only stop words
    expect(searchHelp('')).toEqual([]);
  });
  test('unrelated words match nothing', async () => {
    expect((await search('zebra quantum pancake')).found).toBe(false);
  });
  test('similarity stays in the 30–65 band, sorted high to low, and match_count caps the list', async () => {
    const r = (await search('keyboard shortcuts undo redo')).sections;
    expect(r.length).toBeGreaterThan(0);
    for (const s of r) { expect(s.similarity).toBeGreaterThanOrEqual(30); expect(s.similarity).toBeLessThanOrEqual(65); }
    expect(r.map(s => s.similarity)).toEqual([...r.map(s => s.similarity)].sort((a, b) => b - a));
    expect((await search('export video mp4')).sections.length).toBeGreaterThan(1);
    expect((await helpTool('searchHelpDocs', { query: 'export video mp4', match_count: 1 }, lexical) as Found).sections).toHaveLength(1);
  });
  test('synonyms reach the corpus word (subtitle → caption, pricing/quota → cost)', async () => {
    expect((await search('add subtitles to my video')).sections.map(s => s.section_id)).toContain('captions');
    expect((await search('pricing and quota limits')).sections.map(s => s.section_id)).toContain('costs');
  });

  test.each(QUESTIONS)('%s → %s', async (question, expected) => {
    const r = await search(question);
    expect(r.found, question).toBe(true);
    expect(r.sections.map(s => s.section_id), question).toContain(expected);
  });
  test('the 20 questions cover 20 different sections that exist', () => {
    expect(new Set(QUESTIONS.map(q => q[1])).size).toBe(20);
    for (const [, id] of QUESTIONS) expect(HELP_SECTIONS.map(s => s.section_id)).toContain(id);
  });
});

describe('searchHelpDocs, semantic (an embedder is available)', () => {
  const SIZE = HELP_SECTIONS.length + 1;
  /** Each section text gets its own axis; a query is `scores` (cosine per section id) plus the rest on a spare axis. */
  function embedder(scores: Record<string, number>) {
    const vector = (text: string) => {
      const v = new Array<number>(SIZE).fill(0), own = HELP_SECTIONS.findIndex(s => text.includes(s.content));
      if (own >= 0) { v[own] = 1; return v; }
      for (const [id, score] of Object.entries(scores)) v[HELP_SECTIONS.findIndex(s => s.section_id === id)] = score;
      v[SIZE - 1] = Math.sqrt(Math.max(0, 1 - v.reduce((sum, x) => sum + x * x, 0)));
      return v;
    };
    return vi.fn<Embed>(async texts => texts.map(vector));
  }
  const ask = async (query: string, embed: Embed, input: Record<string, unknown> = {}) => await helpTool('searchHelpDocs', { query, ...input }, embed) as Found;
  const PARAPHRASE = 'turn speech into subtitles automatically';

  test('a paraphrase the lexical search misses finds its section, best first, with the same result shape', async () => {
    expect(searchHelp(PARAPHRASE).map(s => s.section_id)).not.toContain('captions');
    const r = await ask(PARAPHRASE, embedder({ captions: .62, audio: .41, effects: .2 }));
    expect(r.sections.map(s => [s.section_id, s.similarity])).toEqual([['captions', 62], ['audio', 41]]);
    expect(r.message).toBe('Found 2 matching help sections. Base your answer on them.');
    expect(Object.keys(r.sections[0]).sort()).toEqual(['content', 'parent_section', 'section_id', 'section_title', 'similarity']);
    expect(r).toMatchObject({ success: true, found: true, query: PARAPHRASE });
  });
  test('similarity keeps the stored band: capped at 65, cut off below 30', async () => {
    const r = await ask(PARAPHRASE, embedder({ captions: .9, audio: .3, effects: .29 }));
    expect(r.sections.map(s => [s.section_id, s.similarity])).toEqual([['captions', 65], ['audio', 30]]);
  });
  test('match_count caps the list at its value, 5 by default', async () => {
    const scores = Object.fromEntries(HELP_SECTIONS.slice(0, 7).map((s, n) => [s.section_id, .35 + n * .01]));
    expect((await ask(PARAPHRASE, embedder(scores))).sections).toHaveLength(5);
    expect((await ask(PARAPHRASE, embedder(scores), { match_count: 1 })).sections.map(s => s.section_id)).toEqual([HELP_SECTIONS[6].section_id]);
  });
  test('nothing above the cut-off is found: false, with no lexical answer in its place', async () => {
    const r = await ask('how do I export a video', embedder({ export: .2 }));
    expect(r).toEqual({ success: true, found: false, message: 'No matching help documentation found for this query.', sections: [] });
  });
  test('one search word or only stop words find nothing, and the model is not asked', async () => {
    const embed = embedder({ export: .6 });
    for (const query of ['x', 'export', 'how do I', '']) expect((await ask(query, embed)).found, query).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });
  test('the section vectors are made once per embedder, the query each time', async () => {
    const embed = embedder({ captions: .6 });
    await ask(PARAPHRASE, embed); await ask('another way to say the same thing', embed);
    expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([HELP_SECTIONS.length, 1, 1]);
  });
  test.each<[string, Embed]>([
    ['the model is not installed', async () => null],
    ['the model fails', async () => { throw new Error('no worker'); }],
    ['the vectors are unusable', async texts => texts.map(() => [])],
  ])('%s: the lexical search answers', async (_, embed) => {
    expect(await ask('how do I export a video', embed)).toEqual(await search('how do I export a video'));
  });
  test('a failed embed is not remembered: the next call tries again', async () => {
    const embed = vi.fn<Embed>().mockRejectedValueOnce(new Error('model still loading')).mockImplementation(embedder({ captions: .6 }));
    expect((await ask(PARAPHRASE, embed)).sections.map(s => s.section_id)).not.toContain('captions');
    expect((await ask(PARAPHRASE, embed)).sections.map(s => s.section_id)).toEqual(['captions']);
  });
  test('a worker busy with a long job does not hold help up: the lexical search answers after 10 s, and the corpus job is kept', async () => {
    vi.useFakeTimers();
    try {
      let free = (_: number[][]) => {};
      const vector = embedder({ captions: .6 }), embed = vi.fn<Embed>().mockImplementationOnce(() => new Promise(done => { free = done; })).mockImplementation(vector);
      const asked = ask('how do I export a video', embed), answer = Promise.race([asked, new Promise(done => { setTimeout(done, 20_000, 'still waiting'); })]);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(await Promise.race([asked, Promise.resolve('waiting')]), 'not before 10 s').toBe('waiting');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await answer).toEqual(await search('how do I export a video'));
      free(await vector(HELP_SECTIONS.map(s => `${s.section_title}. ${s.content}`)) as number[][]);
      expect((await ask(PARAPHRASE, embed)).sections.map(s => s.section_id)).toEqual(['captions']);
      expect(embed.mock.calls.map(([texts]) => texts.length).filter(n => n > 1), 'the corpus went to the worker once').toEqual([HELP_SECTIONS.length]);
    } finally { vi.useRealTimers(); }
  });
});
