// SPDX-License-Identifier: AGPL-3.0-only
// T08 agent tools addMotionGraphic / editMotionGraphic on the T03 command path, the async dry-run path and the T18a executor and schemas.
// Oracle: agent tool results §2 (addMotionGraphic, editMotionGraphic); reference compares §1.4 (stored texts and templates: R1, R3, R4, 15, 16, 16b);
// error codes §9. Rulings: Q4 (an invalid summary is MISSING_PARAM on add and edit, error = message); Cutframe improvement (4) (a patch that is not found
// fails the whole call atomically with STRING_NOT_FOUND and data.patches holds every status). Units: documents hold ms, tool arguments and results seconds.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHelper } from '../apps/helper/src/helper';
import type { Helper } from '../apps/helper/src/helper';
import { NOT_CONNECTED_ERROR } from '../apps/web/src/agent/protocol';
import { Executor } from '../apps/web/src/agent/executor';
import type { Call } from '../apps/web/src/agent/executor';
import { MotionGraphicError } from '../apps/web/src/mg/errors';
import { callMotionGraphicTool, loadCompiler, MOTION_GRAPHIC_TOOLS } from '../apps/web/src/mg/tools';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem, mkTrack, resetIds, span, useIds, video } from './t03-fixtures';

// The handlers compile synchronously once the lazily loaded compiler is in (review M4).
beforeAll(loadCompiler);
beforeEach(() => useIds());
afterEach(() => resetIds());

// ---- Texts (reference compares §1.4), spelled out here so the tests do not read them from the code.
const SUMMARY_REQUIRED = 'Motion graphic summary is required. Describe what the graphic visually represents in 1 sentence, or up to 3 short sentences for complex graphics.';
const SUMMARY_LONG = 'Motion graphic summary must be 400 characters or less.';
const VIDEO_REFUSAL = `compilation error: Native <video> elements are not supported. Use Remotion's <OffthreadVideo> with getAssetUrl() instead. Example: const url = getAssetUrl("video_1"); <OffthreadVideo src={url} />`;
const IMG_REFUSAL = `compilation error: Native <img> elements are not supported. Use Remotion's <Img> with getAssetUrl() instead. Example: const url = getAssetUrl("image_1"); <Img src={url} />`;
const AUDIO_REFUSAL = `compilation error: Native <audio> elements are not supported. Use Remotion's a Remotion component with getAssetUrl() instead. Example: const url = getAssetUrl("image_1"); <Img src={url} />`;
const EXPORT_REFUSAL = 'compilation error: Put every helper (constants, components, functions) above the exported component and end the code with it: `export const MyAnimation = () => { … };` must be the last statement, with nothing after it.';
const ASSET_PREFIX = "getAssetUrl() takes a project asset's agentId. ";
const fontWarning = (name: string) => `Font "${name}" is not in the font catalog — it will fall back to a system font when rendered (editor preview may differ from the export). Use a catalog font.`;
const CAP_NOTE = (length: string, asked: string) => `, ${length}s: its designed length (${asked}s asked). A longer graphic is a new revision with a longer durationSeconds.`;
const MISSING_CODE_MESSAGE = 'addMotionGraphic requires a code parameter with React/Remotion component code';

// ---- Fixtures. Tracks bottom to top; O2 is the empty overlay that add tests use; OL is locked.
const CODE = `export const Card = () => <AbsoluteFill style={{ backgroundColor: '#112233' }}><div style={{ fontFamily: 'Roboto', color: '#fff' }}>Hello</div></AbsoluteFill>;`;
const BOX = { width: 540, height: 960, x: 10, y: 20 };
const SUMMARY = 'A lower third.';
const text = (id: string, trackId: string, from: number, to: number) => mkItem(id, trackId, from, to, { type: 'text', details: { text: 'x' } });
const mg = (id: string, trackId: string, from: number, to: number, extra: Record<string, unknown> = {}) =>
  mkItem(id, trackId, from, to, { type: 'motionGraphic', trim: { from: 0, to: to - from }, sourceDuration: to - from, details: { name: 'Motion graphic', code: CODE }, metadata: { summary: 'A card.' }, ...extra });

function world(): ProjectDocument {
  return build({
    tracks: [mkTrack('A1', 'audio'), mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay'), mkTrack('O3', 'overlay'), mkTrack('OL', 'overlay', { locked: true })],
    items: [video('v1', 'V1', 0, 4000), mkItem('a1', 'A1', 0, 5000, { type: 'audio', trim: { from: 0, to: 5000 }, sourceDuration: 8000, metadata: { assetId: 'asset-aud1' } }),
      text('t1', 'O1', 1000, 3000), mkItem('sh1', 'O3', 0, 1000, { type: 'shape' }), mkItem('ly1', 'O3', 10000, 11000, { type: 'layout' })],
  });
}
/** Motion graphics to edit, on O2: mg1 (summary), mg2 (code, no summary), mgDup (two equal spans), mgLegacy (no code). */
function editWorld(): ProjectDocument {
  const doc = world();
  doc.items.push(mg('mg1', 'O2', 0, 5000), mg('mg2', 'O2', 6000, 9000, { metadata: {} }),
    mg('mgDup', 'O2', 10000, 12000, { details: { name: 'Motion graphic', code: 'export const D = () => <AbsoluteFill><b>AA</b><b>AA</b></AbsoluteFill>;' } }),
    mg('mgLegacy', 'O2', 13000, 15000, { details: { name: 'Old' }, metadata: {} }));
  return doc;
}
/** O1 is blocked at 1-3 s; `blocked` lists the other overlay tracks that are busy at 0-5 s. OL (locked) and V1 (video) are never free overlay tracks. */
function crowded(blocked: string[], extra: ReturnType<typeof text>[] = []): ProjectDocument {
  return build({
    tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay'), mkTrack('O3', 'overlay'), mkTrack('OL', 'overlay', { locked: true })],
    items: [video('v1', 'V1', 0, 10000), text('t1', 'O1', 1000, 3000), ...extra, ...blocked.map(id => text(`b-${id}`, id, 0, 5000))],
  });
}

type Editor = ReturnType<typeof editor>;
const editor = (doc: ProjectDocument = world()) => createEditor(doc, { assets: assets(), links: links() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (e: Editor, name: string, args: Record<string, unknown>): any => e.call(name, args);
const json = (d: unknown) => JSON.stringify(d);
const addArgs = (extra: Record<string, unknown> = {}) => ({ code: CODE, summary: SUMMARY, ...BOX, trackId: 'O2', ...extra });
const add = (e: Editor, extra: Record<string, unknown> = {}) => call(e, 'addMotionGraphic', addArgs(extra));
const only = (e: Editor, label: string) => {
  expect(e.bus.undoStack).toHaveLength(1);
  expect(e.bus.undoStack[0]).toMatchObject({ label, source: 'agent' });
  expect(e.journal).toHaveLength(1);
};
/** A refusal: success false, document byte-identical, no undo entry, no journal record, no timelineChanges. */
const refused = (e: Editor, before: string, r: { success: boolean; timelineChanges?: unknown }) => {
  expect(r.success).toBe(false); expect(r.timelineChanges).toBeUndefined();
  expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
};
const item = (e: Editor, id: string) => e.doc.items.find(i => i.id === id)!;
const graphics = (e: Editor) => e.doc.items.filter(i => i.type === 'motionGraphic');
const REQUIRED = (name: string) => `must have required property '${name}'`;

describe('addMotionGraphic: success (results §2, reference compares §1.4)', () => {
  it('reaches the tool table: MOTION_GRAPHIC_TOOLS is exactly the two tools and callTool does not answer UNKNOWN_TOOL', () => {
    expect([...MOTION_GRAPHIC_TOOLS].sort()).toEqual(['addMotionGraphic', 'editMotionGraphic']);
    const e = editor();
    expect(add(e)).toMatchObject({ success: true });
  });

  it('message, data keys in order, the stored item and one "Add items" step (default duration 5 s, timelineStart 0)', () => {
    const e = editor();
    const r = add(e);
    expect(r.success).toBe(true);
    const id = r.data.itemId;
    expect(r.message).toBe(`Motion graphic '${id}' added to track 'O2' at 0s`);
    expect(Object.keys(r.data)).toEqual(['itemId', 'trackId', 'duration', 'timelineStart', 'summary']);
    expect(r.data).toEqual({ itemId: id, trackId: 'O2', duration: 5, timelineStart: 0, summary: SUMMARY });
    const stored = item(e, id);
    expect(stored).toMatchObject({ type: 'motionGraphic', trackId: 'O2', display: { from: 0, to: 5000 }, trim: { from: 0, to: 5000 }, sourceDuration: 5000, details: { code: CODE }, metadata: { summary: SUMMARY } });
    expect(stored.properties).toMatchObject({ positionX: { defaultValue: 10 }, positionY: { defaultValue: 20 }, width: { defaultValue: 540 }, height: { defaultValue: 960 }, scale: { defaultValue: 1 } });
    only(e, 'Add items');
  });

  it('timelineChanges: one created motionGraphic entry that carries trim {from:0, to:<length>}, in seconds', () => {
    const e = editor();
    const r = add(e, { timelineStart: 2 });
    expect(r.timelineChanges.items.created).toHaveLength(1);
    expect(r.timelineChanges.items.created[0]).toMatchObject({ itemId: r.data.itemId, type: 'motionGraphic', trackId: 'O2', from: 2, to: 7, trim: { from: 0, to: 5 } });
    expect(r.timelineChanges.items.updated).toEqual([]); expect(r.timelineChanges.items.deleted).toEqual([]);
  });

  it('no motion-graphic summary carries playbackRate (created, updated before/after, deleted); other types keep it', () => {
    // Research §1.8.3 item 2 (21 stored results): Xapp never puts playbackRate in a motion-graphic item summary. `in` rather
    // than toMatchObject, which does not catch an extra field.
    const e = editor();
    const a = add(e);
    const id = a.data.itemId;
    expect(item(e, id).playbackRate).toBe(1); // stored on the item; just not reported
    expect('playbackRate' in a.timelineChanges.items.created[0]).toBe(false);
    const u = call(e, 'editMotionGraphic', { itemId: id, action: 'updateCode', code: CODE.replace('Hello', 'Bye') });
    const row = u.timelineChanges.items.updated[0];
    expect('playbackRate' in row.before).toBe(false); expect('playbackRate' in row.after).toBe(false);
    const d = call(e, 'deleteItems', { itemIds: [id] });
    expect('playbackRate' in d.timelineChanges.items.deleted[0]).toBe(false);
    // A video item still reports it.
    const v = call(e, 'moveItem', { itemId: 'v1', by: 1 });
    expect(v.timelineChanges.items.updated[0].after.playbackRate).toBe(1);
  });

  it('timelineStart is echoed (message and data); a fractional start is printed without trailing zeros', () => {
    const e = editor();
    const a = add(e, { timelineStart: 20 });
    expect(a.data.timelineStart).toBe(20); expect(a.message).toBe(`Motion graphic '${a.data.itemId}' added to track 'O2' at 20s`);
    expect(span(e.doc, a.data.itemId)).toEqual([20000, 25000]);
    const b = add(e, { timelineStart: 30.5 });
    expect(b.data.timelineStart).toBe(30.5); expect(b.message).toBe(`Motion graphic '${b.data.itemId}' added to track 'O2' at 30.5s`);
  });

  it('the project duration grows to the end of the new graphic', () => {
    const e = editor();
    expect(e.doc.duration).toBe(11000);
    add(e, { timelineStart: 20 });
    expect(e.doc.duration).toBe(25000);
  });

  it('the summary is trimmed and runs of whitespace are collapsed to one space (stored and in data)', () => {
    const e = editor();
    const r = add(e, { summary: '  A   lower\n\tthird.  ' });
    expect(r.data.summary).toBe('A lower third.'); expect(item(e, r.data.itemId).metadata.summary).toBe('A lower third.');
  });

  it('a summary of exactly 400 characters after the collapse is accepted', () => {
    const e = editor();
    const r = add(e, { summary: 'a'.repeat(199) + ' '.repeat(50) + 'b'.repeat(200) });
    expect(r.success).toBe(true); expect(r.data.summary).toBe('a'.repeat(199) + ' ' + 'b'.repeat(200));
  });

  it('insertAfterItemId: the graphic starts at the reference item\'s end on its track, timelineStart is that end, and the step is "Insert items"', () => {
    const e = editor();
    const r = call(e, 'addMotionGraphic', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: 't1' });
    expect(r.success).toBe(true);
    expect(r.message).toBe(`Motion graphic '${r.data.itemId}' added to track 'O1' at 3s`);
    expect(r.data).toMatchObject({ trackId: 'O1', timelineStart: 3, duration: 5 });
    expect(span(e.doc, r.data.itemId)).toEqual([3000, 8000]);
    only(e, 'Insert items');
  });

  it('a motion graphic may follow text, shape, motionGraphic and layout items', () => {
    const e = editor(editWorld());
    for (const ref of ['t1', 'sh1', 'mg1', 'ly1']) {
      const r = call(e, 'addMotionGraphic', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: ref });
      expect(r, ref).toMatchObject({ success: true });
    }
  });

  describe('durations', () => {
    it('animationDuration alone sets the length', () => {
      const e = editor();
      const r = add(e, { animationDuration: 3 });
      expect(r.data.duration).toBe(3); expect(r.data).not.toHaveProperty('cappedToDesignedLength');
      expect(item(e, r.data.itemId)).toMatchObject({ display: { from: 0, to: 3000 }, trim: { from: 0, to: 3000 }, sourceDuration: 3000 });
    });
    it('duration alone sets the length, with no cap', () => {
      const e = editor();
      const r = add(e, { duration: 8 });
      expect(r.data.duration).toBe(8); expect(r.data).not.toHaveProperty('cappedToDesignedLength');
      expect(r.message).toBe(`Motion graphic '${r.data.itemId}' added to track 'O2' at 0s`);
    });
    it('a duration longer than animationDuration is capped to it: flag, cap note, key order', () => {
      const e = editor();
      const r = add(e, { duration: 8, animationDuration: 4 });
      expect(r.success).toBe(true);
      expect(r.data.duration).toBe(4); expect(r.data.cappedToDesignedLength).toBe(true);
      expect(Object.keys(r.data)).toEqual(['itemId', 'trackId', 'duration', 'cappedToDesignedLength', 'timelineStart', 'summary']);
      expect(r.message).toBe(`Motion graphic '${r.data.itemId}' added to track 'O2' at 0s${CAP_NOTE('4', '8')}`);
      expect(span(e.doc, r.data.itemId)).toEqual([0, 4000]);
      expect(r.timelineChanges.items.created[0]).toMatchObject({ from: 0, to: 4, trim: { from: 0, to: 4 } });
    });
    it('the cap note prints fractional seconds as they are', () => {
      const e = editor();
      const r = add(e, { duration: 7.5, animationDuration: 2.5 });
      expect(r.data.duration).toBe(2.5);
      expect(r.message).toBe(`Motion graphic '${r.data.itemId}' added to track 'O2' at 0s${CAP_NOTE('2.5', '7.5')}`);
    });
    it('a duration shorter than, or equal to, animationDuration is not capped: no flag, no note', () => {
      const e = editor();
      for (const duration of [3, 4]) {
        const r = add(e, { duration, animationDuration: 4, timelineStart: duration * 10 });
        expect(r.data.duration, `duration ${duration}`).toBe(duration); expect(r.data).not.toHaveProperty('cappedToDesignedLength');
        expect(r.message).not.toContain('designed length');
      }
    });
    it('a short duration still has the designed length as its source length, so the graphic can be trimmed back out', () => {
      const e = editor();
      const r = add(e, { duration: 3, animationDuration: 4 });
      expect(item(e, r.data.itemId)).toMatchObject({ display: { from: 0, to: 3000 }, trim: { from: 0, to: 3000 }, sourceDuration: 4000 });
    });
    it('duration <= 0 → INVALID_DURATION', () => {
      for (const duration of [0, -2]) {
        const e = editor(); const before = json(e.doc);
        const r = add(e, { duration });
        expect(r).toMatchObject({ success: false, code: 'INVALID_DURATION', error: `duration must be positive. Received: ${duration}s.` }); refused(e, before, r);
      }
    });
    it('timelineStart < 0 → INVALID_TIMELINE_START', () => {
      const e = editor(); const before = json(e.doc);
      const r = add(e, { timelineStart: -1 });
      expect(r).toMatchObject({ success: false, code: 'INVALID_TIMELINE_START', error: 'timelineStart must be >= 0. Received: -1s.' }); refused(e, before, r);
    });
  });

  describe('font warnings', () => {
    it('a family outside the catalogue adds the suffix and data.fontWarnings (last key); a catalogue family (Roboto) and no font add nothing', () => {
      const e = editor();
      const code = CODE.replace('Roboto', 'Montserrat');
      const r = add(e, { code });
      expect(r.success).toBe(true);
      expect(r.message).toBe(`Motion graphic '${r.data.itemId}' added to track 'O2' at 0s — FONT WARNING: ${fontWarning('Montserrat')}`);
      expect(r.data.fontWarnings).toEqual([fontWarning('Montserrat')]);
      expect(Object.keys(r.data)).toEqual(['itemId', 'trackId', 'duration', 'timelineStart', 'summary', 'fontWarnings']);
      const ok = add(e, { timelineStart: 10 });
      expect(ok.message).not.toContain('FONT WARNING'); expect(ok.data).not.toHaveProperty('fontWarnings');
      const none = add(e, { code: 'export const G = () => <AbsoluteFill />;', timelineStart: 20 });
      expect(none.message).not.toContain('FONT WARNING'); expect(none.data).not.toHaveProperty('fontWarnings');
    });
    it('several warnings are joined by one space in the message and listed in order in data; the cap note comes first', () => {
      const e = editor();
      const code = `export const G = () => <AbsoluteFill><div style={{ fontFamily: 'Montserrat' }}>a</div><div style={{ fontFamily: 'Lobster' }}>b</div></AbsoluteFill>;`;
      const r = add(e, { code, duration: 8, animationDuration: 4 });
      expect(r.message).toBe(`Motion graphic '${r.data.itemId}' added to track 'O2' at 0s${CAP_NOTE('4', '8')} — FONT WARNING: ${fontWarning('Montserrat')} ${fontWarning('Lobster')}`);
      expect(r.data.fontWarnings).toEqual([fontWarning('Montserrat'), fontWarning('Lobster')]);
    });
    it('the font name is read from the source text: a template literal is not evaluated', () => {
      const e = editor();
      const code = 'export const G = () => { const font = "Roboto"; return <AbsoluteFill style={{ fontFamily: `${font}` }} />; };';
      const r = add(e, { code });
      expect(r.data.fontWarnings).toEqual([fontWarning('${font}')]);
    });
  });
});

describe('addMotionGraphic: failures in the order of results §2 (nothing is added; document byte-identical; no entry; no journal)', () => {
  const fail = (name: string, args: Record<string, unknown>, expected: Record<string, unknown>, doc?: () => ProjectDocument) =>
    it(name, () => {
      const e = editor(doc?.()); const before = json(e.doc);
      const r = call(e, 'addMotionGraphic', args);
      expect(r).toMatchObject({ success: false, ...expected }); refused(e, before, r);
    });

  describe('1. INVALID_TOOL_INPUT for direct calls (REQUIRED first, then TYPE; carried in details)', () => {
    it('missing width, height, x, y → four REQUIRED entries in that order', () => {
      const e = editor(); const before = json(e.doc);
      const r = call(e, 'addMotionGraphic', { code: CODE, summary: SUMMARY, trackId: 'O2' });
      const errors = ['width', 'height', 'x', 'y'].map(k => ({ path: `$.${k}`, code: 'REQUIRED', message: REQUIRED(k) }));
      expect(r).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for addMotionGraphic', message: errors.map(x => `${x.path}: ${x.message}`).join('; '), details: { errors } });
      refused(e, before, r);
    });
    it('animationDuration "5" → exactly the stored G-06 16 shape, details at the top level', () => {
      const e = editor(); const before = json(e.doc);
      const r = add(e, { animationDuration: '5' });
      // Exact, not toMatchObject (research §1.8.3 item 3): the helper's shape has no `data`, so a stray one must fail here.
      expect(r).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for addMotionGraphic', message: '$.animationDuration: must be number',
        details: { errors: [{ path: '$.animationDuration', code: 'TYPE', message: 'must be number' }] } });
      refused(e, before, r);
    });
    it('a REQUIRED error comes before a TYPE error; every number field is type-checked', () => {
      const e = editor();
      const r = call(e, 'addMotionGraphic', { code: CODE, summary: SUMMARY, height: 1, x: 0, y: 0, animationDuration: '5', trackId: 'O2' });
      expect(r.details.errors).toEqual([{ path: '$.width', code: 'REQUIRED', message: REQUIRED('width') }, { path: '$.animationDuration', code: 'TYPE', message: 'must be number' }]);
      for (const key of ['width', 'height', 'x', 'y', 'timelineStart', 'duration', 'animationDuration']) {
        const bad = add(e, { [key]: '1' });
        expect(bad, key).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', details: { errors: [{ path: `$.${key}`, code: 'TYPE', message: 'must be number' }] } });
      }
    });
    it('it comes before INVALID_COMBINATION and every handler check', () => {
      const e = editor();
      const r = call(e, 'addMotionGraphic', { insertAfterItemId: 't1', trackId: 'O2', summary: '' });
      expect(r.code).toBe('INVALID_TOOL_INPUT');
    });
  });

  describe('2. INVALID_COMBINATION', () => {
    fail('insertAfterItemId with trackId and timelineStart', addArgs({ insertAfterItemId: 't1', timelineStart: 1 }),
      { code: 'INVALID_COMBINATION', error: 'insertAfter cannot be used with trackId, timelineStart. Use insertAfterItemId alone, or trackId with timelineStart.' });
    fail('insertAfterItemId with trackId alone', addArgs({ insertAfterItemId: 't1' }),
      { code: 'INVALID_COMBINATION', error: 'insertAfter cannot be used with trackId. Use insertAfterItemId alone, or trackId with timelineStart.' });
    fail('insertAfterItemId with timelineStart alone', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: 't1', timelineStart: 1 },
      { code: 'INVALID_COMBINATION', error: 'insertAfter cannot be used with timelineStart. Use insertAfterItemId alone, or trackId with timelineStart.' });
  });

  describe('3. insertAfter checks', () => {
    fail('reference item not found', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: 'nope' },
      { code: 'INSERT_AFTER_NOT_FOUND', error: 'insertAfter item not found', message: "Item 'nope' not found on the timeline. Read context for current item ids." });
    fail('reference item on no track', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: 'orphan' },
      { code: 'INSERT_AFTER_NO_TRACK', error: 'insertAfter item not on any track' },
      () => { const d = world(); d.items.push(text('orphan', 'nowhere', 0, 1000)); return d; });
    fail('a motion graphic may not follow a video item', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: 'v1' },
      { code: 'INSERT_AFTER_TYPE_MISMATCH', error: 'insertAfter type mismatch', message: "Cannot insert motionGraphic after video item 'v1'. The new item requires a compatible track kind." });
    fail('a motion graphic may not follow an audio item', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: 'a1' },
      { code: 'INSERT_AFTER_TYPE_MISMATCH', error: 'insertAfter type mismatch', message: "Cannot insert motionGraphic after audio item 'a1'. The new item requires a compatible track kind." });
    fail('the insertAfter check comes before the code check', { summary: SUMMARY, ...BOX, insertAfterItemId: 'nope' }, { code: 'INSERT_AFTER_NOT_FOUND' });
  });

  describe('4. MISSING_PARAM: code, then summary', () => {
    for (const [label, code] of [['absent', undefined], ['empty', '']] as const)
      fail(`code ${label} → "Missing code" with the message that asks for component code`, { summary: SUMMARY, ...BOX, trackId: 'O2', ...(code === undefined ? {} : { code }) },
        { code: 'MISSING_PARAM', error: 'Missing code', message: MISSING_CODE_MESSAGE });
    fail('the code check comes before the summary check', { ...BOX, trackId: 'O2' }, { code: 'MISSING_PARAM', error: 'Missing code' });
    for (const [label, summary] of [['absent', undefined], ['empty', ''], ['blank', ' \n\t ']] as const)
      fail(`summary ${label} → the summary-required text (error = message)`, { code: CODE, ...BOX, trackId: 'O2', ...(summary === undefined ? {} : { summary }) },
        { code: 'MISSING_PARAM', error: SUMMARY_REQUIRED, message: SUMMARY_REQUIRED });
    fail('summary over 400 characters → the 400-characters text (error = message)', addArgs({ summary: 'x'.repeat(401) }), { code: 'MISSING_PARAM', error: SUMMARY_LONG, message: SUMMARY_LONG });
    fail('the length is measured after collapsing whitespace: 200 + space + 200 + 1 = 402 → too long', addArgs({ summary: 'a'.repeat(200) + ' '.repeat(40) + 'b'.repeat(201) }),
      { code: 'MISSING_PARAM', error: SUMMARY_LONG, message: SUMMARY_LONG });
  });

  describe('5. VALIDATION_ERROR (static checks, error = message)', () => {
    for (const [tag, refusal] of [['video', VIDEO_REFUSAL], ['img', IMG_REFUSAL], ['audio', AUDIO_REFUSAL]] as const)
      fail(`native <${tag}> → the stored text`, addArgs({ code: `export const G = () => <AbsoluteFill><${tag} src="a" /></AbsoluteFill>;` }), { code: 'VALIDATION_ERROR', error: refusal, message: refusal });
    fail('a native tag followed by ">" is caught too', addArgs({ code: 'export const G = () => <AbsoluteFill><video>x</video></AbsoluteFill>;' }), { code: 'VALIDATION_ERROR', error: VIDEO_REFUSAL });
    it('a capitalised <Video> is not a native tag (the static check does not refuse it)', () => {
      const e = editor();
      const r = add(e, { code: 'export const G = () => <AbsoluteFill><Video /></AbsoluteFill>;' });
      expect(r.code).not.toBe('VALIDATION_ERROR');
    });
    fail('unknown asset id → the stored part', addArgs({ code: `export const G = () => <Img src={getAssetUrl("g06-no-such-asset")} />;` }),
      { code: 'VALIDATION_ERROR', error: `${ASSET_PREFIX}'g06-no-such-asset' is not an asset attached to this project.`, message: `${ASSET_PREFIX}'g06-no-such-asset' is not an asset attached to this project.` });
    fail('both quote styles are read', addArgs({ code: `export const G = () => <Img src={getAssetUrl('ghost')} />;` }),
      { code: 'VALIDATION_ERROR', error: `${ASSET_PREFIX}'ghost' is not an asset attached to this project.` });
    fail('an internal asset id names the agentId to use', addArgs({ code: `export const G = () => <Img src={getAssetUrl("asset-img1")} />;` }),
      { code: 'VALIDATION_ERROR', error: `${ASSET_PREFIX}'asset-img1' is asset 'image_1': use getAssetUrl('image_1').` });
    fail('ids are de-duplicated and the parts are joined by one space, in order of first use',
      addArgs({ code: `const a = getAssetUrl("ghost"); const b = getAssetUrl("asset-vid1"); const c = getAssetUrl("ghost"); const d = getAssetUrl("image_1"); export const G = () => <Img src={a} />;` }),
      { code: 'VALIDATION_ERROR', error: `${ASSET_PREFIX}'ghost' is not an asset attached to this project. 'asset-vid1' is asset 'video_1': use getAssetUrl('video_1').` });
    fail('a native tag is reported before an asset id', addArgs({ code: `export const G = () => <img src={getAssetUrl("ghost")} />;` }), { code: 'VALIDATION_ERROR', error: IMG_REFUSAL });
    it('a project asset\'s agentId passes (getAssetUrl("image_1"), getAssetUrl("video_1"))', () => {
      const e = editor();
      const r = add(e, { code: `export const G = () => <AbsoluteFill><Img src={getAssetUrl("image_1")} /><OffthreadVideo src={getAssetUrl('video_1')} /></AbsoluteFill>;` });
      expect(r).toMatchObject({ success: true });
    });
    it('an asset link removed from the project is no longer valid', () => {
      const removed = links().map(l => l.agent_id === 'image_1' ? { ...l, deleted_at: '2026-10-02T00:00:00Z' } : l);
      const e = createEditor(world(), { assets: assets(), links: removed });
      expect(add(e, { code: `export const G = () => <Img src={getAssetUrl("image_1")} />;` })).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    });
  });

  describe('6. COMPILATION_ERROR', () => {
    fail('a helper after the exported component → the stored R3 text (error = message)', addArgs({ code: `export const G = () => <AbsoluteFill />;\nconst helper = 1;` }),
      { code: 'COMPILATION_ERROR', error: EXPORT_REFUSAL, message: EXPORT_REFUSAL });
    it('export default is refused with a "compilation error: " text', () => {
      const e = editor(); const before = json(e.doc);
      const r = add(e, { code: 'export default () => <AbsoluteFill />;' });
      expect(r).toMatchObject({ success: false, code: 'COMPILATION_ERROR' }); expect(r.error).toMatch(/^compilation error: /); expect(r.message).toBe(r.error); refused(e, before, r);
    });
    it('a syntax error is a COMPILATION_ERROR with a "compilation error: " text', () => {
      const e = editor(); const before = json(e.doc);
      const r = add(e, { code: 'export const G = () => <AbsoluteFill>;' });
      expect(r).toMatchObject({ success: false, code: 'COMPILATION_ERROR' }); expect(r.error).toMatch(/^compilation error: /); refused(e, before, r);
    });
    fail('the compile comes before the track checks (an unknown track with bad code is a COMPILATION_ERROR)', addArgs({ code: `export const G = () => <AbsoluteFill />;\nconst helper = 1;`, trackId: 'zzz' }), { code: 'COMPILATION_ERROR' });
  });

  describe('7. track checks', () => {
    fail('no trackId and no insertAfterItemId → MISSING_TRACK_ID', { code: CODE, summary: SUMMARY, ...BOX }, { code: 'MISSING_TRACK_ID', error: 'trackId is required' });
    fail('a missing track → INVALID_TRACK "Overlay track \'<id>\' not found"', addArgs({ trackId: 'zzz' }), { code: 'INVALID_TRACK', error: "Overlay track 'zzz' not found" });
    fail('a video track → INVALID_TRACK with the same text', addArgs({ trackId: 'V1' }), { code: 'INVALID_TRACK', error: "Overlay track 'V1' not found" });
    fail('an audio track → INVALID_TRACK', addArgs({ trackId: 'A1' }), { code: 'INVALID_TRACK', error: "Overlay track 'A1' not found" });
    fail('a locked track → TRACK_LOCKED "Track \'<id>\' is locked"', addArgs({ trackId: 'OL' }), { code: 'TRACK_LOCKED', error: "Track 'OL' is locked" });
  });

  describe('8. TRACK_OVERLAP: error only, no message', () => {
    const OVERLAP = "Requested range overlaps item 't1' (1s–3s) on track 'O1'. That track has room for this length from 3s";
    const request = { code: CODE, summary: SUMMARY, ...BOX, trackId: 'O1', timelineStart: 2, duration: 2 };
    it('no other overlay track is free → the text ends in "."', () => {
      const e = editor(crowded(['O2', 'O3'])); const before = json(e.doc);
      const r = call(e, 'addMotionGraphic', request);
      expect(r).toMatchObject({ success: false, code: 'TRACK_OVERLAP', error: `${OVERLAP}.` }); expect(r).not.toHaveProperty('message'); refused(e, before, r);
    });
    it('one other overlay track is free → "; for the same time, track <id> is free."', () => {
      const e = editor(crowded(['O2'])); const before = json(e.doc);
      const r = call(e, 'addMotionGraphic', request);
      expect(r).toMatchObject({ success: false, code: 'TRACK_OVERLAP', error: `${OVERLAP}; for the same time, track O3 is free.` }); expect(r).not.toHaveProperty('message'); refused(e, before, r);
    });
    it('two other overlay tracks are free → "; for the same time, tracks <a>, <b> are free." (the locked track and the video track are not listed)', () => {
      const e = editor(crowded([])); const before = json(e.doc);
      const r = call(e, 'addMotionGraphic', request);
      expect(r).toMatchObject({ success: false, code: 'TRACK_OVERLAP' }); expect(r).not.toHaveProperty('message');
      expect(r.error).toMatch(new RegExp(`^${OVERLAP.replace(/[()]/g, '\\$&')}; for the same time, tracks (O2, O3|O3, O2) are free\\.$`)); refused(e, before, r);
    });
    it('the track has room for this length from the first free start after the blocker (a 0.5 s gap does not fit 2 s)', () => {
      const e = editor(crowded(['O2', 'O3'], [text('t2', 'O1', 3500, 5000)])); const before = json(e.doc);
      const r = call(e, 'addMotionGraphic', request);
      expect(r).toMatchObject({ success: false, code: 'TRACK_OVERLAP', error: "Requested range overlaps item 't1' (1s–3s) on track 'O1'. That track has room for this length from 5s." }); refused(e, before, r);
    });
    it('touching ranges are not an overlap (a graphic that starts where t1 ends)', () => {
      const e = editor(crowded([]));
      expect(call(e, 'addMotionGraphic', { ...request, timelineStart: 3 })).toMatchObject({ success: true });
    });
    it('the overlap check does not apply to insertAfterItemId (later items are pushed right)', () => {
      const e = editor(crowded([], [text('t2', 'O1', 3000, 5000)]));
      const r = call(e, 'addMotionGraphic', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: 't1', duration: 2 });
      expect(r).toMatchObject({ success: true, data: { trackId: 'O1', timelineStart: 3 } });
      expect(span(e.doc, 't2')).toEqual([5000, 7000]);
    });
  });
});

describe('editMotionGraphic (results §2 editMotionGraphic; reference compares §1.4)', () => {
  const view = (e: Editor, args: Record<string, unknown> = {}) => call(e, 'editMotionGraphic', { itemId: 'mg1', ...args });
  const fail = (name: string, args: Record<string, unknown>, expected: Record<string, unknown>) =>
    it(name, () => {
      const e = editor(editWorld()); const before = json(e.doc);
      const r = call(e, 'editMotionGraphic', args);
      expect(r).toMatchObject({ success: false, ...expected }); refused(e, before, r);
    });
  const MOUNTED = (e: Editor) => item(e, 'mg1').details.code as string;

  describe('view (the default action)', () => {
    it('returns the full code and the stored summary; no timelineChanges, no undo entry, no journal record', () => {
      for (const args of [{}, { action: 'view' }]) {
        const e = editor(editWorld()); const before = json(e.doc);
        const r = view(e, args);
        expect(r).toEqual({ success: true, message: 'Motion graphic code retrieved', data: { agentId: 'mg1', code: CODE, summary: 'A card.' } });
        expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
      }
    });
    it('returns the whole source with no length cap', () => {
      const e = editor(editWorld());
      const long = `export const L = () => <AbsoluteFill>{${JSON.stringify('x'.repeat(30000))}}</AbsoluteFill>;`;
      item(e, 'mg1').details.code = long;
      expect(view(e).data.code).toBe(long);
    });
    it('an item with no stored summary has an absent summary', () => {
      const e = editor(editWorld());
      const r = call(e, 'editMotionGraphic', { itemId: 'mg2' });
      expect(r.success).toBe(true); expect(r.data.summary).toBeUndefined(); expect(r.data.code).toBe(CODE);
    });
  });

  describe('lookup failures', () => {
    fail('an empty itemId → NOT_FOUND', { itemId: '' }, { code: 'NOT_FOUND', error: 'Motion graphic not found', message: "No motion graphic found with ID ''" });
    fail('an unknown itemId → NOT_FOUND', { itemId: 'nope' }, { code: 'NOT_FOUND', error: 'Motion graphic not found', message: "No motion graphic found with ID 'nope'" });
    fail('an item that is not a motion graphic → WRONG_TYPE, the message names the type', { itemId: 'v1' }, { code: 'WRONG_TYPE', error: 'Not a motion graphic', message: "Item 'v1' is not a motion graphic (type: video)" });
    fail('a legacy graphic with no details.code → NO_CODE (view)', { itemId: 'mgLegacy' }, { code: 'NO_CODE', error: 'Not a code-mode MG', message: "Motion graphic 'mgLegacy' has no code. It may be a legacy MG." });
    fail('a legacy graphic → NO_CODE (updateCode)', { itemId: 'mgLegacy', action: 'updateCode', code: CODE, summary: SUMMARY }, { code: 'NO_CODE' });
    fail('an unknown action → INVALID_ACTION', { itemId: 'mg1', action: 'zap' }, { code: 'INVALID_ACTION', error: 'Invalid action', message: "Unknown action 'zap'" });
    fail('INVALID_ACTION is checked after the lookup (unknown item with an unknown action → NOT_FOUND)', { itemId: 'nope', action: 'zap' }, { code: 'NOT_FOUND' });
    fail('INVALID_ACTION comes after WRONG_TYPE and NO_CODE too', { itemId: 'v1', action: 'zap' }, { code: 'WRONG_TYPE' });
  });

  describe('updateCode', () => {
    const NEW = `export const Card2 = () => <AbsoluteFill style={{ backgroundColor: '#445566' }}><div style={{ fontFamily: 'Roboto' }}>New</div></AbsoluteFill>;`;
    it('replaces the code: message, data keys in order, changedFields details.code only when no summary is given, "Edit items"', () => {
      const e = editor(editWorld());
      const r = call(e, 'editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: NEW });
      expect(r.success).toBe(true); expect(r.message).toBe('Motion graphic code updated');
      expect(Object.keys(r.data)).toEqual(['agentId', 'codeLength', 'summary']);
      expect(r.data).toEqual({ agentId: 'mg1', codeLength: NEW.length, summary: 'A card.' });
      expect(item(e, 'mg1').details.code).toBe(NEW); expect(item(e, 'mg1').metadata.summary).toBe('A card.');
      expect(r.timelineChanges.items.updated).toHaveLength(1);
      expect(r.timelineChanges.items.updated[0].itemId).toBe('mg1');
      expect(r.timelineChanges.items.updated[0].changedFields).toContain('details.code');
      expect(r.timelineChanges.items.updated[0].changedFields).not.toContain('metadata.summary');
      only(e, 'Edit items');
    });
    it('a given summary replaces the stored one (trimmed, collapsed), is returned, and is a changed field', () => {
      const e = editor(editWorld());
      const r = call(e, 'editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: NEW, summary: '  A   new\ncard. ' });
      expect(r.data.summary).toBe('A new card.'); expect(item(e, 'mg1').metadata.summary).toBe('A new card.');
      expect(r.timelineChanges.items.updated[0].changedFields).toEqual(expect.arrayContaining(['details.code', 'metadata.summary']));
    });
    it('an item with no stored summary can be edited when a summary is given', () => {
      const e = editor(editWorld());
      const r = call(e, 'editMotionGraphic', { itemId: 'mg2', action: 'updateCode', code: NEW, summary: 'Now described.' });
      expect(r).toMatchObject({ success: true, data: { summary: 'Now described.' } }); expect(item(e, 'mg2').metadata.summary).toBe('Now described.');
    });
    it('the item keeps its place and timing', () => {
      const e = editor(editWorld());
      call(e, 'editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: NEW });
      expect(item(e, 'mg1')).toMatchObject({ trackId: 'O2', display: { from: 0, to: 5000 }, trim: { from: 0, to: 5000 }, sourceDuration: 5000 });
    });
    it('a font outside the catalogue adds the suffix and data.fontWarnings (last key)', () => {
      const e = editor(editWorld());
      const r = call(e, 'editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: NEW.replace('Roboto', 'Montserrat') });
      expect(r.message).toBe(`Motion graphic code updated — FONT WARNING: ${fontWarning('Montserrat')}`);
      expect(r.data.fontWarnings).toEqual([fontWarning('Montserrat')]); expect(Object.keys(r.data)).toEqual(['agentId', 'codeLength', 'summary', 'fontWarnings']);
    });
    fail('no code → MISSING_PARAM "Missing code" with the updateCode message', { itemId: 'mg1', action: 'updateCode' }, { code: 'MISSING_PARAM', error: 'Missing code', message: "updateCode requires the 'code' parameter" });
    fail('empty code → MISSING_PARAM', { itemId: 'mg1', action: 'updateCode', code: '' }, { code: 'MISSING_PARAM', error: 'Missing code' });
  });

  describe('patchCode', () => {
    const patch = (e: Editor, patches: unknown, extra: Record<string, unknown> = {}, id = 'mg1') => call(e, 'editMotionGraphic', { itemId: id, action: 'patchCode', patches, ...extra });
    it('message, data keys in order (patches before codeLength), status strings, changedFields, "Edit items"', () => {
      const e = editor(editWorld());
      const r = patch(e, [{ old_string: 'Hello', new_string: 'Hi there' }]);
      const next = CODE.replace('Hello', 'Hi there');
      expect(r.success).toBe(true); expect(r.message).toBe('Motion graphic code patched');
      expect(Object.keys(r.data)).toEqual(['agentId', 'patches', 'codeLength', 'summary']);
      expect(r.data).toEqual({ agentId: 'mg1', patches: ['OK: replaced "Hello..."'], codeLength: next.length, summary: 'A card.' });
      expect(item(e, 'mg1').details.code).toBe(next);
      expect(r.timelineChanges.items.updated[0].changedFields).toContain('details.code'); expect(r.timelineChanges.items.updated[0].changedFields).not.toContain('metadata.summary');
      only(e, 'Edit items');
    });
    it('the OK status shows the first 40 characters of old_string', () => {
      const e = editor(editWorld());
      const old = CODE.slice(0, 60);
      expect(patch(e, [{ old_string: old, new_string: old }]).data.patches).toEqual([`OK: replaced "${old.slice(0, 40)}..."`]);
    });
    it('patches apply in sequence: a later patch sees the earlier replacement', () => {
      const e = editor(editWorld());
      const r = patch(e, [{ old_string: 'Hello', new_string: 'Hi' }, { old_string: 'Hi', new_string: 'Hey' }]);
      expect(r.success).toBe(true); expect(r.data.patches).toEqual(['OK: replaced "Hello..."', 'OK: replaced "Hi..."']);
      expect(item(e, 'mg1').details.code).toBe(CODE.replace('Hello', 'Hey'));
    });
    it('only the first occurrence of old_string is replaced', () => {
      const e = editor(editWorld());
      const r = patch(e, [{ old_string: 'AA', new_string: 'BB' }], {}, 'mgDup');
      expect(r.success).toBe(true);
      expect(item(e, 'mgDup').details.code).toBe('export const D = () => <AbsoluteFill><b>BB</b><b>AA</b></AbsoluteFill>;');
    });
    it('a given summary is stored and listed as a changed field; the returned summary is the given one', () => {
      const e = editor(editWorld());
      const r = patch(e, [{ old_string: 'Hello', new_string: 'Hi' }], { summary: 'Greets the viewer.' });
      expect(r.data.summary).toBe('Greets the viewer.'); expect(item(e, 'mg1').metadata.summary).toBe('Greets the viewer.');
      expect(r.timelineChanges.items.updated[0].changedFields).toEqual(expect.arrayContaining(['details.code', 'metadata.summary']));
    });
    it('a font outside the catalogue adds the suffix', () => {
      const e = editor(editWorld());
      const r = patch(e, [{ old_string: 'Roboto', new_string: 'Montserrat' }]);
      expect(r.message).toBe(`Motion graphic code patched — FONT WARNING: ${fontWarning('Montserrat')}`); expect(r.data.fontWarnings).toEqual([fontWarning('Montserrat')]);
    });
    describe('a patch that is not found fails the whole call atomically (Cutframe improvement)', () => {
      it('STRING_NOT_FOUND, data.patches holds every status, the code is unchanged, no undo entry', () => {
        const e = editor(editWorld()); const before = json(e.doc);
        const r = patch(e, [{ old_string: 'Hello', new_string: 'Hi' }, { old_string: 'zzz-not-there', new_string: 'y' }]);
        expect(r).toMatchObject({ success: false, code: 'STRING_NOT_FOUND', data: { patches: ['OK: replaced "Hello..."', 'NOT FOUND: "zzz-not-there..."'] } });
        expect(r.error).toMatch(/^The text to replace was not found in the .+\. Make sure old_string matches exactly \(character-for-character\)\.$/);
        expect(MOUNTED(e)).toBe(CODE); refused(e, before, r);
      });
      it('when no patch matches the call fails too', () => {
        const e = editor(editWorld()); const before = json(e.doc);
        const r = patch(e, [{ old_string: 'nope', new_string: 'y' }]);
        expect(r).toMatchObject({ success: false, code: 'STRING_NOT_FOUND', data: { patches: ['NOT FOUND: "nope..."'] } }); refused(e, before, r);
      });
      it('the NOT FOUND status shows the first 60 characters of old_string', () => {
        const e = editor(editWorld());
        const old = 'q'.repeat(80);
        expect(patch(e, [{ old_string: old, new_string: 'y' }]).data.patches).toEqual([`NOT FOUND: "${'q'.repeat(60)}..."`]);
      });
    });
    fail('no patches → MISSING_PARAM "Missing patches" with the patchCode message', { itemId: 'mg1', action: 'patchCode' }, { code: 'MISSING_PARAM', error: 'Missing patches', message: "patchCode requires the 'patches' array" });
    fail('an empty patches array → MISSING_PARAM "Missing patches"', { itemId: 'mg1', action: 'patchCode', patches: [] }, { code: 'MISSING_PARAM', error: 'Missing patches' });
    fail('a patch without new_string → MISSING_PARAM "Missing patches"', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'Hello' }] }, { code: 'MISSING_PARAM', error: 'Missing patches' });
    fail('a patch that is not an object → MISSING_PARAM "Missing patches"', { itemId: 'mg1', action: 'patchCode', patches: ['Hello'] }, { code: 'MISSING_PARAM', error: 'Missing patches' });
    fail('patches that is not an array → MISSING_PARAM "Missing patches"', { itemId: 'mg1', action: 'patchCode', patches: 'Hello' }, { code: 'MISSING_PARAM', error: 'Missing patches' });
  });

  describe('summary rules (Q4: error = message)', () => {
    const NEW = `export const N = () => <AbsoluteFill />;`;
    for (const action of ['updateCode', 'patchCode'] as const) {
      const body = action === 'updateCode' ? { code: NEW } : { patches: [{ old_string: 'Hello', new_string: 'Hi' }] };
      fail(`${action}: a given empty summary → MISSING_PARAM, summary-required text`, { itemId: 'mg1', action, ...body, summary: '' }, { code: 'MISSING_PARAM', error: SUMMARY_REQUIRED, message: SUMMARY_REQUIRED });
      fail(`${action}: a given blank summary → MISSING_PARAM, summary-required text`, { itemId: 'mg1', action, ...body, summary: '   ' }, { code: 'MISSING_PARAM', error: SUMMARY_REQUIRED, message: SUMMARY_REQUIRED });
      fail(`${action}: a given summary over 400 characters → MISSING_PARAM, 400-characters text`, { itemId: 'mg1', action, ...body, summary: 'x'.repeat(401) }, { code: 'MISSING_PARAM', error: SUMMARY_LONG, message: SUMMARY_LONG });
      fail(`${action}: no summary stored and none given → MISSING_PARAM "Missing summary"`, { itemId: 'mg2', action, ...body }, { code: 'MISSING_PARAM', error: 'Missing summary' });
    }
    it('the message of "Missing summary" asks for a summary', () => {
      const e = editor(editWorld());
      expect(call(e, 'editMotionGraphic', { itemId: 'mg2', action: 'updateCode', code: NEW }).message).toMatch(/summary/i);
    });
    it('a stored summary is kept when none is given (and returned)', () => {
      const e = editor(editWorld());
      const r = call(e, 'editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: NEW });
      expect(r.data.summary).toBe('A card.'); expect(item(e, 'mg1').metadata.summary).toBe('A card.');
    });
    it('view needs no summary (an item without one can be read)', () => {
      const e = editor(editWorld());
      expect(call(e, 'editMotionGraphic', { itemId: 'mg2', action: 'view' })).toMatchObject({ success: true });
    });
  });

  describe('static checks and compile run on the new code; nothing is written when they fail', () => {
    const upd = (code: string) => ({ itemId: 'mg1', action: 'updateCode', code });
    fail('updateCode with a native <video> → VALIDATION_ERROR', upd('export const G = () => <AbsoluteFill><video src="a" /></AbsoluteFill>;'), { code: 'VALIDATION_ERROR', error: VIDEO_REFUSAL, message: VIDEO_REFUSAL });
    fail('updateCode with an unknown asset id → VALIDATION_ERROR', upd(`export const G = () => <Img src={getAssetUrl("ghost")} />;`), { code: 'VALIDATION_ERROR', error: `${ASSET_PREFIX}'ghost' is not an asset attached to this project.` });
    fail('updateCode with a helper after the export → COMPILATION_ERROR', upd(`export const G = () => <AbsoluteFill />;\nconst helper = 1;`), { code: 'COMPILATION_ERROR', error: EXPORT_REFUSAL, message: EXPORT_REFUSAL });
    fail('patchCode that introduces a native <img> → VALIDATION_ERROR', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'Hello', new_string: '<img src="a.png"/>' }] }, { code: 'VALIDATION_ERROR', error: IMG_REFUSAL });
    fail('patchCode that breaks the export order → COMPILATION_ERROR', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: '</AbsoluteFill>;', new_string: '</AbsoluteFill>;\nconst late = 1;' }] }, { code: 'COMPILATION_ERROR', error: EXPORT_REFUSAL });
    it('a project asset\'s agentId introduced by a patch is accepted', () => {
      const e = editor(editWorld());
      const r = call(e, 'editMotionGraphic', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'Hello', new_string: '<Img src={getAssetUrl("image_1")} />' }] });
      expect(r).toMatchObject({ success: true });
    });
  });
});

describe('T03 timed media: a motion graphic trims and splits like timed media (sourceDuration is the designed length)', () => {
  /** A 5 s graphic at 2-7 s on O2. */
  function placed() {
    const e = editor(); const r = add(e, { timelineStart: 2 });
    const id = r.data.itemId as string;
    expect(span(e.doc, id)).toEqual([2000, 7000]);
    e.bus.undoStack.length = 0;
    return { e, id };
  }
  it('trimItem start moves trim.from (and the start of the display) by the delta', () => {
    const { e, id } = placed();
    const r = call(e, 'trimItem', { itemId: id, handle: 'start', deltaSeconds: 1 });
    expect(r.success).toBe(true);
    expect(item(e, id)).toMatchObject({ display: { from: 3000, to: 7000 }, trim: { from: 1000, to: 5000 }, sourceDuration: 5000 });
  });
  it('trimItem end shortens the display and trim.to; extending it again is clamped to sourceDuration', () => {
    const { e, id } = placed();
    expect(call(e, 'trimItem', { itemId: id, handle: 'end', deltaSeconds: -1 }).success).toBe(true);
    expect(item(e, id)).toMatchObject({ display: { from: 2000, to: 6000 }, trim: { from: 0, to: 4000 } });
    expect(call(e, 'trimItem', { itemId: id, handle: 'end', deltaSeconds: 10 }).success).toBe(true);
    expect(item(e, id)).toMatchObject({ display: { from: 2000, to: 7000 }, trim: { from: 0, to: 5000 }, sourceDuration: 5000 });
  });
  it('a graphic cannot be stretched past its designed length (end at the limit cannot grow)', () => {
    const { e, id } = placed();
    call(e, 'trimItem', { itemId: id, handle: 'end', deltaSeconds: 3 });
    expect(item(e, id)).toMatchObject({ display: { from: 2000, to: 7000 }, trim: { from: 0, to: 5000 } });
  });
  it('splitItem: the right half starts at the cut point inside the graphic; both halves keep sourceDuration, code and summary', () => {
    const { e, id } = placed();
    const r = call(e, 'splitItem', { itemId: id, timestampS: 4 });
    expect(r.success).toBe(true);
    const parts = graphics(e).filter(i => i.trackId === 'O2').sort((a, b) => a.display.from - b.display.from);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ id, display: { from: 2000, to: 4000 }, trim: { from: 0, to: 2000 }, sourceDuration: 5000 });
    expect(parts[1]).toMatchObject({ display: { from: 4000, to: 7000 }, trim: { from: 2000, to: 5000 }, sourceDuration: 5000 });
    for (const part of parts) expect(part).toMatchObject({ details: { code: CODE }, metadata: { summary: SUMMARY } });
  });
});

describe('callMotionGraphicTool (the async path: checks, then the dry run, then the real call)', () => {
  const dry = () => vi.fn(async (_code: string, _assetMap: Record<string, string>) => undefined as unknown);
  const AGENT_MAP = { video_1: '', video_2: '', image_1: '', audio_1: '', video_3: '', video_4: '' };
  /** run() is the real call through the bus, as the executor makes it. */
  function setup(doc: ProjectDocument = world()) {
    const e = editor(doc);
    const make = (name: string, args: Record<string, unknown>, dryRun: ReturnType<typeof dry>) => {
      const run = vi.fn(() => e.runtime.call(name, args));
      return { run, result: callMotionGraphicTool(e.runtime.tools, name, args, { dryRun, run }) };
    };
    return { e, make };
  }
  const boom = (message = 'compilation error: G-06 R4: deliberate dry-run error at frame 0') => new MotionGraphicError('COMPILATION_ERROR', message);

  it('a dry-run rejection with a MotionGraphicError is {success:false, code, error: msg, message: msg}; run is not called; the document is unchanged', async () => {
    const { e, make } = setup(); const before = json(e.doc);
    const dryRun = vi.fn(async () => { throw boom(); });
    const { run, result } = make('addMotionGraphic', addArgs(), dryRun);
    expect(await result).toEqual({ success: false, code: 'COMPILATION_ERROR', error: 'compilation error: G-06 R4: deliberate dry-run error at frame 0', message: 'compilation error: G-06 R4: deliberate dry-run error at frame 0' });
    expect(dryRun).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
    expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0);
  });

  it('the code of the MotionGraphicError is passed on (MG_WATCHDOG)', async () => {
    const { make } = setup();
    const { result } = make('addMotionGraphic', addArgs(), vi.fn(async () => { throw new MotionGraphicError('MG_WATCHDOG', 'The graphic did not finish rendering in time.'); }));
    expect(await result).toMatchObject({ success: false, code: 'MG_WATCHDOG', error: 'The graphic did not finish rendering in time.', message: 'The graphic did not finish rendering in time.' });
  });

  describe('a refusal that comes before the dry run: the dry run is never called and the result is run()\'s refusal', () => {
    const early: [string, Record<string, unknown>, string, () => ProjectDocument | undefined][] = [
      ['missing code', { summary: SUMMARY, ...BOX, trackId: 'O2' }, 'MISSING_PARAM', () => undefined],
      ['invalid summary', addArgs({ summary: '' }), 'MISSING_PARAM', () => undefined],
      ['native media', addArgs({ code: 'export const G = () => <video src="a" />;' }), 'VALIDATION_ERROR', () => undefined],
      ['unknown asset id', addArgs({ code: `export const G = () => <Img src={getAssetUrl("ghost")} />;` }), 'VALIDATION_ERROR', () => undefined],
      ['host compile failure', addArgs({ code: `export const G = () => <AbsoluteFill />;\nconst helper = 1;` }), 'COMPILATION_ERROR', () => undefined],
      ['insertAfter item not found', { code: CODE, summary: SUMMARY, ...BOX, insertAfterItemId: 'nope' }, 'INSERT_AFTER_NOT_FOUND', () => undefined],
      ['invalid combination', addArgs({ insertAfterItemId: 't1' }), 'INVALID_COMBINATION', () => undefined],
      ['invalid tool input', { code: CODE, summary: SUMMARY, trackId: 'O2' }, 'INVALID_TOOL_INPUT', () => undefined],
    ];
    it.each(early)('%s', async (_name, args, code) => {
      const { e, make } = setup(); const before = json(e.doc);
      const dryRun = dry();
      const { run, result } = make('addMotionGraphic', args, dryRun);
      const r = await result;
      expect(r).toMatchObject({ success: false, code });
      expect(dryRun).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledTimes(1);
      expect(r).toEqual(e.runtime.call('addMotionGraphic', args)); // the same refusal run() gives
      expect(json(e.doc)).toBe(before);
    });
    it('edit: a missing item, a missing code, an unknown action and a static refusal never reach the dry run', async () => {
      const { e, make } = setup(editWorld());
      const cases: [Record<string, unknown>, string][] = [
        [{ itemId: 'nope', action: 'updateCode', code: CODE, summary: SUMMARY }, 'NOT_FOUND'],
        [{ itemId: 'mg1', action: 'updateCode' }, 'MISSING_PARAM'],
        [{ itemId: 'mg1', action: 'zap' }, 'INVALID_ACTION'],
        [{ itemId: 'mg1', action: 'updateCode', code: 'export const G = () => <video src="a" />;' }, 'VALIDATION_ERROR'],
        [{ itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'zzz', new_string: 'y' }] }, 'STRING_NOT_FOUND'],
        [{ itemId: 'mg2', action: 'updateCode', code: CODE }, 'MISSING_PARAM'],
      ];
      for (const [args, code] of cases) {
        const dryRun = dry();
        const { run, result } = make('editMotionGraphic', args, dryRun);
        expect(await result, JSON.stringify(args)).toMatchObject({ success: false, code });
        expect(dryRun).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledTimes(1);
      }
      expect(item(e, 'mg1').details.code).toBe(CODE);
    });
  });

  describe('a refusal that comes after the dry run (track checks): the dry run is called once, then run() returns the refusal', () => {
    const late: [string, Record<string, unknown>, string, () => ProjectDocument][] = [
      ['TRACK_OVERLAP', { code: CODE, summary: SUMMARY, ...BOX, trackId: 'O1', timelineStart: 2, duration: 2 }, 'TRACK_OVERLAP', () => crowded([])],
      ['INVALID_TRACK (missing)', addArgs({ trackId: 'zzz' }), 'INVALID_TRACK', world],
      ['INVALID_TRACK (video)', addArgs({ trackId: 'V1' }), 'INVALID_TRACK', world],
      ['MISSING_TRACK_ID', { code: CODE, summary: SUMMARY, ...BOX }, 'MISSING_TRACK_ID', world],
      ['TRACK_LOCKED', addArgs({ trackId: 'OL' }), 'TRACK_LOCKED', world],
      ['INVALID_DURATION', addArgs({ duration: 0 }), 'INVALID_DURATION', world],
      ['INVALID_TIMELINE_START', addArgs({ timelineStart: -1 }), 'INVALID_TIMELINE_START', world],
    ];
    it.each(late)('%s', async (_name, args, code, doc) => {
      const { e, make } = setup(doc()); const before = json(e.doc);
      const dryRun = dry();
      const { run, result } = make('addMotionGraphic', args, dryRun);
      expect(await result).toMatchObject({ success: false, code });
      expect(dryRun).toHaveBeenCalledTimes(1); expect(dryRun).toHaveBeenCalledWith(CODE, AGENT_MAP); expect(run).toHaveBeenCalledTimes(1);
      expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0);
    });
    it('a dry-run refusal wins over a track refusal: the dry run fails first, run() is not called', async () => {
      const { make } = setup();
      const dryRun = vi.fn(async () => { throw boom(); });
      const { run, result } = make('addMotionGraphic', addArgs({ trackId: 'zzz' }), dryRun);
      expect(await result).toMatchObject({ success: false, code: 'COMPILATION_ERROR' }); expect(run).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('add: the dry run is called exactly once with the code and an assetMap of every link\'s agentId mapped to ""; then run() makes the one change', async () => {
      const { e, make } = setup();
      const dryRun = dry();
      const { run, result } = make('addMotionGraphic', addArgs(), dryRun);
      const r = await result as any;
      expect(r).toMatchObject({ success: true, data: { trackId: 'O2' } });
      expect(dryRun).toHaveBeenCalledTimes(1); expect(dryRun).toHaveBeenCalledWith(CODE, AGENT_MAP); expect(run).toHaveBeenCalledTimes(1);
      expect(graphics(e)).toHaveLength(1); only(e, 'Add items');
    });
    it('updateCode: the dry run gets the new code', async () => {
      const { e, make } = setup(editWorld());
      const NEW = `export const N = () => <AbsoluteFill style={{ opacity: 0.5 }} />;`;
      const dryRun = dry();
      const { result } = make('editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: NEW }, dryRun);
      expect(await result).toMatchObject({ success: true });
      expect(dryRun).toHaveBeenCalledTimes(1); expect(dryRun).toHaveBeenCalledWith(NEW, AGENT_MAP);
      expect(item(e, 'mg1').details.code).toBe(NEW);
    });
    it('patchCode: the dry run gets the patched code, not the patches and not the old code', async () => {
      const { e, make } = setup(editWorld());
      const dryRun = dry();
      const { result } = make('editMotionGraphic', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'Hello', new_string: 'Patched' }] }, dryRun);
      expect(await result).toMatchObject({ success: true });
      expect(dryRun).toHaveBeenCalledTimes(1); expect(dryRun).toHaveBeenCalledWith(CODE.replace('Hello', 'Patched'), AGENT_MAP);
      expect(item(e, 'mg1').details.code).toBe(CODE.replace('Hello', 'Patched'));
    });
    it('view makes no dry run and returns run()\'s result', async () => {
      const { make } = setup(editWorld());
      const dryRun = dry();
      const { run, result } = make('editMotionGraphic', { itemId: 'mg1' }, dryRun);
      expect(await result).toMatchObject({ success: true, message: 'Motion graphic code retrieved', data: { agentId: 'mg1', code: CODE } });
      expect(dryRun).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledTimes(1);
    });
    it('an empty asset map when the project has no assets', async () => {
      const e = createEditor(world());
      const dryRun = dry();
      await callMotionGraphicTool(e.runtime.tools, 'addMotionGraphic', addArgs(), { dryRun, run: () => e.runtime.call('addMotionGraphic', addArgs()) });
      expect(dryRun).toHaveBeenCalledWith(CODE, {});
    });
  });

  it('a rejection that is not a MotionGraphicError propagates and run() is not called', async () => {
    const { e, make } = setup(); const before = json(e.doc);
    const { run, result } = make('addMotionGraphic', addArgs(), vi.fn(async () => { throw new Error('sandbox died'); }));
    await expect(result).rejects.toThrow('sandbox died');
    expect(run).not.toHaveBeenCalled(); expect(json(e.doc)).toBe(before);
  });
});

describe('executor (T18a path with an injected dry run)', () => {
  const NEVER_READ = "You haven't read the timeline in this session. The current state is attached and the timeline now counts as fresh; retry the call.";
  const fakeStorage = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
  let seq = 0;
  const callOf = (toolName: string, input: Record<string, unknown> = {}, extra: Partial<Call> = {}): Call => ({ type: 'call', callId: `m${++seq}`, executionKey: `mcp:conn:m${seq}`, toolName, input, ...extra });
  function setup(doc: ProjectDocument = world(), dryRun?: (code: string, assetMap: Record<string, string>) => Promise<unknown>) {
    const e = editor(doc);
    const dry = vi.fn(dryRun ?? (async () => undefined));
    const parts: string[][] = [];
    const ex = new Executor({ storage: fakeStorage(), current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }), dryRun: dry, onState: p => parts.push(p) });
    return { e, ex, dry, parts };
  }
  const read = (ex: Executor, session = 's') => ex.execute(callOf('context', {}, { session }));

  it('addMotionGraphic before a context read is refused STALE_READ_REFRESHED; no dry run, nothing added', async () => {
    const { e, ex, dry } = setup(); const before = json(e.doc);
    const r = await ex.execute(callOf('addMotionGraphic', addArgs(), { session: 's' })) as any;
    expect(r).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', error: 'Stale read — refreshed and not applied', message: NEVER_READ, scope: 'timeline' });
    expect(dry).not.toHaveBeenCalled(); expect(json(e.doc)).toBe(before);
  });

  it('after a read it succeeds with timelineChanges; the dry run ran once with the code and the asset map', async () => {
    const { e, ex, dry } = setup();
    await read(ex);
    const r = await ex.execute(callOf('addMotionGraphic', addArgs(), { session: 's' })) as any;
    expect(r).toMatchObject({ success: true, data: { trackId: 'O2', duration: 5 } });
    expect(r.timelineChanges.items.created).toHaveLength(1);
    expect(dry).toHaveBeenCalledTimes(1); expect(dry).toHaveBeenCalledWith(CODE, { video_1: '', video_2: '', image_1: '', audio_1: '', video_3: '', video_4: '' });
    expect(graphics(e)).toHaveLength(1);
  });

  it('the add counts as an agent change: a following gated call is not refused as stale, and the change is reported as an agent change', async () => {
    const { ex, parts } = setup();
    await read(ex);
    await ex.execute(callOf('addMotionGraphic', addArgs(), { session: 's' }));
    expect(parts.length).toBeGreaterThan(0); expect(parts.flat()).toContain('items');
    expect(await ex.execute(callOf('moveItem', { itemId: 'v1', by: 1 }, { session: 's' }))).toMatchObject({ success: true });
  });

  it('editMotionGraphic is not gated: no read is needed (view, updateCode and patchCode)', async () => {
    const { e, ex } = setup(editWorld());
    expect(await ex.execute(callOf('editMotionGraphic', { itemId: 'mg1' }, { session: 'fresh' }))).toMatchObject({ success: true, message: 'Motion graphic code retrieved' });
    expect(await ex.execute(callOf('editMotionGraphic', { itemId: 'mg1', action: 'updateCode', code: 'export const N = () => <AbsoluteFill />;' }, { session: 'fresh2' }))).toMatchObject({ success: true });
    expect(await ex.execute(callOf('editMotionGraphic', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'AbsoluteFill />', new_string: 'AbsoluteFill style={{}} />' }] }, { session: 'fresh3' }))).toMatchObject({ success: true });
    expect(item(e, 'mg1').details.code).toBe('export const N = () => <AbsoluteFill style={{}} />;');
  });

  it('a dry-run MotionGraphicError comes back as the refusal and changes nothing', async () => {
    const { e, ex } = setup(world(), async () => { throw new MotionGraphicError('COMPILATION_ERROR', 'compilation error: deliberate'); });
    await read(ex); const before = json(e.doc);
    const r = await ex.execute(callOf('addMotionGraphic', addArgs(), { session: 's' }));
    expect(r).toEqual({ success: false, code: 'COMPILATION_ERROR', error: 'compilation error: deliberate', message: 'compilation error: deliberate' });
    expect(json(e.doc)).toBe(before);
  });

  it('the same executionKey replays the ledger result without a second dry run, and adds one graphic', async () => {
    const { e, ex, dry } = setup();
    await read(ex);
    const original = callOf('addMotionGraphic', addArgs(), { session: 's' });
    const first = await ex.execute(original);
    const again = await ex.execute({ ...original });
    expect(first).toMatchObject({ success: true }); expect(again).toEqual(first);
    expect(dry).toHaveBeenCalledTimes(1); expect(graphics(e)).toHaveLength(1);
    expect(e.labels().filter(l => l === 'Add items')).toHaveLength(1);
  });

  it('the same executionKey with other input → KEY_COLLISION; no dry run, nothing added', async () => {
    const { e, ex, dry } = setup();
    await read(ex);
    const original = callOf('addMotionGraphic', addArgs(), { session: 's' });
    await ex.execute(original);
    expect(await ex.execute({ ...original, input: addArgs({ timelineStart: 30 }) })).toMatchObject({ success: false, code: 'TOOL_EXECUTION_KEY_COLLISION' });
    expect(dry).toHaveBeenCalledTimes(1); expect(graphics(e)).toHaveLength(1);
  });

  it('a dry-run throw that is not a MotionGraphicError gives the PROJECT_UNAVAILABLE shape with operationMayHaveRun true', async () => {
    const { e, ex } = setup(world(), async () => { throw new Error('sandbox died'); });
    await read(ex); const before = json(e.doc);
    expect(await ex.execute(callOf('addMotionGraphic', addArgs(), { session: 's' }))).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'sandbox died', operationMayHaveRun: true });
    expect(json(e.doc)).toBe(before);
  });

  it('a dry-run throw with no message gets the fixed text', async () => {
    const { ex } = setup(world(), async () => { throw {}; }); // eslint-disable-line no-throw-literal
    await read(ex);
    expect(await ex.execute(callOf('addMotionGraphic', addArgs(), { session: 's' }))).toEqual({ success: false, code: 'PROJECT_UNAVAILABLE', error: 'Unable to verify the open project.', operationMayHaveRun: true });
  });

  it('no project open → PROJECT_UNAVAILABLE for both tools, with no dry run', async () => {
    const dry = vi.fn(async () => undefined);
    const ex = new Executor({ storage: fakeStorage(), current: () => undefined, ui: () => ({ selection: [], playheadMs: 0 }), dryRun: dry });
    const none = { success: false, code: 'PROJECT_UNAVAILABLE', error: 'No project is open in the connected editor tab. Open a project, then retry.' };
    expect(await ex.execute(callOf('addMotionGraphic', addArgs()))).toEqual(none);
    expect(await ex.execute(callOf('editMotionGraphic', { itemId: 'mg1' }))).toEqual(none);
    expect(dry).not.toHaveBeenCalled();
  });

  it('an early refusal is not hidden by the dry run: missing code through the executor is MISSING_PARAM and the dry run is not called', async () => {
    const { ex, dry } = setup();
    await read(ex);
    expect(await ex.execute(callOf('addMotionGraphic', { summary: SUMMARY, ...BOX, trackId: 'O2' }, { session: 's' }))).toMatchObject({ success: false, code: 'MISSING_PARAM', error: 'Missing code', message: MISSING_CODE_MESSAGE });
    expect(dry).not.toHaveBeenCalled();
  });
});

describe('helper schemas (through the helper, as t18a-calls does)', () => {
  let helper: Helper, dir: string;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 't08-tools-')); helper = await startHelper({ port: 0, log: () => {}, configDir: dir }); });
  afterAll(async () => { await helper.close(); rmSync(dir, { recursive: true, force: true }); });
  const invalid = (tool: string, errors: { path: string; code: string; message: string }[]) => ({
    success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`, message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors },
  });
  const open = { success: false, code: 'TAB_NOT_CONNECTED', error: NOT_CONNECTED_ERROR };
  const full = { code: CODE, summary: SUMMARY, ...BOX };

  it('animationDuration "5" gives exactly the stored G-06 16 shape', async () => {
    expect(await helper.call('addMotionGraphic', { ...full, animationDuration: '5' }, undefined)).toEqual({
      success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for addMotionGraphic', message: '$.animationDuration: must be number',
      details: { errors: [{ path: '$.animationDuration', code: 'TYPE', message: 'must be number' }] },
    });
  });
  it('width, height, x and y are required (and nothing else is): four REQUIRED entries in that order', async () => {
    expect(await helper.call('addMotionGraphic', {}, undefined)).toEqual(invalid('addMotionGraphic', ['width', 'height', 'x', 'y'].map(k => ({ path: `$.${k}`, code: 'REQUIRED', message: REQUIRED(k) }))));
  });
  it('the number fields are typed: timelineStart, duration and the box', async () => {
    expect(await helper.call('addMotionGraphic', { ...full, timelineStart: '1' }, undefined)).toEqual(invalid('addMotionGraphic', [{ path: '$.timelineStart', code: 'TYPE', message: 'must be number' }]));
    expect(await helper.call('addMotionGraphic', { ...full, duration: null }, undefined)).toEqual(invalid('addMotionGraphic', [{ path: '$.duration', code: 'TYPE', message: 'must be number' }]));
    expect(await helper.call('addMotionGraphic', { ...full, width: '9' }, undefined)).toEqual(invalid('addMotionGraphic', [{ path: '$.width', code: 'TYPE', message: 'must be number' }]));
  });
  it('code and summary are strings, but not required by the schema (the handler reports MISSING_PARAM)', async () => {
    expect(await helper.call('addMotionGraphic', { ...BOX, code: 5 }, undefined)).toEqual(invalid('addMotionGraphic', [{ path: '$.code', code: 'TYPE', message: 'must be string' }]));
    expect(await helper.call('addMotionGraphic', { ...BOX, summary: 5 }, undefined)).toEqual(invalid('addMotionGraphic', [{ path: '$.summary', code: 'TYPE', message: 'must be string' }]));
    expect(await helper.call('addMotionGraphic', { ...BOX }, undefined)).toEqual(open);
  });
  it('insertAfterItemId is exclusive with trackId and timelineStart (INVALID_COMBINATION on $.insertAfterItemId, clash list in field order)', async () => {
    expect(await helper.call('addMotionGraphic', { ...full, insertAfterItemId: 't1', trackId: 'O2', timelineStart: 1 }, undefined)).toEqual(
      invalid('addMotionGraphic', [{ path: '$.insertAfterItemId', code: 'INVALID_COMBINATION', message: 'cannot be combined with trackId, timelineStart' }]));
    expect(await helper.call('addMotionGraphic', { ...full, insertAfterItemId: 't1', trackId: 'O2' }, undefined)).toEqual(
      invalid('addMotionGraphic', [{ path: '$.insertAfterItemId', code: 'INVALID_COMBINATION', message: 'cannot be combined with trackId' }]));
    expect(await helper.call('addMotionGraphic', { ...full, insertAfterItemId: 't1' }, undefined)).toEqual(open);
    expect(await helper.call('addMotionGraphic', { ...full, trackId: 'O2', timelineStart: 1 }, undefined)).toEqual(open);
  });
  it('both tools are closed objects: an unknown field is ADDITIONALPROPERTIES on $.<field>', async () => {
    expect(await helper.call('addMotionGraphic', { ...full, zz: 1 }, undefined)).toEqual(invalid('addMotionGraphic', [{ path: '$.zz', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }]));
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', zz: 1 }, undefined)).toEqual(invalid('editMotionGraphic', [{ path: '$.zz', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }]));
  });
  it('editMotionGraphic requires itemId and nothing else', async () => {
    expect(await helper.call('editMotionGraphic', {}, undefined)).toEqual(invalid('editMotionGraphic', [{ path: '$.itemId', code: 'REQUIRED', message: REQUIRED('itemId') }]));
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1' }, undefined)).toEqual(open);
  });
  it('a patch item without new_string is REQUIRED on $.patches.0.new_string; a patch item is a closed object', async () => {
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'a' }] }, undefined)).toEqual(
      invalid('editMotionGraphic', [{ path: '$.patches.0.new_string', code: 'REQUIRED', message: REQUIRED('new_string') }]));
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', action: 'patchCode', patches: [{ new_string: 'a' }] }, undefined)).toEqual(
      invalid('editMotionGraphic', [{ path: '$.patches.0.old_string', code: 'REQUIRED', message: REQUIRED('old_string') }]));
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'a', new_string: 'b', bogus: 1 }] }, undefined)).toEqual(
      invalid('editMotionGraphic', [{ path: '$.patches.0.bogus', code: 'ADDITIONALPROPERTIES', message: 'must NOT have additional properties' }]));
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', action: 'patchCode', patches: [{ old_string: 'a', new_string: 'b' }] }, undefined)).toEqual(open);
  });
  it('the editMotionGraphic fields are typed: code, summary and action are strings, patches an array', async () => {
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', code: 5 }, undefined)).toEqual(invalid('editMotionGraphic', [{ path: '$.code', code: 'TYPE', message: 'must be string' }]));
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', summary: 5 }, undefined)).toEqual(invalid('editMotionGraphic', [{ path: '$.summary', code: 'TYPE', message: 'must be string' }]));
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', patches: 'a' }, undefined)).toEqual(invalid('editMotionGraphic', [{ path: '$.patches', code: 'TYPE', message: 'must be array' }]));
  });
  it('action "zap" passes the schema and reaches the tab (the handler answers INVALID_ACTION)', async () => {
    expect(await helper.call('editMotionGraphic', { itemId: 'mg1', action: 'zap' }, undefined)).toEqual(open);
  });
});
