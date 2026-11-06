// SPDX-License-Identifier: AGPL-3.0-only
// The OT-6 fade slice (T11 integration round, coordinator decision QE1: T11 owns the fade window, frames 165–194; T16 keeps the
// text, the captions and the whole EX-P11). fixtures/OT-6 export timeline 13.92s (C).json: tos-speech-45s 0–5977.236 ms with
// a vignette (50 / 50 / 50 / 50), tos-action-30s 5977.236–9937.236 ms, both at x 0, y 734.71875, 1280 × 534 × 0.84375 on the
// 1080 × 1920 canvas, black background, and a 1000 ms fade centred on the cut (window 5477.236–6477.236 ms). Only the two clips
// and the fade are built: the text ends at 5000 ms, the captions and the music clip lie outside frames 165–194.
// `parity --ot6-fade <export file> [--output <dir>]` exports frames 165–194 with Cutframe (parity/g08-export.ts exportRanges)
// and compares each with the same frame of the given file (a full OT-6 export, frame n at n / 30 s): mean SSIM >= 0.98 and,
// where the fade leaves enough picture (alpha >= 0.1), the least-squares alpha within ±0.06 of the fixture's fadeAlphas (QE2).
// D34: video is tabled BT.709 → sRGB before blending and every pixel sRGB → BT.709 before I420; no fade exponent. This
// comparison uses that export as its reference. The run reads only the
// file it is given; the real Xapp file is Author's (D2). The media are the store's corpus files as they are (untagged colour,
// as Xapp was given them); the given file's colour tags are reported.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { Json } from './normalise';
import { atomicJson, resolvedDestination } from './runner';
import { ALPHA_TOLERANCE, MIN_SSIM, decodeFrames, exportRanges, ssim, storeFile } from './g08-export';
import type { ProjectDocument } from '../apps/web/src/store/model';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OT6_FIXTURE = 'fixtures/OT-6 export timeline 13.92s (C).json';
/** The fade window's export frames (fixture measuredChecks, frames 165–194). */
export const OT6_FRAMES: [number, number] = [165, 194];
export type FadeAlpha = { frame: number; p: number; clip: 'speech' | 'action'; alpha: number; sourceMs: number };

const value = (v: number) => ({ defaultValue: v, keyframes: [] });
const sourceMs = (file: string) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  if (r.status !== 0) throw Error(`ffprobe ${file}: ${String(r.stderr)}`);
  return Math.round(Number(String(r.stdout).trim()) * 1000);
};
/** The slice as a schema-4 document whose clips name their media '@speech' / '@action' (exportRanges replaces them with the
 *  uploaded ids), the two store files (checked against the manifest) and the fixture's fadeAlphas. `transition: false` leaves
 *  the fade out: the same frames then show each clip alone, the reference picture of the alpha fit. */
export async function ot6FadeSlice(store = process.env.CUTFRAME_FIXTURES, o: { transition?: boolean } = {}) {
  const fx = JSON.parse(await readFile(path.join(REPO, OT6_FIXTURE), 'utf8'));
  const speech = await storeFile('corpus/tos-speech-45s.mp4', store), action = await storeFile('corpus/tos-action-30s.mp4', store);
  const spec = (id: string) => { const i = fx.items.find((x: { id: string }) => x.id === id); if (!i) throw Error(`${OT6_FIXTURE} has no item ${id}`); return i; };
  const t = fx.transitions.find((x: { id: string }) => x.id === 't1');
  const item = (id: string, key: string, file: string) => {
    const s = spec(id), p = s.properties;
    return { id, type: 'video', trackId: 'V1', display: { ...s.displayMs }, trim: { ...s.trimMs }, sourceDuration: sourceMs(file), details: { name: s.source }, metadata: { assetId: `@${key}` },
      properties: { positionX: value(p.x), positionY: value(p.y), width: value(p.width), height: value(p.height), scale: value(p.scale), opacity: value(p.opacity) },
      ...(s.effects.length ? { effects: s.effects.map((e: { kind: string; params: Record<string, number> }, order: number) => ({ id: `${id}-${e.kind}`, effectId: e.kind, enabled: true, order,
        parameters: Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, value(v)])) })) } : {}) };
  };
  const items = [item('v1-speech', 'speech', speech.file), item('v1-action', 'action', action.file)];
  const doc = { schemaVersion: 4, rev: 0, groups: {}, duration: items[1].display.to, fps: fx.project.fps, size: { ...fx.project.canvas }, background: { type: 'color', value: fx.project.background },
    markers: [], tracks: [{ id: 'V1', name: 'V1', kind: 'video', muted: false, solo: false, locked: false, hidden: false, volume: 1 }], layerOrder: [{ type: 'track', id: 'V1' }], items,
    transitions: o.transition === false ? [] : [{ id: t.id, trackId: 'V1', fromId: t.fromItem, toId: t.toItem, kind: t.kind, durationMs: t.durationMs, alignment: t.alignment }] } as unknown as ProjectDocument;
  return { doc, media: { speech: speech.file, action: action.file }, files: [{ name: 'speech', ...speech }, { name: 'action', ...action }], fadeAlphas: fx.measuredChecks.fadeAlphas as FadeAlpha[] };
}

const colourTags = (file: string): Json => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,nb_frames', '-of', 'json', file]);
  if (r.status !== 0) throw Error(`ffprobe ${file}: ${String(r.stderr)}`);
  return JSON.parse(String(r.stdout)).streams?.[0] ?? null;
};
/** The checks of `--ot6-fade` on decoded frames 165–194 (`ours` keyed by the offset from frame 165, `theirs` by the frame): SSIM
 *  >= MIN_SSIM and, where the fixture's alpha is >= 0.1, the fitted alpha within ALPHA_TOLERANCE, the ticket's ±0.06 for runs
 *  against Xapp's export (implementation tickets l.154). */
export function compareOt6Frames(fadeAlphas: FadeAlpha[], ours: Map<number, Uint8Array>, theirs: Map<number, Uint8Array>, W: number, H: number) {
  const [a, b] = OT6_FRAMES, frames = Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const rows: { [key: string]: Json }[] = [], failures: Json[] = [];
  for (const f of frames) {
    const want = fadeAlphas.find(x => x.frame === f), mine = ours.get(f - a)!, given = theirs.get(f)!, row: { [key: string]: Json } = { frame: f, ssim: ssim(mine, given, W, H) };
    if (want) {
      row.clip = want.clip; row.alpha = want.alpha;
      // Reference-normalised alpha diagnostic: alpha × Σ(theirs · ours) / Σ(ours²). Under D34 the output values are
      // nonlinear in blend alpha; this reports the given frame's scale relative to our tabled formula reference.
      if (want.alpha >= 0.1) { let sxy = 0, sxx = 0; for (let i = 0; i < mine.length; i += 4) for (let k = 0; k < 3; k++) { sxy += given[i + k] * mine[i + k]; sxx += mine[i + k] ** 2; } row.fittedAlpha = sxx ? want.alpha * sxy / sxx : null; }
    }
    if ((row.ssim as number) < MIN_SSIM) failures.push({ frame: f, check: 'ssim', expected: `>= ${MIN_SSIM}`, actual: row.ssim });
    if (typeof row.fittedAlpha === 'number' && Math.abs(row.fittedAlpha - (row.alpha as number)) > ALPHA_TOLERANCE) failures.push({ frame: f, check: 'alpha', expected: row.alpha, actual: row.fittedAlpha });
    rows.push(row);
  }
  return { minSsim: MIN_SSIM, alphaTolerance: ALPHA_TOLERANCE, failures, rows };
}
/** `--ot6-fade`: Cutframe's frames 165–194 against the same frames of `file`; report.json in `output`. */
export async function runOt6Fade(file: string, o: { output?: string; store?: string; port?: number } = {}) {
  const out = await resolvedDestination(path.resolve(o.output ?? 'parity-reports/ot6-fade')), theirsFile = path.resolve(file);
  const slice = await ot6FadeSlice(o.store);
  const [run] = await exportRanges(slice.doc, slice.media, [OT6_FRAMES], out, { port: o.port, title: 'OT-6 fade slice' });
  if (run.error !== undefined || !run.file) throw Error(`The Cutframe export of frames ${OT6_FRAMES.join('-')} failed: ${JSON.stringify(run.error)}`);
  const [a, b] = OT6_FRAMES, n = b - a + 1, { width: W, height: H } = slice.doc.size;
  if (run.frames !== n) throw Error(`The Cutframe export of frames ${a}-${b} has ${run.frames} frames`);
  const frames = Array.from({ length: n }, (_, k) => a + k), ours = decodeFrames(run.file, frames.map(f => f - a), W, H), theirs = decodeFrames(theirsFile, frames, W, H);
  const { minSsim, alphaTolerance, failures, rows } = compareOt6Frames(slice.fadeAlphas, ours, theirs, W, H);
  const report = { version: 1, check: 'OT-6 fade slice (frames 165-194)', status: failures.length ? 'failed' : 'passed', minSsim, alphaTolerance,
    given: { file: theirsFile, stream: colourTags(theirsFile) }, ours: { file: run.file, stream: colourTags(run.file) }, media: slice.files as unknown as Json, failures, rows,
    note: 'Provisional, not Xapp parity until the research agent re-runs the stored export (D2, D34). The candidate uses BT.709 → sRGB on video and sRGB → BT.709 on every output pixel, with the plain fade formula. rows[].fittedAlpha is the reference-normalised output-domain diagnostic; SSIM and alpha gates are unchanged.' };
  await atomicJson(out, 'report.json', report);
  return report;
}
