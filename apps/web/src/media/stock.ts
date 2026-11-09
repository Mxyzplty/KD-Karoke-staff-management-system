// SPDX-License-Identifier: AGPL-3.0-only
// Stock media (findings part 2 §32, part 3 §46.3): Pexels (photos, videos), Unsplash (photos), Freesound (sounds), called
// directly from the browser with the user's own free keys, stored encrypted (settings/secrets.ts) and managed in Settings too.
// Result shape follows §32: {provider, provider_id, type, name, thumbnail_url, preview_url, duration_ms, width, height, attribution, provider_metadata}.
import type { ProjectStore } from '../store/database';
import type { Asset } from '../store/model';
import { mediaError } from './codes';
import { uploadToProject } from './ingest';
import type { IngestOptions } from './ingest';
import { lockNames, withLock } from './locks';
import { countRequest } from '../settings/meter';
import { getSecret, putSecret, removeSecret } from '../settings/secrets';

export type Provider = 'pexels' | 'unsplash' | 'freesound';
export type StockKeys = Partial<Record<Provider, string>>;
export type StockItem = {
  provider: Provider; provider_id: string; type: 'image' | 'video' | 'audio'; name: string; thumbnail_url: string; preview_url: string; duration_ms: number | null;
  width: number | null; height: number | null; attribution: string; author: string; licence: string; page_url: string; download_url: string; tags: string[]; tracking_url?: string;
};
export type StockPage = { results: StockItem[]; has_next_page: boolean; page: number };
export const PAGE_SIZE = { image: 20, video: 15, audio: 15 } as const;
const KEYS_ROW = 'stock-keys', PROVIDERS: Provider[] = ['pexels', 'unsplash', 'freesound'];
/** The one origin each key may be sent to. */
export const STOCK_ORIGIN: Record<Provider, string> = { pexels: 'https://api.pexels.com', unsplash: 'https://api.unsplash.com', freesound: 'https://freesound.org' };
const keyId = (provider: Provider) => `stock:${provider}`;
/** Keys saved before T21 sit in a plain settings row: they move into the encrypted store on the first read. */
async function migrateKeys(store: ProjectStore) {
  const row = await store.row<{ id: string; keys: StockKeys }>('settings', KEYS_ROW);
  if (!row) return;
  for (const p of PROVIDERS) if (row.keys[p]) await putSecret(keyId(p), row.keys[p]!, STOCK_ORIGIN[p]);
  await store.deleteRow('settings', KEYS_ROW);
}
export async function readKeys(store: ProjectStore): Promise<StockKeys> {
  await migrateKeys(store);
  const entries = await Promise.all(PROVIDERS.map(async p => [p, await getSecret(keyId(p), STOCK_ORIGIN[p])] as const));
  return Object.fromEntries(entries.filter(([, key]) => key));
}
export async function saveKey(store: ProjectStore, provider: Provider, key: string) {
  await migrateKeys(store);
  if (key.trim()) await putSecret(keyId(provider), key.trim(), STOCK_ORIGIN[provider]); else await removeSecret(keyId(provider));
  return readKeys(store);
}
async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  countRequest(PROVIDERS.find(p => new URL(url).origin === STOCK_ORIGIN[p]) ?? 'stock');
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw Object.assign(new Error(`${new URL(url).hostname} answered ${response.status}`), { status: response.status });
  return response.json();
}
const largest = (src: Record<string, string>) => src.original ?? src.large2x ?? src.large ?? src.medium;
function pexelsPhoto(p: any): StockItem {
  return { provider: 'pexels', provider_id: String(p.id), type: 'image', name: p.alt || `Pexels photo ${p.id}`, thumbnail_url: p.src?.medium ?? p.src?.small, preview_url: p.src?.large ?? p.src?.medium,
    duration_ms: null, width: p.width, height: p.height, author: p.photographer, attribution: `Photo by ${p.photographer} on Pexels`, licence: 'Pexels License', page_url: p.url, download_url: largest(p.src ?? {}), tags: [] };
}
function unsplashPhoto(p: any): StockItem {
  return { provider: 'unsplash', provider_id: p.id, type: 'image', name: p.alt_description || p.description || `Unsplash photo ${p.id}`, thumbnail_url: p.urls?.small ?? p.urls?.thumb, preview_url: p.urls?.regular,
    duration_ms: null, width: p.width, height: p.height, author: p.user?.name, attribution: `Photo by ${p.user?.name} on Unsplash`, licence: 'Unsplash License', page_url: p.links?.html,
    download_url: p.urls?.full ?? p.urls?.regular ?? p.urls?.small, tags: [], tracking_url: p.links?.download_location };
}
function pexelsVideo(v: any): StockItem {
  // Largest MP4 rendition not above 1080 p on the short side (stated choice), else the largest.
  const files = [...(v.video_files ?? [])].filter((f: any) => /mp4/.test(f.file_type ?? '')).sort((a: any, b: any) => b.width * b.height - a.width * a.height);
  const pick = files.find((f: any) => Math.min(f.width, f.height) <= 1080) ?? files[0];
  return { provider: 'pexels', provider_id: String(v.id), type: 'video', name: `Pexels video ${v.id}`, thumbnail_url: v.image, preview_url: pick?.link, duration_ms: v.duration * 1000,
    width: v.width, height: v.height, author: v.user?.name, attribution: `Video by ${v.user?.name} on Pexels`, licence: 'Pexels License', page_url: v.url, download_url: pick?.link, tags: [] };
}
function freesound(s: any): StockItem {
  return { provider: 'freesound', provider_id: String(s.id), type: 'audio', name: s.name, thumbnail_url: '', preview_url: s.previews?.['preview-hq-mp3'] ?? s.previews?.['preview-lq-mp3'],
    duration_ms: s.duration * 1000, width: null, height: null, author: s.username, attribution: `"${s.name}" by ${s.username} (Freesound, ${s.license})`, licence: s.license,
    page_url: s.url, download_url: s.previews?.['preview-hq-mp3'] ?? s.previews?.['preview-lq-mp3'], tags: (s.tags ?? []).slice(0, 3) };
}
/** Curated photos are cached for 5 minutes (findings part 2 §32), per provider, key and page; searches are not cached. */
export const CURATED_TTL_MS = 5 * 60_000;
type ProviderPage = { items: StockItem[]; next: boolean };
const curated = new Map<string, { at: number; value: ProviderPage }>();
export const clearPhotoCache = () => curated.clear();
/** Photos: curated (no query) or searched, from both providers, interleaved one by one; 20 per page. */
export async function searchPhotos(keys: StockKeys, query: string, page: number, signal?: AbortSignal, clock: () => number = Date.now): Promise<StockPage> {
  const per = PAGE_SIZE.image / 2, q = encodeURIComponent(query.trim()), none: ProviderPage = { items: [], next: false };
  const cached = async (provider: Provider, key: string, load: () => Promise<ProviderPage>) => {
    if (query.trim()) return load();
    const id = JSON.stringify([provider, key, page]), hit = curated.get(id);
    if (hit && clock() - hit.at < CURATED_TTL_MS) return hit.value;
    const value = await load(); curated.set(id, { at: clock(), value }); return value;
  };
  const [pexels, unsplash] = await Promise.all([
    keys.pexels ? cached('pexels', keys.pexels, () => getJson(query.trim() ? `https://api.pexels.com/v1/search?query=${q}&page=${page}&per_page=${per}` : `https://api.pexels.com/v1/curated?page=${page}&per_page=${per}`, { Authorization: keys.pexels! }, signal)
      .then(r => ({ items: (r.photos ?? []).map(pexelsPhoto), next: !!r.next_page }))) : none,
    keys.unsplash ? cached('unsplash', keys.unsplash, () => getJson(query.trim() ? `https://api.unsplash.com/search/photos?query=${q}&page=${page}&per_page=${per}` : `https://api.unsplash.com/photos?page=${page}&per_page=${per}`, { Authorization: `Client-ID ${keys.unsplash}` }, signal)
      .then(r => { const list = Array.isArray(r) ? r : r.results ?? []; return { items: list.map(unsplashPhoto), next: Array.isArray(r) ? list.length === per : page < (r.total_pages ?? 0) }; })) : none,
  ]);
  const results: StockItem[] = [];
  for (let i = 0; i < Math.max(pexels.items.length, unsplash.items.length); i++) { if (pexels.items[i]) results.push(pexels.items[i]); if (unsplash.items[i]) results.push(unsplash.items[i]); }
  return { results, has_next_page: pexels.next || unsplash.next, page };
}
export async function searchVideos(keys: StockKeys, query: string, page: number, signal?: AbortSignal): Promise<StockPage> {
  if (!keys.pexels) return { results: [], has_next_page: false, page };
  const r = await getJson(`https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(query.trim())}&page=${page}&per_page=${PAGE_SIZE.video}`, { Authorization: keys.pexels }, signal);
  return { results: (r.videos ?? []).map(pexelsVideo), has_next_page: !!r.next_page, page };
}
export async function searchSounds(keys: StockKeys, query: string, page: number, signal?: AbortSignal): Promise<StockPage> {
  if (!keys.freesound) return { results: [], has_next_page: false, page };
  const r = await getJson(`https://freesound.org/apiv2/search/?query=${encodeURIComponent(query.trim())}&page=${page}&page_size=${PAGE_SIZE.audio}&fields=id,name,duration,username,tags,previews,license,url`, { Authorization: `Token ${keys.freesound}` }, signal);
  return { results: (r.results ?? []).map(freesound), has_next_page: !!r.next, page };
}
/** Sound row duration: one decimal + "s" (part 3 §46.3). */
export const soundDuration = (ms: number | null) => `${((ms ?? 0) / 1000).toFixed(1)}s`;
const extensionFor = (type: string, url: string) => (url.match(/\.(jpe?g|png|webp|mp4|mov|webm|mp3|ogg|wav)(?:$|\?)/i)?.[1] ?? (type === 'image' ? 'jpg' : type === 'video' ? 'mp4' : 'mp3')).toLowerCase();
/**
 * Add to project (§32): download into the library with attribution and licence, link to the project. An item already
 * linked to the project ("already in project", Xapp's 409) adds no new asset and returns the existing one.
 */
export function addStockToProject(store: ProjectStore, projectId: string, item: StockItem, options: IngestOptions = {}): Promise<{ asset: Asset; alreadyInProject: boolean; preparing: Promise<unknown>[] }> {
  // Lookup, download and insert are serialized per provider item (review F6): a double click or a second tab reuses it.
  return withLock(lockNames.identity(`stock:${item.provider}:${item.type}:${item.provider_id}`), () => addUnderLock(store, projectId, item, options));
}
async function addUnderLock(store: ProjectStore, projectId: string, item: StockItem, options: IngestOptions): Promise<{ asset: Asset; alreadyInProject: boolean; preparing: Promise<unknown>[] }> {
  const links = await store.projectAssets(projectId), library = (await store.library()).assets;
  const existing = library.find(a => a.source?.kind === 'stock' && a.source.provider === item.provider && a.source.providerId === item.provider_id && a.type === item.type);
  if (existing && links.some(l => l.assetId === existing.id)) return { asset: existing, alreadyInProject: true, preparing: [] };
  if (existing) { await store.attach(projectId, existing.id); return { asset: existing, alreadyInProject: false, preparing: [] }; }
  let blob: Blob;
  try {
    const response = await fetch(item.download_url, { signal: options.signal });
    if (!response.ok) throw mediaError('UPLOAD_FAILED', `The ${item.provider} download answered ${response.status}.`);
    blob = await response.blob();
    // Unsplash's guidelines ask apps to report each download to its download_location.
    if (item.tracking_url) { const key = (await readKeys(store)).unsplash; if (key) void fetch(item.tracking_url, { headers: { Authorization: `Client-ID ${key}` } }).catch(() => {}); }
  } catch (e) { if ((e as { code?: string }).code) throw e; throw mediaError('UPLOAD_NETWORK_ERROR', undefined, { provider: item.provider }); }
  const file = new File([blob], `${item.provider}-${item.provider_id}.${extensionFor(item.type, item.download_url)}`, { type: blob.type });
  const result = await uploadToProject(store, projectId, [file], { ...options, source: { kind: 'stock', provider: item.provider, providerId: item.provider_id, attribution: item.attribution, licence: item.licence, pageUrl: item.page_url, author: item.author } });
  if (result.failed.length) throw result.failed[0].error;
  return { asset: result.assets[0], alreadyInProject: false, preparing: result.preparing };
}
