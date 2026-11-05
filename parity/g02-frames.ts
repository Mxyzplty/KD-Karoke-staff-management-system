// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-02 … --frames --frame-time-unit ms|s|frame` (T15): each stored captureFrame step is run again on the
// project as the replay (parity/g02.ts) left it, by Cutframe's own captureFrame (render/capture.ts) in headless Chromium on a
// Vite dev server, and every image is compared with the stored preview frame frames/F1-<t>.jpg / F2-<t>.jpg (tickets l.69,
// G-02 item (3)): as pictures within FRAME_LEVEL_TOLERANCE (parity/frame-tolerance.ts, the formula-oracle tolerance of
// T15 / T16), and where the burned-in number is readable (sample times before 1 s) by S1's counter (parity/s1-counter.ts).
// The unit of <t> is open in the docs (T00 harness runbook l.50), so it is a required flag; every file name must parse and
// match exactly one stored timestamp of its state, and every stored timestamp exactly one file.
// Provisional, not Xapp parity: S1 is captured from the original, not a proxy (the replay prepares no media); the browser is
// headless Chromium (software 2D canvas); the stored frames' renderer and JPEG encoder are unknown, so each frame reports
// whether its JPEG quantization tables and chroma sampling equal ours.
import { readdir, readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from './normalise';
import type { Diff } from './g01';
import type { G02Capture, G02Frames } from './g02';
import { inside } from './runner';
import { fixturePath, manifestFiles, sha256 } from './fixtures';
import { FRAME_LEVEL_TOLERANCE } from './frame-tolerance';
import { COUNTER, counterCrops, counterRegion, readCounter } from './s1-counter';
import { apply, cover, fpsOf, framePlan, frameTime, previewFrame } from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';

export type FrameTimeUnit = 'ms' | 's' | 'frame';
export const FRAME_TIME_UNITS: FrameTimeUnit[] = ['ms', 's', 'frame'];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S1_FILE = 'synthetic/S1-framecount-1080x1920-30fps-10s.mp4';
/** S1's display size (fixture manifest l.53), the source px the counter region is given in. */
const S1_W = 1080, S1_H = 1920;
/** Tickets l.69: the burned-in number is readable at the sample times before 1 s; after the remap these two were checked by eye. */
const READABLE_BEFORE_S = 1, EYE_CHECKED: Record<string, number> = { 'F2:0.516667': 5, 'F2:0.75': 11 };

// ---- File names → stored timestamps.
export type FrameRef = { file: string; timestamp: number };
/** For each capture id, the stored frame file of each of its timestamps, in input order. Throws on any name that does not
 *  parse, matches no stored timestamp or more than one, two names for one timestamp, or a timestamp without a file. */
export function matchFrames(names: string[], captures: G02Capture[], unit: FrameTimeUnit): Record<string, FrameRef[]> {
  if (!FRAME_TIME_UNITS.includes(unit)) throw Error(`--frame-time-unit must be one of ${FRAME_TIME_UNITS.join(', ')}`);
  const wanted = captures.flatMap(c => {
    const ts = (c.input as { timestamps?: unknown } | null)?.timestamps;
    if (!Array.isArray(ts) || !ts.length || ts.some(t => typeof t !== 'number' || !Number.isFinite(t))) throw Error(`captureFrame step ${c.id} has no stored timestamps array, so its frames cannot be named`);
    return (ts as number[]).map((t, k) => ({ id: c.id, state: c.state, k, t, frame: previewFrame(t * 1000, fpsOf(c.doc)), file: '' }));
  });
  for (const name of names) {
    const m = /^(F1|F2)-(.+)\.jpg$/.exec(name), v = m?.[2] ?? '';
    if (!m || !(unit === 'frame' ? /^\d+$/ : /^\d+(\.\d+)?$/).test(v)) throw Error(`frames/${name}: not F1-<t>.jpg or F2-<t>.jpg with <t> in ${unit === 'frame' ? 'whole frames' : unit}`);
    // A decimal name stands for every time it rounds to (half of its last digit either side); an exact match wins over those.
    const half = 0.5 * 10 ** -(v.split('.')[1]?.length ?? 0) + 1e-9, n = Number(v), off = (w: { t: number }) => Math.abs((unit === 's' ? w.t : w.t * 1000) - n);
    const near = wanted.filter(w => w.state === m[1] && (unit === 'frame' ? w.frame === n : off(w) <= half)), exact = unit === 'frame' ? [] : near.filter(w => off(w) < 1e-9);
    const hits = exact.length === 1 ? exact : near;
    if (!hits.length) throw Error(`frames/${name} matches no stored ${m[1]} captureFrame timestamp (unit ${unit})`);
    if (hits.length > 1) throw Error(`frames/${name} matches ${hits.length} stored timestamps (${hits.map(h => `${h.id}: ${h.t}`).join(', ')})`);
    if (hits[0].file) throw Error(`frames/${hits[0].file} and frames/${name} both name ${hits[0].id}'s timestamp ${hits[0].t}`);
    hits[0].file = name;
  }
  const missing = wanted.filter(w => !w.file);
  if (missing.length) throw Error(`No stored frame for ${missing.map(w => `${w.id} ${w.state} ${w.t} s`).join(', ')} (unit ${unit})`);
  const out: Record<string, FrameRef[]> = {};
  for (const w of wanted) (out[w.id] ??= [])[w.k] = { file: w.file, timestamp: w.t };
  return out;
}

// ---- JPEG headers: size, quantization tables and chroma sampling (the encoder's choices).
export function jpegInfo(b: Buffer) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw Error('not a JPEG file');
  let at = 2, width = 0, height = 0, sampling = ''; const dqt: string[] = [];
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const len = b.readUInt16BE(at + 2), seg = b.subarray(at + 4, at + 2 + len);
    if (marker === 0xdb) dqt.push(seg.toString('hex'));
    if (marker >= 0xc0 && marker <= 0xc2) {
      height = seg.readUInt16BE(1); width = seg.readUInt16BE(3);
      sampling = Array.from({ length: seg[5] }, (_, i) => `${seg[6 + i * 3 + 1] >> 4}x${seg[6 + i * 3 + 1] & 15}`).join(',');
    }
    at += 2 + len;
  }
  if (!width || !height) throw Error('JPEG has no frame header');
  return { width, height, encoder: `${sampling};${dqt.join(';')}` };
}

// ---- The browser session: Vite serves apps/web, a blank page imports the modules, S1 is uploaded once.
const PAGE_UPLOAD = `async ({ name }) => {
  const { projectStore } = await import('/src/store/database.ts');
  const blob = await (await fetch('/__g02/S1.mp4')).blob();
  return (await projectStore.upload(new File([blob], name, { type: 'video/mp4' }))).id;
}`;
const PAGE_CAPTURE = `async ({ doc, input, assetId, refs, boxes }) => {
  const { captureFrame } = await import('/src/render/capture.ts'), { projectStore } = await import('/src/store/database.ts');
  const asset = await projectStore.row('assets', assetId);
  for (const i of doc.items) if (i.metadata?.assetId === '@S1') i.metadata.assetId = assetId;
  const result = await captureFrame({ store: projectStore, doc, asset: id => id === assetId ? asset : undefined, playheadMs: 0 }, input);
  if (!result.success) return { refused: result };
  const pixels = async bytes => {
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' });
    const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0); bmp.close(); return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  };
  const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const crop = (img, r) => { const o = new Uint8Array(r.w * r.h * 4); for (let y = 0; y < r.h; y++) o.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4); return b64(o); };
  const images = result.content.filter(b => b.type === 'image'), frames = [];
  for (let k = 0; k < images.length; k++) {
    const ours = await pixels(Uint8Array.from(atob(images[k].base64), c => c.charCodeAt(0)));
    const f = { jpeg: images[k].base64, width: ours.width, height: ours.height };
    // No stored frame (renderCaptures): our picture only.
    const theirs = refs[k] == null ? null : await pixels(new Uint8Array(await (await fetch('/__g02/ref/' + encodeURIComponent(refs[k]))).arrayBuffer()));
    if (theirs && ours.width === theirs.width && ours.height === theirs.height) {
      // Per pixel: the largest RGB channel difference, as a 256-bin histogram.
      const hist = new Array(256).fill(0), a = ours.data, b = theirs.data;
      for (let i = 0; i < a.length; i += 4) hist[Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))]++;
      f.hist = hist;
      if (boxes[k]) f.counter = { ours: crop(ours, boxes[k]), theirs: crop(theirs, boxes[k]) };
    }
    frames.push(f);
  }
  return { text: JSON.parse(result.content[0].text), frames };
}`;

type PageFrame = { jpeg: string; width: number; height: number; hist?: number[]; counter?: { ours: string; theirs: string } };
type PageResult = { refused: { [key: string]: Json } } | { refused?: undefined; text: { frames: { timestamp: number; frame: number }[] }; frames: PageFrame[] };
type Session = { s1: string; capture: (arg: { doc: ProjectDocument; input: Json; refs: (string | null)[]; boxes: (Box | null)[] }) => Promise<PageResult> };
type Box = { x: number; y: number; w: number; h: number };
async function session<T>(o: FramesOptions, serve: (name: string) => string | undefined, run: (s: Session) => Promise<T>): Promise<T> {
  const store = o.store ?? process.env.CUTFRAME_FIXTURES;
  if (!store) throw Error('CUTFRAME_FIXTURES must name the fixture store (S1 is captured)');
  const entry = manifestFiles(await readFile(path.join(REPO, 'fixtures/Cutframe test fixtures (C).md'), 'utf8')).find(f => f.relative === S1_FILE);
  if (!entry) throw Error(`The fixture manifest has no ${S1_FILE}`);
  const s1 = await fixturePath(entry, store, REPO);
  if ((await stat(s1)).size !== entry.bytes || await sha256(s1) !== entry.sha256) throw Error(`Fixture mismatch: ${S1_FILE}`);
  const { createServer } = await import('vite'), { chromium } = await import('@playwright/test');
  const server = await createServer({ configFile: path.join(REPO, 'vite.config.ts'), root: path.join(REPO, 'apps/web'), cacheDir: path.join(os.tmpdir(), 'cutframe-g02-frames-vite'),
    server: { host: '127.0.0.1', port: o.port ?? 0, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const base = server.resolvedUrls!.local[0], page = await browser.newPage();
    await page.route(`${base}__g02/**`, route => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.slice('/__g02/'.length)), file = name === 'S1.mp4' ? s1 : name.startsWith('ref/') ? serve(name.slice(4)) : undefined;
      return name === 'page' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>G-02 frames</title>' }) : file ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
    });
    await page.goto(`${base}__g02/page`);
    const assetId = await page.evaluate(`(${PAGE_UPLOAD})(${JSON.stringify({ name: path.basename(S1_FILE) })})`) as string;
    let reloaded = false;
    page.on('framenavigated', f => { if (f === page.mainFrame()) reloaded = true; });
    return await run({ s1, capture: async arg => {
      const r = await page.evaluate(`(${PAGE_CAPTURE})(${JSON.stringify({ ...arg, assetId })})`) as PageResult;
      if (reloaded) throw Error('The capture page reloaded during the run (Vite re-optimised its dependencies); run again');
      return r;
    } });
  } finally { await browser.close(); await server.close(); }
}

/** The doc with every S1 clip pointing at the uploaded asset (the replay's ids are g01-S1-<n>, parity/g01.ts fixtureAssets). */
function onUpload(doc: ProjectDocument): ProjectDocument {
  const out = structuredClone(doc);
  for (const i of out.items) {
    const id = i.metadata?.assetId;
    if (id === undefined) continue;
    if (!/^g01-S1-\d+$/.test(String(id))) throw Error(`Item ${i.id} shows ${id}; the frames runner captures S1 only`);
    i.metadata = { ...i.metadata, assetId: '@S1' };
  }
  return out;
}
/** The S1 counter region's bounding box in frame px at timeline ms t (2 px margin), with the map from S1 source px into it. */
function counterBox(doc: ProjectDocument, tMs: number, size: { width: number; height: number }) {
  const d = framePlan(doc, tMs, size).draws.find(x => x.kind === 'video' && x.item.metadata?.assetId === '@S1'), r = d && cover(S1_W, S1_H, d.box.W, d.box.H);
  if (!d || !r) return undefined;
  const at = (u: number, v: number) => apply(d.matrix, r.x + u * r.w / S1_W, r.y + v * r.h / S1_H);
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => at(COUNTER.x + i * COUNTER.w, COUNTER.y + j * COUNTER.h));
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[0]))) - 2), y0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[1]))) - 2);
  const x1 = Math.min(size.width, Math.ceil(Math.max(...corners.map(c => c[0]))) + 2), y1 = Math.min(size.height, Math.ceil(Math.max(...corners.map(c => c[1]))) + 2);
  if (x1 - x0 < 2 || y1 - y0 < 2) return undefined;
  return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, at: (u: number, v: number): [number, number] => { const [x, y] = at(u, v); return [x - x0, y - y0]; } };
}
const histStats = (h: number[]) => {
  const n = h.reduce((a, b) => a + b, 0); let sum = 0, seen = 0, p95 = -1, max = 0;
  h.forEach((c, d) => { sum += c * d; seen += c; if (c) max = d; if (p95 < 0 && seen >= 0.95 * n) p95 = d; });
  return { mean: sum / n, p95, max };
};

/** `store`: the fixture store (default CUTFRAME_FIXTURES); `port`: the Vite port (default: any free one). */
export type FramesOptions = { store?: string; port?: number };
/** The G-02 frames comparison for runG02 (`frames` option). Our JPEGs are written to <out>/frames/ under the stored names;
 *  each frame's row (sizes, encoder, pixels over the tolerance, mean / p95 / max level difference, counter readings) goes in
 *  the report's `frames` summary. */
export function compareFrames(referenceDir: string, unit: FrameTimeUnit, o: FramesOptions = {}): G02Frames {
  if (!FRAME_TIME_UNITS.includes(unit)) throw Error(`--frame-time-unit must be one of ${FRAME_TIME_UNITS.join(', ')}`);
  return async (captures, out) => {
    const base = await realpath(referenceDir), folder = await realpath(path.join(base, 'frames')).catch(() => { throw Error(`No frames/ folder in ${referenceDir}`); });
    if (!inside(base, folder)) throw Error('frames/ escapes the reference directory');
    const refs = matchFrames(await readdir(folder), captures, unit), files = new Set(Object.values(refs).flat().map(r => r.file));
    await mkdir(path.join(out, 'frames'), { recursive: true });
    return session(o, name => files.has(name) ? path.join(folder, name) : undefined, async s => {
      const crops = counterCrops(s.s1), diffs: Record<string, Diff[]> = {}, rows: Json[] = [];
      for (const c of captures) {
        const list = refs[c.id], d: Diff[] = diffs[c.id] = [], doc = onUpload(c.doc), fps = fpsOf(doc);
        const stored = await Promise.all(list.map(async r => jpegInfo(await readFile(path.join(folder, r.file)))));
        const boxes = list.map((r, k) => r.timestamp < READABLE_BEFORE_S ? counterBox(doc, frameTime(previewFrame(r.timestamp * 1000, fps), fps), stored[k]) : undefined);
        const res = await s.capture({ doc, input: c.input, refs: list.map(r => r.file), boxes: boxes.map(b => b?.box ?? null) });
        if (res.refused) { d.push({ part: 'frame', path: `${c.id}.captureFrame`, expected: 'success', actual: res.refused }); continue; }
        for (const [k, r] of list.entries()) {
          const f = res.frames[k], ours = Buffer.from(f.jpeg, 'base64'), theirs = stored[k], at = `frames/${r.file}`;
          await writeFile(path.join(out, 'frames', r.file), ours);
          const row: { [key: string]: Json } = { file: r.file, step: c.id, state: c.state, timestamp: r.timestamp, frame: res.text.frames[k].frame,
            size: [f.width, f.height], storedSize: [theirs.width, theirs.height], encoder: jpegInfo(ours).encoder === theirs.encoder ? 'same' : 'different' };
          rows.push(row);
          if (!f.hist) { d.push({ part: 'frame', path: `${at}.size`, expected: [theirs.width, theirs.height], actual: [f.width, f.height] }); continue; }
          const over = f.hist.slice(FRAME_LEVEL_TOLERANCE + 1).reduce((a, b) => a + b, 0), st = histStats(f.hist);
          Object.assign(row, { pixelsOver: over, mean: st.mean, p95: st.p95, max: st.max });
          if (over) d.push({ part: 'frame', path: `${at}.pixels`, expected: 0, actual: over, note: `pixels with an RGB channel more than ${FRAME_LEVEL_TOLERANCE} level off (mean ${st.mean.toFixed(3)}, p95 ${st.p95}, max ${st.max}); JPEG tables ${row.encoder}` });
          if (r.timestamp >= READABLE_BEFORE_S) continue;
          const b = boxes[k];
          if (!b || !f.counter) { row.counter = 'S1 is not drawn at this time'; continue; }
          const read = (s: string) => readCounter(counterRegion({ width: b.box.w, height: b.box.h, data: Buffer.from(s, 'base64') }, b.at), crops);
          const a = read(f.counter.ours), t = read(f.counter.theirs);
          row.counter = { ours: a.frame, stored: t.frame, oursDiff: a.diff, oursRunnerUp: a.runnerUp, storedDiff: t.diff, storedRunnerUp: t.runnerUp };
          if (a.frame !== t.frame) d.push({ part: 'frame', path: `${at}.counter`, expected: t.frame, actual: a.frame, note: 'the S1 frame number the picture shows' });
          const eye = EYE_CHECKED[`${c.state}:${r.timestamp}`];
          if (eye !== undefined && t.frame !== eye) row.note = `the stored frame reads ${t.frame}; tickets l.69 records ${eye}, checked by eye`;
        }
      }
      const failed = Object.values(diffs).filter(x => x.length).length;
      return { diffs, summary: { unit, tolerance: FRAME_LEVEL_TOLERANCE, toleranceFrom: 'parity/frame-tolerance.ts FRAME_LEVEL_TOLERANCE', steps: captures.length, failedSteps: failed, frames: rows.length, ours: path.join(out, 'frames'), rows } };
    });
  };
}

/** Our captureFrame JPEGs for each capture (no comparison): the synthetic G-02 frames test builds its stored frames from these. */
export async function renderCaptures(captures: G02Capture[], o: FramesOptions = {}) {
  return session(o, () => undefined, async s => {
    const out: { id: string; state: G02Capture['state']; timestamp: number; jpeg: Buffer }[] = [];
    for (const c of captures) {
      const res = await s.capture({ doc: onUpload(c.doc), input: c.input, refs: [], boxes: [] });
      if (res.refused) throw Error(`captureFrame ${c.id} refused: ${JSON.stringify(res.refused)}`);
      res.text.frames.forEach((f, k) => out.push({ id: c.id, state: c.state, timestamp: f.timestamp, jpeg: Buffer.from(res.frames[k].jpeg, 'base64') }));
    }
    return out;
  });
}
