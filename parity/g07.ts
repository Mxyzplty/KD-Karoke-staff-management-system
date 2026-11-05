// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-07 --xapp-ref <dir> …`: replays the stored golden effects sweep G-07 (agent tool results §9; tickets T10
// "Oracle") through the direct-call harness, one call at a time. After every step it compares (1) the call result with
// `results/<id>.json` (success, code, error, message, details.errors[].path / code, and every per-item `added` list and
// effects block the result carries) and (2) every effects block of a stored read (a context / viewItemDetails result, or
// `<id>.vid`) with Cutframe's block for the same item (results l.1350: agent id, effectType, name, enabled, order, and the
// non-default parameters with keyframeCount / keyframeTimes). The inputs S3a / S3b / S3c are the fixture stills (fixture
// manifest l.47). Not compared here: the preview frames frames/*.jpg (their naming and plan.json are not documented; T10
// notes), the export (T16) and the registry reads listEffects / getEffectDetails (T18 wires them; T10a's inventory tests
// check the registry). Run by Author on D2 only; implementers test it on synthetic folders (parity/g07-synthetic.ts).
// Provisional choices, not Xapp parity: the stored calls (or inline setup steps in --calls) create the items; Xapp item ids
// are learnt from call results, then from stored reads by span, then as the only unpaired item; diffs on a lut's lutData /
// lutName after `.cube` text reached that item through writeEffects are reported as documented, not failed (results §9
// decision 1: Cutframe bakes the text, Xapp stores it verbatim and renders nothing).
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, inside, resolvedDestination } from './runner';
import type { Json } from './normalise';
import { callResult, findAll, IdMap, isObj, jsonBlocks, learnCall, loadStored, type Diff, type G01Step } from './g01';
import { createEditor } from '../apps/web/src/timeline/harness';
import { item, setIdSource } from '../apps/web/src/timeline/model';
import { effectsBlock } from '../apps/web/src/timeline/effects';
import { TOOLS } from '../apps/web/src/timeline/tools';
import type { Asset, AssetLink, RecordData } from '../apps/web/src/store/model';

type Rec = { [key: string]: Json };
export type G07Options = { calls: G01Step[][]; assets: Record<string, string>; toolField: string; inputField: string; blockBase?: 0 | 1; output?: string };
type StepReport = { id: string; tool: string; status: 'passed' | 'failed' | 'deferred' | 'uncompared'; compared: string[]; diffs: Diff[]; deferredDiffs?: Diff[]; documentedDiffs?: Diff[]; note?: string };

const same = (a: Json | undefined, b: Json | undefined): boolean => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i]))
  : isObj(a) && isObj(b) ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b && same(a[k], b[k]))
  : a === b;
const first = (v: Json, key: string): Json | undefined => findAll(v, o => key in o)[0]?.[key];

// ---- Fixture stills (fixtures/Cutframe test fixtures (C).md l.55–57).
const STILLS: Record<string, { file: string; bytes: number }> = {
  S3a: { file: 'S3a-gradient-1080x1920.png', bytes: 12612 },
  S3b: { file: 'S3b-corpus-frame-tos-action-13s-1080x1920.png', bytes: 435829 },
  S3c: { file: 'S3c-text-on-alpha-1080x1920.png', bytes: 24596 },
};
/** One image asset per `--assets` entry (Xapp asset id → S3a / S3b / S3c); the link's agent id is the Xapp id. */
export function stillAssets(assets: Record<string, string>): { assets: Asset[]; links: AssetLink[] } {
  const out: { assets: Asset[]; links: AssetLink[] } = { assets: [], links: [] };
  for (const [xappId, name] of Object.entries(assets)) {
    const m = STILLS[name];
    if (!m) throw Error(`--assets: unknown fixture '${name}' for ${xappId} (use ${Object.keys(STILLS).join(', ')})`);
    const id = `g07-${name}-${out.assets.length + 1}`;
    out.assets.push({ id, name: m.file, type: 'image', sizeBytes: m.bytes, mimeType: 'image/png', folderId: null, created_at: '', recorded_at: null, location: null, durationMs: null,
      processing_status: 'ready', last_error_code: null,
      media: { container: 'png', mimeType: 'image/png', durationMs: null, video: null, audio: null, image: { width: 1080, height: 1920 } } } as unknown as Asset);
    out.links.push({ id: `g07:${id}`, projectId: 'g07', assetId: id, agent_id: xappId, content_type: 'image', added_at: '', deleted_at: null });
  }
  return out;
}

// ---- Effects blocks (results l.1350) wherever a result carries one: `{itemId | id, effects: [...] | null, added?}`.
const isEffects = (v: Json | undefined) => v === null || (Array.isArray(v) && v.every(e => isObj(e) && typeof e.effectId === 'string'));
export type EffectsHit = { id?: string; effects: Json; added?: Json; start?: number; end?: number };
export const effectsOf = (values: Json[]): EffectsHit[] => values.flatMap(v => findAll(v, o => 'effects' in o && isEffects(o.effects))).map(o => ({
  id: typeof o.itemId === 'string' ? o.itemId : typeof o.id === 'string' ? o.id : undefined, effects: o.effects,
  ...('added' in o ? { added: o.added } : {}), ...(typeof o.startTime === 'number' && typeof o.endTime === 'number' ? { start: o.startTime, end: o.endTime } : {}),
}));

const CUBE_FIELDS = new Set(['lutData', 'lutName']);
const DOCUMENTED = 'documented improvement: Cutframe bakes .cube text sent through writeEffects (results §9 decision 1)';
/** The stored list against ours: ids in order, then each instance's stored fields and the union of their parameters. */
function compareEffects(v: Json, o: Json, at: string, part: Diff['part'], diffs: Diff[], documented: Diff[], cube: boolean) {
  const check = (p: string, a: Json | undefined, b: Json | undefined, doc = false) => {
    if (!same(a, b)) (doc ? documented : diffs).push({ part, path: p, expected: a ?? null, actual: b ?? null, ...(doc ? { note: DOCUMENTED } : {}) });
  };
  if (!Array.isArray(v) || !Array.isArray(o)) return check(at, v, o);
  check(`${at}(ids)`, v.map(e => isObj(e) ? e.effectId : null), o.map(e => isObj(e) ? e.effectId : null));
  v.forEach((e, n) => {
    const u = o[n], k = `${at}[${n}]`;
    if (!isObj(e) || !isObj(u)) return;
    for (const f of ['effectType', 'name', 'enabled', 'order']) if (f in e) check(`${k}.${f}`, e[f], u[f]);
    const vp = isObj(e.parameters) ? e.parameters : {}, op = isObj(u.parameters) ? u.parameters : {};
    for (const p of new Set([...Object.keys(vp), ...Object.keys(op)])) check(`${k}.parameters.${p}`, vp[p], op[p], cube && e.effectType === 'lut' && CUBE_FIELDS.has(p));
  });
}

// ---- The call result.
const schemaErrors = (x: Rec) => { const d = first(x, 'details'); return isObj(d) && Array.isArray(d.errors) ? d.errors.map(e => isObj(e) ? { path: e.path ?? null, code: e.code ?? null } : e) : undefined; };
const failureCodes = (x: Rec) => { const f = first(x, 'failures'); return Array.isArray(f) ? f.map(e => isObj(e) ? { itemId: e.itemId ?? null, code: e.code ?? null } : e) : undefined; };
function compareCall(v: Rec, o: Rec): Diff[] {
  const diffs: Diff[] = [], check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'call', path: p, expected: a ?? null, actual: b ?? null }); };
  check('success', v.success, o.success);
  if ('error' in v || 'error' in o) check('error', v.error, o.error);
  // As G-01 / G-02: `code` and `message` are compared where Xapp's result has them.
  if ('code' in v) check('code', v.code, o.code);
  if ('message' in v) check('message', v.message, o.message);
  const errors = schemaErrors(v), failures = failureCodes(v);
  if (errors) check('details.errors', errors, schemaErrors(o));
  if (failures) check('failures', failures, failureCodes(o));
  return diffs;
}
/** `.cube` text (not the baked base64 table) in a writeEffects input: the Xapp ids of the items it reached. */
const cubeTargets = (input: Json): string[] => {
  if (!isObj(input) || !findAll(input, o => typeof o.lutData === 'string' && /LUT_3D_SIZE/.test(o.lutData)).length) return [];
  return [input.itemId, ...(Array.isArray(input.itemIds) ? input.itemIds : [])].filter((x): x is string => typeof x === 'string');
};

// ---- Replay.
const READS = new Set(['context', 'viewItemDetails']);
/** Stored G-07 tools the direct-call harness does not run, with what compares them. */
const REGISTRY = 'T18 wires the registry reads; T10a checks the registry';
const OWNERS: Record<string, string> = { captureFrame: 'this replay does not compare the preview frames (T10 notes)', exportProject: 'T16 compares it', getExportStatus: 'T16 compares it',
  listEffects: REGISTRY, getEffectDetails: REGISTRY };
export async function runG07(referenceDir: string, o: G07Options) {
  if (!o.toolField || !o.inputField) throw Error('--tool-field and --input-field are required (the stored record schema is not documented)');
  const stored = await loadStored(referenceDir, o.blockBase);
  const out = await resolvedDestination(path.resolve(o.output ?? 'parity-reports/g07')), base = await realpath(referenceDir);
  if (inside(base, out) || inside(out, base)) throw Error('Output/reference directories overlap or alias');
  await mkdir(out, { recursive: true });
  const { assets, links } = stillAssets(o.assets);
  const parts: { steps: StepReport[]; ids: Record<string, string> }[] = [];
  let n = 0;
  setIdSource(() => String(++n).padStart(6, '0'));
  try {
    for (const calls of o.calls) {
      const e = createEditor(undefined, { assets, links }), map = new IdMap(), known = new Set<string>(), cube = new Set<string>(), steps: StepReport[] = [];
      const remember = () => [...e.doc.tracks, ...e.doc.items].forEach(x => known.add(x.id));
      /** A stored item id not learnt from a call: the one unpaired item with its span, else the only unpaired item. */
      const pairRead = (h: EffectsHit) => {
        if (!h.id || map.to.has(h.id)) return;
        const free = e.doc.items.filter(i => !map.from.has(i.id)), span = h.start === undefined ? [] : free.filter(i => Math.abs(i.display.from / 1000 - h.start!) <= 1e-6 && Math.abs(i.display.to / 1000 - h.end!) <= 1e-6);
        const hit = span.length === 1 ? span[0] : free.length === 1 ? free[0] : undefined;
        if (hit) map.pair(h.id, hit.id, `read.${h.id}`);
      };
      const compareHits = (hits: EffectsHit[], part: Diff['part'], report: StepReport, documented: Diff[]) => {
        for (const h of hits) {
          if (part !== 'call') pairRead(h);
          const ours = h.id ? map.to.get(h.id) : e.doc.items.length === 1 ? e.doc.items[0].id : undefined, i = ours ? item(e.doc, ours) : undefined;
          if (!i) { report.diffs.push({ part: 'map', path: h.id ?? 'effects', expected: h.id ?? null, note: 'no Cutframe item for this stored effects block' }); continue; }
          const block = effectsBlock(i), at = `${h.id ?? i.id}.effects`;
          compareEffects(h.effects, block.effects as Json, at, part, report.diffs, documented, cube.has(h.id ?? ''));
        }
      };
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
        const report: StepReport = { id, tool, status: 'passed', compared: [], diffs: [] }, documented: Diff[] = [];
        steps.push(report);
        const read = READS.has(tool);
        if (!read && !TOOLS[tool]) { report.status = 'uncompared'; report.note = `not replayed: '${tool}' is not a direct-call tool; ${OWNERS[tool] ?? 'its owning ticket compares it'}`; continue; }
        const own = typeof step === 'string' ? stored.blocks(id) : undefined;
        let deferred: Diff[] | undefined;
        if (!read) {
          if (tool === 'writeEffects') cubeTargets(input).forEach(t => cube.add(t));
          const ours = e.call(tool, map.input(input) as RecordData) as unknown as Rec, vCall = own ? callResult(own) : undefined;
          remember();
          if (vCall) {
            learnCall(map, vCall, ours, known);
            const diffs = compareCall(map.translate(vCall) as Rec, ours);
            // The per-item `added` ids and effects blocks of a writeEffects result.
            const theirs = effectsOf([vCall]), mine = effectsOf([ours]);
            for (const h of theirs) if (h.added !== undefined) {
              const m = mine.find(x => x.id === (h.id ? map.to.get(h.id) : undefined));
              if (!same(h.added, m?.added)) diffs.push({ part: 'call', path: `${h.id ?? '?'}.added`, expected: h.added, actual: m?.added ?? null });
            }
            report.compared.push('call');
            // Results §4 rule 1: INVALID_TOOL_INPUT is the schema validator's (T18); the direct-call handler refuses with its own code.
            if (vCall.code === 'INVALID_TOOL_INPUT' && ours.success === false && ours.code !== 'INVALID_TOOL_INPUT') {
              deferred = diffs; report.note = `schema refusal: Xapp INVALID_TOOL_INPUT, the direct-call handler ${String(ours.code ?? 'refused')} (T18 owns schema validation)`;
            } else {
              report.diffs.push(...diffs);
              if (theirs.length) { compareHits(theirs, 'call', report, documented); report.compared.push('call.effects'); }
            }
          }
        }
        // A read's own result carries the effects blocks; a write's read-back comes from `<id>.vid`.
        const blocks = read ? own : stored.has(`${id}.vid`) ? stored.blocks(`${id}.vid`) : undefined, hits = blocks ? effectsOf(jsonBlocks(blocks)) : [];
        compareHits(hits, 'vid', report, documented);
        if (hits.length) report.compared.push(read ? `call(${tool})` : 'vid');
        report.diffs.push(...map.conflicts.splice(0));
        if (deferred) report.deferredDiffs = deferred;
        if (documented.length) report.documentedDiffs = documented;
        report.status = report.diffs.length ? 'failed' : deferred ? 'deferred' : report.compared.length ? 'passed' : 'uncompared';
        if (!report.compared.length) report.note ??= 'no stored result or effects block for this step';
      }
      parts.push({ steps, ids: Object.fromEntries(map.to) });
    }
  } finally { setIdSource(null); }
  const all = parts.flatMap(p => p.steps), count = (s: StepReport['status']) => all.filter(x => x.status === s).length;
  const passed = count('passed'), failed = count('failed'), deferred = count('deferred'), uncompared = count('uncompared'), documented = all.filter(x => x.documentedDiffs).length;
  const status = failed ? 'failed' : deferred || uncompared || !all.length ? 'uncompared' : 'passed';
  const report = { version: 1, golden: 'G-07', status, blockBase: stored.blockBase, steps: all.length, passed, failed, deferred, uncompared, documented,
    summary: `${passed} passed, ${failed} failed, ${deferred} deferred (T18 schema validation), ${uncompared} uncompared (preview frames, T16 export, T18 registry reads, or no stored result); ${documented} step(s) carry documented-improvement differences`,
    notCompared: 'the preview frames frames/*.jpg (not built in T10: their naming and plan.json are not documented), frames/export-cut/ and exports/ (T16), and everything in a stored read except its effects blocks',
    parts };
  await atomicJson(out, 'report.json', report);
  return report;
}
