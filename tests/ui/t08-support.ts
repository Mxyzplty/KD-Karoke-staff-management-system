// SPDX-License-Identifier: AGPL-3.0-only
// Shared T08 UI test media: a counter video whose 8 luma blocks encode the source frame number in binary.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function counterVideo(): string {
  const dir = path.join(tmpdir(), 'cutframe-t08-counter'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'counter-64x64-120f-v1.mp4');
  if (existsSync(out)) return out;
  // Bit k (from the left) of the frame number N is block k; all-intra so every seek is exact.
  const geq = "geq=lum='if(gte(mod(floor(N/pow(2,floor(X*8/W))),2),1),230,25)':cb=128:cr=128";
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=30:d=4,format=yuv420p,' + geq,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-an', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return out;
}

// CI fix 2 round 2: counter clips whose element frame spans do not tell which frame a time shows.
const counter = (n: string) => `color=c=gray:s=64x64:r=30:d=4,format=yuv420p,geq=lum='if(gte(mod(floor((${n})/pow(2,floor(X*8/W))),2),1),230,25)':cb=128:cr=128`;
function clip(name: string, args: string[]): string {
  const dir = path.join(tmpdir(), 'cutframe-t08-counter'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  if (existsSync(out)) return out;
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args, out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return out;
}
/** The counter video with its first frame at 0.5 s (review CF-B1). */
export const offsetCounterVideo = () => clip('counter-offset-0.5s-v1.mp4', ['-f', 'lavfi', '-i', counter('N'),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-an', '-output_ts_offset', '0.5']);
/** One video frame (counter value 5) in a 3 s file with an audio track (review CF-M1). */
export const oneFrameVideo = () => clip('one-frame-3s-audio-v1.mp4', ['-f', 'lavfi', '-i', counter('N+5').replace('d=4', 'd=0.03'), '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
/** The counter at 30000/1001 fps with B-frames (review CF2-B1): frame 30 starts at 1.001 s, the same double as 1 s plus the
 *  1 ms nudge, and Chromium shows frame 29 for a seek to that time. All-intra, the same clip shows frame 30 there. */
export const ntscCounterVideo = () => clip('counter-29.97-bf2-v1.mp4', ['-f', 'lavfi', '-i', counter('N').replace('r=30', 'r=30000/1001'),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '8', '-bf', '2', '-pix_fmt', 'yuv420p', '-an']);
/** VP9 WebM with frames only at 0, 1, 2 and 3 s (counter values 0, 30, 60, 90); Chromium reports each as 1/30 s long. */
export const sparseWebm = () => clip('counter-sparse-1s-v1.webm', ['-f', 'lavfi', '-i', counter('N'), '-vf', "select='not(mod(n,30))'", '-fps_mode', 'passthrough',
  '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '20', '-an']);
/** The counter over 8 s (240 frames), for cut points past source frame 120 (decision Q7 at playbackRate 2). All-intra. */
export const longCounterVideo = () => clip('counter-64x64-240f-v1.mp4', ['-f', 'lavfi', '-i', counter('N').replace('d=4', 'd=8'),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-an']);

/** A 1080p long-GOP clip (one keyframe per 120 frames, B-frames on): seeking near its end is slow. */
export function longGopVideo(): string {
  const dir = path.join(tmpdir(), 'cutframe-t08-counter'); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'longgop-1080p-120f-v1.mp4');
  if (existsSync(out)) return out;
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '120', '-bf', '2', '-pix_fmt', 'yuv420p', '-an', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return out;
}
