// SPDX-License-Identifier: AGPL-3.0-only
// T09 the caption agent tools: addCaptions, listCaptionTemplates, the source buttons (CAP-P04 a–e, required case 5), the agent vs panel default
// style (required case 6, G-18), split by speaker, ranged generation with remnants (CAP-P06), and the TranscriptRow `music` flag staying out
// of every agent tool result (required case 4). Oracle: agent tool contracts addCaptions, agent tool results §12 (G-18) and the error codes
// table, findings part 3 §44.2–§44.3 and CAP-P04; never the generator's own output. Node text measurement is the approximate fallback, so box
// checks are relational here; glyph and ±2 px box checks belong in the browser spec.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from '../apps/web/src/agent/executor';
import { Executor } from '../apps/web/src/agent/executor';
import type { Transcript } from '../apps/web/src/analysis/types';
import { bindingStyle, generate } from '../apps/web/src/captions/generation';
import { bindingsOf } from '../apps/web/src/captions/model';
import { AGENT_STYLE, PANEL_STYLE, TEMPLATES } from '../apps/web/src/captions/templates';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext } from '../apps/web/src/timeline/tools';
import { assets, build, itemOf, links, mkItem, mkTrack, resetIds, video } from './t03-fixtures';

// The fonts module is browser-only (it imports font files); mock the loaders, keep the real registry (the t05-executor pattern).
const fonts = vi.hoisted(() => ({ loadFont: vi.fn(), loadChainFonts: vi.fn(), loadUserFonts: vi.fn() }));
vi.mock('../apps/web/src/text/fonts', async orig => ({ ...await orig<typeof import('../apps/web/src/text/fonts')>(), ...fonts }));
beforeEach(() => {
  fonts.loadFont.mockReset().mockResolvedValue(undefined);
  fonts.loadChainFonts.mockReset().mockResolvedValue([]);
  fonts.loadUserFonts.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { resetIds(); });

type W = [string, number, number, number?];                        // word, start s, end s, speaker
const transcript = (list: W[], total = 30): Transcript => {
  const speakers = [...new Set(list.map(w => w[3] ?? 0))];
  return { language: 'en', languages: ['en'], total_duration: total, segments: speakers.map((speaker, id) => {
    const words = list.filter(w => (w[3] ?? 0) === speaker).map(([word, start, end]) => ({ word, start, end }));
    return { id, start: words[0].start, end: words[words.length - 1].end, text: words.map(w => w.word).join(' '), speaker, words };
  }) };
};
type Data = { status: 'complete' | 'pending' | 'none'; transcript: Transcript | null; music: boolean };
const SPEECH: W[] = [['alpha', 20.2, 20.6], ['beta', 21, 21.4], ['gamma', 22, 22.4], ['delta', 23, 23.4]];
const source = (extra: RecordData = {}) => video('v1', 'V1', 10000, 14000, 20000, 60000, extra);
const tracks = () => [mkTrack('V1', 'video'), mkTrack('C1', 'caption'), mkTrack('C2', 'caption'), mkTrack('A1', 'audio')];
function rig(items: RecordData[], data: (assetId: string) => Data, doc?: ProjectDocument) {
  const e = createEditor(doc ?? build({ tracks: tracks(), items }), { assets: assets(), links: links() });
  const ctx: ToolContext = { bus: e.bus, asset: id => assets().find(a => a.id === id), captionData: data };
  return { e, ctx, call: (name: string, a: RecordData = {}) => callTool(ctx, name, a) };
}
const speech = (list: W[] = SPEECH, music = false) => (): Data => ({ status: 'complete', transcript: transcript(list), music });
const captions = (doc: ProjectDocument, trackId?: string) => doc.items.filter(i => i.type === 'caption' && (!trackId || i.trackId === trackId)).sort((a, b) => a.display.from - b.display.from);
const texts = (doc: ProjectDocument, trackId?: string) => captions(doc, trackId).map(c => c.details.text);
const val = (i: RecordData, k: string) => i.properties[k]?.defaultValue;
const data = (r: RecordData) => r.data as RecordData;

describe('T09 addCaptions: generation and result envelope (agent tool contracts addCaptions)', () => {
  it('captions the source into the named track; the result lists captionIds, captionCount, trackId and trackIds', () => {
    const r = rig([source()], speech()), res = r.call('addCaptions', { trackId: 'C1' });
    expect(res.success, JSON.stringify(res)).toBe(true);
    const created = captions(r.e.doc);
    expect(created.length).toBeGreaterThan(0);
    expect(data(res)).toMatchObject({ captionCount: created.length, trackId: 'C1', trackIds: ['C1'] });
    expect(data(res).captionIds).toEqual(expect.arrayContaining(created.map(c => c.id)));
    expect(data(res).captionIds).toHaveLength(created.length);
    expect(data(res).replacedCount).toBeUndefined();
    expect(texts(r.e.doc)).toEqual(['alpha beta gamma delta']);                       // 5-word / 35-character defaults keep four short words together
    expect(r.e.labels()).toEqual(['Add captions']);                                  // one undo step
  });

  it('every caption sits on the requested track and inside the source occurrence span plus its hold (0.5 s, capped by the next caption of the same item)', () => {
    const r = rig([source()], speech());
    r.call('addCaptions', { trackId: 'C1', maxWords: 1 });
    expect(captions(r.e.doc).map(c => [c.trackId, c.display.from, c.display.to])).toEqual([['C1', 10200, 11000], ['C1', 11000, 11900], ['C1', 12000, 12900], ['C1', 13000, 13900]]);
  });

  it('maxWords and maxCharacters arguments change the chunking', () => {
    const r = rig([source()], speech());
    r.call('addCaptions', { trackId: 'C1', maxWords: 2 });
    expect(texts(r.e.doc)).toEqual(['alpha beta', 'gamma delta']);
    r.call('addCaptions', { trackId: 'C1', maxWords: 5, maxCharacters: 12 });
    expect(texts(r.e.doc)).toEqual(['alpha beta', 'gamma delta']);                    // "alpha beta gamma" = 16 > 12; "alpha beta" = 10 fits
  });

  it('a second run replaces the earlier generated captions: replacedCount says how many', () => {
    const r = rig([source()], speech());
    r.call('addCaptions', { trackId: 'C1', maxWords: 1 });
    const res = r.call('addCaptions', { trackId: 'C1', maxWords: 2 });
    expect(data(res).replacedCount).toBe(4);
    expect(texts(r.e.doc)).toEqual(['alpha beta', 'gamma delta']);
  });

  it('no transcript: nothing is captioned, the source is reported as unresolved (missing coverage, not silence)', () => {
    const r = rig([source()], () => ({ status: 'none', transcript: null, music: false })), res = r.call('addCaptions', { trackId: 'C1' });
    expect(res.success).toBe(true);
    expect(captions(r.e.doc)).toHaveLength(0);
    expect(data(res).unresolvedSources).toEqual(['v1']);
    expect(bindingsOf(itemOf(r.e.doc, 'v1'))[0].coverage.map(c => c.state)).toEqual(['unresolved']);
  });

  it('an inaudible (muted) source gives no captions and result.warning INAUDIBLE_SOURCES naming it', () => {
    const r = rig([source({ muted: true })], speech()), res = r.call('addCaptions', { trackId: 'C1' });
    expect(res).toMatchObject({ success: true, warning: 'INAUDIBLE_SOURCES' });
    expect(data(res).inaudibleSources).toEqual(['v1']);
    expect(data(res).captionCount).toBe(0);
    expect(captions(r.e.doc)).toHaveLength(0);
    expect(res.message).toMatch(/inaudible/i);
  });

  it('a muted TRACK and a hidden item are inaudible too', () => {
    const muted = rig([], speech(), build({ tracks: [mkTrack('V1', 'video', { muted: true }), mkTrack('C1', 'caption')], items: [source()] }));
    expect(muted.call('addCaptions', { trackId: 'C1' })).toMatchObject({ warning: 'INAUDIBLE_SOURCES' });
    const hidden = rig([source({ hidden: true })], speech());
    expect(hidden.call('addCaptions', { trackId: 'C1' })).toMatchObject({ warning: 'INAUDIBLE_SOURCES' });
  });

  it('refusals: MISSING_TRACK_ID, TRACK_NOT_FOUND, INVALID_TRACK (not a caption track); nothing changes and the call may not have run', () => {
    const r = rig([source()], speech()), before = JSON.stringify(r.e.doc);
    expect(r.call('addCaptions', {})).toMatchObject({ success: false, code: 'MISSING_TRACK_ID' });
    expect(r.call('addCaptions', { trackId: 'nope' })).toMatchObject({ success: false, code: 'TRACK_NOT_FOUND' });
    expect(r.call('addCaptions', { trackId: 'V1' })).toMatchObject({ success: false, code: 'INVALID_TRACK' });
    expect(JSON.stringify(r.e.doc)).toBe(before);
    expect(r.e.labels()).toEqual([]);
  });

  it('splitBySpeaker validates every speakerTrackId (TC-2): a missing or non-caption id refuses before any change', () => {
    const r = rig([source()], speech()), before = JSON.stringify(r.e.doc);
    expect(r.call('addCaptions', { splitBySpeaker: true })).toMatchObject({ success: false, code: 'MISSING_TRACK_ID' });
    expect(r.call('addCaptions', { splitBySpeaker: true, speakerTrackIds: [] })).toMatchObject({ success: false, code: 'MISSING_TRACK_ID' });
    expect(r.call('addCaptions', { splitBySpeaker: true, speakerTrackIds: ['C1', 'nope'] })).toMatchObject({ success: false, code: 'TRACK_NOT_FOUND' });
    expect(r.call('addCaptions', { splitBySpeaker: true, speakerTrackIds: ['C1', 'V1'] })).toMatchObject({ success: false, code: 'INVALID_TRACK' });
    expect(JSON.stringify(r.e.doc)).toBe(before);
    expect(r.e.labels()).toEqual([]);
  });

  it('a locked caption track refuses (TRACK_LOCKED) and changes nothing', () => {
    const r = rig([], speech(), build({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption', { locked: true })], items: [source()] }));
    expect(r.call('addCaptions', { trackId: 'C1' })).toMatchObject({ success: false, code: 'TRACK_LOCKED' });
    expect(captions(r.e.doc)).toHaveLength(0);
  });

  it('the captions are linked to their source: captionSourceItemId and a binding on the source occurrence', () => {
    const r = rig([source()], speech()); r.call('addCaptions', { trackId: 'C1' });
    const [c] = captions(r.e.doc), [b] = bindingsOf(itemOf(r.e.doc, 'v1'));
    expect(c.captionSourceItemId).toBe('v1');
    expect(c.metadata.captionBindingId).toBe(b.id);
    expect(b.tokens.map(t => [t.text, t.startMs, t.endMs])).toEqual([['alpha', 20200, 20600], ['beta', 21000, 21400], ['gamma', 22000, 22400], ['delta', 23000, 23400]]);
  });
});

describe('T09 required case 6 / G-18: the addCaptions no-style default is AGENT_STYLE; the panel default is PANEL_STYLE', () => {
  const run = () => { const r = rig([source()], speech()); r.call('addCaptions', { trackId: 'C1' }); return captions(r.e.doc)[0]; };

  it('agent default: Roboto Bold (700) 65, white, stroke 3, shadow 0/0/0 black, centred text', () => {
    const c = run();
    expect(c.details.fontFamilyDisplay).toBe('Roboto');
    expect(c.details.fontFamily).toBe('Roboto-Bold');
    expect([val(c, 'fontWeight'), val(c, 'fontSize'), val(c, 'color'), val(c, 'borderWidth'), val(c, 'textAlign'), val(c, 'fontStyle')]).toEqual(['700', 65, '#FFFFFF', 3, 'center', 'normal']);
    expect(val(c, 'boxShadow')).toEqual({ color: '#000000', x: 0, y: 0, blur: 0 });
    expect(c.details.renderMode).toBe('default');
  });

  it('panel default (the generator with PANEL_STYLE): Open Sans Regular (400) 65 — not the agent look', () => {
    const r = rig([source()], speech());
    r.e.bus.run('Add captions', 'user', doc => { generate(doc, { button: 'speech', trackId: 'C1', chunk: { maxWords: 5, maxCharacters: 35, breakOnConjunctions: true, breakOnSentenceEnd: true } as never, style: bindingStyle(PANEL_STYLE, doc.size.height) }, speech(), bindingStyle(PANEL_STYLE, doc.size.height)); return { success: true }; });
    const c = captions(r.e.doc)[0];
    expect(c.details.fontFamilyDisplay).toBe('Open Sans');
    expect(c.details.fontFamily).not.toMatch(/bold/i);
    expect([val(c, 'fontWeight'), val(c, 'fontSize'), val(c, 'color'), val(c, 'borderWidth')]).toEqual(['400', 65, '#FFFFFF', 3]);
  });

  it('the two styles differ exactly in family and weight (G-18: the agent path is Roboto Bold, the panel Open Sans Regular)', () => {
    expect([AGENT_STYLE.family, AGENT_STYLE.fontWeight, AGENT_STYLE.fontSize]).toEqual(['Roboto', '700', 65]);
    expect([PANEL_STYLE.family, PANEL_STYLE.fontWeight, PANEL_STYLE.fontSize]).toEqual(['Open Sans', '400', 65]);
    expect(AGENT_STYLE.borderWidth).toBe(PANEL_STYLE.borderWidth);
  });

  it('caption position: the top of the box is 0.70 × canvas height (bottom third, §44.3) and the box is centred horizontally', () => {
    const r = rig([source()], speech()); r.call('addCaptions', { trackId: 'C1' });
    const c = captions(r.e.doc)[0], w = Number(val(c, 'width')), x = Number(val(c, 'positionX'));
    expect(val(c, 'positionY')).toBe(Math.round(0.7 * r.e.doc.size.height));
    expect(Math.abs(x - (r.e.doc.size.width - w) / 2)).toBeLessThanOrEqual(1);
  });

  it('style arguments sit on top of the agent default: color, fontSize, borderWidth, backgroundColor; the rest stays AGENT_STYLE', () => {
    const r = rig([source()], speech()); r.call('addCaptions', { trackId: 'C1', color: '#FF0000', fontSize: 40, borderWidth: 5, backgroundColor: '#00000080' });
    const c = captions(r.e.doc)[0];
    expect([val(c, 'color'), val(c, 'fontSize'), val(c, 'borderWidth'), val(c, 'backgroundColor'), val(c, 'fontWeight')]).toEqual(['#FF0000', 40, 5, '#00000080', '700']);
  });

  it('font argument: a registry font is used; an unknown one is FONT_UNAVAILABLE and nothing is added', () => {
    const r = rig([source()], speech());
    expect(r.call('addCaptions', { trackId: 'C1', font: 'Open Sans' }).success).toBe(true);
    expect(captions(r.e.doc)[0].details.fontFamilyDisplay).toBe('Open Sans');
    const r2 = rig([source()], speech());
    expect(r2.call('addCaptions', { trackId: 'C1', font: 'No Such Font 123' })).toMatchObject({ success: false, code: 'FONT_UNAVAILABLE' });
    expect(captions(r2.e.doc)).toHaveLength(0);
  });
});

describe('T09 templates (findings §44.3, ticket "the 9 templates\' style values")', () => {
  it('listCaptionTemplates returns the nine templates, in order, with id, name, limits and a defaultColor', () => {
    const r = rig([source()], speech()), res = r.call('listCaptionTemplates', {});
    const list = data(res).templates as { id: string; name: string; maxWords: number; maxCharacters: number; defaultColor: string; description: string; tags: string[] }[];
    expect(list.map(t => t.id)).toEqual(['default', 'cinema', 'editorial', 'handwritten', 'karaoke-pop', 'punch', 'subtitle', 'tiktok', '8-bit']);
    expect(list.map(t => [t.maxWords, t.maxCharacters])).toEqual([[3, 20], [4, 15], [3, 10], [3, 15], [3, 15], [1, 14], [5, 22], [5, 22], [3, 15]]);   // portrait canvas
    for (const t of list) { expect(t.name).toBeTruthy(); expect(t.description).toBeTruthy(); expect(t.defaultColor).toMatch(/^#|^rgb/); }
    expect(r.e.labels()).toEqual([]);                                                  // read-only: no undo step
  });

  const FAMILY: Record<string, string> = { default: 'Roboto', cinema: 'Cormorant', editorial: 'Playfair Display', handwritten: 'Satisfy', 'karaoke-pop': 'Anton', punch: 'Bebas Neue', subtitle: 'Open Sans', tiktok: 'Inter', '8-bit': 'Press Start 2P' };
  const SIZE: Record<string, number> = { default: 65, cinema: 65, editorial: 85, handwritten: 75, 'karaoke-pop': 90, punch: 160, subtitle: 56, tiktok: 60, '8-bit': 50 };
  for (const t of TEMPLATES) {
    it(`template '${t.id}': family ${FAMILY[t.id]}, size ${SIZE[t.id]} on a portrait canvas`, () => {
      const r = rig([source()], speech()), res = r.call('addCaptions', { trackId: 'C1', templateId: t.id });
      expect(res.success, JSON.stringify(res)).toBe(true);
      const c = captions(r.e.doc)[0];
      expect(c.details.fontFamilyDisplay).toBe(FAMILY[t.id]);
      expect(val(c, 'fontSize')).toBe(SIZE[t.id]);
      expect(bindingsOf(itemOf(r.e.doc, 'v1'))[0].options).toMatchObject({ maxWords: t.limits.maxWords, maxCharacters: t.limits.maxCharacters });
    });
  }

  it('portrait values from §44.3: karaoke-pop uppercase with highlight mode; punch one word, centred; tiktok stroke 12; 8-bit pixel shadow; editorial italic slide-up', () => {
    const style = (templateId: string) => { const r = rig([source()], speech()); r.call('addCaptions', { trackId: 'C1', templateId }); return captions(r.e.doc)[0]; };
    expect([val(style('karaoke-pop'), 'textTransform'), style('karaoke-pop').details.renderMode]).toEqual(['uppercase', 'highlight']);
    const punch = style('punch');
    expect(texts({ items: [punch] } as never)).toEqual(['ALPHA']);                    // uppercase look stores upper-cased display text
    expect(val(punch, 'positionY')).toBe(Math.round(1920 / 2 - 0.6 * 160));
    expect(val(style('tiktok'), 'borderWidth')).toBe(12);
    expect(val(style('8-bit'), 'boxShadow')).toMatchObject({ x: 6, y: 10, blur: 0 });
    const ed = style('editorial');
    expect([val(ed, 'fontStyle'), ed.details.renderMode]).toEqual(['italic', 'slide-up']);
  });

  it('landscape canvas overrides (§44.3): editorial 5 / 22, handwritten 5 / 30, 8-bit 3 / 20; cinema keeps 4 / 15 but uppercases at 52', () => {
    const doc = build({ tracks: tracks(), items: [source()], extra: { size: { width: 1920, height: 1080 } } });
    const opts = (templateId: string) => { const r = rig([], speech(), structuredClone(doc)); r.call('addCaptions', { trackId: 'C1', templateId }); return { r, o: bindingsOf(itemOf(r.e.doc, 'v1'))[0].options }; };
    expect(opts('editorial').o).toMatchObject({ maxWords: 5, maxCharacters: 22 });
    expect(opts('handwritten').o).toMatchObject({ maxWords: 5, maxCharacters: 30 });
    expect(opts('8-bit').o).toMatchObject({ maxWords: 3, maxCharacters: 20 });
    const cin = opts('cinema');
    expect(cin.o).toMatchObject({ maxWords: 4, maxCharacters: 15 });
    const c = captions(cin.r.e.doc)[0];
    expect([val(c, 'textTransform'), val(c, 'fontSize')]).toEqual(['uppercase', 52]);
  });

  it('an unknown template id is CAPTION_TEMPLATE_NOT_FOUND with nothing added', () => {
    const r = rig([source()], speech());
    expect(r.call('addCaptions', { trackId: 'C1', templateId: 'neon' })).toMatchObject({ success: false, code: 'CAPTION_TEMPLATE_NOT_FOUND' });
    expect(captions(r.e.doc)).toHaveLength(0);
    expect(r.e.labels()).toEqual([]);
  });

  it('style arguments override the template (the template is the base, the argument wins)', () => {
    const r = rig([source()], speech()); r.call('addCaptions', { trackId: 'C1', templateId: 'tiktok', borderWidth: 2, color: '#00FF00' });
    const c = captions(r.e.doc)[0];
    expect([val(c, 'borderWidth'), val(c, 'color'), c.details.fontFamilyDisplay]).toEqual([2, '#00FF00', 'Inter']);
  });
});

describe('T09 split by speaker (ticket: 5 / 3 / 3 / 1 on tracks C1…C4 with one style)', () => {
  const two: W[] = [['hello', 20.2, 20.6, 0], ['there', 21, 21.4, 0], ['general', 22, 22.4, 1], ['kenobi', 23, 23.4, 1]];

  it('one caption track per detected speaker, in detected order; result.speakers has key, track, count and a defaultColor; one shared style', () => {
    const r = rig([source()], speech(two)), res = r.call('addCaptions', { splitBySpeaker: true, speakerTrackIds: ['C1', 'C2'] });
    expect(res.success, JSON.stringify(res)).toBe(true);
    const speakers = data(res).speakers as { speakerKey: string; captionTrackId: string; captionCount: number; defaultColor: string }[];
    expect(speakers.map(s => [s.captionTrackId, s.captionCount])).toEqual([['C1', 1], ['C2', 1]]);
    for (const s of speakers) { expect(s.speakerKey).toBeTruthy(); expect(s.defaultColor).toMatch(/^#/); }
    expect(speakers[0].defaultColor).not.toBe(speakers[1].defaultColor);
    expect(texts(r.e.doc, 'C1')).toEqual(['hello there']);
    expect(texts(r.e.doc, 'C2')).toEqual(['general kenobi']);
    expect(val(captions(r.e.doc, 'C1')[0], 'color')).toBe(val(captions(r.e.doc, 'C2')[0], 'color'));
    expect(val(captions(r.e.doc, 'C1')[0], 'fontSize')).toBe(val(captions(r.e.doc, 'C2')[0], 'fontSize'));
  });

  it('INSUFFICIENT_TRACK_IDS when fewer track ids than speakers; MISSING_TRACK_ID without any; nothing changes', () => {
    const r = rig([source()], speech(two)), before = JSON.stringify(r.e.doc);
    expect(r.call('addCaptions', { splitBySpeaker: true, speakerTrackIds: ['C1'] })).toMatchObject({ success: false, code: 'INSUFFICIENT_TRACK_IDS' });
    expect(r.call('addCaptions', { splitBySpeaker: true })).toMatchObject({ success: false, code: 'MISSING_TRACK_ID' });
    expect(JSON.stringify(r.e.doc)).toBe(before);
  });

  it('an unknown or non-caption speaker track id is TRACK_NOT_FOUND / INVALID_TRACK', () => {
    const r = rig([source()], speech(two));
    expect(r.call('addCaptions', { splitBySpeaker: true, speakerTrackIds: ['zzz'] }).success).toBe(false);
    expect(r.call('addCaptions', { splitBySpeaker: true, speakerTrackIds: ['V1'] }).success).toBe(false);
    expect(captions(r.e.doc)).toHaveLength(0);
  });
});

describe('T09 ranged generation with remnants (CAP-P06, W3-RF-05)', () => {
  const run = () => {
    const r = rig([source()], speech());
    r.call('addCaptions', { trackId: 'C1' });                                         // one caption "alpha beta gamma delta" [10200, 13900)
    return r;
  };

  it('a range inside one caption splits it: the words outside stay as remnant captions, the words inside are regenerated', () => {
    const r = run(), res = r.call('addCaptions', { trackId: 'C1', startTime: 11, endTime: 12.5 });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(texts(r.e.doc)).toEqual(['alpha', 'beta gamma', 'delta']);
    const [left, mid, right] = captions(r.e.doc);
    expect([left.display.from, left.display.to]).toEqual([10200, 10600]);              // left remnant ends at its own last word
    expect(mid.display.from).toBe(11000);
    expect([right.display.from, right.display.to]).toEqual([13000, 13900]);            // right remnant keeps the old end
  });

  it('the range leaves other captions alone: a caption entirely outside it keeps its id, track and text', () => {
    const r = rig([source()], speech()); r.call('addCaptions', { trackId: 'C1', maxWords: 1 });
    const before = captions(r.e.doc).map(c => [c.id, c.details.text]);
    const res = r.call('addCaptions', { trackId: 'C1', maxWords: 1, startTime: 10.9, endTime: 12.5 });
    expect(data(res).replacedCount).toBe(2);                                          // "beta" and "gamma" only
    const after = captions(r.e.doc).map(c => [c.id, c.details.text]);
    expect(after.map(x => x[1])).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect(after[0]).toEqual(before[0]); expect(after[3]).toEqual(before[3]);
  });

  it('a range with no words in it replaces nothing', () => {
    const r = run(), before = JSON.stringify(captions(r.e.doc));
    r.call('addCaptions', { trackId: 'C1', startTime: 5, endTime: 6 });
    expect(JSON.stringify(captions(r.e.doc))).toBe(before);
  });

  it('coverage after a range run: only the range is marked complete (the rest is a gap, not requested)', () => {
    const r = rig([source()], speech());
    r.call('addCaptions', { trackId: 'C1', startTime: 11, endTime: 12.5 });
    expect(bindingsOf(itemOf(r.e.doc, 'v1'))[0].coverage).toEqual([{ fromMs: 21000, toMs: 22500, state: 'complete' }]);
  });
});

describe('T09 source buttons — CAP-P04 (a)–(e), required case 5 (findings part 3 §44.2, CAP-P04 wave-3 cases)', () => {
  const song: W[] = [['la', 20.2, 20.6], ['la', 21, 21.4], ['la', 22, 22.4], ['laa', 23, 23.4]];
  const vo = () => mkItem('vo1', 'A1', 0, 4000, { type: 'audio', playbackRate: 1, trim: { from: 0, to: 4000 }, sourceDuration: 4000, metadata: { assetId: 'asset-aud1', isVoiceover: true } });
  const audio = () => mkItem('au1', 'A1', 0, 4000, { type: 'audio', playbackRate: 1, trim: { from: 0, to: 4000 }, sourceDuration: 4000, metadata: { assetId: 'asset-aud1' } });
  const songRig = (music: boolean) => rig([source()], speech(song, music));

  it('(a) the song clip alone: Speech = Video only = Everything give the same captions', () => {
    const got = ['speech', 'all'].map(s => { const r = songRig(true); r.call('addCaptions', { trackId: 'C1', source: s }); return captions(r.e.doc).map(c => [c.display.from, c.display.to, c.details.text]); });
    expect(got[0].length).toBeGreaterThan(0);
    expect(got[1]).toEqual(got[0]);
  });

  it('(b) Music lyrics on a music clip gives the same captions (documented improvement; Xapp: 0)', () => {
    const base = songRig(true); base.call('addCaptions', { trackId: 'C1', source: 'speech' });
    const r = songRig(true), res = r.call('addCaptions', { trackId: 'C1', source: 'music' });
    expect(res.success).toBe(true);
    expect(captions(r.e.doc).map(c => [c.display.from, c.display.to, c.details.text])).toEqual(captions(base.e.doc).map(c => [c.display.from, c.display.to, c.details.text]));
  });

  it('(b) the classifier flag alone decides: the same transcript on a clip the classifier called NOT music gives no lyrics captions', () => {
    const r = songRig(false), res = r.call('addCaptions', { trackId: 'C1', source: 'music' });
    expect(res.success).toBe(true);
    expect(captions(r.e.doc)).toHaveLength(0);
    expect(data(res).captionCount).toBe(0);
  });

  it('(c) a voice-over with a finished transcript is captioned from its words (Everything covers it)', () => {
    const r = rig([vo()], (id) => id === 'asset-aud1' ? { status: 'complete', transcript: transcript(SPEECH.map(([w, s, e]) => [w, s - 20, e - 20] as W)), music: false } : { status: 'none', transcript: null, music: false },
      build({ tracks: tracks(), items: [vo()] }));
    const res = r.call('addCaptions', { trackId: 'C1', source: 'all' });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(texts(r.e.doc)).toEqual(['alpha beta gamma delta']);
    expect(captions(r.e.doc)[0].captionSourceItemId).toBe('vo1');
  });

  it('(c) Speech skips a voice-over item and takes the plain audio item (the voice-over has its own button)', () => {
    const r = rig([], (id) => id === 'asset-aud1' ? { status: 'complete', transcript: transcript([['x', 0.2, 0.6]]), music: false } : { status: 'none', transcript: null, music: false },
      build({ tracks: tracks(), items: [vo()] }));
    r.call('addCaptions', { trackId: 'C1', source: 'speech' });
    expect(captions(r.e.doc)).toHaveLength(0);
  });

  it('(d) a run that finds no words leaves the generated caption of clip 1 in place and removes 0', () => {
    const r = songRig(false); r.call('addCaptions', { trackId: 'C1', source: 'speech' });
    const before = JSON.stringify(captions(r.e.doc)), res = r.call('addCaptions', { trackId: 'C1', source: 'music' });   // clip is not music: no words
    expect(res.success).toBe(true);
    expect(JSON.stringify(captions(r.e.doc))).toBe(before);
    expect(data(res).replacedCount ?? 0).toBe(0);
    expect(data(res).captionCount).toBe(0);
  });

  it('(d) a source with no transcript (voice-over not yet transcribed) also leaves earlier captions and removes 0', () => {
    const r = rig([source(), vo()], (id) => id === 'asset-vid1' ? { status: 'complete', transcript: transcript(song), music: false } : { status: 'none', transcript: null, music: false });
    r.call('addCaptions', { trackId: 'C1', source: 'speech' });
    const before = JSON.stringify(captions(r.e.doc));
    const res = r.call('addCaptions', { trackId: 'C2', sourceItems: ['vo1'] });
    expect(res.success).toBe(true);
    expect(JSON.stringify(captions(r.e.doc))).toBe(before);
    expect(data(res).replacedCount ?? 0).toBe(0);
  });

  it('a run removes only earlier captions of the sources it covers; captions of another source stay (§44.1 step 8)', () => {
    const other = video('v2', 'V1', 20000, 24000, 0, 10000, { metadata: { assetId: 'asset-vid2' } });
    const r = rig([source(), other], (id) => ({ status: 'complete', transcript: transcript(id === 'asset-vid1' ? SPEECH : [['zulu', 1, 1.4], ['yankee', 2, 2.4]]), music: false }));
    r.call('addCaptions', { trackId: 'C1' });
    const v2caps = captions(r.e.doc).filter(c => c.captionSourceItemId === 'v2').map(c => c.id);
    expect(v2caps.length).toBeGreaterThan(0);
    r.call('addCaptions', { trackId: 'C1', sourceItems: ['v1'], maxWords: 1 });
    expect(captions(r.e.doc).filter(c => c.captionSourceItemId === 'v2').map(c => c.id)).toEqual(v2caps);
    expect(captions(r.e.doc).filter(c => c.captionSourceItemId === 'v1')).toHaveLength(4);
  });

  it('(e) the result depends on the document only: the same call twice on equal documents gives equal captions', () => {
    const a = songRig(true), b = songRig(true);
    a.call('addCaptions', { trackId: 'C1', source: 'all' }); b.call('addCaptions', { trackId: 'C1', source: 'all' });
    const shape = (doc: ProjectDocument) => captions(doc).map(c => [c.display.from, c.display.to, c.details.text]);
    expect(shape(a.e.doc)).toEqual(shape(b.e.doc));
  });
});

// ---- required case 4: the TranscriptRow `music` flag never reaches an agent tool result. Through the Executor with a real stored-row shape.
describe('T09 required case 4: TranscriptRow.music stays internal (viewItemDetails, context, addCaptions results never carry it)', () => {
  const keysOf = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach(x => keysOf(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
    return out;
  };
  const store = (music: boolean | undefined) => ({
    row: async (table: string, id: string) => table === 'transcripts' && id === 'asset-vid1'
      ? { id, status: 'complete', transcript: transcript(SPEECH), ...(music === undefined ? {} : { music }), created_at: '2026-11-05T00:00:00Z' } : undefined,
    putRow: async () => {}, media: {},
  });
  let n = 0;
  const call = (toolName: string, input: Record<string, unknown>, session = 's1'): Call => ({ type: 'call', callId: `c${++n}`, executionKey: `k${n}`, toolName, input, session });
  const exec = (music: boolean | undefined) => {
    const e = createEditor(build({ tracks: tracks(), items: [source()] }), { assets: assets(), links: links() });
    const mem = new Map<string, string>();
    const ex = new Executor({ storage: { getItem: k => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } }, current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }),
      analysis: async () => ({ store: store(music), service: { rhythm: async () => { throw new Error('unused'); } } }) as never });
    return { e, ex };
  };

  for (const music of [true, false, undefined]) {
    it(`music flag ${String(music)} on the stored row: no result key named "music" in context, viewItemDetails (transcript) or addCaptions`, async () => {
      const { ex } = exec(music);
      const ctxRes = await ex.execute(call('context', {}));
      const view = await ex.execute(call('viewItemDetails', { itemId: 'v1', include: 'transcript' }));
      const add = await ex.execute(call('addCaptions', { trackId: 'C1' }));
      expect((add as { success: boolean }).success, JSON.stringify(add)).toBe(true);
      for (const [name, res] of Object.entries({ ctxRes, view, add })) expect(keysOf(res), name).not.toContain('music');
    });
  }

  it('the Executor path reads the stored flag: Music lyrics captions a row flagged music and nothing for a row without the flag', async () => {
    const yes = exec(true); await yes.ex.execute(call('context', {}));
    const a = await yes.ex.execute(call('addCaptions', { trackId: 'C1', source: 'music' })) as { success: boolean; data: RecordData };
    expect(a.success, JSON.stringify(a)).toBe(true);
    expect(captions(yes.e.doc).length).toBeGreaterThan(0);
    const no = exec(undefined); await no.ex.execute(call('context', {}));
    const b = await no.ex.execute(call('addCaptions', { trackId: 'C1', source: 'music' })) as { success: boolean };
    expect(b.success).toBe(true);
    expect(captions(no.e.doc)).toHaveLength(0);
  });

  it('a stored row that is still being analysed gives pending coverage: addCaptions reports the source unresolved, adds nothing', async () => {
    const e = createEditor(build({ tracks: tracks(), items: [source()] }), { assets: assets(), links: links() });
    const mem = new Map<string, string>();
    const ex = new Executor({ storage: { getItem: k => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } }, current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }),
      analysis: async () => ({ store: { row: async () => undefined, putRow: async () => {}, media: {} }, service: {} }) as never });
    await ex.execute(call('context', {}));
    const res = await ex.execute(call('addCaptions', { trackId: 'C1' })) as { success: boolean; data: RecordData };
    expect(res.success).toBe(true);
    expect(captions(e.doc)).toHaveLength(0);
    expect(res.data.unresolvedSources).toEqual(['v1']);
  });
});
