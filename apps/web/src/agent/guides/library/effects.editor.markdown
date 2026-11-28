---
topic: effects
kind: technical
summary: Add, edit, toggle and remove visual effects on items with writeEffects, using the effect registry for ids and parameters.
related: keyframing
unserved: captureFrame, listEffects, getEffectDetails
unimplemented: viewItemDetails.include=effects
---

## Purpose

Change how an item looks with the effect registry: colour grading, stylise, distort and generate effects. Every change goes through one tool, `writeEffects`, and one call is one atomic change: it applies in full or not at all.

## When to load

- The user asks for a look, a grade, a blur, a glow, a vignette, grain, a key or any other effect.
- You need to change, switch off or remove an effect that is already on an item.
- You want to animate an effect parameter (then load keyframing too).

## Workflow

1. Read the timeline with `context` and pick the target item ids. Effects work on video, image, text, shape and motionGraphic items; the registry says which item types each effect accepts.
2. Find the effect id and its parameters. `listEffects` and `getEffectDetails` are not served in this build; the served path is the refusals of `writeEffects`, which list what is valid. A refused call changes nothing, so read the list, correct the call and send it again:
   - `UNKNOWN_EFFECT`: the message ends "Available: …" with every discoverable effect id.
   - `EFFECT_NOT_SUPPORTED`: "Supported: …" lists the effect ids that fit that item type.
   - `UNKNOWN_PARAMETERS`: "Valid: …" lists the effect's parameter names.
   - `INVALID_PARAM_VALUE`: the message gives a number's range, a select's options, or the expected form (hex colour, colour wheel).
3. Add the effect: `writeEffects` with `itemId` (or `itemIds` for the same change on several items) and `add: [{effectId, initialParameters}]`. Leave out a parameter you have no value for; it starts at the effect's own starting value.
4. Read the result. Each item lists `added` (the new agent effect ids) and `effects`: the stack in order, each entry with its agent effect id, `enabled`, and only the parameters that differ from the default or carry keyframes.
5. Edit later with `effects: {"<agent effect id>": {params, enabled, remove}}`, using the ids from the latest result. The first such edit of an item in a session is refused once with `STALE_READ_REFRESHED` (see Pitfalls).
6. To animate a numeric parameter, call `writeKeyframes` with `itemId`, `effectId` (the agent effect id) and the parameter name as the payload key. A parameter that cannot be animated answers `NOT_ANIMATABLE`, and the message lists the ones that can.

## Tools and parameters

- Plan ahead, for a later build that serves them:
  - `listEffects {itemType?}` is not served in this build (use the `UNKNOWN_EFFECT` list in Workflow). When served: read-only, effect ids grouped by category (`color`, `stylize`, `distort`, `generate`), empty categories left out.
  - `getEffectDetails {effectName | effectNames}` is not served in this build (use the `writeEffects` refusals in Workflow). When served: read-only, description, item types and parameter definitions (key, type, default, range, step, unit, animatable). Select parameters do not list their options. An unknown name gives no error: it is skipped, and when every name is unknown the result is `effects: []`.
- `writeEffects`:
  - `itemId` or `itemIds`: exactly one of them.
  - `add`: new effects, appended to the end of the stack in the order given. `initialParameters` maps parameter name → value.
  - `effects`: agent effect id → `{params?, enabled?, remove?}`. `params` changes the static values and keeps every keyframe. `remove: true` wins over the other fields.
  - Effects you do not name stay as they are.
- Agent effect ids are `<effect type>_<stack position>`, the position counted from one among the item's effects, for example `vignette_1`. They exist only on the agent side; the stored instance has its own id.
- Parameter value types: number, boolean, string (select options and colours), and colour wheels as `{angle, distance}` with `angle` in degrees.
- Colours are hex only: `#rgb`, `#rrggbb` or `#rrggbbaa`. Any other form, such as `rgba(…)` or a colour name, is refused with `INVALID_PARAM_VALUE`.
- `lut`: `lutData` accepts `.cube` text (baked on write; `lutName` defaults to the cube title) or the baked base64 table.

## Units and limits

- Numbers outside a parameter's range are refused, never clamped.
- A colour wheel's `distance` runs from the minimum to the maximum in the table; `angle` is any finite number of degrees.
- Edits and removes run before adds within one call, and ids resolve against the stack as it was when the call started.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:effects.wheelDistanceMin | 0 | fraction | Smallest colour wheel `distance` |
| fact:effects.wheelDistanceMax | 1 | fraction | Largest colour wheel `distance` |

## Verification

- Check the `effects` list in the result: the agent ids, the order and the changed parameters are what you meant.
- `viewItemDetails` does not return effects in this build (`include: "effects"` answers `NOT_IMPLEMENTED`); the latest `writeEffects` result is the reference.
- `captureFrame` is not served in this build either. When the look matters, ask the user to check the preview at a few times.

## Pitfalls

- Stack positions move: removing `glow_1` from a stack shifts later effects down one position. Take ids from the newest result, not from memory.
- A batch with `itemIds` is all-or-nothing: if any item fails, nothing changes on any item, and `failures` lists each item's reason. The top-level `code` is the first failure's code.
- A retired effect (`lumetri-color`) cannot be newly added: `writeEffects` refuses it with `EFFECT_DEPRECATED` and names the replacement (Color Wheels, Levels or Curves). Existing instances stay editable.
- An id that is not in the registry, or an internal one, is `UNKNOWN_EFFECT`; an effect that does not fit the item type is `EFFECT_NOT_SUPPORTED`; an item type with no effects (audio, caption, layout) is `UNSUPPORTED_ITEM_TYPE`.
- Unknown parameter names in `writeEffects` are `UNKNOWN_PARAMETERS`, with the valid names in the message. In `writeKeyframes` on an effect, an unknown name is `UNKNOWN_PARAMETER` (singular), with the valid names too.
- The first `effects` edit of an item in a session (`params`, `enabled` or `remove`) is refused once with `STALE_READ_REFRESHED`, scope `effects`: no served read marks an item's effects as read. Nothing is applied. Check `currentState` (the item's effect stack, with the agent ids), fix the ids if they moved, and send the call again once. A user change to that item's effects makes the next edit refuse the same way. `writeKeyframes` on an effect parameter that already has keyframes is gated the same way; an `add`-only call is not.
- Neither `add` nor `effects` given is `EMPTY_PAYLOAD`; an `add` entry without a string `effectId` is `INVALID_ADD`.
- A malformed agent id is `INVALID_EFFECT_ID_FORMAT`; a well-formed id that is not on the item is `EFFECT_NOT_FOUND`, with the available ids.
- Only numeric parameters marked animatable take keyframes: others answer `NOT_ANIMATABLE`.
- A locked track refuses the edit with `TRACK_LOCKED`.
