// SPDX-License-Identifier: AGPL-3.0-only
// T19a audit F1 (landed-audit-t19a, D117): the editor's analysis worker is pinned to WASM, the backend every acceptance number
// was measured on. The WebGPU branch in models.ts stays as it is; the inference-time WASM retry and the WebGPU runs are T36's.
// Lane A (05:53): the mask worker's text-prompt grounding (T19a's Florence-2, mask.worker.ts) is the second app site of the pin.
import { afterEach, expect, it, vi } from 'vitest';
import { LocalModels } from '../apps/web/src/analysis/models';
import { analysisService } from '../apps/web/src/analysis/service';

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), modelOptions: [] as unknown[] }));
vi.mock('@huggingface/transformers', async importOriginal => ({ ...(await importOriginal<typeof import('@huggingface/transformers')>()), pipeline: mocks.pipeline }));
// The real LocalModels, recording the options it is built with; ground() answers a box without Florence-2.
vi.mock('../apps/web/src/analysis/models', async importOriginal => {
  const real = await importOriginal<typeof import('../apps/web/src/analysis/models')>();
  class LocalModels extends real.LocalModels {
    constructor(options: ConstructorParameters<typeof real.LocalModels>[0]) { super(options); mocks.modelOptions.push(options); }
    async ground(): Promise<[number, number, number, number]> { return [0, 0, 1, 1]; }
  }
  return { ...real, LocalModels };
});
// The mask worker behind a stand-in onnxruntime and media decoder, as in t12-worker-fallback.test.ts; the engine's box seed calls
// the worker's ground() on the first frame, as engine.ts boxSeed does.
vi.mock('onnxruntime-web/webgpu', () => ({ env: { wasm: {}, webgpu: {} }, InferenceSession: { create: async () => ({ release: async () => {} }) } }));
vi.mock('../apps/web/src/media/decode', () => ({ frameToRgba: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }), videoFrames: async function* () { yield { timestamp: 0 }; } }));
vi.mock('../apps/web/src/masks/engine', () => ({
  autoForeground: async () => ({ raster: null, segments: 0 }), previewStrokes: async () => new Uint8Array(4), strokeSeed: () => null,
  boxSeed: (_sam: unknown, box: (picture: unknown) => Promise<unknown>) => box,
  trackObject: async (_sam: unknown, seed: (picture: unknown) => Promise<unknown>) => { await seed({ width: 2, height: 2, data: new Uint8ClampedArray(16) }); return { frameCount: 1 }; },
}));

/** WebGPU offered: navigator.gpu present and requestAdapter() resolves an adapter. */
const offerWebGpu = () => { const requestAdapter = vi.fn(async () => ({})); vi.stubGlobal('navigator', { gpu: { requestAdapter } }); return requestAdapter; };
afterEach(() => vi.unstubAllGlobals());

it('the product AnalysisService starts its worker with device wasm, even when WebGPU offers an adapter', () => {
  offerWebGpu();
  vi.stubGlobal('location', { href: 'http://localhost/', origin: 'http://localhost' }); // AnalysisWorker.init resolves the wasm URLs against it
  const native = { onmessage: undefined as unknown, postMessage: vi.fn(), terminate: vi.fn() };
  vi.stubGlobal('Worker', class { constructor() { return native; } });
  void analysisService.available().catch(() => {}); // opens the worker: init is the first message across the boundary
  const [init] = native.postMessage.mock.calls[0];
  expect(init).toMatchObject({ id: 1, request: { task: 'init' } });
  expect(init.request.options).toMatchObject({ modelRoot: '/models/', device: 'wasm' });
});

it('guard: with device wasm and an adapter offered, LocalModels never asks the factory for webgpu and records wasm', async () => {
  offerWebGpu();
  vi.stubGlobal('location', { href: 'http://localhost/', origin: 'http://localhost' }); // a browser: the local fallback is wasm, not cpu
  mocks.pipeline.mockReset().mockImplementation(async () => async () => ({ tolist: () => [[1, 0]] }));
  const models = new LocalModels({ modelRoot: '/models/', device: 'wasm' });
  await expect(models.embed(['x'])).resolves.toEqual([[1, 0]]);
  expect(mocks.pipeline).toHaveBeenCalledOnce();
  expect(mocks.pipeline.mock.calls.map(call => call[2].device)).toEqual(['wasm']);
  expect(models.backends.embedding).toBe('wasm');
});

it('the mask worker builds the text-prompt grounding LocalModels with device wasm, even when WebGPU offers an adapter', async () => {
  offerWebGpu();
  vi.stubGlobal('fetch', async (url: string) => new Response(url.endsWith('constants.json') ? '{}' : new Uint8Array(1), { headers: { 'content-type': 'application/octet-stream' } }));
  const said: { id?: number; kind: string; code?: string; message?: string }[] = [], self = { postMessage: (m: typeof said[number]) => said.push(m), onmessage: null as unknown as (e: { data: unknown }) => Promise<void> };
  vi.stubGlobal('self', self);
  mocks.modelOptions.length = 0;
  await import('../apps/web/src/masks/mask.worker');
  await self.onmessage({ data: { init: { root: '/models/', wasm: { mjs: 'ort.mjs', wasm: 'ort.wasm' } } } });
  await self.onmessage({ data: { id: 1, request: { task: 'text', source: { blob: new Blob(['x']), rotation: 0 }, atUs: 0, startUs: 0, endUs: 1000, total: 1, prompt: 'the dog' } } });
  expect(said.filter(m => m.kind !== 'progress').pop()).toMatchObject({ id: 1, kind: 'done' });
  expect(mocks.modelOptions).toEqual([expect.objectContaining({ modelRoot: '/models/', device: 'wasm' })]);
});
