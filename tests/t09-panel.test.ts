// SPDX-License-Identifier: AGPL-3.0-only
// T09 the Captions panel seam: addCaptionsPanel (the panel's Generate — it auto-creates its caption track(s), defaults to
// PANEL_STYLE, honours the two break flags and carries its own generation button) and the caption-only editCaptionTransform
// (scale / rotation / X / Y; the shared editProperties caption whitelist stays style + text), plus the generateCaptions and
// editCaptionTransform intents through the runtime (one bus command each; the panel's millisecond range → the generator's
// seconds). Oracle: the §44 panel defaults, the §5 error-code table, and CHUNK_DEFAULTS. Box metrics are the Node fallback,
// so no pixel checks here.
import { describe, expect, it } from 'vitest';
import { addCaptionsPanel } from '../apps/web/src/captions/tools';
import { CAPTION_TRANSFORM_KEYS, editCaptionTransform } from '../apps/web/src/captions/properties';
import type { SourceData } from '../apps/web/src/captions/generation';
import type { Transcript } from '../apps/web/src/analysis/types';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { CommandError, isCaption } from '../apps/web/src/timeline/model';
import { assets, build, links, mkItem, mkTrack, video } from './t03-fixtures';

const seg = (words: [string, number, number][], speaker = 0) => ({ id: speaker, start: words[0][1], end: words[words.length - 1][2], text: words.map(w => w[0]).join(' '), speaker, words: words.map(([word, start, end]) => ({ word, start, end })) });
// Source-local times are 20000–24000 ms (trim 20000, clip 10000–14000), so the words land ~10200–13900 ms on the timeline.
const WORDS: [string, number, number][] = [['alpha', 20.2, 20.6], ['beta', 21.5, 21.9], ['gamma', 22.5, 22.9], ['delta', 23.5, 23.9]];
const transcript = (words = WORDS): Transcript => ({ language: 'en', languages: ['en'], total_duration: 30, segments: [seg(words)] });
const dataOf = (t: Transcript | null = transcript(), music = false): SourceData => ({ status: 'complete', transcript: t, music });
const provider = (d: SourceData = dataOf()) => (_id: string) => d;

const docWith = (extra: { tracks?: RecordData[]; items?: RecordData[] } = {}) =>
  build({ tracks: extra.tracks ?? [mkTrack('V1', 'video')], items: extra.items ?? [video('v1', 'V1', 10000, 14000, 20000, 60000)] });
const caps = (doc: ProjectDocument) => doc.items.filter(isCaption).sort((a, b) => a.display.from - b.display.from);
const val = (i: RecordData, k: string) => i.properties[k]?.defaultValue;
const captionTracks = (doc: ProjectDocument) => doc.tracks.filter(t => t.kind === 'caption');
const thrown = (fn: () => unknown): CommandError => { try { fn(); } catch (e) { if (e instanceof CommandError) return e; throw e; } throw new Error('expected a CommandError'); };

describe('T09 panel: addCaptionsPanel (Generate)', () => {
  it('auto-creates a caption track (none exists), places the captions on it, defaults to PANEL_STYLE (Open Sans Regular 65)', () => {
    const doc = docWith();
    const r = addCaptionsPanel(doc, { source: 'speech', maxWords: 1 }, provider());
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(captionTracks(doc)).toHaveLength(1);                          // created by pickTrack, not required of the panel
    const c = caps(doc);
    expect(c).toHaveLength(4);
    expect(c.every(x => x.trackId === captionTracks(doc)[0].id)).toBe(true);
    expect([val(c[0], 'fontWeight'), val(c[0], 'fontSize')]).toEqual(['400', 65]);   // PANEL_STYLE, NOT the agent's Roboto 700
    expect(c[0].details.fontFamilyDisplay).toBe('Open Sans');
  });

  it('the panel Size / Stroke override onto the manual default: fontSize / borderWidth change, the family stays Open Sans Regular', () => {
    const doc = docWith();
    addCaptionsPanel(doc, { source: 'speech', maxWords: 1, fontSize: 120, borderWidth: 8 }, provider());
    const c = caps(doc)[0];
    expect([val(c, 'fontSize'), val(c, 'borderWidth')]).toEqual([120, 8]);           // the sliders win
    expect([val(c, 'fontWeight'), c.details.fontFamilyDisplay]).toEqual(['400', 'Open Sans']);  // base is PANEL_STYLE, not AGENT_STYLE
  });

  it('honours the panel break flags (the agent path keeps them on): breakOnPunctuation false does not split at a sentence end', () => {
    const words: [string, number, number][] = [['hello', 20.2, 20.5], ['world.', 20.6, 20.9], ['foo', 21.1, 21.4], ['bar', 21.5, 21.8]];
    const on = docWith(); addCaptionsPanel(on, { source: 'speech', maxWords: 10 }, provider(dataOf(transcript(words))));
    const off = docWith(); addCaptionsPanel(off, { source: 'speech', maxWords: 10, breakOnPunctuation: false }, provider(dataOf(transcript(words))));
    expect(caps(on)).toHaveLength(2);         // closes after "world."
    expect(caps(off)).toHaveLength(1);         // the whole line, one caption
  });

  it('splitBySpeaker with no ids auto-creates one caption track per detected speaker', () => {
    const doc = docWith();
    const two: Transcript = { language: 'en', languages: ['en'], total_duration: 30, segments: [seg([['a', 20.2, 20.6], ['b', 21, 21.4]], 0), seg([['c', 22, 22.4], ['d', 23, 23.4]], 1)] };
    const r = addCaptionsPanel(doc, { source: 'speech', splitBySpeaker: true, maxWords: 1 }, provider(dataOf(two)));
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(captionTracks(doc)).toHaveLength(2);
    expect((r.data as RecordData).speakers).toHaveLength(2);
  });

  it('the panel source button is used directly (TC-4): "video" captions the video only, not a non-voiceover audio clip', () => {
    const items = [video('v1', 'V1', 10000, 14000, 20000, 60000), mkItem('a1', 'A1', 10000, 14000, { type: 'audio', trim: { from: 20000, to: 24000 }, sourceDuration: 60000, metadata: { assetId: 'asset-aud1' } })];
    const tracks = [mkTrack('V1', 'video'), mkTrack('A1', 'audio')];
    const vid = docWith({ tracks, items }); addCaptionsPanel(vid, { source: 'video', maxWords: 1 }, provider());
    const speech = docWith({ tracks: [mkTrack('V1', 'video'), mkTrack('A1', 'audio')], items: [video('v1', 'V1', 10000, 14000, 20000, 60000), mkItem('a1', 'A1', 10000, 14000, { type: 'audio', trim: { from: 20000, to: 24000 }, sourceDuration: 60000, metadata: { assetId: 'asset-aud1' } })] });
    addCaptionsPanel(speech, { source: 'speech', maxWords: 1 }, provider());
    const sourcesOf = (doc: ProjectDocument) => [...new Set(caps(doc).map(c => c.captionSourceItemId))].sort();
    expect(sourcesOf(vid)).toEqual(['v1']);                 // video button → the video only (pre-fix this leaked to 'speech')
    expect(sourcesOf(speech)).toEqual(['a1', 'v1']);        // speech button → video + non-voiceover audio
  });
});

describe('T09 panel: editCaptionTransform (caption-only geometry)', () => {
  const rig = (locked = false) => {
    const doc = docWith({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption', { locked })], items: [video('v1', 'V1', 10000, 14000, 20000, 60000)] });
    addCaptionsPanel(doc, { source: 'speech', trackId: 'C1', maxWords: 1 }, provider());
    return doc;
  };
  it('writes the finite transform keys as stored properties and returns the ids', () => {
    const doc = rig(), id = caps(doc)[0].id;
    expect(editCaptionTransform(doc, [id], { scale: 2, rotation: 15, positionX: 40, positionY: 12 })).toEqual({ updatedIds: [id] });
    const c = caps(doc)[0];
    expect([val(c, 'scale'), val(c, 'rotation'), val(c, 'positionX'), val(c, 'positionY')]).toEqual([2, 15, 40, 12]);
  });
  it('NO_PROPERTIES_PROVIDED when no transform key is present (a style key is not one)', () => {
    const doc = rig(), id = caps(doc)[0].id;
    expect(thrown(() => editCaptionTransform(doc, [id], { color: '#FF0000' })).code).toBe('NO_PROPERTIES_PROVIDED');
    expect(CAPTION_TRANSFORM_KEYS).toEqual(['scale', 'rotation', 'positionX', 'positionY']);
  });
  it('PROPERTY_VALIDATION_FAILED for a non-finite value; CAPTION_NOT_FOUND / INVALID_ITEM_TYPE / TRACK_LOCKED', () => {
    const doc = rig(), id = caps(doc)[0].id;
    const bad = thrown(() => editCaptionTransform(doc, [id], { scale: Number.NaN }));
    expect(bad.code).toBe('PROPERTY_VALIDATION_FAILED');
    expect(thrown(() => editCaptionTransform(doc, ['nope'], { scale: 2 })).code).toBe('CAPTION_NOT_FOUND');
    expect(thrown(() => editCaptionTransform(doc, ['v1'], { scale: 2 })).code).toBe('INVALID_ITEM_TYPE');
    expect(thrown(() => editCaptionTransform(rig(true), [caps(rig(true))[0].id], { scale: 2 })).code).toBe('TRACK_LOCKED');
  });
});

describe('T09 panel: the runtime intents', () => {
  const editor = () => createEditor(docWith(), { assets: assets(), links: links() });
  const gen = (extra: RecordData = {}) => ({ type: 'generateCaptions', button: 'speech', range: null, split: false, maxWords: 1, maxCharacters: 35, breakOnPunctuation: true, breakOnConjunctions: true, reset: false, data: { 'asset-vid1': dataOf() }, ...extra }) as const;

  it('generateCaptions adds captions on an auto-created track under one "Add captions" entry', () => {
    const e = editor();
    const out = e.intent(gen() as unknown as Parameters<typeof e.intent>[0]);
    expect(out?.ok, JSON.stringify(out)).toBe(true);
    expect(caps(e.doc)).toHaveLength(4);
    expect(e.labels()).toEqual(['Add captions']);
  });

  it('generateCaptions carries the panel Size / Stroke through to the stored caption', () => {
    const e = editor();
    e.intent(gen({ fontSize: 120, borderWidth: 8 }) as unknown as Parameters<typeof e.intent>[0]);
    const c = caps(e.doc)[0];
    expect([val(c, 'fontSize'), val(c, 'borderWidth')]).toEqual([120, 8]);
  });

  it('the panel range is milliseconds (converted to the generator seconds): a 1 s window from 0 excludes the ~10 s words', () => {
    const e = editor();
    e.intent(gen({ range: { startMs: 0, endMs: 1000 } }) as unknown as Parameters<typeof e.intent>[0]);
    expect(caps(e.doc)).toHaveLength(0);   // a bug that passed ms straight to toMs would make a 1e6 ms window and keep all four
  });

  it('editCaptionTransform runs one "Edit items" and writes the stored value', () => {
    const e = editor();
    e.intent(gen() as unknown as Parameters<typeof e.intent>[0]);
    const id = caps(e.doc)[0].id;
    const out = e.intent({ type: 'editCaptionTransform', itemIds: [id], properties: { scale: 1.5 } } as unknown as Parameters<typeof e.intent>[0]);
    expect(out?.ok, JSON.stringify(out)).toBe(true);
    expect(val(caps(e.doc)[0], 'scale')).toBe(1.5);
    expect(e.labels()).toEqual(['Add captions', 'Edit items']);
  });
});
