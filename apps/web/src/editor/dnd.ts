// SPDX-License-Identifier: AGPL-3.0-only
// One drag-and-drop data type for the timeline and preview with three kinds (findings part 2 §36): assets (project
// footage), stock (one stock item, written by the T14 stock panels) and text (a text payload). Placement is T03 (text T05).
import type { StockItem } from '../media/stock';

export const TIMELINE_DATA_TYPE = 'application/x-cutframe-timeline';
export type AssetRef = { assetId: string; type: 'video' | 'image' | 'audio'; name: string };
export type DragPayload = { kind: 'assets'; items: AssetRef[] } | { kind: 'stock'; item: StockItem } | { kind: 'text'; text: string };

export function setDragPayload(data: DataTransfer, payload: DragPayload) { data.setData(TIMELINE_DATA_TYPE, JSON.stringify(payload)); data.effectAllowed = 'copy'; }
export const carriesPayload = (data: DataTransfer) => Array.from(data.types).includes(TIMELINE_DATA_TYPE);
/** Parses and validates a payload; anything malformed is null (never placed). */
export function parsePayload(raw: string): DragPayload | null {
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  if (value?.kind === 'assets' && Array.isArray(value.items) && value.items.length && value.items.every((i: any) => typeof i?.assetId === 'string' && ['video', 'image', 'audio'].includes(i.type) && typeof i.name === 'string')) {
    return { kind: 'assets', items: value.items.map((i: AssetRef) => ({ assetId: i.assetId, type: i.type, name: i.name })) };
  }
  if (value?.kind === 'stock' && isStockItem(value.item)) return { kind: 'stock', item: value.item };
  if (value?.kind === 'text' && typeof value.text === 'string') return { kind: 'text', text: value.text };
  return null;
}
export const readPayload = (data: DataTransfer) => parsePayload(data.getData(TIMELINE_DATA_TYPE));
const PROVIDERS = ['pexels', 'unsplash', 'freesound'], TYPES = ['image', 'video', 'audio'];
const STRINGS = ['provider_id', 'name', 'thumbnail_url', 'preview_url', 'attribution', 'author', 'licence', 'page_url', 'download_url'] as const;
const numberOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
/** The StockItem contract of media/stock.ts (review R9): a supported provider, a media type and every required field. */
function isStockItem(i: any): i is StockItem {
  return !!i && typeof i === 'object' && PROVIDERS.includes(i.provider) && TYPES.includes(i.type) && STRINGS.every(k => typeof i[k] === 'string')
    && ['duration_ms', 'width', 'height'].every(k => numberOrNull(i[k])) && Array.isArray(i.tags) && i.tags.every((t: unknown) => typeof t === 'string')
    && (i.tracking_url === undefined || typeof i.tracking_url === 'string');
}
