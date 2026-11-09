// SPDX-License-Identifier: AGPL-3.0-only
// T07 layouts on the command path: editLayoutCell (every UI op, clamps, errors, one undo step each), the agent tools addLayout / editLayout
// (messages, data, every error code, timelineChanges, gating, no-op), the section 40 UI-vs-agent round trip and label parity (tickets T03
// fixture (6), T07 fixtures (1) and (2)).
// Oracles: agent tool results sections 2 addLayout / editLayout, contracts addLayout / editLayout and note 19, part 3 section 46.6.
// Messages are typed out from those files, not read back from the code. Where the results file says "no code" and the Cutframe note adds
// one, the code is pinned as implemented (INSERT_AFTER_*, ITEM_NOT_FOUND, CELL_INDEX_OUT_OF_RANGE, INVALID_CELL_ASSET).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Executor } from '../apps/web/src/agent/executor';
import { SERVED_TOOLS, TIMELINE_GATED } from '../apps/web/src/agent/protocol';
import { exportedMedia } from '../apps/web/src/export/prep';
import { framePlan } from '../apps/web/src/render/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { cellsOf, editLayoutCell, LAYOUT_TYPES, LIMITS } from '../apps/web/src/timeline/layouts';
import type { LayoutOp } from '../apps/web/src/timeline/layouts';
import { TOOLS } from '../apps/web/src/timeline/tools';
import { assets, build, itemOf, links, mkItem, mkTrack, resetIds, useIds, video } from './t03-fixtures';

beforeEach(() => useIds());
afterEach(() => resetIds());

const world = () => build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay'), mkTrack('O2', 'overlay'), mkTrack('OL', 'overlay', { locked: true })],
  items: [video('v1', 'V1', 0, 4000), mkItem('t1', 'O2', 0, 3000, { type: 'text', details: { text: 'x' } })] });
const editor = (doc = world()) => createEditor(doc, { assets: assets(), links: links() });
type Editor = ReturnType<typeof editor>;
const asset = (id: string) => assets().find(a => a.id === id);
const layouts = (e: Editor) => e.doc.items.filter(i => i.type === 'layout');
const fail = (code: string, error: string, extra: object = {}) => ({ success: false, code, error, ...extra });
/** A split-horizontal layout on O1, 2-12 s, made through the tool. */
function made(e = editor(), args: Record<string, unknown> = {}) {
  const r = e.call('addLayout', { layoutType: 'split-horizontal', trackId: 'O1', timelineStart: 2, ...args }) as any;
  expect(r.success, JSON.stringify(r)).toBe(true);
  return { e, id: r.data.itemId as string, r };
}
const edit = (e: Editor, id: string, op: LayoutOp) => e.intent({ type: 'layoutEdit', itemId: id, op });
const cell = (e: Editor, id: string, k: number) => cellsOf(itemOf(e.doc, id))[k];
/** Shrinks the layout box (as the Properties panel would) so the Transform buttons have something to do. */
const shrink = (e: Editor, id: string) => { const p = itemOf(e.doc, id).properties; p.width = { defaultValue: 400, keyframes: [] }; p.height = { defaultValue: 600, keyframes: [] }; p.positionX = { defaultValue: 33, keyframes: [] }; };

describe('T07 editLayoutCell (UI ops, section 46.6): every op, clamps, errors', () => {
  it('1. fill: the cell gets {assetId, type, url} of the stored asset; video and image; other cell fields stay', () => {
    const { e, id } = made();
    expect(edit(e, id, { op: 'fill', index: 0, assetId: 'asset-vid1' })).toEqual({ ok: true });
    expect(cell(e, id, 0).source).toStrictEqual({ assetId: 'asset-vid1', type: 'video', url: 'asset:asset-vid1' });
    edit(e, id, { op: 'fill', index: 1, assetId: 'asset-img1' });
    expect(cell(e, id, 1).source).toStrictEqual({ assetId: 'asset-img1', type: 'image', url: 'asset:asset-img1' });
    expect(cell(e, id, 0)).toMatchObject({ fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 });
    expect(e.labels()).toEqual(['Add items', 'Edit items', 'Edit items']);
  });

  it('2. fill replaces a filled cell\'s media and drops its trim; clear empties a cell and keeps its other fields', () => {
    const { e, id } = made(editor(), { cells: [{ assetId: 'video_1', trim: { from: 1000, to: 4000 }, volume: 80 }] });
    expect(cell(e, id, 0).source!.trim).toEqual({ from: 1000, to: 4000 });
    edit(e, id, { op: 'fill', index: 0, assetId: 'asset-vid2' });
    expect(cell(e, id, 0).source).toStrictEqual({ assetId: 'asset-vid2', type: 'video', url: 'asset:asset-vid2' });
    edit(e, id, { op: 'clear', index: 0 });
    expect(cell(e, id, 0).source).toBeNull(); expect(cell(e, id, 0).volume).toBe(80);
  });

  it('3. deleteCell removes the cell (Cells (n - 1)); the other cells keep their ids; the last cell can go too', () => {
    const { e, id } = made(editor(), { layoutType: 'three-horizontal' });
    const ids = cellsOf(itemOf(e.doc, id)).map(c => c.id);
    edit(e, id, { op: 'deleteCell', index: 1 });
    expect(cellsOf(itemOf(e.doc, id)).map(c => c.id)).toEqual([ids[0], ids[2]]);
    edit(e, id, { op: 'deleteCell', index: 0 }); edit(e, id, { op: 'deleteCell', index: 0 });
    expect(cellsOf(itemOf(e.doc, id))).toEqual([]);
  });

  it('4. style: gap and borderRadius are written to details and clamped to 0-40 (LIMITS)', () => {
    expect(LIMITS.gap).toEqual([0, 40]); expect(LIMITS.borderRadius).toEqual([0, 40]);
    const { e, id } = made();
    for (const [key, v, want] of [['gap', 12, 12], ['gap', 99, 40], ['gap', -5, 0], ['borderRadius', 25, 25], ['borderRadius', 400, 40], ['borderRadius', -1, 0], ['gap', Number.NaN, 0]] as const) {
      edit(e, id, { op: 'style', key, value: v }); expect(itemOf(e.doc, id).details[key], `${key} ${v}`).toBe(want);
    }
  });

  it('5. cell fillMode: "fit" or "fill" (anything else is fill)', () => {
    const { e, id } = made();
    edit(e, id, { op: 'cell', index: 0, key: 'fillMode', value: 'fit' }); expect(cell(e, id, 0).fillMode).toBe('fit');
    edit(e, id, { op: 'cell', index: 0, key: 'fillMode', value: 'stretch' }); expect(cell(e, id, 0).fillMode).toBe('fill');
  });

  it('6. cell volume 0-200 and opacity 0-100 are rounded to integers and clamped; playbackRate 0.1-4 rounded to 0.1', () => {
    const { e, id } = made();
    const set = (key: 'volume' | 'opacity' | 'playbackRate', value: number) => { edit(e, id, { op: 'cell', index: 1, key, value }); return cell(e, id, 1)[key]; };
    expect([set('volume', 150.6), set('volume', 500), set('volume', -3), set('volume', 0)]).toEqual([151, 200, 0, 0]);
    expect([set('opacity', 49.4), set('opacity', 250), set('opacity', -9)]).toEqual([49, 100, 0]);
    expect([set('playbackRate', 1.26), set('playbackRate', 9), set('playbackRate', 0.01), set('playbackRate', 2.05)]).toEqual([1.3, 4, 0.1, 2.1]);
    expect(cell(e, id, 0)).toMatchObject({ volume: 100, opacity: 100, playbackRate: 1 });
  });

  it('7. errors: CELL_INDEX_OUT_OF_RANGE (negative, past the end, fractional), INVALID_CELL_ASSET, INVALID_ASSET_URL, a non-finite value, ITEM_NOT_FOUND, TRACK_LOCKED; nothing written', () => {
    const { e, id } = made(), before = JSON.stringify(e.doc), n = e.bus.undoStack.length;
    const thrown = (op: LayoutOp, itemId = id) => { const d = structuredClone(e.doc); try { editLayoutCell(d, itemId, op, asset); } catch (x: any) { return x.code ?? x.message; } return 'no error'; };
    expect(thrown({ op: 'clear', index: -1 })).toBe('CELL_INDEX_OUT_OF_RANGE'); expect(thrown({ op: 'clear', index: 2 })).toBe('CELL_INDEX_OUT_OF_RANGE');
    expect(thrown({ op: 'fill', index: 0.5, assetId: 'asset-vid1' })).toBe('CELL_INDEX_OUT_OF_RANGE');
    expect(thrown({ op: 'fill', index: 0, assetId: 'asset-aud1' })).toBe('INVALID_CELL_ASSET'); expect(thrown({ op: 'fill', index: 0, assetId: 'missing' })).toBe('INVALID_CELL_ASSET');
    expect(thrown({ op: 'fill', index: 0, assetId: 'asset-nosrc' })).toBe('INVALID_ASSET_URL');
    expect(thrown({ op: 'cell', index: 0, key: 'volume', value: Number.NaN })).toBe('INVALID_PROPERTY_VALUE');
    expect(thrown({ op: 'clear', index: 0 }, 'nope')).toBe('ITEM_NOT_FOUND'); expect(thrown({ op: 'clear', index: 0 }, 'v1')).toBe('ITEM_NOT_FOUND');
    e.doc.tracks.find(t => t.id === 'O1')!.locked = true; expect(thrown({ op: 'clear', index: 0 })).toBe('TRACK_LOCKED');
    e.doc.tracks.find(t => t.id === 'O1')!.locked = false;
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n);
  });

  it('8. every op is one undo entry labelled "Edit items", and one undo restores the stored document exactly', () => {
    const { e, id } = made(editor(), { layoutType: 'grid-2x2', cells: [{ assetId: 'video_1' }] });
    shrink(e, id);                                       // a transform button on the full canvas changes nothing (and adds no entry)
    const ops: LayoutOp[] = [{ op: 'fill', index: 1, assetId: 'asset-img1' }, { op: 'clear', index: 0 }, { op: 'deleteCell', index: 3 }, { op: 'style', key: 'gap', value: 8 },
      { op: 'style', key: 'borderRadius', value: 16 }, { op: 'cell', index: 0, key: 'fillMode', value: 'fit' }, { op: 'cell', index: 0, key: 'volume', value: 30 },
      { op: 'cell', index: 0, key: 'opacity', value: 60 }, { op: 'cell', index: 0, key: 'playbackRate', value: 2 }, { op: 'transform', button: 3 }, { op: 'transform', button: 1 }];
    for (const op of ops) {
      const before = JSON.stringify(e.doc), n = e.bus.undoStack.length;
      edit(e, id, op);
      expect(e.bus.undoStack, JSON.stringify(op)).toHaveLength(n + 1); expect(e.labels().at(-1)).toBe('Edit items');
      expect(JSON.stringify(e.doc), JSON.stringify(op)).not.toBe(before);
      e.bus.undo(); expect(JSON.stringify(e.doc), JSON.stringify(op)).toBe(before); e.bus.redo();
    }
  });

  it('9. transform buttons (section 46.6): 1 and 2 reset to the full canvas at 0, 0, scale 1; 3 centres X; 4 centres Y after the layout was shrunk', () => {
    const { e, id } = made();
    const i = () => itemOf(e.doc, id), p = (k: string) => i().properties[k].defaultValue;
    for (const [k, v] of [['width', 400], ['height', 600], ['positionX', 33], ['positionY', 77], ['scale', 0.5]] as const) i().properties[k] = { defaultValue: v, keyframes: [] };
    edit(e, id, { op: 'transform', button: 3 }); expect(p('positionX')).toBe((1080 - 400 * 0.5) / 2); expect(p('positionY')).toBe(77);
    edit(e, id, { op: 'transform', button: 4 }); expect(p('positionY')).toBe((1920 - 600 * 0.5) / 2);
    for (const button of [1, 2] as const) {
      i().properties.width.defaultValue = 400; i().properties.scale.defaultValue = 0.5; i().properties.positionX.defaultValue = 9;
      edit(e, id, { op: 'transform', button });
      expect([p('positionX'), p('positionY'), p('width'), p('height'), p('scale')]).toEqual([0, 0, 1080, 1920, 1]);
    }
  });

  it('10. a layout edit through the bus does not touch the layout\'s display, track, cell ids or other items', () => {
    const { e, id } = made(), others = JSON.stringify(e.doc.items.filter(i => i.id !== id)), ids = cellsOf(itemOf(e.doc, id)).map(c => c.id), disp = itemOf(e.doc, id).display;
    edit(e, id, { op: 'fill', index: 0, assetId: 'asset-vid1' }); edit(e, id, { op: 'style', key: 'gap', value: 6 });
    expect(JSON.stringify(e.doc.items.filter(i => i.id !== id))).toBe(others); expect(cellsOf(itemOf(e.doc, id)).map(c => c.id)).toEqual(ids); expect(itemOf(e.doc, id).display).toEqual(disp);
  });
});

describe('T07 addLayout (agent tool)', () => {
  it('11. success: message, data, timelineChanges (created layout entry, settings.duration), "Add items"', () => {
    const e = editor(), r = e.call('addLayout', { layoutType: 'grid-2x2', trackId: 'O1', timelineStart: 3, gap: 8, borderRadius: 12 }) as any, id = r.data.itemId;
    expect(r.message).toBe(`Added Grid 2x2 layout '${id}' to track 'O1' at 3s`);
    expect(r.data).toStrictEqual({ itemId: id, trackId: 'O1', type: 'layout', layoutType: 'grid-2x2', cellCount: 4, filledCells: 0, gap: 8, borderRadius: 12, timelinePosition: { start: 3, end: 13 } });
    expect(r.timelineChanges.items).toStrictEqual({ created: [{ itemId: id, type: 'layout', trackId: 'O1', from: 3, to: 13 }], updated: [], deleted: [] });
    expect(r.timelineChanges.settings.changedFields).toEqual(['duration']); expect(r.timelineChanges.settings.after.duration).toBe(13);
    expect(e.labels()).toEqual(['Add items']);
    expect(itemOf(e.doc, id)).toMatchObject({ type: 'layout', trackId: 'O1', display: { from: 3000, to: 13000 }, details: { layoutType: 'grid-2x2', gap: 8, borderRadius: 12 } });
  });

  it('12. every preset gets its label in the message and its cell count in the data; defaults: timelineStart 0, duration 10 s, gap and radius 0 and not stored', () => {
    const labels = ['Split Horizontal', 'Split Vertical', 'Three Horizontal', 'Three Vertical', 'Grid 2x2', 'PiP Top Right', 'PiP Top Left', 'PiP Bottom Right', 'PiP Bottom Left', 'Feature Left', 'Feature Right'];
    const counts = [2, 2, 3, 3, 4, 2, 2, 2, 2, 3, 3];
    LAYOUT_TYPES.forEach((t, k) => {
      const e = editor(), r = e.call('addLayout', { layoutType: t, trackId: 'O1' }) as any;
      expect(r.message, t).toBe(`Added ${labels[k]} layout '${r.data.itemId}' to track 'O1' at 0s`);
      expect(r.data, t).toMatchObject({ layoutType: t, cellCount: counts[k], filledCells: 0, gap: 0, borderRadius: 0, timelinePosition: { start: 0, end: 10 } });
      expect(itemOf(e.doc, r.data.itemId).details).not.toHaveProperty('gap');
    });
  });

  it('13. duration and cells: duration sets the length; cells[] fill by position (assets by agent id), fillMode, volume, trim (video only); filledCells counts them', () => {
    const e = editor(), r = e.call('addLayout', { layoutType: 'split-vertical', trackId: 'O1', timelineStart: 1, duration: 4.5,
      cells: [{ assetId: 'video_1', fillMode: 'fit', volume: 150, trim: { from: 1000, to: 6000 } }, { assetId: 'image_1' }] }) as any;
    expect(r.data).toMatchObject({ filledCells: 2, timelinePosition: { start: 1, end: 5.5 } });
    const cs = cellsOf(itemOf(e.doc, r.data.itemId));
    expect(cs[0]).toMatchObject({ source: { assetId: 'asset-vid1', type: 'video', url: 'asset:asset-vid1', trim: { from: 1000, to: 6000 } }, fillMode: 'fit', volume: 150 });
    expect(cs[1]).toMatchObject({ source: { assetId: 'asset-img1', type: 'image', url: 'asset:asset-img1' }, fillMode: 'fill', volume: 100 });
    // null / missing entries leave a cell empty
    const r2 = e.call('addLayout', { layoutType: 'split-vertical', trackId: 'O2', timelineStart: 5, cells: [null, { assetId: 'video_2' }] }) as any;
    expect(r2.data.filledCells).toBe(1); expect(cellsOf(itemOf(e.doc, r2.data.itemId))[0].source).toBeNull();
  });

  it('14. insertAfterItemId: the layout follows the anchor on its track ("Insert items"); with trackId / timelineStart it is INVALID_COMBINATION', () => {
    const e = editor(), a = e.call('addLayout', { layoutType: 'pip-top-left', trackId: 'O1', timelineStart: 1, duration: 3 }) as any;
    const b = e.call('addLayout', { layoutType: 'feature-left', insertAfterItemId: a.data.itemId }) as any;
    expect(b.success, JSON.stringify(b)).toBe(true); expect(b.data).toMatchObject({ trackId: 'O1', timelinePosition: { start: 4, end: 14 } });
    expect(e.labels()).toEqual(['Add items', 'Insert items']);
    expect(e.call('addLayout', { layoutType: 'feature-left', insertAfterItemId: a.data.itemId, trackId: 'O1' })).toMatchObject({ success: false, code: 'INVALID_COMBINATION',
      error: 'insertAfter cannot be used with trackId. Use insertAfterItemId alone, or trackId with timelineStart.' });
    expect(e.call('addLayout', { layoutType: 'feature-left', insertAfterItemId: a.data.itemId, trackId: 'O1', timelineStart: 1 })).toMatchObject({ code: 'INVALID_COMBINATION',
      error: 'insertAfter cannot be used with trackId, timelineStart. Use insertAfterItemId alone, or trackId with timelineStart.' });
  });

  it('15. failures, first match wins: codes and messages', () => {
    const e = editor(), ok = { layoutType: 'split-horizontal', trackId: 'O1' }, a = e.call('addLayout', { ...ok, timelineStart: 20 }) as any;
    const n = e.bus.undoStack.length, before = JSON.stringify(e.doc), call = (args: object) => e.call('addLayout', args);
    expect(call({ ...ok, layoutType: 'bogus' })).toStrictEqual(fail('INVALID_LAYOUT_TYPE', `Unknown layout type: "bogus". Available: ${LAYOUT_TYPES.join(', ')}`));
    expect(call({ trackId: 'O1' })).toMatchObject({ code: 'INVALID_LAYOUT_TYPE' });
    expect(call({ layoutType: 'split-horizontal' })).toStrictEqual(fail('MISSING_TRACK_ID', 'trackId is required'));
    expect(call({ ...ok, trackId: 'V1' })).toStrictEqual(fail('INVALID_TRACK', "Overlay track 'V1' not found"));
    expect(call({ ...ok, trackId: 'nope' })).toStrictEqual(fail('INVALID_TRACK', "Overlay track 'nope' not found"));
    expect(call({ ...ok, trackId: 'OL' })).toStrictEqual(fail('TRACK_LOCKED', "Track 'OL' is locked"));
    expect(call({ ...ok, timelineStart: -1 })).toMatchObject(fail('INVALID_TIMELINE_START', 'timelineStart must be >= 0. Received: -1s.'));
    expect(call({ ...ok, duration: 0 })).toMatchObject(fail('INVALID_DURATION', 'duration must be positive. Received: 0s.'));
    expect(call({ ...ok, duration: -2 })).toMatchObject({ code: 'INVALID_DURATION' });
    expect(call({ ...ok, gap: -1 })).toMatchObject(fail('INVALID_PROPERTY_VALUE', 'gap must be a number >= 0 (px). Received: -1.'));
    expect(call({ ...ok, borderRadius: 'round' })).toMatchObject(fail('INVALID_PROPERTY_VALUE', 'borderRadius must be a number >= 0 (px). Received: round.'));
    expect(call({ ...ok, cells: 'x' })).toMatchObject(fail('INVALID_TOOL_INPUT', 'cells must be an array'));
    expect(call({ ...ok, cells: [{}, {}, {}] })).toMatchObject(fail('CELL_INDEX_OUT_OF_RANGE', 'Cell index 2 out of range (0-1)'));
    expect(call({ ...ok, cells: [3] })).toMatchObject(fail('INVALID_TOOL_INPUT', 'cells[0] must be an object'));
    expect(call({ ...ok, cells: [{ assetId: 'audio_1' }] })).toMatchObject(fail('INVALID_CELL_ASSET', 'Asset "audio_1" is type "audio" — only video/image can be placed in layout cells.'));
    expect(call({ ...ok, cells: [{}, { assetId: 'nope_9' }] })).toMatchObject(fail('INVALID_CELL_ASSET', 'Asset "nope_9" not found or not a video/image.'));
    expect(call({ ...ok, cells: [{ assetId: 'video_3' }] })).toMatchObject({ code: 'INVALID_ASSET_URL', error: "Asset 'video_3' does not have a valid source URL." });
    expect(call({ ...ok, cells: [{ fillMode: 'stretch' }] })).toMatchObject(fail('INVALID_PROPERTY_VALUE', 'Cell 0 fillMode must be "fill" or "fit". Received: stretch.'));
    expect(call({ ...ok, cells: [{ volume: 201 }] })).toMatchObject(fail('INVALID_PROPERTY_VALUE', 'Cell 0 volume must be from 0 to 200 (%). Received: 201.'));
    expect(call({ ...ok, cells: [{ trim: { from: 0, to: 1000 } }] })).toMatchObject({ code: 'INVALID_COMBINATION', error: 'Cell 0 trim needs media in the cell: give an assetId with it.' });
    expect(call({ ...ok, cells: [{ assetId: 'image_1', trim: { from: 0, to: 1000 } }] })).toMatchObject({ code: 'INVALID_COMBINATION', error: 'Cell 0 trim applies to video cells only.' });
    expect(call({ ...ok, cells: [{ assetId: 'video_1', trim: { from: 500, to: 500 } }] })).toMatchObject({ code: 'INVALID_TRIM_RANGE', error: 'Cell 0 trim.to must be greater than trim.from (ms).' });
    expect(call({ ...ok, cells: [{ assetId: 'video_1', trim: { from: -1, to: 500 } }] })).toMatchObject({ code: 'INVALID_TRIM_RANGE' });
    expect(call({ ...ok, cells: [{ assetId: 'video_1', trim: { from: 0, to: 10001 } }] })).toMatchObject({ code: 'TRIM_EXCEEDS_SOURCE', error: 'Cell 0 trim.to (10001ms) exceeds the source video duration (10000ms).' });
    expect(call({ ...ok, timelineStart: 25 })).toMatchObject({ code: 'TRACK_OVERLAP' });
    expect(call({ ...ok, timelineStart: 25 }).error).toContain(`'${a.data.itemId}'`);
    expect(call({ layoutType: 'split-horizontal', insertAfterItemId: 'nope' })).toStrictEqual(fail('INSERT_AFTER_NOT_FOUND', 'insertAfter item not found', { message: "Item 'nope' not found on the timeline. Read context for current item ids." }));
    expect(call({ layoutType: 'split-horizontal', insertAfterItemId: 'v1' })).toStrictEqual(fail('INSERT_AFTER_TYPE_MISMATCH', 'insertAfter type mismatch', { message: "Cannot insert layout after video item 'v1'. The new item requires a compatible track kind." }));
    // a failure writes nothing: no new entry, no new item, document unchanged
    expect(e.bus.undoStack).toHaveLength(n); expect(JSON.stringify(e.doc)).toBe(before);
  });

  it('16. a layout may follow a text item (insertAfter on a compatible neighbour)', () => {
    const e = editor(), r = e.call('addLayout', { layoutType: 'split-horizontal', insertAfterItemId: 't1' }) as any;
    expect(r.success, JSON.stringify(r)).toBe(true); expect(r.data).toMatchObject({ trackId: 'O2', timelinePosition: { start: 3, end: 13 } });
  });

  it('17. no cell in the request is applied if a later one fails (all cells are checked before the one write)', () => {
    const e = editor(), before = JSON.stringify(e.doc);
    expect(e.call('addLayout', { layoutType: 'split-horizontal', trackId: 'O1', cells: [{ assetId: 'video_1' }, { assetId: 'audio_1' }] })).toMatchObject({ code: 'INVALID_CELL_ASSET' });
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.labels()).toEqual([]);
  });
});

describe('T07 editLayout (agent tool)', () => {
  it('18. success: message, data after the edit, timelineChanges with changedFields, "Edit items"', () => {
    const { e, id } = made(), r = e.call('editLayout', { itemId: id, gap: 6, borderRadius: 9, cells: [{ index: 0, assetId: 'video_1', fillMode: 'fit', volume: 40 }, { index: 1, assetId: 'image_1' }] }) as any;
    expect(r.success).toBe(true); expect(r.message).toBe('Layout updated successfully');
    expect(r.data).toStrictEqual({ itemId: id, type: 'layout', layoutType: 'split-horizontal', cellCount: 2, filledCells: 2, gap: 6, borderRadius: 9 });
    expect(r.timelineChanges.items.created).toEqual([]); expect(r.timelineChanges.items.updated).toHaveLength(1);
    expect(r.timelineChanges.items.updated[0].itemId).toBe(id);
    expect([...r.timelineChanges.items.updated[0].changedFields].sort()).toEqual(['details.borderRadius', 'details.cells', 'details.gap']);
    expect(e.labels()).toEqual(['Add items', 'Edit items']);
    expect(cell(e, id, 0)).toMatchObject({ fillMode: 'fit', volume: 40, source: { assetId: 'asset-vid1', type: 'video', url: 'asset:asset-vid1' } });
  });

  it('19. assetId null empties a cell; trim without assetId applies to the media already in the cell; a new assetId drops the old trim', () => {
    const { e, id } = made(editor(), { cells: [{ assetId: 'video_1' }, { assetId: 'image_1' }] });
    e.call('editLayout', { itemId: id, cells: [{ index: 0, trim: { from: 2000, to: 7000 } }] });
    expect(cell(e, id, 0).source).toStrictEqual({ assetId: 'asset-vid1', type: 'video', url: 'asset:asset-vid1', trim: { from: 2000, to: 7000 } });
    e.call('editLayout', { itemId: id, cells: [{ index: 0, assetId: 'video_2' }] });
    expect(cell(e, id, 0).source).toStrictEqual({ assetId: 'asset-vid2', type: 'video', url: 'asset:asset-vid2' });
    e.call('editLayout', { itemId: id, cells: [{ index: 1, assetId: null }] }); expect(cell(e, id, 1).source).toBeNull();
    expect((e.call('editLayout', { itemId: id }) as any).data.filledCells).toBe(1);
  });

  it('20. trim on the cell\'s existing media is checked against that asset (TRIM_EXCEEDS_SOURCE) and against its type', () => {
    const { e, id } = made(editor(), { cells: [{ assetId: 'video_2' }, { assetId: 'image_1' }] });
    expect(e.call('editLayout', { itemId: id, cells: [{ index: 0, trim: { from: 0, to: 6001 } }] })).toMatchObject({ code: 'TRIM_EXCEEDS_SOURCE', error: 'Cell 0 trim.to (6001ms) exceeds the source video duration (6000ms).' });
    expect(e.call('editLayout', { itemId: id, cells: [{ index: 1, trim: { from: 0, to: 100 } }] })).toMatchObject({ code: 'INVALID_COMBINATION', error: 'Cell 1 trim applies to video cells only.' });
    expect((e.call('editLayout', { itemId: id, cells: [{ index: 0, trim: { from: 0, to: 6000 } }] }) as any).success).toBe(true);
  });

  it('21. failures: ITEM_NOT_FOUND (missing id, non-layout), TRACK_LOCKED, CELL_INDEX_OUT_OF_RANGE, INVALID_CELL_ASSET, value checks; nothing written, no entry', () => {
    const { e, id } = made(), n = e.bus.undoStack.length, before = JSON.stringify(e.doc), call = (args: object) => e.call('editLayout', args);
    expect(call({ itemId: 'nope' })).toStrictEqual(fail('ITEM_NOT_FOUND', 'Layout item not found: "nope". Use the persistent item ID from context().'));
    expect(call({ itemId: 'v1' })).toStrictEqual(fail('ITEM_NOT_FOUND', 'Layout item not found: "v1". Use the persistent item ID from context().'));
    expect(call({})).toMatchObject({ code: 'ITEM_NOT_FOUND' });
    expect(call({ itemId: id, cells: [{ index: 2 }] })).toStrictEqual(fail('CELL_INDEX_OUT_OF_RANGE', 'Cell index 2 out of range (0-1)'));
    expect(call({ itemId: id, cells: [{ index: -1 }] })).toMatchObject({ code: 'CELL_INDEX_OUT_OF_RANGE' });
    expect(call({ itemId: id, cells: [{}] })).toMatchObject({ code: 'CELL_INDEX_OUT_OF_RANGE' });
    expect(call({ itemId: id, cells: [{ index: 0, assetId: 'audio_1' }] })).toStrictEqual(fail('INVALID_CELL_ASSET', 'Asset "audio_1" is type "audio" — only video/image can be placed in layout cells.'));
    expect(call({ itemId: id, cells: [{ index: 0, assetId: 'zzz_1' }] })).toStrictEqual(fail('INVALID_CELL_ASSET', 'Asset "zzz_1" not found or not a video/image.'));
    expect(call({ itemId: id, cells: [{ index: 0, assetId: 'video_3' }] })).toMatchObject({ code: 'INVALID_ASSET_URL' });
    expect(call({ itemId: id, gap: 'x' })).toMatchObject({ code: 'INVALID_PROPERTY_VALUE', error: 'gap must be a number >= 0 (px). Received: x.' });
    expect(call({ itemId: id, cells: [{ index: 0, volume: -1 }] })).toMatchObject({ code: 'INVALID_PROPERTY_VALUE' });
    expect(call({ itemId: id, cells: 'x' })).toMatchObject({ code: 'INVALID_TOOL_INPUT' });
    expect(call({ itemId: id, cells: ['a'] })).toMatchObject({ code: 'INVALID_TOOL_INPUT', error: 'cells[0] must be an object with an index' });
    // a bad second cell leaves the first unapplied
    expect(call({ itemId: id, gap: 5, cells: [{ index: 0, assetId: 'video_1' }, { index: 1, assetId: 'audio_1' }] })).toMatchObject({ code: 'INVALID_CELL_ASSET' });
    expect(JSON.stringify(e.doc)).toBe(before); expect(e.bus.undoStack).toHaveLength(n);
    e.doc.tracks.find(t => t.id === 'O1')!.locked = true; expect(call({ itemId: id, gap: 1 })).toStrictEqual(fail('TRACK_LOCKED', "Track 'O1' is locked"));
  });

  it('22. a call that changes nothing returns the success without timelineChanges and adds no undo entry (same gap, same fillMode, same asset)', () => {
    const { e, id } = made(editor(), { gap: 4, cells: [{ assetId: 'video_1', fillMode: 'fit' }] }), n = e.bus.undoStack.length, j = e.journal.length;
    for (const args of [{ itemId: id }, { itemId: id, gap: 4 }, { itemId: id, cells: [{ index: 0, fillMode: 'fit' }] }, { itemId: id, cells: [{ index: 0, assetId: 'video_1' }] }]) {
      const r = e.call('editLayout', args) as any;
      expect(r.success, JSON.stringify(args)).toBe(true); expect(r.message).toBe('Layout updated successfully'); expect(r).not.toHaveProperty('timelineChanges');
    }
    expect(e.bus.undoStack).toHaveLength(n); expect(e.labels()).toEqual(['Add items']); expect(e.journal.length).toBe(j);
  });

  it('23. one undo step reverts a multi-field editLayout', () => {
    const { e, id } = made(), before = JSON.stringify(e.doc);
    e.call('editLayout', { itemId: id, gap: 6, borderRadius: 9, cells: [{ index: 0, assetId: 'video_1' }, { index: 1, assetId: 'image_1', fillMode: 'fit' }] });
    expect(JSON.stringify(e.doc)).not.toBe(before); e.bus.undo(); expect(JSON.stringify(e.doc)).toBe(before);
  });
});

describe('T07 gating and registration', () => {
  // T12 (C8 assertion-only edit): + createMask, editMaskProperties, removeMask, writeMaskPoints (30 -> 34), then viewMaskFrame, previewSmartMask, trackSmartMask, removeBackground (34 -> 38).
  // T21: + getHelpSection and searchHelpDocs = 40.
  it('24. addLayout is in TIMELINE_GATED, editLayout is not; both are served (40 tools); both are in the tool table', () => {
    expect(TIMELINE_GATED.has('addLayout')).toBe(true); expect(TIMELINE_GATED.has('editLayout')).toBe(false);
    expect(SERVED_TOOLS).toHaveLength(40); expect(SERVED_TOOLS).toContain('addLayout'); expect(SERVED_TOOLS).toContain('editLayout'); // T05 (C8): + addText; T21: + getHelpSection, searchHelpDocs
    expect(Object.keys(TOOLS)).toEqual(expect.arrayContaining(['addLayout', 'editLayout']));
  });

  it('25. the executor refuses addLayout with STALE_READ_REFRESHED after a user edit since the session\'s read, applies nothing; editLayout is not gated', async () => {
    const store = new Map<string, string>(), e = editor();
    const ex = new Executor({ storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } }, current: () => e.runtime, ui: () => ({ selection: [], playheadMs: 0 }) });
    let seq = 0;
    const run = (toolName: string, input: Record<string, unknown> = {}) => ex.execute({ type: 'call', callId: `c${++seq}`, executionKey: `mcp:c:c${seq}`, toolName, input, session: 's' }) as Promise<any>;
    const { id } = made(e);
    await run('context');
    e.intent({ type: 'deleteItems', itemIds: ['t1'], ripple: false });
    const stale = await run('addLayout', { layoutType: 'grid-2x2', trackId: 'O2', timelineStart: 20 });
    expect(stale).toMatchObject({ success: false, code: 'STALE_READ_REFRESHED', scope: 'timeline' }); expect(layouts(e)).toHaveLength(1);
    const ok = await run('addLayout', { layoutType: 'grid-2x2', trackId: 'O2', timelineStart: 20 });
    expect(ok.success, JSON.stringify(ok)).toBe(true); expect(layouts(e)).toHaveLength(2);
    e.intent({ type: 'deleteItems', itemIds: ['v1'], ripple: false });
    const edited = await run('editLayout', { itemId: id, gap: 7 });
    expect(edited.success, JSON.stringify(edited)).toBe(true); expect(itemOf(e.doc, id).details.gap).toBe(7);
  });
});

describe('T07 UI-vs-agent round trip (section 40) and label parity (T03 fixture 6)', () => {
  const state = (e: Editor, id: string) => JSON.stringify({ item: itemOf(e.doc, id), tracks: e.doc.tracks, duration: e.doc.duration }).replace(/"id":"[A-Za-z0-9_-]{21}"/g, '"id":"CELL"');
  it('26. the same cell fill, clear, style and cell edits through the UI intent and through editLayout store the identical item', () => {
    const a = made(), b = made(), ids = [a.id, b.id];
    expect(state(a.e, a.id).replaceAll(a.id, 'X')).toBe(state(b.e, b.id).replaceAll(b.id, 'X'));
    const steps: [LayoutOp[], Record<string, unknown>][] = [
      [[{ op: 'fill', index: 0, assetId: 'asset-vid1' }], { cells: [{ index: 0, assetId: 'video_1' }] }],
      [[{ op: 'fill', index: 1, assetId: 'asset-img1' }], { cells: [{ index: 1, assetId: 'image_1' }] }],
      [[{ op: 'style', key: 'gap', value: 12 }, { op: 'style', key: 'borderRadius', value: 20 }], { gap: 12, borderRadius: 20 }],
      [[{ op: 'cell', index: 0, key: 'fillMode', value: 'fit' }, { op: 'cell', index: 0, key: 'volume', value: 35 }], { cells: [{ index: 0, fillMode: 'fit', volume: 35 }] }],
      [[{ op: 'clear', index: 1 }], { cells: [{ index: 1, assetId: null }] }],
    ];
    for (const [ops, args] of steps) {
      for (const op of ops) edit(a.e, a.id, op);
      expect((b.e.call('editLayout', { itemId: b.id, ...args }) as any).success).toBe(true);
      expect(state(a.e, a.id).replaceAll(ids[0], 'X'), JSON.stringify(args)).toBe(state(b.e, b.id).replaceAll(ids[1], 'X'));
    }
  });

  it('27. the tile (UI addLayout) and the tool on a new overlay track store the same item shape for the same type, start 0, 10 s', () => {
    const ui = editor(); ui.intent({ type: 'addLayout', layoutType: 'feature-right' });
    const tl = editor(), r = tl.call('addLayout', { layoutType: 'feature-right', trackId: 'O1', timelineStart: 0 }) as any;
    const norm = (i: any) => JSON.stringify({ ...i, id: 'X', trackId: 'T', details: { ...i.details, cells: i.details.cells.map((c: any) => ({ ...c, id: 'C' })) } });
    expect(norm(layouts(ui)[0])).toBe(norm(itemOf(tl.doc, r.data.itemId)));
  });

  it('28. label parity: tile = 1 "Add items"; a cell fill, clear, delete, style or transform = 1 "Edit items"; the tool add = "Add items", the tool edit = "Edit items"; undo count equals entry count', () => {
    const e = editor(); e.intent({ type: 'addLayout', layoutType: 'grid-2x2' });
    const id = layouts(e)[0].id; shrink(e, id);
    for (const op of [{ op: 'fill', index: 0, assetId: 'asset-vid1' }, { op: 'clear', index: 0 }, { op: 'deleteCell', index: 3 }, { op: 'style', key: 'gap', value: 3 }, { op: 'transform', button: 1 }] as LayoutOp[]) edit(e, id, op);
    expect(e.labels()).toEqual(['Add items', 'Edit items', 'Edit items', 'Edit items', 'Edit items', 'Edit items']);
    const t = editor(); const { id: tid } = made(t); t.call('editLayout', { itemId: tid, gap: 3 });
    expect(t.labels()).toEqual(['Add items', 'Edit items']);
    for (let k = 0; k < 6; k++) e.bus.undo();
    expect(e.doc.items.filter(i => i.type === 'layout')).toHaveLength(0);
  });

  it('29. a UI tile on a timeline with video: only the new overlay track and layout are added; existing tracks and items are untouched', () => {
    const e = editor(), before = JSON.stringify(e.doc.items);
    e.intent({ type: 'addLayout', layoutType: 'split-vertical' });
    expect(JSON.stringify(e.doc.items.filter(i => i.type !== 'layout'))).toBe(before);
    const l = layouts(e)[0]; expect(e.doc.tracks.find(t => t.id === l.trackId)!.kind).toBe('overlay'); expect(e.doc.tracks).toHaveLength(5);
  });
});

describe('T07 cells reach render and export (withCellItems, exportedMedia, frame plan)', () => {
  it('30. a cell filled through the tool appears in exportedMedia and, at a time inside the layout, as a media draw in the frame plan (no pending)', () => {
    const { e, id } = made(editor(), { timelineStart: 0, cells: [{ assetId: 'video_1' }, { assetId: 'image_1' }] });
    const cellMedia = () => exportedMedia(e.doc).filter(i => i.metadata?.layoutId === id);
    expect(cellMedia().map(i => [i.type, i.metadata!.assetId, i.metadata!.cellIndex])).toEqual([['video', 'asset-vid1', 0], ['image', 'asset-img1', 1]]);
    const plan = framePlan(e.doc, 1000);
    expect(plan.pending.filter(p => p.itemId === id || String(p.itemId).startsWith(`${id}/`))).toEqual([]);   // the text item t1 is T05's pending, not the layout's
    const l = plan.draws.find(d => d.item.id === id)!; expect(l.kind).toBe('layout'); expect(l.layout!.cells.map(c => c.media?.draw.kind)).toEqual(['video', 'image']);
    edit(e, id, { op: 'clear', index: 0 }); expect(cellMedia().map(i => i.type)).toEqual(['image']);
  });
});
