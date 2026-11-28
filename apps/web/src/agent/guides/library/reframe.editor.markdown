---
topic: reframe
kind: technical
summary: Reframing landscape footage for a portrait canvas: resize, fill the height, follow the subject with keyframed horizontal position, no empty borders.
related: keyframing, timeline
unserved: captureFrame
---

# Reframing to portrait

## Purpose

Turn a landscape edit into a portrait one without losing the subject. Resizing the canvas alone leaves every item where it was, so the footage must be scaled to fill the new height and then panned left and right to keep the subject in view. This guide gives the method for any shot with one main subject.

## When to load

- When the user asks for a vertical, portrait or `9:16` version of a landscape edit.
- When a subject drifts out of frame after a canvas resize.

## Workflow

1. **Find the subject first.** While the canvas is still landscape, sample each clip at a steady interval of 0.5 s. For each sample, note the subject centre as a share `f` of the frame width (`0` at the left edge, `1` at the right edge).
2. **Resize.** Call `resizeCanvas {aspectRatio: "9:16"}`. The canvas becomes 1080 × 1920 px. Items keep their pixel position and size, so the footage now sits too small and off-centre.
3. **Fill the height.** Call `transformItem {itemId, fillCanvas: true}` on each video item. Read `drawnBox.width` in the result; call it `D`. It is the drawn width of the footage in canvas px.
4. **Work out the positions.** For each sample, the left edge that centres the subject is `x = W/2 − f·D`, where `W` is the canvas width. Clamp it to `W − D ≤ x ≤ 0` (see Units and limits).
5. **Choose keyframes.** Start with one keyframe at the item's first frame and one at its last. Add a keyframe only where the subject would leave the centre band between the existing ones (see Verification). Keep at most 1 position keyframe per second, at least 1 s apart.
6. **Write them.** Call `writeKeyframes {itemId, payload: {positionX: {replace: [...]}}}` once per item, then verify.

## Tools and parameters

- `resizeCanvas {aspectRatio}`: one of `16:9`, `9:16`, `1:1`. It changes only the canvas size, as one undo step; no item moves or scales.
- `transformItem {itemId, fillCanvas: true}`: scales a video or image so it covers the canvas, centred. The result's `drawnBox {x, y, width, height}` is the drawn box in canvas px. Do this before writing keyframes: `transformItem` and `editProperties` change only the default value of a keyframed property.
- `writeKeyframes {itemId, payload}`: for this job the property is `positionX`, the left edge of the drawn footage in canvas px.
  - Entry: `{time, value, easing?}`. `time` is timeline seconds inside the item; `value` is canvas px.
  - `replace` swaps the whole curve, so a second pass does not pile up keyframes.
  - `easing` belongs to the keyframe that starts a move. `easeInOut` reads as a deliberate camera move; `linear` suits a steady follow. Default `linear`.
- `captureFrame {timestamps}`: rendered canvas frames at timeline times, at most 5 per call. It is not served in this build; until it is, use `viewMaskFrame {itemId, timelineSeconds}`, which returns the clip's own source frame with its `width` in image px; measure `f` on that image.

## Units and limits

- The portrait canvas is 1080 px wide and 1920 px tall.
- **No empty borders.** The footage must cover the canvas edge to edge: its left edge `x` may not pass `0` going right, and its right edge `x + D` may not pass `W` going left. So every keyframe value lies in `W − D ≤ x ≤ 0`. Linear and eased moves between two values in that range stay in it; overshooting easings (`easeInBack`, `easeOutBack`, `easeInOutBack`, `easeOutElastic`) and bezier easings whose points overshoot can leave it, so do not use them here.
- **Centre band.** Aim to keep the subject centre inside the middle 30 % of the canvas width. The subject's canvas position at time `t` is `x(t) + f·D`.
- At most 1 position keyframe per second of the item, and keyframes at least 1 s apart. Fewer keyframes look calmer; a pan that chases every small move looks shaky.
- Sample at a steady interval of 0.5 s, both to find the subject and to verify.

## Verification

- Read `data.keyframes` from `writeKeyframes`: count the `positionX` keyframes, and check every value lies inside `W − D ≤ x ≤ 0`.
- At every sample time, work out `x(t)` from the curve and check that `x(t) + f·D` lies inside the centre band. Where it does not, add a keyframe near that time, or move the nearest one, while keeping the spacing rule.
- Capture frames at each keyframe time and halfway between keyframes. Look for the subject near the middle and for no bar of background at the left or right edge.
- Check the vertical edges too: after `fillCanvas` the footage covers the full height, and nothing in this method moves it vertically.

## Pitfalls

- **Resize does not reframe.** After `resizeCanvas` the footage keeps its old pixel size and position. Always follow it with `fillCanvas`.
- **Measure before you crop.** After the resize much of the frame is off the canvas, so a capture may not show the subject. Sample while the canvas is still landscape, or use the source frame from `viewMaskFrame`.
- **Order matters.** Scale first, keyframe second. A `transformItem` or `editProperties` call on an item whose `positionX` already has keyframes changes only the default value, not the curve.
- **Subject near the frame edge.** When the subject sits close to the source frame's own edge, the clamp stops the footage before the subject is centred. Keep the clamp, and tell the user the subject cannot be centred there.
- **Portrait sources.** Footage that is already narrower than the canvas fills the width, not the height, and has no room to pan. Leave it centred.
- **Trims move the window, not the keyframes.** Trimming the item's start later slides the window over its position keyframes; re-check the framing after any trim.
- **Locked track.** `transformItem` and `writeKeyframes` on a locked track fail with `TRACK_LOCKED`.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| schema:resizeCanvas.aspectRatio.enum | ["16:9","9:16","1:1"] | none | Canvas aspect ratios |
| fact:canvas.portraitWidthPx | 1080 | px | Canvas width after a resize to portrait |
| fact:canvas.portraitHeightPx | 1920 | px | Canvas height after a resize to portrait |
| fact:reframe.sampleIntervalS | 0.5 | s | Interval between samples when finding and checking the subject |
| fact:reframe.centreBandPercent | 30 | percent | Middle share of the canvas width the subject centre should stay in |
| fact:reframe.maxPositionKeyframesPerS | 1 | count | Most position keyframes per second of the item |
| fact:reframe.minKeyframeGapS | 1 | s | Least time between two position keyframes |
| fact:captureFrame.maxTimestamps | 5 | count | Most frames one frame-capture call captures |
