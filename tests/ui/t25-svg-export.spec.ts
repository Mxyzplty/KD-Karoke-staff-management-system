// SPDX-License-Identifier: AGPL-3.0-only
// ALL T25 actual exports live here, so the gate can run this one spec with one worker. No import-time processes/media.
// AC2 wraps the real export pipeline's getImageData, calls the ORIGINAL method, records actual frame reads/errors and
// restores in finally. Raw readback is also the AC3 sharpness oracle; the compressed MP4 is only a flat-colour oracle.
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { outputCode } from '../../parity/oracle/transfer';
import { skipTour } from './t02-support';
import { decodeRgba, streams } from './t16a-support';
import {
  breakPlacedSvg, CORE_SVGS, DURATION_MS, EDGE_TRANSITION_LIMIT, EXPORT_TOLERANCE, expectRegions, expectSharpEdges,
  expectSvgIngest, FOREIGN_OBJECT_FIXTURE, FPS, FRAME_SIZE, greySamples, ICON_FIXTURE, ICON_FRAME_SIZE, ICON_ROWS, lowResolutionIconRows,
  measureEdges, MIME_CASES, openAndPlaceSvg, PREVIEW_TOLERANCE, previewCanvas, previewEdgeRows, samplesInFrame,
  SVG_FIXTURES, type EdgeRow, type PixelRegion, type SamplePoint, type Size,
} from './t25-svg-support';

test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

type ExportObservation = {
  status: string; reportedStatus: string; error?: unknown; result?: { frames: number; size: Size; fps: number; stats: { path: string }; notRendered: unknown[] };
  bytesBase64?: string; readback: { calls: number; exceptions: string[]; exportExceptions: string[]; firstReadStack: string;
    frames: { index: number; regions: PixelRegion[] }[]; edgeRows: EdgeRow[] }; restored: boolean;
};

/** The entire actual export is scoped inside one evaluate so even an exception restores the native readback method. */
async function observedExport(page: Page, projectId: string, points: readonly SamplePoint[], edges = false): Promise<ExportObservation> {
  return page.evaluate(async ({ projectId, points, edgeRows }) => {
    const s = '/src/store/database.ts', e = '/src/export/index.ts', r = '/src/render/sources.ts';
    const { projectStore } = await import(s), ex = await import(e), { clearSources } = await import(r), stored = await projectStore.read(projectId);
    if (!stored) throw new Error('The export project is missing.');
    const doc = stored.document, size = doc.size, proto = OffscreenCanvasRenderingContext2D.prototype, original = proto.getImageData;
    const readback: ExportObservation['readback'] = { calls: 0, exceptions: [], exportExceptions: [], firstReadStack: '', frames: [], edgeRows: [] };
    const wrapped = function (this: OffscreenCanvasRenderingContext2D, ...args: any[]) {
      const stack = new Error().stack ?? '';
      const exportFrame = stack.includes('/src/export/pipeline.ts') && this.canvas.width === size.width && this.canvas.height === size.height
        && args[0] === 0 && args[1] === 0 && args[2] === size.width && args[3] === size.height;
      let image: ImageData;
      try { image = Reflect.apply(original, this, args); }
      catch (error) {
        const name = (error as { name?: string })?.name ?? 'UnknownError'; readback.exceptions.push(name);
        if (exportFrame) readback.exportExceptions.push(name);
        throw error;
      }
      if (exportFrame) {
        readback.calls++; if (!readback.firstReadStack) readback.firstReadStack = stack;
        const regions = points.map(point => {
          const pixels: number[][] = [], x = Math.floor(point.x), y = Math.floor(point.y);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const offset = ((y + dy) * image.width + x + dx) * 4; pixels.push(Array.from(image.data.subarray(offset, offset + 4)));
          }
          return { label: point.label, pixels };
        });
        readback.frames.push({ index: readback.calls - 1, regions });
        if (readback.calls === 1) readback.edgeRows = edgeRows.map(y => ({ y, rgba: Array.from(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4)) }));
      }
      return image; // The encoder receives the ORIGINAL native readback, never invented or replaced pixels.
    } as typeof original;
    let renderId: string | undefined, observation: Omit<ExportObservation, 'readback' | 'restored'> | undefined;
    proto.getImageData = wrapped;
    try {
      clearSources(); // Export must actually load/rasterise this stored SVG, not inherit a preview's already-made bitmap.
      renderId = ex.startExport({ store: projectStore, doc, projectKey: projectId, title: 'SVG export', resolution: 'original', remux: false, bitrate: 12_000_000 });
      const state = await ex.awaitExport(renderId), reportedStatus = ex.getExportStatus(renderId).status;
      if (state.status !== 'completed') observation = { status: state.status, reportedStatus, error: state.error };
      else {
        const { blob, ...result } = state.result, bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        observation = { status: state.status, reportedStatus, result, bytesBase64: btoa(binary) };
      }
    } finally {
      proto.getImageData = original;
      if (renderId) ex.releaseExport(renderId);
    }
    if (!observation) throw new Error('No export observation was collected.');
    return { ...observation, readback, restored: proto.getImageData === original };
  }, { projectId, points, edgeRows: edges ? [...ICON_ROWS] : [] });
}

function expectReadback(run: ExportObservation, points: readonly SamplePoint[], size: Size) {
  expect(run.status, JSON.stringify(run.error)).toBe('completed'); expect(run.reportedStatus).toBe('completed'); expect(run.restored).toBe(true);
  expect(run.result).toMatchObject({ size, fps: FPS, frames: Math.ceil(DURATION_MS / 1000 * FPS), stats: { path: 'encode' }, notRendered: [] });
  expect(run.readback.calls, 'successful reads made by pipeline.ts itself, not a standalone canvas probe').toBe(run.result!.frames);
  expect(run.readback.firstReadStack).toContain('/src/export/pipeline.ts');
  expect(run.readback.exceptions, 'exception names thrown by the original getImageData').toEqual([]); expect(run.readback.exportExceptions).toEqual([]);
  expect(run.readback.exceptions).not.toContain('SecurityError'); expect(run.readback.frames).toHaveLength(run.result!.frames);
  for (const frame of run.readback.frames) expectRegions(frame.regions, points, PREVIEW_TOLERANCE, `actual export frame ${frame.index} raw readback versus fixture`);
}

/** D34 output-domain expectation comes from each fixed fixture colour, never from preview/capture/current output. */
const encodedPoints = (points: readonly SamplePoint[]): SamplePoint[] => points.map(point => ({ ...point,
  rgba: [outputCode(point.rgba[0]), outputCode(point.rgba[1]), outputCode(point.rgba[2]), 255] }));
function decodedRegions(bytes: Uint8Array, size: Size, points: readonly SamplePoint[]): PixelRegion[] {
  return points.map(point => {
    const pixels: number[][] = [], x = Math.floor(point.x), y = Math.floor(point.y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const offset = ((y + dy) * size.width + x + dx) * 4; pixels.push(Array.from(bytes.subarray(offset, offset + 4)));
    }
    return { label: point.label, pixels };
  });
}
/** Existing T16a helpers are read-only and invoked in the test body only; ffmpeg decodes the actual completed file. */
function expectDecodedOutput(run: ExportObservation, testInfo: TestInfo, points: readonly SamplePoint[], size: Size) {
  expect(run.bytesBase64).toBeTruthy(); const file = testInfo.outputPath('svg-output.mp4'); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(run.bytesBase64!, 'base64'));
  const video = streams(file).find(stream => stream.codec_type === 'video');
  expect(video).toMatchObject({ codec_name: 'h264', width: size.width, height: size.height, pix_fmt: 'yuv420p', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' });
  const frames = decodeRgba(file, size.width, size.height); expect(frames).toHaveLength(run.result!.frames);
  const expected = encodedPoints(points);
  for (const [index, frame] of frames.entries()) {
    expect(frame.length).toBe(size.width * size.height * 4);
    expectRegions(decodedRegions(frame, size, points), expected, EXPORT_TOLERANCE, `decoded MP4 frame ${index} versus fixture + D34 output transfer`);
  }
  return file;
}

for (const fixture of SVG_FIXTURES) for (const mime of MIME_CASES) {
  test(`T25 AC1 AC2 export ${fixture.key} ${mime.label}: actual encode/readback and decoded fixture colours`, async ({ page }, testInfo) => {
    const { projectId, uploaded } = await openAndPlaceSvg(page, fixture, mime.mimeType);
    await expect(previewCanvas(page)).toHaveAttribute('data-exact', 'true'); expectSvgIngest(uploaded, fixture);
    const points = samplesInFrame(fixture), run = await observedExport(page, projectId, points);
    expectReadback(run, points, FRAME_SIZE); expectDecodedOutput(run, testInfo, points, FRAME_SIZE);
  });
}

for (const mime of MIME_CASES) test(`T25 AC3 export icon ${mime.label}: raw 1920px export edge is sharp, 24px-first control fails the bound`, async ({ page }, testInfo) => {
  const { projectId, uploaded } = await openAndPlaceSvg(page, ICON_FIXTURE, mime.mimeType, ICON_FRAME_SIZE);
  await expect(previewCanvas(page)).toHaveAttribute('data-exact', 'true'); expectSvgIngest(uploaded, ICON_FIXTURE);
  const preview = expectSharpEdges(await previewEdgeRows(page), '1920px raw preview'), negative = measureEdges(await lowResolutionIconRows(page));
  for (const row of negative) expect(row.transitionPx, `24px-first control row ${row.y} must violate the <=3px transition bound`).toBeGreaterThan(EDGE_TRANSITION_LIMIT);
  const points = samplesInFrame(ICON_FIXTURE, ICON_FRAME_SIZE), run = await observedExport(page, projectId, points, true);
  expectReadback(run, points, ICON_FRAME_SIZE);
  const rawExport = expectSharpEdges(run.readback.edgeRows, 'actual export pipeline raw readback');
  // The decoded compressed file still has to contain the white icon and black exterior, but is NOT an edge-width oracle.
  expectDecodedOutput(run, testInfo, points, ICON_FRAME_SIZE);
  testInfo.annotations.push({ type: 'icon-edge', description: JSON.stringify({ preview, rawExport, negative, oracle: 'x50=500+/-1px; 10-90% <=3px; rows=320,960,1600' }) });
});

for (const mime of MIME_CASES) test(`T25 AC4 export broken-after-ingest ${mime.label}: completed real export is specified grey, not missing/tainted`, async ({ page }, testInfo) => {
  const { projectId, uploaded } = await openAndPlaceSvg(page, CORE_SVGS[0], mime.mimeType);
  expectSvgIngest(uploaded, CORE_SVGS[0]); await breakPlacedSvg(page, uploaded);
  const canvas = previewCanvas(page); await expect(canvas).toHaveAttribute('data-frame', '0'); await expect(canvas).toHaveAttribute('data-exact', 'false');
  const points = greySamples(), run = await observedExport(page, projectId, points);
  expectReadback(run, points, FRAME_SIZE); expectDecodedOutput(run, testInfo, points, FRAME_SIZE);
});

// D97 export is independent of thumbnail and preview readback assertions, so its own taint remains the first red.
for (const mime of MIME_CASES) test(`T25 D97 foreignObject export ${mime.label}: completed encode/readback and decoded fixture colours`, async ({ page }, testInfo) => {
  const { projectId } = await openAndPlaceSvg(page, FOREIGN_OBJECT_FIXTURE, mime.mimeType);
  const points = samplesInFrame(FOREIGN_OBJECT_FIXTURE), run = await observedExport(page, projectId, points);
  expect({ status: run.status, exceptions: run.readback.exceptions }, JSON.stringify(run.error)).toEqual({ status: 'completed', exceptions: [] });
  expectReadback(run, points, FRAME_SIZE); expectDecodedOutput(run, testInfo, points, FRAME_SIZE);
});
