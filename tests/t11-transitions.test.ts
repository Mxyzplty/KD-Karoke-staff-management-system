// SPDX-License-Identifier: AGPL-3.0-only
// T11 transitions, the model and the tool: the window and chain rule (findings part 5 §55.2, §55.5 test values), the stored record and
// its limits (§55.1: 100–3000 ms, max = min(clip lengths, 3000), source handles never limit it), repair after item edits, the cut lookup,
// applyTransition (contracts #27; agent tool results §2 and §11; error codes §7) and the UI edits through the intent seam (part 3 §46.8).
// Expected values are written from those documents, not from running the code. Where the code uses its own wording or rule (marked "own"
// in apps/web/src/timeline/transitions.ts) the test says what the code says and is labelled "own wording/rule, not from the doc".
//
// Code ledger (every code T11 owns: the WHOLE response compared with toStrictEqual, and the document, the undo stack and the journal
// unchanged after the refusal). Line = the `it`/row in this file.
//   MISSING_PARAMETERS "Missing parameters"        → 'MISSING_PARAMETERS: no action / bad action / no address …' (REFUSALS rows m1–m6)
//   MISSING_PARAMETERS "Invalid alignment"         → REFUSALS row m7
//   ITEM_NOT_FOUND "Cut not resolved" (own text)   → REFUSALS rows i1–i2
//   INVALID_PAIR "Cut not resolved"                → REFUSALS rows p1 (different tracks: doc wording) and p2–p3 (not meeting ×2: own text)
//   CUT_NOT_FOUND "Cut not resolved" (doc wording)  → REFUSALS row c1; intent addTransition (UI) in 'addTransition refusals' (only "These clips no longer meet at a cut." is own)
//   UNKNOWN_KIND "Transition rejected"             → REFUSALS row u1
//   INVALID_PAIR "Transition rejected"             → REFUSALS rows p4 (audio) and p5 (too short); intent: already has one, too short
//   TRANSITION_NOT_FOUND "No transition"           → REFUSALS row n1 (update); intent editTransition (UI) in 'editTransition refusals'
//   INVALID_TOOL_INPUT (helper schema)             → 'applyTransition helper schema' block (validate(), whole body)
//   TRACK_LOCKED "Track L1 is locked"              → 'addTransition refusals' (intent addAtCut)
//   TRACK_LOCKED "Track L1 is locked"              → D32 Q17 agent lock refusals (add, replace, update, remove, absent cut record)
//   TRACK_LOCKED "Track L1 is locked"              → D34 UI group lock (intent addAtCut, lock only on an enclosing group)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from '../apps/helper/src/schemas';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { activeAt, chainParts, cutNear, cuts, directionFor, DIRECTIONS, KINDS, KIND_LABELS, maxMs, progressAt, resolveMs, windowOf, windowParts, pairOf } from '../apps/web/src/timeline/transitions';
import { build, itemOf, mkItem, mkTrack, resetIds, video } from './t03-fixtures';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T08:00:00.000Z')); });
afterEach(() => { resetIds(); vi.useRealTimers(); });

const json = (d: unknown) => JSON.stringify(d);
const img = (id: string, trackId: string, from: number, to: number) => mkItem(id, trackId, from, to, { type: 'image', metadata: { assetId: 'asset-img1' } });
const aud = (id: string, from: number, to: number) => mkItem(id, 'A1', from, to, { type: 'audio', trim: { from: 0, to: to - from }, sourceDuration: 8000, metadata: { assetId: 'asset-aud1' } });
/** V1: v1 0–4 s | v2 4–8 s | v3 8–8.05 s (50 ms) | v4 8.05–12 s | image i1 12–14 s.  V2: w1 0–3 s, x1 4–4.5 s (touches v1's end on another track),
 *  w2 5–8 s (gap before it), p1|p2 20–21.5 s | 21.5–23.5 s (1.5 s / 2 s), q1|q2 25–25.1 s | 25.1–27 s (100 ms / 1.9 s).  A1: a1|a2 40–43 s | 43–46 s.  L1 (locked): l1|l2 50–52 s | 52–54 s. */
const base = (): ProjectDocument => build({
  tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('V2', 'video'), mkTrack('L1', 'video', { locked: true })],
  items: [video('v1', 'V1', 0, 4000), video('v2', 'V1', 4000, 8000), video('v3', 'V1', 8000, 8050), video('v4', 'V1', 8050, 12000), img('i1', 'V1', 12000, 14000),
    video('w1', 'V2', 0, 3000), video('x1', 'V2', 4000, 4500), video('w2', 'V2', 5000, 8000), video('p1', 'V2', 20000, 21500), video('p2', 'V2', 21500, 23500),
    video('q1', 'V2', 25000, 25100), video('q2', 'V2', 25100, 27000), aud('a1', 40000, 43000), aud('a2', 43000, 46000),
    video('l1', 'L1', 50000, 52000), video('l2', 'L1', 52000, 54000)],
});
const editor = (doc = base()) => createEditor(doc);
type Editor = ReturnType<typeof editor>;
const ap = (e: Editor, args: Record<string, unknown>) => e.call('applyTransition', args) as any;
const stored = (e: Editor) => e.doc.transitions ?? [];
const ID = /^transition_[a-z0-9]{10}$/;
/** A refusal leaves the document, the undo stack and the journal as they were. */
const untouched = (e: Editor, before: string, n = 0) => { expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n); expect(e.journal).toHaveLength(n); };
/** The §2 stored shape of one transitions entry in timelineChanges. */
const entry = (id: string, trackId: string, fromId: string, toId: string, kind: string, duration: number, alignment: number, extra: RecordData = {}) => ({ id, trackId, fromId, toId, kind, duration, alignment, ...extra });
/** The shared T18a timelineChanges wrapper (basis, timeUnit, the read-back note) around the §2 transitions entry. */
const WRAP = { basis: 'observed_net_changes_during_call', timeUnit: 'seconds', detailsOmitted: true, readBack: 'Use context or viewItemDetails for changed fields not included in these summaries, or for truncated text.' };
const created = (...entries: RecordData[]) => ({ ...WRAP, transitions: { created: entries, updated: [], deleted: [] } });

describe('D32 Q17 applyTransition locked resolved tracks', () => {
  const record = { id: 'transition_abcdefghij', trackId: 'L1', fromId: 'l1', toId: 'l2', kind: 'fade', durationMs: 1000, alignment: 0.5 };
  it.each([
    ['add', false], ['add', true], ['update', true], ['remove', true], ['update', false], ['remove', false],
  ] as const)('%s with occupied=%s refuses without changes', (action, occupied) => {
    const doc = base(); if (occupied) doc.transitions = [record];
    const e = editor(doc), before = structuredClone(e.doc), bytes = json(e.doc), rev = e.doc.rev;
    const undo = e.bus.undoStack.length, journal = e.journal.length;
    expect(ap(e, { action, betweenItems: ['l1', 'l2'] })).toStrictEqual({ success: false, error: 'Track L1 is locked', code: 'TRACK_LOCKED' });
    expect(e.doc).toStrictEqual(before); expect(json(e.doc)).toBe(bytes); expect(e.doc.rev).toBe(rev);
    expect(e.bus.undoStack).toHaveLength(undo); expect(e.journal).toHaveLength(journal);
  });
  it('argument and cut resolution errors precede the lock check', () => {
    const e = editor(), before = json(e.doc);
    expect(ap(e, { action: 'add', betweenItems: ['l1', 'l2'], alignment: 'bad' })).toMatchObject({ success: false, code: 'MISSING_PARAMETERS' });
    expect(ap(e, { action: 'remove', betweenItems: ['l1', 'missing'] })).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
    untouched(e, before);
  });
  it('a lock on an enclosing group also refuses a resolved cut', () => {
    const doc = base();
    doc.tracks.find(t => t.id === 'L1')!.locked = false;
    doc.groups = { outer: { id: 'outer', name: 'Outer', locked: true, hidden: false, children: [{ type: 'group', id: 'inner' }] }, inner: { id: 'inner', name: 'Inner', locked: false, hidden: false, children: [{ type: 'track', id: 'L1' }] } };
    doc.layerOrder = [{ type: 'group', id: 'outer' }];
    const e = editor(doc), before = structuredClone(e.doc), bytes = json(e.doc), rev = e.doc.rev;
    expect(ap(e, { action: 'add', betweenItems: ['l1', 'l2'] })).toStrictEqual({ success: false, error: 'Track L1 is locked', code: 'TRACK_LOCKED' });
    expect(e.doc).toStrictEqual(before); expect(json(e.doc)).toBe(bytes); expect(e.doc.rev).toBe(rev); untouched(e, bytes);
  });
  it('D34: addAtCut (UI intent) refuses a track locked only through an enclosing group', () => {
    const doc = base();
    doc.tracks.find(t => t.id === 'L1')!.locked = false;
    doc.groups = { outer: { id: 'outer', name: 'Outer', locked: true, hidden: false, children: [{ type: 'group', id: 'inner' }] }, inner: { id: 'inner', name: 'Inner', locked: false, hidden: false, children: [{ type: 'track', id: 'L1' }] } };
    doc.layerOrder = [{ type: 'group', id: 'outer' }];
    const e = editor(doc), before = structuredClone(e.doc), bytes = json(e.doc), rev = e.doc.rev;
    expect(e.intent({ type: 'addTransition', fromId: 'l1', toId: 'l2' })).toStrictEqual({ ok: false, code: 'TRACK_LOCKED', message: 'Track L1 is locked' });
    expect(e.doc).toStrictEqual(before); expect(json(e.doc)).toBe(bytes); expect(e.doc.rev).toBe(rev); untouched(e, bytes);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('T11 registry (§55.1, §46.8)', () => {
  it('six kinds in the popover order; four directions; the picker labels', () => {
    expect(KINDS).toEqual(['fade', 'dissolve', 'additiveDissolve', 'dipToColorDissolve', 'slide', 'wipe']);
    expect(DIRECTIONS).toEqual(['from-left', 'from-right', 'from-top', 'from-bottom']);
    expect(KIND_LABELS).toEqual({ fade: 'Fade', dissolve: 'Cross Dissolve', additiveDissolve: 'Additive Dissolve', dipToColorDissolve: 'Dip To Color', slide: 'Push', wipe: 'Wipe' });
  });
  it('directionFor: only slide and wipe carry a direction; an invalid one becomes from-left', () => {
    expect(directionFor('slide', 'from-top')).toBe('from-top');
    expect(directionFor('wipe', 'from-bottom')).toBe('from-bottom');
    expect(directionFor('wipe', 'diagonal')).toBe('from-left');
    expect(directionFor('slide', undefined)).toBe('from-left');
    expect(directionFor('slide', 7)).toBe('from-left');
    for (const k of ['fade', 'dissolve', 'additiveDissolve', 'dipToColorDissolve']) expect(directionFor(k, 'from-top')).toBeUndefined();
  });
});

describe('T11 window (§55.2): D = max(1, floor(duration)), pre = floor(D × alignment), post = D − pre', () => {
  it.each([
    [1000, 0.5, 500, 500], [1000, 0, 0, 1000], [1000, 1, 1000, 0], [1001, 0.5, 500, 501], [999.9, 0.5, 499, 500], [100, 0.3, 30, 70],
    [333, 0.5, 166, 167], [0.4, 0.5, 0, 1], [0, 1, 1, 0], [3000, 0.5, 1500, 1500],
  ])('windowParts(%s, %s) → pre %s, post %s', (d, a, pre, post) => { expect(windowParts(d, a)).toEqual({ pre, post }); });

  it('§55.5 test values: a 1 s Center transition on a cut at 1000 ms, 30 fps → window [500, 1500), frames 15–44, p(frame 22) = .2333, frame 45 is outside', () => {
    const e = editor(build({ tracks: [mkTrack('V1', 'video')], items: [video('a', 'V1', 0, 1000), video('b', 'V1', 1000, 3000)] }));
    expect(ap(e, { action: 'add', betweenItems: ['a', 'b'] })).toMatchObject({ success: true });
    const r = stored(e)[0], w = windowOf(e.doc, r)!;
    expect(w).toEqual({ cut: 1000, pre: 500, post: 500, start: 500, end: 1500 });
    const frames = []; for (let f = 0; f < 60; f++) if (activeAt(e.doc, f * 1000 / 30).length) frames.push(f);
    expect(frames[0]).toBe(15); expect(frames[frames.length - 1]).toBe(44); expect(frames).toHaveLength(30);
    expect(progressAt(22 * 1000 / 30, w)).toBeCloseTo(0.2333, 4);
    expect(progressAt(37 * 1000 / 30, w)).toBeCloseTo(0.7333, 4);
    expect(activeAt(e.doc, 45 * 1000 / 30)).toEqual([]); // frame 45 = 1500 ms = plain B
    expect(progressAt(499.999, w)).toBeNull(); expect(progressAt(500, w)).toBe(0); expect(progressAt(1500, w)).toBeNull(); // half-open
  });
  it('alignment moves the window: Start [cut, cut+D), End [cut−D, cut)', () => {
    const e = editor();
    ap(e, { action: 'add', betweenItems: ['v1', 'v2'], alignment: 'start', durationSeconds: 2 });
    expect(windowOf(e.doc, stored(e)[0])).toMatchObject({ cut: 4000, start: 4000, end: 6000 });
    ap(e, { action: 'add', betweenItems: ['v1', 'v2'], alignment: 'end', durationSeconds: 2 });
    expect(windowOf(e.doc, stored(e)[0])).toMatchObject({ start: 2000, end: 4000 });
  });
});

describe('T11 chain rule (§55.2): two windows sharing one clip scale to fit; the leftover ms go by shortfall', () => {
  it.each([
    [777, 500, 500, [389, 388]], // the doc's example
    [700, 300, 400, [300, 400]], [1000, 1500, 500, [750, 250]], [10, 7, 6, [5, 5]], [7, 4, 4, [4, 3]], [11, 7, 8, [5, 6]], [600, 600, 600, [300, 300]],
  ])('chainParts(%s, %s, %s) → %j', (l, i, o, out) => { expect(chainParts(l, i, o)).toEqual(out); });

  it('the doc example: a 777 ms middle clip with two 1 s Center transitions → windows [1500, 2389) and [2389, 3277)', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 2000), video('m', 'V1', 2000, 2777), video('n', 'V1', 2777, 5000)] });
    // Stored lengths over the clip maximum cannot come from the tool (it clamps); a loaded document can hold them, and the window rule still applies.
    doc.transitions = [{ id: 'T1', trackId: 'V1', fromId: 'v1', toId: 'm', kind: 'fade', durationMs: 1000, alignment: 0.5 }, { id: 'T2', trackId: 'V1', fromId: 'm', toId: 'n', kind: 'fade', durationMs: 1000, alignment: 0.5 }];
    expect(windowOf(doc, doc.transitions[0])).toMatchObject({ start: 1500, end: 2389 });
    expect(windowOf(doc, doc.transitions[1])).toMatchObject({ start: 2389, end: 3277 });
    expect(activeAt(doc, 2388)).toHaveLength(1); expect(activeAt(doc, 2388)[0].record.id).toBe('T1');
    expect(activeAt(doc, 2389)[0].record.id).toBe('T2'); // at most one per track
  });
  it('reachable with the tool: a 600 ms middle clip, a Start transition into it and an End transition out of it (600 ms each) → 300 ms each', () => {
    const e = editor(build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 2000), video('m', 'V1', 2000, 2600), video('n', 'V1', 2600, 5000)] }));
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'm'], alignment: 'start', durationSeconds: 1 })).toMatchObject({ success: true, data: { transition: { durationSeconds: 0.6 } } });
    expect(ap(e, { action: 'add', betweenItems: ['m', 'n'], alignment: 'end', durationSeconds: 1 })).toMatchObject({ success: true, data: { transition: { durationSeconds: 0.6 } } });
    const [t1, t2] = stored(e);
    expect(windowOf(e.doc, t1)).toMatchObject({ start: 2000, end: 2300 }); expect(windowOf(e.doc, t2)).toMatchObject({ start: 2300, end: 2600 });
    expect(t1.durationMs).toBe(600); expect(t2.durationMs).toBe(600); // stored lengths are not rewritten by the chain
  });
});

describe('T11 limits and the shared add step (§55.1: round, then clamp; only "too short" refuses)', () => {
  it('maxMs = floor(min(outgoing, incoming, 3000)); source handles never limit it', () => {
    const doc = base();
    expect(maxMs(itemOf(doc, 'v1'), itemOf(doc, 'v2'))).toBe(3000);
    expect(maxMs(itemOf(doc, 'p1'), itemOf(doc, 'p2'))).toBe(1500);
    expect(maxMs(itemOf(doc, 'v3'), itemOf(doc, 'v4'))).toBe(50);
    const noHandles = build({ tracks: [mkTrack('V1', 'video')], items: [video('a', 'V1', 0, 2000, 0, 2000), video('b', 'V1', 2000, 4000, 0, 2000)] });
    expect(maxMs(itemOf(noHandles, 'a'), itemOf(noHandles, 'b'))).toBe(2000);
  });
  it('resolveMs rounds, then clamps to [100, max]', () => {
    expect(resolveMs(600.6, 4000)).toBe(601); expect(resolveMs(600.4, 4000)).toBe(600); expect(resolveMs(50, 4000)).toBe(100);
    expect(resolveMs(5000, 3000)).toBe(3000); expect(resolveMs(2000, 1500)).toBe(1500); expect(resolveMs(1000, 100)).toBe(100);
    expect(() => resolveMs(1000, 99)).toThrow();
  });
  it('the tool rounds durationSeconds to whole ms: 0.6006 → 601, 0.6004 → 600', () => {
    const e = editor();
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], durationSeconds: 0.6006 })).toMatchObject({ success: true, data: { transition: { durationSeconds: 0.601 } } });
    expect(stored(e)[0].durationMs).toBe(601);
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], durationSeconds: 0.6004 })).toMatchObject({ success: true, data: { transition: { durationSeconds: 0.6 } } });
    expect(stored(e)[0].durationMs).toBe(600);
  });
  it('clamps (own wording after the dash, not from the doc): over 3 s → 3.00s; under 0.1 s → 0.10s; over the shorter clip → its length', () => {
    const TAIL = (d: string) => ` Duration clamped to ${d}s — a transition lasts from 0.10s up to the shorter clip's length, at most 3.00s.`;
    const e = editor();
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], durationSeconds: 5 })).toStrictEqual({
      success: true, message: 'Added fade transition (3.00s, center on the cut) on v1 → v2 at 4.00s.' + TAIL('3.00'),
      data: { transition: { id: expect.stringMatching(ID), kind: 'fade', durationSeconds: 3, alignment: 'center' } }, timelineChanges: created(entry(stored(e)[0]?.id ?? expect.stringMatching(ID), 'V1', 'v1', 'v2', 'fade', 3, 0.5)),
    });
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], durationSeconds: 0.05 }).message).toBe('Replaced fade transition (0.10s, center on the cut) on v1 → v2 at 4.00s.' + TAIL('0.10'));
    expect(stored(e)[0].durationMs).toBe(100);
    const f = editor(); // p1 1.5 s, p2 2 s: the shorter clip caps the length
    expect(ap(f, { action: 'add', betweenItems: ['p1', 'p2'], durationSeconds: 2 }).message).toBe('Added fade transition (1.50s, center on the cut) on p1 → p2 at 21.50s.' + TAIL('1.50'));
    expect(stored(f)[0].durationMs).toBe(1500);
    const g = editor(); // exactly 100 ms is allowed; a default 1 s clamps down to it
    expect(ap(g, { action: 'add', betweenItems: ['q1', 'q2'] }).message).toBe('Added fade transition (0.10s, center on the cut) on q1 → q2 at 25.10s.' + TAIL('0.10'));
    expect(stored(g)[0].durationMs).toBe(100);
  });
  it('a request that is not clamped carries no tail', () => {
    const e = editor();
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], durationSeconds: 3 }).message).toBe('Added fade transition (3.00s, center on the cut) on v1 → v2 at 4.00s.');
  });
});

describe('T11 cuts and the atSeconds lookup (contracts #27: within 0.5 s)', () => {
  it('cuts(): every meeting pair on every track, track by track in document order; not across tracks, not over gaps', () => {
    const pairs = cuts(base()).map(c => `${c.from.id}>${c.to.id}`);
    expect(pairs).toEqual(['a1>a2', 'v1>v2', 'v2>v3', 'v3>v4', 'v4>i1', 'p1>p2', 'q1>q2', 'l1>l2']);
    expect(pairs).not.toContain('v1>x1'); expect(pairs).not.toContain('w1>w2'); expect(pairs).not.toContain('x1>w2');
  });
  it('two clips meet when |outgoing end − incoming start| ≤ 1 ms', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('a', 'V1', 0, 2000), video('b', 'V1', 2001, 4000), video('c', 'V1', 4003, 6000)] });
    expect(cuts(doc).map(c => `${c.from.id}>${c.to.id}`)).toEqual(['a>b']);
  });
  it('cutNear: nearest cut, 0.5 s radius is inclusive', () => {
    const doc = base();
    expect(cutNear(doc, 4.3).to.id).toBe('v2'); expect(cutNear(doc, 3.5).to.id).toBe('v2'); expect(cutNear(doc, 4.5).to.id).toBe('v2');
    expect(() => cutNear(doc, 4.501)).toThrow(); expect(() => cutNear(doc, 3.499)).toThrow();
  });
  it('Q3 (own rule, not from the doc): a tie goes to the EARLIER cut, then to the first track in document order', () => {
    const two = (v1cut: number, v2cut: number, order: string[]) => build({ tracks: order.map(id => mkTrack(id, 'video')), items: [
      video('a', 'V1', 0, v1cut), video('b', 'V1', v1cut, 6000), video('c', 'V2', 0, v2cut), video('d', 'V2', v2cut, 6000)] });
    expect(cutNear(two(3750, 4250, ['V1', 'V2']), 4).to.id).toBe('b');   // earlier cut is on V1
    expect(cutNear(two(4250, 3750, ['V1', 'V2']), 4).to.id).toBe('d');   // earlier cut is on V2: time beats track order
    expect(cutNear(two(4000, 4000, ['V1', 'V2']), 4).to.id).toBe('b');   // same time: first track in document order
    expect(cutNear(two(4000, 4000, ['V2', 'V1']), 4).to.id).toBe('d');   // reorder the tracks → the other one
    const e = editor(two(3750, 4250, ['V1', 'V2']));
    expect(ap(e, { action: 'add', atSeconds: 4 }).message).toBe('Added fade transition (1.00s, center on the cut) on a → b at 3.75s.');
  });
  it('atSeconds can land on a cut of a non-visual track (audio): then the pair is refused (see REFUSALS p4)', () => {
    expect(cutNear(base(), 43).to.id).toBe('a2');
  });
});

describe('T11 repair (§55.1): runs after every edit that changes items — max under 100 ms removes, over the max clamps down', () => {
  const trim = (e: Editor, itemId: string, deltaSeconds: number) => expect(e.call('trimItem', { itemId, handle: 'end', deltaSeconds })).toMatchObject({ success: true });
  it('a clip trimmed to 50 ms removes the transition; undo brings it back', () => {
    const e = editor(); ap(e, { action: 'add', betweenItems: ['v1', 'v2'] });
    trim(e, 'v2', -3.95); // 4000 → 50 ms
    expect(stored(e)).toEqual([]);
    e.intent({ type: 'undo' }); expect(stored(e)).toHaveLength(1); expect(stored(e)[0].durationMs).toBe(1000);
  });
  it('a clip trimmed to 400 ms clamps a stored 3000 down to 400 (not removed)', () => {
    const e = editor(); ap(e, { action: 'add', betweenItems: ['v1', 'v2'], durationSeconds: 3 });
    trim(e, 'v2', -3.6);
    expect(stored(e)).toHaveLength(1); expect(stored(e)[0].durationMs).toBe(400);
  });
  it('a stored length over the maximum is clamped by the next item edit anywhere (3000 on a 2 s pair → 2000)', () => {
    const doc = base(); doc.transitions = [{ id: 'T9', trackId: 'V2', fromId: 'p1', toId: 'p2', kind: 'dissolve', durationMs: 5000, alignment: 0.5 }];
    const e = editor(doc);
    trim(e, 'w1', -0.5); // an unrelated item edit
    expect(stored(e)[0].durationMs).toBe(1500);
  });
  it('deleting a clip of the pair removes the transition', () => {
    const e = editor(); ap(e, { action: 'add', betweenItems: ['v1', 'v2'] });
    expect(e.call('deleteItems', { itemIds: ['v2'] })).toMatchObject({ success: true });
    expect(stored(e)).toEqual([]);
  });
  it('Q4 (own rule, not from the doc): clips moved apart keep the record, which is then not drawn; moving back draws it again', () => {
    const e = editor(build({ tracks: [mkTrack('V1', 'video')], items: [video('a', 'V1', 0, 4000), video('b', 'V1', 4000, 8000)] }));
    ap(e, { action: 'add', betweenItems: ['a', 'b'] });
    expect(activeAt(e.doc, 4000)).toHaveLength(1);
    expect(e.call('moveItem', { itemId: 'b', by: 1 })).toMatchObject({ success: true });
    expect(stored(e)).toHaveLength(1); expect(pairOf(e.doc, stored(e)[0])).toBeNull(); expect(windowOf(e.doc, stored(e)[0])).toBeNull();
    expect(activeAt(e.doc, 4500)).toEqual([]);
    e.intent({ type: 'undo' }); expect(activeAt(e.doc, 4000)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('T11 applyTransition: success matrix (results §2, §11)', () => {
  it('add with defaults: fade, 1 s, center; the §2 message; data.transition; one "Add transition" entry; the stored record', () => {
    const e = editor();
    const r = ap(e, { action: 'add', betweenItems: ['v1', 'v2'] });
    const rec = stored(e)[0];
    expect(r).toStrictEqual({
      success: true, message: 'Added fade transition (1.00s, center on the cut) on v1 → v2 at 4.00s.',
      data: { transition: { id: expect.stringMatching(ID), kind: 'fade', durationSeconds: 1, alignment: 'center' } },
      timelineChanges: created(entry(rec.id, 'V1', 'v1', 'v2', 'fade', 1, 0.5)),
    });
    expect(rec).toStrictEqual({ id: expect.stringMatching(ID), trackId: 'V1', fromId: 'v1', toId: 'v2', kind: 'fade', durationMs: 1000, alignment: 0.5 });
    expect(r.data.transition.id).toBe(rec.id);
    expect(e.labels()).toEqual(['Add transition']);
  });
  it('betweenItems in either order; atSeconds within 0.5 s resolves the same cut', () => {
    const a = editor(), b = editor(), c = editor();
    ap(a, { action: 'add', betweenItems: ['v1', 'v2'] }); ap(b, { action: 'add', betweenItems: ['v2', 'v1'] });
    expect(ap(c, { action: 'add', atSeconds: 4.3 }).message).toBe('Added fade transition (1.00s, center on the cut) on v1 → v2 at 4.00s.');
    for (const x of [a, b, c]) expect(stored(x).map(r => [r.fromId, r.toId])).toEqual([['v1', 'v2']]);
  });
  it('the §2 example: a 0.6 s dissolve; a video→image cut also works', () => {
    const e = editor();
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'dissolve', durationSeconds: 0.6 }).message).toBe('Added dissolve transition (0.60s, center on the cut) on v1 → v2 at 4.00s.');
    expect(stored(e)[0]).toMatchObject({ kind: 'dissolve', durationMs: 600 });
    expect(ap(e, { action: 'add', betweenItems: ['v4', 'i1'], kind: 'additiveDissolve' }).message).toBe('Added additiveDissolve transition (1.00s, center on the cut) on v4 → i1 at 12.00s.');
  });
  it.each([['start', 0], ['center', 0.5], ['end', 1]])('alignment %s is stored as %s and read back as the word', (word, a) => {
    const e = editor();
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], alignment: word }).message).toBe(`Added fade transition (1.00s, ${word} on the cut) on v1 → v2 at 4.00s.`);
    expect(stored(e)[0].alignment).toBe(a);
  });
  it('direction: slide and wipe store one (default from-left); other kinds drop it; params are stored as given', () => {
    const e = editor();
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'wipe' }).data.transition).toStrictEqual({ id: expect.stringMatching(ID), kind: 'wipe', durationSeconds: 1, alignment: 'center', direction: 'from-left' });
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'slide', direction: 'from-bottom' }).data.transition.direction).toBe('from-bottom');
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'wipe', params: { softness: 20 } }).data.transition).toMatchObject({ direction: 'from-left', params: { softness: 20 } });
    expect(stored(e)[0].params).toEqual({ softness: 20 });
    const r = ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'dissolve', direction: 'from-right' });
    expect(r.data.transition).toStrictEqual({ id: expect.stringMatching(ID), kind: 'dissolve', durationSeconds: 1, alignment: 'center' });
    expect(stored(e)[0]).not.toHaveProperty('direction');
    for (const k of KINDS.filter(k => k !== 'slide' && k !== 'wipe')) { ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: k, direction: 'from-top' }); expect(stored(e)[0]).not.toHaveProperty('direction'); }
  });
  it('re-adding over an occupied cut replaces the whole record in place (same id, params dropped); the entry is labelled "Change transition"', () => {
    const e = editor();
    ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'wipe', params: { softness: 20 } });
    const id = stored(e)[0].id;
    const r = ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'slide', durationSeconds: 2, alignment: 'end', direction: 'from-top' });
    expect(r.message).toBe('Replaced slide transition (2.00s, end on the cut) on v1 → v2 at 4.00s.');
    expect(r.data).toStrictEqual({ transition: { id, kind: 'slide', durationSeconds: 2, alignment: 'end', direction: 'from-top' } });
    expect(stored(e)).toStrictEqual([{ id, trackId: 'V1', fromId: 'v1', toId: 'v2', kind: 'slide', durationMs: 2000, alignment: 1, direction: 'from-top' }]);
    expect(e.labels()).toEqual(['Add transition', 'Change transition']);
    // add replaces the WHOLE record: fields not given go back to the defaults
    ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'dissolve' });
    expect(stored(e)).toStrictEqual([{ id, trackId: 'V1', fromId: 'v1', toId: 'v2', kind: 'dissolve', durationMs: 1000, alignment: 0.5 }]);
  });
  it('update merges only the given fields (one "Edit transition" entry); the clamp is applied to the merged value', () => {
    const e = editor();
    ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'slide', durationSeconds: 2, alignment: 'end', direction: 'from-top' });
    const id = stored(e)[0].id;
    const r = ap(e, { action: 'update', betweenItems: ['v1', 'v2'], durationSeconds: 5 });
    expect(r.message).toBe("Updated slide transition (3.00s, end on the cut) on v1 → v2 at 4.00s. Duration clamped to 3.00s — a transition lasts from 0.10s up to the shorter clip's length, at most 3.00s."); // tail: own wording
    expect(r.data).toStrictEqual({ transition: { id, kind: 'slide', durationSeconds: 3, alignment: 'end', direction: 'from-top' } });
    expect(stored(e)[0]).toStrictEqual({ id, trackId: 'V1', fromId: 'v1', toId: 'v2', kind: 'slide', durationMs: 3000, alignment: 1, direction: 'from-top' });
    expect(e.labels()).toEqual(['Add transition', 'Edit transition']);
    ap(e, { action: 'update', atSeconds: 4, alignment: 'start' });
    expect(stored(e)[0]).toMatchObject({ id, kind: 'slide', durationMs: 3000, alignment: 0, direction: 'from-top' });
    ap(e, { action: 'update', betweenItems: ['v2', 'v1'], kind: 'dissolve' });
    expect(stored(e)[0]).toStrictEqual({ id, trackId: 'V1', fromId: 'v1', toId: 'v2', kind: 'dissolve', durationMs: 3000, alignment: 0 });
  });
  it('update with only a new kind keeps the stored direction on the agent path (merge; own behaviour, not from the doc) — the UI path resets it (see editTransition)', () => {
    const e = editor();
    ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'slide', direction: 'from-top' });
    ap(e, { action: 'update', betweenItems: ['v1', 'v2'], kind: 'wipe' });
    expect(stored(e)[0]).toMatchObject({ kind: 'wipe', direction: 'from-top' });
  });
  it('remove: the §2 sentence, the deleted record in timelineChanges, one "Remove transition" entry', () => {
    const e = editor();
    ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'dissolve', durationSeconds: 0.6 });
    const rec = stored(e)[0];
    expect(ap(e, { action: 'remove', betweenItems: ['v1', 'v2'] })).toStrictEqual({
      success: true, message: 'Removed the dissolve transition on v1 → v2 at 4.00s.',
      timelineChanges: { ...WRAP, transitions: { created: [], updated: [], deleted: [entry(rec.id, 'V1', 'v1', 'v2', 'dissolve', 0.6, 0.5)] } },
    });
    expect(stored(e)).toEqual([]); expect(e.labels()).toEqual(['Add transition', 'Remove transition']);
  });
  it('remove with nothing there still succeeds (§2), writes no entry (own sentence tail, not from the doc)', () => {
    const e = editor();
    expect(ap(e, { action: 'remove', betweenItems: ['v1', 'v2'] })).toStrictEqual({ success: true, message: 'There is no transition on the cut v1 → v2 at 4.00s, so nothing was removed.' });
    expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('a transition on a cut is not visible to reads of the timeline items (§11)', () => {
    const e = editor(); ap(e, { action: 'add', betweenItems: ['v1', 'v2'] });
    const ctx = e.call('context', {}) as any;
    expect(JSON.stringify(ctx)).not.toContain('transition');
  });
  it('each kind can be added and read back; the id has the form transition_<10 chars>', () => {
    const e = editor();
    for (const kind of KINDS) {
      const r = ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind });
      expect(r.success).toBe(true); expect(r.data.transition.kind).toBe(kind); expect(r.data.transition.id).toMatch(ID);
    }
    expect(stored(e)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('T11 applyTransition: refusals (whole response; nothing written)', () => {
  const MISSING = "applyTransition needs 'action' (add/update/remove) plus a cut address: 'betweenItems' ([outgoingId, incomingId]) or 'atSeconds'.";
  const NOT_MEET = (a: string, ae: number, b: string, bs: number) => `'${a}' ends at ${ae}ms and '${b}' starts at ${bs}ms, so they do not meet at a cut — transitions need two adjacent clips.`;
  const row = (code: string, error: string, message: string) => ({ success: false, code, error, message });
  type Row = [id: string, label: string, args: Record<string, unknown>, expected: Record<string, unknown>];
  const ROWS: Row[] = [
    ['m1', 'MISSING_PARAMETERS: no action', { betweenItems: ['v1', 'v2'] }, row('MISSING_PARAMETERS', 'Missing parameters', MISSING)],
    ['m2', 'MISSING_PARAMETERS: an action that is not add / update / remove', { action: 'zap', betweenItems: ['v1', 'v2'] }, row('MISSING_PARAMETERS', 'Missing parameters', MISSING)],
    ['m3', 'MISSING_PARAMETERS: neither betweenItems nor atSeconds', { action: 'add' }, row('MISSING_PARAMETERS', 'Missing parameters', MISSING)],
    ['m4', 'MISSING_PARAMETERS: atSeconds that is not a number', { action: 'add', atSeconds: '4' }, row('MISSING_PARAMETERS', 'Missing parameters', MISSING)],
    ['m5', 'MISSING_PARAMETERS: betweenItems with one id (doc text, error codes l.194)', { action: 'add', betweenItems: ['v1'] }, row('MISSING_PARAMETERS', 'Missing parameters', "'betweenItems' needs exactly two item ids (got 1).")],
    ['m6', 'MISSING_PARAMETERS: betweenItems with three ids (doc text, error codes l.194)', { action: 'add', betweenItems: ['v1', 'v2', 'v3'] }, row('MISSING_PARAMETERS', 'Missing parameters', "'betweenItems' needs exactly two item ids (got 3).")],
    ['m7', 'MISSING_PARAMETERS "Invalid alignment"', { action: 'add', betweenItems: ['v1', 'v2'], alignment: 'middle' }, row('MISSING_PARAMETERS', 'Invalid alignment', "'alignment' must be start, center, or end.")],
    ['i1', 'ITEM_NOT_FOUND: the first id is unknown (own message)', { action: 'add', betweenItems: ['nope', 'v2'] }, row('ITEM_NOT_FOUND', 'Cut not resolved', "Item 'nope' not found on the timeline. Read context for current item ids.")],
    ['i2', 'ITEM_NOT_FOUND: the second id is unknown (own message)', { action: 'remove', betweenItems: ['v1', 'gone'] }, row('ITEM_NOT_FOUND', 'Cut not resolved', "Item 'gone' not found on the timeline. Read context for current item ids.")],
    ['p1', 'INVALID_PAIR "Cut not resolved": different tracks (doc text, error codes l.195)', { action: 'add', betweenItems: ['v1', 'w1'] }, row('INVALID_PAIR', 'Cut not resolved', 'The two items are on different tracks — transitions need an adjacent same-track pair.')],
    ['p2', 'INVALID_PAIR "Cut not resolved": same track, not touching (own message)', { action: 'add', betweenItems: ['v1', 'v3'] }, row('INVALID_PAIR', 'Cut not resolved', NOT_MEET('v1', 4000, 'v3', 8000))],
    ['p3', 'INVALID_PAIR "Cut not resolved": the same pair given in the other order names the earlier clip first', { action: 'update', betweenItems: ['v3', 'v1'], kind: 'fade' }, row('INVALID_PAIR', 'Cut not resolved', NOT_MEET('v1', 4000, 'v3', 8000))],
    ['c1', 'CUT_NOT_FOUND: no cut within 0.5 s (doc text, error codes l.196)', { action: 'add', atSeconds: 15 }, row('CUT_NOT_FOUND', 'Cut not resolved', "No cut between adjacent clips within 0.5s of 15s. Use 'betweenItems' with the two item ids instead.")],
    ['u1', 'UNKNOWN_KIND', { action: 'add', betweenItems: ['v1', 'v2'], kind: 'zoom' }, row('UNKNOWN_KIND', 'Transition rejected', "Unknown transition kind 'zoom'. Available: fade, dissolve, additiveDissolve, dipToColorDissolve, slide, wipe")],
    ['p4', 'INVALID_PAIR "Transition rejected": an audio pair', { action: 'add', atSeconds: 43 }, row('INVALID_PAIR', 'Transition rejected', 'Transitions only work with video and image clips')],
    ['p5', 'INVALID_PAIR "Transition rejected": a pair whose shorter clip is under 100 ms', { action: 'add', betweenItems: ['v3', 'v4'] }, row('INVALID_PAIR', 'Transition rejected', 'These clips are too short for a transition (min 100ms)')],
    ['n1', 'TRANSITION_NOT_FOUND: update on a cut with none (frame is doc text, error codes l.198; only the cut description "v1 → v2 at 4.00s" is own)', { action: 'update', betweenItems: ['v1', 'v2'], durationSeconds: 2 }, row('TRANSITION_NOT_FOUND', 'No transition', "There is no transition on the cut v1 → v2 at 4.00s to update — use action 'add'.")],
  ];
  it.each(ROWS)('%s %s', (_id, _label, args, expected) => {
    const e = editor(), before = json(e.doc);
    expect(ap(e, args)).toStrictEqual(expected);
    untouched(e, before);
  });
  it('a refusal after earlier writes leaves those writes and adds no entry', () => {
    const e = editor(); ap(e, { action: 'add', betweenItems: ['v1', 'v2'] });
    const before = json(e.doc);
    expect(ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'zoom' })).toMatchObject({ success: false, code: 'UNKNOWN_KIND' });
    untouched(e, before, 1);
  });
  it('an update that fails on a bad kind does not change the stored record', () => {
    const e = editor(); ap(e, { action: 'add', betweenItems: ['v1', 'v2'], kind: 'wipe' });
    const before = json(e.doc);
    expect(ap(e, { action: 'update', betweenItems: ['v1', 'v2'], kind: 'zoom' })).toMatchObject({ success: false, code: 'UNKNOWN_KIND' });
    untouched(e, before, 1);
  });
});

describe('T11 applyTransition helper schema (INVALID_TOOL_INPUT, results §11: schema errors before anything changes)', () => {
  const body = (path: string, code: string, message: string) => ({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for applyTransition', message: `${path}: ${message}`, details: { errors: [{ path, code, message }] } });
  it('passes the documented forms', () => {
    for (const args of [{ action: 'add', betweenItems: ['a', 'b'] }, { action: 'add', atSeconds: 4 }, { action: 'update', betweenItems: ['a', 'b'], kind: 'wipe', direction: 'from-left', params: { softness: 20 }, durationSeconds: 0.6, alignment: 'end' }, { action: 'remove', atSeconds: 4.2 }])
      expect(validate('applyTransition', args)).toBeNull();
  });
  it('both address forms → INVALID_COMBINATION (whole body asserted by the next test); neither → refused; durationSeconds 0 → refused; unknown kind / direction / alignment / action → refused', () => {
    for (const args of [{ action: 'add', betweenItems: ['a', 'b'], atSeconds: 4 }, { action: 'add' }, { action: 'add', betweenItems: ['a', 'b'], durationSeconds: 0 },
      { action: 'add', betweenItems: ['a', 'b'], kind: 'zoom' }, { action: 'add', betweenItems: ['a', 'b'], kind: 'slide', direction: 'diagonal' }, { action: 'add', betweenItems: ['a', 'b'], alignment: 'middle' }, { action: 'zap', betweenItems: ['a', 'b'] }]) {
      const r = validate('applyTransition', args) as any;
      expect(r, json(args)).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for applyTransition' });
      expect(r.details.errors.length).toBeGreaterThan(0);
    }
  });
  it('the whole body for both address forms', () => {
    const r = validate('applyTransition', { action: 'add', betweenItems: ['a', 'b'], atSeconds: 4 }) as any;
    expect(r.success).toBe(false); expect(r.code).toBe('INVALID_TOOL_INPUT'); expect(r.error).toBe('Invalid input for applyTransition');
    expect(r.details.errors.map((x: any) => x.code)).toContain('INVALID_COMBINATION');
    expect(r).toStrictEqual(body(r.details.errors[0].path, r.details.errors[0].code, r.details.errors[0].message));
  });
  it('durationSeconds must be above 0 (a 0 never reaches the clamp)', () => {
    const r = validate('applyTransition', { action: 'add', betweenItems: ['a', 'b'], durationSeconds: 0 }) as any;
    expect(r.details.errors[0].path).toBe('$.durationSeconds');
    expect(r).toStrictEqual(body('$.durationSeconds', r.details.errors[0].code, r.details.errors[0].message));
  });
});

describe('T11 applyTransition is not gated by the stale-read check (contracts #27; the gate covers the TIMELINE_GATED tools only)', () => {
  const storage = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
  let seq = 0;
  const call = (toolName: string, input: Record<string, unknown>): Call => ({ type: 'call', callId: `t${++seq}`, executionKey: `mcp:conn:t${seq}`, toolName, input, session: 's' });
  it('with no read in the session, trimItem is refused as stale but applyTransition (add, update, remove) succeeds', async () => {
    const e = editor();
    const ex = new Executor({ storage: storage(), current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    expect(await ex.execute(call('trimItem', { itemId: 'v2', handle: 'end', deltaSeconds: -0.5 }))).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', scope: 'timeline' });
    expect(await ex.execute(call('applyTransition', { action: 'add', betweenItems: ['v1', 'v2'] }))).toMatchObject({ success: true });
    expect(await ex.execute(call('applyTransition', { action: 'update', betweenItems: ['v1', 'v2'], kind: 'dissolve' }))).toMatchObject({ success: true });
    expect(await ex.execute(call('applyTransition', { action: 'remove', betweenItems: ['v1', 'v2'] }))).toMatchObject({ success: true });
    expect(stored(e)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('T11 UI edits through the intent seam (part 3 §46.8): exact undo labels', () => {
  const add = (e: Editor, from = 'v1', to = 'v2') => e.intent({ type: 'addTransition', fromId: from, toId: to });
  it('addTransition: Fade, 1000 ms, center; one "Add transition" entry; undo and redo', () => {
    const e = editor();
    expect(add(e)).toEqual({ ok: true });
    expect(stored(e)).toStrictEqual([{ id: expect.stringMatching(ID), trackId: 'V1', fromId: 'v1', toId: 'v2', kind: 'fade', durationMs: 1000, alignment: 0.5 }]);
    expect(e.labels()).toEqual(['Add transition']);
    e.intent({ type: 'undo' }); expect(stored(e)).toEqual([]);
    e.intent({ type: 'redo' }); expect(stored(e)).toHaveLength(1);
  });
  it('fixture 6 (tickets l.153, W3-RT-04): a played-to-its-source-end clip a (trim 8000–10000 of 10000) meets b (trim from 0): addTransition succeeds, stores fade / 1000 / 0.5, nothing is refused or clamped by handles', () => {
    const e = editor(build({ tracks: [mkTrack('V1', 'video')], items: [video('a', 'V1', 0, 2000, 8000, 10000), video('b', 'V1', 2000, 4000, 0, 10000)] }));
    expect(e.intent({ type: 'addTransition', fromId: 'a', toId: 'b' })).toEqual({ ok: true });
    expect(stored(e)).toStrictEqual([{ id: expect.stringMatching(ID), trackId: 'V1', fromId: 'a', toId: 'b', kind: 'fade', durationMs: 1000, alignment: 0.5 }]);
    expect(e.labels()).toEqual(['Add transition']);
    // The agent path agrees: the full 1 s on a clip with no handle on either far side, and 2 s (the shorter clip's length) is not cut down by handles either.
    ap(e, { action: 'update', betweenItems: ['a', 'b'], durationSeconds: 2 });
    expect(stored(e)[0].durationMs).toBe(2000);
  });
  it('a cut with short clips: the default clamps (a 100 ms / 1.9 s pair → 100 ms; a 1.5 s / 2 s pair keeps 1000), no message', () => {
    const e = editor(); expect(add(e, 'q1', 'q2')).toEqual({ ok: true }); expect(stored(e)[0].durationMs).toBe(100);
    expect(add(e, 'p1', 'p2')).toEqual({ ok: true }); expect(stored(e)[1].durationMs).toBe(1000);
  });
  it('editTransition: each pick is one "Edit transition" entry; a kind switch resets the direction to from-left; non-direction kinds store none', () => {
    const e = editor(); add(e); const id = stored(e)[0].id;
    const edit = (patch: RecordData) => expect(e.intent({ type: 'editTransition', transitionId: id, patch })).toEqual({ ok: true });
    edit({ kind: 'slide' }); expect(stored(e)[0]).toMatchObject({ kind: 'slide', direction: 'from-left' });
    edit({ direction: 'from-bottom' }); expect(stored(e)[0].direction).toBe('from-bottom');
    edit({ kind: 'wipe' }); expect(stored(e)[0]).toMatchObject({ kind: 'wipe', direction: 'from-left' }); // the switch resets it
    edit({ direction: 'from-right' }); edit({ kind: 'dissolve' }); expect(stored(e)[0]).not.toHaveProperty('direction');
    edit({ alignment: 1 }); expect(stored(e)[0].alignment).toBe(1);
    edit({ alignment: 0 }); expect(stored(e)[0].alignment).toBe(0);
    edit({ durationMs: 2000 }); expect(stored(e)[0].durationMs).toBe(2000);
    edit({ durationMs: 99999 }); expect(stored(e)[0].durationMs).toBe(3000); // the update step clamps
    edit({ durationMs: 1 }); expect(stored(e)[0].durationMs).toBe(100);
    expect(stored(e)[0].id).toBe(id);
    expect(new Set(e.labels().slice(1))).toEqual(new Set(['Edit transition'])); expect(e.labels()[0]).toBe('Add transition');
    expect(e.labels()).not.toContain('Change transition'); // the UI never writes it
  });
  it('params survive a kind switch (§55.6: kept)', () => {
    const e = editor(); add(e); const id = stored(e)[0].id;
    e.intent({ type: 'editTransition', transitionId: id, patch: { kind: 'wipe', params: { softness: 40 } } });
    e.intent({ type: 'editTransition', transitionId: id, patch: { kind: 'slide' } });
    expect(stored(e)[0].params).toEqual({ softness: 40 });
  });
  it('removeTransition: one "Remove transition" entry; removing an unknown id is ok, changes nothing and writes no entry', () => {
    const e = editor(); add(e); const id = stored(e)[0].id;
    expect(e.intent({ type: 'removeTransition', transitionId: id })).toEqual({ ok: true });
    expect(stored(e)).toEqual([]); expect(e.labels()).toEqual(['Add transition', 'Remove transition']);
    // Unknown id (own behaviour, T11 notes: removeTransition filters by id and has no refusal): ok, the stored list is unchanged, and the bus writes no entry for a no-op.
    const g = editor(); add(g); const rec = json(stored(g));
    expect(g.intent({ type: 'removeTransition', transitionId: 'transition_unknown00' })).toEqual({ ok: true });
    expect(json(stored(g))).toBe(rec); expect(g.labels()).toEqual(['Add transition']);
  });
  it('addTransition refusals (UI path; own wordings): the Outcome carries code and "title message"; nothing is written', () => {
    const cases: [string, string, string, { ok: false; code: string; message: string }][] = [
      ['v1', 'v3', 'not meeting', { ok: false, code: 'CUT_NOT_FOUND', message: 'Cut not resolved These clips no longer meet at a cut.' }],
      ['v1', 'nope', 'a missing clip', { ok: false, code: 'CUT_NOT_FOUND', message: 'Cut not resolved These clips no longer meet at a cut.' }],
      ['l1', 'l2', 'a locked track', { ok: false, code: 'TRACK_LOCKED', message: 'Track L1 is locked' }],
      ['v3', 'v4', 'a 50 ms clip', { ok: false, code: 'INVALID_PAIR', message: 'Transition rejected These clips are too short for a transition (min 100ms)' }],
      ['a1', 'a2', 'audio', { ok: false, code: 'INVALID_PAIR', message: 'Transition rejected Transitions only work with video and image clips' }],
    ];
    for (const [from, to, label, outcome] of cases) { const e = editor(), before = json(e.doc); expect(add(e, from, to), label).toStrictEqual(outcome); untouched(e, before); }
    const e = editor(); add(e); const before = json(e.doc);
    expect(add(e)).toStrictEqual({ ok: false, code: 'INVALID_PAIR', message: 'Transition rejected This cut already has a transition.' });
    untouched(e, before, 1);
  });
  it('editTransition refusals (own wording): an unknown id, or a record whose clips no longer meet → TRANSITION_NOT_FOUND', () => {
    const e = editor(); const before = json(e.doc);
    expect(e.intent({ type: 'editTransition', transitionId: 'nope', patch: { kind: 'wipe' } })).toStrictEqual({ ok: false, code: 'TRANSITION_NOT_FOUND', message: 'No transition This transition no longer exists.' });
    untouched(e, before);
    const f = editor(build({ tracks: [mkTrack('V1', 'video')], items: [video('a', 'V1', 0, 4000), video('b', 'V1', 4000, 8000)] }));
    f.intent({ type: 'addTransition', fromId: 'a', toId: 'b' }); const id = stored(f)[0].id;
    f.call('moveItem', { itemId: 'b', by: 1 });
    const b2 = json(f.doc), n = f.bus.undoStack.length;
    expect(f.intent({ type: 'editTransition', transitionId: id, patch: { kind: 'wipe' } })).toStrictEqual({ ok: false, code: 'TRANSITION_NOT_FOUND', message: 'No transition This transition no longer exists.' });
    untouched(f, b2, n);
  });
});
