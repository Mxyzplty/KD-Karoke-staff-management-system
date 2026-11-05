// SPDX-License-Identifier: AGPL-3.0-only
// T10a effect kernels: registry, queries, parameter validation, LUT baking, CSS filters, Colour block maths and the
// one render entry point for T15 (createEffectRenderer → render(input, stack, context)).
import type { EffectRenderer } from './renderer';
import { createWebGL2Renderer } from './webgl2';
import { createWebGPURenderer, webgpuAvailable } from './webgpu';

export * from './schema';
export * from './registry';
export * from './queries';
export * from './validate';
export * from './lut';
export * from './css';
export * from './colour-block';
export { parseColour, keyColour, oklab, bt709Table, type RGB, type RGBA } from './colour-math';
export { curvesTable, evalCurve } from './curves';
export { packUniforms, auxFor, extrasFor, halftoneExtras, recolorActive, recolorExtras,
  type AuxTable, type FrameConstants, type MaskImage, type RecolorElement } from './uniforms';
export { createRenderer, gpuSteps, quantise, type Backend, type BackendKind, type EffectInstance, type EffectRenderer,
  type Frame, type PassSpec, type PixelSource, type RenderContext, type RenderResult } from './renderer';
export { programSource, hasKernel, GLSL_VERTEX } from './shaders';
export { WebGL2Backend, createWebGL2Renderer } from './webgl2';
export { WebGPUBackend, createWebGPURenderer, webgpuAvailable } from './webgpu';

/** WebGPU when the browser grants a device (unless `prefer` is 'webgl2'), else WebGL2. */
export async function createEffectRenderer(prefer: 'webgpu' | 'webgl2' = 'webgpu'): Promise<EffectRenderer> {
  if (prefer === 'webgpu' && webgpuAvailable()) {
    try { return await createWebGPURenderer(); } catch { /* no adapter or device: fall back */ }
  }
  return createWebGL2Renderer();
}
