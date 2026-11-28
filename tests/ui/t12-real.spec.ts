// SPDX-License-Identifier: AGPL-3.0-only
// T12 rows with the real models, through the app (BG-P04..P08, the brush, the text job, mask export). Needs the fixture store and a dev server with
// CUTFRAME_LOCAL_MODELS=1 at CUTFRAME_T12_URL; on any other run it skips with its reason. Thresholds are the rows' (T12 notes).
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clip, skipTour } from './t02-support';
import { CLIP2, CLIP_H, CLIP_Y, H, W, behindNumbers, clipNumbers, item, planes, prop, rawFrames, rounded, setLayers, stored, worst } from './t12-support';
import { STORE, hasStore, videoDoc } from './t15-support';
import { completed, genMedia, runExport, setup } from './t16a-support';

const X3 = path.join(STORE, 'corpus/tos-action-90s-x3.mp4');
test.skip(!hasStore || !process.env.CUTFRAME_T12_URL, 'needs the fixture store and CUTFRAME_T12_URL (a dev server with CUTFRAME_LOCAL_MODELS=1)');
test.use({ baseURL: process.env.CUTFRAME_T12_URL, channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] } });
test.beforeEach(({ page }) => skipTour(page));

const masks = async (page: Page, id: string, at = 'c') => ((await stored(page, id) as any).items.find((i: any) => i.id === at).masks ?? []) as any[];
const jobs = (page: Page) => page.getByRole('region', { name: 'Background Jobs' });
async function openJobs(page: Page) { const b = jobs(page).getByRole('button', { name: /^Background Jobs/ }); if (await b.getAttribute('aria-expanded') === 'false') await b.click(); }


test('BG-P04, BG-P05 Remove Background on clip 2 at 2–7 s: one Add layer, black behind the matte, invert is the complement, all 150 frames', async ({ page }) => {
  test.setTimeout(1_800_000);
  const { id } = await setup(page, videoDoc([item('c', 2000, 7000)], { }), { c: CLIP2 }, 'T12 export');
  await clip(page, 'c').click();
  await page.getByRole('button', { name: 'Apply' }).first().click();
  await openJobs(page);
  await expect(jobs(page).getByRole('listitem').filter({ hasText: 'Remov' })).toHaveCount(1);
  await expect.poll(async () => (await masks(page, id)).length, { timeout: 1_500_000 }).toBe(1);
  const [layer] = await masks(page, id);
  expect({ name: layer.name, mode: layer.mode, feather: layer.feather, expansion: layer.expansion, opacity: layer.opacity, inverted: !!layer.inverted }).toEqual({ name: 'Background Removal', mode: 'add', feather: 0, expansion: 0, opacity: 100, inverted: false });
  expect(layer.raster.sourceEndUs - layer.raster.sourceStartUs).toBe(5_000_000);
  await expect(page.getByText('Tracked 2.00–7.00s in original video')).toBeAttached(); // in the Mask section, closed by default

  // D38, 7 Nov: max changed AFTER seeing the result, because Xapp also fails the former RGB max. Mean and the other gates stay unchanged.
  const dir = mkdtempSync(path.join(tmpdir(), 't12-bgp05-')), open: { close(): void }[] = [], rows: (ReturnType<typeof behindNumbers> & ReturnType<typeof clipNumbers> & { compositedMax: number })[] = [];
  await page.route('**/t12-composited/*', route => {
    const k = Number(route.request().url().split('/').pop());
    writeFileSync(path.join(dir, `${k}.rgba`), route.request().postDataBuffer()!);
    return route.fulfill({ status: 204 });
  });
  // Capture the real export readback before colour conversion/I420; only this export uses these dimensions.
  await page.evaluate(({ W, H }) => {
    const real = OffscreenCanvasRenderingContext2D.prototype.getImageData, sent: Promise<unknown>[] = (window as any).__t12Composited = [];
    (window as any).__t12RestoreReadback = () => { OffscreenCanvasRenderingContext2D.prototype.getImageData = real; };
    OffscreenCanvasRenderingContext2D.prototype.getImageData = function (this: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, settings?: ImageDataSettings) {
      const image = real.call(this, x, y, w, h, settings);
      if (w === W && h === H) sent.push(fetch(`/t12-composited/${sent.length}`, { method: 'POST', body: new Blob([image.data]) }));
      return image;
    };
  }, { W, H });
  const run = async (name: string) => {
    const r = await runExport(page, id); completed(r); expect(r.result!.frames).toBe(150);
    if (name === 'matte') expect(await page.evaluate(async () => {
      (window as any).__t12RestoreReadback();
      return (await Promise.all((window as any).__t12Composited)).length;
    }), 'composited readbacks').toBe(150);
    const raw = rawFrames(r.file!, path.join(dir, name)); open.push(raw); expect(raw.count).toBe(150); return raw;
  };
  try {
    const matte = await run('matte');
    await setLayers(page, id, { inverted: true });
    const inverse = await run('inverse');
    await setLayers(page, id, { enabled: false });
    const plain = await run('plain');
    for (let k = 0; k < 150; k++) {
      const [plane] = await planes(page, layer.raster, [2_000_000 + Math.round(k * 1e6 / 30)]), m = matte.at(k);
      const alpha = Buffer.from(plane, 'base64'), composited = readFileSync(path.join(dir, `${k}.rgba`));
      expect(composited.length, `composited frame ${k} size`).toBe(W * H * 4);
      rows.push({ ...behindNumbers(alpha, m), ...clipNumbers(m, inverse.at(k), plain.at(k)), compositedMax: behindNumbers(alpha, composited).behindMax });
    }
  } finally { for (const raw of open) raw.close(); rmSync(dir, { recursive: true, force: true }); }
  console.log('BG-P05 frames', JSON.stringify(rows.map(rounded)));
  console.log('BG-P05 worst', JSON.stringify(rounded({ frames: rows.length, behindMean: worst(rows, 'behindMean'), behindMax: worst(rows, 'behindMax'), behindLumaMax: worst(rows, 'behindLumaMax'), compositedMax: worst(rows, 'compositedMax'), behindClipMax: worst(rows, 'behindClipMax'), behindMax4px: worst(rows, 'behindMax4px'), canvasMax: worst(rows, 'canvasMax'), edgeShare: worst(rows, 'edgeShare'), complement: worst(rows, 'complement'), intermediate: worst(rows, 'intermediate'), judgedLeast: -worst(rows.map(r => ({ judged: -r.judged })), 'judged'), framesOver16: rows.filter(r => r.behindMax > 16).length, clipFramesOver16: rows.filter(r => r.behindClipMax > 16).length })));
  expect.soft(worst(rows, 'behindMean'), 'mean behind the matte').toBeLessThanOrEqual(1);
  expect.soft(worst(rows, 'behindLumaMax'), 'BT.709 luma max behind the matte (D38)').toBeLessThanOrEqual(16);
  expect.soft(worst(rows, 'compositedMax'), 'composited RGB behind the matte before encoding (D38)').toBe(0);
  expect.soft(worst(rows, 'complement'), 'normal + inverted against the source').toBeLessThanOrEqual(3);
  expect.soft(worst(rows, 'intermediate'), 'intermediate alpha, share of the clip rectangle').toBeLessThanOrEqual(0.005);
});

test('BG-P07 a second removal during the first: both listed with their own state, both attach', async ({ page }) => {
  test.setTimeout(1_200_000);
  const { id } = await setup(page, videoDoc([item('c', 2000, 3000), item('d', 7000, 8000, 1000)]), { c: CLIP2, d: CLIP2 }, 'T12 queue');
  await clip(page, 'c').click();
  await page.getByRole('button', { name: 'Apply' }).first().click();
  await clip(page, 'd').click();
  await page.getByRole('button', { name: 'Apply' }).first().click();
  await openJobs(page);
  const rows = jobs(page).getByRole('listitem');
  await expect(rows.filter({ hasText: 'Background Removal' })).toHaveCount(2);
  await expect(page.locator('section.jobs li[data-state="waiting"]')).toHaveCount(1);
  await expect(rows.locator('progress')).toHaveCount(1);
  const row = page.getByRole('status').filter({ hasText: /Waiting for a worker|Processing mask/ });
  await expect(row).toHaveText('Waiting for a worker');
  await expect(row).toHaveText(/Processing mask \d+ %/, { timeout: 600_000 });
  await expect.poll(async () => [(await masks(page, id)).length, (await masks(page, id, 'd')).length], { timeout: 1_000_000 }).toEqual([1, 1]);
});

test('BG-P08 no foreground: the typed failure with advice stays in Background Jobs, the row returns to Apply, nothing attached', async ({ page }) => {
  test.setTimeout(900_000);
  const flat = genMedia('t12-flat-noise.mp4', ['-f', 'lavfi', '-i', 'color=c=0x667788:s=640x360:r=24:d=2', '-vf', 'noise=alls=12:allf=t', '-pix_fmt', 'yuv420p']);
  const { id } = await setup(page, videoDoc([{ id: 'c', from: 0, to: 2000, sourceDuration: 2000 }]), { c: flat }, 'T12 nothing');
  await clip(page, 'c').click();
  await page.getByRole('button', { name: 'Apply' }).first().click();
  await openJobs(page);
  const row = jobs(page).locator('li[data-state="failed"]');
  await expect(row).toContainText('No reliable foreground was found. Pick a clearer frame or use a stroke-based Smart Mask.', { timeout: 800_000 });
  await expect(page.getByRole('button', { name: 'Apply' }).first()).toBeEnabled();
  expect(await masks(page, id)).toEqual([]);
  await row.getByRole('button', { name: 'Dismiss' }).click();
  await expect(jobs(page).locator('li[data-state="failed"]')).toHaveCount(0);
});

test('Smart mask on the stage: a stroke previews, Track attaches one Smart mask layer', async ({ page }) => {
  test.setTimeout(900_000);
  const { id } = await setup(page, videoDoc([item('c', 958, 2000)]), { c: CLIP2 }, 'T12 brush');
  await clip(page, 'c').click();
  await page.keyboard.press('m');
  await page.keyboard.press('a');
  const brush = page.getByRole('application', { name: 'Smart mask brush' }), box = (await brush.boundingBox())!;
  const at = ([x, y]: number[]) => [box.x + x * box.width, box.y + (CLIP_Y + y * CLIP_H) / H * box.height] as const;
  const line = [[.68, .12], [.64, .3], [.62, .5], [.62, .7], [.65, .9]];
  await page.mouse.move(...at(line[0]));
  await page.mouse.down();
  for (const p of line.slice(1)) await page.mouse.move(...at(p), { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('smart-preview')).toHaveCount(1, { timeout: 120_000 });
  await page.getByRole('button', { name: 'Track' }).click();
  await openJobs(page);
  await expect.poll(async () => (await masks(page, id)).length, { timeout: 600_000 }).toBe(1);
  const [layer] = await masks(page, id);
  expect({ mode: layer.mode, source: layer.source, order: layer.order }).toEqual({ mode: 'add', source: 'smart', order: 0 });
  await expect(page.getByRole('application', { name: 'Smart mask brush' })).toHaveCount(0);
});

test('Text prompt: a Background Jobs entry, the range clamped to 30 s, attached when done; cancelling attaches nothing', async ({ page }) => {
  test.setTimeout(900_000);
  const { id } = await setup(page, videoDoc([item('c', 4200, 8400)]), { c: CLIP2 }, 'T12 text');
  await clip(page, 'c').click();
  await page.keyboard.press('m');
  await page.keyboard.press('a');
  const find = async () => { await page.getByRole('textbox', { name: 'Describe the object' }).fill('the man'); await page.getByRole('button', { name: 'Find' }).click(); };
  await find();
  await openJobs(page);
  const row = jobs(page).getByRole('listitem').filter({ hasText: 'Smart mask' });
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(jobs(page).locator('li[data-state="cancelled"]')).toHaveCount(1, { timeout: 120_000 });
  expect(await masks(page, id)).toEqual([]);
  await page.keyboard.press('m');
  await page.keyboard.press('a');
  await find();
  await expect.poll(async () => (await masks(page, id)).length, { timeout: 700_000 }).toBe(1);
  const [layer] = await masks(page, id);
  expect(layer.raster.sourceEndUs - layer.raster.sourceStartUs).toBeLessThanOrEqual(30_000_000);
  expect(layer.source).toBe('smart');
});

test('BG-P06 the 90.02 s fixture: no refusal, one layer over the whole item, attached at the end of the job', async ({ page }) => {
  test.setTimeout(5_400_000);
  const { id } = await setup(page, videoDoc([{ id: 'c', from: 0, to: 90020, sourceDuration: 90020, properties: { width: prop(W), height: prop(CLIP_H), positionY: prop(CLIP_Y) } }]), { c: X3 }, 'T12 long', 300_000);
  await clip(page, 'c').click();
  await page.getByRole('button', { name: 'Apply' }).first().click();
  await expect.poll(async () => (await masks(page, id)).length, { timeout: 5_000_000, intervals: [5000] }).toBe(1);
  const [layer] = await masks(page, id);
  expect(layer.raster.sourceEndUs - layer.raster.sourceStartUs).toBe(90_020_000);
  expect(Math.abs(layer.raster.frameCount - 2160)).toBeLessThanOrEqual(1);
});
