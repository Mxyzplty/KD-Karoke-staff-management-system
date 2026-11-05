// SPDX-License-Identifier: AGPL-3.0-only
// T08 Motion Graphics rail panel command: the intent `addBlankMotionGraphic` ({startMs, endMs}) through the T03 runtime.
// Oracle: findings part 3 §46.3 (Add Blank Motion Graphic: an empty graphic, whole canvas, on a new overlay track), ticket T08 "Motion Graphics rail panel",
// Xapp's refusal of its 0-5 s empty sample ("Not a code-mode MG", graphic modes 2026-10-20), error codes (INVALID_DURATION). Documents store ms.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itemDraw, framePlan } from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => resetIds());

const world = (): ProjectDocument => build({
  tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('C1', 'caption')],
  items: [video('v1', 'V1', 0, 8000), mkItem('t1', 'O1', 1000, 3000, { type: 'text', details: { text: 'x' } })],
  extra: { size: { width: 540, height: 960 } },
});
const editor = (doc = world()) => createEditor(doc, { assets: assets(), links: links() });
const add = (e: ReturnType<typeof editor>, startMs: number, endMs: number) => e.intent({ type: 'addBlankMotionGraphic', startMs, endMs });
const blanks = (e: ReturnType<typeof editor>) => e.doc.items.filter(i => i.type === 'motionGraphic');

describe('addBlankMotionGraphic: the stored graphic (findings part 3 §46.3)', () => {
  it('succeeds and stores one code-less motionGraphic covering the whole canvas, trim 0 to the length, designed length = the length', () => {
    const e = editor();
    expect(add(e, 1500, 4000)).toEqual({ ok: true });
    expect(blanks(e)).toHaveLength(1);
    const g = blanks(e)[0];
    expect(g).toMatchObject({ type: 'motionGraphic', display: { from: 1500, to: 4000 }, trim: { from: 0, to: 2500 }, sourceDuration: 2500, playbackRate: 1, details: { name: 'Motion graphic' }, metadata: {}, masks: [], effects: [] });
    expect('code' in g.details).toBe(false);
    expect(g.properties).toMatchObject({ positionX: { defaultValue: 0 }, positionY: { defaultValue: 0 }, width: { defaultValue: 540 }, height: { defaultValue: 960 }, scale: { defaultValue: 1 } });
  });
  it('the box is the project size of the document it is added to', () => {
    const e = editor(build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 4000)], extra: { size: { width: 1080, height: 1920 } } }));
    add(e, 0, 5000);
    expect(blanks(e)[0].properties).toMatchObject({ width: { defaultValue: 1080 }, height: { defaultValue: 1920 } });
  });
  it('lives on a NEW overlay track (default placement: just above the highest non-caption track, below the caption track)', () => {
    const e = editor(), before = e.doc.tracks.map(t => t.id);
    add(e, 0, 5000);
    const created = e.doc.tracks.filter(t => !before.includes(t.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: 'overlay', muted: false, solo: false, locked: false, hidden: false });
    expect(blanks(e)[0].trackId).toBe(created[0].id);
    expect(e.doc.layerOrder.map(l => l.id)).toEqual(['V1', 'O1', created[0].id, 'C1']);
  });
  it('never overlaps: it is added over existing items on other tracks without touching them, and two adds make two tracks', () => {
    const e = editor(), items = JSON.stringify(e.doc.items);
    add(e, 1000, 3000); add(e, 1000, 3000);
    expect(JSON.stringify(e.doc.items.filter(i => i.type !== 'motionGraphic'))).toBe(items);
    const [a, b] = blanks(e);
    expect(a.trackId).not.toBe(b.trackId);
    expect(e.doc.tracks.filter(t => t.kind === 'overlay')).toHaveLength(3);
    expect(e.doc.tracks.length).toBe(5);
  });
  it('the project duration grows to the end of the new graphic', () => {
    const e = editor();
    add(e, 7000, 12000);
    expect(e.doc.duration).toBe(12000);
  });
});

describe('addBlankMotionGraphic: history', () => {
  it('one undo entry "Add items" from the user; undo removes the item and the track, redo brings them back', () => {
    const e = editor(), before = JSON.stringify(e.doc);
    add(e, 1000, 4000);
    expect(e.bus.undoStack).toHaveLength(1);
    expect(e.bus.undoStack[0]).toMatchObject({ label: 'Add items', source: 'user' });
    const after = JSON.stringify(e.doc);
    e.bus.undo();
    expect(JSON.stringify(e.doc)).toBe(before);
    e.bus.redo();
    expect(JSON.stringify(e.doc)).toBe(after);
  });
});

describe('addBlankMotionGraphic: refusals leave the document untouched with no history entry', () => {
  const refusal = (startMs: number, endMs: number, received: string) => it(`${startMs} to ${endMs} ms: INVALID_DURATION "duration must be positive. Received: ${received}s."`, () => {
    const e = editor(), before = JSON.stringify(e.doc);
    const r = add(e, startMs, endMs);
    expect(r).toMatchObject({ ok: false, code: 'INVALID_DURATION' });
    expect((r as { message: string }).message).toContain(`duration must be positive. Received: ${received}s.`);
    expect(JSON.stringify(e.doc)).toBe(before);
    expect(e.bus.undoStack).toHaveLength(0);
    expect(e.journal).toHaveLength(0);
  });
  refusal(2000, 2000, '0');
  refusal(4000, 1000, '-3');
  refusal(-500, 2000, '2.5');
  refusal(-1000, -200, '0.8');
  refusal(Number.NaN, 3000, 'NaN');
});

describe('a blank graphic is an empty graphic', () => {
  it('editMotionGraphic view refuses it with NO_CODE; the render model draws nothing and lists nothing pending', () => {
    const e = editor(); add(e, 0, 5000);
    const g = blanks(e)[0];
    const r = e.call('editMotionGraphic', { itemId: g.id }) as { success: boolean; code?: string };
    expect(r).toMatchObject({ success: false, code: 'NO_CODE' });
    expect(itemDraw(e.doc, g, 1000)).toBeNull();
    const plan = framePlan(e.doc, 1000);
    expect(plan.draws.filter(d => d.item.id === g.id)).toEqual([]);
    expect(plan.pending).toEqual(framePlan(editor().doc, 1000).pending);
  });
});
