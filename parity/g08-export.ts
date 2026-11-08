// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-08 … --export --frame-name <regex> --frame-time-unit ms|s|frame --windows <spec> [--media S1=<file>]
// [--media S2c=<file>] [--export-ffprobe <file>]` (T11 integration round, coordinator decisions QE1–QE5): the G-08 export-frame
// comparison (results §11, tickets l.154). The project the replay (parity/g08.ts) holds at its exportProject step, or at the end
// of the replay when it has none, is exported by Cutframe's own export (T16a startExport / awaitExport, one range export per
// cluster of stored frames) in headless Chromium on a Vite dev server. ffmpeg decodes the exported frames and every stored
// frame frames/export/<name> (results §11: frame index = round(t × 30)), and each pair is compared:
//   - mean SSIM over 8 × 8 windows of Rec. 709 luma >= 0.98, the same metric as T16a's export checks (tests/ui/t10a-support.ts);
//   - for fade and dip, the least-squares alpha within ±0.06 of the formula (QE2; results §11 decision 2: for these two kinds the
//     stored frames decide parity; D34 adds the export colour tables around the plain formula, with no fade exponent).
// Every window of frames/export/_windows.json is matched with a Cutframe transition window (start and length within 1 frame,
// own provisional tolerance). With --export-ffprobe, the stored export's video frame count is compared with Cutframe's.
// The docs leave open the frame file names, the unit of their time and the schema of _windows.json (T00 harness runbook
// l.50), so each is a required flag and nothing is guessed; a name, field or entry that does not fit is refused by name.
// Provisional, not Xapp parity: the media are S1 from the fixture store (checked against the manifest) or the files given with
// --media (always for S2c, which is not in our store: QE4; their SHA-256 is recorded, not checked); headless Chromium.
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from './normalise';
import type { Diff } from './g01';
import { inside } from './runner';
import { fixturePath, manifestFiles, sha256 } from './fixtures';
import { exportPlan, fpsOf } from '../apps/web/src/render/model';
import { ALPHA_TOLERANCE, MIN_SSIM, alphaFit, ssim } from './transition-metrics';
import { progressAt, windowOf, type Window } from '../apps/web/src/timeline/transitions';
import type { ProjectDocument } from '../apps/web/src/store/model';

export type TimeUnit = 'ms' | 's' | 'frame';
export const TIME_UNITS: TimeUnit[] = ['ms', 's', 'frame'];
/** Stored frames closer than this many frames share one range export. */
export const CLUSTER_GAP = 15;
export const WINDOWS_FILE = '_windows.json';
const INDEX_FILE = '_index.json';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S1_FILE = 'synthetic/S1-framecount-1080x1920-30fps-10s.mp4';

export const toMs = (v: number, unit: TimeUnit, fps: number) => unit === 'ms' ? v : unit === 's' ? v * 1000 : v * 1000 / fps;
const keysOf = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).join(', ') || '(none)' : Array.isArray(v) ? '(an array)' : typeof v;
const numeric = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;

// ---- _windows.json: `--windows start=<field>,length=<field>,label=<field>,unit=ms|s|frame[,list=<key>]`.
export type WindowSpec = { start: string; length: string; label: string; unit: TimeUnit; list?: string };
export function parseWindowSpec(text: string): WindowSpec {
  const o: Record<string, string> = {};
  for (const part of text.split(',')) {
    const m = /^\s*(start|length|label|unit|list)=(.+?)\s*$/.exec(part);
    if (!m || m[1] in o) throw Error(`--windows: '${part}' is not one of start=<field>, length=<field>, label=<field>, unit=ms|s|frame, list=<key> (each once)`);
    o[m[1]] = m[2];
  }
  const missing = ['start', 'length', 'label', 'unit'].filter(k => !(k in o));
  if (missing.length) throw Error(`--windows needs ${missing.join(', ')}: the field names and the unit of frames/export/_windows.json are not documented (T00 harness runbook l.50)`);
  if (!(TIME_UNITS as string[]).includes(o.unit)) throw Error('--windows unit must be ms, s or frame');
  return { start: o.start, length: o.length, label: o.label, unit: o.unit as TimeUnit, ...(o.list === undefined ? {} : { list: o.list }) };
}
export type StoredWindow = { label: string; startMs: number; lengthMs: number };
export function storedWindows(json: unknown, spec: WindowSpec, fps: number): StoredWindow[] {
  const list = spec.list === undefined ? json : json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>)[spec.list] : undefined;
  const keyed = spec.list === undefined && list && typeof list === 'object' && !Array.isArray(list) ? Object.entries(list) : null;
  if (!Array.isArray(list) && !(keyed?.length && keyed.every(([, w]) => w && typeof w === 'object' && !Array.isArray(w)))) throw Error(spec.list === undefined ? `${WINDOWS_FILE} is not an array: pass list=<key> in --windows (its top-level keys: ${keysOf(json)})` : `${WINDOWS_FILE} has no array '${spec.list}' (its top-level keys: ${keysOf(json)})`);
  const entries: [string, unknown][] = Array.isArray(list) ? list.map((w, i) => [String(i), w]) : keyed!;
  return entries.map(([i, w]) => {
    const r = (w && typeof w === 'object' && !Array.isArray(w) ? w : {}) as Record<string, unknown>, missing = [spec.start, spec.length, spec.label].filter(f => !(f in r));
    if (missing.length) throw Error(`${WINDOWS_FILE} entry ${i} has no ${missing.map(f => `'${f}'`).join(', ')}; its keys are: ${keysOf(w)}`);
    const start = numeric(r[spec.start]), length = numeric(r[spec.length]);
    if (!Number.isFinite(start) || !Number.isFinite(length)) throw Error(`${WINDOWS_FILE} entry ${i}: '${spec.start}' and '${spec.length}' must be numbers`);
    return { label: String(r[spec.label]), startMs: toMs(start, spec.unit, fps), lengthMs: toMs(length, spec.unit, fps) };
  });
}

// ---- Cutframe's windows (§55.2, timeline/transitions.ts windowOf) and the match with the stored ones.
export type OurWindow = Window & { id: string; kind: string; direction?: string; params?: Json; fromId: string; toId: string };
export function ourWindows(doc: ProjectDocument): OurWindow[] {
  return (doc.transitions ?? []).flatMap(r => {
    const w = windowOf(doc, r);
    return w ? [{ id: String(r.id), kind: String(r.kind), ...(r.direction === undefined ? {} : { direction: String(r.direction) }), ...(r.params === undefined ? {} : { params: r.params as Json }),
      fromId: String(r.fromId), toId: String(r.toId), ...w }] : [];
  }).sort((a, b) => a.start - b.start);
}
/** Each stored window takes the unmatched Cutframe window whose start is nearest; start and length must agree within 1 frame. */
export function checkWindows(stored: StoredWindow[], ours: OurWindow[], fps: number) {
  const tol = 1000 / fps + 1e-6, used = new Set<number>(), diffs: Diff[] = [], rows: Json[] = [];
  for (const s of stored) {
    let best = -1;
    ours.forEach((o, i) => { if (!used.has(i) && (best < 0 || Math.abs(o.start - s.startMs) < Math.abs(ours[best].start - s.startMs))) best = i; });
    const o = best < 0 ? undefined : ours[best], at = `${WINDOWS_FILE}[${s.label}]`;
    if (!o || Math.abs(o.start - s.startMs) > tol) {
      diffs.push({ part: 'frame', path: `${at}.start`, expected: s.startMs, actual: o?.start ?? null, note: 'no Cutframe transition window starts within 1 frame of this stored window' });
      rows.push({ label: s.label, startMs: s.startMs, lengthMs: s.lengthMs, ours: null });
      continue;
    }
    used.add(best);
    rows.push({ label: s.label, startMs: s.startMs, lengthMs: s.lengthMs, ours: { id: o.id, kind: o.kind, ...(o.direction ? { direction: o.direction } : {}), startMs: o.start, lengthMs: o.end - o.start } });
    if (Math.abs(o.end - o.start - s.lengthMs) > tol) diffs.push({ part: 'frame', path: `${at}.length`, expected: s.lengthMs, actual: o.end - o.start, note: `Cutframe window ${o.id} (${o.kind}) differs by more than 1 frame` });
  }
  ours.forEach((o, i) => { if (!used.has(i)) diffs.push({ part: 'frame', path: `window ${o.id}`, expected: null, actual: { kind: o.kind, startMs: o.start, lengthMs: o.end - o.start }, note: `a Cutframe transition window with no window in ${WINDOWS_FILE}` }); });
  return { rows, diffs };
}
/** The window a timeline time falls in: start <= t < end with its progress, else the window ending exactly at t (its 100 % point, p null). */
export function windowAt(ours: OurWindow[], t: number): { w: OurWindow; p: number | null } | undefined {
  for (const w of ours) { const p = progressAt(t, w); if (p !== null) return { w, p }; }
  const done = ours.find(o => Math.abs(t - o.end) <= 1e-6);
  return done && { w: done, p: null };
}

// ---- Stored frame names: `--frame-name <regex>`, group 1 = the time in --frame-time-unit; frame = round(t × fps) (results §11).
export type StoredFrame = { file: string; frame: number };
export function matchExportFrames(names: string[], pattern: string, unit: TimeUnit, fps: number): StoredFrame[] {
  if (!(TIME_UNITS as string[]).includes(unit)) throw Error('--frame-time-unit must be ms, s or frame');
  let re: RegExp;
  try { re = new RegExp(pattern); } catch (e) { throw Error(`--frame-name is not a regular expression: ${(e as Error).message}`); }
  if (new RegExp(`${pattern}|`).exec('')!.length < 2) throw Error('--frame-name needs a capture group: group 1 is the frame time');
  const out: StoredFrame[] = [], seen = new Map<number, string>();
  for (const file of names.filter(n => n !== WINDOWS_FILE && n !== INDEX_FILE).sort()) {
    const v = re.exec(file)?.[1];
    if (v === undefined || !(unit === 'frame' ? /^\d+$/ : /^\d+(\.\d+)?$/).test(v)) throw Error(`frames/export/${file}: --frame-name gives no time in ${unit === 'frame' ? 'whole frames' : unit} (group 1: ${v ?? 'no match'})`);
    const frame = unit === 'frame' ? Number(v) : Math.round(Number(v) * fps / (unit === 's' ? 1 : 1000));
    if (seen.has(frame)) throw Error(`frames/export/${seen.get(frame)} and frames/export/${file} both name frame ${frame}`);
    seen.set(frame, file); out.push({ file, frame });
  }
  if (!out.length) throw Error('frames/export/ holds no stored frame');
  return out.sort((a, b) => a.frame - b.frame);
}
export function clusters(frames: number[], gap = CLUSTER_GAP): [number, number][] {
  const out: [number, number][] = [];
  for (const f of [...new Set(frames)].sort((a, b) => a - b)) { const last = out.at(-1); if (last && f - last[1] <= gap) last[1] = f; else out.push([f, f]); }
  return out;
}
/** The export range of frames a…b: floor(startS × fps) = a and ceil(endS × fps) − 1 = b (export/prep.ts, §53.8.4), inside the timeline. */
export const rangeOf = ([a, b]: [number, number], fps: number, durationMs: number) => ({ startS: (a + 0.5) / fps, endS: Math.min((b + 0.5) / fps, durationMs / 1000) });

// ---- Metrics: parity/transition-metrics.ts (shared with ot6-fade.ts and tests/ui/t11-export.spec.ts), re-exported here.
export { ALPHA_TOLERANCE, MIN_SSIM, alphaFit, ssim };

// ---- ffmpeg.
function ff(tool: 'ffmpeg' | 'ffprobe', args: string[]): Buffer {
  const r = spawnSync(tool, args, { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw Error(`${tool} ${args.join(' ')}: ${String(r.stderr ?? r.error).slice(-400)}`);
  return r.stdout;
}
export const videoSize = (file: string) => {
  const s = JSON.parse(ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]).toString()).streams?.[0];
  if (!s) throw Error(`${file} has no video stream`);
  return { width: Number(s.width), height: Number(s.height) };
};
/** Frames n (0-based, presentation order) of a video or a single image as RGBA, decoded by ffmpeg with the stream's own colour tags. */
export function decodeFrames(file: string, frames: number[], width: number, height: number): Map<number, Uint8Array> {
  const want = [...new Set(frames)].sort((a, b) => a - b), size = width * height * 4;
  const buf = ff('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', `select=${want.map(n => `eq(n\\,${n})`).join('+')}`, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  if (buf.length !== want.length * size) throw Error(`${file}: ${buf.length / size} of the ${want.length} frames ${want.join(', ')} decoded at ${width} x ${height}`);
  return new Map(want.map((n, k) => [n, new Uint8Array(buf.buffer, buf.byteOffset + k * size, size)]));
}

// ---- The browser session: Vite serves apps/web; the project is created, the media uploaded and attached, the editor opened
// (T14 ingest), then each range is exported through startExport / awaitExport and the file handed back.
const PAGE_SETUP = `async ({ doc, title, media }) => {
  const { projectStore } = await import('/src/store/database.ts');
  const id = (await projectStore.create(title, doc)).id, ids = {};
  for (const [key, name] of Object.entries(media)) {
    const blob = await (await fetch('/__g08/media/' + encodeURIComponent(key))).blob();
    const asset = await projectStore.upload(new File([blob], name, { type: 'video/mp4' }));
    await projectStore.attach(id, asset.id); ids[key] = asset.id;
  }
  const { document } = await projectStore.read(id);
  for (const i of document.items) {
    const ref = String(i.metadata?.assetId ?? '');
    if (ref.startsWith('@')) { if (!ids[ref.slice(1)]) throw new Error('No media for ' + ref); i.metadata = { ...i.metadata, assetId: ids[ref.slice(1)] }; }
  }
  await projectStore.save(id, document, document.rev);
  return id;
}`;
const PAGE_READY = `async () => {
  if (document.querySelector('[role=status]')?.textContent !== 'Saved locally') return false;
  const { projectStore } = await import('/src/store/database.ts');
  return (await projectStore.library()).assets.every(a => a.processing_status === 'ready' || a.processing_status === 'failed');
}`;
const PAGE_EXPORT = `async ({ id, range }) => {
  const { projectStore } = await import('/src/store/database.ts'), ex = await import('/src/export/index.ts');
  const { document } = await projectStore.read(id);
  const renderId = ex.startExport({ store: projectStore, doc: document, title: 'G-08 export', range });
  const st = await ex.awaitExport(renderId);
  if (st.status !== 'completed') return { error: st.error };
  const { blob, frames, size, fps, codec, audioCodec } = st.result, bytes = new Uint8Array(await blob.arrayBuffer());
  ex.releaseExport(renderId);
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), frames, size, fps, codec, audioCodec };
}`;
export type RangeRun = { range: [number, number]; file?: string; frames?: number; size?: { width: number; height: number }; codec?: string; error?: Json };
/** Exports frames a…b of `doc` for each range, in one browser session. `doc` names its media '@<key>' in metadata.assetId; `media`
 *  maps each key to a file. The files are written to <out>/export/frames-<a>-<b>.mp4. */
export async function exportRanges(doc: ProjectDocument, media: Record<string, string>, ranges: [number, number][], out: string, o: { port?: number; title?: string } = {}): Promise<RangeRun[]> {
  const fps = fpsOf(doc), dir = path.join(out, 'export');
  await mkdir(dir, { recursive: true });
  const { createServer } = await import('vite'), { chromium } = await import('@playwright/test');
  const server = await createServer({ configFile: path.join(REPO, 'vite.config.ts'), root: path.join(REPO, 'apps/web'), cacheDir: path.join(os.tmpdir(), 'cutframe-g08-export-vite'),
    server: { host: '127.0.0.1', port: o.port ?? 0, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const base = server.resolvedUrls!.local[0], page = await browser.newPage();
    await page.route(`${base}__g08/**`, route => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.slice('/__g08/'.length)), file = name.startsWith('media/') ? media[name.slice(6)] : undefined;
      return name === 'page' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>G-08 export</title>' }) : file ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
    });
    await page.goto(`${base}__g08/page`);
    const names = Object.fromEntries(Object.entries(media).map(([k, f]) => [k, path.basename(f)]));
    const id = await page.evaluate(`(${PAGE_SETUP})(${JSON.stringify({ doc, title: o.title ?? 'G-08 export', media: names })})`) as string;
    await page.goto(`${base}project/${id}`);
    await page.waitForFunction(`(${PAGE_READY})()`, undefined, { timeout: 180_000, polling: 250 });
    const failed = await page.evaluate(`(async () => (await (await import('/src/store/database.ts')).projectStore.library()).assets.filter(a => a.processing_status === 'failed').map(a => a.name))()`) as string[];
    if (failed.length) throw Error(`Ingest failed for ${failed.join(', ')}`);
    let reloaded = false;
    page.on('framenavigated', f => { if (f === page.mainFrame()) reloaded = true; });
    const runs: RangeRun[] = [];
    for (const r of ranges) {
      const res = await page.evaluate(`(${PAGE_EXPORT})(${JSON.stringify({ id, range: rangeOf(r, fps, doc.duration) })})`) as { error?: Json; b64?: string; frames: number; size: { width: number; height: number }; codec: string };
      if (reloaded) throw Error('The export page reloaded during the run (Vite re-optimised its dependencies); run again');
      if (res.error !== undefined) { runs.push({ range: r, error: res.error }); continue; }
      const file = path.join(dir, `frames-${r[0]}-${r[1]}.mp4`);
      await writeFile(file, Buffer.from(res.b64!, 'base64'));
      runs.push({ range: r, file, frames: res.frames, size: res.size, codec: res.codec });
    }
    return runs;
  } finally { await browser.close(); await server.close(); }
}

// ---- Media: the replay's asset ids g08-S1-<n> / g08-S2c-<n> (parity/g08.ts transitionAssets) become '@S1' / '@S2c'.
const FIXTURE_ID = /^g08-(S1|S2c)-\d+$/;
export function withPlaceholders(doc: ProjectDocument): { doc: ProjectDocument; used: string[] } {
  const out = structuredClone(doc), used = new Set<string>();
  for (const i of out.items) {
    const id = i.metadata?.assetId;
    if (id === undefined) continue;
    const m = FIXTURE_ID.exec(String(id));
    if (!m) throw Error(`Item ${i.id} shows asset ${id}; the G-08 export runs S1 and S2c only`);
    used.add(m[1]); i.metadata = { ...i.metadata, assetId: `@${m[1]}` };
  }
  return { doc: out, used: [...used].sort() };
}
/** A fixture-store file checked against fixtures/Cutframe test fixtures (C).md (size and SHA-256). */
export async function storeFile(relative: string, store = process.env.CUTFRAME_FIXTURES) {
  if (!store) throw Error(`CUTFRAME_FIXTURES must name the fixture store (for ${relative})`);
  const entry = manifestFiles(await readFile(path.join(REPO, 'fixtures/Cutframe test fixtures (C).md'), 'utf8')).find(f => f.relative === relative);
  if (!entry) throw Error(`The fixture manifest has no ${relative}`);
  const file = await fixturePath(entry, store, REPO);
  if ((await stat(file)).size !== entry.bytes || await sha256(file) !== entry.sha256) throw Error(`Fixture mismatch: ${relative}`);
  return { file, bytes: entry.bytes, sha256: entry.sha256 };
}
export type MediaFiles = Partial<Record<'S1' | 'S2c', string>>;
async function mediaFiles(used: string[], given: MediaFiles, store: string | undefined) {
  const extra = Object.keys(given).filter(k => !used.includes(k));
  if (extra.length) throw Error(`--media ${extra.join(', ')}: the exported state has no clip of ${extra.join(' or ')}`);
  const files: Record<string, string> = {}, rows: Json[] = [];
  for (const name of used) {
    const file = given[name as keyof MediaFiles];
    if (file !== undefined) {
      const f = path.resolve(file);
      rows.push({ name, file: f, bytes: (await stat(f)).size, sha256: await sha256(f), check: 'recorded, not checked (--media)' }); files[name] = f;
      continue;
    }
    if (name !== 'S1') throw Error('--media S2c=<file> is needed: S2c, the centre 9:16 crop of S2, is not in our fixture store (coordinator decision QE4)');
    if (!store) throw Error('CUTFRAME_FIXTURES must name the fixture store for S1, or pass --media S1=<file>');
    const s = await storeFile(S1_FILE, store);
    rows.push({ name, ...s, check: 'fixture manifest (size and SHA-256)' }); files[name] = s.file;
  }
  return { files, rows };
}

// ---- The comparison.
/** The checks of one stored frame `at` (frames/export/<file>) against Cutframe's frame, both W × H RGBA: SSIM >= MIN_SSIM and,
 *  for a fade or dip-to-colour frame inside its window, the least-squares alpha within ALPHA_TOLERANCE of the formula (the
 *  ticket's ±0.06 for Xapp's frames, implementation tickets l.154). `fields` go into the frame's report row. */
export function checkFrame(at: string, hit: ReturnType<typeof windowAt>, theirs: Uint8Array, mine: Uint8Array, W: number, H: number) {
  const fields: { [key: string]: Json } = {}, diffs: Diff[] = [], s = fields.ssim = ssim(mine, theirs, W, H);
  if (s < MIN_SSIM) diffs.push({ part: 'frame', path: `${at}.ssim`, expected: `>= ${MIN_SSIM}`, actual: s, note: hit ? `${hit.w.kind} ${hit.w.id} at p ${hit.p ?? 1}` : 'no transition at this frame' });
  const fit = hit && hit.p !== null ? alphaFit(hit.w.kind, hit.p, hit.w.params, theirs, mine) : null;
  if (fit) {
    fields.alpha = fit.alpha; fields.fittedAlpha = fit.fitted;
    if (Math.abs(fit.fitted - fit.alpha) > ALPHA_TOLERANCE) diffs.push({ part: 'frame', path: `${at}.alpha`, expected: fit.alpha, actual: fit.fitted, note: `least-squares ${hit!.w.kind} alpha off the formula by more than ${ALPHA_TOLERANCE} (QE2)` });
  }
  return { fields, diffs };
}
export type ExportCompareOptions = { frameName: string; frameUnit: TimeUnit; windows: WindowSpec; media?: MediaFiles; exportProbe?: string; store?: string; port?: number };
/** The export comparison runG08 calls (`export` option) with the exported state, where it was taken and the report directory. */
export type G08Export = (doc: ProjectDocument, at: string, out: string) => Promise<{ diffs: Diff[]; summary: Json }>;
export function compareExport(referenceDir: string, o: ExportCompareOptions): G08Export {
  if (!(TIME_UNITS as string[]).includes(o.frameUnit)) throw Error('--frame-time-unit must be ms, s or frame');
  return async (doc, at, out) => {
    const base = await realpath(referenceDir), folder = await realpath(path.join(base, 'frames', 'export')).catch(() => { throw Error(`No frames/export/ folder in ${referenceDir}`); });
    if (!inside(base, folder)) throw Error('frames/export/ escapes the reference directory');
    const fps = fpsOf(doc), plan = exportPlan(doc);
    // A full export drops a leading gap (§53.8.2), so a stored frame index and a timeline frame could differ: refused, not guessed.
    if (plan.shiftMs > 0) throw Error(`The exported state starts with a ${plan.shiftMs} ms gap, which Cutframe's full export drops (§53.8.2); stored frame indices cannot be placed on the timeline`);
    const names = await readdir(folder);
    if (!names.includes(WINDOWS_FILE)) throw Error(`No frames/export/${WINDOWS_FILE}`);
    if (names.includes(INDEX_FILE)) {
      const file = await realpath(path.join(folder, INDEX_FILE));
      if (!inside(folder, file)) throw Error(`frames/export/${INDEX_FILE} escapes the reference directory`);
      const text = await readFile(file, 'utf8');
      // Research 3.8: an array of {name, frame, file} that adds nothing the file names lack, so validate JSON and read no mapping from it.
      try { JSON.parse(text); } catch { throw Error(`frames/export/${INDEX_FILE} is not valid JSON`); }
    }
    const stored = matchExportFrames(names, o.frameName, o.frameUnit, fps), ours = ourWindows(doc);
    const windows = checkWindows(storedWindows(JSON.parse(await readFile(path.join(folder, WINDOWS_FILE), 'utf8')), o.windows, fps), ours, fps), diffs: Diff[] = [...windows.diffs];

    let frameCount: Json = { ours: plan.count, stored: null, note: 'not compared: pass --export-ffprobe <the stored export\'s ffprobe JSON>' };
    if (o.exportProbe !== undefined) {
      const f = await realpath(path.resolve(base, o.exportProbe)).catch(() => { throw Error(`--export-ffprobe: no file ${o.exportProbe} in ${referenceDir}`); });
      if (!inside(base, f)) throw Error('--export-ffprobe escapes the reference directory');
      const probe = JSON.parse(await readFile(f, 'utf8')), v = Array.isArray(probe?.streams) ? probe.streams.find((s: { codec_type?: string }) => s?.codec_type === 'video') : undefined;
      if (!v) throw Error(`--export-ffprobe ${o.exportProbe} has no video stream (its top-level keys: ${keysOf(probe)})`);
      const n = numeric(v.nb_frames ?? v.nb_read_frames);
      if (!Number.isFinite(n)) throw Error(`--export-ffprobe ${o.exportProbe}: the video stream has no nb_frames or nb_read_frames (its keys: ${keysOf(v)})`);
      frameCount = { ours: plan.count, stored: n };
      if (n !== plan.count) diffs.push({ part: 'frame', path: 'exports.frameCount', expected: n, actual: plan.count, note: 'video frames of the stored export (ffprobe) and of Cutframe\'s export plan (§53.8.4)' });
    }

    const past = stored.filter(s => s.frame >= plan.count), inPlan = stored.filter(s => s.frame < plan.count);
    for (const s of past) diffs.push({ part: 'frame', path: `frames/export/${s.file}`, expected: `frame ${s.frame}`, actual: null, note: `past the end of Cutframe's export (${plan.count} frames)` });
    const placed = withPlaceholders(doc), media = await mediaFiles(placed.used, o.media ?? {}, o.store ?? process.env.CUTFRAME_FIXTURES);
    const runs = await exportRanges(placed.doc, media.files, clusters(inPlan.map(s => s.frame)), out, { port: o.port });
    const { width: W, height: H } = doc.size ?? { width: 1080, height: 1920 }, rows: { [key: string]: Json }[] = [];
    for (const run of runs) {
      const [a, b] = run.range, want = inPlan.filter(s => s.frame >= a && s.frame <= b);
      if (run.error !== undefined || !run.file) { for (const s of want) diffs.push({ part: 'frame', path: `frames/export/${s.file}`, expected: 'an exported frame', actual: run.error ?? null, note: `the export of frames ${a}-${b} failed` }); continue; }
      if (run.frames !== b - a + 1) throw Error(`The export of frames ${a}-${b} has ${run.frames} frames`);
      const exported = decodeFrames(run.file, want.map(s => s.frame - a), W, H);
      for (const s of want) {
        const t = s.frame * 1000 / fps, hit = windowAt(ours, t), png = path.join(folder, s.file), size = videoSize(png), at = `frames/export/${s.file}`;
        const row: { [key: string]: Json } = { file: s.file, frame: s.frame, timeMs: Math.round(t * 1000) / 1000, window: hit ? hit.w.id : null, kind: hit ? hit.w.kind : null, p: hit?.p ?? null,
          ...(hit?.w.direction ? { direction: hit.w.direction } : {}), size: [size.width, size.height] };
        rows.push(row);
        if (size.width !== W || size.height !== H) { diffs.push({ part: 'frame', path: `${at}.size`, expected: [W, H], actual: [size.width, size.height] }); continue; }
        const checked = checkFrame(at, hit, decodeFrames(png, [0], W, H).get(0)!, exported.get(s.frame - a)!, W, H);
        Object.assign(row, checked.fields); diffs.push(...checked.diffs);
      }
    }
    const byKind: Record<string, { frames: number; minSsim: number | null; failed: number }> = {};
    for (const r of rows) {
      const k = String(r.kind ?? 'none'), e = byKind[k] ??= { frames: 0, minSsim: null, failed: 0 };
      e.frames++;
      if (typeof r.ssim === 'number') e.minSsim = e.minSsim === null ? r.ssim : Math.min(e.minSsim, r.ssim);
      if (diffs.some(d => d.path.startsWith(`frames/export/${r.file}.`))) e.failed++;
    }
    return { diffs, summary: { fps, minSsim: MIN_SSIM, alphaTolerance: ALPHA_TOLERANCE, windowTolerance: '1 frame (own, provisional)', frameName: o.frameName, frameUnit: o.frameUnit,
      windows: { stored: windows.rows.length, ours: ours.length, rows: windows.rows }, frameCount, media: media.rows, frames: rows.length, byKind, ranges: runs.map(r => ({ range: r.range, file: r.file ?? null, error: r.error ?? null })), rows } };
  };
}
