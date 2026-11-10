// SPDX-License-Identifier: AGPL-3.0-only
// T09 the link engine (caption timing contract §2–§6). A linked caption is a projection: immutable tokens, corrections on top
// of them, through the occurrence's clock onto the timeline. Every command that touches items ends in reconcileCaptions (the
// one choke point, CommandBus.run), on the draft, so a refusal throws the whole command away and one logical edit stays one
// undo step. Hidden captions are parked on their binding, with id and style, and come back when their words do (CT-02). The
// clock is the one media playback reads (audio/mix.ts clipClock): constant rate inverted exactly, a strictly increasing remap
// inverted by bisection on that same curve (CT-12, documented improvement over Xapp, which refuses every remap). Freeze,
// reverse, repeated source, no forward clock, bad word timings and a disagreeing split boundary refuse atomically.
import { compileCurve } from '../audio/curve';
import type { ProjectDocument, RecordData } from '../store/model';
import { EPS, fail, fmt, isCaption, itemsOn, newId, span, track, trackLocked } from '../timeline/model';
import { rateOf, remapKeyframes, sorted } from '../timeline/properties';
import { chunkWords, HOLD_MS } from './chunker';
import type { Binding, Correction, Coverage, StoredWord, Token } from './model';
import { bindingOf, bindingsOf, captionRecord, contentHash, fitBox, isLinked, shownText, wordsOf } from './model';

const r3 = (v: number) => { const r = Math.round(v * 1000) / 1000; return r === 0 ? 0 : r; }; // normalise -0 so projected timings compare equal
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const refused = (message: string, data?: RecordData): never => fail('CAPTION_SOURCE_EDIT_REFUSED', 'Linked captions cannot follow this source edit.', { message, data, mayHaveRun: false });

// ---- The clock (contract §2).
/** Source ms an occurrence plays at item-local ms: the mapping of audio/mix.ts clipClock (t09-links asserts they agree;
 *  mix.ts is not imported because it reaches timeline/items through the layouts). */
export function sourceClock(i: RecordData): (local: number) => number {
  const remap = remapKeyframes(i), rate = rateOf(i), trim = i.trim?.from ?? 0;
  if (!remap.length) return local => trim + local * rate;
  const limit = typeof i.sourceDuration === 'number' ? i.sourceDuration : Infinity, curve = compileCurve(remap, Number(i.timeRemap?.defaultValue ?? 0));
  return local => Math.min(Math.max(curve(local), 0), limit);
}
export type Clock = { span: number; sourceAt: (local: number) => number; localAt: (sourceMs: number) => number; windowFrom: number; windowTo: number };
const SAMPLES = 256, BISECTIONS = 40;
/** The invertible clock of an occurrence, or the reason it has none. */
export function clockOf(i: RecordData): Clock | string {
  const len = span(i), sourceAt = sourceClock(i), remap = remapKeyframes(i);
  if (!remap.length) {
    const r = rateOf(i), from = sourceAt(0);
    return { span: len, sourceAt, localAt: s => (s - from) / r, windowFrom: from, windowTo: sourceAt(len) };
  }
  if (remap.length < 2) return 'The clip has one time-remap keyframe, so it has no forward source clock.';
  const stops = [0, ...sorted(remap).map(k => k.time).filter(t => t > 0 && t < len), len];
  let previous = sourceAt(0);
  if (!Number.isFinite(previous)) return 'The clip has no valid forward source clock.';
  for (let n = 1; n < stops.length; n++) for (let s = 1; s <= SAMPLES; s++) {
    const v = sourceAt(stops[n - 1] + (stops[n] - stops[n - 1]) * s / SAMPLES);
    if (!Number.isFinite(v)) return 'The clip has no valid forward source clock.';
    if (v < previous) return 'Linked captions cannot follow a reversed or repeated source range.';
    if (v === previous) return 'Linked captions cannot follow a frozen source range.';
    previous = v;
  }
  const windowFrom = sourceAt(0), windowTo = sourceAt(len);
  return { span: len, sourceAt, windowFrom, windowTo, localAt: s => {
    if (s <= windowFrom) return 0;
    if (s >= windowTo) return len;
    let lo = 0, hi = len;
    for (let n = 0; n < BISECTIONS; n++) { const m = (lo + hi) / 2; if (sourceAt(m) < s) lo = m; else hi = m; }
    return (lo + hi) / 2;
  } };
}
export const clockFor = (source: RecordData) => { const c = clockOf(source); return typeof c === 'string' ? refused(c, { itemId: source.id }) : c; };
export function checkTokens(b: Binding) {
  let last = -Infinity;
  for (const t of b.tokens) {
    if (!Number.isFinite(t.startMs) || !Number.isFinite(t.endMs) || t.endMs < t.startMs) refused(`The word "${t.text}" has no usable timing.`, { tokenId: t.id });
    if (t.startMs < last) refused(`The word "${t.text}" is out of order.`, { tokenId: t.id });
    last = t.startMs;
  }
}

// ---- Words (contract §4 word-boundary rule, §5).
/** One word the binding can show: a token, or a word of the correction on it. */
export type Resolved = { tokenId: string; wordId: string; text: string; startMs: number; endMs: number; speaker: number | null; correction?: Correction; index?: number };
/** The binding's words in order: a correction replaces its tokens at the first of them; no words = deleted. */
export function resolved(b: Binding): Resolved[] {
  const covered = new Map<string, Correction>(), out: Resolved[] = [];
  for (const c of b.corrections) for (const id of c.tokenIds) covered.set(id, c);
  for (const t of b.tokens) {
    const c = covered.get(t.id);
    if (!c) out.push({ tokenId: t.id, wordId: t.id, text: t.text, startMs: t.startMs, endMs: t.endMs, speaker: t.speaker });
    else if (c.tokenIds[0] === t.id) c.words.forEach((w, index) => out.push({ tokenId: t.id, wordId: w.id ?? `${c.id}:${index}`, text: w.text, startMs: w.startMs, endMs: w.endMs, speaker: t.speaker, correction: c, index }));
  }
  return out;
}
/** Half-open window, positive overlap; a word crossing a cut stays on the left piece (floorMs). */
const visible = (b: Binding, w: { startMs: number; endMs: number }, c: Clock) => w.startMs >= b.floorMs && (w.startMs >= c.windowFrom ? w.startMs < c.windowTo : w.endMs > c.windowFrom);
const inState = (b: Binding, ms: number, state: Coverage['state']) => b.coverage.some(c => c.state === state && c.fromMs <= ms && ms < c.toMs);
/** Sets [fromMs, toMs) to a state, keeping the partition sorted and merged. A suppressed interval stays unless `force`. */
export function setCoverage(b: Binding, fromMs: number, toMs: number, state: Coverage['state'], force = state === 'excluded') {
  if (!(toMs > fromMs)) return;
  const out: Coverage[] = [];
  let holes: Coverage[] = [{ fromMs, toMs, state }];
  for (const c of b.coverage) {
    if (c.toMs <= fromMs || c.fromMs >= toMs) { out.push(c); continue; }
    if (c.fromMs < fromMs) out.push({ ...c, toMs: fromMs });
    if (c.toMs > toMs) out.push({ ...c, fromMs: toMs });
    if (c.state === 'excluded' && !force) {
      const a = Math.max(c.fromMs, fromMs), z = Math.min(c.toMs, toMs);
      out.push({ ...c, fromMs: a, toMs: z });
      holes = holes.flatMap(h => [{ ...h, toMs: Math.min(h.toMs, a) }, { ...h, fromMs: Math.max(h.fromMs, z) }]).filter(h => h.toMs > h.fromMs);
    }
  }
  b.coverage = [...out, ...holes].sort((x, y) => x.fromMs - y.fromMs).reduce<Coverage[]>((list, c) => {
    const last = list[list.length - 1];
    if (last && last.state === c.state && last.toMs >= c.fromMs) last.toMs = Math.max(last.toMs, c.toMs); else list.push({ ...c });
    return list;
  }, []);
}

// ---- Projection.
export const tokensOf = (i: RecordData): string[] => Array.isArray(i.metadata?.captionTokens) ? i.metadata!.captionTokens : [];
/** Token anchors own corrections; word anchors own individual displayed words after regrouping. Older documents select tokens. */
export function wordsFor(b: Binding, i: RecordData): Resolved[] {
  const wordIds: string[] | undefined = i.metadata?.captionWordIds, ids = new Set(wordIds ?? tokensOf(i));
  return resolved(b).filter(w => ids.has(wordIds ? w.wordId : w.tokenId));
}
/** The declared adjustment of a caption (contract §3): its edges, and a shift of the whole caption with its words. */
type Timing = { startMs: number; endMs: number; shiftMs: number };
const timingOf = (i: RecordData): Timing => ({ startMs: i.metadata?.captionTiming?.startMs ?? 0, endMs: i.metadata?.captionTiming?.endMs ?? 0, shiftMs: i.metadata?.captionTiming?.shiftMs ?? 0 });
type Shown = { words: Resolved[]; first: number; last: number };
function shownWords(b: Binding, i: RecordData, c: Clock): Shown | null {
  const words = wordsFor(b, i).filter(w => visible(b, w, c));
  if (!words.length) return null;
  return { words, first: Math.max(words[0].startMs, c.windowFrom), last: Math.min(words[words.length - 1].endMs, c.windowTo) };
}
/** The caption's span with no declared offset: first word to last word plus the hold, inside the occurrence (project ms). */
function rawSpan(source: RecordData, c: Clock, s: Shown) {
  const at = (ms: number) => source.display.from + c.localAt(ms), from = at(s.first), wordEnd = at(s.last);
  return { from, wordEnd, to: Math.min(wordEnd + HOLD_MS, source.display.to) };
}
/** Writes a caption's words and display from its anchors. */
function project(doc: ProjectDocument, source: RecordData, c: Clock, b: Binding, i: RecordData, s: Shown) {
  const raw = rawSpan(source, c, s), timing = timingOf(i), from = r3(raw.from + timing.shiftMs + timing.startMs), to = r3(Math.max(raw.to + timing.shiftMs + timing.endMs, from + 1));
  const base = i.trim?.from ?? 0, at = (ms: number) => source.display.from + c.localAt(ms) + timing.shiftMs;
  const words: StoredWord[] = s.words.map(w => {
    const a = Math.max(w.startMs, c.windowFrom), z = Math.min(w.endMs, c.windowTo);
    return { text: shownText(b, w.text), startMs: r3(at(a) - from + base), endMs: r3(at(z) - from + base), sourceStartMs: w.startMs, sourceEndMs: w.endMs, tokenId: w.tokenId, wordId: w.wordId,
      ...a !== w.startMs || z !== w.endMs ? { partial: true } : {}, ...w.correction?.estimated ? { estimated: true } : {} };
  });
  const text = words.map(w => w.text).join(' '), retext = text !== i.details?.text;
  i.display = { from, to };
  i.details = { ...i.details, text, words };
  if (i.trim) i.trim = { from: base, to: base + (to - from) };
  if (retext) fitBox(i, doc.size);
}
export const linkedTo = (items: RecordData[], b: Binding) => items.filter(i => isLinked(i) && i.metadata!.captionBindingId === b.id);

/** A new linked caption over tokens, in the binding's look. */
export function linkedCaption(doc: ProjectDocument, source: RecordData, b: Binding, tokenIds: string[]): RecordData {
  const record = captionRecord({ trackId: b.trackId, display: { from: 0, to: 1 }, text: '', words: [], style: b.style, top: Number(b.style.properties.positionY ?? 0), size: doc.size, sourceItemId: source.id, metadata: {
    captionGenerator: 'panel', captionSource: { version: 1, sourceItemId: source.id, sourceAssetId: b.assetId, contentHash: contentHash(b.tokens.filter(t => tokenIds.includes(t.id))) },
    captionGeneratorSourceItemId: source.id, captionBindingId: b.id, captionTokens: tokenIds } });
  return record;
}
/** Adds a linked caption over tokens, projected. */
export function placeCaption(doc: ProjectDocument, source: RecordData, c: Clock, b: Binding, tokenIds: string[], dress?: (record: RecordData) => void, wordIds?: string[]) {
  const record = linkedCaption(doc, source, b, tokenIds);
  if (wordIds) record.metadata.captionWordIds = wordIds;
  dress?.(record);
  project(doc, source, c, b, record, shownWords(b, record, c)!);
  doc.items.push(record);
  return record;
}
/** A caption narrowed to some of its tokens at the display it was given (remnants): the offset is declared, the words re-projected. */
export function narrowCaption(doc: ProjectDocument, source: RecordData, c: Clock, b: Binding, i: RecordData, tokenIds: string[], wordIds?: string[]) {
  i.metadata = { ...i.metadata, captionTokens: tokenIds, captionWordIds: wordIds };
  const s = shownWords(b, i, c)!;
  i.metadata = { ...i.metadata, captionTiming: declared(source, c, s, i, null) };
  project(doc, source, c, b, i, s);
}
export type TimedWord = Resolved & { source: string };
/** Words no live or parked caption owns: visible, analysed, not suppressed; in project ms, clamped to the occurrence (contract §3 "Extend trim", CT-03). */
export function freeWords(doc: ProjectDocument, source: RecordData, c: Clock, b: Binding): TimedWord[] {
  const owned = new Set([...linkedTo(doc.items, b), ...b.parked].flatMap(i => wordsFor(b, i).map(w => w.wordId))), at = (ms: number) => source.display.from + c.localAt(ms);
  return resolved(b).filter(w => !owned.has(w.wordId) && visible(b, w, c) && inState(b, w.startMs, 'complete') && !inState(b, w.startMs, 'excluded'))
    .map(w => ({ ...w, startMs: at(Math.max(w.startMs, c.windowFrom)), endMs: at(Math.min(w.endMs, c.windowTo)), source: source.id }));
}
const fillFree = (doc: ProjectDocument, source: RecordData, c: Clock, b: Binding) => {
  for (const chunk of chunkWords(freeWords(doc, source, c, b), b.options)) placeCaption(doc, source, c, b, [...new Set(chunk.words.map(w => w.tokenId))], undefined, chunk.words.map(w => w.wordId));
};
/** A source's captions after a change to its clock or window: project, park, unpark, fill. */
function refresh(doc: ProjectDocument, source: RecordData, c: Clock, b: Binding) {
  for (const i of linkedTo(doc.items, b)) {
    const s = shownWords(b, i, c);
    if (s) { project(doc, source, c, b, i, s); continue; }
    doc.items.splice(doc.items.indexOf(i), 1);
    b.parked.push(i);
  }
  b.parked = b.parked.filter(i => {
    const s = shownWords(b, i, c);
    if (!s) return true;
    project(doc, source, c, b, i, s);
    doc.items.push(i);
    return false;
  });
  fillFree(doc, source, c, b);
}

const signature = (i: RecordData | undefined) => JSON.stringify([i?.display, i?.trim, i?.playbackRate, i?.timeRemap]);
const captionText = (i: RecordData) => String(i.details?.text ?? '');
/** Where a caption's spoken words end (its hold is not speech). */
const reach = (doc: ProjectDocument, i: RecordData) => {
  const source = isLinked(i) ? doc.items.find(x => x.id === i.captionSourceItemId) : undefined, b = bindingOf(source, i.metadata?.captionBindingId), c = source ? clockOf(source) : 'none';
  const s = b && typeof c !== 'string' ? shownWords(b, i, c) : null;
  return s ? rawSpan(source!, c as Clock, s).wordEnd + timingOf(i).shiftMs : i.display.to;
};
/** Holds end before the next caption on the track. Spoken words on top of another source's caption refuse (§6 dependency set). */
function settleTrack(doc: ProjectDocument, trackId: string, sourceEdit: boolean) {
  const list = itemsOn(doc, trackId).filter(isCaption);
  for (let n = 0; n < list.length - 1; n++) {
    const a = list[n], next = list[n + 1];
    if (a.display.to <= next.display.from + EPS) continue;
    const differ = a.captionSourceItemId !== next.captionSourceItemId || !a.captionSourceItemId;
    if (sourceEdit && differ && reach(doc, a) > next.display.from + EPS)
      fail('CAPTION_OVERLAP', `This edit would put the caption "${captionText(a)}" on top of "${captionText(next)}" at ${fmt(next.display.from)}s. Move or delete one of them first.`, { mayHaveRun: false });
    if (!isLinked(a)) continue;
    a.display = { from: a.display.from, to: r3(Math.max(next.display.from, a.display.from + 1)) };
    a.trim = { from: a.trim?.from ?? 0, to: (a.trim?.from ?? 0) + span(a) };
  }
}
/** The offset a caption's new display declares: a whole move shifts it with its words; an edge keeps the words where they are. */
function declared(source: RecordData, c: Clock, s: Shown, i: RecordData, old: RecordData | null): Timing {
  const raw = rawSpan(source, c, s), timing = timingOf(i);
  if (old && Math.abs(i.display.from - old.display.from - (i.display.to - old.display.to)) < EPS) return { ...timing, shiftMs: r3(timing.shiftMs + i.display.from - old.display.from) };
  return { ...timing, startMs: r3(i.display.from - raw.from - timing.shiftMs), endMs: r3(i.display.to - raw.to - timing.shiftMs) };
}

/** Brings every linked caption in line with what the command did to the items. Runs once, on the draft, after the op. */
export function reconcileCaptions(base: ProjectDocument, draft: ProjectDocument) {
  const had = base.items.some(i => bindingsOf(i).length || isLinked(i)), has = draft.items.some(i => bindingsOf(i).length || isLinked(i));
  if (!had && !has) return;
  const before = new Map(base.items.map(i => [i.id, i])), after = new Map(draft.items.map(i => [i.id, i]));
  const changed = draft.items.filter(i => bindingsOf(i).length && signature(i) !== signature(before.get(i.id)));
  const moved = new Set(changed.map(i => i.id));

  // A caption the user removed: suppressed, even when it was the final visible caption (CT-13).
  for (const old of base.items) {
    if (!isLinked(old) || after.has(old.id)) continue;
    const source = after.get(old.captionSourceItemId), was = before.get(old.captionSourceItemId), b = source && bindingOf(source, old.metadata!.captionBindingId), prior = bindingOf(was, old.metadata!.captionBindingId);
    if (!source || !b || !prior || b.run !== prior.run || moved.has(source.id)) continue;
    const spanned = wordsFor(prior, old);
    if (spanned.length) setCoverage(b, spanned[0].startMs, spanned[spanned.length - 1].endMs, 'excluded');
  }

  // A linked caption moved or trimmed by itself: a declared timing offset, provenance kept (contract §3).
  for (const i of draft.items) {
    const old = isLinked(i) ? before.get(i.id) : undefined, source = old && after.get(i.captionSourceItemId);
    if (!old || !source || moved.has(source.id) || same(old.display, i.display)) continue;
    const b = bindingOf(source, i.metadata!.captionBindingId); if (!b) continue;
    if (b.run !== bindingOf(before.get(source.id), b.id)?.run) continue; // regenerated grouping is not a manual timing edit
    const c = clockFor(source), s = shownWords(b, i, c); if (!s) continue;
    i.metadata = { ...i.metadata, captionTiming: declared(source, c, s, i, old) };
    project(draft, source, c, b, i, s);
  }

  for (const source of changed) {
    const c = clockFor(source), fresh = !before.has(source.id);
    for (const b of [...bindingsOf(source)]) {
      checkTokens(b);
      if (!track(draft, b.trackId)) { source.captionBindings = bindingsOf(source).filter(x => x !== b); continue; }
      if (fresh && Math.abs(c.windowFrom - b.floorMs) > 1) refused('The split boundary does not agree with the words of the linked captions.', { itemId: source.id });
      if (c.windowFrom < b.floorMs) b.floorMs = c.windowFrom;
      refresh(draft, source, c, b);
    }
  }

  // Every caption this command changed: its track settles, and a locked caption dependency refuses the whole edit (CT-08).
  const touched = draft.items.filter(i => isLinked(i) && !same(i, before.get(i.id)));
  for (const trackId of new Set(touched.map(i => i.trackId))) settleTrack(draft, trackId, moved.size > 0);
  const now = new Map(draft.items.map(i => [i.id, i]));
  for (const i of [...base.items, ...draft.items]) {
    if (!isLinked(i) || !(moved.has(i.captionSourceItemId) || !after.has(i.captionSourceItemId))) continue;
    if (trackLocked(draft, i.trackId) && !same(now.get(i.id), before.get(i.id))) refused(`Track ${i.trackId} is locked and holds captions linked to this clip. Unlock it first.`, { trackId: i.trackId, itemId: i.id });
  }
}

// ---- Copies, split, detach, corrections.
/** A copy of an item is a new occurrence: no bindings of its own; a copied linked caption is detached (default, notes). */
export function copyRecord(copy: RecordData) {
  delete copy.captionBindings;
  if (isLinked(copy)) detachRecord(copy);
}
function detachRecord(i: RecordData) {
  const { captionBindingId: _b, captionTokens: _t, captionWordIds: _w, captionTiming: _c, ...metadata } = i.metadata ?? {};
  i.metadata = { ...metadata, captionMode: 'detached' };
  delete i.captionSourceItemId;
}
/** Detach (contract §3): independent timing from here on; the provenance snapshot stays, the words stay out of the free pool. */
export function detachCaptions(doc: ProjectDocument, ids: string[]) {
  for (const id of ids) {
    const i = doc.items.find(x => x.id === id);
    if (!isLinked(i)) continue;
    const source = doc.items.find(x => x.id === i.captionSourceItemId), b = bindingOf(source, i.metadata!.captionBindingId);
    if (b) {
      const tokens = new Set(tokensOf(i)), spanned = b.tokens.filter(t => tokens.has(t.id));
      if (spanned.length) setCoverage(b, spanned[0].startMs, spanned[spanned.length - 1].endMs, 'excluded');
    }
    detachRecord(i);
  }
}
/** Partitions a split source's bindings at the cut (source ms): the words before it stay left, the rest go right with their
 *  own binding; a caption over the cut becomes two, same look. Reconcile then projects both pieces. */
export function splitBindings(doc: ProjectDocument, left: RecordData, right: RecordData, cutMs: number) {
  for (const b of bindingsOf(right)) {
    const old = b.id, kept = bindingOf(left, old)!;
    b.id = newId('binding'); b.sourceItemId = right.id; b.floorMs = Math.max(b.floorMs, cutMs);
    const repoint = (i: RecordData, words: Resolved[]) => {
      i.captionSourceItemId = right.id;
      i.metadata = { ...i.metadata, captionBindingId: b.id, captionTokens: [...new Set(words.map(w => w.tokenId))], captionWordIds: words.map(w => w.wordId), captionGeneratorSourceItemId: right.id, captionSource: { ...i.metadata?.captionSource, sourceItemId: right.id } };
    };
    const divide = (i: RecordData): RecordData | null => {
      const words = wordsFor(kept, i), side = (test: (ms: number) => boolean) => words.filter(w => test(w.startMs));
      const l = side(ms => ms < cutMs), r = side(ms => ms >= cutMs);
      if (!l.length) { repoint(i, r); return i; }
      if (!r.length) return null;
      const copy = structuredClone(i);
      copy.id = newId('item'); repoint(copy, r);
      i.metadata = { ...i.metadata, captionTokens: [...new Set(l.map(w => w.tokenId))], captionWordIds: l.map(w => w.wordId) };
      return copy;
    };
    for (const i of linkedTo(doc.items, kept)) { const piece = divide(i); if (piece && piece !== i) doc.items.push(piece); }
    const parked = kept.parked.flatMap(i => { const piece = divide(i); return piece ? [piece] : []; });
    kept.parked = kept.parked.filter(i => i.metadata?.captionBindingId === old);
    b.parked = parked;
  }
}
const nearest = (words: StoredWord[], t: number) => words.reduce((p, w) => Math.abs(w.startMs - t) < Math.abs(p.startMs - t) ? w : p);
/** Direct split of a caption with words: each side keeps its words; a side with none keeps the nearest word on its whole
 *  span, detached. Stored times rebase to the right piece's start (tickets "Splitting a caption rebases word times"). */
export function splitCaptionWords(doc: ProjectDocument, left: RecordData, right: RecordData, atMs: number) {
  const words = wordsOf(left), elapsed = atMs - left.display.from + (left.trim?.from ?? 0), l = words.filter(w => w.startMs < elapsed), r = words.filter(w => w.startMs >= elapsed);
  const source = isLinked(left) ? doc.items.find(x => x.id === left.captionSourceItemId) : undefined, b = bindingOf(source, left.metadata?.captionBindingId), clock = source && b ? clockFor(source) : undefined;
  const rewrite = (i: RecordData, list: StoredWord[], shift: number) => {
    if (clock) {
      i.metadata = { ...i.metadata, captionTokens: [...new Set(list.map(w => w.tokenId).filter((x): x is string => !!x))], captionWordIds: list.every(w => w.wordId) ? list.map(w => w.wordId) : undefined };
      const shown = shownWords(b!, i, clock)!;
      i.metadata = { ...i.metadata, captionTiming: declared(source!, clock, shown, i, null) };
      project(doc, source!, clock, b!, i, shown);
      return;
    }
    i.details = { ...i.details, text: list.map(w => w.text).join(' '), words: list.map(w => ({ ...w, startMs: r3(w.startMs - shift), endMs: r3(w.endMs - shift) })) };
    fitBox(i, doc.size);
  };
  const lone = (i: RecordData, w: StoredWord) => { detachRecord(i); i.details = { ...i.details, text: w.text, words: [{ ...w, startMs: 0, endMs: r3(span(i)) }] }; delete i.trim; fitBox(i, doc.size); };
  delete right.trim;
  if (!r.length) { lone(right, nearest(l, elapsed)); return; }
  if (!l.length) lone(left, nearest(r, elapsed)); else rewrite(left, l, 0);
  rewrite(right, r, elapsed);
}

/** Spreads words over [startMs, endMs) by character length (estimated timing, contract §5). */
const spread = (texts: string[], startMs: number, endMs: number) => {
  const total = texts.reduce((n, t) => n + t.length, 0) || 1;
  let at = startMs;
  return texts.map(text => { const from = at; at += (endMs - startMs) * text.length / total; return { text, startMs: r3(from), endMs: r3(at) }; });
};
/** A text edit on a linked caption: corrections on its binding, never on the transcript. Equal word counts keep their anchors;
 *  anything else is one correction over the changed span, labelled estimated. Reconcile is not needed: the caption is
 *  re-projected here. */
export function correctCaption(doc: ProjectDocument, source: RecordData, b: Binding, i: RecordData, text: string) {
  const c = clockFor(source), shown = shownWords(b, i, c);
  if (!shown) return;
  const old = shown.words, next = text.split(/\s+/).filter(Boolean), equal = (n: number, m: number) => shownText(b, old[n].text) === next[m];
  let head = 0, tail = 0;
  while (head < old.length && head < next.length && equal(head, head)) head++;
  while (tail < old.length - head && tail < next.length - head && equal(old.length - 1 - tail, next.length - 1 - tail)) tail++;
  const middle = old.slice(head, old.length - tail), incoming = next.slice(head, next.length - tail);
  if (!middle.length && !incoming.length) return;
  if (middle.length === incoming.length) middle.forEach((w, n) => {
    if (w.correction) w.correction.words[w.index!] = { ...w.correction.words[w.index!], text: incoming[n] };
    else b.corrections.push({ id: newId('fix'), tokenIds: [w.tokenId], words: [{ id: w.wordId, text: incoming[n], startMs: w.startMs, endMs: w.endMs }], estimated: false });
  });
  else {
    let lo = head, hi = old.length - tail, words = incoming;
    if (lo === hi) { if (head > 0) words = [old[--lo].text, ...words]; else words = [...words, old[hi++].text]; } // a pure insertion anchors on its neighbour
    const anchor = old.slice(lo, hi), replaced = new Set(anchor.map(w => w.correction));
    const tokenIds = [...new Set(anchor.flatMap(w => w.correction ? w.correction.tokenIds : [w.tokenId]))];
    const all = resolved(b), first = all.findIndex(w => w.wordId === anchor[0].wordId), last = all.findIndex(w => w.wordId === anchor[anchor.length - 1].wordId);
    // A correction can span several chunks. Keep its words owned by other chunks, with their identities and timing.
    const keep = (w: Resolved) => ({ id: w.wordId, text: w.text, startMs: w.startMs, endMs: w.endMs });
    const inserted = spread(words, anchor[0].startMs, anchor[anchor.length - 1].endMs).map(w => ({ ...w, id: newId('word') }));
    for (const cap of [...linkedTo(doc.items, b), ...b.parked]) {
      const own = wordsFor(b, cap).filter(w => !anchor.some(a => a.wordId === w.wordId)).map(w => w.wordId);
      cap.metadata = { ...cap.metadata, captionWordIds: cap === i ? [...own, ...inserted.map(w => w.id)] : own };
    }
    const before = all.slice(0, first).filter(w => w.correction && replaced.has(w.correction)).map(keep), after = all.slice(last + 1).filter(w => w.correction && replaced.has(w.correction)).map(keep);
    b.corrections = b.corrections.filter(x => !replaced.has(x));
    b.corrections.push({ id: newId('fix'), tokenIds, words: [...before, ...inserted, ...after], estimated: true });
  }
  const now = shownWords(b, i, c);
  if (now) project(doc, source, c, b, i, now);
  else doc.items.splice(doc.items.indexOf(i), 1);
}
/** Explicit reset to the ASR words of a binding: corrections and suppressed intervals go (contract §4 "offer explicit reset"). */
export function resetBinding(doc: ProjectDocument, source: RecordData, b: Binding) {
  const c = clockFor(source);
  b.corrections = []; b.conflicts = [];
  for (const i of [...linkedTo(doc.items, b), ...b.parked]) delete i.metadata!.captionWordIds;
  b.coverage = b.coverage.map(x => x.state === 'excluded' ? { ...x, state: 'complete' as const } : x);
  refresh(doc, source, c, b);
}
/** Maps a transcript revision onto a binding: exact (start, end, text) matches keep their ids; a correction whose tokens did
 *  not all survive becomes a reviewable conflict (contract §1: never aligned by text alone). */
export function rebaseTokens(b: Binding, tokens: Token[], revision: string): { tokens: Token[]; conflicts: Correction[] } {
  const key = (t: Token) => `${t.startMs}|${t.endMs}|${t.text}`, old = new Map(b.tokens.map(t => [key(t), t.id])), kept = new Set<string>();
  const fresh = tokens.map(t => { const id = old.get(key(t)); if (id) kept.add(id); return { ...t, id: id ?? `${revision}-${t.id}` }; });
  return { tokens: fresh, conflicts: b.corrections.filter(c => !c.tokenIds.every(id => kept.has(id))) };
}
