// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 1 in Chromium: the §39 order, no plans/credits/referrals/billing, and every setting persisting across a reload
// with its stated effect (Profile name, Reference behaviour, Auto backup, Allowed directories, model connections, models and keys),
// then Delete local data confirmed: projects, media, OPFS, keys and settings are gone.
import { test, expect, type Page } from '@playwright/test';
import { addAsset, createProject, guard, richDoc, skipTour } from './t02-support';

test.use({ viewport: { width: 1400, height: 900 } });
const leaks = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { leaks.set(page, guard(page)); await skipTour(page); });
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'requests that left localhost').toEqual([]); });

/** A stand-in for showDirectoryPicker that hands back a real OPFS directory handle (what the browser's picker returns). */
const stubPicker = (page: Page, folder: string) => page.addInitScript(name => {
  (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async (options: { mode: string }) => {
    const w = window as unknown as { __picks: string[] };
    (w.__picks ??= []).push(options?.mode);
    return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  };
}, folder);
const row = (page: Page, store: string, id: string) => page.evaluate(async ({ store, id }) => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return projectStore.row(store, id); }, { store, id });
const opfsNames = (page: Page, folder: string) => page.evaluate(async folder => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true });
  const out: Record<string, number> = {};
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) out[name] = handle.kind === 'file' ? (await (handle as FileSystemFileHandle).getFile()).size : -1;
  return out;
}, folder);

test('row 1: the sections come in the §39 order, with no plans, credits, referrals or billing, and Notifications and Security left out', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('.settings > section > h2')).toHaveText(['Profile', 'Local usage', 'AI and services', 'Storage', 'External Agent (MCP)', 'Danger Zone']);
  await expect(page.locator('#external-agent').locator('h3', { hasText: 'Allowed directories' })).toBeVisible(); // nested in the External Agent card
  await expect(page.getByRole('button', { name: 'Run setup again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete local data' })).toBeVisible();
  const text = await page.locator('.settings').innerText();
  for (const word of [/subscription/i, /\bcredits?\b/i, /referral/i, /redeem/i, /\bbilling\b(?! provider)/i, /\bupgrade\b/i, /\bcancel subscription\b/i, /notifications/i, /change password/i, /connected accounts/i]) expect(text, String(word)).not.toMatch(word);
});

test('row 1: the profile name persists across a reload and its first letter is the avatar', async ({ page }) => {
  await page.goto('/settings');
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Grace Hopper'); await name.blur();
  await expect.poll(async () => ((await row(page, 'settings', 'profile')) as { name: string } | undefined)?.name).toBe('Grace Hopper');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Grace Hopper');
  await expect(page.locator('.avatar')).toHaveText('G');
});

test('row 1: Name and Reference behaviour open once their stored values are read, so a late read cannot wipe a change', async ({ page }) => {
  await page.goto('/settings');
  const name = page.getByRole('textbox', { name: 'Name', exact: true }), toggle = page.getByRole('switch', { name: 'Reference behaviour' });
  await name.fill('Grace Hopper'); await name.blur();
  await expect.poll(() => row(page, 'settings', 'profile')).toMatchObject({ name: 'Grace Hopper' });
  await toggle.check();
  await expect.poll(() => row(page, 'settings', 'parity-mode')).toMatchObject({ enabled: true });
  // The two reads stay unanswered until __release, the way a loaded host answers them late.
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get, held: IDBRequest[] = [];
    (window as unknown as { __release: () => void }).__release = () => { for (const r of held.splice(0)) r.dispatchEvent(new Event('success')); };
    IDBObjectStore.prototype.get = function (key) {
      const r = get.call(this, key);
      if (key === 'profile' || key === 'parity-mode') r.addEventListener('success', e => { if (e.isTrusted) { e.stopImmediatePropagation(); held.push(r); } });
      return r;
    };
  });
  await page.reload();
  await expect(name).toBeDisabled(); await expect(toggle).toBeDisabled();
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(name).toBeEnabled(); await expect(name).toHaveValue('Grace Hopper');
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked();
});

test('row 1: Reference behaviour persists across a reload and is what the editor reads as its mode', async ({ page }) => {
  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: 'Reference behaviour' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(() => row(page, 'settings', 'parity-mode')).toMatchObject({ enabled: true });
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Reference behaviour' })).toBeChecked();
  expect(await page.evaluate(async () => { const s = '/src/store/database.ts', c = '/src/versions/checkpoints.ts'; const { projectStore } = await import(s); return (await import(c)).readMode(projectStore); })).toBe('parity');
  await page.getByRole('switch', { name: 'Reference behaviour' }).uncheck();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Reference behaviour' })).not.toBeChecked();
});

test('row 1: Auto backup is off by default; turning it on asks for a folder, persists, and copies a project asset into that folder; off stops copying', async ({ page }) => {
  await stubPicker(page, 't21-backup');
  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: 'Auto backup' });
  await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  expect(await row(page, 'settings', 'backup')).toBeUndefined();
  await toggle.click(); // controlled: the switch turns once the folder is picked and stored
  await expect(page.getByRole('switch', { name: 'Auto backup' })).toBeChecked();
  await expect(page.getByTestId('backup-folder')).toHaveText('t21-backup');
  expect(await page.evaluate(() => (window as unknown as { __picks: string[] }).__picks)).toEqual(['readwrite']);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Auto backup' })).toBeChecked();
  await expect(page.getByTestId('backup-folder')).toHaveText('t21-backup');
  const id = await createProject(page, richDoc(), 'T21 backup');
  const first = await addAsset(page, id, 'first.png');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByRole('button', { name: 'Backup: on' })).toBeVisible();
  const size = await page.evaluate(async a => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.row('assets', a) as { sizeBytes: number }).sizeBytes; }, first);
  await expect.poll(() => opfsNames(page, 't21-backup')).toEqual({ [`${first}-first.png`]: size });
  // off: a new asset is not copied
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Auto backup' }).click();
  await expect(page.getByRole('switch', { name: 'Auto backup' })).not.toBeChecked();
  await expect.poll(() => row(page, 'settings', 'backup')).toMatchObject({ enabled: false });
  const second = await addAsset(page, id, 'second.png');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByRole('button', { name: 'Cloud backup: local only' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(Object.keys(await opfsNames(page, 't21-backup'))).toEqual([`${first}-first.png`]);
  expect(second).not.toBe(first);
});

test('row 1: Allowed directories — Add folder stores the handle, it persists across a reload and is what the agent folder tools list', async ({ page }) => {
  await stubPicker(page, 't21-docs');
  await page.goto('/');
  await page.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('t21-docs', { create: true }); await (await d.getFileHandle('clip.png', { create: true })).createWritable().then(async w => { await w.write(new Uint8Array([1, 2, 3])); await w.close(); }); });
  await page.goto('/settings');
  await expect(page.getByText('No folders connected on this device')).toBeVisible();
  await page.getByRole('button', { name: '＋ Add folder' }).click();
  const item = page.locator('li[data-folder="t21-docs"]');
  await expect(item).toContainText('Allowed');
  await page.reload();
  await expect(page.locator('li[data-folder="t21-docs"]')).toContainText('Allowed');
  const listing = await page.evaluate(async () => { const s = '/src/store/database.ts', f = '/src/media/folders.ts'; const { projectStore } = await import(s); return (await import(f)).listAllowedDir(projectStore, 't21-docs'); });
  expect(listing).toMatchObject({ success: true, entries: [{ name: 'clip.png', kind: 'file', type: 'image', sizeBytes: 3 }] });
});

test('row 1: model connections, the default model, a per-job model, the speech provider and stock keys persist across a reload with their stated effect', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: '＋ Add connection' }).click();
  const form = page.getByRole('form', { name: 'Add a model connection' });
  await form.getByLabel('Name').fill('Local llama');
  await form.getByLabel('Base URL').fill('http://127.0.0.1:9/v1');
  await form.getByLabel('API key').fill('sk-t21-row1-secret');
  await form.getByRole('button', { name: 'Add connection' }).click();
  const connection = page.locator('li[data-connection="Local llama"]');
  await expect(connection).toContainText('Key saved');
  await expect(page.getByText('No default model.')).toBeVisible(); // the no-key state names what keeps working
  await page.getByRole('combobox', { name: 'Default model connection' }).selectOption({ label: 'Local llama' });
  await page.getByRole('textbox', { name: 'Default model model' }).fill('tiny-chat');
  await page.getByText('Use another model for a job').click();
  await page.getByRole('combobox', { name: 'Project titles connection' }).selectOption({ label: 'Local llama' });
  await page.getByRole('textbox', { name: 'Project titles model' }).fill('tiny-title');
  await page.getByRole('combobox', { name: 'Transcribe with' }).selectOption('elevenlabs');
  await page.getByRole('textbox', { name: 'ElevenLabs API key' }).fill('el-t21-row1-secret');
  await page.getByRole('button', { name: 'Save key' }).click();
  await page.getByRole('textbox', { name: 'Pexels API key' }).fill('px-t21-row1-secret');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.getByRole('textbox', { name: 'Pexels API key' })).toHaveAttribute('placeholder', 'Key saved');
  await expect.poll(async () => JSON.stringify(await row(page, 'settings', 'providers'))).toContain('tiny-title');
  await page.reload();
  await expect(page.locator('li[data-connection="Local llama"]')).toContainText('Key saved');
  await expect(page.getByRole('combobox', { name: 'Default model connection' })).toHaveValue(/.+/);
  await expect(page.getByRole('textbox', { name: 'Default model model' })).toHaveValue('tiny-chat');
  await page.getByText('Use another model for a job').click();
  await expect(page.getByRole('textbox', { name: 'Project titles model' })).toHaveValue('tiny-title');
  await expect(page.getByRole('combobox', { name: 'Transcribe with' })).toHaveValue('elevenlabs');
  await expect(page.getByRole('textbox', { name: 'ElevenLabs API key' })).toHaveAttribute('placeholder', 'Key saved');
  await expect(page.getByRole('textbox', { name: 'Pexels API key' })).toHaveAttribute('placeholder', 'Key saved');
  await expect(page.getByRole('textbox', { name: 'Unsplash API key' })).toHaveAttribute('placeholder', 'API key');
  // the stated effect: the chat model is what Local usage reports, and the job model is what the job resolves to
  await expect(page.getByTestId('usage-ai')).toContainText('Local llama · tiny-chat');
  expect(await page.evaluate(async () => { const s = '/src/store/database.ts', p = '/src/settings/providers.ts'; const { projectStore } = await import(s); const m = await import(p); const settings = await m.readProviders(projectStore); return [m.modelFor(settings, 'chat')?.model, m.modelFor(settings, 'title')?.model, m.modelFor(settings, 'repair')?.model]; })).toEqual(['tiny-chat', 'tiny-title', 'tiny-chat']);
  // Remove drops the connection and every model choice that used it
  await page.locator('li[data-connection="Local llama"]').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('li[data-connection="Local llama"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('No model connections.')).toBeVisible();
  await expect(page.getByTestId('usage-ai')).toHaveText('No provider connected');
});

test('row 1: Delete local data, confirmed, removes projects, media, OPFS files, keys and settings and leaves an empty app', async ({ page }) => {
  await page.goto('/settings');
  const id = await createProject(page, richDoc(), 'Doomed project');
  const asset = await addAsset(page, id, 'doomed.png');
  await page.goto('/settings');
  await page.evaluate(async () => {
    const s = '/src/store/database.ts', k = '/src/settings/secrets.ts'; const { projectStore } = await import(s); const secrets = await import(k);
    await secrets.putSecret('model:doomed', 'sk-t21-doomed-key', 'https://api.example.com');
    await projectStore.putRow('settings', { id: 'profile', name: 'Doomed' });
    localStorage.setItem('cutframe:agent-link:v1', '{"port":47820,"auto":false}');
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe', { create: true }); await d.getDirectoryHandle('exports', { create: true });
  });
  const before = await page.evaluate(async () => { const s = '/src/store/database.ts'; const { projectStore } = await import(s); return { projects: (await projectStore.list()).length, assets: (await projectStore.library()).assets.length, root: await (Array as any).fromAsync((await navigator.storage.getDirectory() as any).keys()) }; });
  expect(before).toMatchObject({ projects: 1, assets: 1 });
  expect(before.root).toContain('cutframe');
  await page.getByRole('button', { name: 'Delete local data' }).click();
  await page.getByRole('dialog', { name: 'Delete local data' }).getByRole('button', { name: 'Delete everything' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
  const after = await page.evaluate(async asset => {
    const s = '/src/store/database.ts', k = '/src/settings/secrets.ts'; const { projectStore } = await import(s); const secrets = await import(k);
    const root = await (Array as any).fromAsync((await navigator.storage.getDirectory() as any).keys());
    const media = root.includes('cutframe') ? await (Array as any).fromAsync(await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe')).keys() as any) : [];
    return { projects: (await projectStore.list()).length, assets: (await projectStore.library()).assets.length, assetRow: await projectStore.row('assets', asset), profile: await projectStore.row('settings', 'profile'), providers: await projectStore.row('settings', 'providers'),
      secret: await secrets.getSecret('model:doomed', 'https://api.example.com'), hasSecret: await secrets.hasSecret('model:doomed'), link: localStorage.getItem('cutframe:agent-link:v1'), media };
  }, asset);
  expect(after).toMatchObject({ projects: 0, assets: 0, assetRow: undefined, profile: undefined, providers: undefined, secret: undefined, hasSecret: false, link: null });
  expect(after.media, 'OPFS files under cutframe/').toEqual([]);
  await page.reload();
  await expect(page.getByText('Doomed project')).toHaveCount(0);
  expect(await page.evaluate(async () => { const s = '/src/store/database.ts'; const { projectStore } = await import(s); return (await projectStore.list()).length; })).toBe(0);
});
