// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-04 --xapp-ref <dir> …`: replays the stored golden shapes sweep G-04 (relay status, G-04 row: addShape ×
// the 6 shapes × 3 bounds / roundness sets and 3 custom paths; tickets T06 "Acceptance") through the direct-call harness, one
// call at a time. After every step it compares (1) the call result with `results/<id>.json` (success, error, code, message,
// details.errors[].path / code, as G-07) and (2) every shape block of a stored read (a viewItemDetails result, or `<id>.vid`;
// results l.1325 timelineMetadata.metadata.shapeType, l.1327 fullDetails {points, closed} in canvas px) with Cutframe's for
// the same item: shapeType, closed, the anchor count, which anchors carry handles, and the filled area: both point lists
// rasterised by the formula oracle (parity/oracle/masks.ts buildPath + fillCoverage) must reach IoU ≥ 0.99 (tickets T06
// Acceptance). Not compared here: G-04's mask steps (T12 compares them) and the captureFrame frames (their naming and
// plan.json are not documented; as G-07). Run by Author on D2 only; implementers test it on synthetic folders
// (parity/g04-synthetic.ts).
// Provisional choices, not Xapp parity: the IoU is the soft IoU Σmin / Σmax of the two coverage planes over the box holding
// both paths' anchors and handles; a stored item id not learnt from a call is paired by span, else as the only unpaired shape.
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, inside, resolvedDestination } from './runner';
import type { Json } from './normalise';
import { callResult, findAll, IdMap, isObj, jsonBlocks, learnCall, loadStored, type Diff, type G01Step } from './g01';
import { buildPath, fillCoverage, type MaskPoint, type Pt } from './oracle/masks';
import { createEditor } from '../apps/web/src/timeline/harness';
import { item, setIdSource } from '../apps/web/src/timeline/model';
import { shapeDetails } from '../apps/web/src/timeline/shape-tools';
import { TOOLS } from '../apps/web/src/timeline/tools';
import type { RecordData } from '../apps/web/src/store/model';

type Rec = { [key: string]: Json };
export type G04Options = { calls: G01Step[][]; toolField: string; inputField: string; blockBase?: 0 | 1; output?: string };
type StepReport = { id: string; tool: string; status: 'passed' | 'failed' | 'deferred' | 'uncompared'; compared: string[]; diffs: Diff[]; deferredDiffs?: Diff[]; iou?: Record<string, number>; note?: string };
/** Tickets T06 Acceptance: generated point lists render with IoU ≥ 0.99. */
export const MIN_IOU = 0.99;

const same = (a: Json | undefined, b: Json | undefined): boolean => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i]))
  : isObj(a) && isObj(b) ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b && same(a[k], b[k]))
  : a === b;
const first = (v: Json, key: string): Json | undefined => findAll(v, o => key in o)[0]?.[key];

// ---- The filled area of two paths (canvas px), each rasterised with exact area anti-aliasing.
type Path = { points: MaskPoint[]; closed: boolean };
export function pathIoU(a: Path, b: Path): number {
  if (!a.points.length || !b.points.length) return a.points.length === b.points.length ? 1 : 0;
  const xs: number[] = [], ys: number[] = [];
  for (const p of [...a.points, ...b.points]) for (const h of [undefined, p.handleIn, p.handleOut]) { xs.push(p.anchor.x + (h?.x ?? 0)); ys.push(p.anchor.y + (h?.y ?? 0)); }
  const x0 = Math.floor(Math.min(...xs)) - 1, y0 = Math.floor(Math.min(...ys)) - 1, W = Math.ceil(Math.max(...xs)) - x0 + 2, H = Math.ceil(Math.max(...ys)) - y0 + 2;
  const plane = (p: Path) => fillCoverage(buildPath(p.points, p.closed).map(s => s.pts.map(([x, y]) => [x - x0, y - y0] as Pt)), W, H);
  const ca = plane(a), cb = plane(b);
  let lo = 0, hi = 0;
  for (let k = 0; k < ca.length; k++) { lo += Math.min(ca[k], cb[k]); hi += Math.max(ca[k], cb[k]); }
  return hi > 0 ? lo / hi : 1;
}

// ---- Shape blocks (results l.1325–l.1327) wherever a stored read carries one.
type ShapeHit = { id?: string; block: Rec; start?: number; end?: number };
const asPath = (f: Rec): Path => ({ points: (f.points as unknown as MaskPoint[]) ?? [], closed: f.closed !== false });
export const shapesOf = (values: Json[]): ShapeHit[] => values.flatMap(v => findAll(v, o => isObj(o.fullDetails) && Array.isArray(o.fullDetails.points))).map(o => {
  const d = isObj(o.timelineMetadata) && isObj(o.timelineMetadata.display) ? o.timelineMetadata.display : undefined;
  return { id: typeof o.id === 'string' ? o.id : typeof o.itemId === 'string' ? o.itemId : undefined, block: o,
    ...(d && typeof d.from === 'number' && typeof d.to === 'number' ? { start: d.from, end: d.to } : {}) };
});
const handleMap = (p: Path) => p.points.map(q => [!!q.handleIn, !!q.handleOut]);
/** Stored shape block against ours: shapeType (when stored), closed, anchors, handle layout and IoU; returns the IoU. */
function compareShape(v: Rec, o: Rec, at: string, diffs: Diff[]): number {
  const check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'vid', path: `${at}.${p}`, expected: a ?? null, actual: b ?? null }); };
  const type = first(v.timelineMetadata ?? null, 'shapeType');
  if (type !== undefined) check('shapeType', type, first(o.timelineMetadata ?? null, 'shapeType'));
  const vp = asPath(v.fullDetails as Rec), op = asPath(o.fullDetails as Rec);
  check('fullDetails.closed', vp.closed, op.closed);
  check('fullDetails.points.length', vp.points.length, op.points.length);
  if (vp.points.length === op.points.length) check('fullDetails.points[].handles', handleMap(vp), handleMap(op));
  const iou = pathIoU(vp, op);
  if (!(iou >= MIN_IOU)) diffs.push({ part: 'vid', path: `${at}.area`, expected: `IoU >= ${MIN_IOU}`, actual: Math.round(iou * 1e4) / 1e4 });
  return iou;
}

// ---- The call result (as G-07).
const schemaErrors = (x: Rec) => { const d = first(x, 'details'); return isObj(d) && Array.isArray(d.errors) ? d.errors.map(e => isObj(e) ? { path: e.path ?? null, code: e.code ?? null } : e) : undefined; };
function compareCall(v: Rec, o: Rec): Diff[] {
  const diffs: Diff[] = [], check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'call', path: p, expected: a ?? null, actual: b ?? null }); };
  check('success', v.success, o.success);
  if ('error' in v || 'error' in o) check('error', v.error, o.error);
  if ('code' in v) check('code', v.code, o.code);
  if ('message' in v) check('message', v.message, o.message);
  const errors = schemaErrors(v);
  if (errors) check('details.errors', errors, schemaErrors(o));
  return diffs;
}

// ---- Replay.
const READS = new Set(['context', 'viewItemDetails']);
const MASKS = 'not replayed: G-04 mask steps are compared by T12';
const OWNERS: Record<string, string> = { captureFrame: 'this replay does not compare the frames (their naming and plan.json are not documented)' };
export async function runG04(referenceDir: string, o: G04Options) {
  if (!o.toolField || !o.inputField) throw Error('--tool-field and --input-field are required (the stored record schema is not documented)');
  const stored = await loadStored(referenceDir, o.blockBase);
  const out = await resolvedDestination(path.resolve(o.output ?? 'parity-reports/g04')), base = await realpath(referenceDir);
  if (inside(base, out) || inside(out, base)) throw Error('Output/reference directories overlap or alias');
  await mkdir(out, { recursive: true });
  const parts: { steps: StepReport[]; ids: Record<string, string> }[] = [];
  let n = 0;
  setIdSource(() => String(++n).padStart(6, '0'));
  try {
    for (const calls of o.calls) {
      const e = createEditor(), map = new IdMap(), known = new Set<string>(), steps: StepReport[] = [];
      const remember = () => [...e.doc.tracks, ...e.doc.items].forEach(x => known.add(x.id));
      /** A stored item id not learnt from a call: the one unpaired shape with its span, else the only unpaired shape. */
      const pairRead = (h: ShapeHit) => {
        if (!h.id || map.to.has(h.id)) return;
        const free = e.doc.items.filter(i => i.type === 'shape' && !map.from.has(i.id)), span = h.start === undefined ? [] : free.filter(i => Math.abs(i.display.from / 1000 - h.start!) <= 1e-6 && Math.abs(i.display.to / 1000 - h.end!) <= 1e-6);
        const hit = span.length === 1 ? span[0] : free.length === 1 ? free[0] : undefined;
        if (hit) map.pair(h.id, hit.id, `read.${h.id}`);
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
        const report: StepReport = { id, tool, status: 'passed', compared: [], diffs: [] };
        steps.push(report);
        const read = READS.has(tool);
        if (!read && /mask/i.test(tool)) { report.status = 'uncompared'; report.note = MASKS; continue; }
        if (!read && !TOOLS[tool]) { report.status = 'uncompared'; report.note = `not replayed: '${tool}' is not a direct-call tool; ${OWNERS[tool] ?? 'its owning ticket compares it'}`; continue; }
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
        // A read's own result carries the shape blocks; a write's read-back comes from `<id>.vid`.
        const blocks = read ? own : stored.has(`${id}.vid`) ? stored.blocks(`${id}.vid`) : undefined, hits = blocks ? shapesOf(jsonBlocks(blocks)) : [];
        for (const h of hits) {
          pairRead(h);
          const mine = h.id ? map.to.get(h.id) : undefined, i = mine ? item(e.doc, mine) : undefined;
          if (!i || i.type !== 'shape') { report.diffs.push({ part: 'map', path: h.id ?? 'shape', expected: h.id ?? null, note: 'no Cutframe shape for this stored shape block' }); continue; }
          (report.iou ??= {})[h.id!] = compareShape(h.block, shapeDetails(e.doc, i) as Rec, h.id!, report.diffs);
        }
        if (hits.length) report.compared.push(read ? `call(${tool})` : 'vid');
        report.diffs.push(...map.conflicts.splice(0));
        if (deferred) report.deferredDiffs = deferred;
        report.status = report.diffs.length ? 'failed' : deferred ? 'deferred' : report.compared.length ? 'passed' : 'uncompared';
        if (!report.compared.length) report.note ??= 'no stored result or shape block for this step';
      }
      parts.push({ steps, ids: Object.fromEntries(map.to) });
    }
  } finally { setIdSource(null); }
  const all = parts.flatMap(p => p.steps), count = (s: StepReport['status']) => all.filter(x => x.status === s).length;
  const passed = count('passed'), failed = count('failed'), deferred = count('deferred'), uncompared = count('uncompared');
  const ious = all.flatMap(s => Object.values(s.iou ?? {})), minIou = ious.length ? Math.min(...ious) : null;
  const status = failed ? 'failed' : deferred || uncompared || !all.length ? 'uncompared' : 'passed';
  const report = { version: 1, golden: 'G-04', status, blockBase: stored.blockBase, steps: all.length, passed, failed, deferred, uncompared, minIou, threshold: MIN_IOU,
    summary: `${passed} passed, ${failed} failed, ${deferred} deferred (T18 schema validation), ${uncompared} uncompared (T12 mask steps, frames, or no stored result); ${ious.length} shape block(s) compared, minimum IoU ${minIou ?? '-'}`,
    notCompared: 'the mask steps (T12), the frames of captureFrame (naming and plan.json not documented), and everything in a stored read except its shape blocks (shapeType, closed, anchors, handle layout, filled area)',
    parts };
  await atomicJson(out, 'report.json', report);
  return report;
}
