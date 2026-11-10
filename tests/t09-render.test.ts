// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption render modes (findings part 5 §57.1–§57.3). Oracle: the §57.2 "Test values" and the §57.3 worked example, with the
// arithmetic written out in each test (outCubic and the linear ramp recomputed here, never read from render.ts).
// Pure state and recording-canvas layout; decoded pipeline frames are covered by ui/t09-export.spec.ts.
import { describe, expect, it } from 'vitest';
import { drawCaption } from '../apps/web/src/captions/draw';
import type { CaptionDraw } from '../apps/web/src/captions/draw';
import { modeOf, renderConfig, RENDER_MODES, wordState } from '../apps/web/src/captions/render';
import type { RenderMode } from '../apps/web/src/captions/render';
import { animationState } from '../apps/web/src/text/animation';

const cfg = (details: Record<string, unknown> = {}) => renderConfig({ details: { renderConfig: details } } as never);
const WORD = { startMs: 500, endMs: 900 };
const state = (mode: RenderMode, tau: number, c = cfg()) => wordState(mode, c, WORD, tau);
// The oracle's own curves (§57.2): outCubic and the linear word-by-word ramp.
const outCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

describe('T09 §57.1 settings and fallbacks', () => {
  it('fallbacks: #FFD700, 1.05, 0.4, 120 ms word-by-word, 200 ms slide, 20 px', () => {
    expect(cfg()).toMatchObject({ highlightColor: '#FFD700', highlightScale: 1.05, baseOpacity: 0.4, durWordByWord: 120, durSlide: 200, slideDistance: 20 });
  });
  it('animationDurationMs and slideDistance: 0 or missing means the fallback', () => {
    expect(cfg({ animationDurationMs: 0, slideDistance: 0 })).toMatchObject({ durWordByWord: 120, durSlide: 200, slideDistance: 20 });
    expect(cfg({ animationDurationMs: 50, slideDistance: 10 })).toMatchObject({ durWordByWord: 50, durSlide: 50, slideDistance: 10 });
  });
  it('for the other keys only a MISSING value means the fallback: baseOpacity 0 and highlightScale 1 are kept', () => {
    expect(cfg({ baseOpacity: 0, highlightScale: 1 })).toMatchObject({ baseOpacity: 0, highlightScale: 1 });
    expect(state('word-by-word', 0, cfg({ baseOpacity: 0 })).alpha).toBe(0);
  });
  it('template values (§57.1): Karaoke Pop #FFE600 / 1.08; Editorial 50 ms / 20 px; Handwritten 100 ms / 10 px', () => {
    expect(cfg({ highlightColor: '#FFE600', highlightScale: 1.08 })).toMatchObject({ highlightColor: '#FFE600', highlightScale: 1.08 });
    expect(cfg({ animationDurationMs: 50, slideDistance: 20 })).toMatchObject({ durSlide: 50, slideDistance: 20 });
    expect(cfg({ animationDurationMs: 100, slideDistance: 10 })).toMatchObject({ durSlide: 100, slideDistance: 10 });
  });
  it('there are exactly five modes; an unknown stored mode draws as default', () => {
    expect([...RENDER_MODES]).toEqual(['default', 'highlight', 'word-by-word', 'slide-up', 'slide-left']);
    expect(modeOf({ details: { renderMode: 'zoom' } } as never)).toBe('default');
    expect(modeOf({ details: { renderMode: 'slide-left' } } as never)).toBe('slide-left');
    expect(modeOf({ details: {} } as never)).toBe('default');
  });
});

describe('T09 §57.2 per-word state, word [500, 900) ms, defaults', () => {
  it('default: opacity 1, scale 1, no offset at any time', () => {
    for (const tau of [0, 499, 500, 899, 900, 5000]) expect(state('default', tau)).toEqual({ alpha: 1, scale: 1, dx: 0, dy: 0, color: null });
  });

  it('word-by-word: 0.4 at 499 · 0.55 at 530 · 0.70 at 560 · 1.0 from 620 · still 1.0 after the end (linear 120 ms)', () => {
    expect(state('word-by-word', 499).alpha).toBe(0.4);
    expect(state('word-by-word', 500).alpha).toBeCloseTo(0.4, 12);
    expect(state('word-by-word', 530).alpha).toBeCloseTo(0.4 + 0.6 * (30 / 120), 12);     // 0.55
    expect(state('word-by-word', 530).alpha).toBeCloseTo(0.55, 12);
    expect(state('word-by-word', 560).alpha).toBeCloseTo(0.7, 12);
    expect(state('word-by-word', 620).alpha).toBe(1);
    expect(state('word-by-word', 900).alpha).toBe(1);
    expect(state('word-by-word', 5000).alpha).toBe(1);
    const s = state('word-by-word', 530);
    expect([s.scale, s.dx, s.dy, s.color]).toEqual([1, 0, 0, null]);
  });

  it('slide-up: τ500 o0 dy20 · τ530 o0.3859 dy12.28 · τ560 o0.6570 dy6.86 · τ620 o0.9360 dy1.28 · τ≥700 at rest', () => {
    const at = (tau: number) => state('slide-up', tau);
    expect(at(499)).toMatchObject({ alpha: 0, dy: 20, dx: 0 });                             // before start: invisible, full distance below
    expect(at(500).alpha).toBeCloseTo(0, 12); expect(at(500).dy).toBeCloseTo(20, 12);
    expect(at(530).alpha).toBeCloseTo(0.385875, 6); expect(at(530).dy).toBeCloseTo(12.2825, 4);
    expect(at(560).alpha).toBeCloseTo(0.657, 6); expect(at(560).dy).toBeCloseTo(6.86, 4);
    expect(at(620).alpha).toBeCloseTo(0.936, 6); expect(at(620).dy).toBeCloseTo(1.28, 4);
    for (const tau of [700, 900, 5000]) expect(at(tau)).toMatchObject({ alpha: 1, dy: 0, dx: 0, scale: 1 });   // a word never goes back after its end
    for (const tau of [510, 540, 600, 650]) { const e = outCubic((tau - 500) / 200); expect(at(tau).alpha).toBeCloseTo(e, 9); expect(at(tau).dy).toBeCloseTo((1 - e) * 20, 9); }
  });

  it('slide-left: the same curve in x; it starts 20 px to the RIGHT (positive dx) and moves left', () => {
    expect(state('slide-left', 499)).toMatchObject({ alpha: 0, dx: 20, dy: 0 });
    for (const tau of [500, 530, 560, 620, 700]) {
      const e = outCubic((tau - 500) / 200), s = state('slide-left', tau);
      expect(s.alpha).toBeCloseTo(e, 9); expect(s.dx).toBeCloseTo((1 - e) * 20, 9); expect(s.dy).toBe(0);
    }
    expect(state('slide-left', 530).dx).toBeGreaterThan(0);
  });

  it('slide modes use the configured duration and distance (Editorial 50 ms / 20 px; Handwritten 100 ms / 10 px)', () => {
    const ed = state('slide-up', 525, cfg({ animationDurationMs: 50, slideDistance: 20 }));
    expect(ed.alpha).toBeCloseTo(outCubic(0.5), 9); expect(ed.dy).toBeCloseTo((1 - outCubic(0.5)) * 20, 9);
    const hw = state('slide-up', 550, cfg({ animationDurationMs: 100, slideDistance: 10 }));
    expect(hw.alpha).toBeCloseTo(outCubic(0.5), 9); expect(hw.dy).toBeCloseTo((1 - outCubic(0.5)) * 10, 9);
  });

  it('highlight: τ499 item colour · τ500–899 #FFD700 at 1.05× · τ900 item colour again (half-open end), instant (no easing)', () => {
    expect(state('highlight', 499)).toEqual({ alpha: 1, scale: 1, dx: 0, dy: 0, color: null });
    for (const tau of [500, 501, 700, 899]) expect(state('highlight', tau)).toEqual({ alpha: 1, scale: 1.05, dx: 0, dy: 0, color: '#FFD700' });
    for (const tau of [900, 901, 5000]) expect(state('highlight', tau)).toEqual({ alpha: 1, scale: 1, dx: 0, dy: 0, color: null });
  });

  it('highlight with the Karaoke Pop values', () => {
    expect(state('highlight', 600, cfg({ highlightColor: '#FFE600', highlightScale: 1.08 }))).toMatchObject({ color: '#FFE600', scale: 1.08 });
  });
});

// ---- §57.3 line layout through a recording fake canvas. measureText returns a width from the word table.
type Call = { text: string; tx: number; ty: number; scale: number; alpha: number; kind: 'fill' | 'stroke'; lineWidth: number };
function fake(widths: Record<string, number>) {
  const calls: Call[] = [];
  type T = { tx: number; ty: number; s: number; a: number };
  let cur: T = { tx: 0, ty: 0, s: 1, a: 1 }; const stack: T[] = [];
  const ctx: Record<string, unknown> = {
    globalAlpha: 1, lineWidth: 1, fillStyle: '', strokeStyle: '', font: '', shadowColor: '', shadowOffsetX: 0, shadowOffsetY: 0, shadowBlur: 0,
    save() { stack.push({ ...cur }); (this as { _a: number[] })._a ??= []; (this as { _a: number[] })._a.push(this.globalAlpha as number); },
    restore() { cur = stack.pop() ?? cur; const a = (this as { _a: number[] })._a; if (a?.length) this.globalAlpha = a.pop(); },
    translate(x: number, y: number) { cur = { ...cur, tx: cur.tx + x * cur.s, ty: cur.ty + y * cur.s }; },
    scale(x: number) { cur = { ...cur, s: cur.s * x }; },
    measureText(t: string) { return { width: widths[t] ?? 10 * t.length }; },
    fillRect() {},
    fillText(t: string, x: number, y: number) { calls.push({ text: t, tx: cur.tx + x * cur.s, ty: cur.ty + y * cur.s, scale: cur.s, alpha: this.globalAlpha as number, kind: 'fill', lineWidth: this.lineWidth as number }); },
    strokeText(t: string, x: number, y: number) { calls.push({ text: t, tx: cur.tx + x * cur.s, ty: cur.ty + y * cur.s, scale: cur.s, alpha: this.globalAlpha as number, kind: 'stroke', lineWidth: this.lineWidth as number }); },
  };
  return { ctx, calls };
}
const style = (F: number, extra: Record<string, unknown> = {}) => ({ F, font: `700 ${F}px Roboto`, letterSpacing: 'normal', wordSpacing: 'normal', background: 'transparent', shadow: null, color: '#FFFFFF',
  borderWidth: 0, borderColor: '#000000', lineHeight: undefined, transform: 'none', decoration: [], text: 'AAA BBB CCC', ...extra });
function draw(words: string[], widths: Record<string, number>, o: { mode?: RenderMode; tau?: number; W?: number; H?: number; F?: number; style?: Record<string, unknown>; align?: string } = {}) {
  const f = fake(widths), F = o.F ?? 60;
  let at = 0;
  const stored = words.map(text => { const w = { text, startMs: at, endMs: at + 400, sourceStartMs: at, sourceEndMs: at + 400 }; at += 400; return w; });
  const d = { item: { id: 'c', type: 'caption', details: {}, properties: o.align ? { textAlign: { defaultValue: o.align } } : {} }, style: style(F, { ...o.style, ...(o.align ? { align: o.align } : {}) }), mode: o.mode ?? 'default', config: cfg(), words: stored, wordTau: o.tau ?? 0,
    anim: animationState(null, 0, words.join(' ')), shadowScale: 1 } as unknown as CaptionDraw;
  const ok = drawCaption(f.ctx as never, d, o.W ?? 1000, o.H ?? 200);
  return { ok, calls: f.calls.filter(c => c.kind === 'fill'), all: f.calls, F };
}
const W3 = { AAA: 200, BBB: 300, CCC: 200 };

describe('T09 §57.3 line layout (reference path)', () => {
  it('three words 200 / 300 / 200, F 60 (gap 12), centred in 1000: line width 724, starting at x = 138', () => {
    const { ok, calls } = draw(['AAA', 'BBB', 'CCC'], W3);
    expect(ok).toBe(true);
    expect(calls.map(c => c.text)).toEqual(['AAA', 'BBB', 'CCC']);
    // Each word is drawn at x0 = −width/2 about its translated centre, so the absolute left edge (scale 1) is tx; the vertical y is the line top.
    expect(calls.map(c => c.tx)).toEqual([138, 138 + 200 + 12, 138 + 200 + 12 + 300 + 12]);
  });

  it('first line top = (H − lines × pitch) / 2 + 0.2 F with pitch = F × 1.2 (H 200, F 60 → 76); one line only', () => {
    const { calls } = draw(['AAA', 'BBB', 'CCC'], W3);
    expect(new Set(calls.map(c => c.ty))).toEqual(new Set([76]));
  });

  it('the worked example: the middle word active at highlight 1.05 → extra 15, line width 739; word 1 starts 7.5 px further left, word 3 7.5 px further right', () => {
    const plain = draw(['AAA', 'BBB', 'CCC'], W3).calls, hi = draw(['AAA', 'BBB', 'CCC'], W3, { mode: 'highlight', tau: 600 }).calls;   // τ 600 ∈ BBB [400, 800)
    expect(hi.map(c => c.text)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(hi[0].tx - plain[0].tx).toBeCloseTo(-7.5, 9);
    expect(hi[2].tx - plain[2].tx).toBeCloseTo(7.5, 9);
    expect(hi[1].scale).toBeCloseTo(1.05, 12);
    // the scaled middle word keeps its centre where the line puts it: slot centre = 130.5 + 200 + 12 + 7.5 + 150
    expect(hi[1].tx + (300 / 2) * 1.05).toBeCloseTo(130.5 + 200 + 12 + 7.5 + 150, 9);          // fillText x = −width/2 scaled about the centre
  });

  it('scales at or below 1 reserve no extra width (word-by-word and slide modes leave the line where default puts it)', () => {
    const plain = draw(['AAA', 'BBB', 'CCC'], W3).calls;
    for (const mode of ['word-by-word', 'default'] as RenderMode[]) expect(draw(['AAA', 'BBB', 'CCC'], W3, { mode, tau: 600 }).calls.map(c => c.tx)).toEqual(plain.map(c => c.tx));
  });

  it('greedy break within W − 0.8 F: a fourth 200 px word does not fit 400 + gap and starts line 2; both lines centred, pitch F × 1.2', () => {
    // W 500, F 60 → budget 452. AAA(200)+12+BBB(300) = 512 > 452 → BBB goes to line 2.
    const { calls } = draw(['AAA', 'BBB'], W3, { W: 500 });
    expect(calls.map(c => c.ty)).toEqual([(200 - 2 * 72) / 2 + 12, (200 - 2 * 72) / 2 + 12 + 72]);
    expect(calls.map(c => c.tx)).toEqual([(500 - 200) / 2, (500 - 300) / 2]);
  });

  it('an over-long word is cut into longest fitting grapheme runs, each on its own line; the next word starts a fresh line', () => {
    const { calls } = draw(['AAA', 'abcdefghij', 'CCC'], { AAA: 20, CCC: 20 }, { W: 60, F: 10 }); // budget 52; each grapheme 10
    expect(calls.map(c => c.text)).toEqual(['AAA', 'abcde', 'fghij', 'CCC']);
    expect(new Set(calls.map(c => c.ty)).size).toBe(4);
    expect(calls.map(c => c.tx)).toEqual([20, 5, 5, 20]);
  });

  it('explicit left/right align use 0.4 F padding; missing alignment stays centred', () => {
    expect(draw(['AAA', 'BBB'], W3, { align: 'left' }).calls.map(c => c.tx)).toEqual([24, 236]);
    expect(draw(['AAA', 'BBB'], W3, { align: 'right' }).calls.map(c => c.tx)).toEqual([464, 676]);
  });

  it('RTL reverses the words on each line based on the first letter, preserving word timing', () => {
    const { calls } = draw(['שלום', 'עולם'], { 'שלום': 100, 'עולם': 200 }, { mode: 'word-by-word', tau: 200 });
    expect(calls.map(c => c.text)).toEqual(['עולם', 'שלום']);
    expect(calls.map(c => c.alpha)).toEqual([0.4, 1]);
    expect(calls.map(c => c.tx)).toEqual([344, 556]);
  });

  it('stroke is drawn first at 2 × borderWidth (export), then the fill on top of it, for every word', () => {
    const { all } = draw(['AAA', 'BBB'], W3, { style: { borderWidth: 3 } });
    expect(all.map(c => c.kind)).toEqual(['stroke', 'fill', 'stroke', 'fill']);
    expect(all.filter(c => c.kind === 'stroke').map(c => c.lineWidth)).toEqual([6, 6]);
  });

  it('the item opacity multiplies the mode alpha (word alpha = item opacity × mode alpha) and a fully transparent word is not drawn', () => {
    const f = fake(W3); (f.ctx as { globalAlpha: number }).globalAlpha = 0.5;
    const d = { item: { id: 'c', details: {}, properties: {} }, style: style(60), mode: 'slide-up', config: cfg(), words: [{ text: 'AAA', startMs: 0, endMs: 400, sourceStartMs: 0, sourceEndMs: 400 }, { text: 'BBB', startMs: 800, endMs: 1200, sourceStartMs: 0, sourceEndMs: 0 }],
      wordTau: 100, anim: animationState(null, 0, 'AAA BBB'), shadowScale: 1 } as unknown as CaptionDraw;
    drawCaption(f.ctx as never, d, 1000, 200);
    const fills = f.calls.filter(c => c.kind === 'fill');
    expect(fills.map(c => c.text)).toEqual(['AAA']);                                  // BBB has not started: alpha 0
    expect(fills[0].alpha).toBeCloseTo(0.5 * outCubic(100 / 200), 9);
  });

  it('no words or a zero-sized box draws nothing and returns false', () => {
    expect(draw([], W3).ok).toBe(false);
    expect(draw(['AAA'], W3, { W: 0 }).ok).toBe(false);
  });

  it('an uppercase look draws upper-cased text', () => {
    expect(draw(['aaa'], { AAA: 200 }, { style: { transform: 'uppercase' } }).calls.map(c => c.text)).toEqual(['AAA']);
  });

});
