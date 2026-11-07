// SPDX-License-Identifier: AGPL-3.0-only
// T12 auto-foreground seeds (part 3 §44.7): RF-DETR-Seg Nano's person instances (a person wins over the most salient object, BG-P03),
// each taking in ISNet's region where that is the same object (what they carry, BG-P01), else ISNet's salient regions (no person: the
// building cluster at 13 s of clip 2). Every seed is a binary mask at the tracker's input size. Models are T12-rfdetr-seg-nano and
// T12-isnet of datasets/manifest.json.
import type { InferenceSession } from 'onnxruntime-web';
import { squarePixels } from './sam2';
import type { Sam2Backend } from './sam2';

type Ort = typeof import('onnxruntime-web');
export type Seed = { mask: Uint8Array; point: [number, number] };
const IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
const ISNET = { mean: [128 / 255, 128 / 255, 128 / 255], std: [256 / 255, 256 / 255, 256 / 255] };
const PERSON_INPUT = 312, PERSON_MASK = 78, PERSON_CLASS = 1, QUERIES = 100, CLASSES = 91, SALIENT_INPUT = 1024;
/** Tracked objects per shot: each costs one tracker pass per frame. */
export const MAX_OBJECTS = 3;
const PERSON_SCORE = 0.3, MIN_AREA = 0.005, SAME_OBJECT = 0.5;

/** A square plane resized bilinearly (a single channel, pixel centres). */
export function resizeSquare(src: ArrayLike<number>, from: number, to: number): Float32Array {
  const out = new Float32Array(to * to), k = from / to;
  for (let y = 0; y < to; y++) {
    const fy = Math.max(0, (y + 0.5) * k - 0.5), y0 = Math.min(from - 1, Math.floor(fy)), y1 = Math.min(from - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < to; x++) {
      const fx = Math.max(0, (x + 0.5) * k - 0.5), x0 = Math.min(from - 1, Math.floor(fx)), x1 = Math.min(from - 1, x0 + 1), tx = fx - x0;
      out[y * to + x] = (src[y0 * from + x0] * (1 - tx) + src[y0 * from + x1] * tx) * (1 - ty) + (src[y1 * from + x0] * (1 - tx) + src[y1 * from + x1] * tx) * ty;
    }
  }
  return out;
}
/** The point deepest inside a mask (two-pass chessboard distance): where a click on the object lands. */
export function deepest(mask: Uint8Array, size: number): [number, number] {
  const d = new Int32Array(size * size);
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) d[i] = !mask[i] ? 0 : x && y ? 1 + Math.min(d[i - 1], d[i - size], d[i - size - 1], d[i - size + 1]) : 1;
  let best = 0, at = 0;
  for (let y = size - 1, i = size * size - 1; y >= 0; y--) for (let x = size - 1; x >= 0; x--, i--) {
    if (!mask[i]) continue;
    if (x < size - 1 && y < size - 1) d[i] = Math.min(d[i], 1 + Math.min(d[i + 1], d[i + size], d[i + size + 1], d[i + size - 1]));
    if (d[i] >= best) { best = d[i]; at = i; }
  }
  return [at % size, Math.floor(at / size)];
}
/** Connected regions of a mask (8-connected), largest first. */
export function regions(mask: Uint8Array, size: number): Uint32Array[] {
  const seen = new Uint8Array(size * size), out: Uint32Array[] = [], stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const members: number[] = []; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!, x = i % size, y = (i - x) / size; members.push(i);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * size + nx;
        if (nx >= 0 && ny >= 0 && nx < size && ny < size && mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    out.push(Uint32Array.from(members));
  }
  return out.sort((a, b) => b.length - a.length);
}
const overlap = (a: Uint8Array, b: Uint8Array) => { let both = 0, either = 0; for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) both++; if (a[i] || b[i]) either++; } return either ? both / either : 0; };
/** Instance logits → seeds: a mask above its floor, unless an earlier (better scoring) one is the same object. */
export function personSeeds(scores: Float32Array, logits: Float32Array, side: number, size: number): Seed[] {
  const seeds: Seed[] = [], order = [...scores.keys()].filter(q => 1 / (1 + Math.exp(-scores[q])) > PERSON_SCORE).sort((a, b) => scores[b] - scores[a]);
  for (const q of order) {
    if (seeds.length === MAX_OBJECTS) break;
    const up = resizeSquare(logits.subarray(q * side * side, (q + 1) * side * side), side, size), mask = Uint8Array.from(up, v => v > 0 ? 1 : 0);
    if (mask.reduce((n, v) => n + v, 0) < MIN_AREA * mask.length || seeds.some(s => overlap(s.mask, mask) > SAME_OBJECT)) continue;
    seeds.push({ mask, point: deepest(mask, size) });
  }
  return seeds;
}
/** Probabilities → seeds: the largest regions above the area floor. Flat colour and noise stay far below .5 (BG-P08). */
export function salientSeeds(prob: Float32Array, size: number): Seed[] {
  const seeds: Seed[] = [];
  for (const r of regions(Uint8Array.from(prob, v => v > 0.5 ? 1 : 0), size)) {
    if (seeds.length === MAX_OBJECTS || r.length < MIN_AREA * prob.length) break;
    const mask = new Uint8Array(prob.length); r.forEach(i => { mask[i] = 1; });
    seeds.push({ mask, point: deepest(mask, size) });
  }
  return seeds;
}
/** A person's mask stops at the person; the salient region that is the same object holds their rifle and pack too. */
export function withCarried(people: Seed[], prob: Float32Array, size: number): Seed[] {
  const salient = salientSeeds(prob, size);
  return people.map(p => { const same = salient.find(s => overlap(s.mask, p.mask) > SAME_OBJECT); return same ? { ...p, mask: p.mask.map((v, i) => v | same.mask[i]) } : p; });
}

export class Foreground {
  private constructor(private ort: Ort, private person: InferenceSession, private salient: InferenceSession) {}
  static async load(ort: Ort, fetchFile: (id: 'person' | 'salient') => Promise<Uint8Array>, backend: Sam2Backend) {
    const open = async (id: 'person' | 'salient') => ort.InferenceSession.create(await fetchFile(id), { executionProviders: [backend] });
    const person = await open('person');
    try { return new Foreground(ort, person, await open('salient')); } catch (e) { await person.release().catch(() => undefined); throw e; }
  }
  async release() { await this.person.release(); await this.salient.release(); }
  private tensor(rgba: Uint8ClampedArray, width: number, height: number, size: number, { mean, std }: typeof IMAGENET) {
    return new this.ort.Tensor('float32', squarePixels(rgba, width, height, size, mean, std), [1, 3, size, size]);
  }
  /** The seeds of one picture at `size` px: its people with what they carry, else what stands out, else none. */
  async seeds(rgba: Uint8ClampedArray, width: number, height: number, size: number): Promise<Seed[]> {
    const out = await this.person.run({ input: this.tensor(rgba, width, height, PERSON_INPUT, IMAGENET) }), labels = out.labels.data as Float32Array, scores = new Float32Array(QUERIES);
    for (let q = 0; q < QUERIES; q++) scores[q] = labels[q * CLASSES + PERSON_CLASS];
    const people = personSeeds(scores, out.masks.data as Float32Array, PERSON_MASK, size);
    const result = await this.salient.run({ [this.salient.inputNames[0]]: this.tensor(rgba, width, height, SALIENT_INPUT, ISNET) });
    const prob = resizeSquare(result[this.salient.outputNames[0]].data as Float32Array, SALIENT_INPUT, size);
    return people.length ? withCarried(people, prob, size) : salientSeeds(prob, size);
  }
}
