// SPDX-License-Identifier: AGPL-3.0-only
// T05 text animations (findings §14; part 5 §56): the stored config, timing models and base durations, the curve
// primitives, the duration presets' key tables, and the per-grapheme presets (typewriter, scramble, step-fade). Pure: no
// DOM. Times are ms; c is animation time, q progress.
import { fail } from '../timeline/model';

/** The 14 presets in the Animation grid's order (part 3 §46.7), which is also the agent enum's order. */
export const PRESETS = ['none', 'typewriter', 'scramble', 'pop', 'jump', 'fade', 'zoom', 'flicker', 'loud', 'fall', 'speedy', 'stamped', 'step-fade', 'slide-right'] as const;
export type Preset = typeof PRESETS[number];
export const PRESET_LABELS: Record<Preset, string> = {
  none: 'None', typewriter: 'Typewriter', scramble: 'Scramble', pop: 'Pop', jump: 'Jump', fade: 'Fade', zoom: 'Zoom', flicker: 'Flicker', loud: 'Loud',
  fall: 'Fall', speedy: 'Speedy', stamped: 'Stamped', 'step-fade': 'Step Fade', 'slide-right': 'Slide Right',
};
/** §56.2: presets timed per grapheme; `durationMs` is refused on these. */
export const PER_GRAPHEME: ReadonlySet<string> = new Set(['typewriter', 'scramble', 'step-fade']);
/** §56.2 base durations T of the duration presets (ms at speed 1). */
export const BASE_MS: Record<string, number> = { pop: 650, jump: 700, fade: 400, zoom: 450, flicker: 650, loud: 720, fall: 760, speedy: 780, stamped: 520, 'slide-right': 500 };
/** The stored config (§56.1). `speed` is stored only when ≠ 1, `durationMs` only when the agent gave a positive one. */
export type TextAnimation = { version: 1; preset: Preset; speed?: number; durationMs?: number };
export const SPEED = { min: 0.25, max: 4, step: 0.25 };
export const MAX_DURATION_MS = 10000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v: number) => clamp(v, 0, 1);
const isPreset = (v: unknown): v is Preset => (PRESETS as readonly unknown[]).includes(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- §56.1 graphemes: Unicode extended grapheme clusters; spaces and line breaks count.
let segmenter: Intl.Segmenter | null = null;
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), s => s.segment);
}

// ---- §56.1 the stored config as the renderer reads it: an unknown preset is none; a non-number speed is 1, else clamped.
export type AnimationConfig = { preset: Preset; speed: number; durationMs: number | null };
export function readAnimation(v: unknown): AnimationConfig {
  const o = typeof v === 'string' ? { preset: v } : isObj(v) ? v : {};
  const preset = isPreset(o.preset) ? o.preset : 'none', s = o.speed;
  const speed = typeof s === 'number' && Number.isFinite(s) ? clamp(s, SPEED.min, SPEED.max) : 1, d = o.durationMs;
  return { preset, speed, durationMs: typeof d === 'number' && d > 0 && Number.isFinite(d) && BASE_MS[preset] !== undefined ? d : null };
}
/** The stored form of a choice (Animation grid, Speed slider): `speed` written only when ≠ 1 (W3-RT-02). */
export function storedAnimation(preset: Preset, speed = 1, durationMs?: number): TextAnimation {
  return { version: 1, preset, ...speed !== 1 ? { speed } : {}, ...durationMs ? { durationMs } : {} };
}
/** Agent validation (§56.1; results §2 addText): the enum or {preset, speed?, durationMs?}. Refusals are
 *  INVALID_TEXT_ANIMATION, `error` "Invalid text animation", `message` the reason. Returns the stored config. */
export function checkAnimation(v: unknown): TextAnimation {
  const bad = (message: string): never => fail('INVALID_TEXT_ANIMATION', 'Invalid text animation', { message });
  const o = typeof v === 'string' ? { preset: v } : isObj(v) ? v : bad(`textAnimation must be a preset name or {preset, speed?, durationMs?}. Received: ${JSON.stringify(v)}.`);
  if (!isPreset(o.preset)) bad(`'${String(o.preset)}' is not a text animation. Use one of: ${PRESETS.join(', ')}.`);
  const preset = o.preset as Preset, extra = Object.keys(o).filter(k => !['preset', 'speed', 'durationMs', 'version'].includes(k));
  if (extra.length) bad(`Unknown textAnimation key(s): ${extra.join(', ')}. Use preset, speed and durationMs.`);
  if (o.speed !== undefined && !(typeof o.speed === 'number' && o.speed >= SPEED.min && o.speed <= SPEED.max))
    bad(`speed must be a number from ${SPEED.min} to ${SPEED.max} (1 = normal). Received: ${JSON.stringify(o.speed)}.`);
  if (o.durationMs !== undefined) {
    if (PER_GRAPHEME.has(preset)) bad(`durationMs applies only to whole-item presets. ${preset} is timed per character (${preset === 'step-fade' ? '240 ms each, 55 ms apart' : `${preset === 'typewriter' ? 70 : 50} ms per character`}), so use speed to make it faster or slower.`);
    if (preset === 'none') bad('durationMs has no effect on the preset none.');
    if (!(typeof o.durationMs === 'number' && o.durationMs >= 0 && o.durationMs <= MAX_DURATION_MS)) bad(`durationMs must be a number from 0 to ${MAX_DURATION_MS}. Received: ${JSON.stringify(o.durationMs)}.`);
  }
  // durationMs 0 is accepted and means "use the default" (§56.1): it is not stored.
  return storedAnimation(preset, (o.speed as number | undefined) ?? 1, (o.durationMs as number | undefined) || undefined);
}

// ---- §56.2 timing: T, then c = min(τ·speed, T) and q = c / T (1 when T = 0).
export function baseDuration(cfg: AnimationConfig, n: number): number {
  switch (cfg.preset) {
    case 'none': return 0;
    case 'typewriter': return 70 * n;
    case 'scramble': return 50 * n;
    case 'step-fade': return n === 0 ? 0 : 240 + 55 * (n - 1);
    default: return cfg.durationMs ?? BASE_MS[cfg.preset];
  }
}
/** τ = ms since the item's timeline start (trim ignored, so a split piece replays). Real duration = T / speed. */
export function animationTime(cfg: AnimationConfig, tau: number, n: number): { c: number; T: number; q: number } {
  const T = baseDuration(cfg, n), c = Math.min(Math.max(0, tau) * cfg.speed, T);
  return { c, T, q: T > 0 ? c / T : 1 };
}

// ---- §56.4 curve primitives.
const smooth = (x: number) => x * x * (3 - 2 * x);
export const outCubic = (x: number) => 1 - (1 - x) ** 3;
type Keys = readonly (readonly [number, number])[];
/** Smooth keys: smoothstep per segment (zero slope at every key); a zero-length segment jumps; past the last key, the last value. */
export function smoothKeys(keys: Keys, q: number): number {
  if (q <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [q0, v0] = keys[i - 1], [q1, v1] = keys[i];
    if (q > q1) continue;
    return q1 - q0 > 0 ? v0 + (v1 - v0) * smooth((q - q0) / (q1 - q0)) : v1;
  }
  return keys[keys.length - 1][1];
}
/** Hold keys: the value of the last key with qi ≤ q. */
export function holdKeys(keys: Keys, q: number): number {
  let v = keys[0][1];
  for (const [qi, vi] of keys) if (qi <= q) v = vi;
  return v;
}
export const ramp = (n: number, q: number) => clamp01(n * q);

// ---- §56.5 duration presets. Channels: scale k, translate (tx, ty) as fractions of the rendered box, rotation r°,
// horizontal skew σ°, opacity o. Unlisted channels stay at identity.
export type Channels = { k: number; tx: number; ty: number; r: number; skew: number; o: number };
export const IDENTITY_CHANNELS: Channels = { k: 1, tx: 0, ty: 0, r: 0, skew: 0, o: 1 };
type Table = Partial<Record<keyof Channels, (q: number) => number>>;
const sk = (keys: Keys) => (q: number) => smoothKeys(keys, q);
export const KEY_TABLES: Record<string, Table> = {
  pop: { k: sk([[0, 0.45], [0.34, 1.18], [0.54, 0.91], [0.72, 1.07], [0.86, 0.97], [1, 1]]), o: q => ramp(5, q) },
  jump: {
    ty: sk([[0, 0.22], [0.24, -0.15], [0.44, -0.30], [0.68, 0.04], [0.84, -0.018], [1, 0]]),
    r: sk([[0, 0], [0.24, -8], [0.44, 7], [0.68, -3], [0.84, 1.2], [1, 0]]),
    k: sk([[0, 0.94], [0.24, 1.03], [0.68, 0.98], [1, 1]]), o: q => ramp(5, q),
  },
  fade: { o: outCubic },
  zoom: { k: q => 0.65 + 0.35 * outCubic(q), o: q => ramp(2, q) },
  flicker: { o: q => holdKeys([[0, 0], [0.12, 0.72], [0.20, 0.08], [0.31, 0.90], [0.42, 0.18], [0.53, 1], [0.61, 0.42], [0.70, 1], [0.77, 0.68], [0.84, 1]], q) },
  loud: {
    k: sk([[0, 0.55], [0.20, 1.30], [0.38, 1.12], [0.54, 1.18], [0.70, 1.05], [0.84, 1.02], [1, 1]]),
    tx: sk([[0, 0], [0.32, 0], [0.42, -0.035], [0.52, 0.032], [0.62, -0.022], [0.72, 0.014], [0.84, -0.006], [1, 0]]),
    ty: sk([[0, 0], [0.42, 0.012], [0.52, -0.010], [0.62, 0.008], [0.72, -0.005], [1, 0]]),
    r: sk([[0, 0], [0.32, 0], [0.42, -4], [0.52, 3.5], [0.62, -2.5], [0.72, 1.6], [0.84, -0.7], [1, 0]]), o: q => ramp(5, q),
  },
  fall: { ty: sk([[0, -0.58], [0.46, 0.10], [0.64, -0.075], [0.80, 0.032], [0.91, -0.010], [1, 0]]), k: sk([[0, 1], [0.46, 0.96], [0.64, 1.025], [0.80, 0.99], [1, 1]]), o: q => ramp(5, q) },
  speedy: {
    tx: sk([[0, 0.72], [0.43, -0.055], [0.60, 0.034], [0.74, -0.018], [0.87, 0.007], [1, 0]]),
    r: sk([[0, 0], [0.43, -3.5], [0.60, 2.3], [0.74, -1.3], [0.87, 0.5], [1, 0]]),
    skew: sk([[0, -16], [0.43, -9], [0.60, 4], [0.74, -2.2], [0.87, 0.8], [1, 0]]), o: q => ramp(6, q),
  },
  stamped: { k: sk([[0, 2.6], [0.42, 0.84], [0.62, 1.10], [0.78, 0.96], [0.90, 1.025], [1, 1]]), o: q => ramp(6, q) },
  'slide-right': { tx: q => 0.35 * (outCubic(q) - 1), o: q => ramp(2, q) },
};
/** The whole-item channels at progress q (identity for none and the per-grapheme presets). */
export function channels(preset: Preset, q: number): Channels {
  const table = KEY_TABLES[preset], out = { ...IDENTITY_CHANNELS };
  if (table) for (const k of Object.keys(table) as (keyof Channels)[]) out[k] = table[k]!(q);
  return out;
}

// ---- §56.6 per-grapheme presets. Layout is computed on the full final text; hidden or changed graphemes keep their place.
/** typewriter: graphemes visible at animation time c (n = min(N, floor(c / 70))). */
export const typewriterCount = (c: number, n: number) => Math.min(n, Math.floor(c / 70 + 1e-9));
/** step-fade, grapheme i: opacity e and the drop below rest as a fraction of the item box height. */
export function stepFade(c: number, i: number): { o: number; drop: number } {
  const e = outCubic(clamp01((c - 55 * i) / 240));
  return { o: e, drop: 0.22 * (1 - e) };
}
/** Scramble seed: 32-bit FNV-1a over the text's code points (captions: the words joined by single spaces). */
export function scrambleSeed(text: string): number {
  let h = 2166136261 | 0;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h;
}
const LOWER = 'abcdefghijklmnopqrstuvwxyz', DIGITS = '0123456789', UPPER = LOWER.toUpperCase();
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
/** The pool a grapheme scrambles through: a–z if it holds one, else digits, else A–Z; null = never replaced. */
export function scramblePool(g: string): string | null {
  if (!LETTER_OR_NUMBER.test(g)) return null;
  return /[a-z]/.test(g) ? LOWER : /[0-9]/.test(g) ? DIGITS : UPPER;
}
/** scramble, grapheme i at animation time c: the real grapheme once resolved (c ≥ 50·(i + 1)), else the stand-in of tick
 *  floor(c / 45). All arithmetic on 32-bit integers (§56.6 steps 1–3). */
export function scrambleChar(seed: number, g: string, i: number, c: number): string {
  const pool = scramblePool(g);
  if (!pool || c >= 50 * (i + 1) - 1e-9) return g;
  const j = Math.floor(c / 45 + 1e-9), x = Math.imul(seed ^ Math.imul(i + 1, 2654435761 | 0) ^ Math.imul(j, 1597334677), 16777619);
  return pool[(x >>> 0) % pool.length];
}
/** The whole scrambled string at animation time c (test vectors §56.6). */
export const scrambled = (text: string, c: number) => { const seed = scrambleSeed(text); return graphemes(text).map((g, i) => scrambleChar(seed, g, i, c)).join(''); };

/** What a text item shows at item-local ms τ: the whole-item channels plus the per-grapheme state the drawer needs. */
export type TextAnimationState = { preset: Preset; c: number; T: number; q: number; channels: Channels; n: number };
export function animationState(config: unknown, tau: number, text: string): TextAnimationState {
  const cfg = readAnimation(config), n = graphemes(text).length, { c, T, q } = animationTime(cfg, tau, n);
  return { preset: cfg.preset, c, T, q, channels: channels(cfg.preset, q), n };
}
