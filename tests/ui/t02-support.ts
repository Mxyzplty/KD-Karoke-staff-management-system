// SPDX-License-Identifier: AGPL-3.0-only
// Shared helpers for the T02 browser specs: fixture documents, project creation through the real store, intent observation,
// store snapshots for the negative checks, and the localhost-only request guard.
import { expect, type Page } from '@playwright/test';

export const notices = (page: Page) => page.getByRole('region', { name: 'Notifications' });
/** Any request off localhost fails the test that checks the returned list (no provider, no remote request, no billing). */
export function guard(page: Page) {
  const leaks: string[] = [];
  page.on('request', r => { if (!['127.0.0.1', 'localhost'].includes(new URL(r.url()).hostname) && !/^(data|blob):/.test(r.url())) leaks.push(r.url()); });
  return leaks;
}
/** The tour has its own tests; every other test marks it seen before the first load. */
export const skipTour = (page: Page) => page.addInitScript(() => { try { localStorage.setItem('cutframe:tour:editor', 'done'); } catch { /* storage unavailable */ } });

const track = (id: string, name: string, kind: string, extra: Record<string, unknown> = {}): Record<string, any> => ({ id, name, kind, muted: false, solo: false, locked: false, hidden: false, volume: 1, ...extra });
const item = (id: string, type: string, trackId: string, from: number, to: number, extra: Record<string, unknown> = {}): Record<string, any> => ({ id, type, trackId, display: { from, to }, trim: { from: 0, to: to - from }, details: { name: id }, ...extra });
const base = { schemaVersion: 4, rev: 0, groups: {}, duration: 20000, fps: 30, size: { width: 1920, height: 1080 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [] };

/** Six tracks (display top-first O3 O2 O1 V2 V1 A1), media clips with distinct trim limits, a text clip, an image, two markers. */
export function richDoc(extra: Record<string, unknown> = {}) {
  return {
    ...base,
    tracks: [track('a1', 'A1', 'audio'), track('v1', 'V1', 'video'), track('v2', 'V2', 'video'), track('o1', 'O1', 'overlay'), track('o2', 'O2', 'overlay'), track('o3', 'O3', 'overlay')],
    layerOrder: ['a1', 'v1', 'v2', 'o1', 'o2', 'o3'].map(id => ({ type: 'track', id })),
    items: [
      item('clipA', 'video', 'v1', 0, 8000, { trim: { from: 0, to: 8000 }, sourceDuration: 10000, details: { name: 'Clip A' } }), // start at the source limit (red), end free (green)
      item('clipB', 'video', 'v1', 8000, 16000, { trim: { from: 2000, to: 10000 }, sourceDuration: 10000, details: { name: 'Clip B' } }), // start green, end at the limit (red)
      item('clipC', 'video', 'v2', 2000, 6000, { trim: { from: 1000, to: 5000 }, sourceDuration: 10000, details: { name: 'Clip C' } }), // both green
      item('title', 'text', 'o1', 1000, 5000, { details: { name: 'Title', text: 'Hello', color: '#ffffff' } }),
      item('photo', 'image', 'o2', 0, 4000, { details: { name: 'Photo' } }),
    ],
    markers: [{ id: 'm1', timeMs: 3000 }, { id: 'm2', timeMs: 9000, label: 'Beat' }],
    ...extra,
  };
}
/** Two groups worth of structure: a group holding V1/V2 above A1, with an overlay on top. */
export function groupedDoc() {
  const doc = richDoc();
  return { ...doc, tracks: doc.tracks.filter(t => t.id !== 'o2' && t.id !== 'o3'), items: doc.items.filter(i => i.trackId !== 'o2'),
    groups: { g1: { name: 'Group 1', children: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'v2' }] } },
    layerOrder: [{ type: 'track', id: 'a1' }, { type: 'group', id: 'g1' }, { type: 'track', id: 'o1' }] };
}
/** Every clip type on its own overlay track, for the colour check. */
export function typesDoc() {
  const kinds: [string, string][] = [['video', 'v'], ['text', 'o'], ['shape', 's'], ['motionGraphic', 'm'], ['layout', 'l'], ['caption', 'c'], ['image', 'i'], ['audio', 'a']];
  const tracks = kinds.map(([type, p]) => track(`t-${type}`, `T-${p}`, type === 'audio' ? 'audio' : type === 'caption' ? 'caption' : type === 'video' || type === 'image' ? 'video' : 'overlay'));
  return { ...base, tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), items: kinds.map(([type]) => item(`i-${type}`, type, `t-${type}`, 0, 4000, type === 'video' || type === 'audio' ? { sourceDuration: 4000 } : {})) };
}
/** Snap fixture: a draggable clip, a far clip whose edges are off the grid, a marker off the grid. */
export function snapDoc(hideV1 = false) {
  return { ...base, duration: 30000, tracks: [track('v1', 'V1', 'video', { hidden: hideV1 }), track('v2', 'V2', 'video')], layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'v2' }],
    items: [item('dragMe', 'video', 'v2', 1000, 3000, { sourceDuration: 2000 }), item('far', 'video', 'v1', 11330, 13660, { sourceDuration: 2330 })], markers: [{ id: 'm', timeMs: 6730 }] };
}

/** Opens the app origin, stores a project through the real store and returns its id. */
export async function createProject(page: Page, doc?: unknown, title = 'T02 fixture') {
  await page.goto('/');
  return page.evaluate(async ({ doc, title }) => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.create(title, doc)).id as string; }, { doc, title });
}
export async function openEditor(page: Page, doc?: unknown, title = 'T02 fixture') {
  const id = await createProject(page, doc, title);
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return id;
}
export async function stored(page: Page, id: string) {
  return page.evaluate(async id => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); const r = await projectStore.read(id); const editor = '/src/editor.tsx'; const { activeSession } = await import(editor); return { json: JSON.stringify(r.document), live: JSON.stringify(activeSession?.document), rev: r.document.rev as number, updated: r.record.updated_at as string }; }, id);
}
export type Snapshot = Awaited<ReturnType<typeof stored>>;
/** Observes every intent (and its outcome) the editor dispatches. */
export async function watchIntents(page: Page) {
  await page.evaluate(async () => {
    const p = '/src/editor/commands.ts'; const c = await import(p); const w = window as unknown as { __intents: unknown[] }; w.__intents = [];
    c.subscribeIntents((intent: unknown, outcome: unknown) => w.__intents.push({ intent, outcome }));
  });
}
export type Logged = { intent: { type: string; [k: string]: any }; outcome: { ok: boolean; code?: string; owner?: string; message?: string } };
export const intents = (page: Page) => page.evaluate(() => (window as unknown as { __intents: Logged[] }).__intents);
export const clearIntents = (page: Page) => page.evaluate(() => { (window as unknown as { __intents: unknown[] }).__intents.length = 0; });
export const viewState = <T>(page: Page, pick: (v: any) => T) => page.evaluate(async fn => { const p = '/src/editor/view.ts'; const { view } = await import(p); return (0, eval)(`(${fn})`)(view()); }, pick.toString()) as Promise<T>;
export const setViewState = (page: Page, patch: Record<string, unknown>) => page.evaluate(async patch => { const p = '/src/editor/view.ts'; (await import(p)).setView(patch); }, patch);
export async function sessionState(page: Page) { return page.evaluate(async () => { const p = '/src/editor.tsx'; const { activeSession } = await import(p); return activeSession.state as string; }); }
/** After stub work: the stored document is byte-identical, the revision is unchanged, nothing was saved and the session is still "saved". */
export async function expectUntouched(page: Page, id: string, before: Snapshot) {
  const after = await stored(page, id);
  expect(after.json).toBe(before.json); expect(after.rev).toBe(before.rev); expect(after.updated).toBe(before.updated);
  expect(await sessionState(page)).toBe('saved'); await expect(page.getByRole('status')).toHaveText('Saved locally');
  expect(before.live).toBeDefined(); expect(after.live).toBe(before.live);
}
export const clip = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`);
/** Focus on the page body: nothing focused. */
export const blurAll = (page: Page) => page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
export const zoomNow = (page: Page) => viewState(page, v => v.zoom as number);

/** A valid 1×1 PNG: uploaded through the real store so it runs where ffmpeg is not installed. */
export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** Uploads a tiny PNG, marks it ready (the state T14 preparation ends in) and links it to the project; returns the asset id. */
export async function addAsset(page: Page, projectId: string, name = 'tiny.png', options: { sound?: boolean; failed?: boolean } = {}) {
  return page.evaluate(async ({ projectId, name, png, options }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0)), asset = await projectStore.upload(new File([bytes], name, { type: 'image/png' }));
    await projectStore.updateAsset(asset.id, (a: any) => options.failed
      ? { ...a, processing_status: 'failed', processing_steps: { ...a.processing_steps, thumbnails: 'failed' }, last_error_code: 'PREPARATION_FAILED', last_error_message: 'Preparation failed.' }
      : { ...a, processing_status: 'ready', processing_steps: { ...a.processing_steps, probe: 'complete', thumbnails: 'complete' }, media: options.sound ? { audio: { codec: 'aac' } } : a.media });
    await projectStore.attach(projectId, asset.id);
    return asset.id as string;
  }, { projectId, name, png: TINY_PNG, options });
}
/** Test setup: points a timeline item at an asset (metadata.assetId) by saving the stored document before the editor opens. */
export async function linkClip(page: Page, projectId: string, assetId: string, itemId: string) {
  await page.evaluate(async ({ projectId, assetId, itemId }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p); const { document } = await projectStore.read(projectId);
    document.items = document.items.map((i: any) => i.id === itemId ? { ...i, metadata: { assetId } } : i); await projectStore.save(projectId, document, document.rev);
  }, { projectId, assetId, itemId });
}
export const assetCount = (page: Page) => page.evaluate(async () => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.library()).assets.length; });
export const linkedCount = (page: Page, projectId: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.projectAssets(id)).length; }, projectId);
