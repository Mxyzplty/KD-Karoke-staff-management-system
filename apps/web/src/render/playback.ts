// SPDX-License-Identifier: AGPL-3.0-only
// Preview playback (findings §5, §7b.2; part 5 §53.8.3): play / pause on the togglePlayback intent; one master clock (the
// AudioContext's while it plays sound, else performance.now); one paint per new frame index round(t s × fps), on
// requestAnimationFrame.
// Picture while playing: muted <video> elements for browser-playable SDR sources (stacked alpha merged on WebGL2), the T04
// remap cache for remapped items, the decoder pool for HDR originals, unplayable sources and remapped items not cached yet,
// and for each clip start and each seek while playing until its element has caught up with the clock (the handoff, below).
// Motion graphics: the latest finished sandbox frame (mg/frames.ts liveGraphic; stale while the next one renders).
// Paused, seeked and captured frames always come from the decoder pool (sources.ts). Sound (T13, replacing Xapp's <audio>
// elements of §7b.2): the export's mix and limiter rendered ahead as Web Audio buffers (audio/preview.ts) on a 48 kHz context.
// Video elements are reused per source and made ahead of need (the element pool below).
// Provisional, not Xapp parity: PREROLL_MS, START_WAIT_MS, RESYNC_S, CATCH_UP, PREMOUNT_MS, MAX_IDLE, HANDOFF_SETTLE_MS,
// POOL_AHEAD, the end-of-timeline rule.
import { create } from 'zustand';
import type { ProjectStore } from '../store/database';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { PreviewAudio } from '../audio/preview';
import { clearAudioSources, storeAudioSource } from '../audio/source';
import { installIntentHandler } from '../editor/commands';
import { remapFrames } from '../editor/remap-cache';
import { setView, view } from '../editor/view';
import { clearLiveGraphics, liveGraphic } from '../mg/frames';
import { withCellItems } from '../timeline/layouts';
import { rateOf, remapKeyframes, sourceTime } from '../timeline/properties';
import type { Source } from './compositor';
import { cachedFrame, decodeFrame } from './decoder-pool';
import type { Frame } from './decoder-pool';
import { glMergeInto } from './gl-merge';
import { catchUpNudge, drawTracks, fpsOf, frameTime, mediaFrame, pickFrame, previewFrame } from './model';
import type { Draw } from './model';
import { imageBitmap, itemMedia, readyImage, readyMedia } from './sources';
import type { ItemMedia } from './sources';

/** Media elements mount this long before their clip; the start waits at most START_WAIT_MS for the visible ones; a video
 *  element more than RESYNC_S from the master clock is re-seeked, one more than a frame off plays CATCH_UP faster or slower
 *  until it is within half a frame (frames of media time at the clip's speed: model.ts mediaFrame). */
export const PREROLL_MS = 1500, START_WAIT_MS = 1000, RESYNC_S = 0.2, CATCH_UP = 0.1;
/** The element pool covers the clips that mount within the next PREMOUNT_MS and makes at most MAX_IDLE elements ahead of need. */
export const PREMOUNT_MS = 10_000, MAX_IDLE = 4;
/** A clip start (and a seek while playing) is drawn from the decoder pool, decoded POOL_AHEAD frames ahead, until its element
 *  has read within half a frame of the clock for HANDOFF_SETTLE_MS. */
export const HANDOFF_SETTLE_MS = 250, POOL_AHEAD = 8;
/** running: the clock runs (after the start-up wait; T13's voice-over starts recording then). */
export const usePlayback = create<{ playing: boolean; running: boolean }>(() => ({ playing: false, running: false }));
const zero = () => ({ starts: 0, painted: 0, skipped: 0, notReady: 0, stale: 0, failed: 0, resyncs: 0, seeks: 0, reanchors: 0, maxDriftMs: 0, elementMaxDriftMs: 0, driftMs: 0, poolDrawnFrames: 0, handoffs: 0, behindHandoffs: 0, handoffMs: [] as number[], unconverged: 0, droppedVideoFrames: 0, elements: 0, lateMounts: 0, sounds: 0, buffers: 0, lateChunks: 0, soundFailures: 0, firstFrame: -1, lastFrame: -1, maxRafGapMs: 0 });
/** Counters for tests and the 60 s check. skipped: frame indices never painted; notReady: draws with no picture yet; stale:
 *  draws that showed an older pool / remap / motion-graphic frame; failed: draws that showed the grey failed picture (P16); maxDriftMs: since the reset, the worst offset of a painted video frame,
 *  whichever path drew it: the presented media time of the frame drawn (an element's currentTime, a pool frame's timestamp,
 *  a remap-cache frame's source time) minus the expected media time at the paint's clock reading t (sourceTime at t − from);
 *  elementMaxDriftMs: the elements' own offset from the clock, read on every rAF whether drawn or not (information only);
 *  driftMs: the largest element offset on the latest rAF; poolDrawnFrames: video draws from the decoder pool; handoffs /
 *  handoffMs: clip starts and seeks while playing that moved from the pool to their element, and the clip ms each took from
 *  the element's first play() or the seek; behindHandoffs: those of them made early because the pool fell behind; unconverged: those still drawn from the pool when they unmounted; droppedVideoFrames: the elements' own
 *  counts, added when they park or are released; elements: <video> elements made; lateMounts: media elements made while the
 *  clock runs (after a paint); sounds: clips whose sound the mix read, once per clip per run; buffers: chunks with sound
 *  made; lateChunks: chunks that started after their time (cut short) or were dropped; soundFailures: source reads that
 *  failed (that clip is silent); maxRafGapMs: the longest gap between two animation frames of one run (a stall). */
export const playbackStats = zero();
/** Diagnostics, kept apart from the counters: the latest DRIFT_LOG painted video frames since the reset, each with the paint's
 *  clock reading t (timeline ms), the signed offset driftMs (presented minus expected media time; negative = behind), the path
 *  that drew it, and the animation-frame gap before that paint. A stall shows gapMs about equal to driftMs; a sustained offset
 *  shows many entries with small gaps. */
type DriftEntry = { t: number; driftMs: number; path: 'element' | 'pool' | 'remap'; gapMs: number };
const DRIFT_LOG = 600;
export const driftLog: DriftEntry[] = [];
export const resetPlaybackStats = () => { Object.assign(playbackStats, zero()); driftLog.length = 0; };

/** The editor's side: the store, the live document and assets, and the paint of timeline ms t with livePicture sources. */
export type PlaybackHost = { store: ProjectStore; doc: () => ProjectDocument; asset: (id: string) => Asset | undefined; paint: (tMs: number) => void };
let host: PlaybackHost | null = null, audio: AudioContext | null = null;

// ---- Master clock: both readings are kept at the anchor, so a context that starts or stops running re-anchors seamlessly.
// The context counts only while it plays sound (audio/preview.ts audible: sound started, the last of it under HOLD_MS ago):
// Chromium swaps a silent context's sink for a timer after ~30 s, and that timer drops ticks under load, so the picture
// would slow down.
type Anchor = { t: number; perf: number; ctx: number | null };
let anchor: Anchor | null = null, ctxClock = false;
const audioMs = () => ctxClock && audio?.state === 'running' ? audio.currentTime * 1000 : null;
const setAnchor = (t: number) => { anchor = { t, perf: performance.now(), ctx: audioMs() }; };
function clock() {
  const a = anchor!, c = audioMs();
  return a.ctx !== null && c !== null ? a.t + c - a.ctx : a.t + performance.now() - a.perf;
}
/** Switches the clock to the context when its sound starts, and back to performance.now when the sound stops, where the
 *  clock is (no step). The sound starts where the picture is: while quiet its mapping follows this clock (sound.follow). */
function followContext() {
  const loud = !!sound?.audible();
  if (loud === ctxClock) return;
  const t = anchor ? clock() : 0;
  ctxClock = loud;
  if (!anchor) return;
  setAnchor(t);
  playbackStats.reanchors++;
}

// ---- Media elements, reused per source (findings §5: Xapp also paints from <video> elements). Starting one stalls Chromium's
// main thread for ~40-50 ms (its media player starts; T15 notes), longer than a 30 fps frame, so elements are made outside
// playback where they can be: one that unmounts parks under its source for the next clip of it, and fillPool makes the
// elements the clips mounting within PREMOUNT_MS will need (at play start and on pause; nearest first, at most MAX_IDLE ahead
// of need) and drops the rest. While playing, fillPool runs right after each frame paint and makes at most one element, so its
// stall ends before the next frame index is due. Provisional design, not Xapp parity: PREMOUNT_MS, MAX_IDLE, nearest first.
const idle = new Map<string, HTMLVideoElement[]>(), counted = new WeakMap<HTMLVideoElement, number>();
function release(el: HTMLMediaElement) { el.pause(); el.removeAttribute('src'); el.load(); }
/** Adds the frames a <video> element dropped since it was last counted (an element serves several clips). */
function countDropped(el: HTMLVideoElement) {
  const n = el.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
  playbackStats.droppedVideoFrames += n - (counted.get(el) ?? 0); counted.set(el, n);
}
function discard(el: HTMLVideoElement) { countDropped(el); release(el); }
function makeElement(m: ItemMedia): HTMLVideoElement {
  const key = m.ref.key, el = document.createElement('video');
  el.muted = true; el.playsInline = true;
  el.preload = 'auto'; el.src = m.url();
  el.addEventListener('error', () => elementFailed(key, el));
  playbackStats.elements++;
  if (anchor) playbackStats.lateMounts++;
  return el;
}
/** A source an element cannot play: its pictures move to the decoder pool. */
function elementFailed(key: string, el: HTMLVideoElement) {
  unplayable.add(key);
  const list = idle.get(key), i = list?.indexOf(el) ?? -1;
  if (i >= 0) { list!.splice(i, 1); release(el); return; }
  for (const c of videos.values()) if (c.el === el) c.failed = true;
}
/** A parked element of m's source, else a new one when `make` (not while the clock runs: fillPool makes it after the paint). */
function take(m: ItemMedia, make: boolean): HTMLVideoElement | null {
  return idle.get(m.ref.key)?.pop() ?? (make ? makeElement(m) : null);
}
function park(key: string, el: HTMLVideoElement) {
  if (unplayable.has(key)) { discard(el); return; }
  el.pause(); countDropped(el);
  const list = idle.get(key);
  if (list) list.push(el); else idle.set(key, [el]);
}
/** Whether an item's picture plays through an element (visible video track, element mode). */
const pictured = (item: RecordData, m: ItemMedia, picture: Set<string>) => item.type === 'video' && picture.has(item.trackId) && elementMode(item, m);
/** Keeps parked the elements the clips mounting over [t, t + PREMOUNT_MS] need beyond the mounted ones, in time order: a need
 *  at t (a clip mounted without its element) always, later ones nearest first up to MAX_IDLE. Drops the other parked elements
 *  and makes at most `make` new ones. */
function fillPool(t: number, make: number) {
  const h = host!, doc = h.doc(), picture = new Set(drawTracks(doc)), spans = new Map<string, { m: ItemMedia; at: [number, number][] }>();
  for (const item of withCellItems(doc.items)) {
    const { from, to } = item.display;
    if (to <= t || from - PREROLL_MS >= t + PREMOUNT_MS || item.type !== 'video') continue;
    const asset = h.asset(String(item.metadata?.assetId)), m = readyMedia(item, asset);
    if (!m) { void itemMedia(h.store, item, asset).catch(() => {}); continue; }
    if (!pictured(item, m, picture)) continue;
    const span: [number, number] = [Math.max(t, from - PREROLL_MS), to], s = spans.get(m.ref.key);
    if (s) s.at.push(span); else spans.set(m.ref.key, { m, at: [span] });
  }
  const mounted = new Map<string, number>();
  for (const c of videos.values()) mounted.set(c.key, (mounted.get(c.key) ?? 0) + 1);
  const needs: { at: number; slot: string }[] = [];
  for (const [slot, s] of spans) {
    // Ends before starts at one time: a clip that ends then hands its element to one that mounts then.
    const events = s.at.flatMap(([a, b]) => [[a, 1], [b, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let n = 0, have = mounted.get(slot) ?? 0;
    for (const [at, d] of events) { n += d; for (; n > have; have++) needs.push({ at, slot }); }
  }
  needs.sort((a, b) => a.at - b.at);
  let ahead = 0;
  const kept = needs.filter(x => x.at <= t || ahead++ < MAX_IDLE), keep = new Map<string, number>();
  for (const x of kept) keep.set(x.slot, (keep.get(x.slot) ?? 0) + 1);
  for (const [slot, list] of idle) {
    while (list.length > (keep.get(slot) ?? 0)) discard(list.pop()!);
    if (!list.length) idle.delete(slot);
  }
  const met = new Map<string, number>();
  for (const x of kept) {
    if (make <= 0) break;
    const k = (met.get(x.slot) ?? 0) + 1, s = spans.get(x.slot)!;
    met.set(x.slot, k);
    if ((idle.get(x.slot)?.length ?? 0) >= k) continue;
    const list = idle.get(x.slot), el = makeElement(s.m);
    if (list) list.push(el); else idle.set(x.slot, [el]);
    make--;
  }
}
/** Every element mounted or parked. */
const allElements = () => [...[...videos.values()].map(c => c.el), ...[...idle.values()].flat()];
function clearPool() { for (const list of idle.values()) for (const el of list) discard(el); idle.clear(); }

// ---- Video elements (picture only, muted), one per clip at a time. Each clip start and each seek while playing is drawn from
// the decoder pool until the handoff: the element has played and read within half a frame of the clock for HANDOFF_SETTLE_MS;
// from then on the element draws it, kept there by CATCH_UP and resync. Reason (T15 notes, measured): a muted <video> of a
// source with an audio track holds ~40 ms at each start and 60–78 ms after a seek while playing (S2); a source without audio
// does not hold at its start.
/** pool: still drawn from the decoder pool; start: clip ms at the element's first play() or at a seek while playing (NaN
 *  before); inBound: performance.now() since which the element has read within half a frame (NaN while it does not). */
type Clip = { key: string; item: RecordData; el: HTMLVideoElement; merged: OffscreenCanvas | null; failed: boolean; nudge: number; pool: boolean; start: number; inBound: number };
const videos = new Map<string, Clip>(), unplayable = new Set<string>();
const elementMode = (item: RecordData, m: ItemMedia) => !m.hdr && !remapKeyframes(item).length && !unplayable.has(m.ref.key);
function unmountVideo(id: string) {
  const c = videos.get(id)!;
  if (c.pool && !c.failed && !Number.isNaN(c.start)) playbackStats.unconverged++; // played, never handed off
  videos.delete(id); park(c.key, c.el);
}
/** The clip's first frame index (its first paint). */
function firstIndex(item: RecordData, fps: number) {
  const n = previewFrame(item.display.from, fps);
  return frameTime(n, fps) < item.display.from ? n + 1 : n;
}
/** Returns true while a clip visible at t still has no picture to start with. */
function syncVideo(item: RecordData, m: ItemMedia, t: number, starting: boolean): boolean {
  let c = videos.get(item.id);
  if (c && c.key !== m.ref.key) { unmountVideo(item.id); c = undefined; } // Use Proxy changed: the source is swapped
  const local = t - item.display.from, expected = sourceTime(item, Math.max(0, local)) / 1000, fps = fpsOf(host!.doc()), oneFrame = mediaFrame(fps, rateOf(item));
  // Preroll and start wait: the pool decodes the first frames it draws at the clip start.
  const missing = local < 0 || starting ? decodeAhead(item, m, Math.max(previewFrame(t, fps), firstIndex(item, fps)), fps) : 0;
  if (!c) {
    const el = take(m, starting);
    if (!el) return false; // made after the next paint; the decoder pool shows the clip until then
    el.currentTime = expected;
    videos.set(item.id, c = { key: m.ref.key, item, el, merged: null, failed: false, nudge: 0, pool: true, start: NaN, inBound: NaN });
  }
  c.item = item;
  const el = c.el;
  // A source the element decodes without a picture (an unsupported video codec in a playable container) uses the pool.
  if (el.readyState >= 1 && !el.videoWidth && !c.failed) { unplayable.add(c.key); c.failed = true; }
  if (c.failed) return false;
  if (local < 0 || starting) return local >= 0 && (el.readyState < 3 || missing > 0); // preroll: held at the clip's first frame
  // The first play() after the clip start or a start from t: from the clock's position, not the held frame, when that is more
  // than half a frame (media time) off (a smaller seek would only flush the decoder).
  if (Number.isNaN(c.start)) { c.start = local; if (Math.abs(el.currentTime - expected) > oneFrame / 2) el.currentTime = expected; }
  if (el.paused && !el.ended) void el.play().catch(() => {});
  if (!el.seeking && el.readyState >= 2) {
    const off = el.currentTime - expected, drift = Math.abs(off);
    playbackStats.elementMaxDriftMs = Math.max(playbackStats.elementMaxDriftMs, drift * 1000); playbackStats.driftMs = Math.max(playbackStats.driftMs, drift * 1000);
    if (drift > RESYNC_S) { el.currentTime = expected; c.nudge = 0; playbackStats.resyncs++; }
    // A start or clip change leaves the element a few frames off: play ±CATCH_UP faster / slower until within half a frame.
    else c.nudge = catchUpNudge(off, c.nudge, oneFrame);
    if (c.pool) {
      const now = performance.now();
      if (drift >= oneFrame / 2) c.inBound = NaN;
      else if (Number.isNaN(c.inBound)) c.inBound = now;
      else if (now - c.inBound >= HANDOFF_SETTLE_MS) { c.pool = false; playbackStats.handoffs++; playbackStats.handoffMs.push(Math.round(local - c.start)); }
    }
  } else c.inBound = NaN; // no reading (seeking, too little data): the settle window starts again
  const rate = rateOf(item) * (1 + c.nudge * CATCH_UP);
  if (el.playbackRate !== rate) el.playbackRate = rate;
  return false;
}

// ---- Sound (T13): one PreviewAudio per run (play, or a seek while playing), primed during the start wait, begun with the
// clock, pumped on every animation frame.
let sound: PreviewAudio | null = null;
const heard = new Set<string>();
function makeSound(h: PlaybackHost): PreviewAudio | null {
  if (!audio) return null;
  const source = storeAudioSource(h.store, h.asset);
  return new PreviewAudio(audio, (item, a, b) => source(item, a, b).catch(() => { playbackStats.soundFailures++; return null; }), h.doc, {
    sound: id => { if (!heard.has(id)) { heard.add(id); playbackStats.sounds++; } },
    buffer: () => { playbackStats.buffers++; },
    late: () => { playbackStats.lateChunks++; },
    failed: () => { playbackStats.soundFailures++; },
  });
}

// ---- Pictures for the frame at t: mounts what plays within PREROLL_MS, drops the rest. Returns the visible clips still
// waiting for a first picture (the start wait).
function syncMedia(t: number, starting: boolean): number {
  const h = host!, doc = h.doc(), picture = new Set(drawTracks(doc)), live = new Set<string>(), mounts: [RecordData, ItemMedia][] = [];
  let waiting = 0;
  for (const item of withCellItems(doc.items)) {
    const { from, to } = item.display;
    if (!(from - PREROLL_MS <= t && t < to) || item.type !== 'video') continue;
    const asset = h.asset(String(item.metadata?.assetId)), m = readyMedia(item, asset);
    if (!m) { void itemMedia(h.store, item, asset).catch(() => {}); if (from <= t && picture.has(item.trackId)) waiting++; continue; }
    if (!pictured(item, m, picture)) continue;
    live.add(item.id); mounts.push([item, m]);
  }
  // Unmounts first: an element that leaves parks in time for a clip of its source that mounts now.
  for (const id of [...videos.keys()]) if (!live.has(id)) unmountVideo(id);
  for (const [item, m] of mounts) if (syncVideo(item, m, t, starting)) waiting++;
  return waiting;
}

// ---- Pictures while playing (synchronous; the paint never waits).
let paintClock = 0, rafGap = 0; // the master clock reading of the paint in progress, and the animation-frame gap before it
/** One painted video frame: its presented media time (s) against the expected one at the paint's clock reading. */
function drawn(item: RecordData, presentedS: number, path: DriftEntry['path']) {
  const expected = sourceTime(item, Math.max(0, paintClock - item.display.from)) / 1000, off = (presentedS - expected) * 1000;
  playbackStats.maxDriftMs = Math.max(playbackStats.maxDriftMs, Math.abs(off));
  driftLog.push({ t: Math.round(paintClock * 10) / 10, driftMs: Math.round(off * 10) / 10, path, gapMs: Math.round(rafGap * 10) / 10 });
  if (driftLog.length > DRIFT_LOG) driftLog.shift();
}
/** Starts decoding the pool frames of a clip's frame indices n … n + POOL_AHEAD − 1 (the paint's own source times, so its draws
 *  find them cached); returns how many are not cached yet. */
function decodeAhead(item: RecordData, m: ItemMedia, n: number, fps: number, end = item.display.to): number {
  let missing = 0;
  for (let k = n; k < n + POOL_AHEAD; k++) {
    const ft = frameTime(k, fps);
    if (ft >= end) break;
    const ms = sourceTime(item, ft - item.display.from);
    if (cachedFrame(m.ref.key, ms)) continue;
    missing++; void decodeFrame(m.ref, ms).catch(() => {});
  }
  return missing;
}
const latest = new Map<string, { frame: Frame | 'failed'; ms: number }>(), inflight = new Set<string>();
/** T11 (§55.3): a transition draw outside the clip's own range (source handles, then a frozen end frame). Its element is not
 *  mounted or parked at the start, so it comes from the decoder pool, with no drift entry (the clock is not its time). */
const extended = (d: Draw) => d.local < 0 || d.local >= d.item.display.to - d.item.display.from;
function poolPicture(d: Draw, m: ItemMedia): Source {
  const id = d.item.id, fps = fpsOf(host!.doc()), hit = cachedFrame(m.ref.key, d.sourceMs), held = latest.get(id)?.frame;
  // The cache's LRU closes the bitmaps it evicts (width 0), which then draw nothing: such a frame is decoded again.
  if (held && held !== 'failed' && !held.bitmap.width) latest.delete(id);
  if (hit) latest.set(id, { frame: hit, ms: d.sourceMs });
  else if (!inflight.has(id) && latest.get(id)?.ms !== d.sourceMs) {
    inflight.add(id);
    const ms = d.sourceMs;
    decodeFrame(m.ref, ms).then(frame => { latest.set(id, { frame, ms }); }, () => { latest.set(id, { frame: 'failed', ms }); }).finally(() => inflight.delete(id));
  }
  decodeAhead(d.item, m, previewFrame(d.local + d.item.display.from, fps) + 1, fps, d.transition ? Infinity : d.item.display.to);
  const have = latest.get(id);
  if (!have) { playbackStats.notReady++; return null; }
  if (have.ms !== d.sourceMs) playbackStats.stale++;
  if (have.frame === 'failed') { playbackStats.failed++; return 'failed'; }
  playbackStats.poolDrawnFrames++; if (!extended(d)) drawn(d.item, have.frame.ts, 'pool');
  return { image: have.frame.bitmap, width: m.fit?.width ?? have.frame.width, height: m.fit?.height ?? have.frame.height };
}
/** T04's remap cache: the export pick over the cached source times; a few neighbours either way are decoded ahead. */
type Strip = { frames: Blob[]; bitmaps: Map<number, ImageBitmap | 'loading'>; shown: number };
const strips = new Map<string, Strip>(), BEHIND = 3, AHEAD = 6;
const closeStrip = (s: Strip) => { for (const b of s.bitmaps.values()) if (b !== 'loading') b.close(); s.bitmaps.clear(); };
function remapPicture(d: Draw, m: ItemMedia): Source | undefined {
  const cache = remapFrames(d.item.id);
  if (!cache) return undefined;
  let s = strips.get(d.item.id);
  if (!s || s.frames !== cache.frames) { if (s) closeStrip(s); strips.set(d.item.id, s = { frames: cache.frames, bitmaps: new Map(), shown: -1 }); }
  const strip = s, k = pickFrame(cache.times, d.sourceMs);
  for (const [i, b] of strip.bitmaps) if ((i < k - BEHIND - 2 || i > k + AHEAD + 2) && b !== 'loading') { b.close(); strip.bitmaps.delete(i); }
  for (let i = Math.max(0, k - BEHIND); i <= Math.min(cache.frames.length - 1, k + AHEAD); i++) {
    if (strip.bitmaps.has(i)) continue;
    strip.bitmaps.set(i, 'loading');
    void createImageBitmap(cache.frames[i]).then(b => { if (strips.get(d.item.id) === strip && strip.bitmaps.get(i) === 'loading') strip.bitmaps.set(i, b); else b.close(); }, () => strip.bitmaps.delete(i));
  }
  let b = strip.bitmaps.get(k);
  if (!(b instanceof ImageBitmap)) {
    const old = strip.bitmaps.get(strip.shown);
    if (!(old instanceof ImageBitmap)) { playbackStats.notReady++; return null; }
    playbackStats.stale++; b = old;
  } else strip.shown = k;
  if (!extended(d)) drawn(d.item, cache.times[strip.shown] / 1000, 'remap');
  return { image: b, width: m.fit?.width ?? b.width, height: m.fit?.height ?? b.height };
}
/** The pool phase ends early when the pool has fallen behind: it lacks this paint's frame, its latest frame is more than one
 *  frame off the clock, and the playing element is closer. Under load the pool can decode slower than real time while the
 *  element never settles within ½ frame; without this the pool's offset grew to seconds (T15 notes, gate 3 drift). */
function poolBehind(c: Clip, d: Draw, m: ItemMedia): boolean {
  const el = c.el, have = latest.get(d.item.id);
  if (el.paused || el.seeking || el.readyState < 2 || !el.videoWidth || !have || have.frame === 'failed' || cachedFrame(m.ref.key, d.sourceMs)) return false;
  const expected = sourceTime(d.item, Math.max(0, paintClock - d.item.display.from)) / 1000, pool = Math.abs(have.frame.ts - expected);
  return pool > 1 / fpsOf(host!.doc()) && Math.abs(el.currentTime - expected) < pool;
}
/** The picture of one draw while playing: what is ready now (null = nothing yet, the item is not drawn this frame). */
export function livePicture(d: Draw): Source {
  const h = host!;
  if (d.kind === 'shape' || d.kind === 'text') return null; // T06 / T05: drawn by the compositor, no source
  if (d.kind === 'layout') return { cells: (d.layout?.cells ?? []).map(c => c.media ? livePicture(c.media.draw) : null) }; // T07
  if (d.kind === 'motionGraphic') {
    const g = liveGraphic(h.store, d);
    if (g.failed) playbackStats.failed++; else if (!g.source) playbackStats.notReady++; else if (!g.exact) playbackStats.stale++;
    return g.source;
  }
  if (d.kind === 'image') {
    const b = readyImage(d.item);
    if (b === undefined) { void imageBitmap(h.store, d.item); playbackStats.notReady++; return null; }
    if (b === 'failed') { playbackStats.failed++; return b; }
    return { image: b, width: b.width, height: b.height };
  }
  const asset = h.asset(String(d.item.metadata?.assetId)), m = readyMedia(d.item, asset);
  if (!m) { void itemMedia(h.store, d.item, asset).catch(() => {}); playbackStats.notReady++; return null; }
  const c = extended(d) ? undefined : videos.get(d.item.id);
  if (c && c.key === m.ref.key && !c.failed && c.pool && poolBehind(c, d, m)) {
    c.pool = false; playbackStats.handoffs++; playbackStats.behindHandoffs++;
    playbackStats.handoffMs.push(Math.round(paintClock - d.item.display.from - c.start));
  }
  if (c && c.key === m.ref.key && !c.failed && !c.pool) {
    const el = c.el;
    if (el.readyState < 2 || !el.videoWidth) { playbackStats.notReady++; return null; }
    if (!d.stackedAlpha) { drawn(d.item, el.currentTime, 'element'); return { image: el, width: m.fit?.width ?? el.videoWidth, height: m.fit?.height ?? el.videoHeight }; }
    c.merged ??= new OffscreenCanvas(2, 2);
    if (glMergeInto(el, el.videoWidth, el.videoHeight, c.merged)) { drawn(d.item, el.currentTime, 'element'); return { image: c.merged, width: m.fit?.width ?? el.videoWidth >> 1, height: m.fit?.height ?? el.videoHeight }; }
    unplayable.add(c.key); c.failed = true; // no WebGL2: the merge pool shows it
  }
  return remapPicture(d, m) ?? poolPicture(d, m);
}

// ---- Play / pause.
let raf = 0, startToken = 0, lastIndex: number | null = null, lastSet = NaN, lastRaf = NaN;
const isPlaying = () => usePlayback.getState().playing;
function frame() {
  if (!host || !anchor) return;
  raf = requestAnimationFrame(frame);
  const now = performance.now();
  rafGap = Number.isNaN(lastRaf) ? 0 : now - lastRaf; lastRaf = now;
  playbackStats.maxRafGapMs = Math.max(playbackStats.maxRafGapMs, rafGap);
  const doc = host.doc(), fps = fpsOf(doc), end = doc.duration ?? 0;
  // A seek while playing (the timeline, a shortcut, an agent) moves the clock; elements and sounds follow it.
  if (view().playheadMs !== lastSet) return seek(view().playheadMs);
  let t = clock();
  const done = t >= end;
  if (done) t = end;
  playbackStats.driftMs = 0; syncMedia(t, false); if (!ctxClock) sound?.follow(t); sound?.pump(); followContext();
  const n = previewFrame(t, fps);
  if (n !== lastIndex) {
    if (lastIndex !== null && n > lastIndex + 1) playbackStats.skipped += n - lastIndex - 1;
    lastIndex = n;
    if (playbackStats.firstFrame < 0) playbackStats.firstFrame = n;
    playbackStats.lastFrame = n; playbackStats.painted++;
    const ft = Math.min(frameTime(n, fps), end);
    paintClock = t; host.paint(ft); lastSet = ft; setView({ playheadMs: ft });
    fillPool(t, 1); // right after the paint: a new element's start-up stall ends before the next frame index is due
  }
  if (done) { pause(); setView({ playheadMs: end }); }
}
/** A seek while playing starts again from t as play() does: the element holds after a seek as at a clip start (T15 notes,
 *  measured on S2), so the clock waits for the pool's first frames at t and the pool draws until the handoff. Provisional:
 *  the last painted frame stays on screen during the wait. */
function seek(t: number) {
  const token = ++startToken;
  cancelAnimationFrame(raf); raf = 0; anchor = null; playbackStats.seeks++;
  stopMedia();
  void start(t, token);
}
async function play() {
  const h = host!, doc = h.doc(), token = ++startToken;
  // Provisional: play at or after the end restarts from 0.
  let t = view().playheadMs;
  if (t >= (doc.duration ?? 0)) { t = 0; setView({ playheadMs: 0 }); }
  if (!audio) { audio = new AudioContext({ sampleRate: 48000 }); audio.onstatechange = () => { if (anchor) { setAnchor(clock()); playbackStats.reanchors++; } }; }
  void audio.resume().catch(() => {});
  usePlayback.setState({ playing: true }); playbackStats.starts++;
  await start(t, token);
}
/** The paused frame stays on screen while the visible clips load, the elements made for the next PREMOUNT_MS load their
 *  metadata (so their start-up stalls end before the clock runs) and the first sound chunk renders, at most START_WAIT_MS.
 *  A seek during the wait is taken by the first frame. */
async function start(t: number, token: number) {
  const until = performance.now() + START_WAIT_MS, run = sound = makeSound(host!);
  for (;;) {
    const waiting = syncMedia(t, true);
    fillPool(t, Infinity);
    void run?.prime(t);
    if (!(waiting > 0 || (run && !run.primed) || allElements().some(el => el.readyState < 1 && !el.error)) || performance.now() >= until) break;
    await new Promise(r => setTimeout(r, 16));
    if (token !== startToken) return;
  }
  run?.begin(); followContext(); setAnchor(t); lastIndex = null; lastSet = t; lastRaf = NaN;
  usePlayback.setState({ running: true });
  frame();
}
/** Video elements unmount, the sound stops, and the pool / remap frames drawn while playing are forgotten (pause, a seek
 *  while playing). */
function stopMedia() {
  for (const id of [...videos.keys()]) unmountVideo(id);
  sound?.stop(); sound = null; heard.clear();
  for (const s of strips.values()) closeStrip(s);
  strips.clear(); latest.clear(); clearLiveGraphics();
}
/** Stops at once; the playhead stays on the last painted frame (provisional). Elements and sounds unmount; the pool keeps
 *  (or makes) the elements the next PREMOUNT_MS from the playhead needs and releases the rest. */
function pause() {
  startToken++; cancelAnimationFrame(raf); raf = 0; anchor = null;
  stopMedia();
  usePlayback.setState({ playing: false, running: false });
  if (host) fillPool(view().playheadMs, Infinity);
}
/** Connects playback to the open editor; the returned function detaches it (pauses, closes the audio context). */
export function attachPlayback(next: PlaybackHost): () => void {
  host = next;
  const uninstall = installIntentHandler(intent => {
    if (intent.type !== 'togglePlayback' || host !== next) return undefined;
    if (isPlaying()) pause(); else void play();
    return { ok: true };
  });
  return () => {
    uninstall();
    if (host !== next) return;
    host = null; pause(); clearPool(); unplayable.clear(); clearAudioSources();
    void audio?.close().catch(() => {}); audio = null;
  };
}
