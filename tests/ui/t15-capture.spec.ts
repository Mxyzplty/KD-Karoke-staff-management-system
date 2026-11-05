// SPDX-License-Identifier: AGPL-3.0-only
// T15 captureFrame (render/capture.ts, exported function captureFrame(env, args); T18 owns the transport). Needs ffmpeg for a 1 s clip.
// Written-spec oracle (findings: agent tool contract captureFrame, G-02, G-03, G-06): timestamps snap to round(t x fps) halves up,
// at most 5, default = the playhead, out of range -> TIME_OUT_OF_RANGE, schema errors -> INVALID_TOOL_INPUT, JPEG image blocks,
// standard 378 x 672 / high 810 x 1440 for 1080 x 1920, read-only.
// PROVISIONAL (P13-P15): the text block's JSON shape, the refusal texts, black backdrop, JPEG quality, sizes on other canvases.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { liveDoc, storedDoc, undoLabels } from './t03-support';
import { makeClip, openWithVideos, videoDoc } from './t15-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the 1 s H.264 clip that is captured');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

type Capture = { result: Record<string, any>; images: { width: number; height: number; magic: number[]; mean: number; max: number; chars: number }[] };
/** Runs captureFrame(env, args) in the page with the playhead at `playheadMs`; decodes every JPEG block to size and pixel stats. */
async function capture(page: Page, args: Record<string, unknown>, playheadMs = 0): Promise<Capture> {
  return page.evaluate(async ({ args, playheadMs }) => {
    const c = '/src/render/capture.ts', d = '/src/store/database.ts', e = '/src/editor.tsx', v = '/src/editor/view.ts';
    const { captureFrame } = await import(c), { projectStore } = await import(d), { activeSession } = await import(e), { setView } = await import(v);
    setView({ playheadMs });
    const assets = (await projectStore.library()).assets as { id: string }[];
    const result = await captureFrame({ store: projectStore, doc: activeSession.document, asset: (id: string) => assets.find(a => a.id === id), playheadMs }, args);
    const images = [];
    for (const block of (result.content ?? []).filter((b: { type: string }) => b.type === 'image')) {
      const bin = atob(block.base64), bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0)), bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height), ctx = cv.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data; let sum = 0, max = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) { sum += px[i + k]; max = Math.max(max, px[i + k]); n++; }
      images.push({ width: bmp.width, height: bmp.height, magic: [...bytes.subarray(0, 3)], mean: sum / n, max, chars: block.base64.length });
    }
    // The base64 payloads stay in the page; only their shape comes back.
    return { result: { ...result, content: result.content?.map((b: { type: string; text?: string; mimeType?: string; base64?: string }) => b.type === 'text' ? b : { type: b.type, mimeType: b.mimeType, keys: Object.keys(b) }) }, images };
  }, { args, playheadMs });
}
const text = (r: Capture) => JSON.parse(r.result.content[0].text);
const SECONDS = 1;
/** A clip on [500, 1000] ms of a 1 s project, so [0, 500) is empty (black backdrop). */
const open = (page: Page, fps?: number) => openWithVideos(page, videoDoc([{ id: 'vid', from: 500, to: SECONDS * 1000, sourceDuration: 1000 }], { duration: SECONDS * 1000, ...fps ? { fps } : {} }), { vid: { path: makeClip(SECONDS) } }, 'T15 capture');

test('content: one text block (JSON) then one image/jpeg block per timestamp, with the stored sizes 378 x 672 (standard) and 810 x 1440 (high)', async ({ page }) => {
  await open(page);
  const std = await capture(page, { timestamps: [0.6, 0.8] });
  expect(std.result.success).toBe(true);
  expect(std.result.content.map((b: any) => b.type)).toEqual(['text', 'image', 'image']);
  expect(std.result.content.slice(1)).toEqual([{ type: 'image', mimeType: 'image/jpeg', keys: ['type', 'mimeType', 'base64'] }, { type: 'image', mimeType: 'image/jpeg', keys: ['type', 'mimeType', 'base64'] }]);
  const t = text(std);
  expect(t).toMatchObject({ success: true, quality: 'standard' });
  expect(t.frames).toEqual([{ timestamp: 0.6, frame: 18, time: 0.6, width: 378, height: 672 }, { timestamp: 0.8, frame: 24, time: 0.8, width: 378, height: 672 }]);
  expect(std.images.map(i => [i.width, i.height])).toEqual([[378, 672], [378, 672]]);
  for (const i of std.images) expect(i.magic).toEqual([0xff, 0xd8, 0xff]);
  const high = await capture(page, { timestamps: [0.6], quality: 'high' });
  expect(text(high).quality).toBe('high'); expect(high.images.map(i => [i.width, i.height])).toEqual([[810, 1440]]);
  expect(text(high).frames[0]).toMatchObject({ width: 810, height: 1440 });
});

test('the picture is the composed frame: black backdrop where nothing plays, the clip where it does', async ({ page }) => {
  await open(page);
  const r = await capture(page, { timestamps: [0.1, 0.8] });
  const [empty, clip] = r.images;
  expect(empty.max, 'empty time: black backdrop (JPEG noise only)').toBeLessThanOrEqual(8);
  expect(clip.mean, 'clip time: the testsrc2 picture is clearly not black').toBeGreaterThan(20);
});

test('timestamps snap to the preview frame round(t x fps), halves up (fps 2: 0.25 s -> frame 1, 0.75 s -> frame 2)', async ({ page }) => {
  await open(page, 2);
  const r = await capture(page, { timestamps: [0, 0.2, 0.25, 0.49, 0.75, 1] });
  expect(r.result.success).toBe(false); // six timestamps: over the limit (see the next test); snapping is checked with five
  const five = await capture(page, { timestamps: [0.2, 0.25, 0.49, 0.75, 1] });
  expect(five.result.success).toBe(true);
  expect(text(five).frames.map((f: any) => [f.timestamp, f.frame, f.time])).toEqual([[0.2, 0, 0], [0.25, 1, 0.5], [0.49, 1, 0.5], [0.75, 2, 1], [1, 2, 1]]);
});

test('at most 5 timestamps; the 6th is INVALID_TOOL_INPUT (schema shape), 5 are fine', async ({ page }) => {
  await open(page);
  const six = await capture(page, { timestamps: [0, 0.1, 0.2, 0.3, 0.4, 0.5] });
  expect(six.result).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for captureFrame', message: '$.timestamps: must have at most 5 items', data: { details: { errors: [{ path: '$.timestamps', code: 'MAXITEMS', message: 'must have at most 5 items' }] } } });
  const five = await capture(page, { timestamps: [0, 0.1, 0.2, 0.3, 0.4] });
  expect(five.result.success).toBe(true); expect(five.images).toHaveLength(5); expect(five.result.content).toHaveLength(6);
});

test('default timestamp is the playhead', async ({ page }) => {
  await open(page);
  for (const [ms, frame] of [[0, 0], [700, 21], [1000, 30]] as const) {
    const r = await capture(page, {}, ms);
    expect(r.result.success).toBe(true);
    const f = text(r).frames;
    expect(f).toHaveLength(1); expect(f[0]).toMatchObject({ timestamp: ms / 1000, frame, width: 378, height: 672 });
    expect(f[0].time).toBeCloseTo(frame / 30, 6);
  }
});

test('out of range -> TIME_OUT_OF_RANGE (negative, past the end); the end itself is allowed', async ({ page }) => {
  await open(page);
  const past = await capture(page, { timestamps: [0.2, 1.5] });
  expect(past.result).toMatchObject({ success: false, code: 'TIME_OUT_OF_RANGE' });
  expect(past.result.error).toMatch(/^Time 1\.5s is outside the composition \(0s - [\d.]+s\)\.$/);
  const negative = await capture(page, { timestamps: [-0.1] });
  expect(negative.result).toMatchObject({ success: false, code: 'TIME_OUT_OF_RANGE' }); expect(negative.result.error).toMatch(/^Time -0\.1s is outside the composition/);
  expect((await capture(page, { timestamps: [1] })).result.success).toBe(true);
  expect((await capture(page, { timestamps: [0] })).result.success).toBe(true);
});

test('schema refusals: wrong quality, non-array timestamps, non-number timestamp', async ({ page }) => {
  await open(page);
  const refusal = (path: string, code: string, message: string) => ({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for captureFrame', message: `${path}: ${message}`, data: { details: { errors: [{ path, code, message }] } } });
  expect((await capture(page, { quality: 'ultra' })).result).toEqual(refusal('$.quality', 'ENUM', 'must be one of standard, high'));
  expect((await capture(page, { timestamps: '0.5' })).result).toEqual(refusal('$.timestamps', 'TYPE', 'must be array'));
  expect((await capture(page, { timestamps: [0.1, 'x'] })).result).toEqual(refusal('$.timestamps[1]', 'TYPE', 'must be number'));
  expect((await capture(page, { timestamps: [Number.NaN] })).result).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT' });
});

test('read-only: no revision change, no undo entry, nothing stored', async ({ page }) => {
  const id = await open(page), before = JSON.stringify(await liveDoc(page)), stored = JSON.stringify(await storedDoc(page, id));
  await capture(page, { timestamps: [0.6, 0.8], quality: 'high' }); await capture(page, { timestamps: [9] }); await capture(page, { quality: 'bad' });
  expect(JSON.stringify(await liveDoc(page))).toBe(before);
  expect(await undoLabels(page)).toEqual([]);
  await page.waitForTimeout(3500); // past the 3 s autosave
  expect(JSON.stringify(await storedDoc(page, id))).toBe(stored);
});
