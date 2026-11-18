// SPDX-License-Identifier: AGPL-3.0-only
// T15 audit F6 (red-first): captureFrame must flag a video whose picture failed. render/sources.ts picture() returns 'failed' (grey) on a decode or
// fetch error (:103), and render/capture.ts:70 drops 'failed' sources, so the frame comes back grey with no notRendered and no errors while the stage
// marks the same frame data-exact="false" (tests/ui/t15-decode-retry.spec.ts, persistent failure row).
// A UI spec, not vitest: the decoder pool spawns module Workers (render/decoder-pool.ts:36) and capture.ts draws on an OffscreenCanvas and reads it
// back with convertToBlob (:53, :61); Node has none of them.
// Fault: decoderFaults.timeouts = 2 makes both tries of picture() time out through the real path (the first is transient, the retry fails too), so the
// source is 'failed' for that capture: the same persistent failure as t15-decode-retry. Only frames not in the decoder cache make a request, so the
// clip opens, the first paused frame (frame 0) is shown, and the capture asks for frame 90, never decoded. While paused nothing else calls the pool.
// Oracle: Cutframe's own contract, not Xapp (Xapp's captureFrame failure shape is not stored; agent tool results (C).md, "captureFrame"): the frame
// JSON's notRendered lists what the frame lacks (capture.ts:71, T15 notes P13), and a failed motion graphic is listed by name and id
// (mg/frames.ts:92, tests/ui/t08-capture-failure.spec.ts). The entry's exact text and any errors entry await the lead's ruling, so this spec only
// requires an entry that names the clip by its id.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { makeClip, openWithVideos, shown, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the clip that is captured');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 4, W = 320, H = 180, T = 3; // T = 3 s: frame 90, inside the clip, not the shown frame 0

async function open(page: Page, title: string) {
  const doc = videoDoc([{ id: 'vid', to: SECONDS * 1000, sourceDuration: SECONDS * 1000, details: { name: 'Faulty clip' } }], { size: { width: W, height: H }, duration: SECONDS * 1000 });
  await openWithVideos(page, doc, { vid: { path: makeClip(SECONDS, W, H) } }, title);
  await shown(page, 0);
}
type Result = { success: boolean; frames: { timestamp: number; notRendered?: string[]; errors?: unknown[] }[]; images: number; timeouts: number; pending: number };
/** Sets decoderFaults.timeouts = `faults`, then runs captureFrame at `t`; returns the frames JSON, the image count and the pool's timeout counters. */
const capture = (page: Page, t: number, faults: number) => page.evaluate(async ({ t, faults }) => {
  const c = '/src/render/capture.ts', d = '/src/store/database.ts', e = '/src/editor.tsx', p = '/src/render/decoder-pool.ts';
  const { captureFrame } = await import(c), { projectStore } = await import(d), { activeSession } = await import(e), pool = await import(p);
  const assets = (await projectStore.library()).assets as { id: string }[], before = pool.decoderStats.timeouts as number;
  pool.decoderFaults.timeouts = faults;
  const r = await captureFrame({ store: projectStore, doc: activeSession.document, asset: (id: string) => assets.find(a => a.id === id), playheadMs: 0 }, { timestamps: [t] });
  const content = (r.content ?? []) as { type: string; text?: string }[];
  return { success: r.success as boolean, frames: JSON.parse(content[0].text!).frames, images: content.filter(b => b.type === 'image').length, timeouts: pool.decoderStats.timeouts - before, pending: pool.decoderFaults.timeouts };
}, { t, faults }) as Promise<Result>;

test('F6: a video whose decode fails on both tries is listed in the frame\'s notRendered by its id; the frame is still captured', async ({ page }) => {
  await open(page, 'T15 F6 capture failed');
  const r = await capture(page, T, 2);
  expect(r.timeouts, 'both tries timed out through the real path').toBe(2);
  expect(r.pending, 'both injected faults were consumed').toBe(0);
  expect(r.success).toBe(true);
  expect(r.images).toBe(1);
  expect(r.frames).toHaveLength(1);
  expect(r.frames[0].notRendered ?? [], 'the failed clip is named').toEqual(expect.arrayContaining([expect.stringMatching(/\bvid\b/)]));
});

test('F6 guard: the same capture with no fault lists nothing: no notRendered, no errors', async ({ page }) => {
  await open(page, 'T15 F6 capture ok');
  const r = await capture(page, T, 0);
  expect(r.timeouts, 'no decoder timeout').toBe(0);
  expect(r.success).toBe(true);
  expect(r.images).toBe(1);
  expect(r.frames[0].notRendered).toBeUndefined();
  expect(r.frames[0].errors).toBeUndefined();
});
