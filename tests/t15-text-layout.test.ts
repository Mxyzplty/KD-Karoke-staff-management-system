// SPDX-License-Identifier: AGPL-3.0-only
// T15 text and caption layout numbers (apps/web/src/render/text-layout.ts). Written-spec oracle for every test below:
// findings part 5 §53.7.6 checks (l.452-466; §53.7.2-§53.7.4 rules). Pure maths, no DOM, no oracle code (parity/oracle has no text layout).
// Mapping notes: "still drawn" / "nothing drawn" map to drawsText (emptiness only; clipping and glyph drawing are T05, not here);
// "≈ 4 px outside the glyph edge" maps to strokeWidth, which is the stroke LINE width (2 x borderWidth for export, borderWidth for
// the preview); a centred stroke puts half of it outside the glyph edge (export 4 px, preview 2 px).
import { describe, it, expect } from 'vitest';
import { captionFirstTop, captionLinePitch, decorationRect, drawsText, fontSizePx, strokeWidth, textAnchorX, textLinePitch, textLineTop, textPadding } from '../apps/web/src/render/text-layout';

const none = textPadding(0, undefined);
const lineOf = (F: number, lineHeight: unknown, pad = none) => { const L = textLinePitch(F, lineHeight, pad); return { pitch: L, top: textLineTop(L, F, 0) }; };

describe('T15 text layout (written-spec oracle: §53.7.6 checks)', () => {
  it('F 100, lineHeight normal, no stroke or shadow, box 300 x 150, centre: pitch 140, first em-box top 20, anchor x 150', () => {
    expect(none).toEqual({ top: 0, bottom: 0 });
    expect(lineOf(100, 'normal')).toEqual({ pitch: 140, top: 20 });
    expect(textAnchorX('center', 300)).toBe(150);
    expect(textAnchorX('left', 300)).toBe(0);
    expect(textAnchorX('right', 300)).toBe(300);
  });
  it('"A↵B": the second line\'s em-box top is 160, below the 150 px box, and the text is still drawn', () => {
    expect(textLineTop(140, 100, 1)).toBe(160);
    expect(160).toBeGreaterThan(150);
    expect(drawsText('A\nB', 300, 150)).toBe(true);
  });
  it('borderWidth 1: pitch = ceil(max(120, 102)) = 120 px; first top 10', () => {
    expect(textPadding(1, undefined)).toEqual({ top: 1, bottom: 1 });
    expect(lineOf(100, 'normal', textPadding(1, undefined))).toEqual({ pitch: 120, top: 10 });
  });
  it('lineHeight 1.2 -> pitch 120, top 10; lineHeight "36px" -> pitch 36, top -32', () => {
    const a = lineOf(100, 1.2);
    expect(a.pitch).toBeCloseTo(120, 9); expect(a.top).toBeCloseTo(10, 9);
    expect(lineOf(100, '36px')).toEqual({ pitch: 36, top: -32 });
  });
  it('lineHeight "150%" at F 50, no stroke -> pitch 150 px, top 50 (the percentage is read as a plain number: quirk)', () => {
    expect(lineOf(50, '150%')).toEqual({ pitch: 150, top: 50 });
  });
  it('shadow {black, x 0, y 10, blur 20}, no stroke, F 100, normal -> paddings 20 and 40, pitch ceil(max(120, 160)) = 160', () => {
    const pad = textPadding(0, { color: 'black', x: 0, y: 10, blur: 20 });
    expect(pad).toEqual({ top: 20, bottom: 40 });
    expect(textLinePitch(100, 'normal', pad)).toBe(160);
  });
  it('a transparent or zero shadow adds no padding (only the border counts)', () => {
    expect(textPadding(2, { color: 'transparent', x: 0, y: 10, blur: 20 })).toEqual({ top: 2, bottom: 2 });
    expect(textPadding(2, { color: 'black', x: 0, y: 0, blur: 0 })).toEqual({ top: 2, bottom: 2 });
  });
  it('fontSize "48.5px" -> 48 px; missing -> 48; "2em" -> 2 px; a number is used as it is', () => {
    expect(fontSizePx('48.5px')).toBe(48);
    expect(fontSizePx(undefined)).toBe(48);
    expect(fontSizePx(null)).toBe(48);
    expect(fontSizePx('2em')).toBe(2);
    expect(fontSizePx(64)).toBe(64);
  });
  it('underline at F 64: a rectangle from the line top + 58.88, 4 px high (line-through 0.5 F, overline 0)', () => {
    const u = decorationRect('underline', 64);
    expect(u.dy).toBeCloseTo(58.88, 9); expect(u.height).toBe(4);
    expect(decorationRect('line-through', 64).dy).toBe(32);
    expect(decorationRect('overline', 64).dy).toBe(0);
  });
  it('caption lineHeight "normal" -> 1.2 F; lineHeight 36 -> 36 F (quirk: never px)', () => {
    expect(captionLinePitch(50, 'normal')).toBeCloseTo(60, 9);
    expect(captionLinePitch(50, undefined)).toBeCloseTo(60, 9);
    expect(captionLinePitch(50, 36)).toBe(1800);
    expect(captionLinePitch(50, '1.5')).toBe(75);
  });
  it('caption block is centred in the box plus 0.2 F (§53.7.4)', () => {
    // 100 px box, one 60 px line, F 50: (100 - 60) / 2 + 10
    expect(captionFirstTop(100, 1, 60, 50)).toBe(30);
    expect(captionFirstTop(100, 2, 60, 50)).toBe(0); // (100 - 120) / 2 + 10
  });
  it('stroke borderWidth 4: export line width 8 (4 px outside the glyph edge), DOM preview 4 (2 px outside)', () => {
    expect(strokeWidth(4, 'export')).toBe(8);
    expect(strokeWidth(4, 'preview')).toBe(4);
    expect(strokeWidth(4, 'export') / 2).toBe(4);
    expect(strokeWidth(4, 'preview') / 2).toBe(2);
  });
  it('an empty text item (even with a red background) draws nothing; so does a zero-sized box', () => {
    expect(drawsText('', 300, 150)).toBe(false);
    expect(drawsText(undefined, 300, 150)).toBe(false);
    expect(drawsText('x', 0, 150)).toBe(false);
    expect(drawsText('x', 300, 0)).toBe(false);
    expect(drawsText('x', 300, 150)).toBe(true);
  });
});
