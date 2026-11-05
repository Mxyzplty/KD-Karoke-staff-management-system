// SPDX-License-Identifier: AGPL-3.0-only
// T08 render behaviour written from the spec: D25 Sequence style, OffthreadVideo trim/playbackRate timing (research §1.3 item 9,
// decision Q7), and the D25 item box (graphic laid out at the box size and placed at the box, no scaling).
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { counterVideo, longCounterVideo, ntscCounterVideo, offsetCounterVideo, oneFrameVideo, sparseWebm } from './t08-support';

const GREEN = [0, 255, 0, 255], CLEAR = [0, 0, 0, 0];

// ---------------------------------------------------------------------------------------------------------------------
// (a) D25: a Sequence `style` is drawn.
// ---------------------------------------------------------------------------------------------------------------------
test('Sequence style backgroundColor tints a dark AbsoluteFill (public Remotion behaviour, D25)', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const probes = [[0, 0], [31, 31], [63, 63], [5, 58]];
    const grab = async (code: string, frame: number) => {
      const r = await renderer.render({ code, frame, width: 64, height: 64, fps: 30, durationInFrames: 60 });
      const image = new Image(); image.src = r.image; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      return probes.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
    };
    const tint = (from: number) => `export const Graphic = () => <AbsoluteFill><AbsoluteFill style={{backgroundColor:'#101010'}} /><Sequence from={${from}} style={{backgroundColor:'rgba(42,157,143,0.12)'}}><div /></Sequence></AbsoluteFill>;`;
    const out = { tinted: await grab(tint(0), 3), before: await grab(tint(10), 3), plain: await grab(`export const Graphic = () => <AbsoluteFill style={{backgroundColor:'#101010'}} />;`, 3) };
    renderer.dispose(); return out;
  });
  // 0.12 * (42,157,143) + 0.88 * (16,16,16) = (19.1, 32.9, 31.2)
  for (const p of result.tinted) {
    expect(Math.abs(p[0] - 19)).toBeLessThanOrEqual(2); expect(Math.abs(p[1] - 33)).toBeLessThanOrEqual(2); expect(Math.abs(p[2] - 31)).toBeLessThanOrEqual(2); expect(p[3]).toBe(255);
  }
  // Not yet mounted (frame 3 < from 10): no tint; identical to the plain fill.
  for (const p of result.before) expect(p).toEqual([16, 16, 16, 255]);
  for (const p of result.plain) expect(p).toEqual([16, 16, 16, 255]);
});

// ---------------------------------------------------------------------------------------------------------------------
// (b) OffthreadVideo timing against a counter video: 8 luma blocks encode the source frame number in binary.
// ---------------------------------------------------------------------------------------------------------------------
type VideoCase = { name: string; frame: number; props: string; seq?: number; expected: number | null };
const VIDEO_CASES: VideoCase[] = [
  // plain: source frame = f
  { name: 'plain f0', frame: 0, props: '', expected: 0 },
  { name: 'plain f7', frame: 7, props: '', expected: 7 },
  { name: 'plain f40', frame: 40, props: '', expected: 40 },
  // trimBefore / startFrom: source = trimBefore + f
  { name: 'trimBefore 10, f0', frame: 0, props: 'trimBefore={10}', expected: 10 },
  { name: 'trimBefore 10, f5', frame: 5, props: 'trimBefore={10}', expected: 15 },
  { name: 'startFrom 10, f0', frame: 0, props: 'startFrom={10}', expected: 10 },
  { name: 'startFrom 10, f5', frame: 5, props: 'startFrom={10}', expected: 15 },
  // playbackRate: source = rate * f (no frame early)
  { name: 'rate 2, f0', frame: 0, props: 'playbackRate={2}', expected: 0 },
  { name: 'rate 2, f5', frame: 5, props: 'playbackRate={2}', expected: 10 },
  { name: 'rate 2, f13', frame: 13, props: 'playbackRate={2}', expected: 26 },
  { name: 'rate 0.5, f6', frame: 6, props: 'playbackRate={0.5}', expected: 3 },
  { name: 'rate 0.5, f8', frame: 8, props: 'playbackRate={0.5}', expected: 4 },
  { name: 'rate 1.5, f4', frame: 4, props: 'playbackRate={1.5}', expected: 6 },
  { name: 'trimBefore 4 + rate 2, f3', frame: 3, props: 'trimBefore={4} playbackRate={2}', expected: 10 },
  { name: 'startFrom 4 + rate 2, f3', frame: 3, props: 'startFrom={4} playbackRate={2}', expected: 10 },
  // trim window end: nothing drawn once local frame >= (trimAfter - trimBefore) / playbackRate
  { name: 'trimAfter 90, f89', frame: 89, props: 'trimBefore={0} trimAfter={90}', expected: 89 },
  { name: 'trimAfter 90, f90 (window ended)', frame: 90, props: 'trimBefore={0} trimAfter={90}', expected: null },
  { name: 'trimAfter 90, f100 (still nothing, no held frame)', frame: 100, props: 'trimBefore={0} trimAfter={90}', expected: null },
  { name: 'trimBefore 20 trimAfter 50, f29', frame: 29, props: 'trimBefore={20} trimAfter={50}', expected: 49 },
  { name: 'trimBefore 20 trimAfter 50, f30 (window ended)', frame: 30, props: 'trimBefore={20} trimAfter={50}', expected: null },
  { name: 'rate 2 trimBefore 10 trimAfter 50, f19', frame: 19, props: 'playbackRate={2} trimBefore={10} trimAfter={50}', expected: 48 },
  { name: 'rate 2 trimBefore 10 trimAfter 50, f20 (window ended)', frame: 20, props: 'playbackRate={2} trimBefore={10} trimAfter={50}', expected: null },
  // older names, same behaviour (decision Q7)
  { name: 'startFrom 20 endAt 50, f29', frame: 29, props: 'startFrom={20} endAt={50}', expected: 49 },
  { name: 'startFrom 20 endAt 50, f30 (window ended)', frame: 30, props: 'startFrom={20} endAt={50}', expected: null },
  { name: 'endAt 30 only, f29', frame: 29, props: 'endAt={30}', expected: 29 },
  { name: 'endAt 30 only, f30 (window ended)', frame: 30, props: 'endAt={30}', expected: null },
  { name: 'rate 2 startFrom 10 endAt 50, f20 (window ended)', frame: 20, props: 'playbackRate={2} startFrom={10} endAt={50}', expected: null },
  // inside <Sequence from={30}>: nothing before 30, source f-30, empty from 120
  { name: 'Sequence from 30: f29', frame: 29, seq: 30, props: 'trimBefore={0} trimAfter={90}', expected: null },
  { name: 'Sequence from 30: f30', frame: 30, seq: 30, props: 'trimBefore={0} trimAfter={90}', expected: 0 },
  { name: 'Sequence from 30: f31', frame: 31, seq: 30, props: 'trimBefore={0} trimAfter={90}', expected: 1 },
  { name: 'Sequence from 30: f100', frame: 100, seq: 30, props: 'trimBefore={0} trimAfter={90}', expected: 70 },
  { name: 'Sequence from 30: f119', frame: 119, seq: 30, props: 'trimBefore={0} trimAfter={90}', expected: 89 },
  { name: 'Sequence from 30: f120 (empty)', frame: 120, seq: 30, props: 'trimBefore={0} trimAfter={90}', expected: null },
];

test('OffthreadVideo shows source frame trimBefore + playbackRate * f, and nothing after the trim window ends', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the counter video');
  test.setTimeout(180_000);
  const video = 'data:video/mp4;base64,' + readFileSync(counterVideo()).toString('base64');
  await page.goto('/src/mg/harness.html');
  const decoded = await page.evaluate(async ({ src, cases }) => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const out: (number | null)[] = [];
    for (const c of cases) {
      const video = `<OffthreadVideo src={getAssetUrl('clip')} style={{width:64,height:64}} muted={true} volume={0} ${c.props} />`;
      const body = c.seq === undefined ? video : `<Sequence from={${c.seq}}>${video}</Sequence>`;
      const code = `export const Graphic = () => ${body};`;
      // CF3-m1: one retry only on "Video frame load timeout." (a cold first media load while many browsers start, as the
      // product's m3 retry); a wrong picture or any other error still fails at once.
      const render = () => renderer.render({ code, frame: c.frame, width: 64, height: 64, fps: 30, durationInFrames: 200, assetMap: { clip: src } });
      const r = await render().catch((e: Error) => { if (e?.message !== 'Video frame load timeout.') throw e; return render(); });
      const image = new Image(); image.src = r.image; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      const all = ctx.getImageData(0, 0, 64, 64).data; let maxAlpha = 0;
      for (let i = 3; i < all.length; i += 4) maxAlpha = Math.max(maxAlpha, all[i]);
      if (maxAlpha === 0) { out.push(null); continue; }
      let n = 0;
      for (let k = 0; k < 8; k++) { const p = ctx.getImageData(4 + 8 * k, 32, 1, 1).data; if (p[3] === 255 && p[0] > 128) n |= 1 << k; }
      out.push(n);
    }
    renderer.dispose(); return out;
  }, { src: video, cases: VIDEO_CASES });
  const mismatches = VIDEO_CASES.flatMap((c, i) => decoded[i] === c.expected ? [] : [`${c.name}: expected ${c.expected === null ? 'nothing drawn' : 'source frame ' + c.expected}, got ${decoded[i] === null ? 'nothing drawn' : 'source frame ' + decoded[i]}`]);
  expect(mismatches).toEqual([]);
});

// Decision Q7 at playbackRate !== 1 (D29): the cut is at the SOURCE frame trimAfter / endAt, so the last drawn graphic frame
// is the largest f with trimBefore + f * playbackRate < that cut. Xapp's export cuts later only because Remotion 4.0.427 does
// not divide endAt by playbackRate; the switch default stays current Remotion. 07 is the first pair (startFrom 60, endAt 210,
// rate 2): f74 shows source 208, f75 and later draw nothing. Every pinned source frame is an integer, so none of these cases
// depends on the open question CF3-n1 (which frame a fractional source time shows).
const RATE_CUT_CASES: VideoCase[] = [
  { name: 'rate 2 trimBefore 60 trimAfter 210, f74 (last drawn)', frame: 74, props: 'playbackRate={2} trimBefore={60} trimAfter={210}', expected: 208 },
  { name: 'rate 2 trimBefore 60 trimAfter 210, f75 (cut)', frame: 75, props: 'playbackRate={2} trimBefore={60} trimAfter={210}', expected: null },
  { name: 'rate 2 startFrom 60 endAt 210, f74 (last drawn, 07)', frame: 74, props: 'playbackRate={2} startFrom={60} endAt={210}', expected: 208 },
  { name: 'rate 2 startFrom 60 endAt 210, f75 (cut, 07)', frame: 75, props: 'playbackRate={2} startFrom={60} endAt={210}', expected: null },
  { name: 'rate 1.5 trimBefore 10 trimAfter 50, f26 (last drawn)', frame: 26, props: 'playbackRate={1.5} trimBefore={10} trimAfter={50}', expected: 49 },
  { name: 'rate 1.5 trimBefore 10 trimAfter 50, f27 (cut)', frame: 27, props: 'playbackRate={1.5} trimBefore={10} trimAfter={50}', expected: null },
  { name: 'rate 1.5 startFrom 10 endAt 50, f26 (last drawn)', frame: 26, props: 'playbackRate={1.5} startFrom={10} endAt={50}', expected: 49 },
  { name: 'rate 1.5 startFrom 10 endAt 50, f27 (cut)', frame: 27, props: 'playbackRate={1.5} startFrom={10} endAt={50}', expected: null },
];

test('at playbackRate != 1, OffthreadVideo cuts at the source frame trimAfter / endAt (decision Q7, D29)', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the counter video');
  test.setTimeout(120_000);
  // 240 frames: source frame 208 is past the 120-frame counter's end.
  const video = 'data:video/mp4;base64,' + readFileSync(longCounterVideo()).toString('base64');
  await page.goto('/src/mg/harness.html');
  const decoded = await page.evaluate(async ({ src, cases }) => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const out: (number | null)[] = [];
    for (const c of cases) {
      const code = `export const Graphic = () => <OffthreadVideo src={getAssetUrl('clip')} style={{width:64,height:64}} muted={true} volume={0} ${c.props} />;`;
      // CF3-m1: one retry only on "Video frame load timeout.", as in the case loop above.
      const render = () => renderer.render({ code, frame: c.frame, width: 64, height: 64, fps: 30, durationInFrames: 300, assetMap: { clip: src } });
      const r = await render().catch((e: Error) => { if (e?.message !== 'Video frame load timeout.') throw e; return render(); });
      const image = new Image(); image.src = r.image; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      const all = ctx.getImageData(0, 0, 64, 64).data; let maxAlpha = 0;
      for (let i = 3; i < all.length; i += 4) maxAlpha = Math.max(maxAlpha, all[i]);
      if (maxAlpha === 0) { out.push(null); continue; }
      let n = 0;
      for (let k = 0; k < 8; k++) { const p = ctx.getImageData(4 + 8 * k, 32, 1, 1).data; if (p[3] === 255 && p[0] > 128) n |= 1 << k; }
      out.push(n);
    }
    renderer.dispose(); return out;
  }, { src: video, cases: RATE_CUT_CASES });
  const mismatches = RATE_CUT_CASES.flatMap((c, i) => decoded[i] === c.expected ? [] : [`${c.name}: expected ${c.expected === null ? 'nothing drawn' : 'source frame ' + c.expected}, got ${decoded[i] === null ? 'nothing drawn' : 'source frame ' + decoded[i]}`]);
  expect(mismatches).toEqual([]);
});

// CI fix 2 round 2 (review CF-B1, CF-M1, CF-M2): the element's frame spans do not tell which frame a time shows. The first
// frame starts at 0.5 s; the only frame of a 3 s file is shown throughout; frames 1 s apart are reported as 1/30 s long.
// Round 3 (review CF2-B1): a 29.97 fps clip in a 30 fps graphic. Frame 30 starts 1 ms after source time 1 s, inside the
// nudge, so it is the frame there; a seek to its start would show frame 29 (Chromium truncates to whole microseconds).
const SPAN_CASES = [
  { clip: 'offset', frame: 0, expected: 0 }, { clip: 'offset', frame: 10, expected: 0 }, { clip: 'offset', frame: 15, expected: 0 },
  { clip: 'offset', frame: 16, expected: 1 }, { clip: 'offset', frame: 45, expected: 30 },
  { clip: 'one', frame: 0, expected: 5 }, { clip: 'one', frame: 30, expected: 5 }, { clip: 'one', frame: 89, expected: 5 },
  { clip: 'sparse', frame: 15, expected: 0 }, { clip: 'sparse', frame: 45, expected: 30 }, { clip: 'sparse', frame: 100, expected: 90 },
  { clip: 'ntsc', frame: 29, expected: 29 }, { clip: 'ntsc', frame: 30, expected: 30 }, { clip: 'ntsc', frame: 31, expected: 30 }, { clip: 'ntsc', frame: 60, expected: 59 },
] as const;

test('OffthreadVideo draws the source frame at the time: first frame at 0.5 s, one frame in a 3 s file, frames 1 s apart, 29.97 fps', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the clips');
  test.setTimeout(120_000);
  const data = (file: string, type: string) => `data:${type};base64,` + readFileSync(file).toString('base64');
  const clips = { offset: data(offsetCounterVideo(), 'video/mp4'), one: data(oneFrameVideo(), 'video/mp4'), sparse: data(sparseWebm(), 'video/webm'), ntsc: data(ntscCounterVideo(), 'video/mp4') };
  await page.goto('/src/mg/harness.html');
  const decoded = await page.evaluate(async ({ clips, cases }) => {
    const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
    const renderer = createMotionGraphicRenderer();
    const out: (number | string)[] = [];
    for (const c of cases) {
      const code = `export const Graphic = () => <OffthreadVideo src={getAssetUrl('clip')} style={{width:64,height:64}} muted={true} volume={0} />;`;
      // CF3-m1: one retry only on "Video frame load timeout.", as in the case loop above.
      const render = () => renderer.render({ code, frame: c.frame, width: 64, height: 64, fps: 30, durationInFrames: 200, assetMap: { clip: clips[c.clip] } });
      let r;
      try { r = await render().catch((e: Error) => { if (e?.message !== 'Video frame load timeout.') throw e; return render(); }); } catch (e) { out.push(`${(e as { code?: string }).code}: ${(e as Error).message}`); continue; }
      const image = new Image(); image.src = r.image; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      let n = 0;
      for (let k = 0; k < 8; k++) { const p = ctx.getImageData(4 + 8 * k, 32, 1, 1).data; if (p[3] === 255 && p[0] > 128) n |= 1 << k; }
      out.push(ctx.getImageData(32, 32, 1, 1).data[3] === 255 ? n : 'nothing drawn');
    }
    renderer.dispose(); return out;
  }, { clips, cases: SPAN_CASES });
  const mismatches = SPAN_CASES.flatMap((c, i) => decoded[i] === c.expected ? [] : [`${c.clip} f${c.frame}: expected source frame ${c.expected}, got ${decoded[i]}`]);
  expect(mismatches).toEqual([]);
});

// Round 3 (review CF2-m1): without a frame list, a fresh element whose first frame starts at 0.5 s. Chromium has moved its
// position to 0.5 s by the time that frame is readable; every time before it still draws that first frame.
test('without a frame list, times before a 0.5 s first frame draw that frame (frames 0–10, fresh element each)', async ({ page }) => {
  test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the clip');
  const src = 'data:video/mp4;base64,' + readFileSync(offsetCounterVideo()).toString('base64');
  await page.goto('/src/mg/harness.html');
  const shown = await page.evaluate(async src => {
    const modulePath = '/src/mg/video-frame.ts'; const { showFrameAt, currentFrame } = await import(/* @vite-ignore */ modulePath);
    const url = URL.createObjectURL(await (await fetch(src)).blob()), out: (number | string)[] = [];
    for (let f = 0; f <= 10; f++) {
      const el = document.createElement('video'); el.muted = true; el.preload = 'auto'; el.src = url; document.body.append(el);
      try { await showFrameAt(el, f / 30, 30, 1800); out.push(currentFrame(el)!.start); } catch (e) { out.push((e as Error).message); }
      el.remove();
    }
    URL.revokeObjectURL(url); return out;
  }, src);
  expect(shown).toEqual(Array(11).fill(0.5));
});

// ---------------------------------------------------------------------------------------------------------------------
// (c) D25 item box: laid out at the box size (itemWidth / itemHeight), placed at the box x/y, no scaling.
// ---------------------------------------------------------------------------------------------------------------------
type Probe = [number, number];
async function renderPixels(page: import('@playwright/test').Page, code: string, canvas: [number, number], itemBox: { x: number; y: number; width: number; height: number } | undefined, probes: Probe[]) {
  return page.evaluate(async ({ code, canvas, itemBox, probes }) => {
    const modulePath = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ modulePath);
    const r = await renderMotionGraphic({ code, frame: 0, width: canvas[0], height: canvas[1], fps: 30, durationInFrames: 30, ...(itemBox ? { itemBox } : {}) });
    const image = new Image(); image.src = r.image; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(image, 0, 0);
    return { size: [r.width, r.height, image.width, image.height], pixels: probes.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data)) };
  }, { code, canvas, itemBox, probes });
}

test.describe('item box', () => {
  const BOX = { x: 8, y: 16, width: 32, height: 24 };
  test.beforeEach(async ({ page }) => { await page.goto('/src/mg/harness.html'); });

  test('itemWidth / itemHeight equal the box size and a div of that size fills exactly the box', async ({ page }) => {
    // Green only if itemWidth === 32 and itemHeight === 24; red otherwise.
    const code = `export const Graphic = () => <div style={{width:itemWidth,height:itemHeight,backgroundColor:itemWidth === 32 && itemHeight === 24 ? '#00ff00' : '#ff0000'}} />;`;
    const probes: Probe[] = [[8, 16], [39, 16], [8, 39], [39, 39], [24, 28], [7, 16], [8, 15], [40, 28], [24, 40], [7, 15], [40, 40], [0, 0], [63, 63]];
    const r = await renderPixels(page, code, [64, 64], BOX, probes);
    expect(r.size).toEqual([64, 64, 64, 64]); // the frame keeps the canvas size
    expect(r.pixels.slice(0, 5)).toEqual([GREEN, GREEN, GREEN, GREEN, GREEN]); // the four box corner pixels and the centre
    expect(r.pixels.slice(5)).toEqual(Array(probes.length - 5).fill(CLEAR)); // one pixel outside every edge and the canvas corners
  });

  test('placed at the box x/y with no scaling: 4x4 markers keep their size at the box corners', async ({ page }) => {
    const code = `export const Graphic = () => <AbsoluteFill>
      <div style={{position:'absolute', left:0, top:0, width:4, height:4, backgroundColor:'#ff0000'}} />
      <div style={{position:'absolute', left:itemWidth - 4, top:itemHeight - 4, width:4, height:4, backgroundColor:'#0000ff'}} />
    </AbsoluteFill>;`;
    const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];
    const probes: Probe[] = [[8, 16], [11, 19], [12, 20], [12, 19], [11, 20], [36, 36], [39, 39], [35, 35], [40, 40], [39, 35], [35, 39], [24, 28], [0, 0]];
    const r = await renderPixels(page, code, [64, 64], BOX, probes);
    expect(r.pixels).toEqual([RED, RED, CLEAR, CLEAR, CLEAR, BLUE, BLUE, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR]);
  });

  test('a box at a different position and size lays out again at that size (cache keys the box)', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
      const renderer = createMotionGraphicRenderer();
      const code = `export const Graphic = () => <div style={{width:itemWidth,height:itemHeight,backgroundColor:'#00ff00'}} />;`;
      const grab = async (itemBox: object) => {
        const r = await renderer.render({ code, frame: 0, width: 64, height: 64, fps: 30, durationInFrames: 30, itemBox });
        const image = new Image(); image.src = r.image; await image.decode();
        const c = document.createElement('canvas'); c.width = c.height = 64; const ctx = c.getContext('2d')!; ctx.drawImage(image, 0, 0);
        const d = ctx.getImageData(0, 0, 64, 64).data; let minX = 64, minY = 64, maxX = -1, maxY = -1, count = 0;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (d[(y * 64 + x) * 4 + 3] > 0) { count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
        return { minX, minY, maxX, maxY, count };
      };
      const a = await grab({ x: 8, y: 16, width: 32, height: 24 });
      const b = await grab({ x: 20, y: 4, width: 40, height: 10 });
      const a2 = await grab({ x: 8, y: 16, width: 32, height: 24 });
      renderer.dispose(); return { a, b, a2 };
    });
    expect(out.a).toEqual({ minX: 8, minY: 16, maxX: 39, maxY: 39, count: 32 * 24 });
    expect(out.b).toEqual({ minX: 20, minY: 4, maxX: 59, maxY: 13, count: 40 * 10 });
    expect(out.a2).toEqual(out.a);
  });

  test('without an item box itemWidth / itemHeight are the canvas size', async ({ page }) => {
    const code = `export const Graphic = () => <div style={{width:itemWidth,height:itemHeight,backgroundColor:itemWidth === 64 && itemHeight === 48 ? '#00ff00' : '#ff0000'}} />;`;
    const r = await renderPixels(page, code, [64, 48], undefined, [[0, 0], [63, 0], [0, 47], [63, 47], [32, 24]]);
    expect(r.size).toEqual([64, 48, 64, 48]);
    expect(r.pixels).toEqual(Array(5).fill(GREEN));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// D25: useVideoConfig stays the canvas; itemSize returns an item-size image (rounded, min 1) with item-local boxes.
// ---------------------------------------------------------------------------------------------------------------------
test.describe('item box and item size, video config and image size', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/src/mg/harness.html'); });
  type Opts = { itemBox?: { x: number; y: number; width: number; height: number }; itemSize?: { width: number; height: number } };
  const render = (page: import('@playwright/test').Page, code: string, opts: Opts, probes: [number, number][]) => page.evaluate(async ({ code, opts, probes }) => {
    const modulePath = '/src/mg/index.ts'; const { renderMotionGraphic } = await import(/* @vite-ignore */ modulePath);
    const r = await renderMotionGraphic({ code, frame: 0, width: 64, height: 64, fps: 30, durationInFrames: 30, ...opts });
    const image = new Image(); image.src = r.image; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(image, 0, 0);
    return { size: [r.width, r.height, image.width, image.height], boxes: r.boxes as { x: number; y: number; width: number; height: number }[], pixels: probes.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data)) };
  }, { code, opts, probes });
  const fillCode = (w: number, h: number) => `export const Graphic = () => { const c = useVideoConfig(); return <div style={{width:itemWidth,height:itemHeight,backgroundColor:itemWidth === ${w} && itemHeight === ${h} && c.width === 64 && c.height === 64 ? '#00ff00' : '#ff0000'}} />; };`;

  test('with itemBox, useVideoConfig width/height stay the canvas size while itemWidth/itemHeight are the box', async ({ page }) => {
    const r = await render(page, fillCode(32, 24), { itemBox: { x: 8, y: 16, width: 32, height: 24 } }, [[8, 16], [39, 39], [24, 28]]);
    expect(r.pixels).toEqual([GREEN, GREEN, GREEN]);
  });

  test('itemSize returns an item-size image laid out at that size; useVideoConfig stays the canvas', async ({ page }) => {
    const r = await render(page, fillCode(32, 24), { itemSize: { width: 32, height: 24 } }, [[0, 0], [31, 0], [0, 23], [31, 23], [16, 12]]);
    expect(r.size).toEqual([32, 24, 32, 24]);
    expect(r.pixels).toEqual(Array(5).fill(GREEN));
  });

  test('itemSize / itemBox sizes are rounded (Math.round) with a minimum of 1', async ({ page }) => {
    const a = await render(page, fillCode(32, 24), { itemSize: { width: 32.4, height: 23.6 } }, [[0, 0], [31, 23]]);
    expect(a.size).toEqual([32, 24, 32, 24]);
    expect(a.pixels).toEqual([GREEN, GREEN]);
    const b = await render(page, `export const Graphic = () => <div style={{width:itemWidth,height:itemHeight,backgroundColor:itemWidth === 1 && itemHeight === 1 ? '#00ff00' : '#ff0000'}} />;`, { itemSize: { width: 0.2, height: 0.3 } }, [[0, 0]]);
    expect(b.size).toEqual([1, 1, 1, 1]);
    expect(b.pixels).toEqual([GREEN]);
    const c = await render(page, fillCode(32, 24), { itemBox: { x: 8, y: 16, width: 32.4, height: 23.6 } }, [[8, 16], [39, 39], [40, 40]]);
    expect(c.size).toEqual([64, 64, 64, 64]);
    expect(c.pixels).toEqual([GREEN, GREEN, CLEAR]);
  });

  test('itemSize boxes are item-local (inside the item rectangle, not offset by a canvas position)', async ({ page }) => {
    const r = await render(page, fillCode(32, 24), { itemSize: { width: 32, height: 24 } }, []);
    for (const b of r.boxes) {
      expect(b.x).toBeGreaterThanOrEqual(-0.5); expect(b.y).toBeGreaterThanOrEqual(-0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(32.5); expect(b.y + b.height).toBeLessThanOrEqual(24.5);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (d) Render-time asset map (research §1.8.3: 07 and 15 keep the id in a constant). An id the code does not write as a
// string literal is not in the compile-time map (mg/frames.ts assetMap), so the sandbox refuses it by name; the host asks
// its resolver for that one id and runs again, and remembers it for the next render of the same code. Unknown ids still
// give the named error. The add check stays literal-only: tests/t08-messages.ts `assetIdRefusal` pins that a non-literal
// id is not refused there and a literal unknown one still is.
// ---------------------------------------------------------------------------------------------------------------------
const RED_SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>').toString('base64');
const CONSTANT = (id: string, tag: 'Img' | 'OffthreadVideo') =>
  `const ID = '${id}';\nexport const Graphic = () => <${tag} src={getAssetUrl(ID)} style={{width:64,height:64}}${tag === 'OffthreadVideo' ? ' muted={true} volume={0}' : ''} />;`;

test.describe('render-time asset map', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/src/mg/harness.html'); });

  test('a constant id renders an Img once the host resolves it, and is refused by name with no resolver', async ({ page }) => {
    const out = await page.evaluate(async ({ src, code }) => {
      const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
      const renderer = createMotionGraphicRenderer();
      const render = (frame: number, resolve?: (id: string) => Promise<string | undefined>) =>
        renderer.render({ code, frame, width: 64, height: 64, fps: 30, durationInFrames: 30, assetMap: {} }, resolve);
      const r = await render(0, async id => id === 'red' ? src : undefined);
      const image = new Image(); image.src = r.image; await image.decode();
      const c = document.createElement('canvas'); c.width = c.height = 64; const ctx = c.getContext('2d')!; ctx.drawImage(image, 0, 0);
      // No resolver: the refusal the sandbox raised, unchanged.
      const bare = await render(1).then(() => 'rendered', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);
      renderer.dispose();
      return { pixel: Array.from(ctx.getImageData(32, 32, 1, 1).data), bare };
    }, { src: RED_SVG, code: CONSTANT('red', 'Img') });
    expect(out.pixel).toEqual([255, 0, 0, 255]);
    expect(out.bare).toBe("VALIDATION_ERROR: getAssetUrl() takes a project asset's agentId. 'red' is not an asset attached to this project.");
  });

  test('a constant id renders an OffthreadVideo at the same source frames as a literal one', async ({ page }) => {
    test.skip(!ffmpegAvailable(), 'ffmpeg is required to generate the counter video');
    test.setTimeout(120_000);
    const video = 'data:video/mp4;base64,' + readFileSync(counterVideo()).toString('base64');
    const decoded = await page.evaluate(async ({ src, code, frames }) => {
      const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
      const renderer = createMotionGraphicRenderer();
      const out: (number | null)[] = [];
      for (const frame of frames) {
        // CF3-m1: one retry only on "Video frame load timeout.", as in the case loops above.
        const render = () => renderer.render({ code, frame, width: 64, height: 64, fps: 30, durationInFrames: 200, assetMap: {} }, async (id: string) => id === 'clip' ? src : undefined);
        const r = await render().catch((e: Error) => { if (e?.message !== 'Video frame load timeout.') throw e; return render(); });
        const image = new Image(); image.src = r.image; await image.decode();
        const c = document.createElement('canvas'); c.width = c.height = 64; const ctx = c.getContext('2d')!; ctx.drawImage(image, 0, 0);
        if (ctx.getImageData(32, 32, 1, 1).data[3] !== 255) { out.push(null); continue; }
        let n = 0;
        for (let k = 0; k < 8; k++) { const p = ctx.getImageData(4 + 8 * k, 32, 1, 1).data; if (p[3] === 255 && p[0] > 128) n |= 1 << k; }
        out.push(n);
      }
      renderer.dispose(); return out;
    }, { src: video, code: CONSTANT('clip', 'OffthreadVideo'), frames: [0, 7, 40] });
    expect(decoded).toEqual([0, 7, 40]);
  });

  test('a constant id the host cannot resolve still gives the named VALIDATION_ERROR', async ({ page }) => {
    const failures = await page.evaluate(async code => {
      const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
      const renderer = createMotionGraphicRenderer();
      const out: string[] = [];
      // A resolver that knows nothing, then one that answers a different id: neither resolves 'nope', so both rethrow.
      for (const resolve of [async () => undefined, async (id: string) => id === 'other' ? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' : undefined]) {
        out.push(await renderer.render({ code, frame: 0, width: 64, height: 64, fps: 30, durationInFrames: 30, assetMap: {} }, resolve as (id: string) => Promise<string | undefined>)
          .then(() => 'rendered', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`));
      }
      renderer.dispose(); return out;
    }, CONSTANT('nope', 'Img'));
    const expected = "VALIDATION_ERROR: getAssetUrl() takes a project asset's agentId. 'nope' is not an asset attached to this project.";
    expect(failures).toEqual([expected, expected]);
  });

  test('the second render of the same code costs one sandbox run, not two (the id is remembered)', async ({ page }) => {
    const runs = await page.evaluate(async ({ src, code }) => {
      const modulePath = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ modulePath);
      const renderer = createMotionGraphicRenderer();
      let sandboxes = 0;
      const observer = new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if ((n as Element).tagName === 'IFRAME') sandboxes++; });
      observer.observe(document.body, { childList: true });
      const resolve = async (id: string) => id === 'remembered' ? src : undefined;
      const count = async (frame: number) => {
        sandboxes = 0;
        await renderer.render({ code, frame, width: 64, height: 64, fps: 30, durationInFrames: 30, assetMap: {} }, resolve);
        await new Promise(r => setTimeout(r, 0)); // the observer's records are delivered as a microtask batch
        return sandboxes;
      };
      const first = await count(0), second = await count(1);
      observer.disconnect(); renderer.dispose(); return { first, second };
    }, { src: RED_SVG, code: CONSTANT('remembered', 'Img') });
    // First: refused once, then rendered. Second: the learned id is in the map before the run.
    expect(runs).toEqual({ first: 2, second: 1 });
  });
});
