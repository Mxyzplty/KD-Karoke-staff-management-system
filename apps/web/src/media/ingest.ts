// SPDX-License-Identifier: AGPL-3.0-only
// Upload rules (findings part 2 §25, §26): Library uploads check names (rename dialog), project uploads reuse a library
// asset with the same original name + exact size silently; uploads for a project are queued and cancelled when the
// project disappears. Also: relink a missing original by size then SHA-256.
import type { ProjectStore } from '../store/database';
import type { Asset, ProjectRecord } from '../store/model';
import { StoreError } from '../store/model';
import { mediaError, MediaError } from './codes';
import { checkUploadable, renamedName } from './files';
import { prepareAsset, resumePreparations, scanInterrupted } from './prepare';
import type { PrepareOptions } from './prepare';
import { sha256Blob } from './sha256';
import { lockNames, withLock } from './locks';

export type Duplicate = { file: File; original: string; renamed: string };
export type Failure = { file: File; error: Error };
export type IngestResult = { assets: Asset[]; uploaded: string[]; reused: string[]; skipped: File[]; failed: Failure[]; preparing: Promise<unknown>[] };
export type IngestOptions = { folderId?: string | null; prepare?: PrepareOptions | false; signal?: AbortSignal; source?: Asset['source'] };
const empty = (): IngestResult => ({ assets: [], uploaded: [], reused: [], skipped: [], failed: [], preparing: [] });
const startPreparation = (store: ProjectStore, result: IngestResult, assetId: string, options: IngestOptions) => {
  if (options.prepare !== false) result.preparing.push(prepareAsset(store, assetId, options.prepare ?? {}).catch(() => 'failed'));
};
/** Library-page duplicates: files whose name already exists (earlier files of the batch count too). */
export function findDuplicates(files: File[], assets: Asset[]): Duplicate[] {
  const taken = new Set(assets.map(a => a.name)), out: Duplicate[] = [];
  for (const file of files) {
    if (taken.has(file.name)) { const renamed = renamedName(file.name, taken); out.push({ file, original: file.name, renamed }); taken.add(renamed); }
    else taken.add(file.name);
  }
  return out;
}
/** Library page: `choice` is the "Duplicate file found" dialog (Skip Duplicates / Upload & Rename); not asked when there are none. */
export async function uploadToLibrary(store: ProjectStore, files: File[], choice: (duplicates: Duplicate[]) => Promise<'skip' | 'rename' | 'cancel'>, options: IngestOptions = {}): Promise<IngestResult> {
  const result = empty(), duplicates = findDuplicates(files, (await store.library()).assets);
  const decision = duplicates.length ? await choice(duplicates) : 'rename';
  if (decision === 'cancel') { result.skipped.push(...files); return result; }
  const renamed = new Map(duplicates.map(d => [d.file, d.renamed]));
  for (const file of files) {
    if (renamed.has(file) && decision === 'skip') { result.skipped.push(file); continue; }
    if (options.signal?.aborted) { result.failed.push({ file, error: mediaError('UPLOAD_CANCELLED') }); continue; }
    try {
      await checkUploadable(file);
      const asset = await underIdentity(file, () => store.upload(file, options.folderId ?? null, { name: renamed.get(file), source: options.source }));
      result.assets.push(asset); result.uploaded.push(asset.id); startPreparation(store, result, asset.id, options);
    } catch (e) { result.failed.push({ file, error: uploadError(e) }); }
  }
  return result;
}
/** Reuse decisions are serialized per original name + exact size (review F6): lookup and insert happen under one lock. */
const underIdentity = <T>(file: File, run: () => Promise<T>) => withLock(lockNames.identity(`asset:${file.name}:${file.size}`), run);
/**
 * Reuse an existing match (§25). Its original must be there: a missing one is restored from the picked file with the
 * relink rules (size, then SHA-256), otherwise WORKSPACE_ORIGINAL_MISMATCH (review F9). Unfinished matches are prepared again.
 */
async function reuse(store: ProjectStore, existing: Asset, file: File, result: IngestResult, options: IngestOptions) {
  const present = await store.media.read(existing.id).then(b => b.size === existing.sizeBytes).catch(() => false);
  if (!present) await relinkOriginal(store, existing.id, file);
  result.reused.push(existing.id);
  const current = (await store.row<Asset>('assets', existing.id)) ?? existing;
  if (!present || current.processing_status !== 'ready') startPreparation(store, result, existing.id, { ...options, prepare: options.prepare === false ? false : { ...options.prepare, manual: true } });
  return current;
}
/** A library asset with the same original file name and exact size (§25 reuse rule); any state except a lost upload. */
export function findReusable(file: File, assets: Asset[]): Asset | undefined {
  return assets.find(a => (a.originalName ?? a.name) === file.name && a.sizeBytes === file.size && a.last_error_code !== 'UPLOAD_INTERRUPTED');
}
/** Library picker drop strip (wizard): reuse by name + size, else upload; no dialog, nothing linked yet. */
export async function uploadReusing(store: ProjectStore, files: File[], options: IngestOptions = {}): Promise<IngestResult> {
  const result = empty();
  for (const file of files) {
    try {
      await checkUploadable(file);
      result.assets.push(await underIdentity(file, async () => {
        const existing = findReusable(file, (await store.library()).assets);
        if (existing) return reuse(store, existing, file, result, options);
        const asset = await store.upload(file, options.folderId ?? null, { source: options.source });
        result.uploaded.push(asset.id); startPreparation(store, result, asset.id, options);
        return asset;
      }));
    } catch (e) { result.failed.push({ file, error: uploadError(e) }); }
  }
  return result;
}
/**
 * Inside a project (wizard, project footage): reuse silently, else upload; link every file to the project in order.
 * A deleted project fails the current file with PROJECT_NOT_FOUND and cancels the rest (UPLOAD_CANCELLED).
 */
export async function uploadToProject(store: ProjectStore, projectId: string, files: File[], options: IngestOptions = {}): Promise<IngestResult> {
  const result = empty();
  let cancelled: MediaError | undefined;
  for (const file of files) {
    if (options.signal?.aborted) cancelled ??= mediaError('UPLOAD_CANCELLED');
    if (cancelled) { result.failed.push({ file, error: cancelled }); continue; }
    try {
      await checkUploadable(file);
      if (!await store.row<ProjectRecord>('projects', projectId)) throw mediaError('PROJECT_NOT_FOUND');
      const asset = await underIdentity(file, async () => {
        const existing = findReusable(file, (await store.library()).assets);
        // A failed or unfinished match is retried (§25: "failed ones are retried"); a missing original is recovered.
        if (existing) return reuse(store, existing, file, result, options);
        const uploaded = await store.upload(file, options.folderId ?? null, { source: options.source });
        result.uploaded.push(uploaded.id); startPreparation(store, result, uploaded.id, options);
        return uploaded;
      });
      await store.attach(projectId, asset.id).catch(e => { throw (e as StoreError).code === 'NOT_FOUND' ? mediaError('PROJECT_NOT_FOUND') : e; });
      result.assets.push(asset);
    } catch (e) {
      const error = uploadError(e);
      result.failed.push({ file, error });
      if ((error as StoreError).code === 'PROJECT_NOT_FOUND') cancelled = mediaError('UPLOAD_CANCELLED', 'The project for this upload was deleted');
    }
  }
  return result;
}
/** Wizard Create: the project is "uploading" while its footage uploads, then "ready"; library picks are linked as they are. */
export async function createProjectWithFootage(store: ProjectStore, files: File[], libraryIds: string[], options: IngestOptions = {}): Promise<{ project: ProjectRecord; result: IngestResult }> {
  const project = await store.create();
  const setStatus = (status: ProjectRecord['processing_status']) => store.swapRow<ProjectRecord>('projects', project.id, p => p ? { ...p, processing_status: status } : null);
  if (files.length) await setStatus('uploading');
  for (const id of libraryIds) await store.attach(project.id, id);
  const result = await uploadToProject(store, project.id, files, options);
  if (files.length) await setStatus('ready');
  return { project: { ...project, processing_status: 'ready' }, result };
}
function uploadError(e: unknown): Error {
  if (e instanceof StoreError) return e;
  const name = (e as DOMException)?.name;
  if (name === 'NotReadableError' || name === 'NotFoundError') return mediaError('SOURCE_FILE_UNREADABLE');
  return mediaError('UPLOAD_FAILED', undefined, { reason: (e as Error)?.message });
}
/** Missing originals (OPFS entry gone) get OBJECT_MISSING; returns their ids. Uploads still in flight are skipped. */
export async function scanMissing(store: ProjectStore): Promise<string[]> {
  if (!store.media.list) return [];
  const present = new Set(await store.media.list()), missing: string[] = [];
  for (const a of await store.rows<Asset>('assets')) {
    if (a.processing_status === 'uploading' || a.last_error_code === 'UPLOAD_INTERRUPTED' || present.has(a.id)) continue;
    missing.push(a.id);
    const error = mediaError('OBJECT_MISSING');
    await store.updateAsset(a.id, x => x.last_error_code === error.code ? x : { ...x, last_error_code: error.code, last_error_message: error.message });
  }
  return missing;
}
/** On app open: interrupted uploads and preparations, missing originals, then resume unfinished preparations. */
export async function recoverOnLoad(store: ProjectStore, options: PrepareOptions = {}): Promise<void> {
  await store.recoverInterrupted();
  await scanInterrupted(store);
  await scanMissing(store);
  await resumePreparations(store, options);
}
/** Relink: size first, then SHA-256 against the value recorded at ingest. Equal → original restored; else WORKSPACE_ORIGINAL_MISMATCH. */
export async function relinkOriginal(store: ProjectStore, assetId: string, file: File): Promise<Asset> {
  const asset = await store.row<Asset>('assets', assetId);
  if (!asset) throw new StoreError('NOT_FOUND', 'This asset no longer exists.');
  if (file.size !== asset.sizeBytes) throw mediaError('WORKSPACE_ORIGINAL_MISMATCH');
  if (!asset.sha256 || await sha256Blob(file) !== asset.sha256) throw mediaError('WORKSPACE_ORIGINAL_MISMATCH');
  await store.media.write(assetId, file);
  const restored = await store.updateAsset(assetId, a => ({ ...a, last_error_code: a.last_error_code === 'OBJECT_MISSING' ? null : a.last_error_code, last_error_message: a.last_error_code === 'OBJECT_MISSING' ? null : a.last_error_message }));
  return restored!;
}
