// SPDX-License-Identifier: AGPL-3.0-only
// Controlled IO schedules, shared by fake-IDB unit tests and Chromium's real IDB/Web Locks/OPFS tests.
import { ProjectStore } from '../apps/web/src/store/database';
import { OpfsMediaStore } from '../apps/web/src/store/media';
import type { MediaStore } from '../apps/web/src/store/media';
import type { Asset } from '../apps/web/src/store/model';
import { prepareAsset, resumePreparations, scanInterrupted, bindPreparationLifecycle, STALE_MS } from '../apps/web/src/media/prepare';
import type { PreparationRecord, Steps, Timers } from '../apps/web/src/media/prepare';
import { mediaError } from '../apps/web/src/media/codes';

const info = () => ({ container: 'mp4', mimeType: 'video/mp4', durationMs: 1000, video: null, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: () => 0, clearInterval: () => {} } as unknown as Timers;
const waitFor = async (f: () => boolean | Promise<boolean>) => { for (let n = 0; n < 1000; n++) { if (await f()) return; await new Promise(r => setTimeout(r, 2)); } throw Error('schedule did not reach its boundary'); };
function memory(): MediaStore {
  const originals = new Map<string, Blob>(), proxies = new Map<string, Blob>();
  const read = async (m: Map<string, Blob>, id: string) => { const b = m.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; };
  return { write: async (id, b) => { originals.set(id, b); }, read: id => read(originals, id), list: async () => [...originals.keys()],
    writeProxy: async (id, b) => { proxies.set(id, b); }, readProxy: id => read(proxies, id), listProxies: async () => [...proxies.keys()], removeProxy: async id => { proxies.delete(id); },
    remove: async (_, id) => { originals.delete(id); for (const k of proxies.keys()) if (k === id || k.startsWith(`${id}~`)) proxies.delete(k); } };
}
async function setup(native: boolean) {
  const store = new ProjectStore(`t14-r2-${crypto.randomUUID()}`, Date.now, native ? new OpfsMediaStore() : memory());
  const asset = await store.upload(new File(['original'], 'race.mp4', { type: 'video/mp4' }));
  return { store, asset };
}
const pointer = (a: Asset) => (a.proxy as Asset['proxy'] & { objectKey?: string })?.objectKey ?? a.id;
const proxySteps = (text: string, width: number): Partial<Steps> => ({ probe: async () => info(), proxy: async () => ({ blob: new Blob([text]), width, height: 2, codec: 'avc', container: 'mp4' }) });

export async function staleProxy(native: boolean, deletion = false) {
  const { store, asset } = await setup(native); let now = 0;
  const gate = deferred(), entered = deferred(), write = store.media.writeProxy!.bind(store.media); let first = true;
  store.media.writeProxy = async (key, blob) => { if (first) { first = false; entered.resolve(); await gate.promise; } await write(key, blob); };
  const old = prepareAsset(store, asset.id, { timers, clock: () => now, steps: proxySteps('OLD', 4) });
  try {
    await entered.promise; now = STALE_MS + 1;
    const winner = await prepareAsset(store, asset.id, { timers, clock: () => now, steps: proxySteps('NEW', 8) });
    const a = (await store.row<Asset>('assets', asset.id))!, key = pointer(a), before = await (await store.media.readProxy!(key)).text();
    // Recovery must leave both a live unpublished writer and the published winner alone.
    await store.recoverInterrupted();
    if (deletion) await store.deleteAssets([asset.id]);
    gate.resolve(); const oldResult = await old;
    const final = deletion ? null : await (await store.media.readProxy!(key)).text();
    // Unpublished crash leftovers use the same storage shape and must be collected.
    const orphan = `${asset.id}~crashed`; await write(orphan, new Blob(['orphan'])); await store.recoverInterrupted();
    return { winner, oldResult, before, final, key, assetId: asset.id, width: a.proxy?.width, remaining: await store.media.listProxies!(), row: await store.row('assets', asset.id) };
  } finally { gate.resolve(); await old; await store.deleteAssets([asset.id]); await store.close(); }
}

export async function failedTakeover(native: boolean, automatic: boolean) {
  const { store, asset } = await setup(native); let now = 0, probes = 0;
  const entered = deferred(), release = deferred();
  const old = prepareAsset(store, asset.id, { timers, clock: () => now, steps: { probe: async () => { entered.resolve(); await release.promise; return info(); } } });
  try {
    await entered.promise; now = STALE_MS + 1;
    const replacement = await prepareAsset(store, asset.id, { timers, clock: () => now, steps: { probe: async () => { throw new Error('transient IO'); } } });
    const gate = deferred(), nextEntered = deferred();
    const options = { timers, clock: () => now, manual: !automatic, steps: { probe: async () => { probes++; nextEntered.resolve(); await gate.promise; return info(); } } };
    const retries = automatic ? [resumePreparations(store, options), resumePreparations(store, options)] : [prepareAsset(store, asset.id, options), prepareAsset(store, asset.id, options)];
    // On the broken tree neither retry reaches probe. Do not count a timeout as the red result.
    await Promise.race([nextEntered.promise, Promise.all(retries)]); gate.resolve(); await Promise.all(retries);
    return { replacement, probes, phase: (await store.row<PreparationRecord>('preparations', asset.id))?.phase, status: (await store.row<Asset>('assets', asset.id))?.processing_status };
  } finally { release.resolve(); await old; await store.deleteAssets([asset.id]); await store.close(); }
}

export async function freshHeartbeat(native: boolean, successor = false) {
  const { store, asset } = await setup(native); let now = 0;
  const entered = deferred(), release = deferred();
  const old = prepareAsset(store, asset.id, { timers, clock: () => now, steps: { probe: async () => { entered.resolve(); await release.promise; return info(); } } });
  try {
    await entered.promise; now = STALE_MS + 1;
    const rows = store.rows.bind(store); let intercepted = false;
    store.rows = async <T>(name: Parameters<ProjectStore['rows']>[0]) => {
      const snapshot = await rows<T>(name);
      if (name === 'preparations' && !intercepted) {
        intercepted = true;
        await store.swapRow<PreparationRecord>('preparations', asset.id, r => r ? { ...r, attemptId: successor ? 'successor' : r.attemptId, updatedAt: now } : null);
        if (successor) await store.updateAsset(asset.id, a => ({ ...a, processing_status: 'ready', last_error_code: null }));
      }
      return snapshot;
    };
    const found = await scanInterrupted(store, () => now);
    return { found, record: await store.row<PreparationRecord>('preparations', asset.id), asset: await store.row<Asset>('assets', asset.id) };
  } finally { release.resolve(); await old; await store.deleteAssets([asset.id]); await store.close(); }
}

export async function recoverySuccessor(native: boolean) {
  const { store, asset } = await setup(native);
  await store.putRow<PreparationRecord>('preparations', { id: asset.id, attemptId: 'gone', phase: 'running', startedAt: 0, updatedAt: 0, sourceRevision: asset.sha256!, budgetMs: 300_000 });
  const ownerWrite = store.ownerWrite.bind(store), swap = store.swapRow.bind(store);
  const replace = async () => {
    await store.putRow<PreparationRecord>('preparations', { id: asset.id, attemptId: 'successor', phase: 'finished', startedAt: 1000, updatedAt: 1000, sourceRevision: asset.sha256!, budgetMs: 300_000 });
    await store.updateAsset(asset.id, a => ({ ...a, processing_status: 'ready', last_error_code: null }));
  };
  // Same schedule for the former two-transaction implementation and the atomic implementation: publish the successor
  // immediately after the recovery preparation write commits. No later recovery asset write may corrupt it.
  store.swapRow = async <T extends { id: string }>(name: Parameters<ProjectStore['swapRow']>[0], id: string, change: (row: T | undefined) => T | null) => {
    const r = await swap(name, id, change); if ((r as PreparationRecord | null)?.phase === 'interrupted') await replace(); return r;
  };
  store.ownerWrite = async (id, attempt, write) => { const r = await ownerWrite(id, attempt, write); if (r === 'ok' && write.preparation?.({})?.phase === 'interrupted') await replace(); return r; };
  try { await scanInterrupted(store, () => STALE_MS + 1); return { record: await store.row<PreparationRecord>('preparations', asset.id), asset: await store.row<Asset>('assets', asset.id) }; }
  finally { await store.deleteAssets([asset.id]); await store.close(); }
}

export async function quickResume() {
  const { store, asset } = await setup(true); let probes = 0, resumeDone = false;
  const entered = deferred(), release = deferred(), ownerWrite = store.ownerWrite.bind(store);
  store.ownerWrite = async (id, attempt, write) => {
    if (write.preparation?.({})?.phase === 'cancelled') { entered.resolve(); await release.promise; }
    return ownerWrite(id, attempt, write);
  };
  const options = { steps: { probe: async () => { if (++probes === 1) return new Promise<ReturnType<typeof info>>(() => {}); return info(); } } };
  const unbind = bindPreparationLifecycle(() => { void resumePreparations(store, options).then(() => { resumeDone = true; }); });
  const old = prepareAsset(store, asset.id, options);
  try {
    await waitFor(() => probes === 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    await entered.promise;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => resumeDone); release.resolve(); await old;
    // A queued visible-page rescan must run after the cancellation has released ownership.
    await new Promise(r => setTimeout(r, 100));
    return { probes, asset: await store.row<Asset>('assets', asset.id), phase: (await store.row<PreparationRecord>('preparations', asset.id))?.phase };
  } finally { release.resolve(); unbind(); Reflect.deleteProperty(document, 'visibilityState'); await store.deleteAssets([asset.id]); await store.close(); }
}
