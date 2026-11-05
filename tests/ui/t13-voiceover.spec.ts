// SPDX-License-Identifier: AGPL-3.0-only
// T13 Voice Over panel in the browser. Oracle: Xapp findings part 2 §30 (states idle → requesting → blocked | countdown 3 s → recording → finalizing → idle;
// Stop pauses playback; auto-stop at the timeline's end within 50 ms; Discard throws the take away; one "Add items" entry; toast "Added <agentId> to the timeline";
// item metadata {assetId, agentId, isVoiceover true, isProxy false}; parity test: a 4.2 s take at playhead 10 s → one audio item at 10 000–14 200 ms ±1 frame).
// The microphone is Chromium's fake device (--use-fake-device-for-media-stream); no real microphone is used.
// Review n5 / m1 (9, 10): the item is as long as the stored take (T14's probe); the take's transcript row is stored within 10 s
// of Stop (T13 ledger row 30), with T19's model stubbed in the page (with the real models the time is T19's; see the T13 notes).
import { expect, test, type Page } from '@playwright/test';
import { assetCount, intents, notices, openEditor, setViewState, skipTour, watchIntents, type Logged } from './t02-support';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test.setTimeout(60_000);

const track = (id: string, name: string, kind: string) => ({ id, name, kind, muted: false, solo: false, locked: false, hidden: false, volume: 1 });
/** One video track V1 and a text clip on O1 for the whole `durationMs`; no audio track. */
const doc = (durationMs: number) => ({
  schemaVersion: 4, rev: 0, groups: {}, duration: durationMs, fps: 30, size: { width: 1280, height: 720 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: [track('v1', 'V1', 'video'), track('o1', 'O1', 'overlay')], layerOrder: [{ type: 'track', id: 'v1' }, { type: 'track', id: 'o1' }],
  items: [{ id: 'title', type: 'text', trackId: 'o1', display: { from: 0, to: durationMs }, trim: { from: 0, to: durationMs }, details: { name: 'Title', text: 'Hello', color: '#ffffff' } }],
});
/** No items, duration 0: nothing to play. */
const emptyDoc = () => ({ ...doc(0), items: [] });
async function open(page: Page, durationMs: number, playheadMs = 0, document: object = doc(durationMs)) {
  await skipTour(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __blockMic?: boolean }, md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
    md.getUserMedia = async c => { if (w.__blockMic) throw new DOMException('Permission denied', 'NotAllowedError'); return orig(c); };
  });
  const id = await openEditor(page, document, 'T13 voice-over');
  await watchIntents(page);
  if (playheadMs) await setViewState(page, { playheadMs });
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('tab', { name: 'Voice-over', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'Voice Over', exact: true })).toBeVisible();
  return id;
}
const panel = (page: Page) => page.getByRole('region', { name: 'Voice Over' });
const rec = (page: Page) => panel(page).getByRole('button', { name: 'Record', exact: true });
const stopBtn = (page: Page) => panel(page).getByRole('button', { name: 'Stop', exact: true });
const discardBtn = (page: Page) => panel(page).getByRole('button', { name: 'Discard', exact: true });
const playing = (page: Page) => page.evaluate(async () => { const p = '/src/render/playback.ts'; return (await import(p)).usePlayback.getState().playing as boolean; });
const undo = (page: Page) => page.evaluate(async () => { const p = '/src/timeline/runtime.ts'; return (await import(p)).activeRuntime.bus.undoStack.map((e: any) => ({ label: e.label, source: e.source })) as { label: string; source: string }[]; });
const live = (page: Page) => page.evaluate(async () => { const p = '/src/editor.tsx'; const d = (await import(p)).activeSession.document; return { tracks: d.tracks as any[], items: d.items as any[], layerOrder: d.layerOrder as any[] }; });
const added = async (page: Page) => (await intents(page)).filter((l: Logged) => l.intent.type === 'addVoiceover');
/** The live document once the voice-over item is in it (the intent places it after the asset list reloads). */
async function placed(page: Page) {
  await expect.poll(async () => (await live(page)).items.filter(i => i.metadata?.isVoiceover).length, { timeout: 10_000 }).toBe(1);
  return live(page);
}
/** Wraps the recorder's stop: its timer reading is kept in window.__timed, and `addMs` is added (a timer made to run long). */
const watchTimer = (page: Page, addMs = 0) => page.evaluate(async addMs => {
  const p = '/src/audio/recorder.ts', { Take } = await import(p), stop = Take.prototype.stop, w = window as unknown as { __timed: number[] };
  w.__timed = [];
  Take.prototype.stop = async function (this: unknown) { const r = await stop.call(this); w.__timed.push(r.durationMs); return { ...r, durationMs: r.durationMs + addMs }; };
}, addMs);
const timed = (page: Page) => page.evaluate(() => (window as unknown as { __timed: number[] }).__timed);
/** From the Record click to the recording state (3 s countdown + start-up). */
async function startRecording(page: Page) {
  await rec(page).click();
  await expect(panel(page).getByText('Get ready…')).toBeVisible({ timeout: 10_000 });
  await expect(stopBtn(page)).toBeVisible({ timeout: 10_000 });
}

test('1 idle panel: explanation, Microphone list with System default, Test microphone, Record; no recording state', async ({ page }) => {
  await open(page, 20_000);
  const p = panel(page);
  await expect(p.getByText(/timeline plays while you record/i)).toBeVisible();
  await expect(p.getByText(/added at the playhead position where recording started/i)).toBeVisible();
  const select = p.getByRole('combobox', { name: 'Microphone' });
  await expect(select).toBeVisible(); await expect(select.locator('option').first()).toHaveText('System default'); await expect(select).toHaveValue('');
  await expect(p.getByRole('button', { name: 'Test microphone' })).toBeVisible(); await expect(rec(page)).toBeVisible();
  for (const absent of [stopBtn(page), discardBtn(page), p.getByText('Get ready…'), p.getByText('Finalizing…'), p.getByText('Requesting microphone access…'), p.getByText('Microphone access blocked'), p.getByText('Open a project to enable recording.')]) await expect(absent).toHaveCount(0);
  // the hint shows while a device has no label (or none is listed); the context grants the microphone, so labels may already be there
  await expect.poll(async () => {
    const names = await select.locator('option').allTextContents(), hint = await p.getByText('Grant mic access once to see device names').count();
    const unnamed = names.length === 1 || names.slice(1).some(n => /^Microphone \d+$/.test(n));
    return unnamed === (hint === 1);
  }).toBe(true);
  expect(await playing(page)).toBe(false);
});

test('2 §30 parity: a take of about 4.2 s from playhead 10 s → one audio item at 10 000 ms on a new audio track A1, named by the rule, metadata exact, one "Add items", toast', async ({ page }) => {
  await open(page, 20_000, 10_000);
  const assetsBefore = await assetCount(page), undoBefore = await undo(page);
  await startRecording(page);
  expect(await playing(page)).toBe(true); // the timeline plays during the recording
  await expect(panel(page).getByLabel('Recording time')).toHaveText(/^00:0\d$/);
  await expect(panel(page).getByRole('img', { name: 'Microphone level' })).toBeVisible();
  const t0 = Date.now(); await page.waitForTimeout(4200); await stopBtn(page).click();
  const wall = Date.now() - t0;
  await expect(rec(page)).toBeVisible({ timeout: 15_000 }); // back to idle
  expect(await playing(page)).toBe(false); // Stop pauses playback
  const [intent] = await added(page); expect(await added(page)).toHaveLength(1);
  const a = intent.intent as any; expect(intent.outcome.ok).toBe(true);
  expect(a.atMs).toBeGreaterThanOrEqual(10_000 - 34); expect(a.atMs).toBeLessThanOrEqual(10_000 + 34); // playhead at start, ±1 frame
  expect(a.durationMs, `wall ${wall} ms`).toBeGreaterThan(4200 - 300); expect(a.durationMs).toBeLessThan(wall + 1000); // the take starts before t0 (panel checks run in between)
  expect(a.name).toMatch(/^Voiceover \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const { tracks, items } = await placed(page), v = items.filter(i => i.metadata?.isVoiceover);
  expect(v).toHaveLength(1); expect(items).toHaveLength(2);
  const audio = tracks.filter(t => t.kind === 'audio'); expect(audio).toHaveLength(1); expect(audio[0].name).toBe('A1');
  expect(v[0].trackId).toBe(audio[0].id); expect(v[0].type).toBe('audio');
  expect(v[0].display.from).toBe(Math.max(0, a.atMs)); expect(v[0].display.to - v[0].display.from).toBe(Math.max(100, a.durationMs));
  expect(v[0].display.from).toBeGreaterThanOrEqual(10_000 - 34); expect(v[0].display.from).toBeLessThanOrEqual(10_000 + 34);
  expect(v[0].display.to - 10_000, 'about 4.2 s').toBeGreaterThan(3900); expect(v[0].display.to - 10_000).toBeLessThan(4200 + 900);
  expect(v[0].details.name).toBe(a.name);
  expect(v[0].metadata).toMatchObject({ agentId: a.agentId, isVoiceover: true, isProxy: false }); expect(a.agentId).toMatch(/^audio_\d+$/);
  expect(Object.keys(v[0].metadata).sort()).toEqual(['agentId', 'assetId', 'isProxy', 'isVoiceover']);
  const after = await undo(page); expect(after).toHaveLength(undoBefore.length + 1); expect(after[after.length - 1]).toEqual({ label: 'Add items', source: 'user' });
  expect(await assetCount(page)).toBe(assetsBefore + 1);
  await expect(notices(page)).toContainText(`Added ${a.agentId} to the timeline`);
  // the stored asset is audio, named like the item
  const asset = await page.evaluate(async id => { const p = '/src/store/database.ts'; const l = await (await import(p)).projectStore.library(); const a = l.assets.find((x: any) => x.id === id); return a && { type: a.type, name: a.name, mimeType: a.mimeType, size: a.sizeBytes }; }, v[0].metadata.assetId);
  expect(asset).toMatchObject({ type: 'audio' }); expect(asset!.size).toBeGreaterThan(0);
  expect(asset!.name.startsWith(a.name)).toBe(true);
});

test('3 auto-stop: recording stops by itself when playback reaches the timeline end (within 50 ms)', async ({ page }) => {
  await open(page, 12_000, 10_000);
  await watchTimer(page);
  await startRecording(page);
  await expect(rec(page)).toBeVisible({ timeout: 15_000 }); // no click: the end of the timeline ended it
  expect(await playing(page)).toBe(false);
  const [l] = await added(page); expect(await added(page)).toHaveLength(1); const a = l.intent as any;
  const [timer] = await timed(page), end = a.atMs + timer; // the recorder's own timer: when the take stopped
  expect(Math.abs(end - 12_000), `take stopped at ${end} ms, timeline end 12000 ms (atMs ${a.atMs}, timer ${timer} ms)`).toBeLessThanOrEqual(50);
  // The item is the stored take (n5): shorter than the timer by the recorder's start-up and its last packet (61–95 ms measured).
  expect(a.durationMs, `stored ${a.durationMs} ms, timer ${timer} ms`).toBeLessThanOrEqual(timer); expect(a.durationMs).toBeGreaterThan(timer - 200);
  const { items } = await placed(page), v = items.filter(i => i.metadata?.isVoiceover);
  expect(v).toHaveLength(1); expect(v[0].display.from).toBe(a.atMs);
  await expect(notices(page)).toContainText('to the timeline');
});

test('4 Discard: the take is thrown away: no item, no asset, no undo entry, playback paused, panel idle', async ({ page }) => {
  await open(page, 20_000, 2000);
  const assetsBefore = await assetCount(page), itemsBefore = (await live(page)).items.length, undoBefore = await undo(page);
  await startRecording(page);
  await page.waitForTimeout(800);
  await discardBtn(page).click();
  await expect(rec(page)).toBeVisible({ timeout: 10_000 });
  expect(await playing(page)).toBe(false);
  await page.waitForTimeout(500);
  expect(await added(page)).toHaveLength(0);
  expect((await live(page)).items).toHaveLength(itemsBefore); expect(await assetCount(page)).toBe(assetsBefore); expect(await undo(page)).toEqual(undoBefore);
  await expect(notices(page).getByText(/Added audio_/)).toHaveCount(0);
  for (const gone of [stopBtn(page), discardBtn(page), panel(page).getByText('Finalizing…')]) await expect(gone).toHaveCount(0);
});

test('5 Cancel in the countdown: back to idle, the timeline never plays, nothing placed even after the 3 s would have passed', async ({ page }) => {
  await open(page, 20_000, 1000);
  const undoBefore = await undo(page);
  await rec(page).click();
  const get = panel(page).getByText('Get ready…'); await expect(get).toBeVisible({ timeout: 10_000 });
  expect(await playing(page)).toBe(false); // the countdown runs before playback starts
  await panel(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(get).toHaveCount(0); await expect(rec(page)).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(stopBtn(page)).toHaveCount(0); await expect(get).toHaveCount(0); expect(await playing(page)).toBe(false);
  expect(await added(page)).toHaveLength(0); expect(await undo(page)).toEqual(undoBefore); expect((await live(page)).items).toHaveLength(1);
});

test('6 blocked microphone: "Microphone access blocked" with the reason and "Try again"; once allowed, Try again goes to the countdown', async ({ page }) => {
  await open(page, 20_000, 1000);
  await page.evaluate(() => { (window as unknown as { __blockMic: boolean }).__blockMic = true; });
  await rec(page).click();
  const p = panel(page);
  await expect(p.getByText('Microphone access blocked')).toBeVisible({ timeout: 10_000 });
  await expect(p.getByRole('alert')).toContainText('Permission denied');
  await expect(p.getByRole('button', { name: 'Try again' })).toBeVisible();
  for (const absent of [p.getByText('Get ready…'), stopBtn(page)]) await expect(absent).toHaveCount(0);
  expect(await playing(page)).toBe(false); expect(await added(page)).toHaveLength(0);
  await page.evaluate(() => { (window as unknown as { __blockMic: boolean }).__blockMic = false; });
  await p.getByRole('button', { name: 'Try again' }).click();
  await expect(p.getByText('Get ready…')).toBeVisible({ timeout: 10_000 });
  await expect(p.getByText('Microphone access blocked')).toHaveCount(0);
  await p.getByRole('button', { name: 'Cancel' }).click(); await expect(rec(page)).toBeVisible();
});

test('7 switching rail tools while recording does not end the take; Stop from the returned panel places the item', async ({ page }) => {
  await open(page, 20_000, 3000);
  await startRecording(page);
  const rail = page.getByRole('navigation', { name: 'Tools' });
  await rail.getByRole('tab', { name: 'Text', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(await playing(page), 'playback continues').toBe(true); expect(await added(page)).toHaveLength(0);
  await rail.getByRole('tab', { name: 'Voice-over', exact: true }).click();
  await expect(stopBtn(page)).toBeVisible(); await expect(discardBtn(page)).toBeVisible();
  const shown = await panel(page).getByLabel('Recording time').textContent();
  expect(shown, 'the timer kept running').not.toBe('00:00');
  await stopBtn(page).click();
  await expect(rec(page)).toBeVisible({ timeout: 15_000 });
  const [l] = await added(page); expect(await added(page)).toHaveLength(1);
  const a = l.intent as any; expect(a.atMs).toBeGreaterThanOrEqual(3000 - 34); expect(a.atMs).toBeLessThanOrEqual(3000 + 34); expect(a.durationMs).toBeGreaterThan(1500);
  expect((await placed(page)).items.filter(i => i.metadata?.isVoiceover)).toHaveLength(1);
});

test('8 empty project: Record → ~1.5 s → Stop → one item of about the recorded length on a new track A1 at the playhead; playback never starts', async ({ page }) => {
  await open(page, 0, 0, emptyDoc());
  await page.evaluate(async () => { // record every change of `playing`
    const p = '/src/render/playback.ts', { usePlayback } = await import(p), w = window as unknown as { __played?: boolean[] };
    w.__played = []; usePlayback.subscribe((s: { playing: boolean }) => { w.__played!.push(s.playing); });
  });
  await startRecording(page);
  expect(await playing(page), 'nothing to play').toBe(false);
  await expect(panel(page).getByLabel('Recording time')).toHaveText(/^00:0\d$/);
  const t0 = Date.now(); await page.waitForTimeout(1500); await stopBtn(page).click();
  const wall = Date.now() - t0;
  await expect(rec(page)).toBeVisible({ timeout: 15_000 });
  const [l] = await added(page); expect(await added(page)).toHaveLength(1);
  const a = l.intent as any; expect(l.outcome.ok).toBe(true);
  expect(a.atMs).toBe(0);
  expect(a.durationMs, `wall ${wall} ms`).toBeGreaterThan(1500 - 300); expect(a.durationMs).toBeLessThan(wall + 1000); // not the 100 ms minimum
  const { tracks, items } = await placed(page), v = items.filter(i => i.metadata?.isVoiceover);
  expect(items).toHaveLength(1); expect(v).toHaveLength(1);
  const audio = tracks.filter(t => t.kind === 'audio'); expect(audio).toHaveLength(1); expect(audio[0].name).toBe('A1'); expect(v[0].trackId).toBe(audio[0].id);
  expect(v[0].display.from).toBe(0); expect(v[0].display.to).toBe(Math.max(100, a.durationMs)); expect(v[0].display.to).toBeGreaterThan(1200);
  expect(await page.evaluate(() => (window as unknown as { __played?: boolean[] }).__played), 'playback never started').not.toContain(true);
  expect(await playing(page)).toBe(false);
});

/** The stored take's duration by T14's probe (the original the item plays). */
const storedMs = (page: Page, item: unknown) => page.evaluate(async item => {
  const r = '/src/media/resolver.ts', s = '/src/store/database.ts', p = '/src/media/probe.ts';
  const { resolveSource } = await import(r), { projectStore } = await import(s), { probeMedia } = await import(p);
  return (await probeMedia((await resolveSource(projectStore, item, 'export')).blob, 'take', 'audio')).durationMs as number;
}, item);

test('9 review n5: the item is as long as the stored take, not the recorder\'s timer (the timer is made to run 2 s long)', async ({ page }) => {
  await open(page, 0, 0, emptyDoc());
  await watchTimer(page, 2000);
  await startRecording(page);
  await page.waitForTimeout(1500); await stopBtn(page).click();
  await expect(rec(page)).toBeVisible({ timeout: 15_000 });
  const [l] = await added(page); const a = l.intent as any;
  const v = (await placed(page)).items.filter(i => i.metadata?.isVoiceover); expect(v).toHaveLength(1);
  const stored = await storedMs(page, v[0]);
  expect(stored, 'the take was probed').toBeGreaterThan(1200); expect(stored).toBeLessThan(3000);
  expect((await timed(page))[0] + 2000 - stored, 'the timer ran 2 s long').toBeGreaterThan(1500);
  expect(a.durationMs).toBe(stored); expect(v[0].display.to - v[0].display.from).toBe(stored);
});

test('10 review m1: the take\'s transcript row is stored within 10 s of Stop (T19\'s preparation runs; its model is stubbed to answer at once)', async ({ page }) => {
  await open(page, 0, 0, emptyDoc());
  await page.evaluate(async () => {
    const s = '/src/analysis/service.ts', { analysisService } = await import(s), w = window as unknown as { __heard: number[] };
    w.__heard = [];
    analysisService.available = async () => ({ analysis: false, transcription: true, embeddings: false, beats: false });
    analysisService.request = async (req: { task: string; pcm?: { sampleRate: number; data: Float32Array[] } }) => {
      if (req.task !== 'transcribe') throw new Error(`not stubbed: ${req.task}`);
      const seconds = req.pcm!.data[0].length / req.pcm!.sampleRate; w.__heard.push(seconds);
      return { status: 'complete', transcript: { language: 'en', languages: ['en'], total_duration: seconds, segments: [{ id: 0, start: 0, end: 1, text: 'stub', speaker: 0, words: [{ word: 'stub', start: 0, end: 1 }] }] } };
    };
  });
  await startRecording(page);
  await page.waitForTimeout(1500); await stopBtn(page).click();
  const stopped = Date.now();
  await expect(rec(page)).toBeVisible({ timeout: 10_000 });
  const v = (await placed(page)).items.filter(i => i.metadata?.isVoiceover); expect(v).toHaveLength(1);
  const row = () => page.evaluate(async id => { const s = '/src/store/database.ts'; const r = await (await import(s)).projectStore.row('transcripts', id); return r ? r.status as string : null; }, v[0].metadata.assetId);
  await expect.poll(row, { timeout: Math.max(0, 10_000 - (Date.now() - stopped)), intervals: [100] }).toBe('complete');
  const elapsed = Date.now() - stopped;
  console.log(`T13 voice-over transcript row ${elapsed} ms after Stop (stubbed model)`);
  expect(elapsed).toBeLessThanOrEqual(10_000);
  const heard = await page.evaluate(() => (window as unknown as { __heard: number[] }).__heard);
  expect(heard, 'the take\'s own PCM reached the model once').toHaveLength(1); expect(heard[0]).toBeGreaterThan(1.2);
});
