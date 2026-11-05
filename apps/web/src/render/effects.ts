// SPDX-License-Identifier: AGPL-3.0-only
// The effect path's GPU stage (findings part 5 §53.4.1 step 4, part 4 §48): the item canvas → T10a's effect chain → a canvas
// the compositor draws into the box, synchronous like the compositor. Preview and capture run the chain on WebGPU when the
// browser grants a hardware adapter and a device (master plan l.38, T10 fix round 1 B2; a fallback adapter is refused, CI
// fix 1), else on WebGL2; WebGL2 also draws while the
// device is being requested and once a device loss is reported (`device.lost` settled; a new device is then requested). A
// frame drawn between a loss and its report is blank: the stage repaints and capture redraws when the report comes
// (onEffectsBackendChange, effectsDeviceLosses; fix round 2 N5). Both backends run the same maths and are tested against the
// same oracle. Both canvases keep premultiplied alpha, as Xapp's export canvas does (part 4 §48 0.4): opaque pixels are
// exact, keyer and halftone output (premultiplied) composites as keyed, and straight output on a semi-transparent pixel
// reads too bright, as in the export (the reference). Drawing either canvas is synchronous; only the device request is
// async. With neither backend, or a source that taints the canvas, the item is not drawn: the stage returns the error code
// (fix round 2 B3), and a failed WebGL2 context creation is tried again after GL_RETRY_MS instead of for the whole session.
import { createWebGL2Renderer, type WebGL2Backend } from '../effects/webgl2';
import { createWebGPURenderer, webgpuAvailable, type WebGPUBackend } from '../effects/webgpu';
import type { BackendKind, EffectInstance, EffectRenderer, RenderContext } from '../effects/renderer';

type Gl = { r: EffectRenderer & { gpu: WebGL2Backend }; canvas: OffscreenCanvas; read: WebGLFramebuffer };
type Gpu = { r: EffectRenderer & { gpu: WebGPUBackend }; canvas: OffscreenCanvas; ctx: GPUCanvasContext };
const TEX_COPY_DST = 2, TEX_RENDER = 16; // GPUTextureUsage
/** A WebGL2 context that could not be created is asked for again on the first frame this long after the failure. */
export const GL_RETRY_MS = 1000;
let gl: Gl | null | undefined, glRetryAt = 0;
/** undefined: not requested yet (or lost); a promise: the adapter and device are being requested; null: no WebGPU here. */
let gpu: Gpu | Promise<void> | null | undefined;
/** Why an adapter the browser granted is not used (CI fix 1); null otherwise. */
let refusal: string | null = null;
let mode: 'auto' | 'webgl2' = 'auto', last: BackendKind | null = null, losses = 0;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

/** Why the stage could not draw an item, as the error codes appendix gives it (l.339 WEBGL_UNSUPPORTED, l.327
 *  CANVAS_TAINTED: category, recovery, and a sentence in the sense of its dialog text). The item is not drawn. */
export type EffectFailure = 'WEBGL_UNSUPPORTED' | 'CANVAS_TAINTED';
export const EFFECT_FAILURES: Record<EffectFailure, { category: string; recovery: string; message: string }> = {
  WEBGL_UNSUPPORTED: { category: 'precondition', recovery: 'user_fixable', message: 'This browser has neither WebGL2 nor WebGPU. Use a current Chrome, Edge or Safari with hardware acceleration on.' },
  CANVAS_TAINTED: { category: 'system_error', recovery: 'our_bug', message: 'The frame could not be read back: a cross-origin picture tainted the canvas. That is our bug.' },
};
/** A SecurityError: the browser refused to read a tainted canvas (upload or readback). */
export const isTaint = (e: unknown) => (e as { name?: unknown } | null)?.name === 'SecurityError';

function webgl(): Gl | null {
  if (gl && gl.r.gpu.gl.isContextLost()) gl = undefined;
  if (gl === null && performance.now() >= glRetryAt) gl = undefined;
  if (gl !== undefined) return gl;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    gl = context ? { r: createWebGL2Renderer(context), canvas, read: context.createFramebuffer()! } : null;
  } catch { gl = null; }
  if (!gl) glRetryAt = performance.now() + GL_RETRY_MS;
  return gl;
}

/** The WebGPU stage once its device is ready; the first call starts the request. */
function webgpu(): Gpu | null {
  if (gpu === undefined) gpu = requestDevice();
  return gpu instanceof Promise ? null : gpu;
}

async function requestDevice(): Promise<void> {
  try {
    const adapter = webgpuAvailable() ? await navigator.gpu.requestAdapter() : null;
    if (!adapter) { gpu = null; return; }
    // CI fix 1: on a fallback (software) adapter, Linux SwiftShader in headless Chromium, the first frame on the webgpu canvas
    // resets the GPU process (WebGL2 contexts are lost, a new one fails for ~200 ms) and reaches a 2D canvas as 0,0,0,0.
    if (adapter.info?.isFallbackAdapter) { refusal = `fallback adapter ${adapter.info.vendor} ${adapter.info.architecture}`; gpu = null; return; }
    const device = await adapter.requestDevice(), canvas = new OffscreenCanvas(1, 1), ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) { device.destroy(); gpu = null; return; }
    ctx.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied', usage: TEX_RENDER | TEX_COPY_DST });
    const g: Gpu = { r: await createWebGPURenderer(device), canvas, ctx };
    gpu = g;
    changed();
    void device.lost.then(() => { if (gpu !== g) return; gpu = undefined; losses++; changed(); });
  } catch { gpu = null; }
}

/** Runs the effect stack over `source` (the W × H item canvas). Returns a canvas holding the result upright, valid until the
 *  next call; WEBGL_UNSUPPORTED when neither WebGPU nor WebGL2 can draw now; CANVAS_TAINTED when the source is tainted. */
export function runEffects(source: OffscreenCanvas, stack: EffectInstance[], context: RenderContext): OffscreenCanvas | EffectFailure {
  try {
    const g = mode === 'auto' ? webgpu() : null;
    if (g) return onWebgpu(g, source, stack, context);
    const w = webgl();
    return w ? onWebgl(w, source, stack, context) : 'WEBGL_UNSUPPORTED';
  } catch (e) {
    if (isTaint(e)) return 'CANVAS_TAINTED';
    throw e;
  }
}

function onWebgl(w: Gl, source: OffscreenCanvas, stack: EffectInstance[], context: RenderContext): OffscreenCanvas {
  const { r, canvas } = w, gl = r.gpu.gl, { width, height } = source;
  const input = r.upload(source), { frame } = r.render(input, stack, context);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  // The frame holds the bottom row first, as the default framebuffer does: a straight blit lands upright.
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, w.read);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, frame.texture as WebGLTexture, 0);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.disable(gl.SCISSOR_TEST);
  gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  r.release(input);
  if (frame !== input) r.release(frame);
  last = 'webgl2';
  return canvas;
}

function onWebgpu(g: Gpu, source: OffscreenCanvas, stack: EffectInstance[], context: RenderContext): OffscreenCanvas {
  const { r, canvas, ctx } = g, device = r.gpu.device, { width, height } = source;
  const input = r.upload(source), { frame } = r.render(input, stack, context);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  // The final frame and the canvas texture are both rgba8unorm with the top row first: a straight copy lands upright.
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture({ texture: frame.texture as GPUTexture }, { texture: ctx.getCurrentTexture() }, [width, height]);
  device.queue.submit([encoder.finish()]);
  r.release(input);
  if (frame !== input) r.release(frame);
  last = 'webgpu';
  return canvas;
}

/** Called when the backend of the next frame changes: a WebGPU device became ready or its loss was reported. The paused
 *  stage repaints then (N5: a frame drawn inside the loss window is blank). Returns the unsubscribe function. */
export function onEffectsBackendChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Device losses reported so far: capture redraws a frame when this changed while it was being read back. */
export const effectsDeviceLosses = () => losses;

/** Test switch (fix round 1 B2): 'webgl2' keeps the chain on WebGL2 even with a WebGPU device ready; 'auto' is the rule above.
 *  Resolves once a device request in flight settles, with the backend the next frame uses. */
export async function setEffectsBackend(m: 'auto' | 'webgl2'): Promise<BackendKind | null> {
  mode = m;
  if (m === 'auto') { webgpu(); await gpu; }
  return m === 'auto' && webgpu() ? 'webgpu' : webgl() ? 'webgl2' : null;
}

/** The backend that drew the last effect frame (null before the first one). */
export const effectsBackend = (): BackendKind | null => last;
/** Why the browser's WebGPU adapter is not used (CI fix 1: a fallback adapter), or null. */
export const webgpuRefusal = (): string | null => refusal;

/** Test hook: destroys the WebGPU device, as a device loss does. The device is destroyed before the first await, so a caller
 *  that does not await draws its next frame inside the loss window. */
export async function loseEffectsDevice(): Promise<void> {
  if (!gpu || gpu instanceof Promise) return;
  const device = gpu.r.gpu.device;
  device.destroy();
  await device.lost;
}
