// SPDX-License-Identifier: AGPL-3.0-only
// T12 mask worker (master plan §1c: local, WebGPU first, WASM fallback). Models load from the same-origin root on first use and
// stay loaded for the next request of this worker; terminating the worker is the cancel. Nothing leaves the machine. An adapter can
// exist and still not run these graphs, so a request that fails on WebGPU runs again whole on WASM, which then stays for this worker.
import { frameToRgba, videoFrames } from '../media/decode';
import { autoForeground, boxSeed, previewStrokes, strokeSeed, trackObject } from './engine';
import type { Picture, SourceFrame, Stroke } from './engine';
import { Foreground } from './foreground';
import { MASK_CODES, MaskError } from './protocol';
import type { MaskFrame, MaskInit, MaskPreview, MaskReply, MaskRequest, MaskSource } from './protocol';
import { Sam2 } from './sam2';
import type { Sam2Backend, Sam2Constants } from './sam2';
import type { LocalModels } from '../analysis/models';

type Ort = typeof import('onnxruntime-web');
const SAM = 'diffusionstudio/sam2.1-tiny-video-onnx-fp16/', SEEDS = { person: '10sai-studio/rf-detr-seg-nano-onnx/rfdetr-seg-nano.onnx', salient: 'onnx-community/ISNet-ONNX/onnx/model_fp16.onnx' };
/** Backward tracking decodes this much ahead of its position, then walks it in reverse. */
const BLOCK_US = 2_000_000, SMALL = 512;

let init: MaskInit, ort: Ort | undefined, backend: Sam2Backend = 'webgpu', sam: Sam2 | undefined, fg: Foreground | undefined, vision: LocalModels | undefined;
const say = (reply: MaskReply) => self.postMessage(reply);
const bytes = async (file: string) => {
  const r = await fetch(init.root + file).catch(() => null);
  if (!r?.ok || (r.headers.get('content-type') ?? '').includes('text/html')) throw new MaskError(MASK_CODES.unavailable, 'Smart masks need the local mask models, which are not installed in this browser.');
  return new Uint8Array(await r.arrayBuffer());
};
async function runtime(): Promise<Ort> {
  if (ort) return ort;
  const o = await import('onnxruntime-web/webgpu');
  o.env.wasm.numThreads = 1; o.env.wasm.proxy = false; o.env.wasm.wasmPaths = init.wasm;
  (o.env.webgpu as { powerPreference?: string }).powerPreference = 'high-performance';
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o: object): Promise<unknown> } }).gpu;
  backend = await gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) ? 'webgpu' : 'wasm';
  return ort = o;
}
async function tracker(): Promise<Sam2> {
  if (sam) return sam;
  const o = await runtime(), constants = JSON.parse(new TextDecoder().decode(await bytes(`${SAM}constants.json`))) as Sam2Constants;
  return sam = await Sam2.load(o, { constants, fetch: file => bytes(SAM + file) }, backend);
}
async function seeder(): Promise<Foreground> {
  return fg ??= await Foreground.load(await runtime(), id => bytes(SEEDS[id]), backend);
}
/** T19a's Florence-2, loaded only for a text prompt: the phrase's first box on a picture. */
async function ground(picture: Picture, prompt: string): Promise<[number, number, number, number]> {
  const box = await (vision ??= new (await import('../analysis/models')).LocalModels({ modelRoot: init.root, wasm: init.wasm })).ground(picture, prompt).catch((e: Error) => { throw new MaskError(MASK_CODES.unavailable, e.message); });
  if (!box) throw new MaskError(MASK_CODES.failed, `Nothing on this frame matches "${prompt}". Describe it differently or draw strokes.`);
  return box;
}
const toUs = (seconds: number) => Math.round(seconds * 1e6);
/** Frames from the one on screen at `startUs` up to `endUs`. The decoder's first frame is that frame (it may start a little earlier). */
async function* frames({ blob, rotation }: MaskSource, startUs: number, endUs: number): AsyncGenerator<SourceFrame> {
  for await (const raw of videoFrames(blob, { startS: (startUs + 0.5) / 1e6 })) { // half a µs: a frame's own rounded time finds that frame
    const timeUs = toUs(raw.timestamp);
    if (timeUs >= endUs) return;
    yield { timeUs, picture: frameToRgba(raw, rotation) };
  }
}
/** The frame on screen at `atUs`. */
async function frameAt(source: MaskSource, atUs: number): Promise<SourceFrame> {
  for await (const f of frames(source, atUs, Infinity)) return f;
  throw new MaskError(MASK_CODES.failed, 'That source frame could not be read.');
}
const shrink = ({ data, width, height }: Picture): Picture => {
  const out = new Uint8ClampedArray(4 * SMALL * SMALL), src = new Uint32Array(data.buffer, data.byteOffset, width * height), dst = new Uint32Array(out.buffer);
  for (let y = 0, o = 0; y < SMALL; y++) { const row = Math.floor((y + 0.5) * height / SMALL) * width; for (let x = 0; x < SMALL; x++, o++) dst[o] = src[row + Math.floor((x + 0.5) * width / SMALL)]; }
  return { width: SMALL, height: SMALL, data: out };
};
/** Frames ahead of `atUs`, nearest first, in blocks small enough to hold: shrunken to the tracker's input, which is all it reads. */
async function* backward(source: MaskSource, startUs: number, atUs: number): AsyncGenerator<SourceFrame> {
  for (let end = atUs; end > startUs; end -= BLOCK_US) {
    const block: SourceFrame[] = [], from = Math.max(startUs, end - BLOCK_US);
    for await (const f of frames(source, from, end)) if (f.timeUs >= from || from === startUs) block.push({ timeUs: f.timeUs, picture: shrink(f.picture) });
    yield* block.reverse();
  }
}
const canvasBlob = (width: number, height: number, rgba: Uint8ClampedArray, type: string, quality?: number) => {
  const canvas = new OffscreenCanvas(width, height), g = canvas.getContext('2d')!;
  g.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return canvas.convertToBlob({ type, quality });
};
async function frame(source: MaskSource, atUs: number): Promise<MaskFrame> {
  const { timeUs, picture: { width, height, data } } = await frameAt(source, atUs);
  return { timeUs, width, height, jpeg: await canvasBlob(width, height, data, 'image/jpeg', 0.92) };
}
async function preview(source: MaskSource, atUs: number, strokes: Stroke[]): Promise<MaskPreview> {
  const s = await tracker(), { timeUs, picture } = await frameAt(source, atUs), { width, height } = picture, plane = await previewStrokes(s, picture, strokes, SMALL);
  const rgba = new Uint8ClampedArray(4 * plane.length).fill(255); let kept = 0;
  for (let i = 0; i < plane.length; i++) { rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = plane[i]; if (plane[i]) kept++; } // white = kept (§19)
  return { timeUs, width, height, png: await canvasBlob(width, height, rgba, 'image/png'), area: kept / plane.length };
}
async function unload() {
  const held = [sam, fg];
  sam = fg = undefined;
  for (const h of held) await h?.release().catch(() => undefined);
}
/** A MaskError is the request's own failure on any backend; a failure that also fails on WASM was not the backend's either. */
async function onBackend<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e) {
    if (e instanceof MaskError || backend !== 'webgpu') throw e;
    await unload();
    backend = 'wasm';
    try { return await work(); } catch (again) { await unload(); backend = 'webgpu'; throw again; }
  }
}
self.onmessage = async ({ data }: MessageEvent<{ init: MaskInit } | { id: number; request: MaskRequest }>) => {
  if ('init' in data) { init = data.init; return; }
  const { id, request } = data;
  const progress = (done: number, total: number) => say({ id, kind: 'progress', done, total, backend });
  try {
    if (request.task === 'frame') say({ id, kind: 'done', value: await frame(request.source, request.atUs) });
    else if (request.task === 'preview') say({ id, kind: 'done', value: await onBackend(() => preview(request.source, request.atUs, request.strokes)) });
    else if (request.task === 'auto') {
      const { source, startUs, endUs, total } = request;
      say({ id, kind: 'done', value: await onBackend(async () => autoForeground(await tracker(), await seeder(), frames(source, startUs, endUs), total, SMALL, progress)) });
    } else {
      const { source, atUs, startUs, endUs, total } = request;
      say({ id, kind: 'done', value: await onBackend(async () => {
        const s = await tracker(), seed = request.task === 'track' ? strokeSeed(s, request.strokes, SMALL) : boxSeed(s, picture => ground(picture, request.prompt), SMALL);
        return trackObject(s, seed, frames(source, atUs, endUs), backward(source, startUs, atUs), total, progress);
      }) });
    }
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    say({ id, kind: 'failed', code: typeof err?.code === 'string' ? err.code : MASK_CODES.failed, message: typeof err?.message === 'string' ? err.message : String(e) });
  }
};
