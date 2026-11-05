// SPDX-License-Identifier: AGPL-3.0-only
// T15 stored transitions are "not rendered yet" until T11 (review NB5). Needs ffmpeg for the 4 s clip.
// Written-spec oracle: findings part 5 §55.2 (alignment table l.1041-1054: the window is [cut - floor(D x a), +D)) and results §11 decision 1
// (Cutframe renders transitions in the preview, so until T11 the stage says so and captureFrame lists it in notRendered).
// Timeline: clip a on V1 [0, 2 s), clip b on V1 [2 s, 4 s), one dissolve a -> b, D = 1000 ms, alignment 0.5: the window is [1500, 2500) ms.
// The draws stay a hard cut (unit-tested in t15-model.test.ts); this spec checks the user-visible note and captureFrame's notRendered.
// T11 (C8 assertion-only edit): transitions render now. The note never shows, captureFrame has no notRendered inside the window,
// and the frame plan draws the tagged pair there (outside it, one clip).
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { makeClip, openWithVideos, seekMs, shown, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the 4 s H.264 clip');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const note = (page: Page) => page.locator('p.pending-render');
async function open(page: Page) {
  const doc = videoDoc([{ id: 'a', from: 0, to: 2000, sourceDuration: 4000 }, { id: 'b', from: 2000, to: 4000, sourceDuration: 4000 }],
    { duration: 4000, transitions: [{ id: 'tr1', trackId: 'v1', fromId: 'a', toId: 'b', kind: 'dissolve', durationMs: 1000, alignment: 0.5 }] });
  await openWithVideos(page, doc, { a: { path: makeClip(4) }, b: { path: makeClip(4) } }, 'T15 transition note');
}
const notRendered = (page: Page, seconds: number) => page.evaluate(async seconds => {
  const c = '/src/render/capture.ts', d = '/src/store/database.ts', e = '/src/editor.tsx';
  const { captureFrame } = await import(c), { projectStore } = await import(d), { activeSession } = await import(e);
  const assets = (await projectStore.library()).assets as { id: string }[];
  const r = await captureFrame({ store: projectStore, doc: activeSession.document, asset: (id: string) => assets.find(a => a.id === id), playheadMs: 0 }, { timestamps: [seconds] });
  return { success: r.success as boolean, notRendered: (JSON.parse(r.content[0].text).frames[0].notRendered ?? null) as string[] | null };
}, seconds);

/** T11 (C8): the frame plan's draws at ms, as [item id, transition role or null]. */
const plan = (page: Page, ms: number) => page.evaluate(async ms => {
  const m = '/src/render/model.ts', e = '/src/editor.tsx';
  const { framePlan } = await import(m), { activeSession } = await import(e);
  return (framePlan(activeSession.document, ms).draws as { item: { id: string }; transition?: { id: string; role: string } }[]).map(d => [d.item.id, d.transition ? `${d.transition.id}:${d.transition.role}` : null]);
}, ms);

test('T11 (C8): the stage note is gone inside the transition window [1500, 2500) ms, where the pair is drawn, and absent outside it', async ({ page }) => {
  await open(page);
  await shown(page, 0);
  await expect(note(page), 'frame 0 is outside the window').toHaveCount(0);
  for (const [ms, frame] of [[1500, 45], [2000, 60], [2466, 74]] as const) {
    await seekMs(page, ms); await shown(page, frame);
    await expect(note(page), `${ms} ms is inside: no note, T11 renders it`).toHaveCount(0); // T11 (C8)
    expect(await plan(page, ms), `${ms} ms draws the pair`).toEqual([['a', 'tr1:from'], ['b', 'tr1:to']]); // T11 (C8)
  }
  for (const [ms, frame] of [[1466, 44], [2500, 75], [3500, 105]] as const) {
    await seekMs(page, ms); await shown(page, frame);
    await expect(note(page), `${ms} ms is outside`).toHaveCount(0);
    expect(await plan(page, ms), `${ms} ms is one clip`).toEqual([[ms < 2000 ? 'a' : 'b', null]]); // T11 (C8)
  }
});

test('T11 (C8): captureFrame omits notRendered inside the window and outside it', async ({ page }) => {
  await open(page);
  const inside = await notRendered(page, 1.7);
  expect(inside.success).toBe(true);
  expect(inside.notRendered, 'T11 (C8): rendered inside the window').toBeNull();
  expect((await notRendered(page, 0.5)).notRendered, 'before the window').toBeNull();
  expect((await notRendered(page, 3)).notRendered, 'after the window').toBeNull();
});
