// SPDX-License-Identifier: AGPL-3.0-only
// T12 the real MaskWorker client and the real job queue over a controlled browser Worker (M1, M2): a closed worker answers every later
// request with the error it closed on, nothing posted to a dead worker waits for ever, and a crash is followed by a job that finishes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, mkTrack, resetIds, video } from './t03-fixtures';
import { installMaskJobs, startRemoval, useMaskEngine, useMaskJobs } from '../apps/web/src/masks/jobs';
import { MASK_CODES, MaskError } from '../apps/web/src/masks/protocol';
import type { MaskRequest } from '../apps/web/src/masks/protocol';
import { MaskWorker } from '../apps/web/src/masks/worker-client';

class FakeWorker {
  static made: FakeWorker[] = [];
  sent: { id?: number }[] = []; terminated = 0;
  onmessage: ((e: { data: unknown }) => void) | null = null; onerror: ((e: { message: string }) => void) | null = null;
  constructor() { FakeWorker.made.push(this); }
  postMessage(m: { id?: number }) { this.sent.push(m); }
  terminate() { this.terminated++; }
  get requests() { return this.sent.filter(m => m.id !== undefined); }
}
const frame = { task: 'frame', source: { blob: new Blob(['x']), rotation: 0 }, atUs: 0 } as MaskRequest;
const within = (p: Promise<unknown>) => Promise.race([p.then(() => 'resolved', (e: { code?: string; message?: string }) => e), new Promise(r => setTimeout(() => r('still waiting'), 50))]);
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  FakeWorker.made = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', { href: 'http://localhost/' });
});
afterEach(() => { vi.unstubAllGlobals(); resetIds(); });

describe('MaskWorker: closing', () => {
  it('a request after close rejects with the error it closed on and posts nothing', async () => {
    const w = new MaskWorker(), worker = FakeWorker.made[0], error = new MaskError(MASK_CODES.failed, 'closed here');
    w.close(error);
    expect(await within(w.run(frame))).toBe(error);
    expect(worker.requests).toEqual([]);
  });
  it('`closed` turns true on close and on a crash, not before', () => {
    const closing = new MaskWorker(), crashing = new MaskWorker();
    expect(closing.closed).toBe(false);
    closing.close();
    expect(closing.closed).toBe(true);
    FakeWorker.made[1].onerror!({ message: 'boom' });
    expect(crashing.closed).toBe(true);
  });
  it('a crash rejects what is running with MASK_FAILED and its message, and the next request gets the same answer', async () => {
    const w = new MaskWorker(), running = w.run(frame);
    FakeWorker.made[0].onerror!({ message: 'boom' });
    expect(await within(running)).toMatchObject({ code: MASK_CODES.failed, message: 'boom' });
    expect(await within(w.run(frame))).toMatchObject({ code: MASK_CODES.failed, message: 'boom' });
  });
  it('close twice terminates once and keeps the first error', async () => {
    const w = new MaskWorker(), first = new MaskError(MASK_CODES.failed, 'first');
    w.close(first); w.close(new MaskError(MASK_CODES.failed, 'second'));
    expect(FakeWorker.made[0].terminated).toBe(1);
    expect(await within(w.run(frame))).toBe(first);
  });
});

describe('M2 through the real client: a worker crash, then a job that finishes', () => {
  it('the crashed job fails, the next one runs on a new worker, attaches and leaves the old worker alone', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' } })] }));
    const asset = { id: 'a1', durationMs: 2000, media: { video: { fps: 30, displayWidth: 10, displayHeight: 10 } } } as unknown as Asset;
    useMaskEngine(async () => new MaskWorker());
    const uninstall = installMaskJobs({ read: async () => new Blob(['src']), writeMask: async () => undefined });
    try {
      const ctx = { bus: e.bus, asset: () => asset, origin: 'user' as const };
      const one = startRemoval(ctx, 'vid');
      one.done.catch(() => undefined);
      await flush();
      FakeWorker.made[0].onerror!({ message: 'simulated worker crash' });
      await flush();
      expect(useMaskJobs.getState().jobs[0]).toMatchObject({ state: 'failed', code: MASK_CODES.failed, detail: 'simulated worker crash' });
      const two = startRemoval(ctx, 'vid');
      two.done.catch(() => undefined);
      await flush();
      expect(FakeWorker.made).toHaveLength(2);
      expect(FakeWorker.made[0].requests).toHaveLength(1);
      const { id } = FakeWorker.made[1].requests[0];
      FakeWorker.made[1].onmessage!({ data: { id, kind: 'done', value: { raster: { file: new Blob(['x']), frameCount: 1, width: 10, height: 10 }, segments: 1 } } });
      expect(await within(two.done)).toBe('resolved');
      expect(e.doc.items[0].masks).toHaveLength(1);
    } finally { uninstall(); }
  });
});
