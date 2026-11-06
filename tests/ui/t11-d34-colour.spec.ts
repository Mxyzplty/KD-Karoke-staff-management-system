// SPDX-License-Identifier: AGPL-3.0-only
// D34: exercise the actual export and preview pipelines with a flat BT.709 video.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { completed, decodeRgba, genMedia, imageDoc, mkDoc, runExport, setup } from './t16a-support';

const input = (v: number) => {
  const x = v / 255, linear = x < 0.081 ? x / 4.5 : ((x + 0.099) / 1.099) ** (1 / 0.45);
  return Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));
};
const output = (v: number) => {
  const x = v / 255, linear = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  return Math.round(255 * (linear < 0.018 ? 4.5 * linear : 1.099 * linear ** 0.45 - 0.099));
};

test.skip(!ffmpegAvailable(), 'ffmpeg creates the input and decodes the exported video');
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

test('D34 export fade uses both tables; preview keeps the decoded video unchanged', async ({ page }) => {
  const file = genMedia('t11-d34-grey-v1.mp4', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=160x90:r=10:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']);
  const doc = mkDoc([{ id: 'a', from: 0, to: 2000, sourceDuration: 4000 }, { id: 'b', from: 2000, to: 4000, sourceDuration: 4000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { a: file, b: file });
  const encoded = readFileSync(file).toString('base64');
  const source = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), blob = new Blob([bytes], { type: 'video/mp4' });
    const d = '/src/media/decode.ts', p = '/src/render/decoder-pool.ts', e = '/src/export/decoders.ts';
    const { videoFrames, frameToRgba } = await import(d), pool = await import(p), { ExportDecoders } = await import(e);
    const frames = videoFrames(blob, { startS: 0 });
    const next = await frames.next(); if (next.done) throw new Error('fixture has no frames');
    const decoded = frameToRgba(next.value, 0).data;
    const preview = await pool.decodeFrame({ key: 'd34-preview', blob, rotation: 0 }, 0);
    const canvas = document.createElement('canvas'); canvas.width = preview.width; canvas.height = preview.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(preview.bitmap, 0, 0);
    const got = Array.from(ctx.getImageData(80, 45, 1, 1).data);
    const off = (45 * preview.width + 80) * 4, raw = Array.from(decoded.slice(off, off + 4)) as number[];
    const decoders = new ExportDecoders(), frame = await decoders.frame({ key: 'd34-export', blob, rotation: 0 }, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(frame.bitmap, 0, 0);
    const exported = Array.from(ctx.getImageData(80, 45, 1, 1).data);
    decoders.closeAll();
    pool.closeDecoderPool(); await frames.return(undefined);
    return { got, raw, exported };
  }, encoded);
  expect(source.got).toEqual(source.raw);
  expect(source.exported).toEqual([...source.raw.slice(0, 3).map(input), source.raw[3]]);
  for (const value of source.raw.slice(0, 3)) expect(Math.abs(output(input(value)) - value)).toBeLessThanOrEqual(1);
  const transition = { id: 'transition_abcdefghij', trackId: 'v1', fromId: 'a', toId: 'b', kind: 'fade', durationMs: 1000, alignment: 0.5 };
  // Opt-in mutation for a sensitivity run: bypass the output transfer at the actual export seam.
  const mutant = process.env.D34_MUTATE_OUTPUT === '1' ? `const m = await import('/src/export/colour.ts'); for (let i = 0; i < 256; i++) m.SRGB_TO_BT709[i] = i;` : '';
  const hook = `${mutant} return { doc: { ...ctx.doc, transitions: [${JSON.stringify(transition)}] } };`;
  const run = await runExport(page, id, { range: { startS: 1.55, endS: 2.55 } }, hook);
  completed(run);
  const frames = decodeRgba(run.file!, 160, 90);
  expect(frames).toHaveLength(11);
  // Frame 0 is p=0, frame 3 is p=.3, frame 5 is p=.5. Encoding/decoding introduces quantisation.
  for (const [frame, alpha] of [[0, 1], [3, Math.cos(Math.PI * 0.3)], [5, 0], [10, 1]] as const) {
    const offset = (45 * 160 + 80) * 4;
    for (let c = 0; c < 3; c++) {
      const expected = output(Math.round(alpha * input(source.raw[c])));
      expect(Math.abs(frames[frame][offset + c] - expected), `frame ${frame}, channel ${c}`).toBeLessThanOrEqual(3);
    }
  }
});

test('D34 a grey image receives the output transfer only in a real export', async ({ page }) => {
  const file = genMedia('t11-d34-grey-v1.png', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=160x90', '-frames:v', '1', '-threads', '1']);
  const { id } = await setup(page, imageDoc(1000, 10), { img: file });
  const run = await runExport(page, id);
  completed(run);
  const frames = decodeRgba(run.file!, 160, 90);
  expect(frames.length).toBeGreaterThan(0);
  // Read the image's actual decoded byte: its PNG was generated through a YUV source.
  const image = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return Array.from(ctx.getImageData(80, 45, 1, 1).data);
  }, readFileSync(file).toString('base64'));
  const offset = (45 * 160 + 80) * 4;
  for (let c = 0; c < 3; c++) expect(Math.abs(frames[0][offset + c] - output(image[c]))).toBeLessThanOrEqual(3);
});
