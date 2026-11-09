// SPDX-License-Identifier: AGPL-3.0-only
import type { MediaInfo } from '../media/probe';
export type RecordData = Record<string, any>;
export type ProjectDocument = {
  schemaVersion: 4; rev: number;
  layerOrder: { type: 'track' | 'group'; id: string }[];
  groups: Record<string, RecordData>;
  duration: number; fps: number; size: { width: number; height: number };
  background: RecordData; tracks: RecordData[]; items: RecordData[];
  transitions: RecordData[]; markers: RecordData[];
  [key: string]: unknown;
};
export type ProjectRecord = {
  id: string; title: string; project_type: 'editing'; processing_status: 'ready' | 'uploading';
  template_id: string | null; style_id: string | null; is_demo: boolean;
  created_at: string; updated_at: string; last_accessed_at: string;
  /** T19 auto title (Q5): only a 'default' title is ever replaced; a rename makes it 'user' for good. Absent = written before DB v3. */
  title_source?: 'default' | 'user' | 'generated';
};
export type Asset = {
  id: string; name: string; type: 'video' | 'image' | 'audio'; sizeBytes: number;
  mimeType: string; folderId: string | null; created_at: string;
  recorded_at: string | null; location: string | null; durationMs: number | null;
} & AssetMedia;
/** 'skipped' (T19, part 3 §44.5): the step did not apply, e.g. transcription of music without vocals. */
export type ProcessingStep = 'pending' | 'processing' | 'complete' | 'skipped' | 'failed' | 'unavailable';
/** T14 ingest fields (optional so T01 records stay valid). */
export type AssetMedia = {
  /** Name at upload: reuse matches original name + exact size (findings part 2 §25), whatever later renames did. */
  originalName?: string; processing_status?: 'uploading' | 'processing' | 'ready' | 'failed';
  processing_steps?: Record<string, ProcessingStep>; last_error_code?: string | null; last_error_message?: string | null;
  sha256?: string | null; media?: MediaInfo | null; latitude?: number | null; longitude?: number | null;
  source?: { kind: 'upload' | 'stock' | 'allowed-dir' | 'demo'; provider?: string; providerId?: string; attribution?: string; licence?: string; pageUrl?: string; author?: string };
  proxy?: { objectKey?: string; codec: string; container: string; width: number; height: number; sizeBytes: number; created_at: string } | null;
  preparationAttempts?: number;
};
export type Folder = { id: string; name: string; parentId: string | null };
export type AssetLink = {
  id: string; projectId: string; assetId: string; agent_id: string;
  content_type: Asset['type']; added_at: string; deleted_at: string | null;
};
export type LibrarySnapshot = { assets: Asset[]; folders: Folder[]; links: AssetLink[] };
export class StoreError extends Error {
  constructor(public code: string, message: string, public category = 'precondition', public recovery?: string) { super(message); }
}
export function storageError(error: unknown): Error {
  if (error instanceof StoreError) return error;
  const e = error as { name?: string; message?: string };
  if (e?.name === 'QuotaExceededError' || e?.name === 'NoModificationAllowedError' || /quota/i.test(e?.message ?? '')) {
    return new StoreError('STORAGE_QUOTA', 'Browser storage is full. Free disk space and try again.', 'system_error', 'user_fixable');
  }
  return error instanceof Error ? error : new Error('Browser storage could not be opened.');
}
export const emptyDocument = (): ProjectDocument => ({
  schemaVersion: 4, rev: 0, layerOrder: [], groups: {}, duration: 1000, fps: 30,
  size: { width: 1080, height: 1920 }, background: { type: 'color', value: 'transparent' },
  tracks: [], items: [], transitions: [], markers: [],
});
export function validateDocument(value: unknown): ProjectDocument {
  const d = value as ProjectDocument;
  if (!d || d.schemaVersion !== 4) throw new StoreError('UNSUPPORTED_SCHEMA', 'Only schema 4 is supported. Schema 1–3 migrations are not specified yet.');
  if (!['items', 'tracks', 'transitions', 'markers', 'layerOrder'].every(k => Array.isArray(d[k])) ||
      !d.groups || Array.isArray(d.groups) || typeof d.groups !== 'object' ||
      ![d.duration, d.fps, d.size?.width, d.size?.height].every(Number.isFinite) ||
      d.duration < 0 || d.fps <= 0 || d.size.width <= 0 || d.size.height <= 0 || !d.background ||
      !Number.isSafeInteger(d.rev) || d.rev < 0) throw new StoreError('INVALID_PROJECT', 'The project document is incomplete or invalid.');
  return structuredClone(d);
}
// Hook point for documented migrations. Refuse 1–3 until their contracts exist.
export function migrateDocument(value: unknown): ProjectDocument { return validateDocument(value); }
export function importProject(value: unknown): ProjectDocument {
  if (!value || typeof value !== 'object') throw new StoreError('INVALID_PROJECT', 'Choose a project JSON object.');
  const input = structuredClone(value) as RecordData;
  if (input.schemaVersion !== undefined) return migrateDocument({ ...input, rev: input.rev ?? 0 });
  if (!Array.isArray(input.trackItemIds) || !input.trackItemsMap || !input.transitionsMap || !Array.isArray(input.tracks)) {
    throw new StoreError('INVALID_PROJECT', 'Expected schema 4 or the legacy unversioned project map.');
  }
  const { trackItemIds, trackItemsMap, transitionsMap, tracks: oldTracks, ...rest } = input;
  const tracks: RecordData[] = oldTracks.map((t: RecordData) => {
    const { items: _items, type, order: _order, ...record } = t;
    return { ...record, kind: t.kind ?? type };
  });
  const items = trackItemIds.map((id: string) => {
    const item = trackItemsMap[id];
    if (!item) throw new StoreError('INVALID_PROJECT', `Legacy item ${id} is missing.`);
    const trackId = item.trackId ?? oldTracks.find((t: RecordData) => t.items?.includes(id))?.id;
    if (!trackId) throw new StoreError('INVALID_PROJECT', `Legacy item ${id} has no track.`);
    return { ...item, id: item.id ?? id, trackId };
  });
  // Legacy direction is undocumented: use §53.5's missing-track repair in legacy array order.
  const layerOrder: ProjectDocument['layerOrder'] = [];
  for (const track of tracks) {
    const entry = { type: 'track' as const, id: track.id };
    const caption = layerOrder.findIndex(e => tracks.find((t: RecordData) => t.id === e.id)?.kind === 'caption');
    if (track.kind === 'audio') layerOrder.unshift(entry);
    else if (track.kind === 'caption' || caption < 0) layerOrder.push(entry);
    else layerOrder.splice(caption, 0, entry);
  }
  return validateDocument({ ...emptyDocument(), ...rest, schemaVersion: 4, tracks, items, groups: {}, layerOrder,
    transitions: Object.entries(transitionsMap).map(([id, t]) => ({ id, ...(t as RecordData) })),
  });
}
export function projectDateLabel(updatedAt: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 86400000));
  return days === 0 ? 'Today' : `${days}d ago`;
}
export type AssetQuery = { folderId: string | null; type?: string; sort?: 'uploaded' | 'recorded'; direction?: 'ASC' | 'DESC'; from?: string; to?: string; location?: string };
export function queryAssets(assets: Asset[], q: AssetQuery): Asset[] {
  const endDate = q.to ? new Date(`${q.to}T00:00:00`) : null;
  endDate?.setDate(endDate.getDate() + 1);
  const end = endDate?.getTime() ?? Infinity;
  return assets.filter(a => a.folderId === q.folderId && (!q.type || q.type === 'all' || a.type === q.type) &&
    ((!q.from && !q.to) || (a.recorded_at !== null && Date.parse(a.recorded_at) >= (q.from ? Date.parse(`${q.from}T00:00:00`) : -Infinity) && Date.parse(a.recorded_at) < end)) &&
    (!q.location || a.location?.toLowerCase().includes(q.location.toLowerCase())))
    .sort((a, b) => {
      const x = q.sort === 'recorded' ? a.recorded_at : a.created_at, y = q.sort === 'recorded' ? b.recorded_at : b.created_at;
      if (x === null || y === null) return x === y ? b.created_at.localeCompare(a.created_at) : x === null ? 1 : -1;
      return (x.localeCompare(y) * (q.direction === 'ASC' ? 1 : -1)) || b.created_at.localeCompare(a.created_at);
    });
}
