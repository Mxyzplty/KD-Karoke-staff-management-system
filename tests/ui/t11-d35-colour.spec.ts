// SPDX-License-Identifier: AGPL-3.0-only
// D35: graphics are converted before compositing; the final output transfer still covers every pixel.
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { completed, decodeRgba, rectShape, runExport, setup } from './t16a-support';

const input = (v: number) => {
  const x = v / 255, l = x < 0.081 ? x / 4.5 : ((x + 0.099) / 1.099) ** (1 / 0.45);
  return Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
};
const output = (v: number) => {
  const x = v / 255, l = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  return Math.round(255 * (l < 0.018 ? 4.5 * l : 1.099 * l ** 0.45 - 0.099));
};
const p = (v: number) => ({ defaultValue: v, keyframes: [] });
const graphic = (colour: string) => ({
  id: 'g', type: 'motionGraphic', trackId: 'o1', display: { from: 0, to: 300 }, trim: { from: 0, to: 300 }, sourceDuration: 300, playbackRate: 1,
  details: { name: 'D35', code: `export const G = () => <AbsoluteFill style={{backgroundColor: '${colour}'}} />;` },
  metadata: {}, effects: [], masks: [], properties: { positionX: p(0), positionY: p(0), width: p(160), height: p(90), scale: p(1) },
});
const doc = (item: unknown) => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 300, fps: 10, size: { width: 160, height: 90 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: [{ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 }],
  layerOrder: [{ type: 'track', id: 'o1' }], items: [item],
});
const pixel = (frame: Buffer) => [...frame.subarray((45 * 160 + 80) * 4, (45 * 160 + 80) * 4 + 3)];
const sampled = (frame: Buffer, label: string) => {
  const rgb = pixel(frame); test.info().annotations.push({ type: 'decoded RGB', description: `${label}: ${rgb.join(',')}` }); return rgb;
};
const near = (actual: number[], expected: number[], tolerance: number) => actual.forEach((v, i) => expect(Math.abs(v - expected[i]), `channel ${i}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance));
// Hook starts after the editor has loaded: count only ImageData bitmaps created by the export.
const trackBitmaps = (delayMs = 0) => `
  const original = window.createImageBitmap, records = [];
  window.__d35 = { original, records };
  window.createImageBitmap = async (...args) => {
    if (!(args[0] instanceof ImageData)) return original(...args);
    if (${delayMs}) await new Promise(r => setTimeout(r, ${delayMs}));
    const bitmap = await original(...args), close = bitmap.close.bind(bitmap), record = { bitmap, closes: 0 };
    records.push(record); bitmap.close = () => { record.closes++; close(); }; return bitmap;
  };
`;
const bitmapResults = (page: import('@playwright/test').Page): Promise<{ closes: number; width: number; height: number }[]> => page.evaluate(() => {
  const state = (window as any).__d35; window.createImageBitmap = state.original;
  return state.records.map((r: any) => ({ closes: r.closes, width: r.bitmap.width, height: r.bitmap.height }));
});

test.skip(!ffmpegAvailable(), 'ffmpeg decodes the exported file');
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

test('D35 graphic round-trips and preview retains its original colour', async ({ page }) => {
  const { id } = await setup(page, doc(graphic('#101010')), {});
  const preview = await page.evaluate(async id => {
    const m = '/src/render/model.ts', s = '/src/render/sources.ts', db = '/src/store/database.ts';
    const { projectStore } = await import(db), { document: doc } = await projectStore.read(id);
    const draw = (await import(m)).framePlan(doc, 0, { width: 160, height: 90 }).draws[0];
    const source = await (await import(s)).picture(projectStore, draw, undefined);
    const c = new OffscreenCanvas(160, 90), ctx = c.getContext('2d')!;
    ctx.drawImage(source.image, 0, 0); source.image.close();
    return Array.from(ctx.getImageData(80, 45, 1, 1).data);
  }, id);
  expect(preview).toEqual([16, 16, 16, 255]);
  expect(output(input(16))).toBe(16);
  const run = await runExport(page, id, {}, trackBitmaps()); completed(run);
  const bitmaps = await bitmapResults(page);
  expect(bitmaps.length).toBeGreaterThan(0);
  expect(bitmaps.every(b => b.closes === 1 && b.width === 0 && b.height === 0)).toBe(true);
  near(sampled(decodeRgba(run.file!, 160, 90)[0], 'graphic'), [16, 16, 16], 1);
});

test('D35 failed graphic waits for a late sibling and closes its bitmap once', async ({ page }) => {
  const broken = { ...graphic('#101010'), id: 'broken', details: { name: 'Broken', code: 'export const G = () => <AbsoluteFill style={{ ;' } };
  const valid = { ...graphic('#101010'), id: 'valid' };
  const project = doc(broken); project.items = [broken, valid];
  const { id } = await setup(page, project, {});
  const run = await runExport(page, id, {}, trackBitmaps(2000), false);
  expect(run.status).toBe('failed'); expect(run.error?.code).toBe('MG_RENDER_FAILED');
  const bitmaps = await bitmapResults(page);
  expect(bitmaps.length).toBeGreaterThan(0);
  expect(bitmaps.every(b => b.closes === 1 && b.width === 0 && b.height === 0)).toBe(true);
});

test('D35 shape receives only the output transfer', async ({ page }) => {
  const shape = rectShape('s', 'o1', { from: 0, to: 300 }, '#ff3366');
  // rectShape's position is the top-left of its 160 x 90 box.
  shape.properties.positionX = p(0); shape.properties.positionY = p(0);
  const expected = [255, 51, 102].map(output);
  expect(expected).toEqual([255, 35, 88]);
  const { id } = await setup(page, doc(shape), {});
  const run = await runExport(page, id); completed(run);
  near(sampled(decodeRgba(run.file!, 160, 90)[0], 'shape'), expected, 1);
});

test('D35 converts straight colour before alpha compositing on black', async ({ page }) => {
  // PNG alpha 64/255: straight 128 -> input 140 -> composite 35 -> output 19.
  // Converting the premultiplied 32 instead produces output 32, a 13-code separation.
  const alpha = 64 / 255, correct = output(Math.round(input(128) * alpha));
  const premultiplied = output(input(Math.round(128 * alpha)));
  expect([input(128), correct, premultiplied]).toEqual([140, 19, 32]);
  const { id } = await setup(page, doc(graphic('rgba(128,128,128,0.25)')), {});
  const run = await runExport(page, id); completed(run);
  near(sampled(decodeRgba(run.file!, 160, 90)[0], 'alpha'), [correct, correct, correct], 3);
});

test('D35 PNG decoding preserves straight RGB and alpha down to one alpha code', async ({ page }) => {
  // Decoder reads the PNG chunks and zlib payload. Construct a tiny, lossless RGBA scanline.
  const chunk = (name: string, data: Buffer) => {
    const n = Buffer.alloc(4); n.writeUInt32BE(data.length);
    return Buffer.concat([n, Buffer.from(name), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 128, 16, 255, 1, 16, 128, 0, 64]))), chunk('IEND', Buffer.alloc(0))]);
  await setup(page, doc(graphic('#101010')), {});
  const got = await page.evaluate(async b64 => {
    const p = '/src/export/graphic.ts', { decodeGraphicPng, graphicBitmap } = await import(p);
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), decoded = await decodeGraphicPng(bytes);
    const original = window.createImageBitmap; let captured: number[] = [];
    window.createImageBitmap = (async (data: ImageData) => { captured = Array.from(data.data); return {} as ImageBitmap; }) as typeof createImageBitmap;
    try { await graphicBitmap(`data:image/png;base64,${b64}`); } finally { window.createImageBitmap = original; }
    return { raw: Array.from(decoded.data), converted: captured };
  }, png.toString('base64'));
  expect(got.raw).toEqual([128, 16, 255, 1, 16, 128, 0, 64]);
  expect(got.converted).toEqual([input(128), input(16), 255, 1, input(16), input(128), 0, 64]);
});

test('D35 layout Draw recursively converts a graphic before compositing and encoding', async ({ page }) => {
  // A graphic cell has no stored-document representation today. Build the Draw explicitly;
  // from drawSource onward this exercises the real export route, including the encoded file.
  const { id } = await setup(page, doc(graphic('#101010')), {});
  const result = await page.evaluate(async id => {
    const model = '/src/render/model.ts', db = '/src/store/database.ts', pipeline = '/src/export/pipeline.ts';
    const compositor = '/src/render/compositor.ts', colour = '/src/export/i420.ts', probe = '/src/export/probe.ts';
    // Reuse Vite's resolved dependency URL; its cache location varies with the server root.
    const response = await fetch(pipeline);
    if (!response.ok) throw new Error(`Could not read transformed export pipeline: ${response.status}`);
    const match = (await response.text()).match(/from\s*["']([^"']*mediabunny[^"']*)["']/);
    if (!match) throw new Error('Vite did not expose the mediabunny import in the transformed pipeline');
    const bunny = new URL(match[1], new URL(pipeline, location.href)).href;
    const { projectStore } = await import(db), { document: doc } = await projectStore.read(id);
    const child = (await import(model)).framePlan(doc, 0, { width: 160, height: 90 }).draws[0];
    const parent = { ...child, kind: 'layout', graphic: undefined, layout: { cells: [{ rect: { x: 0, y: 0, w: 160, h: 90 }, radius: 0, alpha: 1, media: { draw: child, fit: 'cover', zoom: 100, panX: 0, panY: 0 } }] } };
    const owned: ImageBitmap[] = [], { drawSource } = await import(pipeline);
    const source = await drawSource(projectStore, parent, () => { throw new Error('unexpected video'); }, null, new Set(), undefined, owned);
    const canvas = new OffscreenCanvas(160, 90), ctx = canvas.getContext('2d')!;
    const failures = (await import(compositor)).composite(ctx, [parent], [source], { width: 160, height: 90 }, 'black');
    const beforeClose = owned.map(b => [b.width, b.height]); owned.forEach(b => b.close());
    const afterClose = owned.map(b => [b.width, b.height]);
    const { rgbaToI420, BT709 } = await import(colour), bytes = new Uint8Array(160 * 90 * 3 / 2);
    rgbaToI420(ctx.getImageData(0, 0, 160, 90).data, 160, 90, bytes);
    const { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } = await import(bunny);
    const target = new BufferTarget(), output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const track = new EncodedVideoPacketSource('avc'); output.addVideoTrack(track, { frameRate: 10 }); await output.start();
    let mux = Promise.resolve(), error: Error | null = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      const packet = new EncodedPacket(data, chunk.type, chunk.timestamp / 1e6, 0.1);
      const m = meta?.decoderConfig ? { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: BT709 } } : meta;
      mux = mux.then(() => track.add(packet, m));
    }, error: e => { error = e; } });
    const negotiated = await (await import(probe)).negotiateVideo({ width: 160, height: 90, fps: 10, bitrate: 8_000_000 });
    enc.configure(negotiated.config);
    const frame = new VideoFrame(bytes, { format: 'I420', codedWidth: 160, codedHeight: 90, timestamp: 0, duration: 100000, colorSpace: BT709 });
    enc.encode(frame, { keyFrame: true }); frame.close(); await enc.flush(); enc.close(); await mux;
    if (error) throw error;
    track.close(); await output.finalize();
    const data = new Uint8Array(target.buffer); let binary = '';
    for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { b64: btoa(binary), failures, beforeClose, afterClose };
  }, id);
  expect(result.failures).toEqual([]);
  expect(result.beforeClose).toEqual([[160, 90]]); expect(result.afterClose).toEqual([[0, 0]]);
  const file = path.join(tmpdir(), `d35-layout-${randomUUID()}.mp4`); writeFileSync(file, Buffer.from(result.b64, 'base64'));
  near(sampled(decodeRgba(file, 160, 90)[0], 'layout'), [16, 16, 16], 1);
});

test('D35 1080p PNG bitmap conversion timing (informational)', async ({ page }) => {
  const { id } = await setup(page, doc(graphic('#101010')), {});
  const { times, bytes } = await page.evaluate(async () => {
    const p = '/src/export/graphic.ts', { graphicBitmap } = await import(p);
    // Title-card shape: a flat fill compresses to about 44 KB and hides the cost of the compressed bytes.
    const c = new OffscreenCanvas(1920, 1080), x = c.getContext('2d')!;
    const wash = x.createLinearGradient(0, 0, 1920, 1080);
    wash.addColorStop(0, 'rgba(18,40,120,.95)'); wash.addColorStop(.5, 'rgba(190,70,60,.9)'); wash.addColorStop(1, 'rgba(20,150,110,.85)');
    x.fillStyle = wash; x.fillRect(0, 0, 1920, 1080);
    for (let i = 0; i < 5; i++) {
      const cx = (i * 283) % 1920, cy = (i * 197) % 1080, glow = x.createRadialGradient(cx, cy, 0, cx, cy, 340);
      glow.addColorStop(0, `hsla(${i * 37},80%,60%,.5)`); glow.addColorStop(1, `hsla(${i * 37},80%,60%,0)`);
      x.fillStyle = glow; x.fillRect(0, 0, 1920, 1080);
    }
    for (let y = 12, n = 0; y < 1080; y += 54) for (let at = 4; at < 1920; n++) {
      const word = (n * 2654435761 >>> 0).toString(36);
      x.font = `${10 + n % 6}px sans-serif`; x.fillStyle = `hsla(${n * 61 % 360},70%,${35 + n % 50}%,${(2 + n % 8) / 10})`;
      x.fillText(word, at, y); at += x.measureText(word).width + 5;
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const png = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
    const times: number[] = [];
    for (let i = 0; i < 6; i++) { const t = performance.now(), bitmap = await graphicBitmap(png); times.push(performance.now() - t); bitmap.close(); }
    return { times, bytes: blob.size };
  });
  test.info().annotations.push({ type: '1080p PNG bytes', description: String(bytes) }, { type: '1080p graphicBitmap ms, 6 repetitions', description: JSON.stringify(times) });
  expect(times).toHaveLength(6);
});
