// SPDX-License-Identifier: AGPL-3.0-only
// M12 CAP-P04(c): real fake-mic recording, T14 preparation/PCM + T19 transcription persistence, then the Voiceover panel.
// Only the model-service boundary is deterministic. This proves wiring/persistence, not acoustic/ASR quality.
import { test, expect } from '@playwright/test';
import { openEditor, skipTour } from './t02-support';
import { liveDoc } from './t03-support';
test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test('M12 fake mic -> real preparation -> persisted transcript -> Voiceover captions and reopen (model-boundary stub)', async ({ page }) => {
  await skipTour(page);
  const id = await openEditor(page, { schemaVersion: 4, rev: 0, groups: {}, duration: 0, fps: 30, size: { width: 640, height: 360 }, background: { type: 'color', value: 'transparent' }, tracks: [], layerOrder: [], items: [], transitions: [], markers: [] });
  await page.evaluate(async () => {
    const p = '/src/analysis/service.ts', { analysisService } = await import(p), w = window as any;
    w.__t09Pcm = [];
    analysisService.available = async () => ({ analysis: false, transcription: true, embeddings: false, beats: false });
    analysisService.request = async (req: any) => {
      if (req.task !== 'transcribe') throw new Error(`unexpected model task: ${req.task}`);
      const pcm = req.pcm.data[0]; w.__t09Pcm.push({ sampleRate: req.pcm.sampleRate, samples: pcm.length, peak: Math.max(...pcm.subarray(0, 16000).map(Math.abs)) });
      return { status: 'complete', music: false, transcript: { language: 'en', languages: ['en'], total_duration: pcm.length / req.pcm.sampleRate,
        segments: [{ id: 0, start: .2, end: 1.2, text: 'recorded words', speaker: 0, words: [{ word: 'recorded', start: .2, end: .6 }, { word: 'words', start: .8, end: 1.2 }] }] } };
    };
  });
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Voice-over', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Voice Over' });
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1600); await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await liveDoc(page)).items.filter((i: any) => i.metadata?.isVoiceover).length, { timeout: 10000 }).toBe(1);
  const take = (await liveDoc(page)).items.find((i: any) => i.metadata?.isVoiceover);
  const read = () => page.evaluate(async assetId => { const p = '/src/store/database.ts'; const s = (await import(p)).projectStore; return { row: await s.row('transcripts', assetId), asset: await s.row('assets', assetId) }; }, take.metadata.assetId);
  await expect.poll(async () => (await read()).row?.status, { timeout: 10000 }).toBe('complete');
  const stored = await read(); expect(stored.asset.processing_steps.transcription).toBe('complete'); expect(stored.asset.durationMs).toBeGreaterThan(1200);
  const pcm = await page.evaluate(() => (window as any).__t09Pcm); expect(pcm).toHaveLength(1); expect(pcm[0].sampleRate).toBe(16000); expect(pcm[0].samples).toBeGreaterThan(19200);
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('tab', { name: 'Captions', exact: true }).click();
  const captions = page.getByRole('region', { name: 'Captions' });
  await captions.getByLabel('Caption font', { exact: true }).selectOption('Roboto');
  await captions.getByRole('radio', { name: 'Voiceover', exact: true }).click(); await captions.locator('.caption-generate').click();
  await expect.poll(async () => (await liveDoc(page)).items.filter((i: any) => i.type === 'caption').length).toBe(1);
  const c = (await liveDoc(page)).items.find((i: any) => i.type === 'caption');
  expect(c.captionSourceItemId).toBe(take.id); expect(c.metadata.captionSource.sourceAssetId).toBe(take.metadata.assetId); expect(c.details.text).toBe('recorded words');
  expect(c.details.words.map((w: any) => [w.text, w.sourceStartMs, w.sourceEndMs])).toEqual([['recorded', 200, 600], ['words', 800, 1200]]);
  await expect(page.getByRole('status')).toHaveText('Saved locally', { timeout: 15000 });
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  expect((await liveDoc(page)).items.find((i: any) => i.id === c.id)).toEqual(c);
});
