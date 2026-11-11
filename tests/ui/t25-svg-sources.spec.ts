// SPDX-License-Identifier: AGPL-3.0-only
// T25 source-function checks in real Chromium. Only the store read/row seam is substituted: Image decoding, canvas
// rasterisation, ImageBitmap creation and layout composition are real. These tests never upload fake ready media.
import { expect, test, type Page } from '@playwright/test';
import { skipTour } from './t02-support';
import {
  bitmapSize, BROKEN_SVG, expectRegions, intrinsicSize, MIME_CASES, PREVIEW_TOLERANCE, SQUARE_SVG, SVG_FIXTURES, WIDE_SVG,
  type Size, type SvgFixture,
} from './t25-svg-support';

test.setTimeout(60_000);
test.beforeEach(async ({ page }) => { await skipTour(page); await page.goto('/'); });

/** Calls the actual source function with actual typed/untyped stored Blobs, not an OPFS File that has lost its MIME. */
async function rasterSource(page: Page, fixture: SvgFixture, mimeType: string, storedSize: Size) {
  return page.evaluate(async ({ svg, mimeType, storedSize, samples }) => {
    const p = '/src/render/sources.ts', { imageBitmap, readyImage, clearSources } = await import(p);
    clearSources();
    const blob = new Blob([svg], { type: mimeType }), item = { id: 'image', type: 'image', metadata: { assetId: 'svg-function' } };
    const asset = { id: 'svg-function', type: 'image', media: { container: 'svg+xml', image: { ...storedSize, orientation: 1 } } };
    let reads = 0, rows = 0, imageCount = 0, urlsCreated = 0;
    const rowRequests: string[][] = [], inputs: string[] = [], madeImages: HTMLImageElement[] = [], revoked: string[] = [];
    const nativeBitmap = globalThis.createImageBitmap, NativeImage = globalThis.Image, nativeUrl = URL.createObjectURL, nativeRevoke = URL.revokeObjectURL;
    const store = { media: { read: async (id: string) => { reads++; if (id !== asset.id) throw new Error('wrong stored id'); return blob; } },
      row: async (table: string, id: string) => { rows++; rowRequests.push([table, id]); return asset; } };
    globalThis.createImageBitmap = ((...args: any[]) => {
      inputs.push(args[0] instanceof HTMLCanvasElement ? 'canvas' : args[0] instanceof HTMLImageElement ? 'Image' : args[0] instanceof Blob ? 'Blob' : 'other');
      return Reflect.apply(nativeBitmap, globalThis, args);
    }) as typeof createImageBitmap;
    globalThis.Image = class extends NativeImage { constructor(width?: number, height?: number) { super(width, height); imageCount++; madeImages.push(this); } };
    URL.createObjectURL = object => { urlsCreated++; return nativeUrl.call(URL, object); };
    URL.revokeObjectURL = url => { revoked.push(url); nativeRevoke.call(URL, url); };
    try {
      const pending = imageBitmap(store, item), shared = imageBitmap(store, { ...item, id: 'second-item' }) === pending, bitmap = await pending;
      const common = { reads, rows, rowRequests, shared, imageCount, inputs, originalType: blob.type, imageSrc: madeImages[0]?.src,
        urlsCreated, urlsRevoked: revoked.length, ready: readyImage(item) === bitmap, cached: imageBitmap(store, item) === pending };
      if (bitmap === 'failed') return { ...common, status: 'failed', size: null, regions: [] };
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0);
      const regions = samples.map(sample => {
        const data = ctx.getImageData(Math.floor(sample.u * bitmap.width) - 1, Math.floor(sample.v * bitmap.height) - 1, 3, 3).data, pixels = [];
        for (let offset = 0; offset < data.length; offset += 4) pixels.push(Array.from(data.subarray(offset, offset + 4)));
        return { label: sample.label, pixels };
      });
      return { ...common, status: 'ready', size: { width: bitmap.width, height: bitmap.height }, regions };
    } finally {
      clearSources(); globalThis.createImageBitmap = nativeBitmap; globalThis.Image = NativeImage; URL.createObjectURL = nativeUrl; URL.revokeObjectURL = nativeRevoke;
    }
  }, { svg: fixture.svg, mimeType, storedSize, samples: fixture.samples });
}

test.describe('T25 actual typed and untyped SVG source Blobs', () => {
  for (const fixture of SVG_FIXTURES) for (const mime of MIME_CASES) test(`${fixture.key} ${mime.label}: real decode, accepted bitmap size and fixture pixels`, async ({ page }) => {
    const expected = bitmapSize(fixture), result = await rasterSource(page, fixture, mime.mimeType, intrinsicSize(fixture));
    expect(result.status).toBe('ready'); expect(result.size).toEqual(expected);
    expect(result).toMatchObject({ reads: 1, rows: 1, rowRequests: [['assets', 'svg-function']], shared: true, imageCount: 1,
      inputs: ['canvas'], originalType: mime.mimeType, urlsCreated: 0, urlsRevoked: 0, ready: true, cached: true });
    expect(result.imageSrc).toBe('data:image/svg+xml;base64,' + Buffer.from(fixture.svg, 'utf8').toString('base64'));
    expectRegions(result.regions, fixture.samples.map(sample => ({ label: sample.label, x: 0, y: 0, rgba: sample.rgba })), PREVIEW_TOLERANCE, `${fixture.key} ${mime.label} source`);
  });
  for (const mime of MIME_CASES) test(`malformed ${mime.label}: real Image decode fails without object URLs`, async ({ page }) => {
    const broken: SvgFixture = { key: 'malformed', svg: BROKEN_SVG, storedSize: { width: 512, height: 512 }, rasterSize: null, samples: [] };
    const result = await rasterSource(page, broken, mime.mimeType, intrinsicSize(broken));
    expect(result).toMatchObject({ status: 'failed', size: null, reads: 1, rows: 1, shared: true, imageCount: 1, inputs: [],
      originalType: mime.mimeType, urlsCreated: 0, urlsRevoked: 0, ready: true, cached: true });
    expect(result.imageSrc).toBe('data:image/svg+xml;base64,' + Buffer.from(BROKEN_SVG, 'utf8').toString('base64'));
  });
});

// The final (5000 x 3001) row is deliberately function-level only: its unrepresentable exact ratio rounds the short
// raster side by <= 0.5 px, so a layout using that bitmap has approximate, not zero-tolerance intrinsic-ratio fitting.
test.describe('T25 real canvas size table and inclusive boundaries', () => {
  for (const [width, height, W, H] of [
    [24, 24, 2048, 2048], [512, 512, 2048, 2048], [720, 240, 2049, 683], [540, 1080, 1024, 2048],
    [3000, 1000, 3000, 1000], [6000, 2000, 4095, 1365], [5000, 3001, 4096, 2458],
    [2047, 2047, 2048, 2048], [2048, 2048, 2048, 2048], [4096, 4096, 4096, 4096], [4097, 4097, 4096, 4096],
  ]) test(`stored ${width}x${height} rasterises to ${W}x${H}`, async ({ page }) => {
    // Deliberate metadata seam: the stored row, not the SVG's root attributes or Blob MIME, owns the output dimensions.
    const fixture: SvgFixture = { key: 'size-table', svg: SQUARE_SVG, storedSize: { width, height }, rasterSize: { width: W, height: H }, samples: [] };
    const result = await rasterSource(page, fixture, '', { width, height });
    expect(result.status).toBe('ready'); expect(result.size).toEqual({ width: W, height: H }); expect(result.inputs).toEqual(['canvas']);
  });
});

test.describe('T25 layout fit observes the compositor draw, not a second pure formula call', () => {
  for (const [width, height, W, H] of [[720, 240, 2049, 683], [3000, 1000, 3000, 1000], [6000, 2000, 4095, 1365]]) {
    for (const fit of ['cover', 'contain'] as const) test(`${width}x${height} ${fit}: real picture bitmap keeps the stored-size destination exactly`, async ({ page }) => {
      const result = await page.evaluate(async ({ width, height, fit, svg }) => {
        const s = '/src/render/sources.ts', m = '/src/render/model.ts', c = '/src/render/compositor.ts', l = '/src/timeline/layouts.ts';
        const { picture, clearSources } = await import(s), { itemDraw, cellMediaRect } = await import(m), { composite, complete } = await import(c), { layoutRecord } = await import(l);
        clearSources();
        const size = { width: 640, height: 360 }, asset = { id: 'layout-svg', type: 'image', media: { container: 'svg+xml', image: { width, height, orientation: 1 } } };
        const blob = new Blob([svg]), requests: string[][] = [], store = { media: { read: async () => blob }, row: async (table: string, id: string) => { requests.push([table, id]); return asset; } };
        const layout = layoutRecord({ id: 'layout', trackId: 'o1', display: { from: 0, to: 250 }, layoutType: 'split-horizontal', ...size });
        layout.details.cells = [{ id: 'cell', bounds: { x: 0.125, y: 0.125, width: 0.5, height: 0.5 }, source: { assetId: asset.id, type: 'image', url: `asset:${asset.id}` },
          fillMode: fit === 'cover' ? 'fill' : 'fit', zoom: 120, panX: 10, panY: -20, opacity: 100, volume: 100, playbackRate: 1 }];
        const draw = itemDraw({ size, fps: 12 }, layout, 0), source = await picture(store, draw, undefined, 'preview', () => asset);
        try {
          if (!source || source === 'failed' || !('cells' in source) || !source.cells[0] || !('image' in source.cells[0])) throw new Error('Layout cell did not produce a real SVG picture.');
          const cellSource = source.cells[0], cell = draw.layout.cells[0], bitmap = cellSource.image;
          const expected = cellMediaRect(fit, width, height, cell.rect, cell.media.zoom, cell.media.panX, cell.media.panY);
          const ctx = new OffscreenCanvas(size.width, size.height).getContext('2d')!, nativeDraw = ctx.drawImage, observed: number[][] = [];
          ctx.drawImage = ((...args: any[]) => {
            if (args[0] === bitmap) observed.push(args.slice(1).map(Number));
            return Reflect.apply(nativeDraw, ctx, args);
          }) as typeof ctx.drawImage;
          const failures = composite(ctx, [draw], [source], size, 'black');
          return { bitmap: { width: bitmap.width, height: bitmap.height }, fitSize: { width: cellSource.width, height: cellSource.height },
            cell: cell.rect, actualFit: cell.media.fit, observed, expected, failures, complete: complete(source, draw), requests };
        } finally { clearSources(); }
      }, { width, height, fit, svg: WIDE_SVG });
      expect(result.bitmap).toEqual({ width: W, height: H }); expect(result.fitSize).toEqual(result.bitmap);
      expect(result.cell).toEqual({ x: 80, y: 45, w: 320, h: 180 }); expect(result.actualFit).toBe(fit);
      expect(result.requests).toEqual([['assets', 'layout-svg']]); expect(result.complete).toBe(true); expect(result.failures).toEqual([]);
      const expected = fit === 'cover' ? { x: -68, y: 9, w: 648, h: 216 } : { x: 64, y: 53, w: 384, h: 128 };
      expect(result.expected).toEqual(expected);
      // Strict equality is intentional: actual composite(drawImage(realBitmap,...)) versus stored intrinsic geometry.
      expect(result.observed).toEqual([[expected.x, expected.y, expected.w, expected.h]]);
    });
  }
});

test('T25 PNG: native decoding receives each original typed/untyped Blob itself and creates no Image, including legacy rows', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const p = '/src/render/sources.ts', { imageBitmap, clearSources } = await import(p);
    clearSources();
    const canvas = new OffscreenCanvas(32, 24), ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 32, 24);
    const png = await canvas.convertToBlob({ type: 'image/png' }), originals = [png, new Blob([png])];
    const nativeBitmap = globalThis.createImageBitmap, NativeImage = globalThis.Image, nativeUrl = URL.createObjectURL;
    let current: Blob, images = 0, urls = 0;
    const sameObject: boolean[] = [], inputKinds: boolean[] = [], sizes: Size[] = [], pixels: number[][] = [];
    globalThis.Image = class extends NativeImage { constructor(width?: number, height?: number) { super(width, height); images++; } };
    globalThis.createImageBitmap = ((...args: any[]) => {
      sameObject.push(args[0] === current); inputKinds.push(args[0] instanceof Blob); return Reflect.apply(nativeBitmap, globalThis, args);
    }) as typeof createImageBitmap;
    URL.createObjectURL = object => { urls++; return nativeUrl.call(URL, object); };
    try {
      for (const blob of originals) for (const media of [{ container: 'png' }, undefined, { image: { width: 32, height: 24 } }]) {
        clearSources(); current = blob;
        const store = { media: { read: async () => blob }, row: async () => ({ id: 'native', name: 'misleading.svg', mimeType: 'image/svg+xml', media }) };
        const bitmap = await imageBitmap(store, { type: 'image', metadata: { assetId: 'native' } });
        if (bitmap === 'failed') throw new Error('Native PNG did not decode.');
        sizes.push({ width: bitmap.width, height: bitmap.height }); ctx.clearRect(0, 0, 32, 24); ctx.drawImage(bitmap, 0, 0); pixels.push(Array.from(ctx.getImageData(16, 12, 1, 1).data));
      }
      return { sameObject, inputKinds, sizes, pixels, images, urls, originalTypes: originals.map(blob => blob.type) };
    } finally { clearSources(); globalThis.createImageBitmap = nativeBitmap; globalThis.Image = NativeImage; URL.createObjectURL = nativeUrl; }
  });
  expect(result.originalTypes).toEqual(['image/png', '']); expect(result.images).toBe(0); expect(result.urls).toBe(0);
  expect(result.sameObject).toEqual(Array(6).fill(true)); expect(result.inputKinds).toEqual(Array(6).fill(true));
  expect(result.sizes).toEqual(Array(6).fill({ width: 32, height: 24 })); expect(result.pixels).toEqual(Array(6).fill([255, 0, 255, 255]));
});
