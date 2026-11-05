// SPDX-License-Identifier: AGPL-3.0-only
// Text and caption layout numbers of the export path (findings part 5 §53.7).
// Glyph shapes come from the caller's rasteriser; these are the box maths.
type Shadow = { color?: string; x?: number; y?: number; blur?: number };
export type TextStyle = { fontSize?: unknown; lineHeight?: unknown; borderWidth?: number; borderColor?: string; boxShadow?: Shadow; textAlign?: string; textDecoration?: string };

const leading = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
// A number is used as is; a string uses its first run of digits as a whole number; missing → 48.
export function fontSizePx(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const digits = typeof v === 'string' ? v.match(/\d+/) : null;
  return digits ? Number(digits[0]) : 48;
}
const visible = (s?: Shadow) => !!s && !!s.color && s.color !== 'transparent' && [s.x, s.y, s.blur].some(v => (v ?? 0) !== 0);
export function textPadding(style: TextStyle): [top: number, bottom: number] {
  const bw = style.borderWidth ?? 0, s = style.boxShadow;
  if (!visible(s)) return [bw, bw];
  const blur = s!.blur ?? 0, y = s!.y ?? 0;
  return [bw + Math.max(0, 1.5 * blur - y), bw + Math.max(0, 1.5 * blur + y)];
}
// Text items: step 2 rewrites the line height when any padding exists; step 3 turns it into px.
export function textLinePitch(style: TextStyle): number {
  const F = fontSizePx(style.fontSize), [top, bottom] = textPadding(style);
  let value = style.lineHeight ?? 'normal';
  if (top || bottom) {
    const n = leading(value);
    const base = typeof value === 'number' ? (value > 5 ? value : value * F) : value === 'normal' ? 1.2 * F
      : typeof value === 'string' && /px\s*$/.test(value) && Number.isFinite(n) ? n
      : typeof value === 'string' && /%\s*$/.test(value) && Number.isFinite(n) ? F * n / 100
      : Number.isFinite(n) ? (n > 5 ? n : n * F) : 1.2 * F;
    value = `${Math.ceil(Math.max(base, F + top + bottom))}px`;
  }
  if (value === 'normal') return 1.4 * F;
  const m = leading(value);
  return !Number.isFinite(m) ? 1.4 * F : m > 5 ? m : F * m;
}
export const textLineTop = (style: TextStyle, line: number) => (textLinePitch(style) - fontSizePx(style.fontSize)) / 2 + line * textLinePitch(style);
export const textAnchorX = (style: TextStyle, width: number) => style.textAlign === 'center' ? width / 2 : style.textAlign === 'right' ? width : 0;
// Nothing at all is drawn (not even the background) for empty text or a zero-size box.
export const textDrawsNothing = (text: string, width: number, height: number) => !text || width === 0 || height === 0;
export function decorationRect(style: TextStyle, lineTop: number): { y: number; height: number } | null {
  const F = fontSizePx(style.fontSize), d = style.textDecoration ?? '';
  const offset = d.includes('underline') ? 0.92 * F : d.includes('line-through') ? 0.5 * F : d.includes('overline') ? 0 : null;
  return offset === null ? null : { y: lineTop + offset, height: Math.max(1, F / 16) };
}
// Stroke width 2·borderWidth centred on the outline under the fill → borderWidth px shows outside.
// The DOM preview strokes borderWidth wide, so only half of it shows.
export const strokeOutsidePx = (borderWidth: number, path: 'export' | 'dom' = 'export') => path === 'export' ? borderWidth : borderWidth / 2;
// Captions (§53.7.4, §57.3): a positive number or plain numeric string is a multiplier; anything else is 1.2.
// The one caption line-height parser; captions.ts uses it too.
export function captionLineHeight(v: unknown): number {
  const m = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d*\.?\d+\s*$/.test(v) ? Number(v) : NaN;
  return m > 0 ? m : 1.2;
}
export const captionLinePitch = (style: TextStyle): number => fontSizePx(style.fontSize) * captionLineHeight(style.lineHeight);
export const captionFirstTop = (style: TextStyle, boxHeight: number, lines: number) => (boxHeight - lines * captionLinePitch(style)) / 2 + 0.2 * fontSizePx(style.fontSize);
