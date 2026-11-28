// SPDX-License-Identifier: AGPL-3.0-only
import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import wasmBinary from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import { AnalysisError } from './types';
import type { ModelOptions } from './models';
import type { AnalysisMessage, AnalysisReply, AnalysisRequest, AnalysisStarted } from './protocol';

/** Filled by `run`: skip the request while it is still queued in the worker (true = the worker need not be ended). */
export type QueueTicket = { cancelQueued?: () => boolean };

/** Own one worker; terminate it to cancel inference and reject every pending request. */
export class AnalysisWorker {
  private worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 0;
  private closed = false;
  private pending = new Map<number, { resolve(value: AnalysisReply & { ok: true }): void; reject(error: Error): void; onStart?: () => void }>();
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<AnalysisReply | AnalysisStarted>) => {
      const pending = this.pending.get(data.id); if (!pending) return;
      if ('started' in data) { pending.onStart?.(); return; }
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data); else pending.reject(new AnalysisError(data.error.code, data.error.message, { confidence: data.error.confidence }));
    };
    this.worker.onerror = event => this.close(new AnalysisError('ANALYSIS_WORKER_FAILED', event.message));
    this.worker.onmessageerror = () => this.close(new AnalysisError('ANALYSIS_WORKER_FAILED', 'The worker result could not be decoded.'));
  }
  init(options: Omit<ModelOptions, 'wasm'>) { return this.run({ task: 'init', options: { ...options, wasm: { mjs: new URL(wasmModule, location.href).href, wasm: new URL(wasmBinary, location.href).href } } }); }
  /** `ticket.cancelQueued` (audit F1 (c)) skips the request if it has not started (every earlier request has replied): it
   *  posts `{ cancel: id }`, rejects ANALYSIS_CANCELLED and returns true; also true once answered; false while it runs.
   *  `onStart` (T37): called when the worker starts the request (it is posted with `started: true` only then). */
  run(request: AnalysisRequest, transfer: Transferable[] = [], ticket?: QueueTicket, onStart?: () => void) {
    if (this.closed) return Promise.reject(new AnalysisError('ANALYSIS_CANCELLED', 'The analysis worker is closed.'));
    const id = ++this.nextId;
    return new Promise<AnalysisReply & { ok: true }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStart });
      if (ticket) ticket.cancelQueued = () => {
        if (!this.pending.has(id)) return true;
        if (this.pending.keys().next().value === id) return false;
        this.pending.delete(id); this.worker.postMessage({ cancel: id } satisfies AnalysisMessage);
        reject(new AnalysisError('ANALYSIS_CANCELLED', 'Analysis was cancelled.')); return true;
      };
      try { this.worker.postMessage((onStart ? { id, request, started: true } : { id, request }) satisfies AnalysisMessage, transfer); } catch (error) { this.pending.delete(id); reject(new AnalysisError('ANALYSIS_FAILED', error instanceof Error ? error.message : String(error))); }
    });
  }
  close(error = new AnalysisError('ANALYSIS_CANCELLED', 'Analysis was cancelled.')) {
    this.closed = true; this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
