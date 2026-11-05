// SPDX-License-Identifier: AGPL-3.0-only
// T19 C8: the local equivalents of Xapp's footage endpoints (findings part 2 §25, §27). `searchFootage` = POST /api/search
// `{query, projectId?, mode: "general", options: {threshold: "medium", assetType?, limit}}` → `{results, metadata}` over
// the analysis service's index; `clipRange` = /api/video-range: one result's time range cut from the source as its own
// file (the clip tile's "Download clip").
import { AnalysisError } from './types';
import type { SearchRequest, SearchResponse, SearchRow } from './types';
import type { AnalysisService } from './service';
import type { ProjectStore } from '../store/database';
import type { Asset } from '../store/model';
import type { MediaInfo } from '../media/probe';

/** The library search box asks for 30 results (part 2 §25); also the default here. */
export const SEARCH_LIMIT = 30;
export type SearchOptions = { projectId?: string; threshold?: SearchRequest['options']['threshold']; assetType?: SearchRequest['options']['assetType']; limit?: number };
export const searchRequest = (query: string, options: SearchOptions = {}): SearchRequest => ({
  query, ...(options.projectId ? { projectId: options.projectId } : {}), mode: 'general',
  options: { threshold: options.threshold ?? 'medium', limit: options.limit ?? SEARCH_LIMIT, ...(options.assetType ? { assetType: options.assetType } : {}) },
});
type Deps = { store: ProjectStore; service: Pick<AnalysisService, 'search'> };
const defaults = async (): Promise<Deps> => {
  const [{ projectStore }, { analysisService }] = await Promise.all([import('../store/database'), import('./service')]);
  return { store: projectStore, service: analysisService };
};
/** One search. Aborting `signal` cancels it (the search box cancels the previous request when a new one starts). */
export async function searchFootage(query: string, options: SearchOptions = {}, signal?: AbortSignal, deps?: Deps): Promise<SearchResponse> {
  const { store, service } = deps ?? await defaults();
  return service.search(store, searchRequest(query, options), signal);
}

/** A range result (Show clips) has both times; a whole-asset hit has neither. */
export const isRange = (row: SearchRow): row is SearchRow & { startTime: number; endTime: number } => typeof row.startTime === 'number' && typeof row.endTime === 'number';
const stamp = (s: number) => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
/** `<name>_<start>-<end>.<ext>`, e.g. `beach_0m00s-0m06s.mp4`. */
export const clipName = (filename: string, start: number, end: number, extension: string) => `${filename.replace(/\.[^.]+$/, '')}_${stamp(start)}-${stamp(end)}.${extension}`;
type Cut = (blob: Blob, info: MediaInfo, range: [number, number], signal?: AbortSignal) => Promise<{ blob: Blob; extension: 'mp4' | 'webm' }>;
const cutInWorker: Cut = async (blob, info, range, signal) => (await import('../media/worker-client')).runWorker({ op: 'clip', blob, info, range }, signal);
/** The asset's [start, end) s (clamped to its length) as a file of its own, cut in the media worker. */
export async function clipRange(store: Pick<ProjectStore, 'media'>, asset: Asset, start: number, end: number, signal?: AbortSignal, cut: Cut = cutInWorker) {
  const length = (asset.durationMs ?? Infinity) / 1000, from = Math.max(0, start), to = Math.min(length, end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new AnalysisError('INVALID_ANALYSIS_INPUT', 'The clip range must be finite and increasing inside the asset.');
  const out = await cut(await store.media.read(asset.id), asset.media as MediaInfo, [from, to], signal);
  return { blob: out.blob, filename: clipName(asset.name, from, to, out.extension) };
}
