// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the T29 spec: oracle transforms and scores (ffmpeg + PSNR / SSIM), the real upload and placement at scale 1,
// and the three readbacks (paused preview canvas, captureFrame, the exported file). No product helper decides a pass.
import { expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Asset, RecordData } from '../../apps/web/src/store/model';
import { FILTER, run } from './t14-orientation-support';
import { ssim } from './t10a-support';
import { DURATION_MS, previewCanvas, type Size } from './t25-svg-support';

export type Rgb = { width: number; height: number; rgb: Buffer };
export type Rect = { x: number; y: number; w: number; h: number };
export const PROJECT: Size = { width: 192, height: 192 };
/** Top-left of every placed item, in project px. */
export const ORIGIN = { x: 32, y: 32 };
/** captureFrame quality 'high' (CAPTURE_SCALE.high in render/capture.ts): the capture is round(project × 0.75). */
export const CAPTURE_K = 0.75;
export const GREY_RGB = [55, 65, 81] as const; // #374151

// ---- oracle transforms ---------------------------------------------------------------------------------------------
/** One ffmpeg filter chain over a raw RGB24 picture. */
function ffRaw(img: Rgb, vf: string, width: number, height: number): Rgb {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${img.width}x${img.height}`, '-i', '-', '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { input: img.rgb, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw Error(String(r.stderr));
  const rgb = r.stdout as Buffer;
  if (rgb.length !== width * height * 3) throw Error(`ffmpeg ${vf}: ${rgb.length} bytes, expected ${width}×${height}`);
  return { width, height, rgb };
}
/** The picture as TIFF/EXIF Orientation `o` displays it (the T14 round-3 filter chains). */
export const orient = (img: Rgb, o: number): Rgb => ffRaw(img, FILTER[o], o >= 5 ? img.height : img.width, o >= 5 ? img.width : img.height);
/** All eight orientations of an untagged picture, index 1..8 (index 0 unused). */
export const orientations = (base: Rgb): Rgb[] => [base, ...[1, 2, 3, 4, 5, 6, 7, 8].map(o => orient(base, o))];
export const resize = (img: Rgb, width: number, height: number): Rgb => ffRaw(img, `scale=${width}:${height}:flags=bilinear`, width, height);
export function mapBytes(img: Rgb, table: (code: number) => number): Rgb {
  const rgb = Buffer.alloc(img.rgb.length);
  for (let i = 0; i < rgb.length; i++) rgb[i] = table(img.rgb[i]);
  return { ...img, rgb };
}

// ---- scores --------------------------------------------------------------------------------------------------------
export const psnrRgb = (a: Buffer, b: Buffer) => { let se = 0; for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2; return 10 * Math.log10(255 * 255 / (se / a.length || 1e-9)); };
const rgbaOf = (rgb: Buffer) => { const out = new Uint8Array(rgb.length / 3 * 4).fill(255); for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { out[j] = rgb[i]; out[j + 1] = rgb[i + 1]; out[j + 2] = rgb[i + 2]; } return out; };
export const ssimRgb = (a: Buffer, b: Buffer, width: number, height: number) => ssim(rgbaOf(a), rgbaOf(b), width, height);
export type Score = { orientation: number; psnr: number; ssim: number };
export type Measured = { size: Size; right: Score; wrong: Score[]; otherSize: { orientation: number; width: number; height: number }[] };
/** Scores the crop against the right oracle and every wrong orientation of the same size; other sizes are listed, not scored.
 *  `prep` carries an oracle at the displayed size into the path's own domain (identity, resize, output transfer). */
export function measure(variants: readonly Rgb[], rightOrientation: number, crop: Rgb, prep: (img: Rgb) => Rgb): Measured {
  const shown = variants[rightOrientation], out: Measured = { size: { width: crop.width, height: crop.height }, right: undefined as unknown as Score, wrong: [], otherSize: [] };
  for (let o = 1; o <= 8; o++) {
    const v = variants[o];
    if (v.width !== shown.width || v.height !== shown.height) { out.otherSize.push({ orientation: o, width: v.width, height: v.height }); continue; }
    const p = prep(v);
    if (p.width !== crop.width || p.height !== crop.height) throw Error(`oracle ${p.width}×${p.height} versus crop ${crop.width}×${crop.height}`);
    const s = { orientation: o, psnr: psnrRgb(crop.rgb, p.rgb), ssim: ssimRgb(crop.rgb, p.rgb, crop.width, crop.height) };
    if (o === rightOrientation) out.right = s; else out.wrong.push(s);
  }
  return out;
}
export const summary = (m: Measured) => `${m.size.width}×${m.size.height} right o${m.right.orientation} PSNR ${m.right.psnr.toFixed(2)} dB SSIM ${m.right.ssim.toFixed(4)}; wrong ${m.wrong.map(w => `o${w.orientation} ${w.psnr.toFixed(2)} dB / ${w.ssim.toFixed(4)}`).join(', ')}; other sizes ${m.otherSize.map(w => `o${w.orientation} ${w.width}×${w.height}`).join(', ')}`;

// ---- crops ---------------------------------------------------------------------------------------------------------
/** The box out of a full frame of `bytes` per pixel (3 = RGB, 4 = RGBA), as RGB. */
export function crop(frame: Uint8Array, bytes: 3 | 4, frameWidth: number, box: Rect): Rgb {
  const rgb = Buffer.alloc(box.w * box.h * 3);
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    const from = ((box.y + y) * frameWidth + box.x + x) * bytes, to = (y * box.w + x) * 3;
    rgb[to] = frame[from]; rgb[to + 1] = frame[from + 1]; rgb[to + 2] = frame[from + 2];
  }
  return { width: box.w, height: box.h, rgb };
}
/** Share of pixels within `tolerance` of the given colour on every channel. */
export function share(img: Rgb, colour: readonly number[], tolerance: number): number {
  let n = 0;
  for (let i = 0; i < img.rgb.length; i += 3) if (colour.every((c, k) => Math.abs(img.rgb[i + k] - c) <= tolerance)) n++;
  return n / (img.rgb.length / 3);
}
export const inset = (box: Rect, by: number): Rect => ({ x: box.x + by, y: box.y + by, w: box.w - 2 * by, h: box.h - 2 * by });
/** The capture's box: the item's box at CAPTURE_K, which must land on whole pixels. */
export function captureBox(box: Rect): Rect {
  const r = { x: box.x * CAPTURE_K, y: box.y * CAPTURE_K, w: box.w * CAPTURE_K, h: box.h * CAPTURE_K };
  for (const v of Object.values(r)) expect(Number.isInteger(v), `captured box ${JSON.stringify(r)} has integer bounds`).toBe(true);
  return r;
}
export const captureSize = (): Size => ({ width: Math.round(PROJECT.width * CAPTURE_K), height: Math.round(PROJECT.height * CAPTURE_K) });

// ---- real upload and placement -------------------------------------------------------------------------------------
/** The actual Footage input drives add → uploadToProject → probe / preparation; returns the asset row once ready or failed. */
export async function uploadImage(page: Page, projectId: string, name: string, mimeType: string, buffer: Buffer): Promise<Asset> {
  await page.getByLabel('Upload footage to this project', { exact: true }).setInputFiles({ name, mimeType, buffer });
  await expect.poll(() => page.evaluate(async name => {
    const p = '/src/store/database.ts', { projectStore } = await import(p);
    return (await projectStore.library()).assets.find((asset: Asset) => asset.originalName === name)?.processing_status;
  }, name), { timeout: 120_000 }).toMatch(/^(ready|failed)$/);
  await expect.poll(() => page.evaluate(async ({ name, projectId }) => {
    const p = '/src/store/database.ts', { projectStore } = await import(p), asset = (await projectStore.library()).assets.find((a: Asset) => a.originalName === name);
    return !!asset && (await projectStore.projectAssets(projectId)).some((link: { assetId: string }) => link.assetId === asset.id);
  }, { name, projectId }), { timeout: 15_000 }).toBe(true);
  return page.evaluate(async name => {
    const p = '/src/store/database.ts', { projectStore } = await import(p);
    return (await projectStore.library()).assets.find((asset: Asset) => asset.originalName === name) as Asset;
  }, name);
}
/** Reload (indexes the prepared asset), addMedia through the command bus, then transformItem to scale 1 at ORIGIN. */
export async function placeImage(page: Page, asset: Asset): Promise<{ itemId: string; box: { x: number; y: number; W: number; H: number; sx: number; sy: number } }> {
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect.poll(() => page.evaluate(async id => {
    const p = '/src/timeline/runtime.ts', { activeRuntime } = await import(p); return activeRuntime?.assets.get(id)?.processing_status;
  }, asset.id)).toBe(asset.processing_status);
  const placed = await page.evaluate(async ({ assetId, duration, origin }) => {
    const r = '/src/timeline/runtime.ts', e = '/src/editor.tsx', m = '/src/render/model.ts';
    const { activeRuntime } = await import(r), { activeSession } = await import(e), { itemBox } = await import(m);
    const added = activeRuntime.call('addMedia', { assetId, trackId: 'v1', timelineStart: 0, duration: duration / 1000 });
    await activeSession.flush();
    const item = activeSession.document.items.find((i: RecordData) => i.metadata?.assetId === assetId);
    const moved = item ? activeRuntime.call('transformItem', { itemId: item.id, scale: 1, x: origin.x, y: origin.y }) : null;
    await activeSession.flush();
    const live = activeSession.document.items.find((i: RecordData) => i.metadata?.assetId === assetId);
    return { added, moved, state: activeSession.state, itemId: live?.id, type: live?.type, box: live ? itemBox(activeSession.document, live, 0) : null };
  }, { assetId: asset.id, duration: DURATION_MS, origin: ORIGIN });
  expect(placed.added.success, JSON.stringify(placed.added)).toBe(true);
  expect(placed.moved?.success, JSON.stringify(placed.moved)).toBe(true);
  expect(placed.state).toBe('saved'); expect(placed.type).toBe('image');
  return { itemId: placed.itemId, box: placed.box };
}

// ---- readbacks -----------------------------------------------------------------------------------------------------
export type ImageState = 'failed' | 'unset' | { width: number; height: number };
export type PreviewRead = { canvas: Size; exact: string | undefined; frame: string | undefined; rgba: Buffer; image: ImageState };
/** The paused preview canvas composited over black, without screenshots or resampling, plus the source cache's entry. */
export const previewRead = async (page: Page, assetId: string): Promise<PreviewRead> => {
  const r = await page.evaluate(async assetId => {
    const s = '/src/render/sources.ts', { readyImage } = await import(s);
    const source = document.querySelector<HTMLCanvasElement>('canvas.run[data-run="0"]')!, canvas = new OffscreenCanvas(source.width, source.height), ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let binary = '';
    for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const b = readyImage({ metadata: { assetId } });
    return { canvas: { width: canvas.width, height: canvas.height }, exact: source.dataset.exact, frame: source.dataset.frame, b64: btoa(binary),
      image: typeof b === 'string' ? b : b ? { width: b.width, height: b.height } : 'unset' };
  }, assetId);
  return { canvas: r.canvas, exact: r.exact, frame: r.frame, rgba: Buffer.from(r.b64, 'base64'), image: r.image as ImageState };
};
/** Everything outside the box is black: the preview shows the item at its placed position, not the earlier addMedia fit. */
export function outsideBlack(read: PreviewRead, box: Rect): boolean {
  for (let y = 0; y < read.canvas.height; y++) for (let x = 0; x < read.canvas.width; x++) {
    if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue;
    const i = (y * read.canvas.width + x) * 4; if (read.rgba[i] || read.rgba[i + 1] || read.rgba[i + 2]) return false;
  }
  return true;
}
/** Polls the paused preview until it is at the requested exactness, project-sized, at frame 0 and the item sits in its box. */
export async function settledPreview(page: Page, assetId: string, box: Rect, exact: 'true' | 'false'): Promise<PreviewRead> {
  await expect(previewCanvas(page)).toHaveAttribute('data-frame', '0', { timeout: 60_000 });
  let last!: PreviewRead;
  await expect.poll(async () => {
    last = await previewRead(page, assetId);
    return last.exact === exact && last.frame === '0' && last.canvas.width === PROJECT.width && last.canvas.height === PROJECT.height && outsideBlack(last, box);
  }, { timeout: 90_000, message: `paused preview data-exact=${exact}, project-sized, item in its box` }).toBe(true);
  return last;
}

/** captureFrame (high), after clearSources so the capture itself decodes. The JPEG is decoded by ffmpeg, as T14's posters are. */
export async function captureRead(page: Page, assetId: string, file: string) {
  const r = await page.evaluate(async assetId => {
    const c = '/src/render/capture.ts', s = '/src/store/database.ts', e = '/src/editor.tsx', q = '/src/render/sources.ts';
    const { captureFrame } = await import(c), { projectStore } = await import(s), { activeSession } = await import(e), { clearSources, readyImage } = await import(q);
    clearSources();
    const assets: Asset[] = (await projectStore.library()).assets, doc = activeSession.document;
    const result = await captureFrame({ store: projectStore, doc, asset: (id: string) => assets.find(asset => asset.id === id), playheadMs: 0 }, { timestamps: [0], quality: 'high' });
    const images = (result.content ?? []).filter((block: { type: string }) => block.type === 'image'), b = readyImage({ metadata: { assetId } });
    return { success: result.success as boolean, result: result.success ? null : result, imageCount: images.length, mimeType: images[0]?.mimeType as string | undefined, base64: images[0]?.base64 as string | undefined,
      meta: result.success ? JSON.parse(result.content[0].text) : null, image: (typeof b === 'string' ? b : b ? { width: b.width, height: b.height } : 'unset') as ImageState };
  }, assetId);
  expect(r.success, JSON.stringify(r.result)).toBe(true); expect(r.imageCount).toBe(1); expect(r.mimeType).toBe('image/jpeg');
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(r.base64!, 'base64'));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const size = probe.stdout.trim().split(',').map(Number), frame = run(['-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  return { meta: r.meta, image: r.image, size: { width: size[0], height: size[1] } as Size, frame };
}

/** startExport at the original size, after clearSources so the export itself decodes. Returns the MP4 bytes and the cache's entry. */
export async function exportRead(page: Page, projectId: string, assetId: string, file: string) {
  const r = await page.evaluate(async ({ projectId, assetId }) => {
    const s = '/src/store/database.ts', e = '/src/export/index.ts', q = '/src/render/sources.ts';
    const { projectStore } = await import(s), ex = await import(e), { clearSources, readyImage } = await import(q), stored = await projectStore.read(projectId);
    if (!stored) throw new Error('The export project is missing.');
    clearSources();
    let renderId: string | undefined;
    try {
      renderId = ex.startExport({ store: projectStore, doc: stored.document, projectKey: projectId, title: 'T29 export', resolution: 'original', remux: false, bitrate: 12_000_000 });
      const state = await ex.awaitExport(renderId), b = readyImage({ metadata: { assetId } }), image = typeof b === 'string' ? b : b ? { width: b.width, height: b.height } : 'unset';
      if (state.status !== 'completed') return { status: state.status as string, error: state.error, image };
      const { blob, ...result } = state.result, bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { status: state.status as string, result, b64: btoa(binary), image };
    } finally { if (renderId) ex.releaseExport(renderId); }
  }, { projectId, assetId });
  expect(r.status, JSON.stringify((r as { error?: unknown }).error)).toBe('completed');
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from((r as { b64: string }).b64, 'base64'));
  return { result: (r as { result: { frames: number; size: Size } }).result, image: r.image as ImageState };
}

/** The only broken-timeline route (T25 AC4): prepare and place the good file, then overwrite that asset's stored bytes only. */
export async function breakPlacedImage(page: Page, assetId: string, truncated: Buffer) {
  await expect(previewCanvas(page)).toHaveAttribute('data-exact', 'true');
  const facts = await page.evaluate(async ({ assetId, b64 }) => {
    const s = '/src/store/database.ts', r = '/src/render/sources.ts', { projectStore } = await import(s), { clearSources, readyImage } = await import(r);
    const before = JSON.stringify(await projectStore.row('assets', assetId));
    await projectStore.media.write(assetId, new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))])); clearSources();
    const after = JSON.stringify(await projectStore.row('assets', assetId)), blob = await projectStore.media.read(assetId);
    return { sameRow: before === after, size: blob.size, cacheEmpty: readyImage({ metadata: { assetId } }) === undefined };
  }, { assetId, b64: truncated.toString('base64') });
  expect(facts).toEqual({ sameRow: true, size: truncated.length, cacheEmpty: true });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
}
