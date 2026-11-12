// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 11 / A17: wizard template binding, one library reference, rollback and retry; Q10 keeps uploaded footage.
// Expectations are the written contract and Daylight's authored defaults, not the binding/default helper results.
// Real store and controls. Faults are a bundled-file HTTP failure or a real template deletion, never patched functions.
// The tracked CC0 WebM needs no generated media or ffmpeg; no skipped cases. No browser run by the test author.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { guard, notices, skipTour, TINY_PNG } from './t02-support';

test.use({ viewport: { width: 1400, height: 1000 } }); test.setTimeout(120_000);
type Rec = Record<string, any>;
const leaks = new WeakMap<Page, string[]>();
async function localOnly(page: Page) {
  await skipTour(page); leaks.set(page, guard(page));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(u.hostname) || ['blob:', 'data:'].includes(u.protocol) ? route.continue() : route.abort();
  });
}
test.beforeEach(async ({ page }) => { await localOnly(page); });
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) if (leaks.has(page)) expect(leaks.get(page), 'wizard, reference and bundled files make no off-localhost requests').toEqual([]);
});

const DEFAULTS = { templateId: 'daylight', epoch: 1, captionsFont: 'Manrope-Bold', titlesFont: 'Sora-ExtraBold', accentFont: 'InstrumentSerif-Regular',
  palette: [{ name: 'Chalk', hex: '#FAFAF7' }, { name: 'Ink', hex: '#15171C' }, { name: 'Cobalt', hex: '#2F6BFF' }, { name: 'Sun', hex: '#FFD23F' }] };
const DEFAULT_UNAVAILABLE = 'DEFAULT_UNAVAILABLE: The built-in templates aren’t available yet. Please try again later.';
const TEMPLATE_NOT_FOUND = 'TEMPLATE_NOT_FOUND: This template is no longer in your library.';
const DAYLIGHT_FILE = '**/*soft-chime*.wav*';
// vendor/manifest.json records this small, valid VP9/WebM as CC0; uploadReference probes and publishes it natively.
const REFERENCE_BYTES = readFileSync(new URL('../../vendor/demo-pack/slowmo-dune-drift.webm', import.meta.url)).toString('base64');
const REFERENCE_NAME = 'A17 library reference.webm';
const wizard = (page: Page) => page.getByRole('dialog', { name: 'New Video', exact: true });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Choose a Template', exact: true });
const projects = (page: Page): Promise<Rec[]> => page.evaluate(async () => {
  const p = '/src/store/database.ts'; return JSON.parse(JSON.stringify(await (await import(p)).projectStore.list()));
});
const state = (page: Page, id: string): Promise<Rec | null> => page.evaluate(async id => {
  const p = '/src/store/database.ts'; return JSON.parse(JSON.stringify(await (await import(p)).projectStore.read(id)));
}, id);
const library = (page: Page): Promise<Rec> => page.evaluate(async () => {
  const p = '/src/store/database.ts'; return JSON.parse(JSON.stringify(await (await import(p)).projectStore.library()));
});
const references = (page: Page): Promise<Rec[]> => page.evaluate(async () => {
  const p = '/src/media/references.ts', s = '/src/store/database.ts'; return await (await import(p)).listReferences((await import(s)).projectStore);
});
async function seedReference(page: Page): Promise<Rec> {
  return page.evaluate(async ({ data, name }) => {
    const p = '/src/media/references.ts', s = '/src/store/database.ts', bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const { reference } = await (await import(p)).uploadReference((await import(s)).projectStore, new File([bytes], name, { type: 'video/webm' }));
    return reference;
  }, { data: REFERENCE_BYTES, name: REFERENCE_NAME });
}
async function keepExistingProject(page: Page) {
  await page.evaluate(async () => { const p = '/src/store/database.ts'; await (await import(p)).projectStore.create('Existing project must survive wizard rollback'); });
}
async function openWizard(page: Page) {
  await page.getByRole('button', { name: '＋ New Video', exact: true }).click(); await expect(wizard(page)).toBeVisible();
}
async function choose(scope: Locator, name = 'Daylight', tab = 'Built-in templates') {
  await scope.getByRole('tab', { name: tab, exact: true }).click();
  const row = scope.getByRole('list', { name: tab, exact: true }).getByRole('button', { name: new RegExp(`^${name}`) });
  await row.click(); await expect(row).toHaveAttribute('aria-pressed', 'true'); return row;
}
async function pickTemplate(page: Page, name = 'Daylight', tab = 'Built-in templates') {
  await wizard(page).getByRole('button', { name: 'Choose template', exact: true }).click(); const p = picker(page); await choose(p, name, tab);
  await p.getByRole('button', { name: `Use ${name}`, exact: true }).click(); await expect(p).toHaveCount(0); await expect(wizard(page).getByText(name, { exact: true })).toBeVisible();
}
async function pickReference(page: Page, reference: Rec) {
  await wizard(page).getByRole('button', { name: 'From your library', exact: true }).click(); const p = page.getByRole('dialog', { name: 'Reference library', exact: true });
  const list = p.getByRole('list', { name: 'Saved references', exact: true }); await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: reference.name, exact: true }).click(); await expect(p).toHaveCount(0); await expect(wizard(page).getByText(reference.name, { exact: true })).toBeVisible();
}
async function footageStep(page: Page) {
  await wizard(page).getByRole('button', { name: 'Continue', exact: true }).click(); await expect(wizard(page).getByRole('heading', { name: 'Add Your Footage', exact: true })).toBeVisible();
}
async function unavailableDaylight(page: Page) {
  const attempts: { projectIds: string[]; links: Rec[] }[] = [];
  // Registered after the broad local-only guard. Observe the real project/links before the bind's file check fails.
  await page.route(DAYLIGHT_FILE, async route => {
    attempts.push(await page.evaluate(async () => {
      const p = '/src/store/database.ts', store = (await import(p)).projectStore;
      return { projectIds: (await store.list()).map((r: Rec) => r.id as string), links: (await store.library()).links };
    }));
    await route.fulfill({ status: 503, contentType: 'text/plain', body: 'A17 bundled-file fault' });
  });
  return { attempts, restore: () => page.unroute(DAYLIGHT_FILE) };
}
async function expectRollback(page: Page, before: Rec[], message: string) {
  await expect(notices(page)).toContainText(message); const w = wizard(page); await expect(w).toBeVisible();
  await expect(w.getByRole('button', { name: 'Create Project', exact: true })).toBeEnabled(); await expect(w.getByRole('button', { name: '← Back', exact: true })).toBeEnabled();
  await expect(w.getByRole('button', { name: 'Creating…', exact: true })).toHaveCount(0); expect(await projects(page)).toEqual(before); expect(new URL(page.url()).pathname).toBe('/');
  // Enabled alone is not enough: the retained wizard really navigates back and forward without creating anything.
  await w.getByRole('button', { name: '← Back', exact: true }).click(); await expect(w.getByRole('heading', { name: 'Project Setup', exact: true })).toBeVisible();
  await expect(w.getByRole('button', { name: 'Choose template', exact: true })).toBeEnabled(); await footageStep(page);
  await expect(w.getByRole('button', { name: 'Create Project', exact: true })).toBeEnabled(); expect(await projects(page)).toEqual(before);
}
async function createdProject(page: Page, before: Rec[]) {
  await expect(page).toHaveURL(/\/project\/[^/]+$/); await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 15000 }); await expect(page.getByRole('region', { name: 'Timeline', exact: true })).toBeVisible();
  const after = await projects(page), added = after.filter(r => !before.some(old => old.id === r.id)); expect(after).toHaveLength(before.length + 1); expect(added).toHaveLength(1);
  const id = added[0].id as string; await expect(page).toHaveURL(new RegExp(`/project/${id}$`)); return id;
}
async function expectDaylight(page: Page, id: string) {
  const stored = (await state(page, id))!; expect(stored.record).toMatchObject({ template_id: 'daylight', template_epoch: 1 }); expect(stored.document.templateDefaults).toEqual(DEFAULTS);
  await expect(page.getByRole('button', { name: 'Template: Daylight', exact: true })).toBeVisible();
}
async function expectReference(page: Page, id: string, reference: Rec) {
  const attached = await page.evaluate(async id => {
    const p = '/src/media/references.ts', s = '/src/store/database.ts'; return (await (await import(p)).projectReferences((await import(s)).projectStore, id)).map((r: Rec) => r.id);
  }, id);
  expect(attached).toEqual([reference.id]); const saved = await references(page); expect(saved).toHaveLength(1); expect(saved[0].id).toBe(reference.id); expect(saved[0].projects).toEqual([id]);
}
const ownTemplate = (id: string, name: string): Rec => ({ id, name, family: 'Personal', author: 'You', palette: [{ name: 'Personal ink', hex: '#123456' }], examples: [],
  assets: { fonts: [{ name: 'Roboto', ref: 'font:Roboto' }], audio: [], images: [] }, defaults: { captionsFont: 'Roboto-Regular', titlesFont: 'Roboto-Regular', accentFont: 'Roboto-Regular' },
  presetIds: [], guidance: 'A local test template.', learning: true, preferences: '', version: 1, savedAt: '2026-11-11T00:00:00.000Z' });
const storeOwn = (page: Page, template: Rec) => page.evaluate(async template => { const p = '/src/templates/library.ts', s = '/src/store/database.ts'; await (await import(p)).saveTemplate((await import(s)).projectStore, template); }, template);

test('A17: Daylight plus one library reference creates one bound project with literal defaults and opens its editor', async ({ page }) => {
  await page.goto('/'); const reference = await seedReference(page), before = await projects(page);
  await openWizard(page); await pickTemplate(page); await pickReference(page, reference); await footageStep(page);
  await wizard(page).getByRole('button', { name: 'Create Project', exact: true }).click(); const id = await createdProject(page, before);
  await expectDaylight(page, id); await expectReference(page, id, reference);
});

test('A17: an unavailable Daylight bundled file rolls back the project, shows DEFAULT_UNAVAILABLE and leaves the wizard usable', async ({ page }) => {
  await page.goto('/'); await keepExistingProject(page); const reference = await seedReference(page);
  await openWizard(page); await pickTemplate(page); await pickReference(page, reference); await footageStep(page);
  const before = await projects(page), refsBefore = await references(page), fault = await unavailableDaylight(page);
  await wizard(page).getByRole('button', { name: 'Create Project', exact: true }).click(); await expectRollback(page, before, DEFAULT_UNAVAILABLE);
  expect(fault.attempts.length, 'the Daylight file route was exercised by the bind').toBeGreaterThan(0); expect(await references(page)).toEqual(refsBefore);
});

test('A17: deleting a selected user template before Create rolls back the project, shows TEMPLATE_NOT_FOUND and leaves the wizard usable', async ({ page }) => {
  await page.goto('/'); await keepExistingProject(page); const reference = await seedReference(page), template = ownTemplate('a17-deleted-template', 'A17 temporary template'); await storeOwn(page, template);
  await openWizard(page); await pickTemplate(page, template.name, 'My templates'); await pickReference(page, reference); await footageStep(page);
  const missing = await page.evaluate(async id => {
    const p = '/src/templates/library.ts', s = '/src/store/database.ts', api = await import(p), store = (await import(s)).projectStore;
    await api.deleteTemplate(store, id); return await api.findTemplate(store, id) ?? null;
  }, template.id); expect(missing).toBeNull();
  const before = await projects(page), refsBefore = await references(page);
  await wizard(page).getByRole('button', { name: 'Create Project', exact: true }).click(); await expectRollback(page, before, TEMPLATE_NOT_FOUND); expect(await references(page)).toEqual(refsBefore);
});

test('A17/Q10: footage uploaded by the failed Create remains readable in the library; only the new project and its links disappear', async ({ page }) => {
  await page.goto('/'); await keepExistingProject(page); const reference = await seedReference(page);
  await openWizard(page); await pickTemplate(page); await pickReference(page, reference); await footageStep(page);
  const name = 'a17-rollback-footage.png', bytes = Buffer.from(TINY_PNG, 'base64');
  await wizard(page).getByLabel('Add footage from this computer', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
  await expect(wizard(page).getByRole('list', { name: 'Footage to upload', exact: true }).getByText(name, { exact: true })).toBeVisible();
  const before = await projects(page), libraryBefore = await library(page), refsBefore = await references(page), fault = await unavailableDaylight(page);
  await wizard(page).getByRole('button', { name: 'Create Project', exact: true }).click(); await expectRollback(page, before, DEFAULT_UNAVAILABLE);
  expect(fault.attempts.length, 'the bind reached the bundled file after uploading footage').toBeGreaterThan(0);
  const after = await library(page), uploaded = after.assets.filter((a: Rec) => !libraryBefore.assets.some((old: Rec) => old.id === a.id)); expect(uploaded).toHaveLength(1);
  expect(uploaded[0]).toMatchObject({ name, originalName: name, type: 'image', mimeType: 'image/png', sizeBytes: bytes.length });
  const failedIds = fault.attempts[0].projectIds.filter(id => !before.some(old => old.id === id)); expect(failedIds).toHaveLength(1); const failedId = failedIds[0];
  expect(fault.attempts[0].links.filter(link => link.projectId === failedId).map(link => link.assetId)).toEqual([uploaded[0].id]);
  expect(after.links).toEqual(libraryBefore.links); expect(await references(page)).toEqual(refsBefore);
  const removed = await page.evaluate(async id => {
    const p = '/src/store/database.ts', store = (await import(p)).projectStore;
    return { record: await store.row('projects', id) ?? null, document: await store.row('documents', id) ?? null, links: await store.projectAssets(id) };
  }, failedId); expect(removed).toEqual({ record: null, document: null, links: [] });
  const readable = await page.evaluate(async id => {
    const p = '/src/store/database.ts', blob = await (await import(p)).projectStore.media.read(id); return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, uploaded[0].id); expect(readable).toEqual(Array.from(bytes));
});

test('A17: a second Create in the retained wizard succeeds once the bundled-file fault is removed, making exactly one bound project', async ({ page }) => {
  await page.goto('/'); await keepExistingProject(page); const reference = await seedReference(page);
  await openWizard(page); await pickTemplate(page); await pickReference(page, reference); await footageStep(page);
  const before = await projects(page), refsBefore = await references(page), fault = await unavailableDaylight(page);
  await wizard(page).getByRole('button', { name: 'Create Project', exact: true }).click(); await expectRollback(page, before, DEFAULT_UNAVAILABLE);
  expect(fault.attempts.length).toBeGreaterThan(0); expect(await references(page)).toEqual(refsBefore); await fault.restore();
  await wizard(page).getByRole('button', { name: 'Create Project', exact: true }).click(); const id = await createdProject(page, before);
  await expectDaylight(page, id); await expectReference(page, id, reference);
});

test('A17: no template picked creates an unbound project and still attaches the one library reference', async ({ page }) => {
  await page.goto('/'); const reference = await seedReference(page), before = await projects(page);
  await openWizard(page); await pickReference(page, reference); await footageStep(page); await wizard(page).getByRole('button', { name: 'Create Project', exact: true }).click();
  const id = await createdProject(page, before), stored = (await state(page, id))!; expect(stored.record.template_id).toBeNull(); expect(stored.record.template_epoch ?? 0).toBe(0); expect(stored.document).not.toHaveProperty('templateDefaults');
  await expect(page.getByRole('button', { name: 'Template: No template', exact: true })).toBeVisible(); await expectReference(page, id, reference);
});
