// SPDX-License-Identifier: AGPL-3.0-only
// T03: dragging a clip onto another compatible lane moves it there as one "Move item" step. The occupied-lane refusal (COLLISION) is asserted
// in t02-timeline D7; this file covers the successful case t02-timeline D7 can no longer reach with its original fixture.
import { test, expect } from '@playwright/test';
import { clip, intents, openEditor, richDoc, skipTour, stored, watchIntents } from './t02-support';
import { itemById, liveDoc, savedDoc, spanOf, undoEntries } from './t03-support';

test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1600, height: 900 }); });

test('a lane drop onto a free stretch of a compatible lane moves the item there (one "Move item"), and one Undo puts it back', async ({ page }) => {
  const doc0 = richDoc(); doc0.items = doc0.items.filter(i => i.id !== 'clipA'); // v1 is free at 2.4–6.4 s
  const id = await openEditor(page, doc0); await watchIntents(page); const before = await stored(page, id), original = JSON.parse(before.json);
  await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Snapping', exact: true }).click();
  const cb = (await clip(page, 'clipC').boundingBox())!, from = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 }, lane = (await page.locator('.lane[data-track-id="v1"]').boundingBox())!;
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + 20, from.y + 10, { steps: 4 }); await page.mouse.move(from.x + 20, lane.y + lane.height / 2, { steps: 6 }); await page.mouse.up();
  const l = (await intents(page)).at(-1)!; expect(l.intent).toMatchObject({ type: 'moveItems', itemIds: ['clipC'], trackId: 'v1', newTrack: false }); expect(l.outcome).toEqual({ ok: true });
  const doc = await liveDoc(page); expect(itemById(doc, 'clipC')).toMatchObject({ trackId: 'v1' }); expect(spanOf(doc, 'clipC')).toEqual([2400, 6400]); // +20 px at zoom 0.05 = +400 ms
  expect(await undoEntries(page)).toEqual([{ label: 'Move item', source: 'user' }]);
  const saved = await savedDoc(page, id); expect(itemById(saved, 'clipC')).toMatchObject({ trackId: 'v1' }); expect((await stored(page, id)).rev).toBeGreaterThan(before.rev);
  await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Undo', exact: true }).click();
  const back = await liveDoc(page); expect({ ...back, rev: 0 }).toEqual({ ...original, rev: 0 }); expect(await undoEntries(page)).toEqual([]);
});
