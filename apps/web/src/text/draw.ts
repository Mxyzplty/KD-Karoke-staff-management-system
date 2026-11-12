// SPDX-License-Identifier: AGPL-3.0-only
// T05 text drawing (findings part 5 §53.7.3, §56.6): one text item in its box px, on the canvas the compositor has already
// transformed to the item box. Shared by the preview canvas, frame capture and the export, so all three draw the same
// pixels. Order: background (unshadowed), then per line stroke, fill, decoration under one canvas shadow; per-grapheme
// presets draw grapheme by grapheme at the places the full final text was laid out at.
import { decorationRect, drawsText, strokeWidth, textAnchorX, textLineTop } from '../render/text-layout';
import { graphemes, scrambleChar, scrambleSeed, stepFade, typewriterCount } from './animation';
import type { TextAnimationState } from './animation';
import { lineGlyphs } from './layout';
import { requestFonts } from './fonts';
import { lookPasses } from './looks';
import { measuredLayout, measuredSize, setTextFont as setFont } from './measure';
import type { Ctx } from './measure';
import { caseTransform, textFill } from './style';
import type { TextStyle } from './style';
import type { RecordData } from '../store/model';

/** What render/model.ts hands the compositor for a text item. shadowScale: CSS px × this (preview cssScale; 1 in export). */
export type TextDraw = { item: RecordData; style: TextStyle; anim: TextAnimationState; look: unknown; shadowScale: number;
  /** T22: the text slot of an element item, in px inside the box. The text is laid out in it and centred vertically. */
  slot?: { x: number; y: number; W: number; H: number } };

/** Draws one text item into box px W × H. Returns false when nothing is drawn (empty text or a zero-sized box). */
export function drawText(ctx: Ctx, d: TextDraw, W: number, H: number): boolean {
  const s = d.style, slot = d.slot;
  if (slot) { W = slot.W; H = slot.H; }
  if (!drawsText(s.text, W, H)) return false;
  requestFonts(d.item, s.text); // preview: faces not loaded yet start loading; the export preloaded them (fonts.ts)
  const base = ctx.globalAlpha, look = lookPasses(d.look, s.F, s.color);
  ctx.save();
  if (slot) ctx.translate(slot.x, slot.y);
  let previous = '#000000';
  if (s.background !== 'transparent') { ctx.fillStyle = s.background; ctx.fillRect(0, 0, W, H); previous = s.background; }
  const layout = measuredLayout(ctx, s, W), lift = slot ? (H - measuredSize(ctx, s, W).height) / 2 : 0;
  setFont(ctx, s);
  const k = d.shadowScale, shadow = look.shadow ?? s.shadow;
  if (shadow) { ctx.shadowColor = shadow.color; ctx.shadowOffsetX = shadow.x * k; ctx.shadowOffsetY = shadow.y * k; ctx.shadowBlur = shadow.blur * k; }
  const fill = textFill(ctx, s.color, W, H) ?? previous;
  ctx.lineJoin = 'round';
  const a = d.anim, preset = a.preset, gs = preset === 'scramble' ? graphemes(s.text) : null, seed = gs ? scrambleSeed(s.text) : 0;
  const stand = gs ? caseTransform(gs.map((g, i) => scrambleChar(seed, g, i, a.c)), s.transform) : null;
  const shown = preset === 'typewriter' ? typewriterCount(a.c, a.n) : Infinity;
  const decorate = (x: number, top: number, width: number) => {
    ctx.fillStyle = fill;
    for (const kind of s.decoration) { const r = decorationRect(kind as 'underline', s.F); ctx.fillRect(x, top + r.dy, width, r.height); }
  };
  /** Stroke (look rings, then the item's own border stroke), then fill. */
  const paint = (text: string, x: number, top: number) => {
    for (const o of look.outlines) { ctx.lineWidth = o.width; ctx.strokeStyle = o.color; ctx.strokeText(text, x, top); }
    if (s.borderColor && s.borderWidth > 0) { ctx.lineWidth = strokeWidth(s.borderWidth, 'export'); ctx.strokeStyle = s.borderColor; ctx.strokeText(text, x, top); }
    ctx.fillStyle = fill; ctx.fillText(text, x, top);
  };
  /** One pass of the whole text at offset (dx, dy) and alpha × `alpha` (alpha < 1: a look's echo copy). */
  const pass = (dx: number, dy: number, alpha: number) => layout.lines.forEach((line, n) => {
    if (!line.text) return;
    const top = textLineTop(s.pitch, s.F, n) + dy + lift, anchor = textAnchorX(s.align, W) + dx;
    const x0 = s.align === 'center' ? anchor - line.width / 2 : s.align === 'right' ? anchor - line.width : anchor;
    ctx.globalAlpha = base * alpha;
    if (preset !== 'scramble' && preset !== 'step-fade') {
      // Whole lines (typewriter: the visible prefix only, stroke and decoration included).
      let end = line.end;
      if (shown !== Infinity) { const visible = lineGlyphs(layout, line).filter(g => g.glyph.index < shown), last = visible[visible.length - 1]; end = last ? last.from + last.text.length : line.start; }
      if (end <= line.start) return;
      const text = layout.text.slice(line.start, end);
      paint(text, x0, top); decorate(x0, top, end === line.end ? line.width : ctx.measureText(text).width);
      return;
    }
    const xOf = (from: number) => from === line.start ? 0 : ctx.measureText(layout.text.slice(line.start, from)).width;
    if (preset === 'scramble') {
      // Every grapheme from t = 0; a stand-in is drawn at the original glyph's x (no reflow). Decoration under the whole line.
      for (const g of lineGlyphs(layout, line)) paint(g.text === g.glyph.text ? stand![g.glyph.index] : g.text, x0 + xOf(g.from), top);
      decorate(x0, top, line.width);
      return;
    }
    // step-fade: each grapheme fades in and rises from 0.22 × the box height below its place.
    for (const g of lineGlyphs(layout, line)) {
      const f = stepFade(a.c, g.glyph.index);
      if (!(f.o > 0)) continue;
      ctx.globalAlpha = base * alpha * f.o;
      const x = x0 + xOf(g.from), y = top + f.drop * H;
      paint(g.text, x, y); decorate(x, y, ctx.measureText(g.text).width);
    }
  });
  for (const c of [...look.copies].reverse()) pass(c.dx, c.dy, c.alpha);
  pass(0, 0, 1);
  ctx.restore();
  return true;
}
