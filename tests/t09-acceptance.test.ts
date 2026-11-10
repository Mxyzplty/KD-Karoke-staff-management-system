// SPDX-License-Identifier: AGPL-3.0-only
// M12 closes stored-item proof gaps using OT-7 word inputs and independently transcribed §44.3 style expectations.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { addCaptionsPanel } from '../apps/web/src/captions/tools';
import { bindingsOf } from '../apps/web/src/captions/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { callTool } from '../apps/web/src/timeline/tools';
import type { Transcript } from '../apps/web/src/analysis/types';
import type { RecordData } from '../apps/web/src/store/model';
import { build, mkTrack, video } from './t03-fixtures';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/OT-7 caption chunk cases (C).json', import.meta.url), 'utf8'));
const part = (id: string) => fixture.cases.find((c: any) => c.id === id);
const segment = (id: string, speaker: number) => {
  const words = part(id).wordList.map((w: any) => ({ word: w.text, start: w.startS - (id === 'W2-M18' ? 0 : 45), end: w.endS - (id === 'W2-M18' ? 0 : 45) }));
  return { id: speaker, speaker, start: words[0].start, end: words.at(-1).end, text: words.map((w: any) => w.word).join(' '), words };
};
const transcript = (segments: Transcript['segments']): Transcript => ({ language: 'en', languages: ['en'], total_duration: 45, segments });
const speech = transcript([segment('W2-M18', 0)]);
const sourceData = (transcript: Transcript) => ({ status: 'complete' as const, transcript, music: false });
const caps = (doc: any) => doc.items.filter((i: any) => i.type === 'caption').sort((a: any, b: any) => a.display.from - b.display.from);
const val = (i: RecordData, k: string) => i.properties[k]?.defaultValue;

it('M12 CAP-P05 full OT-7 four-speaker panel generation creates C1..C4 in source/speaker order with newest on top and per-asset keys', () => {
  const a = video('speech', 'V1', 0, 45000, 0, 45000), b = video('action', 'V1', 45000, 75000, 0, 30000);
  a.metadata.assetId = 'asset-speech'; b.metadata.assetId = 'asset-action';
  const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [a, b] }));
  const action = transcript([segment('W2-M15', 0), segment('W2-M17', 1), segment('W2-M16', 2)]);
  const provider = (id: string) => sourceData(id === 'asset-speech' ? speech : action);
  const before = structuredClone(e.doc);
  e.bus.run('Add captions', 'user', doc => addCaptionsPanel(doc, { source: 'speech', splitBySpeaker: true }, provider));
  const tracks = e.doc.tracks.filter(t => t.kind === 'caption');
  expect(tracks.map(t => t.name)).toEqual(['C1', 'C2', 'C3', 'C4']);
  expect(e.doc.layerOrder.slice(-4)).toEqual(tracks.map(t => ({ type: 'track', id: t.id })));
  expect(tracks.map(t => t.metadata)).toEqual(['asset-speech:0', 'asset-action:0', 'asset-action:1', 'asset-action:2'].map(speakerKey => ({ speakerKey, captionGenerator: 'panel', captionGeneratorOwnsTrack: true })));
  expect(tracks.map(t => caps(e.doc).filter((i: RecordData) => i.trackId === t.id).length)).toEqual([1, 5, 3, 3]);
  for (const [n, id] of ['W2-M18', 'W2-M15', 'W2-M17', 'W2-M16'].entries()) {
    const list = caps(e.doc).filter((i: RecordData) => i.trackId === tracks[n].id);
    expect(list.map((i: RecordData) => i.details.text)).toEqual(part(id).expectedChunks.map((c: any) => c.text));
    list.forEach((i: RecordData) => {
      expect(i).not.toHaveProperty('speaker'); expect(i.details).not.toHaveProperty('speaker'); expect(i.metadata).not.toHaveProperty('speaker');
      expect(i.metadata.captionSource.sourceAssetId).toBe(n === 0 ? 'asset-speech' : 'asset-action');
      expect(i.metadata.captionGeneratorSourceItemId).toBe(n === 0 ? 'speech' : 'action');
      expect([i.details.fontFamily, val(i, 'fontWeight'), val(i, 'fontSize'), val(i, 'color')]).toEqual(['OpenSans-Regular', '400', 65, '#FFFFFF']);
    });
  }
  expect(e.labels()).toEqual(['Add captions']); e.bus.undo(); expect(e.doc).toEqual(before);
});

it('M12 CAP-P06/CT-15 W3-RF-05 stores all four exact remnants, project intervals and trim offsets', () => {
  const e = createEditor(build({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption')], items: [video('v1', 'V1', 0, 45000, 0, 45000)] }));
  const ctx = { bus: e.bus, asset: () => undefined, captionData: () => sourceData(speech) };
  expect(callTool(ctx, 'addCaptions', { trackId: 'C1' }).success).toBe(true);
  const before = structuredClone(e.doc);
  expect(callTool(ctx, 'addCaptions', { trackId: 'C1', startTime: 3, endTime: 4, maxWords: 1, maxCharacters: 10 }).success).toBe(true);
  expect(caps(e.doc).map((i: RecordData) => [i.details.text, i.display, i.trim ?? null])).toEqual([
    ['This', { from: 2960, to: 3120 }, { from: 0, to: 160 }], ['is', { from: 3180, to: 3480 }, null],
    ['pretty', { from: 3480, to: 3880 }, { from: 0, to: 400 }], ['freaky.', { from: 3880, to: 4840 }, { from: 920, to: 1880 }],
  ]);
  expect(bindingsOf(e.doc.items.find(i => i.id === 'v1'))[0].range).toEqual({ startMs: 3000, endMs: 4000 });
  e.bus.undo(); expect(e.doc).toEqual(before);
});

// Every measured column of §44.3; expected values do not import the product template catalogue.
const rows = [
  ['default', 'Roboto-Black', '900', 'normal', 65, '#FFFFFF', 'none', 'normal', 0, [0, 2, 12, 'rgba(0, 0, 0, 0.75)'], 'default', { animationDurationMs: 100, slideDistance: 14 }, null, 3, 20],
  ['cinema', 'Cormorant-Bold', '700', 'normal', 65, '#E6C069', 'none', '0.35em', 0, [0, 0, 0, 'transparent'], 'default', {}, null, 4, 15],
  ['editorial', 'PlayfairDisplay-Italic', '400', 'italic', 85, '#FFFFFF', 'none', 'normal', 0, [0, 2, 6, 'rgba(0, 0, 0, 0.5)'], 'slide-up', { animationDurationMs: 50, slideDistance: 20 }, null, 3, 10],
  ['handwritten', 'Satisfy-Regular', '400', 'normal', 75, '#FFFFFF', 'none', 'normal', 0, [0, 6, 20, 'rgba(0, 0, 0, 0.25)'], 'slide-up', { animationDurationMs: 100, slideDistance: 10 }, null, 3, 15],
  ['karaoke-pop', 'Anton-Regular', '400', 'normal', 90, '#FFFFFF', 'uppercase', '0.02em', 0, [0, 4, 14, 'rgba(0, 0, 0, 0.6)'], 'highlight', { highlightColor: '#FFE600', highlightScale: 1.08 }, null, 3, 15],
  ['punch', 'BebasNeue-Regular', '400', 'normal', 160, '#FFFFFF', 'uppercase', '0.04em', 4, [0, 0, 0, 'transparent'], 'default', {}, null, 1, 14],
  ['subtitle', 'OpenSans-Bold', '700', 'normal', 56, '#FFFFFF', 'none', 'normal', 0, [0, 2, 6, 'rgba(0, 0, 0, 0.85)'], 'default', {}, null, 5, 22],
  ['tiktok', 'Inter-Bold', '700', 'normal', 60, '#FFFFFF', 'none', 'normal', 12, [0, 0, 0, 'transparent'], 'default', {}, null, 5, 22],
  ['8-bit', 'PressStart2P-Regular', '400', 'normal', 50, '#E5987D', 'none', 'normal', 0, [6, 10, 0, '#2E334D'], 'default', { animationDurationMs: 100, slideDistance: 14 }, { preset: 'typewriter', speed: 3.25 }, 3, 15],
] as const;
for (const landscape of [false, true]) for (const r of rows) it(`M12 CAP-P07 all measured stored ${r[0]} style fields and chunk settings (${landscape ? 'landscape measured overrides' : 'portrait'})`, () => {
  const size = landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  const e = createEditor(build({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption')], items: [video('v1', 'V1', 0, 45000, 0, 45000)], extra: { size } }));
  const ctx = { bus: e.bus, asset: () => undefined, captionData: () => sourceData(speech) };
  expect(callTool(ctx, 'addCaptions', { trackId: 'C1', templateId: r[0] }).success).toBe(true);
  const c = caps(e.doc)[0], sh = val(c, 'boxShadow');
  // Portrait plus only the explicitly measured landscape overrides (§44.3; parent Q5); inherited fields remain provisional.
  const expected: unknown[] = structuredClone(r.slice(1, 13)); let maxWords: number = r[13], maxCharacters: number = r[14];
  if (landscape) {
    if (r[0] === 'cinema') { expected[3] = 52; expected[5] = 'uppercase'; }
    if (r[0] === 'editorial') { expected[3] = 70; maxWords = 5; maxCharacters = 22; }
    if (r[0] === 'handwritten') { maxWords = 5; maxCharacters = 30; }
    if (r[0] === 'karaoke-pop') expected[3] = 80;
    if (r[0] === '8-bit') { expected[8] = [7, 7, 0, '#4C5274']; expected[11] = { preset: 'typewriter', speed: 3 }; maxCharacters = 20; }
  }
  expect([c.details.fontFamily, val(c, 'fontWeight'), val(c, 'fontStyle'), val(c, 'fontSize'), val(c, 'color'), val(c, 'textTransform'), val(c, 'letterSpacing'), val(c, 'borderWidth'), [sh.x, sh.y, sh.blur, sh.color], c.details.renderMode, c.details.renderConfig, c.details.textAnimation ?? null]).toEqual(expected);
  expect(val(c, 'backgroundColor')).toBe('transparent'); expect(val(c, 'borderColor')).toBe('#000000'); expect(val(c, 'positionY')).toBe(r[0] === 'punch' ? Math.round(size.height / 2 - .6 * Number(expected[3])) : Math.round(.7 * size.height));
  expect(bindingsOf(e.doc.items.find(i => i.id === 'v1'))[0].options).toEqual({ maxWords, maxCharacters, breakOnPunctuation: true, breakOnConjunctions: true });
});
