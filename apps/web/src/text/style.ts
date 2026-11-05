// SPDX-License-Identifier: AGPL-3.0-only
// T05 text style as the renderer reads it (findings part 5 §53.7.2–§53.7.3): style fields raw from the stored item (the
// property's stored value, else details; no registry fill), the font string with its family chain, the case transform per
// grapheme, and CSS gradient text colours (a Cutframe improvement: Xapp draws none, PARITY.gradientText). Pure: no DOM.
import type { RecordData } from '../store/model';
import { fontSizePx, rawStyle, textPadding, textLinePitch } from '../render/text-layout';
import { prop, valueAt } from '../timeline/properties';
import { PARITY } from './parity-switches';

/** §53.1.1 a box or paint field (render/model.ts `field`, repeated here so render/model can import this module). */
function field(item: RecordData, key: string, local: number, fallback?: unknown): any {
  const v = prop(item, key) ? valueAt(item, key, local) : undefined;
  return v ?? item.details?.[key] ?? fallback ?? valueAt(item, key, local);
}

export type Shadow = { color: string; x: number; y: number; blur: number };
/** Everything the text drawer needs, at one item-local time. */
export type TextStyle = {
  text: string; F: number; weight: string; style: string; families: string; font: string;
  color: string; background: string; align: string; transform: string; decoration: string[];
  letterSpacing: string; wordSpacing: string; wrap: 'break-all' | 'normal' | 'break-word'; lineHeight: unknown; pitch: number;
  borderWidth: number; borderColor: string | null; shadow: Shadow | null;
};
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
/** §53.7.2 family list: split on commas; each name single-quoted unless already quoted or a generic keyword. */
export function quoteFamilies(list: string): string {
  return list.split(',').map(s => s.trim()).filter(Boolean).map(s => /^['"].*['"]$/.test(s) || GENERIC.has(s.toLowerCase()) ? s : `'${s.replace(/'/g, "\\'")}'`).join(', ');
}
/** The fallbacks after the family (PARITY.fontChain): bundled emoji then the on-demand CJK font, or Xapp's chain. */
export const CJK_FAMILY = 'Noto Sans SC';
export const EMOJI_FAMILY = 'Noto Color Emoji';
export const chainTail = () => PARITY.fontChain === 'bundled' ? `'${EMOJI_FAMILY}', '${CJK_FAMILY}', sans-serif` : `'${EMOJI_FAMILY}', sans-serif`;
export const fontString = (style: string, weight: string, F: number, families: string) => `${style} ${weight} ${F}px ${families ? `${families}, ` : ''}${chainTail()}`;
/** The CSS family the item draws with: the display family when PARITY.weightFace switches faces (text/fonts.ts registers the
 *  family's faces under it), else the stored face name (Xapp registers the stored face file under it). */
export function itemFamily(item: RecordData): string {
  const d = item.details ?? {}, face = typeof d.fontFamily === 'string' ? d.fontFamily.trim() : '', display = typeof d.fontFamilyDisplay === 'string' ? d.fontFamilyDisplay.trim() : '';
  return PARITY.weightFace === 'switch' && display ? display : face || display;
}
const str = (v: unknown, d: string) => v === undefined || v === null || v === '' ? d : String(v);
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** §53.7.2 / §53.7.3: the style at item-local ms. kind 'caption' changes only the weight default (700). */
export function textStyle(item: RecordData, local: number, kind: 'text' | 'caption' = 'text'): TextStyle {
  const raw = (k: string) => rawStyle(item, k, local), F = fontSizePx(raw('fontSize'));
  const weight = str(raw('fontWeight'), kind === 'caption' ? '700' : 'normal'), style = str(raw('fontStyle'), 'normal');
  const family = itemFamily(item), families = family ? quoteFamilies(family) : '';
  // Paint fields go through the registry fill (§53.1.1); the background colour only from the stored property.
  const bw = num(field(item, 'borderWidth', local, 0)), bc = field(item, 'borderColor', local, null), sh = field(item, 'boxShadow', local, null);
  const shadow = sh && typeof sh === 'object' && sh.color && sh.color !== 'transparent' ? { color: String(sh.color), x: num(sh.x), y: num(sh.y), blur: num(sh.blur) } : null;
  const wordBreak = raw('wordBreak'), wordWrap = raw('wordWrap'), lineHeight = raw('lineHeight');
  const decoration = String(raw('textDecoration') ?? '').split(/\s+/).filter(d => d === 'underline' || d === 'line-through' || d === 'overline');
  return {
    text: typeof item.details?.text === 'string' ? item.details.text : '', F, weight, style, families, font: fontString(style, weight, F, families),
    color: str(raw('color'), '#ffffff'), background: str(item.properties?.backgroundColor !== undefined ? rawStyle(item, 'backgroundColor', local) : undefined, 'transparent'),
    align: str(raw('textAlign'), 'left'), transform: str(raw('textTransform'), 'none'), decoration,
    letterSpacing: str(raw('letterSpacing'), 'normal'), wordSpacing: str(raw('wordSpacing'), 'normal'),
    wrap: wordBreak === 'break-all' ? 'break-all' : wordWrap === 'normal' ? 'normal' : 'break-word', lineHeight,
    pitch: textLinePitch(F, lineHeight, textPadding(bw, sh)), borderWidth: bw, borderColor: bw > 0 && bc && bc !== 'transparent' ? String(bc) : null, shadow,
  };
}
/** §53.7.3 canvas letter / word spacing: the stored string, "normal" → 0px; a bare number is px. */
export const canvasSpacing = (v: string) => v === 'normal' || v === '' ? '0px' : /^-?[\d.]+$/.test(v) ? `${v}px` : v;

// ---- §53.7.3 case transform per grapheme (locale rules); capitalize = upper after any grapheme that is not a letter or digit.
const WORD_CHAR = /[\p{L}\p{N}]/u;
export function caseTransform(gs: string[], transform: string): string[] {
  if (transform === 'uppercase') return gs.map(g => g.toLocaleUpperCase());
  if (transform === 'lowercase') return gs.map(g => g.toLocaleLowerCase());
  if (transform !== 'capitalize') return gs;
  return gs.map((g, i) => i === 0 || !WORD_CHAR.test(gs[i - 1]) ? g.toLocaleUpperCase() : g);
}

// ---- Gradient text colour (part 3 §46.7: linear-gradient(…) or radial-gradient(circle, …), stops with % positions).
export type GradientStop = { color: string; at: number };
export type Gradient = { kind: 'linear'; angle: number; stops: GradientStop[] } | { kind: 'radial'; cx: number; cy: number; stops: GradientStop[] };
/** Splits on commas outside parentheses. */
const topLevel = (s: string) => { const out: string[] = []; let depth = 0, cur = ''; for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
const POSITION: Record<string, number> = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
export function parseGradient(v: unknown): Gradient | null {
  const m = typeof v === 'string' ? /^\s*(linear|radial)-gradient\((.*)\)\s*$/i.exec(v) : null;
  if (!m) return null;
  const parts = topLevel(m[2]);
  let angle = 180, cx = 50, cy = 50;
  if (m[1].toLowerCase() === 'linear' && /^-?[\d.]+deg$/.test(parts[0] ?? '')) angle = parseFloat(parts.shift()!);
  else if (m[1].toLowerCase() === 'linear' && /^to /.test(parts[0] ?? '')) {
    const to = parts.shift()!.slice(3).trim();
    angle = ({ top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135, 'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 } as Record<string, number>)[to] ?? 180;
  } else if (m[1].toLowerCase() === 'radial' && /^(circle|ellipse)\b|^at /.test(parts[0] ?? '')) {
    const at = /at\s+(\S+)(?:\s+(\S+))?/.exec(parts.shift()!);
    const pos = (s: string | undefined, d: number) => s === undefined ? d : s.endsWith('%') ? parseFloat(s) : POSITION[s] ?? d;
    // One keyword: top / bottom name the y axis ("at top" = 50 % 0 %), any other the x axis.
    if (at && at[2] === undefined && (at[1] === 'top' || at[1] === 'bottom')) cy = pos(at[1], 50);
    else if (at) { cx = pos(at[1], 50); cy = pos(at[2], 50); }
  }
  const stops = parts.map((p, i, all) => {
    const s = /^(.*?)\s+(-?[\d.]+)%$/.exec(p);
    return { color: s ? s[1].trim() : p, at: s ? parseFloat(s[2]) / 100 : all.length > 1 ? i / (all.length - 1) : 0 };
  });
  if (stops.length < 1) return null;
  return m[1].toLowerCase() === 'linear' ? { kind: 'linear', angle, stops } : { kind: 'radial', cx, cy, stops };
}
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** The canvas fill for a text colour over the W × H box: a gradient (CSS geometry: the linear gradient line spans the box
 *  at the angle; the radial circle reaches the farthest corner), else the colour string. 'xapp' keeps the previous fill. */
export function textFill(ctx: Ctx, color: string, W: number, H: number): string | CanvasGradient | null {
  const g = parseGradient(color);
  if (!g) return color;
  if (PARITY.gradientText === 'xapp') return null;
  let out: CanvasGradient;
  if (g.kind === 'linear') {
    const a = g.angle * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a), L = Math.abs(W * dx) + Math.abs(H * dy);
    out = ctx.createLinearGradient(W / 2 - dx * L / 2, H / 2 - dy * L / 2, W / 2 + dx * L / 2, H / 2 + dy * L / 2);
  } else {
    const x = W * g.cx / 100, y = H * g.cy / 100, r = Math.max(Math.hypot(x, y), Math.hypot(W - x, y), Math.hypot(x, H - y), Math.hypot(W - x, H - y));
    out = ctx.createRadialGradient(x, y, 0, x, y, Math.max(r, 1e-6));
  }
  for (const s of g.stops) { try { out.addColorStop(Math.min(1, Math.max(0, s.at)), s.color); } catch { /* an unparsable stop colour is skipped */ } }
  return out;
}
