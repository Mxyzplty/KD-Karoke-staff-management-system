// SPDX-License-Identifier: AGPL-3.0-only
// Original, inline-only SVG fixtures and real-UI helpers. No media generation or process starts at module import.
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Asset, ProjectDocument, RecordData } from '../../apps/web/src/store/model';
import { createProject } from './t02-support';

export type Size = { width: number; height: number };
export type Rgba = readonly [number, number, number, number];
export type FixtureSample = { label: string; u: number; v: number; rgba: Rgba };
export type SamplePoint = { label: string; x: number; y: number; rgba: Rgba };
export type PixelRegion = { label: string; pixels: number[][] };
export type SvgFixture = { key: string; svg: string; storedSize: Size | null; rasterSize: Size | null; samples: readonly FixtureSample[] };
export type SvgMime = 'image/svg+xml' | '';

// Root geometry distinguishes a square path, wide rounded rect, tall evenodd hole, and a nonzero viewBox origin.
// Primary/secondary endpoint colours stay unchanged by the export's sRGB -> BT.709 transfer. Every sample is flat,
// well away from shape boundaries (except the separate, analytically specified icon-edge measurement).
export const SQUARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><path d="M64 64H448V448H64Z" fill="#ff0000" stroke="#00ff00" stroke-width="32"/></svg>';
export const WIDE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="240" viewBox="0 0 720 240"><rect x="60" y="40" width="600" height="160" rx="48" fill="#0000ff" stroke="#ffff00" stroke-width="48"/></svg>';
export const TALL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="540" height="1080" viewBox="0 0 540 1080"><path d="M60 60H480V1020H60Z M180 360H360V720H180Z" fill="#00ffff" fill-rule="evenodd"/><rect x="225" y="840" width="90" height="90" fill="#ff00ff"/></svg>';
export const OFFSET_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="476" height="376" viewBox="40 20 476 376"><rect x="80" y="60" width="360" height="280" fill="#ffff00"/><path d="M180 140H340V260H180Z" fill="#0000ff"/></svg>';
export const VIEWBOX_ONLY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect x="40" y="40" width="320" height="320" fill="#ff00ff"/></svg>';
export const NO_VIEWBOX_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect x="20" y="20" width="280" height="120" fill="#00ffff"/></svg>';
export const NO_SIZE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ff0000"/><rect x="25%" y="25%" width="50%" height="50%" fill="#00ff00"/></svg>';
export const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect x="6.25" y="2" width="15.75" height="20" fill="#ffffff"/></svg>';
export const BROKEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><path d="M64 64H448V448H64Z" fill="#ff0000"></svg>';

const transparent: Rgba = [0, 0, 0, 0];
export const CORE_SVGS: readonly SvgFixture[] = [
  { key: 'square', svg: SQUARE_SVG, storedSize: { width: 512, height: 512 }, rasterSize: { width: 2048, height: 2048 }, samples: [
    { label: 'red path fill', u: 0.5, v: 0.5, rgba: [255, 0, 0, 255] },
    { label: 'green path stroke', u: 64 / 512, v: 0.5, rgba: [0, 255, 0, 255] },
    { label: 'transparent margin', u: 20 / 512, v: 0.5, rgba: transparent },
  ] },
  { key: 'wide', svg: WIDE_SVG, storedSize: { width: 720, height: 240 }, rasterSize: { width: 2049, height: 683 }, samples: [
    { label: 'blue rounded-rect fill', u: 0.5, v: 0.5, rgba: [0, 0, 255, 255] },
    { label: 'yellow rounded-rect stroke', u: 60 / 720, v: 0.5, rgba: [255, 255, 0, 255] },
    { label: 'transparent margin', u: 12 / 720, v: 0.5, rgba: transparent },
  ] },
  { key: 'tall', svg: TALL_SVG, storedSize: { width: 540, height: 1080 }, rasterSize: { width: 1024, height: 2048 }, samples: [
    { label: 'cyan evenodd fill', u: 100 / 540, v: 200 / 1080, rgba: [0, 255, 255, 255] },
    { label: 'evenodd transparent hole', u: 0.5, v: 0.5, rgba: transparent },
    { label: 'magenta separate rect', u: 0.5, v: 885 / 1080, rgba: [255, 0, 255, 255] },
    { label: 'transparent margin', u: 20 / 540, v: 0.5, rgba: transparent },
  ] },
  { key: 'offset', svg: OFFSET_SVG, storedSize: { width: 476, height: 376 }, rasterSize: { width: 2142, height: 1692 }, samples: [
    { label: 'yellow rect after viewBox-origin subtraction', u: 70 / 476, v: 90 / 376, rgba: [255, 255, 0, 255] },
    { label: 'blue path after viewBox-origin subtraction', u: 220 / 476, v: 180 / 376, rgba: [0, 0, 255, 255] },
    { label: 'right side of yellow rect', u: 370 / 476, v: 180 / 376, rgba: [255, 255, 0, 255] },
    { label: 'transparent margin', u: 10 / 476, v: 188 / 376, rgba: transparent },
  ] },
];

// Intrinsic sizes are pinned to the approved one-time Chromium stored-size observation, not Node's SVG header probe.
// A viewBox-only 400-square SVG stores as 150 x 150; raster expectations follow the accepted exact-ratio rule.
export const EXTRA_SVGS: readonly SvgFixture[] = [
  { key: 'viewbox-only', svg: VIEWBOX_ONLY_SVG, storedSize: { width: 150, height: 150 }, rasterSize: { width: 2048, height: 2048 }, samples: [
    { label: 'magenta viewBox fill', u: 0.5, v: 0.5, rgba: [255, 0, 255, 255] },
    { label: 'transparent viewBox margin', u: 0.04, v: 0.5, rgba: transparent },
  ] },
  { key: 'no-viewbox', svg: NO_VIEWBOX_SVG, storedSize: { width: 320, height: 160 }, rasterSize: { width: 2048, height: 1024 }, samples: [
    { label: 'cyan rect without viewBox', u: 0.5, v: 0.5, rgba: [0, 255, 255, 255] },
    { label: 'transparent margin without viewBox', u: 0.02, v: 0.5, rgba: transparent },
  ] },
  { key: 'no-size', svg: NO_SIZE_SVG, storedSize: { width: 300, height: 150 }, rasterSize: { width: 2048, height: 1024 }, samples: [
    { label: 'green percentage rect', u: 0.5, v: 0.5, rgba: [0, 255, 0, 255] },
    { label: 'red percentage background', u: 0.1, v: 0.5, rgba: [255, 0, 0, 255] },
  ] },
  { key: 'icon', svg: ICON_SVG, storedSize: { width: 24, height: 24 }, rasterSize: { width: 2048, height: 2048 }, samples: [
    { label: 'opaque white icon interior', u: 0.5, v: 0.5, rgba: [255, 255, 255, 255] },
    { label: 'transparent icon exterior', u: 2 / 24, v: 0.5, rgba: transparent },
  ] },
];
export const SVG_FIXTURES: readonly SvgFixture[] = [...CORE_SVGS, ...EXTRA_SVGS];
export const ICON_FIXTURE = EXTRA_SVGS[3];
export const BROKEN_FIXTURE: SvgFixture = { key: 'broken', svg: BROKEN_SVG, storedSize: null, rasterSize: null, samples: [] };
export const MIME_CASES = [{ label: 'typed', mimeType: 'image/svg+xml' }, { label: 'untyped', mimeType: '' }] as const;
export const FRAME_SIZE: Size = { width: 320, height: 320 };
export const ICON_FRAME_SIZE: Size = { width: 1920, height: 1920 };
export const FPS = 12, DURATION_MS = 250;
export const PREVIEW_TOLERANCE = 1;
// Compare to each fixture's independently specified flat colour, never to a screenshot or to each other.
export const CAPTURE_TOLERANCE = 24; // captureFrame JPEG Q0.92: one JPEG encode/decode.
export const EXPORT_TOLERANCE = 32; // actual MP4: I420 BT.709, H.264 4:2:0 and decoder roundtrip.
export const GREY: Rgba = [55, 65, 81, 255]; // #374151, the specified failed-image fill.

export function intrinsicSize(fixture: SvgFixture): Size {
  if (!fixture.storedSize) throw new Error(`T25 BLOCKED: approved intrinsic-size observation still required for ${fixture.key}.`);
  return fixture.storedSize;
}
export function bitmapSize(fixture: SvgFixture): Size {
  if (!fixture.rasterSize) throw new Error(`T25 BLOCKED: approved intrinsic/raster-size expectation still required for ${fixture.key}.`);
  return fixture.rasterSize;
}
export function svgDocument(size: Size = FRAME_SIZE): ProjectDocument {
  return { schemaVersion: 4, rev: 0, groups: {}, duration: DURATION_MS, fps: FPS, size, background: { type: 'color', value: 'transparent' },
    transitions: [], markers: [], tracks: [{ id: 'v1', name: 'V1', kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1 }],
    layerOrder: [{ type: 'track', id: 'v1' }], items: [] };
}
export async function openSvgProject(page: Page, size: Size = FRAME_SIZE): Promise<string> {
  // Keep the actual Footage -> Uploads panel mounted, including when a caller's default viewport is compact.
  await page.setViewportSize({ width: 1280, height: 900 });
  const id = await createProject(page, svgDocument(size), 'SVG rendering');
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return id;
}

type PickedFile = { name: string; type: string; size: number };
export type UploadedSvg = { asset: Asset; incoming?: PickedFile; stored: { name: string; type: string; size: number; text: string }; posterBytes: number; linked: boolean };
/** The actual Footage input (media-panel.tsx) drives add -> uploadToProject -> probe/preparation; no fabricated ready row. */
export async function uploadSvg(page: Page, projectId: string, fixture: SvgFixture, mimeType: SvgMime, status: 'ready' | 'failed' = 'ready'): Promise<UploadedSvg> {
  const name = `${fixture.key}-${mimeType ? 'typed' : 'untyped'}-${randomUUID()}.svg`, bytes = Buffer.from(fixture.svg, 'utf8');
  const input = page.getByLabel('Upload footage to this project', { exact: true });
  if (mimeType === '') {
    // Approved seam: Playwright 1.64.1 coreBundle.js:20921 fills an empty MIME from the .svg filename. Restore only
    // the input File, synchronously before React's normal change handler, with the exact original UTF-8 byte buffer.
    await input.evaluate((element, base64) => {
      const input = element as HTMLInputElement, w = window as unknown as { __t25Picked?: PickedFile };
      const exactBytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      w.__t25Picked = undefined;
      input.addEventListener('change', () => {
        const original = input.files?.[0]; if (!original) return;
        const transfer = new DataTransfer();
        transfer.items.add(new File([exactBytes], original.name, { type: '', lastModified: original.lastModified }));
        input.files = transfer.files;
      }, { once: true, capture: true });
      // A separate, later listener observes the actual replacement File, not the intended payload. Target bubble
      // phase follows target capture phase and still precedes React's delegated upload handler clearing the input.
      input.addEventListener('change', () => {
        const file = input.files?.[0]; if (file) w.__t25Picked = { name: file.name, type: file.type, size: file.size };
      }, { once: true, capture: false });
    }, bytes.toString('base64'));
    await input.setInputFiles({ name, mimeType: '', buffer: bytes });
  } else {
    // Typed uploads use plain setInputFiles: no replacement listener and no observation/recording listener.
    await input.setInputFiles({ name, mimeType: 'image/svg+xml', buffer: bytes });
  }
  await expect.poll(() => page.evaluate(async name => {
    const p = '/src/store/database.ts', { projectStore } = await import(p);
    return (await projectStore.library()).assets.some((asset: Asset) => asset.originalName === name);
  }, name), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(async name => {
    const p = '/src/store/database.ts', { projectStore } = await import(p);
    return (await projectStore.library()).assets.find((asset: Asset) => asset.originalName === name)?.processing_status;
  }, name), { timeout: 90_000 }).toMatch(/^(ready|failed)$/);
  await expect.poll(() => page.evaluate(async ({ name, projectId }) => {
    const p = '/src/store/database.ts', { projectStore } = await import(p), asset = (await projectStore.library()).assets.find((a: Asset) => a.originalName === name);
    return !!asset && (await projectStore.projectAssets(projectId)).some((link: { assetId: string }) => link.assetId === asset.id);
  }, { name, projectId }), { timeout: 15_000 }).toBe(true);
  const uploaded = await page.evaluate(async ({ name, projectId, observeIncoming }) => {
    const p = '/src/store/database.ts', { projectStore } = await import(p), asset: Asset = (await projectStore.library()).assets.find((a: Asset) => a.originalName === name);
    const blob = await projectStore.media.read(asset.id), thumbnail = await projectStore.row('thumbnails', asset.id);
    return { asset, ...(observeIncoming ? { incoming: (window as unknown as { __t25Picked?: PickedFile }).__t25Picked } : {}),
      stored: { name: (blob as File).name, type: blob.type, size: blob.size, text: await blob.text() }, posterBytes: thumbnail?.poster?.size ?? 0,
      linked: (await projectStore.projectAssets(projectId)).some((link: { assetId: string }) => link.assetId === asset.id) } as UploadedSvg;
  }, { name, projectId, observeIncoming: mimeType === '' });
  if (mimeType === '') expect(uploaded.incoming).toEqual({ name, type: '', size: bytes.length });
  else expect(uploaded).not.toHaveProperty('incoming'); // Do not manufacture a typed-case observation from its payload.
  expect(uploaded.asset.processing_status, JSON.stringify({ code: uploaded.asset.last_error_code, message: uploaded.asset.last_error_message })).toBe(status);
  expect(uploaded.stored).toEqual({ name: uploaded.asset.id, type: '', size: bytes.length, text: fixture.svg });
  expect(uploaded.asset.id).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i); expect(uploaded.stored.name).not.toContain('.');
  expect(uploaded.linked).toBe(true);
  return uploaded;
}
export function expectSvgIngest(uploaded: UploadedSvg, fixture: SvgFixture) {
  const size = intrinsicSize(fixture);
  expect(uploaded.asset.media?.container).toBe('svg+xml'); expect(uploaded.asset.media?.image).toMatchObject(size);
  expect(uploaded.asset.processing_steps).toMatchObject({ upload: 'complete', probe: 'complete', thumbnails: 'complete' });
  expect(uploaded.posterBytes, 'real SVG poster was prepared').toBeGreaterThan(0);
}
/** Reloading indexes the freshly prepared real asset, then addMedia places it through the ordinary command bus. */
export async function placeUploadedSvg(page: Page, uploaded: UploadedSvg): Promise<RecordData> {
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect.poll(() => page.evaluate(async id => {
    const p = '/src/timeline/runtime.ts', { activeRuntime } = await import(p); return activeRuntime?.assets.get(id)?.processing_status;
  }, uploaded.asset.id)).toBe(uploaded.asset.processing_status);
  const placed = await page.evaluate(async ({ assetId, duration }) => {
    const r = '/src/timeline/runtime.ts', e = '/src/editor.tsx', { activeRuntime } = await import(r), { activeSession } = await import(e);
    const result = activeRuntime.call('addMedia', { assetId, trackId: 'v1', timelineStart: 0, duration: duration / 1000 });
    await activeSession.flush();
    return { result, state: activeSession.state, item: activeSession.document.items.find((item: RecordData) => item.metadata?.assetId === assetId) };
  }, { assetId: uploaded.asset.id, duration: DURATION_MS });
  expect(placed.result.success, JSON.stringify(placed.result)).toBe(true); expect(placed.state).toBe('saved');
  expect(placed.item).toMatchObject({ type: 'image', metadata: { assetId: uploaded.asset.id }, display: { from: 0, to: DURATION_MS } });
  return placed.item;
}
export async function openAndPlaceSvg(page: Page, fixture: SvgFixture, mimeType: SvgMime, size: Size = FRAME_SIZE) {
  const projectId = await openSvgProject(page, size), uploaded = await uploadSvg(page, projectId, fixture, mimeType), item = await placeUploadedSvg(page, uploaded);
  return { projectId, uploaded, item };
}
export const previewCanvas = (page: Page) => page.locator('canvas.run[data-run="0"]');

/** Independently map fixture coordinates through addMedia's stated contain/centre placement, not through current pixels. */
export function samplesInFrame(fixture: SvgFixture, frame: Size = FRAME_SIZE): SamplePoint[] {
  const size = intrinsicSize(fixture), scale = Math.min(frame.width / size.width, frame.height / size.height), w = size.width * scale, h = size.height * scale;
  return fixture.samples.map(sample => ({ label: sample.label, x: (frame.width - w) / 2 + sample.u * w, y: (frame.height - h) / 2 + sample.v * h,
    rgba: sample.rgba[3] === 0 ? [0, 0, 0, 255] : sample.rgba }));
}
export const greySamples = (size: Size = FRAME_SIZE): SamplePoint[] => [0.25, 0.5, 0.75].map(fraction => ({ label: `grey interior ${fraction}`, x: size.width * fraction, y: size.height * fraction, rgba: GREY }));
export function expectRegions(regions: readonly PixelRegion[], points: readonly SamplePoint[], tolerance: number, label: string) {
  expect(regions.map(region => region.label)).toEqual(points.map(point => point.label));
  for (const [index, region] of regions.entries()) {
    expect(region.pixels, `${label}: ${region.label} has a 3 x 3 flat sample region`).toHaveLength(9);
    for (const [pixelIndex, pixel] of region.pixels.entries()) for (let channel = 0; channel < 4; channel++) {
      expect(Math.abs(pixel[channel] - points[index].rgba[channel]), `${label}: ${region.label}, sample ${pixelIndex}, channel ${channel}, got ${pixel[channel]}, fixture ${points[index].rgba[channel]}`)
        .toBeLessThanOrEqual(channel === 3 ? 0 : tolerance);
    }
  }
}
/** Read the actual preview run composited over its black stage background, without screenshots/resampling. */
export const previewRegions = (page: Page, points: readonly SamplePoint[]) => page.evaluate(points => {
  const source = document.querySelector<HTMLCanvasElement>('canvas.run[data-run="0"]')!, canvas = new OffscreenCanvas(source.width, source.height), ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0);
  return points.map(point => {
    const bytes = ctx.getImageData(Math.floor(point.x) - 1, Math.floor(point.y) - 1, 3, 3).data, pixels = [];
    for (let offset = 0; offset < bytes.length; offset += 4) pixels.push(Array.from(bytes.subarray(offset, offset + 4)));
    return { label: point.label, pixels };
  });
}, points);

/** Real captureFrame high-quality JPEG, independently decoded and sampled at the fixture's own known regions. */
export const captureRegions = (page: Page, points: readonly SamplePoint[]) => page.evaluate(async points => {
  const c = '/src/render/capture.ts', s = '/src/store/database.ts', e = '/src/editor.tsx';
  const { captureFrame } = await import(c), { projectStore } = await import(s), { activeSession } = await import(e);
  const assets: Asset[] = (await projectStore.library()).assets, doc: ProjectDocument = activeSession.document;
  const result = await captureFrame({ store: projectStore, doc, asset: (id: string) => assets.find(asset => asset.id === id), playheadMs: 0 }, { timestamps: [0], quality: 'high' });
  const images = (result.content ?? []).filter((block: { type: string }) => block.type === 'image'), image = images[0];
  if (!result.success || images.length !== 1 || image.mimeType !== 'image/jpeg') return { success: result.success, result, imageCount: images.length, regions: [], size: null, magic: [] };
  const bytes = Uint8Array.from(atob(image.base64), character => character.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0);
    const regions = points.map(point => {
      const x = Math.floor(point.x * bitmap.width / doc.size.width), y = Math.floor(point.y * bitmap.height / doc.size.height), data = ctx.getImageData(x - 1, y - 1, 3, 3).data, pixels = [];
      for (let offset = 0; offset < data.length; offset += 4) pixels.push(Array.from(data.subarray(offset, offset + 4)));
      return { label: point.label, pixels };
    });
    return { success: result.success, imageCount: images.length, size: { width: bitmap.width, height: bitmap.height }, magic: Array.from(bytes.subarray(0, 3)),
      metadata: JSON.parse(result.content[0].text), regions };
  } finally { bitmap.close(); }
}, points);

/** The only allowed broken-timeline route: prepare/place valid bytes first, then overwrite that asset's OPFS bytes only. */
export async function breakPlacedSvg(page: Page, uploaded: UploadedSvg) {
  await expect(previewCanvas(page)).toHaveAttribute('data-exact', 'true');
  const facts = await page.evaluate(async ({ assetId, text }) => {
    const s = '/src/store/database.ts', r = '/src/render/sources.ts', { projectStore } = await import(s), { clearSources, readyImage } = await import(r);
    const before = JSON.stringify(await projectStore.row('assets', assetId));
    await projectStore.media.write(assetId, new Blob([text], { type: 'image/svg+xml' })); clearSources();
    const after = JSON.stringify(await projectStore.row('assets', assetId)), blob = await projectStore.media.read(assetId);
    return { sameRow: before === after, type: blob.type, text: await blob.text(), cacheEmpty: readyImage({ metadata: { assetId } }) === undefined };
  }, { assetId: uploaded.asset.id, text: BROKEN_SVG });
  expect(facts).toEqual({ sameRow: true, type: '', text: BROKEN_SVG, cacheEmpty: true });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('Saved locally');
}

// AC3 is specified before any observation: x = 6.25 * (1920 / 24) = 500 output px; rows are safely inside y=160..1760.
export const ICON_ROWS = [320, 960, 1600] as const;
export const EDGE_X50 = 500, EDGE_POSITION_TOLERANCE = 1, EDGE_TRANSITION_LIMIT = 3;
export type EdgeRow = { y: number; rgba: number[] };
export function measureEdges(rows: readonly EdgeRow[]) {
  return rows.map(row => {
    const values = Array.from({ length: row.rgba.length / 4 }, (_, x) => {
      const index = x * 4, alpha = row.rgba[index + 3] / 255;
      return alpha * (0.2126 * row.rgba[index] + 0.7152 * row.rgba[index + 1] + 0.0722 * row.rgba[index + 2]);
    });
    const crossing = (fraction: number) => {
      const target = 255 * fraction;
      for (let x = 350; x < 650; x++) if (values[x] < target && values[x + 1] >= target) return x + 0.5 + (target - values[x]) / (values[x + 1] - values[x]);
      throw new Error(`No ${fraction * 100}% rising icon edge on row ${row.y}.`);
    };
    const x10 = crossing(0.1), x50 = crossing(0.5), x90 = crossing(0.9);
    return { y: row.y, x10, x50, x90, transitionPx: x90 - x10 };
  });
}
export function expectSharpEdges(rows: readonly EdgeRow[], label: string) {
  const measurements = measureEdges(rows); expect(measurements.map(row => row.y)).toEqual([...ICON_ROWS]);
  for (const row of measurements) {
    expect(Math.abs(row.x50 - EDGE_X50), `${label}: row ${row.y}, 50% luminance edge ${row.x50}`).toBeLessThanOrEqual(EDGE_POSITION_TOLERANCE);
    expect(row.transitionPx, `${label}: row ${row.y}, 10-90% transition`).toBeLessThanOrEqual(EDGE_TRANSITION_LIMIT);
  }
  return measurements;
}
export const previewEdgeRows = (page: Page) => page.evaluate(rows => {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.run[data-run="0"]')!, ctx = canvas.getContext('2d')!;
  return rows.map(y => ({ y, rgba: Array.from(ctx.getImageData(0, y, canvas.width, 1).data) }));
}, [...ICON_ROWS]);
/** Negative control intentionally rasterises at 24 px first, then smooth-scales that bitmap. No production source is patched. */
export const lowResolutionIconRows = (page: Page) => page.evaluate(async ({ svg, rows }) => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); let bitmap: ImageBitmap | undefined;
  try {
    const image = new Image(); image.src = url; await image.decode();
    const small = new OffscreenCanvas(24, 24); small.getContext('2d')!.drawImage(image, 0, 0, 24, 24); bitmap = await createImageBitmap(small);
    const large = new OffscreenCanvas(1920, 1920), ctx = large.getContext('2d')!; ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, 1920, 1920);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; ctx.drawImage(bitmap, 0, 0, 1920, 1920);
    return rows.map(y => ({ y, rgba: Array.from(ctx.getImageData(0, y, 1920, 1).data) }));
  } finally { bitmap?.close(); URL.revokeObjectURL(url); }
}, { svg: ICON_SVG, rows: [...ICON_ROWS] });
