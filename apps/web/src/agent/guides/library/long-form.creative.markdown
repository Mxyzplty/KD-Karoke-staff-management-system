---
topic: long-form
kind: creative
summary: Craft defaults for horizontal videos of several minutes: chapters, varied pacing, steady sound.
related:
unserved: captureFrame, searchProjectAssets, searchUserLibrary
---

## Purpose

How a longer horizontal video is usually shaped: an opening that states the promise, chapters that each earn their place, and pacing that breathes over minutes instead of seconds. This is editing advice, not a rule set. The mechanics are in `assembly/timeline`, `assembly/finding-media` and `transitions`.

## When to use

- The canvas is horizontal and the piece runs several minutes: a tutorial, an explainer, a documentary, a talk, a review.
- The viewer chose to watch and will sit through slower moments if the structure is clear.

## Structure

1. **Cold open.** A short, strong moment from later in the video, or the question the video answers.
2. **Promise.** Say plainly what the viewer will get.
3. **Chapters.** Three to seven sections, each with one goal, a clear start and a clear end.
4. **Recap.** Restate the key points in a few lines.
5. **Close.** End cleanly; no long outro.

- Mark chapter starts with `manageMarkers`, so the user can review them and use them for chapter titles.
- Map the speech first with `viewItemDetails` (include `transcript`), then build the chapters around it.
- Separate chapters with a title card (`addText`), a short pause, or a change of music.

## Pacing

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Cold open length | 15–45 | s | Long enough to intrigue, short enough to reach the promise |
| Typical chapter length | 60–240 | s | Gives each idea room without losing the thread |
| Typical shot length | 3–8 | s | Calm enough to follow an argument |
| Longest shot without a change | 15 | s | Past this, add b-roll, a punch-in or a graphic |
| Chapter-break pause | 0.5–1.5 | s | Lets the viewer register the change of topic |
| Transition length, when used | 0.5–1 | s | Reads as a deliberate change, not a glitch |

- Vary the pace: faster cuts in action or montage, slower in explanation.
- Cover long talking shots with b-roll on a higher video track (`addMedia`), keeping the speech underneath.
- Remove pauses and repeats with `audio/transcript-cleanup`, but keep some breath: wall-to-wall speech tires the viewer.
- Use transitions (`applyTransition`) between chapters more than inside them.

## Text and captions

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Words per caption line | 5–8 | count | A wide frame holds longer lines |
| Caption lines on screen | 1–2 | count | Keeps the image visible |
| Chapter title on screen | 2–4 | s | Long enough to read once |

- Offer captions; they help many viewers. Use `addCaptions` and `editAllCaptionStyles`, with `text/captioning` for the rules.
- Lower thirds (`addText`) for names and places the first time they appear. Placement: `text/text-placement`.
- Keep one type style for the whole video.

## Audio and music

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Music track volume under speech | 0.1–0.2 | fraction | Over minutes, louder beds tire the ear |
| Music track volume in montages | 0.5–0.8 | fraction | Music leads when nobody speaks |

- Change or pause the music between chapters; one loop for the whole video becomes noise.
- Keep speech level steady across chapters. Levels and fades: `audio/mixing`; cutting to the beat: `audio/music-sync`.
- Use the user's own files or the project's. `searchUserLibrary` and `searchProjectAssets` are not served in this build: ask the user which file to use, then read it with `viewItemDetails`.

## Checklist before handing back

- The promise is stated early and the chapters deliver it.
- Each chapter has a marker and a clear start.
- No shot runs past the longest-shot guidance without a change.
- Speech is clear over the music everywhere.
- Spot-check chapter starts. `captureFrame` is not served in this build: use `viewMaskFrame {itemId, timelineSeconds}` for a video item's source frame, or ask the user to check the preview. Then summarise the structure to the user. Export settings: `export`.
