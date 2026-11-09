// SPDX-License-Identifier: AGPL-3.0-only
// The helper's own JSON Schemas for the 40 served tools (T18a ledger row 6, T21 help tools, T08, T19 D, T10 writeEffects, T06 shapes, T07 layouts, T11 applyTransition, T05 addText, T12 masks and smart masks; agent tool results §4 rule 1). Every call is
// checked here before the tab sees it; a violation answers Xapp's server shape:
// {success:false, code:"INVALID_TOOL_INPUT", error:"Invalid input for <tool>", message:"<path>: <reason>", details:{errors:[{path, code, message}]}}.
// Paths use Xapp's stored form ("$.items.0.trackId"); detail codes are the upper-cased JSON Schema keyword (MAXIMUM, MINITEMS,
// REQUIRED, TYPE, ENUM, ADDITIONALPROPERTIES, MINPROPERTIES, MINIMUM, EXCLUSIVEMINIMUM, NOT, ONEOF, ANYOF) and INVALID_COMBINATION for mutually exclusive
// fields. Objects are closed ("same strictness as the catalogue types"; stored: ADDITIONALPROPERTIES on $.items.0.trackId).
// Conditional requirements ("Y*" in the contracts) stay with the handlers, whose codes then appear (MISSING_TRACK_ID,
// INVALID_GROUP_OPERATION, ...). The T04 schemas follow the stored G-02 refusals (results §6): writeKeyframes MINPROPERTIES /
// NOT / ENUM, setTimeRemap MINITEMS / MINIMUM / ENUM + TYPE + ONEOF; handle ranges and item bounds stay with the handlers.
import Ajv from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { EASING_NAMES, SERVED_TOOLS } from '../../web/src/agent/protocol';

type Schema = Record<string, unknown>;
export type Tool = { name: string; description: string; inputSchema: Schema };
export type InputError = { path: string; code: string; message: string };

const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const secs = (description: string) => ({ type: 'number', description });
const ids = (description: string) => ({ type: 'array', items: str, minItems: 1, description });
const obj = (properties: Record<string, unknown>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const media = {
  assetId: { type: 'string', description: 'Project asset id, e.g. video_1' },
  duration: secs('Length override in seconds'), trimStart: secs('Source in-point in seconds'), trimEnd: secs('Source out-point in seconds'),
  bounds: { type: 'object', description: 'Placement box for visuals; aspect ratio is kept, media is never cropped' },
  transcriptRange: obj({ text: str, startText: str, endText: str }), scaleMode: str,
};
// T04 keyframe shapes (contracts writeKeyframes / setTimeRemap): an easing is a preset name or a 4-number bezier.
const easing = { oneOf: [{ enum: EASING_NAMES }, obj({ type: { const: 'bezier' }, points: { type: 'array', items: num, minItems: 4, maxItems: 4 } }, ['type', 'points'])],
  description: 'One of the 15 preset names, or {type: "bezier", points: [x1, y1, x2, y2]}' };
const handle = { type: 'array', items: num, description: 'Segment-normalised [x 0–1, y −100…100]' };
const entry = { ...obj({ time: secs('Timeline seconds, inside the item'), value: num, delta: num, factor: num, easing, inHandle: handle, outHandle: handle }, ['time']),
  not: { anyOf: [{ required: ['value', 'delta'] }, { required: ['value', 'factor'] }, { required: ['delta', 'factor'] }] }, description: 'At most one of value, delta, factor' };
const entries = { type: 'array', items: entry };
const ops = { ...obj({ add: entries, update: entries, replace: entries, remove: { type: 'array', items: num, description: 'Timeline seconds (100 ms tolerance)' } }), minProperties: 1 };
// editProperties keys (contracts editProperties): typed where the contract gives a type. look and textAnimation stay loose so
// their handler codes answer (TEXT_LOOKS_UNAVAILABLE, INVALID_TEXT_ANIMATION; T05); element keys T04 does not serve yet (its
// handler answers NOT_IMPLEMENTED) keep only the contract's enums and unions.
const properties = obj({
  text: str, opacity: num, scale: num, rotation: num, positionX: num, positionY: num, width: num, height: num, flipX: bool, flipY: bool, zIndex: num, blendMode: str,
  blur: num, brightness: num, borderRadius: num, borderWidth: num, borderColor: str, boxShadow: obj({ blur: num, color: str, x: num, y: num }), volume: num, playbackRate: num,
  fillColor: str, fillOpacity: num, strokeColor: str, strokeOpacity: num, strokeWidth: num,
  fontFamily: str, fontSize: { type: ['number', 'string'] }, fontWeight: { type: ['number', 'string'] }, fontStyle: { enum: ['normal', 'italic', 'oblique'] }, color: str, backgroundColor: str,
  textAlign: { enum: ['left', 'center', 'right', 'justify'] }, textDecoration: str, textTransform: { enum: ['none', 'uppercase', 'lowercase', 'capitalize'] }, lineHeight: { anyOf: [num, { const: 'normal' }] },
  letterSpacing: { type: ['number', 'string'] }, wordSpacing: { type: ['number', 'string'] }, wordWrap: { enum: ['normal', 'break-word', 'anywhere'] }, wordBreak: { enum: ['normal', 'break-all', 'keep-all', 'break-word'] },
  look: {}, textAnimation: {}, colors: {}, media: {},
});

// T07 layout presets (timeline/layouts LAYOUT_TYPES; the helper's schemas cannot import that module) and one cell fill.
const LAYOUT_TYPE_NAMES = ['split-horizontal', 'split-vertical', 'three-horizontal', 'three-vertical', 'grid-2x2', 'pip-top-right', 'pip-top-left', 'pip-bottom-right',
  'pip-bottom-left', 'feature-left', 'feature-right'];
const layoutCell = {
  assetId: { type: 'string', description: 'Project asset id (video or image)' }, fillMode: { enum: ['fill', 'fit'], description: 'fill = cover (default), fit = contain' },
  trim: { ...obj({ from: num, to: num }, ['from', 'to']), description: 'Source range in milliseconds (video cells)' },
  volume: { type: 'number', minimum: 0, maximum: 200, description: 'Cell audio level in % (100 = as recorded)' },
};

const TOOL_LIST: Tool[] = [
  // T07 (contracts addLayout, note 19: cell trim in ms, volume 0–200 %). Cell assets, trims and the asset kind are the
  // handler's (INVALID_CELL_ASSET, INVALID_TRIM_RANGE, TRIM_EXCEEDS_SOURCE).
  { name: 'addLayout', description: 'Add a multi-cell layout (split, three-way, grid, picture-in-picture or feature) on an overlay track, or insert it after an item, with cells optionally filled. Times in seconds; cell trims in milliseconds.',
    inputSchema: obj({ layoutType: { enum: LAYOUT_TYPE_NAMES }, trackId: { type: 'string', description: 'Overlay track id from context' },
      insertAfterItemId: { type: 'string', description: 'Insert after this item and push later items right; not with trackId or timelineStart' }, timelineStart: secs('Start in seconds (default 0)'),
      duration: secs('Length in seconds (default 10)'), gap: { type: 'number', description: 'Space between cells in px (default 0)' }, borderRadius: { type: 'number', description: 'Corner radius per cell in px (default 0)' },
      cells: { type: 'array', items: obj(layoutCell), description: 'Cell fills in preset cell order; an empty object or a missing entry leaves the cell empty' } }, ['layoutType']) },
  { name: 'addMedia', description: 'Place one project asset, or a back-to-back batch (items), on one existing compatible track, or insert after an item. Times in seconds.',
    inputSchema: obj({ ...media, items: { type: 'array', items: obj(media, ['assetId']) }, trackId: { type: 'string', description: 'Target track id from context' },
      insertAfterItemId: { type: 'string', description: 'Insert after this item and push later items right; not with trackId or timelineStart' }, timelineStart: secs('Start of the sequence in seconds') }) },
  // T08. code and summary are checked by the handler (MISSING_PARAM, results §2); the box is required here.
  { name: 'addMotionGraphic', description: 'Place a code-mode motion graphic (a Remotion-style React component, the code ending with `export const <Name> = …`) on an overlay track, or insert it after an item. Box in canvas px; times in seconds.',
    inputSchema: obj({ code: { type: 'string', description: 'Full component source' }, summary: { type: 'string', description: 'What the graphic shows, for humans; at most 400 characters' },
      width: num, height: num, x: num, y: num, trackId: { type: 'string', description: 'Overlay track id from context' },
      insertAfterItemId: { type: 'string', description: 'Insert after this item and push later items right; not with trackId or timelineStart' }, timelineStart: secs('Start in seconds (default 0)'),
      duration: secs('Length in seconds (default animationDuration, else 5); capped to the designed length'), animationDuration: secs('Designed length in seconds') }, ['width', 'height', 'x', 'y']) },
  // T06 (contracts addShape). Points stay loose here: their checks are the handler's (contracts "Point validation":
  // NO_SHAPE_POINTS, INVALID_POINT, INVALID_POINT_COORDINATES); value ranges too (INVALID_BOUNDS, INVALID_PROPERTY_VALUE).
  { name: 'addShape', description: 'Add a vector shape on an overlay track, or insert it after an item: a preset (shape + bounds, canvas px) or a custom bezier path (points: absolute canvas px anchors, handles as offsets from their anchor). Times in seconds.',
    inputSchema: obj({ shape: { enum: ['rectangle', 'ellipse', 'triangle', 'pentagon', 'star', 'heart'] },
      bounds: { ...obj({ width: num, height: num, x: num, y: num, cx: num, cy: num }, ['width', 'height']), description: 'Preset box: x/y = top-left or cx/cy = centre (default: canvas centre)' },
      points: { type: 'array', description: '[{anchor: {x, y}, handleIn?: {x, y}, handleOut?: {x, y}}]' }, closed: { type: 'boolean', description: 'Default true' },
      roundness: { type: 'number', description: 'Corner rounding 0–100 (presets with corners)' }, fillColor: str, fillOpacity: num, strokeColor: str, strokeWidth: num, strokeOpacity: num,
      trackId: { type: 'string', description: 'Overlay track id from context' },
      insertAfterItemId: { type: 'string', description: 'Insert after this item and push later items right; not with trackId or timelineStart' }, timelineStart: secs('Start in seconds (default 0)'),
      duration: secs('Length in seconds (default 5)') }) },
  // T05 (contracts addText). textContent and duration are required as in the catalogue type (the handler's 3 s fallback serves
  // callers that skip the helper); bounds values, look and textAnimation are the handler's (INVALID_BOUNDS, TEXT_LOOKS_UNAVAILABLE,
  // INVALID_TEXT_ANIMATION).
  { name: 'addText', description: 'Add a text overlay on an overlay track, or insert it after an item. Height is measured from the font, size and wrap width. Box in canvas px; times in seconds.',
    inputSchema: obj({ textContent: { type: 'string', description: 'The text' }, duration: secs('Length in seconds (one frame to 300)'),
      bounds: { ...obj({ x: num, y: num, width: num }), description: 'Top-left plus wrap width (px); height is measured. Not with a different maxWidth' },
      maxWidth: { type: 'number', description: 'Wrap width in px when bounds is not used (default 60% of the canvas width)' }, font: { type: 'string', description: 'Font family' },
      fontSize: { type: 'number', description: 'px (default 100)' }, color: { type: 'string', description: 'Text colour (hex)' }, backgroundColor: { type: 'string', description: 'Box colour (hex)' },
      look: { description: 'iPhone app only; refused in the web editor' },
      textAnimation: { description: 'Entrance effect: none, typewriter, scramble, pop, jump, fade, zoom, flicker, loud, fall, speedy, stamped, step-fade, slide-right; or {preset, speed?, durationMs?}' },
      trackId: { type: 'string', description: 'Overlay track id from context' },
      insertAfterItemId: { type: 'string', description: 'Insert after this item and push later items right; not with trackId or timelineStart' }, timelineStart: secs('Start in seconds (default 0)') },
    ['textContent', 'duration']) },
  // T11 (contracts #27; results §11 G-08: both or neither address, durationSeconds 0, an unknown kind or direction are schema
  // refusals). The betweenItems count stays with the handler ("got <n>", error codes §7); params values are stored as given
  // (part 5 §55.6), so only their keys are checked here.
  { name: 'applyTransition', description: 'Add, update or remove the transition on the cut between two neighbouring video / image clips of one track: betweenItems (either order) or atSeconds (nearest cut within 0.5 s on any track). add on a cut that has one replaces it. The length is clamped to 0.1 s … the shorter clip (at most 3 s) and the applied length is reported.',
    inputSchema: { ...obj({ action: { enum: ['add', 'update', 'remove'] }, betweenItems: { type: 'array', items: str, description: 'The two clip ids either side of the cut' }, atSeconds: secs('Pick the nearest cut within 0.5 s of this timeline time'),
      kind: { enum: ['fade', 'dissolve', 'additiveDissolve', 'dipToColorDissolve', 'slide', 'wipe'], description: 'Default fade (dips through black)' },
      durationSeconds: { type: 'number', exclusiveMinimum: 0, description: 'Length in seconds (default 1)' }, alignment: { enum: ['start', 'center', 'end'], description: 'start = begins at the cut, end = finishes at it (default center)' },
      direction: { enum: ['from-left', 'from-right', 'from-top', 'from-bottom'], description: 'slide and wipe: the side the incoming clip enters from (default from-left)' },
      params: { ...obj({ color: { description: 'dipToColorDissolve: [r, g, b], each 0–1 (default black)' }, softness: { description: 'wipe: edge feather 0–100 (% of the frame)' } }), description: 'Agent-only parameters' } }, ['action']),
    anyOf: [{ required: ['betweenItems'] }, { required: ['atSeconds'] }] } },
  { name: 'changeTrack', description: 'Move one item to another existing compatible track, optionally to a new start (seconds).',
    inputSchema: obj({ itemId: str, trackId: str, from: secs('New start in seconds') }, ['itemId', 'trackId']) },
  { name: 'cloneItem', description: 'Duplicate an item onto a compatible track, keeping all of its state. Default start: the source item\'s end.',
    inputSchema: obj({ itemId: str, trackId: str, at: secs('Start in seconds') }, ['itemId', 'trackId']) },
  { name: 'consolidateTracks', description: 'Pack non-overlapping items down onto lower tracks of the same kind without changing what is visible.',
    inputSchema: obj({ trackIds: ids('Limit the operation to these tracks'), deleteEmptyTracks: bool }) },
  { name: 'context', description: 'Read the timeline: tracks with their items (seconds), duration, fps, canvas size, layer order, groups and markers. Call it before editing.',
    inputSchema: obj({ include: { type: ['string', 'array'], items: str, description: 'Comma-separated list or array, e.g. "timing,markers"' },
      types: { type: ['string', 'array'], items: str, description: 'Only these item types, e.g. "video,audio"' },
      startSeconds: secs('Window start (with endSeconds)'), endSeconds: secs('Window end (with startSeconds)') }) },
  { name: 'deleteItems', description: 'Delete items by id; ripple closes the gaps. Tracks remain even when emptied.',
    inputSchema: obj({ itemIds: ids('Items to delete'), ripple: bool, rippleGroupId: str }, ['itemIds']) },
  // T07 (contracts editLayout). index ranges are the handler's (CELL_INDEX_OUT_OF_RANGE).
  { name: 'editLayout', description: 'Change the gap, corner radius or cell contents of a layout (include only the cells that change; assetId null empties a cell). Cell trims in milliseconds.',
    inputSchema: obj({ itemId: str, gap: num, borderRadius: num,
      cells: { type: 'array', items: obj({ index: { type: 'number', description: '0-based cell index' }, ...layoutCell, assetId: { type: ['string', 'null'], description: 'Project asset id (video or image), or null to empty the cell' } }, ['index']) } }, ['itemId']) },
  // T08. action stays a string: an unknown one is the handler's INVALID_ACTION (results §2).
  { name: 'editMotionGraphic', description: 'Read (view, the default), patch (patches: exact old_string → new_string, first match each) or replace (updateCode) the code of a motion graphic. A summary is required when the item has none.',
    inputSchema: obj({ itemId: str, action: { type: 'string', description: 'view | patchCode | updateCode' }, patches: { type: 'array', items: obj({ old_string: str, new_string: str }, ['old_string', 'new_string']) },
      code: str, summary: { type: 'string', description: 'At most 400 characters; update it when the visual meaning changes' } }, ['itemId']) },
  { name: 'editProperties', description: 'Change visual, media or shape properties of one item (itemId) or a batch (itemIds), atomically. A keyframed property changes only its default value. Timing: moveItem / trimItem; position and fitting: transformItem.',
    inputSchema: obj({ itemId: str, itemIds: ids('All-or-nothing batch'), properties }, ['properties']) },
  // T21 (contract getHelpSection).
  { name: 'getHelpSection', description: 'Read one help section by the section_id searchHelpDocs returned.',
    inputSchema: obj({ section_id: { type: 'string', description: 'Section id' } }, ['section_id']) },
  { name: 'manageMarkers', description: 'Add, update, remove or clear timeline markers (Cutframe tool; times in seconds).',
    inputSchema: obj({ actions: { type: 'array', items: obj({ action: { enum: ['add', 'update', 'remove', 'clear'] }, time: secs('Marker time in seconds'), label: str, markerId: str }, ['action']) } }, ['actions']) },
  { name: 'manageTrack', description: 'Create, delete, rename, reorder or toggle (mute, solo, lock, hide, volume) tracks.',
    inputSchema: obj({ action: { enum: ['create', 'delete', 'mute', 'solo', 'lock', 'hide', 'volume', 'rename', 'reorder'] }, trackId: str, kind: { enum: ['video', 'audio', 'caption', 'overlay'] },
      name: str, position: { enum: ['top', 'bottom', 'above', 'below'] }, relativeToTrackId: str, toIndex: { type: 'integer', minimum: 0, description: '0-based, bottom-to-top' },
      groupId: { type: ['string', 'null'] }, value: bool, volume: { type: 'number', minimum: 0, maximum: 1 }, deleteItems: bool }, ['action']) },
  { name: 'manageTrackGroup', description: 'Group adjacent tracks into a layer container and manage it (rename, setTracks, reorder, ungroup, hide, lock, delete).',
    inputSchema: obj({ action: { enum: ['create', 'rename', 'setTracks', 'reorder', 'ungroup', 'hide', 'lock', 'delete'] }, groupId: str, name: str, trackIds: { type: 'array', items: str },
      toIndex: { type: 'integer', minimum: 0, description: 'Root position, bottom-to-top' }, value: bool }, ['action']) },
  { name: 'moveItem', description: 'Move items in time (by / to, seconds) and/or across tracks, reorder them (beforeItemId / afterItemId), or shift a whole group (groupId + by). Never trims.',
    inputSchema: obj({ itemId: str, itemIds: ids('All-or-nothing batch'), by: secs('Relative shift in seconds'), to: secs('Absolute start in seconds (single item)'), trackId: str,
      beforeItemId: str, afterItemId: str, groupId: str }) },
  { name: 'reorderItems', description: 'Insert existing items right before or after another item; gaps are opened and closed.',
    inputSchema: obj({ itemIds: ids('Items to move, in their current relative order'), beforeItemId: str, afterItemId: str }, ['itemIds']) },
  { name: 'resizeCanvas', description: 'Change the canvas aspect ratio. Items keep their pixel size and position.',
    inputSchema: obj({ aspectRatio: { enum: ['16:9', '9:16', '1:1'] } }, ['aspectRatio']) },
  // T21 (contract searchHelpDocs).
  { name: 'searchHelpDocs', description: 'Search the user-facing help docs with a question of a few words. A single word finds nothing.',
    inputSchema: obj({ query: { type: 'string', description: 'The question' }, match_count: { type: 'number', maximum: 5, description: 'Number of sections, at most 5 (default 5)' } }, ['query']) },
  { name: 'setTimeRemap', description: 'Set a variable-speed curve on a video or audio item: keyframes map timeline seconds to source milliseconds; speed is the slope between them.',
    inputSchema: obj({ itemId: str, keyframes: { type: 'array', minItems: 1, items: obj({ time: { type: 'number', minimum: 0, description: 'Timeline seconds' },
      value: { type: 'number', minimum: 0, description: 'Source milliseconds' }, easing, inHandle: handle, outHandle: handle }, ['time', 'value']) },
      replace: { type: 'boolean', description: 'Replace the curve (default) or merge into it' } }, ['itemId', 'keyframes']) },
  { name: 'slipItem', description: 'Shift the source window inside a video or audio item; its position and length stay the same.',
    inputSchema: obj({ itemId: str, slipSeconds: secs('+ = later source, − = earlier') }, ['itemId', 'slipSeconds']) },
  { name: 'splitItem', description: 'Split an item at a timeline time (seconds); returns the ids of both pieces.',
    inputSchema: obj({ itemId: str, timestampS: secs('Split point, timeline seconds') }, ['itemId', 'timestampS']) },
  { name: 'syncAndSwap', description: 'Sync a second camera to a timeline item by the speech in both, then place it on a video track for the window from–to (timeline seconds). Refused below 50% sync confidence.',
    inputSchema: obj({ sourceAssetId: { type: 'string', description: 'Second-camera asset id, e.g. video_2' }, targetItemId: { type: 'string', description: 'Base timeline item' },
      trackId: { type: 'string', description: 'Destination track id from context' }, from: secs('Window start, timeline seconds'), to: secs('Window end, timeline seconds') },
    ['sourceAssetId', 'targetItemId', 'trackId', 'from', 'to']) },
  { name: 'transformItem', description: 'Position, scale, rotate, or fit an item to the canvas. At most one of scale, scaleBy, fitToCanvas, fillCanvas.',
    inputSchema: obj({ itemId: str, x: num, y: num, scale: num, scaleBy: num, rotation: { type: 'number', minimum: -360, maximum: 360 }, center: bool, centerX: bool, centerY: bool,
      fitToCanvas: bool, fillCanvas: bool, alignTop: bool, alignBottom: bool }, ['itemId']) },
  { name: 'trimItem', description: 'Shift the start or end edge of an item by signed seconds; clamped to the source. ripple shifts later items.',
    inputSchema: obj({ itemId: str, handle: { enum: ['start', 'end'] }, deltaSeconds: secs('Signed movement in seconds'), ripple: bool, rippleGroupId: str }, ['itemId', 'handle', 'deltaSeconds']) },
  { name: 'viewItemDetails', description: 'Inspect timeline items or project assets: include "transcript" (word timings), "keyframes", or "beats" (music: BPM and first downbeat; with beatsFrom / beatsTo the beats, downbeats and subdivisions in that window).',
    inputSchema: obj({ itemId: str, itemIds: ids('Timeline items'), assetId: { type: 'string', description: 'Project asset id, e.g. audio_1' }, assetIds: ids('Project assets'),
      include: { type: ['string', 'array'], items: str, description: 'Comma-separated list or array: transcript, keyframes, beats' },
      beatsFrom: secs('Beat window start (inclusive): timeline seconds for items, source seconds for assets'), beatsTo: secs('Beat window end (exclusive)'),
      minStrength: { type: 'number', minimum: 0, maximum: 1, description: 'Drop beats weaker than this (model activation, not loudness)' },
      subdivisionsPerBeat: { enum: [2, 3, 4, '2', '3', '4'], description: 'Grid points between beats (default 4; 3 = triplets)' },
      // Contract params of include general / analysis (T18; ignored by transcript, keyframes and beats). limit is capped
      // and extra timestamps dropped by the handler (results §2), not refused here.
      granularity: { enum: ['sections', 'full'], description: 'Long videos: section list (default) or every segment' },
      sectionIds: { type: 'array', items: num, description: 'Expand these sections' }, page: { type: 'number', description: 'Entry page (default 1)' },
      limit: { type: 'number', description: 'Entries per page (default 10, capped at 10)' }, previews: { type: 'boolean', description: 'Source images (default true); false = text only' },
      timestamps: { type: 'array', items: num, description: 'Source seconds to inspect (up to 10)' } }) },
  // T10 (contracts writeEffects): targets and parameter values stay with the handler (INVALID_EFFECT_TARGETS, INVALID_PARAM_VALUE, ...).
  { name: 'writeEffects', description: 'Add, edit, toggle or remove effects on one item (itemId) or a batch (itemIds), atomically. effects keys are agent effect ids like vignette_1 (type + 1-based stack position); params change base values and keep keyframes. Effects not named are unchanged.',
    inputSchema: obj({ itemId: str, itemIds: { type: 'array', items: str, description: 'Same patch for every item, all-or-nothing' },
      add: { type: 'array', items: obj({ effectId: str, initialParameters: { type: 'object', description: 'name → number | boolean | string | {angle, distance}' } }), description: 'New effects, appended in order' },
      effects: { type: 'object', additionalProperties: obj({ params: { type: 'object', description: 'name → value' }, enabled: bool, remove: bool }), description: 'agent effect id → {params?, enabled?, remove?}; remove: true overrides the rest' } }) },
  { name: 'writeKeyframes', description: 'Add, update, remove or replace keyframes per item property (payload: property → operations). Times in timeline seconds. Properties not named are untouched.',
    inputSchema: obj({ itemId: str, effectId: { type: 'string', description: 'Target an effect\'s parameters' }, maskIndex: { type: 'integer', minimum: 0, description: '0-based mask' },
      payload: { type: 'object', additionalProperties: ops, description: 'property → {add?, update?, remove?, replace?}' } }, ['itemId', 'payload']) },
  // T06 (contracts writeShapePoints). update / add / remove entries stay loose: the handler's point codes answer them.
  { name: 'writeShapePoints', description: 'Edit a shape\'s bezier path in canvas px: update points (one axis at a time; null removes a handle), add points (insertAt, default end), remove points; or target a path keyframe (at = timeline seconds, or keyframeIndex) for its points and easing. Not atomic: update, add, remove commit in turn. clearKeyframes: true alone clears the path keyframes.',
    inputSchema: obj({ itemId: str, at: secs('Path keyframe at this timeline time (within one frame), else a new one'), keyframeIndex: { type: 'integer', description: '0-based path keyframe' },
      update: { type: 'array', description: '[{pointIndex, anchor?, handleIn?, handleOut?}]' }, add: { type: 'array', description: '[{anchor: {x, y}, handleIn?, handleOut?}]' },
      insertAt: { type: 'integer', description: 'Index for the added points (default end)' }, remove: { type: 'array', description: 'Point indices' },
      easing, inHandle: handle, outHandle: handle, clearKeyframes: bool, keepStateAt: secs('With clearKeyframes: keep the path drawn at this timeline time') }, ['itemId']) },
  // T12 (contracts createMask, editMaskProperties, removeMask, writeMaskPoints). Point arrays and shapes stay loose: the handlers' codes answer them.
  { name: 'createMask', description: 'Add a vector mask to a video or image item from a preset shape + bounds or at least 3 canvas-px points, with one linear path keyframe at timelineSeconds. Modes add, subtract, intersect, difference. Text prompts are retired: use viewMaskFrame, previewSmartMask and trackSmartMask.',
    inputSchema: obj({ itemId: str, shape: { type: 'string', description: 'rectangle, ellipse, triangle, pentagon, star or heart' }, bounds: { type: 'object', description: '{width, height, x?, y?, cx?, cy?} in canvas px' },
      points: { type: 'array', description: '[{anchor: {x, y}, handleIn?, handleOut?}] in canvas px' }, timelineSeconds: secs('Sets the canvas-to-mask mapping and the first path keyframe'), mode: str,
      feather: secs('Soft edge, 0–50 item px'), expansion: secs('Grow or shrink, −50…50 item px'), opacity: secs('0–100'), roundness: { type: 'number', description: 'Rectangle corners' }, inverted: bool, name: str, textPrompt: str }) },
  { name: 'editMaskProperties', description: 'Set a mask\'s name, enabled, feather, expansion, opacity, inverted or mode. Keyframes stay; writeKeyframes animates feather, expansion and opacity.',
    inputSchema: obj({ itemId: str, maskIndex: { type: 'integer', description: '0-based mask' }, properties: obj({ name: {}, enabled: {}, feather: {}, expansion: {}, opacity: {}, inverted: {}, mode: {} }) }, ['itemId', 'maskIndex', 'properties']) },
  { name: 'removeMask', description: 'Remove one mask from an item; later masks move down one index.', inputSchema: obj({ itemId: str, maskIndex: { type: 'integer', description: '0-based mask' } }, ['itemId', 'maskIndex']) },
  { name: 'writeMaskPoints', description: 'Edit a vector mask\'s path in canvas px: update points (one axis at a time; an empty handle value removes it), add points (after = point index, −1 = start, default end), remove points; or target a path keyframe (at = timeline seconds, or keyframeIndex) for its points and easing. Not atomic: update, add, remove commit in turn. clearKeyframes: true alone clears the path keyframes. Smart masks cannot be edited.',
    inputSchema: obj({ itemId: str, maskIndex: { type: 'integer', description: '0-based mask' }, at: secs('Path keyframe at this timeline time (within one frame), else a new one'), keyframeIndex: { type: 'integer', description: '0-based path keyframe' },
      update: { type: 'array', description: '[{pointIndex, anchor?, handleIn?, handleOut?}]' }, add: { type: 'array', description: '[{after?, anchor: {x, y}, handleIn?, handleOut?}]' }, remove: { type: 'array', description: 'Point indices' },
      easing, inHandle: handle, outHandle: handle, clearKeyframes: bool, keepStateAt: secs('With clearKeyframes: keep the path drawn at this timeline time') }) },
  // T12 smart masks (contracts viewMaskFrame, previewSmartMask, trackSmartMask, removeBackground; limits: findings §19, part 2 §42).
  { name: 'viewMaskFrame', description: 'The original source frame of a video item at a timeline time, for drawing smart-mask strokes: the image, a frameRef and its source timing. Stroke coordinates refer to this image.',
    inputSchema: obj({ itemId: str, timelineSeconds: secs('Moment to inspect') }, ['itemId', 'timelineSeconds']) },
  { name: 'previewSmartMask', description: 'Preview an object selection drawn as strokes on a frame from viewMaskFrame: an alpha preview image (white = kept) and a selectionId for trackSmartMask. Label 1 includes, 0 excludes neighbouring objects; at least one include stroke.',
    inputSchema: obj({ frameRef: str, strokes: { type: 'array', minItems: 1, maxItems: 64, items: obj({ label: { enum: [0, 1] }, points: { type: 'array', minItems: 1, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0, maximum: 1 } }, description: '[[x, y]…] as fractions of the image, [0, 0] = top-left' }, radius: { type: 'number', minimum: 0, maximum: 0.25, description: 'Fraction of the image\'s shorter side' } }, ['label', 'points', 'radius']) } }, ['frameRef', 'strokes']) },
  { name: 'trackSmartMask', description: 'Track a previewed selection through a source range of up to 60 s and 1,800 frames that contains the inspected frame, and attach the alpha mask to the item. Existing masks stay; its numeric settings can be edited afterwards. Waits for the finished mask.',
    inputSchema: obj({ selectionId: str, sourceStartSeconds: secs('Range start, source time (inclusive)'), sourceEndSeconds: secs('Range end, source time (exclusive)'), name: str }, ['selectionId', 'sourceStartSeconds', 'sourceEndSeconds']) },
  { name: 'removeBackground', description: 'Automatic subject selection kept as a persistent binary smart mask on a video item, over the whole item (up to 5 minutes of source). Works well for people; for a specific object draw strokes instead. One job runs at a time, others wait. Waits for the finished mask.',
    inputSchema: obj({ itemId: str, name: str }, ['itemId']) },
];
export const TOOLS: Tool[] = TOOL_LIST.filter(t => (SERVED_TOOLS as readonly string[]).includes(t.name));

/** Mutually exclusive fields per tool, checked after the schema (detail code INVALID_COMBINATION, path of the first field). */
const EXCLUSIVE: Record<string, [string, string[]][]> = {
  addLayout: [['insertAfterItemId', ['trackId', 'timelineStart']]],
  addMedia: [['insertAfterItemId', ['trackId', 'timelineStart']]],
  addMotionGraphic: [['insertAfterItemId', ['trackId', 'timelineStart']]],
  addShape: [['insertAfterItemId', ['trackId', 'timelineStart']], ['shape', ['points']]],
  addText: [['insertAfterItemId', ['trackId', 'timelineStart']]],
  applyTransition: [['betweenItems', ['atSeconds']]],
  writeShapePoints: [['at', ['keyframeIndex']]],
  writeMaskPoints: [['at', ['keyframeIndex']]],
  editProperties: [['itemId', ['itemIds']]],
  moveItem: [['itemId', ['itemIds']], ['beforeItemId', ['afterItemId']], ['groupId', ['itemId', 'itemIds', 'to', 'trackId', 'beforeItemId', 'afterItemId']]],
  reorderItems: [['beforeItemId', ['afterItemId']]],
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const compiled = new Map<string, ValidateFunction>(TOOLS.map(t => [t.name, ajv.compile(t.inputSchema)]));
const unescape = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');
function detail(e: ErrorObject): InputError {
  let path = '$' + e.instancePath.split('/').slice(1).map(s => '.' + unescape(s)).join('');
  if (e.keyword === 'required') path += '.' + (e.params as { missingProperty: string }).missingProperty;
  if (e.keyword === 'additionalProperties') path += '.' + (e.params as { additionalProperty: string }).additionalProperty;
  return { path, code: e.keyword.toUpperCase(), message: e.message ?? 'is invalid' };
}

/** Schema check; returns the INVALID_TOOL_INPUT result, or null when the input passes. Unknown tools pass (the caller refuses them). */
export function validate(tool: string, input: unknown): Record<string, unknown> | null {
  const check = compiled.get(tool);
  if (!check) return null;
  const errors: InputError[] = check(input) ? [] : (check.errors ?? []).map(detail);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const args = input as Record<string, unknown>;
    for (const [field, others] of EXCLUSIVE[tool] ?? []) {
      const clash = args[field] !== undefined ? others.filter(o => args[o] !== undefined) : [];
      if (clash.length) errors.push({ path: `$.${field}`, code: 'INVALID_COMBINATION', message: `cannot be combined with ${clash.join(', ')}` });
    }
    // Stored server refusal (results §2 manageTrackGroup): distinct member ids, at least two when creating.
    if (tool === 'manageTrackGroup' && Array.isArray(args.trackIds)) {
      const distinct = new Set(args.trackIds).size;
      if (distinct !== args.trackIds.length || (args.action === 'create' && distinct < 2))
        errors.push({ path: '$.trackIds', code: 'INVALID_COMBINATION', message: 'provide distinct member track IDs (at least two when creating)' });
    }
  }
  if (!errors.length) return null;
  return { success: false, code: 'INVALID_TOOL_INPUT', error: `Invalid input for ${tool}`, message: errors.map(e => `${e.path}: ${e.message}`).join('; '), details: { errors } };
}
