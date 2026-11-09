// SPDX-License-Identifier: AGPL-3.0-only
// T21 First Edit demo pack (FX-3) and demo project. The pack ships beside the app in vendor/demo-pack (licences in the T00
// manifest), is fetched on first use, checked against pack.json's SHA-256 and kept in OPFS, so a second run works offline.
// The demo project is `is_demo`: it stays out of the home list, and it and its assets are deleted on leaving (our improvement).
import { uploadToProject } from '../../media/ingest';
import { sha256Blob } from '../../media/sha256';
import type { ProjectStore } from '../../store/database';
import type { Asset } from '../../store/model';
import { holdDemo, queued, removeDemos } from './demos';
import type { DemoAsset, RhythmData, SongSegment } from './plan';

export type PackFile = { file: string; type: 'video' | 'audio'; sha256: string; bytes: number; durationMs: number; licence: string; author: string; pageUrl: string; rhythm_data?: RhythmData; segments?: SongSegment[] };
export type Pack = { version: 1; title: string; files: PackFile[] };
export type Demo = { projectId: string; assets: DemoAsset[] };
export type DemoReason = 'pack' | 'project' | 'setup' | 'timeout';
export const SETUP_TIMEOUT_MS = 120_000;
export class DemoFailure extends Error { constructor(readonly reason: DemoReason, cause?: unknown) { super(reason, { cause }); } }

/** Null serves the files built from vendor/demo-pack. A later host replaces this one value (coordinator ruling, FX-3 option A). */
export const DEMO_PACK_ROOT: string | null = null;
const PACK_INDEX = 'pack.json', bundled = import.meta.glob('../../../../../vendor/demo-pack/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const packUrl = (file: string) => DEMO_PACK_ROOT ? `${DEMO_PACK_ROOT}${file}` : bundled[`../../../../../vendor/demo-pack/${file}`];
const MIME: Record<string, string> = { webm: 'video/webm', mp3: 'audio/mpeg' };
const mimeOf = (file: string) => MIME[file.split('.').pop()!] ?? 'application/octet-stream';
async function cacheDir() {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle('cutframe', { create: true })).getDirectoryHandle('demo-pack', { create: true });
}
const readCached = (dir: FileSystemDirectoryHandle, file: string) => dir.getFileHandle(file).then(h => h.getFile()).catch(() => undefined);
async function writeCached(dir: FileSystemDirectoryHandle, file: string, blob: Blob) {
  const writable = await (await dir.getFileHandle(file, { create: true })).createWritable();
  await writable.write(blob); await writable.close();
}
async function fetched(file: string, signal?: AbortSignal) {
  const url = packUrl(file);
  if (!url) throw new Error(`${file} is not in the pack`);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.blob();
}
/** A complete cached pack needs no network at all, its index included. */
export async function loadPack(signal?: AbortSignal): Promise<{ pack: Pack; files: File[] }> {
  try {
    const dir = await cacheDir(), index = await readCached(dir, PACK_INDEX), pack = JSON.parse(await (index ?? await fetched(PACK_INDEX, signal)).text()) as Pack, files: File[] = [];
    for (const entry of pack.files) {
      let blob: Blob | undefined = await readCached(dir, entry.file);
      if (blob?.size !== entry.bytes) {
        blob = await fetched(entry.file, signal);
        if (await sha256Blob(blob) !== entry.sha256) throw new Error(`${entry.file} does not match its checksum`);
        await writeCached(dir, entry.file, blob);
      }
      files.push(new File([blob], entry.file, { type: mimeOf(entry.file) }));
    }
    if (!index) await writeCached(dir, PACK_INDEX, new Blob([JSON.stringify(pack)], { type: 'application/json' }));
    return { pack, files };
  } catch (e) { throw new DemoFailure('pack', e); }
}
/** Reject at the deadline, but retain serialization until the actual build settles, including non-cancellable persistence. */
export function setupDemo(store: ProjectStore) {
  return new Promise<Demo>((resolve, reject) => {
    void queued(async () => {
      const stop = new AbortController();
      const timer = setTimeout(() => { reject(new DemoFailure('timeout')); stop.abort(); }, SETUP_TIMEOUT_MS);
      try { resolve(await buildDemo(store, stop.signal)); }
      catch (e) { reject(e); }
      finally { clearTimeout(timer); }
    }).catch(reject);
  });
}
/** A new demo project each time (PT-FE-01). Each failure keeps its own reason (E1, E3, E4); E2 needs accounts, which we don't have. */
async function buildDemo(store: ProjectStore, signal: AbortSignal): Promise<Demo> {
  const preparing: Promise<unknown>[] = [];
  try {
    await holdDemo();
    await removeDemos(store);
    signal.throwIfAborted();
    const { pack, files } = await loadPack(signal);
    signal.throwIfAborted();
    const record = await store.create(pack.title).catch(e => { throw new DemoFailure('project', e); });
    await store.putRow('projects', { ...record, is_demo: true });
    signal.throwIfAborted();
    const placed: { entry: PackFile; asset: Asset }[] = [];
    for (const [n, file] of files.entries()) {
      signal.throwIfAborted();
      // No proxies: they were 89% of the setup, the preview plays the originals without them, and they would go with the demo.
      const entry = pack.files[n], result = await uploadToProject(store, record.id, [file], { source: { kind: 'demo', licence: entry.licence, author: entry.author, pageUrl: entry.pageUrl }, prepare: { steps: { proxy: undefined } } });
      preparing.push(...result.preparing);
      if (result.assets[0]) placed.push({ entry, asset: result.assets[0] });
    }
    await Promise.all(preparing);
    const assets = await Promise.all(placed.map(async ({ entry, asset }) => {
      const stored = await store.row<Asset>('assets', asset.id) ?? asset;
      return { id: stored.id, type: entry.type, name: stored.name, durationMs: stored.durationMs ?? entry.durationMs, rhythm_data: entry.rhythm_data, segments: entry.segments };
    }));
    return { projectId: record.id, assets };
  } catch (e) { throw e instanceof DemoFailure ? e : new DemoFailure('setup', e); }
  finally { await Promise.allSettled(preparing); }
}
/** Own requirements (§28b.1.2 keeps the rule, not the user-agent test): a desktop browser with the features the editor uses. */
export function browserProblem(w: Window & typeof globalThis = window) {
  const n = w.navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } }, platform = n.userAgentData?.platform ?? '';
  const desktop = /windows|macos|chrome os|chromeos|linux/i.test(platform) && !/android/i.test(platform);
  const mobile = !!n.userAgentData?.mobile || (!desktop && (w.matchMedia('(pointer: coarse) and (hover: none)').matches || w.innerWidth <= 500));
  return mobile || !('VideoDecoder' in w) || !('VideoEncoder' in w) || !('OffscreenCanvas' in w) || !n.storage?.getDirectory;
}
