// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-08 --xapp-ref <dir> …`: replays the stored golden transitions capture G-08 (agent tool results §11: the
// 27-call matrix t01–t27, probes p01–p07, refusals e01–e08, and the setup calls that build the 33-clip timeline; tickets T11
// "Oracle") through the direct-call harness, one call at a time, as the served path runs it: the helper's schema check first
// (apps/helper/src/schemas.ts validate: a refusal there is INVALID_TOOL_INPUT and the tab never sees the call), then the tool.
// After every step it compares the call result with `results/<id>.json`: success, error, code, message, details.errors[].path
// / code, `data.transition` (kind, durationSeconds, alignment, direction, params; results §2) and `timelineChanges.transitions`
// (created / updated / deleted, each entry's stored fields). Transition ids are learnt from timelineChanges. A stored read
// (context, viewItemDetails) is checked for §11's rule that no transition is visible to the reads, on the stored side and in
// Cutframe's context. With --export (T11 integration round), the state at the exportProject step is exported by Cutframe and
// compared with frames/export/ (parity/g08-export.ts); without it the export is not compared. Never compared here: the preview
// captureFrame JPEGs frames/preview/ (Xapp's preview hard-cuts, Cutframe renders transitions: §11 decision 1), and everything
// else in a stored read. Run by Author on D2 only; implementers test it on synthetic folders (parity/g08-synthetic.ts).
// Documented difference (reported, not failed): `data.transition.id` (results §2 Cutframe note: Cutframe returns the id there).
// Messages Cutframe words itself (T11 notes, own wordings) fail until the stored text is adopted.
// Provisional choices, not Xapp parity: the S2c fixture's media values (below); a stored item id not learnt from a call is
// not guessed (the step reports it).
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, inside, resolvedDestination } from './runner';
import type { Json } from './normalise';
import { callResult, contextL, findAll, IdMap, isObj, jsonBlocks, learnCall, loadStored, type Diff, type G01Step } from './g01';
import { validate } from '../apps/helper/src/schemas';
import { createEditor } from '../apps/web/src/timeline/harness';
import { setIdSource } from '../apps/web/src/timeline/model';
import { TOOLS } from '../apps/web/src/timeline/tools';
import { emptyDocument, type Asset, type AssetLink, type ProjectDocument, type RecordData } from '../apps/web/src/store/model';
import type { G08Export } from './g08-export';

type Rec = { [key: string]: Json };
/** `canvas`: the replay's starting canvas, the editor's new-project 1080 × 1920 when absent. Not a CLI flag: G-08 starts on a new
 *  project; the synthetic export test (tests/t11-g08-export.test.ts) passes a small 9:16 canvas, because the oracle's cost scales
 *  with pixels (T11 integration round, coordinator decision). */
export type G08Options = { calls: G01Step[][]; assets: Record<string, string>; toolField: string; inputField: string; blockBase?: 0 | 1; output?: string; export?: G08Export;
  canvas?: { width: number; height: number } };
type StepReport = { id: string; tool: string; status: 'passed' | 'failed' | 'uncompared'; compared: string[]; diffs: Diff[]; documentedDiffs?: Diff[]; note?: string };

const same = (a: Json | undefined, b: Json | undefined): boolean => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i]))
  : isObj(a) && isObj(b) ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b && same(a[k], b[k]))
  : a === b;
const first = (v: Json, key: string): Json | undefined => findAll(v, o => key in o)[0]?.[key];

// ---- Fixture media (results §11: S1 and S2c). S1 from fixtures/Cutframe test fixtures (C).md (the G-01 entry). S2c is the centre
// 9:16 crop of S2, described only in the private fixture.md: its values here are provisional, not read from it (S2's 10 s, 30 fps
// and AAC track; 1080 × 1920; no file name or size). Only the clip lengths reach a transition; the stored setup results show them.
const MEDIA: Record<string, { file: string; bytes: number; width: number; height: number; fps: number; ms: number; audio: boolean }> = {
  S1: { file: 'S1-framecount-1080x1920-30fps-10s.mp4', bytes: 13871655, width: 1080, height: 1920, fps: 30, ms: 10000, audio: false },
  S2c: { file: 'S2c.mp4', bytes: 0, width: 1080, height: 1920, fps: 30, ms: 10000, audio: true },
};
export function transitionAssets(assets: Record<string, string>): { assets: Asset[]; links: AssetLink[] } {
  const out: { assets: Asset[]; links: AssetLink[] } = { assets: [], links: [] };
  for (const [xappId, name] of Object.entries(assets)) {
    const m = MEDIA[name];
    if (!m) throw Error(`--assets: unknown fixture '${name}' for ${xappId} (use ${Object.keys(MEDIA).join(' or ')})`);
    const id = `g08-${name}-${out.assets.length + 1}`;
    out.assets.push({ id, name: m.file, type: 'video', sizeBytes: m.bytes, mimeType: 'video/mp4', folderId: null, created_at: '', recorded_at: null, location: null, durationMs: m.ms,
      processing_status: 'ready', last_error_code: null,
      media: { container: 'mp4', mimeType: 'video/mp4', durationMs: m.ms, video: { displayWidth: m.width, displayHeight: m.height, codedWidth: m.width, codedHeight: m.height, fps: m.fps, rotation: 0 },
        audio: m.audio ? { codec: 'aac', sampleRate: 48000, channels: 2 } : null, image: null } } as unknown as Asset);
    out.links.push({ id: `g08:${id}`, projectId: 'g08', assetId: id, agent_id: xappId, content_type: 'video', added_at: '', deleted_at: null });
  }
  return out;
}

// ---- The call result.
const schemaErrors = (x: Rec) => { const d = first(x, 'details'); return isObj(d) && Array.isArray(d.errors) ? d.errors.map(e => isObj(e) ? { path: e.path ?? null, code: e.code ?? null } : e) : undefined; };
const changes = (x: Rec) => { const t = first(x, 'timelineChanges'); return isObj(t) && isObj(t.transitions) ? t.transitions : undefined; };
function compareCall(v: Rec, o: Rec, diffs: Diff[], documented: Diff[]) {
  const check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'call', path: p, expected: a ?? null, actual: b ?? null }); };
  check('success', v.success, o.success);
  if ('error' in v || 'error' in o) check('error', v.error, o.error);
  if ('code' in v) check('code', v.code, o.code);
  // As G-01 / G-07: compared where Xapp's result has one. Cutframe's own-worded texts (T11 notes) fail here until the stored text is adopted.
  if ('message' in v) check('message', v.message, o.message);
  const errors = schemaErrors(v);
  if (errors) check('details.errors', errors, schemaErrors(o));
  // data.transition: the stored fields; Cutframe's added `id` is a documented improvement (results §2 Cutframe note).
  const vt = first(v, 'transition'), ot = first(o, 'transition');
  if (vt !== undefined || ot !== undefined) {
    if (!isObj(vt) || !isObj(ot)) check('data.transition', vt, ot);
    else {
      for (const k of new Set([...Object.keys(vt), ...Object.keys(ot)].filter(k => k !== 'id'))) check(`data.transition.${k}`, vt[k], ot[k]);
      if ('id' in ot && !('id' in vt)) documented.push({ part: 'call', path: 'data.transition.id', expected: null, actual: ot.id, note: 'documented improvement: Cutframe returns the transition id in data (results §2 Cutframe note)' });
    }
  }
  // timelineChanges.transitions where Xapp's result has a timelineChanges (none there = no transition changed): each list in
  // order, each stored entry's fields.
  if (isObj(first(v, 'timelineChanges'))) {
    const vc = changes(v), oc = changes(o);
    for (const k of ['created', 'updated', 'deleted']) {
      const a = (vc && Array.isArray(vc[k]) ? vc[k] : []) as Json[], b = (oc && Array.isArray(oc[k]) ? oc[k] : []) as Json[];
      if (a.length !== b.length) { check(`timelineChanges.transitions.${k}.length`, a.length, b.length); continue; }
      a.forEach((e, i) => { const u = b[i]; if (isObj(e) && isObj(u)) for (const f of Object.keys(e)) check(`timelineChanges.transitions.${k}[${i}].${f}`, e[f], u[f]); else check(`timelineChanges.transitions.${k}[${i}]`, e, u); });
    }
  }
}
/** §11: no transition is visible to context or viewItemDetails. */
const showsTransition = (v: Json) => findAll(v, o => 'transition' in o || 'transitions' in o || 'transitionIn' in o || 'transitionOut' in o).length > 0;

// ---- Replay.
const READS = new Set(['context', 'viewItemDetails']);
const OWNERS: Record<string, string> = { captureFrame: 'Xapp\'s preview hard-cuts and Cutframe renders transitions (results §11 decision 1); this replay does not compare the preview frames' };
const exportNote = (tool: string, on: boolean) => tool === 'exportProject'
  ? on ? 'the state here is exported by Cutframe and compared with frames/export/ (report.export)' : 'the export is not compared: run with --export (parity/g08-export.ts)'
  : 'the export is compared once, at the exportProject step';
export async function runG08(referenceDir: string, o: G08Options) {
  if (!o.toolField || !o.inputField) throw Error('--tool-field and --input-field are required (the stored record schema is not documented)');
  const stored = await loadStored(referenceDir, o.blockBase);
  const out = await resolvedDestination(path.resolve(o.output ?? 'parity-reports/g08')), base = await realpath(referenceDir);
  if (inside(base, out) || inside(out, base)) throw Error('Output/reference directories overlap or alias');
  await mkdir(out, { recursive: true });
  const { assets, links } = transitionAssets(o.assets);
  const parts: { steps: StepReport[]; ids: Record<string, string> }[] = [];
  let n = 0, exported: { doc: ProjectDocument; at: string } | undefined;
  setIdSource(() => String(++n).padStart(6, '0'));
  try {
    for (const calls of o.calls) {
      const e = createEditor(o.canvas ? { ...emptyDocument(), size: { ...o.canvas } } : undefined, { assets, links }), map = new IdMap(), known = new Set<string>(), steps: StepReport[] = [];
      const remember = () => [...e.doc.tracks, ...e.doc.items, ...e.doc.transitions ?? []].forEach(x => known.add(String(x.id)));
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
        const own = typeof step === 'string' ? stored.blocks(id) : undefined;
        if (READS.has(tool)) {
          if (own) {
            const theirs = jsonBlocks(own);
            if (theirs.some(showsTransition)) report.diffs.push({ part: 'vid', path: tool, expected: 'no transition in the read (results §11)', actual: 'the stored read shows a transition', note: 'stored read differs from agent tool results §11' });
            if (showsTransition(contextL(e.doc))) report.diffs.push({ part: 'vid', path: 'context', expected: 'no transition in the read (results §11)', actual: 'Cutframe\'s context shows a transition' });
            report.compared.push(`call(${tool}: no transition)`);
          }
        } else if (!TOOLS[tool]) {
          if (tool === 'exportProject') exported = { doc: structuredClone(e.doc), at: `step ${id} (exportProject)` };
          report.status = 'uncompared';
          report.note = `not replayed: '${tool}' is not a direct-call tool; ${OWNERS[tool] ?? (tool === 'exportProject' || tool === 'getExportStatus' ? exportNote(tool, !!o.export) : 'its owning ticket compares it')}`;
          continue;
        }
        else {
          const args = map.input(input) as RecordData, ours = (validate(tool, args) ?? e.call(tool, args)) as unknown as Rec, vCall = own ? callResult(own) : undefined;
          remember();
          if (vCall) { learnCall(map, vCall, ours, known); report.compared.push('call'); compareCall(map.translate(vCall) as Rec, ours, report.diffs, documented); }
        }
        report.diffs.push(...map.conflicts.splice(0));
        if (documented.length) report.documentedDiffs = documented;
        report.status = report.diffs.length ? 'failed' : report.compared.length ? 'passed' : 'uncompared';
        if (!report.compared.length) report.note ??= 'no stored result for this step';
      }
      parts.push({ steps, ids: Object.fromEntries(map.to) });
      if (o.export && !exported && parts.length === o.calls.length) exported = { doc: structuredClone(e.doc), at: 'the end of the replay (no exportProject step)' };
    }
  } finally { setIdSource(null); }
  const all = parts.flatMap(p => p.steps), count = (s: StepReport['status']) => all.filter(x => x.status === s).length;
  const passed = count('passed'), failed = count('failed'), uncompared = count('uncompared'), documented = all.filter(x => x.documentedDiffs).length;
  const ex = o.export && exported ? { at: exported.at, ...await o.export(exported.doc, exported.at, out) } : undefined;
  const status = failed || ex?.diffs.length ? 'failed' : uncompared || !all.length ? 'uncompared' : 'passed';
  const report = { version: 1, golden: 'G-08', status, blockBase: stored.blockBase, steps: all.length, passed, failed, uncompared, documented,
    summary: `${passed} passed, ${failed} failed, ${uncompared} uncompared (preview frames, the export steps, or no stored result); ${documented} step(s) carry documented differences`
      + (ex ? `; export at ${ex.at}: ${ex.diffs.length ? `${ex.diffs.length} difference(s)` : 'passed'}` : o.export ? '' : '; export not compared (no --export)'),
    notCompared: (ex ? '' : 'frames/export/ and exports/ (run with --export), ') + 'frames/preview/ (Xapp\'s preview hard-cuts; Cutframe renders transitions, results §11 decision 1), and everything in a stored read except the absence of transitions',
    ...(ex ? { export: { at: ex.at, status: ex.diffs.length ? 'failed' : 'passed', diffs: ex.diffs, ...(ex.summary as Rec) } } : {}),
    parts };
  await atomicJson(out, 'report.json', report);
  return report;
}
