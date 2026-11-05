// SPDX-License-Identifier: AGPL-3.0-only
// T19 C3: transcript reads (Xapp part 2 §25, agent tool results §2 `context`, §viewItemDetails). `importTranscript` brings
// every stored shape to the measured one (part 3 §44.5): the older segments with optional per-word speakers, and the
// legacy flat words. `transcription` is viewItemDetails' include=transcript; `transcriptDetail` is the `context` transcript
// detail: the sentence view for full-timeline reads, words only for a bounded range.
import type { Transcript, Word } from './types';
import type { ProjectStore } from '../store/database';
import type { Asset } from '../store/model';

/** The asset's row as stored now (status, steps, duration, media), else the given index entry. The editor's index
 *  (`Runtime.assets`) is read when the editor opens, so the agent's async reads take the row (review R3). */
export const currentAsset = async (store: Pick<ProjectStore, 'row'>, asset: Asset | undefined) => asset && ((await store.row<Asset>('assets', asset.id)) ?? asset);

export type Segment = Transcript['segments'][number];
type Raw = Record<string, any>;
/** A legacy word without an end lasts 0.3 s (part 2 §25). */
export const LEGACY_WORD_S = 0.3;
export const EARLIER = '[earlier transcript trimmed]', LATER = '[later transcript trimmed]';
/** A pause this long (s) is dead air and starts a new speech section; so does a speaker change. */
export const DEAD_AIR_S = 1;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown): v is number => Number.isInteger(v);
const byStart = (a: { start: number }, b: { start: number }) => a.start - b.start;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/** `{word | text, start | timestamp, end?, speaker?}` → a word, or null without text or a start. */
function toWord(raw: Raw): (Word & { speaker?: number }) | null {
  const text = typeof raw?.word === 'string' ? raw.word.trim() : typeof raw?.text === 'string' ? raw.text.trim() : '';
  const start = num(raw?.start) ? raw.start : num(raw?.timestamp) ? raw.timestamp : null;
  if (!text || start === null) return null;
  return { word: text, start, end: num(raw.end) && raw.end >= start ? raw.end : start + LEGACY_WORD_S, ...(int(raw.speaker) ? { speaker: raw.speaker } : {}) };
}
const plain = ({ word, start, end }: Word): Word => ({ word, start, end });
const segmentOf = (id: number, words: (Word & { speaker?: number })[], speaker?: unknown, text?: unknown, start?: unknown, end?: unknown): Segment | null => {
  const from = num(start) ? start : words[0]?.start, to = num(end) ? end : words.at(-1)?.end;
  if (!num(from) || !num(to)) return null;
  return { id, start: from, end: Math.max(from, to), text: typeof text === 'string' ? text.trim() : words.map(w => w.word).join(' '),
    speaker: int(speaker) ? speaker : words.find(w => int(w.speaker))?.speaker ?? 0, words: words.map(plain) };
};

/** Any stored transcript shape → the measured shape, or null when it has neither segments nor words. A segment without a
 *  speaker takes its first word's, else 0; legacy words are grouped into sentences at sentence-final punctuation; an
 *  unknown language is 'und'. */
export function importTranscript(raw: unknown): Transcript | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw, words = (list: unknown) => (Array.isArray(list) ? list : []).map(toWord).filter(w => w !== null).sort(byStart);
  let segments: Segment[];
  if (Array.isArray(r.segments)) segments = r.segments.flatMap((s: Raw, i: number) => segmentOf(int(s?.id) ? s.id : i, words(s?.words), s?.speaker, s?.text, s?.start, s?.end) ?? []);
  else if (Array.isArray(r.words)) {
    const groups: (Word & { speaker?: number })[][] = [[]];
    for (const w of words(r.words)) { groups.at(-1)!.push(w); if (SENTENCE_END.test(w.word)) groups.push([]); }
    segments = groups.filter(g => g.length).map((g, i) => segmentOf(i, g)!);
  } else return null;
  segments.sort(byStart);
  const language = typeof r.language === 'string' && r.language ? r.language : 'und';
  const languages = Array.isArray(r.languages) ? r.languages.filter((l: unknown) => typeof l === 'string') : language === 'und' ? [] : [language];
  return { language, languages, total_duration: num(r.total_duration) ? r.total_duration : segments.reduce((m, s) => Math.max(m, s.end), 0), segments };
}

/** Where a source transcript lands: the source window [from, to) in s, and source s → output s. */
export type Placement = { from: number; to: number; at: (s: number) => number };
export const SOURCE: Placement = { from: -Infinity, to: Infinity, at: s => s };
/** An item's placement: item start + (source − trim start) / rate. viewItemDetails passes rate 1 (Xapp: "playback rate
 *  not applied"); the `context` detail passes the item's rate. Times in ms, like the document. */
export const placement = (startMs: number, trim: { from: number; to: number }, rate = 1): Placement =>
  ({ from: trim.from / 1000, to: trim.to / 1000, at: s => startMs / 1000 + (s - trim.from / 1000) / rate });
const visible = (t: Transcript, p: Placement) => t.segments.filter(s => s.start < p.to && s.end > p.from);

/** viewItemDetails include=transcript: the segments that overlap the window, each with its words that start inside it.
 *  Undefined when nothing is spoken there (the result then has no `transcription` field). */
export function transcription(t: Transcript, p: Placement = SOURCE) {
  const inside = (s: number) => s >= p.from && s < p.to;
  const segments = visible(t, p).map(s => ({ id: s.id, start: r3(p.at(s.start)), end: r3(p.at(s.end)), text: s.text, speaker: s.speaker,
    words: s.words.filter(w => inside(w.start)).map(w => ({ word: w.word, start: r3(p.at(w.start)), end: r3(p.at(w.end)) })) }));
  return segments.length ? { ...(t.language !== 'und' ? { language: t.language } : {}), segments } : undefined;
}

type Section = { type: 'speech'; start: number; end: number; text: string; speaker: number } | { type: 'dead_air'; start: number; end: number; duration: number };
/** Speech sections: a new one at a pause ≥ DEAD_AIR_S (with a dead-air entry) or a speaker change. Undefined unless
 *  there is dead air or more than one section. */
export function speechSections(segments: { start: number; end: number; text: string; speaker: number }[]): Section[] | undefined {
  const out: Section[] = [];
  let last: Extract<Section, { type: 'speech' }> | undefined;
  for (const s of segments) {
    const gap = last ? s.start - last.end : 0;
    if (last && gap < DEAD_AIR_S && s.speaker === last.speaker) { last.end = Math.max(last.end, s.end); last.text += ` ${s.text}`; continue; }
    if (last && gap >= DEAD_AIR_S) out.push({ type: 'dead_air', start: last.end, end: s.start, duration: r3(gap) });
    out.push(last = { type: 'speech', start: s.start, end: s.end, text: s.text, speaker: s.speaker });
  }
  return out.length > 1 ? out : undefined;
}

/** The `context` transcript detail of one item (timeline s; `p` from `placement` with the item's rate). Sentence view by
 *  default; `words` (only with a bounded `from`/`to`, which the caller enforces) adds the words that start in [from, to).
 *  `transcript` joins the kept sentences, marked where spoken content lies outside the range or the trim. */
export function transcriptDetail(item: { id: string; type: string; startMs: number; endMs: number }, t: Transcript, p: Placement, options: { words?: boolean; from?: number; to?: number } = {}) {
  const lo = options.from ?? -Infinity, hi = options.to ?? Infinity;
  const kept = visible(t, p).filter(s => p.at(s.start) < hi && p.at(s.end) > lo);
  if (!kept.length) return undefined;
  const set = new Set(kept), earlier = t.segments.some(s => !set.has(s) && s.start < kept[0].start), later = t.segments.some(s => !set.has(s) && s.start > kept.at(-1)!.start);
  const inside = (w: Word) => w.start >= p.from && w.start < p.to && p.at(w.start) >= lo && p.at(w.start) < hi;
  const segments = kept.map(s => ({ text: s.text, start: r3(p.at(s.start)), end: r3(p.at(s.end)), speaker: s.speaker,
    ...(options.words ? { words: s.words.filter(inside).map(w => ({ word: w.word, start: r3(p.at(w.start)), end: r3(p.at(w.end)) })) } : {}) }));
  const sections = speechSections(segments);
  return { id: item.id, type: item.type, timelineStart: r3(item.startMs / 1000), timelineEnd: r3(item.endMs / 1000), segments,
    transcript: [earlier ? EARLIER : '', ...kept.map(s => s.text), later ? LATER : ''].filter(Boolean).join(' '), ...(sections ? { speechSections: sections } : {}) };
}
