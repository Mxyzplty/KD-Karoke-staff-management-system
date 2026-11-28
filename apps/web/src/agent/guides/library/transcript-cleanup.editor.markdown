---
topic: transcript-cleanup
kind: technical
summary: Read word timings, then remove long pauses, filler words and retakes with split and ripple delete
related: timeline, captions
unimplemented: context.include=transcript, context.include=transcript_words
---

## Purpose

Tighten spoken footage by cutting at word boundaries: long pauses, filler words, false starts and retakes. You read the words with their times, plan the cuts, then split and ripple-delete.

## When to load

- The user asks to remove silences, dead air, "ums", repeated takes, or to tighten a talking-head edit.
- You need word-accurate cut points for any speech edit.

## Workflow

1. Call `context` to get the speech item ids and their `start` / `end` on the timeline.
2. Call `viewItemDetails` with `itemId` and `include: "transcript"`. You get `transcription.segments[]`, each with `start`, `end`, `text`, `speaker` and `words[] {word, start, end}`.
3. Plan the cuts on paper first:
   - **Pauses:** between one word's `end` and the next word's `start`, a gap longer than the pause threshold is a cut. Keep the kept gap: half of it after the last word, half before the next, and cut the middle.
   - **Fillers and retakes:** cut from the start of the first unwanted word to the start of the first kept word.
4. Make the cuts from the **latest to the earliest**, so earlier times stay valid. For each cut: `splitItem` at the cut's end, `splitItem` at its start, then `deleteItems` the middle piece with `ripple: true`.
5. Call `context` again and re-read the transcript of the result before any further cut.
6. Verify (below).

## Tools and parameters

- **`viewItemDetails`**: `include: "transcript"` on an item or an asset. On an item, times are timeline seconds; on an asset, source seconds. Only words that start inside the item's visible part are listed.
- **`context`**: `include: "transcript_words"` needs `startSeconds` and `endSeconds`; without both it is refused with `INVALID_TOOL_INPUT`. The transcript details of `context` are not implemented yet in this version (`NOT_IMPLEMENTED`); use `viewItemDetails` for words today.
- **`splitItem`**: `itemId`, `timestampS` (timeline seconds). Returns the ids of both pieces; the left piece keeps the original id.
- **`deleteItems`**: `itemIds`, `ripple: true` closes the gap and moves later items left, on that track only (outside a track group). B-roll, music and other tracks do not move, so they drift out of sync with the speech; fix them separately or ask first.
- No silence-removal tool is served to agents; you plan the cuts yourself (Workflow).

## Units and limits

- Word times sit on a fixed grid (table) and are reported in seconds to the millisecond.
- On an item, word times are item start + (source time − trim start), as if the clip played at normal speed. The playback rate is **not** applied, so on a sped-up or slowed clip they are not timeline times, and no served read gives the trim start you would need to convert them. Do not cut such a clip by word times; ask the user, or work at normal speed.
- Suggested thresholds: pause and kept gap from the table. The kept gap must not exceed the pause threshold.
- A cut that would be shorter than one frame is not worth making; skip it.

## Captions after a cut

- Captions linked to a speech clip are split along with it. After the deletes, list the caption items (`context` with `types: "caption"`) and check none is left over a removed part.
- Splitting a caption itself (`splitItem` on a caption) keeps each word on the piece where it is spoken, and the right piece's word times are rebased to its own start. Xapp leaves them unrebased; Cutframe fixes this, so no manual re-timing is needed.
- Caption word times are stored relative to the caption item, in milliseconds.

## Verification

- Re-read the transcript after the cuts: no gap between words should exceed the threshold, and no kept word should be clipped.
- Ask the user to play each cut point and listen for a clipped first or last syllable.

## Pitfalls

- Working earliest-first shifts every later time after each ripple delete. Go latest-first, or re-read after every cut.
- Time-remapped clips have no simple source-to-timeline mapping; ask before cutting them by words.
- `capabilities` appears only when a step is not ready. `capabilities.transcript`: `pending` = still being processed, read again later; `never` = no transcript will exist (the step was skipped or never ran); `failed` = transcription failed, other analysis may be fine; `unavailable` = the local models are not available on this device. Only `pending` is worth waiting for.
- Retakes need judgement: confirm with the user which take to keep before deleting.
- Never cover a caption mistake with a new text item; edit the caption's `text` with `editProperties`.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:transcript.wordGridMs | 20 | ms | Grid that word start and end times sit on |
| fact:silence.pauseS | 0.75 | s | Suggested pause threshold: a longer gap is cut |
| fact:silence.keptGapS | 0.35 | s | Suggested gap left in place of a cut pause, split evenly on both sides |
