// SPDX-License-Identifier: AGPL-3.0-only
// T13 curve compiler and gain law. Oracles:
//   "evaluate oracle"   = timeline/properties.ts evaluate (the T04 reference the compiled curve must equal)
//   "written-spec"      = T13 ticket "Gain law" + findings §29 / §40 + agent tool results §10 (G-09)
import { describe, it, expect } from 'vitest';
import { compileCurve } from '../apps/web/src/audio/curve';
import { audibleTrackGain, clipGain, isHidden } from '../apps/web/src/audio/gain';
import { mixFrames } from '../apps/web/src/audio/mix';
import { renderAudio } from '../apps/web/src/audio/stage';
import { evaluate } from '../apps/web/src/timeline/properties';
import { EASINGS } from '../apps/web/src/timeline/properties';
import { FS, db, kf, mkClip, mkDoc, mkTrack, rms, sine, synthSource, volume } from './t13-support';

describe('compileCurve equals evaluate (evaluate oracle)', () => {
  const times = (k: { time: number }[]) => {
    const ts = k.map(f => f.time), lo = Math.min(...ts), hi = Math.max(...ts), out = new Set<number>([lo - 500, lo - 1, lo, hi, hi + 1, hi + 700]);
    for (const t of ts) { out.add(t); out.add(t + 0.5); out.add(t - 0.5); }
    for (let t = lo; t <= hi; t += (hi - lo) / 97 || 1) out.add(t);
    return [...out];
  };
  const sets: Record<string, ReturnType<typeof kf>[]> = {
    'linear two': [kf(0, 0), kf(1000, 1)],
    'easeInOut 0→1→0.3': [kf(0, 0, 'easeInOut'), kf(1000, 1, 'easeInOut'), kf(2000, 0.3, 'easeInOut')],
    'every easing, one segment each': EASINGS.map((e, i) => kf(i * 400, i % 2 ? 0.2 : 1.7, e)).concat(kf(EASINGS.length * 400, 0.5)),
    'bezier object easing': [kf(100, 0.1, { type: 'bezier', points: [0.2, 0.8, 0.9, 0.1] }), kf(900, 2.5)],
    'out handle only': [kf(0, 0, 'easeIn', { outHandle: [0.3, 0.9] }), kf(1000, 3)],
    'in handle only': [kf(0, 1), kf(1000, 0, 'linear', { inHandle: [0.7, 0.2] })],
    'both handles, mid keyframe': [kf(0, 0, 'easeOut', { outHandle: [0.1, 0.6] }), kf(500, 2, 'linear', { inHandle: [0.8, 0.9], outHandle: [0.4, 0] }), kf(1500, 1, 'easeInOutCubic', { inHandle: [0.5, 1.3] })],
    'hold (same value)': [kf(0, 1), kf(500, 1), kf(1000, 0.25)],
    'single keyframe': [kf(300, 0.7)],
    'unsorted input': [kf(2000, 0.3, 'easeInOut'), kf(0, 0, 'easeInOut'), kf(1000, 1, 'easeOut')],
    'trim-axis times (large, offset)': [kf(40000, 0.2, 'easeInOutQuad'), kf(46000, 1.4, 'easeInOutQuad'), kf(52000, 0.1)],
    'negative values': [kf(0, -1, 'easeInOutCubic'), kf(1000, 1)],
  };
  for (const [name, k] of Object.entries(sets)) {
    it(name, () => {
      const f = compileCurve(k, 0.9), ts = times(k);
      for (const t of ts) expect(f(t), `t=${t}`).toBeCloseTo(evaluate(k, 0.9, t) as number, 9);
      // random-order reads must not depend on the segment cursor
      const shuffled = [...ts].sort((a, b) => Math.sin(a * 12.9898) - Math.sin(b * 78.233));
      for (const t of shuffled) expect(f(t), `shuffled t=${t}`).toBeCloseTo(evaluate(k, 0.9, t) as number, 9);
      for (const t of [...ts].sort((a, b) => b - a)) expect(f(t), `descending t=${t}`).toBeCloseTo(evaluate(k, 0.9, t) as number, 9);
    });
  }
  it('no keyframes: the fallback everywhere', () => {
    expect(compileCurve(undefined, 0.4)(123)).toBe(0.4);
    expect(compileCurve([], 0.4)(-5)).toBe(0.4);
  });
  it('holds the first value before and the last after (written-spec: T04 §38)', () => {
    const f = compileCurve([kf(100, 0.2), kf(200, 0.8)], 1);
    expect(f(-1e6)).toBe(0.2); expect(f(100)).toBe(0.2); expect(f(200)).toBe(0.8); expect(f(1e6)).toBe(0.8);
  });
  it('a non-numeric value reads as the fallback (documented in curve.ts)', () => {
    const f = compileCurve([kf(0, 'x'), kf(1000, 1)], 0.6);
    expect(f(0)).toBe(0.6); expect(f(500)).toBe(0.6); expect(f(1000)).toBe(1);
  });
});

describe('track gain and hidden rules (written-spec: findings §29)', () => {
  const g = (tracks: Record<string, unknown>[], id: string, groups: Record<string, any> = {}, layerOrder?: any) => audibleTrackGain(mkDoc(tracks.map(t => mkTrack(String(t.id), t)), [], groups, layerOrder), id);
  it('plain track volume, clamped to 0…1', () => {
    expect(g([{ id: 'a', volume: 0.5 }], 'a')).toBe(0.5);
    expect(g([{ id: 'a', volume: 3 }], 'a')).toBe(1);
    expect(g([{ id: 'a', volume: -2 }], 'a')).toBe(0);
  });
  it('mute → 0; any solo excludes the others; a soloed track plays', () => {
    expect(g([{ id: 'a', muted: true }], 'a')).toBe(0);
    const t = [{ id: 'a', solo: true, volume: 0.5 }, { id: 'b' }, { id: 'c', solo: true }];
    expect(g(t, 'a')).toBe(0.5); expect(g(t, 'b')).toBe(0); expect(g(t, 'c')).toBe(1);
    expect(g([{ id: 'a', solo: true, muted: true }, { id: 'b' }], 'a'), 'muted and soloed').toBe(0);
  });
  it('hidden track → 0, also when soloed', () => {
    expect(g([{ id: 'a', hidden: true }], 'a')).toBe(0);
    expect(g([{ id: 'a', hidden: true, solo: true }], 'a')).toBe(0);
  });
  it('a track in a hidden group (any depth) is silent; a visible group is not', () => {
    const groups = { g1: { id: 'g1', hidden: false, children: [{ type: 'track', id: 'a' }, { type: 'group', id: 'g2' }] }, g2: { id: 'g2', hidden: true, children: [{ type: 'track', id: 'b' }] } };
    const layerOrder = [{ type: 'group', id: 'g1' }];
    const doc = mkDoc([mkTrack('a'), mkTrack('b')], [], groups, layerOrder as any);
    expect(isHidden(doc, 'a')).toBe(false); expect(isHidden(doc, 'b')).toBe(true);
    expect(audibleTrackGain(doc, 'a')).toBe(1); expect(audibleTrackGain(doc, 'b')).toBe(0);
  });
  it('an unknown track has gain 0', () => { expect(g([{ id: 'a' }], 'nope')).toBe(0); });
});

describe('clipGain, default mode (written-spec: gain = track × volume², eased, at property time)', () => {
  const clipDoc = (itemExtra: Record<string, unknown>, trackExtra: Record<string, unknown> = {}) => {
    const t = mkTrack('a', trackExtra), c = mkClip('c', 'a', 1000, 3000, itemExtra);
    return { doc: mkDoc([t], [c]), c };
  };
  it('static volume squared', () => {
    const { doc, c } = clipDoc({ properties: volume(0.5) });
    expect(clipGain(doc, c, 'default', 0, 4000)(1500)).toBeCloseTo(0.25, 12);
  });
  it('no volume property → unity', () => {
    const { doc, c } = clipDoc({});
    expect(clipGain(doc, c, 'default', 0, 4000)(2000)).toBe(1);
  });
  it('linear keyframes: gain = (t/T)²', () => {
    const { doc, c } = clipDoc({ properties: volume(1, [kf(0, 0), kf(2000, 1)]) });
    const f = clipGain(doc, c, 'default', 0, 4000);
    expect(f(1000)).toBeCloseTo(0, 12); expect(f(2000)).toBeCloseTo(0.25, 12); expect(f(3000)).toBeCloseTo(1, 12);
    expect(f(1500)).toBeCloseTo(0.0625, 12);
  });
  it('easeInOut is kept (symmetric curve: the midpoint 0.5 → gain 0.25, not the linear-export value)', () => {
    const { doc, c } = clipDoc({ properties: volume(1, [kf(0, 0, 'easeInOut'), kf(2000, 1, 'easeInOut')]) });
    const f = clipGain(doc, c, 'default', 0, 4000);
    expect(f(2000)).toBeCloseTo(0.25, 6);
    // easeInOut at x = 0.25 is below 0.25 (slow start), so gain < (0.25)² of the linear law
    expect(f(1500)).toBeLessThan(0.0625);
  });
  it('track gain multiplies', () => {
    const { doc, c } = clipDoc({ properties: volume(0.5) }, { volume: 0.5 });
    expect(clipGain(doc, c, 'default', 0, 4000)(2000)).toBeCloseTo(0.5 * 0.25, 12);
  });
  it('keyframes read at property time: trim.from + local × rate', () => {
    // display 1000…3000, trim 500, rate 2: local 250 ms → property 500 + 500 = 1000 ms
    const { doc, c } = clipDoc({ trim: { from: 500 }, playbackRate: 2, properties: volume(1, [kf(500, 0), kf(1500, 1)]) });
    const f = clipGain(doc, c, 'default', 0, 4000);
    expect(f(1250)).toBeCloseTo(0.25, 12);
    expect(f(1000)).toBeCloseTo(0, 12);
  });
  it('applies on time-remapped clips too (documented improvement)', () => {
    const { doc, c } = clipDoc({ properties: volume(1, [kf(0, 0), kf(2000, 1)]), timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(2000, 4000)] } });
    expect(clipGain(doc, c, 'default', 0, 4000)(2000)).toBeCloseTo(0.25, 12);
  });
  it('zero track gain → exactly 0 even with keyframes', () => {
    const { doc, c } = clipDoc({ properties: volume(1, [kf(0, 1), kf(2000, 1)]) }, { muted: true });
    expect(clipGain(doc, c, 'default', 0, 4000)(2000)).toBe(0);
  });
});

describe('clipGain, parity mode (written-spec: Xapp export events, findings §7 / §40)', () => {
  const t = mkTrack('a');
  const clip = (extra: Record<string, unknown> = {}, from = 0, to = 1000) => mkClip('c', 'a', from, to, extra);
  const eased = [kf(0, 0.5, 'easeInOut'), kf(400, 1, 'easeInOut'), kf(800, 0.3, 'easeInOut')];
  it('linear ramps between squared values; easing ignored; held after the last', () => {
    const c = clip({ properties: volume(1, eased) }), f = clipGain(mkDoc([t], [c]), c, 'parity', 0, 1000);
    expect(f(0)).toBeCloseTo(0.25, 12);
    expect(f(200)).toBeCloseTo((0.25 + 1) / 2, 12);
    expect(f(400)).toBeCloseTo(1, 12);
    expect(f(600)).toBeCloseTo((1 + 0.09) / 2, 12);
    expect(f(800)).toBeCloseTo(0.09, 12);
    expect(f(950)).toBeCloseTo(0.09, 12);
  });
  it('0 → 1 → 0.3 curve: ramps are linear in the squared value (G-09: eased law would give −33.76 dB at burst 1, parity is −37.22)', () => {
    // §10: predicted −37.22 dB for burst 1 under the linear ramp. A ramp 0 → 1 over 1000 ms with bursts at 0.5 s steps cannot be
    // rebuilt (layout unknown), but the law itself: value² at the ramp's 10 % point is linear in time between the squared endpoints.
    const c = clip({ properties: volume(1, [kf(0, 0, 'easeInOut'), kf(1000, 1, 'easeInOut')]) }), f = clipGain(mkDoc([t], [c]), c, 'parity', 0, 1000);
    expect(f(100)).toBeCloseTo(0.1, 12); // linear between 0² and 1² (the eased value² would be (≈0.07)²)
    expect(f(500)).toBeCloseTo(0.5, 12);
  });
  it('keyframes outside [from, to] are skipped; the first keyframe still sets the start value²', () => {
    const c = clip({ properties: volume(1, eased) }), f = clipGain(mkDoc([t], [c]), c, 'parity', 500, 1000);
    expect(f(500)).toBeCloseTo(0.25, 12); // first keyframe value² (0.5²), though its time is outside
    expect(f(650)).toBeCloseTo((0.25 + 0.09) / 2, 12); // ramps to the in-range 800 ms keyframe only
    expect(f(800)).toBeCloseTo(0.09, 12);
  });
  it('keyframes on the range edges count (inclusive)', () => {
    const c = clip({ properties: volume(1, eased) }), f = clipGain(mkDoc([t], [c]), c, 'parity', 400, 800);
    // a keyframe at the range start is a zero-length ramp (the value at exactly that instant is not specified: skipped)
    expect(f(400.5)).toBeCloseTo(1 + (0.09 - 1) * 0.5 / 400, 9); expect(f(600)).toBeCloseTo((1 + 0.09) / 2, 12); expect(f(800)).toBeCloseTo(0.09, 12);
  });
  it('a clip starting after the range start begins at its own start', () => {
    const c = clip({ properties: volume(1, [kf(0, 0.5), kf(500, 1)]) }, 300, 1000), f = clipGain(mkDoc([t], [c]), c, 'parity', 0, 1000);
    expect(f(300)).toBeCloseTo(0.25, 12); expect(f(550)).toBeCloseTo((0.25 + 1) / 2, 12); expect(f(800)).toBeCloseTo(1, 12);
  });
  it('keyframe times map through trim and rate to timeline ms', () => {
    // display 0…1000, trim 400, rate 2: property time 400 → timeline 0, property 1400 → timeline 500
    const c = clip({ trim: { from: 400 }, playbackRate: 2, properties: volume(1, [kf(400, 0), kf(1400, 1)]) }), f = clipGain(mkDoc([t], [c]), c, 'parity', 0, 1000);
    expect(f(250)).toBeCloseTo(0.5, 12); expect(f(500)).toBeCloseTo(1, 12);
  });
  it('track volume scales every value', () => {
    const tr = mkTrack('a', { volume: 0.5 }), c = clip({ properties: volume(1, [kf(0, 0), kf(1000, 1)]) }), f = clipGain(mkDoc([tr], [c]), c, 'parity', 0, 1000);
    expect(f(500)).toBeCloseTo(0.5 * 0.5, 12);
  });
  it('a time-remapped clip plays its static volume² and ignores its keyframes', () => {
    const c = clip({ properties: volume(0.6, [kf(0, 0), kf(1000, 1)]), timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(1000, 2000)] } }), f = clipGain(mkDoc([t], [c]), c, 'parity', 0, 1000);
    expect(f(0)).toBeCloseTo(0.36, 12); expect(f(700)).toBeCloseTo(0.36, 12);
  });
  it('without keyframes the static value² (also in parity)', () => {
    const c = clip({ properties: volume(0.5) }); expect(clipGain(mkDoc([t], [c]), c, 'parity', 0, 1000)(500)).toBeCloseTo(0.25, 12);
  });
});

// ---- G-09 formula values: measured on a full-scale 1 kHz tone through the mix (no limiter) so the oracle is the gain law.
describe('G-09 gain-law values through the mix (written-spec: agent tool results §10)', () => {
  const N = FS; // 1 s = 1000 whole periods
  const level = async (trackVolume: number, itemVolume: number, mode: 'default' | 'parity') => {
    const c = mkClip('c', 'a', 0, 1000, { properties: volume(itemVolume) }), doc = mkDoc([mkTrack('a', { volume: trackVolume })], [c]);
    const [L, R] = await mixFrames(doc, 0, N, { source: synthSource({ c: sine(1000, 1) }, 2), mode });
    return { L, R, db: db(rms(L)) };
  };
  const ref = db(1 / Math.SQRT2);
  for (const mode of ['default', 'parity'] as const) {
    it(`${mode}: volume 0.5 → −12.04 dB`, async () => { expect((await level(1, 0.5, mode)).db - ref).toBeCloseTo(-12.04, 1); });
    it(`${mode}: track volume 0.5 → −6.03 dB`, async () => { expect((await level(0.5, 1, mode)).db - ref).toBeCloseTo(-6.03, 1); });
    it(`${mode}: both → −18.08 dB`, async () => { expect((await level(0.5, 0.5, mode)).db - ref).toBeCloseTo(-18.08, 1); });
  }
  it('unity gain is the identity (full-scale tone untouched, both channels)', async () => {
    const r = await level(1, 1, 'default');
    expect(db(rms(r.L)) - ref).toBeCloseTo(0, 5); expect(rms(r.R)).toBeCloseTo(rms(r.L), 9);
  });
});

describe('mute / solo / hidden give digital silence in the mix (written-spec: G-09, findings §29)', () => {
  const src = synthSource({ ok: sine(1000, 0.5), m: sine(1000, 0.5), ms: sine(1000, 0.5), ns: sine(1000, 0.5), hs: sine(1000, 0.5), hg: sine(1000, 0.5) }, 2);
  const mk = () => mkDoc(
    [mkTrack('ok', { solo: true }), mkTrack('m', { muted: true }), mkTrack('ms', { muted: true, solo: true }), mkTrack('ns'), mkTrack('hs', { hidden: true, solo: true }), mkTrack('hg')],
    ['ok', 'm', 'ms', 'ns', 'hs', 'hg'].map(t => mkClip(t, t, 0, 1000)),
    { g: { id: 'g', hidden: true, children: [{ type: 'track', id: 'hg' }] } },
    [{ type: 'track', id: 'ok' }, { type: 'track', id: 'm' }, { type: 'track', id: 'ms' }, { type: 'track', id: 'ns' }, { type: 'track', id: 'hs' }, { type: 'group', id: 'g' }] as any);
  it('only the soloed, visible, unmuted track is heard', async () => {
    const full = await renderAudio({ doc: mk(), fromMs: 0, toMs: 1000, source: src });
    const only = mkDoc([mkTrack('ok', { solo: true })], [mkClip('ok', 'ok', 0, 1000)]);
    const alone = await renderAudio({ doc: only, fromMs: 0, toMs: 1000, source: src });
    expect(Array.from(full.channels[0])).toEqual(Array.from(alone.channels[0]));
    expect(rms(full.channels[0])).toBeGreaterThan(0.3);
  });
  for (const [name, edit] of [
    ['muted', (d: any) => { d.tracks.find((t: any) => t.id === 'ok').muted = true; }],
    ['soloed but hidden', (d: any) => { d.tracks.find((t: any) => t.id === 'ok').hidden = true; }],
  ] as const) {
    it(`${name} → every sample is exactly 0`, async () => {
      const d = mk(); edit(d);
      const out = await renderAudio({ doc: d, fromMs: 0, toMs: 1000, source: src });
      expect(peak0(out.channels[0])).toBe(0); expect(peak0(out.channels[1])).toBe(0);
    });
  }
  it('with no solo, the not-soloed rule is off: a plain track plays', async () => {
    const d = mkDoc([mkTrack('ns')], [mkClip('ns', 'ns', 0, 1000)]);
    expect(rms((await renderAudio({ doc: d, fromMs: 0, toMs: 1000, source: src })).channels[0])).toBeGreaterThan(0.3);
  });
  it('a track in a hidden group → exact silence', async () => {
    const d = mkDoc([mkTrack('hg')], [mkClip('hg', 'hg', 0, 1000)], { g: { id: 'g', hidden: true, children: [{ type: 'track', id: 'hg' }] } }, [{ type: 'group', id: 'g' }] as any);
    const out = await renderAudio({ doc: d, fromMs: 0, toMs: 1000, source: src });
    expect(peak0(out.channels[0])).toBe(0);
  });
});
const peak0 = (x: Float32Array) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; };
