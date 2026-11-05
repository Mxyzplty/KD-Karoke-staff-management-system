// SPDX-License-Identifier: AGPL-3.0-only
// T04 property model, written-spec oracle. Oracle: findings part 2 §38 (evaluation, clocks, speed), §40 (registry, easing coefficients), agent tool
// results §2 viewItemDetails and §6 G-02 (keyframes block, speed range), tickets § T04. The oracle below is a SEPARATE implementation (own
// cubic-bezier solver by bisection, own §38 evaluator, own back / elastic / bounce); properties.ts is only the thing under test.
// Provisional (undocumented in the written spec): the order of EASINGS; the control points used as handle defaults for back / elastic / bounce
// easings (no handles are generated on those in the random sets); the zero-slope sign of speedAt; seconds rounding of keyframesBlock; the
// keyframes of the 12,000 ms speed-range case (assumed 0 → 0 and 10 s → 12,000 ms, linear).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEZIER, EASINGS, KEYFRAME_PROPERTIES, RATE, REMAP_TYPES, evaluate, keyframeId, keyframesBlock, propertyTime, sourceTime, specOf, speedAt, speedRange, toPropertyTime, toTimelineMs, validEasing, valueAt } from '../apps/web/src/timeline/properties';
import { mkItem, video } from './t03-fixtures';

afterEach(() => { vi.useRealTimers(); });

// ---- Independent oracle.
type K = { id: string; time: number; value: unknown; easing: any; inHandle?: [number, number]; outHandle?: [number, number] };
const NAMES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeInQuad', 'easeOutQuad', 'easeInOutQuad', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic', 'easeInBack', 'easeOutBack', 'easeInOutBack', 'easeOutElastic', 'easeOutBounce'];
const TABLE: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1], easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1],
  easeInQuad: [0.55, 0.085, 0.68, 0.53], easeOutQuad: [0.25, 0.46, 0.45, 0.94], easeInOutQuad: [0.455, 0.03, 0.515, 0.955],
  easeInCubic: [0.55, 0.055, 0.675, 0.19], easeOutCubic: [0.215, 0.61, 0.355, 1], easeInOutCubic: [0.645, 0.045, 0.355, 1],
};
const bez = (c: readonly number[], x: number) => {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const B = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t * t + t ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (B(c[0], c[2], m) < x) lo = m; else hi = m; }
  return B(c[1], c[3], (lo + hi) / 2);
};
const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1, c4 = (2 * Math.PI) / 3;
const FN: Record<string, (x: number) => number> = {
  easeInBack: x => c3 * x * x * x - c1 * x * x,
  easeOutBack: x => 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2,
  easeInOutBack: x => x < 0.5 ? ((2 * x) ** 2 * ((c2 + 1) * 2 * x - c2)) / 2 : ((2 * x - 2) ** 2 * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2,
  easeOutElastic: x => x === 0 ? 0 : x === 1 ? 1 : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1,
  easeOutBounce: x => { const n = 7.5625, d = 2.75; if (x < 1 / d) return n * x * x; if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75; if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375; return n * (x -= 2.625 / d) * x + 0.984375; },
};
const ease = (e: any, p: number) => typeof e === 'object' && e ? bez(e.points, p) : FN[e] ? FN[e](p) : bez(TABLE[e] ?? TABLE.linear, p); // unknown stored name → linear (§40)
const oracle = (kfs: K[], fallback: unknown, t: number): unknown => {
  if (!kfs.length) return fallback;
  const k = [...kfs].sort((a, b) => a.time - b.time), last = k[k.length - 1];
  if (t <= k[0].time) return k[0].value; if (t >= last.time) return last.value;
  let i = 1; while (k[i].time <= t) i++;
  const a = k[i - 1], b = k[i];
  if (typeof a.value !== 'number' || typeof b.value !== 'number') return a.value;
  const p = (t - a.time) / (b.time - a.time);
  let e: number;
  if (a.outHandle || b.inHandle) { const d = TABLE[a.easing as string] ?? TABLE.linear, o = a.outHandle ?? [d[0], d[1]], n = b.inHandle ?? [d[2], d[3]]; e = bez([o[0], o[1], n[0], n[1]], p); } else e = ease(a.easing, p);
  return a.value + (b.value - a.value) * e;
};
const kf = (time: number, value: unknown, easing: any = 'linear', extra: Partial<K> = {}): K => ({ id: `k${time}`, time, value, easing, ...extra });
const prop = (keyframes: K[], defaultValue: unknown = 0) => ({ defaultValue, keyframes });
const mulberry = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

describe('T04 registry (findings part 2 §40, written-spec oracle)', () => {
  // [type, key, default, min, max, animatable]
  const rows: [string, string, unknown, number | undefined, number | undefined, boolean][] = [];
  for (const t of ['video', 'image', 'text', 'shape', 'motionGraphic', 'caption']) rows.push(
    [t, 'opacity', 1, 0, 1, true], [t, 'scale', 1, 0, 100, true], [t, 'rotation', 0, -360, 360, true], [t, 'positionX', 0, undefined, undefined, true], [t, 'positionY', 0, undefined, undefined, true], [t, 'flipX', false, undefined, undefined, false], [t, 'flipY', false, undefined, undefined, false]);
  for (const t of ['video', 'image', 'motionGraphic', 'layout']) rows.push([t, 'width', 0, 0, undefined, true], [t, 'height', 0, 0, undefined, true]);
  rows.push(['shape', 'width', 0, 0, undefined, false], ['shape', 'height', 0, 0, undefined, false], ['text', 'width', 0, 0, undefined, false], ['text', 'height', 0, 0, undefined, false], ['caption', 'width', 800, 0, undefined, false], ['caption', 'height', 100, 0, undefined, false]);
  for (const t of ['video', 'image', 'motionGraphic']) rows.push([t, 'blur', 0, 0, 50, true], [t, 'borderRadius', 0, 0, 500, true], [t, 'borderWidth', 0, 0, 20, true], [t, 'borderColor', '#000000', undefined, undefined, false], [t, 'boxShadow', { color: 'transparent', x: 0, y: 0, blur: 0 }, undefined, undefined, false]);
  for (const t of ['video', 'image', 'text', 'shape', 'motionGraphic', 'caption', 'layout']) rows.push([t, 'zIndex', 0, undefined, undefined, false], [t, 'blendMode', 'normal', undefined, undefined, false]);
  rows.push(['video', 'volume', 1, 0, 3, true], ['audio', 'volume', 1, 0, 3, true], ['text', 'borderWidth', 0, 0, 20, true], ['caption', 'borderWidth', 0, 0, 20, true],
    ['shape', 'fillOpacity', 1, 0, 1, true], ['shape', 'fillColor', '#3b82f6', undefined, undefined, false], ['shape', 'strokeWidth', 0, 0, 50, true], ['shape', 'strokeColor', 'none', undefined, undefined, false], ['shape', 'strokeOpacity', 1, 0, 1, true],
    ['motionGraphic', 'brightness', 1, 0, 2, true]);

  it.each(rows)('%s.%s: default %j, range %s…%s, animatable %s', (type, key, def, min, max, anim) => {
    const s = specOf(type, key)!;
    expect(s, `${type}.${key}`).toBeDefined();
    expect(s.default).toEqual(def); expect(s.min).toBe(min); expect(s.max).toBe(max); expect(s.anim).toBe(anim);
  });
  it('properties a type does not carry are absent (no volume on image / text, no opacity on audio)', () => {
    for (const [t, k] of [['image', 'volume'], ['text', 'volume'], ['audio', 'opacity'], ['video', 'fillOpacity'], ['text', 'brightness']]) expect(specOf(t, k), `${t}.${k}`).toBeUndefined();
  });
  it('playbackRate 0.1–4 default 1 (an item field, not animatable); time remap is video and audio only', () => {
    expect(RATE).toMatchObject({ default: 1, min: 0.1, max: 4 }); expect([...REMAP_TYPES].sort()).toEqual(['audio', 'video']);
  });
  it('writeKeyframes accepts exactly the 15 item properties of the contract', () => {
    expect([...KEYFRAME_PROPERTIES].sort()).toEqual(['blur', 'borderRadius', 'borderWidth', 'brightness', 'fillOpacity', 'height', 'opacity', 'positionX', 'positionY', 'rotation', 'scale', 'strokeOpacity', 'strokeWidth', 'volume', 'width'].sort());
  });
});

describe('T04 easings (findings part 2 §40, written-spec oracle)', () => {
  it('there are exactly the 15 named easings; unknown names are not valid input but a bezier object is', () => {
    expect([...EASINGS].sort()).toEqual([...NAMES].sort());
    for (const n of NAMES) expect(validEasing(n), n).toBe(true);
    expect(validEasing('wobble')).toBe(false); expect(validEasing({ type: 'bezier', points: [0.42, 0, 0.58, 1] })).toBe(true);
    expect(validEasing({ type: 'bezier', points: [0.42, 0, 0.58] })).toBe(false); expect(validEasing(7)).toBe(false);
  });
  it('the ten bezier-named easings keep the §40 coefficients', () => { expect(BEZIER).toEqual(TABLE); });
  it.each(NAMES)('%s sampled at 21 points equals the §40 curve within 1e-6', name => {
    const pair = [kf(0, 0, name), kf(1000, 1)];
    for (let n = 0; n <= 20; n++) { const p = n / 20, got = evaluate(pair as any, 0, p * 1000) as number; expect(Math.abs(got - (ease(name, p) as number)), `${name} @${p}`).toBeLessThan(1e-6); }
  });
  it('endpoints: every easing starts at 0 and ends at 1 (overshoot only in between)', () => {
    for (const n of NAMES) { const pair = [kf(0, 0, n), kf(1000, 1)]; expect(evaluate(pair as any, 0, 0)).toBe(0); expect(evaluate(pair as any, 0, 1000)).toBe(1); }
  });
  it('an unknown stored easing name evaluates as linear (stored names only, §40)', () => {
    expect(evaluate([kf(0, 0, 'wobble'), kf(1000, 10)] as any, 0, 250)).toBeCloseTo(2.5, 9);
  });
});

describe('T04 evaluation (findings part 2 §38, written-spec oracle)', () => {
  it('no keyframes → defaultValue; hold before the first and after the last; exactly on a keyframe → its value', () => {
    expect(evaluate([], 7, 100)).toBe(7); expect(evaluate(undefined, 7, 100)).toBe(7);
    const k = [kf(1000, 10), kf(2000, 20)] as any;
    expect(evaluate(k, 0, 0)).toBe(10); expect(evaluate(k, 0, 1000)).toBe(10); expect(evaluate(k, 0, 2000)).toBe(20); expect(evaluate(k, 0, 9999)).toBe(20);
  });
  it('keyframes are sorted by time whatever the stored order', () => {
    expect(evaluate([kf(2000, 20), kf(0, 0)] as any, 0, 500)).toBeCloseTo(5, 9);
  });
  it('between A and B the OUTGOING keyframe A\'s easing applies (B\'s easing is ignored)', () => {
    const k = [kf(0, 0, 'easeInQuad'), kf(1000, 1, 'easeOutBounce')] as any;
    expect(evaluate(k, 0, 500)).toBeCloseTo(ease('easeInQuad', 0.5) as number, 6);
  });
  it('an out-handle on A and/or an in-handle on B switch the segment to a handle bezier; the missing side defaults from A\'s easing', () => {
    const both = [kf(0, 0, 'linear', { outHandle: [0.1, 0.8] }), kf(1000, 100, 'linear', { inHandle: [0.7, 0.2] })] as any;
    expect(evaluate(both, 0, 400)).toBeCloseTo(100 * bez([0.1, 0.8, 0.7, 0.2], 0.4), 6);
    const inOnly = [kf(0, 0, 'easeIn'), kf(1000, 100, 'linear', { inHandle: [0.2, 0.9] })] as any; // A.out defaults to easeIn's (0.42, 0)
    expect(evaluate(inOnly, 0, 600)).toBeCloseTo(100 * bez([0.42, 0, 0.2, 0.9], 0.6), 6);
    const outOnly = [kf(0, 0, 'easeOut', { outHandle: [0.3, 0.3] }), kf(1000, 100)] as any; // B.in defaults to easeOut's (0.58, 1)
    expect(evaluate(outOnly, 0, 600)).toBeCloseTo(100 * bez([0.3, 0.3, 0.58, 1], 0.6), 6);
  });
  it('a bezier-object easing evaluates its four points', () => {
    expect(evaluate([kf(0, 0, { type: 'bezier', points: [0.25, 0.1, 0.25, 1] }), kf(1000, 10)] as any, 0, 300)).toBeCloseTo(10 * bez([0.25, 0.1, 0.25, 1], 0.3), 6);
  });
  it('a bezier-object easing with only an outHandle: the missing in-handle defaults from the object\'s own points (part 2 §38 l.519, §40 l.558)', () => {
    const k = [kf(0, 0, { type: 'bezier', points: [0.25, 0.1, 0.25, 1] }, { outHandle: [0.6, 0.2] }), kf(1000, 10)] as any;
    for (const t of [300, 700]) expect(evaluate(k, 0, t)).toBeCloseTo(10 * bez([0.6, 0.2, 0.25, 1], t / 1000), 6);
  });
  it('non-numeric values hold A between keyframes and switch at B', () => {
    const k = [kf(0, 'a'), kf(1000, 'b')] as any;
    expect(evaluate(k, 'x', 500)).toBe('a'); expect(evaluate(k, 'x', 999)).toBe('a'); expect(evaluate(k, 'x', 1000)).toBe('b');
  });
  it('20 property/keyframe sets × 50 sample times match the independent §38 evaluator within 0.001', () => {
    const rnd = mulberry(20261101); let samples = 0;
    for (let set = 0; set < 20; set++) {
      const n = 1 + Math.floor(rnd() * 6), times = new Set<number>();
      while (times.size < n) times.add(Math.floor(rnd() * 10) * 1000 + Math.floor(rnd() * 4) * 250);
      const sortedT = [...times].sort((a, b) => a - b);
      const ks: K[] = sortedT.map((t, i) => kf(t, Math.round((rnd() * 200 - 100) * 100) / 100, NAMES[Math.floor(rnd() * NAMES.length)], { id: `s${set}k${i}` }));
      if (set % 7 === 3) ks[0].easing = { type: 'bezier', points: [0.25, 0.1, 0.25, 1] }; // before the handle loop, so no handle lands on a bezier-object keyframe or its successor
      ks.forEach((k, i) => { // handles only where the missing side defaults from a table easing
        if (rnd() < 0.25 && TABLE[k.easing as string]) k.outHandle = [Math.round(rnd() * 100) / 100, Math.round((rnd() * 3 - 1) * 100) / 100];
        if (i > 0 && TABLE[ks[i - 1].easing as string] && rnd() < 0.25) k.inHandle = [Math.round(rnd() * 100) / 100, Math.round((rnd() * 3 - 1) * 100) / 100];
      });
      const shuffled = [...ks], lastT = sortedT[sortedT.length - 1]; // seeded Fisher-Yates: the same order on every engine (a comparator-based sort calls rnd an engine-dependent number of times)
      for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      for (let s = 0; s < 50; s++) {
        const t = Math.floor(rnd() * (lastT + 1500)) - 500, want = oracle(ks, 0, t) as number, got = evaluate(shuffled as any, 0, t) as number;
        expect(Math.abs(got - want), `set ${set} t=${t}`).toBeLessThan(0.001); samples++;
      }
    }
    expect(samples).toBe(1000);
  });
});

describe('T04 clocks (findings part 2 §38, written-spec oracle)', () => {
  it('property time = trim.from + local × rate; a rate ≤ 0 counts as 1; no trim counts as 0', () => {
    expect(propertyTime(video('v', 'V1', 0, 4000, 2000, 10000, { playbackRate: 2 }), 1000)).toBe(4000);
    expect(propertyTime(video('v', 'V1', 0, 4000, 2000, 10000, { playbackRate: 0 }), 1000)).toBe(3000);
    expect(propertyTime(video('v', 'V1', 0, 4000, 2000, 10000, { playbackRate: -3 }), 1000)).toBe(3000);
    expect(propertyTime(mkItem('t', 'O1', 500, 2500, { type: 'text' }), 700)).toBe(700);
  });
  it('timeline ms ↔ property ms are inverses (display start, trim.from and rate)', () => {
    const it = video('v', 'V1', 1000, 3000, 2000, 10000, { playbackRate: 2 });
    expect(toPropertyTime(it, 1500)).toBe(3000); expect(toTimelineMs(it, 3000)).toBe(1500);
    expect(toTimelineMs(it, toPropertyTime(it, 2750))).toBeCloseTo(2750, 9);
  });
  it('a start trim moves the clip window over the keyframes: keyframes sit on the trim axis, not on the clip start', () => {
    const it = video('v', 'V1', 1000, 3000, 2000, 10000, { properties: { opacity: prop([kf(0, 0), kf(4000, 1)], 1) } });
    expect(valueAt(it, 'opacity', 0)).toBeCloseTo(0.5, 9); expect(valueAt(it, 'opacity', 1000)).toBeCloseTo(0.75, 9);
    const untrimmed = video('v', 'V1', 1000, 3000, 0, 10000, { properties: { opacity: prop([kf(0, 0), kf(4000, 1)], 1) } });
    expect(valueAt(untrimmed, 'opacity', 0)).toBe(0); // same keyframes, different trim window
  });
  it('time remap does not move property time (§38: the remap only picks the frame)', () => {
    const remap = { defaultValue: 0, keyframes: [kf(0, 0), kf(2000, 8000)] };
    const it = video('v', 'V1', 0, 2000, 0, 10000, { timeRemap: remap, properties: { opacity: prop([kf(0, 0), kf(2000, 1)], 1) } });
    expect(valueAt(it, 'opacity', 1000)).toBeCloseTo(0.5, 9);
  });
  it('a missing property reads the registry default', () => { expect(valueAt(video('v', 'V1', 0, 1000), 'opacity', 100)).toBe(1); });

  it('source time without remap = trim.from + t × rate, clamped to 0 … source duration', () => {
    const it = video('v', 'V1', 0, 4000, 1000, 5000, { playbackRate: 2 });
    expect(sourceTime(it, 500)).toBe(2000); expect(sourceTime(it, 3000)).toBe(5000); // 1000 + 6000 → clamped to the 5000 source
    expect(sourceTime(video('v', 'V1', 0, 1000, 0, 5000, { playbackRate: 0 }), 400)).toBe(400);
  });
  it('source time with remap = the curve at ITEM-LOCAL time in source ms (trim and rate ignored), clamped to the source', () => {
    const remap = { defaultValue: 0, keyframes: [kf(0, 0), kf(4000, 8000)] };
    const it = video('v', 'V1', 0, 4000, 3000, 10000, { playbackRate: 3, timeRemap: remap });
    expect(sourceTime(it, 1000)).toBe(2000);
    const over = video('v', 'V1', 0, 4000, 0, 10000, { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(4000, 12000)] } });
    expect(sourceTime(over, 4000)).toBe(10000); expect(sourceTime(over, 3000)).toBe(9000);
  });
  it('speed = 1 ms forward difference, magnitude clamped to 1/16 … 16', () => {
    expect(speedAt(video('v', 'V1', 0, 4000, 0, 10000, { playbackRate: 2 }), 1000)).toBeCloseTo(2, 9);
    const fast = video('v', 'V1', 0, 4000, 0, 100000, { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(1000, 40000)] } });
    expect(speedAt(fast, 100)).toBe(16);
    const slow = video('v', 'V1', 0, 4000, 0, 10000, { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(4000, 40)] } });
    expect(speedAt(slow, 100)).toBe(1 / 16);
    const reverse = video('v', 'V1', 0, 4000, 0, 10000, { timeRemap: { defaultValue: 0, keyframes: [kf(0, 8000), kf(4000, 0)] } });
    expect(speedAt(reverse, 1000)).toBeCloseTo(-2, 9); // reverse playback is a negative slope
  });

  const g02 = (keyframes: K[], source = 10000) => video('v', 'V1', 0, 10000, 0, source, { timeRemap: { defaultValue: 0, keyframes } });
  it('speed range, G-02 curve (0 s → 0 ms easeInOut, 5 s → 8,000 ms bezier [0.25,0.1,0.25,1], 10 s → 2,000 ms): 0.000×–2.759×', () => {
    const it = g02([kf(0, 0, 'easeInOut'), kf(5000, 8000, { type: 'bezier', points: [0.25, 0.1, 0.25, 1] }), kf(10000, 2000)]);
    expect(speedRange(it, 10000)).toEqual({ min: 0, max: 2.759 });
  });
  it('speed range, G-02 merged curve (5 s keyframe → 8,500 ms linear): 0.001×–2.931×', () => {
    expect(speedRange(g02([kf(0, 0, 'easeInOut'), kf(5000, 8500, 'linear'), kf(10000, 2000)]), 10000)).toEqual({ min: 0.001, max: 2.931 });
  });
  it('speed range, G-02 value beyond the source (provisional keyframes 0 → 0, 10 s → 12,000 ms linear): 0.000×–1.200×, the clamped tail has speed 0', () => {
    expect(speedRange(g02([kf(0, 0), kf(10000, 12000)]), 10000)).toEqual({ min: 0, max: 1.2 });
  });
});

describe('T04 keyframes block (agent tool results §2 viewItemDetails, §6 G-02)', () => {
  it('no keyframes → { keyframes: null, keyframesNote: "No keyframes on this item" }', () => {
    expect(keyframesBlock(video('v', 'V1', 0, 1000))).toEqual({ keyframes: null, keyframesNote: 'No keyframes on this item' });
    expect(keyframesBlock(video('v', 'V1', 0, 1000, 0, 10000, { properties: { opacity: prop([], 0.5) } })).keyframes).toBeNull(); // a bare static value lists nothing
  });
  it('lists keyframed properties in STORED order (not sorted; findings part 2 §41 l.569–571) in absolute timeline seconds: display.from + (propertyTime − trim.from) / rate; defaultValue; count; stored easing; handles', () => {
    const it = video('v', 'V1', 1000, 5000, 2000, 10000, { properties: {
      opacity: prop([kf(4000, 1), kf(2000, 0, 'easeInOut', { outHandle: [0.25, 0.1] })], 1),
      scale: prop([], 1),
    } });
    expect(keyframesBlock(it)).toEqual({ keyframes: { opacity: { defaultValue: 1, keyframeCount: 2, keyframes: [
      { timelineSeconds: 3, value: 1, easing: 'linear' }, { timelineSeconds: 1, value: 0, easing: 'easeInOut', outHandle: [0.25, 0.1] }] } } });
  });
  it('evaluate on an unsorted stored list gives the same values as on the sorted list (readers sort; findings part 2 §38, §41)', () => {
    const stored = [kf(4000, 1), kf(0, 0, 'easeInOut'), kf(2000, 0.25, 'easeOut'), kf(3000, 'x')], sortedList = [...stored].sort((a, b) => a.time - b.time);
    for (let t = -500; t <= 4500; t += 125) { expect(evaluate(stored, 7, t), `t=${t}`).toEqual(evaluate(sortedList, 7, t)); const o = oracle(sortedList, 7, t), got = evaluate(stored, 7, t); if (typeof o === 'number') expect(got as number, `oracle t=${t}`).toBeCloseTo(o, 9); else expect(got, `oracle t=${t}`).toEqual(o); }
  });
  it('rate 2: timeline seconds halve the property-time distance', () => {
    const it = video('v', 'V1', 0, 2000, 0, 10000, { playbackRate: 2, properties: { opacity: prop([kf(0, 0), kf(4000, 1)], 1) } });
    expect(keyframesBlock(it).keyframes!.opacity.keyframes.map(k => k.timelineSeconds)).toEqual([0, 2]);
  });
  it('the time-remap curve is listed under keyframes.timeRemap: item-local time + display.from in seconds, values in source ms', () => {
    const it = video('v', 'V1', 2000, 7000, 0, 10000, { timeRemap: { defaultValue: 0, keyframes: [kf(0, 0, 'easeInOut'), kf(5000, 8000)] } });
    expect(keyframesBlock(it)).toEqual({ keyframes: { timeRemap: { defaultValue: 0, keyframeCount: 2, keyframes: [
      { timelineSeconds: 2, value: 0, easing: 'easeInOut' }, { timelineSeconds: 7, value: 8000, easing: 'linear' }] } } });
  });
});

describe('T04 keyframe ids (findings part 2 §38: kf_<epoch ms>_<9 chars>)', () => {
  it('has the shape kf_<Date.now()>_<9 characters>', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-23T08:00:00.000Z'));
    expect(keyframeId()).toMatch(/^kf_1792742400000_.{9}$/);
  });
});
