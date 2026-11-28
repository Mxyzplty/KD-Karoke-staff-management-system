---
topic: multi-cam
kind: creative
summary: Craft defaults for multi-camera edits: when to change angle, reaction shots, and keeping sync.
related:
unserved: captureFrame
---

## Purpose

How to cut between several cameras that recorded the same moment: an interview, a podcast, a panel, a performance. The goal is to show whoever the viewer wants to see, at the moment they want to see them, without ever losing sync. This is editing advice, not a rule set. The mechanics (syncing, placing angles) are in `assembly/multi-cam`; split screens are in `assembly/layouts`.

## When to use

- Two or more video sources cover the same scene from different angles.
- The user asks for a podcast edit, an interview cut, a multi-angle performance or a reaction edit.

## Structure

1. **Sync first.** Line every angle up to one master clip with `syncAndSwap`, which matches the speech in both. It refuses when confidence is too low; then sync by a clap or a clear sound and check by eye.
2. **Pick the master audio.** One clean audio source for the whole edit; mute the cameras' own sound unless it adds room tone (`editProperties` volume, or `manageTrack` mute).
3. **Establish.** Open on the wide shot so the viewer knows who is where.
4. **Follow the talk.** Cut to whoever speaks; cut away for reactions.
5. **Return to wide** at changes of topic or when several people talk at once.

- Read who speaks when with `viewItemDetails` (include `transcript`) before choosing cuts.
- For two people talking at once, a split (`addLayout`) can beat fast cutting.

## Pacing

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Hold an angle at least | 2 | s | Shorter angles feel nervous in conversation |
| Typical angle length in talk | 4–10 | s | Follows the rhythm of speech |
| Reaction shot length | 1–2 | s | Long enough to read a face, short enough not to miss the speaker |
| Cut ahead of the new speaker | 0.1–0.3 | s | Lands on the face as the first word starts |
| Wide shot hold at a topic change | 3–5 | s | Resets the viewer's sense of the room |

- Cut on a sentence end, a breath or a gesture, not mid-word.
- Reaction shots carry the emotion: a laugh, a nod, surprise. Use them, but do not cut away from an important line.
- In performances, cut on the musical phrase (`audio/music-sync`), not just the beat.
- Avoid cutting between two angles that look almost alike; the change reads as a jump.

## Text and captions

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Name label on screen | 3–4 | s | Read once on each person's first appearance |
| Words per caption line | 4–7 | count | Conversation runs fast |

- Label each speaker the first time they appear (`addText`), placed per `text/text-placement`.
- For several speakers, captions split by speaker help (`addCaptions` with `splitBySpeaker`; rules in `text/captioning`).

## Audio and music

| Guidance | Value | Unit | Why |
|---|---|---|---|
| Music track volume under conversation | 0.05–0.15 | fraction | Conversation must stay fully clear |

- The master audio never cuts when the picture cuts; only the picture changes angle.
- Keep music out of the talk itself; use it for the intro, breaks and the outro. Levels: `audio/mixing`.

## Checklist before handing back

- Every angle is in sync: check lips against speech at the start, middle and end. `captureFrame` is not served in this build: ask the user to check the preview, or use `viewMaskFrame {itemId, timelineSeconds}` for a video item's source frame.
- Only one audio source carries the speech.
- Each speaker is on screen when they make their key points.
- No angle holds shorter than the minimum above, except deliberate reactions.
- Tell the user which angles you used where and anything you could not sync. Export settings: `export`.
