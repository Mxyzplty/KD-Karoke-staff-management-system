// SPDX-License-Identifier: AGPL-3.0-only
// T22 catalogue assets (plan P8): an `element:<id>` / `sound:<slug>` of addMedia becomes a library asset linked to the
// project. The import is async, addMedia is not, so the agent path first tries the call on a draft with stand-in assets
// (a refused call imports and links nothing), then imports each file once and runs the real call. The file is uploaded
// under a name that carries its content hash, so the library's reuse rule (same original name and size, part 2 §25)
// keeps one copy per file version. An element is uploaded as a PNG drawn from its SVG: the image path decodes with
// createImageBitmap, which takes no SVG.
import { uploadToProject } from '../media/ingest';
import { sha256Blob } from '../media/sha256';
import type { ProjectStore } from '../store/database';
import type { Asset, RecordData } from '../store/model';
import { callTool } from '../timeline/tools';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { findElement } from './elements';
import { findSound } from './sounds';

// `no-inline`: a small SVG would otherwise be served as a rewritten data URL, so its bytes would not be the recorded file's.
const bundled = import.meta.glob('../../../../vendor/t22/{elements,sounds,fonts}/*', { eager: true, query: '?url&no-inline', import: 'default' }) as Record<string, string>;
const MIME: Record<string, string> = { png: 'image/png', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg' };
/** The stored picture of an element: `scale` × its catalogue size, the long side at most `maxSide` px. Placed larger than
 *  that, the picture is upscaled. */
export const RASTER = { scale: 2, maxSide: 2048 };
export function rasterSize(width: number, height: number): { width: number; height: number } {
  const s = Math.min(RASTER.scale, RASTER.maxSide / Math.max(width, height));
  return { width: Math.round(width * s), height: Math.round(height * s) };
}
/** An SVG as a PNG of the given size, alpha kept. SVG renders only through an <img> on the main thread (as T14's
 *  svgThumbnails, media/worker-client.ts); <img> runs no SVG script. */
async function rasterise(svg: Blob, size: { width: number; height: number }): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image(); img.src = url;
    await img.decode();
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext('2d')!.drawImage(img, 0, 0, size.width, size.height);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally { URL.revokeObjectURL(url); }
}
/** A bundled file of `vendor/t22/…` (a catalogue entry, a default-template font), fetched from beside the app. */
export async function bundledFile(file: string): Promise<Blob> {
  const url = bundled[`../../../../${file}`];
  if (!url) throw new Error(`${file} is not bundled`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.blob();
}

/** The catalogue entry an agent id names: its file, asset type and, for a sound, its length. */
function entry(id: unknown): { file: string; type: Asset['type']; licence: string; durationMs?: number; size?: { width: number; height: number } } | undefined {
  if (typeof id !== 'string') return undefined;
  const el = id.startsWith('element:') ? findElement(id.slice(8)) : undefined, sound = id.startsWith('sound:') ? findSound(id.slice(6)) : undefined;
  return el ? { file: el.file, type: 'image', licence: 'AGPL-3.0-only', size: rasterSize(el.width, el.height) } : sound ? { file: sound.file, type: 'audio', licence: 'CC0-1.0', durationMs: sound.durationMs } : undefined;
}
const idsOf = (input: RecordData | undefined): unknown[] => Array.isArray(input?.items) ? input!.items.map((i: RecordData) => i?.assetId) : [input?.assetId];
const named = (id: unknown) => typeof id === 'string' && (id.startsWith('element:') || id.startsWith('sound:'));
/** addMedia with an `element:` / `sound:` id. */
export const usesCatalogue = (tool: string, input: RecordData | undefined) => tool === 'addMedia' && idsOf(input).some(named);
/** The distinct known catalogue ids of a call, in order. */
export const catalogueIds = (input: RecordData | undefined): string[] => [...new Set(idsOf(input).filter((id): id is string => !!entry(id)))];

/** The project asset of a catalogue id: the library copy when there is one, else a new upload; linked either way. */
export async function ensureCatalogueAsset(store: ProjectStore, projectId: string, id: string, load: (file: string) => Promise<Blob> = bundledFile, raster: typeof rasterise = rasterise): Promise<Asset> {
  const e = entry(id);
  if (!e) throw new Error(`${id} is not in the catalogue`);
  // Content-addressed (part 2 §33): the name carries the first 8 hex of the SHA-256 of the bundled file's bytes (the SVG
  // of an element, not its PNG), so a changed file of the same size is a new library copy, never the old one.
  const blob = await load(e.file), ext = e.size ? 'png' : e.file.split('.').pop()!;
  const file = new File([e.size ? await raster(blob, e.size) : blob], `cutframe-${id.replace(':', '-')}-${(await sha256Blob(blob)).slice(0, 8)}.${ext}`, { type: MIME[ext] });
  const result = await uploadToProject(store, projectId, [file], { source: { kind: 'stock', provider: 'cutframe', providerId: id, licence: e.licence } });
  if (result.failed.length) throw result.failed[0].error;
  const asset = result.assets[0], durationMs = e.durationMs;
  // A fresh upload has no length until its preparation ends; the catalogue knows it, and the stored asset gets it now.
  if (durationMs === undefined || asset.durationMs !== null) return asset;
  return await store.updateAsset(asset.id, a => a.durationMs === null ? { ...a, durationMs } : a) ?? { ...asset, durationMs };
}

/** Tries the call on a draft with stand-in assets; a refusal is returned as it is and nothing is imported. Then `ensure`
 *  each known id (the caller indexes it under that id) and `run` the real call. */
export async function callCatalogueTool(ctx: ToolContext, args: RecordData, options: { ensure: (id: string) => Promise<unknown>; run: () => ToolResult | Promise<ToolResult> }): Promise<ToolResult> {
  const standIn = (id: string): Asset | undefined => {
    const e = entry(id);
    return e && { id, name: id, type: e.type, sizeBytes: 0, mimeType: '', folderId: null, created_at: '', recorded_at: null, location: null, durationMs: e.durationMs ?? null };
  };
  const dry = callTool({ ...ctx, dryRun: true, asset: id => standIn(id) ?? ctx.asset(id) }, 'addMedia', args);
  if (dry.code !== 'DRY_RUN_OK') return dry;
  for (const id of catalogueIds(args)) {
    try { await options.ensure(id); } catch (e) {
      const code = (e as { code?: unknown })?.code;
      return { success: false, code: typeof code === 'string' && code ? code : 'UPLOAD_FAILED', error: `The built-in ${id} could not be added to the project. No items were added.`, operationMayHaveRun: false };
    }
  }
  return options.run();
}
