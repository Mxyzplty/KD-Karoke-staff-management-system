// SPDX-License-Identifier: AGPL-3.0-only
import schema from './normalise.v1.json';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type MapSet = Map<string, Map<string, string>>;
const match = (pattern: string, at: string[]) => pattern.split('.').length === at.length && pattern.split('.').every((s, i) => s === '*' || s === at[i]);
const typeAt = (at: string[], rules: Record<string, string[]>) => Object.entries(rules).find(([, paths]) => paths.some(p => match(p, at)))?.[0];
// Canonical traversal: object keys sorted, array order kept, so ID numbering never depends on JSON key order.
const entries = (value: object) => Array.isArray(value) ? Object.entries(value) : Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
function walk(value: Json, visit: (value: Json, at: string[]) => void, at: string[] = []): void {
  visit(value, at);
  if (value && typeof value === 'object') for (const [key, child] of entries(value)) walk(child, visit, [...at, key]);
}
export function normalise(project: Json): { normalisationVersion: number; project: Json } {
  const maps: MapSet = new Map();
  const declare = (type: string, id: Json) => {
    if (typeof id !== 'string' || !id) throw Error(`Invalid ${type} id`);
    const map = maps.get(type) ?? new Map();
    if (map.has(id)) throw Error(`Duplicate ${type} id: ${id}`);
    map.set(id, `${type}:${map.size + 1}`); maps.set(type, map);
  };
  walk(project, (value, at) => {
    const type = typeAt(at, schema.entities);
    if (type) declare(type, value);
    if (at.length === 1 && at[0] === 'groups' && value && !Array.isArray(value) && typeof value === 'object') {
      for (const [id, group] of entries(value)) {
        if (!(group && typeof group === 'object' && !Array.isArray(group) && 'id' in group)) declare('group', id);
      }
    }
  });
  const ref = (type: string, id: Json): Json => {
    if (id === null) return id;
    if (typeof id !== 'string' || !maps.get(type)?.has(id)) throw Error(`Dangling ${type} reference: ${String(id)}`);
    return maps.get(type)!.get(id)!;
  };
  function convert(value: Json, at: string[] = []): Json {
    if (schema.auditFields.some(p => match(p, at))) return '<audit>';
    const type = typeAt(at, schema.entities) ?? typeAt(at, schema.references);
    if (type) return ref(type, value);
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw Error(`Non-finite number at ${at}`);
      return value;
    }
    if (Array.isArray(value)) return value.map((v, i) => convert(v, [...at, String(i)]));
    if (schema.dynamicLayerReferences.some(p => match(p, at))) {
      const kind = value.type;
      if (kind !== 'track' && kind !== 'group') throw Error(`Unknown layer type at ${at}`);
      return { ...value, id: ref(kind, value.id) };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [at.length === 1 && at[0] === 'groups' ? ref('group', k) as string : k, convert(v, [...at, k])]));
  }
  return { normalisationVersion: schema.version, project: convert(project) };
}
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
