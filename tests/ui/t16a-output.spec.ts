// SPDX-License-Identifier: AGPL-3.0-only
// T16a output format (ledger L3, findings §44.8). Oracle: "ffprobe ground truth" on files exported in Chromium through
// startExport / getExportStatus (L12): H.264 High, yuv420p, limited range, BT.709 on all three tags, CFR = timeline fps, no B-frames,
// a key frame every 5 s, frames = ceil(duration x fps), AAC-LC 48 kHz stereo about 192 kb/s, 0 <= audio - video < 21.4 ms (EX-P05),
// an audio stream even for a silent video timeline. Where this Chromium cannot encode AAC-LC (open item O2) the audio is Opus 48 kHz
// stereo with OPUS_MESSAGE (Q-F) and the same tests assert that branch (probe-gated, never a skip): codec, 48 kHz, 2 channels,
// |audio start - video start| <= 1 frame, 0 <= audio - video duration <= 1 frame. The video facts are also asserted on an image-only
// timeline, which has no audio stream.
import { test, expect } from '@playwright/test';
import { ffmpegAvailable, media } from '../media-fixtures';
import { skipTour } from './t02-support';
import { aacSupported, completed, decodePcm, expectOpus, formatOf, makeAudioClip, makeClip, mkDoc, OPUS_MESSAGE, rms, runExport, setup, streams, videoFrames } from './t16a-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the source media and reads the exported file back');
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const fr = (s: string) => { const [n, d] = s.split('/').map(Number); return n / d; };

test('ffprobe ground truth, video facts on an image timeline (11.010 s at 10 fps): High, yuv420p, tv range, BT.709 x3, CFR, no B-frames, key frames at 0 / 5 / 10 s, 111 frames', async ({ page }) => {
  const doc = mkDoc([{ id: 'img', type: 'image', from: 0, to: 11010 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { img: media('pattern.png') });
  const run = await runExport(page, id);
  const r = completed(run);
  expect(r.stats.path).toBe('encode');
  expect(r.frames).toBe(111);
  const all = streams(run.file!), v = all.find(s => s.codec_type === 'video');
  expect(all.map(s => s.codec_type)).toEqual(['video']);
  expect(v).toMatchObject({ codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', color_range: 'tv', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', width: 160, height: 90, has_b_frames: 0 });
  expect(v.r_frame_rate).toBe('10/1'); expect(v.avg_frame_rate).toBe('10/1');
  expect(Number(v.nb_frames)).toBe(Math.ceil(11.01 * 10));
  const frames = videoFrames(run.file!);
  expect(frames).toHaveLength(111);
  expect(frames.some(f => f.pict_type === 'B')).toBe(false);
  expect(frames.filter(f => f.key_frame === 1).map(f => f.pts_time)).toEqual([0, 5, 10]);
  frames.forEach((f, i) => expect(f.pts_time).toBeCloseTo(i / 10, 6));
  expect(Number(formatOf(run.file!).duration)).toBeCloseTo(11.1, 1);
});

test('ffprobe ground truth, a non-integer duration gives ceil(duration x fps) frames at 30 fps too (1010 ms -> 31, 10 010 ms rule is in the units)', async ({ page }) => {
  const doc = mkDoc([{ id: 'img', type: 'image', from: 0, to: 1010 }], { fps: 30, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { img: media('pattern.png') });
  const run = await runExport(page, id);
  completed(run);
  const v = streams(run.file!).find(s => s.codec_type === 'video');
  expect(Number(v.nb_frames)).toBe(Math.ceil(1.01 * 30));
  expect(v.r_frame_rate).toBe('30/1'); expect(v.avg_frame_rate).toBe('30/1');
});

test('ffprobe ground truth, video + audio timeline: 11 frames, AAC-LC 48 kHz stereo about 192 kb/s with 0 <= audio - video < 21.4 ms, or (no AAC-LC in this browser) Opus 48 kHz stereo with OPUS_MESSAGE within 1 frame', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1010, sourceDuration: 3000 }], { fps: 10, size: { width: 320, height: 180 } });
  const { id } = await setup(page, doc, { vid: makeAudioClip(3) });
  const run = await runExport(page, id);
  const r = completed(run);
  const all = streams(run.file!), v = all.find(s => s.codec_type === 'video'), a = all.find(s => s.codec_type === 'audio');
  expect(all.map(s => s.codec_type).sort()).toEqual(['audio', 'video']);
  expect(Number(v.nb_frames)).toBe(11); expect(r.frames).toBe(11);
  expect(fr(v.r_frame_rate)).toBe(10); expect(fr(v.avg_frame_rate)).toBe(10);
  if (!(await aacSupported(page))) { expectOpus(run, 10); return; }
  expect(r.audioCodec).toBe('aac'); expect(r.messages).not.toContain(OPUS_MESSAGE);
  expect(a).toMatchObject({ codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2 });
  expect(Number(a.bit_rate)).toBeGreaterThan(150_000); expect(Number(a.bit_rate)).toBeLessThan(230_000);
  const gap = Number(a.duration) - Number(v.duration);
  test.info().annotations.push({ type: 'audio-minus-video-ms', description: String(gap * 1000) });
  expect(gap).toBeGreaterThanOrEqual(-1e-6); expect(gap).toBeLessThan(0.0214);
});

test('ffprobe ground truth, a video/audio timeline of a silent clip still has an audio stream (AAC-LC, or Opus where this browser has no AAC-LC)', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 320, height: 180 } });
  const { id } = await setup(page, doc, { vid: makeClip(1) });
  const run = await runExport(page, id);
  const r = completed(run);
  if (await aacSupported(page)) {
    expect(r.audioCodec).toBe('aac'); expect(r.messages).not.toContain(OPUS_MESSAGE);
    const a = streams(run.file!).find(s => s.codec_type === 'audio');
    expect(a).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
    expect(Number(a.duration)).toBeGreaterThan(0.9);
  } else expect(Number(expectOpus(run, 10).duration)).toBeGreaterThan(0.9);
});

test('exportFaults.noAac (forced fallback): Opus 48 kHz stereo with OPUS_MESSAGE within 1 frame, audible; a silent clip still has an Opus stream; the default run is AAC-LC with no message (Opus where this browser has no AAC-LC)', async ({ page }) => {
  await page.goto('/');
  const aac = await aacSupported(page), FORCE = "const d = '/src/export/decoders.ts'; (await import(d)).exportFaults.noAac = true; return {};";
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1010, sourceDuration: 3000 }], { fps: 10, size: { width: 320, height: 180 } });
  const { id } = await setup(page, doc, { vid: makeAudioClip(3) });
  // Default run first (the fault flag stays set in the page once it is raised).
  const base = completed(await runExport(page, id, {}, undefined, false));
  expect(base.audioCodec).toBe(aac ? 'aac' : 'opus');
  if (aac) expect(base.messages).not.toContain(OPUS_MESSAGE);
  const run = await runExport(page, id, {}, FORCE);
  completed(run);
  const a = expectOpus(run, 10);
  expect(Number(a.bit_rate)).toBeGreaterThan(0);
  // Not silent: the decoded export has sound inside the clip (window 0.2 s to 0.8 s) at about the level of the source's tone.
  const out = decodePcm(run.file!), src = decodePcm(makeAudioClip(3)), win = [9600, 38400] as const;
  const level = rms(out.left, ...win), srcLevel = rms(src.left, ...win);
  test.info().annotations.push({ type: 'rms-opus-vs-source', description: JSON.stringify({ opus: level, source: srcLevel }) });
  expect(srcLevel).toBeGreaterThan(0.01);
  expect(level).toBeGreaterThan(srcLevel * 0.5);
  // A silent video clip still gets an Opus stream.
  const sdoc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 320, height: 180 } });
  const silent = await setup(page, sdoc, { vid: makeClip(1) }, 'T16a silent');
  const srun = await runExport(page, silent.id, {}, FORCE);
  completed(srun);
  expect(Number(expectOpus(srun, 10).duration)).toBeGreaterThan(0.9);
});
