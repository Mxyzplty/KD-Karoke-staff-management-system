// SPDX-License-Identifier: AGPL-3.0-only
// T19 C9 UI: the editor's auto title (editor.tsx watchTitle). The model provider is injected in the page through
// setTitleProvider (no models, no network). Synthetic media only.
import { test, expect, type Page } from '@playwright/test';
import { addAsset, createProject, skipTour } from './t02-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

const TITLE = '/src/analysis/title.ts', STORE = '/src/store/database.ts';
const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
const summarise = (page: Page, assetId: string, summary: string) => page.evaluate(async ({ assetId, summary, store }) => {
  const { projectStore } = await import(store); await projectStore.putRow('analyses', { id: assetId, analysis: { summary }, created_at: new Date().toISOString() });
}, { assetId, summary, store: STORE });
const connect = (page: Page, answer: string) => page.evaluate(async ({ answer, title }) => {
  const { setTitleProvider } = await import(title), w = window as any; w.titleRequests = [];
  setTitleProvider({ async *stream(request: any) { w.titleRequests.push(request); yield { type: 'text', text: answer }; } });
}, { answer, title: TITLE });
const requests = (page: Page) => page.evaluate(() => (window as any).titleRequests as { purpose?: string; messages: { content: string }[] }[]);
const body = (request: { messages: { content: string }[] }) => JSON.parse(request.messages[0].content.split('\n').slice(1).join('\n'));
/** Marks the asset as still being prepared (its summary may still come). Its upload step is left unfinished so the app's
 *  load recovery neither fails it (not "uploading") nor resumes a real preparation on it (upload not complete). */
const preparing = (page: Page, assetId: string) => page.evaluate(async ({ assetId, store }) => {
  const { projectStore } = await import(store);
  await projectStore.updateAsset(assetId, (a: any) => ({ ...a, processing_status: 'processing', processing_steps: { ...a.processing_steps, upload: 'processing' } }));
}, { assetId, store: STORE });

test.describe('Auto title', () => {
  test('with no provider the editor title stays "Untitled Project"', async ({ page }) => {
    const id = await createProject(page, undefined, 'Untitled Project'); await addAsset(page, id, 'a.png');
    await page.goto(`/project/${id}`); await expect(heading(page, 'Untitled Project')).toBeVisible(); await page.waitForTimeout(1500);
    await expect(heading(page, 'Untitled Project')).toBeVisible();
  });

  test('a provider connected while the editor is open titles the project once a summary exists, and the title persists', async ({ page }) => {
    const id = await createProject(page, undefined, 'Untitled Project'), assetId = await addAsset(page, id, 'a.png'); await preparing(page, assetId);
    await page.goto(`/project/${id}`); await expect(heading(page, 'Untitled Project')).toBeVisible();
    await connect(page, 'Title: "Fixture Title"'); await page.waitForTimeout(500);
    await expect(heading(page, 'Untitled Project')).toBeVisible(); expect(await requests(page)).toEqual([]); // default mode waits while the asset is prepared
    await summarise(page, assetId, 'A tiny test picture');
    await expect(heading(page, 'Fixture Title')).toBeVisible({ timeout: 15000 }); // polled every 5 s
    const sent = await requests(page); expect(sent).toHaveLength(1); expect(sent[0].purpose).toBe('project-title');
    expect(body(sent[0])).toEqual({ message: '', assets: [{ name: 'A tiny test picture', type: 'image' }] });
    await page.reload(); await expect(heading(page, 'Fixture Title')).toBeVisible(); // stored as the generated title
    await page.waitForTimeout(500); expect(await page.evaluate(() => (window as any).titleRequests ?? [])).toEqual([]); // and never asked again
  });

  test('review 4: once every asset settled with no summary (no vision, audio only), the title comes from the file names', async ({ page }) => {
    const id = await createProject(page, undefined, 'Untitled Project'); await addAsset(page, id, 'a.png');
    await page.goto(`/project/${id}`); await expect(heading(page, 'Untitled Project')).toBeVisible();
    await connect(page, 'From Names'); await expect(heading(page, 'From Names')).toBeVisible();
    const sent = await requests(page); expect(sent).toHaveLength(1); expect(body(sent[0])).toEqual({ message: '', assets: [{ name: 'a.png', type: 'image' }] });
  });

  test('review 4: an empty project is titled after its first asset is added in the editor (attach wakes it, no timer)', async ({ page }) => {
    const id = await createProject(page, undefined, 'Untitled Project');
    await page.goto(`/project/${id}`); await expect(heading(page, 'Untitled Project')).toBeVisible();
    await connect(page, 'After Attach'); await page.waitForTimeout(500); expect(await requests(page)).toEqual([]);
    await addAsset(page, id, 'b.png'); await expect(heading(page, 'After Attach')).toBeVisible();
    const sent = await requests(page); expect(sent).toHaveLength(1); expect(body(sent[0])).toEqual({ message: '', assets: [{ name: 'b.png', type: 'image' }] });
  });
});
