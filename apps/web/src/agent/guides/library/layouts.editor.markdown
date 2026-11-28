---
topic: layouts
kind: technical
summary: Split screens, grids, picture-in-picture and feature layouts: presets, cells, cell trims in milliseconds and fill modes.
related: timeline
unimplemented: viewItemDetails.include=general
---

# Layouts

## Purpose

A layout is one overlay item that shows several cells at once: a split screen, a three-way split, a grid, a picture-in-picture or a feature layout. Each cell holds one video or image. This guide covers placing layouts and editing their cells.

## When to load

- Before any split-screen, grid, picture-in-picture or side-by-side composition.
- When the user asks to show two or more clips at the same time.

## Workflow

1. Call `context` and find an overlay track with free time, or create one with `manageTrack {action: "create", kind: "overlay"}`.
2. Pick a preset (`layoutType`) and list the cells in the preset's order.
3. Call `addLayout` with the cells you can fill now. Cells you omit stay empty.
4. Read `filledCells` in the result and compare it with the number of cells you filled.
5. Change cells later with `editLayout`, passing only the cells that change.

## Tools and parameters

- `addLayout {layoutType, trackId | insertAfterItemId, timelineStart?, duration?, gap?, borderRadius?, cells?}`
  - `layoutType`: `split-horizontal`, `split-vertical`, `three-horizontal`, `three-vertical`, `grid-2x2`, `pip-top-right`, `pip-top-left`, `pip-bottom-right`, `pip-bottom-left`, `feature-left`, `feature-right`.
  - `trackId` must be an overlay track. `insertAfterItemId` places the layout at the end of a text, shape, motion-graphic or layout item and pushes later items right; it cannot be combined with `trackId` or `timelineStart`.
  - `timelineStart` and `duration` are timeline seconds; `gap` and `borderRadius` are canvas px.
  - `cells[]`, in preset cell order: `{assetId?, fillMode?, trim?, volume?}`. An empty object leaves that cell empty.
- `editLayout {itemId, gap?, borderRadius?, cells?}`
  - `cells[]`: `{index, assetId?, fillMode?, trim?, volume?}`. `index` counts from zero in preset order. `assetId: null` empties a cell.
- Cell fields:
  - `assetId`: a project video or image asset id.
  - `fillMode`: `fill` covers the cell and may crop; `fit` shows the whole frame and may leave bars.
  - `trim {from, to}`: the source range for a video cell, in **source milliseconds**.
  - `volume`: the cell's audio level in percent; 100 plays as recorded.

## Cell order

- Split and three-way presets: left to right, or top to bottom.
- `grid-2x2`: top-left, top-right, bottom-left, bottom-right.
- `pip-*`: the full-frame cell first, then the inset.
- `feature-left` / `feature-right`: the large cell first, then the upper and lower small cells.

## Units and limits

- A layout lasts 10 s unless you pass `duration`, and starts at 0 s unless you pass `timelineStart`.
- `gap` and `borderRadius` default to 0 px.
- A preset has at most 4 cells.
- Cell `volume` runs from 0 to 200 percent and defaults to 100 percent.
- Cell `fillMode` defaults to `fill`. This differs from media placed with `addMedia`, which defaults to `fit`.

## Clocks

- Cell `trim` is source **milliseconds**, while every other layout time is seconds. Multiply source seconds by a thousand.
- `addMedia` trims are source seconds. Convert when you move a clip into a cell.

## Verification

- `filledCells` must equal the number of cells you gave media.
- `timelinePosition {start, end}` must match the time you intended.
- Both tools return the layout's summary in `data` (`layoutType`, `cellCount`, `filledCells`, `gap`, `borderRadius`). In this build that summary is the read-back: `viewItemDetails` has no layout view yet.

## Pitfalls

- **Bad cell asset.** An asset that is missing or not video or image fails the whole call with `INVALID_CELL_ASSET`; nothing is placed. Check the asset type first.
- **Trim needs a video.** A cell `trim` on an empty or image cell fails with `INVALID_COMBINATION`. Give `assetId` with the trim, or trim a cell that already holds video.
- **Trim range.** `to` must be greater than `from` (`INVALID_TRIM_RANGE`) and must not pass the source end (`TRIM_EXCEEDS_SOURCE`).
- **Too many cells.** More cells than the preset holds, or an `index` past the last cell, fails with `CELL_INDEX_OUT_OF_RANGE`.
- **Occupied time.** A range already taken on the track fails with `TRACK_OVERLAP`; the message names the first free start and other free overlay tracks.
- **Wrong track kind.** Layouts go on overlay tracks only (`INVALID_TRACK`).

| Check | Value | Unit | Meaning |
|---|---|---|---|
| schema:addLayout.layoutType.enum | ["split-horizontal","split-vertical","three-horizontal","three-vertical","grid-2x2","pip-top-right","pip-top-left","pip-bottom-right","pip-bottom-left","feature-left","feature-right"] | none | Layout presets |
| schema:addLayout.cells[].fillMode.enum | ["fill","fit"] | none | How media sits in a cell |
| schema:addLayout.cells[].volume.minimum | 0 | percent | Lowest cell volume |
| schema:addLayout.cells[].volume.maximum | 200 | percent | Highest cell volume |
| schema:editLayout.cells[].volume.maximum | 200 | percent | Highest cell volume when editing |
| fact:layout.defaultDurationS | 10 | s | Layout length when `duration` is omitted |
| fact:layout.defaultTimelineStartS | 0 | s | Layout start when `timelineStart` is omitted |
| fact:layout.defaultGapPx | 0 | px | Default `gap` and `borderRadius` |
| fact:layout.maxCells | 4 | count | Most cells in any preset |
| fact:layout.cellVolumeDefault | 100 | percent | Cell volume when omitted |
| fact:layout.cellFillModeDefault | "fill" | none | Cell `fillMode` when omitted |
| fact:timeline.itemFramingDefault | "fit" | none | How `addMedia` frames media on the canvas |
