// SPDX-License-Identifier: AGPL-3.0-only
// T12 scored rows through the real worker (pre-registered in the T12 notes): BG-P01, BG-P03, SM-P02, SM-P03. Needs the fixture store and a dev server with
// CUTFRAME_LOCAL_MODELS=1 at CUTFRAME_T12_URL. T12_WASM=1 starts Chromium with no GPU adapter (--disable-gpu), the path CI has. T12_RTX=1 adds the timing rows, headed
// on the discrete GPU (T15 notes l.179); T12_RTX=dry walks BG-P09's path on whatever adapter is there, with no gate, to show the test runs. Every row prints its numbers.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { clip, skipTour } from './t02-support';
import { CLIP2, bench, iou, item, pixels } from './t12-support';
import { STORE, hasStore, videoDoc } from './t15-support';
import { setup } from './t16a-support';

const SET = path.join(STORE, 'datasets/t12'), RADIUS = 0.0224719, FPS = 24, wasm = !!process.env.T12_WASM, rtx = process.env.T12_RTX === '1', dry = process.env.T12_RTX === 'dry';
test.skip(!hasStore || !process.env.CUTFRAME_T12_URL || !existsSync(SET), 'needs the fixture store with datasets/t12 and CUTFRAME_T12_URL (a dev server with CUTFRAME_LOCAL_MODELS=1)');
test.use({ baseURL: process.env.CUTFRAME_T12_URL, channel: 'chromium', headless: !rtx, launchOptions: { args: wasm ? ['--disable-gpu'] : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', ...(rtx ? ['--force_high_performance_gpu'] : [])] } });

const matte = (page: Page, name: string, frames: number) => page.evaluate(([name, frames]) => (window as any).t12.matteCheck(`/t12-media/${name}.mp4`, `/t12-media/${name}-alpha.bin.gz`, 24, frames, []), [name, frames] as const) as Promise<any>;
const plainRows = ({ rows, samples, ...rest }: any) => rest;
const label = (page: Page, frame: number) => pixels(page, readFileSync(path.join(SET, 'labels', `c2-f${frame}.png`)).toString('base64'));

test('BG-P01 five composites: mean IoU ≥ .90, min ≥ .80, boundary F ≥ .75, flicker ≤ 1.5 × truth', async ({ page }) => {
  test.setTimeout(wasm ? 7_200_000 : 1_800_000);
  await bench(page);
  const rows = [];
  for (const name of ['bg-p01-standing', 'bg-p01-arms', 'bg-p01-crouching', 'bg-p01-half', 'bg-p01-group']) {
    const r = await matte(page, name, 72);
    console.log(name, JSON.stringify(plainRows(r)));
    rows.push(r);
    expect(r.flickerRatio, name).toBeLessThanOrEqual(1.5);
  }
  const all = rows.flatMap(r => r.rows as number[][]), mean = (k: number) => all.reduce((s, row) => s + row[k], 0) / all.length;
  console.log('BG-P01', JSON.stringify({ frames: all.length, meanIou: mean(0), minIou: Math.min(...all.map(r => r[0])), boundaryF: mean(1) }));
  expect(mean(0)).toBeGreaterThanOrEqual(0.9);
  expect(Math.min(...all.map(r => r[0]))).toBeGreaterThanOrEqual(0.8);
  expect(mean(1)).toBeGreaterThanOrEqual(0.75);
});

test('BG-P03 the soldier behind the balusters: IoU ≥ .80', async ({ page }) => {
  test.setTimeout(wasm ? 1_800_000 : 600_000);
  await bench(page);
  const r = await matte(page, 'bg-p03-balusters', 47);
  console.log('BG-P03', JSON.stringify(plainRows(r)));
  expect(r.meanIou).toBeGreaterThanOrEqual(0.8);
});

test('SM-P02 preview on the head at 2.583 s: IoU ≥ .85, area within ±.05 of .312', async ({ page }) => {
  test.setTimeout(300_000);
  await bench(page);
  const { samples: [s] } = await page.evaluate(r => (window as any).t12.previewCheck('/t12-media/c2.mp4', [{ atS: 2.583, strokes: [{ label: 1, radius: r, points: [[.15, .2], [.2, .45], [.28, .65]] }] }]), RADIUS) as any;
  const score = iou(await pixels(page, s.png), await label(page, 62));
  console.log('SM-P02', JSON.stringify({ iou: score, area: s.area, ms: s.ms }));
  expect(score).toBeGreaterThanOrEqual(0.85);
  expect(Math.abs(s.area - 0.312)).toBeLessThanOrEqual(0.05);
});

test('SM-P03 one stroke tracked 0–30 s: mean IoU ≥ .85 at five annotated frames, absent frames ≤ 1 % area', async ({ page }) => {
  test.setTimeout(wasm ? 7_200_000 : 900_000);
  await bench(page);
  const present = [12, 36, 48, 648, 672], absent = [3, 5, 7, 9, 13, 19, 22, 29], times = [...present.map(f => (f + 0.5) / FPS), ...absent];
  const r = await page.evaluate(([times, radius]) => (window as any).t12.trackCheck('/t12-media/c2.mp4', 958000, 0, 30, 24, [{ label: 1, radius, points: [[.68, .12], [.64, .3], [.62, .5], [.62, .7], [.65, .9]] }], times), [times, RADIUS] as const) as any;
  const ious = [];
  for (let k = 0; k < present.length; k++) ious.push(iou(await pixels(page, r.samples[k].png), await label(page, present[k])));
  const areas = r.samples.slice(present.length).map((s: any) => s.area);
  console.log('SM-P03', JSON.stringify({ totalMs: r.totalMs, previewMs: r.previewMs, ious, areas }));
  expect(ious.reduce((a, b) => a + b, 0) / ious.length).toBeGreaterThanOrEqual(0.85);
  for (const a of areas) expect(a).toBeLessThanOrEqual(0.01);
});

// The rows are specified for the RTX 5070: anywhere else the run stops at the adapter, so another machine's figure cannot pass them.
test('BG-P09 on the reference machine: clip 2 attached ≤ 186 s after Apply (target 93 s)', async ({ page }) => {
  test.skip(!rtx && !dry, 'T12_RTX=1 once the RTX 5070 is out of Code 43 (T12 notes, open question 1)');
  test.setTimeout(3_600_000);
  await skipTour(page);
  await setup(page, videoDoc([item('c', 0, 30000)]), { c: CLIP2 }, 'T12 BG-P09');
  const adapter = await page.evaluate(async () => ((await (navigator as any).gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info?.vendor ?? 'none') as string);
  if (rtx) expect(adapter).toMatch(/nvidia/i);
  await clip(page, 'c').click();
  const apply = page.getByRole('button', { name: 'Apply' }).first(), t0 = Date.now();
  await apply.click();
  await expect(page.getByText('Tracked 0.00–30.00s in original video')).toBeAttached({ timeout: 3_500_000 }); // the row's clock stops at the attached layer, so the raster's write is in it
  const attachedMs = Date.now() - t0;
  console.log('BG-P09', JSON.stringify({ attachedMs, adapter, dry }));
  if (rtx) expect(attachedMs).toBeLessThanOrEqual(186_000);
});

test('SM-P05 on the reference machine: a 30 s track ≤ 60 s, a warm preview ≤ 2 s', async ({ page }) => {
  test.skip(!rtx, 'T12_RTX=1 once the RTX 5070 is out of Code 43 (T12 notes, open question 1)');
  test.setTimeout(1_200_000);
  await bench(page);
  expect((await page.evaluate(() => (window as any).t12.adapter())).vendor).toMatch(/nvidia/i);
  const stroke = { label: 1, radius: RADIUS, points: [[.15, .2], [.2, .45], [.28, .65]] };
  const track = await page.evaluate(s => (window as any).t12.trackCheck('/t12-media/c2.mp4', 2583000, 0, 30, 24, [s], []), stroke) as any;
  const { samples } = await page.evaluate(s => (window as any).t12.previewCheck('/t12-media/c2.mp4', [{ atS: 2.583, strokes: [s] }, { atS: 2.583, strokes: [s] }]), stroke) as any;
  console.log('SM-P05', JSON.stringify({ trackMs: track.totalMs, previewMs: samples.map((s: any) => s.ms) }));
  expect(track.totalMs).toBeLessThanOrEqual(60_000);
  expect(samples[1].ms).toBeLessThanOrEqual(2_000);
});
