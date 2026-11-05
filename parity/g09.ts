// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-09 --xapp-ref <dir> …`: replays the stored golden audio-mix capture G-09 (agent tool results §10;
// tickets T13 "Golden audio mix") through the direct-call harness, renders the whole timeline through T13's audio stage
// in the export parity mode (linear volume ramps) and compares it with `analysis/export-audio-f32.wav` section by section
// through the audio oracle (lag ≤ 1 ms, RMS gain and peak ±0.1 dB, residual ≤ −50 dBFS), leaving out the 10 ms after
// each clip start (Xapp cuts ≈ 9.4 ms there; Cutframe does not). Each replayed call's success and code are compared with
// `results/<id>.json` where Xapp has them. Run by the research agent on D2 only; implementers test it on synthetic
// folders (tests/t13-g09.test.ts). The media files are given at run time (`--media`, Xapp asset id → file: WAV read
// here, anything else decoded by ffmpeg / probed by ffprobe). Provisional choices, not Xapp parity: sections default to
// the spans between the replayed clips' edges (`--sections` overrides them); the lag is searched per section within
// ±maxLagMs; Cutframe's pre-codec PCM is compared with Xapp's decoded AAC (the encoded export is T16's).
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, atomicWrite, inside, resolvedDestination } from './runner';
import type { Json } from './normalise';
import { callResult, IdMap, learnCall, loadStored, type Diff, type G01Step } from './g01';
import { createEditor } from '../apps/web/src/timeline/harness';
import { setIdSource, stack, track } from '../apps/web/src/timeline/model';
import { TOOLS } from '../apps/web/src/timeline/tools';
import { renderAudio } from '../apps/web/src/audio/stage';
import { MIX_RATE, PER_MS, type AudioSource, type Stereo } from '../apps/web/src/audio/mix';
import { compareAudio, type AudioComparison } from '../apps/web/src/audio/oracle';
import { resamplePlanar } from '../apps/web/src/audio/resample';
import type { Asset, AssetLink, RecordData } from '../apps/web/src/store/model';

type Rec = { [key: string]: Json };
export const REFERENCE_WAV = 'analysis/export-audio-f32.wav', CLIP_START_MS = 10;
export type G09Section = { name?: string; fromS: number; toS: number };
export type G09Options = { calls: G01Step[][]; media: Record<string, string>; toolField: string; inputField: string; blockBase?: 0 | 1; output?: string; sections?: G09Section[]; maxLagMs?: number };

// ---- WAV (PCM 16 / 24 / 32-bit and IEEE float 32, plain or extensible).
export function readWav(bytes: Uint8Array): { rate: number; data: Float32Array[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw Error('Not a RIFF/WAVE file');
  let format = 0, channels = 0, rate = 0, bits = 0, data: Uint8Array | undefined;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at), size = v.getUint32(at + 4, true), body = at + 8;
    if (id === 'fmt ') { format = v.getUint16(body, true); channels = v.getUint16(body + 2, true); rate = v.getUint32(body + 4, true); bits = v.getUint16(body + 14, true); if (format === 0xfffe) format = v.getUint16(body + 24, true); }
    if (id === 'data') data = bytes.subarray(body, Math.min(bytes.length, body + size));
    at = body + size + (size & 1);
  }
  if (!data || !channels || !rate) throw Error('WAV has no fmt or data chunk');
  const step = bits / 8, frames = Math.floor(data.length / (step * channels)), d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sample = format === 3 && bits === 32 ? (o: number) => d.getFloat32(o, true) : format === 1 && bits === 16 ? (o: number) => d.getInt16(o, true) / 32768
    : format === 1 && bits === 24 ? (o: number) => ((d.getUint8(o) | d.getUint8(o + 1) << 8 | d.getInt8(o + 2) << 16)) / 8388608 : format === 1 && bits === 32 ? (o: number) => d.getInt32(o, true) / 2147483648 : null;
  if (!sample) throw Error(`Unsupported WAV encoding (format ${format}, ${bits} bit)`);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let n = 0; n < frames; n++) for (let c = 0; c < channels; c++) out[c][n] = sample((n * channels + c) * step);
  return { rate, data: out };
}
/** IEEE float 32 WAV bytes of planar PCM. */
export function wavBytes(rate: number, data: Float32Array[]): Uint8Array {
  const frames = data[0]?.length ?? 0, size = frames * data.length * 4, out = new Uint8Array(44 + size), v = new DataView(out.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); v.setUint32(4, 36 + size, true); text(8, 'WAVE'); text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, data.length, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * data.length * 4, true); v.setUint16(32, data.length * 4, true); v.setUint16(34, 32, true); text(36, 'data'); v.setUint32(40, size, true);
  for (let n = 0; n < frames; n++) for (let c = 0; c < data.length; c++) v.setFloat32(44 + (n * data.length + c) * 4, data[c][n], true);
  return out;
}

// ---- Media: decoded at the mix rate, probed into asset records.
const isWav = (file: string) => /\.wav$/i.test(file);
function ffmpeg(tool: string, args: string[]) {
  const r = spawnSync(tool, args, { maxBuffer: 1 << 31 });
  if (r.error || r.status !== 0) throw Error(`${tool} failed: ${r.error?.message ?? r.stderr?.toString().slice(-300)}`);
  return r.stdout;
}
export async function decodeMedia(file: string): Promise<Float32Array[]> {
  if (isWav(file)) { const w = readWav(await readFile(file)); return w.rate === MIX_RATE ? w.data : resamplePlanar(w.data, w.rate); }
  const b = ffmpeg('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(MIX_RATE), '-']), f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 8)));
  const out: Stereo = [new Float32Array(f.length / 2), new Float32Array(f.length / 2)];
  for (let n = 0; n < out[0].length; n++) { out[0][n] = f[2 * n]; out[1][n] = f[2 * n + 1]; }
  return out;
}
type Probe = { video: { width: number; height: number; fps: number } | null; audio: { sampleRate: number; channels: number } | null; durationMs: number };
async function probeMedia(file: string): Promise<Probe> {
  if (isWav(file)) { const w = readWav(await readFile(file)); return { video: null, audio: { sampleRate: w.rate, channels: w.data.length }, durationMs: w.data[0].length * 1000 / w.rate }; }
  const p = JSON.parse(ffmpeg('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString()), streams: Rec[] = p.streams ?? [];
  const v = streams.find(s => s.codec_type === 'video'), a = streams.find(s => s.codec_type === 'audio'), [num, den] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number);
  return { video: v ? { width: Number(v.width), height: Number(v.height), fps: den ? num / den : 0 } : null, audio: a ? { sampleRate: Number(a.sample_rate), channels: Number(a.channels) } : null, durationMs: Number(p.format?.duration) * 1000 };
}
async function mediaAssets(media: Record<string, string>): Promise<{ assets: Asset[]; links: AssetLink[]; files: Map<string, string> }> {
  const out = { assets: [] as Asset[], links: [] as AssetLink[], files: new Map<string, string>() };
  for (const [xappId, file] of Object.entries(media)) {
    const p = await probeMedia(file), id = `g09-${out.assets.length + 1}`, type = p.video ? 'video' : 'audio', mimeType = p.video ? 'video/mp4' : isWav(file) ? 'audio/wav' : 'audio/mp4';
    if (!p.audio && !p.video) throw Error(`--media: ${file} has no audio or video stream`);
    out.assets.push({ id, name: path.basename(file), type, sizeBytes: 0, mimeType, folderId: null, created_at: '', recorded_at: null, location: null, durationMs: p.durationMs, processing_status: 'ready', last_error_code: null,
      media: { container: isWav(file) ? 'wav' : 'mp4', mimeType, durationMs: p.durationMs, image: null,
        video: p.video && { displayWidth: p.video.width, displayHeight: p.video.height, codedWidth: p.video.width, codedHeight: p.video.height, fps: p.video.fps, rotation: 0 },
        audio: p.audio && { codec: isWav(file) ? 'pcm' : 'aac', ...p.audio } } } as unknown as Asset);
    // The stored inputs name assets by Xapp's project id, so that id is the link's agent id (as G-01).
    out.links.push({ id: `g09:${id}`, projectId: 'g09', assetId: id, agent_id: xappId, content_type: type, added_at: '', deleted_at: null });
    out.files.set(id, file);
  }
  return out;
}
function mediaSource(files: Map<string, string>): AudioSource {
  const pcm = new Map<string, Promise<Float32Array[]>>();
  return async (i: RecordData, startS: number, endS: number) => {
    const file = files.get(i.metadata?.assetId); if (!file) return null;
    if (!pcm.has(file)) pcm.set(file, decodeMedia(file));
    const data = await pcm.get(file)!, start = Math.max(0, Math.floor(startS * MIX_RATE)), end = Math.min(data[0].length, Math.ceil(endS * MIX_RATE));
    return { start, data: data.map(c => c.slice(start, Math.max(start, end))) };
  };
}

// ---- Sections.
const sounding = (i: RecordData) => i.type === 'video' || i.type === 'audio';
/** The spans between the clips' edges (each at least 20 ms), when no sections are given. */
export function clipSections(items: RecordData[], endMs: number): G09Section[] {
  const edges = [...new Set([0, endMs, ...items.filter(sounding).flatMap(i => [i.display.from, i.display.to])])].filter(t => t >= 0 && t <= endMs).sort((a, b) => a - b);
  return edges.slice(1).map((t, n) => ({ fromS: edges[n] / 1000, toS: t / 1000 })).filter(s => s.toS - s.fromS >= 0.02).map((s, n) => ({ name: `section ${n + 1}`, ...s }));
}
const slice = (s: Stereo | Float32Array[], a: number, b: number): Stereo => [s[0].subarray(a, b), (s[1] ?? s[0]).subarray(a, b)];

// ---- Replay.
const OWNERS: Record<string, string> = { captureFrame: 'T15', exportProject: 'T16', getExportStatus: 'T16' };
type StepReport = { id: string; tool: string; status: 'passed' | 'failed' | 'uncompared'; diffs: Diff[]; note?: string };
export async function runG09(referenceDir: string, o: G09Options) {
  if (!o.toolField || !o.inputField) throw Error('--tool-field and --input-field are required (the stored record schema is not documented)');
  const stored = await loadStored(referenceDir, o.blockBase), base = await realpath(referenceDir);
  const wav = await realpath(path.join(base, REFERENCE_WAV)).catch(() => { throw Error(`No ${REFERENCE_WAV} in ${referenceDir}`); });
  if (!inside(base, wav)) throw Error(`${REFERENCE_WAV} escapes the reference directory`);
  const out = await resolvedDestination(path.resolve(o.output ?? 'parity-reports/g09'));
  if (inside(base, out) || inside(out, base)) throw Error('Output/reference directories overlap or alias');
  await mkdir(out, { recursive: true });
  const { assets, links, files } = await mediaAssets(o.media), steps: StepReport[] = [];
  let n = 0;
  setIdSource(() => String(++n).padStart(6, '0'));
  const e = createEditor(undefined, { assets, links }), map = new IdMap(), known = new Set<string>();
  try {
    for (const step of o.calls.flat()) {
      let id: string, tool: string, input: Json;
      if (typeof step === 'string') {
        const r = stored.record(step);
        if (!r) throw Error(`--calls names ${step}, which has no results/${step}.json`);
        const missing = [o.toolField, o.inputField].find(f => !(f in r));
        if (missing) throw Error(`results/${step}.json has no '${missing}' field; its top-level keys are: ${Object.keys(r).join(', ')}`);
        id = step; tool = String(r[o.toolField]); input = typeof r[o.inputField] === 'string' ? JSON.parse(r[o.inputField] as string) : r[o.inputField];
      } else ({ id, tool, input } = step);
      const report: StepReport = { id, tool, status: 'uncompared', diffs: [] };
      steps.push(report);
      if (!TOOLS[tool]) { report.note = `not replayed: '${tool}' is not a direct-call tool (${OWNERS[tool] ?? 'its owning ticket'} compares it)`; continue; }
      const ours = e.call(tool, map.input(input) as RecordData) as unknown as Rec, vCall = typeof step === 'string' ? callResult(stored.blocks(id)) : undefined;
      [...e.doc.tracks, ...e.doc.items].forEach(x => known.add(x.id));
      if (!vCall) { report.note = 'no stored call result'; continue; }
      learnCall(map, vCall, ours, known);
      const v = map.translate(vCall) as Rec;
      if (v.success !== ours.success) report.diffs.push({ part: 'call', path: 'success', expected: v.success ?? null, actual: ours.success ?? null });
      if ('code' in v && v.code !== ours.code) report.diffs.push({ part: 'call', path: 'code', expected: v.code ?? null, actual: ours.code ?? null });
      report.diffs.push(...map.conflicts.splice(0));
      report.status = report.diffs.length ? 'failed' : 'passed';
    }
  } finally { setIdSource(null); }
  // The mix: the whole timeline in the export parity mode, against Xapp's decoded export.
  const doc = e.doc, ref = readWav(await readFile(wav));
  if (ref.rate !== MIX_RATE) throw Error(`${REFERENCE_WAV} is ${ref.rate} Hz; the mix is ${MIX_RATE} Hz`);
  const endMs = Math.max(0, ...doc.items.map(i => i.display.to)), ours = await renderAudio({ doc, fromMs: 0, toMs: endMs, source: mediaSource(files), mode: 'parity' });
  await atomicWrite(out, 'cutframe-audio-f32.wav', wavBytes(MIX_RATE, ours.channels));
  const starts = doc.items.filter(sounding).map(i => Math.round(i.display.from * PER_MS)), frames = Math.min(ref.data[0].length, ours.channels[0].length);
  const sections = (o.sections ?? clipSections(doc.items, endMs)).map(s => {
    const a = Math.max(0, Math.round(s.fromS * MIX_RATE)), b = Math.min(frames, Math.round(s.toS * MIX_RATE));
    const exclude = starts.filter(f => f + CLIP_START_MS * PER_MS > a && f < b).map(f => [Math.max(0, f - a), f - a + CLIP_START_MS * PER_MS] as [number, number]);
    const c: AudioComparison | null = b > a ? compareAudio(slice(ref.data, a, b), slice(ours.channels, a, b), { maxLagMs: o.maxLagMs ?? 50, exclude }) : null;
    return { ...s, excludedClipStarts: exclude.length, ...(c ?? { passed: false, note: 'outside the reference or the mix' }) };
  });
  const failedSteps = steps.filter(s => s.status === 'failed').length, failedSections = sections.filter(s => !s.passed).length;
  const status = failedSteps || failedSections ? 'failed' : sections.length ? 'passed' : 'uncompared';
  const report = { version: 1, golden: 'G-09', status, blockBase: stored.blockBase, mode: 'parity',
    summary: `${sections.length - failedSections}/${sections.length} sections within the audio gates; calls: ${steps.filter(s => s.status === 'passed').length} passed, ${failedSteps} failed, ${steps.filter(s => s.status === 'uncompared').length} uncompared`,
    lengths: { referenceS: ref.data[0].length / MIX_RATE, oursS: ours.channels[0].length / MIX_RATE },
    nullMeans: 'a dB figure of null is −∞ (digital silence, or an exact match for residualDb); gainDb / peakDb null: both signals silent',
    tracks: stack(doc).map(id => track(doc, id)!.name ?? id),
    notCompared: 'the stored preview and export frames (T15 / T16), the encoded export file and its ffprobe facts (T16), everything in a stored call result except success and code',
    sections, steps };
  await atomicJson(out, 'report.json', report);
  return report;
}
