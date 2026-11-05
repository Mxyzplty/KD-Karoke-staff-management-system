// SPDX-License-Identifier: AGPL-3.0-only
// T06: G-04 replay support (parity/g04.ts, CLI `parity --golden G-04`) against a SYNTHETIC stored reference from parity/g04-synthetic.ts.
// This is NOT Xapp parity: no real stored reference is read. The folder is written from findings part 5 §54.2 1.5 (the preset formulas)
// and agent tool results l.1325–l.1327 (metadata.shapeType, fullDetails {points, closed} in canvas px), not from the Cutframe code.
// Expected counts are counted by hand from the step list: 11 steps = S00 A01–A06 W01 M01 R00 C00; 8 passed (S00, A01–A05, W01, R00),
// A06 deferred (Xapp INVALID_TOOL_INPUT, ours INVALID_SHAPE_TYPE), M01 (mask, T12) and C00 (captureFrame) uncompared. The star A04 is stored
// at 0.1 px, so its IoU is below 1 and at least 0.99; every other IoU is 1. Perturbations edit the stored JSON block of the named record;
// each must fail the named step with the named diff path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MIN_IOU, pathIoU, runG04 } from '../parity/g04';
import { writeSyntheticG04 } from '../parity/g04-synthetic';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const BLOCK = '\n<<<BLOCK>>>\n';
type Rec = Record<string, any>;
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'g04-t06-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const folder = async (o: { blockBase?: 0 | 1 } = {}) => { const dir = path.join(root, 'ref'); const written = await writeSyntheticG04(dir, o); return { dir, ...written, out: path.join(root, 'out') }; };
type Folder = Awaited<ReturnType<typeof folder>>;
const run = (f: Folder, extra: Partial<Parameters<typeof runG04>[1]> = {}) =>
  runG04(f.dir, { calls: f.calls, toolField: f.toolField, inputField: f.inputField, blockBase: f.blockBase, output: f.out, ...extra });
type Report = Awaited<ReturnType<typeof runG04>>;
const steps = (r: Report) => r.parts.flatMap(p => p.steps);
const step = (r: Report, id: string) => steps(r).find(s => s.id === id)!;
const idsWith = (r: Report, status: string) => steps(r).filter(s => s.status === status).map(s => s.id);
const failing = (r: Report) => idsWith(r, 'failed');

const file = (dir: string, name: string) => path.join(dir, 'results', `${name}.json`);
/** Edits the JSON block (block 1) of a stored record, whichever form (result_text / result_blocks) it was written in. */
async function edit(dir: string, name: string, change: (json: Rec) => void) {
  const r = JSON.parse(await readFile(file(dir, name), 'utf8')) as Rec;
  if (r.result_blocks) { const j = JSON.parse(r.result_blocks[1]); change(j); r.result_blocks[1] = JSON.stringify(j); }
  else { const b = (r.result_text as string).split(BLOCK), j = JSON.parse(b[1]); change(j); b[1] = JSON.stringify(j); r.result_text = b.join(BLOCK); }
  await writeFile(file(dir, name), JSON.stringify(r, null, 2));
}
/** The shape block (`data.results[0]`) of the stored read `<id>.vid`. */
const editVid = (dir: string, id: string, change: (block: Rec) => void) => edit(dir, `${id}.vid`, j => change(j.data.results[0]));

describe('G-04 replay support: counts and report (synthetic stored reference, written-spec oracle, not Xapp parity)', () => {
  for (const blockBase of [1, 0] as const) {
    it(`1.${blockBase ? 'a' : 'b'} block base ${blockBase}: 11 steps, 8 passed, 0 failed, 1 deferred (A06), 2 uncompared (M01, C00); status "uncompared"; minIou < 1 and >= 0.99, every other IoU 1; report.json written`, async () => {
      const f = await folder({ blockBase }); const report = await run(f);
      expect(report).toMatchObject({ golden: 'G-04', status: 'uncompared', blockBase, steps: 11, passed: 8, failed: 0, deferred: 1, uncompared: 2, threshold: MIN_IOU });
      expect(steps(report).map(s => s.id)).toEqual(['S00', 'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'W01', 'M01', 'R00', 'C00']);
      expect(idsWith(report, 'passed')).toEqual(['S00', 'A01', 'A02', 'A03', 'A04', 'A05', 'W01', 'R00']);
      expect(idsWith(report, 'deferred')).toEqual(['A06']); expect(idsWith(report, 'uncompared')).toEqual(['M01', 'C00']);
      for (const s of steps(report).filter(s => s.status === 'passed')) { expect(s.diffs, s.id).toEqual([]); expect(s.compared.length, s.id).toBeGreaterThan(0); }
      const ious = steps(report).flatMap(s => Object.entries(s.iou ?? {}));
      expect(ious.length).toBeGreaterThan(0);
      for (const [id, v] of ious) {
        if (id === 'shape_star') { expect(v, id).toBeLessThan(1); expect(v, id).toBeGreaterThanOrEqual(MIN_IOU); } else expect(v, id).toBeCloseTo(1, 9);
      }
      expect(report.minIou).toBeLessThan(1); expect(report.minIou!).toBeGreaterThanOrEqual(MIN_IOU);
      expect(report.minIou).toBe(Math.min(...ious.map(([, v]) => v)));
      expect(JSON.parse(await readFile(path.join(f.out, 'report.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(report)));
    });
  }

  it('2. A06 is a deferred schema refusal (Xapp INVALID_TOOL_INPUT, ours INVALID_SHAPE_TYPE) with its deferred diffs; M01 and C00 carry notes; A01–A05 and W01 compare the call and the read-back', async () => {
    const report = await run(await folder());
    const a06 = step(report, 'A06'); expect(a06.status).toBe('deferred'); expect(a06.diffs).toEqual([]);
    expect(a06.note).toContain('INVALID_TOOL_INPUT'); expect(a06.note).toContain('INVALID_SHAPE_TYPE'); expect(a06.deferredDiffs!.length).toBeGreaterThan(0);
    expect(step(report, 'M01').note).toContain('T12'); expect(step(report, 'C00').note).toContain('captureFrame');
    for (const id of ['A01', 'A02', 'A03', 'A04', 'A05', 'W01']) expect(step(report, id).compared, id).toEqual(expect.arrayContaining(['call', 'vid']));
    expect(step(report, 'R00').compared).toEqual(['call(viewItemDetails)']);
    expect(Object.keys(report.parts[0].ids)).toEqual(expect.arrayContaining(['track_ov1', 'shape_rect', 'shape_tri', 'shape_ell', 'shape_star', 'shape_custom']));
  });
});

describe('G-04 replay support: the replay catches mismatches (perturbations edit one stored block each)', () => {
  const unchanged = (r: Report, except: string[]) => { for (const s of steps(r)) if (!except.includes(s.id)) expect(s.status, s.id).not.toBe('failed'); };

  it('3a. A01.vid: one rectangle anchor moved by 40 px: A01 fails with shape_rect.area (IoU below 0.99)', async () => {
    const f = await folder(); await editVid(f.dir, 'A01', b => { b.fullDetails.points[1].anchor.x += 40; });
    const report = await run(f); expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['A01']);
    const d = step(report, 'A01').diffs.find(x => x.path === 'shape_rect.area')!;
    expect(d).toMatchObject({ part: 'vid', expected: `IoU >= ${MIN_IOU}` }); expect(d.actual as number).toBeLessThan(MIN_IOU);
    unchanged(report, ['A01']); expect(report).toMatchObject({ passed: 7, deferred: 1, uncompared: 2 });
  });

  it('3b. A03.vid: the handles of one ellipse anchor dropped: A03 fails with shape_ell.fullDetails.points[].handles', async () => {
    const f = await folder(); await editVid(f.dir, 'A03', b => { delete b.fullDetails.points[0].handleIn; delete b.fullDetails.points[0].handleOut; });
    const report = await run(f); expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['A03']);
    const d = step(report, 'A03').diffs.find(x => x.path === 'shape_ell.fullDetails.points[].handles')!;
    expect(d).toMatchObject({ part: 'vid', expected: [[false, false], [true, true], [true, true], [true, true]], actual: [[true, true], [true, true], [true, true], [true, true]] });
    unchanged(report, ['A03']);
  });

  it('3c. A02.vid: shapeType changed: A02 fails with shape_tri.shapeType', async () => {
    const f = await folder(); await editVid(f.dir, 'A02', b => { b.timelineMetadata.metadata.shapeType = 'pentagon'; });
    const report = await run(f); expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['A02']);
    expect(step(report, 'A02').diffs).toEqual([expect.objectContaining({ part: 'vid', path: 'shape_tri.shapeType', expected: 'pentagon', actual: 'triangle' })]);
    unchanged(report, ['A02']);
  });

  it('3d. R00: closed false for shape_custom: R00 fails with shape_custom.fullDetails.closed', async () => {
    const f = await folder(); await edit(f.dir, 'R00', j => { j.data.results.find((b: Rec) => b.id === 'shape_custom').fullDetails.closed = false; });
    const report = await run(f); expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['R00']);
    expect(step(report, 'R00').diffs.find(x => x.path === 'shape_custom.fullDetails.closed')).toMatchObject({ part: 'vid', expected: false, actual: true });
    unchanged(report, ['R00']);
  });

  it('3e. W01.vid: one point deleted: W01 fails with shape_custom.fullDetails.points.length', async () => {
    const f = await folder(); await editVid(f.dir, 'W01', b => { b.fullDetails.points.pop(); });
    const report = await run(f); expect(report.status).toBe('failed'); expect(failing(report)).toEqual(['W01']);
    expect(step(report, 'W01').diffs.find(x => x.path === 'shape_custom.fullDetails.points.length')).toMatchObject({ part: 'vid', expected: 4, actual: 5 });
    unchanged(report, ['W01']);
  });
});

describe('G-04 replay support: pathIoU (exact-area anti-aliased soft IoU)', () => {
  const square = (x: number, y: number, s = 100) => ({ closed: true, points: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([px, py]) => ({ anchor: { x: px, y: py } })) });
  it('4a. identical paths give 1', () => { expect(pathIoU(square(10, 10), square(10, 10))).toBeCloseTo(1, 12); });
  it('4b. a 100×100 square against the same square shifted 1 px: intersection 99·100 = 9900, union 100·100 + 100·100 − 9900 = 10100, IoU 9900/10100 ≈ 0.980198', () => {
    expect(pathIoU(square(0, 0), square(1, 0))).toBeCloseTo(9900 / 10100, 9);
    expect(pathIoU(square(0, 0), square(0, 1))).toBeCloseTo(9900 / 10100, 9);
  });
  it('4c. disjoint squares give 0', () => { expect(pathIoU(square(0, 0), square(300, 300))).toBe(0); });
});

describe('G-04 replay support: option guards and CLI exit codes (npm run parity -- --golden G-04 …)', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [TSX, 'parity/cli.ts', ...args], { encoding: 'utf8', timeout: 180000 });
  const args = (f: Folder, extra: string[] = []) => ['--golden', 'G-04', '--xapp-ref', f.dir, '--calls', path.join(f.dir, 'calls.json'),
    '--tool-field', f.toolField, '--input-field', f.inputField, '--output', f.out, ...extra];

  it('5a. an output directory inside the reference directory is refused; a missing --tool-field throws', async () => {
    const f = await folder(); await expect(run(f, { output: path.join(f.dir, 'out') })).rejects.toThrow('overlap');
    await expect(run(f, { toolField: '' })).rejects.toThrow(/--tool-field and --input-field are required/);
  });
  it('5b. exit 2 (uncompared), the JSON report is printed and report.json is written to --output', async () => {
    const f = await folder(); const r = cli(args(f));
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ golden: 'G-04', status: 'uncompared', steps: 11, passed: 8, failed: 0, deferred: 1, uncompared: 2 });
    expect(JSON.parse(await readFile(path.join(f.out, 'report.json'), 'utf8'))).toMatchObject({ golden: 'G-04', status: 'uncompared', steps: 11 });
  });
  it('5c. --assets with G-04 exits non-zero and says "--assets is not a G-04 option (shapes only)"', async () => {
    const f = await folder(); const r = cli(args(f, ['--assets', path.join(f.dir, 'assets.json')]));
    expect(r.status).not.toBe(0); expect(`${r.stdout}${r.stderr}`).toContain('--assets is not a G-04 option (shapes only)');
  });
});
