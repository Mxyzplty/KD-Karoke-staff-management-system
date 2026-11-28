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
