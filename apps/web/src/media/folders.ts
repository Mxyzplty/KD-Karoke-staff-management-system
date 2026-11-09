// SPDX-License-Identifier: AGPL-3.0-only
// Allowed folders (master plan §1a, tool contracts listAllowedDir / importFromAllowedDir): per-device, read-only directory
// handles in IndexedDB; one-level listings (500 entries by default, `truncated`); `<folder-name>/<sub/path>` paths.
// These are the library functions T18's agent tools will call; the lower-snake values are error codes §11's.
import type { ProjectStore } from '../store/database';
import { mediaKind, parseAllowedPath } from './files';
import { uploadToProject } from './ingest';
import type { IngestOptions } from './ingest';

export type DirRecord = { id: string; name: string; handle: FileSystemDirectoryHandle; added_at: string };
export type Kind = 'video' | 'image' | 'audio' | 'other';
export type Entry = { name: string; path: string; kind: 'directory' | 'file'; type?: Kind; sizeBytes?: number };
export type DirError = { error: string; message: string };
type ReadPermission = { queryPermission?(d: { mode: 'read' }): Promise<PermissionState>; requestPermission?(d: { mode: 'read' }): Promise<PermissionState> };
export const canPickFolders = () => typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
export async function folders(store: ProjectStore): Promise<DirRecord[]> { return (await store.rows<DirRecord>('dirs')).sort((a, b) => a.name.localeCompare(b.name)); }
/** Store a read-only directory handle under its folder name (a folder of the same name is replaced). */
export async function addFolder(store: ProjectStore, handle: FileSystemDirectoryHandle): Promise<DirRecord> {
  const record = { id: handle.name, name: handle.name, handle, added_at: new Date().toISOString() };
  await store.putRow('dirs', record); return record;
}
export async function connectFolder(store: ProjectStore): Promise<DirRecord> {
  const handle = await (globalThis as unknown as { showDirectoryPicker(o: { mode: 'read' }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'read' });
  return addFolder(store, handle);
}
export const removeFolder = (store: ProjectStore, name: string) => store.deleteRow('dirs', name);
/** The per-folder state Settings shows. A browser without the permission API has no other state. */
export const folderPermission = async (h: FileSystemDirectoryHandle): Promise<PermissionState> => { const p = h as unknown as ReadPermission; return p.queryPermission ? p.queryPermission({ mode: 'read' }) : 'granted'; };
export const reconnectFolder = async (h: FileSystemDirectoryHandle) => { await (h as unknown as ReadPermission).requestPermission?.({ mode: 'read' }); };
const granted = async (h: FileSystemDirectoryHandle) => await folderPermission(h) === 'granted';
const kindOf = (name: string, type = ''): Kind => mediaKind(name, type) ?? 'other';
async function resolveDir(store: ProjectStore, path: string, forImport: boolean): Promise<{ dir: FileSystemDirectoryHandle; segments: string[]; folder: string } | DirError> {
  const parsed = parseAllowedPath(path);
  if ('error' in parsed) return parsed;
  const all = await folders(store);
  if (!all.length) return { error: 'allowed_dir_not_configured', message: 'No allowed directory is configured on this device. The user can connect one in Settings → External Agent.' };
  const record = all.find(f => f.name === parsed.folder);
  if (!record) return forImport ? { error: 'folder_not_found', message: `Path must start with one of the configured folder names (${all.map(f => f.name).join(', ')}).` }
    : { error: 'folder_not_found', message: `No allowed folder named "${parsed.folder}" on this device. Configured: ${all.map(f => f.name).join(', ')}.` };
  if (!await granted(record.handle)) return forImport ? { error: 'folder_permission_denied', message: `Permission to read "${record.name}" was revoked. User can reconnect in Settings.` }
    : { error: 'allowed_dir_permission_denied', message: `Permission to read "${record.name}" was revoked. The user can reconnect in Settings → External Agent.` };
  return { dir: record.handle, segments: parsed.segments, folder: record.name };
}
/**
 * One level of a connected folder. Empty path → the connected folders (`directories`). Directories are always listed so
 * callers can go deeper (stated assumption); files are filtered by kind (default video, image, audio).
 */
export async function listAllowedDir(store: ProjectStore, path = '', filter: Kind[] = ['video', 'image', 'audio'], limit = 500): Promise<{ success: true; path: string; directories?: string[]; entries: Entry[]; truncated: boolean } | ({ success: false } & DirError)> {
  if (!path.replace(/\/+$/, '')) {
    const all = await folders(store);
    if (!all.length) return { success: false, error: 'allowed_dir_not_configured', message: 'No allowed directory is configured on this device. The user can connect one in Settings → External Agent.' };
    return { success: true, path: '', directories: all.map(f => f.name), entries: [], truncated: false };
  }
  const resolved = await resolveDir(store, path, false);
  if ('error' in resolved) return { success: false, ...resolved };
  let dir = resolved.dir;
  for (const [i, segment] of resolved.segments.entries()) {
    const shown = [resolved.folder, ...resolved.segments.slice(0, i + 1)].join('/');
    try { dir = await dir.getDirectoryHandle(segment); }
    catch (e) {
      const name = (e as DOMException).name;
      if (name === 'TypeMismatchError') return { success: false, error: 'path_not_a_directory', message: `'${shown}' is a file, not a directory.` };
      if (name === 'NotFoundError') return { success: false, error: 'path_not_found', message: `Directory '${shown}' not found.` };
      return { success: false, error: 'allowed_dir_unavailable', message: `Could not read "${resolved.folder}": ${(e as Error).message}` };
    }
  }
  const base = [resolved.folder, ...resolved.segments].join('/'), entries: Entry[] = [];
  let truncated = false;
  try {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const entry: Entry = handle.kind === 'directory' ? { name, path: `${base}/${name}`, kind: 'directory' } : { name, path: `${base}/${name}`, kind: 'file', type: kindOf(name) };
      if (entry.kind === 'file' && !filter.includes(entry.type!)) continue;
      if (entries.length >= limit) { truncated = true; break; }
      if (entry.kind === 'file') entry.sizeBytes = (await (handle as FileSystemFileHandle).getFile()).size;
      entries.push(entry);
    }
  } catch (e) { return { success: false, error: 'allowed_dir_unavailable', message: `Could not read "${resolved.folder}": ${(e as Error).message}` }; }
  entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
  return { success: true, path: base, entries, truncated };
}
/** Import files as project footage (always `footage`); per-path failures sit in `failed[]` of a successful result (shape RP). */
export async function importFromAllowedDir(store: ProjectStore, projectId: string | null, paths: string[], options: IngestOptions = {}): Promise<{ success: true; imported: string[]; failed: { path: string; error: string; message: string }[] } | ({ success: false } & DirError)> {
  if (!paths?.length) return { success: false, error: 'no_paths', message: 'No paths provided.' };
  if (!projectId) return { success: false, error: 'no_project', message: 'No project is open. Open a project in the editor first.' };
  const failed: { path: string; error: string; message: string }[] = [], files: { path: string; file: File }[] = [];
  for (const path of paths) {
    const resolved = await resolveDir(store, path, true);
    if ('error' in resolved) { failed.push({ path, ...resolved }); continue; }
    if (!resolved.segments.length) { failed.push({ path, error: 'path_not_a_file', message: `'${path}' is a directory, not a file.` }); continue; }
    let dir = resolved.dir;
    try {
      for (const segment of resolved.segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
      const name = resolved.segments.at(-1)!;
      const handle = await dir.getFileHandle(name).catch(async e => {
        if ((e as DOMException).name === 'TypeMismatchError') throw Object.assign(new Error('dir'), { code: 'path_not_a_file' });
        throw e;
      });
      const file = await handle.getFile();
      if (kindOf(file.name, file.type) === 'other') { failed.push({ path, error: 'unsupported_type', message: `Cutframe only imports video, image, and audio files (got ${file.type || file.name.split('.').pop()}).` }); continue; }
      files.push({ path, file });
    } catch (e) {
      const err = e as DOMException & { code?: string };
      if (err.code === 'path_not_a_file') failed.push({ path, error: 'path_not_a_file', message: `'${path}' is a directory, not a file.` });
      else if (err.name === 'NotFoundError' || err.name === 'TypeMismatchError') failed.push({ path, error: 'file_not_found', message: `File '${path}' not found.` });
      else failed.push({ path, error: 'file_read_failed', message: 'Failed to read file from allowed directory.' });
    }
  }
  if (!files.length) return { success: true, imported: [], failed };
  const result = await uploadToProject(store, projectId, files.map(f => f.file), { ...options, source: { kind: 'allowed-dir' } });
  for (const f of result.failed) failed.push({ path: files.find(x => x.file === f.file)!.path, error: 'upload_rejected', message: `Upload rejected: ${f.error.message}` });
  return { success: true, imported: result.assets.map(a => a.id), failed };
}
