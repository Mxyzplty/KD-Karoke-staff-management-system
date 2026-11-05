// SPDX-License-Identifier: AGPL-3.0-only
// T10: G-07 replay support (parity/g07.ts, CLI `parity --golden G-07`) against a SYNTHETIC stored reference from parity/g07-synthetic.ts.
// This is NOT Xapp parity: no real stored reference is read. Written-spec oracle: agent tool results §9 (G-07), l.1350 (the effects block),
// error codes §7. The expected counts are counted by hand from the step list: 18 steps = S00 S01 R00 E01–E12 R01 G00 C00; 15 compared and
// equal (every S / R step and E01–E11), E12 a deferred schema refusal, G00 (getEffectDetails, T18) and C00 (captureFrame) uncompared; the four
// documented steps are those that see the `.cube` text sent in E09 (E09, E10, E11 and R01, whose blocks are E11.vid's by @@SAME). Perturbations edit
// the stored files by hand; each must fail the named step with the named diff.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runG07, stillAssets } from '../parity/g07';
import { writeSyntheticG07 } from '../parity/g07-synthetic';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const BLOCK = '\n<<<BLOCK>>>\n';
type Rec = Record<string, any>;
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'g07-t10-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const folder = async (o: { blockBase?: 0 | 1 } = {}) => { const dir = path.join(root, 'ref'); const written = await writeSyntheticG07(dir, o); return { dir, ...written, out: path.join(root, 'out') }; };
type Folder = Awaited<ReturnType<typeof folder>>;
const run = (f: Folder, extra: Partial<Parameters<typeof runG07>[1]> = {}) =>
  runG07(f.dir, { calls: f.calls, assets: f.assets, toolField: f.toolField, inputField: f.inputField, blockBase: f.blockBase, output: f.out, ...extra });
type Report = Awaited<ReturnType<typeof runG07>>;
const steps = (r: Report) => r.parts.flatMap(p => p.steps);
const step = (r: Report, id: string) => steps(r).find(s => s.id === id)!;
const idsWith = (r: Report, status: string) => steps(r).filter(s => s.status === status).map(s => s.id);

const file = (dir: string, name: string) => path.join(dir, 'results', `${name}.json`);
const readRecord = async (dir: string, name: string) => JSON.parse(await readFile(file(dir, name), 'utf8')) as Rec;
/** Edits the JSON block (block 1) of a stored record, whichever form (result_text / result_blocks) it was written in. */
async function edit(dir: string, name: string, change: (json: Rec) => void) {
  const r = await readRecord(dir, name);
  if (r.result_blocks) { const j = JSON.parse(r.result_blocks[1]); change(j); r.result_blocks[1] = JSON.stringify(j); }
  else { const b = (r.result_text as string).split(BLOCK), j = JSON.parse(b[1]); change(j); b[1] = JSON.stringify(j); r.result_text = b.join(BLOCK); }
  await writeFile(file(dir, name), JSON.stringify(r, null, 2));
}
/** The item record (`data.results[0]`) of the stored read `<id>.vid`. */
const editVid = (dir: string, id: string, change: (item: Rec) => void) => edit(dir, `${id}.vid`, j => change(j.data.results[0]));

describe('G-07 replay support: counts and report (synthetic stored reference, written-spec oracle, not Xapp parity)', () => {
  for (const blockBase of [1, 0] as const) {
    it(`1.${blockBase ? 'a' : 'b'} block base ${blockBase}: 18 steps, 15 passed, 0 failed, 1 deferred (E12), 2 uncompared (G00, C00), 4 documented; status "uncompared"; report.json written`, async () => {
      const f = await folder({ blockBase }); const report = await run(f);
      expect(report).toMatchObject({ golden: 'G-07', status: 'uncompared', blockBase, steps: 18, passed: 15, failed: 0, deferred: 1, uncompared: 2, documented: 4 });
      expect(steps(report).map(s => s.id)).toEqual(['S00', 'S01', 'R00', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'R01', 'G00', 'C00']);
      expect(idsWith(report, 'deferred')).toEqual(['E12']); expect(idsWith(report, 'uncompared')).toEqual(['G00', 'C00']);
      for (const s of steps(report).filter(s => s.status === 'passed')) { expect(s.diffs, s.id).toEqual([]); expect(s.compared.length, s.id).toBeGreaterThan(0); }
      expect(report.summary).toMatch(/15 passed, 0 failed, 1 deferred/); expect(report.summary).toMatch(/2 uncompared/); expect(report.summary).toMatch(/4 step\(s\) carry documented/);
      expect(JSON.parse(await readFile(path.join(f.out, 'report.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(report)));
    });
  }

  it('2. E12 is a deferred schema refusal naming INVALID_TOOL_INPUT with its deferred diffs; G00 and C00 carry notes; E01–E11 compare both the call and the read-back', async () => {
    const report = await run(await folder());
    const e12 = step(report, 'E12'); expect(e12.status).toBe('deferred'); expect(e12.diffs).toEqual([]); expect(e12.note).toContain('INVALID_TOOL_INPUT'); expect(e12.deferredDiffs!.length).toBeGreaterThan(0);
    expect(step(report, 'G00').note).toContain('T18'); expect(step(report, 'C00').note).toContain('preview frames');
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) { const s = step(report, `E${String(n).padStart(2, '0')}`); expect(s.compared, s.id).toEqual(expect.arrayContaining(['call', 'vid'])); }
    expect(Object.keys(report.parts[0].ids)).toEqual(expect.arrayContaining(['track_a2f3', 'clip-1']));
  });

  it('3. documented differences: E09 carries exactly the lutName diff on the call and on the read-back (path clip-1.effects[6].parameters.lutName, actual {value: "Synthetic warm"}); the other steps do not fail', async () => {
    const report = await run(await folder()); const e09 = step(report, 'E09');
    expect(e09.status).toBe('passed'); expect(e09.diffs).toEqual([]);
    expect(e09.documentedDiffs).toHaveLength(2);
    expect(e09.documentedDiffs!.map(d => d.part).sort()).toEqual(['call', 'vid']);
    for (const d of e09.documentedDiffs!) expect(d).toMatchObject({ path: 'clip-1.effects[6].parameters.lutName', expected: null, actual: { value: 'Synthetic warm' } });
    expect(steps(report).filter(s => s.documentedDiffs).map(s => s.id)).toEqual(['E09', 'E10', 'E11', 'R01']);
  });
});

describe('G-07 replay support: the replay catches mismatches (perturbations edit one stored file each)', () => {
  const failing = (r: Report) => steps(r).filter(s => s.status === 'failed').map(s => s.id);
  const unchanged = (r: Report, except: string[]) => { for (const s of steps(r)) if (!except.includes(s.id)) expect(s.status, s.id).not.toBe('failed'); };

  it('4a. E04 stored `added` → ["curves_1"]: E04 fails with a diff at clip-1.added', async () => {
    const f = await folder(); await edit(f.dir, 'E04', j => { j.data.items[0].added = ['curves_1']; });
    const report = await run(f); expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['E04']); expect(report.failed).toBe(1);
    expect(step(report, 'E04').diffs.map(d => d.path)).toContain('clip-1.added'); expect(step(report, 'E04').diffs.find(d => d.path === 'clip-1.added')).toMatchObject({ part: 'call', expected: ['curves_1'], actual: ['curves_2'] });
    unchanged(report, ['E04']); expect(report).toMatchObject({ passed: 14, deferred: 1, uncompared: 2 });
  });

  it('4b. E11.vid grayscale `enabled` → true: E11 fails with a vid diff at clip-1.effects[0].enabled (R01 reads E11.vid\'s blocks by @@SAME, so it fails the same way)', async () => {
    const f = await folder(); await editVid(f.dir, 'E11', i => { i.effects[0].enabled = true; });
    const report = await run(f); expect(report.status).toBe('failed');
    expect(step(report, 'E11').diffs).toEqual([expect.objectContaining({ part: 'vid', path: 'clip-1.effects[0].enabled', expected: true, actual: false })]);
    expect(failing(report)).toEqual(['E11', 'R01']); expect(step(report, 'R01').diffs.map(d => d.path)).toEqual(['clip-1.effects[0].enabled']);
    unchanged(report, ['E11', 'R01']);
  });

  it('4c. E07 stored result `success` → true: E07 fails at success', async () => {
    const f = await folder(); await edit(f.dir, 'E07', j => { j.success = true; });
    const report = await run(f); expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['E07']);
    expect(step(report, 'E07').diffs.map(d => d.path)).toContain('success'); expect(step(report, 'E07').diffs.find(d => d.path === 'success')).toMatchObject({ part: 'call', expected: true, actual: false });
    unchanged(report, ['E07']);
  });

  it('4d. E05.vid luma-key keyType value → "dark": E05 fails at clip-1.effects[3].parameters.keyType', async () => {
    const f = await folder(); await editVid(f.dir, 'E05', i => { i.effects[3].parameters.keyType.value = 'dark'; });
    const report = await run(f); expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['E05']);
    expect(step(report, 'E05').diffs).toEqual([expect.objectContaining({ part: 'vid', path: 'clip-1.effects[3].parameters.keyType', expected: { value: 'dark' }, actual: { value: 'bright' } })]);
    unchanged(report, ['E05']);
  });

  it('5. the documented rule is narrow: a changed color-wheels shadowsWheel in E06.vid is a failure in `diffs`, not a documented difference', async () => {
    const f = await folder(); await editVid(f.dir, 'E06', i => { i.effects[4].parameters.shadowsWheel.value = { angle: 200, distance: 0.5 }; });
    const report = await run(f); const e06 = step(report, 'E06');
    expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['E06']);
    expect(e06.diffs).toEqual([expect.objectContaining({ part: 'vid', path: 'clip-1.effects[4].parameters.shadowsWheel' })]); expect(e06.documentedDiffs).toBeUndefined();
  });
});

describe('G-07 replay support: stillAssets and option guards', () => {
  it('6a. S3a / S3b / S3c map to image assets of 1080×1920 whose link agent id is the Xapp id', () => {
    const { assets, links } = stillAssets({ image_1: 'S3a', image_2: 'S3b', image_3: 'S3c' });
    expect(assets).toHaveLength(3); expect(links).toHaveLength(3);
    assets.forEach((a, n) => { expect(a.type).toBe('image'); expect((a as Rec).media.image).toEqual({ width: 1080, height: 1920 }); expect(links[n]).toMatchObject({ assetId: a.id, agent_id: `image_${n + 1}`, content_type: 'image' }); });
    expect(new Set(assets.map(a => a.id)).size).toBe(3); expect(assets.map(a => a.name)).toEqual(['S3a-gradient-1080x1920.png', 'S3b-corpus-frame-tos-action-13s-1080x1920.png', 'S3c-text-on-alpha-1080x1920.png']);
  });
  it('6b. an unknown fixture name throws "--assets: unknown fixture"', () => {
    expect(() => stillAssets({ image_1: 'S9z' })).toThrow(/--assets: unknown fixture 'S9z' for image_1/);
  });
  it('7a. an output directory inside the reference directory is refused', async () => {
    const f = await folder(); await expect(run(f, { output: path.join(f.dir, 'out') })).rejects.toThrow('overlap');
  });
  it('7b. a missing --tool-field (or --input-field) throws', async () => {
    const f = await folder(); await expect(run(f, { toolField: '' })).rejects.toThrow(/--tool-field and --input-field are required/);
    await expect(run(f, { inputField: '' })).rejects.toThrow(/--tool-field and --input-field are required/);
  });
});

describe('G-07 replay support: CLI exit codes (npm run parity -- --golden G-07 …)', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [TSX, 'parity/cli.ts', ...args], { encoding: 'utf8', timeout: 180000 });
  const args = (f: Folder, extra: string[] = []) => ['--golden', 'G-07', '--xapp-ref', f.dir, '--calls', path.join(f.dir, 'calls.json'), '--assets', path.join(f.dir, 'assets.json'),
    '--tool-field', f.toolField, '--input-field', f.inputField, '--output', f.out, ...extra];

  it('8a. exit 2 (uncompared) and the JSON report is printed', async () => {
    const f = await folder(); const r = cli(args(f));
    expect(r.status).toBe(2); expect(JSON.parse(r.stdout)).toMatchObject({ golden: 'G-07', status: 'uncompared', steps: 18, passed: 15, failed: 0, deferred: 1, uncompared: 2, documented: 4 });
  });
  it('8b. --item with G-07 exits non-zero and says it is a G-02 option', async () => {
    const f = await folder(); const r = cli(args(f, ['--item', 'x']));
    expect(r.status).not.toBe(0); expect(`${r.stdout}${r.stderr}`).toContain('--item is a G-02 option');
  });
  it('8c. --frames --frame-time-unit s with G-07 exits non-zero and says they are G-02 options', async () => {
    const f = await folder(); const r = cli(args(f, ['--frames', '--frame-time-unit', 's']));
    expect(r.status).not.toBe(0); expect(`${r.stdout}${r.stderr}`).toContain('are G-02 options');
  });
});
