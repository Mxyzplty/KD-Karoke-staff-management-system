// SPDX-License-Identifier: AGPL-3.0-only
// T23 facts registry (T23 notes "Units and limits table"): the values a mechanics guide's `| Check | Value | Unit | Meaning |`
// table may cite. `fact:<key>` rows read FACTS, each checked against its findings section and taken from the code constant
// where the code exports one; `schema:<tool>.<path>.<keyword>` rows read the helper's served JSON Schemas. UNITS holds the unit
// of every timed or sized schema field, so a row's Unit is checked too.
// Path form: property names joined by dots, `[]` after a name for its array items, `*` for an object's additionalProperties.
import { TOOLS } from '../../../../helper/src/schemas';
import { EASING_NAMES } from '../protocol';
import { CEILING_DB } from '../../audio/limiter';
import { FADE_MS } from '../../audio/edits';
import { CHUNK_DEFAULTS, HOLD_MS } from '../../captions/chunker';
import { COUNTDOWN_S } from '../../editor/voiceover';
import { KEYFRAME_S } from '../../export/pipeline';
import { AUDIO, DEFAULT_BITRATE } from '../../export/probe';
import { MASK_RANGE } from '../../masks/model';
import { STROKE_LIMITS } from '../../masks/strokes';
import { COMPUTE_MS, MEDIA_BUDGET_MS } from '../../mg/watchdog';
import { MAX_DURATION_MS, SPEED } from '../../text/animation';
import { AGENT_TEXT } from '../../text/tools';
import { MIN_ITEM_MS, TOOL_IMAGE_MS, UNKNOWN_SOURCE_MS } from '../../timeline/items';
import { LAYOUT_MS } from '../../timeline/layout-tools';
import { REGISTRY } from '../../timeline/properties';
import { ASPECTS } from '../../timeline/tracks';
import { DEFAULT_MS, MAX_MS, MIN_MS, NEAR_MS } from '../../timeline/transitions';
// The graphic runtime only loads in the sandbox, so its API list is read from source, as settings/providers.ts does.
import mgRuntime from '../../mg/runtime-components.tsx?raw';

export const UNIT_NAMES = ['s', 'ms', 'frames', 'px', 'deg', 'fraction', 'percent', 'count', 'chars', 'factor', 'none', 'dB', 'Hz', 'kbps', 'Mbps'] as const;
export type Unit = typeof UNIT_NAMES[number];
export type Fact = { value: number | string | (number | string)[]; unit: Unit; source: string; code?: string };
export const SCHEMA_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'default', 'enum', 'minItems', 'maxItems', 'minLength', 'maxLength'] as const;

// value, unit, source; `code` names the constant (in CODE_VALUES) or, where the owner doesn't export it, the file:line literal.
const f = (value: Fact['value'], unit: Unit, source: string, code?: string): Fact => ({ value, unit, source, ...(code ? { code } : {}) });
/** The writers' `fact:` keys (lane F's merged list), each value checked against its source and the code. */
export const FACTS: Record<string, Fact> = {
  // Orientation, timeline, finding media, layouts, multi-cam, reframe.
  'agent.maxFailedAttempts': f(2, 'count', 'contracts §1 "Retry limit"; findings part 3 §43.2'),
  'timeline.toolImageDurationS': f(3, 's', 'results §2 addMedia', 'timeline/items.ts:TOOL_IMAGE_MS'),
  'timeline.unknownSourceDurationS': f(5, 's', 'results §2 addMedia resolvedTrim', 'timeline/items.ts:UNKNOWN_SOURCE_MS'),
  'timeline.minItemMs': f(50, 'ms', 'code only', 'timeline/items.ts:MIN_ITEM_MS'),
  'changes.textMaxChars': f(1000, 'chars', 'results §1 A0.3; findings part 2 §42', 'timeline/changes.ts:10 TEXT_CAP'),
  'search.defaultLimit': f(20, 'count', 'contracts searchProjectAssets; findings part 2 §42'),
  'search.maxLimit': f(50, 'count', 'contracts searchProjectAssets / searchUserLibrary'),
  'library.recentDefault': f(10, 'count', 'contracts searchUserLibrary; §3h #49'),
  'layout.defaultDurationS': f(10, 's', 'contracts addLayout; results §2', 'timeline/layout-tools.ts:LAYOUT_MS'),
  'layout.defaultTimelineStartS': f(0, 's', 'contracts addLayout'),
  'layout.defaultGapPx': f(0, 'px', 'contracts addLayout'),
  'layout.maxCells': f(4, 'count', 'results §2 addLayout', 'timeline/layouts.ts:27 grid-2x2'),
  'layout.cellVolumeDefault': f(100, 'percent', 'contracts addLayout cells[].volume; note 19', 'timeline/layouts.ts:50 newCell'),
  'layout.cellFillModeDefault': f('fill', 'none', 'findings part 2 §42; contracts addLayout'),
  'timeline.itemFramingDefault': f('fit', 'none', 'findings part 2 §42; results §5 G-01'),
  'multicam.minConfidence': f(0.5, 'fraction', 'findings §17, part 2 §42; results §2 syncAndSwap', 'analysis/sync.ts:32'),
  'multicam.minMatchedWords': f(3, 'count', 'code only', 'analysis/sync.ts:32'),
  'canvas.portraitWidthPx': f(1080, 'px', 'findings part 2 l.504; part 3 l.267', "timeline/tracks.ts:ASPECTS['9:16'].width"),
  'canvas.portraitHeightPx': f(1920, 'px', 'findings part 2 l.504; part 3 l.267', "timeline/tracks.ts:ASPECTS['9:16'].height"),
  'reframe.sampleIntervalS': f(0.5, 's', 'tickets l.306 (RF-P02)'),
  'reframe.centreBandPercent': f(30, 'percent', 'tickets l.306 (RF-P02)'),
  'reframe.maxPositionKeyframesPerS': f(1, 'count', 'tickets l.306 (RF-P02)'),
  'reframe.minKeyframeGapS': f(1, 's', "lane F's reading of tickets l.306"),
  'captureFrame.maxTimestamps': f(5, 'count', 'contracts l.273'),
  // Audio, music sync, transcript cleanup, voice-over, export.
  'audio.volumeMin': f(0, 'factor', 'findings part 2 §42; properties.ts:27', 'timeline/properties.ts:REGISTRY.audio.volume.min'),
  'audio.volumeDefault': f(1, 'factor', 'properties.ts:27', 'timeline/properties.ts:REGISTRY.audio.volume.default'),
  'audio.volumeMax': f(3, 'factor', 'findings part 2 §42 and §40; properties.ts:27', 'timeline/properties.ts:REGISTRY.audio.volume.max'),
  'audio.fadeMs': f(1000, 'ms', 'T13 SR-18', 'audio/edits.ts:FADE_MS'),
  'audio.limiterCeilingDb': f(-1, 'dB', 'findings §7, §44.8', 'audio/limiter.ts:CEILING_DB'),
  'beats.subdivisionsDefault': f(4, 'count', 'contracts §3i #58'),
  'beats.snapToleranceBeats': f(0.25, 'fraction', 'our guidance', 'analysis/tools/score.ts:317'),
  'transcript.wordGridMs': f(20, 'ms', 'T19', 'analysis/types.ts:29'),
  'silence.pauseS': f(0.75, 's', 'T19 C6', 'analysis/helpers.ts:37'),
  'silence.keptGapS': f(0.35, 's', 'T19 C6', 'analysis/helpers.ts:37'),
  'voiceover.countdownS': f(3, 's', 'findings §30', 'editor/voiceover.tsx:COUNTDOWN_S'),
  'export.agentResolutions': f(['original', '720p', '1080p', '1440p', '4k'], 'none', 'contracts exportProject; RC 5.8'),
  'export.longEdge720p': f(1280, 'px', 'findings part 3 §44.8', 'export/prep.ts:63'),
  'export.longEdge1080p': f(1920, 'px', 'findings part 3 §44.8', 'export/prep.ts:63'),
  'export.longEdge1440p': f(2560, 'px', 'findings part 3 §44.8', 'export/prep.ts:63'),
  'export.longEdge4k': f(3840, 'px', 'findings part 3 §44.8', 'export/prep.ts:63'),
  'export.keyframeIntervalS': f(5, 's', 'findings part 3 §44.8', 'export/pipeline.ts:KEYFRAME_S'),
  'export.videoBitrateMbps': f(20, 'Mbps', 'findings part 3 §44.8; RC 5.9', 'export/probe.ts:DEFAULT_BITRATE'),
  'export.audioSampleRateHz': f(48000, 'Hz', 'findings part 3 §44.8', 'export/probe.ts:AUDIO.sampleRate'),
  'export.audioChannels': f(2, 'count', 'findings part 3 §44.8', 'export/probe.ts:AUDIO.numberOfChannels'),
  'export.audioBitrateKbps': f(192, 'kbps', 'findings part 3 §44.8', 'export/probe.ts:AUDIO.bitrate'),
  // Captions, text placement, keyframing, time remapping, transitions.
  'caption.maxWordsDefault': f(5, 'count', 'contracts addCaptions; part 3 §44.2', 'captions/chunker.ts:CHUNK_DEFAULTS.maxWords'),
  'caption.maxCharactersDefault': f(35, 'chars', 'contracts addCaptions; part 3 §44.2', 'captions/chunker.ts:CHUNK_DEFAULTS.maxCharacters'),
  'caption.holdAfterLastWordMs': f(500, 'ms', 'findings part 2 §42; §44.1', 'captions/chunker.ts:HOLD_MS'),
  'caption.textAlignValues': f(['left', 'center', 'right'], 'none', 'code only', 'captions/properties.ts:30 ALIGN'),
  'caption.fontStyleValues': f(['normal', 'italic'], 'none', 'code only', 'captions/properties.ts:31 STYLES'),
  'caption.opacityMax': f(1, 'fraction', 'code only', 'captions/properties.ts:50'),
  'caption.lineHeightMin': f(0.5, 'factor', 'code only', 'captions/properties.ts:51'),
  'caption.lineHeightMax': f(3, 'factor', 'code only', 'captions/properties.ts:51'),
  'caption.borderWidthMax': f(100, 'px', 'code only', 'captions/properties.ts:53'),
  'text.agentFontSizeDefault': f(100, 'px', 'contracts §3c #8', 'text/tools.ts:AGENT_TEXT.fontSize'),
  'text.agentWrapWidthShare': f(0.6, 'fraction', 'contracts §3c #9', 'text/tools.ts:AGENT_TEXT.widthShare'),
  'text.agentDurationDefaultS': f(3, 's', 'contracts addText', 'text/tools.ts:AGENT_TEXT.durationMs'),
  'text.maxDurationS': f(300, 's', 'results §2 addText', 'text/tools.ts:AGENT_TEXT.maxDurationMs'),
  'text.alignTopBandShare': f(0.3, 'fraction', 'code only', 'timeline/items.ts:396'),
  'text.alignBottomBandShare': f(0.7, 'fraction', 'code only', 'timeline/items.ts:397'),
  'text.animationSpeedMin': f(0.25, 'factor', 'results §2 addText; contracts §3c #11', 'text/animation.ts:SPEED.min'),
  'text.animationSpeedMax': f(4, 'factor', 'results §2 addText; contracts §3c #11', 'text/animation.ts:SPEED.max'),
  'text.animationDurationMaxMs': f(10000, 'ms', 'results §2 addText', 'text/animation.ts:MAX_DURATION_MS'),
  'keyframe.addOverwriteMs': f(4, 'ms', 'findings part 2 §41', 'timeline/edits.ts:122'),
  'keyframe.updateMatchMs': f(100, 'ms', 'findings part 2 §41', 'timeline/edits.ts:127'),
  'keyframe.removeToleranceMs': f(100, 'ms', 'findings part 2 §41, §42; contracts §3f #28', 'timeline/edits.ts:131'),
  'keyframe.easings': f([...EASING_NAMES], 'none', 'findings part 2 §40', 'agent/protocol.ts:EASING_NAMES'),
  'keyframe.handleXMax': f(1, 'fraction', 'contracts writeKeyframes'),
  'keyframe.handleYMin': f(-100, 'none', 'contracts writeKeyframes'),
  'keyframe.handleYMax': f(100, 'none', 'contracts writeKeyframes'),
  'property.opacityMax': f(1, 'fraction', 'findings part 2 §40', 'timeline/properties.ts:REGISTRY.video.opacity.max'),
  'property.scaleMax': f(100, 'factor', 'findings part 2 §40', 'timeline/properties.ts:REGISTRY.video.scale.max'),
  'property.rotationMax': f(360, 'deg', 'findings part 2 §40', 'timeline/properties.ts:REGISTRY.video.rotation.max'),
  'property.blurMax': f(50, 'px', 'findings part 2 §40', 'timeline/properties.ts:REGISTRY.video.blur.max'),
  'timeRemap.boundsToleranceMs': f(10, 'ms', 'findings part 2 §38', 'timeline/edits.ts:165'),
  'timeRemap.mergeWindowMs': f(100, 'ms', 'findings part 2 §38', 'timeline/edits.ts:171'),
  'timeRemap.audioSpeedMin': f(0.0625, 'factor', 'findings part 2 §38', 'timeline/properties.ts:173'),
  'timeRemap.audioSpeedMax': f(16, 'factor', 'findings part 2 §38', 'timeline/properties.ts:173'),
  'transition.defaultDurationMs': f(1000, 'ms', 'findings §9; part 5 §55.1', 'timeline/transitions.ts:DEFAULT_MS'),
  'transition.minDurationMs': f(100, 'ms', 'findings part 5 §55.1', 'timeline/transitions.ts:MIN_MS'),
  'transition.maxDurationMs': f(3000, 'ms', 'findings part 2 §42; part 5 §55.1', 'timeline/transitions.ts:MAX_MS'),
  'transition.cutSearchMs': f(500, 'ms', 'contracts §3e #27', 'timeline/transitions.ts:NEAR_MS'),
  'transition.softnessMax': f(100, 'percent', 'contracts applyTransition'),
  'transition.colorChannelMax': f(1, 'fraction', 'contracts applyTransition'),
  // Effects, masks, smart masking, motion graphics.
  'effects.wheelDistanceMin': f(0, 'fraction', 'code only', 'effects/validate.ts:33'),
  'effects.wheelDistanceMax': f(1, 'fraction', 'results §9 G-07', 'effects/validate.ts:33'),
  'mask.minPoints': f(3, 'count', 'code only', 'masks/tools.ts:71'),
  'mask.addAfterStart': f(-1, 'none', 'contracts writeMaskPoints', 'masks/tools.ts:180'),
  'mask.featherMin': f(0, 'px', 'code only', 'masks/model.ts:MASK_RANGE.feather.min'),
  'mask.featherMax': f(50, 'px', 'code only', 'masks/model.ts:MASK_RANGE.feather.max'),
  'mask.expansionMin': f(-50, 'px', 'code only', 'masks/model.ts:MASK_RANGE.expansion.min'),
  'mask.expansionMax': f(50, 'px', 'code only', 'masks/model.ts:MASK_RANGE.expansion.max'),
  'mask.opacityMin': f(0, 'percent', 'code only', 'masks/model.ts:MASK_RANGE.opacity.min'),
  'mask.opacityMax': f(100, 'percent', 'code only', 'masks/model.ts:MASK_RANGE.opacity.max'),
  'smartMask.uiStrokesMax': f(32, 'count', 'findings part 2 §42', 'masks/strokes.ts:STROKE_LIMITS.uiStrokes'),
  'smartMask.uiStrokePointsMax': f(64, 'count', 'findings part 2 §42', 'masks/strokes.ts:STROKE_LIMITS.uiPoints'),
  'smartMask.pointsMax': f(4096, 'count', 'findings part 2 §42', 'masks/strokes.ts:STROKE_LIMITS.points'),
  'smartMask.trackMaxSeconds': f(60, 's', 'findings part 2 §42, §19', 'masks/jobs.ts:37 TRACK_LIMIT_US'),
  'smartMask.trackMaxFrames': f(1800, 'frames', 'findings part 2 §42, §19', 'masks/jobs.ts:37 TRACK_FRAMES'),
  'smartMask.keepSeconds': f(1800, 's', 'code only', 'masks/smart-tools.ts:23 KEEP_MS'),
  'smartMask.keepMax': f(64, 'count', 'code only', 'masks/smart-tools.ts:23 KEEP'),
  'removeBackground.maxSourceSeconds': f(300, 's', 'findings part 2 §42; contracts §3f #33', 'masks/jobs.ts:37 REMOVAL_LIMIT_US'),
  'mg.apiNameCount': f(47, 'count', 'findings part 3 §47', 'mg/runtime-components.tsx:API_NAMES.length'),
  'mg.summaryMaxChars': f(400, 'chars', 'contracts addMotionGraphic §3b #6', 'mg/edits.ts:7'),
  'mg.defaultDurationSeconds': f(5, 's', 'contracts §3b #7', 'mg/tools.ts:25'),
  'mg.codeMaxChars': f(262144, 'chars', 'code only', 'mg/compiler.ts:12'),
  'mg.computeBudgetMs': f(2000, 'ms', 'code only', 'mg/watchdog.ts:COMPUTE_MS'),
  'mg.mediaBudgetMs': f(4000, 'ms', 'code only', 'mg/watchdog.ts:MEDIA_BUDGET_MS'),
};

const apiNames = [.../export const API_NAMES = \[([^\]]*)\]/.exec(mgRuntime)?.[1].matchAll(/'([^']+)'/g) ?? []].map(m => m[1]);
/** The code's value for each fact whose `code` names an exported constant, in the fact's unit. A test checks they match. */
export const CODE_VALUES: Record<string, unknown> = {
  'timeline.toolImageDurationS': TOOL_IMAGE_MS / 1000,
  'timeline.unknownSourceDurationS': UNKNOWN_SOURCE_MS / 1000,
  'timeline.minItemMs': MIN_ITEM_MS,
  'layout.defaultDurationS': LAYOUT_MS / 1000,
  'canvas.portraitWidthPx': ASPECTS['9:16'].width,
  'canvas.portraitHeightPx': ASPECTS['9:16'].height,
  'audio.volumeMin': REGISTRY.audio.volume.min,
  'audio.volumeDefault': REGISTRY.audio.volume.default,
  'audio.volumeMax': REGISTRY.audio.volume.max,
  'audio.fadeMs': FADE_MS,
  'audio.limiterCeilingDb': CEILING_DB,
  'voiceover.countdownS': COUNTDOWN_S,
  'export.keyframeIntervalS': KEYFRAME_S,
  'export.videoBitrateMbps': DEFAULT_BITRATE / 1e6,
  'export.audioSampleRateHz': AUDIO.sampleRate,
  'export.audioChannels': AUDIO.numberOfChannels,
  'export.audioBitrateKbps': AUDIO.bitrate / 1000,
  'caption.maxWordsDefault': CHUNK_DEFAULTS.maxWords,
  'caption.maxCharactersDefault': CHUNK_DEFAULTS.maxCharacters,
  'caption.holdAfterLastWordMs': HOLD_MS,
  'text.agentFontSizeDefault': AGENT_TEXT.fontSize,
  'text.agentWrapWidthShare': AGENT_TEXT.widthShare,
  'text.agentDurationDefaultS': AGENT_TEXT.durationMs / 1000,
  'text.maxDurationS': AGENT_TEXT.maxDurationMs / 1000,
  'text.animationSpeedMin': SPEED.min,
  'text.animationSpeedMax': SPEED.max,
  'text.animationDurationMaxMs': MAX_DURATION_MS,
  'keyframe.easings': [...EASING_NAMES],
  'property.opacityMax': REGISTRY.video.opacity.max,
  'property.scaleMax': REGISTRY.video.scale.max,
  'property.rotationMax': REGISTRY.video.rotation.max,
  'property.blurMax': REGISTRY.video.blur.max,
  'transition.defaultDurationMs': DEFAULT_MS,
  'transition.minDurationMs': MIN_MS,
  'transition.maxDurationMs': MAX_MS,
  'transition.cutSearchMs': NEAR_MS,
  'mask.featherMin': MASK_RANGE.feather.min,
  'mask.featherMax': MASK_RANGE.feather.max,
  'mask.expansionMin': MASK_RANGE.expansion.min,
  'mask.expansionMax': MASK_RANGE.expansion.max,
  'mask.opacityMin': MASK_RANGE.opacity.min,
  'mask.opacityMax': MASK_RANGE.opacity.max,
  'smartMask.uiStrokesMax': STROKE_LIMITS.uiStrokes,
  'smartMask.uiStrokePointsMax': STROKE_LIMITS.uiPoints,
  'smartMask.pointsMax': STROKE_LIMITS.points,
  'mg.apiNameCount': apiNames.length,
  'mg.computeBudgetMs': COMPUTE_MS,
  'mg.mediaBudgetMs': MEDIA_BUDGET_MS,
};

// The schema builders: secs() fields and fields whose description names seconds are `s`; layout cell trims and setTimeRemap
// values are source milliseconds; boxes and geometry are canvas px. Mask feather / expansion use secs() but are item px
// (their descriptions), and mask opacity is 0–100.
const each = (tool: string, unit: Unit, paths: string[]) => paths.map(p => [`${tool}.${p}`, unit] as const);
const keyframeTimes = ['add', 'update', 'replace'].map(op => `payload.*.${op}[].time`).concat('payload.*.remove[]');
export const UNITS: Record<string, Unit> = Object.fromEntries([
  ...each('addCaptions', 's', ['startTime', 'endTime']), ...each('addCaptions', 'count', ['maxWords']), ...each('addCaptions', 'chars', ['maxCharacters']),
  ...each('addCaptions', 'px', ['fontSize', 'borderWidth']),
  ...each('addLayout', 's', ['timelineStart', 'duration']), ...each('addLayout', 'px', ['gap', 'borderRadius']), ...each('addLayout', 'ms', ['cells[].trim.from', 'cells[].trim.to']),
  ...each('addLayout', 'percent', ['cells[].volume']),
  ...each('addMedia', 's', ['duration', 'trimStart', 'trimEnd', 'timelineStart', 'items[].duration', 'items[].trimStart', 'items[].trimEnd']),
  ...each('addMotionGraphic', 'px', ['width', 'height', 'x', 'y']), ...each('addMotionGraphic', 's', ['timelineStart', 'duration', 'animationDuration']),
  ...each('addShape', 'px', ['bounds.width', 'bounds.height', 'bounds.x', 'bounds.y', 'bounds.cx', 'bounds.cy', 'strokeWidth']), ...each('addShape', 's', ['timelineStart', 'duration']),
  ...each('addText', 's', ['duration', 'timelineStart']), ...each('addText', 'px', ['bounds.x', 'bounds.y', 'bounds.width', 'maxWidth', 'fontSize']),
  ...each('applyPreset', 's', ['timelineStart']),
  ...each('applyTransition', 's', ['atSeconds', 'durationSeconds']), ...each('applyTransition', 'percent', ['params.softness']),
  ...each('changeTrack', 's', ['from']), ...each('cloneItem', 's', ['at']),
  ...each('context', 's', ['startSeconds', 'endSeconds']),
  ...each('editLayout', 'px', ['gap', 'borderRadius']), ...each('editLayout', 'ms', ['cells[].trim.from', 'cells[].trim.to']), ...each('editLayout', 'percent', ['cells[].volume']),
  ...each('manageTrack', 'fraction', ['volume']),
  ...each('moveItem', 's', ['by', 'to']),
  ...each('searchHelpDocs', 'count', ['match_count']),
  ...each('setTimeRemap', 's', ['keyframes[].time']), ...each('setTimeRemap', 'ms', ['keyframes[].value']), ...each('setTimeRemap', 'count', ['keyframes']),
  ...each('slipItem', 's', ['slipSeconds']), ...each('splitItem', 's', ['timestampS']),
  ...each('syncAndSwap', 's', ['from', 'to']),
  ...each('transformItem', 'px', ['x', 'y']), ...each('transformItem', 'deg', ['rotation']), ...each('transformItem', 'factor', ['scale', 'scaleBy']),
  ...each('trimItem', 's', ['deltaSeconds']),
  ...each('viewItemDetails', 's', ['beatsFrom', 'beatsTo', 'timestamps[]']), ...each('viewItemDetails', 'fraction', ['minStrength']), ...each('viewItemDetails', 'count', ['limit', 'subdivisionsPerBeat']),
  ...each('writeKeyframes', 's', keyframeTimes),
  ...each('writeShapePoints', 's', ['at', 'keepStateAt']),
  ...each('createMask', 's', ['timelineSeconds']), ...each('createMask', 'px', ['feather', 'expansion']), ...each('createMask', 'percent', ['opacity']),
  ...each('writeMaskPoints', 's', ['at', 'keepStateAt']),
  ...each('viewMaskFrame', 's', ['timelineSeconds']),
  ...each('previewSmartMask', 'count', ['strokes', 'strokes[].points']), ...each('previewSmartMask', 'fraction', ['strokes[].points[][]', 'strokes[].radius']),
  ...each('trackSmartMask', 's', ['sourceStartSeconds', 'sourceEndSeconds']),
  ...each('workspace', 'count', ['limit', 'offset']), ...each('workspace', 'chars', ['maxChars']),
]);

type Schema = Record<string, unknown>;
/** The JSON Schema node at a `<path>` of a tool's input, or undefined. */
export function schemaNode(tool: string, path: string): Schema | undefined {
  let node = TOOLS.find(t => t.name === tool)?.inputSchema as Schema | undefined;
  for (const part of path.split('.')) {
    const [, name, arrays] = /^([^[\]]+)((?:\[\])*)$/.exec(part) ?? [];
    if (!node || !name) return undefined;
    node = (name === '*' ? node.additionalProperties : (node.properties as Record<string, Schema> | undefined)?.[name]) as Schema | undefined;
    for (let n = 0; n < arrays.length / 2 && node; n++) node = node.items as Schema | undefined;
  }
  return node && typeof node === 'object' ? node : undefined;
}
/** The value a `schema:<tool>.<path>.<keyword>` check names, or undefined when the schema has none. */
export function schemaValue(key: string): unknown {
  const m = /^schema:([A-Za-z]+)\.(.+)\.([A-Za-z]+)$/.exec(key);
  if (!m || !(SCHEMA_KEYWORDS as readonly string[]).includes(m[3])) return undefined;
  return schemaNode(m[1], m[2])?.[m[3]];
}
/** The unit of a `schema:` key's field, or of a `fact:` key; undefined when neither registry knows it. */
export function unitOf(key: string): Unit | undefined {
  if (key.startsWith('fact:')) return FACTS[key.slice(5)]?.unit;
  const m = /^schema:([A-Za-z]+)\.(.+)\.[A-Za-z]+$/.exec(key);
  return m ? UNITS[`${m[1]}.${m[2]}`] : undefined;
}
