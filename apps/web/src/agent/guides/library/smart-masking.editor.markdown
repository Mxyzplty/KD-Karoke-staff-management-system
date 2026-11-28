---
topic: smart-masking
kind: technical
summary: Select and track an object in a video with strokes (viewMaskFrame, previewSmartMask, trackSmartMask), or cut out people automatically with removeBackground.
related: masks
unserved: captureFrame
---

## Purpose

Make a tracked alpha mask that follows an object through a video item. You select the object by drawing strokes on a source frame; a local model previews the selection and then tracks it through a source range. `removeBackground` is the automatic variant for people over the whole item. Everything runs on the user's device.

## When to load

- The user wants a moving subject isolated, cut out, blurred, recoloured or placed in front of text.
- The user asks to remove a video's background.
- For a fixed geometric region, use vector masks instead (the masks guide, loaded with this one; id `masking`).

## Workflow

1. `context`: find the video item and a moment where the object is clear, large and not hidden.
2. `viewMaskFrame {itemId, timelineSeconds}`: returns the source frame as an image, its `frameRef`, `sourceSeconds`, `width` and `height`. The image is the original source picture, before the item's transform and effects.
3. Look at the image and plan strokes in image fractions, top-left origin. Draw include strokes (`label` 1) along the object's inside; add exclude strokes (`label` 0) on neighbouring things the selection must not take. Only 12 evenly spaced points of a stroke reach the model, and a point within 4 px (source pixels) of a kept point of the same label is dropped: add more short strokes rather than longer ones.
4. `previewSmartMask {frameRef, strokes}`: returns a preview image (white = kept), a `selectionId` and the kept `area`. Look at it. If it takes too much or too little, adjust the strokes and preview again on the same `frameRef`.
5. Choose the source range around the inspected frame: `sourceStartSeconds` (inclusive) and `sourceEndSeconds` (exclusive), in **source** seconds, containing `sourceSeconds` from step 2. Outside every tracked range the item shows unmasked: cover the whole source range the item shows, one track per window within the caps in the table, or trim the item to the tracked range.
6. `trackSmartMask {selectionId, sourceStartSeconds, sourceEndSeconds, name?}`: waits for the finished mask and attaches it to the item. The result gives `maskId`, `maskIndex` and the stored raster reference.
7. For a longer shot, repeat from step 2 on another frame for the next range.
8. Automatic route: `removeBackground {itemId, name?}` over the whole item; it waits for the finished mask.

## Tools and parameters

- `viewMaskFrame`: `itemId` (a video item), `timelineSeconds` inside the item. Read-only.
- `previewSmartMask`: `frameRef`, `strokes: [{label, points, radius}]`. `points` are `[x, y]` pairs as fractions of the image; `radius` is a fraction of the image's shorter side; it is checked but not sent to the model, so it does not change the selection. Read-only (it only makes a selection).
- `trackSmartMask`: `selectionId`, `sourceStartSeconds`, `sourceEndSeconds`, `name`. Existing masks stay; the new one is appended in `add` mode.
- `removeBackground`: `itemId`, `name` (default "Background Removal"). The mask is binary (no hair detail or translucency). It works well for people: up to 3 subjects per shot (people, or salient regions when no person is found), found at the shot's start; a subject who enters later is not kept. For a specific object, draw strokes instead. It is added in `add` mode, or `intersect` when the item already has masks.
- After attaching, read `viewItemDetails` `include: "masks"` first (tracking and removal do not mark the masks as read), then `editMaskProperties` changes `feather`, `expansion`, `opacity`, `inverted`, `mode`, `enabled` and `name`, and `writeKeyframes` animates feather, expansion and opacity. The shape itself cannot be edited.

## Units and limits

- The tracking window holds the inspected frame (start ≤ frame < end), ends inside the source, and obeys both caps below. On a high-frame-rate source the frame cap binds first: the window is at most the frame cap divided by the source fps.
- The schema rules (stroke count, label, radius, point range) are checked first and reported together as `INVALID_TOOL_INPUT`; then the tab checks for an include stroke, then the total point cap.
- The editor's own brush stops at fewer strokes and points than the tool accepts. The model's strokes are not stored with the mask; a user who wants a different selection draws a new one.
- Frames and selections are kept for the time below, and only the newest ones; after that, view the frame again.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| schema:previewSmartMask.strokes.minItems | 1 | count | Fewest strokes |
| schema:previewSmartMask.strokes.maxItems | 64 | count | Most strokes the tool accepts |
| schema:previewSmartMask.strokes[].label.enum | [0, 1] | none | 1 includes, 0 excludes |
| schema:previewSmartMask.strokes[].radius.minimum | 0 | fraction | Smallest radius, of the shorter side |
| schema:previewSmartMask.strokes[].radius.maximum | 0.25 | fraction | Largest radius, of the shorter side |
| schema:previewSmartMask.strokes[].points.minItems | 1 | count | Fewest points in a stroke |
| schema:previewSmartMask.strokes[].points[][].minimum | 0 | fraction | Smallest x or y |
| schema:previewSmartMask.strokes[].points[][].maximum | 1 | fraction | Largest x or y |
| fact:smartMask.uiStrokesMax | 32 | count | Most strokes the editor's brush makes |
| fact:smartMask.uiStrokePointsMax | 64 | count | Points the editor keeps per drawn stroke |
| fact:smartMask.pointsMax | 4096 | count | Most points in one selection |
| fact:smartMask.promptPointsMax | 12 | count | Points of one stroke that reach the model |
| fact:smartMask.promptSpacingPx | 4 | px | Closer points of the same label are dropped (source px) |
| fact:smartMask.trackMaxSeconds | 60 | s | Longest tracking window |
| fact:smartMask.trackMaxFrames | 1800 | frames | Most frames in one tracking window |
| fact:smartMask.keepSeconds | 1800 | s | How long a frame or selection stays usable |
| fact:smartMask.keepMax | 64 | count | Frames (and selections) kept at once |
| fact:removeBackground.maxSourceSeconds | 300 | s | Longest item source `removeBackground` takes |
| fact:removeBackground.maxSubjects | 3 | count | Most subjects kept per shot: people, or salient regions when no person is found |
| fact:helper.toolTimeoutSeconds | 60 | s | Helper time-out for a call that is not a mask job |

## Verification

- Always look at the `previewSmartMask` image before tracking: white must cover the object and nothing else.
- After tracking, read `viewItemDetails` `include: "masks"`: the new mask is listed as `smart`.
- `captureFrame` is not served in this build. Ask the user to scrub the preview across the tracked range, especially fast motion and the range ends.

## Pitfalls

- A stroke that breaks the schema (count, label, radius, point range) answers `INVALID_TOOL_INPUT`, and `message` names the field. No include stroke, more points than the cap, an expired `frameRef` or `selectionId`, a time outside the item and a bad tracking range come back as `PROJECT_UNAVAILABLE` with `operationMayHaveRun: true`; the `error` text names the rule. Fix the input and call again; nothing was attached.
- A selection with no include stroke is refused, even if it has exclude strokes.
- The range is in source time, not timeline time. On a trimmed or remapped item, use the `sourceSeconds` that `viewMaskFrame` returned.
- If the video or the item's source changes while a job runs, nothing is attached: `trackSmartMask` answers `PROJECT_UNAVAILABLE` with "The source changed while tracking…" (or "The selected video changed…" when caught before the job starts), and `removeBackground` answers `MASK_SOURCE_CHANGED`. View the frame again.
- `removeBackground` on an item over its limit answers `REMOVE_BG_TOO_LONG`: split the item first. When the model finds no subject it answers `FOREGROUND_NOT_FOUND`: pick a clearer shot or use strokes. A non-video item answers `INVALID_ITEM_TYPE`.
- Tracking and removal jobs share one queue and run one at a time; the others wait their turn. Run one removal over a long item and split afterwards, rather than one removal per piece. A preview also waits for a running job and is not exempt from the helper's time-out: behind a long job it can answer `TOOL_TIMEOUT` after 60 s. Wait for the job, then preview again.
- If the on-device model cannot load, calls answer `MASK_MODEL_UNAVAILABLE`; the models first load in `previewSmartMask`. Other load or decode failures answer `MASK_FAILED`. A job the user cancelled answers `MASK_CANCELLED`: do not restart it.
- The track lock is checked only when the mask is attached: on a locked track, `trackSmartMask` answers `TRACK_LOCKED` after the whole track. Unlock the item's track first.
- Calling `trackSmartMask` again with the same `selectionId` after it succeeded returns `{itemId, maskId}` of the mask it already attached, with no `maskIndex` or raster (read them with `viewItemDetails` `include: "masks"`); it does not add a second one. This holds while that mask is on the item and the selection is within its keep time in the table.
- The tools take no text prompt: `createMask` with `textPrompt` answers `VISUAL_SELECTION_REQUIRED`. The editor's Smart Mask pill still has an "Or describe it" box for the user.
