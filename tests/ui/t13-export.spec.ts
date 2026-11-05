// SPDX-License-Identifier: AGPL-3.0-only
// T13's export checks through T16a's entry point (startExport / awaitExport, via runExport). The exported file, decoded by ffmpeg
// ("ffprobe ground truth"), is compared with T13's reference pass (audio/stage.ts renderAudio over the sources decoded by ffmpeg in
// node; the unit tests hold its gain law, limiter and speed rules to the formula oracle) through the audio oracle (audio/oracle.ts
// compareAudio). The codec is lossy (AAC-LC, or Opus where AAC-LC cannot be encoded), so the gates are the tolerances pre-registered
// in "T13 audio notes (C).md" (Pre-registration: export-file gates), not bit-exactness. Where a check needs the stage's own output
// (exact silence, the ceiling, chunk joins), a hook wraps the real stage (export/audio.ts exportMix) and records what it returns, and
// the page compares that with renderAudio over the same browser source, sample for sample.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable } from '../media-fixtures';
import { skipTour } from './t02-support';
import { completed, decodePcm, genMedia, mkDoc, runExport, setup, streams } from './t16a-support';
import { renderAudio } from '../../apps/web/src/audio/stage';
import { compareAudio, dB, levels } from '../../apps/web/src/audio/oracle';
import type { Stereo } from '../../apps/web/src/audio/mix';
import type { ProjectDocument } from '../../apps/web/src/store/model';
import { cents, decodeWithFfmpeg, freqHz, kf, pcmSource } from '../t13-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the media, decodes the export and the sources of the reference');
test.setTimeout(300_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const FS = 48000, CEILING = 10 ** (-1 / 20), SILENT = 10 ** (-90 / 20), EDGE = 0.05 * FS, MARGIN = 0.1 * FS;
const S = (s: number) => Math.round(s * FS);
// ---- media (ffmpeg-made, mono: the mix copies one channel to both, with no down-mix rule on either side) -------------------------------
/** 16 s of 1 kHz at 0.5 (−9.03 dBFS RMS), 16-bit WAV: lossless, so the page and the node reference read the same samples. */
const SINE = () => genMedia('t13-e-sine1k.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=16', '-af', 'volume=4', '-ac', '1', '-c:a', 'pcm_s16le']);
/** 2 s of 660 Hz at 0.5, a second asset for the long export's release sets. */
const TONE = () => genMedia('t13-e-tone660.wav', ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2', '-af', 'volume=4', '-ac', '1', '-c:a', 'pcm_s16le']);
/** 302 s of 440 Hz at 0.2 with 0.9 bursts at 119.80–119.98 s and 239.80–240.20 s, AAC (a small upload; both sides decode the same file). */
const LONG = () => genMedia('t13-e-long440.m4a', ['-f', 'lavfi', '-i', "aevalsrc='(0.2+0.7*(between(t,119.8,119.98)+between(t,239.8,240.2)))*sin(2*PI*440*t)':s=48000:d=302", '-c:a', 'aac', '-b:a', '128k', '-ac', '1']);

const vol = (defaultValue: number, keyframes: unknown[] = []) => ({ volume: { defaultValue, keyframes } });
const setTrack = (doc: any, id: string, flags: Record<string, unknown>) => Object.assign(doc.tracks.find((t: any) => t.id === id), flags);
const setItem = (doc: any, id: string, fields: Record<string, unknown>) => Object.assign(doc.items.find((i: any) => i.id === id), fields);
/** Clip `id` on `track` over section k (2 s each), reading the source from the same second. */
const section = (id: string, track: string, k: number, properties?: Record<string, unknown>) =>
  ({ id, type: 'audio' as const, track, from: k * 2000, to: k * 2000 + 2000, trim: k * 2000, sourceDuration: 16000, properties });
const small = { fps: 10, size: { width: 64, height: 36 } };

// ---- the reference and the gates ---------------------------------------------------------------------------------------------------
const storedDoc = (page: Page, id: string): Promise<ProjectDocument> => page.evaluate(async id => {
  const s = '/src/store/database.ts', { projectStore } = await import(s);
  return (await projectStore.read(id)).document;
}, id);
/** T13's reference pass over [fromS, toS) of the stored document, every item's source decoded by ffmpeg (mono). */
async function reference(doc: ProjectDocument, files: Record<string, string>, fromS: number, toS: number): Promise<Stereo> {
  const decoded = new Map<string, Float32Array>(), pcm: Record<string, Float32Array[]> = {};
  for (const [item, file] of Object.entries(files)) { if (!decoded.has(file)) decoded.set(file, decodeWithFfmpeg(file)); pcm[item] = [decoded.get(file)!]; }
  return (await renderAudio({ doc, fromMs: fromS * 1000, toMs: toS * 1000, source: pcmSource(pcm) })).channels;
}
const fileAudio = (file: string, fromS = 0, toS?: number): Stereo => {
  const { left, right } = decodePcm(file), a = S(fromS), b = toS === undefined ? left.length : S(toS);
  return [left.subarray(a, b), right.subarray(a, b)];
};
const span = (x: Stereo, a: number, b: number): Stereo => [x[0].subarray(a, b), x[1].subarray(a, b)];
const note = (type: string, description: string) => { test.info().annotations.push({ type, description }); console.log(`[${type}] ${description}`); };
/** compareAudio of the file against the reference with the pre-registered gates. Left out: the first and last 50 ms and ±50 ms
 *  around each level step (frames of the reference). Returns the comparison and the whole-frame shift of the file. */
function expectFile(what: string, ref: Stereo, file: Stereo, steps: number[]) {
  const n = ref[0].length, exclude: [number, number][] = [[0, EDGE], [n - EDGE, n], ...steps.map(b => [b - EDGE, b + EDGE] as [number, number])];
  expect(file[0].length, `${what}: the file holds the whole range`).toBeGreaterThanOrEqual(n);
  const c = compareAudio(ref, span(file, 0, n), { exclude });
  note(`${what} vs reference`, `lag ${c.lagMs.toFixed(3)} ms, gain ${c.gainDb.toFixed(3)} dB, peak ${c.peakDb.toFixed(3)} dB, residual ${c.residualDb.toFixed(1)} dBFS`);
  expect(Math.abs(c.lagMs), `${what}: lag (ms)`).toBeLessThanOrEqual(1);
  expect(Math.abs(c.gainDb), `${what}: RMS gain (dB)`).toBeLessThanOrEqual(0.1);
  expect(Math.abs(c.peakDb), `${what}: peak (dB)`).toBeLessThanOrEqual(0.3);
  expect(c.residualDb, `${what}: residual (dBFS)`).toBeLessThanOrEqual(-40);
  return { c, shift: Math.round(c.lagMs * FS / 1000) };
}
/** Levels of section [a, b) minus 100 ms at each end. */
const inner = (x: Stereo, a: number, b: number, shift = 0) => levels(span(x, a + MARGIN + shift, b - MARGIN + shift));
const expectSilent = (what: string, x: Stereo, a: number, b: number, shift = 0) => {
  const p = inner(x, a, b, shift).peakDb;
  note(`${what} peak`, `${p.toFixed(1)} dBFS`);
  expect(p, `${what}: file peak (dBFS)`).toBeLessThanOrEqual(dB(SILENT));
};
/** The limited span's file peak; `margin` frames left out at each end (100 ms for a section, the 50 ms burst-edge exclusion for a burst). */
const expectCeiling = (what: string, x: Stereo, a: number, b: number, shift = 0, margin = MARGIN) => {
  const p = levels(span(x, a + margin + shift, b - margin + shift)).peakDb;
  note(`${what} file peak`, `${p.toFixed(2)} dBFS`);
  expect(p, `${what}: file peak (dBFS)`).toBeGreaterThanOrEqual(-1.3);
  expect(p, `${what}: file peak (dBFS)`).toBeLessThanOrEqual(-0.7);
};

// ---- the stage's own output, recorded in the page -----------------------------------------------------------------------------------
/** A runExport hook: the real stage (exportMix, as the pipeline builds it) wrapped to record every call, each call's peak and the
 *  release sets, plus the output over `windowsS` ([fromS, toS) on the timeline), or the whole output when null. */
const RECORD = (windowsS: [number, number][] | null) => `
  const m = '/src/export/audio.ts', { exportMix } = await import(m);
  const assets = new Map((await ctx.store.library()).assets.map(a => [a.id, a])), real = exportMix(ctx.store, assets);
  const windows = ${JSON.stringify(windowsS)};
  const rec = window.__t13rec = { calls: [], releases: [], doc: null, out: [], windows: (windows ?? []).map(([a, b]) => {
    const from = Math.round(a * 48000), to = Math.round(b * 48000);
    return { a: from, b: to, data: [new Float32Array(to - from), new Float32Array(to - from)] };
  }) };
  const audio = Object.assign(async (doc, r) => {
    const pcm = await real(doc, r), s = Math.round(r.startMs * 48);
    let peak = 0; for (const ch of pcm.data) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    rec.doc = doc; rec.calls.push({ startMs: r.startMs, frames: r.frames, peak });
    if (!windows) rec.out.push({ start: s, data: pcm.data.map(c => c.slice()) });
    for (const w of rec.windows) for (let c = 0; c < 2; c++) for (let f = Math.max(s, w.a); f < Math.min(s + r.frames, w.b); f++) w.data[c][f - w.a] = pcm.data[c][f - s];
    return pcm;
  }, { release: keep => { rec.releases.push([...keep].sort()); real.release(keep); }, close: () => real.close() });
  return { audio };`;
type Call = { startMs: number; frames: number; peak: number };
/** In the page: renderAudio over the stage's document and the browser source (the preview's pool: the same reader and blocks as the
 *  export's own pool) for each recorded span, and the frames that differ. `whole`: the recorded whole output against [0, its end). */
const stageVsRender = (page: Page, opts: { whole: boolean; control?: { fromS: number; frames: number; window: number } ; spans?: [number, number][] }) => page.evaluate(async ({ whole, control, spans }) => {
  const mods = ['/src/audio/stage.ts', '/src/audio/source.ts', '/src/store/database.ts'];
  const [{ renderAudio }, { storeAudioSource }, { projectStore }] = await Promise.all(mods.map(m => import(m)));
  const rec = (window as any).__t13rec, assets = new Map((await projectStore.library()).assets.map((a: any) => [a.id, a]));
  const source = storeAudioSource(projectStore, (id: string) => assets.get(id));
  const render = async (a: number, b: number): Promise<Float32Array[]> => (await renderAudio({ doc: rec.doc, fromMs: a / 48, toMs: b / 48, source })).channels;
  const diff = (x: Float32Array[], y: Float32Array[], from = 0, to = x[0].length) => { let n = 0; for (let c = 0; c < 2; c++) for (let i = from; i < to; i++) if (x[c][i] !== y[c][i]) n++; return n; };
  const stats = (x: Float32Array[], a: number, b: number) => { let nonzero = 0, peak = 0; for (const ch of x) for (let i = a; i < b; i++) { if (ch[i] !== 0) nonzero++; peak = Math.max(peak, Math.abs(ch[i])); } return { nonzero, peak }; };
  const out: Record<string, unknown> = { calls: rec.calls, releases: rec.releases };
  if (whole) {
    const data = rec.out[0].data as Float32Array[], ref = await render(rec.out[0].start, rec.out[0].start + data[0].length);
    out.whole = { frames: data[0].length, differ: diff(data, ref), spans: (spans ?? []).map(([a, b]) => stats(data, a, b)) };
  }
  out.windows = await Promise.all(rec.windows.map(async (w: any) => ({ a: w.a, b: w.b, differ: diff(w.data, await render(w.a, w.b)) })));
  if (control) {
    // Negative control: a render begun afresh at the edge (a new limiter) against the recorded window there.
    const w = rec.windows[control.window], at = Math.round(control.fromS * 48000), fresh = await render(at, at + control.frames);
    out.control = diff(w.data.map((c: Float32Array) => c.subarray(at - w.a, at - w.a + control.frames)), fresh);
  }
  return out as { calls: Call[]; releases: string[][]; whole?: { frames: number; differ: number; spans: { nonzero: number; peak: number }[] }; windows: { a: number; b: number; differ: number }[]; control?: number };
}, opts);

// ---- the gain law, mute, hidden and the limiter in one export --------------------------------------------------------------------------
// Sections of 2 s: g0 unity; g1 item volume 0.5; g2 track volume 0.5; g3 both; g4 a muted track; g5 a hidden track; g6 item volume 2
// (0.5 × 2² = 2, limited to the ceiling). Formula: 20 log10 0.5² = −12.04 dB, 20 log10 0.5 = −6.02 dB, both −18.06 dB.
test('T13 export: the gain law, mute and hidden silence and the limiter ceiling in the exported file (vs renderAudio; pre-registered gates)', async ({ page }) => {
  const doc: any = mkDoc([section('g0', 'a1', 0), section('g1', 'a1', 1, vol(0.5)), section('g2', 'a2', 2), section('g3', 'a2', 3, vol(0.5)),
    section('g4', 'a3', 4), section('g5', 'a4', 5), section('g6', 'a1', 6, vol(2))], small);
  setTrack(doc, 'a2', { volume: 0.5 }); setTrack(doc, 'a3', { muted: true }); setTrack(doc, 'a4', { hidden: true });
  const files = Object.fromEntries(doc.items.map((i: any) => [i.id, SINE()]));
  const { id } = await setup(page, doc, files), run = await runExport(page, id, {}, RECORD(null));
  completed(run);
  const sec = (k: number): [number, number] => [S(2 * k), S(2 * k + 2)];

  // Before the codec: the stage's output is renderAudio's, sample for sample; muted and hidden are exact zeros; the ceiling holds.
  const st = await stageVsRender(page, { whole: true, spans: [sec(4), sec(5), sec(6)] });
  expect(st.calls.map(c => [c.startMs, c.frames]), 'one stage call over the whole range (14 s ≤ 300 s)').toEqual([[0, S(14)]]);
  expect(st.whole!.differ, 'stage output vs renderAudio: frames that differ').toBe(0);
  expect(st.whole!.spans.slice(0, 2).map(s => s.nonzero), 'non-zero samples before the codec: muted, hidden').toEqual([0, 0]);
  expect(st.calls[0].peak, 'stage peak ≤ ceiling').toBeLessThanOrEqual(CEILING * (1 + 1e-6));
  expect(dB(st.whole!.spans[2].peak), 'limited section held at the ceiling (dBFS)').toBeGreaterThanOrEqual(-1.01);

  // The file.
  const stored = await storedDoc(page, id), ref = await reference(stored, files, 0, 14), file = fileAudio(run.file!);
  const { shift } = expectFile('whole document', ref, file, [1, 2, 3, 4, 5, 6].map(k => S(2 * k)));
  const at = (x: Stereo, k: number, s = 0) => inner(x, ...sec(k), s);
  for (const k of [0, 1, 2, 3, 6]) {
    const d = at(file, k, shift).rmsDb - at(ref, k).rmsDb;
    note(`g${k} RMS`, `file ${at(file, k, shift).rmsDb.toFixed(3)} dBFS, reference ${at(ref, k).rmsDb.toFixed(3)} dBFS`);
    expect(Math.abs(d), `g${k}: file RMS vs reference (dB)`).toBeLessThanOrEqual(0.1);
  }
  const rel = (k: number) => at(file, k, shift).rmsDb - at(file, 0, shift).rmsDb;
  const law = [[1, 20 * Math.log10(0.25), -12.04], [2, 20 * Math.log10(0.5), -6.03], [3, 20 * Math.log10(0.125), -18.08]];
  note('gain law in the file', law.map(([k, f, t]) => `g${k} ${rel(k).toFixed(3)} dB (formula ${f.toFixed(3)}, § T13 ${t})`).join('; '));
  for (const [k, f] of law) expect(Math.abs(rel(k) - f), `g${k}: level vs g0 against the formula (dB)`).toBeLessThanOrEqual(0.1);
  expectSilent('g4 muted track', file, ...sec(4), shift);
  expectSilent('g5 hidden track', file, ...sec(5), shift);
  expectCeiling('g6 limited', file, ...sec(6), shift);
});

/** Max |x − y| over frames [a, b) of both channels. */
const maxDiff = (x: Stereo, y: Stereo, a = 0, b = x[0].length) => { let m = 0; for (let c = 0; c < 2; c++) for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[c][i] - y[c][i])); return m; };
test('T13 export: a soloed track silences the others before the codec and in the file (against a control export); a timeline of a muted track and a track at volume 0 is silent with its audio stream', async ({ page }) => {
  // Solo: a1 soloed (0–2 s), a2 not (0–4 s) → [2, 4) silent. The control (ruling R-CI1 (b)): the same document without s2.
  const solo: any = mkDoc([{ id: 's1', type: 'audio', track: 'a1', from: 0, to: 2000, sourceDuration: 16000 }, { id: 's2', type: 'audio', track: 'a2', from: 0, to: 4000, sourceDuration: 16000 }], small);
  setTrack(solo, 'a1', { solo: true });
  const control: any = structuredClone(solo); control.items = control.items.filter((i: any) => i.id !== 's2');
  const files = { s1: SINE(), s2: SINE() }, x = await setup(page, solo, files), run = await runExport(page, x.id, {}, RECORD(null));
  completed(run);
  // Before the codec (R-CI1 (a)): the stage's output is renderAudio's, sample for sample, and exact zeros over the soloed-out span.
  const st = await stageVsRender(page, { whole: true, spans: [[S(2), S(4)]] });
  expect(st.calls.map(c => [c.startMs, c.frames]), 'one stage call over the whole range').toEqual([[0, S(4)]]);
  expect(st.whole!.differ, 'stage output vs renderAudio: frames that differ').toBe(0);
  expect(st.whole!.spans[0].nonzero, 'non-zero samples before the codec: soloed-out a2 (2–4 s)').toBe(0);
  const ref = await reference(await storedDoc(page, x.id), files, 0, 4), file = fileAudio(run.file!);
  const { shift } = expectFile('solo', ref, file, [S(2)]);
  // The file (R-CI1 (b)): a span after sound holds the codec's decay tail (Opus, notes: −73.5 dBFS here), so the gate is the difference
  // from the control. Precondition: the control, exported twice, decodes identically.
  const k = await setup(page, control, { s1: files.s1 }), k1 = await runExport(page, k.id), k2 = await runExport(page, k.id);
  completed(k1); completed(k2);
  const ctl = fileAudio(k1.file!), again = fileAudio(k2.file!);
  note('control exported twice', `${ctl[0].length} / ${again[0].length} frames, max |difference| ${maxDiff(ctl, again)}`);
  expect(again[0].length, 'control: both exports decode to the same length').toBe(ctl[0].length);
  expect(maxDiff(ctl, again), 'control: both exports decode identically (max |difference|)').toBe(0);
  note('soloed-out a2 (2–4 s) peak', `${inner(file, S(2), S(4), shift).peakDb.toFixed(1)} dBFS (reported, not gated)`);
  const vsControl = dB(maxDiff(file, ctl, S(2) + MARGIN + shift, S(4) - MARGIN + shift));
  note('soloed-out a2 (2–4 s): solo − control peak', `${vsControl.toFixed(1)} dBFS`);
  expect(vsControl, 'soloed-out a2: peak of file(solo) − file(control) over 2.1–3.9 s (dBFS)').toBeLessThanOrEqual(dB(SILENT));

  // Every track silent: muted a1, a2 at track volume 0.
  const mute: any = mkDoc([{ id: 'm1', type: 'audio', track: 'a1', from: 0, to: 2000, sourceDuration: 16000 }, { id: 'm2', type: 'audio', track: 'a2', from: 0, to: 2000, sourceDuration: 16000 }], small);
  setTrack(mute, 'a1', { muted: true }); setTrack(mute, 'a2', { volume: 0 });
  const y = await setup(page, mute, { m1: SINE(), m2: SINE() }), silent = await runExport(page, y.id, {}, RECORD(null)), r = completed(silent);
  // Before the codec (R-CI1 (a)): the whole stage output is exact zeros.
  const ss = await stageVsRender(page, { whole: true, spans: [[0, S(2)]] });
  expect(ss.calls.map(c => [c.startMs, c.frames]), 'silent timeline: one stage call over the whole range').toEqual([[0, S(2)]]);
  expect(ss.whole!.spans[0].nonzero, 'non-zero samples before the codec: every track silent').toBe(0);
  const a = streams(silent.file!).find(s => s.codec_type === 'audio');
  note('silent timeline', `codec ${r.audioCodec}, stream ${a?.codec_name} ${a?.sample_rate} Hz ${a?.channels} ch`);
  expect(a, 'an audio stream').toBeTruthy();
  expect(a).toMatchObject({ sample_rate: '48000', channels: 2 });
  const all = fileAudio(silent.file!), p = levels(all).peakDb;
  note('silent timeline peak', `${p} dBFS over ${all[0].length} frames`);
  expect(all[0].length, 'decoded audio frames').toBeGreaterThanOrEqual(S(2));
  expect(p, 'file peak (dBFS)').toBeLessThanOrEqual(dB(SILENT));
});

// ---- speed and pitch, remap, keep pitch, the eased fade ----------------------------------------------------------------------------------
test('T13 export: 2× / 0.5× an octave up / down, keep pitch, reverse remap and an eased fade in the exported file (vs renderAudio; ±10 cents)', async ({ page }) => {
  const doc: any = mkDoc([0, 1, 2, 3, 4].map(k => ({ ...section(`p${k}`, 'a1', k), trim: 0 })), small);
  setItem(doc, 'p0', { playbackRate: 2, trim: { from: 0, to: 4000 } });
  setItem(doc, 'p1', { playbackRate: 0.5, trim: { from: 0, to: 1000 } });
  setItem(doc, 'p2', { playbackRate: 2, keepPitch: true, trim: { from: 0, to: 4000 } });
  setItem(doc, 'p3', { timeRemap: { defaultValue: 0, keyframes: [kf(0, 2000), kf(2000, 0)] } });
  setItem(doc, 'p4', { properties: vol(0, [kf(0, 0, 'easeInOut'), kf(2000, 1)]) });
  const files = Object.fromEntries(doc.items.map((i: any) => [i.id, SINE()]));
  const { id } = await setup(page, doc, files), run = await runExport(page, id);
  completed(run);
  const stored = await storedDoc(page, id), ref = await reference(stored, files, 0, 10), file = fileAudio(run.file!);
  const { shift } = expectFile('speed and pitch', ref, file, [1, 2, 3, 4].map(k => S(2 * k)));
  const pitch: [string, number, number][] = [['p0 2×', 0, 2000], ['p1 0.5×', 1, 500], ['p2 keep pitch 2×', 2, 1000], ['p3 reverse remap', 3, 1000]];
  for (const [what, k, hz] of pitch) {
    const f = freqHz(file[0], S(2 * k) + MARGIN + shift, S(2 * k + 2) - MARGIN + shift), c = cents(f, hz);
    note(`${what} pitch`, `${f.toFixed(2)} Hz (${c.toFixed(2)} cents)`);
    expect(Math.abs(c), `${what}: cents from ${hz} Hz`).toBeLessThanOrEqual(10);
    const d = inner(file, S(2 * k), S(2 * k + 2), shift).rmsDb - inner(ref, S(2 * k), S(2 * k + 2)).rmsDb;
    expect(Math.abs(d), `${what}: file RMS vs reference (dB)`).toBeLessThanOrEqual(0.1);
  }
  // The fade: 200 ms windows over 8.1–9.9 s whose reference RMS is at least −40 dBFS.
  const rows: string[] = [];
  for (let t = 8.1; t < 9.89; t += 0.2) {
    const a = S(t), b = S(t + 0.2), r = levels(span(ref, a, b)).rmsDb, f = levels(span(file, a + shift, b + shift)).rmsDb;
    rows.push(`${t.toFixed(1)} s: ${f.toFixed(2)} / ${r.toFixed(2)}`);
    if (r >= -40) expect(Math.abs(f - r), `fade window at ${t.toFixed(1)} s: file vs reference RMS (dB)`).toBeLessThanOrEqual(0.2);
  }
  note('fade windows (file / reference dBFS)', rows.join('; '));
});

// ---- a long export: T16a's 120 s stage calls -------------------------------------------------------------------------------------
// 302 s (> 300 s), so the pipeline calls the stage for 0–120, 120–240 and 240–302 s. j: the long tone at item volume 1.5 (0.45 between
// the bursts, under the ceiling; 2.03 in them, limited). Burst A ends 20 ms before the first edge (the limiter is releasing there),
// burst B straddles the second (holding there). e: a 2 s clip of another asset, so the first release set drops it.
test('T13 export over T16a\'s chunk calls (> 5 min): the stage joins sample for sample with the limiter carried, and the file across both edges matches renderAudio', async ({ page }) => {
  test.setTimeout(600_000);
  const doc: any = mkDoc([{ id: 'j', type: 'audio', track: 'a1', from: 0, to: 302000, sourceDuration: 302000, properties: vol(1.5) },
    { id: 'e', type: 'audio', track: 'a2', from: 0, to: 2000, sourceDuration: 2000, properties: vol(0.5) }], { fps: 1, size: { width: 64, height: 36 } });
  const files = { j: LONG(), e: TONE() };
  const { id, assets } = await setup(page, doc, files, 'T13 long export', 240_000);
  const run = await runExport(page, id, {}, RECORD([[118, 122], [238, 242]])), r = completed(run);
  expect(r.stats.audioChunks, 'stage calls (stats)').toBe(3);

  const st = await stageVsRender(page, { whole: false, control: { fromS: 120, frames: S(0.05), window: 0 } });
  expect(st.calls.map(c => [c.startMs, c.frames]), 'T16a\'s chunk calls').toEqual([[0, S(120)], [120000, S(120)], [240000, S(62)]]);
  expect(st.releases, 'release sets after each call (assets of items ending later)').toEqual([[assets.j], [assets.j], []]);
  for (const c of st.calls) expect(c.peak, `stage peak, call at ${c.startMs} ms`).toBeLessThanOrEqual(CEILING * (1 + 1e-6));
  note('stage around the edges', st.windows.map(w => `${w.a / FS}–${w.b / FS} s: ${w.differ} frames differ`).join('; ') + `; control (fresh at 120 s): ${st.control} differ`);
  expect(st.windows.map(w => w.differ), 'stage output vs renderAudio over 118–122 s and 238–242 s: frames that differ').toEqual([0, 0]);
  expect(st.control, 'negative control: a fresh limiter at 120 s differs in the first 50 ms').toBeGreaterThan(0);

  const stored = await storedDoc(page, id), file = decodePcm(run.file!);
  for (const [a, b, bursts] of [[110, 130, [119.8, 119.98]], [230, 250, [239.8, 240.2]]] as [number, number, number[]][]) {
    const ref = await reference(stored, files, a, b), part = span([file.left, file.right], S(a), S(b) + EDGE);
    const { shift } = expectFile(`${a}–${b} s`, ref, part, bursts.map(t => S(t - a)));
    expectCeiling(`burst ${a < 200 ? 'A' : 'B'}`, part, S(bursts[0] - a), S(bursts[1] - a), shift, EDGE);
  }
});
