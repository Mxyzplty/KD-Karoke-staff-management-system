// SPDX-License-Identifier: AGPL-3.0-only
// T19 D: addMedia `transcriptRange` (contracts addMedia; results §2 addMedia; error codes TRANSCRIPT_*): the source window
// chosen by spoken words. `text` = one quote; `startText` + `endText` = from the first word of the start quote to the last
// word of the first end quote after it. Words compare as in sync.ts (case, punctuation and curly quotes ignored); the
// range must match exactly one place. The T03 handler stays synchronous: the executor turns each range into trimStart /
// trimEnd here first, then runs addMedia.
import { currentAsset, importTranscript } from './read';
import type { TranscriptRow } from './service';
import { normalWord } from './sync';
import { wordsOf } from './types';
import type { Word } from './types';
import type { ProjectStore } from '../store/database';
import type { Asset } from '../store/model';

type Args = Record<string, unknown>;
type Result = { success: boolean; [k: string]: unknown };
/** The registry's messages (error codes, addMedia rows). */
export const RANGE = {
  combination: 'transcriptRange cannot be combined with trimStart, trimEnd, or duration',
  media: 'Media asset not found',
  form: 'Provide either text, or both startText and endText.',
  unavailable: 'This asset does not have word-level transcript timestamps. Use numeric trimStart and trimEnd instead.',
  notFound: 'No transcript range matched those words. Use the exact wording from the asset transcript.',
  ambiguous: (n: number) => `The transcript range matched ${n} locations. Provide more surrounding words or use numeric trims.`,
};
export const CANDIDATES = 10, CONTEXT_WORDS = 5;
/** results[].resolvedTranscriptRange (s). */
export type Resolved = { trimStart: number; trimEnd: number; duration: number; wordCount: number; matchedText: string };
type Miss = { code: string; message: string; candidates?: (Omit<Resolved, 'duration'> & { context: string })[] };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const tokens = (s: string) => s.split(/\s+/).map(normalWord).filter(Boolean);
const given = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/** The one span of `words` (source s) that `range` names, or why there is none. */
export function findRange(words: Word[], range: { text?: unknown; startText?: unknown; endText?: unknown }, sourceEnd = Infinity): Resolved | Miss {
  const text = given(range.text), start = given(range.startText), end = given(range.endText);
  if (!(text ? !start && !end : start && end)) return { code: 'INVALID_TRANSCRIPT_RANGE', message: RANGE.form };
  const list = words.filter(w => normalWord(w.word)), norm = list.map(w => normalWord(w.word));
  const at = (q: string[]) => norm.flatMap((_, i) => q.length && q.every((t, k) => norm[i + k] === t) ? [i] : []);
  let spans: [number, number][];
  if (text) { const q = tokens(range.text as string); spans = at(q).map(i => [i, i + q.length - 1]); }
  else {
    const a = tokens(range.startText as string), b = tokens(range.endText as string), ends = at(b);
    spans = at(a).flatMap(i => { const j = ends.find(e => e >= i && e + b.length >= i + a.length); return j === undefined ? [] : [[i, j + b.length - 1] as [number, number]]; });
  }
  const span = ([i, j]: [number, number]) => {
    const from = r3(list[i].start), to = r3(Math.min(list[j].end, sourceEnd));
    return { trimStart: from, trimEnd: to, wordCount: j - i + 1, matchedText: list.slice(i, j + 1).map(w => w.word.trim()).join(' ') };
  };
  if (!spans.length) return { code: 'TRANSCRIPT_RANGE_NOT_FOUND', message: RANGE.notFound };
  if (spans.length > 1) return { code: 'AMBIGUOUS_TRANSCRIPT_RANGE', message: RANGE.ambiguous(spans.length), candidates: spans.slice(0, CANDIDATES).map(s => ({ ...span(s),
    context: list.slice(Math.max(0, s[0] - CONTEXT_WORDS), s[1] + CONTEXT_WORDS + 1).map(w => w.word.trim()).join(' ') })) };
  const one = span(spans[0]);
  return { ...one, duration: r3(one.trimEnd - one.trimStart) };
}

export const usesTranscriptRange = (args: Args) => args.transcriptRange !== undefined || (Array.isArray(args.items) && args.items.some(i => (i as Args)?.transcriptRange !== undefined));

/** addMedia args with every `transcriptRange` replaced by trimStart / trimEnd (same spec rule as the handler: `items`
 *  when given, else the top-level item), plus each spec's resolved range; or the R1d failure for the first bad range. */
export async function resolveTranscriptRanges(args: Args, asset: (id: string) => Asset | undefined, store: Pick<ProjectStore, 'row'>): Promise<{ args: Args; resolved: (Resolved | undefined)[] } | Result> {
  const batch = Array.isArray(args.items), specs = (batch ? args.items as Args[] : [args]);
  const resolved: (Resolved | undefined)[] = [], out: Args[] = [];
  for (const spec of specs) {
    if (spec?.transcriptRange === undefined) { resolved.push(undefined); out.push(spec); continue; }
    const assetId = String(spec.assetId), refuse = (code: string, message: string, extra: Args = {}): Result => ({ success: false, code, error: message, message, details: { assetId, ...extra } });
    if (['trimStart', 'trimEnd', 'duration'].some(k => spec[k] !== undefined)) return refuse('INVALID_COMBINATION', RANGE.combination);
    const a = asset(assetId);
    if (!a) return refuse('MEDIA_NOT_FOUND', RANGE.media);
    const range = spec.transcriptRange as Args;
    if (!range || typeof range !== 'object') return refuse('INVALID_TRANSCRIPT_RANGE', RANGE.form);
    const transcript = importTranscript((await store.row<TranscriptRow>('transcripts', a.id))?.transcript), words = transcript ? wordsOf(transcript) : [];
    // The current duration (review R3): the editor's index entry may be older than the probe.
    const end = words.length ? (await currentAsset(store, a))!.durationMs : null;
    const found = words.length ? findRange(words, range, end == null ? Infinity : end / 1000) : { code: 'TRANSCRIPT_UNAVAILABLE', message: RANGE.unavailable };
    if ('code' in found) return refuse(found.code, found.message, found.candidates ? { candidates: found.candidates } : {});
    const { transcriptRange: _, ...rest } = spec;
    resolved.push(found); out.push({ ...rest, trimStart: found.trimStart, trimEnd: found.trimEnd });
  }
  return { args: batch ? { ...args, items: out } : out[0], resolved };
}
