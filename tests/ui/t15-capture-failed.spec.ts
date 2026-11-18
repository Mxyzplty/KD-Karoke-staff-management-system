// SPDX-License-Identifier: AGPL-3.0-only
// T15 audit F6 (red-first): captureFrame must flag a video whose picture failed. render/sources.ts picture() returns 'failed' (grey) on a decode or
// fetch error (:103), and render/capture.ts:70 drops 'failed' sources, so the frame comes back grey with no notRendered and no errors while the stage
// marks the same frame data-exact="false" (tests/ui/t15-decode-retry.spec.ts, persistent failure row). A failed layout cell is the same dropped source.
// A UI spec, not vitest: the decoder pool spawns module Workers (render/decoder-pool.ts:36) and capture.ts draws on an OffscreenCanvas and reads it
// back with convertToBlob (:53, :61); Node has none of them.
// Fault: decoderFaults.timeouts = 2 makes both tries of picture() time out through the real path (the first is transient, the retry fails too), so the
// source fails for that capture: the same persistent failure as t15-decode-retry. Only frames not in the decoder cache make a request, so the clip
// opens, the first paused frame (frame 0) is shown, and the capture asks for frame 90, never decoded. While paused nothing else calls the pool.
// The error the real path ends on is the retry's (sources.ts:101): the first try runs on the slot that opened the source for frame 0, so it times out
// at REQUEST_TIMEOUT_MS; the restart (decoder-pool.ts:47-53) drops that slot and its affinity, so the retry goes to a slot that never opened the source
// and times out at OPEN_TIMEOUT_MS = 8000 (:13, :62). Its text is "Frame decoding timed out after 8 s." (:67), raised as
// mediaError('DECODE_ERROR', text, { transient: true }) (:52): code DECODE_ERROR, category system_error, recovery our_bug (media/codes.ts:10, :48-50).
// Oracle: Cutframe's own contract, not Xapp (Xapp's captureFrame failure shape is not stored; agent tool results (C).md, "captureFrame"). Lane A
// ruling of 19 Nov 2026: notRendered follows mg/frames.ts:92, "Video '<name>' (<id>) could not be decoded: <code>: <message>", with the real code
// and message (picture() carries the error for purpose 'capture', as graphicPicture does); errors gets one entry built like capture.ts:72.
// Image row (lane A ruling, 19 Nov 2026): a seeded ready image asset whose bytes createImageBitmap cannot decode (seeded as t07-support videoAsset
// does), so the real imageBitmap failure runs (sources.ts:66 throws, :84 catches, :99 returns 'failed'). The thrown error is the browser's
// DOMException, not a Cutframe code. Ruled: DECODE_ERROR / system_error / our_bug (media/codes.ts:10) with the DOMException's message, as the video
// rows (the probe passed, so a render-time failure is no evidence of a corrupt file). The message is browser text, so it is not pinned.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable } from '../media-fixtures';
import { createProject, skipTour } from './t02-support';
import { seedLayout } from './t07-support';
import { makeClip, openWithVideos, runCanvas, shown, uploadAsset, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the clip that is captured');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 4, W = 320, H = 180, T = 3; // T = 3 s: frame 90, inside the clip, not the shown frame 0
const TIMEOUT_TEXT = 'Frame decoding timed out after 8 s.';
const DECODE = { code: 'DECODE_ERROR', category: 'system_error', recovery: 'our_bug' };

async function open(page: Page, title: string) {
  const doc = videoDoc([{ id: 'vid', to: SECONDS * 1000, sourceDuration: SECONDS * 1000, details: { name: 'Faulty clip' } }], { size: { width: W, height: H }, duration: SECONDS * 1000 });
  await openWithVideos(page, doc, { vid: { path: makeClip(SECONDS, W, H) } }, title);
  await shown(page, 0);
}
/** A split-horizontal layout L0 over the whole 4 s on o1: cell 0 holds the clip, cell 1 is empty. Returns cell 0's stored id. */
async function openLayout(page: Page, title: string) {
  const track = { id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 };
  const doc = {
    schemaVersion: 4, rev: 0, groups: {}, duration: SECONDS * 1000, fps: 30, size: { width: W, height: H }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks: [track], layerOrder: [{ type: 'track', id: 'o1' }], items: [seedLayout('L0', 'split-horizontal', { trackId: 'o1', from: 0, to: SECONDS * 1000, width: W, height: H })],
  };
  const clip = makeClip(SECONDS, W, H), id = await createProject(page, doc, title), assetId = await uploadAsset(page, id, readFileSync(clip), 'clip.mp4', 'video/mp4');
  const cellId = await page.evaluate(async ({ id, assetId }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p); const { document } = await projectStore.read(id);
    const cell = document.items[0].details.cells[0]; cell.source = { assetId, type: 'video', url: `asset:${assetId}` };
    await projectStore.save(id, document, document.rev); return cell.id as string;
  }, { id, assetId });
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await shown(page, 0);
  return cellId;
}
type Result = { success: boolean; frames: { timestamp: number; notRendered?: string[]; errors?: Record<string, unknown>[] }[]; images: number; timeouts: number; pending: number };
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
/** Both injected faults fired through the real path, and the frame is still captured. */
function faultedFrame(r: Result) {
  expect(r.timeouts, 'both tries timed out through the real path').toBe(2);
  expect(r.pending, 'both injected faults were consumed').toBe(0);
  expect(r.success).toBe(true);
  expect(r.images).toBe(1);
  expect(r.frames).toHaveLength(1);
  return r.frames[0];
}

test('F6: a video whose decode fails on both tries is listed once in notRendered with its name, id, code and message, and its code in errors; the frame is still captured', async ({ page }) => {
  await open(page, 'T15 F6 capture failed');
  const f = faultedFrame(await capture(page, T, 2));
  expect(f.notRendered, 'the failed clip, by the mg template').toEqual([`Video 'Faulty clip' (vid) could not be decoded: DECODE_ERROR: ${TIMEOUT_TEXT}`]);
  expect(f.errors, 'one entry for the decode code').toEqual([expect.objectContaining(DECODE)]);
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

test('F6 layout cell: a clip in a layout cell whose decode fails on both tries is listed by the cell item\'s name and id (timeline/layouts.ts cellItem)', async ({ page }) => {
  const cellId = await openLayout(page, 'T15 F6 capture layout cell');
  const f = faultedFrame(await capture(page, T, 2));
  expect(f.notRendered, 'the failed cell clip').toEqual([`Video 'Layout cell 1 (Split Horizontal)' (L0/${cellId}) could not be decoded: DECODE_ERROR: ${TIMEOUT_TEXT}`]);
  expect(f.errors, 'one entry for the decode code').toEqual([expect.objectContaining(DECODE)]);
});

/** An image item 'img' ('Bad still') over the whole 4 s, on a seeded ready image asset whose bytes are not an image. The stage draws grey, so frame
 *  0 is drawn but not exact. */
async function openBadImage(page: Page, title: string) {
  const doc: any = videoDoc([{ id: 'img', to: SECONDS * 1000, details: { name: 'Bad still' } }], { size: { width: W, height: H }, duration: SECONDS * 1000 });
  doc.items[0] = { ...doc.items[0], type: 'image' };
  const id = await createProject(page, doc, title);
  await page.evaluate(async id => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    const asset = await projectStore.upload(new File([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])], 'bad.png', { type: 'image/png' }));
    await projectStore.updateAsset(asset.id, (a: any) => ({ ...a, processing_status: 'ready', processing_steps: { ...a.processing_steps, probe: 'complete', thumbnails: 'complete' } }));
    await projectStore.attach(id, asset.id);
    const { document } = await projectStore.read(id); document.items[0].metadata = { assetId: asset.id }; await projectStore.save(id, document, document.rev);
  }, id);
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(runCanvas(page)).toHaveAttribute('data-frame', '0', { timeout: 15000 });
}

test('F6 image: an image whose bytes cannot be decoded is listed once in notRendered by name and id with DECODE_ERROR, and its code in errors', async ({ page }) => {
  await openBadImage(page, 'T15 F6 capture bad image');
  const r = await capture(page, T, 0);
  expect(r.success).toBe(true);
  expect(r.images).toBe(1);
  expect(r.frames).toHaveLength(1);
  const f = r.frames[0];
  expect(f.notRendered, 'the failed image, by the mg template').toEqual([expect.stringMatching(/^Image 'Bad still' \(img\) could not be decoded: DECODE_ERROR: .+$/)]);
  expect(f.errors, 'one entry for the decode code').toEqual([expect.objectContaining(DECODE)]);
});
