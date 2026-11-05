// SPDX-License-Identifier: AGPL-3.0-only
// A synthetic G-04 stored-reference folder for testing the replay support (parity/g04.ts) without Xapp captures.
// It is NOT the G-04 reference and says nothing about Xapp parity. It is a written-spec oracle: every stored point list below
// is written from the preset formulas of findings part 5 §54.2 1.5 (rectangle corners, triangle apex top-centre, ellipse with
// κ = 0.5522847498 handles, star regular with R = min(w, h) / 2 and inner ratio 0.4, first vertex up) and results l.1325–l.1327
// (metadata.shapeType, fullDetails {points, closed} in canvas px), not produced by the Cutframe code.
// Provisional choices, not Xapp parity (the spec gives no value): the addShape success envelope `data {itemId, trackId}`, the
// viewItemDetails envelope `data.results[]`, the schema refusal's text (only its path and code are compared, deferred to T18),
// the star's points stored at 0.1 px (so the area check, not exact anchors, decides it).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Json } from './normalise';
import type { G01Step } from './g01';
import { SYNTHETIC_FIELDS } from './g01-synthetic';

type Rec = { [key: string]: Json };
type P = { anchor: { x: number; y: number }; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } };
const TRACK = 'track_ov1', K = 0.5522847498;
const xy = (x: number, y: number) => ({ x, y });
const r = (v: number, d = 100) => Math.round(v * d) / d + 0;
/** The star in a w × h box at (x, y): 10 anchors, outer R, inner 0.4 R, first vertex up, clockwise, at 0.1 px. */
const star = (x: number, y: number, w: number, h: number): P[] => Array.from({ length: 10 }, (_, k) => {
  const R = Math.min(w, h) / 2, rk = k % 2 ? 0.4 * R : R, t = (-90 + 36 * k) * Math.PI / 180;
  return { anchor: xy(r(x + w / 2 + rk * Math.cos(t), 10), r(y + h / 2 + rk * Math.sin(t), 10)) };
});
/** The ellipse in a w × h box at (x, y): right, bottom, left, top, each with κ handles. */
const ellipse = (x: number, y: number, w: number, h: number): P[] => {
  const a = w / 2, b = h / 2, kx = r(K * a), ky = r(K * b);
  return [
    { anchor: xy(x + w, y + b), handleIn: xy(0, -ky), handleOut: xy(0, ky) },
    { anchor: xy(x + a, y + h), handleIn: xy(kx, 0), handleOut: xy(-kx, 0) },
    { anchor: xy(x, y + b), handleIn: xy(0, ky), handleOut: xy(0, -ky) },
    { anchor: xy(x + a, y), handleIn: xy(-kx, 0), handleOut: xy(kx, 0) },
  ];
};
const CUSTOM: P[] = [xy(600, 600), xy(700, 560), xy(800, 600), xy(800, 700), xy(700, 740), xy(600, 700)].map(anchor => ({ anchor }));

/** Writes `<dir>/results/*` and `<dir>/calls.json`; the replay learns the track and item ids from the stored results. */
export async function writeSyntheticG04(dir: string, o: { blockBase?: 0 | 1 } = {}) {
  const base = o.blockBase ?? 1, files = new Map<string, Rec>(), steps: G01Step[] = [];
  const text = (blocks: string[]) => blocks.join('\n<<<BLOCK>>>\n');
  const store = (id: string, tool: string, input: Rec, result: Rec) => {
    files.set(id, { tool_name: tool, tool_input: input, result_text: text([`${tool} result`, JSON.stringify(result, null, 2)]), notes: '' });
    steps.push(id);
  };
  // Each shape's stored block, kept by hand.
  const shapes = new Map<string, { type: string; from: number; points: P[]; closed: boolean }>();
  const block = (id: string) => { const s = shapes.get(id)!; return { id, type: 'shape', timelineMetadata: { metadata: { shapeType: s.type }, display: { from: s.from, to: s.from + 5 } }, fullDetails: { points: s.points, closed: s.closed } }; };
  const read = (ids: string[]) => ({ success: true, data: { results: ids.map(block) } });
  const vid = (id: string, item: string) => files.set(`${id}.vid`, { result_text: text([`viewItemDetails after ${id}`, JSON.stringify(read([item]))]), notes: '' });
  const add = (id: string, item: string, type: string, from: number, input: Rec, points: P[]) => {
    shapes.set(item, { type, from, points, closed: true });
    store(id, 'addShape', { trackId: TRACK, timelineStart: from, ...input }, { success: true, data: { itemId: item, trackId: TRACK } }); vid(id, item);
  };

  store('S00', 'manageTrack', { action: 'create', kind: 'overlay' }, { success: true, data: { track: { id: TRACK, kind: 'overlay' } } });
  add('A01', 'shape_rect', 'rectangle', 0, { shape: 'rectangle', bounds: { x: 100, y: 200, width: 320, height: 240 } },
    [xy(100, 200), xy(420, 200), xy(420, 440), xy(100, 440)].map(anchor => ({ anchor })));
  add('A02', 'shape_tri', 'triangle', 5, { shape: 'triangle', bounds: { cx: 960, cy: 540, width: 300, height: 200 } },
    [xy(960, 440), xy(1110, 640), xy(810, 640)].map(anchor => ({ anchor })));
  add('A03', 'shape_ell', 'ellipse', 10, { shape: 'ellipse', bounds: { x: 0, y: 0, width: 400, height: 200 } }, ellipse(0, 0, 400, 200));
  add('A04', 'shape_star', 'star', 15, { shape: 'star', bounds: { x: 1000, y: 100, width: 320, height: 240 } }, star(1000, 100, 320, 240));
  add('A05', 'shape_custom', 'custom', 20, { points: CUSTOM }, CUSTOM);
  // `hexagon` is not a preset: the schema refuses it (tickets T06 runtime fixture 5); deferred to T18 here.
  store('A06', 'addShape', { trackId: TRACK, timelineStart: 25, shape: 'hexagon', bounds: { x: 0, y: 0, width: 100, height: 100 } },
    { success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for addShape', message: '$.shape: must be one of rectangle, ellipse, triangle, pentagon, star, heart', details: { errors: [{ path: '$.shape', code: 'ENUM', message: 'must be one of rectangle, ellipse, triangle, pentagon, star, heart' }] } });
  // Remove the custom path's last point: 5 anchors left.
  shapes.get('shape_custom')!.points = CUSTOM.slice(0, 5);
  store('W01', 'writeShapePoints', { itemId: 'shape_custom', remove: [5] }, { success: true }); vid('W01', 'shape_custom');
  // The mask step (T12) and a frame capture: not compared by this replay.
  store('M01', 'writeMaskPoints', { itemId: 'shape_rect', masks: [{ shape: 'ellipse', mode: 'add', feather: 20, expansion: 10 }] }, { success: true });
  store('R00', 'viewItemDetails', { itemIds: [...shapes.keys()] }, read([...shapes.keys()]));
  store('C00', 'captureFrame', { timestamps: [1], quality: 'high' }, { success: true, data: { frames: 1 } });

  const calls = [steps];
  await mkdir(path.join(dir, 'results'), { recursive: true });
  for (const [id, record] of files) await writeFile(path.join(dir, 'results', `${id}.json`), JSON.stringify(record, null, 2));
  await writeFile(path.join(dir, 'calls.json'), JSON.stringify(calls, null, 2));
  return { calls, ...SYNTHETIC_FIELDS, blockBase: base };
}
