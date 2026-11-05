// SPDX-License-Identifier: AGPL-3.0-only
// T05 text looks (findings part 2 §34). The stored shape, the agent validation, the error codes and the plain fallbacks
// are Xapp's; the catalogue is Cutframe's own (Xapp's web editor has none and refuses every look with
// TEXT_LOOKS_UNAVAILABLE: PARITY.looks 'unavailable'). A look is drawn as the plain fallbacks (font, case, letter spacing,
// colour, border; written into the item when the style is set) plus the look's own passes: extra outline rings outside
// the border, its shadow, and an effect's echo copies (text/draw.ts). Sizes in the catalogue are fractions of the font size.
import type { RecordData } from '../store/model';
import { fail } from '../timeline/model';
import { PARITY } from './parity-switches';
import type { Shadow } from './style';

/** A catalogue entry, as stored in the look (§34: {id, version, name, params, font?, keyColor?}). */
export type LookEntry = { id: string; version: 1; name: string; params: RecordData; font?: string; keyColor?: string };
/** The stored look: {version 1, style, effect, color, outline}. outline = the style's outline (its fallback border) or null. */
export type Look = { version: 1; style: LookEntry | null; effect: LookEntry | null; color: string | null; outline: { width: number; color: string } | null };

type StyleParams = { transform: string; letterSpacing: string; border: [number, string]; rings: [number, string][]; shadow: [string, number, number, number] | null };
const style = (id: string, name: string, keyColor: string, params: StyleParams, font?: string): LookEntry => ({ id, version: 1, name, params, keyColor, ...font ? { font } : {} });
/** Our styles. border = the fallback border [width × F, colour]; rings = extra outline rings outside it [width × F, colour]
 *  (drawn widest first); shadow = [colour ('key' = the key colour), x × F, y × F, blur × F]. */
export const LOOK_STYLES: LookEntry[] = [
  style('classic-outline', 'Classic outline', '#ffffff', { transform: 'none', letterSpacing: 'normal', border: [0.05, '#000000'], rings: [], shadow: null }),
  style('double-outline', 'Double outline', '#ffe14d', { transform: 'none', letterSpacing: 'normal', border: [0.05, '#ffffff'], rings: [[0.16, '#000000']], shadow: null }),
  style('neon', 'Neon', '#39ff14', { transform: 'none', letterSpacing: '0.02em', border: [0.015, '#ffffff'], rings: [], shadow: ['key', 0, 0, 0.3] }),
  style('poster', 'Poster', '#ffd400', { transform: 'uppercase', letterSpacing: '0.02em', border: [0.07, '#111111'], rings: [], shadow: ['#111111', 0.06, 0.06, 0] }, 'Anton'),
  style('soft-shadow', 'Soft shadow', '#ffffff', { transform: 'none', letterSpacing: 'normal', border: [0, '#000000'], rings: [], shadow: ['rgba(0, 0, 0, 0.6)', 0, 0.04, 0.12] }),
  style('retro', 'Retro', '#ff5a36', { transform: 'uppercase', letterSpacing: '0.05em', border: [0.05, '#2b1a40'], rings: [], shadow: ['#2b1a40', 0.08, 0.08, 0] }, 'Bebas Neue'),
];
type EffectParams = { shadow: [string, number, number, number] | null; copies: [number, number, number][] };
const effect = (id: string, name: string, params: EffectParams): LookEntry => ({ id, version: 1, name, params });
/** Our effects. shadow as for styles ('key' = the key colour, else the text colour); copies = echo copies [dx × F, dy × F, alpha]. */
export const LOOK_EFFECTS: LookEntry[] = [
  effect('glow', 'Glow', { shadow: ['key', 0, 0, 0.35], copies: [] }),
  effect('drop', 'Drop shadow', { shadow: ['rgba(0, 0, 0, 0.75)', 0.06, 0.06, 0.02], copies: [] }),
  effect('echo', 'Echo', { shadow: null, copies: [[0.08, 0.08, 0.5], [0.16, 0.16, 0.25]] }),
];
const byId = (list: LookEntry[], id: unknown) => list.find(e => e.id === id);
const HEX = /^#[0-9a-f]{6}$/i;
const ids = (list: LookEntry[]) => list.map(e => e.id).join(', ');

/** §34 validation of an agent `look` value against the item's current look. Returns the look to store (null = removed). */
export function checkLook(value: unknown, current: unknown): Look | null {
  if (PARITY.looks === 'unavailable') {
    const t = 'Text styles and effects render only in the Xapp iPhone app; this editor cannot draw them. Nothing was changed. Do not retry with look; style the text with fonts, colours, outline and shadow instead, and tell the user.';
    fail('TEXT_LOOKS_UNAVAILABLE', t, { message: t });
  }
  if (value === null) return null;
  const bad = (m: string): never => fail('INVALID_PROPERTY_VALUE', m, { message: m });
  if (typeof value !== 'object' || Array.isArray(value)) bad('look must be an object {style?, effect?, color?} or null');
  const v = value as RecordData, extra = Object.keys(v).filter(k => !['style', 'effect', 'color'].includes(k));
  if (extra.length) bad(`look has unknown key(s): ${extra.join(', ')}. Allowed: style, effect, color.`);
  const was = readLook(current);
  let st = was?.style ?? null, fx = was?.effect ?? null, color = was?.color ?? null;
  if (v.style !== undefined) {
    if (v.style !== null && !byId(LOOK_STYLES, v.style)) { const t = `Unknown text style '${v.style}'. Valid styles: ${ids(LOOK_STYLES)}.`; fail('UNKNOWN_TEXT_STYLE', t, { message: t }); }
    st = v.style === null ? null : structuredClone(byId(LOOK_STYLES, v.style)!);
    if (v.style === null || v.style !== was?.style?.id) color = null;
  }
  if (v.effect !== undefined) {
    if (v.effect !== null && !byId(LOOK_EFFECTS, v.effect)) { const t = `Unknown text effect '${v.effect}'. Valid effects: ${ids(LOOK_EFFECTS)}.`; fail('UNKNOWN_TEXT_EFFECT', t, { message: t }); }
    fx = v.effect === null ? null : structuredClone(byId(LOOK_EFFECTS, v.effect)!);
  }
  if (v.color !== undefined) {
    if (v.color !== null && (typeof v.color !== 'string' || !HEX.test(v.color))) bad('look.color must be a #rrggbb colour');
    if (v.color !== null && !st) bad('look.color recolours a style; this text has no style. Set look.style too, or use color for the text colour.');
    color = v.color === null ? null : (v.color as string).toLowerCase();
  }
  if (!st && !fx) return null;
  const p = st?.params as StyleParams | undefined;
  return { version: 1, style: st, effect: fx, color, outline: p && p.border[0] > 0 ? { width: p.border[0], color: p.border[1] } : null };
}
/** The stored look of an item (details.look), or null when absent or not a look. */
export function readLook(v: unknown): Look | null {
  const l = v as Look | null | undefined;
  return l && typeof l === 'object' && l.version === 1 && (l.style || l.effect) ? l : null;
}
/** §34 plain fallbacks a newly set style writes (explicit fields of the same call win; the caller applies them first).
 *  fontSize F turns the border fraction into px. Keys are storage keys: details.* for the family, else properties. */
export function lookFallbacks(look: Look, F: number): { details: RecordData; properties: RecordData } {
  const s = look.style;
  if (!s) return { details: {}, properties: {} };
  const p = s.params as StyleParams, key = look.color ?? s.keyColor ?? '#ffffff';
  return {
    details: s.font ? { fontFamily: s.font, fontFamilyDisplay: s.font } : {},
    properties: { textTransform: p.transform, letterSpacing: p.letterSpacing, color: key, borderWidth: Math.round(p.border[0] * F * 100) / 100, borderColor: p.border[1] },
  };
}
/** §34: setting an effect clears a visible box shadow (the effect draws its own). */
export const CLEARED_SHADOW = { color: 'transparent', x: 0, y: 0, blur: 0 };

/** What text/draw.ts adds for a look at font size F: outline rings (widest first, line widths in px), the shadow that
 *  replaces the item's, and echo copies. No look → nothing. */
export type LookPasses = { outlines: { width: number; color: string }[]; shadow: Shadow | null; copies: { dx: number; dy: number; alpha: number }[] };
const NONE: LookPasses = { outlines: [], shadow: null, copies: [] };
export function lookPasses(v: unknown, F: number, textColor: string): LookPasses {
  const look = PARITY.looks === 'catalogue' ? readLook(v) : null;
  if (!look) return NONE;
  const key = look.color ?? look.style?.keyColor ?? textColor;
  const sh = (s: [string, number, number, number] | null): Shadow | null => s && { color: s[0] === 'key' ? key : s[0], x: s[1] * F, y: s[2] * F, blur: s[3] * F };
  const sp = look.style?.params as StyleParams | undefined, fp = look.effect?.params as EffectParams | undefined;
  const border = sp ? sp.border[0] * F : 0;
  // A ring is drawn as a stroke of 2 × (border + ring) so it shows ring px outside the border.
  const outlines = (sp?.rings ?? []).map(([w, color]) => ({ width: 2 * (border + w * F), color })).sort((a, b) => b.width - a.width);
  return { outlines, shadow: sh(fp?.shadow ?? null) ?? sh(sp?.shadow ?? null), copies: (fp?.copies ?? []).map(([dx, dy, alpha]) => ({ dx: dx * F, dy: dy * F, alpha })) };
}
