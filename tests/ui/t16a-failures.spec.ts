// SPDX-License-Identifier: AGPL-3.0-only
// T16a export failures with a real trigger in Chromium (ledger L8; the classifier-only classes are in tests/t16a-errors.test.ts;
// USER_CANCELLED and SUPERSEDED are in t16a-budgets.spec.ts; MG_RENDER_FAILED is in t16a-render.spec.ts). Oracle: "written-spec oracle" = error
// codes §12 / findings §7 l.110: each failure ends the export as status 'failed' with its class code, category and kind, and the
// specific text in `detail`. Every export goes through startExport / getExportStatus (L12). No test skips on the audio encoder (Opus is the
// fallback, Q-F). Failures that are stubbed (store, encoder, sink) say so in the title.
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegAvailable, media } from '../media-fixtures';
import { skipTour } from './t02-support';
import { imageDoc, makeClip, mkDoc, runExport, setup, type Run } from './t16a-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the source media');
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });
const failed = (run: Run, code: string, detail?: RegExp) => {
  expect(run.status, 'the export should have failed').toBe('failed');
  expect(run.error, JSON.stringify(run.error)).toMatchObject({ code });
  expect(run.error!.message.length).toBeGreaterThan(10);
  if (detail) expect(run.error!.detail ?? '').toMatch(detail);
  return run.error!;
};
const imageProject = (page: Page, ms = 2000, fps = 30) => setup(page, imageDoc(ms, fps), { img: media('pattern.png') });
const garbage = (name: string, bytes: Buffer) => { const dir = path.join(tmpdir(), 'cutframe-t16a-media'); mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); writeFileSync(f, bytes); return f; };

// ---- Preconditions -----------------------------------------------------------------------------------------------------------------
test('UNRESOLVED_MEDIA: an item with no asset id, and an item whose asset id is not in the library', async ({ page }) => {
  const { id } = await imageProject(page);
  const noId = await runExport(page, id, {}, 'return { doc: { ...ctx.doc, items: ctx.doc.items.map(i => ({ ...i, metadata: {} })) } };', false);
  failed(noId, 'UNRESOLVED_MEDIA', /Reconnect or re-add the media/);
  const unknown = await runExport(page, id, {}, "return { doc: { ...ctx.doc, items: ctx.doc.items.map(i => ({ ...i, metadata: { assetId: 'not-in-the-library' } })) } };", false);
  failed(unknown, 'UNRESOLVED_MEDIA');
});
test('LOCAL_STORAGE_UNAVAILABLE: store.media.read fails with anything but a missing file (read stubbed to throw a plain Error)', async ({ page }) => {
  const { id } = await imageProject(page);
  const hook = "const media = Object.assign(Object.create(ctx.store.media), { read: async () => { throw new Error('disk exploded'); } }); return { store: Object.create(ctx.store, { media: { value: media } }) };";
  failed(await runExport(page, id, {}, hook, false), 'LOCAL_STORAGE_UNAVAILABLE', /could not read/);
});
test('MISSING_LOCAL_FILES: the OPFS file of a used asset is gone (removed through store.media.remove before the export)', async ({ page }) => {
  const { id, assets } = await imageProject(page);
  const hook = `await ctx.store.media.remove('asset', '${assets.img}'); return {};`;
  failed(await runExport(page, id, {}, hook, false), 'MISSING_LOCAL_FILES', /MISSING_LOCAL_FILES/);
});
test('ASSETS_STILL_UPLOADING: an asset whose processing_status is "uploading" (set through store.updateAsset)', async ({ page }) => {
  const { id, assets } = await imageProject(page);
  const hook = `await ctx.store.updateAsset('${assets.img}', a => ({ ...a, processing_status: 'uploading' })); return {};`;
  failed(await runExport(page, id, {}, hook, false), 'ASSETS_STILL_UPLOADING', /SYNCING_ASSETS/);
});
test('INVALID_MEDIA_TIMING: a video item whose trim is inverted (trim.from 500 ms, trim.to 100 ms) aborts before any work', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: makeClip(1, 160, 90) });
  const hook = "return { doc: { ...ctx.doc, items: ctx.doc.items.map(i => ({ ...i, trim: { from: 500, to: 100 } })) } };";
  const run = await runExport(page, id, {}, hook, false);
  failed(run, 'INVALID_MEDIA_TIMING', /trim\.to before trim\.from/);
  expect(run.samples).toEqual([]); // no frame was rendered
});
test('CLIENT_BUG: a range outside the composition, and an empty composition', async ({ page }) => {
  const { id } = await imageProject(page, 2000, 10);
  failed(await runExport(page, id, { range: { startS: 0, endS: 99 } }, undefined, false), 'CLIENT_BUG', /not inside the composition/);
  failed(await runExport(page, id, { range: { startS: 1, endS: 1 } }, undefined, false), 'CLIENT_BUG');
  const empty = await runExport(page, id, {}, 'return { doc: { ...ctx.doc, items: [], duration: 0 } };', false);
  failed(empty, 'CLIENT_BUG');
});

// ---- Encoder, audio, decoders ------------------------------------------------------------------------------------------------------
test('ENCODE_ERROR: no H.264 profile is supported (VideoEncoder.isConfigSupported stubbed to say no)', async ({ page }) => {
  const { id } = await imageProject(page);
  const run = await runExport(page, id, {}, 'VideoEncoder.isConfigSupported = async () => ({ supported: false }); return {};', false);
  failed(run, 'ENCODE_ERROR', /cannot be encoded/);
});
test('ENCODE_ERROR: the VideoEncoder reports an error part-way (page-level VideoEncoder stand-in whose third frame calls the error callback)', async ({ page }) => {
  const { id } = await imageProject(page, 3000, 30);
  const hook = `
    const Real = window.VideoEncoder;
    window.VideoEncoder = class extends Real {
      constructor(init) { super(init); this.n = 0; this.fail = init.error; }
      encode(f, o) { if (++this.n === 3) { this.fail(new DOMException('boom', 'EncodingError')); return; } super.encode(f, o); }
    };
    return {};`;
  const run = await runExport(page, id, {}, hook, false);
  failed(run, 'ENCODE_ERROR', /VideoEncoder error: boom/);
});
test('AUDIO_FAILED: the audio stage throws (audio option stubbed to throw "boom")', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: makeClip(1, 160, 90) });
  const run = await runExport(page, id, {}, "return { audio: async () => { throw new Error('boom'); } };", false);
  failed(run, 'AUDIO_FAILED', /Audio mix failed: boom/);
});
test('AUDIO_FAILED: neither AAC-LC nor Opus encodes (AudioEncoder.isConfigSupported stubbed to supported:false for every config)', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: makeClip(1, 160, 90) });
  await page.evaluate(() => { AudioEncoder.isConfigSupported = async (config: AudioEncoderConfig) => ({ supported: false, config }); });
  const run = await runExport(page, id, {}, undefined, false);
  test.info().annotations.push({ type: 'outcome', description: JSON.stringify({ status: run.status, code: run.error?.code, message: run.error?.message, detail: run.error?.detail }) });
  failed(run, 'AUDIO_FAILED');
  expect(`${run.error!.message} ${run.error!.detail ?? ''}`).toMatch(/neither AAC-LC nor Opus/);
});
test('AUDIO_FAILED: a corrupt audio file (random bytes named .wav) fails the plain mix', async ({ page }) => {
  const bad = garbage('t16a-corrupt.wav', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 255)));
  const doc = mkDoc([{ id: 'aud', type: 'audio', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { aud: bad });
  const run = await runExport(page, id, {}, undefined, false);
  test.info().annotations.push({ type: 'outcome', description: JSON.stringify({ status: run.status, code: run.error?.code, detail: run.error?.detail }) });
  failed(run, 'AUDIO_FAILED');
});
test('TIMEOUT: the decoder does not answer twice (exportFaults.timeouts = 2): one restart, then TIMEOUT', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: makeClip(1, 160, 90) });
  const hook = "const d = '/src/export/decoders.ts'; (await import(d)).exportFaults.timeouts = 2; return {};";
  failed(await runExport(page, id, {}, hook, false), 'TIMEOUT', /timed out/);
});
test('TIMEOUT recovers: one lost decoder answer (exportFaults.timeouts = 1) is restarted once and the export completes', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: makeClip(1, 160, 90) });
  const hook = "const d = '/src/export/decoders.ts'; (await import(d)).exportFaults.timeouts = 1; return {};";
  const run = await runExport(page, id, {}, hook, false);
  expect(run.status, `${run.error?.code}: ${run.error?.detail}`).toBe('completed');
  expect(run.result!.stats.decoders.timeouts).toBe(1);
});
// A broken video file is first met by the audio stage (it runs about 1 s ahead of the first frame). The audio stage (export/audio.ts)
// reports a video item's demux error as UNSUPPORTED_INPUT, and audioFailure (pipeline.ts) keeps that code; the tests below stub the audio stage with silence so the video path is the one
// that meets the file, and the last of the group runs the real audio stage.
const SILENCE = 'return { audio: async (d, r) => ({ sampleRate: 48000, channels: 2, data: [new Float32Array(r.frames), new Float32Array(r.frames)] }) };';
const notAVideo = () => garbage('t16a-not-a-video.mp4', Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 37 + 11) & 255)));
/** A real MP4 whose index (moov) is intact but whose sample data (mdat) is overwritten with noise after its first 32 bytes. */
const brokenData = () => {
  const b = Buffer.from(readFileSync(makeClip(2, 160, 90))), at = b.indexOf('mdat', 0, 'latin1') - 4, end = at + b.readUInt32BE(at);
  for (let i = at + 8 + 32; i < end; i++) b[i] = (i * 2654435761) >>> 24;
  return garbage('t16a-broken-data.mp4', b);
};
test('UNSUPPORTED_INPUT: a "video" whose bytes no demuxer reads (audio stage stubbed with silence)', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: notAVideo() });
  const run = await runExport(page, id, {}, SILENCE, false);
  test.info().annotations.push({ type: 'outcome', description: JSON.stringify({ status: run.status, code: run.error?.code, detail: run.error?.detail }) });
  failed(run, 'UNSUPPORTED_INPUT');
});
test('UNSUPPORTED_INPUT: an MP4 cut off before its index (moov) cannot be opened (audio stage stubbed with silence)', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 2000, sourceDuration: 2000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: garbage('t16a-truncated.mp4', readFileSync(makeClip(2, 160, 90)).subarray(0, 14_000)) });
  failed(await runExport(page, id, {}, SILENCE, false), 'UNSUPPORTED_INPUT');
});
test('DECODE_ERROR: an MP4 with a good index but noise for sample data fails in WebCodecs and again in WASM (audio stage stubbed with silence)', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 2000, sourceDuration: 2000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: brokenData() });
  const run = await runExport(page, id, {}, SILENCE, false);
  test.info().annotations.push({ type: 'outcome', description: JSON.stringify({ status: run.status, code: run.error?.code, detail: run.error?.detail }) });
  failed(run, 'DECODE_ERROR');
});
test('UNSUPPORTED_INPUT with the real audio stage: bytes no demuxer reads report the video class, not AUDIO_FAILED (the audio stage meets the file first)', async ({ page }) => {
  const doc = mkDoc([{ id: 'vid', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { vid: notAVideo() });
  const run = await runExport(page, id, {}, undefined, false);
  test.info().annotations.push({ type: 'outcome', description: JSON.stringify({ status: run.status, code: run.error?.code, message: run.error?.message, detail: run.error?.detail }) });
  failed(run, 'UNSUPPORTED_INPUT', /could not be opened/);
});
test('WORKSPACE_FILE_MISSING: the file of a later clip is deleted while the export runs', async ({ page }) => {
  const doc = mkDoc([{ id: 'a', from: 0, to: 3000, sourceDuration: 3000 }, { id: 'b', track: 'v2', from: 3000, to: 4000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id, assets } = await setup(page, doc, { a: makeClip(3, 160, 90), b: makeClip(1, 160, 90) });
  const hook = `
    window.__t16prog = undefined;
    (async () => { while (!window.__t16prog) await new Promise(r => setTimeout(r, 5)); await ctx.store.media.remove('asset', '${assets.b}'); })();
    return {};`;
  failed(await runExport(page, id, {}, hook, false), 'WORKSPACE_FILE_MISSING');
});

// ---- Output sinks --------------------------------------------------------------------------------------------------------------------
const handleHook = (error: string) => `
  const handle = { name: 'broken.mp4', getFile: async () => new File([], 'broken.mp4'), createWritable: async () => new WritableStream({ write() { throw ${error}; } }) };
  return { handle };`;
test('STORAGE_QUOTA: a file handle whose write fails with a QuotaExceededError (handle stubbed)', async ({ page }) => {
  const { id } = await imageProject(page);
  failed(await runExport(page, id, {}, handleHook("new DOMException('The quota has been exceeded.', 'QuotaExceededError')"), false), 'STORAGE_QUOTA');
});
test('OUTPUT_STREAM_FAILED: a file handle whose write fails with any other error (handle stubbed)', async ({ page }) => {
  const { id } = await imageProject(page);
  failed(await runExport(page, id, {}, handleHook("new Error('disk exploded')"), false), 'OUTPUT_STREAM_FAILED', /errored writable stream/);
});
test('STORAGE_QUOTA: the OPFS export file refuses a write with QuotaExceededError (createWritable of export-*.mp4 returns a stream that throws on write, close and abort go to the real one)', async ({ page }) => {
  const { id } = await imageProject(page);
  const hook = `
    const orig = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (o) {
      const w = await orig.call(this, o);
      if (!this.name.startsWith('export-')) return w;
      // An errored stand-in never forwards abort() to the real stream, which would stay open and lock the file: release it here.
      return new WritableStream({ write() { w.abort().catch(() => undefined); throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); }, close: () => w.close(), abort: r => w.abort(r) });
    };
    return {};`;
  failed(await runExport(page, id, {}, hook, false), 'STORAGE_QUOTA');
  // The partial export file (and Chromium's swap file) is still there right after the failure; the next export's cleanup (files older
  // than 2 min, so called with a clock 3 min ahead) removes both.
  const { left, removed, after, errors } = await page.evaluate(async () => {
    const s = '/src/export/sinks.ts', { cleanStaleExports } = await import(s);
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe', { create: true })).getDirectoryHandle('exports', { create: true });
    const list = async () => { const n: string[] = []; for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) n.push(name); return n; };
    const left = await list(), removed = await cleanStaleExports(Date.now() + 180_000), after = await list(), errors: Record<string, string> = {};
    // cleanStaleExports swallows a refused removal; ask the browser directly why a file is still there.
    for (const n of after) await dir.removeEntry(n).then(() => { errors[n] = 'removed by the probe'; }, (e: Error) => { errors[n] = `${e.name}: ${e.message}`; });
    return { left, removed, after, errors };
  });
  test.info().annotations.push({ type: 'export-files-left-after-failure', description: JSON.stringify({ left, removed, after, errors }) });
  expect(left.some(n => /^export-.*\.mp4$/.test(n)), `a partial export file is left right after the failure: ${JSON.stringify(left)}`).toBe(true);
  expect(after.filter(n => /^export-.*\.mp4(\.crswap)?$/.test(n)), `export files left after cleanStaleExports (removed: ${JSON.stringify(removed)}; removeEntry errors: ${JSON.stringify(errors)})`).toEqual([]);
});

// ---- Clean-up when the setup fails (review-1 N5) ---------------------------------------------------------------------------------------
// exportFaults.failSetup fails the export once the sink and the output exist, before the output starts. The sink's writable must be
// released: a stub handle records abort / close, and the OPFS file must not stay locked by a writer nobody closed.
const SETUP_FAULT = "const d = '/src/export/decoders.ts'; (await import(d)).exportFaults.failSetup = true;";
const SINK_LOG = `
  window.__sink = { writes: 0, closed: 0, aborted: 0 };
  const handle = { name: 'setup.mp4', getFile: async () => new File([], 'setup.mp4'), createWritable: async () => new WritableStream({ write() { window.__sink.writes++; }, close() { window.__sink.closed++; }, abort() { window.__sink.aborted++; } }) };`;
test('N5 encode: a failure after the sink is set up (exportFaults.failSetup) fails the export and aborts the handle writable, never closes it', async ({ page }) => {
  const { id } = await imageProject(page);
  failed(await runExport(page, id, {}, `${SETUP_FAULT}${SINK_LOG} return { handle };`, false), 'CLIENT_BUG', /exportFaults\.failSetup/);
  expect(await page.evaluate(() => (window as unknown as { __sink: unknown }).__sink)).toEqual({ writes: 0, closed: 0, aborted: 1 });
});
test('N5 encode, OPFS: after a failure in the setup the export-*.mp4 it created is not locked (removeEntry resolves)', async ({ page }) => {
  const { id } = await imageProject(page);
  failed(await runExport(page, id, {}, `${SETUP_FAULT} return {};`, false), 'CLIENT_BUG', /exportFaults\.failSetup/);
  const { left, errors } = await page.evaluate(async () => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe', { create: true })).getDirectoryHandle('exports', { create: true });
    const left: string[] = [], errors: Record<string, string> = {};
    for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) left.push(name);
    for (const n of left) await dir.removeEntry(n).then(() => { errors[n] = 'removed'; }, (e: Error) => { errors[n] = `${e.name}: ${e.message}`; });
    return { left, errors };
  });
  expect(left.some(n => /^export-.*\.mp4$/.test(n)), `the OPFS sink was used: ${JSON.stringify(left)}`).toBe(true);
  expect(Object.values(errors), JSON.stringify(errors)).toEqual(left.map(() => 'removed'));
});
