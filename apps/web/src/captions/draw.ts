// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption drawing (findings part 5 §57.3; golden capture G-18). One caption in its box px, on the canvas the compositor
// has already transformed to the item box — the same pixels in the preview, frame capture and the export. The caption has
// its own line layout (its own word gap and padding, the block centred in the box), distinct from a text item's: words are
// broken greedily by their base width, then each is placed and drawn with the per-word render state (captions/render.ts),
// scaled and offset about its own centre. A caption's own border is its font stroke (not a box border), like a text item's.
import { captionFirstTop, captionLinePitch, decorationRect, strokeWidth } from '../render/text-layout';
import { graphemes, scrambleChar, scrambleSeed, stepFade, typewriterCount } from '../text/animation';
import type { TextAnimationState } from '../text/animation';
import { requestFonts } from '../text/fonts';
import { setTextFont } from '../text/measure';
import type { Ctx } from '../text/measure';
import { caseTransform, textFill } from '../text/style';
import type { TextStyle } from '../text/style';
import type { RecordData } from '../store/model';
import type { StoredWord } from './model';
import { isRtl, wordState } from './render';
import type { RenderConfig, RenderMode } from './render';
import { CAPTION_PARITY } from './parity-switches';

/** What render/model.ts hands the compositor for a caption item. `wordTau`: the item-local ms the render modes compare word
 *  times against (local + trim.from, so a split remnant keeps its words' timing); `anim.c` drives the per-grapheme preset on
 *  item-local ms with trim ignored (text/animation). shadowScale: CSS px × this (preview cssScale; 1 in export). */
export type CaptionDraw = { item: RecordData; style: TextStyle; mode: RenderMode; config: RenderConfig; words: StoredWord[]; wordTau: number; anim: TextAnimationState; shadowScale: number };

type Measured = { gs: string[]; text: string; width: number };

/** Draws one caption into box px W × H. Returns false when nothing is drawn (no words or a zero-sized box). */
export function drawCaption(ctx: Ctx, d: CaptionDraw, W: number, H: number): boolean {
  const s = d.style, F = s.F;
  if (!(W > 0 && H > 0) || !d.words.length) return false;
  requestFonts(d.item, s.text); // preview: faces not loaded yet start loading; the export preloaded them (captions/agent.ts)
  const base = ctx.globalAlpha;
  ctx.save();
  // A caption background colour fills the box (mirrors a text item; the pill-vs-box band shape is an open question, notes Q6).
  if (s.background !== 'transparent') { ctx.fillStyle = s.background; ctx.fillRect(0, 0, W, H); }
  setTextFont(ctx, s);
  const k = d.shadowScale, sh = s.shadow;
  if (sh) { ctx.shadowColor = sh.color; ctx.shadowOffsetX = sh.x * k; ctx.shadowOffsetY = sh.y * k; ctx.shadowBlur = sh.blur * k; }
  const fill = textFill(ctx, s.color, W, H) ?? s.color; // the caption colour (gradient is a Cutframe improvement, text/style)
  ctx.lineJoin = 'round';

  // Each word's display graphemes (the case transform), string and base width, measured with the caption's font and spacing.
  type Piece = Measured & { word: number; g0: number };
  const measured = (gs: string[]): Measured => { const text = gs.join(''); return { gs, text, width: ctx.measureText(text).width }; };
  // §57.3 greedy line break: a fixed word gap of 0.2·F, side padding 0.4·F each side, so the break budget is W − 0.8·F; a
  // word wider than the budget is cut into longest fitting grapheme runs, each on its own line. Breaking uses base widths.
  const gap = 0.2 * F, budget = W - 0.8 * F;
  const lines: Piece[][] = [];
  let cur: Piece[] = [], curW = 0, g0 = 0;
  d.words.forEach((w, word) => {
    const gs = caseTransform(graphemes(w.text), s.transform), wd = measured(gs);
    if (wd.width > budget) {
      if (cur.length) { lines.push(cur); cur = []; curW = 0; }
      for (let a = 0; a < gs.length;) {
        let b = a + 1;
        while (b < gs.length && measured(gs.slice(a, b + 1)).width <= budget) b++;
        lines.push([{ ...measured(gs.slice(a, b)), word, g0: g0 + a }]); a = b;
      }
      g0 += gs.length + 1; return;
    }
    if (cur.length && curW + gap + wd.width > budget) { lines.push(cur); cur = []; curW = 0; }
    curW += (cur.length ? gap : 0) + wd.width; cur.push({ ...wd, word, g0 }); g0 += gs.length + 1;
  });
  if (cur.length) lines.push(cur);

  const pitch = captionLinePitch(F, s.lineHeight), top0 = captionFirstTop(H, lines.length, pitch, F);
  const preset = d.anim.preset, shown = preset === 'typewriter' ? typewriterCount(d.anim.c, d.anim.n) : Infinity, seed = preset === 'scramble' ? scrambleSeed(s.text) : 0;

  /** Stroke (the caption's font border, export width 2×) then fill, at box px (x, top), textBaseline top. */
  const paint = (text: string, x: number, top: number, style: string | CanvasGradient) => {
    if (s.borderColor && s.borderWidth > 0) { ctx.lineWidth = strokeWidth(s.borderWidth, 'export'); ctx.strokeStyle = s.borderColor; ctx.strokeText(text, x, top); }
    ctx.fillStyle = style; ctx.fillText(text, x, top);
    if (CAPTION_PARITY.decorations !== 'xapp') for (const kind of s.decoration) {
      const r = decorationRect(kind as 'underline', F); ctx.fillRect(x, top + r.dy, ctx.measureText(text).width, r.height);
    }
  };
  /** One word's graphemes at local box px (x0 = its left, top = its line top): the whole word (no preset / typewriter past
   *  its end), the visible typewriter prefix, or a per-grapheme scramble / step-fade at the original graphemes' places. */
  const drawWord = (wd: Measured, x0: number, top: number, style: string | CanvasGradient, gBase: number) => {
    const xOf = (m: number) => m === 0 ? 0 : ctx.measureText(wd.gs.slice(0, m).join('')).width;
    if (preset === 'typewriter') { const v = Math.max(0, Math.min(wd.gs.length, shown - gBase)); if (v > 0) paint(wd.gs.slice(0, v).join(''), x0, top, style); return; }
    if (preset === 'scramble') { wd.gs.forEach((g, m) => paint(scrambleChar(seed, g, gBase + m, d.anim.c), x0 + xOf(m), top, style)); return; }
    if (preset === 'step-fade') {
      const a0 = ctx.globalAlpha;
      wd.gs.forEach((g, m) => { const f = stepFade(d.anim.c, gBase + m); if (!(f.o > 0)) return; ctx.globalAlpha = a0 * f.o; paint(g, x0 + xOf(m), top + f.drop * H, style); });
      ctx.globalAlpha = a0; return;
    }
    paint(wd.text, x0, top, style);
  };

  const rtl = isRtl(d.words.map(w => w.text).join(' '));
  // Text items default to left alignment; captions default to centre unless the item explicitly stores textAlign.
  const align = d.item.properties?.textAlign ? s.align : 'center';
  lines.forEach((pieces, li) => {
    const line = rtl ? [...pieces].reverse() : pieces;
    const lineTop = top0 + li * pitch;
    const states = line.map(p => wordState(d.mode, d.config, d.words[p.word], d.wordTau));
    const extra = line.map((p, n) => p.width * Math.max(0, states[n].scale - 1)); // a scaled word reserves width so the line re-centres
    const lineWidth = line.reduce((a, p, n) => a + p.width + extra[n], 0) + gap * Math.max(0, line.length - 1);
    let x = align === 'left' ? 0.4 * F : align === 'right' ? W - 0.4 * F - lineWidth : (W - lineWidth) / 2;
    line.forEach((wd, n) => {
      const st = states[n], drawLeft = x + extra[n] / 2;
      if (st.alpha > 0) {
        ctx.save();
        ctx.globalAlpha = base * st.alpha;
        ctx.translate(drawLeft + wd.width / 2 + st.dx, lineTop + F / 2 + st.dy); // offsets and scale about the word centre
        if (st.scale !== 1) ctx.scale(st.scale, st.scale);
        drawWord(wd, -wd.width / 2, -F / 2, st.color ?? fill, wd.g0);
        ctx.restore();
      }
      x += wd.width + extra[n] + gap;
    });
  });
  ctx.restore();
  return true;
}
