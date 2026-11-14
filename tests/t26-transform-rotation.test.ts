// SPDX-License-Identifier: AGPL-3.0-only
// T26 row 15: transformItem stores the rotation brought into 0 <= r < 360 (-90 -> 270, 360 -> 0, -360 -> 0, never -0).
// The -360..360 input check stays (400 and -361 are refused). Written from the rule, not from the code.
// Every case seeds a stored rotation of 30, so a result of 0 is a written value and not a missing property.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, fixture, itemOf, links, resetIds, useIds } from './t03-fixtures';

beforeEach(() => useIds()); afterEach(() => resetIds());
type Editor = ReturnType<typeof createEditor>;
const editor = (doc: ProjectDocument = fixture()) => createEditor(doc, { assets: assets(), links: links() });
const call = (e: Editor, name: string, args: Record<string, unknown>): any => e.call(name, args);
const kf = (time: number, value: unknown, easing: any = 'linear') => ({ id: `k${time}`, time, value, easing });
const prop = (keyframes: any[], defaultValue: unknown = 0) => ({ defaultValue, keyframes });
/** The fixture with `patch` merged into item `id` before the editor starts. */
const patched = (id: string, patch: Record<string, unknown>) => { const d = fixture(); Object.assign(itemOf(d, id), patch); return d; };
const seeded = () => editor(patched('v1', { properties: { rotation: prop([], 30) } }));
const stored = (e: Editor) => itemOf(e.doc, 'v1').properties.rotation.defaultValue;

describe('T26 transformItem rotation is stored in 0 <= r < 360', () => {
  it.each([
    ['-90 becomes 270', -90, 270],
    ['360 becomes 0', 360, 0],
    ['359.5 stays 359.5', 359.5, 359.5],
    ['15 stays 15', 15, 15],
    ['0 stays 0', 0, 0],
    ['-0.5 becomes 359.5', -0.5, 359.5],
  ])('%s', (_title, input, expected) => {
    const e = seeded();
    expect(call(e, 'transformItem', { itemId: 'v1', rotation: input }).success).toBe(true);
    expect(stored(e)).toBe(expected);
  });
  it('-360 becomes 0 and the stored value is not -0', () => {
    const e = seeded();
    expect(call(e, 'transformItem', { itemId: 'v1', rotation: -360 }).success).toBe(true);
    expect(stored(e)).toBe(0);
    expect(Object.is(stored(e), -0)).toBe(false);
  });
  it('360 is stored as +0, not -0', () => {
    const e = seeded();
    expect(call(e, 'transformItem', { itemId: 'v1', rotation: 360 }).success).toBe(true);
    expect(Object.is(stored(e), -0)).toBe(false);
  });
  it.each([400, -361])('%s is refused with PROPERTY_VALIDATION_FAILED and the stored value is unchanged', input => {
    const e = seeded();
    expect(call(e, 'transformItem', { itemId: 'v1', rotation: input })).toMatchObject({ success: false, code: 'PROPERTY_VALIDATION_FAILED' });
    expect(stored(e)).toBe(30);
  });
  it('a keyframed rotation keeps its keyframes and gets the normalised base value', () => {
    const ks = [kf(0, 0), kf(1000, 90)], e = editor(patched('v1', { properties: { rotation: prop(ks, 0) } }));
    expect(call(e, 'transformItem', { itemId: 'v1', rotation: -90 }).success).toBe(true);
    expect(itemOf(e.doc, 'v1').properties.rotation).toEqual({ defaultValue: 270, keyframes: ks });
  });
  it('a call without rotation leaves a stored 380 untouched', () => {
    const e = editor(patched('v1', { properties: { rotation: prop([], 380) } }));
    expect(call(e, 'transformItem', { itemId: 'v1', x: 10 }).success).toBe(true);
    expect(stored(e)).toBe(380);
  });
});
