// SPDX-License-Identifier: AGPL-3.0-only
// Sampled frames on disk: frames.json holds only metadata; each sample's pixels are one
// 16-bit RGBA PNG (unfiltered, deflate level 1) so full-size frames stream one at a time.
// Channel values in [0, 1] are stored as round(v × 65535); comparisons use that precision.
import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export const FRAMES_VERSION = 2;
export type FrameFile = { timeMs: number; width: number; height: number; file: string; sha256: string };
export type FramesMeta = { version: 2; timeUnit: 'ms'; channelRange: [0, 1]; pixelFormat: 'png-rgba16'; sampleTimesMs: number[]; frames: FrameFile[] };
export type Pixels = { width: number; height: number; rgba: ArrayLike<number> };

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export const q16 = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 65535);
export const frameFileName = (index: number) => `frames/${String(index).padStart(4, '0')}.png`;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
export function encodePng16({ width, height, rgba }: Pixels): Buffer {
  const stride = width * 8 + 1, raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let i = 0; i < width * 4; i++) raw.writeUInt16BE(q16(rgba[y * width * 4 + i]), y * stride + 1 + i * 2);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([16, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
// Reads only what encodePng16 writes (16-bit RGBA, filter 0, no interlace); anything else is refused.
export function decodePng16(png: Buffer): { width: number; height: number; rgba: Float32Array } {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw Error('Not a PNG frame file');
  let at = 8, width = 0, height = 0; const idat: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + length);
    if ((crc32(png.subarray(at + 4, at + 8 + length)) >>> 0) !== png.readUInt32BE(at + 8 + length)) throw Error(`PNG ${type} chunk CRC mismatch`);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); if (data[8] !== 16 || data[9] !== 6 || data[12] !== 0) throw Error('Frame PNG must be 16-bit RGBA, not interlaced'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 8 + 1;
  if (!width || !height || raw.length !== stride * height) throw Error('Frame PNG has the wrong data size');
  const rgba = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw Error('Frame PNG rows must be unfiltered');
    for (let i = 0; i < width * 4; i++) rgba[y * width * 4 + i] = raw.readUInt16BE(y * stride + 1 + i * 2) / 65535;
  }
  return { width, height, rgba };
}
export function validateFramesMeta(value: any): asserts value is FramesMeta {
  if (!value || value.version !== FRAMES_VERSION || value.timeUnit !== 'ms' || value.pixelFormat !== 'png-rgba16') throw Error('Reference frames.json version, units or pixel format missing or unsupported');
  if (!Array.isArray(value.sampleTimesMs) || !Array.isArray(value.frames) || value.frames.length !== value.sampleTimesMs.length) throw Error('Reference frames.json sample list is malformed');
  value.frames.forEach((f: any, i: number) => {
    if (f?.timeMs !== value.sampleTimesMs[i] || !Number.isSafeInteger(f.width) || !Number.isSafeInteger(f.height) || f.width <= 0 || f.height <= 0 || typeof f.file !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw Error(`Reference frame entry ${i} is malformed`);
  });
}
