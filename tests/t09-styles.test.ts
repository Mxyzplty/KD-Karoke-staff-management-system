// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption style edits (required cases 7 and 8): editAllCaptionStyles (agent tool results §2) and the editProperties caption path
// (single / batch / applyToAll; text is a correction on a linked caption and a re-spread on a detached one; error codes §5).
// Oracle: the written tool results and error-code tables. Node text measurement is the approximate fallback, so box checks are relational
// (grows / does not change / stays centred); the ±2 px glyph box is a browser check.
import { describe, expect, it } from 'vitest';
import { bindingsOf } from '../apps/web/src/captions/model';
import { editCaptionProperties } from '../apps/web/src/captions/properties';
import type { Transcript } from '../apps/web/src/analysis/types';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { CommandError } from '../apps/web/src/timeline/model';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext } from '../apps/web/src/timeline/tools';
import { assets, build, itemOf, links, mkTrack, video } from './t03-fixtures';

const WORDS: [string, number, number][] = [['alpha', 20.2, 20.6], ['beta', 21.5, 21.9], ['gamma', 22.5, 22.9], ['delta', 23.5, 23.9]];
const transcript = (): Transcript => ({ language: 'en', languages: ['en'], total_duration: 30, segments: [{ id: 0, start: 20.2, end: 23.9, text: WORDS.map(w => w[0]).join(' '), speaker: 0, words: WORDS.map(([word, start, end]) => ({ word, start, end })) }] });
function rig(trackExtra: RecordData = {}) {
  const doc = build({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption'), mkTrack('C2', 'caption'), mkTrack('O1', 'overlay')], items: [video('v1', 'V1', 10000, 14000, 20000, 60000)] });
  const e = createEditor(doc, { assets: assets(), links: links() });
  const ctx: ToolContext = { bus: e.bus, asset: id => assets().find(a => a.id === id), captionData: () => ({ status: 'complete', transcript: transcript(), music: false }) };
  const call = (name: string, a: RecordData) => callTool(ctx, name, a);
  expect(call('addCaptions', { trackId: 'C1', maxWords: 1 }).success).toBe(true);        // four one-word captions, linked
  if (trackExtra.locked) e.bus.run('Edit items', 'agent', d => { d.tracks.find(t => t.id === 'C1')!.locked = true; return { success: true }; });
  return { e, ctx, call };
}
const caps = (doc: ProjectDocument, trackId = 'C1') => doc.items.filter(i => i.type === 'caption' && i.trackId === trackId).sort((a, b) => a.display.from - b.display.from);
const val = (i: RecordData, k: string) => i.properties[k]?.defaultValue;
const data = (r: RecordData) => r.data as RecordData;
const details = (r: RecordData) => r.details as RecordData;
const thrown = (fn: () => unknown): CommandError => { try { fn(); } catch (e) { if (e instanceof CommandError) return e; throw e; } throw new Error('expected a CommandError'); };

describe('T09 required case 7: editAllCaptionStyles', () => {
  it('restyles every caption on the track at once: updatedCount, updatedIds, a message naming only the changed fields; ONE undo step', () => {
    const r = rig(), ids = caps(r.e.doc).map(c => c.id);
    const res = r.call('editAllCaptionStyles', { trackId: 'C1', properties: { color: '#FF0000', fontSize: 40 } });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(data(res).updatedCount).toBe(4);
    expect(data(res).updatedIds).toEqual(ids);
    expect(res.message).toMatch(/^Updated 4 captions/);
    expect(res.message).toContain('color: #FF0000');
    expect(res.message).toContain('size: 40px');
    for (const c of caps(r.e.doc)) expect([val(c, 'color'), val(c, 'fontSize')]).toEqual(['#FF0000', 40]);
    expect(r.e.labels().filter(l => l !== 'Add captions')).toHaveLength(1);
  });

  it('the flat argument form (properties beside trackId) is accepted too', () => {
    const r = rig();
    expect(r.call('editAllCaptionStyles', { trackId: 'C1', color: '#00FF00' }).success).toBe(true);
    expect(caps(r.e.doc).every(c => val(c, 'color') === '#00FF00')).toBe(true);
  });

  it('the binding look follows: the next regeneration on the source keeps the new look', () => {
    const r = rig();
    r.call('editAllCaptionStyles', { trackId: 'C1', properties: { color: '#FF0000', fontSize: 40, borderWidth: 7 } });
    expect(bindingsOf(itemOf(r.e.doc, 'v1'))[0].style.properties).toMatchObject({ color: '#FF0000', fontSize: 40, borderWidth: 7 });
    r.call('addCaptions', { trackId: 'C1', maxWords: 2 });                              // regenerate: styled as the track was left
    expect(caps(r.e.doc).map(c => [val(c, 'color'), val(c, 'fontSize'), val(c, 'borderWidth')])).toEqual([['#FF0000', 40, 7], ['#FF0000', 40, 7]]);
  });

  it('font, renderMode, highlightColor and boxShadow land where the stored caption keeps them', () => {
    const r = rig();
    const res = r.call('editAllCaptionStyles', { trackId: 'C1', properties: { fontFamily: 'Open Sans', renderMode: 'highlight', highlightColor: '#FFE600', boxShadow: { color: '#000000', x: 2, y: 3, blur: 4 } } });
    expect(res.success, JSON.stringify(res)).toBe(true);
    const c = caps(r.e.doc)[0];
    expect(c.details.fontFamilyDisplay).toBe('Open Sans');
    expect(c.details.renderMode).toBe('highlight');
    expect(c.details.renderConfig.highlightColor).toBe('#FFE600');
    expect(val(c, 'boxShadow')).toEqual({ color: '#000000', x: 2, y: 3, blur: 4 });
    expect(res.message).toContain('render mode: highlight');
  });

  it('all five render modes are accepted and a sixth is not', () => {
    for (const mode of ['default', 'highlight', 'word-by-word', 'slide-up', 'slide-left']) expect(rig().call('editAllCaptionStyles', { trackId: 'C1', properties: { renderMode: mode } }).success, mode).toBe(true);
    expect(rig().call('editAllCaptionStyles', { trackId: 'C1', properties: { renderMode: 'zoom' } })).toMatchObject({ success: false, code: 'PROPERTY_VALIDATION_FAILED' });
  });

  it('box is re-measured on size, spacing and type changes; a colour change leaves it alone; the box stays centred', () => {
    const box = (c: RecordData) => [Number(val(c, 'width')), Number(val(c, 'height')), Number(val(c, 'positionX'))];
    const grow = (props: RecordData) => { const r = rig(), before = box(caps(r.e.doc)[0]); r.call('editAllCaptionStyles', { trackId: 'C1', properties: props }); return { before, after: box(caps(r.e.doc)[0]), r }; };
    const size = grow({ fontSize: 130 });
    expect(size.after[0]).toBeGreaterThan(size.before[0]); expect(size.after[1]).toBeGreaterThan(size.before[1]);
    // letterSpacing changes the box in the browser (real glyph widths); the Node approximate measurer ignores it, so that check is in the UI spec.
    const spacing = grow({ letterSpacing: '0.5em' });
    const lines = grow({ lineHeight: 2.5 });
    expect(lines.after[1]).toBeGreaterThanOrEqual(lines.before[1]);
    const type = grow({ fontFamily: 'Press Start 2P' });
    // a face change re-measures with real glyphs in the browser; the Node approximate measurer is face-independent, so only the write is checked here
    expect(caps(type.r.e.doc)[0].details.fontFamilyDisplay).toBe('Press Start 2P');
    const colour = grow({ color: '#123456' });
    expect(colour.after).toEqual(colour.before);
    for (const g of [size, type]) { const c = caps(g.r.e.doc)[0]; expect(Math.abs(Number(val(c, 'positionX')) - (g.r.e.doc.size.width - Number(val(c, 'width'))) / 2)).toBeLessThanOrEqual(1); }
    const c = caps(size.r.e.doc)[0];
    expect(c.details.width).toBe(val(c, 'width')); expect(c.details.height).toBe(val(c, 'height'));    // details mirror the stored box
  });

  it('PROPERTY_VALIDATION_FAILED reports ALL problems at once in details.validationErrors; nothing changes', () => {
    const r = rig(), before = JSON.stringify(r.e.doc);
    const res = r.call('editAllCaptionStyles', { trackId: 'C1', properties: { fontSize: 0, color: '12 34!', textAlign: 'middle', opacity: 5, renderMode: 'zoom' } }) as unknown as RecordData;
    expect(res).toMatchObject({ success: false, code: 'PROPERTY_VALIDATION_FAILED' });
    const errs = details(res).validationErrors as { field: string; message: string }[];
    expect(res.data).toBeUndefined(); expect(res.validationErrors).toBeUndefined();
    expect(errs.map(e => e.field).sort()).toEqual(['color', 'fontSize', 'opacity', 'renderMode', 'textAlign']);
    for (const e of errs) expect(e.message).toBeTruthy();
    expect(JSON.stringify(r.e.doc)).toBe(before);
    expect(r.e.labels()).toEqual(['Add captions']);
  });

  it('a valid key beside an invalid one still refuses the whole call (no partial restyle)', () => {
    const r = rig();
    expect(r.call('editAllCaptionStyles', { trackId: 'C1', properties: { color: '#FF0000', fontSize: -3 } })).toMatchObject({ success: false, code: 'PROPERTY_VALIDATION_FAILED' });
    expect(caps(r.e.doc).every(c => val(c, 'color') === '#FFFFFF')).toBe(true);
  });

  it('NO_CAPTIONS on a caption track with none; NO_PROPERTIES_PROVIDED with nothing styleable; MISSING_TRACK_ID; TRACK_NOT_FOUND; TRACK_LOCKED', () => {
    const r = rig(), before = JSON.stringify(r.e.doc);
    expect(r.call('editAllCaptionStyles', { trackId: 'C2', properties: { color: '#FF0000' } })).toMatchObject({ success: false, code: 'NO_CAPTIONS' });
    expect(r.call('editAllCaptionStyles', { trackId: 'C1', properties: {} })).toMatchObject({ success: false, code: 'NO_PROPERTIES_PROVIDED' });
    expect(r.call('editAllCaptionStyles', { trackId: 'C1', properties: { notAStyle: 1 } })).toMatchObject({ success: false, code: 'NO_PROPERTIES_PROVIDED' });
    expect(r.call('editAllCaptionStyles', { properties: { color: '#FF0000' } })).toMatchObject({ success: false, code: 'MISSING_TRACK_ID' });
    expect(r.call('editAllCaptionStyles', { trackId: 'zzz', properties: { color: '#FF0000' } })).toMatchObject({ success: false, code: 'TRACK_NOT_FOUND' });
    expect(JSON.stringify(r.e.doc)).toBe(before);
    expect(rig({ locked: true }).call('editAllCaptionStyles', { trackId: 'C1', properties: { color: '#FF0000' } })).toMatchObject({ success: false, code: 'TRACK_LOCKED' });
  });

  it('Undo restores every caption and the binding look exactly', () => {
    const r = rig(), before = JSON.stringify(r.e.doc);
    r.call('editAllCaptionStyles', { trackId: 'C1', properties: { color: '#FF0000', fontSize: 120, renderMode: 'slide-up' } });
    expect(JSON.stringify(r.e.doc)).not.toBe(before);
    r.e.bus.undo('agent');
    expect(JSON.stringify(r.e.doc)).toBe(before);
  });

  it('text is not a style: it is ignored here (editProperties is the text path) and the call still needs one styleable key', () => {
    const r = rig();
    expect(r.call('editAllCaptionStyles', { trackId: 'C1', properties: { text: 'nope' } })).toMatchObject({ success: false, code: 'NO_PROPERTIES_PROVIDED' });
  });
});

describe('T09 required case 8: the editProperties caption path', () => {
  it('single caption: style keys restyle that caption only; changedFields names stored names', () => {
    const r = rig(), [a, b] = caps(r.e.doc), res = r.call('editProperties', { itemId: a.id, properties: { color: '#FF0000', fontSize: 50 } });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(val(caps(r.e.doc)[0], 'color')).toBe('#FF0000');
    expect(val(caps(r.e.doc)[1], 'color')).toBe('#FFFFFF');
    expect(data(res).itemIds).toEqual([a.id]);
    const changed = (data(res).changedFields as Record<string, string[]>)[a.id];
    expect(changed).toEqual(expect.arrayContaining(['properties.color', 'properties.fontSize']));
    expect(b.id).not.toBe(a.id);
  });

  it('batch: several captions restyled in one call, one undo step', () => {
    const r = rig(), [a, b, c] = caps(r.e.doc), res = r.call('editProperties', { itemIds: [a.id, c.id], properties: { color: '#00FF00' } });
    expect(res.success).toBe(true);
    expect(caps(r.e.doc).map(x => val(x, 'color'))).toEqual(['#00FF00', '#FFFFFF', '#00FF00', '#FFFFFF']);
    expect(b.id).toBeTruthy();
    expect(r.e.labels().filter(l => l !== 'Add captions')).toHaveLength(1);
  });

  it('applyToAll: the style goes to every caption on the track; the result reports appliedToCount (the others)', () => {
    const r = rig(), [a] = caps(r.e.doc), res = r.call('editProperties', { itemId: a.id, properties: { color: '#0000FF', borderWidth: 9 }, applyToAll: true });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(caps(r.e.doc).map(c => [val(c, 'color'), val(c, 'borderWidth')])).toEqual(Array(4).fill(['#0000FF', 9]));
    expect(data(res).appliedToCount).toBe(3);
    expect(res.message).toMatch(/3 more/);
  });

  it('applyToAll stays on the caption track of the edited caption (another caption track is untouched)', () => {
    const r = rig(); r.call('addCaptions', { trackId: 'C2', sourceItems: ['v1'], maxWords: 4 });
    // sourceItems v1 regenerates onto C2 and takes the captions off C1 (one source, one binding); restyle the surviving track only.
    const only = caps(r.e.doc, 'C2'), res = r.call('editProperties', { itemId: only[0].id, properties: { color: '#ABCDEF' }, applyToAll: true });
    expect(res.success).toBe(true);
    expect(caps(r.e.doc, 'C2').every(c => val(c, 'color') === '#ABCDEF')).toBe(true);
  });

  it('text on a LINKED caption is a correction: still linked, the ASR token is untouched, the binding records the correction', () => {
    const r = rig(), [a] = caps(r.e.doc), res = r.call('editProperties', { itemId: a.id, properties: { text: 'ALPHA!' } });
    expect(res.success, JSON.stringify(res)).toBe(true);
    const after = caps(r.e.doc)[0], [b] = bindingsOf(itemOf(r.e.doc, 'v1'));
    expect(after.id).toBe(a.id);
    expect(after.details.text).toBe('ALPHA!');
    expect(after.captionSourceItemId).toBe('v1');
    expect(b.tokens[0].text).toBe('alpha');
    expect(b.corrections).toHaveLength(1);
    expect(b.corrections[0].tokenIds).toEqual([b.tokens[0].id]);
    expect(after.details.words.map((w: RecordData) => w.text)).toEqual(['ALPHA!']);
    expect((data(res).changedFields as Record<string, string[]>)[a.id]).toEqual(expect.arrayContaining(['details.text', 'details.words']));
  });

  it('text and style in one call both land', () => {
    const r = rig(), [a] = caps(r.e.doc);
    expect(r.call('editProperties', { itemId: a.id, properties: { text: 'hello', color: '#FF00FF' } }).success).toBe(true);
    expect([caps(r.e.doc)[0].details.text, val(caps(r.e.doc)[0], 'color')]).toEqual(['hello', '#FF00FF']);
  });

  it('text on a DETACHED caption re-spreads the stored words over the caption duration by character length (contract §4)', () => {
    const r = rig(), [a] = caps(r.e.doc);
    r.e.bus.run('Edit items', 'agent', d => { const c = d.items.find(i => i.id === a.id)!; delete c.captionSourceItemId; c.metadata = { ...c.metadata, captionMode: 'detached' }; return { success: true }; });
    expect(r.call('editProperties', { itemId: a.id, properties: { text: 'one two three' } }).success).toBe(true);
    const c = caps(r.e.doc)[0], dur = c.display.to - c.display.from, w = c.details.words as { text: string; startMs: number; endMs: number }[];
    expect(w.map(x => x.text)).toEqual(['one', 'two', 'three']);
    expect(w[0].startMs).toBe(0);
    expect(w[2].endMs).toBeCloseTo(dur, 2);
    expect(w[0].endMs).toBeCloseTo(dur * 3 / 11, 2); expect(w[1].endMs).toBeCloseTo(dur * 6 / 11, 2);
    expect(w[1].startMs).toBe(w[0].endMs); expect(w[2].startMs).toBe(w[1].endMs);                 // contiguous
    expect(bindingsOf(itemOf(r.e.doc, 'v1'))[0].corrections).toHaveLength(0);                       // no correction on the binding
  });

  it('MIXED_CAPTION_BATCH when the batch mixes a caption with another item type; nothing changes', () => {
    const r = rig(), [a] = caps(r.e.doc), before = JSON.stringify(r.e.doc);
    expect(r.call('editProperties', { itemIds: [a.id, 'v1'], properties: { color: '#FF0000' } })).toMatchObject({ success: false, code: 'MIXED_CAPTION_BATCH' });
    expect(JSON.stringify(r.e.doc)).toBe(before);
  });

  it('PROPERTY_VALIDATION_FAILED (all at once) and NO_PROPERTIES_PROVIDED on the caption path', () => {
    const r = rig(), [a] = caps(r.e.doc), before = JSON.stringify(r.e.doc);
    const res = r.call('editProperties', { itemId: a.id, properties: { fontSize: 0, textAlign: 'middle' } }) as unknown as RecordData;
    expect(res).toMatchObject({ success: false, code: 'PROPERTY_VALIDATION_FAILED' });
    expect((details(res).validationErrors as { field: string }[]).map(e => e.field).sort()).toEqual(['fontSize', 'textAlign']);
    expect(res.data).toBeUndefined(); expect(res.validationErrors).toBeUndefined();
    expect(JSON.stringify(r.e.doc)).toBe(before);
    expect(r.call('editProperties', { itemId: a.id, properties: { positionX: 3 } })).toMatchObject({ success: false });   // not a caption style key and no text
  });

  it('TRACK_LOCKED: a caption on a locked track cannot be edited', () => {
    const r = rig({ locked: true }), [a] = caps(r.e.doc);
    expect(r.call('editProperties', { itemId: a.id, properties: { color: '#FF0000' } })).toMatchObject({ success: false, code: 'TRACK_LOCKED' });
  });

  it('an unknown item id is refused as not found (tool level)', () => {
    const r = rig(), res = r.call('editProperties', { itemId: 'nope', properties: { color: '#FF0000' } });
    expect(res.success).toBe(false);
    expect(String((res as { code?: string }).code)).toMatch(/NOT_FOUND/);
  });

  // The caption-specific codes at the function level (a direct id list reaches them; the tool path checks the id first).
  it('CAPTION_NOT_FOUND for an unknown id and INVALID_ITEM_TYPE (details.actualType / expectedType) for a non-caption id, at the function level', () => {
    const r = rig(), doc = structuredClone(r.e.doc);
    const nf = thrown(() => editCaptionProperties(doc, ['nope'], { color: '#FF0000' }, false));
    expect(nf.code).toBe('CAPTION_NOT_FOUND');
    const bad = thrown(() => editCaptionProperties(doc, ['v1'], { color: '#FF0000' }, false));
    expect(bad.code).toBe('INVALID_ITEM_TYPE');
    expect(bad.extra.details).toEqual({ actualType: 'video', expectedType: 'caption' });
    expect(bad.extra.data).toBeUndefined();
  });
});
