// SPDX-License-Identifier: AGPL-3.0-only
// Review-1 regressions: independent expected partitions and project times, through the production command bus.
import { describe, expect, it } from 'vitest';
import { validate } from '../apps/helper/src/schemas';
import { bindingsOf } from '../apps/web/src/captions/model';
import { itemDraw } from '../apps/web/src/render/model';
import { PRESETS } from '../apps/web/src/text/animation';
import { createEditor } from '../apps/web/src/timeline/harness';
import { callTool } from '../apps/web/src/timeline/tools';
import type { RecordData } from '../apps/web/src/store/model';
import { build, mkTrack, video } from './t03-fixtures';

function rig(two = false) {
  const e = createEditor(build({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption')], items: [video('v1', 'V1', 0, 4000, 0, 8000), ...(two ? [video('v2', 'V1', 5000, 9000, 0, 8000)] : [])], extra: { size: { width: 1080, height: 1920 } } }));
  const words = [['alpha', .2, .5], ['beta', .8, 1.1], ['gamma', 1.4, 1.8], ['delta', 2.1, 2.5]] as const;
  const transcript = { language: 'en', languages: ['en'], total_duration: 8, segments: [{ id: 0, start: .2, end: 2.5, text: 'alpha beta gamma delta', speaker: 0, words: words.map(([word, start, end]) => ({ word, start, end })) }] };
  const ctx = { bus: e.bus, asset: () => undefined, captionData: () => ({ status: 'complete' as const, transcript, music: false }) };
  const call = (name: string, args: RecordData) => { const r = callTool(ctx, name, args); expect(r.success, JSON.stringify(r)).toBe(true); return r; };
  const caps = () => e.doc.items.filter(i => i.type === 'caption').sort((a, b) => a.display.from - b.display.from);
  const texts = () => caps().map(i => i.details.text);
  const source = () => e.doc.items.find(i => i.id === 'v1')!;
  return { e, call, caps, texts, source };
}

describe('T09 review-1 required repairs', () => {
  it('M1 CT-04/07 repeated multi-occurrence regeneration preserves unique ids, clocks, isolation and undo', () => {
    const r = rig(true); r.call('addCaptions', { trackId: 'C1' });
    r.call('editProperties', { itemId: r.caps()[0].id, properties: { text: 'ALPHA beta gamma delta' } });
    const before = structuredClone(r.e.doc), ids = r.caps().map(i => i.id);
    for (let n = 0; n < 2; n++) {
      const res = r.call('addCaptions', { trackId: 'C1' });
      expect((res.data as RecordData).captionIds).toEqual(ids);
      expect(new Set(r.caps().map(i => i.id)).size).toBe(2);
      expect(r.caps().map(i => [i.captionSourceItemId, i.display.from, i.display.to])).toEqual([['v1', 200, 3000], ['v2', 5200, 8000]]);
      expect(r.texts()).toEqual(['ALPHA beta gamma delta', 'alpha beta gamma delta']);
    }
    r.e.bus.undo(); r.e.bus.undo(); expect(r.e.doc).toEqual(before);
  });

  it('M2 CT-07 insertion survives repeated grouping and subrange regeneration without duplicated/lost correction words', () => {
    const r = rig(); r.call('addCaptions', { trackId: 'C1' });
    r.call('editProperties', { itemId: r.caps()[0].id, properties: { text: 'alpha beta NEW EXTRA gamma delta' } });
    const expected = ['alpha', 'beta', 'NEW', 'EXTRA', 'gamma', 'delta'];
    for (const maxWords of [1, 2, 1]) {
      r.call('addCaptions', { trackId: 'C1', maxWords });
      expect(r.texts().join(' ').split(' ')).toEqual(expected);
      expect(r.caps().every(i => i.details.words.length <= maxWords)).toBe(true);
      expect(new Set(r.caps().map(i => i.id)).size).toBe(r.caps().length);
    }
    const before = structuredClone(r.e.doc);
    r.call('addCaptions', { trackId: 'C1', startTime: .8, endTime: 1.1, maxWords: 1 });
    expect(r.texts()).toEqual(expected);
    expect(r.caps().flatMap(i => i.details.words).map(w => w.text)).toEqual(expected);
    r.e.bus.undo(); expect(r.e.doc).toEqual(before);
    r.call('addCaptions', { trackId: 'C1', reset: true });
    expect(r.texts()).toEqual(['alpha beta gamma delta']);
  });

  it('M3 CT-13 final-caption deletion preserves exclusion through regeneration/slip until explicit reset', () => {
    const r = rig(); r.call('addCaptions', { trackId: 'C1' });
    r.call('deleteItems', { itemIds: [r.caps()[0].id] });
    expect(bindingsOf(r.source())[0]?.coverage ?? []).toContainEqual({ fromMs: 200, toMs: 2500, state: 'excluded' });
    const deleted = structuredClone(r.e.doc);
    r.call('addCaptions', { trackId: 'C1' }); expect(r.caps()).toHaveLength(0);
    r.call('slipItem', { itemId: 'v1', slipSeconds: .1 }); expect(r.caps()).toHaveLength(0);
    r.e.bus.undo(); r.e.bus.undo(); expect(r.e.doc).toEqual(deleted);
    r.call('addCaptions', { trackId: 'C1', reset: true }); expect(r.texts()).toEqual(['alpha beta gamma delta']);
  });

  it('M2 CT-07 editing one regrouped correction word preserves sibling ownership', () => {
    const r = rig(); r.call('addCaptions', { trackId: 'C1' });
    r.call('editProperties', { itemId: r.caps()[0].id, properties: { text: 'alpha beta NEW EXTRA gamma delta' } });
    r.call('addCaptions', { trackId: 'C1', maxWords: 1 });
    r.call('editProperties', { itemId: r.caps().find(c => c.details.text === 'NEW')!.id, properties: { text: 'NEW MORE' } });
    r.call('addCaptions', { trackId: 'C1', maxWords: 1 });
    expect(r.texts()).toEqual(['alpha', 'beta', 'NEW', 'MORE', 'EXTRA', 'gamma', 'delta']);
    const ids = r.caps().flatMap(c => c.details.words.map((w: RecordData) => w.wordId));
    expect(new Set(ids).size).toBe(7);
  });

  it('M4 CT-07 empty correction clears visible/stored words in one undoable document update and survives serialization', () => {
    const r = rig(); r.call('addCaptions', { trackId: 'C1' });
    r.call('editProperties', { itemId: r.caps()[0].id, properties: { text: 'fixed' } });
    const before = structuredClone(r.e.doc), labels = r.e.labels().length;
    r.call('editProperties', { itemId: r.caps()[0].id, properties: { text: '' } });
    expect(r.caps().flatMap(i => i.details.words)).toEqual([]);
    expect(r.caps().map(i => i.details.text).join('')).toBe('');
    expect(bindingsOf(r.source())[0].corrections.flatMap(c => c.words)).toEqual([]);
    expect(r.e.labels()).toHaveLength(labels + 1);
    const saved = JSON.stringify(r.e.doc); expect(JSON.stringify(createEditor(JSON.parse(saved)).doc)).toBe(saved);
    r.e.bus.undo(); expect(r.e.doc).toEqual(before); r.e.bus.redo(); expect(JSON.stringify(r.e.doc)).toBe(saved);
    r.call('addCaptions', { trackId: 'C1' }); expect(r.caps()).toHaveLength(0);
  });

  it('M5 helper admits documented flat style fields and caption applyToAll', () => {
    expect(validate('editAllCaptionStyles', { trackId: 'C1', renderMode: 'highlight', color: '#123456', fontSize: 55 })).toBeNull();
    expect(validate('editProperties', { itemId: 'cap', properties: { text: 'alpha' }, applyToAll: true })).toBeNull();
  });

  it('M6 CAP-P07/13 template limits win over manual limits and panel break flags', () => {
    const r = rig(); r.call('addCaptions', { trackId: 'C1', templateId: 'editorial', maxWords: 20, maxCharacters: 100 });
    expect(r.texts()).toEqual(['alpha beta', 'gamma', 'delta']);
    expect(bindingsOf(r.source())[0].options).toMatchObject({ maxWords: 3, maxCharacters: 10 });
  });

  it('M7 caption Fade consumes whole-item opacity at the first frame', () => {
    const r = rig(); r.call('addCaptions', { trackId: 'C1' });
    r.call('editProperties', { itemId: r.caps()[0].id, properties: { textAnimation: { preset: 'fade', version: 1 } } });
    const c = r.caps()[0], draw = itemDraw(r.e.doc, c, c.display.from, r.e.doc.size);
    expect(draw && 'alpha' in draw ? draw.alpha : 0).toBe(0);
  });

  for (const preset of PRESETS) it(`M7 ${preset}: caption consumes the same whole-item box/opacity channels as the tested T05 text entrance`, () => {
    const r = rig(); r.call('addCaptions', { trackId: 'C1' });
    const c = structuredClone(r.caps()[0]); c.details.textAnimation = { preset, version: 1 };
    const text = { ...structuredClone(c), type: 'text' };
    for (const local of [0, 50, 200, 400, 1000]) {
      const a = itemDraw(r.e.doc, c, c.display.from + local, r.e.doc.size), b = itemDraw(r.e.doc, text, c.display.from + local, r.e.doc.size);
      expect(a && 'alpha' in a ? [a.alpha, a.box, a.matrix] : null).toEqual(b && 'alpha' in b ? [b.alpha, b.box, b.matrix] : null);
    }
  });
});
