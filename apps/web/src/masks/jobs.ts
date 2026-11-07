// SPDX-License-Identifier: AGPL-3.0-only
// T12 mask jobs (part 3 §44.7, findings §19, §20; ticket "length rule"). One job runs at a time in one mask worker, the others wait,
// and each keeps a row in Background Jobs. A job belongs to this tab: there is no client time-out shorter than the job (BG-P06; Xapp
// attaches nothing after about 5 minutes, not copied), Cancel terminates the worker and attaches nothing, and closing the project ends
// its jobs (a local job has no account queue to come back to; documented difference). The worker stays loaded between jobs, so the
// next job and a preview start warm, until it closes: a closed worker is replaced for the next job. A failed or cancelled job writes
// nothing to the document, and a job whose source changed while it ran is a failed one (MASK_SOURCE_CHANGED).
import { create } from 'zustand';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import type { CommandBus, Source } from '../timeline/bus';
import { timelineChanges } from '../timeline/changes';
import { effectStack } from '../timeline/effects';
import { CommandError, fail, item, newId, span } from '../timeline/model';
import { remapKeyframes, sorted, sourceTime } from '../timeline/properties';
import type { Raster, Stroke } from './engine';
import { masksOf } from './model';
import type { RasterRef, StoredMask } from './model';
import { MASK_CODES, MaskError } from './protocol';
import type { AutoResult, MaskFrame, MaskPreview, MaskRequest, MaskResult, MaskSource, Rotation } from './protocol';
import { maskable, maskRecord } from './tools';

export type OnProgress = (done: number, total: number) => void;
export type MaskEngine = { readonly closed?: boolean; run<T extends MaskResult>(request: MaskRequest, progress?: OnProgress): Promise<T>; close(error?: Error): void };
/** The project's media originals and raster mask files. */
export type MaskMedia = { read(assetId: string): Promise<Blob>; writeMask(file: string, data: Blob): Promise<void> };
export type MaskJobState = 'waiting' | 'processing' | 'done' | 'failed' | 'cancelled';
export type MaskJob = { id: string; kind: 'removal' | 'smart'; itemId: string; label: string; state: MaskJobState; percent: number; detail: string; code?: string };
/** Who a job works for: its document writes run as this source, inside `scoped` when given (the executor's agent attribution). */
export type MaskContext = { bus: CommandBus; asset(id: string): Asset | undefined; origin: Source; scoped?<T>(run: () => T): T };
export type SourceRange = { startUs: number; endUs: number };
export type Attached = { itemId: string; maskId: string; maskIndex: number; raster: RasterRef; timelineChanges?: RecordData };

/** Background removal's codes: ours, with the meaning of Xapp's AUTO_FOREGROUND_EMPTY for the second (contracts removeBackground). */
export const REMOVAL_CODES = { tooLong: 'REMOVE_BG_TOO_LONG', noForeground: 'FOREGROUND_NOT_FOUND' } as const;
export const NO_FOREGROUND = 'No reliable foreground was found. Pick a clearer frame or use a stroke-based Smart Mask.';
export const SOURCE_CHANGED = 'The source changed while this job ran. Nothing was attached.';
const REMOVAL_LIMIT_US = 300_000_000, TRACK_LIMIT_US = 60_000_000, TEXT_LIMIT_US = 30_000_000, TRACK_FRAMES = 1800, DEFAULT_FPS = 30, STEPS = 64, REFINE = 32;
const WAITING = 'Waiting for a worker', WORKING = { removal: 'Processing mask', smart: 'Following your selection' } as const;

export const useMaskJobs = create<{ jobs: MaskJob[] }>(() => ({ jobs: [] }));
const setJob = (id: string, patch: Partial<MaskJob>) => useMaskJobs.setState(s => ({ jobs: s.jobs.map(j => j.id === id ? { ...j, ...patch } : j) }));
export const dismissMaskJob = (id: string) => useMaskJobs.setState(s => ({ jobs: s.jobs.filter(j => j.id !== id) }));
/** The removal an item's Remove Background row follows: it goes back to Apply when this is undefined. */
export const activeRemoval = (jobs: MaskJob[], itemId: string) => jobs.find(j => j.kind === 'removal' && j.itemId === itemId && (j.state === 'waiting' || j.state === 'processing'));

type Task = { id?: string; cancelled: boolean; go(engine: MaskEngine): Promise<void>; abort(error: Error): void };
const line: Task[] = [];
let running: Task | null = null, engine: Promise<MaskEngine> | null = null, media: MaskMedia | null = null;
let makeEngine: () => Promise<MaskEngine> = async () => new (await import('./worker-client')).MaskWorker();
const cancelled = () => new MaskError(MASK_CODES.cancelled, 'Cancelled.');
/** A worker that closed, by a crash or a cancel, is never used again. */
async function open(): Promise<MaskEngine> {
  const p = engine ??= makeEngine().catch(e => { engine = null; throw e; }), e = await p;
  if (!e.closed) return e;
  if (engine === p) engine = null;
  return open();
}
const closeEngine = () => { void engine?.then(e => e.close(), () => undefined); engine = null; };
function next() {
  if (running) return;
  const t = line.shift();
  if (!t) return;
  running = t;
  void open().then(e => t.cancelled ? undefined : t.go(e), e => t.abort(e as Error)).finally(() => { if (running === t) running = null; next(); });
}
/** A stopped job lets the queue go at once: what it still waits for (a slow source read) cannot hold the next job, and finds it cancelled when it lands. */
function halt(t: Task) {
  t.cancelled = true;
  t.abort(cancelled());
  if (running === t) running = null;
  closeEngine();
  next();
}
/** Tests: the seam the real worker sits behind. */
export function useMaskEngine(make: () => Promise<MaskEngine>) { makeEngine = make; }
function stopAll() {
  for (const t of line.splice(0)) t.abort(cancelled());
  if (running) halt(running); else closeEngine();
}
/** Binds the queue to the open project; the returned function ends its jobs. */
export function installMaskJobs(m: MaskMedia) {
  media = m;
  return () => { stopAll(); media = null; useMaskJobs.setState({ jobs: [] }); };
}
export function cancelMaskJob(id: string) {
  const at = line.findIndex(t => t.id === id);
  if (at >= 0) line.splice(at, 1)[0].abort(cancelled());
  else if (running?.id === id) halt(running);
}
function addJob<R>(spec: Pick<MaskJob, 'kind' | 'itemId' | 'label'>, work: (e: MaskEngine, progress: OnProgress, live: () => void) => Promise<R>): { id: string; done: Promise<R> } {
  const id = newId('maskjob');
  useMaskJobs.setState(s => ({ jobs: [...s.jobs, { ...spec, id, state: 'waiting', percent: 0, detail: WAITING }] }));
  const done = new Promise<R>((resolve, reject) => {
    let over = false;
    const ended = (e: unknown) => {
      if (over) return;
      over = true;
      const { code, message } = e as { code?: unknown; message?: unknown }, stopped = code === MASK_CODES.cancelled;
      setJob(id, { state: stopped ? 'cancelled' : 'failed', detail: stopped ? 'Cancelled' : typeof message === 'string' && message ? message : 'Mask inference failed.', code: typeof code === 'string' ? code : MASK_CODES.failed });
      reject(e);
    };
    const task: Task = { id, cancelled: false, abort: ended, go: async e => {
      setJob(id, { state: 'processing', detail: WORKING[spec.kind] });
      const live = () => { if (task.cancelled) throw cancelled(); };
      try {
        const value = await work(e, (n, total) => setJob(id, { percent: Math.min(99, Math.floor(100 * n / Math.max(total, 1))) }), live);
        if (over) return;
        over = true;
        setJob(id, { state: 'done', percent: 100, detail: 'Done' });
        resolve(value);
      } catch (err) { ended(err); }
    } };
    line.push(task);
  });
  next();
  return { id, done };
}
/** A preview goes ahead of the waiting jobs, unlisted; it still waits for a running job, which holds the worker's models. */
function ahead<T extends MaskResult>(request: () => Promise<MaskRequest>) {
  return new Promise<T>((resolve, reject) => {
    const task: Task = { cancelled: false, abort: reject, go: async e => {
      try {
        const asked = await request();
        if (task.cancelled) throw cancelled();
        resolve(await e.run<T>(asked));
      } catch (err) { reject(err); }
    } };
    line.unshift(task);
    next();
  });
}

// ---- Source facts.
const store = () => media ?? fail('PROJECT_UNAVAILABLE', 'Unable to verify the open project.');
const sourceOf = async (a: Asset): Promise<MaskSource> => ({ blob: await store().read(a.id), rotation: (a.media?.video?.rotation ?? 0) as Rotation });
/** The largest f on [a, b]: a scan of the segment, then its best bracket narrowed. */
function peak(f: (t: number) => number, a: number, b: number) {
  let best = a;
  for (let k = 1; k <= STEPS; k++) { const t = a + (b - a) * k / STEPS; if (f(t) > f(best)) best = t; }
  let lo = Math.max(a, best - (b - a) / STEPS), hi = Math.min(b, best + (b - a) / STEPS);
  for (let k = 0; k < REFINE; k++) { const third = (hi - lo) / 3; if (f(lo + third) < f(hi - third)) lo += third; else hi -= third; }
  return Math.max(f(best), f((lo + hi) / 2));
}
/** The source range an item shows, remap and reverse included: the item's ends, every remap keyframe inside it, and an eased segment's
 *  own extrema, which can pass its keyframes. The end is exclusive (§54.6 5.1), so a top shown before the item's last instant adds 1 µs. */
export function sourceRange(i: RecordData): SourceRange {
  const end = span(i), k = sorted(remapKeyframes(i)), at = (t: number) => sourceTime(i, t);
  let lo = Math.min(at(0), at(end)), hi = Math.max(at(0), at(end));
  k.forEach((a, n) => {
    if (a.time >= 0 && a.time <= end) { lo = Math.min(lo, at(a.time)); hi = Math.max(hi, at(a.time)); }
    const b = k[n + 1], from = Math.max(a.time, 0), to = Math.min(b?.time ?? -Infinity, end);
    if (!b || from >= to || (!a.outHandle && !b.inHandle && (a.easing ?? 'linear') === 'linear')) return;
    hi = Math.max(hi, peak(at, from, to)); lo = Math.min(lo, -peak(t => -at(t), from, to));
  });
  return { startUs: Math.round(lo * 1000), endUs: Math.round(hi * 1000) + (hi > at(end) ? 1 : 0) };
}
export const frameTotal = (a: Asset, { startUs, endUs }: SourceRange) => Math.round((endUs - startUs) / 1e6 * (a.media?.video?.fps || DEFAULT_FPS));
/** §42: a stroke track covers at most 60 s and 1,800 frames, inside the video, and holds the frame the strokes are on. */
export function trackRangeOk(a: Asset, atUs: number, r: SourceRange) {
  const durationUs = (a.durationMs ?? a.media?.durationMs ?? Infinity) * 1000;
  return r.startUs >= 0 && r.endUs > r.startUs && r.endUs <= durationUs + 1000 && r.endUs - r.startUs <= TRACK_LIMIT_US && frameTotal(a, r) <= TRACK_FRAMES && atUs >= r.startUs && atUs < r.endUs;
}
/** `r` cut to `mostUs`, around the frame when it has to be cut. */
function around({ startUs, endUs }: SourceRange, atUs: number, mostUs: number): SourceRange {
  if (endUs - startUs <= mostUs) return { startUs, endUs };
  const start = Math.round(Math.max(startUs, Math.min(atUs - mostUs / 2, endUs - mostUs)));
  return { startUs: start, endUs: start + mostUs };
}
/** The track panel's first range: what the item shows, cut to the limits. */
export const trackWindow = (a: Asset, i: RecordData, atUs: number) => around(sourceRange(i), atUs, Math.min(TRACK_LIMIT_US, TRACK_FRAMES / (a.media?.video?.fps || DEFAULT_FPS) * 1e6));

// ---- Attaching: the raster file first, then one "Edit items".
/** Taken when the job is made: throws, later, once the item shows something else than the video and revision this job read. A deleted
 *  item is left to `maskable`'s own refusal. */
function pinned(ctx: MaskContext, itemId: string, asset: Asset) {
  const { id, sha256 } = asset;
  return () => {
    const i = item(ctx.bus.doc, itemId);
    if (i && (i.type !== 'video' || i.metadata?.assetId !== id || ctx.asset(id)?.sha256 !== sha256)) throw new MaskError(MASK_CODES.sourceChanged, SOURCE_CHANGED);
  };
}
async function attach(ctx: MaskContext, itemId: string, asset: Asset, same: () => void, raster: Raster, range: SourceRange, live: () => void, fields: (i: RecordData) => Partial<StoredMask> & Pick<StoredMask, 'name'>): Promise<Attached> {
  const file = `${crypto.randomUUID()}.dmk`, v = asset.media?.video;
  same();
  await store().writeMask(file, raster.file);
  live();
  const ref: RasterRef = { file, sourceStartUs: range.startUs, sourceEndUs: range.endUs, frameCount: raster.frameCount, width: raster.width, height: raster.height, space: { kind: 'source', width: v?.displayWidth ?? raster.width, height: v?.displayHeight ?? raster.height }, version: 1 };
  const write = () => {
    same();
    const before = ctx.bus.doc, added = ctx.bus.run('Edit items', ctx.origin, (doc: ProjectDocument) => {
      const i = maskable(doc, itemId), list = masksOf(i), mask = maskRecord(i, { id: crypto.randomUUID(), points: [], closed: true, source: 'smart', raster: ref, ...fields(i) });
      i.masks = [...list, mask];
      return { itemId, maskId: mask.id, maskIndex: list.length, raster: ref };
    }) as Attached, changes = timelineChanges(before, ctx.bus.doc);
    return changes ? { ...added, timelineChanges: changes } : added;
  };
  return ctx.scoped ? ctx.scoped(write) : write();
}

// ---- Background removal: a smart mask layer over the whole item (findings §13, part 3 §44.7).
const REMOVAL_NAME = 'Background Removal';
const legacyEffect = (e: RecordData) => e.effectId === 'bg-removal';
function removal(ctx: MaskContext, i: RecordData, name: string, migrate: boolean) {
  const range = sourceRange(i), asset = ctx.asset(String(i.metadata?.assetId)), itemId: string = i.id;
  if (!asset) fail('REMOVE_BG_FAILED', 'Failed to remove background');
  if (range.endUs - range.startUs > REMOVAL_LIMIT_US) fail(REMOVAL_CODES.tooLong, 'Item too long for background removal', { message: `Background removal takes up to 5 minutes of source; this item shows ${((range.endUs - range.startUs) / 1e6).toFixed(1)} s. Split it into parts of 5 minutes or less.` });
  const same = pinned(ctx, itemId, asset!);
  return addJob({ kind: 'removal', itemId, label: name }, async (e, progress, live) => {
    const source = await sourceOf(asset!);
    live();
    const { raster } = await e.run<AutoResult>({ task: 'auto', source, ...range, total: frameTotal(asset!, range) }, progress);
    live();
    if (!raster) throw new MaskError(REMOVAL_CODES.noForeground, NO_FOREGROUND);
    return attach(ctx, itemId, asset!, same, raster, range, live, it => {
      const old = migrate ? it.effects.filter(legacyEffect) : [];
      if (migrate) it.effects = it.effects.filter((x: RecordData) => !legacyEffect(x));
      return { name, mode: masksOf(it).length ? 'intersect' : 'add', selectionMode: 'auto-foreground', purpose: 'background-removal', ...migrate && !old.some((x: RecordData) => x.enabled !== false) ? { enabled: false } : {} };
    });
  });
}
export function startRemoval(ctx: MaskContext, itemId: string, name = REMOVAL_NAME) {
  const i = maskable(ctx.bus.doc, itemId);
  if (i.type !== 'video') fail('INVALID_ITEM_TYPE', 'Not a video item');
  return removal(ctx, i, name, false);
}
/** An old project's hidden `bg-removal` effect has no alpha cache here, so it counts as a missing one: its layer is computed once and
 *  replaces the effect when attached (findings §13). An item over the limit keeps the effect, which stays listed as not rendered. Several
 *  effects on one item become one layer, and it is off when all of them were: opening a project does not change its picture. */
export function migrateRemovals(ctx: MaskContext) {
  for (const i of ctx.bus.doc.items) {
    if (i.type !== 'video' || !effectStack(i).some(legacyEffect)) continue;
    try { void removal(ctx, i, REMOVAL_NAME, true).done.catch(() => undefined); } catch (e) { if (!(e instanceof CommandError)) throw e; }
  }
}

// ---- Smart masks (findings §19).
export const maskFrame = async (a: Asset, atUs: number) => (await open()).run<MaskFrame>({ task: 'frame', source: await sourceOf(a), atUs });
export const maskPreview = (a: Asset, atUs: number, strokes: Stroke[]) => ahead<MaskPreview>(async () => ({ task: 'preview', source: await sourceOf(a), atUs, strokes }));
function tracked(ctx: MaskContext, itemId: string, a: Asset, range: SourceRange, name: string, request: (source: MaskSource) => MaskRequest) {
  const same = pinned(ctx, itemId, a);
  return addJob({ kind: 'smart', itemId, label: name }, async (e, progress, live) => {
    const source = await sourceOf(a);
    live();
    const raster = await e.run<Raster>(request(source), progress);
    live();
    return attach(ctx, itemId, a, same, raster, range, live, i => ({ name, order: masksOf(i).length }));
  });
}
export const startTracking = (ctx: MaskContext, itemId: string, a: Asset, atUs: number, range: SourceRange, strokes: Stroke[], name = 'Smart mask') =>
  tracked(ctx, itemId, a, range, name, source => ({ task: 'track', source, atUs, ...range, total: frameTotal(a, range), strokes }));
/** A text prompt (findings §20): a job of its own, its range clamped to 30 s. */
export function startTextMask(ctx: MaskContext, itemId: string, a: Asset, atUs: number, range: SourceRange, prompt: string, name = 'Smart mask') {
  const r = around(range, atUs, TEXT_LIMIT_US);
  return tracked(ctx, itemId, a, r, name, source => ({ task: 'text', source, atUs, ...r, total: frameTotal(a, r), prompt }));
}
