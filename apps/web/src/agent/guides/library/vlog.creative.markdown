---
topic: vlog
kind: creative
summary: Craft defaults for vlogs: a talking head with b-roll, jump cuts, and a music bed under speech.
related:
unserved: captureFrame, searchProjectAssets, searchUserLibrary
---

## Purpose

How a vlog is usually cut: the person on camera tells the story, b-roll shows it, jump cuts keep it moving, and a quiet music bed holds it together. This is editing advice, not a rule set. The mechanics are in `assembly/timeline`, `audio/transcript-cleanup` and `audio/mixing`.

## When to use

- The footage is mostly one person speaking to camera, with clips of places, objects or activities.
- The user asks for a vlog, a diary, a day-in-the-life or a travel log.
- For a vertical vlog, also follow the `assembly/short-form` creative default for text bands and the hook.

## Structure

1. **Hook.** The most interesting line or sight of the day, first.
2. **Context.** Where we are and what is happening.
3. **Story.** The events in order, the talking head carrying the thread and b-roll showing each thing mentioned.
4. **Reflection.** A short closing thought to camera.
5. **Sign-off.** Brief.

- Read the speech with `viewItemDetails` (include `transcript`) and cut the story from it before placing b-roll.
- Find b-roll for each thing mentioned. `searchProjectAssets` is not served in this build: ask the user which file to use, then read it with `viewItemDetails`.

## Pacing

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Hook lands within | 5 | s | The viewer decides early whether the day is worth watching |
| Talking-head stretch before b-roll | 5–10 | s | Faces build connection; b-roll keeps it moving |
| B-roll clip length | 2–4 | s | Long enough to see, short enough to stay lively |
| Punch-in on a jump cut | 110–120 | percent | Hides the jump without looking like a new shot |
| Pause left between sentences | 0.1–0.3 | s | Tight but still natural |

- Jump cuts: remove pauses, fillers and retakes with `audio/transcript-cleanup`, then `splitItem` and `deleteItems` with ripple.
- Alternate punch-ins on every other jump cut (`transformItem` scale) so the jumps read as rhythm, not error.
- Place b-roll on a higher video track (`addMedia`) over the talking head while the speech continues; mute b-roll that has distracting sound (`editProperties` volume).
- Keep natural sound from b-roll when it adds place: traffic, waves, a crowd.

## Text and captions

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Words per caption line | 3–6 | count | Matches the speed of casual speech |
| Location or time label on screen | 2–3 | s | Read once, then gone |

- Captions help; use `addCaptions` and `editAllCaptionStyles` (`text/captioning`).
- Short labels for places and times (`addText`), placed per `text/text-placement`.
- Keep the type informal but readable; one style throughout.

## Audio and music

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Music track volume under speech | 0.1–0.2 | fraction | A bed, not a song: the voice leads |
| Music track volume in b-roll-only montages | 0.5–0.8 | fraction | Music takes over when nobody speaks |

- Put music on its own audio track and set its level with `manageTrack` (action `volume`). Mixing detail: `audio/mixing`.
- Change the music with the mood or the place; cut montages to the beat (`audio/music-sync`).
- Use the user's own music. `searchUserLibrary` and `searchProjectAssets` are not served in this build: ask the user which file to use, then read it with `viewItemDetails`.

## Checklist before handing back

- The hook is first and lands within the time above.
- Jump cuts are tight and punch-ins alternate.
- Every long talking stretch has b-roll that matches what is said.
- The voice is clear over the music and the b-roll sound.
- Check a few cuts. `captureFrame` is not served in this build: use `viewMaskFrame {itemId, timelineSeconds}` for a video item's source frame, or ask the user to check the preview. Then list your changes to the user. Export settings: `export`.
