// SPDX-License-Identifier: AGPL-3.0-only
// The one T15 entry point: input texture + ordered stack with resolved values → output texture (+ the CSS chain that
// runs after it). Backend-neutral; webgl2.ts and webgpu.ts implement the GPU passes.
import { cssChain, isCssEffect, type CssFilter } from './css';
import { effectById } from './registry';
import type { EffectDefinition, ParamValues } from './schema';
import { auxFor, extrasFor, packUniforms, recolorActive, type AuxTable, type MaskImage, type RecolorElement } from './uniforms';
import { resolveParams } from './validate';

export type BackendKind = 'webgl2' | 'webgpu';

/** A GPU image. `format` rgba8 = 8-bit (uploads and final passes), rgba16f = half-float intermediate (§48). */
export interface Frame { width: number; height: number; format: 'rgba8' | 'rgba16f'; texture: unknown }

/** Straight RGBA8 pixels, top row first (ImageData fits), or anything the browser can upload as a texture. */
export type PixelSource = { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
  | ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement | HTMLVideoElement | VideoFrame;

/** One stack entry as T03 stores it. Disabled entries are skipped; `order` sorts (stack position when absent). */
export interface EffectInstance { effectId: string; params?: Record<string, unknown>; enabled?: boolean; order?: number }

export interface RenderContext {
  /** Seconds since the item's start (scanlines, film grain). Default 0. */
  timeS?: number;
  /** Per-render random value in [0, 1000) for glitch and VHS. Default: a fresh random value per render() call. */
  seed?: number;
  /** Element data of an image item; an active palette puts a recolor pass first (§49.19). */
  element?: RecolorElement;
  /** Matte for bg-removal (its alpha is the mask); without one the bg-removal pass is dropped (§49.20). */
  mask?: MaskImage;
}

export interface RenderResult {
  /** RGBA8, input size. Straight alpha, except after the premultiplied passes (color-key, luma-key, bg-removal, halftone). */
  frame: Frame;
  /** CSS effects in stack order, to run after the GPU chain (css.ts applyCssChain). */
  css: CssFilter[];
}

/** One fragment pass. `program` = effect id, transport stage id or 'identity'. */
export interface PassSpec { program: string; uniforms: Float32Array; aux?: AuxTable; width: number; height: number; final: boolean }

export interface Backend {
  readonly kind: BackendKind;
  upload(source: PixelSource): Frame;
  pass(input: Frame, spec: PassSpec): Frame;
  read(frame: Frame): Promise<Uint8Array>;
  release(frame: Frame): void;
  dispose(): void;
}

export interface EffectRenderer {
  readonly backend: BackendKind;
  /** Upload pixels as an rgba8 frame (the caller releases it). */
  upload(source: PixelSource): Frame;
  /** Run the WebGL part of a stack over `input` (not released). Returns a new rgba8 frame plus the CSS chain. */
  render(input: Frame, stack: EffectInstance[], context?: RenderContext): RenderResult;
  /** A transport stage before the chain: BT.709 input re-encode, or stacked-alpha unpack (output width ⌊W/2⌋). */
  runStage(id: 'video-input-709' | 'stacked-alpha', input: Frame): Frame;
  /** RGBA8 bytes, top row first. */
  read(frame: Frame): Promise<Uint8Array>;
  release(frame: Frame): void;
  dispose(): void;
}

interface Step { effect: EffectDefinition; values: ParamValues }

/** The GPU passes of a stack, in order: recolor first when the element asks for it, then the enabled WebGL entries. */
export function gpuSteps(stack: EffectInstance[], context: RenderContext = {}): Step[] {
  const steps: Step[] = [];
  if (recolorActive(context.element)) steps.push({ effect: effectById('recolor')!, values: {} });
  for (const e of orderedEnabled(stack)) {
    const effect = effectById(e.effectId);
    if (!effect || effect.renderType !== 'webgl' || effect.id === 'recolor') continue;
    if (effect.id === 'bg-removal' && !context.mask) continue;
    steps.push({ effect, values: resolveParams(effect.id, e.params ?? {}) });
  }
  return steps;
}

function orderedEnabled(stack: EffectInstance[]): EffectInstance[] {
  return stack.map((e, i) => ({ e, i })).filter(({ e }) => e.enabled !== false)
    .sort((a, b) => (a.e.order ?? a.i) - (b.e.order ?? b.i) || a.i - b.i).map(({ e }) => e);
}

export function createRenderer(backend: Backend): EffectRenderer {
  return {
    backend: backend.kind,
    upload: source => backend.upload(source),
    render(input, stack, context = {}) {
      const timeS = context.timeS ?? 0, seed = context.seed ?? Math.random() * 1000;
      const steps = gpuSteps(stack, context);
      let frame = input;
      const run = (program: string, effect: EffectDefinition | undefined, values: ParamValues, final: boolean, aux?: AuxTable) => {
        const extras = extrasFor(program, values, frame.width, frame.height, context.element, timeS);
        const uniforms = packUniforms(effect, values, { width: frame.width, height: frame.height, timeS, seed, final }, extras, aux);
        const next = backend.pass(frame, { program, uniforms, aux, width: frame.width, height: frame.height, final });
        if (frame !== input) backend.release(frame);
        frame = next;
      };
      if (!steps.length) run('identity', undefined, {}, true);
      steps.forEach((s, i) => run(s.effect.id, s.effect, s.values, i === steps.length - 1, auxFor(s.effect.id, s.values, context.mask)));
      return { frame, css: cssChain(orderedEnabled(stack).filter(e => isCssEffect(e.effectId))) };
    },
    runStage(id, input) {
      const width = id === 'stacked-alpha' ? Math.max(1, Math.floor(input.width / 2)) : input.width, aux = auxFor(id, {});
      const uniforms = packUniforms(undefined, {}, { width, height: input.height, timeS: 0, seed: 0, final: true, sourceWidth: input.width }, [], aux);
      return backend.pass(input, { program: id, uniforms, aux, width, height: input.height, final: true });
    },
    read: frame => backend.read(frame),
    release: frame => backend.release(frame),
    dispose: () => backend.dispose(),
  };
}

export const isRawPixels = (s: PixelSource): s is { width: number; height: number; data: Uint8Array | Uint8ClampedArray } =>
  'data' in s && ArrayBuffer.isView((s as { data: unknown }).data);

/** Pixel size of an uploadable source (video and VideoFrame report their display size). */
export function sourceSize(s: PixelSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement) return { width: s.videoWidth, height: s.videoHeight };
  if (typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement) return { width: s.naturalWidth, height: s.naturalHeight };
  if (typeof VideoFrame !== 'undefined' && s instanceof VideoFrame) return { width: s.displayWidth, height: s.displayHeight };
  return { width: (s as { width: number }).width, height: (s as { height: number }).height };
}

/** Float RGBA (any row order) → RGBA8 by clamp + round, as the final 8-bit write. */
export function quantise(src: Float32Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.round(Math.min(Math.max(src[i], 0), 1) * 255);
  return out;
}
