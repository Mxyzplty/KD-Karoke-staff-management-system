// SPDX-License-Identifier: AGPL-3.0-only
// Media work that runs inside the media worker (thumbnails, waveforms, proxies). Browser-only (OffscreenCanvas, WebCodecs).
import { ALL_FORMATS, AudioSample, AudioSampleSource, BlobSource, BufferTarget, CanvasSink, Conversion, Input, Mp4OutputFormat, Output, VideoSample, VideoSampleSource, WebMOutputFormat, canEncodeAudio, canEncodeVideo } from 'mediabunny';
import type { AudioCodec, VideoCodec } from 'mediabunny';
import { mediaError } from './codes';
import { mono, resample } from '../analysis/audio';
import { decodeAudio, frameToRgba, rotateRgba, videoDecoder, videoFrames } from './decode';
import type { DecodeOptions, RawAudio } from './decode';
import type { MediaInfo } from './probe';
import type { ProxyResult, ThumbnailRow, WaveformRow } from './prepare';

export const THUMB_MAX = 320, POSTER_QUALITY = 0.9, SOURCE_PREVIEW_FRAMES = 10, PEAKS_PER_SECOND = 100, PROXY_BOX = { long: 1280, short: 720 }, PROXY_BITRATE = 2_500_000;
const BT709: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true };
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** Fit (w, h) into a long × short box without upscaling. */
export function fitBox(w: number, h: number, long: number, short: number) {
  const [bw, bh] = w >= h ? [long, short] : [short, long], s = Math.min(1, bw / w, bh / h);
  return { width: even(w * s), height: even(h * s) };
}
const hdr = (info: MediaInfo) => info.video?.colour.transfer === 'pq' || info.video?.colour.transfer === 'hlg';
/** Display-oriented, square-pixel canvases of the frames whose timestamps are nearest each requested time. */
export async function* displayFrames(blob: Blob, info: MediaInfo, times: number[], size: { width: number; height: number }, options: DecodeOptions = {}): AsyncGenerator<{ t: number; canvas: OffscreenCanvas }> {
  const v = info.video!;
  if (!hdr(info) && await videoDecoder(blob, options) === 'webcodecs') {
    // Fast path for SDR WebCodecs sources: Mediabunny draws, rotates and scales on the GPU.
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
      const sink = new CanvasSink((await input.getPrimaryVideoTrack())!, { ...size, fit: 'fill' });
      let i = 0;
      for await (const wrapped of sink.canvasesAtTimestamps(times)) {
        const t = times[i++]; if (!wrapped) continue;
        const canvas = new OffscreenCanvas(size.width, size.height); canvas.getContext('2d')!.drawImage(wrapped.canvas, 0, 0);
        yield { t, canvas };
      }
    } finally { input.dispose(); }
    return;
  }
  const scratch = new OffscreenCanvas(1, 1), pending = [...times].sort((a, b) => a - b);
  let previous: { timestamp: number; canvas: () => OffscreenCanvas } | undefined;
  const render = (frame: Parameters<typeof frameToRgba>[0]) => () => {
    const rgba = frameToRgba(frame, v.rotation);
    scratch.width = rgba.width; scratch.height = rgba.height;
    scratch.getContext('2d')!.putImageData(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height), 0, 0);
    const out = new OffscreenCanvas(size.width, size.height); out.getContext('2d')!.drawImage(scratch, 0, 0, size.width, size.height);
    return out;
  };
  for await (const frame of videoFrames(blob, options)) {
    while (pending.length && frame.timestamp > pending[0] + 1e-6) { const t = pending.shift()!; if (previous) yield { t, canvas: previous.canvas() }; }
    if (!pending.length) break;
    previous = { timestamp: frame.timestamp, canvas: render(frame) };
  }
  for (const t of pending) if (previous) yield { t, canvas: previous.canvas() };
}
/**
 * Software still → display canvas. TIFF pixels arrive in stored order and get the probed EXIF Orientation here, once
 * (review F24): 2, 4, 5, 7 mirror left/right first, then 3/4 turn 180°, 5/8 turn 270° and 6/7 turn 90° clockwise.
 * HEIF arrives already displayed (irot/imir); its probed orientation is 1.
 */
async function softwareImage(blob: Blob, orientation: number): Promise<OffscreenCanvas> {
  const decoded = await (await import('./libav')).decodeImageLibav(blob);
  if ([2, 4, 5, 7].includes(orientation)) {
    const pixels = new Uint32Array(decoded.data.buffer, decoded.data.byteOffset, decoded.width * decoded.height);
    for (let y = 0; y < decoded.height; y++) pixels.subarray(y * decoded.width, (y + 1) * decoded.width).reverse();
  }
  const rgba = rotateRgba(decoded.data, decoded.width, decoded.height, ([0, 0, 0, 180, 180, 270, 90, 90, 270] as const)[orientation] ?? 0), canvas = new OffscreenCanvas(rgba.width, rgba.height);
  canvas.getContext('2d')!.putImageData(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height), 0, 0);
  return canvas;
}
/** Poster (frame at min(1 s, duration / 2)) plus SOURCE_PREVIEW_FRAMES evenly spaced source-preview frames, JPEG, ≤ 320 px. */
export async function makeThumbnails(blob: Blob, info: MediaInfo, options: DecodeOptions = {}): Promise<Omit<ThumbnailRow, 'id'>> {
  if (info.image) {
    // TIFF and HEIC (decoder 'wasm' from the probe) decode through our libav build; every other still through the browser.
    const source = info.decoder === 'wasm' ? await softwareImage(blob, info.image.orientation) : await createImageBitmap(blob, { imageOrientation: 'from-image' }), size = fitBox(source.width, source.height, THUMB_MAX, THUMB_MAX);
    const canvas = new OffscreenCanvas(size.width, size.height); canvas.getContext('2d')!.drawImage(source, 0, 0, size.width, size.height); if (source instanceof ImageBitmap) source.close();
    const poster = await canvas.convertToBlob({ type: 'image/jpeg', quality: POSTER_QUALITY });
    return { ...size, poster, frames: [{ t: 0, blob: poster }] };
  }
  const v = info.video!, size = fitBox(v.displayWidth, v.displayHeight, THUMB_MAX, THUMB_MAX), duration = (info.durationMs ?? 0) / 1000;
  const posterT = Math.min(1, duration / 2), times = [posterT, ...Array.from({ length: SOURCE_PREVIEW_FRAMES }, (_, i) => (i + 0.5) / SOURCE_PREVIEW_FRAMES * duration)];
  const shots = new Map<number, Blob>();
  for await (const { t, canvas } of displayFrames(blob, info, times, size, options)) if (!shots.has(t)) shots.set(t, await canvas.convertToBlob({ type: 'image/jpeg', quality: POSTER_QUALITY }));
  const poster = shots.get(posterT) ?? shots.values().next().value;
  if (!poster) throw mediaError('DECODE_ERROR', 'No frame could be decoded for the thumbnail.');
  return { ...size, poster, frames: times.slice(1).filter(t => shots.has(t)).map(t => ({ t, blob: shots.get(t)! })) };
}
/** Min/max peaks of the channel mix, PEAKS_PER_SECOND buckets per second (interleaved min, max). */
export function peaksFromPcm(audio: RawAudio): Omit<WaveformRow, 'id'> {
  const n = audio.data[0]?.length ?? 0, per = audio.sampleRate / PEAKS_PER_SECOND, buckets = Math.ceil(n / per), peaks = new Float32Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = Math.floor(b * per), end = Math.min(n, Math.floor((b + 1) * per)); i < end; i++) {
      let s = 0; for (const ch of audio.data) s += ch[i]; s /= audio.channels;
      if (s < lo) lo = s; if (s > hi) hi = s;
    }
    peaks[2 * b] = Number.isFinite(lo) ? lo : 0; peaks[2 * b + 1] = Number.isFinite(hi) ? hi : 0;
  }
  return { version: 1, bucketsPerSecond: PEAKS_PER_SECOND, durationMs: n / audio.sampleRate * 1000, sampleRate: audio.sampleRate, channels: audio.channels, peaks };
}
export async function makeWaveform(blob: Blob, options: DecodeOptions = {}) { return peaksFromPcm(await decodeAudio(blob, options)); }
/** T19: display frames as RGBA for the vision model, fitted into a box × box square without upscaling. */
export async function analysisFrames(blob: Blob, info: MediaInfo, times: number[], box: number, options: DecodeOptions = {}): Promise<{ timestamp: number; width: number; height: number; data: Uint8ClampedArray }[]> {
  const rgba = (canvas: OffscreenCanvas) => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  if (info.image) {
    const source = info.decoder === 'wasm' ? await softwareImage(blob, info.image.orientation) : await createImageBitmap(blob, { imageOrientation: 'from-image' }), size = fitBox(source.width, source.height, box, box);
    const canvas = new OffscreenCanvas(size.width, size.height); canvas.getContext('2d')!.drawImage(source, 0, 0, size.width, size.height); if (source instanceof ImageBitmap) source.close();
    return [{ timestamp: 0, ...size, data: rgba(canvas) }];
  }
  const v = info.video!, size = fitBox(v.displayWidth, v.displayHeight, box, box), frames: { timestamp: number; width: number; height: number; data: Uint8ClampedArray }[] = [];
  for await (const { t, canvas } of displayFrames(blob, info, times, size, options)) if (!frames.some(f => f.timestamp === t)) frames.push({ timestamp: t, ...size, data: rgba(canvas) });
  if (!frames.length) throw mediaError('DECODE_ERROR', 'No frame could be decoded for analysis.');
  return frames;
}
/** T19: the channel mix at 16 kHz for the speech models. */
export async function analysisPcm(blob: Blob, options: DecodeOptions = {}) { return resample(await decodeAudio(blob, options), 16000); }
/** Mono PCM at the source rate (the beat tracker runs at the native rate, as T19a scored it). */
export async function analysisAudio(blob: Blob, options: DecodeOptions = {}) { const audio = await decodeAudio(blob, options); return { sampleRate: audio.sampleRate, channels: 1, data: [mono(audio)] }; }
/** A source range [start, end) s as its own file (T19 C8, the /api/video-range equivalent): MP4, else WebM when this
 *  browser cannot encode for MP4. Trimming re-encodes. */
export async function cutRange(blob: Blob, start: number, end: number): Promise<{ blob: Blob; extension: 'mp4' | 'webm' }> {
  for (const [format, extension] of [[new Mp4OutputFormat({ fastStart: 'in-memory' }), 'mp4'], [new WebMOutputFormat(), 'webm']] as const) {
    const target = new BufferTarget(), output = new Output({ format, target });
    const conversion = await Conversion.init({ input: new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }), output, trim: { start, end } });
    if (!conversion.isValid) continue;
    await conversion.execute();
    return { blob: new Blob([target.buffer!], { type: format.mimeType }), extension };
  }
  throw mediaError('ENCODE_FAILED', 'This browser cannot cut a clip from this file.');
}
/** Browser-generated proxy: display orientation, square pixels, ≤ 1280 × 720, H.264/AAC in MP4, else VP9 or VP8/Opus in WebM. */
export async function makeProxy(blob: Blob, info: MediaInfo, options: DecodeOptions & { signal?: AbortSignal } = {}): Promise<ProxyResult> {
  const v = info.video!, size = fitBox(v.displayWidth, v.displayHeight, PROXY_BOX.long, PROXY_BOX.short);
  let videoCodec: VideoCodec | undefined;
  for (const codec of ['avc', 'vp9', 'vp8'] as VideoCodec[]) if (await canEncodeVideo(codec, { ...size, bitrate: PROXY_BITRATE })) { videoCodec = codec; break; }
  if (!videoCodec) throw mediaError('ENCODE_FAILED', 'This browser cannot encode a proxy video.');
  // Audio: AAC in MP4, else Opus (Linux Chromium encodes no AAC); WebM always Opus.
  const mp4 = videoCodec === 'avc';
  let audioCodec: AudioCodec | undefined;
  if (info.audio) for (const codec of (mp4 ? ['aac', 'opus'] : ['opus']) as AudioCodec[]) if (await canEncodeAudio(codec, { numberOfChannels: Math.min(2, info.audio.channels), sampleRate: 48000, bitrate: 128_000 })) { audioCodec = codec; break; }
  const target = new BufferTarget(), output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
  const video = new VideoSampleSource({ codec: videoCodec, bitrate: PROXY_BITRATE, keyFrameInterval: 2 });
  output.addVideoTrack(video);
  const audio = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate: 128_000 }) : null;
  if (audio) output.addAudioTrack(audio);
  try {
    await output.start();
    const duration = (info.durationMs ?? 0) / 1000;
    const times = v.vfr || !v.frameCount ? null : Array.from({ length: v.frameCount }, (_, k) => k / v.fps);
    let previous: { t: number; canvas: OffscreenCanvas } | undefined;
    const flush = async (next: number) => {
      if (!previous) return;
      // Raw RGBX tagged BT.709 like export frames (findings §5): a canvas-sourced frame would be tagged sRGB.
      const { width, height } = previous.canvas, pixels = previous.canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
      const sample = new VideoSample(pixels, { format: 'RGBX', codedWidth: width, codedHeight: height, timestamp: previous.t, duration: Math.max(1 / 240, next - previous.t), colorSpace: BT709 });
      try { await video.add(sample); } finally { sample.close(); }
    };
    if (times) {
      for await (const shot of displayFrames(blob, info, times, size, options)) { if (options.signal?.aborted) throw options.signal.reason; await flush(shot.t); previous = shot; }
    } else {
      // VFR: keep every source timestamp.
      for await (const frame of videoFrames(blob, options)) {
        if (options.signal?.aborted) throw options.signal.reason;
        const rgba = frameToRgba(frame, v.rotation), scratch = new OffscreenCanvas(rgba.width, rgba.height);
        scratch.getContext('2d')!.putImageData(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height), 0, 0);
        const canvas = new OffscreenCanvas(size.width, size.height); canvas.getContext('2d')!.drawImage(scratch, 0, 0, size.width, size.height);
        await flush(frame.timestamp); previous = { t: frame.timestamp, canvas };
      }
    }
    await flush(duration > (previous?.t ?? 0) ? duration : (previous?.t ?? 0) + 1 / Math.max(1, v.fps));
    if (audio) {
      const pcm = await decodeAudio(blob, options), channels = Math.min(2, pcm.channels), step = pcm.sampleRate;
      for (let at = 0; at < (pcm.data[0]?.length ?? 0); at += step) {
        const n = Math.min(step, pcm.data[0].length - at), data = new Float32Array(n * channels);
        for (let k = 0; k < channels; k++) data.set(pcm.data[k].subarray(at, at + n), k * n);
        const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: channels, sampleRate: pcm.sampleRate, timestamp: at / pcm.sampleRate });
        try { await audio.add(sample); } finally { sample.close(); }
      }
    }
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    if ((e as { code?: string }).code || (e as Error)?.name === 'AbortError') throw e;
    throw mediaError('ENCODE_FAILED', `The proxy could not be encoded: ${(e as Error)?.message ?? e}`);
  }
  return { blob: new Blob([target.buffer!], { type: mp4 ? 'video/mp4' : 'video/webm' }), codec: videoCodec, container: mp4 ? 'mp4' : 'webm', ...size };
}
