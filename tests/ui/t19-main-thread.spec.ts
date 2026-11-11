// SPDX-License-Identifier: AGPL-3.0-only
// T19 regression: the page's main thread must not load Transformers.js, onnxruntime-web or the model loader. They belong
// to the analysis worker; evaluating them on the main thread (1.15 MB prebundle) cost T15 playback frames on 2-vCPU CI.
// The chain was agent/executor.ts -> analysis/details.ts + multicam.ts -> availability.ts -> models.ts -> transformers.
// Needs ffmpeg for a 2 s H.264 clip ("with media" test only).
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { openEditor, skipTour } from './t02-support';
import { makeClip, openWithVideos, videoDoc } from './t15-support';
import type { AnalysisRequest } from '../../apps/web/src/analysis/protocol';
import type { Frame } from '../../apps/web/src/analysis/types';
import type { Asset } from '../../apps/web/src/store/model';
import { FOREIGN_OBJECT_FIXTURE } from './t25-svg-support';

test.setTimeout(150_000);
const BUFFER = 100_000;
test.beforeEach(async ({ page }) => {
  await skipTour(page);
  // Chromium keeps 250 resource-timing entries by default and the dev server serves each module separately; a full buffer would drop the entries this test reads.
  await page.addInitScript(size => performance.setResourceTimingBufferSize(size), BUFFER);
});

/** The `?url` stubs from analysis/worker-client.ts are plain asset URLs; the ort modules themselves are not. */
const hasUrlQuery = (url: string) => /[?&]url(?:&|$)/.test(url.split('#')[0].replace(/^[^?]*/, ''));
const forbidden = (url: string) =>
  /@huggingface[_/]transformers/.test(url)
  || (/onnxruntime[-_]web/.test(url) && !hasUrlQuery(url))
  || /\/src\/analysis\/models\.ts/.test(url);

/** Resource-timing URLs the page itself requested, up to the analysis worker script (all of them while it has not started).
 *  The cut is needed: Chromium lists a module worker's own import fetches (engine.ts, models.ts, transformers) in the page's
 *  timeline. Anything the main thread loads after the worker starts is not checked; no such path exists today. */
const mainThreadLoads = (page: Page) => page.evaluate(() => {
  const all = performance.getEntriesByType('resource').map(entry => entry.name), cut = all.findIndex(name => name.includes('analysis.worker'));
  return { entries: all.length, workerSeen: cut >= 0, urls: cut < 0 ? all : all.slice(0, cut) };
});
async function expectNoHeavyModules(page: Page) {
  const { entries, workerSeen, urls } = await mainThreadLoads(page);
  console.log(`T19 main-thread resource entries: ${entries}, worker script seen: ${workerSeen}, before it: ${urls.length}`);
  expect(entries, 'the page recorded resource timing entries').toBeGreaterThan(0);
  expect(entries, 'the resource-timing buffer is not full, so no entry was dropped').toBeLessThan(BUFFER);
  const offending = urls.filter(forbidden);
  expect(offending, `the main thread loaded model-stack modules:\n${offending.join('\n')}`).toEqual([]);
}

test('the editor open does not load the model stack on the main thread', async ({ page }) => {
  await openEditor(page, undefined, 'T19 main thread (editor)');
  await expectNoHeavyModules(page);
});

test.describe('with media', () => {
  test.skip(!ffmpegAvailable(), 'ffmpeg makes the H.264 clip whose import triggers the T19 preparation');

  test('preparing a clip (analysis worker, availability probe) does not load the model stack on the main thread', async ({ page }) => {
    await openWithVideos(page, videoDoc([{ id: 'vid', to: 2000, sourceDuration: 2000 }], { duration: 2000 }), { vid: { path: makeClip(2) } }, 'T19 main thread');
    // Every library asset has left its preparation steps, so the worker and the probe have run.
    await expect.poll(() => page.evaluate(async () => { const p = '/src/store/database.ts'; const { projectStore } = await import(p); return (await projectStore.library()).assets.every((a: { processing_status: string }) => a.processing_status === 'ready' || a.processing_status === 'failed'); }), { timeout: 120_000 }).toBe(true);
    await expectNoHeavyModules(page);
  });
});

// D106: real SVG frame extraction; only availability and the model response are substituted, never the pixels.
test('T25 D97 foreignObject analysis: real svgFrame has a red centre and the step completes', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async svg => {
    const p = '/src/analysis/steps.ts', s = '/src/analysis/service.ts';
    const { analysisStep } = await import(p), { analysisService } = await import(s);
    const available = analysisService.available, request = analysisService.request, frames: Frame[] = [];
    analysisService.available = async () => ({ analysis: true, transcription: false, embeddings: false, beats: false });
    analysisService.request = async <T>(message: AnalysisRequest): Promise<T> => {
      if (message.task !== 'describe') throw new Error(`Unexpected analysis task: ${message.task}`);
      frames.push(...message.frames);
      return { width: 512, height: 512, aspectRatio: 1, tags: [], summary: 'synthetic model response', segments: [] } as T;
    };
    try {
      const outcome = await analysisStep({ blob: new Blob([svg], { type: 'image/svg+xml' }), asset: { id: 'foreign-object', name: 'foreign-object.svg', type: 'image' } as Asset,
        info: { container: 'svg+xml', mimeType: 'image/svg+xml', durationMs: null, video: null, audio: null, image: { width: 512, height: 512, orientation: 1 },
          capturedAt: null, latitude: null, longitude: null, decoder: 'native-image' }, signal: new AbortController().signal, results: {} });
      return { outcome, frames: frames.map(frame => {
        const offset = (Math.floor(frame.height / 2) * frame.width + Math.floor(frame.width / 2)) * 4;
        return { timestamp: frame.timestamp, width: frame.width, height: frame.height, centre: Array.from(frame.data.subarray(offset, offset + 4)) };
      }) };
    } finally { analysisService.available = available; analysisService.request = request; }
  }, FOREIGN_OBJECT_FIXTURE.svg);
  expect(result.outcome).toMatchObject({ state: 'complete' }); expect(result.frames).toHaveLength(1);
  expect(result.frames[0]).toMatchObject({ timestamp: 0, width: 512, height: 512, centre: [255, 0, 0, 255] });
});
