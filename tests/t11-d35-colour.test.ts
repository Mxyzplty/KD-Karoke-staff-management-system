// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeGraphicPng, graphicBitmap } from '../apps/web/src/export/graphic';
import { createImage, quantise8 } from '../parity/oracle/image';
import { renderFrame } from '../parity/oracle/render';

const input = (v: number) => {
  const x = v / 255, l = x < 0.081 ? x / 4.5 : ((x + 0.099) / 1.099) ** (1 / 0.45);
  return Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
};
const output = (v: number) => {
  const x = v / 255, l = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  return Math.round(255 * (l < 0.018 ? 4.5 * l : 1.099 * l ** 0.45 - 0.099));
};

// Encode rows from known straight bytes using the five PNG predictors (independent of the decoder).
function png(rows: number[][], channels: 3 | 4, filter: number) {
  const stride = rows[0].length, scan: number[] = [];
  for (let y = 0; y < rows.length; y++) {
    scan.push(filter);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[y][x - channels] : 0, b = y ? rows[y - 1][x] : 0, c = y && x >= channels ? rows[y - 1][x - channels] : 0;
      const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predictor = [0, a, b, Math.floor((a + b) / 2), [a, b, c][distances.indexOf(Math.min(...distances))]][filter];
      scan.push((rows[y][x] - predictor + 256) % 256);
    }
  }
  const chunk = (name: string, data: Buffer) => { const n = Buffer.alloc(4); n.writeUInt32BE(data.length); return Buffer.concat([n, Buffer.from(name), data, Buffer.alloc(4)]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(stride / channels, 0); header.writeUInt32BE(rows.length, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  return Uint8Array.from(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(scan))), chunk('IEND', Buffer.alloc(0))]));
}
class ImageDataStub {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
}
afterEach(() => vi.unstubAllGlobals());

describe('D35 graphic PNG decoding', () => {
  it.each([0, 1, 2, 3, 4])('filter %i decodes RGB and RGBA across multiple rows without losing alpha', async filter => {
    vi.stubGlobal('ImageData', ImageDataStub);
    for (const channels of [3, 4] as const) {
      const rgba = [[128, 16, 255, 1, 7, 240, 31, 64, 3, 4, 5, 255], [2, 200, 100, 0, 255, 17, 180, 2, 80, 32, 220, 127], [77, 22, 33, 1, 1, 2, 3, 64, 255, 254, 253, 255]];
      const rows = channels === 4 ? rgba : rgba.map(r => r.filter((_, i) => i % 4 !== 3));
      const result = await decodeGraphicPng(png(rows, channels, filter));
      const expected = channels === 4 ? rgba.flat() : rows.flatMap(r => Array.from({ length: 3 }, (_, i) => [...r.slice(i * 3, i * 3 + 3), 255]).flat());
      expect([result.width, result.height]).toEqual([3, 3]);
      expect([...result.data]).toEqual(expected);
    }
  });
  it('tables straight RGB before bitmap creation and leaves every alpha unchanged', async () => {
    vi.stubGlobal('ImageData', ImageDataStub);
    const create = vi.fn(async (image: ImageDataStub) => image); vi.stubGlobal('createImageBitmap', create);
    const raw = [128, 16, 255, 1, 16, 128, 0, 64], bytes = png([raw], 4, 4);
    await graphicBitmap(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
    expect([...create.mock.calls[0][0].data]).toEqual([input(128), input(16), 255, 1, input(16), input(128), 0, 64]);
  });
});

describe('D35 independent oracle controls', () => {
  it.each(['bt709', 'iec61966-2-1', 'linear'])('graphic transfer metadata %s never bypasses its input lookup; image stays output-only', transfer => {
    const props = Object.fromEntries(Object.entries({ width: 2, height: 2, positionX: 0, positionY: 0 }).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));
    const item = (type: string, details: Record<string, unknown> = {}) => ({ id: 'x', type, trackId: 'o1', display: { from: 0, to: 1000 }, trim: { from: 0 }, sourceDuration: 1000, properties: props, details });
    const project = (i: any) => ({ size: { width: 2, height: 2 }, fps: 10, tracks: [{ id: 'o1', kind: 'overlay' }], layerOrder: [{ type: 'track', id: 'o1' }], groups: {}, items: [i] });
    const source = () => ({ ...createImage(2, 2, [16 / 255, 16 / 255, 16 / 255, 1]), transfer });
    const code = (i: any, exportColour: boolean) => quantise8(renderFrame(project(i) as any, 0, { effects: {}, cssFilters: {}, source, exportColour }))[0];
    const layout = item('layout', { cells: [{ bounds: { x: 0, y: 0, width: 1, height: 1 }, source: { type: 'motionGraphic', url: 'fixture' }, fillMode: 'fill' }] });
    expect([code(item('motionGraphic'), false), code(item('motionGraphic'), true)]).toEqual([16, output(input(16))]);
    expect([code(item('image'), false), code(item('image'), true)]).toEqual([16, output(16)]);
    expect([code(layout, false), code(layout, true)]).toEqual([16, output(input(16))]);
    expect(output(input(16))).toBe(16); expect(output(16)).toBe(6);
  });
});
