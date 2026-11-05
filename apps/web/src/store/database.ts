// SPDX-License-Identifier: AGPL-3.0-only
import { emptyDocument, migrateDocument, storageError, StoreError, validateDocument } from './model';
import type { Asset, AssetLink, Folder, LibrarySnapshot, ProjectDocument, ProjectRecord } from './model';
import { OpfsMediaStore } from './media';
import type { MediaStore } from './media';
import { mediaError } from '../media/codes';
import { mediaKind, mimeFor } from '../media/files';
import { lockNames, tryLock, withLock } from '../media/locks';
import { Sha256 } from '../media/sha256';

// Version 2 (T14) adds the media caches and records; the upgrade only creates missing stores.
// Version 3 (T19) adds the per-asset analysis records (keyed by asset id) and the project `title_source`.
const stores = ['projects', 'documents', 'assets', 'folders', 'links', 'cleanup', 'thumbnails', 'waveforms', 'preparations', 'references', 'dirs', 'settings', 'transcripts', 'analyses', 'rhythms', 'search_index'] as const;
/** Per-asset caches removed with the asset. */
const assetCaches = ['thumbnails', 'waveforms', 'preparations', 'transcripts', 'analyses', 'rhythms', 'search_index'] as const;
export const DEFAULT_TITLE = 'Untitled Project';
export type StoreName = typeof stores[number];
export const { upload: uploadLock, prepare: prepareLock, reference: referenceLock } = lockNames;
export type UploadOptions = { name?: string; source?: Asset['source']; onProgress?: (bytes: number) => void };
type Cleanup = { id: string; kind: 'asset' | 'project'; targetId: string };
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
export class ProjectStore {
  private connection?: Promise<IDBDatabase>;
  constructor(public name = 'cutframe', private clock = () => Date.now(), public media: MediaStore = new OpfsMediaStore()) {}
  private stamp() { return new Date(this.clock()).toISOString(); }
  private open(): Promise<IDBDatabase> {
    return this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(this.name, 3);
      r.onupgradeneeded = event => {
        // Database migration hook: future versions extend this switch, never silently reset data.
        for (const name of stores) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath: name === 'documents' ? 'projectId' : 'id' });
        // v3 (Q5): a project still titled "Untitled Project" keeps the default; any other title was chosen by the user.
        if (event.oldVersion >= 1 && event.oldVersion < 3) {
          const projects = r.transaction!.objectStore('projects');
          projects.openCursor().onsuccess = e => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result; if (!cursor) return;
            const record = cursor.value as ProjectRecord;
            if (!record.title_source) cursor.update({ ...record, title_source: record.title === DEFAULT_TITLE ? 'default' : 'user' });
            cursor.continue();
          };
        }
      };
      r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); this.connection = undefined; }; resolve(r.result); };
      r.onerror = () => { this.connection = undefined; reject(storageError(r.error)); };
      r.onblocked = () => { this.connection = undefined; reject(new Error('Close older Cutframe tabs to upgrade browser storage.')); };
    }).catch(e => { this.connection = undefined; throw storageError(e); });
  }
  async close() { if (this.connection) (await this.connection).close(); this.connection = undefined; }
  private async transaction<T>(names: StoreName[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    try {
      const tx = (await this.open()).transaction(names, mode);
      const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted.')); tx.onerror = () => {}; });
      try { const result = await run(tx); await done; return result; }
      catch (e) { try { tx.abort(); } catch { /* already completed or aborted */ } await done.catch(() => {}); throw e; }
    } catch (e) { throw storageError(e); }
  }
  async create(title = DEFAULT_TITLE, document = emptyDocument()): Promise<ProjectRecord> {
    const doc = validateDocument(document), now = this.stamp(), named = title.trim() || DEFAULT_TITLE;
    const record: ProjectRecord = { id: crypto.randomUUID(), title: named, project_type: 'editing', processing_status: 'ready', template_id: null, style_id: null, is_demo: false, created_at: now, updated_at: now, last_accessed_at: now, title_source: named === DEFAULT_TITLE ? 'default' : 'user' };
    await this.transaction(['projects', 'documents'], 'readwrite', async tx => {
      await request(tx.objectStore('projects').add(record));
      await request(tx.objectStore('documents').add({ projectId: record.id, document: doc }));
    });
    return record;
  }
  async list(): Promise<ProjectRecord[]> {
    return this.transaction(['projects'], 'readonly', async tx => (await request<ProjectRecord[]>(tx.objectStore('projects').getAll()))
      .filter(p => !p.is_demo).sort((a, b) => b.last_accessed_at.localeCompare(a.last_accessed_at)).slice(0, 500));
  }
  async read(id: string): Promise<{ record: ProjectRecord; document: ProjectDocument } | null> {
    return this.transaction(['projects', 'documents'], 'readonly', async tx => {
      const record = await request<ProjectRecord | undefined>(tx.objectStore('projects').get(id));
      if (!record) return null;
      const stored = await request<{ document: unknown } | undefined>(tx.objectStore('documents').get(id));
      if (!stored) throw new StoreError('INVALID_PROJECT', 'The saved document is missing.');
      return { record, document: migrateDocument(stored.document) };
    });
  }
  async openProject(id: string) {
    const result = await this.read(id);
    if (result) await this.transaction(['projects'], 'readwrite', async tx => {
      const record = await request<ProjectRecord | undefined>(tx.objectStore('projects').get(id));
      if (record) await request(tx.objectStore('projects').put({ ...record, last_accessed_at: this.stamp() }));
    });
    return result;
  }
  async renameProject(id: string, title: string): Promise<void> {
    if (!title.trim()) return;
    await this.transaction(['projects'], 'readwrite', async tx => {
      const record = await request<ProjectRecord | undefined>(tx.objectStore('projects').get(id));
      if (record && record.title !== title.trim()) await request(tx.objectStore('projects').put({ ...record, title: title.trim(), title_source: 'user', updated_at: this.stamp() }));
    });
  }
  /** T19 auto title: replaces the title only while it is still the default (never after a rename). True when written. */
  async setGeneratedTitle(id: string, title: string): Promise<boolean> {
    const next = title.trim();
    if (!next) return false;
    return this.transaction(['projects'], 'readwrite', async tx => {
      const record = await request<ProjectRecord | undefined>(tx.objectStore('projects').get(id));
      if (!record || record.title !== DEFAULT_TITLE || (record.title_source ?? 'default') !== 'default') return false;
      await request(tx.objectStore('projects').put({ ...record, title: next, title_source: 'generated', updated_at: this.stamp() }));
      return true;
    });
  }
  async save(id: string, document: ProjectDocument, expectedRev: number): Promise<ProjectDocument> {
    const candidate = validateDocument(document);
    return this.transaction(['projects', 'documents'], 'readwrite', async tx => {
      const table = tx.objectStore('documents'), stored = await request<{ document: ProjectDocument } | undefined>(table.get(id));
      const record = await request<ProjectRecord | undefined>(tx.objectStore('projects').get(id));
      if (!record || !stored) throw new StoreError('PROJECT_NOT_FOUND', 'This project no longer exists.');
      if (stored.document.rev !== expectedRev) throw new StoreError('CONFLICT', 'Another tab changed this project.');
      const saved = { ...candidate, rev: expectedRev + 1 };
      await request(table.put({ projectId: id, document: saved }));
      await request(tx.objectStore('projects').put({ ...record, updated_at: this.stamp() }));
      return saved;
    });
  }
  async deleteProject(id: string): Promise<void> {
    await this.transaction(['projects', 'documents', 'links', 'cleanup'], 'readwrite', async tx => {
      await request(tx.objectStore('projects').delete(id));
      await request(tx.objectStore('documents').delete(id));
      for (const link of await request<AssetLink[]>(tx.objectStore('links').getAll())) if (link.projectId === id) await request(tx.objectStore('links').delete(link.id));
      await request(tx.objectStore('cleanup').put({ id: `project:${id}`, kind: 'project', targetId: id }));
    });
    await this.retryCleanup();
  }
  async retryCleanup(): Promise<number> {
    const queue = await this.transaction(['cleanup'], 'readonly', tx => request<Cleanup[]>(tx.objectStore('cleanup').getAll()));
    for (const job of queue) {
      try { await this.media.remove(job.kind, job.targetId); await this.transaction(['cleanup'], 'readwrite', tx => request(tx.objectStore('cleanup').delete(job.id))); }
      catch { /* Persisted queue retries on next app open or deletion. The record is already deleted. */ }
    }
    return this.transaction(['cleanup'], 'readonly', tx => request(tx.objectStore('cleanup').count()));
  }
  async library(): Promise<LibrarySnapshot> {
    return this.transaction(['assets', 'folders', 'links'], 'readonly', async tx => ({
      assets: await request<Asset[]>(tx.objectStore('assets').getAll()), folders: await request<Folder[]>(tx.objectStore('folders').getAll()), links: await request<AssetLink[]>(tx.objectStore('links').getAll()),
    }));
  }
  /**
   * T14 order (interrupted-upload recovery): the record is written first as "uploading", the bytes second, under a
   * cross-tab lock. A record still "uploading" with no live lock is an interrupted upload (recoverInterrupted).
   */
  async upload(file: File, folderId: string | null = null, options: UploadOptions = {}): Promise<Asset> {
    const type = mediaKind(file.name, file.type);
    if (!type) throw new StoreError('UNSUPPORTED_INPUT', 'Choose a video, image or audio file.');
    const asset: Asset = { id: crypto.randomUUID(), name: options.name ?? file.name, type, sizeBytes: file.size, mimeType: mimeFor(file.name, file.type), folderId, created_at: this.stamp(), recorded_at: null, location: null, durationMs: null,
      originalName: file.name, processing_status: 'uploading', processing_steps: { upload: 'processing' }, last_error_code: null, last_error_message: null, sha256: null, source: options.source ?? { kind: 'upload' } };
    return withLock(uploadLock(asset.id), async () => {
      await this.transaction(['assets', 'folders'], 'readwrite', async tx => {
        if (folderId && !await request(tx.objectStore('folders').get(folderId))) throw new StoreError('FOLDER_NOT_FOUND', 'This folder no longer exists.');
        await request(tx.objectStore('assets').add(asset));
      });
      try {
        await this.media.write(asset.id, file);
        // A shorter stored object than the picked file is the local "cut off" case (EMPTY_OBJECT, §13).
        if ((await this.media.read(asset.id)).size !== file.size) throw mediaError('EMPTY_OBJECT');
        const hash = new Sha256(), step = 8 << 20;
        for (let at = 0; at < file.size; at += step) { hash.update(new Uint8Array(await file.slice(at, at + step).arrayBuffer())); options.onProgress?.(Math.min(file.size, at + step)); }
        const sha256 = hash.digest();
        // Finish the existing record only: a deletion during the write wins (no resurrection), a rename or move survives.
        const stored = await this.updateAsset(asset.id, current => ({ ...current, processing_status: 'processing', processing_steps: { ...current.processing_steps, upload: 'complete' }, sha256 }));
        if (!stored) throw mediaError('UPLOAD_CANCELLED', 'The file was deleted while it was uploading.');
        return stored;
      } catch (e) {
        // Never put an in-flight upload in the deletion queue: another tab can drain that queue.
        try { await this.media.remove('asset', asset.id); }
        catch {
          await this.transaction(['cleanup'], 'readwrite', tx => request(tx.objectStore('cleanup').put({ id: `asset:${asset.id}`, kind: 'asset', targetId: asset.id }))).catch(() => {});
        }
        await this.transaction(['assets'], 'readwrite', tx => request(tx.objectStore('assets').delete(asset.id))).catch(() => {});
        throw storageError(e);
      }
    });
  }
  /**
   * T14 recovery on load. Listings only nominate candidates; each decision is re-checked under that item's lock, so a
   * live upload, preparation or reference publication in another tab is never touched (review F1, F5):
   * - an "uploading" record whose upload lock is free never received its bytes → UPLOAD_INTERRUPTED, partial bytes removed;
   * - stored originals with no record → removed; proxies of assets that are gone → removed;
   * - reference bytes or pending reference records whose publication never finished → removed.
   */
  async recoverInterrupted(): Promise<{ interrupted: string[]; orphans: string[]; proxies: string[] }> {
    const interrupted: string[] = [], orphans: string[] = [], proxies: string[] = [];
    for (const a of await this.rows<Asset>('assets')) {
      if (a.processing_status !== 'uploading') continue;
      const error = mediaError('UPLOAD_INTERRUPTED');
      const r = await tryLock(uploadLock(a.id), async () => {
        const marked = await this.updateAsset(a.id, x => x.processing_status === 'uploading' ? { ...x, processing_status: 'failed', processing_steps: { ...x.processing_steps, upload: 'failed' }, last_error_code: error.code, last_error_message: error.message } : x);
        if (marked?.processing_status !== 'failed' || marked.last_error_code !== error.code) return false;
        await this.media.remove('asset', a.id).catch(() => {}); return true;
      });
      if (r.ran && r.value) interrupted.push(a.id);
    }
    for (const id of await this.media.list?.() ?? []) {
      const r = await tryLock(uploadLock(id), async () => { if (await this.row('assets', id)) return false; await this.media.remove('asset', id).catch(() => {}); return true; });
      if (r.ran && r.value) orphans.push(id);
    }
    const references = await this.rows<{ id: string; pending?: boolean }>('references');
    for (const ref of references.filter(r => r.pending)) {
      await tryLock(referenceLock(ref.id), async () => {
        const current = await this.row<{ pending?: boolean }>('references', ref.id);
        if (current?.pending) { await this.media.removeProxy?.(`ref-${ref.id}`).catch(() => {}); await this.deleteRow('references', ref.id); proxies.push(`ref-${ref.id}`); }
      });
    }
    if (this.media.listProxies && this.media.removeProxy) for (const name of await this.media.listProxies()) {
      const isReference = name.startsWith('ref-'), [id, attemptId] = isReference ? [name.slice(4)] : name.split('~');
      const r = await tryLock(isReference ? referenceLock(id) : attemptId ? lockNames.prepareAttempt(id, attemptId) : prepareLock(id), async () => {
        const owner = isReference ? await this.row<{ pending?: boolean }>('references', id) : await this.row<Asset>('assets', id);
        if (owner && !(owner as { pending?: boolean }).pending && (!attemptId || (owner as Asset).proxy?.objectKey === name)) return false;
        await this.media.removeProxy!(name).catch(() => {}); return true;
      });
      if (r.ran && r.value && !proxies.includes(name)) proxies.push(name);
    }
    return { interrupted, orphans, proxies };
  }  /** Generic row access for the T14 stores (thumbnails, waveforms, preparations, references, dirs, settings). */
  async row<T>(store: StoreName, key: string): Promise<T | undefined> { return this.transaction([store], 'readonly', tx => request<T | undefined>(tx.objectStore(store).get(key))); }
  async rows<T>(store: StoreName): Promise<T[]> { return this.transaction([store], 'readonly', tx => request<T[]>(tx.objectStore(store).getAll())); }
  async putRow<T>(store: StoreName, value: T): Promise<void> { await this.transaction([store], 'readwrite', tx => request(tx.objectStore(store).put(value))); }
  async deleteRow(store: StoreName, key: string): Promise<void> { await this.transaction([store], 'readwrite', tx => request(tx.objectStore(store).delete(key))); }
  /** Read-modify-write of one asset in one transaction; resolves to the stored row (undefined when it is gone). */
  async updateAsset(id: string, change: (asset: Asset) => Asset): Promise<Asset | undefined> {
    return this.transaction(['assets'], 'readwrite', async tx => {
      const current = await request<Asset | undefined>(tx.objectStore('assets').get(id));
      if (!current) return undefined;
      const next = change(current); if (next !== current) await request(tx.objectStore('assets').put(next));
      return next;
    });
  }
  /**
   * T14 (review F3): one transaction that writes only while `attemptId` still owns the asset's running preparation record
   * (and, if given, the original is still `sourceRevision`). Every preparation mutation goes through here.
   */
  async ownerWrite(id: string, attemptId: string, write: { asset?: (a: Asset) => Asset; preparation?: (row: Record<string, unknown>) => Record<string, unknown>; predicate?: (row: Record<string, unknown>) => boolean; puts?: { store: StoreName; value: unknown }[]; sourceRevision?: string | null }): Promise<'ok' | 'lost' | 'finished' | 'gone' | 'changed' | 'skipped'> {
    const names = [...new Set<StoreName>(['assets', 'preparations', ...(write.puts ?? []).map(p => p.store)])];
    return this.transaction(names, 'readwrite', async tx => {
      const row = await request<Record<string, unknown> | undefined>(tx.objectStore('preparations').get(id));
      if (!row || row.attemptId !== attemptId) return 'lost';
      if (row.phase !== 'running') return 'finished';
      if (write.predicate && !write.predicate(row)) return 'skipped';
      const asset = await request<Asset | undefined>(tx.objectStore('assets').get(id));
      if (!asset) return 'gone';
      if (write.sourceRevision !== undefined && (asset.sha256 ?? null) !== write.sourceRevision) return 'changed';
      for (const p of write.puts ?? []) await request(tx.objectStore(p.store).put(p.value));
      if (write.asset) await request(tx.objectStore('assets').put(write.asset(asset)));
      if (write.preparation) await request(tx.objectStore('preparations').put(write.preparation(row)));
      return 'ok';
    });
  }
  /** Compare-and-set on one row: `change` sees the current row (or undefined) and returns the new row, or null to leave it. */
  async swapRow<T extends { id: string }>(store: StoreName, key: string, change: (row: T | undefined) => T | null): Promise<T | null> {
    return this.transaction([store], 'readwrite', async tx => {
      const next = change(await request<T | undefined>(tx.objectStore(store).get(key)));
      if (next) await request(tx.objectStore(store).put(next));
      return next;
    });
  }
  async createFolder(name: string, parentId: string | null = null): Promise<Folder> {
    if (!name.trim()) throw new StoreError('INVALID_NAME', 'Enter a folder name.');
    const folder = { id: crypto.randomUUID(), name: name.trim(), parentId };
    await this.transaction(['folders'], 'readwrite', async tx => {
      if (parentId && !await request(tx.objectStore('folders').get(parentId))) throw new StoreError('FOLDER_NOT_FOUND', 'This folder no longer exists.');
      await request(tx.objectStore('folders').add(folder));
    });
    return folder;
  }
  async rename(kind: 'asset' | 'folder', id: string, name: string): Promise<void> {
    if (!name.trim()) return;
    const table = kind === 'asset' ? 'assets' : 'folders';
    await this.transaction([table], 'readwrite', async tx => {
      const row = await request<Asset | Folder | undefined>(tx.objectStore(table).get(id));
      if (row) await request(tx.objectStore(table).put({ ...row, name: name.trim() }));
    });
  }
  async moveAssets(ids: string[], folderId: string | null): Promise<void> {
    await this.transaction(['assets', 'folders'], 'readwrite', async tx => {
      if (folderId && !await request(tx.objectStore('folders').get(folderId))) throw new StoreError('FOLDER_NOT_FOUND', 'This folder no longer exists.');
      for (const id of ids) {
        const asset = await request<Asset | undefined>(tx.objectStore('assets').get(id));
        if (asset) await request(tx.objectStore('assets').put({ ...asset, folderId }));
      }
    });
  }
  private async removeAssets(tx: IDBTransaction, ids: string[]) {
    const removed = new Set(ids), links = await request<AssetLink[]>(tx.objectStore('links').getAll());
    for (const id of ids) {
      await request(tx.objectStore('assets').delete(id));
      for (const cache of assetCaches) await request(tx.objectStore(cache).delete(id));
      await request(tx.objectStore('cleanup').put({ id: `asset:${id}`, kind: 'asset', targetId: id }));
    }
    // Keep tombstones so type counters do not recycle a previously issued agent_id.
    for (const link of links) if (removed.has(link.assetId)) await request(tx.objectStore('links').put({ ...link, deleted_at: this.stamp() }));
    for (const row of await request<{ projectId: string; document: ProjectDocument }[]>(tx.objectStore('documents').getAll())) {
      const items = row.document.items.filter(i => !removed.has(i.metadata?.assetId));
      const deletedIds = new Set(row.document.items.filter(i => removed.has(i.metadata?.assetId)).map(i => i.id));
      if (deletedIds.size) {
        const document = { ...row.document, items, transitions: row.document.transitions.filter(t => !deletedIds.has(t.fromId) && !deletedIds.has(t.toId)), rev: row.document.rev + 1 };
        await request(tx.objectStore('documents').put({ ...row, document }));
        const record = await request<ProjectRecord | undefined>(tx.objectStore('projects').get(row.projectId));
        if (record) await request(tx.objectStore('projects').put({ ...record, updated_at: this.stamp() }));
      }
    }
  }
  async deleteAssets(ids: string[]): Promise<void> {
    await this.transaction(['assets', 'links', 'documents', 'projects', 'cleanup', ...assetCaches], 'readwrite', tx => this.removeAssets(tx, ids));
    await this.retryCleanup();
  }
  async deleteFolder(id: string, everything: boolean): Promise<void> {
    await this.transaction(['folders', 'assets', 'links', 'documents', 'projects', 'cleanup', ...assetCaches], 'readwrite', async tx => {
      const folders = await request<Folder[]>(tx.objectStore('folders').getAll()), folder = folders.find(f => f.id === id);
      if (!folder) return;
      const assets = await request<Asset[]>(tx.objectStore('assets').getAll());
      if (everything) {
        const tree = new Set([id]);
        for (let before = -1; before !== tree.size;) { before = tree.size; for (const f of folders) if (f.parentId && tree.has(f.parentId)) tree.add(f.id); }
        await this.removeAssets(tx, assets.filter(a => a.folderId && tree.has(a.folderId)).map(a => a.id));
        for (const key of tree) await request(tx.objectStore('folders').delete(key));
      } else {
        for (const a of assets) if (a.folderId === id) await request(tx.objectStore('assets').put({ ...a, folderId: folder.parentId }));
        for (const f of folders) if (f.parentId === id) await request(tx.objectStore('folders').put({ ...f, parentId: folder.parentId }));
        await request(tx.objectStore('folders').delete(id));
      }
    });
    await this.retryCleanup();
  }
  /** Called with the project id after each attach in this tab (T19 C9: an empty project's auto title waits for its first
   *  asset without a timer). */
  readonly attached = new Set<(projectId: string) => void>();
  async attach(projectId: string, assetId: string): Promise<AssetLink> {
    const link = await this.transaction(['links', 'assets', 'projects'], 'readwrite', async tx => {
      const asset = await request<Asset | undefined>(tx.objectStore('assets').get(assetId));
      if (!asset || !await request(tx.objectStore('projects').get(projectId))) throw new StoreError('NOT_FOUND', 'The project or asset no longer exists.');
      const table = tx.objectStore('links'), id = `${projectId}:${assetId}`;
      const existing = await request<AssetLink | undefined>(table.get(id));
      if (existing) { const restored = { ...existing, deleted_at: null }; await request(table.put(restored)); return restored; }
      const links = await request<AssetLink[]>(table.getAll());
      const n = Math.max(0, ...links.filter(l => l.projectId === projectId && l.content_type === asset.type).map(l => Number(l.agent_id.split('_').at(-1)))) + 1;
      const link: AssetLink = { id, projectId, assetId, agent_id: `${asset.type}_${n}`, content_type: asset.type, added_at: this.stamp(), deleted_at: null };
      await request(table.add(link)); return link;
    });
    for (const wake of [...this.attached]) wake(projectId);
    return link;
  }
  async detach(projectId: string, assetId: string): Promise<void> {
    await this.transaction(['links'], 'readwrite', async tx => {
      const table = tx.objectStore('links'), id = `${projectId}:${assetId}`, link = await request<AssetLink | undefined>(table.get(id));
      if (link) await request(table.put({ ...link, deleted_at: this.stamp() }));
    });
  }
  async projectAssets(projectId: string): Promise<AssetLink[]> {
    return (await this.library()).links.filter(l => l.projectId === projectId && l.deleted_at === null).sort((a, b) => a.added_at.localeCompare(b.added_at));
  }
  async usage(ids: string[]): Promise<number> {
    const set = new Set(ids);
    return new Set((await this.library()).links.filter(l => set.has(l.assetId) && l.deleted_at === null).map(l => l.projectId)).size;
  }
}
export const projectStore = new ProjectStore();
