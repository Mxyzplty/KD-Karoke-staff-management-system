// SPDX-License-Identifier: AGPL-3.0-only
// browsePresets (T22; agent tool results §2): the style presets as `{success, count, presets[{id, name, category,
// description, type}]}`, sorted by id. `category` is the id's prefix; `query` matches the name and the description, any
// letter case. No match is a normal result with count 0. Xapp's row has no `success` field; Cutframe adds it, as every
// in-tab tool result has one.
import type { RecordData } from '../store/model';
import { STYLE_PRESETS } from './content';
import { categoryOf, presetType, type StylePreset } from './model';

export const findStylePreset = (id: unknown, presets: StylePreset[] = STYLE_PRESETS) => presets.find(p => p.id === id);
export function browsePresets(args: RecordData = {}, presets: StylePreset[] = STYLE_PRESETS) {
  const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const list = presets
    .filter(p => (args.category === undefined || categoryOf(p.id) === args.category) && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)))
    .map(p => ({ id: p.id, name: p.name, category: categoryOf(p.id), description: p.description, type: presetType(p) }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { success: true, count: list.length, presets: list };
}
