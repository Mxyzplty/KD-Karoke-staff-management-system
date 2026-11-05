// SPDX-License-Identifier: AGPL-3.0-only
// T13 waveform drawing maths (editor/waveform.tsx `columns`, `visiblePart`). Oracle: the written spec, TIM-14 "waveforms follow trim / slip / retime"
// (findings part 3 §45.4) and the T14 peak format (min, max pairs, 100 buckets/s): a column shows the peaks of the source span the clip reads there, so a
// source event at 2.00 s sits at clip-local (2 s − trim.from) / rate, mirrored by a reversed remap, held by a freeze. Expected columns are worked out by
// hand below (1 px = 1 ms, so a 10 ms bucket is ten columns), never copied from a run.
import { describe, expect, it } from 'vitest';
import { columns, visiblePart } from '../apps/web/src/editor/waveform';
import { kf, mkClip } from './t13-support';

const BPS = 100, BUCKETS = 600; // a 6 s source
/** min, max per bucket; every bucket silent except `loud` (bucket index → [min, max]). */
const row = (loud: Record<number, [number, number]> = { 200: [-0.8, 0.9] }) => {
  const peaks = new Float32Array(BUCKETS * 2);
  for (const [i, [lo, hi]] of Object.entries(loud)) { peaks[2 * Number(i)] = lo; peaks[2 * Number(i) + 1] = hi; }
  return { bucketsPerSecond: BPS, peaks };
};
/** Column indices (relative to x0) whose max reaches `above`. */
const loudColumns = (cols: Float32Array, above = 0.5) => Array.from({ length: cols.length / 2 }, (_, c) => c).filter(c => cols[2 * c + 1] >= above);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const clip = (extra: Record<string, unknown> = {}) => mkClip('c', 'a', 0, 4000, { sourceDuration: 6000, ...extra });
const COUNT = 4000, ZOOM = 1; // 1 px per ms

describe('columns: the peak follows the clip clock (source event at 2.00 s, bucket 200 = 2.00–2.01 s)', () => {
  it('untrimmed: the event is at clip-local 2.00 s (columns 2000…2009), with the stored min / max in those columns and silence elsewhere', () => {
    const cols = columns(clip(), row(), 0, COUNT, ZOOM);
    expect(cols).toHaveLength(COUNT * 2);
    expect(loudColumns(cols)).toEqual(range(2000, 2009));
    expect(cols[2 * 2000]).toBeCloseTo(-0.8, 6); expect(cols[2 * 2000 + 1]).toBeCloseTo(0.9, 6);
    expect(cols[2 * 1999]).toBe(0); expect(cols[2 * 1999 + 1]).toBe(0); expect(cols[2 * 2010]).toBe(0); expect(cols[2 * 2010 + 1]).toBe(0);
  });
  it('trim.from 1 s: the peak column sits at clip-local 1 s', () => {
    expect(loudColumns(columns(clip({ trim: { from: 1000 } }), row(), 0, COUNT, ZOOM))).toEqual(range(1000, 1009));
  });
  it('slip +0.5 s (trim.from 1.5 s): the peak moves earlier to clip-local 0.5 s', () => {
    expect(loudColumns(columns(clip({ trim: { from: 1500 } }), row(), 0, COUNT, ZOOM))).toEqual(range(500, 509));
  });
  it('slip −0.5 s (trim.from 0.5 s): the peak moves later to clip-local 1.5 s', () => {
    expect(loudColumns(columns(clip({ trim: { from: 500 } }), row(), 0, COUNT, ZOOM))).toEqual(range(1500, 1509));
  });
  it('playbackRate 2 with trim.from 1 s: the peak is at clip-local (2 − 1) / 2 = 0.5 s and half as wide (5 columns)', () => {
    expect(loudColumns(columns(clip({ trim: { from: 1000 }, playbackRate: 2 }), row(), 0, COUNT, ZOOM))).toEqual(range(500, 504));
  });
  it('playbackRate 0.5 with trim.from 1 s: the peak is at clip-local 2 s and twice as wide (20 columns)', () => {
    expect(loudColumns(columns(clip({ trim: { from: 1000 }, playbackRate: 0.5 }), row(), 0, COUNT, ZOOM))).toEqual(range(2000, 2019));
  });
  it('x0 offsets the window: columns 1900… of the same clip show the peak at index 100', () => {
    expect(loudColumns(columns(clip(), row(), 1900, 200, ZOOM))).toEqual(range(100, 109));
  });
  it('zoom: at 0.5 px/ms the same event is at column 1000 and spans 5 columns', () => {
    expect(loudColumns(columns(clip(), row(), 0, 2000, 0.5))).toEqual(range(1000, 1004));
  });
  it('a column spanning several buckets draws their min of mins and max of maxes (100 ms per column here)', () => {
    const cols = columns(clip(), row({ 200: [-0.8, 0.9], 205: [-0.3, 0.95] }), 0, 60, 0.01); // column 20 = 2000–2100 ms = buckets 200–209
    expect(cols[2 * 20]).toBeCloseTo(-0.8, 6); expect(cols[2 * 20 + 1]).toBeCloseTo(0.95, 6);
    expect(loudColumns(cols)).toEqual([20]);
  });
});

describe('columns: retime (time remap)', () => {
  const forward = { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(4000, 4000)] } };
  const reversed = { timeRemap: { defaultValue: 0, keyframes: [kf(0, 4000), kf(4000, 0)] } };
  const near = (cols: number[], expected: number[], slack = 1) => {
    expect(cols.length).toBeGreaterThanOrEqual(expected.length - slack); expect(cols.length).toBeLessThanOrEqual(expected.length + slack);
    expect(Math.abs(cols[0] - expected[0])).toBeLessThanOrEqual(slack); expect(Math.abs(cols[cols.length - 1] - expected[expected.length - 1])).toBeLessThanOrEqual(slack);
  };
  it('an identity remap draws the same columns as no remap (2000…2009)', () => {
    near(loudColumns(columns(clip(forward), row(), 0, COUNT, ZOOM)), range(2000, 2009));
  });
  it('a reversed remap mirrors the drawing: the event of source 2.00–2.01 s plays at clip-local 4 − 2.01 … 4 − 2.00 s (columns 1990…1999)', () => {
    near(loudColumns(columns(clip(reversed), row(), 0, COUNT, ZOOM)), range(1990, 1999));
  });
  it('a reversed remap puts an early source event (bucket 50 = 0.50 s) late and a late one (bucket 350 = 3.50 s) early', () => {
    const r = row({ 50: [-0.5, 0.5], 350: [-0.5, 0.6] });
    // bucket 350 (3.50–3.51 s) → local 4000 − 3510 … 4000 − 3500 = 490…499; bucket 50 (max 0.5, below the 0.55 threshold) → local 3490…3499
    near(loudColumns(columns(clip(reversed), r, 0, COUNT, ZOOM), 0.55), range(490, 499));
    const both = loudColumns(columns(clip(reversed), r, 0, COUNT, ZOOM), 0.45);
    expect(both).toHaveLength(20); expect(Math.abs(both[0] - 490)).toBeLessThanOrEqual(1); expect(Math.abs(both[19] - 3499)).toBeLessThanOrEqual(1);
  });
  it('a freeze (constant remap at 2.005 s) draws the event bucket in every column', () => {
    const cols = columns(clip({ timeRemap: { defaultValue: 0, keyframes: [kf(0, 2005), kf(4000, 2005)] } }), row(), 0, COUNT, ZOOM);
    expect(loudColumns(cols)).toEqual(range(0, COUNT - 1));
  });
  it('a remap past the source end is clamped to the source length (6 s): the last bucket shows where the curve passes 5.99 s, silence after', () => {
    // source = 5000 + 4 × local until local 1000 (9000 ms, clamped to 6000): bucket 599 (5.99–6.00 s) at local 247.5…250
    const r = row({ 599: [-0.4, 0.7] }), cols = columns(clip({ timeRemap: { defaultValue: 0, keyframes: [kf(0, 5000), kf(1000, 9000)] } }), r, 0, 4000, ZOOM);
    expect(cols[2 * 249 + 1]).toBeCloseTo(0.7, 6);
    for (let c = 250; c < 4000; c++) { expect(cols[2 * c]).toBe(0); expect(cols[2 * c + 1]).toBe(0); }
  });
});

describe('columns: beyond the source and degenerate input', () => {
  it('columns whose source time is past the source end are 0 / 0 (trim.from 5.9 s: clip-local 100 ms and later read past 6 s)', () => {
    const cols = columns(clip({ trim: { from: 5900 } }), row({ 599: [-0.4, 0.7] }), 0, 400, ZOOM);
    expect(loudColumns(cols, 0.5)).toEqual(range(90, 99)); // bucket 599 (5.99–6.00 s) = local 90–99 ms
    for (let c = 100; c < 400; c++) { expect(cols[2 * c]).toBe(0); expect(cols[2 * c + 1]).toBe(0); }
  });
  it('a clip that starts past the source end draws nothing and does not throw', () => {
    const cols = columns(clip({ trim: { from: 7000 } }), row(), 0, 100, ZOOM);
    expect(Array.from(cols).every(v => v === 0)).toBe(true);
  });
  it('a constant-speed clip that starts before source 0 (trim.from −0.5 s) is silent there and shows bucket 0 at clip-local 500…509 ms', () => {
    const cols = columns(clip({ trim: { from: -500 } }), row({ 0: [-0.2, 0.3] }), 0, 700, ZOOM);
    expect(cols).toHaveLength(1400); expect(loudColumns(cols, 0.25)).toEqual(range(500, 509));
    for (let c = 0; c < 500; c++) { expect(cols[2 * c]).toBe(0); expect(cols[2 * c + 1]).toBe(0); }
  });
  it('count 0 gives an empty array; an all-silent row gives all zeros', () => {
    expect(columns(clip(), row(), 0, 0, ZOOM)).toHaveLength(0);
    expect(Array.from(columns(clip(), row({}), 0, 3000, ZOOM)).every(v => v === 0)).toBe(true);
  });
  it('the row sets the time unit: 50 buckets/s puts a bucket 100 (2.00 s) at the same clip-local 2 s', () => {
    const peaks = new Float32Array(300 * 2); peaks[2 * 100] = -0.8; peaks[2 * 100 + 1] = 0.9;
    expect(loudColumns(columns(clip(), { bucketsPerSecond: 50, peaks }, 0, COUNT, ZOOM))).toEqual(range(2000, 2019));
  });
});

describe('visiblePart: the part of a clip [left, left + width) px drawn in a lane scrolled to `scroll` showing `view` px', () => {
  const size = ([a, b]: [number, number]) => b - a;
  it('the clip inside the view: all of it', () => { expect(visiblePart(100, 500, 0, 1000)).toEqual([0, 500]); });
  it('the clip longer than the view, unscrolled: cut at the right edge of the view (clip px 200 at view px 300)', () => { expect(visiblePart(100, 500, 0, 300)).toEqual([0, 200]); });
  it('scrolled: the part starts where the lane starts (clip px 150) and ends at the view edge (450)', () => { expect(visiblePart(100, 500, 250, 300)).toEqual([150, 450]); });
  it('partly off both sides: only the middle (clip px 200–300)', () => { expect(visiblePart(100, 500, 300, 100)).toEqual([200, 300]); });
  it('scrolled so the clip end is in view: the part ends at the clip width', () => { expect(visiblePart(100, 500, 400, 600)).toEqual([300, 500]); });
  it('fully off-screen to the left (clip 0–100, lane starts at 200): empty', () => { expect(size(visiblePart(0, 100, 200, 300))).toBeLessThanOrEqual(0); });
  it('fully off-screen to the right (clip 600–700, view 0–300): empty', () => { expect(size(visiblePart(600, 100, 0, 300))).toBeLessThanOrEqual(0); });
  it('fractional geometry rounds outward (floor the start, ceil the end), never negative', () => {
    expect(visiblePart(10.5, 20.2, 0, 15)).toEqual([0, 5]);
    expect(visiblePart(10.5, 20.2, 12.25, 100)).toEqual([1, 21]);
    const [a, b] = visiblePart(500, 50, 0, 100); expect(a).toBeGreaterThanOrEqual(0); expect(b).toBeGreaterThanOrEqual(0);
  });
});
