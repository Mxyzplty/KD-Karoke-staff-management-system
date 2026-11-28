// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-02 --xapp-ref <dir> …`: replays the stored golden keyframe and time-remap capture G-02 (agent tool
// results §6; tickets T04 "Golden keyframe and time-remap capture") through the direct-call harness on S1, one call at a
// time. After every step it compares (1) the call result with `results/<id>.json` (success, code, error, message,
// resolvedKeyframes, speedRange, warnings, details.errors[].path / code) and (2) the item's `keyframes` object with
// `<id>.vid` (sorted by time: times and values to 1e-9, stored easing names, handles, the timeRemap curve; then the
// stored order). With `frames` (parity/g02-frames.ts, T15) each captureFrame step is compared with the stored preview frames
// frames/F1-<t>.jpg / F2-<t>.jpg; the export frames and the export's ffprobe facts are T16's and not compared.
// Run by Author on D2 only; implementers test it on synthetic folders (parity/g02-synthetic.ts). Provisional choices,
// not Xapp parity: the `--item` track, schema refusals reported as deferred (T18), and call fields compared wherever
// each result carries them (Xapp's envelope position is not documented).
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, inside, resolvedDestination } from './runner';
import type { Json } from './normalise';
import { callResult, findAll, fixtureAssets, IdMap, isObj, jsonBlocks, learnCall, loadStored, type Diff, type G01Step } from './g01';
import { createEditor } from '../apps/web/src/timeline/harness';
import { item, setIdSource } from '../apps/web/src/timeline/model';
import { keyframesBlock, remapKeyframes } from '../apps/web/src/timeline/properties';
import { TOOLS } from '../apps/web/src/timeline/tools';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';

type Rec = { [key: string]: Json };
/** A stored captureFrame step: its input and the project at that point. F1: before any time remap (results §6 state P), F2:
 *  with one (P + R). */
export type G02Capture = { id: string; state: 'F1' | 'F2'; input: Json; doc: ProjectDocument };
/** The frames comparison (it may write files under `out`, the report directory): the diffs of each captureFrame step by id,
 *  and a summary for the report. */
export type G02Frames = (captures: G02Capture[], out: string) => Promise<{ diffs: Record<string, Diff[]>; summary: Json }>;
/** `item`: the Xapp id of S1's clip when the stored calls do not create it (the replay places S1 itself). */
export type G02Options = { calls: G01Step[][]; assets: Record<string, string>; toolField: string; inputField: string; item?: string; blockBase?: 0 | 1; output?: string; frames?: G02Frames };
type StepReport = { id: string; tool: string; status: 'passed' | 'failed' | 'deferred' | 'uncompared'; compared: string[]; diffs: Diff[]; deferredDiffs?: Diff[]; note?: string };

const same = (a: Json | undefined, b: Json | undefined): boolean => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i]))
  : isObj(a) && isObj(b) ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b && same(a[k], b[k]))
  : a === b;
/** The first value of `key` anywhere in a result. */
const first = (v: Json, key: string): Json | undefined => findAll(v, o => key in o)[0]?.[key];

// ---- The keyframes object (results §2 viewItemDetails `include=keyframes`; §6 "the loader compares the keyframes object only").
const isTracks = (k: Json | undefined) => k === null || (isObj(k) && Object.values(k).every(t => isObj(t) && Array.isArray(t.keyframes)));
/** Every `keyframes` object in a stored read, with the id of the Details (or context item) carrying it. */
export const keyframesOf = (blocks: string[]) => jsonBlocks(blocks).flatMap(v => findAll(v, o => 'keyframes' in o && isTracks(o.keyframes)))
  .map(o => ({ id: typeof o.id === 'string' ? o.id : undefined, keyframes: o.keyframes }));

/** Sorted by time, each keyframe whole (to 1e-9); then, only if those agree, the stored order as one line (findings part 2
 *  §41: replace stores sorted, add / update append; the Author run confirms or refutes it). */
function compareKeyframes(v: Json, o: Json, at: string, diffs: Diff[]) {
  const check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'vid', path: p, expected: a ?? null, actual: b ?? null }); };
  if (!isObj(v) || !isObj(o)) return check(at, v, o);
  check(`${at}(properties)`, Object.keys(v).sort(), Object.keys(o).sort());
  for (const [p, t] of Object.entries(v)) {
    const u = o[p], k = `${at}.${p}`;
    if (!isObj(t) || !isObj(u)) continue;
    check(`${k}.defaultValue`, t.defaultValue, u.defaultValue); check(`${k}.keyframeCount`, t.keyframeCount, u.keyframeCount);
    const list = (x: Rec) => (Array.isArray(x.keyframes) ? x.keyframes : []) as Rec[], times = (l: Rec[]) => l.map(f => f.timelineSeconds);
    const byTime = (l: Rec[]) => [...l].sort((a, b) => (a.timelineSeconds as number) - (b.timelineSeconds as number));
    const a = byTime(list(t)), b = byTime(list(u)), before = diffs.length;
    for (let n = 0; n < Math.max(a.length, b.length); n++) check(`${k}.keyframes[${n}]`, a[n], b[n]);
    if (diffs.length === before) check(`${k}.order`, times(list(t)), times(list(u)));
  }
}

// ---- The call result (tickets T04 G-02 (2)).
const FIELDS = ['resolvedKeyframes', 'speedRange', 'warnings'];
const schemaErrors = (x: Rec) => { const d = first(x, 'details'); return isObj(d) && Array.isArray(d.errors) ? d.errors.map(e => isObj(e) ? { path: e.path ?? null, code: e.code ?? null } : e) : undefined; };
function compareCall(v: Rec, o: Rec): Diff[] {
  const diffs: Diff[] = [], check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'call', path: p, expected: a ?? null, actual: b ?? null }); };
  check('success', v.success, o.success);
  if ('error' in v || 'error' in o) check('error', v.error, o.error);
  // As G-01: Cutframe adds a code to Xapp's code-less failures, so `code` and `message` are compared where Xapp has them.
  if ('code' in v) check('code', v.code, o.code);
  if ('message' in v) check('message', v.message, o.message);
  // A warning Cutframe adds is a difference too; the other fields are compared where Xapp's result carries them.
  for (const f of FIELDS) { const a = first(v, f), b = first(o, f); if (a !== undefined || (f === 'warnings' && b !== undefined)) check(f, a, b); }
  const errors = schemaErrors(v);
  if (errors) check('details.errors', errors, schemaErrors(o));
  return diffs;
}

// ---- Replay.
const READS = new Set(['context', 'viewItemDetails']);
/** Stored G-02 tools the direct-call harness does not run, with the ticket that compares them. */
const OWNERS: Record<string, string> = { captureFrame: 'T15', exportProject: 'T16', getExportStatus: 'T16' };
export async function runG02(referenceDir: string, o: G02Options) {
  if (!o.toolField || !o.inputField) throw Error('--tool-field and --input-field are required (the stored record schema is not documented)');
  const stored = await loadStored(referenceDir, o.blockBase);
  const out = await resolvedDestination(path.resolve(o.output ?? 'parity-reports/g02')), base = await realpath(referenceDir);
  if (inside(base, out) || inside(out, base)) throw Error('Output/reference directories overlap or alias');
  await mkdir(out, { recursive: true });
  const { assets, links } = fixtureAssets(o.assets), s1 = Object.keys(o.assets).find(k => o.assets[k] === 'S1');
  if (o.item !== undefined && !s1) throw Error('--item places S1: --assets must map one Xapp asset id to S1');
  const parts: { steps: StepReport[]; ids: Record<string, string> }[] = [], captures: (G02Capture & { report: StepReport })[] = [];
  let n = 0;
  setIdSource(() => String(++n).padStart(6, '0'));
  try {
    for (const calls of o.calls) {
      const e = createEditor(undefined, { assets, links }), map = new IdMap(), known = new Set<string>(), steps: StepReport[] = [];
      const remember = () => [...e.doc.tracks, ...e.doc.items].forEach(x => known.add(x.id));
      if (o.item !== undefined) {
        // Results §6 (l.1657): "S1 sat at timeline 0–10 s with trim 0–10 and rate 1". The track (a new video track) is our choice.
        const track = e.call('manageTrack', { action: 'create', kind: 'video' }) as RecordData;
        const added = e.call('addMedia', { trackId: track.data?.track?.id, items: [{ assetId: s1 }] }) as RecordData, id = added.data?.addedItemIds?.[0];
        const i = typeof id === 'string' ? item(e.doc, id) : undefined;
        if (!i || i.display.from !== 0 || i.display.to !== 10000 || i.trim?.from !== 0 || i.trim?.to !== 10000 || (i.playbackRate ?? 1) !== 1) throw Error('--item: S1 could not be placed at timeline 0–10 s, trim 0–10, rate 1');
        map.pair(o.item, i.id, 'setup');
      }
      remember();
      for (const step of calls) {
        let id: string, tool: string, input: Json;
        if (typeof step === 'string') {
          const r = stored.record(step);
          if (!r) throw Error(`--calls names ${step}, which has no results/${step}.json`);
          const missing = [o.toolField, o.inputField].find(f => !(f in r));
          if (missing) throw Error(`results/${step}.json has no '${missing}' field; its top-level keys are: ${Object.keys(r).join(', ')}`);
          id = step; tool = String(r[o.toolField]); input = typeof r[o.inputField] === 'string' ? JSON.parse(r[o.inputField] as string) : r[o.inputField];
        } else ({ id, tool, input } = step);
        const report: StepReport = { id, tool, status: 'passed', compared: [], diffs: [] };
        steps.push(report);
        const read = READS.has(tool);
        // The project as it stands at this step; F2 once a clip carries a time remap.
        if (tool === 'captureFrame' && o.frames) { captures.push({ id, state: e.doc.items.some(i => remapKeyframes(i).length) ? 'F2' : 'F1', input: map.input(input), doc: structuredClone(e.doc), report }); continue; }
        if (!read && !TOOLS[tool]) { report.status = 'uncompared'; report.note = `not replayed: '${tool}' is not a direct-call tool (${OWNERS[tool] ?? 'its owning ticket'} compares it)`; continue; }
        const own = typeof step === 'string' ? stored.blocks(id) : undefined;
        let deferred: Diff[] | undefined;
        if (!read) {
          const ours = e.call(tool, map.input(input) as RecordData) as unknown as Rec, vCall = own ? callResult(own) : undefined;
          remember();
          if (vCall) {
            learnCall(map, vCall, ours, known);
            const diffs = compareCall(map.translate(vCall) as Rec, ours);
            report.compared.push('call');
            // Results §4 rule 1: INVALID_TOOL_INPUT is the schema validator's (T18); the direct-call handler refuses with its own code.
            if (vCall.code === 'INVALID_TOOL_INPUT' && ours.success === false && ours.code !== 'INVALID_TOOL_INPUT') {
              deferred = diffs; report.note = `schema refusal: Xapp INVALID_TOOL_INPUT, the direct-call handler ${String(ours.code ?? 'refused')} (T18 owns schema validation)`;
            } else report.diffs.push(...diffs);
          }
        }
        // A read's own result carries the keyframes object; a write's comes from `<id>.vid`.
        const blocks = read ? own : stored.has(`${id}.vid`) ? stored.blocks(`${id}.vid`) : undefined, hits = blocks ? keyframesOf(blocks) : [];
        for (const h of hits) {
          if (h.id && !map.to.has(h.id)) { const free = e.doc.items.filter(i => !map.from.has(i.id)); if (free.length === 1) map.pair(h.id, free[0].id, `vid.${h.id}`); }
          const ours = h.id ? map.to.get(h.id) : e.doc.items.length === 1 ? e.doc.items[0].id : undefined, i = ours ? item(e.doc, ours) : undefined;
          if (!i) { report.diffs.push({ part: 'map', path: h.id ?? 'keyframes', expected: h.id ?? null, note: 'no Cutframe item for this stored keyframes object' }); continue; }
          compareKeyframes(map.translate(h.keyframes), keyframesBlock(i).keyframes as Json, `${h.id ?? i.id}.keyframes`, report.diffs);
        }
        if (hits.length) report.compared.push(read ? `call(${tool})` : 'vid');
        report.diffs.push(...map.conflicts.splice(0));
        if (deferred) report.deferredDiffs = deferred;
        report.status = report.diffs.length ? 'failed' : deferred ? 'deferred' : report.compared.length ? 'passed' : 'uncompared';
        if (!report.compared.length) report.note ??= 'no stored result or keyframes object for this step';
      }
      parts.push({ steps, ids: Object.fromEntries(map.to) });
    }
  } finally { setIdSource(null); }
  let frames: Json | undefined;
  if (o.frames) {
    const r = await o.frames(captures.map(({ report, ...c }) => c), out);
    for (const c of captures) { const d = r.diffs[c.id] ?? []; c.report.compared.push('frames'); c.report.diffs.push(...d); c.report.status = d.length ? 'failed' : 'passed'; }
    frames = r.summary;
  }
  const all = parts.flatMap(p => p.steps), count = (s: StepReport['status']) => all.filter(x => x.status === s).length;
  const passed = count('passed'), failed = count('failed'), deferred = count('deferred'), uncompared = count('uncompared');
  const status = failed ? 'failed' : deferred || uncompared || !all.length ? 'uncompared' : 'passed';
  const report = { version: 1, golden: 'G-02', status, blockBase: stored.blockBase, steps: all.length, passed, failed, deferred, uncompared,
    summary: `${passed} passed, ${failed} failed, ${deferred} deferred (T18 schema validation), ${uncompared} uncompared (${frames === undefined ? 'T15 / T16 frames and export' : 'T16 export'}, or the tool's owning ticket)`,
    notCompared: `${frames === undefined ? 'the preview frames frames/F1-<t>.jpg and frames/F2-<t>.jpg (T15, --frames), ' : ''}the export frames exports/frames/E-<t>.png and exports/ffprobe.json (T16), and everything in a stored read except its keyframes object (results §6)`,
    ...(frames === undefined ? {} : { frames }), parts };
  await atomicJson(out, 'report.json', report);
  return report;
}
