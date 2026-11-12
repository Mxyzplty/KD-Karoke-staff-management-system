// SPDX-License-Identifier: AGPL-3.0-only
// Style presets (T22; findings part 2 §31). A preset is either direct items (text and shape items authored with normalised
// boxes on a canvas_size, default 1080 × 1920) or one motion graphic (T08's GraphicPreset fields). The id is
// `<category>/<slug>`; the category is the id's prefix. The data shape is §31's; every preset shipped is Cutframe's own.
// Cutframe readings (§31 gives no units and no keyframe shape): relativeStart, duration and keyframe times are in ms;
// `properties` holds keyframe lists only, a static style value goes in `details`.
import type { RecordData } from '../store/model';
import type { Easing } from '../timeline/properties';
import { validEasing } from '../timeline/properties';
import { SHAPE_TYPES } from '../timeline/shapes';
import { presetProblem, type GraphicPreset } from '../mg/presets';

export const CATEGORIES = [
  { slug: 'text', label: 'Text' }, { slug: 'title-cards', label: 'Title Cards' }, { slug: 'lower-thirds', label: 'Lower Thirds' },
  { slug: 'info-cards', label: 'Info Cards' }, { slug: 'slide-in-panels', label: 'Panels' }, { slug: 'misc', label: 'Misc' },
  { slug: 'overlays', label: 'Overlays' }, { slug: 'collages', label: 'Collages' },
] as const;
export type Category = typeof CATEGORIES[number]['slug'];
export const isCategory = (v: unknown): v is Category => CATEGORIES.some(c => c.slug === v);
export const categoryOf = (id: string) => id.slice(0, id.indexOf('/')) as Category;

export const DIRECT_TYPES = ['text', 'shape'] as const;
export const DEFAULT_CANVAS = { width: 1080, height: 1920 };
/** The detail fields and keyframed properties that §31 scales to the canvas (normalised 0…1 in the preset). */
export const SCALED_DETAILS = ['left', 'top', 'width', 'height', 'fontSize'] as const;
export const SCALED_PROPERTIES = ['positionX', 'positionY', 'width', 'height', 'fontSize'] as const;

export type PresetKeyframe = { time: number; value: number; easing?: Easing };
export type PresetItem = { type: typeof DIRECT_TYPES[number]; relativeStart: number; duration: number; details: RecordData; properties?: Record<string, PresetKeyframe[]> };
type Listed = { id: string; name: string; description: string };
export type DirectPreset = Listed & { items: PresetItem[]; canvas_size?: { width: number; height: number } };
export type GraphicStylePreset = Listed & GraphicPreset;
export type StylePreset = DirectPreset | GraphicStylePreset;
export const isDirect = (p: StylePreset): p is DirectPreset => Array.isArray((p as DirectPreset).items);
/** browsePresets' `type` (results, browsePresets): "text" places direct items, "motion-graphic" one graphic. */
export const presetType = (p: StylePreset) => isDirect(p) ? 'text' : 'motion-graphic';

const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function itemProblem(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const i = r as RecordData, d = i.details;
  if (!DIRECT_TYPES.includes(i.type)) return `type must be one of ${DIRECT_TYPES.join(', ')}`;
  if (!(finite(i.relativeStart) && i.relativeStart >= 0)) return 'relativeStart must be 0 or more';
  if (!(finite(i.duration) && i.duration > 0)) return 'duration must be positive';
  if (!d || typeof d !== 'object') return 'details is missing';
  if (!finite(d.left) || !finite(d.top)) return 'details.left and details.top must be numbers';
  if (!(finite(d.width) && d.width > 0) || !(finite(d.height) && d.height > 0)) return 'details.width and details.height must be positive';
  if (i.type === 'text' && (typeof d.text !== 'string' || !(finite(d.fontSize) && d.fontSize > 0))) return 'a text item needs details.text and a positive details.fontSize';
  if (i.type === 'shape' && !SHAPE_TYPES.includes(d.shapeType)) return `details.shapeType must be one of ${SHAPE_TYPES.join(', ')}`;
  if (i.properties !== undefined) {
    if (!i.properties || typeof i.properties !== 'object' || Array.isArray(i.properties)) return 'properties is not an object';
    for (const [key, list] of Object.entries(i.properties))
      if (!Array.isArray(list) || list.some(k => !k || !finite(k.time) || k.time < 0 || !finite(k.value) || k.easing !== undefined && !validEasing(k.easing))) return `properties.${key} is not a keyframe list`;
  }
  return null;
}
/** The reason a record is not a style preset, or null. A record with neither items nor mg_code is refused here; applyPreset
 *  answers PRESET_EMPTY for one that reaches it. */
export function stylePresetProblem(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const p = r as RecordData;
  if (!text(p.id) || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(p.id) || !isCategory(categoryOf(p.id))) return 'id must be <category>/<slug>';
  if (!text(p.name)) return 'name is missing';
  if (!text(p.description)) return 'description is missing';
  if (p.items === undefined) return p.mg_code === undefined ? 'has neither items nor mg_code' : presetProblem(p);
  if (!Array.isArray(p.items) || !p.items.length) return 'items is empty';
  const c = p.canvas_size;
  if (c !== undefined && !(c && finite(c.width) && c.width > 0 && finite(c.height) && c.height > 0)) return 'canvas_size is not a size';
  for (const [n, i] of p.items.entries()) { const reason = itemProblem(i); if (reason) return `items[${n}]: ${reason}`; }
  return null;
}
