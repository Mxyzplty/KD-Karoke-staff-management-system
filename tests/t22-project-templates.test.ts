// SPDX-License-Identifier: AGPL-3.0-only
// RC 6.5 / D85 / D86 / D92 / D99: own templates, saved marks, hidden first lessons and one authoritative Learn value.
// Oracles are the written rules and literal authored project data. Native stores; no mocks of template functions.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import type { StoreName } from '../apps/web/src/store/database';
import type { ProjectDocument, ProjectRecord, RecordData } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import type { Template } from '../apps/web/src/templates/model';
import { templateProblem } from '../apps/web/src/templates/model';
import { DEFAULT_TEMPLATE } from '../apps/web/src/templates/default';
import { bindTemplate, projectLearning, setProjectLearning, writeDefaults } from '../apps/web/src/templates/binding';
import { deleteTemplate, exportTemplate, findTemplate, importTemplate, lessonTemplate, listTemplates, projectTemplate, removeFromMyTemplates,
  saveProjectTemplate, saveTemplate, saveToMyTemplates, updateTemplate } from '../apps/web/src/templates/library';
import { build, mkItem, mkTrack } from './t03-fixtures';

const NOW = new Date('2026-11-12T05:00:00.000Z'), LATER = new Date('2026-11-12T05:00:01.000Z'), opened: ProjectStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of opened.splice(0)) await store.close(); });
function setup(name = crypto.randomUUID()) {
  let tick = NOW.getTime(); const files = new Map<string, Blob>();
  const media: MediaStore = { write: vi.fn(async (id, blob) => { files.set(id, blob); }), read: vi.fn(async id => { const blob = files.get(id); if (!blob) throw new Error(`Missing ${id}`); return blob; }), remove: vi.fn(async (_kind, id) => { files.delete(id); }) };
  const store = new ProjectStore(name, () => tick++, media); opened.push(store); return store;
}
const prop = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
function authored(): ProjectDocument {
  return build({ tracks: [mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay'), mkTrack('C1', 'caption'), mkTrack('V1', 'video')], items: [
    mkItem('title', 'O1', 0, 4000, { type: 'text', details: { text: 'Project title', fontFamily: 'Sora-Regular', fontFamilyDisplay: 'Sora' }, properties: { fontSize: prop(90), color: prop('#112233') } }),
    mkItem('accent', 'O2', 0, 4000, { type: 'text', details: { text: 'Accent', fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' }, properties: { fontSize: prop(24), color: prop('#abcdef') } }),
    mkItem('caption', 'C1', 0, 4000, { type: 'caption', details: { text: 'Caption', words: [], fontFamily: 'Manrope-Regular', fontFamilyDisplay: 'Manrope' }, properties: { fontSize: prop(16), color: prop('#FF0000') } }),
    mkItem('shape', 'O2', 0, 4000, { type: 'shape', properties: { fillColor: prop('#112233') } }),
    mkItem('footage', 'V1', 0, 4000, { type: 'image', details: { name: 'Never automatically selected' } }),
  ] });
}
const DEFAULTS = { captionsFont: 'Manrope-Regular', titlesFont: 'Sora-Regular', accentFont: 'Roboto-Bold' };
const PALETTE = [{ name: 'Colour 1', hex: '#112233' }, { name: 'Colour 2', hex: '#ABCDEF' }];
const ownFixture = (extra: Partial<Template> = {}): Template => ({ id: 'personal-template', name: 'Personal template', family: 'Personal', author: 'You',
  defaults: { captionsFont: 'Roboto-Regular', titlesFont: 'Roboto-Bold', accentFont: 'Roboto-Regular' }, palette: [{ name: 'Ink', hex: '#123456' }], examples: [],
  assets: { fonts: [{ name: 'Roboto', ref: 'font:Roboto' }], audio: [], images: [] }, presetIds: [], guidance: '', preferences: 'A preference to keep.', learning: true, version: 1, savedAt: NOW.toISOString(), ...extra });
type Row = RecordData & { id: string };
// A wrapper of the public store boundary, not a source hook: retain real transactions and observe completed row swaps.
function observeSwaps(store: ProjectStore, after: (kind: StoreName, id: string, next: Row | null) => void | Promise<void>): ProjectStore {
  return new Proxy(store, { get(target, key) {
    if (key === 'swapRow') return async (kind: StoreName, id: string, change: (row: Row | undefined) => Row | null) => {
      const next = await target.swapRow<Row>(kind, id, change); await after(kind, id, next); return next;
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe('RC 6.5: first save, repeated save, Remove, and Delete are different operations', () => {
  it('first save makes one named, listed own template from the project fonts/colours, without binding or changing the project', async () => {
    const store = setup(), project = await store.create('Project colours', authored()), before = (await store.read(project.id))!;
    const made = await saveProjectTemplate(store, project.id, before.document, NOW);
    expect(made).toMatchObject({ name: 'Project colours template', fromProject: project.id, family: 'Personal', defaults: DEFAULTS, palette: PALETTE, guidance: '', preferences: '', learning: true });
    expect(made.saved).not.toBe(false); expect(made.examples).toEqual([]); expect(made.assets.audio).toEqual([]); expect(made.assets.images).toEqual([]);
    expect(made.assets.fonts).toEqual([{ name: 'Manrope', ref: 'font:Manrope' }, { name: 'Sora', ref: 'font:Sora' }, { name: 'Roboto', ref: 'font:Roboto' }]);
    expect((await listTemplates(store)).mine).toEqual([made]); expect((await store.row<{ templates: Template[] }>('settings', 'templates'))!.templates).toHaveLength(1);
    expect(await projectTemplate(store, project.id)).toEqual(made); expect(await store.read(project.id)).toEqual(before); expect(before.record.template_id).toBeNull();
  });
  it('repeat save keeps one id and reads neither the project row nor its document again', async () => {
    const store = setup(), project = await store.create('Repeat', authored()), doc = (await store.read(project.id))!.document, first = await saveProjectTemplate(store, project.id, doc, NOW);
    const changed = structuredClone(doc); changed.items[0].details.fontFamily = 'Roboto-Bold'; changed.items[0].properties.color = prop('#FF00FF');
    const row = vi.spyOn(store, 'row'), read = vi.spyOn(store, 'read'), again = await saveProjectTemplate(store, project.id, changed, LATER);
    expect(row.mock.calls.filter(([kind]) => kind === 'projects')).toEqual([]); expect(read).not.toHaveBeenCalled(); expect(again).toEqual(first);
    expect((await listTemplates(store)).mine).toEqual([first]); expect((await store.row<{ templates: Template[] }>('settings', 'templates'))!.templates).toHaveLength(1);
  });
  it('Remove then Save restores the same id and edited preferences, ignoring changed project fonts and title', async () => {
    const store = setup(), project = await store.create('Original name', authored()), original = (await store.read(project.id))!, first = await saveProjectTemplate(store, project.id, original.document, NOW);
    await removeFromMyTemplates(store, first.id);
    await updateTemplate(store, first.id, t => ({ ...t, preferences: 'Edited while removed.', learning: false, defaults: { ...t.defaults, titlesFont: 'Roboto-Bold' } }), LATER);
    const hidden = (await findTemplate(store, first.id))!, changed = structuredClone(original.document); changed.items[0].details.fontFamily = 'InstrumentSerif-Regular'; changed.items[0].properties.color = prop('#FF00FF');
    const current = await store.save(project.id, changed, original.document.rev); await store.renameProject(project.id, 'A different project title');
    const row = vi.spyOn(store, 'row'), read = vi.spyOn(store, 'read'), restored = await saveProjectTemplate(store, project.id, current, LATER);
    expect(row.mock.calls.filter(([kind]) => kind === 'projects')).toEqual([]); expect(read).not.toHaveBeenCalled();
    const { saved: _, ...kept } = hidden; expect(restored).toEqual(kept); expect(restored.id).toBe(first.id); expect(restored.name).toBe('Original name template');
    expect(restored.preferences).toBe('Edited while removed.'); expect(restored.defaults.titlesFont).toBe('Roboto-Bold'); expect((await listTemplates(store)).mine).toEqual([restored]);
  });
  it('a removed own template disappears from mine but findTemplate and projectTemplate still find all its preferences', async () => {
    const store = setup(), project = await store.create('Hidden own', authored()), made = await saveProjectTemplate(store, project.id, (await store.read(project.id))!.document, NOW);
    await updateTemplate(store, made.id, t => ({ ...t, preferences: 'Keep me.' }), LATER); const before = (await findTemplate(store, made.id))!; await removeFromMyTemplates(store, made.id);
    const expected = { ...before, saved: false }; expect((await listTemplates(store)).mine).toEqual([]); expect(await findTemplate(store, made.id)).toEqual(expected); expect(await projectTemplate(store, project.id)).toEqual(expected);
  });
  it('a second project bound before Remove keeps its binding and defaults and can still look up the template', async () => {
    const store = setup(), owner = await store.create('Owner', authored()), made = await saveProjectTemplate(store, owner.id, (await store.read(owner.id))!.document, NOW), bound = await store.create('Uses own');
    await bindTemplate(store, bound.id, { templateId: made.id, expectedEpoch: 0, requestKey: 'bound-before-remove' }); const current = (await store.read(bound.id))!;
    await store.save(bound.id, writeDefaults(current.document, made, 1), current.document.rev); const before = await store.read(bound.id);
    await removeFromMyTemplates(store, made.id); expect(await store.read(bound.id)).toEqual(before); expect((await findTemplate(store, made.id))!.name).toBe('Owner template'); expect((await findTemplate(store, made.id))!.saved).toBe(false);
  });
  it('Delete removes the old lookup; a later Save creates a new id while another project keeps its old binding', async () => {
    const store = setup(), owner = await store.create('Delete and remake', authored()), doc = (await store.read(owner.id))!.document, first = await saveProjectTemplate(store, owner.id, doc, NOW), bound = await store.create('Old binding');
    await bindTemplate(store, bound.id, { templateId: first.id, expectedEpoch: 0, requestKey: 'old-binding' }); const beforeBound = await store.read(bound.id);
    await deleteTemplate(store, first.id); expect(await findTemplate(store, first.id)).toBeUndefined(); expect(await projectTemplate(store, owner.id)).toBeUndefined(); expect(await store.read(bound.id)).toEqual(beforeBound);
    // Assigned identity boundary: a later millisecond, as on the Save-as-template path; not a same-clock claim.
    const second = await saveProjectTemplate(store, owner.id, doc, LATER); expect(second.id).not.toBe(first.id); expect(second.fromProject).toBe(owner.id); expect((await listTemplates(store)).mine).toEqual([second]);
    expect((await store.read(bound.id))!.record.template_id).toBe(first.id); expect((await store.read(owner.id))!.record.template_id).toBeNull();
  });
  it('a generic user template can be removed and saved again without losing its id or preferences', async () => {
    const store = setup(), t = ownFixture(); await saveTemplate(store, t); await removeFromMyTemplates(store, t.id);
    expect(await findTemplate(store, t.id)).toEqual({ ...t, saved: false }); expect((await listTemplates(store)).mine).toEqual([]);
    await saveToMyTemplates(store, t.id); expect(await findTemplate(store, t.id)).toEqual(t); expect((await listTemplates(store)).mine).toEqual([t]);
  });
  it('removing a saved built-in keeps it under Built-in templates and keeps its personal copy', async () => {
    const store = setup(); await saveToMyTemplates(store, 'daylight'); const personal = await updateTemplate(store, 'daylight', t => ({ ...t, preferences: 'Keep this personal copy.', learning: false }), NOW);
    await removeFromMyTemplates(store, 'daylight'); expect((await listTemplates(store)).mine).toEqual([]); expect((await listTemplates(store)).builtIn).toContainEqual(personal); expect(await findTemplate(store, 'daylight')).toEqual(personal);
    await saveToMyTemplates(store, 'daylight'); expect((await listTemplates(store)).mine).toEqual([personal]); expect(DEFAULT_TEMPLATE.learning).toBe(true);
  });
  it('an own template whose source project was deleted still lists/opens; Delete does not recreate or write a project', async () => {
    const store = setup(), project = await store.create('Gone project', authored()), t = await saveProjectTemplate(store, project.id, (await store.read(project.id))!.document, NOW); await store.deleteProject(project.id);
    expect((await listTemplates(store)).mine).toEqual([t]); expect(await findTemplate(store, t.id)).toEqual(t); expect(await projectTemplate(store, project.id)).toEqual(t);
    const writes: Row[] = [], wrapped = observeSwaps(store, (kind, _id, next) => { if (kind === 'projects' && next) writes.push(next); });
    await expect(deleteTemplate(wrapped, t.id)).resolves.toBeUndefined(); expect(writes).toEqual([]); expect(await store.row('projects', project.id)).toBeUndefined(); expect(await findTemplate(store, t.id)).toBeUndefined(); expect((await listTemplates(store)).mine).toEqual([]);
  });
});

describe('D92: projectLearning has one source, even when the own template is removed', () => {
  it.each([{ name: 'absent', value: undefined, expected: true }, { name: 'true', value: true, expected: true }, { name: 'false', value: false, expected: false }])('record only: $name', ({ value, expected }) => {
    const record = (value === undefined ? {} : { template_learning: value }) as ProjectRecord; expect(projectLearning(record)).toBe(expected);
  });
  it.each([
    { record: true, own: false, saved: undefined }, { record: true, own: false, saved: true }, { record: true, own: false, saved: false },
    { record: false, own: true, saved: undefined }, { record: false, own: true, saved: true }, { record: false, own: true, saved: false },
  ])('own learning $own wins over record $record with saved=$saved', ({ record, own, saved }) => {
    const template = ownFixture({ fromProject: 'owner', learning: own, ...(saved === undefined ? {} : { saved }) }); expect(projectLearning({ template_learning: record } as ProjectRecord, template)).toBe(own);
  });
  it.each([false, true])('first Save copies learning=%s without changing the project record', async on => {
    const store = setup(), project = await store.create('Copy Learn', authored()); await setProjectLearning(store, project.id, on); const before = (await store.read(project.id))!;
    const t = await saveProjectTemplate(store, project.id, before.document, NOW); expect(t.learning).toBe(on); expect(await store.read(project.id)).toEqual(before); expect(before.record.template_learning).toBe(on);
  });
  it.each([false, true])('pre-save switch write %s changes only the project record, not document/rev, epoch or settings history', async on => {
    const store = setup(), project = await store.create('Record Learn', authored()); await store.swapRow<ProjectRecord>('projects', project.id, r => r ? { ...r, template_epoch: 7 } : null);
    const before = (await store.read(project.id))!, settings = await store.rows('settings'); await setProjectLearning(store, project.id, on); const after = (await store.read(project.id))!;
    expect(after.record).toEqual({ ...before.record, template_learning: on }); expect(after.record.template_epoch).toBe(7); expect(after.document).toEqual(before.document); expect(after.document.rev).toBe(before.document.rev); expect(await store.rows('settings')).toEqual(settings);
  });
  it.each([false, true])('post-save switch writes only the own template (removed=%s), and the preview value is the same', async removed => {
    const store = setup(), project = await store.create('Template Learn', authored()); await setProjectLearning(store, project.id, false); const recordBefore = (await store.read(project.id))!;
    const own = await saveProjectTemplate(store, project.id, recordBefore.document, NOW); if (removed) await removeFromMyTemplates(store, own.id);
    await setProjectLearning(store, project.id, true); const now = (await projectTemplate(store, project.id))!; expect(now.learning).toBe(true); expect(now.saved === false).toBe(removed); expect(projectLearning(recordBefore.record, now)).toBe(true); expect(await store.read(project.id)).toEqual(recordBefore);
    await updateTemplate(store, own.id, t => ({ ...t, learning: false }), LATER); expect(projectLearning(recordBefore.record, (await projectTemplate(store, project.id))!)).toBe(false);
  });
  it.each([false, true])('Delete writes the own template\'s last Learn value back before removing it (removed=%s)', async removed => {
    const store = setup(), project = await store.create('Learn survives Delete', authored()); await setProjectLearning(store, project.id, true); const before = (await store.read(project.id))!;
    const own = await saveProjectTemplate(store, project.id, before.document, NOW); await updateTemplate(store, own.id, t => ({ ...t, learning: false }), LATER); if (removed) await removeFromMyTemplates(store, own.id);
    await deleteTemplate(store, own.id); const after = (await store.read(project.id))!; expect(after.record).toEqual({ ...before.record, template_learning: false }); expect(after.document).toEqual(before.document); expect(projectLearning(after.record)).toBe(false); expect(await projectTemplate(store, project.id)).toBeUndefined();
  });
  it('Delete retries both writes when the template learning changes between project write-back and template deletion', async () => {
    const store = setup(), project = await store.create('Concurrent Learn', authored()), doc = (await store.read(project.id))!.document, own = await saveProjectTemplate(store, project.id, doc, NOW);
    const order: string[] = [], written: boolean[] = []; let changed = false;
    const wrapped = observeSwaps(store, async (kind, id, next) => {
      if (kind === 'projects' && id === project.id && next) {
        written.push(next.template_learning); order.push(`project:${next.template_learning}`); expect(await findTemplate(store, own.id)).toBeDefined();
        if (!changed) { changed = true; await updateTemplate(store, own.id, t => ({ ...t, learning: false }), LATER); order.push('changed:false'); }
      } else if (kind === 'settings' && id === 'templates') order.push(await findTemplate(store, own.id) ? 'template:kept' : 'template:deleted');
    });
    await deleteTemplate(wrapped, own.id); expect(written).toEqual([true, false]); expect(order).toEqual(['project:true', 'changed:false', 'template:kept', 'project:false', 'template:deleted']);
    expect((await store.read(project.id))!.record.template_learning).toBe(false); expect((await store.read(project.id))!.document).toEqual(doc); expect(await findTemplate(store, own.id)).toBeUndefined();
  });
  it.each([1, 2])('tab %i can save using its pre-toggle document rev after another tab writes template_learning', async editingTab => {
    const db = crypto.randomUUID(), first = setup(db), second = setup(db), project = await first.create('Two tabs', authored());
    const snapshots = [(await first.read(project.id))!, (await second.read(project.id))!]; await setProjectLearning(first, project.id, false);
    for (const store of [first, second]) { const now = (await store.read(project.id))!; expect(now.document.rev).toBe(snapshots[0].document.rev); expect(now.record.template_learning).toBe(false); }
    // Each tab is tested independently: no claim that two later, conflicting document edits share a revision.
    const store = editingTab === 1 ? first : second, before = snapshots[editingTab - 1], changed = structuredClone(before.document); changed.background = { type: 'color', value: '#123456' };
    const saved = await store.save(project.id, changed, before.document.rev); expect(saved.rev).toBe(before.document.rev + 1); expect((await store.read(project.id))!.record.template_learning).toBe(false);
  });
});

describe('D86: optional local fields are valid in storage but neither field travels in a template file', () => {
  it.each([{}, { fromProject: 'owner' }, { saved: true }, { saved: false }, { fromProject: 'owner', saved: false }])('valid optional fields %j', patch => {
    expect(templateProblem(ownFixture(patch))).toBeNull();
  });
  it.each(['', '   ', null, 42, false, {}])('fromProject=%j is not non-empty text', value => { expect(templateProblem({ ...ownFixture(), fromProject: value })).not.toBeNull(); });
  it.each(['false', 0, null, {}])('saved=%j is not a boolean', value => { expect(templateProblem({ ...ownFixture(), saved: value })).not.toBeNull(); });
  it('export strips fromProject and saved from an own template, retaining its preferences and all portable data', async () => {
    const store = setup(), project = await store.create('Portable own', authored()), own = await saveProjectTemplate(store, project.id, (await store.read(project.id))!.document, NOW);
    await updateTemplate(store, own.id, t => ({ ...t, preferences: 'Portable preference.', learning: false }), LATER); await removeFromMyTemplates(store, own.id);
    const stored = (await findTemplate(store, own.id))!, { fromProject: _p, saved: _s, ...portable } = stored, exported = await exportTemplate(store, own.id);
    expect(stored.fromProject).toBe(project.id); expect(stored.saved).toBe(false); expect(exported.file.template).toEqual(portable); expect(exported.file.template).not.toHaveProperty('fromProject'); expect(exported.file.template).not.toHaveProperty('saved'); expect(exported.file.assets).toEqual([]);
    expect(await findTemplate(store, own.id)).toEqual(stored);
  });
  it('import drops both fields even when saved=false; it lists the record and never claims the foreign project', async () => {
    const store = setup(), project = await store.create('Not the imported owner'), foreign = ownFixture({ fromProject: project.id, saved: false, learning: false });
    const { fromProject: _p, saved: _s, ...portable } = foreign, file = { format: 'cutframe-template', version: 1, template: foreign, assets: [] };
    const imported = await importTemplate(store, file); expect(imported).toEqual(portable); expect((await listTemplates(store)).mine).toEqual([portable]); expect(await projectTemplate(store, project.id)).toBeUndefined();
    await removeFromMyTemplates(store, imported.id); await importTemplate(store, file); expect((await listTemplates(store)).mine).toEqual([portable]); expect(await findTemplate(store, imported.id)).toEqual(portable); expect(await projectTemplate(store, project.id)).toBeUndefined();
  });
});

describe('D99: a first lesson makes a hidden own template, not a saved or bound project', () => {
  it.each([false, true])('lesson creation copies learning=%s into one hidden template and leaves the record/document unchanged', async on => {
    const store = setup(), project = await store.create('Hidden lessons', authored()); await setProjectLearning(store, project.id, on); const before = (await store.read(project.id))!;
    const made = await lessonTemplate(store, project.id, before.document, NOW);
    expect(made).toMatchObject({ name: 'Hidden lessons template', fromProject: project.id, defaults: DEFAULTS, palette: PALETTE, guidance: '', preferences: '', learning: on, saved: false, neverSaved: true });
    expect(made.examples).toEqual([]); expect(made.assets.audio).toEqual([]); expect(made.assets.images).toEqual([]); expect((await listTemplates(store)).mine).toEqual([]);
    expect(await projectTemplate(store, project.id)).toEqual(made); expect(await findTemplate(store, made.id)).toEqual(made); expect(await store.read(project.id)).toEqual(before); expect(before.record.template_id).toBeNull();
    const changed = structuredClone(before.document); changed.items[0].details.fontFamily = 'Roboto-Bold';
    expect(await lessonTemplate(store, project.id, changed, LATER)).toEqual(made); expect((await store.row<{ templates: Template[] }>('settings', 'templates'))!.templates).toHaveLength(1);
    expect(await store.read(project.id)).toEqual(before);
  });
  it.each([false, true])('a lesson does not remake or relabel an own template that was already saved (removed=%s)', async removed => {
    const store = setup(), project = await store.create('Already made', authored()), doc = (await store.read(project.id))!.document, made = await saveProjectTemplate(store, project.id, doc, NOW);
    await updateTemplate(store, made.id, t => ({ ...t, preferences: 'Previously saved lessons.', learning: false }), LATER); if (removed) await removeFromMyTemplates(store, made.id);
    const before = (await findTemplate(store, made.id))!, changed = structuredClone(doc); changed.items[0].details.fontFamily = 'InstrumentSerif-Regular';
    expect(await lessonTemplate(store, project.id, changed, LATER)).toEqual(before); expect(await projectTemplate(store, project.id)).toEqual(before); expect(before.saved === false).toBe(removed); expect(before).not.toHaveProperty('neverSaved');
    expect((await store.row<{ templates: Template[] }>('settings', 'templates'))!.templates).toHaveLength(1);
  });
  it('first Save after a lesson takes current project name/fonts/colours but keeps id, lessons, guidance and Learn', async () => {
    const store = setup(), project = await store.create('Before lesson', authored()); await setProjectLearning(store, project.id, true); const original = (await store.read(project.id))!;
    const hidden = await lessonTemplate(store, project.id, original.document, NOW);
    await updateTemplate(store, hidden.id, t => ({ ...t, preferences: 'Keep the first lesson.', guidance: 'Keep this learned guidance.', learning: false }), LATER);
    await store.renameProject(project.id, 'Renamed after lesson'); const changed = structuredClone(original.document);
    Object.assign(changed.items[0].details, { fontFamily: 'InstrumentSerif-Regular', fontFamilyDisplay: 'Instrument Serif' }); changed.items[0].properties.color = prop('#EEAA00');
    const current = await store.save(project.id, changed, original.document.rev), beforeClick = await store.read(project.id), row = vi.spyOn(store, 'row');
    const saved = await saveProjectTemplate(store, project.id, current, LATER); expect(row).toHaveBeenCalledWith('projects', project.id);
    expect(saved).toMatchObject({ id: hidden.id, fromProject: project.id, name: 'Renamed after lesson template', defaults: { ...DEFAULTS, titlesFont: 'InstrumentSerif-Regular' },
      palette: [{ name: 'Colour 1', hex: '#EEAA00' }, { name: 'Colour 2', hex: '#ABCDEF' }, { name: 'Colour 3', hex: '#112233' }], preferences: 'Keep the first lesson.', guidance: 'Keep this learned guidance.', learning: false });
    expect(saved).not.toHaveProperty('neverSaved'); expect(saved).not.toHaveProperty('saved'); expect((await listTemplates(store)).mine).toEqual([saved]); expect(await projectTemplate(store, project.id)).toEqual(saved); expect(await store.read(project.id)).toEqual(beforeClick);
    expect((await store.row<{ templates: Template[] }>('settings', 'templates'))!.templates).toHaveLength(1);
  });
  it('after the first Save and a Remove, another click only re-marks the template and does not refresh it from the project', async () => {
    const store = setup(), project = await store.create('One-time refresh', authored()), original = (await store.read(project.id))!;
    const hidden = await lessonTemplate(store, project.id, original.document, NOW); await updateTemplate(store, hidden.id, t => ({ ...t, preferences: 'Keep this lesson.' }), LATER);
    const firstSave = await saveProjectTemplate(store, project.id, original.document, LATER); await removeFromMyTemplates(store, firstSave.id); const removed = (await findTemplate(store, firstSave.id))!;
    expect(removed).not.toHaveProperty('neverSaved'); expect(removed.saved).toBe(false); await store.renameProject(project.id, 'Must not replace the saved name');
    const changed = structuredClone(original.document); changed.items[0].details.fontFamily = 'InstrumentSerif-Regular'; changed.items[0].properties.color = prop('#FF00FF');
    const current = await store.save(project.id, changed, original.document.rev), row = vi.spyOn(store, 'row'), read = vi.spyOn(store, 'read');
    const restored = await saveProjectTemplate(store, project.id, current, LATER); expect(row.mock.calls.filter(([kind]) => kind === 'projects')).toEqual([]); expect(read).not.toHaveBeenCalled();
    const { saved: _, ...kept } = removed; expect(restored).toEqual(kept); expect(restored.id).toBe(hidden.id); expect(restored.name).toBe('One-time refresh template'); expect(restored.defaults).toEqual(DEFAULTS); expect(restored.palette).toEqual(PALETTE); expect((await listTemplates(store)).mine).toEqual([restored]);
  });
  it('Delete of a never-saved template writes its current Learn value back before destroying it', async () => {
    const store = setup(), project = await store.create('Delete hidden lessons', authored()); await setProjectLearning(store, project.id, true); const before = (await store.read(project.id))!;
    const hidden = await lessonTemplate(store, project.id, before.document, NOW); await updateTemplate(store, hidden.id, t => ({ ...t, learning: false, preferences: 'A hidden lesson.' }), LATER);
    expect((await findTemplate(store, hidden.id))!).toMatchObject({ saved: false, neverSaved: true, learning: false }); await deleteTemplate(store, hidden.id);
    const after = (await store.read(project.id))!; expect(after.record).toEqual({ ...before.record, template_learning: false }); expect(after.document).toEqual(before.document); expect(projectLearning(after.record)).toBe(false);
    expect(await projectTemplate(store, project.id)).toBeUndefined(); expect(await findTemplate(store, hidden.id)).toBeUndefined(); expect((await listTemplates(store)).mine).toEqual([]);
  });
});

describe('D99: neverSaved is a local, true-only mark that requires saved:false', () => {
  it('neverSaved:true together with saved:false is a valid stored template', () => {
    expect(templateProblem(ownFixture({ fromProject: 'owner', saved: false, neverSaved: true }))).toBeNull();
  });
  it.each([{ label: 'absent', saved: undefined }, { label: 'true', saved: true }])('neverSaved:true with saved=$label is refused', ({ saved }) => {
    expect(templateProblem({ ...ownFixture(), neverSaved: true, ...(saved === undefined ? {} : { saved }) })).not.toBeNull();
  });
  it.each([false, null, 0, 'true', {}, []].map(neverSaved => ({ neverSaved })))('neverSaved=$neverSaved is refused even when saved:false', ({ neverSaved }) => {
    expect(templateProblem({ ...ownFixture(), saved: false, neverSaved })).not.toBeNull();
  });
  it('export drops neverSaved as well as saved/fromProject without promoting or losing the lessons', async () => {
    const store = setup(), project = await store.create('Export hidden lesson', authored()), hidden = await lessonTemplate(store, project.id, (await store.read(project.id))!.document, NOW);
    await updateTemplate(store, hidden.id, t => ({ ...t, preferences: 'Export this lesson.', guidance: 'Portable guidance.', learning: false }), LATER);
    const stored = (await findTemplate(store, hidden.id))!, { fromProject: _p, saved: _s, neverSaved: _n, ...portable } = stored, file = (await exportTemplate(store, hidden.id)).file;
    expect(stored).toMatchObject({ saved: false, neverSaved: true, fromProject: project.id }); expect(file.template).toEqual(portable); expect(file.template).not.toHaveProperty('neverSaved'); expect(file.template).not.toHaveProperty('saved'); expect(file.template).not.toHaveProperty('fromProject'); expect(file.assets).toEqual([]);
    expect(await findTemplate(store, hidden.id)).toEqual(stored); expect((await listTemplates(store)).mine).toEqual([]);
  });
  it('import drops all three local fields from a valid never-saved file and lists the imported lessons', async () => {
    const store = setup(), foreign = ownFixture({ fromProject: 'foreign-owner', saved: false, neverSaved: true, preferences: 'Imported lessons.', guidance: 'Imported guidance.', learning: false });
    const { fromProject: _p, saved: _s, neverSaved: _n, ...portable } = foreign, imported = await importTemplate(store, { format: 'cutframe-template', version: 1, template: foreign, assets: [] });
    expect(imported).toEqual(portable); expect(imported).not.toHaveProperty('neverSaved'); expect(imported).not.toHaveProperty('saved'); expect(imported).not.toHaveProperty('fromProject'); expect((await listTemplates(store)).mine).toEqual([portable]); expect(await projectTemplate(store, 'foreign-owner')).toBeUndefined();
  });
});
