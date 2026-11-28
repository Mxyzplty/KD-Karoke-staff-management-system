// SPDX-License-Identifier: AGPL-3.0-only
// WASM software decode fallback (master plan §1b): our LGPL decode-only libav.js build (vendor/libav, FFmpeg without
// --enable-gpl). Loaded lazily, inside the media worker (noworker: libav runs synchronously in that worker).
import frontendUrl from '../../../../vendor/libav/libav-6.10.9.0-cutframe.mjs?url';
import factoryUrl from '../../../../vendor/libav/libav-6.10.9.0-cutframe.wasm.mjs?url';
import wasmUrl from '../../../../vendor/libav/libav-6.10.9.0-cutframe.wasm.wasm?url';
import type { RawVideoFrame, RawAudio } from './decode';
import { rotateRgba } from './decode';
import { parseHeif } from './heif';
import type { MediaInfo } from './probe';
import { parseIso6709 } from './probe';
import { yuvToRgba } from './tonemap';

type Packet = { data: Uint8Array; pts?: number; ptshi?: number; dts?: number; flags?: number; stream_index?: number };
type Frame = { data: Uint8Array | Float32Array[] | Int16Array[] | Int32Array[]; format: number; layout?: { offset: number; stride: number }[]; pts?: number; ptshi?: number; width?: number; height?: number; nb_samples?: number; sample_rate?: number; channels?: number };
type Stream = { index: number; codecpar: number; codec_type: number; codec_id: number; time_base_num: number; time_base_den: number; duration: number; metadata?: Record<string, string> };
// The libav.js surface we use (subset; the vendored build's own typings are not shipped).
type LibAV = Record<string, any> & {
  AVMEDIA_TYPE_VIDEO: number; AVMEDIA_TYPE_AUDIO: number; AVERROR_EOF: number; EAGAIN: number;
  mkworkerfsfile(name: string, blob: Blob): Promise<string>; unlinkworkerfsfile(name: string): Promise<void>;
  ff_init_demuxer_file(name: string): Promise<[number, Stream[]]>;
  ff_read_frame_multi(fmt: number, pkt: number, opts?: { limit?: number }): Promise<[number, Record<number, Packet[]>]>;
  ff_init_decoder(id: number | string, config?: { codecpar: number; time_base: [number, number] }): Promise<[number, number, number, number]>;
  ff_decode_multi(c: number, pkt: number, frame: number, packets: Packet[], config?: { fin?: boolean; ignoreErrors?: boolean }): Promise<Frame[]>;
};
let instance: Promise<LibAV> | undefined;
export function loadLibav(): Promise<LibAV> {
  return instance ??= (async () => {
    const mod = await import(/* @vite-ignore */ new URL(frontendUrl, location.href).href);
    const LibAVWrapper = mod.default ?? (globalThis as { LibAV?: unknown }).LibAV;
    // WORKERFS reads Blobs synchronously, which only a worker may do: run directly inside a worker, else in libav's own worker.
    const inWorker = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
    return LibAVWrapper.LibAV({ noworker: inWorker, nothreads: true, toImport: new URL(factoryUrl, location.href).href, wasmurl: new URL(wasmUrl, location.href).href });
  })();
}
// H.273 code points (stable FFmpeg enum values) for the colour fields of AVCodecParameters.
const PRIMARIES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
const TRANSFER: Record<number, string> = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' };
const MATRIX: Record<number, string> = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };
const ts = (lo = 0, hi = 0) => hi * 0x100000000 + (lo >>> 0);
export type LibavVideo = {
  width: number; height: number; colour: { primaries: string; transfer: string; matrix: string; fullRange: boolean };
  durationS: number; codecId: number; frames(): AsyncGenerator<RawVideoFrame>; close(): Promise<void>;
};
/** Open the primary video stream of a Blob with libav's own demuxer (works for containers Mediabunny cannot read too). */
export async function openLibavVideo(blob: Blob): Promise<LibavVideo> {
  const av = await loadLibav();
  const mount = `in-${crypto.randomUUID()}`, name = await av.mkworkerfsfile(mount, blob);
  const [fmt, streams] = await av.ff_init_demuxer_file(name);
  const stream = streams.find(s => s.codec_type === av.AVMEDIA_TYPE_VIDEO);
  if (!stream) { await av.avformat_close_input_js(fmt); await av.unlinkworkerfsfile(mount); throw new Error('no video track'); }
  const cp = stream.codecpar;
  const colour = { primaries: PRIMARIES[await av.AVCodecParameters_color_primaries(cp)] ?? 'bt709', transfer: TRANSFER[await av.AVCodecParameters_color_trc(cp)] ?? 'bt709',
    matrix: MATRIX[await av.AVCodecParameters_color_space(cp)] ?? 'bt709', fullRange: await av.AVCodecParameters_color_range(cp) === 2 };
  const [width, height] = [await av.AVCodecParameters_width(cp), await av.AVCodecParameters_height(cp)];
  const [, c, pkt, frame] = await av.ff_init_decoder(stream.codec_id, { codecpar: cp, time_base: [stream.time_base_num, stream.time_base_den] });
  const tb = stream.time_base_num / stream.time_base_den;
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await av.ff_free_decoder(c, pkt, frame); await av.avformat_close_input_js(fmt); await av.unlinkworkerfsfile(mount); };
  async function* frames(): AsyncGenerator<RawVideoFrame> {
    for (let done = false; !done;) {
      const [result, packets] = await av.ff_read_frame_multi(fmt, pkt, { limit: 4 << 20 });
      done = result === av.AVERROR_EOF;
      if (result !== 0 && !done && result !== -av.EAGAIN) throw new Error(`demux failed (${result}): invalid data`);
      const decoded = await av.ff_decode_multi(c, pkt, frame, packets[stream!.index] ?? [], { fin: done });
      for (const f of decoded) yield await toRaw(av, f, tb, colour);
    }
  }
  return { width, height, colour, durationS: stream.duration, codecId: stream.codec_id, frames, close };
}
async function toRaw(av: LibAV, f: Frame, tb: number, colour: LibavVideo['colour']): Promise<RawVideoFrame> {
  // (colour is reassigned below for full-range JPEG pixel formats)
  const desc = await av.av_pix_fmt_desc_get(f.format);
  const [log2w, log2h, depth, planes, flags] = [await av.AVPixFmtDescriptor_log2_chroma_w(desc), await av.AVPixFmtDescriptor_log2_chroma_h(desc), await av.AVPixFmtDescriptor_comp_depth(desc, 0), await av.AVPixFmtDescriptor_nb_components(desc), await av.AVPixFmtDescriptor_flags(desc)];
  const data = f.data as Uint8Array, layout = f.layout!, wide = depth > 8;
  const plane = (i: number, rows: number) => {
    const bytes = data.slice(layout[i].offset, layout[i].offset + layout[i].stride * rows);
    return wide ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2) : bytes;
  };
  const w = f.width!, h = f.height!, ch = h >> log2h;
  // Planar Y′CbCr only (AV_PIX_FMT_FLAG_PLANAR = 16, AV_PIX_FMT_FLAG_RGB = 32); packed RGB images take decodeImageLibav.
  if (planes < 3 || !(flags & 16) || flags & 32) throw new Error(`unsupported pixel format ${f.format}`);
  if ([av.AV_PIX_FMT_YUVJ420P, av.AV_PIX_FMT_YUVJ422P, av.AV_PIX_FMT_YUVJ444P].includes(f.format)) colour = { ...colour, fullRange: true };
  return { timestamp: ts(f.pts, f.ptshi) * tb, width: w, height: h, bitDepth: wide ? 10 : 8, chroma: log2w === 0 ? '444' : log2h === 0 ? '422' : '420',
    y: plane(0, h), u: plane(1, ch), v: plane(2, ch), yStride: layout[0].stride / (wide ? 2 : 1), cStride: layout[1].stride / (wide ? 2 : 1), colour, fullRange: colour.fullRange, source: 'wasm' };
}
/** Decode the primary audio stream to planar float PCM. */
export async function decodeLibavAudio(blob: Blob): Promise<RawAudio> {
  const av = await loadLibav();
  const mount = `in-${crypto.randomUUID()}`, name = await av.mkworkerfsfile(mount, blob);
  const [fmt, streams] = await av.ff_init_demuxer_file(name);
  try {
    const stream = streams.find(s => s.codec_type === av.AVMEDIA_TYPE_AUDIO);
    if (!stream) throw new Error('no audio track');
    const [, c, pkt, frame] = await av.ff_init_decoder(stream.codec_id, { codecpar: stream.codecpar, time_base: [stream.time_base_num, stream.time_base_den] });
    const chunks: Float32Array[][] = [];
    let sampleRate = 0;
    try {
      for (let done = false; !done;) {
        const [result, packets] = await av.ff_read_frame_multi(fmt, pkt, { limit: 4 << 20 });
        done = result === av.AVERROR_EOF;
        for (const f of await av.ff_decode_multi(c, pkt, frame, packets[stream.index] ?? [], { fin: done })) {
          sampleRate = f.sample_rate!;
          chunks.push(await toFloatPlanes(av, f));
        }
      }
    } finally { await av.ff_free_decoder(c, pkt, frame); }
    const channels = chunks[0]?.length ?? 0, total = chunks.reduce((n, p) => n + (p[0]?.length ?? 0), 0);
    const data = Array.from({ length: channels }, () => new Float32Array(total));
    let at = 0;
    for (const p of chunks) { for (let k = 0; k < channels; k++) data[k].set(p[k], at); at += p[0].length; }
    return { sampleRate, channels, data, source: 'wasm' };
  } finally { await av.avformat_close_input_js(fmt); await av.unlinkworkerfsfile(mount); }
}
async function toFloatPlanes(av: LibAV, f: Frame): Promise<Float32Array[]> {
  const fmt = (await av.av_get_sample_fmt_name(f.format)) as string, n = f.nb_samples!;
  const planar = fmt.endsWith('p'), base = planar ? fmt.slice(0, -1) : fmt;
  const scale = base === 's16' ? 1 / 32768 : base === 's32' ? 1 / 2147483648 : base === 'u8' ? 1 / 128 : 1;
  const conv = (x: ArrayLike<number>) => { const o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) o[i] = base === 'u8' ? (x[i] - 128) * scale : x[i] * scale; return o; };
  if (planar) return (f.data as ArrayLike<number>[]).map(conv);
  const all = conv(f.data as unknown as ArrayLike<number>), channels = all.length / n;
  return Array.from({ length: channels }, (_, k) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = all[i * channels + k]; return o; });
}
// Codec names as Mediabunny spells them, so records from both probes compare equal.
const CODEC_NAMES: Record<string, string> = { h264: 'avc', hevc: 'hevc', prores: 'prores', vp9: 'vp9', vp8: 'vp8', aac: 'aac', ac3: 'ac3', eac3: 'eac3', opus: 'opus', mp3: 'mp3', mp3float: 'mp3', vorbis: 'vorbis', flac: 'flac', pcm_s16le: 'pcm-s16', pcm_s16be: 'pcm-s16be', pcm_s24le: 'pcm-s24', pcm_s24be: 'pcm-s24be', pcm_s32le: 'pcm-s32', pcm_f32le: 'pcm-f32' };
/**
 * Software probe (review F7) for containers Mediabunny cannot read: streams, sizes and colour from the codec parameters,
 * frame count / fps / VFR from packet timestamps, SAR from the first frame. Format/stream tags preserve capture date,
 * ISO 6709 location and rotation; coded display-matrix side data takes precedence over a rotation tag.
 */
export async function probeLibav(blob: Blob, name = ''): Promise<MediaInfo> {
  const av = await loadLibav();
  const mount = `in-${crypto.randomUUID()}`, path = await av.mkworkerfsfile(mount, blob);
  let fmt = 0;
  try {
    const [f, streams] = await av.ff_init_demuxer_file(path); fmt = f;
    const video = streams.find(s => s.codec_type === av.AVMEDIA_TYPE_VIDEO), audio = streams.find(s => s.codec_type === av.AVMEDIA_TYPE_AUDIO);
    if (!video && !audio) throw new Error('no video or audio track');
    const tags = { ...await av.ff_copyout_dict(await av.AVFormatContext_metadata(fmt)), ...audio?.metadata, ...video?.metadata } as Record<string, string>;
    const stamp = tags['com.apple.quicktime.creationdate'] ?? tags['©day'] ?? tags.creation_time ?? tags.date;
    const date = stamp ? new Date(stamp) : null;
    const where = parseIso6709(tags['com.apple.quicktime.location.ISO6709'] ?? tags['©xyz'] ?? tags.location ?? '');
    // This pinned libav wrapper exposes no detected AVInputFormat accessor. Recognize AVI's signature before using
    // the supplied extension; never report a renamed AVI as a different container merely because of its filename.
    const signature = new TextDecoder('latin1').decode(await blob.slice(0, 12).arrayBuffer());
    const container = signature.startsWith('RIFF') && signature.slice(8) === 'AVI ' ? 'avi' : name.split('.').pop()?.toLowerCase() || 'unknown';
    const pkt = await av.av_packet_alloc(), pts: Record<number, number[]> = {}, ends: Record<number, number> = {}, firstVideo: Packet[] = [];
    try {
      for (let done = false; !done;) {
        const [result, packets] = await av.ff_read_frame_multi(fmt, pkt, { limit: 8 << 20 });
        done = result === av.AVERROR_EOF;
        if (result !== 0 && !done && result !== -av.EAGAIN) throw new Error(`demux failed (${result})`);
        for (const [index, list] of Object.entries(packets)) for (const p of list) {
          const s = streams[Number(index)], tb = s.time_base_num / s.time_base_den, t = ts(p.pts, p.ptshi) * tb, d = ((p as { duration?: number }).duration ?? 0) * tb;
          (pts[s.index] ??= []).push(t); ends[s.index] = Math.max(ends[s.index] ?? 0, t + d);
          if (video && s.index === video.index && firstVideo.length < 60) firstVideo.push(p);
        }
      }
    } finally { await av.av_packet_free_js?.(pkt); }
    const info: MediaInfo = { container, mimeType: blob.type, durationMs: Math.max(0, ...Object.values(ends)) * 1000 || null, video: null, audio: null, image: null, capturedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null, latitude: where?.latitude ?? null, longitude: where?.longitude ?? null, decoder: 'wasm' };
    if (video) {
      const cp = video.codecpar, list = (pts[video.index] ?? []).sort((a, b) => a - b);
      const colour = { primaries: PRIMARIES[await av.AVCodecParameters_color_primaries(cp)] ?? 'bt709', transfer: TRANSFER[await av.AVCodecParameters_color_trc(cp)] ?? 'bt709', matrix: MATRIX[await av.AVCodecParameters_color_space(cp)] ?? 'bt709', fullRange: await av.AVCodecParameters_color_range(cp) === 2 };
      const [w, h] = [await av.AVCodecParameters_width(cp), await av.AVCodecParameters_height(cp)];
      let sar = { num: 1, den: 1 };
      const [, c, dpkt, frame] = await av.ff_init_decoder(video.codec_id, { codecpar: cp, time_base: [video.time_base_num, video.time_base_den] });
      try { const first = (await av.ff_decode_multi(c, dpkt, frame, firstVideo, { fin: true, ignoreErrors: true }))[0] as Frame & { sample_aspect_ratio?: [number, number] }; if (first?.sample_aspect_ratio?.[0]) sar = { num: first.sample_aspect_ratio[0], den: first.sample_aspect_ratio[1] }; }
      finally { await av.ff_free_decoder(c, dpkt, frame); }
      const steps = list.slice(1).map((t, i) => t - list[i]), constant = steps.length > 0 && steps.every(s => Math.abs(s - steps[0]) < 0.002);
      const median = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] || 1 / 30, codec = String(await av.avcodec_get_name(video.codec_id));
      const parameters = await av.ff_copyout_codecpar(cp);
      const matrix = parameters.coded_side_data?.find((s: { type: number }) => s.type === 5)?.data as Uint8Array | undefined;
      const angle = matrix && matrix.length >= 36 ? Math.atan2(new DataView(matrix.buffer, matrix.byteOffset).getInt32(4, true), new DataView(matrix.buffer, matrix.byteOffset).getInt32(0, true)) * 180 / Math.PI : Number(tags.rotate ?? 0);
      const rotation = ((Math.round(angle / 90) * 90 % 360 + 360) % 360) as 0 | 90 | 180 | 270;
      const square = Math.round(w * sar.num / sar.den), quarter = rotation % 180 !== 0;
      info.video = { codec: CODEC_NAMES[codec] ?? codec, codecString: null, codedWidth: w, codedHeight: h, sampleAspectRatio: sar, displayWidth: quarter ? h : square, displayHeight: quarter ? square : h, rotation,
        fps: constant ? 1 / steps[0] : list.length / ((list.at(-1)! - list[0]) + median), vfr: !constant, frameCount: list.length, colour, hdr: colour.transfer === 'pq' ? 'pq' : colour.transfer === 'hlg' ? 'hlg' : colour.primaries === 'bt2020' ? 'bt2020' : null, bitDepth: null };
    }
    if (audio) {
      const cp = audio.codecpar, codec = String(await av.avcodec_get_name(audio.codec_id));
      info.audio = { codec: CODEC_NAMES[codec] ?? codec, sampleRate: await av.AVCodecParameters_sample_rate(cp), channels: await av.AVCodecParameters_ch_layout_nb_channels(cp) };
    }
    return info;
  } finally { if (fmt) await av.avformat_close_input_js(fmt); await av.unlinkworkerfsfile(mount); }
}
/**
 * Software image decode (review F8) → RGBA. TIFF through FFmpeg's TIFF decoder, in stored pixel order: its EXIF Orientation
 * is the probe's `image.orientation`, applied once by the display path (work.ts softwareImage, review F24). HEIF/HEIC through
 * its HEVC decoder → display pixels: tiles composed, `irot`/`imir` applied in association order. Per colour field: explicit nclx container value, then
 * decoded HEVC bitstream value, then the absent-both BT.601 limited fallback. Unspecified nclx codes do not override VUI.
 */
export async function decodeImageLibav(blob: Blob): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const av = await loadLibav(), bytes = new Uint8Array(await blob.arrayBuffer()), heif = parseHeif(bytes);
  const [, c, pkt, frame] = await av.ff_init_decoder(heif ? 'hevc' : 'tiff');
  try {
    const frames = await av.ff_decode_multi(c, pkt, frame, (heif ? heif.tiles : [bytes]).map(data => ({ data })), { fin: true });
    if (!frames.length) throw new Error('no picture decoded');
    if (!heif) return await packedOrPlanarToRgba(av, frames[0], null);
    const cp = await av.avcodec_parameters_alloc();
    let colour: LibavVideo['colour'];
    try {
      await av.avcodec_parameters_from_context(cp, c);
      const range = await av.AVCodecParameters_color_range(cp);
      colour = { primaries: heif.colour?.primaries ?? PRIMARIES[await av.AVCodecParameters_color_primaries(cp)] ?? 'smpte170m',
        transfer: heif.colour?.transfer ?? TRANSFER[await av.AVCodecParameters_color_trc(cp)] ?? 'bt709',
        matrix: heif.colour?.matrix ?? MATRIX[await av.AVCodecParameters_color_space(cp)] ?? 'smpte170m',
        fullRange: heif.colour?.fullRange ?? (range === 2) };
    } finally { await av.avcodec_parameters_free_js(cp); }
    const tiles = await Promise.all(frames.map(f => packedOrPlanarToRgba(av, f, colour)));
    const outW = heif.grid?.outputWidth ?? tiles[0].width, outH = heif.grid?.outputHeight ?? tiles[0].height, out = new Uint8ClampedArray(outW * outH * 4), columns = heif.grid?.columns ?? 1;
    tiles.forEach((tile, i) => {
      const x0 = (i % columns) * tile.width, y0 = Math.floor(i / columns) * tile.height;
      for (let y = 0; y < tile.height && y0 + y < outH; y++) { const w = Math.min(tile.width, outW - x0); if (w > 0) out.set(tile.data.subarray(y * tile.width * 4, (y * tile.width + w) * 4), ((y0 + y) * outW + x0) * 4); }
    });
    let image: { width: number; height: number; data: Uint8ClampedArray } = { width: outW, height: outH, data: out };
    for (const transform of heif.transforms) {
      if (transform.type === 'rotate') image = rotateRgba(image.data, image.width, image.height, transform.degrees);
      else {
        // imir axis 0 exchanges top/bottom, axis 1 left/right (libavif avifImageMirror, ISO 23008-12).
        const pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, image.width * image.height);
        if (transform.axis === 1) for (let y = 0; y < image.height; y++) pixels.subarray(y * image.width, (y + 1) * image.width).reverse();
        else for (let y = 0; y < Math.floor(image.height / 2); y++) for (let x = 0; x < image.width; x++) {
          const a = y * image.width + x, b = (image.height - 1 - y) * image.width + x; [pixels[a], pixels[b]] = [pixels[b], pixels[a]];
        }
      }
    }
    return image;
  } finally { await av.ff_free_decoder(c, pkt, frame); }
}
async function packedOrPlanarToRgba(av: LibAV, f: Frame, colour: LibavVideo['colour'] | null): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const w = f.width!, h = f.height!, data = f.data as Uint8Array, layout = f.layout!, out = new Uint8ClampedArray(w * h * 4);
  const formats: Record<number, [number, number, number, number, number]> = {}; // format → [bytes per pixel, R, G, B, A index (-1 none)]
  formats[av.AV_PIX_FMT_RGB24] = [3, 0, 1, 2, -1]; formats[av.AV_PIX_FMT_BGR24] = [3, 2, 1, 0, -1]; formats[av.AV_PIX_FMT_RGBA] = [4, 0, 1, 2, 3];
  formats[av.AV_PIX_FMT_BGRA] = [4, 2, 1, 0, 3]; formats[av.AV_PIX_FMT_ARGB] = [4, 1, 2, 3, 0]; formats[av.AV_PIX_FMT_ABGR] = [4, 3, 2, 1, 0];
  const packed = formats[f.format];
  if (packed) {
    const [bpp, r, g, b, a] = packed, stride = layout[0].stride;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = layout[0].offset + y * stride + x * bpp, o = (y * w + x) * 4; out[o] = data[i + r]; out[o + 1] = data[i + g]; out[o + 2] = data[i + b]; out[o + 3] = a < 0 ? 255 : data[i + a]; }
    return { width: w, height: h, data: out };
  }
  if (f.format === av.AV_PIX_FMT_RGB48LE || f.format === av.AV_PIX_FMT_RGB48BE || f.format === av.AV_PIX_FMT_GRAY16LE || f.format === av.AV_PIX_FMT_GRAY16BE) {
    const little = f.format === av.AV_PIX_FMT_RGB48LE || f.format === av.AV_PIX_FMT_GRAY16LE, gray = f.format === av.AV_PIX_FMT_GRAY16LE || f.format === av.AV_PIX_FMT_GRAY16BE;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength), stride = layout[0].stride;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = layout[0].offset + y * stride + x * (gray ? 2 : 6), o = (y * w + x) * 4; for (let k = 0; k < 3; k++) out[o + k] = v.getUint16(i + (gray ? 0 : 2 * k), little) >> 8; out[o + 3] = 255; }
    return { width: w, height: h, data: out };
  }
  if (f.format === av.AV_PIX_FMT_GRAY8 || f.format === av.AV_PIX_FMT_PAL8 || f.format === av.AV_PIX_FMT_MONOWHITE || f.format === av.AV_PIX_FMT_MONOBLACK) {
    const stride = layout[0].stride, palette = f.format === av.AV_PIX_FMT_PAL8 ? data.subarray(layout[1].offset, layout[1].offset + 1024) : null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, row = layout[0].offset + y * stride;
      if (palette) { const p = data[row + x] * 4; out[o] = palette[p + 2]; out[o + 1] = palette[p + 1]; out[o + 2] = palette[p]; out[o + 3] = palette[p + 3]; continue; }
      const level = f.format === av.AV_PIX_FMT_GRAY8 ? data[row + x] : ((data[row + (x >> 3)] >> (7 - (x & 7))) & 1) ^ (f.format === av.AV_PIX_FMT_MONOWHITE ? 1 : 0) ? 255 : 0;
      out[o] = out[o + 1] = out[o + 2] = level; out[o + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }
  const raw = await toRaw(av, f, 1, colour ?? { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
  return { width: w, height: h, data: yuvToRgba(raw, raw.colour.matrix, null) };
}
