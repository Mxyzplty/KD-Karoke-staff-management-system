// SPDX-License-Identifier: AGPL-3.0-only
// T09 D39 pre-encode alpha method (frozen 9 Nov, D39 method artifact §2–§4). Word coefficient a from the actual production
// pre-encode RGBA J over black, against an independent native coverage reference P (white glyph, opacity 1, opaque black) and
// the transparent native alpha M. Exact rationals only: L = max(0,J−1)/min(255,P+1), U = min(255,J+1)/max(0,P−1),
// â = mean((L+U)/2), u = mean((U−L)/2), pass iff |â − a_expected| + u ≤ 1/100. Guard failures are a METHOD-VALIDITY red,
// kept apart from an alpha-predicate red; every row is kept either way. Pure: imported by the unit test and the UI specs.
export type Rat = { n: bigint; d: bigint };
export type Rgb = readonly [number, number, number];
export type Row = { at: number; J: number; P: number; M: number };
export type MeasuredRow = Row & { L?: Rat; U?: Rat };
export type Status = 'pass' | 'D39_METHOD_VALIDITY_RED' | 'D39_ALPHA_PREDICATE_RED';
export type Input = {
  label: string;
  /** Named factors of a_expected (1_visible, o_item·o_mode from wordState, o_whole); multiplied as exact binary rationals. */
  expected: Record<string, number>;
  /** Declared paint and backdrop bytes; the channel is chosen from these before any output is read. */
  foreground: Rgb; background: Rgb;
  /** Support must hold strictly more rows than this (the existing minimum counts). */
  minCount: number;
  rows: Row[];
  /** Independently fixed background-only pixels of the same actual frame. */
  backgroundRows: { at: number; rgba: readonly number[] }[];
  /** Face, context and geometry premises of the native reference and of the actual export; every key must agree. */
  identity: { reference: Record<string, unknown>; actual: Record<string, unknown> };
};
export type Measurement = {
  label: string; status: Status; reasons: string[]; channel?: 0 | 1 | 2; count: number;
  expected: Record<string, number>; expectedExact?: Rat; rows: MeasuredRow[];
  mean?: Rat; radius?: Rat; error?: Rat;
};

const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
export const rat = (n: bigint, d = 1n): Rat => {
  if (d === 0n) throw new Error('zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n; return { n: n / g, d: d / g };
};
const add = (a: Rat, b: Rat) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Rat, b: Rat) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Rat, b: Rat) => rat(a.n * b.n, a.d * b.d);
const abs = (a: Rat) => (a.n < 0n ? rat(-a.n, a.d) : a);
export const cmp = (a: Rat, b: Rat) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
export const BOUND = rat(1n, 100n);
/** Presentation only: evidence decimals never feed a verdict. */
export const decimal = (a: Rat) => Number(a.n) / Number(a.d);
export const text = (a: Rat | undefined) => (a ? `${a.n}/${a.d}` : undefined);

/** The exact binary rational of a finite Number (no rounding to a friendlier decimal). */
export function exact(x: number): Rat {
  if (!Number.isFinite(x)) throw new Error(`not finite: ${x}`);
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, x);
  const bits = view.getBigUint64(0), field = Number((bits >> 52n) & 0x7ffn), frac = bits & ((1n << 52n) - 1n);
  const m = field === 0 ? frac : frac | (1n << 52n), e = field === 0 ? -1074 : field - 1075, n = bits >> 63n ? -m : m;
  return e >= 0 ? rat(n << BigInt(e)) : rat(n, 1n << BigInt(-e));
}

/** Greatest declared |F − B|, tie order R, G, B. */
export function selectChannel(F: Rgb, B: Rgb): 0 | 1 | 2 {
  let best: 0 | 1 | 2 = 0;
  for (const c of [1, 2] as const) if (Math.abs(F[c] - B[c]) > Math.abs(F[best] - B[best])) best = c;
  return best;
}

const isByte = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;
/** ±1 LSB on both readings, intersected with the physical 0…255 range; undefined when G⁻ = 0 (not identifiable). */
export function interval(J: number, P: number): { L: Rat; U: Rat } | undefined {
  if (!isByte(J) || !isByte(P)) throw new Error(`not a byte: J=${J} P=${P}`);
  if (P - 1 <= 0) return undefined;
  return { L: rat(BigInt(Math.max(0, J - 1)), BigInt(Math.min(255, P + 1))), U: rat(BigInt(Math.min(255, J + 1)), BigInt(P - 1)) };
}

export function alphaPredicate(mean: Rat, radius: Rat, expected: number | Rat) {
  const error = add(abs(sub(mean, typeof expected === 'number' ? exact(expected) : expected)), radius);
  return { error, pass: cmp(error, BOUND) <= 0 };
}

export function measure(input: Input): Measurement {
  const reasons: string[] = [], rows: MeasuredRow[] = input.rows.map(r => ({ ...r }));
  const out: Measurement = { label: input.label, status: 'D39_METHOD_VALIDITY_RED', reasons, count: rows.length, expected: { ...input.expected }, rows };
  // Expected coefficient: exact product of finite named factors, inside the physical 0…1 range.
  const factors = Object.entries(input.expected);
  if (factors.some(([, v]) => !Number.isFinite(v))) reasons.push(`expected factor not finite: ${JSON.stringify(input.expected)}`);
  else {
    out.expectedExact = factors.reduce((p, [, v]) => mul(p, exact(v)), rat(1n));
    if (cmp(out.expectedExact, rat(0n)) < 0 || cmp(out.expectedExact, rat(1n)) > 0) reasons.push(`expected coefficient outside 0…1: ${text(out.expectedExact)}`);
  }
  // Domain: an opaque full-scale selected channel over black.
  const c = selectChannel(input.foreground, input.background); out.channel = c;
  if (![...input.foreground, ...input.background].every(isByte) || input.foreground[c] !== 255 || input.background[c] !== 0)
    reasons.push(`selected channel ${'RGB'[c]} is not full-scale over black: F=${input.foreground} B=${input.background}`);
  // Support and readings.
  if (!(rows.length > input.minCount)) reasons.push(`support has ${rows.length} rows, needs more than ${input.minCount}`);
  const seen = new Set<number>();
  for (const r of rows) {
    if (!Number.isInteger(r.at) || r.at < 0 || r.at % 4 !== 0 || seen.has(r.at)) reasons.push(`bad or duplicate RGBA offset ${r.at}`);
    seen.add(r.at);
    if (![r.J, r.P, r.M].every(isByte)) { reasons.push(`not a byte at ${r.at}: J=${r.J} P=${r.P} M=${r.M}`); continue; }
    if (Math.abs(r.P - r.M) > 2) reasons.push(`|P−M| = ${Math.abs(r.P - r.M)} > 2 at ${r.at}: P=${r.P} M=${r.M}`);
    const iv = interval(r.J, r.P);
    if (!iv) reasons.push(`not identifiable at ${r.at}: P=${r.P} gives G⁻ = 0`);
    else Object.assign(r, iv);
  }
  // Common coefficient: all intervals ∩ [0, 1] nonempty.
  const ivs = rows.filter((r): r is Required<MeasuredRow> => !!r.L && !!r.U);
  if (ivs.length === rows.length && rows.length) {
    const lo = ivs.reduce((m, r) => (cmp(r.L, m) > 0 ? r.L : m), rat(0n)), hi = ivs.reduce((m, r) => (cmp(r.U, m) < 0 ? r.U : m), rat(1n));
    if (cmp(lo, hi) > 0) reasons.push(`no common coefficient: max L = ${text(lo)} > min U = ${text(hi)} (with [0, 1])`);
  }
  // Background-only pixels: opaque black within 1 LSB.
  if (!input.backgroundRows.length) reasons.push('no background-only rows');
  const lit = input.backgroundRows.filter(({ rgba: [r, g, bl, a] }) => ![r, g, bl, a].every(isByte) || r > 1 || g > 1 || bl > 1 || a !== 255);
  if (lit.length) reasons.push(`background not black within 1 LSB at ${lit.length} of ${input.backgroundRows.length} rows: ${lit.slice(0, 8).map(b => `${b.at}=${b.rgba.join(',')}`).join(' ')}`);
  // Face, context and geometry premises.
  for (const key of new Set([...Object.keys(input.identity.reference), ...Object.keys(input.identity.actual)]))
    if (JSON.stringify(input.identity.reference[key]) !== JSON.stringify(input.identity.actual[key]))
      reasons.push(`identity mismatch ${key}: reference ${JSON.stringify(input.identity.reference[key])} actual ${JSON.stringify(input.identity.actual[key])}`);
  if (reasons.length) return out;
  const n = rat(BigInt(ivs.length));
  out.mean = mul(ivs.reduce((s, r) => add(s, add(r.L, r.U)), rat(0n)), rat(n.d, 2n * n.n));
  out.radius = mul(ivs.reduce((s, r) => add(s, sub(r.U, r.L)), rat(0n)), rat(n.d, 2n * n.n));
  const verdict = alphaPredicate(out.mean, out.radius, out.expectedExact!);
  out.error = verdict.error; out.status = verdict.pass ? 'pass' : 'D39_ALPHA_PREDICATE_RED';
  return out;
}

export class D39Red extends Error {
  constructor(readonly kind: Exclude<Status, 'pass'>, readonly measurement: Measurement) {
    super(`${kind} ${measurement.label}: ${kind === 'D39_ALPHA_PREDICATE_RED' ? `|â − a| + u = ${text(measurement.error)} ≈ ${decimal(measurement.error!)} > 1/100 (â ≈ ${decimal(measurement.mean!)}, u ≈ ${decimal(measurement.radius!)}, a = ${text(measurement.expectedExact)})` : measurement.reasons.slice(0, 8).join('; ')}`);
    this.name = kind;
  }
}
export function assertD39(m: Measurement) { if (m.status !== 'pass') throw new D39Red(m.status, m); }

/** JSON evidence of one measurement: every row, rationals as exact n/d text, decimals for presentation only. */
export const evidence = (m: Measurement) => ({
  ...m, expectedExact: text(m.expectedExact), mean: text(m.mean), radius: text(m.radius), error: text(m.error),
  decimals: m.mean ? { mean: decimal(m.mean), radius: decimal(m.radius!), error: decimal(m.error!), expected: decimal(m.expectedExact!) } : undefined,
  rows: m.rows.map(r => ({ at: r.at, J: r.J, P: r.P, M: r.M, L: text(r.L), U: text(r.U) })),
});

/** The separate decoded word-x predicate: both ink edges within ±1 px of the independent placement. */
export function xPredicate(actual: { x0: number; x1: number } | undefined, expected: { x0: number; x1: number }) {
  if (!actual) return { status: 'X_PREDICATE_RED' as const, reason: 'word ink not found' };
  const dx0 = actual.x0 - expected.x0, dx1 = actual.x1 - expected.x1;
  return { status: Math.abs(dx0) <= 1 && Math.abs(dx1) <= 1 ? 'pass' as const : 'X_PREDICATE_RED' as const, dx0, dx1 };
}
