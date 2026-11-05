// SPDX-License-Identifier: AGPL-3.0-only
// T03 G-01 replay support (parity/g01.ts) against a SYNTHETIC stored reference written by parity/g01-synthetic.ts. This is NOT Xapp parity:
// no real stored reference is read here. Oracle: agent tool results §5 G-01 (stored-file reading, @@SAME blocks, Q32 deviation), ticket § T03.
// Provisional: the synthetic folder is written by the implementer's own writer (independent layout writers), so a pass proves the replay
// machinery (id learning, comparison, error paths, CLI exit codes), not that Cutframe matches Xapp.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadStored, runG01 } from '../parity/g01';
import { SYNTHETIC_FIELDS, writeSyntheticG01 } from '../parity/g01-synthetic';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const BLOCK = '\n<<<BLOCK>>>\n';
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'g01-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const folder = async (blockBase?: 0 | 1) => { const dir = path.join(root, 'ref'); const written = await writeSyntheticG01(dir, { blockBase }); return { dir, ...written, out: path.join(root, 'out') }; };
const readRecord = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, 'results', `${name}.json`), 'utf8')) as Record<string, any>;
const writeRecord = (dir: string, name: string, record: unknown) => writeFile(path.join(dir, 'results', `${name}.json`), JSON.stringify(record, null, 2));
const run = (f: Awaited<ReturnType<typeof folder>>, extra: Partial<Parameters<typeof runG01>[1]> = {}) =>
  runG01(f.dir, { calls: f.calls, assets: f.assets, toolField: f.toolField, inputField: f.inputField, output: f.out, ...extra });
const failing = (report: Awaited<ReturnType<typeof runG01>>) => report.parts.flatMap(p => p.steps).filter(s => s.status === 'failed');

describe('G-01 replay support (synthetic stored reference, not Xapp parity)', () => {
  it('replays the synthetic folder to a pass for both @@SAME block bases, detecting the base itself', async () => {
    for (const base of [1, 0] as const) {
      await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
      const f = await folder(base); expect(f.blockBase).toBe(base);
      const report = await run(f); // the base is auto-detected: it is not passed
      expect(report.blockBase, `base ${base}`).toBe(base);
      expect(report, `base ${base}`).toMatchObject({ version: 1, golden: 'G-01', status: 'passed', steps: 21, passed: 21, failed: 0, uncompared: 0 });
      expect(JSON.parse(await readFile(path.join(f.out, 'report.json'), 'utf8')).status).toBe('passed'); // report.json is written
    }
  });

  it('learns the id map (Xapp ids → replayed ids); the two ids differ and every mapped id exists in the replayed document', async () => {
    const f = await folder(); const report = await run(f);
    const [a, b] = report.parts;
    expect(Object.keys(a.ids)).toHaveLength(6); expect(Object.keys(b.ids)).toHaveLength(5);
    expect(a.ids['track_a2f3']).toBeDefined(); expect(a.ids['track_a2f3']).not.toBe('track_a2f3');
    for (const part of report.parts) for (const [xapp, ours] of Object.entries(part.ids)) { expect(typeof ours, xapp).toBe('string'); expect(ours, xapp).not.toBe(''); }
    expect(new Set(Object.values(a.ids)).size).toBe(6); // one replayed id per Xapp id
  });

  it('a perturbed S12 viewItemDetails endTime (+0.5 s) fails exactly S12 with a vid diff', async () => {
    const f = await folder(); const r = await readRecord(f.dir, 'S12.vid');
    const blocks = (r.result_text as string).split(BLOCK); const data = JSON.parse(blocks[1]); data.data.results[0].endTime += 0.5; blocks[1] = JSON.stringify(data);
    await writeRecord(f.dir, 'S12.vid', { ...r, result_text: blocks.join(BLOCK) });
    const report = await run(f); const bad = failing(report);
    expect(report.status).toBe('failed'); expect(report.failed).toBe(1); expect(bad.map(s => s.id)).toEqual(['S12']);
    expect(bad[0].diffs).toHaveLength(1); const d = bad[0].diffs[0];
    expect(d).toMatchObject({ part: 'vid', expected: 4.5, actual: 4 }); expect(d.path).toMatch(/\.endTime$/);
    expect(Object.values(report.parts[0].ids)).toContain(d.path.replace(/\.endTime$/, '')); // the path names our id, not Xapp's
  });

  it("a stored tool that is not a T03 tool is 'uncompared' with its owner note, so the run is 'uncompared' (exit 2), not a pass", async () => {
    const f = await folder(); const calls = [[...f.calls[0], 'S90'], f.calls[1]];
    const report = await run(f, { calls }); const s90 = report.parts[0].steps.find(s => s.id === 'S90')!;
    expect(report.status).toBe('uncompared'); expect(report.uncompared).toBe(1); expect(report.failed).toBe(0);
    expect(s90.status).toBe('uncompared'); expect(s90.note).toMatch(/^not replayed: 'generateCaptions' is not a T03 tool/);
  });

  it('a wrong --tool-field names the missing field and the keys the stored record does have', async () => {
    const f = await folder();
    await expect(run(f, { toolField: 'tool' })).rejects.toThrow("results/S1.json has no 'tool' field; its top-level keys are: tool_name, tool_input, result_text, notes");
    await expect(run(f, { toolField: '', inputField: '' })).rejects.toThrow(/--tool-field and --input-field are required/);
  });

  it("Q32 is compared as the documented deviation (stored refusal 'Group is locked'); a different stored error fails it citing §5", async () => {
    const f = await folder(); const report = await run(f); const q32 = report.parts[1].steps.find(s => s.id === 'Q32')!;
    expect(q32.compared).toEqual(['call(Q32 deviation)']); expect(q32.status).toBe('passed'); expect(q32.diffs).toEqual([]);
    // Q34 (viewItemDetails after Q32) passes only because the replay patches the moved item's layer to K-V1: covered by the whole-run pass.
    expect(report.parts[1].steps.find(s => s.id === 'Q34')!.status).toBe('passed');
    const r = await readRecord(f.dir, 'Q32'); const blocks = (r.result_text as string).split(BLOCK); const data = JSON.parse(blocks[1]); data.error = 'Other'; blocks[1] = JSON.stringify(data);
    await writeRecord(f.dir, 'Q32', { ...r, result_text: blocks.join(BLOCK) });
    const bad = failing(await run(f)); expect(bad.map(s => s.id)).toEqual(['Q32']);
    expect(bad[0].diffs[0]).toMatchObject({ part: 'call', path: 'Q32' }); expect(bad[0].diffs[0].note).toMatch(/§5/);
  });

  describe('loadStored error paths', () => {
    const s10 = async (dir: string, blocks: string[]) => { const r = await readRecord(dir, 'S10'); await writeRecord(dir, 'S10', { ...r, result_text: blocks.join(BLOCK) }); };

    it('reads the written folder: file list, resolved @@SAME blocks equal the referenced file, same-as files resolve', async () => {
      const { dir, blockBase } = await folder(); const stored = await loadStored(dir);
      expect(stored.blockBase).toBe(blockBase); expect(stored.has('S1')).toBe(true); expect(stored.has('S90')).toBe(true); expect(stored.has('Nope')).toBe(false);
      expect(stored.blocks('S10')).toEqual(stored.blocks('S9.ctx')); expect(stored.blocks('S11')).toEqual(stored.blocks('S10')); // @@SAME and the notes-named same-as file
    });
    it('an @@SAME reference to a missing file throws "unknown file"', async () => {
      const { dir } = await folder(); await s10(dir, ['@@SAME:NOPE#1']);
      await expect(loadStored(dir)).rejects.toThrow(/unknown file/);
    });
    it('an out-of-range block throws "out of range" when the base is given; without a base the numbering cannot be told', async () => {
      const { dir } = await folder(); await s10(dir, ['@@SAME:S9.ctx#9', '@@SAME:S9.ctx#9']);
      await expect((async () => (await loadStored(dir, 1)).blocks('S10'))()).rejects.toThrow(/out of range/);
      await expect(loadStored(dir)).rejects.toThrow('pass --block-base 0 or --block-base 1');
    });
    it('a same-as file whose notes name no stored file throws "no stored file"', async () => {
      const { dir } = await folder(); const r = await readRecord(dir, 'S11'); await writeRecord(dir, 'S11', { ...r, notes: 'Nothing named here.' });
      await expect((async () => (await loadStored(dir)).blocks('S11'))()).rejects.toThrow(/no stored file/);
    });
    it('an @@SAME cycle between two files throws "cycle" when the block is resolved', async () => {
      const { dir } = await folder(); await writeRecord(dir, 'CYC1', { result_text: '@@SAME:CYC2#1', notes: '' }); await writeRecord(dir, 'CYC2', { result_text: '@@SAME:CYC1#1', notes: '' });
      await expect((async () => (await loadStored(dir, 1)).blocks('CYC1'))()).rejects.toThrow(/cycle/);
    });
    it('both #0 and #<block count> references without a base throw "contradictory"; passing the base avoids it', async () => {
      const { dir } = await folder(1); await writeRecord(dir, 'MIX', { result_text: '@@SAME:S9.ctx#0', notes: '' });
      await expect(loadStored(dir)).rejects.toThrow(/contradictory/);
      await expect(loadStored(dir, 1)).resolves.toBeDefined();
    });
    it('a folder with no results/ folder throws "No results/ folder"', async () => {
      const empty = path.join(root, 'empty'); await mkdir(empty);
      await expect(loadStored(empty)).rejects.toThrow(/No results\/ folder/);
    });
  });

  it('the output directory may not sit inside (or contain) the reference directory', async () => {
    const f = await folder();
    await expect(run(f, { output: path.join(f.dir, 'report') })).rejects.toThrow(/overlap/);
    await expect(run(f, { output: root })).rejects.toThrow(/overlap/);
  });

  describe('CLI (npm run parity -- --golden G-01 …)', () => {
    const cli = (args: string[]) => spawnSync(process.execPath, [TSX, 'parity/cli.ts', ...args], { encoding: 'utf8', timeout: 120000 });
    const common = (f: Awaited<ReturnType<typeof folder>>) => ['--golden', 'G-01', '--xapp-ref', f.dir, '--calls', path.join(f.dir, 'calls.json'), '--assets', path.join(f.dir, 'assets.json'),
      '--tool-field', SYNTHETIC_FIELDS.toolField, '--input-field', SYNTHETIC_FIELDS.inputField, '--output', f.out];

    it('exits 0 and prints status passed for the synthetic folder', async () => {
      const f = await folder(); const r = cli(common(f));
      expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout)).toMatchObject({ golden: 'G-01', status: 'passed', steps: 21, passed: 21 });
    });
    it('exits 1 for a perturbed folder', async () => {
      const f = await folder(); const rec = await readRecord(f.dir, 'S12.vid'); const blocks = (rec.result_text as string).split(BLOCK); const data = JSON.parse(blocks[1]); data.data.results[0].endTime += 0.5; blocks[1] = JSON.stringify(data);
      await writeRecord(f.dir, 'S12.vid', { ...rec, result_text: blocks.join(BLOCK) });
      const r = cli(common(f)); expect(r.status).toBe(1); expect(JSON.parse(r.stdout).status).toBe('failed');
    });
    it('exits 2 when a step is uncompared', async () => {
      const f = await folder(); const calls = path.join(root, 'calls-s90.json'); await writeFile(calls, JSON.stringify([[...f.calls[0], 'S90'], f.calls[1]]));
      const args = common(f); args[args.indexOf('--calls') + 1] = calls;
      const r = cli(args); expect(r.status).toBe(2); expect(JSON.parse(r.stdout).status).toBe('uncompared');
    });
    it('--golden G-99 and missing arguments are usage errors (non-zero, usage text)', async () => {
      const f = await folder(); const other = common(f); other[1] = 'G-99';
      const a = cli(other); expect(a.status).not.toBe(0); expect(a.stderr).toMatch(/--golden G-01 --xapp-ref/);
      const b = cli(['--golden', 'G-01', '--xapp-ref', f.dir]); expect(b.status).not.toBe(0); expect(b.stderr).toMatch(/--calls <calls\.json>/);
    });
    it('--self-check together with --xapp-ref still refuses', async () => {
      const f = await folder(); const r = cli(['--self-check', '--xapp-ref', f.dir]);
      expect(r.status).not.toBe(0);
    });
  });
});
