// SPDX-License-Identifier: AGPL-3.0-only
// T08 Q4 switch (review M3): PARITY.summaryCode (mg/parity-switches.ts) is the code of a summary that is given but empty or over 400 characters, on
// addMotionGraphic and editMotionGraphic: 'MISSING_PARAM' (error codes §9, the default) or 'VALIDATION_ERROR' (agent tool results §2). Both values are tested here; the
// error text is the same either way (error = message, reference compares §1.4). A missing summary on an edit is MISSING_PARAM "Missing summary" under both values.
// The default value itself is covered in t08-tools.test.ts "summary rules (Q4: error = message)".
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PARITY } from '../apps/web/src/mg/parity-switches';
import { loadCompiler } from '../apps/web/src/mg/tools';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeAll(loadCompiler);
const ORIGINAL = PARITY.summaryCode;
beforeEach(() => useIds());
afterEach(() => { PARITY.summaryCode = ORIGINAL; resetIds(); });

const SUMMARY_REQUIRED = 'Motion graphic summary is required. Describe what the graphic visually represents in 1 sentence, or up to 3 short sentences for complex graphics.';
const SUMMARY_LONG = 'Motion graphic summary must be 400 characters or less.';
const CODE = `export const Card = () => <AbsoluteFill style={{ backgroundColor: '#112233' }}><div style={{ fontFamily: 'Roboto', color: '#fff' }}>Hello</div></AbsoluteFill>;`;
const NEW = `export const N = () => <AbsoluteFill />;`;
const BOX = { width: 540, height: 960, x: 10, y: 20 };
const mg = (id: string, from: number, to: number, metadata: Record<string, unknown>) =>
  mkItem(id, 'O1', from, to, { type: 'motionGraphic', trim: { from: 0, to: to - from }, sourceDuration: to - from, details: { name: 'Motion graphic', code: CODE }, metadata });
const world = (): ProjectDocument => build({ tracks: [mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay')], items: [mg('withSummary', 0, 5000, { summary: 'A card.' }), mg('noSummary', 6000, 9000, {})] });
const editor = () => createEditor(world(), { assets: assets(), links: links() });
type Editor = ReturnType<typeof editor>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (e: Editor, name: string, args: Record<string, unknown>): any => e.call(name, args);
const json = (d: unknown) => JSON.stringify(d);

/** Summaries that are given but invalid, with the text each is refused with. */
const INVALID: [string, unknown, string][] = [
  ['an empty summary', '', SUMMARY_REQUIRED],
  ['a blank summary (spaces and a newline)', '  \n ', SUMMARY_REQUIRED],
  ['a summary of 401 characters', 'x'.repeat(401), SUMMARY_LONG],
];
const nothingChanged = (e: Editor, before: string) => { expect(json(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0); };

describe.each(['MISSING_PARAM', 'VALIDATION_ERROR'] as const)('PARITY.summaryCode = %s', value => {
  beforeEach(() => { PARITY.summaryCode = value; });

  describe('addMotionGraphic', () => {
    it.each(INVALID)('%s → %s with the text as error and message; nothing is added', (_name, summary, text) => {
      const e = editor(), before = json(e.doc);
      expect(call(e, 'addMotionGraphic', { code: CODE, summary, ...BOX, trackId: 'O2' })).toMatchObject({ success: false, code: value, error: text, message: text });
      nothingChanged(e, before);
    });
    it('a summary that is not a string (a number) is refused like an empty one', () => {
      const e = editor(), before = json(e.doc);
      expect(call(e, 'addMotionGraphic', { code: CODE, summary: 5, ...BOX, trackId: 'O2' })).toMatchObject({ success: false, code: value, error: SUMMARY_REQUIRED });
      nothingChanged(e, before);
    });
    it('a summary of exactly 400 characters is accepted', () => {
      const e = editor();
      expect(call(e, 'addMotionGraphic', { code: CODE, summary: 'x'.repeat(400), ...BOX, trackId: 'O2' })).toMatchObject({ success: true });
    });
    it('a missing code is still MISSING_PARAM "Missing code", whatever the switch says (the code check comes first)', () => {
      const e = editor();
      expect(call(e, 'addMotionGraphic', { summary: '', ...BOX, trackId: 'O2' })).toMatchObject({ success: false, code: 'MISSING_PARAM', error: 'Missing code' });
    });
  });

  describe.each(['updateCode', 'patchCode'] as const)('editMotionGraphic %s', action => {
    const body = action === 'updateCode' ? { code: NEW } : { patches: [{ old_string: 'Hello', new_string: 'Hi' }] };
    it.each(INVALID)('%s → %s with the text as error and message; the item is untouched', (_name, summary, text) => {
      const e = editor(), before = json(e.doc);
      expect(call(e, 'editMotionGraphic', { itemId: 'withSummary', action, ...body, summary })).toMatchObject({ success: false, code: value, error: text, message: text });
      nothingChanged(e, before);
    });
    it('a given invalid summary is refused even when the item has none stored', () => {
      const e = editor(), before = json(e.doc);
      expect(call(e, 'editMotionGraphic', { itemId: 'noSummary', action, ...body, summary: '' })).toMatchObject({ success: false, code: value, error: SUMMARY_REQUIRED });
      nothingChanged(e, before);
    });
    it('no summary given and none stored → MISSING_PARAM "Missing summary" with the summary-required text, under both values', () => {
      const e = editor(), before = json(e.doc);
      expect(call(e, 'editMotionGraphic', { itemId: 'noSummary', action, ...body })).toMatchObject({ success: false, code: 'MISSING_PARAM', error: 'Missing summary', message: SUMMARY_REQUIRED });
      nothingChanged(e, before);
    });
    it('no summary given and one stored: the call succeeds and keeps it', () => {
      const e = editor();
      expect(call(e, 'editMotionGraphic', { itemId: 'withSummary', action, ...body })).toMatchObject({ success: true, data: { summary: 'A card.' } });
    });
    it('a valid summary replaces the stored one', () => {
      const e = editor();
      expect(call(e, 'editMotionGraphic', { itemId: 'withSummary', action, ...body, summary: '  A  new   card. ' })).toMatchObject({ success: true, data: { summary: 'A new card.' } });
      expect(e.doc.items.find(i => i.id === 'withSummary')!.metadata.summary).toBe('A new card.');
    });
  });
});

it('the default is MISSING_PARAM (error codes §9)', () => { expect(ORIGINAL).toBe('MISSING_PARAM'); });
