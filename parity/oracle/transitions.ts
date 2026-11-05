// SPDX-License-Identifier: AGPL-3.0-only
// Transitions (findings part 5 §55): record limits, window placement, clip extension and the six kinds.
// Pixels are gamma-encoded straight-alpha floats (image.ts); canvas 8-bit rounding of the intermediate
// surfaces is not modelled, so pixel checks allow ±1 LSB (§55.0, §59 item 2). Export is the reference.
import { clamp, smooth, type RGBA } from './math';
import { createImage, type Image } from './image';

export const KINDS = ['fade', 'dissolve', 'additiveDissolve', 'dipToColorDissolve', 'slide', 'wipe'] as const;
export type Kind = typeof KINDS[number];
export const DIRECTIONS = ['from-left', 'from-right', 'from-top', 'from-bottom'] as const;
export type Direction = typeof DIRECTIONS[number];
export const DEFAULT_KIND: Kind = 'fade', DEFAULT_MS = 1000, MIN_MS = 100, MAX_MS = 3000;
export type TransitionRecord = { id: string; trackId: string; fromId: string; toId: string; kind: Kind; durationMs: number; alignment: number; direction?: Direction; params?: Record<string, any> };

export const smooth01 = (x: number) => smooth(0, 1, x);
export const outCubic = (x: number) => 1 - (1 - clamp(x)) ** 3;
export const inOutCubic = (x: number) => x < .5 ? 4 * x ** 3 : 1 - (2 - 2 * x) ** 3 / 2;

// §55.1 pair rules and limits. The cut time is the incoming clip's start.
export type PairClip = { trackId: string; type: string; startMs: number; endMs: number };
export const meets = (outgoing: PairClip, incoming: PairClip) => outgoing.trackId === incoming.trackId && [outgoing, incoming].every(c => c.type === 'video' || c.type === 'image') && Math.abs(outgoing.endMs - incoming.startMs) <= 1;
export const maxDurationMs = (outgoingMs: number, incomingMs: number) => Math.floor(Math.min(outgoingMs, incomingMs, MAX_MS));
// Shared add / update step: refuse only "too short"; otherwise round and clamp (never refuse "too long").
export function resolveDurationMs(requestedMs: number | undefined, maximumMs: number): number | { code: 'INVALID_PAIR'; reason: string } {
  if (maximumMs < MIN_MS) return { code: 'INVALID_PAIR', reason: 'These clips are too short for a transition (min 100ms)' };
  return clamp(Math.round(requestedMs ?? DEFAULT_MS), MIN_MS, maximumMs);
}
// Repair after an edit: null = removed ("too short"), else clamped down to the maximum.
export const repairDurationMs = (storedMs: number, maximumMs: number) => maximumMs < MIN_MS ? null : Math.min(storedMs, maximumMs);
export const directionFor = (kind: string, direction: unknown): Direction | undefined => kind === 'slide' || kind === 'wipe' ? (DIRECTIONS.includes(direction as Direction) ? direction as Direction : 'from-left') : undefined;
export const alignmentValue = (a: unknown) => a === 'start' ? 0 : a === 'center' ? .5 : a === 'end' ? 1 : typeof a === 'number' && Number.isFinite(a) ? clamp(a) : .5;

// §55.2 window placement. Half-open [cut − pre, cut + post); frame n is at n / fps × 1000 ms.
export type WindowParts = { preMs: number; postMs: number };
export type TransitionWindow = WindowParts & { startMs: number; endMs: number; lengthMs: number; firstFrame: number; lastFrame: number };
export function windowParts(durationMs: number, alignment: unknown): WindowParts {
  const d = Math.max(1, Math.floor(durationMs)), preMs = Math.floor(d * alignmentValue(alignment));
  return { preMs, postMs: d - preMs };
}
// Middle clip of length L with an incoming transition (post part i) and an outgoing one (pre part o).
// Assumption: "shortfall" = exact scaled value − floored value (largest remainder); see report.
export function chainParts(lengthMs: number, i: number, o: number): [number, number] {
  if (i + o <= lengthMs) return [i, o];
  const k = lengthMs / (i + o); let a = Math.floor(i * k), b = Math.floor(o * k);
  while (a + b + 1 <= lengthMs) if (i * k - a >= o * k - b) a++; else b++;
  return [a, b];
}
export const frameTimeMs = (frame: number, fps: number) => frame / fps * 1000;
// parts overrides the placement for chained windows (the progress denominator is then the shortened length).
export function transitionWindow(cutMs: number, durationMs: number, alignment: unknown, fps: number, parts: WindowParts = windowParts(durationMs, alignment)): TransitionWindow {
  const startMs = cutMs - parts.preMs, endMs = cutMs + parts.postMs;
  const firstAtOrAfter = (ms: number) => { let f = Math.ceil(ms * fps / 1000); while (frameTimeMs(f - 1, fps) >= ms) f--; while (frameTimeMs(f, fps) < ms) f++; return f; };
  return { ...parts, startMs, endMs, lengthMs: parts.preMs + parts.postMs, firstFrame: firstAtOrAfter(startMs), lastFrame: firstAtOrAfter(endMs) - 1 };
}
// Linear p in [0, 1) inside the window, null outside. Only slide eases it (inside its own function).
export const progressAt = (tMs: number, w: { startMs: number; endMs: number; lengthMs: number }) => tMs >= w.startMs && tMs < w.endMs ? (tMs - w.startMs) / w.lengthMs : null;

// §55.3 the outgoing clip runs on to cut + post, the incoming one starts at cut − pre. Video keeps playing
// source handles at its rate, then freezes on its first / last source frame. Constant rate only.
export const extendedSourceMs = (tMs: number, clip: { startMs: number; inPointMs: number; rate: number; sourceDurationMs: number }) => clamp(clip.inPointMs + (tMs - clip.startMs) * clip.rate, 0, clip.sourceDurationMs);

// §55.4 canvas operations on straight-alpha pixels. Global alpha is clamped to [0, 1] (see report: fade at p = 0.5).
const CLEAR: RGBA = [0, 0, 0, 0], BLACK: RGBA = [0, 0, 0, 1];
const over = (d: RGBA, s: RGBA, g = 1): RGBA => { const a = s[3] * clamp(g), o = a + d[3] * (1 - a); return o > 0 ? [...[0, 1, 2].map(i => (s[i] * a + d[i] * d[3] * (1 - a)) / o), o] as RGBA : CLEAR; };
const lighter = (d: RGBA, s: RGBA, g: number): RGBA => { const a = s[3] * clamp(g), o = Math.min(1, a + d[3]); return o > 0 ? [...[0, 1, 2].map(i => Math.min(1, s[i] * a + d[i] * d[3]) / o), o] as RGBA : CLEAR; };
const px = (m: Image, i: number) => Array.from(m.data.subarray(i, i + 4)) as RGBA;
function zip(a: Image, b: Image, f: (a: RGBA, b: RGBA, column: number, row: number) => RGBA): Image {
  if (a.width !== b.width || a.height !== b.height) throw Error('Transition surfaces must share the canvas size');
  const out = createImage(a.width, a.height);
  for (let row = 0; row < a.height; row++) for (let column = 0; column < a.width; column++) { const i = (row * a.width + column) * 4; out.data.set(f(px(a, i), px(b, i), column, row), i); }
  return out;
}
// Move a whole surface by whole canvas px (+y down); uncovered area is transparent.
function shift(m: Image, dx: number, dy: number): Image {
  const out = createImage(m.width, m.height);
  for (let row = 0; row < m.height; row++) for (let column = 0; column < m.width; column++) {
    const c = column - dx, r = row - dy;
    if (c >= 0 && c < m.width && r >= 0 && r < m.height) out.data.set(m.data.subarray((r * m.width + c) * 4, (r * m.width + c) * 4 + 4), (row * m.width + column) * 4);
  }
  return out;
}

// §55.5 per-kind curves.
export const fadeAlpha = (p: number) => clamp(p < .5 ? Math.cos(Math.PI * p) : -Math.cos(Math.PI * p));
export const dissolveWeight = (p: number) => .5 - .5 * Math.cos(Math.PI * p);
export const dipOverlay = (p: number) => p < .5 ? smooth01(p / .5) : 1 - smooth01((p - .5) / .5);
export const dipColour = (c: unknown): RGBA => Array.isArray(c) ? [...[0, 1, 2].map(i => typeof c[i] === 'number' ? Math.round(clamp(c[i]) * 255) / 255 : 0), 1] as RGBA : BLACK;
const VECTOR: Record<Direction, [number, number]> = { 'from-left': [1, 0], 'from-right': [-1, 0], 'from-top': [0, 1], 'from-bottom': [0, -1] };
// Whole-px offsets (round half up) of the outgoing and incoming surfaces.
export function slideOffsets(p: number, direction: unknown, width: number, height: number) {
  const e = inOutCubic(p), [x, y] = VECTOR[directionFor('slide', direction)!];
  return { outgoing: [Math.round(e * x * width), Math.round(e * y * height)] as [number, number], incoming: [Math.round((e - 1) * x * width), Math.round((e - 1) * y * height)] as [number, number] };
}
export const wipeSoftness = (params: Record<string, any> | undefined) => typeof params?.softness === 'number' ? clamp(params.softness, 0, 100) / 100 : 0;
// u = position along the wipe from the entry side (0…1); s = softness 0…1. ideal = DOM path, else reference path quirks A and B.
export function wipeMask(u: number, p: number, s: number, ideal = false) {
  const f = p * (1 + s), g = f - s;
  if (!ideal && p === 0 && s === 0) return 1 - u;
  if (!ideal && f > 1) return u <= g ? 1 : u >= 1 ? 0 : (1 - u) / (1 - g);
  return u <= g ? 1 : u >= f ? 0 : (f - u) / s;
}
// Pixel-centre u; row counts down from the top (canvas +y down).
const wipeU = (d: Direction, column: number, row: number, w: number, h: number) => d === 'from-left' ? (column + .5) / w : d === 'from-right' ? 1 - (column + .5) / w : d === 'from-top' ? (row + .5) / h : 1 - (row + .5) / h;

// Combine the two transparent full-canvas surfaces (outgoing A, incoming B) at linear progress p.
// The result is drawn source-over at the pair's layer position by the frame renderer.
// params = the record's params plus `direction` (slide, wipe) from the record.
export const transitions: Record<string, (outgoing: Image, incoming: Image, progress: number, params: Record<string, any>) => Image> = {
  fade: (a, b, p) => zip(a, b, (x, y) => over(BLACK, p < .5 ? x : y, fadeAlpha(p))),
  dissolve: (a, b, p) => zip(a, b, (x, y) => over(x, y, dissolveWeight(p))),
  additiveDissolve: (a, b, p) => zip(a, b, (x, y) => lighter(over(CLEAR, x, 1 - p), y, p)),
  dipToColorDissolve: (a, b, p, params) => { const c = dipColour(params?.color), k = dipOverlay(p); return zip(a, b, (x, y) => over(p < .5 ? x : y, c, k)); },
  slide: (a, b, p, params) => { const o = slideOffsets(p, params?.direction, a.width, a.height); return zip(shift(a, ...o.outgoing), shift(b, ...o.incoming), (x, y) => over(over(CLEAR, y), x)); },
  wipe: (a, b, p, params) => { const d = directionFor('wipe', params?.direction)!, s = wipeSoftness(params); return zip(a, b, (x, y, column, row) => over(x, y, wipeMask(wipeU(d, column, row, a.width, a.height), p, s))); },
};
