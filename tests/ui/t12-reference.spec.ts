// SPDX-License-Identifier: AGPL-3.0-only
// T12 rows awaiting reference (T12 notes, Reference-compare recipe): BG-P02, W3-RF-06 of SM-P03, the Xapp part of BG-P05. The clean-room research agent runs this with its converted
// inputs in the environment; this lane never opens them. Each row skips until its variable is set. Needs the fixture store and a dev server with CUTFRAME_LOCAL_MODELS=1 at CUTFRAME_T12_URL.
import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clip, skipTour } from './t02-support';
import { CLIP2, CLIP_H, CLIP_Y, W, bench, clipNumbers, gray, iou, item, pixels, rawFrames, rounded, setLayers, stored } from './t12-support';
import { hasStore, videoDoc } from './t15-support';
import { completed, runExport, setup } from './t16a-support';

const MATTES = process.env.CUTFRAME_T12_BG_MATTES, RF06 = process.env.CUTFRAME_T12_W3_RF_06, RF07 = process.env.CUTFRAME_T12_W3_RF_07;
const BG_P02 = [2, 2.5, 3.5, 4.5, 5.5, 6.5, 7, 27], RF06_TIMES = [2, 7, 13, 19, 27], RADIUS = 0.02247;
const png = (file: string) => readFileSync(file).toString('base64');
test.skip(!hasStore || !process.env.CUTFRAME_T12_URL, 'needs the fixture store and CUTFRAME_T12_URL (a dev server with CUTFRAME_LOCAL_MODELS=1)');
test.use({ baseURL: process.env.CUTFRAME_T12_URL, channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] } });

test('BG-P02 removal of clip 2 against the reference mattes: IoU ≥ .85 at 2, 7, 27 s and at 2.5–6.5 s', async ({ page }) => {
  test.skip(!MATTES, 'CUTFRAME_T12_BG_MATTES: PNG mattes, clip2-<timeUs>.png (T12 notes)');
  test.setTimeout(3_600_000);
  const files = BG_P02.map(t => path.join(MATTES!, `clip2-${t * 1e6}.png`));
  for (const f of files) expect(existsSync(f), f).toBe(true);
  await bench(page);
  const { samples } = await page.evaluate(times => (window as any).t12.autoCheck('/t12-media/c2.mp4', 0, 30, 24, times), BG_P02) as any;
  const rows = [];
  for (let k = 0; k < files.length; k++) rows.push({ atS: BG_P02[k], iou: +iou(await pixels(page, samples[k].png), await pixels(page, png(files[k]))).toFixed(4) });
  console.log('BG-P02', JSON.stringify(rows));
  for (const r of rows) expect.soft(r.iou, `${r.atS} s`).toBeGreaterThanOrEqual(0.85);
});

test('SM-P03 W3-RF-06, the reference stroke tracked 0–30 s: IoU ≥ .80 at 2 and 27 s, area ≤ 1 % at 7, 13 and 19 s, intermediate alpha ≤ .5 %', async ({ page }) => {
  test.skip(!RF06, 'CUTFRAME_T12_W3_RF_06: stroke.json with { points }, 2s.png, 27s.png (T12 notes)');
  test.setTimeout(3_600_000);
  const { points } = JSON.parse(readFileSync(path.join(RF06!, 'stroke.json'), 'utf8'));
  await bench(page);
  const { samples } = await page.evaluate(([times, radius, points]) => (window as any).t12.trackCheck('/t12-media/c2.mp4', 958000, 0, 30, 24, [{ label: 1, radius, points }], times), [RF06_TIMES, RADIUS, points] as const) as any;
  const at = (s: number) => samples[RF06_TIMES.indexOf(s)], score = async (s: number) => +iou(await pixels(page, at(s).png), await pixels(page, png(path.join(RF06!, `${s}s.png`)))).toFixed(4);
  const planes = await Promise.all(samples.map((s: any) => gray(page, s.png))), intermediate = Math.max(...planes.map(p => p.filter((v: number) => v > 0 && v < 255).length / p.length));
  const row = { iou2s: await score(2), iou27s: await score(27), area7s: at(7).area, area13s: at(13).area, area19s: at(19).area, intermediate };
  console.log('W3-RF-06', JSON.stringify(row));
  expect.soft(row.iou2s, 'at 2 s').toBeGreaterThanOrEqual(0.8);
  expect.soft(row.iou27s, 'at 27 s').toBeGreaterThanOrEqual(0.8);
  for (const s of [7, 13, 19]) expect.soft(at(s).area, `area at ${s} s`).toBeLessThanOrEqual(0.01);
  expect.soft(intermediate, 'intermediate alpha').toBeLessThanOrEqual(0.005);
});

// The row's gates are BG-P05's own (tests/ui/t12-real.spec.ts). This reads the reference exports with the same code and compares kept pixels frame by frame: printed, no gate.
test('BG-P05 W3-RF-07, the same numbers on the reference exports and kept pixels against ours, 150 frames', async ({ page }) => {
  test.skip(!RF07, 'CUTFRAME_T12_W3_RF_07: on.mp4 and inverted.mp4, 150 frames of 1080 × 1920 (T12 notes)');
  test.setTimeout(1_800_000);
  await skipTour(page);
  const { id } = await setup(page, videoDoc([item('c', 2000, 7000)]), { c: CLIP2 }, 'T12 reference export');
  await clip(page, 'c').click();
  await page.getByRole('button', { name: 'Apply' }).first().click();
  await expect.poll(async () => (await stored(page, id) as any).items[0].masks?.length ?? 0, { timeout: 1_500_000 }).toBe(1);
  const dir = mkdtempSync(path.join(tmpdir(), 't12-rf07-')), open: { close(): void }[] = [], rows: Record<string, number>[] = [];
  const raw = (file: string, name: string) => { const r = rawFrames(file, path.join(dir, name)); open.push(r); expect(r.count, file).toBe(150); return r; };
  const ours = async (name: string) => { const r = await runExport(page, id); completed(r); return raw(r.file!, name); };
  try {
    const matte = await ours('matte');
    await setLayers(page, id, { inverted: true });
    const inverse = await ours('inverse');
    await setLayers(page, id, { enabled: false });
    const plain = await ours('plain'), on = raw(path.join(RF07!, 'on.mp4'), 'on'), inverted = raw(path.join(RF07!, 'inverted.mp4'), 'inverted');
    for (let k = 0; k < 150; k++) {
      const m = matte.at(k), p = plain.at(k), r = on.at(k), a = clipNumbers(m, inverse.at(k), p), b = clipNumbers(r, inverted.at(k), p);
      let both = 0, either = 0;
      for (let y = 0; y < CLIP_H; y++) for (let x = 0; x < W; x++) {
        const i = 4 * ((y + CLIP_Y) * W + x), base = p[i] + p[i + 1] + p[i + 2];
        if (base < 144) continue; // a dark source pixel shows neither matte
        const mine = 2 * (m[i] + m[i + 1] + m[i + 2]) > base, theirs = 2 * (r[i] + r[i + 1] + r[i + 2]) > base;
        if (mine && theirs) both++; if (mine || theirs) either++;
      }
      rows.push({ complement: a.complement, intermediate: a.intermediate, refComplement: b.complement, refIntermediate: b.intermediate, iou: either ? both / either : 1 });
    }
  } finally { for (const r of open) r.close(); rmSync(dir, { recursive: true, force: true }); }
  const range = (key: string) => [Math.min(...rows.map(r => r[key])), Math.max(...rows.map(r => r[key]))].map(v => +v.toFixed(4));
  console.log('W3-RF-07 frames', JSON.stringify(rows.map(rounded)));
  console.log('W3-RF-07', JSON.stringify(Object.fromEntries(Object.keys(rows[0]).map(k => [k, range(k)]))));
});
