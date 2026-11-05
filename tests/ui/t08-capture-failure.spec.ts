// SPDX-License-Identifier: AGPL-3.0-only
// T08 silent render failure (review M2), end to end: a motion graphic that cannot be rendered is never dropped silently from captureFrame. The frame is still
// returned (success, one image block), and the frame's notRendered names the graphic, its id and the renderer's error. A graphic that renders is not listed.
// Oracle: render/capture.ts contract (notRendered lists what the frame lacks; "Motion graphic '<name>' (<id>) could not be rendered: <code>: <message>", from mg/frames.ts
// graphicPicture after two attempts); unit side in tests/t08-frames.test.ts.
import { test, expect, type Page } from '@playwright/test';
import { guard, openEditor, skipTour } from './t02-support';
import { crop, canvasSizeOf, seekMs, shown } from './t15-support';

test.setTimeout(90_000);
test.use({ viewport: { width: 1280, height: 800 } });
test.beforeEach(async ({ page }) => { guard(page); await skipTour(page); });

const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
const GOOD = `export const G = () => <AbsoluteFill style={{ backgroundColor: '#0000ff' }} />;`;
const BROKEN = `export const G = () => { throw new Error('boom in render'); };`;
const graphic = (id: string, trackId: string, name: string, code: string, from: number, to: number) => ({
  id, type: 'motionGraphic', trackId, display: { from, to }, trim: { from: 0, to: to - from }, sourceDuration: to - from, playbackRate: 1, details: { name, code }, metadata: {}, effects: [], masks: [],
  properties: { positionX: prop(0), positionY: prop(0), width: prop(540), height: prop(960), scale: prop(1) },
});
const track = (id: string, name: string) => ({ id, name, kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 });
/** Good graphic g-good at 0-2 s on o1, broken g-bad at 2-4 s on o2, both 540 x 960. */
const doc = () => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 4000, fps: 30, size: { width: 540, height: 960 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: [track('o1', 'O1'), track('o2', 'O2')], layerOrder: [{ type: 'track', id: 'o1' }, { type: 'track', id: 'o2' }],
  items: [graphic('g-good', 'o1', 'Blue card', GOOD, 0, 2000), graphic('g-bad', 'o2', 'Broken card', BROKEN, 2000, 4000)],
});

type Captured = { success: boolean; frames: { timestamp: number; notRendered?: string[] }[]; images: number };
const capture = (page: Page, timestamps: number[]) => page.evaluate(async timestamps => {
  const c = '/src/render/capture.ts', d = '/src/store/database.ts', e = '/src/editor.tsx';
  const { captureFrame } = await import(c), { projectStore } = await import(d), { activeSession } = await import(e);
  const assets = (await projectStore.library()).assets as { id: string }[];
  const r = await captureFrame({ store: projectStore, doc: activeSession.document, asset: (id: string) => assets.find(a => a.id === id), playheadMs: 0 }, { timestamps });
  const content = (r.content ?? []) as { type: string; text?: string }[];
  return { success: r.success as boolean, frames: JSON.parse(content[0].text!).frames, images: content.filter(b => b.type === 'image').length };
}, timestamps) as Promise<Captured>;

test('a broken graphic is listed in notRendered by name, id and the renderer\'s error; the frame is still captured', async ({ page }) => {
  await openEditor(page, doc(), 'T08 capture failure');
  const r = await capture(page, [3]);
  expect(r.success).toBe(true);
  expect(r.images).toBe(1);
  expect(r.frames).toHaveLength(1);
  expect(r.frames[0].notRendered).toHaveLength(1);
  expect(r.frames[0].notRendered![0]).toMatch(/^Motion graphic 'Broken card' \(g-bad\) could not be rendered: .*boom in render/);
});

test('a graphic that renders is not listed: the frame has no notRendered', async ({ page }) => {
  await openEditor(page, doc(), 'T08 capture ok');
  const r = await capture(page, [1]);
  expect(r.success).toBe(true);
  expect(r.images).toBe(1);
  expect(r.frames[0].notRendered).toBeUndefined();
});

test('several frames: only the frames that show the broken graphic list it, once each', async ({ page }) => {
  await openEditor(page, doc(), 'T08 capture mixed');
  const r = await capture(page, [0.5, 2.5, 3.5]);
  expect(r.images).toBe(3);
  expect(r.frames.map(f => f.notRendered?.length ?? 0)).toEqual([0, 1, 1]);
  for (const f of r.frames.slice(1)) expect(f.notRendered![0]).toContain("'Broken card' (g-bad)");
});

test('control: in a project that also holds a broken graphic, the working one still draws in the paused stage (centre pixel is its blue)', async ({ page }) => {
  await openEditor(page, doc(), 'T08 capture stage');
  await seekMs(page, 500); await shown(page, 15);
  const size = await canvasSizeOf(page), px = await crop(page, Math.floor(size.width / 2), Math.floor(size.height / 2), 1, 1);
  expect([px[0], px[1], px[2]], 'blue card drawn').toEqual([0, 0, 255]);
});
