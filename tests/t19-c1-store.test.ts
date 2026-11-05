// SPDX-License-Identifier: AGPL-3.0-only
// T19 C1 store acceptance: database v3 (the four analysis stores, per-asset deletion) and the project title_source
// (create / rename / generated title, and the v2 → v3 upgrade). Synthetic rows only.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { StoreName } from '../apps/web/src/store/database';
import type { Asset, ProjectRecord } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';

const opened: ProjectStore[] = [];
let tick = Date.parse('2026-11-02T00:00:00Z');
function setup() {
  const media: MediaStore = { write: vi.fn(async () => {}), read: vi.fn(async () => new Blob()), remove: vi.fn(async () => {}) };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return { store, media };
}
afterEach(async () => { vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });

const PER_ASSET: StoreName[] = ['thumbnails', 'waveforms', 'preparations', 'transcripts', 'analyses', 'rhythms', 'search_index'];
const asset = (id: string, folderId: string | null = null): Asset => ({ id, name: `${id}.mp4`, type: 'video', sizeBytes: 1, mimeType: 'video/mp4', folderId, created_at: '2026-11-02T00:00:00.000Z', recorded_at: null, location: null, durationMs: 1000, processing_status: 'ready', processing_steps: { upload: 'complete' } });
async function seed(store: ProjectStore, id: string, folderId: string | null = null) {
  await store.putRow('assets', asset(id, folderId));
  for (const name of PER_ASSET) await store.putRow(name, { id, marker: name });
}
const present = async (store: ProjectStore, id: string) => Object.fromEntries(await Promise.all(PER_ASSET.map(async n => [n, !!await store.row(n, id)])));
const all = (value: boolean) => Object.fromEntries(PER_ASSET.map(n => [n, value]));
const databaseStores = async (name: string) => new Promise<string[]>((resolve, reject) => {
  const r = indexedDB.open(name);
  r.onsuccess = () => { const names = [...r.result.objectStoreNames]; r.result.close(); resolve(names); };
  r.onerror = () => reject(r.error);
});

describe('T19 C1 database v3', () => {
  it('creates transcripts, analyses, rhythms and search_index next to the T14 stores', async () => {
    const { store } = setup(); await store.list();
    const names = await databaseStores(store.name);
    for (const n of ['transcripts', 'analyses', 'rhythms', 'search_index', 'thumbnails', 'waveforms', 'preparations', 'projects', 'assets']) expect(names).toContain(n);
    for (const n of ['transcripts', 'analyses', 'rhythms', 'search_index']) { await store.putRow(n as StoreName, { id: 'k', v: n }); expect(await store.row(n as StoreName, 'k')).toEqual({ id: 'k', v: n }); }
  });
  it('deleteAssets removes that asset\'s rows from every per-asset store and leaves the others', async () => {
    const { store } = setup(); await seed(store, 'gone'); await seed(store, 'keep');
    expect(await present(store, 'gone')).toEqual(all(true));
    await store.deleteAssets(['gone']);
    expect(await store.row('assets', 'gone')).toBeUndefined();
    expect(await present(store, 'gone')).toEqual(all(false));
    expect(await present(store, 'keep')).toEqual(all(true)); expect(await store.row('assets', 'keep')).toBeTruthy();
  });
  it('deleteFolder(everything) removes the rows of every asset in the folder tree, not of assets outside it', async () => {
    const { store } = setup(), top = await store.createFolder('Top'), sub = await store.createFolder('Sub', top.id), other = await store.createFolder('Other');
    await seed(store, 'in-top', top.id); await seed(store, 'in-sub', sub.id); await seed(store, 'outside', other.id); await seed(store, 'loose');
    await store.deleteFolder(top.id, true);
    for (const id of ['in-top', 'in-sub']) { expect(await store.row('assets', id)).toBeUndefined(); expect(await present(store, id)).toEqual(all(false)); }
    for (const id of ['outside', 'loose']) { expect(await store.row('assets', id)).toBeTruthy(); expect(await present(store, id)).toEqual(all(true)); }
  });
  it('deleteFolder without everything keeps the assets and their rows', async () => {
    const { store } = setup(), folder = await store.createFolder('Keep');
    await seed(store, 'moved', folder.id); await store.deleteFolder(folder.id, false);
    expect((await store.row<Asset>('assets', 'moved'))?.folderId).toBeNull(); expect(await present(store, 'moved')).toEqual(all(true));
  });
});

describe('T19 C1 project title_source', () => {
  it('create: "Untitled Project" (or no title) is default, any given title is user', async () => {
    const { store } = setup();
    expect((await store.create()).title_source).toBe('default');
    expect((await store.create('Untitled Project')).title_source).toBe('default');
    expect((await store.create('   ')).title_source).toBe('default');
    const named = await store.create('Summer trip'); expect(named).toMatchObject({ title: 'Summer trip', title_source: 'user' });
    expect((await store.read(named.id))?.record.title_source).toBe('user');
  });
  it('renameProject sets user, even back to the default title', async () => {
    const { store } = setup(), p = await store.create();
    await store.renameProject(p.id, 'My film'); expect((await store.read(p.id))?.record).toMatchObject({ title: 'My film', title_source: 'user' });
    const q = await store.create('Other'); await store.renameProject(q.id, 'Untitled Project');
    expect((await store.read(q.id))?.record.title_source).toBe('user');
    expect(await store.setGeneratedTitle(q.id, 'Nope')).toBe(false); // a user's choice, even if it equals the default text
  });
  it('setGeneratedTitle writes and marks "generated" only for an untouched "Untitled Project"', async () => {
    const { store } = setup(), p = await store.create();
    expect(await store.setGeneratedTitle(p.id, '  Beach day  ')).toBe(true);
    expect((await store.read(p.id))?.record).toMatchObject({ title: 'Beach day', title_source: 'generated' });
    expect(await store.setGeneratedTitle(p.id, 'Second try')).toBe(false); // already retitled
    expect((await store.read(p.id))?.record.title).toBe('Beach day');
  });
  it('setGeneratedTitle never retitles a renamed project, an empty title, or a missing project', async () => {
    const { store } = setup(), renamed = await store.create(); await store.renameProject(renamed.id, 'Mine');
    expect(await store.setGeneratedTitle(renamed.id, 'Generated')).toBe(false); expect((await store.read(renamed.id))?.record.title).toBe('Mine');
    const named = await store.create('Given'); expect(await store.setGeneratedTitle(named.id, 'Generated')).toBe(false);
    const fresh = await store.create(); expect(await store.setGeneratedTitle(fresh.id, '   ')).toBe(false); expect((await store.read(fresh.id))?.record.title).toBe('Untitled Project');
    expect(await store.setGeneratedTitle('missing', 'Generated')).toBe(false);
  });
  it('setGeneratedTitle treats an absent title_source on "Untitled Project" as default', async () => {
    const { store } = setup(), p = await store.create(); const { title_source: _drop, ...bare } = p; await store.putRow('projects', bare);
    expect(await store.setGeneratedTitle(p.id, 'Beach day')).toBe(true);
  });
  it('upgrade from a v2 database: "Untitled Project" → default, any other title → user', async () => {
    const name = crypto.randomUUID(), now = '2026-10-30T00:00:00.000Z';
    const v2 = ['projects', 'documents', 'assets', 'folders', 'links', 'cleanup', 'thumbnails', 'waveforms', 'preparations', 'references', 'dirs', 'settings'];
    const base = { project_type: 'editing', processing_status: 'ready', template_id: null, style_id: null, is_demo: false, created_at: now, updated_at: now, last_accessed_at: now };
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 2);
      r.onupgradeneeded = () => {
        for (const n of v2) r.result.createObjectStore(n, { keyPath: n === 'documents' ? 'projectId' : 'id' });
        const projects = r.transaction!.objectStore('projects');
        projects.put({ id: 'p-default', title: 'Untitled Project', ...base }); projects.put({ id: 'p-user', title: 'My film', ...base });
      };
      r.onsuccess = () => { r.result.close(); resolve(); };
      r.onerror = () => reject(r.error);
    });
    const store = new ProjectStore(name, () => tick++, setup().media); opened.push(store);
    const rows = Object.fromEntries((await store.list()).map(p => [p.id, p]));
    expect(rows['p-default']).toMatchObject({ title: 'Untitled Project', title_source: 'default' });
    expect(rows['p-user']).toMatchObject({ title: 'My film', title_source: 'user' });
    expect(await databaseStores(name)).toEqual(expect.arrayContaining(['transcripts', 'analyses', 'rhythms', 'search_index']));
    expect(await store.setGeneratedTitle('p-default', 'Generated')).toBe(true); expect(await store.setGeneratedTitle('p-user', 'Generated')).toBe(false);
  });
  it('the upgrade keeps an existing title_source', async () => {
    const name = crypto.randomUUID(), now = '2026-10-30T00:00:00.000Z';
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 2);
      r.onupgradeneeded = () => {
        for (const n of ['projects', 'documents', 'assets', 'folders', 'links', 'cleanup', 'thumbnails', 'waveforms', 'preparations', 'references', 'dirs', 'settings']) r.result.createObjectStore(n, { keyPath: n === 'documents' ? 'projectId' : 'id' });
        r.transaction!.objectStore('projects').put({ id: 'p', title: 'Untitled Project', project_type: 'editing', processing_status: 'ready', template_id: null, style_id: null, is_demo: false, created_at: now, updated_at: now, last_accessed_at: now, title_source: 'user' });
      };
      r.onsuccess = () => { r.result.close(); resolve(); };
      r.onerror = () => reject(r.error);
    });
    const store = new ProjectStore(name, () => tick++, setup().media); opened.push(store);
    expect((await store.list())[0] as ProjectRecord).toMatchObject({ title_source: 'user' });
  });
});
