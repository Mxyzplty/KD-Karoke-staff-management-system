// SPDX-License-Identifier: AGPL-3.0-only
/** T12: SAM 2.1 Hiera-Tiny video tracker on onnxruntime-web (master plan §1c: local, WebGPU first, WASM fallback).
 *  The graphs are T12-sam2-tiny of datasets/manifest.json; the loop follows their model card: seed = encoder → decoder on
 *  `feats2_no_mem` with points → memory encoder (binarized); each later frame = encoder → memory attention over the bank →
 *  decoder with one padding point → memory encoder. An object score ≤ 0 suppresses the mask in the graph, so an object that
 *  leaves the frame comes back without a new prompt. */
import type { InferenceSession, Tensor } from 'onnxruntime-web';

type Ort = typeof import('onnxruntime-web');
export interface Sam2Files { fetch(file: string): Promise<Uint8Array>; constants: Sam2Constants }
export interface Sam2Constants { image_size: number; memory_frames: number; image_mean: number[]; image_std: number[]; memory_temporal_positional_encoding: number[][] }
export interface Features { feats0: Tensor; feats1: Tensor; feats2: Tensor; feats2NoMem: Tensor; pos: Tensor }
interface Memory { frame: number; tokens: Float32Array; pos: Float32Array }
interface Pointer { frame: number; data: Float32Array }
/** One tracked object: its prompted (cond) memory, the last frames' memories and its object pointers. */
export interface Tracked { cond: Memory; recent: Memory[]; pointers: Pointer[] }
export interface Decoded { logits: Float32Array; size: number; iou: number; score: number }
/** How a region looks: the encoder's coarse features averaged under a mask, unit length; all zero for an empty mask. */
export function signature({ feats2 }: Features, { logits, size }: Decoded): Float64Array {
  const [, channels, height, width] = feats2.dims as number[], data = feats2.data as Float32Array, sum = new Float64Array(channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (logits[Math.floor((y + 0.5) * size / height) * size + Math.floor((x + 0.5) * size / width)] <= 0) continue;
    for (let c = 0; c < channels; c++) sum[c] += data[(c * height + y) * width + x];
  }
  const norm = Math.hypot(...sum) || 1;
  return sum.map(v => v / norm);
}
export type Sam2Backend = 'webgpu' | 'wasm';

const GRAPHS = ['vision_encoder', 'mask_decoder', 'memory_encoder', 'memory_attention', 'pointer_tpos'] as const;
const TOKENS = 1024, MEM_DIM = 64, POINTERS = 16;
const f32 = (ort: Ort, data: Float32Array, dims: number[]) => new ort.Tensor('float32', data, dims);
/** RGBA pixels stretched to a model's square input (bilinear), rescaled and normalised; planar RGB. */
export function squarePixels(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, size: number, [mr, mg, mb]: number[], [sr, sg, sb]: number[]): Float32Array {
  const out = new Float32Array(3 * size * size), step = size * size;
  for (let y = 0; y < size; y++) {
    const fy = Math.max(0, (y + 0.5) * height / size - 0.5), y0 = Math.min(height - 1, Math.floor(fy)), y1 = Math.min(height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < size; x++) {
      const fx = Math.max(0, (x + 0.5) * width / size - 0.5), x0 = Math.min(width - 1, Math.floor(fx)), x1 = Math.min(width - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4, c = (y1 * width + x0) * 4, d = (y1 * width + x1) * 4, at = y * size + x;
      const mix = (i: number) => ((rgba[a + i] * (1 - tx) + rgba[b + i] * tx) * (1 - ty) + (rgba[c + i] * (1 - tx) + rgba[d + i] * tx) * ty) / 255;
      out[at] = (mix(0) - mr) / sr; out[at + step] = (mix(1) - mg) / sg; out[at + 2 * step] = (mix(2) - mb) / sb;
    }
  }
  return out;
}

export class Sam2 {
  private constructor(private ort: Ort, private sessions: Record<(typeof GRAPHS)[number], InferenceSession>, private constants: Sam2Constants, readonly backend: Sam2Backend) {}

  static async load(ort: Ort, files: Sam2Files, backend: Sam2Backend): Promise<Sam2> {
    const sessions = {} as Record<(typeof GRAPHS)[number], InferenceSession>;
    try {
      for (const graph of GRAPHS) sessions[graph] = await ort.InferenceSession.create(await files.fetch(`onnx/${graph}.onnx`), { executionProviders: [backend] });
    } catch (e) {
      await Promise.all(Object.values(sessions).map(s => s.release().catch(() => undefined)));
      throw e;
    }
    return new Sam2(ort, sessions, files.constants, backend);
  }
  async release() { for (const graph of GRAPHS) await this.sessions[graph].release(); }

  async encode(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Promise<Features> {
    const size = this.constants.image_size, pixels = squarePixels(rgba, width, height, size, this.constants.image_mean, this.constants.image_std);
    const out = await this.sessions.vision_encoder.run({ pixel_values: f32(this.ort, pixels, [1, 3, size, size]) });
    return { feats0: out.feats0, feats1: out.feats1, feats2: out.feats2, feats2NoMem: out.feats2_no_mem, pos: out.vision_pos_embed };
  }
  private async decode(f: Features, cond: Tensor, points: [number, number][], labels: number[]) {
    const out = await this.sessions.mask_decoder.run({
      feats0: f.feats0, feats1: f.feats1, feats2_cond: cond,
      input_points: f32(this.ort, Float32Array.from(points.flat()), [1, 1, points.length, 2]),
      input_labels: new this.ort.Tensor('int32', Int32Array.from(labels), [1, 1, labels.length]),
    });
    return { high: out.high_res_mask, score: out.object_score_logits, iou: (out.iou.data as Float32Array)[0], pointer: out.object_pointer };
  }
  private async remember(f: Features, high: Tensor, score: Tensor, binarize: number, frame: number): Promise<Memory> {
    const out = await this.sessions.memory_encoder.run({ feats2: f.feats2, high_res_mask: high, object_score_logits: new this.ort.Tensor('float32', score.data as Float32Array, [1, 1]), binarize: new this.ort.Tensor('float32', Float32Array.of(binarize), []) });
    return { frame, tokens: out.memory_tokens.data as Float32Array, pos: out.memory_pos.data as Float32Array };
  }
  private result(high: Tensor, score: Tensor, iou: number): Decoded {
    return { logits: high.data as Float32Array, size: this.constants.image_size, iou, score: (score.data as Float32Array)[0] };
  }
  /** Prompt an object on `frame` (points in the 512 input's px; labels 1 include, 0 exclude). */
  async seed(f: Features, points: [number, number][], labels: number[], frame = 0): Promise<{ object: Tracked; decoded: Decoded }> {
    const { high, score, iou, pointer } = await this.decode(f, f.feats2NoMem, points, labels);
    const cond = await this.remember(f, high, score, 1, frame);
    return { object: { cond, recent: [], pointers: [{ frame, data: pointer.data as Float32Array }] }, decoded: this.result(high, score, iou) };
  }
  /** An object from a finished mask at the square input size, as SAM 2's add_new_mask: the mask itself is the conditioning memory; a
   *  point inside it gives the object pointer. Keeps a thin or occluded subject whole where a point or box prompt would not. */
  async seedMask(f: Features, mask: Uint8Array, point: [number, number], frame = 0): Promise<Tracked> {
    const size = this.constants.image_size, { score, pointer } = await this.decode(f, f.feats2NoMem, [point], [1]);
    const cond = await this.remember(f, f32(this.ort, Float32Array.from(mask, v => v ? 10 : -10), [1, 1, size, size]), score, 1, frame);
    return { cond, recent: [], pointers: [{ frame, data: pointer.data as Float32Array }] };
  }
  /** Spatial blocks first (cond, then oldest → newest, padded by the newest), then the object pointers split into tokens. */
  private async bank(object: Tracked, frame: number, totalFrames: number) {
    const tpe = this.constants.memory_temporal_positional_encoding, cells = this.constants.memory_frames;
    const blocks: { memory: Memory; row: number }[] = [{ memory: object.cond, row: cells - 1 }];
    for (const memory of object.recent.slice(-(cells - 1))) blocks.push({ memory, row: Math.min(Math.abs(frame - memory.frame), cells - 1) - 1 });
    while (blocks.length < cells) blocks.push(blocks[blocks.length - 1]);
    const spatial = cells * TOKENS * MEM_DIM, words = spatial + POINTERS * 4 * MEM_DIM;
    const memory = new Float32Array(words), pos = new Float32Array(words);
    blocks.forEach(({ memory: m, row }, i) => {
      const at = i * TOKENS * MEM_DIM; memory.set(m.tokens, at);
      for (let t = 0, p = at; t < TOKENS; t++) for (let d = 0; d < MEM_DIM; d++, p++) pos[p] = m.pos[t * MEM_DIM + d] + tpe[row][d];
    });
    const newest = [...object.pointers.slice(1)].reverse().filter(p => frame - p.frame < POINTERS).slice(0, POINTERS - 1), chosen = [object.pointers[0], ...newest];
    while (chosen.length < POINTERS) chosen.push(chosen[chosen.length - 1]);
    const scale = Math.max(1, Math.min(totalFrames, POINTERS) - 1), diffs = Float32Array.from(chosen, p => Math.abs(frame - p.frame) / scale);
    const tpos = (await this.sessions.pointer_tpos.run({ normalized_diffs: f32(this.ort, diffs, [POINTERS]) })).pointer_pos.data as Float32Array;
    chosen.forEach((p, i) => {
      memory.set(p.data, spatial + i * 256);
      for (let k = 0; k < 4; k++) pos.set(tpos.subarray(i * MEM_DIM, (i + 1) * MEM_DIM), spatial + (i * 4 + k) * MEM_DIM);
    });
    const tokens = cells * TOKENS + POINTERS * 4;
    return { memory: f32(this.ort, memory, [tokens, 1, MEM_DIM]), pos: f32(this.ort, pos, [tokens, 1, MEM_DIM]) };
  }
  async track(f: Features, object: Tracked, frame: number, totalFrames: number): Promise<Decoded> {
    const { memory, pos } = await this.bank(object, frame, totalFrames);
    const sequence = (t: Tensor) => { // [1,256,h,w] → [h·w,1,256]
      const [, c, h, w] = t.dims, src = t.data as Float32Array, out = new Float32Array(src.length);
      for (let i = 0; i < h * w; i++) for (let k = 0; k < c; k++) out[i * c + k] = src[k * h * w + i];
      return f32(this.ort, out, [h * w, 1, c]);
    };
    const cond = (await this.sessions.memory_attention.run({ current_vision_features: sequence(f.feats2), current_vision_position_embeddings: sequence(f.pos), memory, memory_pos: pos })).conditioned_feats;
    const { high, score, iou, pointer } = await this.decode(f, cond, [[0, 0]], [-1]);
    object.recent.push(await this.remember(f, high, score, 0, frame));
    if (object.recent.length > this.constants.memory_frames - 1) object.recent.shift();
    object.pointers.push({ frame, data: pointer.data as Float32Array });
    if (object.pointers.length > POINTERS + 1) object.pointers.splice(1, 1);
    return this.result(high, score, iou);
  }
}
