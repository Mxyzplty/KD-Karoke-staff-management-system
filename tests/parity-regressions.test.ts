// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runScenario, compareFrames, type ParityAdapter, type Scenario, type Frame } from '../parity/runner';
import { normalise, canonical, type Json } from '../parity/normalise';
const pixel: Frame = { width: 1, height: 1, rgba: [0, 0, 0, 1] };
const scenario = (): Scenario => ({ version: 1, inputMode: 'fixture-free', name: 'review regression', project: {}, edits: [{ tool: 'probe', input: {} }], sampleTimesMs: [0], expected: { project: {}, frames: [pixel], commandResults: [{ success: true }], exportMetadata: {} } });
const adapter = (overrides: Partial<ParityAdapter> = {}): ParityAdapter => ({ name: 'test', async open() {}, async execute() { return { success: true }; }, async project() { return {}; }, async frame() { return pixel; }, async exportMetadata() { return {}; }, ...overrides });
const temp = () => mkdtemp(path.join(os.tmpdir(), 't00-regression-'));
const files = ['project.normalised.json', 'frames.json', 'export-metadata.json', 'command-results.json', 'report.json'];
async function snapshot(dir: string) { return Promise.all(files.map(f => readFile(path.join(dir, f), 'hex'))); }
it('R1 rejects overlaps and directory aliases before writes/adapter execution', async () => {
  const dir = await temp(); const reference = path.join(dir, 'reference');
  await runScenario(scenario(), adapter(), { output: reference }); const before = await snapshot(reference);
  let opened = false;
  for (const output of [reference, path.join(reference, 'child'), dir]) {
    await expect(runScenario(scenario(), adapter({ async open() { opened = true; } }), { output, referenceDir: reference })).rejects.toThrow('overlap');
  }
  const alias = path.join(dir, 'alias'); await symlink(reference, alias, 'junction');
  await expect(runScenario(scenario(), adapter(), { output: alias, referenceDir: reference })).rejects.toThrow('alias');
  expect(opened).toBe(false); expect(await snapshot(reference)).toEqual(before);
});
it('R1 output symlinks and hardlinks cannot mutate reference bytes', async () => {
  const dir = await temp(); const reference = path.join(dir, 'reference'); const output = path.join(dir, 'output');
  await runScenario(scenario(), adapter(), { output: reference }); const before = await snapshot(reference); await mkdir(output);
  await link(path.join(reference, files[0]), path.join(output, files[0]));
  // Windows file symlinks require a privilege absent on this host; directory
  // junctions above and hardlinks here remain exercised on Windows too.
  if (process.platform !== 'win32') await symlink(path.join(reference, files[1]), path.join(output, files[1]), 'file');
  const report = await runScenario(scenario(), adapter({ async project() { return { different: true }; } }), { output, referenceDir: reference });
  expect(report.status).toBe('failed'); expect(await snapshot(reference)).toEqual(before);
});
it('R2 compares ordered command outcomes, including expected refusal codes', async () => {
  const dir = await temp(); const reference = path.join(dir, 'reference');
  await runScenario(scenario(), adapter(), { output: reference });
  const failed = adapter({ async execute() { return { success: false, code: 'WRONG_RESULT' }; } });
  expect((await runScenario(scenario(), failed, { output: path.join(dir, 'stored'), referenceDir: reference })).status).toBe('failed');
  expect((await runScenario(scenario(), failed, { output: path.join(dir, 'inline') })).status).toBe('failed');
  const s = scenario(); s.expected!.commandResults = [{ success: false, code: 'EXPECTED_REFUSAL' }];
  expect((await runScenario(s, adapter({ async execute() { return { success: false, code: 'EXPECTED_REFUSAL' }; } }), { output: path.join(dir, 'refusal') })).status).toBe('passed');
  expect((await runScenario(s, failed, { output: path.join(dir, 'wrong-refusal') })).status).toBe('failed');
});
it('R3 validates all outputs even with partial or no expectations', async () => {
  const dir = await temp(); const s = scenario(); s.expected = { project: {} };
  for (const category of ['project', 'frame', 'exportMetadata'] as const) {
    const bad = adapter({ [category]: async () => ({ code: 'NOT_IMPLEMENTED' }) } as Partial<ParityAdapter>);
    expect((await runScenario(s, bad, { output: path.join(dir, category) })).status).toBe('not-implemented');
  }
  for (const frame of [{ width: 0, height: 1, rgba: [] }, { width: 1.5, height: 1, rgba: [] }, { ...pixel, rgba: [-3, 2, 20, 10] }, { ...pixel, rgba: [NaN, 0, 0, 1] }, { ...pixel, rgba: [0] }]) {
    expect(() => compareFrames(frame, frame)).toThrow();
    s.expected = undefined;
    expect((await runScenario(s, adapter({ async frame() { return frame; } }), { output: path.join(dir, `invalid-${String(frame.rgba[0])}`) })).status).toBe('failed');
  }
  s.expected = { project: {} };
  const partial = await runScenario(s, adapter(), { output: path.join(dir, 'partial') });
  expect(partial.status).toBe('uncompared'); expect(partial.missingComparisons).toContain('frames');
});
it('R4 compares ordered timestamps and rejects missing/malformed units and metadata', async () => {
  const dir = await temp(); const reference = path.join(dir, 'reference'); await runScenario(scenario(), adapter(), { output: reference });
  const s = scenario(); s.sampleTimesMs = [5000];
  await expect(runScenario(s, adapter(), { output: path.join(dir, 'changed'), referenceDir: reference })).rejects.toThrow('sampleTimesMs differ');
  const meta = JSON.parse(await readFile(path.join(reference, 'frames.json'), 'utf8'));
  for (const metadata of [{ ...meta, version: undefined }, { ...meta, timeUnit: 'seconds' }, { ...meta, sampleTimesMs: ['0'] }, { ...meta, frames: [{ ...meta.frames[0], timeMs: 5 }] }]) {
    await writeFile(path.join(reference, 'frames.json'), JSON.stringify(metadata));
    await expect(runScenario(scenario(), adapter(), { output: path.join(dir, 'missing'), referenceDir: reference })).rejects.toThrow(/frames\.json|frame entry|sampleTimesMs/);
  }
});
it('R5 retains literal dotted audit and ID keys as unknown semantic fields', () => {
  const a: Json = { audit: { savedAt: 1 }, 'audit.savedAt': 123, 'tracks.0.id': 'literal', tracks: [{ id: 'a' }] };
  const b: Json = { audit: { savedAt: 2 }, 'audit.savedAt': 456, 'tracks.0.id': 'changed', tracks: [{ id: 'b' }] };
  expect(canonical(normalise(a))).toContain('123'); expect(canonical(normalise(a))).toContain('literal');
  expect(canonical(normalise(a))).not.toBe(canonical(normalise(b)));
  expect(normalise(a).project).toMatchObject({ audit: { savedAt: '<audit>' }, tracks: [{ id: 'track:1' }] });
});
it('media verification rejects missing fixture store before adapter execution', async () => {
  const previous = process.env.CUTFRAME_FIXTURES; process.env.CUTFRAME_FIXTURES = path.join(await temp(), 'absent');
  let opened = false; const s = scenario(); delete s.inputMode;
  try { await expect(runScenario(s, adapter({ async open() { opened = true; } }), { output: path.join(await temp(), 'output') })).rejects.toThrow(/Fixture missing/); }
  finally { if (previous === undefined) delete process.env.CUTFRAME_FIXTURES; else process.env.CUTFRAME_FIXTURES = previous; }
  expect(opened).toBe(false);
});
