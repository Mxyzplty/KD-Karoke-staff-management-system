// SPDX-License-Identifier: AGPL-3.0-only
// T22 catalogue assets (plan P8): an `element:<id>` / `sound:<slug>` of addMedia becomes a library asset linked to the
// project. The import is async, addMedia is not, so the agent path first tries the call on a draft with stand-in assets
// (a refused call imports and links nothing), then imports each file once and runs the real call. The file is uploaded
// under a name that carries its content hash, so the library's reuse rule (same original name and size, part 2 §25)
// keeps one copy per file version.
import { uploadToProject } from '../media/ingest';
import { sha256Blob } from '../media/sha256';
import type { ProjectStore } from '../store/database';
import type { Asset, RecordData } from '../store/model';
import { callTool } from '../timeline/tools';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { findElement } from './elements';
import { findSound } from './sounds';

const bundled = import.meta.glob('../../../../vendor/t22/{elements,sounds}/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const MIME: Record<string, string> = { svg: 'image/svg+xml', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg' };
/** The bundled file of a catalogue entry (`vendor/t22/…`), fetched from beside the app. */
async function bundledFile(file: string): Promise<Blob> {
  const url = bundled[`../../../../${file}`];
  if (!url) throw new Error(`${file} is not bundled`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.blob();
}

/** The catalogue entry an agent id names: its file, asset type and, for a sound, its length. */
function entry(id: unknown): { file: string; type: Asset['type']; licence: string; durationMs?: number } | undefined {
  if (typeof id !== 'string') return undefined;
  const el = id.startsWith('element:') ? findElement(id.slice(8)) : undefined, sound = id.startsWith('sound:') ? findSound(id.slice(6)) : undefined;
  return el ? { file: el.file, type: 'image', licence: 'AGPL-3.0-only' } : sound ? { file: sound.file, type: 'audio', licence: 'CC0-1.0', durationMs: sound.durationMs } : undefined;
}
const idsOf = (input: RecordData | undefined): unknown[] => Array.isArray(input?.items) ? input!.items.map((i: RecordData) => i?.assetId) : [input?.assetId];
const named = (id: unknown) => typeof id === 'string' && (id.startsWith('element:') || id.startsWith('sound:'));
/** addMedia with an `element:` / `sound:` id. */
export const usesCatalogue = (tool: string, input: RecordData | undefined) => tool === 'addMedia' && idsOf(input).some(named);
/** The distinct known catalogue ids of a call, in order. */
export const catalogueIds = (input: RecordData | undefined): string[] => [...new Set(idsOf(input).filter((id): id is string => !!entry(id)))];

/** The project asset of a catalogue id: the library copy when there is one, else a new upload; linked either way. */
export async function ensureCatalogueAsset(store: ProjectStore, projectId: string, id: string, load: (file: string) => Promise<Blob> = bundledFile): Promise<Asset> {
  const e = entry(id);
  if (!e) throw new Error(`${id} is not in the catalogue`);
  // Content-addressed (part 2 §33): the name carries the first 8 hex of the bytes' SHA-256, so a changed file of the same
  // size is a new library copy, never the old one.
  const ext = e.file.split('.').pop()!, blob = await load(e.file);
  const file = new File([blob], `cutframe-${id.replace(':', '-')}-${(await sha256Blob(blob)).slice(0, 8)}.${ext}`, { type: MIME[ext] });
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
