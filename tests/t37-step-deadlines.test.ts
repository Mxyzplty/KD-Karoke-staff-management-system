// SPDX-License-Identifier: AGPL-3.0-only
// T37 (D120 item 4), red first: each local model step gets its own deadline, sized from its work (analysis: model load +
// frames × time per frame, × margin), armed when the worker starts the step's request (`started` → `onStart`), not while the
// request waits in the queue. Frame extraction keeps preparationBudgetMs. A request that never starts fails at a queue cap
// with the cap's own code. Real prepareAsset + the real analysisStep + a real AnalysisService over a fake worker that keeps
// the worker's serial queue; frame extraction (runWorker) is mocked. Fake time via options.clock / options.timers, as in
// t19-r2-step-deadline (setInterval is inert: no heartbeat). Every checkpoint is a fraction of a deadline computed from the
// TBD constants; no value is written for them. Synthetic data only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ svc: undefined as unknown as object }));
vi.mock('../apps/web/src/media/worker-client', () => ({ runWorker: vi.fn(), browserSteps: vi.fn() }));
// The steps reach the worker through the `analysisService` singleton: here it forwards to this test's own AnalysisService.
vi.mock('../apps/web/src/analysis/service', async original => ({
  ...await original<typeof import('../apps/web/src/analysis/service')>(),
  analysisService: new Proxy({}, { get: (_t, key) => { const v = Reflect.get(h.svc, key); return typeof v === 'function' ? v.bind(h.svc) : v; } }),
}));

import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { mediaError } from '../apps/web/src/media/codes';
import { uploadToLibrary } from '../apps/web/src/media/ingest';
import { preparationBudgetMs, prepareAsset } from '../apps/web/src/media/prepare';
import type { PreparationRecord, Timers } from '../apps/web/src/media/prepare';
import { runWorker } from '../apps/web/src/media/worker-client';
import { AnalysisService } from '../apps/web/src/analysis/service';
import { analysisDeadlineMs, analysisStep, frameTimes, MARGIN, MODEL_LOAD_VISION, PER_FRAME } from '../apps/web/src/analysis/steps';
import { AnalysisError } from '../apps/web/src/analysis/types';
import type { AnalysisRequest } from '../apps/web/src/analysis/protocol';

const opened: ProjectStore[] = [];
let tick = Date.parse('2026-11-26T00:00:00Z');
function setup() {
  const files = new Map<string, Blob>();
  const media: MediaStore = {
    write: vi.fn(async (id, blob) => { files.set(id, blob); }), read: vi.fn(async id => { const b = files.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; }),
    remove: vi.fn(async (kind, id) => { if (kind === 'asset') files.delete(id); }), list: vi.fn(async () => [...files.keys()]),
  };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
}
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(runWorker).mockReset(); for (const s of opened.splice(0)) await s.close(); });
/** The T23 A clip lengths and CLIP2 (30 s); the clip name carries its length. */
const SECONDS: Record<string, number> = { 'clip30.mp4': 30, 'clip40.mp4': 40, 'clip45.mp4': 45 };
async function upload(store: ProjectStore, names: string[]) {
  const assets = (await uploadToLibrary(store, names.map(n => new File([`synthetic ${n}`], n)), async () => 'rename', { prepare: false })).assets;
  return names.map(n => assets.find(a => a.name === n)!);
}
const stored = (store: ProjectStore, id: string) => store.row<Asset>('assets', id);
const record = (store: ProjectStore, id: string) => store.row<PreparationRecord>('preparations', id);
const video = (durationMs: number) => ({ container: 'mp4', mimeType: 'video/mp4', durationMs, video: { displayWidth: 640, displayHeight: 360 }, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null });
const frames = (times: number[]) => times.map(t => ({ timestamp: t, width: 2, height: 2, data: new Uint8ClampedArray(16) }));
const DESCRIBED = { summary: 'synthetic', tags: [], segments: [] };
const MIN = 60_000;
const real = (ms = 0) => new Promise<void>(res => setTimeout(res, ms));
/** The analysis deadline for a clip of `s` seconds (its frame count by the T19a rule). */
const deadline = (s: number) => analysisDeadlineMs(frameTimes(s).length);

/** Fake time: timers fire only inside advance(); setInterval never fires (no heartbeat). Same model as t19-r2. */
function fakeTime() {
  let now = Date.parse('2026-11-26T00:00:00Z'), seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers = {
    setTimeout: ((fn: () => void, ms = 0) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; }) as unknown as Timers['setTimeout'],
    clearTimeout: ((id: number) => { pending.delete(id); }) as unknown as Timers['clearTimeout'],
    setInterval: (() => 0) as unknown as Timers['setInterval'],
    clearInterval: (() => {}) as unknown as Timers['clearInterval'],
  } satisfies Timers;
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((x, y) => x[1].at - y[1].at)[0];
      if (!due) break;
      pending.delete(due[0]); now = Math.max(now, due[1].at); due[1].fn(); await real();
    }
    now = target; await real();
  }
  return { now: () => now, timers, advance };
}

/** The analysis worker as the main thread sees it: one serial queue; the head request starts (its `onStart` is called,
 *  standing for the worker's `started` message) when every earlier request has replied. `silent`: nothing ever starts or
 *  replies (a dead or hung worker). `close` rejects every pending request, like AnalysisWorker.close. */
type Job = { request: AnalysisRequest; onStart?: () => void; started: boolean; resolve(v: unknown): void; reject(e: unknown): void };
class FakeWorker {
  jobs: Job[] = []; closed = false;
  private queue: Job[] = [];
  constructor(private silent: boolean) {}
  init() { return Promise.resolve({ id: 0, ok: true, value: true, elapsedMs: 0, backends: {} }); }
  run(request: AnalysisRequest, _transfer: Transferable[] = [], _ticket?: unknown, onStart?: () => void) {
    if (this.closed) return Promise.reject(new AnalysisError('ANALYSIS_CANCELLED', 'The analysis worker is closed.'));
    return new Promise((resolve, reject) => { const job: Job = { request, onStart, started: false, resolve, reject }; this.jobs.push(job); this.queue.push(job); this.pump(); });
  }
  finish(job: Job, value: unknown) {
    expect(this.queue[0]).toBe(job); // only the running request can reply
    this.queue.shift(); job.resolve({ id: 0, ok: true, value, elapsedMs: 0, backends: {} }); this.pump();
  }
  close(error: unknown) { this.closed = true; for (const j of this.queue) j.reject(error); this.queue = []; }
  private pump() { const head = this.queue[0]; if (head && !head.started && !this.silent) { head.started = true; head.onStart?.(); } }
}
function rig(silent = false) {
  const workers: FakeWorker[] = [];
  const svc = new AnalysisService('/models/', (() => { const w = new FakeWorker(silent); workers.push(w); return w; }) as never);
  vi.spyOn(svc, 'available').mockResolvedValue({ analysis: true, transcription: true, embeddings: true, beats: true });
  h.svc = svc;
  vi.mocked(runWorker).mockImplementation((async (req: { times: number[] }) => frames(req.times)) as never);
  const describes = () => workers.flatMap(w => w.jobs.filter(j => j.request.task === 'describe'));
  return { workers, describes };
}
function prepare(store: ProjectStore, asset: Asset, time: ReturnType<typeof fakeTime>) {
  const promise = prepareAsset(store, asset.id, { clock: time.now, timers: time.timers, steps: {
    probe: async (_blob, a) => video(SECONDS[a.name] * 1000) as never, analysis: analysisStep,
  } });
  const t = { promise, settled: false }; void promise.then(() => { t.settled = true; }); return t;
}
/** Complete, no error code anywhere: asset ready, analysis complete, no step error on our preparation row. */
async function clean(store: ProjectStore, id: string) {
  expect(await stored(store, id)).toMatchObject({ processing_status: 'ready', last_error_code: null, processing_steps: { analysis: 'complete' } });
  expect((await record(store, id))?.stepErrors).toBeUndefined();
}

describe('T37 row 2: the analysis deadline is sized from its work', () => {
  it('row 2: 15, 20 and 23 frames give (MODEL_LOAD_VISION + n × PER_FRAME) × MARGIN; changing any constant changes the deadline; MARGIN ≥ 1/0.75', () => {
    const c = { MODEL_LOAD_VISION, PER_FRAME, MARGIN };
    const formula = (n: number, k = c) => (k.MODEL_LOAD_VISION + n * k.PER_FRAME) * k.MARGIN;
    const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1); // whole-ms rounding allowed
    for (const n of [15, 20, 23]) near(analysisDeadlineMs(n), formula(n));
    expect([30, 40, 45].map(s => frameTimes(s).length)).toEqual([15, 20, 23]);
    for (const v of [MODEL_LOAD_VISION, PER_FRAME]) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThan(0); }
    expect(MARGIN).toBeGreaterThanOrEqual(1 / 0.75);
    expect(analysisDeadlineMs(15)).toBeLessThan(analysisDeadlineMs(20)); expect(analysisDeadlineMs(20)).toBeLessThan(analysisDeadlineMs(23));
    // Each constant doubled in turn (no value assumed): the deadline follows the formula and differs from the current one.
    for (const k of [{ ...c, MODEL_LOAD_VISION: 2 * MODEL_LOAD_VISION }, { ...c, PER_FRAME: 2 * PER_FRAME }, { ...c, MARGIN: 2 * MARGIN }]) {
      for (const n of [15, 20, 23]) { near(analysisDeadlineMs(n, k), formula(n, k)); expect(analysisDeadlineMs(n, k)).not.toBe(analysisDeadlineMs(n)); }
    }
  });
});

describe('T37 the model deadline starts at `started`, not while the request waits', () => {
  it('row 1: the 30 s clip waits behind the 45 s clip for longer than its whole deadline, then finishes inside its deadline after started → both complete, no error code', async () => {
    const d30 = deadline(30), d45 = deadline(45);
    const store = setup(), [a, b] = await upload(store, ['clip45.mp4', 'clip30.mp4']), time = fakeTime(), { workers, describes } = rig();
    const pa = prepare(store, a, time); await vi.waitFor(() => expect(describes()).toHaveLength(1));
    const pb = prepare(store, b, time); await vi.waitFor(() => expect(describes()).toHaveLength(2));
    const [ja, jb] = describes();
    expect(ja.started).toBe(true); expect(jb.started).toBe(false);
    await time.advance((d30 + d45) / 2); // > the 30 s clip's whole deadline; < the 45 s clip's own
    expect(pb.settled).toBe(false); // a deadline counted from the step's call has fired here
    workers[0].finish(ja, DESCRIBED);
    expect(jb.started).toBe(true);
    await time.advance(d30 / 2); workers[0].finish(jb, DESCRIBED);
    expect(await pa.promise).toBe('prepared'); expect(await pb.promise).toBe('prepared');
    await clean(store, a.id); await clean(store, b.id);
  });
  it('row 3: a step that hangs after started (it waited half its deadline first) times out after its own deadline from started: CLIENT_PREPARATION_TIMEOUT, then GEMINI_FAILED, asset ready', async () => {
    const d30 = deadline(30);
    const store = setup(), [a, b] = await upload(store, ['clip45.mp4', 'clip30.mp4']), time = fakeTime(), { workers, describes } = rig();
    const pa = prepare(store, a, time); await vi.waitFor(() => expect(describes()).toHaveLength(1));
    const pb = prepare(store, b, time); await vi.waitFor(() => expect(describes()).toHaveLength(2));
    const [ja, jb] = describes();
    await time.advance(d30 / 2); workers[0].finish(ja, DESCRIBED);
    expect(jb.started).toBe(true);
    await time.advance(0.9 * d30); // 1.4 × the deadline since the step was called, 0.9 × since started
    expect(pb.settled).toBe(false); expect(workers[0].closed).toBe(false);
    await time.advance(0.2 * d30);
    expect(await pb.promise).toBe('prepared');
    expect(await stored(store, b.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED', last_error_message: mediaError('GEMINI_FAILED').message, processing_steps: { analysis: 'failed' } });
    expect(await record(store, b.id)).toMatchObject({ phase: 'finished', stepErrors: { analysis: { code: 'CLIENT_PREPARATION_TIMEOUT' } } });
    expect(await pa.promise).toBe('prepared'); await clean(store, a.id);
  });
  it('row 7: a long queue (30 s, 40 s, 45 s clips) whose jobs each use 75% of their own deadline, total wait under the queue cap → all complete, no error code', async () => {
    // Waits: the 40 s clip 0.75 × d30, the 45 s clip 0.75 × (d30 + d40). With d = MARGIN × (load + n × perFrame) and any
    // positive constants, each wait plus its own work exceeds that clip's deadline (1.5 load + 26.25 perFrame against
    // load + 20 or + 23 perFrame), so a deadline counted from the step's call fails here; each wait is under the sum of the
    // deadlines ahead, so the cap (that sum + slack) does not.
    const d30 = deadline(30), d40 = deadline(40), d45 = deadline(45);
    const store = setup(), [x, y, z] = await upload(store, ['clip30.mp4', 'clip40.mp4', 'clip45.mp4']), time = fakeTime(), { workers, describes } = rig();
    const px = prepare(store, x, time); await vi.waitFor(() => expect(describes()).toHaveLength(1));
    const py = prepare(store, y, time); await vi.waitFor(() => expect(describes()).toHaveLength(2));
    const pz = prepare(store, z, time); await vi.waitFor(() => expect(describes()).toHaveLength(3));
    const [jx, jy, jz] = describes();
    await time.advance(0.75 * d30); workers[0].finish(jx, DESCRIBED);
    await time.advance(0.75 * d40); expect(py.settled).toBe(false); workers[0].finish(jy, DESCRIBED);
    await time.advance(0.75 * d45); expect(pz.settled).toBe(false); workers[0].finish(jz, DESCRIBED);
    for (const p of [px, py, pz]) expect(await p.promise).toBe('prepared');
    for (const a of [x, y, z]) await clean(store, a.id);
  });
});

describe('T37 row 4: a request that never starts fails at the queue cap, with the cap\'s own code', () => {
  it('row 4: the worker never posts started → the step fails with a stored code that is not CLIENT_PREPARATION_TIMEOUT; the asset keeps GEMINI_FAILED and ends ready', async () => {
    const store = setup(), [b] = await upload(store, ['clip30.mp4']), time = fakeTime(), { describes } = rig(true);
    const pb = prepare(store, b, time); await vi.waitFor(() => expect(describes()).toHaveLength(1));
    expect(describes()[0].started).toBe(false);
    // The cap's slack is TBD: advance until the step settles, at most 24 h of fake time.
    for (let i = 0; i < 24 * 60 && !pb.settled; i++) await time.advance(MIN);
    expect(pb.settled).toBe(true);
    expect(await pb.promise).toBe('prepared');
    const code = (await record(store, b.id))?.stepErrors?.analysis?.code;
    expect(code).not.toBe('CLIENT_PREPARATION_TIMEOUT');
    expect(typeof code).toBe('string');
    expect(await stored(store, b.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED', processing_steps: { analysis: 'failed' } });
  });
});

describe('T37 row 5: frame extraction stays on preparationBudgetMs; the model deadline is a separate timer', () => {
  it('row 5 (a) guard: extraction past preparationBudgetMs times out (CLIENT_PREPARATION_TIMEOUT, GEMINI_FAILED, ready) and no model request is sent, so the model deadline is never armed (may pass before the fix)', async () => {
    const budget = preparationBudgetMs(30_000);
    const store = setup(), [b] = await upload(store, ['clip30.mp4']), time = fakeTime(), { describes } = rig();
    let extracting = false;
    vi.mocked(runWorker).mockImplementation(((_req: unknown, signal?: AbortSignal) => { extracting = true; return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })); }) as never);
    const pb = prepare(store, b, time); await vi.waitFor(() => expect(extracting).toBe(true));
    await time.advance(0.9 * budget); expect(pb.settled).toBe(false);
    await time.advance(0.2 * budget);
    expect(await pb.promise).toBe('prepared');
    expect(await stored(store, b.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED', processing_steps: { analysis: 'failed' } });
    expect(await record(store, b.id)).toMatchObject({ stepErrors: { analysis: { code: 'CLIENT_PREPARATION_TIMEOUT' } } });
    expect(describes()).toHaveLength(0);
  });
  it('row 5 (b): extraction ends inside its budget, then the model work runs 0.9 × its own deadline from started; together past the budget → complete, no error code', async () => {
    const d30 = deadline(30), budget = preparationBudgetMs(30_000);
    const extraction = budget - Math.min(0.45 * d30, 0.5 * budget); // < budget, and extraction + 0.9 × d30 > budget
    const store = setup(), [b] = await upload(store, ['clip30.mp4']), time = fakeTime(), { workers, describes } = rig();
    let release: (() => void) | undefined;
    vi.mocked(runWorker).mockImplementation(((req: { times: number[] }) => new Promise(res => { release = () => res(frames(req.times)); })) as never);
    const pb = prepare(store, b, time); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await time.advance(extraction); release!();
    await vi.waitFor(() => expect(describes()).toHaveLength(1));
    expect(describes()[0].started).toBe(true);
    await time.advance(0.9 * d30); expect(pb.settled).toBe(false);
    workers[0].finish(describes()[0], DESCRIBED);
    expect(await pb.promise).toBe('prepared');
    await clean(store, b.id);
  });
});
