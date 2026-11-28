---
topic: timeline
kind: technical
summary: Assembly mechanics: clocks, tracks, placing media, trims, splits, moves, deleting and the change report.
related:
---

# Timeline assembly

## Purpose

How to build and change the edit: create tracks, place media, trim, split, move and delete items, and read the change report each call returns.

## When to load

- Before assembling a cut, rearranging clips or cleaning up tracks.
- `assembly/short-form`, `assembly/long-form` and `vlog` load this guide first, then their creative default.

## Workflow

1. Call `context` and note the track ids, item ids and the time span you will touch.
2. No compatible track? Create one with `manageTrack {action: "create", kind}`. Kinds: `video`, `audio`, `caption`, `overlay`.
3. Place media with `addMedia`. One call places one asset or a back-to-back batch (`items[]`) on one track.
4. Shape the cut with `trimItem`, `splitItem`, `slipItem`, `moveItem`, `reorderItems`, `changeTrack`, `cloneItem` and `deleteItems`.
5. Read `timelineChanges` in every result and confirm it matches what you meant.
6. Tidy up with `consolidateTracks` only when the user wants fewer tracks.

## Clocks

Each field names its clock. Mixing them is the most common error.

- Timeline seconds: `timelineStart`, `from`, `to`, `by`, `at`, `timestampS`, `deltaSeconds`.
- Source seconds: `addMedia` `trimStart` and `trimEnd` (in- and out-point inside the asset), and `slipItem` `slipSeconds` (a shift of the source window, not scaled by playback speed).
- Source milliseconds: layout cell `trim {from, to}` (see `assembly/layouts`).
- `setTimeRemap`: `time` in timeline seconds, `value` in source milliseconds (see `time-remapping`).

## Tools and parameters

- `manageTrack {action, trackId?, kind?, name?, position?, relativeToTrackId?, toIndex?, groupId?, value?, volume?, deleteItems?}`
  - Actions: `create`, `delete`, `mute`, `solo`, `lock`, `hide`, `volume`, `rename`, `reorder`.
  - `position`: `top`, `bottom`, `above`, `below` (the last two need `relativeToTrackId`). `toIndex` counts from the bottom.
  - Deleting a track that holds items needs `deleteItems: true`.
- `manageTrackGroup {action, groupId?, name?, trackIds?, toIndex?, value?}`: groups adjacent tracks. `ungroup` keeps the tracks; `delete` removes them with their items.
- `addMedia {assetId | items[], trackId | insertAfterItemId, timelineStart?, duration?, trimStart?, trimEnd?, bounds?}`
  - Batch items chain back-to-back from `timelineStart` in input order. `trackId` and `timelineStart` are top-level fields, never inside `items[]`.
  - Video and image may share a call; audio needs its own call on an audio track.
  - `insertAfterItemId` starts the batch at that item's end and pushes later items on its track right. It cannot be combined with `trackId` or `timelineStart`.
  - `bounds` keeps the aspect ratio and never crops.
  - Built-in elements (`element:<id>`) and sounds (`sound:<slug>`) are placed the same way.
- `trimItem {itemId, handle: "start" | "end", deltaSeconds, ripple?, rippleGroupId?}`: moves one edge. `ripple` shifts later items on the track by the delta actually applied.
- `splitItem {itemId, timestampS}`: the left piece keeps the id; the result gives `leftItemId` and `rightItemId`.
- `slipItem {itemId, slipSeconds}`: video and audio only. Shifts the source window; position and length stay. Keyframes stay on the timeline; masks follow the footage.
- `moveItem {itemId | itemIds, by? | to?, trackId?, beforeItemId? | afterItemId?}` or `{groupId, by}`. Never trims. A batch is all-or-nothing; `to` is for one item only.
- `reorderItems {itemIds, beforeItemId | afterItemId}`: opens a gap at the anchor and closes the gaps left behind.
- `changeTrack {itemId, trackId, from?}`: one item to another compatible track.
- `cloneItem {itemId, trackId, at?}`: copies effects, masks, keyframes, trim and asset. Default start is the source item's end.
- `deleteItems {itemIds, ripple?, rippleGroupId?}`: tracks stay even when emptied. Captions linked to a deleted clip are deleted with it.
- `consolidateTracks {trackIds?, deleteEmptyTracks?}`: packs items down onto lower tracks of the same kind without changing what is seen. Caption tracks are left out.

## Units and limits

- An image or element placed without `duration` lasts 3 s.
- A video or audio asset whose length is unknown is placed for 5 s.
- An item is never trimmed shorter than 50 ms.
- A trim edge stops at the source media's bounds; the result reports `appliedDeltaSeconds`.
- Track volume (`manageTrack` `volume`) runs from 0 to 1.
- Text in the change report is cut at 1000 chars; `textTruncated` and `textLength` mark the cut.

## The change report

Every mutating call that changed something returns `timelineChanges`, also on a failed call.

- Header: `basis` (net change over the call), `timeUnit` (`"seconds"`), `detailsOmitted`, `readBack`.
- Sections, each `{created, updated, deleted}`: `items`, `tracks`, `groups`, `transitions`, `markers`; plus `layerOrder` and `settings` (duration, fps, size).
- An `updated` entry has `changedFields`, `before` and `after`. Keyframe, effect and style changes appear only as field names; read their values back with `viewItemDetails`.
- No `timelineChanges` means nothing changed.

## Verification

- Compare `timelineChanges.items` with your intent: new ids, `from`/`to`, `trim`, `trackId`.
- After ripple edits, check `shiftedItemIds` and the later items' new times.
- The project duration follows the last item end; check `settings.duration` after large edits.
- For placement on the canvas, check `resolvedBounds` in the `addMedia` result.

## Pitfalls

- **Overlaps are refused.** `addMedia` fails with `OVERLAP_DETECTED`, `cloneItem` with `TRACK_OVERLAP`, `moveItem`, `changeTrack` and `trimItem` with `COLLISION`. The message names the blocking item; it gives the first free start, except for `trimItem`, whose message gives the free space left on that side. Nothing is applied.
- **Per-item `addMedia` failures.** A bad entry fails the whole call with top-level `VALIDATION_FAILED`; each bad entry's own code is in `data.failures[].code` (with its `assetId`). Nothing is placed.
- **Asset id, not item id.** `addMedia` takes asset ids (`video_1`); a timeline item id gives `TIMELINE_ID_NOT_ALLOWED` in `data.failures[].code`.
- **Locked tracks.** Moves, trims, splits, slips and ripple deletes on a locked track fail with `TRACK_LOCKED`. A plain `deleteItems` still deletes there, so check locks before deleting.
- **Trim at its limit.** A trim that cannot move the edge at all fails with `TRIM_AT_LIMIT`; a slip with `SLIP_AT_LIMIT`.
- **Captions** are never rippled by `trimItem` or `deleteItems`.
- **Groups.** `rippleGroupId` ripples only the group's tracks; an item that spans the edit boundary blocks it (`GROUP_RIPPLE_BOUNDARY_UNSET`). Split that item first.
- **Trimming by spoken words.** `addMedia` (top level or per entry in `items[]`) takes `transcriptRange` in place of numeric trims: `{text}` for one quote, or `{startText, endText}` for the span from the start quote to the first end quote after it. Case and punctuation are ignored, and the words must match exactly one place in the asset's transcript. The result reports `resolvedTranscriptRange` (`trimStart`, `trimEnd`, `duration`, `wordCount`, `matchedText`) on each placed entry. Refusals, with nothing placed:
  - `INVALID_COMBINATION`: `transcriptRange` given together with `trimStart`, `trimEnd` or `duration`.
  - `INVALID_TRANSCRIPT_RANGE`: neither `text` nor both `startText` and `endText`, or both forms at once.
  - `TRANSCRIPT_UNAVAILABLE`: the asset has no word times yet (still processing, or no speech). Read the transcript later with `viewItemDetails` (`include: "transcript"`), or pass numeric `trimStart` / `trimEnd`.
  - `TRANSCRIPT_RANGE_NOT_FOUND`: no span matches. Copy the exact wording from the transcript.
  - `AMBIGUOUS_TRANSCRIPT_RANGE`: the words match several places; `details.candidates` lists them with surrounding words. Quote more words.
  - `MEDIA_NOT_FOUND`: the asset is not in the project.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:timeline.toolImageDurationS | 3 | s | Default length of an image or element placed by `addMedia` |
| fact:timeline.unknownSourceDurationS | 5 | s | Placement length when a video or audio asset's length is unknown |
| fact:timeline.minItemMs | 50 | ms | Shortest length a trim leaves |
| schema:manageTrack.volume.minimum | 0 | fraction | Lowest track volume |
| schema:manageTrack.volume.maximum | 1 | fraction | Highest track volume |
| fact:changes.textMaxChars | 1000 | chars | Text kept per item in `timelineChanges` |
