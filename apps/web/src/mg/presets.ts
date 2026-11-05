// SPDX-License-Identifier: AGPL-3.0-only
// Motion-graphic preset loader (T08; coordinator split, 2 Nov: T22 ships the content and applyPreset, GFX-10's Save as Preset
// is T22's). A preset has Xapp's data shape (findings part 2 §31): mg_code, optional landscape mg_code_h, spatial / spatial_h
// boxes and duration_ms (default 5000). Placement (§31): a landscape canvas with mg_code_h uses it and spatial_h on a 1920 ×
// 1080 reference; otherwise mg_code and spatial on 1080 × 1920. A full-frame box covers the whole canvas; a box touching the
// bottom (y + h ≥ reference height − 10, i.e. 1910 on the portrait reference) is scaled per axis and pinned to the bottom;
// any other box is fit-scaled uniformly and centred. The item starts at the start time and lasts duration_ms, which is also
// its designed length (contracts addMotionGraphic: presets set it from their own length).
import type { ProjectDocument, RecordData } from '../store/model';
import type { ProjectStore } from '../store/database';
import { fail, fmt, insertTrack, newId, newTrack } from '../timeline/model';
import { storedProperties } from '../timeline/properties';

export type Box = { x: number; y: number; width: number; height: number };
export type GraphicPreset = { id: string; name: string; category?: string; mg_code: string; mg_code_h?: string; spatial?: Box; spatial_h?: Box; duration_ms: number };
export const USER_PRESETS_ROW = 'mg-presets';
const PORTRAIT = { width: 1080, height: 1920 }, LANDSCAPE = { width: 1920, height: 1080 };

const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const box = (v: unknown) => v === undefined || (!!v && finite((v as Box).x) && finite((v as Box).y) && finite((v as Box).width) && finite((v as Box).height) && (v as Box).width > 0 && (v as Box).height > 0);
/** The reason a record is not a motion-graphic preset, or null. */
export function presetProblem(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const p = r as RecordData;
  if (!text(p.id)) return 'id is missing';
  if (!text(p.name)) return 'name is missing';
  if (!text(p.mg_code)) return 'mg_code is missing';
  if (p.mg_code_h !== undefined && !text(p.mg_code_h)) return 'mg_code_h is not code';
  if (!box(p.spatial)) return 'spatial is not a box';
  if (!box(p.spatial_h)) return 'spatial_h is not a box';
  if (p.duration_ms !== undefined && !(finite(p.duration_ms) && p.duration_ms > 0)) return 'duration_ms must be positive';
  return null;
}
/** The valid presets of a list (duration_ms defaulted) and why each other record was left out. */
export function loadGraphicPresets(list: unknown): { presets: GraphicPreset[]; skipped: { index: number; reason: string }[] } {
  const presets: GraphicPreset[] = [], skipped: { index: number; reason: string }[] = [];
  (Array.isArray(list) ? list : []).forEach((r, index) => {
    const reason = presetProblem(r);
    if (reason) skipped.push({ index, reason });
    else presets.push({ ...r, duration_ms: r.duration_ms ?? 5000 });
  });
  return { presets, skipped };
}
/** The user's own presets (My Presets), kept in one settings row for every project. */
export async function userGraphicPresets(store: ProjectStore) {
  return loadGraphicPresets((await store.row<{ id: string; presets: unknown }>('settings', USER_PRESETS_ROW))?.presets);
}

/** The code and box a preset gets on a canvas (§31). */
export function placeGraphicPreset(p: GraphicPreset, canvas: { width: number; height: number }): { code: string; box: Box } {
  const landscape = canvas.width > canvas.height && !!p.mg_code_h, ref = landscape ? LANDSCAPE : PORTRAIT;
  const b = (landscape ? p.spatial_h : p.spatial) ?? { x: 0, y: 0, ...ref }, W = canvas.width, H = canvas.height;
  const code = landscape ? p.mg_code_h! : p.mg_code;
  if (b.x === 0 && b.y === 0 && b.width === ref.width && b.height === ref.height) return { code, box: { x: 0, y: 0, width: W, height: H } };
  if (b.y + b.height >= ref.height - 10) {
    const sx = W / ref.width, h = b.height * H / ref.height;
    return { code, box: { x: b.x * sx, y: H - h, width: b.width * sx, height: h } };
  }
  const s = Math.min(W / ref.width, H / ref.height), ox = (W - ref.width * s) / 2, oy = (H - ref.height * s) / 2;
  return { code, box: { x: b.x * s + ox, y: b.y * s + oy, width: b.width * s, height: b.height * s } };
}
/** Places a preset as one motion graphic on a new overlay track (inside a bus command; T22's applyPreset and My Presets). */
/** Add Blank Motion Graphic (the rail panel, findings part 3 §46.3): an empty graphic covering the whole canvas on a new
 *  overlay track. It has no code (drawn as nothing; editMotionGraphic refuses it NO_CODE, as Xapp refused its 0–5 s
 *  whole-canvas sample, graphic modes 20 Oct); its designed length is the clip length (T08 notes). */
export function addBlankGraphic(doc: ProjectDocument, from: number, to: number): RecordData {
  if (!(from >= 0 && to > from)) fail('INVALID_DURATION', `duration must be positive. Received: ${fmt(to - from)}s.`);
  const t = insertTrack(doc, newTrack(doc, 'overlay')), length = to - from;
  const record: RecordData = { id: newId('item'), type: 'motionGraphic', trackId: t.id, display: { from, to }, playbackRate: 1, trim: { from: 0, to: length }, sourceDuration: length,
    details: { name: 'Motion graphic' }, metadata: {}, properties: storedProperties({ positionX: 0, positionY: 0, width: doc.size.width, height: doc.size.height, scale: 1 }), masks: [], effects: [] };
  doc.items.push(record);
  return record;
}

export function applyGraphicPreset(doc: ProjectDocument, p: GraphicPreset, startMs = 0): RecordData {
  if (!(startMs >= 0)) fail('INVALID_TIMELINE_START', `timelineStart must be >= 0. Received: ${fmt(startMs)}s.`);
  const { code, box } = placeGraphicPreset(p, doc.size), t = insertTrack(doc, newTrack(doc, 'overlay')), length = p.duration_ms;
  const record: RecordData = { id: newId('item'), type: 'motionGraphic', trackId: t.id, display: { from: startMs, to: startMs + length }, playbackRate: 1, trim: { from: 0, to: length }, sourceDuration: length,
    details: { name: p.name, code }, metadata: { presetId: p.id }, properties: storedProperties({ positionX: box.x, positionY: box.y, width: box.width, height: box.height, scale: 1 }), masks: [], effects: [] };
  doc.items.push(record);
  return record;
}
