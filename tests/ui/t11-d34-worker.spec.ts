// SPDX-License-Identifier: AGPL-3.0-only
// D34: exercise the real shared worker's raw and bitmap reply paths with an untagged video.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable } from '../media-fixtures';
import { genMedia, streams } from './t16a-support';

const transfer = (v: number) => {
  const x = v / 255, linear = x < 0.081 ? x / 4.5 : ((x + 0.099) / 1.099) ** (1 / 0.45);
  return Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));
};

test.skip(!ffmpegAvailable(), 'ffmpeg creates the untagged two-half source');
test.setTimeout(180_000);

test('untagged video: shared worker tables export pixels and preserves preview and raw stacked alpha for both decoders', async ({ page }) => {
  const file = genMedia('t11-d34-worker-untagged-v1.mp4', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=32x16:r=10:d=1', '-vf', 'drawbox=x=16:y=0:w=16:h=16:color=0x303030:t=fill', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
  const video = streams(file).find(s => s.codec_type === 'video');
  expect(video.color_transfer ?? 'unknown').toBe('unknown');
  await page.goto('/');
  const results = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'video/mp4' });
    const path = '/src/media/decode.ts', { videoFrames, frameToRgba } = await import(path);
    const results = [];
    for (const forceWasm of [false, true]) {
      const iterator = videoFrames(blob, { forceWasm, startS: 0 });
      const first = await iterator.next();
      if (first.done) throw new Error('fixture has no video frames');
      const control = first.value, rgba = frameToRgba(control, 0);
      const source = control.source, transfer = control.colour.transfer;
      await iterator.return(undefined);
      const request = async (raw: boolean, exportColour: boolean) => {
        const worker = new Worker('/src/render/decoder.worker.ts?worker_file&type=module', { type: 'module' });
        try {
          const reply: any = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('worker request timed out')), 30000);
            worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
            worker.onmessage = e => { clearTimeout(timer); resolve(e.data); };
            worker.postMessage({ id: 1, key: 'd34', blob, timeS: 0, rotation: 0, forceWasm, raw, ...(exportColour ? { exportColour: true } : {}) });
          });
          if (!reply.ok) throw new Error(`${reply.code}: ${reply.message}`);
          if (raw) return Array.from(new Uint8Array(reply.data));
          const canvas = document.createElement('canvas'); canvas.width = reply.width; canvas.height = reply.height;
          const ctx = canvas.getContext('2d')!; ctx.drawImage(reply.bitmap, 0, 0); reply.bitmap.close();
          return Array.from(ctx.getImageData(0, 0, reply.width, reply.height).data);
        } finally { worker.terminate(); }
      };
      results.push({ source, transfer, width: rgba.width, height: rgba.height, control: Array.from(rgba.data) as number[],
        previewRaw: await request(true, false), exportRaw: await request(true, true),
        previewBitmap: await request(false, false), exportBitmap: await request(false, true) });
    }
    return results;
  }, readFileSync(file).toString('base64'));

  expect(results.map(r => r.source)).toEqual(['webcodecs', 'wasm']);
  for (const result of results) {
    expect(result.transfer).toBe('bt709');
    expect([result.width, result.height]).toEqual([32, 16]);
    expect(result.previewRaw).toEqual(result.control);
    expect(result.previewBitmap).toEqual(result.control);
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) for (let c = 0; c < 4; c++) {
      const i = (y * result.width + x) * 4 + c, value = result.control[i];
      expect(result.exportRaw[i], `${result.source} raw (${x},${y}) channel ${c}`).toBe(x < result.width / 2 && c < 3 ? transfer(value) : value);
      expect(result.exportBitmap[i], `${result.source} bitmap (${x},${y}) channel ${c}`).toBe(c < 3 ? transfer(value) : value);
    }
    expect(result.control.some((v, i) => i % 4 < 3 && transfer(v) !== v)).toBe(true);
  }
});
