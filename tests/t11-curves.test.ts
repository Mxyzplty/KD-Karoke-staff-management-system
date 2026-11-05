// SPDX-License-Identifier: AGPL-3.0-only
// T11 transition curves (findings part 5 §55.5 formulas and test values; part 3 §46.8 for the edge drag). Pure functions: the per-kind
// alpha / weight / offset / mask curves of render/transitions.ts and the edge-drag length of editor/transition-ui.tsx. The pictures are
// in tests/ui/t11-render.spec.ts. Expected numbers are hand-evaluated from the §55.5 formulas, not read from the code.
// Own rules (not from the doc) are labelled: dipColour's clamp and non-number entries, wipeSoftness's non-number → 0.
import { describe, expect, it } from 'vitest';
import { dipColour, dipOverlay, dissolveWeight, fadeAlpha, inOutCubic, slideOffsets, wipeMask, wipeSoftness } from '../apps/web/src/render/transitions';
import { draggedMs } from '../apps/web/src/editor/transition-ui';

/** −0 → 0 so toEqual compares offsets by value. */
const z = (v: number[]) => v.map(x => x + 0);

describe('fade (§55.5): black fill, A at cos(πp) for p < .5, then B at −cos(πp)', () => {
  it.each([[0, 1], [0.25, 0.70711], [0.5, 0], [0.75, 0.70711], [1, 1], [0.2333, 0.7431], [0.7333, 0.6691], [0.96667, 0.99452], [0.1, 0.95106], [0.9, 0.95106]])('fadeAlpha(%s) ≈ %s', (p, a) => { expect(fadeAlpha(p)).toBeCloseTo(a, 3); });
  it('the §55.5 test values at 30 fps on a 1 s Center window at cut 1000: frame 22 → .7431, frame 37 → .6691, frame 44 → .9945', () => {
    const at = (f: number) => (f * 1000 / 30 - 500) / 1000;
    expect(fadeAlpha(at(22))).toBeCloseTo(0.7431, 4); expect(fadeAlpha(at(37))).toBeCloseTo(0.6691, 4); expect(fadeAlpha(at(44))).toBeCloseTo(0.9945, 4);
  });
  it('is 0 at the midpoint (full black) and never leaves [0, 1]', () => {
    expect(fadeAlpha(0.5)).toBeCloseTo(0, 12);
    for (let i = 0; i <= 100; i++) { const a = fadeAlpha(i / 100); expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(1); }
  });
});

describe('dissolve (§55.5): B over A at w = .5 − .5 cos(πp)', () => {
  it.each([[0, 0], [0.25, 0.14645], [0.5, 0.5], [0.75, 0.85355], [1, 1]])('dissolveWeight(%s) ≈ %s', (p, w) => { expect(dissolveWeight(p)).toBeCloseTo(w, 4); });
  it('the §55.5 pixel values for red A over blue B: w .1464 / .5 / .8536 → A 218 / 128 / 37', () => {
    for (const [p, a] of [[0.25, 218], [0.5, 128], [0.75, 37]] as const) expect(Math.round(255 * (1 - dissolveWeight(p)))).toBe(a);
  });
});

describe('dip to colour (§55.5): overlay smooth(p/.5) up, then 1 − smooth((p−.5)/.5); colour array × 255 rounded, otherwise black', () => {
  it.each([[0, 0], [0.25, 0.5], [0.5, 1], [0.75, 0.5], [1, 0], [0.9, 0.104], [0.1, 0.104], [0.125, 0.15625]])('dipOverlay(%s) ≈ %s', (p, o) => { expect(dipOverlay(p)).toBeCloseTo(o, 4); });
  it('dipColour: [r, g, b] in 0–1 → round(v × 255)', () => {
    expect(dipColour([1, 0, 0.5])).toEqual([255, 0, 128]); expect(dipColour([0.2, 0.4, 0.6])).toEqual([51, 102, 153]); expect(dipColour([0, 0, 0])).toEqual([0, 0, 0]);
  });
  it('a missing or non-array colour is black', () => {
    for (const c of [undefined, null, 'red', '#ff0000', 5, { 0: 1, 1: 1, 2: 1 }]) expect(dipColour(c)).toEqual([0, 0, 0]);
  });
  it('own rule, not from the doc: entries are clamped to 0–1 and a non-number entry is 0', () => {
    expect(dipColour([2, -1, 0.5])).toEqual([255, 0, 128]); expect(dipColour([1, 'x', null])).toEqual([255, 0, 0]); expect(dipColour([1])).toEqual([255, 0, 0]);
  });
});

describe('slide (§55.5): e = inOutCubic(p); outgoing e·d·(W,H), incoming (e − 1)·d·(W,H), round half up', () => {
  it.each([[0, 0], [0.25, 0.0625], [0.5, 0.5], [0.75, 0.9375], [1, 1], [0.9, 0.996]])('inOutCubic(%s) = %s', (p, e) => { expect(inOutCubic(p)).toBeCloseTo(e, 6); });
  it('the §55.5 test values, from-left, W = 1080: p .25 → A +68, B −1012; .5 → ±540; .75 → A +1013, B −67; .9 → A +1076, B −4', () => {
    const at = (p: number) => slideOffsets(p, 'from-left', 1080, 1920);
    expect(z(at(0.25).outgoing)).toEqual([68, 0]); expect(z(at(0.25).incoming)).toEqual([-1012, 0]);
    expect(z(at(0.5).outgoing)).toEqual([540, 0]); expect(z(at(0.5).incoming)).toEqual([-540, 0]);
    expect(z(at(0.75).outgoing)).toEqual([1013, 0]); expect(z(at(0.75).incoming)).toEqual([-67, 0]);
    expect(z(at(0.9).outgoing)).toEqual([1076, 0]); expect(z(at(0.9).incoming)).toEqual([-4, 0]);
  });
  it('p = 0 puts A in place and B a whole frame away; p = 1 the reverse', () => {
    expect(z(slideOffsets(0, 'from-left', 1080, 1920).outgoing)).toEqual([0, 0]); expect(z(slideOffsets(0, 'from-left', 1080, 1920).incoming)).toEqual([-1080, 0]);
    expect(z(slideOffsets(1, 'from-left', 1080, 1920).outgoing)).toEqual([1080, 0]); expect(z(slideOffsets(1, 'from-left', 1080, 1920).incoming)).toEqual([0, 0]);
  });
  it('all four directions at p = .5 on 1080 × 1920: from-left (+1,0), from-right (−1,0), from-top (0,+1), from-bottom (0,−1)', () => {
    const o = (d: string) => { const r = slideOffsets(0.5, d, 1080, 1920); return { outgoing: z(r.outgoing), incoming: z(r.incoming) }; };
    expect(o('from-left')).toEqual({ outgoing: [540, 0], incoming: [-540, 0] });
    expect(o('from-right')).toEqual({ outgoing: [-540, 0], incoming: [540, 0] });
    expect(o('from-top')).toEqual({ outgoing: [0, 960], incoming: [0, -960] });
    expect(o('from-bottom')).toEqual({ outgoing: [0, -960], incoming: [0, 960] });
  });
  it('all four directions at p = .25: the axis uses W for left / right and H for top / bottom', () => {
    const o = (d: string) => { const r = slideOffsets(0.25, d, 1080, 1920); return { outgoing: z(r.outgoing), incoming: z(r.incoming) }; };
    expect(o('from-right')).toEqual({ outgoing: [-67, 0], incoming: [1013, 0] }); // round half up: −67.5 → −67, 1012.5 → 1013
    expect(o('from-top')).toEqual({ outgoing: [0, 120], incoming: [0, -1800] });
    expect(o('from-bottom')).toEqual({ outgoing: [0, -120], incoming: [0, 1800] });
  });
});

describe('wipe (§55.5): softness s = clamp(softness, 0, 100)/100; f = p(1 + s), g = f − s; mask in u from the entry side', () => {
  it('wipeSoftness: a fraction of the frame; clamped to 0–100; no softness → 0', () => {
    expect(wipeSoftness(undefined)).toBe(0); expect(wipeSoftness({})).toBe(0); expect(wipeSoftness({ softness: 20 })).toBe(0.2);
    expect(wipeSoftness({ softness: 150 })).toBe(1); expect(wipeSoftness({ softness: -5 })).toBe(0); expect(wipeSoftness({ softness: 100 })).toBe(1);
  });
  it('own rule, not from the doc: a non-number softness is 0', () => { expect(wipeSoftness({ softness: '20' })).toBe(0); expect(wipeSoftness({ softness: null })).toBe(0); });
  it('s = 0: a hard edge at u = p (B on the entry side)', () => {
    expect(wipeMask(0.25, 0.25, 0)).toBe(1); expect(wipeMask(0.2, 0.25, 0)).toBe(1); expect(wipeMask(0.3, 0.25, 0)).toBe(0); expect(wipeMask(0.9, 0.5, 0)).toBe(0);
    expect(wipeMask(0.5, 0.5, 0)).toBe(1);
  });
  it('s = .2 at the cut (p = .5): solid below u = .4, linear to .6, .5 at u = .5 — 432 / 648 / 540 px on W = 1080', () => {
    expect(wipeMask(0.39, 0.5, 0.2)).toBe(1); expect(wipeMask(0.4, 0.5, 0.2)).toBeCloseTo(1, 12);   // boundary: float noise in g = f − s
    expect(wipeMask(0.6, 0.5, 0.2)).toBe(0); expect(wipeMask(0.7, 0.5, 0.2)).toBe(0);
    expect(wipeMask(0.5, 0.5, 0.2)).toBeCloseTo(0.5, 9); expect(wipeMask(0.45, 0.5, 0.2)).toBeCloseTo(0.75, 9); expect(wipeMask(0.55, 0.5, 0.2)).toBeCloseTo(0.25, 9);
    expect(0.4 * 1080).toBeCloseTo(432, 6); expect(0.6 * 1080).toBeCloseTo(648, 6);
  });
  it('s = .2 at p = .25: solid below u = .1 (108 px), clear from u = .3 (324 px)', () => {
    expect(wipeMask(0.1, 0.25, 0.2)).toBeCloseTo(1, 12); expect(wipeMask(0.3, 0.25, 0.2)).toBe(0); expect(wipeMask(0.2, 0.25, 0.2)).toBeCloseTo(0.5, 9);
  });
  it('quirk A: once the feather front passes the far edge (f > 1) the ramp ends at the edge — m = (1 − u)/(1 − g)', () => {
    expect(wipeMask(0.94, 0.9, 0.2)).toBeCloseTo(0.5, 9); // f = 1.08, g = .88
    expect(wipeMask(0.88, 0.9, 0.2)).toBe(1); expect(wipeMask(1, 0.9, 0.2)).toBe(0); expect(wipeMask(0.97, 0.9, 0.2)).toBeCloseTo(0.25, 9);
    expect(wipeMask(0.5, 1, 0.2)).toBe(1); expect(wipeMask(1, 1, 0.2)).toBe(1); // p = 1: all B (g = 1)
  });
  it('quirk B: p = 0 with s = 0 is the ramp 1 − u, not "all A"', () => {
    expect(wipeMask(0, 0, 0)).toBe(1); expect(wipeMask(0.3, 0, 0)).toBeCloseTo(0.7, 12); expect(wipeMask(1, 0, 0)).toBe(0);
  });
  it('p = 0 with softness: all A except u = 0 (g < 0)', () => { expect(wipeMask(0.01, 0, 0.2)).toBe(0); expect(wipeMask(0.5, 0, 0.2)).toBe(0); });
  it('p = 1, s = 0: all B', () => { for (const u of [0, 0.5, 1]) expect(wipeMask(u, 1, 0)).toBe(1); });
});

describe('edge drag (§46.8: a +1 s drag on a 1 s transition → 2000 ms; the length changes by the drag distance)', () => {
  it('+1 s on the end edge and −1 s (dragged left) on the start edge both give 2000', () => {
    expect(draggedMs(1000, 'end', 1000, 3000)).toBe(2000); expect(draggedMs(1000, 'start', -1000, 3000)).toBe(2000);
  });
  it('the opposite drags shorten: end −400 → 600, start +400 → 600', () => {
    expect(draggedMs(1000, 'end', -400, 3000)).toBe(600); expect(draggedMs(1000, 'start', 400, 3000)).toBe(600);
  });
  it('clamps at 100 ms below and at hi above', () => {
    expect(draggedMs(1000, 'end', -5000, 3000)).toBe(100); expect(draggedMs(1000, 'start', 5000, 3000)).toBe(100);
    expect(draggedMs(1000, 'end', 5000, 3000)).toBe(3000); expect(draggedMs(1000, 'start', -5000, 3000)).toBe(3000);
    expect(draggedMs(1000, 'end', 5000, 1500)).toBe(1500);
  });
  it('no movement leaves the length', () => { expect(draggedMs(1234, 'end', 0, 3000)).toBe(1234); });
});
