// SPDX-License-Identifier: AGPL-3.0-only
// The mix's sources in the browser: each clip's original file (never the proxy, so preview and export hear the same
// samples), decoded in BLOCK_S blocks at 48 kHz on the absolute source grid (so blocks join sample-exactly whatever window
// asks for them) by an audio source worker (source.worker.ts: decoding and rate conversion stay off the main thread). A
// pool owns one worker and keeps its last MAX_BLOCKS blocks: the preview shares one pool, each export opens its own
// (sourcePool, closed when the export ends).
import type { ProjectStore } from '../store/database';
import type { Asset, RecordData } from '../store/model';
import { forceWasm } from '../media/force-wasm';
import { resolveSource } from '../media/resolver';
import { BLOCK_S, MIX_RATE } from './mix';
import type { AudioSource, SourcePcm } from './mix';
import type { SourceReply, SourceRequest } from './source.worker';

export const MAX_BLOCKS = 24;
export type SourcePool = {
  /** The mix's AudioSource over the store's originals. `asset` answers from the loaded library. */
  source(store: ProjectStore, asset: (id: string) => Asset | undefined): AudioSource;
  /** Forgets the blocks and closes the worker's readers of every asset not in `keep`. */
  release(keep: Set<string>): void;
  /** Forgets every decoded block and closes the worker's readers. */
  clear(): void;
  /** Ends the worker; a block still waiting rejects. */
  close(): void;
};

/** A pool of decoded blocks with its own worker. `wasm` answers whether a new reader decodes through WASM only. */
export function sourcePool(wasm: () => boolean): SourcePool {
  const blocks = new Map<string, Promise<Float32Array[] | null>>(), waiting = new Map<number, { resolve: (d: Float32Array[] | null) => void; reject: (e: Error) => void }>();
  let worker: Worker | null = null, nextId = 0;
  const fail = (e: Error) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); };
  function post(req: SourceRequest) {
    if (!worker) {
      worker = new Worker(new URL('./source.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<SourceReply>) => {
        const r = event.data, w = waiting.get(r.id);
        waiting.delete(r.id);
        if (r.ok) w?.resolve(r.data); else w?.reject(new Error(r.message));
      };
      worker.onerror = event => fail(new Error(event.message || 'The audio source worker failed.'));
    }
    worker.postMessage(req);
  }
  function block(key: string, blob: () => Promise<Blob>, k: number): Promise<Float32Array[] | null> {
    const id = `${key} ${k}`, held = blocks.get(id);
    if (held) { blocks.delete(id); blocks.set(id, held); return held; }
    const made = blob().then(b => new Promise<Float32Array[] | null>((resolve, reject) => {
      const n = nextId++;
      waiting.set(n, { resolve, reject });
      post({ op: 'block', id: n, key, blob: b, k, forceWasm: wasm() });
    }));
    blocks.set(id, made);
    made.catch(() => blocks.delete(id));
    while (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value!);
    return made;
  }
  return {
    source: (store, asset) => async (item: RecordData, startS: number, endS: number): Promise<SourcePcm | null> => {
      const assetId = String(item.metadata?.assetId), a = asset(assetId);
      if (a?.media && !a.media.audio) return null; // probed without a sound track
      const blob = () => resolveSource(store, item, 'export').then(r => r.blob), k0 = Math.floor(startS / BLOCK_S), k1 = Math.floor(endS / BLOCK_S);
      const parts = await Promise.all(Array.from({ length: k1 - k0 + 1 }, (_, i) => block(assetId, blob, k0 + i)));
      if (!parts[0]) return null;
      // Only the frames asked for, on the main thread each chunk: a view inside one block, a copy of the window across an edge.
      const size = BLOCK_S * MIX_RATE, from = Math.floor(startS * MIX_RATE), to = Math.max(from, Math.ceil(endS * MIX_RATE)), at = (i: number) => (k0 + i) * size;
      if (parts.length === 1) return { start: from, data: parts[0].map(plane => plane.subarray(from - at(0), to - at(0))) };
      const data = parts[0].map(() => new Float32Array(to - from));
      parts.forEach((p, i) => p?.forEach((plane, c) => {
        const lo = Math.max(from, at(i)), hi = Math.min(to, at(i) + plane.length);
        if (hi > lo) data[c]?.set(plane.subarray(lo - at(i), hi - at(i)), lo - from);
      }));
      return { start: from, data };
    },
    release(keep) {
      for (const id of [...blocks.keys()]) if (!keep.has(id.slice(0, id.lastIndexOf(' ')))) blocks.delete(id);
      if (worker) post({ op: 'release', keep: [...keep] });
    },
    clear() {
      blocks.clear();
      if (worker) post({ op: 'clear' });
    },
    close() {
      blocks.clear();
      worker?.terminate(); worker = null;
      fail(new Error('The audio source worker was closed.'));
    },
  };
}

// The preview's pool. forceWasm from its own module: importing media/worker-client here, even lazily, loads it and its
// imports at the first Play (a network fetch on a no-entry action, t03-fixtures fixture 13), and a static import pulls it
// into the app chunk.
const preview = sourcePool(forceWasm);
/** The preview's AudioSource over the store's originals. `asset` answers from the editor's loaded library. */
export const storeAudioSource = (store: ProjectStore, asset: (id: string) => Asset | undefined): AudioSource => preview.source(store, asset);
/** Forgets the preview's decoded blocks and closes its worker's readers (the editor detached). */
export const clearAudioSources = () => preview.clear();
