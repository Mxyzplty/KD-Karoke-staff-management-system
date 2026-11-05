// SPDX-License-Identifier: AGPL-3.0-only
// Time-remap frame cache (part 3 §45.5, §46.11; tickets T04): while a video's Time Remap is on, the source frames for
// remapped playback are pre-extracted with real progress, kept per item and curve, and rebuilt when the curve changes
// (a change aborts the running build). Decoding goes through T14's seams: media/resolver.ts picks the source preview
// uses (Use Proxy), media/decode.ts decodes it (in remap-cache.worker.ts). Showing the frames is T15's (preview).
// Provisional choices, not Xapp parity: the frame set (remapFrameTimes), the in-memory store, the failure text, and
// decoding through T14 instead of Xapp's hidden <video>.
import { useSyncExternalStore } from 'react';
import type { ProjectStore } from '../store/database';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { resolveSource, usesProxy } from '../media/resolver';
import { span } from '../timeline/model';
import { remapKeyframes, sorted, sourceTime } from '../timeline/properties';
import type { RemapCacheMessage, RemapCacheRequest } from './remap-cache.worker';

export type RemapCacheState = { status: 'building'; progress: number } | { status: 'cached'; frames: number } | { status: 'failed'; message: string };
type Entry = { fingerprint: string; state: RemapCacheState; times: number[]; frames: Blob[]; stop: () => void };
const entries = new Map<string, Entry>(), listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
/** Builds started and builds aborted by a curve change or removal (tests). */
export const remapCacheStats = { started: 0, aborted: 0 };

/** Source ms to cache: one frame per project frame (1000 / fps ms) from the lowest to the highest source time the curve
 *  reaches at the clip's project frames (clip end included). */
export function remapFrameTimes(item: RecordData, fps: number): number[] {
  const step = 1000 / fps, length = span(item), n = Math.floor(length / step + 1e-9);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k <= n + 1; k++) { const s = sourceTime(item, Math.min(k * step, length)); lo = Math.min(lo, s); hi = Math.max(hi, s); }
  return Array.from({ length: Math.floor((hi - lo) / step + 1e-9) + 1 }, (_, j) => lo + j * step);
}
const fingerprint = (item: RecordData, fps: number) => JSON.stringify([item.metadata?.assetId, usesProxy(item), fps, span(item), item.sourceDuration,
  sorted(remapKeyframes(item)).map(k => [k.time, k.value, k.easing, k.inHandle, k.outHandle])]);
const cached = (item: RecordData) => item.type === 'video' && remapKeyframes(item).length > 0;

/** Starts, keeps or drops each video's cache to match the document (called on every document change). */
export function syncRemapCaches(store: ProjectStore, doc: ProjectDocument) {
  const live = new Set<string>();
  for (const item of doc.items) {
    if (!cached(item)) continue;
    live.add(item.id);
    const print = fingerprint(item, doc.fps), old = entries.get(item.id);
    if (old?.fingerprint === print) continue;
    old?.stop();
    build(store, item, doc.fps, print);
  }
  let dropped = false;
  for (const [id, e] of entries) if (!live.has(id)) { e.stop(); entries.delete(id); dropped = true; }
  if (dropped) emit();
}
export const clearRemapCaches = (store: ProjectStore) => syncRemapCaches(store, { items: [], fps: 30 } as unknown as ProjectDocument);

function build(store: ProjectStore, item: RecordData, fps: number, print: string) {
  const times = remapFrameTimes(item, fps), frames: Blob[] = [];
  let worker: Worker | undefined, done = false;
  const entry: Entry = { fingerprint: print, state: { status: 'building', progress: 0 }, times, frames,
    stop: () => { if (!done) { done = true; worker?.terminate(); remapCacheStats.aborted++; } } };
  entries.set(item.id, entry); remapCacheStats.started++; emit();
  const set = (state: RemapCacheState) => { if (entries.get(item.id) === entry) { entry.state = state; emit(); } };
  const fail = (message: string) => { if (done) return; done = true; worker?.terminate(); set({ status: 'failed', message: `Frames could not be cached: ${message}` }); };
  void (async () => {
    let request: RemapCacheRequest;
    try {
      // worker-client stays lazy (media/prepare.ts imports it on demand; a static import here would pull it into the app chunk).
      const { forceWasm } = await import('../media/worker-client');
      const source = await resolveSource(store, item, 'preview'), asset = await store.row<Asset>('assets', source.assetId);
      request = { blob: source.blob, times: times.map(t => t / 1000), rotation: source.kind === 'proxy' ? 0 : asset?.media?.video?.rotation ?? 0, width: source.width, height: source.height, forceWasm: forceWasm() };
    } catch (e) { return fail((e as Error).message); }
    if (done) return;
    worker = new Worker(new URL('./remap-cache.worker.ts', import.meta.url), { type: 'module' });
    let filled = 0;
    worker.onmessage = (event: MessageEvent<RemapCacheMessage>) => {
      const m = event.data;
      if (done) return;
      if (m.kind === 'error') return fail(m.message);
      if (m.kind === 'done') { done = true; worker?.terminate(); return set({ status: 'cached', frames: filled }); }
      if (!frames[m.index]) filled++;
      frames[m.index] = m.blob;
      const progress = Math.floor(filled * 100 / times.length);
      if (entry.state.status === 'building' && progress !== entry.state.progress) set({ status: 'building', progress });
    };
    worker.onerror = event => fail(event.message || 'The frame cache worker failed.');
    worker.postMessage(request);
  })();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** The cache state of one item (undefined: no cache). */
export const useRemapCache = (itemId: string) => useSyncExternalStore(subscribe, () => entries.get(itemId)?.state);
/** The cached frames of one item, in source-time order (T15 reads these for remapped playback). */
export function remapFrames(itemId: string): { times: number[]; frames: Blob[] } | null {
  const e = entries.get(itemId);
  return e?.state.status === 'cached' ? { times: e.times, frames: e.frames } : null;
}
