// SPDX-License-Identifier: AGPL-3.0-only
// T11 transitions in the export (T16a pipeline, Chromium): every export goes through startExport / awaitExport (t16a-support runExport) on a 160 x 90, 30 fps project;
// the transition record is put into the exported document by the options hook, so one project serves every kind. Oracles:
//   "T00 oracle"      parity/oracle renderFrame (findings part 5 §53 item model, §55 transitions) on the same document with fixture:// sources, quantised to 8 bit;
//                     frame times are the export's (frame n at n / 30 s). Per-frame SSIM >= MIN_SSIM (.98, G-08).
//   "formula oracle"  fadeAlpha / dipOverlay (§55.5) against the fitted alpha of Cutframe' frame on the T00 oracle's frame, +-0.02 (own, provisional; QE2's +-0.06 is Xapp's criterion).
//   window            half-open [cut - floor(D * alignment), cut + D - floor(D * alignment)), p = (t - start) / D; 0 / 25 / 50 / 75 / 100 % of the window are frames round(t * 30 / 1000)
//                     (half rounds up), so the 25 % and 75 % points sit at p .26667 / .76667 for a 1 s window; the 100 % point is the first frame after the window (p null).
// Metrics: ssim / alphaFit / MIN_SSIM from parity/transition-metrics.ts (the single copy, also used by parity/g08-export.ts). The OT-6 slice comes from a tsx child
// (tests/ui/t11-export-slice.ts): Playwright's loader cannot import parity/ot6-fade.ts, which reaches the runner's JSON import.
// E1 six kinds, E2 directions / softness 0 / alignments / 2 s, E3 same-asset pair + no-handle freeze + audio hard cut (QE6), E4 the OT-6 fade slice against the same slice without the fade,
// E5 a T07 layout and a same-asset transition pair in one export (each video cell on its own decoder key).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegAvailable } from '../media-fixtures';
import { spawnSync } from 'node:child_process';
import { fixtureSource, oracleDeps } from '../../parity/oracle/frame';
import { quantise8 } from '../../parity/oracle/image';
import type { Item } from '../../parity/oracle/item';
import { renderFrame, type Deps } from '../../parity/oracle/render';
import { transferBytes } from '../../parity/oracle/transfer';
import { MIN_SSIM, alphaFit, ssim } from '../../parity/transition-metrics';
import { dipOverlay, fadeAlpha } from '../../apps/web/src/render/transitions';
import { createProject, linkClip, skipTour } from './t02-support';
import { seedLayout } from './t07-support';
import { uploadAsset } from './t15-support';
import { NO_STORE, completed, decodePcm, decodeRgba, ff, genMedia, hasStore, mimeOf, mkDoc, openAndIngest, runExport, setup, STORE } from './t16a-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the source media, decodes the exported file and decodes the oracle sources');
test.setTimeout(240_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const W = 160, H = 90, FPS = 30, CUT = 2000;
const SSIM_OK = MIN_SSIM;                                 // G-08 (.98)
const FIT_TOL = 0.02;                                     // own, provisional
const MEDIA_DIR = path.join(tmpdir(), 'cutframe-t16a-media');
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
/** 160 x 90 testsrc2 (moving), hue-turned, BT.709 tagged so ffmpeg (oracle, read-back) and the browser decode it to the same colours; optional 440 / 880 Hz tone. */
const source = (name: string, hue: number, seconds: number, tone?: number) => genMedia(name, ['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${seconds}`,
  ...(tone ? ['-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`] : []), '-vf', `hue=h=${hue}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', ...TAGS,
  ...(tone ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : [])]);

type Rec = { kind: string; durationMs: number; alignment: number; direction?: string; params?: Record<string, unknown> };
const record = (r: Rec) => ({ id: 'transition_abcdefghij', trackId: 'v1', fromId: 'a', toId: 'b', ...r });
/** The two-clip document: A 0-2 s (source from `a.trim`), B 2-4 s (source from `b.trim`), one track; the page project is stored without a transition. */
const pair = (a: { trim?: number; sourceDuration?: number } = {}, b: { trim?: number; sourceDuration?: number } = {}) =>
  mkDoc([{ id: 'a', from: 0, to: 2000, trim: a.trim ?? 0, sourceDuration: a.sourceDuration ?? 4000 }, { id: 'b', from: 2000, to: 4000, trim: b.trim ?? 1000, sourceDuration: b.sourceDuration ?? 4000 }], { fps: FPS, size: { width: W, height: H } });
/** The options hook: exports the stored document with `records` as its transitions. */
const withTransitions = (...records: object[]) => `return { doc: { ...ctx.doc, transitions: ${JSON.stringify(records)} } };`;

// ---- T00 oracle ------------------------------------------------------------------------------------------------------------------
// One source for the whole file, memoised per (file, source time): fixtureSource spawns ffmpeg for every source frame it is asked for.
// A layout's cell k decodes the video fixture details.cellSrc[k] (E5; set by its oracle project, as t07-render's oracleFrame does per cell).
const raw = fixtureSource(MEDIA_DIR), memo = new Map<string, ReturnType<Deps['source']>>();
const D = oracleDeps((item: Item, sourceTimeMs: number, cell?: number) => {
  const it = item.type === 'layout' ? { ...item, type: 'video', details: { ...item.details, src: item.details?.cellSrc?.[cell ?? 0] } } as Item : item;
  const k = `${String(it.details?.src)}@${sourceTimeMs}`;
  if (!memo.has(k)) memo.set(k, raw(it, sourceTimeMs));
  return memo.get(k)!;
}, { exportColour: true });
/** The document for the oracle: the same items, the sources as fixture:// files of MEDIA_DIR, the record as the only transition. */
function oracleProject(doc: any, files: Record<string, string>, ...records: object[]) {
  const p = structuredClone(doc);
  for (const it of p.items) it.details = { name: it.id, src: `fixture://${path.basename(files[it.id])}` };
  p.transitions = records;
  return p;
}
const oracleFrame = (project: any, frame: number) => { const q = quantise8(renderFrame(project, frame * 1000 / FPS, D)); return new Uint8Array(q.buffer, q.byteOffset, q.byteLength); };
const asU8 = (b: Uint8Array) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** The window of a record on the cut at CUT, and the frames at 0 / 25 / 50 / 75 / 100 % of it (frame = round(t * fps / 1000)). */
function windowOf(r: Rec) {
  const start = CUT - Math.floor(r.durationMs * r.alignment), end = start + r.durationMs;
  const points = [0, 0.25, 0.5, 0.75, 1].map(q => Math.round((start + q * r.durationMs) * FPS / 1000));
  return { start, end, points, first: points[0], last: points[4] };
}
const pAt = (frame: number, w: { start: number; end: number }) => { const t = frame * 1000 / FPS; return t >= w.end || t < w.start ? null : (t - w.start) / (w.end - w.start); };
const range = (first: number, last: number) => ({ range: { startS: (first + 0.5) / FPS, endS: (last + 0.5) / FPS } });

/** Exports the window of `r` and holds each of its five frames to the T00 oracle (SSIM) and, for fade and dip, to the fitted alpha. Returns the run and the decoded frames. */
async function holdToOracle(page: Page, id: string, doc: any, files: Record<string, string>, r: Rec, label: string, firstFrame?: number) {
  const w = windowOf(r), rec = record(r), first = firstFrame ?? w.first;
  const run = await runExport(page, id, range(first, w.last), withTransitions(rec));
  const result = completed(run), frames = decodeRgba(run.file!, W, H);
  expect.soft(frames.length, `${label}: frames`).toBe(w.last - first + 1);
  const project = oracleProject(doc, files, rec), sims: number[] = [];
  for (const f of w.points) {
    const ours = frames[f - first], theirs = oracleFrame(project, f), p = pAt(f, w), s = ssim(asU8(ours), theirs, W, H);
    sims.push(s);
    expect.soft(s, `${label}: frame ${f} (p ${p === null ? 'null' : p.toFixed(5)}) SSIM vs the T00 oracle`).toBeGreaterThanOrEqual(SSIM_OK);
    if (p !== null && (r.kind === 'fade' || r.kind === 'dipToColorDissolve')) {
      // D34: fit alpha in the sRGB blend domain, reversing the output table on both decoded export frames.
      const alpha = r.kind === 'fade' ? fadeAlpha(p) : dipOverlay(p), fits = r.kind === 'fade' ? alpha >= 0.1 : alpha <= 0.9, fit = alphaFit(r.kind, p, r.params, transferBytes(asU8(ours), 'input'), transferBytes(theirs, 'input'));
      expect.soft(fit !== null, `${label}: frame ${f}: alphaFit is ${fits ? 'defined' : 'null'} at alpha ${alpha.toFixed(4)}`).toBe(fits);
      if (fit) expect.soft(Math.abs(fit.fitted - fit.alpha), `${label}: frame ${f} (p ${p.toFixed(5)}): fitted alpha ${fit.fitted.toFixed(4)} against the formula's ${fit.alpha.toFixed(4)}`).toBeLessThanOrEqual(FIT_TOL);
    }
  }
  test.info().annotations.push({ type: `ssim ${label}`, description: sims.map(s => s.toFixed(4)).join(' ') });
  return { run, result, frames, first };
}

const KINDS: Rec[] = [
  { kind: 'fade', durationMs: 1000, alignment: 0.5 },
  { kind: 'dissolve', durationMs: 1000, alignment: 0.5 },
  { kind: 'additiveDissolve', durationMs: 1000, alignment: 0.5 },
  { kind: 'dipToColorDissolve', durationMs: 1000, alignment: 0.5, params: { color: [1, 0.5, 0] } },
  { kind: 'slide', durationMs: 1000, alignment: 0.5, direction: 'from-left' },
  { kind: 'wipe', durationMs: 1000, alignment: 0.5, direction: 'from-left', params: { softness: 20 } },
];

test('E1 six kinds: each frame at 0 / 25 / 50 / 75 / 100 % of a 1 s centred window has SSIM >= .98 against the T00 oracle; fade and dip (non-black colour) fit the formula alpha within +-0.02 (own, provisional)', async ({ page }) => {
  const files = { a: source('t11-e1-a-160.mp4', 0, 4), b: source('t11-e1-b-160.mp4', 150, 4) }, doc = pair();
  const { id } = await setup(page, doc, files);
  for (const r of KINDS) await holdToOracle(page, id, doc, files, r, r.kind);
});

test('E2 directions and timings: slide and wipe in all four directions, wipe softness 0, alignment start and end, a 2 s duration, all against the T00 oracle (SSIM >= .98)', async ({ page }) => {
  const files = { a: source('t11-e1-a-160.mp4', 0, 4), b: source('t11-e1-b-160.mp4', 150, 4) }, doc = pair();
  const { id } = await setup(page, doc, files);
  const dirs = ['from-left', 'from-right', 'from-top', 'from-bottom'];
  for (const kind of ['slide', 'wipe']) for (const direction of dirs) await holdToOracle(page, id, doc, files, { kind, durationMs: 1000, alignment: 0.5, direction, ...(kind === 'wipe' ? { params: { softness: 20 } } : {}) }, `${kind} ${direction}`);
  await holdToOracle(page, id, doc, files, { kind: 'wipe', durationMs: 1000, alignment: 0.5, direction: 'from-left', params: { softness: 0 } }, 'wipe softness 0');
  await holdToOracle(page, id, doc, files, { kind: 'dissolve', durationMs: 1000, alignment: 0, params: {} }, 'dissolve alignment start [cut, cut + D)');
  await holdToOracle(page, id, doc, files, { kind: 'dissolve', durationMs: 1000, alignment: 1, params: {} }, 'dissolve alignment end [cut - D, cut)');
  await holdToOracle(page, id, doc, files, { kind: 'slide', durationMs: 1000, alignment: 0, direction: 'from-right' }, 'slide alignment start');
  await holdToOracle(page, id, doc, files, { kind: 'wipe', durationMs: 1000, alignment: 1, direction: 'from-top', params: { softness: 0 } }, 'wipe alignment end');
  await holdToOracle(page, id, doc, files, { kind: 'dissolve', durationMs: 2000, alignment: 0.5, params: {} }, 'dissolve 2 s');
  await holdToOracle(page, id, doc, files, { kind: 'fade', durationMs: 2000, alignment: 0.5 }, 'fade 2 s');
});

// ---- E3 ---------------------------------------------------------------------------------------------------------------------------
test('E3 (i) same-asset pair: A and B from one file with different trims match the T00 oracle, with at most two decoders open, two at once (stats.decoders.maxOpen 2; written-spec oracle: findings §55.3 two sources per pair, one decoder each)', async ({ page }) => {
  const file = source('t11-e1-a-160.mp4', 0, 4), files = { a: file, b: file }, doc = pair({ trim: 0 }, { trim: 1500 });
  const { id, assets } = await setup(page, doc, files);
  expect(assets.a, 'A and B are one asset').toBe(assets.b);
  const { result } = await holdToOracle(page, id, doc, files, { kind: 'dissolve', durationMs: 1000, alignment: 0.5, params: {} }, 'same asset');
  // maxOpen, not opened: a worker restart under load (T16a O13) adds to opened; one shared decoder for the pair would give 1.
  expect(result.stats.decoders.maxOpen).toBe(2);
});

/** The mean absolute RGB difference of the pixels with x in [x0, x1) of two RGBA frames. */
function meanDiff(a: Uint8Array, b: Uint8Array, x0: number, x1: number) {
  let sum = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) for (let k = 0; k < 3; k++) { sum += Math.abs(a[(y * W + x) * 4 + k] - b[(y * W + x) * 4 + k]); n++; }
  return sum / n;
}
test('E3 (ii) no-handle freeze: A shows its last frame after its end and B its first frame before its start (T00 oracle, and the same pixels as the frame that shows that source frame)', async ({ page }) => {
  // A: a 2 s file used whole (no handle after), B: a 2 s file from its first frame (no handle before). Wipe from-left, softness 0: A on the right, B on the left of the front.
  const files = { a: source('t11-e3-a-160.mp4', 0, 2), b: source('t11-e3-b-160.mp4', 150, 2) }, doc = pair({ trim: 0, sourceDuration: 2000 }, { trim: 0, sourceDuration: 2000 });
  const { id } = await setup(page, doc, files);
  const r: Rec = { kind: 'wipe', durationMs: 1000, alignment: 0.5, direction: 'from-left', params: { softness: 0 } }, w = windowOf(r);
  const { frames, first } = await holdToOracle(page, id, doc, files, r, 'freeze', w.first);
  const at = (f: number) => asU8(frames[f - first]);
  // Front at x = floor(p * W + 0.5), margin 5 px (W / 32, as 10 px at 320). Frame 59 (t 1966.7 ms) is A's last source frame (index 59); frame 68 (t 2266.7 ms,
  // p .76667, front at x 123) shows A's frozen frame on x >= 128.
  const aFrozen = meanDiff(at(68), at(59), 128, W), aMoving = meanDiff(at(68), at(46), 128, W);
  // Frame 60 (t 2000 ms) is B's first source frame; frame 53 (t 1766.7 ms, p .26667, front at x 43) shows B's frozen first frame on x < 38; frame 66 shows B's source frame 6.
  const bFrozen = meanDiff(at(53), at(60), 0, 38), bMoving = meanDiff(at(66), at(60), 0, 38);
  test.info().annotations.push({ type: 'mean abs diff', description: JSON.stringify({ aFrozen, aMoving, bFrozen, bMoving }) });
  expect(aFrozen, 'A after its end: the same pixels as its last frame (re-encode noise only; own, provisional)').toBeLessThanOrEqual(3);
  expect(bFrozen, 'B before its start: the same pixels as its first frame (own, provisional)').toBeLessThanOrEqual(3);
  expect(aMoving, 'control: A before its end moves').toBeGreaterThan(aFrozen + 2);
  expect(bMoving, 'control: B after its start moves').toBeGreaterThan(bFrozen + 2);
});

/** Goertzel power of `x` at `hz` (48 kHz) over samples [from, to). */
function goertzel(x: Float32Array, hz: number, from: number, to: number) {
  const k = 2 * Math.cos(2 * Math.PI * hz / 48000); let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s = x[i] + k * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (to - from) ** 2;
}
test('E3 (iii) audio hard cut (QE6): with a transition at the cut 440 Hz stops and 880 Hz starts, no crossfade (Goertzel on the decoded PCM; own, provisional ratio 100)', async ({ page }) => {
  const files = { a: source('t11-e3-tone440-160.mp4', 0, 4, 440), b: source('t11-e3-tone880-160.mp4', 150, 4, 880) }, doc = pair({ trim: 0 }, { trim: 0 });
  const { id } = await setup(page, doc, files);
  for (const r of [{ kind: 'fade', durationMs: 1000, alignment: 0.5 }, { kind: 'dissolve', durationMs: 1000, alignment: 0.5 }]) {
    const run = await runExport(page, id, {}, withTransitions(record(r))); completed(run);
    const { left } = decodePcm(run.file!), at = (s: number) => Math.round(s * 48000);
    const before: [number, number] = [at(1.6), at(1.95)], after: [number, number] = [at(2.05), at(2.4)];
    const lo = (b: [number, number]) => goertzel(left, 440, ...b), hi = (b: [number, number]) => goertzel(left, 880, ...b);
    test.info().annotations.push({ type: `goertzel ${r.kind}`, description: JSON.stringify({ before: [lo(before), hi(before)], after: [lo(after), hi(after)] }) });
    expect(lo(before), `${r.kind}: 440 Hz before the cut`).toBeGreaterThan(hi(before) * 100);
    expect(hi(after), `${r.kind}: 880 Hz after the cut`).toBeGreaterThan(lo(after) * 100);
    expect(lo(before), `${r.kind}: the 440 Hz tone is audible`).toBeGreaterThan(1e-6);
  }
});

// ---- E4 ---------------------------------------------------------------------------------------------------------------------------
const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
/** Frames of a file as RGBA (ffmpeg, the stream's colour tags); `frames` are 0-based indexes in presentation order. */
function frameMap(file: string, frames: number[], width: number, height: number) {
  const buf = ff('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', `select='${frames.map(n => `eq(n,${n})`).join('+')}'`, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], 'buffer') as Buffer, size = width * height * 4;
  expect(buf.length, `${frames.length} frames of ${width} x ${height}`).toBe(frames.length * size);
  return new Map(frames.map((n, k) => [n, new Uint8Array(buf.buffer, buf.byteOffset + k * size, size)]));
}
test('E4 OT-6 fade slice: the fitted alpha in the sRGB blend domain of each fade frame 165-194 against the same frame without the fade is within +-0.02 of the fixture alpha (D34; formula oracle: the fixture fadeAlphas)', async ({ page }) => {
  test.skip(!hasStore, NO_STORE);
  const sliced = spawnSync(process.execPath, [TSX, 'tests/ui/t11-export-slice.ts', STORE], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120_000 });
  expect(sliced.status, sliced.stderr).toBe(0);
  const { fade, cutTransitions } = JSON.parse(sliced.stdout) as { fade: { doc: any; media: { speech: string; action: string }; fadeAlphas: { frame: number; p: number; clip: string; alpha: number }[] }; cutTransitions: unknown[] };
  expect(cutTransitions).toStrictEqual([]);
  const FIRST = 165, LAST = 194;                          // OT6_FRAMES
  const { id } = await setup(page, fade.doc, { 'v1-speech': fade.media.speech, 'v1-action': fade.media.action }, 'T11 OT-6 fade', 300_000);
  const opts = range(FIRST, LAST);
  const faded = await runExport(page, id, opts);
  const noFade = await runExport(page, id, opts, 'return { doc: { ...ctx.doc, transitions: [] } };');
  completed(faded); completed(noFade);
  const n = LAST - FIRST + 1, idx = Array.from({ length: n }, (_, k) => k);
  const F = frameMap(faded.file!, idx, 1080, 1920), C = frameMap(noFade.file!, idx, 1080, 1920);
  expect(fade.fadeAlphas.length).toBe(n);
  const worst: number[] = [];
  for (const row of fade.fadeAlphas) {
    const k = row.frame - FIRST, f = transferBytes(F.get(k)!, 'input'), c = transferBytes(C.get(k)!, 'input');
    let sxy = 0, sxx = 0;
    for (let i = 0; i < c.length; i += 4) for (let j = 0; j < 3; j++) { sxy += f[i + j] * c[i + j]; sxx += c[i + j] ** 2; }
    const fit = sxy / sxx; worst.push(Math.abs(fit - row.alpha));
    expect.soft(Math.abs(fit - row.alpha), `frame ${row.frame} (${row.clip}, p ${row.p}): fitted alpha ${fit.toFixed(4)} against the fixture's ${row.alpha}`).toBeLessThanOrEqual(FIT_TOL);
  }
  test.info().annotations.push({ type: 'worst |fit - alpha|', description: Math.max(...worst).toFixed(4) });
});

// ---- E5 ---------------------------------------------------------------------------------------------------------------------------
/** A CW x CH lavfi pattern (`testsrc`, `smptehdbars` …), BT.709 tagged as `source`: a picture whose luma structure differs from testsrc2's (a hue turn keeps the luma SSIM sees). */
const pattern = (name: string, src: string) => genMedia(name, ['-f', 'lavfi', '-i', `${src}=size=${CW}x${CH}:rate=${FPS}:duration=4`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', ...TAGS]);
/** The pixels of [x0, x1) x [y0, y1) of a W x H RGBA frame. */
function crop(img: Uint8Array, x0: number, y0: number, x1: number, y1: number) {
  const out = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) out.set(img.subarray((y * W + x0) * 4, (y * W + x1) * 4), (y - y0) * (x1 - x0) * 4);
  return out;
}
// The layout box is x 80, y 0, 80 x 88, split vertical: cell 1 is 80 x 44 at (80, 0), cell 2 80 x 44 at (80, 44); the pair shows in the left half (and rows 88-89 on the right).
// The cell sources are CW x CH = the cell size (even, for 4:2:0), so Fill draws them 1:1: at 2x downscale the browser's and the oracle's resampling of
// smptehdbars' hard edges differ (measured cell 2 SSIM .985, .918 on the first frame, with 160 x 90 sources in 80 x 45 cells).
const CW = W / 2, CH = 44;
const REGIONS: Record<string, [number, number, number, number]> = { pair: [0, 0, W / 2, H], 'cell 1': [W / 2, 0, W, CH], 'cell 2': [W / 2, CH, W, 2 * CH] };

test('E5 a layout and a transition in one export: a same-asset pair with a 1 s centred fade under a split-vertical layout on the right (two other video sources) matches the T00 oracle on the whole frame and on each region (SSIM >= .98), with four decoders open (A, B, cell 1, cell 2)', async ({ page }) => {
  const file = source('t11-e1-a-160.mp4', 0, 4), cellFiles = [pattern('t11-e5-cell1-testsrc-80x44.mp4', 'testsrc'), pattern('t11-e5-cell2-smptehdbars-80x44.mp4', 'smptehdbars')];
  const base = pair({ trim: 0 }, { trim: 1500 });
  const overlay = { id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 };
  const layout = seedLayout('L', 'split-vertical', { trackId: 'o1', from: 0, to: 4000, width: CW, height: 2 * CH, props: { positionX: W / 2 } });
  const doc = { ...base, tracks: [...base.tracks, overlay], layerOrder: [...base.layerOrder, { type: 'track', id: 'o1' }], items: [...base.items, layout] };   // layerOrder bottom first: o1 on top
  const id = await createProject(page, doc, 'T11 E5');
  const a = await uploadAsset(page, id, readFileSync(file), path.basename(file), mimeOf(file));
  await linkClip(page, id, a, 'a'); await linkClip(page, id, a, 'b');
  const cellIds: string[] = [];
  for (const f of cellFiles) cellIds.push(await uploadAsset(page, id, readFileSync(f), path.basename(f), mimeOf(f)));
  // Each cell filled the way the footage picker stores it (t07-render open()).
  await page.evaluate(async ({ id, cellIds }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p); const { document } = await projectStore.read(id);
    document.items.find((i: any) => i.id === 'L').details.cells.forEach((c: any, k: number) => { c.source = { assetId: cellIds[k], type: 'video', url: `asset:${cellIds[k]}` }; });
    await projectStore.save(id, document, document.rev);
  }, { id, cellIds });
  await openAndIngest(page, id);
  const stored = await page.evaluate(async id => { const p = '/src/store/database.ts'; return (await (await import(p)).projectStore.read(id)).document; }, id);

  const r: Rec = { kind: 'fade', durationMs: 1000, alignment: 0.5 }, w = windowOf(r), rec = record(r);
  const run = await runExport(page, id, range(w.first, w.last), withTransitions(rec));
  const result = completed(run), frames = decodeRgba(run.file!, W, H);
  expect(frames.length, 'frames').toBe(w.last - w.first + 1);
  const project = structuredClone(stored);
  for (const it of project.items) {
    if (it.id === 'L') it.details.cellSrc = cellFiles.map(f => `fixture://${path.basename(f)}`);
    else it.details = { name: it.id, src: `fixture://${path.basename(file)}` };
  }
  project.transitions = [rec];
  const sims: string[] = [];
  for (const f of w.points) {
    const ours = asU8(frames[f - w.first]), theirs = oracleFrame(project, f), p = pAt(f, w), at = `frame ${f} (p ${p === null ? 'null' : p.toFixed(5)})`;
    const whole = ssim(ours, theirs, W, H), parts = Object.entries(REGIONS).map(([name, [x0, y0, x1, y1]]) => [name, ssim(crop(ours, x0, y0, x1, y1), crop(theirs, x0, y0, x1, y1), x1 - x0, y1 - y0)] as const);
    sims.push(`${f}: ${whole.toFixed(4)} / ${parts.map(([, s]) => s.toFixed(4)).join(' ')}`);
    expect.soft(whole, `${at}: whole frame SSIM vs the T00 oracle`).toBeGreaterThanOrEqual(SSIM_OK);
    for (const [name, s] of parts) expect.soft(s, `${at}: ${name} SSIM vs the T00 oracle`).toBeGreaterThanOrEqual(SSIM_OK);
  }
  test.info().annotations.push({ type: 'ssim E5 (frame: whole / pair, cell 1, cell 2)', description: sims.join('; ') });
  test.info().annotations.push({ type: 'decoders E5', description: JSON.stringify(result.stats.decoders) });
  // A, B (its own `:to` key, as E3 (i)), cell 1 and cell 2 are all drawn in the window: four at once, the cap (master plan §1b).
  expect(result.stats.decoders.maxOpen).toBeLessThanOrEqual(4);
  expect(result.stats.decoders.maxOpen).toBe(4);
});
