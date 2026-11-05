// SPDX-License-Identifier: AGPL-3.0-only
// T05 agent path: the addText tool (defaults, placement, every failure code and its order, no ledger / undo entry on a refusal) and the
// font load the agent path awaits first (coordinator ruling Q5: callTextTool loads the faces the call would draw with; a face that cannot
// load refuses the call with nothing changed; a refused call loads nothing; a dry run writes nothing). Oracles: the written contract in
// "T05 text and text animations notes (C).md" and the ticket (addText defaults 100 px / 60 % wrap width / 3 s; max 300 s), not the code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { valueAt } from '../apps/web/src/timeline/properties';
import { build, mkTrack, resetIds, video } from './t03-fixtures';

const fonts = vi.hoisted(() => ({ loadFont: vi.fn(), loadChainFonts: vi.fn(), loadUserFonts: vi.fn() }));
vi.mock('../apps/web/src/text/fonts', async orig => ({ ...await orig<typeof import('../apps/web/src/text/fonts')>(), ...fonts }));
import { FontError, itemFonts } from '../apps/web/src/text/font-registry';
import { PARITY } from '../apps/web/src/text/parity-switches';
import { callTextTool, needsFontLoad } from '../apps/web/src/text/agent';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T08:00:00.000Z'));
  fonts.loadFont.mockReset().mockResolvedValue(undefined); fonts.loadChainFonts.mockReset().mockResolvedValue([]); fonts.loadUserFonts.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { resetIds(); vi.useRealTimers(); PARITY.weightFace = 'switch'; });

type Editor = ReturnType<typeof createEditor>;
const doc = (): ProjectDocument => build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay', { locked: true })], items: [video('v1', 'V1', 0, 4000)] });
const sizeOf = (e: Editor) => (e.doc as unknown as { size: { width: number; height: number } }).size;
const itemOf = (e: Editor, id: string) => e.doc.items.find(i => i.id === id) as any;
const v = (i: any, k: string) => valueAt(i, k, 0);

describe('T05 addText: success shape and defaults', () => {
  it('1. minimal call: fontSize 100, wrap width 60 % of the canvas, centred, 3 s from 0 s; result data and label', () => {
    const e = createEditor(doc()), r = e.call('addText', { textContent: 'Hi', trackId: 'O1' }) as any;
    expect(r.success).toBe(true);
    const id = r.data.itemId, t = itemOf(e, id), { width: W, height: H } = sizeOf(e), wrap = Math.round(W * 0.6);
    expect(r.data).toEqual({ itemId: id, assetId: null, type: 'text', trackId: 'O1', timelinePosition: { start: 0, end: 3 } });
    expect(r.message).toBe(`Added text item '${id}' to track 'O1' at 0s`);
    expect(t.type).toBe('text'); expect(t.details.text).toBe('Hi'); expect(t.display).toEqual({ from: 0, to: 3000 });
    expect([v(t, 'fontSize'), v(t, 'width')]).toEqual([100, wrap]);
    expect(v(t, 'positionX')).toBe(Math.round((W - wrap) / 2));
    expect(v(t, 'positionY')).toBe(Math.round((H - (v(t, 'height') as number)) / 2));
    expect(v(t, 'height')).toBeGreaterThan(0);
    expect(e.labels()).toEqual(['Add items']);
  });

  it('2. timelineStart / duration (seconds) place the item; duration 300 s is the maximum, one frame the minimum', () => {
    const e = createEditor(doc());
    const a = e.call('addText', { textContent: 'a', trackId: 'O1', timelineStart: 1.5, duration: 2 }) as any;
    expect(itemOf(e, a.data.itemId).display).toEqual({ from: 1500, to: 3500 });
    expect(a.data.timelinePosition).toEqual({ start: 1.5, end: 3.5 });
    expect((e.call('addText', { textContent: 'b', trackId: 'O1', timelineStart: 10, duration: 300 }) as any).success).toBe(true);
    const one = e.call('addText', { textContent: 'c', trackId: 'O1', timelineStart: 400, duration: 0.034 }) as any; expect(one.success, JSON.stringify(one)).toBe(true);
    const long = e.call('addText', { textContent: 'd', trackId: 'O1', timelineStart: 800, duration: 300.001 }) as any;
    expect([long.success, long.code]).toEqual([false, 'INVALID_DURATION']);
    const short = e.call('addText', { textContent: 'd', trackId: 'O1', timelineStart: 800, duration: 0.03 }) as any;
    expect([short.success, short.code]).toEqual([false, 'INVALID_DURATION']);
  });

  it('2b. the minimum the refusal itself states (one frame, 0.033 s) is accepted', () => {
    const r = createEditor(doc()).call('addText', { textContent: 'a', trackId: 'O1', duration: 0.033 }) as any;
    expect(r.success, JSON.stringify(r)).toBe(true);       // INVALID_DURATION says "between one frame (0.033s) and 300 seconds"
  });

  it('3. bounds: x / y position, bounds.width is the wrap width, the result carries resolvedBounds with the measured height', () => {
    const e = createEditor(doc()), r = e.call('addText', { textContent: 'Hello world', trackId: 'O1', bounds: { x: 120, y: 340, width: 500 } }) as any;
    const t = itemOf(e, r.data.itemId);
    expect([v(t, 'positionX'), v(t, 'positionY'), v(t, 'width')]).toEqual([120, 340, 500]);
    expect(r.data.resolvedBounds).toEqual({ x: 120, y: 340, width: 500, height: v(t, 'height') });
    expect((e.call('addText', { textContent: 'ok', trackId: 'O1', timelineStart: 5, bounds: { x: 0, y: 0, width: 300 }, maxWidth: 300 }) as any).success).toBe(true);   // maxWidth equal to bounds.width is accepted
  });

  it('4. maxWidth sets the wrap width; fontSize, color, backgroundColor, font and textAnimation are stored', () => {
    const e = createEditor(doc());
    const r = e.call('addText', { textContent: 'Styled', trackId: 'O1', maxWidth: 400, fontSize: 64, color: '#ff0000', backgroundColor: '#00ff00', font: 'Roboto', textAnimation: { preset: 'pop' } }) as any;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const t = itemOf(e, r.data.itemId);
    expect([v(t, 'width'), v(t, 'fontSize'), v(t, 'color'), v(t, 'backgroundColor')]).toEqual([400, 64, '#ff0000', '#00ff00']);
    expect(t.details).toMatchObject({ fontFamilyDisplay: 'Roboto' });
    expect(t.details.fontFamily).toMatch(/^Roboto/);
    expect(t.details.textAnimation).toMatchObject({ preset: 'pop' });
  });

  it('5. insertAfterItemId: the new text starts where the referenced text ends, on its track; label "Insert items"', () => {
    const e = createEditor(doc()), a = e.call('addText', { textContent: 'one', trackId: 'O1', timelineStart: 1, duration: 2 }) as any;
    const b = e.call('addText', { textContent: 'two', insertAfterItemId: a.data.itemId, duration: 1 }) as any;
    expect(b.success, JSON.stringify(b)).toBe(true);
    const t = itemOf(e, b.data.itemId);
    expect([t.trackId, t.display]).toEqual(['O1', { from: 3000, to: 4000 }]);
    expect(e.labels()).toEqual(['Add items', 'Insert items']);
  });

  it('6. one Undo removes the added text (a single undo entry)', () => {
    const e = createEditor(doc()), before = e.doc.items.length;
    e.call('addText', { textContent: 'Hi', trackId: 'O1' });
    expect(e.doc.items).toHaveLength(before + 1);
    e.intent({ type: 'undo' });
    expect(e.doc.items).toHaveLength(before);
  });
});

describe('T05 addText: a face name sets weight and style exactly as editProperties (R2 M2: reuse writeFont, do not copy)', () => {
  const faces = (i: any) => itemFonts(i).map(r => r.variant.face);
  for (const mode of ['switch', 'keep'] as const) {
    it(`${mode}: font 'Roboto-Bold' stores the Bold face; itemFonts resolves to Roboto-Bold`, () => {
      PARITY.weightFace = mode;
      const e = createEditor(doc()), r = e.call('addText', { textContent: 'Hi', trackId: 'O1', font: 'Roboto-Bold' }) as any;
      expect(r.success, JSON.stringify(r)).toBe(true);
      const t = itemOf(e, r.data.itemId);
      expect(t.details).toMatchObject({ fontFamily: 'Roboto-Bold', fontFamilyDisplay: 'Roboto' });
      expect(faces(t)).toEqual(['Roboto-Bold']);
    });
  }
  it("switch: font 'Roboto-Bold' writes fontWeight 700 / fontStyle normal (the old fontDetails path left the weight unset, drawing Regular)", () => {
    const e = createEditor(doc()), r = e.call('addText', { textContent: 'Hi', trackId: 'O1', font: 'Roboto-Bold' }) as any;
    const t = itemOf(e, r.data.itemId);
    expect([v(t, 'fontWeight'), v(t, 'fontStyle')]).toEqual([700, 'normal']);
  });
  it('addText(font) equals addText + editProperties(fontFamily) in font family, display, weight and style (both modes)', () => {
    for (const mode of ['switch', 'keep'] as const) {
      PARITY.weightFace = mode;
      const e = createEditor(doc());
      const a = e.call('addText', { textContent: 'Hi', trackId: 'O1', font: 'Roboto-Bold' }) as any;
      const b = e.call('addText', { textContent: 'Hi', trackId: 'O1', timelineStart: 3 }) as any;
      e.call('editProperties', { itemIds: [b.data.itemId], properties: { fontFamily: 'Roboto-Bold' } });
      const font = (i: any) => ({ family: i.details.fontFamily, display: i.details.fontFamilyDisplay, weight: v(i, 'fontWeight'), style: v(i, 'fontStyle') });
      expect(font(itemOf(e, a.data.itemId))).toEqual(font(itemOf(e, b.data.itemId)));
    }
  });
});

describe('T05 addText: failures return their code and change nothing (no undo entry)', () => {
  const FAIL: [string, Record<string, unknown>, string][] = [
    ['MISSING_CONTENT (empty)', { textContent: '', trackId: 'O1' }, 'MISSING_CONTENT'],
    ['MISSING_CONTENT (blank)', { textContent: '   ', trackId: 'O1' }, 'MISSING_CONTENT'],
    ['MISSING_TRACK_ID', { textContent: 'Hi' }, 'MISSING_TRACK_ID'],
    ['INVALID_TRACK (video track)', { textContent: 'Hi', trackId: 'V1' }, 'INVALID_TRACK'],
    ['INVALID_TRACK (unknown id)', { textContent: 'Hi', trackId: 'nope' }, 'INVALID_TRACK'],
    ['TRACK_LOCKED', { textContent: 'Hi', trackId: 'O2' }, 'TRACK_LOCKED'],
    ['INSERT_AFTER_NOT_FOUND', { textContent: 'Hi', insertAfterItemId: 'zz' }, 'INSERT_AFTER_NOT_FOUND'],
    ['INSERT_AFTER_TYPE_MISMATCH (a video)', { textContent: 'Hi', insertAfterItemId: 'v1' }, 'INSERT_AFTER_TYPE_MISMATCH'],
    ['INVALID_COMBINATION (insertAfter + trackId)', { textContent: 'Hi', insertAfterItemId: 'v1', trackId: 'O1' }, 'INVALID_COMBINATION'],
    ['INVALID_COMBINATION (insertAfter + timelineStart)', { textContent: 'Hi', insertAfterItemId: 'v1', timelineStart: 1 }, 'INVALID_COMBINATION'],
    ['INVALID_COMBINATION (bounds + different maxWidth)', { textContent: 'Hi', trackId: 'O1', bounds: { x: 0, y: 0, width: 300 }, maxWidth: 200 }, 'INVALID_COMBINATION'],
    ['INVALID_BOUNDS (negative width)', { textContent: 'Hi', trackId: 'O1', bounds: { x: 1, y: 2, width: -1 } }, 'INVALID_BOUNDS'],
    ['INVALID_BOUNDS (missing y)', { textContent: 'Hi', trackId: 'O1', bounds: { x: 1, width: 5 } }, 'INVALID_BOUNDS'],
    ['INVALID_PROPERTY_VALUE (maxWidth 0)', { textContent: 'Hi', trackId: 'O1', maxWidth: 0 }, 'INVALID_PROPERTY_VALUE'],
    ['INVALID_PROPERTY_VALUE (fontSize -3)', { textContent: 'Hi', trackId: 'O1', fontSize: -3 }, 'INVALID_PROPERTY_VALUE'],
    ['INVALID_TIMELINE_START', { textContent: 'Hi', trackId: 'O1', timelineStart: -1 }, 'INVALID_TIMELINE_START'],
    ['INVALID_DURATION (0)', { textContent: 'Hi', trackId: 'O1', duration: 0 }, 'INVALID_DURATION'],
    ['FONT_NOT_FOUND', { textContent: 'Hi', trackId: 'O1', font: 'Nope Sans' }, 'FONT_NOT_FOUND'],
  ];
  it.each(FAIL)('%s', (_name, args, code) => {
    const e = createEditor(doc()), before = JSON.stringify(e.doc), r = e.call('addText', args) as any;
    expect(r.success).toBe(false); expect(r.code).toBe(code); expect(typeof r.error).toBe('string');
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.labels()).toEqual([]);
  });

  it('INVALID_TIMELINE_START carries top-level details {received, minimum: 0, example: 0} in the units the call used (seconds)', () => {
    const r = createEditor(doc()).call('addText', { textContent: 'Hi', trackId: 'O1', timelineStart: -1 }) as any;
    expect(r.message).toBe('timelineStart must be >= 0. Received: -1s.');
    expect(r.details).toEqual({ received: -1, minimum: 0, example: 0 });          // oracle: the message, minimum, example and INVALID_DURATION.received are all in seconds
  });
  it('INVALID_DURATION carries details {received, minimum: one frame, maximum: 300, example: 3}', () => {
    const r = createEditor(doc()).call('addText', { textContent: 'Hi', trackId: 'O1', duration: 301 }) as any;
    expect(r.details).toEqual({ received: 301, minimum: 0.033, maximum: 300, example: 3 });
    expect(r.message).toBe('duration must be between one frame (0.033s) and 300 seconds. Received: 301s.');
  });
  it('FONT_NOT_FOUND carries details {requestedFont, suggestion}', () => {
    const r = createEditor(doc()).call('addText', { textContent: 'Hi', trackId: 'O1', font: 'Nope Sans' }) as any;
    expect(r.details).toEqual({ requestedFont: 'Nope Sans', suggestion: "Font 'Nope Sans' is unavailable. Choose a font from the fonts tool." });
  });
  it('failure order: content, then bounds, then start, then duration, then font, then track', () => {
    const e = createEditor(doc());
    const order = (args: Record<string, unknown>) => (e.call('addText', args) as any).code;
    expect(order({ textContent: '', bounds: { x: 0, y: 0, width: -1 }, timelineStart: -1 })).toBe('MISSING_CONTENT');
    expect(order({ textContent: 'a', bounds: { x: 0, y: 0, width: -1 }, timelineStart: -1 })).toBe('INVALID_BOUNDS');
    expect(order({ textContent: 'a', timelineStart: -1, duration: 0, font: 'Nope Sans' })).toBe('INVALID_TIMELINE_START');
    expect(order({ textContent: 'a', duration: 0, font: 'Nope Sans' })).toBe('INVALID_DURATION');
    expect(order({ textContent: 'a', font: 'Nope Sans' })).toBe('FONT_NOT_FOUND');
    expect(order({ textContent: 'a', trackId: 'V1' })).toBe('INVALID_TRACK');
  });
});

describe('T05 agent font load (coordinator ruling Q5)', () => {
  const textDoc = () => build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')], items: [video('v1', 'V1', 0, 4000)] });
  const ctxOf = (e: Editor) => e.runtime.tools;
  const run = (e: Editor, name: string, args: Record<string, unknown>) => vi.fn(() => e.call(name, args));

  it('7. needsFontLoad: addText, and editProperties holding a font key; nothing else', () => {
    expect(needsFontLoad('addText', {})).toBe(true);
    expect(needsFontLoad('addText', undefined)).toBe(true);
    expect(needsFontLoad('editProperties', { properties: { fontFamily: 'Roboto' } })).toBe(true);
    expect(needsFontLoad('editProperties', { properties: { opacity: 0.5 } })).toBe(false);
    expect(needsFontLoad('editProperties', { properties: 'x' })).toBe(false);
    expect(needsFontLoad('editProperties', undefined)).toBe(false);
    for (const t of ['addShape', 'addMotionGraphic', 'deleteItems', 'getContext']) expect(needsFontLoad(t, { properties: { fontFamily: 'Roboto' } })).toBe(false);
  });

  it('8. addText loads the face the item would draw with (and the chain fonts for its text), then runs the real call once', async () => {
    const e = createEditor(textDoc()), args = { textContent: 'Hi 你好', trackId: 'O1', font: 'Roboto' }, call = run(e, 'addText', args);
    const r = await callTextTool(ctxOf(e), 'addText', args, { run: call }) as any;
    expect(r.success).toBe(true); expect(call).toHaveBeenCalledTimes(1);
    expect(fonts.loadUserFonts).toHaveBeenCalledTimes(1);
    expect(fonts.loadFont).toHaveBeenCalled();
    expect(fonts.loadFont.mock.calls[0][0].variant.face).toMatch(/^Roboto/); expect(fonts.loadFont.mock.calls[0][1]).toBe('Hi 你好');
    expect(fonts.loadChainFonts).toHaveBeenCalledWith('Hi 你好');
    expect(e.doc.items.filter((i: any) => i.type === 'text')).toHaveLength(1);       // the dry run wrote nothing extra: exactly the one real item
    expect(e.labels()).toEqual(['Add items']);
  });

  it('9. a face that cannot load: success false, the loader\'s FONT_* code, "No items were added.", run never called, no ledger or undo entry', async () => {
    fonts.loadFont.mockRejectedValue(new FontError('FONT_DELIVERY_FAILED', 'blocked'));
    const e = createEditor(textDoc()), before = JSON.stringify(e.doc), args = { textContent: 'Hi', trackId: 'O1', font: 'Roboto' }, call = run(e, 'addText', args);
    const r = await callTextTool(ctxOf(e), 'addText', args, { run: call }) as any;
    expect(r).toEqual({ success: false, error: 'The selected font could not be loaded. No items were added.', code: 'FONT_DELIVERY_FAILED' });
    expect(call).not.toHaveBeenCalled();
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.labels()).toEqual([]); expect(e.journal).toEqual([]);
  });

  it('10. FONT_LOAD_FAILED and FONT_TOO_LARGE pass through as the code', async () => {
    for (const code of ['FONT_LOAD_FAILED', 'FONT_TOO_LARGE'] as const) {
      fonts.loadFont.mockRejectedValueOnce(new FontError(code, 'x'));
      const e = createEditor(textDoc()), args = { textContent: 'Hi', trackId: 'O1', font: 'Roboto' };
      expect(((await callTextTool(ctxOf(e), 'addText', args, { run: run(e, 'addText', args) })) as any).code).toBe(code);
    }
  });

  it('11. a refused call loads nothing and returns the refusal from the real call (run called once)', async () => {
    const e = createEditor(textDoc()), args = { textContent: '', trackId: 'O1', font: 'Roboto' }, call = run(e, 'addText', args);
    const r = await callTextTool(ctxOf(e), 'addText', args, { run: call }) as any;
    expect([r.success, r.code]).toEqual([false, 'MISSING_CONTENT']);
    expect(call).toHaveBeenCalledTimes(1);
    expect(fonts.loadFont).not.toHaveBeenCalled(); expect(fonts.loadChainFonts).not.toHaveBeenCalled();
  });

  it('12. a chain font (emoji / CJK) that cannot load only falls back: the call still runs', async () => {
    fonts.loadChainFonts.mockResolvedValue(['Chinese, Japanese and Korean characters are drawn with the default sans-serif font: the CJK font (Noto Sans SC) could not be loaded. Check the connection.']);
    const e = createEditor(textDoc()), args = { textContent: '你好', trackId: 'O1' }, call = run(e, 'addText', args);
    expect(((await callTextTool(ctxOf(e), 'addText', args, { run: call })) as any).success).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('13. editProperties with a font key loads the new face for each text item; a failure says "No items were changed." and changes nothing', async () => {
    const e = createEditor(textDoc()), a = e.call('addText', { textContent: 'One', trackId: 'O1' }) as any, id = a.data.itemId;
    const args = { itemIds: [id], properties: { fontFamily: 'Roboto' } };
    fonts.loadFont.mockClear();
    const ok = await callTextTool(ctxOf(e), 'editProperties', args, { run: run(e, 'editProperties', args) }) as any;
    expect(ok.success, JSON.stringify(ok)).toBe(true);
    expect(fonts.loadFont).toHaveBeenCalled(); expect(fonts.loadFont.mock.calls[0][1]).toBe('One');
    fonts.loadFont.mockRejectedValue(new FontError('FONT_LOAD_FAILED', 'x'));
    const args2 = { itemIds: [id], properties: { fontFamily: 'Open Sans' } }, call = run(e, 'editProperties', args2), before = JSON.stringify(e.doc), labelsBefore = e.labels().length;
    const r = await callTextTool(ctxOf(e), 'editProperties', args2, { run: call }) as any;
    expect(r).toEqual({ success: false, error: 'The selected font could not be loaded. No items were changed.', code: 'FONT_LOAD_FAILED' });
    expect(call).not.toHaveBeenCalled(); expect(JSON.stringify(e.doc)).toBe(before); expect(e.labels()).toHaveLength(labelsBefore);
  });

  it('14. the dry run is discarded: loading for addText leaves the document, the undo stack and the journal as they were', async () => {
    const e = createEditor(textDoc()), before = JSON.stringify(e.doc), args = { textContent: 'Hi', trackId: 'O1' };
    fonts.loadFont.mockImplementation(async () => { expect(JSON.stringify(e.doc)).toBe(before); expect(e.labels()).toEqual([]); });
    await callTextTool(ctxOf(e), 'addText', args, { run: () => ({ success: true, message: 'x' }) });
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.labels()).toEqual([]); expect(e.journal).toEqual([]);
  });

  it('15. an error that is not a FontError is not swallowed', async () => {
    fonts.loadFont.mockRejectedValue(new TypeError('boom'));
    const e = createEditor(textDoc()), args = { textContent: 'Hi', trackId: 'O1', font: 'Roboto' };
    await expect(callTextTool(ctxOf(e), 'addText', args, { run: run(e, 'addText', args) })).rejects.toThrow('boom');
  });
});
