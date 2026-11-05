// SPDX-License-Identifier: AGPL-3.0-only
// T07 layouts, model level: the 11 presets, the tile record, cell rectangles / media rectangles / alpha / source time against the formula
// oracle (parity/oracle/item.ts cellRect, cellMedia, cellAlpha, cellSourceTime; G-05 is never stored, F25), the Author-only switches
// LAYOUT_PARITY.cellSpeed and .imageFit both ways, and the frame plan (a layout is drawn, no longer pending).
// Oracles: findings §20 (presets, tile record), part 3 §46.3 / §46.6, part 5 §53.3.3 and §53.9 rows 7-11, tickets §T07 fixture (1).
// The preset fractions below are typed from findings §20, not read back from the code. Where §20 does not fix an order (grid-2x2 and
// feature-right), the order is the implementer's reading (row by row; the feature cell first) and is pinned as implemented.
import { afterEach, describe, expect, it } from 'vitest';
import { cellAlpha, cellMedia, cellRect as oracleCellRect, cellSourceTime } from '../parity/oracle/item';
import { cellMediaRect, cellRect, framePlan, isPending, itemDraw, EMPTY_CELL, projectSize } from '../apps/web/src/render/model';
import type { Draw } from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { exportedMedia, precheck } from '../apps/web/src/export/prep';
import { cellItem, cellItems, cellsOf, filledCount, LAYOUT_PARITY, LAYOUT_PRESETS, LAYOUT_TYPES, layoutLabel, layoutRecord, newCell, withCellItems } from '../apps/web/src/timeline/layouts';
import type { LayoutType } from '../apps/web/src/timeline/layouts';
import { assets, build, links, mkTrack, resetIds, video } from './t03-fixtures';

afterEach(() => { resetIds(); LAYOUT_PARITY.cellSpeed = 'apply'; LAYOUT_PARITY.imageFit = 'honour'; });

type B = [number, number, number, number];
const FULL: B = [0, 0, 1, 1];
/** findings §20 typed out: preset id -> [label, cells as x, y, width, height]. */
const SPEC: Record<string, [string, B[]]> = {
  'split-horizontal': ['Split Horizontal', [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]],
  'split-vertical': ['Split Vertical', [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]],
  'three-horizontal': ['Three Horizontal', [[0, 0, 0.333, 1], [0.333, 0, 0.334, 1], [0.667, 0, 0.333, 1]]],
  'three-vertical': ['Three Vertical', [[0, 0, 1, 0.333], [0, 0.333, 1, 0.334], [0, 0.667, 1, 0.333]]],
  'grid-2x2': ['Grid 2x2', [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]],
  'pip-top-right': ['PiP Top Right', [FULL, [0.65, 0.05, 0.3, 0.3]]],
  'pip-top-left': ['PiP Top Left', [FULL, [0.05, 0.05, 0.3, 0.3]]],
  'pip-bottom-right': ['PiP Bottom Right', [FULL, [0.65, 0.65, 0.3, 0.3]]],
  'pip-bottom-left': ['PiP Bottom Left', [FULL, [0.05, 0.65, 0.3, 0.3]]],
  'feature-left': ['Feature Left', [[0, 0, 0.6, 1], [0.6, 0, 0.4, 0.5], [0.6, 0.5, 0.4, 0.5]]],
  'feature-right': ['Feature Right', [[0.4, 0, 0.6, 1], [0, 0, 0.4, 0.5], [0, 0.5, 0.4, 0.5]]],
};
const IDS = Object.keys(SPEC) as LayoutType[];
const bounds = (b: B) => ({ x: b[0], y: b[1], width: b[2], height: b[3] });
const SIZES = [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, { width: 1080, height: 1080 }];
const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
const prop = (v: unknown) => ({ defaultValue: v, keyframes: [] });

/** A project with one layout item (all cells empty unless `fill` says), at the given canvas, 0-10 s on O1. */
function project(type: LayoutType, size = SIZES[0], opts: { gap?: number; borderRadius?: number; fill?: Record<number, Record<string, unknown>>; cell?: Record<string, unknown>; props?: Record<string, unknown> } = {}) {
  const doc = build({ tracks: [mkTrack('O1', 'overlay')], items: [], extra: { size, duration: 10000 } });
  const rec: any = layoutRecord({ id: 'L1', trackId: 'O1', display: { from: 0, to: 10000 }, layoutType: type, ...size });
  if (opts.gap !== undefined) rec.details.gap = opts.gap;
  if (opts.borderRadius !== undefined) rec.details.borderRadius = opts.borderRadius;
  rec.details.cells.forEach((c: any, k: number) => Object.assign(c, opts.cell, opts.fill?.[k]));
  for (const [k, v] of Object.entries(opts.props ?? {})) rec.properties[k] = prop(v);
  doc.items.push(rec);
  return { doc, rec };
}
const src = (type: 'video' | 'image', trim?: { from: number; to: number }, assetId = 'asset-vid1') => ({ assetId, type, url: `asset:${assetId}`, ...trim ? { trim } : {} });
const layoutDraw = (doc: ProjectDocument, t = 1000): Draw & { layout: NonNullable<Draw['layout']> } => {
  const d = itemDraw(doc, doc.items[0], t);
  if (!d || isPending(d)) throw new Error(`no draw: ${JSON.stringify(d)}`);
  return d as never;
};

describe('T07 presets (findings §20)', () => {
  it('1. LAYOUT_TYPES: the 11 ids in §20 order, with the card labels of part 3 §46.3', () => {
    expect([...LAYOUT_TYPES]).toEqual(IDS);
    expect(Object.keys(LAYOUT_PRESETS)).toEqual(IDS);
    expect(IDS.map(t => LAYOUT_PRESETS[t].label)).toEqual(['Split Horizontal', 'Split Vertical', 'Three Horizontal', 'Three Vertical', 'Grid 2x2', 'PiP Top Right', 'PiP Top Left', 'PiP Bottom Right', 'PiP Bottom Left', 'Feature Left', 'Feature Right']);
    expect(layoutLabel('grid-2x2')).toBe('Grid 2x2'); expect(layoutLabel('nope')).toBe('nope'); expect(layoutLabel(undefined)).toBe('Layout');
  });

  it('2. every preset has exactly the §20 fractions (0.333 / 0.334 / 0.333, pip insets 0.3 × 0.3, feature 0.6 / 0.4)', () => {
    for (const id of IDS) {
      expect(LAYOUT_PRESETS[id].label, id).toBe(SPEC[id][0]);
      expect(LAYOUT_PRESETS[id].cells, id).toStrictEqual(SPEC[id][1].map(bounds));
    }
  });

  it('3. layoutRecord: the W3-RT-09 record shape - no name / gap / radius, cells with 21-character ids, fixed defaults (fixture 1, model level)', () => {
    const r = layoutRecord({ id: 'item_x', trackId: 'O1', display: { from: 0, to: 10000 }, layoutType: 'split-horizontal', width: 1080, height: 1920 }) as any;
    expect(Object.keys(r).sort()).toEqual(['details', 'display', 'id', 'properties', 'trackId', 'type']);
    expect(r).toMatchObject({ id: 'item_x', type: 'layout', trackId: 'O1', display: { from: 0, to: 10000 } });
    expect(Object.keys(r.details).sort()).toEqual(['cells', 'layoutType']);
    expect(r.details.layoutType).toBe('split-horizontal');
    expect(r.properties).toStrictEqual({ positionX: prop(0), positionY: prop(0), width: prop(1080), height: prop(1920), scale: prop(1), rotation: prop(0), opacity: prop(1) });
    const ids = new Set<string>();
    r.details.cells.forEach((c: any, k: number) => {
      expect(c.id, `cell ${k}`).toMatch(/^[A-Za-z0-9_-]{21}$/); ids.add(c.id);
      expect(Object.keys(c).sort()).toEqual(['bounds', 'fillMode', 'id', 'opacity', 'panX', 'panY', 'playbackRate', 'source', 'volume', 'zoom']);
      const { id, bounds: b, ...rest } = c;
      expect(b).toStrictEqual(bounds(SPEC['split-horizontal'][1][k]));
      expect(rest).toStrictEqual({ source: null, fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 });
    });
    expect(ids.size).toBe(2);
  });

  it('4. cell ids are unique across layouts and across 200 new cells; the cells do not share the preset\'s bounds objects', () => {
    const all = new Set<string>(); for (let i = 0; i < 200; i++) all.add(newCell({ x: 0, y: 0, width: 1, height: 1 }).id);
    expect(all.size).toBe(200);
    const a = layoutRecord({ id: 'a', trackId: 'O1', display: { from: 0, to: 1 }, layoutType: 'grid-2x2', width: 10, height: 10 }), b = layoutRecord({ id: 'b', trackId: 'O1', display: { from: 0, to: 1 }, layoutType: 'grid-2x2', width: 10, height: 10 });
    expect(cellsOf(a).map(c => c.id).some(id => cellsOf(b).some(c => c.id === id))).toBe(false);
    cellsOf(a)[0].bounds.x = 0.9; expect(LAYOUT_PRESETS['grid-2x2'].cells[0].x).toBe(0);
  });

  it('5. the UI tile through the runtime (fixture 1): empty timeline, 1 "Add items", one new overlay track O1, the whole stored item', () => {
    const e = createEditor(), n = e.bus.undoStack.length;
    expect(e.doc.items).toHaveLength(0);
    e.intent({ type: 'addLayout', layoutType: 'split-horizontal' });
    expect(e.bus.undoStack).toHaveLength(n + 1); expect(e.labels()).toEqual(['Add items']);
    expect(e.doc.items).toHaveLength(1); expect(e.doc.tracks.map(t => [t.kind, t.name])).toEqual([['overlay', 'O1']]);
    const i: any = e.doc.items[0];
    expect(i.trackId).toBe(e.doc.tracks[0].id); expect(i.type).toBe('layout'); expect(i.display).toEqual({ from: 0, to: 10000 });
    expect(i.properties).toStrictEqual({ positionX: prop(0), positionY: prop(0), width: prop(1080), height: prop(1920), scale: prop(1), rotation: prop(0), opacity: prop(1) });
    expect(i.details).not.toHaveProperty('name'); expect(i.details).not.toHaveProperty('gap'); expect(i.details).not.toHaveProperty('borderRadius'); expect(i).not.toHaveProperty('name');
    expect(i.details.cells.map((c: any) => c.bounds)).toEqual([{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 }]);
    for (const c of i.details.cells) expect(c).toMatchObject({ source: null, fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 });
    expect(e.doc.duration).toBe(10000);
    e.bus.undo(); expect(e.doc.items).toHaveLength(0); expect(e.doc.tracks).toHaveLength(0);
  });

  it('6. a tile follows the canvas size (1920 × 1080 and a 1080 × 1080 canvas) and always starts at 0 s, 10 s long', () => {
    for (const size of SIZES) {
      const e = createEditor(build({ tracks: [mkTrack('V1', 'video')], items: [video('v1', 'V1', 0, 30000, 0, 40000)], extra: { size } }));
      e.intent({ type: 'addLayout', layoutType: 'grid-2x2' });
      const i: any = e.doc.items.find(x => x.type === 'layout')!;
      expect(i.display).toEqual({ from: 0, to: 10000 });
      expect([i.properties.width.defaultValue, i.properties.height.defaultValue]).toEqual([size.width, size.height]);
      expect(e.doc.tracks.filter(t => t.kind === 'overlay')).toHaveLength(1); expect(i.details.cells).toHaveLength(4);
    }
  });

  it('7. every one of the 11 presets can be added as a tile; each tile is one undo step with the right cell count', () => {
    for (const id of IDS) {
      const e = createEditor(); e.intent({ type: 'addLayout', layoutType: id });
      expect(e.labels(), id).toEqual(['Add items']);
      expect(cellsOf(e.doc.items[0]).map(c => c.bounds), id).toStrictEqual(SPEC[id][1].map(bounds));
    }
  });
});

describe('T07 cell rectangles against the oracle (§53.3.3, §53.9 rows 8-11)', () => {
  it('8. cellRect equals the oracle for every cell of every preset, 3 canvas sizes, gaps 0, 12 and 40 (box = the canvas)', () => {
    let n = 0;
    for (const id of IDS) for (const size of SIZES) for (const gap of [0, 12, 40]) SPEC[id][1].forEach((b, k) => {
      const want = oracleCellRect(bounds(b), size.width, size.height, gap), got = cellRect(bounds(b), size.width, size.height, gap);
      for (const key of ['x', 'y', 'w', 'h'] as const) near(got[key], want[key]);
      n++;
    });
    expect(n).toBe(28 * 3 * 3);   // 28 cells over the 11 presets, 3 sizes, 3 gaps
  });

  it('9. the formulas by hand: x = bx·W + gap/2, w = bw·W − gap (fixed numbers, 1080 × 1920)', () => {
    expect(cellRect(bounds([0.5, 0, 0.5, 1]), 1080, 1920, 0)).toStrictEqual({ x: 540, y: 0, w: 540, h: 1920 });
    expect(cellRect(bounds([0.5, 0, 0.5, 1]), 1080, 1920, 20)).toStrictEqual({ x: 550, y: 10, w: 520, h: 1900 });
    near(cellRect(bounds([0.65, 0.05, 0.3, 0.3]), 1920, 1080, 0).x, 1248); near(cellRect(bounds([0.65, 0.05, 0.3, 0.3]), 1920, 1080, 0).y, 54);
    near(cellRect(bounds([0.65, 0.05, 0.3, 0.3]), 1920, 1080, 0).w, 576); near(cellRect(bounds([0.65, 0.05, 0.3, 0.3]), 1920, 1080, 0).h, 324);
  });

  it('10. the frame plan draws the layout: cell rects of every preset at 3 canvas sizes match the oracle, with gap 0 and 24 (not Pending)', () => {
    for (const id of IDS) for (const size of SIZES) for (const gap of [0, 24]) {
      const { doc } = project(id, size, gap ? { gap } : {}), plan = framePlan(doc, 1000);
      expect(plan.pending, `${id} ${size.width}x${size.height}`).toEqual([]); expect(plan.draws).toHaveLength(1);
      const d = plan.draws[0]; expect(d.kind).toBe('layout');
      expect(d.layout!.cells).toHaveLength(SPEC[id][1].length);
      d.layout!.cells.forEach((c, k) => {
        const want = oracleCellRect(bounds(SPEC[id][1][k]), size.width, size.height, gap);
        for (const key of ['x', 'y', 'w', 'h'] as const) near(c.rect[key], want[key]);
      });
    }
  });

  it('11. the layout box is its own box: a half-size layout (width/height 540 × 960, scale 1) lays cells out in box px (§53.9 row 11)', () => {
    const { doc } = project('split-horizontal', SIZES[0], { props: { width: 540, height: 960 } }), d = layoutDraw(doc);
    expect([d.box.W, d.box.H]).toEqual([540, 960]);
    expect(d.layout.cells.map(c => c.rect)).toEqual([{ x: 0, y: 0, w: 270, h: 960 }, { x: 270, y: 0, w: 270, h: 960 }]);
  });

  it('12. a gap that swallows a cell (gap ≥ cell size) drops that cell from the draw instead of drawing a negative rectangle', () => {
    const { doc } = project('grid-2x2', { width: 100, height: 100 }, { gap: 60 }); // 0.5 × 100 − 60 < 0
    expect(layoutDraw(doc).layout.cells).toEqual([]);
  });

  it('13. a negative or non-numeric gap / radius in a stored record is treated as 0; the radius reaches every cell', () => {
    const a = layoutDraw(project('split-vertical', SIZES[0], { gap: -10, borderRadius: -4 }).doc);
    expect(a.layout.cells.map(c => [c.rect.y, c.radius])).toEqual([[0, 0], [960, 0]]);
    const b = layoutDraw(project('split-vertical', SIZES[0], { borderRadius: 24 }).doc); expect(b.layout.cells.map(c => c.radius)).toEqual([24, 24]);
    const { doc, rec } = project('split-vertical'); rec.details.gap = 'wide'; expect(layoutDraw(doc).layout.cells[1].rect.y).toBe(960);
  });
});

describe('T07 media in a cell (§53.3.3, §53.9 rows 7, 9, 10)', () => {
  const SRC: [number, number][] = [[1920, 1080], [1080, 1920], [1000, 1000], [3000, 500], [320, 180]];
  const CELLS: B[] = [[0, 0, 0.5, 1], [0, 0, 1, 0.5], [0.65, 0.05, 0.3, 0.3], [0, 0, 1, 1]];
  const lo = (b: B) => oracleCellRect(bounds(b), 1080, 1920, 10);

  it('14. cellMediaRect(cover) = the oracle\'s cellMedia(video, fill) and cellMediaRect(contain) = cellMedia(video, fit) for zoom 50-300, pan ±100', () => {
    let n = 0;
    for (const [w, h] of SRC) for (const cb of CELLS) for (const zoom of [50, 100, 175, 300]) for (const [px, py] of [[0, 0], [100, 0], [-60, 40], [0, -100]]) {
      const c = lo(cb);
      for (const [fit, mode] of [['cover', 'fill'], ['contain', 'fit']] as const) {
        const want = cellMedia('video', mode, w, h, c, zoom, px, py), got = cellMediaRect(fit, w, h, c, zoom, px, py);
        near(got.x, want.x, 1e-7); near(got.y, want.y, 1e-7); near(got.w, want.w, 1e-7); near(got.h, want.h, 1e-7); n++;
      }
    }
    expect(n).toBe(SRC.length * CELLS.length * 4 * 4 * 2);
  });

  it('15. fixed numbers: 1920 × 1080 cover in a 540 × 1920 cell is 3413.33 × 1920 centred; contain is 540 × 303.75 centred; pan 100 moves it half a cell width', () => {
    const c = { x: 0, y: 0, w: 540, h: 1920 };
    const cover = cellMediaRect('cover', 1920, 1080, c); near(cover.w, 1920 * 16 / 9); near(cover.h, 1920); near(cover.x, (540 - 1920 * 16 / 9) / 2); near(cover.y, 0);
    const contain = cellMediaRect('contain', 1920, 1080, c); near(contain.w, 540); near(contain.h, 303.75); near(contain.x, 0); near(contain.y, (1920 - 303.75) / 2);
    near(cellMediaRect('contain', 1920, 1080, c, 100, 100, 0).x - contain.x, 270);
    near(cellMediaRect('contain', 1920, 1080, c, 200).w, 1080);
  });

  it('16. a filled video cell in the frame plan: its rect, fit mapping fill→cover / fit→contain, zoom and pan reach the media draw; it is a draw of the cell item', () => {
    const { doc, rec } = project('split-horizontal', SIZES[0], { gap: 10, fill: { 0: { source: src('video'), fillMode: 'fill', zoom: 150, panX: 20, panY: -10 }, 1: { source: src('video'), fillMode: 'fit' } } });
    const d = layoutDraw(doc), c0 = rec.details.cells[0], c1 = rec.details.cells[1];
    expect(d.layout.cells[0].media).toMatchObject({ fit: 'cover', zoom: 150, panX: 20, panY: -10 });
    expect(d.layout.cells[1].media).toMatchObject({ fit: 'contain', zoom: 100, panX: 0, panY: 0 });
    expect(d.layout.cells[0].media!.draw.item.id).toBe(`L1/${c0.id}`); expect(d.layout.cells[1].media!.draw.item.id).toBe(`L1/${c1.id}`);
    expect(d.layout.cells[0].media!.draw.kind).toBe('video');
  });

  it('17. an empty cell has no media draw; the empty-cell colour is white at 6 % alpha (oracle EMPTY_CELL [1, 1, 1, 0.06])', () => {
    expect(EMPTY_CELL).toBe('rgba(255, 255, 255, 0.06)');
    const { doc } = project('three-vertical'), d = layoutDraw(doc);
    expect(d.layout.cells.map(c => c.media)).toEqual([null, null, null]);
  });

  it('18. cell alpha: cell opacity / 100 (clamped 0-1) times the item opacity as the draw alpha, as the oracle\'s cellAlpha', () => {
    for (const op of [0, 25, 50, 100]) for (const itemOp of [1, 0.5]) {
      const { doc, rec } = project('split-horizontal', SIZES[0], { cell: { opacity: op }, props: { opacity: itemOp } });
      const d = itemDraw(doc, doc.items[0], 1000);
      expect(d && !isPending(d), `op ${op}`).toBe(true);
      const dd = d as Draw & { layout: NonNullable<Draw['layout']> };
      dd.layout.cells.forEach((c, k) => near(c.alpha * dd.alpha, cellAlpha(rec.details.cells[k], itemOp)));
      near(dd.alpha, itemOp);
    }
    const { doc } = project('split-horizontal', SIZES[0], { cell: { opacity: 250 } }); expect(layoutDraw(doc).layout.cells.every(c => c.alpha === 1)).toBe(true);
    const { doc: d2 } = project('split-horizontal', SIZES[0], { cell: { opacity: -40 } }); expect(layoutDraw(d2).layout.cells.every(c => c.alpha === 0)).toBe(true);
  });

  it('19. a layout whose item opacity is 0 draws nothing', () => {
    const { doc } = project('split-horizontal', SIZES[0], { props: { opacity: 0 } });
    expect(itemDraw(doc, doc.items[0], 1000)).toBeNull();
  });

  it('20. cell source time, cellSpeed "ignore" (Xapp\'s export): local + trim.from at any playbackRate - the oracle\'s cellSourceTime', () => {
    LAYOUT_PARITY.cellSpeed = 'ignore';
    for (const [rate, trimFrom, local] of [[1, 0, 4000], [2, 0, 4000], [2, 1500, 3000], [0.5, 800, 5000], [4, 0, 2500]] as const) {
      const { doc, rec } = project('split-horizontal', SIZES[0], { fill: { 0: { source: src('video', { from: trimFrom, to: trimFrom + 20000 }), playbackRate: rate } } });
      expect(layoutDraw(doc, local).layout.cells[0].media!.draw.sourceMs).toBeCloseTo(cellSourceTime(rec.details.cells[0], local), 6);
    }
  });

  it('21. cell source time, cellSpeed "apply" (the default, ticket): local × rate + trim.from', () => {
    for (const [rate, trimFrom, local, want] of [[1, 0, 4000, 4000], [2, 0, 4000, 8000], [2, 1500, 3000, 7500], [0.5, 800, 5000, 3300], [4, 0, 2500, 10000]] as const) {
      const { doc } = project('split-horizontal', SIZES[0], { fill: { 0: { source: src('video', { from: trimFrom, to: trimFrom + 40000 }), playbackRate: rate } } });
      expect(layoutDraw(doc, local).layout.cells[0].media!.draw.sourceMs).toBeCloseTo(want, 6);
    }
    // the cell with no trim starts at 0
    const { doc } = project('split-horizontal', SIZES[0], { fill: { 0: { source: src('video'), playbackRate: 2 } } });
    expect(layoutDraw(doc, 1500).layout.cells[0].media!.draw.sourceMs).toBeCloseTo(3000, 6);
  });

  it('22. imageFit "honour" (default): an image cell in Fit mode is contain, in Fill mode cover; imageFit "cover" (Xapp\'s export, §53.9 row 7) is cover in both', () => {
    const mk = () => project('split-horizontal', SIZES[0], { fill: { 0: { source: src('image', undefined, 'asset-img1'), fillMode: 'fit' }, 1: { source: src('image', undefined, 'asset-img1'), fillMode: 'fill' } } }).doc;
    expect(layoutDraw(mk()).layout.cells.map(c => c.media!.fit)).toEqual(['contain', 'cover']);
    LAYOUT_PARITY.imageFit = 'cover';
    expect(layoutDraw(mk()).layout.cells.map(c => c.media!.fit)).toEqual(['cover', 'cover']);
    // the oracle: an image cell is always cover-led, whatever the stored fill mode
    const c = oracleCellRect(bounds([0, 0, 0.5, 1]), 1080, 1920, 0), a = cellMedia('image', 'fit', 800, 600, c), b = cellMedia('image', 'fill', 800, 600, c);
    expect(a).toEqual(b);
    expect(a).toEqual(cellMedia('video', 'fill', 800, 600, c));
  });

  it('23. a video cell is unaffected by imageFit; a Fill-mode image is cover under either switch', () => {
    for (const sw of ['honour', 'cover'] as const) {
      LAYOUT_PARITY.imageFit = sw;
      const d = layoutDraw(project('split-horizontal', SIZES[0], { fill: { 0: { source: src('video'), fillMode: 'fit' }, 1: { source: src('image', undefined, 'asset-img1'), fillMode: 'fill' } } }).doc);
      expect(d.layout.cells.map(c => c.media!.fit)).toEqual(['contain', 'cover']);
    }
  });

  it('24. an image cell\'s source time is the property time (stills do not advance); an unrecognised source type is not drawn as media', () => {
    const { doc } = project('split-horizontal', SIZES[0], { fill: { 0: { source: src('image', undefined, 'asset-img1') }, 1: { source: { assetId: 'x', type: 'audio', url: 'asset:x' } } } });
    const d = layoutDraw(doc, 5000);
    expect(d.layout.cells[0].media!.draw.kind).toBe('image'); expect(d.layout.cells[1].media).toBeNull();
  });
});

describe('T07 cell items for render, playback, export and audio (timeline/layouts cellItem, withCellItems, exportedMedia)', () => {
  it('25. cellItem: id <layout>/<cell>, the layout\'s track and time, trim start, cell speed as playbackRate, volume / 100, asset id and cell index in metadata', () => {
    const { rec } = project('split-horizontal', SIZES[0], { fill: { 0: { source: src('video', { from: 2000, to: 22000 }, 'asset-vid1'), playbackRate: 2, volume: 150 }, 1: { source: src('image', undefined, 'asset-img1') } } });
    const [a, b] = cellItems(rec), cells = cellsOf(rec);
    expect(a).toMatchObject({ id: `L1/${cells[0].id}`, type: 'video', trackId: 'O1', display: { from: 0, to: 10000 }, playbackRate: 2, trim: { from: 2000, to: 22000 }, metadata: { assetId: 'asset-vid1', layoutId: 'L1', cellIndex: 0 } });
    expect(a!.properties.volume).toStrictEqual({ defaultValue: 1.5, keyframes: [] });
    expect(b).toMatchObject({ id: `L1/${cells[1].id}`, type: 'image', metadata: { assetId: 'asset-img1', cellIndex: 1 } });
    expect(a).not.toHaveProperty('sourceDuration');
  });

  it('26. an empty cell has no cell item; a source with no url or an audio source has none either', () => {
    const { rec } = project('three-horizontal', SIZES[0], { fill: { 1: { source: { assetId: 'a', type: 'video', url: '' } }, 2: { source: { assetId: 'a', type: 'audio', url: 'asset:a' } } } });
    expect(cellItems(rec)).toEqual([null, null, null]); expect(filledCount(rec)).toBe(1);
  });

  it('27. withCellItems appends each layout\'s filled cells after the layout and leaves other items alone; cellSpeed "ignore" gives playbackRate 1', () => {
    const { rec } = project('split-horizontal', SIZES[0], { fill: { 1: { source: src('video'), playbackRate: 3 } } });
    const v = video('v1', 'V1', 0, 1000);
    const out = withCellItems([v, rec, video('v2', 'V1', 1000, 2000)]);
    expect(out.map(i => i.id)).toEqual(['v1', 'L1', `L1/${cellsOf(rec)[1].id}`, 'v2']); expect(out[2].playbackRate).toBe(3);
    LAYOUT_PARITY.cellSpeed = 'ignore'; expect(withCellItems([rec])[1].playbackRate).toBe(1);
    expect(cellItem(rec, cellsOf(rec)[0], 0)).toBeNull();
  });

  it('28. cell trim.to defaults to trim.from + the layout length × cell speed', () => {
    const { rec } = project('split-horizontal', SIZES[0], { fill: { 0: { source: src('video', { from: 1000, to: 2000 }), playbackRate: 2 } } });
    const i = cellItem(rec, cellsOf(rec)[0], 0)!; expect(i.trim).toEqual({ from: 1000, to: 2000 });                          // the explicit trim wins
    const j = layoutRecord({ id: 'L2', trackId: 'O1', display: { from: 0, to: 4000 }, layoutType: 'split-horizontal', width: 100, height: 100 }); cellsOf(j)[0].source = { assetId: 'asset-vid1', type: 'video', url: 'asset:asset-vid1' }; cellsOf(j)[0].playbackRate = 2;
    expect(cellItem(j, cellsOf(j)[0], 0)!.trim).toEqual({ from: 0, to: 8000 });
  });

  it('29. exportedMedia lists a filled cell (video, image) of a visible layout and nothing for empty cells; a hidden track hides its cells', () => {
    const { doc, rec } = project('split-horizontal', SIZES[0], { fill: { 0: { source: src('video') }, 1: { source: src('image', undefined, 'asset-img1') } } });
    expect(exportedMedia(doc).map(i => [i.type, i.metadata!.assetId])).toEqual([['video', 'asset-vid1'], ['image', 'asset-img1']]);
    expect(exportedMedia(project('split-horizontal').doc)).toEqual([]);
    doc.tracks[0].hidden = true; expect(exportedMedia(doc)).toEqual([]);
    expect(rec.details.cells).toHaveLength(2);
  });

  it('30. a layout with filled cells on the harness: the frame plan is drawn (no pending entry, owner "T07" is gone) at every time of its range', () => {
    const e = createEditor(build({ tracks: [mkTrack('O1', 'overlay')], items: [] }), { assets: assets(), links: links() });
    e.intent({ type: 'addLayout', layoutType: 'pip-top-right' });
    const id = e.doc.items[0].id, t = (ms: number) => framePlan(e.doc, ms);
    for (const ms of [0, 4999, 9999]) { const p = t(ms); expect(p.pending, `${ms}`).toEqual([]); expect(p.draws.map(d => d.kind)).toEqual(['layout']); }
    expect(t(10000).draws).toEqual([]);
    expect(id).toBeTruthy(); expect(projectSize(e.doc)).toEqual({ width: 1080, height: 1920 });
  });

  it('31. Q7 default: a cell whose asset was deleted fails the export precheck with UNRESOLVED_MEDIA, naming the cell and the layout preset; the cells are left as stored', async () => {
    const { doc, rec } = project('split-horizontal', SIZES[0], { fill: { 0: { source: src('video') }, 1: { source: src('video', undefined, 'asset-gone') } } });
    const before = JSON.stringify(rec.details.cells), reads: string[] = [];
    const store = { library: async () => ({ assets: assets() }), media: { read: async (id: string) => { reads.push(id); return new Blob(); } } } as never;
    const err: any = await precheck(store, doc).then(() => null, e => e);
    expect(err?.code).toBe('UNRESOLVED_MEDIA');
    expect(err.detail).toBe('Reconnect or re-add the media for Layout cell 2 (Split Horizontal) before exporting.');
    expect(err.data).toEqual({ itemIds: [`L1/${cellsOf(rec)[1].id}`] });
    expect(reads).toEqual([]); expect(JSON.stringify(rec.details.cells)).toBe(before);
    // With the asset back in the library the same document passes the precheck, reading each cell asset once.
    cellsOf(rec)[1].source = src('video', undefined, 'asset-vid2');
    await expect(precheck(store, doc)).resolves.toBeInstanceOf(Map); expect(reads).toEqual(['asset-vid1', 'asset-vid2']);
  });
});
