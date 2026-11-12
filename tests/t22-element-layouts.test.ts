// SPDX-License-Identifier: AGPL-3.0-only
// A13 C-gt: settled from code, RC 6.1, no stored output. Native media-slot inserts use layoutType:'element'.
// These are the existing T07 layout operations, not a fabricated enum preset. Any refusal/throw is a finding, not skipped.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandBus } from '../apps/web/src/timeline/bus';
import { callTool } from '../apps/web/src/timeline/tools';
import type { ToolContext } from '../apps/web/src/timeline/tools';
import { editLayoutCell } from '../apps/web/src/timeline/layouts';
import type { LayoutOp } from '../apps/web/src/timeline/layouts';
import type { Asset, RecordData } from '../apps/web/src/store/model';
import { assets, build, itemOf, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeEach(() => useIds()); afterEach(() => resetIds());
function inserted() {
  let doc = build({ tracks: [mkTrack('O1', 'overlay')], extra: { size: { width: 1080, height: 1920 } } });
  const bus = new CommandBus({ get: () => doc, set: next => { doc = next; } });
  const picture = { ...assets()[2], id: 'phone-picture', type: 'image', name: 'phone.png' } as Asset;
  const lookup = (id: string) => id === 'element:phone-frame' ? picture : assets().find(asset => asset.id === id);
  const ctx: ToolContext = { bus, asset: lookup };
  const result = callTool(ctx, 'addMedia', { assetId: 'element:phone-frame', trackId: 'O1', bounds: { x: 37, y: 83, width: 150, height: 300 } });
  expect(result.success, JSON.stringify(result)).toBe(true); const id = result.data.addedItemIds[0] as string;
  expect(itemOf(doc, id)).toMatchObject({ type: 'layout', details: { layoutType: 'element', gap: 0, borderRadius: 0 } });
  return { ctx, bus, id, lookup, get doc() { return doc; } };
}
const source = { assetId: 'asset-img1', type: 'image', url: 'asset:asset-img1' };
const UI_OPS: { name: string; op: LayoutOp }[] = [
  { name: 'fill image', op: { op: 'fill', index: 0, assetId: 'asset-img1' } }, { name: 'fill video', op: { op: 'fill', index: 0, assetId: 'asset-vid1' } },
  { name: 'clear', op: { op: 'clear', index: 0 } }, { name: 'deleteCell including last', op: { op: 'deleteCell', index: 0 } },
  { name: 'style gap', op: { op: 'style', key: 'gap', value: 12 } }, { name: 'style borderRadius', op: { op: 'style', key: 'borderRadius', value: 7 } },
  { name: 'cell fillMode', op: { op: 'cell', index: 0, key: 'fillMode', value: 'fit' } }, { name: 'cell volume', op: { op: 'cell', index: 0, key: 'volume', value: 80 } },
  { name: 'cell opacity', op: { op: 'cell', index: 0, key: 'opacity', value: 70 } }, { name: 'cell playbackRate', op: { op: 'cell', index: 0, key: 'playbackRate', value: 1.5 } },
  ...([1, 2, 3, 4] as const).map(button => ({ name: `transform ${button}`, op: { op: 'transform' as const, button } })),
];
describe('native element layout supports every existing T07 UI edit operation', () => {
  it.each(UI_OPS)('$name and subsequent agent summary retain layoutType element', ({ op }) => {
    const w = inserted(); if (op.op === 'clear') itemOf(w.doc, w.id).details.cells[0].source = { ...source };
    expect(() => w.bus.run('Edit items', 'user', doc => editLayoutCell(doc, w.id, op, w.lookup))).not.toThrow();
    const item = itemOf(w.doc, w.id); expect(item.details.layoutType).toBe('element');
    if (op.op === 'fill') expect(item.details.cells[0].source.assetId).toBe(op.assetId);
    if (op.op === 'clear') expect(item.details.cells[0].source).toBeNull();
    if (op.op === 'deleteCell') expect(item.details.cells).toHaveLength(0);
    if (op.op === 'style') expect(item.details[op.key]).toBe(op.value);
    if (op.op === 'cell') expect(item.details.cells[0][op.key]).toBe(op.value);
    if (op.op === 'transform' && (op.button === 1 || op.button === 2)) expect(Object.fromEntries(['positionX', 'positionY', 'width', 'height', 'scale'].map(key => [key, item.properties[key].defaultValue])))
      .toEqual({ positionX: 0, positionY: 0, width: 1080, height: 1920, scale: 1 });
    if (op.op === 'transform' && op.button === 3) expect(item.properties.positionX.defaultValue).toBe((1080 - 150) / 2);
    if (op.op === 'transform' && op.button === 4) expect(item.properties.positionY.defaultValue).toBe((1920 - 300) / 2);
    const summary = callTool(w.ctx, 'editLayout', { itemId: w.id }); expect(summary.success, JSON.stringify(summary)).toBe(true); expect(summary.data.layoutType).toBe('element');
  });
});

describe('editLayout, the existing-layout agent tool, accepts native element layouts', () => {
  it.each([
    { name: 'image fill', args: { cells: [{ index: 0, assetId: 'asset-img1' }] } },
    { name: 'video fill with millisecond trim', args: { cells: [{ index: 0, assetId: 'asset-vid1', trim: { from: 100, to: 900 } }] } },
    { name: 'clear', args: { cells: [{ index: 0, assetId: null }] } },
    { name: 'gap/radius', args: { gap: 12, borderRadius: 7 } },
    { name: 'cell mode/volume', args: { cells: [{ index: 0, fillMode: 'fit', volume: 80 }] } },
    { name: 'read-back no-op summary', args: {} },
  ])('$name', ({ args, name }) => {
    const w = inserted(); if (name === 'clear') itemOf(w.doc, w.id).details.cells[0].source = { ...source };
    let result: RecordData | undefined; expect(() => { result = callTool(w.ctx, 'editLayout', { itemId: w.id, ...args }); }).not.toThrow();
    expect(result!.success, JSON.stringify(result)).toBe(true); expect(result!.data).toMatchObject({ itemId: w.id, type: 'layout', layoutType: 'element' });
  });
});
