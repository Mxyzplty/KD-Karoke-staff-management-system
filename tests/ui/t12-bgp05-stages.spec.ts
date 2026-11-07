// SPDX-License-Identifier: AGPL-3.0-only
// T12 BG-P05's max, stage by stage (review round 2, A1): one export's 150 frames scored with the row's own mapping and gate at three stages. `composited` is the RGBA the export reads back from its
// canvas, `i420` is that frame through the export's rgbaToI420 and back with no encoder, `encoded` is the file. A diagnostic, not a gate: it runs with T12_STAGES=1 in t12-real.spec.ts's environment.
import { expect, test } from '@playwright/test';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rgbaToI420 } from '../../apps/web/src/export/i420';
import { clip, skipTour } from './t02-support';
import { CLIP2, CLIP_H, CLIP_Y, H, W, behindNumbers, item, matteAt, nearMatte, planes, stored } from './t12-support';
import { hasStore, videoDoc } from './t15-support';
import { completed, ff, runExport, setup } from './t16a-support';

test.skip(!hasStore || !process.env.CUTFRAME_T12_URL || !process.env.T12_STAGES, 'a diagnostic: needs T12_STAGES=1, the fixture store and CUTFRAME_T12_URL');
test.use({ baseURL: process.env.CUTFRAME_T12_URL, channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] } });
test.beforeEach(({ page }) => skipTour(page));

const SIZE = W * H * 4, FRAMES = 150, GATE = 16;
const reader = (file: string) => { const fd = openSync(file, 'r'); return { count: statSync(file).size / SIZE, at: (k: number) => { const b = Buffer.allocUnsafe(SIZE); readSync(fd, b, 0, SIZE, k * SIZE); return b; }, close: () => closeSync(fd) }; };
/** I420 back to RGBA the way rawFrames reads an export: the control below shows the two agree byte for byte on the file's own planes. */
const backToRgba = (yuv: string, out: string) => { ff('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', '30', '-i', yuv, '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgba', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', out]); return reader(out); };
const fileRgba = (file: string, out: string) => { ff('ffmpeg', ['-v', 'error', '-y', '-i', file, '-an', '-vf', 'format=rgba', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', out]); return reader(out); };
const value = (m: Buffer, x: number, y: number) => { const i = 4 * (y * W + x); return Math.max(m[i], m[i + 1], m[i + 2]); };

const rgb = (m: Buffer, x: number, y: number) => { const i = 4 * (y * W + x); return [m[i], m[i + 1], m[i + 2]]; };
/** The pixels behind the matte over the gate: how many in the clip's rectangle, how many on the rest of the canvas, and how far the rectangle's are from a kept pixel, in source px. luma is the highest BT.709 luma behind the matte, beside the row's max of R, G and B. */
function overGate(plane: Buffer, m: Buffer, near: ((x: number, y: number) => boolean)[]) {
  const matte = matteAt(plane), bands = near.map(() => 0);
  let clipOver = 0, canvasOver = 0, beyond = 0, luma = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = value(m, x, y), c = y - CLIP_Y, inClip = c >= 0 && c < CLIP_H;
    if (!v || (inClip && matte(x, c) > 0)) continue;
    const [r, g, b] = rgb(m, x, y);
    luma = Math.max(luma, 0.2126 * r + 0.7152 * g + 0.0722 * b);
    if (v <= GATE) continue;
    if (!inClip) { canvasOver++; continue; }
    clipOver++;
    const band = near.findIndex(f => f(x, c));
    if (band < 0) beyond++; else bands[band]++;
  }
  return { clipOver, canvasOver, bands, beyond, luma };
}

test('BG-P05 max: where the pixels over 16 come from, before and after the encoder', async ({ page }) => {
  test.setTimeout(1_800_000);
  const dir = mkdtempSync(path.join(tmpdir(), 't12-stages-'));
  const server = createServer((req, res) => {
    const parts: Buffer[] = [], k = Number(req.url!.slice(1));
    req.on('data', c => parts.push(c));
    req.on('end', () => { writeFileSync(path.join(dir, `${k}.rgba`), Buffer.concat(parts)); res.writeHead(204, { 'access-control-allow-origin': '*' }); res.end(); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port, open: { close(): void }[] = [];
  try {
    const { id } = await setup(page, videoDoc([item('c', 2000, 7000)], { }), { c: CLIP2 }, 'T12 export');
    await clip(page, 'c').click();
    await page.getByRole('button', { name: 'Apply' }).first().click();
    const layers = async () => ((await stored(page, id) as any).items[0].masks ?? []) as any[];
    await expect.poll(async () => (await layers()).length, { timeout: 1_500_000 }).toBe(1);
    const [layer] = await layers();

    // The readback the export makes before rgbaToI420, each frame sent out as it passes; nothing else reads a canvas of this size.
    await page.evaluate(({ port, W, H }) => {
      const real = OffscreenCanvasRenderingContext2D.prototype.getImageData, sent: Promise<unknown>[] = (window as any).__sent = [];
      OffscreenCanvasRenderingContext2D.prototype.getImageData = function (this: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, settings?: ImageDataSettings) {
        const image = real.call(this, x, y, w, h, settings);
        if (w === W && h === H) sent.push(fetch(`http://127.0.0.1:${port}/${sent.length}`, { method: 'POST', body: new Blob([image.data]) }));
        return image;
      };
    }, { port, W, H });
    const r = await runExport(page, id);
    completed(r);
    expect(r.result!.frames).toBe(FRAMES);
    expect(await page.evaluate(async () => (await Promise.all((window as any).__sent)).length)).toBe(FRAMES);

    const encoded = fileRgba(r.file!, path.join(dir, 'encoded.raw'));
    open.push(encoded);
    expect(encoded.count).toBe(FRAMES);
    // Control: the file's own planes through backToRgba give rawFrames' bytes, so the i420 stage is read the way the export is.
    const planesOfFile = path.join(dir, 'file.yuv');
    ff('ffmpeg', ['-v', 'error', '-y', '-i', r.file!, '-an', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', planesOfFile]);
    const control = backToRgba(planesOfFile, path.join(dir, 'control.raw'));
    open.push(control);
    const controlSame = [0, 37, 149].every(k => control.at(k).equals(encoded.at(k)));
    const yuv = path.join(dir, 'i420.yuv'), fd = openSync(yuv, 'w'), i420 = new Uint8Array(W * H * 3 / 2);
    for (let k = 0; k < FRAMES; k++) { const f = readFileSync(path.join(dir, `${k}.rgba`)); rgbaToI420(new Uint8ClampedArray(f.buffer, f.byteOffset, f.length), W, H, i420); writeSync(fd, i420); }
    closeSync(fd);
    const through = backToRgba(yuv, path.join(dir, 'i420.raw'));
    open.push(through);

    const STAGES = ['composited', 'i420', 'encoded'] as const, rows: Record<string, unknown>[] = [];
    const summary = Object.fromEntries(STAGES.map(s => [s, { framesOver: 0, clipFramesOver: 0, max: 0, clipMax: 0, canvasMax: 0, mean: 0, luma: 0, clipPixelsOver: 0, canvasPixelsOver: 0, bands: [0, 0, 0], beyond: 0 }]));
    for (let k = 0; k < FRAMES; k++) {
      const [base64] = await planes(page, layer.raster, [2_000_000 + Math.round(k * 1e6 / 30)]), plane = Buffer.from(base64, 'base64');
      const frames = { composited: readFileSync(path.join(dir, `${k}.rgba`)), i420: through.at(k), encoded: encoded.at(k) }, near = [1, 2, 4].map(by => nearMatte(plane, by)), row: Record<string, unknown> = { k };
      for (const s of STAGES) {
        const n = behindNumbers(plane, frames[s]), o = overGate(plane, frames[s], near), t = summary[s];
        row[s] = [n.behindMax, n.behindClipMax, n.canvasMax, o.clipOver, o.canvasOver];
        t.max = Math.max(t.max, n.behindMax); t.clipMax = Math.max(t.clipMax, n.behindClipMax); t.canvasMax = Math.max(t.canvasMax, n.canvasMax); t.mean = Math.max(t.mean, n.behindMean); t.luma = Math.max(t.luma, o.luma);
        if (n.behindMax > GATE) t.framesOver++;
        if (n.behindClipMax > GATE) t.clipFramesOver++;
        t.clipPixelsOver += o.clipOver; t.canvasPixelsOver += o.canvasOver; t.beyond += o.beyond; o.bands.forEach((b, i) => { t.bands[i] += b; });
      }
      rows.push(row);
    }
    // The worst frames' pixels over the gate, through the stages: the I420 planes say whether a pixel's light comes from its own luma or from the chroma it shares with its 2 × 2 block.
    const pixels: Record<string, unknown>[] = [];
    for (const { k } of [...rows].sort((a: any, b: any) => b.encoded[0] - a.encoded[0]).slice(0, 4) as { k: number }[]) {
      const [base64] = await planes(page, layer.raster, [2_000_000 + Math.round(k * 1e6 / 30)]), matte = matteAt(Buffer.from(base64, 'base64')), raw = readFileSync(path.join(dir, `${k}.rgba`)), i = through.at(k), e = encoded.at(k), cw = W >> 1, found: { x: number; y: number; v: number }[] = [];
      rgbaToI420(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length), W, H, i420);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = Math.max(value(i, x, y), value(e, x, y)), c = y - CLIP_Y;
        if (v > GATE && (c < 0 || c >= CLIP_H || !(matte(x, c) > 0))) found.push({ x, y, v });
      }
      for (const { x, y } of found.sort((a, b) => b.v - a.v).slice(0, 5)) {
        const bx = x & ~1, by = y & ~1, chroma = (by >> 1) * cw + (bx >> 1);
        pixels.push({ k, x, y, composited: rgb(raw, x, y), block: [[bx, by], [bx + 1, by], [bx, by + 1], [bx + 1, by + 1]].map(([u, v]) => Math.max(...rgb(raw, u, v))), Y: i420[y * W + x], U: i420[W * H + chroma], V: i420[W * H + (cw * (H >> 1)) + chroma], i420: rgb(i, x, y), encoded: rgb(e, x, y) });
      }
    }
    console.log('STAGE control', controlSame);
    console.log('STAGE pixels', JSON.stringify(pixels));
    console.log('STAGE summary', JSON.stringify(summary));
    console.log('STAGE rows [max, clip max, canvas max, clip px over, canvas px over]', JSON.stringify(rows));
  } finally {
    for (const raw of open) raw.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
