// SPDX-License-Identifier: AGPL-3.0-only
// T04 property model (findings (C).md:38; part 2 §38, §40): the per-type registry in stored units, the 15 easing curves,
// keyframe evaluation, the item clocks (property time, source time, speed) and the agent-facing keyframes block.
// Stored animatable value: `{defaultValue, keyframes[{id, time, value, easing, inHandle?, outHandle?}]}`; property
// keyframe times sit on the trim axis (ms), time-remap keyframe times on the item-local axis (ms).
import type { RecordData } from '../store/model';
import { newId } from './model';

export type Handle = [number, number];
export type Easing = string | { type: 'bezier'; points: [number, number, number, number] };
export type Keyframe = { id: string; time: number; value: unknown; easing: Easing; inHandle?: Handle; outHandle?: Handle };
export type Prop = { defaultValue: unknown; keyframes: Keyframe[] };
/** One keyframe as the UI addresses it; key 'timeRemap' names the time-remap curve; `effect` (a stored effect instance id,
 *  T10) makes `key` that effect's parameter. */
export type KeyframeRef = { itemId: string; key: string; keyframeId: string; effect?: string };
/** A UI keyframe edit: time in stored ms (trim axis; item-local for the remap curve); null removes a handle. */
export type KeyframePatch = { time?: number; value?: number; easing?: Easing; inHandle?: Handle | null; outHandle?: Handle | null };

// ---- Registry (§40). Display units are UI labels only (a UI showing 100 % stores 1).
export type Spec = { default: unknown; anim: boolean; min?: number; max?: number; unit?: '%' | '°' | 'px' };
const anim = (d: number, min?: number, max?: number, unit?: Spec['unit']): Spec => ({ default: d, anim: true, min, max, unit });
const fixed = (d: unknown, min?: number): Spec => ({ default: d, anim: false, min });
const COMMON = { opacity: anim(1, 0, 1, '%'), scale: anim(1, 0, 100), rotation: anim(0, -360, 360, '°'), positionX: anim(0, undefined, undefined, 'px'), positionY: anim(0, undefined, undefined, 'px'), flipX: fixed(false), flipY: fixed(false) };
const SIZE = { width: anim(0, 0, undefined, 'px'), height: anim(0, 0, undefined, 'px') };
const STYLE = { blur: anim(0, 0, 50, 'px'), borderRadius: anim(0, 0, 500, 'px'), borderWidth: anim(0, 0, 20, 'px'), borderColor: fixed('#000000'), boxShadow: fixed({ color: 'transparent', x: 0, y: 0, blur: 0 }) };
const LAYER = { zIndex: fixed(0), blendMode: fixed('normal') };
const VOLUME = { volume: anim(1, 0, 3, '%') };
const BORDER = { borderWidth: anim(0, 0, 20, 'px') };
// Text and caption style keys (font, colour, alignment …) belong to T05 / T09 and are not listed here.
export const REGISTRY: Record<string, Record<string, Spec>> = {
  video: { ...COMMON, ...SIZE, ...STYLE, ...LAYER, ...VOLUME },
  image: { ...COMMON, ...SIZE, ...STYLE, ...LAYER },
  audio: { ...VOLUME },
  text: { ...COMMON, width: fixed(0, 0), height: fixed(0, 0), ...BORDER, ...LAYER },
  shape: { ...COMMON, width: fixed(0, 0), height: fixed(0, 0), ...LAYER, fillOpacity: anim(1, 0, 1), fillColor: fixed('#3b82f6'), strokeWidth: anim(0, 0, 50, 'px'), strokeColor: fixed('none'), strokeOpacity: anim(1, 0, 1) },
  motionGraphic: { ...COMMON, ...SIZE, ...STYLE, ...LAYER, brightness: anim(1, 0, 2, '%') },
  caption: { ...COMMON, width: fixed(800, 0), height: fixed(100, 0), ...BORDER, ...LAYER },
  layout: { ...SIZE, ...LAYER },
};
/** playbackRate and timeRemap are item fields (not under `properties`): rate 0.1–4 on video/audio, not animatable. */
export const RATE = { default: 1, min: 0.1, max: 4 };
export const REMAP_TYPES = new Set(['video', 'audio']);
export const specOf = (type: string, key: string): Spec | undefined => REGISTRY[type]?.[key];
/** Every item property writeKeyframes accepts (contracts writeKeyframes "Item properties (15)"). */
export const KEYFRAME_PROPERTIES = ['opacity', 'scale', 'rotation', 'positionX', 'positionY', 'width', 'height', 'blur', 'brightness', 'borderRadius', 'borderWidth', 'volume', 'fillOpacity', 'strokeWidth', 'strokeOpacity'];

// ---- The read seam. Projects saved by T03 builds may hold bare values under `properties`; this is the only place that
// reads them (as the default value, no keyframes). Provisional choice (dev-only data, no schema bump).
export function prop(item: RecordData, key: string): Prop | undefined {
  const p = item.properties?.[key];
  if (p === undefined || p === null) return undefined;
  if (typeof p === 'object' && !Array.isArray(p) && 'defaultValue' in p) return { ...p, keyframes: Array.isArray(p.keyframes) ? p.keyframes : [] };
  return { defaultValue: p, keyframes: [] };
}
/** The stored value of `key` written back in the stored shape (created on first write: `initial`, else the registry default). */
export function ensureProp(item: RecordData, key: string, initial?: unknown): Prop {
  const p = prop(item, key) ?? { defaultValue: initial !== undefined ? initial : specOf(item.type, key)?.default ?? null, keyframes: [] };
  (item.properties ??= {})[key] = p;
  return p;
}
/** Sets the static value (keyframes untouched). */
export const setStatic = (item: RecordData, key: string, value: unknown) => { ensureProp(item, key).defaultValue = value; };
/** The static value, else the registry fallback. */
export const staticValue = (item: RecordData, key: string, fallback?: unknown) => prop(item, key)?.defaultValue ?? fallback ?? specOf(item.type, key)?.default;
/** Every stored property's static value as a plain object (readers that compare static values, e.g. the G-01 replay). */
export const statics = (item: RecordData): RecordData =>
  Object.fromEntries(Object.keys(item.properties ?? {}).map(k => [k, prop(item, k)?.defaultValue]));
/** Stored-shape `properties` from plain values (new items). */
export const storedProperties = (values: Record<string, unknown>): Record<string, Prop> =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));
/** Rewrites every stored property in the stored shape, through the read seam (copies made by split / clone / paste). */
export const normaliseProperties = (item: RecordData) => { for (const k of Object.keys(item.properties ?? {})) { const p = prop(item, k); if (p) item.properties[k] = p; } };

// ---- Easings (§40): stored as names, evaluated as cubic beziers; back / elastic / bounce use the standard functions.
export const BEZIER: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1], easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1],
  easeInQuad: [0.55, 0.085, 0.68, 0.53], easeOutQuad: [0.25, 0.46, 0.45, 0.94], easeInOutQuad: [0.455, 0.03, 0.515, 0.955],
  easeInCubic: [0.55, 0.055, 0.675, 0.19], easeOutCubic: [0.215, 0.61, 0.355, 1], easeInOutCubic: [0.645, 0.045, 0.355, 1],
};
const C1 = 1.70158, C2 = C1 * 1.525, C3 = C1 + 1, C4 = (2 * Math.PI) / 3;
function outBounce(x: number) {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x - 1.5 / d) ** 2 + 0.75;
  if (x < 2.5 / d) return n * (x - 2.25 / d) ** 2 + 0.9375;
  return n * (x - 2.625 / d) ** 2 + 0.984375;
}
export const FUNCTIONS: Record<string, (x: number) => number> = {
  easeInBack: x => C3 * x ** 3 - C1 * x ** 2,
  easeOutBack: x => 1 + C3 * (x - 1) ** 3 + C1 * (x - 1) ** 2,
  easeInOutBack: x => x < 0.5 ? ((2 * x) ** 2 * ((C2 + 1) * 2 * x - C2)) / 2 : ((2 * x - 2) ** 2 * ((C2 + 1) * (2 * x - 2) + C2) + 2) / 2,
  easeOutElastic: x => x === 0 ? 0 : x === 1 ? 1 : 2 ** (-10 * x) * Math.sin((10 * x - 0.75) * C4) + 1,
  easeOutBounce: outBounce,
};
/** The 15 easing names (order of the "Options:" list is a provisional choice). */
export const EASINGS = [...Object.keys(BEZIER), ...Object.keys(FUNCTIONS)];

/** Cubic bezier (0,0)-(x1,y1)-(x2,y2)-(1,1) as y(x); x1, x2 in 0…1 keep x(t) monotonic. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t: number) => ((ax * t + bx) * t + cx) * t, Y = (t: number) => ((ay * t + by) * t + cy) * t, dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = X(t) - x, d = dX(t);
      if (Math.abs(e) < 1e-12 && t >= 0 && t <= 1) return Y(t);
      if (Math.abs(d) < 1e-9) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 64; i++) { const v = X(t); if (Math.abs(v - x) < 1e-12) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return Y(t);
  };
}
const isBezierEasing = (e: unknown): e is { type: 'bezier'; points: [number, number, number, number] } =>
  !!e && typeof e === 'object' && (e as RecordData).type === 'bezier' && Array.isArray((e as RecordData).points) && (e as RecordData).points.length === 4 && (e as RecordData).points.every(Number.isFinite);
/** An input easing is valid when it is one of the 15 names or a 4-number bezier object (unknown input is refused). */
export const validEasing = (e: unknown, allowBezier = true) => typeof e === 'string' ? EASINGS.includes(e) : allowBezier && isBezierEasing(e);
/** Control points of an easing (its default bezier handles). Back / elastic / bounce / unknown: linear's (provisional). */
export const controlPoints = (e: unknown): [number, number, number, number] => isBezierEasing(e) ? e.points : typeof e === 'string' && BEZIER[e] ? BEZIER[e] : BEZIER.linear;
/** The curve of an easing; an unknown stored name falls back to linear (§40). */
export function easingCurve(e: unknown): (x: number) => number {
  if (typeof e === 'string' && FUNCTIONS[e]) return FUNCTIONS[e];
  const [x1, y1, x2, y2] = controlPoints(e);
  return x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1 ? x => x : cubicBezier(x1, y1, x2, y2);
}
/** e(p) of the segment A→B (§38): A's easing, or a bezier when A has an out-handle or B an in-handle. */
export function segmentEase(a: Keyframe, b: Keyframe, p: number): number {
  if (a.outHandle || b.inHandle) {
    const d = controlPoints(a.easing), o = a.outHandle ?? [d[0], d[1]], i = b.inHandle ?? [d[2], d[3]];
    return cubicBezier(o[0], o[1], i[0], i[1])(p);
  }
  return easingCurve(a.easing)(p);
}

// ---- Evaluation (§38).
export const sorted = (keyframes: Keyframe[]) => [...keyframes].sort((a, b) => a.time - b.time);
/** Value of a keyframe list at time t: hold before the first / after the last; non-numbers hold A between keyframes. */
export function evaluate(keyframes: Keyframe[] | undefined, fallback: unknown, t: number): unknown {
  if (!keyframes?.length) return fallback;
  const k = sorted(keyframes), last = k[k.length - 1];
  if (t <= k[0].time) return k[0].value;
  if (t >= last.time) return last.value;
  const i = k.findIndex(f => f.time > t), a = k[i - 1], b = k[i];
  if (t === a.time) return a.value;
  if (typeof a.value !== 'number' || typeof b.value !== 'number') return a.value;
  return a.value + (b.value - a.value) * segmentEase(a, b, (t - a.time) / (b.time - a.time));
}

// ---- Clocks (§38). t = item-local ms.
export const rateOf = (item: RecordData) => { const r = item.playbackRate ?? 1; return typeof r === 'number' && r > 0 ? r : 1; };
export const propertyTime = (item: RecordData, local: number) => (item.trim?.from ?? 0) + local * rateOf(item);
/** Timeline ms ↔ property time (the trim axis). */
export const toPropertyTime = (item: RecordData, timelineMs: number) => propertyTime(item, timelineMs - item.display.from);
export const toTimelineMs = (item: RecordData, propertyMs: number) => item.display.from + (propertyMs - (item.trim?.from ?? 0)) / rateOf(item);
/** A property's value at item-local time t, else its static value, else the registry fallback. */
export function valueAt(item: RecordData, key: string, local: number): unknown {
  const p = prop(item, key);
  return evaluate(p?.keyframes, p ? p.defaultValue : specOf(item.type, key)?.default, propertyTime(item, local));
}
/** The time-remap keyframes (item-local ms → source ms), or none. */
export const remapKeyframes = (item: RecordData): Keyframe[] => Array.isArray(item.timeRemap?.keyframes) ? item.timeRemap.keyframes : [];
/** Source ms at item-local t: the remap curve, else trim.from + t × rate; clamped to 0 … limit (the source length). */
export function sourceTime(item: RecordData, local: number, limit: number = typeof item.sourceDuration === 'number' ? item.sourceDuration : Infinity): number {
  const k = remapKeyframes(item), s = k.length ? Number(evaluate(k, item.timeRemap?.defaultValue ?? 0, local)) : propertyTime(item, local);
  return Math.min(Math.max(s, 0), limit);
}
/** Instantaneous speed (audio pitch / decoder hints): 1 ms forward difference, magnitude clamped to 1/16 … 16. */
export function speedAt(item: RecordData, local: number): number {
  const d = sourceTime(item, local + 1) - sourceTime(item, local), m = Math.min(16, Math.max(1 / 16, Math.abs(d)));
  return d < 0 ? -m : m;
}
/** setTimeRemap's speedRange: |1 ms forward difference| at the start, middle and end (end − 1 ms) of each segment longer
 *  than 1 ms, unclamped, 3 decimals (agent tool results §2, §6 G-02). No segment → 0×–0× (provisional). */
export function speedRange(item: RecordData, limit: number): { min: number; max: number } {
  const k = sorted(remapKeyframes(item)), speeds: number[] = [], at = (t: number) => Math.abs(sourceTime(item, t + 1, limit) - sourceTime(item, t, limit));
  for (let n = 1; n < k.length; n++) {
    const a = k[n - 1].time, b = k[n].time;
    if (b - a > 1) speeds.push(at(a), at((a + b) / 2), at(b - 1));
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return speeds.length ? { min: r3(Math.min(...speeds)), max: r3(Math.max(...speeds)) } : { min: 0, max: 0 };
}

// ---- Keyframe ids: kf_<epoch ms>_<9 chars> (findings (C).md:38); the random part follows model.ts's injectable source.
export const keyframeId = () => `kf_${Date.now()}_${newId('').slice(1, 10).padEnd(9, '0')}`;

// ---- The agent-facing keyframes block (agent tool results §2 viewItemDetails; §6 G-02): absolute timeline seconds,
// time-remap values in source ms, keyframes in stored order (results §2 does not say the block is sorted). The
// viewItemDetails tool itself is T18's.
const seconds = (ms: number) => Math.round(ms * 1000) / 1e6; // µs-clean (provisional rounding)
export type KeyframesBlock = { keyframes: Record<string, { defaultValue: unknown; keyframeCount: number; keyframes: RecordData[] }> | null; keyframesNote?: string };
/** One keyframe list as the agent sees it (`at` maps a stored time to timeline ms). Also used for effect parameters (T10). */
export const keyframeList = (k: Keyframe[], at: (time: number) => number) => k.map(f => ({
  timelineSeconds: seconds(at(f.time)), value: f.value, easing: f.easing,
  ...(f.inHandle ? { inHandle: f.inHandle } : {}), ...(f.outHandle ? { outHandle: f.outHandle } : {}),
}));
export function keyframesBlock(item: RecordData): KeyframesBlock {
  const out: NonNullable<KeyframesBlock['keyframes']> = {}, list = keyframeList;
  for (const key of Object.keys(item.properties ?? {})) {
    const p = prop(item, key);
    if (p?.keyframes.length) out[key] = { defaultValue: p.defaultValue, keyframeCount: p.keyframes.length, keyframes: list(p.keyframes, t => toTimelineMs(item, t)) };
  }
  const remap = remapKeyframes(item);
  if (remap.length) out.timeRemap = { defaultValue: item.timeRemap?.defaultValue ?? 0, keyframeCount: remap.length, keyframes: list(remap, t => item.display.from + t) };
  return Object.keys(out).length ? { keyframes: out } : { keyframes: null, keyframesNote: 'No keyframes on this item' };
}
