// SPDX-License-Identifier: AGPL-3.0-only
// T14 acceptance 8 (reference videos, part 2 §36) and 10 (stock, part 2 §32 / part 3 §46.3) with mocked provider
// responses: no request leaves the test (fetch is stubbed and every URL is asserted).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { MediaStore } from '../apps/web/src/store/media';
import { mediaError } from '../apps/web/src/media/codes';
import { attachReference, deleteReference, detachReference, listReferences, projectReferences, retryReference, uploadReference } from '../apps/web/src/media/references';
import { addStockToProject, clearPhotoCache, PAGE_SIZE, readKeys, saveKey, searchPhotos, searchSounds, searchVideos, soundDuration } from '../apps/web/src/media/stock';
import type { StockItem } from '../apps/web/src/media/stock';

const opened: ProjectStore[] = []; let tick = Date.parse('2026-10-28T00:00:00Z');
function setup() {
  const files = new Map<string, Blob>();
  const media: MediaStore = { write: async (id, b) => { files.set(id, b); }, read: async id => { const b = files.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; },
    remove: async (_k, id) => { files.delete(id); }, list: async () => [...files.keys()], writeProxy: async (id, b) => { files.set(`p:${id}`, b); }, readProxy: async id => files.get(`p:${id}`)!, removeProxy: async id => { files.delete(`p:${id}`); } };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return { store, files };
}
beforeEach(clearPhotoCache);
afterEach(async () => { vi.unstubAllGlobals(); for (const s of opened.splice(0)) await s.close(); });
const video = (name: string, content = 'reference bytes') => new File([content], name, { type: 'video/mp4' });

describe('T14 reference videos (§36)', () => {
  it('the same reference twice is reused by hash, also after soft delete; "N saved" counts the live ones; no quota', async () => {
    const { store, files } = setup();
    const first = await uploadReference(store, video('ref.mp4')), second = await uploadReference(store, video('renamed.mp4'));
    expect(first.reused).toBe(false); expect(second).toMatchObject({ reused: true, reference: { id: first.reference.id } });
    expect([...files.keys()].filter(k => k.startsWith('p:ref-'))).toHaveLength(1); expect(await listReferences(store)).toHaveLength(1);
    await deleteReference(store, first.reference.id); expect(await listReferences(store)).toHaveLength(0);
    const again = await uploadReference(store, video('ref.mp4')); expect(again).toMatchObject({ reused: true, reference: { id: first.reference.id, deleted_at: null } });
    for (let n = 0; n < 7; n++) await uploadReference(store, video(`r${n}.mp4`, `bytes ${n}`));
    expect(await listReferences(store)).toHaveLength(8);
  });
  it('attach / detach per project; delete removes it from every project; retry with no provider stays "no-provider", never "ready"', async () => {
    const { store } = setup(), p = await store.create(), q = await store.create(); const { reference } = await uploadReference(store, video('ref.mp4'));
    expect(reference.analysis.status).toBe('no-provider');
    await attachReference(store, p.id, reference.id); await attachReference(store, q.id, reference.id);
    expect((await projectReferences(store, p.id)).map(r => r.id)).toEqual([reference.id]);
    await detachReference(store, p.id, reference.id); expect(await projectReferences(store, p.id)).toEqual([]); expect(await projectReferences(store, q.id)).toHaveLength(1);
    expect((await retryReference(store, reference.id)).analysis.status).toBe('no-provider');
    expect((await retryReference(store, reference.id, async () => { throw new Error('model offline'); })).analysis).toEqual({ status: 'failed', error: 'model offline' });
    await attachReference(store, p.id, reference.id); await deleteReference(store, reference.id);
    expect(await projectReferences(store, p.id)).toEqual([]); expect(await projectReferences(store, q.id)).toEqual([]);
    await expect(attachReference(store, p.id, reference.id)).rejects.toMatchObject({ message: 'Attach failed' });
    await expect(detachReference(store, p.id, 'missing')).rejects.toMatchObject({ message: 'Detach failed' });
  });
});
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(route: Route) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => { calls.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> }); return route(new URL(input), init); }));
  return calls;
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const pexelsPhoto = (id: number) => ({ id, width: 100, height: 80, url: `https://www.pexels.com/photo/${id}/`, photographer: `P${id}`, alt: `pexels ${id}`, src: { original: `https://images.pexels.com/${id}.jpg`, large2x: `https://images.pexels.com/${id}-2x.jpg`, large: `https://images.pexels.com/${id}-l.jpg`, medium: `https://images.pexels.com/${id}-m.jpg` } });
const unsplashPhoto = (id: number) => ({ id: `u${id}`, width: 100, height: 80, alt_description: `unsplash ${id}`, user: { name: `U${id}` }, urls: { full: `https://images.unsplash.com/u${id}`, regular: `https://images.unsplash.com/u${id}-r`, small: `https://images.unsplash.com/u${id}-s` }, links: { html: `https://unsplash.com/photos/u${id}`, download_location: `https://api.unsplash.com/photos/u${id}/download` } });
const sound = (id: number) => ({ id, name: `Sound ${id}`, duration: 1.234 + id, username: `user${id}`, tags: ['a', 'b', 'c', 'd'], license: 'http://creativecommons.org/publicdomain/zero/1.0/', url: `https://freesound.org/s/${id}/`, previews: { 'preview-hq-mp3': `https://cdn.freesound.org/previews/${id}.mp3` } });
describe('T14 stock media (§32, §46.3) with mocked providers', () => {
  it('no keys: nothing is requested; keys are stored locally', async () => {
    const { store } = setup(), calls = mockFetch(() => json({}));
    expect(await readKeys(store)).toEqual({});
    expect((await searchPhotos({}, '', 1)).results).toEqual([]); expect((await searchVideos({}, 'sea', 1)).results).toEqual([]); expect((await searchSounds({}, 'door', 1)).results).toEqual([]);
    expect(calls).toEqual([]);
    expect(await saveKey(store, 'pexels', ' key-1 ')).toEqual({ pexels: 'key-1' }); expect(await readKeys(store)).toEqual({ pexels: 'key-1' });
  });
  it('photos: curated on open from both providers, interleaved one by one, 20 per page; search queries both; load more asks page 2', async () => {
    const calls = mockFetch(url => url.hostname === 'api.pexels.com' ? json({ photos: Array.from({ length: 10 }, (_, i) => pexelsPhoto(i + Number(url.searchParams.get('page')) * 100)), next_page: 'x' })
      : json(Array.from({ length: 10 }, (_, i) => unsplashPhoto(i + Number(url.searchParams.get('page')) * 100))));
    const keys = { pexels: 'P', unsplash: 'U' }, first = await searchPhotos(keys, '', 1);
    expect(first.results).toHaveLength(PAGE_SIZE.image); expect(PAGE_SIZE.image).toBe(20);
    expect(first.results.slice(0, 4).map(r => `${r.provider}:${r.provider_id}`)).toEqual(['pexels:100', 'unsplash:u100', 'pexels:101', 'unsplash:u101']);
    expect(calls.map(c => c.url)).toEqual(['https://api.pexels.com/v1/curated?page=1&per_page=10', 'https://api.unsplash.com/photos?page=1&per_page=10']);
    expect(calls[0].headers).toEqual({ Authorization: 'P' }); expect(calls[1].headers).toEqual({ Authorization: 'Client-ID U' });
    expect(first.results[0]).toMatchObject({ download_url: 'https://images.pexels.com/100.jpg', attribution: 'Photo by P100 on Pexels' });
    const more = await searchPhotos(keys, 'sea', 2);
    expect(calls.slice(2).map(c => c.url)).toEqual(['https://api.pexels.com/v1/search?query=sea&page=2&per_page=10', 'https://api.unsplash.com/search/photos?query=sea&page=2&per_page=10']);
    expect(more.has_next_page).toBe(true);
  });
  it('full-size fallback original → large2x → large → preview', async () => {
    const p = pexelsPhoto(1); delete (p.src as Record<string, string>).original;
    mockFetch(() => json({ photos: [p, { ...pexelsPhoto(2), src: { medium: 'https://images.pexels.com/2-m.jpg' } }] }));
    const r = await searchPhotos({ pexels: 'P' }, '', 1);
    expect(r.results.map(x => x.download_url)).toEqual(['https://images.pexels.com/1-2x.jpg', 'https://images.pexels.com/2-m.jpg']);
  });
  it('videos 15 per page with duration; sounds 15 per page, row duration one decimal + "s", ≤ 3 tags, "by <author>"', async () => {
    const calls = mockFetch(url => url.hostname === 'api.pexels.com' ? json({ videos: Array.from({ length: 15 }, (_, i) => ({ id: i, width: 1920, height: 1080, duration: 7, url: 'u', image: `https://images.pexels.com/v${i}.jpg`, user: { name: 'V' }, video_files: [{ file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://player.example/4k' }, { file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://player.example/hd' }] })), next_page: 'n' })
      : json({ results: Array.from({ length: 15 }, (_, i) => sound(i)), next: null }));
    const v = await searchVideos({ pexels: 'P' }, 'sea', 1), s = await searchSounds({ freesound: 'F' }, 'door', 1);
    expect(v.results).toHaveLength(15); expect(v.results[0]).toMatchObject({ duration_ms: 7000, download_url: 'https://player.example/hd' });
    expect(s.results).toHaveLength(15); expect(soundDuration(s.results[0].duration_ms)).toBe('1.2s'); expect(s.results[0]).toMatchObject({ author: 'user0', tags: ['a', 'b', 'c'] });
    expect(calls.map(c => c.url)).toEqual(['https://api.pexels.com/v1/videos/search?query=sea&page=1&per_page=15', 'https://freesound.org/apiv2/search/?query=door&page=1&page_size=15&fields=id,name,duration,username,tags,previews,license,url']);
    expect(calls[1].headers).toEqual({ Authorization: 'Token F' });
  });
  it('add-to-project downloads into the library with attribution + licence and links it; adding twice adds no new asset; a network failure is UPLOAD_NETWORK_ERROR', async () => {
    const { store } = setup(), p = await store.create();
    const item: StockItem = { provider: 'freesound', provider_id: '7', type: 'audio', name: 'Door', thumbnail_url: '', preview_url: 'https://cdn.freesound.org/previews/7.mp3', duration_ms: 1200, width: null, height: null,
      attribution: '"Door" by user7 (Freesound, CC0)', author: 'user7', licence: 'CC0', page_url: 'https://freesound.org/s/7/', download_url: 'https://cdn.freesound.org/previews/7.mp3', tags: [] };
    const calls = mockFetch(() => new Response(new Blob(['mp3 bytes'], { type: 'audio/mpeg' })));
    const first = await addStockToProject(store, p.id, item, { prepare: false });
    expect(first.alreadyInProject).toBe(false);
    expect(first.asset).toMatchObject({ name: 'freesound-7.mp3', type: 'audio', source: { kind: 'stock', provider: 'freesound', providerId: '7', attribution: '"Door" by user7 (Freesound, CC0)', licence: 'CC0', author: 'user7' } });
    expect((await store.projectAssets(p.id)).map(l => [l.assetId, l.agent_id])).toEqual([[first.asset.id, 'audio_1']]);
    const second = await addStockToProject(store, p.id, item, { prepare: false });
    expect(second).toMatchObject({ alreadyInProject: true, asset: { id: first.asset.id } }); expect((await store.library()).assets).toHaveLength(1); expect(calls).toHaveLength(1);
    const q = await store.create(); expect((await addStockToProject(store, q.id, item, { prepare: false })).asset.id).toBe(first.asset.id); expect(calls).toHaveLength(1);
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    await expect(addStockToProject(store, p.id, { ...item, provider_id: '8', download_url: 'https://cdn.freesound.org/previews/8.mp3' }, { prepare: false })).rejects.toMatchObject({ code: 'UPLOAD_NETWORK_ERROR', category: 'system_error' });
  });
});
