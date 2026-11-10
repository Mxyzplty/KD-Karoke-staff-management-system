// SPDX-License-Identifier: AGPL-3.0-only
// T09 the stored caption (findings part 3 §44.1 step 7) and its source link (caption timing contract §2–§4). The link lives
// on the source occurrence (`item.captionBindings`): immutable ASR tokens, corrections on top of them, coverage, the options
// and style new chunks take. A linked caption names its binding and its tokens; its words and display are projected from
// them through the occurrence's clock (links.ts). Bindings travel with the items, so an undo restores them with the rest.
import type { RecordData } from '../store/model';
import { fontSizePx, textLinePitch, textPadding } from '../render/text-layout';
import { resolveFont } from '../text/font-registry';
import { measureContext, measuredLayout, setTextFont } from '../text/measure';
import type { Ctx } from '../text/measure';
import { textStyle } from '../text/style';
import { newId } from '../timeline/model';
import { prop, setStatic, staticValue, storedProperties } from '../timeline/properties';
import type { ChunkOptions } from './chunker';
import type { StyleSpec } from './templates';
import { styleTop } from './templates';
import { CAPTION_PARITY } from './parity-switches';

/** One ASR word in source ms. Immutable: a correction never rewrites it. */
export type Token = { id: string; text: string; startMs: number; endMs: number; speaker: number | null };
/** Replaces `tokenIds` (consecutive, one or more) by `words`; timing is `estimated` when redistributed. No words = deleted. */
export type Correction = { id: string; tokenIds: string[]; words: { id?: string; text: string; startMs: number; endMs: number }[]; estimated: boolean };
/** Half-open source interval. `complete`: analysed (no token in it = confirmed silence). `excluded`: suppressed by the user.
 *  `pending` / `unresolved`: analysis running / missing. A gap: not requested (outside a ranged generation). */
export type Coverage = { fromMs: number; toMs: number; state: 'complete' | 'excluded' | 'pending' | 'unresolved' };
export type CaptionStyleRecord = { details: RecordData; properties: RecordData };
export type Binding = {
  version: 1; id: string; sourceItemId: string; assetId: string; revision: string; mode: 'linked'; trackId: string; speaker: number | null; run: number;
  tokens: Token[]; corrections: Correction[]; conflicts: Correction[]; coverage: Coverage[]; options: ChunkOptions; style: CaptionStyleRecord; floorMs: number;
  parked: RecordData[]; range: { startMs: number; endMs: number } | null;
};
/** A stored word: item-relative project ms (remnants: relative to the old item, so τ = local + trim.from) and source ms. */
export type StoredWord = { text: string; startMs: number; endMs: number; sourceStartMs: number; sourceEndMs: number; tokenId?: string; wordId?: string; partial?: boolean; estimated?: boolean };

export const isLinked = (i: RecordData | undefined): i is RecordData => !!i?.captionSourceItemId && typeof i.metadata?.captionBindingId === 'string';
export const isDetached = (i: RecordData) => i.metadata?.captionMode === 'detached';
export const bindingsOf = (i: RecordData | undefined): Binding[] => Array.isArray(i?.captionBindings) ? i!.captionBindings : [];
export const bindingOf = (source: RecordData | undefined, id: unknown) => bindingsOf(source).find(b => b.id === id);
export const wordsOf = (i: RecordData): StoredWord[] => Array.isArray(i.details?.words) ? i.details!.words : [];

/** FNV-1a over the words: the transcript revision, and the content hash of `captionSource`. */
export function contentHash(words: { text: string; startMs: number; endMs: number }[]): string {
  const s = words.map(w => `${w.text}|${w.startMs}|${w.endMs}`).join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** The stored fields of a look (§44.1 step 7). Box and position are measured per caption. */
export function styleRecord(s: StyleSpec): CaptionStyleRecord {
  const r = resolveFont(s.family, s.fontWeight, s.fontStyle);
  return {
    details: { ...r ? { fontFamily: r.variant.face, fontFamilyDisplay: r.entry.family, fontUrl: r.url } : {}, renderMode: s.renderMode, renderConfig: s.renderConfig, ...s.textAnimation ? { textAnimation: s.textAnimation } : {} },
    properties: { scale: 1, opacity: 1, borderWidth: s.borderWidth, borderColor: s.borderColor, fontSize: s.fontSize, fontWeight: s.fontWeight, fontStyle: s.fontStyle, color: s.color,
      backgroundColor: s.backgroundColor, textAlign: 'center', textTransform: s.textTransform, ...(s.textDecoration && CAPTION_PARITY.decorations !== 'xapp' ? { textDecoration: s.textDecoration } : {}), letterSpacing: s.letterSpacing, boxShadow: s.boxShadow, rotation: 0, blendMode: 'normal' },
  };
}
const upper = (r: Pick<CaptionStyleRecord, 'properties'>) => r.properties.textTransform === 'uppercase';
/** Display text of a word under a look: an uppercase look stores upper-cased text (OT-7 template cases); tokens keep theirs. */
export const shownText = (b: Binding, text: string) => upper(b.style) ? text.toUpperCase() : text;

/** The box of a caption (provisional fit, notes "Open questions": the three stored boxes, CAP-P14 ±2 px): width = the widest
 *  line wrapped at 85 % of the canvas + F + 11, height = lines × L + 0.8 F − 2 rounded down, L the text pitch with its padding. */
export function measureBox(i: RecordData, canvasWidth: number, ctx: Ctx = measureContext()): { width: number; height: number } {
  const s = { ...textStyle(i, 0, 'caption'), wrap: 'normal' as const }, F = fontSizePx(s.F), layout = measuredLayout(ctx, s, 0.85 * canvasWidth);
  setTextFont(ctx, s);
  const pitch = s.lineHeight === undefined || s.lineHeight === null ? textLinePitch(F, undefined, textPadding(s.borderWidth, staticValue(i, 'boxShadow') as never)) : s.pitch;
  return { width: Math.round(Math.max(0, ...layout.lines.map(l => l.width))) + F + 11, height: Math.floor(layout.lines.length * pitch + 0.8 * F - 2) };
}
const roundHalfUp = (v: number) => Math.floor(v + 0.5);
/** Writes the measured box. A caption that sat centred stays centred; one the user moved keeps its x. */
export function fitBox(i: RecordData, size: { width: number; height: number }) {
  const was = Number(prop(i, 'width')?.defaultValue), x = Number(prop(i, 'positionX')?.defaultValue);
  const centred = !Number.isFinite(was) || !Number.isFinite(x) || Math.abs(x - (size.width - was) / 2) <= 1;
  const box = measureBox(i, size.width);
  setStatic(i, 'width', box.width); setStatic(i, 'height', box.height);
  i.details = { ...i.details, width: box.width, height: box.height };
  if (centred) setStatic(i, 'positionX', roundHalfUp((size.width - box.width) / 2));
}
/** A new caption item in a look, its box measured. */
export function captionRecord(o: { trackId: string; display: { from: number; to: number }; text: string; words: StoredWord[]; style: CaptionStyleRecord; top: number; metadata: RecordData; size: { width: number; height: number }; sourceItemId?: string }): RecordData {
  const record: RecordData = { id: newId('item'), type: 'caption', trackId: o.trackId, display: o.display, details: { text: o.text, words: o.words, ...structuredClone(o.style.details) },
    properties: storedProperties({ ...structuredClone(o.style.properties), positionY: o.top }), metadata: o.metadata, masks: [], effects: [],
    ...o.sourceItemId ? { captionSourceItemId: o.sourceItemId } : {} };
  fitBox(record, o.size);
  return record;
}
/** The look of a binding from a spec, with the top of its box. */
export const lookOf = (s: StyleSpec, height: number) => ({ style: styleRecord(s), top: styleTop(s, height) });
