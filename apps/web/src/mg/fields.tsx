// SPDX-License-Identifier: AGPL-3.0-only
// The inspector's Fields section (agent tool results §8, G-06): a graphic whose code declares editable fields shows one
// control per field above Basic and Transform: text, number, colour, toggle, a list with an add button, a font select and a
// choice select. Each change writes details.fieldValues[name] through the command path, one "Edit items" step; the render
// reads fieldValues (render/model.ts). The list comes from the sandbox dry run (frames.ts graphicFields), the type by the
// runtime's rule (meta.type, else text[] for an array default, else typeof the default).
// Provisional, not Xapp parity: the label (meta.label, else the name), the choice list (meta.options: strings or
// {value, label?}), text and number committing on blur or Enter, the font list (the sandbox catalogue) and no list removal.
// Bounded (review m4; the caps are a provisional coordinator default, no spec): the list is the graphic's own output, so at
// most FIELD_CAPS.fields fields, options per choice and characters per label are kept, and one line counts the fields left out;
// a list shows at most FIELD_CAPS.entries inputs and counts the rest (review n1).
import { useEffect, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { dispatch } from '../editor/commands';
import { ColourPicker } from '../editor/controls';
import { projectStore } from '../store/database';
import type { RecordData } from '../store/model';
import { SANDBOX_FAMILY_NAMES } from './agent-checks';
import { graphicFields } from './frames';

export type FieldType = 'text' | 'string' | 'number' | 'color' | 'boolean' | 'text[]' | 'font' | 'select';
export type GraphicField = { name: string; type: FieldType; label: string; defaultValue: unknown; options: { value: string; label: string }[] };
type Value = string | number | boolean | string[];
const TYPES: readonly string[] = ['text', 'string', 'number', 'color', 'boolean', 'text[]', 'font', 'select'];
export const FIELD_CAPS = { fields: 100, options: 200, label: 200, entries: 200 } as const;

type Declared = { name: string; type: FieldType; defaultValue: unknown; meta?: Record<string, unknown> };
/** One declared entry ({name, defaultValue, meta}) if it is a control: a string name and a known type. */
function declared(f: unknown): Declared | null {
  const { name, defaultValue, meta } = (f ?? {}) as { name?: unknown; defaultValue?: unknown; meta?: Record<string, unknown> };
  const type = meta?.type ?? (Array.isArray(defaultValue) ? 'text[]' : typeof defaultValue);
  return typeof name === 'string' && typeof type === 'string' && TYPES.includes(type) ? { name, type: type as FieldType, defaultValue, meta } : null;
}
const clip = (text: string) => text.slice(0, FIELD_CAPS.label);
/** The sandbox's declared list as controls, the first FIELD_CAPS.fields of them; an entry without a name or a known type is left out. */
export function fieldList(raw: unknown[]): GraphicField[] {
  const out: GraphicField[] = [];
  for (const f of raw) {
    if (out.length === FIELD_CAPS.fields) break;
    const d = declared(f);
    if (!d) continue;
    const options: GraphicField['options'] = [];
    for (const o of Array.isArray(d.meta?.options) ? d.meta.options : []) {
      if (options.length === FIELD_CAPS.options) break;
      if (typeof o === 'string') options.push({ value: o, label: clip(o) });
      else if (o && typeof o === 'object' && typeof o.value === 'string') options.push({ value: o.value, label: clip(typeof o.label === 'string' ? o.label : o.value) });
    }
    out.push({ name: d.name, type: d.type, label: clip(typeof d.meta?.label === 'string' ? d.meta.label : d.name), defaultValue: d.defaultValue, options });
  }
  return out;
}
/** How many declared entries are controls (fieldList's entries before the cap). */
export const fieldCount = (raw: unknown[]) => raw.reduce<number>((n, f) => n + (declared(f) ? 1 : 0), 0);
/** A list field's entries as text (all of them: an edit keeps the ones not shown), the first FIELD_CAPS.entries to show, and the count past them. */
export function listEntries(value: unknown): { all: string[]; shown: string[]; more: number } {
  const all = Array.isArray(value) ? value.map(String) : [];
  return { all, shown: all.slice(0, FIELD_CAPS.entries), more: Math.max(0, all.length - FIELD_CAPS.entries) };
}
/** The item's value for the field: details.fieldValues[name] when set, else the declared default. */
export function fieldValue(item: RecordData, field: GraphicField): unknown {
  const values = item.details?.fieldValues;
  return values && typeof values === 'object' && !Array.isArray(values) && Object.hasOwn(values, field.name) ? (values as RecordData)[field.name] : field.defaultValue;
}

function Control({ item, field }: { item: RecordData; field: GraphicField }) {
  const value = fieldValue(item, field), label = field.label;
  const commit = (next: Value) => { if (JSON.stringify(next) !== JSON.stringify(value)) dispatch({ type: 'editGraphicField', itemId: item.id, name: field.name, value: next }); };
  const enter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); };
  const choices = (list: { value: string; label: string }[]) => {
    const all = list.some(o => o.value === value) || typeof value !== 'string' ? list : [...list, { value, label: value }];
    return <select aria-label={label} value={String(value)} onChange={e => commit(e.target.value)}>{all.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  };
  let control: ReactNode;
  switch (field.type) {
    case 'number': control = <input type="number" aria-label={label} key={String(value)} defaultValue={String(value)} onKeyDown={enter}
      onBlur={e => { const n = e.target.valueAsNumber; if (Number.isFinite(n)) commit(n); else e.target.value = String(value); }} />; break;
    case 'color': control = <ColourPicker key={item.id} label={label} value={String(value)} onChange={commit} />; break;
    case 'boolean': control = <button role="switch" className="switch" aria-label={label} aria-checked={value === true} onClick={() => commit(value !== true)}><span /></button>; break;
    case 'font': control = choices(SANDBOX_FAMILY_NAMES.map(f => ({ value: f, label: f }))); break;
    case 'select': control = choices(field.options); break;
    case 'text[]': {
      const { all: list, shown, more } = listEntries(value);
      return <div className="field-list" role="group" aria-label={label}><span>{label}</span>
        {shown.map((entry, i) => <input key={`${i}:${entry}`} aria-label={`${label} ${i + 1}`} defaultValue={entry} onKeyDown={enter} onBlur={e => commit(list.map((x, j) => j === i ? e.target.value : x))} />)}
        {more > 0 && <span className="field-more">{more} more {more === 1 ? 'entry' : 'entries'} not shown</span>}
        <button type="button" aria-label={`Add to ${label}`} onClick={() => commit([...list, ''])}>Add</button></div>;
    }
    default: control = <input type="text" aria-label={label} key={String(value)} defaultValue={String(value)} onKeyDown={enter} onBlur={e => commit(e.target.value)} />;
  }
  return <label className="row">{label}{control}</label>;
}

/** Nothing until the code's fields are known, and nothing for a graphic that declares none (or does not compile). */
export function GraphicFields({ item, open }: { item: RecordData; open?: boolean }) {
  const code = String(item.details?.code ?? ''), [known, setKnown] = useState<{ code: string; fields: GraphicField[]; more: number }>();
  useEffect(() => {
    let live = true;
    graphicFields(projectStore, code).then(raw => { if (!live) return; const fields = fieldList(raw); setKnown({ code, fields, more: fieldCount(raw) - fields.length }); },
      () => { if (live) setKnown({ code, fields: [], more: 0 }); });
    return () => { live = false; };
  }, [code]);
  const fields = known?.code === code ? known.fields : [], more = known?.code === code ? known.more : 0;
  if (!fields.length) return null;
  return <details className="inspector-section" open={open}><summary>Fields</summary>{fields.map(f => <Control key={f.name} item={item} field={f} />)}
    {more > 0 && <p className="field-more">{more} more {more === 1 ? 'field' : 'fields'} not shown</p>}</details>;
}
