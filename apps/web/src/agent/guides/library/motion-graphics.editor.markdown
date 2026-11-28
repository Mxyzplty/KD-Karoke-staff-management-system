---
topic: motion-graphics
kind: technical
summary: Write, place, read and patch code-mode motion graphics: a Remotion-style React component, its compile rule, its API and its editable fields.
related: keyframing
unserved: captureFrame
---

## Purpose

Build animated graphics that no preset covers (titles, charts, counters, kinetic shapes, framed media) as code. A motion graphic is a React component in the style of Remotion, rendered frame by frame in a sandbox, the same way in the preview and in the export.

## When to load

- The user asks for a custom animated graphic, an animated chart or a designed title sequence.
- You need to read, fix or change the code of an existing motion graphic.

## Workflow

1. `context`: pick an overlay track and a free time range, or an overlay item (text, shape, graphic) to insert after. Note the canvas size.
2. Write the component (rules below). Lay it out from `itemWidth` and `itemHeight`, drive every motion from `useCurrentFrame()`.
3. `addMotionGraphic` with `code`, `summary`, the box `x`, `y`, `width`, `height` in canvas px (for full screen, the canvas size), `trackId` + `timelineStart` or `insertAfterItemId`, and `duration` or `animationDuration`.
4. Read the result: `itemId`, the placed `duration`, `cappedToDesignedLength` when the length was cut, and `fontWarnings` when a font is not in the catalogue.
5. To change it, `editMotionGraphic` with `action: "view"` first, then `patchCode` with exact replacements, or `updateCode` with the full new source. Update `summary` when the meaning changes.

## Tools and parameters

- `addMotionGraphic`: `code` (full source), `summary` (what the graphic shows, for people; one sentence, at most three), `x`, `y`, `width`, `height` (all required), `trackId` (an overlay track) or `insertAfterItemId` (an overlay item: after video, image, audio or caption it answers `INSERT_AFTER_TYPE_MISMATCH`; later items on its track move right; never with `trackId` or `timelineStart`; to start at a clip's end, use `trackId` + `timelineStart`), `timelineStart` (seconds), `duration` (seconds), `animationDuration` (the designed length in seconds).
- Length: with `animationDuration` set, `duration` defaults to it and a longer `duration` is cut to it (`cappedToDesignedLength: true`). Without either, the default in the table applies. `editMotionGraphic` takes no `animationDuration` and trimming cannot pass the designed length: for a longer graphic, add it again with a longer `animationDuration` (copy the code from `view`), then delete the old item.
- `editMotionGraphic`: `itemId`, `action` = `view` (default, read-only: returns `code` and `summary`), `patchCode` (`patches: [{old_string, new_string}]`) or `updateCode` (`code`). `summary` is required when the item has none.
- `patchCode` applies each patch in order to the result of the previous one, replacing the first exact match.

### The compile rule

- End the code with the component as the last statement: `export const <Name> = (…) => { … };`. Put every helper, constant and sub-component above it. Nothing may follow it, and `export default` is refused.
- Do not write `import` lines: they are dropped, and the API names are already in scope.

### The API (the names below and nothing else)

- React: `React`, `useState`, `useEffect`, `useMemo`, `useRef`, `useCallback`.
- Core: `AbsoluteFill`, `interpolate`, `interpolateColors`, `useCurrentFrame`, `useVideoConfig`, `spring`, `Easing`, `Sequence`, `Img`, `OffthreadVideo`.
- Shapes: `Rect`, `Circle`, `Triangle`, `Star`, `Polygon`, `Ellipse`, `Heart`, `Pie` and their `make…` functions (`makeRect` … `makePie`).
- Paths and noise: `evolvePath`, `interpolatePath`, `noise3D`.
- Transitions: `TransitionSeries`, `linearTiming`, `springTiming`, `fade`, `slide`, `wipe`.
- Other: `Lottie`, `ThreeCanvas`, `getAssetUrl`, `itemWidth`, `itemHeight`, `editable`.
- Remotion's `Series` is not exposed: chain scenes with `Sequence` (`from` offsets) or `TransitionSeries`.
- Remotion options follow its public API of the pinned version; an option outside it fails with `UNSUPPORTED_OPTION`.

### Editable fields

- `editable(name, default, meta?)` declares a field the user can edit in the inspector's Fields section and returns its current value.
- Types: `text`, `number`, `color`, `boolean`, `text[]`, `font`, `select`. Set `meta.type`, or it is inferred (an array default is `text[]`, else the default's own type). `meta.label` names the control; `meta.options` lists the `select` choices.
- A value of the wrong type fails the render, so give a default of the declared type.
- When you edit the code, keep each field's name and type: the user's value stays, and the add / edit check uses only defaults, so a changed type passes the edit and then fails every frame with `MG_RENDER_FAILED`. To change a type, rename the field.

## Units and limits

- The box and positions are canvas px; times on the timeline are seconds; inside the code, time is frames (`useCurrentFrame()`, at the project fps).
- `useVideoConfig()` gives the canvas `width` and `height`, and `durationInFrames` = the clip's length. Size the layout from `itemWidth` / `itemHeight`, the item box.
- `Sequence` re-bases the frame for its children; scenes inside `TransitionSeries` see the graphic's own frame, not re-based.
- The sandbox draws one font family: `Roboto`, at the weights in the table. Use `fontFamily: "Roboto, sans-serif"`. The `fonts` tool lists title and caption fonts, not graphic fonts.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:mg.apiNameCount | 47 | count | Names injected into graphic code |
| fact:mg.summaryMaxChars | 400 | chars | Longest `summary` |
| fact:mg.defaultDurationSeconds | 5 | s | Length when neither `duration` nor `animationDuration` is given |
| fact:mg.codeMaxChars | 262144 | chars | Longest source |
| fact:mg.computeBudgetMs | 2000 | ms | Host watchdog per frame; graphic code itself stops at the two caps below |
| fact:mg.sandboxComputeMs | 1700 | ms | Graphic code time per frame |
| fact:mg.stepsMax | 200000 | count | Function calls plus loop iterations per frame |
| fact:mg.mediaBudgetMs | 4000 | ms | Media loading time allowed per frame |
| fact:mg.mediaLoadMaxMs | 1800 | ms | Longest wait for one `Img` / `OffthreadVideo` load |
| fact:mg.elementsMax | 2000 | count | Elements in one drawn frame |
| fact:mg.canvasMaxPixels | 16777216 | count | Largest canvas or box area (width × height, in pixels) |
| fact:mg.fontWeights | [400, 700] | none | `Roboto` weights the sandbox draws |

## Verification

- Every add and edit compiles the code and runs the component once at its first frame (hooks stubbed, media and 3D skipped, later scenes not run) before anything is written; a refusal changes nothing. It does not draw the frame: errors in later scenes, media or the element count show only in the preview (`MG_RENDER_FAILED`, or the limit's own code).
- Read back with `editMotionGraphic` `view` after patches.
- `captureFrame` is not served in this build. Ask the user to scrub the graphic in the preview, including its first and last frames.

## Pitfalls

- Be deterministic per frame: the same frame must always draw the same picture. Derive everything from `useCurrentFrame()`; do not animate with `useState` / `useEffect` timers, `Date` or `Math.random`. For variation, use `noise3D` with a fixed seed.
- `patchCode` with an `old_string` that does not match exactly fails the whole call with `STRING_NOT_FOUND`; the code is unchanged and `patches` shows each patch's status. Copy `old_string` from `view`, character for character.
- Native `<img>`, `<video>` and `<audio>` are refused (`VALIDATION_ERROR`): use `Img` / `OffthreadVideo` with `getAssetUrl("<agentId>")`. An id that is not an attached project asset is refused when the graphic is added.
- Refused as unsafe (`VALIDATION_ERROR`): links, forms, frames, scripts, `dangerouslySetInnerHTML`, `eval` and dynamic `import()`, async and generator functions, names beginning `__mg`.
- A syntax error, a helper after the export, or an error thrown during that first-frame check answers `COMPILATION_ERROR`; an error thrown in a real render answers `MG_RENDER_FAILED`.
- A frame whose code runs past 1700 ms or 200,000 steps (function calls plus loop iterations) fails with `MG_WATCHDOG`; the host watchdog in the table is only the backstop. Avoid heavy loops per frame. Each `Img` / `OffthreadVideo` load waits at most 1800 ms, inside the media budget.
- A frame with more than 2000 elements, a canvas or box whose area (width × height) is over the largest area in the table, heap growth past its budget, or a source over the longest-source limit fails with `MG_MEMORY_LIMIT`. The element count is checked only when a frame is drawn, not when the graphic is added.
- A `fontFamily` outside the sandbox font catalogue still adds, with a FONT WARNING suffix and `fontWarnings`; the render falls back to a system font.
- An occupied range answers `TRACK_OVERLAP` with the next free start on that track and the free tracks.
- A summary that is empty or too long answers `MISSING_PARAM`.
