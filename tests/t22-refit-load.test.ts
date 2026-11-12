// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 9d / D88: wait for a refitting bubble's font; a FontError on that non-strict path falls back silently.
// Font-key edits keep T05's strict refusal. Expectations come from D88 and RC 6.3, never the new loading predicates.
// As in t05-agent, only the three asynchronous font I/O functions are mocked; the dry run, tools and intent path are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditor } from '../apps/web/src/timeline/harness';
import type { RecordData } from '../apps/web/src/store/model';
import type { ToolResult } from '../apps/web/src/timeline/tools';
import { assets, build, itemOf, mkItem, mkTrack, resetIds } from './t03-fixtures';

const fonts = vi.hoisted(() => ({ loadFont: vi.fn(), loadChainFonts: vi.fn(), loadUserFonts: vi.fn() }));
vi.mock('../apps/web/src/text/fonts', async orig => ({ ...await orig<typeof import('../apps/web/src/text/fonts')>(), ...fonts }));
import { FontError } from '../apps/web/src/text/font-registry';
import type { ResolvedFont } from '../apps/web/src/text/font-registry';
import { callTextTool, needsFontLoad } from '../apps/web/src/text/agent';
import { measureText } from '../apps/web/src/text/tools';
import { clearLayouts } from '../apps/web/src/text/measure';

beforeEach(() => {
  fonts.loadFont.mockReset().mockResolvedValue(undefined); fonts.loadChainFonts.mockReset().mockResolvedValue([]); fonts.loadUserFonts.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { resetIds(); clearLayouts(); });
const prop = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
const props = (values: RecordData) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, prop(value)]));
function bubble(id = 'bubble', text = 'Before'): RecordData {
  return mkItem(id, 'O1', 0, 4000, { type: 'text', details: { text, fontFamily: 'Manrope-Bold', fontFamilyDisplay: 'Manrope', element: { id: 'label-tag', slot: 'text' } },
    properties: props({ positionX: 37, positionY: 83, width: 360, height: 180, fontSize: 48, fontWeight: 700, fontStyle: 'normal', wordWrap: 'break-word' }) });
}
function plain(): RecordData {
  return mkItem('plain', 'O2', 0, 4000, { type: 'text', details: { text: 'Ordinary text', fontFamily: 'Roboto-Regular', fontFamilyDisplay: 'Roboto' },
    properties: props({ positionX: 37, positionY: 83, width: 360, height: 180, fontSize: 48, fontWeight: 400, fontStyle: 'normal' }) });
}
function frame(): RecordData {
  return mkItem('frame', 'O2', 0, 4000, { type: 'layout', details: { layoutType: 'element', gap: 0, borderRadius: 0, element: { id: 'phone-frame', slot: 'media' },
    cells: [{ id: 'opening', bounds: { x: 30 / 540, y: 90 / 1080, width: 480 / 540, height: 900 / 1080 }, source: null,
      fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 }] },
    properties: props({ positionX: 37, positionY: 83, width: 540, height: 1080 }) });
}
const editor = (...items: RecordData[]) => createEditor(build({ tracks: [mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay')], items,
  extra: { rev: 17, size: { width: 1080, height: 1920 } } }), { assets: assets() });
const faces = () => fonts.loadFont.mock.calls.map(([face]) => (face as ResolvedFont).variant.face);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('D88: a non-strict bubble refit loads first and preserves the native result on fallback', () => {
  it('text makes an empty bubble refittable; its face resolves before options.run is called', async () => {
    const e = editor(bubble('bubble', '')), before = structuredClone(e.doc), args = { itemIds: ['bubble'], properties: { text: 'The new words need a fit.' } };
    const entered = deferred(), release = deferred(), order: string[] = [], native: ToolResult = { success: true, message: 'Native run result', data: { token: 'unchanged' } };
    fonts.loadFont.mockImplementation(async (face: ResolvedFont) => { order.push(`load ${face.variant.face}`); entered.resolve(); await release.promise; order.push('font resolved'); });
    const run = vi.fn(() => { order.push('run'); return native; }), pending = callTextTool(e.runtime.tools, 'editProperties', args, { run });
    await entered.promise; let result: ToolResult | undefined;
    try {
      expect(faces()).toEqual(['Manrope-Bold']); expect(fonts.loadFont.mock.calls[0][1]).toBe(args.properties.text); expect(run).not.toHaveBeenCalled();
      expect(e.doc).toEqual(before); expect(e.labels()).toEqual([]); expect(e.journal).toEqual([]);
    } finally { release.resolve(); result = await pending; }
    expect(result).toBe(native); expect(run).toHaveBeenCalledTimes(1); expect(order).toEqual(['load Manrope-Bold', 'font resolved', 'run']);
  });

  it.each(['plain width', 'layout width', 'empty bubble', 'whitespace bubble', 'cleared bubble', 'unknown element'])('%s: a trigger that refits nothing loads no face and returns run\'s own successful result', async kind => {
    let item: RecordData, properties: RecordData;
    if (kind === 'plain width') { item = plain(); properties = { width: 600 }; }
    else if (kind === 'layout width') { item = frame(); properties = { width: 600 }; }
    else {
      item = bubble(); properties = { width: 600 };
      if (kind === 'empty bubble') item.details.text = '';
      if (kind === 'whitespace bubble') item.details.text = ' \t\n ';
      if (kind === 'cleared bubble') properties = { text: '' };
      if (kind === 'unknown element') { item.details.element.id = 'missing-catalogue-element'; properties = { text: 'Still non-blank' }; }
    }
    const e = editor(item), args = { itemIds: [item.id], properties }, run = vi.fn(() => e.call('editProperties', args));
    const result = await callTextTool(e.runtime.tools, 'editProperties', args, { run });
    expect(result.success, JSON.stringify(result)).toBe(true); expect(run).toHaveBeenCalledTimes(1); expect(result).toBe(run.mock.results[0].value); expect(fonts.loadFont).not.toHaveBeenCalled();
  });

  it('a non-strict load FontError is dropped without adding a note, code, field or copy to run\'s result', async () => {
    fonts.loadFont.mockRejectedValue(new FontError('FONT_LOAD_FAILED', 'fixture delivery failure'));
    const e = editor(bubble()), args = { itemIds: ['bubble'], properties: { text: 'New wrapped text' } }, before = structuredClone(e.doc);
    const native: ToolResult = { success: true, message: 'The native message stays exactly this.', data: { token: 'native result', notes: [] } }, expected = structuredClone(native), run = vi.fn(() => native);
    const result = await callTextTool(e.runtime.tools, 'editProperties', args, { run });
    expect(faces()).toEqual(['Manrope-Bold']); expect(run).toHaveBeenCalledTimes(1); expect(result).toBe(native); expect(result).toEqual(expected); expect(e.doc).toEqual(before); expect(e.labels()).toEqual([]);
  });

  it('a failed non-strict load still runs the real tool, with only its normal refit entry and sentence', async () => {
    fonts.loadFont.mockRejectedValue(new FontError('FONT_DELIVERY_FAILED', 'blocked'));
    const item = bubble(), text = 'too many words '.repeat(100); Object.assign(item.properties, props({ width: 36, height: 30 }));
    const smallest = structuredClone(item); smallest.details.text = text; smallest.properties.fontSize = prop(8);
    // RC 6.3: local slot W=36*(600/720)=30, H=30*(160/240)=20; no size fits, so the result is 8.
    expect(measureText(smallest, 36 * (600 / 720)).height).toBeGreaterThan(30 * (160 / 240));
    const e = editor(item), args = { itemIds: ['bubble'], properties: { text } }, run = vi.fn(() => e.call('editProperties', args));
    const result = await callTextTool(e.runtime.tools, 'editProperties', args, { run });
    expect(run).toHaveBeenCalledTimes(1); expect(result).toBe(run.mock.results[0].value); expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data.results).toEqual([{ itemId: 'bubble', applied: { fontSize: 8 } }]); expect(result.message).toBe("Updated 1 item atomically. bubble's text fits its bubble at fontSize 8."); expect(result).not.toHaveProperty('code');
    expect(itemOf(e.doc, 'bubble').details.text).toBe(text); expect(itemOf(e.doc, 'bubble').properties.fontSize).toEqual(prop(8)); expect(e.labels()).toEqual(['Edit items']);
  });

  it('a mixed width batch loads the bubble face, never the ordinary text face', async () => {
    const e = editor(bubble(), plain()), args = { itemIds: ['bubble', 'plain'], properties: { width: 600 } }, run = vi.fn(() => e.call('editProperties', args));
    const result = await callTextTool(e.runtime.tools, 'editProperties', args, { run });
    expect(result.success, JSON.stringify(result)).toBe(true); expect(run).toHaveBeenCalledTimes(1); expect(faces()).toEqual(['Manrope-Bold']);
    expect(itemOf(e.doc, 'plain').properties.fontSize).toEqual(prop(48)); expect(itemOf(e.doc, 'plain').properties.width).toEqual(prop(600));
  });

  it('media + width uses ctx.asset in the discarded dry run, then loads the bubble face before the real batch', async () => {
    const e = editor(frame(), bubble()), before = structuredClone(e.doc), order: string[] = [], image = assets().find(a => a.id === 'asset-img1')!;
    const asset = vi.fn((id: string) => { order.push(`asset ${id}`); return id === image.id ? image : undefined; });
    fonts.loadFont.mockImplementation(async (face: ResolvedFont) => { order.push(`font ${face.variant.face}`); expect(e.doc).toEqual(before); expect(e.labels()).toEqual([]); });
    const args = { itemIds: ['frame', 'bubble'], properties: { media: ['asset-img1'], width: 600 } }, run = vi.fn(() => { order.push('run'); return e.call('editProperties', args); });
    const result = await callTextTool({ ...e.runtime.tools, asset }, 'editProperties', args, { run });
    expect(result.success, JSON.stringify(result)).toBe(true); expect(asset).toHaveBeenCalledWith('asset-img1'); expect(faces()).toEqual(['Manrope-Bold']); expect(run).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['asset asset-img1', 'font Manrope-Bold', 'run']);
    expect(itemOf(e.doc, 'frame').details.cells[0].source).toEqual({ assetId: 'asset-img1', type: 'image', url: 'asset:asset-img1' });
    expect(result.data.results.find((r: RecordData) => r.itemId === 'bubble').applied.fontSize).toEqual(expect.any(Number)); expect(e.labels()).toEqual(['Edit items']);
  });

  it('a non-FontError from a non-strict load rejects rather than falling back or running', async () => {
    const failure = new TypeError('unexpected font I/O failure'); fonts.loadFont.mockRejectedValue(failure);
    const e = editor(bubble()), before = structuredClone(e.doc), args = { itemIds: ['bubble'], properties: { text: 'After' } }, run = vi.fn(() => ({ success: true }));
    await expect(callTextTool(e.runtime.tools, 'editProperties', args, { run })).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled(); expect(e.doc).toEqual(before); expect(e.labels()).toEqual([]);
  });
});

describe('D88: font-key calls retain T05 strict font-load failures', () => {
  it.each(['FONT_LOAD_FAILED', 'FONT_DELIVERY_FAILED'] as const)('fontFamily: %s refuses without running or changing the document', code => {
    fonts.loadFont.mockRejectedValue(new FontError(code, 'blocked'));
    const e = editor(bubble()), before = structuredClone(e.doc), args = { itemIds: ['bubble'], properties: { fontFamily: 'Roboto-Regular' } }, run = vi.fn(() => e.call('editProperties', args));
    return callTextTool(e.runtime.tools, 'editProperties', args, { run }).then(result => {
      expect(result).toEqual({ success: false, code, error: 'The selected font could not be loaded. No items were changed.' }); expect(run).not.toHaveBeenCalled();
      expect(faces()).toEqual(['Roboto-Regular']); expect(e.doc).toEqual(before); expect(e.labels()).toEqual([]); expect(e.journal).toEqual([]);
    });
  });
  it('text plus fontFamily remains strict: a failed load refuses the text change too', async () => {
    fonts.loadFont.mockRejectedValue(new FontError('FONT_LOAD_FAILED', 'blocked'));
    const e = editor(bubble()), before = structuredClone(e.doc), args = { itemIds: ['bubble'], properties: { text: 'Must not be written', fontFamily: 'Roboto-Regular' } }, run = vi.fn(() => e.call('editProperties', args));
    const result = await callTextTool(e.runtime.tools, 'editProperties', args, { run });
    expect(result).toEqual({ success: false, code: 'FONT_LOAD_FAILED', error: 'The selected font could not be loaded. No items were changed.' });
    expect(run).not.toHaveBeenCalled(); expect(e.doc).toEqual(before); expect(e.labels()).toEqual([]); expect(e.journal).toEqual([]);
  });
});

describe('D88: needsFontLoad is a presence gate, not a claim that every target is a bubble', () => {
  it.each(['text', 'fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'letterSpacing', 'lineHeight', 'wordSpacing', 'textTransform', 'look', 'width', 'height'])(
    'editProperties with %s needs the font-loading pre-step', key => { expect(needsFontLoad('editProperties', { properties: { [key]: 'present' } })).toBe(true); });
  it.each([
    { name: 'opacity', input: { properties: { opacity: 0.5 } } }, { name: 'positionX', input: { properties: { positionX: 20 } } },
    { name: 'missing properties', input: {} }, { name: 'undefined input', input: undefined }, { name: 'string properties', input: { properties: 'text' } },
    { name: 'null properties', input: { properties: null } }, { name: 'array properties', input: { properties: ['text'] } },
  ])('$name does not need the pre-step', ({ input }) => { expect(needsFontLoad('editProperties', input)).toBe(false); });
  it.each(['addShape', 'addMedia', 'deleteItems', 'context'])('%s does not enter this font path even with a trigger-shaped property', tool => {
    expect(needsFontLoad(tool, { properties: { text: 'After', width: 600, fontFamily: 'Roboto-Regular' } })).toBe(false);
  });
});

it('D88 inline commit remains synchronous: real refit and history finish without entering any asynchronous font loader', () => {
  const item = bubble(), text = 'too many words '.repeat(100); Object.assign(item.properties, props({ width: 36, height: 30 }));
  const e = editor(item), outcome = e.intent({ type: 'editTextProperties', itemIds: ['bubble'], properties: { text }, refit: true });
  expect(outcome).toEqual({ ok: true }); expect(outcome).not.toBeInstanceOf(Promise); expect(itemOf(e.doc, 'bubble').details.text).toBe(text); expect(itemOf(e.doc, 'bubble').properties.fontSize).toEqual(prop(8));
  expect(e.labels()).toEqual(['Edit items']); expect(fonts.loadUserFonts).not.toHaveBeenCalled(); expect(fonts.loadFont).not.toHaveBeenCalled(); expect(fonts.loadChainFonts).not.toHaveBeenCalled();
});
