// SPDX-License-Identifier: AGPL-3.0-only
// T28 row 3, lane A: the preview drag's draft shows what the commit will hold. previewDraft runs the commit's op and the bus's
// settle (timeline/bus.ts) on its draft; the commit is the transformOnPreview intent through the bus.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument, RecordData } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { settle } from '../apps/web/src/timeline/bus';
import { previewDraft } from '../apps/web/src/editor/selection-box';
import type { PreviewEdit } from '../apps/web/src/editor/selection-box';
import { assets, build, links, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeEach(() => useIds()); afterEach(() => { resetIds(); vi.restoreAllMocks(); });
const P = (defaultValue: unknown) => ({ defaultValue, keyframes: [] });
const props = (x: number) => ({ positionX: P(x), positionY: P(100), width: P(200), height: P(200), scale: P(1), rotation: P(0) });
const image = (id: string, from: number, to: number) => mkItem(id, 'V1', from, to, { type: 'image', trim: { from: 0, to: to - from }, properties: props(100) });
const editor = (doc: ProjectDocument) => createEditor(doc, { assets: assets(), links: links() });
const json = (d: unknown) => JSON.stringify(d);
const edits: PreviewEdit[] = [{ itemId: 'a', values: { positionX: 250, positionY: 300 } }];
// Stored duration 6000, content end 4000: the commit sets duration = content end (G-01). The touching pair a | b carries a
// transition that repairTransitions rewrites in place: durationMs 2500 is clamped to 2000 (transitions.ts l.108), trackId 'OLD'
// becomes 'V1' (l.110).
const doc = (locked = false) => build({ tracks: [mkTrack('V1', 'video', { locked })], items: [image('a', 0, 2000), image('b', 2000, 4000)],
  extra: { size: { width: 1080, height: 1920 }, duration: 6000, transitions: [{ id: 'T1', trackId: 'OLD', fromId: 'a', toId: 'b', kind: 'fade', durationMs: 2500, alignment: 0.5 }] } });

describe('T28 row 3: the preview draft equals the commit', () => {
  it('a move over a document with duration 6000 and content end 4000: the draft has duration 4000, as the commit stores', () => {
    const d = previewDraft(doc(), edits, 1000), e = editor(doc());
    expect(d.duration).toBe(4000);
    expect(d.transitions).toEqual([expect.objectContaining({ id: 'T1', trackId: 'V1', durationMs: 2000 })]);
    expect(e.intent({ type: 'transformOnPreview', edits, atMs: 1000 })).toMatchObject({ ok: true });
    expect(e.doc.duration).toBe(4000);
    expect(json(d.items)).toBe(json(e.doc.items)); expect(json(d.transitions)).toBe(json(e.doc.transitions));
  });
  it('the draft leaves the base document untouched, though settle rewrites its transition in place', () => {
    const base = doc(), before = json(base);
    previewDraft(base, edits, 1000); expect(json(base)).toBe(before);
  });
  it('a drag on a locked track: the draft keeps duration 6000 and the stored transition, the commit refuses with TRACK_LOCKED', () => {
    const base = doc(true), before = json(base), d = previewDraft(base, edits, 1000), e = editor(doc(true));
    expect(d.items[0].properties.positionX.defaultValue).toBe(250); expect(d.duration).toBe(6000); expect(json(d.transitions)).toBe(json(base.transitions));
    expect(json(base)).toBe(before);
    expect(e.intent({ type: 'transformOnPreview', edits, atMs: 1000 })).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
    expect(e.doc.duration).toBe(6000); expect(e.bus.undoStack).toHaveLength(0);
  });
  it('an error that is not a refusal is warned about and the plain draft shows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), base = doc();
    base.items[1].details = { name: 'b', handle: () => 0 }; // a function cannot be cloned: structuredClone throws DataCloneError
    const d = previewDraft(base, edits, 1000);
    expect(warn).toHaveBeenCalledOnce(); expect(d.items[0].properties.positionX.defaultValue).toBe(250); expect(d.duration).toBe(6000);
  });
});

describe('T28 row 3: a caption refusal keeps the plain draft', () => {
  // A linked caption whose source is gone, on a locked track: the bus's settle refuses its edit (CAPTION_SOURCE_EDIT_REFUSED).
  const caption = (): RecordData => mkItem('c', 'C1', 0, 4000, { type: 'caption', trim: { from: 0, to: 4000 }, captionSourceItemId: 'gone', metadata: { captionBindingId: 'b1' }, details: { text: 'Hi' }, properties: props(100) });
  const capDoc = () => build({ tracks: [mkTrack('C1', 'caption', { locked: true })], items: [caption()], extra: { size: { width: 1080, height: 1920 }, duration: 6000 } });
  const move: PreviewEdit[] = [{ itemId: 'c', values: { positionX: 250 } }];
  it('the draft is the plain writeEdits draft: the item moved, duration kept, the base untouched, nothing warned', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), base = capDoc(), before = json(base), d = previewDraft(base, move, 1000);
    expect(() => settle(base, structuredClone(d))).toThrow(expect.objectContaining({ code: 'CAPTION_SOURCE_EDIT_REFUSED' }));
    expect(d.items[0].properties.positionX.defaultValue).toBe(250); expect(d.duration).toBe(6000); expect(json(base)).toBe(before);
    expect(warn).not.toHaveBeenCalled();
  });
  it('the commit at release refuses as today: TRACK_LOCKED, no step, the document unchanged', () => {
    const e = editor(capDoc()), before = json(e.doc.items);
    expect(e.intent({ type: 'transformOnPreview', edits: move, atMs: 1000 })).toMatchObject({ ok: false, code: 'TRACK_LOCKED' });
    expect(e.bus.undoStack).toHaveLength(0); expect(json(e.doc.items)).toBe(before);
  });
});
