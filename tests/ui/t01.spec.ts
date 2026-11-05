// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, type Page } from '@playwright/test';

async function createProject(page: Page, title = 'Browser fixture') {
  return page.evaluate(async title => { const path = '/src/store/database.ts'; const { projectStore } = await import(path); return (await projectStore.create(title)).id as string; }, title);
}
async function edit(page: Page, fps: number) {
  await page.evaluate(async fps => { const path = '/src/editor.tsx'; const { activeSession } = await import(path); activeSession.update({ ...activeSession.document, fps }); await activeSession.flush(); }, fps);
}
// T17: a clean tab now refetches another tab's save (cross-tab channel); a tab with an unsaved change shows the conflict instead.
async function dirty(page: Page, fps: number) {
  await page.evaluate(async fps => { const path = '/src/editor.tsx'; const { activeSession } = await import(path); activeSession.update({ ...activeSession.document, fps }); }, fps);
}
test('empty wizard creates exactly one schema-4 empty project and navigates without a message handover or provider', async ({ page }) => {
  const external: string[] = []; page.on('request', r => { if (!['127.0.0.1', 'localhost'].includes(new URL(r.url()).hostname)) external.push(r.url()); });
  await page.goto('/?no-provider=1'); await page.getByRole('button', { name: '＋ New Video', exact: true }).click();
  await expect(page.getByLabel('Step 1 of 2')).toBeVisible(); await expect(page.getByRole('heading', { name: 'Project Setup', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.getByLabel('Step 2 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Create Project', exact: true }).click(); await expect(page).toHaveURL(/\/project\/[^/]+$/); await expect(page.getByRole('status')).toHaveText('Saved locally');
  const result = await page.evaluate(async () => { const path = '/src/store/database.ts'; const { projectStore } = await import(path); const projects = await projectStore.list(); return { projects, saved: await projectStore.read(projects[0].id), keys: Object.keys(sessionStorage) }; });
  expect(result.projects).toHaveLength(1); expect(result.projects[0].title).toBe('Untitled Project');
  expect(result.saved.document).toEqual({ schemaVersion: 4, rev: 0, layerOrder: [], groups: {}, duration: 1000, fps: 30, size: { width: 1080, height: 1920 }, background: { type: 'color', value: 'transparent' }, tracks: [], items: [], transitions: [], markers: [] });
  expect(result.keys.some((key: string) => /message|model|chat/i.test(key))).toBe(false); expect(external).toEqual([]);
});
test('two real Chromium pages and IndexedDB show conflict, preserve the first write, and support Keep mine and Reload', async ({ page, context }) => {
  await page.goto('/'); const id = await createProject(page); const other = await context.newPage();
  await Promise.all([page.goto(`/project/${id}`), other.goto(`/project/${id}`)]);
  await expect(page.getByRole('status')).toHaveText('Saved locally'); await expect(other.getByRole('status')).toHaveText('Saved locally');
  await dirty(other, 60); await edit(page, 24); await edit(other, 60);
  await expect(other.getByRole('group', { name: 'Resolve project conflict' })).toBeVisible();
  expect(await page.evaluate(async id => { const path = '/src/store/database.ts'; return (await (await import(path)).projectStore.read(id)).document; }, id)).toMatchObject({ fps: 24, rev: 1 });
  await dirty(page, 25); await other.getByRole('button', { name: 'Keep mine', exact: true }).click(); await expect(other.getByTestId('project-rev')).toHaveText('Saved revision: 2');
  await edit(page, 25); await expect(page.getByRole('group', { name: 'Resolve project conflict' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await expect(page.getByTestId('project-rev')).toHaveText('Saved revision: 2');
  await page.reload(); await expect(page.getByTestId('project-rev')).toHaveText('Saved revision: 2'); await expect(page.getByText('1080 × 1920 · 60 fps · 0 items')).toBeVisible();
});
test('unknown route redirects home with toast and notification shortcut; missing id is a full-screen failure', async ({ page }) => {
  await page.goto('/unknown-route'); await expect(page).toHaveURL('/'); await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Page not found');
  await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('button')).toHaveCount(1);
  await page.keyboard.press('Alt+n'); await expect(page.getByRole('region', { name: 'Notifications' })).toBeFocused();
  await page.goto('/project/missing-id'); await expect(page.getByRole('heading', { name: 'Failed to load project' })).toBeVisible(); await expect(page.getByText('Project not found.', { exact: true })).toBeVisible(); await expect(page.locator('header')).toHaveCount(0);
  await page.getByRole('button', { name: '‹ Back to home' }).click(); await expect(page).toHaveURL('/');
});
test('storage open failure has a separate Retry route', async ({ page }) => {
  await page.addInitScript(() => { const open = IDBFactory.prototype.open; let fail = true; IDBFactory.prototype.open = function (...args) { if (fail) { fail = false; throw new DOMException('Blocked storage', 'SecurityError'); } return open.apply(this, args); }; });
  await page.goto('/project/some-id'); await expect(page.getByText('Couldn’t open this project. Browser storage could not be read.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(page.getByText('Project not found.', { exact: true })).toBeVisible();
});
test('theme cycles through all three saved states; help and later-ticket entry points are explicit', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Theme: system' }).click(); await page.reload(); await expect(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
  await page.getByRole('button', { name: 'Theme: light' }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await page.getByRole('button', { name: 'Theme: dark' }).click();
  for (const route of ['/assets', '/settings', '/costs']) { await page.goto(route); await page.getByRole('button', { name: 'Help & Resources' }).click(); await expect(page.getByRole('menuitem', { name: 'Agent-setup guide' })).toBeVisible(); }
  await page.getByRole('menuitem', { name: 'Community' }).click(); await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('destination not configured');
  await page.goto('/'); await page.getByRole('button', { name: '＋ New Video', exact: true }).click(); await page.getByRole('button', { name: 'From your library', exact: true }).click();
  // T14 built the reference library: an empty store shows "0 saved" and the empty state (T14 tests the filled library).
  await expect(page.getByText('0 saved', { exact: true })).toBeVisible(); await expect(page.getByText('No reference videos yet.', { exact: true })).toBeVisible();
});
test('project and media quota errors surface STORAGE_QUOTA visibly, with failed writes rolled back', async ({ page }) => {
  await page.goto('/'); const id = await createProject(page); await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await page.evaluate(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...args) { if (this.name === 'documents') throw new DOMException('full', 'QuotaExceededError'); return put.apply(this, args); }; });
  await edit(page, 60); await expect(page.getByRole('alert')).toContainText('STORAGE_QUOTA'); await expect(page.getByRole('alert')).toContainText('Free disk space');
  await page.goto('/assets'); await page.evaluate(() => { FileSystemFileHandle.prototype.createWritable = async () => { throw new DOMException('full', 'QuotaExceededError'); }; });
  await page.getByLabel('Upload media').setInputFiles({ name: 'quota.png', mimeType: 'image/png', buffer: Buffer.from('test') });
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('STORAGE_QUOTA'); await expect(page.getByRole('tab', { name: 'Assets (0)', exact: true })).toBeVisible();
});
test('library UI persists OPFS bytes, nested folders, move, rename, usage warning and deletion across reload', async ({ page }) => {
  await page.goto('/assets');
  await page.getByRole('button', { name: 'New folder', exact: true }).click(); await page.getByLabel('Folder name').fill('Outer'); await page.getByLabel('Folder name').press('Enter');
  await page.getByRole('button', { name: 'Open folder Outer' }).click(); await page.getByRole('button', { name: 'New folder', exact: true }).click(); await page.getByLabel('Folder name').fill('Inner'); await page.getByLabel('Folder name').press('Enter');
  await page.getByLabel('Upload media').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await expect(page.getByText('tiny.png', { exact: true })).toBeVisible(); await page.reload(); await page.getByRole('button', { name: 'Open folder Outer' }).click();
  await page.getByText('tiny.png', { exact: true }).dblclick(); await page.getByLabel('Asset name', { exact: true }).fill('renamed.png'); await page.getByLabel('Asset name', { exact: true }).press('Enter');
  await page.getByLabel('Select renamed.png', { exact: true }).check(); await page.getByRole('button', { name: 'Move', exact: true }).click(); await page.getByRole('group', { name: 'Move to', exact: true }).getByRole('button', { name: 'Outer / Inner', exact: true }).click();
  await page.getByRole('button', { name: 'Open folder Inner' }).click(); await expect(page.getByText('renamed.png', { exact: true })).toBeVisible();
  const fixture = await page.evaluate(async () => { const path = '/src/store/database.ts'; const { projectStore } = await import(path); const a = (await projectStore.library()).assets[0]; const p = await projectStore.create('Usage fixture'); await projectStore.attach(p.id, a.id); return { bytes: Array.from(new Uint8Array(await (await projectStore.media.read(a.id)).arrayBuffer())), id: a.id }; });
  expect(fixture.bytes).toEqual([137, 80, 78, 71]);
  await page.getByText('renamed.png', { exact: true }).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete (1)' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete 1 asset(s)' })).toContainText('Used in 1 project(s)'); await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click(); await expect(page.getByText('renamed.png', { exact: true })).toHaveCount(0);
  await page.reload(); expect(await page.evaluate(async () => { const path = '/src/store/database.ts'; return (await (await import(path)).projectStore.library()).assets.length; })).toBe(0);
});
test('home UI shows scripted five-project order and updated-date labels with an injected clock', async ({ page }) => {
  const now = new Date('2026-10-27T12:00:00Z'); await page.clock.setFixedTime(now); await page.goto('/');
  await page.evaluate(async timestamp => {
    const path = '/src/store/database.ts'; const { ProjectStore } = await import(path); let clock = timestamp;
    const store = new ProjectStore('cutframe', () => clock), records = [];
    for (let n = 0; n < 5; n++) { clock = timestamp - n * 86400000; records.push(await store.create(`Fixture ${n}`)); }
    for (const [i, n] of [2, 0, 4, 1, 3].entries()) { clock = timestamp + i * 1000; await store.openProject(records[n].id); }
    await store.close();
  }, now.getTime());
  await page.reload(); const rows = page.locator('.project-list li');
  await expect(rows.locator('.project-title')).toHaveText(['Fixture 3', 'Fixture 1', 'Fixture 4', 'Fixture 0', 'Fixture 2']); await expect(rows.locator('time')).toHaveText(['3d ago', '1d ago', '4d ago', 'Today', '2d ago']);
  await rows.first().hover(); await page.getByRole('button', { name: 'Actions for Fixture 3' }).click(); await page.getByRole('menuitem', { name: 'Rename' }).click(); await page.getByLabel('Project title').fill('   '); await page.getByLabel('Project title').press('Enter'); await expect(rows.first().locator('.project-title')).toHaveText('Fixture 3');
});
test('folder-only deletion moves children up; deleting everything removes the nested tree through the UI', async ({ page }) => {
  await page.goto('/assets');
  await page.getByRole('button', { name: 'New folder', exact: true }).click(); await page.getByLabel('Folder name').fill('Cancelled'); await page.getByLabel('Folder name').press('Escape');
  await expect(page.getByRole('button', { name: 'Open folder Cancelled' })).toHaveCount(0);
  await page.evaluate(async () => { const path = '/src/store/database.ts'; const { projectStore } = await import(path); const outer = await projectStore.createFolder('Outer'); await projectStore.createFolder('Inner', outer.id); await projectStore.upload(new File(['a'], 'in-tree.png', { type: 'image/png' }), outer.id); });
  await page.reload(); await page.getByRole('button', { name: 'Actions for folder Outer' }).click(); await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete folder', exact: true })).toContainText('1 assets and 1 subfolders'); await page.getByRole('button', { name: 'Delete folder only', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open folder Inner' })).toBeVisible(); await expect(page.getByText('in-tree.png', { exact: true })).toBeVisible();
  await page.getByLabel('Select in-tree.png', { exact: true }).check(); await page.getByRole('button', { name: 'Move', exact: true }).click(); await expect(page.getByRole('group', { name: 'Move to', exact: true }).getByRole('button', { name: 'All assets', exact: true })).toBeDisabled(); await page.getByRole('group', { name: 'Move to', exact: true }).getByRole('button', { name: 'Inner', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for folder Inner' }).click(); await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click(); await page.getByRole('button', { name: 'Delete everything', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete folder', exact: true })).toHaveCount(0); await expect(page.getByRole('tab', { name: 'Assets (0)', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Open folder Inner' })).toHaveCount(0); await expect(page.getByRole('tab', { name: 'Assets (0)', exact: true })).toBeVisible();
});
test('library view and sorting survive the Exports subtab and reset after navigation; filters apply and clear; search runs the T19 footage search', async ({ page }) => {
  await page.goto('/assets'); await page.getByRole('button', { name: 'List', exact: true }).click(); await page.getByLabel('Sort field').selectOption('recorded'); await page.getByRole('button', { name: 'DESC', exact: true }).click();
  await page.getByRole('tab', { name: 'Exports', exact: true }).click(); await page.getByRole('tab', { name: 'Assets (0)', exact: true }).click(); await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByLabel('Sort field')).toHaveValue('recorded'); await expect(page.getByRole('button', { name: 'ASC', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click(); await page.getByLabel('Location', { exact: true }).fill('Singapore'); await page.getByRole('button', { name: 'Apply Filters' }).click(); await expect(page.getByRole('button', { name: 'Filters active', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Clear', exact: true }).click();
  // T19 (was: an explicit stub): the search runs; UI runs have no models, so the service answers with no rows here (T19's own specs cover results).
  await page.evaluate(async () => { const p = '/src/analysis/service.ts'; const { analysisService } = await import(p); analysisService.search = async (_store: unknown, request: { query: string }) => ({ query: request.query, results: [], metadata: { totalResults: 0, sources: { embedding: 0, filename: 0 } } }); });
  await page.getByLabel('Search media', { exact: true }).fill('Footage'); await page.getByLabel('Search media', { exact: true }).press('Enter'); await expect(page.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0); await expect(page.getByRole('heading', { name: 'No assets match your search' })).toBeVisible(); await page.getByRole('button', { name: 'Show clips', exact: true }).click(); await expect(page.getByRole('heading', { name: 'No clips match your search' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click(); await page.getByRole('link', { name: 'Library', exact: true }).click(); await expect(page.getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByLabel('Sort field')).toHaveValue('uploaded'); await expect(page.getByRole('button', { name: 'DESC', exact: true })).toBeVisible();
});
test('identical two-tab edits resolve visibly with Keep mine without increasing the saved revision', async ({ page, context }) => {
  await page.goto('/'); const id = await createProject(page); const other = await context.newPage();
  await Promise.all([page.goto(`/project/${id}`), other.goto(`/project/${id}`)]);
  await expect(page.getByRole('status')).toHaveText('Saved locally'); await expect(other.getByRole('status')).toHaveText('Saved locally');
  await dirty(other, 24); await edit(page, 24); await edit(other, 24); await expect(other.getByRole('group', { name: 'Resolve project conflict' })).toBeVisible();
  await other.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await expect(other.getByRole('status')).toHaveText('Saved locally'); await expect(other.getByRole('group', { name: 'Resolve project conflict' })).toHaveCount(0);
  await expect(other.getByRole('alert')).toHaveCount(0); await expect(other.getByTestId('project-rev')).toHaveText('Saved revision: 1');
  await other.reload(); await expect(other.getByTestId('project-rev')).toHaveText('Saved revision: 1');
});
test('real IndexedDB reload/edit/flush cannot silently revert the edit on a later unrelated save', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const storePath = '/src/store/database.ts', sessionPath = '/src/store/autosave.ts', modelPath = '/src/store/model.ts';
    const { ProjectStore } = await import(storePath), { AutosaveSession } = await import(sessionPath), { emptyDocument } = await import(modelPath);
    const store = new ProjectStore(`reload-race-${crypto.randomUUID()}`), project = await store.create(), session = new AutosaveSession(store, project.id, emptyDocument());
    try {
      const reloading = session.reload(); session.update({ ...session.document, fps: 60 }); const saving = session.flush(); await Promise.all([reloading, saving]);
      const before = { local: structuredClone(session.document), stored: (await store.read(project.id)).document, state: session.state };
      session.update({ ...session.document, duration: 2000 }); await session.flush();
      const after = { local: structuredClone(session.document), stored: (await store.read(project.id)).document, state: session.state };
      await session.keepMine(); session.update({ ...session.document, duration: 3000 }); await session.flush();
      return { before, after, resolved: { local: session.document, stored: (await store.read(project.id)).document, state: session.state } };
    } finally { await store.close(); }
  });
  expect(result.before).toMatchObject({ local: { fps: 60 }, stored: { fps: 30, rev: 0 }, state: 'conflict' });
  expect(result.after).toMatchObject({ local: { fps: 60, duration: 2000 }, stored: { fps: 30, duration: 1000, rev: 0 }, state: 'conflict' });
  expect(result.resolved.state).toBe('saved'); expect(result.resolved.stored).toMatchObject({ fps: 60, duration: 3000, rev: 2 }); expect(result.resolved.local).toEqual(result.resolved.stored);
});
test('Move menu stays clickable with a persistent upload notice and the notice can still be dismissed', async ({ page }) => {
  await page.goto('/assets'); await page.getByLabel('Upload media').setInputFiles({ name: 'notice.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  const notices = page.getByRole('region', { name: 'Notifications' }); await expect(notices).toContainText('Media stored locally');
  await page.getByLabel('Select notice.png', { exact: true }).check(); await page.getByRole('button', { name: 'Move', exact: true }).click();
  const menu = page.getByRole('group', { name: 'Move to', exact: true });
  await menu.getByRole('button', { name: 'New folder…', exact: true }).click({ timeout: 3000 }); await page.getByLabel('Destination folder name', { exact: true }).press('Escape');
  await expect(notices).toContainText('Media stored locally'); await menu.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 3000 });
  await expect(menu).toHaveCount(0); await notices.getByRole('button').click(); await expect(notices.getByRole('button')).toHaveCount(0);
});
test.describe('Library calendar date filters in America/New_York', () => {
  test.use({ timezoneId: 'America/New_York' });
  for (const fixture of [
    { day: '2026-03-08', start: '2026-03-08T05:00:00Z', last: '2026-03-09T03:59:59.999Z', next: '2026-03-09T04:00:00Z' },
    { day: '2026-11-01', start: '2026-11-01T04:00:00Z', last: '2026-11-02T04:59:59.999Z', next: '2026-11-02T05:00:00Z' },
  ]) test(`includes exactly the calendar day across DST on ${fixture.day}`, async ({ page }) => {
    await page.goto('/assets');
    const result = await page.evaluate(async fixture => {
      const path = '/src/store/model.ts'; const { queryAssets } = await import(path);
      const assets = Object.entries({ before: new Date(Date.parse(fixture.start) - 1).toISOString(), start: fixture.start, last: fixture.last, next: fixture.next }).map(([id, recorded_at]) => ({
        id, name: id, type: 'video', sizeBytes: 1, mimeType: 'video/mp4', folderId: null, created_at: fixture.start, recorded_at, location: null, durationMs: null,
      }));
      return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ids: queryAssets(assets, { folderId: null, from: fixture.day, to: fixture.day }).map((a: { id: string }) => a.id).sort() };
    }, fixture);
    expect(result.timezone).toBe('America/New_York'); expect(result.ids).toEqual(['last', 'start']);
  });
});
