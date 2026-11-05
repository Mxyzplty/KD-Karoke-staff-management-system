// SPDX-License-Identifier: AGPL-3.0-only
// T16a remux fast path and fallback formats in Chromium (ledger L5 browser part, L10). Oracles: "ffprobe ground truth" for the
// packets (the packet list of the source and of the export, each with an MD5 of the packet bytes) and the exported streams;
// "written-spec oracle" = findings §7 l.101 for the conditions of the fast path (each negative case breaks exactly one condition
// and must take the encode path with the stated reason) and l.100 for the formats that must export with no helper running.
// Encode-path tests run on every browser (Opus is the audio fallback, Q-F) and assert the audio codec for the branch the browser takes
// (probe-gated, never a skip); the remux itself copies AAC packets and needs no encoder.
import { test, expect, type Page } from '@playwright/test';
import { ffmpegAvailable, media } from '../media-fixtures';
import { skipTour } from './t02-support';
import { aacSupported, completed, expectOpus, ff, fixture, formatOf, genMedia, haveFile, hasStore, makeAudioClip, makeClip, mkDoc, NO_STORE, OPUS_MESSAGE, packets, rectShape, runExport, setup, streams, videoFrames } from './t16a-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the source media and reads the exported file back');
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });
const SIZE = { width: 320, height: 180 };
const oneClip = (extra: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => {
  const d = mkDoc([{ id: 'vid', from: 0, to: 2000, sourceDuration: 2000 }], { fps: 30, size: SIZE, ...extra });
  Object.assign(d.items[0], item);
  return d;
};

// ---- L5: the fast path -------------------------------------------------------------------------------------------------------------
test('L5 remux: one unedited H.264 / AAC clip is copied, packet for packet (ffprobe ground truth: packet lists with MD5 of the bytes)', async ({ page }) => {
  const src = makeAudioClip(2, SIZE.width, SIZE.height);
  const { id } = await setup(page, oneClip(), { vid: src });
  const run = await runExport(page, id);
  const r = completed(run);
  expect(r.stats.path, `remuxSkipped: ${r.stats.remuxSkipped}`).toBe('remux');
  expect(r.stats.remuxSkipped).toBeNull();
  expect(r.frames).toBe(60);
  const [sv, ov] = [packets(src, 'v:0'), packets(run.file!, 'v:0')], [sa, oa] = [packets(src, 'a:0'), packets(run.file!, 'a:0')];
  expect(ov.length).toBe(sv.length);
  expect(ov.map(p => p.data_hash)).toEqual(sv.map(p => p.data_hash));
  expect(ov.map(p => p.size)).toEqual(sv.map(p => p.size));
  expect(ov.map(p => p.pts_time)).toEqual(sv.map(p => p.pts_time));
  expect(ov.map(p => p.flags.includes('K'))).toEqual(sv.map(p => p.flags.includes('K')));
  expect(oa.length).toBe(sa.length);
  expect(oa.map(p => p.data_hash)).toEqual(sa.map(p => p.data_hash));
  expect(oa.map(p => p.size)).toEqual(sa.map(p => p.size));
  const all = streams(run.file!);
  expect(all.map(s => s.codec_type).sort()).toEqual(['audio', 'video']);
  expect(Number(formatOf(run.file!).duration)).toBeCloseTo(Number(formatOf(src).duration), 1);
});

// One condition broken per case. `reason` is the text stats.remuxSkipped must carry.
const NEGATIVES: { name: string; reason: RegExp; doc?: () => ReturnType<typeof oneClip>; opts?: Record<string, unknown>; file?: () => string; files?: () => Record<string, string>; frames: number }[] = [
  { name: 'a frame range is set', reason: /frame range is set/, opts: { range: { startS: 0, endS: 1 } }, frames: 30 },
  { name: 'the output size is not the canvas size (480p)', reason: /output size is not the canvas size/, opts: { resolution: '480p' }, frames: 60 },
  { name: 'the timeline fps differs from the clip fps (25 vs 30)', reason: /frame rate is not the timeline frame rate/, doc: () => oneClip({ fps: 25 }), frames: 50 },
  { name: 'the clip is edited (volume 0.5)', reason: /clip is edited/, doc: () => oneClip({}, { properties: { volume: { defaultValue: 0.5, keyframes: [] } } }), frames: 60 },
  { name: 'the clip is trimmed (trim.from 500 ms)', reason: /trimmed or moved/, doc: () => { const d = mkDoc([{ id: 'vid', from: 0, to: 1500, trim: 500, sourceDuration: 2000 }], { fps: 30, size: SIZE }); return d; }, frames: 45 },
  { name: 'the audio is shorter than the video by more than one frame', reason: /do not start together or differ in length/, file: () => genMedia('t16a-short-audio.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), frames: 60 },
  { name: 'the audio starts later than the video (0.5 s offset)', reason: /do not start together or differ in length/, file: () => genMedia('t16a-late-audio.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), frames: 60 },
  // Review-1 R2: the four remaining l.101 conditions, each broken alone. The reason text is the one remuxCandidate returns for that
  // condition only (anchored), so a row that stopped at an earlier condition, or got past this one, fails on the text.
  { name: 'the codecs are not H.264 / AAC (H.264 + Opus in MP4, canvas size and fps)', reason: /^the clip is not H\.264 \/ AAC$/, file: () => genMedia('t16a-h264-opus.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '96k']), frames: 60 },
  { name: 'a second item is exported (a still on v2 for the last 500 ms)', reason: /^the timeline is not one clip$/, doc: () => mkDoc([{ id: 'vid', from: 0, to: 2000, sourceDuration: 2000 }, { id: 'img', type: 'image', track: 'v2', from: 1500, to: 2000 }], { fps: 30, size: SIZE }), files: () => ({ vid: makeAudioClip(2, SIZE.width, SIZE.height), img: media('pattern.png') }), frames: 60 },
  // Freeze 6 (S3, T06): remux.ts exportedItems counts every item on an exported track whatever its type, so a shape on an overlay track
  // is a second exported item.
  { name: 'a T06 shape is on an overlay track (the shape counts as an exported item)', reason: /^the timeline is not one clip$/, doc: () => { const d = oneClip(); d.tracks.push({ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 } as never); d.layerOrder.push({ type: 'track', id: 'o1' }); d.items.push(rectShape('shp', 'o1', { from: 0, to: 2000 }) as never); return d; }, frames: 60 },
  { name: 'the clip is transformed (opacity 0.5)', reason: /^the clip is transformed or styled$/, doc: () => oneClip({}, { properties: { opacity: { defaultValue: 0.5, keyframes: [] } } }), frames: 60 },
  { name: 'the clip is transformed (positionX 10)', reason: /^the clip is transformed or styled$/, doc: () => oneClip({}, { properties: { positionX: { defaultValue: 10, keyframes: [] } } }), frames: 60 },
  { name: 'the clip has no audio stream (video only)', reason: /^the clip is not a video with audio$/, file: () => makeClip(2, SIZE.width, SIZE.height), frames: 60 },
];
for (const n of NEGATIVES) {
  test(`L5 remux negative, ${n.name}: the encode path is taken and says why (written-spec oracle: findings §7 l.101)`, async ({ page }) => {
    const { id } = await setup(page, n.doc ? n.doc() : oneClip(), n.files ? n.files() : { vid: n.file ? n.file() : makeAudioClip(2, SIZE.width, SIZE.height) });
    const run = await runExport(page, id, n.opts ?? {});
    const r = completed(run);
    expect(r.stats.path).toBe('encode');
    expect(r.stats.remuxSkipped).toMatch(n.reason);
    expect(r.frames).toBe(n.frames);
    expect(streams(run.file!).find(s => s.codec_type === 'video').codec_name).toBe('h264');
  });
}

test('L5 remux, a lone clip placed at 500 ms: the leading gap is not exported (plan.shiftMs), so the clip is still copied packet for packet', async ({ page }) => {
  const src = makeAudioClip(2, SIZE.width, SIZE.height);
  const { id } = await setup(page, mkDoc([{ id: 'vid', from: 500, to: 2500, sourceDuration: 2000 }], { fps: 30, size: SIZE }), { vid: src });
  const run = await runExport(page, id);
  const r = completed(run);
  test.info().annotations.push({ type: 'frames', description: String(r.frames) });
  expect(r.stats.path, `remuxSkipped: ${r.stats.remuxSkipped}`).toBe('remux');
  expect(r.frames).toBe(60);
  expect(packets(run.file!, 'v:0').map(p => p.data_hash)).toEqual(packets(src, 'v:0').map(p => p.data_hash));
});

test('L5 remux off: options.remux = false takes the encode path with no reason recorded', async ({ page }) => {
  const { id } = await setup(page, oneClip(), { vid: makeAudioClip(2, SIZE.width, SIZE.height) });
  const r = completed(await runExport(page, id, { remux: false }, undefined, false));
  expect(r.stats.path).toBe('encode');
  expect(r.stats.remuxSkipped).toBeNull();
});

// Review-1 N5: a failure after the remux's sink and output are set up (exportFaults.failSetup, before the output starts) releases both the
// sink's writable (aborted, never closed) and the remux Input (remuxInputs.open back to 0).
test('N5 remux: a failure in the setup (exportFaults.failSetup) fails the export, aborts the handle writable and disposes the remux Input', async ({ page }) => {
  const { id } = await setup(page, oneClip(), { vid: makeAudioClip(2, SIZE.width, SIZE.height) });
  const hook = `
    const d = '/src/export/decoders.ts'; (await import(d)).exportFaults.failSetup = true;
    const rx = '/src/export/remux.ts', { remuxInputs } = await import(rx); let v = remuxInputs.open; window.__peak = 0;
    Object.defineProperty(remuxInputs, 'open', { get: () => v, set: x => { v = x; window.__peak = Math.max(window.__peak, x); }, configurable: true });
    window.__sink = { writes: 0, closed: 0, aborted: 0 };
    const handle = { name: 'setup.mp4', getFile: async () => new File([], 'setup.mp4'), createWritable: async () => new WritableStream({ write() { window.__sink.writes++; }, close() { window.__sink.closed++; }, abort() { window.__sink.aborted++; } }) };
    return { handle };`;
  const run = await runExport(page, id, {}, hook, false);
  expect(run.status, 'the export should have failed').toBe('failed');
  expect(run.error).toMatchObject({ code: 'CLIENT_BUG' });
  expect(run.error!.detail).toMatch(/exportFaults\.failSetup/);
  const out = await page.evaluate(async () => {
    const r = '/src/export/remux.ts', { remuxInputs } = await import(r);
    return { open: remuxInputs.open as number, peak: (window as unknown as { __peak: number }).__peak, sink: (window as unknown as { __sink: unknown }).__sink };
  });
  // The remux path was the one that failed (peak 1: its Input was opened, the fault comes after remuxTracks) and the Input is disposed again.
  expect(out).toEqual({ open: 0, peak: 1, sink: { writes: 0, closed: 0, aborted: 1 } });
});

// ---- L10: fallback formats, no helper ----------------------------------------------------------------------------------------------
// One test per format. The S5 file from the fixture store is used when the store has it (Windows gate); otherwise the
// media-fixtures stand-in (ffmpeg-made, Ubuntu gate). S5b (HDR10 PQ) has no stand-in and skips without the store.
const probeMs = (file: string) => Math.round(Number(formatOf(file).duration) * 1000);
const FORMATS: { name: string; s5: string; stand?: string }[] = [
  { name: 'HEVC 10-bit SDR', s5: 'S5i-hevc10-sdr.mp4', stand: 'hevc10-sdr.mp4' },
  { name: 'HEVC 10-bit HDR10 (PQ)', s5: 'S5b-hdr10-pq-hevc10.mp4' },
  { name: 'ProRes 422', s5: 'S5h-prores422.mov', stand: 'prores.mov' },
  { name: 'VFR H.264', s5: 'S5a-vfr.mp4', stand: 'vfr.mp4' },
  { name: 'Matroska container', s5: 'S5g-container.mkv', stand: 'h264-opus.mkv' },
  { name: 'AC-3 audio', s5: 'S5e-ac3-audio.mp4', stand: 'ac3.mp4' },
];
for (const f of FORMATS) {
  test(`L10 formats, ${f.name} (${f.s5}): exports to a valid H.264 MP4 with no helper running; audio is AAC-LC, or Opus + OPUS_MESSAGE where this browser has no AAC-LC (written-spec oracle: findings §7 l.100, Q-F; ffprobe ground truth for the result)`, async ({ page }) => {
    const s5 = hasStore ? fixture('synthetic', f.s5) : '';
    const file = s5 && haveFile(s5) ? s5 : f.stand ? media(f.stand) : '';
    test.skip(!file, hasStore ? `${f.s5} is not in the fixture store` : NO_STORE);
    const ms = Math.min(1000, probeMs(file)), hasAudio = streams(file).some(s => s.codec_type === 'audio');
    test.info().annotations.push({ type: 'source', description: file });
    test.setTimeout(600_000); // T14 sends HDR sources down its WASM path: ingest of the S5b clip takes about 113 s here, so the ingest wait is 480 s (a harness wait, not a bound)
    const { id } = await setup(page, mkDoc([{ id: 'vid', from: 0, to: ms, sourceDuration: probeMs(file) }], { fps: 30, size: SIZE }), { vid: file }, 'T16a fixture', 480_000);
    const run = await runExport(page, id);
    const r = completed(run);
    expect(r.stats.path).toBe('encode');
    const v = streams(run.file!).find(s => s.codec_type === 'video'), expected = Math.ceil(ms / 1000 * 30);
    expect(v).toMatchObject({ codec_name: 'h264', width: SIZE.width, height: SIZE.height });
    expect(Number(v.nb_frames)).toBe(expected); expect(r.frames).toBe(expected);
    expect(videoFrames(run.file!)).toHaveLength(expected);
    if (hasAudio) {
      if (await aacSupported(page)) { expect(r.audioCodec).toBe('aac'); expect(r.messages).not.toContain(OPUS_MESSAGE); expect(streams(run.file!).some(s => s.codec_type === 'audio' && s.codec_name === 'aac')).toBe(true); }
      else expectOpus(run, 30);
    }
    // The picture is not black: a decoded frame from the middle of the export has some spread of luma.
    const mid = ff('ffmpeg', ['-v', 'error', '-i', run.file!, '-vf', `select=eq(n\\,${Math.floor(expected / 2)})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], 'buffer') as Buffer;
    expect(Math.max(...mid) - Math.min(...mid)).toBeGreaterThan(20);
  });
}
