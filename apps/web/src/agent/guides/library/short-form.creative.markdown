---
topic: short-form
kind: creative
summary: Craft defaults for vertical social clips: a fast hook, dense cuts, captions always on.
related:
unserved: captureFrame, searchProjectAssets, searchUserLibrary
---

## Purpose

How a vertical social clip is usually built: what to put first, how fast to cut, and how to keep a viewer who scrolls with the sound off. This is editing advice, not a rule set. The mechanics (tools, units, limits) are in `assembly/timeline`, `text/captioning` and `audio/music-sync`.

## When to use

- The canvas is vertical, or the user asks for a reel, a short, a story or a social cut.
- The finished piece is under about a minute and is meant to be watched on a phone.
- If the canvas is still horizontal, ask before calling `resizeCanvas`: changing the frame is the user's choice.

## Structure

1. **Hook.** Open on the strongest moment: the result, the surprise, the question. No logo, no title card, no slow fade in.
2. **Setup.** One line of context: who, what, why it matters.
3. **Body.** Three to five beats, each one idea, each shown, not just told.
4. **Payoff.** Deliver what the hook promised.
5. **End.** A clean last frame or a loop back to the opening shot. Keep any call to action short.

Find the hook with `viewItemDetails` (include `transcript`) on the speech. For the most striking shot: `searchProjectAssets` is not served in this build, so ask the user which file to use, then read it with `viewItemDetails`.

## Pacing

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Hook lands within | 2 | s | Most viewers decide to stay or scroll in the opening moments |
| Typical total length | 15–60 | s | Long enough for one idea, short enough to finish |
| Typical shot length | 1–3 | s | Keeps visual change frequent on a small screen |
| Longest shot without a change | 5 | s | Past this, add a cut, a zoom or a text beat |
| Transition length, when used | 0.2–0.4 | s | Short transitions read as energy; long ones read as slow |

- Cut on the beat or on a word: `audio/music-sync` gives beat times, `audio/transcript-cleanup` removes pauses and fillers.
- Prefer hard cuts. Use `applyTransition` sparingly, for a change of place or time.
- A punch-in (`transformItem` scale with `writeKeyframes`) refreshes a long talking shot without a new clip.

## Text and captions

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Words per caption line | 2–5 | count | Short groups are readable at a glance |
| Caption lines on screen | 1–2 | count | More lines cover the subject |
| Keep text out of the bottom band | 20 | percent | Platform buttons and descriptions sit there |
| Keep text out of the top band | 10 | percent | The account name and progress bar sit there |

- Captions on by default: many viewers watch muted. Use `addCaptions`, then `editAllCaptionStyles`; `listCaptionTemplates` gives ready styles.
- Big, bold, high-contrast type. One highlighted word per line at most.
- A title over the hook (`addText`) works when the speech starts late. Placement rules: `text/text-placement`.

## Audio and music

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Music track volume under speech | 0.15–0.25 | fraction | Speech stays clear on phone speakers |
| Music track volume with no speech | 0.6–0.9 | fraction | Music carries the clip alone |

- Start sound at the first frame; silence at the start reads as a broken clip.
- Choose music from the user's own files. `searchUserLibrary` and `searchProjectAssets` are not served in this build: ask the user which file to use, then read it with `viewItemDetails`. Levels and ducking: `audio/mixing`.

## Checklist before handing back

- The hook is the first shot and lands within the time above.
- No shot runs past the longest-shot guidance without a change.
- Captions are on and clear of the top and bottom bands.
- Speech is audible over the music.
- Check the hook and the last frame. `captureFrame` is not served in this build: use `viewMaskFrame {itemId, timelineSeconds}` for a video item's source frame, or ask the user to check the preview (text and captions show only there). Then tell the user what you changed. Export settings: `export`.
