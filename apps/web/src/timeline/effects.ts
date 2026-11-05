// SPDX-License-Identifier: AGPL-3.0-only
// T10 effect stacks on items (findings §6; part 2 §39; part 3 §46.9; contracts #29; agent tool results §9 and l.1350).
// Stored instance: `{id effect_<epoch ms>_<9 chars>, effectId, enabled, order, parameters {key {defaultValue, keyframes}}}`;
// parameter keyframe times sit on the trim axis like item properties (T04). Agent effect ids are `<effectType>_<1-based
// stack position>`; they exist only on the agent side. The UI edits, the Color card's block (part 4 §49.1 [C]) and
// writeEffects all run here, so both paths store the same instance. Pure functions over a document; a refusal throws
// and the bus rolls the whole command back.
import type { ProjectDocument, RecordData } from '../store/model';
import { COLOUR_BLOCK_EFFECTS, type ColourBlockEffect } from '../effects/colour-block';
import { checkAddable, retiredAddRefusal, type Refusal } from '../effects/queries';
import { effectById, TRANSPORT_STAGES } from '../effects/registry';
import type { NumberParam, ParamDef, ParamValues } from '../effects/schema';
import { newInstanceParams, validateParams } from '../effects/validate';
import { CommandError, fail, item, newId, trackLocked } from './model';
import { evaluate, propertyTime, sorted, toTimelineMs, type Prop } from './properties';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const refused = (r: Refusal): never => fail(r.code, r.error, { message: r.message });
const refuse = (code: string, error: string, message: string): never => fail(code, error, { message });
const isObject = (v: unknown): v is RecordData => !!v && typeof v === 'object' && !Array.isArray(v);
/** writeEffects adding a retired id: `EFFECT_DEPRECATED` with the error codes §7 text, then the registry's replacement note
 *  (the UI addEffect intent keeps checkAddable's UNKNOWN_EFFECT, error codes §7 l.187). Null for an id that is not retired. */
function retiredAdd(id: string): Refusal | null {
  const e = effectById(id);
  if (e?.visibility !== 'retired') return null;
  const r = retiredAddRefusal(id);
  return { ...r, message: `${r.message} ${e.replacement ?? ''}`.trim() };
}
const lockCheck = (doc: ProjectDocument, i: RecordData) => { if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`); };

const INTERNAL = new Set<string>(TRANSPORT_STAGES.map(s => s.id));
/** Transport stages stored in a stack (T15's `stacked-alpha` marker) are pipeline stages, not effects: no agent id, no card. */
export const isInternal = (e: RecordData) => INTERNAL.has(e.effectId);
/** effect_<epoch ms>_<9 chars>; the random part follows model.ts's injectable source (as keyframe ids do). */
export const effectInstanceId = () => `effect_${Date.now()}_${newId('').slice(1, 10).padEnd(9, '0')}`;

// ---- The stack.
/** The stored stack in stack order (`order`, then array position). */
export function effectStack(i: RecordData): RecordData[] {
  const list: RecordData[] = Array.isArray(i.effects) ? i.effects : [];
  return list.map((e, n) => ({ e, n })).sort((a, b) => (Number.isFinite(a.e.order) ? a.e.order : a.n) - (Number.isFinite(b.e.order) ? b.e.order : b.n) || a.n - b.n).map(x => x.e);
}
/** Writes the stack back in stack order: transport stages first (they unpack the frame), orders 0…n−1. */
function store(i: RecordData, list: RecordData[]) {
  i.effects = [...list.filter(isInternal), ...list.filter(e => !isInternal(e))];
  i.effects.forEach((e: RecordData, n: number) => { e.order = n; });
}

// ---- Parameters: the stored shape, read through one seam (a bare stored value reads as the static value, no keyframes).
export function paramProp(e: RecordData, key: string): Prop | undefined {
  const p = e.parameters?.[key];
  if (p === undefined || p === null) return undefined;
  if (isObject(p) && 'defaultValue' in p) return { defaultValue: p.defaultValue, keyframes: Array.isArray(p.keyframes) ? p.keyframes : [] };
  return { defaultValue: p, keyframes: [] };
}
export const paramDef = (e: RecordData, key: string): ParamDef | undefined => effectById(e.effectId)?.params.find(p => p.key === key);
/** The stored parameter, created on first write from the definition default. */
export function ensureParam(e: RecordData, key: string): Prop {
  const p = paramProp(e, key) ?? { defaultValue: structuredClone(paramDef(e, key)?.default ?? null), keyframes: [] };
  (e.parameters ??= {})[key] = p;
  return p;
}
/** The static value, else the definition default. */
export const paramValue = (e: RecordData, key: string): unknown => paramProp(e, key)?.defaultValue ?? paramDef(e, key)?.default;
/** Static values: a keyframed parameter changes only its default value (contracts #29: edits keep keyframes). */
function setParams(e: RecordData, values: ParamValues) {
  for (const [k, v] of Object.entries(values)) if (!same(paramProp(e, k)?.defaultValue, v)) ensureParam(e, k).defaultValue = v;
}
/** Render-time values of one instance at item-local ms (T04's evaluator on the trim axis). */
export function effectParamsAt(i: RecordData, e: RecordData, local: number): RecordData {
  const t = propertyTime(i, local), out: RecordData = {};
  for (const k of Object.keys(e.parameters ?? {})) { const p = paramProp(e, k)!; out[k] = evaluate(p.keyframes, p.defaultValue, t); }
  return out;
}
const validated = (effectId: string, values: unknown, where: string): ParamValues => {
  if (!isObject(values)) refuse('INVALID_PARAM_VALUE', 'Invalid parameter value', `On '${where}': parameters must be an object of name → value.`);
  const r = validateParams(effectId, values as RecordData);
  return r.success ? r.data : refused(r);
};

// ---- Agent effect ids (results l.1350: 1-based stack position; G-07: a re-added curves effect became `curves_2`).
export type AgentEffect = { agentId: string; entry: RecordData };
export const agentEffects = (i: RecordData): AgentEffect[] =>
  effectStack(i).filter(e => !isInternal(e)).map((entry, n) => ({ agentId: `${entry.effectId}_${n + 1}`, entry }));
export const agentIdOf = (i: RecordData, instanceId: string) => agentEffects(i).find(a => a.entry.id === instanceId)?.agentId;
const available = (i: RecordData) => agentEffects(i).map(a => a.agentId).join(', ') || 'none';
/** The instance behind an agent effect id (INVALID_EFFECT_ID_FORMAT / INVALID_STACK_POSITION / EFFECT_NOT_FOUND, R1). */
export function resolveAgentId(i: RecordData, id: unknown): RecordData {
  const m = typeof id === 'string' ? /^([a-z][a-z0-9-]*)_(.+)$/i.exec(id) : null;
  if (!m || (!/^-?\d+(\.\d+)?$/.test(m[2]))) refuse('INVALID_EFFECT_ID_FORMAT', 'Invalid effect id', `'${String(id)}' invalid. Expected effectName_stackPosition (e.g. 'vignette_1').`);
  if (!/^[1-9]\d*$/.test(m![2])) refuse('INVALID_STACK_POSITION', 'Invalid stack position', 'Stack position must be a positive integer (1-indexed).');
  const hit = agentEffects(i)[Number(m![2]) - 1];
  if (!hit || hit.entry.effectId !== m![1]) refuse('EFFECT_NOT_FOUND', 'Effect not found', `Effect '${id}' not on this item. Available: ${available(i)}`);
  return hit!.entry;
}

/** An effect parameter writeKeyframes may animate (error codes §6: UNKNOWN_PARAMETER / NOT_ANIMATABLE, R1). */
export function animatableParam(e: RecordData, agentId: string, key: string): NumberParam {
  const visible = (effectById(e.effectId)?.params ?? []).filter(p => !p.hidden), d = visible.find(p => p.key === key);
  const animatable = visible.filter((p): p is NumberParam => p.type === 'number' && p.animatable).map(p => p.key);
  if (!d) refuse('UNKNOWN_PARAMETER', 'Unknown parameter', `Parameter '${key}' not on effect '${agentId}'. Valid: ${visible.map(p => p.key).join(', ') || 'none'}`);
  if (d!.type !== 'number' || !d!.animatable) refuse('NOT_ANIMATABLE', 'Parameter not animatable', `'${key}' cannot be keyframed. Animatable: ${animatable.join(', ') || 'none'}`);
  return d as NumberParam;
}

// ---- The agent-facing effects block (results l.1350): non-default or keyframed parameters only; hidden keys and the baked
// LUT table (a 191,664-character string) left out (provisional reading of "internal parameters hidden").
const seconds = (ms: number) => Math.round(ms * 1000) / 1e6;
export function effectsBlock(i: RecordData): RecordData {
  const list = agentEffects(i);
  if (!list.length) return { effects: null, effectsNote: 'No effects on this item' };
  return {
    effects: list.map(({ agentId, entry }, n) => {
      const d = effectById(entry.effectId), parameters: RecordData = {};
      for (const p of d?.params ?? []) {
        const pr = paramProp(entry, p.key);
        if (p.hidden || p.key === 'lutData' || !pr || (!pr.keyframes.length && same(pr.defaultValue, p.default))) continue;
        parameters[p.key] = { value: pr.defaultValue, ...(pr.keyframes.length ? { keyframeCount: pr.keyframes.length, keyframeTimes: sorted(pr.keyframes).map(k => seconds(toTimelineMs(i, k.time))) } : {}) };
      }
      return { effectId: agentId, effectType: entry.effectId, name: d?.name ?? entry.effectId, enabled: entry.enabled !== false, order: n, ...(Object.keys(parameters).length ? { parameters } : {}) };
    }),
    effectsNote: 'Only non-default parameters shown. Use getEffectDetails() for full schemas.',
  };
}

// ---- Stack edits (UI intents address the stored instance id; each runs inside one "Edit items" command).
function itemOf(doc: ProjectDocument, itemId: string): RecordData {
  const i = item(doc, itemId);
  if (!i) return fail('ITEM_NOT_FOUND', `Item '${itemId}' not found`);
  lockCheck(doc, i);
  return i;
}
function entryOf(doc: ProjectDocument, itemId: string, instanceId: string) {
  const i = itemOf(doc, itemId), e = effectStack(i).find(x => x.id === instanceId);
  if (!e) return fail('EFFECT_NOT_FOUND', `Effect '${instanceId}' not on this item`);
  return { i, e };
}
/** Appends a new instance: every parameter stored at its new-instance value (toneCurve 2), `values` validated on top. */
export function appendEffect(i: RecordData, effectId: string, values: ParamValues = {}): RecordData {
  const ok = checkAddable(effectId, i.type);
  if (!ok.success) refused(ok);
  const params = { ...newInstanceParams(effectId), ...values };
  const entry = { id: effectInstanceId(), effectId, enabled: true, order: 0, parameters: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { defaultValue: v, keyframes: [] }])) };
  store(i, [...effectStack(i), entry]);
  return entry;
}
/** The UI addEffect helper (error codes §7 l.193). Its own checks keep their codes (ITEM_NOT_FOUND, UNKNOWN_EFFECT,
 *  EFFECT_NOT_SUPPORTED, UNSUPPORTED_ITEM_TYPE); the add itself failing (a locked track, the instance write throwing) is
 *  ADD_EFFECT_FAILED with the cause in `message` (D26 reading, notes). */
export function addEffect(doc: ProjectDocument, itemIds: string[], effectId: string) {
  for (const id of itemIds) {
    const i = item(doc, id);
    if (!i) fail('ITEM_NOT_FOUND', `Item '${id}' not found`);
    const ok = checkAddable(effectId, i!.type);
    if (!ok.success) refused(ok);
    try { lockCheck(doc, i!); appendEffect(i!, effectId); } catch (e) {
      fail('ADD_EFFECT_FAILED', 'Failed to add effect', { message: e instanceof CommandError ? e.extra.message ?? e.error : (e as Error).message });
    }
  }
}
export function toggleEffect(doc: ProjectDocument, itemId: string, instanceId: string, enabled: boolean) {
  const { e } = entryOf(doc, itemId, instanceId);
  if ((e.enabled !== false) !== enabled) e.enabled = enabled;
}
export function removeEffect(doc: ProjectDocument, itemId: string, instanceId: string) {
  const { i } = entryOf(doc, itemId, instanceId);
  store(i, effectStack(i).filter(x => x.id !== instanceId));
}
/** Moves an instance to 0-based position `to` among the item's effects (transport stages excluded). */
export function moveEffect(doc: ProjectDocument, itemId: string, instanceId: string, to: number) {
  const { i, e } = entryOf(doc, itemId, instanceId), list = effectStack(i).filter(x => !isInternal(x) && x !== e);
  list.splice(Math.min(Math.max(Math.round(to), 0), list.length), 0, e);
  store(i, [...effectStack(i).filter(isInternal), ...list]);
}
export function editEffectParams(doc: ProjectDocument, itemId: string, instanceId: string, values: RecordData) {
  const { e } = entryOf(doc, itemId, instanceId);
  setParams(e, validated(e.effectId, values, e.effectId));
}
/** The card's reset arrow: every parameter back to its new-instance value; keyframes removed (provisional). */
export function resetEffect(doc: ProjectDocument, itemId: string, instanceId: string) {
  const { e } = entryOf(doc, itemId, instanceId), fresh = newInstanceParams(e.effectId);
  for (const k of Object.keys(e.parameters ?? {})) if (!(k in fresh)) delete e.parameters[k];
  for (const [k, v] of Object.entries(fresh)) if (!same(e.parameters?.[k], { defaultValue: v, keyframes: [] })) (e.parameters ??= {})[k] = { defaultValue: v, keyframes: [] };
}

// ---- The Color card's block (part 4 §49.1 [C]): a front end over the FIRST color-wheels, curves and lut instances.
/** First edit creates the instance at the end of the stack; later edits change the first instance's static values. */
export function editColourBlock(doc: ProjectDocument, itemIds: string[], effectId: ColourBlockEffect, values: RecordData) {
  for (const id of itemIds) {
    const i = itemOf(doc, id), checked = validated(effectId, values, effectId);
    const e = effectStack(i).find(x => x.effectId === effectId) ?? appendEffect(i, effectId);
    setParams(e, checked);
  }
}
const blockOf = (i: RecordData) => COLOUR_BLOCK_EFFECTS.map(id => effectStack(i).find(x => x.effectId === id)).filter((e): e is RecordData => !!e);
/** Bypass grade: the card's switch enables or disables all three block instances. */
export function bypassGrade(doc: ProjectDocument, itemIds: string[], enabled: boolean) {
  for (const id of itemIds) for (const e of blockOf(itemOf(doc, id))) if ((e.enabled !== false) !== enabled) e.enabled = enabled;
}
/** Reset grade: the three block instances are deleted. */
export function resetGrade(doc: ProjectDocument, itemIds: string[]) {
  for (const id of itemIds) { const i = itemOf(doc, id), block = new Set(blockOf(i)); if (block.size) store(i, effectStack(i).filter(e => !block.has(e))); }
}

// ---- writeEffects (contracts #29; error codes §7). All items are validated before the first write; agent ids resolve
// against each stack as it was when the call started. Edits and removes run before the adds, so `add` appends.
type Plan = { i: RecordData; edits: { e: RecordData; params: ParamValues; enabled?: boolean }[]; removes: Set<RecordData>; adds: { effectId: string; params: ParamValues }[] };
function plan(doc: ProjectDocument, itemId: unknown, add: unknown[], edits: RecordData): Plan {
  const i = item(doc, itemId as string);
  if (!i) return refuse('TIMELINE_ITEM_NOT_FOUND', 'Item not found', `Item '${String(itemId)}' is not in current state.`);
  lockCheck(doc, i);
  const out: Plan = { i, edits: [], removes: new Set(), adds: [] };
  for (const [agentId, change] of Object.entries(edits)) {
    const e = resolveAgentId(i, agentId);
    if (!isObject(change)) refuse('INVALID_PARAM_VALUE', 'Invalid parameter value', `On '${agentId}': expected {params?, enabled?, remove?}.`);
    if (change.remove === true) { out.removes.add(e); continue; }
    if (change.enabled !== undefined && typeof change.enabled !== 'boolean') refuse('INVALID_PARAM_VALUE', 'Invalid parameter value', `On '${agentId}': 'enabled' expects true or false, got ${JSON.stringify(change.enabled)}`);
    out.edits.push({ e, params: change.params === undefined ? {} : validated(e.effectId, change.params, e.effectId), enabled: change.enabled });
  }
  for (const a of add) {
    if (!isObject(a) || typeof a.effectId !== 'string') refuse('INVALID_ADD', 'Invalid add entry', 'Each add entry needs `effectId` (string).');
    const ok = checkAddable((a as RecordData).effectId, i.type);
    if (!ok.success) refused(ok.code === 'UNKNOWN_EFFECT' ? retiredAdd((a as RecordData).effectId) ?? ok : ok);
    out.adds.push({ effectId: (a as RecordData).effectId, params: (a as RecordData).initialParameters === undefined ? {} : validated((a as RecordData).effectId, (a as RecordData).initialParameters, (a as RecordData).effectId) });
  }
  return out;
}
export function writeEffects(doc: ProjectDocument, args: RecordData): RecordData {
  const single = args.itemId !== undefined, many = args.itemIds !== undefined;
  if (single === many || (many && (!Array.isArray(args.itemIds) || !args.itemIds.length))) fail('INVALID_EFFECT_TARGETS', 'Provide exactly one of itemId or itemIds');
  if (args.add !== undefined && !Array.isArray(args.add)) refuse('INVALID_ADD', 'Invalid add entry', 'Each add entry needs `effectId` (string).');
  if (args.effects !== undefined && !isObject(args.effects)) refuse('INVALID_PARAM_VALUE', 'Invalid parameter value', '`effects` must map agent effect ids (e.g. vignette_1) to {params?, enabled?, remove?}.');
  const add: unknown[] = args.add ?? [], edits: RecordData = args.effects ?? {};
  if (!add.length && !Object.keys(edits).length) refuse('EMPTY_PAYLOAD', 'Empty payload', 'writeEffects needs `add` (new effects) and/or `effects` (per-effect edits).');
  const ids: unknown[] = single ? [args.itemId] : [...new Set(args.itemIds as unknown[])];
  if (single) return written(ids, [plan(doc, args.itemId, add, edits)]);
  const plans: Plan[] = [], failures: RecordData[] = [];
  for (const id of ids) {
    try { plans.push(plan(doc, id, add, edits)); } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      failures.push({ itemId: id, code: e.code, error: e.error, ...(e.extra.message !== undefined ? { message: e.extra.message } : {}) });
    }
  }
  if (failures.length) fail(failures[0].code ?? 'EFFECT_VALIDATION_FAILED', `${failures.length} item(s) failed effect validation`,
    { message: `No effects were changed. ${failures.map(f => `${f.itemId}: ${f.message ?? f.error}`).join(' ')}`, failures });
  return written(ids, plans);
}
function written(ids: unknown[], plans: Plan[]): RecordData {
  const items = plans.map(({ i, edits, removes, adds }) => {
    for (const { e, params, enabled } of edits) { setParams(e, params); if (enabled !== undefined && (e.enabled !== false) !== enabled) e.enabled = enabled; }
    if (removes.size) store(i, effectStack(i).filter(e => !removes.has(e)));
    const added = adds.map(a => appendEffect(i, a.effectId, a.params).id);
    return { itemId: i.id, added: added.map(id => agentIdOf(i, id)), ...effectsBlock(i) };
  });
  const n = items.length;
  return { success: true, message: `Effects written on ${n === 1 ? `'${items[0].itemId}'` : `${n} items`} atomically.`, data: { itemIds: ids, items } };
}
