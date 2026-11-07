// SPDX-License-Identifier: AGPL-3.0-only
// T12 smart-mask agent tools (contracts viewMaskFrame, previewSmartMask, trackSmartMask, removeBackground; results §2 trackSmartMask,
// rules 3 and 6): asynchronous, so the executor runs them outside the synchronous tool table. Failures of the first three are thrown,
// with Xapp's texts, and reach the agent as PROJECT_UNAVAILABLE + operationMayHaveRun (the executor's `unavailable`); viewMaskFrame
// returns the frameRef Xapp's MCP path drops. Frames and selections are kept 30 min, at most 64 of each. Provisional: the text block's
// shape and the wording of what Xapp's stored results do not show (out-of-range view, stroke rules).
import type { MediaStore } from '../store/media';
import type { Asset, RecordData } from '../store/model';
import { CommandError, item } from '../timeline/model';
import { sourceTime } from '../timeline/properties';
import { installMaskJobs, maskFrame, maskPreview, startRemoval, startTracking, trackRangeOk } from './jobs';
import type { Attached, MaskContext } from './jobs';
import { masksOf } from './model';
import { MASK_CODES, MaskError } from './protocol';
import { useRasterStore } from './raster';
import { strokeProblem } from './strokes';
import type { Stroke } from './strokes';

type Result = RecordData & { success: boolean };
type Frame = { ref: string; itemId: string; assetId: string; revision: unknown; timeUs: number; at: number };
type Selection = { frame: Frame; strokes: Stroke[]; maskId?: string; at: number };
export const SMART_TOOLS = new Set(['viewMaskFrame', 'previewSmartMask', 'trackSmartMask', 'removeBackground']);
const KEEP_MS = 30 * 60_000, KEEP = 64;
const EXPIRED = 'This frame selection expired. View a fresh source frame.', CHANGED = 'The selected video changed. View its source frame again.', MOVED = 'The source changed while tracking. View and select a new frame.';
const ITEM = 'Smart masking requires a current video item.', PROJECT = 'The video must belong to the current saved project.', RANGE = 'Use a source-time range up to 60 seconds, inside the video and containing the inspected frame.';
const ADDED = 'Tracked alpha mask added. Its feather, expansion, opacity, invert, blend mode and numeric keyframes can still be changed.';

const frames = new Map<string, Frame>(), selections = new Map<string, Selection>();
/** Binds masks to the open project: its mask files, its job queue, its selections. The returned function ends them. */
export function installMasks(store: MediaStore, projectId: string) {
  const writeMask = (file: string, data: Blob) => store.writeMask!(projectId, file, data);
  useRasterStore({ writeMask, readMask: file => store.readMask!(projectId, file) });
  const uninstall = installMaskJobs({ read: id => store.read(id), writeMask });
  return () => { uninstall(); useRasterStore(null); frames.clear(); selections.clear(); };
}
function keep<V extends { at: number }>(map: Map<string, V>, key: string, value: V) {
  map.set(key, value);
  for (const [k, v] of map) if (Date.now() - v.at > KEEP_MS || map.size > KEEP) map.delete(k);
}
function recall<V extends { at: number }>(map: Map<string, V>, key: unknown): V {
  const v = map.get(String(key));
  if (!v || Date.now() - v.at > KEEP_MS) throw new Error(EXPIRED);
  return v;
}
function current(ctx: MaskContext, itemId: unknown): { i: RecordData; asset: Asset } {
  const i = item(ctx.bus.doc, String(itemId));
  if (!i || i.type !== 'video') throw new Error(ITEM);
  const asset = ctx.asset(String(i.metadata?.assetId));
  if (!asset) throw new Error(PROJECT);
  return { i, asset };
}
/** The frame's item and video as they were viewed. */
function unchanged(ctx: MaskContext, f: Frame): Asset {
  const { asset } = current(ctx, f.itemId);
  if (asset.id !== f.assetId || asset.sha256 !== f.revision) throw new Error(CHANGED);
  return asset;
}
async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(s);
}
const blocks = async (info: RecordData, image: Blob, mimeType: string): Promise<Result> => ({ success: true, ...info, content: [{ type: 'text', text: JSON.stringify({ success: true, ...info }) }, { type: 'image', mimeType, base64: await base64(image) }] });

async function viewMaskFrame(ctx: MaskContext, args: RecordData): Promise<Result> {
  const { i, asset } = current(ctx, args.itemId), ms = Number(args.timelineSeconds) * 1000;
  if (!(ms >= i.display.from && ms <= i.display.to)) throw new Error(`Time ${args.timelineSeconds}s is outside this item.`);
  const shown = await maskFrame(asset, Math.round(sourceTime(i, ms - i.display.from) * 1000)), ref = crypto.randomUUID();
  keep(frames, ref, { ref, itemId: i.id, assetId: asset.id, revision: asset.sha256, timeUs: shown.timeUs, at: Date.now() });
  return blocks({ frameRef: ref, itemId: i.id, timelineSeconds: args.timelineSeconds, sourceSeconds: shown.timeUs / 1e6, sourceTimeUs: shown.timeUs, width: shown.width, height: shown.height }, shown.jpeg, 'image/jpeg');
}
async function previewSmartMask(ctx: MaskContext, args: RecordData): Promise<Result> {
  const frame = recall(frames, args.frameRef), strokes = args.strokes as Stroke[], asset = unchanged(ctx, frame), problem = strokeProblem(strokes);
  if (problem) throw new Error(problem);
  const p = await maskPreview(asset, frame.timeUs, strokes), selectionId = crypto.randomUUID();
  keep(selections, selectionId, { frame, strokes, at: Date.now() });
  return blocks({ selectionId, frameRef: frame.ref, width: p.width, height: p.height, area: p.area }, p.png, 'image/png');
}
const stored = (a: Attached, asset: Asset) => {
  const { file, ...raster } = a.raster;
  return { assetId: file.replace(/\.dmk$/, ''), bucket: 'local', manifestKey: `masks/${file}`, sourceAssetId: asset.id, sourceRevision: asset.sha256, ...raster };
};
async function trackSmartMask(ctx: MaskContext, args: RecordData): Promise<Result> {
  const selection = recall(selections, args.selectionId), { frame } = selection, done = selection.maskId && masksOf(item(ctx.bus.doc, frame.itemId) ?? {}).find(m => m.id === selection.maskId);
  if (done) return { success: true, data: { itemId: frame.itemId, maskId: done.id } };
  const asset = unchanged(ctx, frame), range = { startUs: Math.round(Number(args.sourceStartSeconds) * 1e6), endUs: Math.round(Number(args.sourceEndSeconds) * 1e6) };
  if (!trackRangeOk(asset, frame.timeUs, range)) throw new Error(RANGE);
  const job = startTracking(ctx, frame.itemId, asset, frame.timeUs, range, selection.strokes, typeof args.name === 'string' && args.name ? args.name : undefined);
  let attached: Attached;
  try { attached = await job.done; } catch (e) {
    const { code, message } = e as MaskError;
    if (code === MASK_CODES.sourceChanged) throw new Error(MOVED);
    throw code === MASK_CODES.cancelled ? new MaskError(code, 'Smart masking cancelled.') : e instanceof CommandError ? e : new MaskError(code ?? MASK_CODES.failed, message || 'Smart masking failed.');
  }
  selection.maskId = attached.maskId;
  const { timelineChanges, ...rest } = attached;
  return { success: true, message: ADDED, data: { itemId: rest.itemId, maskId: rest.maskId, maskIndex: rest.maskIndex, raster: stored(attached, asset) }, ...timelineChanges ? { timelineChanges } : {} };
}
/** Headless runs wait for the finished mask (contracts removeBackground). Refusals and job failures carry their own codes. */
async function removeBackground(ctx: MaskContext, args: RecordData): Promise<Result> {
  try {
    const { itemId, maskId, maskIndex, timelineChanges } = await startRemoval(ctx, String(args.itemId), typeof args.name === 'string' && args.name ? args.name : undefined).done;
    return { success: true, message: `Background removed from '${itemId}' as a smart mask layer.`, data: { itemId, maskId, maskIndex }, ...timelineChanges ? { timelineChanges } : {} };
  } catch (e) {
    if (e instanceof CommandError) return { success: false, code: e.code, error: e.error, ...e.extra.message ? { message: e.extra.message } : {} };
    const { code, message } = e as MaskError;
    return { success: false, code: code ?? MASK_CODES.failed, error: message || 'Failed to remove background' };
  }
}
export function callSmartTool(ctx: MaskContext, tool: string, args: RecordData): Promise<Result> {
  return tool === 'viewMaskFrame' ? viewMaskFrame(ctx, args) : tool === 'previewSmartMask' ? previewSmartMask(ctx, args) : tool === 'trackSmartMask' ? trackSmartMask(ctx, args) : removeBackground(ctx, args);
}
