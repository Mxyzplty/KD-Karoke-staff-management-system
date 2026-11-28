---
topic: text-placement
kind: technical
summary: Add a text overlay, size and wrap it, place it in canvas pixels, and restyle it.
related: keyframing
unserved: captureFrame
---

## Purpose

How to put a title, label or callout on screen with `addText`, move it with `transformItem`, and restyle it with `editProperties`. Captions are a different item type: see `text/captioning`.

## When to load

- The user wants a title, lower line, label, quote or any free text on the video.
- You need to move, wrap, resize or restyle a text item that already exists.

## Workflow

1. Call `context` for the canvas size and an overlay track id. Create an overlay track with `manageTrack` if there is none.
2. If the user named a font, check it with `fonts` (`role: "titles"`, or `familyName`).
3. Call `addText` with `textContent`, `duration`, `trackId` (or `insertAfterItemId`), and either `bounds` or `maxWidth`.
4. Read `data.timelinePosition` (seconds) and, when you passed `bounds`, `data.resolvedBounds` with the measured `height`.
5. Move or centre it with `transformItem`; restyle it with `editProperties`.
6. Animate it with `writeKeyframes` (see `keyframing`), or give it an entrance with `textAnimation`.
7. Check the frame (see Verification).

## Tools and parameters

**`addText`** (box in canvas px, times in seconds)
- `textContent` (required) and `duration` (required in the schema; the handler uses the default in the table when it is missing).
- `bounds {x, y, width}`: top-left corner and wrap width. The height is measured from the font, size and width. Do not pass a different `maxWidth` with it.
- `maxWidth`: wrap width when `bounds` is not used. Without `bounds` the box is centred on the canvas.
- `font`: the family or face name, for example `Roboto` or `Roboto-Bold`. A face name also sets the weight and style.
- `fontSize` (px), `color`, `backgroundColor` (hex).
- `textAnimation`: a preset name, or `{preset, speed?, durationMs?}`.
- `trackId` + `timelineStart`, or `insertAfterItemId` (which pushes later items right and cannot be combined with the other two).
- `look`: a ready text style `{style?, effect?, color?}`, or `null` to remove it.
  - `style`: `classic-outline`, `double-outline`, `neon`, `poster`, `soft-shadow` or `retro`. `effect`: `glow`, `drop` or `echo`.
  - `color` (`#rrggbb`) recolours the style and needs one; choosing a different style resets it.
  - The style's plain parts (font, case, letter spacing, colour, border) are written first; explicit fields in the same call win.
  - An unknown id is `UNKNOWN_TEXT_STYLE` or `UNKNOWN_TEXT_EFFECT` (the message lists the valid ids); another key or a bad colour is `INVALID_PROPERTY_VALUE`.

**`transformItem`** on text: `x`, `y` (top-left, px), `scale`, `scaleBy`, `rotation` (deg), `center`, `centerX`, `centerY`, and the two text-only bands `alignTop` and `alignBottom` (both also centre horizontally).

**`editProperties`** on text, inside `properties`:
- `text`, `fontFamily`, `fontSize` (number or string), `fontWeight`, `fontStyle`, `color`, `backgroundColor`.
- `textAlign`, `textDecoration`, `textTransform`, `lineHeight` (number or `normal`), `letterSpacing`, `wordSpacing`, `wordWrap`, `wordBreak`.
- `opacity`, `scale`, `rotation`, `positionX`, `positionY`, `borderWidth`, `borderColor`, `boxShadow`, `blendMode`, `textAnimation`.
- `look`: as in `addText`. Fields you leave out keep the current look; set `style` or `effect` to `null` to drop just that part.

## Positions and safe bands

- `positionX` and `positionY` are the top-left corner of the text box, in canvas pixels from the top-left of the canvas. They are not centre points.
- Cutframe has no drawn safe-area overlay and no tool refuses text near an edge. Its only placement bands are `transformItem`'s `alignTop` (the box ends at the top band line) and `alignBottom` (the box starts at the bottom band line), with the lines given in the table as a share of canvas height.
- To keep text clear of platform buttons, read the canvas size from `context` and place the box yourself.

## Units and limits

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:text.agentFontSizeDefault | 100 | px | `addText` font size when `fontSize` is omitted |
| fact:text.agentWrapWidthShare | 0.6 | fraction | Default wrap width as a share of canvas width |
| fact:text.agentDurationDefaultS | 3 | s | Length used when `duration` is missing |
| fact:text.maxDurationS | 300 | s | Longest text item `addText` accepts (the shortest is one frame) |
| fact:text.alignTopBandShare | 0.3 | fraction | `alignTop`: the box's bottom edge sits at this share of canvas height |
| fact:text.alignBottomBandShare | 0.7 | fraction | `alignBottom`: the box's top edge sits at this share of canvas height |
| fact:text.animationSpeedMin | 0.25 | factor | Slowest `textAnimation.speed` |
| fact:text.animationSpeedMax | 4 | factor | Fastest `textAnimation.speed` |
| fact:text.animationDurationMaxMs | 10000 | ms | Longest `textAnimation.durationMs` (whole-item presets only) |
| schema:transformItem.rotation.minimum | -360 | deg | Smallest rotation |
| schema:transformItem.rotation.maximum | 360 | deg | Largest rotation |
| schema:editProperties.properties.textAlign.enum | ["left","center","right","justify"] | none | Text alignments (text items accept `justify`; captions do not) |
| schema:editProperties.properties.textTransform.enum | ["none","uppercase","lowercase","capitalize"] | none | Letter case |
| schema:editProperties.properties.wordWrap.enum | ["normal","break-word","anywhere"] | none | Wrap rule |

## Verification

- `context` shows the item, its track and its start and end.
- `captureFrame` is not served in this build. Ask the user to check the preview at a time inside the item: no line cut off, no face covered, text readable against the background.
- After `transformItem`, read `context` again for the item's new position.

## Pitfalls

- **`font` vs `fontFamily`.** `addText` takes `font`; `editProperties` takes `fontFamily`. Each schema is closed, so the other name is refused with `INVALID_TOOL_INPUT`.
- **Unknown font.** `FONT_NOT_FOUND`, with a suggestion. Call `fonts` and use a listed family.
- **Text width and height cannot be keyframed.** Animate `scale`, `positionX`, `positionY`, `opacity` or `rotation` instead.
- **Box size comes from the text.** To make text bigger, change `fontSize` or `scale`, not `height`.
- **Per-character presets** (`typewriter`, `scramble`, `step-fade`) take `speed` only; `durationMs` on them is `INVALID_TEXT_ANIMATION`.
- **Edit in place.** Change an existing text with `editProperties` instead of deleting and re-adding it, so its keyframes and animation stay.
- **Overlaps.** A start that collides with another item on the track is `TRACK_OVERLAP`; a locked track is `TRACK_LOCKED`.
