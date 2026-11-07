// SPDX-License-Identifier: AGPL-3.0-only
// T12: raster mask frames (findings part 5 §54.6 5.3). One file per raster: 'DMK1', the frame count, every frame's time in µs and
// byte offset, then each frame's 8-bit alpha plane, row-major, top row first, zlib-compressed. A frame reads on its own. The files
// live in the project's own OPFS folder (store/media.ts), so deleting the project removes them and undo finds them back; a raster
// is not an asset. The render is synchronous: rasterPlane answers from a cache and loads behind it. A frame not decoded yet holds
// the raster's last decoded frame while that is cached, and the listeners redraw when it lands (the documented choice in place of
// Xapp's skipped preview frame, §54.12); export and capture wait for the frame with readyRaster and fail rather than draw another
// one. The cache is one budget over every raster (RASTER_CACHE).
import { frameIndex } from './model';
import type { RasterRef } from './model';

export type RasterStore = { writeMask(file: string, data: Blob): Promise<void>; readMask(file: string): Promise<Blob> };
const MAGIC = 0x314b4d44;
const HEADER = 8;
/** §54.6 5.3 limits. */
export const RASTER_LIMITS = { pixels: 4096 * 4096, side: 8192, frames: 1_000_000, frameBytes: 256 * 2 ** 20 };

const through = async (bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }) => new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer());
export const deflate = (plane: Uint8Array) => through(plane, new CompressionStream('deflate') as never);
export const inflate = (zlib: Uint8Array) => through(zlib, new DecompressionStream('deflate') as never);
/** Builds one raster file frame by frame; the frames stay compressed in memory until `blob`. Times must rise. */
export class RasterWriter {
  private times: number[] = []; private frames: Uint8Array[] = [];
  constructor(readonly width: number, readonly height: number) {
    if (width * height > RASTER_LIMITS.pixels || width > RASTER_LIMITS.side || height > RASTER_LIMITS.side) throw new Error(`Raster size ${width} x ${height} is over the limit.`);
  }
  get count() { return this.times.length; }
  async add(timeUs: number, plane: Uint8Array) {
    if (plane.length !== this.width * this.height) throw new Error('Raster frame size does not match the raster.');
    if (this.times.length >= RASTER_LIMITS.frames) throw new Error('Too many raster frames.');
    const zlib = await deflate(plane);
    this.times.push(timeUs); this.frames.push(zlib);
  }
  blob(): Blob {
    const n = this.times.length, head = new DataView(new ArrayBuffer(HEADER)), table = new Float64Array(2 * n + 1);
    head.setUint32(0, MAGIC, true); head.setUint32(4, n, true);
    table.set(this.times);
    let at = 0;
    this.frames.forEach((f, i) => { table[n + i] = at; at += f.length; });
    table[2 * n] = at;
    return new Blob([head.buffer, table.buffer, ...this.frames as BlobPart[]]);
  }
}
type Index = { blob: Blob; timesUs: Float64Array; offsets: Float64Array; body: number };
async function readIndex(blob: Blob): Promise<Index> {
  const head = new DataView(await blob.slice(0, HEADER).arrayBuffer());
  if (head.byteLength < HEADER || head.getUint32(0, true) !== MAGIC) throw new Error('Not a raster mask file.');
  const n = head.getUint32(4, true), table = new Float64Array(await blob.slice(HEADER, HEADER + (2 * n + 1) * 8).arrayBuffer());
  return { blob, timesUs: table.subarray(0, n), offsets: table.subarray(n), body: HEADER + (2 * n + 1) * 8 };
}
async function readFrame(x: Index, k: number) {
  return inflate(new Uint8Array(await x.blob.slice(x.body + x.offsets[k], x.body + x.offsets[k + 1]).arrayBuffer()));
}

/** §54.6 5.3's client cache, across all rasters: 64 MiB of decoded frames, least recently used out first (the newest stays even when
 *  it is bigger than that), 2 decodes at a time, at most 16 pending with those running, 2 s back-off after an error. Its chunk cache and
 *  downloads have no counterpart: a frame is a slice of a local file. */
export const RASTER_CACHE = { bytes: 64 * 2 ** 20, decodes: 2, pending: 16, backoffMs: 2000 };
/** Playback reads ahead, a seek loads one. */
const AHEAD = 12;
/** What asks for a frame: read-ahead waits behind the rest and is refused when the queue is full; the frame on screen goes first and
 *  pushes out the oldest other request; export and capture go first, are never pushed out, and with the queue full of their own kind
 *  wait outside it for a place. */
type Need = 'ahead' | 'shown' | 'must';
type Decode = { e: Open; x: Index; k: number; need: Need; promise: Promise<Uint8Array>; resolve(plane: Uint8Array): void; reject(error: unknown): void };
type Open = { file: string; index?: Index; loading?: Promise<Index>; pending: Map<number, Decode>; failed: Map<number, { until: number; error: unknown }>; last: number | null; error?: unknown };
let store: RasterStore | null = null, used = 0, decoding = 0, generation = 0;
const open = new Map<string, Open>(), listeners = new Set<() => void>(), frames = new Map<string, Uint8Array>(), waiting: Decode[] = [], admitting: Decode[] = [];
const landed = () => { for (const f of [...listeners]) f(); };
const entry = (file: string): Open => { let e = open.get(file); if (!e) open.set(file, e = { file, pending: new Map(), failed: new Map(), last: null }); return e; };
/** The project's store. A new project starts with no decoded frames and an empty queue; decodes under way land nowhere. */
export function useRasterStore(s: RasterStore | null) {
  store = s; open.clear(); frames.clear(); used = 0; decoding = 0; generation++;
  for (const d of [...waiting.splice(0), ...admitting.splice(0)]) d.reject(new Error('The raster mask store changed.'));
}
/** Tests: what the cache holds and does now. */
export const rasterCacheStats = () => ({ bytes: used, running: decoding, pending: waiting.length });
const cacheKey = (e: Open, k: number) => `${e.file}#${k}`;
function cached(e: Open, k: number) {
  const key = cacheKey(e, k), plane = frames.get(key);
  if (plane) { frames.delete(key); frames.set(key, plane); }
  return plane;
}
function keep(key: string, plane: Uint8Array) {
  frames.set(key, plane); used += plane.length;
  for (const [old, p] of frames) { if (used <= RASTER_CACHE.bytes) break; if (old !== key) { frames.delete(old); used -= p.length; } }
}
export const onRasterFrame = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
function indexOf(file: string, e: Open): Promise<Index> {
  if (e.index) return Promise.resolve(e.index);
  if (!store) return Promise.reject(new Error('No raster mask store.'));
  return e.loading ??= store.readMask(file).then(readIndex).then(x => { e.index = x; e.loading = undefined; return x; }, err => { e.loading = undefined; throw err; });
}
function pump() {
  while (admitting.length && !full()) enqueue(admitting.shift()!);
  while (decoding < RASTER_CACHE.decodes && waiting.length) {
    const d = waiting.shift()!, mine = generation;
    decoding++;
    readFrame(d.x, d.k).then(plane => {
      if (mine === generation) keep(cacheKey(d.e, d.k), plane);
      d.resolve(plane);
    }, error => {
      d.e.failed.set(d.k, { until: Date.now() + RASTER_CACHE.backoffMs, error });
      d.reject(error);
    }).finally(() => {
      d.e.pending.delete(d.k);
      if (mine === generation) { decoding--; pump(); }
    });
  }
}
const full = () => decoding + waiting.length >= RASTER_CACHE.pending;
function enqueue(d: Decode) { if (d.need === 'ahead') waiting.push(d); else waiting.unshift(d); }
function load(e: Open, x: Index, k: number, need: Need): Promise<Uint8Array> {
  const have = cached(e, k);
  if (have) return Promise.resolve(have);
  const queued = e.pending.get(k);
  if (queued) {
    const at = waiting.indexOf(queued);
    if (at >= 0 && need !== 'ahead' && queued.need !== 'must') { waiting.splice(at, 1); queued.need = need; enqueue(queued); pump(); }
    return queued.promise;
  }
  const failed = e.failed.get(k);
  if (failed && Date.now() < failed.until) return Promise.reject(failed.error);
  e.failed.delete(k);
  let resolve!: Decode['resolve'], reject!: Decode['reject'];
  const promise = new Promise<Uint8Array>((a, b) => { resolve = a; reject = b; }), d: Decode = { e, x, k, need, promise, resolve, reject };
  if (full()) {
    const out = need === 'ahead' ? -1 : waiting.map(w => w.need !== 'must').lastIndexOf(true);
    if (out >= 0) { const [old] = waiting.splice(out, 1); old.e.pending.delete(old.k); old.reject(new Error('Raster frame dropped from the decode queue.')); }
    else if (need !== 'must') return Promise.reject(new Error('The raster decode queue is full.'));
    else { e.pending.set(k, d); admitting.push(d); return promise; }
  }
  e.pending.set(k, d);
  enqueue(d);
  pump();
  return promise;
}
const shownLast = (e: Open) => e.last === null ? null : cached(e, e.last) ?? null;
/** The raster's plane for a source time: the frame itself, else the last one decoded, else null. Loads behind the answer. */
export function rasterPlane(ref: RasterRef, timeUs: number): Uint8Array | null {
  const e = entry(ref.file), x = e.index;
  if (!x) {
    if (!e.error) void indexOf(ref.file, e).then(landed, err => { e.error = err; console.warn(`Raster mask ${ref.file}: ${String(err)}`); });
    return shownLast(e);
  }
  const k = frameIndex(x.timesUs, timeUs), plane = cached(e, k);
  for (let n = 0; n <= AHEAD && k + n < x.timesUs.length; n++) {
    if (n > 0 && full()) break;
    const fresh = !e.pending.has(k + n);
    if (frames.has(cacheKey(e, k + n)) || (n > 0 && !fresh)) continue;
    const loading = load(e, x, k + n, n === 0 ? 'shown' : 'ahead');
    if (fresh) void loading.then(() => { if (n === 0) { e.last = k; landed(); } }, () => undefined);
  }
  if (plane) e.last = k;
  return plane ?? shownLast(e);
}
/** Export and capture: the exact frame, whatever the cache does afterwards. */
export async function readyRaster(ref: RasterRef, timeUs: number): Promise<Uint8Array> {
  const e = entry(ref.file), x = await indexOf(ref.file, e), k = frameIndex(x.timesUs, timeUs), plane = await load(e, x, k, 'must');
  e.last = k;
  return plane;
}
