// SPDX-License-Identifier: AGPL-3.0-only
// T21 local settings: the profile row, byte units, the parity switch, the Local usage figures and Delete local data.
// Everything here describes or clears this browser; nothing limits an action (§39, contract #1).
import { agentLink } from '../agent/link';
import { projectStore } from '../store/database';
import type { ProjectStore } from '../store/database';
import { PARITY_KEY, readMode } from '../versions/checkpoints';
import { readUsage } from './meter';
import type { Usage } from './meter';

export type Profile = { name: string };
const PROFILE = 'profile';
export async function readProfile(store: Pick<ProjectStore, 'row'>): Promise<Profile> { return { name: (await store.row<Profile>('settings', PROFILE))?.name ?? '' }; }
export const saveProfile = (store: Pick<ProjectStore, 'putRow'>, profile: Profile) => store.putRow('settings', { id: PROFILE, ...profile });
/** §39 adaptive units: MB under 1 GB. */
export const formatBytes = (bytes: number) => bytes < 2 ** 30 ? `${(bytes / 2 ** 20).toFixed(1)} MB` : `${(bytes / 2 ** 30).toFixed(1)} GB`;
export const readParity = async (store: Pick<ProjectStore, 'row'>) => await readMode(store) === 'parity';
export const saveParity = (store: Pick<ProjectStore, 'putRow'>, enabled: boolean) => store.putRow('settings', { id: PARITY_KEY, enabled });

export type LocalUsage = { used: number; quota: number; persisted: boolean; projects: number; assets: number; assetBytes: number; meter: Usage };
export async function localUsage(store: Pick<ProjectStore, 'list' | 'library'>): Promise<LocalUsage> {
  const [estimate, persisted, projects, library] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted(), store.list(), store.library()]);
  return { used: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted, projects: projects.length, assets: library.assets.length, assetBytes: library.assets.reduce((sum, a) => sum + a.sizeBytes, 0), meter: readUsage() };
}
/** `blocked` also fires while a closing connection finishes its last transaction: only a wait that runs out means another tab. */
const BLOCKED_MS = 3000;
const deleted = (name: string) => new Promise<void>((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name);
  let timer: ReturnType<typeof setTimeout>;
  request.onsuccess = () => { clearTimeout(timer); resolve(); };
  request.onerror = () => { clearTimeout(timer); reject(request.error); };
  request.onblocked = () => { timer = setTimeout(() => reject(new Error('Another Cutframe tab is still open. Close it, then delete again.')), BLOCKED_MS); };
});
const missing = (e: unknown) => (e as DOMException)?.name === 'NotFoundError';
/** Danger Zone: every project, asset, key, pairing token and preference in this browser. The caller reloads afterwards. */
export async function deleteLocalData() {
  agentLink.disconnect();
  await projectStore.close();
  const names = (await indexedDB.databases()).flatMap(d => d.name?.startsWith('cutframe') ? [d.name] : []);
  const databases = await Promise.allSettled(names.map(deleted));
  const root = await navigator.storage.getDirectory();
  await root.removeEntry('cutframe', { recursive: true }).catch(e => { if (!missing(e)) throw e; });
  for (const key of Object.keys(localStorage)) if (key.startsWith('cutframe')) localStorage.removeItem(key);
  sessionStorage.clear();
  if ('caches' in globalThis) await Promise.all((await caches.keys()).map(name => caches.delete(name)));
  // A database held by a tab that will not let go stays queued and goes when that tab closes; the rest is gone by now.
  const held = databases.find(d => d.status === 'rejected');
  if (held) throw held.reason;
}
