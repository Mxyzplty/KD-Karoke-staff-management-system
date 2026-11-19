// SPDX-License-Identifier: AGPL-3.0-only
// T15 (deferred from T14 notes): toggling Use Proxy does not move the item and does not change the frame shown.
// Written-spec oracle (findings §2: details.useProxy only picks proxy or original media for the preview; T14 notes l.277/470): after
// each toggle the item's display, trim, transform properties and playback rate are exactly as before, only details.useProxy changes,
// the playhead stays, and the paused stage shows the same timeline frame (data-frame) with the same canvas size.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { liveDoc } from './t03-support';
import { prop, runtimeCall } from './t04-support';
import { canvasSizeOf, makeClip, openWithVideos, runCanvas, seekMs, shown, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the H.264 clip');
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const geometry = async (page: Page) => {
  const i = (await liveDoc(page) as { items: Record<string, any>[] }).items.find(i => i.id === 'vid')!;
  const { useProxy, ...details } = i.details ?? {};
  return { display: i.display, trim: i.trim, playbackRate: i.playbackRate, properties: i.properties, details, trackId: i.trackId };
};

test('Use Proxy off then on leaves display, trim, transform and the shown frame unchanged', async ({ page }) => {
  const d = videoDoc([{ id: 'vid', from: 500, to: 2500, trim: 200, sourceDuration: 3000, properties: { positionX: prop(40), positionY: prop(-20), scale: prop(1.5) } }], { duration: 3000 });
  await openWithVideos(page, d, { vid: { path: makeClip(3) } }, 'T15 proxy no-op');
  await seekMs(page, 1500); await shown(page, 45);
  const before = await geometry(page), size = await canvasSizeOf(page);
  for (const useProxy of [false, true, false]) {
    const r = await runtimeCall(page, 'setUseProxy', { itemId: 'vid', useProxy }) as { success: boolean };
    expect(r.success).toBe(true);
    expect(await geometry(page), `after useProxy ${useProxy}: the item did not move`).toEqual(before);
    await shown(page, 45);
    expect(await runCanvas(page).getAttribute('data-frame'), `after useProxy ${useProxy}: same frame`).toBe('45');
    expect(await canvasSizeOf(page), `after useProxy ${useProxy}: same canvas size`).toEqual(size);
    expect(await page.evaluate(async () => { const p = '/src/editor/view.ts'; return (await import(p)).view().playheadMs as number; }), 'the playhead stays').toBe(1500);
  }
});

// Audit F10: the row above never shows that a proxy exists (sources.ts mediaKey falls back to 'original' without asset.proxy, and preparation
// writes the proxy record asynchronously, media/prepare.ts:167-178). This row waits for processing_steps.proxy === 'complete' (every video gets a
// browser proxy, media/work.ts makeProxy; t14-review.spec.ts F7 asserts one on ingest), then checks that the preview's own resolution
// (render/sources.ts itemMedia, which calls media/resolver.ts resolveSource) flips proxy -> original -> proxy across the toggles, while the paused
// stage keeps the same frame and canvas size.
const resolvedKind = (page: Page) => page.evaluate(async () => {
  const s = '/src/render/sources.ts', d = '/src/store/database.ts', e = '/src/editor.tsx';
  const { itemMedia } = await import(s), { projectStore } = await import(d), { activeSession } = await import(e);
  const item = activeSession.document.items.find((i: { id: string }) => i.id === 'vid'), asset = await projectStore.row('assets', item.metadata.assetId);
  return (await itemMedia(projectStore, item, asset)).kind as string;
});
/** Review 17f1959a finding 2: whether the decoder cache holds the paused frame's source time (framePlan's sourceMs at the playhead) from the
 *  `kind` source of the clip (render/sources.ts mediaKey form '<assetId>:<kind>'). Only the stage's paused render decodes that frame here. */
const stageDecoded = (page: Page, kind: 'proxy' | 'original') => page.evaluate(async kind => {
  const m = '/src/render/model.ts', p = '/src/render/decoder-pool.ts', e = '/src/editor.tsx', v = '/src/editor/view.ts';
  const { framePlan } = await import(m), { cachedFrame } = await import(p), { activeSession } = await import(e), { view } = await import(v);
  const doc = activeSession.document, d = framePlan(doc, view().playheadMs).draws.find((x: { item: { id: string } }) => x.item.id === 'vid');
  return !!d && !!cachedFrame(`${d.item.metadata.assetId}:${kind}`, d.sourceMs);
}, kind);

test('F10: with the proxy ready, Use Proxy flips the resolved source proxy -> original -> proxy; the shown frame and canvas size stay', async ({ page }) => {
  const d = videoDoc([{ id: 'vid', from: 500, to: 2500, trim: 200, sourceDuration: 3000 }], { duration: 3000 });
  await openWithVideos(page, d, { vid: { path: makeClip(3) } }, 'T15 proxy resolved');
  await expect.poll(() => page.evaluate(async () => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    return (await projectStore.library()).assets.map((a: { processing_steps?: Record<string, string> }) => a.processing_steps?.proxy);
  }), { timeout: 60_000, message: 'the proxy step completes' }).toEqual(['complete']);
  await seekMs(page, 1500); await shown(page, 45);
  await expect.poll(() => stageDecoded(page, 'proxy'), { timeout: 15_000, message: 'the stage drew the paused frame from the proxy' }).toBe(true);
  await shown(page, 45);
  const size = await canvasSizeOf(page);
  expect(await resolvedKind(page), 'Use Proxy on by default: the proxy is shown').toBe('proxy');
  for (const [useProxy, kind] of [[false, 'original'], [true, 'proxy']] as const) {
    // Review 17f1959a delta finding 1: the stage's asset map lags the store by a library poll (editor/shell.tsx:48-58), so the seek may have cached
    // original@1200 before the proxy arrived, and proxy@1200 is cached above. Dropping the target source's frames (decoder-pool.ts dropFrames) leaves
    // only the stage's render after this toggle to satisfy the poll below.
    await page.evaluate(async kind => {
      const p = '/src/render/decoder-pool.ts', e = '/src/editor.tsx';
      const { dropFrames } = await import(p), { activeSession } = await import(e);
      dropFrames(`${activeSession.document.items.find((i: { id: string }) => i.id === 'vid').metadata.assetId}:${kind}`);
    }, kind);
    const r = await runtimeCall(page, 'setUseProxy', { itemId: 'vid', useProxy }) as { success: boolean };
    expect(r.success).toBe(true);
    expect(await resolvedKind(page), `after useProxy ${useProxy}: resolved source`).toBe(kind);
    await expect.poll(() => stageDecoded(page, kind), { timeout: 15_000, message: `after useProxy ${useProxy}: the stage drew from the ${kind}` }).toBe(true);
    await shown(page, 45);
    expect(await runCanvas(page).getAttribute('data-frame'), `after useProxy ${useProxy}: same frame`).toBe('45');
    expect(await canvasSizeOf(page), `after useProxy ${useProxy}: same canvas size`).toEqual(size);
  }
});
