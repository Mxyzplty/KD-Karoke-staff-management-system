// SPDX-License-Identifier: AGPL-3.0-only
// The export run (findings §7, §44.8, §53.8): prep → prechecks → remux fast path or the frame loop → MP4. The frame loop
// draws T15's frame plan (framePlan, composite) for frame n at planTime(n) on an opaque black canvas of the output size,
// reads it back as I420 BT.709 limited range, and encodes it with its own VideoEncoder (queue ≤ 2) into Mediabunny's
// EncodedVideoPacketSource at exact CFR timestamps (n − first) / fps. Audio: the audio stage (T13's limited mix, audio.ts)
// in one chunk, or 120 s chunks above 5 min, encoded to AAC-LC 48 kHz stereo 192 kb/s (Opus 48 kHz stereo with a message
// when this browser has no AAC-LC encoder, Q-F provisional), kept about 1 s ahead of the video.
// Any failure stops the run, closes everything it opened and is thrown for the caller to classify (errors.ts).
import { AudioSample, AudioSampleSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny';
import type { ProjectStore } from '../store/database';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { resolveSource } from '../media/resolver';
import { composite } from '../render/compositor';
import type { Source } from '../render/compositor';
import { encodedTime, framePlan, isStackedAlpha, planTime } from '../render/model';
import type { Draw, Pending, Size } from '../render/model';
import { picture } from '../render/sources';
import { loadTextFonts } from '../text/fonts';
import { sourceTime } from '../timeline/properties';
import { withCellItems } from '../timeline/layouts';
import { CHUNK_S, CHUNKED_ABOVE_S, exportMix, hasAudioStream, SAMPLE_RATE } from './audio';
import type { AudioStage, Pcm } from './audio';
import { ExportDecoders, exportFaults, PREFETCH_S } from './decoders';
import type { DecoderStats } from './decoders';
import { ExportError } from './errors';
import { BT709, rgbaToI420 } from './i420';
import { outputSize, precheck, prepare } from './prep';
import type { Range, Resolution } from './prep';
import { AUDIO, audioSupported, DEFAULT_BITRATE, negotiateAudio, negotiateVideo } from './probe';
import { remuxCandidate, remuxTracks } from './remux';
import { estimateBytes, openSink } from './sinks';
import type { Sink, SinkKind, SinkOptions, WritableHandle } from './sinks';

export const MAX_ENCODE_QUEUE = 2, KEYFRAME_S = 5, PROGRESS_EVERY = 5, MAX_MUX_PENDING = 4;
export type Progress = { phase: 'render' | 'remux' | 'finalize'; frame: number; frames: number; percent: number; elapsedMs: number; etaMs: number | null; fps: number };
export type ExportOptions = {
  store: ProjectStore; doc: ProjectDocument; title?: string; filename?: string; resolution?: Resolution; bitrate?: number; range?: Range;
  handle?: WritableHandle | null; signal?: AbortSignal; onProgress?: (p: Progress) => void;
  /** The audio stage; default T13's limited mix (exportMix). close() is called when the run ends. */
  audio?: AudioStage & { release?(keep: Set<string>): void; close?(): void };
  storage?: SinkOptions['storage']; forceWasm?: boolean; maxDecoders?: number;
  /** false skips the remux fast path (default: taken when eligible). */
  remux?: boolean;
};
export type ExportStats = {
  path: 'encode' | 'remux'; remuxSkipped: string | null; maxEncodeQueue: number; encodeWaits: number; heapPeakBytes: number | null;
  decoders: DecoderStats | null; audioChunks: number; renderMs: number;
  /** Frame-loop time per stage, summed over the frames (ms): where an export's time goes. */
  timing: { audioMs: number; sourcesMs: number; compositeMs: number; readbackMs: number; convertMs: number; encodeWaitMs: number };
};
export type ExportResult = {
  blob: Blob; filename: string; sink: SinkKind; sinkName?: string; frames: number; size: Size; fps: number; codec: string; profile: string;
  /** The audio track's codec; null when the timeline has no video or audio item (no audio track). */
  audioCodec: 'aac' | 'opus' | null; messages: string[]; repaired: string[]; notRendered: (Pending & { firstMs: number })[]; stats: ExportStats;
};

/** The download name: the given name or the project title (findings §7), never empty, with .mp4. */
export function exportFilename(name: string | undefined, title: string | undefined) {
  const base = (name?.trim() || title || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().replace(/\.mp4$/i, '') || 'Untitled';
  return `${base}.mp4`;
}
const waitFor = (target: EventTarget, type: string, ms: number) => new Promise<void>(r => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); target.removeEventListener(type, done); r(); }
  target.addEventListener(type, done, { once: true });
});
const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
export const audioFailure = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  if ((e as { name?: string })?.name === 'AbortError' || code === 'USER_CANCELLED' || code === 'SUPERSEDED' || code === 'WORKSPACE_FILE_MISSING') return e;
  const message = (e as Error)?.message ?? String(e);
  // The audio stage runs ahead of the video, so it opens a source first: a video item's bytes no demuxer reads come back
  // as UNSUPPORTED_INPUT (export/audio.ts), as on the video path, not an audio failure.
  if (code === 'UNSUPPORTED_INPUT') return new ExportError('UNSUPPORTED_INPUT', message);
  return new ExportError('AUDIO_FAILED', `Audio mix failed: ${message}`);
};

/** Runs one export to the first sink that takes it (handle → OPFS → memory) and returns the file. */
export async function runExport(o: ExportOptions): Promise<ExportResult> {
  const t0 = performance.now(), signal = o.signal;
  signal?.throwIfAborted();
  const { doc, plan, repaired } = prepare(o.doc, o.range);
  const assets = await precheck(o.store, doc);
  signal?.throwIfAborted();
  const size = outputSize(doc, o.resolution), fps = plan.fps, durationS = plan.count / fps, bitrate = o.bitrate ?? DEFAULT_BITRATE;
  const filename = exportFilename(o.filename, o.title), messages: string[] = [];
  if (repaired.length) messages.push(`Trims of ${repaired.join(', ')} were clamped into their source before the export.`);
  if (!(plan.count > 0)) throw new ExportError('CLIENT_BUG', 'The export has no frames (empty composition).');
  // T05: every text's faces load before the first frame; a family that is not available or a face that cannot load fails
  // the export with its FONT_* code (never a silent fallback). An on-demand CJK font that cannot load is a message only.
  try { messages.push(...await loadTextFonts(doc, o.range)); } catch (e) {
    const code = (e as { code?: unknown })?.code;
    throw typeof code === 'string' && code.startsWith('FONT_') ? new ExportError(code, (e as Error).message) : e;
  }
  signal?.throwIfAborted();
  const stats: ExportStats = { path: 'encode', remuxSkipped: null, maxEncodeQueue: 0, encodeWaits: 0, heapPeakBytes: heap(), decoders: null, audioChunks: 0, renderMs: 0,
    timing: { audioMs: 0, sourcesMs: 0, compositeMs: 0, readbackMs: 0, convertMs: 0, encodeWaitMs: 0 } };

  // ---- Remux fast path.
  if (o.remux !== false) {
    const c = remuxCandidate(doc, plan, size, id => assets.get(id), !!o.range);
    if ('item' in c) {
      const blob = (await resolveSource(o.store, c.item, 'export')).blob, tracks = await remuxTracks(blob, fps);
      if (tracks) return remux(o, { blob, tracks, size, fps, filename, messages, repaired, stats, t0, frames: plan.count, bitrate, durationS, asset: assets.get(String(c.item.metadata?.assetId))! });
      stats.remuxSkipped = 'the source tracks do not start together or differ in length';
    } else stats.remuxSkipped = c.reason;
  }

  // ---- Codecs, sink, output.
  let negotiated;
  try { negotiated = await negotiateVideo({ width: size.width, height: size.height, fps, bitrate }); }
  catch (e) { throw new ExportError('ENCODE_ERROR', (e as Error).message); }
  messages.push(...negotiated.messages);
  const withAudio = hasAudioStream(doc);
  const audio = withAudio ? await negotiateAudio(exportFaults.noAac ? async () => false : audioSupported) : null;
  if (withAudio && !audio) throw new ExportError('AUDIO_FAILED', `AudioEncoder: neither AAC-LC nor Opus ${AUDIO.sampleRate / 1000} kHz stereo is supported by this browser.`);
  if (audio?.message) messages.push(audio.message);
  const decoders = new ExportDecoders(o.forceWasm, o.maxDecoders);
  stats.decoders = decoders.stats;
  const mix = o.audio ?? exportMix(o.store, assets, { forceWasm: o.forceWasm });

  let sink: Sink | null = null, output: Output | null = null;
  let encoder: VideoEncoder | null = null, started = false, encodeError: Error | null = null, muxError: unknown = null;
  let mux: Promise<void> = Promise.resolve(), muxPending = 0;
  try {
    // The sink and the output are opened inside the try, so a failure while setting them up still releases the file.
    sink = await openSink({ handle: o.handle, estimate: estimateBytes(bitrate, durationS), storage: o.storage });
    messages.push(sink.message);
    output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
    const videoSource = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(videoSource, { frameRate: fps });
    const audioSource = audio ? new AudioSampleSource({ codec: audio.codec, bitrate: AUDIO.bitrate }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    setupFault();
    await output.start(); started = true;
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        const k = Math.round(chunk.timestamp * fps / 1e6), packet = new EncodedPacket(data, chunk.type, k / fps, 1 / fps);
        // The MP4 colour box is written from the decoder config: the frames are BT.709 limited range (i420.ts).
        const m = meta?.decoderConfig ? { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: BT709 } } : meta;
        muxPending++;
        mux = mux.then(() => videoSource.add(packet, m)).catch(e => { muxError ??= e; }).finally(() => { muxPending--; });
      },
      error: e => { encodeError ??= new ExportError('ENCODE_ERROR', `VideoEncoder error: ${e.message}`); },
    });
    encoder.configure(negotiated.config);

    // ---- Audio, about 1 s ahead of the video.
    const totalAudio = Math.round(durationS * SAMPLE_RATE), chunkFrames = durationS > CHUNKED_ABOVE_S ? CHUNK_S * SAMPLE_RATE : totalAudio;
    const baseMs = planTime(plan, plan.first);
    let pcm: Pcm | null = null, pcmStart = 0, audioDone = 0;
    const feedAudio = async (until: number) => {
      if (!audioSource) return;
      while (audioDone < Math.min(until, totalAudio)) {
        if (!pcm || audioDone >= pcmStart + pcm.data[0].length) {
          pcmStart = audioDone;
          const frames = Math.min(chunkFrames, totalAudio - audioDone), endMs = baseMs + (pcmStart + frames) / SAMPLE_RATE * 1000;
          try { pcm = await mix(doc, { startMs: baseMs + pcmStart / SAMPLE_RATE * 1000, frames }); } catch (e) { throw audioFailure(e); }
          stats.audioChunks++;
          mix.release?.(new Set(withCellItems(doc.items).filter(i => i.display.to > endMs).map(i => String(i.metadata?.assetId))));
        }
        const off = audioDone - pcmStart, n = Math.min(SAMPLE_RATE, pcm.data[0].length - off), planar = new Float32Array(n * 2);
        planar.set(pcm.data[0].subarray(off, off + n)); planar.set(pcm.data[1].subarray(off, off + n), n);
        const sample = new AudioSample({ data: planar, format: 'f32-planar', numberOfChannels: 2, sampleRate: SAMPLE_RATE, timestamp: audioDone / SAMPLE_RATE });
        try { await audioSource.add(sample); } catch (e) { throw audioFailure(e); } finally { sample.close(); }
        audioDone += n;
      }
    };

    // ---- Frame loop.
    const canvas = new OffscreenCanvas(size.width, size.height), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const i420 = new Uint8Array(size.width * size.height * 3 / 2), keyEvery = Math.max(1, Math.round(KEYFRAME_S * fps));
    const notRendered = new Map<string, Pending & { firstMs: number }>();
    const refs = new Map<string, Promise<VideoRef>>();
    const videoItems = withCellItems(doc.items).filter(i => i.type === 'video').map(item => ({ item, key: keyOf(item) }));
    const refOf = (item: RecordData, key = keyOf(item)) => {
      let r = refs.get(key);
      if (!r) { r = videoRef(o.store, item, assets.get(String(item.metadata?.assetId)), key); refs.set(key, r); r.catch(() => refs.delete(key)); }
      return r;
    };
    for (let n = plan.first; n < plan.first + plan.count; n++) {
      signal?.throwIfAborted();
      if (encodeError) throw encodeError;
      if (muxError) throw muxError;
      const k = n - plan.first, t = planTime(plan, n), ts = encodedTime(plan, n), time = stats.timing;
      let mark = performance.now();
      const lap = (key: keyof ExportStats['timing']) => { const now = performance.now(); time[key] += now - mark; mark = now; };
      await feedAudio(Math.ceil((ts + 1 + 1 / fps) * SAMPLE_RATE));
      lap('audioMs');
      const { draws, pending } = framePlan(doc, t, size);
      for (const p of pending) { const id = `${p.itemId}|${p.what}`; if (!notRendered.has(id)) notRendered.set(id, { ...p, firstMs: t }); }
      // Decoders: keep the sources due within the prefetch window, end the rest, open one upcoming source early.
      const current = new Set(videoDraws(draws).map(d => drawKey(d, draws))), needed = new Set(current);
      let upcoming: { item: RecordData; key: string } | undefined;
      for (const v of videoItems) {
        if (v.item.display.to <= t || v.item.display.from >= t + PREFETCH_S * 1000) continue;
        needed.add(v.key);
        if (!current.has(v.key) && v.item.display.from > t && !upcoming) upcoming = v;
      }
      decoders.retain(needed);
      if (upcoming && decoders.hasRoom && !decoders.isOpen(upcoming.key)) {
        const u = upcoming.item;
        void refOf(u).then(ref => decoders.frame(ref.ref, sourceTime(u, 0), current)).catch(() => undefined);
      }
      // The transition key is the draw's own item's; a layout's cells (T07) keep their own keys.
      const sources: Source[] = await Promise.all(draws.map(d => drawSource(o.store, d, item => refOf(item, item === d.item ? drawKey(d, draws) : undefined), decoders, current, assets.get(String(d.item.metadata?.assetId)))));
      lap('sourcesMs');
      // An item T10's effect stage could not draw is missing from the frame: the export fails with its code (§12 rows
      // WEBGL_UNSUPPORTED, CANVAS_TAINTED) rather than writing the file without it.
      const failed = composite(ctx, draws, sources, size, 'black');
      if (failed.length) throw new ExportError(failed[0].code ?? 'CLIENT_BUG', `${failed[0].message ?? failed[0].what} (item ${failed[0].itemId})`);
      decoders.sweep();
      lap('compositeMs');
      const image = ctx.getImageData(0, 0, size.width, size.height);
      lap('readbackMs');
      rgbaToI420(image.data, size.width, size.height, i420);
      const frame = new VideoFrame(i420, { format: 'I420', codedWidth: size.width, codedHeight: size.height, timestamp: Math.round(ts * 1e6), duration: Math.round(1e6 / fps), colorSpace: BT709 });
      lap('convertMs');
      while (!exportFaults.noBackpressure && encoder.encodeQueueSize >= MAX_ENCODE_QUEUE && !encodeError) { stats.encodeWaits++; await waitFor(encoder, 'dequeue', 250); }
      lap('encodeWaitMs');
      if (encodeError) { frame.close(); throw encodeError; }
      encoder.encode(frame, { keyFrame: k % keyEvery === 0 });
      frame.close();
      stats.maxEncodeQueue = Math.max(stats.maxEncodeQueue, encoder.encodeQueueSize);
      if (muxPending > MAX_MUX_PENDING) await mux;
      if (k % 30 === 0) { const h = heap(); if (h !== null) stats.heapPeakBytes = Math.max(stats.heapPeakBytes ?? 0, h); }
      if ((k + 1) % PROGRESS_EVERY === 0 || k + 1 === plan.count) progress(o, 'render', k + 1, plan.count, t0);
    }

    // ---- Finish: flush the encoder, close the sources, write the index, close the file.
    progress(o, 'finalize', plan.count, plan.count, t0);
    try { await encoder.flush(); } catch (e) { throw encodeError ?? new ExportError('ENCODE_ERROR', `VideoEncoder error during flush: ${(e as Error).message}`); }
    await mux;
    if (encodeError) throw encodeError;
    if (muxError) throw muxError;
    await feedAudio(totalAudio);
    encoder.close(); encoder = null;
    videoSource.close(); audioSource?.close();
    await output.finalize();
    const file = await sink.finish();
    stats.renderMs = performance.now() - t0;
    const h = heap(); if (h !== null) stats.heapPeakBytes = Math.max(stats.heapPeakBytes ?? 0, h);
    return {
      blob: file.blob, filename, sink: file.kind, sinkName: file.name, frames: plan.count, size, fps, codec: negotiated.config.codec, profile: negotiated.profile,
      audioCodec: audio?.codec ?? null, messages, repaired, notRendered: [...notRendered.values()], stats,
    };
  } catch (e) {
    if (encoder && encoder.state !== 'closed') try { encoder.close(); } catch { /* already closed */ }
    if (started) await output!.cancel().catch(() => undefined);
    await sink?.abort();
    throw e;
  } finally {
    decoders.closeAll();
    mix.close?.();
  }
}
/** Test hook exportFaults.failSetup: a failure after the sink and the output are set up, before the output starts. */
function setupFault() { if (exportFaults.failSetup) throw new ExportError('CLIENT_BUG', 'Test fault: export setup failed (exportFaults.failSetup).'); }

type VideoRef = { ref: { key: string; blob: Blob; rotation: 0 | 90 | 180 | 270; stackedAlpha: boolean }; fit: Size | null };
/** The video draws of a frame, a layout's video cells included (T07). */
const videoDraws = (draws: Draw[]): Draw[] => draws.flatMap(d => d.kind === 'video' ? [d] : (d.layout?.cells ?? []).flatMap(c => c.media?.draw.kind === 'video' ? [c.media.draw] : []));
/** The export's decoder key for an item: the asset's original, merged when stacked alpha (T15's mediaKey with 'original'). */
const keyOf = (item: RecordData) => `${item.metadata?.assetId}:original${isStackedAlpha(item) ? ':stacked' : ''}`;
/** T11 (performance fix): the incoming side of a transition pair whose outgoing side reads the same source gets its own
 *  decoder (key + ':to'), so one worker does not seek back and forth between the two source times on every frame. */
export const drawKey = (d: Draw, draws: Draw[]) => {
  const key = keyOf(d.item), tag = d.transition;
  return tag?.role === 'to' && draws.some(o => o.transition?.id === tag.id && o.transition.role === 'from' && keyOf(o.item) === key) ? `${key}:to` : key;
};
async function videoRef(store: ProjectStore, item: RecordData, asset: Asset | undefined, key: string): Promise<VideoRef> {
  const s = await resolveSource(store, item, 'export'), v = asset?.media?.video, stacked = isStackedAlpha(item);
  const w = v?.displayWidth ?? s.width, h = v?.displayHeight ?? s.height;
  return { ref: { key, blob: s.blob, rotation: (v?.rotation ?? 0) as 0 | 90 | 180 | 270, stackedAlpha: stacked }, fit: w && h ? { width: stacked ? w >> 1 : w, height: h } : null };
}
/** The draw kinds whose picture is T15's capture picture (render/sources.ts picture): images (the original bitmap, grey
 *  when it cannot be read), T08's motion graphics (capture's retry rule), T06's shapes and T05's texts (no source: the
 *  compositor draws them; a text's fonts are loaded before the frame loop); T07's layouts take each cell's picture by these
 *  rules (video cells from the export decoders). A kind added to Draw fails the typecheck here until it is listed. List a
 *  kind only once
 *  render/sources.ts picture() has a branch for it: otherwise picture() treats it as a video (T15's preview resolver,
 *  grey on failure). */
const PICTURE_KINDS: Record<Exclude<Draw['kind'], 'video'>, true> = { image: true, motionGraphic: true, shape: true, text: true, layout: true };
/** One draw's picture. Video: the export decoders; a decode failure fails the export (§12 DECODE_ERROR and the rest), it
 *  is never drawn grey. A motion graphic that still fails fails the export as MG_RENDER_FAILED with T08's text naming it.
 *  A kind the export does not know fails it as CLIENT_BUG, never as a video decode. */
export async function drawSource(store: ProjectStore, d: Draw, refOf: (i: RecordData) => Promise<VideoRef>, decoders: ExportDecoders, current: Set<string>, asset: Asset | undefined): Promise<Source> {
  if (d.kind === 'video') {
    const r = await refOf(d.item), f = await decoders.frame(r.ref, d.sourceMs, current);
    return { image: f.bitmap, width: r.fit?.width ?? f.width, height: r.fit?.height ?? f.height };
  }
  if (PICTURE_KINDS[d.kind] !== true) throw new ExportError('CLIENT_BUG', `The export cannot draw item ${d.item.id}: draw kind '${d.kind}' is not supported by the export.`);
  if (d.kind === 'layout') return { cells: await Promise.all((d.layout?.cells ?? []).map(c => c.media ? drawSource(store, c.media.draw, refOf, decoders, current, undefined) : null)) };
  const s = await picture(store, d, asset, 'capture');
  if (s !== null && s !== 'failed' && 'error' in s) throw new ExportError('MG_RENDER_FAILED', s.error);
  return s;
}
function progress(o: ExportOptions, phase: Progress['phase'], frame: number, frames: number, t0: number) {
  if (!o.onProgress) return;
  const elapsedMs = performance.now() - t0, done = frame / frames;
  o.onProgress({ phase, frame, frames, percent: Math.round(done * 1000) / 10, elapsedMs, etaMs: done > 0 ? elapsedMs / done * (1 - done) : null, fps: frame / (elapsedMs / 1000) });
}

type RemuxInput = {
  blob: Blob; tracks: NonNullable<Awaited<ReturnType<typeof remuxTracks>>>; size: Size; fps: number; filename: string; messages: string[]; repaired: string[];
  stats: ExportStats; t0: number; frames: number; bitrate: number; durationS: number; asset: Asset;
};
async function remux(o: ExportOptions, r: RemuxInput): Promise<ExportResult> {
  r.stats.path = 'remux';
  let sink: Sink | null = null, output: Output | null = null, started = false;
  try {
    sink = await openSink({ handle: o.handle, estimate: r.blob.size * 1.1, storage: o.storage });
    r.messages.push(sink.message, 'The timeline is one unedited clip: its video and audio were copied without re-encoding.');
    output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
    output.addVideoTrack(r.tracks.video, { frameRate: r.fps });
    output.addAudioTrack(r.tracks.audio);
    setupFault();
    await output.start(); started = true;
    await r.tracks.copy(n => { if (n % PROGRESS_EVERY === 0) progress(o, 'remux', Math.min(n, r.frames), r.frames, r.t0); }, o.signal);
    progress(o, 'finalize', r.frames, r.frames, r.t0);
    await output.finalize();
    const file = await sink.finish();
    r.stats.renderMs = performance.now() - r.t0;
    return {
      blob: file.blob, filename: r.filename, sink: file.kind, sinkName: file.name, frames: r.frames, size: r.size, fps: r.fps,
      codec: r.asset.media?.video?.codecString ?? 'avc', profile: 'source', audioCodec: 'aac', messages: r.messages, repaired: r.repaired, notRendered: [], stats: r.stats,
    };
  } catch (e) {
    if (started) await output!.cancel().catch(() => undefined);
    await sink?.abort();
    throw e;
  } finally {
    r.tracks.dispose();
  }
}
