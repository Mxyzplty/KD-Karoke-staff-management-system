// SPDX-License-Identifier: AGPL-3.0-only
// T09 D39 pre-encode alpha method (frozen 9 Nov, method §2–§4): the exact interval estimator in tests/ui/t09-alpha-measurement.ts.
// Oracle: the written source-over model C = a·g over black with ±1 LSB readings, worked through by hand here (true coefficient,
// true coverage, rounded bytes), not the helper's own outputs. Checks the containment and uncertainty claims, the analytic endpoints,
// the false-acceptance risk (0.05 control) and every fail-closed guard, which must give a METHOD-VALIDITY red apart from an alpha red.
import { describe, expect, it } from 'vitest';
import { alphaPredicate, assertD39, BOUND, cmp, D39Red, exact, interval, measure, rat, selectChannel, xPredicate } from './ui/t09-alpha-measurement';
import type { Input, Rat, Row } from './ui/t09-alpha-measurement';

const R = (n: number | bigint, d: number | bigint = 1) => rat(BigInt(n), BigInt(d));
const le = (a: Rat, b: Rat) => cmp(a, b) <= 0;
// Half-up rounding of a non-negative rational to an integer byte (a reading within ±1/2 LSB, inside the ±1 model).
const round = (x: Rat) => Number((2n * x.n + x.d) / (2n * x.d));
const black = { at: 0, rgba: [0, 0, 0, 255] };
const identity = { reference: { face: 'Roboto 700 loaded', colorSpace: 'srgb', size: '320x180' }, actual: { face: 'Roboto 700 loaded', colorSpace: 'srgb', size: '320x180' } };
const rows = (pairs: [J: number, P: number][]): Row[] => pairs.map(([J, P], i) => ({ at: 4 * (1000 + i), J, P, M: P }));
const input = (r: Row[], expected: Record<string, number> = { visible: 1 }, extra: Partial<Input> = {}): Input =>
  ({ label: 'unit', expected, foreground: [255, 255, 255], background: [0, 0, 0], minCount: 0, rows: r, backgroundRows: [black], identity, ...extra });
// Readings of a word whose true coefficient is a, at true coverage bytes P (rounded readings of a·P).
const readings = (a: Rat, ps: number[]) => rows(ps.map(P => [round({ n: a.n * BigInt(P), d: a.d }), P]));
const PS = [249, 250, 251, 252, 253, 254, 255];

describe('D39 interval estimator: exact endpoints and quantization', () => {
  it('P = J = 255 gives exactly [254/255, 255/254] and passes against 1 with error 1/254', () => {
    expect(interval(255, 255)).toEqual({ L: R(254, 255), U: R(255, 254) });
    const m = measure(input(rows([[255, 255]])));
    expect(m.status).toBe('pass');
    expect(m.error).toEqual(R(1, 254));
    expect(le(R(1, 254), BOUND)).toBe(true);
  });
  it('P = 255, J = 0 gives exactly [0, 1/254] and passes against 0 with error 1/254', () => {
    expect(interval(0, 255)).toEqual({ L: R(0), U: R(1, 254) });
    const m = measure(input(rows([[0, 255]]), { visible: 0 }));
    expect(m.status).toBe('pass');
    expect(m.error).toEqual(R(1, 254));
  });
  it('endpoints are the physical 0…255 channel range intersected with ±1 LSB, no clamp of the coefficient', () => {
    expect(interval(0, 2)).toEqual({ L: R(0), U: R(1, 1) });
    expect(interval(255, 254)).toEqual({ L: R(254, 255), U: R(255, 253) });
    expect(interval(128, 100)).toEqual({ L: R(127, 101), U: R(129, 99) });
    // An interval above 1 is kept as it is (no clamp to 1).
    expect(cmp(interval(255, 200)!.L, R(1))).toBe(1);
  });
  it('the unchanged oracle Number is used as its exact binary rational', () => {
    expect(exact(0.1)).toEqual(R(3602879701896397n, 36028797018963968n));
    expect(exact(0.95)).toEqual(R(4278419646001971n, 4503599627370496n));
    expect(exact(1)).toEqual(R(1));
    expect(exact(0)).toEqual(R(0));
    expect(exact(2 ** -1074)).toEqual(R(1n, 2n ** 1074n));
  });
  it('the predicate is |mean − expected| + radius ≤ 1/100 exactly, with no epsilon', () => {
    expect(alphaPredicate(R(101, 200), R(1, 200), 0.5).pass).toBe(true);
    expect(alphaPredicate(R(101, 200), R(1, 200), 0.5).error).toEqual(R(1, 100));
    expect(alphaPredicate({ n: 101n * 10n ** 30n + 1n, d: 200n * 10n ** 30n }, R(1, 200), 0.5).pass).toBe(false);
    expect(alphaPredicate(R(99, 200), R(1, 200), 0.5).pass).toBe(true);
    expect(alphaPredicate(R(99, 200), { n: 10n ** 30n + 1n, d: 200n * 10n ** 30n }, 0.5).pass).toBe(false);
  });
  it('the statistic is the unweighted mean of interval centres and half-widths over all rows', () => {
    const m = measure(input(rows([[255, 255], [254, 253], [250, 251]])));
    const iv = [interval(255, 255)!, interval(254, 253)!, interval(250, 251)!];
    const sum = (f: (i: { L: Rat; U: Rat }) => bigint[]) => iv.reduce((s, i) => { const [n, d] = f(i); return { n: s.n * d + n * s.d, d: s.d * d }; }, { n: 0n, d: 1n });
    const centres = sum(i => [i.L.n * i.U.d + i.U.n * i.L.d, 2n * i.L.d * i.U.d]);
    const radii = sum(i => [i.U.n * i.L.d - i.L.n * i.U.d, 2n * i.L.d * i.U.d]);
    expect(cmp(m.mean!, { n: centres.n, d: centres.d * 3n })).toBe(0);
    expect(cmp(m.radius!, { n: radii.n, d: radii.d * 3n })).toBe(0);
    expect(m.rows).toHaveLength(3);
  });
});

describe('D39 model claims (containment, uncertainty, false acceptance)', () => {
  it('every interval contains the true coefficient when both readings are within ±1 LSB of the truth', () => {
    // True coverage byte g255 = m/10 over 248.6…255, true coefficient a = k/1000; readings are the rounded true values.
    for (let m = 2486; m <= 2550; m += 4) for (let k = 0; k <= 1000; k += 7) {
      const g = R(m, 10), a = R(k, 1000), P = round(g), J = round({ n: a.n * g.n, d: a.d * g.d }), iv = interval(J, P)!;
      expect(le(iv.L, a) && le(a, iv.U), `m=${m} k=${k} J=${J} P=${P}`).toBe(true);
    }
  });
  it('with P ≥ 249 and J ≤ P + 2 the half-width is at most 2/(P − 1) ≤ 2/248 < 0.0081 (method §4)', () => {
    for (const P of PS) for (let J = 0; J <= Math.min(255, P + 2); J++) {
      const { L, U } = interval(J, P)!, half = { n: U.n * L.d - L.n * U.d, d: 2n * U.d * L.d };
      expect(le(half, R(2, P - 1)), `J=${J} P=${P}`).toBe(true);
      expect(le(half, R(81, 10000))).toBe(true);
    }
  });
  it('an actual 0.05 coefficient change (0.95 against expected 1) fails the alpha predicate specifically', () => {
    const m = measure(input(readings(R(95, 100), [...PS, ...PS, ...PS])));
    expect(m.status).toBe('D39_ALPHA_PREDICATE_RED');
    expect(m.reasons).toEqual([]);
    expect(le(R(5, 100), m.error!)).toBe(true);
    expect(() => assertD39(m)).toThrow(/D39_ALPHA_PREDICATE_RED/);
  });
  it('no true coefficient more than 1/100 from the expected value is ever accepted', () => {
    for (const e of [0, 0.3, 0.5, 0.95, 1]) for (let k = 0; k <= 200; k++) {
      const a = R(k, 200), d = cmp(a, exact(e)) >= 0 ? { n: a.n * exact(e).d - exact(e).n * a.d, d: a.d * exact(e).d } : { n: exact(e).n * a.d - a.n * exact(e).d, d: a.d * exact(e).d };
      const m = measure(input(readings(a, PS), { visible: 1, item: e }));
      if (cmp(d, BOUND) > 0) expect(m.status, `a=${k}/200 e=${e}`).toBe('D39_ALPHA_PREDICATE_RED');
      else expect(m.status).not.toBe('D39_METHOD_VALIDITY_RED');
    }
    // Just outside the bound: a = e ± 101/10000 (inside 0…1) must still fail.
    for (const e of [0, 0.3, 0.5, 0.95, 1]) for (const s of [-1n, 1n]) {
      const x = exact(e), a = rat(x.n * 10000n + s * 101n * x.d, x.d * 10000n);
      if (cmp(a, R(0)) < 0 || cmp(a, R(1)) > 0) continue;
      expect(measure(input(readings(a, PS), { visible: 1, item: e })).status, `e=${e} s=${s}`).toBe('D39_ALPHA_PREDICATE_RED');
    }
  });
  it('the expected coefficient is the exact product of its named factors', () => {
    const m = measure(input(readings(R(1, 4), PS), { visible: 1, item: 0.5, whole: 0.5 }));
    expect(m.expectedExact).toEqual(R(1, 4));
    expect(m.status).toBe('pass');
  });
});

describe('D39 fail-closed guards: METHOD-VALIDITY red, every row kept', () => {
  const validity = (i: Input, reason: RegExp) => {
    const m = measure(i);
    expect(m.status).toBe('D39_METHOD_VALIDITY_RED');
    expect(m.reasons.join('\n')).toMatch(reason);
    expect(m.rows).toHaveLength(i.rows.length);
    expect(m.mean).toBeUndefined();
    expect(() => assertD39(m)).toThrow(/D39_METHOD_VALIDITY_RED/);
    try { assertD39(m); } catch (e) { expect(e).toBeInstanceOf(D39Red); expect((e as D39Red).kind).toBe('D39_METHOD_VALIDITY_RED'); expect((e as D39Red).measurement).toBe(m); }
    return m;
  };
  it('empty or too-small support is a failing measurement, never a skipped row', () => {
    validity(input([]), /support/);
    validity(input(rows([[255, 255], [255, 255]]), { visible: 1 }, { minCount: 2 }), /support/);
  });
  it('missing or non-byte readings are refused', () => {
    validity(input([{ at: 4000, J: 255, P: Number.NaN, M: 255 }]), /byte/);
    validity(input([{ at: 4000, J: 254.5, P: 255, M: 255 }]), /byte/);
    validity(input([{ at: 4000, J: 256, P: 255, M: 255 }]), /byte/);
    validity(input([{ at: 4000, J: 255, P: 255, M: undefined as unknown as number }]), /byte/);
  });
  it('duplicate or non-RGBA offsets are refused', () => {
    validity(input([{ at: 4000, J: 255, P: 255, M: 255 }, { at: 4000, J: 255, P: 255, M: 255 }]), /offset/);
    validity(input([{ at: 4001, J: 255, P: 255, M: 255 }]), /offset/);
  });
  it('|P − M| > 2 (contradictory references) is a validity red even when the alpha would pass', () => {
    const m = validity(input([...rows([[255, 255]]), { at: 8000, J: 252, P: 252, M: 255 }]), /\|P−M\|/);
    expect(m.rows.map(r => [r.J, r.P, r.M])).toEqual([[255, 255, 255], [252, 252, 255]]);
    expect(measure(input([{ at: 8000, J: 253, P: 253, M: 255 }])).status).toBe('pass');
  });
  it('an empty common-coefficient intersection is a validity red, not an alpha verdict', () => {
    validity(input(rows([[255, 255], [100, 255]])), /common/);
    // Every interval above 1: the intersection with the physical range [0, 1] is empty.
    validity(input(rows([[255, 200], [255, 201]])), /common/);
  });
  it('non-identifiable inputs are refused: reference coverage ≤ 1 LSB, no full-scale channel over black', () => {
    validity(input([{ at: 4000, J: 0, P: 1, M: 1 }]), /identifiable/);
    validity(input(rows([[255, 255]]), { visible: 1 }, { foreground: [200, 200, 200] }), /full-scale/);
    validity(input(rows([[255, 255]]), { visible: 1 }, { background: [10, 0, 0], foreground: [255, 0, 0] }), /full-scale/);
    validity(input(rows([[255, 255]]), { visible: Number.NaN }), /expected/);
    validity(input(rows([[255, 255]]), { visible: 1, item: 1.5 }), /expected/);
  });
  it('background-only regions must be opaque black within 1 LSB', () => {
    expect(measure(input(rows([[255, 255]]), { visible: 1 }, { backgroundRows: [{ at: 0, rgba: [1, 1, 1, 255] }] })).status).toBe('pass');
    validity(input(rows([[255, 255]]), { visible: 1 }, { backgroundRows: [{ at: 0, rgba: [2, 0, 0, 255] }] }), /background/);
    validity(input(rows([[255, 255]]), { visible: 1 }, { backgroundRows: [{ at: 0, rgba: [0, 0, 0, 254] }] }), /background/);
    validity(input(rows([[255, 255]]), { visible: 1 }, { backgroundRows: [] }), /background/);
  });
  it('face, context or geometry mismatch between reference and actual is a validity red', () => {
    validity(input(rows([[255, 255]]), { visible: 1 }, { identity: { reference: identity.reference, actual: { ...identity.actual, face: 'sans-serif fallback' } } }), /face/);
    validity(input(rows([[255, 255]]), { visible: 1 }, { identity: { reference: identity.reference, actual: { ...identity.actual, size: '640x360' } } }), /size/);
    validity(input(rows([[255, 255]]), { visible: 1 }, { identity: { reference: identity.reference, actual: { face: 'Roboto 700 loaded', colorSpace: 'srgb' } } }), /size/);
  });
});

describe('D39 channel selection and the separate x predicate', () => {
  it('selects the channel of greatest declared contrast with fixed R, G, B tie order', () => {
    expect(selectChannel([255, 255, 255], [0, 0, 0])).toBe(0);
    expect(selectChannel([255, 230, 0], [0, 0, 0])).toBe(0);
    expect(selectChannel([0, 255, 0], [0, 0, 0])).toBe(1);
    expect(selectChannel([0, 255, 255], [0, 0, 0])).toBe(1);
    expect(selectChannel([0, 0, 255], [0, 0, 0])).toBe(2);
  });
  it('word x is within ±1 px on both edges; a 3 px shift or a missing word fails it', () => {
    expect(xPredicate({ x0: 101, x1: 172 }, { x0: 100, x1: 173 }).status).toBe('pass');
    expect(xPredicate({ x0: 103, x1: 175 }, { x0: 100, x1: 172 }).status).toBe('X_PREDICATE_RED');
    expect(xPredicate({ x0: 100, x1: 174 }, { x0: 100, x1: 172 }).status).toBe('X_PREDICATE_RED');
    expect(xPredicate(undefined, { x0: 100, x1: 172 }).status).toBe('X_PREDICATE_RED');
  });
});
