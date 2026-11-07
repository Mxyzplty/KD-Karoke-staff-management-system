// SPDX-License-Identifier: AGPL-3.0-only
// Applies routed keyboard actions (keymap.route) and the toolbar actions they share. View actions change view state only;
// edits go to their owner through the intent seam.
import type { ProjectDocument } from '../store/model';
import { activeRuntime } from '../timeline/runtime';
import { notify } from '../ui';
import { dispatch } from './commands';
import { frameAt, stepFrame, zoomAround } from './geometry';
import { focusZone, route } from './keymap';
import type { Action, FocusTarget, Zone } from './keymap';
import { enterMaskEdit } from './mask-state';
import { setUi, setView, view } from './view';

export function splitSelection() { const s = view(); if (s.selection.length) dispatch({ type: 'splitItems', itemIds: s.selection, atMs: s.playheadMs }); }
export function duplicateSelection() { const s = view(); if (s.selection.length) dispatch({ type: 'duplicateItems', itemIds: s.selection }); }
export function deleteSelection() { const s = view(); if (s.selection.length) dispatch({ type: 'deleteItems', itemIds: s.selection, ripple: s.toolMode === 'ripple' }); }
export function copySelection(doc: ProjectDocument) { const s = view(); if (s.selection.length) setView({ clipboard: structuredClone(doc.items.filter(i => s.selection.includes(i.id))) }); }
export function zoomBy(direction: 'in' | 'out', doc: ProjectDocument) { const s = view(); setView(zoomAround(s, direction, s.playheadMs, s.laneWidth, doc.duration)); }
/** Ctrl/Cmd+Shift+M: "Clear all N markers?" then one T03 command. */
export function clearMarkers(doc: ProjectDocument) {
  if (!doc.markers.length) { notify('There are no markers to clear.'); return; }
  if (confirm(`Clear all ${doc.markers.length} markers?`)) dispatch({ type: 'clearMarkers', count: doc.markers.length });
}
export function perform(action: Action, doc: ProjectDocument) {
  const s = view();
  switch (action.kind) {
    case 'stepFrame': setView({ playheadMs: stepFrame(s.playheadMs, action.direction, doc.fps, doc.duration) }); break;
    case 'zoom': zoomBy(action.direction, doc); break;
    case 'toggleMarkers': setUi({ markersVisible: !s.ui.markersVisible }); break;
    case 'togglePerformance': setView({ performance: !s.performance }); break;
    case 'exitGroupSelection': setView({ groupSelection: null }); break;
    case 'copy': copySelection(doc); break;
    case 'shortcuts': setView({ shortcuts: true }); break;
    case 'togglePlayback': dispatch({ type: 'togglePlayback' }); break;
    case 'undo': dispatch({ type: 'undo' }); break;
    case 'redo': dispatch({ type: 'redo' }); break;
    case 'paste': if (s.clipboard.length) dispatch({ type: 'pasteItems', items: s.clipboard, atMs: s.playheadMs }); break;
    case 'duplicate': duplicateSelection(); break;
    case 'split': splitSelection(); break;
    case 'nudge': dispatch({ type: 'nudgeItems', itemIds: s.selection, dx: action.dx, dy: action.dy }); break;
    case 'deleteKeyframe': dispatch({ type: 'deleteKeyframe' }); break;
    case 'deleteMarker': if (s.markerId) dispatch({ type: 'removeMarker', markerId: s.markerId }); break;
    case 'deleteItems': deleteSelection(); break;
    case 'addMarker': dispatch({ type: 'addMarker', timeMs: frameAt(s.playheadMs, doc.fps) }); break;
    case 'enterMask':
      enterMaskEdit(doc, s.selection[0]);
      if (action.marker) dispatch({ type: 'addMarker', timeMs: frameAt(s.playheadMs, doc.fps) });
      break;
    case 'clearMarkers': clearMarkers(doc); break;
    case 'swallow': break;
  }
}
/** Describes the focused element for keymap.focusZone. */
export function describeTarget(target: EventTarget | null): FocusTarget | null {
  if (!(target instanceof Element)) return null;
  const zone = target.closest<HTMLElement>('[data-zone]')?.dataset.zone as FocusTarget['zone'] | undefined;
  return { tag: target.tagName, type: (target as HTMLInputElement).type, role: target.getAttribute('role'), editable: (target as HTMLElement).isContentEditable, zone: zone ?? null,
    overlay: !!target.closest('dialog, [role="dialog"], [role="menu"]') };
}
export const zoneOf = (target: EventTarget | null): Zone => focusZone(describeTarget(target));
/** One key press through one handler: the window ('global') or the timeline root ('timeline'). */
export function handleKey(e: KeyboardEvent, handler: 'global' | 'timeline', doc: ProjectDocument): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const s = view(), selected = s.selection.length === 1 ? doc.items.find(i => i.id === s.selection[0]) : undefined;
  const action = route({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }, {
    zone: zoneOf(e.target), handler, modes: { ...s.modes, groupSelection: !!s.groupSelection }, selectedItems: s.selection.length,
    markerSelected: !!s.markerId, keyframeSelected: s.keyframeSelected, ripple: s.toolMode === 'ripple',
    maskTarget: selected?.type === 'video' || selected?.type === 'image', maskMarker: activeRuntime?.bus.options.maskMarker === 'both',
  });
  if (!action) return false;
  e.preventDefault(); perform(action, doc); return true;
}
