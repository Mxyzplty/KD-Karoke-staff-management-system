// SPDX-License-Identifier: AGPL-3.0-only
// T19 review fix R2: the T19 steps no longer run under the attempt budget. Each step has its own deadline, counted from its
// own start with the same formula preparationBudgetMs(durationMs) (6 min for a 60 s clip); only that step's signal aborts
// (reason CLIENT_PREPARATION_TIMEOUT), the step fails with its code and the asset stays ready. A user cancel still aborts the
// whole attempt. Fake time via options.clock / options.timers (setInterval is inert: no heartbeat). Synthetic data only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { mediaError } from '../apps/web/src/media/codes';
import { uploadToLibrary } from '../apps/web/src/media/ingest';
import { cancelPreparation, preparationBudgetMs, prepareAsset } from '../apps/web/src/media/prepare';
import type { AnalysisArgs, PreparationRecord, Steps, Timers } from '../apps/web/src/media/prepare';

const opened: ProjectStore[] = [];
let tick = Date.parse('2026-11-02T00:00:00Z');
function setup() {
  const files = new Map<string, Blob>();
  const media: MediaStore = {
    write: vi.fn(async (id, blob) => { files.set(id, blob); }), read: vi.fn(async id => { const b = files.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; }),
    remove: vi.fn(async (kind, id) => { if (kind === 'asset') files.delete(id); }), list: vi.fn(async () => [...files.keys()]),
  };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
}
afterEach(async () => { vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
async function ready(store: ProjectStore) {
  return (await uploadToLibrary(store, [new File(['synthetic bytes'], 'clip.mp4')], async () => 'rename', { prepare: false })).assets[0];
}
const stored = (store: ProjectStore, id: string) => store.row<Asset>('assets', id);
const info = (durationMs: number) => ({ container: 'mp4', mimeType: 'video/mp4', durationMs, video: null, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null });
const MIN = 60_000, DURATION = 60_000;
const real = (ms = 0) => new Promise<void>(res => setTimeout(res, ms));
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(res => { resolve = res; }); return { promise, resolve }; };

/** Fake time: timers fire only inside advance(); setInterval never fires (no heartbeat), so nothing but the budgets can abort. */
function fakeTime() {
  let now = Date.parse('2026-11-02T00:00:00Z'), seq = 0;
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

describe('T19 R2 formula', () => {
  it('a 60 s clip has a 6 min budget (the number the tests below rely on)', () => { expect(preparationBudgetMs(DURATION)).toBe(6 * MIN); });
});

describe('T19 R2a a T19 step may run past the attempt budget, inside its own deadline', () => {
  it('probe takes 1 min, analysis 5.5 min (6.5 min in all, past the 6 min attempt budget; 5.5 min < the step\'s own 6 min) → asset ready, no error code, analysis complete', async () => {
    const store = setup(), a = await ready(store), time = fakeTime();
    const probe = deferred<ReturnType<typeof info>>(), analysis = deferred<{ state: 'complete' }>(); let probing = false, analysing = false;
    const done = prepareAsset(store, a.id, { clock: time.now, timers: time.timers, steps: {
      probe: () => { probing = true; return probe.promise as never; },
      analysis: () => { analysing = true; return analysis.promise; },
    } });
    await vi.waitFor(() => expect(probing).toBe(true));
    await time.advance(1 * MIN); probe.resolve(info(DURATION));
    await vi.waitFor(() => expect(analysing).toBe(true));
    await time.advance(5.5 * MIN); analysis.resolve({ state: 'complete' });
    expect(await done).toBe('prepared'); // before the fix: 'failed' (CLIENT_PREPARATION_TIMEOUT fired at the 6 min mark)
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: null, processing_steps: { probe: 'complete', analysis: 'complete' } });
    expect(await store.row<PreparationRecord>('preparations', a.id)).toMatchObject({ phase: 'finished' });
  });
  it('guard: the attempt budget still bounds the T14 steps (a probe that never ends → CLIENT_PREPARATION_TIMEOUT, asset failed)', async () => {
    const store = setup(), a = await ready(store), time = fakeTime(); let probing = false;
    const done = prepareAsset(store, a.id, { clock: time.now, timers: time.timers, steps: { probe: () => { probing = true; return new Promise<never>(() => {}); } } });
    await vi.waitFor(() => expect(probing).toBe(true));
    await time.advance(5 * MIN + 1000); // 5 min: the budget while the duration is unknown
    expect(await done).toBe('failed');
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'failed', last_error_code: 'CLIENT_PREPARATION_TIMEOUT' });
  });
});

describe('T19 R2b the step deadline: per step, from its own start; only that step\'s signal aborts', () => {
  /** A step that records its signal (and whether it was already aborted when it started) and never ends. */
  const hang = (box: { signal?: AbortSignal; abortedAtStart?: boolean }) => (args: AnalysisArgs) => { box.signal = args.signal; box.abortedAtStart = args.signal.aborted; return new Promise<never>(() => {}); };
  const reasonCode = (s?: AbortSignal) => (s?.reason as { code?: string } | undefined)?.code;

  it('analysis hangs (ignores its signal): after 6 min its signal is aborted with CLIENT_PREPARATION_TIMEOUT; transcription and embeddings still run with fresh signals; asset ready with GEMINI_FAILED, phase finished', async () => {
    const store = setup(), a = await ready(store), time = fakeTime();
    const an: { signal?: AbortSignal; abortedAtStart?: boolean } = {}, tr: { signal?: AbortSignal; abortedAtStart?: boolean } = {}, em: { signal?: AbortSignal; abortedAtStart?: boolean } = {};
    const done = prepareAsset(store, a.id, { clock: time.now, timers: time.timers, steps: {
      probe: async () => info(DURATION) as never, analysis: hang(an),
      transcription: async args => { tr.signal = args.signal; tr.abortedAtStart = args.signal.aborted; return { state: 'complete' }; },
      embeddings: async args => { em.signal = args.signal; em.abortedAtStart = args.signal.aborted; return { states: { embeddings_description: 'complete', embeddings_transcript: 'complete' } }; },
    } });
    await vi.waitFor(() => expect(an.signal).toBeDefined());
    expect(an.signal!.aborted).toBe(false);
    await time.advance(6 * MIN + 1000);
    expect(an.signal!.aborted).toBe(true);
    expect(reasonCode(an.signal)).toBe('CLIENT_PREPARATION_TIMEOUT');
    expect(await done).toBe('prepared');
    expect(tr.abortedAtStart).toBe(false); expect(em.abortedAtStart).toBe(false);
    expect(tr.signal).not.toBe(an.signal); expect(em.signal).not.toBe(an.signal);
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED',
      processing_steps: { analysis: 'failed', transcription: 'complete', embeddings_description: 'complete', embeddings_transcript: 'complete' } });
    expect(await store.row<PreparationRecord>('preparations', a.id)).toMatchObject({ phase: 'finished' }); // not 'failed' / RETRY_LIMIT_EXCEEDED
    expect((await stored(store, a.id))?.last_error_code).not.toBe('RETRY_LIMIT_EXCEEDED');
  });
  it('the deadline is counted from each step\'s own start: transcription (started after the analysis timed out) is aborted 6 min after its own start, not before', async () => {
    const store = setup(), a = await ready(store), time = fakeTime();
    const an: { signal?: AbortSignal } = {}, tr: { signal?: AbortSignal } = {}; let embeddings = 0;
    const done = prepareAsset(store, a.id, { clock: time.now, timers: time.timers, steps: {
      probe: async () => info(DURATION) as never, analysis: hang(an), transcription: hang(tr),
      embeddings: async () => { embeddings++; },
    } });
    await vi.waitFor(() => expect(an.signal).toBeDefined());
    await time.advance(6 * MIN + 1000);
    expect(reasonCode(an.signal)).toBe('CLIENT_PREPARATION_TIMEOUT');
    await vi.waitFor(() => expect(tr.signal).toBeDefined());
    expect(tr.signal!.aborted).toBe(false);
    await time.advance(5 * MIN); // 11+ min since the attempt began, 5 min since transcription began
    expect(tr.signal!.aborted).toBe(false);
    await time.advance(1 * MIN + 1000);
    expect(reasonCode(tr.signal)).toBe('CLIENT_PREPARATION_TIMEOUT');
    expect(await done).toBe('prepared');
    expect(embeddings).toBe(1);
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'GEMINI_FAILED', // the first failure wins
      processing_steps: { analysis: 'failed', transcription: 'failed' } });
  });
  it('a step that finishes in time leaves nothing behind: its deadline does not abort a later step', async () => {
    const store = setup(), a = await ready(store), time = fakeTime(); const tr: { signal?: AbortSignal } = {};
    const done = prepareAsset(store, a.id, { clock: time.now, timers: time.timers, steps: {
      probe: async () => info(DURATION) as never, analysis: async () => ({ state: 'complete' }), transcription: hang(tr),
    } });
    await vi.waitFor(() => expect(tr.signal).toBeDefined());
    await time.advance(5 * MIN); // past the analysis step's would-be deadline (its 6 min is over 1 min after transcription started)... still inside transcription's own
    expect(tr.signal!.aborted).toBe(false);
    await time.advance(1 * MIN + 1000);
    expect(reasonCode(tr.signal)).toBe('CLIENT_PREPARATION_TIMEOUT');
    expect(await done).toBe('prepared');
    expect(await stored(store, a.id)).toMatchObject({ processing_status: 'ready', last_error_code: 'TRANSCRIPTION_FAILED', processing_steps: { analysis: 'complete', transcription: 'failed' } });
  });
});

describe('T19 R2c a user cancel during a T19 step still aborts the whole attempt (guard; may pass before the fix)', () => {
  it('the step\'s signal is aborted, the phase is cancelled by the user, later steps do not run, the result is failed', async () => {
    const store = setup(), a = await ready(store), time = fakeTime(); let signal: AbortSignal | undefined, transcription = 0, embeddings = 0;
    const done = prepareAsset(store, a.id, { clock: time.now, timers: time.timers, steps: {
      probe: async () => info(DURATION) as never,
      analysis: args => { signal = args.signal; return new Promise<never>((_, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true })); },
      transcription: async () => { transcription++; }, embeddings: async () => { embeddings++; },
    } });
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(cancelPreparation(a.id)).toBe(true);
    expect(await done).toBe('failed');
    expect(signal!.aborted).toBe(true);
    expect((signal!.reason as { code?: string }).code).toBe('CLIENT_PREPARATION_CANCELLED');
    expect(await store.row<PreparationRecord>('preparations', a.id)).toMatchObject({ phase: 'cancelled', cancelledBy: 'user' });
    expect(transcription).toBe(0); expect(embeddings).toBe(0);
  });
});
