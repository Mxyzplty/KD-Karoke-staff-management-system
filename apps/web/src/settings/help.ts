// SPDX-License-Identifier: AGPL-3.0-only
// T21 help corpus (own Markdown, help-corpus.markdown: D37's public copy drops every .md) and the searchHelpDocs / getHelpSection tools (contracts §43, §42; results
// §2). searchHelpDocs is semantic through T19's text embedder when its model is installed, and lexical otherwise, so help works
// offline with nothing installed; nothing leaves the browser and nothing is downloaded. A single search word returns no
// sections, as the contract measured (W3-RF-18); similarity stays in the stored 30–65 band with a cut-off of 30.
import { cosine } from '../analysis/audio';
import corpus from './help-corpus.markdown?raw';

export type HelpSection = { section_id: string; section_title: string; parent_section: string; content: string };
export type HelpResult = { success: true; section: HelpSection } | { success: false; code: string; error: string };
export function parseCorpus(text: string): HelpSection[] {
  const sections: HelpSection[] = [];
  let parent = '';
  for (const block of text.replace(/\r\n/g, '\n').split(/^(?=#{1,2} )/m)) {
    const heading = /^(#{1,2}) (.+?)(?: \{#([a-z0-9-]+)\})?\n/.exec(block);
    if (!heading) continue;
    if (heading[1] === '#') parent = heading[2];
    else sections.push({ section_id: heading[3], section_title: heading[2], parent_section: parent, content: block.slice(heading[0].length).trim() });
  }
  return sections;
}
export const HELP_SECTIONS = parseCorpus(corpus);
const STOP = new Set('a about an and any are as at be been but by can could do does for from get got had has have how i if in into is it its me my need of on one or our out over so some than that the their them then there these they this to too up us use used using want was we what when where which who why will with would you your'.split(' '));
/** Words a user types for what the corpus calls something else. */
const SAME: Record<string, string> = { subtitle: 'caption', cc: 'caption', transcribe: 'caption', transcript: 'caption', render: 'export', download: 'export', mp4: 'export', save: 'export', fx: 'effect', filter: 'effect', grade: 'colour', color: 'colour', grading: 'colour', lut: 'colour', hotkey: 'shortcut', keybinding: 'shortcut', sound: 'audio', music: 'audio', voiceover: 'audio', mcp: 'agent', codex: 'agent', claude: 'agent', helper: 'agent', pair: 'pairing', price: 'cost', pricing: 'cost', pay: 'cost', charge: 'cost', free: 'cost', quota: 'cost', ollama: 'local', cors: 'local', fade: 'transition', crossfade: 'transition', cut: 'split', trim: 'timeline', clip: 'clip', key: 'key', delete: 'delete', overlay: 'graphic', animation: 'animate' };
const stem = (word: string) => word.length > 4 ? word.replace(/(ings?|ies|es|ed|s)$/, '') : word.length > 3 ? word.replace(/s$/, '') : word;
const canonical = (word: string) => SAME[word] ?? SAME[stem(word)] ?? stem(word);
const terms = (text: string) => text.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').split(' ').filter(w => w && !STOP.has(w)).map(canonical);
const INDEX = HELP_SECTIONS.map(section => ({ section, title: new Set(terms(section.section_title)), body: new Set(terms(section.content)) }));
const rarity = (term: string) => { const found = INDEX.filter(s => s.title.has(term) || s.body.has(term)).length; return Math.log(1 + INDEX.length / (1 + found)); };
const searchable = (query: string) => query.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim().split(' ').filter(Boolean).length >= 2 && terms(query).length > 0;
const ranked = (sections: (HelpSection & { similarity: number })[], count: number) => sections.filter(s => s.similarity >= 30).sort((a, b) => b.similarity - a.similarity || a.section_id.localeCompare(b.section_id)).slice(0, count);
export function searchHelp(query: string, count = 5) {
  if (!searchable(query)) return [];
  const words = [...new Set(terms(query))], total = words.reduce((sum, w) => sum + rarity(w), 0);
  return ranked(INDEX.map(({ section, title, body }) => {
    const hit = words.reduce((sum, w) => sum + rarity(w) * (title.has(w) ? 1 : body.has(w) ? .7 : 0), 0);
    return { ...section, similarity: Math.round(65 * hit / total) };
  }), count);
}
/** Unit vectors for `texts`, or null when no embedder is installed. */
export type Embed = (texts: string[]) => Promise<number[][] | null>;
export const localEmbed: Embed = async texts => {
  const { analysisService } = await import('../analysis/service');
  return (await analysisService.available()).embeddings ? analysisService.embed(texts) : null;
};
const sectionVectors = new WeakMap<Embed, Promise<number[][] | null>>();
/** The corpus is embedded once per embedder; a failed or empty try is not remembered. */
function embedSections(embed: Embed) {
  const known = sectionVectors.get(embed);
  if (known) return known;
  const made = embed(HELP_SECTIONS.map(s => `${s.section_title}. ${s.content}`)), forget = () => { sectionVectors.delete(embed); };
  sectionVectors.set(embed, made);
  made.then(vectors => { if (!vectors) forget(); }, forget);
  return made;
}
/** Null sends the caller to the lexical search; an empty list is a real answer: nothing in the corpus is close. */
async function searchSemantic(query: string, count: number, embed: Embed) {
  const sections = await embedSections(embed), asked = sections && (await embed([query]))?.[0];
  if (!sections || !asked) return null;
  return ranked(HELP_SECTIONS.map((section, n) => ({ ...section, similarity: Math.min(65, Math.round(100 * cosine(asked, sections[n]))) })), count);
}
/** The analysis worker runs one job at a time, so a long transcription must not hold help up. Its section vectors stay pending for the next call. */
const EMBED_WAIT_MS = 10_000;
function inTime<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<null>(done => { timer = setTimeout(done, EMBED_WAIT_MS, null); })]).finally(() => clearTimeout(timer));
}
/** searchHelpDocs and getHelpSection need no project, so the Executor answers them before its project check. */
export async function helpTool(tool: string, input: Record<string, unknown>, embed = localEmbed) {
  if (tool === 'getHelpSection') {
    const section = HELP_SECTIONS.find(s => s.section_id === input.section_id);
    return section ? { success: true as const, section } : { success: false as const, code: 'SECTION_NOT_FOUND', error: `Section "${String(input.section_id)}" not found` };
  }
  const query = String(input.query), count = (input.match_count as number | undefined) ?? 5;
  const sections = searchable(query) ? await inTime(searchSemantic(query, count, embed)).catch(() => null) ?? searchHelp(query, count) : [];
  if (!sections.length) return { success: true as const, found: false, message: 'No matching help documentation found for this query.', sections: [] };
  return { success: true as const, found: true, query, sections, message: `Found ${sections.length} matching help ${sections.length === 1 ? 'section' : 'sections'}. Base your answer on them.` };
}
