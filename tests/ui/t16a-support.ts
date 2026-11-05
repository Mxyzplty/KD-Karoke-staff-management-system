// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the T16a export specs. Oracles are named in each spec: "ffprobe ground truth" (the exported file read back by
// ffprobe / ffmpeg), "formula oracle" (a float CPU reference computed from the written spec), "written-spec oracle" (findings text).
// Every export goes through startExport / getExportStatus (L12), driven from the page; the finished file is written to a temp file.
import { expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject, linkClip } from './t02-support';
import { uploadAsset } from './t15-support';

export { hasStore, NO_STORE, S1, STORE, fixture, haveFile, makeAudioClip, makeClip } from './t15-support';
/** The message the export reports when it falls back to Opus (written-spec oracle: coordinator ruling Q-F; the exact text). */
export const OPUS_MESSAGE = 'AAC-LC 48 kHz stereo is not supported by this browser, so the audio is Opus 48 kHz stereo in the MP4.';

const track = (id: string, kind: string) => ({ id, name: id.toUpperCase(), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
export type Clip = { id: string; type?: 'video' | 'image' | 'audio'; track?: string; from?: number; to?: number; trim?: number; sourceDuration?: number; details?: Record<string, unknown>; properties?: Record<string, unknown>; effects?: unknown[]; playbackRate?: number };
/** A schema-4 document: one track per distinct track id (audio items on audio tracks, the rest on video tracks, ids sorted = bottom first). */
export function mkDoc(clips: Clip[], extra: Record<string, unknown> = {}) {
  const trackOf = (c: Clip) => c.track ?? (c.type === 'audio' ? 'a1' : 'v1'), kinds = new Map<string, string>();
  for (const c of clips) kinds.set(trackOf(c), c.type === 'audio' ? 'audio' : 'video');
  const tracks = [...kinds.keys()].sort().map(id => track(id, kinds.get(id)!)), end = Math.max(...clips.map(c => c.to ?? 1000));
  return {
    schemaVersion: 4, rev: 0, groups: {}, duration: end, fps: 30, size: { width: 320, height: 180 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
    tracks, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })),
    items: clips.map(c => ({
      id: c.id, type: c.type ?? 'video', trackId: trackOf(c), display: { from: c.from ?? 0, to: c.to ?? 1000 }, trim: { from: c.trim ?? 0, to: (c.trim ?? 0) + (c.to ?? 1000) - (c.from ?? 0) },
      ...(c.type === 'image' ? {} : { sourceDuration: c.sourceDuration ?? 10000 }), details: { name: c.id, ...c.details }, ...(c.properties ? { properties: c.properties } : {}),
      ...(c.effects ? { effects: c.effects } : {}), ...(c.playbackRate ? { playbackRate: c.playbackRate } : {}),
    })),
    ...extra,
  };
}
const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
export const mimeOf = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

/** Opens the editor (T14 ingest fills asset.media only while it is open) and waits until every asset is ready or failed. */
export async function openAndIngest(page: Page, id: string, ingestTimeout = 120_000) {
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect.poll(() => page.evaluate(async () => {
    const p = '/src/store/database.ts', { projectStore } = await import(p);
    return (await projectStore.library()).assets.every((a: any) => a.processing_status === 'ready' || a.processing_status === 'failed');
  }), { timeout: ingestTimeout }).toBe(true);
}
/** Creates the project, uploads one file per clip id ({clip: file}), links them, opens the editor and waits for ingest; returns the project id and the asset id per clip. */
export async function setup(page: Page, doc: any, files: Record<string, string>, title = 'T16a fixture', ingestTimeout?: number) {
  const id = await createProject(page, doc, title), byFile = new Map<string, string>(), assets: Record<string, string> = {};
  for (const [clipId, file] of Object.entries(files)) {
    let a = byFile.get(file);
    if (!a) { a = await uploadAsset(page, id, readFileSync(file), path.basename(file), mimeOf(file)); byFile.set(file, a); }
    await linkClip(page, id, a, clipId); assets[clipId] = a;
  }
  await openAndIngest(page, id, ingestTimeout);
  return { id, assets };
}
/** Whether this Chromium can encode AAC-LC 48 kHz stereo at 192 kb/s (open item O2: the Ubuntu gate Chromium cannot; the export then writes Opus). */
export const aacSupported = (page: Page) => page.evaluate(async () => {
  // No catch: a thrown error fails the test.
  return (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })).supported === true;
});

export type Run = {
  status: 'completed' | 'failed'; error?: { code: string; category: string; kind: string; message: string; detail?: string };
  samples: any[]; result?: Record<string, any>; file?: string; wallMs: number; renderId: string;
};
/** Runs startExport / awaitExport in the page. `opts` are serialisable ExportOptions; `hook` is the body of an async function (ctx = {ex, store, doc, id}) whose
 *  returned object is merged over the options (page-side stubs: audio, storage, signal …). The finished file is written to a temp file. */
export async function runExport(page: Page, id: string, opts: Record<string, unknown> = {}, hook?: string, keep = true): Promise<Run> {
  const r = await page.evaluate(async ({ id, opts, hook, keep }) => {
    const s = '/src/store/database.ts', e = '/src/export/index.ts';
    const { projectStore } = await import(s), ex = await import(e), { document } = await projectStore.read(id);
    const AF = Object.getPrototypeOf(async function () { /* */ }).constructor;
    const extra = hook ? (await new AF('ctx', hook)({ ex, store: projectStore, doc: document, id })) ?? {} : {};
    const samples: unknown[] = [], t0 = performance.now();
    const renderId = ex.startExport({ store: projectStore, doc: document, title: 'T16a', ...opts, ...extra, onProgress: (p: unknown) => { samples.push(p); (window as unknown as { __t16prog: unknown }).__t16prog = p; } });
    const st = await ex.awaitExport(renderId);
    const wallMs = performance.now() - t0;
    if (st.status !== 'completed') return { status: st.status, error: st.error, samples, wallMs, renderId };
    const { blob, ...result } = st.result;
    let b64: string | null = null;
    if (keep) {
      const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      b64 = btoa(bin);
    }
    return { status: st.status, samples, result: { ...result, blobSize: blob.size, blobType: blob.type }, b64, wallMs, renderId };
  }, { id, opts, hook, keep });
  const { b64, ...rest } = r as any;
  if (b64 !== null && b64 !== undefined) { const dir = path.join(tmpdir(), 'cutframe-t16a'); mkdirSync(dir, { recursive: true }); rest.file = path.join(dir, `${randomUUID()}.mp4`); writeFileSync(rest.file, Buffer.from(b64, 'base64')); }
  return rest as Run;
}
/** Throws with the failure text when the run did not complete. */
export function completed(run: Run) { expect(run.status, `${run.error?.code}: ${run.error?.detail ?? run.error?.message}`).toBe('completed'); return run.result!; }

// ---- ffprobe / ffmpeg ground truth ----------------------------------------------------------------------------------------
export function ff(tool: 'ffprobe' | 'ffmpeg', args: string[], encoding: 'utf8' | 'buffer' = 'utf8') {
  const r = spawnSync(tool, args, { encoding: encoding === 'utf8' ? 'utf8' : undefined, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${tool} ${args.join(' ')}: ${String(r.stderr).slice(-400)}`);
  return r.stdout as any;
}
export const streams = (file: string): any[] => JSON.parse(ff('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).streams;
export const formatOf = (file: string): any => JSON.parse(ff('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', file])).format;

/** The Opus branch (AAC-LC not encodable, Q-F): result.audioCodec 'opus', OPUS_MESSAGE among the messages, an Opus 48 kHz stereo stream,
 *  and |audio start - video start| <= 1 frame, 0 <= audio duration - video duration <= 1 frame. Returns the audio stream. */
export function expectOpus(run: Run, fps: number) {
  const r = run.result!, all = streams(run.file!), v = all.find(s => s.codec_type === 'video'), a = all.find(s => s.codec_type === 'audio');
  expect(r.audioCodec).toBe('opus'); expect(r.messages).toContain(OPUS_MESSAGE);
  expect(all.map(s => s.codec_type).sort()).toEqual(['audio', 'video']);
  expect(a).toMatchObject({ codec_name: 'opus', sample_rate: '48000', channels: 2 });
  expect(Math.abs(Number(a.start_time) - Number(v.start_time))).toBeLessThanOrEqual(1 / fps);
  const gap = Number(a.duration) - Number(v.duration);
  expect(gap).toBeGreaterThanOrEqual(-1e-6); expect(gap).toBeLessThanOrEqual(1 / fps);
  return a;
}
/** Per-frame facts of the first video stream, presentation order. */
export const videoFrames = (file: string): { pict_type: string; key_frame: number; pts_time: number }[] =>
  (JSON.parse(ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pict_type,key_frame,pts_time', '-of', 'json', file])).frames as any[])
    .map(f => ({ pict_type: f.pict_type, key_frame: Number(f.key_frame), pts_time: Number(f.pts_time) })).sort((a, b) => a.pts_time - b.pts_time);
/** Packets of one stream selector ('v:0' / 'a:0') with an MD5 of each packet's bytes, in file order. */
export const packets = (file: string, sel: string): { pts_time: number; dts_time: number; size: number; flags: string; data_hash: string }[] =>
  (JSON.parse(ff('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_packets', '-show_data_hash', 'MD5', '-of', 'json', file])).packets as any[])
    .map(p => ({ pts_time: Number(p.pts_time), dts_time: Number(p.dts_time), size: Number(p.size), flags: p.flags, data_hash: p.data_hash }));
/** The video as RGBA frames, decoded by ffmpeg with the stream's own colour tags (BT.709 limited → full RGB). */
export function decodeRgba(file: string, width: number, height: number): Buffer[] {
  const buf = ff('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], 'buffer') as Buffer, size = width * height * 4, out: Buffer[] = [];
  for (let o = 0; o + size <= buf.length; o += size) out.push(buf.subarray(o, o + size));
  return out;
}
/** Stereo float PCM at 48 kHz from the first audio stream (ffmpeg), planar. */
export function decodePcm(file: string): { left: Float32Array; right: Float32Array } {
  const buf = ff('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], 'buffer') as Buffer;
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4))), n = all.length >> 1, left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = all[i * 2]; right[i] = all[i * 2 + 1]; }
  return { left, right };
}
export const rms = (x: Float32Array, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, to - from)); };
/** An ffmpeg-generated clip: lavfi video input + optional lavfi audio, written once per machine run. */
export function genMedia(name: string, args: string[]): string {
  const dir = path.join(tmpdir(), 'cutframe-t16a-media'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  if (!existsSync(out)) ff('ffmpeg', ['-v', 'error', '-y', ...args, out]);
  return out;
}
/** A 160x90 testsrc2 H.264 clip with its hue turned by `hue` degrees (distinct bytes = a distinct asset). */
export const hueClip = (name: string, hue: number, seconds = 1) => genMedia(name, ['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30:duration=${seconds}`, '-vf', `hue=h=${hue}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p']);
/** An image-only document (no audio stream): one still for `ms` at `fps`. */
export const imageDoc = (ms: number, fps: number, size = { width: 160, height: 90 }) => mkDoc([{ id: 'img', type: 'image', from: 0, to: ms }], { fps, size });

/** A T06 rectangle in the stored shape form of timeline/shapes.ts shapeRecord (W3-RT-08): the preset's corners (0,0) (w,0) (w,h) (0,h)
 *  (presetPoints), the box (position = top-left, width, height) and the style as stored properties. */
export const rectShape = (id: string, trackId: string, display = { from: 0, to: 1000 }, fill = '#ff0000') => {
  const p = (v: unknown) => ({ defaultValue: v, keyframes: [] });
  return {
    name: 'Shape rectangle', id, type: 'shape', trackId, display,
    details: { src: '', path: 'M 0,0 L 160,0 L 160,90 L 0,90 Z', points: [{ anchor: { x: 0, y: 0 } }, { anchor: { x: 160, y: 0 } }, { anchor: { x: 160, y: 90 } }, { anchor: { x: 0, y: 90 } }], closed: true, width: 160, height: 90 },
    properties: { positionX: p(80), positionY: p(45), width: p(160), height: p(90), opacity: p(1), scale: p(1), rotation: p(0), fillColor: p(fill), fillOpacity: p(1), strokeColor: p('none'), strokeWidth: p(0), strokeOpacity: p(1) },
    metadata: { shapeType: 'rectangle' },
  };
};
