// SPDX-License-Identifier: AGPL-3.0-only
// T21 acceptance row 8: 20 natural questions, each must put its section in the results. Shared by the unit test (lexical search)
// and the real-model test.
export const QUESTIONS: [string, string][] = [
  ['how do I get started with Cutframe', 'getting-started'],
  ['how do I import my footage into the library', 'library'],
  ['how does undo and version history work', 'version-history'],
  ['what is on the editor layout and inspector', 'editor'],
  ['how do I split a clip on the timeline', 'timeline'],
  ['how do I add subtitles to my video', 'captions'],
  ['how do I change the text font', 'text'],
  ['how do I add a blur effect or colour grade', 'effects'],
  ['how do I add a transition', 'transitions'],
  ['how do I mask part of a clip', 'masks'],
  ['how do I make a motion graphic overlay', 'motion-graphics'],
  ['how do I make a split screen layout', 'shapes-layouts'],
  ['how do I record a voice-over', 'audio'],
  ['how do I export a video as mp4', 'export'],
  ['what are the keyboard shortcuts', 'keyboard-shortcuts'],
  ['how do I connect Claude Code to the editor', 'agent-setup'],
  ['my agent connection has a wrong pairing code', 'agent-troubleshooting'],
  ['where do I put my API keys in settings', 'settings'],
  ['how do I use Ollama as a local model server', 'local-model-servers'],
  ['how much does it cost and what is the storage quota', 'costs'],
];
