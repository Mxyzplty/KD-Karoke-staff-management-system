---
topic: music-sync
kind: technical
summary: Read a music track's tempo, beats and downbeats, and put cuts on the beat
related: audio, timeline
---

## Purpose

Read the rhythm of a music track and cut the picture to it. Beat data comes from the music's own analysis; you read it with `viewItemDetails` and move cuts with the timeline tools.

## When to load

- The user asks to cut on the beat, sync to the music, or match the tempo.
- You place music under a montage and want the cuts to land on beats or bars.

## Workflow

1. Call `context` and find the music item on an audio track, or use the music asset id.
2. Call `viewItemDetails` with `include: "beats"` and no range. You get `bpm` and `firstDownbeat` only. Use this to decide the cut rhythm (every beat, every bar, every half beat).
3. Call it again with `beatsFrom` and `beatsTo` around the part you are editing. You get the beats, downbeats and subdivisions inside that window.
4. List your current cut times (the `end` of each clip on the picture track, from `context`).
5. For each cut, find the nearest beat (or subdivision) within the snap tolerance. If two cuts would land on the same beat, move only the nearer one; leave the other where it is so no clip shrinks to nothing.
6. Move cuts from the earliest to the latest. For back-to-back clips, `trimItem` the left clip's `end` by the signed difference with `ripple: true`, so the following clips move with it. Call `context` again after each trim: a ripple moves every later cut.
7. Verify (below).

## Tools and parameters

- **`viewItemDetails`**: `itemId` / `itemIds` (timeline items) or `assetId` / `assetIds` (project assets), `include: "beats"`.
  - `beatsFrom` (inclusive) and `beatsTo` (exclusive): timeline seconds for an item, source seconds for an asset. Give both or neither; `beatsFrom` must be below `beatsTo`.
  - `minStrength`: drop beats weaker than this. Strength is the beat model's confidence, scaled per file so the strongest beat is 1. It is not loudness. Subdivisions are never filtered.
  - `subdivisionsPerBeat`: grid points between beats; use the triplet value for swing.
- **Result** (`data.beats`): `bpm`, `firstDownbeat` (may be null), and with a window `beats` and `downbeats` as `[time, strength]` pairs, plus `subdivisions {divisionsPerBeat, method: "interpolated", timestamps}`. Several targets give `data.beatsBySource` keyed by id, and `unavailable` for the ones without beats.
- **`trimItem`**: `itemId`, `handle: "start" | "end"`, `deltaSeconds`, `ripple`. The result's `appliedDeltaSeconds` says how far the edge really moved (it stops at the source edge).

## Units and limits

- Item beats are in timeline seconds: the item's trim and speed are applied, only the visible part of the source is listed, and `bpm` is multiplied by the playback rate.
- A gap between beats that spans a silence gets no subdivisions.
- Snap tolerance: a quarter of a beat is a good default. Widen it only when the user wants every cut on a beat.
- The reported `bpm` is the analysis tempo; it can differ from what the beat spacing suggests. Trust the `beats` list for cut times.

## Verification

- Read `context` again and compare each cut with the beat list.
- Ask the user to play through the montage and listen for cuts that feel early or late.

## Pitfalls

- Only `audio` items and assets tagged as music have beats. A video item gives `BEATS_NOT_AUDIO`; speech or sound gives `BEATS_NOT_MUSIC`. With one target these come back as success with `beats: null` and a `noBeats` reason.
- A music file still being analysed gives `BEATS_PROCESSING`: wait and read again. `BEATS_FAILED` means its analysis failed; cut by ear instead.
- A time-remapped item has no timeline rhythm: a window read gives `RHYTHM_TIME_REMAP_UNSUPPORTED`. Read the source asset instead and convert times yourself.
- Moving cuts latest-first with ripple works too, but earliest-first with a fresh `context` each time is easier to get right.
- No tool snaps cuts for you; the snapping is your arithmetic on the beat list.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| schema:viewItemDetails.minStrength.minimum | 0 | fraction | Weakest beat strength filter |
| schema:viewItemDetails.minStrength.maximum | 1 | fraction | Strongest beat strength filter (the file's strongest beat) |
| schema:viewItemDetails.subdivisionsPerBeat.enum | [2, 3, 4, "2", "3", "4"] | count | Allowed grid points per beat; 3 = triplets |
| fact:beats.subdivisionsDefault | 4 | count | Subdivisions per beat when not given |
| fact:beats.snapToleranceBeats | 0.25 | fraction | Suggested snap tolerance, as a share of one beat |
