// SPDX-License-Identifier: AGPL-3.0-only
// T07 layout items on the T03 command path: the agent tools addLayout and editLayout (contracts addLayout / editLayout, note
// 19; results §2 addLayout / editLayout). Xapp's code-less failures get Cutframe codes (results §1.4); a cell asset that
// cannot be used is an error in both tools (results "Cutframe note"; Xapp's addLayout leaves the cell empty). Every cell is
// checked before the one write. The model and the UI edits live in layouts.ts.
import type { Asset, RecordData } from '../store/model';
import { projectSize } from '../render/model';
import { overlap } from '../mg/tools';
import { canInsertAfter, insertAfter, sourceOf } from './items';
import { blockers, EPS, fail, fmt, item, newId, toMs, track, trackLocked } from './model';
import { cellAsset, cellAt, cellsOf, cellSource, filledCount, isLayoutType, LAYOUT_PRESETS, LAYOUT_TYPES, layoutLabel, layoutOf, layoutRecord } from './layouts';
import type { Cell, LayoutType } from './layouts';
import type { ToolContext, ToolResult } from './tools';

type Handler = (ctx: ToolContext, args: RecordData) => ToolResult;
const s3 = (ms: number) => Math.round(ms) / 1000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is RecordData => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
/** A new layout lasts 10 s (contracts addLayout; W3-RT-09). */
export const LAYOUT_MS = 10000;

/** gap / borderRadius: finite and >= 0 when given (Cutframe check; Xapp stores what it gets). */
function style(args: RecordData): RecordData {
  const out: RecordData = {};
  for (const k of ['gap', 'borderRadius']) if (args[k] !== undefined) {
    if (!finite(args[k]) || args[k] < 0) fail('INVALID_PROPERTY_VALUE', `${k} must be a number >= 0 (px). Received: ${show(args[k])}.`);
    out[k] = args[k];
  }
  return out;
}
/** One cells[] entry checked against its asset: the new source (undefined = keep, null = clear), fillMode and volume. */
type CellEdit = { index: number; source?: ReturnType<typeof cellSource> | null; fillMode?: string; volume?: number };
function cellEdit(ctx: ToolContext, e: RecordData, index: number, current: Cell | null): CellEdit {
  const out: CellEdit = { index };
  if (e.fillMode !== undefined) {
    if (e.fillMode !== 'fill' && e.fillMode !== 'fit') fail('INVALID_PROPERTY_VALUE', `Cell ${index} fillMode must be "fill" or "fit". Received: ${show(e.fillMode)}.`);
    out.fillMode = e.fillMode;
  }
  if (e.volume !== undefined) {
    if (!finite(e.volume) || e.volume < 0 || e.volume > 200) fail('INVALID_PROPERTY_VALUE', `Cell ${index} volume must be from 0 to 200 (%). Received: ${show(e.volume)}.`);
    out.volume = e.volume;
  }
  let a: Asset | null = null;
  if (e.assetId === null) out.source = null;
  else if (e.assetId !== undefined) a = cellAsset(typeof e.assetId === 'string' ? ctx.asset(e.assetId) : undefined, show(e.assetId));
  if (e.trim !== undefined) {
    // The trim applies to the cell's new media, else to the media already in it.
    const base = a ? cellSource(a) : out.source === null ? null : current?.source ?? null, t = e.trim;
    if (!base) fail('INVALID_COMBINATION', `Cell ${index} trim needs media in the cell: give an assetId with it.`);
    if (base.type !== 'video') fail('INVALID_COMBINATION', `Cell ${index} trim applies to video cells only.`);
    if (!isObj(t) || !finite(t.from) || !finite(t.to) || t.from < 0) fail('INVALID_TRIM_RANGE', `Cell ${index} trim must be {from, to} in ms with from >= 0. Received: ${show(t)}.`);
    if (!(t.to > t.from)) fail('INVALID_TRIM_RANGE', `Cell ${index} trim.to must be greater than trim.from (ms).`);
    const known = a ?? ctx.asset(base.assetId), src = known ? sourceOf(known) : null;
    if (src !== null && t.to > src + EPS) fail('TRIM_EXCEEDS_SOURCE', `Cell ${index} trim.to (${t.to}ms) exceeds the source video duration (${src}ms).`);
    out.source = { ...base, trim: { from: t.from, to: t.to } };
  } else if (a) out.source = cellSource(a);
  return out;
}
const applyEdit = (c: Cell, e: CellEdit) => {
  if (e.source !== undefined) c.source = e.source;
  if (e.fillMode !== undefined) c.fillMode = e.fillMode;
  if (e.volume !== undefined) c.volume = e.volume;
};
const summary = (i: RecordData) => ({ layoutType: i.details?.layoutType, cellCount: cellsOf(i).length, filledCells: filledCount(i), gap: i.details?.gap ?? 0, borderRadius: i.details?.borderRadius ?? 0 });

// ---- addLayout (placement as addShape / addMotionGraphic).
export const addLayout: Handler = (ctx, args) => ctx.bus.run(args.insertAfterItemId !== undefined ? 'Insert items' : 'Add items', 'agent', doc => {
  const ref: string | undefined = args.insertAfterItemId;
  if (ref !== undefined && (args.trackId !== undefined || args.timelineStart !== undefined))
    fail('INVALID_COMBINATION', `insertAfter cannot be used with ${['trackId', 'timelineStart'].filter(k => args[k] !== undefined).join(', ')}. Use insertAfterItemId alone, or trackId with timelineStart.`);
  if (ref !== undefined) {
    const r = item(doc, ref);
    if (!r) fail('INSERT_AFTER_NOT_FOUND', 'insertAfter item not found', { message: `Item '${ref}' not found on the timeline. Read context for current item ids.` });
    if (!track(doc, r.trackId)) fail('INSERT_AFTER_NO_TRACK', 'insertAfter item not on any track');
    if (!canInsertAfter('layout', r)) fail('INSERT_AFTER_TYPE_MISMATCH', 'insertAfter type mismatch', { message: `Cannot insert layout after ${r.type} item '${ref}'. The new item requires a compatible track kind.` });
  }
  if (!isLayoutType(args.layoutType)) fail('INVALID_LAYOUT_TYPE', `Unknown layout type: "${show(args.layoutType)}". Available: ${LAYOUT_TYPES.join(', ')}`);
  const layoutType = args.layoutType as LayoutType, n = LAYOUT_PRESETS[layoutType].cells.length, gapRadius = style(args);
  const length = args.duration === undefined ? LAYOUT_MS : finite(args.duration) ? toMs(args.duration) : NaN;
  if (!(length > 0)) fail('INVALID_DURATION', `duration must be positive. Received: ${show(args.duration)}s.`);
  const asked = args.cells === undefined ? [] : Array.isArray(args.cells) ? args.cells : fail('INVALID_TOOL_INPUT', 'cells must be an array');
  if (asked.length > n) fail('CELL_INDEX_OUT_OF_RANGE', `Cell index ${n} out of range (0-${n - 1})`);
  const edits = asked.map((e: unknown, k: number) => e === null || e === undefined ? { index: k } : isObj(e) ? cellEdit(ctx, e, k, null)
    : fail('INVALID_TOOL_INPUT', `cells[${k}] must be an object`));
  const record = layoutRecord({ id: newId('item'), trackId: '', display: { from: 0, to: length }, layoutType, ...projectSize(doc) });
  Object.assign(record.details, gapRadius);
  edits.forEach((e: CellEdit) => applyEdit(record.details.cells[e.index], e));
  if (ref !== undefined) insertAfter(doc, ref, [record]);
  else {
    if (!args.trackId) fail('MISSING_TRACK_ID', 'trackId is required');
    const t = track(doc, args.trackId);
    if (!t || t.kind !== 'overlay') fail('INVALID_TRACK', `Overlay track '${args.trackId}' not found`);
    if (trackLocked(doc, t.id)) fail('TRACK_LOCKED', `Track '${t.id}' is locked`);
    const from = args.timelineStart === undefined ? 0 : finite(args.timelineStart) ? toMs(args.timelineStart) : NaN;
    if (!(from >= 0)) fail('INVALID_TIMELINE_START', `timelineStart must be >= 0. Received: ${show(args.timelineStart)}s.`);
    record.trackId = t.id; record.display = { from, to: from + length };
    const hit = blockers(doc, t.id, record.display)[0];
    if (hit) overlap(doc, t.id, record.display, hit);
    doc.items.push(record);
  }
  return { success: true, message: `Added ${layoutLabel(layoutType)} layout '${record.id}' to track '${record.trackId}' at ${fmt(record.display.from)}s`,
    data: { itemId: record.id, trackId: record.trackId, type: 'layout', ...summary(record), timelinePosition: { start: s3(record.display.from), end: s3(record.display.from + length) } } };
}) as ToolResult;

// ---- editLayout: style and cell contents, all checked first, one "Edit items" write (no entry when nothing changed).
export const editLayout: Handler = (ctx, args) => ctx.bus.run('Edit items', 'agent', doc => {
  const i = layoutOf(doc, typeof args.itemId === 'string' ? args.itemId : show(args.itemId)), cells = cellsOf(i), gapRadius = style(args);
  const asked = args.cells === undefined ? [] : Array.isArray(args.cells) ? args.cells : fail('INVALID_TOOL_INPUT', 'cells must be an array');
  const edits = asked.map((e: unknown, k: number) => {
    if (!isObj(e)) fail('INVALID_TOOL_INPUT', `cells[${k}] must be an object with an index`);
    return cellEdit(ctx, e, e.index, cellAt(i, e.index));
  });
  if (Object.keys(gapRadius).length) i.details = { ...i.details, ...gapRadius };
  if (edits.length) { edits.forEach((e: CellEdit) => applyEdit(cells[e.index], e)); i.details = { ...i.details, cells }; }
  return { success: true, message: 'Layout updated successfully', data: { itemId: i.id, type: 'layout', ...summary(i) } };
}) as ToolResult;
