<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Start here

## Getting started {#getting-started}
Cutframe is a free video editor that runs in your browser. Your projects and media stay on this device. Open the home page, press New Video, and add your footage. The timeline, preview and inspector open in the editor, and every change saves itself. No account or AI provider is needed. Press ? in the editor to see the keyboard shortcuts. Run setup again from Settings whenever you want the guided setup back.

## Import media and the library {#library}
Add footage with New Video, by dropping files on the Library page, or from the Footage tab in the editor. Video, images and audio are all accepted. Assets live in the Library and can be attached to any project. Folders organise them. Each asset is prepared in the background: thumbnails, a proxy for smooth playback and, when the local models are installed, analysis. Stock tabs search Pexels, Unsplash and Freesound once you add a free key.

## Save, undo and version history {#version-history}
Every edit saves automatically in this browser. Undo and redo cover each step. Checkpoints keep named points in a project: open the version menu to save one, compare it or restore it. A restore keeps a recovery checkpoint so you can go back. Projects are not sent anywhere.

# The editor

## The editor layout {#editor}
The editor has the footage panel, the preview canvas, the inspector for the selected item, and the timeline along the bottom. The top bar holds undo, redo, resize, the agent badge, help and export. Select an item on the timeline or the canvas to edit it. Drag on the canvas to move or scale. The Reference tab keeps videos whose style you want to match.

## Timeline editing {#timeline}
Clips sit on tracks. Drag a clip to move it, drag its edges to trim, and press Ctrl+B to split at the playhead. Ripple edits close the gap after a delete. Tracks can be hidden, muted, soloed and locked, and grouped. Markers note a time: press M to add one. Zoom with + and -. Keyframes animate a property over time: use the diamond next to a property in the inspector.

## Captions and subtitles {#captions}
Captions come from a transcript of your speech. Transcription runs on this device when the local speech models are installed, or through ElevenLabs if you add your own key in Settings. Edit the words in the captions panel, change the style, position and timing, and burn them into the export. Text overlays are separate items you add from the Text panel.

## Text and fonts {#text}
Add text from the Text panel. Choose a preset, a font, a size and a colour, then pick one of the text animations and its speed. Double-click text on the canvas to type. Upload your own font, or use the fonts that come with the editor. A missing font stops the export with a message that names it.

## Effects and colour grading {#effects}
Open the Effects tab on a selected clip to add effects such as blur, glow, distortion and stylize, and adjust each parameter. Effects stack in order, and each one can be switched off or removed. The Base Colour card grades a clip with exposure, contrast, saturation, temperature and tint. Advanced colour adds wheels, curves and LUTs.

## Transitions {#transitions}
A transition blends two clips that touch on the same track. Open the Transitions panel, pick one and drop it on the cut, then set its duration. Move or remove it from the inspector. A clip needs spare footage past the cut for the transition to overlap.

## Masks {#masks}
A mask shows only part of a clip. Add a mask to a selected video or image, choose a shape or draw a path, then feather, invert or animate it. Several masks can combine on one item. Agents can read a mask frame to check the result.

## Motion graphics {#motion-graphics}
A motion graphic is an animated overlay written as a small component, drawn in a sandbox. Agents and the built-in chat can write one for you, and you adjust its properties in the inspector. When a graphic fails to run, Cutframe repairs what it can by itself. Repair with a model needs a default model in Settings.

## Shapes and layouts {#shapes-layouts}
Add shapes from the Shapes panel and edit their points on the canvas. A layout arranges several clips in cells, such as a split screen. Resize the cells in the inspector.

## Audio and voice-over {#audio}
Set volume per clip, with keyframes for fades, and per track with the header slider. Record a voice-over from the Audio panel. Sound effects and music come from your library or Freesound. Beat detection finds the rhythm of a music track when the local models are installed, and cuts can snap to it.

## Export a video {#export}
Press Export in the top bar, choose a resolution and start. The export runs in this browser and the file downloads as an MP4. There is no watermark and no limit on length or count. Keep the tab open while it runs. If an export stops, the message names the cause, such as a missing font or a clip whose media is gone.

## Keyboard shortcuts {#keyboard-shortcuts}
Press ? in the editor for the full list. Space plays and pauses. Left and right arrows step one frame. Ctrl+Z undoes and Ctrl+Shift+Z redoes. Ctrl+C copies, Ctrl+V pastes, Ctrl+D duplicates and Ctrl+B splits at the playhead. Delete removes the selection. M adds a marker. Plus and minus zoom the timeline. Alt+N focuses notifications.

# Agents

## Connect an agent {#agent-setup}
Your own agent, such as Claude Code or Codex, can edit the open project through the local helper. In the Cutframe folder run npx cutframe-connect and leave the terminal open. Add the MCP server it prints to your client: http://127.0.0.1:47820/mcp. Then open a project, click the Agent badge, press Connect tab and enter the 6-digit pairing code. Settings has a guide for each client, and Claude Desktop uses a config file. The agent uses the same tools the editor does, so nothing it does is out of your reach.

## Agent connection problems {#agent-troubleshooting}
No helper found: start npx cutframe-connect in the Cutframe folder. Helper running but refused or not found: the helper only accepts the editor's own addresses on ports 5173 and 4173. If your editor runs on any other address, for example when the dev server moved to the next free port, restart the helper with npx cutframe-connect --allow-origin followed by that address, and the helper log names the refused origin. Wrong pairing code or locked pairing: type code in the helper terminal for a new one. Port taken: the helper uses the next free port from 47820 to 47829. Only one tab can hold the connection: use Take over in the other tab.

# Settings and costs

## Settings and API keys {#settings}
Settings holds your profile, local usage, AI and services, storage, the External Agent card and Delete local data. Model connections support OpenAI-compatible, Anthropic and Gemini protocols. Choose one default model and, if you want, another model per job. API keys are encrypted in this browser, are sent only to the site they were entered for, and are removed with Remove. Delete local data clears everything in this browser.

## Local model servers {#local-model-servers}
Ollama, LM Studio, llama.cpp and vLLM work as OpenAI-compatible connections with a local base URL and no key. The browser calls the server directly, so the server must allow this page's address (CORS). For Ollama, set OLLAMA_ORIGINS to this page's address and restart it. In LM Studio, turn on CORS in the server settings. For llama.cpp and vLLM, check the server's own CORS option. If Test says the server could not be reached, this is the usual cause. Nothing is billed for a local server.

## Costs and storage limits {#costs}
Cutframe is free and open source, with no plans, credits or watermarks, and it sets no limits. The Costs page lists each optional paid extra and who bills it. The real limit is your browser's storage quota, shown on the Costs page and in Local usage. Request persistent storage in Settings so the browser does not clear your data under pressure.

## Backup {#backup}
Auto backup is off by default. Turn it on in Settings, Storage and pick a folder. A project's media is copied there when it is added. Pick a folder your own sync client watches to keep a copy off this device. Project files themselves stay in this browser.

## Community {#community}
No community space has been set up yet. Bug reports and questions will have a home here once one exists.
