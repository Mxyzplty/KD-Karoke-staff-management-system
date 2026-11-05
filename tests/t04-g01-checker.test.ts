// SPDX-License-Identifier: AGPL-3.0-only
// T04 batch 1b: G-01 checker regression cases for parity/g01.ts compareDetails (rotation, volume). SYNTHETIC stored reference, written-spec
// oracle, not Xapp parity. Oracle: agent tool results §2 l.1326 (viewItemDetails key `rotate`); contracts l.418 / l.939 (stored key `rotation`,
// `volume` is an item property); findings part 2 §40 (volume 0–3, default 1). Helpers are copied from t03-g01-replay.test.ts (not imported).
// Provisional: cases 2 and 4 rely on the synthetic folder's item names (clip-1 = the S1 item, 0–4 s after S12); case 4 needs the P2 handler
// `editProperties` and is red until it lands (blocked-on-P2), not skipped.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runG01 } from '../parity/g01';
import { writeSyntheticG01 } from '../parity/g01-synthetic';

const BLOCK = '\n<<<BLOCK>>>\n';
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'g01-t04-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const folder = async () => { const dir = path.join(root, 'ref'); const written = await writeSyntheticG01(dir, {}); return { dir, ...written, out: path.join(root, 'out') }; };
const readRecord = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, 'results', `${name}.json`), 'utf8')) as Record<string, any>;
const writeRecord = (dir: string, name: string, record: unknown) => writeFile(path.join(dir, 'results', `${name}.json`), JSON.stringify(record, null, 2));
const run = (f: Awaited<ReturnType<typeof folder>>, extra: Partial<Parameters<typeof runG01>[1]> = {}) =>
  runG01(f.dir, { calls: f.calls, assets: f.assets, toolField: f.toolField, inputField: f.inputField, output: f.out, ...extra });
const failing = (report: Awaited<ReturnType<typeof runG01>>) => report.parts.flatMap(p => p.steps).filter(s => s.status === 'failed');

/** S12.vid results[0] (clip-1) gets `properties.<key> = value` in the stored reference. */
const perturbS12 = async (dir: string, key: string, value: number) => {
  const r = await readRecord(dir, 'S12.vid'); const blocks = (r.result_text as string).split(BLOCK); const data = JSON.parse(blocks[1]);
  data.data.results[0].properties[key] = value; blocks[1] = JSON.stringify(data);
  await writeRecord(dir, 'S12.vid', { ...r, result_text: blocks.join(BLOCK) });
};
/** Inserts an inline step into calls[0] immediately before 'S12'. */
const withStep = (f: Awaited<ReturnType<typeof folder>>, step: { id: string; tool: string; input: Record<string, unknown> }) => {
  const first = [...f.calls[0]]; first.splice(first.indexOf('S12'), 0, step as never);
  return [first, f.calls[1]];
};
/** One failing step S12 with exactly one vid diff whose path ends `.properties.<key>` and names our replayed id (not 'clip-1'). */
const expectOneDiff = (report: Awaited<ReturnType<typeof runG01>>, key: string, expected: number, actual: number) => {
  const bad = failing(report);
  expect(report.status).toBe('failed'); expect(report.failed).toBe(1); expect(bad.map(s => s.id)).toEqual(['S12']);
  expect(bad[0].diffs).toHaveLength(1);
  const d = bad[0].diffs[0];
  expect(d).toMatchObject({ part: 'vid', expected, actual }); expect(d.path).toMatch(new RegExp(`\\.properties\\.${key}$`));
  const id = d.path.replace(new RegExp(`\\.properties\\.${key}$`), '');
  expect(id).not.toBe('clip-1'); expect(Object.values(report.parts[0].ids)).toContain(id);
};

describe('G-01 checker: rotation and volume in compareDetails (synthetic stored reference, written-spec oracle, not Xapp parity)', () => {
  it('baseline: the unperturbed folder passes 21/21', async () => {
    const f = await folder(); const report = await run(f);
    expect(report).toMatchObject({ status: 'passed', steps: 21, passed: 21, failed: 0, uncompared: 0 });
  });

  it('1. rotate, reference side: stored properties.rotate = 15 against our 0 fails S12 with one vid diff', async () => {
    const f = await folder(); await perturbS12(f.dir, 'rotate', 15);
    expectOneDiff(await run(f), 'rotate', 15, 0);
  });

  it('2. rotate, Cutframe side: transformItem rotation 15 before S12 against the stored 0 fails S12; R1 is uncompared', async () => {
    const f = await folder(); const report = await run(f, { calls: withStep(f, { id: 'R1', tool: 'transformItem', input: { itemId: 'clip-1', rotation: 15 } }) });
    expectOneDiff(report, 'rotate', 0, 15);
    expect(report.parts[0].steps.find(s => s.id === 'R1')!.status).toBe('uncompared'); expect(report.uncompared).toBe(1);
  });

  it('3. volume, reference side: stored properties.volume = 0.5 against our default 1 fails S12 with one vid diff', async () => {
    const f = await folder(); await perturbS12(f.dir, 'volume', 0.5);
    expectOneDiff(await run(f), 'volume', 0.5, 1);
  });

  it('4. volume, Cutframe side: editProperties volume 0.5 before S12 against the stored 1 fails S12; V1 is uncompared (blocked-on-P2)', async () => {
    const f = await folder(); const report = await run(f, { calls: withStep(f, { id: 'V1', tool: 'editProperties', input: { itemId: 'clip-1', properties: { volume: 0.5 } } }) });
    expectOneDiff(report, 'volume', 1, 0.5);
    expect(report.parts[0].steps.find(s => s.id === 'V1')!.status).toBe('uncompared'); expect(report.uncompared).toBe(1);
  });
});
