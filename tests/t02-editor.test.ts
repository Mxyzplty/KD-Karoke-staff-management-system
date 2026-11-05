// SPDX-License-Identifier: AGPL-3.0-only
// T02 owned acceptance G1/G4 maths, H5 drag payloads, the intent seam (I1) and the view-state store (D1/D2). Pure modules, Node only;
// DOM behaviour is in tests/ui/t02-*.spec.ts. Oracle: part 3 §46.4, §46.6 (W3-ED-24), §46.7 and our written view rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decimals, dragValue, format, FULL_RANGE_PX, quantise, typedValue } from '../apps/web/src/editor/slider';
import type { Range } from '../apps/web/src/editor/slider';
import { DEFAULT_GRADIENT, formatColour, gradientCss, hsvToRgb, parseColour, parseGradient, RADIAL_POSITIONS, rgbToHsv } from '../apps/web/src/editor/colour';
import { carriesPayload, parsePayload, readPayload, setDragPayload, TIMELINE_DATA_TYPE } from '../apps/web/src/editor/dnd';
import { dispatch, history, INTENTS, installIntentHandler, subscribeIntents } from '../apps/web/src/editor/commands';
import type { Intent, Outcome } from '../apps/web/src/editor/commands';
import { PREVIEW_QUALITY_KEY, readQuality, readTimelineUi, resetView, select, setQuality, setUi, setView, TIMELINE_UI_KEY, TOOLS, toggleToolMode, view } from '../apps/web/src/editor/view';

const exposure: Range = { min: -3, max: 3, step: 0.05 }, contrast: Range = { min: 0, max: 2, step: 0.01 };

describe('G1 slider maths (ground truth: §46.6 W3-ED-24)', () => {
  it('relative drag: about the full range per 324 CSS px; Exposure −3…3 over 100 px gives +1.85, Shift gives +0.20', () => {
    expect(FULL_RANGE_PX).toBe(324);
    expect(dragValue(0, 100, exposure, false)).toBe(1.85); expect(Math.abs(dragValue(0, 100, exposure, false) - 1.85)).toBeLessThanOrEqual(0.05);
    expect(dragValue(0, 100, exposure, true)).toBe(0.2); expect(Math.abs(dragValue(0, 100, exposure, true) - 0.2)).toBeLessThanOrEqual(0.05);
    expect(dragValue(0, -100, exposure, false)).toBe(-1.85); expect(dragValue(0, 0, exposure, false)).toBe(0);
    expect(dragValue(1, 100, exposure, false)).toBe(2.85); // relative: starts from the current value, not from the click position
  });
  it('drag clamps to the range and snaps to the step', () => {
    expect(dragValue(0, 10000, exposure, false)).toBe(3); expect(dragValue(0, -10000, exposure, false)).toBe(-3);
    expect(dragValue(1, 100, contrast, false)).toBe(1.62); // 1 + 100 × 2 ÷ 324 = 1.6173 → step 0.01
  });
  it('quantise, decimals and format', () => {
    expect(quantise(1.234, contrast)).toBe(1.23); expect(quantise(1.236, contrast)).toBe(1.24); expect(quantise(4, contrast)).toBe(2); expect(quantise(-1, contrast)).toBe(0);
    expect(quantise(0.07, { min: 0, max: 100, step: 1 })).toBe(0); expect(quantise(50.5, { min: -100, max: 100, step: 1 })).toBe(51);
    expect([decimals(1), decimals(0.5), decimals(0.05), decimals(0.01), decimals(1e-7)]).toEqual([0, 1, 2, 2, 7]);
    expect(format(1.85, 0.05)).toBe('1.85'); expect(format(2, 1)).toBe('2'); expect(format(0.2, 0.05)).toBe('0.20'); expect(format(-3, 0.05)).toBe('-3.00');
  });
  it('typed values: clamp into the range, then snap; non-numbers are ignored', () => {
    expect(typedValue('-99', exposure)).toBe(-3); expect(typedValue('999', exposure)).toBe(3); expect(typedValue('abc', exposure)).toBeNull();
    expect(typedValue('1.234', exposure)).toBe(1.25); expect(typedValue('−1', exposure)).toBe(-1); expect(typedValue('–1.5', exposure)).toBe(-1.5);
    expect(typedValue('+2', exposure)).toBe(2); expect(typedValue('.5', exposure)).toBe(0.5); expect(typedValue(' 2 ', exposure)).toBe(2); expect(typedValue('5.', exposure)).toBe(3);
    expect(typedValue('-5', contrast)).toBe(0);
    for (const bad of ['', '  ', '1e3', '1,5', 'NaN', 'Infinity', '--1', '1.2.3', '0x10', '1 2']) expect(typedValue(bad, exposure), JSON.stringify(bad)).toBeNull();
  });
});

describe('G4 colour maths (§46.4, §46.7)', () => {
  it('parses #rgb, #rrggbb, #rrggbbaa and transparent; rejects anything else', () => {
    expect(parseColour('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 }); expect(parseColour('#FF0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColour('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 }); expect(parseColour('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColour(' #00ff00 ')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    for (const bad of ['red', '#ff', '#ffff', '#gggggg', 'ff0000', 'rgb(0,0,0)', '']) expect(parseColour(bad), bad).toBeNull();
  });
  it('formats opaque colours as #rrggbb and others as #rrggbbaa', () => {
    expect(formatColour({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000'); expect(formatColour({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#ff000080'); expect(formatColour({ r: 0, g: 0, b: 0, a: 0 })).toBe('#00000000');
  });
  it('HSV ↔ RGB round-trips and matches known primaries', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 1, v: 1, a: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0, a: 1 }).h).toBe(120); expect(rgbToHsv({ r: 0, g: 0, b: 255, a: 1 }).h).toBe(240);
    expect(rgbToHsv({ r: 128, g: 128, b: 128, a: 1 }).s).toBe(0);
    expect(hsvToRgb({ h: 120, s: 1, v: 1, a: 1 })).toEqual({ r: 0, g: 255, b: 0, a: 1 }); expect(hsvToRgb({ h: 60, s: 1, v: 1, a: 1 })).toEqual({ r: 255, g: 255, b: 0, a: 1 });
    expect(hsvToRgb({ h: 0, s: 0, v: 1, a: 2 })).toEqual({ r: 255, g: 255, b: 255, a: 1 }); // alpha clamps
    for (const hex of ['#336699', '#ffffff', '#000000', '#ff8800', '#12ab34', '#fedcba']) expect(formatColour(hsvToRgb(rgbToHsv(parseColour(hex)!))), hex).toBe(hex);
  });
  it('gradient defaults and CSS: linear 180°, black 0% → white 100%', () => {
    expect(DEFAULT_GRADIENT).toEqual({ kind: 'linear', angle: 180, position: 'center', stops: [{ colour: '#000000', at: 0 }, { colour: '#ffffff', at: 100 }] });
    expect(gradientCss(DEFAULT_GRADIENT)).toBe('linear-gradient(180deg, #000000 0%, #ffffff 100%)');
    expect(gradientCss({ ...DEFAULT_GRADIENT, kind: 'radial', position: 'left top' })).toBe('radial-gradient(circle at left top, #000000 0%, #ffffff 100%)');
    expect(gradientCss({ ...DEFAULT_GRADIENT, angle: 90.4, stops: [{ colour: '#ffffff', at: 100 }, { colour: '#ff0000', at: 50.4 }, { colour: '#000000', at: 0 }] })).toBe('linear-gradient(90deg, #000000 0%, #ff0000 50%, #ffffff 100%)');
    expect(RADIAL_POSITIONS).toEqual(['left top', 'top', 'right top', 'left', 'center', 'right', 'left bottom', 'bottom', 'right bottom']);
  });
  it('parseGradient reads back what gradientCss writes and nothing else', () => {
    for (const g of [DEFAULT_GRADIENT, { ...DEFAULT_GRADIENT, kind: 'radial' as const, position: 'right bottom' }, { ...DEFAULT_GRADIENT, angle: 45, stops: [{ colour: '#000000', at: 0 }, { colour: '#00ff00', at: 30 }, { colour: '#ffffff', at: 100 }] }])
      expect(parseGradient(gradientCss(g))).toEqual(g);
    for (const bad of ['red', '#ffffff', 'linear-gradient(180deg, #000000 0%)', 'conic-gradient(red, blue)', '']) expect(parseGradient(bad), bad).toBeNull();
  });
});

describe('H5 drag payloads (findings part 2 §36: kinds assets / stock / text)', () => {
  const asset = { assetId: 'a1', type: 'video', name: 'clip.mp4' };
  const stock = { provider: 'pexels', provider_id: '7', type: 'video', name: 'Video', thumbnail_url: 'https://example.test/thumb', preview_url: 'https://example.test/preview', duration_ms: 5000, width: 1920, height: 1080, attribution: 'Attribution', author: 'Author', licence: 'Pexels License', page_url: 'https://example.test/page', download_url: 'https://example.test/download', tags: [] };
  it('accepts well-formed payloads of the three kinds', () => {
    expect(parsePayload(JSON.stringify({ kind: 'assets', items: [asset, { ...asset, assetId: 'a2', type: 'image' }] }))).toEqual({ kind: 'assets', items: [asset, { ...asset, assetId: 'a2', type: 'image' }] });
    const item = stock;
    expect(parsePayload(JSON.stringify({ kind: 'stock', item }))).toEqual({ kind: 'stock', item });
    expect(parsePayload(JSON.stringify({ kind: 'text', text: 'Hello' }))).toEqual({ kind: 'text', text: 'Hello' }); expect(parsePayload(JSON.stringify({ kind: 'text', text: '' }))).toEqual({ kind: 'text', text: '' });
  });
  it('strips unknown fields from asset items and rejects every malformed shape', () => {
    expect(parsePayload(JSON.stringify({ kind: 'assets', items: [{ ...asset, path: '/etc/passwd' }] }))).toEqual({ kind: 'assets', items: [asset] });
    const bad: unknown[] = [
      { kind: 'assets', items: [] }, { kind: 'assets' }, { kind: 'assets', items: 'x' }, { kind: 'assets', items: [{ ...asset, type: 'document' }] }, { kind: 'assets', items: [{ ...asset, name: 5 }] },
      { kind: 'assets', items: [asset, { assetId: 'b' }] }, { kind: 'assets', items: [null] }, { kind: 'stock' }, { kind: 'stock', item: { provider: 'pexels' } }, { kind: 'stock', item: { provider: 1, provider_id: 'x' } },
      { kind: 'text', text: 5 }, { kind: 'text' }, { kind: 'file', text: 'x' }, {}, [], null, 'x', 5,
    ];
    for (const b of bad) expect(parsePayload(JSON.stringify(b)), JSON.stringify(b)).toBeNull();
    for (const key of Object.keys(stock)) { const item: Record<string, unknown> = { ...stock }; delete item[key]; expect(parsePayload(JSON.stringify({ kind: 'stock', item })), `missing ${key}`).toBeNull(); }
    expect(parsePayload(JSON.stringify({ kind: 'stock', item: { ...stock, provider: 'not-a-provider' } }))).toBeNull();
    expect(parsePayload('{not json')).toBeNull(); expect(parsePayload('')).toBeNull();
  });
  it('writes and reads through a DataTransfer under the timeline data type', () => {
    const store = new Map<string, string>(), data = { setData: (t: string, v: string) => store.set(t, v), getData: (t: string) => store.get(t) ?? '', get types() { return [...store.keys()]; }, effectAllowed: '' } as unknown as DataTransfer;
    expect(carriesPayload(data)).toBe(false); expect(readPayload(data)).toBeNull();
    setDragPayload(data, { kind: 'assets', items: [{ assetId: 'a1', type: 'audio', name: 'x.mp3' }] });
    expect(TIMELINE_DATA_TYPE).toBe('application/x-cutframe-timeline'); expect(carriesPayload(data)).toBe(true); expect(data.effectAllowed).toBe('copy');
    expect(readPayload(data)).toEqual({ kind: 'assets', items: [{ assetId: 'a1', type: 'audio', name: 'x.mp3' }] });
  });
});

describe('I1 intent seam: stubs refuse visibly and never succeed', () => {
  const removers: (() => void)[] = [];
  afterEach(() => { for (const r of removers.splice(0)) r(); });
  const seen = (): { intent: Intent; outcome: Outcome }[] => { const log: { intent: Intent; outcome: Outcome }[] = []; removers.push(subscribeIntents((intent, outcome) => log.push({ intent, outcome }))); return log; };
  const sample = (type: Intent['type']): Intent => {
    const base: Record<string, unknown> = { itemIds: ['i'], ripple: false, atMs: 0, dx: 0, dy: 0, items: [], deltaMs: 0, trackId: 't', newTrack: false, edge: 'start', itemId: 'i', markerId: 'm', timeMs: 0, count: 1, name: 'n', flag: 'hidden', value: true, volume: 1, height: 56, beforeTrackId: null, trackIds: ['a', 'b'], groupId: 'g', direction: 'up', aspectRatio: '16:9' };
    return { type, ...base } as Intent;
  };
  it('ground truth: every undoable/edit intent without an owner returns NOT_IMPLEMENTED naming its owner', () => {
    const log = seen();
    for (const type of Object.keys(INTENTS) as (keyof typeof INTENTS)[]) {
      const { owner, label } = INTENTS[type], outcome = dispatch(sample(type));
      expect(outcome, type).toEqual({ ok: false, code: 'NOT_IMPLEMENTED', owner, message: `${label} is not yet implemented (${owner}).` });
    }
    expect(log).toHaveLength(Object.keys(INTENTS).length); expect(log.every(l => l.outcome.ok === false)).toBe(true);
    const owners = Object.fromEntries(Object.entries(INTENTS).map(([k, v]) => [k, v.owner]));
    expect(owners).toMatchObject({ undo: 'T03', redo: 'T03', deleteItems: 'T03', splitItems: 'T03', duplicateItems: 'T03', nudgeItems: 'T03', pasteItems: 'T03', moveItems: 'T03', trimItem: 'T03', slipItem: 'T03', addMarker: 'T03', removeMarker: 'T03', clearMarkers: 'T03', deleteTrack: 'T03', renameTrack: 'T03', setTrackFlag: 'T03', setTrackVolume: 'T03', resizeTrack: 'T03', moveTrackLayer: 'T03', groupTracks: 'T03', resizeCanvas: 'T03', togglePlayback: 'T15', deleteKeyframe: 'T04' });
  });
  it('placement, drop, editProperty and feature intents name their own owner and label', () => {
    expect(dispatch({ type: 'placeAssets', assetIds: ['a'], name: 'clip.mp4' })).toEqual({ ok: false, code: 'NOT_IMPLEMENTED', owner: 'T03', message: 'Placing clip.mp4 on the timeline is not yet implemented (T03).' });
    const drop = (payload: NonNullable<ReturnType<typeof parsePayload>>) => dispatch({ type: 'drop', payload, trackId: null, timeMs: 0, below: false });
    expect(drop({ kind: 'text', text: 'x' })).toMatchObject({ owner: 'T05', message: 'Dropping text on the timeline is not yet implemented (T05).' });
    expect(drop({ kind: 'stock', item: { provider: 'pexels', provider_id: '1' } as never })).toMatchObject({ owner: 'T03', message: 'Placing stock media on the timeline is not yet implemented (T03).' });
    expect(drop({ kind: 'assets', items: [{ assetId: 'a', type: 'video', name: 'n' }] })).toMatchObject({ owner: 'T03', message: 'Placing footage on the timeline is not yet implemented (T03).' });
    expect(dispatch({ type: 'editProperty', itemIds: ['i'], owner: 'T10', label: 'Color adjustments', key: 'color-wheels', value: { exposure: 1 } })).toEqual({ ok: false, code: 'NOT_IMPLEMENTED', owner: 'T10', message: 'Color adjustments is not yet implemented (T10).' });
    expect(dispatch({ type: 'feature', owner: 'T16', label: 'Export' })).toEqual({ ok: false, code: 'NOT_IMPLEMENTED', owner: 'T16', message: 'Export is not yet implemented (T16).' });
  });
  it('an installed handler takes precedence for the intents it owns; others still refuse; removal restores the refusal', () => {
    const log = seen(), calls: string[] = [];
    removers.push(installIntentHandler(i => { calls.push(`first:${i.type}`); return i.type === 'undo' ? { ok: true } : undefined; }));
    removers.push(installIntentHandler(i => { calls.push(`second:${i.type}`); return i.type === 'redo' ? { ok: false, code: 'NOTHING_TO_REDO', message: 'Nothing to redo.' } : undefined; }));
    expect(dispatch({ type: 'undo' })).toEqual({ ok: true });
    expect(calls).toEqual(['first:undo']); // the first handler to answer stops the chain
    expect(dispatch({ type: 'redo' })).toEqual({ ok: false, code: 'NOTHING_TO_REDO', message: 'Nothing to redo.' });
    expect(dispatch({ type: 'splitItems', itemIds: ['i'], atMs: 1 })).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED', owner: 'T03' });
    expect(log.map(l => l.outcome)).toEqual([{ ok: true }, { ok: false, code: 'NOTHING_TO_REDO', message: 'Nothing to redo.' }, expect.objectContaining({ code: 'NOT_IMPLEMENTED' })]);
    for (const r of removers.splice(0)) r();
    expect(dispatch({ type: 'undo' })).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
  });
  it('subscribeIntents reports every dispatch with its outcome until unsubscribed', () => {
    const log: Intent['type'][] = [], off = subscribeIntents(i => log.push(i.type));
    dispatch({ type: 'togglePlayback' }); dispatch({ type: 'deleteKeyframe' }); off(); dispatch({ type: 'undo' });
    expect(log).toEqual(['togglePlayback', 'deleteKeyframe']);
  });
  it('history seam: nothing to undo or redo until T03 replaces it', () => { expect(history.canUndo()).toBe(false); expect(history.canRedo()).toBe(false); });
});

describe('D1/D2 view state', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    resetView();
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('ground truth: defaults', () => {
    expect(view()).toMatchObject({ playheadMs: 0, zoom: 0.05, scroll: 0, toolMode: 'select', selection: [], markerId: null, keyframeSelected: false, clipboard: [], groupSelection: null, performance: false, shortcuts: false, quality: 'full', left: 'footage', footageTab: 'uploads', right: { kind: 'none' }, inspectorTab: 'properties', drawer: null });
    expect(view().ui).toEqual({ snapping: true, markersVisible: true, waveforms: true }); expect(view().modes).toEqual({ graphEditorOpen: false, smartMask: false, timelineLocked: false });
  });
  it('the 11-tool rail keeps Xapp\'s order with our labels and owners', () => {
    expect(TOOLS.map(t => t.id)).toEqual(['text', 'motion', 'shapes', 'layouts', 'captions', 'effects', 'presets', 'videos', 'photos', 'sounds', 'voiceover']);
    expect(TOOLS.map(t => t.label)).toEqual(['Text', 'Motion graphics', 'Shapes', 'Layouts', 'Captions', 'Effects', 'Style presets', 'Videos', 'Photos', 'Sounds', 'Voice-over']);
    expect(Object.fromEntries(TOOLS.map(t => [t.id, t.owner]))).toEqual({ text: 'T05', motion: 'T08', shapes: 'T06', layouts: 'T07', captions: 'T09', effects: 'T10', presets: 'T22', videos: 'T14', photos: 'T14', sounds: 'T14', voiceover: 'T13' });
  });
  it('tool modes: pressing the active one returns to select; switching goes straight across', () => {
    toggleToolMode('ripple'); expect(view().toolMode).toBe('ripple'); toggleToolMode('ripple'); expect(view().toolMode).toBe('select');
    toggleToolMode('slip'); expect(view().toolMode).toBe('slip'); toggleToolMode('ripple'); expect(view().toolMode).toBe('ripple'); toggleToolMode('slip'); expect(view().toolMode).toBe('slip'); toggleToolMode('slip'); expect(view().toolMode).toBe('select');
  });
  it('selecting an item shows the inspector, clears a marker; emptying the selection leaves a tool panel alone', () => {
    setView({ markerId: 'm1' }); select(['a']); expect(view()).toMatchObject({ selection: ['a'], markerId: null, right: { kind: 'inspector' } });
    select([]); expect(view().right).toEqual({ kind: 'none' });
    setView({ right: { kind: 'tool', tool: 'effects' } }); select(['a']); expect(view().right).toEqual({ kind: 'inspector' }); select([]); expect(view().right).toEqual({ kind: 'none' });
    setView({ right: { kind: 'tool', tool: 'effects' } }); select([]); expect(view().right).toEqual({ kind: 'tool', tool: 'effects' });
  });
  it('per-browser toggles persist, default on, and ignore junk', () => {
    setUi({ snapping: false }); expect(JSON.parse(store.get(TIMELINE_UI_KEY)!)).toEqual({ snapping: false, markersVisible: true, waveforms: true });
    expect(readTimelineUi()).toEqual({ snapping: false, markersVisible: true, waveforms: true });
    store.set(TIMELINE_UI_KEY, JSON.stringify({ snapping: false, markersVisible: 'no', junk: true, waveforms: false })); expect(readTimelineUi()).toEqual({ snapping: false, markersVisible: true, waveforms: false });
    store.set(TIMELINE_UI_KEY, '{broken'); expect(readTimelineUi()).toEqual({ snapping: true, markersVisible: true, waveforms: true });
    store.set(TIMELINE_UI_KEY, JSON.stringify({ snapping: false })); resetView(); expect(view().ui.snapping).toBe(false);
  });
  it('preview quality: Full by default, stored per browser, junk reads as Full', () => {
    expect(readQuality()).toBe('full'); setQuality('half'); expect(store.get(PREVIEW_QUALITY_KEY)).toBe('half'); expect(readQuality()).toBe('half'); resetView(); expect(view().quality).toBe('half');
    setQuality('quarter'); expect(readQuality()).toBe('quarter'); store.set(PREVIEW_QUALITY_KEY, 'bogus'); expect(readQuality()).toBe('full'); store.delete(PREVIEW_QUALITY_KEY); expect(readQuality()).toBe('full');
  });
  it('works without any storage (private mode): toggles still apply for the page', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(readTimelineUi()).toEqual({ snapping: true, markersVisible: true, waveforms: true }); expect(readQuality()).toBe('full');
    setUi({ markersVisible: false }); expect(view().ui.markersVisible).toBe(false); setQuality('quarter'); expect(view().quality).toBe('quarter');
  });
  it('resetView returns everything to the defaults (a project opens with fresh view state)', () => {
    setView({ playheadMs: 5000, zoom: 0.5, selection: ['a'], clipboard: [{ id: 'x' }], toolMode: 'ripple', groupSelection: { origin: 'a', checked: ['a'] }, drawer: 'tab:basic', collapsedGroups: ['g'] }); resetView();
    expect(view()).toMatchObject({ playheadMs: 0, zoom: 0.05, selection: [], clipboard: [], toolMode: 'select', groupSelection: null, drawer: null, collapsedGroups: [] });
  });
});
