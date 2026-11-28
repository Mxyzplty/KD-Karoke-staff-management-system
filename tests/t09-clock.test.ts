// SPDX-License-Identifier: AGPL-3.0-only
// T09 the caption clock and source-edit contract (required cases 1, 2, 3, 10; caption timing contract §2–§4, CT-01…CT-03, CT-05,
// CT-12, CT-13; error code CAPTION_SOURCE_EDIT_REFUSED). A linked caption is a projection of immutable tokens through the source
// occurrence's clock; every item-touching command ends in reconcileCaptions (links.ts) on the command's draft.
// Two layers: (E) the engine, reconcileCaptions(base, draft) on cloned documents, which is what CommandBus.run must call; (B) the bus
// and the agent tools (setTimeRemap, moveItem …), which pass only once the bus calls reconcileCaptions. Oracle: the contract text and
// the piecewise arithmetic written out in each test, never links.ts output. Source v1 sits at project [10, 14) s and reads source
// [20, 24) s of a 60 s asset (contract §2 worked example).
import { describe, expect, it } from 'vitest';
import { clipClock } from '../apps/web/src/audio/mix';
import { compileCurve } from '../apps/web/src/audio/curve';
import type { Transcript } from '../apps/web/src/analysis/types';
import { clockOf, reconcileCaptions, sourceClock } from '../apps/web/src/captions/links';
import { bindingsOf } from '../apps/web/src/captions/model';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { CommandError } from '../apps/web/src/timeline/model';
import { sourceTime } from '../apps/web/src/timeline/properties';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext } from '../apps/web/src/timeline/tools';
import { assets, build, itemOf, links, mkTrack, video } from './t03-fixtures';

type W = [string, number, number];
type StoredWord = { text: string; startMs: number; endMs: number; sourceStartMs: number; sourceEndMs: number; partial?: boolean; estimated?: boolean };
const transcript = (list: W[], total = 30): Transcript => ({ language: 'en', languages: ['en'], total_duration: total,
  segments: [{ id: 0, start: list[0][1], end: list[list.length - 1][2], text: list.map(w => w[0]).join(' '), speaker: 0, words: list.map(([word, start, end]) => ({ word, start, end })) }] });
const kf = (id: string, time: number, value: number, easing = 'linear') => ({ id, time, value, easing });
const remapOf = (...points: [number, number][]) => ({ defaultValue: 0, keyframes: points.map(([t, v], n) => kf(`k${n}`, t, v)) });
const source = (extra: RecordData = {}) => video('v1', 'V1', 10000, 14000, 20000, 60000, extra);
/** A project with the source v1 captioned on C1 by the addCaptions tool (the real bus path). */
function rig(list: W[], extra: RecordData = {}, args: RecordData = {}, total = 30) {
  const doc = build({ tracks: [mkTrack('V1', 'video'), mkTrack('C1', 'caption')], items: [source(extra)] });
  const e = createEditor(doc, { assets: assets(), links: links() });
  const ctx: ToolContext = { bus: e.bus, asset: id => assets().find(a => a.id === id), captionData: () => ({ status: 'complete', transcript: transcript(list, total), music: false }) };
  const r = callTool(ctx, 'addCaptions', { trackId: 'C1', ...args });
  expect(r.success, JSON.stringify(r)).toBe(true);
  return { e, ctx, call: (name: string, a: RecordData) => callTool(ctx, name, a) };
}
type Rig = ReturnType<typeof rig>;
const captions = (doc: ProjectDocument) => doc.items.filter(i => i.type === 'caption').sort((a, b) => a.display.from - b.display.from);
const wordsOf = (c: RecordData) => c.details.words as StoredWord[];
const shape = (c: RecordData) => ({ from: c.display.from, to: c.display.to, words: wordsOf(c).map(w => [w.text, w.startMs, w.endMs]) });
/** The engine layer: what CommandBus.run does after the op — reconcile the draft against the base. */
function drive(doc: ProjectDocument, mutate: (draft: ProjectDocument) => void): ProjectDocument {
  const base = structuredClone(doc), draft = structuredClone(doc);
  mutate(draft); reconcileCaptions(base, draft);
  return draft;
}
const thrown = (fn: () => unknown): CommandError => { try { fn(); } catch (e) { if (e instanceof CommandError) return e; throw e; } throw new Error('expected a CommandError, nothing was thrown'); };
const src = (doc: ProjectDocument) => itemOf(doc, 'v1');
const parked = (doc: ProjectDocument) => bindingsOf(src(doc)).flatMap(b => b.parked);

describe('T09 CT-04: two occurrences of one asset keep corrections and clocks independent', () => {
  it('real cloneItem of a linked caption is detached; moving its old source cannot move or correct the copy', () => {
    const r = rig([['one', 21, 21.5], ['two', 22, 22.5]]), original = captions(r.e.doc)[0].id;
    const result = r.call('cloneItem', { itemId: original, trackId: 'C1', at: 16 });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const id = (result.data as RecordData).itemId, copy = itemOf(r.e.doc, id), before = JSON.stringify(copy);
    expect(copy.captionSourceItemId).toBeUndefined(); expect(copy.metadata.captionMode).toBe('detached');
    expect(r.call('editProperties', { itemId: original, properties: { text: 'ONE two' } }).success).toBe(true);
    expect(r.call('moveItem', { itemId: 'v1', by: 1 }).success).toBe(true);
    expect(JSON.stringify(itemOf(r.e.doc, id))).toBe(before);
  });
  it('real cloneItem makes a fresh source occurrence, with no inherited corrections or caption ownership', () => {
    const r = rig([['one', 21, 21.5], ['two', 22, 22.5]]), c = captions(r.e.doc)[0];
    expect(r.call('editProperties', { itemId: c.id, properties: { text: 'ONE two' } }).success).toBe(true);
    const first = JSON.stringify({ source: src(r.e.doc), captions: captions(r.e.doc) });
    const copy = r.call('cloneItem', { itemId: 'v1', trackId: 'V1', at: 16 });
    expect(copy.success, JSON.stringify(copy)).toBe(true);
    const id = (copy.data as RecordData).itemId;
    expect(bindingsOf(itemOf(r.e.doc, id))).toEqual([]);
    expect(JSON.stringify({ source: src(r.e.doc), captions: captions(r.e.doc) })).toBe(first);
    expect(r.call('addCaptions', { trackId: 'C1' }).success).toBe(true);
    expect(captions(r.e.doc).find(c => c.captionSourceItemId === id)!.details.text).toBe('one two');
    expect(captions(r.e.doc).find(c => c.captionSourceItemId === 'v1')!.details.text).toBe('ONE two');
  });
  it('correct one copy; move and slip the other and back; no text, binding, timing or coverage leaks', () => {
    const data = rig([['one', 21, 21.5], ['two', 22, 22.5]]).ctx.captionData;
    const e = createEditor(build({ tracks: [mkTrack('V1', 'video'), mkTrack('V2', 'video'), mkTrack('C1', 'caption')],
      items: [source(), video('v2', 'V2', 16000, 20000, 20000, 60000)] }), { assets: assets(), links: links() });
    const ctx: ToolContext = { bus: e.bus, asset: id => assets().find(a => a.id === id), captionData: data };
    const call = (name: string, a: RecordData) => { const r = callTool(ctx, name, a); expect(r.success, JSON.stringify(r)).toBe(true); };
    call('addCaptions', { trackId: 'C1' });
    const own = (id: string) => captions(e.doc).filter(c => c.captionSourceItemId === id);
    expect(own('v1')).toHaveLength(1); expect(own('v2')).toHaveLength(1);
    call('editProperties', { itemId: own('v1')[0].id, properties: { text: 'ONE two' } });
    const first = JSON.stringify({ source: src(e.doc), captions: own('v1') });
    const second = JSON.stringify({ source: itemOf(e.doc, 'v2'), captions: own('v2') });
    expect(bindingsOf(src(e.doc))[0].id).not.toBe(bindingsOf(itemOf(e.doc, 'v2'))[0].id);
    call('moveItem', { itemId: 'v2', by: 2 });
    call('slipItem', { itemId: 'v2', slipSeconds: 0.5 });
    expect(JSON.stringify({ source: src(e.doc), captions: own('v1') })).toBe(first);
    expect(own('v2')[0].details.text).toBe('one two');
    expect(own('v2')[0].display.from).toBe(18500);
    expect(bindingsOf(itemOf(e.doc, 'v2'))[0].corrections).toEqual([]);
    call('slipItem', { itemId: 'v2', slipSeconds: -0.5 });
    call('moveItem', { itemId: 'v2', by: -2 });
    expect(JSON.stringify({ source: itemOf(e.doc, 'v2'), captions: own('v2') })).toBe(second);
    expect(JSON.stringify({ source: src(e.doc), captions: own('v1') })).toBe(first);
  });
});

describe('T09 CT-06/07: real splitItem partitions anchors, corrections and hold; moves do not bridge gaps', () => {
  it('a bare caption with no word data keeps the ordinary split path and never enters word rebasing', () => {
    const r = rig([['one', 21, 21.4]]), c = captions(r.e.doc)[0];
    r.e.bus.run('Edit items', 'agent', doc => {
      const cap = itemOf(doc, c.id); cap.metadata = { captionMode: 'bare' }; delete cap.captionSourceItemId;
      cap.details.words = []; delete src(doc).captionBindings;
    });
    const before = JSON.stringify(r.e.doc), result = r.call('splitItem', { itemId: c.id, timestampS: 11.2 });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(captions(r.e.doc).map(c => c.details.text)).toEqual(['one', 'one']);
    r.e.bus.undo('agent'); expect(JSON.stringify(r.e.doc)).toBe(before);
  });
  for (const corrected of [false, true]) for (const cut of [10900, 11200, 11500]) it(`source cut ${cut}, ${corrected ? 'corrected' : 'untouched'}, right away/back`, () => {
    const r = rig([['one', 21, 21.4], ['two', 22, 22.4]]), first = corrected ? 'ONE' : 'one';
    if (corrected) expect(r.call('editProperties', { itemId: captions(r.e.doc)[0].id, properties: { text: 'ONE two' } }).success).toBe(true);
    const res = r.call('splitItem', { itemId: 'v1', timestampS: cut / 1000 });
    expect(res.success, JSON.stringify(res)).toBe(true);
    const right = (res.data as RecordData).rightItemId;
    const check = (move: number) => {
      expect(captions(r.e.doc).map(c => [c.details.text, c.display.from, c.display.to])).toEqual(cut < 11000 ? [[`${first} two`, 11000 + move, 12900 + move]] : [[first, 11000, cut], ['two', 12000 + move, 12900 + move]]);
      expect(captions(r.e.doc).flatMap(c => wordsOf(c).map(w => [w.text, w.sourceStartMs, w.sourceEndMs]))).toEqual([[first, 21000, 21400], ['two', 22000, 22400]]);
      // Assert the projected clock independently of the stored anchors (the renderer consumes these local times).
      expect(captions(r.e.doc).flatMap(c => wordsOf(c).map(w => [c.display.from - (c.trim?.from ?? 0) + w.startMs, c.display.from - (c.trim?.from ?? 0) + w.endMs])))
        .toEqual([[11000 + (cut < 11000 ? move : 0), cut < 11000 ? 11400 + move : Math.min(11400, cut)], [12000 + move, 12400 + move]]);
    };
    check(0); const before = JSON.stringify(r.e.doc);
    expect(r.call('moveItem', { itemId: right, by: 1 }).success).toBe(true); check(1000);
    expect(r.call('moveItem', { itemId: right, by: -1 }).success).toBe(true); check(0);
    expect(JSON.stringify(r.e.doc)).toBe(before);
  });
  it('direct linked caption split rebases right word times through the bus and is one undoable command', () => {
    const r = rig([['one', 21, 21.4], ['two', 22, 22.4]]), before = JSON.stringify(r.e.doc), id = captions(r.e.doc)[0].id;
    const split = r.call('splitItem', { itemId: id, timestampS: 11.8 });
    expect(split.success, JSON.stringify(split)).toBe(true);
    expect(captions(r.e.doc).map(c => c.details.text)).toEqual(['one', 'two']);
    expect(wordsOf(captions(r.e.doc)[1])).toMatchObject([{ text: 'two', startMs: 200, endMs: 600, sourceStartMs: 22000, sourceEndMs: 22400 }]);
    r.e.bus.undo('agent'); expect(JSON.stringify(r.e.doc)).toBe(before);
  });
  it('real trimItem and slipItem preserve a correction when the original source window is restored (CT-02/03)', () => {
    const r = rig([['one', 21, 21.4], ['two', 22, 22.4]]), id = captions(r.e.doc)[0].id;
    expect(r.call('editProperties', { itemId: id, properties: { text: 'ONE two' } }).success).toBe(true);
    const before = JSON.stringify(r.e.doc);
    expect(r.call('trimItem', { itemId: 'v1', handle: 'start', deltaSeconds: 1.5 }).success).toBe(true);
    expect(captions(r.e.doc)[0].details.text).toBe('two');
    expect(r.call('trimItem', { itemId: 'v1', handle: 'start', deltaSeconds: -1.5 }).success).toBe(true);
    expect(JSON.stringify(r.e.doc)).toBe(before);
    expect(r.call('slipItem', { itemId: 'v1', slipSeconds: 1.5 }).success).toBe(true);
    expect(captions(r.e.doc)[0].details.text).toBe('two');
    expect(r.call('slipItem', { itemId: 'v1', slipSeconds: -1.5 }).success).toBe(true);
    expect(JSON.stringify(r.e.doc)).toBe(before);
  });
});

describe('T09 CT-08: source edits refuse atomically across the dependency set', () => {
  const operations: [string, RecordData][] = [
    ['moveItem', { itemId: 'v1', by: 1 }],
    ['trimItem', { itemId: 'v1', handle: 'start', deltaSeconds: 1.25 }],
    ['slipItem', { itemId: 'v1', slipSeconds: 0.5 }],
    ['splitItem', { itemId: 'v1', timestampS: 11.25 }],
    ['editProperties', { itemId: 'v1', properties: { playbackRate: 2 } }],
    ['trimItem', { itemId: 'v1', handle: 'start', deltaSeconds: 1.25, ripple: true }],
    ['deleteItems', { itemIds: ['v1'], ripple: true }],
  ];
  const make = () => rig([['one', 21, 21.5], ['two', 22, 22.5]]);
  const refuse = (r: Rig, name: string, args: RecordData, code?: string) => {
    const before = JSON.stringify(r.e.doc), labels = r.e.labels();
    const result = r.call(name, args);
    expect(result, JSON.stringify({ name, args, result })).toMatchObject({ success: false, ...(code ? { code } : {}) });
    // CAPTION_SOURCE_EDIT_REFUSED specifies the flag; ordinary validation/lock errors do not expose it.
    if (code === 'CAPTION_SOURCE_EDIT_REFUSED') expect(result.operationMayHaveRun).toBe(false);
    expect(JSON.stringify(r.e.doc), `${name}: every project record`).toBe(before);
    expect(r.e.labels(), `${name}: undo stack`).toEqual(labels);
  };
  it('invalid member: a mixed-id source batch and a caption batch leave all records unchanged', () => {
    const r = make();
    refuse(r, 'moveItem', { itemIds: ['v1', 'missing'], by: 1 }, 'ITEM_NOT_FOUND');
    refuse(r, 'editProperties', { itemIds: [captions(r.e.doc)[0].id, 'missing'], properties: { text: 'ONE two' } });
  });
  for (const [label, target, group, code] of [
    ['locked source track', 'V1', false, 'TRACK_LOCKED'],
    ['locked caption dependency track', 'C1', false, 'CAPTION_SOURCE_EDIT_REFUSED'],
    ['group locking source track', 'V1', true, 'TRACK_LOCKED'],
    ['group locking caption dependency', 'C1', true, 'CAPTION_SOURCE_EDIT_REFUSED'],
  ] as const) {
    for (const [name, args] of operations) it(`${label}: ${name}${args.ripple ? ' ripple' : ''} rejects before commit`, () => {
      const r = make();
      r.e.bus.run('Edit items', 'agent', doc => {
        if (group) doc.groups = { g1: { id: 'g1', name: 'Locked', children: [{ type: 'track', id: target }], hidden: false, locked: true } };
        else doc.tracks.find(t => t.id === target)!.locked = true;
      });
      refuse(r, name, args, code);
      if (group && target === 'V1') refuse(r, 'moveItem', { groupId: 'g1', by: 1 }, 'TRACK_LOCKED');
    });
  }
  it('a locked source permits caption correction/restyle; source timing/media stay unchanged (coordinator ruling)', () => {
    const r = make(), id = captions(r.e.doc)[0].id;
    r.e.bus.run('Edit items', 'agent', d => { d.tracks.find(t => t.id === 'V1')!.locked = true; });
    const media = (s: RecordData) => { const { captionBindings: _b, ...rest } = s; return rest; };
    const before = structuredClone(media(src(r.e.doc)));
    expect(r.call('editProperties', { itemId: id, properties: { text: 'ONE two', color: '#FF0000' } }).success).toBe(true);
    expect(r.call('editAllCaptionStyles', { trackId: 'C1', properties: { fontSize: 72 } }).success).toBe(true);
    expect(media(src(r.e.doc))).toEqual(before);
    expect(captions(r.e.doc)[0].details.text).toBe('ONE two');
    expect(bindingsOf(src(r.e.doc))[0].corrections).toHaveLength(1);
  });
});

describe('T09 CT-01 / CT-05: constant-rate clock (contract §2 worked example)', () => {
  const list: W[] = [['one', 21, 21.5], ['two', 22, 22.5]];

  it('CT-01: source [20,24) at project [10,14), word [21,21.5) → the caption starts at 11 s; its words keep source anchors; it holds 0.5 s past the last word', () => {
    const r = rig(list), [c] = captions(r.e.doc);
    expect(captions(r.e.doc)).toHaveLength(1);
    expect(shape(c)).toEqual({ from: 11000, to: 13000, words: [['one', 0, 500], ['two', 1000, 1500]] });
    expect(wordsOf(c).map(w => [w.sourceStartMs, w.sourceEndMs])).toEqual([[21000, 21500], [22000, 22500]]);
  });

  it('CT-01 (engine): moving the occurrence +3 s moves the word to [14, 14.5); id, corrected text and style are unchanged', () => {
    const r = rig(list), id = captions(r.e.doc)[0].id;
    expect(r.call('editProperties', { itemId: id, properties: { text: 'ONE two', color: '#FF0000' } }).success).toBe(true);   // a correction does not detach
    const before = captions(r.e.doc)[0], after = captions(drive(r.e.doc, d => { src(d).display = { from: 13000, to: 17000 }; }))[0];
    expect(after.id).toBe(id);
    expect(shape(after)).toEqual({ from: 14000, to: 16000, words: [['ONE', 0, 500], ['two', 1000, 1500]] });
    expect(after.details.text).toBe('ONE two');
    expect(after.properties.color.defaultValue).toBe('#FF0000');
    expect(after.metadata.captionBindingId).toBe(before.metadata.captionBindingId);
  });

  it('CT-05 (engine): at 2× the project duration and the word spans halve under the same mapping; source anchors and source duration stay', () => {
    // Source [20,24) at 2× fills project [10,12): word [21,21.5) → local 500..750; word [22,22.5) → 1000..1250.
    const r = rig(list, { display: { from: 10000, to: 12000 }, playbackRate: 2, trim: { from: 20000, to: 24000 } }), [c] = captions(r.e.doc);
    expect(shape(c)).toEqual({ from: 10500, to: 11750, words: [['one', 0, 250], ['two', 500, 750]] });
    expect(wordsOf(c).map(w => [w.sourceStartMs, w.sourceEndMs])).toEqual([[21000, 21500], [22000, 22500]]);
    expect(src(r.e.doc).sourceDuration).toBe(60000);
  });

  it('CT-05: a speed change of the source (1× → 2× over the same source window) re-projects the existing caption', () => {
    const r = rig(list), after = captions(drive(r.e.doc, d => { const s = src(d); s.playbackRate = 2; s.display = { from: 10000, to: 12000 }; s.trim = { from: 20000, to: 24000 }; }))[0];
    expect(shape(after)).toEqual({ from: 10500, to: 11750, words: [['one', 0, 250], ['two', 500, 750]] });
  });
});

describe('T09 CT-02 / CT-03: trim, restore and slip against the cached transcript (contract §3, §4)', () => {
  // Words well apart so the 0.5 s holds never meet: one 20.4–20.8, two 21.5–22.0, three 23.0–23.4, four 24.5–25.0 (outside the window).
  const list: W[] = [['one', 20.4, 20.8], ['two', 21.5, 22], ['three', 23, 23.4], ['four', 24.5, 25]];
  const make = () => rig(list, {}, { maxWords: 1 });

  it('generation: only the words inside the source window [20,24) get captions; the word at 24.5 s does not', () => {
    const r = make();
    expect(captions(r.e.doc).map(c => [c.details.text, c.display.from, c.display.to])).toEqual([['one', 10400, 11300], ['two', 11500, 12500], ['three', 13000, 13900]]);
  });

  it('CT-02: trimming the start inward removes the caption whose word left the window; extending restores the same item with its correction (no reanalysis)', () => {
    const r = make(), one = captions(r.e.doc)[0];
    expect(r.call('editProperties', { itemId: one.id, properties: { text: 'ONE' } }).success).toBe(true);
    const trimmed = drive(r.e.doc, d => { const s = src(d); s.display = { from: 11000, to: 14000 }; s.trim = { from: 21000, to: 24000 }; });
    expect(captions(trimmed).map(c => c.details.text)).toEqual(['two', 'three']);
    expect(captions(trimmed)[0].display.from).toBe(11500);                          // placement of the surviving words did not move
    expect(parked(trimmed).map(c => c.id)).toEqual([one.id]);                       // retained on the binding with its id
    const restored = drive(trimmed, d => { const s = src(d); s.display = { from: 10000, to: 14000 }; s.trim = { from: 20000, to: 24000 }; });
    const back = captions(restored)[0];
    expect([back.id, back.details.text, back.display.from, back.display.to]).toEqual([one.id, 'ONE', 10400, 11300]);
    expect(parked(restored)).toHaveLength(0);
  });

  it('CT-02: a word cut by the trim is kept as a partial word: displayed span clipped to the window, original anchor kept, flagged', () => {
    const r = make(), cut = captions(drive(r.e.doc, d => { const s = src(d); s.display = { from: 11750, to: 14000 }; s.trim = { from: 21750, to: 24000 }; })).find(c => c.details.text === 'two')!;
    expect(cut.display.from).toBe(11750);
    expect(wordsOf(cut)[0]).toMatchObject({ text: 'two', startMs: 0, endMs: 250, sourceStartMs: 21500, sourceEndMs: 22000, partial: true });
  });

  it('CT-02: a word ending exactly at the new start does not survive (half-open window)', () => {
    const r = make(), cut = drive(r.e.doc, d => { const s = src(d); s.display = { from: 12000, to: 14000 }; s.trim = { from: 22000, to: 24000 }; });
    expect(captions(cut).map(c => c.details.text)).toEqual(['three']);
  });

  it('CT-03: slip [20,24) → [22,26): captions of words left of 22 go, the surviving word moves with its source time, the cached word at 24.5 s appears', () => {
    const r = make(), slipped = drive(r.e.doc, d => { src(d).trim = { from: 22000, to: 26000 }; });   // slip: display unchanged
    expect(captions(slipped).map(c => [c.details.text, c.display.from])).toEqual([['three', 11000], ['four', 12500]]);
    expect(src(slipped).display).toEqual({ from: 10000, to: 14000 });
    expect(bindingsOf(src(slipped))[0].parked.map(c => c.details.text)).toEqual(['one', 'two']);
  });

  it('CT-03: audio beyond the analysed duration is explicit unresolved coverage, not silence and not a caption', () => {
    const r = make(), [b] = bindingsOf(src(r.e.doc));
    expect(b.coverage).toEqual([{ fromMs: 0, toMs: 30000, state: 'complete' }, { fromMs: 30000, toMs: 60000, state: 'unresolved' }]);
    const far = captions(drive(r.e.doc, d => { src(d).trim = { from: 38000, to: 42000 }; }));
    expect(far).toHaveLength(0);
  });
});

describe('T09 CT-12 (required case 1): strictly increasing time remap — the positive half', () => {
  // Remap in item-local ms → source ms: 0→10000, 2000→12000, 4000→20000 (slope 1 then 4). Words in source seconds.
  const list: W[] = [['alpha', 10, 10.5], ['beta', 11, 11.5], ['gamma', 14, 14.5], ['delta', 18, 18.5]];
  const remap = remapOf([0, 10000], [2000, 12000], [4000, 20000]);
  const make = () => rig(list, { timeRemap: remap });

  it('generation through the inverse: word times follow local = 2000 + (source − 12000) / 4 on the steep segment', () => {
    const [c] = captions(make().e.doc);
    expect(captions(make().e.doc)).toHaveLength(1);
    expect(shape(c)).toEqual({ from: 10000, to: 14000, words: [['alpha', 0, 500], ['beta', 1000, 1500], ['gamma', 2500, 2625], ['delta', 3500, 3625]] });
  });

  it('a caption source edit (text correction) SUCCEEDS on a remapped source and reprojects; the equal-count correction keeps every anchor', () => {
    const r = make(), id = captions(r.e.doc)[0].id, res = r.call('editProperties', { itemId: id, properties: { text: 'alpha BETA gamma delta' } });
    expect(res).toMatchObject({ success: true });
    const [c] = captions(r.e.doc);
    expect(c.id).toBe(id);
    expect(shape(c)).toEqual({ from: 10000, to: 14000, words: [['alpha', 0, 500], ['BETA', 1000, 1500], ['gamma', 2500, 2625], ['delta', 3500, 3625] ] });
    const [b] = bindingsOf(src(r.e.doc));
    expect(b.tokens.map(t => t.text)).toEqual(['alpha', 'beta', 'gamma', 'delta']);                     // the ASR token is immutable
    expect(b.corrections).toHaveLength(1);
    expect(b.corrections[0]).toMatchObject({ estimated: false, words: [{ text: 'BETA', startMs: 11000, endMs: 11500 }] });
  });

  it('a many-to-one correction keeps the anchor span and is labelled estimated (no forced-alignment claim)', () => {
    const r = make(), [c] = captions(r.e.doc);
    expect(r.call('editProperties', { itemId: c.id, properties: { text: 'alpha betagamma delta' } }).success).toBe(true);   // "beta gamma" → one word
    const [b] = bindingsOf(src(r.e.doc));
    expect(b.corrections).toHaveLength(1);
    expect(b.corrections[0].estimated).toBe(true);
    expect(b.corrections[0].words).toMatchObject([{ text: 'betagamma', startMs: 11000, endMs: 14500 }]);   // spans both tokens' anchors
    expect(captions(r.e.doc)[0].details.text).toBe('alpha betagamma delta');
  });

  it('(engine) moving the remapped source +1 s shifts the caption +1 s and keeps the relative word times', () => {
    const after = captions(drive(make().e.doc, d => { src(d).display = { from: 11000, to: 15000 }; }))[0];
    expect(shape(after)).toEqual({ from: 11000, to: 15000, words: [['alpha', 0, 500], ['beta', 1000, 1500], ['gamma', 2500, 2625], ['delta', 3500, 3625]] });
  });

  it('(engine) a new strictly increasing curve re-projects every word by the inverse of that curve (slope 2 then 8/3)', () => {
    // 0→10000, 1000→12000, 4000→20000: alpha 0..250, beta 500..750, gamma 1750..1937.5, delta 3250..3437.5.
    const after = captions(drive(make().e.doc, d => { src(d).timeRemap = remapOf([0, 10000], [1000, 12000], [4000, 20000]); }))[0];
    expect(after.display.from).toBe(10000);
    const w = wordsOf(after);
    expect(w.map(x => x.text)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    [[0, 250], [500, 750], [1750, 1937.5], [3250, 3437.5]].forEach(([s, z], n) => { expect(w[n].startMs).toBeCloseTo(s, 2); expect(w[n].endMs).toBeCloseTo(z, 2); });
    expect(after.display.to).toBeCloseTo(13937.5, 2);
    expect(w.map(x => [x.sourceStartMs, x.sourceEndMs])).toEqual([[10000, 10500], [11000, 11500], [14000, 14500], [18000, 18500]]);
  });

  it('the clock is the playback curve inverted by bisection: localAt(sourceAt(t)) = t for a non-linear (easeInOut) curve, on both sides of the keyframes', () => {
    const item = source({ timeRemap: { defaultValue: 0, keyframes: [kf('a', 0, 10000, 'easeInOut'), kf('b', 1500, 15000, 'easeInOut'), kf('c', 4000, 30000)] } });
    const clock = clockOf(item);
    expect(typeof clock).not.toBe('string');
    const c = clock as Exclude<typeof clock, string>;
    expect([c.span, c.windowFrom, c.windowTo]).toEqual([4000, 10000, 30000]);
    const curve = compileCurve(item.timeRemap.keyframes, 0), bisect = (s: number) => { let lo = 0, hi = 4000; for (let n = 0; n < 60; n++) { const m = (lo + hi) / 2; if (curve(m) < s) lo = m; else hi = m; } return (lo + hi) / 2; };
    for (const local of [0, 1, 250, 700, 1499, 1500, 1501, 2800, 3999, 4000]) expect(c.localAt(c.sourceAt(local)), `local ${local}`).toBeCloseTo(local, 3);
    for (const s of [10000, 10010, 11000, 14999, 15000, 22000, 29999, 30000]) expect(c.localAt(s), `source ${s}`).toBeCloseTo(bisect(s), 3);
    expect([c.localAt(0), c.localAt(5000), c.localAt(10000), c.localAt(30000), c.localAt(99999)]).toEqual([0, 0, 0, 4000, 4000]);   // outside the window: clamped to the ends
  });
});

describe('T09 CT-12 / contract §2 (required case 2): refusals — CAPTION_SOURCE_EDIT_REFUSED, operationMayHaveRun false, nothing changes', () => {
  const list: W[] = [['one', 21, 21.5], ['two', 22, 22.5]];
  /** name → how the draft's source is edited so the clock (or the tokens) cannot carry the captions. */
  const REFUSALS: Record<string, (d: ProjectDocument) => void> = {
    freeze: d => { src(d).timeRemap = remapOf([0, 20000], [2000, 21000], [4000, 21000]); },
    reverse: d => { src(d).timeRemap = remapOf([0, 24000], [4000, 20000]); },
    'repeated clip': d => { src(d).timeRemap = remapOf([0, 20000], [2000, 22000], [4000, 21000]); },
    'no forward clock': d => { src(d).timeRemap = remapOf([0, 20000]); },
    'bad word timings': d => { src(d).display = { from: 11000, to: 15000 }; const t = bindingsOf(src(d))[0].tokens[1]; t.endMs = t.startMs - 1; },
    'split boundary disagreement': d => {
      // A split whose right half keeps the words of the whole: floorMs 0 against a window that starts at 22 s.
      const s = src(d); s.display = { from: 10000, to: 12000 }; s.trim = { from: 20000, to: 22000 };
      const right = structuredClone(s); right.id = 'v1b'; right.display = { from: 12000, to: 14000 }; right.trim = { from: 22000, to: 24000 };
      d.items.push(right);
    },
  };

  for (const [name, edit] of Object.entries(REFUSALS)) {
    it(`(engine) ${name}: reconcile throws CAPTION_SOURCE_EDIT_REFUSED with mayHaveRun false and a reason`, () => {
      const r = rig(list), e = thrown(() => drive(r.e.doc, edit));
      expect(e.code).toBe('CAPTION_SOURCE_EDIT_REFUSED');
      expect(e.extra.mayHaveRun).toBe(false);
      expect(e.error.length + String(e.extra.message ?? '').length).toBeGreaterThan(0);
    });
  }

  it('(engine) the whole refuse list fires: six distinct inputs, six refusals, and the input document is never modified', () => {
    const r = rig(list), snapshot = JSON.stringify(r.e.doc);
    const codes = Object.values(REFUSALS).map(edit => thrown(() => drive(r.e.doc, edit)).code);
    expect(codes).toEqual(Array(6).fill('CAPTION_SOURCE_EDIT_REFUSED'));
    expect(JSON.stringify(r.e.doc)).toBe(snapshot);
  });

  it('clockOf names the reason as a string for every unsupported clock (freeze, reverse, repeated, one keyframe)', () => {
    for (const map of [remapOf([0, 20000], [2000, 21000], [4000, 21000]), remapOf([0, 24000], [4000, 20000]), remapOf([0, 20000], [2000, 22000], [4000, 21000]), remapOf([0, 20000])])
      expect(typeof clockOf(source({ timeRemap: map })), JSON.stringify(map)).toBe('string');
    expect(typeof clockOf(source({ timeRemap: remapOf([0, 20000], [4000, 24000]) }))).not.toBe('string');
    expect(typeof clockOf(source())).not.toBe('string');
  });

  for (const [name, edit] of Object.entries(REFUSALS)) {
    it(`(bus) ${name}: the command is thrown away — same document, same undo stack (one 'Add captions' step)`, () => {
      const r = rig(list), before = JSON.stringify(r.e.doc), labels = r.e.labels();
      expect(labels).toEqual(['Add captions']);
      expect(thrown(() => r.e.bus.run('Edit items', 'agent', draft => { edit(draft); })).code).toBe('CAPTION_SOURCE_EDIT_REFUSED');
      expect(JSON.stringify(r.e.doc)).toBe(before);
      expect(r.e.labels()).toEqual(labels);
    });
  }

  const TOOL_REFUSALS: Record<string, { time: number; value: number }[]> = {
    freeze: [{ time: 10, value: 20000 }, { time: 12, value: 21000 }, { time: 14, value: 21000 }],
    reverse: [{ time: 10, value: 24000 }, { time: 14, value: 20000 }],
    'repeated clip': [{ time: 10, value: 20000 }, { time: 12, value: 22000 }, { time: 14, value: 21000 }],
    'no forward clock': [{ time: 10, value: 20000 }],
  };
  for (const [name, keyframes] of Object.entries(TOOL_REFUSALS)) {
    it(`(bus, tool) setTimeRemap ${name}: { success:false, code CAPTION_SOURCE_EDIT_REFUSED, operationMayHaveRun:false }; nothing changed`, () => {
      const r = rig(list), before = JSON.stringify(r.e.doc), res = r.call('setTimeRemap', { itemId: 'v1', keyframes });
      expect(res).toMatchObject({ success: false, code: 'CAPTION_SOURCE_EDIT_REFUSED', operationMayHaveRun: false });
      expect(JSON.stringify(r.e.doc)).toBe(before);
      expect(r.e.labels()).toEqual(['Add captions']);
    });
  }

  it('(bus, tool) a strictly increasing setTimeRemap succeeds as ONE undo step, reprojects the captions, and Undo restores them exactly', () => {
    // 0→20000, 1000→22000, 4000→24000 (local ms): "one" [21000,21500) → 500..750; "two" [22000,22500) → 1000..1750.
    const r = rig(list), before = JSON.stringify(r.e.doc);
    const res = r.call('setTimeRemap', { itemId: 'v1', keyframes: [{ time: 10, value: 20000 }, { time: 11, value: 22000 }, { time: 14, value: 24000 }] });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(r.e.labels()).toEqual(['Add captions', 'Edit items']);
    expect(shape(captions(r.e.doc)[0])).toEqual({ from: 10500, to: 12250, words: [['one', 0, 250], ['two', 500, 1250]] });
    expect(r.e.bus.undo('agent')).not.toBeNull();
    expect(JSON.stringify(r.e.doc)).toBe(before);
  });

  it('(bus, tool) moving the source with moveItem moves the linked caption by the same displacement in the same undo step', () => {
    const r = rig(list), res = r.call('moveItem', { itemId: 'v1', by: 3 });
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(shape(captions(r.e.doc)[0])).toEqual({ from: 14000, to: 16000, words: [['one', 0, 500], ['two', 1000, 1500]] });
    expect(r.e.labels()).toHaveLength(2);
  });
});

describe('T09 required case 3: one clock — sourceClock (captions) = clipClock (audio/mix.ts) = sourceTime (timeline/properties.ts)', () => {
  const sample = (len: number) => [0, 1, 17, 250, 333.3, len / 2, len - 250, len - 1, len];
  const cases: Record<string, RecordData> = {
    'constant rate 1×': source(),
    'constant rate 1.5× with a trim': source({ playbackRate: 1.5, trim: { from: 2000, to: 8000 } }),
    'constant rate 0.5×': source({ playbackRate: 0.5, trim: { from: 5000, to: 7000 } }),
    'two-keyframe remap': source({ timeRemap: remapOf([0, 20000], [4000, 24000]) }),
    'nonuniform remap': source({ timeRemap: remapOf([0, 10000], [2000, 12000], [4000, 20000]) }),
    'eased remap': source({ timeRemap: { defaultValue: 0, keyframes: [kf('a', 0, 10000, 'easeInOut'), kf('b', 1500, 15000, 'easeInOutCubic'), kf('c', 4000, 30000)] } }),
    'remap clamped at the asset end': source({ sourceDuration: 25000, timeRemap: remapOf([0, 20000], [4000, 40000]) }),
  };
  for (const [name, item] of Object.entries(cases)) {
    it(`${name}: the three clocks agree at ${sample(4000).length} sampled item-local times`, () => {
      const a = sourceClock(item), b = clipClock(item);
      for (const t of sample(item.display.to - item.display.from)) {
        expect(a(t), `sourceClock vs clipClock @${t}`).toBeCloseTo(b(t), 9);
        expect(a(t), `sourceClock vs sourceTime @${t}`).toBeCloseTo(sourceTime(item, t), 9);
      }
    });
  }
});

describe('T09 CT-13 (required case 10): explicit exclusions stay distinguishable from missing coverage', () => {
  // CT-13 (contract §7): "Deliberately suppress a caption range, then slip/regenerate nearby content; suppression remains
  // distinguishable from missing coverage." Read as: (a) deleting a caption excludes its source interval, (b) a later run or a
  // slip does not bring it back, (c) coverage records `excluded` apart from `unresolved`, (d) only an explicit reset (reset: true) clears it.
  const list: W[] = [['one', 20.4, 20.8], ['two', 21.5, 22], ['three', 23, 23.4]];
  const args = { maxWords: 1 };
  const states = (doc: ProjectDocument) => bindingsOf(src(doc))[0].coverage;

  it('(engine) deleting a caption records its word span as excluded coverage; unanalysed audio stays a separate `unresolved` state', () => {
    const r = rig(list, {}, args), two = captions(r.e.doc)[1];
    const after = drive(r.e.doc, d => { d.items.splice(d.items.findIndex(i => i.id === two.id), 1); });
    expect(captions(after).map(c => c.details.text)).toEqual(['one', 'three']);
    expect(states(after)).toEqual([{ fromMs: 0, toMs: 21500, state: 'complete' }, { fromMs: 21500, toMs: 22000, state: 'excluded' }, { fromMs: 22000, toMs: 30000, state: 'complete' }, { fromMs: 30000, toMs: 60000, state: 'unresolved' }]);
  });

  it('(engine) regenerating nearby does not recreate the suppressed caption; an explicit reset (reset: true) does', () => {
    const r = rig(list, {}, args), two = captions(r.e.doc)[1];
    const after = drive(r.e.doc, d => { d.items.splice(d.items.findIndex(i => i.id === two.id), 1); });
    const e2 = createEditor(after, { assets: assets(), links: links() });
    const ctx: ToolContext = { bus: e2.bus, asset: id => assets().find(a => a.id === id), captionData: r.ctx.captionData };
    expect(callTool(ctx, 'addCaptions', { trackId: 'C1', ...args }).success).toBe(true);
    expect(captions(e2.doc).map(c => c.details.text)).toEqual(['one', 'three']);
    expect(states(e2.doc).map(c => c.state)).toContain('excluded');
    expect(callTool(ctx, 'addCaptions', { trackId: 'C1', ...args, reset: true }).success).toBe(true);
    expect(captions(e2.doc).map(c => c.details.text)).toEqual(['one', 'two', 'three']);
    expect(states(e2.doc).map(c => c.state)).not.toContain('excluded');
  });

  it('(engine) slipping nearby content leaves the exclusion in place (it is anchored in source time) and fills nothing into it', () => {
    const r = rig(list, {}, args), two = captions(r.e.doc)[1];
    const deleted = drive(r.e.doc, d => { d.items.splice(d.items.findIndex(i => i.id === two.id), 1); });
    const slipped = drive(deleted, d => { src(d).trim = { from: 21000, to: 25000 }; });
    expect(states(slipped).filter(c => c.state === 'excluded')).toEqual([{ fromMs: 21500, toMs: 22000, state: 'excluded' }]);
    expect(captions(slipped).map(c => c.details.text)).toEqual(['three']);        // "one" left the window; "two" stays suppressed
  });

  it('(bus, tool) deleteItems on a caption suppresses it: the next addCaptions leaves it out', () => {
    const r = rig(list, {}, args), two = captions(r.e.doc)[1];
    expect(r.call('deleteItems', { itemIds: [two.id] }).success).toBe(true);
    expect(states(r.e.doc).some(c => c.state === 'excluded' && c.fromMs === 21500)).toBe(true);
    expect(r.call('addCaptions', { trackId: 'C1', ...args }).success).toBe(true);
    expect(captions(r.e.doc).map(c => c.details.text)).toEqual(['one', 'three']);
  });
});
