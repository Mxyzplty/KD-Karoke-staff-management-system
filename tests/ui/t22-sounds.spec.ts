// SPDX-License-Identifier: AGPL-3.0-only
// T22 plan lines 177 and 253: the Sounds panel's "Built-in" list of the bundled catalogue. It needs no key and no network;
// a title click adds the sound as a stock sound is added (T14's click rule: an audio item from 0 s; with no audio track
// yet, on a new one). Oracle: the plan text and catalogue/sounds.ts data; lengths read "2.3s" as T14's sound rows do.
// Length tolerance ±34 ms, one frame at 30 fps (a Cutframe test choice). Any off-localhost request fails the case.
import { test, expect, type Page } from '@playwright/test';
import { SOUNDS } from '../../apps/web/src/catalogue/sounds';
import { assetCount, linkedCount, notices, openEditor, skipTour } from './t02-support';
import { liveDoc, storedDoc, undoEntries } from './t03-support';

test.use({ viewport: { width: 1400, height: 900 } }); test.setTimeout(90_000);
type Rec = Record<string, any>;
const leaks = new WeakMap<Page, string[]>();
const local = (href: string) => { const url = new URL(href); return ['localhost', '127.0.0.1'].includes(url.hostname) || ['blob:', 'data:', 'about:'].includes(url.protocol); };
test.beforeEach(async ({ page }) => {
  await skipTour(page); const seen: string[] = []; leaks.set(page, seen);
  page.on('request', request => { if (!local(request.url())) seen.push(request.url()); });
  await page.route('**/*', route => local(route.request().url()) ? route.continue() : route.abort());
});
test.afterEach(async ({ page }) => { expect(leaks.get(page), 'no off-localhost requests, even failed ones').toEqual([]); });

const TOLERANCE_MS = 34;
const track = (id: string, kind: string) => ({ id, name: id, kind, hidden: false, locked: false, muted: false, solo: false, volume: 1 });
// No audio track and no items: the first sound has to make its own track.
function doc(): Rec {
  const tracks = [track('V1', 'video'), track('O1', 'overlay')];
  return { schemaVersion: 4, rev: 0, groups: {}, duration: 10000, fps: 30, size: { width: 1080, height: 1920 }, background: { type: 'color', value: 'transparent' },
    transitions: [], markers: [], tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), items: [] };
}
const lengthText = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const sounds = (page: Page) => page.getByRole('region', { name: 'Sounds', exact: true });
const builtIn = (page: Page) => sounds(page).getByRole('list', { name: 'Built-in sounds', exact: true });
const addButton = (page: Page, name: string) => builtIn(page).getByRole('button', { name: `Add sound ${name}`, exact: true });
async function openSounds(page: Page) {
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Sounds', exact: true }).click(); await expect(builtIn(page)).toBeVisible();
}
async function listContract(page: Page) {
  await expect(sounds(page).getByRole('heading', { name: 'Built-in', exact: true })).toBeVisible();
  const rows = builtIn(page).getByRole('listitem'); await expect(rows).toHaveCount(SOUNDS.length);
  await expect(builtIn(page).getByRole('button')).toHaveText(SOUNDS.map(s => s.name));
  for (const [k, s] of SOUNDS.entries()) { await expect(rows.nth(k).getByRole('button', { name: `Add sound ${s.name}`, exact: true })).toBeVisible(); await expect(rows.nth(k)).toContainText(lengthText(s.durationMs)); }
  // No preview button (ruling): one button per row, the title.
  await expect(builtIn(page).getByRole('button')).toHaveCount(SOUNDS.length);
}
const top = async (page: Page, what: ReturnType<typeof builtIn>) => { const box = await what.boundingBox(); expect(box, 'is laid out').not.toBeNull(); return box!; };
const linked = (page: Page, id: string): Promise<Rec[]> => page.evaluate(async id => {
  const p = '/src/store/database.ts', { projectStore } = await import(p), library = (await projectStore.library()).assets;
  return (await projectStore.projectAssets(id)).map((l: Rec) => { const a = library.find((a: Rec) => a.id === l.assetId); return { agent: l.agent_id, id: a.id, name: a.name, type: a.type, durationMs: a.durationMs, source: a.source }; });
}, id);

test('no Freesound key: Built-in lists every catalogue sound in order with its length, above the "Add a free key" block', async ({ page }) => {
  expect(SOUNDS.length).toBeGreaterThan(0); expect(new Set(SOUNDS.map(s => s.name)).size, 'names are unique, so each Add button is one row').toBe(SOUNDS.length);
  await openEditor(page, doc(), 'T22 built-in sounds'); await openSounds(page); await listContract(page);
  const keys = sounds(page).getByRole('group', { name: 'Stock keys' }); await expect(keys).toContainText('Add a free key'); await expect(keys).toContainText('Freesound');
  await expect(sounds(page).getByLabel('Freesound API key')).toBeVisible(); await expect(sounds(page).getByLabel('Search sounds')).toHaveCount(0);
  const list = await top(page, builtIn(page)), block = await top(page, keys); expect(list.y + list.height, 'the list ends above the key block').toBeLessThanOrEqual(block.y);
  expect((await liveDoc(page)).items, 'listing adds nothing').toEqual([]); expect(await assetCount(page)).toBe(0);
});

// One sound of each bundled file type, picked from the catalogue.
const BY_TYPE = [...new Set(SOUNDS.map(s => s.file.split('.').pop()!))].map(ext => SOUNDS.find(s => s.file.endsWith(`.${ext}`))!);
for (const sound of BY_TYPE) test(`a title click adds ${sound.slug} (${sound.file.split('.').pop()}): one audio item from 0 s on a new audio track, its catalogue length, a cutframe stock asset`, async ({ page }) => {
  const id = await openEditor(page, doc(), `T22 add ${sound.slug}`), before = await liveDoc(page); expect(before.tracks.some((t: Rec) => t.kind === 'audio')).toBe(false);
  await openSounds(page); await addButton(page, sound.name).click(); await expect(notices(page)).toContainText('Sound added to the project footage');
  await expect.poll(async () => (await liveDoc(page)).items.length, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await storedDoc(page, id)).items.length, { message: 'the item reaches the stored project', timeout: 20_000 }).toBe(1);
  const after = await storedDoc(page, id), item = after.items[0], lane = after.tracks.find((t: Rec) => t.id === item.trackId);
  expect(item.type).toBe('audio'); expect(lane?.kind).toBe('audio'); expect(before.tracks.map((t: Rec) => t.id), 'a new track').not.toContain(item.trackId);
  expect(after.tracks).toHaveLength(before.tracks.length + 1); expect(item.display.from).toBe(0);
  expect(Math.abs(item.display.to - item.display.from - sound.durationMs), `item length ${item.display.to - item.display.from} ms vs catalogue ${sound.durationMs} ms, ±${TOLERANCE_MS} ms`).toBeLessThanOrEqual(TOLERANCE_MS);
  // T14's reading of the click placement: one "Add items" step by the user.
  expect(await undoEntries(page)).toEqual([{ label: 'Add items', source: 'user' }]);
  const assets = await linked(page, id); expect(assets).toHaveLength(1); expect(await assetCount(page)).toBe(1);
  expect(assets[0]).toMatchObject({ agent: 'audio_1', type: 'audio', source: { kind: 'stock', provider: 'cutframe', providerId: `sound:${sound.slug}` } });
  expect(Math.abs(assets[0].durationMs - sound.durationMs), `asset length ${assets[0].durationMs} ms`).toBeLessThanOrEqual(TOLERANCE_MS);
});

test('a second click on the same sound makes no second library copy and no second project link', async ({ page }) => {
  const sound = SOUNDS[0], id = await openEditor(page, doc(), 'T22 same sound twice'); await openSounds(page); expect(await assetCount(page)).toBe(0);
  await addButton(page, sound.name).click(); await expect.poll(async () => (await liveDoc(page)).items.length, { timeout: 20_000 }).toBe(1);
  expect(await assetCount(page)).toBe(1); expect(await linkedCount(page, id)).toBe(1); const first = await linked(page, id);
  // Content-addressed (part 2 §33, catalogue/assets.ts): the same bundled file has the same name and size, so the library reuses its copy.
  await addButton(page, sound.name).click(); await expect.poll(async () => (await liveDoc(page)).items.length, { message: 'the second click places the sound again', timeout: 20_000 }).toBe(2);
  expect(await assetCount(page), 'one library copy').toBe(1); expect(await linkedCount(page, id)).toBe(1);
  // The stored length is written twice by design: the catalogue value on the click, the measured one when preparation ends. So it is checked against the catalogue, not against the first read.
  const [{ durationMs: _, ...was }] = first, again = await linked(page, id); expect(again).toHaveLength(1); const [{ durationMs, ...now }] = again;
  expect(now).toEqual(was); expect(Math.abs(durationMs - sound.durationMs), `asset length ${durationMs} ms`).toBeLessThanOrEqual(TOLERANCE_MS);
  const items = (await liveDoc(page)).items; expect(items.map((i: Rec) => i.type)).toEqual(['audio', 'audio']);
});

test('with a Freesound key saved, Built-in still lists every sound and sits above the search box; nothing is requested', async ({ page }) => {
  await openEditor(page, doc(), 'T22 built-in with key'); await openSounds(page);
  await sounds(page).getByLabel('Freesound API key').fill('fk'); await sounds(page).getByRole('button', { name: 'Save Freesound key' }).click();
  const search = sounds(page).getByLabel('Search sounds'); await expect(search).toBeVisible(); await expect(sounds(page).getByRole('group', { name: 'Stock keys' })).toHaveCount(0);
  await listContract(page); const list = await top(page, builtIn(page)), box = await top(page, search);
  expect(list.y + list.height, 'the list ends above the search box').toBeLessThanOrEqual(box.y);
  await expect(sounds(page).getByRole('list', { name: 'Sound results' }).getByRole('listitem')).toHaveCount(0);
  expect(leaks.get(page), 'saving a key and showing the list ask Freesound nothing').toEqual([]);
});
