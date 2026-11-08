// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EditorAdapter, runScenario, type ParityAdapter, type Scenario } from './runner';
import { MockProvider, NoProvider } from './provider';
import { importReference } from './reference';
import type { Json } from './normalise';
export async function selfCheck(output = 'parity-reports/self-check') {
  // A real adapter contract exercise, explicitly a harness probe, never an editor pass.
  let state: Json = {};
  const adapter: ParityAdapter = {
    name: 'T00-harness-probe',
    async open(p) { state = p; },
    async execute(tool, input) { if (tool !== 'probe.set' || !input || typeof input !== 'object' || Array.isArray(input)) throw Error('Unknown probe command'); state = { ...state as object, ...input }; return { success: true }; },
    async project() { return state; },
    async frame(t) { const n = (state as { value: number }).value; return { width: 2, height: 1, rgba: [n, 0, 0, 1, t / 1000, 0, 0, 1] }; },
    async exportMetadata() { return { kind: 'harness-probe', frameCount: 2, fps: 30 }; }
  };
  const scenario: Scenario = { version: 1, inputMode: 'fixture-free', name: 'harness dispatch and output comparison', project: { value: 0 }, edits: [{ tool: 'probe.set', input: { value: 0.5 } }], sampleTimesMs: [0, 1000], expected: { project: { value: 0.5 }, commandResults: [{ success: true }], frames: [{ width: 2, height: 1, rgba: [0.5, 0, 0, 1, 0, 0, 0, 1] }, { width: 2, height: 1, rgba: [0.5, 0, 0, 1, 1, 0, 0, 1] }], exportMetadata: { kind: 'harness-probe', frameCount: 2, fps: 30 } } };
  const report = await runScenario(scenario, adapter, { noProvider: true, output });
  if (report.status !== 'passed') throw Error(`Harness self-check failed: ${JSON.stringify(report)}`);
  const absent = await runScenario(scenario, new EditorAdapter(), { noProvider: true, output: path.join(output, 'editor-status') });
  if (absent.status !== 'not-implemented') throw Error('Missing editor incorrectly passed');
  const mock = new MockProvider();
  const events = [];
  for await (const event of mock.stream({ messages: [{ role: 'user', content: 'probe' }] })) events.push(event);
  if (!events.some(e => e.type === 'tool') || mock.requests.length !== 1) throw Error('Mock provider failed');
  let noProvider = false;
  try { for await (const _ of new NoProvider().stream({ messages: [] })) {} } catch (e) { noProvider = (e as { code: string }).code === 'NO_PROVIDER'; }
  if (!noProvider) throw Error('No-provider state was not explicit');
  return { selfCheck: 'passed', inputMode: 'fixture-free', editor: 'not-implemented', noProvider: true };
}
async function main() {
  const args = process.argv.slice(2);
  const option = (flag: string) => { const i = args.indexOf(flag); if (i < 0) return undefined; const value = args[i + 1]; if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`); return value; };
  if (args.includes('--self-check')) { if (args.includes('--xapp-ref')) throw Error('Self-check never reads stored research references'); console.log(JSON.stringify(await selfCheck(), null, 2)); return; }
  if (args[0] === 'import-reference') {
    // Author-run only (D2): converts a golden-capture directory into the runner's reference layout.
    const [capture, out] = args.slice(1, 3);
    if (!capture || !out || capture.startsWith('--') || out.startsWith('--')) throw Error('Use import-reference <capture-dir> <out-dir> [--calls <ids.json>] [--call-id-field <name>] [--frames <folder> --time-from name-ms|name-s|frame-index|map:<file>] [--fps <n>] [--export <mp4>] [--ffprobe <json>] [--project <normalised.json>]');
    const fps = option('--fps');
    console.log(JSON.stringify(await importReference(capture, out, { calls: option('--calls'), callIdField: option('--call-id-field'), frames: option('--frames'), timeFrom: option('--time-from'), fps: fps === undefined ? undefined : Number(fps), export: option('--export'), ffprobe: option('--ffprobe'), project: option('--project') }), null, 2));
    return;
  }
  if (args.includes('--ot6-fade')) {
    // Author-run only (D2) on the stored OT-6 export (T11 integration round, QE1): Cutframe's fade frames 165–194 against the given file's (parity/ot6-fade.ts).
    const file = option('--ot6-fade');
    if (args.includes('--golden') || args.includes('--xapp-ref')) throw Error('Use --ot6-fade <export file> [--output <dir>] on its own');
    const report = await (await import('./ot6-fade')).runOt6Fade(file!, { output: option('--output') });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
    return;
  }
  const golden = option('--golden');
  if (golden === 'G-09') {
    // Research-agent-run only (D2): replays the stored G-09 sequence and compares the parity-mode mix with Xapp's export audio (parity/g09.ts, T13).
    const usage = 'Use --golden G-09 --xapp-ref <dir> --calls <calls.json> --media <media.json> --tool-field <name> --input-field <name> [--sections <sections.json>] [--max-lag-ms <n>] [--block-base 0|1] [--output <dir>]';
    const ref = option('--xapp-ref'), calls = option('--calls'), media = option('--media'), sections = option('--sections'), lag = option('--max-lag-ms'), base = option('--block-base');
    if (!ref || !calls || !media) throw Error(usage);
    if (base !== undefined && base !== '0' && base !== '1') throw Error('--block-base must be 0 or 1');
    if (lag !== undefined && !(Number(lag) > 0)) throw Error('--max-lag-ms must be a positive number');
    const report = await (await import('./g09')).runG09(ref, { calls: JSON.parse(await readFile(calls, 'utf8')), media: JSON.parse(await readFile(media, 'utf8')), toolField: option('--tool-field') ?? '', inputField: option('--input-field') ?? '',
      sections: sections === undefined ? undefined : JSON.parse(await readFile(sections, 'utf8')), maxLagMs: lag === undefined ? undefined : Number(lag), blockBase: base === undefined ? undefined : Number(base) as 0 | 1, output: option('--output') });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = report.status === 'uncompared' ? 2 : 1;
    return;
  }
  if (golden !== undefined) {
    // Author-run only (D2): replays the stored G-01 / G-02 / G-04 / G-07 / G-08 sequence through the direct-call harness (parity/g01.ts, parity/g02.ts, parity/g04.ts, parity/g07.ts, parity/g08.ts).
    const usage = 'Use --golden G-01 --xapp-ref <dir> --calls <calls.json> --assets <assets.json> --tool-field <name> --input-field <name> [--block-base 0|1] [--output <dir>], or --golden G-02 with the same options and [--item <xapp-item-id>] [--frames --frame-time-unit ms|s|frame], or --golden G-07 with the G-01 options (--assets maps Xapp asset ids to S3a, S3b or S3c), or --golden G-04 with the G-01 options but no --assets (T06: shapes only), or --golden G-08 with the G-01 options (--assets maps Xapp asset ids to S1 or S2c) and [--export --frame-name <regex> --frame-time-unit ms|s|frame --windows <spec> [--media S1=<file>] [--media S2c=<file>] [--export-ffprobe <file>]]';
    const ref = option('--xapp-ref'), calls = option('--calls'), assets = option('--assets'), base = option('--block-base'), itemId = option('--item');
    const frames = args.includes('--frames'), unit = option('--frame-time-unit');
    if (!['G-01', 'G-02', 'G-04', 'G-07', 'G-08'].includes(golden) || !ref || !calls || (golden !== 'G-04' && !assets)) throw Error(usage);
    if (golden === 'G-04' && assets !== undefined) throw Error('--assets is not a G-04 option (shapes only)');
    if (base !== undefined && base !== '0' && base !== '1') throw Error('--block-base must be 0 or 1');
    if (golden !== 'G-02' && itemId !== undefined) throw Error('--item is a G-02 option');
    // G-08 --export (T11 integration round, parity/g08-export.ts): the frame names, their time unit and _windows.json are not documented (T00 harness runbook l.50), so each is a flag.
    const g08Export = args.includes('--export'), exportFlags = ['--frame-name', '--windows', '--media', '--export-ffprobe'].filter(f => args.includes(f));
    if (golden !== 'G-08' && (g08Export || exportFlags.length)) throw Error('--export, --frame-name, --windows, --media and --export-ffprobe are G-08 options');
    if (golden === 'G-08' && !g08Export && (exportFlags.length || unit !== undefined)) throw Error('--frame-name, --frame-time-unit, --windows, --media and --export-ffprobe are only used with --export');
    if (golden !== 'G-02' && (frames || unit !== undefined && golden !== 'G-08')) throw Error('--item, --frames and --frame-time-unit are G-02 options');
    // T00 harness runbook l.50: the unit of <t> in frames/F1-<t>.jpg is not documented, so it is never assumed.
    if (frames && unit === undefined) throw Error('--frames needs --frame-time-unit ms|s|frame: the unit of <t> in frames/F1-<t>.jpg / F2-<t>.jpg is not documented (T00 harness runbook l.50)');
    if (!frames && unit !== undefined && golden !== 'G-08') throw Error('--frame-time-unit is only used with --frames');
    let exportCompare: import('./g08-export').G08Export | undefined;
    if (g08Export) {
      const frameName = option('--frame-name'), windows = option('--windows');
      if (!frameName || !unit || !windows) throw Error('--export needs --frame-name <regex> (group 1 = the frame time), --frame-time-unit ms|s|frame and --windows start=<field>,length=<field>,label=<field>,unit=ms|s|frame[,list=<key>]: the names of frames/export/ and the schema of _windows.json are not documented (T00 harness runbook l.50)');
      const media: Record<string, string> = {};
      args.forEach((a, i) => {
        if (a !== '--media') return;
        const m = /^(S1|S2c)=(.+)$/.exec(args[i + 1] ?? '');
        if (!m) throw Error('--media takes S1=<file> or S2c=<file>');
        if (m[1] in media) throw Error(`--media ${m[1]} is given twice`);
        media[m[1]] = m[2];
      });
      const ex = await import('./g08-export');
      exportCompare = ex.compareExport(ref, { frameName, frameUnit: unit as 'ms' | 's' | 'frame', windows: ex.parseWindowSpec(windows), media, exportProbe: option('--export-ffprobe') });
    }
    const { compareFrames, FRAME_TIME_UNITS } = frames || unit !== undefined ? await import('./g02-frames') : { compareFrames: undefined, FRAME_TIME_UNITS: [] };
    if (unit !== undefined && !(FRAME_TIME_UNITS as string[]).includes(unit)) throw Error('--frame-time-unit must be ms, s or frame');
    const common = { calls: JSON.parse(await readFile(calls, 'utf8')), assets: assets === undefined ? {} : JSON.parse(await readFile(assets, 'utf8')), toolField: option('--tool-field') ?? '', inputField: option('--input-field') ?? '',
      blockBase: base === undefined ? undefined : Number(base) as 0 | 1, output: option('--output') };
    const report = golden === 'G-01' ? await (await import('./g01')).runG01(ref, common)
      : golden === 'G-04' ? await (await import('./g04')).runG04(ref, common)
      : golden === 'G-07' ? await (await import('./g07')).runG07(ref, common)
      : golden === 'G-08' ? await (await import('./g08')).runG08(ref, { ...common, export: exportCompare })
      : await (await import('./g02')).runG02(ref, { ...common, item: itemId, frames: compareFrames && compareFrames(ref, unit as 'ms' | 's' | 'frame') });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = report.status === 'uncompared' ? 2 : 1;
    return;
  }
  const sequence = option('--sequence');
  if (!sequence) throw Error('Use --self-check, import-reference <capture-dir> <out-dir> …, --golden G-01|G-02|G-04|G-07|G-08|G-09 …, --ot6-fade <export file> [--output <dir>], or --sequence <scenario.json> [--adapter <module.ts>] [--no-provider] [--xapp-ref <explicit-directory>]');
  const scenario = JSON.parse(await readFile(sequence, 'utf8')) as Scenario;
  const module = option('--adapter');
  const adapter: ParityAdapter = module ? (await import(pathToFileURL(path.resolve(module)).href)).createAdapter() : new EditorAdapter();
  const report = await runScenario(scenario, adapter, { noProvider: args.includes('--no-provider'), output: option('--output') ?? 'parity-reports/latest', referenceDir: option('--xapp-ref') });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = report.status === 'not-implemented' ? 2 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
