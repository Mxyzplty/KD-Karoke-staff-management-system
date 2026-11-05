// SPDX-License-Identifier: AGPL-3.0-only
// T06 render model: what a shape item becomes in the frame plan (render/model.ts itemDraw → Draw.shape) and how the compositor applies its
// alphas. Three cases: Transparent (fillOpacity 0) draws no fill; stroke width 0 or colour 'none' draws no stroke; the item's opacity reaches
// the shape draw once (T06 Q10, P22: fill and stroke alpha × item opacity, not squared as on Xapp's effect path). A shape is built with
// addShape (as tests/t06-shapes.test.ts does), then its stored properties are set on a clone, as a loaded document would hold them.
import { afterEach, describe, expect, it } from 'vitest';
import { composite } from '../apps/web/src/render/compositor';
import { isPending, itemDraw } from '../apps/web/src/render/model';
import type { Draw } from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { build, mkTrack, resetIds, video } from './t03-fixtures';

afterEach(() => resetIds());

const RECT = { shape: 'rectangle', bounds: { x: 100, y: 100, width: 200, height: 100 }, trackId: 'O1', timelineStart: 0, duration: 5 };
/** A rectangle made by addShape with the given style, then the given stored properties set on a clone of the document. */
function plan(style: Record<string, unknown>, stored: Record<string, unknown> = {}): { doc: ProjectDocument; draw: Draw & { shape: NonNullable<Draw['shape']> } } {
  const e = createEditor(build({ tracks: [mkTrack('V1', 'video'), mkTrack('O1', 'overlay')], items: [video('v1', 'V1', 0, 4000)] }));
  const made: any = e.call('addShape', { ...RECT, ...style });
  expect(made.success, JSON.stringify(made)).toBe(true);
  const doc = structuredClone(e.doc), item: any = doc.items.find(i => i.id === made.data.itemId)!;
  for (const [k, v] of Object.entries(stored)) item.properties[k] = { ...item.properties[k], defaultValue: v };
  const draw = itemDraw(doc, item, item.display.from + 1000);
  if (!draw || isPending(draw)) throw new Error(`no draw: ${JSON.stringify(draw)}`);
  expect(draw.kind).toBe('shape'); expect(draw.shape).toBeTruthy();
  return { doc, draw: draw as Draw & { shape: NonNullable<Draw['shape']> } };
}
/** A 2D context that only records the globalAlpha in force at each fill and stroke. */
function recorder() {
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 }, calls: { op: string; alpha: number; style: unknown }[] = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => k in state ? state[k] : (...a: unknown[]) => { if (k === 'fill' || k === 'stroke') calls.push({ op: k, alpha: state.globalAlpha as number, style: state[k === 'fill' ? 'fillStyle' : 'strokeStyle'] }); return a; },
    set: (_t, k, v) => { state[k] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('T06 render model: shape fill and stroke in the frame plan', () => {
  it('Transparent (fillOpacity 0) has no fill and keeps the stroke; the fill colour is kept in the item (Q6)', () => {
    const { draw } = plan({ fillOpacity: 0, strokeColor: '#ff0000', strokeWidth: 4 });
    expect(draw.shape.fill).toBeNull();
    expect(draw.shape.stroke).toStrictEqual({ color: '#ff0000', width: 4, alpha: 1 });
    expect(draw.item.properties.fillColor.defaultValue).toBe('#3b82f6');
    const { ctx, calls } = recorder();
    composite(ctx, [draw], [null], { width: 1920, height: 1080 }, 'clear');
    expect(calls).toStrictEqual([{ op: 'stroke', alpha: 1, style: '#ff0000' }]);        // no fill call at all
  });

  it('stroke width 0, or stroke colour none, has no stroke; the fill is drawn', () => {
    for (const style of [{ strokeColor: '#ff0000', strokeWidth: 0 }, { strokeColor: 'none', strokeWidth: 6 }, {}]) {
      const { draw } = plan(style);
      expect(draw.shape.stroke, JSON.stringify(style)).toBeNull();
      expect(draw.shape.fill, JSON.stringify(style)).toStrictEqual({ color: '#3b82f6', alpha: 1 });
      const { ctx, calls } = recorder();
      composite(ctx, [draw], [null], { width: 1920, height: 1080 }, 'clear');
      expect(calls, JSON.stringify(style)).toStrictEqual([{ op: 'fill', alpha: 1, style: '#3b82f6' }]);
    }
    // The same through a stored document: the colour is set but the width is 0 (a loaded shape), and the other way round.
    expect(plan({ strokeColor: '#00ff00', strokeWidth: 3 }, { strokeWidth: 0 }).draw.shape.stroke).toBeNull();
    expect(plan({ strokeColor: '#00ff00', strokeWidth: 3 }, { strokeColor: 'none' }).draw.shape.stroke).toBeNull();
  });

  it('the item opacity multiplies the fill and stroke alpha once at the compositor (Q10, P22): 0.5 × 0.8 = 0.4 and 0.5 × 0.5 = 0.25, not 0.5 × 0.5 × 0.8', () => {
    const { draw } = plan({ fillOpacity: 0.8, strokeColor: '#112233', strokeWidth: 3, strokeOpacity: 0.5 }, { opacity: 0.5 });
    expect(draw.alpha).toBe(0.5);
    expect(draw.shape.fill).toStrictEqual({ color: '#3b82f6', alpha: 0.8 });            // the plan keeps the two alphas apart …
    expect(draw.shape.stroke).toStrictEqual({ color: '#112233', width: 3, alpha: 0.5 });
    expect(draw.path).toBe('direct');                                                   // … on the direct path (no CSS chain, no effect)
    const { ctx, calls } = recorder();
    composite(ctx, [draw], [null], { width: 1920, height: 1080 }, 'clear');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toStrictEqual({ op: 'fill', alpha: 0.5 * 0.8, style: '#3b82f6' });  // … and the compositor multiplies them with the item opacity once
    expect(calls[1]).toStrictEqual({ op: 'stroke', alpha: 0.5 * 0.5, style: '#112233' });
  });
});
