// SPDX-License-Identifier: AGPL-3.0-only
// T12 mask jobs (part 3 §44.7, findings §19, §20; ticket "length rule"): one job runs at a time and the others wait
// (BG-P07), background removal's 5-minute limit and its no-foreground failure (BG-P06, BG-P08), cancel, attach mode
// and order, the legacy bg-removal migration, and the stroke track's source-range rule (SM-P04). A fake MaskEngine
// stands behind the real worker (useMaskEngine is the test seam); its close(error) rejects whatever run() is pending,
// matching worker-client.ts's own close(error = MaskError(cancelled)).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, mkTrack, resetIds, video } from './t03-fixtures';
import {
  activeRemoval, cancelMaskJob, dismissMaskJob, installMaskJobs, maskFrame, maskPreview, migrateRemovals,
  NO_FOREGROUND, REMOVAL_CODES, sourceRange, startRemoval, startTextMask, startTracking, trackRangeOk, useMaskEngine, useMaskJobs,
} from '../apps/web/src/masks/jobs';
import type { MaskContext, MaskEngine } from '../apps/web/src/masks/jobs';
import { MASK_CODES, MaskError } from '../apps/web/src/masks/protocol';
import { sourceTime } from '../apps/web/src/timeline/properties';

const asset = (id: string, durationMs: number, fps?: number): Asset => ({
  id, name: `${id}.mp4`, type: 'video', sizeBytes: 1, mimeType: 'video/mp4', folderId: null,
  created_at: '2026-10-01T00:00:00Z', recorded_at: null, location: `local://${id}`, durationMs,
  media: { video: { displayWidth: 1920, displayHeight: 1080, durationMs, ...(fps ? { fps } : {}) } },
} as unknown as Asset);
function ctxFor(e: ReturnType<typeof createEditor>, assets: Asset[]): MaskContext {
  const map = new Map(assets.map(a => [a.id, a]));
  return { bus: e.bus, asset: id => map.get(id), origin: 'user' };
}
function fakeEngine() {
  const pending: { resolve(v: unknown): void; reject(e: Error): void }[] = [];
  const calls: unknown[] = [];
  const engine: MaskEngine = {
    run: (request: unknown) => { calls.push(request); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    close: (error: Error = new MaskError(MASK_CODES.cancelled, 'Cancelled.')) => { for (const p of pending.splice(0)) p.reject(error); },
  };
  return { engine, calls, size: () => pending.length, resolveNext: (v: unknown) => pending.shift()!.resolve(v) };
}
const rasterFixture = () => ({ file: new Blob(['x']), frameCount: 1, width: 10, height: 10 });
const autoResult = () => ({ raster: rasterFixture(), segments: 1 });
const flush = () => new Promise(r => setTimeout(r, 0));

let fake: ReturnType<typeof fakeEngine>;
let uninstall: () => void;
beforeEach(() => {
  fake = fakeEngine();
  useMaskEngine(async () => fake.engine);
  uninstall = installMaskJobs({ read: async () => new Blob(['src']), writeMask: async () => undefined });
});
afterEach(() => { uninstall(); resetIds(); });

describe('mask job queue (BG-P07): one worker, the other job waits, both attach', () => {
  it('a second removal shows "Waiting for a worker" while the first runs, via activeRemoval too; both attach once each resolves', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [
      video('vid1', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' } }),
      video('vid2', 'V1', 2000, 4000, 0, 2000, { metadata: { assetId: 'a2' } }),
    ] }));
    const ctx = ctxFor(e, [asset('a1', 2000), asset('a2', 2000)]);
    const job1 = startRemoval(ctx, 'vid1');
    await flush();
    expect(fake.calls).toHaveLength(1);
    expect(useMaskJobs.getState().jobs).toEqual([{ id: job1.id, kind: 'removal', itemId: 'vid1', label: 'Background Removal', state: 'processing', percent: 0, detail: 'Processing mask' }]);

    const job2 = startRemoval(ctx, 'vid2');
    await flush();
    expect(fake.calls).toHaveLength(1); // job2 has not reached the engine yet
    expect(useMaskJobs.getState().jobs.find(j => j.id === job2.id)).toMatchObject({ state: 'waiting', detail: 'Waiting for a worker' });
    expect(activeRemoval(useMaskJobs.getState().jobs, 'vid1')?.id).toBe(job1.id);
    expect(activeRemoval(useMaskJobs.getState().jobs, 'vid2')?.id).toBe(job2.id);

    fake.resolveNext(autoResult());
    await job1.done;
    await flush();
    expect(activeRemoval(useMaskJobs.getState().jobs, 'vid1')).toBeUndefined();
    expect(fake.calls).toHaveLength(2); // job2 now reached the engine
    expect(useMaskJobs.getState().jobs.find(j => j.id === job2.id)).toMatchObject({ state: 'processing' });

    fake.resolveNext(autoResult());
    await job2.done;
    expect(activeRemoval(useMaskJobs.getState().jobs, 'vid2')).toBeUndefined();
    expect(e.doc.items.find(i => i.id === 'vid1')!.masks).toHaveLength(1);
    expect(e.doc.items.find(i => i.id === 'vid2')!.masks).toHaveLength(1);
  });
});

describe('background removal limits (BG-P06)', () => {
  it('5 minutes of source + 1 second is refused REMOVE_BG_TOO_LONG before any engine call', () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 301_000, 0, 301_000, { metadata: { assetId: 'a1' } })] }));
    const ctx = ctxFor(e, [asset('a1', 301_000)]);
    let caught: any;
    try { startRemoval(ctx, 'vid'); } catch (err) { caught = err; }
    expect(caught?.code).toBe(REMOVAL_CODES.tooLong);
    expect(fake.calls).toHaveLength(0);
    expect(useMaskJobs.getState().jobs).toHaveLength(0);
  });
  it('a whole, unsplit item is the removal range: 0 to its full displayed length', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 4000, 0, 10_000, { metadata: { assetId: 'a1' } })] }));
    const ctx = ctxFor(e, [asset('a1', 10_000)]);
    const job = startRemoval(ctx, 'vid');
    job.done.catch(() => undefined);
    await flush();
    expect(fake.calls[0]).toMatchObject({ task: 'auto', startUs: 0, endUs: 4_000_000 });
  });
  it('a job that runs far past any plausible client time-out still attaches: nothing in the queue times it out', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' } })] }));
    const ctx = ctxFor(e, [asset('a1', 2000)]);
    const job = startRemoval(ctx, 'vid');
    await flush();
    expect(useMaskJobs.getState().jobs.find(j => j.id === job.id)?.state).toBe('processing');
    vi.useFakeTimers();
    vi.advanceTimersByTime(10 * 60_000);
    vi.useRealTimers();
    expect(useMaskJobs.getState().jobs.find(j => j.id === job.id)?.state).toBe('processing');
    fake.resolveNext(autoResult());
    await job.done;
    expect(useMaskJobs.getState().jobs.find(j => j.id === job.id)?.state).toBe('done');
    expect(e.doc.items.find(i => i.id === 'vid')!.masks).toHaveLength(1);
  });
  it('a 24fps item 90.02 seconds of source long: frameTotal is 2160', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 90_020, 0, 90_020, { metadata: { assetId: 'a1' } })] }));
    const ctx = ctxFor(e, [asset('a1', 90_020, 24)]);
    const job = startRemoval(ctx, 'vid');
    job.done.catch(() => undefined);
    await flush();
    expect(fake.calls[0]).toMatchObject({ total: 2160 });
  });
});

describe('background removal failure (BG-P08)', () => {
  it('no foreground found fails FOREGROUND_NOT_FOUND / NO_FOREGROUND, stays listed until dismissed, attaches nothing', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' } })] }));
    const ctx = ctxFor(e, [asset('a1', 2000)]);
    const job = startRemoval(ctx, 'vid');
    await flush();
    fake.resolveNext({ raster: null, segments: 0 });
    let caught: any;
    try { await job.done; } catch (err) { caught = err; }
    expect(caught?.code).toBe(REMOVAL_CODES.noForeground);
    expect(caught?.message).toBe(NO_FOREGROUND);
    expect(useMaskJobs.getState().jobs.find(j => j.id === job.id)).toMatchObject({ state: 'failed', code: REMOVAL_CODES.noForeground, detail: NO_FOREGROUND });
    expect(e.doc.items.find(i => i.id === 'vid')!.masks).toEqual([]);
    expect(e.bus.undoStack).toHaveLength(0);
    dismissMaskJob(job.id);
    expect(useMaskJobs.getState().jobs.find(j => j.id === job.id)).toBeUndefined();
  });
});

describe('cancelMaskJob: attaches nothing, waiting and running', () => {
  it('a waiting job rejects cancelled and never reaches the engine', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [
      video('vid1', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' } }),
      video('vid2', 'V1', 2000, 4000, 0, 2000, { metadata: { assetId: 'a2' } }),
    ] }));
    const ctx = ctxFor(e, [asset('a1', 2000), asset('a2', 2000)]);
    const job1 = startRemoval(ctx, 'vid1');
    const job2 = startRemoval(ctx, 'vid2');
    await flush();
    cancelMaskJob(job2.id);
    let caught: any;
    try { await job2.done; } catch (err) { caught = err; }
    expect(caught?.code).toBe(MASK_CODES.cancelled);
    expect(useMaskJobs.getState().jobs.find(j => j.id === job2.id)).toMatchObject({ state: 'cancelled' });
    fake.resolveNext(autoResult());
    await job1.done;
    await flush();
    expect(fake.calls).toHaveLength(1);
    expect(e.doc.items.find(i => i.id === 'vid2')!.masks).toEqual([]);
  });
  it('a running job rejects cancelled when the engine closes, and attaches nothing', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' } })] }));
    const ctx = ctxFor(e, [asset('a1', 2000)]);
    const job = startRemoval(ctx, 'vid');
    await flush();
    cancelMaskJob(job.id);
    let caught: any;
    try { await job.done; } catch (err) { caught = err; }
    expect(caught?.code).toBe(MASK_CODES.cancelled);
    expect(useMaskJobs.getState().jobs.find(j => j.id === job.id)).toMatchObject({ state: 'cancelled' });
    expect(e.doc.items.find(i => i.id === 'vid')!.masks).toEqual([]);
  });
});

describe('attach mode and order', () => {
  it('removal adds when the item has no masks, at order 0', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' } })] }));
    const ctx = ctxFor(e, [asset('a1', 2000)]);
    const job = startRemoval(ctx, 'vid');
    await flush();
    fake.resolveNext(autoResult());
    await job.done;
    expect(e.doc.items.find(i => i.id === 'vid')!.masks[0]).toMatchObject({ mode: 'add', order: 0, selectionMode: 'auto-foreground', purpose: 'background-removal', name: 'Background Removal' });
  });
  it('removal intersects when the item already has a mask, at order highest+1', async () => {
    const existing = { id: 'm0', name: 'Mask 1', enabled: true, mode: 'add', order: 0, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape', points: [], closed: true };
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' }, masks: [existing] })] }));
    const ctx = ctxFor(e, [asset('a1', 2000)]);
    const job = startRemoval(ctx, 'vid');
    await flush();
    fake.resolveNext(autoResult());
    await job.done;
    expect(e.doc.items.find(i => i.id === 'vid')!.masks[1]).toMatchObject({ mode: 'intersect', order: 1 });
  });
  it('a tracked (stroke) smart mask always adds, at order = the current mask count, not the highest order + 1', async () => {
    const existing = { id: 'm0', name: 'Mask 1', enabled: true, mode: 'add', order: 5, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape', points: [], closed: true };
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' }, masks: [existing] })] }));
    const ctx = ctxFor(e, [asset('a1', 2000)]);
    const job = startTracking(ctx, 'vid', ctx.asset('a1')!, 500_000, { startUs: 0, endUs: 1_000_000 }, [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }]);
    await flush();
    fake.resolveNext(rasterFixture());
    await job.done;
    expect(e.doc.items.find(i => i.id === 'vid')!.masks[1]).toMatchObject({ mode: 'add', order: 1, name: 'Smart mask' });
  });
});

describe('migrateRemovals', () => {
  it('replaces the legacy bg-removal effect with an auto-foreground mask in one "Edit items" write; an over-limit item keeps its effect', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [
      video('vid1', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' }, effects: [{ effectId: 'bg-removal' }] }),
      video('vid2', 'V1', 10_000, 311_000, 0, 301_000, { metadata: { assetId: 'a2' }, effects: [{ effectId: 'bg-removal' }] }),
    ] }));
    const ctx = ctxFor(e, [asset('a1', 2000), asset('a2', 301_000)]);
    migrateRemovals(ctx);
    await flush();
    const jobs = useMaskJobs.getState().jobs;
    expect(jobs).toHaveLength(1); // vid2's over-limit removal failed synchronously and created no job
    expect(jobs[0].itemId).toBe('vid1');
    fake.resolveNext(autoResult());
    await vi.waitFor(() => { expect(useMaskJobs.getState().jobs.find(j => j.id === jobs[0].id)?.state).toBe('done'); });
    const i1 = e.doc.items.find(i => i.id === 'vid1')!;
    expect(i1.effects).toEqual([]);
    expect(i1.masks[0]).toMatchObject({ selectionMode: 'auto-foreground', purpose: 'background-removal' });
    expect(e.bus.undoStack).toHaveLength(1);
    expect(e.bus.undoStack[0].label).toBe('Edit items');
    const i2 = e.doc.items.find(i => i.id === 'vid2')!;
    expect(i2.effects).toEqual([{ effectId: 'bg-removal' }]);
    expect(i2.masks).toEqual([]);
  });
});

describe('trackRangeOk (SM-P04): a stroke track covers at most 60 s and 1,800 frames, inside the video, and holds the frame', () => {
  it('exactly 60 s at 30fps (1,800 frames) passes', () => {
    expect(trackRangeOk(asset('a', 120_000, 30), 30_000_000, { startUs: 0, endUs: 60_000_000 })).toBe(true);
  });
  it('60 s + 1 frame at 30fps is refused (over the time limit)', () => {
    expect(trackRangeOk(asset('a', 120_000, 30), 30_000_000, { startUs: 0, endUs: 60_000_000 + Math.round(1e6 / 30) })).toBe(false);
  });
  it('1,801 frames is refused even well inside 60 s', () => {
    expect(trackRangeOk(asset('a', 10_000, 1801), 500_000, { startUs: 0, endUs: 1_000_000 })).toBe(false);
  });
  it('an asset the probe has not filled in yet: the media record gives the length, and an unknown length refuses nothing', () => {
    const range = { startUs: 2_000_000, endUs: 3_000_000 }, unprobed = (media: unknown) => ({ ...asset('a', 0, 24), durationMs: null, media }) as unknown as Asset;
    expect(trackRangeOk(unprobed({ durationMs: 30_000, video: { fps: 24 } }), 2_500_000, range)).toBe(true);
    expect(trackRangeOk(unprobed({ durationMs: 2_500, video: { fps: 24 } }), 2_500_000, range)).toBe(false);
    expect(trackRangeOk(unprobed(null), 2_500_000, range)).toBe(true);
  });
  it('a frame outside the range is refused', () => {
    expect(trackRangeOk(asset('a', 120_000, 30), 60_000_000, { startUs: 0, endUs: 60_000_000 })).toBe(false);
    expect(trackRangeOk(asset('a', 120_000, 30), -1, { startUs: 0, endUs: 60_000_000 })).toBe(false);
  });
});

const item2s = () => createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' } })] }));
const within = (p: Promise<unknown>) => Promise.race([p.then(() => 'resolved', () => 'rejected'), new Promise(r => setTimeout(() => r('still waiting'), 50))]);
/** Finishes whatever these tests leave running, so that one failing test does not hold the module's queue for the next. */
async function drain() {
  for (let n = 0; n < 4; n++) { await flush(); while (fake.size()) fake.resolveNext(autoResult()); }
}
/** A read that waits for the test; only the first read waits when `once`. */
function heldRead(once = false) {
  let release: () => void = () => undefined, used = false;
  const held = new Promise<Blob>(r => { release = () => r(new Blob(['src'])); });
  return { release: () => release(), read: () => { if (once && used) return Promise.resolve(new Blob(['src'])); used = true; return held; } };
}

describe('M1: a stop during the source read', () => {
  it('cancelling while read() is still pending never calls e.run(), and the job settles rejected instead of hanging', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000)]), hold = heldRead();
    uninstall = installMaskJobs({ read: hold.read, writeMask: async () => undefined });
    const job = startRemoval(ctx, 'vid');
    job.done.catch(() => undefined);
    await flush();
    cancelMaskJob(job.id);
    hold.release();
    try {
      expect(await within(job.done)).toBe('rejected');
      expect(fake.calls).toHaveLength(0);
    } finally { await drain(); }
  });
  it('the next job does not wait for that read: it finishes, and the read landing later starts nothing', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000)]), hold = heldRead(true);
    uninstall = installMaskJobs({ read: hold.read, writeMask: async () => undefined });
    const one = startRemoval(ctx, 'vid');
    one.done.catch(() => undefined);
    await flush();
    cancelMaskJob(one.id);
    const two = startRemoval(ctx, 'vid');
    two.done.catch(() => undefined);
    await flush();
    try {
      expect(fake.calls).toHaveLength(1);
      fake.resolveNext(autoResult());
      expect(await within(two.done)).toBe('resolved');
      hold.release();
      await flush();
      expect(fake.calls).toHaveLength(1);
      expect(useMaskJobs.getState().jobs.map(j => j.state)).toEqual(['cancelled', 'done']);
    } finally { hold.release(); await drain(); }
  });
  it('closing the project during the read ends the job, and the next project\'s job runs and finishes', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000)]), hold = heldRead();
    uninstall = installMaskJobs({ read: hold.read, writeMask: async () => undefined });
    const one = startRemoval(ctx, 'vid');
    let first: { code?: string } | undefined;
    one.done.catch(err => { first = err; });
    await flush();
    uninstall();
    uninstall = installMaskJobs({ read: async () => new Blob(['src']), writeMask: async () => undefined });
    hold.release();
    const two = startRemoval(ctx, 'vid');
    two.done.catch(() => undefined);
    await flush();
    try {
      expect(first?.code).toBe(MASK_CODES.cancelled);
      fake.resolveNext(autoResult());
      expect(await within(two.done)).toBe('resolved');
      expect(fake.calls).toHaveLength(1);
    } finally { await drain(); }
  });
  it('a preview whose read is pending when the project closes is rejected and never reaches the engine', async () => {
    const hold = heldRead();
    uninstall = installMaskJobs({ read: hold.read, writeMask: async () => undefined });
    const seen = Promise.race([maskPreview(asset('a1', 2000), 0, [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }]).then(() => 'resolved', (err: { code?: string }) => err.code), new Promise(r => setTimeout(() => r('still waiting'), 200))]);
    await flush();
    uninstall();
    uninstall = installMaskJobs({ read: async () => new Blob(['src']), writeMask: async () => undefined });
    hold.release();
    await flush();
    try {
      expect(await seen).toBe(MASK_CODES.cancelled);
      expect(fake.calls).toHaveLength(0);
    } finally { await drain(); }
  });
});

describe('M2: a closed engine is never used again', () => {
  /** Engines like MaskWorker: close(error) rejects what runs and marks it closed. `leave` finishes what is left on any of them. */
  function engines() {
    const made: { closed: boolean; run(): Promise<unknown>; close(error?: Error): void; finish(v: unknown): void; leave(): void }[] = [];
    const make = async () => {
      const pending: { resolve(v: unknown): void; reject(e: Error): void }[] = [];
      const one = {
        closed: false,
        run: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
        close: (error: Error = new MaskError(MASK_CODES.cancelled, 'Cancelled.')) => { one.closed = true; for (const p of pending.splice(0)) p.reject(error); },
        finish: (v: unknown) => pending.shift()!.resolve(v),
        leave: () => { for (const p of pending.splice(0)) p.resolve(autoResult()); },
      };
      made.push(one);
      return one as unknown as MaskEngine;
    };
    return { made, make, leave: async () => { await flush(); for (const m of made) m.leave(); await flush(); } };
  }
  it('a crash mid-job fails that job, and the next job runs on a new engine to the end', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000)]), { made, make, leave } = engines();
    useMaskEngine(make);
    const one = startRemoval(ctx, 'vid');
    one.done.catch(() => undefined);
    await flush();
    made[0].close(new MaskError(MASK_CODES.failed, 'worker crashed'));
    await flush();
    expect(useMaskJobs.getState().jobs[0]).toMatchObject({ state: 'failed', detail: 'worker crashed' });
    const two = startRemoval(ctx, 'vid');
    two.done.catch(() => undefined);
    await flush();
    try {
      expect(made).toHaveLength(2);
      made[1].finish(autoResult());
      expect(await within(two.done)).toBe('resolved');
      expect(e.doc.items.find(i => i.id === 'vid')!.masks).toHaveLength(1);
    } finally { await leave(); }
  });
  it('a frame request after a crash opens a new engine too', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000)]), { made, make, leave } = engines();
    useMaskEngine(make);
    const one = startRemoval(ctx, 'vid');
    one.done.catch(() => undefined);
    await flush();
    made[0].close(new MaskError(MASK_CODES.failed, 'worker crashed'));
    await flush();
    void maskFrame(asset('a1', 2000), 0).catch(() => undefined);
    await flush();
    try { expect(made).toHaveLength(2); } finally { await leave(); }
  });
});

describe('M3: attach revalidates the source the job read, before the file and again before the document', () => {
  const revised = (sha256: string) => ({ ...asset('a1', 2000), sha256 }) as Asset;
  const refused = async (done: Promise<unknown>) => { try { await done; return null; } catch (err) { return (err as { code?: string }).code; } };
  it('the item is pointed at another asset during inference: refused, no file, no mask, job failed', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000), asset('a2', 2000)]);
    let wrote = 0;
    uninstall = installMaskJobs({ read: async () => new Blob(['src']), writeMask: async () => { wrote++; } });
    const job = startRemoval(ctx, 'vid');
    job.done.catch(() => undefined);
    await flush();
    e.bus.run('Edit items', 'user', doc => { doc.items[0].metadata.assetId = 'a2'; });
    fake.resolveNext(autoResult());
    expect(await refused(job.done)).toBe('MASK_SOURCE_CHANGED');
    expect(wrote).toBe(0);
    expect(e.doc.items[0].masks).toEqual([]);
    expect(useMaskJobs.getState().jobs[0]).toMatchObject({ state: 'failed', code: 'MASK_SOURCE_CHANGED' });
  });
  it('the asset is re-ingested (a new sha256) during inference: refused, no mask', async () => {
    const e = item2s();
    let current = revised('rev-1');
    const job = startRemoval({ bus: e.bus, asset: () => current, origin: 'user' }, 'vid');
    job.done.catch(() => undefined);
    await flush();
    current = revised('rev-2');
    fake.resolveNext(autoResult());
    expect(await refused(job.done)).toBe('MASK_SOURCE_CHANGED');
    expect(e.doc.items[0].masks).toEqual([]);
  });
  it('the source changes while the raster file is being written: the document is still refused', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000), asset('a2', 2000)]);
    let release: () => void = () => undefined;
    uninstall = installMaskJobs({ read: async () => new Blob(['src']), writeMask: () => new Promise(r => { release = () => r(undefined); }) });
    const job = startRemoval(ctx, 'vid');
    job.done.catch(() => undefined);
    await flush();
    fake.resolveNext(autoResult());
    await flush();
    e.bus.run('Edit items', 'user', doc => { doc.items[0].metadata.assetId = 'a2'; });
    release();
    expect(await refused(job.done)).toBe('MASK_SOURCE_CHANGED');
    expect(e.doc.items[0].masks).toEqual([]);
  });
  it('the item stops being a video during inference: refused', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000)]);
    const job = startRemoval(ctx, 'vid');
    job.done.catch(() => undefined);
    await flush();
    e.bus.run('Edit items', 'user', doc => { doc.items[0].type = 'image'; });
    fake.resolveNext(autoResult());
    expect(await refused(job.done)).toBe('MASK_SOURCE_CHANGED');
    expect(e.doc.items[0].masks).toEqual([]);
  });
  it('a stroke track is pinned the same way', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000), asset('a2', 2000)]);
    const job = startTracking(ctx, 'vid', ctx.asset('a1')!, 0, { startUs: 0, endUs: 1_000_000 }, [{ label: 1, points: [[0.5, 0.5]], radius: 0.1 }]);
    job.done.catch(() => undefined);
    await flush();
    e.bus.run('Edit items', 'user', doc => { doc.items[0].metadata.assetId = 'a2'; });
    fake.resolveNext(rasterFixture());
    expect(await refused(job.done)).toBe('MASK_SOURCE_CHANGED');
    expect(e.doc.items[0].masks).toEqual([]);
  });
  it('an item deleted during inference keeps maskable\'s own refusal (already correct on a6ca05e)', async () => {
    const e = item2s(), ctx = ctxFor(e, [asset('a1', 2000)]);
    const job = startRemoval(ctx, 'vid');
    job.done.catch(() => undefined);
    await flush();
    e.bus.run('Edit items', 'user', doc => { doc.items.splice(0, 1); });
    fake.resolveNext(autoResult());
    expect(await refused(job.done)).toBe('TIMELINE_ITEM_NOT_FOUND');
  });
});

describe('M4: sourceRange follows the time mapping, not a fixed sample count', () => {
  const remapped = (span: number, sourceDuration: number, keyframes: Record<string, unknown>[]) => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, span, 0, sourceDuration, { metadata: { assetId: 'a1' } })] }));
    e.bus.run('Edit items', 'user', doc => { Object.assign(doc.items[0], { sourceDuration, timeRemap: { keyframes } }); });
    return e;
  };
  const spike = [{ time: 0, value: 0, easing: 'linear' }, { time: 40, value: 301_000, easing: 'linear' }, { time: 80, value: 0, easing: 'linear' }, { time: 6400, value: 6400, easing: 'linear' }];
  it('a 2-frame spike to 301 s between the samples is inside the range, with its end exclusive', () => {
    expect(sourceRange(remapped(6400, 400_000, spike).doc.items[0])).toEqual({ startUs: 0, endUs: 301_000_001 });
  });
  it('that spike is over the five-minute limit: refused before any engine call', async () => {
    const e = remapped(6400, 400_000, spike), ctx = ctxFor(e, [asset('a1', 400_000)]);
    let code: string | undefined;
    try {
      try { startRemoval(ctx, 'vid'); } catch (err) { code = (err as { code?: string }).code; }
      expect(code).toBe(REMOVAL_CODES.tooLong);
      await flush();
      expect(fake.calls).toHaveLength(0);
    } finally { await drain(); }
  });
  it('an overshooting easing passes its keyframes: the range holds the top of the curve', () => {
    const i = remapped(10_000, 60_000, [{ time: 0, value: 0, easing: 'easeOutBack' }, { time: 10, value: 1000, easing: 'linear' }, { time: 10_000, value: 1000, easing: 'linear' }]).doc.items[0];
    let top = 0;
    for (let t = 0; t <= 10; t += 0.01) top = Math.max(top, sourceTime(i, t));
    expect(top).toBeGreaterThan(1050);
    expect(sourceRange(i).endUs).toBeGreaterThanOrEqual(Math.floor(top * 1000));
  });
  it('an easing that undershoots lowers the start the same way', () => {
    const i = remapped(10_000, 60_000, [{ time: 0, value: 5000, easing: 'easeInBack' }, { time: 10, value: 6000, easing: 'linear' }, { time: 10_000, value: 6000, easing: 'linear' }]).doc.items[0];
    let low = Infinity;
    for (let t = 0; t <= 10; t += 0.01) low = Math.min(low, sourceTime(i, t));
    expect(low).toBeLessThan(4950);
    expect(sourceRange(i).startUs).toBeLessThanOrEqual(Math.ceil(low * 1000));
  });
  it('a peak in the middle stays inside the end-exclusive range, and so does a reversed item\'s first frame', () => {
    expect(sourceRange(remapped(2000, 60_000, [{ time: 0, value: 0, easing: 'linear' }, { time: 1000, value: 5000, easing: 'linear' }, { time: 2000, value: 0, easing: 'linear' }]).doc.items[0])).toEqual({ startUs: 0, endUs: 5_000_001 });
    expect(sourceRange(remapped(2000, 60_000, [{ time: 0, value: 2000, easing: 'linear' }, { time: 2000, value: 0, easing: 'linear' }]).doc.items[0])).toEqual({ startUs: 0, endUs: 2_000_001 });
  });
  it('a value past the source is clamped as sourceTime clamps it, and a keyframe past the item does not count (already correct on a6ca05e)', () => {
    expect(sourceRange(remapped(200, 6400, [{ time: 0, value: 0, easing: 'linear' }, { time: 100, value: 999_999, easing: 'linear' }, { time: 200, value: 6400, easing: 'linear' }]).doc.items[0]).endUs).toBe(6_400_000);
    expect(sourceRange(remapped(1000, 60_000, [{ time: 0, value: 0, easing: 'linear' }, { time: 1000, value: 1000, easing: 'linear' }, { time: 50_000, value: 50_000, easing: 'linear' }]).doc.items[0])).toEqual({ startUs: 0, endUs: 1_000_000 });
  });
  it('no remap: the trim, as before', () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 1000, 10_000, { metadata: { assetId: 'a1' } })] }));
    expect(sourceRange(e.doc.items[0])).toEqual({ startUs: 1_000_000, endUs: 3_000_000 });
  });
});

describe('M5: migrateRemovals keeps the picture the project was saved with', () => {
  const legacy = (...enabled: boolean[]) => createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 2000, 0, 2000, { metadata: { assetId: 'a1' }, effects: enabled.map((on, order) => ({ id: `bg${order}`, effectId: 'bg-removal', enabled: on, order, parameters: {} })) })] }));
  const migrated = async (e: ReturnType<typeof createEditor>) => {
    migrateRemovals(ctxFor(e, [asset('a1', 2000)]));
    await flush();
    const job = useMaskJobs.getState().jobs[0];
    fake.resolveNext(autoResult());
    await vi.waitFor(() => { expect(useMaskJobs.getState().jobs.find(j => j.id === job.id)?.state).toBe('done'); });
    return e.doc.items[0];
  };
  it('a disabled effect becomes a disabled layer', async () => {
    const i = await migrated(legacy(false));
    expect(i.masks).toHaveLength(1);
    expect(i.masks[0].enabled).toBe(false);
    expect(i.effects).toEqual([]);
  });
  it('an enabled effect becomes an enabled layer (already correct on a6ca05e)', async () => {
    expect((await migrated(legacy(true))).masks[0].enabled).toBe(true);
  });
  it('several effects on one item become one layer: off when all of them were', async () => {
    const i = await migrated(legacy(false, false));
    expect(i.masks).toHaveLength(1);
    expect(i.masks[0].enabled).toBe(false);
  });
  it('several effects on one item become one layer: on when any of them was (already correct on a6ca05e)', async () => {
    const i = await migrated(legacy(false, true));
    expect(i.masks).toHaveLength(1);
    expect(i.masks[0].enabled).toBe(true);
    expect(i.effects).toEqual([]);
  });
  it('an item over the limit keeps its effect as saved, and no job starts (already correct on a6ca05e)', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 301_000, 0, 301_000, { metadata: { assetId: 'a1' }, effects: [{ id: 'bg', effectId: 'bg-removal', enabled: false, order: 0, parameters: {} }] })] }));
    migrateRemovals(ctxFor(e, [asset('a1', 301_000)]));
    await flush();
    expect(useMaskJobs.getState().jobs).toEqual([]);
    expect(e.doc.items[0].effects).toMatchObject([{ effectId: 'bg-removal', enabled: false }]);
  });
});

describe('text-clamp (confirmation): startTextMask clamps its range to 30s around the prompt frame', () => {
  it('45s into a 90s shown range clamps to exactly a 30s window (already correct today)', async () => {
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('vid', 'V1', 0, 90_000, 0, 90_000, { metadata: { assetId: 'a1' } })] }));
    const ctx = ctxFor(e, [asset('a1', 90_000)]);
    const job = startTextMask(ctx, 'vid', ctx.asset('a1')!, 45_000_000, { startUs: 0, endUs: 90_000_000 }, 'the man');
    job.done.catch(() => undefined);
    await flush();
    const call = fake.calls[0] as { task: string; startUs: number; endUs: number };
    expect(call.task).toBe('text');
    expect(call.endUs - call.startUs).toBe(30_000_000);
  });
});
