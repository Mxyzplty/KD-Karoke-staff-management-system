// SPDX-License-Identifier: AGPL-3.0-only
// import-reference on a synthetic capture in the documented layout (tool results "Stored reference"):
// results.jsonl + results/<id>.json, frames/export/E-<t>.png, exports/<name>.mp4 + exports/ffprobe.json.
import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importReference } from '../parity/reference';
import { decodePng16 } from '../parity/frames';
import { runScenario, type ParityAdapter, type Scenario } from '../parity/runner';
import type { Json } from '../parity/normalise';

const times = [0, 500, 1000];
const pixels = (t: number) => Uint8Array.from({ length: 4 * 2 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 17 + t / 10) % 256));
const results: Json[] = [{ success: true, id: 'item-1' }, { success: false, code: 'INVALID_PAIR' }];
const ffprobe = { streams: [{ codec_name: 'h264', width: 4, height: 2, nb_read_frames: '30' }], format: { duration: '1.000000' } };
async function capture(dir: string, change: { frame?: number; result?: boolean; export?: boolean } = {}) {
  await mkdir(path.join(dir, 'results'), { recursive: true }); await mkdir(path.join(dir, 'frames/export'), { recursive: true }); await mkdir(path.join(dir, 'exports'), { recursive: true });
  await writeFile(path.join(dir, 'results.jsonl'), 'c01\nc02'.split('\n').map(id => JSON.stringify({ id, tool: 'probe' })).join('\n') + '\n');
  await writeFile(path.join(dir, 'results/c01.json'), JSON.stringify(results[0]));
  await writeFile(path.join(dir, 'results/c02.json'), JSON.stringify(change.result ? { ...(results[1] as object), code: 'OTHER' } : results[1]));
  for (const t of times) {
    const raw = path.join(dir, `raw-${t}`), data = pixels(t);
    if (change.frame === t) data[5] ^= 0x40;
    await writeFile(raw, data);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '4x2', '-i', raw, '-frames:v', '1', path.join(dir, `frames/export/E-${t}.png`)]);
  }
  await writeFile(path.join(dir, 'exports/G-xx.mp4'), 'not really an mp4, only hashed');
  await writeFile(path.join(dir, 'exports/ffprobe.json'), JSON.stringify(change.export ? { ...ffprobe, format: { duration: '1.033333' } } : ffprobe));
}
// The adapter reproduces exactly what the capture holds.
const adapter: ParityAdapter = { name: 'import-probe', async open() {}, async execute(_t, input) { return results[(input as { n: number }).n]; }, async project() { return { tracks: [{ id: 't' }] }; },
  async frame(t) { return { width: 4, height: 2, rgba: Array.from(pixels(t), v => v / 255) }; },
  async exportMetadata() { return { file: 'G-xx.mp4', bytes: 30, sha256: '4b08a163832b04a8bb63ce5831dc281aa510f192645aaf54e5216bbbc119e489', ffprobe }; } };
const scenario: Scenario = { version: 1, inputMode: 'fixture-free', name: 'imported capture', project: {}, edits: [{ tool: 'probe', input: { n: 0 } }, { tool: 'probe', input: { n: 1 } }], sampleTimesMs: times };
const options = { callIdField: 'id', frames: 'frames/export', timeFrom: 'name-ms' };

it('imports a capture into the reference layout; --xapp-ref passes, and a changed frame, call result or export field fails by name', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 't00-import-')), project = path.join(dir, 'project.json');
  await writeFile(project, JSON.stringify({ normalisationVersion: 1, project: { tracks: [{ id: 'track:1' }] } }));
  const run = async (label: string, change = {}) => {
    const cap = path.join(dir, `capture-${label}`), ref = path.join(dir, `ref-${label}`);
    await capture(cap, change);
    const imported = await importReference(cap, ref, { ...options, project });
    expect(imported.written.sort()).toEqual(['command-results.json', 'export-metadata.json', 'frames.json', 'project.normalised.json']);
    return runScenario(scenario, adapter, { output: path.join(dir, `out-${label}`), referenceDir: ref });
  };
  const exact = await run('exact');
  expect(exact.status).toBe('passed');
  const frame = await run('frame', { frame: 500 });
  expect(frame).toMatchObject({ status: 'failed', failedSampleTimesMs: [500] }); expect(frame.reason).toContain('frame at 500 ms differs');
  const call = await run('call', { result: true });
  expect(call.status).toBe('failed'); expect(call.reason).toContain('commandResults differs');
  const exported = await run('export', { export: true });
  expect(exported.status).toBe('failed'); expect(exported.reason).toContain('exportMetadata differs');
}, 120_000);

it('refuses what the docs leave open instead of guessing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 't00-import-open-')), cap = path.join(dir, 'capture');
  await capture(cap);
  await expect(importReference(cap, path.join(dir, 'z'), { frames: 'frames/export', timeFrom: 'name-ms' })).rejects.toThrow('pass --call-id-field');
  await expect(importReference(cap, path.join(dir, 'a'), { callIdField: 'id', frames: 'frames/export' })).rejects.toThrow('--time-from');
  await expect(importReference(cap, path.join(dir, 'b'), { ...options, callIdField: 'callId' })).rejects.toThrow('no "callId" field');
  await expect(importReference(cap, path.join(cap, 'inside'), options)).rejects.toThrow('overlap');
  await expect(importReference(cap, path.join(dir, 'c'), { callIdField: 'id', frames: '../elsewhere', timeFrom: 'name-ms' })).rejects.toThrow('inside the capture');
});

it('imports 16-bit RGB frames exactly and refuses pixel formats whose decode is not verified (gray16, ya16)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 't00-import-depth-'));
  const frameCapture = async (name: string, pixFmt: string, data: Buffer) => {
    const cap = path.join(dir, name); await mkdir(path.join(cap, 'frames'), { recursive: true });
    const raw = path.join(dir, `${name}.raw`); await writeFile(raw, data);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', '2x1', '-i', raw, '-frames:v', '1', path.join(cap, 'frames/F-0.png')]);
    return cap;
  };
  const deep = Buffer.alloc(12); [0, 1, 257, 40000, 65534, 65535].forEach((v, i) => deep.writeUInt16LE(v, i * 2));
  const rgb48 = await frameCapture('rgb48', 'rgb48le', deep);
  await importReference(rgb48, path.join(dir, 'rgb48-ref'), { frames: 'frames', timeFrom: 'name-ms' });
  const meta = JSON.parse(await readFile(path.join(dir, 'rgb48-ref/frames.json'), 'utf8'));
  const back = decodePng16(await readFile(path.join(dir, 'rgb48-ref', meta.frames[0].file)));
  expect(Array.from(back.rgba, v => Math.round(v * 65535))).toEqual([0, 1, 257, 65535, 40000, 65534, 65535, 65535]);
  const gray16 = await frameCapture('gray16', 'gray16le', Buffer.from([0, 0, 255, 255]));
  await expect(importReference(gray16, path.join(dir, 'gray16-ref'), { frames: 'frames', timeFrom: 'name-ms' })).rejects.toThrow('pixel format gray16be is not supported');
  const ya16 = await frameCapture('ya16', 'ya16le', Buffer.alloc(8, 255));
  await expect(importReference(ya16, path.join(dir, 'ya16-ref'), { frames: 'frames', timeFrom: 'name-ms' })).rejects.toThrow('pixel format ya16be is not supported');
});
