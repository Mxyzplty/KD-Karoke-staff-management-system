// SPDX-License-Identifier: AGPL-3.0-only
// T16a render correctness in Chromium (ledger L4, L4a, L13 and the A/V offset of L4). Oracles: "formula oracle" = the float CPU
// reference in parity/oracle (renderFrame over the same document, media decoded by ffmpeg, §53) against the exported frames decoded
// by ffmpeg ("ffprobe ground truth" for the file itself): per-frame SSIM >= 0.98 (Rec. 709 luma, 8x8 windows, t10a-support.ssim).
// The A/V rows use clips whose picture and sound carry a known event time (ffmpeg-generated flash + tone burst; S2 from the store).
// A timeline with a video or audio item has an audio track (export/audio.ts AUDIBLE; AAC-LC, or Opus where AAC-LC cannot be encoded);
// the render rows do not assert the audio codec and run on every browser.
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { ffmpegAvailable, media } from '../media-fixtures';
import { skipTour } from './t02-support';
import { ssim } from './t10a-support';
import { quantise8 } from '../../parity/oracle/image';
import { exportPlan, planTime, type Project } from '../../parity/oracle/item';
import { renderFrame } from '../../parity/oracle/render';
import { fixtureSource, oracleDeps } from '../../parity/oracle/frame';
import { completed, decodePcm, decodeRgba, genMedia, hasStore, haveFile, fixture, imageDoc, mkDoc, NO_STORE, rectShape, rms, runExport, setup, S1, videoFrames } from './t16a-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the media, decodes the export and is the oracle\'s decoder');
test.setTimeout(240_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

// ---- media (ffmpeg-made, identical bytes for the page and for the oracle) ---------------------------------------------------------
// Tagged BT.709 limited range: an untagged file is read with BT.601 by ffmpeg (the oracle's decoder) and with BT.709 by Chromium, which
// moves the green channel of saturated colours by ~20 codes (SSIM 0.96) and has nothing to do with the export.
const H264 = ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-crf', '12', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const VIDEO = () => genMedia('t16a-r-video.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', ...H264]);
const PORTRAIT = () => genMedia('t16a-r-portrait.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=90x160:rate=30:duration=2', ...H264]);
const PNG = (name: string, size: string) => genMedia(name, ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=1:duration=1`, '-frames:v', '1', '-update', '1']);
/** A bitstream-tagged BT.709 copy of an untagged store file (same frames and bytes of picture data): ffmpeg reads an untagged file as BT.601, Chromium as BT.709. */
const tag709 = (file: string, name: string) => genMedia(name, ['-i', file, '-map', '0', '-c', 'copy', '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0']);
const PATTERN = () => PNG('t16a-r-pattern.png', '160x90');
const PORTRAIT_PNG = () => PNG('t16a-r-portrait.png', '90x160');
const WHITE = () => genMedia('t16a-r-white.png', ['-f', 'lavfi', '-i', 'color=c=white:s=64x36:r=1:d=1', '-frames:v', '1', '-update', '1']);
const props = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));

// ---- the formula oracle against the export -----------------------------------------------------------------------------------------
const u8 = (a: Uint8ClampedArray) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const luma = (d: Uint8Array | Buffer, i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
/** The oracle's project for an app document: the same document, each clip's source named as fixture://<file> under the files' directory. */
function oracleProject(doc: any, files: Record<string, string>): { project: Project; dir: string } {
  const dirs = new Set(Object.values(files).map(f => path.dirname(f)));
  expect(dirs.size, 'all media of one document live in one directory').toBe(1);
  const project = JSON.parse(JSON.stringify(doc));
  for (const item of project.items) if (files[item.id]) item.details = { ...item.details, src: `fixture://${path.basename(files[item.id])}` };
  return { project, dir: [...dirs][0] };
}
type Rendered = Awaited<ReturnType<typeof renderRow>>;
/** Exports `doc` (media: clip id -> file) and renders the oracle's frame n (the export plan's own frame times) for each sampled n. */
async function renderRow(page: Page, doc: any, files: Record<string, string>, sample: number[] | 'all', opts: Record<string, unknown> = {}) {
  const { id } = await setup(page, doc, files), run = await runExport(page, id, opts), r = completed(run);
  const { width: w, height: h } = doc.size, { project, dir } = oracleProject(doc, files);
  const range = opts.range as { startS: number; endS: number } | undefined, plan = exportPlan(project, range);
  const frames = decodeRgba(run.file!, w, h);
  expect(frames.length, 'frames in the file (§53.8.4)').toBe(plan.count);
  const deps = oracleDeps(fixtureSource(dir)), idx = sample === 'all' ? [...frames.keys()] : sample;
  const scores = idx.map(k => {
    const exp = u8(quantise8(renderFrame(project, planTime(plan, plan.first + k), deps, { width: w, height: h })));
    return { k, exp, ssim: ssim(new Uint8Array(frames[k]), exp, w, h) };
  });
  const min = Math.min(...scores.map(s => s.ssim));
  test.info().annotations.push({ type: 'ssim', description: `min ${min.toFixed(5)} over ${scores.length} frames (${scores.map(s => `${s.k}:${s.ssim.toFixed(4)}`).slice(0, 12).join(' ')}${scores.length > 12 ? ' …' : ''})` });
  return { run, r, frames, scores, plan, project, w, h, min };
}
const expectSsim = (x: Rendered) => expect(x.scores.filter(s => s.ssim < 0.98).map(s => `frame ${s.k}: ${s.ssim.toFixed(4)}`), 'frames below SSIM 0.98').toEqual([]);
/** Mean luma of a rectangle of an RGBA frame. */
const region = (d: Uint8Array | Buffer, w: number, x0: number, y0: number, x1: number, y1: number) => {
  let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += luma(d, (y * w + x) * 4); n++; } return s / n;
};

// ---- L4 / L4a: §53 rows on video and image items -----------------------------------------------------------------------------------
test('L4 video timeline: every one of 90 frames of a 3 s clip is SSIM >= 0.98 against the formula oracle (§53.0, §53.8.4)', async ({ page }) => {
  const doc = mkDoc([{ id: 'v', from: 0, to: 3000, sourceDuration: 3000 }], { fps: 30, size: { width: 320, height: 180 } });
  const x = await renderRow(page, doc, { v: VIDEO() }, 'all');
  expect(x.r.frames).toBe(90); expectSsim(x);
});

test('L4a §53.1.4 box geometry: a 200 x 100 box at (60, 40) with a 16:9 clip drawn cover-fit inside it', async ({ page }) => {
  const doc = mkDoc([{ id: 'v', from: 0, to: 2000, sourceDuration: 3000, properties: props({ width: 200, height: 100, positionX: 60, positionY: 40 }) }], { fps: 30, size: { width: 320, height: 180 } });
  const x = await renderRow(page, doc, { v: VIDEO() }, [0, 15, 30, 59]);
  expectSsim(x);
  expect(region(x.frames[10], 320, 0, 0, 50, 30), 'outside the box is black').toBeLessThan(4);
});

test('L4a §53.2.4 positionX 10.25 + L13 (Q13): the sub-pixel edge is measured, the export is SSIM >= 0.98 (l.162 soft edge: numbers recorded)', async ({ page }) => {
  const doc = mkDoc([{ id: 'i', type: 'image', from: 0, to: 1000, properties: props({ width: 64, height: 36, positionX: 10.25, positionY: 20 }) }], { fps: 30, size: { width: 160, height: 90 } });
  const x = await renderRow(page, doc, { i: WHITE() }, [0, 15, 29]);
  expectSsim(x);
  // L13: the row through the middle of the box, columns around the left edge (x = 10.25) and the right edge (x = 74.25).
  const row = 38, cols = [8, 9, 10, 11, 12, 72, 73, 74, 75, 76], exp = x.scores[1].exp, got = x.frames[15];
  const at = (d: Uint8Array | Buffer, c: number) => Math.round(luma(d, (row * 160 + c) * 4));
  const record = cols.map(c => `x${c}: export ${at(got, c)} oracle ${at(exp, c)}`);
  test.info().annotations.push({ type: 'L13 edge (Q13)', description: record.join('; ') });
  test.info().annotations.push({ type: 'L13 edge max |export - oracle|', description: String(Math.max(...cols.map(c => Math.abs(at(got, c) - at(exp, c))))) });
  expect(at(got, 30), 'inside the box').toBeGreaterThan(230); expect(at(got, 2), 'outside the box').toBeLessThan(20);
});

test('L4a §53.3.5 cover / stretch: a portrait clip cover-fits a 160 x 180 box, a portrait still stretches into a second one', async ({ page }) => {
  const doc = mkDoc([
    { id: 'v', track: 'v1', from: 0, to: 1000, sourceDuration: 2000, properties: props({ width: 160, height: 180, positionX: 0, positionY: 0 }) },
    { id: 'i', track: 'v2', type: 'image', from: 0, to: 1000, properties: props({ width: 160, height: 180, positionX: 160, positionY: 0 }) },
  ], { fps: 30, size: { width: 320, height: 180 } });
  const x = await renderRow(page, doc, { v: PORTRAIT(), i: PORTRAIT_PNG() }, [0, 10, 20, 29]);
  expectSsim(x);
});

test('L4a §53.4.6 border and radius: a 6 px red border and a 24 px corner radius on a still', async ({ page }) => {
  const border = { borderWidth: 6, borderColor: '#ff0000', borderRadius: 24 };
  const doc = mkDoc([{ id: 'i', type: 'image', from: 0, to: 1000, details: border, properties: props({ width: 200, height: 120, positionX: 60, positionY: 30, ...border }) }], { fps: 30, size: { width: 320, height: 180 } });
  const x = await renderRow(page, doc, { i: PATTERN() }, [0, 15, 29]);
  expectSsim(x);
  // The border is there: the middle of the left edge of the box (x 60 ± 3) is red in both.
  const at = (d: Uint8Array | Buffer) => { const i = (90 * 320 + 60) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const [r, g, b] = at(x.frames[15]), [er, eg, eb] = at(x.scores[1].exp);
  expect(Math.abs(r - er) + Math.abs(g - eg) + Math.abs(b - eb), `border pixel ${[r, g, b]} vs oracle ${[er, eg, eb]}`).toBeLessThan(60);
});

test('L4a §53.5.6 track order and the frame 30 to 59 rule: a still on the upper track shows from frame 30 (1000 ms) to the end, over the clip below', async ({ page }) => {
  const doc = mkDoc([
    { id: 'v', track: 'v1', from: 0, to: 2000, sourceDuration: 3000 },
    { id: 'i', track: 'v2', type: 'image', from: 1000, to: 2000, properties: props({ width: 120, height: 60, positionX: 100, positionY: 60 }) },
  ], { fps: 30, size: { width: 320, height: 180 } });
  const x = await renderRow(page, doc, { v: VIDEO(), i: WHITE() }, [0, 28, 29, 30, 31, 45, 59]);
  expectSsim(x);
  const centre = (k: number) => region(x.frames[k], 320, 150, 80, 170, 100);
  expect(centre(29), 'frame 29: the still is not drawn yet').toBeLessThan(235);
  expect(centre(30), 'frame 30: the still is on top').toBeGreaterThan(235);
  expect(centre(59), 'frame 59: the still is still drawn').toBeGreaterThan(235);
});

test('L4a §53.6.3 blend over black: multiply over the black frame stays black, screen at 50 % opacity shows half the still', async ({ page }) => {
  const mode = (m: string) => ({ blendMode: m });
  const doc = mkDoc([
    { id: 'a', track: 'v1', type: 'image', from: 0, to: 1000, details: mode('multiply'), properties: props({ width: 140, height: 80, positionX: 10, positionY: 50, ...mode('multiply') }) },
    { id: 'b', track: 'v2', type: 'image', from: 0, to: 1000, details: mode('screen'), properties: props({ width: 140, height: 80, positionX: 170, positionY: 50, opacity: 0.5, ...mode('screen') }) },
  ], { fps: 30, size: { width: 320, height: 180 } });
  const x = await renderRow(page, doc, { a: PATTERN(), b: PATTERN() }, [0, 15, 29]);
  expectSsim(x);
  expect(region(x.frames[15], 320, 10, 50, 150, 130), 'multiply over black').toBeLessThan(6);
  expect(region(x.frames[15], 320, 170, 50, 310, 130), 'screen at 50 % over black').toBeGreaterThan(20);
});

// ---- §53.8.4 frame counts and the empty region ---------------------------------------------------------------------------------------
test('L4a §53.8.4 frame counts: 10 000 ms at 30 fps = 300, 10 010 ms = 301, 10 000 ms at 29.97 fps = ceil(299.7) = 300 (ffprobe ground truth + formula oracle)', async ({ page }) => {
  const small = { width: 160, height: 90 };
  for (const [ms, fps, expected] of [[10000, 30, 300], [10010, 30, 301], [10000, 29.97, 300]] as const) {
    const doc = imageDoc(ms, fps, small);
    const { id } = await setup(page, doc, { img: PATTERN() });
    const run = await runExport(page, id), r = completed(run), plan = exportPlan(doc as unknown as Project);
    expect({ ms, fps, plan: plan.count, frames: r.frames, packets: videoFrames(run.file!).length }, `${ms} ms at ${fps} fps`).toEqual({ ms, fps, plan: expected, frames: expected, packets: expected });
  }
});

test('L4a §53.8.4 range 1.0 to 2.0 s = frames 30 to 59 (30 frames), and the first exported frame shows timeline time 1000 ms', async ({ page }) => {
  const doc = mkDoc([{ id: 'v', from: 0, to: 3000, sourceDuration: 3000 }], { fps: 30, size: { width: 160, height: 90 } });
  const x = await renderRow(page, doc, { v: VIDEO() }, [0, 1, 15, 29], { range: { startS: 1, endS: 2 } });
  expect(x.plan).toMatchObject({ first: 30, count: 30 }); expect(x.r.frames).toBe(30);
  expectSsim(x);
});

test('L4a §53.8.4 empty region: a gap between two clips is exported as (0, 0, 0)', async ({ page }) => {
  const doc = mkDoc([{ id: 'a', type: 'image', from: 0, to: 500 }, { id: 'b', type: 'image', from: 1500, to: 2000 }], { fps: 30, size: { width: 160, height: 90 } });
  const x = await renderRow(page, doc, { a: PATTERN(), b: PATTERN() }, [5, 24, 40]);
  expectSsim(x);
  // H.264 is lossy, so an exact (0, 0, 0) cannot be asserted on the decoded file: the oracle's black frame is scored by SSIM above,
  // the mean channel value must be below 1 and the largest value is recorded.
  const gap = x.frames[24]; let max = 0, sum = 0; for (let i = 0; i < gap.length; i += 4) { max = Math.max(max, gap[i], gap[i + 1], gap[i + 2]); sum += gap[i] + gap[i + 1] + gap[i + 2]; }
  const mean = sum / (gap.length / 4 * 3);
  test.info().annotations.push({ type: 'gap frame 24', description: `mean channel value ${mean.toFixed(3)}, largest ${max}` });
  expect(mean, 'mean channel value in frame 24 (800 ms, no item)').toBeLessThan(1);
});

// ---- audio timeline ----------------------------------------------------------------------------------------------------------------------
test('L4 audio timeline: a timeline of one tone clip exports black frames (SSIM 1 vs the oracle) and the tone at the source level', async ({ page }) => {
  const tone = media('tone.mp3'), doc = mkDoc([{ id: 'a', type: 'audio', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 30, size: { width: 160, height: 90 } });
  const x = await renderRow(page, doc, { a: tone }, [0, 15, 29]);
  expectSsim(x);
  const out = decodePcm(x.run.file!), src = decodePcm(tone), from = 4800, to = 38400;
  const ro = rms(out.left, from, to), rs = rms(src.left, from, to);
  test.info().annotations.push({ type: 'tone rms', description: `export ${ro.toFixed(4)} source ${rs.toFixed(4)}` });
  expect(rs).toBeGreaterThan(0.01);
  expect(Math.abs(ro / rs - 1), 'tone level 0.1-0.8 s, export vs source').toBeLessThan(0.1);
});

// ---- A/V offset <= 1 frame ---------------------------------------------------------------------------------------------------------------
/** First sample time (s) at or after `fromS` where |x| exceeds `level`, or -1. */
const onset = (x: Float32Array, fromS: number, toS: number, level = 0.1) => { for (let i = Math.floor(fromS * 48000); i < Math.min(x.length, Math.floor(toS * 48000)); i++) if (Math.abs(x[i]) > level) return i / 48000; return -1; };
const FLASH = () => genMedia('t16a-r-flash-tone.mp4', [
  '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2',
  '-vf', "drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable='between(n,30,30)'", '-af', "volume='4*between(t,1,1.1)':eval=frame",
  '-c:v', 'libx264', '-crf', '12', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']);
for (const remux of [false, true]) {
  test(`A/V offset <= 1 frame, ${remux ? 'remux path' : 'encode path'}: the flash (frame 30) and the tone burst (1.0 s) of an ffmpeg clip stay together in the export (ffprobe ground truth)`, async ({ page }) => {
    const src = FLASH(), doc = mkDoc([{ id: 'v', from: 0, to: 2000, sourceDuration: 2000 }], { fps: 30, size: { width: 320, height: 180 } });
    const { id } = await setup(page, doc, { v: src }), run = await runExport(page, id, { remux }), r = completed(run);
    expect(r.stats.path).toBe(remux ? 'remux' : 'encode');
    const flashAt = (f: string) => decodeRgba(f, 320, 180).map((d, k) => ({ k, y: region(d, 320, 0, 0, 320, 180) })).filter(p => p.y > 128).map(p => p.k);
    const flash = flashAt(run.file!), tone = onset(decodePcm(run.file!).left, 0.5, 1.5), base = onset(decodePcm(src).left, 0.5, 1.5);
    test.info().annotations.push({ type: 'A/V', description: `export flash frames ${JSON.stringify(flash)}, tone onset ${tone.toFixed(4)} s (source ${base.toFixed(4)} s)` });
    expect(flash, 'one white frame').toHaveLength(1); expect(Math.abs(flash[0] - 30), 'flash frame vs 30').toBeLessThanOrEqual(1);
    expect(tone, 'a tone burst was found').toBeGreaterThan(0);
    expect(Math.abs(tone - flash[0] / 30), `tone onset ${tone.toFixed(4)} s vs flash ${(flash[0] / 30).toFixed(4)} s`).toBeLessThanOrEqual(1 / 30);
  });
}

test('A/V S2 (store, 1920x1080 frame count + tone burst at every whole second): frame count, frame identity vs the oracle and tone onsets of an encode-path export', async ({ page }) => {
  test.skip(!hasStore, NO_STORE);
  const s2raw = fixture('synthetic', 'S2-framecount-tone-1920x1080-30fps-10s.mp4');
  test.skip(!haveFile(s2raw), 'S2 is not in the fixture store');
  const s2 = tag709(s2raw, 't16a-r-s2-709.mp4'); // BT.709-tagged copy: the store file is untagged (ffmpeg reads BT.601, Chromium BT.709)
  const doc = mkDoc([{ id: 'v', from: 0, to: 3000, sourceDuration: 10000 }], { fps: 30, size: { width: 320, height: 180 } });
  const x = await renderRow(page, doc, { v: s2 }, [0, 30, 60, 89]);
  expect(x.r.frames).toBe(90); expectSsim(x);
  const pcm = decodePcm(x.run.file!).left, onsets = [0, 1, 2].map(s => onset(pcm, s === 0 ? 0 : s - 0.1, s + 0.5));
  test.info().annotations.push({ type: 'S2 tone onsets', description: onsets.map(o => o.toFixed(4)).join(', ') });
  onsets.forEach((o, s) => expect(Math.abs(o - s), `tone burst at ${s} s`).toBeLessThanOrEqual(1 / 30));
});

test('A/V S1 (store, frame-number clip, 1080x1920): the exported frame k shows source frame k (frame identity vs the oracle at 0, 29, 30, 89)', async ({ page }) => {
  test.skip(!hasStore, NO_STORE);
  const s1raw = S1();
  test.skip(!haveFile(s1raw), 'S1 is not in the fixture store');
  const s1 = tag709(s1raw, 't16a-r-s1-709.mp4'); // BT.709-tagged copy: the store file is untagged (ffmpeg reads BT.601, Chromium BT.709)
  const doc = mkDoc([{ id: 'v', from: 0, to: 3000, sourceDuration: 10000 }], { fps: 30, size: { width: 180, height: 320 } });
  const x = await renderRow(page, doc, { v: s1 }, [0, 29, 30, 89]);
  expect(x.r.frames).toBe(90); expectSsim(x);
  // A neighbouring source frame must match worse than frame k itself: the numbers prove the export is not off by one.
  const deps = oracleDeps(fixtureSource(path.dirname(s1))), size = { width: x.w, height: x.h };
  for (const k of [29, 30]) for (const n of [k - 1, k + 1]) {
    const other = ssim(new Uint8Array(x.frames[k]), u8(quantise8(renderFrame(x.project, planTime(x.plan, n), deps, size))), x.w, x.h), own = x.scores.find(s => s.k === k)!.ssim;
    test.info().annotations.push({ type: 'S1 frame identity', description: `export frame ${k}: own ${own.toFixed(4)}, oracle frame ${n} ${other.toFixed(4)}` });
    expect(own, `export frame ${k} against oracle frame ${n}`).toBeGreaterThan(other);
  }
});

// ---- Motion graphics (rebase onto T08: render/mg graphicPicture, purpose 'capture') ------------------------------------------------
// Oracle: "written-spec oracle" = a motion graphic is drawn in its box like any item; one that cannot render fails the export as
// MG_RENDER_FAILED with T08's text naming it (render/mg/frames.ts graphicPicture), it is never dropped from the file.
const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });
const GOOD = "export const G = () => <AbsoluteFill style={{ backgroundColor: '#0000ff' }} />;";
const BROKEN = 'export const G = () => <AbsoluteFill style={{ ;';
const graphicDoc = (name: string, code: string) => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: 1000, fps: 10, size: { width: 320, height: 180 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: [{ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 }], layerOrder: [{ type: 'track', id: 'o1' }],
  items: [{
    id: 'g1', type: 'motionGraphic', trackId: 'o1', display: { from: 0, to: 1000 }, trim: { from: 0, to: 1000 }, sourceDuration: 1000, playbackRate: 1, details: { name, code }, metadata: {}, effects: [], masks: [],
    properties: { positionX: prop(80), positionY: prop(45), width: prop(160), height: prop(90), scale: prop(1) },
  }],
});
test('MG: a working motion graphic is drawn in its box (160 x 90 at 80,45): blue exactly there, the black background everywhere else (pixels of the decoded export)', async ({ page }) => {
  const { id } = await setup(page, graphicDoc('Blue card', GOOD), {});
  const run = await runExport(page, id);
  const r = completed(run);
  expect(r.frames).toBe(10);
  const f = decodeRgba(run.file!, 320, 180)[5], at = (x: number, y: number) => [f[(y * 320 + x) * 4], f[(y * 320 + x) * 4 + 1], f[(y * 320 + x) * 4 + 2]];
  const near = (p: number[], q: number[]) => p.every((v, i) => Math.abs(v - q[i]) <= 24);
  // The box is x 80..239, y 45..134 (position is the box's top-left). Edge pixels may blend with the black through the 4:2:0 chroma, so the
  // samples stay 3 px inside and outside the box edge.
  for (const [x, y] of [[160, 90], [83, 48], [236, 48], [83, 131], [236, 131]]) expect(near(at(x, y), [0, 0, 255]), `inside the box at ${x},${y}: ${at(x, y)}`).toBe(true);
  for (const [x, y] of [[10, 10], [310, 170], [76, 90], [243, 90], [160, 41], [160, 138], [76, 41], [243, 138]]) expect(near(at(x, y), [0, 0, 0]), `outside the box at ${x},${y}: ${at(x, y)}`).toBe(true);
});
// ---- Shapes (rebase onto T06: Draw.kind 'shape', no source, the compositor draws the vector) ------------------------------------------
// Oracle: "written-spec oracle" = render/model.ts ShapeDraw: the path at property time drawn 1:1 in the box (§53.1.2) with its fill; the
// rectangle preset is the corners (0,0) (w,0) (w,h) (0,h) (timeline/shapes.ts presetPoints). The freeze-5 export sent a shape down the
// video path and failed.
test('S3 shape: a T06 rectangle (160 x 90 at 80,45, red fill) is drawn in its box: red exactly there, the black background elsewhere; no shape entry in notRendered (pixels of the decoded export)', async ({ page }) => {
  const doc = graphicDoc('unused', GOOD);
  doc.items = [rectShape('s1', 'o1')] as never;
  const { id } = await setup(page, doc, {});
  const run = await runExport(page, id);
  const r = completed(run);
  expect(r.frames).toBe(10);
  expect(JSON.stringify(r.notRendered ?? []), 'a shape is rendered, not listed as pending').not.toMatch(/shape/i);
  expect(JSON.stringify(r.notRendered ?? [])).not.toMatch(/T06/);
  const f = decodeRgba(run.file!, 320, 180)[5], at = (x: number, y: number) => [f[(y * 320 + x) * 4], f[(y * 320 + x) * 4 + 1], f[(y * 320 + x) * 4 + 2]];
  const near = (p: number[], q: number[]) => p.every((v, i) => Math.abs(v - q[i]) <= 24);
  for (const [x, y] of [[160, 90], [83, 48], [236, 48], [83, 131], [236, 131]]) expect(near(at(x, y), [255, 0, 0]), `inside the box at ${x},${y}: ${at(x, y)}`).toBe(true);
  for (const [x, y] of [[10, 10], [310, 170], [76, 90], [243, 90], [160, 41], [160, 138], [76, 41], [243, 138]]) expect(near(at(x, y), [0, 0, 0]), `outside the box at ${x},${y}: ${at(x, y)}`).toBe(true);
});
test('MG_RENDER_FAILED: a motion graphic with a compile error fails the export, and the detail names the graphic (T08\'s text)', async ({ page }) => {
  const { id } = await setup(page, graphicDoc('Broken card', BROKEN), {});
  const run = await runExport(page, id, {}, undefined, false);
  test.info().annotations.push({ type: 'outcome', description: JSON.stringify({ status: run.status, error: run.error }) });
  expect(run.status, 'the export should have failed').toBe('failed');
  expect(run.error).toMatchObject({ code: 'MG_RENDER_FAILED', category: 'system_error', kind: 'our_bug' });
  expect(run.error!.detail ?? '').toMatch(/Broken card/);
  expect(run.error!.detail ?? '').toMatch(/g1/);
});
