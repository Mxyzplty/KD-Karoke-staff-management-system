// SPDX-License-Identifier: AGPL-3.0-only
// A13 C-gt: settled from code, RC 6.1, no stored output — slot text drawing and the standalone refit search.
// Drawer oracle: literal fixture metrics (10px/character, 20px line height), local slot arithmetic and vertical centring.
// Refit oracle: defining height/maximality properties measured by T05's measureText, not a magic approximate Node font size.
import { afterEach, describe, expect, it } from 'vitest';
import { drawText } from '../apps/web/src/text/draw';
import type { TextDraw } from '../apps/web/src/text/draw';
import type { TextStyle } from '../apps/web/src/text/style';
import { animationState } from '../apps/web/src/text/animation';
import { clearLayouts } from '../apps/web/src/text/measure';
import type { Ctx } from '../apps/web/src/text/measure';
import { measureText } from '../apps/web/src/text/tools';
import { REFIT, refitSlotText } from '../apps/web/src/catalogue/edit';
import { findElement } from '../apps/web/src/catalogue/elements';
import type { RecordData } from '../apps/web/src/store/model';
import { mkItem } from './t03-fixtures';

afterEach(() => clearLayouts());
const prop = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
const props = (values: RecordData) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, prop(value)]));
function recording(text = 'aa bb cc', irrelevantElement = false) {
  clearLayouts();
  const calls: unknown[][] = [], ctx = {
    globalAlpha: 1, font: '', letterSpacing: '0px', wordSpacing: '0px', textBaseline: 'top', textAlign: 'left', fillStyle: '#000000',
    save: () => { calls.push(['save']); }, restore: () => { calls.push(['restore']); },
    translate: (x: number, y: number) => { calls.push(['translate', x, y]); },
    fillRect: (x: number, y: number, width: number, height: number) => { calls.push(['fillRect', x, y, width, height]); },
    fillText: (value: string, x: number, y: number) => { calls.push(['fillText', value, x, y]); },
    strokeText: (value: string, x: number, y: number) => { calls.push(['strokeText', value, x, y]); },
    measureText: (value: string) => ({ width: [...value].length * 10, fontBoundingBoxAscent: 20, fontBoundingBoxDescent: 0 }),
  } as unknown as Ctx;
  const item = mkItem('text', 'O1', 0, 3000, { type: 'text', details: { text, fontFamily: 'Roboto-Regular', fontFamilyDisplay: 'Roboto', ...(irrelevantElement ? { element: { id: 'sticker-star' } } : {}) } });
  const style: TextStyle = { text, F: 20, weight: '400', style: 'normal', families: "'Roboto'", font: "normal 400 20px 'Roboto'", color: '#0000FF', background: '#FF0000',
    align: 'left', transform: 'none', decoration: [], letterSpacing: 'normal', wordSpacing: 'normal', wrap: 'normal', lineHeight: 20, pitch: 20, borderWidth: 0, borderColor: null, shadow: null };
  const d: TextDraw = { item, style, anim: animationState(undefined, 0, text), look: null, shadowScale: 1 };
  return { calls, ctx, d };
}

describe('RC 6.1 text slot drawer: translate, slot-width wrap, vertical lift and local background', () => {
  it('a string fitting the 300px box wraps into three lines at slot width35, with a 20px vertical lift', () => {
    const plain = recording(); expect(drawText(plain.ctx, plain.d, 300, 200)).toBe(true); expect(plain.calls.filter(call => call[0] === 'fillText')).toHaveLength(1);
    const slot = recording(); slot.d.slot = { x: 15, y: 25, W: 35, H: 100 }; expect(drawText(slot.ctx, slot.d, 300, 200)).toBe(true);
    expect(slot.calls.filter(call => call[0] === 'translate')).toEqual([['translate', 15, 25]]);
    expect(slot.calls.filter(call => call[0] === 'fillRect')).toEqual([['fillRect', 0, 0, 35, 100]]);
    expect(slot.calls.findIndex(call => call[0] === 'translate')).toBeLessThan(slot.calls.findIndex(call => call[0] === 'fillRect'));
    const lines = slot.calls.filter(call => call[0] === 'fillText'); expect(lines).toHaveLength(3);
    // Each 20px word fits width35; two words plus their space are50px, so 3 lines ×20px =60px. Lift=(100-60)/2=20.
    expect(lines.map(call => call[2])).toEqual([0, 0, 0]); expect(lines.map(call => call[3])).toEqual([20, 40, 60]);
  });
  it('a one-line short text is centred vertically within the slot, not at its top', () => {
    const r = recording('HI'); r.d.slot = { x: 15, y: 25, W: 100, H: 100 }; drawText(r.ctx, r.d, 300, 200);
    expect(r.calls.filter(call => call[0] === 'fillText')).toEqual([['fillText', 'HI', 0, (100 - 20) / 2]]);
  });
  it('without slot, adding an irrelevant element field leaves every recorded paint/transform call unchanged', () => {
    const ordinary = recording(); drawText(ordinary.ctx, ordinary.d, 300, 200);
    const irrelevant = recording('aa bb cc', true); drawText(irrelevant.ctx, irrelevant.d, 300, 200);
    expect(irrelevant.calls).toEqual(ordinary.calls); expect(ordinary.calls.filter(call => call[0] === 'translate')).toEqual([]);
    expect(ordinary.calls.filter(call => call[0] === 'fillRect')).toEqual([['fillRect', 0, 0, 300, 200]]);
  });
});

function slotItem(text = 'A short sentence that must wrap.', id = 'label-tag', width = 360, height = 180): RecordData {
  return mkItem('slot', 'O1', 0, 3000, { type: 'text', details: { text, fontFamily: 'Roboto-Regular', fontFamilyDisplay: 'Roboto', element: { id, slot: 'text' } },
    properties: props({ positionX: 37, positionY: 83, width, height, fontSize: 48, fontWeight: 400, scale: 1, opacity: 1, wordWrap: 'break-word' }) });
}
describe('RC 6.1 standalone text-slot refit: whole integer maximum and minimum fallback', () => {
  it('REFIT is 8..400, separate from the insert limit48', () => expect(REFIT).toEqual({ min: 8, max: 400 }));
  it.each([{ id: 'label-tag', width: 360, height: 180 }, { id: 'speech-bubble', width: 400, height: 240 }])('$id returned size fits, and size+1 fails unless at the independent upper bound', ({ id, width, height }) => {
    const item = slotItem('A short sentence that must wrap.', id, width, height), slot = findElement(id)!.slot;
    if (slot?.kind !== 'text') throw new Error('fixture requires a text slot');
    const slotWidth = width * slot.box.width, slotHeight = height * slot.box.height, upper = Math.min(400, Math.floor(slotHeight));
    const size = refitSlotText(item)!; expect(Number.isInteger(size)).toBe(true); expect(size).toBeGreaterThanOrEqual(8); expect(size).toBeLessThanOrEqual(upper);
    expect(item.properties.fontSize).toEqual(prop(size)); expect(measureText(item, slotWidth).height).toBeLessThanOrEqual(slotHeight);
    if (size < upper) { const next = structuredClone(item); next.properties.fontSize = prop(size + 1); expect(measureText(next, slotWidth).height).toBeGreaterThan(slotHeight); }
  });
  it('a one-letter text in a tall slot reaches min(400,floor(slotHeight)), not the insert cap48', () => {
    const item = slotItem('H', 'label-tag', 720, 1800), slotHeight = 1800 * (160 / 240), upper = Math.min(400, Math.floor(slotHeight));
    expect(refitSlotText(item)).toBe(upper); expect(upper).toBe(400); expect(item.properties.fontSize).toEqual(prop(400));
  });
  it('a long text that cannot fit even at8 returns8', () => {
    const item = slotItem('too many words '.repeat(100), 'label-tag', 36, 30), width = 36 * (600 / 720), height = 30 * (160 / 240);
    expect(refitSlotText(item)).toBe(8); expect(measureText(item, width).height).toBeGreaterThan(height); expect(item.properties.fontSize).toEqual(prop(8));
  });
  it.each(['ordinary text', 'plain image', 'media layout', 'empty text', 'unknown slot'])('%s returns null and changes nothing', kind => {
    const item = slotItem();
    if (kind === 'ordinary text') delete item.details.element;
    if (kind === 'plain image') { item.type = 'image'; item.details.element = { id: 'sticker-star' }; }
    if (kind === 'media layout') { item.type = 'layout'; item.details.element = { id: 'phone-frame', slot: 'media' }; item.details.layoutType = 'element'; item.details.cells = []; }
    if (kind === 'empty text') item.details.text = '';
    if (kind === 'unknown slot') item.details.element.id = 'missing';
    const before = structuredClone(item); expect(refitSlotText(item)).toBeNull(); expect(item).toEqual(before);
  });
});
