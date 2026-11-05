// SPDX-License-Identifier: AGPL-3.0-only
import { storageError } from './model';
import { mediaError } from '../media/codes';
export interface MediaStore {
  write(assetId: string, file: Blob): Promise<void>;
  read(assetId: string): Promise<Blob>;
  remove(kind: 'asset' | 'project', id: string): Promise<void>;
  /** T14: ids of stored originals, for orphan-byte cleanup. */
  list?(): Promise<string[]>;
  /** T14: proxy objects (`<assetId>~<attemptId>`); the asset row publishes the winning objectKey. */
  writeProxy?(assetId: string, file: Blob): Promise<void>;
  readProxy?(assetId: string): Promise<Blob>;
  /** Names under proxies/ (legacy asset ids, attempt objects, references as ref-<id>), and removal of one object. */
  listProxies?(): Promise<string[]>;
  removeProxy?(name: string): Promise<void>;
}
const missing = (e: unknown) => (e as DOMException)?.name === 'NotFoundError';
export class OpfsMediaStore implements MediaStore {
  private async directory(name: string) {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('cutframe', { create: true });
    return app.getDirectoryHandle(name, { create: true });
  }
  private async put(dir: string, name: string, file: Blob) {
    try {
      const handle = await (await this.directory(dir)).getFileHandle(name, { create: true });
      const writer = await handle.createWritable();
      try { await writer.write(file); await writer.close(); } catch (e) { await writer.abort().catch(() => {}); throw e; }
    } catch (e) { throw storageError(e); }
  }
  private async get(dir: string, name: string) {
    try { return await (await (await this.directory(dir)).getFileHandle(name)).getFile(); }
    catch (e) { throw missing(e) ? mediaError('WORKSPACE_FILE_MISSING', 'A stored media file is missing from this browser’s storage.') : storageError(e); }
  }
  write(assetId: string, file: Blob) { return this.put('media', assetId, file); }
  read(assetId: string): Promise<Blob> { return this.get('media', assetId); }
  writeProxy(assetId: string, file: Blob) { return this.put('proxies', assetId, file); }
  readProxy(assetId: string): Promise<Blob> { return this.get('proxies', assetId); }
  private async names(dir: string): Promise<string[]> {
    const names: string[] = [];
    for await (const name of (await this.directory(dir) as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names;
  }
  list(): Promise<string[]> { return this.names('media'); }
  listProxies(): Promise<string[]> { return this.names('proxies'); }
  async removeProxy(name: string): Promise<void> {
    try { await (await this.directory('proxies')).removeEntry(name); }
    catch (e) { if (!missing(e)) throw storageError(e); }
  }
  async remove(kind: 'asset' | 'project', id: string): Promise<void> {
    for (const dir of kind === 'asset' ? ['media', 'proxies'] : ['projects']) {
      try { await (await this.directory(dir)).removeEntry(id, { recursive: true }); }
      catch (e) { if (!missing(e)) throw storageError(e); }
    }
    if (kind === 'asset') for (const name of await this.listProxies()) if (name.startsWith(`${id}~`)) await this.removeProxy(name);
  }
}
