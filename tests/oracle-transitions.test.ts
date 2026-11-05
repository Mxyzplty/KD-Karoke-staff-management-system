// SPDX-License-Identifier: AGPL-3.0-only
// Findings part 5 §55 test values, computed through the oracle from the stated inputs.
// Tolerance: half a unit of the last printed digit; pixel codes ±1 LSB (§55.0).
import { it, expect } from 'vitest';
import { createImage, quantise8, type Image } from '../parity/oracle/image';
import type { RGBA } from '../parity/oracle/math';
import { transitions, transitionWindow, progressAt, frameTimeMs, windowParts, chainParts, extendedSourceMs, fadeAlpha, dissolveWeight, dipOverlay, slideOffsets, wipeMask, resolveDurationMs, maxDurationMs } from '../parity/oracle/transitions';

const near = (actual: number, printed: string) => { const d = printed.split('.')[1]?.length ?? 0; expect(Math.abs(actual - Number(printed)), `${actual} vs ${printed}`).toBeLessThanOrEqual(.5 * 10 ** -d + 1e-12); };
const lsb = (actual: number, printed: number) => expect(Math.abs(actual - printed), `${actual} vs ${printed}`).toBeLessThanOrEqual(1);
const row = (...px: RGBA[]) => { const m = createImage(px.length, 1); px.forEach((c, i) => m.data.set(c, i * 4)); return m; };
const fill = (width: number, c: RGBA) => createImage(width, 1, c);
const code = (m: Image, column: number, channel = 0) => quantise8(m)[column * 4 + channel];
const WHITE: RGBA = [1, 1, 1, 1], BLACK: RGBA = [0, 0, 0, 1], RED: RGBA = [1, 0, 0, 1], BLUE: RGBA = [0, 0, 1, 1];
// Every block: 1 s, Center. The fade block states cut 1000 ms and 30 fps; the others use the same window.
const W = transitionWindow(1000, 1000, 'center', 30);
const p = (tMs: number) => progressAt(tMs, W)!;
const pf = (frame: number) => progressAt(frameTimeMs(frame, 30), W);

it('§55.5 fade test values', () => {
  expect([W.firstFrame, W.lastFrame, W.startMs, W.endMs]).toEqual([15, 44, 500, 1500]);
  const A = row(WHITE, RED), B = row(WHITE, BLUE), at = (q: number) => transitions.fade(A, B, q, {});
  expect(pf(15)).toBe(0); expect(Array.from(quantise8(at(pf(15)!)))).toEqual(Array.from(quantise8(A)));
  near(p(750), '0.25'); near(fadeAlpha(p(750)), '0.7071'); lsb(code(at(p(750)), 0), 180);
  near(pf(22)!, '0.2333'); near(fadeAlpha(pf(22)!), '0.7431'); near(at(pf(22)!).data[0] * 255, '189.5'); lsb(code(at(pf(22)!), 0), 190);
  expect(pf(30)).toBe(.5); expect(Array.from(quantise8(at(pf(30)!)))).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  near(pf(37)!, '0.7333'); near(fadeAlpha(pf(37)!), '0.6691'); lsb(code(at(pf(37)!), 0), 171);
  near(fadeAlpha(pf(44)!), '0.9945'); lsb(code(at(pf(44)!), 0), Math.round(.9945 * 255));
  expect(pf(45)).toBeNull();
  // Column 1 (A red, B blue) tells the clips apart: A in the first half, B in the second half.
  lsb(code(at(p(750)), 1, 0), 180); expect(code(at(p(750)), 1, 2)).toBe(0);
  expect(code(at(pf(37)!), 1, 0)).toBe(0); lsb(code(at(pf(37)!), 1, 2), 171);
});

it('§55.5 dissolve test values', () => {
  const A = fill(1, WHITE), B = fill(1, BLACK), at = (t: number) => transitions.dissolve(A, B, p(t), {});
  near(dissolveWeight(p(750)), '0.1464'); lsb(code(at(750), 0), 218);
  near(dissolveWeight(p(1000)), '0.5'); lsb(code(at(1000), 0), 128);
  near(dissolveWeight(p(1250)), '0.8536'); lsb(code(at(1250), 0), 37);
});

it('§55.5 additiveDissolve test values', () => {
  const A = fill(1, WHITE), B = fill(1, BLACK), at = (t: number) => transitions.additiveDissolve(A, B, p(t), {});
  near(p(750), '0.25'); near(at(750).data[0], '0.75'); lsb(code(at(750), 0), 191);
  near(at(1000).data[0], '0.5'); lsb(code(at(1000), 0), 128);
  near(at(1250).data[0], '0.25'); lsb(code(at(1250), 0), 64);
  expect(at(1250).data[3]).toBe(1);
});

it('§55.5 dipToColorDissolve test values', () => {
  // A white, B blue: the second half must show B (blue under black at 0.5), not A.
  const A = fill(1, WHITE), B = fill(1, BLUE), at = (q: number, params = {}) => transitions.dipToColorDissolve(A, B, q, params);
  near(dipOverlay(p(750)), '0.5'); [0, 1, 2].forEach(k => lsb(code(at(p(750)), 0, k), 128));
  expect(dipOverlay(p(1000))).toBe(1); expect(Array.from(quantise8(at(p(1000))))).toEqual([0, 0, 0, 255]);
  near(dipOverlay(p(1250)), '0.5'); expect([code(at(p(1250)), 0, 0), code(at(p(1250)), 0, 1)]).toEqual([0, 0]); lsb(code(at(p(1250)), 0, 2), 128);
  near(dipOverlay(.9), '0.104');
  expect(Array.from(quantise8(at(p(1000), { color: [1, 0, 0] })))).toEqual([255, 0, 0, 255]);
});

it('§55.5 slide test values', () => {
  const o = (q: number) => { const s = slideOffsets(q, 'from-left', 1080, 1920); expect(Math.abs(s.outgoing[1]) + Math.abs(s.incoming[1])).toBe(0); return [s.outgoing[0], s.incoming[0]]; };
  expect(o(p(750))).toEqual([68, -1012]);
  expect(o(p(1000))).toEqual([540, -540]);
  expect(o(p(1250))).toEqual([1013, -67]);
  expect(o(.9)).toEqual([1076, -4]);
  // Pixels: A white moved to x = +68, B black ending at x = 68; no overlap, no gap.
  const out = transitions.slide(fill(1080, WHITE), fill(1080, BLACK), p(750), { direction: 'from-left' }), q = quantise8(out);
  expect([q[67 * 4], q[67 * 4 + 3], q[68 * 4], q[68 * 4 + 3]]).toEqual([0, 255, 255, 255]);
});

it('§55.5 wipe test values', () => {
  const m = (x: number, q: number, s: number, ideal = false) => wipeMask(x / 1080, q, s, ideal); // x = pixel-centre position in px
  // s = 0 at the cut: B covers x < 540.
  expect([m(539.5, p(1000), 0), m(540.5, p(1000), 0)]).toEqual([1, 0]);
  const hard = transitions.wipe(fill(1080, WHITE), fill(1080, BLACK), p(1000), { direction: 'from-left' });
  expect([code(hard, 539), code(hard, 540)]).toEqual([0, 255]);
  // s = 0 at cut − 250 ms: edge at x = 270.
  expect([m(269.5, p(750), 0), m(270.5, p(750), 0)]).toEqual([1, 0]);
  // s = 20 at the cut: solid x < 432, ramp to 648, 0.5 at 540.
  expect(m(431.5, p(1000), .2)).toBe(1); expect(m(432.5, p(1000), .2)).toBeLessThan(1);
  expect(m(647.5, p(1000), .2)).toBeGreaterThan(0); expect(m(648.5, p(1000), .2)).toBe(0);
  near(m(540, p(1000), .2), '0.5');
  const soft = transitions.wipe(fill(1080, WHITE), fill(1080, BLACK), p(1000), { direction: 'from-left', softness: 20 });
  // Ideal mask (f = 0.5·1.2 = 0.6 ≤ 1), black B over white A, red = 255·(1 − m) with m = (0.6 − (column + 0.5)/1080) / 0.2:
  // column 540 → m 0.49769 → 128.1 → 128; column 486 → m 0.74769 → 64.3 → 64.
  lsb(code(soft, 540), 128); lsb(code(soft, 486), 64);
  // s = 20 at cut − 250 ms: solid < 108, clear ≥ 324.
  expect(m(107.5, p(750), .2)).toBe(1); expect(m(108.5, p(750), .2)).toBeLessThan(1);
  expect(m(323.5, p(750), .2)).toBeGreaterThan(0); expect(m(324.5, p(750), .2)).toBe(0);
  // s = 20, p = 0.95: export ramps from x = 1015 to 0 at x = 1080; ideal value at the edge 0.70.
  expect(m(1014.5, .95, .2)).toBe(1); expect(m(1015.5, .95, .2)).toBeLessThan(1);
  expect(m(1079.5, .95, .2)).toBeGreaterThan(0); expect(m(1080, .95, .2)).toBe(0);
  near(m(1080, .95, .2, true), '0.70');
});

it('§55.5 wipe quirk examples (A: s 0.5, p 0.8; B: p 0, s 0)', () => {
  near(wipeMask(.85, .8, .5, true), '0.70'); near(wipeMask(.85, .8, .5), '0.50');
  near(wipeMask(1, .8, .5, true), '0.40'); expect(wipeMask(1, .8, .5)).toBe(0);
  near(wipeMask(.25, 0, 0), '0.75'); expect(wipeMask(.25, 0, 0, true)).toBe(0);
});

it('§55.1–§55.3 written examples', () => {
  expect(windowParts(1995, .5)).toEqual({ preMs: 997, postMs: 998 });
  expect(chainParts(777, windowParts(1000, .5).postMs, windowParts(1000, .5).preMs)).toEqual([389, 388]);
  const end = transitionWindow(5000, 1000, 1, 30), start = transitionWindow(5000, 1000, 0, 30);
  expect([end.startMs, end.endMs, start.startMs, start.endMs]).toEqual([4000, 5000, 5000, 6000]);
  // In-point 500 ms, 1000 ms End transition: incoming clip (start 5000) freezes on frame 0 for 500 ms, then plays 0 → 500.
  const clip = { startMs: 5000, inPointMs: 500, rate: 1, sourceDurationMs: 10000 };
  expect([4000, 4499, 4500, 4750, 5000].map(t => extendedSourceMs(t, clip))).toEqual([0, 0, 0, 250, 500]);
  expect(maxDurationMs(5000, 2400.7)).toBe(2400); expect(resolveDurationMs(undefined, 2400)).toBe(1000);
  expect(resolveDurationMs(5000, 2400)).toBe(2400); expect(resolveDurationMs(40, 2400)).toBe(100);
  expect(resolveDurationMs(1000, 99)).toMatchObject({ code: 'INVALID_PAIR' });
});
