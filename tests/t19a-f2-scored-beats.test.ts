// SPDX-License-Identifier: AGPL-3.0-only
// T19a audit F2 (landed-audit-t19a :70-80), phase 1: the scored beats rows run in a gate. The test spawns the real scorer,
// `tsx apps/web/src/analysis/tools/score.ts --part beats --output <tmp>`, and compares every [item, status] of <tmp>/report.json
// with the table below: same items, same order, same statuses. A dropped or renamed row, a `beats runner` crash row
// (score.ts:720) or an unplanned status change on any row turns it red.
// Rows pinned (score.ts at 522537e): BEAT-P01 ×6 :268-277 (BPM ±1 %, F70 ≥ .95, F20 ≥ .85, downbeatF ≥ .85, first ±50 ms,
// deterministic); BEAT-P02 Groove ×3 :281-287 (F ≥ .85 at 70 ms, BPM ±1 %), ids and order from the store's
// datasets/groove/test-subset.json; BEAT-P02 Xapp 3.8-10 s :299 (report-only, null gate, D31 Q6); BEAT-P02 whole-file Xapp
// :309 (uncompared without --beat-reference, which this test never passes); BEAT-P03 :312; SYNC-P01 :324; Determinism :326.
// Store check :703, BeatThis fold0 check :707, exit 1 on any fail :730. No scorer threshold is set or changed here (C8).
// Oracle: the table is written from score.ts and the T19a F2 plan §3 before any run, never from run output.
// Needs the fixture store and BeatThis fold0 (store vitests' skip); CI has neither, so it skips there.
// 26 Nov 2026, one run: spawn wall 140.5 s, vitest 140.73 s; T = 282_000 ms is approximately twice the test time.
// D67: beats wasm; node v26.8.1; onnxruntime-web 1.31.0-dev.20260914-8d85527a0 dist/ort.webgpu.bundle.min.mjs -> ort-wasm-simd-threaded.asyncify.wasm.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const T = 282_000;
const root = process.env.CUTFRAME_FIXTURES;
const fold0 = root ? existsSync(path.join(root, 'models/t19a/CPJKU/beat_this/beat_this_fold0.onnx')) : false;

const TABLE: [item: string, status: 'pass' | 'fail' | 'uncompared'][] = [
  ['BEAT-P01 click-90', 'pass'],
  ['BEAT-P01 drum-120', 'pass'],
  ['BEAT-P01 drum-128', 'pass'],
  ['BEAT-P01 drum-129.2-noise', 'pass'],
  ['BEAT-P01 drum-140-3-4', 'pass'],
  ['BEAT-P01 drum-tempo-change', 'pass'],
  ['BEAT-P02 drummer1/eval_session/1', 'pass'],
  ['BEAT-P02 drummer3/session1/11', 'pass'],
  ['BEAT-P02 drummer3/session2/10', 'pass'],
  ['BEAT-P02 Xapp 3.8-10s (repo numbers, D24 Q9)', 'uncompared'],
  ['BEAT-P02 whole-file Xapp', 'uncompared'],
  ['BEAT-P03', 'pass'],
  ['SYNC-P01', 'pass'],
  ['Determinism beats corpus', 'pass'],
];

describe('T19a audit F2: scored beats rows (score.ts --part beats on the fixture store)', () => {
  it.skipIf(!root || !fold0)('every [item, status] equals the committed table', () => {
    const out = mkdtempSync(path.join(tmpdir(), 't19a-f2-'));
    try {
      const start = performance.now();
      const r = spawnSync(process.execPath, [TSX, 'apps/web/src/analysis/tools/score.ts', '--part', 'beats', '--output', out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: T });
      const seconds = (performance.now() - start) / 1000;
      // The scorer imports onnxruntime-web/webgpu as ESM (models.ts:93): the package's `import.default` export is the bundle, and the
      // wasm it names is the binary ORT loads.
      const ortDir = realpathSync('node_modules/onnxruntime-web'), ortPackage = JSON.parse(readFileSync(path.join(ortDir, 'package.json'), 'utf8'));
      const bundle = path.join(ortDir, ortPackage.exports['./webgpu'].import.default), wasm = [...new Set(readFileSync(bundle, 'utf8').match(/ort-wasm[\w.-]*\.wasm/g))];
      const report = existsSync(path.join(out, 'report.json')) ? JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) : { rows: [], backends: {} };
      const summary = `[T19a F2] spawn wall ${seconds.toFixed(1)} s; exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''}; backends ${JSON.stringify(report.backends)}; node ${process.version} ${process.execPath}; onnxruntime-web ${ortPackage.version} ${bundle} -> ${wasm.join(', ')}`;
      const log = path.join(tmpdir(), 't19a-f2-last-run.log');
      writeFileSync(log, `${summary}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}\n`);
      console.log(`${summary}; log ${log}`);
      const actual = (report.rows as { item: string; status: string }[]).map(row => [row.item, row.status]);
      const expected = new Map(TABLE), got = new Map(actual as [string, string][]);
      for (const [item, status] of actual) if (expected.get(item) !== status) console.log(`[T19a F2] differs: ${item}: expected ${expected.get(item) ?? '(not in table)'}, actual ${status}`);
      for (const [item] of TABLE) if (!got.has(item)) console.log(`[T19a F2] missing: ${item}`);
      if (!actual.length) console.log(`[T19a F2] no report rows; stderr: ${r.stderr.slice(-4000)}`);
      expect(actual).toEqual(TABLE);
      expect(r.status, r.stderr.slice(-4000)).toBe(0);
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, T);
});
