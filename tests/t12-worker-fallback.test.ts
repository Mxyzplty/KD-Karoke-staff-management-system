// SPDX-License-Identifier: AGPL-3.0-only
// T12 WebGPU → WASM fallback (M6, master plan §1c): an adapter can exist and still not run a graph. The real mask.worker.ts, Sam2.load and
// Foreground.load behind a controlled onnxruntime: a request that fails on WebGPU runs again whole on WASM, sessions are released on the way,
// and WASM then stays for that worker. This is the branch the --disable-gpu oracle cannot reach: there the adapter is missing from the start.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Foreground } from '../apps/web/src/masks/foreground';
import { MASK_CODES } from '../apps/web/src/masks/protocol';
import { Sam2 } from '../apps/web/src/masks/sam2';
import type { Sam2Constants, Sam2Files } from '../apps/web/src/masks/sam2';

const ort = vi.hoisted(() => ({
  created: [] as string[], released: [] as string[], work: [] as string[],
  refuse: (_backend: string, _opened: number): boolean => false, fail: (_backend: string): boolean => false,
}));
vi.mock('onnxruntime-web/webgpu', () => ({
  env: { wasm: {}, webgpu: {} },
  InferenceSession: { create: async (_file: Uint8Array, o: { executionProviders: string[] }) => {
    const backend = o.executionProviders[0];
    if (ort.refuse(backend, ort.created.filter(b => b === backend).length)) throw new Error('unsupported graph');
    ort.created.push(backend);
    return { release: async () => { ort.released.push(backend); } };
  } },
}));
vi.mock('../apps/web/src/media/decode', () => ({
  frameToRgba: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }),
  videoFrames: async function* () { yield { timestamp: 0 }; },
}));
vi.mock('../apps/web/src/masks/engine', () => {
  const step = (task: string, value: unknown) => async (s: { backend: string }) => {
    ort.work.push(`${task}:${s.backend}`);
    if (ort.fail(s.backend)) throw new Error('device lost');
    return value;
  };
  return { autoForeground: step('auto', { raster: null, segments: 0 }), previewStrokes: step('preview', new Uint8Array(4)), trackObject: step('track', { frameCount: 1 }), strokeSeed: () => null, boxSeed: () => null };
});

const source = { blob: new Blob(['x']), rotation: 0 };
const auto = { task: 'auto', source, startUs: 0, endUs: 1000, total: 1 };
const preview = { task: 'preview', source, atUs: 0, strokes: [] };
const track = { task: 'track', source, atUs: 0, startUs: 0, endUs: 1000, total: 1, strokes: [] };
const times = (backend: string, n: number) => Array<string>(n).fill(backend);
const ALL = 7; // five SAM graphs, the person model, the salient model

/** A fresh worker module: `say` is what it posted. */
async function worker(gpu = true) {
  vi.resetModules();
  const said: { id?: number; kind: string; code?: string; message?: string }[] = [], self = { postMessage: (m: typeof said[number]) => said.push(m), onmessage: null as unknown as (e: { data: unknown }) => Promise<void> };
  vi.stubGlobal('self', self);
  vi.stubGlobal('navigator', gpu ? { gpu: { requestAdapter: async () => ({}) } } : {});
  await import('../apps/web/src/masks/mask.worker');
  await self.onmessage({ data: { init: { root: '/models/', wasm: {} } } });
  return async (id: number, request: unknown) => { await self.onmessage({ data: { id, request } }); return said.filter(m => m.id === id && m.kind !== 'progress').pop(); };
}
beforeEach(() => {
  ort.created = []; ort.released = []; ort.work = []; ort.refuse = () => false; ort.fail = () => false;
  vi.stubGlobal('fetch', async (url: string) => new Response(url.endsWith('constants.json') ? '{}' : new Uint8Array(1), { headers: { 'content-type': 'application/octet-stream' } }));
  vi.stubGlobal('ImageData', class { constructor(public data: unknown) {} });
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { putImageData() { /* nothing to show */ } }; } async convertToBlob() { return new Blob(['png']); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('M6: the worker runs a request again on WASM when WebGPU cannot', () => {
  it('a graph that will not open on WebGPU: the sessions already open are released and the request finishes on WASM', async () => {
    ort.refuse = (backend, opened) => backend === 'webgpu' && opened === 2;
    const ask = await worker();
    expect(await ask(1, auto)).toMatchObject({ kind: 'done' });
    expect(ort.created).toEqual([...times('webgpu', 2), ...times('wasm', ALL)]);
    expect(ort.released).toEqual(times('webgpu', 2));
    expect(ort.work).toEqual(['auto:wasm']);
  });
  it('a session that opens and fails while running: every WebGPU session is released and the whole request runs again', async () => {
    ort.fail = backend => backend === 'webgpu';
    const ask = await worker();
    expect(await ask(1, auto)).toMatchObject({ kind: 'done' });
    expect(ort.created).toEqual([...times('webgpu', ALL), ...times('wasm', ALL)]);
    expect(ort.released).toEqual(times('webgpu', ALL));
    expect(ort.work).toEqual(['auto:webgpu', 'auto:wasm']);
  });
  it.each([['preview', preview], ['track', track]])('a %s request falls back the same way', async (name, request) => {
    ort.fail = backend => backend === 'webgpu';
    const ask = await worker();
    expect(await ask(1, request)).toMatchObject({ kind: 'done' });
    expect(ort.work).toEqual([`${name}:webgpu`, `${name}:wasm`]);
  });
  it('WASM then stays for this worker: the next request does not try WebGPU again', async () => {
    ort.fail = backend => backend === 'webgpu';
    const ask = await worker();
    await ask(1, auto);
    expect(await ask(2, preview)).toMatchObject({ kind: 'done' });
    expect(ort.work).toEqual(['auto:webgpu', 'auto:wasm', 'preview:wasm']);
  });
  it('a request that also fails on WASM reports that failure, releases what it opened and leaves the next request free to try WebGPU', async () => {
    ort.fail = () => true;
    const ask = await worker();
    expect(await ask(1, preview)).toMatchObject({ kind: 'failed', code: MASK_CODES.failed, message: 'device lost' });
    expect(ort.released.filter(b => b === 'wasm')).toHaveLength(5);
    ort.fail = () => false;
    expect(await ask(2, preview)).toMatchObject({ kind: 'done' });
    expect(ort.work).toEqual(['preview:webgpu', 'preview:wasm', 'preview:webgpu']);
  });
});

describe('M6: what is not WebGPU\'s fault is not retried', () => {
  it('models not installed: the request\'s own MaskError goes straight back, nothing opens on WASM', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    const ask = await worker();
    expect(await ask(1, auto)).toMatchObject({ kind: 'failed', code: MASK_CODES.unavailable });
    expect(ort.created).toEqual([]);
  });
  it('no adapter: WASM from the start, and a failure there runs once', async () => {
    ort.fail = () => true;
    const ask = await worker(false);
    expect(await ask(1, preview)).toMatchObject({ kind: 'failed', message: 'device lost' });
    expect(ort.work).toEqual(['preview:wasm']);
  });
});

describe('M6: a load that fails half way leaves no session open', () => {
  const opening = (failAt: number) => {
    const released: number[] = []; let n = 0;
    return { released, ort: { InferenceSession: { create: async () => { const k = n++; if (k === failAt) throw new Error('unsupported graph'); return { release: async () => { released.push(k); } }; } } } };
  };
  const files: Sam2Files = { constants: {} as Sam2Constants, fetch: async () => new Uint8Array() };
  it('Sam2.load: the graphs before the failing one are released and the load rejects', async () => {
    const o = opening(2);
    await expect(Sam2.load(o.ort as never, files, 'webgpu')).rejects.toThrow('unsupported graph');
    expect(o.released.sort()).toEqual([0, 1]);
  });
  it('Foreground.load: the person model is released when the salient model will not open', async () => {
    const o = opening(1);
    await expect(Foreground.load(o.ort as never, async () => new Uint8Array(), 'webgpu')).rejects.toThrow('unsupported graph');
    expect(o.released).toEqual([0]);
  });
});
