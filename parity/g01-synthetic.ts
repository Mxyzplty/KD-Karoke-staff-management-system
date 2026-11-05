// SPDX-License-Identifier: AGPL-3.0-only
// A synthetic G-01 stored-reference folder for testing the replay support (parity/g01.ts) without Xapp captures.
// It is NOT the G-01 reference and says nothing about Xapp parity: it runs a short editing sequence through the T03
// harness, renames every id into a Xapp-like shape, and writes the §5 layout (`results/<id>.json`, `<id>.ctx.json`,
// `<id>.vid.json`; `result_text` blocks split by `<<<BLOCK>>>`, `result_blocks`, `@@SAME` block references, a same-as
// file named in `notes`). Its `context` and `viewItemDetails` records come from a writer of their own, so the replay's
// projections are checked against an independent reading of layout L. Q32 is stored as Xapp's refusal (§5 decision 2).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Json } from './normalise';
import { fixtureAssets, type G01Step } from './g01';
import { createEditor } from '../apps/web/src/timeline/harness';
import { setIdSource } from '../apps/web/src/timeline/model';
import { statics } from '../apps/web/src/timeline/properties';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';

type Rec = { [key: string]: Json };
type Entry = { type: 'track' | 'group'; id: string };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const SYNTHETIC_FIELDS = { toolField: 'tool_name', inputField: 'tool_input' } as const;

// ---- Independent layout L / Details writers (results §2), deliberately not sharing code with parity/g01.ts.
function bottomFirst(doc: ProjectDocument): string[] {
  const out: string[] = [], walk = (list: Entry[]) => list.forEach(e => e.type === 'group' ? walk((doc.groups[e.id]?.children ?? []) as Entry[]) : out.push(e.id));
  walk(doc.layerOrder as Entry[]);
  return out;
}
function writeContext(doc: ProjectDocument): Rec {
  const order = bottomFirst(doc), tracks: Rec = {};
  for (const id of [...order].reverse()) {
    const t = doc.tracks.find(x => x.id === id)!, at = order.indexOf(id);
    const items = doc.items.filter(i => i.trackId === id).sort((a, b) => a.display.from - b.display.from).map(i => ({ id: i.id, start: r3(i.display.from / 1000), end: r3(i.display.to / 1000), label: i.details?.name ?? 'clip' }));
    tracks[id] = { name: t.name, kind: t.kind, order: at, layerIndex: order.length - 1 - at, ...(at === 0 ? { layer: 'bottom' } : at === order.length - 1 ? { layer: 'top' } : {}),
      muted: !!t.muted, solo: !!t.solo, locked: !!t.locked, hidden: !!t.hidden, volume: t.volume ?? 1, type: t.kind, items };
  }
  const groups: Rec = {};
  for (const [id, g] of Object.entries(doc.groups)) {
    const members: string[] = [], walk = (list: Entry[]) => list.forEach(e => e.type === 'group' ? walk((doc.groups[e.id]?.children ?? []) as Entry[]) : members.push(e.id));
    walk((g.children ?? []) as Entry[]);
    const ids = order.filter(t => members.includes(t)), items = doc.items.filter(i => ids.includes(i.trackId));
    groups[id] = { name: g.name, hidden: !!g.hidden, locked: !!g.locked, trackIds: ids, bounds: items.length ? { start: Math.min(...items.map(i => i.display.from)) / 1000, end: Math.max(...items.map(i => i.display.to)) / 1000 } : null };
  }
  const markers = [...doc.markers].sort((a, b) => a.timeMs - b.timeMs).map(m => ({ time: r3(m.timeMs / 1000), ...(m.label ? { label: m.label } : {}) }));
  return { summary: 'Synthetic project (analysis text is not compared).', duration: r3(doc.duration / 1000), fps: doc.fps, canvasSize: { width: doc.size.width, height: doc.size.height },
    tracks, layerOrder: (doc.layerOrder as Entry[]).map(e => ({ id: e.id, type: e.type })), groups, ...(markers.length ? { markers } : {}) };
}
function writeDetails(doc: ProjectDocument, ids = doc.items.map(i => i.id)): Rec[] {
  return ids.map(id => {
    const i = doc.items.find(x => x.id === id)!, p: RecordData = statics(i), scale = p.scale ?? 1, props: Rec = {};
    if (p.positionX || p.positionY) props.position = { x: p.positionX ?? 0, y: p.positionY ?? 0 };
    if (scale !== 1) props.scale = scale;
    if (p.width) props.size = { width: p.width * scale, height: p.height * scale };
    if ((i.playbackRate ?? 1) !== 1) props.playbackRate = i.playbackRate;
    return { id, type: i.type, startTime: i.display.from / 1000, endTime: i.display.to / 1000, duration: (i.display.to - i.display.from) / 1000, layer: i.trackId,
      ...(i.trim ? { trim: { start: i.trim.from / 1000, end: i.trim.to / 1000 } } : {}), properties: props, description: 'Synthetic analysis text.' };
  });
}

/** Writes `<dir>/results/*`, `<dir>/calls.json` and `<dir>/assets.json`. `blockBase` sets how `@@SAME` blocks are
 *  numbered in the written files (the replay detects it). Also writes `S90.json`, a non-T03 tool not in calls.json. */
export async function writeSyntheticG01(dir: string, o: { blockBase?: 0 | 1 } = {}) {
  const base = o.blockBase ?? 1, assets = { video_1: 'S1' }, { assets: list, links } = fixtureAssets(assets);
  const files = new Map<string, Rec>(), calls: G01Step[][] = [];
  let n = 0;
  setIdSource(() => `syn-${++n}`);
  try {
    // Xapp-like ids, assigned in creation order per kind.
    const names = new Map<string, string>(), count = { track: 0, item: 0, group: 0, marker: 0 };
    const name = (doc: ProjectDocument) => {
      const add = (id: string, kind: keyof typeof count) => { if (!names.has(id)) names.set(id, kind === 'track' ? `track_${(0xa1 + ++count.track).toString(16)}f3` : kind === 'item' ? `clip-${++count.item}` : kind === 'group' ? `grp${++count.group}` : `mk${++count.marker}`); };
      doc.tracks.forEach(t => add(t.id, 'track')); doc.items.forEach(i => add(i.id, 'item')); Object.keys(doc.groups).forEach(g => add(g, 'group')); doc.markers.forEach(m => add(m.id, 'marker'));
    };
    const rename = (v: unknown): Json => JSON.parse(JSON.stringify(v).replace(/\w*syn-\d+/g, m => names.get(m) ?? m));
    const text = (blocks: string[]) => blocks.join('\n<<<BLOCK>>>\n');
    const store = (id: string, tool: string, input: unknown, result: unknown, form: 'text' | 'blocks' = 'text', stringInput = false) => {
      const json = JSON.stringify(rename(result), null, 2), blocks = [`${tool} result`, json];
      files.set(id, { tool_name: tool, tool_input: stringInput ? JSON.stringify(rename(input)) : rename(input), ...(form === 'text' ? { result_text: text(blocks) } : { result_blocks: blocks }), notes: '' });
    };
    const read = (id: string, label: string, value: Rec) => files.set(id, { result_text: text([label, JSON.stringify(rename({ success: true, data: value }))]), notes: '' });

    // Part A.
    let e = createEditor(undefined, { assets: list, links }), steps: G01Step[] = [];
    const step = (id: string, tool: string, input: RecordData, form: 'text' | 'blocks' = 'text', stringInput = false) => {
      const r = e.call(tool, input); name(e.doc); store(id, tool, input, r, form, stringInput); steps.push(id); return r as RecordData;
    };
    const va = step('S1', 'manageTrack', { action: 'create', kind: 'video', name: 'SYN-VA' }).data.track.id;
    const s1 = step('S2', 'addMedia', { trackId: va, items: [{ assetId: 'video_1' }] }, 'blocks').data.addedItemIds[0];
    const right = step('S3', 'splitItem', { itemId: s1, timestampS: 4 }, 'text', true).data.rightItemId;
    step('S4', 'trimItem', { itemId: right, handle: 'end', deltaSeconds: -2, ripple: true });
    store('S5', 'context', {}, { success: true, data: writeContext(e.doc) }); steps.push('S5');
    const vb = step('S6', 'manageTrack', { action: 'create', kind: 'video', name: 'SYN-VB' }).data.track.id;
    step('S7', 'manageTrackGroup', { action: 'create', trackIds: [va, vb], name: 'SYN-G' });
    store('S8', 'viewItemDetails', { itemIds: [s1, right] }, { success: true, data: { results: writeDetails(e.doc, [s1, right]) } }, 'blocks'); steps.push('S8');
    step('S9', 'cloneItem', { itemId: s1, trackId: vb, at: 0 });
    read('S9.ctx', 'context after S9', writeContext(e.doc));
    // S10: a context read with nothing changed since S9, stored as @@SAME references to S9.ctx's blocks.
    files.set('S10', { tool_name: 'context', tool_input: {}, result_text: text([`@@SAME:S9.ctx#${base}`, `@@SAME:S9.ctx.json#${base + 1}`]), notes: '' }); steps.push('S10');
    // S11: the same read again, stored as a same-as file.
    files.set('S11', { tool_name: 'context', tool_input: {}, notes: 'Identical to S10; result not re-captured.' }); steps.push('S11');
    // M1: a marker step run through Xapp's chat (inline in calls.json); only its context markers are stored.
    e.call('manageMarkers', { actions: [{ action: 'add', time: 2, label: 'SYN mark' }] }); name(e.doc);
    read('M1.ctx', 'context after M1', writeContext(e.doc));
    steps.push({ id: 'M1', tool: 'manageMarkers', input: { actions: [{ action: 'add', time: 2, label: 'SYN mark' }] } });
    step('S12', 'deleteItems', { itemIds: [right], ripple: true });
    read('S12.vid', 'viewItemDetails after S12', { results: writeDetails(e.doc) });
    files.set('S90', { tool_name: 'generateCaptions', tool_input: { language: 'en' }, result_text: text(['generateCaptions result', JSON.stringify({ success: true, data: { captionCount: 3 } })]), notes: '' });
    calls.push(steps);

    // Part B: the Q32 deviation. K-V2 holds one item that overlaps K-V1's item (stays) and one that fits (moves).
    e = createEditor(undefined, { assets: list, links }); steps = [];
    const kv1 = step('Q1', 'manageTrack', { action: 'create', kind: 'video', name: 'K-V1' }).data.track.id;
    const kv2 = step('Q2', 'manageTrack', { action: 'create', kind: 'video', name: 'K-V2' }).data.track.id;
    step('Q3', 'addMedia', { trackId: kv1, timelineStart: 0, items: [{ assetId: 'video_1', trimStart: 0, trimEnd: 2 }] });
    step('Q4', 'addMedia', { trackId: kv2, timelineStart: 1, items: [{ assetId: 'video_1', trimStart: 0, trimEnd: 1 }] });
    step('Q5', 'addMedia', { trackId: kv2, timelineStart: 3, items: [{ assetId: 'video_1', trimStart: 0, trimEnd: 2 }] });
    // Xapp refused Q32, so its document (and every later stored read) is unchanged.
    store('Q32', 'consolidateTracks', { trackIds: [kv1, kv2], deleteEmptyTracks: true }, { success: false, error: 'Group is locked', code: 'PROJECT_UNAVAILABLE', operationMayHaveRun: true }); steps.push('Q32');
    store('Q33', 'context', {}, { success: true, data: writeContext(e.doc) }); steps.push('Q33');
    store('Q34', 'viewItemDetails', { itemIds: e.doc.items.map(i => i.id) }, { success: true, data: { results: writeDetails(e.doc) } }); steps.push('Q34');
    calls.push(steps);
  } finally { setIdSource(null); }
  await mkdir(path.join(dir, 'results'), { recursive: true });
  for (const [id, record] of files) await writeFile(path.join(dir, 'results', `${id}.json`), JSON.stringify(record, null, 2));
  await writeFile(path.join(dir, 'calls.json'), JSON.stringify(calls, null, 2));
  await writeFile(path.join(dir, 'assets.json'), JSON.stringify(assets, null, 2));
  return { calls, assets, ...SYNTHETIC_FIELDS, blockBase: base };
}
