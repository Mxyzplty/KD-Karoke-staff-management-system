// SPDX-License-Identifier: AGPL-3.0-only
// T19 C4 / C11 / C5: viewItemDetails (envelopes, include, resolve, details fields, status flags, capabilities, include=transcript,
// include=keyframes, beats) and snapToBeats (analysis/details.ts) against a fake store and a fake rhythm service. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { BEATS, notFound, snapToBeats, sourceUnavailable, templateMissing, viewItemDetails } from '../apps/web/src/analysis/details';
import type { DetailsContext } from '../apps/web/src/analysis/details';
import { readBeats, snapCuts } from '../apps/web/src/analysis/helpers';
import type { RhythmRow } from '../apps/web/src/analysis/service';
import type { Rhythm, Transcript } from '../apps/web/src/analysis/types';
import { keyframesBlock } from '../apps/web/src/timeline/properties';
import type { Asset } from '../apps/web/src/store/model';
import { build, mkItem, mkTrack } from './t03-fixtures';

type Rec = Record<string, any>;
const DONE = { analysis: 'complete', transcription: 'complete', embeddings_description: 'complete', embeddings_transcript: 'complete' };
const asset = (id: string, type: 'video' | 'audio' | 'image', durationMs: number | null, extra: Rec = {}) =>
  ({ id, name: `${id}.bin`, type, durationMs, recorded_at: null, processing_status: 'ready', processing_steps: { ...DONE }, last_error_code: null, ...extra }) as unknown as Asset;

// Beats every 0.5 s from 0.5 to 8 s: strong (0.9) on odd multiples of 0.5, weak (0.4) between; downbeats every 4th beat from 0.5 s.
const BEAT_LIST: [number, number][] = Array.from({ length: 16 }, (_, i) => [0.5 * (i + 1), i % 2 === 0 ? 0.9 : 0.4]);
const RHYTHM: Rhythm = { bpm: 120, averageBpm: 118, beats: BEAT_LIST, downbeats: [[0.5, 0.9], [2.5, 0.9], [4.5, 0.9], [6.5, 0.9]], silences: [] };
const rhythmRow = (a: Asset, rhythm: Rhythm | null = RHYTHM): RhythmRow => ({ id: a.id, analysis: rhythm ? { stored: rhythm, tab: { bpm: rhythm.bpm, beats: rhythm.beats, onsets: [], silences: [], firstBeat: 0.5, tempoType: 'constant' } } : null, ...(rhythm ? {} : { reason: 'BEATS_NOT_MUSIC' as const }), created_at: '2026-11-02T00:00:00Z' });

const kf = (time: number, value: number) => ({ time, value, easing: 'linear' });
const ITEMS = [
  mkItem('v1', 'V1', 0, 4000, { trim: { from: 0, to: 4000 } }),
  mkItem('v2', 'V1', 4000, 8000, { trim: { from: 0, to: 4000 }, metadata: { assetId: 'asset-lib' } }), // asset without a project link
  mkItem('a1', 'A1', 10000, 12000, { type: 'audio', trim: { from: 2000, to: 6000 }, playbackRate: 2, metadata: { assetId: 'asset-aud1' } }),
  mkItem('a2', 'A1', 20000, 22000, { type: 'audio', trim: { from: 0, to: 2000 }, metadata: { assetId: 'asset-aud2' } }),
  mkItem('i1', 'V1', 30000, 32000, { type: 'image', metadata: { assetId: 'asset-img1' } }),
  mkItem('t1', 'O1', 1000, 3000, { type: 'text', details: { text: 'Hello' }, metadata: {} }),
  mkItem('c1', 'C1', 0, 2000, { type: 'text', details: { subType: 'caption', text: 'x' }, metadata: {} }),
  mkItem('c2', 'C1', 2000, 4000, { type: 'caption', details: { text: 'y' }, metadata: {} }),
  mkItem('k1', 'V1', 40000, 44000, { trim: { from: 0, to: 4000 }, properties: { opacity: { defaultValue: 1, keyframes: [kf(0, 1), kf(1000, 0.5)] } }, masks: [{}], effects: [{}] }),
  mkItem('r1', 'A1', 50000, 54000, { type: 'audio', trim: { from: 0, to: 4000 }, metadata: { assetId: 'asset-aud1' }, timeRemap: { defaultValue: 0, keyframes: [kf(0, 0), kf(4000, 4000)] } }),
  mkItem('gone', 'V1', 60000, 61000, { metadata: { assetId: 'asset-nowhere' } }),
  mkItem('up', 'V1', 62000, 63000, { metadata: { assetId: 'asset-up' } }),
  mkItem('proc', 'V1', 64000, 65000, { metadata: { assetId: 'asset-proc' } }),
  mkItem('miss', 'V1', 66000, 67000, { metadata: { assetId: 'asset-miss' } }),
];
// [stored asset, agent id (null = not in the project)]
const baseAssets = (): [Asset, string | null][] => [
  [asset('asset-vid1', 'video', 10000), 'video_1'], [asset('asset-aud1', 'audio', 8000), 'audio_1'], [asset('asset-aud2', 'audio', 3000), 'audio_2'],
  [asset('asset-img1', 'image', null), 'image_1'], [asset('asset-lib', 'video', 5000), null],
  [asset('asset-up', 'video', 1000, { processing_status: 'uploading' }), 'video_2'], [asset('asset-proc', 'video', 1000, { processing_status: 'processing' }), 'video_3'],
  [asset('asset-miss', 'video', 1000, { last_error_code: 'OBJECT_MISSING' }), 'video_4'],
];
type Setup = { assets?: [Asset, string | null][]; items?: Rec[]; rows?: Record<string, Record<string, unknown>>; rhythm?: (asset: Asset) => Promise<RhythmRow> | RhythmRow };
function setup({ assets = baseAssets(), items = ITEMS, rows = {}, rhythm = a => rhythmRow(a) }: Setup = {}) {
  const byId = new Map<string, Asset>(), agent = new Map<string, string>();
  for (const [a, ag] of assets) { byId.set(a.id, a); if (ag) { byId.set(ag, a); agent.set(a.id, ag); } }
  const service = { rhythm: vi.fn(async (_store: unknown, a: Asset) => rhythm(a)) };
  const ctx = { doc: build({ tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('C1', 'caption')], items }),
    asset: (id: string) => byId.get(id), agentId: (id: string) => agent.get(id),
    store: { row: async (s: string, id: string) => rows[s]?.[id], putRow: async () => {}, media: {} }, service } as unknown as DetailsContext;
  return { ctx, service };
}
const view = (input: Rec, s: Setup = {}, onKeyframes?: (id: string) => void) => { const w = setup(s); return viewItemDetails(w.ctx, input, onKeyframes).then(r => ({ r: r as Rec, ...w })); };
const T = 'transcript';

describe('T19 C4 envelopes and include', () => {
  it('no ids → INVALID_TOOL_INPUT', async () => {
    expect((await view({ include: T })).r).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Provide itemId/itemIds or assetId/assetIds' });
    expect((await view({ include: T, itemIds: [], assetIds: [] })).r.code).toBe('INVALID_TOOL_INPUT');
  });
  it('one id → { success, data } only; a single-element itemIds is single too', async () => {
    const { r } = await view({ itemId: 'v1', include: T });
    expect(Object.keys(r).sort()).toEqual(['data', 'success']); expect(r.data.id).toBe('v1');
    expect(Object.keys((await view({ itemIds: ['v1'], include: T })).r).sort()).toEqual(['data', 'success']);
    expect(Object.keys((await view({ assetId: 'video_1', include: T })).r).sort()).toEqual(['data', 'success']);
  });
  it('a single failing id returns the bare failure { success: false, code, error }', async () => {
    expect((await view({ itemId: 'nope', include: T })).r).toEqual({ success: false, code: 'ITEM_NOT_FOUND', error: notFound('nope') });
  });
  it('two or more ids → "Batch: ok/n items" with a result per id (data, or code + error)', async () => {
    const { r } = await view({ itemIds: ['v1', 'nope', 'a1'], include: T });
    expect(r).toMatchObject({ success: true, message: 'Batch: 2/3 items' });
    expect(Object.keys(r).sort()).toEqual(['data', 'message', 'success']);
    expect(r.data.results.map((x: Rec) => [x.id, x.success])).toEqual([['v1', true], ['nope', false], ['a1', true]]);
    expect(r.data.results[0].data.id).toBe('v1');
    expect(r.data.results[1]).toEqual({ id: 'nope', success: false, code: 'ITEM_NOT_FOUND', error: notFound('nope') });
  });
  it('ids are deduplicated; itemIds and assetIds are combined', async () => {
    expect((await view({ itemIds: ['v1', 'v1', 'a1'], include: T })).r.message).toBe('Batch: 2/2 items');
    const { r } = await view({ itemIds: ['v1'], assetIds: ['video_1', 'v1'], include: T });
    expect(r.data.results.map((x: Rec) => x.id)).toEqual(['v1', 'video_1']);
  });
  // T12 (C8 assertion-only edit): masks is served now, so it no longer appears among the NOT_IMPLEMENTED words.
  it('include "", general, analysis, effects (alone or with others) → NOT_IMPLEMENTED owned by T18; masks is served', async () => {
    for (const include of [undefined, '', 'general', 'analysis', 'effects', 'general,transcript', ['effects']]) {
      const { r, service } = await view({ itemId: 'v1', include });
      expect(r, JSON.stringify(include)).toMatchObject({ success: false, code: 'NOT_IMPLEMENTED', owner: 'T18' });
      expect(typeof r.error).toBe('string'); expect(typeof r.message).toBe('string'); expect(service.rhythm).not.toHaveBeenCalled();
    }
    const both = (await view({ itemId: 'v1', include: 'masks,effects' })).r;
    expect(both.error).toContain('"effects"'); expect(both.error).not.toContain('masks'); expect(both.message).toContain('T18');
    expect((await view({ itemId: 'v1', include: 'general' })).r.error).toContain('"general"');
  });
  it('only unknown words → NOT_IMPLEMENTED (the default, general)', async () => {
    const { r } = await view({ itemId: 'v1', include: 'bogus,whatever' });
    expect(r).toMatchObject({ success: false, code: 'NOT_IMPLEMENTED', owner: 'T18' }); expect(r.error).toContain('"general"');
  });
  it('transcript, keyframes and "transcript,keyframes" are served; include as an array works; unknown words beside served ones are ignored', async () => {
    for (const include of ['transcript', 'keyframes', 'transcript,keyframes', ['transcript', 'keyframes'], 'transcript, bogus']) {
      const { r } = await view({ itemId: 'v1', include });
      expect(r, JSON.stringify(include)).toMatchObject({ success: true, data: { id: 'v1' } });
    }
  });
  it('beats among the words → the beats-only result, whatever else is listed', async () => {
    for (const include of ['beats', 'general,beats', ['masks', 'beats'], 'transcript,keyframes,beats']) {
      const { r } = await view({ assetId: 'audio_1', include });
      expect(r, JSON.stringify(include)).toEqual({ success: true, data: { beats: { bpm: 120, firstDownbeat: 0.5 } } });
    }
  });
});

describe('T19 C4 resolve', () => {
  it('a timeline item id comes first; an asset by agent id or stored id (with a live project link) is an asset result', async () => {
    expect((await view({ itemId: 'v1', include: T })).r.data).toMatchObject({ id: 'v1', layer: 'V1' });
    expect((await view({ assetId: 'video_1', include: T })).r.data).toMatchObject({ id: 'video_1', layer: 'video_track_available' });
    expect((await view({ assetId: 'asset-vid1', include: T })).r.data).toMatchObject({ id: 'asset-vid1', layer: 'video_track_available' });
  });
  it('an item id wins over an asset of the same id', async () => {
    const w = setup({ assets: [...baseAssets(), [asset('v1', 'audio', 2000), 'audio_9']] });
    expect((await viewItemDetails(w.ctx, { itemId: 'v1', include: T }) as Rec).data.layer).toBe('V1');
  });
  it('a tpl_ id that is not in the project → TEMPLATE_ASSET_NOT_IN_PROJECT', async () => {
    expect((await view({ assetId: 'tpl_x', include: T })).r).toEqual({ success: false, code: 'TEMPLATE_ASSET_NOT_IN_PROJECT', error: templateMissing('tpl_x') });
    expect(templateMissing('tpl_x')).toBe("'tpl_x' is a template asset that is not in this project. Add it with addAssetToProject, then inspect the agent ID it returns.");
  });
  it('anything else → ITEM_NOT_FOUND with the exact message; video_9 adds the project-asset sentence', async () => {
    const prefix = (id: string) => `'${id}' is not a current timeline item or project asset. Timeline item IDs change when clips are deleted, split or replaced; call context()`;
    const plain = (await view({ itemId: 'nope', include: T })).r;
    expect(plain).toEqual({ success: false, code: 'ITEM_NOT_FOUND', error: `${prefix('nope')} to get the current IDs.` });
    const looks = (await view({ itemId: 'video_9', include: T })).r;
    expect(looks.code).toBe('ITEM_NOT_FOUND'); expect(looks.error.startsWith(prefix('video_9'))).toBe(true);
    expect(looks.error).toContain("'video_9' looks like a project asset ID"); expect(looks.error.length).toBeGreaterThan(plain.error.length);
  });
  it('a library asset with no project link → ITEM_NOT_FOUND (by stored id)', async () => {
    expect((await view({ assetId: 'asset-lib', include: T })).r).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
  });
});

describe('T19 C4 details fields and status flags', () => {
  it('item fields: id, type, startTime, endTime, duration (s, 3 dp), layer = trackId, has* flags', async () => {
    const one = (await view({ itemId: 'v1', include: T })).r.data;
    expect(one).toMatchObject({ id: 'v1', type: 'video', startTime: 0, endTime: 4, duration: 4, layer: 'V1', hasKeyframes: false, hasMasks: false, hasEffects: false });
    const odd = (await view({ itemId: 'x', include: T }, { items: [mkItem('x', 'V1', 1001, 3502, { trim: { from: 0, to: 2501 } })] })).r.data;
    expect(odd).toMatchObject({ startTime: 1.001, endTime: 3.502, duration: 2.501 });
    expect((await view({ itemId: 'k1', include: T })).r.data).toMatchObject({ hasKeyframes: true, hasMasks: true, hasEffects: true });
    expect((await view({ itemId: 'r1', include: T })).r.data.hasKeyframes).toBe(true); // a time remap counts
  });
  it('a text item whose details.subType is caption (and a caption item) has type "caption"; other text stays text', async () => {
    expect((await view({ itemId: 'c1', include: T })).r.data.type).toBe('caption');
    expect((await view({ itemId: 'c2', include: T })).r.data.type).toBe('caption');
    expect((await view({ itemId: 't1', include: T })).r.data.type).toBe('text');
  });
  it('asset fields: startTime 0, endTime = duration = durationMs / 1000, layer "<type>_track_available", has* false', async () => {
    expect((await view({ assetId: 'video_1', include: T })).r.data).toMatchObject({ id: 'video_1', type: 'video', startTime: 0, endTime: 10, duration: 10, layer: 'video_track_available', hasKeyframes: false, hasMasks: false, hasEffects: false });
    expect((await view({ assetId: 'audio_1', include: T })).r.data).toMatchObject({ type: 'audio', endTime: 8, duration: 8, layer: 'audio_track_available' });
    expect((await view({ assetId: 'image_1', include: T })).r.data).toMatchObject({ type: 'image', endTime: 0, duration: 0, layer: 'image_track_available' });
  });
  it('recordedAt appears when the asset has recorded_at', async () => {
    const withDate = baseAssets(); withDate[0] = [asset('asset-vid1', 'video', 10000, { recorded_at: '2026-10-05T12:00:00Z' }), 'video_1'];
    expect((await view({ assetId: 'video_1', include: T }, { assets: withDate })).r.data.recordedAt).toBe('2026-10-05T12:00:00Z');
    expect((await view({ itemId: 'v1', include: T }, { assets: withDate })).r.data.recordedAt).toBe('2026-10-05T12:00:00Z');
    expect(await view({ assetId: 'video_1', include: T }).then(x => x.r.data)).not.toHaveProperty('recordedAt');
  });
  it('a normal, fully prepared asset has no flags, warning or capabilities', async () => {
    for (const input of [{ itemId: 'v1' }, { assetId: 'video_1' }]) {
      const data = (await view({ ...input, include: T })).r.data;
      for (const key of ['assetUnavailable', 'assetRemovedFromProject', 'assetStillAdding', 'assetProcessing', 'warning', 'warningMessage', 'status', 'note', 'capabilities']) expect(data, key).not.toHaveProperty(key);
    }
  });
  it('a missing asset (item) → assetUnavailable, SOURCE_ASSET_UNAVAILABLE and its message', async () => {
    const data = (await view({ itemId: 'gone', include: T })).r.data;
    expect(data).toMatchObject({ assetUnavailable: true, warning: 'SOURCE_ASSET_UNAVAILABLE', warningMessage: "The exact source for 'gone' is unavailable in this project." });
    expect(sourceUnavailable('gone')).toBe(data.warningMessage);
  });
  it('last_error_code OBJECT_MISSING → the same flags (item and asset)', async () => {
    expect((await view({ itemId: 'miss', include: T })).r.data).toMatchObject({ assetUnavailable: true, warning: 'SOURCE_ASSET_UNAVAILABLE', warningMessage: "The exact source for 'miss' is unavailable in this project." });
    expect((await view({ assetId: 'video_4', include: T })).r.data).toMatchObject({ assetUnavailable: true, warning: 'SOURCE_ASSET_UNAVAILABLE', warningMessage: "The exact source for 'video_4' is unavailable in this project." });
  });
  it('an item whose asset has no project link → assetRemovedFromProject with the same warning', async () => {
    const data = (await view({ itemId: 'v2', include: T })).r.data;
    expect(data).toMatchObject({ assetRemovedFromProject: true, warning: 'SOURCE_ASSET_UNAVAILABLE', warningMessage: "The exact source for 'v2' is unavailable in this project." });
    expect(data).not.toHaveProperty('assetUnavailable');
  });
  it('processing_status uploading → assetStillAdding and SOURCE_STILL_ADDING', async () => {
    for (const input of [{ itemId: 'up' }, { assetId: 'video_2' }]) {
      const data = (await view({ ...input, include: T })).r.data;
      expect(data).toMatchObject({ assetStillAdding: true, warning: 'SOURCE_STILL_ADDING' }); expect(typeof data.warningMessage).toBe('string');
      expect(data).not.toHaveProperty('assetUnavailable');
    }
  });
  it('processing_status processing → assetProcessing, status PROCESSING and a note', async () => {
    for (const input of [{ itemId: 'proc' }, { assetId: 'video_3' }]) {
      const data = (await view({ ...input, include: T })).r.data;
      expect(data).toMatchObject({ assetProcessing: true, status: 'PROCESSING' }); expect(typeof data.note).toBe('string'); expect(data).not.toHaveProperty('warning');
    }
  });
  it('text items (no assetId) carry no flags and no capabilities', async () => {
    for (const id of ['t1', 'c1']) {
      const data = (await view({ itemId: id, include: T })).r.data;
      for (const key of ['assetUnavailable', 'assetRemovedFromProject', 'assetStillAdding', 'assetProcessing', 'warning', 'capabilities']) expect(data, key).not.toHaveProperty(key);
    }
  });
});

describe('T19 C4 capabilities', () => {
  const caps = async (steps: Rec | undefined, status = 'ready') => {
    const a = asset('asset-vid1', 'video', 1000, { processing_status: status, ...(steps ? { processing_steps: steps } : { processing_steps: undefined }) });
    return (await view({ assetId: 'video_1', include: T }, { assets: [[a, 'video_1']] })).r.data.capabilities;
  };
  it('absent when analysis, transcript and search are all ready', async () => { expect(await caps(DONE)).toBeUndefined(); });
  it('step states map: complete→ready, skipped→never, pending→pending, processing→pending, failed→failed, unavailable→unavailable', async () => {
    const cases: [string, string][] = [['skipped', 'never'], ['pending', 'pending'], ['processing', 'pending'], ['failed', 'failed'], ['unavailable', 'unavailable']];
    for (const [state, name] of cases) {
      expect(await caps({ ...DONE, analysis: state }), `analysis ${state}`).toEqual({ analysis: name, transcript: 'ready', search: 'ready' });
      expect(await caps({ ...DONE, transcription: state }), `transcription ${state}`).toEqual({ analysis: 'ready', transcript: name, search: 'ready' });
    }
  });
  it('search is the worst of embeddings_description / embeddings_transcript: failed > pending > unavailable > ready > never', async () => {
    const search = async (d: string, t: string) => (await caps({ ...DONE, embeddings_description: d, embeddings_transcript: t }) ?? { search: 'ready' }).search; // absent = all ready
    expect(await search('failed', 'complete')).toBe('failed');
    expect(await search('complete', 'failed')).toBe('failed');
    expect(await search('failed', 'pending')).toBe('failed');
    expect(await search('pending', 'unavailable')).toBe('pending');
    expect(await search('processing', 'complete')).toBe('pending');
    expect(await search('unavailable', 'complete')).toBe('unavailable');
    expect(await search('unavailable', 'skipped')).toBe('unavailable');
    expect(await search('skipped', 'complete')).toBe('ready');
    expect(await search('skipped', 'skipped')).toBe('never');
  });
  it('a step missing on an asset prepared before T19 is never; pending while the asset is processing or uploading', async () => {
    expect(await caps(undefined)).toEqual({ analysis: 'never', transcript: 'never', search: 'never' });
    expect(await caps({})).toEqual({ analysis: 'never', transcript: 'never', search: 'never' });
    expect(await caps({ analysis: 'complete' })).toEqual({ analysis: 'ready', transcript: 'never', search: 'never' });
    expect(await caps({}, 'processing')).toEqual({ analysis: 'pending', transcript: 'pending', search: 'pending' });
    expect(await caps({}, 'uploading')).toEqual({ analysis: 'pending', transcript: 'pending', search: 'pending' });
  });
  it('capabilities appear on an item as well as an asset', async () => {
    const a = asset('asset-vid1', 'video', 1000, { processing_steps: { ...DONE, transcription: 'unavailable' } });
    expect((await view({ itemId: 'v1', include: T }, { assets: [[a, 'video_1']] })).r.data.capabilities).toEqual({ analysis: 'ready', transcript: 'unavailable', search: 'ready' });
  });
});

describe('T19 C4 include=transcript', () => {
  const w = (word: string, start: number, end: number) => ({ word, start, end });
  const TR: Transcript = { language: 'en', languages: ['en'], total_duration: 11, segments: [
    { id: 0, start: 0, end: 1.5, text: 'S0', speaker: 0, words: [w('w0', 0, 0.5)] },
    { id: 1, start: 3, end: 5, text: 'S1', speaker: 0, words: [w('w3', 3, 3.5), w('w4', 4, 4.5)] },
    { id: 2, start: 7, end: 9, text: 'S2', speaker: 1, words: [w('w7', 7, 7.5), w('w8', 8.2, 8.5)] },
    { id: 3, start: 9.5, end: 11, text: 'S3', speaker: 0, words: [w('w9', 9.5, 10)] },
  ] };
  const rows = (transcript: unknown = TR) => ({ transcripts: { 'asset-vid1': { id: 'asset-vid1', status: 'complete', transcript, created_at: 'x' } } });
  const trimmed = (rate: number) => mkItem('tv', 'V1', 10000, rate === 1 ? 16000 : 13000, { playbackRate: rate, trim: { from: 2000, to: 8000 } });

  it('an asset: the whole transcript at source seconds, read through importTranscript', async () => {
    const t = (await view({ assetId: 'video_1', include: T }, { rows: rows() })).r.data.transcription;
    expect(t.language).toBe('en'); expect(t.segments.map((s: Rec) => s.id)).toEqual([0, 1, 2, 3]);
    expect(t.segments[1]).toEqual({ id: 1, start: 3, end: 5, text: 'S1', speaker: 0, words: [w('w3', 3, 3.5), w('w4', 4, 4.5)] });
    const legacy = (await view({ assetId: 'video_1', include: T }, { rows: rows({ words: [w('Hi', 1, 1.4), w('there.', 1.5, 2)] }) })).r.data.transcription;
    expect(legacy).toEqual({ segments: [{ id: 0, start: 1, end: 2, text: 'Hi there.', speaker: 0, words: [w('Hi', 1, 1.4), w('there.', 1.5, 2)] }] }); // no language → none
  });
  it('an item: item start + source − trim start, playback rate not applied; segments outside the trim are dropped; words must start inside', async () => {
    const expected = { language: 'en', segments: [
      { id: 1, start: 11, end: 13, text: 'S1', speaker: 0, words: [w('w3', 11, 11.5), w('w4', 12, 12.5)] },
      { id: 2, start: 15, end: 17, text: 'S2', speaker: 1, words: [w('w7', 15, 15.5)] }, // w8 starts at 8.2, past the trim end
    ] };
    for (const rate of [1, 2]) expect((await view({ itemId: 'tv', include: T }, { items: [trimmed(rate)], rows: rows() })).r.data.transcription, `rate ${rate}`).toEqual(expected);
  });
  it('an item without a trim reads from the start of the source for its own span', async () => {
    const plain = mkItem('tn', 'V1', 5000, 9000, {}); delete plain.trim;
    const t = (await view({ itemId: 'tn', include: T }, { items: [plain], rows: rows() })).r.data.transcription;
    expect(t.segments.map((s: Rec) => [s.id, s.start])).toEqual([[0, 5], [1, 8]]); // S2 starts at 7 ≥ 4 s
  });
  it('no transcription key without a transcript row, with a null transcript, for an image, or for a non-media item', async () => {
    expect((await view({ assetId: 'video_1', include: T })).r.data).not.toHaveProperty('transcription');
    expect((await view({ assetId: 'video_1', include: T }, { rows: rows(null) })).r.data).not.toHaveProperty('transcription'); // skipped transcription
    const img = { transcripts: { 'asset-img1': { id: 'asset-img1', status: 'complete', transcript: TR, created_at: 'x' } } };
    expect((await view({ assetId: 'image_1', include: T }, { rows: img })).r.data).not.toHaveProperty('transcription');
    expect((await view({ itemId: 'i1', include: T }, { rows: img })).r.data).not.toHaveProperty('transcription');
    expect((await view({ itemId: 't1', include: T }, { rows: rows() })).r.data).not.toHaveProperty('transcription');
    const none = (await view({ itemId: 'tv', include: T }, { items: [mkItem('tv', 'V1', 0, 1000, { trim: { from: 20000, to: 21000 } })], rows: rows() })).r.data;
    expect(none).not.toHaveProperty('transcription'); // nothing spoken inside the trim
  });
  it('only included with the transcript word; include=keyframes alone does not read the store', async () => {
    const reads: string[] = [];
    const w2 = setup({ rows: rows() }); const ctx = { ...w2.ctx, store: { ...w2.ctx.store, row: async (s: string, id: string) => { reads.push(`${s}:${id}`); return undefined; } } } as DetailsContext;
    await viewItemDetails(ctx, { itemId: 'v1', include: 'keyframes' });
    const transcripts = () => reads.filter(r => r.startsWith('transcripts:')); // the asset itself is re-read from the store too (R3)
    expect(transcripts()).toEqual([]);
    await viewItemDetails(ctx, { itemId: 'v1', include: 'transcript' });
    expect(transcripts()).toEqual(['transcripts:asset-vid1']);
  });
});

describe('T19 C4 include=keyframes', () => {
  it('an item with keyframes returns its keyframesBlock fields', async () => {
    const data = (await view({ itemId: 'k1', include: 'keyframes' })).r.data;
    expect(data.keyframes).toEqual(keyframesBlock(ITEMS.find(i => i.id === 'k1')!).keyframes);
    expect(data.keyframes.opacity).toMatchObject({ defaultValue: 1, keyframeCount: 2 });
    expect(data.keyframes.opacity.keyframes.map((k: Rec) => k.timelineSeconds)).toEqual([40, 41]); // item start 40 s + keyframe time
    expect(data).not.toHaveProperty('keyframesNote');
  });
  it('an item without keyframes → keyframes null and the note', async () => {
    expect((await view({ itemId: 'v1', include: 'keyframes' })).r.data).toMatchObject({ keyframes: null, keyframesNote: 'No keyframes on this item' });
  });
  it('an asset → keyframes null and the note', async () => {
    expect((await view({ assetId: 'video_1', include: 'keyframes' })).r.data).toMatchObject({ keyframes: null, keyframesNote: 'No keyframes on this item' });
  });
  it('no keyframes keys without the keyframes word', async () => {
    expect((await view({ itemId: 'k1', include: T })).r.data).not.toHaveProperty('keyframes');
  });
  it('onKeyframesRead is called once per successful item — not for assets, failed ids or other includes', async () => {
    const seen: string[] = [];
    await view({ itemIds: ['k1', 'v1', 'video_1', 'nope'], include: 'transcript,keyframes' }, {}, id => seen.push(id));
    expect(seen).toEqual(['k1', 'v1']);
    seen.length = 0;
    await view({ itemId: 'nope', include: 'keyframes' }, {}, id => seen.push(id));
    await view({ assetId: 'video_1', include: 'keyframes' }, {}, id => seen.push(id));
    await view({ itemId: 'k1', include: T }, {}, id => seen.push(id));
    await view({ itemId: 'k1', include: 'masks' }, {}, id => seen.push(id)); // NOT_IMPLEMENTED
    expect(seen).toEqual([]);
    await view({ itemId: 'k1', include: 'keyframes' }, {}, id => seen.push(id));
    expect(seen).toEqual(['k1']);
  });
});

describe('T19 C4 beats: input validation (before any target)', () => {
  const beats = (extra: Rec, id = 'nope') => view({ itemId: id, include: 'beats', ...extra });
  const INVALID = (error: string) => ({ success: false, code: 'INVALID_TOOL_INPUT', error });
  it('beatsFrom / beatsTo must both be finite numbers with from < to', async () => {
    const range = 'beatsFrom and beatsTo must define a finite, increasing time range.';
    for (const extra of [{ beatsFrom: 1 }, { beatsTo: 2 }, { beatsFrom: NaN, beatsTo: 2 }, { beatsFrom: 1, beatsTo: Infinity }, { beatsFrom: 2, beatsTo: 2 }, { beatsFrom: 3, beatsTo: 2 }, { beatsFrom: '1', beatsTo: 2 }]) {
      const { r, service } = await beats(extra);
      expect(r, JSON.stringify(extra)).toEqual(INVALID(range)); expect(service.rhythm).not.toHaveBeenCalled(); // not ITEM_NOT_FOUND: validation comes first
    }
  });
  it('subdivisionsPerBeat must be 2, 3 or 4 (a numeric string is accepted)', async () => {
    for (const subdivisionsPerBeat of [5, 1, 'x', 2.5]) expect((await beats({ subdivisionsPerBeat })).r, String(subdivisionsPerBeat)).toEqual(INVALID('subdivisionsPerBeat must be 2, 3, or 4.'));
    const ok = (await beats({ subdivisionsPerBeat: '3', beatsFrom: 2, beatsTo: 4 }, 'audio_1')).r;
    expect(ok.data.beats.subdivisions.divisionsPerBeat).toBe(3);
    expect((await beats({ subdivisionsPerBeat: 2, beatsFrom: 2, beatsTo: 4 }, 'audio_1')).r.data.beats.subdivisions.divisionsPerBeat).toBe(2);
  });
  it('minStrength must be a number from 0 to 1', async () => {
    for (const minStrength of [-0.1, 2, 'a', NaN, '0.5']) expect((await beats({ minStrength })).r, String(minStrength)).toEqual(INVALID('minStrength must be a number from 0 to 1.'));
    for (const minStrength of [0, 1]) expect((await beats({ minStrength, beatsFrom: 2, beatsTo: 4 }, 'audio_1')).r.success).toBe(true);
  });
  it('the same validation applies to a batch', async () => {
    expect((await view({ itemIds: ['a1', 'audio_1'], include: 'beats', beatsFrom: 5, beatsTo: 1 })).r).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT' });
  });
});

describe('T19 C4 beats: single target', () => {
  const beats = (input: Rec, s: Setup = {}) => view({ include: 'beats', ...input }, s);
  it('an audio asset without a window → { bpm, firstDownbeat } only', async () => {
    const { r, service } = await beats({ assetId: 'audio_1' });
    expect(r).toEqual({ success: true, data: { beats: { bpm: 120, firstDownbeat: 0.5 } } });
    expect(service.rhythm).toHaveBeenCalledTimes(1);
    expect(service.rhythm.mock.calls[0][1]).toMatchObject({ id: 'asset-aud1' });
  });
  it('with a window: beats and downbeats in [from, to), subdivisions (default 4, interpolated)', async () => {
    const { r } = await beats({ assetId: 'audio_1', beatsFrom: 2, beatsTo: 4 });
    expect(r.data.beats).toEqual({ bpm: 120, firstDownbeat: 0.5,
      beats: [[2, 0.4], [2.5, 0.9], [3, 0.4], [3.5, 0.9]], downbeats: [[2.5, 0.9]],
      subdivisions: { divisionsPerBeat: 4, method: 'interpolated', timestamps: [2.125, 2.25, 2.375, 2.625, 2.75, 2.875, 3.125, 3.25, 3.375, 3.625, 3.75, 3.875] } });
    expect(r.data.beats).toEqual(readBeats(RHYTHM, { from: 2, to: 4, divisionsPerBeat: 4 }));
  });
  it('minStrength filters beats and downbeats; subdivisionsPerBeat changes the divisions', async () => {
    const { r } = await beats({ assetId: 'audio_1', beatsFrom: 2, beatsTo: 4, minStrength: 0.8, subdivisionsPerBeat: 2 });
    expect(r.data.beats.beats).toEqual([[2.5, 0.9], [3.5, 0.9]]); expect(r.data.beats.downbeats).toEqual([[2.5, 0.9]]);
    expect(r.data.beats.subdivisions).toMatchObject({ divisionsPerBeat: 2, method: 'interpolated' });
    expect(r.data.beats.subdivisions.timestamps).toEqual([2.25, 2.75, 3.25, 3.75]);
  });
  it('a video asset is a soft result: success with beats null and noBeats; the service is not asked', async () => {
    const { r, service } = await beats({ assetId: 'video_1' });
    expect(r).toEqual({ success: true, data: { beats: null, noBeats: "'video_1' is a video. Beat data comes from music audio; inspect the music track instead." } });
    expect((await beats({ assetId: 'image_1' })).r.data.noBeats).toBe("'image_1' is an image. Beat data comes from music audio; inspect the music track instead.");
    expect(service.rhythm).not.toHaveBeenCalled();
  });
  it('a video / image item is soft too: "<id> is a video item. Beat data exists only for music audio."', async () => {
    const v = await beats({ itemId: 'v1' });
    expect(v.r).toEqual({ success: true, data: { beats: null, noBeats: "'v1' is a video item. Beat data exists only for music audio." } });
    expect((await beats({ itemId: 'i1' })).r.data.noBeats).toBe("'i1' is an image item. Beat data exists only for music audio.");
    expect(v.service.rhythm).not.toHaveBeenCalled();
  });
  it('a service row with no analysis (not music) is soft with the BEATS_NOT_MUSIC text', async () => {
    const { r } = await beats({ assetId: 'audio_1' }, { rhythm: a => rhythmRow(a, null) });
    expect(r).toEqual({ success: true, data: { beats: null, noBeats: "'audio_1' is not tagged as music (its analysis treats it as speech or sound), so it has no beat data." } });
    expect(BEATS.notMusic('audio_1')).toBe(r.data.noBeats);
  });
  it('processing / uploading → BEATS_PROCESSING (hard); processing_status failed → BEATS_FAILED; the service is not asked', async () => {
    const mk = (extra: Rec): Setup => ({ assets: [[asset('asset-aud1', 'audio', 8000, extra), 'audio_1']] });
    for (const status of ['processing', 'uploading']) {
      const { r, service } = await beats({ assetId: 'audio_1' }, mk({ processing_status: status }));
      expect(r).toEqual({ success: false, code: 'BEATS_PROCESSING', error: "'audio_1' is still being analyzed. Beat data for music appears when processing finishes; check again shortly." });
      expect(service.rhythm).not.toHaveBeenCalled();
    }
    const failed = await beats({ assetId: 'audio_1' }, mk({ processing_status: 'failed' }));
    expect(failed.r).toEqual({ success: false, code: 'BEATS_FAILED', error: BEATS.failed('audio_1') }); expect(failed.service.rhythm).not.toHaveBeenCalled();
    expect(BEATS.failed('audio_1')).toContain("'audio_1'");
  });
  it('a missing source (OBJECT_MISSING, or the item\'s asset gone) → SOURCE_ASSET_UNAVAILABLE', async () => {
    const miss = await beats({ assetId: 'audio_1' }, { assets: [[asset('asset-aud1', 'audio', 8000, { last_error_code: 'OBJECT_MISSING' }), 'audio_1']] });
    expect(miss.r).toEqual({ success: false, code: 'SOURCE_ASSET_UNAVAILABLE', error: sourceUnavailable('audio_1') }); expect(miss.service.rhythm).not.toHaveBeenCalled();
    const gone = await beats({ itemId: 'a1' }, { assets: [] });
    expect(gone.r).toEqual({ success: false, code: 'SOURCE_ASSET_UNAVAILABLE', error: sourceUnavailable('a1') });
  });
  it('service errors: ANALYSIS_UNAVAILABLE keeps code and message; WORKSPACE_FILE_MISSING / OBJECT_MISSING → SOURCE_ASSET_UNAVAILABLE; anything else → BEATS_FAILED', async () => {
    const throwing = (err: unknown): Setup => ({ rhythm: () => { throw err; } });
    expect((await beats({ assetId: 'audio_1' }, throwing({ code: 'ANALYSIS_UNAVAILABLE', message: 'Beat detection needs the local sound model, which is not installed in this browser.' }))).r)
      .toEqual({ success: false, code: 'ANALYSIS_UNAVAILABLE', error: 'Beat detection needs the local sound model, which is not installed in this browser.' });
    for (const code of ['WORKSPACE_FILE_MISSING', 'OBJECT_MISSING']) expect((await beats({ assetId: 'audio_1' }, throwing({ code, message: 'x' }))).r).toEqual({ success: false, code: 'SOURCE_ASSET_UNAVAILABLE', error: sourceUnavailable('audio_1') });
    for (const err of [new Error('boom'), { code: 'ANALYSIS_WORKER_FAILED', message: 'x' }, 'text', undefined]) expect((await beats({ assetId: 'audio_1' }, throwing(err))).r, String(err)).toEqual({ success: false, code: 'BEATS_FAILED', error: BEATS.failed('audio_1') });
  });
  it('an unknown id is a plain failure (ITEM_NOT_FOUND), not a soft result', async () => {
    expect((await beats({ itemId: 'nope' })).r).toEqual({ success: false, code: 'ITEM_NOT_FOUND', error: notFound('nope') });
  });
});

describe('T19 C4 beats: items (trim, rate, remap)', () => {
  // a1: timeline 10–12 s, trim 2–6 s of the source, rate 2 → timeline = 10 + (source − 2) / 2; bpm doubles.
  const tl = (s: number) => 10 + (s - 2) / 2;
  const beats = (input: Rec, s: Setup = {}) => view({ include: 'beats', itemId: 'a1', ...input }, s);
  it('no window: bpm × rate and the first downbeat inside the trim, in timeline seconds', async () => {
    expect((await beats({})).r).toEqual({ success: true, data: { beats: { bpm: 240, firstDownbeat: 10.25 } } }); // source 2.5 s, not 0.5 s (before the trim)
  });
  it('a source beat at 3 s lands at 10.5 s; beats outside the trim never appear', async () => {
    const { r } = await beats({ beatsFrom: 0, beatsTo: 100 }); // wider than the item: clamped
    const times = r.data.beats.beats.map((b: number[]) => b[0]);
    expect(times).toEqual([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5].map(tl)); expect(times).toContain(10.5);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(10); expect(Math.max(...times)).toBeLessThan(12);
    expect(r.data.beats.beats[2]).toEqual([10.5, 0.4]); // strengths are kept
    expect(r.data.beats.downbeats).toEqual([[10.25, 0.9], [11.25, 0.9]]); // source 2.5 and 4.5; 0.5 and 6.5 are hidden
    expect(r.data.beats.subdivisions.timestamps.every((t: number) => t >= 10 && t < 12)).toBe(true);
  });
  it('the window is in timeline seconds and clamped to the item', async () => {
    const { r } = await beats({ beatsFrom: 9, beatsTo: 11 }); // source [2, 4)
    expect(r.data.beats.beats.map((b: number[]) => b[0])).toEqual([2, 2.5, 3, 3.5].map(tl));
    expect(r.data.beats).toMatchObject({ bpm: 240, firstDownbeat: 10.25 });
    expect(r.data.beats.subdivisions).toMatchObject({ divisionsPerBeat: 4, method: 'interpolated' });
    expect(r.data.beats.subdivisions.timestamps).toEqual([2.125, 2.25, 2.375, 2.625, 2.75, 2.875, 3.125, 3.25, 3.375, 3.625, 3.75, 3.875].map(tl));
    const narrow = await beats({ beatsFrom: 10.4, beatsTo: 10.6, minStrength: 0 }); // source [2.8, 3.2)
    expect(narrow.r.data.beats.beats).toEqual([[10.5, 0.4]]);
  });
  it('a window wholly outside the item → empty arrays (bpm and firstDownbeat still given)', async () => {
    for (const [beatsFrom, beatsTo] of [[20, 30], [0, 5]]) {
      expect((await beats({ beatsFrom, beatsTo })).r.data.beats, `${beatsFrom}-${beatsTo}`).toEqual({ bpm: 240, firstDownbeat: 10.25, beats: [], downbeats: [], subdivisions: { divisionsPerBeat: 4, method: 'interpolated', timestamps: [] } });
    }
  });
  it('firstDownbeat is null when no downbeat lies inside the trim', async () => {
    const quiet = [mkItem('q1', 'A1', 0, 1000, { type: 'audio', trim: { from: 5000, to: 6000 }, metadata: { assetId: 'asset-aud1' } })];
    expect((await view({ itemId: 'q1', include: 'beats' }, { items: quiet })).r.data.beats).toEqual({ bpm: 120, firstDownbeat: null }); // downbeats at 4.5 and 6.5
  });
  it('minStrength applies to items', async () => {
    const { r } = await beats({ beatsFrom: 9, beatsTo: 11, minStrength: 0.8 });
    expect(r.data.beats.beats).toEqual([[10.25, 0.9], [10.75, 0.9]]);
  });
  it('a time-remapped item: no window → bpm and firstDownbeat null; with a window → RHYTHM_TIME_REMAP_UNSUPPORTED', async () => {
    expect((await view({ itemId: 'r1', include: 'beats' })).r).toEqual({ success: true, data: { beats: { bpm: null, firstDownbeat: null } } });
    expect((await view({ itemId: 'r1', include: 'beats', beatsFrom: 1, beatsTo: 2 })).r).toEqual({ success: false, code: 'RHYTHM_TIME_REMAP_UNSUPPORTED',
      error: 'Timeline rhythm is unavailable for a time-remapped clip; inspect its source asset for source-clock rhythm.' });
    expect(BEATS.remap).toBe('Timeline rhythm is unavailable for a time-remapped clip; inspect its source asset for source-clock rhythm.');
  });
});

describe('T19 C4 beats: batch', () => {
  const ok = { bpm: 120, firstDownbeat: 0.5 }, a2 = { bpm: 120, firstDownbeat: 20.5 }; // a2: item at 20 s, trim 0–2 s
  it('{ beatsBySource, unavailable? }: every id with beats is keyed by the id it was asked with', async () => {
    const { r } = await view({ itemIds: ['a2'], assetIds: ['audio_1'], include: 'beats' });
    expect(r).toEqual({ success: true, data: { beatsBySource: { a2, audio_1: ok } } });
    expect(r.data).not.toHaveProperty('unavailable');
  });
  it('soft reasons go to unavailable as { success: false, code, error } while the rest succeed', async () => {
    const { r } = await view({ itemIds: ['a2', 'v1'], assetIds: ['video_1'], include: 'beats' });
    expect(r.success).toBe(true); expect(Object.keys(r.data.beatsBySource)).toEqual(['a2']);
    expect(r.data.unavailable).toEqual({
      v1: { success: false, code: 'BEATS_NOT_AUDIO', error: "'v1' is a video item. Beat data exists only for music audio." },
      video_1: { success: false, code: 'BEATS_NOT_AUDIO', error: "'video_1' is a video. Beat data comes from music audio; inspect the music track instead." } });
  });
  it('a hard reason beside a success is listed under unavailable and does not fail the call', async () => {
    const { r } = await view({ itemIds: ['a2', 'nope'], include: 'beats' });
    expect(r.success).toBe(true); expect(r.data.beatsBySource).toEqual({ a2 });
    expect(r.data.unavailable).toEqual({ nope: { success: false, code: 'ITEM_NOT_FOUND', error: notFound('nope') } });
  });
  it('all soft → success with beatsBySource {} and unavailable', async () => {
    const { r } = await view({ itemIds: ['v1', 'i1'], include: 'beats' });
    expect(r).toMatchObject({ success: true, data: { beatsBySource: {} } });
    expect(Object.keys(r.data.unavailable)).toEqual(['v1', 'i1']);
  });
  it('nothing usable and at least one hard reason → BEATS_UNAVAILABLE with the reasons joined by a space', async () => {
    const { r } = await view({ itemIds: ['v1', 'nope'], include: 'beats' });
    expect(r).toEqual({ success: false, code: 'BEATS_UNAVAILABLE',
      error: `${BEATS.notAudioItem('v1', 'video')} ${notFound('nope')}`,
      unavailable: { v1: { success: false, code: 'BEATS_NOT_AUDIO', error: BEATS.notAudioItem('v1', 'video') }, nope: { success: false, code: 'ITEM_NOT_FOUND', error: notFound('nope') } } });
  });
  it('the service is asked one source at a time (no overlap)', async () => {
    let active = 0, max = 0;
    const rhythm = async (a: Asset) => { active++; max = Math.max(max, active); await new Promise(res => setTimeout(res, 5)); active--; return rhythmRow(a); };
    const { r, service } = await view({ itemIds: ['a1', 'a2'], assetIds: ['audio_1', 'audio_2'], include: 'beats' }, { rhythm });
    expect(Object.keys(r.data.beatsBySource)).toEqual(['a1', 'a2', 'audio_1', 'audio_2']);
    expect(service.rhythm).toHaveBeenCalledTimes(4); expect(max).toBe(1);
  });
});

describe('T19 C5 snapToBeats', () => {
  it('an asset: the moves equal snapCuts over the stored rhythm (source seconds)', async () => {
    const { ctx } = setup();
    const cuts = [0.6, 1.9, 7.9, 20];
    for (const subdivisionsPerBeat of [undefined, 4 as const]) {
      const r = await snapToBeats(ctx, { id: 'audio_1', cuts, tolerance: 0.2, subdivisionsPerBeat }) as Rec;
      expect(r).toEqual({ success: true, data: { moves: snapCuts(cuts, RHYTHM, 0.2, subdivisionsPerBeat) } });
    }
    const plain = (await snapToBeats(ctx, { id: 'audio_1', cuts: [0.6, 1.9], tolerance: 0.2 }) as Rec).data.moves;
    expect(plain.map((m: Rec) => [m.index, m.to])).toEqual([[0, 0.5], [1, 2]]);
  });
  it('an item: cuts and moves in timeline seconds, tolerance × rate in the source, only beats inside the trim', async () => {
    const { ctx } = setup();
    // a1: timeline = 10 + (source − 2) / 2. 10.2 → source 2.4 → beat 2.5 → 10.25; 11.45 → 4.9 → 5 → 11.5.
    const r = await snapToBeats(ctx, { id: 'a1', cuts: [10.2, 11.45, 30], tolerance: 0.1 }) as Rec;
    expect(r).toEqual({ success: true, data: { moves: [{ index: 0, from: 10.2, to: 10.25, delta: 0.05 }, { index: 1, from: 11.45, to: 11.5, delta: 0.05 }] } });
  });
  it('beats outside the trim are never targets: a cut just before or after the item finds nothing', async () => {
    const { ctx } = setup();
    // 9.7 → source 1.4 (beat 1.5 is outside the trim); 12.3 → source 6.6 (beat 6.5 is outside).
    expect(await snapToBeats(ctx, { id: 'a1', cuts: [9.7, 12.3], tolerance: 0.1 })).toEqual({ success: true, data: { moves: [] } });
    // the same cut in the source asset does move
    expect(((await snapToBeats(ctx, { id: 'audio_1', cuts: [1.4], tolerance: 0.2 })) as Rec).data.moves[0].to).toBe(1.5);
  });
  it('a time-remapped item → RHYTHM_TIME_REMAP_UNSUPPORTED', async () => {
    const { ctx } = setup();
    expect(await snapToBeats(ctx, { id: 'r1', cuts: [50.2], tolerance: 0.1 })).toEqual({ success: false, code: 'RHYTHM_TIME_REMAP_UNSUPPORTED', error: BEATS.remap });
  });
  it('soft and hard reasons come back as { success: false, code, error }', async () => {
    const { ctx } = setup();
    expect(await snapToBeats(ctx, { id: 'video_1', cuts: [1], tolerance: 0.1 })).toEqual({ success: false, code: 'BEATS_NOT_AUDIO', error: BEATS.notAudioAsset('video_1', 'video') });
    expect(await snapToBeats(ctx, { id: 'v1', cuts: [1], tolerance: 0.1 })).toEqual({ success: false, code: 'BEATS_NOT_AUDIO', error: BEATS.notAudioItem('v1', 'video') });
    expect(await snapToBeats(ctx, { id: 'nope', cuts: [1], tolerance: 0.1 })).toEqual({ success: false, code: 'ITEM_NOT_FOUND', error: notFound('nope') });
    expect(await snapToBeats(ctx, { id: 'tpl_x', cuts: [1], tolerance: 0.1 })).toMatchObject({ success: false, code: 'TEMPLATE_ASSET_NOT_IN_PROJECT' });
    const notMusic = setup({ rhythm: a => rhythmRow(a, null) });
    expect(await snapToBeats(notMusic.ctx, { id: 'audio_1', cuts: [1], tolerance: 0.1 })).toEqual({ success: false, code: 'BEATS_NOT_MUSIC', error: BEATS.notMusic('audio_1') });
    const failing = setup({ rhythm: () => { throw new Error('boom'); } });
    expect(await snapToBeats(failing.ctx, { id: 'audio_1', cuts: [1], tolerance: 0.1 })).toEqual({ success: false, code: 'BEATS_FAILED', error: BEATS.failed('audio_1') });
    const busy = setup({ assets: [[asset('asset-aud1', 'audio', 8000, { processing_status: 'processing' }), 'audio_1']] });
    expect(await snapToBeats(busy.ctx, { id: 'audio_1', cuts: [1], tolerance: 0.1 })).toEqual({ success: false, code: 'BEATS_PROCESSING', error: BEATS.processing('audio_1') });
  });
  it('a negative tolerance (asset or item), or a non-finite cut → INVALID_ANALYSIS_INPUT', async () => {
    const { ctx } = setup();
    for (const id of ['audio_1', 'a1']) {
      expect(await snapToBeats(ctx, { id, cuts: [1], tolerance: -0.1 }), id).toEqual({ success: false, code: 'INVALID_ANALYSIS_INPUT', error: 'Tolerance must be nonnegative.' });
      expect(await snapToBeats(ctx, { id, cuts: [NaN], tolerance: 0.1 }), id).toMatchObject({ success: false, code: 'INVALID_ANALYSIS_INPUT' });
    }
  });
});
