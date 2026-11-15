// SPDX-License-Identifier: AGPL-3.0-only
// T29: TIFF and HEIC image items (decoder 'wasm') draw their picture, upright, in the paused preview, in captureFrame and in the
// export; browser-decoded stills (EXIF-6 JPEG) keep the browser's own orientation. Five subjects go through the real Footage
// upload and addMedia, then transformItem puts each at scale 1, top-left (32, 32), in a 192 × 192 project, so the picture is in
// frame whole and the preview canvas (backing = project size when paused) and the export hold it 1:1.
// Capture: quality 'high' makes a 144 × 144 JPEG (192 × 0.75), so the 32 px origin lands on 24 px and every displayed size here
// (96 × 64, 128 × 128, 64 × 96: all multiples of 4) on whole pixels (72 × 48, 96 × 96, 48 × 72). That cannot be 1:1: the crop is
// scored against the oracle resized to the same size by ffmpeg (bilinear), with the JPEG decoded by ffmpeg, as T14's posters are.
// Oracles: ffmpegImageRgb('heic-single' | 'heic-grid') for HEIC, the untagged pattern.tiff / pattern.jpg for the rest, each put
// through the TIFF/EXIF filter chains of t14-orientation-support (FILTER). The export is decoded by ffmpeg with its own BT.709
// tags (limited to full RGB); the decoded frame is in the export's output domain (D34), so the oracle goes through
// parity/oracle/transfer outputCode first, as T25's export checks do. The raw (untransferred) scores are logged beside it.
// Thresholds are MEASURED FIRST (Author, 14 Nov): every run scores the crop against the right orientation and against every wrong
// orientation of the same size (PSNR over RGB and SSIM as T16a's export checks compute it, t10a-support.ssim), logs all of them
// and writes t29-measurements.json. The constants below are the measured PSNR thresholds, one per path, set in the gap between
// the right score and the closest wrong one (run 1 numbers beside them); SSIM is logged, not asserted.
// A second rotation (the o6 subjects turned again) or the probed orientation applied on top of the browser's (JPEG) gives
// 96 × 64, not the displayed 64 × 96: the bitmap size and the oracle sizes fail it before any pixel is compared (AC4).
// AC5 follows T25 AC4: ingest and place the good file, overwrite only that asset's stored bytes with a truncated copy, clear the
// source caches, reload; preview, capture and export must then draw #374151 and the cache entry must be 'failed'.
import { expect, test, type TestInfo } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { outputCode } from '../../parity/oracle/transfer';
import { ffmpegAvailable, ffmpegImageRgb, media } from '../media-fixtures';
import { skipTour } from './t02-support';
import { reference, taggedJpeg, taggedTiff } from './t14-orientation-support';
import { decodeRgba } from './t16a-support';
import { openSvgProject } from './t25-svg-support';
import {
  breakPlacedImage, captureBox, captureRead, captureSize, crop, exportRead, GREY_RGB, inset, mapBytes, measure, orientations, ORIGIN,
  placeImage, PROJECT, resize, settledPreview, share, summary, uploadImage, type ImageState, type Measured, type Rect, type Rgb,
} from './t29-support';

test.skip(!ffmpegAvailable(), 'ffmpeg generates the media and is the oracle');
test.setTimeout(240_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

// MEASURED (T29 AC2, run 1, 15 Nov, at cdb4ca3, rebased as 602e9e3): each PSNR threshold sits in the gap between the lowest right value and the highest
// same-size wrong value of that run: preview 36.23 / 8.15 dB, capture 22.60 / 8.52, export 27.62 / 7.81. SSIM is logged, not
// asserted (null): PSNR leaves a clean gap on every path (export order: PSNR first). A null metric skips both of its asserts.
type Threshold = { psnr: number | null; ssim: number | null };
const PREVIEW: Threshold = { psnr: 25, ssim: null };
const CAPTURE: Threshold = { psnr: 16, ssim: null };
const EXPORT: Threshold = { psnr: 18, ssim: null };
// MEASURED (run 1): the most a good picture's box may share with the #374151 fill. Good subjects <= 0.015, broken files 1.0.
const GREY_MAX_SHARE = 0.5;
// The failed-image fill, per path: the preview is the exact fill; the capture JPEG and the H.264 export add their own error.
const GREY_TOLERANCE = { preview: 1, capture: 24, export: 32 };

type Subject = { key: string; name: string; mime: string; bytes: Buffer; base: Rgb; orientation: number; wasm: boolean };
const untagged = (file: string): Rgb => { const r = reference(file, 1); return { width: r.width, height: r.height, rgb: r.rgb }; };
const SUBJECTS: { key: string; make: () => Subject }[] = [
  { key: 'pattern.heic', make: () => ({ key: 'pattern.heic', name: 'pattern.heic', mime: 'image/heic', bytes: readFileSync(media('pattern.heic')), base: ffmpegImageRgb('heic-single'), orientation: 1, wasm: true }) },
  { key: 'grid.heic', make: () => ({ key: 'grid.heic', name: 'grid.heic', mime: 'image/heic', bytes: readFileSync(media('grid.heic')), base: ffmpegImageRgb('heic-grid'), orientation: 1, wasm: true }) },
  { key: 'pattern.tiff', make: () => ({ key: 'pattern.tiff', name: 'pattern.tiff', mime: 'image/tiff', bytes: readFileSync(media('pattern.tiff')), base: untagged(media('pattern.tiff')), orientation: 1, wasm: true }) },
  { key: 'o6 TIFF', make: () => ({ key: 'o6 TIFF', name: 'o6.tiff', mime: 'image/tiff', bytes: taggedTiff(6).bytes, base: untagged(media('pattern.tiff')), orientation: 6, wasm: true }) },
  { key: 'o6 JPEG', make: () => ({ key: 'o6 JPEG', name: 'o6.jpg', mime: 'image/jpeg', bytes: taggedJpeg(6), base: untagged(media('pattern.jpg')), orientation: 6, wasm: false }) },
];

const unique = (name: string) => `${randomUUID()}-${name}`;
const fmt = (m: Measured) => summary(m);
const imageDims = (state: ImageState) => typeof state === 'string' ? state : [state.width, state.height];
const bounds = (s: Rgb): Rect => ({ x: ORIGIN.x, y: ORIGIN.y, w: s.width, h: s.height });

// Sizes before scores: a path whose bitmap is not the displayed size is not scored (it would be stretched into the box); it carries sizeMismatch instead.
type PathMeasure = { measured?: Measured; measuredRaw?: Measured; sizeMismatch?: unknown; image: ImageState; greyShare: number; size?: unknown };
function record(testInfo: TestInfo, label: string, data: unknown) {
  testInfo.annotations.push({ type: 't29-measurement', description: `${label} ${JSON.stringify(data)}` });
  console.log(`T29 ${label}: ${JSON.stringify(data)}`);
}

for (const entry of SUBJECTS) test(`T29 AC1 AC2 AC3 AC4 ${entry.key}: upright picture in preview, capture and export, thresholds measured`, async ({ page }, testInfo) => {
  const subject = entry.make(), variants = orientations(subject.base), shown = variants[subject.orientation], box = bounds(shown);
  const sizeOk = (state: ImageState) => typeof state !== 'string' && state.width === shown.width && state.height === shown.height;
  const projectId = await openSvgProject(page, PROJECT);
  const asset = await uploadImage(page, projectId, unique(subject.name), subject.mime, subject.bytes);
  expect(asset.processing_status, JSON.stringify({ code: asset.last_error_code, message: asset.last_error_message })).toBe('ready');
  expect(asset.media?.image).toMatchObject({ width: shown.width, height: shown.height, orientation: subject.orientation });
  if (subject.wasm) expect(asset.media?.decoder).toBe('wasm'); else expect(asset.media?.decoder).not.toBe('wasm');
  const placed = await placeImage(page, asset);
  expect(placed.box, 'the item is at scale 1, top-left (32, 32), at the displayed size').toMatchObject({ x: ORIGIN.x, y: ORIGIN.y, W: shown.width, H: shown.height, sx: 1, sy: 1 });

  // Preview: the paused canvas is project-sized, so the crop is 1:1 with the oracle.
  const previewRead = await settledPreview(page, asset.id, box, 'true');
  const previewCrop = crop(previewRead.rgba, 4, PROJECT.width, box);
  const preview: PathMeasure = { measured: sizeOk(previewRead.image) ? measure(variants, subject.orientation, previewCrop, img => img) : undefined, sizeMismatch: sizeOk(previewRead.image) ? undefined : imageDims(previewRead.image), image: previewRead.image, greyShare: share(previewCrop, GREY_RGB, GREY_TOLERANCE.preview), size: previewRead.canvas };

  // Capture: 144 × 144 JPEG (high); the crop is the box at 0.75, scored against the oracle resized to it.
  const cb = captureBox(box), cs = captureSize();
  const captured = await captureRead(page, asset.id, testInfo.outputPath('t29-capture.jpg'));
  expect(captured.size).toEqual(cs);
  const captureCrop = crop(captured.frame, 3, cs.width, cb);
  const capture: PathMeasure = { measured: sizeOk(captured.image) ? measure(variants, subject.orientation, captureCrop, img => resize(img, cb.w, cb.h)) : undefined, sizeMismatch: sizeOk(captured.image) ? undefined : imageDims(captured.image), image: captured.image, greyShare: share(captureCrop, GREY_RGB, GREY_TOLERANCE.capture), size: captured.size };

  // Export: the decoded first frame (original size, 192 × 192), against the oracle in the export's output domain.
  const exported = await exportRead(page, projectId, asset.id, testInfo.outputPath('t29-export.mp4'));
  expect(exported.result.size).toEqual(PROJECT);
  const frames = decodeRgba(testInfo.outputPath('t29-export.mp4'), PROJECT.width, PROJECT.height); expect(frames).toHaveLength(exported.result.frames);
  const exportCrop = crop(frames[0], 4, PROJECT.width, box);
  const exportPath: PathMeasure = {
    measured: sizeOk(exported.image) ? measure(variants, subject.orientation, exportCrop, img => mapBytes(img, outputCode)) : undefined,
    measuredRaw: sizeOk(exported.image) ? measure(variants, subject.orientation, exportCrop, img => img) : undefined, sizeMismatch: sizeOk(exported.image) ? undefined : imageDims(exported.image),
    image: exported.image, greyShare: share(exportCrop, GREY_RGB.map(outputCode), GREY_TOLERANCE.export), size: exported.result.size,
  };

  const all = { subject: subject.key, displayed: { width: shown.width, height: shown.height }, project: PROJECT, capture: cs, thresholds: { preview: PREVIEW, capture: CAPTURE, export: EXPORT, provisional: true },
    preview, captureResult: capture, export: exportPath };
  writeFileSync(testInfo.outputPath('t29-measurements.json'), JSON.stringify(all, null, 2));
  for (const [label, p] of [['preview', preview], ['capture', capture], ['export', exportPath]] as const) {
    if (!p.measured) { console.log(`T29 ${subject.key} ${label}: not scored, bitmap ${JSON.stringify(p.sizeMismatch)}, displayed ${shown.width}×${shown.height}; grey share ${p.greyShare.toFixed(3)}`); record(testInfo, `${subject.key} ${label}`, { sizeMismatch: p.sizeMismatch, greyShare: p.greyShare }); continue; }
    console.log(`T29 ${subject.key} ${label}: ${fmt(p.measured)}; bitmap ${JSON.stringify(imageDims(p.image))}; grey share ${p.greyShare.toFixed(3)}`);
    record(testInfo, `${subject.key} ${label}`, { right: p.measured.right, wrong: p.measured.wrong, otherSize: p.measured.otherSize, bitmap: imageDims(p.image), greyShare: p.greyShare });
  }
  if (exportPath.measuredRaw) {
    console.log(`T29 ${subject.key} export, oracle without the output transfer: ${fmt(exportPath.measuredRaw)}`);
    record(testInfo, `${subject.key} export untransferred`, { right: exportPath.measuredRaw.right, wrong: exportPath.measuredRaw.wrong });
  }

  // AC3: a bitmap of the displayed size, no failed fill, and the picture clears the threshold the wrong orientations do not.
  for (const [label, p, t] of [['preview', preview, PREVIEW], ['capture', capture, CAPTURE], ['export', exportPath, EXPORT]] as const) {
    expect.soft(sizeOk(p.image), `${subject.key} ${label}: bitmap ${JSON.stringify(imageDims(p.image))}, displayed ${shown.width}×${shown.height}: not scored`).toBe(true);
    expect.soft(p.greyShare, `${subject.key} ${label}: the item's box is not the #374151 fill`).toBeLessThan(GREY_MAX_SHARE);
    if (!p.measured) continue;
    if (t.psnr !== null) {
      expect.soft(p.measured.right.psnr, `${subject.key} ${label}: right orientation PSNR`).toBeGreaterThanOrEqual(t.psnr);
      expect.soft(Math.max(...p.measured.wrong.map(w => w.psnr)), `${subject.key} ${label}: closest wrong orientation PSNR`).toBeLessThan(t.psnr);
    }
    if (t.ssim !== null) {
      expect.soft(p.measured.right.ssim, `${subject.key} ${label}: right orientation SSIM`).toBeGreaterThanOrEqual(t.ssim);
      expect.soft(Math.max(...p.measured.wrong.map(w => w.ssim)), `${subject.key} ${label}: closest wrong orientation SSIM`).toBeLessThan(t.ssim);
    }
  }
  expect.soft(preview.measured?.size, 'preview crop is the displayed size').toEqual({ width: shown.width, height: shown.height });
  expect.soft(preview.size, 'paused preview backing = project size').toEqual(PROJECT);
  // AC4: the static size assert below only documents the sizes; the real guard is the bitmap-size check in AC3 above.
  // A second rotation (o6 on top of o6), or the probed orientation on top of the browser's, is 96 × 64: another size, so it fails.
  if (subject.orientation === 6) {
    const again = { width: shown.height, height: shown.width };
    expect(again, 'a second rotation changes the size').not.toEqual({ width: shown.width, height: shown.height });
    for (const p of [preview, capture, exportPath]) expect.soft(imageDims(p.image), 'the bitmap is not the twice-rotated size').not.toEqual([again.width, again.height]);
  }
});

const BROKEN: { key: string; file: string; mime: string }[] = [
  { key: 'TIFF', file: 'pattern.tiff', mime: 'image/tiff' },
  { key: 'HEIC', file: 'pattern.heic', mime: 'image/heic' },
];
// A copy cut to its first 64 bytes: the file signature stays (TIFF header, HEIC ftyp), what the decoder needs after it is gone. For the HEIC that includes the meta box, so the parse stops before any HEVC decode (review round 2, R2-1; notes, Unspecified).
const TRUNCATED_BYTES = 64;
for (const entry of BROKEN) test(`T29 AC5 broken ${entry.key}: still the #374151 fill in preview, capture and export`, async ({ page }, testInfo) => {
  const bytes = readFileSync(media(entry.file)), shown = entry.file.endsWith('heic') ? ffmpegImageRgb('heic-single') : untagged(media(entry.file)), box = bounds(shown);
  const projectId = await openSvgProject(page, PROJECT);
  const asset = await uploadImage(page, projectId, unique(entry.file), entry.mime, bytes);
  expect(asset.processing_status, JSON.stringify({ code: asset.last_error_code, message: asset.last_error_message })).toBe('ready');
  expect(asset.media?.decoder).toBe('wasm');
  await placeImage(page, asset);
  const good = await settledPreview(page, asset.id, box, 'true');
  expect(imageDims(good.image), 'the good file decoded before it was broken').toEqual([shown.width, shown.height]);
  await breakPlacedImage(page, asset.id, bytes.subarray(0, TRUNCATED_BYTES));

  const preview = await settledPreview(page, asset.id, box, 'false'), previewCrop = crop(preview.rgba, 4, PROJECT.width, inset(box, 2));
  const cb = captureBox(box), captured = await captureRead(page, asset.id, testInfo.outputPath('t29-capture-broken.jpg')), captureCrop = crop(captured.frame, 3, captureSize().width, inset(cb, 2));
  const exported = await exportRead(page, projectId, asset.id, testInfo.outputPath('t29-export-broken.mp4'));
  const frames = decodeRgba(testInfo.outputPath('t29-export-broken.mp4'), PROJECT.width, PROJECT.height), exportCrop = crop(frames[0], 4, PROJECT.width, inset(box, 2));
  const result = {
    preview: { image: preview.image, grey: share(previewCrop, GREY_RGB, GREY_TOLERANCE.preview) },
    capture: { image: captured.image, grey: share(captureCrop, GREY_RGB, GREY_TOLERANCE.capture) },
    export: { image: exported.image, grey: share(exportCrop, GREY_RGB.map(outputCode), GREY_TOLERANCE.export) },
  };
  record(testInfo, `broken ${entry.key}`, result);
  expect.soft(preview.exact, 'the preview of a failed image is not exact').toBe('false');
  for (const [label, r] of Object.entries(result)) {
    expect.soft(r.image, `${label}: readyImage()`).toBe('failed');
    expect.soft(r.grey, `${label}: share of the box inside its 2 px border that is #374151`).toBe(1);
  }
});
