// SPDX-License-Identifier: AGPL-3.0-only
// T08 motion graphics in the T15 render model (apps/web/src/render/model.ts): the MG clock, the box, pending / null rules, preview runs and a split.
// Oracle: findings §16 addendum ("frame mapping after a start trim; clamp at the designed end; a split continues the graphic; preview and export give the
// same frame for the same timeline time"), ticket T08 "MG clock", D25, findings part 5 §53.1 (a width / height of 0 or missing falls back to the project size).
// Expected numbers below are worked out by hand from the clock rule, not read from the code:
//   graphic ms = clamp(t - clipStart + trimStart, 0, designedLength); frame = round(ms x fps / 1000), at most ceil(designedLength x fps / 1000) - 1.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadCompiler } from '../apps/web/src/mg/tools';
import { framePlan, isPending, itemDraw, previewRuns } from '../apps/web/src/render/model';
import type { Draw, Pending } from '../apps/web/src/render/model';
import type { ProjectDocument } from '../apps/web/src/store/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, build, links, mkItem as t03Item, mkTrack, resetIds, useIds } from './t03-fixtures';

const props = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));
type Tr = { id: string; kind: string; hidden?: boolean };
const CODE = 'export const G = () => <AbsoluteFill />;';
/** A motion graphic on `trackId`: display from-to, trim.from, designed length `source` (undefined = none). */
const mg = (id: string, trackId: string, o: { from?: number; to?: number; trim?: number; source?: number | null; p?: Record<string, unknown>; details?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) => {
  const from = o.from ?? 0, to = o.to ?? 10000;
  return { id, type: 'motionGraphic', trackId, display: { from, to }, trim: { from: o.trim ?? 0, to: (o.trim ?? 0) + to - from }, properties: props(o.p ?? {}),
    ...o.source === null ? {} : { sourceDuration: o.source ?? to - from }, details: { code: CODE, ...o.details }, ...o.extra };
};
const textItem = (id: string, trackId: string) => ({ id, type: 'text', trackId, display: { from: 0, to: 10000 }, trim: { from: 0 }, properties: props({}), details: { text: 'x' } });
const project = (w: number, h: number, tracks: Tr[], items: unknown[], extra: Record<string, unknown> = {}) =>
  ({ schemaVersion: 4, rev: 0, size: { width: w, height: h }, fps: 30, duration: 10000, background: {}, transitions: [], markers: [], tracks, items,
    layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), groups: {}, ...extra }) as unknown as ProjectDocument;
const draw = (doc: ProjectDocument, id: string, t: number) => itemDraw(doc, doc.items.find(i => i.id === id)!, t) as Draw;

// addMotionGraphic compiles synchronously once the lazily loaded compiler is in (review M4).
beforeAll(loadCompiler);

describe('T08 MG clock in the render model (findings §16 addendum, ticket T08 "MG clock")', () => {
  // display 2000-4000, trim.from 1000, designed length 3000 ms at 30 fps: designed last frame = ceil(3000 x 30 / 1000) - 1 = 89; clip length 2000 ms = 60 frames.
  const doc = project(1080, 1920, [{ id: 'O1', kind: 'overlay' }], [mg('g', 'O1', { from: 2000, to: 4000, trim: 1000, source: 3000 })]);
  const cases: [number, number, number][] = [[2000, 30, 1000], [2500, 45, 1500], [3000, 60, 2000], [3999, 89, 2999]];
  cases.forEach(([t, frame, ms]) => it(`t=${t}: frame ${frame}, graphic time ${ms} ms (start trim 1000 ms)`, () => {
    const d = draw(doc, 'g', t);
    expect(d.kind).toBe('motionGraphic');
    expect(d.graphic!.frame).toBe(frame);
    expect(d.sourceMs).toBe(ms);
  }));
  it('lastFrame is the designed length\'s last frame (89) and durationInFrames is the clip length in frames (60, G-06)', () => {
    const g = draw(doc, 'g', 2500).graphic!;
    expect(g.lastFrame).toBe(89);
    expect(g.durationInFrames).toBe(60);
    expect(g.fps).toBe(30);
  });
  it('without a designed length the frame is not clamped and lastFrame is Infinity', () => {
    const open = project(1080, 1920, [{ id: 'O1', kind: 'overlay' }], [mg('g', 'O1', { from: 2000, to: 4000, trim: 1000, source: null })]);
    const d = draw(open, 'g', 3999);
    expect(d.graphic!.frame).toBe(90); // round(2999 x 30 / 1000) = 90, one past the clamp above
    expect(d.sourceMs).toBe(2999);
    expect(d.graphic!.lastFrame).toBe(Infinity);
  });
  it('a clip longer than the designed length stays on the last frame', () => {
    const long = project(1080, 1920, [{ id: 'O1', kind: 'overlay' }], [mg('g', 'O1', { from: 0, to: 10000, source: 3000, trim: 0 })]);
    expect(draw(long, 'g', 9000).graphic!.frame).toBe(89);
    expect(draw(long, 'g', 9000).sourceMs).toBe(3000);
    expect(draw(long, 'g', 2900).graphic!.frame).toBe(87);
  });
  it('fps comes from the project: at 24 fps t=1000 is frame 24 and the designed 3000 ms end is frame 71', () => {
    const d24 = project(1080, 1920, [{ id: 'O1', kind: 'overlay' }], [mg('g', 'O1', { source: 3000 })], { fps: 24 });
    expect(draw(d24, 'g', 1000).graphic).toMatchObject({ frame: 24, lastFrame: 71, fps: 24, durationInFrames: 240 });
  });
});

describe('T08 MG box, canvas and field values (D25, findings part 5 §53.1)', () => {
  const tracks: Tr[] = [{ id: 'O1', kind: 'overlay' }];
  it('the box comes from positionX / positionY / width / height; canvas is the project size', () => {
    const doc = project(540, 960, tracks, [mg('g', 'O1', { p: { positionX: 100, positionY: 200, width: 200, height: 100 } })]);
    const d = draw(doc, 'g', 500);
    expect(d.box).toMatchObject({ x: 100, y: 200, W: 200, H: 100 });
    expect(d.graphic!.canvas).toEqual({ width: 540, height: 960 });
  });
  [{ width: 0, height: 0 }, {}, { width: 0 }, { height: 0 }].forEach(p => it(`width / height ${JSON.stringify(p)}: the missing side falls back to the project size`, () => {
    const doc = project(540, 960, tracks, [mg('g', 'O1', { p: { positionX: 10, positionY: 20, ...p } })]);
    const b = draw(doc, 'g', 0).box;
    expect(b).toMatchObject({ x: 10, y: 20 });
    expect(b.W).toBe(('width' in p ? p.width : 0) || 540);
    expect(b.H).toBe(('height' in p ? p.height : 0) || 960);
    if (!('width' in p) || p.width === 0) expect(b.W).toBe(540);
    if (!('height' in p) || p.height === 0) expect(b.H).toBe(960);
  }));
  it('fieldValues pass through; none stored gives {}', () => {
    const values = { title: 'Hi', n: 3 };
    const doc = project(540, 960, tracks, [mg('a', 'O1', { details: { fieldValues: values } }), mg('b', 'O1')]);
    expect(draw(doc, 'a', 0).graphic!.fieldValues).toEqual(values);
    expect(draw(doc, 'b', 0).graphic!.fieldValues).toEqual({});
  });
  it('the code is passed on unchanged', () => {
    const code = 'export const Z = () => <div>z</div>;';
    expect(draw(project(540, 960, tracks, [mg('a', 'O1', { details: { code } })]), 'a', 0).graphic!.code).toBe(code);
  });
});

describe('T08 MG pending and null rules (T15 owners table)', () => {
  const tracks: Tr[] = [{ id: 'O1', kind: 'overlay' }];
  const one = (extra: Record<string, unknown>, details?: Record<string, unknown>) => project(540, 960, tracks, [{ ...mg('g', 'O1'), ...extra, ...details ? { details } : {} }]);
  const at = (doc: ProjectDocument) => itemDraw(doc, doc.items[0], 0);
  it('no code, empty code and non-string code are an empty graphic: null (nothing drawn, nothing pending; coordinator ruling, findings part 3 §46.3)', () => {
    expect(at(one({}, {}))).toBeNull();
    expect(at(one({}, { code: '' }))).toBeNull();
    expect(at(one({}, { code: 42 }))).toBeNull();
    expect(at(one({}, { code: null }))).toBeNull();
    expect(at(one({ details: undefined }))).toBeNull();
  });
  // T10/T12 (C8 assertion-only edit): effects and masks both render now; 'blur' is no registry id, so the graphic is pending as an unknown effect, but masks never are.
  it('an enabled effect the registry does not know is pending (unknown effect); masks always draw (T12)', () => {
    const fx = { id: 'e', effectId: 'blur', enabled: true, order: 0, parameters: {} };
    expect(at(one({ effects: [fx] }))).toEqual({ itemId: 'g', owner: '?', what: "Unknown effect 'blur'" });
    expect(isPending(at(one({ masks: [{ id: 'm', enabled: true }] }))!)).toBe(false);
    expect(isPending(at(one({ effects: [{ ...fx, enabled: false }] }))!)).toBe(false);
    expect(isPending(at(one({ masks: [{ id: 'm', enabled: false }] }))!)).toBe(false);
  });
  it('opacity 0 draws nothing (null)', () => {
    expect(at(project(540, 960, tracks, [mg('g', 'O1', { p: { opacity: 0 } })]))).toBeNull();
    expect(isPending(at(project(540, 960, tracks, [mg('g', 'O1', { p: { opacity: 0.5 } })]))!)).toBe(false);
  });
  it('framePlan on a mixed overlay track: the MG and the text are both drawn (T05: text is a draw, no longer pending)', () => {
    const doc = project(540, 960, tracks, [mg('g', 'O1'), textItem('t', 'O1')]);
    const plan = framePlan(doc, 500);
    expect(plan.draws.map(d => [d.item.id, d.kind])).toEqual([['g', 'motionGraphic'], ['t', 'text']]);
    expect(plan.draws[1].text).toBeDefined();
    expect(plan.pending).toEqual([]);
  });
  it('framePlan: a graphic without code is absent from draws and pending; the drawn one still draws', () => {
    const doc = project(540, 960, tracks, [mg('a', 'O1'), mg('b', 'O1', { details: { code: '' } })]);
    const plan = framePlan(doc, 0);
    expect(plan.draws.map(d => d.item.id)).toEqual(['a']);
    expect(plan.pending).toEqual([]);
  });
});

describe('T08 MG tracks join the preview run (a track holding a motion graphic is a canvas track)', () => {
  const video = (id: string, trackId: string) => ({ id, type: 'video', trackId, display: { from: 0, to: 10000 }, trim: { from: 0 }, properties: props({}), metadata: { assetId: `a_${id}` } });
  it('[V1 video, O1 overlay with an MG, V2 video] is one run of three tracks', () => {
    const doc = project(540, 960, [{ id: 'V1', kind: 'video' }, { id: 'O1', kind: 'overlay' }, { id: 'V2', kind: 'video' }], [video('v1', 'V1'), mg('g', 'O1'), video('v2', 'V2')]);
    expect(previewRuns(doc).map(r => r.trackIds)).toEqual([['V1', 'O1', 'V2']]);
  });
  it('an overlay track with only text between two video tracks is one run of three (T05: text is a canvas track)', () => {
    const doc = project(540, 960, [{ id: 'V1', kind: 'video' }, { id: 'O1', kind: 'overlay' }, { id: 'V2', kind: 'video' }], [video('v1', 'V1'), textItem('t', 'O1'), video('v2', 'V2')]);
    expect(previewRuns(doc).map(r => r.trackIds)).toEqual([['V1', 'O1', 'V2']]);
  });
  it('a hidden MG track is skipped and the video tracks around it stay one run', () => {
    const doc = project(540, 960, [{ id: 'V1', kind: 'video' }, { id: 'O1', kind: 'overlay', hidden: true }, { id: 'V2', kind: 'video' }], [video('v1', 'V1'), mg('g', 'O1'), video('v2', 'V2')]);
    expect(previewRuns(doc).map(r => r.trackIds)).toEqual([['V1', 'V2']]);
  });
  it('an MG-only project is a single run of its track', () => {
    const doc = project(540, 960, [{ id: 'O1', kind: 'overlay' }], [mg('g', 'O1')]);
    expect(previewRuns(doc).map(r => r.trackIds)).toEqual([['O1']]);
  });
});

describe('T08 a split continues the graphic', () => {
  beforeEach(() => useIds());
  afterEach(() => resetIds());
  const CARD = `export const Card = () => <AbsoluteFill style={{ backgroundColor: '#112233' }} />;`;
  function split() {
    const doc: ProjectDocument = build({ tracks: [mkTrack('V1', 'video'), mkTrack('O2', 'overlay')], items: [t03Item('v1', 'V1', 0, 8000, { trim: { from: 0, to: 8000 }, sourceDuration: 10000 })] });
    const e = createEditor(doc, { assets: assets(), links: links() });
    const added = e.call('addMotionGraphic', { code: CARD, summary: 'A card.', width: 540, height: 960, x: 0, y: 0, trackId: 'O2', timelineStart: 2 }) as { success: boolean; data: { itemId: string } };
    expect(added.success).toBe(true);
    const id = added.data.itemId;
    const cut = e.call('splitItem', { itemId: id, timestampS: 4 }) as { success: boolean; data: { leftItemId: string; rightItemId: string } };
    expect(cut.success).toBe(true);
    return { e, left: cut.data.leftItemId, right: cut.data.rightItemId };
  }
  const frameAt = (e: ReturnType<typeof split>['e'], id: string, t: number) => (itemDraw(e.doc, e.doc.items.find(i => i.id === id)!, t) as Draw).graphic!;
  it('the halves are consecutive: left at cut - 1 frame, right at the cut, step exactly 1', () => {
    const { e, left, right } = split();
    const fps = e.doc.fps || 30, cut = 4000, step = 1000 / fps;
    const a = frameAt(e, left, cut - step), b = frameAt(e, right, cut);
    expect(b.frame - a.frame).toBe(1);
    expect(a.frame).toBe(59); // 2 s into a 5 s graphic at 30 fps is frame 60; one frame earlier is 59
    expect(b.frame).toBe(60);
  });
  it('the right half\'s trim.from is the cut point inside the graphic (2000 ms) and its first frame is the one the left half would have shown next', () => {
    const { e, left, right } = split();
    const l = e.doc.items.find(i => i.id === left)!, r = e.doc.items.find(i => i.id === right)!;
    expect(r.trim!.from).toBe(2000);
    expect(r.display.from).toBe(4000);
    expect(l.display.to).toBe(4000);
    expect(frameAt(e, right, 4000).frame).toBe(60);
  });
  it('both halves report the same lastFrame (the whole designed length, 149) and keep their clip length for durationInFrames', () => {
    const { e, left, right } = split();
    expect(frameAt(e, left, 3000).lastFrame).toBe(149);
    expect(frameAt(e, right, 5000).lastFrame).toBe(149);
    expect(frameAt(e, left, 3000).durationInFrames).toBe(60); // 2 s
    expect(frameAt(e, right, 5000).durationInFrames).toBe(90); // 3 s
  });
  it('the whole run is continuous: frames over the left half then the right half never skip or repeat a frame at 30 fps', () => {
    const { e, left, right } = split();
    const frames: number[] = [];
    for (let k = 0; k < 60; k++) frames.push(frameAt(e, left, 2000 + k * 1000 / 30).frame);
    for (let k = 60; k < 150; k++) frames.push(frameAt(e, right, 2000 + k * 1000 / 30).frame);
    frames.forEach((f, i) => { if (i) expect(f - frames[i - 1], `step at index ${i}`).toBe(1); });
    expect(frames[0]).toBe(0);
    expect(frames.at(-1)).toBe(149);
  });
});
