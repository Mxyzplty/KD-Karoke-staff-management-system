---
topic: masks
kind: technical
summary: Draw, edit, animate and remove vector masks (preset shapes and pen paths) on video and image items.
related: smart-masking, keyframing
unserved: captureFrame
---

## Purpose

Show or hide part of a video or image item with a vector mask: a preset shape or a pen path of bezier points. Masks combine in stack order with a mode. For an object that moves on its own (a person, a car), use a tracked smart mask instead: load smart-masking.

## When to load

- The user wants a shape cut-out, a spotlight, a vignette-like reveal, a split-screen edge or a hand-drawn region.
- You need to move, reshape, soften, invert or remove an existing mask, or animate its path.

## Workflow

1. Read the item: `context` for its id and time range, then `viewItemDetails` with `include: "masks"` for the masks it already has, each with its index, points in canvas px, path keyframes and `pathEditing` rules.
2. Create: `createMask` with `itemId`, `timelineSeconds` (inside the item) and either `shape` + `bounds` or `points` (at least the minimum in the table). The new mask gets one linear path keyframe at that time.
3. Style: `editMaskProperties` with `itemId`, `maskIndex` and `properties`.
4. Reshape: `writeMaskPoints`. Because `createMask` already made a path keyframe, pass `at` (timeline seconds) or `keyframeIndex` to choose which path you edit; `at` on a time with no keyframe makes a new one there.
5. Animate feather, expansion or opacity with `writeKeyframes` (`itemId`, `maskIndex`, payload keys `feather` / `expansion` / `opacity`). Animate the shape with path keyframes through `writeMaskPoints` `at`.
6. Remove: `removeMask {itemId, maskIndex}`. Later masks move down one index: re-read before the next call.

## Tools and parameters

- `createMask`:
  - `itemId`; `timelineSeconds` is required in practice (`MISSING_TIMELINE_SECONDS` without it). It fixes the canvas-to-mask mapping through the item's position, scale and rotation at that time.
  - `shape`: `rectangle`, `ellipse`, `triangle`, `pentagon`, `star` or `heart`, with `bounds {width, height, x?, y?, cx?, cy?}` in canvas px (`x`/`y` top-left or `cx`/`cy` centre; default the canvas centre). `roundness` rounds rectangle corners.
  - `points`: `[{anchor: {x, y}, handleIn?, handleOut?}]`, anchors in canvas px, handles as offsets from their anchor.
  - `mode`: `add` (default), `subtract`, `intersect`, `difference`. Also `feather`, `expansion`, `opacity`, `inverted`, `name`.
- `editMaskProperties`: `properties` takes `name`, `enabled`, `feather`, `expansion`, `opacity`, `inverted`, `mode`. Keyframes stay; a keyframed value changes only its base.
- `writeMaskPoints`: `itemId`, `maskIndex` (zero-based), then:
  - `update: [{pointIndex, anchor?, handleIn?, handleOut?}]`: one axis alone is allowed; the other keeps its value. An empty handle value removes that handle.
  - `add: [{after?, anchor, handleIn?, handleOut?}]`: `after` is the point index to insert after; the start value in the table inserts at the start; default end. New points need both `x` and `y`.
  - `remove`: point indices.
  - `at` or `keyframeIndex` (never both); `easing`, `inHandle`, `outHandle` set the morph toward the next path keyframe and need a target.
  - `clearKeyframes: true`, alone, removes every path keyframe; `keepStateAt` keeps the path drawn at that timeline time as the static path.
- `removeMask {itemId, maskIndex}`.

## Units and limits

- Coordinates are canvas px at the targeted time; Cutframe stores them in the item's own pixels, so moving or scaling the item carries the mask with it.
- Out-of-range feather, expansion and opacity values are clamped, and the result lists them in `clamped`.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:mask.minPoints | 3 | count | Fewest points of a custom mask, and the fewest a removal may leave |
| fact:mask.addAfterStart | -1 | none | `add[].after` value that inserts at the start |
| fact:mask.featherMin | 0 | px | Smallest feather (item px) |
| fact:mask.featherMax | 50 | px | Largest feather (item px) |
| fact:mask.expansionMin | -50 | px | Largest shrink (item px) |
| fact:mask.expansionMax | 50 | px | Largest grow (item px) |
| fact:mask.opacityMin | 0 | percent | Smallest mask opacity |
| fact:mask.opacityMax | 100 | percent | Largest mask opacity, and the default |

## Verification

- Read `viewItemDetails` `include: "masks"` after each change: point count, canvas positions, keyframe times and the mode are what you meant.
- `captureFrame` is not served in this build. When placement matters, ask the user to check the preview at the keyframe times.

## Pitfalls

- `writeMaskPoints` is not atomic: `update`, then `add`, then `remove` each commit on their own. If a later stage fails, the earlier ones stay. Send one kind of change per call when a failure must leave nothing behind.
- Adding or removing points works only on a static path. A mask made by `createMask` has a path keyframe, so `add` answers `KEYFRAMED_MASK_NO_ADD` and `remove` answers `KEYFRAMED_MASK_NO_REMOVE`. Clear the keyframes first (`clearKeyframes: true`, with `keepStateAt` to keep a shape), then add or remove.
- Editing a keyframed path without `at` or `keyframeIndex` answers `TIME_TARGET_REQUIRED`. `easing` without a target answers `EASING_REQUIRES_TARGET`; on a path with no keyframes, `CURVE_REQUIRES_KEYFRAME`.
- Smart masks (tracked, raster) cannot be reshaped: `SMART_MASK_NOT_EDITABLE`. Their feather, expansion, opacity, invert and mode can still be edited.
- Times outside the item answer `TIME_OUT_OF_RANGE`. Masks work on video and image items only (`INVALID_ITEM_TYPE`).
- A non-finite or missing coordinate answers `INVALID_POINT_COORDINATES` and writes nothing for that stage.
- `textPrompt` is retired: `createMask` answers `VISUAL_SELECTION_REQUIRED`. Use the smart-masking tools.
- An unknown `mode` is refused with the valid list; it is not replaced by `add`.
