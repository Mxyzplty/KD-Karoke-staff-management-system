// SPDX-License-Identifier: AGPL-3.0-only
// Decoding: WebCodecs first (through Mediabunny), the WASM software decoder second (master plan §1b). `forceWasm` proves
// the WASM path even where WebCodecs could decode. Frames come out as planar Y′CbCr so SDR and HDR share one converter.
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import type { VideoSample } from 'mediabunny';
import { registerAc3Decoder } from '@mediabunny/ac3';
import { mediaError } from './codes';
import { yuvToRgba } from './tonemap';
import type { YuvFrame } from './tonemap';

export type RawVideoFrame = YuvFrame & { timestamp: number; colour: { primaries: string; transfer: string; matrix: string; fullRange: boolean }; source: 'webcodecs' | 'wasm' };
export type RawAudio = { sampleRate: number; channels: number; data: Float32Array[]; source: 'webcodecs' | 'wasm' };
export type DecodeOptions = { forceWasm?: boolean };
let ac3 = false;
/** @mediabunny/ac3 registers FFmpeg's AC-3 / E-AC-3 decoders with Mediabunny (browsers decode neither). */
export function ensureAc3() { if (!ac3) { registerAc3Decoder(); ac3 = true; } }
const wasm = () => import('./libav');

/** Which decoder a source's video takes in this browser. */
export async function videoDecoder(blob: Blob, options: DecodeOptions = {}): Promise<'webcodecs' | 'wasm'> {
  if (options.forceWasm) return 'wasm';
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try { const track = await input.getPrimaryVideoTrack().catch(() => null); return track && await track.canDecode() ? 'webcodecs' : 'wasm'; }
  finally { input.dispose(); }
}
/** Every frame of the primary video track in presentation order, from `startS`. */
export async function* videoFrames(blob: Blob, options: DecodeOptions & { startS?: number } = {}): AsyncGenerator<RawVideoFrame> {
  if (await videoDecoder(blob, options) === 'wasm') {
    let source: Awaited<ReturnType<Awaited<ReturnType<typeof wasm>>['openLibavVideo']>>;
    try { source = await (await wasm()).openLibavVideo(blob); } catch (e) { throw mediaError('UNSUPPORTED_INPUT', `This file could not be opened: ${(e as Error).message}`); }
    try {
      const pending: RawVideoFrame[] = [];
      for await (const frame of source.frames()) {
        // Decoders emit in presentation order already; keep a short window in case a demuxer reorders.
        pending.push(frame); pending.sort((a, b) => a.timestamp - b.timestamp);
        while (pending.length > 4) { const f = pending.shift()!; if (f.timestamp >= (options.startS ?? 0) - 1e-6) yield f; }
      }
      for (const f of pending) if (f.timestamp >= (options.startS ?? 0) - 1e-6) yield f;
    } catch (e) { throw (e as { code?: string }).code ? e : mediaError('DECODE_ERROR', `Decoding failed: ${(e as Error).message}`); }
    finally { await source.close(); }
    return;
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = (await input.getPrimaryVideoTrack())!, cs = await track.getColorSpace();
    const colour = { primaries: cs.primaries ?? 'bt709', transfer: cs.transfer ?? 'bt709', matrix: cs.matrix ?? 'bt709', fullRange: cs.fullRange ?? false };
    for await (const sample of new VideoSampleSink(track).samples(options.startS)) {
      try { yield await sampleToRaw(sample, colour); } finally { sample.close(); }
    }
  } catch (e) { throw (e as { code?: string }).code ? e : mediaError('DECODE_ERROR', `Decoding failed: ${(e as Error).message}`); }
  finally { input.dispose(); }
}
async function sampleToRaw(sample: VideoSample, colour: RawVideoFrame['colour']): Promise<RawVideoFrame> {
  const format = sample.format ?? '', w = sample.codedWidth, h = sample.codedHeight;
  const bytes = new Uint8Array(sample.allocationSize()), layout = await sample.copyTo(bytes);
  const wide = /P1[02]/.test(format), bitDepth = wide ? 10 : 8;
  const view = (i: number, rows: number) => { const b = bytes.subarray(layout[i].offset, layout[i].offset + layout[i].stride * rows); return wide ? new Uint16Array(b.slice().buffer) : b; };
  const base = { timestamp: sample.timestamp, width: w, height: h, bitDepth: bitDepth as 8 | 10, colour, fullRange: colour.fullRange, source: 'webcodecs' as const };
  if (format === 'NV12') {
    const ch = Math.ceil(h / 2), cw = Math.ceil(w / 2), uv = bytes.subarray(layout[1].offset), u = new Uint8Array(cw * ch), v = new Uint8Array(cw * ch);
    for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) { u[r * cw + c] = uv[r * layout[1].stride + 2 * c]; v[r * cw + c] = uv[r * layout[1].stride + 2 * c + 1]; }
    return { ...base, chroma: '420', y: view(0, h), u, v, yStride: layout[0].stride, cStride: cw };
  }
  const chroma = format.startsWith('I444') ? '444' : format.startsWith('I422') ? '422' : format.startsWith('I420') ? '420' : null;
  if (!chroma) throw mediaError('DECODE_ERROR', `Unsupported decoded pixel format ${format || 'unknown'}.`);
  const ch = chroma === '420' ? Math.ceil(h / 2) : h, div = wide ? 2 : 1;
  return { ...base, chroma, y: view(0, h), u: view(1, ch), v: view(2, ch), yStride: layout[0].stride / div, cStride: layout[1].stride / div };
}
/** One frame as display RGBA: Y′CbCr → R′G′B′ (HDR PQ/HLG tone-mapped by the shared BT.2390 function), then rotated clockwise. */
export function frameToRgba(frame: RawVideoFrame, rotation: 0 | 90 | 180 | 270 = 0): { width: number; height: number; data: Uint8ClampedArray } {
  const hdr = frame.colour.transfer === 'pq' ? 'pq' : frame.colour.transfer === 'hlg' ? 'hlg' : null;
  const rgba = yuvToRgba(frame, frame.colour.matrix, hdr);
  return rotateRgba(rgba, frame.width, frame.height, rotation);
}
export function rotateRgba(src: Uint8ClampedArray, w: number, h: number, rotation: 0 | 90 | 180 | 270) {
  if (rotation === 0) return { width: w, height: h, data: src };
  const quarter = rotation !== 180, ow = quarter ? h : w, oh = quarter ? w : h, out = new Uint8ClampedArray(src.length), s32 = new Uint32Array(src.buffer, src.byteOffset, w * h), o32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [nx, ny] = rotation === 90 ? [h - 1 - y, x] : rotation === 180 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
    o32[ny * ow + nx] = s32[y * w + x];
  }
  return { width: ow, height: oh, data: out };
}
/** The primary audio track as planar float PCM (AC-3 / E-AC-3 through the registered extension). */
export async function decodeAudio(blob: Blob, options: DecodeOptions = {}): Promise<RawAudio> {
  ensureAc3();
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack().catch(() => null);
    if (!options.forceWasm && track && await track.canDecode()) {
      // Samples are placed by their timestamps: priming before t = 0 (edit lists, encoder delay) is dropped.
      const chunks: { at: number; planes: Float32Array[] }[] = [], rate = track.sampleRate;
      for await (const sample of new AudioSampleSink(track).samples()) {
        try {
          chunks.push({ at: Math.round(sample.timestamp * rate), planes: Array.from({ length: sample.numberOfChannels }, (_, k) => {
            const plane = new Float32Array(sample.numberOfFrames); sample.copyTo(plane, { planeIndex: k, format: 'f32-planar' }); return plane;
          }) });
        } finally { sample.close(); }
      }
      const channels = track.numberOfChannels, total = Math.max(0, ...chunks.map(c => c.at + c.planes[0].length)), data = Array.from({ length: channels }, () => new Float32Array(total));
      for (const c of chunks) c.planes.forEach((p, k) => { const skip = Math.max(0, -c.at); if (skip < p.length) data[k].set(p.subarray(skip), Math.max(0, c.at)); });
      return { sampleRate: rate, channels, data, source: 'webcodecs' };
    }
  } finally { input.dispose(); }
  try { return await (await wasm()).decodeLibavAudio(blob); }
  catch (e) { throw mediaError('DECODE_ERROR', `The audio could not be decoded: ${(e as Error).message}`); }
}
