// SPDX-License-Identifier: AGPL-3.0-only
// Findings part 5 §53 "Checks" blocks through the oracle's item model and frame renderer.
import { describe, it, expect } from 'vitest';
import {
  addMedia, alignBottom, alignTop, apply, bounds, boxMatrix, cellMedia, cellRect, cellSourceTime, cover, drawTracks, effectiveRadius, exportPlan,
  encodedTime, frameScale, frameTime, invert, isVisible, itemBox, pickFrame, planTime, stretch, syncedDuration, trackItems, type Item, type Project,
} from '../parity/oracle/item';
import { renderFrame, renderItem, type Deps, type TextTarget } from '../parity/oracle/render';
import { cssFilters } from '../parity/oracle/effects';
import { captionLinePitch, decorationRect, fontSizePx, strokeOutsidePx, textAnchorX, textDrawsNothing, textLinePitch, textLineTop, textPadding } from '../parity/oracle/layout';
import { createImage, type Image } from '../parity/oracle/image';
import { effects as colourEffects } from '../parity/oracle/colour';
import type { RGBA } from '../parity/oracle/math';

const props = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));
const item = (id: string, type: string, trackId: string, p: Record<string, any> = {}, extra: Partial<Item> = {}): Item =>
  ({ id, type, trackId, display: { from: 0, to: 10000 }, trim: { from: 0 }, properties: props(p), ...extra });
const project = (w: number, h: number, tracks: { id: string; kind: string; hidden?: boolean; muted?: boolean }[], items: Item[], extra: Partial<Project> = {}): Project =>
  ({ size: { width: w, height: h }, fps: 30, tracks, items, layerOrder: tracks.map(t => ({ type: 'track' as const, id: t.id })), groups: {}, ...extra });
const solid = (w: number, h: number, rgb: number[], a = 1) => createImage(w, h, [...rgb.map(v => v / 255), a] as RGBA);
const px = (img: Image, x: number, y: number) => [0, 1, 2, 3].map(k => Math.round(img.data[(y * img.width + x) * 4 + k] * 255));
const rgb = (img: Image, x: number, y: number) => px(img, x, y).slice(0, 3);
const deps = (o: Partial<Deps> = {}): Deps => ({ effects: {}, cssFilters: {}, source: () => null, ...o });
// A stored effect instance (findings (C).md:65): {id, effectId, enabled, order, parameters: {<key>: {defaultValue, keyframes[]}}}.
const effect = (effectId: string, params: Record<string, any>, order = 0) => ({ id: `effect_${order}`, effectId, enabled: true, order, parameters: props(params) });
const near = (a: number, e: number, digits: number) => expect(Math.abs(a - e)).toBeLessThanOrEqual(0.5 * 10 ** -digits + 1e-9);
// A stand-in deps.text draw: box-local rects [x, y, w, h] in an RGB colour through target.m into target.size,
// sampled at pixel centres (exact for the axis-aligned, whole-pixel rects used here).
const paint = (at: TextTarget, rects: [number[], number[]][]): Image => {
  const out = createImage(at.size.width, at.size.height), inv = invert(at.m);
  for (let i = 0; i < out.width * out.height; i++) {
    const [u, v] = apply(inv, i % out.width + 0.5, Math.floor(i / out.width) + 0.5), hit = rects.find(([[x, y, w, h]]) => u >= x && u < x + w && v >= y && v < y + h);
    if (hit) out.data.set([...hit[1].map(c => c / 255), 1], i * 4);
  }
  return out;
};

describe('§53 item render model', () => {
  it('§53.1.4 box geometry checks', () => {
    const P = project(1080, 1920, [{ id: 'V1', kind: 'video' }], []);
    const img = itemBox(P, item('i', 'image', 'V1', { positionX: 100, positionY: 200, width: 400, height: 300, scale: 0.5 }), 0), b = bounds(boxMatrix(img), img.W, img.H);
    expect([b.x0, b.x1, b.y0, b.y1]).toEqual([100, 300, 200, 350]);
    expect(apply(boxMatrix(img), 200, 150)).toEqual([200, 275]);
    const v = itemBox(P, item('v', 'video', 'V1'), 0), c = itemBox(P, item('c', 'caption', 'V1'), 0);
    expect([v.W, v.H]).toEqual([1080, 1920]);
    expect([c.W, c.H]).toEqual([800, 100]);
    const fit = addMedia(1920, 1080, 1080, 1920, 'fit'), fill = addMedia(1920, 1080, 1080, 1920, 'fill');
    near(fit.scale, 0.5625, 4); near(fit.positionX, 0, 0); near(fit.positionY, 656.25, 2);
    near(fill.scale, 1.7778, 4); near(fill.positionX, -1166.67, 2); near(fill.positionY, 0, 0);
    expect(alignBottom(1080, 1920, 800)).toEqual({ positionX: 140, positionY: 1344 });
    const top = alignTop(1080, 1920, 800, 120);
    expect(top).toEqual({ positionX: 140, positionY: 456 });
    expect(top.positionY + 120).toBe(0.3 * 1920);
  });

  it('§53.2.4 transform maths checks', () => {
    const P = project(1080, 1920, [{ id: 'V1', kind: 'video' }], []);
    const box = (p: Record<string, any>) => itemBox(P, item('i', 'image', 'V1', p), 0);
    const a = box({ positionX: 100, positionY: 200, width: 400, height: 300, scale: 0.5, rotation: 90 }), ma = boxMatrix(a), ba = bounds(ma, 400, 300);
    apply(ma, 200, 150).forEach((v, i) => near(v, [200, 275][i], 9));
    [ba.x0, ba.x1, ba.y0, ba.y1].forEach((v, i) => near(v, [125, 275, 175, 375][i], 9));
    apply(ma, 0, 0).forEach((v, i) => near(v, [275, 175][i], 9));
    const r = boxMatrix(box({ width: 400, height: 300, rotation: 90 })), br = bounds(r, 400, 300);
    apply(r, 200, 150).forEach((v, i) => near(v, [200, 150][i], 9));
    [br.x0, br.x1, br.y0, br.y1].forEach((v, i) => near(v, [50, 350, -50, 350][i], 9));
    apply(r, 0, 0).forEach((v, i) => near(v, [350, -50][i], 9));
    const f = boxMatrix(box({ width: 400, height: 300, flipX: true })), bf = bounds(f, 400, 300);
    near(apply(f, 0.5, 150)[0], 399.5, 9);
    expect([bf.x0, bf.x1]).toEqual([0, 400]);
    const s2 = box({ width: 400, height: 300, scale: 2, scaleX: 0.5 }), s1 = box({ positionX: 10, width: 400, height: 300, scaleX: 0.5 });
    expect([s2.sx, s2.sy, s1.sx, s1.sy]).toEqual([2, 2, 0.5, 1]);
    expect(apply(boxMatrix(s1), 200, 150)[0]).toBe(10 + 400 * 0.5 / 2);
    // positionX 10.25 is not snapped: a soft 1-px edge at the project size
    const Q = project(20, 4, [{ id: 'V1', kind: 'video' }], []), white = solid(4, 4, [255, 255, 255]);
    const out = renderItem(Q, item('w', 'image', 'V1', { positionX: 10.25, width: 4, height: 4 }), 0, deps({ source: () => white }));
    expect([9, 10, 11, 13, 14, 15].map(x => px(out, x, 1)[3])).toEqual([0, 191, 255, 255, 64, 0]);
    // 720p export of a 1080 × 1920 project: every point × 2/3, the centre included
    const m720 = frameScale(P, { width: 720, height: 1280 }, ma);
    apply(m720, 200, 150).forEach((v, i) => near(v, [200, 275][i] * 2 / 3, 9));
    apply(m720, 0, 0).forEach((v, i) => near(v, [275, 175][i] * 2 / 3, 9));
  });

  it('§53.3.5 media fitting checks', () => {
    const v1 = cover(1920, 1080, 1080, 1080)!, v2 = cover(1080, 1920, 1920, 1080)!;
    expect([v1.w, v1.h, v1.x, v1.y]).toEqual([1920, 1080, -420, 0]);
    near(v2.w, 1920, 0); near(v2.h, 3413.33, 2); near(v2.y, -1166.67, 2);
    expect(stretch(500, 500)).toEqual({ x: 0, y: 0, w: 500, h: 500 }); // image 1000 × 500 squeezed 2 : 1, nothing cropped
    const S = project(2, 2, [{ id: 'V1', kind: 'video' }], []), halves = createImage(4, 2);
    for (let i = 0; i < 8; i++) halves.data.set(i % 4 < 2 ? [1, 0, 0, 1] : [0, 1, 0, 1], i * 4);
    const sq = renderItem(S, item('s', 'image', 'V1', { width: 2, height: 2 }), 0, deps({ source: () => halves }));
    expect([rgb(sq, 0, 0), rgb(sq, 1, 0)]).toEqual([[255, 0, 0], [0, 255, 0]]);
    const cell = cellRect({ x: 0, y: 0, width: 1, height: 0.5 }, 1080, 1920);
    expect(cell).toEqual({ x: 0, y: 0, w: 1080, h: 960 });
    const fill = cellMedia('video', 'fill', 1920, 1080, cell), fit = cellMedia('video', 'fit', 1920, 1080, cell), img = cellMedia('image', 'fit', 1920, 1080, cell);
    near(fill.w, 1706.67, 2); near(fill.h, 960, 0); near(fill.x, -313.33, 2); near(fill.y, 0, 0);
    near(fit.w, 1080, 0); near(fit.h, 607.5, 1); near(fit.x, 0, 0); near(fit.y, 176.25, 2);
    near(img.w, 1706.67, 2);
    expect(cellMedia('video', 'fill', 1920, 1080, cell, 100, 50).x - fill.x).toBe(270);
    // empty layout cell over black → ≈ (15, 15, 15); a filled neighbour is unchanged
    const L = project(4, 2, [{ id: 'O1', kind: 'overlay' }], [item('l', 'layout', 'O1', {}, { details: { cells: [
      { bounds: { x: 0, y: 0, width: 0.5, height: 1 }, source: null, fillMode: 'fill' },
      { bounds: { x: 0.5, y: 0, width: 0.5, height: 1 }, source: { type: 'image', url: 'red' }, fillMode: 'fill' }] } })]);
    const lf = renderFrame(L, 0, deps({ source: () => solid(10, 10, [255, 0, 0]) }));
    expect([rgb(lf, 0, 0), rgb(lf, 3, 1)]).toEqual([[15, 15, 15], [255, 0, 0]]);
    expect(cellSourceTime({ source: { trim: { from: 0 } }, playbackRate: 2 }, 4000)).toBe(4000); // Speed 2 ignored
    expect([33.2, 33.3, 50].map(t => pickFrame([0, 33.37, 66.73], t))).toEqual([0, 1, 1]);
  });

  it('§53.4.6 per-item order of operations checks', () => {
    // border 10 red with radius 50 on a white 200 × 200 image over black
    const B = project(200, 200, [{ id: 'V1', kind: 'video' }], [item('b', 'image', 'V1', { width: 200, height: 200, borderRadius: 50, borderWidth: 10, borderColor: '#ff0000' })]);
    const bf = renderFrame(B, 0, deps({ source: () => solid(200, 200, [255, 255, 255]) }));
    expect([rgb(bf, 100, 1), rgb(bf, 100, 6), rgb(bf, 2, 2), rgb(bf, 16, 16)]).toEqual([[255, 0, 0], [255, 255, 255], [0, 0, 0], [255, 255, 255]]);
    expect(effectiveRadius(500, 400, 300)).toBe(150);
    // blur 4: a halo outside the box with radius 0, none with radius 1
    const halo = (radius: number) => renderFrame(project(40, 40, [{ id: 'V1', kind: 'video' }], [item('h', 'image', 'V1', { positionX: 15, positionY: 15, width: 10, height: 10, blur: 4, borderRadius: radius })]), 0,
      deps({ source: () => solid(10, 10, [255, 255, 255]) }));
    const h0 = halo(0), h1 = halo(1);
    expect(rgb(h0, 9, 20)[0]).toBeGreaterThan(0); expect(rgb(h1, 9, 20)[0]).toBe(0);
    expect(rgb(h0, 2, 20)[0]).toBe(0); // beyond 3σ
    // shape at opacity 0.5 → 0.5; with blur 1 the opacity applies twice → ≈ 0.25
    const shape = (p: Record<string, any>) => renderFrame(project(10, 10, [{ id: 'O1', kind: 'overlay' }], [item('s', 'shape', 'O1', { width: 10, height: 10, opacity: 0.5, ...p })]), 0,
      deps({ text: (_, at) => [paint(at, [[[0, 0, 10, 10], [255, 255, 255]]])] }));
    expect(rgb(shape({}), 5, 5)[0]).toBe(128);
    expect(Math.abs(rgb(shape({ blur: 1 }), 5, 5)[0] - 0.25 * 255)).toBeLessThanOrEqual(1);
    // a layout with blur 2 is drawn empty
    const lay = (p: Record<string, any>) => renderFrame(project(4, 2, [{ id: 'O1', kind: 'overlay' }], [item('l', 'layout', 'O1', p, { details: { cells: [{ bounds: { x: 0, y: 0, width: 1, height: 1 }, source: null }] } })]), 0, deps());
    expect(rgb(lay({}), 1, 1)).toEqual([15, 15, 15]);
    expect(rgb(lay({ blur: 2 }), 1, 1)).toEqual([0, 0, 0]);
    // text, no filter, second line below its 4 × 4 box: drawn. brightness 1.01 → effect path, cut at the box edge.
    // Line 1 = rows 0–3 grey 100, line 2 = rows 4–7 grey 200; 100 × 1.01 = 101.
    const lines = (at: TextTarget) => [paint(at, [[[0, 0, 4, 4], [100, 100, 100]], [[0, 4, 4, 4], [200, 200, 200]]])];
    const two = (p: Record<string, any>) => renderFrame(project(4, 8, [{ id: 'O1', kind: 'overlay' }], [item('t', 'text', 'O1', { width: 4, height: 4, ...p })]), 0, deps({ text: (_, at) => lines(at) }));
    const plain = two({}), bright = two({ brightness: 1.01 });
    expect([rgb(plain, 1, 1), rgb(plain, 1, 5)]).toEqual([[100, 100, 100], [200, 200, 200]]);
    expect([rgb(bright, 1, 1), rgb(bright, 1, 5)]).toEqual([[101, 101, 101], [0, 0, 0]]);
  });

  it('§51.5 / §51.6 item CSS filters see the item past the frame edge (outside the item is transparent, outside the frame is not)', () => {
    // Review repro: 90 × 160 project, 160 × 90 white video at Fill (§53.1.3: scale 16/9, positionX (90 − 160·16/9)/2 ≈ −97.2), blur 4.
    // The item spans x −97.2…187.2, y 0…160, so every tap within 3σ = 12 px of row 80, x 0…8 is white: 255.
    const fill = renderFrame(project(90, 160, [{ id: 'V1', kind: 'video' }], [item('v', 'video', 'V1', { width: 160, height: 90, scale: 16 / 9, positionX: (90 - 160 * 16 / 9) / 2, positionY: 0, blur: 4 })]), 0,
      deps({ source: () => solid(160, 90, [255, 255, 255]) }));
    expect([0, 1, 2, 4, 8].map(x => rgb(fill, x, 80))).toEqual([0, 1, 2, 4, 8].map(() => [255, 255, 255]));
    // drop-shadow x 6, blur 0, red, of a white 8 × 4 image wholly left of the frame (x −10…−2): the shadow lands at x −4…4.
    const shadow = renderFrame(project(8, 4, [{ id: 'V1', kind: 'video' }], [item('s', 'image', 'V1', { positionX: -10, width: 8, height: 4 }, { effects: [effect('drop-shadow', { x: 6, y: 0, blur: 0, color: '#ff0000' })] })]), 0,
      deps({ source: () => solid(8, 4, [255, 255, 255]), cssFilters }));
    expect([0, 1, 2, 3, 4].map(x => rgb(shadow, x, 2))).toEqual([[255, 0, 0], [255, 0, 0], [255, 0, 0], [255, 0, 0], [0, 0, 0]]);
  });

  it('part 4 §49.19 recolor: an element image gets the pass first in its chain, only when a target differs', () => {
    // palette {#ffffff neutral}, colour #ffd0a0. The printed case is 0.5 grey → (0.5483, 0.3859, 0.2073); a decoded bitmap is
    // 8 bit, so the source here is 128/255 grey. The §49.19 steps worked independently of colour.ts (standard OKLab matrices;
    // the same working reproduces the printed 0.5 case) give (0.55014, 0.38755, 0.20900) → 8 bit (140, 99, 53).
    // Then grayscale 100 (Y601, §49.13) on the unrounded pass output: 0.41581 → 106. Grayscale first would leave the grey to recolor: (140, 99, 53).
    const frame = (colors: string[], effects: any[] = []) => rgb(renderFrame(project(2, 2, [{ id: 'V1', kind: 'video' }], [item('e', 'image', 'V1', { width: 2, height: 2 }, { effects })]), 0,
      deps({ source: () => solid(2, 2, [128, 128, 128]), effects: colourEffects, element: () => ({ palette: [{ base: '#ffffff', kind: 'neutral' }], colors }) })), 0, 0);
    expect(frame(['#ffd0a0'])).toEqual([140, 99, 53]);
    expect(frame(['#ffd0a0'], [effect('grayscale', { amount: 100 })])).toEqual([106, 106, 106]);
    expect(frame(['#ffffff'])).toEqual([128, 128, 128]); // target = base: no pass
  });

  it('§53.5.6 stacking checks', () => {
    const T = (id: string, kind: string) => ({ id, kind });
    const tracks = [T('A1', 'audio'), T('V1', 'video'), T('V2', 'video'), T('O1', 'overlay'), T('C1', 'caption')];
    const P = project(2, 2, tracks, []), ids = (p: Project) => drawTracks(p).map(t => t.id);
    expect(ids(P)).toEqual(['V1', 'V2', 'O1', 'C1']);
    expect(ids({ ...P, layerOrder: [{ type: 'track', id: 'A1' }, { type: 'track', id: 'V1' }, { type: 'group', id: 'G' }, { type: 'track', id: 'C1' }], groups: { G: { children: [{ type: 'track', id: 'V2' }, { type: 'track', id: 'O1' }], hidden: true } } })).toEqual(['V1', 'C1']);
    expect(ids({ ...P, layerOrder: ['A1', 'V2', 'O1', 'C1', 'V1'].map(id => ({ type: 'track' as const, id })) })).toEqual(['V2', 'O1', 'C1', 'V1']);
    expect(ids({ ...P, tracks: tracks.map(t => ({ ...t, muted: true, solo: true, locked: true })) })).toEqual(['V1', 'V2', 'O1', 'C1']); // §53.5.2: picture unchanged
    // A (zIndex 0) and B (zIndex 5) on O1, both 0–5 s, stored [B, A] → A on top in the export
    const texts = project(2, 2, [T('O1', 'overlay')], [item('B', 'text', 'O1', { zIndex: 5 }, { display: { from: 0, to: 5000 } }), item('A', 'text', 'O1', { zIndex: 0 }, { display: { from: 0, to: 5000 } })]);
    const tf = renderFrame(texts, 1000, deps({ text: (it, at) => [paint(at, [[[0, 0, 2, 2], it.id === 'A' ? [255, 0, 0] : [0, 0, 255]]])] }));
    expect(rgb(tf, 0, 0)).toEqual([255, 0, 0]);
    // clips on V1 starting at 0 and 2 s overlap 2–3 s → the later start is on top
    const clips = project(2, 2, [T('V1', 'video')], [item('late', 'video', 'V1', {}, { display: { from: 2000, to: 6000 } }), item('early', 'video', 'V1', {}, { display: { from: 0, to: 3000 } })]);
    expect(trackItems(clips, 'V1').map(i => i.id)).toEqual(['early', 'late']);
    const cf = renderFrame(clips, 2500, deps({ source: (it) => solid(2, 2, it.id === 'late' ? [0, 255, 0] : [255, 0, 0]) }));
    expect(rgb(cf, 1, 1)).toEqual([0, 255, 0]);
    // display [1000, 2000) at 30 fps: frames 30…59 draw it, frame 60 does not
    const d = item('d', 'video', 'V1', {}, { display: { from: 1000, to: 2000 } });
    expect([29, 30, 59, 60].map(n => isVisible(d, frameTime(n, 30)))).toEqual([false, true, true, false]);
  });

  it('§53.6.3 blend backdrop checks', () => {
    const grey = solid(2, 2, [128, 128, 128]), white = solid(2, 2, [255, 255, 255]);
    const frame = (tracks: { id: string; kind: string }[], items: Item[], d: Partial<Deps>) => rgb(renderFrame(project(2, 2, tracks, items), 0, deps(d)), 0, 0);
    expect(frame([{ id: 'V1', kind: 'video' }], [item('m', 'video', 'V1', { blendMode: 'multiply' })], { source: () => grey })).toEqual([0, 0, 0]);
    expect(frame([{ id: 'V1', kind: 'video' }, { id: 'O1', kind: 'overlay' }], [item('v', 'video', 'V1'), item('t', 'text', 'O1', { blendMode: 'multiply' })], { source: () => grey, text: (_, at) => [paint(at, [[[0, 0, 2, 2], [128, 128, 128]]])] })).toEqual([64, 64, 64]);
    expect(frame([{ id: 'V1', kind: 'video' }, { id: 'V2', kind: 'video' }], [item('a', 'video', 'V1'), item('b', 'video', 'V2', { blendMode: 'screen' })], { source: () => grey })).toEqual([192, 192, 192]);
    expect(frame([{ id: 'V1', kind: 'video' }, { id: 'O1', kind: 'overlay' }], [item('i', 'image', 'V1'), item('s', 'shape', 'O1', { blendMode: 'difference' })], { source: () => white, text: (_, at) => [paint(at, [[[0, 0, 2, 2], [255, 255, 255]]])] })).toEqual([0, 0, 0]);
  });

  it('§53.7.6 text and caption layout checks', () => {
    const base = { fontSize: 100, lineHeight: 'normal', textAlign: 'center' };
    expect(textLinePitch(base)).toBe(140); expect(textLineTop(base, 0)).toBe(20); expect(textAnchorX(base, 300)).toBe(150);
    expect(textLineTop(base, 1)).toBe(160); // "A↵B": below the 150 px box, still drawn (no clip)
    // ...and the renderer draws it: em-box stand-ins F × F at anchor 150 (x 100…200), tops 20 and 160, in a 300 × 150 box.
    const ab = renderFrame(project(300, 300, [{ id: 'O1', kind: 'overlay' }], [item('t', 'text', 'O1', { width: 300, height: 150 })]), 0,
      deps({ text: (_, at) => [paint(at, [[[100, 20, 100, 100], [255, 255, 255]]]), paint(at, [[[100, 160, 100, 100], [255, 255, 255]]])] }));
    expect([rgb(ab, 150, 70), rgb(ab, 150, 140), rgb(ab, 150, 210), rgb(ab, 150, 259), rgb(ab, 150, 260)]).toEqual([[255, 255, 255], [0, 0, 0], [255, 255, 255], [255, 255, 255], [0, 0, 0]]);
    expect(textLinePitch({ ...base, borderWidth: 1, borderColor: '#000000' })).toBe(120); expect(textLineTop({ ...base, borderWidth: 1 }, 0)).toBe(10);
    expect(textLinePitch({ ...base, lineHeight: 1.2 })).toBeCloseTo(120, 9); expect(textLineTop({ ...base, lineHeight: 1.2 }, 0)).toBeCloseTo(10, 9);
    expect(textLinePitch({ ...base, lineHeight: '36px' })).toBe(36); expect(textLineTop({ ...base, lineHeight: '36px' }, 0)).toBe(-32);
    expect(textLinePitch({ fontSize: 50, lineHeight: '150%' })).toBe(150); expect(textLineTop({ fontSize: 50, lineHeight: '150%' }, 0)).toBe(50);
    const shadow = { ...base, boxShadow: { color: '#000000', x: 0, y: 10, blur: 20 } };
    expect(textPadding(shadow)).toEqual([20, 40]); expect(textLinePitch(shadow)).toBe(160);
    expect([fontSizePx('48.5px'), fontSizePx(undefined), fontSizePx('2em')]).toEqual([48, 48, 2]);
    const underline = decorationRect({ fontSize: 64, textDecoration: 'underline' }, 0)!;
    expect(underline.y).toBeCloseTo(58.88, 9); expect(underline.height).toBe(4);
    expect(captionLinePitch({ fontSize: 50, lineHeight: 'normal' })).toBeCloseTo(60, 9); expect(captionLinePitch({ fontSize: 50, lineHeight: 36 })).toBe(1800);
    expect(strokeOutsidePx(4)).toBe(4); expect(strokeOutsidePx(4, 'dom')).toBe(2);
    expect(textDrawsNothing('', 300, 150)).toBe(true);
  });

  it('§53.8.4 frame range and timing checks', () => {
    const P = (items: Item[], extra: Partial<Project> = {}) => project(2, 2, [{ id: 'V1', kind: 'video' }], items, extra);
    const ten = exportPlan(P([item('a', 'video', 'V1')], { duration: 10000 }));
    expect(ten.count).toBe(300); near(frameTime(299, 30), 9966.67, 2);
    const long = P([item('a', 'video', 'V1', {}, { display: { from: 0, to: 10010 } })]), lp = exportPlan({ ...long, duration: syncedDuration(long) });
    expect(lp.count).toBe(301); expect(isVisible(long.items[0], planTime(lp, 300))).toBe(true);
    const gap = P([item('a', 'video', 'V1', {}, { display: { from: 2000, to: 10000 } })], { duration: 10000 }), gp = exportPlan(gap);
    expect([gp.shiftMs, planTime(gp, 0), gp.count]).toEqual([2000, 2000, 240]);
    expect(exportPlan(P([item('a', 'video', 'V1', {}, { display: { from: 0.8, to: 10000 } })], { duration: 10000 })).shiftMs).toBe(0);
    const ntsc = exportPlan(P([], { fps: 29.97, duration: 10000 }));
    expect(ntsc.count).toBe(300); near(frameTime(299, 29.97), 9976.64, 2);
    const range = exportPlan(P([item('a', 'video', 'V1')], { duration: 10000 }), { startS: 1, endS: 2 });
    expect([range.first, range.first + range.count - 1, range.shiftMs]).toEqual([30, 59, 0]);
    near(encodedTime(range, 30), 0, 4); near(encodedTime(range, 59), 0.9667, 4);
    const empty = renderFrame(P([], { background: { type: 'color', value: '#ff0000' } }), 0, deps());
    expect(px(empty, 1, 1)).toEqual([0, 0, 0, 255]);
  });

  it('§53 renderFrame: two images, the top one rotated, masked and multiplied', () => {
    // V1: image A (100, 150, 200) fills the 8 × 8 frame. V2: a 4 × 4 image at (2, 2), rotation 90°, multiply,
    // rows 0–1 C1 = (200, 100, 50), rows 2–3 C2 = (50, 200, 250), masked to its local columns 0–1.
    const b = createImage(4, 4);
    for (let i = 0; i < 16; i++) b.data.set(i < 8 ? [200 / 255, 100 / 255, 50 / 255, 1] : [50 / 255, 200 / 255, 250 / 255, 1], i * 4);
    const mask = { enabled: true, points: [[0, 0], [2, 0], [2, 4], [0, 4]].map(([x, y]) => ({ anchor: { x, y } })), closed: true, mode: 'add', opacity: 100, feather: 0, expansion: 0, inverted: false };
    const P = project(8, 8, [{ id: 'V1', kind: 'video' }, { id: 'V2', kind: 'video' }], [
      item('A', 'image', 'V1', { width: 8, height: 8 }),
      item('B', 'image', 'V2', { positionX: 2, positionY: 2, width: 4, height: 4, rotation: 90, blendMode: 'multiply' }, { masks: [mask] })]);
    const f = renderFrame(P, 0, deps({ source: it => it.id === 'A' ? solid(8, 8, [100, 150, 200]) : b }));
    // Rotation 90° about the centre (4, 4): local (u, v) → (6 − v, 2 + u); local row r → frame column 5 − r, local column c → frame row 2 + c.
    // Multiply over A, rounded: C1 → (78, 59, 39), C2 → (20, 118, 196). Local columns 2–3 are masked away → A shows.
    const C1 = [78, 59, 39], C2 = [20, 118, 196], A = [100, 150, 200];
    expect([rgb(f, 5, 2), rgb(f, 4, 3), rgb(f, 3, 2), rgb(f, 2, 3)]).toEqual([C1, C1, C2, C2]);
    expect([rgb(f, 3, 4), rgb(f, 5, 5), rgb(f, 0, 0), rgb(f, 6, 2), rgb(f, 1, 3)]).toEqual([A, A, A, A, A]);
  });
});
