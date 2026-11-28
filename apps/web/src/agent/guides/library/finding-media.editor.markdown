---
topic: finding-media
kind: technical
summary: Finding the right footage: listing and searching project and library assets, reading asset details, processing states and references.
related: timeline
unserved: viewProjectAssets, searchProjectAssets, searchUserLibrary, addAssetToProject, viewReferenceVideo, viewReferenceFrame
unimplemented: viewItemDetails.include=general, viewItemDetails.include=analysis
---

# Finding media

## Purpose

How to find the material for an edit: list the project's assets, search them by meaning, date or place, search the user's whole library, and check what each asset holds before you place it.

## When to load

- Before choosing clips for a cut, b-roll or music.
- When the user describes footage ("the shot of the harbour") instead of naming a file.

## Workflow

1. **Asset tools are not served in this build.** `viewProjectAssets`, `searchProjectAssets`, `searchUserLibrary`, `addAssetToProject`, `viewReferenceVideo` and `viewReferenceFrame` are not served yet. Fallback: ask the user which file to use (by its asset id, such as `video_1`), and take the ids of media already placed from `context`.
2. Before placing a clip, read it with `viewItemDetails {assetId}`: transcript words with times (`include: "transcript"`), or beats for music (`include: "beats"`).
3. Place it with `addMedia` (see `assembly/timeline`).
4. Plan ahead: once the asset tools are served, list the project's media first, search it by description, then search the library, using the blocks below.

## Tools and parameters

- `viewItemDetails {assetId | assetIds | itemId | itemIds, include?}` (served)
  - `include` values in this build: `transcript`, `keyframes`, `masks`, `beats`.
  - Asset reads give source time.
  - Item reads place each word at the item's start plus (source time minus trim start), without the playback rate. On a clip at normal speed these are timeline times; on a sped-up or slowed clip they are not.

**Plan-ahead blocks:** `viewProjectAssets`, `searchProjectAssets` and `searchUserLibrary` are not served in this build; until they are, use the fallback in the first Workflow step (ask the user which file to use).

- `viewProjectAssets {limit?, page?, sortBy?, order?, previews?}` (not served yet; fallback: ask the user)
  - `sortBy`: `recordedAt` (default) or `duration`; `order`: `asc` (default) or `desc`.
  - Pages after the first need `limit`.
  - Media already in the project carries an `agentId` (`video_1`, `audio_2`, `image_3`): the id timeline tools take.
  - Template media not yet in the project carries an `assetId` instead; `addAssetToProject` (not served yet; fallback: ask the user to add the file) gives it an `agentId`.
- `searchProjectAssets {query?, assetType?, dateFrom?, dateTo?, location?, limit?, page?, previews?}` (not served yet; fallback: ask the user)
  - Write `query` as one or two sentences about one visual idea, as it would look on screen. Leave names, brands, places and dates out of it; use `location`, `dateFrom` and `dateTo` for those.
  - With no `query` it returns every asset that matches the filters.
  - More pages are signalled by `metadata.nextPage`.
- `searchUserLibrary {query?, assetType?, dateFrom?, dateTo?, location?, folder?, limit?, page?, previews?}` (not served yet; fallback: ask the user)
  - Works with no project open. A bare call (no arguments) returns the folder tree and recent uploads.
  - `folder` takes a full path (`A/B`) or a unique folder name. An unknown name returns the real folder paths.
  - Results carry `folderPath`.

## Units and limits

- Plan-ahead, for the search tools once served: pages hold 20 results by default, and `limit` goes up to 50.
- Plan-ahead: a bare library search lists the 10 most recent uploads.

## Processing states

An asset that is not fully processed carries `capabilities`, one value per step (`analysis`, `transcript`, `search`):

- `ready`: the data exists.
- `pending`: still being made; check again shortly.
- `never`: it will not exist (a silent clip has no transcript).
- `failed`: that step failed; the asset's other data may be fine.
- `unavailable`: the local models that make it are not installed on this device.

Search can match only indexed assets. Assets still being indexed come back in `pending`, so a short result list does not prove the footage is missing. Say so to the user instead of concluding it is not there.

## References vs footage

- Reference videos are style input only: pacing, framing, look. They never go on the timeline; project assets are the footage. Never mix the two up.
- `viewReferenceVideo` and `viewReferenceFrame` are not served yet, and references are never listed with the project's assets. Fallback: ask the user to describe the reference's pacing and look.

## Verification

- Before placing, confirm the asset type matches the track you plan to use (audio on an audio track; video and image on a video track).
- For speech, read the transcript to confirm the words are in the clip before you trim to them.
- After placing, check `resolvedTrim` in the `addMedia` result.

## Pitfalls

- **Asset ids and item ids.** `addMedia` `assetId` and `syncAndSwap` `sourceAssetId` take asset ids; `syncAndSwap` `targetItemId` takes a timeline item id. Items on the timeline have their own ids.
- **Removed or template assets.** The code depends on the tool. `addMedia` fails with `VALIDATION_FAILED`, and `data.failures[].code` is `MEDIA_NOT_FOUND`. `viewItemDetails` answers `ITEM_NOT_FOUND`, or `TEMPLATE_ASSET_NOT_IN_PROJECT` for a template asset id. The user may have removed the file; `addAssetToProject` is not served yet, so ask the user to add or pick the file.
- **General reads.** For media, `viewItemDetails` without `include` (the `general` view) and `include: "analysis"` return `NOT_IMPLEMENTED` in this build. Pass an `include` from the list above.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:search.defaultLimit | 20 | count | Results per search page when `limit` is omitted |
| fact:search.maxLimit | 50 | count | Largest `limit` a search accepts |
| fact:library.recentDefault | 10 | count | Recent uploads listed by a bare library search |
