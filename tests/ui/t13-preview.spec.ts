// SPDX-License-Identifier: AGPL-3.0-only
// T13 audio in the browser: (a) the source blocks join sample-exactly (audio/source.ts decodes 8 s blocks at 48 kHz on the absolute source grid),
// from 44.1 kHz and 48 kHz files made by ffmpeg; (b) preview = export: the Web Audio output of a play equals renderAudio's samples
// (master plan Â§4 oracle: residual <= -50 dBFS after alignment, gain/peak within 0.1 dB, the first 20 ms excluded because the preview drops the
// first LEAD_MS of its first chunk). The expected values come from the ffmpeg reference decode and from renderAudio (the export's own mix), never
// from the preview. (c) the same over a T07 layout cell at Volume 150 and Speed 2 (review round 3 n11). No Xapp files are used. Skips with a visible reason without ffmpeg.
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareAudio } from '../../apps/web/src/audio/oracle';
import { ffmpegAvailable } from '../media-fixtures';
import { createProject, linkClip, skipTour } from './t02-support';
import { seedLayout } from './t07-support';
import { uploadAsset } from './t15-support';
import { openAndIngest } from './t16a-support';

test.skip(!ffmpegAvailable(), 'ffmpeg makes the 44.1 kHz and 48 kHz test files and the reference decode');
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await skipTour(page); });

const SECONDS = 20;
const dir = path.join(tmpdir(), 'cutframe-t13-media');
/** A stereo float WAV: white noise (seeded) plus a 440 Hz sine, so any offset or step is unambiguous. */
function makeWav(rate: number): string {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `noise-sine-${rate}.wav`);
  if (!existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anoisesrc=d=${SECONDS}:c=white:r=${rate}:a=0.1:seed=3`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${SECONDS}`,
      '-filter_complex', '[0][1]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo', '-c:a', 'pcm_f32le', out]);
    expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  }
  return out;
}
/** The same file decoded by ffmpeg to 48 kHz interleaved stereo float: the reference for the page's decode. */
function referenceDecode(wav: string): Float32Array {
  const raw = path.join(dir, `${path.basename(wav, '.wav')}-48k.f32`);
  if (!existsSync(raw)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-ar', '48000', '-ac', '2', '-f', 'f32le', raw]);
    expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  }
  const b = readFileSync(raw); return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

const track = (id: string) => ({ id, name: id.toUpperCase(), kind: 'audio', muted: false, solo: false, locked: false, hidden: false, volume: 1 });
const clip = (id: string, from: number, to: number, trim: number, volume: number) => ({
  id, type: 'audio', trackId: 'a1', display: { from, to }, trim: { from: trim, to: trim + to - from }, sourceDuration: SECONDS * 1000, playbackRate: 1,
  properties: { volume: { defaultValue: volume, keyframes: [] } }, details: { name: id },
});
const audioDoc = (items: ReturnType<typeof clip>[], duration: number) => ({
  schemaVersion: 4, rev: 0, groups: {}, duration, fps: 30, size: { width: 1280, height: 720 }, background: { type: 'color', value: 'transparent' }, transitions: [], markers: [],
  tracks: [track('a1')], layerOrder: [{ type: 'track', id: 'a1' }], items,
});
async function upload(page: Page, projectId: string, file: string) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async ({ projectId, name, b64 }) => {
    const p = '/src/store/database.ts'; const { projectStore } = await import(p);
    const bin = atob(b64), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const asset = await projectStore.upload(new File([data], name, { type: 'audio/wav' })); await projectStore.attach(projectId, asset.id); return asset.id as string;
  }, { projectId, name: path.basename(file), b64 });
}
async function openWith(page: Page, wav: string, items: ReturnType<typeof clip>[], duration: number) {
  const id = await createProject(page, audioDoc(items, duration), 'T13 audio');
  const assetId = await upload(page, id, wav);
  for (const i of items) await linkClip(page, id, assetId, i.id);
  await page.goto(`/project/${id}`); await expect(page.getByRole('status')).toHaveText('Saved locally');
  return { id, assetId };
}

for (const rate of [48000, 44100]) {
  test(`(a) source blocks join sample-exactly at the 8 s block edges: ${rate} Hz file`, async ({ page }) => {
    const wav = makeWav(rate), ref = referenceDecode(wav);
    const { assetId } = await openWith(page, wav, [clip('c1', 0, 4000, 0, 1)], 4000);
    // windows that cross a block edge (7.5-8.5 s and 15.5-16.5 s: two blocks each) and one inside block 1 (11.9-12.1 s)
    const got = await page.evaluate(async ({ assetId }) => {
      const s = '/src/audio/source.ts', d = '/src/store/database.ts';
      const { storeAudioSource } = await import(s), { projectStore } = await import(d);
      const source = storeAudioSource(projectStore, () => undefined), item = { id: 'probe', type: 'audio', metadata: { assetId } } as any;
      const out: Record<string, { start: number; channels: number; slices: Record<string, number[][]> }> = {};
      for (const [name, a, b, centres] of [['edge8', 7.5, 8.5, [8]], ['edge16', 15.5, 16.5, [16]], ['mid', 11.9, 12.1, [12]]] as const) {
        const pcm = await source(item, a, b);
        if (!pcm) { out[name] = { start: -1, channels: 0, slices: {} }; continue; }
        const slices: Record<string, number[][]> = {};
        for (const c of centres) {
          const f0 = c * 48000 - 2400;
          slices[c] = pcm.data.map((ch: Float32Array) => Array.from(ch.subarray(f0 - pcm.start, f0 - pcm.start + 4800)));
        }
        out[name] = { start: pcm.start, channels: pcm.data.length, slices };
      }
      return out;
    }, { assetId });
    for (const [name, centre] of [['edge8', 8], ['edge16', 16], ['mid', 12]] as const) {
      const w = got[name]; expect(w.start, `${name}: the source returned a window`).toBeGreaterThanOrEqual(0);
      expect(w.channels).toBe(2);
      const f0 = centre * 48000 - 2400, page2 = w.slices[centre];
      const expected = [0, 1].map(c => Float32Array.from({ length: 4800 }, (_, n) => ref[(f0 + n) * 2 + c]));
      const test = page2.map(a => Float32Array.from(a)) as [Float32Array, Float32Array], refS = expected as [Float32Array, Float32Array];
      // a step at the block edge: the sample-to-sample jump across it (index 2399 â†’ 2400) against the reference's
      const jump = (s: Float32Array) => Math.abs(s[2400] - s[2399]);
      const tolerance = rate === 48000 ? 1e-6 : 3e-3; // 48 kHz: no rate conversion, the samples are the file's; 44.1 kHz: -50 dBFS resampling error
      expect(Math.abs(jump(test[0]) - jump(refS[0])), `${name} L: jump across the edge`).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(jump(test[1]) - jump(refS[1])), `${name} R: jump across the edge`).toBeLessThanOrEqual(tolerance);
      let worst = 0; for (let c = 0; c < 2; c++) for (let n = 0; n < 4800; n++) worst = Math.max(worst, Math.abs(test[c][n] - refS[c][n]));
      expect(worst, `${name}: largest sample difference across Â±50 ms of the edge`).toBeLessThanOrEqual(tolerance);
      const cmp = compareAudio(refS, test, { maxLagMs: 2 });
      expect(Math.abs(cmp.lagMs), `${name}: lag`).toBeLessThanOrEqual(0.02);
      expect(cmp.residualDb, `${name}: residual dBFS`).toBeLessThanOrEqual(-50);
      expect(Math.abs(cmp.gainDb), `${name}: gain dB`).toBeLessThanOrEqual(0.1);
    }
  });
}

// ---- (b) preview = export. The preview's chunks are AudioBufferSourceNodes connected to the context's destination. An init script (1) wraps
// window.AudioContext so each 48 kHz context loads a recorder AudioWorklet as soon as it is made, and (2) wraps AudioNode.prototype.connect so that
// an AudioBufferSourceNode connected to the destination is also connected to the recorder once its module has loaded. The worklet runs on the audio
// thread and posts every 128-frame quantum with its exact currentFrame, so no quantum is lost (a ScriptProcessorNode drops quanta when its
// main-thread handoff is late, which gave a false 12.7 dB residual under load). The test plays once and pauses (this makes playback.ts's single
// module-level context and loads the recorder), then seeks to 0 and plays again: that second play is the one compared.
type Tap = { blocks: { f: number; l: Float32Array; r: Float32Array }[]; ready: boolean; connected: number; ctx?: AudioContext; since?: number };
/** The recorder tap described above, installed before the page loads. */
async function installTap(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __tap: Tap };
    w.__tap = { blocks: [], ready: false, connected: 0 };
    const processor = `class T13Rec extends AudioWorkletProcessor {
      process(inputs) { const i = inputs[0]; if (i && i.length) { const l = i[0].slice(), r = (i[1] || i[0]).slice(); this.port.postMessage({ f: currentFrame, l, r }, [l.buffer, r.buffer]); } return true; }
    }
    registerProcessor('t13-rec', T13Rec);`;
    const url = URL.createObjectURL(new Blob([processor], { type: 'text/javascript' }));
    const original = AudioNode.prototype.connect, Original = window.AudioContext;
    const recorders = new WeakMap<BaseAudioContext, AudioWorkletNode>();
    class TappedContext extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        if (this.sampleRate !== 48000) return;
        void this.audioWorklet.addModule(url).then(() => {
          const node = new AudioWorkletNode(this, 't13-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }), mute = this.createGain();
          mute.gain.value = 0;
          node.port.onmessage = e => { w.__tap.blocks.push(e.data); };
          (original as any).call(node, mute); (original as any).call(mute, this.destination); // pulled by the graph, silent at the output
          recorders.set(this, node); w.__tap.ctx = this; w.__tap.ready = true;
        });
      }
    }
    window.AudioContext = TappedContext as typeof AudioContext;
    (AudioNode.prototype as any).connect = function (this: AudioNode, ...args: unknown[]) {
      const result = (original as any).apply(this, args);
      if (args[0] instanceof AudioDestinationNode && this instanceof AudioBufferSourceNode) {
        const rec = recorders.get(this.context);
        if (rec) { (original as any).call(this, rec); w.__tap.connected++; }
      }
      return result;
    };
  });
}
/** Plays once and pauses, then plays from 0 to the end of the timeline and compares the capture with renderAudio over the open document. */
async function playAndCompare(page: Page) {
  const play = page.getByRole('button', { name: 'Play', exact: true }), pause = page.getByRole('button', { name: 'Pause', exact: true });
  // first play: makes the context (the recorder module loads), then pause
  await play.click(); await expect(pause).toBeVisible(); await pause.click(); await expect(play).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __tap: Tap }).__tap.ready, undefined, { timeout: 15_000 });
  // the compared play: from 0, with an empty capture and zeroed stats
  await page.evaluate(async () => {
    const v = '/src/editor/view.ts', p = '/src/render/playback.ts';
    (await import(v)).setView({ playheadMs: 0 });
    const { playbackStats } = await import(p); playbackStats.lateChunks = 0; playbackStats.maxRafGapMs = 0;
    const tap = (window as unknown as { __tap: Tap }).__tap; tap.blocks.length = 0; tap.connected = 0;
    // a late quantum of the first play can still arrive after this reset: blocks that start before the context's current frame are dropped at assembly
    tap.since = Math.ceil(tap.ctx!.currentTime * 48000);
  });
  await play.click(); await expect(pause).toBeVisible();
  // the playback pauses itself at the end of the timeline (3 s); wait for it, plus a margin for the last quanta
  await expect(play).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const result = await page.evaluate(async () => {
    const tap = (window as unknown as { __tap: Tap }).__tap;
    const kept = tap.blocks.filter(b => b.f >= (tap.since ?? 0));
    if (!kept.length) return { error: `no capture (ready ${tap.ready}, blocks ${tap.blocks.length}, kept 0, connected ${tap.connected})` } as const;
    const blocks = [...kept].sort((a, b) => a.f - b.f), f0 = blocks[0].f, last = blocks[blocks.length - 1], total = last.f + last.l.length - f0;
    const left = new Float32Array(total), right = new Float32Array(total);
    for (const b of blocks) { left.set(b.l, b.f - f0); right.set(b.r, b.f - f0); } // placed by the audio thread's frame counter: gaps stay silent
    const d = '/src/store/database.ts', s = '/src/audio/source.ts', st = '/src/audio/stage.ts', o = '/src/audio/oracle.ts', e = '/src/editor.tsx', p = '/src/render/playback.ts';
    const { projectStore } = await import(d), { storeAudioSource } = await import(s), { renderAudio } = await import(st), { compareAudio } = await import(o), { activeSession } = await import(e), { playbackStats } = await import(p);
    const doc = activeSession.document, source = storeAudioSource(projectStore, () => undefined);
    const exported = await renderAudio({ doc, fromMs: 0, toMs: doc.duration, source });
    const exclude: [number, number][] = [[0, 960]]; // the first 20 ms (LEAD_MS) of the preview's first chunk are dropped
    const cmp = compareAudio(exported.channels, [left, right], { maxLagMs: 4000, exclude });
    let peak = 0; for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    let exportedPeak = 0; for (let i = 0; i < exported.channels[0].length; i++) exportedPeak = Math.max(exportedPeak, Math.abs(exported.channels[0][i]), Math.abs(exported.channels[1][i]));
    let gaps = 0; const gapAt: number[] = []; for (let i = 1; i < blocks.length; i++) if (blocks[i].f !== blocks[i - 1].f + blocks[i - 1].l.length) { gaps++; gapAt.push(blocks[i - 1].f + blocks[i - 1].l.length - f0); }
    // where the capture differs from the export at the oracle's lag: spans of frames (merged within 256 frames) with |difference| > 1e-3
    const shift = Math.round(cmp.lagMs * 48), bad: { from: number; to: number }[] = [];
    for (let i = 0; i < exported.channels[0].length; i++) {
      const j = i + shift, dl = Math.abs((left[j] ?? 0) - exported.channels[0][i]), dr = Math.abs((right[j] ?? 0) - exported.channels[1][i]);
      if (dl > 1e-3 || dr > 1e-3) { const last = bad[bad.length - 1]; if (last && i - last.to < 256) last.to = i; else bad.push({ from: i, to: i }); }
    }
    return { cmp, captured: total, exportFrames: exported.channels[0].length, peak, exportedPeak, quanta: blocks.length, quantumGaps: gaps, gapAt, badSpans: bad.length, bad: bad.slice(0, 12), firstCaptureFrame: f0, since: tap.since ?? 0, connected: tap.connected, lateChunks: playbackStats.lateChunks as number, maxRafGapMs: playbackStats.maxRafGapMs as number };
  });
  if ('error' in result) throw new Error(result.error);
  return result;
}
/** (b)'s gates on a playAndCompare result. */
function expectPreviewEqualsExport(result: Awaited<ReturnType<typeof playAndCompare>>, label = '') {
  console.log(`T13 preview=export${label}: ${JSON.stringify(result)}`);
  expect(result.connected, 'chunk nodes reached the destination').toBeGreaterThan(0);
  expect(result.exportedPeak, 'the export mix is loud (not a vacuous comparison)').toBeGreaterThan(0.3);
  expect(result.exportedPeak, 'the limiter holds the export under the -1 dBFS ceiling').toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-4);
  expect(result.peak, 'the capture holds sound').toBeGreaterThan(0.3);
  // the capture starts at an arbitrary place in the context: the oracle's lag search finds it, so the lag gate is not asserted; level, peak and residual are
  expect(Math.abs(result.cmp.gainDb), `gain dB (lateChunks ${result.lateChunks}, maxRafGapMs ${result.maxRafGapMs})`).toBeLessThanOrEqual(0.1);
  expect(Math.abs(result.cmp.peakDb), `peak dB (lateChunks ${result.lateChunks}, maxRafGapMs ${result.maxRafGapMs})`).toBeLessThanOrEqual(0.1);
  expect(result.cmp.residualDb, `residual dBFS at lag ${result.cmp.lagMs.toFixed(2)} ms (lateChunks ${result.lateChunks}, maxRafGapMs ${result.maxRafGapMs}, quantumGaps ${result.quantumGaps})`).toBeLessThanOrEqual(-50);
}
test('(b) preview = export: the Web Audio output of a play equals renderAudio (residual <= -50 dBFS, first 20 ms excluded)', async ({ page }) => {
  await installTap(page);
  const wav = makeWav(48000), DURATION = 3000;
  // A: source 2-5 s at volume 1.5 (gain 2.25); B: source 10-11.4 s at volume 2 (gain 4) over 800-2200 ms, so the overlap drives the limiter.
  const items = [clip('ca', 0, DURATION, 2000, 1.5), clip('cb', 800, 2200, 10_000, 2)];
  const { assetId } = await openWith(page, wav, items, DURATION);
  expect(assetId).toBeTruthy();
  expectPreviewEqualsExport(await playAndCompare(page));
});

// ---- (c) the capture and gates of (b) over a T07 layout cell (review round 3 n11): a split-horizontal layout over the whole 3 s timeline, cell 0 at
// Volume 150 and Speed 2 on an MP4 (H.264 + AAC) holding (b)'s noise + 440 Hz. The preview and renderAudio both play it as T07's cell item (findings
// §7b.3 l.159: track gain × (cell volume % / 100)², the cell's own playbackRate). Pre-registered in the notes before the first run.
function makeCellClip(): string {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'cell-noise-sine.mp4');
  if (!existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=8', '-f', 'lavfi', '-i', 'anoisesrc=d=8:c=white:r=48000:a=0.1:seed=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8', '-filter_complex', '[1][2]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', out]);
    expect(r.status, `ffmpeg: ${r.stderr?.toString().slice(-300)}`).toBe(0);
  }
  return out;
}
test('(c) preview = export for a layout cell at 150 % and 2×: the Web Audio output of a play equals renderAudio (the gates of (b))', async ({ page }) => {
  await installTap(page);
  const doc: any = audioDoc([], 3000);
  doc.tracks = [{ id: 'o1', name: 'O1', kind: 'overlay', muted: false, solo: false, locked: false, hidden: false, volume: 1 }];
  doc.layerOrder = [{ type: 'track', id: 'o1' }];
  doc.items = [seedLayout('L1', 'split-horizontal', { trackId: 'o1', from: 0, to: 3000, width: 1280, height: 720 })];
  const id = await createProject(page, doc, 'T13 audio cell'), file = makeCellClip();
  const cell = await uploadAsset(page, id, readFileSync(file), path.basename(file), 'video/mp4');
  await page.evaluate(async ({ id, cell }) => {
    const p = '/src/store/database.ts', { projectStore } = await import(p), { document } = await projectStore.read(id);
    Object.assign(document.items.find((i: any) => i.id === 'L1').details.cells[0], { source: { assetId: cell, type: 'video', url: `asset:${cell}` }, volume: 150, playbackRate: 2 });
    await projectStore.save(id, document, document.rev);
  }, { id, cell });
  await openAndIngest(page, id);
  expectPreviewEqualsExport(await playAndCompare(page), ' (layout cell)');
});
