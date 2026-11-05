// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('Chromium worker preserves request IDs, typed failures and queue recovery', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/analysis/worker-client.ts';
    const { AnalysisWorker } = await import(path);
    const worker = new AnalysisWorker();
    const transcript = { language: 'en', languages: ['en'], total_duration: 4, segments: [{ id: 0, start: 0, end: 2, text: 'one two three', speaker: 0, words: ['one', 'two', 'three'].map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.25 })) }] };
    const target = structuredClone(transcript);
    for (const word of target.segments[0].words) { word.start += 1; word.end += 1; }
    const requests = [
      worker.run({ task: 'sync', source: transcript, target }),
      worker.run({ task: 'sync', source: { ...transcript, segments: [] }, target }).catch((e: any) => ({ code: e.code, message: e.message, confidence: e.details.confidence })),
      worker.run({ task: 'silence', words: [{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 3, end: 4 }], ranges: [[1, 3]] }),
      worker.run({ task: 'search', request: { query: 'x', mode: 'general', options: { threshold: 'medium', limit: 5 } } }).catch((e: any) => ({ code: e.code }))
    ];
    const values = await Promise.all(requests); worker.close();
    const closed = await worker.run({ task: 'remove', assetId: 'x' }).catch((e: any) => e.code);
    return { values, closed };
  });
  expect(result.values[0]).toMatchObject({ id: 1, ok: true, value: { offset: -1, confidence: 1 } });
  expect(result.values[1]).toEqual({ code: 'SYNC_LOW_CONFIDENCE', message: 'Low sync confidence (0%). Transcripts may not overlap enough.', confidence: 0 });
  expect(result.values[2]).toMatchObject({ id: 3, ok: true, value: [[1.175, 2.825]] });
  expect(result.values[3]).toEqual({ code: 'ANALYSIS_NOT_INITIALIZED' });
  expect(result.closed).toBe('ANALYSIS_CANCELLED');
});

test('closing a worker rejects every pending operation', async ({ page }) => {
  await page.goto('/');
  const codes = await page.evaluate(async () => {
    const path = '/src/analysis/worker-client.ts'; const { AnalysisWorker } = await import(path);
    const worker = new AnalysisWorker();
    const operations = [worker.run({ task: 'remove', assetId: 'a' }), worker.run({ task: 'remove', assetId: 'b' })];
    worker.close();
    return Promise.all(operations.map(p => p.then(() => 'resolved', (e: any) => e.code)));
  });
  expect(codes).toEqual(['ANALYSIS_CANCELLED', 'ANALYSIS_CANCELLED']);
});
