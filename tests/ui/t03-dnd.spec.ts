// SPDX-License-Identifier: AGPL-3.0-only
// T03 acceptance (ticket T03 "drag-and-drop placement", findings part 3 §45.4, W3-RT-01 / W3-ED-20): 10 drops per kind - uploaded video / image / audio
// and stock videos / images / sounds - each one real "Add items" step. Placement rules (the expected values come from these, not from source output):
//   compatible lane  -> appended after that lane's last clip;   incompatible lane or the preview -> the click rule: the lowest unlocked track of the
//   kind that holds clips, appended at its end;   below the tracks -> a NEW track at the bottom of the stack, the clip at the drop time (120 px / zoom, 2.4 s at the default zoom 0.05).
//   Images are 5 s; video and audio take the source duration with the trim window (0, duration).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable, media } from '../media-fixtures';
import { TINY_PNG, createProject, guard, intents, richDoc, skipTour, viewState, watchIntents } from './t02-support';
import { itemById, journalRows, liveDoc, savedDoc, undoEntries } from './t03-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

const FRAME = 1000 / 30, norev = (d: any) => ({ ...d, rev: 0 });
const mk = (id: string, kind: string) => ({ id, name: id.toUpperCase(), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
const clipOn = (id: string, type: string, trackId: string, to: number) => ({ id, type, trackId, display: { from: 0, to }, trim: { from: 0, to }, sourceDuration: to, details: { name: id } });
/** Bottom-first: a1 a2 v1 v2 o1. Clips only on a1 (0-3 s) and v1 (0-4 s), so the click rule must pick them. */
const dropDoc = () => richDoc({
  duration: 20000, markers: [], tracks: [mk('a1', 'audio'), mk('a2', 'audio'), mk('v1', 'video'), mk('v2', 'video'), mk('o1', 'overlay')], layerOrder: ['a1', 'a2', 'v1', 'v2', 'o1'].map(id => ({ type: 'track', id })),
  items: [clipOn('a1c', 'audio', 'a1', 3000), clipOn('v1c', 'video', 'v1', 4000)],
});
const LANES = () => ({ a1: { kind: 'audio', end: 3000 }, a2: { kind: 'audio', end: 0 }, v1: { kind: 'video', end: 4000 }, v2: { kind: 'video', end: 0 }, o1: { kind: 'overlay', end: 0 } } as Record<string, { kind: string; end: number }>);

/** Independent model of the placement rules above. */
class Model {
  order = ['a1', 'a2', 'v1', 'v2', 'o1']; lanes = LANES();
  where(kind: string, target: string): { lane: string | null; from: number } {
    if (target === 'below') return { lane: null, from: -1 };
    if (target !== 'preview' && this.lanes[target]?.kind === kind) return { lane: target, from: this.lanes[target].end };
    const usable = this.order.filter(id => this.lanes[id].kind === kind), id = usable.find(i => this.lanes[i].end > 0) ?? usable[0];
    return { lane: id, from: this.lanes[id].end };
  }
  commit(lane: string, kind: string, to: number, created = false) { if (created) { this.order.unshift(lane); this.lanes[lane] = { kind, end: 0 }; } this.lanes[lane].end = to; }
}
const selectorOf = (target: string) => target === 'below' ? '.drop-below' : target === 'preview' ? '[aria-label="Preview"]' : `.lane[data-track-id="${target}"]`;
/** Lane drops first, then the click-rule drops, then two below-the-tracks drops, then lane drops again (a new bottom track would take later click-rule drops). */
const SEQUENCE = {
  video: ['v1', 'v2', 'v2', 'o1', 'a1', 'preview', 'below', 'below', 'v1', 'v2'],
  audio: ['a1', 'a2', 'a2', 'v1', 'o1', 'preview', 'below', 'below', 'a1', 'a2'],
} as const;
const drop = (page: Page, selector: string, payload: unknown) => page.evaluate(({ selector, payload }) => {
  const el = document.querySelector(selector)!, data = new DataTransfer(); data.setData('application/x-cutframe-timeline', JSON.stringify(payload)); const b = el.getBoundingClientRect();
  // The drop time is measured from the left edge of the time axis (.ruler-lanes), 120 px in; the below-the-tracks strip starts left of that edge.
  const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: document.querySelector('.ruler-lanes')!.getBoundingClientRect().left + 120, clientY: b.top + 5 };
  el.dispatchEvent(new DragEvent('dragover', init)); el.dispatchEvent(new DragEvent('drop', init));
}, { selector, payload });
async function uploaded(page: Page, projectId: string, kind: 'video' | 'audio' | 'image', durationMs: number) {
  return page.evaluate(async ({ projectId, kind, durationMs, png }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    const [name, type] = { video: ['clip.mp4', 'video/mp4'], audio: ['tone.mp3', 'audio/mpeg'], image: ['pic.png', 'image/png'] }[kind];
    const bytes = kind === 'image' ? Uint8Array.from(atob(png), c => c.charCodeAt(0)) : new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const asset = await projectStore.upload(new File([bytes], name, { type }));
    await projectStore.updateAsset(asset.id, (a: any) => ({ ...a, durationMs: kind === 'image' ? null : durationMs, processing_status: 'ready', processing_steps: { ...a.processing_steps, probe: 'complete', thumbnails: 'complete' } }));
    await projectStore.attach(projectId, asset.id); return asset.id as string;
  }, { projectId, kind, durationMs, png: TINY_PNG });
}
async function openDrops(page: Page) { const id = await createProject(page, dropDoc(), 'Drops'); return id; }
const reopen = async (page: Page, id: string) => { await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); await watchIntents(page); };

/** Runs the 10-drop script and checks every drop; `payloadFor(n)` builds the nth drag payload, `lenOf` the expected clip length (null = read it from the item). */
async function runScript(page: Page, id: string, kind: 'video' | 'audio', type: string, payloadFor: (n: number) => unknown, lenOf: (n: number) => number | null, assetOf: (n: number, item: any) => Promise<void>) {
  const original = await liveDoc(page), model = new Model(), sequence = SEQUENCE[kind], zoom = await viewState(page, v => v.zoom as number); expect(zoom).toBe(0.05);
  for (let n = 0; n < sequence.length; n++) {
    const target = sequence[n], before = await liveDoc(page), laneKind = kind, expected = model.where(laneKind, target);
    const zNow = await viewState(page, v => v.zoom as number); // the zoom follows the project length (fit is the floor), so the drop time is read against the zoom at the moment of the drop
    await drop(page, selectorOf(target), payloadFor(n));
    await expect.poll(async () => (await liveDoc(page)).items.length, { timeout: 20000, message: `drop ${n + 1} on ${target}` }).toBe(before.items.length + 1);
    const doc = await liveDoc(page), item = doc.items.find((i: any) => !before.items.some((b: any) => b.id === i.id)), fixed = lenOf(n), len = item.display.to - item.display.from;
    expect(item.type, `drop ${n + 1}`).toBe(type);
    if (fixed !== null) expect(len, `drop ${n + 1} length`).toBeCloseTo(fixed, 6); else expect(len, `drop ${n + 1} length from the source`).toBeGreaterThan(0);
    if (type === 'image') expect(item.trim, `drop ${n + 1}`).toBeUndefined(); else { const stockDrop = (payloadFor(n) as any).kind === 'stock'; expect(item.trim.from, `drop ${n + 1} trim from`).toBe(0); expect(item.trim.to, `drop ${n + 1} trim to`).toBeCloseTo(len, 6); if (!stockDrop || item.sourceDuration !== undefined) expect(item.sourceDuration, `drop ${n + 1} sourceDuration`).toBeCloseTo(len, 6); } // stock: PROVISIONAL, a not-yet-probed download may place with no sourceDuration
    if (expected.lane) { expect(item.trackId, `drop ${n + 1} on ${target}`).toBe(expected.lane); expect(item.display.from, `drop ${n + 1} start`).toBe(expected.from); model.commit(expected.lane, laneKind, item.display.to); }
    else { // below the tracks: a new track at the bottom of the stack, the clip at the drop time
      expect(doc.layerOrder[0], `drop ${n + 1} new bottom track`).toEqual({ type: 'track', id: item.trackId }); expect(before.tracks.some((t: any) => t.id === item.trackId)).toBe(false);
      expect(doc.tracks.find((t: any) => t.id === item.trackId).kind).toBe(laneKind); expect(Math.abs(item.display.from - 120 / zNow), `drop ${n + 1} drop time`).toBeLessThanOrEqual(FRAME); expect(doc.items.filter((i: any) => i.trackId === item.trackId)).toHaveLength(1); model.commit(item.trackId, laneKind, item.display.to, true);
    }
    await assetOf(n, item);
    const entries = await undoEntries(page); expect(entries, `drop ${n + 1}`).toHaveLength(n + 1); expect(entries.every(e => e.label === 'Add items' && e.source === 'user')).toBe(true);
    const log = (await intents(page)).at(-1)!; expect(log.intent.type).toBe('drop'); expect(log.outcome).toEqual({ ok: true });
  }
  const saved = await savedDoc(page, id); expect(saved.items).toHaveLength(original.items.length + 10);
  await expect.poll(async () => (await journalRows(page, id)).filter(r => r.label === 'Add items').length, { timeout: 15000 }).toBe(10); // one journal record per drop, flushed within the 4 s window
  const rows = (await journalRows(page, id)).filter(r => r.label === 'Add items'); expect(rows.every(r => r.source === 'user' && r.project_id === id)).toBe(true); expect(rows.map(r => r.seq)).toEqual([...rows.map(r => r.seq)].sort((a, b) => a - b));
  for (let n = 0; n < 10; n++) await page.keyboard.press('Control+Z'); // ten real undos
  expect(await undoEntries(page)).toEqual([]); expect(norev(await liveDoc(page))).toEqual(norev(original)); expect(norev(await savedDoc(page, id))).toEqual(norev(original));
}

for (const [type, kind, duration] of [['video', 'video', 3000], ['image', 'video', 0], ['audio', 'audio', 2000]] as const) {
  test(`DnD: 10 uploaded ${type} drops - compatible lane appends, incompatible lane and preview use the click rule, below the tracks makes a new bottom track; 10 undos restore`, async ({ page }) => {
    const id = await openDrops(page); const assetId = await uploaded(page, id, type, duration); await reopen(page, id); test.setTimeout(90000);
    const len = type === 'image' ? 5000 : duration, payload = { kind: 'assets', items: [{ assetId, type, name: `${type}.bin` }] };
    await runScript(page, id, kind, type, () => payload, () => len, async (_n, item) => { expect(item.metadata.assetId).toBe(assetId); });
  });
}

const haveFfmpeg = ffmpegAvailable();
const FILES = { video: { body: haveFfmpeg ? readFileSync(media('h264-aac.mp4')) : Buffer.alloc(0), ext: 'mp4', mime: 'video/mp4' }, audio: { body: haveFfmpeg ? readFileSync(media('tone.mp3')) : Buffer.alloc(0), ext: 'mp3', mime: 'audio/mpeg' }, image: { body: haveFfmpeg ? readFileSync(media('still.png')) : Buffer.alloc(0), ext: 'png', mime: 'image/png' } };
for (const [type, kind] of [['video', 'video'], ['image', 'video'], ['audio', 'audio']] as const) {
  test(`DnD: 10 stock ${type === 'audio' ? 'sound' : type} drops (3 distinct items, one download each) - same placement rules, one "Add items" per drop; 10 undos restore`, async ({ page }) => {
    test.skip(!haveFfmpeg, 'ffmpeg generates the test media'); test.setTimeout(180000);
    const leaks = guard(page), urls = [0, 1, 2].map(n => `https://example.test/${type}/${n}.${FILES[type].ext}`);
    for (const url of urls) await page.route(url, route => route.fulfill({ status: 200, contentType: FILES[type].mime, body: FILES[type].body }));
    const id = await openDrops(page); await reopen(page, id);
    const stock = (n: number) => ({ kind: 'stock', item: { provider: 'pexels', provider_id: `${type}-${n % 3}`, type, name: `Stock ${type} ${n % 3}`, thumbnail_url: 'https://example.test/thumb', preview_url: 'https://example.test/preview', duration_ms: 5000, width: 320, height: 180, attribution: 'Attribution', author: 'Author', licence: 'Pexels License', page_url: 'https://example.test/page', download_url: urls[n % 3], tags: [] } });
    await runScript(page, id, kind, type, stock, () => type === 'image' ? 5000 : null, async (_n, item) => {
      const asset = await page.evaluate(async aid => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.library()).assets as any[]).find(a => a.id === aid); }, item.metadata.assetId);
      expect(asset.type).toBe(type); expect(asset.source).toMatchObject({ kind: 'stock', provider: 'pexels' });
      if (type !== 'image') expect([5000, asset.durationMs ?? asset.media?.durationMs].some(v => Math.abs(item.display.to - item.display.from - v) < 1e-6), 'stock length: the 5 s placeholder or the probed length (PROVISIONAL, spec silent)').toBe(true);
    });
    expect([...leaks].sort()).toEqual([...urls].sort()); // exactly the three downloads, once each - the other seven drops reuse the asset
  });
}

test('DnD: a dropped item is selectable and a second drop of the same upload makes a second item with a new id (no shared state)', async ({ page }) => {
  const id = await openDrops(page); const assetId = await uploaded(page, id, 'image', 0); await reopen(page, id);
  const payload = { kind: 'assets', items: [{ assetId, type: 'image', name: 'pic.png' }] };
  await drop(page, selectorOf('v2'), payload); await drop(page, selectorOf('v2'), payload); await expect.poll(async () => (await liveDoc(page)).items.length).toBe(4);
  const doc = await liveDoc(page), added = doc.items.filter((i: any) => i.metadata?.assetId === assetId); expect(added).toHaveLength(2); expect(new Set(added.map((i: any) => i.id)).size).toBe(2);
  expect(added.map((i: any) => [i.display.from, i.display.to])).toEqual([[0, 5000], [5000, 10000]]); expect(itemById(doc, added[0].id).trackId).toBe('v2');
  expect(await undoEntries(page)).toEqual([{ label: 'Add items', source: 'user' }, { label: 'Add items', source: 'user' }]);
});
