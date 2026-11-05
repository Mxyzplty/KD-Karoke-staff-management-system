// SPDX-License-Identifier: AGPL-3.0-only
// T05 text line layout (findings part 5 §53.7.3): hard lines on line breaks (empty lines kept), greedy fill on single
// spaces at wrap width W (no padding), the three break modes by code points, and each grapheme's place in its line. The
// measure function is the canvas's (font, letter and word spacing set); everything else is pure.
import { graphemes } from './animation';
import { caseTransform } from './style';

/** One drawn line: its string (case-transformed text), its range in that string and its measured width. */
export type Line = { text: string; start: number; end: number; width: number };
/** A grapheme as drawn: its index in the original text, its transformed string, and its offset in the transformed text. */
export type Glyph = { index: number; text: string; offset: number };
export type TextLayout = { text: string; glyphs: Glyph[]; lines: Line[] };
type Measure = (s: string) => number;

/** Breaks one hard line [start, end) of `text` into wrapped lines. */
function wrapLine(text: string, start: number, end: number, W: number, mode: 'break-all' | 'normal' | 'break-word', measure: Measure): [number, number][] {
  const out: [number, number][] = [];
  if (start === end) return [[start, end]];
  // break-all: greedy per code point over the whole line.
  if (mode === 'break-all') {
    let a = start, i = start;
    while (i < end) {
      const cp = text.codePointAt(i)!, next = i + (cp > 0xffff ? 2 : 1);
      if (i > a && measure(text.slice(a, next)) > W) { out.push([a, i]); a = i; }
      i = next;
    }
    out.push([a, end]);
    return out;
  }
  // Words on single spaces; a word moves to a new line when "line + space + word" is wider than W.
  let a = start, cur = -1; // cur = end of the current line's last word (−1: empty line so far)
  const words: [number, number][] = [];
  for (let i = start, w = start; i <= end; i++) if (i === end || text[i] === ' ') { words.push([w, i]); w = i + 1; }
  for (const [ws, we] of words) {
    if (cur >= 0 && measure(text.slice(a, we)) > W) { out.push([a, cur]); a = ws; cur = -1; }
    if (mode === 'break-word' && measure(text.slice(a, we)) > W && cur < 0) {
      // A word wider than W is broken by code points; its last piece stays open for the next word.
      let i = ws;
      while (i < we) {
        const cp = text.codePointAt(i)!, next = i + (cp > 0xffff ? 2 : 1);
        if (i > a && measure(text.slice(a, next)) > W) { out.push([a, i]); a = i; }
        i = next;
      }
    }
    cur = we;
  }
  out.push([a, cur < 0 ? end : cur]);
  return out;
}
/** Lays out `raw` (the stored text) with the case transform per grapheme, at wrap width W. */
export function layoutText(raw: string, transform: string, W: number, mode: 'break-all' | 'normal' | 'break-word', measure: Measure): TextLayout {
  const shown = caseTransform(graphemes(raw), transform), glyphs: Glyph[] = [];
  let text = '';
  shown.forEach((g, index) => { glyphs.push({ index, text: g, offset: text.length }); text += g; });
  const lines: Line[] = [];
  let s = 0;
  for (const m of text.matchAll(/\r\n|\n|\r/g)) { for (const [a, b] of wrapLine(text, s, m.index!, W, mode, measure)) lines.push({ text: text.slice(a, b), start: a, end: b, width: 0 }); s = m.index! + m[0].length; }
  for (const [a, b] of wrapLine(text, s, text.length, W, mode, measure)) lines.push({ text: text.slice(a, b), start: a, end: b, width: 0 });
  for (const l of lines) l.width = l.text ? measure(l.text) : 0;
  return { text, glyphs, lines };
}
/** The glyphs drawn on one line (a glyph split by a code-point break is cut to the line). */
export function lineGlyphs(layout: TextLayout, line: Line): { glyph: Glyph; text: string; from: number }[] {
  const out: { glyph: Glyph; text: string; from: number }[] = [];
  for (const g of layout.glyphs) {
    const a = Math.max(g.offset, line.start), b = Math.min(g.offset + g.text.length, line.end);
    if (a < b) out.push({ glyph: g, text: layout.text.slice(a, b), from: a });
  }
  return out;
}
