// SPDX-License-Identifier: AGPL-3.0-only
// T04 edits shared by the agent tools and the UI intents: writeKeyframes (findings part 2 §41; contracts writeKeyframes;
// agent tool results §6 G-02), setTimeRemap (results §2), editProperties (results §2, normal path, one result family),
// change speed and remap on/off (part 3 §45.5). Each runs inside one bus command: a throw rolls the whole draft back, so
// a refusal changes nothing even when it is found after an earlier write of the same call.
import type { ProjectDocument, RecordData } from '../store/model';
import { changedFields } from './changes';
import { MIN_ITEM_MS, rippleAt } from './items';
import { EPS, fail, fmt, groupOf, isCaption, item, itemsOn, span, toMs, trackLocked } from './model';
import type { Keyframe, KeyframePatch, KeyframeRef } from './properties';
import {
  EASINGS, ensureProp, evaluate, KEYFRAME_PROPERTIES, keyframeId, keyframeList, keyframesBlock, prop, rateOf, RATE, REGISTRY, REMAP_TYPES, remapKeyframes,
  setStatic, sorted, specOf, speedRange, staticValue, toTimelineMs, validEasing,
} from './properties';
import { agentIdOf, animatableParam, effectStack, ensureParam, paramProp, resolveAgentId } from './effects';
import { checkTextProperty, isTextKey, TEXT_EDIT_KEYS, writeTextProperties } from '../text/properties';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const show = (v: unknown) => v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** R1 refusal: short title + the documented message. */
const refuse = (code: string, error: string, message: string): never => fail(code, error, { message });
const handleOk = (h: unknown) => Array.isArray(h) && h.length === 2 && isNum(h[0]) && isNum(h[1]) && h[0] >= 0 && h[0] <= 1 && h[1] >= -100 && h[1] <= 100;
const lockCheck = (doc: ProjectDocument, i: RecordData) => { if (trackLocked(doc, i.trackId)) fail('TRACK_LOCKED', `Track ${i.trackId} is locked`); };

/** Checks shared by both keyframe tools: time, easing, handles (error codes §6). */
function checkTime(path: string, t: unknown) {
  if (!isNum(t) || t < 0) refuse('INVALID_KEYFRAME_TIME', 'Invalid keyframe time', `[${path}] time must be a positive number, got: ${show(t)}`);
}
export function checkShape(path: string, e: RecordData) {
  if (e.easing !== undefined && !validEasing(e.easing)) refuse('INVALID_EASING', 'Invalid easing', `[${path}] easing '${show(e.easing)}' not valid. Options: ${EASINGS.join(', ')}`);
  for (const h of ['inHandle', 'outHandle']) if (e[h] !== undefined && !handleOk(e[h]))
    refuse('INVALID_BEZIER_HANDLE', 'Invalid bezier handle', `[${path}] ${h} must be [x, y] with x from 0 to 1 and y from -100 to 100.`);
}
/** A stored keyframe from an input entry; an overwrite keeps the old id and time (§41). */
const keyframe = (e: RecordData, time: number, value: unknown, id = keyframeId()): Keyframe =>
  ({ id, time, value, easing: e.easing ?? 'linear', ...(e.inHandle ? { inHandle: e.inHandle } : {}), ...(e.outHandle ? { outHandle: e.outHandle } : {}) });
const replaceAt = (list: Keyframe[], old: Keyframe, e: RecordData, value: unknown) => { list[list.indexOf(old)] = keyframe(e, old.time, value, old.id); };
/** The nearest keyframe strictly closer than `limit` ms (the first wins a tie). */
function nearest(list: Keyframe[], t: number, limit: number): Keyframe | undefined {
  let best: Keyframe | undefined;
  for (const k of list) if (Math.abs(k.time - t) < limit && (!best || Math.abs(k.time - t) < Math.abs(best.time - t))) best = k;
  return best;
}

// ---- writeKeyframes.
const OPS = ['replace', 'add', 'update', 'remove'] as const;
const keyframeable = (type: string) => KEYFRAME_PROPERTIES.filter(k => specOf(type, k)?.anim);
const TIME_REMAP_FORM = 'Time remap keyframes are written with setTimeRemap: {itemId, keyframes: [{time (timeline seconds), value (source ms), easing?}], replace?}. writeKeyframes only clears the curve: {timeRemap: {replace: []}}.';

export function writeKeyframes(doc: ProjectDocument, args: RecordData): RecordData {
  if (args.maskIndex !== undefined) fail('NOT_IMPLEMENTED', 'Mask keyframes (maskIndex) are not yet implemented (T12).');
  const i = item(doc, args.itemId);
  if (!i) return refuse('ITEM_NOT_FOUND', 'Item not found', `Item '${args.itemId}' not found on timeline.`);
  const payload = args.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).length) fail('MISSING_PARAM', 'payload is required');
  lockCheck(doc, i);
  // T10: `effectId` (agent effect id) targets that effect's parameters, keyframed on the same trim axis as item properties.
  const fx = args.effectId !== undefined ? resolveAgentId(i, args.effectId) : undefined;
  // Validate every property and entry before the first write.
  for (const [p, ops] of Object.entries<RecordData>(payload)) {
    if (fx) animatableParam(fx, args.effectId, p);
    else {
      if (p === 'timeRemap') {
        if (!(ops && Object.keys(ops).length === 1 && Array.isArray(ops.replace) && !ops.replace.length)) refuse('USE_SET_TIME_REMAP', 'Use setTimeRemap for time remap keyframes', TIME_REMAP_FORM);
        continue;
      }
      const spec = specOf(i.type, p), list = `Keyframeable properties on ${i.type} items: ${keyframeable(i.type).join(', ') || 'none'}.`;
      if (!KEYFRAME_PROPERTIES.includes(p)) {
        if (spec) refuse('PROPERTY_NOT_ANIMATABLE', 'Property not animatable', `'${p}' cannot be keyframed on ${i.type} items. ${list}`);
        refuse('INVALID_PROPERTY', 'Invalid property', `'${p}' is not a keyframeable property. Keyframeable item properties: ${KEYFRAME_PROPERTIES.join(', ')}.`);
      }
      if (!spec) refuse('PROPERTY_NOT_ON_TYPE', 'Property not valid for item type', `'${p}' does not exist on ${i.type} items. ${list}`);
      if (!spec!.anim) refuse('PROPERTY_NOT_ANIMATABLE', 'Property not animatable', `'${p}' cannot be keyframed on ${i.type} items. ${list}`);
    }
    if (!ops || typeof ops !== 'object' || !OPS.some(o => ops[o] !== undefined)) refuse('EMPTY_OPS', 'No ops provided', `No ops provided for '${p}'.`);
    for (const o of OPS) if (ops[o] !== undefined && !Array.isArray(ops[o]))
      fail('INVALID_TOOL_INPUT', 'Invalid input for writeKeyframes', { message: `$.payload.${p}.${o}: must be array`, data: { details: { errors: [{ path: `$.payload.${p}.${o}`, code: 'TYPE', message: 'must be array' }] } } });
    for (const o of ['replace', 'add', 'update'] as const) (ops[o] ?? []).forEach((e: RecordData, n: number) => {
      const path = `${p}.${o}[${n}]`, entry = e ?? {};
      checkTime(path, entry.time);
      if (['value', 'delta', 'factor'].filter(m => entry[m] !== undefined).length > 1)
        refuse('CONFLICTING_KEYFRAME_VALUE_MODES', 'Conflicting value modes', `[${path}] provide at most one of value, delta, or factor. Omit all three to capture the current interpolated value.`);
      for (const m of ['value', 'delta', 'factor']) if (entry[m] !== undefined && !isNum(entry[m]))
        refuse(`INVALID_KEYFRAME_${m.toUpperCase()}`, `Invalid keyframe ${m}`, `[${path}] ${m} must be a finite number if provided, got: ${show(entry[m])}`);
      checkShape(path, entry);
      const t = toMs(entry.time);
      if (t < i.display.from - EPS || t > i.display.to + EPS)
        refuse('TIME_OUT_OF_BOUNDS', 'Keyframe time out of bounds', `[${path}] keyframe at ${entry.time}s outside item bounds (${fmt(i.display.from)}s - ${fmt(i.display.to)}s).`);
    });
    (ops.remove ?? []).forEach((t: unknown, n: number) => checkTime(`${p}.remove[${n}]`, t));
  }
  // Apply: per property replace → add → update (keyframes that existed before the call) → remove.
  const at = (time: number) => Math.round((i.trim?.from ?? 0) + (toMs(time) - i.display.from) * rateOf(i)); // stored ms (G-02: rounded first)
  const resolved: Record<string, RecordData[]> = {}, warnings: string[] = [], tracks: RecordData = {};
  for (const [p, ops] of Object.entries<RecordData>(payload)) {
    if (!fx && p === 'timeRemap') { i.timeRemap = null; continue; }
    const spec: { min?: number; max?: number } = fx ? animatableParam(fx, args.effectId, p) : specOf(i.type, p)!, pr = fx ? ensureParam(fx, p) : ensureProp(i, p), pre = new Set(pr.keyframes.map(k => k.id)), echo: RecordData[] = (resolved[p] = []);
    const resolve = (path: string, e: RecordData, t: number, list: Keyframe[]) => {
      const cur = Number(evaluate(list, pr.defaultValue, t));
      const [v, source] = e.value !== undefined ? [e.value, 'value'] : e.delta !== undefined ? [cur + e.delta, 'delta'] : e.factor !== undefined ? [cur * e.factor, 'factor'] : [cur, 'hold'];
      if (!Number.isFinite(v)) refuse('INVALID_RESOLVED_KEYFRAME_VALUE', 'Invalid resolved keyframe value', `[${path}] ${p} resolved to a non-finite value.`);
      if (spec.min !== undefined && v < spec.min) refuse('KEYFRAME_VALUE_OUT_OF_RANGE', 'Keyframe value out of range', `[${path}] ${p} must be at least ${spec.min}, resolved to ${v}.`);
      if (spec.max !== undefined && v > spec.max) refuse('KEYFRAME_VALUE_OUT_OF_RANGE', 'Keyframe value out of range', `[${path}] ${p} must be at most ${spec.max}, resolved to ${v}.`);
      echo.push({ time: e.time, value: v, source });
      return v as number;
    };
    if (ops.replace) {
      const old = pr.keyframes;
      pr.keyframes = sorted(ops.replace.map((e: RecordData, n: number) => { const t = at(e.time); return keyframe(e, t, resolve(`${p}.replace[${n}]`, e, t, old)); }));
    }
    (ops.add ?? []).forEach((e: RecordData, n: number) => {
      const t = at(e.time), v = resolve(`${p}.add[${n}]`, e, t, pr.keyframes), hit = nearest(pr.keyframes, t, 4);
      if (hit) { replaceAt(pr.keyframes, hit, e, v); warnings.push(`${p}: add at ${e.time}s replaced the keyframe already at that instant.`); }
      else pr.keyframes.push(keyframe(e, t, v));
    });
    (ops.update ?? []).forEach((e: RecordData, n: number) => {
      const t = at(e.time), v = resolve(`${p}.update[${n}]`, e, t, pr.keyframes), hit = nearest(pr.keyframes.filter(k => pre.has(k.id)), t, 100);
      if (hit) replaceAt(pr.keyframes, hit, e, v); else pr.keyframes.push(keyframe(e, t, v));
    });
    if (ops.remove?.length) {
      const missing = ops.remove.filter((s: number) => !pr.keyframes.some(k => Math.abs(k.time - at(s)) < 100));
      if (missing.length) refuse('REMOVE_TIME_NOT_FOUND', 'No keyframes at remove times', `For '${p}', no keyframes found at ${missing.map((s: number) => `${s}s`).join(', ')} (100ms tolerance). Available: ${
        sorted(pr.keyframes).map(k => `${(toTimelineMs(i, k.time) / 1000).toFixed(3)}s`).join(', ') || 'none'}.`);
      pr.keyframes = pr.keyframes.filter(k => !ops.remove.some((s: number) => Math.abs(k.time - at(s)) < 100));
    }
    // Storage order per findings part 2 §41: replace stores sorted, add / update append, overwrites keep their place;
    // readers sort (evaluator, UI, graph). Confirmed or refuted by the Author-run G-02 replay.
  }
  const block = keyframesBlock(i).keyframes ?? {};
  for (const p of Object.keys(payload)) {
    const ep = fx && paramProp(fx, p);
    tracks[p] = ep ? { defaultValue: ep.defaultValue, keyframeCount: ep.keyframes.length, keyframes: keyframeList(ep.keyframes, t => toTimelineMs(i, t)) }
      : block[p] ?? { defaultValue: p === 'timeRemap' ? 0 : prop(i, p)?.defaultValue, keyframeCount: 0, keyframes: [] };
  }
  const counts = Object.keys(payload).map(p => `${p} (${tracks[p].keyframeCount})`).join(', ');
  return { success: true, message: `Keyframes written on '${i.id}'${fx ? ` effect '${args.effectId}'` : ''}: ${counts}.${warnings.length ? ` Warnings: ${warnings.join(' ')}` : ''}`,
    data: { itemId: i.id, ...(fx ? { effectId: args.effectId } : {}), keyframes: tracks, resolvedKeyframes: resolved, ...(warnings.length ? { warnings } : {}) } };
}

// ---- setTimeRemap.
export function setTimeRemap(doc: ProjectDocument, args: RecordData): RecordData {
  const i = item(doc, args.itemId);
  if (!i) return refuse('ITEM_NOT_FOUND', 'Item not found', `Item '${args.itemId}' not found on timeline.`);
  if (!REMAP_TYPES.has(i.type)) refuse('INVALID_ITEM_TYPE', 'Invalid item type', `Time remapping only works on video and audio items, but '${i.id}' is type '${i.type}'.`);
  const ks = args.keyframes;
  if (!Array.isArray(ks) || !ks.length) refuse('INVALID_KEYFRAMES', 'Invalid keyframes', 'Keyframes must be a non-empty array. Each keyframe needs { time (seconds), value (source ms) }.');
  lockCheck(doc, i);
  const from = i.display.from, to = i.display.to;
  ks.forEach((e: RecordData, n: number) => {
    const path = `keyframes[${n}]`, entry = e ?? {};
    checkTime(path, entry.time);
    if (!isNum(entry.value) || entry.value < 0) refuse('INVALID_KEYFRAME_VALUE', 'Invalid keyframe value', `[${path}] value must be a non-negative number of source milliseconds, got: ${show(entry.value)}`);
    checkShape(path, entry);
    const t = toMs(entry.time);
    if (t < from - 10 - EPS || t > to + 10 + EPS)
      refuse('TIME_OUT_OF_BOUNDS', 'Keyframe time out of bounds', `[${path}] keyframe at ${entry.time}s outside clip bounds (${(from / 1000).toFixed(3)}s – ${(to / 1000).toFixed(3)}s).`);
  });
  const replace = args.replace !== false, local = (s: number) => Math.min(Math.max(toMs(s) - from, 0), span(i));
  let list: Keyframe[] = replace ? [] : [...remapKeyframes(i)];
  for (const e of ks as RecordData[]) {
    const t = local(e.time), hit = replace ? undefined : nearest(list, t, 100);
    if (hit) replaceAt(list, hit, e, e.value); else list.push(keyframe(e, t, e.value));
  }
  list = sorted(list); // the remap curve is stored sorted (provisional: findings §38 / results §6 do not give its order)
  i.timeRemap = { defaultValue: 0, keyframes: list };
  const source = typeof i.sourceDuration === 'number' && i.sourceDuration > 0 ? i.sourceDuration : i.trim?.to ?? span(i);
  const warnings = (ks as RecordData[]).filter(e => e.value > source)
    .map(e => `Keyframe at ${e.time}s maps to source ${e.value}ms but source duration is only ${source}ms. The value will be clamped during playback.`);
  const range = speedRange(i, source);
  return { success: true, message: `Set ${ks.length} time remap keyframes on '${i.id}' (${replace ? 'replaced' : 'merged'}). Speed range: ${range.min.toFixed(3)}x – ${range.max.toFixed(3)}x.${warnings.length ? ` Warnings: ${warnings.join(' ')}` : ''}`,
    data: { itemId: i.id, mode: replace ? 'replace' : 'merge', keyframesSet: ks.length, totalKeyframesInTrack: list.length, clipDuration: span(i) / 1000, sourceDuration: source / 1000, speedRange: range, ...(warnings.length ? { warnings } : {}) } };
}

// ---- Change speed (part 3 §45.5, W3-RT-12): start kept; length = trim length ÷ rate (whole ms, ≥ 50 ms); trim unchanged.
// Ripple off: the next clip on the track stops the growth. Ripple on: later items move by the change of the end.
export type SpeedChange = { id: string; rate: number; from: number; to: number; oldEnd: number; blocked: boolean; shifted: string[] };
export function changeSpeed(doc: ProjectDocument, id: string, rate: number, ripple: boolean): SpeedChange {
  const i = item(doc, id);
  if (!i) return fail('ITEM_NOT_FOUND', `Item '${id}' not found`);
  lockCheck(doc, i);
  const from = i.display.from, oldEnd = i.display.to, length = i.trim ? i.trim.to - i.trim.from : span(i) * rateOf(i);
  let to = from + Math.max(MIN_ITEM_MS, Math.round(length / rate)), blocked = false;
  if (!ripple) {
    const next = itemsOn(doc, i.trackId).find(x => x.id !== id && x.display.from >= oldEnd - EPS);
    if (next && to > next.display.from + EPS) { to = next.display.from; blocked = true; }
  }
  i.playbackRate = rate; i.display = { from, to };
  const shifted = ripple ? rippleAt(doc, i.trackId, groupOf(doc, i.trackId), oldEnd, to - oldEnd, new Set([id])) : [];
  return { id, rate, from, to, oldEnd, blocked, shifted };
}

// ---- Remap on / off (UI, part 3 §45.5): on = two linear keyframes {0 → trim start}, {clip length → trim end}; off = no
// curve (speed keeps its old value, length unchanged). Switching to the state the item is already in changes nothing.
function remapItem(doc: ProjectDocument, id: string) {
  const i = item(doc, id);
  if (!i) return fail('ITEM_NOT_FOUND', `Item '${id}' not found`);
  if (!REMAP_TYPES.has(i.type)) refuse('INVALID_ITEM_TYPE', 'Invalid item type', `Time remapping only works on video and audio items, but '${i.id}' is type '${i.type}'.`);
  lockCheck(doc, i);
  return i;
}
export function remapOn(doc: ProjectDocument, id: string) {
  const i = remapItem(doc, id);
  if (i.timeRemap) return;
  const tr = i.trim ?? { from: 0, to: span(i) * rateOf(i) };
  i.timeRemap = { defaultValue: 0, keyframes: [keyframe({}, 0, tr.from), keyframe({}, span(i), tr.to)] };
}
export function remapOff(doc: ProjectDocument, id: string) {
  const i = remapItem(doc, id);
  if (i.timeRemap) i.timeRemap = null;
}

// ---- UI keyframe edits (part 3 §46.10, §45.5 graph editor), addressed by keyframe id; one "Edit items" step each.
// Add is writeKeyframes `add` at the playhead with the held value, so the UI and the agent store the same keyframe. A
// keyframe that is no longer there (a stale selection) changes nothing.
const REMAP = 'timeRemap';
/** The keyframe list behind a reference: a property's or an effect parameter's (trim axis) or the remap curve (item-local
 *  axis), with its bounds. */
function curve(doc: ProjectDocument, itemId: string, key: string, effect?: string) {
  const i = key === REMAP && !effect ? remapItem(doc, itemId) : item(doc, itemId);
  if (!i) return fail('ITEM_NOT_FOUND', `Item '${itemId}' not found`);
  lockCheck(doc, i);
  if (effect) {
    const e = effectStack(i).find(x => x.id === effect);
    if (!e) return fail('EFFECT_NOT_FOUND', `Effect '${effect}' not on this item`);
    const d = animatableParam(e, agentIdOf(i, effect) ?? effect, key), lo = i.trim?.from ?? 0;
    return { i, list: paramProp(e, key)?.keyframes ?? [], lo, hi: lo + span(i) * rateOf(i), min: d.min as number | undefined, max: d.max as number | undefined, store: (list: Keyframe[]) => { ensureParam(e, key).keyframes = list; } };
  }
  if (key === REMAP) return { i, list: remapKeyframes(i), lo: 0, hi: span(i), min: 0, max: undefined as number | undefined,
    store: (list: Keyframe[]) => { i.timeRemap = { defaultValue: i.timeRemap?.defaultValue ?? 0, keyframes: sorted(list) }; } };
  const spec = specOf(i.type, key);
  if (!spec?.anim || !KEYFRAME_PROPERTIES.includes(key)) refuse('PROPERTY_NOT_ANIMATABLE', 'Property not animatable', `'${key}' cannot be keyframed on ${i.type} items.`);
  const lo = i.trim?.from ?? 0;
  return { i, list: prop(i, key)?.keyframes ?? [], lo, hi: lo + span(i) * rateOf(i), min: spec!.min, max: spec!.max, store: (list: Keyframe[]) => { ensureProp(i, key).keyframes = list; } };
}
export function addKeyframe(doc: ProjectDocument, itemId: string, key: string, atMs: number, effect?: string) {
  if (effect) {
    // An effect parameter's diamond: writeKeyframes on that instance's agent id, so the UI and the agent store the same keyframe.
    const i = item(doc, itemId), effectId = i && agentIdOf(i, effect);
    if (!effectId) return void fail('EFFECT_NOT_FOUND', `Effect '${effect}' not on this item`);
    return void writeKeyframes(doc, { itemId, effectId, payload: { [key]: { add: [{ time: atMs / 1000 }] } } });
  }
  if (key !== REMAP) return void writeKeyframes(doc, { itemId, payload: { [key]: { add: [{ time: atMs / 1000 }] } } });
  // Remap curve (graph double-click): setTimeRemap merge at that instant with the curve's current source time.
  const i = remapItem(doc, itemId);
  setTimeRemap(doc, { itemId, keyframes: [{ time: atMs / 1000, value: Math.max(0, Number(evaluate(remapKeyframes(i), 0, atMs - i.display.from))) }], replace: false });
}
export function editKeyframe(doc: ProjectDocument, ref: KeyframeRef, patch: KeyframePatch) {
  const c = curve(doc, ref.itemId, ref.key, ref.effect), old = c.list.find(k => k.id === ref.keyframeId);
  if (!old) return;
  const next: Keyframe = { ...old }, path = `${ref.key}[${ref.keyframeId}]`;
  if (patch.time !== undefined) {
    const t = Math.round(patch.time);
    if (!isNum(patch.time) || t < c.lo - EPS || t > c.hi + EPS) refuse('TIME_OUT_OF_BOUNDS', 'Keyframe time out of bounds', `[${path}] keyframe time ${show(patch.time)} is outside the item.`);
    next.time = t;
  }
  if (patch.value !== undefined) {
    const v = patch.value;
    if (!isNum(v)) refuse('INVALID_KEYFRAME_VALUE', 'Invalid keyframe value', `[${path}] value must be a finite number if provided, got: ${show(v)}`);
    if (c.min !== undefined && v < c.min) refuse('KEYFRAME_VALUE_OUT_OF_RANGE', 'Keyframe value out of range', `[${path}] ${ref.key} must be at least ${c.min}, resolved to ${v}.`);
    if (c.max !== undefined && v > c.max) refuse('KEYFRAME_VALUE_OUT_OF_RANGE', 'Keyframe value out of range', `[${path}] ${ref.key} must be at most ${c.max}, resolved to ${v}.`);
    next.value = v;
  }
  checkShape(path, { easing: patch.easing, inHandle: patch.inHandle ?? undefined, outHandle: patch.outHandle ?? undefined });
  if (patch.easing !== undefined) next.easing = patch.easing;
  for (const h of ['inHandle', 'outHandle'] as const) if (patch[h] === null) delete next[h]; else if (patch[h]) next[h] = patch[h]!;
  c.store(c.list.map(k => k === old ? next : k));
}
export function deleteKeyframe(doc: ProjectDocument, ref: KeyframeRef) {
  const c = curve(doc, ref.itemId, ref.key, ref.effect);
  if (c.list.some(k => k.id === ref.keyframeId)) c.store(c.list.filter(k => k.id !== ref.keyframeId));
}

// ---- editProperties (normal path; one result family, Cutframe note).
const TEXT_KEYS = new Set(['text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'backgroundColor', 'textAlign', 'textDecoration', 'textTransform',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'wordWrap', 'wordBreak', 'look', 'textAnimation']);
const ELEMENT_KEYS = new Set(['colors', 'media']);
/** The 16 blend modes, stored kebab-case (part 5; UI order part 3). */
export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
/** Accepted colour strings (provisional): hex, rgb()/rgba()/hsl()/hsla(), or a CSS colour name (incl. transparent, none). */
const COLOUR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\([^()]*\)|[a-z]+)$/i;
const colourOk = (v: unknown) => typeof v === 'string' && COLOUR.test(v.trim());
const SHADOW = ['blur', 'color', 'x', 'y'];
/** Keys editProperties accepts on a type: its registry plus playbackRate on video / audio, plus T05's text keys on text. */
export const editableKeys = (type: string) => [...Object.keys(REGISTRY[type] ?? {}), ...(type === 'text' ? TEXT_EDIT_KEYS : []), ...(REMAP_TYPES.has(type) ? ['playbackRate'] : [])];
function pointer(type: string, k: string) {
  if (k === 'volume') return ' volume applies only to video and audio items.';
  if (k === 'look') return ' look applies only to text items.';
  if (k === 'textAnimation') return ' textAnimation applies only to text and caption items.';
  if (k === 'brightness' || k === 'blur' || k === 'boxShadow') return ` For ${k} on a ${type} item, add an effect with writeEffects.`;
  if (type === 'shape' && (k === 'borderWidth' || k === 'borderColor')) return " A shape's outline is strokeWidth / strokeColor.";
  if ((type === 'text' || type === 'caption') && (k === 'strokeWidth' || k === 'strokeColor')) return ' A text outline is borderWidth / borderColor.';
  return '';
}
/** One property value on one item (INVALID_PROPERTY / INVALID_PROPERTY_VALUE, R2). */
export function checkProperty(i: RecordData, k: string, v: unknown) {
  const allowed = editableKeys(i.type);
  if (!allowed.includes(k)) fail('INVALID_PROPERTY', `Property '${k}' is not editable on ${i.type} items.${pointer(i.type, k)} Allowed properties: ${allowed.join(', ')}`);
  if (i.type === 'text' && isTextKey(k)) return checkTextProperty(i, k, v);
  const bad = (why: string): never => fail('INVALID_PROPERTY_VALUE', `${k} ${why}`);
  const spec = k === 'playbackRate' ? { default: RATE.default, min: RATE.min, max: RATE.max } : specOf(i.type, k)!, d = spec.default;
  if (k === 'blendMode') { if (!BLEND_MODES.includes(v as string)) bad(`must be one of: ${BLEND_MODES.join(', ')}`); }
  else if (k === 'boxShadow') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) bad('has the wrong value type');
    for (const f of ['blur', 'x', 'y']) if ((v as RecordData)[f] !== undefined && !isNum((v as RecordData)[f])) fail('INVALID_PROPERTY_VALUE', `boxShadow.${f} must be finite`);
    if ((v as RecordData).color !== undefined && !colourOk((v as RecordData).color)) fail('INVALID_PROPERTY_VALUE', `boxShadow.color must be a valid colour, got: ${show((v as RecordData).color)}`);
  } else if (typeof d === 'number') {
    if (typeof v !== 'number') bad('has the wrong value type');
    if (!Number.isFinite(v)) bad('must be finite');
    if (spec.min !== undefined && (v as number) < spec.min) bad(`must be at least ${spec.min}`);
    if (spec.max !== undefined && (v as number) > spec.max) bad(`must be at most ${spec.max}`);
  } else if (typeof d === 'boolean') { if (typeof v !== 'boolean') bad('has the wrong value type'); }
  else if (!colourOk(v)) bad(`must be a valid colour, got: ${show(v)}`);
}
/** Writes one checked value: a keyframed property changes only its default value; boxShadow merges its four fields. */
export function writeProperty(i: RecordData, k: string, v: unknown) {
  const next = k === 'boxShadow' ? { ...(staticValue(i, k) as RecordData), ...Object.fromEntries(SHADOW.filter(f => (v as RecordData)[f] !== undefined).map(f => [f, (v as RecordData)[f]])) } : v;
  if (!same(staticValue(i, k), next)) setStatic(i, k, next);
}
const speedNote = (c: SpeedChange) => c.blocked
  ? `'${c.id}' at ${c.rate}× was stopped at ${fmt(c.to)}s by the next clip on its track, so less of its footage now plays; trimItem with ripple: true can lengthen it and push later clips along.`
  : `'${c.id}' at ${c.rate}× now spans ${fmt(c.from)}–${fmt(c.to)}s (it ended at ${fmt(c.oldEnd)}s); later clips did not move.`;

export function editProperties(doc: ProjectDocument, args: RecordData): RecordData {
  const props = args.properties, ids: string[] | null = Array.isArray(args.itemIds) ? args.itemIds : args.itemId !== undefined ? [args.itemId] : null;
  if (!props || typeof props !== 'object' || Array.isArray(props) || !Object.keys(props).length) fail('MISSING_PARAM', 'properties is required');
  if (!ids?.length) fail('MISSING_PARAM', 'Provide itemId (single) or itemIds (batch)');
  const unique = [...new Set(ids)], keys = Object.keys(props);
  const missing = unique.filter(id => !item(doc, id));
  if (missing.length) fail('ITEM_NOT_FOUND', `Unknown item ID(s): ${missing.join(', ')}`);
  const items = unique.map(id => item(doc, id)!), text = keys.filter(k => TEXT_KEYS.has(k)), element = keys.filter(k => ELEMENT_KEYS.has(k));
  if (text.length && items.some(isCaption)) fail('NOT_IMPLEMENTED', `${text.join(', ')} ${text.length === 1 ? 'is' : 'are'} not yet implemented (T09).`);
  if (element.length) fail('NOT_IMPLEMENTED', `${element.join(', ')} ${element.length === 1 ? 'is' : 'are'} not yet implemented (T22).`);
  // All items are validated first, then written in one update ("atomically").
  for (const i of items) {
    // Every Xapp item type is in the registry; only a type Xapp itself rejects gets here. Xapp gives no code; MISSING_PARAM
    // is T03's placeholder for codeless refusals (wire shape → T18).
    if (!REGISTRY[i.type]) fail('MISSING_PARAM', `Unsupported item type: ${i.type}`);
    lockCheck(doc, i);
    for (const k of keys) checkProperty(i, k, props[k]);
  }
  const before = new Map(items.map(i => [i.id, structuredClone(i)])), notes: string[] = [];
  for (const i of items) for (const k of keys) {
    if (i.type === 'text' && isTextKey(k)) { if (k === keys.find(isTextKey)) writeTextProperties(i, props); }
    else if (k !== 'playbackRate') writeProperty(i, k, props[k]);
    else if (props[k] !== rateOf(i)) notes.push(speedNote(changeSpeed(doc, i.id, props[k], false)));
  }
  const n = items.length;
  return { success: true, message: `Updated ${n} item${n === 1 ? '' : 's'} atomically${notes.length ? `. ${notes.join(' ')}` : ''}`,
    data: { itemIds: ids, changedFields: Object.fromEntries(items.map(i => [i.id, changedFields(before.get(i.id)!, i)])) } };
}

// ---- T15 Use Proxy (findings §2): `details.useProxy` of a video item picks proxy or original for the preview (export always
// reads the original). The inspector switch and the setUseProxy tool both run this, so both store the same document under
// the same label. Xapp has no agent tool for it: the tool, its name and its messages are provisional.
export function setUseProxy(doc: ProjectDocument, args: RecordData): RecordData {
  const i = item(doc, args.itemId);
  if (!i) return refuse('ITEM_NOT_FOUND', 'Item not found', `Item '${args.itemId}' not found on timeline.`);
  if (i.type !== 'video') refuse('INVALID_ITEM_TYPE', 'Invalid item type', `Use Proxy only applies to video items, but '${i.id}' is type '${i.type}'.`);
  if (typeof args.useProxy !== 'boolean') fail('MISSING_PARAM', 'useProxy (true or false) is required');
  lockCheck(doc, i);
  if ((i.details?.useProxy !== false) !== args.useProxy) i.details = { ...i.details, useProxy: args.useProxy };
  return { success: true, message: `Use Proxy is ${args.useProxy ? 'on' : 'off'} for '${i.id}'.`, data: { itemId: i.id, useProxy: args.useProxy } };
}
