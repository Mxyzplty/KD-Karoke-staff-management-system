// SPDX-License-Identifier: AGPL-3.0-only
// Text animations (findings part 5 §56): clock, duration presets, per-grapheme presets. Values only, no glyphs.
import { clamp, smooth } from './math';

export type TextAnimation = { version: 1; preset: string; speed?: number; durationMs?: number };
// Translate is in fractions of the rendered box (+y down); rotation and skew in degrees.
export type Channels = { scale: number; tx: number; ty: number; rotation: number; skew: number; opacity: number };
export const IDENTITY: Channels = { scale: 1, tx: 0, ty: 0, rotation: 0, skew: 0, opacity: 1 };
export const PER_GRAPHEME = ['typewriter', 'scramble', 'step-fade'];
export const PRESET_MS: Record<string, number> = { pop: 650, jump: 700, fade: 400, zoom: 450, flicker: 650, loud: 720, fall: 760, speedy: 780, stamped: 520, 'slide-right': 500 };
const outCubic = (x: number) => 1 - (1 - clamp(x)) ** 3;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text: string) => Array.from(segmenter.segment(text), s => s.segment);

// §56.1 config, agent validation (reason wording is ours; Xapp's text and codes are not in the spec).
export const speedOf = (a: { speed?: unknown }) => typeof a.speed === 'number' ? clamp(a.speed, .25, 4) : 1;
export function validateTextAnimation(a: { preset?: unknown; speed?: unknown; durationMs?: unknown }): string | null {
  if (a.speed !== undefined && !(typeof a.speed === 'number' && a.speed >= .25 && a.speed <= 4)) return 'speed must be between 0.25 and 4';
  if (a.durationMs === undefined) return null;
  if (!(typeof a.preset === 'string' && Object.hasOwn(PRESET_MS, a.preset))) return `durationMs applies only to duration presets; ${String(a.preset)} times itself from the text`;
  return typeof a.durationMs === 'number' && a.durationMs >= 0 && a.durationMs <= 10000 ? null : 'durationMs must be between 0 and 10000';
}

// §56.2 base duration T (animation ms); N = grapheme count. durationMs > 0 replaces T on duration presets.
export function baseDurationMs(a: TextAnimation, graphemeCount = 0) {
  const n = graphemeCount;
  if (a.preset === 'typewriter') return 70 * n;
  if (a.preset === 'scramble') return 50 * n;
  if (a.preset === 'step-fade') return n ? 240 + 55 * (n - 1) : 0;
  if (!Object.hasOwn(PRESET_MS, a.preset)) return 0;
  return typeof a.durationMs === 'number' && a.durationMs > 0 ? a.durationMs : PRESET_MS[a.preset];
}
// τ = item-local ms (trim ignored). c = min(τ × speed, T), q = c / T (1 when T = 0), real length T / speed.
export function animationClock(a: TextAnimation, tauMs: number, graphemeCount = 0) {
  const T = baseDurationMs(a, graphemeCount), speed = speedOf(a), c = Math.min(tauMs * speed, T);
  return { T, c, q: T === 0 ? 1 : c / T, realMs: T / speed };
}

// §56.4 curve primitives. Keys [(q, v)…] with q0 = 0, smoothstep per segment, last value after the last key.
export type Keys = [number, number][];
export function smoothKeys(keys: Keys, q: number) {
  for (let i = 1; i < keys.length; i++) if (q <= keys[i][0]) {
    const [q0, v0] = keys[i - 1], [q1, v1] = keys[i];
    return q1 > q0 ? v0 + (v1 - v0) * smooth(0, 1, (q - q0) / (q1 - q0)) : v1;
  }
  return keys[keys.length - 1][1];
}
export function holdKeys(keys: Keys, q: number) { let v = keys[0][1]; for (const [k, value] of keys) if (k <= q) v = value; return v; }
export const ramp = (n: number, q: number) => clamp(n * q);

// §56.5 key tables (q as fraction of T).
const K = (...v: number[]): Keys => Array.from({ length: v.length / 2 }, (_, i) => [v[2 * i], v[2 * i + 1]]);
const T_ = {
  popScale: K(0, .45, .34, 1.18, .54, .91, .72, 1.07, .86, .97, 1, 1),
  jumpTy: K(0, .22, .24, -.15, .44, -.30, .68, .04, .84, -.018, 1, 0), jumpRot: K(0, 0, .24, -8, .44, 7, .68, -3, .84, 1.2, 1, 0), jumpScale: K(0, .94, .24, 1.03, .68, .98, 1, 1),
  flicker: K(0, 0, .12, .72, .20, .08, .31, .90, .42, .18, .53, 1, .61, .42, .70, 1, .77, .68, .84, 1),
  loudScale: K(0, .55, .20, 1.30, .38, 1.12, .54, 1.18, .70, 1.05, .84, 1.02, 1, 1),
  loudTx: K(0, 0, .32, 0, .42, -.035, .52, .032, .62, -.022, .72, .014, .84, -.006, 1, 0),
  loudTy: K(0, 0, .42, .012, .52, -.010, .62, .008, .72, -.005, 1, 0),
  loudRot: K(0, 0, .32, 0, .42, -4, .52, 3.5, .62, -2.5, .72, 1.6, .84, -.7, 1, 0),
  fallTy: K(0, -.58, .46, .10, .64, -.075, .80, .032, .91, -.010, 1, 0), fallScale: K(0, 1, .46, .96, .64, 1.025, .80, .99, 1, 1),
  speedyTx: K(0, .72, .43, -.055, .60, .034, .74, -.018, .87, .007, 1, 0), speedyRot: K(0, 0, .43, -3.5, .60, 2.3, .74, -1.3, .87, .5, 1, 0), speedySkew: K(0, -16, .43, -9, .60, 4, .74, -2.2, .87, .8, 1, 0),
  stampedScale: K(0, 2.6, .42, .84, .62, 1.10, .78, .96, .90, 1.025, 1, 1),
};
const PRESETS: Record<string, (q: number) => Partial<Channels>> = {
  pop: q => ({ scale: smoothKeys(T_.popScale, q), opacity: ramp(5, q) }),
  jump: q => ({ ty: smoothKeys(T_.jumpTy, q), rotation: smoothKeys(T_.jumpRot, q), scale: smoothKeys(T_.jumpScale, q), opacity: ramp(5, q) }),
  fade: q => ({ opacity: outCubic(q) }),
  zoom: q => ({ scale: .65 + .35 * outCubic(q), opacity: ramp(2, q) }),
  flicker: q => ({ opacity: holdKeys(T_.flicker, q) }),
  loud: q => ({ scale: smoothKeys(T_.loudScale, q), tx: smoothKeys(T_.loudTx, q), ty: smoothKeys(T_.loudTy, q), rotation: smoothKeys(T_.loudRot, q), opacity: ramp(5, q) }),
  fall: q => ({ ty: smoothKeys(T_.fallTy, q), scale: smoothKeys(T_.fallScale, q), opacity: ramp(5, q) }),
  speedy: q => ({ tx: smoothKeys(T_.speedyTx, q), rotation: smoothKeys(T_.speedyRot, q), skew: smoothKeys(T_.speedySkew, q), opacity: ramp(6, q) }),
  stamped: q => ({ scale: smoothKeys(T_.stampedScale, q), opacity: ramp(6, q) }),
  'slide-right': q => ({ tx: .35 * (outCubic(q) - 1), opacity: ramp(2, q) }),
};
// Whole-box channels at item-local τ (identity for none and the per-grapheme presets).
export const textChannels = (a: TextAnimation, tauMs: number): Channels => ({ ...IDENTITY, ...(Object.hasOwn(PRESETS, a.preset) ? PRESETS[a.preset](animationClock(a, tauMs).q) : {}) });

// §56.3 apply the channels to the item. (x, y) = top-left of the rendered box w × h; k about the box centre.
export type TextBox = { x: number; y: number; width: number; height: number; scaleX: number; scaleY: number; rotation: number; skewX: number; opacity: number };
export function applyTextChannels(item: TextBox, ch: Channels): TextBox {
  const w = Math.abs(item.width * item.scaleX), h = Math.abs(item.height * item.scaleY);
  return { ...item, x: item.x + w * (1 - ch.scale) / 2 + ch.tx * w, y: item.y + h * (1 - ch.scale) / 2 + ch.ty * h, scaleX: item.scaleX * ch.scale, scaleY: item.scaleY * ch.scale, rotation: item.rotation + ch.rotation, skewX: item.skewX + ch.skew, opacity: item.opacity * ch.opacity };
}

// §56.6 per-grapheme presets; layout stays on the full final text.
export const typewriterCount = (c: number, n: number) => Math.min(n, Math.floor(c / 70));
// 32-bit FNV-1a over code points; returned as signed 32-bit.
export function scrambleSeed(text: string) { let h = 2166136261 | 0; for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619); return h; }
const POOLS = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
// Grapheme i (0-based) at animation time c; resolves at c = 50(i + 1). Text transform is applied later, at draw.
export function scrambleGrapheme(g: string, i: number, c: number, seed: number) {
  if (c >= 50 * (i + 1) || !/[\p{L}\p{N}]/u.test(g)) return g;
  const pool = /[a-z]/.test(g) ? POOLS[0] : /[0-9]/.test(g) ? POOLS[1] : POOLS[2];
  const x = Math.imul(seed ^ Math.imul(i + 1, 2654435761) ^ Math.imul(Math.floor(c / 45), 1597334677), 16777619) >>> 0;
  return pool[x % pool.length];
}
// drop is a fraction of the item box height h (below rest, +y down).
export const stepFade = (c: number, i: number) => { const e = outCubic((c - 55 * i) / 240); return { opacity: e, drop: .22 * (1 - e) }; };
export type GraphemeState = { grapheme: string; shown: string; visible: boolean; opacity: number; drop: number };
// For captions pass the words joined by single spaces (seed text and global grapheme indices).
export function graphemeStates(a: TextAnimation, text: string, tauMs: number): GraphemeState[] {
  const g = graphemes(text), { c } = animationClock(a, tauMs, g.length), seed = scrambleSeed(text), n = typewriterCount(c, g.length);
  return g.map((grapheme, i) => ({
    grapheme, shown: a.preset === 'scramble' ? scrambleGrapheme(grapheme, i, c, seed) : grapheme, visible: a.preset !== 'typewriter' || i < n,
    ...(a.preset === 'step-fade' ? stepFade(c, i) : { opacity: 1, drop: 0 }),
  }));
}
