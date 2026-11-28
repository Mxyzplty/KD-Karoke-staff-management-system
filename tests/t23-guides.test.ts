// SPDX-License-Identifier: AGPL-3.0-only
// T23 the CI unit/limit check of our guides (ticket T23 acceptance: "the CI unit/limit check passes, and a deliberately wrong
// number in a guide fails it"; T23 notes "Guide files"; lane F's prose ruling of 15 Nov). checkGuide is a pure function of a
// guide's path and text: the real guides and the mutated copies run the same code. Oracles are the tool JSON Schemas
// (schemaValue), the facts registry (FACTS, unitOf) and the written format rules; the guide files are read from disk.
//
// The marks check (lane F's ruling of 15 Nov, lane A's order): `unserved` / `unimplemented` front-matter keys must agree with
// the served tool list (helper TOOLS), with the guide's "not served" prose, and with a probe through the real executor.
import 'fake-indexeddb/auto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLS, validate } from '../apps/helper/src/schemas';
import { Executor } from '../apps/web/src/agent/executor';
import { CODE_VALUES, FACTS, UNIT_NAMES, schemaValue, unitOf } from '../apps/web/src/agent/guides/facts';
import type { Fact } from '../apps/web/src/agent/guides/facts';
import { createEditor } from '../apps/web/src/timeline/harness';
import { assets, fixture, links } from './t03-fixtures';

const LIBRARY = fileURLToPath(new URL('../apps/web/src/agent/guides/library/', import.meta.url));
const FILES = readdirSync(LIBRARY).filter(f => f.endsWith('.markdown')).sort();
const read = (file: string) => readFileSync(LIBRARY + file, 'utf8').replace(/\r\n/g, '\n');

/** The Unit set (lane F's list); I1 exports it as UNIT_NAMES, which must agree. */
const UNITS = ['s', 'ms', 'frames', 'px', 'deg', 'fraction', 'percent', 'count', 'chars', 'factor', 'none', 'dB', 'Hz', 'kbps', 'Mbps'];
const TECHNICAL_SECTIONS = ['Purpose', 'When to load', 'Workflow', 'Tools and parameters', 'Units and limits', 'Verification', 'Pitfalls'];
const CREATIVE_SECTIONS = ['Purpose', 'When to use', 'Structure', 'Pacing', 'Text and captions', 'Audio and music', 'Checklist before handing back'];
const TABLE_HEAD = '| Check | Value | Unit | Meaning |';
/** A unit word right after a prose number, and the table Unit it means (lane F's ruling). `×` before another number is a size. */
const UNIT_WORD = /^\s?(ms|s|frames?|px|deg|°|%|percent|chars?|dB|Hz|kbps|Mbps|×(?!\s*\d))(?![A-Za-z])/;
const UNIT_OF_WORD: Record<string, string> = { ms: 'ms', s: 's', frame: 'frames', frames: 'frames', px: 'px', deg: 'deg', '°': 'deg', '%': 'percent', percent: 'percent',
  char: 'chars', chars: 'chars', dB: 'dB', Hz: 'Hz', kbps: 'kbps', Mbps: 'Mbps', '×': 'factor' };

export type Row = { check: string; value: unknown; unit: string; line: number };
type Registry = { facts: Record<string, Fact>; schemaValue: (key: string) => unknown; unitOf: (key: string) => string | undefined };
const REAL: Registry = { facts: FACTS, schemaValue, unitOf };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function splitHead(text: string): { fields: Record<string, string> | null; body: string; offset: number } {
  const head = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!head) return { fields: null, body: text, offset: 0 };
  const fields: Record<string, string> = {};
  for (const line of head[1].split('\n')) { const at = line.indexOf(':'); if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim(); }
  return { fields, body: text.slice(head[0].length), offset: head[0].split('\n').length - 1 };
}
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/** The line indexes of the checked-table headers (lane F's ruling: exactly one, anywhere in the file). */
const tableHeads = (lines: string[]) => lines.flatMap((l, n) => l.trim() === TABLE_HEAD ? [n] : []);
/** The checked table's rows of a technical guide (the first `| Check | Value | Unit | Meaning |` table). */
export function tableRows(text: string): Row[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), start = tableHeads(lines)[0];
  if (start === undefined) return [];
  const rows: Row[] = [];
  for (let n = start + 2; n < lines.length && lines[n].trim().startsWith('|'); n++) {
    const [check, value, unit] = cells(lines[n]);
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { parsed = { unparsable: value }; }
    rows.push({ check, value: parsed, unit, line: n + 1 });
  }
  return rows;
}

/** Prose numbers of a technical guide, with the unit word after each (lane F's ruling). */
export function proseNumbers(text: string): { value: number; unit?: string; line: number; raw: string }[] {
  const { body, offset } = splitHead(text.replace(/\r\n/g, '\n')), out: { value: number; unit?: string; line: number; raw: string }[] = [];
  let fenced = false;
  for (const [n, original] of body.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(original)) { fenced = !fenced; continue; }
    if (fenced || original.trim().startsWith('|')) continue;
    // Step references ("step 2", "steps 3–5") are exempt (lane F's ruling).
    const line = original.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, '] ').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ' ')
      .replace(/\bsteps?\s+\d+(?:\s*(?:[–-]|to|and|,)\s*\d+)*/gi, ' ');
    for (const m of line.matchAll(/-?\d(?:\d|,(?=\d))*(?:\.\d+)?/g)) {
      let raw = m[0], at = m.index!;
      const before = line[at - 1] ?? '', after = line[at + raw.length] ?? '';
      if (raw.startsWith('-') && /[A-Za-z0-9_]/.test(before)) { if (/[A-Za-z_]/.test(before)) continue; raw = raw.slice(1); at++; }
      const prev = line[at - 1] ?? '';
      if (/[A-Za-z_]/.test(prev) || /[A-Za-z_]/.test(after) || prev === '.' && /[A-Za-z_]/.test(line[at - 2] ?? '')) continue; // part of a word
      const word = UNIT_WORD.exec(line.slice(at + raw.length))?.[1];
      out.push({ value: Number(raw.replace(/,/g, '')), unit: word ? UNIT_OF_WORD[word.startsWith('×') ? '×' : word] : undefined, line: n + 1 + offset, raw });
    }
  }
  return out;
}

const headings = (body: string) => { let fenced = false; return body.split('\n').filter(l => (/^\s*```/.test(l) ? (fenced = !fenced, false) : !fenced) && /^## /.test(l)).map(l => l.slice(3).trim()); };
const inOrder = (found: string[], wanted: string[]) => { let at = 0; for (const h of found) if (h === wanted[at]) at++; return at === wanted.length; };

/** Every problem of one guide; [] when it passes. `path` is the library file name. */
export function checkGuide(path: string, text: string, registry: Registry = REAL): string[] {
  const problems: string[] = [], t = text.replace(/\r\n/g, '\n'), { fields, body } = splitHead(t);
  const creative = path.endsWith('.creative.markdown');
  const topic = path === 'orientation.markdown' ? 'orientation' : /^([a-z0-9-]+)\.(editor|creative)\.markdown$/.exec(path)?.[1];
  if (!topic) problems.push(`${path}: name is not <topic>.editor|creative.markdown or orientation.markdown`);
  if (!fields) return [...problems, `${path}: no front-matter block`];
  for (const k of ['topic', 'kind', 'summary', 'related']) if (!(k in fields)) problems.push(`${path}: front matter has no ${k}`);
  if (topic && fields.topic !== topic) problems.push(`${path}: topic is ${fields.topic}, expected ${topic}`);
  if (fields.kind !== (creative ? 'creative' : 'technical')) problems.push(`${path}: kind is ${fields.kind}, expected ${creative ? 'creative' : 'technical'}`);
  if ('summary' in fields && !fields.summary) problems.push(`${path}: summary is empty`);
  const sections = creative ? CREATIVE_SECTIONS : TECHNICAL_SECTIONS;
  if (!inOrder(headings(body), sections)) problems.push(`${path}: sections are not ${sections.join(' · ')} in order (found ${headings(body).join(' · ')})`);
  if (creative) return problems;

  const heads = tableHeads(t.split('\n')).length;
  if (heads !== 1) problems.push(`${path}: has ${heads} tables with the header ${TABLE_HEAD}, expected exactly 1`);
  const rows = tableRows(t);
  for (const r of rows) {
    const at = `${path}:${r.line} ${r.check}`;
    if (r.value && typeof r.value === 'object' && 'unparsable' in (r.value as object)) problems.push(`${at}: Value is not a JSON literal`);
    if (r.check.startsWith('schema:')) {
      const v = registry.schemaValue(r.check);
      if (v === undefined) problems.push(`${at}: the schema has no such path or keyword`);
      else if (!same(v, r.value)) problems.push(`${at}: Value ${JSON.stringify(r.value)}, schema says ${JSON.stringify(v)}`);
    } else if (r.check.startsWith('fact:')) {
      const f = registry.facts[r.check.slice(5)];
      if (!f) problems.push(`${at}: unknown fact key`);
      else if (!same(f.value, r.value)) problems.push(`${at}: Value ${JSON.stringify(r.value)}, FACTS says ${JSON.stringify(f.value)}`);
    } else problems.push(`${at}: Check is neither schema:<tool>.<path>.<keyword> nor fact:<key>`);
    if (!UNITS.includes(r.unit)) problems.push(`${at}: Unit ${r.unit} is not one of ${UNITS.join(', ')}`);
    const expected = registry.unitOf(r.check);
    if (expected !== undefined && expected !== r.unit) problems.push(`${at}: Unit ${r.unit}, the registry says ${expected}`);
  }
  // Prose: each number is a table Value (or an element of an array Value), with the same unit when a unit word follows it.
  const values = new Map<number, Set<string>>();
  for (const r of rows) for (const v of Array.isArray(r.value) ? r.value : [r.value]) if (typeof v === 'number') (values.get(v) ?? values.set(v, new Set()).get(v)!).add(r.unit);
  for (const p of proseNumbers(t)) {
    const units = values.get(p.value);
    if (!units) problems.push(`${path}:${p.line} prose number ${p.raw}${p.unit ? ` ${p.unit}` : ''} is not a Value of the table`);
    else if (p.unit && !units.has(p.unit)) problems.push(`${path}:${p.line} prose number ${p.raw} ${p.unit}: the table has it only as ${[...units].join(', ')}`);
  }
  return problems;
}
const relatedOf = (text: string) => (splitHead(text.replace(/\r\n/g, '\n')).fields?.related ?? '').split(',').map(s => s.trim()).filter(Boolean);

// ---- The marks check ----
/** Tool names of the contracts that this branch does not serve; an `unserved` name outside this list and TOOLS is a typo (rule 4). */
const KNOWN_UNSERVED = ['captureFrame', 'exportProject', 'getExportStatus', 'viewProjectAssets', 'searchProjectAssets', 'searchUserLibrary', 'addAssetToProject', 'viewReferenceVideo', 'viewReferenceFrame', 'listEffects', 'getEffectDetails'];
const NOT_SERVED_LINE = /not served|missing from this build's tool list/i;
/** Probe input per tool: the T03 fixture's item v1, asset asset-vid1 and track V1. */
const PROBE_BASE: Record<string, Record<string, unknown>> = { viewItemDetails: { itemId: 'v1' }, context: {}, addMedia: { assetId: 'asset-vid1', trackId: 'V1' } };
/** The value of a `tool.param` entry that names no value. */
const PROBE_VALUE: Record<string, unknown> = { 'addMedia.transcriptRange': { text: 'hello' } };
/** Extra input an entry needs to reach its refusal (context.ts: transcript_words without a window is INVALID_TOOL_INPUT). */
const PROBE_EXTRA: Record<string, Record<string, unknown>> = { 'context.include=transcript_words': { startSeconds: 0, endSeconds: 5 } };
export type Probe = (tool: string, input: Record<string, unknown>) => Promise<string | undefined>;
export type MarkDeps = { served: readonly { name: string; inputSchema: { properties?: Record<string, unknown> } }[]; known: readonly string[]; probe: Probe };

const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
const spanWords = (line: string) => [...line.matchAll(/`([^`]*)`/g)].flatMap(m => m[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

/** Rules 1, 2 and 4 for `unserved`, rules 3 and 4 for `unimplemented`, rule 5 for every backticked unserved name; [] when the guide's marks agree. */
export async function checkMarks(path: string, text: string, deps: MarkDeps): Promise<string[]> {
  const problems: string[] = [], { fields, body, offset } = splitHead(text.replace(/\r\n/g, '\n'));
  const unserved = list(fields?.unserved), served = new Map(deps.served.map(t => [t.name, t]));
  for (const n of unserved) {
    if (served.has(n)) problems.push(`${path} marks ${n} unserved, but it is served: apply the T18 sweep`);
    else if (!deps.known.includes(n)) problems.push(`${path} marks ${n} unserved, but no tool has that name`);
  }
  // Rule 2: every "not served" line names an unserved tool in a backtick span; every unserved name has such a line.
  const named = new Set<string>();
  let fenced = false;
  for (const [n, line] of body.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    // Rule 5 (lane F's ruling, round 1 R3): any backticked known-unserved name must be in this guide's unserved list.
    for (const w of new Set(spanWords(line))) if (deps.known.includes(w) && !served.has(w) && !unserved.includes(w))
      problems.push(`${path}:${n + 1 + offset} names \`${w}\`, which is not served, but ${w} is not in unserved`);
    if (!NOT_SERVED_LINE.test(line)) continue;
    const hits = spanWords(line).filter(w => unserved.includes(w));
    if (!hits.length) problems.push(`${path}:${n + 1 + offset} says a tool is not served but names none of its unserved tools (${unserved.join(', ') || 'none'}) in backticks`);
    hits.forEach(w => named.add(w));
  }
  for (const n of unserved) if (!named.has(n)) problems.push(`${path} marks ${n} unserved, but no "not served" line names it`);
  // Rules 3 and 4: each entry resolves to a served tool and one of its parameters, and the probe is refused with NOT_IMPLEMENTED.
  for (const entry of list(fields?.unimplemented)) {
    const m = /^([A-Za-z]\w*)\.([A-Za-z]\w*)(?:=(.+))?$/.exec(entry);
    if (!m) { problems.push(`${path}: unimplemented entry "${entry}" is not tool.param or tool.param=value`); continue; }
    const [, tool, param, value] = m, schema = served.get(tool);
    if (!schema) { problems.push(`${path}: unimplemented entry ${entry} names ${tool}, which is not a served tool`); continue; }
    if (!(param in (schema.inputSchema.properties ?? {}))) { problems.push(`${path}: unimplemented entry ${entry}: ${tool} has no parameter ${param}`); continue; }
    const base = PROBE_BASE[tool], v = value ?? PROBE_VALUE[`${tool}.${param}`];
    if (!base || v === undefined) { problems.push(`${path}: unimplemented entry ${entry} has no probe: add one to PROBE_BASE / PROBE_VALUE`); continue; }
    const code = await deps.probe(tool, { ...base, ...PROBE_EXTRA[entry], [param]: v });
    if (code !== 'NOT_IMPLEMENTED') problems.push(`${path} marks ${entry} unimplemented, but ${tool} answers ${code ?? 'success'}: it is implemented now, apply the T18 sweep`);
  }
  return problems;
}

/** The real probe: the helper's validate(), then the native executor over the T03 fixture, after a context read in the same session. */
const deps = { store: { row: async () => undefined, putRow: async () => {}, media: {} }, service: { rhythm: async () => { throw new Error('unused'); } } } as never;
const fakeStorage = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
let seq = 0;
export const realProbe: Probe = async (tool, input) => {
  const invalid = validate(tool, input) as { code?: string } | null;
  if (invalid) return invalid.code;
  const editor = createEditor(fixture(), { assets: assets(), links: links() });
  const ex = new Executor({ storage: fakeStorage(), current: () => editor.runtime, ui: () => ({ selection: [], playheadMs: 0 }), analysis: async () => deps });
  const run = (toolName: string, i: Record<string, unknown>) => ex.execute({ type: 'call', callId: `p${++seq}`, executionKey: `mcp:conn:p${seq}`, toolName, input: i, session: 'probe' });
  await run('context', {});
  const r = await run(tool, input) as { success?: boolean; code?: string };
  return r.success ? undefined : r.code;
};
const REAL_MARKS: MarkDeps = { served: TOOLS, known: KNOWN_UNSERVED, probe: realProbe };

// ---- A synthetic guide that passes, for the mutation cases (real schema rows, an injected fact) ----
const SYNTHETIC_FACTS: Record<string, Fact> = { 'test.capMs': { value: 3000, unit: 'ms', source: 'test' }, 'test.kinds': { value: [2, 4], unit: 'count', source: 'test' } };
const SYNTHETIC: Registry = { facts: SYNTHETIC_FACTS, schemaValue, unitOf: key => key.startsWith('fact:') ? SYNTHETIC_FACTS[key.slice(5)]?.unit : unitOf(key) };
const SYNTHETIC_GUIDE = `---
topic: synthetic
kind: technical
summary: A guide for the check's own tests.
related:
---

## Purpose

Transitions last at most 3000 ms. Versions like H.264, 720p, 4k, base64 and vignette_1 are words.

## When to load

- Pick 2 or 4 of them.

## Workflow

1. Call \`applyTransition\` with \`durationSeconds: 99\` in code.
2. Another step.

## Tools and parameters

\`\`\`
durationSeconds 12345
\`\`\`

## Units and limits

| Check | Value | Unit | Meaning |
|---|---|---|---|
| schema:applyTransition.durationSeconds.exclusiveMinimum | 0 | s | Above this |
| schema:applyTransition.alignment.enum | ["start","center","end"] | none | Where |
| fact:test.capMs | 3000 | ms | Cap |
| fact:test.kinds | [2,4] | count | Kinds |

## Verification

Nothing below 0 s.

## Pitfalls

None.
`;

describe('T23 guide check: the function itself', () => {
  it('the synthetic guide passes, skipping code spans, fences, list markers, table rows and word-joined numbers', () => {
    expect(checkGuide('synthetic.editor.markdown', SYNTHETIC_GUIDE, SYNTHETIC)).toEqual([]);
    expect(proseNumbers(SYNTHETIC_GUIDE).map(p => [p.raw, p.unit])).toEqual([['3000', 'ms'], ['2', undefined], ['4', undefined], ['0', 's']]);
  });
  it('reads commas, decimals, negatives, ranges and unit words', () => {
    const t = '---\ntopic: x\n---\nA 1,800 frames, 0.25 fraction, -1 dB, 1–3 s, 90°, 30 %, 2× zoom, 1080 × 1920 px, 128 kbps.\n';
    expect(proseNumbers(t).map(p => [p.value, p.unit])).toEqual([[1800, 'frames'], [0.25, undefined], [-1, 'dB'], [1, undefined], [3, 's'], [90, 'deg'], [30, 'percent'], [2, 'factor'],
      [1080, undefined], [1920, 'px'], [128, 'kbps']]);
  });
  const mutations: [string, (t: string) => string, RegExp][] = [
    ['a wrong table Value', t => t.replace('| fact:test.capMs | 3000 |', '| fact:test.capMs | 3500 |'), /test\.capMs: Value 3500, FACTS says 3000/],
    ['a wrong schema Value', t => t.replace('exclusiveMinimum | 0 |', 'exclusiveMinimum | 0.1 |'), /schema says 0/],
    ['a wrong Unit', t => t.replace('| 3000 | ms |', '| 3000 | s |'), /Unit s, the registry says ms/],
    ['a Unit outside the set', t => t.replace('| 3000 | ms |', '| 3000 | seconds |'), /Unit seconds is not one of/],
    ['a prose number missing from the table', t => t.replace('at most 3000 ms', 'at most 2500 ms'), /prose number 2500 ms is not a Value/],
    ['a prose unit that disagrees', t => t.replace('at most 3000 ms', 'at most 3000 px'), /prose number 3000 px: the table has it only as ms/],
    ['an unknown fact: key', t => t.replace('| fact:test.capMs |', '| fact:test.capMx |'), /unknown fact key/],
    ['a bad schema: path', t => t.replace('applyTransition.alignment.enum', 'applyTransition.alignmnt.enum'), /the schema has no such path/],
    ['a bad schema: keyword', t => t.replace('alignment.enum', 'alignment.pattern'), /the schema has no such path or keyword/],
    ['a wrong table header (no table)', t => t.replace(TABLE_HEAD, '| Check | Value | Units | Meaning |'), /has 0 tables with the header/],
    ['a second checked table', t => `${t}\n${TABLE_HEAD}\n|---|---|---|---|\n| fact:test.capMs | 3000 | ms | Again |\n`, /has 2 tables with the header/],
    ['sections out of order', t => t.replace('## Verification', '## Verify'), /sections are not/],
    ['a front-matter field missing', t => t.replace('summary: A guide for the check\'s own tests.\n', ''), /front matter has no summary/],
  ];
  for (const [name, mutate, problem] of mutations) it(`fails on ${name}`, () => {
    const mutated = mutate(SYNTHETIC_GUIDE);
    expect(mutated).not.toBe(SYNTHETIC_GUIDE);
    expect(checkGuide('synthetic.editor.markdown', mutated, SYNTHETIC).join('\n')).toMatch(problem);
  });
  it('the table may sit anywhere; "Units and limits" bullets are then prose and still checked', () => {
    const lines = SYNTHETIC_GUIDE.split('\n'), at = lines.indexOf(TABLE_HEAD), table = lines.splice(at, 6);
    const moved = `${lines.join('\n').replace('## Units and limits\n', '## Units and limits\n\n- Transitions stop at 3000 ms.\n')}\n${table.join('\n')}\n`;
    expect(checkGuide('synthetic.editor.markdown', moved, SYNTHETIC)).toEqual([]);
    expect(checkGuide('synthetic.editor.markdown', moved.replace('stop at 3000 ms', 'stop at 3100 ms'), SYNTHETIC).join()).toMatch(/prose number 3100 ms is not a Value/);
  });
  it('step references are exempt; other numbers on the line are not', () => {
    expect(proseNumbers('---\n---\nRepeat from step 2, see steps 3–5 and Steps 6 to 7, then wait 9 s.\n').map(p => p.raw)).toEqual(['9']);
  });
  it('creative guides: front matter and their own sections; advice tables and ranges are not checked', () => {
    const creative = `---\ntopic: c\nkind: creative\nsummary: s\nrelated:\n---\n\n${CREATIVE_SECTIONS.map(s => `## ${s}\n\nKeep 1–3 s, 42 frames.\n\n| Guidance | Value | Unit | Why |\n|---|---|---|---|\n| x | 1–3 | s | y |\n`).join('\n')}`;
    expect(checkGuide('c.creative.markdown', creative)).toEqual([]);
    expect(checkGuide('c.creative.markdown', creative.replace('## Pacing', '## Rhythm')).join()).toMatch(/sections are not/);
  });
});

describe('T23 guide check: the real guides', () => {
  it('the library holds the orientation, the mechanics guides and the 4 creative defaults', () => {
    for (const t of ['timeline', 'finding-media', 'layouts', 'multi-cam', 'audio', 'music-sync', 'transcript-cleanup', 'keyframing', 'masks', 'smart-masking', 'motion-graphics',
      'captions', 'text-placement', 'time-remapping', 'transitions', 'effects', 'export', 'voice-over']) expect(FILES).toContain(`${t}.editor.markdown`);
    for (const t of ['short-form', 'long-form', 'vlog', 'multi-cam']) expect(FILES).toContain(`${t}.creative.markdown`);
    expect(FILES).toContain('orientation.markdown');
  });
  for (const file of FILES) it(`${file} passes`, () => { expect(checkGuide(file, read(file))).toEqual([]); });
  it('every related topic is a mechanics guide', () => {
    for (const file of FILES) for (const topic of relatedOf(read(file))) expect(FILES, `${file} related ${topic}`).toContain(`${topic}.editor.markdown`);
  });
  it('every fact: key a guide uses exists, and no FACTS key is unused', () => {
    const used = new Set(FILES.filter(f => !f.endsWith('.creative.markdown')).flatMap(f => tableRows(read(f)).filter(r => r.check.startsWith('fact:')).map(r => r.check.slice(5))));
    expect([...used].filter(k => !(k in FACTS)).sort()).toEqual([]);
    expect(Object.keys(FACTS).filter(k => !used.has(k)).sort()).toEqual([]);
  });
  it('facts.ts exports the same Unit set as UNIT_NAMES', () => {
    expect([...UNIT_NAMES]).toEqual(UNITS);
  });
  it('every fact has a unit from the set and a source', () => {
    for (const [k, f] of Object.entries(FACTS)) { expect(UNITS, k).toContain(f.unit); expect(f.source, k).toBeTruthy(); }
  });
  it('every FACTS entry with a code import equals that constant', () => {
    // I1's interface: CODE_VALUES holds, per code-backed fact key, the imported (or derived) value in the fact's unit.
    expect(Object.keys(CODE_VALUES).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(CODE_VALUES)) { expect(k in FACTS, `${k} is not a fact`).toBe(true); expect(FACTS[k]?.value, k).toEqual(v); }
  });
  it('a deliberately wrong number in a real guide fails the check', () => {
    const file = 'transitions.editor.markdown', text = read(file), row = tableRows(text).find(r => typeof r.value === 'number')!;
    const lines = text.split('\n'), c = cells(lines[row.line - 1]);
    lines[row.line - 1] = `| ${c[0]} | ${(row.value as number) + 7} | ${c.slice(2).join(' | ')} |`;
    expect(checkGuide(file, lines.join('\n')).length).toBeGreaterThan(0);
    expect(checkGuide(file, text.replace('## Verification', 'A stray 987654 s here.\n\n## Verification')).join()).toMatch(/prose number 987654 s is not a Value/);
  });
});

describe('T23 marks check: the function itself', () => {
  const fakeServed = [{ name: 'context', inputSchema: { properties: { include: {} } } }, { name: 'exportProject', inputSchema: { properties: {} } }];
  const refuse: Probe = async () => 'NOT_IMPLEMENTED';
  const fake = (over: Partial<MarkDeps> = {}): MarkDeps => ({ served: fakeServed.filter(t => t.name === 'context'), known: ['captureFrame', 'exportProject'], probe: refuse, ...over });
  const guide = (head: string, body: string) => `---\ntopic: x\n${head}\n---\n\n## Purpose\n\n${body}\n`;
  const GOOD = guide('unserved: captureFrame\nunimplemented: context.include=transcript', '- `captureFrame {timestamps}` is not served in this build.');
  it('a guide whose marks agree passes; no marks and no "not served" line passes', async () => {
    expect(await checkMarks('x.editor.markdown', GOOD, fake())).toEqual([]);
    expect(await checkMarks('x.editor.markdown', guide('', 'Plain text.'), fake())).toEqual([]);
  });
  it('rule 1: a served list holding a marked tool gives red', async () => {
    const g = guide('unserved: exportProject', '`exportProject` is not served to outside agents.');
    expect((await checkMarks('export.editor.markdown', g, fake({ served: fakeServed }))).join()).toMatch(/export\.editor\.markdown marks exportProject unserved, but it is served: apply the T18 sweep/);
  });
  it('rule 2: a "not served" line naming a tool missing from unserved gives red', async () => {
    const g = guide('unserved: captureFrame', '`captureFrame` is not served.\n`exportProject` may be missing from this build\'s tool list.');
    expect((await checkMarks('x.editor.markdown', g, fake())).join()).toMatch(/x\.editor\.markdown:9 says a tool is not served but names none/);
  });
  it('rule 2: a "not served" line without a backtick span gives red', async () => {
    expect((await checkMarks('x.editor.markdown', guide('unserved: captureFrame', 'captureFrame is not served.'), fake())).length).toBeGreaterThan(0);
  });
  it('rule 2: an unserved name with no prose line gives red', async () => {
    expect((await checkMarks('x.editor.markdown', guide('unserved: captureFrame', 'Nothing here.'), fake())).join()).toMatch(/marks captureFrame unserved, but no "not served" line names it/);
  });
  it('rule 3: an unimplemented entry whose probe succeeds gives red', async () => {
    expect((await checkMarks('x.editor.markdown', GOOD, fake({ probe: async () => undefined }))).join()).toMatch(/marks context\.include=transcript unimplemented, but context answers success: it is implemented now, apply the T18 sweep/);
    expect((await checkMarks('x.editor.markdown', GOOD, fake({ probe: async () => 'INVALID_TOOL_INPUT' }))).join()).toMatch(/answers INVALID_TOOL_INPUT/);
  });
  it('rule 4: typos and unknown tools or parameters give red', async () => {
    for (const head of ['unserved: captureFrmae', 'unimplemented: contxt.include=transcript', 'unimplemented: context.inclde=transcript', 'unimplemented: context', 'unimplemented: exportProject.x'])
      expect((await checkMarks('x.editor.markdown', guide(head, '`captureFrmae` is not served.'), fake())).length, head).toBeGreaterThan(0);
    expect((await checkMarks('x.editor.markdown', guide('unimplemented: context.types', ''), fake({ served: [{ name: 'context', inputSchema: { properties: { types: {} } } }] }))).join()).toMatch(/has no probe/);
  });
  it('rule 5: an unmarked backticked mention of an unserved tool gives red; a marked mention with a "not served" line passes', async () => {
    const plain = '- Check the look with `captureFrame {timestamps}`.';
    expect((await checkMarks('x.creative.markdown', guide('', plain), fake())).join()).toMatch(/x\.creative\.markdown:8 names `captureFrame`, which is not served, but captureFrame is not in unserved/);
    expect(await checkMarks('x.creative.markdown', guide('unserved: captureFrame', `${plain}
- \`captureFrame\` may be missing from this build's tool list.`), fake())).toEqual([]);
    expect(await checkMarks('x.editor.markdown', guide('', 'Unmarked prose about captureFrame without backticks.'), fake())).toEqual([]);
  });
  it('KNOWN_UNSERVED holds no served tool', () => {
    for (const n of KNOWN_UNSERVED) expect(TOOLS.map(t => t.name), n).not.toContain(n);
  });
});

describe('T23 marks check: the real probe and the real guides', () => {
  it('the probe reports NOT_IMPLEMENTED for a known refusal and nothing for a served read', async () => {
    expect(await realProbe('viewItemDetails', { itemId: 'v1', include: 'effects' })).toBe('NOT_IMPLEMENTED');
    expect(await realProbe('viewItemDetails', { itemId: 'v1', include: 'transcript' })).toBeUndefined();
    expect(await realProbe('context', { include: 'timing' })).toBeUndefined();
  });
  for (const file of FILES) it(`${file} marks agree with the build`, async () => {
    expect(await checkMarks(file, read(file), REAL_MARKS)).toEqual([]);
  });
});
