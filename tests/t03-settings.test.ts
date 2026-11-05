// SPDX-License-Identifier: AGPL-3.0-only
// T03 settings ops: Set duration / Set fps / Set background (findings part 2 §36; part 5 background shape; results §5: no agent tool, no UI control).
// Oracle: one undo step each with the label; validation is Cutframe's own (provisional codes INVALID_DURATION / INVALID_FPS / INVALID_BACKGROUND, named in tracks.ts).
import { describe, expect, it } from 'vitest';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, fixture, itemOf } from './t03-fixtures';

const labelsOf = (e: ReturnType<typeof createEditor>) => e.bus.undoStack.map(x => x.label);

describe('settings ops — one undo step each, stored value, journal record', () => {
  it('Set duration: stored in ms, 1 entry "Set duration" (source user), journal record, undo restores', () => {
    const e = createEditor(build());
    expect(e.runtime.setSetting('Set duration', { duration: 60000 })).toEqual({ ok: true });
    expect(e.doc.duration).toBe(60000); expect(labelsOf(e)).toEqual(['Set duration']); expect(e.bus.undoStack[0].source).toBe('user');
    expect(e.journal).toHaveLength(1); expect(e.journal[0]).toMatchObject({ label: 'Set duration', source: 'user', items_before: 0, items_after: 0 });
    e.bus.undo(); expect(e.doc.duration).toBe(1000); e.bus.redo(); expect(e.doc.duration).toBe(60000);
  });
  it('Set fps: stored as given, 1 entry "Set fps", undo restores 30', () => {
    const e = createEditor(build());
    expect(e.runtime.setSetting('Set fps', { fps: 24 })).toEqual({ ok: true });
    expect(e.doc.fps).toBe(24); expect(labelsOf(e)).toEqual(['Set fps']); e.bus.undo(); expect(e.doc.fps).toBe(30);
  });
  it.each([['color', '#112233'], ['image', 'asset-img1']])('Set background %s: stored {type, value}, 1 entry "Set background", undo restores the previous background', (type, value) => {
    const e = createEditor(build()); const prev = JSON.stringify(e.doc.background);
    expect(e.runtime.setSetting('Set background', { background: { type, value } })).toEqual({ ok: true });
    expect(e.doc.background).toEqual({ type, value }); expect(labelsOf(e)).toEqual(['Set background']);
    e.bus.undo(); expect(JSON.stringify(e.doc.background)).toBe(prev);
  });
  it('a combined change is still ONE step with the given label', () => {
    const e = createEditor(build());
    e.runtime.setSetting('Set fps', { fps: 25, duration: 5000 });
    expect(e.doc).toMatchObject({ fps: 25, duration: 5000 }); expect(e.bus.undoStack).toHaveLength(1);
  });
  it('with items present the set duration stays; the next item edit re-fits it to the content end (results §5 "re-fitted after every edit")', () => {
    const e = createEditor(fixture()); // content ends at 12 s (v3)
    e.runtime.setSetting('Set duration', { duration: 60000 }); expect(e.doc.duration).toBe(60000);
    e.intent({ type: 'moveItems', itemIds: ['v3'], deltaMs: 1000 } as never);
    expect(e.doc.duration).toBe(Math.max(...e.doc.items.map(i => i.display.to)));
    expect(itemOf(e.doc, 'v3').display.to).toBe(13000);
  });
});

describe('settings ops — invalid values are refused with a code, nothing changes, no entry, no journal record (provisional codes)', () => {
  it.each([
    ['duration 0', 'Set duration', { duration: 0 }, 'INVALID_DURATION'],
    ['duration negative', 'Set duration', { duration: -5 }, 'INVALID_DURATION'],
    ['duration NaN', 'Set duration', { duration: NaN }, 'INVALID_DURATION'],
    ['duration Infinity', 'Set duration', { duration: Infinity }, 'INVALID_DURATION'],
    ['fps 0', 'Set fps', { fps: 0 }, 'INVALID_FPS'],
    ['fps negative', 'Set fps', { fps: -30 }, 'INVALID_FPS'],
    ['fps NaN', 'Set fps', { fps: NaN }, 'INVALID_FPS'],
    ['background wrong type', 'Set background', { background: { type: 'gradient', value: 'x' } }, 'INVALID_BACKGROUND'],
    ['background non-string value', 'Set background', { background: { type: 'color', value: 7 } }, 'INVALID_BACKGROUND'],
    ['background missing', 'Set background', { background: undefined }, 'INVALID_BACKGROUND'],
  ] as const)('%s → %s refused', (_n, label, change, code) => {
    const e = createEditor(build()); const before = JSON.stringify(e.doc);
    const r = e.runtime.setSetting(label, change as never);
    expect(r).toMatchObject({ ok: false, code }); expect(JSON.stringify(e.doc)).toBe(before);
    expect(e.bus.undoStack).toHaveLength(0); expect(e.journal).toHaveLength(0);
  });
  it('setting the value it already has writes no undo entry (content-mode no-op)', () => {
    const e = createEditor(build()); e.runtime.setSetting('Set fps', { fps: 30 });
    expect(e.bus.undoStack).toHaveLength(0);
  });
});
