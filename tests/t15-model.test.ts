// SPDX-License-Identifier: AGPL-3.0-only
// T15 render model (apps/web/src/render/model.ts). Each test names its oracle:
//   "formula oracle"     = parity/oracle/* (the same part 5 §53 formulas, written independently) or fixture frame numbers
//   "written-spec oracle" = a number or rule stated in findings part 5 §53 text
//   "provisional"        = a T15 choice (notes P1-P17), not Xapp parity
import { describe, it, expect } from 'vitest';
import * as app from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import * as oracle from '../parity/oracle/item';

const props = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));
type Tr = { id: string; kind: string; hidden?: boolean; muted?: boolean };
const mkItem = (id: string, type: string, trackId: string, p: Record<string, any> = {}, extra: Record<string, any> = {}) =>
  ({ id, type, trackId, display: { from: 0, to: 10000 }, trim: { from: 0 }, properties: props(p), metadata: { assetId: `a_${id}` }, ...extra });
// One project literal that both implementations read (the app's ProjectDocument and the oracle's Project share the stored shape).
const mkProject = (w: number, h: number, tracks: Tr[], items: any[], extra: Record<string, any> = {}) =>
  ({ schemaVersion: 4, rev: 0, size: { width: w, height: h }, fps: 30, duration: 10000, background: {}, transitions: [], markers: [], tracks, items,
    layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), groups: {}, ...extra });
const A = (p: any) => p as ProjectDocument;
const O = (p: any) => p as oracle.Project;
// Canvas [a, b, c, d, e, f] <-> oracle (m0, m2, m1, m3, m4, m5): the oracle stores rows of the 2x3 matrix, the app stores columns.
const toOracle = (m: app.Mat): oracle.Mat => [m[0], m[2], m[1], m[3], m[4], m[5]];
const close = (a: number[], b: number[], digits = 9) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(10 ** -digits));

describe('T15 box and transform (formula oracle: parity/oracle/item.ts)', () => {
  const tracks: Tr[] = [{ id: 'V1', kind: 'video' }];
  const cases: Record<string, any>[] = [
    {}, { positionX: 100, positionY: 200, width: 400, height: 300 }, { positionX: 100, positionY: 200, width: 400, height: 300, scale: 0.5 },
    { positionX: 100, positionY: 200, width: 400, height: 300, scale: 0.5, rotation: 90 }, { width: 400, height: 300, scaleX: 2, scaleY: 0.5 },
    { width: 400, height: 300, scale: 2, scaleX: 3, scaleY: 4 }, { width: 400, height: 300, flipX: true, rotation: 33, positionX: -50, positionY: 70 },
    { width: 300, height: 500, flipY: true, flipX: true, rotation: -17.5, scale: 1.25 }, { positionX: 10, positionY: 20, width: 0, height: 0 },
    // The written-check inputs of oracle-item.test.ts §53.2.4 (review NB4): rotation 90 at the origin, scale 2 with scaleX 0.5, flipX alone, positionX 10.25.
    { width: 400, height: 300, rotation: 90 }, { width: 400, height: 300, scale: 2, scaleX: 0.5 }, { width: 400, height: 300, flipX: true }, { positionX: 10.25, width: 4, height: 4 },
  ];
  cases.forEach((p, n) => it(`itemBox + boxMatrix + frameScale match the oracle (case ${n}: ${JSON.stringify(p)})`, () => {
    const P = mkProject(1080, 1920, tracks, [mkItem('i', 'image', 'V1', p)]), a = P.items[0];
    const ab = app.itemBox(A(P), a, 0), ob = oracle.itemBox(O(P), a as oracle.Item, 0);
    expect(ab).toEqual(ob);
    const am = app.boxMatrix(ab), om = oracle.boxMatrix(ob);
    close(toOracle(am), om);
    for (const out of [{ width: 1080, height: 1920 }, { width: 540, height: 960 }, { width: 270, height: 480 }, { width: 378, height: 672 }, { width: 720, height: 1280 }]) {
      const af = app.frameScale(A(P), out, am), of = oracle.frameScale(O(P), out, om);
      close(toOracle(af), of);
      for (const [u, v] of [[0, 0], [ab.W, ab.H], [ab.W / 2, ab.H / 3]]) close(app.apply(af, u, v), oracle.apply(of, u, v), 8);
    }
  }));

  // The written numbers of tests/oracle-item.test.ts §53.2.4 (findings part 5 §53.2.4 checks), asserted on the app's own functions.
  it('§53.2.4 written checks on the app: rotation 90 at the origin keeps the centre (200,150); corners; flipX alone maps x=0.5 to 399.5; scale 2 beats scaleX; scaleX 0.5 centres at 10 + 100; 720p is x 2/3 (written-spec oracle)', () => {
    const tr: Tr[] = [{ id: 'V1', kind: 'video' }], P = mkProject(1080, 1920, tr, []);
    const box = (p: Record<string, any>) => app.itemBox(A(P), mkItem('i', 'image', 'V1', p), 0), bounds = (m: app.Mat, W: number, H: number) => {
      const xs = [[0, 0], [W, 0], [0, H], [W, H]].map(([u, v]) => app.apply(m, u, v)); return [Math.min(...xs.map(p => p[0])), Math.max(...xs.map(p => p[0])), Math.min(...xs.map(p => p[1])), Math.max(...xs.map(p => p[1]))];
    };
    const r = app.boxMatrix(box({ width: 400, height: 300, rotation: 90 }));
    close(app.apply(r, 200, 150), [200, 150]); close(app.apply(r, 0, 0), [350, -50]); close(bounds(r, 400, 300), [50, 350, -50, 350]);
    const f = app.boxMatrix(box({ width: 400, height: 300, flipX: true }));
    expect(Math.abs(app.apply(f, 0.5, 150)[0] - 399.5)).toBeLessThanOrEqual(1e-9); expect(bounds(f, 400, 300).slice(0, 2)).toEqual([0, 400]);
    const s2 = box({ width: 400, height: 300, scale: 2, scaleX: 0.5 }), s1 = box({ positionX: 10, width: 400, height: 300, scaleX: 0.5 });
    expect([s2.sx, s2.sy, s1.sx, s1.sy]).toEqual([2, 2, 0.5, 1]);
    expect(app.apply(app.boxMatrix(s1), 200, 150)[0]).toBe(10 + 400 * 0.5 / 2);
    const a = box({ positionX: 100, positionY: 200, width: 400, height: 300, scale: 0.5, rotation: 90 }), ma = app.boxMatrix(a);
    close(app.apply(ma, 200, 150), [200, 275]); close(app.apply(ma, 0, 0), [275, 175]); close(bounds(ma, 400, 300), [125, 275, 175, 375]);
    const m720 = app.frameScale(A(P), { width: 720, height: 1280 }, ma);
    close(app.apply(m720, 200, 150), [200 * 2 / 3, 275 * 2 / 3]); close(app.apply(m720, 0, 0), [275 * 2 / 3, 175 * 2 / 3]);
  });

  it('caption defaults 800 x 100, other items the project size (written-spec oracle: §53.1.4 check)', () => {
    const P = mkProject(1080, 1920, tracks, [mkItem('v', 'video', 'V1'), mkItem('c', 'caption', 'V1')]);
    const v = app.itemBox(A(P), P.items[0], 0), c = app.itemBox(A(P), P.items[1], 0);
    expect([v.W, v.H, c.W, c.H]).toEqual([1080, 1920, 800, 100]);
  });

  it('§53.1.4 check: 400x300 at (100, 200) scale 0.5 covers x 100..300, y 200..350 (written-spec oracle)', () => {
    const P = mkProject(1080, 1920, tracks, [mkItem('i', 'image', 'V1', { positionX: 100, positionY: 200, width: 400, height: 300, scale: 0.5 })]);
    const b = app.itemBox(A(P), P.items[0], 0), m = app.boxMatrix(b);
    expect(app.apply(m, 0, 0)).toEqual([100, 200]);
    expect(app.apply(m, 400, 300)).toEqual([300, 350]);
    expect(app.apply(m, 200, 150)).toEqual([200, 275]);
  });

  it('a keyframed property is read at item-local time (formula oracle; trim 0, rate 1 so local = property time)', () => {
    const it = mkItem('k', 'image', 'V1', {}, { properties: { positionX: { defaultValue: 0, keyframes: [{ time: 0, value: 0 }, { time: 1000, value: 100 }] }, width: { defaultValue: 100, keyframes: [] }, height: { defaultValue: 100, keyframes: [] } } });
    const P = mkProject(1080, 1920, tracks, [it]);
    for (const t of [0, 250, 500, 1000, 2000]) expect(app.itemBox(A(P), it, t).x).toBeCloseTo(oracle.itemBox(O(P), it as oracle.Item, t).x, 9);
    expect(app.itemBox(A(P), it, 500).x).toBeCloseTo(50, 9);
  });

  it('field falls back property -> details -> given fallback (formula oracle)', () => {
    const it = mkItem('d', 'image', 'V1', { positionX: 5 }, { details: { positionX: 9, positionY: 7 } });
    expect(app.field(it, 'positionX', 0, 1)).toBe(oracle.field(it as oracle.Item, 'positionX', 0, 1));
    expect(app.field(it, 'positionY', 0, 1)).toBe(oracle.field(it as oracle.Item, 'positionY', 0, 1));
    expect(app.field(it, 'positionY', 0, 1)).toBe(7);
    expect(app.field(mkItem('e', 'image', 'V1'), 'blur', 0, 4)).toBe(4);
  });
});

describe('T15 media fit and frame pick (formula oracle)', () => {
  it('cover matches the oracle over landscape / portrait / square sources and boxes', () => {
    for (const [sw, sh] of [[1920, 1080], [1080, 1920], [500, 500], [3, 2], [2, 3]]) for (const [W, H] of [[1080, 1920], [400, 300], [300, 400], [200, 200]])
      expect(app.cover(sw, sh, W, H)).toEqual(oracle.cover(sw, sh, W, H));
  });
  it('a source under 2 px is not drawn (written-spec oracle: §53.3)', () => {
    expect(app.cover(1, 100, 100, 100)).toBeNull();
    expect(app.cover(100, 1, 100, 100)).toBeNull();
    expect(app.cover(2, 2, 100, 100)).not.toBeNull();
  });
  it('cover fills the box and is centred (written-spec oracle: §53.3 cover, centred)', () => {
    const r = app.cover(1920, 1080, 1080, 1920)!;
    expect(r.h).toBe(1920); expect(r.w).toBeCloseTo(1920 * 1920 / 1080, 6); expect(r.x).toBeCloseTo((1080 - r.w) / 2, 6); expect(r.y).toBe(0);
    const p = app.cover(1080, 1920, 400, 300)!;
    expect(p.w).toBe(400); expect(p.y).toBeCloseTo((300 - p.h) / 2, 6);
  });
  it('stretch is the whole box (formula oracle)', () => { expect(app.stretch(400, 300)).toEqual(oracle.stretch(400, 300)); });
  it('pickFrame matches the oracle: last frame <= request + 0.1 ms, before the first the first', () => {
    const ts = [0, 33.333, 66.667, 100, 133.333];
    for (const r of [-5, 0, 33.2, 33.3, 33.4, 66.6, 99.95, 100, 100.05, 100.2, 133.4, 1e6]) expect(app.pickFrame(ts, r)).toBe(oracle.pickFrame(ts, r));
    expect(app.pickFrame([10, 20], 5)).toBe(0);
    expect(app.pickFrame([], 5)).toBe(0);
  });
  it('effectiveRadius is min(r, W/2, H/2) (formula oracle)', () => {
    for (const [r, W, H] of [[0, 100, 100], [10, 100, 100], [80, 100, 40], [80, 40, 100], [-3, 100, 100]]) expect(app.effectiveRadius(r, W, H)).toBe(oracle.effectiveRadius(r, W, H));
  });
});

describe('T15 blend names (written-spec oracle: §53.6.1)', () => {
  const names = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
  it('the 16 stored names, in order', () => { expect([...app.BLENDS]).toEqual(names); });
  it('each name maps 1:1 to the composite operation; normal = source-over', () => {
    for (const n of names) expect(app.compositeOp(n)).toBe(n === 'normal' ? 'source-over' : n);
  });
  it('an unknown or missing mode is source-over', () => {
    for (const m of ['Multiply', 'bogus', '', undefined, null, 3]) expect(app.compositeOp(m)).toBe('source-over');
  });
});

describe('T15 CSS chain (written-spec oracle: §53.4.3 blur > 0 px, then brightness != 1 as a percentage)', () => {
  const ch = (p: Record<string, any>) => app.cssChain(mkItem('c', 'video', 'V1', p), 0);
  it('empty when neither applies', () => { expect(ch({})).toBe(''); expect(ch({ blur: 0, brightness: 1 })).toBe(''); expect(ch({ blur: -2 })).toBe(''); });
  it('blur then brightness', () => {
    expect(ch({ blur: 4 })).toBe('blur(4px)');
    expect(ch({ brightness: 0.5 })).toBe('brightness(50%)');
    expect(ch({ blur: 2.5, brightness: 1.2 })).toBe('blur(2.5px) brightness(120%)');
  });
});

describe('T15 stacking (formula oracle: drawTracks / trackItems / isVisible; §53.5.6 checks)', () => {
  const tracks: Tr[] = [{ id: 'A1', kind: 'audio' }, { id: 'V1', kind: 'video' }, { id: 'V2', kind: 'video' }, { id: 'O1', kind: 'overlay' }, { id: 'C1', kind: 'caption' }];
  const items = tracks.map(t => mkItem(`i_${t.id}`, t.kind === 'audio' ? 'audio' : t.kind === 'video' ? 'video' : t.kind === 'overlay' ? 'text' : 'caption', t.id));
  it('layerOrder [A1, V1, V2, O1, C1] draws V1, V2, O1, C1 (written-spec oracle: §53.5.6)', () => {
    const P = mkProject(1080, 1920, tracks, items);
    expect(app.drawTracks(A(P))).toEqual(['V1', 'V2', 'O1', 'C1']);
    expect(app.drawTracks(A(P))).toEqual(oracle.drawTracks(O(P)).map(t => t.id));
  });
  it('a hidden group [V2, O1] leaves V1 and C1 (written-spec oracle: §53.5.6)', () => {
    const P = mkProject(1080, 1920, tracks, items, { layerOrder: [{ type: 'track', id: 'A1' }, { type: 'track', id: 'V1' }, { type: 'group', id: 'G' }, { type: 'track', id: 'C1' }], groups: { G: { id: 'G', hidden: true, children: [{ type: 'track', id: 'V2' }, { type: 'track', id: 'O1' }] } } });
    expect(app.drawTracks(A(P))).toEqual(['V1', 'C1']);
    expect(app.drawTracks(A(P))).toEqual(oracle.drawTracks(O(P)).map(t => t.id));
  });
  it('moving V1 to the end of the list puts it above C1 (written-spec oracle: §53.5.6)', () => {
    const P = mkProject(1080, 1920, tracks, items, { layerOrder: ['A1', 'V2', 'O1', 'C1', 'V1'].map(id => ({ type: 'track', id })) });
    expect(app.drawTracks(A(P)).at(-1)).toBe('V1');
    expect(app.drawTracks(A(P))).toEqual(oracle.drawTracks(O(P)).map(t => t.id));
  });
  it('hidden track skipped; muted / solo / locked do not stop drawing (written-spec oracle: §53.5.2)', () => {
    const t2: Tr[] = [{ id: 'V1', kind: 'video', hidden: true }, { id: 'V2', kind: 'video', muted: true }, { id: 'V3', kind: 'video', locked: true } as Tr, { id: 'V4', kind: 'video', solo: true } as Tr];
    const P = mkProject(1080, 1920, t2, []);
    expect(app.drawTracks(A(P))).toEqual(['V2', 'V3', 'V4']);
  });
  it('items of one track: stable sort by display.from, zIndex ignored (formula oracle)', () => {
    const its = [mkItem('b', 'text', 'O1', {}, { display: { from: 0, to: 5000 }, properties: { ...props({}), zIndex: { defaultValue: 0, keyframes: [] } } }),
      mkItem('a', 'text', 'O1', {}, { display: { from: 0, to: 5000 }, properties: { zIndex: { defaultValue: 5, keyframes: [] } } }),
      mkItem('c', 'text', 'O1', {}, { display: { from: 2000, to: 3000 } }), mkItem('z', 'text', 'O1', {}, { display: { from: -100, to: 3000 } })];
    const P = mkProject(1080, 1920, [{ id: 'O1', kind: 'overlay' }], its);
    const ids = app.trackItems(A(P), 'O1').map(i => i.id);
    expect(ids).toEqual(['z', 'b', 'a', 'c']);
    expect(ids).toEqual(oracle.trackItems(O(P), 'O1').map(i => i.id));
  });
  it('visibility is half-open: [1000, 2000) at 30 fps shows frames 30..59 (written-spec oracle: §53.5.6)', () => {
    const it = mkItem('v', 'video', 'V1', {}, { display: { from: 1000, to: 2000 } });
    const shown = (n: number) => app.isVisible(it, app.frameTime(n, 30));
    expect(shown(29)).toBe(false);
    for (const n of [30, 31, 59]) expect(shown(n)).toBe(true);
    expect(shown(60)).toBe(false);
    for (const t of [999, 1000, 1500, 1999.999, 2000, 2001]) expect(app.isVisible(it, t)).toBe(oracle.isVisible(it as oracle.Item, t));
  });
  it('overlapping clips: the later start is drawn last, so on top (written-spec oracle: §53.5.3 / §53.5.6)', () => {
    const P = mkProject(1080, 1920, [{ id: 'V1', kind: 'video' }], [mkItem('first', 'video', 'V1', {}, { display: { from: 0, to: 3000 } }), mkItem('second', 'video', 'V1', {}, { display: { from: 2000, to: 5000 } })]);
    expect(app.framePlan(A(P), 2500).draws.map(d => d.item.id)).toEqual(['first', 'second']);
    expect(app.framePlan(A(P), 1500).draws.map(d => d.item.id)).toEqual(['first']);
    expect(app.framePlan(A(P), 3500).draws.map(d => d.item.id)).toEqual(['second']);
  });
  it('an item with opacity <= 0 draws nothing; audio items never draw (written-spec oracle: §53.5.3)', () => {
    const P = mkProject(1080, 1920, [{ id: 'V1', kind: 'video' }, { id: 'A1', kind: 'audio' }], [mkItem('v', 'video', 'V1', { opacity: 0 }), mkItem('w', 'video', 'V1', { opacity: 0.5 }), mkItem('au', 'audio', 'A1')]);
    const plan = app.framePlan(A(P), 100);
    expect(plan.draws.map(d => d.item.id)).toEqual(['w']);
    expect(plan.draws[0].alpha).toBe(0.5);
    expect(plan.pending).toEqual([]);
  });
});

describe('T15 preview runs (written-spec oracle: §53.5.5)', () => {
  const V = (id: string): Tr => ({ id, kind: 'video' });
  const mk = (id: string, type = 'video') => mkItem(`i_${id}`, type, id);
  it('consecutive video tracks share one run; an overlay with a caption item ends it (T05: a text overlay is a canvas track and no longer does)', () => {
    const tracks = [V('V1'), V('V2'), { id: 'O1', kind: 'overlay' }, V('V3')];
    const P = mkProject(1080, 1920, tracks, [mk('V1'), mk('V2'), mk('O1', 'caption'), mk('V3')]);
    expect(app.previewRuns(A(P)).map(r => r.trackIds)).toEqual([['V1', 'V2'], ['V3']]);
  });
  it('an overlay with a text item does NOT end the run: a text is a canvas draw now (T05), like MG and shapes (render/model.ts preview-run rule)', () => {
    const tracks = [V('V1'), V('V2'), { id: 'O1', kind: 'overlay' }, V('V3')];
    const P = mkProject(1080, 1920, tracks, [mk('V1'), mk('V2'), mk('O1', 'text'), mk('V3')]);
    expect(app.previewRuns(A(P)).map(r => r.trackIds)).toEqual([['V1', 'V2', 'O1', 'V3']]);
  });
  it('empty, hidden and audio tracks are skipped and do not break a run', () => {
    const tracks = [V('V1'), V('V2'), { id: 'O1', kind: 'overlay' }, { id: 'A1', kind: 'audio' }, V('V3'), V('V4')];
    const P = mkProject(1080, 1920, tracks, [mk('V1'), mk('V3'), mk('V4'), mk('A1', 'audio')]);
    expect(app.previewRuns(A(P)).map(r => r.trackIds)).toEqual([['V1', 'V3', 'V4']]);
    const hid = mkProject(1080, 1920, [V('V1'), { ...V('V2'), hidden: true }, V('V3')], [mk('V1'), mk('V2'), mk('V3')]);
    expect(app.previewRuns(A(hid)).map(r => r.trackIds)).toEqual([['V1', 'V3']]);
  });
  it('no items, no runs; a caption track with items splits the video tracks around it', () => {
    expect(app.previewRuns(A(mkProject(1080, 1920, [V('V1')], [])))).toEqual([]);
    const P = mkProject(1080, 1920, [V('V1'), { id: 'C1', kind: 'caption' }, V('V2')], [mk('V1'), mk('C1', 'caption'), mk('V2')]);
    expect(app.previewRuns(A(P)).map(r => r.trackIds)).toEqual([['V1'], ['V2']]);
  });
});

describe('T15 export plan (formula oracle: exportPlan / planTime / encodedTime; §53.8.2 checks)', () => {
  const V1: Tr[] = [{ id: 'V1', kind: 'video' }];
  const plan = (fps: number, duration: number, from = 0, range?: { startS: number; endS: number }) => {
    const P = mkProject(1080, 1920, V1, [mkItem('v', 'video', 'V1', {}, { display: { from, to: duration } })], { fps, duration });
    return { a: app.exportPlan(A(P), range), o: oracle.exportPlan(O(P), range) };
  };
  it('matches the oracle for assorted fps, durations, shifts and ranges', () => {
    for (const [fps, d, from] of [[30, 10000, 0], [30, 10033, 0], [30, 10000, 2000], [29.97, 10000, 0], [24, 8000, 1], [60, 2500, 1.5]] as const) {
      const { a, o } = plan(fps, d, from);
      expect(a).toEqual(o);
      for (const n of [0, 1, a.count - 1]) { expect(app.planTime(a, n)).toBe(oracle.planTime(o, n)); expect(app.encodedTime(a, n)).toBe(oracle.encodedTime(o, n)); }
    }
    const { a, o } = plan(30, 10000, 0, { startS: 1, endS: 2 });
    expect(a).toEqual(o);
    expect(a).toEqual({ fps: 30, first: 30, count: 30, shiftMs: 0 });
  });
  it('written-spec checks: 10 s at 30 fps = 300 frames; 10.033 s = 301; a 2 s leading gap shifts and leaves 240 frames at 10 s', () => {
    expect(plan(30, 10000).a.count).toBe(300);
    expect(plan(30, 10033).a.count).toBe(301);
    const g = plan(30, 10000, 2000).a;
    expect([g.shiftMs, g.count]).toEqual([2000, 240]);
    expect(plan(29.97, 10000).a.count).toBe(300);
  });
  // §53.8.4 checks (findings part 5 l.503-510), written-spec oracle.
  it('§53.8.4: an item [0, 10 010) ms at 30 fps = 301 frames and frame 300 (t = 10 000 ms) still shows it', () => {
    const P = mkProject(1080, 1920, V1, [mkItem('v', 'video', 'V1', {}, { display: { from: 0, to: 10010 } })], { fps: 30, duration: 10010 });
    const p = app.exportPlan(A(P));
    expect(p.count).toBe(301);
    const t = app.planTime(p, 300);
    expect(t).toBe(10000);
    expect(app.framePlan(A(P), t).draws.map(d => d.item.id)).toEqual(['v']);
    expect(app.framePlan(A(P), app.planTime(p, 301)).draws).toEqual([]); // one past the last frame: the item is gone
  });
  it('§53.8.4: fps 29.97, 10 s = 300 frames (ceil 299.7); frame 299 is at 9976.64 ms', () => {
    const p = plan(29.97, 10000).a;
    expect(p.count).toBe(300);
    expect(app.planTime(p, 299)).toBeCloseTo(9976.64, 2);
  });
  it('§53.8.4: a range of 1.0-2.0 s at 30 fps = frames 30 ... 59, encoded timestamps 0 ... 0.9667 s', () => {
    const p = plan(30, 10000, 0, { startS: 1, endS: 2 }).a;
    expect([p.first, p.count, p.first + p.count - 1]).toEqual([30, 30, 59]);
    expect(app.encodedTime(p, p.first)).toBe(0);
    expect(app.encodedTime(p, 59)).toBeCloseTo(0.9667, 4);
    expect(app.planTime(p, 30)).toBe(1000); // the range's first frame shows t = 1 s, with no shift
  });
  it('§53.8.4: earliest item at 2000 ms shifts the export (frame 0 shows t = 2000 ms, 2 s shorter); at 0.8 ms there is no shift', () => {
    const shifted = plan(30, 10000, 2000).a;
    expect(shifted.shiftMs).toBe(2000);
    expect(app.planTime(shifted, 0)).toBe(2000);
    expect(shifted.count).toBe(240);
    const unshifted = plan(30, 10000, 0.8).a;
    expect(unshifted.shiftMs).toBe(0);
    expect(app.planTime(unshifted, 0)).toBe(0);
    expect(unshifted.count).toBe(300);
  });
});

describe('T15 preview clock (formula oracle: round(t s x fps); halves up)', () => {
  it('previewFrame is round(t s x fps) for assorted times and rates', () => {
    for (const fps of [24, 25, 30, 60]) for (const t of [0, 1, 16, 33.3, 40, 41.7, 999, 1000, 4321.5, 10000]) expect(app.previewFrame(t, fps)).toBe(Math.round(t / 1000 * fps));
  });
  it('an exact half frame rounds up (fps 2: 250 ms = 0.5 -> 1; 750 ms = 1.5 -> 2; fps 10: 50 ms -> 1)', () => {
    expect(app.previewFrame(250, 2)).toBe(1);
    expect(app.previewFrame(750, 2)).toBe(2);
    expect(app.previewFrame(50, 10)).toBe(1);
    expect(app.previewFrame(249.9, 2)).toBe(0);
  });
  it('snapTime = the time of the frame previewFrame picks, and is idempotent', () => {
    expect(app.snapTime(1000 / 30 * 3.4, 30)).toBeCloseTo(app.frameTime(3, 30), 9);
    expect(app.snapTime(1000 / 30 * 3.6, 30)).toBeCloseTo(app.frameTime(4, 30), 9);
    for (const t of [0, 17, 500, 1234.5]) expect(app.snapTime(app.snapTime(t, 30), 30)).toBeCloseTo(app.snapTime(t, 30), 9);
  });
  it('fps defaults to 30', () => { expect(app.fpsOf({ fps: 0 })).toBe(30); expect(app.fpsOf({ fps: 24 })).toBe(24); });
});

describe('T15 canvasSize (written-spec oracle: §53.8.3; q = max(0.1, min(1, quality, display)); size = max(2, round(project x q)))', () => {
  const P = { width: 1080, height: 1920 };
  const expected = (quality: 'full' | 'half' | 'quarter', onscreen: { width: number; height: number }, dpr: number) => {
    const f = { full: 1, half: 0.5, quarter: 0.25 }[quality], display = Math.max(onscreen.width * dpr / P.width, onscreen.height * dpr / P.height);
    const q = Math.max(0.1, Math.min(1, f, display));
    return { width: Math.max(2, Math.round(P.width * q)), height: Math.max(2, Math.round(P.height * q)) };
  };
  it('paused = the project size, whatever quality / display / dpr', () => {
    for (const quality of ['full', 'half', 'quarter'] as const) expect(app.canvasSize(P, false, quality, { width: 50, height: 90 }, 3)).toEqual(P);
  });
  it('quality factors are 1, 0.5, 0.25', () => { expect(app.QUALITY_FACTOR).toEqual({ full: 1, half: 0.5, quarter: 0.25 }); });
  it('playing follows the formula over quality x on-screen size x dpr', () => {
    for (const quality of ['full', 'half', 'quarter'] as const) for (const onscreen of [{ width: 1080, height: 1920 }, { width: 400, height: 711 }, { width: 100, height: 178 }, { width: 3000, height: 3000 }, { width: 10, height: 10 }]) for (const dpr of [1, 1.5, 2, 3])
      expect(app.canvasSize(P, true, quality, onscreen, dpr)).toEqual(expected(quality, onscreen, dpr));
  });
  it('display never exceeds quality: a huge screen at half is 540 x 960; at quarter 270 x 480; full is the project size', () => {
    const big = { width: 5000, height: 5000 };
    expect(app.canvasSize(P, true, 'half', big, 2)).toEqual({ width: 540, height: 960 });
    expect(app.canvasSize(P, true, 'quarter', big, 2)).toEqual({ width: 270, height: 480 });
    expect(app.canvasSize(P, true, 'full', big, 2)).toEqual(P);
  });
  it('a small display lowers the size, with a floor of 0.1 and 2 px', () => {
    expect(app.canvasSize(P, true, 'full', { width: 54, height: 96 }, 1)).toEqual({ width: 108, height: 192 });
    expect(app.canvasSize(P, true, 'full', { width: 1, height: 1 }, 1)).toEqual({ width: 108, height: 192 });
    expect(app.canvasSize({ width: 10, height: 10 }, true, 'full', { width: 1, height: 1 }, 1)).toEqual({ width: 2, height: 2 });
  });
});

describe('T15 frame plan and the pending list (provisional: notes "Deferrals" and the stage "Not rendered yet" note)', () => {
  const V1: Tr[] = [{ id: 'V1', kind: 'video' }, { id: 'O1', kind: 'overlay' }];
  const pending = (type: string, extra: Record<string, any> = {}) => {
    const P = mkProject(1080, 1920, V1, [mkItem('p', type, 'O1', {}, extra)]);
    return app.framePlan(A(P), 100).pending;
  };
  // T05 + T07 (assertion-only edits): text and layouts are draws now, so neither is pending; only captions (T09) remain.
  const owners: [string, string][] = [['caption', 'T09']];
  owners.forEach(([type, owner]) => it(`a ${type} item is pending on ${owner} and not drawn (provisional)`, () => {
    const P = mkProject(1080, 1920, V1, [mkItem('p', type, 'O1')]), plan = app.framePlan(A(P), 100);
    expect(plan.draws).toEqual([]);
    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0]).toMatchObject({ itemId: 'p', owner });
  }));
  it('T08: an MG without code is an empty graphic (nothing drawn, nothing pending)', () => {
    const P = mkProject(1080, 1920, V1, [mkItem('p', 'motionGraphic', 'O1', {}, { details: { name: 'Motion graphic' } })]), plan = app.framePlan(A(P), 100);
    expect(plan.draws).toEqual([]);
    expect(plan.pending).toEqual([]);
  });
  // T10/T12 (C8 assertion-only edit): effects and masks both render now, so neither is pending.
  it('a video with a non-stacked-alpha effect the registry does not know is pending (unknown effect); masks render (T12)', () => {
    const fx = { id: 'e', effectId: 'blur', enabled: true, order: 0, parameters: {} };
    expect(pending('video', { effects: [fx] })).toMatchObject([{ owner: '?', what: "Unknown effect 'blur'" }]);
    expect(pending('video', { masks: [{ id: 'm', enabled: true }] })).toEqual([]);
    expect(pending('video', { effects: [{ ...fx, enabled: false }] })).toEqual([]);
    expect(pending('video', { masks: [{ id: 'm', enabled: false }] })).toEqual([]);
  });
  it('an unknown item type is pending with owner "?" (provisional)', () => { expect(pending('hologram')).toMatchObject([{ owner: '?' }]); });
  it('an invisible pending item is not reported (opacity 0 or outside its span)', () => {
    const P = mkProject(1080, 1920, V1, [mkItem('p', 'text', 'O1', { opacity: 0 }), mkItem('q', 'text', 'O1', {}, { display: { from: 5000, to: 6000 } })]);
    expect(app.framePlan(A(P), 100).pending).toEqual([]);
  });
});

describe('T15 stored transitions are listed as pending on T11 inside their window (written-spec oracle: findings part 5 §55.2 table l.1041-1054; results §11 decision 1: the preview renders them, so until T11 they are "not rendered yet")', () => {
  const tracks: Tr[] = [{ id: 'V1', kind: 'video' }, { id: 'V2', kind: 'video' }];
  // outgoing clip [0, 3000) and incoming clip [3000, 6000) on V1: the cut is 3000.
  const withTransition = (record: Record<string, any>) => A(mkProject(1080, 1920, tracks,
    [mkItem('out', 'video', 'V1', {}, { display: { from: 0, to: 3000 } }), mkItem('in', 'video', 'V1', {}, { display: { from: 3000, to: 6000 } })],
    { transitions: [{ id: 'tr1', trackId: 'V1', fromId: 'out', toId: 'in', kind: 'dissolve', durationMs: 1000, alignment: 0.5, ...record }] }));
  // T11 (C8 assertion-only edit): transitions render now, so inside the window the pair is drawn, tagged with the record's id,
  // and nothing is pending on T11; the windows below are unchanged.
  const listed = (doc: ProjectDocument, t: number, trackIds?: string[]) => {
    const plan = app.framePlan(doc, t, undefined, trackIds);
    expect(plan.pending.filter(p => p.owner === 'T11')).toEqual([]);
    return [...new Set(plan.draws.flatMap(d => d.transition ? [d.transition.id] : []))];
  };
  const PENDING = 'tr1';
  // [alignment, window] from the §55.2 table, D = 1000, cut = 3000: End [cut - D, cut), Center [cut - D/2, cut + D/2), Start [cut, cut + D).
  const table: [number, [number, number]][] = [[1, [2000, 3000]], [0.5, [2500, 3500]], [0, [3000, 4000]]];
  table.forEach(([alignment, [from, to]]) => it(`alignment ${alignment}: listed on [${from}, ${to}) and not at ${from - 1} or ${to} (half-open)`, () => {
    const doc = withTransition({ alignment });
    expect(listed(doc, from - 1)).toEqual([]);
    for (const t of [from, from + 1, Math.floor((from + to) / 2), to - 1]) expect(listed(doc, t), `t ${t}`).toEqual([PENDING]);
    expect(listed(doc, to)).toEqual([]);
  }));
  it('an odd duration at Center: D 1995 is 997 ms before the cut and 998 after (window [2003, 3998))', () => {
    const doc = withTransition({ durationMs: 1995, alignment: 0.5 });
    expect([2002, 2003, 3997, 3998].map(t => listed(doc, t).length)).toEqual([0, 1, 1, 0]);
  });
  it('a record without durationMs is 1000 ms and without alignment 0.5; alignment is clamped to [0, 1]; durationMs is floored with a minimum of 1 ms', () => {
    const bare = withTransition({ durationMs: undefined, alignment: undefined });
    expect([2499, 2500, 3499, 3500].map(t => listed(bare, t).length)).toEqual([0, 1, 1, 0]);
    expect([2999, 3000, 3999, 4000].map(t => listed(withTransition({ alignment: -3 }), t).length)).toEqual([0, 1, 1, 0]);
    expect([1999, 2000, 2999, 3000].map(t => listed(withTransition({ alignment: 7 }), t).length)).toEqual([0, 1, 1, 0]);
    expect([2999, 3000, 3001].map(t => listed(withTransition({ durationMs: 0.4, alignment: 0 }), t).length)).toEqual([0, 1, 0]);
  });
  it('a transition on a track outside trackIds is not listed (one preview run walks its own tracks)', () => {
    const doc = withTransition({});
    expect(listed(doc, 3000, ['V2'])).toEqual([]);
    expect(listed(doc, 3000, ['V1'])).toEqual([PENDING]);
    expect(listed(doc, 3000)).toEqual([PENDING]);
  });
  it('a transition whose incoming clip is missing is not listed', () => { expect(listed(withTransition({ toId: 'gone' }), 3000)).toEqual([]); });
  // T11 (C8 assertion-only edit): inside the window both clips are drawn, outgoing first; outside it the cut stays hard.
  it('the draws stay a hard cut: the outgoing clip before the cut, the incoming one from the cut (§53.5.3 visibility is half-open)', () => {
    const doc = withTransition({ alignment: 0.5 });
    for (const [t, ids] of [[2499, ['out']], [2500, ['out', 'in']], [2999, ['out', 'in']], [3000, ['out', 'in']], [3499, ['out', 'in']], [3500, ['in']]] as const) expect(app.framePlan(doc, t).draws.map(d => d.item.id), `t ${t}`).toEqual(ids);
  });
});

describe('T15 playback element thresholds scale with the clip speed (provisional T15 rule, not Xapp parity; review NB8): mediaFrame and catchUpNudge', () => {
  it('rate 1 is a no-op: mediaFrame(fps, 1) is exactly 1 / fps at 24, 25, 30 and 60', () => {
    for (const fps of [24, 25, 30, 60]) expect(app.mediaFrame(fps, 1)).toBe(1 / fps);
  });
  it('rate 1: catchUpNudge equals the former rule (beyond one frame +-1, within half a frame 0, else kept) over a grid of offsets and nudges', () => {
    const former = (off: number, nudge: number, oneFrame: number) => { const drift = Math.abs(off); return drift > oneFrame ? (off < 0 ? 1 : -1) : drift < oneFrame / 2 ? 0 : nudge; };
    for (const fps of [24, 25, 30, 60]) for (let k = -300; k <= 300; k++) for (const nudge of [-1, 0, 1]) {
      const off = k / 2000;
      expect(app.catchUpNudge(off, nudge, app.mediaFrame(fps, 1)), `fps ${fps} off ${off} nudge ${nudge}`).toBe(former(off, nudge, 1 / fps));
    }
  });
  it('rate 2 at 30 fps (a media frame is 2/30 s): 0.05 s keeps the nudge, -0.07 s nudges +1, 0.07 s nudges -1, 0.02 s resets to 0', () => {
    const frame = app.mediaFrame(30, 2);
    expect(frame).toBeCloseTo(2 / 30, 12);
    for (const n of [0, 1]) expect(app.catchUpNudge(0.05, n, frame)).toBe(n);
    expect(app.catchUpNudge(-0.05, 1, frame)).toBe(1);
    expect(app.catchUpNudge(-0.07, 0, frame)).toBe(1);
    expect(app.catchUpNudge(0.07, 0, frame)).toBe(-1);
    expect(app.catchUpNudge(0.02, 1, frame)).toBe(0);
  });
  it('rate 1 at 30 fps: 0.05 s is beyond one frame (1/30), so an element ahead of the clock nudges -1', () => {
    expect(app.catchUpNudge(0.05, 0, app.mediaFrame(30, 1))).toBe(-1);
    expect(app.catchUpNudge(-0.05, 0, app.mediaFrame(30, 1))).toBe(1);
  });
});

describe('T15 stacked-alpha marker (provisional P1: effect entry effectId "stacked-alpha", video items only)', () => {
  const entry = (effectId: string, enabled = true) => ({ id: 'e', effectId, enabled, order: 0, parameters: {} });
  it('the marker id', () => { expect(app.STACKED_ALPHA_EFFECT).toBe('stacked-alpha'); });
  it('isStackedAlpha: enabled marker on a video item', () => {
    expect(app.isStackedAlpha(mkItem('v', 'video', 'V1', {}, { effects: [entry('stacked-alpha')] }))).toBe(true);
    expect(app.isStackedAlpha(mkItem('v', 'video', 'V1', {}, { effects: [entry('stacked-alpha', false)] }))).toBe(false);
    expect(app.isStackedAlpha(mkItem('v', 'video', 'V1', {}, { effects: [entry('blur')] }))).toBe(false);
    expect(app.isStackedAlpha(mkItem('v', 'video', 'V1'))).toBe(false);
    expect(app.isStackedAlpha(mkItem('i', 'image', 'V1', {}, { effects: [entry('stacked-alpha')] }))).toBe(false);
  });
  it('the marker alone does not make an item pending, and the draw is flagged stackedAlpha', () => {
    const P = mkProject(1080, 1920, [{ id: 'V1', kind: 'video' }], [mkItem('v', 'video', 'V1', {}, { effects: [entry('stacked-alpha')] })]);
    const plan = app.framePlan(A(P), 100);
    expect(plan.pending).toEqual([]);
    expect(plan.draws.map(d => d.stackedAlpha)).toEqual([true]);
  });
  // T10 (C8 assertion-only edit): effects render now; 'blur' is no registry id, so the item is pending as an unknown effect.
  it('the marker plus an effect the registry does not know is pending (unknown effect, not T10)', () => {
    const P = mkProject(1080, 1920, [{ id: 'V1', kind: 'video' }], [mkItem('v', 'video', 'V1', {}, { effects: [entry('stacked-alpha'), entry('blur')] })]);
    expect(app.framePlan(A(P), 100).pending).toMatchObject([{ owner: '?', what: "Unknown effect 'blur'" }]);
  });
});

describe('T15 draw record (formula oracle for geometry; written-spec for the rest)', () => {
  it('a video draw: matrix = frameScale(boxMatrix), source time from the trim clock, direct path unless a CSS chain exists', () => {
    const P = mkProject(1080, 1920, [{ id: 'V1', kind: 'video' }], [mkItem('v', 'video', 'V1', { positionX: 40, positionY: 60, width: 500, height: 300, rotation: 15 }, { display: { from: 1000, to: 5000 }, trim: { from: 2000 } })]);
    const out = { width: 540, height: 960 }, d = app.framePlan(A(P), 2000, out).draws[0], o = P.items[0] as oracle.Item;
    expect(d.local).toBe(1000);
    expect(d.sourceMs).toBeCloseTo(oracle.sourceTime(o, 1000), 9);
    expect(d.sourceMs).toBeCloseTo(3000, 9);
    close(toOracle(d.matrix), oracle.frameScale(O(P), out, oracle.boxMatrix(oracle.itemBox(O(P), o, oracle.propertyTime(o, 1000)))));
    expect(d.path).toBe('direct'); expect(d.filter).toBe(''); expect(d.border).toBeNull(); expect(d.blend).toBe('source-over');
  });
  it('blur / blend / border / radius reach the draw; blur switches to the css path', () => {
    const P = mkProject(1080, 1920, [{ id: 'V1', kind: 'video' }], [mkItem('v', 'video', 'V1', { blur: 3, blendMode: 'multiply', borderWidth: 4, borderColor: '#ff0000', borderRadius: 25, opacity: 0.4 })]);
    const d = app.framePlan(A(P), 0).draws[0];
    expect(d).toMatchObject({ filter: 'blur(3px)', path: 'css', blend: 'multiply', border: { width: 4, color: '#ff0000' }, radius: 25, alpha: 0.4 });
  });
  it('an image draw uses property time and is not stacked-alpha', () => {
    const P = mkProject(1080, 1920, [{ id: 'V1', kind: 'video' }], [mkItem('i', 'image', 'V1', {}, { display: { from: 500, to: 4000 }, trim: { from: 100 } })]);
    const d = app.framePlan(A(P), 1500).draws[0];
    expect(d).toMatchObject({ kind: 'image', local: 1000, sourceMs: 1100, stackedAlpha: false });
  });
  it('a zero-area box draws nothing', () => {
    const P = mkProject(1080, 1920, [{ id: 'V1', kind: 'video' }], [mkItem('v', 'video', 'V1', { scale: 1, scaleX: 0 })]);
    expect(app.framePlan(A(P), 0).draws).toEqual([]);
  });
  it('MISSING_MEDIA is #374151 (written-spec oracle: §53.3 / oracle MISSING_MEDIA)', () => {
    expect(app.MISSING_MEDIA).toBe('#374151');
    expect(oracle.MISSING_MEDIA.map(v => Math.round(v * 255))).toEqual([0x37, 0x41, 0x51, 255]);
  });
});
