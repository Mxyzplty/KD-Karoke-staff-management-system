// SPDX-License-Identifier: AGPL-3.0-only
// Preview decoder pool (findings §5): clamp(⌊hardwareConcurrency / 2⌋, 3, 6) module workers (decoder.worker.ts), started
// together on first use; request caching, in-flight reuse and timeouts. A source sticks to one worker so its stream stays
// open. Decoded frames are kept in a byte-budget LRU, each valid for the request interval of its pick (§53.3.1).
// Provisional, not Xapp parity: the 5 s / 8 s reading (5 s per request, 8 s for a source's first request, which opens it),
// the cache budget, and the timeout message. A timeout or a worker failure restarts the worker; the requests it fails carry
// details.transient, so a caller may ask once more (the restarted worker reopens the source).
import { mediaError } from '../media/codes';
import { mergeStackedAlpha } from './merge-pool';
import type { DecodeReply, DecodeRequest } from './decoder.worker';

export const decoderCount = (cores = globalThis.navigator?.hardwareConcurrency || 4) => Math.min(6, Math.max(3, Math.floor(cores / 2)));
export const REQUEST_TIMEOUT_MS = 5000, OPEN_TIMEOUT_MS = 8000;
/** A source to decode: `key` names it (asset + proxy/original); stacked-alpha sources go through the merge pool. */
export type SourceRef = { key: string; blob: Blob; rotation: 0 | 90 | 180 | 270; stackedAlpha?: boolean };
/** A decoded frame: `ts` is the picked frame's timestamp in s. */
export type Frame = { bitmap: ImageBitmap; width: number; height: number; ts: number };
type Entry = Frame & { key: string; from: number; to: number; bytes: number; used: number };
type Waiter = { resolve: (r: DecodeReply & { ok: true }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Slot = { worker: Worker; waiting: Map<number, Waiter>; opened: Set<string>; keys: number };

let slots: Slot[] = [], ids = 0, clock = 0, budget = 256 * 2 ** 20, bytes = 0;
const KEEP = 16;
const affinity = new Map<string, Slot>(), inflight = new Map<string, Promise<Frame>>(), entries: Entry[] = [];
export const decoderStats = { workers: 0, requests: 0, hits: 0, reused: 0, timeouts: 0, evicted: 0 };
/** Test hooks. timeouts: the next `timeouts` requests are not sent and time out at once (the real timeout and restart path).
 *  poolDelayMs: decodes take turns, one per poolDelayMs across the pool, before their request is sent (a pool slower than
 *  real time; cache hits are not slowed). Read at each turn, so setting it back to 0 drains the waiting decodes at once. */
export const decoderFaults = { timeouts: 0, poolDelayMs: 0 };
let paced: Promise<unknown> = Promise.resolve();
/** A failure from a timeout or a worker restart, not from the source: one more request may succeed. */
export const transientDecodeError = (e: unknown) => (e as { details?: { transient?: boolean } })?.details?.transient === true;
let forceWasm: (() => boolean) | null = null;

function spawn(i: number) {
  const slot: Slot = { worker: new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' }), waiting: new Map(), opened: new Set(), keys: 0 };
  slot.worker.onmessage = (e: MessageEvent<DecodeReply>) => {
    const w = slot.waiting.get(e.data.id);
    if (!w) return;
    slot.waiting.delete(e.data.id); clearTimeout(w.timer);
    if (e.data.ok) w.resolve(e.data); else w.reject(mediaError(e.data.code ?? 'DECODE_ERROR', e.data.message));
  };
  slot.worker.onerror = event => { event.preventDefault(); restart(slot, event.message || 'The decoder worker failed.'); };
  slots[i] = slot;
}
/** A hung or failed worker is replaced; its requests fail and its sources reopen on another request. */
function restart(slot: Slot, message: string) {
  const i = slots.indexOf(slot);
  if (i < 0) return;
  slot.worker.terminate();
  for (const [key, s] of affinity) if (s === slot) affinity.delete(key);
  for (const w of slot.waiting.values()) { clearTimeout(w.timer); w.reject(mediaError('DECODE_ERROR', message, { transient: true })); }
  spawn(i);
}
function slotFor(key: string): Slot {
  if (!slots.length) { for (let i = 0; i < decoderCount(); i++) spawn(i); decoderStats.workers = slots.length; }
  let slot = affinity.get(key);
  if (!slot) { slot = slots.reduce((a, b) => b.keys < a.keys || b.keys === a.keys && b.waiting.size < a.waiting.size ? b : a); slot.keys++; affinity.set(key, slot); }
  return slot;
}
function request(src: SourceRef, timeS: number): Promise<DecodeReply & { ok: true }> {
  const slot = slotFor(src.key), id = ++ids, first = !slot.opened.has(src.key), limit = first ? OPEN_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const hang = decoderFaults.timeouts > 0;
  if (hang) decoderFaults.timeouts--;
  decoderStats.requests++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { decoderStats.timeouts++; restart(slot, `Frame decoding timed out after ${limit / 1000} s.`); }, hang ? 0 : limit);
    slot.waiting.set(id, { resolve: r => { slot.opened.add(src.key); resolve(r); }, reject, timer });
    const message: DecodeRequest = { id, key: src.key, blob: src.blob, timeS, rotation: src.rotation, forceWasm: forceWasm?.() ?? false, raw: !!src.stackedAlpha };
    if (!hang) slot.worker.postMessage(message);
  });
}

const lookup = (key: string, ms: number) => entries.find(e => e.key === key && e.from <= ms && ms < e.to);
function insert(e: Entry) {
  entries.push(e); bytes += e.bytes;
  // Least recently used first; the KEEP newest stay (the frames being drawn are among them).
  const order = [...entries].sort((a, b) => a.used - b.used);
  while (bytes > budget && order.length > KEEP) {
    const old = order.shift()!;
    entries.splice(entries.indexOf(old), 1); bytes -= old.bytes; old.bitmap.close(); decoderStats.evicted++;
  }
}
/** The source frame shown at source time `ms` if it is decoded already (synchronous, for the playback paint; not counted). */
export function cachedFrame(key: string, ms: number): Frame | undefined {
  const hit = lookup(key, ms);
  if (hit) hit.used = ++clock;
  return hit;
}
/** The source frame shown at source time `ms` (the export pick). */
export async function decodeFrame(src: SourceRef, ms: number): Promise<Frame> {
  const hit = lookup(src.key, ms);
  if (hit) { hit.used = ++clock; decoderStats.hits++; return hit; }
  const flight = `${src.key}@${ms}`, running = inflight.get(flight);
  if (running) { decoderStats.reused++; return running; }
  const job = (async () => {
    if (!forceWasm) forceWasm = (await import('../media/worker-client')).forceWasm;
    if (decoderFaults.poolDelayMs) await (paced = paced.then(() => new Promise(r => setTimeout(r, decoderFaults.poolDelayMs))));
    const r = await request(src, ms / 1000);
    let { bitmap, width, height } = r;
    if (src.stackedAlpha) ({ bitmap, width, height } = await mergeStackedAlpha(r.data!, width, height));
    // Another request may have filled the same interval meanwhile.
    const again = lookup(src.key, ms);
    if (again) { bitmap!.close(); again.used = ++clock; return again; }
    const e: Entry = { key: src.key, bitmap: bitmap!, width, height, ts: r.ts, from: r.first ? -Infinity : r.ts * 1000 - 0.1, to: r.nextTs === null ? Infinity : r.nextTs * 1000 - 0.1, bytes: width * height * 4, used: ++clock };
    insert(e);
    return e;
  })();
  inflight.set(flight, job);
  try { return await job; } finally { inflight.delete(flight); }
}
/** Cache budget in bytes (tests); evicts at the next insert. */
export const setDecoderCacheBudget = (b: number) => { budget = b; };
export const decoderCacheBytes = () => bytes;
/** Drops the frames of one source (its media changed) or of all sources. */
export function dropFrames(key?: string) {
  for (let i = entries.length - 1; i >= 0; i--) if (!key || entries[i].key === key) { bytes -= entries[i].bytes; entries[i].bitmap.close(); entries.splice(i, 1); }
}
/** Ends every worker and empties the cache (tests, project close). */
export function closeDecoderPool() {
  dropFrames();
  for (const s of slots) { s.worker.terminate(); for (const w of s.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('The decoder pool was closed.')); } }
  slots = []; affinity.clear(); decoderStats.workers = 0;
}
