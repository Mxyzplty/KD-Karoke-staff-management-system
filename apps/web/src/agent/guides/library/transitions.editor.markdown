---
topic: transitions
kind: technical
summary: Add, change or remove the transition on a cut between two clips with applyTransition: kinds, length clamp, alignment and the returned id.
related:
unserved: captureFrame
---

## Purpose

`applyTransition` puts one transition on the cut between two neighbouring video or image clips on the same track, changes it, or removes it. Clips never move: the transition plays over the frames around the cut.

## When to load

- The user asks for a fade, dissolve, dip, push (slide) or wipe between two shots.
- You need to change the kind, length or position of a transition, or remove one.
- Zooms, spins and other moves are not transitions: animate them with `keyframing`.

## Workflow

1. Call `context`: find the two clips that meet at the cut, their ids and their lengths.
2. Call `applyTransition` with `action: "add"`, the cut (`betweenItems` or `atSeconds`), and `kind`, `durationSeconds`, `alignment` as needed.
3. Read `data.transition`: `id`, `kind`, `durationSeconds` (the length actually stored), `alignment`, and `direction` / `params` when set. If the message says the duration was clamped, tell the user the length you got.
4. To change it later, call `update` on the same cut with only the fields that change.
5. Check the cut (see Verification).

## Tools and parameters

**`applyTransition`**
- `action` (required): `add`, `update` or `remove`.
  - `add` on a cut that already has a transition replaces it (the message says "Replaced"; the id is kept).
  - `update` merges the given fields into the existing transition; on a cut without one it is `TRANSITION_NOT_FOUND`.
  - `remove` on a cut without one still succeeds and says nothing was removed.
- Cut address, one of:
  - `betweenItems`: the two clip ids, in either order;
  - `atSeconds`: a timeline time; the nearest cut within the search distance in the table, on any track and between any item types. It can pick an audio or caption cut, which answers `INVALID_PAIR` (or "nothing removed" for `remove`). When other tracks have cuts nearby, use `betweenItems`.
- `kind`: see the table. Default `fade`, which dips through black.
- `durationSeconds`: length in seconds; default in the table.
- `alignment`: `start` (begins at the cut, inside the incoming clip), `center` (default, centred on the cut), `end` (finishes at the cut, inside the outgoing clip).
- `direction`: for `slide` and `wipe`, the side the incoming clip enters from. Default `from-left`.
- `params.color`: for `dipToColorDissolve`, `[r, g, b]` with each channel a fraction. Default black.
- `params.softness`: for `wipe`, the edge feather as a percent of the frame.

## Length

- The stored length is the request rounded to whole milliseconds, then clamped between the minimum and the smaller of: the outgoing clip's visible length, the incoming clip's visible length, and the cap. All three values are in the table.
- `add` and `update` clamp; they never refuse for length. Only a pair whose maximum is below the minimum is refused (`INVALID_PAIR`).
- Hidden source beyond the clip edges (handles) does not limit the length. Where the source runs out, the transition shows a frozen first or last frame of that clip.
- Back-to-back transitions on one short clip share it: each one's part inside that clip is scaled down so the two fit.

## Units and limits

| Check | Value | Unit | Meaning |
|---|---|---|---|
| schema:applyTransition.action.enum | ["add","update","remove"] | none | Operations |
| schema:applyTransition.kind.enum | ["fade","dissolve","additiveDissolve","dipToColorDissolve","slide","wipe"] | none | The six transition kinds |
| schema:applyTransition.alignment.enum | ["start","center","end"] | none | Where the transition sits on the cut |
| schema:applyTransition.direction.enum | ["from-left","from-right","from-top","from-bottom"] | none | Entry side for slide and wipe |
| schema:applyTransition.durationSeconds.exclusiveMinimum | 0 | s | A requested length must be above this |
| fact:transition.defaultDurationMs | 1000 | ms | Length when `durationSeconds` is omitted on `add` |
| fact:transition.minDurationMs | 100 | ms | Shortest stored length |
| fact:transition.maxDurationMs | 3000 | ms | Cap on the stored length, even with long clips |
| fact:transition.cutSearchMs | 500 | ms | `atSeconds` finds the nearest cut within this distance |
| fact:transition.softnessMax | 100 | percent | Largest wipe softness (from 0) |
| fact:transition.colorChannelMax | 1 | fraction | Largest value of one `params.color` channel (from 0) |

## Verification

- `data.transition.durationSeconds` is the real length; compare it with what you asked for.
- Keep `data.transition.id` with the two clip ids; later calls address the transition by its cut (`betweenItems`).
- `captureFrame` is not served in this build, and `viewMaskFrame` shows source frames without the blend. To see the blend, ask the user to check the preview across the cut.

## Pitfalls

- **Only video and image clips** on the same track that meet exactly. With `betweenItems`, a gap, an overlap, other item types or clips on different tracks are `INVALID_PAIR`.
- **`atSeconds` misses.** A gap at that time is not a cut, so it gives `CUT_NOT_FOUND`, as does no cut nearby. Use `betweenItems`.
- **`betweenItems` must hold exactly two ids** (`MISSING_PARAMETERS`); an id not on the timeline is `ITEM_NOT_FOUND`.
- **Locked track.** All three actions refuse with `TRACK_LOCKED` and change nothing.
- **No address, no action.** Missing `action`, or neither `betweenItems` nor `atSeconds`, is refused before anything changes.
- **Short transitions read as energy, long ones as slow.** Keep the length a creative choice: see the creative guides.
