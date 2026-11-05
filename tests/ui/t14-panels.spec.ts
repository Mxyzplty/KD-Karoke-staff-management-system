// SPDX-License-Identifier: AGPL-3.0-only
// T14 acceptance 8, 10, 11 in real Chromium. Every provider request is answered by a route; any other off-host request
// fails the test (no real network to Pexels, Unsplash or Freesound).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable, media } from '../media-fixtures';
import { liveDoc, savedDoc, undoEntries } from './t03-support';

test.skip(!ffmpegAvailable(), 'ffmpeg generates the test media');
const PROVIDERS = /^(api\.pexels\.com|images\.pexels\.com|api\.unsplash\.com|images\.unsplash\.com|freesound\.org|cdn\.freesound\.org|player\.example)$/;
function guard(page: Page) {
  const leaks: string[] = [];
  page.on('request', r => { const host = new URL(r.url()).hostname; if (!['127.0.0.1', 'localhost'].includes(host) && !PROVIDERS.test(host) && !/^(data|blob):/.test(r.url())) leaks.push(r.url()); });
  return leaks;
}
const png = readFileSync(media('still.png')), mp4 = readFileSync(media('h264-aac.mp4')), mp3 = readFileSync(media('tone.mp3'));
async function mockProviders(page: Page, options: { failDownloads?: boolean } = {}) {
  const requests: string[] = [];
  await page.route(url => PROVIDERS.test(url.hostname), async route => {
    const url = new URL(route.request().url()); requests.push(url.href); const page_ = Number(url.searchParams.get('page') ?? 1);
    if (options.failDownloads && /images\.|cdn\.|player\./.test(url.hostname)) return route.abort('internetdisconnected');
    if (url.pathname === '/v1/curated' || url.pathname === '/v1/search') return route.fulfill({ json: { photos: Array.from({ length: 10 }, (_, i) => ({ id: page_ * 100 + i, width: 32, height: 24, url: 'https://www.pexels.com/p', photographer: `Pex ${i}`, alt: `pexels ${page_ * 100 + i}`, src: { original: `https://images.pexels.com/${i}.png`, medium: `https://images.pexels.com/${i}-m.png` } })), next_page: page_ < 3 ? 'n' : undefined } });
    if (url.pathname === '/photos' || url.pathname === '/search/photos') { const list = Array.from({ length: 10 }, (_, i) => ({ id: `u${page_ * 100 + i}`, width: 32, height: 24, alt_description: `unsplash ${page_ * 100 + i}`, user: { name: `Uns ${i}` }, urls: { full: `https://images.unsplash.com/${i}.png`, small: `https://images.unsplash.com/${i}-s.png` }, links: { html: 'https://unsplash.com/p', download_location: `https://api.unsplash.com/photos/u${i}/download` } })); return route.fulfill({ json: url.pathname === '/photos' ? list : { results: list, total_pages: 3 } }); }
    if (url.pathname === '/v1/videos/search') return route.fulfill({ json: { videos: Array.from({ length: 15 }, (_, i) => ({ id: page_ * 100 + i, width: 320, height: 180, duration: 1, url: 'https://www.pexels.com/v', image: `https://images.pexels.com/v${i}.png`, user: { name: `Vid ${i}` }, video_files: [{ file_type: 'video/mp4', width: 320, height: 180, link: `https://player.example/v${page_ * 100 + i}.mp4` }] })), next_page: 'n' } });
    if (url.pathname === '/apiv2/search/') return route.fulfill({ json: { results: Array.from({ length: 15 }, (_, i) => ({ id: page_ * 100 + i, name: `Sound ${page_ * 100 + i}`, duration: 2.345, username: `fs${i}`, tags: ['door', 'wood', 'slam', 'extra'], license: 'Creative Commons 0', url: 'https://freesound.org/s', previews: { 'preview-hq-mp3': `https://cdn.freesound.org/p${i}.mp3` } })), next: 'n' } });
    if (/\/download$/.test(url.pathname)) return route.fulfill({ json: { url: 'ok' } });
    if (/\.png$/.test(url.pathname)) return route.fulfill({ body: png, contentType: 'image/png' });
    if (/\.mp3$/.test(url.pathname)) return route.fulfill({ body: mp3, contentType: 'audio/mpeg' });
    return route.fulfill({ body: mp4, contentType: 'video/mp4' });
  });
  return requests;
}
async function openProject(page: Page) {
  await page.goto('/'); const id = await page.evaluate(async () => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.create('Stock fixture')).id as string; });
  await page.goto(`/project/${id}`); return id;
}
const notices = (page: Page) => page.getByRole('region', { name: 'Notifications' });
test('stock: no-key state with the cost line, keys saved locally; photos curated + interleaved 20 per page with Load More; image click adds nothing', async ({ page }) => {
  const leaks = guard(page), requests = await mockProviders(page); await openProject(page);
  await page.getByRole('tab', { name: 'Photos', exact: true }).click();
  const keys = page.getByRole('group', { name: 'Stock keys' });
  await expect(keys).toContainText('Add a free key'); await expect(keys).toContainText('the provider’s own request limits apply'); expect(requests).toEqual([]);
  await page.getByLabel('Pexels API key').fill('pk'); await page.getByRole('button', { name: 'Save Pexels key' }).click();
  await page.getByRole('tab', { name: 'Videos', exact: true }).click(); await page.getByRole('tab', { name: 'Photos', exact: true }).click();
  const results = page.getByRole('list', { name: 'Photo results' }).getByRole('listitem');
  await expect(results).toHaveCount(10); // Pexels only: half a page
  await page.evaluate(async () => { const p = '/src/media/stock.ts', s = '/src/store/database.ts'; await (await import(p)).saveKey((await import(s)).projectStore, 'unsplash', 'uk'); });
  await page.getByRole('tab', { name: 'Videos', exact: true }).click(); await page.getByRole('tab', { name: 'Photos', exact: true }).click();
  await expect(results).toHaveCount(20);
  expect(await results.evaluateAll(items => items.slice(0, 4).map(i => (i as HTMLElement).dataset.provider))).toEqual(['pexels', 'unsplash', 'pexels', 'unsplash']);
  const seen = requests.length; await page.getByRole('button', { name: 'Load More' }).click(); await expect(results).toHaveCount(40);
  expect(requests.slice(seen).map(r => [new URL(r).pathname, new URL(r).searchParams.get('page'), new URL(r).searchParams.get('per_page')])).toEqual([['/v1/curated', '2', '10'], ['/photos', '2', '10']]);
  const before = await page.evaluate(async () => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.library()).assets.length; });
  await results.first().locator('img').click();
  expect(await page.evaluate(async () => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.library()).assets.length; })).toBe(before);
  expect(leaks).toEqual([]);
});
test('stock videos (15, duration badge, Load More) and sounds (15 rows: play · title · "2.3s" · by author · 3 tags); preview adds nothing; title/tile click adds once; T03 placement seam', async ({ page }) => {
  const leaks = guard(page); await mockProviders(page); const id = await openProject(page);
  await page.evaluate(async () => { const p = '/src/media/stock.ts', s = '/src/store/database.ts'; const { saveKey } = await import(p), { projectStore } = await import(s); await saveKey(projectStore, 'pexels', 'pk'); await saveKey(projectStore, 'freesound', 'fk'); });
  await page.getByRole('tab', { name: 'Videos', exact: true }).click(); await page.getByLabel('Search videos').fill('sea'); await page.getByLabel('Search videos').press('Enter');
  const tiles = page.getByRole('list', { name: 'Video results' }).getByRole('listitem'); await expect(tiles).toHaveCount(15);
  await expect(tiles.first().locator('.badge.duration')).toHaveText('0:01'); await page.getByRole('button', { name: 'Load More' }).click(); await expect(tiles).toHaveCount(30);
  await tiles.first().getByRole('button').click();
  await expect(notices(page)).toContainText('Video added to the project footage');
  // T03 (was: "on the timeline is not yet implemented (T03)"): the downloaded clip is placed on a video track as one "Add items" step.
  await expect.poll(async () => (await liveDoc(page)).items.length).toBe(1); let doc = await liveDoc(page);
  // Click rule (notes, Provisional choices "UI click placement"): no track holds clips yet, so the lowest empty track of the kind at 0 - a video track from 0. The mocked download is not decodable media, so the source duration is unknown and the item takes the 5 s fallback (UNKNOWN_SOURCE_MS).
  expect(doc.tracks.find((t: any) => t.id === doc.items[0].trackId).kind).toBe('video'); expect(doc.items[0].type).toBe('video'); expect(doc.items[0].display).toEqual({ from: 0, to: 5000 }); expect(await undoEntries(page)).toEqual([{ label: 'Add items', source: 'user' }]);
  expect((await savedDoc(page, id)).items).toHaveLength(1);
  await page.getByRole('tab', { name: 'Sounds', exact: true }).click(); await page.getByLabel('Search sounds').fill('door'); await page.getByLabel('Search sounds').press('Enter');
  const rows = page.getByRole('list', { name: 'Sound results' }).getByRole('listitem'); await expect(rows).toHaveCount(15);
  await expect(rows.first()).toContainText('Sound 100'); await expect(rows.first()).toContainText('2.3s'); await expect(rows.first()).toContainText('by fs0'); await expect(rows.first().locator('.tag')).toHaveText(['door', 'wood', 'slam']);
  const count = () => page.evaluate(async () => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.library()).assets.length; });
  const assetsBefore = await count();
  await page.evaluate(() => { (window as unknown as { played: number[] }).played = []; HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { (window as unknown as { played: number[] }).played.push(this.volume); return Promise.resolve(); }; });
  await rows.nth(0).getByRole('button', { name: 'Play Sound 100' }).click(); await expect(rows.nth(0).getByRole('button', { name: 'Stop Sound 100' })).toBeVisible();
  await rows.nth(1).getByRole('button', { name: 'Play Sound 101' }).click(); await expect(rows.nth(0).getByRole('button', { name: 'Play Sound 100' })).toBeVisible();
  await rows.nth(1).getByRole('button', { name: 'Stop Sound 101' }).click(); await expect(rows.nth(1).getByRole('button', { name: 'Play Sound 101' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { played: number[] }).played)).toEqual([0.5, 0.5]); expect(await count()).toBe(assetsBefore);
  await rows.nth(2).getByRole('button', { name: 'Add sound Sound 102' }).click(); await expect(notices(page)).toContainText('Sound added to the project footage');
  await expect.poll(count).toBe(assetsBefore + 1);
  // T03: the sound lands on an audio track as a second "Add items" step.
  await expect.poll(async () => (await liveDoc(page)).items.length).toBe(2); doc = await liveDoc(page); expect(doc.items[1].type).toBe('audio'); expect(doc.tracks.find((t: any) => t.id === doc.items[1].trackId).kind).toBe('audio'); expect(doc.items[1].trackId).not.toBe(doc.items[0].trackId); expect(doc.items[1].display).toEqual({ from: 0, to: 5000 }); // the first audio track is empty, so 0; unknown source duration, 5 s fallback
  expect(await undoEntries(page)).toEqual([{ label: 'Add items', source: 'user' }, { label: 'Add items', source: 'user' }]);
  await rows.nth(2).getByRole('button', { name: 'Add sound Sound 102' }).click(); await expect(notices(page)).toContainText('Already in project');
  expect(await count()).toBe(assetsBefore + 1);
  const linked = await page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); const lib = (await projectStore.library()).assets; return (await projectStore.projectAssets(id)).map((l: any) => ({ agent: l.agent_id, source: lib.find((a: any) => a.id === l.assetId).source })); }, id);
  expect(linked).toEqual([{ agent: 'video_1', source: expect.objectContaining({ kind: 'stock', provider: 'pexels', attribution: 'Video by Vid 0 on Pexels', licence: 'Pexels License' }) },
    { agent: 'audio_1', source: expect.objectContaining({ kind: 'stock', provider: 'freesound', providerId: '102', licence: 'Creative Commons 0', author: 'fs2' }) }]);
  expect(leaks).toEqual([]);
});
test('stock download failure surfaces UPLOAD_NETWORK_ERROR', async ({ page }) => {
  await mockProviders(page, { failDownloads: true }); await openProject(page);
  await page.evaluate(async () => { const p = '/src/media/stock.ts', s = '/src/store/database.ts'; await (await import(p)).saveKey((await import(s)).projectStore, 'freesound', 'fk'); });
  await page.getByRole('tab', { name: 'Sounds', exact: true }).click(); await page.getByLabel('Search sounds').fill('door'); await page.getByLabel('Search sounds').press('Enter');
  await page.getByRole('button', { name: 'Add sound Sound 100' }).click(); await expect(notices(page)).toContainText('UPLOAD_NETWORK_ERROR');
});
test('allowed folders through an OPFS directory handle: one-level listing, filter, limit + truncated, path validator, import as footage', async ({ page }) => {
  const id = await openProject(page), clip = Array.from(readFileSync(media('undated.mp4')));
  const result = await page.evaluate(async ({ id, clip }) => {
    const f = '/src/media/folders.ts', s = '/src/store/database.ts'; const { addFolder, listAllowedDir, importFromAllowedDir } = await import(f), { projectStore } = await import(s);
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Clips', { create: true });
    const write = async (dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array<ArrayBuffer> | string) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(bytes); await w.close(); };
    await write(root, 'a.mp4', new Uint8Array(clip) as Uint8Array<ArrayBuffer>); await write(root, 'notes.txt', 'text'); await write(root, 'b.png', 'png');
    const sub = await root.getDirectoryHandle('day 1', { create: true }); for (let i = 0; i < 5; i++) await write(sub, `clip${i}.mov`, 'x');
    const none = await listAllowedDir(projectStore, '');
    await addFolder(projectStore, root);
    return {
      none, top: await listAllowedDir(projectStore, ''), level: await listAllowedDir(projectStore, 'Clips'), withOther: await listAllowedDir(projectStore, 'Clips', ['video', 'image', 'audio', 'other']),
      limited: await listAllowedDir(projectStore, 'Clips/day 1', undefined, 3), missing: await listAllowedDir(projectStore, 'Clips/nope'), notDir: await listAllowedDir(projectStore, 'Clips/a.mp4'),
      unknown: await listAllowedDir(projectStore, 'Other/x'), traversal: await listAllowedDir(projectStore, 'Clips/../x'), absolute: await listAllowedDir(projectStore, '/Clips'),
      imported: await importFromAllowedDir(projectStore, id, ['Clips/a.mp4', 'Clips/notes.txt', 'Clips/day 1', 'Clips/gone.mp4', '../a.mp4', 'Elsewhere/a.mp4'], { prepare: false }),
      noPaths: await importFromAllowedDir(projectStore, id, []), noProject: await importFromAllowedDir(projectStore, null, ['Clips/a.mp4']),
      links: (await projectStore.projectAssets(id)).map((l: { agent_id: string }) => l.agent_id),
    };
  }, { id, clip });
  expect(result.none).toMatchObject({ success: false, error: 'allowed_dir_not_configured' });
  expect(result.top).toMatchObject({ success: true, directories: ['Clips'] });
  expect(result.level).toMatchObject({ success: true, truncated: false, entries: [{ name: 'day 1', kind: 'directory' }, { name: 'a.mp4', type: 'video' }, { name: 'b.png', type: 'image' }] });
  expect((result.withOther as { entries: unknown[] }).entries).toHaveLength(4);
  expect(result.limited).toMatchObject({ success: true, truncated: true }); expect((result.limited as { entries: unknown[] }).entries).toHaveLength(3);
  expect(result.missing).toMatchObject({ error: 'path_not_found', message: "Directory 'Clips/nope' not found." });
  expect(result.notDir).toMatchObject({ error: 'path_not_a_directory' });
  expect(result.unknown).toMatchObject({ error: 'folder_not_found' }); expect(result.traversal).toMatchObject({ error: 'path_traversal_blocked' }); expect(result.absolute).toMatchObject({ error: 'path_traversal_blocked' });
  expect(result.imported).toMatchObject({ success: true, imported: [expect.any(String)] });
  expect((result.imported as { failed: { path: string; error: string }[] }).failed.map(f => [f.path, f.error])).toEqual([
    ['Clips/notes.txt', 'unsupported_type'], ['Clips/day 1', 'path_not_a_file'], ['Clips/gone.mp4', 'file_not_found'], ['../a.mp4', 'path_traversal_blocked'], ['Elsewhere/a.mp4', 'folder_not_found']]);
  expect(result.noPaths).toMatchObject({ success: false, error: 'no_paths' }); expect(result.noProject).toMatchObject({ success: false, error: 'no_project' });
  expect(result.links).toEqual(['video_1']);
});
test('missing original: Library shows Missing; relink with different bytes → WORKSPACE_ORIGINAL_MISMATCH; with the original → restored', async ({ page }) => {
  await page.goto('/assets'); await page.getByLabel('Upload media').setInputFiles(media('undated.mp4')); await expect(page.getByText('undated.mp4', { exact: true })).toBeVisible();
  await expect(page.locator('.badge.status').filter({ hasText: /Processing|Uploading/ })).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); const [a] = (await projectStore.library()).assets; const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe')).getDirectoryHandle('media'); await dir.removeEntry(a.id); });
  await page.reload(); await expect(page.locator('.badge.status')).toContainText('Missing');
  page.once('filechooser', chooser => void chooser.setFiles(media('h264-aac.mp4')));
  await page.getByRole('button', { name: 'Relink undated.mp4' }).click(); await expect(notices(page)).toContainText('WORKSPACE_ORIGINAL_MISMATCH');
  page.once('filechooser', chooser => void chooser.setFiles(media('undated.mp4')));
  await page.getByRole('button', { name: 'Relink undated.mp4' }).click(); await expect(notices(page)).toContainText('linked to its original again');
  await expect(page.locator('.badge.status').filter({ hasText: 'Missing' })).toHaveCount(0);
});
test('references: the same file twice is reused by hash (also after delete); "N saved" chip in the wizard; attach at Create; no-provider analysis state', async ({ page }) => {
  const id = await openProject(page); await page.getByRole('tab', { name: 'Reference', exact: true }).click();
  const input = page.getByLabel('Upload a reference video');
  await input.setInputFiles(media('h264-aac.mp4')); await expect(notices(page)).toContainText('Saved reference');
  await input.setInputFiles(media('h264-aac.mp4')); await expect(notices(page)).toContainText('Reused your saved reference');
  const list = page.getByRole('list', { name: 'Saved references' });
  await expect(list.getByRole('listitem')).toHaveCount(1); await expect(list).toContainText('Not analysed — no AI provider connected'); await expect(page.getByText('1 saved', { exact: true })).toBeVisible();
  await list.getByRole('button', { name: 'Attach' }).click(); await expect(list.getByRole('button', { name: 'Detach' })).toBeVisible();
  await list.getByRole('button', { name: /Retry analysis/ }).click(); await expect(notices(page)).toContainText('needs an AI provider');
  page.once('dialog', d => { expect(d.message()).toContain('removed from every project it is attached to'); void d.accept(); });
  await list.getByRole('button', { name: /Delete reference/ }).click(); await expect(page.getByText('No reference videos yet.')).toBeVisible();
  const afterDelete = await page.evaluate(async id => { const r = '/src/media/references.ts', s = '/src/store/database.ts'; return (await (await import(r)).projectReferences((await import(s)).projectStore, id)).length; }, id);
  expect(afterDelete).toBe(0);
  await input.setInputFiles(media('h264-aac.mp4')); await expect(notices(page)).toContainText('Reused your saved reference');
  await expect(list.getByRole('listitem')).toHaveCount(1); // review R13: the restore has committed (the panel lists it again); line 138's identical notice cannot stand in for it
  await page.goto('/'); await page.getByRole('button', { name: '＋ New Video', exact: true }).click(); await page.getByRole('button', { name: 'From your library', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Reference library' }); await expect(library.getByText('1 saved', { exact: true })).toBeVisible();
  await library.getByRole('button', { name: 'h264-aac.mp4' }).click(); await expect(page.getByText('From your library', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click(); await page.getByRole('button', { name: 'Create Project', exact: true }).click(); await expect(page).toHaveURL(/\/project\/[^/]+$/);
  const attached = await page.evaluate(async () => { const r = '/src/media/references.ts', s = '/src/store/database.ts'; const { projectStore } = await import(s); const p = (await projectStore.list())[0]; return (await (await import(r)).projectReferences(projectStore, p.id)).map((x: { name: string }) => x.name); });
  expect(attached).toEqual(['h264-aac.mp4']);
});
