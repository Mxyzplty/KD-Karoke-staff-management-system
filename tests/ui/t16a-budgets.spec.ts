// SPDX-License-Identifier: AGPL-3.0-only
// T16a budgets, sinks, progress and audio chunking in Chromium (ledger L2, L6, L7, L11, L12, L14). Every export goes through
// startExport / getExportStatus (L12). Oracles: "written-spec oracle" = findings §7 / master plan §1b (decoder cap 4, prefetch
// <= 2 s, encoder queue <= 2, handle -> OPFS -> memory with room = 2.5 x estimate, stale after 2 min, progress every 5 frames
// with ETA, audio in 120 s chunks above 300 s, no network); "ffprobe ground truth" and "formula oracle" for the exported file.
// No test skips on the audio encoder: where AAC-LC cannot be encoded the export writes Opus (Q-F) and these tests do not assert the codec.
import { test, expect, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ffmpegAvailable, media } from '../media-fixtures';
import { skipTour } from './t02-support';
import { completed, decodePcm, formatOf, genMedia, hueClip, imageDoc, makeClip, mkDoc, rms, runExport, setup, streams } from './t16a-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the source media and reads the exported file back');
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

// ---- L2 decoder budgets ----------------------------------------------------------------------------------------------------------
test('L2 decoders: six overlapping clips complete with stats.decoders.maxOpen <= 4 (written-spec oracle: master plan §1b cap 4; O1: the 6-source case is slow, the test of record is "completes")', async ({ page }) => {
  const clips = [0, 1, 2, 3, 4, 5].map(i => ({ id: `c${i}`, track: `v${i + 1}`, from: 0, to: 500, sourceDuration: 1000 }));
  const { id } = await setup(page, mkDoc(clips, { fps: 10, size: { width: 160, height: 90 } }), Object.fromEntries(clips.map((c, i) => [c.id, hueClip(`t16a-cap-${i}.mp4`, i * 50)])));
  const r = completed(await runExport(page, id, {}, undefined, false));
  test.info().annotations.push({ type: 'decoders', description: JSON.stringify(r.stats.decoders) });
  expect(r.stats.decoders.maxOpen).toBeLessThanOrEqual(4);
  expect(r.stats.decoders.maxOpen).toBeGreaterThanOrEqual(2);
  expect(r.stats.decoders.opened).toBeGreaterThanOrEqual(6);
  expect(r.frames).toBe(5);
});

test('L2 decoders: a clip that starts late is not opened early, and the prefetch per source stays <= 2 s (written-spec oracle: findings §7 lazy open, 2 s window)', async ({ page }) => {
  const doc = mkDoc([{ id: 'a', from: 0, to: 3000, sourceDuration: 3000 }, { id: 'b', track: 'v2', from: 3000, to: 4000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { a: makeClip(3, 160, 90), b: makeClip(1, 160, 90) });
  const hook = 'window.__workers = []; const W = window.Worker; window.Worker = class extends W { constructor(...a) { super(...a); window.__others = window.__others || []; if (String(a[0]).includes("decoder.worker")) window.__workers.push(window.__t16prog ? window.__t16prog.frame : 0); else window.__others.push(String(a[0])); } }; return {};';
  const r = completed(await runExport(page, id, {}, hook, false));
  const created = await page.evaluate(() => (window as unknown as { __workers: number[] }).__workers);
  // Only the export's decoder workers count: the editor page starts other workers (not the export's) at times.
  test.info().annotations.push({ type: 'worker-created-at-progress-frame', description: JSON.stringify(created) });
  test.info().annotations.push({ type: 'other-workers', description: JSON.stringify(await page.evaluate(() => (window as unknown as { __others?: string[] }).__others ?? [])) });
  expect(r.stats.decoders.opened).toBe(2);
  expect(created[0]).toBe(0);
  // b is due at 3 s (frame 30). A decoder may open once the clip is within the 2 s window, i.e. at frame 10 (30 - 2 s x 10 fps) at the
  // earliest; a worker opened 2.5 s early (frame 5 to 9) is outside the window and must fail.
  expect(created[1]).toBeGreaterThanOrEqual(10);
  expect(r.stats.decoders.maxPrefetchS).toBeLessThanOrEqual(2);
});

test('L2 decoders: WebCodecs first, WASM second: the default path never retries; forceWasm completes through the WASM decoder (written-spec oracle: findings §7)', async ({ page }) => {
  const doc = mkDoc([{ id: 'a', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { a: makeClip(1, 160, 90) });
  const def = completed(await runExport(page, id, {}, undefined, false));
  expect(def.stats.decoders.wasmRetries).toBe(0);
  const wasm = await runExport(page, id, { forceWasm: true });
  completed(wasm);
  expect(Number(streams(wasm.file!).find(s => s.codec_type === 'video').nb_frames)).toBe(10);
});

// ---- L2 queue <= 2 ---------------------------------------------------------------------------------------------------------------
/** Page-level VideoEncoder stand-in: a real encoder behind a queue that releases one frame every 15 ms (the pipeline code is unchanged). */
const SLOW = `
  const Real = window.VideoEncoder;
  window.VideoEncoder = class extends Real {
    constructor(init) { super(init); this.q = []; this.t = null; }
    get encodeQueueSize() { return this.q.length + super.encodeQueueSize; }
    encode(frame, options) { this.q.push([frame.clone(), options]); this.pump(); }
    pump() {
      if (this.t) return;
      this.t = setTimeout(() => { this.t = null; const x = this.q.shift(); if (x) { super.encode(x[0], x[1]); x[0].close(); this.dispatchEvent(new Event('dequeue')); } if (this.q.length) this.pump(); }, 15);
    }
    async flush() { while (this.q.length) await new Promise(r => setTimeout(r, 5)); return super.flush(); }
    close() { for (const x of this.q) x[0].close(); this.q = []; return super.close(); }
  };`;
test('L2 queue: with a slow encoder the encode queue never exceeds 2 and the loop waits (written-spec oracle: findings §7 queue <= 2)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(2000, 30), { img: media('pattern.png') });
  const r = completed(await runExport(page, id, {}, SLOW + ' return {};', false));
  test.info().annotations.push({ type: 'queue', description: JSON.stringify({ maxEncodeQueue: r.stats.maxEncodeQueue, encodeWaits: r.stats.encodeWaits }) });
  expect(r.frames).toBe(60);
  expect(r.stats.maxEncodeQueue).toBeLessThanOrEqual(2);
  expect(r.stats.encodeWaits).toBeGreaterThan(0);
});
test('L2 queue, sensitivity: the same slow encoder with exportFaults.noBackpressure = true lets the queue pass 2 (the test above can fail)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(2000, 30), { img: media('pattern.png') });
  const hook = SLOW + " const d = '/src/export/decoders.ts'; (await import(d)).exportFaults.noBackpressure = true; return {};";
  const r = completed(await runExport(page, id, {}, hook, false));
  test.info().annotations.push({ type: 'queue-without-backpressure', description: JSON.stringify({ maxEncodeQueue: r.stats.maxEncodeQueue, encodeWaits: r.stats.encodeWaits }) });
  expect(r.stats.maxEncodeQueue).toBeGreaterThan(2);
  expect(r.stats.encodeWaits).toBe(0);
});

// ---- L6 sinks --------------------------------------------------------------------------------------------------------------------
const roomHook = (quotaExpr: string) => `
  const s = '/src/export/sinks.ts', { estimateBytes } = await import(s);
  const est = estimateBytes(1000000, 2), need = 2.5 * est, usage = 1000;
  return { bitrate: 1000000, storage: async () => ({ quota: ${quotaExpr}, usage }) };`;
test('L6 sinks: with room the export goes to OPFS cutframe/exports/export-<ts>.mp4 and the file is a valid MP4 (written-spec oracle: findings §7)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(2000, 30), { img: media('pattern.png') });
  const run = await runExport(page, id);
  const r = completed(run);
  expect(r.sink).toBe('opfs');
  expect(r.sinkName).toMatch(/^export-\d+\.mp4$/);
  const inOpfs = await page.evaluate(async name => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe')).getDirectoryHandle('exports');
    return (await (await dir.getFileHandle(name as string)).getFile()).size;
  }, r.sinkName);
  expect(inOpfs).toBe(r.blobSize);
  expect(Number(formatOf(run.file!).duration)).toBeCloseTo(2, 1);
});
test('L6 sinks, boundary: free = 2.5 x estimate - 1 -> memory; free = 2.5 x estimate -> OPFS (written-spec oracle: findings §7 room rule)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(2000, 30), { img: media('pattern.png') });
  // Free space is whole bytes: ceil(2.5 x est) is the least free that has room, ceil(2.5 x est) - 1 the most that has not.
  const below = await runExport(page, id, {}, roomHook('Math.ceil(need) - 1 + usage'), false);
  expect(completed(below).sink).toBe('memory');
  const at = await runExport(page, id, {}, roomHook('Math.ceil(need) + usage'), false);
  expect(completed(at).sink).toBe('opfs');
});
test('L6 sinks, memory fallback: the file is complete, index in front (fast start), and ffprobe reads it', async ({ page }) => {
  const { id } = await setup(page, imageDoc(2000, 30), { img: media('pattern.png') });
  const run = await runExport(page, id, {}, roomHook('0'));
  const r = completed(run);
  expect(r.sink).toBe('memory');
  expect(r.messages.join(' ')).toMatch(/in memory/);
  const bytes = readFileSync(run.file!), box = (at: number) => bytes.subarray(at + 4, at + 8).toString('latin1');
  expect(box(0)).toBe('ftyp');
  expect(box(bytes.readUInt32BE(0))).toBe('moov');
  expect(Number(streams(run.file!)[0].nb_frames)).toBe(60);
});
test('L6 sinks: stale export files older than 2 min are deleted, newer ones kept (written-spec oracle: findings §7)', async ({ page }) => {
  await page.goto('/');
  const out = await page.evaluate(async () => {
    const s = '/src/export/sinks.ts', { cleanStaleExports } = await import(s);
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('cutframe', { create: true })).getDirectoryHandle('exports', { create: true });
    const list = async () => { const n: string[] = []; for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) n.push(name); return n; };
    for (const n of ['export-1.mp4', 'other.mp4']) { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write('x'); await w.close(); }
    const now = Date.now();
    await cleanStaleExports(now + 119_000);
    const afterKept = await list();
    await cleanStaleExports(now + 121_000);
    return { afterKept, afterRemoved: await list() };
  });
  expect(out.afterKept).toContain('export-1.mp4');
  expect(out.afterRemoved).not.toContain('export-1.mp4');
  expect(out.afterRemoved).toContain('other.mp4'); // only export-*.mp4 files are touched
});

// ---- L7 progress / cancel / supersede / format -----------------------------------------------------------------------------------
test('L7 progress: a render report every 5 frames with an ETA, then the last frame, then finalize; getExportStatus ends completed with a download URL (written-spec oracle: findings §7)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(2100, 30), { img: media('pattern.png') });
  const run = await runExport(page, id);
  const r = completed(run);
  expect(r.frames).toBe(63);
  const render = run.samples.filter(p => p.phase === 'render');
  expect(render.map(p => p.frame)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 63]);
  for (const p of render) { expect(p.frames).toBe(63); expect(p.etaMs).not.toBeNull(); expect(p.etaMs).toBeGreaterThanOrEqual(0); expect(Number.isFinite(p.fps)).toBe(true); }
  const pct = render.map(p => p.percent);
  expect(pct).toEqual([...pct].sort((a, b) => a - b));
  expect(run.samples[run.samples.length - 1]).toMatchObject({ phase: 'finalize', frame: 63, frames: 63 });
  const st = await page.evaluate(async rid => { const e = '/src/export/index.ts', { getExportStatus } = await import(e), s = getExportStatus(rid); return { status: s.status, url: s.downloadUrl, progress: s.progress }; }, run.renderId);
  expect(st.status).toBe('completed'); expect(st.url).toMatch(/^blob:/); expect(st.progress).toMatchObject({ phase: 'finalize', frame: 63 });
});
test('L7 cancel: cancelExport during the render fails the export as USER_CANCELLED (written-spec oracle: error codes §12)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(10_000, 30), { img: media('pattern.png') });
  const out = await page.evaluate(async id => {
    const s = '/src/store/database.ts', e = '/src/export/index.ts', { projectStore } = await import(s), ex = await import(e), { document } = await projectStore.read(id);
    const rid = ex.startExport({ store: projectStore, doc: document, title: 'T16a' });
    while (!ex.getExportStatus(rid).progress) await new Promise(r => setTimeout(r, 10));
    ex.cancelExport(rid);
    const st = await ex.awaitExport(rid);
    return { status: st.status, code: st.error?.code, frame: st.progress?.frame };
  }, id);
  expect(out.status).toBe('failed'); expect(out.code).toBe('USER_CANCELLED'); expect(out.frame).toBeLessThan(300);
});
test('L7 cancel, signal already aborted (review-1 Nit 1): startExport with an aborted signal fails at once as USER_CANCELLED and renders nothing (written-spec oracle: error codes §12)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(10_000, 30), { img: media('pattern.png') });
  const run = await runExport(page, id, {}, 'const c = new AbortController(); c.abort(); return { signal: c.signal };', false);
  expect(run.status, 'the export should have failed').toBe('failed');
  expect(run.error).toMatchObject({ code: 'USER_CANCELLED' });
  expect(run.samples.filter(p => p.phase === 'render'), 'no render progress after an already-aborted signal').toEqual([]);
});
test('L7 supersede: a second startExport on the same project fails the first as SUPERSEDED and the second completes (written-spec oracle: error codes §12)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(10_000, 30), { img: media('pattern.png') });
  const out = await page.evaluate(async id => {
    const s = '/src/store/database.ts', e = '/src/export/index.ts', { projectStore } = await import(s), ex = await import(e), { document } = await projectStore.read(id);
    const a = ex.startExport({ store: projectStore, doc: document, title: 'A' });
    while (!ex.getExportStatus(a).progress) await new Promise(r => setTimeout(r, 10));
    const b = ex.startExport({ store: projectStore, doc: document, title: 'B', range: { startS: 0, endS: 0.5 } });
    const sa = await ex.awaitExport(a), sb = await ex.awaitExport(b);
    return { a: sa.status, aCode: sa.error?.code, b: sb.status, bFrames: sb.result?.frames };
  }, id);
  expect(out).toEqual({ a: 'failed', aCode: 'SUPERSEDED', b: 'completed', bFrames: 15 });
});
test('L7 format: format "webm" is NOT_IMPLEMENTED (T16 owns WebM)', async ({ page }) => {
  const { id } = await setup(page, imageDoc(1000, 30), { img: media('pattern.png') });
  const out = await page.evaluate(async id => {
    const s = '/src/store/database.ts', e = '/src/export/index.ts', { projectStore } = await import(s), ex = await import(e), { document } = await projectStore.read(id);
    try { ex.startExport({ store: projectStore, doc: document, format: 'webm' }); return { threw: false }; } catch (err) { return { threw: true, code: (err as { code?: string }).code }; }
  }, id);
  expect(out).toEqual({ threw: true, code: 'NOT_IMPLEMENTED' });
});

// ---- L11 audio chunking and the mix ---------------------------------------------------------------------------------------------
test('L11 chunked audio: a 310 s timeline asks the audio stage for 3 chunks (5.76M, 5.76M, 3.36M frames), releases after each, and stats.audioChunks is 3 (written-spec oracle: master plan §1b, 120 s chunks above 300 s)', async ({ page }) => {
  test.setTimeout(300_000);
  const doc = mkDoc([{ id: 'aud', type: 'audio', from: 0, to: 310_000, sourceDuration: 400_000 }], { fps: 1, size: { width: 64, height: 36 } });
  const { id } = await setup(page, doc, { aud: media('tone.mp3') });
  const hook = `
    window.__calls = []; window.__releases = 0;
    const stage = async (d, r) => { window.__calls.push({ startMs: r.startMs, frames: r.frames }); return { sampleRate: 48000, channels: 2, data: [new Float32Array(r.frames), new Float32Array(r.frames)] }; };
    stage.release = () => { window.__releases++; };
    return { audio: stage };`;
  const r = completed(await runExport(page, id, {}, hook, false));
  const seen = await page.evaluate(() => ({ calls: (window as unknown as { __calls: unknown[] }).__calls, releases: (window as unknown as { __releases: number }).__releases }));
  expect(seen.calls).toEqual([{ startMs: 0, frames: 5_760_000 }, { startMs: 120_000, frames: 5_760_000 }, { startMs: 240_000, frames: 3_360_000 }]);
  expect(seen.releases).toBe(3);
  expect(r.stats.audioChunks).toBe(3);
  expect(r.frames).toBe(310);
});
// T13: the stage is T13's mix, whose gain law squares the volume (findings §40), so volume 0.5 is a quarter of the level (−12.04 dB).
test('L11 mix: a 440 Hz clip at volume 0.5 exports with a quarter of the source level (formula oracle: source x stored volume², T13 gain law; ffmpeg-decoded RMS within 5 %)', async ({ page }) => {
  const wav = genMedia('t16a-sine.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-ac', '2', '-c:a', 'pcm_s16le']);
  const doc = mkDoc([{ id: 'aud', type: 'audio', from: 0, to: 2000, sourceDuration: 2000, properties: { volume: { defaultValue: 0.5, keyframes: [] } } }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { aud: wav });
  const run = await runExport(page, id);
  completed(run);
  const src = decodePcm(wav), out = decodePcm(run.file!);
  // 0.2 s to 1.8 s: clear of the AAC encoder delay and the end padding.
  const a = Math.round(0.2 * 48000), b = Math.round(1.8 * 48000);
  const want = rms(src.left, a, b) * 0.25, got = rms(out.left, a, b);
  test.info().annotations.push({ type: 'rms', description: JSON.stringify({ source: rms(src.left, a, b), want, got }) });
  expect(got / want).toBeGreaterThan(0.95); expect(got / want).toBeLessThan(1.05);
  expect(rms(out.right, a, b) / want).toBeGreaterThan(0.95); expect(rms(out.right, a, b) / want).toBeLessThan(1.05);
});

// ---- L14 no network --------------------------------------------------------------------------------------------------------------
test('L14 no network: during a video export no request leaves 127.0.0.1 (written-spec oracle: local-first, findings §7)', async ({ page }) => {
  const doc = mkDoc([{ id: 'a', from: 0, to: 1000, sourceDuration: 1000 }], { fps: 10, size: { width: 160, height: 90 } });
  const { id } = await setup(page, doc, { a: makeClip(1, 160, 90) });
  const urls: string[] = [], on = (req: Request) => urls.push(req.url());
  page.on('request', on);
  completed(await runExport(page, id, {}, undefined, false));
  page.off('request', on);
  const origin = new URL(test.info().project.use.baseURL!).origin; // the app's own server, whatever port the config serves on
  const foreign = urls.filter(u => !(u.startsWith('blob:') || u.startsWith('data:') || u.startsWith(origin + '/')));
  test.info().annotations.push({ type: 'requests-during-export', description: String(urls.length) });
  expect(foreign).toEqual([]);
});
