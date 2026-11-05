// SPDX-License-Identifier: AGPL-3.0-only
// Shared helpers for the T10 fix round 2 specs (effect-stage failures and the device-loss window): an image project built
// through the real store with a PNG made in the page, captureFrame run in the page, and stage pixel reads.
import { expect, type Page } from '@playwright/test';
import { createProject, linkClip } from './t02-support';
import { videoDoc } from './t15-support';

export const W = 200, H = 200;
/** A stored instance as the stack writes it (one GPU effect). */
export const grayscale = (id = 'aaaaaaaaa') => ({ id: `effect_1730000000000_${id}`, effectId: 'grayscale', enabled: true, order: 0, parameters: { amount: { defaultValue: 100, keyframes: [] } } });
export const levels = () => ({ id: 'effect_1730000000000_bbbbbbbbb', effectId: 'levels', enabled: true, order: 0,
  parameters: Object.fromEntries(Object.entries({ inputBlack: 10, inputWhite: 90, gamma: 1.4, outputBlack: 5, outputWhite: 95 }).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }])) });
/** Image items on V1 of a W × H, 30 fps project (one second each, in order). */
export function imageDoc(items: { id: string; effects?: unknown[] }[]) {
  const d = videoDoc(items.map((x, n) => ({ id: x.id, from: n * 1000, to: (n + 1) * 1000, sourceDuration: 1000, ...x.effects ? { effects: x.effects } : {} })), { size: { width: W, height: H }, duration: items.length * 1000 });
  for (const i of d.items) (i as Record<string, unknown>).type = 'image';
  return d;
}
/** PNG bytes (base64) of a 64 × 64 picture made in the page: red left half, blue right half, a green band across. */
export const pngInPage = (page: Page) => page.evaluate(async () => {
  const c = new OffscreenCanvas(64, 64), x = c.getContext('2d')!;
  x.fillStyle = '#e02020'; x.fillRect(0, 0, 32, 64); x.fillStyle = '#2040e0'; x.fillRect(32, 0, 32, 64); x.fillStyle = '#20c040'; x.fillRect(0, 24, 64, 16);
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
});
/** Creates the project, stores the page-made PNG once, links it to every item, opens the editor. Returns the PNG (base64). */
export async function openImages(page: Page, doc: ReturnType<typeof imageDoc>, title: string, beforeOpen?: () => Promise<void>) {
  const id = await createProject(page, doc, title), png = await pngInPage(page);
  const assetId = await page.evaluate(async b64 => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    const asset = await projectStore.upload(new File([Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))], 'pattern.png', { type: 'image/png' }));
    return asset.id as string;
  }, png);
  await page.evaluate(async ({ id, assetId }) => { const p = '/src/store/database.ts'; await (await import(p)).projectStore.attach(id, assetId); }, { id, assetId });
  for (const i of doc.items) await linkClip(page, id, assetId, i.id);
  await beforeOpen?.();
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return png;
}
/** Every RGBA byte of the stage canvas of run 0. */
export const stagePixels = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('canvas.run[data-run="0"]') as HTMLCanvasElement, d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let s = ''; for (let k = 0; k < d.length; k += 0x8000) s += String.fromCharCode(...d.subarray(k, k + 0x8000)); return btoa(s);
}).then(b64 => Uint8Array.from(Buffer.from(b64, 'base64')));
export const maxAlpha = (px: Uint8Array) => { let m = 0; for (let i = 3; i < px.length; i += 4) m = Math.max(m, px[i]); return m; };

export type Captured = { result: Record<string, any>; frames: Record<string, any>[]; images: { base64: string; mean: number; max: number; spread: number }[] };
/** captureFrame(env, args) in the page (as t15-capture.spec.ts); each JPEG block decoded to its mean, max and max |R−G|, |G−B|.
 *  loseDevice: the WebGPU device is destroyed (not awaited) right before the call, so the capture starts inside the loss window. */
export async function capture(page: Page, args: Record<string, unknown>, loseDevice = false): Promise<Captured> {
  return page.evaluate(async ({ args, loseDevice }) => {
    const c = '/src/render/capture.ts', d = '/src/store/database.ts', e = '/src/editor.tsx', v = '/src/editor/view.ts', f = '/src/render/effects.ts';
    const { captureFrame } = await import(c), { projectStore } = await import(d), { activeSession } = await import(e), { view } = await import(v), fx = await import(f);
    const assets = (await projectStore.library()).assets as { id: string }[];
    const lost = loseDevice ? fx.loseEffectsDevice() : null;
    const result = await captureFrame({ store: projectStore, doc: activeSession.document, asset: (id: string) => assets.find(a => a.id === id), playheadMs: view().playheadMs }, args);
    const images = [];
    for (const block of (result.content ?? []).filter((b: { type: string }) => b.type === 'image')) {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(block.base64), ch => ch.charCodeAt(0))], { type: 'image/jpeg' }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height), ctx = cv.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data; let sum = 0, max = 0, spread = 0;
      for (let i = 0; i < px.length; i += 4) { for (let k = 0; k < 3; k++) { sum += px[i + k]; max = Math.max(max, px[i + k]); } spread = Math.max(spread, Math.abs(px[i] - px[i + 1]), Math.abs(px[i + 1] - px[i + 2])); }
      images.push({ base64: block.base64 as string, mean: sum / (px.length / 4 * 3), max, spread });
    }
    await lost;
    const text = result.content?.[0]?.text;
    return { result: { ...result, content: undefined }, frames: text ? JSON.parse(text).frames : [], images };
  }, { args, loseDevice });
}
