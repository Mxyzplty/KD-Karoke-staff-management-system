---
topic: captions
kind: technical
summary: Generate captions from transcripts, restyle a caption track, pick a caption template, and fix caption text.
related: text-placement, keyframing
unserved: captureFrame
---

## Purpose

Captions in Cutframe are caption items on a caption track, built from the transcripts of the audible items on the timeline. This guide covers generating them (`addCaptions`), restyling a whole track (`editAllCaptionStyles`), choosing a ready look (`listCaptionTemplates`) and correcting one caption (`editProperties`).

## When to load

- The user asks for captions, subtitles, lyrics on screen, or one caption track per speaker.
- You need to restyle, re-time or correct captions that already exist.
- Free text overlays (titles, labels) are not captions: load `text/text-placement`.

## Workflow

1. Call `context` and find a caption track. If there is none, create one with `manageTrack`. `addCaptions` never creates the track for you.
2. Make the speech audible. A muted or hidden item, or one on a muted, hidden or un-soloed track, produces no words.
3. Optional: call `listCaptionTemplates` and pick a template id.
4. Call `addCaptions` with `trackId` (or `splitBySpeaker` with `speakerTrackIds`), plus `templateId` or your own style fields.
5. Read the result: `captionCount`, `captionIds`, and `inaudibleSources` with `warning: "INAUDIBLE_SOURCES"` when a muted or hidden source gave no words, and `unresolvedSources` when a source's transcript is not ready yet (still pending or missing), which also gives no words and no warning.
6. Restyle the whole track with `editAllCaptionStyles`.
7. Fix a wrong word by editing that caption's `text` with `editProperties`.
8. Check the result (see Verification).

## Tools and parameters

**`addCaptions`** (times in timeline seconds)
- `trackId`: the target caption track. Required unless `splitBySpeaker`.
- `splitBySpeaker` + `speakerTrackIds`: existing caption tracks, in detected-speaker order. Too few ids is refused with `INSUFFICIENT_TRACK_IDS`. Speakers are counted per source asset: the same person in two different assets is two speakers.
- `source`: which audio to caption. `speech` is the default, `music` captions lyrics, `all` captions everything transcribed. `sourceItems` overrides it. `speech` skips recorded voice-overs, with no warning: to caption narration, use `all` or name the voice-over items in `sourceItems`.
- `startTime`, `endTime`: a window on the timeline.
- `maxWords`, `maxCharacters`: chunk limits; defaults in the table. The agent path uses any number as given, with no clamp (the caption panel's sliders have their own range; this call does not). A non-number is refused by the schema with `INVALID_TOOL_INPUT`.
- `templateId`: a template from `listCaptionTemplates`.
- `font`, `fontSize`, `color`, `backgroundColor`, `borderColor`, `borderWidth`: the starting look.
- `reset`: replace the existing captions on the track(s).

**`editAllCaptionStyles`**
- `trackId` (required), then style keys flat beside it or inside `properties`, never both: when `properties` is given, flat style keys are ignored without a warning.
- Keys: `fontFamily`, `fontSize` (px), `fontWeight`, `fontStyle`, `color`, `backgroundColor`, `borderColor`, `borderWidth`, `highlightColor`, `lineHeight` (multiplier), `letterSpacing`, `opacity`, `boxShadow {blur, color, x, y}`, `blendMode`, `textAlign`, `textDecoration`, `textTransform`, `renderMode`, `textAnimation`.
- Colours also take `transparent` or `none`.
- It never changes caption text or word times.

**`listCaptionTemplates`**: no input. Each template gives `id`, `name`, `description`, `tags`, `accentColors`, `defaultColor`, `maxWords` and `maxCharacters`.

**`editProperties`** on one caption: `properties.text` replaces its text. On captions, `applyToAll: true` copies the changed style fields to the other captions on that track.

## How captions are cut

- A caption closes before the next word when it already holds `maxWords` words. `maxWords` is a ceiling, not a target: many captions hold fewer.
- It also closes when adding the next word would pass `maxCharacters` (spaces count; a word longer than the limit stays whole).
- It closes after a sentence end (`.`, `!`, `?`), before a conjunction (and, but, or, so, yet, for, nor, because), and at the boundary between two source items. Pauses, commas and speaker changes do not close it.
- A caption stays on screen after its last word for the hold time in the table, but never past the start of the next caption from the same source.

## Units and limits

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:caption.maxWordsDefault | 5 | count | Words per caption when neither `maxWords` nor a template is given |
| fact:caption.maxCharactersDefault | 35 | chars | Characters per caption when neither `maxCharacters` nor a template is given |
| fact:caption.holdAfterLastWordMs | 500 | ms | Longest time a caption stays after its last word ends |
| schema:addCaptions.source.enum | ["speech","music","all"] | none | The audio that `source` can pick |
| schema:editAllCaptionStyles.renderMode.enum | ["default","highlight","word-by-word","slide-up","slide-left"] | none | How words are revealed with the speech |
| fact:caption.textAlignValues | ["left","center","right"] | none | Alignments a caption accepts (`justify` is refused) |
| fact:caption.fontStyleValues | ["normal","italic"] | none | Caption font styles the handler accepts |
| fact:caption.opacityMax | 1 | fraction | Caption opacity runs from 0 to this |
| fact:caption.lineHeightMin | 0.5 | factor | Smallest caption line height |
| fact:caption.lineHeightMax | 3 | factor | Largest caption line height |
| fact:caption.borderWidthMax | 100 | px | Largest caption outline width |

- Caption word times are stored in milliseconds relative to the caption item's own start, not in timeline seconds. No caption tool takes word times. Moving a linked caption item (timeline seconds) shifts its words with it; trimming an edge keeps the words where they are and only changes which of them show.

## Verification

- `context` lists the new caption items with their start and end in timeline seconds.
- `viewItemDetails` on a caption gives its `caption` block: link mode, `renderMode`, `wordCount`, and for a linked caption its source item and speaker.
- `captureFrame` is not served in this build. To check that a caption is readable and does not cover the subject, ask the user to check the preview mid-sentence.
- If `inaudibleSources` is present, unmute or unhide those items and run `addCaptions` again.
- If `unresolvedSources` is present, those transcripts are not ready: tell the user, and run `addCaptions` again once transcription has finished.

## Pitfalls

- **Template limits win.** With `templateId`, the template's own word and character limits are used; `maxWords` and `maxCharacters` are ignored. Your style fields still apply on top of the template look.
- **No track, no captions.** A missing `trackId` returns `MISSING_TRACK_ID`; a non-caption track returns `INVALID_TRACK`; an unknown one `TRACK_NOT_FOUND`.
- **Fix, don't cover.** Correct a caption by editing its `text`. Never lay a text overlay on top of a caption.
- **Field names differ.** `addCaptions` takes `font`; `editAllCaptionStyles` takes `fontFamily`. An unknown font is `FONT_UNAVAILABLE` in `addCaptions` and `PROPERTY_VALIDATION_FAILED` in `editAllCaptionStyles`: call `fonts` with `role: "captions"` first.
- **Batches don't mix.** An `editProperties` batch cannot mix captions with other item types (`MIXED_CAPTION_BATCH`).
- **Splitting a caption** keeps its words on the right times in Cutframe; you do not need to re-time the halves.
- **A template id that does not exist** is `CAPTION_TEMPLATE_NOT_FOUND`.
