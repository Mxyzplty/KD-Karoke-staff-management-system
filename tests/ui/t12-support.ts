// SPDX-License-Identifier: AGPL-3.0-only
// T12 export scoring shared by tests/ui/t12-real.spec.ts and tests/ui/t12-reference.spec.ts: the BG-P05 layout (clip 2 across a 1080 × 1920 project), an export's raw frames,
// the raster's planes and the row's numbers. The matte's mapping is §54.6 5.3's written out again here, on purpose, not the app's resampler (ruling on BG-P05, T12 notes).
import type { Page } from '@playwright/test';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { STORE } from './t15-support';
import { ff } from './t16a-support';

export const CLIP2 = path.join(STORE, 'corpus/tos-action-30s.mp4');
export const W = 1080, H = 1920, CLIP_H = Math.round(W * 534 / 1280), CLIP_Y = Math.round((H - CLIP_H) / 2), SRC_W = 1280, SRC_H = 534;
const SET = path.join(STORE, 'datasets/t12');
export const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
/** Clip 2 from `fromMs` to `toMs` of its source as one item on a 1080 × 1920 project, as wide as the project. */
export const item = (id: string, fromMs: number, toMs: number, at = 0, sourceDuration = 30000) => ({ id, from: at, to: at + toMs - fromMs, trim: fromMs, sourceDuration, properties: { width: prop(W), height: prop(CLIP_H), positionY: prop(CLIP_Y) } });
export const stored = (page: Page, id: string) => page.evaluate(async id => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.read(id)).document; }, id);
export const setLayers = (page: Page, id: string, patch: Record<string, unknown>) => page.evaluate(async ({ id, patch }) => {
  const p = '/src/store/database.ts', { projectStore } = await import(p), { document } = await projectStore.read(id) as any;
  for (const m of document.items[0].masks) Object.assign(m, patch);
  await projectStore.save(id, document, document.rev);
}, { id, patch });

/** The check page, with the store's files under /t12-media/ (a name with '-' or '.' relative to datasets/t12/composites, clip 2 as c2.mp4). */
export async function bench(page: Page) {
  await page.route('**/t12-media/**', r => {
    const name = r.request().url().split('/').pop()!;
    return r.fulfill({ body: readFileSync(name === 'c2.mp4' ? CLIP2 : path.join(SET, 'composites', name)), contentType: 'application/octet-stream' });
  });
  await page.route('**/@vite/client', r => r.fulfill({ contentType: 'text/javascript', body: 'export const createHotContext = () => ({ accept() {}, dispose() {}, on() {}, off() {}, send() {}, prune() {}, invalidate() {}, data: {} }); export const injectQuery = u => u; export const updateStyle = () => {}; export const removeStyle = () => {};' }));
  await page.goto('/src/masks/tools/check.html');
  await page.waitForFunction(() => (window as any).t12, null, { timeout: 60_000 });
}
/** A PNG's first channel as 0–255. */
export const gray = (page: Page, base64: string) => page.evaluate(async base64 => {
  const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
  const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const g = c.getContext('2d')!; g.drawImage(image, 0, 0);
  return Array.from(g.getImageData(0, 0, c.width, c.height).data.filter((_, i) => i % 4 === 0));
}, base64);
export const pixels = async (page: Page, base64: string) => (await gray(page, base64)).map(v => v > 127 ? 1 : 0);
export const iou = (a: number[], b: number[]) => { let both = 0, either = 0; a.forEach((v, i) => { if (v && b[i]) both++; if (v || b[i]) either++; }); return both / either; };

/** An export as raw RGBA frames in a file, read one at a time: three 150-frame exports of 1080 × 1920 are 3.7 GB. */
export function rawFrames(file: string, out: string) {
  ff('ffmpeg', ['-v', 'error', '-y', '-i', file, '-an', '-vf', 'format=rgba', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', out]);
  const fd = openSync(out, 'r'), size = W * H * 4;
  return { count: statSync(out).size / size, at: (k: number) => { const b = Buffer.allocUnsafe(size); readSync(fd, b, 0, size, k * size); return b; }, close: () => closeSync(fd) };
}
export const planes = (page: Page, ref: unknown, times: number[]) => page.evaluate(async ({ ref, times }) => {
  const p = '/src/masks/raster.ts', { readyRaster, rasterPlane } = await import(p), out: string[] = [];
  for (const t of times) {
    await readyRaster(ref, t);
    const plane = rasterPlane(ref, t) as Uint8Array;
    let bin = '';
    for (let i = 0; i < plane.length; i += 0x8000) bin += String.fromCharCode(...plane.subarray(i, i + 0x8000));
    out.push(btoa(bin));
  }
  return out;
}, { ref, times });
/** §54.6 5.3's mapping of the clip's rectangle into the plane: cover-fit of the source, each pixel centre back into source px, minus .5. */
const fit = Math.max(W / SRC_W, CLIP_H / SRC_H), offX = (W - SRC_W * fit) / 2, offY = (CLIP_H - SRC_H * fit) / 2;
const sourceAt = (x: number, y: number) => [(x + 0.5 - offX) / fit - 0.5, (y + 0.5 - offY) / fit - 0.5];
/** The matte at a pixel of the clip's rectangle, 0–255: bilinear, 0 outside the plane. */
export function matteAt(plane: Buffer) {
  const at = (u: number, v: number) => u < 0 || v < 0 || u >= SRC_W || v >= SRC_H ? 0 : plane[v * SRC_W + u];
  return (x: number, y: number) => {
    const [fx, fy] = sourceAt(x, y), x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  };
}
/** Whether a pixel of the clip's rectangle is within `by` source px of a kept pixel. */
export function nearMatte(plane: Buffer, by: number) {
  const near = new Uint8Array(SRC_W * SRC_H);
  for (let y = 0; y < SRC_H; y++) for (let x = 0; x < SRC_W; x++) {
    if (!plane[y * SRC_W + x]) continue;
    for (let dy = -by; dy <= by; dy++) for (let dx = -by; dx <= by; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && u < SRC_W && v >= 0 && v < SRC_H) near[v * SRC_W + u] = 1; }
  }
  return (x: number, y: number) => { const [fx, fy] = sourceAt(x, y), u = Math.round(fx), v = Math.round(fy); return u >= 0 && v >= 0 && u < SRC_W && v < SRC_H && !!near[v * SRC_W + u]; };
}
/** Behind the matte on one exported frame: every pixel where the matte is 0. The mean is on the clip's rectangle, the max on the whole canvas. No band is left out: the max further than 4 source px from
 *  the matte sits beside the row's number, not in place of it. `edgeShare` is the rectangle's pixels with a matte strictly between 0 and 255: those are not behind it, and they are the row's intermediate class. */
export function behindNumbers(plane: Buffer, m: Buffer) {
  const matte = matteAt(plane), far = nearMatte(plane, 4);
  let sum = 0, count = 0, top = 0, top4 = 0, canvas = 0, edge = 0, luma = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 4 * (y * W + x), v = Math.max(m[i], m[i + 1], m[i + 2]), c = y - CLIP_Y;
    const light = 0.2126 * m[i] + 0.7152 * m[i + 1] + 0.0722 * m[i + 2]; // BT.709 luma in 0–255 units (D38).
    if (c < 0 || c >= CLIP_H) { canvas = Math.max(canvas, v); luma = Math.max(luma, light); continue; }
    const a = matte(x, c);
    if (a > 0) { if (a < 255) edge++; continue; }
    count++; sum += m[i] + m[i + 1] + m[i + 2]; top = Math.max(top, v); luma = Math.max(luma, light);
    if (!far(x, c)) top4 = Math.max(top4, v);
  }
  return { behindMean: count ? sum / count / 3 : 0, behindMax: Math.max(top, canvas), behindLumaMax: luma, behindClipMax: top, behindMax4px: top4, canvasMax: canvas, edgeShare: edge / (W * CLIP_H) };
}
/** Complement and intermediate alpha of a matte export against its plain export, as a share of the clip's rectangle. A pixel darker than 48 in the source cannot show its alpha, so `judged` says how much of the rectangle was. */
export function clipNumbers(m: Buffer, v: Buffer, p: Buffer) {
  const rect = W * CLIP_H;
  let sum = 0, bright = 0, between = 0;
  for (let y = 0; y < CLIP_H; y++) for (let x = 0; x < W; x++) {
    const i = 4 * ((y + CLIP_Y) * W + x), base = (p[i] + p[i + 1] + p[i + 2]) / 3, here = (m[i] + m[i + 1] + m[i + 2]) / 3;
    for (let c = 0; c < 3; c++) sum += Math.abs(m[i + c] + v[i + c] - p[i + c]);
    if (base >= 48) { bright++; const r = here / base; if (r > 0.15 && r < 0.85) between++; }
  }
  return { complement: sum / (3 * rect), intermediate: between / rect, judged: bright / rect };
}
/** Every row's value to 4 places, and the worst of each number over the frames. */
export const rounded = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +v.toFixed(4)]));
export const worst = <T extends Record<string, number>>(rows: T[], key: keyof T) => Math.max(...rows.map(r => r[key]));
