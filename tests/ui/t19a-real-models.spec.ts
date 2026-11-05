// SPDX-License-Identifier: AGPL-3.0-only
// Real-model parity: DirectEngine vs AnalysisWorker vs a second worker run must agree exactly (no retries,
// no loosened numeric equality on that comparison). Models/media are served only from the local fixture
// store after a SHA-256 check against datasets/manifest.json; any non-origin request is a defect.
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const STORE = process.env.CUTFRAME_FIXTURES;
test.skip(!STORE, 'needs $CUTFRAME_FIXTURES fixture store');
test.describe.configure({ retries: 0 });
test.setTimeout(600_000);

type ManifestFile = { path: string; sha256: string };
type ManifestModel = { id: string; files: ManifestFile[] };
const manifest: { models: ManifestModel[] } = STORE ? JSON.parse(readFileSync(path.join(process.cwd(), 'datasets/manifest.json'), 'utf8')) : { models: [] };
// Mirrors apps/web/src/analysis/engine.ts: transcribe() classifies (sound) -> speechRegions (vad) -> ASR (whisper)
// -> CTC alignment -> diarize (speaker); beats() classifies (sound) for an audio asset; describe()+footage
// use vision and CLIP (frame vectors, T19q round F8) then the shared embedder. sync needs the same five transcription models.
const MODELS_FOR: Record<'transcription' | 'beats' | 'footage' | 'sync', string[]> = {
  transcription: ['T19a-whisper', 'T19a-qwen3-asr', 'T19a-aligner', 'T19a-sound', 'T19a-vad', 'T19a-wespeaker'],
  beats: ['T19a-sound', 'T19a-beat-this-fold0'],
  footage: ['T19a-vision', 'T19a-clip', 'T19a-embedding'],
  sync: ['T19a-whisper', 'T19a-qwen3-asr', 'T19a-aligner', 'T19a-sound', 'T19a-vad', 'T19a-wespeaker'],
};

const hashCache = new Map<string, string>();
function sha256(file: string) {
  let hash = hashCache.get(file);
  if (hash === undefined) { hash = createHash('sha256').update(readFileSync(file)).digest('hex'); hashCache.set(file, hash); }
  return hash;
}

// Chromium's headless --remote-debugging-pipe transport caps a single CDP message at 100MB.
// route.fulfill({path}) inlines the whole file through that pipe base64-encoded (~1.33x the raw
// byte size), so it crashes well before the raw file reaches 100MB: the 86.6MB sound-classifier
// weights alone blew the cap. Serve anything past the gap in the fixture sizes (28.7MB vs. the next
// tier up at 61.4MB) from a companion static server via route.continue({url}), which never touches
// the CDP pipe; everything smaller keeps using route.fulfill({path}), the simpler native-CDP path.
const CDP_PIPE_CAP = 50 * 1024 * 1024;
const activeServers: Server[] = [];
test.afterEach(() => { while (activeServers.length > 0) activeServers.pop()!.close(); });

function startStaticServer(byRelative: ReadonlyMap<string, string>): Promise<string> {
  const server = createServer((req, res) => {
    const relative = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0]);
    const abs = byRelative.get(relative);
    if (!abs) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(abs).size, 'Access-Control-Allow-Origin': '*' });
    createReadStream(abs).pipe(res);
  });
  activeServers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }));
}

/** Hashes every file for the given model ids against the manifest, then serves ONLY those verified files under modelRoot. */
async function serveModels(page: Page, ids: readonly string[], modelRoot = '/t19a-models/') {
  const files = manifest.models.filter(m => ids.includes(m.id)).flatMap(m => m.files);
  expect(files.length, `no manifest rows for ${ids.join(', ')}`).toBeGreaterThan(0);
  const byRelative = new Map<string, string>();
  for (const file of files) {
    const abs = path.join(STORE!, file.path);
    expect(existsSync(abs), `missing model file ${file.path} (is the fixture store populated?)`).toBe(true);
    expect(sha256(abs), `SHA-256 mismatch for ${file.path}`).toBe(file.sha256);
    byRelative.set(file.path.replace(/^models\/t19a\//, ''), abs);
  }
  const origin = await startStaticServer(byRelative);
  await page.route(`**${modelRoot}**`, route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(new RegExp(`^.*${modelRoot}`), ''));
    const abs = byRelative.get(relative);
    if (!abs) return route.abort();
    return statSync(abs).size >= CDP_PIPE_CAP ? route.continue({ url: `${origin}/${relative}` }) : route.fulfill({ path: abs });
  });
}

/** Serves one fixture-store media file, unverified against the manifest (it carries no model-integrity hash). */
async function serveMedia(page: Page, file: string, mediaRoot = '/t19a-media/') {
  const abs = path.join(STORE!, file);
  expect(existsSync(abs), `missing media fixture ${file} (is the fixture store populated?)`).toBe(true);
  const origin = await startStaticServer(new Map([[file, abs]]));
  await page.route(`**${mediaRoot}${file}`, route => statSync(abs).size >= CDP_PIPE_CAP ? route.continue({ url: `${origin}/${file}` }) : route.fulfill({ path: abs }));
}

/** Aborts and counts every request that is not same-origin with the page; returns a getter for the count. */
async function blockRemote(page: Page, origin: string) {
  let remote = 0;
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    remote++; return route.abort();
  });
  return () => remote;
}

async function run(page: Page, task: 'transcription' | 'beats' | 'footage' | 'sync') {
  const origin = new URL(page.url()).origin;
  const remote = await blockRemote(page, origin);
  await serveModels(page, MODELS_FOR[task]);
  await serveMedia(page, task === 'beats' ? 'prerequisites/OT-5-drum-120.wav' : 'corpus/tos-speech-45s.mp4');
  const result = await page.evaluate(async task => {
    const path = '/src/analysis/tools/browser-check.ts';
    const { runWorkerCheck } = await import(path);
    return runWorkerCheck(task);
  }, task);
  expect(result.worker, 'worker must match DirectEngine exactly').toEqual(result.direct);
  expect(result.again, 'a second worker run must match the first exactly').toEqual(result.worker);
  expect(remote(), 'no request should leave the app origin').toBe(0);
  return result;
}

test.beforeEach(async ({ page }) => { await page.goto('/src/analysis/tools/check.html'); });

test('real transcription: DirectEngine, worker and worker rerun agree on the speech corpus clip', async ({ page }) => {
  const result = await run(page, 'transcription');
  expect(result.direct).toMatchObject({ status: 'complete' });
  // TR-P03 (median/p95 word-timing accuracy) is scored separately in score.ts against the aligned-speech
  // reference; this test establishes equality across the direct and Chromium worker paths.
  const transcript = (result.direct as {
    transcript: { language: string; languages: string[]; total_duration: number; segments: { id: number; speaker: number; text: string; words: { word: string; start: number; end: number }[] }[] };
  }).transcript;
  expect(Object.keys(transcript).sort()).toEqual(['language', 'languages', 'segments', 'total_duration'].sort());
  expect(transcript.segments.length).toBeGreaterThan(0);
  let lastEnd = -Infinity;
  for (const segment of transcript.segments) {
    expect(Number.isInteger(segment.id)).toBe(true);
    expect(Number.isInteger(segment.speaker)).toBe(true);
    expect(segment.words.length).toBeGreaterThan(0);
    expect(segment.text.trim().length).toBeGreaterThan(0);
    for (const word of segment.words) {
      expect(typeof word.word).toBe('string');
      for (const n of [word.start, word.end]) expect(Math.abs(n * 50 - Math.round(n * 50)), `${n} must land on the 20ms grid`).toBeLessThan(1e-7);
      expect(word.start, 'words must not decrease in time').toBeGreaterThanOrEqual(lastEnd);
      expect(word.end).toBeGreaterThanOrEqual(word.start);
      lastEnd = word.end;
    }
  }
  expect(result.backends).toMatchObject({ transcription: 'wasm', sound: 'wasm', 'word alignment': 'wasm' });
});

test('real beats: DirectEngine, worker and worker rerun agree on the drum fixture', async ({ page }) => {
  const result = await run(page, 'beats');
  const beats = result.direct as { stored: { bpm: number; beats: [number, number][] }; tab: { beats: [number, number][] } };
  expect(beats.stored.bpm).toBeGreaterThan(0);
  expect(beats.stored.beats.length).toBeGreaterThan(0);
  expect(beats.stored.beats.every(([t, s]) => t >= 0 && t <= 6 && s >= 0 && s <= 1)).toBe(true);
  expect(beats.tab.beats).toEqual(beats.stored.beats);
  expect(result.backends).toMatchObject({ sound: 'wasm' });
});

test('real footage: DirectEngine, worker and worker rerun agree on caption and self-search', async ({ page }) => {
  const result = await run(page, 'footage');
  const footage = result.direct as { analysis: { summary: string; segments: { description: string }[] }; search: { results: { assetId: string }[] } };
  expect(footage.analysis.summary.trim().length).toBeGreaterThan(0);
  expect(footage.analysis.segments.length).toBeGreaterThan(0);
  // The query is the asset's own first-segment caption: it must find itself through the real embedder.
  expect(footage.search.results.some(r => r.assetId === 'short')).toBe(true);
  expect(result.backends).toMatchObject({ vision: 'wasm', embedding: 'wasm' });
});

test('real sync: DirectEngine, worker and worker rerun agree on the real transcript offset', async ({ page }) => {
  const result = await run(page, 'sync');
  const sync = result.direct as { offset: number; confidence: number };
  // recut's audio starts 1.234s into the original clip, so recut(source) minus original(target) is ≈ −1.234s;
  // ASR word timestamps are not frame-exact, so this is a coarse sanity bound, not the worker/direct/again equality above.
  expect(sync.offset).toBeGreaterThan(-1.6);
  expect(sync.offset).toBeLessThan(-0.9);
  expect(sync.confidence).toBeGreaterThan(0.5);
});
