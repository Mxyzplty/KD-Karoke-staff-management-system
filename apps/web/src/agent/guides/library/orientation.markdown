---
topic: orientation
kind: technical
summary: How an agent works inside Cutframe: reading the edit, loading skills, the workspace, memory, verifying and recovering.
related:
---

# Working in Cutframe

## Purpose

Cutframe is a video editor that runs in the user's browser. Your tool calls change the project open in that tab, and the user sees each change as it happens. This orientation covers the editing context, how to discover the current edit, skills and tools, verifying and recovering, and how to inspect source footage.

`getAgentOverview` returns separate text blocks: this orientation; the user's memory index (`memory/overview.md`) inside `<memory_overview>` tags, when there is one; and the open project's template overview (`template/overview.md`) when the project has a template, or a short notice while the project isn't connected yet. A connected project with no template gets no third block.

## When to load

- Call `getAgentOverview` at the start of every session.
- Call it again after the user opens another project or changes the project's template.

## Workflow

1. **Orient.** Call `getAgentOverview`. Read the memory index and the template overview, when they are present.
2. **Read the edit.** Call `context` before your first change. It lists tracks (top to bottom), item ids, times in seconds, the canvas size, groups and markers.
3. **Load a skill for unfamiliar work.** Call `loadSkill` with a skill id before an edit you have not done in this session. A bare id returns the mechanics guide first, then the creative guidance (the template's own, else Cutframe's default).
4. **Edit in place.** Change existing items; do not delete and re-add them. A rebuild loses keyframes, effects, masks and placement. Ask the user before any full rebuild.
5. **Batch.** Use array inputs (`items`, `itemIds`, `cells`) where a tool has them. Independent read-only calls may run in parallel. Mutating calls run one at a time, in the order they arrive.
6. **Verify** every change (see Verification) before you report it as done.
7. **Save what lasts** (see Memory discipline), then tell the user what you changed.

## Priority

When instructions disagree, follow this order:

1. the user's current message;
2. the template's creative guidance (template overview and `template/skills/`);
3. saved memory.

## Skills

Load a skill with `loadSkill {skillName}`. Registered ids:

- Assembly: `assembly/timeline`, `assembly/finding-media`, `assembly/layouts`, `assembly/multi-cam`, `assembly/short-form`, `assembly/long-form`, `vlog`.
- Audio: `audio/mixing`, `audio/music-sync`, `audio/transcript-cleanup`, `audio/voice-over`.
- Text: `text/captioning`, `text/text-placement`.
- Visuals: `keyframing`, `time-remapping`, `transitions` (alias `visuals/transitions`), `effects`, `masking`, `masking-and-shapes/smart-masking`, `motion-graphics`, `reframe`.
- Output: `export`.

An unknown id fails with `CREATIVE_SKILL_NOT_REGISTERED` and names the closest registered ids. Pick one of those.

## Workspace

`workspace` reads and writes files under three roots:

- `memory/`: notes about this user, kept on this device. `memory/overview.md` is the index. You may write here only while the user's memory switch (Settings) is on; it is off by default.
- `template/`: the open project's template. `overview.md` and `fonts.md` are generated and read-only. `skills/<id>.md` and `examples/` are writable only while the project's Learn switch is on.
- `cutframe/`: Cutframe's guides, the element and sound catalogues (`catalogue/elements.md`, `catalogue/sounds.md`) and the overviews of the user's other projects. Always read-only.

Commands: `ls`, `view`, `cat`, `grep`, `write`, `edit`, `copy`, `delete`. Use paths exactly as `ls` returns them.

## Memory discipline

- Nothing persists unless you save it.
- Save lasting facts when you learn them: who the user is, upcoming projects, standing preferences.
- Do not save choices that apply only to this video.
- Read a file before you change it. Prefer `edit` (one exact passage) over rewriting the file with `write`.
- Keep `memory/overview.md` pointing at every file you add.
- Write under your own headings. Template-level style belongs in `template/skills/`, not in memory.

## Tools and parameters

- `getAgentOverview {refresh?}`: every call reads fresh.
- `loadSkill {skillName}`.
- `context {include?, types?, startSeconds?, endSeconds?}`: call it with no arguments for the overview.
- `viewItemDetails {itemId | itemIds | assetId | assetIds, include?}`: deep reads of items or assets.
- `workspace {command, path?, text?, old?, new?, from?, to?, pattern?, limit?, maxChars?, offset?}`.

## Units and limits

- Timeline times are seconds unless a field says otherwise. Some fields use other clocks (layout cell trims are source milliseconds); each skill names them.
- `workspace` `ls` returns pages of files; follow `nextOffset` until it is null.
- Stop after 2 failed attempts with one approach. Tell the user what you tried and what failed.

## Verification

- Read the result of every mutating call. It carries `timelineChanges`: the items, tracks and settings that changed, with before and after values.
- For a field the report omits, read it back with `context` or `viewItemDetails`.
- Inspect source footage with `viewItemDetails` on the asset id (`include: "transcript"` for words with times). Previews show the source, not the composited timeline.
- Reference videos are style input only. Never place them on the timeline; project assets are the footage.

## Pitfalls

- **Stale state.** If the user may have edited since your last read, call `context` again. A write refused with `STALE_READ_REFRESHED` was not applied: the result carries `currentState`, the scope now counts as read, so retry once with the fresh ids.
- **Ids change.** Splits, deletes and replacements create new item ids. Never reuse an id you have not seen in a recent read.
- **Read-only roots.** A write to `cutframe/`, to a generated template file, to `memory/` with the memory switch off, or to `template/` with Learn off fails with `WORKSPACE_READ_ONLY`. Tell the user which switch controls it; do not retry.
- **No project open.** `workspace` returns `WORKSPACE_UNAVAILABLE` and timeline tools cannot run. Ask the user to open a project.
- **Not in this build.** A result with code `NOT_IMPLEMENTED` means that part of a tool is not available yet. Use another way, or tell the user.

| Check | Value | Unit | Meaning |
|---|---|---|---|
| fact:agent.maxFailedAttempts | 2 | count | Failed attempts of one approach before you stop and report |
