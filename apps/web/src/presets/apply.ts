// SPDX-License-Identifier: AGPL-3.0-only
// Applying a style preset (T22; findings part 2 §31). Direct items are scaled to the canvas: fit scale s = min(W / srcW,
// H / srcH), the effective area srcW·s × srcH·s centred; left → x·effW + offsetX, top → y·effH + offsetY, width and fontSize
// × effW, height × effH; keyframed positionX / positionY / width / fontSize / height likewise. Each item starts at the start
// time + its relativeStart, on its own new overlay track. A motion-graphic preset goes through T08's applyGraphicPreset.
// Cutframe reading: every scaled value is rounded to 0.01 (§31 says so for keyframe values only).
import type { ProjectDocument, RecordData } from '../store/model';
import { applyGraphicPreset, type GraphicPreset } from '../mg/presets';
import { projectSize } from '../render/model';
import { ADD_TEXT, fontDetails, textRecord } from '../text/tools';
import { fail, fmt, insertTrack, newId, newTrack } from '../timeline/model';
import { ensureProp, keyframeId, setStatic } from '../timeline/properties';
import { mapPoints, presetPoints, r2, shapeRecord, shifted, type ShapeType } from '../timeline/shapes';
import { DEFAULT_CANVAS, isDirect, type DirectPreset, type PresetKeyframe, type SavedGraphic, type StylePreset } from './model';

export const PRESET_SOURCE = 'cutframe-preset';
export type ScaledItem = { type: 'text' | 'shape'; display: { from: number; to: number }; details: RecordData; properties: Record<string, PresetKeyframe[]> };

/** A direct preset's items on a canvas, in px and ms (§31). Pure. */
export function scaleDirectPreset(p: DirectPreset, canvas: { width: number; height: number }, startMs = 0): ScaledItem[] {
  const src = p.canvas_size ?? DEFAULT_CANVAS, s = Math.min(canvas.width / src.width, canvas.height / src.height);
  const effW = src.width * s, effH = src.height * s, ox = (canvas.width - effW) / 2, oy = (canvas.height - effH) / 2;
  const X = (v: number) => r2(v * effW + ox), Y = (v: number) => r2(v * effH + oy), W = (v: number) => r2(v * effW), H = (v: number) => r2(v * effH);
  const detail: Record<string, (v: number) => number> = { left: X, top: Y, width: W, height: H, fontSize: W };
  const keyed: Record<string, (v: number) => number> = { positionX: X, positionY: Y, width: W, height: H, fontSize: W };
  return p.items.map(i => ({
    type: i.type, display: { from: startMs + i.relativeStart, to: startMs + i.relativeStart + i.duration },
    details: Object.fromEntries(Object.entries(i.details).map(([k, v]) => [k, detail[k] && typeof v === 'number' ? detail[k](v) : v])),
    properties: Object.fromEntries(Object.entries(i.properties ?? {}).map(([k, list]) => [k, list.map(f => ({ ...f, value: keyed[k] ? keyed[k](f.value) : f.value }))])),
  }));
}

const NOT_STYLE = new Set(['left', 'top', 'width', 'height', 'text', 'fontFamily', 'shapeType', 'roundness', 'innerRatio', 'points', 'closed']);
/** The stored item of one scaled preset item: the box, font size and every other detail as stored properties (a text keeps
 *  its text and font in details, a shape its path), keyframes on top. */
function record(i: ScaledItem, trackId: string, presetId: string): RecordData {
  const d = i.details, style = Object.fromEntries(Object.entries(d).filter(([k]) => !NOT_STYLE.has(k)));
  const box = { positionX: d.left, positionY: d.top, width: d.width, height: d.height };
  const r = i.type === 'text'
    ? textRecord({ text: d.text, trackId, display: i.display, details: fontDetails(d.fontFamily ?? ADD_TEXT.family, d.fontWeight, d.fontStyle), properties: { ...box, ...style } })
    : shapeRecord({ id: newId('item'), trackId, display: i.display, shapeType: d.shapeType ?? 'custom', closed: d.closed !== false,
      points: Array.isArray(d.points) ? shifted(mapPoints([d.width, 0, 0, d.height, 0, 0], d.points), 0, 0) : presetPoints(d.shapeType as ShapeType, d.width, d.height, d.roundness, d.innerRatio),
      x: d.left, y: d.top, width: d.width, height: d.height, style });
  r.details.source = PRESET_SOURCE;
  r.metadata = { ...r.metadata, presetId };
  for (const [key, list] of Object.entries(i.properties))
    ensureProp(r, key).keyframes = list.map(f => ({ id: keyframeId(), time: f.time, value: f.value, easing: f.easing ?? 'linear' }));
  return r;
}

/** Places a preset (inside a bus command): the new items, each on a new overlay track. The panel applies at 0 (§31). */
export function applyStylePreset(doc: ProjectDocument, p: StylePreset | GraphicPreset, startMs = 0): RecordData[] {
  if (!(startMs >= 0)) fail('INVALID_TIMELINE_START', `timelineStart must be >= 0. Received: ${fmt(startMs)}s.`);
  if (!isDirect(p)) {
    if (typeof p.mg_code !== 'string' || !p.mg_code.trim()) fail('PRESET_EMPTY', `Preset '${p.id}' has neither items nor motion graphic code.`);
    const r = applyGraphicPreset(doc, p, startMs), { field_values, saved } = p as SavedGraphic, size = projectSize(doc);
    if (field_values) r.details.fieldValues = structuredClone(field_values);
    if (saved && saved.canvas.width === size.width && saved.canvas.height === size.height)
      for (const [key, v] of [['positionX', saved.box.x], ['positionY', saved.box.y], ['width', saved.box.width], ['height', saved.box.height]] as const) setStatic(r, key, v);
    return [r];
  }
  if (!p.items.length) fail('PRESET_EMPTY', `Preset '${p.id}' has neither items nor motion graphic code.`);
  return scaleDirectPreset(p, projectSize(doc), startMs).map(i => {
    const r = record(i, insertTrack(doc, newTrack(doc, 'overlay')).id, p.id);
    doc.items.push(r);
    return r;
  });
}
