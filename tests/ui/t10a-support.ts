// SPDX-License-Identifier: AGPL-3.0-only
// T10a render-parity helpers (Node side): PNG decode, labelled stand-in stills, oracle image conversion, comparison metrics,
// parameter variants, and the in-page driver for the effects module.
import { inflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { STORE } from '../media-fixtures';
import { effectById } from '../../apps/web/src/effects/registry';
import { resolveParams } from '../../apps/web/src/effects/validate';
import { encodeLut, importCube } from '../../apps/web/src/effects/lut';
import type { Image } from '../../parity/oracle/image';

export interface Raw { width: number; height: number; data: Uint8Array }

// ---- PNG ----------------------------------------------------------------------------------------------------------
/** 8-bit, non-interlaced PNG (grey, grey+alpha, RGB, RGBA) → straight RGBA8, top row first. */
export function decodePng(buf: Buffer): Raw {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0; const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), tag = buf.toString('latin1', off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (tag === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(type)) throw new Error(`unsupported PNG: depth ${depth} type ${type} interlace ${interlace}`);
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[type as 0 | 2 | 4 | 6], stride = width * bpp, raw = inflateSync(Buffer.concat(idat));
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride), out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * bpp;
      if (type === 0) out.set([cur[s], cur[s], cur[s], 255], o);
      else if (type === 4) out.set([cur[s], cur[s], cur[s], cur[s + 1]], o);
      else if (type === 2) out.set([cur[s], cur[s + 1], cur[s + 2], 255], o);
      else out.set(cur.subarray(s, s + 4), o);
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

// ---- stills -------------------------------------------------------------------------------------------------------
export const W = 1080, H = 1920;
export const hasStills = !!STORE && existsSync(path.join(STORE, 'synthetic'));
export const STILL_FILES = { S3a: 'S3a-gradient-1080x1920.png', S3b: 'S3b-corpus-frame-tos-action-13s-1080x1920.png', S3c: 'S3c-text-on-alpha-1080x1920.png' } as const;
export const loadStill = (id: keyof typeof STILL_FILES): Raw => decodePng(readFileSync(path.join(STORE, 'synthetic', STILL_FILES[id])));

/** LABELLED STAND-IN for S3a: horizontal black→white gradient, opaque. */
export function standInS3a(width = W, height = H): Raw {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const v = Math.round(x / (width - 1) * 255); data.set([v, v, v, 255], (y * width + x) * 4); }
  return { width, height, data };
}
/** LABELLED STAND-IN for the dark corner cases (dither threshold τ = 1 at cell corners, which needs b = 0 exactly): opaque black with a
 *  band of the middle third of the rows holding a horizontal ramp of dark codes 0–40 (R = G = B). Generated, no fixture store. */
export function standInDark(width = 270, height = 480): Raw {
  const data = new Uint8Array(width * height * 4), y0 = Math.floor(height / 3), y1 = Math.floor(2 * height / 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = y >= y0 && y < y1 ? Math.round(x / (width - 1) * 40) : 0;
    data.set([v, v, v, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}
// 5×7 glyphs for T E X.
const GLYPH: Record<string, string[]> = {
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
};
/** LABELLED STAND-IN for S3c: white "TEXT" on a fully transparent background (RGB 0 outside the glyphs), with a soft-alpha ring. */
export function standInS3c(width = W, height = H): Raw {
  const data = new Uint8Array(width * height * 4), cell = Math.floor(width / 30), word = 'TEXT', gw = 5 * cell, gap = cell;
  const x0 = Math.floor((width - (word.length * gw + (word.length - 1) * gap)) / 2), y0 = Math.floor(height / 2 - 3.5 * cell);
  for (let k = 0; k < word.length; k++) GLYPH[word[k] === 'T' ? 'T' : word[k]].forEach((row, r) => [...row].forEach((bit, c) => {
    if (bit !== '1') return;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const px = x0 + k * (gw + gap) + c * cell + x, py = y0 + r * cell + y, edge = Math.min(x, y, cell - 1 - x, cell - 1 - y);
      const a = edge >= 2 ? 255 : 128 + edge * 40;
      if (px >= 0 && px < width && py >= 0 && py < height) data.set([255, 255, 255, a], (py * width + px) * 4);
    }
  }));
  return { width, height, data };
}

/** Box-average downscale to (w, h) (premultiplied-free, straight channel mean). */
export function downscale(src: Raw, w: number, h: number): Raw {
  if (src.width === w && src.height === h) return src;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * src.height / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * src.height / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * src.width / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * src.width / w)), sum = [0, 0, 0, 0];
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) for (let k = 0; k < 4; k++) sum[k] += src.data[(yy * src.width + xx) * 4 + k];
      const n = (y1 - y0) * (x1 - x0);
      for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = Math.round(sum[k] / n);
    }
  }
  return { width: w, height: h, data: out };
}

export function toImage(raw: Raw): Image {
  const data = new Float32Array(raw.data.length);
  for (let i = 0; i < data.length; i++) data[i] = raw.data[i] / 255;
  return { width: raw.width, height: raw.height, data };
}
export function quantise(image: Image): Uint8Array {
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(Math.max(image.data[i], 0), 1) * 255);
  return out;
}

// ---- metrics ------------------------------------------------------------------------------------------------------
export interface Diff { maxErr: number; meanErr: number; over1: number; over2: number; ssim: number }
const luma = (d: Uint8Array, i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
/** Mean SSIM over non-overlapping 8×8 windows of Rec. 709 luma (constants k1 .01, k2 .03, L 255). */
export function ssim(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2, B = Math.min(8, width, height); let total = 0, count = 0;
  for (let by = 0; by + B <= height; by += B) for (let bx = 0; bx + B <= width; bx += B) {
    let ma = 0, mb = 0, saa = 0, sbb = 0, sab = 0; const n = B * B;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const i = ((by + y) * width + bx + x) * 4, la = luma(a, i), lb = luma(b, i); ma += la; mb += lb; saa += la * la; sbb += lb * lb; sab += la * lb; }
    ma /= n; mb /= n; const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cv = sab / n - ma * mb;
    total += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); count++;
  }
  return count ? total / count : 1;
}
export function compare(actual: Uint8Array, expected: Uint8Array, width: number, height: number): Diff {
  if (actual.length !== expected.length) throw new Error(`size mismatch ${actual.length} vs ${expected.length}`);
  let maxErr = 0, sum = 0, over1 = 0, over2 = 0;
  for (let i = 0; i < actual.length; i++) { const e = Math.abs(actual[i] - expected[i]); if (e > maxErr) maxErr = e; sum += e; if (e > 1) over1++; if (e > 2) over2++; }
  return { maxErr, meanErr: sum / actual.length, over1: over1 / actual.length, over2: over2 / actual.length, ssim: ssim(actual, expected, width, height) };
}
export interface Stats { mean: number[]; sd: number[]; changed: number }
/** Per-channel mean and sd of (output − input), and the fraction of changed channels, RGBA. */
export function deltaStats(out: Uint8Array, input: Uint8Array): Stats {
  const n = out.length / 4, sum = [0, 0, 0, 0], sq = [0, 0, 0, 0]; let changed = 0;
  for (let i = 0; i < out.length; i++) { const d = out[i] - input[i], k = i & 3; sum[k] += d; sq[k] += d * d; if (d !== 0) changed++; }
  const mean = sum.map(s => s / n);
  return { mean, sd: sq.map((s, k) => Math.sqrt(Math.max(0, s / n - mean[k] ** 2))), changed: changed / out.length };
}
/** Fraction of rows whose RGB differs from the input row anywhere — for glitch's horizontal shifts. */
export function changedRows(out: Uint8Array, input: Uint8Array, width: number, height: number): number {
  let rows = 0;
  for (let y = 0; y < height; y++) { for (let i = y * width * 4; i < (y + 1) * width * 4; i += 4) if (out[i] !== input[i] || out[i + 1] !== input[i + 1] || out[i + 2] !== input[i + 2]) { rows++; break; } }
  return rows / height;
}

// ---- parameter variants -------------------------------------------------------------------------------------------
export type Variant = 'defaults' | 'min' | 'max';
const decimals = (step: number) => { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; };
const WARM = (() => {
  const lines: string[] = [];
  for (let b = 0; b < 5; b++) for (let g = 0; g < 5; g++) for (let r = 0; r < 5; r++) lines.push([Math.min(1, r / 4 * 1.1 + 0.02), (g / 4) ** 0.9, b / 4 * 0.8 + 0.1 * r / 4].map(v => v.toFixed(6)).join(' '));
  return encodeLut(importCube(`LUT_3D_SIZE 5\n${lines.join('\n')}\n`));
})();
/** Effect values for a variant: numbers at 10% / 90% of their range (quality knobs, animatable:false, stay at default). */
export function variantParams(id: string, variant: Variant): Record<string, unknown> {
  if (variant === 'defaults') return resolveParams(id, {});
  const effect = effectById(id)!, p: Record<string, unknown> = {};
  for (const def of effect.params) {
    if (def.type === 'number' && def.animatable !== false) {
      const t = variant === 'min' ? 0.1 : 0.9, v = def.min + t * (def.max - def.min), d = decimals(def.step);
      p[def.key] = Math.min(def.max, Math.max(def.min, Number((Math.round((v - def.min) / def.step) * def.step + def.min).toFixed(d))));
    } else if (def.type === 'colorWheel') p[def.key] = variant === 'min' ? { angle: 40, distance: 0.2 } : { angle: 220, distance: 0.9 };
  }
  if (id === 'lut' && variant === 'max') p.lutData = WARM;
  return resolveParams(id, p);
}

// ---- in-page driver -----------------------------------------------------------------------------------------------
export const b64 = (d: Uint8Array | Uint8ClampedArray) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('base64');
export const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** webgpu = adapter name when a device was created; webgpuError = a real failure (anything other than "no adapter"), which fails the WebGPU tests. */
export interface PageInfo { webgpu: string | null; webgpuError: string | null }
interface GpuNavigator { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }
/** Load the app, import the effects module, create the WebGL2 renderer and, when the browser has a WebGPU adapter, the WebGPU one.
 *  No `navigator.gpu` or a null adapter is the only skip; any throw (adapter request, device creation) is recorded and fails the WebGPU tests. */
export async function setupPage(page: Page): Promise<PageInfo> {
  await page.addInitScript('window.__name = (f) => f');
  await page.goto('/');
  return page.evaluate(async () => {
    const p = '/src/effects/index.ts', fx: { createWebGL2Renderer(): unknown; createWebGPURenderer(): Promise<unknown> } = await import(p);
    const w = window as unknown as { __t: { fx: unknown; inputs: Record<string, unknown>; r: Record<string, unknown> } };
    w.__t = { fx, inputs: {}, r: { webgl2: fx.createWebGL2Renderer() } };
    let webgpu: string | null = null, webgpuError: string | null = null;
    try {
      const adapter = await (navigator as unknown as GpuNavigator).gpu?.requestAdapter();
      if (adapter) {
        w.__t.r.webgpu = await fx.createWebGPURenderer();
        const i = adapter.info ?? {};
        webgpu = [i.vendor, i.architecture, i.description].filter(Boolean).join(' / ') || 'adapter';
      }
    } catch (e) { webgpuError = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
    return { webgpu, webgpuError };
  });
}
export async function putInput(page: Page, key: string, raw: Raw) {
  await page.evaluate(({ key, w, h, s }) => {
    const bin = atob(s), data = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    (window as any).__t.inputs[key] = { width: w, height: h, data };
  }, { key, w: raw.width, h: raw.height, s: b64(raw.data) });
}
export const BACKENDS = ['webgl2', 'webgpu'] as const;
export type Backend = (typeof BACKENDS)[number];
export interface RenderArgs { backend: Backend; input: string; stack: { effectId: string; params?: Record<string, unknown>; enabled?: boolean; order?: number }[];
  context?: { timeS?: number; seed?: number; element?: unknown; mask?: Raw }; stage?: 'video-input-709' | 'stacked-alpha' }
export interface RenderOut { data: Uint8Array; width: number; height: number; css: { effectId: string; filter: string; reach: number }[] }
/** Upload the named input, run the stack (or one stage), read RGBA8 back. Width/height are the frame's own, not derived from the input. */
export async function renderInPage(page: Page, a: RenderArgs): Promise<RenderOut> {
  const mask = a.context?.mask, context = a.context ? { ...a.context, mask: undefined } : undefined;
  const r = await page.evaluate(async ({ a, context, mask }) => {
    interface PageFrame { width: number; height: number }
    interface PageRenderer { upload(raw: Raw): PageFrame; render(input: PageFrame, stack: RenderArgs['stack'], ctx: NonNullable<RenderArgs['context']>): { frame: PageFrame; css: RenderOut['css'] };
      runStage(stage: string, input: PageFrame): PageFrame; read(frame: PageFrame): Promise<Uint8Array>; release(frame: PageFrame): void }
    const t = (window as unknown as { __t: { r: Record<Backend, PageRenderer>; inputs: Record<string, Raw> } }).__t, r = t.r[a.backend], raw = t.inputs[a.input];
    const dec = (s: string) => { const bin = atob(s), d = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i); return d; };
    const ctx: NonNullable<RenderArgs['context']> = context ? { ...context } : {};
    if (mask) ctx.mask = { width: mask.width, height: mask.height, data: dec(mask.s) };
    const input = r.upload(raw);
    let frame: PageFrame, css: RenderOut['css'] = [];
    if (a.stage) frame = r.runStage(a.stage, input); else { const out = r.render(input, a.stack, ctx); frame = out.frame; css = out.css; }
    const bytes = await r.read(frame);
    const size = { width: frame.width, height: frame.height };
    if (frame !== input) r.release(frame);
    r.release(input);
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
    return { s: btoa(s), ...size, css };
  }, { a: { backend: a.backend, input: a.input, stack: a.stack, stage: a.stage }, context, mask: mask && { width: mask.width, height: mask.height, s: b64(mask.data) } });
  return { data: unb64(r.s), width: r.width, height: r.height, css: r.css };
}

// ---- shared case runner -------------------------------------------------------------------------------------------
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { effects as oracleEffects } from '../../parity/oracle/effects';
export const DIFF_LOG = path.join(tmpdir(), 't10a-diffs.jsonl');
export const log = (row: Record<string, unknown>) => { try { appendFileSync(DIFF_LOG, JSON.stringify(row) + '\n'); } catch { /* log is best effort */ } };

export const CONTEXT = { timeS: 1.25, seed: 321.5 };
const imageCache = new Map<string, Image>();
const stillCache = new Map<string, Raw>();
/** A still at a given size, cached. Source: a stand-in or the fixture store, then downscaled. */
export function stillAt(id: StillId, width: number, height: number): Raw {
  const key = `${id}@${width}x${height}`;
  let raw = stillCache.get(key);
  if (!raw) {
    const full = stillCache.get(`${id}@full`) ?? (id.endsWith('*') ? (id === 'S3a*' ? standInS3a() : standInS3c()) : loadStill(id as keyof typeof STILL_FILES));
    stillCache.set(`${id}@full`, full);
    raw = downscale(full, width, height); stillCache.set(key, raw);
  }
  return raw;
}
export type StillId = 'S3a*' | 'S3c*' | 'S3a' | 'S3b' | 'S3c';
/** `*` = labelled stand-in generated in the test (no fixture store needed). */
export const STILLS: StillId[] = ['S3a*', 'S3c*', ...(hasStills ? ['S3a', 'S3b', 'S3c'] as StillId[] : [])];
export const STILLS_ALL: StillId[] = ['S3a*', 'S3c*', 'S3a', 'S3b', 'S3c'];

/** Oracle result as RGBA8 (final clamp + round) for one effect. */
export function oracleBytes(id: string, raw: Raw, key: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}): Uint8Array {
  let image = imageCache.get(key);
  if (!image) { image = toImage(raw); imageCache.set(key, image); }
  return quantise(oracleEffects[id](image, { ...params, ...extra }, CONTEXT));
}
const loaded = new WeakMap<Page, Set<string>>();
export async function ensureInput(page: Page, key: string, raw: Raw) {
  let set = loaded.get(page); if (!set) loaded.set(page, set = new Set());
  if (!set.has(key)) { await putInput(page, key, raw); set.add(key); }
}

// ---- rule 6: one per-pixel rule for every single-effect deterministic comparison ----------------------------------
/** Fraction of channels > 1 code ≤ over1, max error ≤ maxErr codes, mean SSIM ≥ ssim. */
export const RULE6 = { over1: 0.001, maxErr: 4, ssim: 0.98 } as const;
export function expectRule6(d: Diff, label: string) {
  expect.soft(d.maxErr, `${label} max error`).toBeLessThanOrEqual(RULE6.maxErr);
  expect.soft(d.over1, `${label} fraction of channels over 1 code`).toBeLessThanOrEqual(RULE6.over1);
  expect.soft(d.ssim, `${label} SSIM`).toBeGreaterThanOrEqual(RULE6.ssim);
}
export const rule6Note = (d: Diff) => `max ${d.maxErr} mean ${d.meanErr.toFixed(4)} >1 ${(d.over1 * 100).toFixed(4)}% ssim ${d.ssim.toFixed(5)}`;

// ---- rule 8: backend is a test dimension; WebGPU cases skip explicitly --------------------------------------------
/** One test per backend. The two tests of a case run in one worker, in order, so a one-entry cache can share the oracle result.
 *  `store: true` marks a case that needs the fixture store: the whole group is skipped at describe level without it. */
export function perBackend(title: string, getInfo: () => PageInfo, body: (backend: Backend) => Promise<void>, opts?: { store?: boolean }) {
  test.describe(title, () => {
    test.describe.configure({ mode: 'default' });
    test.skip(!!opts?.store && !hasStills, 'needs $CUTFRAME_FIXTURES (T00 rule: store cases skip on CI)'); // describe level: hooks never run for store groups on CI
    for (const backend of BACKENDS) {
      test(backend, async () => {
        if (backend === 'webgpu') {
          const info = getInfo();
          if (info.webgpuError) throw new Error(`WebGPU setup failed: ${info.webgpuError}`);
          test.skip(!info.webgpu, 'no WebGPU adapter');
        }
        await body(backend);
      });
    }
  });
}
/** One-entry memo: the last (key, value) pair. */
export function memo1<T>() {
  let last: { key: string; value: T } | undefined;
  return async (key: string, make: () => T | Promise<T>): Promise<T> => {
    if (last?.key === key) return last.value;
    const value = await make(); last = { key, value }; return value;
  };
}

// ---- rule 4: tie-aware comparison. Variants come only from the oracle ---------------------------------------------
export const TIE_EPS = 2 ** -20;
export interface TieSet { base: Uint8Array; variants: Uint8Array[]; tie: Uint8Array; tiePixels: number; pixels: number; variantCount: number; /** rule 4 (one quantity perturbed at a time) tie count and variant count; equal to the above unless combined */ tiePixelsSingle: number; variantCountSingle: number }
/** Oracle base plus perturbed oracle runs; alpha untouched. A pixel is a TIE pixel when any variant differs from the base by more than 1 code.
 *  Quantities: input RGB (one quantity) and each nonzero numeric param. Rule 4 ('single'): each quantity × (1 ± 2^-20) alone.
 *  Rule 4b ('combined', ASCII only): every combination with each quantity independently in {-2^-20, 0, +2^-20} relative (3^n - 1 variants);
 *  the rule-4 tie count is reported alongside. */
export function buildTieSet(id: string, raw: Raw, params: Record<string, unknown>, ctx: { timeS: number; seed: number } = CONTEXT, mode: 'single' | 'combined' = 'single'): TieSet {
  const image = toImage(raw), run = (img: Image, p: Record<string, unknown>) => quantise(oracleEffects[id](img, p, ctx));
  const scaled = (s: number): Image => { const d = Float32Array.from(image.data); for (let i = 0; i < d.length; i += 4) { d[i] *= s; d[i + 1] *= s; d[i + 2] *= s; } return { ...image, data: d }; };
  const numeric = Object.entries(params).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] !== 0).map(e => e[0]);
  const base = run(image, params), variants: Uint8Array[] = [], isSingle: boolean[] = [];
  const nq = 1 + numeric.length;                                   // quantity 0 = input RGB
  const combos = mode === 'combined' ? 3 ** nq : 0;
  if (mode === 'single') {
    for (const s of [1 - TIE_EPS, 1 + TIE_EPS]) { variants.push(run(scaled(s), params)); isSingle.push(true); }
    for (const k of numeric) for (const s of [1 - TIE_EPS, 1 + TIE_EPS]) { variants.push(run(image, { ...params, [k]: (params[k] as number) * s })); isSingle.push(true); }
  } else for (let c = 0; c < combos; c++) {
    const digits: number[] = []; let r = c; for (let q = 0; q < nq; q++) { digits.push((r % 3) - 1); r = Math.floor(r / 3); }
    const nonzero = digits.filter(d => d !== 0).length; if (nonzero === 0) continue;
    const p = { ...params }; numeric.forEach((k, q) => { p[k] = (params[k] as number) * (1 + digits[q + 1] * TIE_EPS); });
    variants.push(run(digits[0] === 0 ? image : scaled(1 + digits[0] * TIE_EPS), p)); isSingle.push(nonzero === 1);
  }
  const pixels = base.length / 4, tie = new Uint8Array(pixels); let tiePixels = 0; const tieS = new Uint8Array(pixels); let tiePixelsSingle = 0;
  variants.forEach((v, vi) => {
    for (let p = 0; p < pixels; p++) {
      const o = p * 4;
      if (Math.abs(v[o] - base[o]) > 1 || Math.abs(v[o + 1] - base[o + 1]) > 1 || Math.abs(v[o + 2] - base[o + 2]) > 1 || Math.abs(v[o + 3] - base[o + 3]) > 1) {
        if (!tie[p]) { tie[p] = 1; tiePixels++; }
        if (isSingle[vi] && !tieS[p]) { tieS[p] = 1; tiePixelsSingle++; }
      }
    }
  });
  return { base, variants, tie, tiePixels, pixels, variantCount: variants.length, tiePixelsSingle, variantCountSingle: isSingle.filter(Boolean).length };
}
export interface TieResult { nonTie: Diff; tieFraction: number; tiePixels: number; tieViolations: number; tieMaxErr: number; offenders: { x: number; y: number; gpu: number[]; oracle: number[] }[] }
/** Non-tie pixels: rule 6 metrics (SSIM over the image with tie pixels replaced by the GPU value, so ties cannot move it).
 *  Tie pixels: the GPU must equal the base or one variant within 1 code per channel (violations = tie pixels where none does). */
export function tieCompare(actual: Uint8Array, ts: TieSet, width: number, height: number): TieResult {
  if (actual.length !== ts.base.length) throw new Error(`size mismatch ${actual.length} vs ${ts.base.length}`);
  const all = [ts.base, ...ts.variants], neutral = Uint8Array.from(ts.base);
  let maxErr = 0, sum = 0, over1 = 0, over2 = 0, channels = 0, violations = 0, tieMaxErr = 0;
  const offenders: TieResult['offenders'] = [];
  for (let p = 0; p < ts.pixels; p++) {
    const o = p * 4;
    if (ts.tie[p]) {
      let best = 255;
      for (const v of all) { const e = Math.max(Math.abs(v[o] - actual[o]), Math.abs(v[o + 1] - actual[o + 1]), Math.abs(v[o + 2] - actual[o + 2]), Math.abs(v[o + 3] - actual[o + 3])); if (e < best) best = e; }
      if (best > 1) {
        violations++;
        if (offenders.length < 40) offenders.push({ x: p % width, y: Math.floor(p / width), gpu: [...actual.subarray(o, o + 4)], oracle: [...ts.base.subarray(o, o + 4)] });
      }
      if (best > tieMaxErr) tieMaxErr = best;
      for (let k = 0; k < 4; k++) neutral[o + k] = actual[o + k];
    } else for (let k = 0; k < 4; k++) {
      const e = Math.abs(actual[o + k] - ts.base[o + k]); channels++; sum += e; if (e > maxErr) maxErr = e; if (e > 1) over1++; if (e > 2) over2++;
      if (e > RULE6.maxErr && offenders.length < 40 && !(offenders.length && offenders[offenders.length - 1].y * width + offenders[offenders.length - 1].x === p)) offenders.push({ x: p % width, y: Math.floor(p / width), gpu: [...actual.subarray(o, o + 4)], oracle: [...ts.base.subarray(o, o + 4)] });
    }
  }
  const nonTie: Diff = { maxErr, meanErr: channels ? sum / channels : 0, over1: channels ? over1 / channels : 0, over2: channels ? over2 / channels : 0, ssim: ssim(actual, neutral, width, height) };
  return { nonTie, tieFraction: ts.tiePixels / ts.pixels, tiePixels: ts.tiePixels, tieViolations: violations, tieMaxErr, offenders };
}

// ---- rule 5: seed-distribution statistics -------------------------------------------------------------------------
/** One fixed list of 16 seeds in [0, 1000): the same for the oracle and the GPU. */
export const SEEDS16 = [3.5, 61.25, 118.75, 187, 249.5, 312.125, 377, 441.75, 503.5, 568, 629.25, 694.5, 757, 821.75, 884.125, 947.5] as const;
export type StatVector = Record<string, number>;
/** The statistics of one (output, input) pair: changed fraction, per-channel mean (RGBA) and sd (RGB), and, for glitch, shifted rows. */
export function statVector(out: Uint8Array, input: Uint8Array, width: number, height: number, withRows: boolean): StatVector {
  const s = deltaStats(out, input), v: StatVector = { changed: s.changed };
  s.mean.forEach((m, k) => { v[`mean${'RGBA'[k]}`] = m; });
  for (let k = 0; k < 3; k++) v[`sd${'RGB'[k]}`] = s.sd[k];
  if (withRows) v.rows = changedRows(out, input, width, height);
  return v;
}
const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleSd = (xs: number[]) => { const m = meanOf(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };
export interface DistVerdict { stat: string; meanOracle: number; meanGpu: number; sdOracle: number; sdGpu: number; delta: number; bound: number; pass: boolean; zeroSdMismatch: boolean }
/** Pass when |mean_GPU − mean_oracle| ≤ 3·sqrt((SD_o² + SD_g²)/n), mean and (sample, n−1) SD taken over the seeds. No epsilon: when both
 *  SDs are 0 the bound is 0, so any difference fails and is flagged `zeroSdMismatch`. */
export function compareDistributions(oracle: StatVector[], gpu: StatVector[]): DistVerdict[] {
  const n = oracle.length;
  return Object.keys(oracle[0]).map(stat => {
    const o = oracle.map(v => v[stat]), g = gpu.map(v => v[stat]), sdOracle = sampleSd(o), sdGpu = sampleSd(g), meanOracle = meanOf(o), meanGpu = meanOf(g);
    const delta = Math.abs(meanGpu - meanOracle), bound = 3 * Math.sqrt((sdOracle ** 2 + sdGpu ** 2) / n);
    return { stat, meanOracle, meanGpu, sdOracle, sdGpu, delta, bound, pass: delta <= bound, zeroSdMismatch: sdOracle === 0 && sdGpu === 0 && delta > 0 };
  });
}
/** Oracle bytes for an explicit context (oracleBytes uses the shared CONTEXT). */
export const oracleWith = (id: string, raw: Raw, params: Record<string, unknown>, ctx: { timeS: number; seed: number }): Uint8Array => quantise(oracleEffects[id](toImage(raw), params, ctx));
