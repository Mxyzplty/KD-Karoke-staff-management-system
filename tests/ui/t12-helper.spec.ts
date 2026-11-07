// SPDX-License-Identifier: AGPL-3.0-only
// T12 lane rule (tickets l.320): the smart-mask tools #30-34 from a real MCP client, through a real helper, to a paired tab with the real models.
// Pattern: tests/ui/t11-helper.spec.ts. Needs the fixture store and a dev server with CUTFRAME_LOCAL_MODELS=1 at CUTFRAME_T12_URL.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHelper } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { createProject, linkClip, skipTour } from './t02-support';
import { STORE, hasStore, uploadAsset, videoDoc } from './t15-support';

const CLIP2 = path.join(STORE, 'corpus/tos-action-30s.mp4'), LINK_KEY = 'cutframe:agent-link:v1';
let projectId = '';
test.skip(!hasStore || !process.env.CUTFRAME_T12_URL, 'needs the fixture store and CUTFRAME_T12_URL (a dev server with CUTFRAME_LOCAL_MODELS=1)');
test.use({ baseURL: process.env.CUTFRAME_T12_URL, channel: 'chromium', viewport: { width: 1400, height: 900 }, launchOptions: { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] } });
const cleanups: (() => unknown | Promise<unknown>)[] = [];
test.beforeEach(({ page }) => skipTour(page));
test.afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function connected(page: Page) {
  const configDir = mkdtempSync(join(tmpdir(), 't12-helper-'));
  const helper = await startHelper({ port: 0, log: () => {}, configDir, quietMs: 100 });
  cleanups.push(() => helper.close(), () => rmSync(configDir, { recursive: true, force: true }));
  projectId = await createProject(page, videoDoc([{ id: 'c', from: 0, to: 1000, trim: 2000, sourceDuration: 30000 }]), 'T12 helper');
  await linkClip(page, projectId, await uploadAsset(page, projectId, readFileSync(CLIP2), 'clip2.mp4', 'video/mp4'), 'c');
  const token = newToken(); helper.store.add(token);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), token);
  await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected');
  const c = new Client({ name: 't12', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
  cleanups.push(() => c.close());
  // A long tool must not end on the client's own request time-out either (the helper's rule): none shorter than the job.
  return (name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }, undefined, { timeout: 900_000, resetTimeoutOnProgress: true }) as Promise<{ isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] }>;
}
const body = (r: { content: { text?: string }[] }) => JSON.parse(r.content[0].text!);
const liveMasks = (page: Page) => page.evaluate(async id => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.read(id)).document.items[0].masks ?? []) as any[]; }, projectId);

test('viewMaskFrame → previewSmartMask → trackSmartMask, removeBackground, then the mask tools read and edit the layers', async ({ page }) => {
  test.setTimeout(1_200_000);
  const call = await connected(page);
  expect(body(await call('context')).success).toBe(true);

  const view = await call('viewMaskFrame', { itemId: 'c', timelineSeconds: 0.5 });
  expect(view.isError, view.content[0].text).toBeUndefined();
  expect(view.content.map(b => [b.type, b.mimeType])).toEqual([['text', undefined], ['image', 'image/jpeg']]);
  const frame = body(view);
  expect(frame).toMatchObject({ success: true, itemId: 'c', timelineSeconds: 0.5, width: 1280, height: 534 });
  expect(frame.sourceSeconds).toBeCloseTo(2.5, 1);

  const stroke = { label: 1, radius: 0.0224719, points: [[.15, .2], [.2, .45], [.28, .65]] };
  const preview = await call('previewSmartMask', { frameRef: frame.frameRef, strokes: [stroke] });
  expect(preview.isError).toBeUndefined();
  expect(preview.content.map(b => [b.type, b.mimeType])).toEqual([['text', undefined], ['image', 'image/png']]);
  const { selectionId, area } = body(preview);
  expect(area).toBeGreaterThan(0.1);

  const tracked = body(await call('trackSmartMask', { selectionId, sourceStartSeconds: 2.25, sourceEndSeconds: 2.75, name: 'Head' }));
  expect(tracked.success, JSON.stringify(tracked)).toBe(true);
  expect(tracked).toMatchObject({ success: true, data: { itemId: 'c', maskIndex: 0, raster: { bucket: 'local', sourceStartUs: 2_250_000, sourceEndUs: 2_750_000 } } });
  // A second call with the same selection returns the same mask, nothing new.
  expect(body(await call('trackSmartMask', { selectionId, sourceStartSeconds: 2.25, sourceEndSeconds: 2.75 })).data.maskId).toBe(tracked.data.maskId);
  await expect.poll(async () => (await liveMasks(page)).map(m => [m.name, m.mode])).toEqual([['Head', 'add']]);

  const over = await call('trackSmartMask', { selectionId: 'nothing', sourceStartSeconds: 2, sourceEndSeconds: 3 });
  expect(over.isError).toBe(true);

  const removed = body(await call('removeBackground', { itemId: 'c', name: 'Cut out' }));
  expect(removed).toMatchObject({ success: true, data: { itemId: 'c', maskIndex: 1 } });
  await expect.poll(async () => (await liveMasks(page)).map(m => [m.name, m.mode, m.purpose])).toEqual([['Head', 'add', undefined], ['Cut out', 'intersect', 'background-removal']]);

  // A mask from a job is not read yet: the gate holds the edit back until viewItemDetails has read the layers (results l.1541).
  const edit = { itemId: 'c', maskIndex: 0, properties: { feather: 3, inverted: true } };
  expect(body(await call('editMaskProperties', edit))).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', scope: 'masks', agentId: 'c' });
  expect(body(await call('viewItemDetails', { itemId: 'c', include: 'masks' })).success).toBe(true);
  expect(body(await call('editMaskProperties', edit)).success).toBe(true);
  expect(body(await call('writeMaskPoints', { itemId: 'c', maskIndex: 0, remove: [0] }))).toMatchObject({ success: false, code: 'SMART_MASK_NOT_EDITABLE' });
  expect(body(await call('removeMask', { itemId: 'c', maskIndex: 0 })).success).toBe(true);
  await expect.poll(async () => (await liveMasks(page)).map(m => m.name)).toEqual(['Cut out']);

  // #34: createMask through the same helper. timelineSeconds is required, the text prompt is retired, the layer has its path keyframe, and creating marks the scope read (results §2).
  const box = { itemId: 'c', shape: 'rectangle', bounds: { width: 400, height: 200 } };
  expect(body(await call('createMask', box))).toMatchObject({ success: false, code: 'MISSING_TIMELINE_SECONDS' });
  expect(body(await call('createMask', { ...box, timelineSeconds: 0.5, textPrompt: 'the man' }))).toMatchObject({ success: false, code: 'VISUAL_SELECTION_REQUIRED' });
  const made = body(await call('createMask', { ...box, timelineSeconds: 0.5, mode: 'subtract', feather: 2 }));
  expect(made).toMatchObject({ success: true, data: { itemId: 'c', maskIndex: 1, maskName: 'Rectangle Mask', hasPathKeyframes: true, totalMasks: 2, properties: { mode: 'subtract', feather: 2 } } });
  await expect.poll(async () => (await liveMasks(page)).map(m => [m.name, m.mode, m.keyframes?.path?.keyframes?.length])).toEqual([['Cut out', 'intersect', undefined], ['Rectangle Mask', 'subtract', 1]]);
  expect(body(await call('editMaskProperties', { itemId: 'c', maskIndex: 1, properties: { opacity: 50 } })).success).toBe(true);
  await expect.poll(async () => (await liveMasks(page))[1].opacity).toBe(50);
});
