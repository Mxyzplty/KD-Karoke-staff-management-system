// SPDX-License-Identifier: AGPL-3.0-only
// T13's export check over the ways the source worker reads a file (review round 2 n8) and over a T07 layout cell (review round 3
// n11), through T16a's entry point. Test 1: an AVI (no Mediabunny demuxer, so the reader's whole() path decodes it once with T14's
// WASM decode; review M1) and a layout cell at Volume 150 and Speed 2 (findings §7b.3 l.159: track gain × (cell volume % / 100)², the
// cell's own playbackRate). Test 2: an MKV with AC-3 (Mediabunny's block reader, AC-3 through @mediabunny/ac3), a known failure (below).
// The file, decoded by ffmpeg, is compared with T13's reference pass (renderAudio over the sources decoded by ffmpeg in node) through
// the audio oracle, with the gates pre-registered in "T13 audio notes (C).md" (Pre-registration: formats and a layout cell; and its
// amendment for the MKV / AC-3 check after run 1).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ffmpegAvailable } from '../media-fixtures';
import { createProject, linkClip, skipTour } from './t02-support';
import { uploadAsset } from './t15-support';
import { seedLayout } from './t07-support';
import { completed, decodePcm, ff, genMedia, mimeOf, mkDoc, openAndIngest, runExport } from './t16a-support';
import { renderAudio } from '../../apps/web/src/audio/stage';
import { compareAudio, levels } from '../../apps/web/src/audio/oracle';
import type { Stereo } from '../../apps/web/src/audio/mix';
import type { ProjectDocument } from '../../apps/web/src/store/model';
import { cents, decodeWithFfmpeg, freqHz, pcmSource } from '../t13-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the media, decodes the export and the sources of the reference');
test.setTimeout(300_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const FS = 48000, EDGE = 0.05 * FS, MARGIN = 0.1 * FS;
const S = (s: number) => Math.round(s * FS);
const SMALL = { fps: 10, size: { width: 64, height: 36 } };
// ---- media (ffmpeg-made, mono: the mix copies one channel to both, with no down-mix rule on either side) -------------------------------
const PICTURE = (seconds: number) => ['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30:duration=${seconds}`];
const TONE = (hz: number, gain: number, seconds: number) => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`, '-af', `volume=${gain}`, '-ac', '1'];
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
/** v: AVI, MPEG-4 Part 2 + PCM s16le 48 kHz, 660 Hz at 0.5 (sine's 1/8 × 4), 3 s. */
const AVI = () => genMedia('t13-f-pcm.avi', [...PICTURE(3), ...TONE(660, 4, 3), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', '-shortest']);
/** c: MP4, H.264 + AAC, 400 Hz at 0.2 (1/8 × 1.6), 6 s: the cell reads 0–4 s of it at Speed 2. */
const CELL = () => genMedia('t13-f-cell.mp4', [...PICTURE(6), ...TONE(400, 1.6, 6), ...H264, '-c:a', 'aac', '-b:a', '192k', '-shortest']);
/** m: MKV, H.264 + AC-3 192 kb/s, a linear sweep 200 Hz → 4 kHz over 3 s at 0.25: no period, so the lag search cannot wrap, and tonal,
 *  so the export's AAC codes it as closely as the tone sections (white noise did not: residual −35.7 dBFS, notes). */
const MKV = () => genMedia('t13-f-ac3-sweep.mkv', [...PICTURE(3), '-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*(200*t+633.333333*t*t)):s=48000:d=3',
  ...H264, '-c:a', 'ac3', '-b:a', '192k', '-ac', '1', '-shortest']);

const storedDoc = (page: Page, id: string): Promise<ProjectDocument> => page.evaluate(async id => {
  const s = '/src/store/database.ts', { projectStore } = await import(s);
  return (await projectStore.read(id)).document;
}, id);
const span = (x: Stereo, a: number, b: number): Stereo => [x[0].subarray(a, b), x[1].subarray(a, b)];
const note = (type: string, description: string) => { test.info().annotations.push({ type, description }); console.log(`[${type}] ${description}`); };
/** The pre-registered file gates on ref vs file (same length), with `exclude` left out; returns the whole-frame shift of the file.
 *  `soft`: every gate is evaluated and reported, so a known failure shows which gates it fails. */
function gates(what: string, ref: Stereo, file: Stereo, exclude: [number, number][], soft = false) {
  const c = compareAudio(ref, file, { exclude }), check = soft ? expect.soft : expect;
  note(`${what} vs reference`, `lag ${c.lagMs.toFixed(3)} ms, gain ${c.gainDb.toFixed(3)} dB, peak ${c.peakDb.toFixed(3)} dB, residual ${c.residualDb.toFixed(1)} dBFS`);
  check(Math.abs(c.lagMs), `${what}: lag (ms)`).toBeLessThanOrEqual(1);
  check(Math.abs(c.gainDb), `${what}: RMS gain (dB)`).toBeLessThanOrEqual(0.1);
  check(Math.abs(c.peakDb), `${what}: peak (dB)`).toBeLessThanOrEqual(0.3);
  check(c.residualDb, `${what}: residual (dBFS)`).toBeLessThanOrEqual(-40);
  return Math.round(c.lagMs * FS / 1000);
}
/** In the page, as the source worker reads each asset: how often `whole()` runs and how many frames block 0 holds. */
const readPaths = (page: Page, assets: Record<string, string>) => page.evaluate(async assets => {
  const mods = ['/src/store/database.ts', '/src/audio/reader.ts', '/src/media/decode.ts'];
  const [{ projectStore }, { openReader }, { decodeAudio, ensureAc3 }] = await Promise.all(mods.map(x => import(x)));
  ensureAc3(); // as source.worker.ts does before each block
  const out: Record<string, { whole: number; rate: number | null; frames: number }> = {};
  for (const [k, assetId] of Object.entries(assets)) {
    let whole = 0;
    const reader = await openReader(await projectStore.media.read(assetId), false, async (b: Blob) => { whole++; return decodeAudio(b, { forceWasm: true }); });
    const block = await reader?.block(0); reader?.dispose();
    out[k] = { whole, rate: block?.rate ?? null, frames: block?.data[0]?.length ?? 0 };
  }
  return out;
}, assets);
/** Each section's file RMS against the formula: the source's RMS over the span it reads × gain (±0.1 dB), 100 ms left out at each end. */
function sectionLevel(what: string, file: Stereo, at: number, src: Float32Array, [s0, s1]: [number, number], gain: number, shift: number, soft = false) {
  const a = S(at), b = S(at + 2), rate = (s1 - s0) / 2;
  const got = levels(span(file, a + MARGIN + shift, b - MARGIN + shift)).rmsDb;
  const part = src.subarray(S(s0) + MARGIN * rate, S(s1) - MARGIN * rate), source = levels([part, part]).rmsDb, want = 20 * Math.log10(gain);
  note(`${what} level`, `file ${got.toFixed(3)} dBFS, source ${source.toFixed(3)} dBFS: ${(got - source).toFixed(3)} dB (formula ${want.toFixed(3)} dB)`);
  (soft ? expect.soft : expect)(Math.abs(got - source - want), `${what}: file level vs source × gain (dB)`).toBeLessThanOrEqual(0.1);
}

// Sections of 2 s: 0–2 s empty (run 1's MKV section, now Test 2), v 2–4 s (an audio item on A1, from the AVI), c 4–6 s (a split-horizontal
// layout on an overlay track; cell 0 plays the MP4 at Volume 150 and Speed 2, cell 1 is empty). The export leaves the leading gap out
// (findings §53.8, render/model.ts exportPlan: the earliest item starts at 2 s), so the file is document time 2–6 s: v at 0–2 s, c at 2–4 s.
const START_MS = 2000;
test('T13 export: an AVI item (the whole-file WASM decode) and a layout cell at 150 % and 2× in the exported file (vs renderAudio; pre-registered gates)', async ({ page }) => {
  const doc: any = mkDoc([{ id: 'v', type: 'audio', track: 'a1', from: 2000, to: 4000, sourceDuration: 3000 }], SMALL);
  doc.tracks.push({ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 });
  doc.layerOrder.push({ type: 'track', id: 'o1' });
  doc.items.push(seedLayout('L1', 'split-horizontal', { trackId: 'o1', from: 4000, to: 6000, width: 64, height: 36 }));
  doc.duration = 6000;
  const id = await createProject(page, doc, 'T13 formats'), avi = AVI();
  const v = await uploadAsset(page, id, readFileSync(avi), path.basename(avi), mimeOf(avi)); await linkClip(page, id, v, 'v');
  const cell = await uploadAsset(page, id, readFileSync(CELL()), path.basename(CELL()), mimeOf(CELL()));
  await page.evaluate(async ({ id, cell }) => {
    const p = '/src/store/database.ts', { projectStore } = await import(p), { document } = await projectStore.read(id);
    Object.assign(document.items.find((i: any) => i.id === 'L1').details.cells[0], { source: { assetId: cell, type: 'video', url: `asset:${cell}` }, volume: 150, playbackRate: 2 });
    await projectStore.save(id, document, document.rev);
  }, { id, cell });
  await openAndIngest(page, id);

  // Preconditions: the AVI goes through whole() once; the stored cell is the one described above.
  const paths = await readPaths(page, { v });
  note('read paths', JSON.stringify(paths));
  expect(paths.v.whole, 'AVI: the reader decodes the whole file through T14\'s WASM path, once').toBe(1);
  expect(paths.v.frames, 'v: the reader returns samples').toBeGreaterThan(0);
  const stored = await storedDoc(page, id), layout: any = stored.items.find(i => i.id === 'L1'), c0 = layout.details.cells[0];
  expect([c0.source?.assetId, c0.volume, c0.playbackRate], 'the stored cell: source, Volume, Speed').toEqual([cell, 150, 2]);

  const run = await runExport(page, id);
  completed(run);
  // The reference: renderAudio over the stored document, each item's source decoded by ffmpeg (the cell is T07's cell item L1/<cell id>).
  const pcm: Record<string, Float32Array[]> = { v: [decodeWithFfmpeg(avi)], [`L1/${c0.id}`]: [decodeWithFfmpeg(CELL())] };
  const ref = (await renderAudio({ doc: stored, fromMs: START_MS, toMs: 6000, source: pcmSource(pcm) })).channels as Stereo;
  const { left, right } = decodePcm(run.file!), n = ref[0].length;
  expect(left.length, 'the file holds the exported range').toBeGreaterThanOrEqual(n);
  const file: Stereo = [left.subarray(0, n), right.subarray(0, n)];

  const shift = gates('whole document', ref, file, [[0, EDGE], [n - EDGE, n], [S(2) - EDGE, S(2) + EDGE]]);
  // Each section alone (file time), its first and last 50 ms left out; then its level against the formula.
  const sections: [string, number, Float32Array, [number, number], number][] = [
    ['v (AVI, whole decode)', 0, pcm.v[0], [0, 2], 1],
    ['c (layout cell, 150 %, 2×)', 2, pcm[`L1/${c0.id}`][0], [0, 4], 1.5 ** 2],
  ];
  for (const [what, at, src, range, gain] of sections) {
    const a = S(at), b = S(at + 2), len = b - a;
    gates(what, span(ref, a, b), span(file, a, b), [[0, EDGE], [len - EDGE, len]]);
    sectionLevel(what, file, at, src, range, gain, shift);
  }
  const f = freqHz(file[0], S(2) + MARGIN + shift, S(4) - MARGIN + shift), off = cents(f, 800);
  note('c pitch', `${f.toFixed(2)} Hz (${off.toFixed(2)} cents from 800 Hz)`);
  expect(Math.abs(off), 'c: 400 Hz at the cell\'s Speed 2 sounds at 800 Hz (cents)').toBeLessThanOrEqual(10);
});

/** Test 2's reference source (ruling R-CI1 (d2)): ffmpeg's decode of the MKV, less the encoder delay the file declares (the AC-3
 *  stream's initial_padding, from ffprobe) when this ffmpeg's decode kept it, i.e. decoded frames > packets × 1536 (AC-3's frame) −
 *  initial_padding. Both ffmpeg 6.1.1 and 8.1.2 write the padding at pts −5 ms; 8.1.2's decode trims it, 6.1.1's keeps it (notes). */
function delayTrimmedDecode(file: string): Float32Array {
  const pcm = decodeWithFfmpeg(file), probe = ['-v', 'error', '-select_streams', 'a:0', '-count_packets', '-show_entries', 'stream=initial_padding,nb_read_packets', '-of', 'json', file];
  const a = JSON.parse(ff('ffprobe', probe)).streams[0], padding = Number(a.initial_padding ?? 0), packets = Number(a.nb_read_packets);
  const kept = pcm.length > packets * 1536 - padding;
  note('reference decode', `${pcm.length} frames, ${packets} packets, initial_padding ${padding}: ${kept ? `kept by this ffmpeg, ${padding} frames dropped` : 'trimmed by ffmpeg'}`);
  return kept ? pcm.subarray(padding) : pcm;
}

// A video item on V1, 0–2 s, from the MKV.
test('T13 export: an MKV / AC-3 video item in the exported file (vs renderAudio; pre-registered gates; known failure: the AC-3 encoder delay)', async ({ page }) => {
  // Known failure (T13 notes, Open questions for Author): the Matroska encoder delay is not trimmed. ffmpeg writes the AC-3 stream with
  // initial_padding 256 and its first packet at -5 ms; Mediabunny's Matroska demuxer reports that packet at 0 and keeps the 256 frames of
  // padding, which the reference trims (delayTrimmedDecode, on every ffmpeg), so the sound is 256 frames (5.33 ms) late in preview and
  // export alike. Expected to fail the lag gate
  // only (soft gates: each run reports every gate); once the delay is trimmed every gate passes and this test turns red.
  test.fail(true, 'the Matroska AC-3 encoder delay (initial_padding 256) is not trimmed: 5.33 ms late');
  const doc: any = mkDoc([{ id: 'm', type: 'video', track: 'v1', from: 0, to: 2000, sourceDuration: 3000 }], SMALL);
  const id = await createProject(page, doc, 'T13 MKV AC-3'), mkv = MKV();
  const m = await uploadAsset(page, id, readFileSync(mkv), path.basename(mkv), mimeOf(mkv)); await linkClip(page, id, m, 'm');
  await openAndIngest(page, id);
  const paths = await readPaths(page, { m });
  note('read paths', JSON.stringify(paths));
  expect(paths.m.whole, 'MKV / AC-3: the reader reads blocks through Mediabunny, without whole()').toBe(0);
  expect(paths.m.frames, 'm: the reader returns samples').toBeGreaterThan(0);

  const stored = await storedDoc(page, id), run = await runExport(page, id);
  completed(run);
  const pcm: Record<string, Float32Array[]> = { m: [delayTrimmedDecode(mkv)] };
  const ref = (await renderAudio({ doc: stored, fromMs: 0, toMs: 2000, source: pcmSource(pcm) })).channels as Stereo;
  const { left, right } = decodePcm(run.file!), n = ref[0].length;
  expect(left.length, 'the file holds the whole range').toBeGreaterThanOrEqual(n);
  const file: Stereo = [left.subarray(0, n), right.subarray(0, n)];
  const shift = gates('m (MKV / AC-3)', ref, file, [[0, EDGE], [n - EDGE, n]], true);
  sectionLevel('m (MKV / AC-3)', file, 0, pcm.m[0], [0, 2], 1, shift, true);
});
