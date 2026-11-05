// SPDX-License-Identifier: AGPL-3.0-only
// One MCP server per client session (stdio, or one Streamable HTTP session): the 23 served tools and the resource
// cutframe://project/state (Contract A). Tool results are the JSON envelope as one text block, isError when success is false.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema, SubscribeRequestSchema,
  UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE_URI } from '../../web/src/agent/protocol';
import type { ToolResult } from '../../web/src/agent/protocol';
import { TOOLS } from './schemas';

export type Link = { call(tool: string, input: unknown, session: string | undefined, opts?: { resource?: boolean }): Promise<ToolResult> };
export type McpSession = { server: Server; subscribed(): boolean; changed(): void };

const INSTRUCTIONS = 'Edits the timeline of the project open in the connected Cutframe editor tab. Call context first and again after the user edits; '
  + 'times are seconds. Every edit lands in the editor\'s undo history, so the user can undo it there.';

export const toContent = (result: ToolResult) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(result.success === false ? { isError: true } : {}) });

export function createMcpSession(link: Link, version: string, session: () => string | undefined): McpSession {
  const server = new Server({ name: 'cutframe-helper', version }, { capabilities: { tools: {}, resources: { subscribe: true } }, instructions: INSTRUCTIONS });
  let subscribed = false;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async req => toContent(await link.call(req.params.name, req.params.arguments ?? {}, session())));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: RESOURCE_URI, name: 'project-state', title: 'Project state',
    description: 'The open project\'s timeline as the context tool returns it without parameters. Subscribe to be told when items, tracks or transitions change.',
    mimeType: 'application/json' }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async req => {
    if (req.params.uri !== RESOURCE_URI) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${req.params.uri}`);
    return { contents: [{ uri: RESOURCE_URI, mimeType: 'application/json', text: JSON.stringify(await link.call('context', {}, session(), { resource: true })) }] };
  });
  server.setRequestHandler(SubscribeRequestSchema, async req => { if (req.params.uri === RESOURCE_URI) subscribed = true; return {}; });
  server.setRequestHandler(UnsubscribeRequestSchema, async req => { if (req.params.uri === RESOURCE_URI) subscribed = false; return {}; });
  return { server, subscribed: () => subscribed, changed: () => { if (subscribed) server.sendResourceUpdated({ uri: RESOURCE_URI }).catch(() => {}); } };
}
