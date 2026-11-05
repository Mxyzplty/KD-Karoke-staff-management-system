// SPDX-License-Identifier: AGPL-3.0-only
// T03 test fixtures (test writer). Plain documents with explicit ids so expected values come from the oracle docs, not from the code.
// Units: documents store ms; agent tool arguments and results are seconds.
import { emptyDocument } from '../apps/web/src/store/model';
import type { Asset, AssetLink, ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { setIdSource } from '../apps/web/src/timeline/model';

export const mkTrack = (id: string, kind: string, extra: RecordData = {}): RecordData =>
  ({ id, name: id, kind, muted: false, solo: false, locked: false, hidden: false, volume: 1, ...extra });
export const mkItem = (id: string, trackId: string, from: number, to: number, extra: RecordData = {}): RecordData =>
  ({ id, type: 'video', trackId, display: { from, to }, playbackRate: 1, details: {}, metadata: { assetId: 'asset-vid1' }, properties: {}, masks: [], effects: [], ...extra });
export const video = (id: string, trackId: string, from: number, to: number, trimFrom = 0, source = 10000, extra: RecordData = {}) =>
  mkItem(id, trackId, from, to, { trim: { from: trimFrom, to: trimFrom + (to - from) }, sourceDuration: source, ...extra });

export type Build = { tracks?: RecordData[]; items?: RecordData[]; groups?: ProjectDocument['groups']; layerOrder?: ProjectDocument['layerOrder']; markers?: RecordData[]; extra?: Partial<ProjectDocument> };
/** tracks listed bottom-first (layerOrder is bottom-first); duration follows the content like the bus does. */
export function build(b: Build = {}): ProjectDocument {
  const tracks = b.tracks ?? [], items = b.items ?? [];
  return { ...emptyDocument(), tracks, items, groups: b.groups ?? {}, markers: b.markers ?? [],
    layerOrder: b.layerOrder ?? tracks.map(t => ({ type: 'track' as const, id: t.id })),
    duration: items.length ? Math.max(...items.map(i => i.display.to)) : 1000, ...b.extra } as ProjectDocument;
}

/** A1 audio, V1 video, V2 video (empty), O1 overlay, C1 caption — bottom to top. */
export function fixture(): ProjectDocument {
  return build({
    tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('V2', 'video'), mkTrack('O1', 'overlay'), mkTrack('C1', 'caption')],
    items: [
      video('v1', 'V1', 0, 4000), video('v2', 'V1', 4000, 8000, 2000), video('v3', 'V1', 10000, 12000),
      mkItem('a1', 'A1', 0, 5000, { type: 'audio', trim: { from: 0, to: 5000 }, sourceDuration: 8000, metadata: { assetId: 'asset-aud1' } }),
      mkItem('t1', 'O1', 1000, 3000, { type: 'text', details: { text: 'Hello' } }),
      mkItem('c1', 'C1', 0, 2000, { type: 'caption', details: { text: 'one' } }),
      mkItem('c2', 'C1', 2000, 4000, { type: 'caption', details: { text: 'two' } }),
      mkItem('c3', 'C1', 4000, 6000, { type: 'caption', details: { text: 'three' } }),
    ],
  });
}
/** Two grouped video tracks g1{V1,V2} (V1 below V2), an overlay O1 and an audio A1 at the root. */
export function grouped(): ProjectDocument {
  return build({
    tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('V2', 'video'), mkTrack('O1', 'overlay')],
    layerOrder: [{ type: 'track', id: 'A1' }, { type: 'group', id: 'g1' }, { type: 'track', id: 'O1' }],
    groups: { g1: { id: 'g1', name: 'Pair', children: [{ type: 'track', id: 'V1' }, { type: 'track', id: 'V2' }], hidden: false, locked: false } },
    items: [video('v1', 'V1', 0, 4000), video('v2', 'V1', 4000, 8000, 2000), video('w1', 'V2', 0, 3000), video('w2', 'V2', 5000, 9000), video('v3', 'V1', 10000, 12000),
      mkItem('t1', 'O1', 1000, 3000, { type: 'text', details: { text: 'Hello' } })],
  });
}

const asset = (id: string, type: string, durationMs: number | undefined, extra: RecordData = {}): Asset => ({
  id, name: `${id}.bin`, type, sizeBytes: 1000, mimeType: type + '/x', folderId: null, created_at: '2026-10-01T00:00:00Z', recorded_at: null, location: `local://${id}`,
  durationMs, ...(type === 'audio' ? {} : { media: { video: { displayWidth: 1920, displayHeight: 1080 }, durationMs } }), ...extra } as unknown as Asset);
export const assets = (): Asset[] => [
  asset('asset-vid1', 'video', 10000), asset('asset-vid2', 'video', 6000), asset('asset-img1', 'image', undefined), asset('asset-aud1', 'audio', 8000),
  asset('asset-nosrc', 'video', 5000, { processing_status: 'failed' }), asset('asset-nodur', 'video', undefined),
];
const link = (assetId: string, agent: string): AssetLink => ({ id: `link-${agent}`, projectId: 'p1', assetId, agent_id: agent, content_type: 'video', added_at: '2026-10-01T00:00:00Z', deleted_at: null } as unknown as AssetLink);
export const links = (): AssetLink[] => [link('asset-vid1', 'video_1'), link('asset-vid2', 'video_2'), link('asset-img1', 'image_1'), link('asset-aud1', 'audio_1'), link('asset-nosrc', 'video_3'), link('asset-nodur', 'video_4')];

/** Deterministic ids: item_001, track_002 … (prefix + counter). */
export function useIds() { let n = 0; setIdSource(() => String(++n).padStart(3, '0')); }
export const resetIds = () => setIdSource(null);

export const ms = (s: number) => s * 1000;
export const itemOf = (doc: ProjectDocument, id: string) => doc.items.find(i => i.id === id)!;
export const span = (doc: ProjectDocument, id: string) => { const i = itemOf(doc, id); return [i.display.from, i.display.to]; };
