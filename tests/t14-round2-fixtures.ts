// SPDX-License-Identifier: AGPL-3.0-only
// Independent HEIF writer and ffmpeg pixel oracle. No product parsing/transform/colour helper is used here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { media } from './media-fixtures';
const dir = mkdtempSync(path.join(tmpdir(), 't14-round2-'));
const run = (args: string[]) => { const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 32 << 20 }); if (r.status !== 0) throw Error(String(r.stderr)); return r.stdout as Buffer; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type: string, ...data: Buffer[]) => { const b = Buffer.concat(data); return Buffer.concat([u32(8 + b.length), Buffer.from(type), b]); };
const full = (type: string, ...data: Buffer[]) => box(type, Buffer.alloc(4), ...data);
export type HeifCase = { axis?: 0 | 1; rotation?: 0 | 1 | 2 | 3; mirrorFirst?: boolean; vui?: boolean; colr?: '601' | '709' | 'unspecified' };
let encoded: Record<string, Buffer> = {};
export function heifCase(options: HeifCase = {}) {
  const key = options.vui ? '709' : 'absent';
  const bitstream = encoded[key] ??= run(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=1:duration=1', '-frames:v', '1', '-pix_fmt', 'yuv444p', '-c:v', 'libx265', '-x265-params',
    `log-level=error:keyint=1${options.vui ? ':range=full:colorprim=bt709:transfer=bt709:colormatrix=bt709' : ''}`, '-f', 'hevc', '-']);
  const encodedPath = path.join(dir, `${key}.hevc`); writeFileSync(encodedPath, bitstream);
  const starts: number[] = [];
  for (let n = 0; n + 3 < bitstream.length; n++) if (bitstream[n] === 0 && bitstream[n + 1] === 0 && bitstream[n + 2] === 1) { starts.push(n + 3); n += 2; }
  const nals = starts.map((start, i) => { let end = i + 1 < starts.length ? starts[i + 1] - 3 : bitstream.length; while (bitstream[end - 1] === 0) end--; return bitstream.subarray(start, end); });
  const type = (n: Buffer) => (n[0] >> 1) & 63;
  const config = box('hvcC', Buffer.from([1, 4, 8, 0, 0, 0, 0x98, 8, 0, 0, 0, 0, 30, 0xf0, 0, 0xfc, 0xff, 0xf8, 0xf8, 0, 0, 0x0f, 3]),
    ...[32, 33, 34].map(t => { const list = nals.filter(n => type(n) === t); return Buffer.concat([Buffer.from([0x80 | t]), u16(list.length), ...list.flatMap(n => [u16(n.length), n])]); }));
  const payload = Buffer.concat(nals.filter(n => type(n) < 32).flatMap(n => [u32(n.length), n]));
  const props = [config, full('ispe', u32(96), u32(64))], associations = [0x81, 2], filters: string[] = [];
  const rotate = () => { if (options.rotation) { props.push(box('irot', Buffer.from([options.rotation]))); associations.push(props.length); filters.push(...({ 1: ['transpose=cclock'], 2: ['hflip', 'vflip'], 3: ['transpose=clock'] }[options.rotation])); } };
  const mirror = () => { if (options.axis !== undefined) { props.push(box('imir', Buffer.from([options.axis]))); associations.push(props.length); filters.push(options.axis === 0 ? 'vflip' : 'hflip'); } };
  // HEIF transformations follow ipma association order; the ffmpeg filter chain is the independent pixel oracle.
  if (options.mirrorFirst) { mirror(); rotate(); } else { rotate(); mirror(); }
  if (options.colr) { const code = options.colr === '601' ? 6 : options.colr === '709' ? 1 : 2; props.push(box('colr', Buffer.from('nclx'), u16(code), u16(code), u16(code), Buffer.from([options.colr === '709' ? 0x80 : 0]))); associations.push(props.length); }
  const meta = (offset: number) => full('meta', full('hdlr', u32(0), Buffer.from('pict'), Buffer.alloc(13)), full('pitm', u16(1)),
    full('iloc', Buffer.from([0x44, 0]), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(payload.length)),
    full('iinf', u16(1), box('infe', Buffer.from([2, 0, 0, 0]), u16(1), u16(0), Buffer.from('hvc1\0'))),
    box('iprp', box('ipco', ...props), full('ipma', u32(1), u16(1), Buffer.from([associations.length, ...associations]))));
  const ftyp = box('ftyp', Buffer.from('heic'), u32(0), Buffer.from('mif1heic'));
  const bytes = Buffer.concat([ftyp, meta(ftyp.length + meta(0).length + 8), box('mdat', payload)]);
  const colourOverride = options.colr === '601' ? 'scale=in_range=tv:in_color_matrix=bt601:flags=neighbor' : options.colr === '709' ? 'scale=in_range=pc:in_color_matrix=bt709:flags=neighbor' : options.colr === 'unspecified' ? 'scale=in_range=tv:flags=neighbor' : '';
  const filter = [colourOverride, ...filters].filter(Boolean).join(',');
  const rgb = run(['-i', encodedPath, ...(filter ? ['-vf', filter] : []), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  return { bytes, rgb, width: options.rotation && options.rotation % 2 ? 64 : 96, height: options.rotation && options.rotation % 2 ? 96 : 64, encodedPath };
}
export function datedAvi() {
  const file = path.join(dir, 'dated.avi'); run(['-i', media('mpeg4.avi'), '-map', '0', '-c', 'copy', '-metadata', 'date=2020-01-02T03:04:05Z', file]);
  return { file, bytes: readFileSync(file) };
}
