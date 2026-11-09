// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 9 (First Edit, §28b), the demo itself: PT-FE-05 (music), PT-FE-06 (montage), PT-FE-07 (look; the same
// document and undo history as the same commands by hand and through the agent tools), PT-FE-08 (cosmetic input), PT-FE-09
// (soft failures W3–W9), PT-FE-10 (no provider, pack cached, network blocked), PT-FE-11 (exit and clean-up), PT-FE-12 (export).
// The expected plan is computed here from the pack's records and the stored durations by the rules of the findings §28b.3.2,
// not read back from the app. The two long runs (online, then offline with other typed input) are made once per invocation
// and kept in a temp file, so a worker restarted after a failure does not repeat them. Nothing leaves localhost.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHelper } from '../../apps/helper/src/helper';
import { newToken } from '../../apps/helper/src/store';
import { buildPlan, clipPools, clock, cutBoundaries } from '../../apps/web/src/settings/first-edit/plan';
import type { DemoAsset } from '../../apps/web/src/settings/first-edit/plan';
import { ffmpegAvailable } from '../media-fixtures';
import { guard, skipTour } from './t02-support';
import { decodePcm, decodeRgba, ff, runExport, streams, type Run as ExportRun } from './t16a-support';

test.use({ viewport: { width: 1400, height: 900 } });
const KEY = 'cutframe:onboarding:v1', LINK_KEY = 'cutframe:agent-link:v1', FPS = 30, FRAME = 1000 / FPS;
const AT_PICKER = { phase: 'drive-picker', step: 3, answers: {}, other: {}, completed: false };
const FINAL_HEADLINE = 'Your montage is ready. Press play.';
type PackFile = { file: string; type: 'video' | 'audio'; durationMs: number; rhythm_data?: any; segments?: any[] };
const PACK = JSON.parse(readFileSync(join(process.cwd(), 'vendor', 'demo-pack', 'pack.json'), 'utf8')) as { files: PackFile[] };

// ---- page helpers --------------------------------------------------------------------------------------------------------
const seed = (page: Page, state: Record<string, unknown>) => page.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k as string)) localStorage.setItem(k as string, JSON.stringify(v)); } catch { /* storage unavailable */ } }, [KEY, state]);
const stored = (page: Page) => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null') as Record<string, any> | null, KEY);
const intro = (page: Page) => page.getByRole('heading', { name: 'A quick look at what this can do' });
const built = (page: Page) => page.getByRole('button', { name: /Use the built-in assistant/ });
const isImport = (url: string) => /[?&]import\b/.test(url);
const isPackUrl = (url: string) => /demo-pack|\.webm|\.mp3|pack\.json/.test(url) && !isImport(url);
const isPackJson = (url: string) => /pack\.json/.test(url) && !isImport(url);

type Obs = { tracks: string[]; duration: number; labels: string[]; sources: string[]; items: Record<string, any>[] };
/** The open editor's document with ids replaced by position and asset name, and its undo stack. */
const observe = (page: Page): Promise<Obs> => page.evaluate(async () => {
  const ed = '/src/editor.tsx', rt = '/src/timeline/runtime.ts', db = '/src/store/database.ts';
  const { activeSession } = await import(ed), { activeRuntime } = await import(rt), { projectStore } = await import(db);
  const doc = JSON.parse(JSON.stringify(activeSession.document)), names = new Map<string, string>(((await projectStore.library()).assets as { id: string; name: string }[]).map(a => [a.id, a.name]));
  const order = (doc.tracks as { id: string }[]).map(t => t.id);
  return {
    tracks: doc.tracks.map((t: any) => t.kind), duration: doc.duration, labels: activeRuntime.bus.labels() as string[], sources: activeRuntime.bus.undoStack.map((e: any) => e.source as string),
    items: doc.items.map((i: any) => ({ type: i.type, track: order.indexOf(i.trackId), asset: names.get(i.metadata?.assetId) ?? null, from: i.display.from, to: i.display.to, trim: i.trim, rate: i.playbackRate, sourceDuration: i.sourceDuration, properties: i.properties, masks: i.masks, details: i.details, effects: i.effects.map(({ id: _id, ...rest }: any) => rest) })),
  };
});
const library = (page: Page) => page.evaluate(async () => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.library()).assets as any[]).map(a => ({ name: a.name as string, durationMs: a.durationMs as number, demo: a.source?.kind === 'demo' })); });
const leftovers = (page: Page) => page.evaluate(async () => {
  const p = '/src/store/database.ts', { projectStore } = await import(p), projects = (await projectStore.rows('projects')) as any[], demo = projects.filter(r => r.is_demo).map(r => r.id as string);
  const settings = ((await projectStore.rows('settings')) as { id: string }[]).map(r => r.id).filter(id => demo.some(d => id === `history:${d}` || id.startsWith(`journal:${d}:`)));
  return { projects: projects.length, demoProjects: demo.length, demoSettings: settings.length, demoAssets: ((await projectStore.library()).assets as any[]).filter(a => a.source?.kind === 'demo').length };
});

type Staged = { typed: string; user: string; chips: { tool: string; state: string }[]; answer: string; obs: Obs };
type How = 'auto' | 'empty' | string;
/** One scripted turn: wait for the message to be typed (or type our own / nothing), send, wait for the step's answer. */
async function playStep(page: Page, n: number, how: How = 'auto'): Promise<Staged> {
  const input = page.getByRole('textbox', { name: 'Message' }), send = page.getByRole('button', { name: 'Send this message' });
  await expect(input).toBeEnabled({ timeout: 90_000 });
  if (how === 'auto') {
    await expect.poll(async () => { const a = await input.inputValue(); await page.waitForTimeout(400); return a.length > 0 && a === await input.inputValue(); }, { timeout: 30_000 }).toBe(true);
  } else {
    await input.fill('x'); // a real edit, so the auto-typing stops: `fill` can land between two ticks and lose only its first try
    await input.fill(how === 'empty' ? '' : how);
    await page.waitForTimeout(1500); // auto-typing, had it carried on, would have rewritten the field by now
  }
  const typed = await input.inputValue();
  await send.click();
  await expect(page.locator('.demo-bar')).toHaveAttribute('data-done', String(n + 1), { timeout: 90_000 });
  const chipRow = page.locator('.demo-chips').nth(n).locator('li');
  // the chips settle as the answer is posted; a chip that never does is recorded as it stands, and the tests judge it
  await expect.poll(async () => (await chipRow.evaluateAll(els => els.map(e => e.getAttribute('data-state')))).every(x => x === 'done'), { timeout: 5000 }).toBe(true).catch(() => undefined);
  const chips = await page.locator('.demo-chips').nth(n).locator('li').evaluateAll(els => els.map(e => ({ tool: e.textContent ?? '', state: e.getAttribute('data-state') ?? '' })));
  return { typed, user: await page.locator('.demo-turn.user').nth(n).innerText(), chips, answer: await page.locator('.demo-turn.assistant:not(.working)').last().innerText(), obs: await observe(page) };
}
/** Intro → Show me → the editor with the opening line. `load: false` goes on from a page already at the picker. */
async function openDemo(page: Page, load = true) {
  if (load) await page.goto('/onboarding');
  await built(page).click(); await expect(intro(page)).toBeVisible();
  await page.getByRole('button', { name: 'Show me' }).click();
  await expect(page.locator('.demo-turn.assistant').first()).toContainText('Your timeline is empty', { timeout: 90_000 });
}
/** The end state comes with the last answer (findings §28b.3.6), with no click. */
const finish = (page: Page) => expect(page.locator('.demo-top strong')).toHaveText(FINAL_HEADLINE);
/** The Ready page (findings §28b.4): reached, not yet finished — phase `ready`, not completed, still on /onboarding. */
const atReady = async (page: Page) => { await expect(page.getByRole('heading', { name: 'All set' })).toBeVisible(); expect(await stored(page)).toMatchObject({ phase: 'ready', completed: false }); await expect(page).toHaveURL(/\/onboarding$/); };
/** "Open Cutframe" finishes onboarding and goes home. */
const openApp = async (page: Page) => { await page.getByRole('button', { name: 'Open Cutframe' }).click(); await expect(page).toHaveURL(/\/$/); expect(await stored(page)).toMatchObject({ phase: 'ready', completed: true }); };
const leave = async (page: Page) => { await page.locator('.demo-top').getByRole('button', { name: 'Continue' }).click(); await atReady(page); expect(await stored(page)).toMatchObject({ skipped: false }); await openApp(page); };

// ---- the oracle: the plan of §28b.3.2 over the pack's records and the stored durations --------------------------------------
type Lib = { name: string; durationMs: number }[];
function planOf(lib: Lib, edit: (files: PackFile[]) => PackFile[] = f => f) {
  const assets: DemoAsset[] = edit(PACK.files).map(f => ({ id: f.file, type: f.type, name: f.file, durationMs: lib.find(a => a.name === f.file)?.durationMs ?? f.durationMs, rhythm_data: f.rhythm_data, segments: f.segments }));
  const plan = buildPlan(assets), b = cutBoundaries(plan.analysis);
  return { plan, assets, pools: clipPools(assets), intro: b.intro, afterDrop: b.afterDrop };
}
const normal = (o: Obs) => ({ tracks: o.tracks, labels: o.labels, sources: o.sources, items: o.items });

// ---- the two long runs, once per invocation -------------------------------------------------------------------------------
type Run = {
  lib: Lib; demoId: string; defaults: Record<string, unknown>; opening: string; introText: string; obs0: Obs; steps: Staged[]; headline: string; requests: string[];
  exported: ExportRun; after: Awaited<ReturnType<typeof leftovers>> & { url: string; onboarding: any; homeFirstEdit: number };
  offline: { steps: Staged[]; packHits: string[]; requests: string[]; startedUrl: string };
};
const sources = ['src/settings/first-edit/FirstEdit.tsx', 'src/settings/first-edit/script.ts', 'src/settings/first-edit/plan.ts', 'src/settings/first-edit/pack.ts', 'src/settings/first-edit/demos.ts', 'src/settings/OnboardingPage.tsx'].map(f => join(process.cwd(), 'apps', 'web', f));
const cacheFile = () => join(tmpdir(), `t21-fe-run-${process.ppid}-${createHash('sha1').update([...sources, join(process.cwd(), 'tests', 'ui', 't21-first-edit-run.spec.ts')].map(f => (existsSync(f) ? readFileSync(f, 'utf8') : '')).join('\0')).update(String(PACK.files.length)).digest('hex').slice(0, 12)}.json`);

async function execute(browser: Browser, baseURL: string): Promise<Run> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1400, height: 900 } }), page = await context.newPage();
  const requests: string[] = [], leaks = guard(page);
  page.on('request', r => requests.push(r.url()));
  await skipTour(page); await seed(page, AT_PICKER);
  // ---- run 1: online, the pack not yet cached
  await page.goto('/onboarding'); await built(page).click(); await expect(intro(page)).toBeVisible();
  const introText = await page.locator('.demo-intro').innerText();
  await page.getByRole('button', { name: 'Show me' }).click();
  await expect(page.locator('.demo-turn.assistant').first()).toContainText('Your timeline is empty', { timeout: 90_000 });
  const opening = await page.locator('.demo-turn.assistant').first().innerText(), obs0 = await observe(page);
  const steps: Staged[] = [];
  for (let n = 0; n < 3; n++) steps.push(await playStep(page, n));
  await finish(page);
  const headline = await page.locator('.demo-top strong').innerText();
  const lib = await library(page), demoId = await page.evaluate(async () => { const p = '/src/store/database.ts'; return (((await (await import(p)).projectStore.rows('projects')) as any[]).find(r => r.is_demo)).id as string; });
  const defaults = await page.evaluate(async () => { const p = '/src/effects/registry.ts', def = (await import(p)).effectById('ascii'); return Object.fromEntries((def.params as any[]).map(q => [q.key, q.newInstance ?? q.default])); });
  const exported = await runExport(page, demoId, { resolution: '480p' }, "const { activeSession } = await import('/src/editor.tsx'); return { doc: activeSession.document };");
  await leave(page);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  const after = { ...(await leftovers(page)), url: page.url(), onboarding: await stored(page), homeFirstEdit: await page.getByText('First Edit').count() };
  // ---- run 2: the pack is cached; any request for it is refused and counted; other text, then an empty input
  const packHits: string[] = [], mark = requests.length;
  await context.route(url => isPackUrl(url.href), route => { packHits.push(route.request().url()); return route.abort(); });
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), [KEY, AT_PICKER]);
  await openDemo(page);
  const offline: Staged[] = [await playStep(page, 0, 'something else entirely'), await playStep(page, 1, 'empty'), await playStep(page, 2)];
  await finish(page); await leave(page);
  expect(leaks, 'requests that left localhost').toEqual([]);
  await context.close();
  return { lib, demoId, defaults, opening, introText, obs0, steps, headline, requests: requests.slice(0, mark), exported, after, offline: { steps: offline, packHits, requests: requests.slice(mark), startedUrl: '' } };
}
let memo: Promise<Run> | undefined;
const getRun = (browser: Browser, baseURL: string) => memo ??= (async () => {
  const file = cacheFile();
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Run;
  const run = await execute(browser, baseURL);
  writeFileSync(file, JSON.stringify(run));
  return run;
})();

test.describe('the scripted demo, run twice', () => {
  let run: Run;
  test.beforeAll(async ({ browser }) => { test.setTimeout(600_000); run = await getRun(browser, test.info().project.use.baseURL!); });
  const plan = () => planOf(run.lib);
  const secs = (ms: number) => Math.round(ms) / 1000;

  test('PT-FE-05: step 1 puts exactly one audio track with one item at 0 trimmed to the plan\'s source range; the answer has the BPM and the drop as m:ss; chips searchProjectAssets then addMedia, done', () => {
    const { plan: p } = plan(), s = run.steps[0], music = p.music!;
    expect(run.obs0.tracks).toEqual([]); expect(run.obs0.items).toEqual([]);
    expect(s.obs.tracks).toEqual(['audio']);
    expect(s.obs.items).toHaveLength(1);
    const item = s.obs.items[0];
    expect(item).toMatchObject({ type: 'audio', track: 0, asset: music.name, from: 0, trim: { from: 0 } });
    expect(item.trim.to).toBe(Math.round(Math.min(p.sourceEnd, run.lib.find(a => a.name === music.name)!.durationMs)));
    expect(item.to).toBe(item.trim.to);
    expect(p.analysis.bpm).toBe(128);
    expect(s.answer).toContain(`${Math.round(p.analysis.bpm!)} BPM`);
    expect(s.answer).toContain(clock(p.analysis.drop));
    expect(s.chips).toEqual([{ tool: 'searchProjectAssets', state: 'done' }, { tool: 'addMedia', state: 'done' }]);
    expect(s.obs.labels).toEqual(['Create track', 'Add media']);
  });

  test('PT-FE-06: step 2 puts exactly one video track whose items are gapless from 0, one per plan segment, every cut on a plan beat (±1 frame)', () => {
    const { plan: p } = plan(), s = run.steps[1], items = s.obs.items.filter(i => i.type === 'video');
    expect(s.obs.tracks).toEqual(['audio', 'video']);
    expect(s.obs.tracks.filter(t => t === 'video')).toHaveLength(1);
    expect(p.skipped).toBe(0);
    expect(items).toHaveLength(p.cuts.length);
    expect(items.length).toBe(p.boundaries.length - 1);
    expect(items[0].from).toBe(0);
    items.forEach((it, n) => {
      if (n) expect(it.from, `item ${n} starts where item ${n - 1} ends`).toBe(items[n - 1].to);
      expect(Math.abs(it.to - p.boundaries[n + 1]), `boundary ${n + 1}`).toBeLessThanOrEqual(FRAME);
      expect(it.track).toBe(1);
    });
    expect(s.chips).toEqual([{ tool: 'loadSkill', state: 'done' }, { tool: 'addMedia', state: 'done' }]);
    expect(s.answer).toContain(`${items.length} cuts.`);
    expect(s.obs.labels).toEqual(['Create track', 'Add media', 'Create track', 'Add media']);
  });

  test('PT-FE-06: pools — a scenic intro, slow-motion clips on post-drop segments of at least 1.8 beats, no clip twice in a row', () => {
    const { plan: p, pools, intro: introCuts, afterDrop } = plan(), items = run.steps[1].obs.items.filter(i => i.type === 'video');
    const scenic = new Set(pools.scenic.map(a => a.name)), slowmo = new Set(pools.slowmo.map(a => a.name));
    expect(scenic.size).toBeGreaterThan(1); expect(slowmo.size).toBeGreaterThan(0); expect(pools.action.length).toBeGreaterThan(1);
    expect(introCuts).toBeGreaterThan(0);
    items.forEach((it, n) => {
      if (n < introCuts) expect(scenic.has(it.asset), `intro item ${n} is scenic (${it.asset})`).toBe(true);
      const beats = (it.to - it.from) / p.analysis.interval;
      if (n >= afterDrop && beats >= 1.8) expect(slowmo.has(it.asset), `post-drop item ${n} of ${beats.toFixed(2)} beats is slow motion (${it.asset})`).toBe(true);
      if (n) expect(it.asset, `item ${n} differs from item ${n - 1}`).not.toBe(items[n - 1].asset);
    });
    expect(items.some((it, n) => n >= afterDrop && slowmo.has(it.asset))).toBe(true);
  });

  test('PT-FE-06: each clip is at least its segment plus 80 ms, and per-clip trims advance and wrap', () => {
    const items = run.steps[1].obs.items.filter(i => i.type === 'video'), read = new Map<string, number>();
    for (const [n, it] of items.entries()) {
      const length = it.to - it.from, dur = run.lib.find(a => a.name === it.asset)!.durationMs;
      expect(dur, `item ${n} (${it.asset}) is long enough`).toBeGreaterThanOrEqual(length + 80);
      expect(it.trim.to - it.trim.from, `item ${n} trim length`).toBe(length);
      const before = read.get(it.asset) ?? 0, expected = dur - before >= length + 80 ? before : 0;
      expect(it.trim.from, `item ${n} (${it.asset}) continues at ${before} or wraps to 0`).toBe(expected);
      expect(it.trim.to).toBeLessThanOrEqual(dur);
      read.set(it.asset, it.trim.to);
    }
    expect([...read.values()].length, 'more than one clip is used').toBeGreaterThan(3);
    const repeated = [...items.reduce((m, it) => m.set(it.asset, (m.get(it.asset) ?? 0) + 1), new Map<string, number>()).values()];
    expect(Math.max(...repeated), 'at least one clip is used more than once, so a trim advances').toBeGreaterThan(1);
  });

  test('PT-FE-07: step 3 gives every montage item exactly one ascii effect with the registry defaults and the music none', () => {
    const items = run.steps[2].obs.items, video = items.filter(i => i.type === 'video'), music = items.filter(i => i.type === 'audio');
    expect(video.length).toBeGreaterThan(0); expect(music).toHaveLength(1);
    expect(music[0].effects).toEqual([]);
    const expected = Object.fromEntries(Object.entries(run.defaults).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }]));
    expect(Object.keys(expected).length).toBeGreaterThan(4);
    for (const [n, it] of video.entries()) {
      expect(it.effects, `item ${n}`).toHaveLength(1);
      expect(it.effects[0], `item ${n}`).toMatchObject({ effectId: 'ascii', enabled: true, order: 0, parameters: expected });
    }
    expect(run.steps[2].chips).toEqual([{ tool: 'writeEffects', state: 'done' }]);
    expect(run.steps[2].answer).toMatch(/^One request changed the look of every clip\./);
    expect(run.steps[2].obs.labels).toEqual(['Create track', 'Add media', 'Create track', 'Add media', 'Edit items']);
    expect(run.steps[1].obs.items.filter(i => i.type === 'video').every(i => i.effects.length === 0), 'step 2 left the look to step 3').toBe(true);
  });

  test('PT-FE-07: every edit is an "agent" undo entry (the same path an agent tool call takes)', () => {
    expect(run.steps[2].obs.sources).toEqual(['agent', 'agent', 'agent', 'agent', 'agent']);
  });

  for (const via of ['by hand', 'through the agent tools'] as const) {
    test(`PT-FE-07: the project JSON and undo history equal what the same commands give ${via} (promise 2)`, async ({ page, baseURL }) => {
      test.setTimeout(240_000);
      const leaks = guard(page); await skipTour(page);
      const cuts = plan().plan.cuts, music = plan().plan.music!, p = plan().plan;
      const id = await replayProject(page);
      const assetOf = await assetIds(page);
      const args = {
        music: { assetId: assetOf(music.name), trimStart: 0, trimEnd: secs(Math.min(p.sourceEnd, run.lib.find(a => a.name === music.name)!.durationMs)) },
        montage: cuts.map(c => ({ assetId: assetOf(c.assetId), trimStart: secs(c.trimStart), trimEnd: secs(c.trimEnd) })),
      };
      let tidy: () => unknown = () => undefined;
      if (via === 'by hand') {
        await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
        await page.waitForFunction(async () => { const m = '/src/timeline/runtime.ts'; return !!(await import(m)).activeRuntime; });
        await page.evaluate(async ({ args }) => {
          const m = '/src/timeline/runtime.ts', { activeRuntime } = await import(m), call = (t: string, a: Record<string, unknown>) => { const r = activeRuntime!.call(t, a); if (!r.success) throw new Error(`${t}: ${JSON.stringify(r)}`); return r.data as any; };
          const a = call('manageTrack', { action: 'create', kind: 'audio' }).track.id;
          call('addMedia', { trackId: a, timelineStart: 0, items: [args.music] });
          const v = call('manageTrack', { action: 'create', kind: 'video' }).track.id;
          call('addMedia', { trackId: v, timelineStart: 0, items: args.montage });
          const ids = (activeRuntime!.bus.doc.items as any[]).filter(i => i.type === 'video').map(i => i.id as string);
          call('writeEffects', { itemIds: ids, add: [{ effectId: 'ascii' }] });
        }, { args });
      } else {
        const configDir = mkdtempSync(join(tmpdir(), 't21-fe-agent-'));
        const helper = await startHelper({ port: 0, log: () => {}, configDir, allowOrigins: [baseURL!], quietMs: 100 });
        const token = newToken(); helper.store.add(token);
        await page.evaluate(t => new Promise<void>(resolve => {
          const open = indexedDB.open('cutframe-agent', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('kv');
          open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(t, 'token'); tx.oncomplete = () => { db.close(); resolve(); }; };
        }), token);
        await page.addInitScript(({ key, port }) => { try { localStorage.setItem(key, JSON.stringify({ port, auto: true })); } catch { /* storage unavailable */ } }, { key: LINK_KEY, port: helper.port });
        await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
        await expect(page.getByTestId('agent-link-badge')).toHaveAttribute('data-status', 'connected');
        const client = new Client({ name: 't21-first-edit', version: '0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${helper.port}/mcp`)));
        tidy = async () => { await client.close(); await helper.close(); rmSync(configDir, { recursive: true, force: true }); };
        const tool = async (name: string, a: Record<string, unknown>) => {
          const r = await client.callTool({ name, arguments: a }) as { isError?: boolean; content: { text: string }[] };
          const body = JSON.parse(r.content[0].text) as { success: boolean; data: any };
          expect(r.isError ?? false, `${name}: ${r.content[0].text.slice(0, 300)}`).toBe(false); expect(body.success).toBe(true);
          return body.data;
        };
        await tool('context', {}); // the stale-read gate: the timeline has to have been read in this MCP session
        const a = (await tool('manageTrack', { action: 'create', kind: 'audio' })).track.id;
        await tool('addMedia', { trackId: a, timelineStart: 0, items: [args.music] });
        const v = (await tool('manageTrack', { action: 'create', kind: 'video' })).track.id;
        const added = await tool('addMedia', { trackId: v, timelineStart: 0, items: args.montage });
        await tool('writeEffects', { itemIds: added.addedItemIds, add: [{ effectId: 'ascii' }] });
      }
      try {
        const got = normal(await observe(page)), want = normal(run.steps[2].obs);
        expect(got.labels).toEqual(want.labels); expect(got.sources).toEqual(want.sources);
        expect(got.tracks).toEqual(want.tracks);
        expect(got.items.length).toBe(want.items.length);
        got.items.forEach((it, n) => expect(it, `item ${n}`).toEqual(want.items[n]));
      } finally { await tidy(); }
      expect(leaks, 'requests that left localhost').toEqual([]);
    });
  }

  test('PT-FE-08: other typed text stops the auto-typing and sends the scripted message anyway; an empty input also sends; the same edit results', () => {
    const online = run.steps, off = run.offline.steps;
    expect(off[0].typed).toBe('something else entirely');
    expect(off[0].user, 'the scripted message is posted, not the typed text').toBe(online[0].typed);
    expect(off[1].typed).toBe('');
    expect(off[1].user).toBe(online[1].typed);
    expect(off[2].user).toBe(online[2].typed);
    expect(online.map(s => s.typed).every(t => t.length > 10)).toBe(true);
    for (const n of [0, 1, 2]) expect(off[n].answer, `answer ${n}`).toBe(online[n].answer);
    expect(normal(off[2].obs)).toEqual(normal(online[2].obs));
  });

  test('PT-FE-10: with no provider and the cached pack blocked, the full demo runs: no pack request, no request beyond the app, the same timeline JSON', ({ baseURL }) => {
    expect(run.offline.packHits, 'the cached pack was not fetched again').toEqual([]);
    const own = new URL(baseURL!).host, all = [...run.requests, ...run.offline.requests].filter(u => !/^(blob|data):/.test(u));
    expect(all.filter(u => new URL(u).host !== own && !/^127\.0\.0\.1:478\d$/.test(new URL(u).host)), 'no request beyond the app (and the helper probe)').toEqual([]);
    expect(all.filter(u => !u.includes('/src/') && /\/(v1\/|chat\/completions|messages$|generateContent|api\/chat)/.test(new URL(u).pathname)), 'no request to any model endpoint').toEqual([]);
    expect(run.offline.steps).toHaveLength(3);
    expect(run.offline.steps.map(s => s.chips.every(c => c.state === 'done'))).toEqual([true, true, true]);
    const a = run.offline.steps[2].obs, b = run.steps[2].obs;
    expect(a.items.length).toBe(b.items.length); expect(normal(a)).toEqual(normal(b));
    expect(run.offline.steps[0].answer).toContain('128 BPM');
  });

  test('PT-FE-11: the demo ends on Continue at Ready, and afterwards the home list shows no demo project and the library no demo assets', () => {
    expect(run.headline).toBe(FINAL_HEADLINE);
    expect(run.after.url).toMatch(/\/$/);
    expect(run.after.onboarding).toMatchObject({ phase: 'ready', completed: true, skipped: false });
    expect(run.after.homeFirstEdit, 'the home list does not show the demo project').toBe(0);
    expect(run.after.demoProjects, 'the demo project is deleted').toBe(0);
    expect(run.after.demoAssets, 'no demo assets are left in the library').toBe(0);
    expect(run.after.demoSettings, 'no demo undo history or journal rows are left').toBe(0);
  });

  test('PT-FE-12: the export of the finished demo completes at 480p and is as long as the timeline', async () => {
    test.skip(!ffmpegAvailable(), 'ffmpeg decodes the exported file');
    expect(run.exported.status, `${run.exported.error?.code}: ${run.exported.error?.detail ?? run.exported.error?.message}`).toBe('completed');
    const total = run.steps[2].obs.duration, v = streams(run.exported.file!).find(s => s.codec_type === 'video');
    const size = run.exported.result!.size as { width: number; height: number };
    expect([Math.max(size.width, size.height), Math.min(size.width, size.height)], '480p: long edge 854, short edge 480').toEqual([854, 480]);
    expect(run.exported.result!.fps).toBe(FPS);
    expect(Math.abs(Number(v.duration) * 1000 - total)).toBeLessThanOrEqual(FRAME);
  });

  test('PT-FE-12: the cuts in the exported file are within one frame of the plan\'s, and the ASCII look is visible in a frame of every cut', async () => {
    test.skip(!ffmpegAvailable(), 'ffmpeg decodes the exported file');
    expect(run.exported.status).toBe('completed');
    const { plan: p } = plan(), { width: W, height: H } = run.exported.result!.size as { width: number; height: number }, frames = decodeRgba(run.exported.file!, W, H), bounds = p.boundaries;
    expect(frames.length).toBeGreaterThanOrEqual(Math.floor(bounds[bounds.length - 1] / FRAME) - 1);
    const diff = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i += 16) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length / 16); };
    const d = frames.map((f, n) => n ? diff(f, frames[n - 1]) : 0);
    const cuts = bounds.slice(1, -1).map(t => Math.round(t / FRAME)); // the first frame of the next clip
    const biggest = (lo: number, hi: number) => { let at = lo; for (let n = lo; n <= hi; n++) if (d[n] > d[at]) at = n; return at; };
    // the strongest change within ±1 frame of each planned cut is where the cut is; it must stand out from the segment's own motion
    const typical = [...d.slice(1)].sort((a, b) => a - b)[Math.floor(d.length / 2)];
    for (const [n, frame] of cuts.entries()) {
      const at = biggest(frame - 1, frame + 1);
      expect(d[at], `cut ${n + 1} at ${bounds[n + 1]} ms (frame ${frame}) shows as a change`).toBeGreaterThan(typical * 1.5);
    }
    // and no other change is as strong as the weakest cut by a wide margin: the cuts are where the file changes
    const weakest = Math.min(...cuts.map(frame => d[biggest(frame - 1, frame + 1)]));
    const stray = d.map((v, n) => ({ v, n })).filter(({ v, n }) => v > weakest * 1.5 && !cuts.some(c => Math.abs(c - n) <= 1));
    expect(stray, 'no change stronger than the weakest cut outside a planned cut').toEqual([]);
    // the look: the middle frame of every segment is two-level and grey, with glyph pixels, not the footage's colour
    for (let n = 0; n + 1 < bounds.length; n++) {
      const f = frames[Math.min(frames.length - 1, Math.round((bounds[n] + bounds[n + 1]) / 2 / FRAME))];
      let grey = 0, dark = 0, bright = 0;
      for (let i = 0; i < f.length; i += 4) { const hi = Math.max(f[i], f[i + 1], f[i + 2]), lo = Math.min(f[i], f[i + 1], f[i + 2]); if (hi - lo <= 24) grey++; if (hi < 60) dark++; if (lo > 150) bright++; }
      const px = f.length / 4;
      expect(grey / px, `segment ${n}: mono`).toBeGreaterThan(.97);
      expect(dark / px, `segment ${n}: dark background`).toBeGreaterThan(.35);
      expect(bright / px, `segment ${n}: glyph pixels`).toBeGreaterThan(.002);
    }
  });

  test('PT-FE-12: the exported audio ends at the last boundary and carries the song', async () => {
    test.skip(!ffmpegAvailable(), 'ffmpeg decodes the exported file');
    expect(run.exported.status).toBe('completed');
    const { plan: p } = plan(), last = p.boundaries[p.boundaries.length - 1], media = streams(run.exported.file!), a = media.find(s => s.codec_type === 'audio'), v = media.find(s => s.codec_type === 'video');
    expect(a, 'an audio stream').toBeDefined();
    // the video ends on the boundary (±1 frame) and the audio on the video by the export's own rule (T16a EX-P05): under one AAC frame, or one video frame for Opus
    expect(Math.abs(Number(v.duration) * 1000 - last), 'video ends at the last boundary').toBeLessThanOrEqual(FRAME);
    const gap = (Number(a.duration) - Number(v.duration)) * 1000;
    expect(gap, 'audio does not stop before the video').toBeGreaterThanOrEqual(0);
    expect(gap, 'audio outlasts the video only by encoder framing').toBeLessThanOrEqual(a.codec_name === 'aac' ? 21.4 : FRAME);
    const { left } = decodePcm(run.exported.file!), at = (s: number) => Math.floor(s * 48000), rms = (from: number, to: number) => { let t = 0; for (let i = from; i < to; i++) t += left[i] * left[i]; return Math.sqrt(t / Math.max(1, to - from)); };
    expect(rms(at(1), at(3)), 'sound at the start').toBeGreaterThan(.005);
    expect(rms(at(last / 1000 - 1), at(last / 1000 - .1)), 'sound up to the end').toBeGreaterThan(.005);
    expect(ff('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', run.exported.file!]).trim().split(/\s+/).sort()).toEqual(['audio', 'video']);
  });
});

// ---- a project holding the pack's assets, for the by-hand and agent-tool replays -------------------------------------------
async function replayProject(page: Page) {
  await page.goto('/');
  return page.evaluate(async () => {
    const pk = '/src/settings/first-edit/pack.ts', ing = '/src/media/ingest.ts', db = '/src/store/database.ts';
    const { loadPack } = await import(pk), { uploadToProject } = await import(ing), { projectStore } = await import(db);
    const { files } = await loadPack(), record = await projectStore.create('First Edit replay'), preparing: Promise<unknown>[] = [];
    for (const file of files) preparing.push(...(await uploadToProject(projectStore, record.id, [file], {})).preparing);
    await Promise.all(preparing);
    return record.id as string;
  });
}
async function assetIds(page: Page) {
  const rows = await page.evaluate(async () => { const p = '/src/store/database.ts'; return ((await (await import(p)).projectStore.library()).assets as { id: string; name: string }[]).map(a => [a.name, a.id]); });
  const map = new Map(rows as [string, string][]);
  return (name: string) => { const id = map.get(name); if (!id) throw new Error(`no asset ${name}`); return id; };
}

// ---- PT-FE-09 · soft failures ---------------------------------------------------------------------------------------------
type Fault = {
  edit?: (files: PackFile[]) => PackFile[]; clock?: boolean; durations?: number;
  /** Runs in the page once the editor is open; patches the runtime's call. */
  patch?: string;
};
async function faulty(page: Page, fault: Fault) {
  const leaks = guard(page); await skipTour(page); await seed(page, AT_PICKER);
  if (fault.clock) await page.clock.install();
  if (fault.edit) {
    const edit = fault.edit;
    await page.route(url => isPackJson(url.href), async route => { const body = await (await route.fetch()).json() as { files: PackFile[] }; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...body, files: edit(body.files) }) }); });
  }
  if (fault.durations) {
    const ms = fault.durations;
    await page.addInitScript(ms => { (window as unknown as { __shortVideos: number }).__shortVideos = ms; }, ms);
    await page.goto('/onboarding');
    await page.evaluate(async () => {
      const p = '/src/store/database.ts', { projectStore } = await import(p), row = projectStore.row.bind(projectStore);
      projectStore.row = async (table: string, id: string) => { const r = await row(table, id) as any; return table === 'assets' && r && r.type === 'video' ? { ...r, durationMs: (window as unknown as { __shortVideos: number }).__shortVideos } : r; };
    });
  }
  await openDemo(page, !fault.durations); // the patched store lives in the page, so do not reload it
  if (fault.patch) await page.evaluate(async code => {
    const m = '/src/timeline/runtime.ts', { activeRuntime } = await import(m), real = activeRuntime!.call.bind(activeRuntime);
    // eslint-disable-next-line no-new-func
    activeRuntime!.call = new Function('real', `return (${code})`)(real);
  }, fault.patch);
  return leaks;
}
async function throughSteps(page: Page, clockFast?: (n: number) => Promise<void>) {
  const out: Staged[] = [];
  for (let n = 0; n < 3; n++) { if (clockFast) await clockFast(n); out.push(await playStep(page, n)); }
  return out;
}
const lib = (): Lib => PACK.files.map(f => ({ name: f.file, durationMs: f.durationMs }));

test.describe('PT-FE-09 · soft failures', () => {
  test.setTimeout(240_000);
  async function reachesEnd(page: Page, leaks: string[]) {
    await finish(page); await leave(page);
    expect(await stored(page)).toMatchObject({ phase: 'ready', completed: true });
    expect(leaks, 'requests that left localhost').toEqual([]);
  }

  test('PT-FE-09 (W3, no beats): a song with no beat data gives the synthetic grid without a word — no BPM in the answer, the drop at 0:08, the cuts on the 0.5 s grid', async ({ page }) => {
    const strip = (files: PackFile[]) => files.map(f => f.type === 'audio' ? { ...f, rhythm_data: { ...f.rhythm_data, beats: undefined, pulseBeats: undefined, onsets: undefined }, segments: [] } : f);
    const leaks = await faulty(page, { edit: strip });
    const steps = await throughSteps(page), want = planOf(lib(), strip).plan;
    expect(want.boundaries).toEqual([0, 2000, 4000, 5000, 6000, 6500, 7000, 7500, 8000, 8500, 9000, 10000, 10500, 11000, 13000, 13500, 14000, 15000, 15500, 16000, 18000, 18500, 19000, 20000]);
    expect(steps[0].answer).not.toMatch(/BPM/); expect(steps[0].answer).toContain('0:08'); expect(steps[0].obs.items).toHaveLength(1);
    expect(steps[0].obs.items[0].trim.to).toBe(20_000);
    const video = steps[1].obs.items.filter(i => i.type === 'video');
    expect(video.map(i => i.to)).toEqual(want.boundaries.slice(1));
    expect(steps[2].obs.items.filter(i => i.effects.length === 1)).toHaveLength(video.length);
    await reachesEnd(page, leaks);
  });

  test('PT-FE-09 (W4, no audio): step 1 gives its no-track fallback, no audio track is made, the montage is still built on the synthetic grid', async ({ page }) => {
    const noAudio = (files: PackFile[]) => files.filter(f => f.type === 'video');
    const leaks = await faulty(page, { edit: noAudio });
    const steps = await throughSteps(page), want = planOf(lib(), noAudio).plan;
    expect(steps[0].answer).toMatch(/would not go on/);
    expect(steps[0].chips.map(c => c.state)).toEqual(['done', 'done']);
    expect(steps[0].obs.items).toEqual([]);
    expect(steps[1].obs.tracks).toEqual(['video']);
    expect(steps[1].obs.items.map(i => i.to)).toEqual(want.boundaries.slice(1));
    expect(steps[1].answer).toContain(`${want.cuts.length} cuts.`);
    expect(steps[2].obs.items.every(i => i.effects.length === 1)).toBe(true);
    await reachesEnd(page, leaks);
  });

  test('PT-FE-09 (W5, no video): step 2 and step 3 give their fallbacks, nothing is placed after the music, and the demo reaches the end', async ({ page }) => {
    const leaks = await faulty(page, { edit: files => files.filter(f => f.type === 'audio') });
    const steps = await throughSteps(page);
    expect(steps[0].obs.items).toHaveLength(1);
    expect(steps[1].answer).toMatch(/montage didn.t work/);
    expect(steps[1].obs.tracks).toEqual(['audio']); expect(steps[1].obs.items).toHaveLength(1);
    expect(steps[2].answer).toMatch(/timeline is yours from here/);
    expect(steps[2].obs.items).toHaveLength(1); expect(steps[2].obs.items[0].effects).toEqual([]);
    expect(steps.every(s => s.chips.every(c => c.state === 'done'))).toBe(true);
    await reachesEnd(page, leaks);
  });

  test('PT-FE-09 (W6, batch fail): when the montage batch is refused, step 2 gives its fallback, step 3 the no-montage answer, and the demo reaches the end', async ({ page }) => {
    const leaks = await faulty(page, { patch: "(tool, args) => tool === 'addMedia' && args.items.length > 1 ? { success: false, code: 'ADD_FAILED', error: 'refused' } : real(tool, args)" });
    const steps = await throughSteps(page);
    expect(steps[0].obs.items).toHaveLength(1);
    expect(steps[1].answer).toMatch(/montage didn.t work/);
    expect(steps[1].obs.items.filter(i => i.type === 'video')).toEqual([]);
    expect(steps[2].answer).toMatch(/timeline is yours from here/);
    expect(steps[2].obs.items).toHaveLength(1);
    await reachesEnd(page, leaks);
  });

  test('PT-FE-09 (W7, short clips): segments no clip is long enough for are dropped, the answer says how many, and the later cuts move up onto the beat with no gap', async ({ page }) => {
    const leaks = await faulty(page, { durations: 1000 });
    const steps = await throughSteps(page), short = lib().map(a => a.name.endsWith('.webm') ? { ...a, durationMs: 1000 } : a);
    const want = planOf(short).plan, items = steps[1].obs.items.filter(i => i.type === 'video'), song = steps[1].obs.items.find(i => i.type === 'audio')!;
    expect(want.skipped).toBeGreaterThan(0); expect(want.cuts.length).toBeGreaterThan(0);
    expect(items).toHaveLength(want.cuts.length);
    expect(items[0].from).toBe(0);
    items.forEach((it, n) => {
      if (n) expect(it.from, `item ${n} starts where item ${n - 1} ends`).toBe(items[n - 1].to);
      expect(Math.abs(it.to - want.boundaries[n + 1]), `boundary ${n + 1}`).toBeLessThanOrEqual(FRAME);
      expect(want.analysis.beats, `boundary ${n + 1} is a beat of the song`).toContain(want.boundaries[n + 1]);
    });
    expect(song.trim.to, 'the music ends with the montage').toBe(Math.round(want.boundaries[want.boundaries.length - 1]));
    expect(steps[1].answer).toContain(`${want.cuts.length} cuts. ${want.skipped} ${want.skipped === 1 ? 'segment' : 'segments'} had no clip long enough, so the rest were moved up onto the beat.`);
    expect(steps[2].obs.items.filter(i => i.type === 'video').every(i => i.effects.length === 1)).toBe(true);
    await reachesEnd(page, leaks);
  });

  test('PT-FE-09 (W8, effect fail): a clip that refuses the effect keeps none and the answer counts only the clips that took it', async ({ page }) => {
    const leaks = await faulty(page, { patch: "(() => { let n = 0; return (tool, args) => tool === 'writeEffects' ? (args.itemIds ? { success: false, code: 'EFFECT_FAILED', error: 'refused' } : (n++ % 2 ? { success: false, code: 'EFFECT_FAILED', error: 'refused' } : real(tool, args))) : real(tool, args); })()" });
    const steps = await throughSteps(page), video = steps[2].obs.items.filter(i => i.type === 'video'), styled = video.filter(i => i.effects.length === 1);
    expect(styled.length).toBeGreaterThan(0); expect(styled.length).toBeLessThan(video.length);
    expect(video.filter(i => i.effects.length > 1)).toEqual([]);
    expect(steps[2].answer).toContain(`${styled.length} of ${video.length} clips took the new look.`);
    expect(steps[2].answer).not.toMatch(/changed the look of every clip/);
    await reachesEnd(page, leaks);
  });

  test('PT-FE-09 (W9, 20 s timeout, fake clock): an operation that never answers times out after 20 s, its chip turns done, the answer follows and the demo reaches the end', async ({ page }) => {
    const leaks = await faulty(page, { clock: true, patch: "(tool, args) => tool === 'addMedia' && args.items.length === 1 && !args.items[0].effects ? new Promise(() => {}) : real(tool, args)" });
    const input = page.getByRole('textbox', { name: 'Message' });
    await expect(input).toBeEnabled({ timeout: 90_000 });
    await page.clock.runFor(4000); // the message types itself
    await page.getByRole('button', { name: 'Send this message' }).click();
    const chips = page.locator('.demo-chips').first().locator('li');
    await expect(chips.nth(1)).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
    await page.clock.runFor(10_000);
    await expect(chips.nth(1), 'not done at 10 s').toHaveAttribute('data-state', 'running');
    await page.clock.runFor(11_000);
    await expect(chips.nth(1), 'done after the 20 s timeout').toHaveAttribute('data-state', 'done');
    await expect(page.locator('.demo-bar')).toHaveAttribute('data-done', '1');
    await expect(page.locator('.demo-turn.assistant:not(.working)').last()).toContainText('would not go on');
    expect((await observe(page)).items).toEqual([]);
    // the rest of the demo carries on
    for (let n = 1; n < 3; n++) {
      await expect(input).toBeEnabled({ timeout: 60_000 });
      await page.clock.runFor(4000);
      await page.getByRole('button', { name: 'Send this message' }).click();
      await expect(async () => { await page.clock.runFor(1500); expect(await page.locator('.demo-bar').getAttribute('data-done')).toBe(String(n + 1)); }).toPass({ timeout: 60_000 });
    }
    await reachesEnd(page, leaks);
  });
});

// ---- §28b.1.4 and §28b.3.6 · the headline and the end state --------------------------------------------------------------------
test.describe('the headline and the end state', () => {
  test.setTimeout(240_000);
  test('the top bar shows each step’s headline, the end state comes with the last answer and no click, and the dock’s Continue reaches Ready as completed', async ({ page }) => {
    const leaks = guard(page); await skipTour(page); await seed(page, AT_PICKER);
    await openDemo(page);
    const top = page.locator('.demo-top strong');
    await expect(top).toHaveText('The music goes in first.');
    await playStep(page, 0);
    await expect(top).toHaveText('Now a montage, cut to the beat.');
    await playStep(page, 1);
    await expect(top).toHaveText('One new look for every clip.');
    await expect(page.locator('.demo-confetti')).toHaveCount(0);
    await playStep(page, 2);
    await expect(top).toHaveText(FINAL_HEADLINE);
    await expect(page.locator('.demo-confetti i')).toHaveCount(28);
    await expect(page.locator('.demo-top').getByRole('button', { name: 'Skip demo' })).toHaveCount(0);
    await expect(page.locator('.demo-top').getByRole('button', { name: 'Continue' })).toBeVisible();
    await page.locator('.demo-continue').click();
    await atReady(page);
    expect(await stored(page)).toMatchObject({ skipped: false });
    expect(leaks).toEqual([]);
  });
});

// ---- PT-FE-11 · exit and clean-up ------------------------------------------------------------------------------------------
test.describe('PT-FE-11 · exit and clean-up', () => {
  test.setTimeout(240_000);
  const prepare = async (page: Page) => { const leaks = guard(page); await skipTour(page); await seed(page, AT_PICKER); return leaks; };
  const skipDemo = async (page: Page) => { await page.locator('.demo-top').getByRole('button', { name: 'Skip demo' }).click(); await atReady(page); expect(await stored(page)).toMatchObject({ skipped: true }); };

  test('PT-FE-11: Skip demo while the demo is still being set up reaches Ready', async ({ page }) => {
    const leaks = await prepare(page);
    await page.route(url => isPackJson(url.href), async route => { await new Promise(r => setTimeout(r, 4000)); await route.continue(); });
    await page.goto('/onboarding'); await built(page).click(); await expect(intro(page)).toBeVisible();
    await page.getByRole('button', { name: 'Show me' }).click();
    await expect(page.getByText('Setting up the demo…')).toBeVisible();
    await page.getByRole('button', { name: 'Skip demo' }).click();
    await atReady(page); expect(await stored(page)).toMatchObject({ skipped: true }); await openApp(page);
    expect(leaks).toEqual([]);
  });

  test('PT-FE-11 (setup timeout, fake clock): a setup that never finishes stops after 120 s with its own message; Continue reaches Ready as skipped, and a new entry is not stuck behind it', async ({ page }) => {
    const leaks = await prepare(page);
    await page.clock.install();
    let held = true;
    await page.route(url => isPackJson(url.href), route => held ? undefined : route.continue()); // never answered while held
    await page.goto('/onboarding'); await built(page).click(); await expect(intro(page)).toBeVisible();
    await page.getByRole('button', { name: 'Show me' }).click();
    await expect(page.getByText('Setting up the demo…')).toBeVisible();
    await page.clock.pauseAt(new Date(Date.now() + 1000)); // from here only runFor moves it
    await page.clock.runFor(110_000);
    await expect(page.getByText('Setting up the demo…'), 'still waiting before the limit').toBeVisible();
    await page.clock.runFor(12_000);
    await expect(page.getByRole('heading', { name: 'The demo could not start' })).toBeVisible();
    await expect(page.getByText('The demo took too long to set up.')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    held = false;
    await page.clock.resume();
    await built(page).click(); await expect(intro(page)).toBeVisible();
    await expect.poll(() => leftovers(page), { timeout: 90_000 }).toMatchObject({ demoProjects: 1 });
    expect(leaks).toEqual([]);
  });

  for (const after of [0, 1, 2]) {
    test(`PT-FE-11: Skip demo before step ${after + 1} (after ${after} sent) reaches Ready and removes the demo project, its assets and its history`, async ({ page }) => {
      const leaks = await prepare(page);
      await openDemo(page);
      for (let n = 0; n < after; n++) await playStep(page, n);
      await skipDemo(page);
      await expect.poll(() => leftovers(page), { timeout: 20_000 }).toMatchObject({ demoProjects: 0, demoAssets: 0, demoSettings: 0 });
      expect(leaks).toEqual([]);
    });
  }

  test('PT-FE-11: a reload in the middle of the demo restarts at the intro, with a new demo project and none of the first run\'s edits', async ({ page }) => {
    const leaks = await prepare(page);
    await openDemo(page);
    await playStep(page, 0);
    const before = await page.evaluate(async () => { const p = '/src/store/database.ts'; return (((await (await import(p)).projectStore.rows('projects')) as any[]).filter(r => r.is_demo).map(r => r.id)) as string[]; });
    await page.reload();
    await expect(intro(page)).toBeVisible();
    expect(await stored(page)).toMatchObject({ phase: 'first-edit', completed: false });
    await page.getByRole('button', { name: 'Show me' }).click();
    await expect(page.locator('.demo-turn.assistant').first()).toContainText('Your timeline is empty', { timeout: 90_000 });
    const o = await observe(page);
    expect(o.items).toEqual([]); expect(o.tracks).toEqual([]); expect(o.labels).toEqual([]);
    const now = await page.evaluate(async () => { const p = '/src/store/database.ts'; return (((await (await import(p)).projectStore.rows('projects')) as any[]).filter(r => r.is_demo).map(r => r.id)) as string[]; });
    expect(now.length).toBeGreaterThan(0);
    for (const id of before) expect(now, 'the first run\'s demo project is gone').not.toContain(id);
    expect(leaks).toEqual([]);
  });
});
