---
topic: time-remapping
kind: technical
summary: Variable speed, ramps, freezes and reverse on video or audio with setTimeRemap: timeline seconds in, source milliseconds out.
related: keyframing
unserved: captureFrame
---

## Purpose

`setTimeRemap` puts a speed curve on a video or audio item. Each keyframe says which source moment plays at a given timeline moment; the speed between two keyframes is the slope. Use it for speed ramps, slow motion inside a clip, freeze frames and reverse.

## When to load

- The user asks for a speed ramp, slow-mo on part of a clip, a freeze, or a reverse.
- A constant speed for the whole clip is simpler: `editProperties` with `playbackRate`.

## Workflow

1. Call `context` for the item's timeline start and end. On an item, `viewItemDetails` gives the timeline span, not the source length. Two served reads give the source length: `viewItemDetails {assetId, include: "transcript"}` (or `"keyframes"`) on the item's asset returns `duration`, the asset's length in seconds; and `sourceDuration` in a `setTimeRemap` result. Without either, send a first curve that stays inside the clip's current source range, read `sourceDuration`, then send the full curve.
2. Plan the curve as pairs: timeline second → source millisecond. Speed of a segment = (source ms change) ÷ (timeline ms change).
3. Call `setTimeRemap` with all keyframes in one call. `replace` defaults to true and swaps the whole curve.
4. Read `data`: `keyframesSet`, `totalKeyframesInTrack`, `clipDuration` and `sourceDuration` (both seconds), `speedRange {min, max}`, and any `warnings`.
5. Check frames and sound (see Verification).

## Tools and parameters

**`setTimeRemap`**
- `itemId`: a video or audio item. Other types are `INVALID_ITEM_TYPE`.
- `keyframes[]` (at least one): `{time, value, easing?, inHandle?, outHandle?}`.
  - `time`: **timeline seconds**, inside the item.
  - `value`: **source milliseconds**, counted from the start of the source file (not from the trim in-point).
  - `easing`, `inHandle`, `outHandle`: as in `keyframing`; the easing sits on the keyframe that starts the segment.
- `replace`: true (default) replaces the curve; false merges, and a new keyframe within the merge window of an existing one overwrites that one's value and easing and keeps its time. An overwrite without `easing` resets it to `linear` and drops its handles: send the easing again if you want to keep it.

**Clearing:** `writeKeyframes` with `payload: {timeRemap: {replace: []}}` removes the curve. Any other `timeRemap` write through `writeKeyframes` is `USE_SET_TIME_REMAP`.

## Units and limits

| Check | Value | Unit | Meaning |
|---|---|---|---|
| schema:setTimeRemap.keyframes.minItems | 1 | count | Fewest keyframes per call |
| schema:setTimeRemap.keyframes[].time.minimum | 0 | s | Earliest keyframe time |
| schema:setTimeRemap.keyframes[].value.minimum | 0 | ms | Smallest source time |
| fact:timeRemap.boundsToleranceMs | 10 | ms | How far outside the item a keyframe time may sit before `TIME_OUT_OF_BOUNDS` |
| fact:timeRemap.mergeWindowMs | 100 | ms | With `replace: false`, a keyframe closer than this to an existing one overwrites it |
| fact:timeRemap.audioSpeedMin | 0.0625 | factor | Slowest speed used for audio rate and pitch (the curve itself is not limited) |
| fact:timeRemap.audioSpeedMax | 16 | factor | Fastest speed used for audio rate and pitch |

- Two clocks: `time` is timeline seconds, `value` is source milliseconds. Mixing them up is the most common error: multiply a source time in seconds by a thousand before sending it as `value`.
- Equal values on two keyframes make a freeze; a falling value plays in reverse.
- A value past the end of the source is accepted with a warning; playback holds the last source frame there, so that tail does not move.
- Property keyframes (opacity, scale and so on) are not moved by the remap: they stay on the item's trim axis.

## Verification

- `data.speedRange` should match the speeds you planned. A range far below plan (about a thousandth of the planned speed) usually means seconds were sent as `value`.
- `captureFrame` is not served in this build. For a video item, call `viewMaskFrame {itemId, timelineSeconds}` just before and after each keyframe: its source timing tells you which source moment plays there. For audio, ask the user to check the preview.
- Play audio items over each segment and listen for the speed and pitch change.

## Pitfalls

- **`value` in seconds.** A `value` sent in seconds points a thousand times too early in the source.
- **`time` relative to the item.** `time` is on the timeline, not from the item's start.
- **Merge vs replace.** Sending one keyframe with the default `replace` wipes the rest of the curve. Use `replace: false` to change one point.
- **Bad input** (empty list, negative time or value, unknown easing) is refused by the schema with `INVALID_TOOL_INPUT` before the handler runs.
- **Locked track** refuses with `TRACK_LOCKED`.
