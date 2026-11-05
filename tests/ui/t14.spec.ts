// SPDX-License-Identifier: AGPL-3.0-only
// T14 in real Chromium: Library duplicate dialog, thumbnails + duration badges, the wizard footage path (silent reuse),
// and the 5-asset sort / view fixture (expected order from the written §27 rules: ground truth).
import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegAvailable, media } from '../media-fixtures';

test.skip(!ffmpegAvailable(), 'ffmpeg generates the test media');
/** A copy of a generated file under another name (same bytes, same size). */
function named(source: string, name: string) {
  const dir = path.join(tmpdir(), 'cutframe-t14-named', path.basename(path.dirname(media(source))));
  mkdirSync(dir, { recursive: true }); const out = path.join(dir, name); copyFileSync(media(source), out); return out;
}
const external = (page: Page) => { const hits: string[] = []; page.on('request', r => { if (!['127.0.0.1', 'localhost'].includes(new URL(r.url()).hostname) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) hits.push(r.url()); }); return hits; };
const settled = async (page: Page) => { await expect(page.locator('.badge.status').filter({ hasText: /Uploading|Processing/ })).toHaveCount(0, { timeout: 60_000 }); };

test('Library: a.mp4 twice → "Duplicate file found" offers a_1.mp4; Skip Duplicates and Upload & Rename both work; poster + duration badge', async ({ page }) => {
  const remote = external(page), a = named('h264-aac.mp4', 'a.mp4');
  await page.goto('/assets'); await page.getByLabel('Upload media').setInputFiles(a);
  await expect(page.getByText('a.mp4', { exact: true })).toBeVisible(); await settled(page);
  const tile = page.locator('article.asset', { hasText: 'a.mp4' });
  await expect(tile.locator('.asset-poster img')).toHaveAttribute('src', /^blob:/); await expect(tile.locator('.badge.duration')).toHaveText('0:01');
  await page.getByLabel('Upload media').setInputFiles(a);
  const dialog = page.getByRole('dialog', { name: 'Duplicate file found' });
  await expect(dialog).toContainText('a.mp4 → a_1.mp4'); await dialog.getByRole('button', { name: 'Skip Duplicates' }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('tab', { name: 'Assets (1)', exact: true })).toBeVisible();
  await page.getByLabel('Upload media').setInputFiles(a); await page.getByRole('dialog', { name: 'Duplicate file found' }).getByRole('button', { name: 'Upload & Rename' }).click();
  await expect(page.getByText('a_1.mp4', { exact: true })).toBeVisible(); await expect(page.getByRole('tab', { name: 'Assets (2)', exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('article.asset', { hasText: 'a_1.mp4' }).locator('.badge.duration')).toHaveText('0:01');
  expect(remote).toEqual([]);
});
test('wizard: 3 files with 1 name+size duplicate of a library asset → 2 new uploads + 1 reused, no dialog, all 3 listed "In project"', async ({ page }) => {
  const dup = named('h264-aac.mp4', 'dup.mp4');
  await page.goto('/assets'); await page.getByLabel('Upload media').setInputFiles(dup); await expect(page.getByText('dup.mp4', { exact: true })).toBeVisible();
  await page.goto('/'); await page.getByRole('button', { name: '＋ New Video', exact: true }).click(); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Add footage from this computer').setInputFiles([named('undated.mp4', 'one.mp4'), dup, media('still.png')]);
  await expect(page.getByRole('list', { name: 'Footage to upload' }).getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Create Project', exact: true }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+$/); await expect(page.getByRole('dialog', { name: 'Duplicate file found' })).toHaveCount(0);
  const list = page.getByRole('list', { name: 'In project' });
  await expect(list.getByRole('listitem')).toHaveCount(3); await expect(list).toContainText('one.mp4'); await expect(list).toContainText('dup.mp4'); await expect(list).toContainText('still.png');
  const state = await page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); const lib = await projectStore.library(); const projects = await projectStore.list(); return { names: lib.assets.map((a: { name: string }) => a.name).sort(), agentIds: (await projectStore.projectAssets(projects[0].id)).map((l: { agent_id: string }) => l.agent_id), status: projects[0].processing_status, items: (await projectStore.read(projects[0].id)).document.items.length }; });
  expect(state).toEqual({ names: ['dup.mp4', 'one.mp4', 'still.png'], agentIds: ['video_1', 'video_2', 'image_1'], status: 'ready', items: 0 });
});
test('proxies (SDR and HDR→SDR) recorded; resolver picks proxy vs original per item flag; waveform cache survives reload', async ({ page }) => {
  await page.goto('/assets'); await page.getByLabel('Upload media').setInputFiles([media('h264-aac.mp4'), media('hevc10-pq.mp4')]);
  await expect(page.getByRole('tab', { name: 'Assets (2)', exact: true })).toBeVisible(); await settled(page);
  const read = () => page.evaluate(async () => {
    const s = '/src/store/database.ts', r = '/src/media/resolver.ts', p = '/src/media/probe.ts';
    const { projectStore } = await import(s), { resolveSource } = await import(r), { probeMedia } = await import(p);
    const out: Record<string, unknown> = {};
    for (const a of (await projectStore.library()).assets) {
      const item = { metadata: { assetId: a.id }, details: {} };
      const proxy = await resolveSource(projectStore, item), original = await resolveSource(projectStore, { ...item, details: { useProxy: false } }), exported = await resolveSource(projectStore, item, 'export');
      const probed = await probeMedia(proxy.blob, 'proxy', 'video'), wave = await projectStore.row('waveforms', a.id);
      out[a.name] = { record: a.proxy, kinds: [proxy.kind, original.kind, exported.kind], proxyVideo: { codec: probed.video.codec, w: probed.video.displayWidth, h: probed.video.displayHeight, transfer: probed.video.colour.transfer, frames: probed.video.frameCount }, proxyAudio: probed.audio?.codec ?? null,
        proxyDuration: probed.durationMs, sourceDuration: a.durationMs, sourceHdr: a.media.video.hdr, waveform: wave && { buckets: wave.peaks.length / 2, head: Array.from(wave.peaks.slice(0, 6)) } };
    }
    return out;
  });
  const first = await read() as Record<string, any>;
  for (const name of ['h264-aac.mp4', 'hevc10-pq.mp4']) {
    const x = first[name];
    expect(x.kinds).toEqual(['proxy', 'original', 'original']);
    expect(x.record).toMatchObject({ width: 320, height: 180 }); expect(['avc', 'vp9', 'vp8']).toContain(x.proxyVideo.codec);
    expect(x.proxyVideo).toMatchObject({ w: 320, h: 180, frames: 30, transfer: 'bt709' });
    expect(Math.abs(x.proxyDuration - x.sourceDuration)).toBeLessThanOrEqual(1000 / 30 + 1);
    expect(x.waveform.buckets).toBeGreaterThanOrEqual(99); expect(['aac', 'opus']).toContain(x.proxyAudio); // proxies keep the sound for T15's preview
  }
  expect(first['hevc10-pq.mp4'].sourceHdr).toBe('pq');
  await page.reload(); await expect(page.getByRole('tab', { name: 'Assets (2)', exact: true })).toBeVisible();
  const again = await read() as Record<string, any>;
  expect(again['h264-aac.mp4'].waveform).toEqual(first['h264-aac.mp4'].waveform); expect(again['hevc10-pq.mp4'].waveform).toEqual(first['hevc10-pq.mp4'].waveform);
});
test('5-asset sort fixture with measured capture dates (two undated): Uploaded/Recorded × DESC/ASC in grid and list', async ({ page }) => {
  const files = [named('dated-2025-05-01T10_00_00Z.mp4', 'b-2025.mp4'), named('undated.mp4', 'c-undated.mp4'), named('dated-2024-01-01T00_00_00Z.mp4', 'd-2024.mp4'), named('dated-2025-05-01T10_00_00Z.mp4', 'e-2025-copy.mp4'), named('still.png', 'f-still.png')];
  await page.goto('/assets');
  for (const f of files) { await page.getByLabel('Upload media').setInputFiles(f); await expect(page.getByText(path.basename(f), { exact: true })).toBeVisible(); }
  await settled(page);
  const names = ['b-2025.mp4', 'c-undated.mp4', 'd-2024.mp4', 'e-2025-copy.mp4', 'f-still.png'];
  const expected = { 'uploaded-DESC': [...names].reverse(), 'uploaded-ASC': names,
    'recorded-DESC': ['e-2025-copy.mp4', 'b-2025.mp4', 'd-2024.mp4', 'f-still.png', 'c-undated.mp4'], 'recorded-ASC': ['d-2024.mp4', 'e-2025-copy.mp4', 'b-2025.mp4', 'f-still.png', 'c-undated.mp4'] };
  for (const view of ['Grid', 'List']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    for (const sort of ['uploaded', 'recorded'] as const) {
      await page.getByLabel('Sort field').selectOption(sort);
      for (const direction of ['DESC', 'ASC'] as const) {
        const toggle = page.getByRole('button', { name: direction === 'DESC' ? 'ASC' : 'DESC', exact: true });
        if (await toggle.isVisible()) await toggle.click();
        await expect(page.getByRole('button', { name: direction, exact: true })).toBeVisible();
        await expect(page.locator('article.asset strong')).toHaveText(expected[`${sort}-${direction}`]);
      }
    }
  }
});
