---
topic: multi-cam
kind: technical
summary: Multi-camera edits: syncing a second camera to a base clip by transcript overlap and cutting between angles with syncAndSwap.
related: timeline
---

# Multi-camera editing

## Purpose

Cut between camera angles of the same recording. `syncAndSwap` finds the time offset between a second camera and a base clip from the words spoken in both, then places the second camera, in sync, over a window of the timeline.

## When to load

- When the project holds several recordings of the same scene or talk.
- When the user asks to cut to another angle, add a close-up or switch cameras.

## Workflow

1. Call `context`. Place the base camera (usually the wide shot) on a video track with `addMedia`. Note its item id.
2. Create a second video track above it with `manageTrack {action: "create", kind: "video"}`. The upper track shows on top.
3. Decide each window where the other angle should show, in timeline seconds.
4. For each window, call `syncAndSwap {sourceAssetId, targetItemId, trackId, from, to}`.
5. Check `syncConfidence` and the placed item's times in the result (see Verification).
6. To change a window later, use `trimItem` on the placed item, or delete it and swap again. Never `moveItem` an angle in time: a move shifts its timeline position but not its source window, so it plays out of sync.

## Tools and parameters

- `syncAndSwap {sourceAssetId, targetItemId, trackId, from, to}`: all five are required.
  - `sourceAssetId`: the second camera's **asset** id (`video_2`), not a timeline item id.
  - `targetItemId`: the base clip on the timeline.
  - `trackId`: the video track that receives the second camera.
  - `from` / `to`: the window in timeline seconds; `to` must be greater than `from`.
- The result is `addMedia`'s result for one item, plus:
  - `syncOffset`: second-camera source time minus base source time, in seconds;
  - `syncConfidence`: from zero to one;
  - `syncMatches`: the number of words matched across the two transcripts.

## How sync works

- The offset comes from the two assets' stored transcripts, not from the audio waveform. Both assets need transcripts with word times.
- Cutframe places the second camera through the base item's own position and trim. The swap stays in sync wherever the base clip sits on the timeline and however it is trimmed.
- Only the part of the window the second camera actually covers is placed. If the second camera starts late or ends early, the placed item is shorter than the window; read its `from` / `to` in `timelineChanges`.

## Units and limits

- The sync is refused below a confidence of 0.5.
- At least 3 words must match across the two transcripts.
- The base clip must play at normal speed with no time remap.

## Verification

- `syncConfidence` near one means a strong match. Close to the minimum, check by ear or with the user.
- Read the placed item's `from`, `to` and `trim` in `timelineChanges.items.created`.
- Read the transcripts of the two timeline items with `viewItemDetails {itemIds: [baseItemId, swappedItemId], include: "transcript"}` and confirm a line spoken in the window lands at the same time in both. Both play at normal speed, so item transcript times are timeline times. Asset reads give source times, which differ by `syncOffset` by design.
- Usually only one angle's sound should play. Mute the duplicate audio with `editProperties {properties: {volume}}` on the swapped item, or keep the base audio track as the only sound.

## Pitfalls

- **Low confidence.** `SYNC_LOW_CONFIDENCE` (with `details.confidence`) means the transcripts do not overlap enough: different takes, music only, or little speech. Nothing is placed. Do not retry the same pair; ask the user, or line the angles up by hand.
- **Missing transcript.** `TRANSCRIPT_UNAVAILABLE` means an asset is still being processed or has too little speech. Wait for processing, or pick another clip. `ANALYSIS_UNAVAILABLE` means transcription is not set up on this device.
- **Item id instead of asset id.** `sourceAssetId` given a timeline item id fails with `TIMELINE_ID_NOT_ALLOWED`.
- **Base not at normal speed.** A remapped or sped-up base clip is refused with `INVALID_TOOL_INPUT`. Swap against an unremapped clip.
- **No footage in the window.** If the second camera has no footage there at the offset, the call fails with `INVALID_TRIM_RANGE`.
- **Placement failures** are `addMedia`'s: an occupied range (`OVERLAP_DETECTED`), a locked track (`TRACK_LOCKED`) or a wrong track kind (`INVALID_TRACK`).

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:multicam.minConfidence | 0.5 | fraction | Lowest sync confidence that is placed |
| fact:multicam.minMatchedWords | 3 | count | Fewest matched transcript words for a sync |
