// SPDX-License-Identifier: AGPL-3.0-only
// T23 stand-in user runs (tickets l.306; T23 notes "Lane A's rulings" and "Stand-in user isolation check"): the user's model,
// Claude Code headless with only the cutframe server, edits a paired tab through `npx --offline cutframe-connect --stdio`,
// which relays to the helper this spec starts. CUTFRAME_T23_RUN picks the mode: smoke (does a viewMaskFrame image reach the
// model), A (timeline + captions + music-sync guides on the corpus), rfp02 (RF-P02: the 9:16 reframe of clip 2's robot shot,
// scored from the final document against fixtures/SUBJ, which only this scorer reads). Never in CI: skipped unless the variable
// is set. Each run writes its stream log, final document and summary under test-results/t23-runs/<mode>-<timestamp>/.
// The spec starts its own dev server (CUTFRAME_T23_PORT, default 4231; local models only in mode A) and stops it after.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHelper, type Helper } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { createProject, skipTour } from './t02-support';
import { STORE, hasStore, uploadAsset } from './t15-support';

const MODE = process.env.CUTFRAME_T23_RUN ?? '', MODES = ['smoke', 'A', 'rfp02'];
const ROOT = process.cwd(), PORT = Number(process.env.CUTFRAME_T23_PORT || 4231), BASE = `http://127.0.0.1:${PORT}`, LINK_KEY = 'cutframe:agent-link:v1';
const MODEL = 'claude-opus-5-5', BIN = 'apps/helper/bin/cutframe-connect.mjs';
const CLIP = (name: string) => path.join(STORE, 'corpus', name);
const SPEECH = 'tos-speech-45s.mp4', ACTION = 'tos-action-30s.mp4', MUSIC = 'tos-credits-music-40s.mp4';
/** The robot shot of clip 2 in source ms, on whole ms inside frames 247..453 (SUBJ file: 10.291667–18.916667 s). */
const SHOT = { from: 10292, to: 18916 };
/** Env variables the stand-in user never inherits: an API key (subscription only) and the parent Claude Code session's links. */
const STRIPPED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];
const MINUTES = { smoke: { prep: 0, cli: 10 }, A: { prep: 40, cli: 60 }, rfp02: { prep: 0, cli: 45 } } as Record<string, { prep: number; cli: number }>;

test.skip(!MODES.includes(MODE) || !hasStore, `stand-in user runs only: CUTFRAME_T23_RUN=${MODES.join('|')} and the fixture store`);
test.use({ baseURL: BASE, channel: 'chromium', viewport: { width: 1400, height: 900 }, launchOptions: { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] } });
test.beforeEach(({ page }) => skipTour(page));

type Json = Record<string, any>;
type Call = { id: string; name: string; input: unknown; isError: boolean; success?: boolean; code?: string; error?: string; blockTypes: string[]; images: { mimeType?: string; base64Chars: number; bytes: number }[] };

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function killTree(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}
/** D64 (Windows): npm rewrites the bin file; the tracked one is restored before and after each run. */
const restoreBin = () => { if (process.platform === 'win32') spawnSync('git', ['checkout', '--', BIN], { cwd: ROOT, stdio: 'ignore' }); };
const claudeBin = () => process.env.CUTFRAME_T23_CLAUDE
  || (process.platform === 'win32' ? path.join(process.env.APPDATA ?? '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe') : 'claude');

async function startVite(run: string, models: boolean): Promise<ChildProcess> {
  if (await fetch(BASE).then(() => true, () => false)) throw new Error(`${BASE} already answers: stop that server or set CUTFRAME_T23_PORT`);
  const log = join(run, 'vite.log'), child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, env: { ...process.env, CUTFRAME_LOCAL_MODELS: models ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout!.on('data', d => appendFileSync(log, d)); child.stderr!.on('data', d => appendFileSync(log, d));
  for (const end = Date.now() + 90_000; Date.now() < end; await sleep(500)) {
    if (child.exitCode !== null) throw new Error(`vite exited ${child.exitCode}: ${readFileSync(log, 'utf8').slice(-800)}`);
    if (await fetch(BASE).then(r => r.ok, () => false)) return child;
  }
  killTree(child); throw new Error('vite did not answer within 90 s');
}

/** Pairs the open tab with the helper (t12-helper pattern) and opens the editor. */
async function pair(page: Page, helper: Helper, projectId: string) {
  const token = newToken(); helper.store.add(token);
  await page.evaluate(t => new Promise<void>(resolve => {
    const open = indexedDB.open('cutframe-agent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
  }), token);
  await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
  await page.goto(`/project/${projectId}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
}
/** The harness's own MCP client (checks and scoring only; closed before the model starts, opened again after it ends). */
async function harnessClient(helper: Helper) {
  const c = new Client({ name: 't23-harness', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
  const call = async (name: string, args: Json) => (await c.callTool({ name, arguments: args }, undefined, { timeout: 900_000, resetTimeoutOnProgress: true })) as { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
  return { call, close: () => c.close() };
}
const bodyOf = (r: { content: { type: string; text?: string }[] }) => { try { return JSON.parse(r.content.find(b => b.type === 'text')?.text ?? 'null'); } catch { return null; } };

const docOf = (page: Page, id: string) => page.evaluate(async id => {
  const s = '/src/store/database.ts', m = '/src/store/model.ts', { projectStore } = await import(s), { validateDocument } = await import(m);
  const { document } = await projectStore.read(id);
  let valid: { ok: boolean; error?: string } = { ok: true };
  try { validateDocument(document); } catch (e) { valid = { ok: false, error: `${(e as { code?: string }).code ?? ''} ${(e as Error).message}` }; }
  return { document, valid };
}, id);
/** Links item `itemId` to the asset and gives it the stored properties the app's own placement writes (timeline/items.ts
 *  mediaItem: fitProperties(doc, naturalSize(asset), 'fit')), once the upload's probe has the display size. Then, on a copy
 *  only, the 9:16 starting state RF-P02 needs: resizeCanvas 9:16 and transformItem {fillCanvas} through the app's functions. */
type Placed = { natural: { width: number; height: number }; stored: Record<string, number>; placement: Record<string, number>; dryFill: { canvas: { width: number; height: number }; drawnBox: { x: number; y: number; width: number; height: number } } };
const placeClip = (page: Page, projectId: string, assetId: string, itemId: string): Promise<Placed> => page.evaluate(async ({ projectId, assetId, itemId }) => {
  const s = '/src/store/database.ts', it = '/src/timeline/items.ts', tr = '/src/timeline/tracks.ts', pr = '/src/timeline/properties.ts', pp = '/src/media/prepare.ts';
  const { projectStore } = await import(s), items = await import(it), tracks = await import(tr), props = await import(pr), { prepareAsset } = await import(pp);
  // uploadAsset only stores the file; the app's own upload also starts preparation (media/ingest.ts startPreparation), not awaited.
  void prepareAsset(projectStore, assetId).catch(() => 'failed');
  let asset: any = null;
  for (const end = Date.now() + 120_000; ; await new Promise(r => setTimeout(r, 500))) {
    asset = (await projectStore.library()).assets.find((a: any) => a.id === assetId);
    if (asset?.processing_status === 'ready' && items.naturalSize(asset)) break;
    if (asset?.processing_status === 'failed' || Date.now() > end) throw new Error(`asset ${assetId} has no display size (${asset?.processing_status})`);
  }
  const { document } = await projectStore.read(projectId), statics = (i: any) => props.statics(i) as Record<string, number>;
  const placement = items.mediaItem(document, { assetId, asset }, 'v1', 0, items.TOOL_IMAGE_MS).properties;
  document.items = document.items.map((i: any) => i.id === itemId ? { ...i, metadata: { assetId }, properties: structuredClone(placement) } : i);
  await projectStore.save(projectId, document, document.rev);
  const stored = (await projectStore.read(projectId)).document.items.find((i: any) => i.id === itemId);
  const copy = structuredClone(document); tracks.resizeCanvas(copy, '9:16');
  const drawnBox = items.transform(copy, itemId, { fillCanvas: true });
  return { natural: items.naturalSize(asset)!, stored: statics(stored), placement: statics({ properties: placement }), dryFill: { canvas: copy.size, drawnBox } };
}, { projectId, assetId, itemId });
type AssetState = { id: string; name: string; status: string; steps: Record<string, string> };
const assetsOf = (page: Page, id: string): Promise<AssetState[]> => page.evaluate(async id => {
  const s = '/src/store/database.ts', { projectStore } = await import(s), lib = await projectStore.library();
  const ids = new Set(lib.links.filter((l: any) => l.projectId === id && l.deleted_at === null).map((l: any) => l.assetId));
  return lib.assets.filter((a: any) => ids.has(a.id)).map((a: any) => ({ id: a.id as string, name: a.name as string, status: a.processing_status as string, steps: (a.processing_steps ?? {}) as Record<string, string> }));
}, id);
/** Run A evidence (lane A 17 Nov 23:01): per asset the stored error code and message, the preparation record's code and the
 *  transcript row (the only T19 row that keeps the worker's error text, analysis/steps.ts transcriptionStep). */
const failureEvidence = (page: Page, ids: string[]) => page.evaluate(async ids => {
  const s = '/src/store/database.ts', { projectStore } = await import(s);
  return Promise.all(ids.map(async id => {
    const a: any = await projectStore.row('assets', id), p: any = await projectStore.row('preparations', id), t: any = await projectStore.row('transcripts', id);
    return { id, name: a?.name, status: a?.processing_status, steps: a?.processing_steps ?? {}, lastErrorCode: a?.last_error_code ?? null, lastErrorMessage: a?.last_error_message ?? null,
      preparation: p ? { phase: p.phase, code: p.code ?? null } : null, transcript: t ? { status: t.status, error: t.error ?? null, reason: t.reason ?? null } : null };
  }));
}, ids);
const ORT_WASM = { name: 'ort-wasm-simd-threaded.jsep.wasm', sha256: '62ff86b2f2fa3a79eb87a7e4720e8ea9051942bf975f314181bf7dcef2feac06' };

/** Runs the stand-in user with the notes' exact flags from an empty folder; the stream goes to disk line by line. */
async function runModel(run: string, helperPort: number, configDir: string, prompt: string, minutes: number) {
  const cwd = mkdtempSync(join(tmpdir(), 't23-user-')), bin = claudeBin();
  const relay = ['--offline', '--prefix', ROOT, 'cutframe-connect', '--stdio', '--port', String(helperPort), '--config-dir', configDir];
  const server = process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...relay] } : { command: 'npx', args: relay };
  writeFileSync(join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: { cutframe: server } }, null, 2));
  const args = ['--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', join(cwd, 'mcp.json'), '--tools', '', '--allowedTools', 'mcp__cutframe__*',
    '--model', MODEL, '--no-session-persistence', '--include-hook-events', '--output-format', 'stream-json', '--verbose', '-p', prompt];
  // MCP_TIMEOUT: the relay's first start compiles the helper through tsx, which can pass Claude Code's default server start-up wait.
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_TIMEOUT: '60000' };
  const stripped = STRIPPED.filter(k => k in env); for (const k of STRIPPED) delete env[k];
  const version = spawnSync(bin, ['--version'], { env, encoding: 'utf8' }).stdout?.trim() ?? '';
  writeFileSync(join(run, 'mcp.json'), JSON.stringify({ mcpServers: { cutframe: server } }, null, 2));
  writeFileSync(join(run, 'command.json'), JSON.stringify({ bin, version, cwd, args, stripped }, null, 2));
  const stream = join(run, 'stream.jsonl'), errLog = join(run, 'claude-stderr.log'), started = Date.now();
  writeFileSync(stream, '');
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout!.on('data', d => appendFileSync(stream, d)); child.stderr!.on('data', d => appendFileSync(errLog, d));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, minutes * 60_000);
  const exitCode = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  clearTimeout(timer); killTree(child);
  rmSync(cwd, { recursive: true, force: true });
  return { version, exitCode, timedOut, seconds: Math.round((Date.now() - started) / 1000), stripped, lines: readFileSync(stream, 'utf8').split(/\r?\n/).filter(Boolean) };
}

/** The stream as tool calls with what reached the model, the init event, the final result and the model's own words. */
function parseStream(lines: string[]) {
  const events = lines.flatMap(l => { try { return [JSON.parse(l) as Json]; } catch { return []; } });
  const uses = new Map<string, { name: string; input: unknown }>(), calls: Call[] = [], words: string[] = [];
  let firstImageEvent: Json | undefined;
  for (const e of events) {
    const content = Array.isArray(e.message?.content) ? e.message.content as Json[] : [];
    if (e.type === 'assistant') for (const b of content) {
      if (b.type === 'tool_use') uses.set(b.id, { name: b.name, input: b.input });
      if (b.type === 'text') words.push(b.text);
    }
    if (e.type === 'user') for (const b of content) if (b.type === 'tool_result') {
      const blocks: Json[] = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
      const texts = blocks.filter(x => x.type === 'text').map(x => String(x.text));
      let body: Json | null = null; try { body = JSON.parse(texts[0] ?? ''); } catch { /* not JSON */ }
      const images = blocks.filter(x => x.type === 'image').map(x => {
        const data = String(x.source?.data ?? x.data ?? '');
        return { mimeType: x.source?.media_type ?? x.mimeType, base64Chars: data.length, bytes: Buffer.from(data, 'base64').length };
      });
      const use = uses.get(b.tool_use_id) ?? { name: '?', input: undefined }, name = String(use.name).replace(/^mcp__cutframe__/, '');
      // The first image-tool result as it stands in the stream, bytes cut out: is the image in message.content, in tool_use_result, or nowhere.
      if ((images.length || name === 'viewMaskFrame') && !firstImageEvent) firstImageEvent = redact(e);
      calls.push({ id: b.tool_use_id, name, input: use.input, isError: !!b.is_error, success: body?.success, code: body?.code,
        error: body?.error ?? (b.is_error || body?.success === false ? texts.join('\n').slice(0, 600) : undefined), blockTypes: blocks.map(x => String(x.type)), images });
    }
  }
  const init = events.find(e => e.type === 'system' && e.subtype === 'init'), result = [...events].reverse().find(e => e.type === 'result');
  const hooks = events.filter(e => /hook/i.test(String(e.subtype ?? e.type)));
  const tools: string[] = init?.tools ?? [], servers: Json[] = init?.mcp_servers ?? [];
  const isolation = {
    ok: servers.length === 1 && servers[0].name === 'cutframe' && servers[0].status === 'connected' && tools.length > 0 && tools.every(t => t.startsWith('mcp__cutframe__'))
      && !(init?.slash_commands ?? []).length && !(init?.skills ?? []).length && init?.apiKeySource === 'none' && !hooks.length && init?.model === MODEL,
    model: init?.model, apiKeySource: init?.apiKeySource, mcpServers: servers, toolCount: tools.length, nonCutframeTools: tools.filter(t => !t.startsWith('mcp__cutframe__')),
    slashCommands: init?.slash_commands ?? [], skills: init?.skills ?? [], plugins: init?.plugins ?? [], hookEvents: hooks.length,
  };
  return { calls, words, isolation, firstImageEvent, result: result ? { subtype: result.subtype, isError: result.is_error, durationMs: result.duration_ms, turns: result.num_turns, text: result.result } : null };
}
/** A stream event with base64 payloads cut to their length (evidence of the block shape without the bytes). */
function redact(v: unknown): any {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (k === 'data' || k === 'base64') && typeof x === 'string' ? `<${x.length} base64 chars>` : redact(x)]));
  return v;
}
/** Every refused call; unitLike marks the codes the A acceptance names (schema input, ranges, units). */
const UNIT_LIKE = /INVALID_TOOL_INPUT|RANGE|BOUND|UNIT|OUT_OF|NEGATIVE|TOO_|EXCEED|MINIMUM|MAXIMUM|OUTSIDE/;
const refusals = (calls: Call[]) => calls.filter(c => c.isError || c.success === false).map(c => ({ name: c.name, code: c.code, error: c.error, input: c.input, unitLike: UNIT_LIKE.test(`${c.code ?? ''} ${c.error ?? ''}`) }));

// ---- Mode A scoring. Gates: a valid document, no unit-like refusal, a caption, a cut. Beat alignment is reported only (the guide
// allows subdivisions): each cut's offset to the nearest beat and to the nearest subdivision, against the guide's tolerance.
async function musicBeats(call: Awaited<ReturnType<typeof harnessClient>>['call'], doc: Json, musicAssetId: string) {
  const items = (doc.items as Json[]).filter(i => i.metadata?.assetId === musicAssetId && (i.type === 'audio' || i.type === 'video'));
  const beats: number[] = [], subdivisions: number[] = [], notes: unknown[] = [];
  for (const i of items) {
    const from = i.display.from / 1000, to = i.display.to / 1000;
    let r = bodyOf(await call('viewItemDetails', { itemId: i.id, include: 'beats', beatsFrom: from, beatsTo: to }));
    if (r?.success && r.data?.beats?.beats) {
      beats.push(...(r.data.beats.beats as [number, number][]).map(([t]) => t)); subdivisions.push(...(r.data.beats.subdivisions?.timestamps ?? []) as number[]);
      notes.push({ itemId: i.id, via: 'item', bpm: r.data.beats.bpm }); continue;
    }
    // A video item has no item beats (BEATS_NOT_AUDIO): its asset's source beats mapped through the item's trim and rate.
    const rate = Number(i.playbackRate ?? 1), s0 = (i.trim?.from ?? 0) / 1000, s1 = s0 + (to - from) * rate, map = (s: number) => from + (s - s0) / rate;
    r = bodyOf(await call('viewItemDetails', { assetId: musicAssetId, include: 'beats', beatsFrom: s0, beatsTo: s1 }));
    beats.push(...((r?.data?.beats?.beats ?? []) as [number, number][]).map(([s]) => map(s))); subdivisions.push(...((r?.data?.beats?.subdivisions?.timestamps ?? []) as number[]).map(map));
    notes.push({ itemId: i.id, via: 'asset', reason: r?.data?.noBeats ?? r?.code, bpm: r?.data?.beats?.bpm });
  }
  const sort = (xs: number[]) => xs.sort((a, b) => a - b);
  return { musicItems: items.map(i => ({ id: i.id, type: i.type, trackId: i.trackId, from: i.display.from, to: i.display.to })), beats: sort(beats), subdivisions: sort(subdivisions), notes };
}
/** The nearest grid time to s and the spacing of the grid there. */
function nearestOn(grid: number[], s: number) {
  if (!grid.length) return null;
  const j = grid.reduce((best, g, k) => Math.abs(g - s) < Math.abs(grid[best] - s) ? k : best, 0), spacing = grid[j + 1] !== undefined ? grid[j + 1] - grid[j] : grid[j] - grid[j - 1];
  return { at: grid[j], offset: +(s - grid[j]).toFixed(4), spacing: Number.isFinite(spacing) && spacing > 0 ? spacing : null };
}
function scoreCuts(doc: Json, music: { beats: number[]; subdivisions: number[] }, toleranceBeats: number) {
  const visualTracks = new Set((doc.tracks as Json[]).filter(t => t.kind !== 'audio').map(t => t.id));
  const visual = (doc.items as Json[]).filter(i => (i.type === 'video' || i.type === 'image') && visualTracks.has(i.trackId));
  const end = Math.max(0, ...visual.map(i => i.display.to)), times: number[] = [];
  for (const i of visual) for (const t of [i.display.from, i.display.to]) if (t > 0 && t < end && !times.some(x => Math.abs(x - t) < 1)) times.push(t);
  const cuts = times.sort((a, b) => a - b).map(ms => {
    const s = ms / 1000, beat = nearestOn(music.beats, s), subdivision = nearestOn(music.subdivisions, s);
    const tolerance = beat?.spacing ? +(toleranceBeats * beat.spacing).toFixed(4) : null;
    return { at: s, beat, subdivision, tolerance, onBeat: !!beat && tolerance !== null && Math.abs(beat.offset) <= tolerance,
      onSubdivision: !!subdivision && tolerance !== null && Math.abs(subdivision.offset) <= tolerance };
  });
  return { visualItems: visual.length, cuts, onBeat: cuts.filter(c => c.onBeat).length, onBeatOrSubdivision: cuts.filter(c => c.onBeat || c.onSubdivision).length };
}

// ---- RF-P02 scoring (lane A's ruling): subject centre inside the middle 30 % of the width in >= 11 of the 12 samples with a
// point, no empty border at any of the 17 samples, at most 1 distinct position keyframe time in any [t, t + 1 s), a 9:16 canvas.
// Geometry is the app's own: render/model.ts framePlan (itemBox, boxMatrix, frameScale) and cover, evaluated in the tab.
type Subj = { clip: { width: number; height: number }; points: { t_s: number; x: number | null; y: number | null }[] };
async function drawsOf(page: Page, doc: Json, assetId: string, src: { width: number; height: number }) {
  return page.evaluate(async ({ doc, assetId, src }) => {
    const m = '/src/render/model.ts', p = '/src/timeline/properties.ts', model = await import(m), props = await import(p), fps = model.fpsOf(doc), size = model.projectSize(doc);
    const frames: { t: number; itemId: string; sourceMs: number; matrix: number[]; W: number; H: number; cover: { x: number; y: number; w: number; h: number }; alpha: number }[] = [];
    // Every frame of the timeline: a draw of the clip-2 video with its matrix (box → frame px) and the cover rectangle of the source in the box.
    for (let n = 0, end = Math.ceil(doc.duration * fps / 1000); n <= end; n++) {
      const t = model.frameTime(n, fps);
      for (const d of model.framePlan(doc, t).draws) if (d.kind === 'video' && d.item.metadata?.assetId === assetId)
        frames.push({ t, itemId: d.item.id, sourceMs: d.sourceMs, matrix: d.matrix, W: d.box.W, H: d.box.H, cover: model.cover(src.width, src.height, d.box.W, d.box.H)!, alpha: d.alpha });
    }
    const keyframes: { itemId: string; from: number; len: number; pt0: number; pt1: number; positionX: number[]; positionY: number[] }[] = (doc.items as any[]).filter(i => i.type === 'video' && i.metadata?.assetId === assetId).map(i => {
      const len = i.display.to - i.display.from, kf = (k: string) => (props.prop(i, k)?.keyframes ?? []).map((x: any) => x.time as number);
      return { itemId: i.id, from: i.display.from, len, pt0: props.propertyTime(i, 0), pt1: props.propertyTime(i, len), positionX: kf('positionX'), positionY: kf('positionY') };
    });
    return { size, fps, frames, keyframes };
  }, { doc, assetId, src });
}
/** A sample's timeline frame: the draw showing the source time nearest to it, within 50 ms (about one source frame at 24 fps). */
const NEAR_MS = 50;
function scoreReframe(subj: Subj, d: Awaited<ReturnType<typeof drawsOf>>) {
  const { width: Wp, height: Hp } = d.size, apply = (m: number[], u: number, v: number) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  const at = (s: number) => d.frames.filter(f => Math.abs(f.sourceMs - s * 1000) <= NEAR_MS).sort((a, b) => Math.abs(a.sourceMs - s * 1000) - Math.abs(b.sourceMs - s * 1000))[0];
  const inside = (quad: number[][], [x, y]: number[]) => quad.every((a, k) => { const b = quad[(k + 1) % 4]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= -0.5 * Math.hypot(b[0] - a[0], b[1] - a[1]); });
  const samples = subj.points.map(p => {
    const f = at(p.t_s);
    if (!f) return { t_s: p.t_s, shown: false, subjectOk: p.x === null ? null : false, borderOk: false };
    const quad = [[0, 0], [f.W, 0], [f.W, f.H], [0, f.H]].map(([u, v]) => apply(f.matrix, u, v));
    const corners = [[0, 0], [Wp, 0], [Wp, Hp], [0, Hp]], quadOrdered = signedArea(quad) < 0 ? [...quad].reverse() : quad;
    const borderOk = corners.every(c => inside(quadOrdered, c));
    let subject: number[] | null = null;
    if (p.x !== null && p.y !== null) { const r = f.cover; subject = apply(f.matrix, r.x + p.x * r.w / subj.clip.width, r.y + p.y * r.h / subj.clip.height); }
    return { t_s: p.t_s, shown: true, timelineMs: f.t, itemId: f.itemId, sourceMs: +f.sourceMs.toFixed(1), alpha: f.alpha, borderOk,
      subjectX: subject ? +subject[0].toFixed(1) : null, subjectY: subject ? +subject[1].toFixed(1) : null,
      subjectOk: subject ? Math.abs(subject[0] - Wp / 2) <= 0.15 * Wp : null };
  });
  // Position keyframes inside the shot, as timeline ms (property time mapped linearly over each item: exact at a constant rate).
  // The gate (lane F): distinct keyframe times on positionX or positionY (a time keyed on both counts once), at most 1 in any
  // half-open window [t, t + 1 s); keyframes exactly 1 s apart pass.
  const kfTimes = (key: 'positionX' | 'positionY') => d.keyframes.flatMap(k => k[key].filter(t => t >= k.pt0 && t <= k.pt1).map(t => k.from + (k.pt1 > k.pt0 ? (t - k.pt0) / (k.pt1 - k.pt0) * k.len : 0))).sort((a, b) => a - b);
  const distinct = (ts: number[]) => [...ts].sort((a, b) => a - b).filter((t, k, s) => k === 0 || t - s[k - 1] > 1e-6);
  const xs = kfTimes('positionX'), ys = kfTimes('positionY'), xy = distinct([...xs, ...ys]), windowMax = (ts: number[]) => Math.max(0, ...ts.map(t => ts.filter(u => u >= t && u < t + 1000).length));
  const scored = samples.filter(s => s.subjectOk !== null), shotS = (SHOT.to - SHOT.from) / 1000;
  return {
    canvas: { width: Wp, height: Hp, nineBySixteen: Math.abs(Wp / Hp - 9 / 16) < 0.01 },
    subject: { scored: scored.length, inside: scored.filter(s => s.subjectOk).length, pass: scored.length === 12 && scored.filter(s => s.subjectOk).length >= 11 },
    borders: { samples: samples.length, ok: samples.filter(s => s.borderOk).length, pass: samples.every(s => s.borderOk) },
    keyframes: { positionX: xs.length, positionY: ys.length, distinctTimes: xy.length, timesMs: xy.map(t => +t.toFixed(1)), perSecond: +(xy.length / shotS).toFixed(3),
      maxInAnyOneSecondX: windowMax(xs), maxInAnyOneSecond: windowMax(xy), pass: windowMax(xy) <= 1 },
    samples,
  };
}
const signedArea = (q: number[][]) => q.reduce((s, a, k) => { const b = q[(k + 1) % q.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;

const PROMPTS: Record<string, string> = {
  smoke: 'Call the cutframe tool viewMaskFrame with itemId "c" and timelineSeconds 1. Do not call any other tool. Then answer three things: '
    + '(1) whether the tool result gave you an image you can actually see, or only text; (2) a detailed description of the picture: people, objects, setting, colours, '
    + 'lighting and where things sit in the frame; (3) the image size in pixels as you perceive it from the image itself, kept separate from any width or height numbers in the text part of the result. '
    + 'If you received no image, say so plainly instead of guessing.',
  A: 'This Cutframe project holds three clips: a dialogue scene (tos-speech-45s.mp4), an action scene (tos-action-30s.mp4) and a credits clip with music (tos-credits-music-40s.mp4). '
    + 'Start with getAgentOverview, then use loadSkill to read the guides you need before you edit. '
    + 'Make a short edit of about 20 to 30 seconds: use the music from the credits clip as the soundtrack, cut between shots from the dialogue and action clips so that the cuts land on the music\'s beats, '
    + 'and add captions for the dialogue. Do not export. When you are done, list the cuts you made and their times.',
  rfp02: 'The timeline of this Cutframe project holds one shot from an action clip (item "c"): a rooftop view where a combat robot appears. '
    + 'Reframe it to vertical 9:16 for a phone so that the robot stays centred as it moves. Start with getAgentOverview and use loadSkill to read the reframe skill before you edit. '
    + 'Do not export. When you are done, say what you changed.',
};

test(`T23 stand-in user run: ${MODE}`, async ({ page }) => {
  const budget = MINUTES[MODE] ?? { prep: 0, cli: 0 };
  test.setTimeout((budget.prep + budget.cli + 10) * 60_000);
  const run = path.join(ROOT, 'test-results', 't23-runs', `${MODE}-${stamp()}`); mkdirSync(run, { recursive: true });
  const summary: Json = { mode: MODE, started: new Date().toISOString(), run, base: BASE, model: MODEL };
  const save = () => writeFileSync(join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  const cleanups: (() => unknown)[] = [];
  // Browser evidence for every mode: page and worker console, uncaught page errors, and each .wasm the page or a worker loads.
  const browserLog = join(run, 'browser.log'), wasm: { url: string; status: number }[] = [];
  writeFileSync(browserLog, '');
  page.on('console', m => appendFileSync(browserLog, `${new Date().toISOString()} ${m.worker() ? 'worker ' : ''}console.${m.type()} ${m.location().url}:${m.location().lineNumber} ${m.text()}\n`));
  page.on('pageerror', e => appendFileSync(browserLog, `${new Date().toISOString()} pageerror ${e.stack ?? e.message}\n`));
  // URL and status only: the jsep binary (about 28 MB, in a worker) may be past what CDP keeps of a response body.
  page.context().on('response', r => { try { if (new URL(r.url()).pathname.endsWith('.wasm')) wasm.push({ url: r.url(), status: r.status() }); } catch { /* evidence only */ } });
  restoreBin();
  try {
    const vite = await startVite(run, MODE === 'A'); cleanups.push(() => killTree(vite));
    const configDir = mkdtempSync(join(tmpdir(), 't23-helper-'));
    const helper = await startHelper({ port: 0, log: line => appendFileSync(join(run, 'helper.log'), line + '\n'), configDir, allowOrigins: [BASE], quietMs: 100 });
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }), () => helper.close());

    // The project.
    let projectId = '', ids: Record<string, string> = {};
    const track = (id: string, kind: string) => ({ id, name: id.toUpperCase(), kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
    const base = { schemaVersion: 4, rev: 0, groups: {}, fps: 30, size: { width: 1920, height: 1080 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [] };
    const video = (id: string, from: number, to: number, trim: number, sourceDuration: number) => ({ id, type: 'video', trackId: 'v1', display: { from, to }, trim: { from: trim, to: trim + to - from }, sourceDuration, details: { name: id } });
    const upload = async (name: string) => ids[name] = await uploadAsset(page, projectId, readFileSync(CLIP(name)), name, 'video/mp4');
    if (MODE === 'smoke' || MODE === 'rfp02') {
      const smoke = MODE === 'smoke', len = smoke ? 45000 : SHOT.to - SHOT.from;
      projectId = await createProject(page, { ...base, duration: len, tracks: [track('v1', 'video')], layerOrder: [{ type: 'track', id: 'v1' }],
        items: [video('c', 0, len, smoke ? 0 : SHOT.from, smoke ? 45000 : 30000)] }, `T23 ${MODE}`);
      // Item c as the app places it (review R1): stored width / height / scale / position, checked before the model starts.
      const placed = summary.placement = await placeClip(page, projectId, await upload(smoke ? SPEECH : ACTION), 'c');
      const { width: w, height: h } = placed.natural, fit = Math.min(1920 / w, 1080 / h);
      expect(placed.stored, 'item c stores the app\'s own placement').toEqual(placed.placement);
      expect(placed.stored, 'fit placement on 1920 × 1080').toEqual(expect.objectContaining({ width: w, height: h }));
      expect(placed.stored.scale).toBeCloseTo(fit, 9);
      expect(placed.stored.positionX).toBeCloseTo((1920 - w * fit) / 2, 9);
      expect(placed.stored.positionY).toBeCloseTo((1080 - h * fit) / 2, 9);
      if (!smoke) {
        expect(placed.dryFill.canvas, 'resizeCanvas 9:16 on a copy').toEqual({ width: 1080, height: 1920 });
        expect(placed.dryFill.drawnBox.width, 'a dry fillCanvas leaves room to pan: drawnBox wider than the canvas').toBeGreaterThan(placed.dryFill.canvas.width);
      }
    } else {
      projectId = await createProject(page, { ...base, duration: 1000, tracks: [track('v1', 'video'), track('a1', 'audio')], layerOrder: [{ type: 'track', id: 'a1' }, { type: 'track', id: 'v1' }], items: [] }, 'T23 A');
      for (const name of [SPEECH, ACTION, MUSIC]) await upload(name);
    }
    summary.projectId = projectId; summary.assets = ids; save();
    await pair(page, helper, projectId);

    // Preparation (mode A: the corpus must have its transcripts before the model starts; the music's beats are read once here).
    if (MODE === 'A') {
      const end = Date.now() + budget.prep * 60_000;
      for (;;) {
        const assets = await assetsOf(page, projectId);
        appendFileSync(join(run, 'prep.log'), `${new Date().toISOString()} ${JSON.stringify(assets.map(a => [a.name, a.status, a.steps]))}\n`);
        if (assets.length === 3 && assets.every(a => (a.status === 'ready' || a.status === 'failed') && !Object.values(a.steps).some(s => s === 'pending' || s === 'processing'))) { summary.preparation = assets; break; }
        if (Date.now() > end) throw new Error(`preparation did not settle in ${budget.prep} min (prep.log)`);
        await sleep(10_000);
      }
      save();
      // Evidence before any stop (lane A 17 Nov 23:01): every asset's errors, the .wasm binaries loaded, the browser log.
      const failed = (summary.preparation as AssetState[]).filter(a => a.status === 'failed' || Object.values(a.steps).includes('failed')).map(a => a.name);
      // Each observed .wasm fetched again from Node (same Vite server) and hashed; evidence only, no stop (lane A 17 Nov 23:21).
      const hashed = await Promise.all(wasm.map(async w => {
        const name = path.posix.basename(new URL(w.url).pathname);
        try {
          const r = await fetch(w.url);
          return { name, url: w.url, status: w.status, sha256: r.ok ? createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex') : null, error: r.ok ? null : `re-fetch HTTP ${r.status}` };
        } catch (e) { return { name, url: w.url, status: w.status, sha256: null, error: String(e) }; }
      }));
      const ortLoaded = hashed.some(w => w.name === ORT_WASM.name && w.sha256 === ORT_WASM.sha256);
      summary.evidence = { failed, assets: await failureEvidence(page, Object.values(ids)), wasm: hashed.length ? hashed : 'not observed', ortLoaded, expectedWasm: ORT_WASM, browserLog: 'browser.log', helperLog: 'helper.log' };
      save();
      expect(summary.preparation.find((a: Json) => a.name === SPEECH)?.steps.transcription, 'the dialogue needs a transcript (local models: CUTFRAME_LOCAL_MODELS=1 dev server)').toBe('complete');
      // Fail-fast: no model phase on a failed preparation (errors: summary.evidence, browser.log).
      expect(failed, 'fail-fast: preparation steps failed (summary.json evidence.assets)').toEqual([]);      const h = await harnessClient(helper);
      for (let k = 0; k < 10; k++) {
        const r = bodyOf(await h.call('viewItemDetails', { assetId: ids[MUSIC], include: 'beats' }));
        summary.musicWarmUp = r; if (r?.code !== 'TOOL_TIMEOUT') break;
      }
      await h.close(); save();
    }
    // Smoke: what the helper itself returns, and ffmpeg's own picture of the same source frame (timeline 1 s = source 1 s).
    if (MODE === 'smoke') {
      const h = await harnessClient(helper), view = await h.call('viewMaskFrame', { itemId: 'c', timelineSeconds: 1 });
      await h.close();
      const image = view.content.find(b => b.type === 'image');
      if (image?.data) writeFileSync(join(run, 'helper-frame-1s.jpg'), Buffer.from(image.data, 'base64'));
      const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', CLIP(SPEECH), '-frames:v', '1', join(run, 'ffmpeg-frame-1s.png')], { encoding: 'utf8' });
      summary.helperReturns = { isError: !!view.isError, blocks: view.content.map(b => [b.type, b.mimeType ?? null]), text: bodyOf(view), imageBytes: image?.data ? Buffer.from(image.data, 'base64').length : 0, ffmpeg: ff.status === 0 ? 'ffmpeg-frame-1s.png' : ff.stderr?.slice(-300) };
      save();
      expect(summary.helperReturns.blocks, 'the helper returns a text block and a JPEG').toEqual([['text', null], ['image', 'image/jpeg']]);
    }

    // The stand-in user.
    restoreBin();
    const m = await runModel(run, helper.port, configDir, PROMPTS[MODE], budget.cli);
    restoreBin();
    const parsed = parseStream(m.lines);
    Object.assign(summary, { claude: { version: m.version, exitCode: m.exitCode, timedOut: m.timedOut, seconds: m.seconds, strippedEnv: m.stripped }, isolation: parsed.isolation, result: parsed.result,
      toolCalls: parsed.calls.map(c => ({ name: c.name, success: c.success, code: c.code, isError: c.isError, blocks: c.blockTypes, images: c.images })), refusals: refusals(parsed.calls), modelText: parsed.words });
    save();
    const { document, valid } = await docOf(page, projectId);
    writeFileSync(join(run, 'document.json'), JSON.stringify(document, null, 2));
    summary.document = { valid, items: (document.items as Json[]).length, size: document.size, duration: document.duration };
    save();

    if (MODE === 'smoke') {
      const views = parsed.calls.filter(c => c.name === 'viewMaskFrame');
      summary.smoke = { viewMaskFrameCalls: views.length, imageReachedModel: views.some(c => c.images.length > 0), images: views.flatMap(c => c.images), blockTypes: views.map(c => c.blockTypes),
        firstImageEvent: parsed.firstImageEvent ?? null, compare: 'helper-frame-1s.jpg and ffmpeg-frame-1s.png in this folder; the model\'s description is modelText' };
      save();
    }
    if (MODE === 'A') {
      const h = await harnessClient(helper);
      const beats = await musicBeats(h.call, document, ids[MUSIC]); await h.close();
      const tolerance = await page.evaluate(async () => { try { const f = '/src/agent/guides/facts.ts'; return Number((await import(f)).FACTS?.['beats.snapToleranceBeats']?.value) || null; } catch { return null; } });
      const captions = (document.items as Json[]).filter(i => i.type === 'caption' || (i.type === 'text' && i.details?.subType === 'caption'));
      const cuts = scoreCuts(document, beats, tolerance ?? 0.25);
      const unitRefusals = summary.refusals.filter((r: Json) => r.unitLike);
      // Gates (lane F): valid document, no unit-like refusal, a caption, a cut. Beat alignment is in `cuts`, reported only.
      summary.scoreA = { schemaValid: valid.ok, captions: captions.length, captionWords: captions.reduce((n, c) => n + (Array.isArray(c.details?.words) ? c.details.words.length : 0), 0),
        toleranceBeats: tolerance ?? 0.25, toleranceSource: tolerance ? 'FACTS beats.snapToleranceBeats' : 'music-sync guide default (0.25 beat)', music: beats, cuts, unitRefusals: unitRefusals.length,
        pass: valid.ok && captions.length > 0 && unitRefusals.length === 0 && cuts.cuts.length > 0 };
      save();
      expect.soft(valid, 'the final document passes the project schema').toEqual({ ok: true });
      expect.soft(unitRefusals, 'no call refused with INVALID_TOOL_INPUT or a range/unit code').toEqual([]);
      expect.soft(captions.length, 'captions exist').toBeGreaterThan(0);
      expect.soft(cuts.cuts.length, 'the edit has cuts').toBeGreaterThan(0);
    }
    if (MODE === 'rfp02') {
      const subj = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'SUBJ clip 2 subject centre.json'), 'utf8')) as Subj;
      const score = scoreReframe(subj, await drawsOf(page, document, ids[ACTION], subj.clip));
      summary.scoreRFP02 = { ...score, pass: score.canvas.nineBySixteen && score.subject.pass && score.borders.pass && score.keyframes.pass };
      save();
      expect.soft(score.canvas.nineBySixteen, 'a 9:16 canvas').toBe(true);
      expect.soft(score.subject.inside, 'subject centre inside the middle 30 % in >= 11 of 12 samples').toBeGreaterThanOrEqual(11);
      expect.soft(score.borders.ok, 'no empty border at any 0.5 s sample').toBe(score.borders.samples);
      expect.soft(score.keyframes.maxInAnyOneSecond, 'at most 1 distinct position keyframe time in any [t, t + 1 s) of the shot').toBeLessThanOrEqual(1);
    }
    expect(parsed.isolation.ok, `isolation: ${JSON.stringify(parsed.isolation)}`).toBe(true);
    expect(m.timedOut, 'the model run ended inside its time budget').toBe(false);
  } finally {
    summary.ended = new Date().toISOString(); save();
    while (cleanups.length) { try { await cleanups.pop()!(); } catch { /* best effort */ } }
    restoreBin();
    if (!existsSync(join(run, 'summary.json'))) save();
    // A copy outside the repo (lane F's CUTFRAME_T23_KEEP): a later full UI run empties test-results/.
    if (process.env.CUTFRAME_T23_KEEP) cpSync(run, join(process.env.CUTFRAME_T23_KEEP, path.basename(run)), { recursive: true });
  }
});
