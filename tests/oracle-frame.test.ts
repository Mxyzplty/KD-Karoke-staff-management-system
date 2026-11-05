// SPDX-License-Identifier: AGPL-3.0-only
// The wired frame renderer: effect registry + transitions + fixture media (part 4 §48.3, part 5 §53–§55).
import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImage, type Image } from '../parity/oracle/image';
import type { Item, Project } from '../parity/oracle/item';
import { renderFrame } from '../parity/oracle/render';
import { displaySize, fixtureSource, oracleDeps, recordWindow } from '../parity/oracle/frame';
import type { TransitionRecord } from '../parity/oracle/transitions';

const props = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));
const clip = (id: string, from: number, to: number, extra: Partial<Item> = {}): Item =>
  ({ id, type: 'image', trackId: 'V1', display: { from, to }, trim: { from: 0 }, properties: props({ width: 4, height: 4, positionX: 0, positionY: 0 }), ...extra });
const project = (items: Item[], transitions: object[]): Project =>
  ({ size: { width: 4, height: 4 }, fps: 30, tracks: [{ id: 'V1', kind: 'video' }], items, layerOrder: [{ type: 'track', id: 'V1' }], groups: {}, transitions });
const colours: Record<string, number> = { white: 1, black: 0, grey: 0.5 };
const deps = oracleDeps(item => createImage(4, 4, [colours[item.id], colours[item.id], colours[item.id], 1]));
const code = (img: Image) => Math.round(img.data[0] * 255);

it('§55 dissolve through the renderer: window, linear p, curve, then outside the window the clips draw alone', () => {
  const p = project([clip('white', 0, 1000), clip('black', 1000, 2000)], [{ id: 'x', trackId: 'V1', fromId: 'white', toId: 'black', kind: 'dissolve', durationMs: 1000, alignment: 0.5 }]);
  expect(recordWindow(p, p.transitions[0])).toMatchObject({ startMs: 500, endMs: 1500 });
  // §55.5 dissolve test values (A white, B black, 1 s Center): p = 0 → A; cut − 250 → 218; cut → 128; cut + 250 → 37.
  expect([500, 750, 1000, 1250].map(t => code(renderFrame(p, t, deps)))).toEqual([255, 218, 128, 37]);
  expect(code(renderFrame(p, 400, deps))).toBe(255);
  expect(code(renderFrame(p, 1500, deps))).toBe(0);
});

it('§55 fade through black at a quarter of the window uses fadeAlpha on the outgoing clip', () => {
  const p = project([clip('white', 0, 1000), clip('black', 1000, 2000)], [{ id: 'x', trackId: 'V1', fromId: 'white', toId: 'black', kind: 'fade', durationMs: 1000, alignment: 0.5 }]);
  // §55.5 fade test values: 250 ms before the cut a white A reads 180; the cut frame is pure black.
  expect(code(renderFrame(p, 750, deps))).toBe(180);
  expect(code(renderFrame(p, 1000, deps))).toBe(0);
});

it('§55.2 a middle clip with transitions at both ends shares its length between the two windows', () => {
  const records: TransitionRecord[] = [{ id: 'a', trackId: 'V1', fromId: 'white', toId: 'grey', kind: 'dissolve', durationMs: 3000, alignment: 0.5 },
    { id: 'b', trackId: 'V1', fromId: 'grey', toId: 'black', kind: 'dissolve', durationMs: 3000, alignment: 0.5 }];
  const p = project([clip('white', 0, 5000), clip('grey', 5000, 6000), clip('black', 6000, 11000)], records);
  // grey is 1000 ms long; the two 1500 ms halves inside it shrink to 500 + 500.
  expect(recordWindow(p, records[0])).toMatchObject({ startMs: 3500, endMs: 5500 });
  expect(recordWindow(p, records[1])).toMatchObject({ startMs: 5500, endMs: 7500 });
});

it('rejects a transition record whose clips do not meet', () => {
  const p = project([clip('white', 0, 1000), clip('black', 1200, 2000)], [{ id: 'x', trackId: 'V1', fromId: 'white', toId: 'black', kind: 'dissolve', durationMs: 500, alignment: 0.5 }]);
  expect(() => renderFrame(p, 900, deps)).toThrow('does not join');
});

const store = process.env.CUTFRAME_FIXTURES;
it.skipIf(!store)('fixture media: a full-canvas S1 video item renders exactly its decoded export-pick frame', () => {
  const src = 'synthetic/S1-framecount-1080x1920-30fps-10s.mp4';
  const p: Project = { size: { width: 1080, height: 1920 }, fps: 30, tracks: [{ id: 'V1', kind: 'video' }], layerOrder: [{ type: 'track', id: 'V1' }], groups: {}, transitions: [],
    items: [{ id: 'v', type: 'video', trackId: 'V1', display: { from: 0, to: 10000 }, trim: { from: 0 }, sourceDuration: 10000, details: { src: `fixture://${src}` }, properties: props({ width: 1080, height: 1920, positionX: 0, positionY: 0 }) }] };
  const frame = renderFrame(p, 45 * 1000 / 30, oracleDeps(fixtureSource(store)));
  const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(store!, src), '-vf', 'select=eq(n\\,45)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 28 });
  let worst = 0;
  for (let i = 0; i < decoded.length; i++) worst = Math.max(worst, Math.abs(Math.round(frame.data[i] * 255) - decoded[i]));
  expect(worst).toBe(0);
});

it('§53.3.1 display size: rotation side data swaps the sides, SAR scales the width', () => {
  expect(displaySize({ width: 1920, height: 1080, sample_aspect_ratio: '1:1', side_data_list: [{ rotation: 90 }] })).toMatchObject({ width: 1080, height: 1920 });
  expect(displaySize({ width: 1920, height: 1080, side_data_list: [{ rotation: -270 }] })).toMatchObject({ width: 1080, height: 1920 });
  expect(displaySize({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] })).toMatchObject({ width: 1920, height: 1080 });
  expect(displaySize({ width: 720, height: 576, sample_aspect_ratio: '16:15' })).toMatchObject({ width: 768, height: 576 });
  expect(() => displaySize({ width: 4, height: 4, side_data_list: [{ rotation: 45 }] })).toThrow('multiple of 90');
});

const rgba = (file: string, filter: string, args: string[] = []) => execFileSync('ffmpeg', ['-v', 'error', ...args, '-i', file, '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 28 });
const codes = (img: Image) => Buffer.from(img.data.map(v => Math.round(v * 255)));
it.skipIf(!store)('fixture media: S5d (rotation 90) decodes at its 1080×1920 display size, equal to an explicit transpose of the coded frames', () => {
  const file = path.join(store!, 'synthetic/S5d-rotation-90.mp4');
  const image = fixtureSource(store)({ id: 'r', type: 'video', trackId: 'V1', display: { from: 0, to: 3000 }, details: { src: 'fixture://synthetic/S5d-rotation-90.mp4' } }, 500)!;
  expect([image.width, image.height]).toEqual([1080, 1920]);
  // Independent path: no autorotate, rotation 90 (counter-clockwise display matrix) undone by one explicit transpose.
  const explicit = rgba(file, 'select=eq(n\\,15),transpose=cclock', ['-noautorotate']);
  const turned = rgba(file, 'select=eq(n\\,15),transpose=clock', ['-noautorotate']);
  expect(codes(image).equals(explicit) || codes(image).equals(turned)).toBe(true);
  expect(explicit.equals(turned)).toBe(false); // the content is asymmetric, so the direction is pinned
});

it('fixture media: a SAR 2:1 source is widened to its display width', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cutframe-sar-')); mkdirSync(path.join(dir, 'media'));
  const file = path.join(dir, 'media/sar.mp4');
  // Left half red, right half blue, 64×48 coded, SAR 2:1 → display 128×48.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x48:r=30:d=0.2', '-f', 'lavfi', '-i', 'color=c=blue:s=32x48:r=30:d=0.2',
    '-filter_complex', 'hstack,setsar=2/1,format=yuv444p', '-c:v', 'libx264', '-qp', '0', file]);
  const image = fixtureSource(dir)({ id: 's', type: 'video', trackId: 'V1', display: { from: 0, to: 200 }, details: { src: 'fixture://media/sar.mp4' } }, 0)!;
  expect([image.width, image.height]).toEqual([128, 48]);
  const coded = rgba(file, 'select=eq(n\\,0)');
  const at = (buf: Buffer | Uint8Array, w: number, x: number) => Array.from(buf.subarray((10 * w + x) * 4, (10 * w + x) * 4 + 3));
  const out = codes(image);
  // Away from the colour edge each display column repeats its coded column's colour.
  for (const x of [0, 20, 50, 80, 110, 127]) expect(at(out, 128, x)).toEqual(at(coded, 64, Math.floor(x / 2)));
});
