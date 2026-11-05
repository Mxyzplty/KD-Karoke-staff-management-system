// SPDX-License-Identifier: AGPL-3.0-only
// Full-size sampled frames: metadata-only frames.json + one 16-bit PNG per sample, streamed.
import { it, expect } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScenario, type ParityAdapter, type Scenario } from '../parity/runner';
import { decodePng16, encodePng16, sha256 } from '../parity/frames';

const W = 1080, H = 1920, times = Array.from({ length: 81 }, (_, i) => i * 125);
// Every sample differs; a diagonal band keeps the content non-uniform.
function frame(t: number) {
  const rgba = new Float32Array(W * H * 4), v = (t % 4096) / 4095;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; rgba[i] = v; rgba[i + 1] = (x + y) % 64 < 8 ? 1 : 0; rgba[i + 2] = y / (H - 1); rgba[i + 3] = 1; }
  return { width: W, height: H, rgba };
}
const adapter: ParityAdapter = { name: 'frames-probe', async open() {}, async execute() { return { success: true }; }, async project() { return {}; }, async frame(t) { return frame(t); }, async exportMetadata() { return { frames: times.length }; } };
const scenario: Scenario = { version: 1, inputMode: 'fixture-free', name: 'full-size frames', project: {}, edits: [], sampleTimesMs: times };

it('records 81 frames at 1080×1920, compares them, names a one-pixel change by sample time and refuses a tampered file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 't00-frames-')), reference = path.join(dir, 'reference');
  expect((await runScenario(scenario, adapter, { output: reference })).status).toBe('uncompared');
  const meta = JSON.parse(await readFile(path.join(reference, 'frames.json'), 'utf8'));
  expect(meta).toMatchObject({ version: 2, pixelFormat: 'png-rgba16', sampleTimesMs: times });
  expect(Object.keys(meta.frames[0]).sort()).toEqual(['file', 'height', 'sha256', 'timeMs', 'width']); // metadata only, no pixels

  const pass = await runScenario(scenario, adapter, { output: path.join(dir, 'run'), referenceDir: reference });
  expect(pass.status).toBe('passed');
  expect((pass.comparisons as any).frames).toHaveLength(81);

  // One pixel of sample 40 (5000 ms) changes; the file and its hash stay consistent.
  const changed = path.join(dir, 'changed'); await cp(reference, changed, { recursive: true });
  const entry = meta.frames[40], png = decodePng16(await readFile(path.join(changed, entry.file)));
  png.rgba[(777 * W + 333) * 4] = png.rgba[(777 * W + 333) * 4] > 0.5 ? 0 : 1;
  const bytes = encodePng16(png); await writeFile(path.join(changed, entry.file), bytes);
  meta.frames[40] = { ...entry, sha256: sha256(bytes) }; await writeFile(path.join(changed, 'frames.json'), JSON.stringify(meta));
  const fail = await runScenario(scenario, adapter, { output: path.join(dir, 'run2'), referenceDir: changed });
  expect(fail.status).toBe('failed');
  expect(fail.failedSampleTimesMs).toEqual([5000]);
  expect(fail.reason).toContain('frame at 5000 ms differs');

  // A pixel file whose bytes no longer match frames.json is refused before the adapter runs.
  const tampered = path.join(dir, 'tampered'); await cp(changed, tampered, { recursive: true });
  const raw = await readFile(path.join(tampered, meta.frames[3].file)); raw[raw.length - 20] ^= 1; await writeFile(path.join(tampered, meta.frames[3].file), raw);
  await expect(runScenario(scenario, adapter, { output: path.join(dir, 'run3'), referenceDir: tampered })).rejects.toThrow(`hash mismatch: ${meta.frames[3].file}`);
}, 600_000);

it('writes frames into the resolved frames/ folder when frames/ is a junction inside the output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 't00-junction-')), out = path.join(dir, 'out'), store = path.join(out, 'deep', 'store');
  await mkdir(store, { recursive: true }); await symlink(store, path.join(out, 'frames'), 'junction');
  const small: ParityAdapter = { ...adapter, async frame() { return { width: 1, height: 1, rgba: [0.5, 0.5, 0.5, 1] }; } };
  const report = await runScenario({ ...scenario, sampleTimesMs: [0, 40] }, small, { output: out });
  expect(report.status).toBe('uncompared');
  expect((await readdir(store)).filter(f => f.endsWith('.png')).sort()).toEqual(['0000.png', '0001.png']);
});

it('16-bit PNG frames round-trip within half a 16-bit step', () => {
  const rgba = Float32Array.from([0, 0.25, 0.5, 1, 1 / 3, 2 / 3, 0.999, 0.0001]);
  const back = decodePng16(encodePng16({ width: 2, height: 1, rgba }));
  expect([back.width, back.height]).toEqual([2, 1]);
  back.rgba.forEach((v, i) => expect(Math.abs(v - rgba[i])).toBeLessThanOrEqual(0.5 / 65535 + 1e-7));
});
