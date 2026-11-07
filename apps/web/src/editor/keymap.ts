// SPDX-License-Identifier: AGPL-3.0-only
// Editor keyboard routing (inventory §15; findings §15; part 2 §36; part 3 §46.17). Pure: one function decides, for one
// key press, which handler acts and what it does. Layers in order: typing → ignored; focus outside the page body, the
// timeline or the preview (a focused button, menu, dialog…) → no effect; graph editor open → handler off; the timeline
// root's own keys (M, Delete/Backspace, Ctrl/Cmd+C/V/Z) → the timeline handler only (never both); group-selection mode;
// smart-mask mode; timeline-locked (blocking) mode; then the normal map.

export type Zone = 'typing' | 'control' | 'page' | 'timeline' | 'preview' | 'outside';
export type Key = { key: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean };
export type Modes = { graphEditorOpen: boolean; smartMask: boolean; timelineLocked: boolean; groupSelection: boolean };
export type KeyContext = { zone: Zone; handler: 'global' | 'timeline'; modes: Modes; selectedItems: number; markerSelected: boolean; keyframeSelected: boolean; ripple: boolean;
  /** T12 (part 2 §36): exactly one video or image is selected, so M enters mask edit; `maskMarker` = parity mode, M also adds the marker. */
  maskTarget?: boolean; maskMarker?: boolean };
export type Action =
  | { kind: 'stepFrame'; direction: 1 | -1 } | { kind: 'zoom'; direction: 'in' | 'out' } | { kind: 'toggleMarkers' } | { kind: 'togglePerformance' }
  | { kind: 'exitGroupSelection' } | { kind: 'copy' } | { kind: 'shortcuts' }
  | { kind: 'togglePlayback' } | { kind: 'undo' } | { kind: 'redo' } | { kind: 'paste' } | { kind: 'duplicate' } | { kind: 'split' }
  | { kind: 'nudge'; dx: number; dy: number } | { kind: 'deleteKeyframe' } | { kind: 'deleteMarker' } | { kind: 'deleteItems'; ripple: boolean }
  | { kind: 'addMarker' } | { kind: 'clearMarkers' } | { kind: 'enterMask'; marker: boolean }
  | { kind: 'swallow' };
/** null = this handler does not act (the browser default stays, and the other handler may act). */
export type Route = Action | null;

const TYPING_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week', '']);
const CONTROL_ROLES = new Set(['button', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'tab', 'slider', 'switch', 'checkbox', 'radio', 'link', 'spinbutton', 'combobox']);
/** Where focus is, from the event target (DOM-free shape so tests can describe it). */
/** overlay: the element is inside a dialog, popover or menu (those own their keys, Escape included). */
export type FocusTarget = { tag: string; type?: string; role?: string | null; editable?: boolean; zone?: 'timeline' | 'preview' | 'page' | null; overlay?: boolean };
export function focusZone(target: FocusTarget | null): Zone {
  if (!target) return 'page';
  const tag = target.tag.toLowerCase();
  if (tag === 'textarea' || target.editable || (tag === 'input' && TYPING_INPUTS.has((target.type ?? '').toLowerCase())) || tag === 'select') return 'typing';
  if (target.overlay) return 'outside';
  if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'input' || (target.role && CONTROL_ROLES.has(target.role))) return 'control';
  if (tag === 'body' || tag === 'html') return 'page';
  return target.zone ?? 'outside';
}
const mod = (k: Key) => k.ctrl || k.meta;
const lower = (k: Key) => k.key.length === 1 ? k.key.toLowerCase() : k.key;
/** Keys the timeline root handles itself when focus is inside it (part 2 §36). */
export function isTimelineRootKey(k: Key): boolean {
  const key = lower(k);
  if (mod(k)) return !k.alt && ['c', 'v', 'z'].includes(key);
  return (key === 'm' && !k.shift && !k.alt) || key === 'Delete' || key === 'Backspace';
}
const isFrameStep = (k: Key) => k.key === 'ArrowLeft' || k.key === 'ArrowRight';
const isZoomKey = (k: Key) => !mod(k) && ['+', '=', '-', '_'].includes(k.key);

export function route(k: Key, c: KeyContext): Route {
  if (c.zone === 'typing') return null;
  // Escape leaves group-selection mode from the page, timeline, preview or a focused control (its checkboxes are controls),
  // but not from inside a dialog or menu, which Escape closes first.
  if (c.modes.groupSelection && k.key === 'Escape' && c.handler === 'global' && c.zone !== 'outside') return { kind: 'exitGroupSelection' };
  if (c.zone === 'control' || c.zone === 'outside') return null;
  if (c.modes.graphEditorOpen) return null;
  if (isTimelineRootKey(k) && (c.zone === 'timeline') !== (c.handler === 'timeline')) return null;
  if (c.handler === 'timeline' && !isTimelineRootKey(k)) return null;
  const key = lower(k);
  if (c.modes.groupSelection) {
    if (isFrameStep(k)) return { kind: 'stepFrame', direction: k.key === 'ArrowRight' ? 1 : -1 };
    if (mod(k) && ['c', 'v', 'd', 'z', 'y'].includes(key)) return { kind: 'swallow' };
    if (!mod(k) && key === 'm' && !k.shift) return { kind: 'swallow' };
    if (key === 'Delete' || key === 'Backspace') return { kind: 'swallow' };
  }
  if (c.modes.smartMask && (k.key === ' ' || key === 'Delete' || key === 'Backspace' || isZoomKey(k))) return { kind: 'swallow' };
  if (c.modes.timelineLocked) {
    if (k.key === ' ' && !mod(k)) return { kind: 'togglePlayback' };
    if (isFrameStep(k)) return { kind: 'stepFrame', direction: k.key === 'ArrowRight' ? 1 : -1 };
    return k.key === 'Escape' ? null : { kind: 'swallow' };
  }
  return normal(k, c);
}
function normal(k: Key, c: KeyContext): Route {
  const key = lower(k);
  // Arrows first: Shift, Ctrl/Cmd or Alt + ← / → still step one frame; with a selection they nudge (Shift = 20 px).
  if (k.key.startsWith('Arrow')) {
    if (c.selectedItems > 0) {
      const step = k.shift ? 20 : 5, dx = k.key === 'ArrowLeft' ? -step : k.key === 'ArrowRight' ? step : 0, dy = k.key === 'ArrowUp' ? -step : k.key === 'ArrowDown' ? step : 0;
      return { kind: 'nudge', dx, dy };
    }
    return isFrameStep(k) ? { kind: 'stepFrame', direction: k.key === 'ArrowRight' ? 1 : -1 } : null;
  }
  if (mod(k) && !k.alt) {
    if (key === 'z') return k.shift ? { kind: 'redo' } : { kind: 'undo' };
    if (key === 'y' && !k.shift) return { kind: 'redo' };
    if (key === 'c' && !k.shift) return { kind: 'copy' };
    if (key === 'v' && !k.shift) return { kind: 'paste' };
    if (key === 'd' && !k.shift) return { kind: 'duplicate' };
    if (key === 'b' && !k.shift) return { kind: 'split' };
    if (key === 'm' && k.shift) return { kind: 'clearMarkers' };
    if (key === 'p' && k.shift) return { kind: 'togglePerformance' };
    return null;
  }
  if (mod(k)) return null;
  if (k.key === ' ') return { kind: 'togglePlayback' };
  if (key === 'Delete' || key === 'Backspace') {
    if (c.keyframeSelected) return { kind: 'deleteKeyframe' };
    if (c.markerSelected) return { kind: 'deleteMarker' };
    return c.selectedItems > 0 ? { kind: 'deleteItems', ripple: c.ripple } : null;
  }
  if (key === 'm' && !k.alt) return k.shift ? { kind: 'toggleMarkers' } : c.maskTarget ? { kind: 'enterMask', marker: !!c.maskMarker } : { kind: 'addMarker' };
  if (k.key === '+' || k.key === '=') return { kind: 'zoom', direction: 'in' };
  if (k.key === '-' || k.key === '_') return { kind: 'zoom', direction: 'out' };
  if (k.key === '?') return { kind: 'shortcuts' };
  return null; // Home, End, Escape (no deselect) and everything else: no effect.
}

/** Our shortcut overlay (a documented improvement: Xapp has none). */
export const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], ['← / →', 'Step one frame (no selection)'], ['Arrow keys', 'Nudge the selection 5 px (Shift: 20 px)'],
  ['Ctrl/Cmd+Z', 'Undo'], ['Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y', 'Redo'], ['Ctrl/Cmd+C', 'Copy'], ['Ctrl/Cmd+V', 'Paste at the playhead'],
  ['Ctrl/Cmd+D', 'Duplicate'], ['Ctrl/Cmd+B', 'Split at the playhead'], ['Delete / Backspace', 'Delete the selected keyframe, else marker, else items'],
  ['M', 'Add a marker; with one video or image selected, edit its masks'], ['Shift+M', 'Show or hide markers'], ['Ctrl/Cmd+Shift+M', 'Clear all markers'], ['+ / =', 'Zoom in'], ['−', 'Zoom out'],
  ['Ctrl+Shift+P', 'Performance overlay'], ['?', 'This list'], ['Alt+N', 'Focus notifications'],
];
