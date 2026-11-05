// SPDX-License-Identifier: AGPL-3.0-only
// T05 text keys of editProperties (contracts editProperties "Text"; findings part 2 §40 Text row, §34 looks, part 5
// §53.7.2): the checks and the writes shared by the agent tools and the text inspector. Storage: the text, the font
// (fontFamily = the face, fontFamilyDisplay = the family, fontUrl), the look and the animation config in details; every
// other style key as a stored property ({defaultValue, keyframes: []}; not animatable). Value wording is Cutframe's own
// (Xapp's validator texts are not stored).
import type { RecordData } from '../store/model';
import { fontSizePx } from '../render/text-layout';
import { fail } from '../timeline/model';
import { setStatic, staticValue } from '../timeline/properties';
import { checkAnimation } from './animation';
import { findFont, resolveFont } from './font-registry';
import { CLEARED_SHADOW, checkLook, lookFallbacks, readLook } from './looks';
import { PARITY } from './parity-switches';
import { parseGradient } from './style';

/** The T05 keys editProperties accepts on a text item besides the registry's. borderColor and boxShadow are text keys here,
 *  not registry keys: the stroke and the shadow draw only when set (part 5 §53.7.2), so a registry default would change the
 *  render. */
export const TEXT_EDIT_KEYS = ['text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'backgroundColor', 'textAlign', 'textDecoration',
  'textTransform', 'lineHeight', 'letterSpacing', 'wordSpacing', 'wordWrap', 'wordBreak', 'look', 'textAnimation', 'borderColor', 'boxShadow'];
export const isTextKey = (k: string) => TEXT_EDIT_KEYS.includes(k);
/** Keys whose edit needs a font face loaded first (coordinator ruling Q5: the agent path awaits the load). */
export const FONT_KEYS = ['fontFamily', 'fontWeight', 'fontStyle'];

/** Colour strings as timeline/edits.ts accepts them: hex, rgb()/rgba()/hsl()/hsla(), or a CSS colour name. */
const COLOUR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\([^()]*\)|[a-z]+)$/i;
export const colourOk = (v: unknown) => typeof v === 'string' && COLOUR.test(v.trim());
const ENUMS: Record<string, string[]> = {
  fontStyle: ['normal', 'italic', 'oblique'], textAlign: ['left', 'center', 'right', 'justify'], textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'],
  wordWrap: ['normal', 'break-word', 'anywhere'], wordBreak: ['normal', 'break-all', 'keep-all', 'break-word'],
};
const DECORATIONS = ['underline', 'line-through', 'overline'], WEIGHTS = ['normal', 'bold', 'bolder', 'lighter'];
const SIZE = /^\d+(\.\d+)?(px)?$/, LENGTH = /^\d+(\.\d+)?(px|%|em)?$/, SPACING = /^-?\d+(\.\d+)?(px|em)?$/;
const show = (v: unknown) => JSON.stringify(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** FONT_NOT_FOUND (error codes l.127; results §2 editProperties; Q2: the wording stays although `fonts` is not served yet). */
export const fontNotFoundText = (name: string) => `Font '${name}' is unavailable. Choose a font from the fonts tool.`;
const fontNotFound = (name: string): never => fail('FONT_NOT_FOUND', fontNotFoundText(name));

/** One T05 key on a text item: INVALID_PROPERTY_VALUE, FONT_NOT_FOUND, INVALID_TEXT_ANIMATION or a look code. */
export function checkTextProperty(i: RecordData, k: string, v: unknown) {
  const bad = (why: string): never => fail('INVALID_PROPERTY_VALUE', `${k} ${why}`);
  const oneOf = (list: string[]) => { if (typeof v !== 'string' || !list.includes(v)) bad(`must be one of: ${list.join(', ')}`); };
  switch (k) {
    case 'text': if (typeof v !== 'string') bad('must be a string'); return;
    case 'fontFamily':
      if (typeof v !== 'string') bad('must be a string');
      if (!(v as string).trim()) bad('must not be empty');
      if (!findFont(v as string)) fontNotFound(v as string);
      return;
    case 'fontSize':
      if (finite(v) ? v <= 0 : typeof v !== 'string' || !SIZE.test(v.trim()) || !(parseFloat(v) > 0)) bad(`must be a positive size in px (a number or "<n>px"), got: ${show(v)}`);
      return;
    case 'fontWeight':
      if (finite(v) ? v < 1 || v > 1000 : typeof v !== 'string' || !(WEIGHTS.includes(v) || /^\d+$/.test(v) && +v >= 1 && +v <= 1000)) bad(`must be normal, bold, bolder, lighter or a number from 1 to 1000, got: ${show(v)}`);
      return;
    case 'fontStyle': case 'textAlign': case 'textTransform': case 'wordWrap': case 'wordBreak': oneOf(ENUMS[k]); return;
    case 'color': if (!colourOk(v) && !parseGradient(v)) bad(`must be a valid colour or a CSS linear-gradient() / radial-gradient(), got: ${show(v)}`); return;
    case 'backgroundColor': case 'borderColor': if (!colourOk(v)) bad(`must be a valid colour, got: ${show(v)}`); return;
    case 'textDecoration': {
      const t = typeof v === 'string' ? v.trim().split(/\s+/) : [];
      if (!(t.length === 1 && t[0] === 'none') && !(t.length && t.every(x => DECORATIONS.includes(x)) && new Set(t).size === t.length)) bad(`must be none or any of ${DECORATIONS.join(', ')} separated by spaces, got: ${show(v)}`);
      return;
    }
    case 'lineHeight': if (finite(v) ? v < 0 : v !== 'normal' && (typeof v !== 'string' || !LENGTH.test(v.trim()))) bad(`must be normal, a number of at least 0, or a length in px, % or em, got: ${show(v)}`); return;
    case 'letterSpacing': case 'wordSpacing': if (!finite(v) && v !== 'normal' && (typeof v !== 'string' || !SPACING.test(v.trim()))) bad(`must be normal, a number of px or a length in px or em, got: ${show(v)}`); return;
    case 'look': checkLook(v, i.details?.look); return;
    case 'textAnimation': checkAnimation(v); return;
    case 'boxShadow':
      if (!v || typeof v !== 'object' || Array.isArray(v)) bad('has the wrong value type');
      for (const f of ['blur', 'x', 'y']) if ((v as RecordData)[f] !== undefined && !finite((v as RecordData)[f])) fail('INVALID_PROPERTY_VALUE', `boxShadow.${f} must be finite`);
      if ((v as RecordData).color !== undefined && !colourOk((v as RecordData).color)) fail('INVALID_PROPERTY_VALUE', `boxShadow.color must be a valid colour, got: ${show((v as RecordData).color)}`);
      return;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function writeStatic(i: RecordData, k: string, v: unknown) { if (!same(staticValue(i, k), v)) setStatic(i, k, v); }
function setDetail(i: RecordData, k: string, v: unknown) {
  if (same(i.details?.[k], v ?? undefined)) return;
  const d = { ...i.details };
  if (v === null || v === undefined) delete d[k]; else d[k] = v;
  i.details = d;
}
/** The family the item uses now: the display family, else the stored face. */
export const currentFamily = (i: RecordData) => String(i.details?.fontFamilyDisplay || i.details?.fontFamily || '');

/** Family, weight and style of one call. PARITY.weightFace 'switch': the stored face follows the family, weight and style
 *  (a face name with no weight or style in the call sets the weight and style properties to that face's); 'keep' (Xapp):
 *  only a family change writes the face, weight and style write their properties only. */
export function writeFont(i: RecordData, p: RecordData) {
  const given = typeof p.fontFamily === 'string', m = findFont(given ? p.fontFamily : currentFamily(i));
  const face = given && m?.variant && p.fontWeight === undefined && p.fontStyle === undefined ? m.variant : undefined;
  const switching = PARITY.weightFace === 'switch';
  let weight = p.fontWeight, style = p.fontStyle;
  if (face && switching) { weight = face.weight; style = face.italic ? 'italic' : 'normal'; }
  if (weight !== undefined) writeStatic(i, 'fontWeight', weight);
  if (style !== undefined) writeStatic(i, 'fontStyle', style);
  if (!m || !given && !switching) return;
  const r = face ? resolveFont(face.face)! : resolveFont(m.entry.family, staticValue(i, 'fontWeight') ?? 'normal', staticValue(i, 'fontStyle') ?? 'normal')!;
  setDetail(i, 'fontFamily', r.variant.face); setDetail(i, 'fontFamilyDisplay', r.entry.family); setDetail(i, 'fontUrl', r.url);
}

/** Writes the checked T05 keys of one call into a text item. A look style newly set (or re-tinted) writes its plain
 *  fallbacks where the call has no explicit key; an effect newly set clears a visible box shadow (§34). */
export function writeTextProperties(i: RecordData, props: RecordData) {
  const p: RecordData = Object.fromEntries(Object.keys(props).filter(isTextKey).map(k => [k, props[k]]));
  if (!Object.keys(p).length) return;
  if ('look' in p) {
    const was = readLook(i.details?.look), look = checkLook(p.look, i.details?.look);
    setDetail(i, 'look', look);
    if (look?.style && (look.style.id !== was?.style?.id || look.color !== was?.color)) {
      const fb = lookFallbacks(look, fontSizePx(p.fontSize ?? staticValue(i, 'fontSize') ?? i.details?.fontSize));
      for (const [k, v] of Object.entries(fb.properties)) if (!(k in p)) p[k] = v;
      if (fb.details.fontFamily && !('fontFamily' in p)) p.fontFamily = fb.details.fontFamily;
    }
    if (look?.effect && look.effect.id !== was?.effect?.id && !('boxShadow' in p)) p.boxShadow = { ...CLEARED_SHADOW };
  }
  if (FONT_KEYS.some(k => k in p)) writeFont(i, p);
  for (const [k, v] of Object.entries(p)) {
    if (k === 'look' || FONT_KEYS.includes(k)) continue;
    if (k === 'text') setDetail(i, 'text', v);
    else if (k === 'textAnimation') setDetail(i, 'textAnimation', checkAnimation(v));
    else if (k === 'boxShadow') {
      const s = v as RecordData;
      writeStatic(i, k, { ...CLEARED_SHADOW, ...staticValue(i, k) as RecordData, ...Object.fromEntries(['color', 'x', 'y', 'blur'].filter(f => s[f] !== undefined).map(f => [f, s[f]])) });
    } else writeStatic(i, k, v);
  }
}
