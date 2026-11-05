// SPDX-License-Identifier: AGPL-3.0-only
// T07 layouts (findings §20, W3-RT-09; part 3 §46.3, §46.6; part 5 §53.3.3, §53.9 rows 7–11, 13, 14; contracts addLayout /
// editLayout, note 19): the 11 presets, the stored layout item and its cells, the cell edits the inspector and the agent
// tools share, and each filled cell as a media item the render, playback and export paths already read. Pure: no render
// imports, so render/model.ts can import it.
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { hasSource } from './items';
import { fail, insertTrack, item, newId, newTrack, trackLocked } from './model';
import { setStatic, staticValue, storedProperties } from './properties';

export const LAYOUT_TYPES = ['split-horizontal', 'split-vertical', 'three-horizontal', 'three-vertical', 'grid-2x2', 'pip-top-right', 'pip-top-left',
  'pip-bottom-right', 'pip-bottom-left', 'feature-left', 'feature-right'] as const;
export type LayoutType = typeof LAYOUT_TYPES[number];
export type Bounds = { x: number; y: number; width: number; height: number };
export type CellSource = { assetId: string; type: 'video' | 'image'; url: string; trim?: { from: number; to: number } };
export type Cell = { id: string; bounds: Bounds; source: CellSource | null; fillMode: string; panX: number; panY: number; zoom: number; volume: number; opacity: number; playbackRate: number };

// ---- §20 presets: cells as fractions of the item box (x, y, width, height), exactly as stored (0.333 / 0.334 / 0.333).
const b = (x: number, y: number, width: number, height: number): Bounds => ({ x, y, width, height });
const FULL = b(0, 0, 1, 1);
export const LAYOUT_PRESETS: Record<LayoutType, { label: string; cells: Bounds[] }> = {
  'split-horizontal': { label: 'Split Horizontal', cells: [b(0, 0, 0.5, 1), b(0.5, 0, 0.5, 1)] },
  'split-vertical': { label: 'Split Vertical', cells: [b(0, 0, 1, 0.5), b(0, 0.5, 1, 0.5)] },
  'three-horizontal': { label: 'Three Horizontal', cells: [b(0, 0, 0.333, 1), b(0.333, 0, 0.334, 1), b(0.667, 0, 0.333, 1)] },
  'three-vertical': { label: 'Three Vertical', cells: [b(0, 0, 1, 0.333), b(0, 0.333, 1, 0.334), b(0, 0.667, 1, 0.333)] },
  // Row by row (Cutframe order: §20 gives "four 0.5×0.5 cells").
  'grid-2x2': { label: 'Grid 2x2', cells: [b(0, 0, 0.5, 0.5), b(0.5, 0, 0.5, 0.5), b(0, 0.5, 0.5, 0.5), b(0.5, 0.5, 0.5, 0.5)] },
  'pip-top-right': { label: 'PiP Top Right', cells: [FULL, b(0.65, 0.05, 0.3, 0.3)] },
  'pip-top-left': { label: 'PiP Top Left', cells: [FULL, b(0.05, 0.05, 0.3, 0.3)] },
  'pip-bottom-right': { label: 'PiP Bottom Right', cells: [FULL, b(0.65, 0.65, 0.3, 0.3)] },
  'pip-bottom-left': { label: 'PiP Bottom Left', cells: [FULL, b(0.05, 0.65, 0.3, 0.3)] },
  'feature-left': { label: 'Feature Left', cells: [b(0, 0, 0.6, 1), b(0.6, 0, 0.4, 0.5), b(0.6, 0.5, 0.4, 0.5)] },
  // Mirrored about x = 0.5, the feature cell first as in feature-left (Cutframe order).
  'feature-right': { label: 'Feature Right', cells: [b(0.4, 0, 0.6, 1), b(0, 0, 0.4, 0.5), b(0, 0.5, 0.4, 0.5)] },
};
export const isLayoutType = (v: unknown): v is LayoutType => (LAYOUT_TYPES as readonly unknown[]).includes(v);
export const layoutLabel = (type: unknown) => isLayoutType(type) ? LAYOUT_PRESETS[type].label : String(type ?? 'Layout');

// ---- Switches for the two §53.9 rows where Xapp's preview and export differ and the ticket asks for the control (D26
// defaults, notes Q1 / Q2): 'apply' / 'honour' = the ticket; 'ignore' / 'cover' = Xapp's export (the formula oracle).
export const LAYOUT_PARITY: { cellSpeed: 'apply' | 'ignore'; imageFit: 'honour' | 'cover' } = { cellSpeed: 'apply', imageFit: 'honour' };

// ---- The stored item (W3-RT-09): no name, gap or radius on a tile add; cells with 21-character ids.
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
/** A 21-character URL-safe id (the nanoid alphabet and length). */
export function cellId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, n => ALPHABET[n & 63]).join('');
}
export const newCell = (bounds: Bounds): Cell => ({ id: cellId(), bounds: { ...bounds }, source: null, fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 });
export const layoutRecord = (o: { id: string; trackId: string; display: { from: number; to: number }; layoutType: LayoutType; width: number; height: number }): RecordData => ({
  id: o.id, type: 'layout', trackId: o.trackId, display: o.display,
  details: { layoutType: o.layoutType, cells: LAYOUT_PRESETS[o.layoutType].cells.map(newCell) },
  properties: storedProperties({ positionX: 0, positionY: 0, width: o.width, height: o.height, scale: 1, rotation: 0, opacity: 1 }),
});
export const cellsOf = (i: RecordData): Cell[] => Array.isArray(i.details?.cells) ? i.details.cells : [];
export const filledCount = (i: RecordData) => cellsOf(i).filter(c => !!c.source?.url).length;
/** A stable source string per stored asset (Cutframe has no hosted URL; the bytes come from the project store). */
export const assetUrl = (a: Asset) => `asset:${a.id}`;
export const cellSource = (a: Asset, trim?: { from: number; to: number }): CellSource =>
  ({ assetId: a.id, type: a.type as 'video' | 'image', url: assetUrl(a), ...trim ? { trim: { ...trim } } : {} });

// ---- Each filled cell as a media item: id `<layout id>/<cell id>`, the layout's track and time, the cell's trim start and
// Speed (when applied), its volume as the volume property. The render plan, the preview's media pool, the export decoders
// and the audio mix read these instead of the cell. No sourceDuration: past the source's end the last frame holds.
export function cellItem(layout: RecordData, cell: Cell, index: number): RecordData | null {
  const s = cell.source;
  if (!s?.url || (s.type !== 'video' && s.type !== 'image')) return null;
  const rate = LAYOUT_PARITY.cellSpeed === 'apply' && cell.playbackRate > 0 ? cell.playbackRate : 1, from = s.trim?.from ?? 0;
  return {
    id: `${layout.id}/${cell.id}`, type: s.type, trackId: layout.trackId, display: layout.display, playbackRate: rate,
    trim: { from, to: s.trim?.to ?? from + (layout.display.to - layout.display.from) * rate },
    details: { name: `Layout cell ${index + 1} (${layoutLabel(layout.details?.layoutType)})` }, metadata: { assetId: s.assetId, layoutId: layout.id, cellIndex: index },
    properties: { volume: { defaultValue: (Number.isFinite(cell.volume) ? cell.volume : 100) / 100, keyframes: [] } },
  };
}
/** The cell items of one layout, by cell index (null for an empty cell). */
export const cellItems = (layout: RecordData): (RecordData | null)[] => cellsOf(layout).map((c, k) => cellItem(layout, c, k));
/** `items` with every layout's filled cells added after it (media readers: playback pool, export decoders, audio, prechecks). */
export const withCellItems = (items: RecordData[]): RecordData[] =>
  items.flatMap(i => i.type === 'layout' ? [i, ...cellItems(i).filter((c): c is RecordData => !!c)] : [i]);

// ---- UI edits (Layouts panel, inspector, preview drop), each inside the caller's bus command.
export const LIMITS = { gap: [0, 40], borderRadius: [0, 40], volume: [0, 200], opacity: [0, 100], playbackRate: [0.1, 4] } as const;
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
/** The canvas size, with render/model.ts projectSize's fallback (§53.9 row 11: the layout box falls back to the project size). */
const canvas = (doc: ProjectDocument) => ({ width: doc.size?.width || 1080, height: doc.size?.height || 1920 });
export type LayoutOp =
  | { op: 'fill'; index: number; assetId: string }
  | { op: 'clear'; index: number }
  | { op: 'deleteCell'; index: number }
  | { op: 'style'; key: 'gap' | 'borderRadius'; value: number }
  | { op: 'cell'; index: number; key: 'fillMode' | 'volume' | 'opacity' | 'playbackRate'; value: number | string }
  | { op: 'transform'; button: 1 | 2 | 3 | 4 };
/** §46.3 tile: a 10 s layout at 0 s (not the playhead) on a new overlay track, the full canvas, every cell empty. */
export function addLayoutTile(doc: ProjectDocument, layoutType: LayoutType): RecordData {
  const t = insertTrack(doc, newTrack(doc, 'overlay'));
  const record = layoutRecord({ id: newId('item'), trackId: t.id, display: { from: 0, to: 10000 }, layoutType, ...canvas(doc) });
  doc.items.push(record);
  return record;
}
export function layoutOf(doc: ProjectDocument, id: string): RecordData {
  const i = item(doc, id);
  if (!i || i.type !== 'layout') fail('ITEM_NOT_FOUND', `Layout item not found: "${id}". Use the persistent item ID from context().`);
  if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track '${i.trackId}' is locked`);
  return i;
}
export function cellAt(i: RecordData, index: number): Cell {
  const cells = cellsOf(i);
  if (!Number.isInteger(index) || index < 0 || index >= cells.length) fail('CELL_INDEX_OUT_OF_RANGE', `Cell index ${index} out of range (0-${cells.length - 1})`);
  return cells[index];
}
/** A video or image asset with a readable source, else INVALID_CELL_ASSET / INVALID_ASSET_URL (both agent tools and the UI). */
export function cellAsset(a: Asset | undefined, id: string): Asset {
  if (!a) fail('INVALID_CELL_ASSET', `Asset "${id}" not found or not a video/image.`);
  if (a.type !== 'video' && a.type !== 'image') fail('INVALID_CELL_ASSET', `Asset "${id}" is type "${a.type}" — only video/image can be placed in layout cells.`);
  if (!hasSource(a)) fail('INVALID_ASSET_URL', `Asset '${id}' does not have a valid source URL.`);
  return a;
}
/** One UI edit. `asset` resolves a stored asset id (fill). Stored values are clamped to the inspector's ranges. */
export function editLayoutCell(doc: ProjectDocument, id: string, o: LayoutOp, asset: (id: string) => Asset | undefined) {
  const i = layoutOf(doc, id), cells = cellsOf(i);
  if (o.op === 'style') { i.details = { ...i.details, [o.key]: clamp(Number(o.value) || 0, LIMITS[o.key]) }; return; }
  if (o.op === 'transform') { transformLayout(doc, i, o.button); return; }
  const c = cellAt(i, o.index);
  if (o.op === 'fill') c.source = cellSource(cellAsset(asset(o.assetId), o.assetId));
  else if (o.op === 'clear') c.source = null;
  else if (o.op === 'deleteCell') cells.splice(o.index, 1);
  else if (o.key === 'fillMode') c.fillMode = o.value === 'fit' ? 'fit' : 'fill';
  else {
    const n = Number(o.value);
    if (!Number.isFinite(n)) fail('INVALID_PROPERTY_VALUE', `${o.key} must be a finite number`);
    c[o.key] = o.key === 'playbackRate' ? Math.round(clamp(n, LIMITS.playbackRate) * 10) / 10 : Math.round(clamp(n, LIMITS[o.key]));
  }
  i.details = { ...i.details, cells };
}
/** §46.6 Transform buttons: 1 and 2 fit the box to the canvas (full size at 0, 0, scale 1); 3 centres it horizontally, 4
 *  vertically, keeping its scaled size. */
function transformLayout(doc: ProjectDocument, i: RecordData, button: 1 | 2 | 3 | 4) {
  const { width: W, height: H } = canvas(doc), v = (k: string) => Number(staticValue(i, k)) || 0;
  if (button === 1 || button === 2) { setStatic(i, 'positionX', 0); setStatic(i, 'positionY', 0); setStatic(i, 'width', W); setStatic(i, 'height', H); setStatic(i, 'scale', 1); return; }
  const scale = Number(staticValue(i, 'scale', 1));
  if (button === 3) setStatic(i, 'positionX', (W - Math.abs(v('width') * scale)) / 2);
  else setStatic(i, 'positionY', (H - Math.abs(v('height') * scale)) / 2);
}
