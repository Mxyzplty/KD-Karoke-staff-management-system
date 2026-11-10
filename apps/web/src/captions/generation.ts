// SPDX-License-Identifier: AGPL-3.0-only
// T09 generation (findings part 3 §44.1–§44.2; caption timing contract §3, §4, CT-15 amendment; agent tool contracts addCaptions).
// One run on the running command's draft: pick the sources, clear their earlier generated captions (a range leaves remnants
// of the words outside it), keep each occurrence's binding with its corrections, chunk the words of the local transcripts and
// place linked captions. No network and no provider. An inaudible source gives no words but is still cleared (§41).
import { audibleTrackGain } from '../audio/gain';
import type { Transcript } from '../analysis/types';
import type { ProjectDocument, RecordData } from '../store/model';
import { autoName, fail, insertTrack, newId, newTrack, stack, toMs, track, trackLocked } from '../timeline/model';
import { prop, setStatic, staticValue } from '../timeline/properties';
import type { ChunkOptions } from './chunker';
import { chunkWords } from './chunker';
import { checkTokens, clockFor, freeWords, linkedTo, narrowCaption, placeCaption, rebaseTokens, setCoverage, tokensOf, wordsFor } from './links';
import type { Clock, TimedWord } from './links';
import type { Binding, CaptionStyleRecord, Token } from './model';
import { bindingsOf, contentHash, fitBox, isLinked, styleRecord } from './model';
import { styleTop } from './templates';
import type { StyleSpec } from './templates';

export type SourceButton = 'speech' | 'video' | 'voiceover' | 'lyrics' | 'all';
/** What the analysis has for an asset. `none`: analysed to nothing or never analysed (missing coverage); `complete` without a
 *  transcript: analysed, confirmed silent. `music`: the classifier's flag, or a beat-analysis row. */
export type SourceData = { status: 'complete' | 'pending' | 'none'; transcript: Transcript | null; music: boolean };
export type GenerateOptions = {
  button: SourceButton; sourceItems?: string[]; range?: { startMs: number; endMs: number } | null; split?: boolean; trackId?: string; speakerTrackIds?: string[];
  chunk: ChunkOptions; style?: CaptionStyleRecord; templateId?: string; reset?: boolean;
};
export type SpeakerResult = { speakerKey: string; captionTrackId: string; captionCount: number; defaultColor: string };
export type Generated = { created: string[]; removed: number; inaudible: string[]; unresolved: string[]; trackIds: string[]; speakers?: SpeakerResult[] };

/** A look stored on a binding: the record plus the top of its box. */
export const bindingStyle = (s: StyleSpec, height: number): CaptionStyleRecord => { const r = styleRecord(s); return { details: r.details, properties: { ...r.properties, positionY: styleTop(s, height) } }; };
/** Result only, never drawn (W3-RF-14: one style; the agent path is unmeasured, notes Q4). */
const SPEAKER_COLORS = ['#FFE600', '#4FC3F7', '#FF8A65', '#AED581', '#CE93D8', '#FFFFFF'];
const isVoiceover = (i: RecordData) => i.metadata?.isVoiceover === true;
const timed = (i: RecordData) => i.type === 'video' || i.type === 'audio';
const assetOf = (i: RecordData): string => i.metadata?.assetId;

/** The items a run captions. Everything outside the source buttons' item types has no words. */
export function sourcesFor(doc: ProjectDocument, o: Pick<GenerateOptions, 'button' | 'sourceItems'>, data: (assetId: string) => SourceData): RecordData[] {
  if (o.sourceItems) return doc.items.filter(i => o.sourceItems!.includes(i.id) && timed(i));
  const pick: Record<SourceButton, (i: RecordData) => boolean> = {
    speech: i => timed(i) && !isVoiceover(i), video: i => i.type === 'video', voiceover: i => timed(i) && isVoiceover(i), lyrics: i => timed(i) && data(assetOf(i)).music, all: timed,
  };
  return doc.items.filter(pick[o.button]).sort((a, b) => a.display.from - b.display.from);
}
/** Audible in the edit (contract addCaptions, §41): not muted or hidden, on a track that sounds. */
export const audibleSource = (doc: ProjectDocument, i: RecordData) => i.muted !== true && i.hidden !== true && audibleTrackGain(doc, i.trackId) > 0 && !(prop(i, 'volume')?.keyframes.length === 0 && staticValue(i, 'volume') === 0);
export function tokensFrom(t: Transcript | null): Token[] {
  let n = 0;
  return (t?.segments ?? []).flatMap(s => s.words.map(w => ({ id: `w${n++}`, text: w.word, startMs: toMs(w.start), endMs: toMs(w.end), speaker: s.speaker ?? null })));
}
const speakersOf = (t: Transcript | null) => [...new Set((t?.segments ?? []).map(s => s.speaker ?? 0))].sort((a, b) => a - b);
const sourceLength = (i: RecordData) => typeof i.sourceDuration === 'number' ? i.sourceDuration : Number(i.trim?.to ?? 0);

/** Where the panel puts captions: the track of the sources' earlier captions, else the first empty caption track, else a new one. */
export function pickTrack(doc: ProjectDocument, sources: RecordData[]): string {
  const ids = new Set(sources.map(i => i.id)), own = doc.items.find(i => isLinked(i) && ids.has(i.captionSourceItemId));
  if (own) return own.trackId;
  const empty = doc.tracks.find(t => t.kind === 'caption' && !trackLocked(doc, t.id) && !doc.items.some(i => i.trackId === t.id));
  return (empty ?? insertTrack(doc, newTrack(doc, 'caption', autoName(doc, 'caption')))).id;
}
function speakerTrack(doc: ProjectDocument, key: string): string {
  const old = doc.tracks.find(t => t.kind === 'caption' && t.metadata?.speakerKey === key);
  if (old) return old.id;
  const t = insertTrack(doc, newTrack(doc, 'caption', autoName(doc, 'caption')));
  t.metadata = { speakerKey: key, captionGenerator: 'panel', captionGeneratorOwnsTrack: true };
  return t.id;
}

const inRange = (w: { startMs: number; endMs: number }, r: GenerateOptions['range']) => !r || (w.startMs >= r.startMs && w.endMs <= r.endMs);
type Old = { record: RecordData; style: CaptionStyleRecord };
/** Takes the sources' earlier generated captions off the timeline. With a range only the words fully inside go: what lies
 *  outside stays as remnant items, trimmed into the old item (W3-RF-05). Returns the removed count and the removed records. */
function clear(doc: ProjectDocument, sources: RecordData[], range: GenerateOptions['range'], previous: Map<string, Old>): number {
  let removed = 0;
  for (const source of sources) for (const b of bindingsOf(source)) {
    if (!range) b.parked = [];
    const c = clockFor(source), at = (ms: number) => source.display.from + c.localAt(ms);
    for (const i of linkedTo(doc.items, b)) {
      const words = wordsFor(b, i).map(w => ({ ...w, startMs: at(w.startMs), endMs: at(w.endMs) }));
      const left = words.filter(w => range && w.startMs < range.startMs), right = words.filter(w => range && w.endMs > range.endMs), inside = words.filter(w => !left.includes(w) && !right.includes(w));
      if (range && !inside.length) continue;
      if (!left.length && !right.length) {
        doc.items.splice(doc.items.indexOf(i), 1);
        previous.set(`${b.id}:${words[0]?.wordId}`, { record: i, style: b.style });
        removed++;
        continue;
      }
      remnants(doc, source, c, b, i, left, right);
    }
  }
  return removed;
}
const uniqueTokens = (list: { tokenId: string }[]) => [...new Set(list.map(w => w.tokenId))];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** A caption that straddles the range becomes its outside words. Left: ends at its own last word. Right: keeps the old end. */
function remnants(doc: ProjectDocument, source: RecordData, c: Clock, b: Binding, i: RecordData, left: TimedLike[], right: TimedLike[]) {
  const { from, to } = i.display, base = i.trim?.from ?? 0;
  if (right.length) {
    const copy = left.length ? structuredClone(i) : i, start = r3(Math.max(from, right[0].startMs));
    if (left.length) { copy.id = newId('item'); doc.items.push(copy); }
    copy.trim = { from: base + (start - from), to: base + (to - from) };
    copy.display = { from: start, to };
    narrowCaption(doc, source, c, b, copy, uniqueTokens(right), right.map(w => w.wordId));
  }
  if (left.length) {
    const end = r3(Math.min(to, left[left.length - 1].endMs));
    i.trim = { from: base, to: base + (end - from) };
    i.display = { from, to: end };
    narrowCaption(doc, source, c, b, i, uniqueTokens(left), left.map(w => w.wordId));
  }
}
type TimedLike = { tokenId: string; wordId: string; startMs: number; endMs: number };

/** The binding of one (occurrence, speaker): the old one keeps its corrections and exclusions across runs (contract §4). */
function bindingFor(source: RecordData, speaker: number | null, trackId: string, tokens: Token[], o: GenerateOptions, fallback: CaptionStyleRecord): Binding {
  const list = bindingsOf(source), revision = contentHash(tokens), held = list.find(b => b.speaker === speaker);
  const siblings = list.filter(b => b !== held && b.revision === revision), known = new Set(tokens.map(t => t.id));
  const carried = siblings.flatMap(b => b.corrections).filter(c => c.tokenIds.every(id => known.has(id)));
  const b: Binding = held ?? { version: 1, id: newId('binding'), sourceItemId: source.id, assetId: assetOf(source), revision, mode: 'linked', trackId, speaker, run: 0, tokens, corrections: [], conflicts: [], coverage: [],
    options: o.chunk, style: o.style ?? fallback, floorMs: 0, parked: [], range: null };
  if (held && held.revision !== revision) {
    const r = rebaseTokens(held, tokens, revision);
    held.conflicts.push(...r.conflicts);
    held.corrections = held.corrections.filter(c => !r.conflicts.includes(c));
    held.tokens = r.tokens; held.revision = revision;
  }
  b.corrections.push(...carried.filter(c => !b.corrections.some(x => x.tokenIds.some(id => c.tokenIds.includes(id)))));
  b.run++; b.trackId = trackId; b.options = o.chunk; b.range = o.range ?? null;
  if (held && o.style) b.style = o.templateId ? o.style : { details: { ...o.style.details, renderMode: held.style.details.renderMode, renderConfig: held.style.details.renderConfig }, properties: o.style.properties };
  if (o.reset) { b.corrections = []; b.conflicts = []; b.coverage = b.coverage.filter(c => c.state !== 'excluded'); }
  source.captionBindings = [...list.filter(x => x !== held), b];
  return b;
}
function cover(b: Binding, source: RecordData, c: Clock, d: SourceData, range: GenerateOptions['range']) {
  const whole = sourceLength(source), spoken = Math.min(whole, toMs(d.transcript?.total_duration ?? 0));
  if (d.status !== 'complete') { setCoverage(b, 0, whole, d.status === 'pending' ? 'pending' : 'unresolved'); return; }
  if (range) {
    const local = (ms: number) => Math.min(c.span, Math.max(0, ms - source.display.from));
    setCoverage(b, c.sourceAt(local(range.startMs)), c.sourceAt(local(range.endMs)), 'complete');
    return;
  }
  const silent = !d.transcript;
  setCoverage(b, 0, silent ? whole : spoken, 'complete');
  if (!silent) setCoverage(b, spoken, whole, 'unresolved');
}
/** A regenerated chunk that starts on an old caption keeps its id and whatever the user changed on it (contract §4). */
function dressAs(old: Old | undefined, size: ProjectDocument['size']) {
  return old && ((record: RecordData) => {
    record.id = old.record.id;
    for (const key of Object.keys(old.style.properties)) {
      const was = prop(old.record, key)?.defaultValue;
      if (JSON.stringify(was) !== JSON.stringify(old.style.properties[key])) setStatic(record, key, was);
    }
    for (const key of Object.keys(old.style.details)) if (JSON.stringify(old.record.details?.[key]) !== JSON.stringify(old.style.details[key])) record.details = { ...record.details, [key]: old.record.details?.[key] };
    fitBox(record, size);
  });
}

export function generate(doc: ProjectDocument, o: GenerateOptions, data: (assetId: string) => SourceData, fallback: CaptionStyleRecord): Generated {
  const chosen = sourcesFor(doc, o, data), audible = chosen.filter(i => audibleSource(doc, i)), inaudible = chosen.filter(i => !audible.includes(i)).map(i => i.id);
  const previous = new Map<string, Old>(), removed = clear(doc, chosen, o.range, previous), created: string[] = [], unresolved: string[] = [];
  // One track per (asset, speaker) in source then speaker order, else the one track.
  const keys: { key: string; speaker: number | null }[] = [], groups = new Map<string, TimedWord[]>(), speakers: SpeakerResult[] = [], trackIds: string[] = [];
  if (o.split) for (const i of audible) for (const speaker of speakersOf(data(assetOf(i)).transcript)) {
    const key = `${assetOf(i)}:${speaker}`;
    if (!keys.some(k => k.key === key)) keys.push({ key, speaker });
  }
  if (o.split && o.speakerTrackIds && o.speakerTrackIds.length < keys.length) fail('INSUFFICIENT_TRACK_IDS', `splitBySpeaker found ${keys.length} speakers but only ${o.speakerTrackIds.length} speakerTrackIds were provided`);
  const trackOf = (key: string) => {
    if (!o.split) return o.trackId ?? pickTrack(doc, chosen);
    const n = keys.findIndex(k => k.key === key);
    return o.speakerTrackIds ? o.speakerTrackIds[n] : speakerTrack(doc, key);
  };
  const place = (i: RecordData, speaker: number | null, key: string) => {
    const d = data(assetOf(i)), all = tokensFrom(d.transcript), tokens = speaker === null ? all : all.filter(t => t.speaker === speaker);
    const trackId = trackOf(key), b = bindingFor(i, speaker, trackId, tokens, o, fallback), c = clockFor(i);
    checkTokens(b);
    if (trackLocked(doc, trackId)) fail('TRACK_LOCKED', `Track ${trackId} is locked`);
    cover(b, i, c, d, o.range);
    if (d.status !== 'complete') unresolved.push(i.id);
    if (!trackIds.includes(trackId)) trackIds.push(trackId);
    const list = freeWords(doc, i, c, b).filter(w => inRange(w, o.range));
    groups.set(key, [...groups.get(key) ?? [], ...list]);
    binds.set(i.id + key, { b, c });
  };
  const binds = new Map<string, { b: Binding; c: Clock }>();
  for (const i of audible) {
    if (o.split) for (const speaker of speakersOf(data(assetOf(i)).transcript)) place(i, speaker, `${assetOf(i)}:${speaker}`);
    else place(i, null, '');
  }
  for (const [key, words] of groups) {
    let count = 0;
    for (const chunk of chunkWords(words, o.chunk)) {
      const source = doc.items.find(x => x.id === chunk.source)!, link = binds.get(source.id + key)!, tokens = [...new Set(chunk.words.map(w => w.tokenId))];
      const old = previous.get(`${link.b.id}:${chunk.words[0].wordId}`);
      const record = placeCaption(doc, source, link.c, link.b, tokens, dressAs(old, doc.size), chunk.words.map(w => w.wordId));
      record.display.to = Math.min(record.display.to, chunk.endMs); // same-source generated neighbour caps the natural hold
      created.push(record.id);
      count++;
    }
    if (o.split) speakers.push({ speakerKey: key, captionTrackId: trackOf(key), captionCount: count, defaultColor: SPEAKER_COLORS[speakers.length % SPEAKER_COLORS.length] });
  }
  for (const i of chosen) i.captionBindings = bindingsOf(i).filter(b => binds.has(i.id + (b.speaker === null ? '' : `${assetOf(i)}:${b.speaker}`)) || linkedTo(doc.items, b).length || b.parked.length || b.corrections.length || b.coverage.some(c => c.state === 'excluded'));
  return { created, removed, inaudible, unresolved, trackIds, ...o.split ? { speakers } : {} };
}
/** Bottom-to-top caption track ids (the agent's alias order is top-down). */
export const captionTracks = (doc: ProjectDocument) => stack(doc).filter(id => track(doc, id)?.kind === 'caption');
