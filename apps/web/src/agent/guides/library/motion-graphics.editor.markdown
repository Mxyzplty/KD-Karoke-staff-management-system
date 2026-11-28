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

1. `context`: pick an overlay track and a free time range, or an item to insert after. Note the canvas size.
2. Write the component (rules below). Lay it out from `itemWidth` and `itemHeight`, drive every motion from `useCurrentFrame()`.
3. `addMotionGraphic` with `code`, `summary`, the box `x`, `y`, `width`, `height` in canvas px (for full screen, the canvas size), `trackId` + `timelineStart` or `insertAfterItemId`, and `duration` or `animationDuration`.
4. Read the result: `itemId`, the placed `duration`, `cappedToDesignedLength` when the length was cut, and `fontWarnings` when a font is not in the catalogue.
5. To change it, `editMotionGraphic` with `action: "view"` first, then `patchCode` with exact replacements, or `updateCode` with the full new source. Update `summary` when the meaning changes.

## Tools and parameters

- `addMotionGraphic`: `code` (full source), `summary` (what the graphic shows, for people; one sentence, at most three), `x`, `y`, `width`, `height` (all required), `trackId` (an overlay track) or `insertAfterItemId` (never with `trackId` or `timelineStart`), `timelineStart` (seconds), `duration` (seconds), `animationDuration` (the designed length in seconds).
- Length: with `animationDuration` set, `duration` defaults to it and a longer `duration` is cut to it (`cappedToDesignedLength: true`). Without either, the default in the table applies. A longer graphic needs a new revision with a longer `animationDuration`.
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

## Units and limits

- The box and positions are canvas px; times on the timeline are seconds; inside the code, time is frames (`useCurrentFrame()`, at the project fps).
- `useVideoConfig()` gives the canvas `width` and `height`, and `durationInFrames` = the clip's length. Size the layout from `itemWidth` / `itemHeight`, the item box.
- `Sequence` re-bases the frame for its children; scenes inside `TransitionSeries` see the graphic's own frame, not re-based.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:mg.apiNameCount | 47 | count | Names injected into graphic code |
| fact:mg.summaryMaxChars | 400 | chars | Longest `summary` |
| fact:mg.defaultDurationSeconds | 5 | s | Length when neither `duration` nor `animationDuration` is given |
| fact:mg.codeMaxChars | 262144 | chars | Longest source |
| fact:mg.computeBudgetMs | 2000 | ms | Compute time allowed per frame |
| fact:mg.mediaBudgetMs | 4000 | ms | Media loading time allowed per frame |

## Verification

- Every add and edit compiles the code and renders its first frame in the sandbox before anything is written; a refusal changes nothing.
- Read back with `editMotionGraphic` `view` after patches.
- `captureFrame` is not served in this build. Ask the user to scrub the graphic in the preview, including its first and last frames.

## Pitfalls

- Be deterministic per frame: the same frame must always draw the same picture. Derive everything from `useCurrentFrame()`; do not animate with `useState` / `useEffect` timers, `Date` or `Math.random`. For variation, use `noise3D` with a fixed seed.
- `patchCode` with an `old_string` that does not match exactly fails the whole call with `STRING_NOT_FOUND`; the code is unchanged and `patches` shows each patch's status. Copy `old_string` from `view`, character for character.
- Native `<img>`, `<video>` and `<audio>` are refused (`VALIDATION_ERROR`): use `Img` / `OffthreadVideo` with `getAssetUrl("<agentId>")`. An id that is not an attached project asset is refused when the graphic is added.
- Refused as unsafe (`VALIDATION_ERROR`): links, forms, frames, scripts, `dangerouslySetInnerHTML`, `eval` and dynamic `import()`, async and generator functions, names beginning `__mg`.
- A syntax error, a helper after the export, or an error thrown while the first frame renders answers `COMPILATION_ERROR`.
- A frame over its budget fails with `MG_WATCHDOG`; avoid heavy loops per frame.
- A `fontFamily` outside the sandbox font catalogue still adds, with a FONT WARNING suffix and `fontWarnings`; the render falls back to a system font.
- An occupied range answers `TRACK_OVERLAP` with the next free start on that track and the free tracks.
- A summary that is empty or too long answers `MISSING_PARAM`.
