// SPDX-License-Identifier: AGPL-3.0-only
// Registry queries (T10a): discovery, details and add checks. R1 refusals = {success:false, error (title), message (detail), code}.
import type { Category, EffectDefinition, ItemType, ParamDef } from './schema';
import { CATEGORY_ORDER, EFFECTS, effectById } from './registry';

export interface Refusal { success: false; error: string; message: string; code: string }
export interface Ok<T> { success: true; data: T }
export type Result<T> = Ok<T> | Refusal;

export const refuse = (code: string, error: string, message: string): Refusal => ({ success: false, error, message, code });

/** Item types that take effects at all (error codes §7 `UNSUPPORTED_ITEM_TYPE`). */
export const EFFECT_ITEM_TYPES: ItemType[] = ['video', 'image', 'text', 'shape', 'motionGraphic'];

export const discoverable = (): EffectDefinition[] => EFFECTS.filter(e => e.visibility === 'discoverable');
export const discoverableIds = (): string[] => discoverable().map(e => e.id);

const unknownEffect = (id: string) =>
  refuse('UNKNOWN_EFFECT', 'Unknown effect', `Effect '${id}' not found. Available: ${discoverableIds().join(', ')}`);
const deprecatedEffect = (e: EffectDefinition) =>
  refuse('UNKNOWN_EFFECT', 'Unknown effect', `Effect '${e.id}' is deprecated. ${e.replacement ?? ''}`.trim());

/** `listEffects`: discoverable ids grouped by category in catalogue order; empty categories omitted. */
export function listEffects(itemType?: string): Ok<Partial<Record<Category, string[]>>> {
  const data: Partial<Record<Category, string[]>> = {};
  for (const cat of CATEGORY_ORDER) {
    const ids = discoverable().filter(e => e.category === cat && (itemType === undefined || e.itemTypes.includes(itemType as ItemType))).map(e => e.id);
    if (ids.length) data[cat] = ids;
  }
  return { success: true, data };
}

export interface ParamDetails {
  key: string; type: ParamDef['type']; label: string; default: unknown; animatable: boolean;
  min?: number; max?: number; step?: number; unit?: string; group?: string;
}
export interface EffectDetails {
  id: string; name: string; category: Category; description: string; renderType: EffectDefinition['renderType'];
  tags: string[]; itemTypes: ItemType[]; params: ParamDetails[]; retired?: true; replacement?: string;
}

/** `getEffectDetails`: discoverable or retired effects. Select option lists are not part of the details (inventory §Gaps). */
export function getEffectDetails(id: string): Result<EffectDetails> {
  const e = effectById(id);
  if (!e || e.visibility === 'hidden') return unknownEffect(id);
  const params = e.params.filter(p => !p.hidden).map((p): ParamDetails => ({
    key: p.key, type: p.type, label: p.label, default: p.default, animatable: p.animatable,
    ...(p.type === 'number' ? { min: p.min, max: p.max, step: p.step, ...(p.unit ? { unit: p.unit } : {}) } : {}),
    ...(p.group ? { group: p.group } : {}),
  }));
  return {
    success: true,
    data: {
      id: e.id, name: e.name, category: e.category, description: e.description, renderType: e.renderType, tags: e.tags,
      itemTypes: e.itemTypes, params, ...(e.visibility === 'retired' ? { retired: true as const, replacement: e.replacement } : {}),
    },
  };
}

/**
 * Can a new instance of `id` be added to an item of `itemType`? Retired → `UNKNOWN_EFFECT` "is deprecated" with the
 * replacement note (tickets file, registry visibility rule); hidden → not found.
 */
export function checkAddable(id: string, itemType: string): Result<EffectDefinition> {
  if (!EFFECT_ITEM_TYPES.includes(itemType as ItemType))
    return refuse('UNSUPPORTED_ITEM_TYPE', 'Unsupported item type', `'${itemType}' items don't support effects. Effects work on: ${EFFECT_ITEM_TYPES.join(', ')}.`);
  const e = effectById(id);
  if (!e || e.visibility === 'hidden') return unknownEffect(id);
  if (e.visibility === 'retired') return deprecatedEffect(e);
  if (!e.itemTypes.includes(itemType as ItemType)) {
    const supported = discoverable().filter(d => d.itemTypes.includes(itemType as ItemType)).map(d => d.id);
    return refuse('EFFECT_NOT_SUPPORTED', 'Effect not supported', `'${itemType}' doesn't support '${id}'. Supported: ${supported.join(', ')}.`);
  }
  return { success: true, data: e };
}

/** writeEffects' retired-add refusal (error codes §7 `EFFECT_DEPRECATED`); which of the two codes writeEffects uses is a T10 open question. */
export const retiredAddRefusal = (id: string): Refusal =>
  refuse('EFFECT_DEPRECATED', 'Effect deprecated', `'${id}' is retired and can't be newly added. Existing instances remain editable.`);
