// SPDX-License-Identifier: AGPL-3.0-only
// T19: the main thread's one analysis worker. Models load from the same-origin model root; a capability without its
// models is "unavailable" (C12), never faked. Cancelling a request terminates the worker and the next request starts a
// fresh one (a cancelled search only drops its answer). The footage index lives in the worker and is kept per asset in `search_index`; before each search it is
// brought in line with the stored rows, the current asset names and the project links (Footage search filters on them).
import { AnalysisWorker } from './worker-client';
import { AnalysisError } from './types';
import { unavailableError } from './availability';
import type { Availability, Capability } from './availability';
import type { AnalysisRequest } from './protocol';
import type { IndexEntry } from './search';
import type { SyncResult } from './sync';
import type { AssetInput, BeatAnalysis, Pcm, SearchRequest, SearchResponse, Transcript, VisualAnalysis } from './types';
import type { MediaInfo } from '../media/probe';
import type { ProjectStore } from '../store/database';
import type { Asset, AssetLink } from '../store/model';

/** Same-origin model root (dev: served from $CUTFRAME_FIXTURES by the Vite plugin). */
export const MODEL_ROOT = '/models/';
export type IndexRow = { id: string; embedder: string; entry: IndexEntry };
export type AnalysisRow = { id: string; analysis: VisualAnalysis; created_at: string };
/** `failed` is a voice-over whose transcription failed (Xapp part 2 §25: the asset is ready, transcription failed). */
export type TranscriptRow = { id: string; status: 'complete' | 'skipped' | 'failed'; transcript: Transcript | null; reason?: string; error?: string; created_at: string };
/** `analysis: null` = audio the classifier treats as speech or sound (BEATS_NOT_MUSIC), kept so it is not re-run. */
export type RhythmRow = { id: string; analysis: BeatAnalysis | null; reason?: 'BEATS_NOT_MUSIC'; created_at: string };
type Current = { worker: AnalysisWorker; ready: Promise<unknown>; indexed: Map<string, string> };

export const assetInput = (asset: Asset, projectIds?: string[]): AssetInput => ({ id: asset.id, filename: asset.name, type: asset.type, duration: (asset.durationMs ?? 0) / 1000, ...(projectIds ? { projectIds } : {}) });
export class AnalysisService {
  private current?: Current;
  private availability?: Promise<Availability>;
  constructor(private modelRoot = MODEL_ROOT, private spawn = () => new AnalysisWorker()) {}
  private open(): Current {
    if (!this.current) {
      const worker = this.spawn(), ready = worker.init({ modelRoot: this.modelRoot });
      ready.catch(() => {}); // awaited by each inference request
      this.current = { worker, ready, indexed: new Map() };
    }
    return this.current;
  }
  private drop(current: Current, error: AnalysisError) { if (this.current === current) this.current = undefined; current.worker.close(error); }
  /** Which capabilities have their local models; probed once per page (a failed probe is retried on the next call). */
  available(): Promise<Availability> {
    return this.availability ??= this.request<Availability>({ task: 'available', modelRoot: this.modelRoot }).catch(e => { this.availability = undefined; throw e; });
  }
  /** C12: ANALYSIS_UNAVAILABLE when the capability's local models are not served. */
  async require(capability: Capability) { if (!(await this.available())[capability]) throw unavailableError(capability); }
  /** One worker request. Aborting `signal` terminates the worker (ANALYSIS_CANCELLED for every pending request). */
  async request<T>(request: AnalysisRequest, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const current = this.open(), cancel = () => this.drop(current, new AnalysisError('ANALYSIS_CANCELLED', 'Analysis was cancelled.'));
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (request.task !== 'available') await current.ready;
      return (await current.worker.run(request, transfer)).value as T;
    } catch (e) {
      if ((e as AnalysisError).code === 'ANALYSIS_WORKER_FAILED') this.drop(current, e as AnalysisError);
      throw signal?.aborted ? signal.reason : e;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  /** The footage search's text embedder on any texts (T21 help search); ANALYSIS_UNAVAILABLE without its model. */
  async embed(texts: string[]): Promise<number[][]> { await this.require('embeddings'); return this.request<number[][]>({ task: 'embed', texts }); }
  /** Multicam offset (sync.ts): `source` source time − `target` source time; SYNC_LOW_CONFIDENCE below 0.5 (C10). */
  syncOffset(source: Transcript, target: Transcript): Promise<SyncResult> { return this.request<SyncResult>({ task: 'sync', source, target }); }
  /** Index one asset in the worker and return the row that persists it. */
  async index(asset: AssetInput, analysis: VisualAnalysis | null, transcript: Transcript | null, signal?: AbortSignal): Promise<IndexRow> {
    const current = this.open();
    await this.request({ task: 'index', asset, analysis, transcript }, [], signal);
    const { entry, embedder } = await this.request<{ entry: IndexEntry | null; embedder: string }>({ task: 'entry', assetId: asset.id }, [], signal);
    if (!entry) throw new AnalysisError('ANALYSIS_CANCELLED', 'Analysis was cancelled.'); // the worker was replaced in between
    current.indexed.set(asset.id, indexKey(asset.filename, asset.projectIds ?? []));
    return { id: asset.id, embedder, entry };
  }
  private searching: Promise<unknown> = Promise.resolve();
  /** One footage search; searches run one after another. Aborting `signal` (the search box cancels the previous query)
   *  rejects at once but leaves the worker running: terminating it would cancel preparation work in the same worker.
   *  ANALYSIS_CANCELLED without that abort means another request terminated the worker: the run is re-run once (R1). */
  async search(store: ProjectStore, request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    signal?.throwIfAborted();
    const once = async () => {
      await this.require('embeddings');
      await this.sync(store);
      return this.request<SearchResponse>({ task: 'search', request });
    };
    const run = this.searching.catch(() => {}).then(() => once().catch(e => {
      if ((e as AnalysisError).code !== 'ANALYSIS_CANCELLED' || signal?.aborted) throw e;
      return once();
    }));
    this.searching = run;
    if (!signal) return run;
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
    return Promise.race([run, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
  }
  /** `tries`: a worker replaced during the pass (another request was cancelled) is brought in line again, at most 3 passes (R5). */
  private async sync(store: ProjectStore, signal?: AbortSignal, tries = 3): Promise<void> {
    const current = this.open();
    const [rows, assets, links] = await Promise.all([store.rows<IndexRow>('search_index'), store.rows<Asset>('assets'), store.rows<AssetLink>('links')]);
    const byId = new Map(assets.map(a => [a.id, a])), projects = new Map<string, string[]>();
    for (const l of links) if (!l.deleted_at) projects.set(l.assetId, [...(projects.get(l.assetId) ?? []), l.projectId]);
    const live = rows.filter(r => byId.has(r.id)), stored = new Set(live.map(r => r.id));
    for (const id of [...current.indexed.keys()]) if (!stored.has(id)) { await this.request({ task: 'remove', assetId: id }, [], signal); current.indexed.delete(id); }
    for (const row of live) {
      if (this.current !== current) break; // replaced: the next pass brings the new worker in line
      const asset = byId.get(row.id)!, projectIds = (projects.get(row.id) ?? []).sort(), key = indexKey(asset.name, projectIds);
      if (current.indexed.get(row.id) === key) continue;
      const entry: IndexEntry = { ...row.entry, asset: { ...row.entry.asset, filename: asset.name, projectIds } };
      // Kept on the worker that answered: once a request resolves, that is the current one (a replacement while it ran
      // rejects it).
      if (await this.request<boolean>({ task: 'restore', entry, embedder: row.embedder }, [], signal)) this.current?.indexed.set(row.id, key);
      else await this.reindex(store, asset, projectIds, signal); // made by another embedder: embed it again
    }
    if (this.current !== current && tries > 1) await this.sync(store, signal, tries - 1);
  }
  private async reindex(store: ProjectStore, asset: Asset, projectIds: string[], signal?: AbortSignal) {
    const [analysis, transcript] = await Promise.all([store.row<AnalysisRow>('analyses', asset.id), store.row<TranscriptRow>('transcripts', asset.id)]);
    await store.putRow('search_index', await this.index(assetInput(asset, projectIds), analysis?.analysis ?? null, transcript?.transcript ?? null, signal));
  }
  private rhythms = new Map<string, Promise<RhythmRow>>();
  /** C11: an audio asset's beats, computed on first read at the file's own rate (as T19a scored it) and kept in
   *  `rhythms`. Not-music is kept too (`analysis: null`); a failure is not, so the next read tries again. */
  rhythm(store: Pick<ProjectStore, 'row' | 'putRow' | 'media'>, asset: Asset, decode = decodeAudio): Promise<RhythmRow> {
    let pending = this.rhythms.get(asset.id);
    if (!pending) {
      pending = (async () => {
        const stored = await store.row<RhythmRow>('rhythms', asset.id);
        if (stored) return stored;
        await this.require('beats');
        const pcm = await decode(await store.media.read(asset.id), asset.media as MediaInfo);
        let row: RhythmRow;
        try { row = { id: asset.id, analysis: await this.request<BeatAnalysis>({ task: 'beats', pcm, asset: { filename: asset.name, type: asset.type } }, [pcm.data[0].buffer]), created_at: new Date().toISOString() }; }
        catch (e) { if ((e as AnalysisError).code !== 'BEATS_NOT_MUSIC') throw e; row = { id: asset.id, analysis: null, reason: 'BEATS_NOT_MUSIC', created_at: new Date().toISOString() }; }
        if (await store.row('assets', asset.id)) await store.putRow('rhythms', row); // not for an asset deleted meanwhile
        return row;
      })().finally(() => this.rhythms.delete(asset.id));
      this.rhythms.set(asset.id, pending);
    }
    return pending;
  }
}
/** Mono PCM at the source rate, decoded in the media worker. */
const decodeAudio = async (blob: Blob, info: MediaInfo): Promise<Pcm> => (await import('../media/worker-client')).runWorker<Pcm>({ op: 'audio', blob, info });
const indexKey = (filename: string, projectIds: string[]) => JSON.stringify([filename, projectIds]);
export const analysisService = new AnalysisService();
