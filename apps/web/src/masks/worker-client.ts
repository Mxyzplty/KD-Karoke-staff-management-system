// SPDX-License-Identifier: AGPL-3.0-only
// T12: one mask worker. A request settles with the worker's answer; close terminates the worker, which is the cancel, and a closed
// worker answers every later request with the error it closed on: nothing posted to a dead worker waits for ever.
import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmBinary from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { MASK_CODES, MaskError } from './protocol';
import type { MaskReply, MaskRequest, MaskResult } from './protocol';

export type OnProgress = (done: number, total: number) => void;
export class MaskWorker {
  private worker = new Worker(new URL('./mask.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 0;
  private pending = new Map<number, { resolve(value: MaskResult): void; reject(error: Error): void; progress?: OnProgress }>();
  private ended: Error | null = null;
  get closed() { return !!this.ended; }
  constructor(root = '/models/') {
    this.worker.postMessage({ init: { root, wasm: { mjs: new URL(wasmModule, location.href).href, wasm: new URL(wasmBinary, location.href).href } } });
    this.worker.onmessage = ({ data }: MessageEvent<MaskReply>) => {
      const p = this.pending.get(data.id); if (!p) return;
      if (data.kind === 'progress') { p.progress?.(data.done, data.total); return; }
      this.pending.delete(data.id);
      if (data.kind === 'done') p.resolve(data.value); else p.reject(new MaskError(data.code, data.message));
    };
    this.worker.onerror = event => this.close(new MaskError(MASK_CODES.failed, event.message));
  }
  run<T extends MaskResult>(request: MaskRequest, progress?: OnProgress) {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      if (this.ended) { reject(this.ended); return; }
      this.pending.set(id, { resolve: v => resolve(v as T), reject, progress });
      this.worker.postMessage({ id, request });
    });
  }
  close(error = new MaskError(MASK_CODES.cancelled, 'Cancelled.')) {
    if (this.ended) return;
    this.ended = error;
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}
