// SPDX-License-Identifier: AGPL-3.0-only
// Export decoders (findings §7 frame loop, master plan §1b budgets): T15's decoder worker file (render/decoder.worker.ts,
// unchanged) with the export's own instances, one worker per open source and at most 4 alive. A source opens lazily when
// one of its frames is due within the 2 s prefetch window and its worker ends once no item needs it in that window.
// Prefetch per source = the one frame the worker pulls ahead (≤ 2 s). WebCodecs first, WASM second: T14's videoFrames
// picks by canDecode, and a source whose WebCodecs stream fails is reopened once with forceWasm. A request that times out,
// or a worker that fails (an `error` event, e.g. a worker that could not start under load), restarts the worker once, as
// T15's pool does; a second failure fails the export. A request whose worker is ended under it (the WASM reopen of its
// source) is sent again to the source's new worker. At the cap, a source not needed for the current frame gives up its
// worker (a budget slows the export, it never fails it). After closeAll no worker starts again.
import { mediaError } from '../media/codes';
import { mergeStackedAlpha } from '../render/merge-pool';
import type { DecodeReply, DecodeRequest } from '../render/decoder.worker';
import type { SourceRef } from '../render/decoder-pool';

export const MAX_DECODERS = 4, PREFETCH_S = 2, REQUEST_TIMEOUT_MS = 30_000;
/** Test hooks (as T15's decoderFaults): the next `timeouts` requests are not sent and time out at once (the real path);
 *  `noBackpressure` skips the encoder queue wait, for the sensitivity check of the queue ≤ 2 test only; `noAac` treats
 *  AAC-LC as not encodable, so the Opus fallback (probe.ts negotiateAudio) runs where AAC exists; `failSetup` fails the
 *  export once its sink and output are set up, before the output starts (encode and remux), for the clean-up tests. */
export const exportFaults = { timeouts: 0, noBackpressure: false, noAac: false, failSetup: false };
export type ExportFrame = { bitmap: ImageBitmap; width: number; height: number; ts: number; from: number; to: number };
type Waiter = { resolve: (r: DecodeReply & { ok: true }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Slot = { key: string; worker: Worker; waiting: Map<number, Waiter>; wasm: boolean; used: number; last?: ExportFrame; busy: number };
/** A request whose worker was ended under it (`closed`), or a request after closeAll. */
const closedError = () => Object.assign(new Error('export decoder closed'), { closed: true });
export type DecoderStats = { opened: number; open: number; maxOpen: number; requests: number; reused: number; wasmRetries: number; timeouts: number; maxPrefetchS: number; evictions: number };

export class ExportDecoders {
  readonly stats: DecoderStats = { opened: 0, open: 0, maxOpen: 0, requests: 0, reused: 0, wasmRetries: 0, timeouts: 0, maxPrefetchS: 0, evictions: 0 };
  private slots = new Map<string, Slot>();
  private ids = 0; private clock = 0; private freed: (() => void)[] = []; private closed = false;
  /** Bitmaps no longer cached; closed by sweep() once the frame that may still draw them is composited. */
  private retired: ImageBitmap[] = [];
  constructor(private forceWasm = false, private max = MAX_DECODERS) {}

  private spawn(key: string, wasm: boolean): Slot {
    const slot: Slot = { key, worker: new Worker(new URL('../render/decoder.worker.ts', import.meta.url), { type: 'module' }), waiting: new Map(), wasm, used: ++this.clock, busy: 0 };
    slot.worker.onmessage = (e: MessageEvent<DecodeReply>) => {
      const w = slot.waiting.get(e.data.id); if (!w) return;
      slot.waiting.delete(e.data.id); clearTimeout(w.timer);
      if (e.data.ok) w.resolve(e.data); else w.reject(mediaError(e.data.code ?? 'DECODE_ERROR', e.data.message));
    };
    slot.worker.onerror = event => { event.preventDefault(); this.fail(slot, Object.assign(new Error(event.message || 'The decoder worker failed.'), { transient: true })); };
    this.slots.set(key, slot); this.stats.opened++; this.stats.open = this.slots.size; this.stats.maxOpen = Math.max(this.stats.maxOpen, this.slots.size);
    return slot;
  }
  private fail(slot: Slot, error: Error) { for (const w of slot.waiting.values()) { clearTimeout(w.timer); w.reject(error); } slot.waiting.clear(); this.close(slot.key); }
  /** Ends one source's worker (its stream, decoder and frames go with it). */
  close(key: string) {
    const slot = this.slots.get(key); if (!slot) return;
    this.slots.delete(key); slot.worker.terminate(); if (slot.last) this.retired.push(slot.last.bitmap);
    for (const w of slot.waiting.values()) { clearTimeout(w.timer); w.reject(closedError()); }
    this.stats.open = this.slots.size;
    this.freed.splice(0).forEach(f => f());
  }
  /** Keeps the sources in `needed` (due within the prefetch window) and ends the others. */
  retain(needed: Set<string>) { for (const key of [...this.slots.keys()]) if (!needed.has(key) && !this.slots.get(key)!.busy) this.close(key); }
  /** Closes the bitmaps retired since the last call (after each composited frame). */
  sweep() { for (const b of this.retired.splice(0)) b.close(); }
  closeAll() { this.closed = true; for (const key of [...this.slots.keys()]) this.close(key); this.sweep(); this.freed.splice(0).forEach(f => f()); }
  /** Whether another source can open now without taking a worker from one in use. */
  get hasRoom() { return this.slots.size < this.max; }
  isOpen(key: string) { return this.slots.has(key); }

  /** A worker for `key`, reserved for the caller (busy + 1, so a parallel call cannot evict it): an open one, a new one
   *  under the cap, or the least recently used idle one's place (outside `current` first). */
  private async slotFor(ref: SourceRef, current: Set<string>): Promise<Slot> {
    for (;;) {
      if (this.closed) throw closedError();
      const open = this.slots.get(ref.key); if (open) { open.busy++; return open; }
      if (this.slots.size < this.max) { const s = this.spawn(ref.key, this.forceWasm); s.busy++; return s; }
      const idle = [...this.slots.values()].filter(s => !s.busy).sort((a, b) => Number(current.has(a.key)) - Number(current.has(b.key)) || a.used - b.used)[0];
      if (idle) { this.close(idle.key); this.stats.evictions++; continue; }
      await new Promise<void>(r => this.freed.push(r));
    }
  }
  private request(slot: Slot, ref: SourceRef, timeS: number): Promise<DecodeReply & { ok: true }> {
    const id = ++this.ids, hang = exportFaults.timeouts > 0; this.stats.requests++;
    if (hang) exportFaults.timeouts--;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stats.timeouts++; this.fail(slot, Object.assign(new Error(`Frame decoding timed out after ${REQUEST_TIMEOUT_MS / 1000} s.`), { transient: true })); }, hang ? 0 : REQUEST_TIMEOUT_MS);
      slot.waiting.set(id, { resolve, reject, timer });
      const message: DecodeRequest = { id, key: ref.key, blob: ref.blob, timeS, rotation: ref.rotation, forceWasm: slot.wasm, raw: !!ref.stackedAlpha };
      if (!hang) slot.worker.postMessage(message);
    });
  }
  /** The source frame shown at source time `ms` (the export pick, §53.3.1). `current`: the sources the frame being drawn needs. */
  async frame(ref: SourceRef, ms: number, current: Set<string> = new Set([ref.key])): Promise<ExportFrame> {
    let retried = false, wasm = false;
    for (;;) {
      const slot = await this.slotFor(ref, current);
      slot.used = ++this.clock;
      try {
        const hit = slot.last;
        if (hit && hit.from <= ms && ms < hit.to) { this.stats.reused++; return hit; }
        const r = await this.request(slot, ref, ms / 1000);
        let { bitmap, width, height } = r;
        if (ref.stackedAlpha) ({ bitmap, width, height } = await mergeStackedAlpha(r.data!, width, height));
        this.stats.maxPrefetchS = Math.max(this.stats.maxPrefetchS, Math.max(0, (r.nextTs ?? r.ts) - ms / 1000));
        const f: ExportFrame = { bitmap: bitmap!, width, height, ts: r.ts, from: r.first ? -Infinity : r.ts * 1000 - 0.1, to: r.nextTs === null ? Infinity : r.nextTs * 1000 - 0.1 };
        if (slot.last) this.retired.push(slot.last.bitmap);
        slot.last = f;
        return f;
      } catch (e) {
        // The worker was ended under this request by another caller (the WASM reopen below): ask the source's new worker.
        if ((e as { closed?: boolean }).closed && !this.closed) continue;
        const transient = (e as { transient?: boolean }).transient === true;
        if (transient && !retried) { retried = true; continue; }
        if (transient) throw e;
        // WebCodecs first, WASM second: one retry of this source through the WASM decoder (once per source: a parallel
        // request that failed on the same WebCodecs worker uses the WASM worker already opened).
        if (!slot.wasm && !wasm && (e as { code?: string }).code === 'DECODE_ERROR') {
          wasm = true;
          if (!this.slots.get(ref.key)?.wasm) { this.stats.wasmRetries++; this.close(ref.key); this.spawn(ref.key, true); }
          continue;
        }
        throw e;
      } finally { slot.busy--; if (!slot.busy) this.freed.splice(0).forEach(f => f()); }
    }
  }
}
