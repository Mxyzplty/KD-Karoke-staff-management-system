// SPDX-License-Identifier: AGPL-3.0-only
// Editor view state: playhead, zoom/scroll, tool mode, selection, clipboard, panels, modes and the per-browser toggles.
// None of this is project content: changing it writes no document, no undo entry and no save (part 3 §45.3, W3-RT-17).
import { create } from 'zustand';
import type { RecordData } from '../store/model';
import type { KeyframeRef } from '../timeline/properties';
import { DEFAULT_ZOOM } from './geometry';

export type Tool = 'text' | 'motion' | 'shapes' | 'layouts' | 'captions' | 'effects' | 'presets' | 'videos' | 'photos' | 'sounds' | 'voiceover';
/** The 11-tool rail in Xapp's order (inventory §2, part 3 §46.1), with our own labels. */
export const TOOLS: { id: Tool; label: string; owner: string }[] = [
  { id: 'text', label: 'Text', owner: 'T05' }, { id: 'motion', label: 'Motion graphics', owner: 'T08' }, { id: 'shapes', label: 'Shapes', owner: 'T06' },
  { id: 'layouts', label: 'Layouts', owner: 'T07' }, { id: 'captions', label: 'Captions', owner: 'T09' }, { id: 'effects', label: 'Effects', owner: 'T10' },
  { id: 'presets', label: 'Style presets', owner: 'T22' }, { id: 'videos', label: 'Videos', owner: 'T14' }, { id: 'photos', label: 'Photos', owner: 'T14' },
  { id: 'sounds', label: 'Sounds', owner: 'T14' }, { id: 'voiceover', label: 'Voice-over', owner: 'T13' },
];
export type Quality = 'full' | 'half' | 'quarter';
export type TimelineUi = { snapping: boolean; markersVisible: boolean; waveforms: boolean };
export const TIMELINE_UI_KEY = 'cutframe:timeline-ui', PREVIEW_QUALITY_KEY = 'cutframe:preview-quality';
/** Snapping, marker visibility and waveform lanes: per browser, all three default on (findings §23). */
export function readTimelineUi(): TimelineUi {
  const defaults = { snapping: true, markersVisible: true, waveforms: true };
  try { const saved = JSON.parse(localStorage.getItem(TIMELINE_UI_KEY) ?? '{}'); return { ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in defaults && typeof v === 'boolean')) }; } catch { return defaults; }
}
export function readQuality(): Quality { try { const q = localStorage.getItem(PREVIEW_QUALITY_KEY); return q === 'half' || q === 'quarter' ? q : 'full'; } catch { return 'full'; } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable: the toggle still works for this page */ } };

export type ViewState = {
  playheadMs: number; zoom: number; scroll: number; laneWidth: number; fitted: boolean;
  toolMode: 'select' | 'ripple' | 'slip'; selection: string[]; markerId: string | null; keyframeSelected: boolean; clipboard: RecordData[];
  /** T04 graph editor: the item and property it shows (null key: the first keyframed one), and the selected keyframe. */
  graph: { itemId: string; key: string | null } | null; keyframe: KeyframeRef | null;
  /** T04 eye icons (part 3 §46.10, W3-ED-11; changes no value): `${itemId}:${key}` whose diamonds the clip hides;
   *  `${itemId}:timeRemap` = the Time Remap switch's eye off (§46.11). */
  keyframesHidden: string[];
  groupSelection: { origin: string; checked: string[] } | null; collapsedGroups: string[];
  performance: boolean; shortcuts: boolean;
  /** Mode seams owned by later tickets: graph editor (T04), smart mask (T12), timeline lock while an agent works (T18/T20). */
  modes: { graphEditorOpen: boolean; smartMask: boolean; timelineLocked: boolean };
  ui: TimelineUi; quality: Quality;
  left: 'footage' | 'ai'; footageTab: 'uploads' | 'reference'; right: { kind: 'tool'; tool: Tool } | { kind: 'inspector' } | { kind: 'none' }; inspectorTab: 'properties' | 'effects';
  drawer: string | null;
};
const initial = (): ViewState => ({
  playheadMs: 0, zoom: DEFAULT_ZOOM, scroll: 0, laneWidth: 0, fitted: false, toolMode: 'select', selection: [], markerId: null, keyframeSelected: false, clipboard: [], graph: null, keyframe: null, keyframesHidden: [],
  groupSelection: null, collapsedGroups: [], performance: false, shortcuts: false, modes: { graphEditorOpen: false, smartMask: false, timelineLocked: false },
  ui: readTimelineUi(), quality: readQuality(), left: 'footage', footageTab: 'uploads', right: { kind: 'none' }, inspectorTab: 'properties', drawer: null,
});
export const useView = create<ViewState>(() => initial());
export const view = () => useView.getState();
export const setView = (patch: Partial<ViewState> | ((s: ViewState) => Partial<ViewState>)) => useView.setState(patch);
/** A project opens with fresh view state; the per-browser toggles are re-read. */
export const resetView = () => useView.setState(initial(), true);
export function setUi(patch: Partial<TimelineUi>) { const ui = { ...view().ui, ...patch }; write(TIMELINE_UI_KEY, JSON.stringify(ui)); setView({ ui }); }
export function setQuality(quality: Quality) { write(PREVIEW_QUALITY_KEY, quality); setView({ quality }); }
/** Selecting an item shows Properties/Effects in the inspector area (part 3 §46.1). */
export function select(ids: string[]) { setView(s => ({ selection: ids, markerId: null, right: ids.length ? { kind: 'inspector' } : s.right.kind === 'inspector' ? { kind: 'none' } : s.right })); }
/** The graph editor (part 3 §46.10): open on an item; closing clears the keyframe selection (§45.5 Delete rule). */
export const openGraph = (itemId: string, key: string | null = null) => setView(s => ({ graph: { itemId, key }, keyframe: null, keyframeSelected: false, modes: { ...s.modes, graphEditorOpen: true } }));
export const closeGraph = () => setView(s => ({ graph: null, keyframe: null, keyframeSelected: false, modes: { ...s.modes, graphEditorOpen: false } }));
export const selectKeyframe = (keyframe: KeyframeRef | null) => setView({ keyframe, keyframeSelected: !!keyframe });
export const toggleKeyframesShown = (itemId: string, key: string) => setView(s => {
  const id = `${itemId}:${key}`;
  return { keyframesHidden: s.keyframesHidden.includes(id) ? s.keyframesHidden.filter(k => k !== id) : [...s.keyframesHidden, id] };
});
/** Tool modes select / ripple / slip: pressing the active one returns to select (part 3 §45.4). */
export const toggleToolMode = (mode: 'ripple' | 'slip') => setView(s => ({ toolMode: s.toolMode === mode ? 'select' : mode }));
