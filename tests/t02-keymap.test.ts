// SPDX-License-Identifier: AGPL-3.0-only
// T02 owned acceptance E1–E5 (pure key routing). Oracle: findings §15, part 2 §36, part 3 §46.17 (W3-ED-23). Golden capture G-15 was
// never stored, so every matrix below is a "ground truth" check against our written key table, not "same as Xapp".
import { describe, expect, it } from 'vitest';
import { focusZone, isTimelineRootKey, route, SHORTCUTS } from '../apps/web/src/editor/keymap';
import type { Action, Key, KeyContext, Modes, Zone } from '../apps/web/src/editor/keymap';

const NO_MODES: Modes = { graphEditorOpen: false, smartMask: false, timelineLocked: false, groupSelection: false };
const key = (k: string, mods: Partial<Pick<Key, 'ctrl' | 'meta' | 'shift' | 'alt'>> = {}): Key => ({ key: k, ctrl: false, meta: false, shift: false, alt: false, ...mods });
const ctx = (c: Partial<Omit<KeyContext, 'modes'>> & { modes?: Partial<Modes> } = {}): KeyContext => ({
  zone: 'page', handler: 'global', selectedItems: 0, markerSelected: false, keyframeSelected: false, ripple: false, ...c, modes: { ...NO_MODES, ...c.modes },
});
const ctrl = { ctrl: true }, cmd = { meta: true }, shift = { shift: true };

describe('E2 focus zones', () => {
  it('maps the focused element to a zone', () => {
    expect(focusZone(null)).toBe('page');
    expect(focusZone({ tag: 'BODY' })).toBe('page'); expect(focusZone({ tag: 'html' })).toBe('page');
    expect(focusZone({ tag: 'INPUT', type: 'text' })).toBe('typing'); expect(focusZone({ tag: 'INPUT', type: 'number' })).toBe('typing'); expect(focusZone({ tag: 'INPUT' })).toBe('typing');
    expect(focusZone({ tag: 'TEXTAREA' })).toBe('typing'); expect(focusZone({ tag: 'SELECT' })).toBe('typing'); expect(focusZone({ tag: 'DIV', editable: true })).toBe('typing');
    expect(focusZone({ tag: 'INPUT', type: 'range' })).toBe('control'); expect(focusZone({ tag: 'INPUT', type: 'checkbox' })).toBe('control');
    expect(focusZone({ tag: 'BUTTON' })).toBe('control'); expect(focusZone({ tag: 'A' })).toBe('control'); expect(focusZone({ tag: 'SUMMARY' })).toBe('control');
    for (const role of ['button', 'menuitem', 'menuitemradio', 'tab', 'slider', 'switch', 'checkbox', 'combobox']) expect(focusZone({ tag: 'DIV', role }), role).toBe('control');
    expect(focusZone({ tag: 'DIV', zone: 'timeline' })).toBe('timeline'); expect(focusZone({ tag: 'SECTION', zone: 'preview' })).toBe('preview');
    expect(focusZone({ tag: 'DIALOG' })).toBe('outside'); expect(focusZone({ tag: 'DIV', role: 'listbox' })).toBe('outside');
    // A control inside the timeline is still a control (a focused button swallows the arrows).
    expect(focusZone({ tag: 'BUTTON', zone: 'timeline' })).toBe('control');
    // A clip (role option) inside the timeline zone is the timeline.
    expect(focusZone({ tag: 'DIV', role: 'option', zone: 'timeline' })).toBe('timeline');
    // Anything inside a dialog, popover or menu is an overlay: editor keys never act from there (its own keys, Escape included, win).
    expect(focusZone({ tag: 'H3', overlay: true })).toBe('outside'); expect(focusZone({ tag: 'DIV', zone: 'timeline', overlay: true })).toBe('outside'); expect(focusZone({ tag: 'BUTTON', overlay: true })).toBe('outside');
    expect(focusZone({ tag: 'INPUT', type: 'text', overlay: true })).toBe('typing');
  });
});

type Row = { name: string; k: Key; c?: Partial<Omit<KeyContext, 'modes'>> & { modes?: Partial<Modes> }; expect: Action | null };

/** The normal map, row by row (inventory §15 + W3-ED-23). Acting zones: page, timeline and preview. */
const NORMAL: Row[] = [
  { name: 'Space', k: key(' '), expect: { kind: 'togglePlayback' } },
  { name: 'Right', k: key('ArrowRight'), expect: { kind: 'stepFrame', direction: 1 } },
  { name: 'Left', k: key('ArrowLeft'), expect: { kind: 'stepFrame', direction: -1 } },
  { name: 'Shift+Right', k: key('ArrowRight', shift), expect: { kind: 'stepFrame', direction: 1 } },
  { name: 'Alt+Left', k: key('ArrowLeft', { alt: true }), expect: { kind: 'stepFrame', direction: -1 } },
  { name: 'Ctrl+Right (one frame, no bigger step)', k: key('ArrowRight', ctrl), expect: { kind: 'stepFrame', direction: 1 } },
  { name: 'Ctrl+Left', k: key('ArrowLeft', ctrl), expect: { kind: 'stepFrame', direction: -1 } },
  { name: 'Meta+Right', k: key('ArrowRight', cmd), expect: { kind: 'stepFrame', direction: 1 } },
  { name: 'Ctrl+Shift+Right (any modifier mix: one frame)', k: key('ArrowRight', { ctrl: true, shift: true }), expect: { kind: 'stepFrame', direction: 1 } },
  { name: 'Ctrl+Alt+Left', k: key('ArrowLeft', { ctrl: true, alt: true }), expect: { kind: 'stepFrame', direction: -1 } },
  { name: 'Ctrl+Right with a selection nudges (arrows are decided before shortcuts)', k: key('ArrowRight', ctrl), c: { selectedItems: 1 }, expect: { kind: 'nudge', dx: 5, dy: 0 } },
  { name: 'Up with nothing selected', k: key('ArrowUp'), expect: null },
  { name: 'Right with a selection nudges 5 px', k: key('ArrowRight'), c: { selectedItems: 1 }, expect: { kind: 'nudge', dx: 5, dy: 0 } },
  { name: 'Left with a selection', k: key('ArrowLeft'), c: { selectedItems: 2 }, expect: { kind: 'nudge', dx: -5, dy: 0 } },
  { name: 'Up with a selection', k: key('ArrowUp'), c: { selectedItems: 1 }, expect: { kind: 'nudge', dx: 0, dy: -5 } },
  { name: 'Down with a selection', k: key('ArrowDown'), c: { selectedItems: 1 }, expect: { kind: 'nudge', dx: 0, dy: 5 } },
  { name: 'Shift+Right with a selection nudges 20 px', k: key('ArrowRight', shift), c: { selectedItems: 1 }, expect: { kind: 'nudge', dx: 20, dy: 0 } },
  { name: 'Shift+Down with a selection', k: key('ArrowDown', shift), c: { selectedItems: 1 }, expect: { kind: 'nudge', dx: 0, dy: 20 } },
  { name: 'Ctrl+B splits', k: key('b', ctrl), expect: { kind: 'split' } },
  { name: 'Cmd+B splits', k: key('b', cmd), expect: { kind: 'split' } },
  { name: 'Ctrl+D duplicates', k: key('d', ctrl), expect: { kind: 'duplicate' } },
  { name: 'Ctrl+Z undo', k: key('z', ctrl), expect: { kind: 'undo' } },
  { name: 'Ctrl+Shift+Z redo', k: key('Z', { ctrl: true, shift: true }), expect: { kind: 'redo' } },
  { name: 'Ctrl+Y redo', k: key('y', ctrl), expect: { kind: 'redo' } },
  { name: 'Ctrl+Shift+Y nothing', k: key('Y', { ctrl: true, shift: true }), expect: null },
  { name: 'Ctrl+C copy', k: key('c', ctrl), expect: { kind: 'copy' } },
  { name: 'Ctrl+V paste', k: key('v', ctrl), expect: { kind: 'paste' } },
  { name: 'Ctrl+Shift+M clears markers', k: key('M', { ctrl: true, shift: true }), expect: { kind: 'clearMarkers' } },
  { name: 'Cmd+Shift+P performance', k: key('P', { meta: true, shift: true }), expect: { kind: 'togglePerformance' } },
  { name: 'Ctrl+P alone nothing', k: key('p', ctrl), expect: null },
  { name: 'Ctrl+Alt+Z nothing', k: key('z', { ctrl: true, alt: true }), expect: null },
  { name: 'Ctrl+Shift+B nothing', k: key('B', { ctrl: true, shift: true }), expect: null },
  { name: 'M adds a marker, also with nothing selected', k: key('m'), expect: { kind: 'addMarker' } },
  { name: 'M adds a marker with items selected', k: key('m'), c: { selectedItems: 3 }, expect: { kind: 'addMarker' } },
  { name: 'Shift+M toggles markers', k: key('M', shift), expect: { kind: 'toggleMarkers' } },
  { name: 'Alt+M nothing', k: key('m', { alt: true }), expect: null },
  // T12 (part 2 §36): with exactly one video or image selected (maskTarget), M enters mask edit instead of adding a marker.
  { name: 'M enters mask edit when a video/image is the mask target', k: key('m'), c: { maskTarget: true }, expect: { kind: 'enterMask', marker: false } },
  { name: 'M enters mask edit and adds the marker too in maskMarker parity mode', k: key('m'), c: { maskTarget: true, maskMarker: true }, expect: { kind: 'enterMask', marker: true } },
  { name: 'Alt+M with a mask target still nothing (Alt wins over M)', k: key('m', { alt: true }), c: { maskTarget: true }, expect: null },
  { name: 'Shift+M with a mask target still toggles markers (Shift wins over M)', k: key('M', shift), c: { maskTarget: true }, expect: { kind: 'toggleMarkers' } },
  { name: '+ zooms in', k: key('+', shift), expect: { kind: 'zoom', direction: 'in' } },
  { name: '= zooms in', k: key('='), expect: { kind: 'zoom', direction: 'in' } },
  { name: '- zooms out', k: key('-'), expect: { kind: 'zoom', direction: 'out' } },
  { name: '_ zooms out', k: key('_', shift), expect: { kind: 'zoom', direction: 'out' } },
  { name: 'Ctrl+= nothing', k: key('=', ctrl), expect: null },
  { name: '? opens the shortcut list', k: key('?', shift), expect: { kind: 'shortcuts' } },
  { name: 'Home nothing', k: key('Home'), expect: null },
  { name: 'End nothing', k: key('End'), expect: null },
  { name: 'Escape nothing (no deselect)', k: key('Escape'), c: { selectedItems: 2 }, expect: null },
  { name: 'unmapped letter', k: key('q'), expect: null },
  { name: 'Delete with nothing selected', k: key('Delete'), expect: null },
  { name: 'Delete removes items', k: key('Delete'), c: { selectedItems: 1 }, expect: { kind: 'deleteItems', ripple: false } },
  { name: 'Backspace removes items', k: key('Backspace'), c: { selectedItems: 1 }, expect: { kind: 'deleteItems', ripple: false } },
  { name: 'Delete in ripple mode', k: key('Delete'), c: { selectedItems: 1, ripple: true }, expect: { kind: 'deleteItems', ripple: true } },
  { name: 'Delete: marker beats items', k: key('Delete'), c: { selectedItems: 1, markerSelected: true }, expect: { kind: 'deleteMarker' } },
  { name: 'Delete: keyframe beats marker and items', k: key('Delete'), c: { selectedItems: 1, markerSelected: true, keyframeSelected: true }, expect: { kind: 'deleteKeyframe' } },
  { name: 'Backspace: keyframe', k: key('Backspace'), c: { keyframeSelected: true }, expect: { kind: 'deleteKeyframe' } },
  { name: 'Delete with only a marker selected', k: key('Delete'), c: { markerSelected: true }, expect: { kind: 'deleteMarker' } },
];
const rootRow = (r: Row) => isTimelineRootKey(r.k);

describe('E1 normal key map, row by row (ground truth: findings §15 + W3-ED-23)', () => {
  for (const zone of ['page', 'timeline', 'preview'] as Zone[]) for (const r of NORMAL) {
    // A timeline-root key in the timeline zone is the timeline handler's; every other acting row belongs to the global handler.
    const handler: 'global' | 'timeline' = rootRow(r) && zone === 'timeline' ? 'timeline' : 'global';
    it(`${zone}: ${r.name}`, () => { expect(route(r.k, ctx({ ...r.c, zone, handler }))).toEqual(r.expect); });
  }
});

describe('E2 focus gating', () => {
  const samples = [key(' '), key('ArrowRight'), key('m'), key('Delete'), key('b', ctrl), key('+'), key('?'), key('z', ctrl)];
  it('typing: nothing acts, whatever the key or mode', () => {
    for (const k of samples) for (const modes of [{}, { groupSelection: true }, { timelineLocked: true }]) for (const handler of ['global', 'timeline'] as const)
      expect(route(k, ctx({ zone: 'typing', handler, selectedItems: 1, modes })), `${k.key}`).toBeNull();
    expect(route(key('Escape'), ctx({ zone: 'typing', modes: { groupSelection: true } }))).toBeNull();
  });
  it('a focused control or menu/dialog content: no effect (a button swallows the arrows)', () => {
    for (const zone of ['control', 'outside'] as Zone[]) for (const k of samples) expect(route(k, ctx({ zone, selectedItems: 1 })), `${zone} ${k.key}`).toBeNull();
  });
  it('group-selection Escape also leaves from a focused control (its checkboxes) but not from a dialog or menu', () => {
    expect(route(key('Escape'), ctx({ zone: 'control', modes: { groupSelection: true } }))).toEqual({ kind: 'exitGroupSelection' });
    expect(route(key('Escape'), ctx({ zone: 'outside', modes: { groupSelection: true } }))).toBeNull();
  });
});

describe('E3 handled once: timeline-root keys never run in both handlers', () => {
  const all: Key[] = [
    ...'abcdefghijklmnopqrstuvwxyz'.split('').flatMap(c => [key(c), key(c, ctrl), key(c, { ctrl: true, shift: true }), key(c, cmd), key(c, shift)]),
    key(' '), key('ArrowLeft'), key('ArrowRight'), key('ArrowUp'), key('ArrowDown'), key('Delete'), key('Backspace'), key('Escape'), key('Home'), key('End'), key('+'), key('='), key('-'), key('_'), key('?'),
    key('Delete', shift), key('Backspace', ctrl), key('ArrowLeft', ctrl), key('ArrowRight', shift),
  ];
  const states: Partial<KeyContext>[] = [{}, { selectedItems: 2 }, { markerSelected: true }, { keyframeSelected: true, selectedItems: 1 }, { ripple: true, selectedItems: 1 }];
  const modeSets: Partial<Modes>[] = [{}, { groupSelection: true }, { smartMask: true }, { timelineLocked: true }, { graphEditorOpen: true }, { groupSelection: true, timelineLocked: true }];
  it('for every key × zone × mode × state at most one of {global, timeline} acts', () => {
    let checked = 0;
    for (const k of all) for (const zone of ['page', 'timeline', 'preview', 'control', 'typing', 'outside'] as Zone[]) for (const modes of modeSets) for (const state of states) {
      const g = route(k, ctx({ ...state, zone, handler: 'global', modes })), t = route(k, ctx({ ...state, zone, handler: 'timeline', modes }));
      expect(g !== null && t !== null, `${JSON.stringify(k)} ${zone} ${JSON.stringify(modes)}`).toBe(false); checked++;
    }
    expect(checked).toBeGreaterThan(10000);
  });
  it('exactly one handler acts for each normal-map row that acts in the page, timeline and preview zones', () => {
    for (const zone of ['page', 'timeline', 'preview'] as Zone[])
    for (const r of NORMAL.filter(x => x.expect)) {
      const g = route(r.k, ctx({ ...r.c, zone, handler: 'global' })), t = route(r.k, ctx({ ...r.c, zone, handler: 'timeline' }));
      expect([g, t].filter(Boolean), `${zone} ${r.name}`).toHaveLength(1);
      expect(Boolean(t), `${zone} ${r.name} acts via the timeline handler iff it is a timeline-root key inside the timeline`).toBe(rootRow(r) && zone === 'timeline');
    }
  });
  it('the timeline handler only ever acts on timeline-root keys', () => {
    for (const k of all) { const t = route(k, ctx({ zone: 'timeline', handler: 'timeline', selectedItems: 1, markerSelected: true })); if (t) expect(isTimelineRootKey(k), JSON.stringify(k)).toBe(true); }
  });
  it('timeline-root key set', () => {
    for (const k of [key('m'), key('M'), key('Delete'), key('Backspace'), key('c', ctrl), key('v', cmd), key('z', ctrl), key('Z', { ctrl: true, shift: true })]) expect(isTimelineRootKey(k), JSON.stringify(k)).toBe(true);
    for (const k of [key('M', shift), key('m', { alt: true }), key('d', ctrl), key('b', ctrl), key('y', ctrl), key(' '), key('ArrowLeft'), key('c', { ctrl: true, alt: true })]) expect(isTimelineRootKey(k), JSON.stringify(k)).toBe(false);
  });
});

describe('E4 group-selection layer (part 2 §36)', () => {
  const g = (k: Key, extra: Partial<KeyContext> = {}) => route(k, ctx({ ...extra, modes: { groupSelection: true } }));
  it('Escape clears the mode from page, timeline, preview and a control — via the global handler only', () => {
    for (const zone of ['page', 'timeline', 'preview', 'control'] as Zone[]) expect(g(key('Escape'), { zone }), zone).toEqual({ kind: 'exitGroupSelection' });
    expect(g(key('Escape'), { zone: 'timeline', handler: 'timeline' })).toBeNull();
  });
  it('Ctrl/Cmd+C/V/D/Z/Y, M, Delete and Backspace are swallowed', () => {
    for (const c of ['c', 'v', 'd', 'z', 'y']) for (const mods of [ctrl, cmd]) expect(g(key(c, mods), { zone: 'page' }), `${c} ${JSON.stringify(mods)}`).toEqual({ kind: 'swallow' });
    expect(g(key('Z', { ctrl: true, shift: true }), { zone: 'page' })).toEqual({ kind: 'swallow' });
    expect(g(key('m'))).toEqual({ kind: 'swallow' }); expect(g(key('Delete'))).toEqual({ kind: 'swallow' }); expect(g(key('Backspace'))).toEqual({ kind: 'swallow' });
    // Inside the timeline the timeline handler swallows; the global one stays out (never both).
    expect(g(key('m'), { zone: 'timeline', handler: 'timeline' })).toEqual({ kind: 'swallow' }); expect(g(key('m'), { zone: 'timeline', handler: 'global' })).toBeNull();
    expect(g(key('Delete'), { zone: 'timeline', handler: 'timeline', selectedItems: 2 })).toEqual({ kind: 'swallow' });
  });
  it('left and right still step one frame, even with a selection (no nudge)', () => {
    expect(g(key('ArrowRight'), { selectedItems: 3 })).toEqual({ kind: 'stepFrame', direction: 1 }); expect(g(key('ArrowLeft'), { selectedItems: 3 })).toEqual({ kind: 'stepFrame', direction: -1 });
  });
  it('focus still gates the layer: typing and controls (other than Escape) do nothing', () => {
    expect(g(key('c', ctrl), { zone: 'typing' })).toBeNull(); expect(g(key('ArrowRight'), { zone: 'control' })).toBeNull(); expect(g(key('m'), { zone: 'outside' })).toBeNull();
  });
});

describe('E5 timeline-locked (blocking) layer (part 2 §36; trigger T18/T20)', () => {
  const l = (k: Key, extra: Partial<KeyContext> = {}) => route(k, ctx({ ...extra, modes: { timelineLocked: true } }));
  it('allows only Space and left/right', () => {
    expect(l(key(' '))).toEqual({ kind: 'togglePlayback' });
    expect(l(key('ArrowRight'), { selectedItems: 2 })).toEqual({ kind: 'stepFrame', direction: 1 }); expect(l(key('ArrowLeft'))).toEqual({ kind: 'stepFrame', direction: -1 });
    for (const k of [key('m'), key('M', shift), key('Delete'), key('Backspace'), key('b', ctrl), key('d', ctrl), key('z', ctrl), key('c', ctrl), key('v', ctrl), key('+'), key('='), key('-'), key('?'), key('q'), key('Home'), key('ArrowUp'), key('ArrowDown'), key(' ', ctrl), key('P', { ctrl: true, shift: true })])
      expect(l(k, { zone: 'page', selectedItems: 1 }), JSON.stringify(k)).toEqual({ kind: 'swallow' });
    expect(l(key('Escape'))).toBeNull();
  });
  it('is not applied when focus is typing, a control or a dialog', () => {
    for (const zone of ['typing', 'control', 'outside'] as Zone[]) expect(l(key(' '), { zone })).toBeNull();
  });
  it('inside the timeline only the timeline handler can swallow root keys; Space/arrows belong to the global handler', () => {
    expect(l(key('Delete'), { zone: 'timeline', handler: 'timeline' })).toEqual({ kind: 'swallow' }); expect(l(key('Delete'), { zone: 'timeline', handler: 'global' })).toBeNull();
    expect(l(key(' '), { zone: 'timeline', handler: 'timeline' })).toBeNull(); expect(l(key(' '), { zone: 'timeline', handler: 'global' })).toEqual({ kind: 'togglePlayback' });
  });
});

describe('layer order: graph editor, group selection, smart mask, locked', () => {
  it('graph editor open switches the handler off (after the group-selection Escape)', () => {
    for (const k of [key(' '), key('ArrowRight'), key('m'), key('Delete'), key('b', ctrl), key('+')]) expect(route(k, ctx({ modes: { graphEditorOpen: true }, selectedItems: 1, keyframeSelected: true })), k.key).toBeNull();
    expect(route(key('Escape'), ctx({ modes: { graphEditorOpen: true, groupSelection: true } }))).toEqual({ kind: 'exitGroupSelection' });
  });
  it('smart-mask seam swallows Space, Delete, Backspace and the zoom keys; the rest follows the normal map', () => {
    const s = (k: Key) => route(k, ctx({ modes: { smartMask: true } }));
    for (const k of [key(' '), key('Delete'), key('Backspace'), key('+'), key('='), key('-'), key('_')]) expect(s(k), k.key).toEqual({ kind: 'swallow' });
    expect(s(key('ArrowRight'))).toEqual({ kind: 'stepFrame', direction: 1 }); expect(s(key('?'))).toEqual({ kind: 'shortcuts' });
  });
});

describe('H4 shortcut list', () => {
  it('lists every key of the normal map', () => {
    const keys = SHORTCUTS.map(([k]) => k).join(' | ');
    for (const part of ['Space', '← / →', 'Ctrl/Cmd+Z', 'Ctrl/Cmd+C', 'Ctrl/Cmd+V', 'Ctrl/Cmd+D', 'Ctrl/Cmd+B', 'Delete / Backspace', 'M', 'Shift+M', 'Ctrl/Cmd+Shift+M', '+ / =', 'Ctrl+Shift+P', '?', 'Alt+N']) expect(keys, part).toContain(part);
    expect(new Set(SHORTCUTS.map(([k]) => k)).size).toBe(SHORTCUTS.length);
  });
});
