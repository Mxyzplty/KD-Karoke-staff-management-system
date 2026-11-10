// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption-source cleanup (coordinator Q3, database.ts removeAssets): when a source asset is deleted, the same transaction
// removes the source item AND every caption LINKED to it; a DETACHED caption stays, a layout item stays (T07's gap), and a
// caption of another, surviving source stays. Through the real ProjectStore.deleteAssets (fake-indexeddb), the real IDB
// transaction and the real rule at database.ts — the shape it keys on is top-level captionSourceItemId + metadata.captionMode.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import { emptyDocument } from '../apps/web/src/store/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';

const opened: ProjectStore[] = [];
function setup(clock = () => Date.now(), name: string = crypto.randomUUID()) {
  const bytes = new Map<string, Blob>();
  const media: MediaStore = {
    write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!),
    remove: vi.fn(async (kind, id) => { if (kind === 'asset') bytes.delete(id); }),
  };
  const store = new ProjectStore(name, clock, media); opened.push(store); return { store };
}
afterEach(async () => { vi.restoreAllMocks(); for (const store of opened.splice(0)) await store.close(); });
const file = (name: string, type = 'video/mp4') => new File(['synthetic bytes'], name, { type });

describe('T09 caption-source cleanup on asset deletion', () => {
  it('removes the source item and its linked captions; keeps a detached caption, a layout item, and another source’s caption', async () => {
    const { store } = setup(), p = await store.create();
    const del = await store.upload(file('del.mp4'));                                 // the asset to delete
    const keep = await store.upload(file('keep.mp4'));                               // a surviving source asset
    const doc: ProjectDocument = { ...emptyDocument(),
      tracks: [{ id: 'v1', kind: 'video', name: 'V1' }, { id: 'c1', kind: 'caption', name: 'C1' }],
      layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'c1' }],
      items: [
        { id: 'src', type: 'video', trackId: 'v1', display: { from: 0, to: 900 }, metadata: { assetId: del.id } },
        { id: 'other', type: 'video', trackId: 'v1', display: { from: 900, to: 1800 }, metadata: { assetId: keep.id } },
        { id: 'linked', type: 'caption', trackId: 'c1', display: { from: 0, to: 450 }, captionSourceItemId: 'src', metadata: { captionMode: 'linked' } },
        { id: 'detached', type: 'caption', trackId: 'c1', display: { from: 450, to: 900 }, captionSourceItemId: 'src', metadata: { captionMode: 'detached' } },
        { id: 'layout', type: 'layout', trackId: 'v1', display: { from: 0, to: 900 }, details: { cells: [{ id: 'cell', source: { assetId: del.id } }] } },
        { id: 'elsewhere', type: 'caption', trackId: 'c1', display: { from: 900, to: 1350 }, captionSourceItemId: 'other', metadata: { captionMode: 'linked' } },
      ],
    } as ProjectDocument;
    await store.save(p.id, doc, 0);
    await store.deleteAssets([del.id]);

    const after = (await store.read(p.id))!.document;
    expect(after.items.map(i => i.id).sort()).toEqual(['detached', 'elsewhere', 'layout', 'other']);  // src + linked gone; the rest stay
    expect(after.rev).toBe(2);                                                       // save (1) + the delete transaction (2)
    expect(after.items.find(i => i.id === 'detached')?.metadata?.captionMode).toBe('detached');
    expect(after.items.find(i => i.id === 'elsewhere')?.captionSourceItemId).toBe('other');
  });

  it('a linked caption whose source is NOT deleted stays; deleting its source then removes it', async () => {
    const { store } = setup(), p = await store.create();
    const a = await store.upload(file('a.mp4')), b = await store.upload(file('b.mp4'));
    const doc: ProjectDocument = { ...emptyDocument(),
      tracks: [{ id: 'v1', kind: 'video', name: 'V1' }, { id: 'c1', kind: 'caption', name: 'C1' }],
      layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'c1' }],
      items: [
        { id: 'sa', type: 'video', trackId: 'v1', display: { from: 0, to: 900 }, metadata: { assetId: a.id } },
        { id: 'sb', type: 'video', trackId: 'v1', display: { from: 900, to: 1800 }, metadata: { assetId: b.id } },
        { id: 'ca', type: 'caption', trackId: 'c1', display: { from: 0, to: 450 }, captionSourceItemId: 'sa', metadata: { captionMode: 'linked' } },
      ],
    } as ProjectDocument;
    await store.save(p.id, doc, 0);
    await store.deleteAssets([b.id]);                                                // unrelated source removed
    expect((await store.read(p.id))!.document.items.map(i => i.id).sort()).toEqual(['ca', 'sa']);  // caption of sa untouched
    await store.deleteAssets([a.id]);                                                // now its own source
    expect((await store.read(p.id))!.document.items.map(i => i.id)).toEqual([]);     // ca goes with sa
  });
});
