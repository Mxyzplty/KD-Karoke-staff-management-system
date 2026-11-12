// SPDX-License-Identifier: AGPL-3.0-only
// T22 step 5 applyPreset / browsePresets handlers before step 13 registers them in TOOLS.
// Oracle: findings part 2 §31, plan S2 and the pinned step-5 success/refusal contract. Tool starts are seconds;
// preset item times/documents are ms. Expected envelopes and browse rows below are independent of implementation helpers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPreset, browsePresets as browseHandler } from '../apps/web/src/presets/tools';
import { browsePresets } from '../apps/web/src/presets/browse';
import { STYLE_PRESETS } from '../apps/web/src/presets/content';
import type { DirectPreset, StylePreset } from '../apps/web/src/presets/model';
import { CommandBus } from '../apps/web/src/timeline/bus';
import { CommandError } from '../apps/web/src/timeline/model';
import type { ToolContext, ToolResult } from '../apps/web/src/timeline/tools';
import type { RecordData } from '../apps/web/src/store/model';
import { build, itemOf, mkItem, mkTrack, resetIds, useIds } from './t03-fixtures';

beforeEach(() => useIds()); afterEach(() => resetIds());
function world() {
  let current = build({ tracks: [mkTrack('O0', 'overlay')], items: [mkItem('keep', 'O0', 0, 9000, { type: 'text', details: { text: 'Keep' } })] });
  const bus = new CommandBus({ get: () => current, set: doc => { current = doc; } });
  const ctx: ToolContext = { bus, asset: () => undefined };
  return { ctx, bus, get doc() { return current; } };
}
// Same CommandError-to-result boundary as callTool, without pretending these handlers are registered before step 13.
function invoke(handler: typeof applyPreset, ctx: ToolContext, args: RecordData): ToolResult {
  try { return handler(ctx, args); } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    return { success: false, code: error.code, error: error.error };
  }
}
const SLUGS = ['text', 'title-cards', 'lower-thirds', 'info-cards', 'slide-in-panels', 'misc', 'overlays', 'collages'];
function expectedRows(list: StylePreset[], args: { category?: string; query?: string } = {}) {
  const query = (args.query ?? '').toLowerCase();
  return list.filter(p => (!args.category || p.id.split('/')[0] === args.category) && (!query || p.name.toLowerCase().includes(query) || p.description.toLowerCase().includes(query)))
    .map(p => ({ id: p.id, name: p.name, category: p.id.split('/')[0], description: p.description, type: Array.isArray((p as DirectPreset).items) ? 'text' : 'motion-graphic' }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
const injectedDirect = (id: string, name: string, description: string): DirectPreset => ({ id, name, description, items: [{ type: 'text', relativeStart: 0, duration: 1000,
  details: { text: 'Fixture', left: 0.1, top: 0.2, width: 0.3, height: 0.1, fontSize: 0.04 } }] });
const INJECTED: StylePreset[] = [
  injectedDirect('text/zulu', 'Last entry', 'No matching token here.'),
  injectedDirect('text/a0', 'Apple cards', 'COPPER appears only in this description.'),
  { id: 'misc/zulu', name: 'Another entry', description: 'A needle appears in the description.', mg_code: 'export const G = () => null;', duration_ms: 1000 },
  injectedDirect('text/a-thing', 'Needle headline', 'An independently authored entry.'),
];

describe('applyPreset handler: own overlay tracks, exact success envelope and one undo', () => {
  it.each([{ start: undefined, ms: 0 }, { start: 12.345, ms: 12345 }])('timelineStart $start → $ms ms', ({ start, ms }) => {
    const p = STYLE_PRESETS.find(p => p.id === 'text/kicker-and-title') as DirectPreset, w = world(), before = structuredClone(w.doc);
    const result = invoke(applyPreset, w.ctx, { presetId: p.id, ...(start === undefined ? {} : { timelineStart: start }) });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.message).toBe(`Applied "${p.name}" — ${p.items.length} item(s)`);
    const added = w.doc.items.filter(item => item.id !== 'keep');
    expect(result.data).toEqual({ presetId: p.id, itemIds: added.map(item => item.id), trackIds: added.map(item => item.trackId) });
    expect(added).toHaveLength(p.items.length); expect(w.doc.tracks).toHaveLength(before.tracks.length + p.items.length);
    expect(added.map(item => item.display)).toEqual(p.items.map(item => ({ from: ms + item.relativeStart, to: ms + item.relativeStart + item.duration })));
    expect(added.map(item => item.trackId)).toHaveLength(new Set(added.map(item => item.trackId)).size);
    for (const item of added) expect(w.doc.tracks.find(track => track.id === item.trackId)?.kind).toBe('overlay');
    expect(itemOf(w.doc, 'keep')).toEqual(itemOf(before, 'keep')); expect(w.bus.labels()).toEqual(['Add items']); expect(w.bus.undoStack[0].source).toBe('agent');
    w.bus.undo(); expect(w.doc).toEqual(before); expect(w.bus.undoStack).toHaveLength(0);
  });
  it('a motion-graphic style yields one item and one track with the same envelope', () => {
    const p = STYLE_PRESETS.find(p => p.id === 'collages/grid-reveal')!, w = world(), result = invoke(applyPreset, w.ctx, { presetId: p.id });
    expect(result).toMatchObject({ success: true, message: `Applied "${p.name}" — 1 item(s)` });
    expect(result.data.itemIds).toHaveLength(1); expect(result.data.trackIds).toHaveLength(1);
    expect(itemOf(w.doc, result.data.itemIds[0])).toMatchObject({ type: 'motionGraphic', metadata: { presetId: p.id } }); expect(w.bus.labels()).toEqual(['Add items']);
  });
});

describe('applyPreset handler refusals leave document and undo unchanged', () => {
  it.each([
    { args: { presetId: 'text/not-a-preset' }, code: 'PRESET_NOT_FOUND' },
    { args: { presetId: 'text/kicker-and-title', timelineStart: -1 }, code: 'INVALID_TIMELINE_START', error: 'timelineStart must be >= 0. Received: -1s.' },
  ])('$code', ({ args, code, error }) => {
    const w = world(), before = JSON.stringify(w.doc), result = invoke(applyPreset, w.ctx, args);
    expect(result).toMatchObject({ success: false, code, ...(error ? { error } : {}) });
    expect(JSON.stringify(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0); expect(w.bus.redoStack).toHaveLength(0);
  });
  it.each([{ presetId: 'text/not-a-preset', code: 'PRESET_NOT_FOUND' }, { presetId: 'text/kicker-and-title', timelineStart: -1, code: 'INVALID_TIMELINE_START' }])(
    '$code is a thrown CommandError, not a schema return', ({ code, ...args }) => {
      const w = world(), before = JSON.stringify(w.doc);
      let error: unknown; try { applyPreset(w.ctx, args); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(CommandError); expect(error).toMatchObject({ code });
      expect(JSON.stringify(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0);
    });
});

describe('Lane A 02:49: tab schema failures return the helper INVALID_TOOL_INPUT envelope, never throw', () => {
  const cases: { tool: 'applyPreset' | 'browsePresets'; args: RecordData; path: string; code: string; reason: string }[] = [
    { tool: 'applyPreset', args: {}, path: '$.presetId', code: 'REQUIRED', reason: "must have required property 'presetId'" },
    ...[42, null, {}].map(presetId => ({ tool: 'applyPreset' as const, args: { presetId }, path: '$.presetId', code: 'TYPE', reason: 'must be string' })),
    ...[NaN, Infinity, -Infinity, '1', null].map(timelineStart => ({ tool: 'applyPreset' as const, args: { presetId: 'text/kicker-and-title', timelineStart }, path: '$.timelineStart', code: 'TYPE', reason: 'must be number' })),
    ...['not-a-category', 'Text', ''].map(category => ({ tool: 'browsePresets' as const, args: { category }, path: '$.category', code: 'ENUM', reason: 'must be equal to one of the allowed values' })),
    ...[42, null].map(category => ({ tool: 'browsePresets' as const, args: { category }, path: '$.category', code: 'TYPE', reason: 'must be string' })),
    ...[42, null].map(query => ({ tool: 'browsePresets' as const, args: { query }, path: '$.query', code: 'TYPE', reason: 'must be string' })),
  ];
  it.each(cases)('$tool $path $code ($args)', ({ tool, args, path, code, reason }) => {
    const w = world(), before = JSON.stringify(w.doc), handler = tool === 'applyPreset' ? applyPreset : browseHandler;
    let result: ToolResult | undefined;
    expect(() => { result = handler(w.ctx, args); }).not.toThrow();
    expect(result).toEqual({ success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`, message: `${path}: ${reason}`,
      details: { errors: [{ path, code, message: reason }] } });
    expect(JSON.stringify(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0); expect(w.bus.redoStack).toHaveLength(0);
  });
  it('several errors are preserved and their sentences are joined with semicolon-space (no undocumented ordering pinned)', () => {
    const w = world(), before = JSON.stringify(w.doc);
    const errors = [{ path: '$.presetId', code: 'TYPE', message: 'must be string' }, { path: '$.timelineStart', code: 'TYPE', message: 'must be number' }];
    let result: ToolResult | undefined;
    expect(() => { result = applyPreset(w.ctx, { presetId: 42, timelineStart: NaN }); }).not.toThrow();
    expect(result).toMatchObject({ success: false, code: 'INVALID_TOOL_INPUT', error: 'Invalid input for applyPreset', details: { errors: expect.arrayContaining(errors) } });
    expect(result!.details.errors).toHaveLength(2);
    const a = '$.presetId: must be string', b = '$.timelineStart: must be number'; expect([`${a}; ${b}`, `${b}; ${a}`]).toContain(result!.message);
    expect(JSON.stringify(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0);
  });
});

describe('S2 browsePresets: shipped rows, exact fields, plain code-unit sort, filters and no mutation', () => {
  it('the full shipped list has exactly the five documented keys and a correct count/type/category', () => {
    const rows = expectedRows(STYLE_PRESETS), result = browsePresets({});
    expect(result).toEqual({ success: true, count: rows.length, presets: rows });
    for (const row of result.presets) expect(Object.keys(row).sort()).toEqual(['category', 'description', 'id', 'name', 'type']);
  });
  it.each(SLUGS)('category %s', category => {
    const rows = expectedRows(STYLE_PRESETS, { category });
    expect(browsePresets({ category })).toEqual({ success: true, count: rows.length, presets: rows });
    if (category === 'overlays' || category === 'title-cards') expect(rows).toEqual([]);
  });
  it.each(['hEaDlInE', 'SuRvEy ReSuLtS', '__NOT_A_PRESET__'])('query %s matches name OR description, ignoring case', query => {
    const rows = expectedRows(STYLE_PRESETS, { query }); expect(browsePresets({ query })).toEqual({ success: true, count: rows.length, presets: rows });
  });
  it('category and query combine with AND', () => {
    const args = { category: 'text', query: 'card' }, rows = expectedRows(STYLE_PRESETS, args);
    expect(browsePresets(args)).toEqual({ success: true, count: rows.length, presets: rows });
  });
  it('an injected unsorted list uses code-unit order (a-thing before a0), not locale order', () => {
    const before = JSON.stringify(INJECTED), result = browsePresets({}, INJECTED);
    expect(result.presets.map(p => p.id)).toEqual(['misc/zulu', 'text/a-thing', 'text/a0', 'text/zulu']);
    expect(result).toEqual({ success: true, count: 4, presets: expectedRows(INJECTED) }); expect(JSON.stringify(INJECTED)).toBe(before);
  });
  it('injected name/description OR and category AND are independently pinned', () => {
    expect(browsePresets({ query: 'nEeDlE' }, INJECTED).presets.map(p => p.id)).toEqual(['misc/zulu', 'text/a-thing']);
    expect(browsePresets({ query: 'cOpPeR' }, INJECTED).presets.map(p => p.id)).toEqual(['text/a0']);
    expect(browsePresets({ category: 'text', query: 'needle' }, INJECTED).presets.map(p => p.id)).toEqual(['text/a-thing']);
    expect(browsePresets({ category: 'misc', query: 'COPPER' }, INJECTED)).toEqual({ success: true, count: 0, presets: [] });
  });
  it('the browse handler reads without a bus command, undo entry or document change', () => {
    const w = world(), before = JSON.stringify(w.doc), rows = expectedRows(STYLE_PRESETS, { category: 'text' });
    expect(invoke(browseHandler, w.ctx, { category: 'text' })).toEqual({ success: true, count: rows.length, presets: rows });
    expect(JSON.stringify(w.doc)).toBe(before); expect(w.bus.undoStack).toHaveLength(0);
  });
});
