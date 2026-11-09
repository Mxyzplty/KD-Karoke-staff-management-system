// SPDX-License-Identifier: AGPL-3.0-only
// T21 Storage (§39 "optional backup target, off by default"). The target is a local folder the user picks, which can be a
// folder their own sync client watches: Cutframe runs no cloud and adds no charge. With backup on, a project's assets are
// copied there when the project opens or gains one, as `<asset id>-<name>`; a file already there at the same size is left.
import type { ProjectStore } from '../store/database';
import type { Asset } from '../store/model';

export type Backup = { enabled: boolean; folder?: string; handle?: FileSystemDirectoryHandle };
export type BackupState = 'local' | 'copying' | 'backed-up' | 'failed' | 'no-permission';
type Permission = { queryPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>; requestPermission?(d: { mode: 'readwrite' }): Promise<PermissionState> };
type Store = Pick<ProjectStore, 'row' | 'putRow'>;
const ROW = 'backup';

export const canBackup = () => typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
export async function readBackup(store: Pick<Store, 'row'>): Promise<Backup> {
  const row = await store.row<Backup>('settings', ROW);
  return { enabled: !!row?.enabled, folder: row?.folder, handle: row?.handle };
}
const save = (store: Pick<Store, 'putRow'>, backup: Backup) => store.putRow('settings', { id: ROW, ...backup });
/** Turning on asks for the folder; a cancelled picker leaves backup off. */
export async function chooseBackupFolder(store: Store): Promise<Backup> {
  const handle = await (globalThis as unknown as { showDirectoryPicker(o: { mode: 'readwrite' }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' });
  const backup = { enabled: true, folder: handle.name, handle };
  await save(store, backup);
  return backup;
}
export async function setBackup(store: Store, enabled: boolean): Promise<Backup> {
  const backup = { ...await readBackup(store), enabled };
  await save(store, backup);
  return backup;
}
/** The Auto switch (Settings and the editor's storage chip). */
export const turnBackup = (store: Store, on: boolean, backup?: Backup) => on && !backup?.handle ? chooseBackupFolder(store) : setBackup(store, on);
export const backupGranted = async (handle: FileSystemDirectoryHandle) => { const p = handle as unknown as Permission; return !p.queryPermission || await p.queryPermission({ mode: 'readwrite' }) === 'granted'; };
/** After a browser restart the permission must be asked for again, from a click. */
export const reconnectBackup = async (handle: FileSystemDirectoryHandle) => { const p = handle as unknown as Permission; return !p.requestPermission || await p.requestPermission({ mode: 'readwrite' }) === 'granted'; };
const fileName = (asset: Asset) => `${asset.id}-${asset.name.replace(/[\\/:*?"<>|]/g, '_')}`;
async function sizeOf(dir: FileSystemDirectoryHandle, name: string) {
  try { return (await (await dir.getFileHandle(name)).getFile()).size; } catch { return undefined; }
}
/** Copies what is missing. Off, or no asset: an empty answer, and nothing touches the folder. */
export async function backupAssets(store: Pick<ProjectStore, 'row' | 'media'>, assets: Asset[], report: (asset: Asset, state: BackupState) => void) {
  const { enabled, handle } = await readBackup(store);
  if (!enabled || !handle) return;
  if (!await backupGranted(handle)) { for (const asset of assets) report(asset, 'no-permission'); return; }
  for (const asset of assets) {
    if (asset.processing_status === 'uploading') continue;
    const name = fileName(asset);
    if (await sizeOf(handle, name) === asset.sizeBytes) { report(asset, 'backed-up'); continue; }
    report(asset, 'copying');
    try {
      const writable = await (await handle.getFileHandle(name, { create: true })).createWritable();
      await writable.write(await store.media.read(asset.id));
      await writable.close();
      report(asset, 'backed-up');
    } catch { report(asset, 'failed'); }
  }
}
