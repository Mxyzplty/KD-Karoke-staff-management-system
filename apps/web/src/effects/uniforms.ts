// SPDX-License-Identifier: AGPL-3.0-only
// CPU side of one shader pass: the 64 × vec4 uniform block (frame constants, parameters, per-frame extras) and the
// aux texture (lookup table or matte). Setup the oracle computes once per frame runs here in float64.
import { FRAME_SLOTS, EXTRA_SLOT, UNIFORM_VEC4S } from './dsl';
import type { EffectDefinition, ParamValues, Wheel } from './schema';
import { bt709Table, keyColour, oklab, parseColour, type RGB } from './colour-math';
import { curvesTable } from './curves';
import { LUT_GRID, lutTableFor } from './lut';

/** Raw RGBA8 aux texture, row 0 first exactly as `tab(col, row)` reads it (a matte: top row first). */
export interface AuxTable { width: number; height: number; data: Uint8Array }

/** Per-pass frame constants. `sourceWidth` differs from `width` only for the stacked-alpha stage. */
export interface FrameConstants { width: number; height: number; timeS: number; seed: number; final: boolean; sourceWidth?: number }

interface Bands { chromaLo?: number; chromaHi?: number; glossLo?: number; glossHi?: number }
/** Element data for Element Colors (§49.19): palette entries, their targets and optional band edges (`bands`, or flat). */
export interface RecolorElement extends Bands {
  palette?: { base: string; kind: string }[];
  colors?: string[];
  bands?: Bands;
}

/** A matte for bg-removal: straight RGBA8, top row first; its alpha is the mask. */
export interface MaskImage { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

export function packUniforms(effect: EffectDefinition | undefined, values: ParamValues, frame: FrameConstants,
  extras: number[] = [], aux?: AuxTable): Float32Array {
  const u = new Float32Array(UNIFORM_VEC4S * 4);
  u[FRAME_SLOTS.W] = frame.width;
  u[FRAME_SLOTS.H] = frame.height;
  u[FRAME_SLOTS.T] = frame.timeS;
  u[FRAME_SLOTS.SEED] = frame.seed;
  u[FRAME_SLOTS.AW] = aux?.width ?? 1;
  u[FRAME_SLOTS.AH] = aux?.height ?? 1;
  u[FRAME_SLOTS.FINAL] = frame.final ? 1 : 0;
  u[FRAME_SLOTS.SW] = frame.sourceWidth ?? frame.width;
  for (const slot of effect?.uniforms ?? []) {
    const p = effect!.params.find(q => q.key === slot.key)!;
    const v = values[slot.key];
    switch (p.type) {
      case 'number': u[slot.slot] = v as number; break;
      case 'boolean': u[slot.slot] = v ? 1 : 0; break;
      case 'select': u[slot.slot] = Math.max(0, p.options.findIndex(o => o.value === v)); break;
      case 'colorWheel': u[slot.slot] = (v as Wheel).angle; u[slot.slot + 1] = (v as Wheel).distance; break;
      case 'color': {
        const c = effect!.id === 'color-key' ? [...keyColour(v), 1] : parseColour(v, effect!.id === 'halftone' ? p.default : '#000000');
        u.set(c, slot.slot);
      }
    }
  }
  if (extras.length > (UNIFORM_VEC4S * 4 - EXTRA_SLOT)) throw new Error('too many extra uniforms');
  u.set(extras, EXTRA_SLOT);
  return u;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// §50.11 palettes as 4-decimal fractions of the 8-bit codes.
const DITHER_PALETTES: Record<string, string[]> = {
  bw: ['000000', 'ffffff'], gameboy: ['0f380f', '306230', '8bac0f', '9bbc0f'], cga: ['000000', '55ffff', 'ff55ff', 'ffffff'],
  sepia: ['2b1d0e', '6b4226', 'c4956a', 'f5e6c8'],
};
function ditherExtras(v: ParamValues): number[] {
  const pal = DITHER_PALETTES[v.palette as string] ?? DITHER_PALETTES.gameboy;
  const out = [pal.length];
  for (const hex of pal) for (const i of [0, 2, 4]) out.push(Math.round(parseInt(hex.slice(i, i + 2), 16) / 255 * 1e4) / 1e4);
  return out;
}

/** §50.12 grid steps 1–6 for a W × H item: [N, hex, type, cell w, cell h, kappa, b, original]. */
export function halftoneExtras(v: ParamValues, W: number, H: number): number[] {
  const s = (v.size as number) / 100, R = clamp((v.radius as number) / 100, 0, 2), kp = (v.contrast as number) / 100, original = !!v.originalColors;
  const hex = v.grid !== 'square', ti = ['classic', 'gooey', 'holes', 'soft'].indexOf(v.type as string), type = ti < 0 ? 1 : ti;
  const N = [2, 6, 1, 6][type], n0 = mix(300, 7, s ** .7), g = type === 1 && hex ? .7 : 1, h = N / n0 * g, w = N / n0 * H / W * g;
  const odd = (k: number) => k % 2 ? k : k + 1, cols = odd(Math.max(1, Math.floor(1 / w + .5))), rows = odd(Math.max(1, Math.floor(1 / h + .5)));
  return [N, +hex, type, 1 / cols, 1 / rows, original ? mix(.1, 4, kp * kp) : 15 * kp ** 1.5, original ? 2 * (R / 2) ** .3 : R, +original];
}

const rgbOf = (c: string | undefined, fallback?: string): RGB => parseColour(c, fallback ?? '#000000').slice(0, 3) as RGB;
const byte = (v: number) => Math.round(v * 255);

/** §49.19: is the pass needed at all (a target differs from its base after 8-bit rounding)? */
export function recolorActive(el: RecolorElement | undefined): boolean {
  return (el?.palette ?? []).slice(0, 2).some((e, i) => {
    const base = rgbOf(e.base), goal = rgbOf(el?.colors?.[i], e.base);
    return base.some((b, k) => byte(b) !== byte(goal[k]));
  });
}

/** Recolor extras: x0 count, x1 active, x2..x5 band edges, entry i at x(8 + 16i) (layout in shaders/colour.ts). */
export function recolorExtras(el: RecolorElement | undefined): number[] {
  const list = (el?.palette ?? []).slice(0, 2);
  const out = new Array(8 + 16 * 2).fill(0);
  out[0] = list.length;
  out[1] = recolorActive(el) ? 1 : 0;
  const band = (k: keyof Bands, d: number) => {
    const v = el?.bands?.[k] ?? el?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  out[2] = band('chromaLo', .025); out[3] = band('chromaHi', .07); out[4] = band('glossLo', 2); out[5] = band('glossHi', 3);
  list.forEach((e, i) => {
    const base = oklab(rgbOf(e.base)), goal = oklab(rgbOf(el?.colors?.[i], e.base)), o = 8 + 16 * i;
    const cb = Math.hypot(base[1], base[2]), cg = Math.hypot(goal[1], goal[2]);
    out[o] = e.kind === 'color' ? 1 : 0;
    out.splice(o + 1, 6, ...base, ...goal);
    out[o + 7] = Math.atan2(base[2], base[1]);
    out[o + 8] = cg / Math.max(cb, 1e-4);
    out[o + 9] = cg < 1e-6 ? 0 : Math.atan2(goal[2], goal[1]) - Math.atan2(base[2], base[1]);
    out[o + 10] = clamp(base[0], .02, .999);
    out[o + 11] = clamp(goal[0], .035, 1);
    out[o + 12] = Math.abs(base[0] - goal[0]) < 1e-6 ? 1 : 0;
  });
  return out;
}

/** Scanlines x0: the time offset o = T·speed/20·0.1 reduced mod one line period 2π/(100·density) in float64, so the
 * f32 sine argument stays small at any T (100·D·(o − kP) = 100·D·o − 2πk; the oracle's sine is unchanged). */
function scanlinesExtras(v: ParamValues, timeS: number): number[] {
  const D = v.density as number, o = timeS * (v.speed as number) / 20 * .1, P = 2 * Math.PI / (100 * D);
  return [D ? o - P * Math.floor(o / P) : o];
}

export function extrasFor(id: string, values: ParamValues, W: number, H: number, element?: RecolorElement, timeS = 0): number[] {
  if (id === 'dither') return ditherExtras(values);
  if (id === 'halftone') return halftoneExtras(values, W, H);
  if (id === 'recolor') return recolorExtras(element);
  if (id === 'scanlines') return scanlinesExtras(values, timeS);
  return [];
}

let bt709Aux: AuxTable | undefined;
/** Decoded LUT tables per `lutData` value (T10 fix round 1 N2): the decode runs once per value, not once per frame. */
const LUT_CACHE = 8, lutTables = new Map<unknown, Uint8Array>();
function lutTable(data: unknown): Uint8Array {
  let table = lutTables.get(data);
  if (!table) {
    if (lutTables.size >= LUT_CACHE) lutTables.delete(lutTables.keys().next().value);
    lutTables.set(data, table = lutTableFor(data));
  }
  return table;
}

/** The aux texture a program reads, if any. bg-removal without a mask has none (the caller skips the pass). */
export function auxFor(id: string, values: ParamValues, mask?: MaskImage): AuxTable | undefined {
  if (id === 'curves') return { width: 256, height: 1, data: curvesTable(values) };
  if (id === 'lut') return { width: LUT_GRID * LUT_GRID, height: LUT_GRID, data: lutTable(values.lutData) };
  if (id === 'bg-removal' && mask) return { width: mask.width, height: mask.height, data: new Uint8Array(mask.data.buffer, mask.data.byteOffset, mask.data.byteLength) };
  if (id === 'video-input-709') {
    if (!bt709Aux) {
      const t = bt709Table(), data = new Uint8Array(256 * 4);
      t.forEach((v, i) => data.set([v, v, v, 255], i * 4));
      bt709Aux = { width: 256, height: 1, data };
    }
    return bt709Aux;
  }
  return undefined;
}
