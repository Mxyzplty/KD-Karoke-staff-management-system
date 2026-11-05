// SPDX-License-Identifier: AGPL-3.0-only
// Text and caption layout numbers of the shared render model (findings part 5 §53.7.2–§53.7.4). Pure: no DOM. Drawing
// glyphs is T05 (text) and T09 (captions); both read their layout from here so preview and export cannot drift.
import type { RecordData } from '../store/model';
import { prop, valueAt } from '../timeline/properties';

/** §53.7.2: text style fields are read raw (the property's stored value, else details); no registry fill. */
export const rawStyle = (item: RecordData, key: string, local: number): any => prop(item, key) ? valueAt(item, key, local) : item.details?.[key];
/** §53.7.2 size F: a number as is; a string's first run of digits as a whole number; missing → 48. */
export function fontSizePx(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const digits = typeof value === 'string' ? /\d+/.exec(value) : null;
  return digits ? Number(digits[0]) : 48;
}
type Shadow = { color?: string; x?: number; y?: number; blur?: number } | null | undefined;
/** §53.7.3 line pitch step 1: (top, bottom) padding from the border and a visible shadow. */
export function textPadding(borderWidth: number, shadow: Shadow): { top: number; bottom: number } {
  const bw = Number(borderWidth) || 0, x = Number(shadow?.x) || 0, y = Number(shadow?.y) || 0, blur = Number(shadow?.blur) || 0;
  const visible = !!shadow && shadow.color !== 'transparent' && (x !== 0 || y !== 0 || blur !== 0);
  return visible ? { top: bw + Math.max(0, 1.5 * blur - y), bottom: bw + Math.max(0, 1.5 * blur + y) } : { top: bw, bottom: bw };
}
const leading = (v: string) => { const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)/.exec(v); return m ? Number(m[0]) : NaN; };
/** Step 2's base: a number (> 5 px, else × F), "normal" 1.2·F, "N px", "N %" (of F), another numeric string as a number. */
function base(lineHeight: unknown, F: number): number {
  if (typeof lineHeight === 'number' && Number.isFinite(lineHeight)) return lineHeight > 5 ? lineHeight : lineHeight * F;
  if (typeof lineHeight !== 'string' || lineHeight.trim() === 'normal') return 1.2 * F;
  const s = lineHeight.trim(), n = leading(s);
  if (!Number.isFinite(n)) return 1.2 * F;
  if (s.endsWith('px')) return n;
  if (s.endsWith('%')) return F * n / 100;
  return n > 5 ? n : n * F;
}
/** §53.7.3 text line pitch L (export rule): the padding rewrite of step 2, then L = F × m (step 3). */
export function textLinePitch(F: number, lineHeight: unknown, padding: { top: number; bottom: number }): number {
  const value = padding.top === 0 && padding.bottom === 0 ? lineHeight ?? 'normal' : `${Math.ceil(Math.max(base(lineHeight, F), F + padding.top + padding.bottom))}px`;
  if (value === 'normal' || value == null) return 1.4 * F;
  const n = typeof value === 'number' ? value : leading(String(value));
  if (!Number.isFinite(n)) return 1.4 * F;
  return n > 5 ? n : F * n;
}
/** Line k's em-box top (no vertical centring for text items; nothing clipped). */
export const textLineTop = (L: number, F: number, k: number) => (L - F) / 2 + k * L;
/** Horizontal anchor: left 0, center W / 2, right W (no side padding). */
export const textAnchorX = (align: unknown, W: number) => align === 'center' ? W / 2 : align === 'right' ? W : 0;
/** Export stroke width = 2 × borderWidth (≈ borderWidth outside the glyph); the DOM preview's CSS stroke = borderWidth. */
export const strokeWidth = (borderWidth: number, target: 'export' | 'preview') => target === 'export' ? 2 * borderWidth : borderWidth;
/** Decoration rectangle top offset from the line top and its height (underline 0.92·F, line-through 0.5·F, overline 0). */
export function decorationRect(kind: 'underline' | 'line-through' | 'overline', F: number): { dy: number; height: number } {
  return { dy: kind === 'underline' ? 0.92 * F : kind === 'line-through' ? 0.5 * F : 0, height: Math.max(1, F / 16) };
}
/** Nothing is drawn (not even the background) for empty text or a zero-sized box. */
export const drawsText = (text: unknown, W: number, H: number) => typeof text === 'string' && text.length > 0 && W > 0 && H > 0;

/** §53.7.4 caption line pitch = F × lineHeight (a positive number or plain numeric string; else 1.2; never px). */
export function captionLinePitch(F: number, lineHeight: unknown): number {
  const n = typeof lineHeight === 'number' ? lineHeight : typeof lineHeight === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(lineHeight) ? Number(lineHeight) : NaN;
  return F * (Number.isFinite(n) && n > 0 ? n : 1.2);
}
/** First caption line top: the block is centred in the box, plus 0.2·F. */
export const captionFirstTop = (H: number, lines: number, pitch: number, F: number) => (H - lines * pitch) / 2 + 0.2 * F;
