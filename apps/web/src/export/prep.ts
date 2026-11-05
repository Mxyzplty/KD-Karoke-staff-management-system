// SPDX-License-Identifier: AGPL-3.0-only
// Timeline prep (findings §7 step 4): deep copy, timing repair, timing check (error codes §12: five issue codes,
// tolerance 0.01 ms; any issue left aborts as INVALID_MEDIA_TIMING), validate, then the frame plan (T15's exportPlan:
// the leading gap > 1 ms is trimmed unless a range is set). Prechecks map unreachable media to the §12 precondition
// classes. The repair rule is provisional (notes Q-A): trims are clamped to [0, sourceDuration], nothing else.
import type { ProjectStore } from '../store/database';
import type { Asset, ProjectDocument, RecordData } from '../store/model';
import { validateDocument } from '../store/model';
import { stack } from '../timeline/model';
import { withCellItems } from '../timeline/layouts';
import { exportPlan, projectSize } from '../render/model';
import type { Plan, Size } from '../render/model';
import { ExportError } from './errors';

const TOLERANCE = 0.01;
const TIMED = new Set(['video', 'audio']);
export type TimingIssue = { itemId: string; code: 'TRIM_FROM_INVALID' | 'TRIM_TO_INVALID' | 'TRIM_BEFORE_SOURCE' | 'TRIM_INVERTED' | 'TRIM_AFTER_SOURCE'; message: string };

const timed = (i: RecordData) => TIMED.has(i.type) && i.trim && typeof i.trim === 'object';
/** Clamps trims into the source (in place); returns the ids it changed. */
export function repairTiming(doc: ProjectDocument): string[] {
  const changed: string[] = [];
  for (const i of doc.items) {
    if (!timed(i)) continue;
    const t = i.trim, sd = i.sourceDuration;
    if (Number.isFinite(t.from) && t.from < -TOLERANCE) { t.from = 0; changed.push(i.id); }
    if (Number.isFinite(t.to) && typeof sd === 'number' && sd > 0 && t.to > sd + TOLERANCE) { t.to = sd; changed.push(i.id); }
  }
  return [...new Set(changed)];
}
/** The timeline timing check (§12): one record per issue, first failing rule per item. */
export function timingIssues(doc: ProjectDocument): TimingIssue[] {
  const out: TimingIssue[] = [];
  for (const i of doc.items) {
    if (!timed(i)) continue;
    const { from, to } = i.trim, sd = i.sourceDuration, id = i.id;
    if (!Number.isFinite(from)) out.push({ itemId: id, code: 'TRIM_FROM_INVALID', message: `${id} has invalid trim.from (${from})` });
    else if (!Number.isFinite(to)) out.push({ itemId: id, code: 'TRIM_TO_INVALID', message: `${id} has invalid trim.to (${to})` });
    else if (from < -TOLERANCE) out.push({ itemId: id, code: 'TRIM_BEFORE_SOURCE', message: `${id} has trim.from before source start (${from}ms)` });
    else if (to < from - TOLERANCE) out.push({ itemId: id, code: 'TRIM_INVERTED', message: `${id} has trim.to before trim.from (${from}ms > ${to}ms)` });
    else if (typeof sd === 'number' && sd > 0 && to > sd + TOLERANCE) out.push({ itemId: id, code: 'TRIM_AFTER_SOURCE', message: `${id} has trim.to after source duration (${to}ms > ${sd}ms)` });
  }
  return out;
}

export type Range = { startS: number; endS: number };
export type Prepared = { doc: ProjectDocument; plan: Plan; repaired: string[] };
/** Copy → repair → check → validate → plan. The input document is never changed. */
export function prepare(input: ProjectDocument, range?: Range): Prepared {
  const copy = structuredClone(input) as ProjectDocument, repaired = Array.isArray(copy?.items) ? repairTiming(copy) : [];
  const issues = Array.isArray(copy?.items) ? timingIssues(copy) : [];
  if (issues.length) throw new ExportError('INVALID_MEDIA_TIMING', `Invalid media timing: ${issues.map(i => i.message).join('; ')}`, { issues });
  const doc = validateDocument(copy);
  if (range && !(range.startS >= 0 && range.endS > range.startS && range.endS * 1000 <= doc.duration + TOLERANCE)) {
    throw new ExportError('CLIENT_BUG', `Export range ${range.startS}-${range.endS}s is not inside the composition (0-${doc.duration / 1000}s).`);
  }
  return { doc, plan: exportPlan(doc, range), repaired };
}

// ---- Output size (findings §7 l.118): original = the canvas; otherwise the long edge, the other side scaled, both even.
export type Resolution = 'original' | '480p' | '720p' | '1080p' | '1440p' | '4k';
const LONG_EDGE: Record<Exclude<Resolution, 'original'>, number> = { '480p': 854, '720p': 1280, '1080p': 1920, '1440p': 2560, '4k': 3840 };
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
export function outputSize(doc: Pick<ProjectDocument, 'size'>, resolution: Resolution = 'original'): Size {
  const p = projectSize(doc);
  if (resolution === 'original') return { width: even(p.width), height: even(p.height) };
  const edge = LONG_EDGE[resolution];
  return p.height > p.width ? { width: even(edge * p.width / p.height), height: edge } : { width: edge, height: even(edge * p.height / p.width) };
}

// ---- Prechecks (§12 precondition rows): every media item on an exported (not hidden) track needs a readable asset.
const MEDIA = new Set(['video', 'image', 'audio']);
/** Items on exported tracks (not hidden, not in a hidden group). */
export function exportedItems(doc: ProjectDocument): RecordData[] {
  const hidden = new Set(doc.tracks.filter(t => t.hidden).map(t => t.id)), groupsHidden = hiddenByGroup(doc);
  const ids = new Set(stack(doc).filter(id => !hidden.has(id) && !groupsHidden.has(id)));
  return doc.items.filter(i => ids.has(i.trackId));
}
/** Media items that the export reads, a layout's filled cells included (T07: timeline/layouts cellItem). */
export const exportedMedia = (doc: ProjectDocument): RecordData[] => withCellItems(exportedItems(doc)).filter(i => MEDIA.has(i.type));
function hiddenByGroup(doc: ProjectDocument): Set<string> {
  const out = new Set<string>(), walk = (list: { type: string; id: string }[], hidden: boolean) => list.forEach(e => {
    if (e.type === 'group') walk((doc.groups[e.id]?.children ?? []) as { type: string; id: string }[], hidden || !!doc.groups[e.id]?.hidden);
    else if (hidden) out.add(e.id);
  });
  walk(doc.layerOrder as { type: string; id: string }[], false);
  return out;
}
const names = (list: string[]) => [...new Set(list)].join(', ');
/** Throws the first failing precondition; returns the assets by id. */
export async function precheck(store: ProjectStore, doc: ProjectDocument): Promise<Map<string, Asset>> {
  const items = exportedMedia(doc), assets = new Map((await store.library()).assets.map(a => [a.id, a] as const));
  const unresolved = items.filter(i => !assets.has(String(i.metadata?.assetId ?? '')));
  if (unresolved.length) throw new ExportError('UNRESOLVED_MEDIA', `Reconnect or re-add the media for ${names(unresolved.map(i => String(i.details?.name ?? i.id)))} before exporting.`, { itemIds: unresolved.map(i => i.id) });
  const used = [...new Set(items.map(i => String(i.metadata!.assetId)))].map(id => assets.get(id)!);
  const missing: string[] = [], unreadable: string[] = [];
  for (const a of used) {
    try { await store.media.read(a.id); }
    catch (e) { ((e as { code?: string }).code === 'WORKSPACE_FILE_MISSING' || (e as { name?: string }).name === 'NotFoundError' ? missing : unreadable).push(a.name); }
  }
  if (unreadable.length) throw new ExportError('LOCAL_STORAGE_UNAVAILABLE', `Browser storage could not read ${names(unreadable)}. Reopen the project and retry before relinking these files.`);
  if (missing.length) throw new ExportError('MISSING_LOCAL_FILES', `MISSING_LOCAL_FILES: ${names(missing)} ${missing.length === 1 ? "isn't" : "aren't"} on this device — re-add ${missing.length === 1 ? 'it' : 'them'} and export again.`);
  const uploading = used.filter(a => a.processing_status === 'uploading');
  if (uploading.length) throw new ExportError('ASSETS_STILL_UPLOADING', `SYNCING_ASSETS: ${names(uploading.map(a => a.name))}`);
  return assets;
}
