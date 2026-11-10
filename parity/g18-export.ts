// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-18 … --export --modes <names> --frame-name <regex> --frame-time-unit ms|s|frame [--media speech=<file>]
// [--media action=<file>]` (results §12 decision 3): the G-18 render-mode export-frame comparison. The project the replay
// (parity/g18.ts) holds at its exportProject step, or at the end of the replay, carries all five caption tracks each in its own
// render mode; it is exported once by Cutframe's own export (T16a startExport / awaitExport, one range export per cluster of stored
// frames) in headless Chromium on a Vite dev server. ffmpeg decodes the exported frames and every stored frame
// frames/export/<mode>/<name> (results §12: frames N − 1, N and N + 1 at every word and caption boundary, per mode; frame index =
// round(t × fps)), and each pair is compared by mean SSIM over 8 × 8 windows of Rec. 709 luma >= 0.98, the metric of T16a's export
// checks. No alpha fit (that is the fade / dip case of G-08); captions are opaque draws over the video, so the stored frame decides
// parity directly. The per-mode subfolders only say which boundary a stored frame belongs to; the rendered content is the full
// composite at that frame's time, so the comparison is time-based and the mode is carried through to the report.
// The docs leave open the frame file names, the unit of their time and the exact spelling of the <mode> subfolders (results §12
// names the modes in prose, not as folder names; T00 harness runbook l.50), so --frame-name, --frame-time-unit and --modes are
// required and nothing is guessed: a frame name that gives no time, or a set of subfolders that is not exactly --modes, is refused.
// Provisional, not Xapp parity: the media are tos-speech-45s / tos-action-30s from the fixture store (checked against the manifest)
// or the files given with --media (their SHA-256 recorded, not checked); headless Chromium.
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Json } from './normalise';
import type { Diff } from './g01';
import { inside } from './runner';
import { sha256 } from './fixtures';
import { clusters, decodeFrames, exportRanges, matchExportFrames, MIN_SSIM, ssim, storeFile, TIME_UNITS, videoSize, type MediaFiles, type TimeUnit } from './g08-export';
import { exportPlan, fpsOf } from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';

// ---- Media: the replay's asset ids g18-speech-<n> / g18-action-<n> (parity/g18.ts captionAssets) become '@speech' / '@action'.
const FIXTURE_ID = /^g18-(speech|action)-\d+$/;
const CORPUS: Record<'speech' | 'action', string> = { speech: 'corpus/tos-speech-45s.mp4', action: 'corpus/tos-action-30s.mp4' };
export function withPlaceholders(doc: ProjectDocument): { doc: ProjectDocument; used: string[] } {
  const out = structuredClone(doc), used = new Set<string>();
  for (const i of out.items) {
    const id = i.metadata?.assetId;
    if (id === undefined) continue;
    const m = FIXTURE_ID.exec(String(id));
    if (!m) throw Error(`Item ${i.id} shows asset ${id}; the G-18 export runs tos-speech-45s and tos-action-30s only`);
    used.add(m[1]); i.metadata = { ...i.metadata, assetId: `@${m[1]}` };
  }
  return { doc: out, used: [...used].sort() };
}
async function mediaFiles(used: string[], given: MediaFiles, store: string | undefined) {
  const extra = Object.keys(given).filter(k => !used.includes(k));
  if (extra.length) throw Error(`--media ${extra.join(', ')}: the exported state has no clip of ${extra.join(' or ')}`);
  const files: Record<string, string> = {}, rows: Json[] = [];
  for (const name of used) {
    const file = (given as Record<string, string | undefined>)[name];
    if (file !== undefined) {
      const f = path.resolve(file);
      rows.push({ name, file: f, bytes: (await stat(f)).size, sha256: await sha256(f), check: 'recorded, not checked (--media)' }); files[name] = f;
      continue;
    }
    if (!store) throw Error(`CUTFRAME_FIXTURES must name the fixture store for ${name}, or pass --media ${name}=<file>`);
    const s = await storeFile(CORPUS[name as 'speech' | 'action'], store);
    rows.push({ name, ...s, check: 'fixture manifest (size and SHA-256)' }); files[name] = s.file;
  }
  return { files, rows };
}

// ---- The subfolders: the set in frames/export/ must be exactly --modes (an unlisted mode would be an unmeasured comparison).
export async function modeFolders(exportDir: string, modes: string[]): Promise<Record<string, string>> {
  const entries = await readdir(exportDir, { withFileTypes: true }), dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort(), want = [...modes].sort();
  if (JSON.stringify(dirs) !== JSON.stringify(want)) throw Error(`frames/export/ holds the subfolders [${dirs.join(', ') || '(none)'}] but --modes is [${want.join(', ')}]; name every render-mode subfolder and no other (results §12 names the modes in prose, not as folder names)`);
  return Object.fromEntries(modes.map(m => [m, path.join(exportDir, m)]));
}

export type ExportCompareOptions = { modes: string[]; frameName: string; frameUnit: TimeUnit; media?: MediaFiles; store?: string; port?: number };
export type G18Export = (doc: ProjectDocument, at: string, out: string) => Promise<{ diffs: Diff[]; summary: Json }>;
type StoredAt = { mode: string; file: string; frame: number };
export function compareExport(referenceDir: string, o: ExportCompareOptions): G18Export {
  if (!(TIME_UNITS as string[]).includes(o.frameUnit)) throw Error('--frame-time-unit must be ms, s or frame');
  if (!o.modes.length) throw Error('--modes needs at least one render-mode subfolder name');
  return async (doc, at, out) => {
    const base = await realpath(referenceDir), exportDir = await realpath(path.join(base, 'frames', 'export')).catch(() => { throw Error(`No frames/export/ folder in ${referenceDir}`); });
    if (!inside(base, exportDir)) throw Error('frames/export/ escapes the reference directory');
    const fps = fpsOf(doc), plan = exportPlan(doc);
    // A full export drops a leading gap (§53.8.2), so a stored frame index and a timeline frame could differ: refused, not guessed.
    if (plan.shiftMs > 0) throw Error(`The exported state starts with a ${plan.shiftMs} ms gap, which Cutframe's full export drops (§53.8.2); stored frame indices cannot be placed on the timeline`);
    const folders = await modeFolders(exportDir, o.modes), diffs: Diff[] = [], stored: StoredAt[] = [];
    for (const mode of o.modes) {
      const names = await readdir(folders[mode]);
      for (const f of matchExportFrames(names, o.frameName, o.frameUnit, fps)) stored.push({ mode, file: f.file, frame: f.frame });
    }
    const past = stored.filter(s => s.frame >= plan.count), inPlan = stored.filter(s => s.frame < plan.count);
    for (const s of past) diffs.push({ part: 'frame', path: `frames/export/${s.mode}/${s.file}`, expected: `frame ${s.frame}`, actual: null, note: `past the end of Cutframe's export (${plan.count} frames)` });
    const placed = withPlaceholders(doc), media = await mediaFiles(placed.used, o.media ?? {}, o.store ?? process.env.CUTFRAME_FIXTURES);
    const runs = await exportRanges(placed.doc, media.files, clusters([...new Set(inPlan.map(s => s.frame))]), out, { port: o.port, title: 'G-18 export' });
    const { width: W, height: H } = doc.size ?? { width: 1080, height: 1920 }, rows: { [key: string]: Json }[] = [];
    for (const run of runs) {
      const [a, b] = run.range, want = inPlan.filter(s => s.frame >= a && s.frame <= b);
      if (run.error !== undefined || !run.file) { for (const s of want) diffs.push({ part: 'frame', path: `frames/export/${s.mode}/${s.file}`, expected: 'an exported frame', actual: run.error ?? null, note: `the export of frames ${a}-${b} failed` }); continue; }
      if (run.frames !== b - a + 1) throw Error(`The export of frames ${a}-${b} has ${run.frames} frames`);
      const exported = decodeFrames(run.file, want.map(s => s.frame - a), W, H);
      for (const s of want) {
        const t = s.frame * 1000 / fps, png = path.join(folders[s.mode], s.file), size = videoSize(png), at = `frames/export/${s.mode}/${s.file}`;
        const row: { [key: string]: Json } = { mode: s.mode, file: s.file, frame: s.frame, timeMs: Math.round(t * 1000) / 1000, size: [size.width, size.height] };
        rows.push(row);
        if (size.width !== W || size.height !== H) { diffs.push({ part: 'frame', path: `${at}.size`, expected: [W, H], actual: [size.width, size.height] }); continue; }
        const value = row.ssim = ssim(exported.get(s.frame - a)!, decodeFrames(png, [0], W, H).get(0)!, W, H);
        if (value < MIN_SSIM) diffs.push({ part: 'frame', path: `${at}.ssim`, expected: `>= ${MIN_SSIM}`, actual: value, note: `${s.mode} caption frame at ${row.timeMs} ms` });
      }
    }
    const byMode: Record<string, { frames: number; minSsim: number | null; failed: number }> = {};
    for (const r of rows) {
      const k = String(r.mode), e = byMode[k] ??= { frames: 0, minSsim: null, failed: 0 };
      e.frames++;
      if (typeof r.ssim === 'number') e.minSsim = e.minSsim === null ? r.ssim : Math.min(e.minSsim, r.ssim);
      if (diffs.some(d => d.path.startsWith(`frames/export/${r.mode}/${r.file}.`))) e.failed++;
    }
    return { diffs, summary: { fps, minSsim: MIN_SSIM, frameName: o.frameName, frameUnit: o.frameUnit, modes: o.modes, frames: rows.length, stored: stored.length,
      media: media.rows, byMode, ranges: runs.map(r => ({ range: r.range, file: r.file ?? null, error: r.error ?? null })), rows } };
  };
}
