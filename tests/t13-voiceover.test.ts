// SPDX-License-Identifier: AGPL-3.0-only
// T13 voice-over: the recorder's pure helpers and the addVoiceover placement through the T03 runtime.
// Oracle: Xapp findings part 2 §30 (codec order, naming, mm:ss timer, "Add items" placement, A1 on a project without an audio track,
// metadata {assetId, agentId, isVoiceover true, isProxy false}, one "Add items" undo entry, toast "Added <agentId> to the timeline", min 100 ms)
// and the T13 ticket. Choices among several existing audio tracks are provisional in the code, so only the unambiguous cases are asserted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';

const notices = vi.hoisted(() => [] as string[]);
vi.mock('../apps/web/src/ui', async importOriginal => ({ ...await importOriginal<typeof import('../apps/web/src/ui')>(), notify: (t: string) => { notices.push(t); } }));

import { MIME_ORDER, recordingType, takeExtension, takeName, timer } from '../apps/web/src/audio/recorder';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, fixture, itemOf, links, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';
import type { Asset, AssetLink } from '../apps/web/src/store/model';

beforeEach(() => { notices.length = 0; useIds(); });
afterEach(() => resetIds());

describe('recordingType (§30: first supported of the codec order)', () => {
  it('order is webm/opus, webm, mp4/aac, mp4', () => {
    expect(MIME_ORDER).toEqual(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']);
  });
  it('picks the first supported type, asking in that order', () => {
    const asked: string[] = [];
    expect(recordingType(t => { asked.push(t); return true; })).toBe('audio/webm;codecs=opus');
    expect(asked).toEqual(['audio/webm;codecs=opus']);
  });
  it.each([
    [['audio/webm'], 'audio/webm'],
    [['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'], 'audio/mp4;codecs=mp4a.40.2'],
    [['audio/mp4'], 'audio/mp4'],
    [['audio/webm', 'audio/mp4'], 'audio/webm'],
  ])('only %j supported → %s', (ok, want) => { expect(recordingType(t => ok.includes(t))).toBe(want); });
  it('none supported → empty string (MediaRecorder default)', () => { expect(recordingType(() => false)).toBe(''); });
});

describe('takeExtension', () => {
  it.each([['audio/mp4', '.m4a'], ['audio/mp4;codecs=mp4a.40.2', '.m4a'], ['audio/webm', '.weba'], ['audio/webm;codecs=opus', '.weba'], ['', '.weba']])('%j → %s', (t, ext) => { expect(takeExtension(t)).toBe(ext); });
});

describe('takeName (§30: "Voiceover YYYY-MM-DD HH:MM:SS", local time)', () => {
  it('zero-pads every field', () => { expect(takeName(new Date(2026, 0, 5, 3, 4, 9))).toBe('Voiceover 2026-01-05 03:04:09'); });
  it('two-digit fields stay as they are', () => { expect(takeName(new Date(2026, 11, 31, 23, 59, 58))).toBe('Voiceover 2026-12-31 23:59:58'); });
  it('midnight', () => { expect(takeName(new Date(2027, 5, 1, 0, 0, 0))).toBe('Voiceover 2027-06-01 00:00:00'); });
});

describe('timer (mm:ss of a running take)', () => {
  it.each([[0, '00:00'], [999, '00:00'], [1000, '00:01'], [59_999, '00:59'], [60_000, '01:00'], [61_500, '01:01'], [599_000, '09:59'], [3_600_000, '60:00']])('%i ms → %s', (ms, s) => { expect(timer(ms)).toBe(s); });
});

// ---- placement
const voiceAsset = (id = 'asset-vo1', durationMs: number | null = 4200): Asset => ({ id, name: 'Voiceover 2026-11-02 10:00:00', type: 'audio', sizeBytes: 5000, mimeType: 'audio/webm', folderId: null,
  created_at: '2026-11-02T10:00:00Z', recorded_at: null, location: `local://${id}`, durationMs } as unknown as Asset);
const voiceLink = (assetId = 'asset-vo1', agent = 'audio_2'): AssetLink => ({ id: `link-${agent}`, projectId: 'p1', assetId, agent_id: agent, content_type: 'audio', added_at: '2026-11-02T10:00:00Z', deleted_at: null });
const take = (atMs: number, durationMs: number, extra: Record<string, unknown> = {}) => ({ type: 'addVoiceover' as const, assetId: 'asset-vo1', agentId: 'audio_2', name: 'Voiceover 2026-11-02 10:00:00', atMs, durationMs, ...extra });
const withVoice = (doc: ProjectDocument) => createEditor(doc, { assets: [...assets(), voiceAsset()], links: [...links(), voiceLink()] });
const audioTracks = (doc: ProjectDocument) => doc.tracks.filter(t => t.kind === 'audio');
const ranges = (doc: ProjectDocument, trackId: string) => doc.items.filter(i => i.trackId === trackId).map(i => [i.display.from, i.display.to]);
const voiceItems = (doc: ProjectDocument) => doc.items.filter(i => i.metadata?.isVoiceover);

describe('placeVoiceover through the addVoiceover intent', () => {
  it('a project with no audio track gets a new audio track named A1 holding the item at the recorded span (§30 measured, §30 parity test)', () => {
    const e = withVoice(build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('v1', 'V1', 0, 18000)] }));
    expect(e.intent(take(10_000, 4200))).toEqual({ ok: true });
    const a = audioTracks(e.doc); expect(a).toHaveLength(1); expect(a[0].name).toBe('A1'); expect(a[0].kind).toBe('audio');
    const v = voiceItems(e.doc); expect(v).toHaveLength(1);
    expect(v[0].trackId).toBe(a[0].id); expect(v[0].type).toBe('audio'); expect(v[0].display).toEqual({ from: 10_000, to: 14_200 });
  });
  it('item metadata is exactly {assetId, agentId, isVoiceover true, isProxy false}; the details name is the take name', () => {
    const e = withVoice(build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('v1', 'V1', 0, 18000)] }));
    e.intent(take(0, 18_204, { name: 'Voiceover 2026-11-02 10:00:00' }));
    const [v] = voiceItems(e.doc);
    expect(v.metadata).toEqual({ assetId: 'asset-vo1', agentId: 'audio_2', isVoiceover: true, isProxy: false });
    expect(v.details.name).toBe('Voiceover 2026-11-02 10:00:00');
    expect(v.display).toEqual({ from: 0, to: 18_204 });
    expect(v.playbackRate).toBe(1);
    expect(v.trim).toEqual({ from: 0, to: 18_204 });
  });
  it('the placement is one "Add items" undo entry and one journal record; undo removes the item and the created track', () => {
    const before = build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('v1', 'V1', 0, 18000)] });
    const e = withVoice(before);
    e.intent(take(2000, 3000));
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0]).toMatchObject({ label: 'Add items', source: 'user' }); expect(e.journal).toHaveLength(1);
    e.intent({ type: 'undo' });
    expect(voiceItems(e.doc)).toHaveLength(0); expect(audioTracks(e.doc)).toHaveLength(0); expect(e.doc.items).toHaveLength(1);
    e.intent({ type: 'redo' });
    expect(voiceItems(e.doc)).toHaveLength(1); expect(audioTracks(e.doc)).toHaveLength(1);
  });
  it('the toast reads "Added <agentId> to the timeline" and only after a successful placement', () => {
    const e = withVoice(fixture());
    e.intent(take(9000, 1000));
    expect(notices).toEqual(['Added audio_2 to the timeline']);
  });
  it('a free existing audio track is reused (no new track)', () => {
    const e = withVoice(fixture()); // A1 holds a1 at 0–5000
    e.intent(take(6000, 2000));
    expect(audioTracks(e.doc)).toHaveLength(1);
    const [v] = voiceItems(e.doc); expect(v.trackId).toBe('A1'); expect(ranges(e.doc, 'A1')).toContainEqual([6000, 8000]);
  });
  it('an item touching the take at its edge does not block the track (a1 ends at 5000, the take starts at 5000)', () => {
    const e = withVoice(fixture());
    e.intent(take(5000, 1000));
    expect(audioTracks(e.doc)).toHaveLength(1); expect(voiceItems(e.doc)[0].trackId).toBe('A1');
  });
  it('a take that overlaps an existing clip goes on a new audio track', () => {
    const e = withVoice(fixture());
    e.intent(take(4000, 3000)); // overlaps a1 (0–5000)
    expect(audioTracks(e.doc)).toHaveLength(2);
    const [v] = voiceItems(e.doc); expect(v.trackId).not.toBe('A1'); expect(itemOf(e.doc, 'a1').trackId).toBe('A1');
    expect(audioTracks(e.doc).find(t => t.id === v.trackId)!.kind).toBe('audio');
  });
  it('a take that encloses an existing clip goes on a new audio track', () => {
    const e = withVoice(fixture());
    e.intent(take(1000, 2000)); // inside a1
    expect(voiceItems(e.doc)[0].trackId).not.toBe('A1');
  });
  it('a locked audio track is skipped even when free: a new unlocked audio track gets the item', () => {
    const doc = fixture(); doc.tracks.find(t => t.id === 'A1')!.locked = true;
    const e = withVoice(doc);
    e.intent(take(9000, 1000));
    const [v] = voiceItems(e.doc); expect(v.trackId).not.toBe('A1');
    const t = e.doc.tracks.find(t => t.id === v.trackId)!; expect(t.kind).toBe('audio'); expect(t.locked).toBeFalsy();
    expect(ranges(e.doc, 'A1')).toEqual([[0, 5000]]);
  });
  it('a locked audio track does not stop the placement when another audio track is free', () => {
    const doc = fixture(); doc.tracks.push(mkTrack('A2', 'audio')); doc.layerOrder.push({ type: 'track', id: 'A2' }); doc.tracks.find(t => t.id === 'A1')!.locked = true;
    const e = withVoice(doc);
    e.intent(take(100, 1000));
    expect(voiceItems(e.doc)[0].trackId).toBe('A2'); expect(audioTracks(e.doc)).toHaveLength(2);
  });
  it('with several free audio tracks the item lands on one of them, no track is added', () => {
    const doc = fixture(); doc.tracks.push(mkTrack('A2', 'audio')); doc.layerOrder.push({ type: 'track', id: 'A2' });
    const e = withVoice(doc);
    e.intent(take(9000, 1000));
    expect(audioTracks(e.doc)).toHaveLength(2); expect(['A1', 'A2']).toContain(voiceItems(e.doc)[0].trackId);
  });
  it('a take shorter than 100 ms is 100 ms long (0 ms, 40 ms, 99 ms)', () => {
    for (const d of [0, 40, 99]) {
      const e = withVoice(fixture());
      e.intent(take(7000, d));
      expect(voiceItems(e.doc)[0].display).toEqual({ from: 7000, to: 7100 });
    }
  });
  it('exactly 100 ms and just above are kept', () => {
    for (const d of [100, 101]) {
      const e = withVoice(fixture());
      e.intent(take(7000, d));
      expect(voiceItems(e.doc)[0].display).toEqual({ from: 7000, to: 7000 + d });
    }
  });
  it('a negative start is clamped to 0', () => {
    const e = withVoice(fixture());
    e.intent(take(-250, 1000));
    expect(voiceItems(e.doc)[0].display.from).toBe(0);
  });
  it('the document duration follows the new item', () => {
    const e = withVoice(build({ tracks: [mkTrack('V1', 'video')], items: [mkItem('v1', 'V1', 0, 2000)] }));
    e.intent(take(1500, 4000));
    expect(e.doc.duration).toBe(5500);
  });
  it('existing items are untouched', () => {
    const doc = fixture(), before = JSON.stringify(doc.items);
    const e = withVoice(doc);
    e.intent(take(9000, 1000));
    expect(JSON.stringify(e.doc.items.filter(i => !i.metadata?.isVoiceover))).toBe(before);
  });
});

describe('addVoiceover with an asset the index does not hold yet (§45.4 late index)', () => {
  it('reloads the index, then places once with the toast', async () => {
    const calls: number[] = [];
    const e = createEditor(fixture(), { assets: assets(), links: links(), options: { loadAssets: async () => { calls.push(1); return { assets: [...assets(), voiceAsset()], links: [...links(), voiceLink()] }; } } });
    expect(e.intent(take(9000, 1000))).toEqual({ ok: true });
    expect(voiceItems(e.doc)).toHaveLength(0); // not yet
    await vi.waitFor(() => expect(voiceItems(e.doc)).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(e.bus.undoStack).toHaveLength(1); expect(e.bus.undoStack[0].label).toBe('Add items');
    expect(notices).toEqual(['Added audio_2 to the timeline']);
  });
  it('an asset the reload still lacks notifies MEDIA_NOT_FOUND and changes nothing', async () => {
    const e = createEditor(fixture(), { assets: assets(), links: links(), options: { loadAssets: async () => ({ assets: assets(), links: links() }) } });
    e.intent(take(9000, 1000));
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toMatch(/^MEDIA_NOT_FOUND: /);
    expect(voiceItems(e.doc)).toHaveLength(0); expect(e.bus.undoStack).toHaveLength(0);
  });
  it('a failing reload notifies MEDIA_NOT_FOUND with the error message', async () => {
    const e = createEditor(fixture(), { assets: assets(), links: links(), options: { loadAssets: async () => { throw new Error('index unreadable'); } } });
    e.intent(take(9000, 1000));
    await vi.waitFor(() => expect(notices).toEqual(['MEDIA_NOT_FOUND: index unreadable']));
    expect(voiceItems(e.doc)).toHaveLength(0);
  });
  it('without a loader an unknown asset fails at once: MEDIA_NOT_FOUND, no entry, no toast', () => {
    const e = createEditor(fixture(), { assets: assets(), links: links() });
    expect(e.intent(take(9000, 1000))).toMatchObject({ ok: false, code: 'MEDIA_NOT_FOUND' });
    expect(e.bus.undoStack).toHaveLength(0); expect(notices).toEqual([]);
  });
});
