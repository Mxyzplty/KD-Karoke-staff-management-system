// SPDX-License-Identifier: AGPL-3.0-only
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import { emptyDocument, importProject, projectDateLabel, queryAssets, StoreError } from '../apps/web/src/store/model';
import type { Asset, ProjectDocument } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { normalise, type Json } from '../parity/normalise';
import { layerEntries, flattenLayers, trackItems, type Project } from '../parity/oracle/item';

const opened: ProjectStore[] = [];
function setup(clock = () => Date.now(), name: string = crypto.randomUUID()) {
  const bytes = new Map<string, Blob>();
  const media: MediaStore = {
    write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!),
    remove: vi.fn(async (kind, id) => { if (kind === 'asset') bytes.delete(id); }),
  };
  const store = new ProjectStore(name, clock, media); opened.push(store); return { store, media, bytes };
}
afterEach(async () => { vi.restoreAllMocks(); for (const store of opened.splice(0)) await store.close(); });
const file = (name: string, type = 'video/mp4') => new File(['synthetic bytes'], name, { type });
const full = (): ProjectDocument => ({ ...emptyDocument(), tracks: [{ id: 'v1', kind: 'video', name: 'V1' }], layerOrder: [{ type: 'track', id: 'v1' }],
  items: [{ id: 'item1', type: 'video', trackId: 'v1', display: { from: 0.123, to: 900.456 }, trim: { from: 10.25, to: 910.583 }, playbackRate: 1,
    properties: { opacity: { defaultValue: 0.9, keyframes: [{ id: 'kf1', time: 5.5, value: 0.2, easing: 'linear' }] } }, details: { custom: ['keep', 0, false, null] } }],
  markers: [{ id: 'mark1', timeMs: 100.125, label: 'A' }], userFonts: [{ family: 'Our font' }],
});

describe('T01 project persistence', () => {
  it('atomically admits one of two writers; stale save does not overwrite the winning revision', async () => {
    const { store } = setup(), second = setup(undefined, store.name).store, p = await store.create();
    const results = await Promise.allSettled([store.save(p.id, { ...emptyDocument(), fps: 24 }, 0), second.save(p.id, { ...emptyDocument(), fps: 60 }, 0)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    const winning = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<ProjectDocument>).value;
    await store.close(); expect((await second.read(p.id))?.document).toEqual(winning);
  });
  it('1,000 save/close/reopen/read cycles preserve every field and float exactly', async () => {
    const { store } = setup(), original = full(), p = await store.create('Lossless', original);
    let doc = original;
    for (let n = 1; n <= 1000; n++) {
      doc = await store.save(p.id, { ...doc, duration: 1000 + n / 7 }, n - 1);
      await store.close();
      expect((await store.read(p.id))?.document).toEqual({ ...original, duration: 1000 + n / 7, rev: n });
    }
  });
  it('uses open order and whole days since update for the five-project fixture', async () => {
    const today = Date.parse('2026-10-27T12:00:00Z'); let now = today;
    const { store } = setup(() => now), records = [];
    for (let n = 0; n < 5; n++) { now = today - n * 86400000; records.push(await store.create(`Project ${n}`)); }
    for (const n of [2, 0, 4, 1, 3]) { now = today + n + 10; await store.openProject(records[n].id); }
    // Use a strictly increasing injected access clock, independent of project age.
    for (const [i, n] of [2, 0, 4, 1, 3].entries()) { now = today + i * 1000; await store.openProject(records[n].id); }
    const projects = await store.list();
    expect(projects.map(p => p.title)).toEqual(['Project 3', 'Project 1', 'Project 4', 'Project 0', 'Project 2']);
    expect(projects.map(p => projectDateLabel(p.updated_at, today))).toEqual(['3d ago', '1d ago', '4d ago', 'Today', '2d ago']);
    now = today; await store.renameProject(records[2].id, '  Renamed  '); await store.renameProject(records[2].id, ' ');
    expect((await store.read(records[2].id))?.record).toMatchObject({ title: 'Renamed', updated_at: new Date(today).toISOString() });
  });
  it('deletes the project first and retries project-scoped cleanup after failure, preserving shared media', async () => {
    const { store, media, bytes } = setup(), p = await store.create(), asset = await store.upload(file('shared.mp4'));
    await store.attach(p.id, asset.id);
    vi.mocked(media.remove).mockRejectedValueOnce(new Error('temporarily locked'));
    await store.deleteProject(p.id);
    expect(await store.read(p.id)).toBeNull(); expect(await store.projectAssets(p.id)).toEqual([]); expect(bytes.has(asset.id)).toBe(true);
    expect(await store.retryCleanup()).toBe(0); expect(media.remove).toHaveBeenCalledWith('project', p.id);
  });
  it('maps project QuotaExceededError to STORAGE_QUOTA and rolls back atomically', async () => {
    const { store } = setup(), p = await store.create(); const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'documents') throw new DOMException('disk full', 'QuotaExceededError');
      return put.apply(this, args);
    });
    await expect(store.save(p.id, { ...emptyDocument(), fps: 60 }, 0)).rejects.toMatchObject({ code: 'STORAGE_QUOTA', category: 'system_error', recovery: 'user_fixable' });
    expect((await store.read(p.id))?.document).toEqual(emptyDocument());
  });
  it('maps media quota failure to STORAGE_QUOTA without creating an asset record', async () => {
    const { store, media } = setup(); vi.mocked(media.write).mockRejectedValue(new DOMException('disk full', 'QuotaExceededError'));
    await expect(store.upload(file('no-space.mp4'))).rejects.toMatchObject({ code: 'STORAGE_QUOTA', category: 'system_error' });
    expect((await store.library()).assets).toEqual([]);
  });
});
describe('T01 library', () => {
  it('another tab draining cleanup cannot delete an in-flight OPFS upload', async () => {
    const { store, media, bytes } = setup(); let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(media.write).mockImplementationOnce(async (id, file) => { bytes.set(id, file); await pending; });
    const second = new ProjectStore(store.name, undefined, media); opened.push(second);
    const uploading = store.upload(file('pending.mp4'));
    await vi.waitFor(() => expect(media.write).toHaveBeenCalledOnce());
    expect(await second.retryCleanup()).toBe(0); expect(media.remove).not.toHaveBeenCalled();
    finish(); const asset = await uploading; expect(bytes.has(asset.id)).toBe(true);
    expect((await second.library()).assets.map(a => a.id)).toEqual([asset.id]);
  });
  it('persists nested folders, move, rename, both folder deletion modes, batch deletion, usage and stable agent ids after reopen', async () => {
    const { store } = setup(), p = await store.create(), q = await store.create();
    const outer = await store.createFolder('Outer'), inner = await store.createFolder('Inner', outer.id), child = await store.createFolder('Child', inner.id);
    const a = await store.upload(file('a.mp4'), inner.id), b = await store.upload(file('b.mp4'), child.id), image = await store.upload(file('still.png', 'image/png'));
    expect((await store.attach(p.id, a.id)).agent_id).toBe('video_1');
    expect((await store.attach(p.id, b.id)).agent_id).toBe('video_2');
    expect((await store.attach(p.id, image.id)).agent_id).toBe('image_1');
    await store.attach(q.id, a.id); expect(await store.usage([a.id, b.id])).toBe(2);
    await store.detach(p.id, a.id); expect((await store.attach(p.id, a.id)).agent_id).toBe('video_1');
    await store.rename('asset', a.id, '  renamed.mp4 '); await store.rename('folder', child.id, 'Renamed child');
    await store.deleteFolder(inner.id, false); await store.close();
    let snapshot = await store.library();
    expect(snapshot.folders.find(f => f.id === child.id)).toMatchObject({ name: 'Renamed child', parentId: outer.id });
    expect(snapshot.assets.find(x => x.id === a.id)).toMatchObject({ name: 'renamed.mp4', folderId: outer.id });
    await store.moveAssets([a.id, image.id], child.id); await store.close();
    expect((await store.library()).assets.every(x => x.folderId === child.id)).toBe(true);
    await store.deleteFolder(child.id, true); await store.close(); snapshot = await store.library();
    expect(snapshot.assets).toEqual([]); expect(snapshot.links.every(l => l.deleted_at !== null)).toBe(true); expect(snapshot.folders).toEqual([outer]);
    const c = await store.upload(file('c.mp4')), d = await store.upload(file('d.mp4'));
    expect((await store.attach(p.id, c.id)).agent_id).toBe('video_3');
    await store.deleteAssets([c.id, d.id]); await store.close(); expect((await store.library()).assets).toEqual([]);
  });
  it('asset deletion removes timeline items and dependent transitions, increments rev, and invalidates stale editors', async () => {
    const { store } = setup(), p = await store.create(), a = await store.upload(file('a.mp4'));
    const doc = full(); doc.items[0].metadata = { assetId: a.id }; doc.transitions = [{ id: 't1', fromId: 'item1', toId: 'item2' }];
    // T07 still owns layout cell cleanup (that gap remains). The caption here is a DETACHED caption of item1 (the deleted
    // source): it stays by rule, the same real shape database.ts keys on (top-level captionSourceItemId + metadata.captionMode).
    // A LINKED caption of a deleted source IS removed — covered in tests/t09-deletion.test.ts, which exercises that branch.
    const nested = [
      { id: 'layout', type: 'layout', trackId: 'v1', display: { from: 0, to: 900 }, details: { cells: [{ id: 'cell', source: { assetId: a.id } }] } },
      { id: 'caption', type: 'caption', trackId: 'v1', display: { from: 0, to: 900 }, captionSourceItemId: 'item1', metadata: { captionMode: 'detached' } },
    ];
    doc.items.push(...nested);
    await store.save(p.id, doc, 0); await store.deleteAssets([a.id]);
    expect((await store.read(p.id))?.document).toMatchObject({ rev: 2, items: nested, transitions: [] });
    expect((await store.read(p.id))?.document.items).toEqual(nested);
    await expect(store.save(p.id, doc, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('recorded nulls sort last in either direction; ties use newest upload; filters apply recorded date and place', () => {
    const asset = (id: string, created: string, recorded: string | null): Asset => ({ id, name: id, type: 'video', sizeBytes: 1, mimeType: 'video/mp4', folderId: null, created_at: created, recorded_at: recorded, location: 'Singapore', durationMs: null });
    const assets = [asset('null-old', '2026-01-01', null), asset('late', '2026-01-02', '2026-04-02'), asset('early-old', '2026-01-03', '2026-04-01'), asset('early-new', '2026-01-04', '2026-04-01'), asset('null-new', '2026-01-05', null)];
    expect(queryAssets(assets, { folderId: null, sort: 'recorded', direction: 'ASC' }).map(a => a.id)).toEqual(['early-new', 'early-old', 'late', 'null-new', 'null-old']);
    expect(queryAssets(assets, { folderId: null, sort: 'recorded', direction: 'DESC' }).map(a => a.id)).toEqual(['late', 'early-new', 'early-old', 'null-new', 'null-old']);
    expect(queryAssets(assets, { folderId: null, from: '2026-04-01', to: '2026-04-01', location: 'SING' }).map(a => a.id)).toEqual(['early-new', 'early-old']);
  });
});
describe('T01 import contract', () => {
  it('schema 4 import retains all stored fields and is cloned', () => {
    const original = full(), imported = importProject(original); expect(imported).toEqual(original);
    imported.items[0].details.custom[0] = 'changed'; expect(original.items[0].details.custom[0]).toBe('keep');
  });
  it('refuses unspecified schema 1–3 migrations and invalid data', () => {
    for (const schemaVersion of [1, 2, 3, 5]) expect(() => importProject({ ...emptyDocument(), schemaVersion })).toThrow(/migrations are not specified/);
    expect(() => importProject({ schemaVersion: 4 })).toThrow(StoreError);
  });
  it('converts legacy maps with the documented missing-track repair; passes normaliser and stored oracle readers', () => {
    const original = full();
    const converted = importProject({ ...original, schemaVersion: undefined, items: undefined, transitions: undefined,
      tracks: [{ id: 'c', type: 'caption', items: [], order: 2 }, { id: 'v1', type: 'video', items: ['item1'], order: 0 }, { id: 'a', type: 'audio', items: [], order: 1 }],
      trackItemIds: ['item1'], trackItemsMap: { item1: { ...original.items[0], trackId: undefined } }, transitionsMap: {}, userFonts: [{ family: 'Our font' }],
    });
    expect(converted.tracks).toEqual([{ id: 'c', kind: 'caption' }, { id: 'v1', kind: 'video' }, { id: 'a', kind: 'audio' }]);
    expect(converted.layerOrder.map(e => e.id)).toEqual(['a', 'v1', 'c']); expect(converted.items[0].id).toBe('item1');
    expect(converted.userFonts).toEqual(original.userFonts); expect(converted.groups).toEqual({});
    expect(() => normalise(JSON.parse(JSON.stringify(converted)) as Json)).not.toThrow();
    const oracleProject = converted as unknown as Project;
    expect(layerEntries(oracleProject)).toEqual(converted.layerOrder);
    expect(flattenLayers(oracleProject).map(l => l.track.id)).toEqual(['a', 'v1', 'c']);
    expect(trackItems(oracleProject, 'v1').map(i => i.id)).toEqual(['item1']);
  });
});
