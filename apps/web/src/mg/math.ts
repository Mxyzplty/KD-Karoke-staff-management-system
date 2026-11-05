// SPDX-License-Identifier: AGPL-3.0-only
import { supportedOptions } from './errors';
export type Ease = (t: number) => number;
export type Extrapolation = 'extend' | 'clamp' | 'wrap' | 'identity';
export type InterpolateOptions = { easing?: Ease; extrapolateLeft?: Extrapolation; extrapolateRight?: Extrapolation };
export function interpolate(input: number, inputRange: number[], outputRange: number[], options: InterpolateOptions = {}): number {
  supportedOptions('interpolate', options, ['easing', 'extrapolateLeft', 'extrapolateRight']);
  if (inputRange.length < 2 || inputRange.length !== outputRange.length || inputRange.some((v, i) => !Number.isFinite(v) || i > 0 && v <= inputRange[i - 1])) throw Error('inputRange must be strictly increasing and match outputRange (at least two values).');
  if (options.easing !== undefined && typeof options.easing !== 'function') throw Error('interpolate easing must be one function.');
  const first = inputRange[0], last = inputRange.at(-1)!;
  const mode = input < first ? options.extrapolateLeft ?? 'extend' : input > last ? options.extrapolateRight ?? 'extend' : 'extend';
  if (!['extend', 'clamp', 'wrap', 'identity'].includes(mode)) throw Error(`Unsupported extrapolation '${mode}'.`);
  if (mode === 'identity') return input;
  if (mode === 'clamp') input = Math.max(first, Math.min(last, input));
  if (mode === 'wrap') input = first + ((input - first) % (last - first) + last - first) % (last - first);
  let i = 0; while (i < inputRange.length - 2 && input >= inputRange[i + 1]) i++;
  const t = (input - inputRange[i]) / (inputRange[i + 1] - inputRange[i]);
  return outputRange[i] + (outputRange[i + 1] - outputRange[i]) * (options.easing ?? Easing.linear)(t);
}
function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) throw Error('Bezier x coordinates must be in [0,1].');
  const axis = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  return x => { if (x === 0 || x === 1) return x; let lo = 0, hi = 1; for (let n = 0; n < 40; n++) { const m = (lo + hi) / 2; if (axis(m, x1, x2) < x) lo = m; else hi = m; } return axis((lo + hi) / 2, y1, y2); };
}
const bounce: Ease = t => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375; return n * (t -= 2.625 / d) * t + .984375; };
export const Easing = {
  linear: (t: number) => t, ease: bezier(.42, 0, 1, 1), quad: (t: number) => t * t, cubic: (t: number) => t ** 3,
  poly: (n: number): Ease => t => t ** n, sin: (t: number) => 1 - Math.cos(t * Math.PI / 2), circle: (t: number) => 1 - Math.sqrt(1 - t * t), exp: (t: number) => t === 0 ? 0 : 2 ** (10 * (t - 1)),
  elastic: (bounciness = 1): Ease => t => 1 - Math.cos(t * Math.PI / 2) ** 3 * Math.cos(t * bounciness * Math.PI),
  back: (s = 1.70158): Ease => t => t * t * ((s + 1) * t - s), bounce, bezier,
  in: (f: Ease): Ease => f, out: (f: Ease): Ease => t => 1 - f(1 - t), inOut: (f: Ease): Ease => t => t < .5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2,
};
export type SpringConfig = { mass?: number; damping?: number; stiffness?: number; overshootClamping?: boolean };
export type SpringOptions = { frame: number; fps: number; config?: SpringConfig; from?: number; to?: number; durationInFrames?: number; durationRestThreshold?: number; delay?: number; reverse?: boolean };
function springValue(frame: number, fps: number, config: SpringConfig = {}): number {
  supportedOptions('spring.config', config, ['mass', 'damping', 'stiffness', 'overshootClamping']);
  const { mass = 1, damping = 10, stiffness = 100, overshootClamping = false } = config;
  if (![mass,damping,stiffness,fps].every(v => Number.isFinite(v) && v > 0)) throw Error('Spring mass, damping, stiffness and fps must be positive finite values.');
  const w = Math.sqrt(stiffness / mass), z = Math.min(1, damping / (2 * Math.sqrt(stiffness * mass))), t = Math.max(0, frame) / fps;
  const d = w * Math.sqrt(1 - z * z);
  const value = z === 1 ? 1 - Math.exp(-w * t) * (1 + w * t) : 1 - Math.exp(-z * w * t) * (Math.cos(d * t) + z * w / d * Math.sin(d * t));
  const firstCrossing = z < 1 ? (Math.PI - Math.atan2(d, z * w)) / d : Infinity;
  return overshootClamping && t >= firstCrossing ? 1 : value;
}
export function springDuration(fps: number, config: SpringConfig = {}, threshold = .005): number {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) throw Error('Spring fps must be positive and at most 1000 (execution budget).');
  if (!(threshold > 0 && threshold < 1)) throw Error('durationRestThreshold must be between 0 and 1.');
  let last = 0;
  for (let f = 0; f <= fps * 60; f++) if (Math.abs(1 - springValue(f, fps, config)) > threshold) last = f;
  return last + 1;
}
export function spring(options: SpringOptions): number {
  supportedOptions('spring', options, ['frame', 'fps', 'config', 'from', 'to', 'durationInFrames', 'durationRestThreshold', 'delay', 'reverse']);
  const { frame, fps, config, from = 0, to = 1, durationInFrames, durationRestThreshold = .005, delay = 0, reverse = false } = options;
  const natural = springDuration(fps, config, durationRestThreshold), duration = durationInFrames ?? natural;
  if (duration <= 0) throw Error('durationInFrames must be positive.');
  const local = Math.max(0, frame - delay), f = (reverse ? Math.max(0, duration - local) : local) * natural / duration;
  const progress = local >= duration && durationInFrames !== undefined ? reverse ? 0 : 1 : springValue(f, fps, config);
  return from + (to - from) * progress;
}
export function interpolateColors(input: number, range: number[], colors: string[]): string {
  if (arguments.length > 3) throw Error('interpolateColors options are unsupported (API pinned to 4.0.427).');
  if (colors.length !== range.length) throw Error('Color ranges must have matching lengths.');
  const channels = colors.map(parseColor);
  const values = [0, 1, 2, 3].map(c => interpolate(input, range, channels.map(v => v[c]), { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  return `rgba(${Math.round(values[0])}, ${Math.round(values[1])}, ${Math.round(values[2])}, ${Number(values[3].toFixed(5))})`;
}
function parseColor(color: string): number[] {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas'); const context = canvas.getContext('2d')!;
    context.fillStyle = color; color = context.fillStyle;
  }
  if (typeof document === 'undefined') {
    const named: Record<string, string> = { red: '#ff0000', blue: '#0000ff', green: '#008000', white: '#ffffff', black: '#000000', transparent: '#00000000' };
    color = named[color] ?? color;
    if (/^#[0-9a-f]{3,8}$/i.test(color)) { let h = color.slice(1); if (h.length <= 4) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1); }
    const m = color.match(/^rgba?\(([^)]+)\)$/); if (m) { const c = m[1].split(',').map(Number); return [c[0], c[1], c[2], c[3] ?? 1]; }
    throw Error('CSS colour parsing requires the browser for this format.');
  }
  if (color.startsWith('#')) { let h = color.slice(1); if (h.length <= 4) h = [...h].map(c => c + c).join(''); return [0,2,4].map(i => parseInt(h.slice(i, i + 2),16)).concat(h.length === 8 ? parseInt(h.slice(6),16) / 255 : 1); }
  const values = color.match(/[\d.]+/g)!.map(Number); return [values[0], values[1], values[2], values[3] ?? 1];
}
