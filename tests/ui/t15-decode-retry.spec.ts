// SPDX-License-Identifier: AGPL-3.0-only
// T15 decode retry on the paused view (apps/web/src/render/decoder-pool.ts seam: decoderFaults.timeouts / decoderStats.timeouts; render/sources.ts picture()).
// Written-spec oracle = the coordinator's rule of 1 Nov 2026 (PROVISIONAL, not Xapp parity):
//   a. a failed or placeholder frame is never marked data-exact="true": the flag says what was drawn;
//   b. the paused / seeked view asks once more after a decoder timeout or worker restart before it draws grey.
// decoderFaults.timeouts = N makes the next N decoder requests time out at once through the real path (decoderStats.timeouts + 1, the worker restarts,
// its waiters reject with a transient DECODE_ERROR). Only frames not in the decoder cache make a request, so each test opens the clip, waits for the
// first paused frame, THEN sets the fault, THEN moves the playhead to a frame that was never decoded. While paused nothing else calls the decoder pool.
// Picture oracle: the ffmpeg-decoded frame n of the clip, the same marker test as t15-remap-shown (the canvas is closer to frame n than to n - 1 / n + 1,
// mean abs diff over RGB); the grey is MISSING_MEDIA #374151 (render/model.ts), read at the canvas centre.
import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { canvasSizeOf, crop, makeClip, meanAbsDiff, openWithVideos, runCanvas, seekMs, shown, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the clip and the oracle frames');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 4, FPS = 30, W = 320, H = 180, FRAMES = SECONDS * FPS;
const GREY = [0x37, 0x41, 0x51]; // MISSING_MEDIA #374151

async function openClip(page: Page) {
  const clip = makeClip(SECONDS, W, H);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  expect(r.status).toBe(0);
  const size = W * H * 3, all = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length);
  expect(all.length).toBe(size * FRAMES);
  await openWithVideos(page, videoDoc([{ id: 'vid', to: SECONDS * 1000, sourceDuration: SECONDS * 1000 }], { size: { width: W, height: H }, duration: SECONDS * 1000 }), { vid: { path: clip } }, 'T15 decode retry');
  await shown(page, 0); // the first paused frame: drawn, exact
  return (n: number) => all.subarray(n * size, (n + 1) * size);
}
const timeouts = (page: Page) => page.evaluate(async () => { const p = '/src/render/decoder-pool.ts'; return (await import(p)).decoderStats.timeouts as number; });
const inject = (page: Page, n: number) => page.evaluate(async n => { const p = '/src/render/decoder-pool.ts'; (await import(p)).decoderFaults.timeouts = n; }, n);
const pending = (page: Page) => page.evaluate(async () => { const p = '/src/render/decoder-pool.ts'; return (await import(p)).decoderFaults.timeouts as number; });

test('one injected decoder timeout: the paused view retries once and shows the right frame, data-exact true, timeouts + 1', async ({ page }) => {
  const oracle = await openClip(page), before = await timeouts(page), N = 60;
  await inject(page, 1);
  await seekMs(page, N * 1000 / FPS);
  await shown(page, N); // data-frame N and data-exact true
  expect(await timeouts(page) - before, 'decoder timeouts through the real path').toBe(1);
  expect(await pending(page), 'the injected fault was consumed').toBe(0);
  const canvas = await crop(page, 0, 0, W, H), d = (m: number) => meanAbsDiff(canvas, oracle(m));
  expect(d(N), `canvas vs ffmpeg frame ${N}`).toBeLessThan(Math.min(d(N - 1), d(N + 1)));
  expect(await canvasSizeOf(page)).toEqual({ width: W, height: H });
});

test('a persistent failure (two timeouts, both tries): grey #374151, data-frame is the new frame, data-exact stays false, timeouts + 2; the next seek recovers', async ({ page }) => {
  const oracle = await openClip(page), before = await timeouts(page), N = 90;
  await inject(page, 2);
  await seekMs(page, N * 1000 / FPS);
  await expect(runCanvas(page)).toHaveAttribute('data-frame', String(N), { timeout: 15000 }); // drawn (the attribute follows the draw)
  expect(await runCanvas(page).getAttribute('data-exact'), 'a grey placeholder is not the frame').toBe('false');
  expect(await timeouts(page) - before, 'both tries timed out').toBe(2);
  expect(await pending(page), 'both injected faults were consumed').toBe(0);
  const px = await crop(page, W / 2, H / 2, 1, 1);
  expect([px[0], px[1], px[2]], 'MISSING_MEDIA grey at the centre').toEqual(GREY);
  // The worker restarted: with no fault left, a new frame decodes and is exact again.
  const M = 100;
  await seekMs(page, M * 1000 / FPS);
  await shown(page, M);
  const canvas = await crop(page, 0, 0, W, H), d = (m: number) => meanAbsDiff(canvas, oracle(m));
  expect(d(M), `canvas vs ffmpeg frame ${M} after recovery`).toBeLessThan(Math.min(d(M - 1), d(M + 1)));
});
