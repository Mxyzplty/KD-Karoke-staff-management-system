// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 6 / plan A21. Oracle: findings part 2 §31's insert-after table and the pinned step-6 refusal envelope.
// The 8×8 expected table is written out below, never obtained from canInsertAfter/kindOf or a tool under test.
// Real calls go through callTool with our own CommandBus/asset lookup. T08's compiler is loaded, but no browser,
// sandbox, provider, store, source edits or async import is needed for this constant, self-contained graphic code.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canInsertAfter } from '../apps/web/src/timeline/items';
import { CommandBus } from '../apps/web/src/timeline/bus';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext, ToolResult } from '../apps/web/src/timeline/tools';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import { loadCompiler } from '../apps/web/src/mg/tools';
import { findSound } from '../apps/web/src/catalogue/sounds';
import { assets, build, itemOf, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeAll(loadCompiler);
beforeEach(() => useIds()); afterEach(() => resetIds());
const TYPES = ['video', 'image', 'audio', 'caption', 'text', 'shape', 'motionGraphic', 'layout'] as const;
type ItemType = typeof TYPES[number];
// Columns:     video  image  audio  caption text   shape  motionGraphic layout
const EXPECTED: Record<ItemType, readonly boolean[]> = {
  video:        [true,  true,  false, false,  false, false, false,        false],
  image:        [true,  true,  false, false,  false, false, false,        false],
  audio:        [false, false, true,  false,  false, false, false,        false],
  caption:      [false, false, false, true,   false, false, false,        false],
  text:         [false, false, false, false,  true,  true,  true,         true],
  shape:        [false, false, false, false,  true,  true,  true,         true],
  motionGraphic:[false, false, false, false,  true,  true,  true,         true],
  layout:       [false, false, false, false,  true,  true,  true,         true],
};
const TRACK_KIND: Record<ItemType, string> = { video: 'video', image: 'video', audio: 'audio', caption: 'caption', text: 'overlay', shape: 'overlay', motionGraphic: 'overlay', layout: 'overlay' };
const CODE = "export const MatrixGraphic = () => <AbsoluteFill style={{ backgroundColor: '#123456' }} />;";
const FROM = 1000, END = 4000;
const allowed = (inserted: ItemType, reference: ItemType) => EXPECTED[inserted][TYPES.indexOf(reference)];
function reference(type: ItemType): RecordData {
  const details: RecordData = type === 'text' || type === 'caption' ? { text: 'Reference', ...(type === 'caption' ? { words: [] } : {}) }
    : type === 'motionGraphic' ? { code: CODE, name: 'Reference graphic' } : type === 'layout' ? { layoutType: 'split-horizontal', cells: [] }
    : type === 'shape' ? { closed: true, points: [{ anchor: { x: 0, y: 0 } }, { anchor: { x: 100, y: 0 } }, { anchor: { x: 100, y: 80 } }, { anchor: { x: 0, y: 80 } }] } : { name: 'Reference' };
  return mkItem('ref', 'R', FROM, END, { type, details, ...(type === 'shape' ? { metadata: { shapeType: 'rectangle' } } : {}),
    ...(type === 'video' || type === 'audio' || type === 'motionGraphic' ? { trim: { from: 0, to: END - FROM }, sourceDuration: 20000 } : {}) });
}
function world(refType: ItemType) {
  let current = build({ tracks: [mkTrack('R', TRACK_KIND[refType]), mkTrack('KEEP', 'overlay')],
    items: [reference(refType), mkItem('keep', 'KEEP', 0, 15000, { type: 'text', details: { text: 'Unchanged' } })] });
  const journal: unknown[] = [], bus = new CommandBus({ get: () => current, set: doc => { current = doc; } }, { journal: row => { journal.push(row); } });
  const index = new Map(assets().map(asset => [asset.id, asset]));
  for (const id of ['element:sticker-star', 'element:label-tag', 'element:phone-frame']) {
    index.set(id, { ...assets()[2], id: `stored-${id}`, name: `${id}.png`, type: 'image', mimeType: 'image/png' } as Asset);
  }
  const sound = findSound('mouse-click')!;
  index.set('sound:mouse-click', { ...assets()[3], id: 'stored-sound:mouse-click', name: 'mouse-click.wav', durationMs: sound.durationMs } as Asset);
  const ctx: ToolContext = { bus, asset: id => index.get(id) };
  return { ctx, bus, journal, get doc() { return current; } };
}
type World = ReturnType<typeof world>;
type Add = { label: string; inserted: ItemType; tool: string; args: RecordData; lengthMs: number };
const TOOLS: Add[] = [
  { label: 'video asset', inserted: 'video', tool: 'addMedia', args: { assetId: 'asset-vid1', duration: 1 }, lengthMs: 1000 },
  { label: 'image asset', inserted: 'image', tool: 'addMedia', args: { assetId: 'asset-img1', duration: 1 }, lengthMs: 1000 },
  { label: 'audio asset', inserted: 'audio', tool: 'addMedia', args: { assetId: 'asset-aud1', duration: 1 }, lengthMs: 1000 },
  { label: 'text tool', inserted: 'text', tool: 'addText', args: { textContent: 'Matrix text', font: 'Roboto', duration: 1 }, lengthMs: 1000 },
  { label: 'shape tool', inserted: 'shape', tool: 'addShape', args: { shape: 'rectangle', bounds: { x: 10, y: 20, width: 120, height: 80 }, duration: 1 }, lengthMs: 1000 },
  { label: 'motion graphic tool', inserted: 'motionGraphic', tool: 'addMotionGraphic', args: { code: CODE, summary: 'A simple matrix graphic.', width: 120, height: 80, x: 10, y: 20, duration: 1 }, lengthMs: 1000 },
  { label: 'layout tool', inserted: 'layout', tool: 'addLayout', args: { layoutType: 'split-horizontal', duration: 1 }, lengthMs: 1000 },
];
const CATALOGUE: Add[] = [
  { label: 'element:sticker-star', inserted: 'image', tool: 'addMedia', args: { assetId: 'element:sticker-star', duration: 1 }, lengthMs: 1000 },
  { label: 'element:label-tag', inserted: 'text', tool: 'addMedia', args: { assetId: 'element:label-tag', duration: 1 }, lengthMs: 1000 },
  { label: 'element:phone-frame', inserted: 'layout', tool: 'addMedia', args: { assetId: 'element:phone-frame', duration: 1 }, lengthMs: 1000 },
  { label: 'sound:mouse-click', inserted: 'audio', tool: 'addMedia', args: { assetId: 'sound:mouse-click' }, lengthMs: findSound('mouse-click')!.durationMs },
];
function expectUnchanged(w: World, before: string, result: ToolResult) {
  expect(result.success).toBe(false); expect(result).not.toHaveProperty('timelineChanges');
  expect(JSON.stringify(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0); expect(w.bus.redoStack).toHaveLength(0); expect(w.journal).toHaveLength(0);
}
function checkToolPair(add: Add, refType: ItemType) {
  const w = world(refType), before = structuredClone(w.doc), beforeIds = new Set(before.items.map(item => item.id));
  const result = callTool(w.ctx, add.tool, { ...add.args, insertAfterItemId: 'ref' });
  const diagnostic = `${add.label} (${add.inserted}) after ${refType}: expected ${allowed(add.inserted, refType) ? 'compatible' : 'mismatch'}, got ${JSON.stringify(result)}`;
  if (allowed(add.inserted, refType)) {
    expect(result.success, diagnostic).toBe(true);
    const added = w.doc.items.filter(item => !beforeIds.has(item.id)); expect(added, diagnostic).toHaveLength(1);
    expect(added[0], diagnostic).toMatchObject({ type: add.inserted, trackId: 'R', display: { from: END, to: END + add.lengthMs } });
    expect(itemOf(w.doc, 'ref')).toEqual(itemOf(before, 'ref')); expect(itemOf(w.doc, 'keep')).toEqual(itemOf(before, 'keep')); expect(w.doc.tracks).toEqual(before.tracks);
    expect(w.bus.undoStack).toHaveLength(1); expect(w.bus.undoStack[0]).toMatchObject({ label: 'Insert items', source: 'agent' }); expect(w.journal).toHaveLength(1);
    w.bus.undo(); expect(w.doc).toEqual(before);
  } else {
    expect(result, diagnostic).toMatchObject({ success: false, code: 'INSERT_AFTER_TYPE_MISMATCH', error: 'insertAfter type mismatch',
      message: `Cannot insert ${add.inserted} after ${refType} item 'ref'. The new item requires a compatible track kind.` });
    expectUnchanged(w, JSON.stringify(before), result);
  }
}

describe('A21: canInsertAfter, all 64 pairs from the literal §31 table', () => {
  for (const inserted of TYPES) for (const refType of TYPES) it(`${inserted} after ${refType} → ${allowed(inserted, refType)}`, () => {
    expect(canInsertAfter(inserted, reference(refType)), `${inserted} after ${refType}`).toBe(allowed(inserted, refType));
  });
});

describe('A21: legacy text items marked subType caption use the caption column, not the text column', () => {
  it.each(TYPES)('%s after a caption-marked text', inserted => {
    const ref = reference('text'); ref.details.subType = 'caption';
    expect(canInsertAfter(inserted, ref)).toBe(EXPECTED[inserted][3]);
  });
});

describe('A21: real supported add tools against all eight reference types', () => {
  for (const add of TOOLS) for (const refType of TYPES) it(`${add.label} (${add.inserted}) after ${refType}`, () => checkToolPair(add, refType));
  // Inspected captions/tools.ts addCaptionsIn: it targets trackId/speakerTrackIds and has no insertAfterItemId path.
  // Do not manufacture a caption insertion API. The caption row remains fully covered in the pure 64-pair table above.
  // The addCaptions contract has no insertAfterItemId input, so there is no real-tool row to run.
  // C-8: addCaptions has no insert-after path; this pins today's behaviour.
  it('C-8: addCaptions has no insert-after path; this pins today\'s behaviour', () => {
    const w = world('caption'), before = JSON.stringify(w.doc);
    const result = callTool(w.ctx, 'addCaptions', { insertAfterItemId: 'ref' });
    expect(result).toEqual({ success: false, code: 'MISSING_TRACK_ID', error: 'trackId is required',
      message: 'addCaptions needs a target caption trackId (or splitBySpeaker with speakerTrackIds). Create one with manageTrack.' });
    expectUnchanged(w, before, result);
  });
});

describe('T22: catalogue ids use their placed item type, not the source asset image type', () => {
  for (const add of CATALOGUE) for (const refType of TYPES) it(`${add.label} (${add.inserted}) after ${refType}`, () => checkToolPair(add, refType));
});

describe('insertAfterItemId is mutually exclusive with trackId and timelineStart, including timelineStart 0', () => {
  for (const add of [...TOOLS, ...CATALOGUE]) for (const extra of [{ trackId: 'R' }, { timelineStart: 0 }, { trackId: 'R', timelineStart: 0 }]) {
    it(`${add.label} plus ${Object.keys(extra).join('+')}`, () => {
      const refType = TYPES[EXPECTED[add.inserted].indexOf(true)], w = world(refType), before = JSON.stringify(w.doc);
      const result = callTool(w.ctx, add.tool, { ...add.args, insertAfterItemId: 'ref', ...extra });
      expect(result, `${add.label}: ${JSON.stringify(result)}`).toMatchObject({ success: false, code: 'INVALID_COMBINATION' }); expectUnchanged(w, before, result);
    });
  }
});
