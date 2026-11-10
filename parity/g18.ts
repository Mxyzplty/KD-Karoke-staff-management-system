// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-18 --xapp-ref <dir> …`: replays the stored golden caption render-mode capture G-18 (agent tool results §12,
// stored 23 Oct 2026: five blocks of [speech 0–8 s + action 0–30 s] on one video track, each block captioned on its own caption
// track by `addCaptions` with no style, then one `editAllCaptionStyles {trackId, renderMode}` per track across the five render
// modes default / highlight / word-by-word / slide-up / slide-left; 39 stored calls) through the direct-call harness, one call at a
// time, as the served path runs it: the helper's schema check first (apps/helper/src/schemas.ts validate: a refusal there is
// INVALID_TOOL_INPUT and the tab never sees the call), then the tool. `addCaptions` reads each source's transcript / music state
// from `ctx.captionData`; the agent path loads that from the analysis store (captions/agent.ts), so the replay sets the same
// provider on the runtime from the word times of --plan (a Author-produced file in this harness's documented shape; the raw
// plan.json schema is not documented, so it is not parsed here).
// What is compared:
//   - every stored call result's success / error / code (the pass-fail parity: §12 "editAllCaptionStyles accepted all five render
//     modes"). Messages and data payloads carry Xapp ids and Cutframe's own wordings, so they are not compared (noted);
//   - each stored `context` read's caption tracks, by their item count and time ranges (§12: addCaptions made 12 caption items per
//     block), matched in start-time order (id-free: addCaptions has no stored result, so caption-item ids are not learnable);
//   - with --export (the authoritative G-18 check, §12 decision 3), Cutframe's export frames against the 1,203 stored frames in
//     frames/export/<mode>/ (parity/g18-export.ts; per-frame SSIM).
// Documented difference (reported, not failed): `viewItemDetails` on a caption returns no renderMode / render settings from Xapp;
// Cutframe returns them (§12 decision 2). Never compared: addCaptions / listCaptionTemplates result envelopes (Xapp stores none,
// notes Q4), frames/preview/ (the 25 captureFrame JPEGs), and everything in a stored read beyond the caption tracks above.
// Run by Author on D2 only; implementers test it on synthetic folders (parity/g18-synthetic.ts). The two fixtures' media values are
// the public manifest's (fixtures/Cutframe test fixtures (C).md), not read from the private reference.
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, inside, resolvedDestination } from './runner';
import type { Json } from './normalise';
import { callResult, contextL, contextOf, detailsOf, IdMap, isObj, learnCall, loadStored, type Diff, type G01Step } from './g01';
import { validate } from '../apps/helper/src/schemas';
import { createEditor } from '../apps/web/src/timeline/harness';
import { setIdSource } from '../apps/web/src/timeline/model';
import { TOOLS } from '../apps/web/src/timeline/tools';
import type { SourceData } from '../apps/web/src/captions/generation';
import type { Transcript } from '../apps/web/src/analysis/types';
import { type Asset, type AssetLink, type ProjectDocument, type RecordData } from '../apps/web/src/store/model';
import type { G18Export } from './g18-export';

type Rec = { [key: string]: Json };
/** The transcripts addCaptions replays with, keyed by Xapp asset id (the id --assets maps to a fixture). Author's own file,
 *  derived from the reference plan.json: its raw schema is not documented, so it is not parsed here. Word start / end are seconds
 *  (the addCaptions contract and §44.2's "2.96–4.34 s"). */
export type G18Source = { music?: boolean; totalDuration?: number; segments: { speaker?: number; words: { word: string; start: number; end: number }[] }[] };
export type G18Plan = { sources: Record<string, G18Source> };
export type G18Options = { calls: G01Step[][]; assets: Record<string, string>; plan: G18Plan; toolField: string; inputField: string; blockBase?: 0 | 1; output?: string; export?: G18Export };
type StepReport = { id: string; tool: string; status: 'passed' | 'failed' | 'uncompared'; compared: string[]; diffs: Diff[]; documentedDiffs?: Diff[]; note?: string };

const same = (a: Json | undefined, b: Json | undefined): boolean => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i]))
  : isObj(a) && isObj(b) ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b && same(a[k], b[k]))
  : a === b;

// ---- Fixture media (fixtures/Cutframe test fixtures (C).md: the two G-18 inputs; both 1280 × 534, 24 fps, AAC 44100).
const MEDIA: Record<string, { file: string; bytes: number; width: number; height: number; fps: number; ms: number }> = {
  speech: { file: 'tos-speech-45s.mp4', bytes: 8057475, width: 1280, height: 534, fps: 24, ms: 45000 },
  action: { file: 'tos-action-30s.mp4', bytes: 6789415, width: 1280, height: 534, fps: 24, ms: 30000 },
};
export function captionAssets(assets: Record<string, string>): { assets: Asset[]; links: AssetLink[] } {
  const out: { assets: Asset[]; links: AssetLink[] } = { assets: [], links: [] };
  for (const [xappId, name] of Object.entries(assets)) {
    const m = MEDIA[name];
    if (!m) throw Error(`--assets: unknown fixture '${name}' for ${xappId} (use ${Object.keys(MEDIA).join(' or ')})`);
    const id = `g18-${name}-${out.assets.length + 1}`;
    out.assets.push({ id, name: m.file, type: 'video', sizeBytes: m.bytes, mimeType: 'video/mp4', folderId: null, created_at: '', recorded_at: null, location: null, durationMs: m.ms,
      processing_status: 'ready', last_error_code: null,
      media: { container: 'mp4', mimeType: 'video/mp4', durationMs: m.ms, video: { displayWidth: m.width, displayHeight: m.height, codedWidth: m.width, codedHeight: m.height, fps: m.fps, rotation: 0 },
        audio: { codec: 'aac', sampleRate: 44100, channels: 2 }, image: null } } as unknown as Asset);
    // The stored inputs name assets by Xapp's project id, so that id is the link's agent id.
    out.links.push({ id: `g18:${id}`, projectId: 'g18', assetId: id, agent_id: xappId, content_type: 'video', added_at: '', deleted_at: null });
  }
  return out;
}

// ---- Transcripts → the runtime's captionData provider (what captions/agent.ts loads from the analysis store on the agent path).
function sourceData(src: G18Source): SourceData {
  const segments = src.segments.map((s, id) => ({ id, speaker: s.speaker ?? 0, start: s.words[0]?.start ?? 0, end: s.words.at(-1)?.end ?? 0, text: s.words.map(w => w.word).join(' '), words: s.words }));
  const total = src.totalDuration ?? (segments.length ? segments.at(-1)!.end : 0);
  const transcript: Transcript = { language: 'en', languages: ['en'], total_duration: total, segments };
  return { status: 'complete', transcript, music: src.music === true };
}
const NO_DATA: SourceData = { status: 'none', transcript: null, music: false };

// ---- The call result: the pass-fail parity only (success / error / code). Messages and data carry Xapp ids / Cutframe's own
// wordings (results §12 corrections), so they are not compared.
function compareCall(v: Rec, o: Rec, diffs: Diff[]) {
  const check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'call', path: p, expected: a ?? null, actual: b ?? null }); };
  check('success', v.success, o.success);
  if ('error' in v || 'error' in o) check('error', v.error, o.error);
  if ('code' in v) check('code', v.code, o.code);
}

// ---- Caption tracks of a context read, in start-time order (id-free). A collapsed Xapp caption track carries itemCount / ranges;
// an expanded one carries items. contextL gives Cutframe's caption tracks the same itemCount / ranges.
type CapTrack = { count: number; ranges: Json | null };
const firstStart = (t: CapTrack) => Array.isArray(t.ranges) && isObj(t.ranges[0]) ? Number((t.ranges[0] as Rec).from ?? (t.ranges[0] as Rec).start ?? 0) : 0;
function captionTracksOf(ctx: Rec | undefined): CapTrack[] {
  const tracks = ctx && isObj(ctx.tracks) ? ctx.tracks as Rec : {};
  const out: CapTrack[] = [];
  for (const row of Object.values(tracks)) {
    if (!isObj(row) || row.kind !== 'caption') continue;
    const count = typeof row.itemCount === 'number' ? row.itemCount : Array.isArray(row.items) ? row.items.length : 0;
    if (!count) continue;
    out.push({ count, ranges: Array.isArray(row.ranges) ? row.ranges : null });
  }
  return out.sort((a, b) => firstStart(a) - firstStart(b));
}
function compareCaptionTracks(stored: CapTrack[], ours: CapTrack[], diffs: Diff[]) {
  if (stored.length !== ours.length) { diffs.push({ part: 'ctx', path: 'context.captionTracks.length', expected: stored.length, actual: ours.length, note: 'number of non-empty caption tracks differs' }); return; }
  stored.forEach((s, i) => {
    const o = ours[i];
    if (s.count !== o.count) diffs.push({ part: 'ctx', path: `context.captionTracks[${i}].itemCount`, expected: s.count, actual: o.count });
    if (s.ranges !== null && o.ranges !== null && !same(s.ranges, o.ranges)) diffs.push({ part: 'ctx', path: `context.captionTracks[${i}].ranges`, expected: s.ranges, actual: o.ranges });
  });
}
/** §12 decision 2: Xapp's viewItemDetails hides renderMode; Cutframe returns it. A stored caption detail that carries a renderMode
 *  contradicts §12 and is a failure; otherwise the difference is recorded, not failed. */
const CAPTION_RENDER_KEYS = ['renderMode', 'renderConfig', 'highlightColor'];
function viewItemDocumented(details: Rec[], diffs: Diff[], documented: Diff[]) {
  for (const d of details.filter(d => d.type === 'caption')) {
    const leaked = CAPTION_RENDER_KEYS.filter(k => k in d || (isObj(d.properties) && k in d.properties));
    if (leaked.length) diffs.push({ part: 'vid', path: `viewItemDetails.${String(d.id)}`, expected: 'no render settings (results §12)', actual: leaked, note: 'the stored Xapp read exposes a render setting §12 says it hides' });
  }
  if (details.some(d => d.type === 'caption')) documented.push({ part: 'vid', path: 'viewItemDetails.renderMode', expected: null, actual: 'renderMode and render settings', note: 'documented improvement: Cutframe\'s viewItemDetails returns the caption renderMode; Xapp hides it (results §12 decision 2)' });
}

/** Xapp track id → Cutframe track id by position in a context read (both order tracks the same way), so a later
 *  editAllCaptionStyles / addCaptions trackId remaps even when the track was made by a call with no stored result. */
function learnTracks(map: IdMap, stored: Rec | undefined, ours: Rec) {
  const vt = stored && isObj(stored.tracks) ? Object.entries(stored.tracks as Rec) : [], ot = Object.entries(ours.tracks as Rec);
  if (!vt.length || vt.length !== ot.length) return;
  vt.forEach(([id, row], i) => { if (!map.to.has(id) && !map.from.has(ot[i][0]) && isObj(row) && row.kind === (ot[i][1] as Rec).kind) map.pair(id, ot[i][0], `ctx.tracks[${i}]`); });
}

// ---- Replay.
const READS = new Set(['context', 'viewItemDetails']);
const NO_ENVELOPE = new Set(['addCaptions', 'listCaptionTemplates']);
const exportNote = (tool: string, on: boolean) => tool === 'exportProject'
  ? on ? 'the state here is exported by Cutframe and compared with frames/export/<mode>/ (report.export)' : 'the export is not compared: run with --export (parity/g18-export.ts)'
  : 'the export is compared once, at the exportProject step';
export async function runG18(referenceDir: string, o: G18Options) {
  if (!o.toolField || !o.inputField) throw Error('--tool-field and --input-field are required (the stored record schema is not documented)');
  for (const xappId of Object.keys(o.assets)) if (!o.plan.sources[xappId]) throw Error(`--plan has no source for asset '${xappId}'; every --assets entry is captioned in G-18 (results §12), so each needs its word times`);
  const stored = await loadStored(referenceDir, o.blockBase);
  const out = await resolvedDestination(path.resolve(o.output ?? 'parity-reports/g18')), base = await realpath(referenceDir);
  if (inside(base, out) || inside(out, base)) throw Error('Output/reference directories overlap or alias');
  await mkdir(out, { recursive: true });
  const { assets, links } = captionAssets(o.assets);
  const byAsset = new Map<string, SourceData>();
  // Keyed by both the Cutframe asset id and the Xapp agent id, so it resolves whichever addMedia stored on the item.
  for (const link of links) { const src = o.plan.sources[link.agent_id]; if (src) { const d = sourceData(src); byAsset.set(link.assetId, d); byAsset.set(link.agent_id, d); } }
  const provider = (assetId: string): SourceData => byAsset.get(assetId) ?? NO_DATA;
  const parts: { steps: StepReport[] }[] = [];
  let n = 0, exported: { doc: ProjectDocument; at: string } | undefined;
  setIdSource(() => String(++n).padStart(6, '0'));
  try {
    for (const calls of o.calls) {
      const e = createEditor(undefined, { assets, links }), map = new IdMap(), known = new Set<string>(), steps: StepReport[] = [];
      e.runtime.tools.captionData = provider;
      const remember = () => [...e.doc.tracks, ...e.doc.items].forEach(x => known.add(String(x.id)));
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
          if (own && tool === 'context') { const ourCtx = contextL(e.doc); learnTracks(map, contextOf(own), ourCtx); compareCaptionTracks(captionTracksOf(contextOf(own)), captionTracksOf(ourCtx), report.diffs); report.compared.push('context(caption tracks)'); }
          else if (own) { viewItemDocumented(detailsOf(own), report.diffs, documented); report.compared.push('viewItemDetails(no render settings in Xapp; documented difference)'); }
        } else if (!TOOLS[tool]) {
          if (tool === 'exportProject') exported = { doc: structuredClone(e.doc), at: `step ${id} (exportProject)` };
          report.status = 'uncompared';
          report.note = `not replayed: '${tool}' is not a direct-call tool; ${tool === 'exportProject' || tool === 'getExportStatus' ? exportNote(tool, !!o.export) : 'its owning ticket compares it'}`;
          continue;
        } else {
          const args = map.input(input) as RecordData, ours = (validate(tool, args) ?? e.call(tool, args)) as unknown as Rec, vCall = own ? callResult(own) : undefined;
          remember();
          if (NO_ENVELOPE.has(tool)) report.note = `run, result not compared: Xapp stores no ${tool} result envelope (notes Q4); its effect is checked by the following reads and the export frames`;
          else if (vCall) { learnCall(map, vCall, ours, known); compareCall(vCall as Rec, ours, report.diffs); report.compared.push('call(success/error/code)'); }
        }
        report.diffs.push(...map.conflicts.splice(0));
        if (documented.length) report.documentedDiffs = documented;
        report.status = report.diffs.length ? 'failed' : report.compared.length ? 'passed' : 'uncompared';
        if (!report.compared.length) report.note ??= 'no stored result for this step';
      }
      parts.push({ steps });
      if (o.export && !exported && parts.length === o.calls.length) exported = { doc: structuredClone(e.doc), at: 'the end of the replay (no exportProject step)' };
    }
  } finally { setIdSource(null); }
  const all = parts.flatMap(p => p.steps), count = (s: StepReport['status']) => all.filter(x => x.status === s).length;
  const passed = count('passed'), failed = count('failed'), uncompared = count('uncompared'), documented = all.filter(x => x.documentedDiffs).length;
  const ex = o.export && exported ? { at: exported.at, ...await o.export(exported.doc, exported.at, out) } : undefined;
  const status = failed || ex?.diffs.length ? 'failed' : uncompared || !all.length ? 'uncompared' : 'passed';
  const report = { version: 1, golden: 'G-18', status, blockBase: stored.blockBase, steps: all.length, passed, failed, uncompared, documented,
    summary: `${passed} passed, ${failed} failed, ${uncompared} uncompared (addCaptions / listCaptionTemplates envelopes, the export steps, or no stored result); ${documented} step(s) carry documented differences`
      + (ex ? `; export at ${ex.at}: ${ex.diffs.length ? `${ex.diffs.length} difference(s)` : 'passed'}` : o.export ? '' : '; export not compared (no --export)'),
    notCompared: (ex ? '' : 'frames/export/<mode>/ and exports/ (run with --export), ') + 'frames/preview/ (the 25 captureFrame JPEGs), the addCaptions / listCaptionTemplates result envelopes (Xapp stores none, notes Q4), and messages / data payloads (Xapp ids and Cutframe\'s own wordings)',
    ...(ex ? { export: { at: ex.at, status: ex.diffs.length ? 'failed' : 'passed', diffs: ex.diffs, ...(ex.summary as Rec) } } : {}),
    parts };
  await atomicJson(out, 'report.json', report);
  return report;
}
