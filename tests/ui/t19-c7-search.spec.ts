// SPDX-License-Identifier: AGPL-3.0-only
// T19 C7 + C1 UI: Library footage search (Enter only, files / clips, errors, cancellation, clip preview and download),
// the editor Footage panel search, the "Analysis failed" badge and Retry. The analysis service is stubbed in the page
// (no models in UI runs). Synthetic media only.
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegAvailable } from '../media-fixtures';
import { TINY_PNG, addAsset, clearIntents, createProject, intents, richDoc, skipTour, watchIntents } from './t02-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

type Row = { assetId: string; start?: number; end?: number; similarity?: number };
const STORE = '/src/store/database.ts', SERVICE = '/src/analysis/service.ts';

/** A ready PNG in the library only (optionally with an error code); returns its id. */
async function libraryAsset(page: Page, name: string, code?: string): Promise<string> {
  return page.evaluate(async ({ name, png, code, store }) => {
    const { projectStore } = await import(store);
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0)), asset = await projectStore.upload(new File([bytes], name, { type: 'image/png' }));
    await projectStore.updateAsset(asset.id, (a: any) => ({ ...a, processing_status: 'ready', processing_steps: { ...a.processing_steps, probe: 'complete', thumbnails: 'complete' }, last_error_code: code ?? null, last_error_message: code ? 'Analysis failed.' : null }));
    return asset.id as string;
  }, { name, png: TINY_PNG, code, store: STORE });
}
/** Replaces analysisService.search; rows are built from `answer` (a function body string over `request` and `window.__rows`). */
async function stub(page: Page, mode: 'rows' | 'reject' | 'deferred', rows: Row[] = []) {
  await page.evaluate(async ({ mode, rows, service }) => {
    const { analysisService } = await import(service); const w = window as any;
    w.searches = []; w.deferred = []; w.aborted = [];
    const answer = (request: any, list: Row[]) => ({ query: request.query, results: list.map(r => ({ assetId: r.assetId, embeddingType: 'description', chunkText: 'x', ...(r.start !== undefined ? { startTime: r.start, endTime: r.end } : {}), surroundingContext: [], filename: 'f', similarity: r.similarity ?? 0.5, source: 'embedding' })), metadata: { totalResults: list.length, sources: { embedding: list.length, filename: 0 } } });
    w.answer = answer;
    analysisService.search = async (_store: unknown, request: any, signal?: AbortSignal) => {
      w.searches.push(request);
      if (mode === 'reject') { const types = '/src/analysis/types.ts', { AnalysisError } = await import(types); throw new AnalysisError('ANALYSIS_UNAVAILABLE', 'Local analysis models are not installed.'); }
      if (mode === 'rows') return answer(request, rows);
      return new Promise((resolve, reject) => {
        const index = w.deferred.length; w.aborted[index] = false;
        signal?.addEventListener('abort', () => { w.aborted[index] = true; reject(signal.reason); }, { once: true });
        w.deferred.push((list: Row[]) => resolve(answer(request, list)));
      });
    };
  }, { mode, rows, service: SERVICE });
}
const searches = (page: Page) => page.evaluate(() => (window as any).searches as any[]);
const search = (page: Page) => page.getByLabel('Search media', { exact: true });
const run = async (page: Page, text: string) => { await search(page).fill(text); await search(page).press('Enter'); };
const tileNames = (page: Page) => page.locator('article.asset > strong').allTextContents();

test.describe('Library search', () => {
  test('typing sends nothing; Enter sends one request without projectId; blank queries send none', async ({ page }) => {
    await page.goto('/assets'); await libraryAsset(page, 'a.png'); await page.reload(); await stub(page, 'rows');
    await search(page).pressSequentially('sunset', { delay: 20 }); await page.waitForTimeout(300); expect(await searches(page)).toEqual([]);
    await search(page).press('Enter'); await expect(page.getByRole('heading', { name: 'No assets match your search' })).toBeVisible();
    expect(await searches(page)).toEqual([{ query: 'sunset', mode: 'general', options: { threshold: 'medium', limit: 30 } }]);
    expect(Object.keys((await searches(page))[0])).not.toContain('projectId');
    await page.reload(); await stub(page, 'rows');
    await run(page, ''); await run(page, '   '); await page.waitForTimeout(300); expect(await searches(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible();
  });

  test('two submits: the first (slow) answer is aborted and never renders; the second renders', async ({ page }) => {
    await page.goto('/assets'); const a = await libraryAsset(page, 'first.png'), b = await libraryAsset(page, 'second.png'); await page.reload(); await stub(page, 'deferred');
    await run(page, 'one'); await expect.poll(() => searches(page).then(s => s.length)).toBe(1); await expect(page.getByRole('status')).toHaveText('Searching…');
    await run(page, 'two'); await expect.poll(() => searches(page).then(s => s.length)).toBe(2);
    expect((await searches(page)).map(s => s.query)).toEqual(['one', 'two']);
    expect(await page.evaluate(() => (window as any).aborted)).toEqual([true, false]);
    await page.evaluate(([x, y]) => { const w = window as any; w.deferred[0]([{ assetId: x }]); w.deferred[1]([{ assetId: y }]); }, [a, b]);
    await expect.poll(() => tileNames(page)).toEqual(['second.png']); await page.waitForTimeout(300); expect(await tileNames(page)).toEqual(['second.png']);
  });

  test('Show files: one tile per asset in best-row order; searching hides New folder and breadcrumbs; Clear search and emptying restore the grid without a request', async ({ page }) => {
    await page.goto('/assets'); const a = await libraryAsset(page, 'a.png'), b = await libraryAsset(page, 'b.png'); await libraryAsset(page, 'c.png'); await page.reload();
    await stub(page, 'rows', [{ assetId: a, start: 2, end: 4, similarity: 0.6 }, { assetId: b, similarity: 0.5 }, { assetId: a, similarity: 0.4 }]);
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible(); await expect(page.getByRole('navigation', { name: 'Library location' })).toBeVisible();
    await run(page, 'beach'); await expect.poll(() => tileNames(page)).toEqual(['a.png', 'b.png']);
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0); await expect(page.getByRole('navigation', { name: 'Library location' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show files', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click(); expect(await searches(page)).toHaveLength(1);
    await expect.poll(() => tileNames(page).then(n => n.sort())).toEqual(['a.png', 'b.png', 'c.png']); await expect(search(page)).toHaveValue('');
    await run(page, 'beach'); await expect.poll(() => tileNames(page)).toEqual(['a.png', 'b.png']); expect(await searches(page)).toHaveLength(2);
    await search(page).fill(''); await expect.poll(() => tileNames(page).then(n => n.sort())).toEqual(['a.png', 'b.png', 'c.png']); expect(await searches(page)).toHaveLength(2);
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible();
  });

  test('no rows: "No assets match your search" + "Try a different search term"', async ({ page }) => {
    await page.goto('/assets'); await libraryAsset(page, 'a.png'); await page.reload(); await stub(page, 'rows', []);
    await run(page, 'nothing'); await expect(page.getByRole('heading', { name: 'No assets match your search' })).toBeVisible(); await expect(page.getByText('Try a different search term')).toBeVisible();
    await expect(page.locator('article.asset')).toHaveCount(0);
  });

  test('Show clips: one tile per row in order, duplicates kept; range badge and second line; stays on for the next query; empty message', async ({ page }) => {
    await page.goto('/assets'); const a = await libraryAsset(page, 'a.png'), b = await libraryAsset(page, 'b.png'); await page.reload();
    await stub(page, 'rows', [{ assetId: a, start: 2.9, end: 4.7 }, { assetId: b }, { assetId: a, start: 65, end: 125.2 }]);
    await run(page, 'beach'); await expect.poll(() => tileNames(page)).toEqual(['a.png', 'b.png']);
    await page.getByRole('button', { name: 'Show clips', exact: true }).click();
    const tiles = page.getByLabel('Clip results').locator('article.asset');
    await expect(tiles).toHaveCount(3); await expect(tiles.locator('strong')).toHaveText(['a.png', 'b.png', 'a.png']);
    await expect(tiles.nth(0).locator('.badge.range')).toHaveText('0:02–0:04'); await expect(tiles.nth(0).locator('small')).toHaveText('IMAGE · 0:02–0:04');
    await expect(tiles.nth(2).locator('.badge.range')).toHaveText('1:05–2:05'); await expect(tiles.nth(2).locator('small')).toHaveText('IMAGE · 1:05–2:05');
    await expect(tiles.nth(1).locator('.badge.range')).toHaveCount(0); // a still has no duration: 0:00–0:00
    await expect(tiles.nth(1).locator('small')).toHaveText('IMAGE · 0:00–0:00');
    await run(page, 'again'); await expect(page.getByLabel('Clip results').locator('article.asset')).toHaveCount(3); await expect(page.getByRole('button', { name: 'Show clips', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await stub(page, 'rows', []); await run(page, 'empty'); await expect(page.getByRole('heading', { name: 'No clips match your search' })).toBeVisible(); await expect(page.getByText('Try a different search term')).toBeVisible();
  });

  test('a rejecting service shows the "Search couldn’t run" alert with the message; Searching… while pending', async ({ page }) => {
    await page.goto('/assets'); await libraryAsset(page, 'a.png'); await page.reload(); await stub(page, 'deferred');
    await run(page, 'q'); await expect(page.getByRole('status')).toHaveText('Searching…');
    await stub(page, 'reject'); await run(page, 'q2');
    const alert = page.getByRole('alert'); await expect(alert.getByRole('heading', { name: 'Search couldn’t run' })).toBeVisible(); await expect(alert).toContainText('Local analysis models are not installed.');
  });

  test('"Your Assets" picker: Clear search only, no Show files / Show clips', async ({ page }) => {
    const id = await createProject(page, richDoc(), 'Picker'); const a = await addAsset(page, id, 'in-project.png'); await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await stub(page, 'rows', [{ assetId: a }]);
    await page.getByRole('region', { name: 'Footage', exact: true }).getByRole('button', { name: 'Add from your library' }).click();
    const dialog = page.getByRole('dialog', { name: 'Your Assets' }); await expect(dialog).toBeVisible();
    await dialog.getByLabel('Search media', { exact: true }).fill('x'); await dialog.getByLabel('Search media', { exact: true }).press('Enter');
    await expect(dialog.getByRole('button', { name: 'Clear search', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Show files', exact: true })).toHaveCount(0); await expect(dialog.getByRole('button', { name: 'Show clips', exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('Select in-project.png')).toBeVisible();
  });
});

test.describe('Library clips of real video', () => {
  test.skip(!ffmpegAvailable(), 'ffmpeg generates the test media');
  /** A synthetic 5 s H.264/AAC file (keyframe every 0.5 s) so ranges 2-4 s lie inside it. */
  function fiveSeconds() {
    const dir = path.join(tmpdir(), 'cutframe-t19-c7'); mkdirSync(dir, { recursive: true }); const out = path.join(dir, 'clipsrc.mp4');
    if (!existsSync(out)) {
      const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
    }
    return out;
  }
  async function videoLibrary(page: Page) {
    await page.goto('/assets'); await page.getByLabel('Upload media').setInputFiles(fiveSeconds());
    await expect(page.getByText('clipsrc.mp4', { exact: true })).toBeVisible();
    await expect(page.locator('.badge.status').filter({ hasText: /Uploading|Processing/ })).toHaveCount(0, { timeout: 60_000 });
    return page.evaluate(async store => { const { projectStore } = await import(store); const a = (await projectStore.library()).assets.find((x: any) => x.name === 'clipsrc.mp4'); return { id: a.id as string, durationMs: a.durationMs as number }; }, STORE);
  }

  test('range tile: badge and line, Preview opens at 2 s, Download clip is <base>_0m02s-0m04s and non-empty; whole-asset row downloads the original', async ({ page }) => {
    const { id, durationMs } = await videoLibrary(page); expect(durationMs).toBeGreaterThan(4500);
    await stub(page, 'rows', [{ assetId: id, start: 2.4, end: 4.6 }, { assetId: id }]);
    await run(page, 'clip'); await expect.poll(() => tileNames(page)).toEqual(['clipsrc.mp4']);
    await page.getByRole('button', { name: 'Show clips', exact: true }).click();
    const tiles = page.getByLabel('Clip results').locator('article.asset'); await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(0).locator('.badge.range')).toHaveText('0:02–0:04'); await expect(tiles.nth(0).locator('small')).toHaveText('VIDEO · 0:02–0:04');
    const whole = `0:0${Math.floor(durationMs / 1000)}`;
    await expect(tiles.nth(1).locator('.badge.range')).toHaveCount(0); await expect(tiles.nth(1).locator('small')).toHaveText(`VIDEO · 0:00–${whole}`);

    await tiles.nth(0).getByRole('button', { name: 'Preview clipsrc.mp4 from 0:02' }).click();
    const dialog = page.getByRole('dialog', { name: 'clipsrc.mp4' }), video = dialog.locator('video'); await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(2.1); // start is 2.4 s, floored to 0:02 in the label only
    expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThanOrEqual(2.7);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);

    const [clip] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), tiles.nth(0).getByRole('button', { name: 'Download clip clipsrc.mp4 0:02–0:04' }).click()]);
    expect(clip.suggestedFilename()).toMatch(/^clipsrc_0m02s-0m04s\.(mp4|webm)$/); expect(statSync((await clip.path())!).size).toBeGreaterThan(0);
    const [original] = await Promise.all([page.waitForEvent('download'), tiles.nth(1).getByRole('button', { name: `Download clip clipsrc.mp4 0:00–${whole}` }).click()]);
    expect(original.suggestedFilename()).toBe('clipsrc.mp4'); expect(readFileSync((await original.path())!).equals(readFileSync(fiveSeconds()))).toBe(true);
  });
});

test.describe('Footage panel search', () => {
  const footage = (page: Page) => page.getByRole('region', { name: 'Footage', exact: true });
  async function project(page: Page) {
    const id = await createProject(page, richDoc(), 'Footage search'); const a = await addAsset(page, id, 'a.png'), b = await addAsset(page, id, 'b.png');
    const outside = await libraryAsset(page, 'outside.png');
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally'); await watchIntents(page);
    return { id, a, b, outside };
  }
  test('Enter sends one request with the projectId; "Search results" replaces "In project"; tiles with ranges; unlinked assets hidden; emptying restores', async ({ page }) => {
    const { id, a, b, outside } = await project(page); await stub(page, 'rows', [{ assetId: a, start: 2.2, end: 4.9 }, { assetId: outside, start: 1, end: 2 }, { assetId: b }, { assetId: a, start: 7, end: 9 }]);
    const input = footage(page).getByLabel('Search footage'); await expect(footage(page).getByRole('heading', { name: 'In project' })).toBeVisible();
    await input.pressSequentially('sunset', { delay: 20 }); await page.waitForTimeout(300); expect(await searches(page)).toEqual([]);
    await input.press('Enter');
    await expect(footage(page).getByRole('heading', { name: 'Search results' })).toBeVisible(); await expect(footage(page).getByRole('heading', { name: 'In project' })).toHaveCount(0);
    expect(await searches(page)).toEqual([{ query: 'sunset', projectId: id, mode: 'general', options: { threshold: 'medium', limit: 30 } }]);
    const items = footage(page).getByRole('list', { name: 'Search results' }).getByRole('listitem');
    await expect(items).toHaveCount(3); await expect(items.locator(':scope > span')).toHaveText(['a.png', 'b.png', 'a.png']);
    await expect(items.locator('small')).toHaveText(['[0:02–0:04]', '[0:00–0:00]', '[0:07–0:09]']);
    await expect(footage(page)).not.toContainText('outside.png');
    await input.fill(''); await expect(footage(page).getByRole('heading', { name: 'In project' })).toBeVisible(); await expect(footage(page).getByRole('list', { name: 'In project' }).getByRole('listitem')).toHaveCount(2);
    expect(await searches(page)).toHaveLength(1);
  });
  test('no linked rows → "No clips match your search"', async ({ page }) => {
    const { outside } = await project(page); await stub(page, 'rows', [{ assetId: outside, start: 1, end: 2 }]);
    const input = footage(page).getByLabel('Search footage'); await input.fill('zzz'); await input.press('Enter');
    await expect(footage(page).getByText('No clips match your search')).toBeVisible(); await expect(footage(page).getByText('Try a different search term')).toBeVisible();
  });
  test('a result thumbnail places that asset (placeAssets); the eye opens the preview and places nothing', async ({ page }) => {
    const { a } = await project(page); await stub(page, 'rows', [{ assetId: a, start: 2.2, end: 4.9 }]);
    const input = footage(page).getByLabel('Search footage'); await input.fill('x'); await input.press('Enter');
    await footage(page).getByRole('button', { name: 'Preview a.png from 0:02' }).click(); await expect(page.getByRole('dialog', { name: 'a.png' })).toBeVisible();
    expect(await intents(page)).toEqual([]); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
    await clearIntents(page); await footage(page).getByRole('button', { name: 'Add a.png to the timeline' }).click();
    const log = await intents(page); expect(log).toHaveLength(1); expect(log[0].intent).toMatchObject({ type: 'placeAssets', assetIds: [a], name: 'a.png' }); expect(log[0].outcome).toEqual({ ok: true });
  });
  test('a rejecting service shows the message in an alert', async ({ page }) => {
    await project(page); await stub(page, 'reject'); const input = footage(page).getByLabel('Search footage'); await input.fill('x'); await input.press('Enter');
    await expect(footage(page).getByRole('alert')).toContainText('Local analysis models are not installed.');
  });
});

test.describe('C1 analysis badge and Retry', () => {
  for (const code of ['GEMINI_FAILED', 'TRANSCRIPTION_FAILED', 'EMBEDDING_FAILED']) {
    test(`${code}: badge on the library tile and the Footage thumbnail, Retry only in the library`, async ({ page }) => {
      const id = await createProject(page, richDoc(), 'Badge'); const asset = await libraryAsset(page, 'bad.png', code);
      await page.evaluate(async ([store, project, asset]) => { const { projectStore } = await import(store); await projectStore.attach(project, asset); }, [STORE, id, asset]);
      await libraryAsset(page, 'good.png');
      await page.goto('/assets');
      const tile = page.locator('article.asset', { hasText: 'bad.png' }); await expect(tile.locator('.badge.status')).toHaveText(`Analysis failed · ${code}`); await expect(tile.getByRole('button', { name: 'Retry bad.png' })).toBeVisible();
      const good = page.locator('article.asset', { hasText: 'good.png' }); await expect(good.locator('.badge.status')).toHaveCount(0); await expect(good.getByRole('button', { name: /^Retry/ })).toHaveCount(0);
      await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
      await expect(page.getByRole('region', { name: 'Footage', exact: true }).locator('.badge.status')).toHaveText(`Analysis failed · ${code}`);
    });
  }
  test('a proxy failure and a failed analysis step on one asset: the analysis badge and Retry show (last_error_code is the proxy code)', async ({ page }) => {
    const id = await createProject(page, richDoc(), 'Both'); const asset = await libraryAsset(page, 'bad.png', 'ENCODE_FAILED');
    await page.evaluate(async ([store, project, asset]) => {
      const { projectStore } = await import(store);
      await projectStore.updateAsset(asset, (a: any) => ({ ...a, processing_steps: { ...a.processing_steps, proxy: 'failed', analysis: 'failed' } }));
      await projectStore.attach(project, asset);
    }, [STORE, id, asset]);
    await page.goto('/assets');
    const tile = page.locator('article.asset', { hasText: 'bad.png' });
    await expect(tile.locator('.badge.status')).toHaveText('Analysis failed · GEMINI_FAILED'); await expect(tile.getByRole('button', { name: 'Retry bad.png' })).toBeVisible();
    await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
    await expect(page.getByRole('region', { name: 'Footage', exact: true }).locator('.badge.status')).toHaveText('Analysis failed · GEMINI_FAILED');
  });
  test('other error codes on a ready asset show no analysis badge or Retry', async ({ page }) => {
    await page.goto('/assets'); await libraryAsset(page, 'proxy.png', 'PROXY_FAILED'); await page.reload();
    const tile = page.locator('article.asset', { hasText: 'proxy.png' }); await expect(tile).toBeVisible();
    await expect(tile.getByText(/Analysis failed/)).toHaveCount(0); await expect(tile.getByRole('button', { name: /^Retry/ })).toHaveCount(0);
  });
  test('Retry re-runs preparation for that asset (manual): a preparation record or a changed asset row appears', async ({ page }) => {
    await page.goto('/assets'); const asset = await libraryAsset(page, 'bad.png', 'GEMINI_FAILED'); await page.reload();
    const before = await page.evaluate(async ([store, id]) => { const { projectStore } = await import(store); const a = await projectStore.row('assets', id); return { updated: a.updated_at ?? null, status: a.processing_status, code: a.last_error_code }; }, [STORE, asset]);
    expect(before).toMatchObject({ status: 'ready', code: 'GEMINI_FAILED' });
    await page.locator('article.asset', { hasText: 'bad.png' }).getByRole('button', { name: 'Retry bad.png' }).click();
    await expect.poll(() => page.evaluate(async ([store, id, updated]) => {
      const { projectStore } = await import(store); const rec = await projectStore.row('preparations', id), a = await projectStore.row('assets', id);
      return !!rec || a.processing_status !== 'ready' || a.last_error_code !== 'GEMINI_FAILED' || (a.updated_at ?? null) !== updated;
    }, [STORE, asset, before.updated]), { timeout: 30_000 }).toBe(true);
  });
});
