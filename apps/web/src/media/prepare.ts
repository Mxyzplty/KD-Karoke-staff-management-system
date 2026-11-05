// SPDX-License-Identifier: AGPL-3.0-only
// On-device preparation (error codes §13): probe → thumbnails / waveform / proxy, with preparation records in IndexedDB
// shared across tabs (attempt ids, 30 s heartbeat with a 20 s timeout, 10 min staleness), the 4 × duration + 2 min budget
// clamped to 5–30 min, a source-revision check before publishing, and the classified last_error_code on failure.
// Ownership (review F3): the preparation lock is taken before the record is claimed, and every write is made only while
// this attempt still owns the record (ProjectStore.ownerWrite). Hiding or leaving the page cancels (review F11).
import type { ProjectStore, StoreName } from '../store/database';
import type { Asset, ProcessingStep } from '../store/model';
import { classifyPreparation, mediaError, MediaError } from './codes';
import type { MediaCode } from './codes';
import { lockNames, tryLock } from './locks';
import { placeName } from './geocode';
import type { MediaInfo } from './probe';

export type PreparationRecord = { id: string; attemptId: string; phase: 'running' | 'finished' | 'failed' | 'interrupted' | 'cancelled'; startedAt: number; updatedAt: number; sourceRevision: string | null; budgetMs: number; code?: string; cancelledBy?: 'user' };
export type ThumbnailRow = { id: string; width: number; height: number; poster: Blob; frames: { t: number; blob: Blob }[] };
export type WaveformRow = { id: string; version: 1; bucketsPerSecond: number; durationMs: number; sampleRate: number; channels: number; peaks: Float32Array };
export type ProxyResult = { blob: Blob; codec: string; container: string; width: number; height: number };
type StepArgs = { blob: Blob; asset: Asset; info: MediaInfo; signal: AbortSignal };
/** T19 step input: `results` holds each earlier T19 step's value by step name (null when it failed or gave none). */
export type AnalysisArgs = StepArgs & { results: Record<string, unknown> };
/** A T19 step's outcome: its state (or one state per recorded step name), the rows published with it, and the value later
 *  steps read. void = complete with nothing stored. */
export type StepOutcome = void | { state?: ProcessingStep; states?: Record<string, ProcessingStep>; puts?: { store: StoreName; value: unknown }[]; value?: unknown };
export type Steps = {
  probe(blob: Blob, asset: Asset): Promise<MediaInfo>;
  thumbnails?(a: StepArgs): Promise<Omit<ThumbnailRow, 'id'>>;
  waveform?(a: StepArgs): Promise<Omit<WaveformRow, 'id'> | null>;
  proxy?(a: StepArgs): Promise<ProxyResult | null>;
  /** T19 steps. Absent = no provider: the step is recorded "unavailable", never a fake success. */
  analysis?(a: AnalysisArgs): Promise<StepOutcome>;
  transcription?(a: AnalysisArgs): Promise<StepOutcome>;
  embeddings?(a: AnalysisArgs): Promise<StepOutcome>;
};
export type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };
export type PrepareOptions = { steps?: Partial<Steps>; clock?: () => number; signal?: AbortSignal; timers?: Timers; manual?: boolean };
export const HEARTBEAT_MS = 30_000, HEARTBEAT_TIMEOUT_MS = 20_000, STALE_MS = 10 * 60_000, RETRY_BUDGET = 3;
export const prepareLock = lockNames.prepare;
/** 4 × clip duration + 2 min, clamped to 5–30 min (error codes §13). */
export const preparationBudgetMs = (durationMs: number | null) => Math.min(30 * 60_000, Math.max(5 * 60_000, 4 * (durationMs ?? 0) + 2 * 60_000));
const ABORT_CODES: MediaCode[] = ['CLIENT_PREPARATION_TIMEOUT', 'CLIENT_PREPARATION_CANCELLED', 'LOCAL_PREPARATION_ATTEMPT_CHANGED', 'LOCAL_PREPARATION_ATTEMPT_FINISHED', 'LOCAL_PREPARATION_CONTROL_FAILED', 'LOCAL_PREPARATION_SOURCE_CHANGED', 'LOCAL_PREPARATION_PUBLICATION_FAILED'];
/** Failures that leave the original usable (§13: other preparation failures fall back to the original file). */
const ORIGINAL_STILL_USABLE: MediaCode[] = ['ENCODE_FAILED', 'EXTRACTION_FAILED'];
let defaultSteps: Promise<Steps> | undefined;
const loadDefaultSteps = () => defaultSteps ??= import('./worker-client').then(m => m.browserSteps());

/** Page lifecycle (review F11): hidden or leaving → every running preparation is cancelled; visible again → `resume`. */
let page = new AbortController();
let resumeVisible: (() => void) | undefined;
export function bindPreparationLifecycle(resume: () => void): () => void {
  resumeVisible = resume;
  const hide = () => page.abort(mediaError('CLIENT_PREPARATION_CANCELLED'));
  const visibility = () => { if (document.visibilityState === 'hidden') hide(); else if (page.signal.aborted) { page = new AbortController(); resume(); } };
  window.addEventListener('pagehide', hide); document.addEventListener('visibilitychange', visibility);
  return () => { window.removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', visibility); if (resumeVisible === resume) resumeVisible = undefined; };
}
/** Attempts running in this tab, by asset id. The Background Jobs panel (T02) can cancel exactly these, never another tab's. */
const localAttempts = new Map<string, () => void>();
export const preparingHere = (assetId: string) => localAttempts.has(assetId);
/** The user cancels this tab's running attempt: CLIENT_PREPARATION_CANCELLED, no retry budget used, and it is not resumed
 *  automatically (Retry restarts it). Returns false when this tab runs no attempt for the asset. */
export function cancelPreparation(assetId: string): boolean { const cancel = localAttempts.get(assetId); cancel?.(); return !!cancel; }
export async function prepareAsset(store: ProjectStore, assetId: string, options: PrepareOptions = {}): Promise<'prepared' | 'already-active' | 'cancelled' | 'failed' | 'gone'> {
  const clock = options.clock ?? Date.now, timers = options.timers ?? globalThis;
  const attemptId = crypto.randomUUID(), pageSignal = page.signal;
  try {
    // The attempt lock lives for the work; the asset lock only serializes claims/recovery. A hung obsolete attempt cannot
    // block retries of its replacement. The running record, not that obsolete native lock, is the current lease (F17).
    const locked = await tryLock(lockNames.prepareAttempt(assetId, attemptId), async () => {
      const claim = await tryLock(prepareLock(assetId), async () => {
        const asset = await store.row<Asset>('assets', assetId);
        if (!asset) return { result: 'gone' as const };
        if (asset.processing_steps?.upload !== 'complete') { await recordFailure(store, assetId, mediaError('SOURCE_MISSING'), false); return { result: 'failed' as const }; }
        const now = clock();
        let userCancelled = false;
        const record = await store.swapRow<PreparationRecord>('preparations', assetId, current => {
          // Review R12: a user's Cancel holds until an explicit (manual) Retry. Checked on the current record inside the claim
          // transaction, so an automatic scan that read an older snapshot cannot restart it.
          userCancelled = !options.manual && current?.phase === 'cancelled' && current.cancelledBy === 'user';
          if (userCancelled) return null;
          if (current?.phase === 'running' && now - current.updatedAt < STALE_MS) return null;
          return { id: assetId, attemptId, phase: 'running', startedAt: now, updatedAt: now, sourceRevision: asset.sha256 ?? null, budgetMs: preparationBudgetMs(asset.durationMs) };
        });
        return record ? { asset, record } : { result: userCancelled ? 'cancelled' as const : 'already-active' as const };
      });
      if (!claim.ran) return 'already-active' as const;
      if ('result' in claim.value) return claim.value.result!;
      return run(store, claim.value.asset, claim.value.record, { ...options, clock, timers });
    });
    return locked.ran ? locked.value : 'already-active';
  } finally {
    // F19: the first visible rescan may have met this attempt while cancellation was still committing. Rescan after
    // its native lock releases as well; cancellation itself continues to consume no retry budget.
    if (pageSignal.aborted && !page.signal.aborted) resumeVisible?.();
  }
}
async function run(store: ProjectStore, asset: Asset, record: PreparationRecord, options: PrepareOptions & { clock: () => number; timers: Timers }): Promise<'prepared' | 'failed'> {
  const { clock, timers } = options, controller = new AbortController();
  let proxyKey: string | undefined, proxyPublished = false;
  let abortError: MediaError | undefined;
  const abort = (e: MediaError) => { if (!abortError) { abortError = e; controller.abort(e); } };
  const onCancel = () => abort(mediaError('CLIENT_PREPARATION_CANCELLED'));
  let userCancelled = false;
  const cancelHere = () => { if (!abortError) userCancelled = true; onCancel(); };
  localAttempts.set(asset.id, cancelHere);
  const signals = [options.signal, page.signal].filter(Boolean) as AbortSignal[];
  for (const s of signals) { if (s.aborted) onCancel(); else s.addEventListener('abort', onCancel, { once: true }); }
  // Budget (review F4): first from the record's known duration (5 min when unknown) to bound the probe, then re-armed from
  // the probed duration, minus the time already spent.
  let budget = timers.setTimeout(() => abort(mediaError('CLIENT_PREPARATION_TIMEOUT')), record.budgetMs);
  /** Heartbeat: proves this attempt still owns the record; a failed or slow write is CONTROL_FAILED. */
  const control = async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const write = store.swapRow<PreparationRecord>('preparations', record.id, row => {
      if (!row || row.attemptId !== record.attemptId) { abort(mediaError('LOCAL_PREPARATION_ATTEMPT_CHANGED')); return null; }
      if (row.phase !== 'running') { abort(mediaError('LOCAL_PREPARATION_ATTEMPT_FINISHED')); return null; }
      return { ...row, updatedAt: clock() };
    });
    try {
      await Promise.race([write, new Promise((_, reject) => { timeout = timers.setTimeout(() => reject(new Error('heartbeat timed out')), HEARTBEAT_TIMEOUT_MS); })]);
    } catch { abort(mediaError('LOCAL_PREPARATION_CONTROL_FAILED')); } finally { timers.clearTimeout(timeout); }
  };
  const heartbeat = timers.setInterval(() => void control(), HEARTBEAT_MS);
  const checkpoint = () => { if (abortError) throw abortError; };
  const raceAbort = <T>(work: Promise<T>, signal = controller.signal) => signal.aborted ? Promise.reject<T>(signal.reason) : Promise.race([work, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
  const steps: Partial<Steps> = { ...(options.steps?.probe ? {} : await loadDefaultSteps().catch(() => ({}))), ...options.steps };
  const stepState: Record<string, ProcessingStep> = { ...asset.processing_steps };
  /** Every write: only while this attempt owns the record; publications also require the original it started from. */
  const owned = async (write: Parameters<ProjectStore['ownerWrite']>[2], publication = false) => {
    checkpoint();
    let outcome: Awaited<ReturnType<ProjectStore['ownerWrite']>>;
    try { outcome = await store.ownerWrite(asset.id, record.attemptId, publication ? { ...write, sourceRevision: record.sourceRevision } : write); }
    catch (e) { if (!publication) throw e; throw mediaError('LOCAL_PREPARATION_PUBLICATION_FAILED', undefined, { reason: (e as Error)?.message }); }
    if (outcome === 'lost') throw mediaError('LOCAL_PREPARATION_ATTEMPT_CHANGED');
    if (outcome === 'finished') throw mediaError('LOCAL_PREPARATION_ATTEMPT_FINISHED');
    if (outcome === 'changed' || outcome === 'gone') throw mediaError('LOCAL_PREPARATION_SOURCE_CHANGED');
  };
  const setSteps = async (states: Record<string, ProcessingStep>) => { await owned({ asset: a => ({ ...a, processing_steps: { ...a.processing_steps, ...states } }) }); Object.assign(stepState, states); };
  const setStep = (name: string, state: ProcessingStep) => setSteps({ [name]: state });
  try {
    // Review R14: a retried asset (an earlier attempt failed or was cancelled) is processing again while this attempt runs,
    // without the stale error, so its job row is Running with Cancel. An owner write like every other.
    if (asset.processing_status === 'failed') await owned({ asset: a => a.processing_status === 'failed' ? { ...a, processing_status: 'processing', last_error_code: null, last_error_message: null } : a });
    const blob = await store.media.read(asset.id).catch(e => { throw (e as { code?: string }).code === 'WORKSPACE_FILE_MISSING' ? mediaError('OBJECT_MISSING') : e; });
    await setStep('probe', 'processing');
    const info = await raceAbort(steps.probe!(blob, asset));
    const location = await placeName(info.latitude, info.longitude).catch(() => null);
    const budgetMs = preparationBudgetMs(info.durationMs);
    timers.clearTimeout(budget); budget = timers.setTimeout(() => abort(mediaError('CLIENT_PREPARATION_TIMEOUT')), Math.max(0, record.startedAt + budgetMs - clock()));
    await owned({ asset: a => ({ ...a, media: info, durationMs: info.durationMs, recorded_at: info.capturedAt, latitude: info.latitude, longitude: info.longitude, location, processing_steps: { ...a.processing_steps, probe: 'complete' } }),
      preparation: row => ({ ...row, budgetMs }) }, true);
    stepState.probe = 'complete';
    const args: StepArgs = { blob, asset: { ...asset, media: info }, info, signal: controller.signal };
    if (steps.thumbnails && asset.type !== 'audio') {
      await setStep('thumbnails', 'processing');
      const thumbs = await raceAbort(steps.thumbnails(args));
      await owned({ puts: [{ store: 'thumbnails', value: { id: asset.id, ...thumbs } }], asset: a => ({ ...a, processing_steps: { ...a.processing_steps, thumbnails: 'complete' } }) }, true);
      stepState.thumbnails = 'complete';
    }
    if (steps.waveform && info.audio) {
      await setStep('waveform', 'processing');
      const wave = await raceAbort(steps.waveform(args));
      await owned({ puts: wave ? [{ store: 'waveforms', value: { id: asset.id, ...wave } }] : [], asset: a => ({ ...a, processing_steps: { ...a.processing_steps, waveform: wave ? 'complete' : 'unavailable' } }) }, true);
      stepState.waveform = wave ? 'complete' : 'unavailable';
    }
    let proxyFailure: MediaCode | undefined;
    if (steps.proxy && asset.type === 'video') {
      await setStep('proxy', 'processing');
      try {
        const proxy = await raceAbort(steps.proxy(args));
        if (proxy) {
          await owned({}, true);
          if (!store.media.writeProxy) throw mediaError('LOCAL_PREPARATION_PUBLICATION_FAILED', 'This media store cannot keep proxies.');
          proxyKey = `${asset.id}~${record.attemptId}`;
          await store.media.writeProxy(proxyKey, proxy.blob).catch(e => { throw mediaError('LOCAL_PREPARATION_PUBLICATION_FAILED', undefined, { reason: (e as Error)?.message }); });
          await owned({ asset: a => ({ ...a, proxy: { objectKey: proxyKey, codec: proxy.codec, container: proxy.container, width: proxy.width, height: proxy.height, sizeBytes: proxy.blob.size, created_at: new Date(clock()).toISOString() }, processing_steps: { ...a.processing_steps, proxy: 'complete' } }) }, true);
          proxyPublished = true;
        } else await setStep('proxy', 'unavailable');
        stepState.proxy = proxy ? 'complete' : 'unavailable';
      } catch (e) {
        const code = classifyPreparation(e);
        if (ABORT_CODES.includes(code) || !ORIGINAL_STILL_USABLE.includes(code)) throw e;
        proxyFailure = code; await setStep('proxy', 'failed');
      }
    }
    // T19 (Xapp's steps, part 3 §44.5): analysis (Xapp's `gemini`), transcription, then the search index, recorded as
    // embeddings_description / embeddings_transcript. With no provider a step stays "unavailable" (a clear no-provider
    // state); a failed step leaves the asset ready with its code. Its rows are published with its state.
    // Review R2: the attempt budget bounds the part above. Each T19 step has its own deadline (same formula, from its
    // start) on a controller linked to the attempt's: expiry fails only that step; cancel, page hide and the heartbeat
    // still abort the attempt.
    timers.clearTimeout(budget);
    let analysisFailure: MediaCode | undefined;
    const results: Record<string, unknown> = {};
    const t19 = [['analysis', 'GEMINI_FAILED', ['analysis']], ['transcription', 'TRANSCRIPTION_FAILED', ['transcription']], ['embeddings', 'EMBEDDING_FAILED', ['embeddings_description', 'embeddings_transcript']]] as const;
    for (const [name, code, recorded] of t19) {
      const step = steps[name], all = (state: ProcessingStep) => Object.fromEntries(recorded.map(n => [n, state]));
      results[name] = null;
      if (!step) { await setSteps(all('unavailable')); continue; }
      const own = new AbortController(), link = () => own.abort(controller.signal.reason);
      if (controller.signal.aborted) link(); else controller.signal.addEventListener('abort', link, { once: true });
      const deadline = timers.setTimeout(() => own.abort(mediaError('CLIENT_PREPARATION_TIMEOUT')), budgetMs);
      // Review R1: ANALYSIS_CANCELLED while this step's signal is not aborted = another request terminated the shared
      // analysis worker. The step is re-run (it decodes its input again) at most twice; its rows are never published.
      const collateral = (e: unknown) => (e as { code?: string }).code === 'ANALYSIS_CANCELLED' && !own.signal.aborted;
      try {
        await setSteps(all('processing'));
        let outcome: Awaited<ReturnType<typeof step>>;
        for (let rerun = 0; ; rerun++) {
          try { outcome = await raceAbort(step({ ...args, signal: own.signal, results }), own.signal); break; } catch (e) { if (rerun < 2 && collateral(e)) continue; throw e; }
        }
        const states = outcome?.states ?? all(outcome?.state ?? 'complete');
        await owned({ puts: outcome?.puts ?? [], asset: a => ({ ...a, processing_steps: { ...a.processing_steps, ...states } }) }, true);
        Object.assign(stepState, states); results[name] = outcome?.value ?? null;
      } catch (e) {
        if (abortError) throw abortError; if ((e as { code?: string }).code?.startsWith('LOCAL_PREPARATION_')) throw e; analysisFailure ??= code;
        // A step that failed by itself may carry rows that say why (T19 C2: the transcript row `{status: "failed", error}`);
        // not one that ran out of time or was cancelled by another request.
        const puts = own.signal.aborted || collateral(e) ? undefined : (e as { puts?: { store: StoreName; value: unknown }[] }).puts;
        if (!puts?.length) await setSteps(all('failed'));
        else { await owned({ puts, asset: a => ({ ...a, processing_steps: { ...a.processing_steps, ...all('failed') } }) }, true); Object.assign(stepState, all('failed')); }
      } finally { timers.clearTimeout(deadline); controller.signal.removeEventListener('abort', link); }
    }
    const failure = proxyFailure ?? analysisFailure;
    await owned({ preparation: row => ({ ...row, phase: 'finished', updatedAt: clock(), code: failure }),
      asset: a => ({ ...a, processing_status: 'ready', preparationAttempts: 0, last_error_code: failure ?? null, last_error_message: failure ? mediaError(failure).message : null }) });
    return 'prepared';
  } catch (e) {
    const error = abortError ?? e;
    const code = classifyPreparation(error);
    if (code !== 'LOCAL_PREPARATION_ATTEMPT_CHANGED' && code !== 'LOCAL_PREPARATION_ATTEMPT_FINISHED') {
      // A cancellation (page hidden, user) is not a failed attempt: it does not use up the retry budget.
      const counted = !options.manual && code !== 'CLIENT_PREPARATION_CANCELLED';
      await store.ownerWrite(asset.id, record.attemptId, { preparation: row => ({ ...row, phase: code === 'CLIENT_PREPARATION_CANCELLED' ? 'cancelled' : 'failed', updatedAt: clock(), code, ...(userCancelled ? { cancelledBy: 'user' as const } : {}) }),
        asset: a => failed(a, error instanceof MediaError ? error : mediaError(code, undefined, { reason: (error as Error)?.message }), counted, stepState) }).catch(() => null);
    }
    return 'failed';
  } finally {
    timers.clearTimeout(budget); timers.clearInterval(heartbeat);
    if (localAttempts.get(asset.id) === cancelHere) localAttempts.delete(asset.id);
    for (const s of signals) s.removeEventListener('abort', onCancel);
    if (proxyKey && !proxyPublished) await store.media.removeProxy?.(proxyKey).catch(() => {});
  }
}
function failed(a: Asset, error: MediaError, counted: boolean, steps?: Record<string, ProcessingStep>): Asset {
  const code = classifyPreparation(error), attempts = (a.preparationAttempts ?? 0) + (counted ? 1 : 0);
  const final: MediaCode = counted && attempts >= RETRY_BUDGET ? 'RETRY_LIMIT_EXCEEDED' : code;
  const steps2 = { ...a.processing_steps, ...steps };
  for (const [k, v] of Object.entries(steps2)) if (v === 'processing') steps2[k] = 'failed';
  return { ...a, processing_steps: steps2, preparationAttempts: attempts, processing_status: ORIGINAL_STILL_USABLE.includes(code) && a.media ? 'ready' : 'failed',
    last_error_code: final, last_error_message: final === code ? error.message : mediaError(final).message };
}
async function recordFailure(store: ProjectStore, assetId: string, error: MediaError, counted: boolean) {
  await store.updateAsset(assetId, a => failed(a, error, counted));
}
/** On load: a running record whose tab is gone, or with no progress for 10 min, is interrupted (only when no code was recorded). */
export async function scanInterrupted(store: ProjectStore, clock = Date.now): Promise<string[]> {
  const found: string[] = [];
  const mark = async (row: PreparationRecord, busy: boolean) => {
    const error = mediaError('CLIENT_PREPARATION_INTERRUPTED');
    const marked = await store.ownerWrite(row.id, row.attemptId, {
      predicate: r => !busy || clock() - Number(r.updatedAt) >= STALE_MS,
      preparation: r => ({ ...r, phase: 'interrupted', updatedAt: clock() }),
      asset: a => a.last_error_code ? a : { ...a, processing_status: 'failed', last_error_code: error.code, last_error_message: error.message },
    });
    if (marked === 'ok') found.push(row.id);
  };
  for (const row of await store.rows<PreparationRecord>('preparations')) {
    if (row.phase !== 'running') continue;
    await tryLock(prepareLock(row.id), async () => {
      const r = await tryLock(lockNames.prepareAttempt(row.id, row.attemptId), () => mark(row, false));
      if (!r.ran) await mark(row, true);
    });
  }
  return found;
}
/** Resume unfinished preparations (automatic retries stop at the retry budget: RETRY_LIMIT_EXCEEDED). */
export async function resumePreparations(store: ProjectStore, options: PrepareOptions = {}): Promise<void> {
  const userCancelled = new Set((await store.rows<PreparationRecord>('preparations')).filter(r => r.phase === 'cancelled' && r.cancelledBy === 'user').map(r => r.id));
  for (const a of await store.rows<Asset>('assets')) {
    if (userCancelled.has(a.id)) continue; // a user's Cancel stays cancelled until Retry (the claim re-checks it: review R12)
    const retryable = a.processing_status === 'processing' || (a.processing_status === 'failed' && a.last_error_code !== 'RETRY_LIMIT_EXCEEDED' && a.last_error_code !== 'UPLOAD_INTERRUPTED' && (a.preparationAttempts ?? 0) < RETRY_BUDGET);
    if (retryable && a.processing_steps?.upload === 'complete') await prepareAsset(store, a.id, options);
  }
}
