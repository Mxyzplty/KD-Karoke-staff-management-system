// SPDX-License-Identifier: AGPL-3.0-only
// `parity import-reference <capture-dir> <out-dir>`: converts the common golden-capture layout of
// "Cutframe agent tool results (C).md" ("Stored reference" paragraphs) into the runner's reference
// layout. Run by Author on D2 only; implementers never point it at the private captures.
// Built only from what the planning docs say. Where they leave a detail open (the results.jsonl
// line schema, the unit of <t> in frame names, the map-file schemas), the importer requires an
// explicit flag instead of guessing. Per-capture call mapping and the normalising of Xapp project
// snapshots belong to the ticket that cites each G capture; they hand their output in via flags.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { FRAMES_VERSION, encodePng16, frameFileName, sha256, type FrameFile } from './frames';
import { atomicJson, atomicWrite, inside, resolvedDestination, safeSubdirectory } from './runner';

export type ImportOptions = {
  calls?: string;          // JSON file (any path): ordered call ids (else the order of results.jsonl lines)
  callIdField?: string;    // field naming the call id in each results.jsonl line (required: the schema is open)
  frames?: string;         // frame folder inside the capture, e.g. "frames/export"
  timeFrom?: string;       // "name-ms" | "name-s" | "frame-index" | "map:<file.json>" (any path; { "<file under --frames>": timeMs })
  fps?: number;            // for frame-index: t = N / fps
  export?: string;         // MP4 inside the capture (default: the only exports/*.mp4)
  ffprobe?: string;        // ffprobe JSON inside the capture (default: exports/ffprobe.json)
  project?: string;        // a normalisation-v1 project file (any path) made by the owning ticket
};

const SHALLOW = new Set(['rgba', 'rgb24', 'gray', 'pal8', 'yuvj420p', 'yuvj422p', 'yuvj444p', 'yuv420p', 'yuv422p', 'yuv444p']);
const DEEP = new Set(['rgba64be', 'rgb48be']);

async function within(base: string, relative: string, what: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error(`${what} must be a path inside the capture: ${relative}`);
  const file = await realpath(path.join(base, relative)).catch(() => { throw Error(`${what} not found in the capture: ${relative}`); });
  if (!inside(base, file)) throw Error(`${what} escapes the capture directory: ${relative}`);
  return file;
}
const listFiles = async (dir: string, root = dir): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(e =>
  e.isDirectory() ? listFiles(path.join(dir, e.name), root) : [path.relative(root, path.join(dir, e.name)).split(path.sep).join('/')]))).flat().sort();

function sampleTime(file: string, timeFrom: string, fps: number | undefined, map: Record<string, unknown> | undefined): number {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  if (timeFrom.startsWith('map:')) {
    const t = map![file];
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw Error(`Time map has no valid time for ${file}`);
    return t;
  }
  const number = stem.match(/-(\d+(?:\.\d+)?)$/)?.[1];
  if (number === undefined) throw Error(`Frame name has no trailing -<number>: ${file}`);
  if (timeFrom === 'name-ms') return Number(number);
  if (timeFrom === 'name-s') return Number(number) * 1000;
  if (timeFrom === 'frame-index') { if (!fps || !/^\d+$/.test(number)) throw Error(`frame-index needs --fps and an integer index: ${file}`); return Number(number) / fps * 1000; }
  throw Error(`Unknown --time-from ${timeFrom}`);
}

export async function importReference(captureDir: string, outDir: string, o: ImportOptions) {
  const capture = await realpath(captureDir), out = await resolvedDestination(path.resolve(outDir));
  if (inside(capture, out) || inside(out, capture)) throw Error('Output and capture directories overlap');
  const provenance: Record<string, unknown> = { version: 1, captureName: path.basename(capture), options: o, sources: {} as Record<string, string> };
  const source = async (relative: string, what: string) => { const file = await within(capture, relative, what), bytes = await readFile(file); (provenance.sources as Record<string, string>)[relative] = sha256(bytes); return bytes; };
  // Inputs made by the owning ticket (call list, time map, normalised project) may live anywhere.
  const external = async (file: string) => { const bytes = await readFile(path.resolve(file)); (provenance.sources as Record<string, string>)[`external:${path.basename(file)}`] = sha256(bytes); return bytes; };
  const written: string[] = [];
  await mkdir(out, { recursive: true });

  // Command results: results/<id>.json in the documented call order.
  const lines = await stat(path.join(capture, 'results.jsonl')).then(() => true, () => false);
  let ids: string[] | undefined;
  if (o.calls) ids = JSON.parse((await external(o.calls)).toString('utf8'));
  else if (lines) {
    // The line schema is not documented, so the id field is never assumed.
    if (!o.callIdField) throw Error('results.jsonl found: pass --call-id-field <field> (the line schema is not documented) or --calls <ids.json>');
    ids = (await source('results.jsonl', 'results.jsonl')).toString('utf8').split(/\r?\n/).filter(l => l.trim()).map((line, n) => {
      const id = JSON.parse(line)[o.callIdField!];
      if (typeof id !== 'string' || !id) throw Error(`results.jsonl line ${n + 1} has no "${o.callIdField}" field; pass another --call-id-field or --calls`);
      return id;
    });
  }
  if (ids) {
    if (!Array.isArray(ids) || !ids.every(i => typeof i === 'string' && /^[\w.-]+$/.test(i))) throw Error('Call ids must be plain names');
    const results = [];
    for (const id of ids) results.push(JSON.parse((await source(`results/${id}.json`, `Result of call ${id}`)).toString('utf8')));
    await atomicJson(out, 'command-results.json', results); written.push('command-results.json');
  }

  // Frames: every PNG/JPEG under the chosen frame folder, ordered by sample time.
  if (o.frames) {
    if (!o.timeFrom) throw Error('--frames needs --time-from (the docs do not fix the time encoding of frame names)');
    const folder = await within(capture, o.frames, 'Frame folder');
    const map = o.timeFrom.startsWith('map:') ? JSON.parse((await external(o.timeFrom.slice(4))).toString('utf8')) : undefined;
    const frames = (await listFiles(folder)).filter(f => /\.(png|jpe?g)$/i.test(f)).map(f => ({ file: f, timeMs: sampleTime(f, o.timeFrom!, o.fps, map) })).sort((a, b) => a.timeMs - b.timeMs);
    if (!frames.length) throw Error(`No PNG/JPEG frames under ${o.frames}`);
    frames.forEach((f, i) => { if (i && f.timeMs === frames[i - 1].timeMs) throw Error(`Two frames share ${f.timeMs} ms: ${frames[i - 1].file}, ${f.file}`); });
    await safeSubdirectory(out, 'frames', capture);
    const files: FrameFile[] = [];
    for (const [i, f] of frames.entries()) {
      const file = path.join(folder, f.file); await source(path.relative(capture, file).split(path.sep).join('/'), 'Frame');
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', file]).toString()).streams[0];
      // Only formats whose decode is exact (checked 27 Oct) or inherently lossy (JPEG). 8-bit sources
      // decode at 8 bit: ffmpeg's 8 → 16-bit conversion is not exact (0 → 6, 255 → 65532).
      const deep = DEEP.has(probe.pix_fmt), bytes = deep ? 8 : 4;
      if (!deep && !SHALLOW.has(probe.pix_fmt)) throw Error(`Frame ${f.file}: pixel format ${probe.pix_fmt} is not supported (supported: ${[...SHALLOW, ...DEEP].join(', ')})`);
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', deep ? 'rgba64le' : 'rgba', 'pipe:1'], { maxBuffer: 1 << 29 });
      if (raw.length !== probe.width * probe.height * bytes) throw Error(`Decoded size of ${f.file} does not match its stream size`);
      const rgba = new Float32Array(probe.width * probe.height * 4);
      for (let k = 0; k < rgba.length; k++) rgba[k] = deep ? raw.readUInt16LE(k * 2) / 65535 : raw[k] / 255;
      const png = encodePng16({ width: probe.width, height: probe.height, rgba }), name = frameFileName(i);
      await atomicWrite(out, name, png);
      files.push({ timeMs: f.timeMs, width: probe.width, height: probe.height, file: name, sha256: sha256(png) });
    }
    await atomicJson(out, 'frames.json', { version: FRAMES_VERSION, timeUnit: 'ms', channelRange: [0, 1], pixelFormat: 'png-rgba16', sampleTimesMs: files.map(f => f.timeMs), frames: files });
    written.push('frames.json');
  }

  // Export metadata: the export MP4's identity plus the capture's ffprobe JSON.
  const exports = await stat(path.join(capture, 'exports')).then(() => true, () => false);
  if (o.export || exports) {
    const mp4s = o.export ? [o.export] : (await readdir(path.join(capture, 'exports'))).filter(f => /\.mp4$/i.test(f)).map(f => `exports/${f}`);
    if (mp4s.length !== 1) throw Error(`Expected one exports/*.mp4, found ${mp4s.length}; pass --export`);
    const bytes = await source(mp4s[0], 'Export');
    const ffprobe = JSON.parse((await source(o.ffprobe ?? 'exports/ffprobe.json', 'ffprobe JSON')).toString('utf8'));
    await atomicJson(out, 'export-metadata.json', { file: path.basename(mp4s[0]), bytes: bytes.length, sha256: sha256(bytes), ffprobe });
    written.push('export-metadata.json');
  }

  // Project: only a normalised project made by the owning ticket; Xapp snapshots are never normalised here.
  if (o.project) {
    const project = JSON.parse((await external(o.project)).toString('utf8'));
    if (project?.normalisationVersion !== 1 || project.project === undefined) throw Error('--project must be a normalisation-v1 file ({normalisationVersion: 1, project})');
    await atomicJson(out, 'project.normalised.json', project); written.push('project.normalised.json');
  }
  await atomicJson(out, 'import.json', { ...provenance, written });
  return { written, sources: Object.keys(provenance.sources as object).length };
}
