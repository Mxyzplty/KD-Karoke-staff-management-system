// SPDX-License-Identifier: AGPL-3.0-only
// Parameter validation (writes) and resolution (renders).
// Writes refuse: out-of-range numbers are refused, not clamped; colours must be hex; selects must name an option.
// Renders never refuse: a missing, non-finite or mistyped value falls back to the definition default.
import type { EffectDefinition, ParamDef, ParamValue, ParamValues, Wheel } from './schema';
import { effectById } from './registry';
import { refuse, type Refusal, type Result } from './queries';
import { cubeTitle, decodeLut, encodeLut, importCube, looksLikeCube } from './lut';

export const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const invalid = (effectId: string, message: string): Refusal => refuse('INVALID_PARAM_VALUE', 'Invalid parameter value', `On '${effectId}': ${message}`);
const show = (v: unknown) => typeof v === 'string' ? `'${v}'` : JSON.stringify(v) ?? String(v);
const isWheel = (v: unknown): v is Wheel => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkValue(e: EffectDefinition, p: ParamDef, v: unknown): Refusal | ParamValue {
  const where = `'${p.key}'`;
  switch (p.type) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return invalid(e.id, `${where} expects a finite number, got ${show(v)}`);
      if (v < p.min || v > p.max) return invalid(e.id, `${where} must be between ${p.min} and ${p.max}, got ${v}`);
      return v;
    case 'boolean':
      return typeof v === 'boolean' ? v : invalid(e.id, `${where} expects true or false, got ${show(v)}`);
    case 'select':
      return typeof v === 'string' && p.options.some(o => o.value === v) ? v
        : invalid(e.id, `${where} must be one of ${p.options.map(o => o.value).join(', ')}, got ${show(v)}`);
    case 'color':
      return typeof v === 'string' && HEX_COLOR.test(v) ? v : invalid(e.id, `${where} expects a hex color (#rgb, #rrggbb or #rrggbbaa), got ${show(v)}`);
    case 'colorWheel': {
      const keys = isWheel(v) ? Object.keys(v) : [];
      if (!isWheel(v) || keys.some(k => k !== 'angle' && k !== 'distance') || typeof v.angle !== 'number' || !Number.isFinite(v.angle)
        || typeof v.distance !== 'number' || !(v.distance >= 0 && v.distance <= 1))
        return invalid(e.id, `${where} expects {angle: degrees, distance: 0-1}, got ${show(v)}`);
      return { angle: v.angle, distance: v.distance };
    }
    case 'data':
      if (typeof v !== 'string') return invalid(e.id, `${where} expects a string, got ${show(v)}`);
      if (p.key !== 'lutData' || v === '') return v;
      if (looksLikeCube(v)) {
        try { return encodeLut(importCube(v)); } catch (err) { return invalid(e.id, `${where} .cube import failed: ${(err as Error).message}`); }
      }
      return decodeLut(v) ? v : invalid(e.id, `${where} must be .cube text or base64 of the 33³ RGBA8 table (143,748 bytes)`);
  }
}

/**
 * Validate an edit or add payload for one effect. Returns the normalised values (only the given keys):
 * `.cube` text in `lutData` is baked to the stored base64 table, and `lutName` defaults to the cube TITLE when not given.
 */
export function validateParams(effectId: string, values: Record<string, unknown>): Result<ParamValues> {
  const e = effectById(effectId);
  if (!e) return refuse('UNKNOWN_EFFECT', 'Unknown effect', `Effect '${effectId}' not found.`);
  const known = new Map(e.params.map(p => [p.key, p]));
  const unknown = Object.keys(values).filter(k => !known.has(k));
  if (unknown.length) {
    const valid = e.params.filter(p => !p.hidden).map(p => p.key);
    return refuse('UNKNOWN_PARAMETERS', 'Unknown parameters', `On '${effectId}': unknown parameter(s) ${unknown.join(', ')}. Valid: ${valid.join(', ')}`);
  }
  const out: ParamValues = {};
  for (const [key, v] of Object.entries(values)) {
    const p = known.get(key)!;
    if (p.type === 'number' && p.hidden && !(v === 1 || v === 2)) return invalid(e.id, `'${key}' must be 1 or 2, got ${show(v)}`);
    const r = checkValue(e, p, v);
    if (typeof r === 'object' && 'success' in r) return r;
    out[key] = r;
  }
  const lut = values.lutData;
  if (typeof lut === 'string' && looksLikeCube(lut) && !('lutName' in values)) {
    const title = cubeTitle(lut);
    if (title !== undefined) out.lutName = title;
  }
  return { success: true, data: out };
}

/** Full render-time values: every parameter present, invalid or missing ones replaced by the definition default. */
export function resolveParams(effectId: string, values: Record<string, unknown> = {}): ParamValues {
  const e = effectById(effectId);
  if (!e) throw new Error(`Unknown effect '${effectId}'`);
  const out: ParamValues = {};
  for (const p of e.params) {
    const v = values[p.key];
    switch (p.type) {
      case 'number': out[p.key] = typeof v === 'number' && Number.isFinite(v) ? v : p.default; break;
      case 'boolean': out[p.key] = typeof v === 'boolean' ? v : p.default; break;
      case 'select': out[p.key] = typeof v === 'string' && p.options.some(o => o.value === v) ? v : p.default; break;
      case 'color': case 'data': out[p.key] = typeof v === 'string' ? v : p.default; break;
      case 'colorWheel': {
        const w: Partial<Wheel> = isWheel(v) ? v : {};
        const angle = typeof w.angle === 'number' && Number.isFinite(w.angle) ? w.angle : p.default.angle;
        const distance = typeof w.distance === 'number' && Number.isFinite(w.distance) ? w.distance : p.default.distance;
        out[p.key] = { angle, distance };
      }
    }
  }
  return out;
}

/** Parameters written into a newly added instance (defaults, plus `newInstance` overrides such as toneCurve 2). */
export function newInstanceParams(effectId: string): ParamValues {
  const e = effectById(effectId);
  if (!e) throw new Error(`Unknown effect '${effectId}'`);
  const out: ParamValues = {};
  for (const p of e.params) out[p.key] = p.type === 'number' && p.newInstance !== undefined ? p.newInstance
    : p.type === 'colorWheel' ? { ...p.default } : p.default;
  return out;
}
