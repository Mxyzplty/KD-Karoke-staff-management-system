// SPDX-License-Identifier: AGPL-3.0-only
// T07 layouts: preview pixels and export (tickets T07 render and export rows; findings §20, §53 cells). Oracle = the formula oracle in
// parity/oracle (renderFrame over the same document, media decoded by ffmpeg) with the Xapp-parity switches of the oracle's own formulas
// (cell speed 1 and Fill mode only, so the default LAYOUT_PARITY and the oracle agree). SSIM >= 0.98 (t10a-support.ssim). The export rows
// decode the file with ffmpeg (t16a-support.decodeRgba) and compare the same frames; preview = export on the same frames.
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { ffmpegAvailable } from '../media-fixtures';
import { createProject, skipTour } from './t02-support';
import { ssim } from './t10a-support';
import { quantise8 } from '../../parity/oracle/image';
import { exportPlan, planTime } from '../../parity/oracle/item';
import { renderFrame } from '../../parity/oracle/render';
import { fixtureSource, oracleDeps } from '../../parity/oracle/frame';
import { LAYOUT_TYPES, type LayoutType } from '../../apps/web/src/timeline/layouts';
import { completed, decodeRgba, genMedia, mimeOf, openAndIngest, runExport } from './t16a-support';
import { seekMs, shown, uploadAsset } from './t15-support';
import { seedLayout } from './t07-support';
import { readFileSync } from 'node:fs';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the media, decodes the export and is the oracle\'s decoder');
test.setTimeout(300_000);
test.beforeEach(async ({ page }) => { await skipTour(page); await page.setViewportSize({ width: 1400, height: 900 }); });

// ---- media: three tagged BT.709 clips with different hues and one still (tagging as in t16a-render: ffmpeg and Chromium then agree) ----
const TAG = ['-c:v', 'libx264', '-crf', '12', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const clip = (hue: number) => genMedia(`t07-hue${hue}.mp4`, ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=2', '-vf', `hue=h=${hue},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`, ...TAG]);
const STILL = () => genMedia('t07-still.png', ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1:duration=1', '-frames:v', '1', '-update', '1']);
/** Cell k of every layout shows FILES[k % 4]: three videos, then the still. */
const FILES = () => [clip(0), clip(100), clip(220), STILL()];
const SIZE = { width: 320, height: 180 };
const SLOT = 1000;   // each layout lasts 1 s, one after the other on one track

type Look = { gap?: number; borderRadius?: number; empty?: number[]; pick?: Record<number, number>; cell?: Record<number, Record<string, unknown>> };   // pick: cell -> FILES index; cell: extra stored fields per cell
function layoutDoc(types: LayoutType[], look: Look = {}) {
  const track = { id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 };
  return {
    schemaVersion: 4, rev: 0, groups: {}, duration: types.length * SLOT, fps: 30, size: SIZE, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks: [track], layerOrder: [{ type: 'track', id: 'o1' }],
    items: types.map((t, k) => seedLayout(`L${k}`, t, { trackId: 'o1', from: k * SLOT, to: (k + 1) * SLOT, ...SIZE, details: { ...(look.gap ? { gap: look.gap } : {}), ...(look.borderRadius ? { borderRadius: look.borderRadius } : {}) } })),
  };
}
/** Uploads the four files, fills every cell (except look.empty) the way the picker stores it, opens the editor and waits for ingest. */
async function open(page: Page, types: LayoutType[], look: Look = {}) {
  const pick = look.pick ?? {}, cellProps = look.cell ?? {};
  const doc = layoutDoc(types, look), files = FILES(), id = await createProject(page, doc, 'T07 render');
  const ids: string[] = [];
  for (const f of files) ids.push(await uploadAsset(page, id, readFileSync(f), path.basename(f), mimeOf(f)));
  await page.evaluate(async ({ id, ids, empty, pick, cellProps }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p); const { document } = await projectStore.read(id);
    for (const it of document.items) it.details.cells.forEach((c: any, j: number) => {
      if (empty.includes(j)) return;
      const f = (pick[j] ?? j) % 4, assetId = ids[f]; c.source = { assetId, type: f === 3 ? 'image' : 'video', url: `asset:${assetId}` };
      Object.assign(c, cellProps[j] ?? {});
    });
    await projectStore.save(id, document, document.rev);
  }, { id, ids, empty: look.empty ?? [], pick, cellProps });
  await openAndIngest(page, id);
  return { id, doc: JSON.parse(JSON.stringify((await page.evaluate(async id => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.read(id)).document; }, id)))) };
}
const u8 = (a: Uint8ClampedArray) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
/** The oracle's frame n (the export plan's own frame times) of the stored document; cell k decodes FILES[k % 4]. */
function oracleFrame(doc: any, n: number, w = SIZE.width, h = SIZE.height, pick: Record<number, number> = {}) {
  const files = FILES(), dir = path.dirname(files[0]), plan = exportPlan(doc), fx = fixtureSource(dir);
  const deps = oracleDeps((item, t, cell) => {
    const fi = (pick[cell ?? 0] ?? cell ?? 0) % 4, f = files[fi];
    return fx({ ...item, type: fi === 3 ? 'image' : 'video', details: { ...item.details, src: `fixture://${path.basename(f)}` } }, t);
  });
  return u8(quantise8(renderFrame(doc, planTime(plan, plan.first + n), deps, { width: w, height: h })));
}
/** What the preview shows: every `canvas.run` composited in DOM (z) order, as RGBA at the canvas size. */
const previewPixels = (page: Page) => page.evaluate(() => {
  const runs = [...document.querySelectorAll<HTMLCanvasElement>('canvas.run')], o = document.createElement('canvas');
  o.width = runs[0].width; o.height = runs[0].height; const g = o.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, o.width, o.height);   // the export is over black, a 6 % white cell has alpha in the preview
  for (const c of runs) g.drawImage(c, 0, 0);
  const d = g.getImageData(0, 0, o.width, o.height).data; let s = ''; for (let k = 0; k < d.length; k += 0x8000) s += String.fromCharCode(...d.subarray(k, k + 0x8000));
  return { w: o.width, h: o.height, b64: btoa(s) };
});
async function previewAt(page: Page, ms: number) {
  await seekMs(page, ms); await shown(page, Math.round(ms * 30 / 1000));
  const p = await previewPixels(page); return { w: p.w, h: p.h, data: new Uint8Array(Buffer.from(p.b64, 'base64')) };
}
const rgbAt = (d: Uint8Array | Buffer, w: number, x: number, y: number) => [d[(y * w + x) * 4], d[(y * w + x) * 4 + 1], d[(y * w + x) * 4 + 2]];
const note = (type: string, description: string) => test.info().annotations.push({ type, description });
/** Split horizontal at gap 16, radius 20, frame 15: cell 2 is x 168, y 8, 144 x 164, its top-left arc centred at (188, 28).
 *  (170, 10) is inside the cell's rectangle and 5.5 px outside the arc, so it is empty canvas only because of the rounded
 *  clip. The oracle at radius 0 shows picture there (58, 151, 251): the sample fails if the corner is not rounded. The
 *  export's 4:2:0 chroma carries a few levels from the picture 5.5 px away (measured 3, 0, 8 on Windows), so its limit is
 *  40, room for another encoder's ringing on CI; a square corner in the export reads 74, 148, 236 (review delta d1). */
function roundedCorner(d: Uint8Array | Buffer, w: number, h: number, doc: any, what: 'preview' | 'export') {
  const at = (img: Uint8Array | Buffer) => rgbAt(img, w, Math.round(170 * w / SIZE.width), Math.round(10 * h / SIZE.height)), limit = what === 'export' ? 40 : 4;
  const square = JSON.parse(JSON.stringify(doc)); square.items[0].details.borderRadius = 0;
  const got = at(d), flat = at(oracleFrame(square, 15, w, h));
  note('corner', `${what} (170, 10): ${got.join(',')}; oracle at radius 0: ${flat.join(',')}`);
  expect(Math.max(...flat), 'the sample point shows picture when the corner is square (oracle, radius 0)').toBeGreaterThan(30);
  for (const c of got) expect(c, `${what}: outside cell 2's rounded corner, inside its rectangle`).toBeLessThanOrEqual(limit);
}

test.describe('T07 layouts: preview and export pixels', () => {
  test('preview: every preset, cells filled (3 videos + 1 still), SSIM >= 0.98 against the formula oracle at 0.5 s into each layout', async ({ page }) => {
    const { doc } = await open(page, [...LAYOUT_TYPES]);
    const low: string[] = [], scores: string[] = [];
    for (const [k, t] of LAYOUT_TYPES.entries()) {
      const got = await previewAt(page, k * SLOT + 500);
      const exp = oracleFrame(doc, k * 30 + 15, got.w, got.h), s = ssim(got.data, exp, got.w, got.h);
      scores.push(`${t}:${s.toFixed(4)}`); if (s < 0.98) low.push(`${t}: ${s.toFixed(4)}`);
    }
    note('ssim', scores.join(' ')); expect(low, 'presets below SSIM 0.98').toEqual([]);
  });

  test('preview: an empty cell is white at 6 %, the gap and the radius show, SSIM >= 0.98 against the oracle', async ({ page }) => {
    const types: LayoutType[] = ['split-horizontal', 'grid-2x2', 'pip-top-right'];
    const { doc } = await open(page, types, { gap: 16, borderRadius: 20, empty: [0] });
    for (const [k, t] of types.entries()) {
      const got = await previewAt(page, k * SLOT + 500), exp = oracleFrame(doc, k * 30 + 15, got.w, got.h);
      expect(ssim(got.data, exp, got.w, got.h), t).toBeGreaterThanOrEqual(0.98);
    }
    // Split horizontal: cell 1 (left) is empty: white at 6 % over the empty canvas = about 15 / 255 in the middle; the gap strip at the middle is empty canvas.
    const a = await previewAt(page, 500), mid = (x: number, y: number) => rgbAt(a.data, a.w, Math.round(x * a.w), Math.round(y * a.h));
    for (const c of mid(0.25, 0.5)) expect(c, 'empty cell').toBeGreaterThanOrEqual(10), expect(c).toBeLessThanOrEqual(22);
    for (const c of mid(0.5, 0.5)) expect(c, 'gap').toBeLessThanOrEqual(4);
    for (const c of mid(0.5 + 0.25, 0.02)) expect(c, 'above cell 2 (outside the cell, inset by the gap)').toBeLessThanOrEqual(4);
    expect(Math.max(...mid(0.75, 0.5)), 'the filled cell shows picture').toBeGreaterThan(30);
    roundedCorner(a.data, a.w, a.h, doc, 'preview');
  });

  test('export: every preset, cells filled, frames match the formula oracle (SSIM >= 0.98) and the preview on the same frames; the video cells decode through the export decoders', async ({ page }) => {
    const { id, doc } = await open(page, [...LAYOUT_TYPES]);
    const run = await runExport(page, id, {}), r = completed(run), plan = exportPlan(doc);
    expect(r.frames, 'frame count').toBe(plan.count);
    // The cells go through the export's own decoders (master plan §1b: cap 4, prefetch <= 2 s): three distinct video assets, so three decoders.
    note('decoders', JSON.stringify(r.stats.decoders));
    expect(r.stats.decoders.opened, 'one decoder per distinct video asset').toBeGreaterThanOrEqual(3);
    expect(r.stats.decoders.maxOpen).toBeLessThanOrEqual(4); expect(r.stats.decoders.requests).toBeGreaterThan(0); expect(r.stats.decoders.maxPrefetchS).toBeLessThanOrEqual(2);
    const frames = decodeRgba(run.file!, SIZE.width, SIZE.height); expect(frames.length).toBe(plan.count);
    const low: string[] = [], scores: string[] = [];
    for (const [k, t] of LAYOUT_TYPES.entries()) {
      const n = k * 30 + 15, s = ssim(new Uint8Array(frames[n]), oracleFrame(doc, n), SIZE.width, SIZE.height);
      scores.push(`${t}:${s.toFixed(4)}`); if (s < 0.98) low.push(`${t}: ${s.toFixed(4)}`);
    }
    note('ssim export', scores.join(' ')); expect(low, 'presets below SSIM 0.98 in the export').toEqual([]);
    // Preview = export on the same frames (three presets).
    for (const k of [0, 4, 5]) {
      const got = await previewAt(page, k * SLOT + 500), s = ssim(got.data, new Uint8Array(frames[k * 30 + 15]), got.w, got.h);
      expect(s, `preview vs export, ${LAYOUT_TYPES[k]}`).toBeGreaterThanOrEqual(0.98);
    }
  });

  test('export: an empty cell at 6 %, gap and radius match the oracle and the preview', async ({ page }) => {
    const types: LayoutType[] = ['split-horizontal', 'grid-2x2', 'feature-left'];
    const { id, doc } = await open(page, types, { gap: 16, borderRadius: 20, empty: [0] });
    const run = await runExport(page, id, {}); completed(run);
    const frames = decodeRgba(run.file!, SIZE.width, SIZE.height); expect(frames.length).toBe(exportPlan(doc).count);
    for (const [k, t] of types.entries()) {
      const n = k * 30 + 15; expect(ssim(new Uint8Array(frames[n]), oracleFrame(doc, n), SIZE.width, SIZE.height), `${t} export vs oracle`).toBeGreaterThanOrEqual(0.98);
      const got = await previewAt(page, k * SLOT + 500);
      expect(ssim(got.data, new Uint8Array(frames[n]), got.w, got.h), `${t} preview vs export`).toBeGreaterThanOrEqual(0.98);
    }
    // Split horizontal, frame 15: the empty cell (left half) is about 15 / 255; the gap strip in the middle is empty canvas.
    const f = frames[15], at = (x: number, y: number) => rgbAt(f, SIZE.width, Math.round(x * SIZE.width), Math.round(y * SIZE.height));
    for (const c of at(0.25, 0.5)) expect(c, 'empty cell in the export').toBeGreaterThanOrEqual(10), expect(c).toBeLessThanOrEqual(22);
    for (const c of at(0.5, 0.5)) expect(c, 'gap in the export').toBeLessThanOrEqual(4);
    roundedCorner(f, SIZE.width, SIZE.height, doc, 'export');
  });
  // Not oracle-scored (Author-only defaults, D26): LAYOUT_PARITY cellSpeed 'apply' and imageFit 'honour' differ from Xapp's export, which the oracle follows.
  test('Author-only defaults, not oracle-scored (D26): cell speed 2 is applied and a Fit still is contained, in preview and export alike', async ({ page }) => {
    const pick = { 0: 0, 1: 3 };   // cell 0 the first video, cell 1 the still
    const { id, doc } = await open(page, ['split-horizontal'], { pick, cell: { 0: { playbackRate: 2 }, 1: { fillMode: 'fit' } } });
    expect(doc.items[0].details.cells.map((c: any) => [c.playbackRate, c.fillMode])).toEqual([[2, 'fill'], [1, 'fit']]);
    const run = await runExport(page, id, {}); completed(run);
    const frames = decodeRgba(run.file!, SIZE.width, SIZE.height), fr = new Uint8Array(frames[15]);
    // (a) preview = export on frame 15.
    const got = await previewAt(page, 500);
    expect(ssim(got.data, fr, got.w, got.h), 'preview vs export').toBeGreaterThanOrEqual(0.98);
    // (b) Speed applied. The oracle ignores the speed: the same document scored as is shows source time 0.5 s in cell 0, the export shows 1.0 s.
    const cell0 = (d: Uint8Array) => { const out = new Uint8Array(160 * 180 * 4); for (let y = 0; y < 180; y++) out.set(d.subarray(y * 320 * 4, y * 320 * 4 + 160 * 4), y * 160 * 4); return out; };
    const ignoring = ssim(cell0(fr), cell0(oracleFrame(doc, 15, SIZE.width, SIZE.height, pick)), 160, 180);
    // The oracle at rate 1 sampled at the matching source time: the layout stretched to 2 s, frame 30 = 1.0 s into the cell's source.
    const slow = JSON.parse(JSON.stringify(doc)); slow.items[0].display.to = 2000; slow.duration = 2000; slow.items[0].details.cells[0].playbackRate = 1;
    const doubled = ssim(cell0(fr), cell0(oracleFrame(slow, 30, SIZE.width, SIZE.height, pick)), 160, 180);
    note('speed', `cell 0 region SSIM: vs oracle ignoring speed (source 0.5 s) ${ignoring.toFixed(4)}; vs oracle at source 1.0 s ${doubled.toFixed(4)}`);
    expect(doubled, 'cell 0 shows source time doubled').toBeGreaterThanOrEqual(0.98);
    expect(ignoring, 'cell 0 differs from the oracle that ignores speed').toBeLessThan(0.9);
    // (c) Fit honoured: the 160 x 90 still in the 160 x 180 right cell is contained (y 45..135), the bands above and below are empty canvas.
    for (const [what, d, w] of [['export', fr, SIZE.width], ['preview', got.data, got.w]] as const) {
      const at = (fx: number, fy: number) => rgbAt(d, w, Math.round(fx * w), Math.round(fy * (w * 180 / 320)));
      for (const c of at(0.75, 0.1)) expect(c, `${what}: band above the still`).toBeLessThanOrEqual(4);
      for (const c of at(0.75, 0.9)) expect(c, `${what}: band below the still`).toBeLessThanOrEqual(4);
      expect(Math.max(...at(0.75, 0.5)), `${what}: the still shows in the middle`).toBeGreaterThan(30);
    }
  });
});
