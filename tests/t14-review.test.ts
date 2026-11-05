// SPDX-License-Identifier: AGPL-3.0-only
// T14 review round 1 (independent review, 28 Oct): interleavings and recovery paths. Each case reproduces the reviewer's
// scheduling recipe with the real store and helpers; only IO timing/failure boundaries are controlled.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { Asset } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { mediaError } from '../apps/web/src/media/codes';
import { uploadReusing, uploadToProject } from '../apps/web/src/media/ingest';
import { prepareAsset } from '../apps/web/src/media/prepare';
import type { PreparationRecord, Steps } from '../apps/web/src/media/prepare';
import { listReferences, uploadReference } from '../apps/web/src/media/references';
import { addStockToProject, clearPhotoCache, searchPhotos } from '../apps/web/src/media/stock';
import type { StockItem } from '../apps/web/src/media/stock';

const opened: ProjectStore[] = [];
function setup(name: string = crypto.randomUUID()) {
  const bytes = new Map<string, Blob>(), proxies = new Map<string, Blob>();
  const media: MediaStore = {
    write: async (id, b) => { bytes.set(id, b); }, read: async id => { const b = bytes.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; },
    remove: async (kind, id) => { if (kind === 'asset') { bytes.delete(id); proxies.delete(id); } }, list: async () => [...bytes.keys()],
    writeProxy: async (id, b) => { proxies.set(id, b); }, readProxy: async id => { const b = proxies.get(id); if (!b) throw mediaError('WORKSPACE_FILE_MISSING'); return b; },
    removeProxy: async id => { proxies.delete(id); }, listProxies: async () => [...proxies.keys()],
  };
  const store = new ProjectStore(name, Date.now, media); opened.push(store); return { store, media, bytes, proxies };
}
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
const pause = () => new Promise(r => setTimeout(r, 2));
const until = async (fn: () => Promise<boolean> | boolean) => { for (let i = 0; i < 2000; i++) { if (await fn()) return; await pause(); } throw Error('wait expired'); };
const picked = (content = 'unchanged original') => new File([content], 'clip.mp4', { type: 'video/mp4' });
const info = (durationMs: number | null = 3000) => ({ container: 'mp4', mimeType: 'video/mp4', durationMs, video: null, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null });

describe('F1 recovery never deletes another tab\'s upload', () => {
  it('an upload completing between recovery\'s asset read and its byte listing keeps its record and original', async () => {
    const { store, media, bytes } = setup(); let fresh: Asset | undefined;
    media.list = async () => { fresh = await store.upload(picked()); return [...bytes.keys()]; };
    const r = await store.recoverInterrupted();
    expect(r.orphans).toEqual([]); expect(await store.row('assets', fresh!.id)).toBeTruthy(); expect(bytes.has(fresh!.id)).toBe(true);
  });
  it('an upload starting during recovery is left alone; a real orphan is still removed', async () => {
    const { store, media, bytes } = setup(); let release!: () => void; let started: Promise<Asset> | undefined;
    bytes.set('orphan', new Blob(['x']));
    const write = media.write; media.write = async (id, b) => { bytes.set(id, b); await new Promise<void>(r => { release = r; }); await write(id, b); };
    media.list = async () => { started = store.upload(picked()); await until(() => !!release); return [...bytes.keys()]; };
    const r = await store.recoverInterrupted(); release(); const a = await started!;
    expect(r.orphans).toEqual(['orphan']); expect(r.interrupted).toEqual([]); expect(bytes.has(a.id)).toBe(true);
    expect((await store.row<Asset>('assets', a.id))?.processing_status).toBe('processing');
  });
});
describe('F2 a finishing upload never resurrects a deleted asset or overwrites user edits', () => {
  it('delete while uploading: record and bytes stay gone and the upload reports UPLOAD_CANCELLED', async () => {
    const { store, media, bytes } = setup(); let release!: () => void;
    media.write = async (id, b) => { await new Promise<void>(r => { release = r; }); bytes.set(id, b); };
    const upload = store.upload(picked()); await until(() => !!release);
    const id = (await store.rows<Asset>('assets'))[0].id; await store.deleteAssets([id]);
    release(); await expect(upload).rejects.toMatchObject({ code: 'UPLOAD_CANCELLED' });
    expect(await store.row('assets', id)).toBeUndefined(); expect(bytes.has(id)).toBe(false);
  });
  it('rename and move during the upload survive its completion', async () => {
    const { store, media, bytes } = setup(); const folder = await store.createFolder('Clips'); let release!: () => void;
    media.write = async (id, b) => { await new Promise<void>(r => { release = r; }); bytes.set(id, b); };
    const upload = store.upload(picked()); await until(() => !!release);
    const id = (await store.rows<Asset>('assets'))[0].id; await store.rename('asset', id, 'renamed.mp4'); await store.moveAssets([id], folder.id);
    release(); await upload;
    expect(await store.row<Asset>('assets', id)).toMatchObject({ name: 'renamed.mp4', folderId: folder.id, processing_status: 'processing', processing_steps: { upload: 'complete' } });
  });
});
describe('F3 preparation ownership comes before the claim; an obsolete attempt writes nothing', () => {
  it('a second preparation during the first claim does not leave a stale "processing" step on a ready asset', async () => {
    const { store } = setup(); const a = await store.upload(picked());
    const swap = store.swapRow.bind(store); let ready!: () => void, release!: () => void, intercept = true;
    const inserted = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
    vi.spyOn(store, 'swapRow').mockImplementation(async (s, k, f) => { const out = await swap(s, k, f as never); if (s === 'preparations' && intercept && out) { intercept = false; ready(); await gate; } return out; });
    const steps = { probe: async () => info(1000) };
    const first = prepareAsset(store, a.id, { steps }); await inserted;
    const second = await prepareAsset(store, a.id, { steps }); release(); const firstResult = await first;
    const current = (await store.row<Asset>('assets', a.id))!;
    expect([firstResult, second].sort()).toEqual(['already-active', 'prepared']);
    expect(current.processing_status).toBe('ready'); expect(Object.values(current.processing_steps ?? {})).not.toContain('processing');
  });
});
describe('F4 the preparation budget follows the probed duration', () => {
  it('a new 10-minute clip gets 4 × 10 min + 2 min clamped to 30 min, not the 5-minute floor of an unknown duration', async () => {
    const { store } = setup(); const a = await store.upload(picked());
    const timeouts = new Map<number, { at: number; run: () => void }>(); let id = 0, now = 0, next!: () => void;
    const timers = { setTimeout: (run: () => void, ms: number) => { timeouts.set(++id, { at: now + ms, run }); return id; }, clearTimeout: (t: number) => { timeouts.delete(t); }, setInterval: () => ++id, clearInterval: () => {} };
    const advance = (ms: number) => { now += ms; for (const [k, t] of [...timeouts]) if (t.at <= now) { timeouts.delete(k); t.run(); } };
    const run = prepareAsset(store, a.id, { timers: timers as never, clock: () => now, steps: { probe: async () => info(600_000), thumbnails: async () => { await new Promise<void>(r => { next = r; }); return { poster: new Blob(['t']), frames: [], width: 1, height: 1 }; } } });
    await until(() => !!next);
    expect((await store.row<PreparationRecord>('preparations', a.id))?.budgetMs).toBe(1_800_000);
    advance(300_000); await pause(); expect((await store.row<Asset>('assets', a.id))?.last_error_code).toBeNull();
    advance(1_500_000); expect(await run).toBe('failed');
    expect((await store.row<Asset>('assets', a.id))?.last_error_code).toBe('CLIENT_PREPARATION_TIMEOUT'); next();
  });
});
describe('F5 reference publication is recoverable', () => {
  it('a failed reference record write leaves no bytes behind', async () => {
    const { store, proxies } = setup(); const put = store.putRow.bind(store);
    vi.spyOn(store, 'putRow').mockImplementation(async (name, value) => { if (name === 'references') throw new DOMException('quota full', 'QuotaExceededError'); return put(name, value as never); });
    for (let n = 0; n < 2; n++) await expect(uploadReference(store, picked(`r${n}`))).rejects.toMatchObject({ code: 'STORAGE_QUOTA' });
    expect(await store.rows('references')).toEqual([]); expect([...proxies.keys()]).toEqual([]);
  });
  it('after a crash between bytes and record, recovery removes the unpublished reference bytes', async () => {
    const { store, proxies } = setup(); const kept = await uploadReference(store, picked('kept'));
    proxies.set('ref-crashed', new Blob(['x'])); await store.putRow('references', { ...kept.reference, id: 'pending-one', sha256: 'p', pending: true }); proxies.set('ref-pending-one', new Blob(['y']));
    proxies.set('ghost-asset', new Blob(['proxy of a deleted asset']));
    await store.recoverInterrupted();
    expect([...proxies.keys()]).toEqual([`ref-${kept.reference.id}`]); expect((await listReferences(store)).map(r => r.id)).toEqual([kept.reference.id]);
    expect(await store.row('references', 'pending-one')).toBeUndefined();
  });
});
describe('F6 reuse decisions are serialized by media identity', () => {
  it('two simultaneous project imports of the same name + size give one asset (one upload, one reuse)', async () => {
    const { store } = setup(), p = await store.create();
    const both = await Promise.all([uploadToProject(store, p.id, [picked()], { prepare: false }), uploadToProject(store, p.id, [picked()], { prepare: false })]);
    expect((await store.library()).assets).toHaveLength(1);
    expect(both.map(r => r.uploaded.length + r.reused.length)).toEqual([1, 1]); expect(both.flatMap(r => r.uploaded)).toHaveLength(1);
    const picker = await Promise.all([uploadReusing(store, [picked('other bytes!')], { prepare: false }), uploadReusing(store, [picked('other bytes!')], { prepare: false })]);
    expect(picker.flatMap(r => r.uploaded)).toHaveLength(1); expect((await store.library()).assets).toHaveLength(2);
  });
  it('two simultaneous reference uploads of identical bytes give one reference and one byte object', async () => {
    const { store, proxies } = setup();
    const both = await Promise.all([uploadReference(store, picked()), uploadReference(store, picked())]);
    expect(await store.rows('references')).toHaveLength(1); expect(proxies.size).toBe(1); expect(both.map(r => r.reused).sort()).toEqual([false, true]);
  });
  it('two simultaneous stock adds of the same provider item give one asset', async () => {
    const { store } = setup(), p = await store.create();
    vi.stubGlobal('fetch', vi.fn(async () => { await pause(); return new Response(new Blob(['mp3 bytes'], { type: 'audio/mpeg' })); }));
    const item: StockItem = { provider: 'freesound', provider_id: '7', type: 'audio', name: 'Door', thumbnail_url: '', preview_url: 'https://cdn.freesound.org/previews/7.mp3', duration_ms: 1200, width: null, height: null,
      attribution: 'a', author: 'u', licence: 'CC0', page_url: 'https://freesound.org/s/7/', download_url: 'https://cdn.freesound.org/previews/7.mp3', tags: [] };
    const both = await Promise.all([addStockToProject(store, p.id, item, { prepare: false }), addStockToProject(store, p.id, item, { prepare: false })]);
    expect((await store.library()).assets).toHaveLength(1); expect(both.map(r => r.alreadyInProject).sort()).toEqual([false, true]);
  });
});
describe('F9 re-picking the original of a failed / missing reused asset recovers it', () => {
  const steps: Partial<Steps> = { probe: async () => info() };
  it('project footage: the missing original is restored from the picked file (size + SHA-256 verified) and prepared', async () => {
    const { store, bytes } = setup(), p = await store.create(), a = await store.upload(picked());
    bytes.delete(a.id); await store.updateAsset(a.id, x => ({ ...x, processing_status: 'failed', last_error_code: 'OBJECT_MISSING' }));
    const r = await uploadToProject(store, p.id, [picked()], { prepare: { steps } }); await Promise.all(r.preparing);
    expect(r).toMatchObject({ reused: [a.id], uploaded: [], failed: [] }); expect(await bytes.get(a.id)?.text()).toBe('unchanged original');
    expect(await store.row<Asset>('assets', a.id)).toMatchObject({ processing_status: 'ready', last_error_code: null });
  });
  it('same name + size but different bytes is not counted as reuse: WORKSPACE_ORIGINAL_MISMATCH', async () => {
    const { store, bytes } = setup(), p = await store.create(), a = await store.upload(picked());
    bytes.delete(a.id);
    const r = await uploadToProject(store, p.id, [picked('Unchanged original')], { prepare: false });
    expect(r.reused).toEqual([]); expect(r.failed.map(f => (f.error as unknown as { code: string }).code)).toEqual(['WORKSPACE_ORIGINAL_MISMATCH']);
    expect(bytes.has(a.id)).toBe(false);
  });
  it('the wizard picker restores a missing original too', async () => {
    const { store, bytes } = setup(), a = await store.upload(picked()); bytes.delete(a.id);
    const r = await uploadReusing(store, [picked()], { prepare: false });
    expect(r.reused).toEqual([a.id]); expect(await bytes.get(a.id)?.text()).toBe('unchanged original');
  });
});
describe('F15 curated photos are cached for 5 minutes', () => {
  it('repeat openings within 5 min reuse the curated page; expiry and a key change refetch; searches are never cached', async () => {
    clearPhotoCache(); let t = 0; const clock = () => t;
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('pexels') ? { photos: [{ id: 1, width: 1, height: 1, url: 'u', photographer: 'p', src: { original: 'o' } }] } : []), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await searchPhotos({ pexels: 'P', unsplash: 'U' }, '', 1, undefined, clock); t = 299_999;
    await searchPhotos({ pexels: 'P', unsplash: 'U' }, '', 1, undefined, clock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    t = 300_000; await searchPhotos({ pexels: 'P', unsplash: 'U' }, '', 1, undefined, clock); expect(fetchMock).toHaveBeenCalledTimes(4);
    await searchPhotos({ pexels: 'P2', unsplash: 'U' }, '', 1, undefined, clock); expect(fetchMock).toHaveBeenCalledTimes(5);
    await searchPhotos({ pexels: 'P2', unsplash: 'U' }, 'sea', 1, undefined, clock); await searchPhotos({ pexels: 'P2', unsplash: 'U' }, 'sea', 1, undefined, clock);
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });
});
