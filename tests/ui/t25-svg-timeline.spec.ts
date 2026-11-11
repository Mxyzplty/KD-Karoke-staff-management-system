// SPDX-License-Identifier: AGPL-3.0-only
// T25 AC1/AC3/AC4: actual file-input ingestion, ordinary addMedia, raw preview and real captureFrame JPEGs.
// All actual MP4 export tests live in t25-svg-export.spec.ts, never in this file.
import { expect, test } from '@playwright/test';
import { skipTour } from './t02-support';
import {
  bitmapSize, breakPlacedSvg, BROKEN_FIXTURE, CAPTURE_TOLERANCE, captureRegions, CORE_SVGS, EDGE_TRANSITION_LIMIT,
  expectRegions, expectSharpEdges, expectSvgIngest, FOREIGN_OBJECT_FIXTURE, FRAME_SIZE, greySamples, ICON_FIXTURE, ICON_FRAME_SIZE, intrinsicSize,
  lowResolutionIconRows, measureEdges, MIME_CASES, openAndPlaceSvg, openSvgProject, placeUploadedSvg, PREVIEW_TOLERANCE, previewCanvas,
  previewEdgeRows, previewRegions, samplesInFrame, SVG_FIXTURES, uploadSvg,
} from './t25-svg-support';

test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

// Mutation target is ONLY the first generated case: "T25 AC1 preview square typed: exact SVG pixels and capture JPEG".
// Its first preview assertion is deliberately data-exact=true. The base source fails ImageBitmap(SVG Blob), complete()
// is false for that failed image, and PreviewFrames writes data-exact=false. Independent fixture-colour checks follow.
for (const fixture of SVG_FIXTURES) for (const mime of MIME_CASES) {
  test(`T25 AC1 preview ${fixture.key} ${mime.label}: exact SVG pixels and capture JPEG`, async ({ page }) => {
    const { uploaded, item } = await openAndPlaceSvg(page, fixture, mime.mimeType), canvas = previewCanvas(page);
    await expect(canvas).toHaveAttribute('data-exact', 'true');
    await expect(canvas).toHaveAttribute('data-frame', '0');
    expectSvgIngest(uploaded, fixture);
    const stored = intrinsicSize(fixture), raster = bitmapSize(fixture), points = samplesInFrame(fixture);
    expect(item.properties.width.defaultValue).toBe(stored.width); expect(item.properties.height.defaultValue).toBe(stored.height);
    expect(await canvas.evaluate(element => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }))).toEqual(FRAME_SIZE);
    const ready = await page.evaluate(async assetId => {
      const p = '/src/render/sources.ts', { readyImage } = await import(p), bitmap = readyImage({ metadata: { assetId } });
      return bitmap && bitmap !== 'failed' ? { width: bitmap.width, height: bitmap.height } : bitmap;
    }, uploaded.asset.id);
    expect(ready).toEqual(raster);
    expectRegions(await previewRegions(page, points), points, PREVIEW_TOLERANCE, `${fixture.key} ${mime.label} preview`);
    const capture = await captureRegions(page, points);
    expect(capture.success, JSON.stringify(capture)).toBe(true); expect(capture.imageCount).toBe(1); expect(capture.magic).toEqual([0xff, 0xd8, 0xff]);
    expect(capture.size).toEqual({ width: 240, height: 240 }); expect(capture.metadata).toMatchObject({ success: true, quality: 'high', frames: [{ frame: 0, width: 240, height: 240 }] });
    expectRegions(capture.regions, points, CAPTURE_TOLERANCE, `${fixture.key} ${mime.label} capture JPEG versus fixture`);
  });
}

for (const mime of MIME_CASES) test(`T25 AC3 raw preview icon ${mime.label}: 1920px edge is sharp and a 24px-first negative control is not`, async ({ page }) => {
  const { uploaded } = await openAndPlaceSvg(page, ICON_FIXTURE, mime.mimeType, ICON_FRAME_SIZE), canvas = previewCanvas(page);
  await expect(canvas).toHaveAttribute('data-exact', 'true'); expectSvgIngest(uploaded, ICON_FIXTURE);
  expect(await canvas.evaluate(element => [(element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height])).toEqual([1920, 1920]);
  const positive = expectSharpEdges(await previewEdgeRows(page), `raw preview ${mime.label}`), negative = measureEdges(await lowResolutionIconRows(page));
  for (const row of negative) expect(row.transitionPx, `24px-first negative control row ${row.y} must violate the same <=3px bound`).toBeGreaterThan(EDGE_TRANSITION_LIMIT);
  test.info().annotations.push({ type: 'icon-edge', description: JSON.stringify({ positive, negative, oracle: 'x50=500+/-1px; 10-90% <=3px; rows=320,960,1600' }) });
});

for (const mime of MIME_CASES) test(`T25 AC4 fresh malformed upload ${mime.label}: probe fails and ordinary addMedia refuses it`, async ({ page }) => {
  const projectId = await openSvgProject(page), uploaded = await uploadSvg(page, projectId, BROKEN_FIXTURE, mime.mimeType, 'failed');
  expect(uploaded.asset.processing_steps?.probe).toBe('failed'); expect(uploaded.asset.last_error_code).toBeTruthy();
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect.poll(() => page.evaluate(async assetId => {
    const p = '/src/timeline/runtime.ts', { activeRuntime } = await import(p); return activeRuntime?.assets.get(assetId)?.processing_status;
  }, uploaded.asset.id)).toBe('failed');
  const refused = await page.evaluate(async assetId => {
    const r = '/src/timeline/runtime.ts', e = '/src/editor.tsx', { activeRuntime } = await import(r), { activeSession } = await import(e);
    return { result: activeRuntime.call('addMedia', { assetId, trackId: 'v1', timelineStart: 0, duration: 0.25 }), items: activeSession.document.items };
  }, uploaded.asset.id);
  expect(refused.result).toMatchObject({ success: false, code: 'VALIDATION_FAILED', data: { failures: [{ assetId: uploaded.asset.id, code: 'INVALID_ASSET_URL' }] } });
  expect(refused.items).toEqual([]);
});

for (const mime of MIME_CASES) test(`T25 AC4 broken after valid ingest ${mime.label}: cached failure is inexact grey in preview and capture`, async ({ page }) => {
  const { uploaded } = await openAndPlaceSvg(page, CORE_SVGS[0], mime.mimeType);
  expectSvgIngest(uploaded, CORE_SVGS[0]); await breakPlacedSvg(page, uploaded);
  const canvas = previewCanvas(page); await expect(canvas).toHaveAttribute('data-frame', '0'); await expect(canvas).toHaveAttribute('data-exact', 'false');
  const points = greySamples(); expectRegions(await previewRegions(page, points), points, PREVIEW_TOLERANCE, 'broken SVG preview #374151');
  const capture = await captureRegions(page, points); expect(capture.success).toBe(true); expect(capture.imageCount).toBe(1);
  expectRegions(capture.regions, points, CAPTURE_TOLERANCE, 'broken SVG capture versus specified #374151');
  expect(await page.evaluate(async assetId => {
    const s = '/src/store/database.ts', r = '/src/render/sources.ts', { projectStore } = await import(s), { readyImage } = await import(r);
    return { state: (await projectStore.row('assets', assetId)).processing_status, ready: readyImage({ metadata: { assetId } }) };
  }, uploaded.asset.id)).toEqual({ state: 'ready', ready: 'failed' });
});

// D97 stages stand alone: a thumbnail failure must not hide preview taint or a capture refusal.
for (const mime of MIME_CASES) {
  test(`T25 D97 foreignObject upload ${mime.label}: ready with complete thumbnail and no error`, async ({ page }) => {
    const projectId = await openSvgProject(page), uploaded = await uploadSvg(page, projectId, FOREIGN_OBJECT_FIXTURE, mime.mimeType);
    expectSvgIngest(uploaded, FOREIGN_OBJECT_FIXTURE); expect(uploaded.asset.last_error_code).toBeNull();
  });

  test(`T25 D97 foreignObject preview ${mime.label}: exact frame and fixture colours`, async ({ page }) => {
    await openAndPlaceSvg(page, FOREIGN_OBJECT_FIXTURE, mime.mimeType);
    const canvas = previewCanvas(page); await expect(canvas).toHaveAttribute('data-exact', 'true'); await expect(canvas).toHaveAttribute('data-frame', '0');
    const points = samplesInFrame(FOREIGN_OBJECT_FIXTURE);
    expectRegions(await previewRegions(page, points), points, PREVIEW_TOLERANCE, `foreignObject ${mime.label} preview`);
  });

  test(`T25 D97 foreignObject capture ${mime.label}: one readable JPEG with fixture colours`, async ({ page }) => {
    await openAndPlaceSvg(page, FOREIGN_OBJECT_FIXTURE, mime.mimeType);
    const points = samplesInFrame(FOREIGN_OBJECT_FIXTURE), capture = await captureRegions(page, points);
    expect(capture.success, JSON.stringify(capture)).toBe(true); expect(capture.imageCount).toBe(1); expect(capture.magic).toEqual([0xff, 0xd8, 0xff]);
    expectRegions(capture.regions, points, CAPTURE_TOLERANCE, `foreignObject ${mime.label} capture JPEG versus fixture`);
  });
}

test('T25 D97 large SVG typed: above 2 MB uploads with thumbnail and exact fixture pixels', async ({ page }) => {
  const square = CORE_SVGS[0], fixture = { ...square, key: 'large-square', svg: square.svg.replace('</svg>', `<!--${'x'.repeat(2 * 1024 * 1024)}--></svg>`) };
  expect(Buffer.byteLength(fixture.svg, 'utf8')).toBeGreaterThan(2 * 1024 * 1024);
  const projectId = await openSvgProject(page), uploaded = await uploadSvg(page, projectId, fixture, 'image/svg+xml');
  expectSvgIngest(uploaded, fixture); await placeUploadedSvg(page, uploaded);
  const canvas = previewCanvas(page); await expect(canvas).toHaveAttribute('data-exact', 'true'); await expect(canvas).toHaveAttribute('data-frame', '0');
  const points = samplesInFrame(fixture); expectRegions(await previewRegions(page, points), points, PREVIEW_TOLERANCE, 'large square SVG preview');
});
