// SPDX-License-Identifier: AGPL-3.0-only
// T12 masks, the pure part (findings part 5 §54: §54.5 opacity/invert, §54.6 combining, §54.8 keyframes). No canvas: the
// alpha algebra (combineInto/layerValue), raster placement/frame-hold/range (model.ts), frameMasks filtering, createMask's
// canvas-to-item-local coordinate math (C1), and the raster file format round trip (raster.ts). The browser-only parts
// (T1-T7b, T9 lone-mask combine through a real path, T11, T12) are tests/ui/t12-render.spec.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { clampMask, combineInto, frameIndex, frameMasks, layerValue, MASK_RANGE, placement, resample } from '../apps/web/src/masks/model';
import type { FrameMask, MaskMode, RasterRef, StoredMask } from '../apps/web/src/masks/model';
import { deflate, RASTER_LIMITS, RasterWriter, rasterPlane, readyRaster, useRasterStore } from '../apps/web/src/masks/raster';
import type { RasterStore } from '../apps/web/src/masks/raster';
import { build, mkTrack, resetIds, video } from './t03-fixtures';
import { createEditor } from '../apps/web/src/timeline/harness';
import { offsetPlane } from '../apps/web/src/masks/model';
import { framePlan } from '../apps/web/src/render/model';
import { pathString } from '../apps/web/src/timeline/shapes';
import type { PathPoint } from '../apps/web/src/timeline/shapes';

afterEach(() => resetIds());

// ---- §54.5 / §54.6 5.2: the alpha algebra on 8-bit planes. One pixel is enough; layerValue/combineInto are per-pixel.
const g1 = (v: number) => Uint8ClampedArray.of(v);
const fm = (mode: MaskMode, over: Partial<Pick<FrameMask, 'inverted' | 'opacity'>> = {}): Pick<FrameMask, 'inverted' | 'opacity' | 'mode'> => ({ mode, inverted: false, opacity: 1, ...over });
const b = (mode: MaskMode, v: number, over: Partial<Pick<FrameMask, 'inverted' | 'opacity'>> = {}) => { const out = new Uint8ClampedArray(1); layerValue(g1(v), fm(mode, over), out); return out[0]; };

describe('T12 alpha algebra (§54.5, §54.6 5.2): layerValue and combineInto on 8-bit planes', () => {
  it('T9: a lone add/intersect/difference mask is a lone add (255 inside, 0 outside); a lone subtract is a hole (0 inside, 255 outside)', () => {
    // "Lone" = no combineInto call: acc is the first mask's b directly (render.ts combinedPlane: acc ?? b.slice()).
    for (const mode of ['add', 'intersect', 'difference'] as const) { expect(b(mode, 255)).toBe(255); expect(b(mode, 0)).toBe(0); }
    expect(b('subtract', 255)).toBe(0); expect(b('subtract', 0)).toBe(255);
  });
  it('T9b: subtract, inverted, opacity 60: inside 255, outside 102', () => {
    expect(b('subtract', 255, { inverted: true, opacity: 0.6 })).toBe(255);
    expect(b('subtract', 0, { inverted: true, opacity: 0.6 })).toBe(102);
  });
  it('T10: add, opacity 37: inside 94, outside 0', () => {
    expect(b('add', 255, { opacity: 0.37 })).toBe(94);
    expect(b('add', 0, { opacity: 0.37 })).toBe(0);
  });
  it('T8: two full-box masks, A add opacity 60 (acc = A\'s b, first-mask rule), B at opacity 50 in each mode: inside both / inside A only', () => {
    const accOf = () => { const out = new Uint8ClampedArray(1); layerValue(g1(255), fm('add', { opacity: 0.6 }), out); return out; };
    const combined = (mode: MaskMode, insideB: boolean) => {
      const acc = accOf(), bb = new Uint8ClampedArray(1);
      layerValue(g1(insideB ? 255 : 0), fm(mode, { opacity: 0.5 }), bb);
      combineInto(acc, bb, mode);
      return acc[0];
    };
    expect([combined('add', true), combined('add', false)]).toEqual([204, 153]);
    expect([combined('subtract', true), combined('subtract', false)]).toEqual([76, 153]);
    expect([combined('intersect', true), combined('intersect', false)]).toEqual([77, 0]);
    expect([combined('difference', true), combined('difference', false)]).toEqual([127, 153]);
  });
});

// ---- §54.6 5.1: which masks take part, and in what order.
const rec = (o: Partial<StoredMask> & Pick<StoredMask, 'id' | 'order'>): StoredMask =>
  ({ name: o.id, enabled: true, points: [{ anchor: { x: 0, y: 0 } }, { anchor: { x: 10, y: 0 } }, { anchor: { x: 10, y: 10 } }], closed: true, mode: 'add', colorIndex: 0,
    feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape', ...o });
const withMasks = (masks: StoredMask[]) => {
  // sourceDuration 1,000,000 ms: well past anything these tests probe, so sourceTime's clamp never interferes.
  const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 4000, 0, 1_000_000, { masks })] });
  return doc.items[0];
};
describe('T12 frameMasks (§54.6 5.1): enabled/order filtering, the first mask after filtering, range dropping', () => {
  it('sorts enabled masks by order ascending and drops disabled ones, regardless of their position in the stored array', () => {
    const item = withMasks([rec({ id: 'c', order: 2 }), rec({ id: 'a', order: 0 }), rec({ id: 'skip', order: 1, enabled: false }), rec({ id: 'b', order: 1 })]);
    expect(frameMasks(item, 0).map(m => m.id)).toEqual(['a', 'b', 'c']);
  });
  it('R5: a raster mask outside [sourceStartUs, sourceEndUs) is dropped, as if absent', () => {
    const raster: RasterRef = { file: 'f1', sourceStartUs: 0, sourceEndUs: 30_000_000, frameCount: 1, width: 2, height: 2, space: { kind: 'item', width: 2, height: 2 }, version: 1 };
    const item = withMasks([rec({ id: 'r', order: 0, raster, points: [], closed: false })]);
    expect(frameMasks(item, 30_000)).toEqual([]); // local 30,000 ms -> source 30,000,000 us === sourceEndUs: dropped
    expect(frameMasks(item, 29_999)).toHaveLength(1); // local 29,999 ms -> source 29,999,000 us: 1 ms inside the range, kept
  });
  it('opacity is clamped to 0…1 at the point of use, even when the stored value is out of the editor\'s own 0–100 range', () => {
    const item = withMasks([rec({ id: 'a', order: 0, opacity: 150 })]);
    expect(frameMasks(item, 0)[0].opacity).toBe(1);
    item.masks[0].opacity = -30;
    expect(frameMasks(item, 0)[0].opacity).toBe(0);
  });
  it('a negative feather is passed through unclamped (§54.4: "a negative feather means off" is the render\'s job, not the model\'s)', () => {
    const item = withMasks([rec({ id: 'a', order: 0, feather: -5 })]);
    expect(frameMasks(item, 0)[0].feather).toBe(-5);
  });
  it('expansion overshoot (beyond the editor\'s -50…50) passes through unclamped', () => {
    const item = withMasks([rec({ id: 'a', order: 0, expansion: 1000 })]);
    expect(frameMasks(item, 0)[0].expansion).toBe(1000);
  });
});

// ---- §54.8 7.2/7.3: path and property keyframes, through frameMasks' clocks.
describe('T12 path and property keyframes (§54.8)', () => {
  const SQUARE = [{ anchor: { x: 150, y: 150 } }, { anchor: { x: 250, y: 150 } }, { anchor: { x: 250, y: 250 } }, { anchor: { x: 150, y: 250 } }];
  const shiftedX = (pts: typeof SQUARE, dx: number) => pts.map(p => ({ anchor: { x: p.anchor.x + dx, y: p.anchor.y } }));
  it('K1: path keyframes at 0 and 1000 ms, linear, B = the square +100 px in x, same point count: t = 250 ms lerps to x 175-275', () => {
    const item = withMasks([rec({ id: 'a', order: 0, points: SQUARE, keyframes: { path: { keyframes: [
      { id: 'k0', time: 0, value: '', points: SQUARE, closed: true, easing: 'linear' },
      { id: 'k1', time: 1000, value: '', points: shiftedX(SQUARE, 100), closed: true, easing: 'linear' },
    ] } } })]);
    const path = frameMasks(item, 250)[0].path!;
    expect(path!.points.map(p => p.anchor.x)).toEqual([175, 275, 275, 175]);
  });
  it('K2: keyframes 0 and 40 ms apart (gap ≤ 50): t = 15 → A; t = 20 → A (tie goes to A); t = 25 → B', () => {
    const A = SQUARE, B = shiftedX(SQUARE, 100);
    const item = withMasks([rec({ id: 'a', order: 0, points: A, keyframes: { path: { keyframes: [
      { id: 'k0', time: 0, value: '', points: A, closed: true, easing: 'linear' }, { id: 'k1', time: 40, value: '', points: B, closed: true, easing: 'linear' },
    ] } } })]);
    const xAt = (local: number) => frameMasks(item, local)[0].path!.points[0].anchor.x;
    expect(xAt(15)).toBe(150); expect(xAt(20)).toBe(150); expect(xAt(25)).toBe(250);
  });
  it('K3: A has 4 points, B has 5 (different counts): hard switch at e ≥ 0.5 — t = 499 → A, t = 500 → B', () => {
    const A = SQUARE, B = [...SQUARE, { anchor: { x: 200, y: 200 } }];
    const item = withMasks([rec({ id: 'a', order: 0, points: A, keyframes: { path: { keyframes: [
      { id: 'k0', time: 0, value: '', points: A, closed: true, easing: 'linear' }, { id: 'k1', time: 1000, value: '', points: B, closed: true, easing: 'linear' },
    ] } } })]);
    expect(frameMasks(item, 499)[0].path!.points).toHaveLength(4);
    expect(frameMasks(item, 500)[0].path!.points).toHaveLength(5);
  });
  it('K4: feather keyframes 0 → 50 over 0-1000 ms, linear: t = 500 → 25', () => {
    const item = withMasks([rec({ id: 'a', order: 0, feather: 0, keyframes: { feather: { keyframes: [{ id: 'k0', time: 0, value: 0, easing: 'linear' }, { id: 'k1', time: 1000, value: 50, easing: 'linear' }] } } })]);
    expect(frameMasks(item, 500)[0].feather).toBe(25);
  });
  it('K5: trim.from 1000, display.from 5000, rate 2: frame time 6000 ms on the timeline → property time 3000 ms (feather keyframe read at that time)', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 5000, 9000, 1000, 8000, { playbackRate: 2,
      masks: [rec({ id: 'a', order: 0, keyframes: { feather: { keyframes: [{ id: 'k0', time: 3000, value: 7, easing: 'linear' }, { id: 'k1', time: 5000, value: 99, easing: 'linear' }] } } })] })] });
    const item = doc.items[0];
    expect(frameMasks(item, 6000 - item.display.from)[0].feather).toBe(7); // local = 1000 ms; property time = 1000 + 1000*2 = 3000 ms, exactly on k0
  });
});

// ---- C1 (§54.2 1.1): createMask's canvas-px → item-local-px conversion, through the real tool (itemFrames' inverse box matrix).
describe('T12 createMask coordinates (§54.11 C1)', () => {
  it('item at positionX 100, positionY 50, box 400×400, scale 0.5, rotation 0: canvas (200,150) → item-local (200,200); canvas (250,150) → item-local (300,200)', () => {
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 4000, 0, 4000)] });
    const item = doc.items[0];
    item.properties = { positionX: { defaultValue: 100, keyframes: [] }, positionY: { defaultValue: 50, keyframes: [] },
      width: { defaultValue: 400, keyframes: [] }, height: { defaultValue: 400, keyframes: [] }, scale: { defaultValue: 0.5, keyframes: [] }, rotation: { defaultValue: 0, keyframes: [] } };
    const e = createEditor(doc);
    const r: any = e.call('createMask', { itemId: 'v1', timelineSeconds: 0, points: [{ anchor: { x: 200, y: 150 } }, { anchor: { x: 250, y: 150 } }, { anchor: { x: 250, y: 250 } }] });
    expect(r.success, JSON.stringify(r)).toBe(true);
    const mask = e.doc.items.find(i => i.id === 'v1')!.masks[0];
    expect([mask.points[0].anchor.x, mask.points[0].anchor.y]).toEqual([200, 200]);
    expect([mask.points[1].anchor.x, mask.points[1].anchor.y]).toEqual([300, 200]);
  });
});

// ---- §54.6 5.3: raster placement, the frame hold, and model.ts's own clamp.
describe('T12 raster placement and frame hold (§54.6 5.3, §54.11 R1-R4)', () => {
  const ITEM = { width: 2, height: 2 };
  it('R1: raster 1280×534, space source 1280×534, item box 1280×534 → identity', () => {
    const p = placement({ width: 1280, height: 534, space: { kind: 'source', width: 1280, height: 534 } }, 1280, 534);
    expect(p).toEqual({ sx: 1, sy: 1, ox: 0, oy: 0 });
  });
  it('R2: the same raster, item box 1080×1920 → s = 1920/534, scale on both axes, offset (-1761.124, 0) (sides cropped)', () => {
    const p = placement({ width: 1280, height: 534, space: { kind: 'source', width: 1280, height: 534 } }, 1080, 1920);
    const s = 1920 / 534;
    expect(p.sx).toBeCloseTo(s, 9); expect(p.sy).toBeCloseTo(s, 9);
    expect(p.ox).toBeCloseTo(-1761.123595505618, 6); expect(p.oy).toBeCloseTo(0, 9);
  });
  it('R3: raster 640×267, space source 1280×534, item box 1280×534 → scale 2 both axes', () => {
    const p = placement({ width: 640, height: 267, space: { kind: 'source', width: 1280, height: 534 } }, 1280, 534);
    expect(p).toEqual({ sx: 2, sy: 2, ox: 0, oy: 0 });
  });
  it('"item" space stretches the raster to the item box regardless of its own size', () => {
    const p = placement({ width: 100, height: 50, space: { kind: 'item', width: 100, height: 50 } }, 400, 400);
    expect(p).toEqual({ sx: 4, sy: 8, ox: 0, oy: 0 });
  });
  it('R4: frames at 0, 41708, 83417 µs (hold, last frame ≤ t): source time 60,000 µs → frame at 41708; 41,707 µs → frame at 0', () => {
    const times = [0, 41708, 83417];
    expect(times[frameIndex(times, 60_000)]).toBe(41708);
    expect(times[frameIndex(times, 41_707)]).toBe(0);
    expect(times[frameIndex(times, 0)]).toBe(0); // clamped to the first frame
  });
  it('MASK_RANGE / clampMask: feather 0-50, expansion -50-50, opacity 0-100', () => {
    expect(MASK_RANGE).toEqual({ feather: { min: 0, max: 50 }, expansion: { min: -50, max: 50 }, opacity: { min: 0, max: 100 } });
    expect(clampMask('feather', -5)).toBe(0); expect(clampMask('feather', 999)).toBe(50);
    expect(clampMask('expansion', -999)).toBe(-50); expect(clampMask('expansion', 999)).toBe(50);
    expect(clampMask('opacity', -1)).toBe(0); expect(clampMask('opacity', 101)).toBe(100);
  });
  it('resample identity: when the raster already fills the buffer 1:1, the plane is copied unchanged', () => {
    const plane = new Uint8Array([10, 20, 30, 40]);
    const out = resample(plane, { width: 2, height: 2, space: { kind: 'item', width: 2, height: 2 } }, 2, 2);
    expect([...out]).toEqual([10, 20, 30, 40]);
  });
  it('a bilinear tap outside the raster reads 0, or the edge texel when edgeSampling is "clamp"', () => {
    const plane = new Uint8Array([255]); // a 1x1 raster stretched over a 3x3 item box: the corner pixel's 2x2 tap window is half outside
    const def = resample(plane, { width: 1, height: 1, space: { kind: 'item', width: 1, height: 1 } }, 3, 3);
    const clamp = resample(plane, { width: 1, height: 1, space: { kind: 'item', width: 1, height: 1 }, edgeSampling: 'clamp' }, 3, 3);
    expect(def[0]).toBe(113); // top-left item pixel: taps (-1,-1),(0,-1),(-1,0) read 0, tap (0,0) reads 255, weight 2/3 each axis: 0.667^2*255 ≈ 113
    expect(clamp[0]).toBe(255); // same pixel with clamp: every out-of-range tap repeats the one texel, so all four taps read 255
  });
  void ITEM;
});

// ---- raster.ts: the file format round trip, and its size limits.
function fakeStore(): RasterStore & { files: Map<string, Blob> } {
  const files = new Map<string, Blob>();
  return { files, writeMask: async (file, data) => { files.set(file, data); }, readMask: async file => { const b2 = files.get(file); if (!b2) throw new Error('not found'); return b2; } };
}
describe('T12 raster file format round trip (§54.6 5.3) and limits', () => {
  it('RasterWriter → store → rasterPlane: a written frame is read back byte-identical after readyRaster loads it', async () => {
    const store = fakeStore();
    useRasterStore(store);
    const w = new RasterWriter(2, 2);
    await w.add(0, new Uint8Array([0, 64, 128, 255]));
    await w.add(1000, new Uint8Array([255, 128, 64, 0]));
    expect(w.count).toBe(2);
    await store.writeMask('r1.mask', w.blob());
    const ref: RasterRef = { file: 'r1.mask', sourceStartUs: 0, sourceEndUs: 2000, frameCount: 2, width: 2, height: 2, space: { kind: 'item', width: 2, height: 2 }, version: 1 };
    expect(rasterPlane(ref, 0)).toBeNull(); // not loaded yet: no previous frame to fall back on
    await readyRaster(ref, 0);
    expect([...rasterPlane(ref, 0)!]).toEqual([0, 64, 128, 255]);
    await readyRaster(ref, 1000);
    expect([...rasterPlane(ref, 1000)!]).toEqual([255, 128, 64, 0]);
    await readyRaster(ref, 500); // hold: nearest frame at or before 500 is the one at 0
    expect([...rasterPlane(ref, 500)!]).toEqual([0, 64, 128, 255]);
    useRasterStore(null);
  });
  it('a mismatched frame size is refused', async () => {
    const w = new RasterWriter(2, 2);
    await expect(w.add(0, new Uint8Array([1, 2, 3]))).rejects.toThrow('Raster frame size does not match the raster.');
  });
  it('RASTER_LIMITS.pixels / .side: a raster over 4096×4096 px, or over 8192 px on a side, is refused', () => {
    expect(() => new RasterWriter(5000, 5000)).toThrow(/over the limit/);
    expect(() => new RasterWriter(9000, 10)).toThrow(/over the limit/);
    expect(RASTER_LIMITS).toMatchObject({ pixels: 4096 * 4096, side: 8192, frames: 1_000_000, frameBytes: 256 * 2 ** 20 });
  });
  it('deflate/inflate round trip a plane through zlib compression', async () => {
    const { inflate } = await import('../apps/web/src/masks/raster');
    const plane = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const zlib = await deflate(plane);
    expect([...await inflate(zlib)]).toEqual([...plane]);
  });
});

// ---- M7: offsetPlane's erosion must see the raster's own edge as a boundary, not just real interior transitions.
describe('M7: offsetPlane erosion at the raster edge (review finding M7, model.ts:98)', () => {
  it('a full-255 20x20 raster eroded by -3: every edge goes to 0, the centre stays 255', () => {
    const out = offsetPlane(new Uint8ClampedArray(400).fill(255), 20, 20, -3);
    expect(out[10 * 20 + 0]).toBe(0); // left edge: today 255 (no virtual boundary), should erode like any interior edge
    expect(out[10 * 20 + 19]).toBe(0); // right edge
    expect(out[0 * 20 + 10]).toBe(0); // top edge
    expect(out[19 * 20 + 10]).toBe(0); // bottom edge
    expect(out[10 * 20 + 10]).toBe(255); // centre: far from every edge, unaffected
  });
  it('a raster flush with the buffer edge on one side shrinks there exactly as it does at a real interior edge the same distance away', () => {
    const W = 40, H = 10, g = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) g[y * W + x] = 255; // band cols 0..19; col 0 is flush with the buffer's left edge, col 19/20 is a real interior edge
    const out = offsetPlane(g, W, H, -2.5), row = 5;
    expect(out[row * W + 0]).toBe(0); // the flush edge itself is eroded (a6ca05e leaves it 255)
    expect(out[row * W + 2]).toBe(out[row * W + 17]); // col 2 is as far from the flush edge as col 17 from the real one
    expect(out[row * W + 2]).toBeGreaterThan(0); expect(out[row * W + 2]).toBeLessThan(255); // a genuine partial pixel, not a 0/255 coincidence
  });
  it('expansion (e > 0) is unchanged by the erosion fix: a full-255 raster dilates into its own padding exactly as before', () => {
    const W = 20, H = 20, g = new Uint8ClampedArray(W * H);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) g[y * W + x] = 255; // a 10x10 box with 5px margin on every side
    const out = offsetPlane(g, W, H, 3);
    expect(out[10 * W + 1]).toBe(0); // 4px outside the box's left edge (col5-4=1): still outside the +3 expansion
    expect(out[10 * W + 3]).toBe(255); // 2px outside (col5-3=2, distance ≈1.41 < r): inside the +3 expansion
  });
  it('an existing interior erosion case (ample margin on every side) is unchanged by the fix', () => {
    const W = 20, H = 20, g = new Uint8ClampedArray(W * H);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) g[y * W + x] = 255;
    const out = offsetPlane(g, W, H, -3);
    expect(out[10 * W + 9]).toBe(255); // distance 5 from the background at col4: well outside the -3 erosion reach
    expect(out[10 * W + 6]).toBe(0); // distance 2 from the background at col4: well within the -3 erosion reach, same as model.ts always computed for a real interior edge
  });
});

// ---- M8: a legacy "smart" mask's path keyframes stored only as a path string (no .points) must resolve through a real
// parser, and the hard-switch-vs-lerp rule must trigger on "no points" exactly as it does on unequal point counts.
describe('M8: legacy path-string keyframes (model.ts frameMasks delegating to shapes.ts pathOf, which today reads only .points)', () => {
  it('legacy-path: a closed square stored only as a path string ("M 0,0 L 10,0 L 10,10 L 0,10 Z") resolves to its 4 points, not an empty mask', () => {
    const item = withMasks([rec({ id: 'legacy', order: 0, points: [], closed: true, keyframes: { path: { keyframes: [
      { id: 'k0', time: 0, value: 'M 0,0 L 10,0 L 10,10 L 0,10 Z', points: [], closed: true, easing: 'linear' },
      { id: 'k1', time: 1000, value: 'M 0,0 L 10,0 L 10,10 L 0,10 Z', points: [], closed: true, easing: 'linear' },
    ] } } })]);
    const path = frameMasks(item, 500)[0].path!;
    expect(path.points.map(p => [p.anchor.x, p.anchor.y])).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(path.closed).toBe(true);
  });
  it('a path string with a cubic (C) segment parses handles correctly; no Z and no stored closed flag infers open', () => {
    const curved: PathPoint[] = [{ anchor: { x: 0, y: 0 }, handleOut: { x: 5, y: 0 } }, { anchor: { x: 20, y: 20 }, handleIn: { x: -5, y: 0 } }];
    const value = pathString({ points: curved, closed: false });
    const item = withMasks([rec({ id: 'curve', order: 0, points: [], closed: true, keyframes: { path: { keyframes: [
      { id: 'k0', time: 0, value, points: [] }, { id: 'k1', time: 1000, value, points: [] },
    ] as never } } })]);
    const path = frameMasks(item, 500)[0].path!;
    expect(path.points).toEqual(curved);
    expect(path.closed).toBe(false);
  });
  it('points present (non-empty) still win over value, even when both are stored on the same keyframe', () => {
    const real: PathPoint[] = [{ anchor: { x: 1, y: 1 } }, { anchor: { x: 2, y: 2 } }, { anchor: { x: 3, y: 1 } }];
    const item = withMasks([rec({ id: 'wins', order: 0, points: [], closed: true, keyframes: { path: { keyframes: [
      { id: 'k0', time: 0, value: 'M 0,0 L 10,0 L 10,10 L 0,10 Z', points: real, closed: true, easing: 'linear' },
      { id: 'k1', time: 1000, value: 'M 0,0 L 10,0 L 10,10 L 0,10 Z', points: real, closed: true, easing: 'linear' },
    ] } } })]);
    expect(frameMasks(item, 500)[0].path!.points).toEqual(real);
  });
  it('two string-only keyframes (equal point count, no .points), more than 50ms apart, hard-switch at e >= 0.5 rather than lerping', () => {
    const A: PathPoint[] = [{ anchor: { x: 0, y: 0 } }, { anchor: { x: 10, y: 0 } }, { anchor: { x: 10, y: 10 } }, { anchor: { x: 0, y: 10 } }];
    const B: PathPoint[] = [{ anchor: { x: 100, y: 0 } }, { anchor: { x: 110, y: 0 } }, { anchor: { x: 110, y: 10 } }, { anchor: { x: 0, y: 10 } }];
    const item = withMasks([rec({ id: 'hard', order: 0, points: [], closed: true, keyframes: { path: { keyframes: [
      { id: 'k0', time: 0, value: pathString({ points: A, closed: true }), points: [], closed: true, easing: 'linear' },
      { id: 'k1', time: 1000, value: pathString({ points: B, closed: true }), points: [], closed: true, easing: 'linear' },
    ] } } })]);
    expect(frameMasks(item, 499)[0].path!.points).toEqual(A); // e just below .5: A exactly, no lerp toward B
    expect(frameMasks(item, 500)[0].path!.points).toEqual(B); // e >= .5: B exactly
  });
  it('an explicit closed:false on the keyframe wins over the string\'s own trailing Z (already correct today; confirms the fix must not disturb it)', () => {
    const item = withMasks([rec({ id: 'explicit', order: 0, points: [], closed: true, keyframes: { path: { keyframes: [
      { id: 'k0', time: 0, value: 'M 0,0 L 10,0 L 10,10 L 0,10 Z', points: [], closed: false, easing: 'linear' },
      { id: 'k1', time: 1000, value: 'M 0,0 L 10,0 L 10,10 L 0,10 Z', points: [], closed: false, easing: 'linear' },
    ] } } })]);
    expect(frameMasks(item, 500)[0].path!.closed).toBe(false);
  });
});

describe('M7: a raster\'s edge moves as far as a vector edge (§54.12: one expansion for every mask)', () => {
  it('±10 on a straight edge is exact, 2.5 is one half-covered pixel: T3, T4 and T5\'s values on a plane', () => {
    const W = 60, H = 20, row = 10 * W, g = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) g.fill(255, y * W + 20, y * W + 40);
    const grown = offsetPlane(g, W, H, 10), shrunk = offsetPlane(g, W, H, -5), half = offsetPlane(g, W, H, 2.5);
    expect([grown[row + 9], grown[row + 10]]).toEqual([0, 255]);
    expect([shrunk[row + 24], shrunk[row + 25]]).toEqual([0, 255]);
    expect([half[row + 16], half[row + 17], half[row + 18]]).toEqual([0, 128, 255]);
  });
  it('shrinking never adds coverage: a partly covered pixel keeps its coverage out of reach, and falls with the shrink inside it (review round 2)', () => {
    const W = 20, H = 20, row = 10 * W, g = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = x === 0 ? 0 : x === 1 ? 64 : x === 2 ? 191 : 255; // an interpolated edge: 191 is above the 50 % line, one pixel from it
    const at = (e: number) => offsetPlane(g, W, H, e);
    expect(at(-0.1)[row + 2]).toBeLessThanOrEqual(191); // 229 before: it was rebuilt from 255, not from what the pixel held
    for (const e of [-0.1, -0.25, -0.5, -0.75, -1, -2.5, -5]) { const out = at(e); for (let i = 0; i < out.length; i++) expect(out[i], `e ${e}, pixel ${i}`).toBeLessThanOrEqual(g[i]); }
    for (let e = -0.1; e > -3; e -= 0.1) { const a = at(e), b = at(e - 0.1); for (let i = 0; i < a.length; i++) expect(b[i], `from ${e}, pixel ${i}`).toBeLessThanOrEqual(a[i]); }
  });
});

describe('M8: a legacy vector smart mask (§54.9 8.3): one path string per tracked frame, read at times floored to the tracker\'s rate', () => {
  const square = (x: number) => `M ${x},0 L ${x + 10},0 L ${x + 10},10 L ${x},10 Z`;
  const old = (extra: Record<string, unknown> = {}) => rec({ id: 'old', order: 0, points: [], source: 'smart', smartMask: { sourceFps: 10 }, keyframes: { path: { keyframes: [{ time: 100, value: square(0) }, { time: 200, value: square(20) }, { time: 300, value: square(40) }] } }, ...extra } as never);
  const xAt = (m: StoredMask, local: number) => frameMasks(withMasks([m]), local)[0].path!.points[0].anchor.x;
  it('the path is the keyframe at the floored source time: 260 ms at 10 fps reads 200 ms', () => {
    expect(xAt(old(), 199)).toBe(0);
    expect(xAt(old(), 200)).toBe(20);
    expect(xAt(old(), 260)).toBe(20); // unfloored, 260 ms is past the middle of the segment: the hard switch would show 40
  });
  it('without a tracker rate the time is not floored', () => {
    expect(xAt(old({ smartMask: undefined }), 260)).toBe(40);
  });
  it('outside the first-to-last keyframe span the mask is dropped', () => {
    expect(frameMasks(withMasks([old()]), 99)).toEqual([]);
    expect(frameMasks(withMasks([old()]), 399)).toHaveLength(1); // floors to 300, the last keyframe
    expect(frameMasks(withMasks([old()]), 400)).toEqual([]);
  });
  it('feather, expansion and opacity are read at the floored property time', () => {
    const ramp = (a: number, b: number) => ({ keyframes: [{ id: 'a', time: 0, value: a, easing: 'linear' }, { id: 'b', time: 1000, value: b, easing: 'linear' }] });
    const keys = { ...old().keyframes, feather: ramp(0, 100), expansion: ramp(0, 10), opacity: ramp(0, 100) }, m = frameMasks(withMasks([old({ keyframes: keys })]), 190)[0];
    expect([m.feather, m.expansion, m.opacity]).toEqual([10, 1, 0.1]);
  });
  it('a manual mask with path keyframes is not dropped outside them (already correct on a6ca05e)', () => {
    const m = rec({ id: 'hand', order: 0, keyframes: { path: { keyframes: [{ id: 'a', time: 100, value: '', points: [{ anchor: { x: 1, y: 1 } }], closed: true }] } } } as never);
    expect(frameMasks(withMasks([m]), 500)).toHaveLength(1);
  });
});

describe('M8: §54.8 7.4 the legacy frame-based fields, at the integer frame floor(clip ms × fps / 1000)', () => {
  const A = 'M 0,0 L 10,0 L 10,10 Z', B = 'M 50,0 L 60,0 L 60,10 Z';
  const frames = (...list: [number, string, string?][]) => list.map(([frame, path, easing]) => ({ frame, path, easing: easing ?? 'linear' }));
  const xAt = (m: StoredMask, local: number, fps?: number) => frameMasks(withMasks([m]), local, fps)[0].path!.points[0].anchor.x;
  it('pathKeyframes: held outside them, A until the eased progress reaches .5, then B', () => {
    const m = rec({ id: 'f', order: 0, points: [], pathKeyframes: frames([10, A], [40, B]) });
    expect(xAt(m, 0)).toBe(0); // before the first
    expect(xAt(m, 800)).toBe(0); // frame 24, progress .47
    expect(xAt(m, 834)).toBe(50); // frame 25, progress .5
    expect(xAt(m, 3000)).toBe(50); // after the last
  });
  it('the easing decides when progress reaches .5', () => {
    const late = rec({ id: 'f', order: 0, points: [], pathKeyframes: frames([0, A, 'easeInCubic'], [30, B]) });
    expect(xAt(late, 500)).toBe(0); // frame 15, eased progress .125
  });
  it('keyframes one frame apart: A on its frame, B from the next', () => {
    const m = rec({ id: 'f', order: 0, points: [], pathKeyframes: frames([0, A], [1, B]) });
    expect([xAt(m, 0), xAt(m, 34)]).toEqual([0, 50]);
  });
  it('the frame is counted at the fps it is given', () => {
    const m = rec({ id: 'f', order: 0, points: [], pathKeyframes: frames([0, A], [30, B]) });
    expect(xAt(m, 300, 30)).toBe(0); // frame 9
    expect(xAt(m, 300, 60)).toBe(50); // frame 18
  });
  it('keyframes.path wins over pathKeyframes', () => {
    const m = rec({ id: 'f', order: 0, pathKeyframes: frames([0, A], [30, B]), keyframes: { path: { keyframes: [{ time: 0, value: 'M 7,0 L 8,0 L 8,8 Z' }, { time: 1000, value: 'M 7,0 L 8,0 L 8,8 Z' }] } } } as never);
    expect(xAt(m, 500)).toBe(7);
  });
  it('propertyKeyframes: eased lerp at the frame; keyframes of the same key win', () => {
    const m = rec({ id: 'f', order: 0, propertyKeyframes: { feather: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 30, value: 30 }], opacity: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 30, value: 100 }] }, keyframes: { opacity: { keyframes: [{ id: 'k', time: 0, value: 40, easing: 'linear' }] } } } as never);
    const at = frameMasks(withMasks([m]), 500, 30)[0];
    expect(at.feather).toBe(15);
    expect(at.opacity).toBe(0.4);
  });
  it('framePlan counts frames at the document\'s fps', () => {
    const m = rec({ id: 'f', order: 0, propertyKeyframes: { feather: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 60, value: 60 }] } });
    const doc = build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 4000, 0, 1_000_000, { masks: [m] })], extra: { fps: 60 } });
    expect(framePlan(doc, 500).draws[0].masks![0].feather).toBe(30);
  });
});
