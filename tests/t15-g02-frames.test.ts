// SPDX-License-Identifier: AGPL-3.0-only
// T15: the G-02 frames runner (parity/g02-frames.ts, CLI `--golden G-02 --frames --frame-time-unit ms|s|frame`) on a SYNTHETIC stored reference
// from parity/g02-synthetic.ts ({ frames: true } adds the C00 captureFrame at 0 s and 0.5 s before the remap; C01 stays after it).
// This is NOT Xapp parity: the stored frames here are our own renderer's JPEGs, so the round trip proves the runner (name matching, rendering,
// pixel and counter comparison, report shape) is self-consistent, nothing about Xapp's frames.
// Oracles, per test: self-consistency of our renderer (1, 3); fixture design, counter = round(t x 30) (2: F1 at 0 s and 0.5 s); written spec,
// tickets l.69, checked by eye (2: F2 at 0.516667 s reads 5 and 0.75 s reads 11); coordinator decision + T00 harness runbook l.50, the unit of <t>
// in frames/F1-<t>.jpg is undocumented so no default exists (4, 5).
// The browser tests (1-3) need the fixture store (S1, checked against the manifest's size and sha256) and take about a minute each.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareFrames, matchFrames, renderCaptures } from '../parity/g02-frames';
import { runG02, type G02Capture } from '../parity/g02';
import { writeSyntheticG02 } from '../parity/g02-synthetic';
import { STORE, hasStore } from './media-fixtures';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const T = 240_000;
let root: string, ref: string, opts: Omit<Parameters<typeof runG02>[1], 'output' | 'frames'>, recorded: G02Capture[];
type Report = Awaited<ReturnType<typeof runG02>>;
const frameSteps = (r: Report) => r.parts.flatMap(p => p.steps).filter(s => s.tool === 'captureFrame');
const run = (dir: string, out: string) => runG02(dir, { ...opts, output: path.join(root, out), frames: compareFrames(dir, 's', { store: STORE }) });
const stored = [['F1', 0], ['F1', 0.5], ['F2', 0.516667], ['F2', 0.75]] as const;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'g02-t15-'));
  ref = path.join(root, 'ref');
  const w = await writeSyntheticG02(ref, { frames: true });
  opts = { calls: w.calls, assets: w.assets, toolField: w.toolField, inputField: w.inputField, item: w.item, blockBase: w.blockBase };
  // A stub frames callback records the captures without a browser.
  await runG02(ref, { ...opts, output: path.join(root, 'rec'), frames: async c => { recorded = c; return { diffs: {}, summary: {} }; } });
}, 60_000);

describe('G-02 frames: name matching (pure, no browser; coordinator decision + T00 runbook l.50)', () => {
  const names = { s: ['F1-0.jpg', 'F1-0.5.jpg', 'F2-0.516667.jpg', 'F2-0.75.jpg'], ms: ['F1-0.jpg', 'F1-500.jpg', 'F2-517.jpg', 'F2-750.jpg'], frame: ['F1-0.jpg', 'F1-15.jpg', 'F2-16.jpg', 'F2-23.jpg'] };
  const withNames = (base: string[], edit: (n: string[]) => string[]) => edit([...base]);

  it('the recorded captures are C00 (F1: 0 and 0.5 s, quality high) and C01 (F2: 0.516667 and 0.75 s)', () => {
    expect(recorded.map(c => [c.id, c.state, (c.input as { timestamps: number[] }).timestamps])).toEqual([['C00', 'F1', [0, 0.5]], ['C01', 'F2', [0.516667, 0.75]]]);
  });
  for (const unit of ['s', 'ms', 'frame'] as const) {
    it(`unit ${unit}: ${names[unit].join(', ')} match the four stored timestamps in input order`, () => {
      const m = matchFrames(names[unit], recorded, unit);
      expect(Object.fromEntries(Object.entries(m).map(([id, l]) => [id, l.map(r => r.timestamp)]))).toEqual({ C00: [0, 0.5], C01: [0.516667, 0.75] });
      expect(Object.values(m).flat().map(r => r.file).sort()).toEqual([...names[unit]].sort());
    });
  }
  it('unit s: F1-0.jpg next to F1-0.5.jpg is fine: an exact match wins inside the ambiguous rounding window', () => {
    expect(() => matchFrames(names.s, recorded, 's')).not.toThrow();
  });
  it('an extra F1-9.jpg is refused ("matches no stored")', () => {
    expect(() => matchFrames(withNames(names.s, n => [...n, 'F1-9.jpg']), recorded, 's')).toThrow(/matches no stored/);
  });
  it('a missing file is refused ("No stored frame for")', () => {
    expect(() => matchFrames(names.s.slice(0, 3), recorded, 's')).toThrow(/No stored frame for/);
  });
  it('F1-abc.jpg is refused (does not parse)', () => {
    expect(() => matchFrames(withNames(names.s, n => [...n, 'F1-abc.jpg']), recorded, 's')).toThrow(/F1-abc\.jpg: not F1-<t>\.jpg or F2-<t>\.jpg/);
  });
  it('two names for one timestamp are refused', () => {
    expect(() => matchFrames(withNames(names.s, n => [...n, 'F1-0.0.jpg']), recorded, 's')).toThrow(/both name/);
  });
  it('a unit that is not ms, s or frame is refused by compareFrames', () => {
    expect(() => compareFrames(ref, 'sec' as never)).toThrow(/must be one of ms, s, frame/);
  });
});

describe('G-02 frames: CLI refusals (the arguments are checked before any file is read; stderr text is the runner\'s)', () => {
  const base = ['--golden', 'G-02', '--xapp-ref', 'nowhere', '--calls', 'nowhere.json', '--assets', 'nowhere.json', '--tool-field', 'tool', '--input-field', 'input', '--item', 'clip-1'];
  const cli = (extra: string[], b = base) => spawnSync(process.execPath, [TSX, 'parity/cli.ts', ...b, ...extra], { encoding: 'utf8', timeout: 180_000 });
  it('--frames alone needs --frame-time-unit ms|s|frame (T00 harness runbook l.50)', () => {
    const r = cli(['--frames']); expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--frames needs --frame-time-unit ms\|s\|frame: .*\(T00 harness runbook l\.50\)/);
  });
  it('--frame-time-unit s alone is only used with --frames', () => {
    const r = cli(['--frame-time-unit', 's']); expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--frame-time-unit is only used with --frames/);
  });
  it('--frames --frame-time-unit sec must be ms, s or frame', () => {
    const r = cli(['--frames', '--frame-time-unit', 'sec']); expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--frame-time-unit must be ms, s or frame/);
  });
  it('G-01 with --frames: --item, --frames and --frame-time-unit are G-02 options', () => {
    const r = cli(['--frames', '--frame-time-unit', 's'], ['--golden', 'G-01', ...base.slice(2, -2)]); // base without --item clip-1
    expect(r.status).not.toBe(0); expect(r.stderr).toMatch(/--item, --frames and --frame-time-unit are G-02 options/);
  });
});

describe.skipIf(!hasStore)('G-02 frames: round trip through the real session (self-consistency of our renderer, NOT Xapp parity; needs the fixture store)', () => {
  let rows: Record<string, any>[], report: Report;
  beforeAll(async () => {
    const frames = await renderCaptures(recorded, { store: STORE });
    await mkdir(path.join(ref, 'frames'), { recursive: true });
    for (const f of frames) await writeFile(path.join(ref, 'frames', `${f.state}-${f.timestamp}.jpg`), f.jpeg);
    report = await run(ref, 'out-same');
    rows = (report as any).frames.rows;
  }, T);

  it('1. our own frames as the stored ones: C00 and C01 pass with 0 frame diffs; 4 rows; same encoder; pixelsOver 0', () => {
    expect(frameSteps(report).map(s => [s.id, s.status])).toEqual([['C00', 'passed'], ['C01', 'passed']]);
    expect(frameSteps(report).flatMap(s => s.diffs)).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows.map(r => [r.state, r.timestamp])).toEqual(stored.map(s => [...s]));
    for (const r of rows) expect(r, r.file).toMatchObject({ encoder: 'same', pixelsOver: 0 });
    expect((report as any).frames).toMatchObject({ unit: 's', steps: 2, failedSteps: 0, frames: 4 });
  }, T);

  it('2. counter readings: F1 at 0 and 0.5 s read 0 and 15 (fixture design, round(t x 30)); F2 at 0.516667 and 0.75 s read 5 and 11 (tickets l.69, checked by eye); ours = stored', () => {
    expect(rows.map(r => r.counter.ours)).toEqual([0, 15, 5, 11]);
    for (const r of rows) expect(r.counter.stored, r.file).toBe(r.counter.ours);
  }, T);

  it('3. negative control: corrupting F1-0.jpg fails C00 with exactly one diff frames/F1-0.jpg.pixels (expected 0, actual > 0); C01 passes; report failed', async () => {
    const bad = path.join(root, 'ref-bad');
    await cp(ref, bad, { recursive: true });
    const file = path.join(bad, 'frames', 'F1-0.jpg'), buf = await readFile(file);
    for (let i = Math.floor(buf.length / 2); i < Math.floor(buf.length / 2) + 64; i++) buf[i] = buf[i] === 0xff ? 0xfe : buf[i] ^ 0x5a;
    await writeFile(file, buf);
    const r = await run(bad, 'out-bad');
    expect(frameSteps(r).map(s => [s.id, s.status])).toEqual([['C00', 'failed'], ['C01', 'passed']]);
    const diffs = frameSteps(r)[0].diffs;
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ part: 'frame', path: 'frames/F1-0.jpg.pixels', expected: 0 });
    expect(diffs[0].actual as number).toBeGreaterThan(0);
    expect(r.status).toBe('failed');
  }, T);
});

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
