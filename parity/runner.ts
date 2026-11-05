// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, mkdir, writeFile, realpath, rename, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonical, normalise, type Json } from './normalise';
import { verifyFixtures } from './fixtures';
import { FRAMES_VERSION, decodePng16, encodePng16, frameFileName, q16, sha256, validateFramesMeta, type FrameFile } from './frames';
// Linear or encoded colour is adapter-defined; all RGBA channels are finite [0,1].
// Full-size frames may be typed arrays; they are written and compared one sample at a time.
export type Frame = { width: number; height: number; rgba: ArrayLike<number> };
export interface ParityAdapter {
  name: string;
  open(project: Json, options: { noProvider: boolean }): Promise<void>;
  execute(tool: string, input: Json): Promise<Json>;
  project(): Promise<Json>;
  frame(timeMs: number): Promise<Frame>;
  exportMetadata(): Promise<Json>;
  close?(): Promise<void>;
}
export type Scenario = { version: 1; name: string; inputMode?: 'fixture-free' | 'media'; project: Json; edits: { tool: string; input: Json }[]; sampleTimesMs: number[]; expected?: { project?: Json; frames?: Frame[]; sampleTimesMs?: number[]; timeUnit?: 'ms'; commandResults?: Json[]; exportMetadata?: Json }; tolerance?: { maxPixelError?: number; minSsim?: number } };
export class NotImplemented extends Error { readonly code = 'NOT_IMPLEMENTED'; }
export class EditorAdapter implements ParityAdapter {
  name = 'cutframe-editor';
  async open(): Promise<void> { throw new NotImplemented('Editor adapter is not implemented (owned by later tickets)'); }
  async execute(): Promise<Json> { throw new NotImplemented('Editor command is not implemented'); }
  async project(): Promise<Json> { throw new NotImplemented('Editor project is not implemented'); }
  async frame(): Promise<Frame> { throw new NotImplemented('Editor renderer is not implemented'); }
  async exportMetadata(): Promise<Json> { throw new NotImplemented('Editor export is not implemented'); }
}
function available(value: unknown, category: string): void {
  if (value && typeof value === 'object' && 'code' in value && value.code === 'NOT_IMPLEMENTED') throw new NotImplemented(`${category} is not implemented`);
}
function validateJson(value: unknown): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) throw Error('Invalid JSON adapter output');
  for (const child of Object.values(value)) validateJson(child);
}
function jsonObject(value: unknown, category: string): asserts value is Record<string, Json> {
  available(value, category); validateJson(value);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(`Invalid ${category} object`);
}
export function validateFrame(value: unknown): asserts value is Frame {
  available(value, 'Frame');
  const f = value as Frame;
  if (!f || !Number.isSafeInteger(f.width) || !Number.isSafeInteger(f.height) || f.width <= 0 || f.height <= 0 || !(Array.isArray(f.rgba) || ArrayBuffer.isView(f.rgba)) || f.rgba.length !== f.width * f.height * 4) throw Error('Invalid frame dimensions or RGBA length');
  for (let i = 0; i < f.rgba.length; i++) { const v = f.rgba[i]; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw Error('Frame pixels must be finite RGBA values in [0,1]'); }
}
// Both sides are compared at the stored 16-bit precision.
export function compareFrames(a: Frame, b: Frame) {
  validateFrame(a); validateFrame(b);
  if (a.width !== b.width || a.height !== b.height) throw Error('Frame dimensions differ');
  const n = a.rgba.length, va = new Float64Array(n), vb = new Float64Array(n);
  let maxPixelError = 0, mse = 0, x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    va[i] = q16(a.rgba[i]) / 65535; vb[i] = q16(b.rgba[i]) / 65535;
    maxPixelError = Math.max(maxPixelError, Math.abs(va[i] - vb[i]));
    mse += (va[i] - vb[i]) ** 2; x += va[i]; y += vb[i];
  }
  x /= n; y /= n;
  let vx = 0, vy = 0, cov = 0;
  for (let i = 0; i < n; i++) { vx += (va[i] - x) ** 2; vy += (vb[i] - y) ** 2; cov += (va[i] - x) * (vb[i] - y); }
  vx /= n; vy /= n; cov /= n;
  const ssim = ((2 * x * y + 0.01 ** 2) * (2 * cov + 0.03 ** 2)) / ((x * x + y * y + 0.01 ** 2) * (vx + vy + 0.03 ** 2));
  return { maxPixelError, mse: mse / n, ssim };
}
export const inside = (base: string, candidate: string) => { const rel = path.relative(base, candidate); return rel === '' || !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
export async function resolvedDestination(dest: string): Promise<string> {
  try { return await realpath(dest); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(dest);
    if (parent === dest) throw error;
    return path.join(await resolvedDestination(parent), path.basename(dest));
  }
}
export async function atomicWrite(directory: string, name: string, data: string | Uint8Array) {
  // Replacing a directory entry breaks pre-existing symlink/hardlink aliases;
  // writing directly through that entry could corrupt a reference elsewhere.
  const target = path.join(directory, name), temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try { await writeFile(temp, data, { flag: 'wx' }); await rename(temp, target); }
  finally { await rm(temp, { force: true }); }
}
export const atomicJson = (directory: string, name: string, value: unknown) => atomicWrite(directory, name, JSON.stringify(value, null, 2));
// A sub-directory for writes must resolve inside the output and outside the reference (no planted link).
export async function safeSubdirectory(output: string, name: string, base?: string) {
  const dir = path.join(output, name);
  await mkdir(dir, { recursive: true });
  const real = await realpath(dir);
  if (!inside(output, real) || base && inside(base, real)) throw Error(`Output ${name}/ resolves outside the output directory`);
  return real;
}
function sampleTimes(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || !value.every(t => typeof t === 'number' && Number.isFinite(t) && t >= 0)) throw Error('Invalid sampleTimesMs metadata');
}
const exists = (file: string) => access(file).then(() => true, () => false);

// Reference directory layout (also written by every run): project.normalised.json,
// frames.json (metadata, version 2) + frames/NNNN.png, command-results.json,
// export-metadata.json. Each part is optional; a missing one leaves the run uncompared.
async function readReference(base: string) {
  const bounded = async (name: string) => { const file = await realpath(path.join(base, name)); if (!inside(base, file)) throw Error('Reference escapes configured directory'); return file; };
  const json = async (name: string) => (await exists(path.join(base, name))) ? JSON.parse(await readFile(await bounded(name), 'utf8')) : undefined;
  const project = await json('project.normalised.json');
  if (project !== undefined && project.normalisationVersion !== 1) throw Error('Reference normalisation version mismatch');
  const frames = await json('frames.json');
  let files: { meta: FrameFile; file: string }[] | undefined;
  if (frames !== undefined) {
    validateFramesMeta(frames);
    // Every pixel file is located and hash-checked before any write or adapter call.
    files = await Promise.all(frames.frames.map(async meta => {
      const file = await bounded(meta.file);
      if (sha256(await readFile(file)) !== meta.sha256) throw Error(`Reference frame file hash mismatch: ${meta.file}`);
      return { meta, file };
    }));
  }
  return { project: project?.project as Json | undefined, sampleTimesMs: frames?.sampleTimesMs as number[] | undefined, files,
    commandResults: await json('command-results.json') as Json[] | undefined, exportMetadata: await json('export-metadata.json') as Json | undefined };
}

export async function runScenario(scenario: Scenario, adapter: ParityAdapter, options: { noProvider?: boolean; output: string; referenceDir?: string }) {
  if (scenario.version !== 1 || !scenario.name || !Array.isArray(scenario.edits) || scenario.inputMode !== undefined && !['media', 'fixture-free'].includes(scenario.inputMode)) throw Error('Invalid scenario');
  sampleTimes(scenario.sampleTimesMs);
  const output = await resolvedDestination(path.resolve(options.output));
  const base = options.referenceDir ? await realpath(options.referenceDir) : undefined;
  if (base && (inside(base, output) || inside(output, base))) throw Error('Output/reference directories overlap or alias');
  const inline = scenario.expected;
  // Read the entire explicit reference before any writes or adapter execution.
  const reference = base ? await readReference(base) : undefined;
  const expected = reference ? { ...reference, timeUnit: 'ms' as const, frames: undefined } : inline;
  if (expected?.sampleTimesMs !== undefined) {
    sampleTimes(expected.sampleTimesMs);
    if (expected.timeUnit !== 'ms' || canonical(expected.sampleTimesMs) !== canonical(scenario.sampleTimesMs)) throw Error('Reference ordered sampleTimesMs differ');
  }
  if (inline?.frames !== undefined && !reference && (!Array.isArray(inline.frames) || inline.frames.length !== scenario.sampleTimesMs.length)) throw Error('Reference sampled-frame count differs');
  if (!reference) for (const frame of inline?.frames ?? []) validateFrame(frame);
  if (expected?.commandResults !== undefined && (!Array.isArray(expected.commandResults) || expected.commandResults.length !== scenario.edits.length)) throw Error('Reference command-result count differs');
  const expectedFrame = reference?.files ? async (i: number): Promise<Frame> => {
    const { meta, file } = reference.files![i], bytes = await readFile(file);
    if (sha256(bytes) !== meta.sha256) throw Error(`Reference frame file changed during the run: ${meta.file}`);
    const decoded = decodePng16(bytes);
    if (decoded.width !== meta.width || decoded.height !== meta.height) throw Error(`Reference frame size differs from frames.json: ${meta.file}`);
    return decoded;
  } : !reference && inline?.frames ? async (i: number) => inline.frames![i] : undefined;
  // Media is the default. Only explicitly identified in-memory probes bypass it.
  const fixtures = scenario.inputMode === 'fixture-free' ? [] : await verifyFixtures();
  await mkdir(output, { recursive: true });
  const report: Record<string, unknown> = { version: 1, name: scenario.name, adapter: adapter.name, inputMode: scenario.inputMode ?? 'media', verifiedFixtures: fixtures.length, noProvider: !!options.noProvider, status: 'failed', comparisons: {} };
  let opened = false;
  try {
    opened = true;
    await adapter.open(structuredClone(scenario.project), { noProvider: !!options.noProvider });
    const results: Json[] = [];
    for (const step of scenario.edits) {
      const result = await adapter.execute(step.tool, structuredClone(step.input));
      available(result, `Command ${step.tool}`); validateJson(result);
      results.push(result);
    }
    const rawProject = await adapter.project(); jsonObject(rawProject, 'Project');
    const project = normalise(rawProject);
    const frameDir = scenario.sampleTimesMs.length ? await safeSubdirectory(output, 'frames', base) : undefined;
    const files: FrameFile[] = [], metrics: (ReturnType<typeof compareFrames> & { timeMs: number })[] = [];
    for (const [i, timeMs] of scenario.sampleTimesMs.entries()) {
      const frame = await adapter.frame(timeMs); validateFrame(frame);
      const png = encodePng16(frame), file = frameFileName(i);
      await atomicWrite(frameDir!, path.basename(file), png); // into the resolved frames/ folder itself
      files.push({ timeMs, width: frame.width, height: frame.height, file, sha256: sha256(png) });
      if (expectedFrame) {
        const want = await expectedFrame(i);
        if (want.width !== frame.width || want.height !== frame.height) throw Error(`Frame at ${timeMs} ms: dimensions differ (${frame.width}×${frame.height} vs ${want.width}×${want.height})`);
        metrics.push({ timeMs, ...compareFrames(frame, want) });
      }
    }
    const exportMetadata = await adapter.exportMetadata(); jsonObject(exportMetadata, 'Export metadata');
    await atomicJson(output, 'project.normalised.json', project);
    await atomicJson(output, 'frames.json', { version: FRAMES_VERSION, timeUnit: 'ms', channelRange: [0, 1], pixelFormat: 'png-rgba16', sampleTimesMs: scenario.sampleTimesMs, frames: files });
    await atomicJson(output, 'export-metadata.json', exportMetadata);
    await atomicJson(output, 'command-results.json', results);
    if (!expected) { report.status = 'uncompared'; report.reason = 'Outputs recorded; no expected outputs supplied'; }
    else {
      const comparisons: Record<string, unknown> = {};
      if (expected.project !== undefined) comparisons.project = canonical(project.project) === canonical(expected.project);
      if (expected.exportMetadata !== undefined) comparisons.exportMetadata = canonical(exportMetadata) === canonical(expected.exportMetadata);
      // Exact JSON semantics, including ordered refusals and codes. No broad
      // stripping of result IDs or unknown fields is permitted in schema v1.
      if (expected.commandResults !== undefined) comparisons.commandResults = canonical(results) === canonical(expected.commandResults);
      if (expectedFrame) comparisons.frames = metrics;
      const failedFrames = metrics.filter(m => m.maxPixelError > (scenario.tolerance?.maxPixelError ?? 0) || m.ssim < (scenario.tolerance?.minSsim ?? 1) - 1e-12).map(m => m.timeMs);
      const failedParts = Object.entries(comparisons).filter(([, v]) => v === false).map(([k]) => k);
      const missing = ['project', 'exportMetadata', ...(scenario.edits.length ? ['commandResults'] : []), ...(scenario.sampleTimesMs.length ? ['frames'] : [])].filter(k => !(k in comparisons));
      report.missingComparisons = missing;
      report.comparisons = comparisons;
      report.status = failedParts.length || failedFrames.length ? 'failed' : missing.length ? 'uncompared' : 'passed';
      if (failedFrames.length) report.failedSampleTimesMs = failedFrames;
      if (report.status === 'failed') report.reason = [...failedParts.map(k => `${k} differs`), ...failedFrames.map(t => `frame at ${t} ms differs`)].join('; ');
    }
  } catch (error) {
    report.status = error instanceof NotImplemented ? 'not-implemented' : 'failed';
    report.reason = error instanceof Error ? error.message : String(error);
  } finally {
    try { if (opened) await adapter.close?.(); }
    catch (error) { report.status = 'failed'; report.reason = `Adapter close failed: ${String(error)}`; }
  }
  await atomicJson(output, 'report.json', report);
  return report;
}
