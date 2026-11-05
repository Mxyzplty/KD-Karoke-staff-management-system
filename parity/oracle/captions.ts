// SPDX-License-Identifier: AGPL-3.0-only
// Caption render modes (findings part 5 §57): word timing, per-word state, reference-path line layout.
// τ = caption-item-local ms; word times are relative to the item start. Widths come from a caller's measure().
import { clamp } from './math';
import { graphemes } from './text';
import { captionLineHeight } from './layout';

export type Word = { text: string; startMs: number; endMs: number };
export const started = (w: Word, tau: number) => tau >= w.startMs;
export const active = (w: Word, tau: number) => tau >= w.startMs && tau < w.endMs;

// §57.1 fallbacks: duration and distance treat 0 as missing, the other keys only a missing value.
export function captionSettings(mode: string, c: Record<string, any> = {}) {
  return {
    highlightColor: c.highlightColor ?? '#FFD700', highlightScale: c.highlightScale ?? 1.05, baseOpacity: c.baseOpacity ?? .4,
    animationDurationMs: c.animationDurationMs || (mode === 'word-by-word' ? 120 : 200), slideDistance: c.slideDistance || 20,
  };
}
// §57.2 per-word state. color null = the item colour; dx / dy in project canvas px about the word centre.
export type WordState = { opacity: number; dx: number; dy: number; scale: number; color: string | null };
export function wordState(mode: string, w: Word, tau: number, s = captionSettings(mode), itemOpacity = 1): WordState {
  const st: WordState = { opacity: 1, dx: 0, dy: 0, scale: 1, color: null }, x = (tau - w.startMs) / s.animationDurationMs;
  if (mode === 'highlight' && active(w, tau)) { st.color = s.highlightColor; st.scale = s.highlightScale; }
  if (mode === 'word-by-word') st.opacity = s.baseOpacity + (1 - s.baseOpacity) * clamp(x);
  if (mode === 'slide-up' || mode === 'slide-left') { const e = 1 - (1 - clamp(x)) ** 3; st.opacity = e; st[mode === 'slide-up' ? 'dy' : 'dx'] = (1 - e) * s.slideDistance; }
  st.opacity *= itemOpacity;
  return st;
}

// §57.3 line layout (export path). lineHeight: positive number or plain numeric string, else 1.2 (layout.ts parser).
const RTL = /\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Adlam}|\p{Script=Samaritan}|\p{Script=Mandaic}/u;
export const isRtl = (text: string) => { const m = text.match(/\p{L}/u); return !!m && RTL.test(m[0]); };
// Global grapheme offset of each word in the caption text (words joined by single spaces).
export function graphemeOffsets(words: string[]) { let n = 0; return words.map(w => { const o = n; n += graphemes(w).length + 1; return o; }); }

export type CaptionBox = { fontSize: number; width: number; height: number; align?: string; lineHeight?: unknown };
export type PlacedWord = { word: number; text: string; width: number; scale: number; extra: number; left: number; top: number; centreX: number; centreY: number };
// scales[i] = render scale of word i (highlightScale on the active word); breaking uses the unscaled widths.
export function layoutCaption(words: string[], measure: (text: string) => number, box: CaptionBox, scales: number[] = []): PlacedWord[][] {
  const F = box.fontSize, gap = .2 * F, max = box.width - .8 * F, pitch = F * captionLineHeight(box.lineHeight);
  type Piece = { word: number; text: string; width: number };
  const lines: Piece[][] = []; let line: Piece[] = [], used = 0;
  words.forEach((text, word) => {
    const width = measure(text);
    if (width > max) { // longest grapheme runs that fit (≥ 1 grapheme), each on its own line; the next word starts a new line
      if (line.length) lines.push(line);
      line = []; used = 0;
      const g = graphemes(text);
      for (let a = 0; a < g.length;) { let b = a + 1; while (b < g.length && measure(g.slice(a, b + 1).join('')) <= max) b++; const run = g.slice(a, b).join(''); lines.push([{ word, text: run, width: measure(run) }]); a = b; }
      return;
    }
    if (line.length && used + gap + width > max) { lines.push(line); line = []; used = 0; }
    used += (line.length ? gap : 0) + width; line.push({ word, text, width });
  });
  if (line.length) lines.push(line);
  const top0 = (box.height - lines.length * pitch) / 2 + .2 * F, rtl = isRtl(words.join(' '));
  return lines.map((pieces, k) => {
    const order = rtl ? [...pieces].reverse() : pieces, scale = (p: Piece) => scales[p.word] ?? 1, extra = (p: Piece) => Math.max(0, p.width * (scale(p) - 1));
    const lineWidth = order.reduce((s, p) => s + p.width + extra(p), 0) + gap * (order.length - 1), top = top0 + k * pitch;
    let x = box.align === 'left' ? .4 * F : box.align === 'right' ? box.width - .4 * F - lineWidth : (box.width - lineWidth) / 2;
    return order.map(p => { const e = extra(p), left = x + e / 2; x += p.width + e + gap; return { ...p, scale: scale(p), extra: e, left, top, centreX: left + p.width / 2, centreY: top + F / 2 }; });
  });
}
