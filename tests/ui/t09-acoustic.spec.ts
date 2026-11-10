// SPDX-License-Identifier: AGPL-3.0-only
// CT-11 controlled TTS acoustic/caption/export timing. No ASR or natural-speech alignment claim.
// D39 (Author, 9 Nov, set after the result was seen): every word-alpha row is measured on the actual production pre-encode
// frame of the same continuous 120 s export with the frozen D39 interval method (t09-alpha-capture, t09-alpha-measurement).
// Decoded brightness stays as the named legacy diagnostic; decoded highlight state, PCM boundaries and clap A/V stay decoded.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';
import { layoutCaption } from '../../parity/oracle/captions';
import { skipTour } from './t02-support';
import { liveDoc } from './t03-support';
import { decodePcm, ff, genMedia, mkDoc, setup, streams } from './t16a-support';
import { acousticFixture, FPS, LENGTH, RATE } from './t09-acoustic-support';
import { backgroundRows, captionBox, captureExport, FONT_SHA256, geometry, installPipelineOverlay, offsetsFor, sealReference, sha256, supportHash, visibleCaptions } from './t09-alpha-capture';
import { assertD39, evidence as d39Evidence, measure, selectChannel, type Measurement, type Rgb } from './t09-alpha-measurement';
test.setTimeout(240000);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const frameAt = (s: number) => Math.ceil(s * FPS - 1e-8);
const withinFrame = (offsetSamples: number, uncertaintySamples = 0) => {
  // 48 kHz / 30 fps = exactly 1600 samples: no floating-point tolerance added to the one-frame requirement.
  if (Math.abs(offsetSamples) + uncertaintySamples > RATE / FPS) throw new Error(`sync error ${offsetSamples} samples + uncertainty ${uncertaintySamples} samples exceeds one frame`);
};
/** The saved word-1 ("eight") core, one exact pixel set per OS, all M = 255 (D39 step 0, per-OS by D40 2A). Evidence:
 *  linux: the archived pre-D39 run, epic artifacts/t09-captions-c/fix-round-1/ct11-native-diagnostic/index.md (sha256 20cbb29f…57c4);
 *  win32: the D40 2E observation, epic scratch/t09-2e-run-20261109T034303Z/result.json
 *  (sha256 dbde25e32b0b741ceb1400c71ba57f1fc473542fcda20e22ba5ef0283b0dca76), repeated in D39 P2. */
const WORD1_BY_OS: Record<string, { count: number; first: number; last: number; sha256: string }> = {
  linux: { count: 273, first: 92844, last: 128640, sha256: 'b2bb03fb80b176c9e27d9c26b69e0cca7c463fb4ab935929adad5e4f72b7cde0' },
  win32: { count: 212, first: 92844, last: 128632, sha256: '5f02750bd5f62d97926357296ede86ed124391f537f2512a88f041263422f75b' },
};
const WORD1 = WORD1_BY_OS[process.platform];
if (!WORD1) throw new Error(`D39_METHOD_VALIDITY_RED: no saved word-1 support for platform ${process.platform}`);
const HIGHLIGHT: Rgb = [255, 230, 0], WHITE: Rgb = [255, 255, 255], BLACK: Rgb = [0, 0, 0], SIZE = { width: 320, height: 180 };

test('CT-11 120-second continuous production export: independent PCM speech boundaries, highlight N-1/N/N+1 and decoded clap/visual sync', async ({ page }, info) => {
  const fixture = acousticFixture();
  await skipTour(page); await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ status: 404, body: 'offline' }));
  const overlay = await installPipelineOverlay(page, info);
  const white = genMedia('t09-acoustic-white.png', ['-f', 'lavfi', '-i', 'color=white:size=320x180', '-frames:v', '1']);
  const markers = fixture.claps.map((s, n) => ({ id: `clap${n}`, type: 'image' as const, track: 'v1', from: s * 1000, to: s * 1000 + 1000 / FPS }));
  const doc = mkDoc([{ id: 'speech', type: 'audio', track: 'a1', from: 0, to: LENGTH * 1000, sourceDuration: LENGTH * 1000 }, ...markers], { duration: LENGTH * 1000, size: { width: 320, height: 180 } });
  doc.tracks.push({ id: 'c1', name: 'C1', kind: 'caption', hidden: false, muted: false, solo: false, locked: false, volume: 1 }); doc.layerOrder.push({ type: 'track', id: 'c1' });
  const { id, assets } = await setup(page, doc, { speech: fixture.file, ...Object.fromEntries(markers.map(m => [m.id, white])) });
  const generated = await page.evaluate(async ({ assetId, words }) => {
    const sp = '/src/store/database.ts', rp = '/src/timeline/runtime.ts', ap = '/src/captions/agent.ts'; const { projectStore } = await import(sp), rt = (await import(rp)).activeRuntime;
    // This is independently measured fixture truth, not the output of a mocked ASR/preparation path.
    await projectStore.putRow('transcripts', { id: assetId, status: 'complete', music: false, created_at: new Date().toISOString(), transcript: { language: 'en', languages: ['en'], total_duration: 120,
      segments: [{ id: 0, speaker: 0, start: words[0].start, end: words.at(-1)!.end, text: words.map((w: any) => w.text).join(' '), words: words.map((w: any) => ({ word: w.text, start: w.start, end: w.end })) }] } });
    const args = { trackId: 'c1', maxWords: 3, maxCharacters: 100, fontSize: 32, borderWidth: 0 };
    const result = await (await import(ap)).callCaptionTool(rt.tools, args, { store: projectStore, asset: (id: string) => rt.assets.get(id), run: () => rt.call('addCaptions', args) });
    if (result.success) {
      rt.call('editAllCaptionStyles', { trackId: 'c1', renderMode: 'highlight' });
      rt.bus.run('Edit items', 'user', (d: any) => { for (const c of d.items.filter((i: any) => i.type === 'caption')) { c.details.renderConfig = { highlightColor: '#FFE600', highlightScale: 1 }; c.properties.positionY = { defaultValue: 50, keyframes: [] }; } });
    }
    return result;
  }, { assetId: assets.speech, words: fixture.words });
  expect(generated.success, JSON.stringify(generated)).toBe(true);
  const placed = await liveDoc(page), captions = placed.items.filter((i: any) => i.type === 'caption'); expect(captions).toHaveLength(12);
  await expect.poll(() => page.evaluate(async id => { const p = '/src/store/database.ts'; const d = (await (await import(p)).projectStore.read(id)).document; return d.items.filter((i: any) => i.type === 'caption').length; }, id), { timeout: 15000 }).toBe(12);
  const masks = await page.evaluate(async captions => {
    const p = '/src/captions/fonts.ts'; await (await import(p)).loadCaptionFonts({ items: captions, tracks: [], groups: {}, layerOrder: [] });
    return captions.map((c: any) => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')!, F = c.properties.fontSize.defaultValue; ctx.font = `normal 700 ${F}px 'Roboto', sans-serif`;
      return { id: c.id, F, widths: c.details.words.map((w: any) => ctx.measureText(w.text).width) };
    });
  }, captions);
  const placements = captions.flatMap((c: any, ci: number) => {
    const m = masks[ci], v = (k: string) => c.properties[k].defaultValue;
    return layoutCaption(c.details.words.map((w: any) => w.text), text => m.widths[c.details.words.findIndex((w: any) => w.text === text)], { fontSize: m.F, width: v('width'), height: v('height'), align: 'center' }, [1, 1, 1]).flat().map((w: { word: number; centreX: number; centreY: number; width: number }) => ({ c: c.id, word: w.word, F: m.F, cx: v('positionX') + w.centreX, cy: v('positionY') + w.centreY, width: w.width, text: c.details.words[w.word].text }));
  });
  // Both declared paints are full scale in the same channel over black, chosen before any output is read (D39 §2).
  const CH = selectChannel(WHITE, BLACK); expect(selectChannel(HIGHLIGHT, BLACK), 'highlight and white paints measure the same channel').toBe(CH);
  const native: { core: number[]; M: number[]; P: number[]; any: { x0: number; x1: number; y0: number; y1: number }; reference: { context: unknown; faces: unknown } }[] = await page.evaluate(({ placements, CH }) => {
    const faces = Array.from(document.fonts).filter(f => f.family.replace(/["']/g, '') === 'Roboto' && f.weight === '700')
      .map(f => ({ family: f.family.replace(/["']/g, ''), weight: f.weight, style: f.style, status: f.status })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    return placements.map((w: { F: number; text: string; cx: number; cy: number; width: number }) => {
      const ctx = new OffscreenCanvas(320, 180).getContext('2d')!; ctx.font = `normal 700 ${w.F}px 'Roboto', sans-serif`; ctx.textBaseline = 'top'; ctx.fillStyle = 'white'; ctx.fillText(w.text, w.cx - w.width / 2, w.cy - w.F / 2);
      const pixels = ctx.getImageData(0, 0, 320, 180).data, indices: number[] = [];
      // Use the independently drawn opaque interior (one-pixel erosion), excluding antialias/chroma-edge coverage.
      for (let y = 1; y < 179; y++) for (let x = 1; x < 319; x++) {
        const i = (y * 320 + x) * 4;
        if ([i, i - 4, i + 4, i - 1280, i + 1280].every(at => pixels[at + 3] > 250)) indices.push(i);
      }
      // D39 coverage reference P: the same glyph, white at opacity 1 on opaque black, export canvas settings.
      const ref = new OffscreenCanvas(320, 180).getContext('2d', { willReadFrequently: true })!;
      ref.fillStyle = '#000000'; ref.fillRect(0, 0, 320, 180); ref.font = `normal 700 ${w.F}px 'Roboto', sans-serif`; ref.textBaseline = 'top'; ref.fillStyle = 'white'; ref.fillText(w.text, w.cx - w.width / 2, w.cy - w.F / 2);
      const b = ref.getImageData(0, 0, 320, 180).data, any = { x0: 320, x1: -1, y0: 180, y1: -1 };
      for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) if (pixels[(y * 320 + x) * 4 + 3] > 0) { any.x0 = Math.min(any.x0, x); any.x1 = Math.max(any.x1, x); any.y0 = Math.min(any.y0, y); any.y1 = Math.max(any.y1, y); }
      return { core: indices, M: indices.map(i => pixels[i + 3]), P: indices.map(i => b[i + CH]), any, reference: { context: { ...(ref as any).getContextAttributes() }, faces } };
    });
  }, { placements, CH });
  const core = native.map(w => w.core);
  core.forEach(p => expect(p.length).toBeGreaterThan(20));
  // The native support is fixed before any actual output: word 1 must be this OS's saved support.
  expect({ count: core[1].length, first: core[1][0], last: core[1].at(-1), sha256: sha256(JSON.stringify(core[1])) }, `D39_METHOD_VALIDITY_RED: word 1 support differs from the saved ${process.platform} support`).toEqual(WORD1);
  const ns = [...new Set([...fixture.words.flatMap(w => [w.start, w.end].flatMap(s => { const n = frameAt(s); return [n - 1, n, n + 1]; })), ...fixture.claps.flatMap(s => { const n = frameAt(s); return [n - 1, n, n + 1]; })])].sort((a, b) => a - b);
  // Every original word-alpha row: word, global frame, expected 1_visible against the independent caption interval, declared paint.
  const alphaRows = [...new Map(fixture.words.flatMap((word, wi) => (['start', 'end'] as const).flatMap(edge => { const n = frameAt(word[edge]); return [n - 1, n, n + 1]; }).map(f => {
    const group = Math.floor(wi / 3) * 3, visible = f / FPS >= fixture.words[group].start && f / FPS < fixture.words[group + 2].end + .5;
    const factors = { visible: visible ? 1 : 0 }, lit = visible && f / FPS >= word.start && f / FPS < word.end;
    return [`${wi}:${f}`, { wi, f, factors, lit, supportSha256: supportHash(core[wi].map((at, j) => ({ at, M: native[wi].M[j], P: native[wi].P[j] })), factors) }] as const;
  }))).values()];
  sealReference(info, 'acoustic', { requested: ns, channel: CH, word1: WORD1, words: native.map((w, wi) => ({ wi, text: placements[wi].text, ...w })), rows: alphaRows });
  const cap = await captureExport(page, info, overlay, id, { bitrate: 20_000_000, range: { startS: 0, endS: LENGTH } }, ns, 'acoustic'), run = cap.run;
  copyFileSync(run.file!, info.outputPath('controlled-tts-120s.mp4'));
  expect(run.result!.stats.path).toBe('encode');
  const all = streams(run.file!), video = all.find(s => s.codec_type === 'video'), audio = all.find(s => s.codec_type === 'audio');
  expect(Math.abs(Number(video.duration) - LENGTH)).toBeLessThanOrEqual(1 / FPS);
  const frames = new Map<number, Buffer>();
  // Bound ffmpeg's expression depth and decode buffer; every declared probe still runs on the same continuous export.
  for (let from = 0; from < ns.length; from += 48) {
    const batch = ns.slice(from, from + 48), raw: Buffer = ff('ffmpeg', ['-v', 'error', '-i', run.file!, '-an', '-vf', `select=${batch.map(n => `eq(n\\,${n})`).join('+')}`, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], 'buffer');
    expect(raw.length).toBe(batch.length * 320 * 180 * 4);
    batch.forEach((n, i) => frames.set(n, raw.subarray(i * 320 * 180 * 4, (i + 1) * 320 * 180 * 4)));
  }
  // D39 on every word-alpha row before any decision; every row is kept with its legacy decoded-brightness diagnostic.
  const boxes = [...captions.map(captionBox), ...native.map(w => w.any)], measured = new Map<string, Measurement>();
  for (const r of alphaRows) {
    const c = cap.captures.get(r.f)!, w = native[r.wi], t = r.f * 1000 / FPS, rows = offsetsFor(w.core).map((at, j) => ({ at, J: c.rgba[at + CH], P: w.P[j], M: w.M[j] }));
    const m = measure({ label: `acoustic frame ${r.f} word ${r.wi} ${fixture.words[r.wi].text}`, expected: r.factors, foreground: r.lit ? HIGHLIGHT : WHITE, background: BLACK, minCount: 20, rows, backgroundRows: backgroundRows(c.rgba, SIZE, boxes),
      identity: {
        reference: { face: w.reference.faces, fontSha256: FONT_SHA256, context: w.reference.context, colorSpace: 'srgb', size: '320x180', geometry: geometry(placed, t), captionDraws: visibleCaptions(placed, t).map((i: any) => i.id).sort(), otherPaint: [], support: r.supportSha256 },
        actual: { face: c.faces, fontSha256: cap.meta.fontSha256, context: cap.meta.context, colorSpace: c.colorSpace, size: `${c.width}x${c.height}`, geometry: geometry(cap.meta.doc, c.t),
          captionDraws: c.draws.filter(d => d.kind === 'caption').map(d => d.itemId).sort(), otherPaint: c.draws.filter(d => d.kind !== 'caption').map(d => d.itemId), support: supportHash(rows, r.factors) },
      } });
    const f = frames.get(r.f)!, decoded = median(w.core.map(i => Math.max(f[i], f[i + 1], f[i + 2]))) / 255;
    appendFileSync(info.outputPath('acoustic-d39-measurements.jsonl'), `${JSON.stringify({ ...d39Evidence(m), word: r.wi, frame: r.f, legacyDecodedBrightness: { alpha: decoded, oracle: r.factors.visible, error: Math.abs(decoded - r.factors.visible) } })}\n`);
    measured.set(`${r.wi}:${r.f}`, m);
  }
  const highlighted = (f: Buffer, wi: number) => median(core[wi].map(i => f[i])) > 235 && median(core[wi].map(i => f[i + 1])) > 195 && median(core[wi].map(i => f[i + 2])) < 20;
  // Independent PCM clap onsets: decoded once from the same export, never from frame records.
  const pcm = decodePcm(run.file!), audioStart = Number(audio.start_time ?? 0), clapSamples = fixture.claps.map(time => {
    const start = Math.round((time - .025) * RATE), end = Math.round((time + .025) * RATE);
    for (let j = start; j < end; j++) if (Math.abs(pcm.left[j]) > .4) return j;
    return -1;
  });
  /** Highlight / visual-marker classification and event-to-independent-PCM comparison over decoded frame records keyed by
   *  global frame. The event is the first pre→post switch between consecutive records within ±3 frames of the acoustic frame. */
  const judge = (records: Map<number, Buffer>) => {
    const event = (n: number, state: (f: number) => boolean | null, post: boolean) => { for (let f = n - 3; f <= n + 3; f++) if (state(f - 1) === !post && state(f) === post) return f; return undefined; };
    const boundaries = fixture.words.flatMap((word, wi) => (['start', 'end'] as const).map(edge => {
      const n = frameAt(word[edge]), post = edge === 'start', state = (f: number) => { const r = records.get(f); return r ? highlighted(r, wi) : null; }, e = event(n, state, post);
      const uncertaintyMs = edge === 'start' ? word.onsetUncertaintyMs : word.endUncertaintyMs;
      return { word: wi, text: word.text, edge, acousticS: word[edge], frame: n, states: [n - 1, n, n + 1].map(state), expected: post ? [false, true, true] : [true, false, false], event: e,
        errorMs: e === undefined ? undefined : (e / FPS - word[edge]) * 1000, uncertaintyMs,
        offsetSamples: e === undefined ? undefined : e * (RATE / FPS) - Math.round(word[edge] * RATE), uncertaintySamples: Math.round(uncertaintyMs * RATE / 1000) };
    }));
    const markers = fixture.claps.map((time, k) => {
      const n = frameAt(time), brightness = (f: number) => { const r = records.get(f); return r ? (r[0] + r[1] + r[2]) / 3 : null; };
      const lit = (f: number) => { const b = brightness(f); return b === null ? null : b > 240; }, e = event(n, lit, true), sample = clapSamples[k], audioS = sample / RATE + audioStart;
      return { sourceClapS: time, frame: n, states: [n - 1, n, n + 1].map(lit), brightness: [n - 1, n, n + 1].map(brightness), event: e, decodedAudioSample: sample, audioS,
        visualFrame: e, offsetMs: e === undefined ? undefined : (e / FPS - audioS) * 1000, offsetSamples: e === undefined ? undefined : e * (RATE / FPS) - sample - Math.round(audioStart * RATE) };
    });
    return { boundaries, markers };
  };
  const verdict = judge(frames), boundaries: any[] = [], markerResults: any[] = [];
  for (const b of verdict.boundaries) {
    expect(b.states, `${b.text} ${b.edge} @ ${b.acousticS}`).toEqual(b.expected);
    for (const f of [b.frame - 1, b.frame, b.frame + 1]) assertD39(measured.get(`${b.word}:${f}`)!);
    withinFrame(b.offsetSamples!, b.uncertaintySamples);
    boundaries.push({ word: b.word, text: b.text, edge: b.edge, acousticS: b.acousticS, frame: b.event, errorMs: b.errorMs, uncertaintyMs: b.uncertaintyMs, offsetSamples: b.offsetSamples, uncertaintySamples: b.uncertaintySamples });
  }
  for (const m of verdict.markers) {
    expect(m.states, `clap ${m.sourceClapS}s, frame ${m.frame}, brightness ${m.brightness}`).toEqual([false, true, false]);
    expect(m.decodedAudioSample).toBeGreaterThanOrEqual(0);
    withinFrame(m.offsetSamples!, 1);
    markerResults.push({ sourceClapS: m.sourceClapS, decodedAudioSample: m.decodedAudioSample, audioS: m.audioS, visualFrame: m.visualFrame, offsetMs: m.offsetMs, offsetSamples: m.offsetSamples });
  }
  expect(() => withinFrame(boundaries[0].offsetSamples + 2 * RATE / FPS, boundaries[0].uncertaintySamples), 'a two-frame caption shift must fail').toThrow(/sync error/);
  expect(() => withinFrame(markerResults[0].offsetSamples + 2 * RATE / FPS, 1), 'a two-frame A/V shift must fail').toThrow(/sync error/);
  // Measurement-association control (D39 §6): the same saved decoded records relabelled m → m+2 (exactly +2/FPS) before event
  // calculation, image and PCM bytes unchanged. Not an actually delayed encoder or a second export. Every boundary and clap must
  // be rejected by its N−1/N/N+1 states and by the one-frame bound on the event detected from the shifted records.
  const association = judge(new Map([...frames].map(([n, f]) => [n + 2, f])));
  for (const b of association.boundaries) {
    expect(b.states, `association control ${b.text} ${b.edge}: N-1/N/N+1 states`).not.toEqual(b.expected);
    expect(b.event, `association control ${b.text} ${b.edge}: switch detected in the shifted records`).toBeDefined();
    expect(() => withinFrame(b.offsetSamples!, b.uncertaintySamples), `association control ${b.text} ${b.edge}: timing`).toThrow(/sync error/);
  }
  for (const m of association.markers) {
    expect(m.states, `association control clap ${m.sourceClapS}s: N-1/N/N+1 states`).not.toEqual([false, true, false]);
    expect(m.event, `association control clap ${m.sourceClapS}s: marker detected in the shifted records`).toBeDefined();
    expect(() => withinFrame(m.offsetSamples!, 1), `association control clap ${m.sourceClapS}s: A/V`).toThrow(/sync error/);
  }
  const firstPackets = JSON.parse(ff('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-read_intervals', '%+#1', '-show_packets', '-of', 'json', run.file!]));
  const evidence = { claim: 'controlled TTS acoustic/caption/export timing only', fixture: { ...fixture, file: 'generated from preserved test source PCM' }, durationS: LENGTH, fps: FPS, codec: audio.codec_name,
    decodedAudioDelayPolicy: 'ffmpeg honors container timestamps/edit-list and codec skip-sample metadata; no fitted offset', firstPackets, streams: all, boundaries, markers: markerResults,
    initialSignedOffsetMs: markerResults[0].offsetMs, finalSignedOffsetMs: markerResults.at(-1).offsetMs, driftMs: markerResults.at(-1).offsetMs - markerResults[0].offsetMs,
    d39: { method: 'frozen D39 pre-encode interval method', rows: measured.size, file: 'acoustic-d39-measurements.jsonl' },
    associationControl: { shiftFrames: 2, boundaries: association.boundaries.map(b => ({ word: b.word, edge: b.edge, states: b.states, event: b.event, offsetSamples: b.offsetSamples })), markers: association.markers.map(m => ({ sourceClapS: m.sourceClapS, states: m.states, event: m.event, offsetSamples: m.offsetSamples })) },
    exportSha256: createHash('sha256').update(readFileSync(run.file!)).digest('hex') };
  await info.attach('CT-11 acoustic evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  copyFileSync(run.file!, info.outputPath('controlled-tts-120s.mp4'));
  console.log(JSON.stringify({ CT11: 'passed', pcmSha256: fixture.pcmSha256, boundaryChecks: boundaries.length, markerChecks: markerResults.length, d39Rows: measured.size, initialSignedOffsetMs: evidence.initialSignedOffsetMs, finalSignedOffsetMs: evidence.finalSignedOffsetMs, driftMs: evidence.driftMs }));
});
