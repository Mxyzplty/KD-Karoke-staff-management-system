// SPDX-License-Identifier: AGPL-3.0-only
// T22 / D93 + D100: the chip's explicit tab binding is authoritative; the copied defaults key is repaired on open.
// Native ProjectStore on fake-indexeddb and native AutosaveSession, following t17-checkpoints; media bytes alone are fake.
// D108: a loaded binding to deleted B still wins over an existing A named only by the document's defaults.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { StoreName } from '../apps/web/src/store/database';
import { AutosaveSession } from '../apps/web/src/store/autosave';
import { emptyDocument } from '../apps/web/src/store/model';
import type { ProjectDocument, ProjectRecord, RecordData } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import type { Template, TemplateDefaults } from '../apps/web/src/templates/model';
import { bindTemplate, repairDefaults, setProjectLearning } from '../apps/web/src/templates/binding';
import { deleteTemplate, findTemplate, projectTemplate, removeFromMyTemplates, saveProjectTemplate, saveTemplate, updateTemplate } from '../apps/web/src/templates/library';
import { saveAsCopy } from '../apps/web/src/versions/checkpoints';
import type { TabBinding } from '../apps/web/src/versions/checkpoints';

const NOW = new Date('2026-11-12T07:00:00.000Z'), LATER = new Date('2026-11-12T07:00:01.000Z'), opened: ProjectStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of opened.splice(0)) await store.close(); });
function newStore() {
  const bytes = new Map<string, Blob>();
  const media: MediaStore = { write: vi.fn(async (id, blob) => { bytes.set(id, blob); }), read: vi.fn(async id => bytes.get(id)!), remove: vi.fn(async () => {}) };
  const store = new ProjectStore(crypto.randomUUID(), undefined, media); opened.push(store); return store;
}
const prop = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
const DEFAULTS_A: TemplateDefaults = { templateId: 'copy-template-a', epoch: 1, captionsFont: 'Roboto-Regular', titlesFont: 'Sora-Regular', accentFont: 'Roboto-Bold', palette: [{ name: 'Tab ink', hex: '#123456' }] };
const DEFAULTS_B: TemplateDefaults = { templateId: 'copy-template-b', epoch: 2, captionsFont: 'Manrope-Regular', titlesFont: 'Roboto-Bold', accentFont: 'InstrumentSerif-Regular', palette: [{ name: 'Other tab', hex: '#ABCDEF' }] };
function document(defaults?: TemplateDefaults): ProjectDocument {
  const doc: ProjectDocument = { ...emptyDocument(), rev: 4, duration: 4000, size: { width: 640, height: 360 },
    tracks: [{ id: 'O1', name: 'O1', kind: 'overlay', hidden: false, locked: false, muted: false, solo: false, volume: 1 }], layerOrder: [{ type: 'track', id: 'O1' }],
    items: [{ id: 'title', type: 'text', trackId: 'O1', display: { from: 0, to: 4000 }, details: { text: 'Stored wording', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' },
      properties: { fontSize: prop(48), color: prop('#123456') } }], markers: [{ id: 'stored-marker', timeMs: 500 }] };
  if (defaults) doc.templateDefaults = structuredClone(defaults);
  return doc;
}
function template(id = DEFAULTS_A.templateId): Template {
  const values = id === DEFAULTS_A.templateId ? DEFAULTS_A : DEFAULTS_B;
  return { id, name: id === DEFAULTS_A.templateId ? 'Template A' : 'Template B', family: 'Personal', author: 'You',
    defaults: { captionsFont: values.captionsFont, titlesFont: values.titlesFont, accentFont: values.accentFont }, palette: structuredClone(values.palette),
    examples: [], assets: { fonts: [{ name: 'Roboto', ref: 'font:Roboto' }], audio: [], images: [] }, presetIds: [], guidance: '', learning: false, preferences: '', version: 1, savedAt: NOW.toISOString() };
}
async function open(doc = document()) {
  const store = newStore(), record = await store.create('Source project', doc), loaded = (await store.read(record.id))!;
  const session = new AutosaveSession(store, record.id, loaded.document); return { store, record, session, id: record.id };
}
const loadedBinding = (record: ProjectRecord): TabBinding => ({ id: record.template_id, epoch: record.template_epoch ?? 0 });
function boundRecord(record: ProjectRecord, id: string, epoch: number) {
  expect(record).toMatchObject({ template_id: id, template_epoch: epoch }); expect(record).not.toHaveProperty('template_request'); expect(record).not.toHaveProperty('template_learning');
}

describe('D100: the tab chip supplies the binding; its document supplies only the copied defaults', () => {
  it('(a) this tab\'s own bind selects A; stale defaults are copied unchanged and repaired only when the copy opens', async () => {
    const oldKey = { ...DEFAULTS_B, epoch: 1 }, t = await open(document(oldKey)); await saveTemplate(t.store, template()); await saveTemplate(t.store, template(DEFAULTS_B.templateId)); await setProjectLearning(t.store, t.id, true);
    await bindTemplate(t.store, t.id, { templateId: DEFAULTS_B.templateId, expectedEpoch: 0, requestKey: 'loaded-b' }); const recordAsLoaded = (await t.store.read(t.id))!.record;
    await bindTemplate(t.store, t.id, { templateId: DEFAULTS_A.templateId, expectedEpoch: 1, requestKey: 'this-tab-a' }); const binding: TabBinding = { id: 'copy-template-a', epoch: 2 };
    await updateTemplate(t.store, DEFAULTS_A.templateId, a => ({ ...a, defaults: { ...a.defaults, titlesFont: 'Sora-ExtraBold' }, palette: [{ name: 'Current ink', hex: '#445566' }] }), LATER);
    const asset = await t.store.upload(new File(['bytes'], 'linked.mp4', { type: 'video/mp4' })); await t.store.attach(t.id, asset.id);
    const other = (await t.store.read(t.id))!.document; await t.store.save(t.id, { ...other, fps: 12 }, other.rev); const original = (await t.store.read(t.id))!;
    const local = structuredClone(t.session.document); local.items[0].details.text = 'This tab\'s unsaved wording'; local.markers.push({ id: 'only-in-this-tab', timeMs: 1500 });
    t.session.update(local); await t.session.flush(); expect(t.session.state).toBe('conflict'); const mine = structuredClone(t.session.document);
    const row = vi.spyOn(t.store, 'row'), read = vi.spyOn(t.store, 'read'), copy = await saveAsCopy(t.session, t.store, recordAsLoaded, binding);
    expect(row.mock.calls.filter(([kind, id]) => kind === 'projects' && id === t.id)).toEqual([]); expect(read.mock.calls.filter(([id]) => id === t.id)).toEqual([]);
    const stored = (await t.store.read(copy.id))!; expect(copy.id).not.toBe(t.id); boundRecord(copy, 'copy-template-a', 2); boundRecord(stored.record, 'copy-template-a', 2);
    expect(stored.document).toEqual({ ...mine, rev: 0 }); expect(stored.document.templateDefaults).toEqual(oldKey); expect(stored.document.fps).toBe(30); expect(stored.document.rev).toBe(0);
    const currentDefaults: TemplateDefaults = { templateId: 'copy-template-a', epoch: 2, captionsFont: 'Roboto-Regular', titlesFont: 'Sora-ExtraBold', accentFont: 'Roboto-Bold', palette: [{ name: 'Current ink', hex: '#445566' }] };
    const repaired = await repairDefaults(t.store, stored.record, stored.document); expect(repaired).toEqual({ ...stored.document, templateDefaults: currentDefaults });
    const openedCopy = new AutosaveSession(t.store, copy.id, stored.document); openedCopy.update(repaired!); await openedCopy.flush(); expect(openedCopy.state).toBe('saved');
    const afterOpen = (await t.store.read(copy.id))!; expect(afterOpen.document.templateDefaults).toEqual(currentDefaults); expect(await repairDefaults(t.store, afterOpen.record, afterOpen.document)).toBeNull(); expect(await projectTemplate(t.store, copy.id)).toBeUndefined();
    expect((await t.store.projectAssets(copy.id)).map(link => link.assetId)).toEqual([asset.id]); expect(await t.store.read(t.id)).toEqual(original); expect(t.session.document).toEqual(mine);
    expect((await findTemplate(t.store, copy.template_id!))!.learning).toBe(false);
    await updateTemplate(t.store, DEFAULTS_A.templateId, a => ({ ...a, learning: true }), LATER); expect((await findTemplate(t.store, copy.template_id!))!.learning).toBe(true); expect((await t.store.read(copy.id))!.record).not.toHaveProperty('template_learning');
  });

  it('(b) a Missing template binding keeps the deleted id and the chip epoch, not the defaults epoch', async () => {
    const t = await open(document(DEFAULTS_A)); await saveTemplate(t.store, template()); await bindTemplate(t.store, t.id, { templateId: DEFAULTS_A.templateId, expectedEpoch: 0, requestKey: 'before-delete' });
    const recordAsLoaded = (await t.store.read(t.id))!.record; await bindTemplate(t.store, t.id, { templateId: DEFAULTS_A.templateId, expectedEpoch: 1, requestKey: 'this-tab-rebind' });
    const binding: TabBinding = { id: 'copy-template-a', epoch: 2 };
    await deleteTemplate(t.store, DEFAULTS_A.templateId); const original = (await t.store.read(t.id))!, mine = structuredClone(t.session.document);
    const copy = await saveAsCopy(t.session, t.store, recordAsLoaded, binding), stored = (await t.store.read(copy.id))!; boundRecord(copy, 'copy-template-a', 2); boundRecord(stored.record, 'copy-template-a', 2);
    expect(stored.document).toEqual({ ...mine, rev: 0 }); expect(await findTemplate(t.store, copy.template_id!)).toBeUndefined(); expect(await repairDefaults(t.store, stored.record, stored.document)).toBeNull(); expect(await t.store.read(t.id)).toEqual(original);
  });

  it('D108: the loaded chip names deleted B while the document names existing A; the copy keeps B and the unchanged A defaults', async () => {
    const t = await open(document(DEFAULTS_A)); await saveTemplate(t.store, template()); await saveTemplate(t.store, template(DEFAULTS_B.templateId));
    await bindTemplate(t.store, t.id, { templateId: DEFAULTS_A.templateId, expectedEpoch: 0, requestKey: 'before-loaded-b' });
    await bindTemplate(t.store, t.id, { templateId: DEFAULTS_B.templateId, expectedEpoch: 1, requestKey: 'loaded-b' }); const recordAsLoaded = (await t.store.read(t.id))!.record;
    expect(loadedBinding(recordAsLoaded)).toEqual({ id: 'copy-template-b', epoch: 2 }); await deleteTemplate(t.store, DEFAULTS_B.templateId);
    expect(await findTemplate(t.store, DEFAULTS_A.templateId)).toBeDefined(); const original = (await t.store.read(t.id))!, mine = structuredClone(t.session.document);
    const copy = await saveAsCopy(t.session, t.store, recordAsLoaded, loadedBinding(recordAsLoaded)), stored = (await t.store.read(copy.id))!;
    boundRecord(copy, 'copy-template-b', 2); boundRecord(stored.record, 'copy-template-b', 2); expect(await findTemplate(t.store, copy.template_id!)).toBeUndefined();
    expect(stored.document).toEqual({ ...mine, rev: 0 }); expect(stored.document.templateDefaults).toEqual(DEFAULTS_A); expect(await repairDefaults(t.store, stored.record, stored.document)).toBeNull(); expect(await t.store.read(t.id)).toEqual(original);
  });

  it('(c) a No template chip stays unbound even after another tab binds the stored project to B', async () => {
    const t = await open(), recordAsLoaded = structuredClone(t.record), binding = loadedBinding(recordAsLoaded); expect(binding).toEqual({ id: null, epoch: 0 });
    await setProjectLearning(t.store, t.id, false); await saveTemplate(t.store, { ...template(DEFAULTS_B.templateId), learning: true });
    await bindTemplate(t.store, t.id, { templateId: DEFAULTS_B.templateId, expectedEpoch: 0, requestKey: 'other-tab-b' }); const other = (await t.store.read(t.id))!;
    await t.store.save(t.id, { ...other.document, templateDefaults: { ...DEFAULTS_B, epoch: 1 }, fps: 12 }, other.document.rev); const original = (await t.store.read(t.id))!, mine = structuredClone(t.session.document);
    const copy = await saveAsCopy(t.session, t.store, recordAsLoaded, binding), stored = (await t.store.read(copy.id))!;
    expect(copy).toMatchObject({ template_id: null, template_learning: false }); expect(stored.record).toHaveProperty('template_learning', false); expect(stored.record.template_id).toBeNull(); expect(stored.document).toEqual({ ...mine, rev: 0 }); expect(stored.document).not.toHaveProperty('templateDefaults'); expect(await projectTemplate(t.store, copy.id)).toBeUndefined();
    expect(await t.store.read(t.id)).toEqual(original); expect(original.record).toMatchObject({ template_id: 'copy-template-b', template_epoch: 1, template_learning: false });
  });

  it('the loaded A chip remains authoritative when the tab document names A but another tab\'s stored version names B', async () => {
    const t = await open(document(DEFAULTS_A)); await saveTemplate(t.store, template()); await saveTemplate(t.store, template(DEFAULTS_B.templateId));
    await bindTemplate(t.store, t.id, { templateId: DEFAULTS_A.templateId, expectedEpoch: 0, requestKey: 'loaded-a' }); const recordAsLoaded = (await t.store.read(t.id))!.record, binding = loadedBinding(recordAsLoaded);
    expect(binding).toEqual({ id: 'copy-template-a', epoch: 1 }); await bindTemplate(t.store, t.id, { templateId: DEFAULTS_B.templateId, expectedEpoch: 1, requestKey: 'other-tab-b' });
    const other = (await t.store.read(t.id))!; await t.store.save(t.id, { ...other.document, templateDefaults: structuredClone(DEFAULTS_B), fps: 24 }, other.document.rev);
    const original = (await t.store.read(t.id))!, mine = structuredClone(t.session.document); expect(original.record).toMatchObject({ template_id: 'copy-template-b', template_epoch: 2 });
    const copy = await saveAsCopy(t.session, t.store, recordAsLoaded, binding), stored = (await t.store.read(copy.id))!; boundRecord(copy, 'copy-template-a', 1); boundRecord(stored.record, 'copy-template-a', 1);
    expect(stored.document).toEqual({ ...mine, rev: 0 }); expect(stored.document.templateDefaults).toEqual(DEFAULTS_A); expect(await repairDefaults(t.store, stored.record, stored.document)).toBeNull(); expect(await t.store.read(t.id)).toEqual(original);
  });
});

describe('D93 retained: an explicit No template binding snapshots the current Learn value, not a stale record argument', () => {
  it.each([
    { kind: 'record off', expected: false }, { kind: 'own template off, saved', expected: false }, { kind: 'own template off, removed', expected: false }, { kind: 'never set', expected: true },
  ])('$kind gives explicit template_learning=$expected on the unbound copy', async ({ kind, expected }) => {
    const t = await open(); let stale: ProjectRecord = { ...t.record, template_learning: !expected };
    if (kind === 'record off') await setProjectLearning(t.store, t.id, false);
    else if (kind.startsWith('own template')) {
      await setProjectLearning(t.store, t.id, true); const own = await saveProjectTemplate(t.store, t.id, t.session.document, NOW);
      await updateTemplate(t.store, own.id, a => ({ ...a, learning: false }), LATER); if (kind.endsWith('removed')) await removeFromMyTemplates(t.store, own.id);
      stale = { ...t.record, template_learning: true };
    }
    const before = (await t.store.read(t.id))!; if (kind === 'never set') expect(before.record).not.toHaveProperty('template_learning');
    if (kind.startsWith('own template')) { expect(before.record.template_learning).toBe(true); expect((await projectTemplate(t.store, t.id))!.learning).toBe(false); }
    const mine = structuredClone(t.session.document), copy = await saveAsCopy(t.session, t.store, stale, loadedBinding(t.record)), stored = (await t.store.read(copy.id))!;
    expect(copy).toMatchObject({ template_id: null, template_learning: expected }); expect(stored.record).toHaveProperty('template_learning', expected); expect(stored.record.template_id).toBeNull(); expect(stored.document).not.toHaveProperty('templateDefaults');
    expect(stored.document).toEqual({ ...mine, rev: 0 }); expect(await projectTemplate(t.store, copy.id)).toBeUndefined(); expect(await t.store.read(t.id)).toEqual(before);
  });

  it.each([false, true])('the copy has no own template; Save makes a second template for it (original removed=%s)', async removed => {
    const t = await open(); await setProjectLearning(t.store, t.id, true); const own = await saveProjectTemplate(t.store, t.id, t.session.document, NOW);
    await updateTemplate(t.store, own.id, a => ({ ...a, learning: false, preferences: 'The original\'s lessons stay with the original.' }), LATER); if (removed) await removeFromMyTemplates(t.store, own.id);
    const originalOwn = (await projectTemplate(t.store, t.id))!, original = (await t.store.read(t.id))!, copy = await saveAsCopy(t.session, t.store, original.record, loadedBinding(t.record)), stored = (await t.store.read(copy.id))!;
    expect(copy.template_id).toBeNull(); expect(await projectTemplate(t.store, copy.id)).toBeUndefined(); expect(await projectTemplate(t.store, t.id)).toEqual(originalOwn); expect(originalOwn.fromProject).toBe(t.id);
    const copyOwn = await saveProjectTemplate(t.store, copy.id, stored.document, LATER); expect(copyOwn.id).not.toBe(own.id); expect(copyOwn.fromProject).toBe(copy.id); expect(copyOwn.learning).toBe(false); expect(copyOwn.preferences).toBe('');
    expect(await projectTemplate(t.store, copy.id)).toEqual(copyOwn); expect(await projectTemplate(t.store, t.id)).toEqual(originalOwn); expect((await t.store.row<{ templates: Template[] }>('settings', 'templates'))!.templates).toHaveLength(2); expect((await t.store.read(copy.id))!.record.template_id).toBeNull();
  });
});

it('D93: a failed copy-record swap rejects with that error and deletes the new project', async () => {
  const t = await open(), original = (await t.store.read(t.id))!, failure = new Error('Copy record write failed.'); let rejectedId: string | undefined;
  type Row = RecordData & { id: string };
  const wrapped = new Proxy(t.store, { get(target, key) {
    if (key === 'swapRow') return async (kind: StoreName, id: string, change: (row: Row | undefined) => Row | null) => {
      if (kind === 'projects' && rejectedId === undefined) { rejectedId = id; throw failure; }
      return target.swapRow<Row>(kind, id, change);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(saveAsCopy(t.session, wrapped, original.record, loadedBinding(t.record))).rejects.toBe(failure); expect(rejectedId).toEqual(expect.any(String)); expect(rejectedId).not.toBe(t.id);
  expect((await t.store.list()).map(record => record.id)).toEqual([t.id]); expect(await t.store.read(rejectedId!)).toBeNull(); expect(await t.store.read(t.id)).toEqual(original);
});
