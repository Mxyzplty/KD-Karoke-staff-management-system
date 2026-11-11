// SPDX-License-Identifier: AGPL-3.0-only
// Runs one media job in a fresh worker; aborting terminates the worker (the job stops at once).
import { MediaError, mediaError } from './codes';
import type { MediaCode } from './codes';
import { probeMedia } from './probe';
import type { MediaInfo } from './probe';
import type { ThumbnailRow } from './prepare';
import { POSTER_QUALITY, THUMB_MAX, fitBox } from './work';
import type { Steps } from './prepare';
import type { WorkerRequest } from './media.worker';
import { forceWasm } from './force-wasm';

export { forceWasm };
export function runWorker<T>(request: WorkerRequest, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL('./media.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => { worker.terminate(); reject(signal?.reason ?? mediaError('CLIENT_PREPARATION_CANCELLED')); };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: T; error?: { code?: string; message: string } }>) => {
      signal?.removeEventListener('abort', stop); worker.terminate();
      const { ok, result, error } = event.data;
      if (ok) resolve(result as T);
      else reject(error?.code ? new MediaError(error.code as MediaCode, error.message) : Object.assign(new Error(error?.message), { name: 'WorkerError' }));
    };
    worker.onerror = event => { signal?.removeEventListener('abort', stop); worker.terminate(); reject(mediaError('EXTRACTION_FAILED', event.message || 'The media worker failed.')); };
    worker.postMessage({ ...request, forceWasm: request.forceWasm ?? forceWasm() });
  });
}
/** The default preparation steps in a browser. The T19 analysis steps load on first use; without local models they
 *  report "unavailable" (analysis/steps.ts). */
export function browserSteps(): Steps {
  const t19 = () => import('../analysis/steps');
  return {
    probe: (blob, asset) => probeMedia(blob, asset.name, asset.type),
    thumbnails: ({ blob, info, signal }) => info.container === 'svg+xml' ? svgThumbnails(blob, info) : runWorker({ op: 'thumbnails', blob, info }, signal),
    waveform: ({ blob, info, signal }) => runWorker({ op: 'waveform', blob, info }, signal),
    proxy: ({ blob, info, signal }) => runWorker({ op: 'proxy', blob, info }, signal),
    analysis: async args => (await t19()).analysisStep(args),
    transcription: async args => (await t19()).transcriptionStep(args),
    embeddings: async args => (await t19()).embeddingsStep(args),
  };
}
/** SVG renders only through an <img> on the main thread (workers have no SVG decoder); <img> runs no SVG script. */
/** The stored SVG bytes as a data URL: an object URL taints the canvas when the SVG has a foreignObject (D97). */
async function svgDataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(s)}`;
}
async function svgThumbnails(blob: Blob, info: MediaInfo): Promise<Omit<ThumbnailRow, 'id'>> {
  const img = new Image(); img.src = await svgDataUrl(blob);
  try { await img.decode(); } catch { throw mediaError('DECODE_ERROR', 'The SVG could not be drawn.'); }
  const size = fitBox(info.image!.width, info.image!.height, THUMB_MAX, THUMB_MAX), canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height; canvas.getContext('2d')!.drawImage(img, 0, 0, size.width, size.height);
  const poster = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(mediaError('DECODE_ERROR', 'The SVG could not be drawn.')), 'image/jpeg', POSTER_QUALITY));
  return { ...size, poster, frames: [{ t: 0, blob: poster }] };
}