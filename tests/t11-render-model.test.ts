// SPDX-License-Identifier: AGPL-3.0-only
// T11 transitions in the render model: the extension / frozen-frame rule through framePlan (apps/web/src/render/model.ts).
// Oracle: findings part 5 §55.1 (source handles never limit a transition's length) and §55.3 (inside the window both clips are drawn at the
// timeline time t, the outgoing one past its end and the incoming one before its start; when the source has no more frames the first / last source frame
// holds). Formula used by the tests, written from the doc and not read back from the code: sourceMs = trim.from + local × rate, local = t − display.from,
// clamped to 0 … sourceDuration for video.
// D32 Q7: a time-remapped clip holds its edge keyframe's value outside the keyframes' range. Own: an image's sourceMs is its property time, unclamped.
import { describe, it, expect } from 'vitest';
import { framePlan } from '../apps/web/src/render/model';
import { createEditor } from '../apps/web/src/timeline/harness';
import type { ProjectDocument } from '../apps/web/src/store/model';

const CUT = 2000, W0 = 1500;                                // A 0–2000 | B 2000–4000, a 1000 ms centred transition: window [1500, 2500)
type Rec = Record<string, any>;
const clip = (id: string, type: 'video' | 'image', from: number, to: number, extra: Rec = {}) =>
  ({ id, type, trackId: 'V1', display: { from, to }, trim: { from: 0 }, sourceDuration: 10000, properties: {}, metadata: { assetId: `a_${id}` }, ...extra });
const project = (a: Rec, b: Rec, rec: Rec = {}) => ({
  schemaVersion: 4, rev: 0, size: { width: 64, height: 36 }, fps: 30, duration: 4000, background: {}, markers: [], groups: {},
  tracks: [{ id: 'V1', kind: 'video' }], layerOrder: [{ type: 'track', id: 'V1' }], items: [a, b],
  transitions: [{ id: 'transition_abcdefghij', trackId: 'V1', fromId: a.id, toId: b.id, kind: 'dissolve', durationMs: 1000, alignment: 0.5, ...rec }],
}) as unknown as ProjectDocument;
/** sourceMs of each draw at t, by item id (undefined when the item is not drawn). */
const at = (doc: ProjectDocument, t: number) => {
  const plan = framePlan(doc, t), by = Object.fromEntries(plan.draws.map(d => [d.item.id, d.sourceMs as number]));
  return { A: by.A, B: by.B, n: plan.draws.length, tags: plan.draws.map(d => (d as any).transition?.role), pending: plan.pending };
};

describe('T11 §55.3 extension through framePlan: both clips are drawn across the window at their own item-local time', () => {
  // (a) Handles on both sides. A shows source 1000–3000 on the timeline 0–2000 (7000 ms of tail left), B shows 3000–5000 on 2000–4000 (3000 ms of head left).
  const handles = project(clip('A', 'video', 0, 2000, { trim: { from: 1000, to: 3000 } }), clip('B', 'video', 2000, 4000, { trim: { from: 3000, to: 5000 } }));

  it('(a) with handles on both sides every source time in the window is linear: A = 1000 + t, B = 3000 + (t − 2000), and both are drawn and tagged', () => {
    for (const t of [W0, 1600, 1999, CUT, 2300, 2499]) {
      const r = at(handles, t);
      expect(r.n, `t=${t}: two draws`).toBe(2);
      expect(r.tags, `t=${t}`).toEqual(['from', 'to']);
      expect(r.A, `A at t=${t}`).toBe(1000 + t);
      expect(r.B, `B at t=${t}`).toBe(3000 + (t - CUT));
    }
    // Past the cut A's source time continues (3300 at t = 2300), before the cut B's is already running (2600 at t = 1600): they meet at the same source time here.
    expect(at(handles, 2300).A).toBe(3300); expect(at(handles, 1600).B).toBe(2600);
  });

  it('(a) outside the window there is no extension: only the clip whose own range holds t is drawn, untagged', () => {
    for (const [t, only] of [[W0 - 1, 'A'], [2500, 'B']] as const) {
      const r = at(handles, t);
      expect(r.n, `t=${t}`).toBe(1); expect(r.tags).toEqual([undefined]); expect(r[only], `${only} at t=${t}`).toBeTypeOf('number');
      expect(r[only === 'A' ? 'B' : 'A']).toBeUndefined();
    }
  });

  it('(a) the playback rate scales the extended time: A at 2× = trim.from + local × 2', () => {
    const doc = project(clip('A', 'video', 0, 2000, { trim: { from: 1000, to: 5000 }, playbackRate: 2 }), clip('B', 'video', 2000, 4000, { trim: { from: 6000, to: 8000 }, playbackRate: 0.5 }));
    expect(at(doc, 2300).A).toBe(1000 + 2300 * 2);             // local 2300 beyond A's 2000 ms
    expect(at(doc, 1600).B).toBe(6000 + (1600 - CUT) * 0.5);   // local −400 before B's start
  });

  // (b) The ticket's fixture 6: the outgoing clip is already at its source end, the incoming one starts at source 0, so neither has a handle on its far side.
  it('(b) fixture 6 shape, window ending on the cut (alignment 1): A holds its last source frame (sourceDuration) and B its first (0) across the whole window', () => {
    const doc = project(clip('A', 'video', 0, 2000, { trim: { from: 10000, to: 10000 } }), clip('B', 'video', 2000, 4000, { trim: { from: 0, to: 2000 } }), { alignment: 1 });
    for (const t of [1000, 1250, 1500, 1750, 1999]) {         // window [1000, 2000)
      const r = at(doc, t);
      expect(r.n, `t=${t}`).toBe(2); expect(r.tags).toEqual(['from', 'to']);
      expect(r.A, `A at t=${t}`).toBe(10000); expect(r.B, `B at t=${t}`).toBe(0);
    }
  });

  it('(b) the same clips with the window centred on the cut: the side with no handle clamps, the other side runs (A = 10000 after the cut; B = 0 before it)', () => {
    const doc = project(clip('A', 'video', 0, 2000, { trim: { from: 8000, to: 10000 } }), clip('B', 'video', 2000, 4000, { trim: { from: 0, to: 2000 } }));
    for (const t of [1500, 1700, 1999]) { expect(at(doc, t).A, `A at t=${t} (inside its own range)`).toBe(8000 + t); expect(at(doc, t).B, `B at t=${t}`).toBe(0); }
    expect(at(doc, CUT).A).toBe(10000);                       // 8000 + 2000 reaches the source end exactly
    for (const t of [2100, 2300, 2499]) { expect(at(doc, t).A, `A at t=${t}`).toBe(10000); expect(at(doc, t).B, `B at t=${t}`).toBe(t - CUT); }
  });

  it('(b) the first frame never goes below 0 and the last never above sourceDuration, whatever the overshoot', () => {
    const doc = project(clip('A', 'video', 0, 2000, { trim: { from: 9990, to: 10000 }, sourceDuration: 10000 }), clip('B', 'video', 2000, 4000, { trim: { from: 5, to: 2005 } }));
    expect(at(doc, 2499).A).toBe(10000); expect(at(doc, W0).B).toBe(0);   // 5 − 500 → 0
    expect(at(doc, 2499).B).toBe(5 + 499);
  });

  // (c) D32 Q7.
  it('(c) D32 Q7: a time-remapped clip holds its edge keyframe value past / before its keyframes (A past 2000 ms of local time, B before 0)', () => {
    const doc = project(
      clip('A', 'video', 0, 2000, { timeRemap: { keyframes: [{ time: 0, value: 1000, easing: 'linear' }, { time: 2000, value: 3000 }], defaultValue: 0 } }),
      clip('B', 'video', 2000, 4000, { timeRemap: { keyframes: [{ time: 0, value: 500, easing: 'linear' }, { time: 2000, value: 2500 }], defaultValue: 0 } }));
    expect(at(doc, 1000).A).toBe(2000);                       // inside the curve: 1000 + local
    for (const t of [2000, 2300, 2499]) expect(at(doc, t).A, `A held at its last keyframe, t=${t}`).toBe(3000);
    for (const t of [W0, 1700, 1999]) expect(at(doc, t).B, `B held at its first keyframe, t=${t}`).toBe(500);
    expect(at(doc, 2500).B).toBe(500 + 500);                  // at t = 2500 the pair is over: B plays its curve at local 500
  });

  it('own rule: an image clip in the window has sourceMs = its property time (trim.from + local × rate), not clamped to a source length', () => {
    const doc = project(clip('A', 'image', 0, 2000, { trim: { from: 0, to: 2000 } }), clip('B', 'image', 2000, 4000, { trim: { from: 0, to: 2000 } }));
    expect(at(doc, 2300).A).toBe(2300); expect(at(doc, 1600).B).toBe(-400);
  });
});

describe('D32 Q7 incoming nonlinear remap remains aligned to the timeline', () => {
  it.each([0, 0.5, 1])('alignment %s preserves B curve and holds extended edges', alignment => {
    const a = clip('A', 'video', 0, 2000, { timeRemap: { keyframes: [{ time: 0, value: 1000, easing: 'linear' }, { time: 2000, value: 3000 }], defaultValue: 0 } });
    const b = clip('B', 'video', 2000, 4000, { timeRemap: { keyframes: [{ time: 0, value: 500, easing: 'easeInOut' }, { time: 500, value: 1500, easing: 'easeInOut' }, { time: 1000, value: 2500, easing: 'linear' }, { time: 2000, value: 3500 }], defaultValue: 0 } });
    const doc = project(a, b, { alignment }), plain = { ...doc, transitions: [] } as ProjectDocument;
    const originalCurves = JSON.stringify((doc.items as any[]).map(i => i.timeRemap));
    // easeInOut is cubic bezier (.42,0,.58,1): its symmetric midpoint is .5, and at x=.25 y≈.12916.
    for (const [t, expected] of [[2000, 500], [2125, 629.16], [2250, 1000], [2500, 1500], [2750, 2000], [3000, 2500], [3500, 3000]] as const) {
      expect(at(doc, t).B, `transition at ${t}`).toBeCloseTo(expected, 1);
      expect(at(plain, t).B, `plain at ${t}`).toBeCloseTo(expected, 1);
      expect(at(doc, t).B).toBeCloseTo(at(plain, t).B!, 8);
    }
    for (const [t, expected] of [[1000, 2000], [1500, 2500], [1900, 2900]] as const) {
      expect(at(doc, t).A, `A transition at ${t}`).toBe(expected);
      expect(at(plain, t).A, `A plain at ${t}`).toBe(expected);
    }
    if (alignment > 0) expect(at(doc, 2000 - alignment * 500).B).toBe(500);
    if (alignment < 1) expect(at(doc, 2000 + (1 - alignment) * 500).A).toBe(3000);
    expect(JSON.stringify((doc.items as any[]).map(i => i.timeRemap))).toBe(originalCurves);
  });
  it('add, changing update and remove leave both stored curves byte-identical', () => {
    const a = clip('A', 'video', 0, 2000, { timeRemap: { keyframes: [{ time: 0, value: 500, easing: 'easeInOut' }, { time: 500, value: 1500 }, { time: 2000, value: 3000 }], defaultValue: 0 } });
    const b = clip('B', 'video', 2000, 4000, { timeRemap: { keyframes: [{ time: 0, value: 700, easing: 'easeInOut' }, { time: 500, value: 1700 }, { time: 2000, value: 3200 }], defaultValue: 0 } });
    const doc = project(a, b); doc.transitions = [];
    const e = createEditor(doc), curves = () => JSON.stringify((e.doc.items as any[]).map(i => i.timeRemap));
    const before = curves();
    expect(e.call('applyTransition', { action: 'add', betweenItems: ['A', 'B'] })).toMatchObject({ success: true });
    expect(curves()).toBe(before);
    expect(e.call('applyTransition', { action: 'update', betweenItems: ['A', 'B'], kind: 'wipe', alignment: 'end', durationSeconds: 0.6 })).toMatchObject({ success: true });
    expect(e.doc.transitions![0]).toMatchObject({ kind: 'wipe', alignment: 1, durationMs: 600 });
    expect(curves()).toBe(before);
    expect(e.call('applyTransition', { action: 'remove', betweenItems: ['A', 'B'] })).toMatchObject({ success: true });
    expect(curves()).toBe(before);
  });
});
