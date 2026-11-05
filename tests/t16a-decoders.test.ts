// SPDX-License-Identifier: AGPL-3.0-only
// T16a export decoders (apps/web/src/export/decoders.ts), against a stub Worker. Oracle: master plan §1b, "a budget slows the export,
// it never fails it", and T15's pool rules (render/decoder-pool.ts: a worker `error` event or a timeout restarts the worker once and
// asks again; a second failure fails). Real workers are exercised end to end in tests/ui/t16a-budgets.spec.ts; the paths below need
// a worker that fails or answers on cue, which a real one cannot do reliably.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDecoders, exportFaults, REQUEST_TIMEOUT_MS } from '../apps/web/src/export/decoders';
import { awaitExport, cancelExport, startExport } from '../apps/web/src/export/index';

// The job layer runs against a stub pipeline: it opens a real ExportDecoders and waits for one frame, as the real pipeline does,
// and closes the decoders when it ends.
vi.mock('../apps/web/src/export/pipeline', () => ({
  runExport: async () => {
    const { ExportDecoders: Decoders } = await import('../apps/web/src/export/decoders');
    const d = new Decoders();
    try { await d.frame({ key: 'a', blob: new Blob(['x']), rotation: 0, stackedAlpha: false }, 0); } finally { d.closeAll(); }
    throw new Error('the stub pipeline expects the decode to hang');
  },
}));

type Req = { id: number; key: string; forceWasm: boolean; timeS: number };
/** A scripted Worker: `script(worker, request)` decides what each posted request does (reply, error, or nothing). */
class StubWorker {
  static all: StubWorker[] = [];
  static script: (w: StubWorker, r: Req) => void = () => undefined;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  posted: Req[] = []; terminated = false;
  constructor(public url: unknown, public options: unknown) { StubWorker.all.push(this); }
  postMessage(r: Req) { this.posted.push(r); queueMicrotask(() => { if (!this.terminated) StubWorker.script(this, r); }); }
  terminate() { this.terminated = true; }
  ok(r: Req, ts = 0) { this.onmessage?.({ data: { id: r.id, ok: true, ts, nextTs: ts + 1, first: true, width: 2, height: 2, bitmap: { close() { /* stub */ } } } }); }
  fail(r: Req, code: string) { this.onmessage?.({ data: { id: r.id, ok: false, code, message: `${code} from stub` } }); }
  /** The `error` event the browser fires when a module worker cannot load or start (empty message). */
  crash() { this.onerror?.({ message: '', preventDefault() { /* stub */ } }); }
}
const ref = (key: string) => ({ key, blob: new Blob(['x']), rotation: 0 as const, stackedAlpha: false });
const realWorker = (globalThis as { Worker?: unknown }).Worker;
beforeEach(() => { StubWorker.all = []; StubWorker.script = (w, r) => w.ok(r); (globalThis as { Worker?: unknown }).Worker = StubWorker; });
afterEach(() => { (globalThis as { Worker?: unknown }).Worker = realWorker; exportFaults.timeouts = 0; });

describe('T16a decoder worker error event (review-1 R1)', () => {
  it('R1: the first worker spawn fires an error event, the second answers: frame() resolves and a second worker was opened', async () => {
    let n = 0;
    StubWorker.script = (w, r) => { n++; if (n === 1) w.crash(); else w.ok(r); };
    const d = new ExportDecoders();
    const f = await d.frame(ref('a'), 0);
    expect(f.width).toBe(2);
    expect(d.stats.opened).toBe(2);
    expect(StubWorker.all[0].terminated).toBe(true);
    d.closeAll();
  });
  it('R1: two worker errors in a row fail the export with a transient error (one restart, not a loop)', async () => {
    StubWorker.script = w => w.crash();
    const d = new ExportDecoders();
    await expect(d.frame(ref('a'), 0)).rejects.toMatchObject({ transient: true });
    expect(d.stats.opened).toBe(2);
    d.closeAll();
  });
});

describe('T16a WASM reopen with parallel waiters (review-1 N1)', () => {
  it('N1: two parallel frames on one key, WebCodecs answers DECODE_ERROR: both resolve through the one WASM worker, one reopen', async () => {
    StubWorker.script = (w, r) => { if (r.forceWasm) w.ok(r); else w.fail(r, 'DECODE_ERROR'); };
    const d = new ExportDecoders();
    const [a, b] = await Promise.all([d.frame(ref('a'), 0), d.frame(ref('a'), 5000)]);
    expect(a.width).toBe(2);
    expect(b.width).toBe(2);
    expect(d.stats.wasmRetries).toBe(1);
    expect(StubWorker.all.filter(w => w.posted.some(p => p.forceWasm)).length).toBe(1);
    expect(StubWorker.all.every(w => w.posted.every(p => p.forceWasm === w.posted[0].forceWasm))).toBe(true);
    d.closeAll();
  });
  it('N1: a request still pending when another call\'s WASM reopen ends its worker is sent again to the new worker, not failed as DECODE_ERROR', async () => {
    // Request 1 fails at once (starts the reopen); request 2 stays pending on the WebCodecs worker until that worker is ended.
    const held: Req[] = [];
    StubWorker.script = (w, r) => {
      if (r.forceWasm) return w.ok(r);
      if (held.length === 0) { held.push(r); w.fail(r, 'DECODE_ERROR'); } else held.push(r);
    };
    const d = new ExportDecoders();
    const [a, b] = await Promise.all([d.frame(ref('a'), 0), d.frame(ref('a'), 5000)]);
    expect(a.width).toBe(2);
    expect(b.width).toBe(2);
    expect(held.length).toBe(2);
    expect(d.stats.wasmRetries).toBe(1);
    d.closeAll();
  });
});

describe('T16a closeAll (review-1 N2)', () => {
  it('N2: closeAll before a frame() starts: it rejects with closed and no Worker is constructed', async () => {
    const d = new ExportDecoders();
    d.closeAll();
    await expect(d.frame(ref('a'), 0)).rejects.toMatchObject({ closed: true });
    expect(StubWorker.all.length).toBe(0);
    expect(d.stats.open).toBe(0);
  });
  it('N2: closeAll while a frame() waits on the worker: it rejects with closed, nothing opens afterwards', async () => {
    StubWorker.script = () => undefined; // never answers
    const d = new ExportDecoders();
    const p = d.frame(ref('a'), 0);
    await new Promise(r => setTimeout(r, 10));
    expect(StubWorker.all.length).toBe(1);
    d.closeAll();
    await expect(p).rejects.toMatchObject({ closed: true });
    expect(StubWorker.all.length).toBe(1);
    expect(d.stats.open).toBe(0);
  });
  it('N2: closeAll while a second key waits at the cap (max 1): the waiter rejects with closed and no worker spawns for it', async () => {
    StubWorker.script = () => undefined;
    const d = new ExportDecoders(false, 1);
    const first = d.frame(ref('a'), 0, new Set(['a', 'b'])), second = d.frame(ref('b'), 0, new Set(['a', 'b']));
    first.catch(() => undefined);
    await new Promise(r => setTimeout(r, 10));
    expect(StubWorker.all.length).toBe(1); // 'b' waits: 'a' is busy
    d.closeAll();
    await expect(second).rejects.toMatchObject({ closed: true });
    await expect(first).rejects.toMatchObject({ closed: true });
    expect(StubWorker.all.length).toBe(1);
    expect(StubWorker.all.every(w => w.terminated)).toBe(true);
    expect(d.stats.open).toBe(0);
  });
  it('N2: a prefetch that resolves its source after closeAll cannot start a worker', async () => {
    const d = new ExportDecoders();
    const late = new Promise<ReturnType<typeof ref>>(r => setTimeout(() => r(ref('a')), 20)).then(r => d.frame(r, 0));
    d.closeAll();
    await expect(late).rejects.toMatchObject({ closed: true });
    expect(StubWorker.all.length).toBe(0);
  });
});

describe('T16a cancel during a hung decode (freeze 5)', () => {
  // Both decode requests (the first and the one after the worker restart) time out after REQUEST_TIMEOUT_MS each.
  const hungFor = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
  beforeEach(() => { vi.useFakeTimers(); StubWorker.script = () => undefined; });
  afterEach(() => { vi.useRealTimers(); });

  it('control: a hung decode with no abort ends as TIMEOUT after both requests time out', async () => {
    const id = startExport({ projectKey: 'hung-control' } as never), done = awaitExport(id);
    await hungFor(2 * REQUEST_TIMEOUT_MS + 1000);
    const st = await done;
    expect(st.status).toBe('failed');
    expect(st.error?.code).toBe('TIMEOUT');
  });
  it('cancelExport during the wait ends the job as USER_CANCELLED, not TIMEOUT', async () => {
    const id = startExport({ projectKey: 'hung-cancel' } as never), done = awaitExport(id);
    await hungFor(5000);
    cancelExport(id);
    await hungFor(2 * REQUEST_TIMEOUT_MS + 1000);
    const st = await done;
    expect(st.status).toBe('failed');
    expect(st.error?.code).toBe('USER_CANCELLED');
  });
  it('a second startExport of the same project during the wait ends the first job as SUPERSEDED, not TIMEOUT', async () => {
    const first = startExport({ projectKey: 'hung-supersede' } as never), firstDone = awaitExport(first);
    await hungFor(5000);
    const second = startExport({ projectKey: 'hung-supersede' } as never), secondDone = awaitExport(second);
    await hungFor(2 * REQUEST_TIMEOUT_MS + 1000);
    const st = await firstDone;
    expect(st.status).toBe('failed');
    expect(st.error?.code).toBe('SUPERSEDED');
    await secondDone; // the newer job hangs too; only the first job's code is asserted
  });
});
