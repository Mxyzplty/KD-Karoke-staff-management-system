// SPDX-License-Identifier: AGPL-3.0-only
// T11: G-08 replay support (parity/g08.ts, CLI `parity --golden G-08`) against a SYNTHETIC stored reference from parity/g08-synthetic.ts.
// This is NOT Xapp parity: no real stored reference is read. Written-spec oracle: agent tool results §2 (applyTransition) and §11 (G-08).
// Expected counts are counted by hand from the step list: 22 steps = S00 S01 t01 t02 R00 t03 t04 t05 p01 t06 t07 R01 e01–e08 C00 X00; 20 compared
// and equal, C00 (captureFrame) and X00 (exportProject) uncompared (T11 notes / --export). The six documented steps are those whose stored
// data.transition has no id while Cutframe returns one (results §2 Cutframe note): t01 t02 t03 t04 t05 p01. Perturbations edit the stored
// files by hand; each must fail the named step with the named diff and leave the other steps as they were.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runG08 } from '../parity/g08';
import { writeSyntheticG08 } from '../parity/g08-synthetic';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const BLOCK = '\n<<<BLOCK>>>\n';
type Rec = Record<string, any>;
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'g08-t11-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const folder = async (o: { blockBase?: 0 | 1 } = {}) => { const dir = path.join(root, 'ref'); const written = await writeSyntheticG08(dir, o); return { dir, ...written, out: path.join(root, 'out') }; };
type Folder = Awaited<ReturnType<typeof folder>>;
const run = (f: Folder, extra: Partial<Parameters<typeof runG08>[1]> = {}) =>
  runG08(f.dir, { calls: f.calls, assets: f.assets, toolField: f.toolField, inputField: f.inputField, blockBase: f.blockBase, output: f.out, ...extra });
type Report = Awaited<ReturnType<typeof runG08>>;
const steps = (r: Report) => r.parts.flatMap(p => p.steps);
const step = (r: Report, id: string) => steps(r).find(s => s.id === id)!;
const idsWith = (r: Report, status: string) => steps(r).filter(s => s.status === status).map(s => s.id);
const failing = (r: Report) => idsWith(r, 'failed');

const file = (dir: string, name: string) => path.join(dir, 'results', `${name}.json`);
const readRecord = async (dir: string, name: string) => JSON.parse(await readFile(file(dir, name), 'utf8')) as Rec;
/** Edits the JSON block (block 1) of a stored record, whichever form (result_text / result_blocks) it was written in. */
async function edit(dir: string, name: string, change: (json: Rec) => void) {
  const r = await readRecord(dir, name);
  if (r.result_blocks) { const j = JSON.parse(r.result_blocks[1]); change(j); r.result_blocks[1] = JSON.stringify(j); }
  else { const b = (r.result_text as string).split(BLOCK), j = JSON.parse(b[1]); change(j); b[1] = JSON.stringify(j); r.result_text = b.join(BLOCK); }
  await writeFile(file(dir, name), JSON.stringify(r, null, 2));
}
const ALL = ['S00', 'S01', 't01', 't02', 'R00', 't03', 't04', 't05', 'p01', 't06', 't07', 'R01', 'e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08', 'C00', 'X00'];

describe('G-08 replay support: counts and report (synthetic stored reference, written-spec oracle, not Xapp parity)', () => {
  for (const blockBase of [1, 0] as const) {
    it(`1.${blockBase ? 'a' : 'b'} block base ${blockBase}: 22 steps, 20 passed, 0 failed, 2 uncompared (C00, X00); status "uncompared"; report.json written`, async () => {
      const f = await folder({ blockBase }); const report = await run(f);
      expect(report).toMatchObject({ version: 1, golden: 'G-08', status: 'uncompared', blockBase, steps: 22, passed: 20, failed: 0, uncompared: 2 });
      expect(steps(report).map(s => s.id)).toEqual(ALL);
      expect(idsWith(report, 'uncompared')).toEqual(['C00', 'X00']);
      for (const s of steps(report).filter(s => s.status === 'passed')) { expect(s.diffs, s.id).toEqual([]); expect(s.compared.length, s.id).toBeGreaterThan(0); }
      expect(report.summary).toMatch(/^20 passed, 0 failed, 2 uncompared/);
      expect(JSON.parse(await readFile(path.join(f.out, 'report.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(report)));
    });
  }

  it('2. C00 and X00 carry a note naming the preview / export owner; the add steps compare the call; the reads compare "no transition"', async () => {
    const report = await run(await folder());
    expect(step(report, 'C00').note).toContain('preview'); expect(step(report, 'X00').note).toContain('--export');
    for (const id of ['t01', 't02', 't03', 't04', 't05', 'p01', 't06', 't07', 'e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08']) expect(step(report, id).compared, id).toContain('call');
    for (const id of ['R00', 'R01']) expect(step(report, id).compared, id).toEqual(['call(context: no transition)']);
    expect(Object.keys(report.parts[0].ids)).toEqual(expect.arrayContaining(['track_v1', 'clip-a', 'clip-b', 'clip-c', 'transition-1', 'transition-2']));
  });

  it('3. documented differences: exactly the six steps whose stored data.transition lacks the id Cutframe returns, each with the data.transition.id note only', async () => {
    const report = await run(await folder());
    const doc = steps(report).filter(s => s.documentedDiffs);
    expect(doc.map(s => s.id)).toEqual(['t01', 't02', 't03', 't04', 't05', 'p01']); expect(report.documented).toBe(6);
    for (const s of doc) { expect(s.status, s.id).toBe('passed'); expect(s.documentedDiffs, s.id).toHaveLength(1); expect(s.documentedDiffs![0]).toMatchObject({ part: 'call', path: 'data.transition.id', expected: null }); }
  });
});

describe('G-08 replay support: the replay catches mismatches (perturbations edit one stored file each)', () => {
  const only = (r: Report, ids: string[]) => { expect(r.status).toBe('failed'); expect(failing(r)).toEqual(ids); expect(r.failed).toBe(ids.length); for (const s of steps(r)) if (!ids.includes(s.id)) expect(s.status, s.id).not.toBe('failed'); };

  it('4a. t01 stored message → another sentence: t01 fails with a diff at `message` (expected the stored text, actual Cutframe\'s)', async () => {
    const f = await folder(); await edit(f.dir, 't01', j => { j.message = 'Added fade transition (2.00s, center on the cut) on clip-a → clip-b at 10.00s.'; });
    const report = await run(f); only(report, ['t01']);
    // The replay translates the stored ids to the ids Cutframe made (report.parts[0].ids), in both texts.
    const { ids } = report.parts[0], on = (d: string) => `Added fade transition (${d}.00s, center on the cut) on ${ids['clip-a']} → ${ids['clip-b']} at 10.00s.`;
    expect(step(report, 't01').diffs).toEqual([{ part: 'call', path: 'message', expected: on('2'), actual: on('1') }]);
  });
  it('4b. t02 stored timelineChanges duration 0.6 → 0.7: t02 fails at timelineChanges.transitions.created[0].duration (expected 0.7, actual 0.6)', async () => {
    const f = await folder({ blockBase: 0 }); await edit(f.dir, 't02', j => { j.timelineChanges.transitions.created[0].duration = 0.7; });
    const report = await run(f); only(report, ['t02']);
    expect(step(report, 't02').diffs).toEqual([expect.objectContaining({ part: 'call', path: 'timelineChanges.transitions.created[0].duration', expected: 0.7, actual: 0.6 })]);
  });
  it('4c. t05 stored direction from-left → from-top: t05 fails at data.transition.direction', async () => {
    const f = await folder(); await edit(f.dir, 't05', j => { j.data.transition.direction = 'from-top'; });
    const report = await run(f); only(report, ['t05']);
    expect(step(report, 't05').diffs).toEqual([expect.objectContaining({ part: 'call', path: 'data.transition.direction', expected: 'from-top', actual: 'from-left' })]);
  });
  it('4d. e02 stored code INVALID_PAIR → CUT_NOT_FOUND: e02 fails at `code`', async () => {
    const f = await folder(); await edit(f.dir, 'e02', j => { j.code = 'CUT_NOT_FOUND'; });
    const report = await run(f); only(report, ['e02']);
    expect(step(report, 'e02').diffs).toEqual([expect.objectContaining({ part: 'call', path: 'code', expected: 'CUT_NOT_FOUND', actual: 'INVALID_PAIR' })]);
  });
  it('4e. a stored read that shows `transitions`: R00 fails with the §11 "no transition in the read" diff; the other steps are unchanged', async () => {
    const f = await folder(); await edit(f.dir, 'R00', j => { j.data.tracks.track_v1.transitions = [{ fromId: 'clip-a', toId: 'clip-b' }]; });
    const report = await run(f); only(report, ['R00']);
    expect(step(report, 'R00').diffs).toEqual([expect.objectContaining({ part: 'vid', path: 'context', expected: 'no transition in the read (results §11)', actual: 'the stored read shows a transition' })]);
  });
  it('4f. a stored schema refusal with another code: e04 fails at details.errors', async () => {
    const f = await folder(); await edit(f.dir, 'e04', j => { j.details = { errors: [{ path: '$', code: 'SOMETHING_ELSE' }] }; });
    const report = await run(f); only(report, ['e04']);
    expect(step(report, 'e04').diffs.map(d => d.path)).toEqual(['details.errors']);
  });
  it('4g. e01 stored success true (a refusal that should have succeeded): e01 fails at `success`', async () => {
    const f = await folder(); await edit(f.dir, 'e01', j => { j.success = true; delete j.error; delete j.code; });
    const report = await run(f); only(report, ['e01']);
    expect(step(report, 'e01').diffs.map(d => d.path)).toContain('success');
  });
  it('4h. a perturbation does not change the counts of the other steps (20 − 1 passed, 1 failed, 2 uncompared)', async () => {
    const f = await folder(); await edit(f.dir, 't05', j => { j.data.transition.direction = 'from-top'; });
    expect(await run(f)).toMatchObject({ steps: 22, passed: 19, failed: 1, uncompared: 2, status: 'failed' });
  });
});

describe('G-08 replay support: argument checks and the CLI (npm run parity -- --golden G-08 …)', () => {
  it('5a. runG08 without --tool-field / --input-field throws, naming both', async () => {
    const f = await folder();
    await expect(runG08(f.dir, { calls: f.calls, assets: f.assets, output: f.out } as any)).rejects.toThrow(/--tool-field and --input-field are required/);
  });
  it('5b. a --calls step with no results file throws, naming the step', async () => {
    const f = await folder();
    await expect(runG08(f.dir, { calls: [['nope']], assets: f.assets, toolField: f.toolField, inputField: f.inputField, blockBase: f.blockBase, output: f.out })).rejects.toThrow(/nope, which has no results\/nope\.json/);
  });
  it('5c. the output directory may not overlap the reference directory', async () => {
    const f = await folder();
    await expect(run(f, { output: path.join(f.dir, 'inside') })).rejects.toThrow(/overlap/);
  });

  const cli = (args: string[]) => spawnSync(process.execPath, [TSX, 'parity/cli.ts', ...args], { encoding: 'utf8', timeout: 180000 });
  const args = (f: Folder, extra: string[] = []) => ['--golden', 'G-08', '--xapp-ref', f.dir, '--calls', path.join(f.dir, 'calls.json'), '--assets', path.join(f.dir, 'assets.json'),
    '--tool-field', f.toolField, '--input-field', f.inputField, '--output', f.out, ...extra];

  it('6a. exit 2 (uncompared) and the JSON report is printed', async () => {
    const f = await folder(); const r = cli(args(f));
    expect(r.status).toBe(2); expect(JSON.parse(r.stdout)).toMatchObject({ golden: 'G-08', status: 'uncompared', steps: 22, passed: 20, failed: 0, uncompared: 2 });
  });
  it('6b. exit 1 when a step fails', async () => {
    const f = await folder(); await edit(f.dir, 't05', j => { j.data.transition.direction = 'from-top'; });
    const r = cli(args(f));
    expect(r.status).toBe(1); expect(JSON.parse(r.stdout)).toMatchObject({ golden: 'G-08', status: 'failed', failed: 1 });
  });
  it('6c. --item with G-08 exits non-zero and says it is a G-02 option', async () => {
    const f = await folder(); const r = cli(args(f, ['--item', 'x']));
    expect(r.status).not.toBe(0); expect(`${r.stdout}${r.stderr}`).toContain('--item is a G-02 option');
  });
});
