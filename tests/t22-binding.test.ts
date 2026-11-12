// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 8 S1 / P2-P3. Oracle: findings §22 Cutframe spec, plan P1/P2/P3/S1 and the pinned step-8 binding rules.
// Expected epochs, retry behaviour and defaults are literal contract expectations, never bind/read/default helper output.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../apps/web/src/store/database';
import { StoreError, emptyDocument } from '../apps/web/src/store/model';
import type { ProjectRecord } from '../apps/web/src/store/model';
import type { MediaStore } from '../apps/web/src/store/media';
import { bindProject, bindTemplate, writeDefaults, readDefaults, repairDefaults } from '../apps/web/src/templates/binding';
import { defaultsOf } from '../apps/web/src/templates/model';
import type { Template } from '../apps/web/src/templates/model';
import { DEFAULT_FILES, DEFAULT_TEMPLATE } from '../apps/web/src/templates/default';
import { saveTemplate, updateTemplate, deleteTemplate } from '../apps/web/src/templates/library';
import { SNAPSHOT_KEYS } from '../apps/web/src/timeline/bus';

const opened: ProjectStore[] = [];
afterEach(async () => { for (const store of opened.splice(0)) await store.close(); });
function setup() {
  let tick = Date.parse('2026-11-11T04:30:00Z'); const files = new Map<string, Blob>();
  const media: MediaStore = { write: vi.fn(async (id, blob) => { files.set(id, blob); }), read: vi.fn(async id => files.get(id)!), remove: vi.fn(async (_kind, id) => { files.delete(id); }) };
  const store = new ProjectStore(crypto.randomUUID(), () => tick++, media); opened.push(store); return store;
}
const alternative = (): Template => ({ id: 'user-alternative', name: 'Alternative', family: 'Personal', author: 'Test',
  palette: [{ name: 'Accent', hex: '#123456' }], examples: [], assets: { fonts: [{ name: 'Roboto', ref: 'font:Roboto' }], audio: [], images: [] },
  defaults: { captionsFont: 'Roboto', titlesFont: 'Roboto', accentFont: 'Roboto' }, presetIds: [], guidance: '', learning: true, preferences: '', version: 1, savedAt: '2026-11-11T00:00:00Z' });
async function unbound(store: ProjectStore) {
  const project = await store.create('Binding fixture'), record = { ...project } as Partial<ProjectRecord> & { id: string };
  // Simulate a project written before T22: all three binding fields are absent, not merely epoch=0.
  delete record.template_id; delete record.template_epoch; delete record.template_request;
  await store.putRow('projects', record); return project.id;
}
const expectedDefaults = (template: Template, epoch: number) => ({ templateId: template.id, epoch, captionsFont: template.defaults.captionsFont,
  titlesFont: template.defaults.titlesFont, accentFont: template.defaults.accentFont, palette: structuredClone(template.palette) });
async function expectStoreError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, caught => caught);
  expect(error).toBeInstanceOf(StoreError); expect(error).toMatchObject({ code });
}

describe('S1: project binding epochs, idempotency and record/document isolation', () => {
  it('a field-less project starts at epoch 0; only the three binding fields are written', async () => {
    const store = setup(), id = await unbound(store), before = (await store.read(id))!;
    expect(await bindTemplate(store, id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'first' })).toEqual({ epoch: 1, templateId: DEFAULT_TEMPLATE.id });
    const after = (await store.read(id))!;
    expect(after.record).toEqual({ ...before.record, template_id: DEFAULT_TEMPLATE.id, template_epoch: 1, template_request: 'first' });
    expect(after.document).toEqual(before.document);
  });
  it('two different keys with the same epoch: the second is stale and changes nothing', async () => {
    const store = setup(), id = await unbound(store); await saveTemplate(store, alternative());
    await bindTemplate(store, id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'tab-one' }); const before = (await store.read(id))!;
    await expectStoreError(bindTemplate(store, id, { templateId: 'user-alternative', expectedEpoch: 0, requestKey: 'tab-two' }), 'TEMPLATE_SELECTION_STALE');
    expect(await store.read(id)).toEqual(before);
  });
  it('concurrent same-epoch requests have exactly one winner', async () => {
    const store = setup(), id = await unbound(store); await saveTemplate(store, alternative()); const document = (await store.read(id))!.document;
    const results = await Promise.allSettled([
      bindTemplate(store, id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'one' }),
      bindTemplate(store, id, { templateId: 'user-alternative', expectedEpoch: 0, requestKey: 'two' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult; expect(failure.reason).toBeInstanceOf(StoreError); expect(failure.reason.code).toBe('TEMPLATE_SELECTION_STALE');
    const winner = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ epoch: number; templateId: string }>).value;
    const after = (await store.read(id))!; expect(after.record).toMatchObject({ template_id: winner.templateId, template_epoch: 1 }); expect(after.document).toEqual(document);
  });
  it.each([{ epoch: 0, other: false }, { epoch: 1, other: false }, { epoch: 0, other: true }])('same request key retries once, including stale epoch/another template: %j', async retry => {
    const store = setup(), id = await unbound(store); await saveTemplate(store, alternative());
    await bindTemplate(store, id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'retry' }); const before = (await store.read(id))!;
    expect(await bindTemplate(store, id, { templateId: retry.other ? 'user-alternative' : DEFAULT_TEMPLATE.id, expectedEpoch: retry.epoch, requestKey: 'retry' })).toEqual({ epoch: 1, templateId: DEFAULT_TEMPLATE.id });
    expect(await store.read(id)).toEqual(before);
  });
  it('an old key after a newer binding is no longer the last retry key', async () => {
    const store = setup(), id = await unbound(store); await saveTemplate(store, alternative());
    await bindTemplate(store, id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'old' });
    await bindTemplate(store, id, { templateId: 'user-alternative', expectedEpoch: 1, requestKey: 'new' }); const before = (await store.read(id))!;
    await expectStoreError(bindTemplate(store, id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'old' }), 'TEMPLATE_SELECTION_STALE');
    expect(await store.read(id)).toEqual(before); expect(before.record.template_epoch).toBe(2);
  });
  it('unknown template is TEMPLATE_NOT_FOUND, with project and document unchanged', async () => {
    const store = setup(), id = await unbound(store), before = await store.read(id);
    await expectStoreError(bindTemplate(store, id, { templateId: 'not-a-template', expectedEpoch: 0, requestKey: 'unknown' }), 'TEMPLATE_NOT_FOUND'); expect(await store.read(id)).toEqual(before);
  });
  it('missing project is PROJECT_NOT_FOUND', async () => {
    await expectStoreError(bindTemplate(setup(), 'missing-project', { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'missing' }), 'PROJECT_NOT_FOUND');
  });
});

describe('P3: document defaults and repair from the current library', () => {
  it('defaultsOf/writeDefaults/readDefaults match the explicit key, without mutating the input document', () => {
    const template = alternative(), doc = emptyDocument(), before = structuredClone(doc), expected = expectedDefaults(template, 7);
    expect(defaultsOf(template, 7)).toEqual(expected); expect(readDefaults(doc)).toBeUndefined();
    const result = writeDefaults(doc, template, 7); expect(result).not.toBe(doc); expect(result.templateDefaults).toEqual(expected); expect(readDefaults(result)).toEqual(expected); expect(doc).toEqual(before);
    expect(SNAPSHOT_KEYS).not.toContain('templateDefaults');
  });
  it('a behind epoch is re-derived from the personal copy, not the built-in values', async () => {
    const store = setup(), id = await unbound(store);
    const personal = await updateTemplate(store, DEFAULT_TEMPLATE.id, t => ({ ...t, defaults: { ...t.defaults, titlesFont: 'Roboto' }, palette: [{ name: 'Personal', hex: '#123456' }] }), new Date('2026-11-11T04:00:00Z'));
    await bindTemplate(store, id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'bind' }); const record = (await store.read(id))!.record;
    const doc = emptyDocument(); doc.templateDefaults = expectedDefaults(DEFAULT_TEMPLATE, 0);
    const repaired = await repairDefaults(store, record, doc); expect(repaired).not.toBeNull(); expect(readDefaults(repaired!)).toEqual(expectedDefaults(personal, 1));
  });
  it('equal epochs return null', async () => {
    const store = setup(), id = await unbound(store); await bindTemplate(store, id, { templateId: DEFAULT_TEMPLATE.id, expectedEpoch: 0, requestKey: 'bind' });
    const record = (await store.read(id))!.record, doc = writeDefaults(emptyDocument(), DEFAULT_TEMPLATE, 1), before = structuredClone(doc);
    expect(await repairDefaults(store, record, doc)).toBeNull(); expect(doc).toEqual(before);
  });
  it('an unbound record removes a stale defaults key', async () => {
    const store = setup(), id = await unbound(store), record = (await store.read(id))!.record, doc = emptyDocument();
    doc.templateDefaults = expectedDefaults(DEFAULT_TEMPLATE, 9); const expected = structuredClone(doc); delete expected.templateDefaults;
    const repaired = await repairDefaults(store, record, doc); expect(repaired).toEqual(expected); expect(repaired).not.toHaveProperty('templateDefaults');
  });
  it('a binding to a deleted user template stays bound and leaves its document alone', async () => {
    const store = setup(), id = await unbound(store), template = alternative(); await saveTemplate(store, template);
    await bindTemplate(store, id, { templateId: template.id, expectedEpoch: 0, requestKey: 'bind' }); await deleteTemplate(store, template.id);
    const record = (await store.read(id))!.record, beforeRecord = structuredClone(record), doc = writeDefaults(emptyDocument(), template, 0), before = structuredClone(doc);
    expect(await repairDefaults(store, record, doc)).toBeNull(); expect(doc).toEqual(before); expect((await store.read(id))!.record).toEqual(beforeRecord);
  });
});

const bundledBytes = async (file: string) => new Blob([readFileSync(new URL(`../${file}`, import.meta.url))]);
describe('step 10 bindProject: verified built-in files before binding, fresh requests and own-template isolation', () => {
  it('loads every DEFAULT_FILES entry before changing the project record', async () => {
    const store = setup(), project = await store.create('UI bind'), before = (await store.read(project.id))!;
    const load = vi.fn(async (file: string) => {
      expect((await store.read(project.id))!.record).toEqual(before.record);
      return bundledBytes(file);
    });
    expect(await bindProject(store, project.id, DEFAULT_TEMPLATE, 0, load)).toEqual({ epoch: 1, templateId: 'daylight' });
    expect(load.mock.calls.map(([file]) => file)).toEqual(DEFAULT_FILES.map(file => file.path));
    const after = (await store.read(project.id))!;
    expect(after.record).toMatchObject({ template_id: 'daylight', template_epoch: 1 }); expect(after.document).toEqual(before.document);
  });
  it.each(['load failure', 'different bytes'])('%s rejects DEFAULT_UNAVAILABLE without a partial binding', async kind => {
    const store = setup(), project = await store.create('Unavailable UI bind'), before = (await store.read(project.id))!;
    const load = vi.fn(async (file: string) => {
      if (file === DEFAULT_FILES[1].path) {
        if (kind === 'load failure') throw new Error('fixture file unavailable');
        return new Blob(['not the recorded font']);
      }
      return bundledBytes(file);
    });
    await expectStoreError(bindProject(store, project.id, DEFAULT_TEMPLATE, 0, load), 'DEFAULT_UNAVAILABLE');
    expect(load.mock.calls.map(([file]) => file)).toEqual(DEFAULT_FILES.slice(0, 2).map(file => file.path));
    const after = (await store.read(project.id))!; expect(after).toEqual(before);
    expect(after.record.template_id).toBeNull(); expect(after.record).not.toHaveProperty('template_epoch'); expect(after.record).not.toHaveProperty('template_request');
  });
  it('a stale UI expectedEpoch rejects TEMPLATE_SELECTION_STALE without changing the winning binding', async () => {
    const store = setup(), project = await store.create('Stale UI bind');
    await bindProject(store, project.id, DEFAULT_TEMPLATE, 0, bundledBytes); const before = await store.read(project.id);
    await expectStoreError(bindProject(store, project.id, DEFAULT_TEMPLATE, 0, bundledBytes), 'TEMPLATE_SELECTION_STALE');
    expect(await store.read(project.id)).toEqual(before);
  });
  it('two UI calls use distinct request keys and advance the epoch twice', async () => {
    const store = setup(), project = await store.create('Repeated UI bind');
    expect(await bindProject(store, project.id, DEFAULT_TEMPLATE, 0, bundledBytes)).toEqual({ epoch: 1, templateId: 'daylight' });
    const first = (await store.read(project.id))!.record.template_request;
    expect(await bindProject(store, project.id, DEFAULT_TEMPLATE, 1, bundledBytes)).toEqual({ epoch: 2, templateId: 'daylight' });
    const second = (await store.read(project.id))!.record.template_request;
    expect(first).toEqual(expect.any(String)); expect(first!.length).toBeGreaterThan(0); expect(second).toEqual(expect.any(String)); expect(second).not.toBe(first);
  });
  it('an own template binds without calling the bundled-file loader', async () => {
    const store = setup(), project = await store.create('Own UI bind'), template = alternative(); await saveTemplate(store, template);
    const load = vi.fn(async (_file: string): Promise<Blob> => { throw new Error('own templates must not load built-in files'); });
    expect(await bindProject(store, project.id, template, 0, load)).toEqual({ epoch: 1, templateId: 'user-alternative' });
    expect(load).not.toHaveBeenCalled();
  });
});
