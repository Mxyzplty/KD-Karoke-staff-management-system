---
topic: export
kind: technical
summary: Export is not available in this build; what to tell the user, and how export will work when it arrives
related: audio
unserved: exportProject, getExportStatus
---

## Purpose

Tell the user honestly what export can do today, and plan ahead for the export tools. When export works, the render runs inside the user's browser tab, not on a server, and the file it writes is the product the user keeps.

## When to load

- The user asks to export, render, download or share the finished video.
- You need to know the output format, size or length before promising anything.

## Availability today

- Export is **not available** in this build, for agents or for the user.
- `exportProject` and `getExportStatus` are not served: the helper does not list them, and there is no served export fallback. Do not try to call them.
- The editor's Export button is a placeholder: pressing it only shows a notice that export is not implemented yet.
- So never promise a file. Tell the user the edit is saved in the project, and that export is not in this build yet.

## Workflow

Today, with no export in this build:

1. Finish and verify the edit with the timeline tools.
2. Tell the user export is not available yet; the project keeps the edit for later.
3. Do not suggest the Export button as a way round it.

## Tools and parameters

Planned tools, for planning ahead only; nothing in this section works in this build.

- `exportProject` (not served yet): `filename` (no extension; `.mp4` is added), `format`, `resolution` (default `original`). It returns at once with `success`, `renderId`, `status: "started"`, `message`, and `warning` only when the tab is hidden at the call. Always pass a `filename`.
- `getExportStatus` (not served yet): `renderId`. `status` is `rendering`, `completed` (with `downloadUrl`) or `failed` (with `error`). Poll a few seconds apart.
- In the export core, `error` is an object: `code`, `category`, `kind`, `message`, `detail`. `progress` is null until the first few frames are done.
- A finished job lives only in the tab's memory. After a reload or a closed tab its `renderId` reads as not found; start a new export.

## Units and limits

These describe the export core as built, which agents cannot reach yet.

- **Container and codecs:** MP4 with H.264 video. Audio is AAC-LC at the sample rate, channel count and bitrate in the table; if the browser has no AAC-LC encoder, Opus at the same sample rate and channels, with a message.
- **Frame rate:** the timeline's fps, constant. A key frame comes at the interval in the table, with no B-frames.
- **Length:** the frame count is ceil((duration − lead-in) × fps), where the lead-in is the earliest start of an item on a visible track (zero when that item starts at the timeline's start). The file can run up to one frame past the timeline's end.
- **Empty lead-in:** if the first item on a visible track starts after the timeline's start, the empty part before it is not exported. Items on hidden tracks do not count. To keep a lead-in, start an item on a visible track at the very start of the timeline.
- **Resolution:** `original` keeps the canvas, with an odd side rounded to an even number. The other choices set the long edge (table); the short edge is scaled and rounded to even. Larger than the canvas is an upscale.
- **Bitrate:** the video target in the table, for variable bitrate; actual rates vary with the content.
- **Copy exception:** when the timeline is one whole, unedited H.264/AAC clip at the canvas size and fps (no trim, move, speed, keyframes, effects, masks or styling, full volume), its packets are copied, not encoded. The file then keeps the source's bitrate, key frames and audio, and the audio does not pass the limiter.
- **Format:** only MP4 is made. `format: "webm"` is refused as not implemented yet.
- **One at a time:** a new export of the same project stops the running one, which then fails as `SUPERSEDED`.
- **Audio stream:** written when a visible track holds a video or audio item, silent if nothing sounds; otherwise none. Encoded mixes pass the output limiter described in the audio guide.
- **Media:** a clip still uploading refuses the export (`ASSETS_STILL_UPLOADING`); a clip still being analysed does not.

## Verification

- Today: confirm the edit with `context` and the user's preview; there is no file to check.
- When export arrives: the job reports `completed` with a `downloadUrl`; ask the user to open the file and check the first and last seconds, text, captions and sound.

## Pitfalls

- Never claim a video was exported or saved as a file in this build.
- When export arrives:
  - The tab must stay open and in front: a background tab renders slower, and the browser may take a decoder back (`CODEC_RECLAIMED`).
  - `USER_CANCELLED` means the user stopped it; do not restart without asking.
  - Fix-and-retry codes: `UNRESOLVED_MEDIA` or `MISSING_LOCAL_FILES` (re-add the media), `ASSETS_STILL_UPLOADING` (wait), `FONT_NOT_FOUND` (change the font), `OOM` or `STORAGE_QUOTA` (lower the resolution or free space).
  - `ENCODE_ERROR` can be a browser limit: no H.264 encoder at that size (the error's `detail` says "cannot be encoded at" a width and height; its `message` is a generic text). Retry once at a lower `resolution`; if it fails again, tell the user and stop.
  - `AUDIO_FAILED` has two causes; never retry either, since a lower resolution does not change the audio. The `message` is the same generic text for both; read the cause from `detail`. If `detail` says the browser supports neither AAC-LC nor Opus, tell the user that this browser cannot encode the sound. If `detail` starts "Audio mix failed", the mix itself broke, which Cutframe counts as its own bug: tell the user the sound could not be mixed, and stop.
  - `DECODE_ERROR` and other bug codes: report them to the user and do not loop.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:export.agentResolutions | ["original", "720p", "1080p", "1440p", "4k"] | none | resolution values the planned agent tool accepts |
| fact:export.longEdge720p | 1280 | px | Long edge for 720p |
| fact:export.longEdge1080p | 1920 | px | Long edge for 1080p |
| fact:export.longEdge1440p | 2560 | px | Long edge for 1440p |
| fact:export.longEdge4k | 3840 | px | Long edge for 4k |
| fact:export.keyframeIntervalS | 5 | s | Time between key frames |
| fact:export.videoBitrateMbps | 20 | Mbps | Default video bitrate target |
| fact:export.audioSampleRateHz | 48000 | Hz | Audio sample rate |
| fact:export.audioChannels | 2 | count | Audio channels (stereo) |
| fact:export.audioBitrateKbps | 192 | kbps | Audio bitrate (AAC-LC) |
