---
topic: keyframing
kind: technical
summary: Animate item properties, effect parameters and mask properties with writeKeyframes: times, value modes, easing and match windows.
related:
unserved: captureFrame
---

## Purpose

`writeKeyframes` is the one tool for every keyframe change on an item property, an effect parameter (`effectId`) or a mask property (`maskIndex`). This guide gives its operations, how values and easing are resolved, and the time windows that decide which keyframe an operation hits.

## When to load

- Any animation with more than one keyframe, or any easing other than `linear`.
- Fades, punch-ins, slides, volume ramps, animated blur or effect strength, animated mask feather.
- Variable speed is not keyframing: load `time-remapping`.

## Workflow

1. Call `context` for the item's start and end on the timeline.
2. Read existing keyframes with `viewItemDetails` and `include: ["keyframes"]`.
3. Write one `writeKeyframes` call per item: `payload` maps each property to its operations.
4. Read `data.keyframes` (the stored curve per property) and `data.resolvedKeyframes` (each written `{time, value, source}`), plus any `warnings`.
5. Check the motion (see Verification).

## Tools and parameters

**`writeKeyframes`**
- `itemId` (required), `payload` (required): `{ <property>: { add?, update?, remove?, replace? } }`. Properties not named are untouched.
- `effectId`: an agent effect id such as `vignette_1`; the payload then names that effect's parameters.
- `maskIndex`: a 0-based mask; the payload then names `feather`, `expansion` or `opacity`. Not together with `effectId` (`INVALID_COMBINATION`).
- Entry for `add`, `update`, `replace`: `{time, value? | delta? | factor?, easing?, inHandle?, outHandle?}`.
  - `time`: timeline seconds, inside the item.
  - `value` sets an absolute value; `delta` adds to the current curve value at that time; `factor` multiplies it; none of the three holds the current curve value there. Give at most one (`CONFLICTING_KEYFRAME_VALUE_MODES`).
  - `easing`: a preset name from the table, or `{type: "bezier", points: [x1, y1, x2, y2]}`. Default `linear`.
  - `inHandle`, `outHandle`: `[x, y]`, with x a share of the segment and y in the range given in the table.
- `remove`: a list of timeline times in seconds.

**Item properties you can keyframe:** `opacity`, `scale`, `rotation`, `positionX`, `positionY`, `width`, `height`, `blur`, `brightness`, `borderRadius`, `borderWidth`, `volume`, `fillOpacity`, `strokeWidth`, `strokeOpacity`, where the item type has them.

## How operations combine

Per property, in this order:
1. `replace` swaps the whole curve for its list, sorted by time; `[]` clears it. Its `delta` and `factor` read the curve as it was before the call.
2. `add` appends a keyframe. If one already sits within the add window, that keyframe is overwritten in place (its time is kept) and a warning says so.
3. `update` overwrites the nearest keyframe, before or after its time, that existed before this call, within the match window; with none in reach it appends. It never hits a keyframe this call appended or set with `replace`. A keyframe the call overwrote (an `add` at the same instant, or an earlier `update`) keeps its id, so a later `update` can overwrite it again.
4. `remove` deletes every keyframe within the match window of each time. A time with no keyframe in reach refuses the whole call with `REMOVE_TIME_NOT_FOUND`, which lists the times that exist.

So `replace` sets the base, and `add` / `update` in the same call land on top of it. To rebuild a curve, send `replace` alone.

Times are rounded to whole milliseconds before the windows are measured; a distance exactly at the window size does not match.

## How easing works

The easing of a segment belongs to the keyframe that starts it (the departing key). To make the move from A to B ease out, put the easing on A. The last keyframe's easing does nothing. Before the first keyframe the curve holds the first value; after the last it holds the last.

## Units and limits

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:keyframe.addOverwriteMs | 4 | ms | `add` overwrites an existing keyframe closer than this |
| fact:keyframe.updateMatchMs | 100 | ms | `update` targets the nearest pre-call keyframe (either side) closer than this |
| fact:keyframe.removeToleranceMs | 100 | ms | `remove` matches keyframes closer than this |
| fact:keyframe.easings | ["linear","easeIn","easeOut","easeInOut","easeInQuad","easeOutQuad","easeInOutQuad","easeInCubic","easeOutCubic","easeInOutCubic","easeInBack","easeOutBack","easeInOutBack","easeOutElastic","easeOutBounce"] | none | The easing preset names |
| fact:keyframe.handleXMax | 1 | fraction | Handle x runs from 0 to this share of the segment |
| fact:keyframe.handleYMin | -100 | none | Smallest handle y |
| fact:keyframe.handleYMax | 100 | none | Largest handle y |
| schema:writeKeyframes.maskIndex.minimum | 0 | count | First mask index |
| fact:property.opacityMax | 1 | fraction | Opacity runs from 0 to this |
| fact:property.scaleMax | 100 | factor | Largest scale multiplier (1 = original size) |
| fact:property.rotationMax | 360 | deg | Rotation runs from minus this to this |
| fact:audio.volumeMax | 3 | factor | Largest item volume (1 = as recorded; gain is volume squared) |
| fact:property.blurMax | 50 | px | Largest blur |

- Values use stored units: opacity as a fraction, not a percent; rotation in degrees; positions and sizes in canvas px.
- A resolved value outside a property's range is refused with `KEYFRAME_VALUE_OUT_OF_RANGE`.

## Verification

- Compare `data.keyframes` with what you meant: count, times, values, easing.
- `viewItemDetails` with `include: ["keyframes"]` shows the stored curves in timeline seconds.
- `captureFrame` is not served in this build. To check the motion, ask the user to check the preview at the start, middle and end of each move.
- For volume, play the range and listen.

## Pitfalls

- **Time outside the item** is `TIME_OUT_OF_BOUNDS`; the message gives the item's range.
- **Not animatable.** A fixed property the item type has (text, caption and shape `width` / `height`, `flipX`, `blendMode`, video and image `borderColor`, shape `fillColor` and `strokeColor`) is `PROPERTY_NOT_ANIMATABLE`. A key with no keyframe entry at all, such as `playbackRate` or the text keys `color` and `fontSize`, is `INVALID_PROPERTY`. A keyframeable property the item type lacks is `PROPERTY_NOT_ON_TYPE`.
- **Keyframes ride the trim axis.** Trimming an item's start slides the window over its keyframes; the keyframes do not move with the edge.
- **`editProperties` on a keyframed property** changes only its default value, not the curve.
- **Time remap is separate.** `timeRemap` in `writeKeyframes` only accepts `{replace: []}` to clear it; anything else is `USE_SET_TIME_REMAP`.
- **Locked track** refuses with `TRACK_LOCKED`.
