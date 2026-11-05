// SPDX-License-Identifier: AGPL-3.0-only
// Colour/alpha merge pool (findings §13): clamp(CPU cores, 1, 4) inline workers, requests round-robin, recombine the two
// halves of a stacked-alpha frame into one RGBA frame. Any worker error rejects every pending request with
// "Color/alpha merge worker error" (the failed worker is replaced).

/** The packing (findings §6 "alpha video packed side by side"; FX-1: left half straight RGB, right half R = G = B = alpha).
 *  The one place the merge reads its layout from. Which half holds what is our fixture's layout, not a stated Xapp fact. */
export const STACKED_ALPHA = { colour: 'left', alpha: 'right', channel: 0 } as const;
export const mergeCount = (cores = globalThis.navigator?.hardwareConcurrency || 4) => Math.min(4, Math.max(1, cores));

/** out(x, y).rgb = in(colour half).rgb, out.a = in(alpha half).channel. Self-contained: it also runs as worker source. */
export function mergeHalves(src: Uint8ClampedArray, width: number, height: number, colourX: number, alphaX: number, channel: number): Uint8ClampedArray {
  const w = width >> 1, out = new Uint8ClampedArray(w * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, c = (y * width + x + colourX) * 4, a = (y * width + x + alphaX) * 4;
    out[o] = src[c]; out[o + 1] = src[c + 1]; out[o + 2] = src[c + 2]; out[o + 3] = src[a + channel];
  }
  return out;
}
/** Half-frame offsets of the layout above for a frame `width` px wide. */
export const halves = (width: number) => { const w = width >> 1; return STACKED_ALPHA.colour === 'left' ? { colourX: 0, alphaX: width - w } : { colourX: width - w, alphaX: 0 }; };

const SOURCE = `const merge = ${mergeHalves.toString()};
onmessage = async e => {
  const { id, data, width, height, colourX, alphaX, channel, bitmap } = e.data;
  const out = merge(new Uint8ClampedArray(data), width, height, colourX, alphaX, channel), w = width >> 1;
  if (!bitmap) return postMessage({ id, data: out.buffer, width: w, height }, [out.buffer]);
  const image = await createImageBitmap(new ImageData(out, w, height));
  postMessage({ id, bitmap: image, width: w, height }, [image]);
};`;
type Pending = { resolve: (v: { bitmap?: ImageBitmap; data?: ArrayBuffer; width: number; height: number }) => void; reject: (e: Error) => void };
let workers: Worker[] = [], next = 0, ids = 0, url: string | null = null;
const pending = new Map<number, Pending>();
export const mergeStats = { workers: 0, requests: 0, errors: 0 };

function spawn(i: number) {
  url ??= URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = (e: MessageEvent) => { const p = pending.get(e.data.id); pending.delete(e.data.id); p?.resolve(e.data); };
  worker.onerror = event => { event.preventDefault(); fail(i); };
  workers[i] = worker;
}
function fail(i: number) {
  mergeStats.errors++;
  workers[i]?.terminate(); spawn(i);
  const all = [...pending.values()]; pending.clear();
  for (const p of all) p.reject(new Error('Color/alpha merge worker error'));
}
/** Merge one stacked-alpha RGBA frame (`width` = both halves). The buffer is transferred. */
export function mergeStackedAlpha(data: ArrayBuffer, width: number, height: number, out: 'bitmap' | 'data' = 'bitmap') {
  if (!workers.length) { workers = []; for (let i = 0; i < mergeCount(); i++) spawn(i); mergeStats.workers = workers.length; }
  const id = ++ids, worker = workers[next];
  next = (next + 1) % workers.length; mergeStats.requests++;
  return new Promise<{ bitmap?: ImageBitmap; data?: ArrayBuffer; width: number; height: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, data, width, height, ...halves(width), channel: STACKED_ALPHA.channel, bitmap: out === 'bitmap' }, [data]);
  });
}
/** Ends the pool (tests). */
export function closeMergePool() { for (const w of workers) w.terminate(); workers = []; next = 0; mergeStats.workers = 0; }
