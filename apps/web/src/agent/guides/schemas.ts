// SPDX-License-Identifier: AGPL-3.0-only
// T23's three TOOL_LIST entries (contracts getAgentOverview, loadSkill, workspace; §3h #41, #44, #45), spread into the helper's
// list (apps/helper/src/schemas.ts). Pure data, so the helper can import it. Objects are closed as there; the per-command
// required fields of `workspace` are the handler's (I2), not the schema's.
import type { Tool } from '../../../../helper/src/schemas';

const str = { type: 'string' }, count = (description: string, minimum = 0) => ({ type: 'integer', minimum, description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
export const WORKSPACE_COMMANDS = ['ls', 'view', 'cat', 'grep', 'write', 'edit', 'copy', 'delete'] as const;

export const GUIDE_TOOL_LIST: Tool[] = [
  { name: 'getAgentOverview', description: 'Start here: how the editor works for an agent, the user\'s saved memory (memory/overview.md) and the open project\'s template overview (template/overview.md). Read-only.',
    inputSchema: obj({ refresh: { type: 'boolean', description: 'Read again after a template change (every call reads fresh)' } }) },
  { name: 'loadSkill', description: 'Load the guide for one kind of edit: the mechanics (tools, fields, units, limits, checks), then the creative layer from the project template or our default. Read-only.',
    inputSchema: obj({ skillName: { type: 'string', description: 'Skill id, e.g. text/captioning, transitions, assembly/short-form' } }, ['skillName']) },
  { name: 'workspace', description: 'Files for the agent under three roots: memory/ (the user\'s notes), template/ (the open project\'s template) and cutframe/ (our guides and catalogues, read-only). Commands ls, view, cat, grep, write, edit, copy, delete.',
    inputSchema: obj({ command: { enum: WORKSPACE_COMMANDS }, path: str, text: { type: 'string', description: 'write: the whole new text' },
      old: { type: 'string', description: 'edit: the one exact passage to replace' }, new: { type: 'string', description: 'edit: its replacement' },
      from: { type: 'string', description: 'copy: source path' }, to: { type: 'string', description: 'copy: destination path' },
      pattern: { type: 'string', description: 'grep: literal text, any case' }, limit: count('ls: files per page (default 50); grep: lines', 1),
      maxChars: count('cat: characters per slice', 1), offset: count('ls: first file; cat: first character') }, ['command']) },
];
