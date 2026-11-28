// SPDX-License-Identifier: AGPL-3.0-only
// T23 getAgentOverview (contracts getAgentOverview, §3h #41; results §2 getAgentOverview; T23 notes "getAgentOverview"). Plain
// MCP text blocks, no JSON envelope (RC 11.1 A1; lane R's 07:1x follow-up: G-07 0001, A01, G-04 c001; lane F and lane A
// 07:1x): 1 our orientation; 2 the user's memory/overview.md in a tagged section, G-07's bytes; 3 the open project's
// template/overview.md when it has a template, or the stored notice before connecting. `refresh` changes nothing.
import type { ProjectRecord } from '../../store/model';
import type { ToolResult } from '../protocol';
import { readMemory } from '../workspace/memory';
import { overviewText, templateState } from '../workspace/template';
import { ORIENTATION } from './registry';
import { guideFailure } from './tools';
import type { GuideContext } from './tools';

/** Stored text (results §2, 48 characters). */
export const NO_PROJECT_TEMPLATE = 'Open and connect a project to load its template.';
/** Stored message (error codes l.58). */
export const PROJECT_FORBIDDEN = 'Open a project owned by your signed-in account.';
/** Block 2 as G-07 0001 stores it: open tag, "\n", the memory, "\n\n", close tag, nothing after. */
export const MEMORY_OPEN = '<memory_overview>', MEMORY_CLOSE = '</memory_overview>', MEMORY_BEFORE = '\n', MEMORY_AFTER = '\n\n';
export const memoryBlock = (memory: string) => MEMORY_OPEN + MEMORY_BEFORE + memory.trimEnd() + MEMORY_AFTER + MEMORY_CLOSE;

export async function getAgentOverview(_input: Record<string, unknown>, ctx: GuideContext): Promise<ToolResult> {
  // No project open: PROJECT_FORBIDDEN (contracts l.75, results §7 and l.1713, error codes l.58; RC 11.1 A1).
  if (!ctx.projectId) return { success: false, code: 'PROJECT_FORBIDDEN', error: PROJECT_FORBIDDEN };
  try {
    const record = await ctx.store.row<ProjectRecord>('projects', ctx.projectId);
    const state = record && !record.is_demo ? await templateState(ctx.store, ctx.projectId) : undefined;
    const memory = (await readMemory('overview.md', ctx.store))?.text ?? '';
    const blocks = [ORIENTATION]; // as is: it ends with "\n" and nothing follows (G-07)
    // Ours: empty memory was not captured (RC 11.1 A2), so block 2 is left out.
    if (memory.trim()) blocks.push(memoryBlock(memory));
    // Block 3 follows connection (lane A 07:1x): the notice only before connecting (G-04 c001); connected, a template's
    // overview as a plain block (the 21 Oct role) and nothing without one (A01, G-07), a demo too. A call reaches this
    // tab only through a connected link (helper.ts:180-181), so "not connected" here is ours: the project's row is gone.
    if (!record) blocks.push(NO_PROJECT_TEMPLATE);
    else if (state && (state.active || state.missing)) blocks.push(overviewText(state));
    return { success: true, content: blocks.map(text => ({ type: 'text', text })) };
  } catch (e) { return guideFailure(e); }
}
