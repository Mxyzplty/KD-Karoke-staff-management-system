---
topic: voice-over
kind: technical
summary: How a recorded voice-over enters the project, and how to edit, balance and caption it with the tools
related: audio, transcript-cleanup, captions
---

## Purpose

Work with narration the user records in Cutframe. Recording is done by the user in the editor's Voice Over panel; no agent tool records, and Cutframe has no generated (text-to-speech) voice. Once the take is in the project, you edit it like any other audio clip.

## When to load

- The user wants to add narration, or has just recorded a take.
- You need to place, trim, balance or caption a voice-over.

## What exists

- **Recording (user only).** The user opens the Voice Over panel, picks a microphone and presses Record. A countdown runs (table), then the timeline plays from the playhead while the take records, so the narration lines up with the picture. Stopping (or playback reaching its end or pausing) ends the take.
- **Placement (automatic).** The take is saved in the project as an audio asset and placed as one audio item at the playhead position where recording started, in one undo step. It goes on the first unlocked audio track that is free over the take; a new audio track is made only when none is. The item is named "Voiceover" plus the date and time of the take.
- **Transcription (automatic).** The take is transcribed like any imported audio, so its words become readable with `viewItemDetails`.
- **Not available:** an agent tool to start or stop recording, text-to-speech, and automatic ducking.

## Workflow

1. If there is no take yet, ask the user to record one in the Voice Over panel, and tell them where the playhead should be. Wait for them to say it is done.
2. Call `context` and find the audio item whose `start` is the playhead position where recording started. A `context` row gives only the item id and times, so keep that item id.
3. Read its words with `viewItemDetails` `itemId` and `include: "transcript"`. If `capabilities.transcript` is `pending`, read again shortly.
4. Clean it up: trim the head and tail with `trimItem`, and remove long pauses or retakes as in the transcript-cleanup guide.
5. Balance it: set its level with `editProperties` `properties.volume`, and duck the music under it with volume keyframes (audio guide).
6. Caption it if asked: `addCaptions` with `trackId` (a caption track) and `sourceItems` set to the voice-over item's id.
7. Verify (below).

## Tools and parameters

- **`context`**, **`viewItemDetails`**: find the item and read its words.
- **`trimItem`**, **`splitItem`**, **`deleteItems`**, **`moveItem`**: shape and place the take; `moveItem` with `by` nudges it in seconds.
- **`editProperties`** `properties.volume` and **`writeKeyframes`** on `volume`: level and ducking.
- **`addCaptions`**: `trackId`, `sourceItems`; captions from the take's transcript.

## Units and limits

- The take is as long as the stored recording, which can end a little before the panel's timer.
- Level follows the audio guide: gain = track gain × clip volume², with track volume as a fraction of full level.
- Recording needs microphone permission in the browser; if it is blocked, the panel offers a retry and the user must allow access.

## Verification

- `context`: the item starts where the user meant and does not overlap other speech on the same track.
- Re-read the transcript after cuts.
- Ask the user to listen to the narration against the music and the picture.

## Pitfalls

- Do not claim you can record or generate a voice. Ask the user to record.
- Moving the take after recording breaks its sync with the picture it was recorded against; move it only when the user asks.
- A take is local to this browser, like all project media.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:voiceover.countdownS | 3 | s | Countdown before a take starts recording |
