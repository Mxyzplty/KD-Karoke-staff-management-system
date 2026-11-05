// SPDX-License-Identifier: AGPL-3.0-only
// `parity --golden G-01 --xapp-ref <dir> …`: replays the stored golden editing sequence G-01 (agent tool results §5;
// tickets T03 "Golden editing sequence") through the T03 direct-call harness, one call at a time, and after every
// step compares the call result with `results/<id>.json`, the `context` read with `<id>.ctx.json` and the
// `viewItemDetails` read with `<id>.vid.json`. Run by Author on D2 only; implementers test it on synthetic folders
// (parity/g01-synthetic.ts). The docs leave the stored record's tool / input field names, the call order, the block
// numbering base and the asset ids open: each is an explicit option, never a guess (the T00 reference.ts rule).
import { mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, inside, resolvedDestination } from './runner';
import type { Json } from './normalise';
import { createEditor } from '../apps/web/src/timeline/harness';
import { item, itemsOn, setIdSource, stack, track } from '../apps/web/src/timeline/model';
import { groupSummary, trackSummary } from '../apps/web/src/timeline/tracks';
import { TOOLS } from '../apps/web/src/timeline/tools';
import { statics } from '../apps/web/src/timeline/properties';
import { layerEntries } from '../apps/web/src/editor/geometry';
import type { Asset, AssetLink, ProjectDocument, RecordData } from '../apps/web/src/store/model';

type Rec = { [key: string]: Json };
/** A stored call id (tool and input read from its record), or an inline step that Xapp ran outside MCP (S41–S43). */
export type G01Step = string | { id: string; tool: string; input: Json };
export type G01Options = { calls: G01Step[][]; assets: Record<string, string>; toolField: string; inputField: string; blockBase?: 0 | 1; output?: string };
export type Diff = { part: 'call' | 'ctx' | 'vid' | 'map' | 'frame'; path: string; expected?: Json; actual?: Json; note?: string };

export const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const BLOCK = /(?:^|\r?\n)<<<BLOCK>>>(?:\r?\n|$)/, REF = /^@@SAME:(.+)#(\d+)$/;
const ref = (b: string) => b.trim().match(REF);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Stored-reference loader (§5 "Reading the stored files").
/** Every `results/*.json` record, keyed by file name without `.json` ("S12", "S12.ctx", "S12.vid"), with `@@SAME` block
 *  references and same-as files resolved recursively. The block base is detected from the folder or given. */
export async function loadStored(dir: string, blockBase?: 0 | 1) {
  const base = await realpath(dir), folder = await realpath(path.join(base, 'results')).catch(() => { throw Error(`No results/ folder in ${dir}`); });
  if (!inside(base, folder)) throw Error('results/ escapes the reference directory');
  const raw = new Map<string, Rec>();
  for (const name of (await readdir(folder)).filter(n => n.endsWith('.json')).sort()) {
    const file = await realpath(path.join(folder, name));
    if (!inside(folder, file)) throw Error(`Stored file escapes results/: ${name}`);
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!isObj(value)) throw Error(`Stored file is not a JSON object: ${name}`);
    raw.set(name.slice(0, -5), value);
  }
  const key = (id: string, from: string) => { const k = id.replace(/\.json$/, ''); if (!raw.has(k)) throw Error(`${from}: @@SAME reference to unknown file ${id}`); return k; };
  const own = (r: Rec): string[] | null => typeof r.result_text === 'string' && r.result_text.length ? r.result_text.split(BLOCK)
    : Array.isArray(r.result_blocks) && r.result_blocks.length ? r.result_blocks.map(b => typeof b === 'string' ? b : isObj(b) && typeof b.text === 'string' ? b.text : JSON.stringify(b)) : null;
  // A file with no result content whose `notes` name exactly one other stored file takes that file's result.
  const sameAs = (k: string): string => {
    const notes = raw.get(k)!.notes, hits = typeof notes === 'string' ? [...raw.keys()].filter(s => s !== k && new RegExp(`(?<![\\w.])${escape(s)}(?![\\w]|\\.\\w)`).test(notes)) : [];
    if (hits.length !== 1) throw Error(`${k}: no result content and its notes name ${hits.length ? `several files (${hits.join(', ')})` : 'no stored file'}`);
    return hits[0];
  };
  const blocksOf = (k: string, chain: string[] = []): string[] => {
    if (chain.includes(k)) throw Error(`Same-as cycle: ${[...chain, k].join(' → ')}`);
    return own(raw.get(k)!) ?? blocksOf(sameAs(k), [...chain, k]);
  };
  const refs = [...raw.keys()].flatMap(k => (own(raw.get(k)!) ?? []).flatMap(b => { const m = ref(b); return m ? [{ to: key(m[1], k), n: Number(m[2]) }] : []; }));
  let zero = false, one = false;
  for (const r of refs) { const count = blocksOf(r.to).length; if (r.n === 0) zero = true; if (r.n === count) one = true; }
  if (blockBase === undefined && zero && one) throw Error('@@SAME block numbers are contradictory (both #0 and #<block count> occur); check the stored folder');
  const offset = blockBase ?? (zero ? 0 : one ? 1 : refs.length ? undefined : 0);
  if (offset === undefined) throw Error('@@SAME block numbering base cannot be told from this folder; pass --block-base 0 or --block-base 1');
  const block = (k: string, n: number, seen: Set<string>): string => {
    const list = blocksOf(k), b = list[n];
    if (b === undefined) throw Error(`@@SAME block #${n + offset} is out of range for ${k} (${list.length} blocks)`);
    const m = ref(b);
    if (!m) return b;
    if (seen.has(`${k}#${n}`)) throw Error(`@@SAME cycle at ${k}#${n + offset}`);
    seen.add(`${k}#${n}`);
    return block(key(m[1], k), Number(m[2]) - offset, seen);
  };
  const resolved = new Map<string, string[]>();
  const blocks = (k: string) => { if (!resolved.has(k)) resolved.set(k, blocksOf(k).map((_, n) => block(k, n, new Set()))); return resolved.get(k)!; };
  return { files: [...raw.keys()], record: (k: string) => raw.get(k), has: (k: string) => raw.has(k), blocks, blockBase: offset as 0 | 1 };
}
export type Stored = Awaited<ReturnType<typeof loadStored>>;

export const jsonBlocks = (blocks: string[]): Json[] => blocks.flatMap(b => { try { return [JSON.parse(b) as Json]; } catch { return []; } });
export const findAll = (v: Json, test: (o: Rec) => boolean, out: Rec[] = []): Rec[] => {
  if (isObj(v)) { if (test(v)) out.push(v); Object.values(v).forEach(c => findAll(c, test, out)); }
  else if (Array.isArray(v)) v.forEach(c => findAll(c, test, out));
  return out;
};
/** The call result: the first JSON block carrying a boolean `success`. */
export const callResult = (blocks: string[]) => jsonBlocks(blocks).find(v => isObj(v) && typeof v.success === 'boolean') as Rec | undefined;
/** The context projection: the first object holding `tracks` and `layerOrder`. */
export const contextOf = (blocks: string[]) => jsonBlocks(blocks).flatMap(v => findAll(v, o => isObj(o.tracks) && Array.isArray(o.layerOrder)))[0];
/** viewItemDetails Details objects (single or batch envelope). */
export const detailsOf = (blocks: string[]) => jsonBlocks(blocks).flatMap(v => findAll(v, o => typeof o.id === 'string' && typeof o.startTime === 'number' && typeof o.endTime === 'number' && typeof o.layer === 'string'));

// ---- Cutframe projections compared against the stored reads (results §2 `context` layout L, `viewItemDetails`).
const captionRanges = (items: { start: number; end: number }[]) => items.reduce<{ start: number; end: number }[]>((out, i) => {
  const last = out[out.length - 1];
  if (last && i.start - last.end <= 1.5 + 1e-9) last.end = Math.max(last.end, i.end); else out.push({ start: i.start, end: i.end });
  return out;
}, []);
export function contextL(doc: ProjectDocument): Rec {
  const tracks: Rec = {};
  for (const id of [...stack(doc)].reverse()) {
    const s = trackSummary(doc, id), items = itemsOn(doc, id).map(i => ({ id: i.id, start: r3(i.display.from / 1000), end: r3(i.display.to / 1000) }));
    const row: Rec = { name: s.name, kind: s.kind, order: s.order, layerIndex: s.layerIndex, ...(s.layer ? { layer: s.layer } : {}), muted: s.muted, solo: s.solo, locked: s.locked, hidden: s.hidden, volume: s.volume, type: s.kind, items };
    if (s.kind === 'caption' && items.length) Object.assign(row, { itemCount: items.length, collapsed: true, ranges: captionRanges(items) });
    tracks[id] = row;
  }
  const groups: Rec = {};
  for (const id of Object.keys(doc.groups)) { const g = groupSummary(doc, id); groups[id] = { name: g.name, hidden: g.hidden, locked: g.locked, trackIds: g.trackIds, bounds: g.bounds }; }
  const markers = [...doc.markers].sort((a, b) => a.timeMs - b.timeMs).map(m => ({ time: r3(m.timeMs / 1000), ...(m.label ? { label: m.label } : {}) }));
  return { duration: r3(doc.duration / 1000), fps: doc.fps, canvasSize: { ...doc.size }, tracks, layerOrder: layerEntries(doc).map(e => ({ id: e.id, type: e.type })), groups, ...(markers.length ? { markers } : {}) };
}

// ---- Comparison helpers.
const same = (a: Json | undefined, b: Json | undefined): boolean => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i]))
  : isObj(a) && isObj(b) ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b && same(a[k], b[k]))
  : a === b;
const sortIds = (v: Json | undefined) => Array.isArray(v) && v.every(x => typeof x === 'string') ? [...v].sort() : v;
/** Compared data fields (tickets T03 G-01), wherever Xapp's result carries them; id lists compare as sets. */
const CALL_FIELDS = new Set(['shiftedItemIds', 'appliedDeltaSeconds', 'bounds', 'trackIds', 'moved', 'deletedTrackIds']);
const ID_LISTS = new Set(['shiftedItemIds', 'deletedTrackIds']);
const ID_KEY = /(^id|Id|Ids|^layer)$/;

/** Xapp ids ↔ Cutframe ids, learnt by creation order: first from the parallel structure of each call result, then by
 *  position from the `context` / `viewItemDetails` reads (tracks top-to-bottom, items by start, groups by members). */
export class IdMap {
  readonly to = new Map<string, string>(); readonly from = new Map<string, string>(); readonly conflicts: Diff[] = [];
  pair(xapp: string, ours: string, where: string) {
    if (this.to.get(xapp) === ours) return;
    if (this.to.has(xapp) || this.from.has(ours)) { this.conflicts.push({ part: 'map', path: where, expected: xapp, actual: ours, note: `id already mapped (${xapp} → ${this.to.get(xapp) ?? '-'}, ${this.from.get(ours) ?? '-'} → ${ours})` }); return; }
    this.to.set(xapp, ours); this.from.set(ours, xapp);
  }
  /** Xapp-side JSON in Cutframe id space: exact ids, ids inside text and object keys. */
  translate(v: Json): Json {
    const ids = [...this.to.keys()].sort((a, b) => b.length - a.length), re = ids.length ? new RegExp(`(?<![\\w-])(${ids.map(escape).join('|')})(?![\\w-])`, 'g') : null;
    const text = (s: string) => this.to.get(s) ?? (re ? s.replace(re, m => this.to.get(m)!) : s);
    const walk = (x: Json): Json => typeof x === 'string' ? text(x) : Array.isArray(x) ? x.map(walk) : isObj(x) ? Object.fromEntries(Object.entries(x).map(([k, c]) => [this.to.get(k) ?? k, walk(c)])) : x;
    return walk(v);
  }
  /** Stored inputs: only whole-string ids are replaced. */
  input(v: Json): Json { return typeof v === 'string' ? this.to.get(v) ?? v : Array.isArray(v) ? v.map(x => this.input(x)) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, c]) => [k, this.input(c)])) : v; }
}
export function learnCall(map: IdMap, v: Json | undefined, o: Json | undefined, known: Set<string>, at = '', key = '') {
  if (typeof v === 'string' && typeof o === 'string') { if (ID_KEY.test(key) && known.has(o) && !map.to.has(v) && !map.from.has(o)) map.pair(v, o, `call${at}`); }
  else if (Array.isArray(v) && Array.isArray(o)) v.forEach((x, i) => learnCall(map, x, o[i], known, `${at}[${i}]`, key));
  else if (isObj(v) && isObj(o)) for (const k of Object.keys(v)) if (k in o) learnCall(map, v[k], o[k], known, `${at}.${k}`, k);
}
function learnContext(map: IdMap, v: Rec, o: Rec) {
  const vt = Object.entries(v.tracks as Rec), ot = Object.entries(o.tracks as Rec);
  if (vt.length === ot.length) vt.forEach(([id, row], i) => { if (!map.to.has(id) && !map.from.has(ot[i][0]) && isObj(row) && row.kind === (ot[i][1] as Rec).kind) map.pair(id, ot[i][0], `ctx.tracks[${i}]`); });
  for (const [id, row] of vt) {
    const mine = map.to.get(id), ours = mine ? (o.tracks as Rec)[mine] : undefined;
    if (!isObj(row) || !isObj(ours) || !Array.isArray(row.items) || !Array.isArray(ours.items) || row.items.length !== ours.items.length) continue;
    const a = [...row.items as Rec[]].sort((x, y) => (x.start as number) - (y.start as number)), b = ours.items as Rec[];
    a.forEach((x, i) => { if (typeof x.id === 'string' && !map.to.has(x.id) && !map.from.has(b[i].id as string)) map.pair(x.id, b[i].id as string, `ctx.tracks.${id}.items[${i}]`); });
  }
  for (const [id, g] of Object.entries(v.groups as Rec)) {
    if (map.to.has(id) || !isObj(g)) continue;
    const members = JSON.stringify((map.translate(g.trackIds ?? []) as string[]).slice().sort());
    const hit = Object.entries(o.groups as Rec).find(([oid, og]) => !map.from.has(oid) && JSON.stringify([...((og as Rec).trackIds as string[])].sort()) === members);
    if (hit) map.pair(id, hit[0], `ctx.groups.${id}`);
  }
}
function learnDetails(map: IdMap, details: Rec[], doc: ProjectDocument) {
  for (const d of details) {
    if (map.to.has(d.id as string)) continue;
    const t = map.to.get(d.layer as string), hits = t ? itemsOn(doc, t).filter(i => !map.from.has(i.id) && Math.abs(i.display.from / 1000 - (d.startTime as number)) <= 1e-6 && Math.abs(i.display.to / 1000 - (d.endTime as number)) <= 1e-6) : [];
    if (hits.length === 1) map.pair(d.id as string, hits[0].id, `vid.${d.id}`);
  }
}

function compareCall(v: Rec, o: Rec, diffs: Diff[]) {
  const check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'call', path: p, expected: a ?? null, actual: b ?? null }); };
  check('success', v.success, o.success);
  if ('error' in v || 'error' in o) check('error', v.error, o.error);
  // Cutframe adds a code to Xapp's code-less failures and extra result fields (documented); operationMayHaveRun is not compared (§5 decision 1).
  if ('code' in v) check('code', v.code, o.code);
  if ('message' in v) check('message', v.message, o.message);
  const walk = (a: Json, b: Json | undefined, at: string) => {
    if (Array.isArray(a)) a.forEach((x, i) => walk(x, Array.isArray(b) ? b[i] : undefined, `${at}[${i}]`));
    else if (isObj(a)) for (const [k, x] of Object.entries(a)) {
      const y = isObj(b) ? b[k] : undefined, p = at ? `${at}.${k}` : k;
      if (CALL_FIELDS.has(k)) check(p, ID_LISTS.has(k) ? sortIds(x) : x, ID_LISTS.has(k) ? sortIds(y) : y); else walk(x, y, p);
    }
  };
  walk(v, o, '');
}
const TRACK_FIELDS = ['name', 'kind', 'order', 'layerIndex', 'layer', 'muted', 'solo', 'locked', 'hidden', 'volume'];
/** `markersOnly`: the S41–S43 marker steps ran through Xapp's chat, so only `context.markers` is compared there. */
function compareContext(v: Rec, o: Rec, diffs: Diff[], markersOnly: boolean) {
  const check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'ctx', path: p, expected: a ?? null, actual: b ?? null }); };
  check('markers', (v.markers as Json) ?? [], (o.markers as Json) ?? []);
  if (markersOnly) return;
  check('duration', v.duration, o.duration); check('canvasSize', v.canvasSize, o.canvasSize); check('layerOrder', v.layerOrder, o.layerOrder);
  check('tracks(order)', Object.keys(v.tracks as Rec), Object.keys(o.tracks as Rec));
  for (const [id, row] of Object.entries(v.tracks as Rec)) {
    const ours = (o.tracks as Rec)[id];
    if (!isObj(row) || !isObj(ours)) { check(`tracks.${id}`, row, ours ?? null); continue; }
    for (const f of TRACK_FIELDS) if (f in row || f in ours) check(`tracks.${id}.${f}`, row[f], ours[f]);
    if (Array.isArray(row.items)) check(`tracks.${id}.items`, (row.items as Rec[]).map(i => ({ id: i.id, start: i.start, end: i.end })).sort((a, b) => (a.start as number) - (b.start as number)), ours.items);
    else if (row.collapsed) { check(`tracks.${id}.itemCount`, row.itemCount, (ours.items as Json[]).length); check(`tracks.${id}.ranges`, row.ranges, captionRanges(ours.items as { start: number; end: number }[])); }
  }
  check('groups(ids)', Object.keys(v.groups as Rec).sort(), Object.keys(o.groups as Rec).sort());
  for (const [id, g] of Object.entries(v.groups as Rec)) {
    const ours = (o.groups as Rec)[id];
    if (!isObj(g) || !isObj(ours)) continue;
    for (const f of ['name', 'hidden', 'locked', 'trackIds', 'bounds']) if (f in g) check(`groups.${id}.${f}`, g[f], ours[f]);
  }
}
/** Each stored Details object against the Cutframe item: track, span, trim, and the non-default properties (an omitted
 *  property must be at its default; an omitted size is not compared). Analysis text is T19's and not compared. */
function compareDetails(details: Rec[], doc: ProjectDocument, diffs: Diff[]) {
  const check = (p: string, a: Json | undefined, b: Json | undefined) => { if (!same(a, b)) diffs.push({ part: 'vid', path: p, expected: a ?? null, actual: b ?? null }); };
  const listed = new Set(details.map(d => d.id as string));
  for (const extra of doc.items.filter(i => !listed.has(i.id))) diffs.push({ part: 'vid', path: extra.id, actual: extra.id, note: 'item missing from the stored read' });
  for (const d of details) {
    const i = item(doc, d.id as string), at = d.id as string;
    if (!i) { diffs.push({ part: 'vid', path: at, expected: at, note: 'no such Cutframe item' }); continue; }
    check(`${at}.type`, d.type, i.type); check(`${at}.layer`, d.layer, i.trackId);
    check(`${at}.startTime`, d.startTime, i.display.from / 1000); check(`${at}.endTime`, d.endTime, i.display.to / 1000);
    if (typeof d.duration === 'number') check(`${at}.duration`, d.duration, (i.display.to - i.display.from) / 1000);
    if (isObj(d.trim)) check(`${at}.trim`, d.trim, i.trim ? { start: i.trim.from / 1000, end: i.trim.to / 1000 } : null);
    const vp = isObj(d.properties) ? d.properties : {}, p: RecordData = statics(i), scale = p.scale ?? 1;
    check(`${at}.properties.position`, vp.position ?? { x: 0, y: 0 }, { x: p.positionX ?? 0, y: p.positionY ?? 0 });
    check(`${at}.properties.scale`, vp.scale ?? 1, scale);
    if (isObj(vp.size)) check(`${at}.properties.size`, vp.size, { width: (p.width ?? 0) * scale, height: (p.height ?? 0) * scale });
    check(`${at}.properties.opacity`, vp.opacity ?? 1, p.opacity ?? 1); check(`${at}.properties.rotate`, vp.rotate ?? 0, p.rotation ?? 0);
    check(`${at}.properties.volume`, vp.volume ?? 1, p.volume ?? 1); check(`${at}.properties.playbackRate`, vp.playbackRate ?? 1, i.playbackRate ?? 1);
  }
}

// ---- Fixture media (fixtures/Cutframe test fixtures (C).md: S1 and tos-action-30s, the two G-01 inputs).
const MEDIA: Record<string, { file: string; bytes: number; width: number; height: number; fps: number; ms: number; audio: boolean }> = {
  S1: { file: 'S1-framecount-1080x1920-30fps-10s.mp4', bytes: 13871655, width: 1080, height: 1920, fps: 30, ms: 10000, audio: false },
  'tos-action-30s': { file: 'tos-action-30s.mp4', bytes: 6789415, width: 1280, height: 534, fps: 24, ms: 30000, audio: true },
};
export function fixtureAssets(assets: Record<string, string>): { assets: Asset[]; links: AssetLink[] } {
  const out: { assets: Asset[]; links: AssetLink[] } = { assets: [], links: [] };
  for (const [xappId, name] of Object.entries(assets)) {
    const m = MEDIA[name];
    if (!m) throw Error(`--assets: unknown fixture '${name}' for ${xappId} (use ${Object.keys(MEDIA).join(' or ')})`);
    const id = `g01-${name}-${out.assets.length + 1}`;
    out.assets.push({ id, name: m.file, type: 'video', sizeBytes: m.bytes, mimeType: 'video/mp4', folderId: null, created_at: '', recorded_at: null, location: null, durationMs: m.ms,
      processing_status: 'ready', last_error_code: null,
      media: { container: 'mp4', mimeType: 'video/mp4', durationMs: m.ms, video: { displayWidth: m.width, displayHeight: m.height, codedWidth: m.width, codedHeight: m.height, fps: m.fps, rotation: 0 },
        audio: m.audio ? { codec: 'aac', sampleRate: 44100, channels: 2 } : null, image: null } } as unknown as Asset);
    // The stored inputs name assets by Xapp's project id, so that id is the link's agent id.
    out.links.push({ id: `g01:${id}`, projectId: 'g01', assetId: id, agent_id: xappId, content_type: 'video', added_at: '', deleted_at: null });
  }
  return out;
}

// ---- Replay.
const READS = new Set(['context', 'viewItemDetails']);
type StepReport = { id: string; tool: string; status: 'passed' | 'failed' | 'uncompared'; compared: string[]; diffs: Diff[]; note?: string };
export async function runG01(referenceDir: string, o: G01Options) {
  if (!o.toolField || !o.inputField) throw Error('--tool-field and --input-field are required (the stored record schema is not documented)');
  const stored = await loadStored(referenceDir, o.blockBase);
  const out = await resolvedDestination(path.resolve(o.output ?? 'parity-reports/g01')), base = await realpath(referenceDir);
  if (inside(base, out) || inside(out, base)) throw Error('Output/reference directories overlap or alias');
  await mkdir(out, { recursive: true });
  const { assets, links } = fixtureAssets(o.assets);
  const parts: { steps: StepReport[]; ids: Record<string, string> }[] = [];
  let n = 0;
  setIdSource(() => String(++n).padStart(6, '0'));
  try {
    for (const calls of o.calls) {
      const e = createEditor(undefined, { assets, links }), map = new IdMap(), known = new Set<string>(), steps: StepReport[] = [];
      const remember = () => { const d = e.doc; [...d.tracks, ...d.items, ...d.markers].forEach(x => known.add(x.id)); Object.keys(d.groups).forEach(g => known.add(g)); };
      let moved: Map<string, string> | undefined;
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
        if (!READS.has(tool) && !TOOLS[tool]) { report.status = 'uncompared'; report.note = `not replayed: '${tool}' is not a T03 tool (its owning ticket compares it)`; continue; }
        // A read step's own result is its context / Details; other steps take them from `<id>.ctx` / `<id>.vid`.
        const own = typeof step === 'string' ? stored.blocks(id) : undefined, vCall = own && !READS.has(tool) ? callResult(own) : undefined;
        const vCtx = tool === 'context' && own ? contextOf(own) : stored.has(`${id}.ctx`) ? contextOf(stored.blocks(`${id}.ctx`)) : undefined;
        const vDetails = tool === 'viewItemDetails' && own ? detailsOf(own) : stored.has(`${id}.vid`) ? detailsOf(stored.blocks(`${id}.vid`)) : undefined;
        const before = structuredClone(e.doc);
        const ours = READS.has(tool) ? { success: true } as Rec : e.call(tool, map.input(input) as RecordData) as unknown as Rec;
        remember();
        if (vCall && !READS.has(tool)) learnCall(map, vCall, ours, known);
        const oCtx = contextL(e.doc);
        if (vCtx) learnContext(map, vCtx, oCtx);
        if (vDetails) learnDetails(map, vDetails, e.doc);
        // Q32 (§5 decision 2): Xapp refused "Group is locked"; Cutframe succeeds in scope and moves one item to K-V1.
        if (id === 'Q32' && tool === 'consolidateTracks') {
          report.compared.push('call(Q32 deviation)');
          if (!vCall || vCall.success !== false || vCall.code !== 'PROJECT_UNAVAILABLE' || vCall.error !== 'Group is locked') report.diffs.push({ part: 'call', path: 'Q32', expected: { success: false, code: 'PROJECT_UNAVAILABLE', error: 'Group is locked' }, actual: (vCall ?? null) as Json, note: 'stored Q32 differs from agent tool results §5' });
          const shifted = e.doc.items.filter(i => before.items.find(b => b.id === i.id)?.trackId !== i.trackId);
          const ok = ours.success === true && ours.moved === 1 && same(ours.deletedTrackIds, []) && shifted.length === 1 && track(e.doc, shifted[0].trackId)?.name === 'K-V1' && e.doc.tracks.length === before.tracks.length;
          if (!ok) report.diffs.push({ part: 'call', path: 'Q32', expected: { success: true, moved: 1, deletedTrackIds: [], movedTo: ['K-V1'] }, actual: { success: ours.success ?? null, moved: ours.moved ?? null, deletedTrackIds: ours.deletedTrackIds ?? null, movedTo: shifted.map(i => track(e.doc, i.trackId)?.name ?? i.trackId) } });
          moved = new Map(shifted.map(i => [i.id, i.trackId]));
        } else if (vCall && !READS.has(tool)) { report.compared.push('call'); compareCall(map.translate(vCall) as Rec, ours, report.diffs); }
        // After Q32, Xapp's reads still show the item on its old track; they are compared with Cutframe's documented result.
        const patchCtx = (c: Rec) => {
          for (const [itemId, trackId] of moved ?? []) {
            let entry: Rec | undefined;
            for (const row of Object.values(c.tracks as Rec)) if (isObj(row) && Array.isArray(row.items)) { const k = (row.items as Rec[]).findIndex(x => x.id === itemId); if (k >= 0) entry = (row.items as Rec[]).splice(k, 1)[0]; }
            const dest = (c.tracks as Rec)[trackId];
            if (entry && isObj(dest) && Array.isArray(dest.items)) (dest.items as Rec[]).push(entry);
          }
          return c;
        };
        if (vCtx) { report.compared.push(tool === 'context' ? 'call(context)' : 'ctx'); compareContext(patchCtx(map.translate(vCtx) as Rec), oCtx, report.diffs, typeof step !== 'string'); }
        if (vDetails && typeof step === 'string') {
          report.compared.push(tool === 'viewItemDetails' ? 'call(viewItemDetails)' : 'vid');
          compareDetails((map.translate(vDetails as Json) as Rec[]).map(d => moved?.has(d.id as string) ? { ...d, layer: moved.get(d.id as string)! } : d), e.doc, report.diffs);
        }
        report.diffs.push(...map.conflicts.splice(0));
        report.status = report.diffs.length ? 'failed' : report.compared.length ? 'passed' : 'uncompared';
        if (!report.compared.length) report.note = 'no stored result, context or viewItemDetails read for this step';
      }
      parts.push({ steps, ids: Object.fromEntries(map.to) });
    }
  } finally { setIdSource(null); }
  const all = parts.flatMap(p => p.steps), count = (s: string) => all.filter(x => x.status === s).length;
  const status = count('failed') ? 'failed' : count('uncompared') || !all.length ? 'uncompared' : 'passed';
  const report = { version: 1, golden: 'G-01', status, blockBase: stored.blockBase, steps: all.length, passed: count('passed'), failed: count('failed'), uncompared: count('uncompared'),
    notCompared: 'asset-analysis text (summaries, context narrative and labels), source file ids and the orientation text: T19 owns analysis', parts };
  await atomicJson(out, 'report.json', report);
  return report;
}
