// SPDX-License-Identifier: AGPL-3.0-only
// T23's three tools as the executor dispatches them (T23 notes "Boundaries"): getAgentOverview and loadSkill need no project
// and answer before the project check, like T21's help tools; workspace (I2) is refused per command without one.
import type { ProjectStore } from '../../store/database';
import type { ProjectDocument } from '../../store/model';
import type { ToolResult } from '../protocol';

/** One call's context. `projectId` is null when no project is open; `doc` reads the open runtime's live document. */
export type GuideContext = { store: ProjectStore; projectId: string | null; channel: 'chat' | 'mcp'; doc?: () => ProjectDocument | undefined };
export const GUIDE_TOOLS: ReadonlySet<string> = new Set(['getAgentOverview', 'loadSkill', 'workspace']);

/** The open editor's context, read at call time: the project counts as open only while a runtime is bound to it. */
export async function guideContext(channel: GuideContext['channel'] = 'mcp'): Promise<GuideContext> {
  // Namespaces, not destructured values: activeRuntime and activeSession are live `let` bindings.
  const [{ projectStore }, runtime, editor] = await Promise.all([import('../../store/database'), import('../../timeline/runtime'), import('../../editor')]);
  return { store: projectStore, projectId: runtime.activeRuntime && editor.activeSession ? editor.activeSession.projectId : null, channel, doc: () => runtime.activeRuntime?.bus.doc };
}

/** A store or IndexedDB failure as a result, mapped as workspace/tools.ts thrown() does: its own code when it has one. */
export function guideFailure(e: unknown): ToolResult {
  const err = e as { code?: unknown; message?: unknown };
  return { success: false, code: typeof err?.code === 'string' && err.code ? err.code : 'PROJECT_UNAVAILABLE',
    error: typeof err?.message === 'string' && err.message ? err.message : 'The workspace could not be read.' };
}

/** Every current caller is the helper, so the channel defaults to MCP. */
export async function guideTool(tool: string, input: Record<string, unknown>, ctx?: GuideContext): Promise<ToolResult> {
  try {
    const context = ctx ?? await guideContext();
    if (tool === 'loadSkill') return await (await import('./load')).loadSkill(input, context);
    if (tool === 'getAgentOverview') return await (await import('./overview')).getAgentOverview(input, context);
    if (tool === 'workspace') return await (await import('../workspace/tools')).workspaceTool(input, context);
  } catch (e) { return guideFailure(e); }
  return { success: false, code: 'UNKNOWN_TOOL', error: `${tool} is not a guide tool.` };
}
