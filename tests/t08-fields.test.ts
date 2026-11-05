// SPDX-License-Identifier: AGPL-3.0-only
// T08 inspector Fields section, the logic below the UI (review M5): the declared-field list (mg/fields.tsx fieldList / fieldValue), the intent
// editGraphicField on the T03 command path and the render model's carry of details.fieldValues. The controls themselves are tests/ui/t08-fields.spec.ts.
// Oracle: agent tool results (C) line 1726 (editable fields: text, number, color, boolean, text[], font, select; the value is details.fieldValues[name], else the
// declared default) and the runtime rule in mg/runtime-components.tsx `editable` (type = meta.type, else text[] for an array default, else typeof the default).
// Provisional, not Xapp parity (stated in fields.tsx): the label (meta.label, else the name) and the choice list (meta.options: strings or {value, label?}).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIELD_CAPS, fieldCount, fieldList, fieldValue, listEntries } from '../apps/web/src/mg/fields';
import { framePlan, itemDraw } from '../apps/web/src/render/model';
import type { Draw } from '../apps/web/src/render/model';
import type { RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => resetIds());

describe('fieldList: the sandbox\'s declared list as controls', () => {
  const one = (name: unknown, defaultValue: unknown, meta?: Record<string, unknown>) => fieldList([{ name, defaultValue, meta }]);

  describe('the type rule: meta.type, else text[] for an array default, else typeof the default', () => {
    const typed: [string, unknown][] = [['text', 'a'], ['string', 'a'], ['number', 1], ['color', '#fff'], ['boolean', true], ['text[]', ['a']], ['font', 'Roboto'], ['select', 'a']];
    it.each(typed)('meta.type "%s" is kept', (type, defaultValue) => {
      expect(one('f', defaultValue, { type })).toEqual([{ name: 'f', type, label: 'f', defaultValue, options: [] }]);
    });
    it('no meta.type: a string default is "string", a number "number", a boolean "boolean"', () => {
      expect(one('a', 'x')[0].type).toBe('string');
      expect(one('b', 3)[0].type).toBe('number');
      expect(one('c', false)[0].type).toBe('boolean');
    });
    it('no meta.type: an array default is "text[]" (not "object")', () => {
      expect(one('l', ['a', 'b'])[0].type).toBe('text[]');
      expect(one('empty', [])[0].type).toBe('text[]');
    });
    it('meta.type wins over the default\'s own type (a string default declared "color" is a colour, a string default declared "select" a choice)', () => {
      expect(one('c', '#ff0000', { type: 'color' })[0].type).toBe('color');
      expect(one('s', 'a', { type: 'select', options: ['a', 'b'] })[0].type).toBe('select');
    });
  });

  describe('entries that are left out', () => {
    it('an unknown meta.type', () => { expect(one('f', 'x', { type: 'date' })).toEqual([]); });
    it('no meta.type and a default that is not string, number, boolean or array (an object, null, undefined)', () => {
      expect(one('o', { a: 1 })).toEqual([]);
      expect(one('n', null)).toEqual([]);
      expect(one('u', undefined)).toEqual([]);
    });
    it('a meta.type that is not a string', () => { expect(one('f', 'x', { type: 5 })).toEqual([]); });
    it('a missing or non-string name', () => {
      expect(one(undefined, 'x')).toEqual([]);
      expect(one(5, 'x')).toEqual([]);
      expect(fieldList([{ defaultValue: 'x' }])).toEqual([]);
    });
    it('a null or non-object entry does not throw and is left out', () => {
      expect(fieldList([null, undefined, 'x', 7])).toEqual([]);
    });
    it('the valid entries around a dropped one keep their order', () => {
      const list = fieldList([{ name: 'a', defaultValue: 'x' }, { name: 'bad', defaultValue: 'x', meta: { type: 'date' } }, { name: 'c', defaultValue: 2 }]);
      expect(list.map(f => f.name)).toEqual(['a', 'c']);
    });
    it('an empty list is an empty list', () => { expect(fieldList([])).toEqual([]); });
  });

  describe('the label', () => {
    it('meta.label when it is a string', () => { expect(one('title', 'x', { label: 'Headline' })[0].label).toBe('Headline'); });
    it('else the name (no meta, no label, a non-string label)', () => {
      expect(one('title', 'x')[0].label).toBe('title');
      expect(one('title', 'x', {})[0].label).toBe('title');
      expect(one('title', 'x', { label: 5 })[0].label).toBe('title');
    });
  });

  describe('select options (meta.options)', () => {
    it('strings become {value, label} with the label equal to the value', () => {
      expect(one('s', 'a', { type: 'select', options: ['a', 'b'] })[0].options).toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]);
    });
    it('{value, label} keeps its label; {value} alone uses the value as the label; a non-string label falls back to the value', () => {
      expect(one('s', 'a', { type: 'select', options: [{ value: 'a', label: 'Alpha' }, { value: 'b' }, { value: 'c', label: 9 }] })[0].options)
        .toEqual([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'b' }, { value: 'c', label: 'c' }]);
    });
    it('entries that are neither a string nor an object with a string value are dropped, the rest keep their order', () => {
      expect(one('s', 'a', { type: 'select', options: ['a', 5, null, { value: 5 }, {}, { value: 'z' }] })[0].options).toEqual([{ value: 'a', label: 'a' }, { value: 'z', label: 'z' }]);
    });
    it('no options, or options that are not an array, give an empty list', () => {
      expect(one('s', 'a', { type: 'select' })[0].options).toEqual([]);
      expect(one('s', 'a', { type: 'select', options: 'a,b' })[0].options).toEqual([]);
    });
  });

  it('defaultValue is carried as declared (the same array, not a copy of a default)', () => {
    const list = ['a', 'b'];
    expect(one('l', list)[0].defaultValue).toBe(list);
  });

  // Review m4: the caps are a provisional coordinator default (2 Nov), no spec: 100 fields, 200 options per choice, 200 characters per label.
  describe('the caps (FIELD_CAPS)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, defaultValue: 'x' }));
    it('the caps are 100 fields, 200 options, 200 label characters and 200 list entries', () => {
      expect(FIELD_CAPS).toEqual({ fields: 100, options: 200, label: 200, entries: 200 });
    });
    it('a list shows its first 200 entries and counts the rest; all entries are kept for an edit (review n1)', () => {
      const value = Array.from({ length: 1_000 }, (_, i) => i % 2 ? `e${i}` : i);
      const { all, shown, more } = listEntries(value);
      expect(all).toHaveLength(1_000);
      expect(all[999]).toBe('e999');
      expect(shown).toEqual(all.slice(0, 200));
      expect(more).toBe(800);
      expect(listEntries(all.slice(0, 200))).toMatchObject({ more: 0 });
      expect(listEntries('not a list')).toEqual({ all: [], shown: [], more: 0 });
    });
    it('100 fields are all kept; 50,000 keep the first 100 in order, and fieldCount counts all 50,000', () => {
      expect(fieldList(many(100))).toHaveLength(100);
      const raw = many(50_000), list = fieldList(raw);
      expect(list.map(f => f.name)).toEqual(many(100).map(f => f.name));
      expect(fieldCount(raw)).toBe(50_000);
    });
    it('fieldCount counts only the entries that are controls (as fieldList), so the "more" line counts fields, not junk', () => {
      const raw = [...many(100), null, { name: 'bad', defaultValue: 'x', meta: { type: 'date' } }, { defaultValue: 'x' }, { name: 'late', defaultValue: 1 }];
      expect(fieldList(raw)).toHaveLength(100);
      expect(fieldCount(raw) - fieldList(raw).length).toBe(1);
      expect(fieldCount([])).toBe(0);
    });
    it('invalid entries do not use up the cap: 100 valid fields after 10 invalid ones are all kept', () => {
      expect(fieldList([...Array.from({ length: 10 }, () => ({ name: 'bad', defaultValue: null })), ...many(100)])).toHaveLength(100);
    });
    it('a choice keeps its first 200 valid options; dropped entries do not count', () => {
      const options = [5, null, ...Array.from({ length: 10_000 }, (_, i) => `o${i}`)];
      const kept = one('s', 'o0', { type: 'select', options })[0].options;
      expect(kept).toHaveLength(200);
      expect(kept[0]).toEqual({ value: 'o0', label: 'o0' });
      expect(kept[199]).toEqual({ value: 'o199', label: 'o199' });
    });
    it('labels keep their first 200 characters: meta.label, the name as label, and an option label (the name and option value stay whole)', () => {
      const long = 'x'.repeat(5_000);
      const f = one(long, 'a', { type: 'select', options: [long, { value: 'v', label: long }] })[0];
      expect(f.name).toBe(long);
      expect(f.label).toBe('x'.repeat(200));
      expect(f.options).toEqual([{ value: long, label: 'x'.repeat(200) }, { value: 'v', label: 'x'.repeat(200) }]);
      expect(one('n', 'a', { label: long })[0].label).toHaveLength(200);
      expect(one('n', 'a', { label: 'y'.repeat(200) })[0].label).toBe('y'.repeat(200));
    });
  });
});

describe('fieldValue: the item\'s value, else the declared default', () => {
  const field = (name: string, defaultValue: unknown) => fieldList([{ name, defaultValue }])[0];
  const withValues = (fieldValues: unknown): RecordData => ({ id: 'g', type: 'motionGraphic', details: { fieldValues } } as RecordData);

  it('a set value wins over the default', () => {
    expect(fieldValue(withValues({ title: 'Set' }), field('title', 'Default'))).toBe('Set');
  });
  it('no fieldValues, or no entry for the name: the default', () => {
    expect(fieldValue({ id: 'g', type: 'motionGraphic', details: {} } as RecordData, field('title', 'Default'))).toBe('Default');
    expect(fieldValue({ id: 'g', type: 'motionGraphic' } as RecordData, field('title', 'Default'))).toBe('Default');
    expect(fieldValue(withValues({ other: 'x' }), field('title', 'Default'))).toBe('Default');
  });
  it('a falsy set value (empty string, 0, false, an empty list) is still the item\'s value, not the default', () => {
    expect(fieldValue(withValues({ t: '' }), field('t', 'Default'))).toBe('');
    expect(fieldValue(withValues({ n: 0 }), field('n', 5))).toBe(0);
    expect(fieldValue(withValues({ b: false }), field('b', true))).toBe(false);
    expect(fieldValue(withValues({ l: [] }), field('l', ['a']))).toEqual([]);
  });
  it('own properties only: a name that exists on Object.prototype is the default (toString, constructor, __proto__)', () => {
    for (const name of ['toString', 'constructor', 'hasOwnProperty'])
      expect(fieldValue(withValues({}), field(name, 'Default')), name).toBe('Default');
    expect(fieldValue(withValues(Object.create({ title: 'inherited' })), field('title', 'Default'))).toBe('Default');
  });
  it('fieldValues that is not a plain object (an array, a string, null) gives the default', () => {
    for (const bad of [['x'], 'x', null, 7]) expect(fieldValue(withValues(bad), field('0', 'Default')), JSON.stringify(bad)).toBe('Default');
  });
});

describe('through the runtime: intent editGraphicField {itemId, name, value} (provisional: one "Edit items" step, merged into details.fieldValues)', () => {
  const CODE = `export const G = () => { const t = editable('title', 'Hi'); return <AbsoluteFill>{t}</AbsoluteFill>; };`;
  const mg = (extra: Record<string, unknown> = {}) => mkItem('g1', 'O1', 0, 4000, { type: 'motionGraphic', trim: { from: 0, to: 4000 }, sourceDuration: 4000, details: { name: 'Fields', code: CODE, ...extra } });
  const world = (details: Record<string, unknown> = {}) => build({
    tracks: [mkTrack('O1', 'overlay')],
    items: [mg(details), mkItem('t1', 'O1', 5000, 6000, { type: 'text', details: { text: 'x' } })],
  });
  const editor = (details: Record<string, unknown> = {}) => createEditor(world(details), { assets: assets(), links: links() });
  const g1 = (e: ReturnType<typeof editor>) => e.doc.items.find(i => i.id === 'g1')!;

  it('the first value creates details.fieldValues; the step is one "Edit items" user entry; the rest of the item is untouched', () => {
    const e = editor(), before = structuredClone(g1(e));
    expect(e.intent({ type: 'editGraphicField', itemId: 'g1', name: 'title', value: 'Hello' })).toEqual({ ok: true });
    expect(g1(e).details.fieldValues).toEqual({ title: 'Hello' });
    expect({ ...g1(e), details: { ...g1(e).details, fieldValues: undefined } }).toEqual({ ...before, details: { ...before.details, fieldValues: undefined } });
    expect(e.bus.undoStack).toHaveLength(1);
    expect(e.bus.undoStack[0]).toMatchObject({ label: 'Edit items', source: 'user' });
  });

  it('a second field merges into the existing values; an existing field is replaced; other values stay', () => {
    const e = editor({ fieldValues: { title: 'Old', size: 3 } });
    e.intent({ type: 'editGraphicField', itemId: 'g1', name: 'color', value: '#00ff00' });
    expect(g1(e).details.fieldValues).toEqual({ title: 'Old', size: 3, color: '#00ff00' });
    e.intent({ type: 'editGraphicField', itemId: 'g1', name: 'title', value: 'New' });
    expect(g1(e).details.fieldValues).toEqual({ title: 'New', size: 3, color: '#00ff00' });
    expect(e.bus.undoStack.map(s => s.label)).toEqual(['Edit items', 'Edit items']);
  });

  it('every value type is stored as given: string, number, boolean, a list', () => {
    const e = editor();
    for (const [name, value] of [['s', 'x'], ['n', 12.5], ['b', false], ['l', ['a', '', 'c']]] as const)
      expect(e.intent({ type: 'editGraphicField', itemId: 'g1', name, value: value as string | number | boolean | string[] })).toEqual({ ok: true });
    expect(g1(e).details.fieldValues).toEqual({ s: 'x', n: 12.5, b: false, l: ['a', '', 'c'] });
  });

  it('fieldValues of another shape (an array) is replaced by an object holding the new value, not spread into it', () => {
    const e = editor({ fieldValues: ['junk'] });
    e.intent({ type: 'editGraphicField', itemId: 'g1', name: 'title', value: 'x' });
    expect(g1(e).details.fieldValues).toEqual({ title: 'x' });
  });

  it('details.code, name and the other details keys are kept', () => {
    const e = editor({ extra: 'kept' });
    e.intent({ type: 'editGraphicField', itemId: 'g1', name: 'title', value: 'x' });
    expect(g1(e).details).toMatchObject({ name: 'Fields', code: CODE, extra: 'kept' });
  });

  it('undo removes the step (the document is byte-identical to before), redo applies it again', () => {
    const e = editor(), before = JSON.stringify(e.doc);
    e.intent({ type: 'editGraphicField', itemId: 'g1', name: 'title', value: 'x' });
    const after = JSON.stringify(e.doc);
    e.bus.undo(); expect(JSON.stringify(e.doc)).toBe(before);
    e.bus.redo(); expect(JSON.stringify(e.doc)).toBe(after);
  });

  it('undo restores the previous value, not nothing, when the field was already set', () => {
    const e = editor({ fieldValues: { title: 'Old' } });
    e.intent({ type: 'editGraphicField', itemId: 'g1', name: 'title', value: 'New' });
    e.bus.undo();
    expect(g1(e).details.fieldValues).toEqual({ title: 'Old' });
  });

  it.each([['an unknown id', 'nope'], ['a text item', 't1']])('%s: ITEM_NOT_FOUND "Item not found", no history entry, document untouched', (_label, itemId) => {
    const e = editor(), before = JSON.stringify(e.doc);
    expect(e.intent({ type: 'editGraphicField', itemId, name: 'title', value: 'x' })).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND', message: 'Item not found' });
    expect(e.bus.undoStack).toHaveLength(0);
    expect(JSON.stringify(e.doc)).toBe(before);
  });
});

describe('the render model carries details.fieldValues to the draw (render/model.ts)', () => {
  const props = { positionX: { defaultValue: 0, keyframes: [] }, positionY: { defaultValue: 0, keyframes: [] }, width: { defaultValue: 540, keyframes: [] }, height: { defaultValue: 960, keyframes: [] }, scale: { defaultValue: 1, keyframes: [] } };
  const project = (details: Record<string, unknown>) => ({
    schemaVersion: 4, rev: 0, size: { width: 540, height: 960 }, fps: 30, duration: 4000, background: {}, transitions: [], markers: [],
    tracks: [{ id: 'O1', kind: 'overlay' }], layerOrder: [{ type: 'track', id: 'O1' }], groups: {},
    items: [{ id: 'g', type: 'motionGraphic', trackId: 'O1', display: { from: 0, to: 4000 }, trim: { from: 0, to: 4000 }, sourceDuration: 4000, properties: props, details: { code: 'export const G = () => <AbsoluteFill />;', ...details } }],
  }) as unknown as Parameters<typeof framePlan>[0];
  const drawOf = (doc: ReturnType<typeof project>) => itemDraw(doc, doc.items[0], 500) as Draw;

  it('the stored values reach graphic.fieldValues (framePlan draws and itemDraw)', () => {
    const doc = project({ fieldValues: { title: 'Set', n: 2, l: ['a'] } });
    expect(drawOf(doc).graphic!.fieldValues).toEqual({ title: 'Set', n: 2, l: ['a'] });
    const plan = framePlan(doc, 500, { width: 540, height: 960 });
    expect(plan.draws).toHaveLength(1);
    expect(plan.draws[0].graphic!.fieldValues).toEqual({ title: 'Set', n: 2, l: ['a'] });
  });
  it('no fieldValues gives an empty object (the declared defaults then apply in the sandbox)', () => {
    expect(drawOf(project({})).graphic!.fieldValues).toEqual({});
  });
  it('fieldValues that is not an object (an array, a string) gives an empty object', () => {
    expect(drawOf(project({ fieldValues: ['x'] })).graphic!.fieldValues).toEqual({});
    expect(drawOf(project({ fieldValues: 'x' })).graphic!.fieldValues).toEqual({});
  });
  it('an edit through the intent changes the draw (the render uses the value)', () => {
    const e = createEditor(build({ tracks: [mkTrack('O1', 'overlay')], items: [mkItem('g1', 'O1', 0, 4000, { type: 'motionGraphic', trim: { from: 0, to: 4000 }, sourceDuration: 4000, details: { name: 'F', code: 'export const G = () => <AbsoluteFill />;' } })] }), { assets: assets(), links: links() });
    const at = () => itemDraw(e.doc, e.doc.items[0], 500) as Draw;
    expect(at().graphic!.fieldValues).toEqual({});
    e.intent({ type: 'editGraphicField', itemId: 'g1', name: 'title', value: 'Edited' });
    expect(at().graphic!.fieldValues).toEqual({ title: 'Edited' });
  });
});
