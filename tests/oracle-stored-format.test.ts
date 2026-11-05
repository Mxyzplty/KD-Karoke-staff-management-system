// SPDX-License-Identifier: AGPL-3.0-only
// The oracle on records in the STORED project format, built from the planning docs' field names (never from the
// oracle's own readers). One test per record type; expected values worked out by hand from the cited sections.
import { it, expect } from 'vitest';
import { apply, drawTracks, invert, type Item, type Project } from '../parity/oracle/item';
import { renderFrame, type Deps, type TextTarget } from '../parity/oracle/render';
import { oracleDeps } from '../parity/oracle/frame';
import { createImage, type Image } from '../parity/oracle/image';
import type { RGBA } from '../parity/oracle/math';

// Animatable value {defaultValue, keyframes[]}, keyframe {id, time, value, easing} (findings (C).md:38).
const value = (defaultValue: any, keyframes: [number, any][] = []) => ({ defaultValue, keyframes: keyframes.map(([time, v], i) => ({ id: `kf_${i}`, time, value: v, easing: 'linear' })) });
const props = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));
// Track record (part 2 §29): {id, name, kind, muted, solo, locked, hidden, volume}; schema 4 stores no order.
const track = (id: string, kind: string, hidden = false) => ({ id, name: id, kind, muted: false, solo: false, locked: false, hidden, volume: 1 });
// Persisted document, schema 4 (findings (C).md:35).
const project = (w: number, h: number, tracks: any[], items: any[], extra: Record<string, any> = {}): Project => ({
  schemaVersion: 4, layerOrder: tracks.map(t => ({ type: 'track', id: t.id })), groups: {}, duration: 10000, fps: 30, size: { width: w, height: h },
  background: { type: 'color', value: 'transparent' }, tracks, items, transitions: [], markers: [], ...extra,
});
// Item (findings (C).md:37; drawn-item example l.423).
const item = (id: string, type: string, trackId: string, properties: Record<string, any>, extra: Record<string, any> = {}): Item => ({
  id, name: id, type, trackId, display: { from: 0, to: 5000 }, trim: { from: 0, to: 5000 }, duration: 5000, playbackRate: 1, sourceDuration: 5000,
  details: { src: '' }, metadata: {}, properties, masks: [], effects: [], ...extra,
});
// Effect instance (findings (C).md:65, W3-RT-03).
const effect = (effectId: string, parameters: Record<string, any>, order = 0, enabled = true) => ({ id: `effect_${order}_abcdefghi`, effectId, enabled, order, parameters });
const solid = (w: number, h: number, rgb: number[]) => createImage(w, h, [...rgb.map(v => v / 255), 1] as RGBA);
const rgb = (img: Image, x: number, y: number) => [0, 1, 2].map(k => Math.round(img.data[(y * img.width + x) * 4 + k] * 255));
const row = (img: Image, y = 0) => Array.from({ length: img.width }, (_, x) => rgb(img, x, y)[0]);
// deps.text stand-in: the whole box in white through target.m, sampled at pixel centres.
const box = (item: Item, at: TextTarget) => {
  const out = createImage(at.size.width, at.size.height), inv = invert(at.m), W = item.properties!.width.defaultValue, H = item.properties!.height.defaultValue;
  for (let i = 0; i < out.width * out.height; i++) { const [u, v] = apply(inv, i % out.width + .5, Math.floor(i / out.width) + .5); if (u >= 0 && u < W && v >= 0 && v < H) out.data.set([1, 1, 1, 1], i * 4); }
  return [out];
};

it('stored items and animatable properties: display / trim / playbackRate / timeRemap / {defaultValue, keyframes}', () => {
  // positionX keyframes at property time 1000 → 0 and 2000 → 4; trim.from 1000, rate 2. At t 250: property time
  // = 1000 + 250 × 2 = 1500 (part 2 §38) → positionX 2: the 2 × 2 white image covers columns 2–3 of 6.
  const img = item('i1', 'image', 'V1', { positionX: value(0, [[1000, 0], [2000, 4]]), positionY: value(0), width: value(2), height: value(2), opacity: value(1), scale: value(1), rotation: value(0) },
    { trim: { from: 1000, to: 6000 }, playbackRate: 2, sourceDuration: 6000 });
  const d = oracleDeps(() => solid(2, 2, [255, 255, 255]));
  expect(row(renderFrame(project(6, 2, [track('V1', 'video')], [img]), 250, d))).toEqual([0, 0, 255, 255, 0, 0]);
  // timeRemap {defaultValue 0, keyframes} at item-local time, values in source ms: 0 → 5000, 1000 → 6000; at t 500 → 5500.
  const asked: number[] = [];
  const vid = item('v1', 'video', 'V1', props({ width: 2, height: 2 }), { timeRemap: value(0, [[0, 5000], [1000, 6000]]), sourceDuration: 10000 });
  renderFrame(project(2, 2, [track('V1', 'video')], [vid]), 500, oracleDeps((_, ms) => { asked.push(ms); return solid(2, 2, [0, 0, 0]); }));
  expect(asked).toEqual([5500]);
  // Shapes that are not the stored ones throw instead of being skipped (a video item reads all three).
  const bad = (p: Record<string, any>, extra: Record<string, any> = {}) => () => renderFrame(project(2, 2, [track('V1', 'video')], [item('b', 'video', 'V1', { width: value(2), height: value(2), ...p }, extra)]), 0, d);
  expect(bad({ opacity: 0.5 })).toThrow('not a stored {defaultValue, keyframes[]} value');
  expect(bad({}, { playbackRate: value(2) })).toThrow('playbackRate');
  expect(bad({}, { timeRemap: [{ time: 0, value: 0 }] })).toThrow('not a stored {defaultValue, keyframes[]} value');
});

it('stored effect instances: {id, effectId, enabled, order, parameters: {key: {defaultValue, keyframes}}}', () => {
  const frame = (effects: any[], t = 0) => rgb(renderFrame(project(2, 2, [track('V1', 'video')], [item('e', 'image', 'V1', props({ width: 2, height: 2 }), { effects })]), t, oracleDeps(() => solid(2, 2, [255, 0, 0]))), 0, 0);
  // Review repro: grayscale amount 0 (§49.13: lerp(c, Y601(c), 0)) leaves red.
  expect(frame([effect('grayscale', { amount: value(0) })])).toEqual([255, 0, 0]);
  // amount keyframed 0 → 100 over property time 0…1000. t 500 → 50: R = 1 − 0.5 × 0.701 = 0.6495 → 166, G = B = 0.1495 → 38.
  const ramp = [effect('grayscale', { amount: value(0, [[0, 0], [1000, 100]]) })];
  expect([frame(ramp, 0), frame(ramp, 500), frame(ramp, 1000)]).toEqual([[255, 0, 0], [166, 38, 38], [76, 76, 76]]); // 0.299 × 255 = 76
  expect(frame([effect('grayscale', { amount: value(100) }, 0, false)])).toEqual([255, 0, 0]); // enabled false: skipped
  // order sorts the chain. Sepia first (§49.14 matrix: red → 0.393, 0.349, 0.272), then grayscale: Y601 = 0.3534 → 90.
  // Stored order reversed in the array on purpose; grayscale first would give (103, 92, 71).
  expect(frame([effect('grayscale', { amount: value(100) }, 1), effect('sepia', { amount: value(100) }, 0)])).toEqual([90, 90, 90]);
  expect(() => frame([{ kind: 'grayscale', params: { amount: 0 } }])).toThrow('not a stored effect instance');
  expect(() => frame([effect('grayscale', { amount: 0 })])).toThrow('not a stored {defaultValue, keyframes[]} value');
});

it('stored transition records: {id, trackId, fromId, toId, kind, durationMs, alignment, direction?, params?}', () => {
  // §55.1 / §55.2 / §55.6. White clip 0–2000, black clip 2000–4000; durationMs 1600 at alignment 0 → window 2000–3600
  // (pre 0, post 1600); t 2800 → p 0.5. (A misread duration of 1000 gives p 0.8; a misread alignment 0.5 puts t outside.)
  const clips = [item('a', 'image', 'V1', props({ width: 4, height: 1 }), { display: { from: 0, to: 2000 } }), item('b', 'image', 'V1', props({ width: 4, height: 1 }), { display: { from: 2000, to: 4000 } })];
  const d = oracleDeps(it => solid(4, 1, it.id === 'a' ? [255, 255, 255] : [0, 0, 0]));
  const at = (record: Record<string, any>) => renderFrame(project(4, 1, [track('V1', 'video')], clips, { transitions: [{ id: 'tr_1', trackId: 'V1', fromId: 'a', toId: 'b', durationMs: 1600, alignment: 0, ...record }] }), 2800, d);
  // wipe from-right at p 0.5, softness 0: u = 1 − (column + 0.5)/4 → columns 2–3 (u ≤ 0.5) show the incoming black.
  expect(row(at({ kind: 'wipe', direction: 'from-right' }))).toEqual([255, 255, 0, 0]);
  // dipToColorDissolve at p 0.5: overlay 1 − smooth(0) = 1 of params.color [1, 0, 0] → red.
  expect(rgb(at({ kind: 'dipToColorDissolve', params: { color: [1, 0, 0] } }), 0, 0)).toEqual([255, 0, 0]);
});

it('stored masks: the UI mask record and createMask keyframes.path / keyframes.opacity', () => {
  // findings (C).md:421: {id, name, enabled, points, closed, mode, order, colorIndex, feather, expansion, opacity, inverted, source}.
  const ui = (points: number[][], extra: Record<string, any> = {}) => ({ id: 'mask_1', name: 'Mask 1', enabled: true, points: points.map(([x, y]) => ({ anchor: { x, y } })), closed: true, mode: 'add', order: 0, colorIndex: 0, feather: 0, expansion: 0, opacity: 100, inverted: false, source: 'shape', ...extra });
  const left = [[0, 0], [2, 0], [2, 1], [0, 1]], right = [[2, 0], [4, 0], [4, 1], [2, 1]];
  const frame = (mask: any, t = 0) => row(renderFrame(project(4, 1, [track('V1', 'video')], [item('m', 'image', 'V1', props({ width: 4, height: 1 }), { masks: [mask] })]), t, oracleDeps(() => solid(4, 1, [255, 255, 255]))));
  expect(frame(ui(left))).toEqual([255, 255, 0, 0]);
  // §54.8 7.2 / 7.3: path keyframes win over the points; keyframes.opacity 0 → 100 over 0…1000 → 50 at t 500 → 128.
  const keyed = ui(left, { keyframes: { path: { keyframes: [{ id: 'kf_p', time: 0, value: 'M 2,0 L 4,0 L 4,1 L 2,1 Z', points: right.map(([x, y]) => ({ anchor: { x, y } })), closed: true, easing: 'linear' }] }, opacity: value(100, [[0, 0], [1000, 100]]) } });
  expect(frame(keyed, 500)).toEqual([0, 0, 128, 128]);
  // Stored forms the oracle does not model throw (§54.8 7.4 legacy frame fields, §54.9 8.3 legacy vector smart mask).
  expect(() => frame(ui(left, { pathKeyframes: [{ frame: 0, path: 'M 0,0 Z', easing: 'linear' }] }))).toThrow('legacy frame-based');
  expect(() => frame(ui(left, { source: 'smart' }))).toThrow('legacy vector smart mask');
});

it('stored textAnimation: details.textAnimation {version, preset, speed}', () => {
  // agent tool results l.607 (textAnimation is stored under details.*), l.1703 ({version, preset, speed}); §56.1:
  // c = min(τ × speed, T). fade, speed 2, τ 50 → c 100, q 0.25 → outCubic = 1 − 0.75³ = 0.578 → 147.
  const t = (details: Record<string, any>, properties: Record<string, any> = {}) => item('t', 'text', 'O1', { ...props({ width: 1, height: 1 }), ...properties }, { details });
  const d: Deps = { ...oracleDeps(() => null), text: (it, at) => box(it, at) };
  const red = (x: Item) => rgb(renderFrame(project(1, 1, [track('O1', 'overlay')], [x]), 50, d), 0, 0)[0];
  expect(Math.abs(red(t({ text: 'A', textAnimation: { version: 1, preset: 'fade', speed: 2 } })) - 147)).toBeLessThanOrEqual(1); // ±1 LSB, §58.3
  expect(() => red(t({ text: 'A' }, { textAnimation: value({ version: 1, preset: 'fade' }) }))).toThrow('stored under details');
});

it('stored caption: details.words [{text, startMs, endMs, sourceStartMs, sourceEndMs}], renderMode, renderConfig', () => {
  // part 3 l.179 (stored caption item); §57.1: word times relative to the item start, τ = item-local ms; settings from renderConfig.
  const words = [{ text: 'hi', startMs: 0, endMs: 400, sourceStartMs: 1000, sourceEndMs: 1400 }, { text: 'there', startMs: 500, endMs: 900, sourceStartMs: 1500, sourceEndMs: 1900 }];
  const cap = item('c', 'caption', 'C1', props({ width: 4, height: 1 }), { display: { from: 2000, to: 3000 }, trim: { from: 1000, to: 2000 },
    details: { text: 'hi there', words, renderMode: 'highlight', renderConfig: { highlightColor: '#00ff00', highlightScale: 1.2 } } });
  const seen: TextTarget[] = [];
  renderFrame(project(4, 1, [track('C1', 'caption')], [cap]), 2600, { ...oracleDeps(() => null), text: (_, at) => { seen.push(at); return []; } });
  // τ 600: word 0 ended at 400; word 1 is active (500 ≤ 600 < 900) → its highlight colour and scale from renderConfig.
  expect(seen[0].words!.map(w => [w.color, w.scale])).toEqual([[null, 1], ['#00ff00', 1.2]]);
});

it('stored tracks, layerOrder and groups: kind (not type), layerOrder entries {type, id}, groups {name, children, hidden}', () => {
  // part 2 §29 / §37, part 5 §53.5.1: A1 and V2 missing from layerOrder are repaired: audio first (bottom), a video
  // track just below the first entry holding a caption track. Audio draws nothing.
  const tracks = [track('A1', 'audio'), track('V1', 'video'), track('O1', 'overlay'), track('C1', 'caption'), track('V2', 'video')];
  const layerOrder = [{ type: 'track', id: 'V1' }, { type: 'group', id: 'G1' }, { type: 'track', id: 'C1' }];
  const p = (hidden: boolean) => project(2, 2, tracks, [], { layerOrder, groups: { G1: { name: 'Group 1', children: [{ type: 'track', id: 'O1' }], hidden } } });
  expect(drawTracks(p(false)).map(t => t.id)).toEqual(['V1', 'O1', 'V2', 'C1']);
  expect(drawTracks(p(true)).map(t => t.id)).toEqual(['V1', 'V2', 'C1']);
  expect(() => drawTracks(project(2, 2, [{ id: 'V1', type: 'video' }], []))).toThrow('is not a stored track kind');
});

it('stored layout item and cells (W3-RT-09): bounds {x, y, width, height}, source {assetId, type, url} or null, opacity in %', () => {
  // findings (C).md:425: no gap or radius field; each cell {id, bounds, source, fillMode, panX, panY, zoom, volume, opacity, playbackRate}.
  const cell = (id: string, x: number, source: any) => ({ id: id.padEnd(21, '0'), bounds: { x, y: 0, width: 0.5, height: 1 }, source, fillMode: 'fill', panX: 0, panY: 0, zoom: 100, volume: 100, opacity: 100, playbackRate: 1 });
  const layout = item('l', 'layout', 'O1', props({ positionX: 0, positionY: 0, width: 4, height: 2, scale: 1, rotation: 0, opacity: 1 }),
    { details: { layoutType: 'split-horizontal', cells: [cell('a', 0, { assetId: 'asset-1', type: 'video', url: 'fixture://x.mp4' }), cell('b', 0.5, null)] } });
  const frame = renderFrame(project(4, 2, [track('O1', 'overlay')], [layout]), 0, oracleDeps(() => solid(2, 2, [255, 0, 0])));
  // §53.3.3: the filled cell shows its media (cover); the empty cell is white at 6 % over black → 15 (§53.3.5).
  expect([rgb(frame, 0, 0), rgb(frame, 1, 1), rgb(frame, 2, 0), rgb(frame, 3, 1)]).toEqual([[255, 0, 0], [255, 0, 0], [15, 15, 15], [15, 15, 15]]);
});

it('stored project record (schema 4): the stored background is never used by the export, which fills opaque black (§53.8.1)', () => {
  const frame = renderFrame(project(2, 2, [track('V1', 'video')], [], { background: { type: 'color', value: '#ff0000' } }), 0, oracleDeps(() => null));
  expect([rgb(frame, 0, 0), rgb(frame, 1, 1)]).toEqual([[0, 0, 0], [0, 0, 0]]);
  expect(frame.data[3]).toBe(1);
});
