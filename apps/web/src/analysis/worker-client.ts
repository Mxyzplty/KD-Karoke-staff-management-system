// SPDX-License-Identifier: AGPL-3.0-only
import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import wasmBinary from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import { AnalysisError } from './types';
import type { ModelOptions } from './models';
import type { AnalysisReply, AnalysisRequest } from './protocol';

/** Own one worker; terminate it to cancel inference and reject every pending request. */
export class AnalysisWorker {
  private worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 0;
  private closed = false;
  private pending = new Map<number, { resolve(value: AnalysisReply & { ok: true }): void; reject(error: Error): void }>();
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<AnalysisReply>) => {
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data); else pending.reject(new AnalysisError(data.error.code, data.error.message, { confidence: data.error.confidence }));
    };
    this.worker.onerror = event => this.close(new AnalysisError('ANALYSIS_WORKER_FAILED', event.message));
    this.worker.onmessageerror = () => this.close(new AnalysisError('ANALYSIS_WORKER_FAILED', 'The worker result could not be decoded.'));
  }
  init(options: Omit<ModelOptions, 'wasm'>) { return this.run({ task: 'init', options: { ...options, wasm: { mjs: new URL(wasmModule, location.href).href, wasm: new URL(wasmBinary, location.href).href } } }); }
  run(request: AnalysisRequest, transfer: Transferable[] = []) {
    if (this.closed) return Promise.reject(new AnalysisError('ANALYSIS_CANCELLED', 'The analysis worker is closed.'));
    const id = ++this.nextId;
    return new Promise<AnalysisReply & { ok: true }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, request }, transfer); } catch (error) { this.pending.delete(id); reject(new AnalysisError('ANALYSIS_FAILED', error instanceof Error ? error.message : String(error))); }
    });
  }
  close(error = new AnalysisError('ANALYSIS_CANCELLED', 'Analysis was cancelled.')) {
    this.closed = true; this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
