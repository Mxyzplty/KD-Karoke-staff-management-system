// SPDX-License-Identifier: AGPL-3.0-only
// Source probing (findings §2): Mediabunny Input over a Blob → the asset's media record. Image headers and EXIF are read
// here too. Sources Mediabunny cannot open fall back to the WASM probe (libav.ts) in the browser.
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { mediaError } from './codes';
import { mimeFor } from './files';
import { isHeif, parseHeif } from './heif';
import type { Asset } from '../store/model';

export type Colour = { primaries: string; transfer: string; matrix: string; fullRange: boolean };
export type HdrKind = 'pq' | 'hlg' | 'bt2020' | null;
export type MediaInfo = {
  container: string; mimeType: string; durationMs: number | null;
  video: null | {
    codec: string; codecString: string | null; codedWidth: number; codedHeight: number; sampleAspectRatio: { num: number; den: number };
    /** width × SAR rounded (G-08 decision 3), then swapped for 90/270 rotation. */
    displayWidth: number; displayHeight: number; rotation: 0 | 90 | 180 | 270;
    fps: number; vfr: boolean; frameCount: number | null; colour: Colour; hdr: HdrKind; bitDepth: number | null;
  };
  audio: null | { codec: string; sampleRate: number; channels: number };
  image: null | { width: number; height: number; orientation: number };
  capturedAt: string | null; latitude: number | null; longitude: number | null;
  decoder: 'webcodecs' | 'wasm' | 'native-image' | null;
};
const CONTAINERS: Record<string, string> = { MP4: 'mp4', 'QuickTime File Format': 'mov', Matroska: 'mkv', WebM: 'webm', MP3: 'mp3', WAVE: 'wav', Ogg: 'ogg', FLAC: 'flac', ADTS: 'adts', 'MPEG Transport Stream': 'mpegts' };
const BT709: Colour = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
export function hdrKind(c: Colour): HdrKind { return c.transfer === 'pq' ? 'pq' : c.transfer === 'hlg' ? 'hlg' : c.primaries === 'bt2020' ? 'bt2020' : null; }
/** HEVC profile 2 (Main 10) and ProRes are 10-bit; 8-bit otherwise when the codec string tells. */
function bitDepth(codec: string, codecString: string | null): number | null {
  if (codec === 'prores') return 10;
  if (codec === 'hevc' && codecString) return /^(hev1|hvc1)\.A?2\./.test(codecString) ? 10 : 8;
  if (codec === 'avc' && codecString) return /^avc[13]\.(6e|7a|f4)/i.test(codecString) ? 10 : 8;
  if (codec === 'vp9' && codecString) return Number(codecString.split('.')[3]) || null;
  return null;
}
export async function probeMedia(blob: Blob, name: string, kind: Asset['type']): Promise<MediaInfo> {
  if (kind === 'image') return probeImage(blob, name);
  let input: Input | undefined;
  try {
    input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const format = await input.getFormat().catch(() => null);
    // Review F7: containers Mediabunny cannot read (AVI, …) are probed by the WASM software path (master plan §1b).
    if (!format) return await softwareProbe(blob, name);
    const [mimeType, durationS, tags] = await Promise.all([input.getMimeType(), input.computeDuration(), input.getMetadataTags().catch(() => ({ raw: {} }) as never)]);
    const v = await input.getPrimaryVideoTrack(), a = await input.getPrimaryAudioTrack();
    // A recognised container without any track is cut off or damaged (e.g. an MP4 whose movie box never landed).
    if (!v && !a) throw mediaError('CORRUPT_FILE', undefined, { reason: `“${name}” has no video or audio track.` });
    const info: MediaInfo = { container: CONTAINERS[format.name] ?? format.name.toLowerCase(), mimeType, durationMs: Number.isFinite(durationS) ? durationS * 1000 : null, video: null, audio: null, image: null, capturedAt: null, latitude: null, longitude: null, decoder: null };
    if (v) {
      const [w, h, par, rotation, cs, config, metrics, stats, last, start] = await Promise.all([v.getCodedWidth(), v.getCodedHeight(), v.getPixelAspectRatio(), v.getRotation(), v.getColorSpace(), v.getDecoderConfig(), v.computeFrameRateMetrics(), v.computePacketStats(), new EncodedPacketSink(v).getPacket(Infinity, { metadataOnly: true }), v.getFirstTimestamp()]);
      const colour: Colour = { primaries: cs.primaries ?? BT709.primaries, transfer: cs.transfer ?? BT709.transfer, matrix: cs.matrix ?? BT709.matrix, fullRange: cs.fullRange ?? BT709.fullRange };
      const sar = { num: par.num || 1, den: par.den || 1 }, squareW = Math.round(w * sar.num / sar.den), quarter = rotation === 90 || rotation === 270;
      // VFR = timestamps off one constant lattice step (dropped frames included); its fps is the average rate.
      const vfr = !metrics.frameRateIsConstant;
      const codec = v.codec ?? 'unknown', codecString = config?.codec ?? null;
      info.video = { codec, codecString, codedWidth: w, codedHeight: h, sampleAspectRatio: sar, displayWidth: quarter ? h : squareW, displayHeight: quarter ? squareW : h, rotation,
        // ffprobe's avg_frame_rate: frames / (last − first timestamp + one median frame step).
        fps: vfr ? stats.packetCount / ((last?.timestamp ?? start) - start + 1 / metrics.medianFrameRate) : metrics.underlyingFrameRate ?? metrics.bestGuessFrameRate, vfr, frameCount: stats.packetCount, colour, hdr: hdrKind(colour), bitDepth: bitDepth(codec, codecString) };
    }
    if (a) {
      const [sampleRate, channels] = [a.sampleRate, a.numberOfChannels];
      info.audio = { codec: a.codec ?? 'unknown', sampleRate, channels };
    }
    const raw = (tags.raw ?? {}) as Record<string, unknown>;
    info.capturedAt = tags.date ? tags.date.toISOString() : await quickTimeCreation(blob);
    const where = parseIso6709(String(raw['com.apple.quicktime.location.ISO6709'] ?? raw['©xyz'] ?? '')) ?? parseLoci(raw.loci);
    if (where) { info.latitude = where.latitude; info.longitude = where.longitude; }
    return info;
  } catch (e) {
    if ((e as { code?: string }).code) throw e;
    // The container was recognised (getFormat passed) but could not be parsed: corrupt or truncated source.
    throw mediaError('CORRUPT_FILE', undefined, { reason: (e as Error)?.message ?? String(e) });
  } finally { input?.dispose(); }
}
/** The libav probe runs in browsers (page or worker); in Node there is none and the format stays unsupported. */
async function softwareProbe(blob: Blob, name: string): Promise<MediaInfo> {
  const browser = typeof document !== 'undefined' || typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
  const unsupported = mediaError('UNSUPPORTED_INPUT', `“${name}” is in an unsupported or unrecognizable format.`);
  if (!browser) throw unsupported;
  try { return await (await import('./libav')).probeLibav(blob, name); } catch (e) { throw (e as { code?: string }).code ? e : unsupported; }
}
/** ISO 6709 point, e.g. "+52.3696+004.8999/" or "+52.3696+004.8999+010.0/". */
export function parseIso6709(text: string): { latitude: number; longitude: number } | null {
  const m = text.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const latitude = Number(m[1]), longitude = Number(m[2]);
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}
/** 3GPP `loci` box (MP4 files written by FFmpeg and some phones): version/flags, language, name, role, then 16.16 lon/lat. */
export function parseLoci(value: unknown): { latitude: number; longitude: number } | null {
  if (!(value instanceof Uint8Array) || value.length < 18) return null;
  let at = 6; while (at < value.length && value[at] !== 0) at++;
  at += 2; // name terminator + role
  if (at + 8 > value.length) return null;
  const view = new DataView(value.buffer, value.byteOffset + at, 8), longitude = view.getInt32(0) / 65536, latitude = view.getInt32(4) / 65536;
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}
/** QuickTime/MP4 movie-header creation time (seconds since 1904-01-01 UTC); 0 means unset. Mediabunny skips this field. */
export async function quickTimeCreation(blob: Blob): Promise<string | null> {
  const read = async (at: number, n: number) => new DataView(await blob.slice(at, at + n).arrayBuffer());
  const boxes = async function* (start: number, end: number) {
    for (let at = start; at + 8 <= end;) {
      const head = await read(at, 16); if (head.byteLength < 8) return;
      let size = head.getUint32(0); const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
      let header = 8;
      if (size === 1 && head.byteLength >= 16) { size = Number(head.getBigUint64(8)); header = 16; } else if (size === 0) size = end - at;
      if (size < header) return;
      yield { type, start: at + header, end: at + size }; at += size;
    }
  };
  try {
    for await (const box of boxes(0, blob.size)) {
      if (box.type !== 'moov') continue;
      for await (const child of boxes(box.start, box.end)) {
        if (child.type !== 'mvhd') continue;
        const d = await read(child.start, 12), seconds = d.getUint8(0) === 1 ? Number(d.getBigUint64(4)) : d.getUint32(4);
        return seconds ? new Date(Date.UTC(1904, 0, 1) + seconds * 1000).toISOString() : null;
      }
    }
  } catch { /* not an ISO-BMFF file */ }
  return null;
}
/**
 * Image probe. Review F8: every accepted image extension must really ingest. Chromium decodes neither TIFF nor HEIC, so
 * their sizes come from their own headers (TIFF IFD0, HEIF `ispe`/`irot`) and they decode through our libav build; SVG
 * intrinsic sizing is delegated to the browser; Node's header probe handles absolute units and viewBox aspect ratio.
 */
async function probeImage(blob: Blob, name: string): Promise<MediaInfo> {
  const head = new Uint8Array(await blob.slice(0, 256 << 10).arrayBuffer());
  const mimeType = mimeFor(name, blob.type);
  let size: { width: number; height: number } | null = null, decoder: MediaInfo['decoder'] = 'native-image', container = mimeType.split('/')[1] ?? 'image', orientation: number | null = null;
  if (isHeif(head)) {
    const heif = parseHeif(new Uint8Array(await blob.arrayBuffer()));
    if (!heif) throw mediaError('UNSUPPORTED_INPUT', 'This HEIF image uses a layout Cutframe cannot read.');
    const quarter = heif.rotation % 180 !== 0;
    size = { width: quarter ? heif.height : heif.width, height: quarter ? heif.width : heif.height }; decoder = 'wasm'; container = 'heic'; orientation = 1;
  } else if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d)) { size = await tiffSize(blob); decoder = 'wasm'; container = 'tiff'; }
  else if (/<svg[\s>]/i.test(new TextDecoder().decode(head.subarray(0, 4096)))) { size = typeof Image === 'function' ? await svgIntrinsicSize(blob) : svgSize(await blob.text()); container = 'svg+xml'; }
  else size = imageSize(head) ?? await browserImageSize(blob);
  if (!size) throw mediaError('UNSUPPORTED_INPUT', 'This image could not be read.');
  const exif = await readExif(blob);
  orientation ??= exif.orientation;
  const quarter = orientation >= 5 && orientation <= 8;
  return { container, mimeType, durationMs: null, video: null, audio: null,
    image: { width: quarter ? size.height : size.width, height: quarter ? size.width : size.height, orientation },
    capturedAt: exif.capturedAt, latitude: exif.latitude, longitude: exif.longitude, decoder };
}
/** TIFF IFD0 ImageWidth (256) / ImageLength (257); the IFD can sit anywhere in the file. */
async function tiffSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const read = async (at: number, n: number) => new DataView(await blob.slice(at, at + n).arrayBuffer());
  const h = await read(0, 8), little = h.getUint8(0) === 0x49;
  if (h.getUint16(2, little) !== 42) return null;
  const ifd = h.getUint32(4, little), count = (await read(ifd, 2)).getUint16(0, little), entries = await read(ifd + 2, count * 12);
  let width = 0, height = 0;
  for (let i = 0; i < count; i++) {
    const tag = entries.getUint16(i * 12, little), type = entries.getUint16(i * 12 + 2, little), value = type === 3 ? entries.getUint16(i * 12 + 8, little) : entries.getUint32(i * 12 + 8, little);
    if (tag === 256) width = value; if (tag === 257) height = value;
  }
  return width && height ? { width, height } : null;
}
export function svgSize(text: string): { width: number; height: number } {
  const tag = text.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  const units: Record<string, number> = { '': 1, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 };
  const attr = (n: string) => { const m = tag.match(new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)([a-z]*)\\s*["']`, 'i')); return m && units[m[2].toLowerCase()] !== undefined ? Number(m[1]) * units[m[2].toLowerCase()] : null; };
  const box = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  const w = attr('width'), h = attr('height'), ratio = box && Number(box[2]) > 0 ? Number(box[1]) / Number(box[2]) : null;
  const width = w ?? (h && ratio ? h * ratio : box ? Number(box[1]) : 300), height = h ?? (w && ratio ? w / ratio : box ? Number(box[2]) : 150);
  return { width: Math.round(width), height: Math.round(height) };
}
/** The browser owns SVG intrinsic sizing (absolute/relative units, viewBox aspect ratio and the default object size). */
async function svgIntrinsicSize(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' }));
  try { const image = new Image(); image.src = url; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }
  finally { URL.revokeObjectURL(url); }
}
/** PNG / JPEG / GIF / WebP / BMP dimensions from the header bytes. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: v.getUint32(16), height: v.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: v.getInt32(18, true), height: Math.abs(v.getInt32(22, true)) };
  if (b.length > 30 && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...b.subarray(12, 16));
    if (kind === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === 'VP8L') { const n = v.getUint32(21, true); return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let at = 2; at + 9 < b.length;) {
      if (b[at] !== 0xff) { at++; continue; }
      const marker = b[at + 1], length = v.getUint16(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: v.getUint16(at + 7), height: v.getUint16(at + 5) };
      at += 2 + length;
    }
  }
  return null;
}
async function browserImageSize(blob: Blob) {
  if (typeof createImageBitmap !== 'function') return null;
  try { const bitmap = await createImageBitmap(blob); const size = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return size; } catch { return null; }
}
/** EXIF capture time (DateTimeOriginal, else DateTime) and GPS. A time without an offset tag is stored as UTC wall-clock (stated assumption). */
async function readExif(blob: Blob): Promise<{ capturedAt: string | null; latitude: number | null; longitude: number | null; orientation: number }> {
  const none = { capturedAt: null, latitude: null, longitude: null, orientation: 1 };
  try {
    const exifr = (await import('exifr')).default;
    const bytes = await blob.slice(0, Math.min(blob.size, 16 << 20)).arrayBuffer();
    const tags = await exifr.parse(bytes, { tiff: true, exif: true, gps: true, reviveValues: false, translateValues: false });
    if (!tags) return none;
    const stamp = String(tags.DateTimeOriginal ?? tags.CreateDate ?? tags.DateTime ?? '');
    const m = stamp.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    const offset = typeof tags.OffsetTimeOriginal === 'string' && /^[+-]\d{2}:\d{2}$/.test(tags.OffsetTimeOriginal) ? tags.OffsetTimeOriginal : 'Z';
    const capturedAt = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset}`).toISOString() : null;
    const dms = (x: unknown) => Array.isArray(x) ? x[0] + x[1] / 60 + x[2] / 3600 : typeof x === 'number' ? x : NaN;
    let latitude = dms(tags.GPSLatitude), longitude = dms(tags.GPSLongitude);
    if (tags.GPSLatitudeRef === 'S') latitude = -latitude;
    if (tags.GPSLongitudeRef === 'W') longitude = -longitude;
    return { capturedAt, latitude: Number.isFinite(latitude) ? latitude : null, longitude: Number.isFinite(longitude) ? longitude : null, orientation: Number(tags.Orientation) || 1 };
  } catch { return none; }
}
