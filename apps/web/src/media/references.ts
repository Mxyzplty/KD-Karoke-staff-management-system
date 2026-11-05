// SPDX-License-Identifier: AGPL-3.0-only
// Reference videos (findings part 2 §36): hashed before upload, reused by hash (soft-deleted ones too), duration read on
// upload, attach/detach per project, delete removes them from every project. No quota ("N saved"). Analysis is T19:
// with no provider the status is an explicit "no provider" state, never "ready".
import type { ProjectStore } from '../store/database';
import { storageError, StoreError } from '../store/model';
import { lockNames, withLock } from './locks';
import { checkUploadable } from './files';
import { probeMedia } from './probe';
import { sha256Blob } from './sha256';

export type AnalysisStatus = 'no-provider' | 'pending' | 'processing' | 'complete' | 'failed';
export type ReferenceVideo = { pending?: boolean; id: string; name: string; sizeBytes: number; mimeType: string; sha256: string; durationMs: number | null; created_at: string; deleted_at: string | null; projects: string[]; analysis: { status: AnalysisStatus; error?: string } };
/** The T19 seam: analysis runs only when a provider is configured. */
export type ReferenceAnalyser = (reference: ReferenceVideo, blob: Blob) => Promise<void>;
const NO_PROVIDER = { status: 'no-provider' as const };
const file = (id: string) => `ref-${id}`;
export async function listReferences(store: ProjectStore): Promise<ReferenceVideo[]> {
  return (await store.rows<ReferenceVideo>('references')).filter(r => !r.deleted_at && !r.pending).sort((a, b) => b.created_at.localeCompare(a.created_at));
}
/**
 * Upload: SHA-256 first; an existing (or soft-deleted) reference with the same hash is reused instead of stored again.
 * Same-hash uploads are serialized (review F6). Publication is recoverable (review F5): a pending record comes first, the
 * bytes second, under the reference's lock; a failure removes both, and recovery removes leftovers of a closed tab.
 */
export async function uploadReference(store: ProjectStore, picked: File, clock = Date.now): Promise<{ reference: ReferenceVideo; reused: boolean }> {
  if (await checkUploadable(picked) !== 'video') throw new StoreError('UNSUPPORTED_FORMAT', 'Reference videos must be video files.', 'user_error');
  const sha256 = await sha256Blob(picked);
  return withLock(lockNames.identity(`reference:${sha256}`), async () => {
    const existing = (await store.rows<ReferenceVideo>('references')).find(r => r.sha256 === sha256 && !r.pending);
    if (existing) {
      const restored = await store.swapRow<ReferenceVideo>('references', existing.id, r => r ? { ...r, deleted_at: null } : null);
      return { reference: restored!, reused: true };
    }
    if (!store.media.writeProxy) throw new StoreError('UPLOAD_FAILED', 'This media store cannot keep reference videos.', 'system_error');
    const id = crypto.randomUUID();
    const durationMs = await probeMedia(picked, picked.name, 'video').then(i => i.durationMs).catch(() => null);
    const reference: ReferenceVideo = { id, name: picked.name, sizeBytes: picked.size, mimeType: picked.type, sha256, durationMs, created_at: new Date(clock()).toISOString(), deleted_at: null, projects: [], analysis: NO_PROVIDER };
    return withLock(lockNames.reference(id), async () => {
      try {
        await store.putRow('references', { ...reference, pending: true });
        await store.media.writeProxy!(file(id), picked);
        await store.putRow('references', reference);
        return { reference, reused: false };
      } catch (e) {
        await store.media.removeProxy?.(file(id)).catch(() => {});
        await store.deleteRow('references', id).catch(() => {});
        throw storageError(e);
      }
    });
  });
}export async function readReference(store: ProjectStore, id: string): Promise<Blob> { return store.media.readProxy!(file(id)); }
async function change(store: ProjectStore, id: string, fn: (r: ReferenceVideo) => ReferenceVideo, failure: string) {
  const next = await store.swapRow<ReferenceVideo>('references', id, r => r && !r.deleted_at && !r.pending ? fn(r) : null).catch(() => null);
  if (!next) throw new StoreError('REFERENCE_UNAVAILABLE', failure);
  return next;
}
export const attachReference = (store: ProjectStore, projectId: string, id: string) => change(store, id, r => ({ ...r, projects: [...new Set([...r.projects, projectId])] }), 'Attach failed');
export const detachReference = (store: ProjectStore, projectId: string, id: string) => change(store, id, r => ({ ...r, projects: r.projects.filter(p => p !== projectId) }), 'Detach failed');
/** Soft delete: it disappears from the list and from every project it was attached to; its bytes stay for hash reuse. */
export const deleteReference = (store: ProjectStore, id: string, clock = Date.now) => change(store, id, r => ({ ...r, deleted_at: new Date(clock()).toISOString(), projects: [] }), 'Delete failed');
export async function projectReferences(store: ProjectStore, projectId: string) { return (await listReferences(store)).filter(r => r.projects.includes(projectId)); }
/** Retry analysis: with no provider the state stays "no-provider"; with a T19 analyser it runs and records the outcome. */
export async function retryReference(store: ProjectStore, id: string, analyser?: ReferenceAnalyser): Promise<ReferenceVideo> {
  if (!analyser) return change(store, id, r => ({ ...r, analysis: NO_PROVIDER }), 'Retry failed');
  const current = await change(store, id, r => ({ ...r, analysis: { status: 'processing' } }), 'Retry failed');
  try { await analyser(current, await readReference(store, id)); return change(store, id, r => ({ ...r, analysis: { status: 'complete' } }), 'Retry failed'); }
  catch (e) { return change(store, id, r => ({ ...r, analysis: { status: 'failed', error: (e as Error).message } }), 'Retry failed'); }
}
