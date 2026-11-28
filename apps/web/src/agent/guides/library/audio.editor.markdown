---
topic: audio
kind: technical
summary: Clip and track volume, fades as volume keyframes, ducking music under speech, and how the mix is built
related: music-sync, voice-over
---

## Purpose

Set how loud each clip and track plays, fade sound in and out, and keep music under speech. The same mix plays in the preview and goes into the export, so what you set here is what the file contains.

## When to load

- The user asks for louder, quieter, muted or soloed sound.
- You add music, sound effects or a voice-over and need to balance them.
- You need fades or ducking.

## Workflow

1. Call `context` and note the audio-carrying items: `video` and `audio` items, and filled layout cells. Note each track's `muted`, `solo`, `hidden` and `volume`.
2. Set a whole track's level with `manageTrack` `action: "volume"`. Mute, solo or hide with `action: "mute" | "solo" | "hide"` and `value`.
3. Set one clip's level with `editProperties` `properties.volume` (one item with `itemId`, or the same value on several with `itemIds`).
4. Shape the level over time with `writeKeyframes` on the `volume` property: fades, swells and ducking.
5. Set a layout cell's level with `editLayout` `cells[].volume`, in percent.
6. Verify (below), then report the levels you set.

## Tools and parameters

- **`manageTrack`**: `action: "volume"`, `trackId`, `volume` (a fraction of full level). `mute` / `solo` / `hide` take `value` (boolean, default true).
- **`editProperties`**: `properties.volume` on `video` and `audio` items only. On any other type it is refused with `INVALID_PROPERTY`. Out of range is `INVALID_PROPERTY_VALUE`. If the item already has volume keyframes, only the default value changes; edit the keyframes for the rest.
- **`writeKeyframes`**: `itemId`, `payload: { volume: { add | update | remove | replace } }`. Each entry has `time` (timeline seconds, inside the item) and one of `value`, `delta` or `factor`, plus an optional `easing`. A value outside the range is `KEYFRAME_VALUE_OUT_OF_RANGE`.
- **`editLayout` / `addLayout`**: `cells[].volume` in percent, where the default is as recorded.

## Units and limits

- **Gain law.** A clip's gain is the track gain times the square of the clip volume. Raising the volume raises the gain much faster than the number suggests, so change it in small steps. Think in volume, not in decibels.
- **Track gain** is 0 when the track is muted, hidden (or in a hidden group), or when another track is soloed. Otherwise it is the track volume.
- **Fades** have no tool of their own. A fade is two volume keyframes: 0 at the clip edge and the current level one fade length inside it. The editor's own fade button uses the fade length in the table, capped at half the clip.
- **Ducking** has no automatic mode. Duck by hand: on the music item, add keyframes that lower the volume just before each speech section and raise it just after.
- **Limiter.** The mix always passes a peak limiter with the ceiling in the table. It stops clipping; it does not normalise loudness. A mix that is too hot sounds squashed, not distorted.
- **Speed and pitch.** A clip played faster or slower (`playbackRate`, or a time remap) changes pitch with speed. The Keep pitch switch is in the inspector only; no agent tool sets it.

## Verification

- Read the levels back: `context` for track `volume` and flags, `viewItemDetails` `include: "keyframes"` for volume keyframes.
- Ask the user to listen around each change: the start and end of a fade, each duck, each music entry.
- Check ducking against the speech times from `viewItemDetails` `include: "transcript"`.

## Pitfalls

- Track volume above full level is refused with `INVALID_VOLUME`. To boost, raise the clip volume instead.
- `editProperties` on a keyframed volume changes only the default value; the keyframes still drive the level.
- Images, text, shapes, captions and motion graphics have no volume.
- A hidden track is silent in the preview and in the export.
- Soloing one track silences every track that is not soloed, including speech. Clear solo when done.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| schema:manageTrack.volume.minimum | 0 | fraction | Lowest track volume |
| schema:manageTrack.volume.maximum | 1 | fraction | Highest track volume (full level) |
| fact:audio.volumeMin | 0 | factor | Lowest clip volume (silent) |
| fact:audio.volumeDefault | 1 | factor | Clip volume as recorded |
| fact:audio.volumeMax | 3 | factor | Highest clip volume |
| schema:editLayout.cells[].volume.minimum | 0 | percent | Lowest layout-cell volume |
| schema:editLayout.cells[].volume.maximum | 200 | percent | Highest layout-cell volume |
| fact:layout.cellVolumeDefault | 100 | percent | Layout-cell volume as recorded |
| fact:audio.fadeMs | 1000 | ms | Fade length of the editor's fade button |
| fact:audio.limiterCeilingDb | -1 | dB | Limiter ceiling (dBFS) |
