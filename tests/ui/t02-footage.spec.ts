// SPDX-License-Identifier: AGPL-3.0-only
// T02 owned acceptance F1–F4 (Footage tab, part 3 §46.16) with a tiny valid PNG uploaded through the real store (no ffmpeg needed). Placement on
// the timeline is T03's: the thumbnail click must dispatch placeAssets and say so; nothing is appended.
import { test, expect, type Page } from '@playwright/test';
import { addAsset, assetCount, clip, createProject, expectUntouched, guard, intents, linkedCount, linkClip, notices, richDoc, skipTour, stored, TINY_PNG, watchIntents } from './t02-support';
import { itemById, liveDoc, savedDoc, undoEntries } from './t03-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

async function footageProject(page: Page) {
  const id = await createProject(page, richDoc(), 'Footage fixture'); const asset = await addAsset(page, id, 'footage.png'); await linkClip(page, id, asset, 'clipA');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); await watchIntents(page);
  return { id, asset, before: await stored(page, id) };
}
const footage = (page: Page) => page.getByRole('region', { name: 'Footage', exact: true });

test('F1 × removes the asset from the project list at once (no dialog); the timeline clip that uses it stays', async ({ page }) => {
  let dialogs = 0; page.on('dialog', d => { dialogs++; void d.dismiss(); });
  const { id, asset, before } = await footageProject(page); await expect(footage(page).getByRole('list', { name: 'In project' }).getByRole('listitem')).toHaveCount(1);
  await expect(clip(page, 'clipA')).toBeVisible();
  await footage(page).getByRole('button', { name: 'Remove footage.png from this project' }).click();
  await expect(footage(page).getByText('No footage in this project yet.')).toBeVisible(); await expect(notices(page)).toContainText('footage.png removed from this project.'); expect(dialogs).toBe(0);
  expect(await linkedCount(page, id)).toBe(0); expect(await assetCount(page)).toBe(1); // removed from the project list only; the library keeps the file
  await expect(clip(page, 'clipA')).toBeVisible(); expect(await page.evaluate(async id => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.read(id)).document.items.find((i: any) => i.id === 'clipA').metadata.assetId; }, id)).toBe(asset);
  expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
});

test('F2 the eye opens a preview that adds nothing; × and Esc close it', async ({ page }) => {
  const { id, before } = await footageProject(page); const assets = await assetCount(page), linked = await linkedCount(page, id);
  await footage(page).getByRole('button', { name: 'Preview footage.png' }).click(); const dialog = page.getByRole('dialog', { name: 'footage.png' }); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'footage.png' })).toBeVisible(); await dialog.getByRole('button', { name: 'Close footage.png' }).click(); await expect(dialog).toHaveCount(0);
  await footage(page).getByRole('button', { name: 'Preview footage.png' }).click(); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(await assetCount(page)).toBe(assets); expect(await linkedCount(page, id)).toBe(linked); expect(await intents(page)).toEqual([]); await expect(page.locator('[data-item-id]')).toHaveCount(5); await expectUntouched(page, id, before);
});

test('F3 the folder button opens the library picker "Your Assets" (never an OS dialog); Done attaches newly checked assets and only adds', async ({ page }) => {
  const { id, before } = await footageProject(page); let chooser = false; page.on('filechooser', () => { chooser = true; });
  const other = await page.evaluate(async png => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0)); const a = await projectStore.upload(new File([bytes], 'library-only.png', { type: 'image/png' })); await projectStore.updateAsset(a.id, (x: any) => ({ ...x, processing_status: 'ready' })); return a.id as string; }, TINY_PNG);
  await footage(page).getByRole('button', { name: 'Add from your library' }).click(); const dialog = page.getByRole('dialog', { name: 'Your Assets' }); await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Select footage.png')).toBeChecked(); await expect(dialog.getByLabel('Select library-only.png')).not.toBeChecked(); // a check mark on assets already in the project
  await dialog.getByLabel('Select library-only.png').check(); await dialog.getByLabel('Select footage.png').uncheck(); await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0); await expect(notices(page)).toContainText('Added 1 asset from your library to this project.');
  await expect(footage(page).getByRole('list', { name: 'In project' }).getByRole('listitem')).toHaveCount(2); // unchecking an existing one removed nothing: × is the only remover
  expect(await linkedCount(page, id)).toBe(2); expect(chooser).toBe(false);
  // Cancelling the picker (×) changes nothing.
  await footage(page).getByRole('button', { name: 'Add from your library' }).click(); await page.getByRole('dialog', { name: 'Your Assets' }).getByRole('button', { name: 'Close Your Assets' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); expect(await linkedCount(page, id)).toBe(2); expect(chooser).toBe(false);
  expect(other).toBeTruthy(); expect(await intents(page)).toEqual([]); await expectUntouched(page, id, before);
});

test('F4 a thumbnail click appends the clip (placeAssets → ok, one "Add items" step) and the thumbnail drags as kind "assets"', async ({ page }) => {
  const leaks = guard(page); const { id, asset, before } = await footageProject(page);
  await footage(page).getByRole('button', { name: 'Add footage.png to the timeline' }).click();
  const log = await intents(page); expect(log).toHaveLength(1); expect(log[0].intent).toEqual({ type: 'placeAssets', assetIds: [asset], name: 'footage.png' }); expect(log[0].outcome).toEqual({ ok: true });
  // T03 (was: NOT_IMPLEMENTED, nothing appended): the image lands after the last clip of the lowest video track that has clips (V1 ends at 16 s), 5 s long, as one "Add items" step.
  await expect(page.locator('[data-item-id]')).toHaveCount(6); await expect(notices(page)).not.toContainText('not yet implemented');
  const placed = await liveDoc(page); const added = placed.items.filter((i: any) => i.metadata?.assetId === asset && i.id !== 'clipA'); expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ type: 'image', trackId: 'v1', display: { from: 16000, to: 21000 } }); expect(placed.items).toHaveLength(6); expect(placed.duration).toBe(21000); expect(itemById(placed, 'clipB').display).toEqual({ from: 8000, to: 16000 });
  expect(await undoEntries(page)).toEqual([{ label: 'Add items', source: 'user' }]);
  const payload = await footage(page).getByRole('button', { name: 'Add footage.png to the timeline' }).evaluate(el => {
    const data = new DataTransfer(); el.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }));
    return { types: Array.from(data.types), raw: data.getData('application/x-cutframe-timeline'), draggable: (el as HTMLElement).draggable };
  });
  expect(payload.draggable).toBe(true); expect(payload.types).toEqual(['application/x-cutframe-timeline']); expect(JSON.parse(payload.raw)).toEqual({ kind: 'assets', items: [{ assetId: asset, type: 'image', name: 'footage.png' }] });
  await expect(page.getByRole('button', { name: 'Add footage.png to the timeline' })).toBeVisible(); expect(await intents(page)).toHaveLength(1); expect(leaks).toEqual([]);
  const saved = await savedDoc(page, id); expect(saved.items).toHaveLength(6); expect(JSON.parse(before.json).items).toHaveLength(5); expect(saved.rev).toBeGreaterThan(before.rev); // saved after the ~3 s debounce
});

test('F4 dragging a footage thumbnail onto a lane, below the tracks and onto the preview places the asset (three "Add items" steps)', async ({ page }) => {
  const { id, asset, before } = await footageProject(page);
  const dragTo = (selector: string) => footage(page).getByRole('button', { name: 'Add footage.png to the timeline' }).evaluate((thumb, selector) => {
    const data = new DataTransfer(); thumb.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true })); const target = document.querySelector(selector)!, b = target.getBoundingClientRect();
    const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: b.left + 60, clientY: b.top + 5 }; target.dispatchEvent(new DragEvent('dragover', init)); target.dispatchEvent(new DragEvent('drop', init));
  }, selector);
  const added = async () => (await liveDoc(page)).items.filter((i: any) => i.metadata?.assetId === asset && i.id !== 'clipA');
  await dragTo('.lane[data-track-id="v2"]'); const a1 = await added(); await dragTo('.drop-below'); const a2 = await added(); await dragTo('[aria-label="Preview"]'); const a3 = await added();
  const log = await intents(page); expect(log).toHaveLength(3);
  for (const l of log) { expect(l.intent).toMatchObject({ type: 'drop', payload: { kind: 'assets', items: [{ assetId: asset, type: 'image', name: 'footage.png' }] } }); expect(l.outcome).toEqual({ ok: true }); }
  expect(log.map(l => [l.intent.trackId, l.intent.below])).toEqual([['v2', false], [null, true], [null, false]]);
  // T03 (was: NOT_IMPLEMENTED ×3, document untouched). Provisional placement table: a compatible lane appends at that lane's end (V2: after clipC, 6 s; the image is 5 s);
  // below the tracks makes a new track at the bottom of the root stack with the clip at the drop time; the preview uses the click rule (lowest video track that has clips).
  expect(a1).toHaveLength(1); expect(a1[0]).toMatchObject({ type: 'image', trackId: 'v2', display: { from: 6000, to: 11000 } });
  expect(a2).toHaveLength(2); const below = a2.find((i: any) => i.id !== a1[0].id); expect(below.display.from).toBeCloseTo(log[1].intent.timeMs, 0); expect(below.display.to - below.display.from).toBe(5000);
  const doc = await liveDoc(page); expect(doc.layerOrder[0]).toEqual({ type: 'track', id: below.trackId }); expect(doc.tracks.find((t: any) => t.id === below.trackId)).toMatchObject({ kind: 'video' });
  expect(a3).toHaveLength(3); const third = a3.find((i: any) => ![a1[0].id, below.id].includes(i.id)); expect(third.type).toBe('image'); expect(third.trackId).toBe(below.trackId); expect(third.display.from).toBe(below.display.to);
  expect(doc.items).toHaveLength(8); expect(await undoEntries(page)).toEqual([{ label: 'Add items', source: 'user' }, { label: 'Add items', source: 'user' }, { label: 'Add items', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(saved.items).toHaveLength(8); expect(JSON.parse(before.json).items).toHaveLength(5);
});

test('Footage search runs on Enter only (T19 search); the Upload button opens the OS chooser and adds the file to the project list', async ({ page }) => {
  const { id, before } = await footageProject(page); const search = footage(page).getByLabel('Search footage');
  // T19 (was: a NOT_IMPLEMENTED notice): the search runs in the analysis service. UI runs have no models, so the service is replaced by a counter with no rows.
  await page.evaluate(async () => { const p = '/src/analysis/service.ts'; const { analysisService } = await import(p); (window as any).searches = []; analysisService.search = async (_store: unknown, request: { query: string }) => { (window as any).searches.push(request); return { query: request.query, results: [], metadata: { totalResults: 0, sources: { embedding: 0, filename: 0 } } }; }; });
  const searches = () => page.evaluate(() => (window as any).searches);
  await search.fill('sunset'); expect(await intents(page)).toEqual([]); expect(await searches()).toEqual([]);
  await search.fill(''); await search.press('Enter'); await search.fill('   '); await search.press('Enter'); expect(await searches()).toEqual([]);
  await search.fill('sunset'); await search.press('Enter'); await expect(footage(page).getByText('No clips match your search')).toBeVisible();
  expect(await searches()).toEqual([{ query: 'sunset', projectId: id, mode: 'general', options: { threshold: 'medium', limit: 30 } }]); expect(await intents(page)).toEqual([]);
  await search.fill(''); await expect(footage(page).getByRole('list', { name: 'In project' })).toBeVisible(); // an empty query clears
  await expectUntouched(page, id, before);
  const chooser = page.waitForEvent('filechooser'); await footage(page).getByRole('button', { name: 'Upload', exact: true }).click();
  await (await chooser).setFiles({ name: 'second.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64') });
  await expect(footage(page).getByRole('list', { name: 'In project' })).toContainText('second.png', { timeout: 15000 }); expect(await linkedCount(page, id)).toBe(2);
});
