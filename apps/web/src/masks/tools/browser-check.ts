// SPDX-License-Identifier: AGPL-3.0-only
/** Real-model load and speed checks in the browser (T12), behind check.html; driven by tests and by hand. */
import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmBinary from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { prompts } from '../engine';
import type { Raster, Stroke } from '../engine';
import { Foreground } from '../foreground';
import type { RasterRef } from '../model';
import type { AutoResult, MaskFrame, MaskPreview } from '../protocol';
import { rasterPlane, readyRaster, useRasterStore } from '../raster';
import { Sam2, signature, type Sam2Backend, type Sam2Constants } from '../sam2';
import { MaskWorker } from '../worker-client';
import { binary, scoreFrames } from './matte-score';
import { frameToRgba, videoFrames } from '../../media/decode';

const ROOT = '/models/diffusionstudio/sam2.1-tiny-video-onnx-fp16/';
const FOREGROUND = { person: '/models/10sai-studio/rf-detr-seg-nano-onnx/rfdetr-seg-nano.onnx', salient: '/models/onnx-community/ISNet-ONNX/onnx/model_fp16.onnx' };

async function runtime() {
  const ort = await import('onnxruntime-web/webgpu');
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { mjs: new URL(wasmModule, location.href).href, wasm: new URL(wasmBinary, location.href).href };
  (ort.env.webgpu as { powerPreference?: string }).powerPreference = 'high-performance';
  return ort;
}
const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
async function foregroundCheck(backend: Sam2Backend, mediaUrl: string, atS: number[]) {
  const ort = await runtime(), t0 = performance.now(), fg = await Foreground.load(ort, id => bytes(FOREGROUND[id]), backend), t1 = performance.now();
  const blob = await (await fetch(mediaUrl)).blob(), rows: { atS: number; ms: number; areas: number[] }[] = [];
  for (const startS of atS) for await (const raw of videoFrames(blob, { startS })) {
    const frame = frameToRgba(raw), a = performance.now(), seeds = await fg.seeds(frame.data, frame.width, frame.height, 512);
    rows.push({ atS: startS, ms: Math.round(performance.now() - a), areas: seeds.map(s => +(s.mask.reduce((n, v) => n + v, 0) / s.mask.length).toFixed(3)) });
    break;
  }
  await fg.release();
  return { backend, loadMs: Math.round(t1 - t0), rows, adapter: await adapter() };
}
/** A worker job's planes at chosen source times: area and a PNG each (the driver stores them for a look or a score). */
async function sampled(raster: Raster, startUs: number, endUs: number, sampleS: number[]) {
  useRasterStore({ writeMask: async () => undefined, readMask: async () => raster.file });
  const { width, height, frameCount } = raster, ref: RasterRef = { file: 'check', sourceStartUs: startUs, sourceEndUs: endUs, frameCount, width, height, space: { kind: 'source', width, height }, version: 1 };
  const canvas = document.createElement('canvas'), g = canvas.getContext('2d')!; canvas.width = width; canvas.height = height;
  return Promise.all(sampleS.map(async t => {
    await readyRaster(ref, t * 1e6);
    const plane = rasterPlane(ref, t * 1e6)!, image = g.createImageData(width, height);
    plane.forEach((v, i) => { image.data[4 * i] = image.data[4 * i + 1] = image.data[4 * i + 2] = v; image.data[4 * i + 3] = 255; });
    g.putImageData(image, 0, 0);
    return { t, area: +(plane.reduce((n, v) => n + (v ? 1 : 0), 0) / plane.length).toFixed(4), png: canvas.toDataURL('image/png').split(',')[1] };
  }));
}
const clock = (t0: number, marks: number[][]) => (done: number, total: number) => { if (done === 1 || done % 48 === 0 || done === total) marks.push([done, Math.round(performance.now() - t0)]); };
async function autoCheck(mediaUrl: string, startS: number, endS: number, fps: number, sampleS: number[]) {
  const blob = await (await fetch(mediaUrl)).blob(), worker = new MaskWorker(), t0 = performance.now(), marks: number[][] = [], startUs = startS * 1e6, endUs = endS * 1e6;
  const { raster, segments } = await worker.run<AutoResult>({ task: 'auto', source: { blob, rotation: 0 }, startUs, endUs, total: Math.round((endS - startS) * fps) }, clock(t0, marks));
  worker.close();
  return { totalMs: Math.round(performance.now() - t0), segments, marks, frameCount: raster?.frameCount ?? 0, bytes: raster?.file.size ?? 0, samples: raster ? await sampled(raster, startUs, endUs, sampleS) : [] };
}
async function trackCheck(mediaUrl: string, atUs: number, startS: number, endS: number, fps: number, strokes: Stroke[], sampleS: number[]) {
  const blob = await (await fetch(mediaUrl)).blob(), worker = new MaskWorker(), t0 = performance.now(), marks: number[][] = [], startUs = startS * 1e6, endUs = endS * 1e6, source = { blob, rotation: 0 as const };
  const frame = await worker.run<MaskFrame>({ task: 'frame', source, atUs });
  const preview = await worker.run<MaskPreview>({ task: 'preview', source, atUs: frame.timeUs, strokes }), previewMs = Math.round(performance.now() - t0);
  const raster = await worker.run<Raster>({ task: 'track', source, atUs: frame.timeUs, startUs, endUs, total: Math.round((endS - startS) * fps), strokes }, clock(t0, marks));
  worker.close();
  return { previewMs, previewArea: preview.area, totalMs: Math.round(performance.now() - t0), marks, frameCount: raster.frameCount, samples: await sampled(raster, startUs, endUs, sampleS) };
}
async function textCheck(mediaUrl: string, atUs: number, startS: number, endS: number, fps: number, prompt: string, sampleS: number[]) {
  const blob = await (await fetch(mediaUrl)).blob(), worker = new MaskWorker(), t0 = performance.now(), marks: number[][] = [], startUs = startS * 1e6, endUs = endS * 1e6, source = { blob, rotation: 0 as const };
  const { timeUs } = await worker.run<MaskFrame>({ task: 'frame', source, atUs }), raster = await worker.run<Raster>({ task: 'text', source, atUs: timeUs, startUs, endUs, total: Math.round((endS - startS) * fps), prompt }, clock(t0, marks));
  worker.close();
  return { totalMs: Math.round(performance.now() - t0), marks, frameCount: raster.frameCount, samples: await sampled(raster, startUs, endUs, sampleS) };
}
/** One automatic job scored frame by frame against exact alpha (gzip of frames × H × W bytes). */
async function matteCheck(mediaUrl: string, alphaUrl: string, fps: number, frames: number, sampleS: number[]) {
  const blob = await (await fetch(mediaUrl)).blob(), worker = new MaskWorker(), t0 = performance.now(), endUs = frames / fps * 1e6;
  const { raster, segments } = await worker.run<AutoResult>({ task: 'auto', source: { blob, rotation: 0 }, startUs: 0, endUs, total: frames });
  const totalMs = Math.round(performance.now() - t0);
  worker.close();
  if (!raster) return { totalMs, segments, empty: true };
  const alpha = new Uint8Array(await new Response((await fetch(alphaUrl)).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  useRasterStore({ writeMask: async () => undefined, readMask: async () => raster.file });
  const { width, height, frameCount } = raster, ref: RasterRef = { file: 'check', sourceStartUs: 0, sourceEndUs: endUs, frameCount, width, height, space: { kind: 'source', width, height }, version: 1 }, masks: Uint8Array[] = [], truth: Uint8Array[] = [];
  for (let k = 0; k < frames; k++) {
    const timeUs = (k + 0.5) / fps * 1e6;
    await readyRaster(ref, timeUs);
    masks.push(binary(rasterPlane(ref, timeUs)!));
    truth.push(binary(alpha.subarray(k * width * height, (k + 1) * width * height)));
  }
  const score = scoreFrames(masks, truth, width, height), samples = await sampled(raster, 0, endUs, sampleS);
  return { totalMs, segments, frameCount, width, height, ...score, rows: score.rows.map(r => [+r.iou.toFixed(4), +r.f.toFixed(4)]), samples };
}
async function previewCheck(mediaUrl: string, rows: { atS: number; strokes: Stroke[] }[]) {
  const blob = await (await fetch(mediaUrl)).blob(), worker = new MaskWorker(), source = { blob, rotation: 0 as const }, samples = [];
  for (const { atS, strokes } of rows) {
    const { timeUs } = await worker.run<MaskFrame>({ task: 'frame', source, atUs: atS * 1e6 }), t0 = performance.now(), { png, area } = await worker.run<MaskPreview>({ task: 'preview', source, atUs: timeUs, strokes });
    samples.push({ t: atS, area: +area.toFixed(4), ms: Math.round(performance.now() - t0), png: btoa(String.fromCharCode(...new Uint8Array(await png.arrayBuffer()))) });
  }
  worker.close();
  return { samples };
}
/** What the tracker makes of each shot from the seed's memory alone: object score, area, and how like the seed the region is (engine.ts SAME). */
async function gateCheck(backend: Sam2Backend, mediaUrl: string, atS: number, strokes: Stroke[], times: number[]) {
  const ort = await runtime(), constants = await (await fetch(`${ROOT}constants.json`)).json() as Sam2Constants, sam = await Sam2.load(ort, { constants, fetch: file => bytes(ROOT + file) }, backend);
  const blob = await (await fetch(mediaUrl)).blob(), one = async (t: number) => { for await (const raw of videoFrames(blob, { startS: t })) return frameToRgba(raw); throw new Error('no frame'); };
  const first = await one(atS), f0 = await sam.encode(first.data, first.width, first.height), { points, labels } = prompts(strokes, 512, first.width, first.height), seeded = await sam.seed(f0, points, labels);
  const base = signature(f0, seeded.decoded), rows = [];
  for (const t of times) {
    const p = await one(t), f = await sam.encode(p.data, p.width, p.height), object = { ...seeded.object, recent: [], pointers: seeded.object.pointers.slice(0, 1) }, d = await sam.track(f, object, 1, 720);
    rows.push({ t, score: +d.score.toFixed(2), area: +(d.logits.reduce((s, v) => s + (v > 0 ? 1 : 0), 0) / d.logits.length).toFixed(3), cos: +signature(f, d).reduce((s, v, i) => s + v * base[i], 0).toFixed(3) });
  }
  await sam.release();
  return rows;
}
/** One graph alone on one backend: which of the seed models a backend can run, and how fast. */
async function graphCheck(backend: Sam2Backend, id: keyof typeof FOREGROUND, size: number) {
  const ort = await runtime(), t0 = performance.now(), session = await ort.InferenceSession.create(await bytes(FOREGROUND[id]), { executionProviders: [backend] }), t1 = performance.now();
  const input = new ort.Tensor('float32', new Float32Array(3 * size * size).fill(0.1), [1, 3, size, size]), runs: (number | string)[] = [];
  for (let n = 0; n < 3; n++) {
    const a = performance.now();
    try { await session.run({ [session.inputNames[0]]: input }); runs.push(Math.round(performance.now() - a)); } catch (e) { runs.push(String(e).slice(0, 240)); break; }
  }
  await session.release();
  return { id, backend, loadMs: Math.round(t1 - t0), inputs: session.inputNames, outputs: session.outputNames, runs };
}
async function sam2Check(backend: Sam2Backend, mediaUrl: string, frames: number, startS: number) {
  const ort = await runtime();
  const constants = await (await fetch(`${ROOT}constants.json`)).json() as Sam2Constants;
  const t0 = performance.now();
  const sam = await Sam2.load(ort, { constants, fetch: file => bytes(ROOT + file) }, backend);
  const t1 = performance.now();
  const blob = await (await fetch(mediaUrl)).blob(), times = { decode: 0, encode: 0, track: 0 };
  let object: Awaited<ReturnType<Sam2['seed']>>['object'] | undefined, n = 0, seed = 0, area: number[] = [];
  let last = performance.now();
  for await (const raw of videoFrames(blob, { startS })) {
    const frame = frameToRgba(raw), a = performance.now(); times.decode += a - last;
    const f = await sam.encode(frame.data, frame.width, frame.height), b = performance.now();
    if (n > 0) times.encode += b - a;
    let decoded;
    if (!object) { const r = await sam.seed(f, [[350, 200]], [1]); object = r.object; decoded = r.decoded; seed = performance.now() - a; }
    else { decoded = await sam.track(f, object, n, frames); times.track += performance.now() - b; }
    if (n % 30 === 0) area.push(+(decoded.logits.reduce((s, v) => s + (v > 0 ? 1 : 0), 0) / decoded.logits.length).toFixed(3));
    if (++n === frames) break;
    last = performance.now();
  }
  await sam.release();
  return { backend, loadMs: Math.round(t1 - t0), seedMs: Math.round(seed), frames: n, perFrameMs: { decode: +(times.decode / n).toFixed(1), encode: +(times.encode / (n - 1)).toFixed(1), track: +(times.track / (n - 1)).toFixed(1) }, area, adapter: await adapter() };
}
async function adapter() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o: object): Promise<{ info?: { vendor: string; architecture: string; description: string }; features: Set<string> } | null> } }).gpu;
  const a = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description, f16: a.features.has('shader-f16') } : null;
}
Object.assign(window, { t12: { sam2Check, foregroundCheck, graphCheck, autoCheck, trackCheck, textCheck, matteCheck, previewCheck, gateCheck, adapter } });
