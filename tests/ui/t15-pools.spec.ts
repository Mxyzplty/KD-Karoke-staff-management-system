// SPDX-License-Identifier: AGPL-3.0-only
// T15 decoder-pool frame cache: byte-budget LRU that always keeps the 16 newest frames (decoder-pool.ts KEEP = 16, default 256 MiB).
// Written-spec oracle for "evict by byte budget, never drop below the newest 16"; the 16 and the 256 MiB are provisional (not stated
// Xapp facts, see the pool header). Real workers decode a 320x180, 30-frame ffmpeg clip (230400 bytes per frame).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable, media } from '../media-fixtures';
import { skipTour } from './t02-support';

test.skip(!ffmpegAvailable(), 'ffmpeg generates the small clip the decoder pool decodes');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); await page.goto('/'); });

const FRAME_BYTES = 320 * 180 * 4, FRAMES = 30, KEEP = 16;
type Result = { stats: Record<string, number>; cached: number; width: number; height: number };

/** Decodes frames 0..count-1 of the clip in order under a cache budget, then reports the pool counters. */
async function decodeRun(page: import('@playwright/test').Page, budget: number | null, count: number, repeatFirst = false): Promise<Result> {
  const b64 = readFileSync(media('h264-aac.mp4')).toString('base64');
  return page.evaluate(async ({ b64, budget, count, repeatFirst }) => {
    const p = '/src/render/decoder-pool.ts', pool = await import(p);
    const bin = atob(b64), data = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const src = { key: 'pools-spec', blob: new Blob([data], { type: 'video/mp4' }), rotation: 0 as const };
    pool.closeDecoderPool(); Object.assign(pool.decoderStats, { requests: 0, hits: 0, reused: 0, timeouts: 0, evicted: 0 });
    if (budget !== null) pool.setDecoderCacheBudget(budget);
    let width = 0, height = 0;
    for (let i = 0; i < count; i++) { const f = await pool.decodeFrame(src, i * 1000 / 30 + 5); width = f.width; height = f.height; }
    if (repeatFirst) await pool.decodeFrame(src, count * 1000 / 30 - 28);
    const out = { stats: { ...pool.decoderStats }, cached: pool.decoderCacheBytes(), width, height };
    pool.setDecoderCacheBudget(256 * 2 ** 20); pool.closeDecoderPool(); return out;
  }, { b64, budget, count, repeatFirst });
}

test('a small budget evicts oldest frames but keeps the 16 newest', async ({ page }) => {
  const r = await decodeRun(page, 4 * FRAME_BYTES, FRAMES);
  expect([r.width, r.height]).toEqual([320, 180]);
  expect(r.stats.timeouts).toBe(0);
  expect(r.stats.evicted, 'evictions').toBe(FRAMES - KEEP);
  expect(r.cached, 'cached bytes = the 16 newest frames').toBe(KEEP * FRAME_BYTES);
});

test('a budget that holds every frame evicts nothing', async ({ page }) => {
  const r = await decodeRun(page, FRAMES * FRAME_BYTES, FRAMES);
  expect(r.stats.evicted).toBe(0);
  expect(r.cached).toBe(FRAMES * FRAME_BYTES);
});

test('the default budget (256 MiB) keeps a short clip entirely', async ({ page }) => {
  const r = await decodeRun(page, null, FRAMES);
  expect(r.stats.evicted).toBe(0);
  expect(r.cached).toBe(FRAMES * FRAME_BYTES);
});

test('a cached frame is a hit, not a second decode', async ({ page }) => {
  const r = await decodeRun(page, null, 3, true);
  expect(r.stats.requests, 'worker requests for 3 distinct frames + 1 repeat').toBe(3);
  expect(r.stats.hits).toBe(1);
});
