// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption style edits (agent tool results §2 editAllCaptionStyles, editProperties caption path; error codes §5). The
// field checks and writes shared by editAllCaptionStyles (whole track), the caption path of editProperties (one caption or a
// batch, plus applyToAll) and the inspector. A caption stores its look as text does (font in details; renderMode / renderConfig
// / textAnimation in details; every other style key as a stored property); a text change is a correction on the binding
// (links.ts), never on the transcript. Geometry keys re-measure the box. Pure of font files: text/agent.ts loads the faces.
import type { ProjectDocument, RecordData } from '../store/model';
import { fail, isCaption, item, track, trackLocked } from '../timeline/model';
import { prop, setStatic, staticValue } from '../timeline/properties';
import { BLEND_MODES } from '../timeline/edits';
import { checkAnimation } from '../text/animation';
import { findFont, resolveFont } from '../text/font-registry';
import { bindingOf, bindingsOf, fitBox, isLinked } from './model';
import { correctCaption } from './links';
import { CAPTION_PARITY } from './parity-switches';

/** The five render modes (results §2 editAllCaptionStyles). */
export const RENDER_MODES = ['default', 'highlight', 'word-by-word', 'slide-up', 'slide-left'];
/** Style keys that live in details (not stored properties): the font face fields, the render mode and its config, the animation. */
const DETAIL_KEYS = new Set(['fontFamily', 'fontFamilyDisplay', 'fontUrl', 'renderMode', 'renderConfig', 'textAnimation', 'highlightColor']);
/** Keys whose change re-measures the box (type metrics and spacing; results §2 "also re-measures every caption box"). */
const BOX_KEYS = new Set(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textTransform', 'letterSpacing', 'textAlign', 'lineHeight', 'borderWidth', 'boxShadow']);

const COLOUR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\([^()]*\)|[a-z]+)$/i;
const colourOk = (v: unknown) => typeof v === 'string' && COLOUR.test(v.trim());
const colourOrKeyword = (v: unknown) => colourOk(v) || v === 'transparent' || v === 'none';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const LENGTH = /^-?\d+(\.\d+)?(px|em)?$/;
const WEIGHTS = ['normal', 'bold'];
const ALIGN = ['left', 'center', 'right'];
const STYLES = ['normal', 'italic'];
const TRANSFORMS = ['none', 'uppercase', 'lowercase', 'capitalize'];
const DECORATIONS = ['none', 'underline', 'line-through', 'overline'];

export type FieldError = { field: string; message: string };
/** Validates one caption style field, pushing to `errors` (all problems at once, results §2). `text` is handled by the caller. */
export function checkStyleField(k: string, v: unknown, errors: FieldError[]) {
  const bad = (message: string) => errors.push({ field: k, message });
  switch (k) {
    case 'fontFamily': if (typeof v !== 'string' || !v.trim()) return bad('must be a font name'); if (!findFont(v)) bad(`font '${v}' is not available`); return;
    case 'fontSize': if (!(finite(v) && v >= 1)) bad('must be a number of at least 1'); return;
    case 'fontWeight': if (!(WEIGHTS.includes(v as string) || (finite(v) ? v >= 100 && v <= 900 : typeof v === 'string' && /^\d+$/.test(v) && +v >= 100 && +v <= 900))) bad('must be normal, bold or 100–900'); return;
    case 'fontStyle': if (!STYLES.includes(v as string)) bad(`must be one of: ${STYLES.join(', ')}`); return;
    case 'textAlign': if (!ALIGN.includes(v as string)) bad(`must be one of: ${ALIGN.join(', ')}`); return;
    case 'textTransform': if (!TRANSFORMS.includes(v as string)) bad(`must be one of: ${TRANSFORMS.join(', ')}`); return;
    case 'textDecoration': { const t = typeof v === 'string' ? v.trim().split(/\s+/) : []; if (!t.length || !t.every(x => DECORATIONS.includes(x))) bad(`must be any of: ${DECORATIONS.join(', ')}`); return; }
    case 'renderMode': if (!RENDER_MODES.includes(v as string)) bad(`must be one of: ${RENDER_MODES.join(', ')}`); return;
    case 'blendMode': if (!BLEND_MODES.includes(v as string)) bad(`must be one of the 16 blend modes`); return;
    case 'color': case 'backgroundColor': case 'borderColor': case 'highlightColor': if (!colourOrKeyword(v)) bad('must be a colour, transparent or none'); return;
    case 'opacity': if (!(finite(v) && v >= 0 && v <= 1)) bad('must be 0–1'); return;
    case 'lineHeight': if (!(finite(v) && v >= 0.5 && v <= 3)) bad('must be a multiplier 0.5–3'); return;
    case 'letterSpacing': if (!(v === 'normal' || finite(v) || (typeof v === 'string' && LENGTH.test(v.trim())))) bad('must be normal or a CSS length'); return;
    case 'borderWidth': if (!(finite(v) && v >= 0 && v <= 100)) bad('must be 0–100'); return;
    case 'boxShadow':
      if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('must be an object');
      for (const f of ['blur', 'x', 'y']) if ((v as RecordData)[f] !== undefined && !finite((v as RecordData)[f])) bad(`shadow ${f} must be finite`);
      if ((v as RecordData).color !== undefined && !colourOrKeyword((v as RecordData).color)) bad('shadow color must be a colour');
      return;
    case 'textAnimation': try { checkAnimation(v); } catch (e) { bad((e as { extra?: { message?: string } }).extra?.message ?? 'is invalid'); } return;
    default: bad('is not a caption style property');
  }
}
/** Every caption style key (what editAllCaptionStyles and the caption editProperties path accept besides `text`). */
export const CAPTION_STYLE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'backgroundColor', 'borderColor', 'highlightColor', 'borderWidth',
  'lineHeight', 'letterSpacing', 'opacity', 'boxShadow', 'blendMode', 'textAlign', 'textDecoration', 'textTransform', 'renderMode', 'textAnimation'];
export const isCaptionStyleKey = (k: string) => CAPTION_STYLE_KEYS.includes(k);

const SHADOW = ['blur', 'color', 'x', 'y'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Writes the checked style keys of one call into a caption item. highlightColor sits under renderConfig; the font face fields
 *  follow a family change; boxShadow merges its fields. Returns the storage names changed (A0.3 changedFields). */
export function writeCaptionStyle(i: RecordData, props: RecordData): string[] {
  const changed: string[] = [], was = structuredClone({ details: i.details, properties: i.properties });
  if (typeof props.fontFamily === 'string') {
    const r = resolveFont(props.fontFamily, props.fontWeight, props.fontStyle);
    if (r) i.details = { ...i.details, fontFamily: r.variant.face, fontFamilyDisplay: r.entry.family, fontUrl: r.url };
  }
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text' || k === 'fontFamily') continue;
    if (k === 'textDecoration' && CAPTION_PARITY.decorations === 'xapp') continue;
    if (k === 'highlightColor') { i.details = { ...i.details, renderConfig: { ...i.details?.renderConfig, highlightColor: v } }; continue; }
    if (k === 'renderMode') { i.details = { ...i.details, renderMode: v }; continue; }
    if (k === 'textAnimation') { i.details = { ...i.details, textAnimation: checkAnimation(v) }; continue; }
    if (k === 'boxShadow') { const s = v as RecordData; setStatic(i, k, { ...(staticValue(i, k) as RecordData ?? {}), ...Object.fromEntries(SHADOW.filter(f => s[f] !== undefined).map(f => [f, s[f]])) }); continue; }
    setStatic(i, k, v);
  }
  for (const k of new Set(Object.keys(props).concat('fontFamilyDisplay', 'fontUrl'))) {
    if (DETAIL_KEYS.has(k) || k === 'text') { if (!same(was.details?.[k], i.details?.[k])) changed.push(`details.${k}`); }
    else if (!same(prop({ properties: was.properties } as RecordData, k)?.defaultValue, prop(i, k)?.defaultValue)) changed.push(`properties.${k}`);
  }
  return changed;
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** A detached or bare caption's new text re-spreads the stored words over the caption's duration by character length (contract
 *  §4; a linked caption's text is a correction on its binding instead — see links.correctCaption). */
function respread(i: RecordData, text: string, size: { width: number; height: number }) {
  const parts = text.split(/\s+/).filter(Boolean), total = parts.reduce((n, p) => n + p.length, 0) || 1, dur = i.display.to - i.display.from;
  let at = 0;
  const words = parts.map(p => { const from = at; at += dur * p.length / total; return { text: p, startMs: r3(from), endMs: r3(at), sourceStartMs: r3(from), sourceEndMs: r3(at) }; });
  i.details = { ...i.details, text, words };
  fitBox(i, size);
}
/** The source and binding of a linked caption on the live draft, or null. */
const linkOf = (doc: ProjectDocument, i: RecordData) => {
  if (!isLinked(i)) return null;
  const source = doc.items.find(x => x.id === i.captionSourceItemId), b = bindingOf(source, i.metadata!.captionBindingId);
  return source && b ? { source, b } : null;
};
/** Validates then writes the style keys of `props` on every caption in `items` (box re-measured when geometry changed), and
 *  updates the look of bindings whose captions are among them. Throws PROPERTY_VALIDATION_FAILED with all problems. Returns the
 *  changed storage names per item id. */
export function applyStyles(doc: ProjectDocument, items: RecordData[], props: RecordData): Record<string, string[]> {
  const errors: FieldError[] = [];
  for (const [k, v] of Object.entries(props)) checkStyleField(k, v, errors);
  if (errors.length) fail('PROPERTY_VALIDATION_FAILED', 'Property validation failed', { message: `Invalid properties: ${errors.map(e => `${e.field} ${e.message}`).join(', ')}`, details: { validationErrors: errors } });
  const geometry = Object.keys(props).some(k => BOX_KEYS.has(k)), changed: Record<string, string[]> = {};
  for (const i of items) {
    changed[i.id] = writeCaptionStyle(i, props);
    if (geometry) { fitBox(i, doc.size); if (!changed[i.id].includes('properties.width')) changed[i.id].push('details.height', 'properties.height'); }
    const link = linkOf(doc, i);
    if (link) link.b.style = { details: { ...link.b.style.details, ...Object.fromEntries(Object.entries(i.details ?? {}).filter(([k]) => DETAIL_KEYS.has(k))) }, properties: { ...link.b.style.properties, ...Object.fromEntries(Object.keys(props).filter(k => !DETAIL_KEYS.has(k) && k !== 'text').map(k => [k, staticValue(i, k)])) } };
  }
  return changed;
}
/** editAllCaptionStyles on one track: all its captions restyled at once, their bindings' looks updated. */
export function editAllCaptionStyles(doc: ProjectDocument, trackId: string, props: RecordData): { updatedCount: number; updatedIds: string[]; changed: Record<string, string[]> } {
  if (!trackId) fail('MISSING_TRACK_ID', 'trackId is required');
  if (!track(doc, trackId)) fail('TRACK_NOT_FOUND', 'Track not found');
  if (trackLocked(doc, trackId)) fail('TRACK_LOCKED', `Track ${trackId} is locked`);
  const style = Object.fromEntries(Object.entries(props).filter(([k]) => isCaptionStyleKey(k)));
  if (!Object.keys(style).length) fail('NO_PROPERTIES_PROVIDED', 'No valid properties provided');
  const captions = doc.items.filter(i => i.trackId === trackId && isCaption(i)).sort((a, b) => a.display.from - b.display.from);
  if (!captions.length) fail('NO_CAPTIONS', 'No captions on track', { message: `No caption items found on track ${trackId}. Add captions first.` });
  const changed = applyStyles(doc, captions, style);
  return { updatedCount: captions.length, updatedIds: captions.map(i => i.id), changed };
}
/** The caption path of editProperties: `text` is a correction (linked) or a re-spread (detached / bare); style keys restyle the
 *  caption, and applyToAll the whole track. Returns per-caption applied counts. Throws on a bad field or a non-caption id. */
export function editCaptionProperties(doc: ProjectDocument, ids: string[], props: RecordData, applyToAll: boolean): { results: { itemId: string; changed: string[]; appliedToCount: number }[] } {
  const style = Object.fromEntries(Object.entries(props).filter(([k]) => isCaptionStyleKey(k)));
  const text = typeof props.text === 'string' ? props.text : undefined;
  if (text === undefined && !Object.keys(style).length) fail('NO_PROPERTIES_PROVIDED', 'No valid properties provided');
  if (Object.keys(style).length) { const errors: FieldError[] = []; for (const [k, v] of Object.entries(style)) checkStyleField(k, v, errors); if (errors.length) fail('PROPERTY_VALIDATION_FAILED', 'Property validation failed', { message: `Invalid properties: ${errors.map(e => `${e.field} ${e.message}`).join(', ')}`, details: { validationErrors: errors } }); }
  const results: { itemId: string; changed: string[]; appliedToCount: number }[] = [];
  for (const id of ids) {
    const i = item(doc, id);
    if (!i) fail('CAPTION_NOT_FOUND', 'Caption item not found', { message: `Caption '${id}' not found.` });
    if (!isCaption(i)) fail('INVALID_ITEM_TYPE', 'Not a caption item', { details: { actualType: i.type, expectedType: 'caption' } });
    if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`);
    const changed = Object.keys(style).length ? applyStyles(doc, [i], style)[id] : [];
    if (text !== undefined) {
      const link = linkOf(doc, i);
      if (link) correctCaption(doc, link.source, link.b, i, text);
      else respread(i, text, doc.size);
      changed.push('details.text', 'details.words', 'details.height', 'properties.height');
    }
    let appliedToCount = 0;
    if (applyToAll && Object.keys(style).length) {
      const others = doc.items.filter(x => x.trackId === i.trackId && isCaption(x) && x.id !== id);
      applyStyles(doc, others, style); appliedToCount = others.length;
    }
    results.push({ itemId: id, changed, appliedToCount });
  }
  return { results };
}

/** The caption inspector's Transform (scale / rotation / position). The editProperties caption whitelist stays style + text
 *  (editCaptionProperties, test t09-styles), so caption geometry is its own UI-only command — the agent path does not reach
 *  it. Writes the finite values as stored properties; the box is not re-measured (geometry does not change type metrics). */
export const CAPTION_TRANSFORM_KEYS = ['scale', 'rotation', 'positionX', 'positionY'];
export function editCaptionTransform(doc: ProjectDocument, ids: string[], props: RecordData): { updatedIds: string[] } {
  const keys = Object.keys(props).filter(k => CAPTION_TRANSFORM_KEYS.includes(k));
  if (!keys.length) fail('NO_PROPERTIES_PROVIDED', 'No valid properties provided', { message: `Provide one of: ${CAPTION_TRANSFORM_KEYS.join(', ')}.` });
  const errors: FieldError[] = [];
  for (const k of keys) if (!finite(props[k])) errors.push({ field: k, message: 'must be a finite number' });
  if (errors.length) fail('PROPERTY_VALIDATION_FAILED', 'Property validation failed', { message: `Invalid properties: ${errors.map(e => `${e.field} ${e.message}`).join(', ')}`, details: { validationErrors: errors } });
  for (const id of ids) {
    const i = item(doc, id);
    if (!i) fail('CAPTION_NOT_FOUND', 'Caption item not found', { message: `Caption '${id}' not found.` });
    if (!isCaption(i!)) fail('INVALID_ITEM_TYPE', 'Not a caption item', { details: { actualType: i!.type, expectedType: 'caption' } });
    if (trackLocked(doc, i!.trackId)) fail('TRACK_LOCKED', `Track ${i!.trackId} is locked`);
    for (const k of keys) setStatic(i!, k, props[k]);
  }
  return { updatedIds: ids };
}
