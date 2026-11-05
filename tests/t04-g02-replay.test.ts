// SPDX-License-Identifier: AGPL-3.0-only
// T04 batch 3: G-02 replay support (parity/g02.ts, CLI `parity --golden G-02`) against a SYNTHETIC stored reference from parity/g02-synthetic.ts.
// This is NOT Xapp parity: no real stored reference is read. Written-spec oracle: agent tool results §6 (G-02: what is compared, the keyframes object only,
// storage order), §2 setTimeRemap, error codes l.163–166, tickets T04 (G-02 boundary outcomes), results §4 rule 1 (INVALID_TOOL_INPUT is T18's).
// The expected counts below are counted by hand from the step list (33 steps in item mode: 29 compared and equal, K70 and T06 schema refusals deferred,
// C01 and E01 owned by T15 / T16), never copied from the report. Perturbations edit the stored files by hand; each must fail exactly the named step.
// Provisional (marked in the test names): the `--item` placement, the refusal text of schema refusals (only path and code are compared, and only on K72),
// the C01 / E01 owner tickets in the notes, and the "owning ticket" wording for an unknown tool.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runG02 } from '../parity/g02';
import { writeSyntheticG02 } from '../parity/g02-synthetic';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const BLOCK = '\n<<<BLOCK>>>\n';
type Rec = Record<string, any>;
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'g02-t04-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const folder = async (o: { blockBase?: 0 | 1; setup?: 'item' | 'calls' } = {}) => { const dir = path.join(root, 'ref'); const written = await writeSyntheticG02(dir, o); return { dir, ...written, out: path.join(root, 'out') }; };
type Folder = Awaited<ReturnType<typeof folder>>;
const run = (f: Folder, extra: Partial<Parameters<typeof runG02>[1]> = {}) =>
  runG02(f.dir, { calls: f.calls, assets: f.assets, toolField: f.toolField, inputField: f.inputField, item: f.item, blockBase: f.blockBase, output: f.out, ...extra });
type Report = Awaited<ReturnType<typeof runG02>>;
const steps = (r: Report) => r.parts.flatMap(p => p.steps);
const step = (r: Report, id: string) => steps(r).find(s => s.id === id)!;
const failedIds = (r: Report) => steps(r).filter(s => s.status === 'failed').map(s => s.id);

const file = (dir: string, name: string) => path.join(dir, 'results', `${name}.json`);
const readRecord = async (dir: string, name: string) => JSON.parse(await readFile(file(dir, name), 'utf8')) as Rec;
/** Edits the JSON block (block 1) of a stored record, whichever form (result_text / result_blocks) it was written in. */
async function edit(dir: string, name: string, change: (json: Rec) => void) {
  const r = await readRecord(dir, name);
  if (r.result_blocks) { const j = JSON.parse(r.result_blocks[1]); change(j); r.result_blocks[1] = JSON.stringify(j); }
  else { const b = (r.result_text as string).split(BLOCK), j = JSON.parse(b[1]); change(j); b[1] = JSON.stringify(j); r.result_text = b.join(BLOCK); }
  await writeFile(file(dir, name), JSON.stringify(r, null, 2));
}
/** The keyframes object of the stored read `<id>.vid` (the item's whole keyframes after the step). */
const editVid = (dir: string, id: string, change: (keyframes: Rec) => void) => edit(dir, `${id}.vid`, j => change(j.data.results[0].keyframes));
const editInput = async (dir: string, name: string, change: (input: Rec) => void) => { const r = await readRecord(dir, name); change(r.tool_input); await writeFile(file(dir, name), JSON.stringify(r, null, 2)); };

/** Runs the perturbed folder and expects exactly `id` to fail. */
async function expectOnlyFails(f: Folder, id: string, extra: Partial<Parameters<typeof runG02>[1]> = {}) {
  const report = await run(f, extra);
  expect(failedIds(report)).toEqual([id]); expect(report.status).toBe('failed'); expect(report.failed).toBe(1);
  return report;
}

describe('G-02 replay support: counts and report (synthetic stored reference, written-spec oracle, not Xapp parity)', () => {
  it('1. item mode: 33 steps, 29 passed, 0 failed, 2 deferred (K70, T06), 2 uncompared (C01, E01); status "uncompared"; summary carries all four counts; report.json written', async () => {
    const f = await folder(); const report = await run(f);
    expect(report).toMatchObject({ golden: 'G-02', status: 'uncompared', steps: 33, passed: 29, failed: 0, deferred: 2, uncompared: 2, blockBase: 1 });
    expect(steps(report).filter(s => s.status === 'deferred').map(s => s.id)).toEqual(['K70', 'T06']);
    expect(steps(report).filter(s => s.status === 'uncompared').map(s => s.id)).toEqual(['C01', 'E01']);
    expect(report.summary).toMatch(/29 passed, 0 failed, 2 deferred/); expect(report.summary).toMatch(/2 uncompared/);
    const written = JSON.parse(await readFile(path.join(f.out, 'report.json'), 'utf8')); expect(written).toMatchObject({ golden: 'G-02', status: 'uncompared', passed: 29, failed: 0, deferred: 2, uncompared: 2 });
  });

  it('2. setup "calls" with block base 0: 31 passed, 0 failed, 2 deferred, 2 uncompared; blockBase 0; the id map holds track_a2f3 and clip-1', async () => {
    const f = await folder({ setup: 'calls', blockBase: 0 }); expect(f.item).toBeUndefined();
    const report = await run(f);
    expect(report).toMatchObject({ status: 'uncompared', steps: 35, passed: 31, failed: 0, deferred: 2, uncompared: 2, blockBase: 0 });
    expect(Object.keys(report.parts[0].ids)).toEqual(expect.arrayContaining(['track_a2f3', 'clip-1']));
  });
});

describe('G-02 replay support: stored order (findings part 2 §41: replace stores sorted, add / update append)', () => {
  it('3a. K05 stores positionY in append order [0, 8, 1, 3, 5, 7] and passes', async () => {
    const f = await folder(); const r = await readRecord(f.dir, 'K05.vid'); const stored = JSON.parse((r.result_text as string).split(BLOCK)[1]).data.results[0].keyframes.positionY.keyframes;
    expect(stored.map((k: Rec) => k.timelineSeconds)).toEqual([0, 8, 1, 3, 5, 7]); // precondition of the oracle
    expect(step(await run(f), 'K05').status).toBe('passed');
  });
  it('3b. K05.vid rewritten sorted: K05 fails with exactly ONE diff, path clip-1.keyframes.positionY.order', async () => {
    const f = await folder(); await editVid(f.dir, 'K05', k => { k.positionY.keyframes.sort((a: Rec, b: Rec) => a.timelineSeconds - b.timelineSeconds); });
    const report = await expectOnlyFails(f, 'K05'); expect(step(report, 'K05').diffs).toHaveLength(1); expect(step(report, 'K05').diffs[0].path).toBe('clip-1.keyframes.positionY.order');
  });
});

describe('G-02 replay support: every perturbation of the stored reference fails exactly its step', () => {
  describe('keyframes object (<id>.vid)', () => {
    it('4a. a keyframe value: 1e-10 passes, 1e-6 fails K10', async () => {
      const near = await folder(); await editVid(near.dir, 'K10', k => { k.opacity.keyframes[0].value += 1e-10; });
      expect(failedIds(await run(near))).toEqual([]);
      const far = await folder(); await editVid(far.dir, 'K10', k => { k.opacity.keyframes[0].value += 1e-6; }); await expectOnlyFails(far, 'K10');
    });
    it('4b. an easing name (K10 opacity keyframe 0: linear -> easeIn)', async () => { const f = await folder(); await editVid(f.dir, 'K10', k => { k.opacity.keyframes[0].easing = 'easeIn'; }); await expectOnlyFails(f, 'K10'); });
    it('4c. an outHandle (K60 blur keyframe 0)', async () => { const f = await folder(); await editVid(f.dir, 'K60', k => { k.blur.keyframes[0].outHandle = [0.25, 0.2]; }); await expectOnlyFails(f, 'K60'); });
    it('4d. an inHandle (K60 blur keyframe 1)', async () => { const f = await folder(); await editVid(f.dir, 'K60', k => { k.blur.keyframes[1].inHandle = [0.3, 1]; }); await expectOnlyFails(f, 'K60'); });
    it('4e. the timeRemap curve (T03 keyframe 1: 8500 -> 8600)', async () => { const f = await folder(); await editVid(f.dir, 'T03', k => { k.timeRemap.keyframes[1].value = 8600; }); await expectOnlyFails(f, 'T03'); });
    it('4f. an extra property key in the stored object', async () => {
      const f = await folder(); await editVid(f.dir, 'K10', k => { k.zIndexExtra = { defaultValue: 0, keyframeCount: 1, keyframes: [{ timelineSeconds: 1, value: 1, easing: 'linear' }] }; }); await expectOnlyFails(f, 'K10');
    });
    it('4g. a defaultValue (K10 opacity 1 -> 0.5)', async () => { const f = await folder(); await editVid(f.dir, 'K10', k => { k.opacity.defaultValue = 0.5; }); await expectOnlyFails(f, 'K10'); });
    it('4h. a keyframeCount (K10 opacity 3 -> 4)', async () => { const f = await folder(); await editVid(f.dir, 'K10', k => { k.opacity.keyframeCount = 4; }); await expectOnlyFails(f, 'K10'); });
  });

  describe('call result (<id>.json)', () => {
    it('4i. success (K01 true -> false)', async () => { const f = await folder(); await edit(f.dir, 'K01', j => { j.success = false; }); await expectOnlyFails(f, 'K01'); });
    it('4j. code (K51 REMOVE_TIME_NOT_FOUND -> TIME_OUT_OF_BOUNDS)', async () => { const f = await folder(); await edit(f.dir, 'K51', j => { j.code = 'TIME_OUT_OF_BOUNDS'; }); await expectOnlyFails(f, 'K51'); });
    it('4k. error (K51)', async () => { const f = await folder(); await edit(f.dir, 'K51', j => { j.error = 'Something else'; }); await expectOnlyFails(f, 'K51'); });
    it('4l. message (K51)', async () => { const f = await folder(); await edit(f.dir, 'K51', j => { j.message += ' (changed)'; }); await expectOnlyFails(f, 'K51'); });
    it('4m. resolvedKeyframes (K11 first time 1.003999 -> 1.0041)', async () => { const f = await folder(); await edit(f.dir, 'K11', j => { j.data.resolvedKeyframes.opacity[0].time = 1.0041; }); await expectOnlyFails(f, 'K11'); });
    it('4n. speedRange (T03 max 2.931 -> 3)', async () => { const f = await folder(); await edit(f.dir, 'T03', j => { j.data.speedRange.max = 3; }); await expectOnlyFails(f, 'T03'); });
    it('4o. warnings dropped from a stored result that has them (T01)', async () => { const f = await folder(); await edit(f.dir, 'T01', j => { delete j.data.warnings; }); await expectOnlyFails(f, 'T01'); });
    it('4p. a warning added to a stored result that has none (T04): a warning Cutframe lacks is a difference', async () => {
      const f = await folder(); await edit(f.dir, 'T04', j => { j.data.warnings = ['A warning Xapp gave']; }); await expectOnlyFails(f, 'T04');
    });
    it('4q. K72 emulated TYPE refusal: details.errors[0].code and .path are compared in full', async () => {
      const code = await folder(); await edit(code.dir, 'K72', j => { j.details.errors[0].code = 'ENUM'; }); await expectOnlyFails(code, 'K72');
      const at = await folder(); await edit(at.dir, 'K72', j => { j.details.errors[0].path = '$.payload.positionY.remove'; }); await expectOnlyFails(at, 'K72');
    });
  });
});

describe('G-02 replay support: schema refusals are deferred to T18 (results §4 rule 1)', () => {
  it('5a. K70 and T06 are deferred: deferredDiffs non-empty, diffs empty', async () => {
    const report = await run(await folder());
    for (const id of ['K70', 'T06']) { const s = step(report, id); expect(s.status).toBe('deferred'); expect(s.diffs).toEqual([]); expect(s.deferredDiffs?.length).toBeGreaterThan(0); }
  });
  it('5b. perturbing R01 (the read right after K70) fails R01: the refusal must have changed nothing', async () => {
    const f = await folder(); await edit(f.dir, 'R01', j => { j.data.results[0].keyframes.positionY.keyframes[0].value = 1; });
    const report = await run(f); expect(failedIds(report)).toEqual(['R01']); expect(step(report, 'K70').status).toBe('deferred');
  });
  it('5c. K70 stored with the handler\'s own code (EMPTY_OPS, "No ops provided", "No ops provided for \'positionY\'.") gets a full compare and passes', async () => {
    const f = await folder();
    await edit(f.dir, 'K70', j => { for (const k of Object.keys(j)) delete j[k]; Object.assign(j, { success: false, code: 'EMPTY_OPS', error: 'No ops provided', message: "No ops provided for 'positionY'." }); });
    const report = await run(f); expect(step(report, 'K70').status).toBe('passed'); expect(failedIds(report)).toEqual([]); expect(report).toMatchObject({ passed: 30, deferred: 1 });
  });
  it('5d. K70 with a valid tool_input: Cutframe succeeds against a stored INVALID_TOOL_INPUT, so K70 fails', async () => {
    const f = await folder(); await editInput(f.dir, 'K70', input => { input.payload = { positionY: { add: [{ time: 2, value: 5 }] } }; });
    const report = await run(f); expect(step(report, 'K70').status).toBe('failed'); expect(report.status).toBe('failed');
  });
});

describe('G-02 replay support: uncompared steps', () => {
  it('6a. C01 names T15 and E01 names T16 (provisional: the owner wording)', async () => {
    const report = await run(await folder());
    expect(step(report, 'C01').note).toContain('T15'); expect(step(report, 'E01').note).toContain('T16');
  });
  it('6b. a stored tool unknown to the tool table (generateCaptions) is uncompared and names "its owning ticket" (provisional wording)', async () => {
    const f = await folder(); const first = [...f.calls[0]]; first.splice(first.indexOf('K01'), 0, { id: 'U1', tool: 'generateCaptions', input: {} } as never);
    const report = await run(f, { calls: [first] });
    expect(step(report, 'U1').status).toBe('uncompared'); expect(step(report, 'U1').note).toContain('its owning ticket'); expect(report).toMatchObject({ passed: 29, uncompared: 3, failed: 0 });
  });
});

describe('G-02 replay support: option errors', () => {
  it('7. --item with an assets map that lacks S1 throws "--item places S1"', async () => {
    const f = await folder(); await expect(run(f, { assets: { video_1: 'tos-action-30s' } })).rejects.toThrow(/--item places S1/);
  });
  it('9. an output directory inside the reference directory is refused', async () => {
    const f = await folder(); await expect(run(f, { output: path.join(f.dir, 'out') })).rejects.toThrow('Output/reference directories overlap or alias');
  });
});

describe('G-02 replay support: CLI exit codes (npm run parity -- --golden G-02 …)', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [TSX, 'parity/cli.ts', ...args], { encoding: 'utf8', timeout: 180000 });
  const args = (f: Folder, extra: string[] = []) => ['--golden', 'G-02', '--xapp-ref', f.dir, '--calls', path.join(f.dir, 'calls.json'), '--assets', path.join(f.dir, 'assets.json'),
    '--tool-field', f.toolField, '--input-field', f.inputField, '--item', 'clip-1', '--block-base', String(f.blockBase), '--output', f.out, ...extra];

  it('8a. exit 2 by default (uncompared), and the JSON report is printed', () => {
    return folder().then(f => { const r = cli(args(f)); expect(r.status).toBe(2); expect(JSON.parse(r.stdout)).toMatchObject({ golden: 'G-02', status: 'uncompared', passed: 29 }); });
  });
  it('8b. exit 1 on any perturbation', async () => {
    const f = await folder(); await editVid(f.dir, 'K10', k => { k.opacity.keyframes[0].value += 1e-6; });
    const r = cli(args(f)); expect(r.status).toBe(1); expect(JSON.parse(r.stdout)).toMatchObject({ status: 'failed', failed: 1 });
  });
  it('8c. exit 0 when calls.json drops K70, T06, C01 and E01 (status "passed")', async () => {
    const f = await folder(); const drop = new Set(['K70', 'T06', 'C01', 'E01']); const calls = path.join(root, 'calls-trimmed.json');
    await writeFile(calls, JSON.stringify([f.calls[0].filter(id => !drop.has(id as string))]));
    const a = args(f); a[a.indexOf('--calls') + 1] = calls; const r = cli(a);
    expect(r.status).toBe(0); expect(JSON.parse(r.stdout)).toMatchObject({ status: 'passed', steps: 29, passed: 29, failed: 0, deferred: 0, uncompared: 0 });
  });
  it('8d. --golden G-99 prints the usage text containing "--golden G-02" and exits non-zero', async () => {
    const f = await folder(); const r = cli(args(f).map(a => a === 'G-02' ? 'G-99' : a));
    expect(r.status).not.toBe(0); expect(`${r.stdout}${r.stderr}`).toContain('--golden G-02');
  });
  it('8e. --item with G-01 exits non-zero and says it is a G-02 option', async () => {
    const f = await folder(); const r = cli(args(f).map(a => a === 'G-02' ? 'G-01' : a));
    expect(r.status).not.toBe(0); expect(`${r.stdout}${r.stderr}`).toContain('--item is a G-02 option');
  });
});
