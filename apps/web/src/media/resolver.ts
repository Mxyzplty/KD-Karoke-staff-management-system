// SPDX-License-Identifier: AGPL-3.0-only
// Per-item source resolver (findings §2): the item's Use Proxy flag picks proxy or original for preview; export always
// uses the original. The flag lives at item.details.useProxy, default true (stated assumption: no field name in our docs).
import type { ProjectStore } from '../store/database';
import type { Asset, RecordData } from '../store/model';
import { mediaError } from './codes';

export type ResolvedSource = { kind: 'proxy' | 'original'; assetId: string; blob: Blob; width: number | null; height: number | null };
export const usesProxy = (item: RecordData) => item?.details?.useProxy !== false;
export async function resolveSource(store: ProjectStore, item: RecordData, purpose: 'preview' | 'export' = 'preview'): Promise<ResolvedSource> {
  const assetId = item?.metadata?.assetId as string | undefined;
  const asset = assetId ? await store.row<Asset>('assets', assetId) : undefined;
  if (!asset || !assetId) throw mediaError('WORKSPACE_FILE_MISSING', 'This item has no stored source.');
  if (purpose === 'preview' && usesProxy(item) && asset.proxy && store.media.readProxy) {
    try { return { kind: 'proxy', assetId, blob: await store.media.readProxy(asset.proxy.objectKey ?? assetId), width: asset.proxy.width, height: asset.proxy.height }; }
    catch { /* a missing proxy falls back to the original */ }
  }
  const v = asset.media?.video;
  return { kind: 'original', assetId, blob: await store.media.read(assetId), width: v?.displayWidth ?? asset.media?.image?.width ?? null, height: v?.displayHeight ?? asset.media?.image?.height ?? null };
}
/** Exportability wait (findings §2): resolve once the asset's proxy exists, or PROXY_TIMEOUT after `timeoutMs`. */
export async function awaitProxy(store: ProjectStore, assetId: string, timeoutMs: number, clock = Date.now, poll = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<NonNullable<Asset['proxy']>> {
  const start = clock();
  for (;;) {
    const asset = await store.row<Asset>('assets', assetId);
    if (asset?.proxy) return asset.proxy;
    if (clock() - start >= timeoutMs) throw mediaError('PROXY_TIMEOUT');
    await poll(250);
  }
}
