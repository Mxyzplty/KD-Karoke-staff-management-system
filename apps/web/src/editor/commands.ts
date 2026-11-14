// SPDX-License-Identifier: AGPL-3.0-only
// Command-intent seam. Every editor control dispatches a typed intent here. A later ticket installs a handler for the
// intents it owns (T03 the command bus: edits, tracks, groups, markers, placement; T04 properties; T15 playback; T17
// checkpoints; …). Until its owner is installed, an intent is refused visibly ("… is not yet implemented (Txx).") and
// nothing in the project changes. A stub never reports success.
import type { RecordData } from '../store/model';
import type { KeyframePatch, KeyframeRef } from '../timeline/properties';
import type { GraphicPreset } from '../mg/presets';
import type { StylePreset } from '../presets/model';
import type { PathPoint, ShapePath } from '../timeline/shapes';
import type { LayoutOp, LayoutType } from '../timeline/layouts';
import type { MaskOp } from '../masks/tools';
import type { Patch as TransitionPatch } from '../timeline/transitions';
import type { SourceButton, SourceData } from '../captions/generation';
import { notify } from '../ui';
import type { DragPayload } from './dnd';
import type { PreviewEdit } from './selection-box';

export type TrackFlag = 'hidden' | 'muted' | 'solo' | 'locked';
export type Intent =
  | { type: 'undo' } | { type: 'redo' }
  | { type: 'deleteItems'; itemIds: string[]; ripple: boolean }
  | { type: 'splitItems'; itemIds: string[]; atMs: number }
  | { type: 'duplicateItems'; itemIds: string[] }
  | { type: 'nudgeItems'; itemIds: string[]; dx: number; dy: number }
  | { type: 'pasteItems'; items: RecordData[]; atMs: number }
  /** trackId: the lane released over when it differs from the clip's own; newTrack: released below the tracks ("Move to new track");
   *  pointer: where the pointer was released and how many ms 12 screen px span (the ripple-reorder slot rule). */
  | { type: 'moveItems'; itemIds: string[]; deltaMs: number; trackId: string | null; newTrack: boolean; ripple: boolean; pointer?: { ms: number; windowMs: number } }
  | { type: 'trimItem'; itemId: string; edge: 'start' | 'end'; deltaMs: number; ripple: boolean }
  | { type: 'slipItem'; itemId: string; deltaMs: number }
  | { type: 'moveItemOutOfGroup'; itemId: string }
  | { type: 'placeAssets'; assetIds: string[]; name: string }
  | { type: 'drop'; payload: DragPayload; trackId: string | null; timeMs: number; below: boolean }
  | { type: 'addMarker'; timeMs: number } | { type: 'removeMarker'; markerId: string } | { type: 'clearMarkers'; count: number }
  | { type: 'deleteTrack'; trackId: string } | { type: 'renameTrack'; trackId: string; name: string }
  | { type: 'setTrackFlag'; trackId: string; flag: TrackFlag; value: boolean } | { type: 'setTrackVolume'; trackId: string; volume: number }
  | { type: 'resizeTrack'; trackId: string; height: number } | { type: 'moveTrackLayer'; trackId: string; beforeTrackId: string | null }
  | { type: 'moveTrackOutOfGroup'; trackId: string }
  | { type: 'groupTracks'; trackIds: string[]; name: string }
  | { type: 'setGroupFlag'; groupId: string; flag: 'hidden' | 'locked'; value: boolean }
  | { type: 'reorderGroup'; groupId: string; direction: 'up' | 'down' } | { type: 'ungroupTracks'; groupId: string } | { type: 'deleteGroup'; groupId: string }
  | { type: 'resizeCanvas'; aspectRatio: '16:9' | '9:16' | '1:1' }
  | { type: 'togglePlayback' }
  /** T15: the inspector's Use Proxy switch (details.useProxy; the setUseProxy tool runs the same edit). */
  | { type: 'setUseProxy'; itemId: string; on: boolean }
  /** T04: the Speed slider / typed speed (ripple follows the tool mode); the Time Remap switch; keyframe add / edit / delete
   *  (target: the keyframe selected in the graph editor; none → nothing to delete). */
  | { type: 'changeSpeed'; itemId: string; rate: number; ripple: boolean }
  | { type: 'toggleTimeRemap'; itemId: string; on: boolean }
  | { type: 'addKeyframe'; itemId: string; key: string; atMs: number; effect?: string }
  /** T10: the Effects tab (part 3 §46.9), addressed by stored effect instance id: picker add, card switch / trash / drag /
   *  values / reset arrow; the Color card's block (part 4 §49.1 [C]). Effect keyframes use the keyframe intents + `effect`. */
  | { type: 'addEffect'; itemIds: string[]; effectId: string }
  | { type: 'toggleEffect'; itemId: string; instanceId: string; enabled: boolean }
  | { type: 'removeEffect'; itemId: string; instanceId: string }
  | { type: 'moveEffect'; itemId: string; instanceId: string; to: number }
  | { type: 'effectParams'; itemId: string; instanceId: string; values: RecordData }
  | { type: 'resetEffect'; itemId: string; instanceId: string }
  | { type: 'colourBlock'; itemIds: string[]; effectId: 'color-wheels' | 'curves' | 'lut'; values: RecordData }
  | { type: 'bypassGrade'; itemIds: string[]; enabled: boolean }
  | { type: 'resetGrade'; itemIds: string[] }
  | { type: 'editKeyframe'; target: KeyframeRef; patch: KeyframePatch }
  | { type: 'deleteKeyframe'; target?: KeyframeRef }
  | { type: 'saveCheckpoint'; name?: string } | { type: 'restoreCheckpoint'; checkpointId: string }
  | { type: 'deleteCheckpoint'; checkpointId: string } | { type: 'renameCheckpoint'; checkpointId: string; name: string }
  | { type: 'editProperty'; itemIds: string[]; owner: string; label: string; key: string; value: unknown }
  /** T08: the Motion Graphics panel's Add Blank Motion Graphic (start / end in timeline ms). */
  | { type: 'addBlankMotionGraphic'; startMs: number; endMs: number }
  /** T08: a My Presets entry (mg/presets.ts), placed at 0 s. */
  | { type: 'addGraphicPreset'; preset: GraphicPreset }
  /** T22: a style preset or a built-in motion-graphic preset (presets/apply.ts), placed at 0 s. */
  | { type: 'applyStylePreset'; preset: StylePreset | GraphicPreset }
  /** T08: Fix automatically saves the repaired code (mg/repair.ts). */
  | { type: 'repairMotionGraphic'; itemId: string; code: string }
  /** T08: the inspector's Fields section sets one editable field (details.fieldValues[name], mg/fields.tsx). */
  | { type: 'editGraphicField'; itemId: string; name: string; value: string | number | boolean | string[] }
  /** T06: a shape drawn on the stage (Shapes panel Draw, Polygon, Pen Tool; path in canvas px); a pen edit of a shape's path
   *  (points item-local) or point delete; the inspector's Add path keyframe. Each at the playhead. */
  | { type: 'drawShape'; shapeType: string; path: ShapePath; playheadMs: number; style: Record<string, unknown> }
  | { type: 'editShapePath'; itemId: string; points: PathPoint[]; playheadMs: number }
  | { type: 'removeShapePoint'; itemId: string; index: number; playheadMs: number }
  | { type: 'addPathKeyframe'; itemId: string; playheadMs: number }
  /** T05: the Text panel's Add text preset (findings part 2 §40; W3-ED-22); several text keys as one edit (a preset tile). */
  | { type: 'addTextPreset' }
  | { type: 'editTextProperties'; itemIds: string[]; properties: RecordData; refit?: true }
  /** T09: the Captions panel's Generate / Regenerate. The resolved transcript map travels with the intent (the handler
   *  cannot await); the handler builds the sources and auto-creates the caption track(s) (generate()'s pickTrack / speakerTrack). */
  | { type: 'generateCaptions'; button: SourceButton; sourceItems?: string[]; range: { startMs: number; endMs: number } | null; split: boolean; templateId?: string; maxWords?: number; maxCharacters?: number; fontSize?: number; borderWidth?: number; fontFamily?: string; fontWeight?: string; fontStyle?: string; color?: string; backgroundColor?: string; textDecoration?: string; borderColor?: string; boxShadow?: RecordData; breakOnPunctuation: boolean; breakOnConjunctions: boolean; reset: boolean; data: Record<string, SourceData> }
  /** T09: the caption inspector's Transform (scale / rotation / position). A caption's editProperties stays style + text
   *  (editCaptionProperties), so geometry is a separate UI-only command the agent path does not reach. */
  | { type: 'editCaptionTransform'; itemIds: string[]; properties: RecordData }
  /** T07: a Layouts panel card (a 10 s layout at 0 s on a new overlay track); one cell, style or transform edit of a layout
   *  (the inspector's Cells / Style / Transform, the empty-row picker, a footage drop on a cell in the preview). */
  | { type: 'addLayout'; layoutType: LayoutType }
  | { type: 'layoutEdit'; itemId: string; op: LayoutOp }
  // T12 (findings §20 W3-RT-05, part 3 §46.13): every mask edit from the inspector or the stage is one "Edit items" entry.
  | { type: 'maskEdit'; itemId: string; op: MaskOp }
  /** T11: the timeline's Add transition diamond (a cut's two clips); a popover pick or an edge drag; the popover's trash. */
  | { type: 'addTransition'; fromId: string; toId: string }
  | { type: 'editTransition'; transitionId: string; patch: TransitionPatch }
  | { type: 'removeTransition'; transitionId: string }
  /** T13: a voice-over take (findings §30), stored and attached as asset `assetId` (`agentId` audio_n), placed at the
   *  recorded start `atMs` for the recorded `durationMs`. */
  | { type: 'addVoiceover'; assetId: string; agentId: string; name: string; atMs: number; durationMs: number }
  /** T13: the inspector's fade shortcut (two volume keyframes, audio/edits.ts) and per-clip Keep pitch switch. */
  | { type: 'addFade'; itemId: string; edge: 'in' | 'out' }
  | { type: 'removeBackground'; itemId: string }
  | { type: 'setKeepPitch'; itemId: string; on: boolean }
  /** T26: a corner, rotation or move drag of the preview selection box, released (selection-box.ts applyPreviewEdit). Not an agent tool. */
  | { type: 'transformOnPreview'; edits: PreviewEdit[]; atMs: number }
  | { type: 'feature'; owner: string; label: string };

/** Owner ticket and visible name of each intent type (labels of T03's undo entries where one exists, part 3 §45.1). */
export const INTENTS: Record<Exclude<Intent['type'], 'editProperty' | 'feature' | 'placeAssets' | 'drop'>, { owner: string; label: string }> = {
  undo: { owner: 'T03', label: 'Undo' }, redo: { owner: 'T03', label: 'Redo' },
  deleteItems: { owner: 'T03', label: 'Delete items' }, splitItems: { owner: 'T03', label: 'Split items' },
  duplicateItems: { owner: 'T03', label: 'Duplicate items' }, nudgeItems: { owner: 'T03', label: 'Nudging items' },
  pasteItems: { owner: 'T03', label: 'Paste at playhead' }, moveItems: { owner: 'T03', label: 'Move items' },
  trimItem: { owner: 'T03', label: 'Trimming' }, slipItem: { owner: 'T03', label: 'Slip item' },
  moveItemOutOfGroup: { owner: 'T03', label: 'Move item out of group' },
  addMarker: { owner: 'T03', label: 'Add marker' }, removeMarker: { owner: 'T03', label: 'Remove marker' }, clearMarkers: { owner: 'T03', label: 'Clear markers' },
  deleteTrack: { owner: 'T03', label: 'Delete track' }, renameTrack: { owner: 'T03', label: 'Rename track' },
  setTrackFlag: { owner: 'T03', label: 'Set track flag' }, setTrackVolume: { owner: 'T03', label: 'Set track volume' },
  resizeTrack: { owner: 'T03', label: 'Resize track' }, moveTrackLayer: { owner: 'T03', label: 'Move track layer' },
  moveTrackOutOfGroup: { owner: 'T03', label: 'Move track out of group' }, groupTracks: { owner: 'T03', label: 'Group tracks' },
  setGroupFlag: { owner: 'T03', label: 'Set group flag' }, reorderGroup: { owner: 'T03', label: 'Reorder group' },
  ungroupTracks: { owner: 'T03', label: 'Ungroup tracks' }, deleteGroup: { owner: 'T03', label: 'Delete group' },
  resizeCanvas: { owner: 'T03', label: 'Resize canvas' },
  togglePlayback: { owner: 'T15', label: 'Playback' }, setUseProxy: { owner: 'T15', label: 'Use Proxy' }, deleteKeyframe: { owner: 'T04', label: 'Deleting a keyframe' },
  changeSpeed: { owner: 'T04', label: 'Change speed' }, toggleTimeRemap: { owner: 'T04', label: 'Time remap' },
  addKeyframe: { owner: 'T04', label: 'Adding a keyframe' }, editKeyframe: { owner: 'T04', label: 'Editing a keyframe' },
  addEffect: { owner: 'T10', label: 'Adding an effect' }, toggleEffect: { owner: 'T10', label: 'Toggling an effect' },
  removeEffect: { owner: 'T10', label: 'Removing an effect' }, moveEffect: { owner: 'T10', label: 'Reordering effects' },
  effectParams: { owner: 'T10', label: 'Editing an effect' }, resetEffect: { owner: 'T10', label: 'Resetting an effect' },
  colourBlock: { owner: 'T10', label: 'Color adjustments' }, bypassGrade: { owner: 'T10', label: 'Bypassing the grade' }, resetGrade: { owner: 'T10', label: 'Resetting the grade' },
  saveCheckpoint: { owner: 'T17', label: 'Saving a checkpoint' }, restoreCheckpoint: { owner: 'T17', label: 'Restoring a checkpoint' },
  deleteCheckpoint: { owner: 'T17', label: 'Deleting a checkpoint' }, renameCheckpoint: { owner: 'T17', label: 'Renaming a checkpoint' },
  addBlankMotionGraphic: { owner: 'T08', label: 'Add Blank Motion Graphic' }, addGraphicPreset: { owner: 'T08', label: 'Adding a motion-graphic preset' },
  applyStylePreset: { owner: 'T22', label: 'Applying a preset' },
  repairMotionGraphic: { owner: 'T08', label: 'Repairing a motion graphic' }, editGraphicField: { owner: 'T08', label: 'Editing a motion-graphic field' },
  drawShape: { owner: 'T06', label: 'Drawing a shape' }, editShapePath: { owner: 'T06', label: 'Editing a shape path' },
  removeShapePoint: { owner: 'T06', label: 'Removing a shape point' }, addPathKeyframe: { owner: 'T06', label: 'Adding a path keyframe' },
  addTextPreset: { owner: 'T05', label: 'Add text' }, editTextProperties: { owner: 'T05', label: 'Editing text' },
  generateCaptions: { owner: 'T09', label: 'Add captions' }, editCaptionTransform: { owner: 'T09', label: 'Edit items' },
  addLayout: { owner: 'T07', label: 'Adding a layout' }, layoutEdit: { owner: 'T07', label: 'Editing a layout' }, maskEdit: { owner: 'T12', label: 'Editing a mask' }, removeBackground: { owner: 'T12', label: 'Background removal' },
  addTransition: { owner: 'T11', label: 'Add transition' }, editTransition: { owner: 'T11', label: 'Edit transition' }, removeTransition: { owner: 'T11', label: 'Remove transition' },
  addVoiceover: { owner: 'T13', label: 'Adding a voice-over' }, addFade: { owner: 'T13', label: 'Adding a fade' },
  setKeepPitch: { owner: 'T13', label: 'Keep pitch' },
  transformOnPreview: { owner: 'T26', label: 'Edit items' },
};
export function describe(intent: Intent): { owner: string; label: string } {
  switch (intent.type) {
    case 'editProperty': case 'feature': return { owner: intent.owner, label: intent.label };
    case 'placeAssets': return { owner: 'T03', label: `Placing ${intent.name} on the timeline` };
    case 'drop': return { owner: intent.payload.kind === 'text' ? 'T05' : 'T03', label: intent.payload.kind === 'text' ? 'Dropping text on the timeline' : intent.payload.kind === 'stock' ? 'Placing stock media on the timeline' : 'Placing footage on the timeline' };
    default: return INTENTS[intent.type];
  }
}
export type Outcome = { ok: true } | { ok: false; code: 'NOT_IMPLEMENTED'; owner: string; message: string } | { ok: false; code: string; message: string };
/** Returns an outcome for intents it owns, or undefined to leave the intent to another owner. */
export type IntentHandler = (intent: Intent) => Outcome | undefined;
const handlers: IntentHandler[] = [], listeners = new Set<(intent: Intent, outcome: Outcome) => void>();
/** A later ticket installs its handler; the returned function removes it. */
export function installIntentHandler(handler: IntentHandler): () => void {
  handlers.push(handler);
  return () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1); };
}
/** Observe every dispatched intent and its outcome (journal seam; tests). */
export function subscribeIntents(listener: (intent: Intent, outcome: Outcome) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function dispatch(intent: Intent): Outcome {
  let outcome: Outcome | undefined;
  for (const handler of handlers) { outcome = handler(intent); if (outcome) break; }
  if (!outcome) {
    const { owner, label } = describe(intent), message = `${label} is not yet implemented (${owner}).`;
    outcome = { ok: false, code: 'NOT_IMPLEMENTED', owner, message }; notify(message);
  } else if (!outcome.ok) notify(`${outcome.code}: ${outcome.message}`);
  for (const listener of listeners) listener(intent, outcome);
  return outcome;
}
/** History seam: T03 replaces it; with no history nothing can be undone, so Undo/Redo stay disabled. */
export const history = { canUndo: () => false, canRedo: () => false };
