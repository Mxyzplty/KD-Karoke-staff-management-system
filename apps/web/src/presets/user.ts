// SPDX-License-Identifier: AGPL-3.0-only
// The user's own presets (T22; GFX-10 Save as Preset: re-applies with the same parameters on another project, missing fonts
// and media are reported, versioned, exportable). No Xapp capture exists for it: the whole flow is Cutframe's own (plan Q7).
// One motion graphic → My Presets (T08's `mg-presets` settings row, T08's shape plus optional fields). Text and shape items →
// a direct style preset (§31's shape) in the `style-presets` settings row. Both rows hold every project's presets.
// Cutframe readings: a saved graphic keeps its code, field values and length, its exact box for a canvas of the same size,
// and §31 boxes (its share of the canvas on both references) for any other canvas. A saved text or shape keeps its timing,
// box, static style, text, font family, numeric keyframes and path; §31's item shape has no place for effects, masks, path
// keyframes, a text look or keyframe handles, so `notKept` names them for the save notice.
import type { ProjectStore } from '../store/database';
import type { RecordData } from '../store/model';
import { assetIds } from '../mg/agent-checks';
import { presetProblem, USER_PRESETS_ROW, type GraphicPreset } from '../mg/presets';
import { findFont } from '../text/font-registry';
import { prop, staticValue, statics } from '../timeline/properties';
import { mapPoints, pathKeyframes } from '../timeline/shapes';
import { isDirect, SCALED_PROPERTIES, stylePresetProblem, type DirectPreset, type PresetItem, type PresetKeyframe, type SavedGraphic } from './model';

export const STYLE_PRESETS_ROW = 'style-presets', PRESET_VERSION = 1, EXPORT_FORMAT = 'cutframe-presets';
export type UserDirect = DirectPreset & { version?: number; savedAt?: string };
export type UserPreset = SavedGraphic | UserDirect;
type Size = { width: number; height: number };
type Skipped = { index: number; reason: string };

/** What a selection saves as, or null when Save as preset does not apply: one motion graphic with code, or text and shape
 *  items only (one or several). */
export function savable(items: RecordData[]): 'graphic' | 'direct' | null {
  if (items.length === 1 && items[0].type === 'motionGraphic') return typeof items[0].details?.code === 'string' && items[0].details.code.trim() ? 'graphic' : null;
  return items.length && items.every(i => i.type === 'text' || i.type === 'shape') ? 'direct' : null;
}
/** The parts of the items a saved preset does not carry. */
export function notKept(items: RecordData[]): string[] {
  const out = new Set<string>();
  for (const i of items) {
    const frames = Object.keys(i.properties ?? {}).flatMap(k => prop(i, k)?.keyframes ?? []);
    if (Array.isArray(i.effects) && i.effects.some((e: RecordData) => e.enabled !== false)) out.add('effects');
    if (Array.isArray(i.masks) && i.masks.length) out.add('masks');
    if (i.type === 'motionGraphic') { if (frames.length) out.add('keyframes'); continue; }
    if (i.type === 'shape' && pathKeyframes(i.details).length) out.add('path keyframes');
    if (i.type === 'text' && i.details?.look) out.add('text look');
    if (frames.some(f => typeof f.value !== 'number')) out.add('keyframes without a number value');
    if (frames.some(f => f.inHandle || f.outHandle)) out.add('keyframe handles');
  }
  return [...out];
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
const stamp = (name: string, now: Date) => ({ name: name.trim(), version: PRESET_VERSION, savedAt: now.toISOString(), tail: `${slug(name)}-${now.getTime().toString(36)}` });
const boxOf = (i: RecordData) => ({ x: Number(staticValue(i, 'positionX', 0)), y: Number(staticValue(i, 'positionY', 0)), width: Number(staticValue(i, 'width')), height: Number(staticValue(i, 'height')) });

/** A motion-graphic item as a My Presets entry. */
export function savedGraphic(item: RecordData, canvas: Size, name: string, now = new Date()): SavedGraphic {
  const { tail, ...s } = stamp(name, now), box = boxOf(item), values = item.details?.fieldValues;
  const on = (ref: Size) => ({ x: box.x / canvas.width * ref.width, y: box.y / canvas.height * ref.height, width: box.width / canvas.width * ref.width, height: box.height / canvas.height * ref.height });
  return { id: `my/${tail}`, name: s.name, mg_code: item.details.code, mg_code_h: item.details.code, spatial: on({ width: 1080, height: 1920 }), spatial_h: on({ width: 1920, height: 1080 }),
    duration_ms: typeof item.sourceDuration === 'number' && item.sourceDuration > 0 ? item.sourceDuration : item.display.to - item.display.from,
    ...(values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length ? { field_values: structuredClone(values) } : {}),
    saved: { canvas: { width: canvas.width, height: canvas.height }, box }, version: s.version, savedAt: s.savedAt };
}
/** Text and shape items as one direct style preset on `canvas` (boxes and font sizes normalised, §31); the earliest item
 *  starts at 0. The category is `text` with a text item, else `misc`. */
export function savedDirect(list: RecordData[], canvas: Size, name: string, now = new Date()): UserDirect {
  const { tail, ...s } = stamp(name, now), start = Math.min(...list.map(i => i.display.from)), W = canvas.width, H = canvas.height;
  const share: Record<string, number> = { positionX: W, positionY: H, width: W, height: H, fontSize: W };
  const items = list.map((i): PresetItem => {
    const { positionX: _x, positionY: _y, width: _w, height: _h, fontSize: _f, ...style } = statics(i), box = boxOf(i);
    const details: RecordData = { ...style, left: box.x / W, top: box.y / H, width: box.width / W, height: box.height / H };
    if (i.type === 'text') Object.assign(details, { text: i.details?.text ?? '', fontFamily: i.details?.fontFamilyDisplay ?? i.details?.fontFamily, fontSize: Number(staticValue(i, 'fontSize')) / W });
    else Object.assign(details, { ...(i.metadata?.shapeType ? { shapeType: i.metadata.shapeType } : {}), closed: i.details?.closed !== false,
      points: mapPoints([1 / (i.details?.width || box.width), 0, 0, 1 / (i.details?.height || box.height), 0, 0], Array.isArray(i.details?.points) ? i.details.points : []) });
    const properties: Record<string, PresetKeyframe[]> = {};
    for (const key of Object.keys(i.properties ?? {})) {
      const frames = (prop(i, key)?.keyframes ?? []).filter(f => typeof f.value === 'number');
      if (frames.length) properties[key] = frames.map(f => ({ time: f.time, value: (SCALED_PROPERTIES as readonly string[]).includes(key) ? (f.value as number) / share[key] : f.value as number, easing: f.easing }));
    }
    return { type: i.type, relativeStart: i.display.from - start, duration: i.display.to - i.display.from, details, ...(Object.keys(properties).length ? { properties } : {}) };
  });
  return { id: `${list.some(i => i.type === 'text') ? 'text' : 'misc'}/${tail}`, name: s.name, description: `Saved from ${items.length} item(s).`, items, canvas_size: { width: W, height: H }, version: s.version, savedAt: s.savedAt };
}

/** The user's direct style presets, and why each other record of the row was left out. */
export function loadStylePresets(list: unknown): { presets: UserDirect[]; skipped: Skipped[] } {
  const presets: UserDirect[] = [], skipped: Skipped[] = [];
  (Array.isArray(list) ? list : []).forEach((r, index) => {
    const reason = stylePresetProblem(r) ?? (isDirect(r) ? null : 'not a direct preset');
    if (reason) skipped.push({ index, reason }); else presets.push(r);
  });
  return { presets, skipped };
}
export async function userStylePresets(store: ProjectStore) {
  return loadStylePresets((await store.row<{ id: string; presets: unknown }>('settings', STYLE_PRESETS_ROW))?.presets);
}
/** Adds presets to their rows (a preset with an id already there replaces it). */
export async function storePresets(store: ProjectStore, presets: UserPreset[]): Promise<void> {
  for (const [row, own] of [[USER_PRESETS_ROW, presets.filter(p => !isDirect(p))], [STYLE_PRESETS_ROW, presets.filter(isDirect)]] as const) {
    if (!own.length) continue;
    const ids = new Set(own.map(p => p.id));
    await store.swapRow<{ id: string; presets: unknown }>('settings', row, r => ({ id: row, presets: [...(Array.isArray(r?.presets) ? r.presets : []).filter((p: RecordData) => !ids.has(p?.id)), ...own] }));
  }
}

/** The export file's content: every preset of both rows. */
export const exportPresets = (presets: UserPreset[]) => ({ format: EXPORT_FORMAT, version: PRESET_VERSION, presets });
/** The valid presets of an export file, and why each other record was left out. Throws INVALID_PRESET_FILE for another file. */
export function importPresets(file: unknown): { presets: UserPreset[]; skipped: Skipped[] } {
  const f = file as RecordData;
  if (!f || typeof f !== 'object' || f.format !== EXPORT_FORMAT || !Array.isArray(f.presets)) throw Object.assign(new Error('This is not a Cutframe presets file.'), { code: 'INVALID_PRESET_FILE' });
  if (f.version !== PRESET_VERSION) throw Object.assign(new Error(`This presets file has version ${String(f.version)}; this build reads version ${PRESET_VERSION}.`), { code: 'INVALID_PRESET_FILE' });
  const presets: UserPreset[] = [], skipped: Skipped[] = [];
  f.presets.forEach((r: RecordData, index: number) => {
    const direct = !!r && typeof r === 'object' && Array.isArray(r.items), reason = direct ? stylePresetProblem(r) : presetProblem(r);
    if (reason) skipped.push({ index, reason }); else presets.push((direct ? r : { ...r, duration_ms: r.duration_ms ?? 5000 }) as UserPreset);
  });
  return { presets, skipped };
}

/** What a preset needs and this machine or project lacks: one notice per missing font (a text item's family) and per missing
 *  asset (an id the graphic's code passes to getAssetUrl). The items are placed either way. */
export function missingFor(p: UserPreset | GraphicPreset | DirectPreset, agentIds: readonly string[]): string[] {
  if (isDirect(p)) return [...new Set(p.items.filter(i => i.type === 'text' && typeof i.details.fontFamily === 'string' && !findFont(i.details.fontFamily)).map(i => i.details.fontFamily as string))]
    .map(f => `The font "${f}" is not available here. The default font is used.`);
  return [...new Set([p.mg_code, p.mg_code_h ?? ''].flatMap(assetIds))].filter(id => !agentIds.includes(id))
    .map(id => `The asset "${id}" is not in this project. Attach it, then check the motion graphic.`);
}
