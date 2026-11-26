// SPDX-License-Identifier: AGPL-3.0-only
// T19a audit F1 (landed-audit-t19a, D117): the editor's analysis worker is pinned to WASM, the backend every acceptance number
// was measured on. The WebGPU branch in models.ts stays as it is; the inference-time WASM retry and the WebGPU runs are T36's.
import { afterEach, expect, it, vi } from 'vitest';
import { LocalModels } from '../apps/web/src/analysis/models';
import { analysisService } from '../apps/web/src/analysis/service';

const mocks = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock('@huggingface/transformers', async importOriginal => ({ ...(await importOriginal<typeof import('@huggingface/transformers')>()), pipeline: mocks.pipeline }));

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
